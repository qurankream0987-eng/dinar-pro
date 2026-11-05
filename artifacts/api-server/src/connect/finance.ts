import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  users,
  businessProfiles,
  connectPartners,
  connectAgreements,
  connectAgreementAcceptances,
  connectReferrals,
  connectOffers,
  connectTransactions,
  connectExternalEvents,
  connectAuditEvents,
  connectCommissionLedger,
} from "@workspace/db";
import {
  ConnectExternalTransactionSchema,
  ConnectAgreementTerms,
  ConnectPartnerEvent,
  ConnectFinanceCommand,
  type ConnectEvent,
  type ConnectAgreement,
} from "@workspace/api-zod/connect-platform";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import type { ProviderContext } from "../lib/provider-connections";
import {
  providerConnectIntegration,
  assertConnectAdmin,
  connectAudit,
  connectDigest,
  type ConnectTx,
  type ConnectActor,
  type ConnectMarket,
} from "./partners";
import { assertConnectReferralConsent } from "./agreements";
import {
  commissionSnapshot,
  remainingCommission,
  type ConnectCommissionItem,
} from "./commission-math";
import { connectError } from "./provider-registry";
type Header = typeof connectTransactions.$inferSelect;
const ROOT_EVENTS = new Set([
  "PURCHASE_COMPLETED",
  "BOOKING_CONFIRMED",
  "SERVICE_COMPLETED",
]);
const BUCKETS = {
  earnedMinor: "EARNED",
  approvedMinor: "APPROVED",
  payableMinor: "PAYABLE",
  simulatedSettledMinor: "SIMULATED_SETTLED",
  recoveryDueMinor: "RECOVERY_DUE",
} as const;
type Balances = Record<keyof typeof BUCKETS, number>;
const zero = (): Balances => ({
  earnedMinor: 0,
  approvedMinor: 0,
  payableMinor: 0,
  simulatedSettledMinor: 0,
  recoveryDueMinor: 0,
});
function refuse(code: string, message: string): never {
  throw connectError(409, code, message);
}
function onlySimulation(mode: string) {
  if (mode !== "SIMULATION_ONLY")
    refuse(
      "LIVE_EXTERNAL_COMMERCE_DISABLED",
      "التنفيذ المالي الحي غير مفعّل؛ لا تسجّل المحاكاة استلام مال حقيقي",
    );
}
function evidence(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/.test(value))
    throw connectError(
      400,
      "INVALID_EVIDENCE_REFERENCE",
      "استخدم معرّف دليل مبهمًا؛ لا ترسل رابطًا أو محادثة أو مفتاحًا سريًا",
    );
}
export async function connectBalances(
  tx: ConnectTx,
  id: string,
): Promise<Balances> {
  const rows = await tx
    .select({
      bucket: connectCommissionLedger.bucket,
      amount: sql<string>`sum(${connectCommissionLedger.deltaMinor})::text`,
    })
    .from(connectCommissionLedger)
    .where(eq(connectCommissionLedger.transactionId, id))
    .groupBy(connectCommissionLedger.bucket);
  const result = zero();
  for (const [key, bucket] of Object.entries(BUCKETS)) {
    const amount = BigInt(
      rows.find((row) => row.bucket === bucket)?.amount ?? "0",
    );
    if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
      throw connectError(
        500,
        "LEDGER_RECONCILIATION_REQUIRED",
        "يلزم تدقيق السجل المحاسبي قبل متابعة العملية",
      );
    result[key as keyof Balances] = Number(amount);
  }
  return result;
}
export function transactionView(row: Header, balances: Balances) {
  return ConnectExternalTransactionSchema.parse({
    id: row.id,
    externalId: row.externalId,
    partnerId: row.partnerId,
    integrationId: row.integrationId,
    state: row.state,
    currency: row.currencyCode,
    grossMinor: row.grossMinor,
    refundedMinor: row.refundedMinor,
    commissionCeilingMinor: row.commissionCeilingMinor,
    lastSequence: row.lastSequence,
    mode: row.mode,
    balances,
    actuallyReceivedMinor: row.mode === "SIMULATION_ONLY" ? 0 : null,
    internalOrderCreated: false,
    disclosure:
      row.mode === "SIMULATION_ONLY"
        ? "سجل عمولة خارجية بالمحاكاة فقط؛ التسوية المسجلة ليست إثبات استلام أموال حقيقية."
        : "سجل تجارة خارجية؛ استلام الأموال الحقيقية غير متحقق. لا ينشئ طلبًا أو دفعًا داخليًا.",
  });
}
async function lines(
  tx: ConnectTx,
  row: Header,
  from: Balances,
  to: Balances,
  source: { eventId?: string; auditId?: string },
  force?: keyof Balances,
) {
  for (const [key, bucket] of Object.entries(BUCKETS)) {
    const delta = to[key as keyof Balances] - from[key as keyof Balances];
    if (delta !== 0 || force === key)
      await tx.insert(connectCommissionLedger).values({
        id: randomUUID(),
        transactionId: row.id,
        sourceEventId: source.eventId ?? null,
        sourceAuditId: source.auditId ?? null,
        sourceKey:
          (source.eventId ? "event:" : "finance:") +
          (source.eventId ?? source.auditId),
        bucket,
        deltaMinor: delta,
        currencyCode: row.currencyCode,
        mode: row.mode,
      });
  }
}
async function agreementFor(tx: ConnectTx, row: Header) {
  const [agreement] = await tx
    .select()
    .from(connectAgreements)
    .where(
      and(
        eq(connectAgreements.id, row.agreementId),
        eq(connectAgreements.partnerId, row.partnerId),
      ),
    );
  if (!agreement) refuse("AGREEMENT_MISSING", "دليل الاتفاقية الأصلي غير متاح");
  const terms = ConnectAgreementTerms.parse(agreement.terms);
  onlySimulation(terms.mode);
  return terms;
}
function reducedBalances(old: Balances, earnedMinor: number) {
  const approvedMinor = Math.min(old.approvedMinor, earnedMinor),
    recoveryDueMinor = Math.max(
      old.recoveryDueMinor,
      old.simulatedSettledMinor - approvedMinor,
    );
  return {
    earnedMinor,
    approvedMinor,
    simulatedSettledMinor: old.simulatedSettledMinor,
    recoveryDueMinor,
    payableMinor: Math.min(
      old.payableMinor,
      Math.max(0, approvedMinor - old.simulatedSettledMinor + recoveryDueMinor),
    ),
  };
}
async function rootConversion(
  tx: ConnectTx,
  context: ProviderContext,
  ready: Awaited<ReturnType<typeof providerConnectIntegration>>,
  event: ConnectEvent,
  market: ConnectMarket,
) {
  await assertMarketLegalCapability(market.id, "TRANSACTIONS", tx);
  onlySimulation(ready.integration.mode);
  if (event.sequence !== 1 || !event.referralId || !event.items?.length)
    refuse(
      "VERIFIED_REFERRAL_REQUIRED",
      "يلزم مصدر إحالة مقبول وكشف بنود أصلي وتسلسل يبدأ بواحد",
    );
  const [referral] = await tx
    .select()
    .from(connectReferrals)
    .where(
      and(
        eq(connectReferrals.id, event.referralId!),
        eq(connectReferrals.integrationId, ready.integration.id),
        eq(connectReferrals.partnerId, ready.partner.id),
      ),
    );
  if (!referral)
    throw connectError(
      404,
      "REFERRAL_NOT_FOUND",
      "لا توجد إحالة مؤهلة لهذا الربط",
    );
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, referral.userId))
    .for("update");
  await assertConnectReferralConsent(tx, referral);
  const [contract] = await tx
    .select({
      agreement: connectAgreements,
      acceptance: connectAgreementAcceptances,
    })
    .from(connectAgreements)
    .innerJoin(
      connectAgreementAcceptances,
      eq(connectAgreementAcceptances.agreementId, connectAgreements.id),
    )
    .where(
      and(
        eq(connectAgreements.id, referral.agreementId),
        eq(connectAgreements.partnerId, ready.partner.id),
      ),
    );
  if (
    !contract ||
    contract.acceptance.termsDigest !== contract.agreement.termsDigest ||
    contract.acceptance.acceptedBy !== ready.business.ownerUserId ||
    contract.acceptance.createdAt > referral.createdAt
  )
    refuse(
      "ACCEPTED_AGREEMENT_REQUIRED",
      "لا يوجد دليل قبول سابق صالح لهذه الإحالة",
    );
  const terms = ConnectAgreementTerms.parse(contract.agreement.terms);
  onlySimulation(terms.mode);
  if (terms.currency !== event.currency)
    refuse(
      "CURRENCY_CONVERSION_REQUIRES_ACCEPTED_RATE",
      "العملة لا تطابق الاتفاقية؛ لن نخترع سعر صرف أو عمولة محوّلة",
    );
  const occurred = Date.parse(event.occurredAt),
    now = Date.now();
  if (
    occurred < referral.createdAt.getTime() ||
    occurred > referral.expiresAt.getTime() ||
    now > referral.expiresAt.getTime() + terms.reportingGraceSeconds * 1000 ||
    Date.parse(terms.effectiveFrom) > referral.createdAt.getTime() ||
    (terms.effectiveUntil &&
      Date.parse(terms.effectiveUntil) <= referral.createdAt.getTime())
  )
    refuse(
      "ATTRIBUTION_EXPIRED",
      "التحويل خارج نافذة الإسناد أو مهلة الإبلاغ المقبولة",
    );
  if (
    !terms.eligibleEvents.includes(
      event.type as ConnectAgreement["eligibleEvents"][number],
    )
  )
    refuse(
      "EVENT_NOT_ELIGIBLE",
      "نوع التحويل غير مؤهل بموجب الاتفاقية المقبولة",
    );
  const catalog = await tx
    .select()
    .from(connectOffers)
    .where(
      and(
        eq(connectOffers.integrationId, ready.integration.id),
        inArray(
          connectOffers.externalId,
          event.items!.map((item) => item.externalId),
        ),
      ),
    );
  const byExternalId = new Map(
    catalog.map((offer) => [offer.externalId, offer]),
  );
  const source = event.items!.map((item) => {
    const offer = byExternalId.get(item.externalId);
    if (!offer)
      refuse(
        "UNVERIFIED_PRODUCT",
        "البند غير موجود في كتالوج هذا الربط؛ لا عمولة مفترضة",
      );
    return {
      externalId: item.externalId,
      categoryId: offer!.categoryId,
      grossMinor: item.amountMinor,
    };
  });
  const snapshot = commissionSnapshot(terms, source);
  if (snapshot.grossMinor !== event.amountMinor)
    refuse("AMOUNT_MISMATCH", "مجموع البنود لا يطابق مبلغ التحويل");
  const [row] = await tx
    .insert(connectTransactions)
    .values({
      id: randomUUID(),
      partnerId: ready.partner.id,
      integrationId: ready.integration.id,
      externalId: event.transactionId,
      referralId: referral.id,
      agreementId: contract.agreement.id,
      currencyCode: event.currency,
      grossMinor: snapshot.grossMinor,
      eligibleMinor: snapshot.eligibleMinor,
      commissionCeilingMinor: snapshot.commissionMinor,
      itemsSnapshot: snapshot.items,
      state: "VERIFIED",
      lastSequence: 1,
      occurredAt: new Date(event.occurredAt),
      mode: terms.mode,
    })
    .returning();
  return {
    row: row!,
    balances: { ...zero(), earnedMinor: snapshot.commissionMinor },
  };
}
export async function receiveConnectEvent(
  context: ProviderContext,
  market: ConnectMarket,
  raw: unknown,
) {
  const event = ConnectPartnerEvent.parse(raw),
    digest = connectDigest(event);
  evidence(event.evidenceReference);
  if (Date.parse(event.occurredAt) > Date.now() + 300000)
    refuse("FUTURE_EVENT", "وقت الحدث أبعد من هامش الساعة المسموح");
  return db.transaction(async (tx) => {
    const ready = await providerConnectIntegration(
      context,
      tx,
      "connect:events:write",
      "TRANSACTION_REPORT",
    );
    if (ready.partner.marketId !== market.id)
      throw connectError(404, "NOT_FOUND", "السوق غير موجود");
    onlySimulation(ready.integration.mode);
    const [prior] = await tx
      .select()
      .from(connectExternalEvents)
      .where(
        and(
          eq(connectExternalEvents.integrationId, ready.integration.id),
          eq(connectExternalEvents.externalEventId, event.eventId),
        ),
      );
    if (prior) {
      if (prior.payloadDigest !== digest)
        refuse("IDEMPOTENCY_CONFLICT", "معرّف الحدث مستخدم لمحتوى مختلف");
      const [row] = await tx
        .select()
        .from(connectTransactions)
        .where(eq(connectTransactions.id, prior.transactionId));
      return {
        duplicate: true,
        transaction: transactionView(row!, await connectBalances(tx, row!.id)),
      };
    }
    let [row] = await tx
      .select()
      .from(connectTransactions)
      .where(
        and(
          eq(connectTransactions.integrationId, ready.integration.id),
          eq(connectTransactions.externalId, event.transactionId),
        ),
      )
      .for("update");
    let from = zero(),
      to = zero(),
      force: keyof Balances | undefined,
      state: string,
      refundedMinor = 0,
      disputeFromState: string | null = null;
    if (!row) {
      if (!ROOT_EVENTS.has(event.type))
        refuse(
          "PREDECESSOR_REQUIRED",
          "لا توجد معاملة أصلية موثّقة؛ أعد تسوية تسلسل الأحداث",
        );
      const created = await rootConversion(tx, context, ready, event, market);
      row = created.row;
      to = created.balances;
      force = "earnedMinor";
      state = "VERIFIED";
    } else {
      onlySimulation(row.mode);
      from = await connectBalances(tx, row.id);
      to = { ...from };
      state = row.state;
      refundedMinor = row.refundedMinor;
      disputeFromState = row.disputeFromState;
      if (event.sequence !== row.lastSequence + 1)
        refuse(
          "EVENT_ORDER_CONFLICT",
          "يلزم الحدث التالي في التسلسل دون فجوة أو إعادة ترتيب",
        );
      if (event.currency !== row.currencyCode)
        refuse("CURRENCY_MISMATCH", "عملة الحدث تختلف عن المصدر المثبت");
      if (Date.parse(event.occurredAt) < row.occurredAt.getTime())
        refuse("EVENT_TIME_CONFLICT", "الحدث يسبق المعاملة الأصلية");
      if (ROOT_EVENTS.has(event.type))
        refuse(
          "CONVERSION_ALREADY_RECORDED",
          "لا يمكن احتساب التحويل نفسه مرة أخرى بمعرّف حدث جديد",
        );
      if (row.state === "REVERSED")
        refuse(
          "TRANSACTION_REVERSED",
          "المعاملة معكوسة؛ لا يمكن إنشاء التزام جديد منها",
        );
      if (event.referralId && event.referralId !== row.referralId)
        refuse("REFERRAL_MISMATCH", "مصدر الإحالة لا يطابق المعاملة الأصلية");
      const terms = await agreementFor(tx, row);
      if (event.type === "COMMISSION_APPROVED") {
        if (
          !["VERIFIED", "APPROVED"].includes(state) ||
          event.amountMinor !== from.earnedMinor
        )
          refuse(
            "APPROVAL_MISMATCH",
            "الموافقة لا تطابق العمولة المؤهلة المحسوبة أو حالتها",
          );
        to.approvedMinor = from.earnedMinor;
        state = "APPROVED";
        force = "approvedMinor";
      } else if (event.type === "COMMISSION_SETTLED") {
        if (
          state !== "PAYABLE" ||
          event.amountMinor <= 0 ||
          event.amountMinor > from.payableMinor
        )
          refuse(
            "SETTLEMENT_CLAIM_MISMATCH",
            "ادعاء التسوية لا يطابق الرصيد المستحق المراجع",
          );
        // Retain the claim only. Independent reconciliation is the sole settlement writer.
      } else if (
        ["COMMISSION_REJECTED", "DISPUTE_OPENED"].includes(event.type)
      ) {
        if (event.amountMinor !== from.earnedMinor)
          refuse(
            "DISPUTE_AMOUNT_MISMATCH",
            "مبلغ النزاع لا يطابق العمولة القائمة",
          );
        if (state !== "DISPUTED") disputeFromState = state;
        state = "DISPUTED";
        to.payableMinor = 0;
      } else if (
        ["REFUND", "CANCELLATION", "CHARGEBACK"].includes(event.type)
      ) {
        const items = row.itemsSnapshot as unknown as ConnectCommissionItem[];
        const refunds =
          event.type === "REFUND"
            ? event.refundItems
            : items.map((item) => ({
                externalId: item.externalId,
                amountMinor: item.grossMinor,
              }));
        if (!refunds?.length)
          refuse("REFUND_ITEMS_REQUIRED", "يلزم كشف استرداد تراكمي لكل بند");
        const next = remainingCommission(terms, items, refunds!);
        const priorRefunds = await tx
          .select({ payload: connectExternalEvents.payload })
          .from(connectExternalEvents)
          .where(
            and(
              eq(connectExternalEvents.transactionId, row.id),
              eq(connectExternalEvents.kind, "REFUND"),
            ),
          )
          .orderBy(desc(connectExternalEvents.sequence))
          .limit(1);
        const priorItems = (priorRefunds.at(-1)?.payload.refundItems ?? []) as {
          externalId: string;
          amountMinor: number;
        }[];
        if (
          priorItems.some(
            (previous) =>
              (refunds!.find((item) => item.externalId === previous.externalId)
                ?.amountMinor ?? 0) < previous.amountMinor,
          ) ||
          next.refundedMinor < row.refundedMinor
        )
          refuse(
            "REFUND_REGRESSION",
            "لا يجوز تقليل الاسترداد التراكمي المثبت",
          );
        if (
          (event.type === "REFUND" &&
            (event.refundedTotalMinor !== next.refundedMinor ||
              event.amountMinor !== next.refundedMinor - row.refundedMinor)) ||
          (event.type !== "REFUND" && event.amountMinor !== row.grossMinor)
        )
          refuse(
            "REFUND_AMOUNT_MISMATCH",
            "مبلغ الحدث لا يطابق الفرق التراكمي أو المعاملة الأصلية",
          );
        if (next.commissionMinor > from.earnedMinor)
          refuse(
            "REFUND_REEARNING_DENIED",
            "الاسترداد لا يزيد العمولة المثبتة",
          );
        refundedMinor = next.refundedMinor;
        to = reducedBalances(from, next.commissionMinor);
        if (next.commissionMinor === 0 && state !== "DISPUTED")
          state = "REVERSED";
      } else refuse("UNSUPPORTED_EVENT", "نوع الحدث غير مدعوم");
    }
    const eventId = randomUUID();
    await tx.insert(connectExternalEvents).values({
      id: eventId,
      partnerId: row.partnerId,
      integrationId: row.integrationId,
      transactionId: row.id,
      externalEventId: event.eventId,
      sequence: event.sequence,
      kind: event.type,
      payload: event,
      payloadDigest: digest,
      credentialPrefix: `dnr_${context.keyId}`,
      occurredAt: new Date(event.occurredAt),
    });
    await lines(tx, row, from, to, { eventId }, force);
    if (event.sequence > 1) {
      const [updated] = await tx
        .update(connectTransactions)
        .set({
          state: state!,
          refundedMinor,
          disputeFromState,
          lastSequence: event.sequence,
          updatedAt: new Date(),
        })
        .where(eq(connectTransactions.id, row.id))
        .returning();
      row = updated!;
    }
    return {
      duplicate: false,
      eventId: event.eventId,
      transaction: transactionView(row, to),
    };
  });
}
export async function financeConnectTransaction(
  actor: ConnectActor,
  market: ConnectMarket,
  id: string,
  raw: unknown,
) {
  const command = ConnectFinanceCommand.parse(raw),
    digest = connectDigest(command);
  evidence(command.evidenceReference);
  return db.transaction(async (tx) => {
    await assertConnectAdmin(actor, tx);
    const [scope] = await tx
      .select({
        row: connectTransactions,
        ownerId: businessProfiles.ownerUserId,
        marketId: connectPartners.marketId,
      })
      .from(connectTransactions)
      .innerJoin(
        connectPartners,
        eq(connectPartners.id, connectTransactions.partnerId),
      )
      .innerJoin(
        businessProfiles,
        eq(businessProfiles.id, connectPartners.businessId),
      )
      .where(eq(connectTransactions.id, id))
      .for("update", { of: connectTransactions });
    if (!scope || scope.marketId !== market.id || scope.ownerId === actor.id)
      throw connectError(
        404,
        "NOT_FOUND",
        "المعاملة غير موجودة للمراجعة المستقلة",
      );
    let row = scope.row;
    onlySimulation(row.mode);
    const [prior] = await tx
      .select()
      .from(connectAuditEvents)
      .where(
        and(
          eq(connectAuditEvents.partnerId, row.partnerId),
          eq(connectAuditEvents.actorId, actor.id),
          eq(connectAuditEvents.idempotencyKey, command.idempotencyKey),
        ),
      );
    if (prior) {
      if (prior.requestDigest !== digest || prior.details.transactionId !== id)
        refuse("IDEMPOTENCY_CONFLICT", "مفتاح القرار مستخدم لمحتوى مختلف");
      return { duplicate: true, transaction: prior.details.transaction };
    }
    const from = await connectBalances(tx, id);
    let to = { ...from },
      state = row.state,
      disputeFromState = row.disputeFromState;
    let force: keyof Balances | undefined;
    const terms = await agreementFor(tx, row);
    if (command.action === "MARK_PAYABLE") {
      await assertMarketLegalCapability(market.id, "TRANSACTIONS", tx);
      if (
        state !== "APPROVED" ||
        Date.now() <
          row.occurredAt.getTime() + terms.settlementDueDays * 86400000
      )
        refuse(
          "PAYABLE_REVIEW_REQUIRED",
          "يلزم اعتماد العمولة وبلوغ موعد الاستحقاق المقبول",
        );
      to.payableMinor = Math.max(
        0,
        from.approvedMinor - from.simulatedSettledMinor + from.recoveryDueMinor,
      );
      state = "PAYABLE";
      force = "payableMinor";
    } else if (command.action === "RECONCILE_SIMULATED_SETTLEMENT") {
      await assertMarketLegalCapability(market.id, "TRANSACTIONS", tx);
      if (state !== "PAYABLE" || !command.providerEventId)
        refuse(
          "SETTLEMENT_EVIDENCE_REQUIRED",
          "يلزم ادعاء تسوية موثّق ورصيد مستحق مراجع",
        );
      const [claim] = await tx
        .select()
        .from(connectExternalEvents)
        .where(
          and(
            eq(connectExternalEvents.transactionId, id),
            eq(connectExternalEvents.externalEventId, command.providerEventId!),
            eq(connectExternalEvents.kind, "COMMISSION_SETTLED"),
          ),
        );
      if (!claim)
        refuse(
          "SETTLEMENT_EVIDENCE_REQUIRED",
          "دليل التسوية من هذا الربط غير موجود",
        );
      const consumed = await tx
        .select({ id: connectAuditEvents.id })
        .from(connectAuditEvents)
        .where(
          and(
            eq(connectAuditEvents.partnerId, row.partnerId),
            eq(connectAuditEvents.action, "RECONCILE_SIMULATED_SETTLEMENT"),
            sql`${connectAuditEvents.details}->>'providerEventId'=${command.providerEventId}`,
            sql`${connectAuditEvents.details}->>'transactionId'=${id}`,
          ),
        );
      if (consumed.length)
        refuse(
          "SETTLEMENT_ALREADY_RECONCILED",
          "استُخدم دليل التسوية في قرار سابق",
        );
      const amount = ConnectPartnerEvent.parse(claim!.payload).amountMinor;
      if (amount <= 0 || amount > from.payableMinor)
        refuse(
          "SETTLEMENT_AMOUNT_MISMATCH",
          "تغيّر الرصيد منذ ادعاء التسوية؛ يلزم دليل مطابق جديد",
        );
      to.payableMinor -= amount;
      to.simulatedSettledMinor += amount;
      state = to.payableMinor === 0 ? "SETTLED" : "PAYABLE";
    } else if (command.action === "OPEN_DISPUTE") {
      if (state === "REVERSED" || state === "DISPUTED")
        refuse("DISPUTE_STATE_CONFLICT", "الحالة لا تقبل فتح نزاع جديد");
      disputeFromState = state;
      state = "DISPUTED";
      to.payableMinor = 0;
    } else {
      if (state !== "DISPUTED" || !command.resolution)
        refuse("DISPUTE_REVIEW_REQUIRED", "يلزم نزاع قائم وقرار تسوية صريح");
      if (command.resolution === "REVERSE") {
        to = reducedBalances(from, 0);
        state = "REVERSED";
      } else if (from.earnedMinor === 0) state = "REVERSED";
      else if (
        ["PAYABLE", "SETTLED"].includes(disputeFromState ?? "") &&
        from.approvedMinor > 0
      ) {
        to.payableMinor = Math.max(
          0,
          from.approvedMinor -
            from.simulatedSettledMinor +
            from.recoveryDueMinor,
        );
        state =
          to.payableMinor > 0
            ? "PAYABLE"
            : from.simulatedSettledMinor > 0
              ? "SETTLED"
              : "APPROVED";
        if (state === "PAYABLE") force = "payableMinor";
      } else state = from.approvedMinor > 0 ? "APPROVED" : "VERIFIED";
      disputeFromState = null;
    }
    const auditId = randomUUID();
    const nextRow = { ...row, state, disputeFromState, updatedAt: new Date() },
      receipt = transactionView(nextRow, to);
    await connectAudit(
      tx,
      row.partnerId,
      actor.id,
      "ADMIN",
      command.action,
      {
        transactionId: id,
        providerEventId: command.providerEventId ?? null,
        evidenceReference: command.evidenceReference,
        transaction: receipt,
      },
      {
        id: auditId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
      },
    );
    await lines(tx, row, from, to, { auditId }, force);
    await tx
      .update(connectTransactions)
      .set({ state, disputeFromState, updatedAt: nextRow.updatedAt })
      .where(eq(connectTransactions.id, id));
    return { duplicate: false, transaction: receipt };
  });
}
