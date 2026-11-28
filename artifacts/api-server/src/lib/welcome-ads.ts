/**
 * Welcome-screen sponsored cards — the WELCOME placement of the Sponsored Conversation product
 * («إعلان داخل المحادثة»). Not a separate ad engine: candidates are the same serving
 * SPONSORED_RECOMMENDATION campaigns, gated by the same eligibility (published listing, active
 * seller, policy, inventory) and ranked by the same deterministic sponsored score.
 *
 * Rules the server enforces (the client only renders):
 *   - only on the viewer's own conversation while it has no message; never after the first one,
 *     never on an existing conversation, never stored as a message;
 *   - at most `welcomeSponsoredSlots` (≤ 2) cards, chosen once per conversation and returned
 *     unchanged on every later read (typing or refreshing never rotates them);
 *   - at most `welcomeSponsoredDailyConversations` conversations per viewer per 24 h show any;
 *   - market eligibility only — no personal profiling; the viewer's own listings are excluded;
 *   - one IMPRESSION attribution per card (placement WELCOME), never billable; dismissal hides
 *     them for that conversation.
 * No eligible campaign → no section at all (never filler).
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { conversations, db, listingPromotions, messages, offers, users, welcomeAdExposures } from "@workspace/db";
import { getCommercialPolicy } from "./commercial-policy";
import { isSponsoredServingEnabled } from "./promotion-policy";
import { formatMinor, isServingCampaign, listingPromotionEligibility, rankSponsored, representativeCampaign, sponsoredScore, SPONSORED_LABEL, SERVING_PAYMENT_STATUSES } from "./promotions";
import { jassimAdsEnabled } from "./jassim-ads";
import { recordAttributionEvent } from "./promotion-attribution";
import type { marketFor } from "./markets";
type Market = Awaited<ReturnType<typeof marketFor>>;

export const WELCOME_PLACEMENT = "WELCOME" as const;
export const WELCOME_SOURCE_PLACEMENT = "SPONSORED_RECOMMENDATION" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WelcomeCard = {
  slot: number;
  /** 0084: a display card promotes a listing (default) or a store. */
  kind?: "LISTING" | "STORE";
  businessId?: string;
  listingId: string;
  promotionId: string;
  title: string;
  price: string | null;
  currency: string;
  city: string | null;
  imagePath: string | null;
  sellerName: string;
  label: typeof SPONSORED_LABEL;
  path: string;
};
export type WelcomeAds = { cards: WelcomeCard[]; reason?: "NOT_EMPTY" | "NOT_OWNER" | "DISMISSED" | "DAILY_CAP" | "NO_ELIGIBLE" | "DISABLED" };

async function cardsFor(market: Market, rows: { slot: number; listingId: string; promotionId: string }[]): Promise<WelcomeCard[]> {
  if (!rows.length) return [];
  const listing = await db
    .select({ offer: offers, sellerName: users.displayName })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(inArray(offers.id, rows.map((row) => row.listingId)));
  const byId = new Map(listing.map((row) => [row.offer.id, row]));
  return rows.flatMap((row) => {
    const found = byId.get(row.listingId);
    // A listing that stopped being published since it was chosen is simply not shown.
    if (!found || found.offer.status !== "PUBLISHED") return [];
    const data = found.offer.data as { title?: string; imageUrl?: string; city?: string };
    return [{
      slot: row.slot,
      listingId: row.listingId,
      promotionId: row.promotionId,
      title: String(data.title ?? "").slice(0, 120),
      price: found.offer.unitPriceMinor == null ? null : formatMinor(found.offer.unitPriceMinor, market.minorUnitScale),
      currency: market.currencyCode,
      city: data.city ? String(data.city).slice(0, 60) : null,
      imagePath: data.imageUrl ? String(data.imageUrl) : null,
      sellerName: found.sellerName.slice(0, 60),
      label: SPONSORED_LABEL,
      path: `/listings/${row.listingId}`,
    }];
  });
}

/**
 * `welcomeKey`: the empty conversation's id when one exists, otherwise the client's nonce for the
 * new-conversation screen (kept for that screen only, so a refresh returns the same cards).
 */
export async function welcomeSponsoredCards(input: { actorId: string; welcomeKey: string; conversationId?: string; market: Market; now?: Date }): Promise<WelcomeAds> {
  const now = input.now ?? new Date();
  if (!isSponsoredServingEnabled()) return { cards: [], reason: "DISABLED" };
  if (input.conversationId) {
    const [conversation] = await db.select({ owner: conversations.ownerUserId }).from(conversations).where(eq(conversations.id, input.conversationId));
    if (!conversation || conversation.owner !== input.actorId) return { cards: [], reason: "NOT_OWNER" };
    const [messageCount] = await db.select({ n: count() }).from(messages).where(eq(messages.conversationId, input.conversationId));
    if ((messageCount?.n ?? 0) > 0) return { cards: [], reason: "NOT_EMPTY" };
  }
  // A key that already belongs to a started conversation never shows welcome cards again.
  const [startedByKey] = await db.select({ n: count() }).from(messages).where(eq(messages.conversationId, input.welcomeKey));
  if ((startedByKey?.n ?? 0) > 0) return { cards: [], reason: "NOT_EMPTY" };

  // Already chosen for this conversation: the same cards (or none, once dismissed).
  const ownKey = and(eq(welcomeAdExposures.userId, input.actorId), eq(welcomeAdExposures.welcomeKey, input.welcomeKey));
  const existing = await db.select().from(welcomeAdExposures).where(ownKey);
  if (existing.length) {
    if (existing.some((row) => row.dismissedAt)) return { cards: [], reason: "DISMISSED" };
    return { cards: await cardsFor(input.market, existing.sort((a, b) => a.slot - b.slot)) };
  }

  const policy = await getCommercialPolicy(input.market.id);
  // Owner decision 2026-11-27: up to three cards («إعلانات مميزة لك»); the policy sets the number.
  const slots = Math.min(3, policy.welcomeSponsoredSlots);
  if (slots <= 0) return { cards: [], reason: "DISABLED" };
  const recent = await db
    .selectDistinct({ welcomeKey: welcomeAdExposures.welcomeKey })
    .from(welcomeAdExposures)
    .where(and(eq(welcomeAdExposures.userId, input.actorId), gt(welcomeAdExposures.shownAt, new Date(now.getTime() - DAY_MS))));
  if (recent.length >= policy.welcomeSponsoredDailyConversations) return { cards: [], reason: "DAILY_CAP" };

  const campaigns = (await db
    .select()
    .from(listingPromotions)
    .where(and(
      eq(listingPromotions.marketId, input.market.id),
      eq(listingPromotions.status, "ACTIVE"),
      eq(listingPromotions.placementSnapshot, WELCOME_SOURCE_PLACEMENT),
      inArray(listingPromotions.paymentStatus, [...SERVING_PAYMENT_STATUSES]),
      lte(listingPromotions.startsAt, now),
      gt(listingPromotions.expiresAt, now),
    ))
    .orderBy(desc(listingPromotions.createdAt))
    .limit(50)).filter((row) => isServingCampaign(row, now) && row.sellerId !== input.actorId);
  if (!campaigns.length) return { cards: [], reason: "NO_ELIGIBLE" };
  const listings = await db
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(inArray(offers.id, [...new Set(campaigns.map((row) => row.listingId))]));
  const scored: { id: string; listingId: string; promotionId: string; score: number }[] = [];
  for (const row of listings) {
    const eligible = await listingPromotionEligibility(row.offer, row.sellerStatus, input.market);
    if (!eligible.ok) continue;
    const campaign = campaigns.find((item) => item.listingId === row.offer.id)!;
    scored.push({
      id: row.offer.id,
      listingId: row.offer.id,
      promotionId: campaign.id,
      score: sponsoredScore({
        organicIndex: 0,
        priorityWeight: campaign.priorityWeightSnapshot,
        unitChargeMinor: campaign.unitChargeMinorSnapshot,
        minorUnitScale: input.market.minorUnitScale,
        hasImage: Boolean((row.offer.data as { imageUrl?: string }).imageUrl),
        descriptionLength: String((row.offer.data as { description?: string }).description ?? "").length,
      }),
    });
  }
  const chosen = rankSponsored(scored, slots).map((item, index) => ({ slot: index + 1, listingId: item.listingId, promotionId: item.promotionId }));
  if (!chosen.length) return { cards: [], reason: "NO_ELIGIBLE" };
  // The unique (conversation, slot) index makes a concurrent first read choose once.
  const inserted = await db
    .insert(welcomeAdExposures)
    .values(chosen.map((item) => ({ id: randomUUID(), userId: input.actorId, welcomeKey: input.welcomeKey, conversationId: input.conversationId ?? null, marketId: input.market.id, ...item, shownAt: now })))
    .onConflictDoNothing()
    .returning();
  if (inserted.length !== chosen.length) {
    const winners = await db.select().from(welcomeAdExposures).where(ownKey);
    return { cards: await cardsFor(input.market, winners.sort((a, b) => a.slot - b.slot)) };
  }
  for (const item of chosen)
    await recordAttributionEvent({ promotionId: item.promotionId, listingId: item.listingId, placement: WELCOME_SOURCE_PLACEMENT, recordedPlacement: WELCOME_PLACEMENT, market: input.market, viewerUserId: input.actorId, eventType: "IMPRESSION", resultSetId: `welcome:${input.welcomeKey}` });
  return { cards: await cardsFor(input.market, chosen) };
}

export async function dismissWelcomeCards(input: { actorId: string; welcomeKey: string; now?: Date }) {
  const result = await db
    .update(welcomeAdExposures)
    .set({ dismissedAt: input.now ?? new Date() })
    .where(and(eq(welcomeAdExposures.welcomeKey, input.welcomeKey), eq(welcomeAdExposures.userId, input.actorId), isNull(welcomeAdExposures.dismissedAt)))
    .returning({ id: welcomeAdExposures.id });
  return { dismissed: result.length };
}

/**
 * Jassim Ads Phase 1 (behind DINAR_JASSIM_ADS): display placements around the conversation —
 * the welcome hero carousel (paid VIP campaigns) and the desktop sidebar card (paid FEATURED or
 * VIP campaigns). Owner decision 2026-11-27: visible to signed-out visitors too, so selection is
 * non-personal (market + the same public-visibility gates as search); the viewer's own listings
 * are excluded when signed in. Nothing is persisted or charged here (no exposure rows, no
 * billable events); every card carries the sponsored label. Served only where sponsored
 * placements serve at all (`isSponsoredServingEnabled`: simulation in development/test, or Whop when live).
 */
// 0084: HERO/SIDEBAR are also explicit placements (HERO_BANNER, SIDEBAR_AD) and accept stores.
export const DISPLAY_PLACEMENTS = { HERO: { sources: ["VIP", "HERO"], max: 5 }, SIDEBAR: { sources: ["FEATURED", "VIP", "SIDEBAR"], max: 3 } } as const;
export type DisplayPlacement = keyof typeof DISPLAY_PLACEMENTS;

/**
 * Hero carousel and sidebar card. Eligibility (published, active seller, policy, stock) and a
 * deterministic score decide; payment alone never shows an ad. With a context category (what the
 * viewer is searching or asking about) only ads of that category are shown — none rather than an
 * unrelated one — and stores (which have no single category) are left out.
 */
export async function displayPlacementCards(input: { placement: DisplayPlacement; market: Market; viewerId?: string; categoryId?: string; now?: Date }): Promise<WelcomeAds> {
  const now = input.now ?? new Date();
  if (!jassimAdsEnabled() || !isSponsoredServingEnabled()) return { cards: [], reason: "DISABLED" };
  const spec = DISPLAY_PLACEMENTS[input.placement];
  const campaigns = (await db
    .select()
    .from(listingPromotions)
    .where(and(
      eq(listingPromotions.marketId, input.market.id),
      eq(listingPromotions.status, "ACTIVE"),
      inArray(listingPromotions.placementSnapshot, [...spec.sources]),
      inArray(listingPromotions.paymentStatus, [...SERVING_PAYMENT_STATUSES]),
      lte(listingPromotions.startsAt, now),
      gt(listingPromotions.expiresAt, now),
    ))
    .orderBy(desc(listingPromotions.createdAt))
    .limit(50)).filter((row) => isServingCampaign(row, now) && row.sellerId !== input.viewerId);
  const scored: { id: string; kind: "LISTING" | "STORE"; listingId: string; promotionId: string; score: number }[] = [];
  if (campaigns.length) {
    const listings = await db
      .select({ offer: offers, sellerStatus: users.status })
      .from(offers)
      .innerJoin(users, eq(users.id, offers.sellerId))
      .where(inArray(offers.id, [...new Set(campaigns.map((row) => row.listingId))]));
    for (const row of listings) {
      const eligible = await listingPromotionEligibility(row.offer, row.sellerStatus, input.market);
      if (!eligible.ok) continue;
      if (input.categoryId && eligible.categoryId !== input.categoryId) continue;
      const campaign = representativeCampaign(campaigns, row.offer.id);
      if (!campaign) continue;
      scored.push({
        id: `l:${row.offer.id}`,
        kind: "LISTING",
        listingId: row.offer.id,
        promotionId: campaign.id,
        score: sponsoredScore({
          organicIndex: 0,
          priorityWeight: campaign.priorityWeightSnapshot,
          unitChargeMinor: campaign.unitChargeMinorSnapshot,
          minorUnitScale: input.market.minorUnitScale,
          hasImage: Boolean((row.offer.data as { imageUrl?: string }).imageUrl),
          descriptionLength: String((row.offer.data as { description?: string }).description ?? "").length,
        }),
      });
    }
  }
  const { servingStoreItems, recordStoreEvent } = await import("./promotion-campaigns");
  const stores = input.categoryId ? [] : await servingStoreItems(input.market.id, input.placement, now, input.viewerId);
  for (const { row, profile } of stores)
    scored.push({
      id: `s:${row.businessId}`,
      kind: "STORE",
      listingId: row.businessId,
      promotionId: row.id,
      score: sponsoredScore({ organicIndex: 0, priorityWeight: row.priorityWeightSnapshot, unitChargeMinor: null, minorUnitScale: input.market.minorUnitScale, hasImage: false, descriptionLength: profile.description.length }),
    });
  if (!scored.length) return { cards: [], reason: "NO_ELIGIBLE" };
  const chosen = rankSponsored(scored, spec.max);
  if (!chosen.length) return { cards: [], reason: "NO_ELIGIBLE" };
  const listingCards = await cardsFor(input.market, chosen.flatMap((item, index) => (item.kind === "LISTING" ? [{ slot: index + 1, listingId: item.listingId, promotionId: item.promotionId }] : [])));
  const cards: WelcomeCard[] = [];
  for (const [index, item] of chosen.entries()) {
    if (item.kind === "LISTING") {
      const card = listingCards.find((c) => c.slot === index + 1);
      if (!card) continue;
      cards.push({ ...card, kind: "LISTING" });
      if (input.viewerId)
        await recordAttributionEvent({ promotionId: item.promotionId, listingId: item.listingId, placement: campaigns.find((c) => c.id === item.promotionId)!.placementSnapshot, recordedPlacement: input.placement, market: input.market, viewerUserId: input.viewerId, eventType: "IMPRESSION", resultSetId: `display:${input.placement}` }).catch(() => undefined);
    } else {
      const store = stores.find((s) => s.row.id === item.promotionId)!;
      cards.push({
        slot: index + 1,
        kind: "STORE",
        businessId: store.profile.id,
        listingId: store.profile.id,
        promotionId: store.row.id,
        title: store.profile.displayName.slice(0, 120),
        price: null,
        currency: input.market.currencyCode,
        city: null,
        imagePath: null,
        sellerName: store.profile.displayName.slice(0, 60),
        label: SPONSORED_LABEL,
        path: `/business/${encodeURIComponent(store.profile.id)}`,
      });
      await recordStoreEvent(store.row.id, input.placement, input.viewerId, "IMPRESSION", now).catch(() => undefined);
    }
  }
  return cards.length ? { cards: cards.map((card, index) => ({ ...card, slot: index + 1 })) } : { cards: [], reason: "NO_ELIGIBLE" };
}

/** A click on a display card: an opened ad, recorded once per viewer and window. */
export async function displayPlacementEngagement(input: { placement: DisplayPlacement; promotionId: string; kind: "LISTING" | "STORE"; market: Market; viewerId?: string }) {
  if (input.kind === "STORE") {
    const { storeEngagement } = await import("./promotion-campaigns");
    return storeEngagement(input.promotionId, input.viewerId);
  }
  const [campaign] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, input.promotionId));
  if (!campaign || campaign.marketId !== input.market.id || !(DISPLAY_PLACEMENTS[input.placement].sources as readonly string[]).includes(campaign.placementSnapshot))
    throw Object.assign(new Error("الإعلان غير موجود"), { status: 404, expose: true });
  if (input.viewerId)
    await recordAttributionEvent({ promotionId: campaign.id, listingId: campaign.listingId, placement: campaign.placementSnapshot, recordedPlacement: input.placement, market: input.market, viewerUserId: input.viewerId, eventType: "ENGAGEMENT", kind: "DETAIL_OPENED" }).catch(() => undefined);
  return { path: `/listings/${encodeURIComponent(campaign.listingId)}` };
}
