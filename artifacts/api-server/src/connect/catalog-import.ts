/**
 * Jassim Connect — Mode A (SELL_INSIDE_DINAR / HYBRID): the owner moves one offer that Connect
 * already read from their store (feed, API, MCP or observed page) into a normal DINAR listing.
 *
 * Not a second listing system: creation goes through `createListingForActor` (the seller form /
 * conversation authority), so category, attributes, contact-text, image, moderation and
 * inventory rules are the ones every listing obeys. Rules added here:
 *   - owner only (staff and strangers get 404), in the partner's market, with the internal-sale
 *     capability enabled (approved partner + verified business) — choosing a mode is not enough;
 *   - only a PUBLISHED offer checked within 24 h, priced in the market's own currency and scale
 *     (no conversion); the owner confirms the exact price and source version that were previewed,
 *     so a sync between preview and confirmation is refused, never silently applied;
 *   - stock, location, fulfilment and photos come from the owner (an external page is not proof
 *     of stock and remote images are never fetched); photos must be the owner's own uploads;
 *   - the listing id is derived from (partner, offer), so a retry or a second click returns the
 *     same listing instead of a duplicate. Later edits use the normal listing management.
 * Importing never enables the merchant's website checkout inside DINAR (nativeCatalogCheckout
 * stays off) and is free: no fee, subscription or commission is created by it.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectOffers, db, marketAudit, offers, users } from "@workspace/db";
import { createListingForActor } from "../routes/marketplace";
import { formatMinor } from "../lib/promotions";
import { resolveMarketplaceCategory } from "../lib/marketplace-categories";
import type { marketFor } from "../lib/markets";
import { connectError } from "./provider-registry";

/** A deliberate, user-safe refusal: the API returns its Arabic message and stable code. */
const refuse = (status: number, code: string, message: string) => Object.assign(connectError(status, code, message), { expose: true });
import { connectAccess, partnerView } from "./partners";

type Market = Awaited<ReturnType<typeof marketFor>>;
export const CONNECT_IMPORT_FRESH_MS = 24 * 60 * 60_000;

export function connectImportListingId(partnerId: string, offerId: string) {
  const bytes = createHash("sha256").update(`dinar-connect-import\0${partnerId}\0${offerId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ImportInput = z.object({
  confirm: z.literal(true),
  /** What the owner saw in the preview; a newer sync makes the confirmation stale. */
  expectedSourceVersion: z.number().int().min(0),
  expectedPriceMinor: z.number().int().min(0).nullable(),
  imageUrl: z.string().max(2000).default(""),
  imageUrls: z.array(z.string().max(2000)).max(3).optional(),
  area: z.string().trim().min(1).max(100),
  city: z.string().trim().max(100).optional(),
  inventoryMode: z.enum(["LIMITED", "UNLIMITED"]),
  availableQuantity: z.number().int().min(1).max(1_000_000).optional(),
  fulfilmentType: z.enum(["PICKUP", "DELIVERY", "DIGITAL", "SERVICE"]),
  paymentMethods: z.array(z.enum(["CASH_DIRECT", "CARD"])).min(1).max(2).optional(),
  attributes: z.record(z.string().max(60), z.union([z.string().max(160), z.number().finite()])).optional(),
}).strict();

async function importable(actorId: string, market: Market, partnerId: string, offerId: string, now: Date) {
  // Owner scope: staff with catalog read and every stranger get the same 404.
  await connectAccess(actorId, market.id, partnerId, "OWNER");
  const view = await partnerView(actorId, market.id, partnerId);
  const [offer] = await db
    .select()
    .from(connectOffers)
    .where(and(eq(connectOffers.id, offerId), eq(connectOffers.partnerId, partnerId)));
  if (!offer || offer.status !== "PUBLISHED") throw refuse(404, "NOT_FOUND", "المنتج غير موجود في كتالوجك المتصل");
  const blockers: { code: string; message: string }[] = [];
  if (!view.participation.internalSale.included)
    blockers.push({ code: "MODE_EXCLUDES_INTERNAL_SALE", message: "وضعك الحالي لا يشمل البيع داخل جاسم؛ اختر «البيع داخل جاسم» أو «الوضع المختلط» أولًا." });
  else if (!view.participation.internalSale.enabled)
    blockers.push({ code: "INTERNAL_SALE_NOT_ENABLED", message: view.participation.internalSale.requirements[0] ?? "البيع داخل جاسم غير مفعل بعد." });
  if (offer.sourceCheckedAt.getTime() < now.getTime() - CONNECT_IMPORT_FRESH_MS)
    blockers.push({ code: "STALE_OFFER", message: "بيانات هذا المنتج أقدم من 24 ساعة؛ حدّث الكتالوج ثم أعد المحاولة." });
  if (offer.priceMinor != null && (offer.currencyCode !== market.currencyCode || offer.minorUnitScale !== market.minorUnitScale))
    blockers.push({ code: "CURRENCY_MISMATCH", message: `سعر المنتج بعملة ${offer.currencyCode ?? "غير معروفة"} وسوقك بعملة ${market.currencyCode}؛ لا أحوّل العملات تلقائيًا.` });
  if (offer.priceMinor == null)
    blockers.push({ code: "PRICE_UNKNOWN", message: "المتجر لم يذكر سعرًا موثقًا لهذا المنتج؛ أنشئه كإعلان عادي بسعرك." });
  return { offer, blockers };
}

/** Read-only preview: what would be imported, what the owner must still provide, and why not. */
export async function previewConnectImport(input: { actorId: string; market: Market; partnerId: string; offerId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const { offer, blockers } = await importable(input.actorId, input.market, input.partnerId, input.offerId, now);
  const listingId = connectImportListingId(input.partnerId, input.offerId);
  const [existing] = await db.select({ id: offers.id }).from(offers).where(and(eq(offers.id, listingId), eq(offers.sellerId, input.actorId)));
  return {
    offerId: offer.id,
    sourceVersion: offer.sourceVersion,
    checkedAt: offer.sourceCheckedAt.toISOString(),
    title: offer.title,
    description: offer.description,
    categoryId: offer.categoryId,
    priceMinor: offer.priceMinor,
    price: offer.priceMinor == null || offer.minorUnitScale == null ? null : formatMinor(offer.priceMinor, offer.minorUnitScale),
    currency: offer.currencyCode,
    alreadyImportedListingId: existing?.id ?? null,
    canImport: blockers.length === 0 && !existing,
    blockers,
    ownerMustProvide: ["area", "inventoryMode", "fulfilmentType"],
    fee: { amountMinor: 0, label: "الربط واستيراد الكتالوج مجانيان" },
    disclosure: "سيُنشر المنتج كإعلان جاسم عادي بسعر متجرك الموثق. المخزون والموقع والصور منك أنت، ولا يُفعَّل الدفع في موقعك من داخل جاسم.",
  };
}

export async function importConnectOffer(input: { actorId: string; market: Market; partnerId: string; offerId: string; body: unknown; now?: Date }) {
  const now = input.now ?? new Date();
  const parsed = ImportInput.safeParse(input.body);
  if (!parsed.success) throw refuse(400, "INVALID_IMPORT", "أكمل بيانات الاستيراد وأكّدها صراحةً.");
  const body = parsed.data;
  const { offer, blockers } = await importable(input.actorId, input.market, input.partnerId, input.offerId, now);
  if (blockers.length) throw refuse(409, blockers[0]!.code, blockers[0]!.message);
  if (offer.sourceVersion !== body.expectedSourceVersion || offer.priceMinor !== body.expectedPriceMinor)
    throw refuse(409, "OFFER_CHANGED", "تغيرت بيانات المنتج منذ المعاينة؛ راجعها وأكّد من جديد.");
  if (body.inventoryMode === "LIMITED" && !body.availableQuantity)
    throw refuse(400, "QUANTITY_REQUIRED", "اذكر الكمية المتوفرة لديك؛ صفحة المتجر ليست إثباتًا للمخزون.");
  const [actor] = await db.select().from(users).where(eq(users.id, input.actorId));
  if (!actor) throw refuse(404, "NOT_FOUND", "الشريك غير موجود");
  const listingId = connectImportListingId(input.partnerId, input.offerId);
  const [existing] = await db.select({ id: offers.id, sellerId: offers.sellerId }).from(offers).where(eq(offers.id, listingId));
  if (existing) {
    if (existing.sellerId !== input.actorId) throw refuse(404, "NOT_FOUND", "المنتج غير موجود في كتالوجك المتصل");
    return { result: "ALREADY_IMPORTED" as const, listingId };
  }
  const category = await resolveMarketplaceCategory(offer.categoryId, undefined);
  if (!category) throw refuse(409, "CATEGORY_UNMAPPED", "تصنيف هذا المنتج غير موجود في جاسم؛ أنشئه كإعلان عادي.");
  const created = await createListingForActor(actor, {
    title: offer.title.slice(0, 120),
    description: offer.description,
    category: category.label,
    categoryId: category.id,
    area: body.area,
    city: body.city,
    attributes: body.attributes,
    paymentMethods: body.paymentMethods,
    unitPrice: formatMinor(offer.priceMinor!, offer.minorUnitScale!),
    pricingMode: "FIXED",
    inventoryMode: body.inventoryMode,
    availableQuantity: body.inventoryMode === "LIMITED" ? body.availableQuantity : null,
    fulfilmentType: body.fulfilmentType,
    imageUrl: body.imageUrl,
    imageUrls: body.imageUrls,
    contactPhone: null,
  }, listingId);
  // 200 = the listing write replayed a concurrent click's publish: same listing, no second audit.
  if (created.status !== 201) return { result: "ALREADY_IMPORTED" as const, listingId: created.listing.id };
  await db.insert(marketAudit).values({
    id: randomUUID(),
    marketId: input.market.id,
    actorId: input.actorId,
    action: "CONNECT_OFFER_IMPORTED",
    data: { partnerId: input.partnerId, offerId: offer.id, sourceVersion: offer.sourceVersion, listingId: created.listing.id },
  });
  return { result: "CREATED" as const, listingId: created.listing.id, listing: created.listing };
}
