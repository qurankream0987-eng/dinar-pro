/**
 * DINAR commercial accounting authority (Monetization V3).
 *
 * «رصيد دينار التجاري» is prepaid credit for DINAR's own commercial services (featured,
 * VIP, refresh, campaigns, bundles, DINAR Business). It is not buyer money, seller
 * proceeds, escrow, a payment account or a withdrawable balance, and it never touches
 * orders, payment_intents or settlement.
 *
 * - The append-only `commercial_ledger` is the authority. `commercial_accounts` holds the
 *   materialised buckets and is only ever changed by `post`, in the same transaction as
 *   the ledger entry, under a row lock, with non-negative guards in SQL.
 * - Every mutation carries an idempotency key; a repeated event returns the first entry.
 * - Top-ups are credited only from a provider capture whose webhook signature, amount and
 *   currency verify (the test adapter today; SIMULATION_ONLY / TEST_NO_TRANSFER). A client
 *   or a redirect can never credit a balance.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  commercialAccounts,
  commercialLedger,
  commercialTopups,
  db,
  users,
} from "@workspace/db";
import type { PaymentWebhookEvent } from "./payments/contracts";
import { testOnlyPaymentAdapter } from "./payments/test-adapter";
import { isPromotionSimulationEnabled } from "./promotion-policy";
import {
  formatMinorAmount,
  getCommercialPolicy,
  majorToMinor,
  trafficClass,
  type CommercialPolicy,
} from "./commercial-policy";
import { logger } from "./logger";

type Market = { id: string; currencyCode: string; minorUnitScale: number };
type Account = typeof commercialAccounts.$inferSelect;
type LedgerEntry = typeof commercialLedger.$inferSelect;

export const COMMERCIAL_BALANCE_STATEMENT = "رصيد للاستخدام في خدمات دينار التجارية فقط — لا يُسحب ولا يُحوّل، وليس أموال مشترين أو مستحقات بيع.";

export const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// ─── Accounts ────────────────────────────────────────────────────────────────

/** The actor's account in this market (created empty on first use), locked for update. */
export async function lockedAccount(userId: string, market: Market, tx: any): Promise<Account> {
  await tx
    .insert(commercialAccounts)
    .values({ id: randomUUID(), userId, marketId: market.id, currencyCode: market.currencyCode })
    .onConflictDoNothing();
  const [account] = await tx
    .select()
    .from(commercialAccounts)
    .where(and(eq(commercialAccounts.userId, userId), eq(commercialAccounts.marketId, market.id)))
    .for("update");
  if (!account || account.currencyCode !== market.currencyCode) throw fail(409, "عملة رصيدك لا تطابق السوق الحالي", "MARKET_MISMATCH");
  return account;
}

export type LedgerPosting = {
  entryType: LedgerEntry["entryType"];
  amountMinor: number;
  paidDelta?: number;
  promoDelta?: number;
  reservedDelta?: number;
  spentDelta?: number;
  idempotencyKey: string;
  productId?: string | null;
  productType?: string | null;
  pricingVersion?: number | null;
  promotionId?: string | null;
  subscriptionId?: string | null;
  entitlementId?: string | null;
  topupId?: string | null;
  reversesEntryId?: string | null;
  providerKey?: string | null;
  providerRef?: string | null;
  policyVersion?: number;
  metadata?: Record<string, string | number | boolean>;
};

/**
 * The only writer of balances. Called inside a transaction that already holds the account
 * row lock; replays of the same idempotency key return the original entry unchanged.
 */
export async function post(tx: any, account: Account, posting: LedgerPosting): Promise<{ entry: LedgerEntry; replayed: boolean; account: Account }> {
  const [existing] = await tx
    .select()
    .from(commercialLedger)
    .where(and(eq(commercialLedger.accountId, account.id), eq(commercialLedger.idempotencyKey, posting.idempotencyKey)))
    .limit(1);
  if (existing) return { entry: existing, replayed: true, account };
  const d = {
    paid: posting.paidDelta ?? 0,
    promo: posting.promoDelta ?? 0,
    reserved: posting.reservedDelta ?? 0,
    spent: posting.spentDelta ?? 0,
  };
  for (const value of [...Object.values(d), posting.amountMinor])
    if (!Number.isSafeInteger(value)) throw fail(400, "مبلغ غير صالح");
  const [updated] = await tx
    .update(commercialAccounts)
    .set({
      paidAvailableMinor: sql`${commercialAccounts.paidAvailableMinor} + ${d.paid}`,
      promoAvailableMinor: sql`${commercialAccounts.promoAvailableMinor} + ${d.promo}`,
      reservedMinor: sql`${commercialAccounts.reservedMinor} + ${d.reserved}`,
      spentMinor: sql`${commercialAccounts.spentMinor} + ${d.spent}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commercialAccounts.id, account.id),
        sql`${commercialAccounts.paidAvailableMinor} + ${d.paid} >= 0`,
        sql`${commercialAccounts.promoAvailableMinor} + ${d.promo} >= 0`,
        sql`${commercialAccounts.reservedMinor} + ${d.reserved} >= 0`,
        sql`${commercialAccounts.spentMinor} + ${d.spent} >= 0`,
      ),
    )
    .returning();
  if (!updated) throw fail(409, "رصيدك التجاري غير كافٍ لهذا الإجراء", "INSUFFICIENT_BALANCE");
  const [entry] = await tx
    .insert(commercialLedger)
    .values({
      id: randomUUID(),
      accountId: account.id,
      userId: account.userId,
      marketId: account.marketId,
      currencyCode: account.currencyCode,
      entryType: posting.entryType,
      amountMinor: posting.amountMinor,
      paidDeltaMinor: d.paid,
      promoDeltaMinor: d.promo,
      reservedDeltaMinor: d.reserved,
      spentDeltaMinor: d.spent,
      productId: posting.productId ?? null,
      productType: posting.productType ?? null,
      pricingVersion: posting.pricingVersion ?? null,
      promotionId: posting.promotionId ?? null,
      subscriptionId: posting.subscriptionId ?? null,
      entitlementId: posting.entitlementId ?? null,
      topupId: posting.topupId ?? null,
      reversesEntryId: posting.reversesEntryId ?? null,
      providerKey: posting.providerKey ?? null,
      providerRef: posting.providerRef ?? null,
      policyVersion: posting.policyVersion ?? 0,
      idempotencyKey: posting.idempotencyKey,
      trafficClass: trafficClass(),
      metadata: posting.metadata ?? {},
    })
    .returning();
  logger.info({ event: "commercial_ledger_posted", entryType: posting.entryType, amountMinor: posting.amountMinor, marketId: account.marketId }, "commercial ledger entry");
  return { entry, replayed: false, account: updated };
}

/**
 * Which credit pays: promotional first or paid first, from versioned policy. Returns null
 * when the available credit cannot cover the amount (never a partial or negative spend).
 */
export function creditSplit(account: Account, amountMinor: number, policy: CommercialPolicy): { promo: number; paid: number } | null {
  if (account.promoAvailableMinor + account.paidAvailableMinor < amountMinor) return null;
  if (policy.creditConsumptionOrder === "PROMO_FIRST") {
    const promo = Math.min(account.promoAvailableMinor, amountMinor);
    return { promo, paid: amountMinor - promo };
  }
  const paid = Math.min(account.paidAvailableMinor, amountMinor);
  return { paid, promo: amountMinor - paid };
}

/** A fixed commercial purchase paid from available credit, recognised immediately. */
export async function chargeAvailable(
  tx: any,
  account: Account,
  input: Omit<LedgerPosting, "paidDelta" | "promoDelta" | "reservedDelta" | "spentDelta"> & { market: Market },
) {
  const policy = await getCommercialPolicy(account.marketId, tx);
  const split = creditSplit(account, input.amountMinor, policy);
  if (!split) throw insufficient(account, input.amountMinor, input.market);
  const { market: _market, ...posting } = input;
  return post(tx, account, {
    ...posting,
    paidDelta: -split.paid,
    promoDelta: -split.promo,
    spentDelta: input.amountMinor,
    policyVersion: policy.version,
    metadata: { ...(input.metadata ?? {}), consumption: policy.creditConsumptionOrder, promoMinor: split.promo },
  });
}

/** Moves a campaign budget from available credit into the reserved bucket. */
export async function reserveBudget(
  tx: any,
  account: Account,
  input: { amountMinor: number; promotionId: string; productId: string; productType: string; pricingVersion: number; market: Market; idempotencyKey: string },
) {
  const policy = await getCommercialPolicy(account.marketId, tx);
  const split = creditSplit(account, input.amountMinor, policy);
  if (!split) throw insufficient(account, input.amountMinor, input.market);
  const result = await post(tx, account, {
    entryType: "CAMPAIGN_RESERVE",
    amountMinor: input.amountMinor,
    paidDelta: -split.paid,
    promoDelta: -split.promo,
    reservedDelta: input.amountMinor,
    promotionId: input.promotionId,
    productId: input.productId,
    productType: input.productType,
    pricingVersion: input.pricingVersion,
    policyVersion: policy.version,
    idempotencyKey: input.idempotencyKey,
    metadata: { consumption: policy.creditConsumptionOrder, promoMinor: split.promo },
  });
  return { ...result, promoPart: split.promo };
}

export function insufficient(account: Account, amountMinor: number, market: Market) {
  const available = account.paidAvailableMinor + account.promoAvailableMinor;
  const missing = amountMinor - available;
  return Object.assign(
    fail(
      409,
      `رصيدك التجاري غير كافٍ. المتاح ${formatMinorAmount(available, market.minorUnitScale, market.currencyCode)} وتحتاج إلى شحن ${formatMinorAmount(missing, market.minorUnitScale, market.currencyCode)} إضافية`,
      "INSUFFICIENT_BALANCE",
    ),
    { missingMinor: missing },
  );
}

// ─── Views ───────────────────────────────────────────────────────────────────

export type CommercialBalanceView = {
  currencyCode: string;
  availableMinor: number;
  paidAvailableMinor: number;
  promoAvailableMinor: number;
  reservedMinor: number;
  spentMinor: number;
  availableLabel: string;
  promoLabel: string;
  reservedLabel: string;
  spentLabel: string;
  statement: string;
  paymentMode: "TEST_NO_TRANSFER";
};

export function balanceView(account: Pick<Account, "paidAvailableMinor" | "promoAvailableMinor" | "reservedMinor" | "spentMinor">, market: Market): CommercialBalanceView {
  const f = (minor: number) => formatMinorAmount(minor, market.minorUnitScale, market.currencyCode);
  const available = account.paidAvailableMinor + account.promoAvailableMinor;
  return {
    currencyCode: market.currencyCode,
    availableMinor: available,
    paidAvailableMinor: account.paidAvailableMinor,
    promoAvailableMinor: account.promoAvailableMinor,
    reservedMinor: account.reservedMinor,
    spentMinor: account.spentMinor,
    availableLabel: f(available),
    promoLabel: f(account.promoAvailableMinor),
    reservedLabel: f(account.reservedMinor),
    spentLabel: f(account.spentMinor),
    statement: COMMERCIAL_BALANCE_STATEMENT,
    paymentMode: "TEST_NO_TRANSFER",
  };
}

export async function getCommercialBalance(userId: string, market: Market): Promise<CommercialBalanceView> {
  const [account] = await db
    .select()
    .from(commercialAccounts)
    .where(and(eq(commercialAccounts.userId, userId), eq(commercialAccounts.marketId, market.id)));
  return balanceView(account ?? { paidAvailableMinor: 0, promoAvailableMinor: 0, reservedMinor: 0, spentMinor: 0 }, market);
}

const ENTRY_LABELS: Record<string, string> = {
  CREDIT_TOPUP: "شحن رصيد (تجريبي)",
  CREDIT_GRANTED: "رصيد ترويجي مجاني",
  CAMPAIGN_RESERVE: "حجز ميزانية حملة",
  CAMPAIGN_RELEASE: "إعادة ميزانية غير مستخدمة",
  CAMPAIGN_CHARGE: "تفاعل مؤهل في حملة",
  FEATURED_PURCHASE: "إعلان مميز",
  VIP_PURCHASE: "VIP",
  REFRESH_PURCHASE: "تجديد الإعلان",
  BUNDLE_PURCHASE: "باقة إعلانات",
  SUBSCRIPTION_CHARGE: "اشتراك دينار بزنس",
  PROMOTION_PURCHASE: "ترويج",
  ENTITLEMENT_CONSUMED: "استخدام وحدة من باقة",
  REFUND: "استرداد إلى الرصيد",
  CREDIT: "رصيد",
  ADJUSTMENT: "تسوية",
  EXPIRE: "انتهاء رصيد",
  REVERSAL: "عكس قيد",
};

/** Safe accounting history: date, product, amount, effect. No keys, refs or metadata. */
export async function commercialHistory(userId: string, market: Market, limit = 20) {
  const rows: LedgerEntry[] = await db
    .select()
    .from(commercialLedger)
    .where(and(eq(commercialLedger.userId, userId), eq(commercialLedger.marketId, market.id)))
    .orderBy(desc(commercialLedger.createdAt), desc(commercialLedger.id))
    .limit(limit);
  const f = (minor: number) => formatMinorAmount(minor, market.minorUnitScale, market.currencyCode);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    entryType: row.entryType,
    label: ENTRY_LABELS[row.entryType] ?? row.entryType,
    amountLabel: f(row.amountMinor),
    amountMinor: row.amountMinor,
    effect: row.paidDeltaMinor + row.promoDeltaMinor > 0 ? "CREDIT" : row.spentDeltaMinor !== 0 ? "SPEND" : row.reservedDeltaMinor !== 0 ? "RESERVE" : "INFO",
  }));
}

/** Monthly/total spend summary derived from the ledger (recognised charges minus refunds). */
export async function commercialSpendSummary(userId: string, market: Market, since?: Date) {
  const [row] = await db
    .select({
      spent: sql<number>`coalesce(sum(${commercialLedger.spentDeltaMinor}), 0)::int`,
      credited: sql<number>`coalesce(sum(case when ${commercialLedger.entryType} in ('CREDIT_TOPUP', 'CREDIT_GRANTED') then ${commercialLedger.amountMinor} else 0 end), 0)::int`,
    })
    .from(commercialLedger)
    .where(
      and(
        eq(commercialLedger.userId, userId),
        eq(commercialLedger.marketId, market.id),
        ...(since ? [sql`${commercialLedger.createdAt} >= ${since}`] : []),
      ),
    );
  return { spentMinor: row?.spent ?? 0, creditedMinor: row?.credited ?? 0 };
}

/** The ledger alone must reproduce every bucket of the account. */
export async function reconcileAccount(accountId: string) {
  const [sums] = await db
    .select({
      paid: sql<number>`coalesce(sum(${commercialLedger.paidDeltaMinor}), 0)::int`,
      promo: sql<number>`coalesce(sum(${commercialLedger.promoDeltaMinor}), 0)::int`,
      reserved: sql<number>`coalesce(sum(${commercialLedger.reservedDeltaMinor}), 0)::int`,
      spent: sql<number>`coalesce(sum(${commercialLedger.spentDeltaMinor}), 0)::int`,
    })
    .from(commercialLedger)
    .where(eq(commercialLedger.accountId, accountId));
  const [account] = await db.select().from(commercialAccounts).where(eq(commercialAccounts.id, accountId));
  const matches =
    !!account &&
    sums!.paid === account.paidAvailableMinor &&
    sums!.promo === account.promoAvailableMinor &&
    sums!.reserved === account.reservedMinor &&
    sums!.spent === account.spentMinor;
  return { matches, ledger: sums, account };
}

// ─── Top-ups (provider boundary) ─────────────────────────────────────────────

export type TopupView = {
  id: string;
  amountLabel: string;
  amountMinor: number;
  currencyCode: string;
  status: string;
  paymentMode: "TEST_NO_TRANSFER";
};

function topupView(row: typeof commercialTopups.$inferSelect, market: Market): TopupView {
  return {
    id: row.id,
    amountLabel: formatMinorAmount(row.amountMinor, market.minorUnitScale, row.currencyCode),
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    status: row.status,
    paymentMode: "TEST_NO_TRANSFER",
  };
}

/** Validates a requested top-up amount (major units) against policy; returns minor units. */
export async function topupAmountMinor(market: Market, amountMajor: number): Promise<number> {
  const policy = await getCommercialPolicy(market.id);
  const minor = majorToMinor(amountMajor, market.minorUnitScale);
  if (!Number.isSafeInteger(minor) || amountMajor < policy.topupMinMajor || amountMajor > policy.topupMaxMajor)
    throw fail(400, `مبلغ الشحن يجب أن يكون بين ${policy.topupMinMajor} و${policy.topupMaxMajor} ${market.currencyCode}`);
  return minor;
}

/**
 * Opens one top-up intent at the provider boundary (CreateCommercialTopupIntent). The
 * balance does not change here; only `receiveTopupWebhook` can credit it.
 */
export async function createTopupIntent(input: { userId: string; market: Market; amountMinor: number; idempotencyKey: string }) {
  if (!isPromotionSimulationEnabled()) throw fail(403, "شحن الرصيد التجريبي متاح في بيئة التطوير والاختبار فقط");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح");
  return db.transaction(async (tx) => {
    const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.userId)).for("share");
    if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا.");
    const account = await lockedAccount(input.userId, input.market, tx);
    const [prior] = await tx
      .select()
      .from(commercialTopups)
      .where(and(eq(commercialTopups.userId, input.userId), eq(commercialTopups.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.amountMinor !== input.amountMinor || prior.marketId !== input.market.id)
        throw fail(409, "مفتاح عدم التكرار مستخدم لطلب شحن مختلف", "IDEMPOTENCY_KEY_REUSED");
      return topupView(prior, input.market);
    }
    const providerRef = testOnlyPaymentAdapter.allocateIntentReference();
    testOnlyPaymentAdapter.registerIntent(providerRef, { amountMinor: input.amountMinor, currencyCode: input.market.currencyCode });
    const [row] = await tx
      .insert(commercialTopups)
      .values({
        id: randomUUID(),
        accountId: account.id,
        userId: input.userId,
        marketId: input.market.id,
        amountMinor: input.amountMinor,
        currencyCode: input.market.currencyCode,
        providerKey: testOnlyPaymentAdapter.providerKey,
        providerRef,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    logger.info({ event: "commercial_topup_intent_created", marketId: input.market.id, amountMinor: input.amountMinor }, "commercial top-up intent");
    return topupView(row, input.market);
  });
}

/**
 * The provider webhook path: signature, event type, amount and currency must verify and
 * the provider snapshot must be CAPTURED. Exactly one CREDIT_TOPUP per provider intent;
 * replays return the same credit. Anything else credits nothing.
 */
export async function receiveTopupWebhook(event: PaymentWebhookEvent, signature: string) {
  const adapter = testOnlyPaymentAdapter;
  if (!adapter.verifyWebhook(event, signature) || event.type !== "CAPTURE_SUCCEEDED")
    throw fail(400, "إشعار دفع غير موثّق", "WEBHOOK_UNVERIFIED");
  const snapshot = await adapter.getSnapshot(event.providerIntentId);
  if (snapshot?.status !== "CAPTURED" || snapshot.capturedAmountMinor !== event.amountMinor || snapshot.currencyCode !== event.currencyCode)
    throw fail(409, "حالة الدفع لدى المزوّد لا تطابق الإشعار", "PAYMENT_PENDING");
  return db.transaction(async (tx) => {
    const [topup] = await tx
      .select()
      .from(commercialTopups)
      .where(and(eq(commercialTopups.providerKey, adapter.providerKey), eq(commercialTopups.providerRef, event.providerIntentId)))
      .for("update");
    if (!topup) throw fail(404, "طلب الشحن غير موجود");
    if (topup.amountMinor !== event.amountMinor || topup.currencyCode !== event.currencyCode)
      throw fail(409, "مبلغ الإشعار لا يطابق طلب الشحن", "AMOUNT_MISMATCH");
    if (topup.status === "CREDITED") return { credited: false, topupId: topup.id };
    const [account] = await tx.select().from(commercialAccounts).where(eq(commercialAccounts.id, topup.accountId)).for("update");
    const posted = await post(tx, account!, {
      entryType: "CREDIT_TOPUP",
      amountMinor: topup.amountMinor,
      paidDelta: topup.amountMinor,
      topupId: topup.id,
      providerKey: topup.providerKey,
      providerRef: topup.providerRef,
      idempotencyKey: `topup:${topup.providerKey}:${topup.providerRef}`,
      metadata: { paymentMode: "SIMULATION_ONLY" },
    });
    await tx
      .update(commercialTopups)
      .set({ status: "CREDITED", creditedEntryId: posted.entry.id, updatedAt: new Date() })
      .where(eq(commercialTopups.id, topup.id));
    logger.info({ event: "commercial_credit_posted", marketId: topup.marketId, amountMinor: topup.amountMinor }, "commercial credit posted");
    return { credited: !posted.replayed, topupId: topup.id };
  });
}

/**
 * Development/test stand-in for the provider checkout: the simulated provider captures
 * and emits its signed webhook, which goes through the same verification as a real one.
 */
export async function simulateTopupCapture(input: { userId: string; market: Market; topupId: string }) {
  if (!isPromotionSimulationEnabled()) throw fail(403, "شحن الرصيد التجريبي متاح في بيئة التطوير والاختبار فقط");
  const [topup] = await db
    .select()
    .from(commercialTopups)
    .where(and(eq(commercialTopups.id, input.topupId), eq(commercialTopups.userId, input.userId), eq(commercialTopups.marketId, input.market.id)));
  if (!topup) throw fail(404, "طلب الشحن غير موجود");
  if (topup.status === "CREDITED") return { credited: false, topup: topupView(topup, input.market) };
  const adapter = testOnlyPaymentAdapter;
  if (!(await adapter.getSnapshot(topup.providerRef)))
    adapter.registerIntent(topup.providerRef, { amountMinor: topup.amountMinor, currencyCode: topup.currencyCode });
  const snapshot = await adapter.getSnapshot(topup.providerRef);
  const signed = snapshot?.status === "PENDING" ? adapter.createCaptureWebhook(topup.providerRef) : undefined;
  const outcome = signed
    ? await receiveTopupWebhook(signed.event, signed.signature)
    : { credited: false };
  const [after] = await db.select().from(commercialTopups).where(eq(commercialTopups.id, topup.id));
  return { credited: outcome.credited, topup: topupView(after!, input.market) };
}

// ─── Admin: promotional credit and refunds ───────────────────────────────────

/** Free marketing credit, kept in its own bucket so it is never mistaken for paid cash. */
export async function grantPromotionalCredit(input: { adminId: string; userId: string; market: Market; amountMinor: number; reason: string; idempotencyKey: string }) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw fail(400, "مبلغ غير صالح");
  return db.transaction(async (tx) => {
    const account = await lockedAccount(input.userId, input.market, tx);
    const result = await post(tx, account, {
      entryType: "CREDIT_GRANTED",
      amountMinor: input.amountMinor,
      promoDelta: input.amountMinor,
      idempotencyKey: `grant:${input.idempotencyKey}`,
      metadata: { reason: input.reason.slice(0, 60), grantedBy: "ADMIN" },
    });
    return { replayed: result.replayed, balance: balanceView(result.account, input.market) };
  });
}

const REFUNDABLE_ENTRY_TYPES = ["FEATURED_PURCHASE", "VIP_PURCHASE", "REFRESH_PURCHASE", "BUNDLE_PURCHASE", "SUBSCRIPTION_CHARGE", "CAMPAIGN_CHARGE"];

/**
 * A server-authorised refund back to commercial credit (no real money moves). One refund
 * per original entry, never more than it charged, back into the bucket it came from.
 */
export async function refundEntryToCredit(input: { entryId: string; reason: string }) {
  return db.transaction(async (tx) => {
    const [entry] = await tx.select().from(commercialLedger).where(eq(commercialLedger.id, input.entryId));
    if (!entry || !REFUNDABLE_ENTRY_TYPES.includes(entry.entryType) || entry.spentDeltaMinor <= 0)
      throw fail(404, "القيد غير قابل للاسترداد");
    const [account] = await tx.select().from(commercialAccounts).where(eq(commercialAccounts.id, entry.accountId)).for("update");
    // A campaign charge was paid from the reserve; its promo share follows the campaign split.
    const promoBack = entry.entryType === "CAMPAIGN_CHARGE" ? Number(entry.metadata.promoMinor ?? 0) : -entry.promoDeltaMinor;
    const paidBack = entry.spentDeltaMinor - promoBack;
    const result = await post(tx, account!, {
      entryType: "REFUND",
      amountMinor: entry.spentDeltaMinor,
      paidDelta: paidBack,
      promoDelta: promoBack,
      spentDelta: -entry.spentDeltaMinor,
      reversesEntryId: entry.id,
      productId: entry.productId,
      productType: entry.productType,
      promotionId: entry.promotionId,
      idempotencyKey: `refund:${entry.id}`,
      metadata: { reason: input.reason.slice(0, 60), paymentMode: "SIMULATION_ONLY" },
    });
    logger.info({ event: "commercial_refund_posted", marketId: entry.marketId, amountMinor: entry.spentDeltaMinor }, "commercial refund posted");
    return { replayed: result.replayed, entryId: result.entry.id };
  });
}

// ─── Admin economics: revenue is never GMV ───────────────────────────────────

/**
 * Recognised commercial revenue by product (charges minus refunds), reserved budgets (a
 * liability, not revenue), credit outstanding, and order economics with GMV and the
 * bps commission entitlement reported separately.
 */
export async function commercialEconomics(marketId: string) {
  const revenue = (await db.execute(sql`
    select coalesce(product_type, entry_type) as product, sum(spent_delta_minor)::int as recognised_minor
    from commercial_ledger where market_id = ${marketId} and spent_delta_minor <> 0
    group by 1 order by 1`)).rows as { product: string; recognised_minor: number }[];
  const [accounts] = (await db.execute(sql`
    select coalesce(sum(paid_available_minor), 0)::int as paid_credit, coalesce(sum(promo_available_minor), 0)::int as promo_credit,
           coalesce(sum(reserved_minor), 0)::int as reserved
    from commercial_accounts where market_id = ${marketId}`)).rows as { paid_credit: number; promo_credit: number; reserved: number }[];
  const [orderEconomics] = (await db.execute(sql`
    select coalesce(sum(subtotal_minor), 0)::bigint::text as gmv, coalesce(sum(platform_fee_minor), 0)::bigint::text as commission,
           count(*)::int as orders
    from orders where market_id = ${marketId} and status <> 'CANCELLED'`)).rows as { gmv: string; commission: string; orders: number }[];
  return {
    commercialRevenueByProduct: revenue.map((row) => ({ product: row.product, recognisedMinor: row.recognised_minor })),
    commercialRevenueMinor: revenue.reduce((sum, row) => sum + row.recognised_minor, 0),
    outstandingPaidCreditMinor: accounts?.paid_credit ?? 0,
    outstandingPromoCreditMinor: accounts?.promo_credit ?? 0,
    reservedBudgetsMinor: accounts?.reserved ?? 0,
    gmvMinor: Number(orderEconomics?.gmv ?? 0),
    commissionEntitlementMinor: Number(orderEconomics?.commission ?? 0),
    orderCount: orderEconomics?.orders ?? 0,
  };
}
