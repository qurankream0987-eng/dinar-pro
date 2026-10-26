/**
 * G2 — the one generic price-negotiation authority.
 *
 * A buyer may propose a price on every published listing, whatever its category or price
 * representation (owner policy 2026-10-24). The seller alone decides on a buyer's proposal;
 * a seller's counter only binds once the buyer accepts it.
 * Parties are always derived on the server: seller = listing owner, buyer = the actor.
 * Minimal states: OPEN (buyer's offer awaits the seller), COUNTERED (seller's counter
 * awaits the buyer), ACCEPTED, REJECTED, WITHDRAWN, EXPIRED. Every transition re-reads
 * and locks the negotiation and its listing. An agreed amount is private to that buyer:
 * the public listing price never changes, and checkout (the canonical order authority)
 * resolves and consumes it server-side. Nothing here creates orders, payments or
 * commission, and nothing here decides on a party's behalf.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, negotiations, negotiationEvents, offers, users } from "@workspace/db";
import {
  acceptsPriceProposals,
  negotiationDecisions,
  priceRepresentationOf,
  proposalCeilingMinor,
} from "@workspace/api-zod/listing-pricing";
import type { marketFor } from "./markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
export type Negotiation = typeof negotiations.$inferSelect;
export type NegotiationRole = "BUYER" | "SELLER";

export const NEGOTIATION_OPEN_TTL_MS = 48 * 60 * 60 * 1000;
export const NEGOTIATION_ACCEPTED_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE = ["OPEN", "COUNTERED"] as const;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * A definite asking price (FIXED or NEGOTIABLE) caps a proposal: an amount up to and including it
 * is negotiable, so a seller may answer «my price is the listed one». A starting amount or guide
 * price is not a ceiling.
 */
export const OFFER_ABOVE_LISTED = "عرضك أعلى من السعر المعلن؛ اعرض السعر المعلن أو أقل";

async function recordEvent(
  tx: any,
  row: Negotiation,
  input: {
    actorId: string;
    actorRole: NegotiationRole;
    eventType: string;
    amountMinor?: number | null;
  },
) {
  await tx.insert(negotiationEvents).values({
    id: randomUUID(),
    negotiationId: row.id,
    version: row.version,
    actorId: input.actorId,
    actorRole: input.actorRole,
    eventType: input.eventType,
    amountMinor: input.amountMinor ?? null,
    currencyCode: row.currencyCode,
    status: row.status,
    expiresAt: row.expiresAt,
  });
}

export const NEGOTIATION_STATUS_LABELS: Record<string, string> = {
  OPEN: "بانتظار رد البائع",
  COUNTERED: "البائع أرسل عرضًا مضادًا",
  ACCEPTED: "تم الاتفاق",
  REJECTED: "مرفوض",
  WITHDRAWN: "مسحوب",
  EXPIRED: "منتهي",
};

type PricedRow = Pick<typeof offers.$inferSelect, "data" | "pricingMode" | "unitPriceMinor">;

/** Universal negotiation: any listing whose price representation is known accepts proposals. */
export function listingNegotiable(row: PricedRow): boolean {
  return acceptsPriceProposals(priceRepresentationOf(row));
}

/** The most a proposal or seller counter may ask on this listing, if anything caps it. */
export function proposalCeiling(row: PricedRow): number | null {
  return proposalCeilingMinor(priceRepresentationOf(row), row.unitPriceMinor);
}

/** The status a stored negotiation has now: an unconsumed one past its expiry is EXPIRED. */
export function effectiveStatus(row: Negotiation, now = Date.now()): string {
  if (row.expiresAt.getTime() <= now && (ACTIVE as readonly string[]).includes(row.status)) return "EXPIRED";
  if (row.expiresAt.getTime() <= now && row.status === "ACCEPTED" && !row.orderId) return "EXPIRED";
  return row.status;
}

/** Whose decision the negotiation awaits, if anyone's. */
export function awaitingRole(row: Negotiation): NegotiationRole | null {
  const status = effectiveStatus(row);
  return status === "OPEN" ? "SELLER" : status === "COUNTERED" ? "BUYER" : null;
}

export function roleOf(row: Negotiation, actorId: string): NegotiationRole | null {
  return row.buyerId === actorId ? "BUYER" : row.sellerId === actorId ? "SELLER" : null;
}

/** The amount currently on the table: the counter while COUNTERED, else the buyer's offer. */
export function currentAmountMinor(row: Negotiation): number | null {
  return row.agreedAmountMinor ?? (row.status === "COUNTERED" && row.counterAmountMinor ? row.counterAmountMinor : row.offerAmountMinor);
}

export type CommercialPriceResolution =
  | { source: "LISTING_PRICE"; unitPriceMinor: number; listedUnitPriceMinor: number }
  | { source: "NEGOTIATED_PRICE"; unitPriceMinor: number; listedUnitPriceMinor: number | null; negotiationId: string };

/** The single buyer-specific price authority used by review and checkout. */
export function resolveCommercialUnitPrice(
  listing: Pick<typeof offers.$inferSelect, "unitPriceMinor"> &
    Partial<Pick<typeof offers.$inferSelect, "pricingMode" | "data">>,
  agreement?: Pick<Negotiation, "status" | "agreedAmountMinor" | "id">,
): CommercialPriceResolution | null {
  if (
    agreement?.status === "ACCEPTED" &&
    agreement.agreedAmountMinor !== null &&
    agreement.agreedAmountMinor >= 1
  )
    return {
      source: "NEGOTIATED_PRICE",
      unitPriceMinor: agreement.agreedAmountMinor,
      listedUnitPriceMinor: listing.unitPriceMinor,
      negotiationId: agreement.id,
    };
  // Neither a guide price, a starting amount nor a quotation request is a purchase price.
  const representation = listing.pricingMode === undefined
    ? "FIXED"
    : priceRepresentationOf({ pricingMode: listing.pricingMode, unitPriceMinor: listing.unitPriceMinor, data: listing.data });
  if (
    listing.unitPriceMinor === null ||
    representation === null ||
    representation === "OPEN_TO_OFFERS" ||
    representation === "STARTING_FROM" ||
    representation === "QUOTE_REQUIRED"
  )
    return null;
  return {
    source: "LISTING_PRICE",
    unitPriceMinor: listing.unitPriceMinor,
    listedUnitPriceMinor: listing.unitPriceMinor,
  };
}

const availableOf = (row: typeof offers.$inferSelect) =>
  row.inventoryMode === "UNLIMITED" ? null : (row.availableQuantity ?? 0) - row.reservedQuantity;

/** Everything an offer on this listing depends on; a reason string means "not allowed". */
function listingProblem(listing: typeof offers.$inferSelect | undefined, market: Market, buyerId: string, quantity: number) {
  if (!listing || listing.marketId !== market.id) return "العرض غير موجود في سوقك الحالي";
  if (listing.status !== "PUBLISHED") return "العرض لم يعد متاحًا";
  if (listing.sellerId === buyerId) return "لا يمكنك التفاوض على عرضك";
  if (!listingNegotiable(listing)) return "تسعير هذا الإعلان غير متاح للتفاوض حاليًا";
  const available = availableOf(listing);
  if (available !== null && available <= 0) return "المنتج لم يعد متوفرًا";
  if (available !== null && quantity > available) return `المتوفر الآن ${available} فقط`;
  return undefined;
}

async function activeActor(actorId: string, market: Market, tx: any) {
  const [actor] = await tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId));
  if (!actor || actor.status !== "ACTIVE") throw fail(403, "حسابك غير نشط حاليًا");
  if (actor.activeMarketId !== market.id) throw fail(409, "غيّر السوق النشط أولًا");
}

/** Reads a negotiation only for one of its two parties; anyone else gets "not found". */
export async function negotiationForParty(actorId: string, negotiationId: string, tx: any = db): Promise<Negotiation | undefined> {
  const [row] = await tx
    .select()
    .from(negotiations)
    .where(and(eq(negotiations.id, negotiationId), or(eq(negotiations.buyerId, actorId), eq(negotiations.sellerId, actorId))));
  return row;
}

/** Pre-check for a buyer's offer review; changes nothing. */
export async function offerPreconditions(input: { buyerId: string; listingId: string; amountMinor?: number; type?: "BUYER_PRICE_OFFER" | "BEST_PRICE_REQUEST"; quantity: number; market: Market }) {
  const [listing] = await db.select().from(offers).where(eq(offers.id, input.listingId));
  const problem = listingProblem(listing, input.market, input.buyerId, input.quantity);
  if (problem) return { problem, listing };
  if (input.type !== "BEST_PRICE_REQUEST" && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor! < 1)) return { problem: "المبلغ غير صالح", listing };
  const ceiling = proposalCeiling(listing!);
  if (input.type !== "BEST_PRICE_REQUEST" && ceiling !== null && input.amountMinor! > ceiling)
    return { problem: OFFER_ABOVE_LISTED, listing };
  return { listing: listing! };
}

/**
 * Buyer sends (or replaces) its offer. One active negotiation per buyer and listing:
 * a new amount while one is OPEN/COUNTERED updates that negotiation back to OPEN.
 */
export async function openNegotiation(input: { buyerId: string; listingId: string; amountMinor?: number; type?: "BUYER_PRICE_OFFER" | "BEST_PRICE_REQUEST"; quantity: number; market: Market }) {
  return db.transaction(async (tx) => {
    await activeActor(input.buyerId, input.market, tx);
    const [listing] = await tx.select().from(offers).where(eq(offers.id, input.listingId)).for("update");
    const problem = listingProblem(listing, input.market, input.buyerId, input.quantity);
    if (problem) throw fail(409, problem);
    const isBestPriceRequest = input.type === "BEST_PRICE_REQUEST";
    if (!isBestPriceRequest && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor! < 1)) throw fail(400, "المبلغ غير صالح");
    const ceiling = proposalCeiling(listing!);
    if (!isBestPriceRequest && ceiling !== null && input.amountMinor! > ceiling)
      throw fail(409, OFFER_ABOVE_LISTED);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + NEGOTIATION_OPEN_TTL_MS);
    const [existing] = await tx
      .select()
      .from(negotiations)
      .where(and(eq(negotiations.listingId, listing!.id), eq(negotiations.buyerId, input.buyerId), inArray(negotiations.status, [...ACTIVE])))
      .for("update");
    if (existing && effectiveStatus(existing) !== "EXPIRED") {
      if (
        existing.status === "OPEN" &&
        existing.lastActor === "BUYER" &&
        existing.offerAmountMinor === (input.amountMinor ?? null)
      )
        return existing;
      const [updated] = await tx
        .update(negotiations)
        .set({
          status: "OPEN",
          offerAmountMinor: input.amountMinor ?? null,
          counterAmountMinor: null,
          quantity: input.quantity,
          listedPriceMinor: listing!.unitPriceMinor,
          lastActor: "BUYER",
          expiresAt,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(negotiations.id, existing.id))
        .returning();
      await recordEvent(tx, updated!, {
        actorId: input.buyerId,
        actorRole: "BUYER",
        eventType: isBestPriceRequest ? "BEST_PRICE_REQUEST" : "BUYER_PRICE_OFFER",
        amountMinor: input.amountMinor,
      });
      return updated!;
    }
    if (existing)
      {
        const [expired] = await tx.update(negotiations).set({ status: "EXPIRED", version: existing.version + 1, updatedAt: now }).where(eq(negotiations.id, existing.id)).returning();
        await recordEvent(tx, expired!, { actorId: input.buyerId, actorRole: "BUYER", eventType: "EXPIRE" });
      }
    const [created] = await tx
      .insert(negotiations)
      .values({
        id: randomUUID(),
        listingId: listing!.id,
        marketId: input.market.id,
        sellerId: listing!.sellerId,
        buyerId: input.buyerId,
        status: "OPEN",
        currencyCode: input.market.currencyCode,
        minorUnitScale: input.market.minorUnitScale,
        listedPriceMinor: listing!.unitPriceMinor,
        offerAmountMinor: input.amountMinor ?? null,
        quantity: input.quantity,
        lastActor: "BUYER",
        expiresAt,
      })
      .returning();
    await recordEvent(tx, created!, {
      actorId: input.buyerId,
      actorRole: "BUYER",
      eventType: isBestPriceRequest ? "BEST_PRICE_REQUEST" : "BUYER_PRICE_OFFER",
      amountMinor: input.amountMinor,
    });
    return created!;
  });
}

type Decision = "COUNTER" | "ACCEPT" | "REJECT" | "WITHDRAW";

/**
 * Counter / accept / reject by the party the negotiation awaits; withdraw by the buyer, or by
 * the seller of its own unaccepted counter. Acceptance re-validates the listing under lock
 * (published, same market and currency, stock for the quantity, and an agreed amount no higher
 * than a definite asking price that changed since the proposal).
 */
export async function decideNegotiation(input: {
  actorId: string;
  negotiationId: string;
  decision: Decision;
  market: Market;
  amountMinor?: number;
  expectedVersion?: number;
}): Promise<Negotiation> {
  const outcome = await db.transaction(async (tx): Promise<Negotiation | "EXPIRED"> => {
    await activeActor(input.actorId, input.market, tx);
    const [row] = await tx
      .select()
      .from(negotiations)
      .where(and(eq(negotiations.id, input.negotiationId), or(eq(negotiations.buyerId, input.actorId), eq(negotiations.sellerId, input.actorId))))
      .for("update");
    if (!row || row.marketId !== input.market.id) throw fail(404, "عرض السعر غير موجود");
    const role = roleOf(row, input.actorId)!;
    const now = new Date();
    const status = effectiveStatus(row);
    // Recorded, then refused after the transaction commits, so the expiry is kept.
    if (status === "EXPIRED" && row.status !== "EXPIRED") {
      const [expired] = await tx.update(negotiations).set({ status: "EXPIRED", version: row.version + 1, updatedAt: now }).where(eq(negotiations.id, row.id)).returning();
      await recordEvent(tx, expired!, { actorId: input.actorId, actorRole: role, eventType: "EXPIRE" });
      return "EXPIRED";
    }
    if (!(ACTIVE as readonly string[]).includes(status)) throw fail(409, `عرض السعر ${NEGOTIATION_STATUS_LABELS[status] ?? status} بالفعل`);
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) throw fail(409, "تغيّر عرض السعر منذ المراجعة");
    if (input.decision === "WITHDRAW") {
      // The seller withdraws only its own counter that the buyer has not accepted; a buyer's
      // proposal awaiting the seller is answered by rejecting it.
      if (role === "SELLER" && status !== "COUNTERED")
        throw fail(409, "يسحب البائع عرضه المقابل فقط؛ لعرض المشتري استخدم الرفض");
      const [updated] = await tx.update(negotiations).set({ status: "WITHDRAWN", lastActor: role, version: row.version + 1, updatedAt: now }).where(eq(negotiations.id, row.id)).returning();
      await recordEvent(tx, updated!, { actorId: input.actorId, actorRole: role, eventType: "WITHDRAW" });
      return updated!;
    }
    if (awaitingRole(row) !== role) throw fail(409, "عرض السعر بانتظار رد الطرف الآخر");
    if (input.decision === "REJECT") {
      const [updated] = await tx.update(negotiations).set({ status: "REJECTED", lastActor: role, version: row.version + 1, updatedAt: now }).where(eq(negotiations.id, row.id)).returning();
      await recordEvent(tx, updated!, { actorId: input.actorId, actorRole: role, eventType: "REJECT", amountMinor: currentAmountMinor(row) });
      return updated!;
    }
    const [listing] = await tx.select().from(offers).where(eq(offers.id, row.listingId)).for("update");
    const problem = listingProblem(listing, input.market, row.buyerId, row.quantity);
    if (problem) throw fail(409, problem);
    if (row.currencyCode !== input.market.currencyCode) throw fail(409, "عملة العرض تغيّرت");
    if (input.decision === "COUNTER") {
      const amount = input.amountMinor;
      if (!amount || !Number.isSafeInteger(amount) || amount < 1) throw fail(400, "المبلغ غير صالح");
      if (
        role === "SELLER" &&
        row.offerAmountMinor !== null &&
        amount <= row.offerAmountMinor
      )
        throw fail(409, "العرض المضاد يجب أن يكون أعلى من عرض المشتري؛ أو اقبل عرضه");
      if (
        role === "BUYER" &&
        (row.counterAmountMinor === null || amount >= row.counterAmountMinor)
      )
        throw fail(409, "عرضك المضاد يجب أن يكون أقل من عرض البائع؛ أو اقبل عرضه");
      const ceiling = proposalCeiling(listing!);
      if (ceiling !== null && amount > ceiling)
        throw fail(409, "المبلغ أعلى من السعر المعلن؛ اعرض السعر المعلن أو أقل");
      const isSellerCounter = role === "SELLER";
      const [updated] = await tx
        .update(negotiations)
        .set({
          status: isSellerCounter ? "COUNTERED" : "OPEN",
          offerAmountMinor: isSellerCounter ? row.offerAmountMinor : amount,
          counterAmountMinor: isSellerCounter ? amount : null,
          lastActor: role,
          expiresAt: new Date(now.getTime() + NEGOTIATION_OPEN_TTL_MS),
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(negotiations.id, row.id))
        .returning();
      await recordEvent(tx, updated!, {
        actorId: input.actorId,
        actorRole: role,
        eventType: isSellerCounter ? "SELLER_COUNTER_OFFER" : "BUYER_COUNTER_OFFER",
        amountMinor: amount,
      });
      return updated!;
    }
    const agreed = status === "COUNTERED" ? row.counterAmountMinor : row.offerAmountMinor;
    if (agreed === null) throw fail(409, "البائع لم يحدد سعرًا بعد؛ أرسل عرضًا مضادًا أولًا");
    // The asking price may have dropped since the proposal: nobody agrees above it.
    const ceiling = proposalCeiling(listing!);
    if (ceiling !== null && agreed > ceiling)
      throw fail(409, "تغيّر السعر المعلن منذ العرض وأصبح أقل من المبلغ المعروض؛ اشترِ بالسعر المعلن أو أرسل عرضًا جديدًا");
    const [updated] = await tx
      .update(negotiations)
      .set({ status: "ACCEPTED", agreedAmountMinor: agreed, lastActor: role, expiresAt: new Date(now.getTime() + NEGOTIATION_ACCEPTED_TTL_MS), version: row.version + 1, updatedAt: now })
      .where(eq(negotiations.id, row.id))
      .returning();
    await recordEvent(tx, updated!, {
      actorId: input.actorId,
      actorRole: role,
      eventType: "ACCEPT",
      amountMinor: agreed,
    });
    return updated!;
  });
  if (outcome === "EXPIRED") throw fail(409, "انتهت صلاحية عرض السعر");
  return outcome;
}

/**
 * Checkout's only entry: the buyer's unconsumed, unexpired ACCEPTED negotiation for a
 * listing, locked for the order transaction. Never takes an amount from the caller.
 */
export async function acceptedNegotiationForCheckout(tx: any, buyerId: string, listingId: string): Promise<Negotiation | undefined> {
  const rows: Negotiation[] = await tx
    .select()
    .from(negotiations)
    .where(and(eq(negotiations.buyerId, buyerId), eq(negotiations.listingId, listingId), eq(negotiations.status, "ACCEPTED")))
    .orderBy(desc(negotiations.updatedAt))
    .for("update");
  return rows.find((row) => !row.orderId && effectiveStatus(row) === "ACCEPTED");
}

/** The buyer's usable agreements by listing in one market, without locking: what a cart may hold and show. */
export async function acceptedAgreementsByListing(buyerId: string, marketId: string, listingIds: string[], tx: any = db): Promise<Map<string, Negotiation>> {
  const byListing = new Map<string, Negotiation>();
  if (!listingIds.length) return byListing;
  const rows: Negotiation[] = await tx
    .select()
    .from(negotiations)
    .where(and(eq(negotiations.buyerId, buyerId), eq(negotiations.marketId, marketId), inArray(negotiations.listingId, listingIds), eq(negotiations.status, "ACCEPTED")))
    .orderBy(desc(negotiations.updatedAt));
  for (const row of rows)
    if (!row.orderId && (row.agreedAmountMinor ?? 0) >= 1 && effectiveStatus(row) === "ACCEPTED" && !byListing.has(row.listingId))
      byListing.set(row.listingId, row);
  return byListing;
}

/** Marks an accepted negotiation as used by exactly one order (same transaction). */
export async function consumeNegotiation(tx: any, negotiationId: string, orderId: string) {
  const [updated] = await tx
    .update(negotiations)
    .set({ orderId, updatedAt: new Date() })
    .where(and(eq(negotiations.id, negotiationId), eq(negotiations.status, "ACCEPTED")))
    .returning({ id: negotiations.id });
  if (!updated) throw fail(409, "تعذر استخدام السعر المتفق عليه");
}

/** A party's own negotiations, newest first; the other party's identity is never exposed. */
export async function negotiationsFor(actorId: string, role: NegotiationRole, market: Market, statuses?: string[]) {
  const rows: Negotiation[] = await db
    .select()
    .from(negotiations)
    .where(and(role === "BUYER" ? eq(negotiations.buyerId, actorId) : eq(negotiations.sellerId, actorId), eq(negotiations.marketId, market.id)))
    .orderBy(desc(negotiations.updatedAt))
    .limit(24);
  return rows.filter((row) => !statuses || statuses.includes(effectiveStatus(row)));
}

const money = (minor: number | null, scale: number) => (minor === null ? null : (minor / 10 ** scale).toFixed(scale));

/** The allowlisted view of one negotiation for one of its parties. */
export async function negotiationView(row: Negotiation, actorId: string) {
  const role = roleOf(row, actorId);
  if (!role) return null;
  const [listing] = await db.select({ data: offers.data, unitPriceMinor: offers.unitPriceMinor, status: offers.status, pricingMode: offers.pricingMode }).from(offers).where(eq(offers.id, row.listingId));
  const history = await db
    .select({
      version: negotiationEvents.version,
      actorRole: negotiationEvents.actorRole,
      eventType: negotiationEvents.eventType,
      amountMinor: negotiationEvents.amountMinor,
      currency: negotiationEvents.currencyCode,
      status: negotiationEvents.status,
      createdAt: negotiationEvents.createdAt,
    })
    .from(negotiationEvents)
    .where(eq(negotiationEvents.negotiationId, row.id))
    .orderBy(negotiationEvents.version);
  const status = effectiveStatus(row);
  const awaiting = awaitingRole(row);
  return {
    negotiationId: row.id,
    listingId: row.listingId,
    title: typeof listing?.data?.title === "string" ? listing.data.title : "",
    role,
    status,
    statusLabel: NEGOTIATION_STATUS_LABELS[status] ?? status,
    currency: row.currencyCode,
    listedPrice: money(
      listing?.unitPriceMinor === undefined
        ? row.listedPriceMinor
        : listing.unitPriceMinor,
      row.minorUnitScale,
    ),
    offerAmount: money(row.offerAmountMinor, row.minorUnitScale),
    counterAmount: money(row.counterAmountMinor, row.minorUnitScale),
    agreedAmount: money(row.agreedAmountMinor, row.minorUnitScale),
    history: history.map((event) => ({
      ...event,
      amount: money(event.amountMinor, row.minorUnitScale),
    })),
    quantity: row.quantity,
    priceRepresentation: listing ? priceRepresentationOf(listing) : null,
    /** A buyer's amount-less request: a quotation or best-price request, never a binding offer. */
    priceRequest: row.offerAmountMinor === null,
    decisions: negotiationDecisions({ role, status, amountOnTable: currentAmountMinor(row) !== null }),
    yourTurn: awaiting === role,
    ordered: Boolean(row.orderId),
    expiresAt: row.expiresAt.toISOString(),
  };
}
