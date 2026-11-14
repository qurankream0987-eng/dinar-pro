/**
 * Server-owned attribution for paid placements (Monetization V3).
 *
 * - A delivered paid card carries an opaque token: an HMAC-signed, expiring payload naming
 *   the campaign, listing, placement, result set, market and the viewer's one-way actor
 *   key. It holds no personal data and the client can never choose a campaign or a cost.
 * - Qualified events are deduplicated by a unique key per window, so replays and repeated
 *   clicks count once; the campaign owner's own views are recorded as SKIPPED_SELF and are
 *   never billed or counted as results.
 * - A billable engagement charges the campaign budget atomically (chargeCampaignEvent).
 * - A conversion links an ordinary canonical order to an earlier engagement; it stores the
 *   order id only — never its price or any negotiated terms.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiResultSets,
  db,
  demandSignals,
  listingPromotions,
  orderItems,
  orders,
  promotionAttributions,
} from "@workspace/db";
import {
  actorKey,
  commercialSignature,
  getCommercialPolicy,
  trafficClass,
  type EngagementKind,
} from "./commercial-policy";
import { chargeCampaignEvent, isServingCampaign } from "./promotions";
import { logger } from "./logger";

type Market = { id: string; minorUnitScale: number; currencyCode: string };

const TokenPayload = z
  .object({
    p: z.string().min(1).max(64),
    l: z.string().min(1).max(64),
    pl: z.string().min(1).max(40),
    r: z.string().max(64).optional(),
    m: z.string().min(1).max(8),
    v: z.string().min(1).max(64),
    e: z.number().int(),
  })
  .strict();

export async function mintAttributionToken(input: {
  promotionId: string;
  listingId: string;
  placement: string;
  resultSetId?: string;
  marketId: string;
  viewerUserId: string;
}): Promise<string> {
  const policy = await getCommercialPolicy(input.marketId);
  const payload = Buffer.from(
    JSON.stringify({
      p: input.promotionId,
      l: input.listingId,
      pl: input.placement,
      ...(input.resultSetId ? { r: input.resultSetId } : {}),
      m: input.marketId,
      v: actorKey(input.viewerUserId),
      e: Date.now() + policy.attributionTokenTtlMinutes * 60_000,
    }),
  ).toString("base64url");
  return `${payload}.${commercialSignature("attribution", payload)}`;
}

/** Signature, expiry, market and viewer must all match; anything else is rejected. */
export function verifyAttributionToken(token: string, context: { viewerUserId: string; marketId: string }) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || token.length > 1024) return undefined;
  const expected = commercialSignature("attribution", payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  let parsed;
  try {
    parsed = TokenPayload.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (value.e < Date.now() || value.m !== context.marketId || value.v !== actorKey(context.viewerUserId)) return undefined;
  return value;
}

export type AttributionOutcome = {
  recorded: boolean;
  duplicate: boolean;
  chargeStatus: string;
  chargeMinor: number;
};

/**
 * Records one qualified impression or engagement for a campaign that is serving now.
 * Duplicates inside the policy window, self views and inactive campaigns never charge.
 */
export async function recordAttributionEvent(input: {
  promotionId: string;
  listingId: string;
  placement: string;
  /** A distinct placement of the same product (e.g. WELCOME of SPONSORED_RECOMMENDATION), recorded as such. */
  recordedPlacement?: string;
  resultSetId?: string;
  market: Market;
  viewerUserId: string;
  eventType: "IMPRESSION" | "ENGAGEMENT";
  kind?: EngagementKind;
}): Promise<AttributionOutcome> {
  const policy = await getCommercialPolicy(input.market.id);
  const viewerKey = actorKey(input.viewerUserId);
  const now = Date.now();
  const bucket = input.eventType === "IMPRESSION"
    ? Math.floor(now / (policy.impressionDedupMinutes * 60_000))
    : Math.floor(now / (policy.engagementDedupHours * 60 * 60_000));
  const surface = input.recordedPlacement ? `:${input.recordedPlacement}` : "";
  const dedupKey = input.eventType === "IMPRESSION"
    ? `imp:${input.promotionId}:${viewerKey}:${bucket}${surface}`
    : `eng:${input.promotionId}:${viewerKey}:${input.kind}:${bucket}`;
  return db.transaction(async (tx) => {
    const [campaign] = await tx.select().from(listingPromotions).where(eq(listingPromotions.id, input.promotionId));
    if (!campaign || campaign.listingId !== input.listingId || campaign.marketId !== input.market.id || campaign.placementSnapshot !== input.placement)
      throw Object.assign(new Error("إسناد غير صالح"), { status: 400, code: "ATTRIBUTION_INVALID" });
    const self = campaign.sellerId === input.viewerUserId;
    const serving = isServingCampaign(campaign, new Date());
    const [inserted] = await tx
      .insert(promotionAttributions)
      .values({
        id: randomUUID(),
        promotionId: campaign.id,
        listingId: campaign.listingId,
        sellerId: campaign.sellerId,
        marketId: campaign.marketId,
        placement: input.recordedPlacement ?? campaign.placementSnapshot,
        resultSetId: input.resultSetId ?? null,
        viewerKey,
        eventType: input.eventType,
        engagementKind: input.eventType === "ENGAGEMENT" ? input.kind! : null,
        chargeStatus: self ? "SKIPPED_SELF" : !serving ? "SKIPPED_INACTIVE" : "NOT_BILLABLE",
        dedupKey,
        policyVersion: policy.version,
        trafficClass: trafficClass(),
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return { recorded: false, duplicate: true, chargeStatus: "DUPLICATE", chargeMinor: 0 };
    let chargeStatus = inserted.chargeStatus;
    let chargeMinor = 0;
    const billable =
      !self &&
      serving &&
      input.eventType === "ENGAGEMENT" &&
      campaign.budgetMinor != null &&
      policy.billableEngagementKinds.includes(input.kind!);
    if (billable) {
      const charge = await chargeCampaignEvent(tx, campaign.id, dedupKey, input.kind!);
      chargeStatus = charge.status;
      chargeMinor = charge.chargeMinor;
      await tx
        .update(promotionAttributions)
        .set({ chargeStatus: charge.status, chargeMinor: charge.chargeMinor, ledgerEntryId: charge.ledgerEntryId ?? null })
        .where(eq(promotionAttributions.id, inserted.id));
    }
    logger.info({ event: input.eventType === "IMPRESSION" ? "qualified_impression" : "qualified_engagement", marketId: campaign.marketId, chargeStatus }, "paid placement event");
    return { recorded: true, duplicate: false, chargeStatus, chargeMinor };
  });
}

/** Client-reported delivery or click, accepted only through a valid opaque token. */
export async function recordTokenEvent(input: {
  token: string;
  event: "IMPRESSION" | "DETAIL_OPENED";
  viewerUserId: string;
  market: Market;
}): Promise<AttributionOutcome> {
  const value = verifyAttributionToken(input.token, { viewerUserId: input.viewerUserId, marketId: input.market.id });
  if (!value) throw Object.assign(new Error("رمز الإسناد غير صالح أو منتهي"), { status: 400, code: "ATTRIBUTION_INVALID" });
  return recordAttributionEvent({
    promotionId: value.p,
    listingId: value.l,
    placement: value.pl,
    resultSetId: value.r,
    market: input.market,
    viewerUserId: input.viewerUserId,
    eventType: input.event === "IMPRESSION" ? "IMPRESSION" : "ENGAGEMENT",
    ...(input.event === "DETAIL_OPENED" ? { kind: "DETAIL_OPENED" as const } : {}),
  });
}

export type SponsoredCampaignMap = Record<string, { promotionId: string; placement: string }>;

/**
 * Engagements the server observes itself inside the conversation (opening, comparing,
 * negotiating or reviewing a purchase of a listing that was a paid placement in the
 * buyer's own latest result set). No token is needed: the server owns that ResultSet.
 */
export async function recordConversationEngagement(input: {
  conversationId: string;
  market: Market;
  viewerUserId: string;
  listingIds: string[];
  kind: EngagementKind;
}) {
  if (!input.listingIds.length) return [];
  const sets = await db
    .select({ id: aiResultSets.id, query: aiResultSets.query })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, input.conversationId), eq(aiResultSets.marketId, input.market.id)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(10);
  const outcomes: AttributionOutcome[] = [];
  for (const listingId of [...new Set(input.listingIds)]) {
    const set = sets.find((row) => (row.query as { sponsoredCampaigns?: SponsoredCampaignMap })?.sponsoredCampaigns?.[listingId]);
    const paid = (set?.query as { sponsoredCampaigns?: SponsoredCampaignMap } | undefined)?.sponsoredCampaigns?.[listingId];
    if (!set || !paid) continue;
    try {
      outcomes.push(
        await recordAttributionEvent({
          promotionId: paid.promotionId,
          listingId,
          placement: paid.placement,
          resultSetId: set.id,
          market: input.market,
          viewerUserId: input.viewerUserId,
          eventType: "ENGAGEMENT",
          kind: input.kind,
        }),
      );
    } catch {
      // A stale or mismatched placement is simply not attributed.
    }
  }
  return outcomes;
}

/**
 * After a canonical order commits: attribute it to campaigns the buyer engaged with
 * inside the conversion window. Order authority, price and commission are untouched.
 */
export async function attributeOrderConversions(input: { buyerId: string; marketId: string; orderIds: string[] }) {
  if (!input.orderIds.length) return 0;
  const policy = await getCommercialPolicy(input.marketId);
  const viewerKey = actorKey(input.buyerId);
  const items = await db
    .select({ orderId: orderItems.orderId, listingId: orderItems.offerId })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inArray(orderItems.orderId, input.orderIds), eq(orders.buyerId, input.buyerId)));
  const since = new Date(Date.now() - policy.conversionWindowDays * 24 * 60 * 60 * 1000);
  let recorded = 0;
  for (const item of items) {
    const engaged = await db
      .select()
      .from(promotionAttributions)
      .where(
        and(
          eq(promotionAttributions.viewerKey, viewerKey),
          eq(promotionAttributions.listingId, item.listingId),
          eq(promotionAttributions.eventType, "ENGAGEMENT"),
          gte(promotionAttributions.createdAt, since),
          sql`${promotionAttributions.chargeStatus} <> 'SKIPPED_SELF'`,
        ),
      )
      .orderBy(desc(promotionAttributions.createdAt))
      .limit(1);
    const source = engaged[0];
    if (!source) continue;
    const [row] = await db
      .insert(promotionAttributions)
      .values({
        id: randomUUID(),
        promotionId: source.promotionId,
        listingId: source.listingId,
        sellerId: source.sellerId,
        marketId: source.marketId,
        placement: source.placement,
        resultSetId: source.resultSetId,
        viewerKey,
        eventType: "CONVERSION",
        orderId: item.orderId,
        chargeStatus: "NOT_BILLABLE",
        dedupKey: `conv:${source.promotionId}:${item.orderId}`,
        policyVersion: policy.version,
        trafficClass: trafficClass(),
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      recorded++;
      logger.info({ event: "conversion_attributed", marketId: source.marketId }, "conversion attributed");
    }
  }
  // The buyer's recent open need in this market is now converted.
  await db
    .update(demandSignals)
    .set({ state: "CONVERTED", updatedAt: new Date() })
    .where(and(eq(demandSignals.actorKey, viewerKey), eq(demandSignals.marketId, input.marketId), gte(demandSignals.createdAt, since), inArray(demandSignals.state, ["SEARCHED", "ZERO_RESULTS", "LOW_SUPPLY", "USER_UNSATISFIED", "SATISFIED"])));
  return recorded;
}

/** Bounded raw-event retention; aggregates computed from them are not affected later. */
export async function purgeExpiredCommercialEvents(marketId?: string) {
  const policy = await getCommercialPolicy(marketId ?? "");
  const cutoff = new Date(Date.now() - policy.rawEventRetentionDays * 24 * 60 * 60 * 1000);
  const attributions = await db.delete(promotionAttributions).where(lt(promotionAttributions.createdAt, cutoff)).returning({ id: promotionAttributions.id });
  const signals = await db.delete(demandSignals).where(lt(demandSignals.expiresAt, new Date())).returning({ id: demandSignals.id });
  return { attributions: attributions.length, signals: signals.length };
}
