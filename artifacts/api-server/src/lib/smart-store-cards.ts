/**
 * Smart store cards — server side (brief: docs/design/SMART-STORE-CARDS-BRIEF.md, section 6).
 *
 * - Cards are built only from persisted data: today Jassim's own published listings.
 * - The server stores every card it issues; events from the browser are applied to the server's own
 *   copy, in revision order (a stale revision is refused and the current card is returned).
 * - The quote is computed here from the card's server-issued prices. The browser's arithmetic is a
 *   preview at most. Checkout re-prices from the listing anyway (persisted state is the authority).
 * - The primary action never completes a purchase: «add to cart» adds the listings to Jassim's cart
 *   at server prices; payment and orders keep their own flow.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CardEvent, SmartStoreCard, type SmartMoney, type SmartSection } from "@workspace/api-zod/smart-store-card";
import { businessProfiles, conversations, db, smartStoreCards } from "@workspace/db";
import { searchMarketplaceListings } from "./marketplace-listings";
import { addMarketplaceCartItem } from "./marketplace-cart";
import { formatMinorAmount, scaleOfCurrency } from "./commercial-policy";
import type { ListingRecord } from "./dinar-data";

type Market = Parameters<typeof searchMarketplaceListings>[0];
const fail = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });
const QUOTE_TTL_MS = 15 * 60_000;

export function money(minor: number, currency: string, market: { currencyCode: string; minorUnitScale: number }): SmartMoney {
  const scale = scaleOfCurrency(currency, market) ?? market.minorUnitScale;
  return { minor, currency, scale, label: formatMinorAmount(minor, scale, currency) };
}

function priceMinor(listing: ListingRecord, market: { currencyCode: string; minorUnitScale: number }) {
  if (listing.unitPrice === null || !/^\d+(?:\.\d+)?$/.test(listing.unitPrice)) return undefined;
  const scale = scaleOfCurrency(listing.currency, market) ?? market.minorUnitScale;
  const [whole, fraction = ""] = listing.unitPrice.split(".");
  return Number(whole) * 10 ** scale + Number((fraction + "0".repeat(scale)).slice(0, scale) || "0");
}

function media(url: string | undefined, alt: string) {
  return url && /^(?:https:\/\/|\/)[^\s"'<>]+$/.test(url) ? { url, alt: alt.slice(0, 200) || "صورة المنتج", kind: "IMAGE" as const } : undefined;
}

// ─── Quote (pure) ───────────────────────────────────────────────────────────────────────────────

/**
 * The total from the card's own server-issued prices:
 *  - a PRODUCT_DETAIL: the selected priced variant (or the product price) + selected deltas, × quantity;
 *  - otherwise a BUNDLE_BUILDER: the filled slots;
 *  - otherwise a PRODUCT_GRID: the selected available products.
 * Returns undefined when nothing is priced (no total is shown rather than a guessed one).
 */
export function computeQuote(card: SmartStoreCard, now = new Date()): SmartStoreCard["quote"] {
  const lines: { label: string; amount: SmartMoney }[] = [];
  const detail = card.sections.find((section) => section.kind === "PRODUCT_DETAIL") as Extract<SmartSection, { kind: "PRODUCT_DETAIL" }> | undefined;
  const bundle = card.sections.find((section) => section.kind === "BUNDLE_BUILDER") as Extract<SmartSection, { kind: "BUNDLE_BUILDER" }> | undefined;
  const grid = card.sections.find((section) => section.kind === "PRODUCT_GRID") as Extract<SmartSection, { kind: "PRODUCT_GRID" }> | undefined;
  let quantity = 1;
  if (detail) {
    let base = detail.price;
    let baseLabel = detail.title;
    for (const section of card.sections) {
      if (section.kind === "VARIANT_PICKER") {
        const chosen = section.options.find((option) => option.selected);
        if (!chosen) continue;
        if (section.style === "STEPPER") quantity = Math.max(1, Math.min(99, Number(chosen.label) || 1));
        else if (chosen.price) { base = chosen.price; baseLabel = `${detail.title} (${chosen.label})`; }
        else if (chosen.delta) lines.push({ label: chosen.label, amount: chosen.delta });
      }
      if (section.kind === "CUSTOMIZER") for (const option of section.options) if (option.selected && option.delta) lines.push({ label: option.label, amount: option.delta });
    }
    lines.unshift({ label: baseLabel, amount: base });
  } else if (bundle) {
    for (const slot of bundle.slots) if (slot.item) lines.push({ label: slot.item.title, amount: slot.item.price });
  } else if (grid) {
    for (const product of grid.products) if (product.selected && product.available) lines.push({ label: product.title, amount: product.price });
  }
  if (!lines.length) return undefined;
  const currency = lines[0]!.amount.currency;
  if (lines.some((line) => line.amount.currency !== currency)) return undefined; // never add different currencies
  const scale = lines[0]!.amount.scale;
  const total = lines.reduce((sum, line) => sum + line.amount.minor, 0) * quantity;
  return {
    total: { minor: total, currency, scale, label: formatMinorAmount(total, scale, currency) },
    lines: quantity > 1 ? [...lines, { label: `× ${quantity}`, amount: { minor: 0, currency, scale, label: `× ${quantity}` } }] : lines,
    // Final only for Jassim's own listings; a merchant system or website confirms its own price.
    final: card.store.mode === "SELL_INSIDE_JASSIM",
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
  };
}

// ─── Events (pure) ──────────────────────────────────────────────────────────────────────────────

/** Applies one event to the server's copy. Unknown ids change nothing (refused by the caller). */
export function applyCardEvent(card: SmartStoreCard, event: CardEvent): { card: SmartStoreCard; changed: boolean } {
  const next: SmartStoreCard = structuredClone(card);
  let changed = false;
  const sections = next.sections;
  switch (event.type) {
    case "SELECT_TAB":
      for (const section of sections) if (section.kind === "CATEGORY_TABS" && section.tabs.some((tab) => tab.id === event.tabId)) {
        section.tabs.forEach((tab) => (tab.selected = tab.id === event.tabId));
        changed = true;
      }
      break;
    case "SELECT_PRODUCT":
      for (const section of sections) if (section.kind === "PRODUCT_GRID") {
        const product = section.products.find((item) => item.id === event.productId);
        if (product?.available) { product.selected = !product.selected; changed = true; }
      }
      break;
    case "SELECT_OPTION":
      for (const section of sections) {
        if (section.kind === "VARIANT_PICKER" && section.groupId === event.groupId && section.style !== "STEPPER") {
          const option = section.options.find((item) => item.id === event.optionId);
          if (option?.available && event.selected) { section.options.forEach((item) => (item.selected = item.id === event.optionId)); changed = true; }
        }
        if (section.kind === "CUSTOMIZER" && section.groupId === event.groupId) {
          const option = section.options.find((item) => item.id === event.optionId);
          if (!option) continue;
          if (section.multi) option.selected = event.selected;
          else section.options.forEach((item) => (item.selected = item.id === event.optionId && event.selected));
          changed = true;
        }
      }
      break;
    case "SET_QUANTITY":
      for (const section of sections) if (section.kind === "VARIANT_PICKER" && section.style === "STEPPER" && event.quantity >= 1) {
        section.options = [{ id: `q${event.quantity}`, label: String(event.quantity), available: true, selected: true }];
        changed = true;
      }
      break;
    case "FILL_SLOT": {
      const source = sections.flatMap((section) => (section.kind === "PRODUCT_GRID" ? section.products.filter((item) => item.available) : []));
      const product = source.find((item) => item.id === event.productId);
      for (const section of sections) if (section.kind === "BUNDLE_BUILDER" && product) {
        const slot = section.slots.find((item) => item.slotId === event.slotId);
        if (slot) { slot.item = { id: product.id, title: product.title, price: product.price, media: product.media }; changed = true; }
      }
      break;
    }
    case "REFINE_REMOVE":
      for (const section of sections) if (section.kind === "UNDERSTOOD_REQUEST") {
        const before = section.chips.length;
        section.chips = section.chips.filter((chip) => chip.id !== event.chipId);
        changed ||= section.chips.length !== before;
      }
      next.sections = sections.filter((section) => section.kind !== "UNDERSTOOD_REQUEST" || section.chips.length > 0);
      break;
    default:
      break;
  }
  if (!changed) return { card, changed: false };
  next.revision = card.revision + 1;
  next.quote = computeQuote(next);
  return { card: SmartStoreCard.parse(next), changed: true };
}

// ─── Building from Jassim's own listings ────────────────────────────────────────────────────────

/** One published listing → a product card; several → a grid card (one store per card). */
export async function buildCardFromListings(market: Market, listingIds: readonly string[], understood: readonly string[] = []): Promise<SmartStoreCard> {
  const listings = (await searchMarketplaceListings(market, { search: "", allowedIds: [...listingIds], limit: Math.min(listingIds.length, 24) })) as ListingRecord[];
  if (!listings.length) throw fail(404, "لا توجد منتجات منشورة مطابقة", "LISTING_NOT_FOUND");
  const seller = listings[0]!.sellerId;
  const own = listings.filter((listing) => listing.sellerId === seller);
  const priced = own.map((listing) => ({ listing, minor: priceMinor(listing, market) }));
  const sections: SmartSection[] = [];
  if (understood.length) sections.push({ kind: "UNDERSTOOD_REQUEST", chips: understood.slice(0, 8).map((label, index) => ({ id: `u${index}`, label: label.slice(0, 60) })) });
  if (own.length === 1 && priced[0]!.minor !== undefined) {
    const listing = own[0]!;
    const gallery = [listing.imageUrl, ...(listing.imageUrls ?? [])].map((url) => media(url, listing.title)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (gallery.length) sections.push({ kind: "HERO_GALLERY", media: gallery.slice(0, 12) });
    sections.push({
      kind: "PRODUCT_DETAIL",
      productId: listing.id,
      title: listing.title.slice(0, 160),
      subtitle: listing.description?.slice(0, 300) || undefined,
      price: money(priced[0]!.minor!, listing.currency, market),
      // Ratings only from the store's own persisted reviews.
      ...(listing.reviewCount > 0 ? { rating: { value: Math.min(5, Math.max(0, listing.rating)), count: listing.reviewCount } } : {}),
      media: [],
    });
    sections.push({ kind: "VARIANT_PICKER", groupId: "qty", label: "الكمية", style: "STEPPER", options: [{ id: "q1", label: "1", available: true, selected: true }] });
    const attributes = Object.entries(listing.attributes ?? {}).slice(0, 16).map(([label, value]) => ({ label: label.slice(0, 40), value: String(value).slice(0, 80) })).filter((row) => row.label && row.value);
    if (attributes.length) sections.push({ kind: "SPECS", rows: attributes });
  } else {
    const products = priced
      .filter((entry) => entry.minor !== undefined)
      .map(({ listing, minor }) => ({
        id: listing.id,
        title: listing.title.slice(0, 120),
        price: money(minor!, listing.currency, market),
        media: media(listing.imageUrl, listing.title) ?? { url: "/smart-store/fixtures/generic.svg", alt: listing.title.slice(0, 200) || "منتج", kind: "IMAGE" as const, illustrative: true },
        available: listing.availableQuantity === null || listing.availableQuantity - listing.reservedQuantity > 0,
      }));
    if (!products.length) throw fail(409, "لا توجد منتجات بسعر منشور", "LISTING_NOT_PRICED");
    sections.push({ kind: "PRODUCT_GRID", products });
  }
  // A verified business of this seller in this market makes it a business; anyone else is an
  // individual selling their own items — no business profile or Connect is required to sell.
  const [business] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(and(eq(businessProfiles.ownerUserId, seller), eq(businessProfiles.marketId, market.id), eq(businessProfiles.verificationStatus, "VERIFIED")))
    .limit(1);
  const card: SmartStoreCard = {
    cardId: randomUUID(),
    revision: 1,
    vertical: "GENERAL",
    store: { name: own[0]!.sellerName.slice(0, 120) || "بائع", kind: business ? "BUSINESS" : "INDIVIDUAL", sponsored: own.some((listing) => listing.isSponsored), verified: Boolean(business), mode: "SELL_INSIDE_JASSIM" },
    sections,
    primaryAction: { kind: "ADD_TO_CART", label: "إضافة إلى السلة" },
    status: "READY",
  };
  card.quote = computeQuote(card);
  return SmartStoreCard.parse(card);
}

// ─── Persistence ────────────────────────────────────────────────────────────────────────────────

/** On by default outside production; production needs DINAR_SMART_STORE_CARDS=true (owner decision). */
export function smartStoreCardsEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.DINAR_SMART_STORE_CARDS === "true") return true;
  if (env.DINAR_SMART_STORE_CARDS === "false") return false;
  return env.NODE_ENV !== "production";
}

/**
 * After a search reply: one card for the first store among the organic results (paid results never
 * pick the store). Failure never affects the reply; the ordinary results stay the source of truth.
 */
export async function issueCardForSearchReply(input: { actorId: string; market: Market; conversationId: string; messageId: string; listings: readonly ListingRecord[]; search?: string }) {
  if (!smartStoreCardsEnabled()) return undefined;
  const organic = input.listings.filter((listing) => !listing.isSponsored);
  const seller = organic[0]?.sellerId;
  if (!seller) return undefined;
  const ids = organic.filter((listing) => listing.sellerId === seller).slice(0, 8).map((listing) => listing.id);
  const understood = input.search?.trim() ? [input.search.trim().slice(0, 60)] : [];
  return issueSmartStoreCard({ actorId: input.actorId, market: input.market, listingIds: ids, conversationId: input.conversationId, messageId: input.messageId, understood });
}

export async function issueSmartStoreCard(input: { actorId: string; market: Market; listingIds: readonly string[]; conversationId?: string; messageId?: string; understood?: readonly string[] }) {
  if (input.conversationId) {
    const [owned] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.marketId, input.market.id)));
    if (!owned) throw fail(404, "المحادثة غير موجودة", "CONVERSATION_NOT_FOUND");
  }
  const card = await buildCardFromListings(input.market, input.listingIds, input.understood);
  await db.insert(smartStoreCards).values({ id: card.cardId, ownerUserId: input.actorId, marketId: input.market.id, conversationId: input.conversationId ?? null, messageId: input.messageId ?? null, revision: card.revision, card });
  return card;
}

/** The card attached to one of the actor's assistant replies, or null. */
export async function smartStoreCardForMessage(actorId: string, messageId: string) {
  const [row] = await db.select().from(smartStoreCards).where(and(eq(smartStoreCards.messageId, messageId), eq(smartStoreCards.ownerUserId, actorId)));
  return row ? SmartStoreCard.parse(row.card) : null;
}

export async function readSmartStoreCard(actorId: string, cardId: string) {
  const [row] = await db.select().from(smartStoreCards).where(and(eq(smartStoreCards.id, cardId), eq(smartStoreCards.ownerUserId, actorId)));
  if (!row) throw fail(404, "البطاقة غير موجودة", "CARD_NOT_FOUND");
  return SmartStoreCard.parse(row.card);
}

/**
 * One browser event. The server's copy changes only at the expected revision; the primary action
 * adds Jassim listings to the actor's cart at server prices (nothing is paid or ordered here).
 */
export async function handleSmartStoreEvent(input: { actorId: string; market: Market; event: unknown }) {
  const event = CardEvent.parse(input.event);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(smartStoreCards).where(and(eq(smartStoreCards.id, event.cardId), eq(smartStoreCards.ownerUserId, input.actorId))).for("update");
    if (!row) throw fail(404, "البطاقة غير موجودة", "CARD_NOT_FOUND");
    const card = SmartStoreCard.parse(row.card);
    if (event.type === "FAVORITE" || event.type === "SHARE") return { card, applied: false as const };
    if (event.revision !== card.revision) return { card, applied: false as const, stale: true as const };
    if (event.type === "PRIMARY_ACTION") {
      if (card.store.mode !== "SELL_INSIDE_JASSIM" || card.primaryAction.kind !== "ADD_TO_CART") throw fail(409, "هذا الإجراء يتم عبر المتجر نفسه", "ACTION_NOT_AVAILABLE_HERE");
      const detail = card.sections.find((section) => section.kind === "PRODUCT_DETAIL") as Extract<SmartSection, { kind: "PRODUCT_DETAIL" }> | undefined;
      const grid = card.sections.find((section) => section.kind === "PRODUCT_GRID") as Extract<SmartSection, { kind: "PRODUCT_GRID" }> | undefined;
      const quantity = Number((card.sections.find((section) => section.kind === "VARIANT_PICKER" && section.style === "STEPPER") as Extract<SmartSection, { kind: "VARIANT_PICKER" }> | undefined)?.options.find((option) => option.selected)?.label ?? 1) || 1;
      const items = detail ? [{ listingId: detail.productId, quantity }] : (grid?.products ?? []).filter((product) => product.selected && product.available).map((product) => ({ listingId: product.id, quantity: 1 }));
      if (!items.length) throw fail(409, "اختر منتجًا أولًا", "NOTHING_SELECTED");
      for (const item of items) await addMarketplaceCartItem({ userId: input.actorId, expectedMarketId: input.market.id, listingId: item.listingId, quantity: item.quantity });
      const next = { ...card, revision: card.revision + 1, notice: "أُضيف إلى سلتك بأسعار المتجر الحالية؛ المراجعة والدفع من السلة." };
      await tx.update(smartStoreCards).set({ revision: next.revision, card: next, updatedAt: new Date() }).where(eq(smartStoreCards.id, card.cardId));
      return { card: SmartStoreCard.parse(next), applied: true as const, addedToCart: items.length };
    }
    const result = applyCardEvent(card, event);
    if (!result.changed) return { card, applied: false as const };
    await tx.update(smartStoreCards).set({ revision: result.card.revision, card: result.card, updatedAt: new Date() }).where(eq(smartStoreCards.id, card.cardId));
    return { card: result.card, applied: true as const };
  });
}
