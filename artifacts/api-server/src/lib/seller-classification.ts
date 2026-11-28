/**
 * Seller Intelligence: is this person selling their own belongings, or trading?
 *
 * Deterministic rules over explainable signals — never a model's verdict alone, never the number
 * of listings alone, never a plan limit. Every decision is stored with its reason, confidence,
 * source and signals (append-only), the seller can declare or appeal, and an admin can decide with
 * a reason. Orders snapshot the classification at checkout, so a change never reprices the past.
 *
 *   PERSONAL_SELLER      0% marketplace commission
 *   INDIVIDUAL_MERCHANT  published marketplace rate on completed sales (no company needed)
 *   REGISTERED_BUSINESS  published marketplace rate on completed sales
 *   CONNECT_PARTNER      no marketplace rate; its Jassim Connect agreement applies instead
 *   UNDER_REVIEW         nothing charged automatically
 *
 * This is an internal commercial classification, not a legal finding about business registration.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { businessProfiles, connectPartners, db, offers, sellerClassifications } from "@workspace/db";

export type SellerClassification = "PERSONAL_SELLER" | "INDIVIDUAL_MERCHANT" | "REGISTERED_BUSINESS" | "CONNECT_PARTNER" | "UNDER_REVIEW";
export type Signal = { key: string; weight: number; detail?: string };

export const CLASSIFICATION_LABELS_AR: Record<SellerClassification, string> = {
  PERSONAL_SELLER: "بائع فردي (مقتنيات شخصية)",
  INDIVIDUAL_MERCHANT: "تاجر فردي",
  REGISTERED_BUSINESS: "شركة أو متجر مسجل",
  CONNECT_PARTNER: "شريك Jassim Connect",
  UNDER_REVIEW: "قيد المراجعة",
};

/** Owner switch: until on, checkout keeps the published rate for everyone (current behaviour). */
export function sellerClassificationEnabled() {
  return process.env.DINAR_SELLER_CLASSIFICATION === "true";
}

const fold = (text: string) =>
  text.toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ");

const PERSONAL_WORDS = /(?:مستعمل|استعمال شخصي|شخصي|ملكي|اغراضي|مقتنياتي|بسبب السفر|مسافر|انتقال|بدي اتخلص|للتخلص|اشتريت (?:غيره|جديد|واحد جديد))/u;
const STOCK_WORDS = /(?:جديد بالكرتونه|بالكرتونه|كفاله وكيل|كفالة الوكيل|جمله|بالجمله|متوفر بكميات|كميات|جميع الالوان|جميع المقاسات|توصيل لجميع|وكيل|ضمان المحل|عرض خاص|خصم للكميات|اسعار الجمله)/u;
const NEW_WORDS = /(?:^|\s)(?:جديد|جديده|new)(?:\s|$)/u;

/** Declarations in the seller's own words (chat). */
export const DECLARES_PERSONAL = /(?:(?:سريري|هاتفي|جوالي|تلفوني|سيارتي|اغراضي|مقتنياتي|اثاثي|غرضي|جهازي|لابتوبي|ساعتي)\s+(?:ال)?شخصي(?:ه)?|ملكي الشخصي|مقتنيات(?:ي)? شخصيه|اغراض(?:ي)? شخصيه|للاستعمال الشخصي|استعمالي الشخصي|مش تاجر|لست تاجرا?|ما(?:ني)? تاجر|ليس للتجاره|مش للتجاره|ما بشتغل (?:ب)?تجاره|بسبب (?:السفر|انتقالي|الانتقال)|(?:اريد|بدي|ابي) (?:اتخلص|التخلص) منه)/u;
export const DECLARES_MERCHANT = /(?:اشتري (?:و ?ابيع|واعيد بيع)|اشتريها و ?ابيعها|اعيد بيع(?:ها)?|ابيع كتجاره|كتجاره|بالجمله|عندي محل|نشاط(?:ي)? تجاري|ابيع (?:هواتف|اجهزه|ملابس|اثاث|جوالات) جديده|انا تاجر|اتاجر ب|مصدر رزقي|بيع مستمر)/u;

type Tx = any;

/**
 * Commercial signals from the seller's own listings in the market. Count of listings is reported
 * but carries no weight by itself; it only matters together with stock-like signals.
 */
export async function sellerSignals(tx: Tx, sellerId: string, marketId: string): Promise<{ merchant: Signal[]; personal: Signal[]; listingCount: number }> {
  const rows: { data: Record<string, any>; inventoryMode: string; availableQuantity: number | null }[] = await tx
    .select({ data: offers.data, inventoryMode: offers.inventoryMode, availableQuantity: offers.availableQuantity })
    .from(offers)
    .where(and(eq(offers.sellerId, sellerId), eq(offers.marketId, marketId), ne(offers.status, "ARCHIVED")));
  const merchant: Signal[] = [];
  const personal: Signal[] = [];
  const texts = rows.map((r) => fold(`${r.data?.title ?? ""} ${r.data?.description ?? ""} ${JSON.stringify(r.data?.attributes ?? {})}`));
  const multiUnit = rows.filter((r) => r.inventoryMode === "UNLIMITED" || (r.availableQuantity ?? 1) > 1).length;
  const stockText = texts.filter((t) => STOCK_WORDS.test(t)).length;
  const newItems = texts.filter((t) => NEW_WORDS.test(t) && !PERSONAL_WORDS.test(t)).length;
  const personalText = texts.filter((t) => PERSONAL_WORDS.test(t)).length;
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    const key = String(r.data?.categoryId ?? r.data?.category ?? "");
    if (key) byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  const sameCategoryNew = [...byCategory.entries()].filter(([category, count]) => count >= 3 && rows.filter((r) => String(r.data?.categoryId ?? r.data?.category ?? "") === category && NEW_WORDS.test(fold(String(r.data?.title ?? "")))).length >= 3);
  if (multiUnit) merchant.push({ key: "MULTI_UNIT_STOCK", weight: multiUnit >= 2 ? 2 : 1, detail: `${multiUnit} عرض بكمية أكثر من قطعة` });
  if (stockText) merchant.push({ key: "STOCK_LANGUAGE", weight: stockText >= 2 ? 2 : 1, detail: `${stockText} عرض بصياغة تجارية` });
  if (sameCategoryNew.length) merchant.push({ key: "REPEATED_NEW_SAME_CATEGORY", weight: 2, detail: "عدة منتجات جديدة متشابهة في نفس التصنيف" });
  else if (newItems >= 3) merchant.push({ key: "SEVERAL_NEW_ITEMS", weight: 1, detail: `${newItems} منتجات جديدة` });
  if (personalText) personal.push({ key: "PERSONAL_LANGUAGE", weight: personalText, detail: `${personalText} عرض يصف غرضًا شخصيًا أو مستعملًا` });
  return { merchant, personal, listingCount: rows.length };
}

const score = (signals: Signal[]) => signals.reduce((sum, s) => sum + s.weight, 0);
/** Commercial evidence strong enough to classify without a declaration, or to contradict one. */
const STRONG = 4;

export type Resolution = {
  classification: SellerClassification;
  confidence: number;
  source: "USER_DECLARED" | "SIGNALS" | "BUSINESS_PROFILE" | "CONNECT_PARTNER" | "ADMIN" | "APPEAL";
  reason: string;
  signals: Signal[];
  recordId: string | null;
};

async function latest(tx: Tx, sellerId: string, marketId: string, humanOnly = false) {
  const [row]: (typeof sellerClassifications.$inferSelect)[] = await tx
    .select()
    .from(sellerClassifications)
    .where(and(eq(sellerClassifications.sellerId, sellerId), eq(sellerClassifications.marketId, marketId), ...(humanOnly ? [inArray(sellerClassifications.source, ["USER_DECLARED", "ADMIN", "APPEAL"])] : [])))
    .orderBy(desc(sellerClassifications.createdAt), desc(sellerClassifications.id))
    .limit(1);
  return row;
}

/**
 * The classification in force now. Order of authority: an admin decision; an open appeal (charges
 * nothing until decided); a verified business or approved Connect partner; the seller's own
 * declaration unless strong commercial evidence contradicts it (then UNDER_REVIEW); otherwise
 * signals — strong commercial evidence makes a merchant, personal evidence a personal seller, and
 * anything else stays UNDER_REVIEW.
 */
export async function resolveSellerClassification(tx: Tx, sellerId: string, marketId: string): Promise<Resolution> {
  // Only people decide; derived rows recorded for history never override a declaration.
  const current = await latest(tx, sellerId, marketId, true);
  if (current && (current.source === "ADMIN" || current.source === "APPEAL"))
    return { classification: current.classification as SellerClassification, confidence: current.confidence, source: current.source, reason: current.reason, signals: current.signals, recordId: current.id };

  const businesses: { id: string; status: string }[] = await tx
    .select({ id: businessProfiles.id, status: businessProfiles.verificationStatus })
    .from(businessProfiles)
    .where(and(eq(businessProfiles.ownerUserId, sellerId), eq(businessProfiles.marketId, marketId)));
  const businessIds = businesses.map((b) => b.id);
  if (businessIds.length) {
    const [partner] = await tx
      .select({ id: connectPartners.id })
      .from(connectPartners)
      .where(and(inArray(connectPartners.businessId, businessIds), eq(connectPartners.status, "APPROVED")))
      .limit(1);
    if (partner) return { classification: "CONNECT_PARTNER", confidence: 95, source: "CONNECT_PARTNER", reason: "حساب مرتبط بشريك Jassim Connect معتمد؛ تطبق اتفاقية Connect.", signals: [{ key: "CONNECT_PARTNER_APPROVED", weight: 10 }], recordId: current?.id ?? null };
    if (businesses.some((b) => b.status === "VERIFIED"))
      return { classification: "REGISTERED_BUSINESS", confidence: 90, source: "BUSINESS_PROFILE", reason: "ملف نشاط تجاري موثّق في هذا السوق.", signals: [{ key: "VERIFIED_BUSINESS_PROFILE", weight: 10 }], recordId: current?.id ?? null };
  }

  const { merchant, personal } = await sellerSignals(tx, sellerId, marketId);
  const merchantScore = score(merchant);
  const signals = [...merchant, ...personal];
  if (current?.source === "USER_DECLARED") {
    if (current.classification === "PERSONAL_SELLER" && merchantScore >= STRONG)
      return { classification: "UNDER_REVIEW", confidence: 50, source: "SIGNALS", reason: "صرّح البائع بأنها مقتنيات شخصية، لكن عروضه تشير إلى مخزون تجاري؛ تحتاج مراجعة. لا عمولة تلقائية.", signals, recordId: current.id };
    return { classification: current.classification as SellerClassification, confidence: current.classification === "PERSONAL_SELLER" ? Math.max(60, 80 - merchantScore * 5) : 85, source: "USER_DECLARED", reason: current.reason, signals, recordId: current.id };
  }
  if (merchantScore >= STRONG)
    return { classification: "INDIVIDUAL_MERCHANT", confidence: Math.min(90, 55 + merchantScore * 5), source: "SIGNALS", reason: "عروض بمخزون متجدد وكميات وصياغة تجارية؛ نشاط تجاري حتى دون سجل تجاري.", signals, recordId: null };
  if (score(personal) > 0 && merchantScore <= 1)
    return { classification: "PERSONAL_SELLER", confidence: 65, source: "SIGNALS", reason: "العروض تصف أغراضًا شخصية أو مستعملة.", signals, recordId: null };
  return { classification: "UNDER_REVIEW", confidence: 30, source: "SIGNALS", reason: "لا توجد أدلة كافية على نشاط تجاري أو على أنها مقتنيات شخصية؛ لا عمولة تلقائية.", signals, recordId: null };
}

/** The seller's own statement (or appeal). Stored as said; resolution still weighs the evidence. */
export async function declareSellerClassification(input: { sellerId: string; marketId: string; classification: "PERSONAL_SELLER" | "INDIVIDUAL_MERCHANT"; statement: string; appeal?: boolean }) {
  const row = {
    id: randomUUID(),
    sellerId: input.sellerId,
    marketId: input.marketId,
    classification: input.appeal ? "UNDER_REVIEW" : input.classification,
    confidence: input.appeal ? 40 : 70,
    source: input.appeal ? "APPEAL" : "USER_DECLARED",
    signals: [{ key: input.appeal ? "SELLER_APPEAL" : "SELLER_DECLARATION", weight: 0, detail: input.classification }],
    reason: (input.appeal ? `اعتراض البائع: يطلب ${CLASSIFICATION_LABELS_AR[input.classification]}. ` : "تصريح البائع: ") + input.statement.trim().slice(0, 300),
    actorId: input.sellerId,
  };
  await db.insert(sellerClassifications).values(row);
  return resolveSellerClassification(db, input.sellerId, input.marketId);
}

export async function adminDecideClassification(input: { adminId: string; sellerId: string; marketId: string; classification: SellerClassification; reason: string }) {
  if (!input.reason?.trim()) throw Object.assign(new Error("سبب القرار مطلوب."), { status: 400, code: "REASON_REQUIRED", expose: true });
  await db.insert(sellerClassifications).values({
    id: randomUUID(),
    sellerId: input.sellerId,
    marketId: input.marketId,
    classification: input.classification,
    confidence: 100,
    source: "ADMIN",
    signals: [],
    reason: input.reason.trim(),
    actorId: input.adminId,
  });
  return resolveSellerClassification(db, input.sellerId, input.marketId);
}

/**
 * Marketplace commission for a classification. The published policy rate applies to merchants and
 * businesses only; Connect partners pay under their own agreement; personal sellers and undecided
 * cases pay nothing automatically.
 */
export function marketplaceRateFor(classification: SellerClassification, policyRateBps: number) {
  if (classification === "INDIVIDUAL_MERCHANT" || classification === "REGISTERED_BUSINESS") return { rateBasisPoints: policyRateBps, rule: "MARKETPLACE_POLICY_RATE" as const };
  if (classification === "CONNECT_PARTNER") return { rateBasisPoints: 0, rule: "CONNECT_AGREEMENT_APPLIES" as const };
  if (classification === "PERSONAL_SELLER") return { rateBasisPoints: 0, rule: "PERSONAL_SALE_NO_COMMISSION" as const };
  return { rateBasisPoints: 0, rule: "UNDER_REVIEW_NO_AUTOMATIC_COMMISSION" as const };
}

/** Records a signals-based resolution when it differs from the stored one, so history explains changes. */
export async function recordResolutionIfChanged(tx: Tx, sellerId: string, marketId: string, resolution: Resolution) {
  if (resolution.source !== "SIGNALS" && resolution.source !== "BUSINESS_PROFILE" && resolution.source !== "CONNECT_PARTNER") return resolution.recordId;
  const current = await latest(tx, sellerId, marketId);
  if (current && current.classification === resolution.classification && current.source === resolution.source) return current.id;
  const id = randomUUID();
  await tx.insert(sellerClassifications).values({ id, sellerId, marketId, classification: resolution.classification, confidence: resolution.confidence, source: resolution.source, signals: resolution.signals, reason: resolution.reason, actorId: null });
  return id;
}
