/**
 * DINAR commercial economy inside the shared conversation runtime (Monetization V3).
 *
 * An intent adapter, not an agent or a mode: deterministic phrases only, every step an
 * `ai_result_sets` row of kind COMMERCE whose resourceIds are server ids the seller refers
 * to by ordinal, and every money-moving step a pending review that only the same actor's
 * explicit confirmation applies through the commercial authorities (ledger, promotion,
 * business). Payloads are rebuilt from live server state; the client only renders them.
 * No model output can credit, charge, grant, activate or change any number here.
 */
import { cancelSubscriptionEverywhere, configuredAppOrigin, startSubscriptionCheckout, SUBSCRIPTION_TAX_NOTE } from "../lib/subscription-checkout";
import {
  providerDirectApplies,
  providerPromotionReviewNote,
  startProviderPromotionCheckout,
} from "../lib/promotion-billing";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CONVERSATION_SURFACE_FAMILIES,
  isDinarTutorialQuestion,
  type TutorialPayload,
} from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, conversations, db, offers } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import {
  commercialHistory,
  commercialSpendSummary,
  createTopupIntent,
  getCommercialBalance,
  simulateTopupCapture,
  topupAmountMinor,
} from "../lib/commercial-ledger";
import { formatMinorAmount, getCommercialPolicy, majorToMinor, PULSE_WINDOW_MS, type PulseWindow } from "../lib/commercial-policy";
import {
  campaignAnalytics,
  commercialProducts,
  commercialProductView,
  DEMAND_CAPTURE_PITCH,
  DEMAND_PRIVACY_NOTE,
  expireStalePromotions,
  getSellerPromotion,
  listEntitlements,
  listSellerPromotions,
  promotableListings,
  purchaseCommercialProduct,
  reviewCommercialPurchase,
  type CommercialPaymentSource,
} from "../lib/promotions";
import { isPromotionFeatureEnabled } from "../lib/promotion-policy";
import {
  businessEntitlements,
  businessPlans,
  getBusinessStatus,
  reviewBusinessSubscription,
  subscribeBusiness,
} from "../lib/business";
import { approximate, insightView, marketPulse, type PulseMode } from "../lib/market-pulse";
import { needCoverage, needTokens } from "../lib/demand-normalization";
import { listMarketplaceCategories } from "../lib/marketplace-categories";
import { publishedListingCities } from "../lib/marketplace-listings";
import { markLatestNeedUnsatisfied, needFromSearch } from "../lib/demand-signals";
import { demandOptions } from "../lib/demand-rescue";
import { normalizeSearch } from "./search-context";
import { findOrdinalMention, foldArabicLetters, normalizeDigits, parseResultReference } from "./arabic-normalization";
import { promotionIntent } from "./intent";
import { aiUsageSummary } from "../lib/ai-usage";
import { plansCardPrompt, plansCardView, usageCardPrompt, usageCardView, usageProjection } from "./usage-turn";
import { AI_USAGE_QUESTION } from "./usage-intent";
import { resumeConversationDraftById } from "./draft-actions";
import type { ToolResult } from "./tool-registry";
import { businessIntent, isPossibleBusinessMessage, normalizeBusinessText, type BusinessIntent } from "./business-intent";
import { subscriptionPlansOverview } from "../lib/subscription-overview";
import {
  createBusinessDraft,
  getOwnBusiness,
  listOwnBusinesses,
  startBusinessVerification,
  submitBusinessForReview,
  updateBusinessProfile,
  businessVerificationReadiness,
  BUSINESS_CATEGORIES,
  DOCUMENT_KIND_LABELS,
  type BusinessOwnerView,
} from "../lib/business-profiles";
import { namedPlanCodes, PLAN_CODES, type PlanCode } from "../lib/subscription-plans";
import { subscriptionBillingStatus } from "../lib/subscription-billing";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult; redirectMessage?: string };
type StoredSet = typeof aiResultSets.$inferSelect;

export const COMMERCE_SURFACES = CONVERSATION_SURFACE_FAMILIES.commercial;
type CommerceSurface = (typeof COMMERCE_SURFACES)[number];

export const COMMERCE_PENDING_TTL_MS = 10 * 60 * 1000;

const PendingAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TOPUP"), amountMinor: z.number().int().positive() }).strict(),
  z
    .object({
      type: z.literal("PURCHASE"),
      productId: z.string().min(1),
      listingId: z.string().min(1).optional(),
      budgetMinor: z.number().int().positive().optional(),
      paymentSource: z.enum(["COMMERCIAL_BALANCE", "BUNDLE_ENTITLEMENT"]),
    })
    .strict(),
  z.object({ type: z.literal("SUBSCRIBE"), planId: z.string().min(1), businessId: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal("CANCEL_SUBSCRIPTION") }).strict(),
]);
type PendingAction = z.infer<typeof PendingAction>;

const CommerceQuery = z
  .object({
    kind: z.literal("COMMERCE"),
    ownerId: z.string().min(1),
    view: z.enum(COMMERCE_SURFACES),
    tutorialId: z.enum([
      "SELL_FIRST_LISTING",
      "PHOTO_FIRST_SELLING",
      "PROMOTION_OVERVIEW",
      "FEATURED_EXPLAINER",
      "VIP_EXPLAINER",
      "DEMAND_CAPTURE_EXPLAINER",
    ]).optional(),
    tutorialDraftId: z.string().uuid().optional(),
    step: z.enum(["LISTING", "PRODUCT", "BUDGET"]).optional(),
    productType: z.string().max(40).optional(),
    listingId: z.string().max(80).optional(),
    productId: z.string().max(80).optional(),
    promotionId: z.string().max(80).optional(),
    pulse: z
      .object({
        window: z.enum(["24h", "7d", "30d"]),
        mode: z.enum(["TOP", "UNMET", "OPPORTUNITIES"]),
        city: z.string().max(60).optional(),
        categoryId: z.string().max(80).optional(),
        needText: z.string().max(80).optional(),
        budgetMinor: z.number().int().positive().optional(),
        compare: z.boolean().optional(),
      })
      .strict()
      .optional(),
    upsell: z.boolean().optional(),
    usageQuestion: z.enum(["SUMMARY", "RENEWAL", "WHY_STOPPED"]).optional(),
    planFocus: z.enum(["BUSINESS_GO", "BUSINESS_PRO"]).optional(),
    /** D1: a public plan the user asked about (comparison or Business explanation). */
    publicPlanFocus: z.array(z.enum(PLAN_CODES)).max(3).optional(),
    /** D2: the actor's business shown on the DINAR Business card (re-read from the server). */
    businessId: z.string().uuid().optional(),
    businessFocus: z.enum(["OVERVIEW", "INFO", "UPLOAD", "STATUS", "CONNECT"]).optional(),
    action: PendingAction.optional(),
    /** Whop phase 2: the hosted payment page prepared after «تأكيد» (nothing paid until Whop confirms). */
    checkout: z
      .object({ subscriptionId: z.string().uuid(), url: z.string().max(600).regex(/^https:\/\/[^\s]+$/), expiresAt: z.string().max(40) })
      .strict()
      .optional(),
    /** Jassim Ads Phase 2: the Whop page for one promotion (it starts only after Whop confirms). */
    promotionCheckout: z
      .object({ promotionId: z.string().uuid(), url: z.string().max(600).regex(/^https:\/\/[^\s]+$/), amountLabel: z.string().max(60), note: z.string().max(400) })
      .strict()
      .optional(),
    status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "REJECTED"]).optional(),
    notice: z.string().max(600).optional(),
  })
  .strict();
type CommerceQuery = z.infer<typeof CommerceQuery>;

export function isCommerceQuery(query: unknown) {
  return (query as { kind?: unknown } | null)?.kind === "COMMERCE";
}
export function commerceStateExpiry(query: unknown, now = Date.now()): Date | undefined {
  const parsed = CommerceQuery.safeParse(query);
  if (!parsed.success) return undefined;
  return new Date(now + (parsed.data.action ? COMMERCE_PENDING_TTL_MS : 30 * 24 * 60 * 60 * 1000));
}

// ─── Phrases ─────────────────────────────────────────────────────────────────

function normalize(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .toLowerCase()
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WANT = String.raw`(?:(?:انا\s+)?(?:اريد|ابي|ابغي|بدي|ودي|حاب)\s+)?`;
const LISTING_NOUN = String.raw`(?:ال)?(?:اعلان|عرض|منتج|سياره|اعلاني|عرضي)\S*`;
const P = {
  injection: /(?:اجعل|خل|خلي|حط|زود|ضيف)\s+(?:لي\s+)?رصيدي?\s*\d|اعتبر(?:ني)?\s+(?:اني\s+)?دفعت|اعتبر\s+(?:ال)?دفع|(?:ممول|مميز|vip)\s+(?:مجانا|ببلاش|بدون\s+(?:دفع|رصيد))|بدون\s+دفع|set\s+(?:balance|paid)|mark\s+.*paid/u,
  employment: /(?:روج|ميز|vip|ممول|ارفع|رتب|قدم)\s*.*(?:سيرتي|ملفي الوظيفي|طلب التوظيف|طلبي للوظيفه|ترشيحي|المرشح|المرشحين|المتقدم|المتقدمين)|(?:سيرتي|ملفي الوظيفي|المرشحين|المتقدمين)\s*.*(?:vip|ممول|مميز|اول|اعلي)/u,
  balance: /^(?:(?:اعرض|وريني|شوف|كم)\s+)?(?:رصيدي|رصيد)(?:\s+(?:الاعلاني|التجاري|في (?:دينار|جاسم)))?$|^كم\s+(?:باقي\s+)?(?:في\s+)?رصيدي|^(?:كم\s+)?ميزانيتي\s+الاعلانيه(?:\s+كم)?$|^رصيدي الاعلاني كم$/u,
  history: /وش\s+دفعت|ماذا\s+دفعت|مشترياتي\s+الاعلانيه|وش\s+شريت|كم\s+صرفت\s+(?:هذا|هالشهر|الشهر)|سجل\s+(?:الرصيد|المدفوعات|المشتريات)/u,
  topup: /^(?:اريد|ابي|ابغي|بدي|ودي)?\s*(?:اشحن|شحن|اشحنلي)(?:\s+(?:لي|رصيدي|الرصيد|الاعلاني|التجاري))*(?:\s+(\d+(?:\.\d+)?))?(?:\s+(?:دينار|دنانير|jod|kwd))?$/u,
  bundle: /(?:اشتر|اشتري|ابي|اريد|اعرض|وريني)\s+(?:لي\s+)?(?:ال)?باق(?:ه|ات)|^(?:ال)?باقات(?:\s+(?:الاعلانيه|الاعلانات))?$|^باقات الاعلانات$/u,
  bundleStatus: /^(?:كم\s+)?(?:باقي\s+(?:في|من)\s+)?باقاتي$|^وحدات\s+باقاتي$|^اعرض\s+باقاتي$/u,
  featured: new RegExp(String.raw`^(?:${WANT}(?:(?:خل|خلي|اجعل|سو|صير)\s+${LISTING_NOUN}(?:\s+\S+){0,3}\s+مميز|اعلان\s+مميز(?:\s+ل\S+)?|ميز\s+${LISTING_NOUN})|.*\bfeatured\b.*)$`, "u"),
  promoteEntry: /^(?:روج\s+(?:اعلاني|اعلاناتي)|اعرض\s+(?:خيارات\s+)?الترويج)$/u,
  vip: /(?:^|\s)vip(?:\s|$)|في\s+اي\s+بي/u,
  refresh: new RegExp(String.raw`^${WANT}(?:ارفع|جدد|جددي|رفع|تجديد|حدث)\s+${LISTING_NOUN}`, "u"),
  demand: /روح\s+بع(?:ه|ها)?\s*لي|روح\s+بيع(?:ه|ها)?\s*لي|روح\s+بيعه|فعل\s+روح\s+بع|بع\s+لي\s+(?:هذا|هذي|هذه)|(?:دينار|جاسم)\s+بع\s*لي|(?:ساعدني|ساعد)\s+.*(?:الاقي|احصل|اجيب)\s+.*(?:مشتري|مشترين|عميل|عملاء)|(?:سوق|روج)\s+لي\s+(?:اعلاني|الاعلان|هذا\s+الاعلان|العرض)/u,
  sponsoredSearch: /(?:ممول|ممولا)\s+في\s+البحث|(?:اعلان|ظهور)\s+ممول\s+في\s+البحث|(?:خل|خلي|اجعل)\s+\S+(?:\s+\S+)?\s+ممول$/u,
  sponsoredRecommendation: /(?:ممول|ممولا)\s+في\s+(?:ال)?اقتراحات|اقتراح\s+ممول|(?:اقترح|يقترح|توصيه|توصية).*(?:اعلان|اعلاني|عرض).*(?:مناسب|للناس|للعملاء)/u,
  sponsoredSearchIntent: /(?:اعلاني|اعلان|العرض).*(?:يظهر|يبان|يوصل).*(?:يدور|يبحث|بحث)|(?:اظهر|عرض).*(?:اعلاني|اعلان).*(?:باحث|بحث|يدور|يبحث)/u,
  analytics: /كم\s+صرفت|كم\s+بقي\s+(?:من\s+)?(?:ال)?ميزاني|وش\s+(?:نتائج|جابت|سوت)\s+(?:ال)?حمل|نتائج\s+(?:ال)?حمل|تحليلات\s+(?:ال)?حمل|اداء\s+(?:ال)?حمل/u,
  pulse: /نبض\s+السوق|فرص\s+السوق|(?:اكثر|اكثر\s+شي|اكثر\s+شيء)\s+(?:ال)?(?:منتجات|اشياء|شي|شيء|سيارات|\S+)?\s*(?:ال)?(?:مطلوب|طلب)|(?:عليه|عليها)\s+طلب|وش\s+(?:الناس|العالم)\s+(?:تدور|تبحث|يدورون|يبحثون|تبي|يبون)|ماذا\s+(?:يريد|يبحث)\s+السوق|وش\s+(?:ابيع|بيع)|ماذا\s+ابيع|ايش\s+ابيع|تنصحني\s+ابيع|قسم\s+فيه\s+طلب|طلب\s+اكثر\s+من\s+العرض|(?:هل|فيه|في)\s+(?:في\s+|فيه\s+)?طلب\s+علي|الطلب\s+علي|قارن\s+الطلب/u,
  pulseUnmet: /ما\s+(?:تلقاه|يلقونه|يلقوه|لقوه|يجدونه|وجدوه)|ولا\s+(?:تلقاه|يلقونه|يجدون)|ما\s+يلقون|لا\s+يجدونه|ولا\s+يلاقو/u,
  pulseSell: /ابيع|بيع|فرص|تنصحني/u,
  pulseCompare: /قارن\s+الطلب|الاسبوع\s+الماضي|مقارنه\s+الطلب/u,
  tutorialContinue: /^(?:فهمت|تمام\s+فهمت|تخطي|تجاوز|كمل)$/u,
  business: /(?:دينار|dinar|جاسم|jassim)\s*(?:بزنس|business)|اشترك\s+.*بزنس|اشتراك\s+(?:(?:دينار|جاسم)\s+)?بزنس/u,
  businessStatus: /^(?:حاله|وضع|اعرض)\s+اشتراكي$|^اشتراكي$|^هل\s+انا\s+مشترك|(?:متي|امتي|ايمتي|وقت\s+ما)\s+(?:ينتهي|يخلص|ينتهى)\s+(?:ال)?اشتراك/u,
  businessCancel: /^(?:الغ|الغي|الغاء|اوقف)\s+(?:ال)?اشتراك(?:ي)?(?:\s+(?:في\s+)?(?:(?:دينار|جاسم)\s+)?بزنس)?$|(?:^|\s)(?:الغ|الغي|الغاء|اوقف|وقف)\s+(?:ال)?تجديد(?:\s+(?:ال)?(?:تلقائي|اشتراك|اشتراكي))?$/u,
  // G1: AI usage and plans. Questions about the user's own AI allowance, never ad bundles.
  aiUsage: AI_USAGE_QUESTION,
  // «كم سعر برو؟», «اشترك في Go»: a tier name only counts next to a plan word, so «ايفون pro» stays a search.
  aiPlanTier: /^(?=.*(?:باقه|باقات|اشتراك|اشترك|ترقي|ارقي|بزنس|بيزنس|business|الفرق|خطه))(?=.*(?:^|\s)(?:go|pro|جو|برو)(?:\s|$)).*$|(?:سعر|تكلفه|كلفه|بكم)\s+(?:باقه\s+|خطه\s+)?(?:(?:جاسم|دينار|jassim)\s+)?(?:go|pro|جو|برو)(?:\s|$)|^(?:اريد|ابي|ابغي|ابغى|بدي|ودي|حاب)\s+(?:باقه\s+)?(?:go|pro|جو|برو)$/u,
  aiPlans: /^(?:(?:اعرض|وريني|شوف|ما\s+هي|شو|وش|ايش)\s+)?(?:ال)?باقات(?:ك|كم)?(?:\s+(?:الاشتراك|الاشتراكات|دينار|جاسم|المتاحه))?$|(?:الفرق|فرق)\s+بين\s+(?:ال)?(?:مجاني|باقات)|^(?:اريد|ابي|ابغي|ابغى|بدي|ودي|حاب)\s+(?:ان\s+)?(?:اشترك|(?:ال)?اشتراك)(?:\s+(?:في|ب)?\s*(?:دينار|الباقات|باقه))?$|(?:ترقيه|ترقيت|ارقي|رقي|رق)\s+(?:حسابي|باقتي|اشتراكي)|(?:ترقيه|اشتراك)\s+(?:ال)?حساب|(?:^|\s)(?:ادفع|دفع|سداد|اسدد|اجدد|تجديد)\s+(?:ال)?اشتراك(?:ي)?(?:\s|$)|(?:^|\s)(?:غير|حول|بدل)\s+(?:اشتراكي|باقتي|خطتي)(?:\s|$)/u,
  sellForNeed: /بع\s+لهذا\s+الطلب|بيع\s+لهذا\s+الطلب/u,
  unsatisfied: /ما\s+عجبني|ولا\s+(?:واحد|وحده|شي|شيء)\s+(?:عجبني|مناسب|ينفع)|في\s+غيرهم|فيه\s+غيرهم|في\s+غيرها|ما\s+لقيت\s+(?:اللي|الي|شي)|ابي\s+خيار\s+ثاني|اريد\s+خيارات\s+(?:ثانيه|اخري|غيرها)|خيارات\s+ثانيه|غير\s+هذول|ولا\s+واحد/u,
};
const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|اشحن|ادفع|اشترك|اكد الشراء|تاكيد الشراء|نعم اشحن|نعم اشترك)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا شكرا)$/u;
const BUDGET = /(?:ميزانيت(?:ي|ه)|ميزانيه|بميزانيه|حط|خلها|خليها)\s*(?:للحمله\s*)?(\d+(?:\.\d+)?)|^(\d+(?:\.\d+)?)\s*(?:دينار|دنانير|jod|kwd)?$/u;
const MONEY = /(?:معي|عندي|بميزانيه|ميزانيتي|راس\s+مال(?:ي)?)\s+(\d+(?:\.\d+)?)/u;

const TUTORIALS: Record<TutorialPayload["id"], TutorialPayload> = {
  SELL_FIRST_LISTING: {
    id: "SELL_FIRST_LISTING",
    title: "خطوات نشر أول إعلان",
    caption: "أكمل التفاصيل داخل المحادثة، وراجع الإعلان قبل نشره.",
    animation: "LOCAL_STEP_SEQUENCE",
    steps: [
      { title: "صف ما تبي تبيع", description: "اكتب اسم المنتج أو الخدمة." },
      { title: "أضف التفاصيل", description: "اذكر الحالة والوصف والمعلومات الناقصة." },
      { title: "حدّد السعر", description: "اكتب السعر والكمية عند الحاجة." },
      { title: "راجع المسودة", description: "صحح أي معلومة قبل المتابعة." },
      { title: "انشر بعد موافقتك", description: "لا ينشر جاسم الإعلان تلقائيًا." },
    ],
  },
  PHOTO_FIRST_SELLING: {
    id: "PHOTO_FIRST_SELLING",
    title: "البيع بالصور",
    caption: "الصور تساعد على إعداد مسودة، وأنت تراجع كل معلومة قبل النشر.",
    animation: "LOCAL_STEP_SEQUENCE",
    steps: [
      { title: "أرفق صورة", description: "ابدأ بصورة واضحة للمنتج." },
      { title: "راجع الاقتراحات", description: "قد يقترح جاسم حقولًا من الصورة." },
      { title: "صحح التفاصيل", description: "تأكد من الحالة والسعر بنفسك." },
      { title: "افحص المسودة", description: "راجع النص والصور المعروضة." },
      { title: "انشر بموافقتك", description: "لن ينشر الإعلان دون تأكيدك." },
    ],
  },
  PROMOTION_OVERVIEW: {
    id: "PROMOTION_OVERVIEW",
    title: "كيف يعمل الترويج؟",
    caption: "اختيار الخطة والميزانية والمراجعة كلها تبقى داخل المحادثة.",
    animation: "LOCAL_STEP_SEQUENCE",
    steps: [
      { title: "اختر إعلانًا", description: "يعرض جاسم إعلاناتك المنشورة المؤهلة." },
      { title: "اختر نوع الترويج", description: "تظهر الخيارات المتاحة في سوقك." },
      { title: "حدّد الميزانية", description: "تظهر التكلفة والمدة قبل المتابعة." },
      { title: "راجع وأكّد", description: "لا يبدأ الترويج قبل تأكيدك." },
      { title: "تابع النتائج", description: "تعرض البطاقة حالة الحملة ونتائجها الفعلية." },
    ],
  },
  FEATURED_EXPLAINER: {
    id: "FEATURED_EXPLAINER",
    title: "الإعلان المميز",
    caption: "راجع موضع الظهور والسعر والمدة قبل أي تأكيد.",
    animation: "LOCAL_STEP_SEQUENCE",
    steps: [
      { title: "اختر إعلانك", description: "يعرض جاسم الإعلانات المؤهلة فقط." },
      { title: "راجع الظهور", description: "تظهر تفاصيل موضع الخطة كما هي." },
      { title: "تحقق من السعر", description: "السعر والمدة من خطة السوق الحالية." },
      { title: "راجع الطلب", description: "اقرأ الشروط قبل التأكيد." },
      { title: "أكّد إذا رغبت", description: "الترويج لا يضمن بيعًا." },
    ],
  },
  VIP_EXPLAINER: {
    id: "VIP_EXPLAINER",
    title: "ترويج VIP",
    caption: "VIP يصف خطة ظهور مدفوعة فقط، ولا يعني أن البائع موثّق.",
    animation: "LOCAL_STEP_SEQUENCE",
    steps: [
      { title: "اختر إعلانًا", description: "ابدأ بإعلان منشور ومؤهل." },
      { title: "راجع موضع VIP", description: "توضح البطاقة مكان الظهور ومدته." },
      { title: "تحقق من التكلفة", description: "تظهر التكلفة قبل التأكيد." },
      { title: "أكّد صراحة", description: "لا يبدأ الترويج دون موافقتك." },
      { title: "تابع الحالة", description: "VIP لا يضمن البيع ولا يثبت هوية البائع." },
    ],
  },
  DEMAND_CAPTURE_EXPLAINER: {
    id: "DEMAND_CAPTURE_EXPLAINER",
    title: "جاسم روح بيع لي",
    caption: "يساعد الترويج على الوصول إلى مهتمين وفق إعدادات الحملة، من دون انتحال شخصيتك أو مراسلة الناس نيابةً عنك.",
    animation: "LOCAL_STEP_SEQUENCE",
    steps: [
      { title: "اختر إعلانًا", description: "تأكد أن الإعلان المنشور هو المقصود." },
      { title: "راجع آلية الحملة", description: "تظهر سياسة الخصوصية والتفاعل المؤهل." },
      { title: "حدّد الميزانية", description: "اختر ميزانية ضمن حدود الخطة." },
      { title: "راجع وأكّد", description: "لا تبدأ الحملة دون موافقتك." },
      { title: "تابع النتائج", description: "جاسم لا يرسل رسائل مزعجة أو ينتحل هويتك." },
    ],
  },
};

/**
 * Market Pulse reads DINAR's own market. «هل الطلب على الهواتف كبير في العالم؟» asks about a
 * wider scope DINAR has no data for, so it is a general question for the model.
 */
const BEYOND_DINAR_MARKET = /(?:^|\s)(?:في\s+)?(?:العالم|عالميا|دوليا|الدول|globally|worldwide)(?:\s|$)|بشكل\s+عام|عموما/u;
const GENERAL_CURRENT_DEMAND_QUESTION =
  /(?:الطلب\s+علي|فيه\s+طلب\s+علي)\s+.+\s+(?:عالي|مرتفع|كبير).*(?:هالايام|هذه\s+الايام|هالفتره|هذه\s+الفتره)/u;
const EXPLICIT_DINAR_MARKET_SCOPE = /(?:في\s+(?:سوق\s+)?دينار|داخل\s+(?:السوق|المنصه)\s+دينار|سوقنا|منصتنا)/u;
const isMarketPulseQuestion = (text: string) =>
  P.pulse.test(text) &&
  !BEYOND_DINAR_MARKET.test(text) &&
  !(GENERAL_CURRENT_DEMAND_QUESTION.test(text) && !EXPLICIT_DINAR_MARKET_SCOPE.test(text));

function tutorialFor(text: string): TutorialPayload | undefined {
  const semantic = promotionIntent(text);
  if (semantic?.kind === "EXPLAIN") {
    const id: TutorialPayload["id"] = semantic.productType === "VIP_LISTING"
      ? "VIP_EXPLAINER"
      : semantic.productType === "FEATURED_LISTING"
        ? "FEATURED_EXPLAINER"
        : semantic.productType === "DEMAND_CAPTURE"
          ? "DEMAND_CAPTURE_EXPLAINER"
          : "PROMOTION_OVERVIEW";
    return TUTORIALS[id];
  }
  if (!isDinarTutorialQuestion(text)) return undefined;
  const id: TutorialPayload["id"] = /(?:^|\s)vip(?:\s|$)|في\s+اي\s+بي/u.test(text)
    ? "VIP_EXPLAINER"
    : /featured|مميز/u.test(text)
      ? "FEATURED_EXPLAINER"
      : /صور|صوره|photo/u.test(text)
        ? "PHOTO_FIRST_SELLING"
      : /روح\s+بيع|ساعدني|مشتري|عملاء/u.test(text)
        ? "DEMAND_CAPTURE_EXPLAINER"
        : /تبيع|بيع|انشر|مسوده|اعلان/u.test(text) &&
            !/ترويج|روج|سوق|اعلاني/u.test(text)
          ? "SELL_FIRST_LISTING"
          : "PROMOTION_OVERVIEW";
  return TUTORIALS[id];
}

export function isCommerceCommand(message: string): boolean {
  const text = normalize(message);
  return isDinarTutorialQuestion(text) ||
    isMarketPulseQuestion(text) ||
    Object.entries(P).some(([key, pattern]) => !["pulse", "pulseUnmet", "pulseSell", "pulseCompare", "unsatisfied"].includes(key) && pattern.test(text)) ||
    promotionIntent(message)?.kind === "ACTION";
}

function ordinalIn(text: string): number | undefined {
  const whole = parseResultReference(text);
  if (whole?.kind === "INDEX") return whole.index;
  const numbered = text.match(/(?:^|\s)(?:رقم|الاعلان|العرض|الباقه|الخيار|المنتج|الفرصه)\s*(?:رقم\s*)?(\d{1,2})(?=\s|$)/u);
  if (numbered) return Number(numbered[1]) - 1;
  const mention = findOrdinalMention(text);
  return mention?.kind === "INDEX" ? mention.index : undefined;
}

// ─── State and rendering ─────────────────────────────────────────────────────

function parseState(set: StoredSet | undefined, actorId: string) {
  if (!set) return undefined;
  const parsed = CommerceQuery.safeParse(set.query);
  return parsed.success && parsed.data.ownerId === actorId ? parsed.data : undefined;
}

async function conversationSets(conversationId: string, marketId: string) {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(10);
}

async function focusedSellerDraftId(conversationId: string) {
  const rows = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(and(
      eq(aiUiBlocks.conversationId, conversationId),
      sql`${aiUiBlocks.payload}->>'surface' = 'SELL'`,
    ))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(20);
  for (const row of rows) {
    const payload = row.payload as { draft?: { draftId?: unknown }; draftStep?: unknown };
    const draftId = payload.draft?.draftId;
    const step = String(payload.draftStep ?? "");
    if (
      typeof draftId === "string" &&
      z.string().uuid().safeParse(draftId).success &&
      !["published", "cancelled", "choose_draft"].includes(step)
    ) return draftId;
  }
  return undefined;
}

const ACTION_LABELS: Record<string, string> = {
  PENDING: "بانتظار تأكيدك",
  CONFIRMED: "تم التنفيذ بعد تأكيدك",
  CANCELLED: "أُلغي دون أي تغيير",
  EXPIRED: "انتهت صلاحيته دون أي تغيير",
  REJECTED: "لم يُنفذ؛ لم يتغير شيء",
};

const REVIEW_SURFACE: Record<string, CommerceSurface> = {
  FEATURED_LISTING: "FEATURED_REVIEW",
  VIP_LISTING: "VIP_REVIEW",
  REFRESH_LISTING: "REFRESH_REVIEW",
  PROMOTION_BUNDLE: "BUNDLE_REVIEW",
  DEMAND_CAPTURE: "DEMAND_CAPTURE_REVIEW",
  SPONSORED_SEARCH: "COMMERCIAL_PRODUCT_REVIEW",
  SPONSORED_RECOMMENDATION: "COMMERCIAL_PRODUCT_REVIEW",
};

/** Rebuilt from live server state on every turn and history read. */
async function composePayload(state: CommerceQuery, resourceIds: string[], resultSetId: string, actorId: string, market: Market): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { view: state.view, paymentMode: "TEST_NO_TRANSFER", autoRenew: false };
  if (state.step) payload.step = state.step;
  if (state.productType) payload.productType = state.productType;
  if (state.notice) payload.notice = state.notice;
  if (state.upsell) payload.upsell = true;
  if (state.action)
    payload.action = { actionId: resultSetId, type: state.action.type, status: state.status ?? "PENDING", statusLabel: ACTION_LABELS[state.status ?? "PENDING"] };
  try {
    switch (state.view) {
      case "COMMERCIAL_BALANCE":
      case "COMMERCIAL_LEDGER_SUMMARY": {
        await expireStalePromotions({ sellerId: actorId });
        payload.balance = await getCommercialBalance(actorId, market);
        payload.history = await commercialHistory(actorId, market, state.view === "COMMERCIAL_LEDGER_SUMMARY" ? 20 : 5);
        const month = new Date();
        month.setUTCDate(1);
        month.setUTCHours(0, 0, 0, 0);
        const spend = await commercialSpendSummary(actorId, market, month);
        payload.monthSpentLabel = formatMinorAmount(spend.spentMinor, market.minorUnitScale, market.currencyCode);
        payload.entitlements = (await listEntitlements(actorId, market)).filter((item) => item.status === "ACTIVE");
        break;
      }
      case "COMMERCIAL_TOPUP_REVIEW": {
        const balance = await getCommercialBalance(actorId, market);
        const amount = state.action?.type === "TOPUP" ? state.action.amountMinor : 0;
        payload.topup = {
          amountMinor: amount,
          amountLabel: formatMinorAmount(amount, market.minorUnitScale, market.currencyCode),
          currencyCode: market.currencyCode,
          marketId: market.id,
          balance,
          balanceAfterLabel: formatMinorAmount(balance.availableMinor + amount, market.minorUnitScale, market.currencyCode),
          statement: balance.statement,
          verificationNote: "يُضاف الرصيد فقط بعد تأكيد موثّق من مزوّد الدفع، لا من صفحة أو رسالة «تم الدفع».",
        };
        break;
      }
      case "COMMERCIAL_PRODUCTS": {
        const products = await commercialProducts(market, {
          ...(state.productType ? { productTypes: [state.productType] } : {}),
        });
        const byId = new Map(products.map((product) => [product.id, product]));
        payload.products = resourceIds.flatMap((id) => (byId.has(id) ? [commercialProductView(byId.get(id)!, market)] : []));
        if (state.listingId) payload.listing = await listingRef(state.listingId, actorId);
        break;
      }
      case "PROMOTION_TYPE_OPTIONS": {
        if (state.step === "LISTING") {
          const live = await promotableListings(actorId, market);
          const byId = new Map(live.map((item) => [item.id, item]));
          payload.listings = resourceIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
        } else if (state.step === "PRODUCT" && state.listingId) {
          const listing = (await promotableListings(actorId, market)).find((item) => item.id === state.listingId);
          if (listing) {
            const products = await commercialProducts(market, { productTypes: [...LISTING_PROMOTION_TYPES], categoryId: listing.categoryId });
            const byId = new Map(products.map((product) => [product.id, product]));
            payload.listing = await listingRef(state.listingId, actorId);
            payload.products = resourceIds.flatMap((id) => byId.has(id) ? [commercialProductView(byId.get(id)!, market)] : []);
          }
        } else if (state.step === "BUDGET" && state.productId) {
          const [product] = (await commercialProducts(market, {})).filter((item) => item.id === state.productId);
          if (product) payload.product = commercialProductView(product, market);
          if (state.listingId) payload.listing = await listingRef(state.listingId, actorId);
          payload.balance = await getCommercialBalance(actorId, market);
          if (state.productType === "DEMAND_CAPTURE") Object.assign(payload, { pitch: DEMAND_CAPTURE_PITCH, privacyNote: DEMAND_PRIVACY_NOTE });
        }
        break;
      }
      case "FEATURED_REVIEW":
      case "VIP_REVIEW":
      case "REFRESH_REVIEW":
      case "BUNDLE_REVIEW":
      case "DEMAND_CAPTURE_REVIEW":
      case "COMMERCIAL_PRODUCT_REVIEW": {
        if (state.action?.type === "PURCHASE") {
          try {
            payload.review = await reviewCommercialPurchase({
              actorId,
              market,
              productId: state.action.productId,
              listingId: state.action.listingId,
              budgetMinor: state.action.budgetMinor,
              paymentSource: state.action.paymentSource,
            });
          } catch (error) {
            if ((state.status ?? "PENDING") === "PENDING") throw error;
          }
          // Real payment through a registered provider replaces the test balance for direct fixed-price products.
          const review = payload.review as { failureCode?: string; sufficient?: boolean; failure?: string; balanceAfterLabel?: string; missingLabel?: string } | undefined;
          const direct = review
            ? await providerDirectApplies({ market, productId: state.action.productId, paymentSource: state.action.paymentSource })
            : { applies: false as const };
          if (review && direct.applies) {
            if (review.failureCode === "INSUFFICIENT_BALANCE") {
              delete review.failure;
              delete review.failureCode;
            }
            review.sufficient = true;
            delete review.balanceAfterLabel;
            delete review.missingLabel;
            payload.providerPayment = {
              providerKey: direct.provider.providerKey,
              displayName: direct.provider.displayName,
              note: providerPromotionReviewNote(direct.provider),
            };
          }
        }
        if (state.promotionId) payload.promotion = await getSellerPromotion(actorId, market, state.promotionId);
        if (state.promotionCheckout && (payload.promotion as { effectiveStatus?: string } | undefined)?.effectiveStatus === "PENDING_PAYMENT")
          payload.promotionCheckout = state.promotionCheckout;
        break;
      }
      case "BUNDLE_STATUS":
        payload.entitlements = await listEntitlements(actorId, market);
        payload.balance = await getCommercialBalance(actorId, market);
        break;
      case "CAMPAIGN_STATUS":
        if (state.promotionId) payload.promotion = await getSellerPromotion(actorId, market, state.promotionId);
        // The Whop link is shown only while that campaign still waits for its payment.
        if (state.promotionCheckout && (payload.promotion as { effectiveStatus?: string } | undefined)?.effectiveStatus === "PENDING_PAYMENT")
          payload.promotionCheckout = state.promotionCheckout;
        payload.balance = await getCommercialBalance(actorId, market);
        break;
      case "CAMPAIGN_ANALYTICS": {
        await expireStalePromotions({ sellerId: actorId });
        const analytics = await campaignAnalytics(actorId, market, resourceIds.length ? resourceIds : undefined);
        payload.campaigns = analytics;
        payload.balance = await getCommercialBalance(actorId, market);
        payload.privacyNote = "أرقام مجمّعة فقط؛ لا تظهر هوية أي مشترٍ أو رسائله أو موقعه أو أي سعر تفاوض خاص.";
        break;
      }
      case "MARKET_PULSE":
      case "MARKET_OPPORTUNITY": {
        if (!state.pulse) break;
        const entitled = await businessEntitlements(actorId, market);
        const policy = await getCommercialPolicy(market.id);
        const business = entitled.has("MARKET_PULSE_ADVANCED");
        const result = await marketPulse({
          market,
          window: state.pulse.window,
          mode: state.pulse.mode,
          limit: state.view === "MARKET_OPPORTUNITY" ? 1 : business ? policy.businessPulseInsightLimit : policy.freePulseInsightLimit,
          ...(state.pulse.city ? { city: state.pulse.city } : {}),
          ...(state.pulse.categoryId ? { categoryId: state.pulse.categoryId } : {}),
          ...(state.pulse.needText ? { needText: state.pulse.needText } : {}),
          ...(state.pulse.budgetMinor ? { budgetMinor: state.pulse.budgetMinor } : {}),
        });
        const owned = (await promotableListings(actorId, market)).map((item) => ({ id: item.id, tokens: needTokens(item.title) }));
        payload.pulse = {
          status: result.status,
          message: result.message,
          window: result.window,
          windowLabel: { "24h": "آخر 24 ساعة", "7d": "آخر 7 أيام", "30d": "آخر 30 يومًا" }[result.window],
          marketId: market.id,
          city: result.city,
          generatedAt: result.generatedAt,
          cohortThreshold: result.cohortThreshold,
          tier: business ? "BUSINESS" : "FREE",
          insights: result.clusters.map((cluster) => ({
            ...insightView(cluster, market),
            ...(state.pulse!.compare ? { previousLabel: cluster.trend === "INSUFFICIENT_DATA" ? "الفترة السابقة دون حد الخصوصية" : `${approximate(cluster.previousActors)} في الفترة السابقة` } : {}),
            // «فعّل روح بع لي» only when the seller already owns a matching listing.
            canActivateDemandCapture: owned.some((item) => needCoverage(needTokens(cluster.title), item.tokens.join(" ")) >= 0.5),
          })),
          disclaimer: "إشارات مجمّعة من بحث مستخدمي جاسم داخل المنصة فقط، وليست وعدًا بربح أو بيع.",
        };
        break;
      }
      case "BUSINESS_PLAN_REVIEW": {
        if (state.action?.type === "SUBSCRIBE") payload.review = await reviewBusinessSubscription({ actorId, market, planId: state.action.planId, businessId: state.action.businessId });
        else payload.plans = await businessPlans(market);
        payload.status = await getBusinessStatus(actorId, market);
        break;
      }
      case "BUSINESS_STATUS":
        payload.status = await getBusinessStatus(actorId, market);
        if (state.checkout) payload.checkout = { ...state.checkout, taxNote: SUBSCRIPTION_TAX_NOTE };
        break;
      case "AI_USAGE":
        payload.usage = await usageCardView(actorId, market);
        break;
      case "AI_PLANS":
        payload.aiPlans = await plansCardView(actorId, market);
        if (state.publicPlanFocus) payload.publicPlanFocus = state.publicPlanFocus;
        break;
      case "BUSINESS_PROFILE": {
        // Rebuilt from the business authority on every read: status, documents and actions are
        // never the stored card's; a stranger (or another market) gets the expired notice.
        const business = state.businessId ? await getOwnBusiness(actorId, market, state.businessId).catch(() => undefined) : undefined;
        if (!business) {
          payload.notice = "لا يوجد نشاط تجاري مرتبط بهذه البطاقة في حسابك وسوقك الحاليين.";
          break;
        }
        payload.business = businessCard(business, state.businessFocus ?? "OVERVIEW");
        break;
      }
      default:
        break;
    }
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (!(typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)) throw error;
    payload.notice = `${error.message}.`;
    if (state.action && (state.status ?? "PENDING") === "PENDING")
      payload.action = { ...(payload.action as object), status: "REJECTED", statusLabel: ACTION_LABELS.REJECTED };
  }
  return payload;
}

async function listingRef(listingId: string, actorId: string) {
  const [row] = await db.select({ id: offers.id, data: offers.data, sellerId: offers.sellerId }).from(offers).where(eq(offers.id, listingId));
  return row && row.sellerId === actorId ? { id: row.id, title: typeof row.data.title === "string" ? row.data.title : "إعلان" } : undefined;
}

async function turnFor(state: CommerceQuery, resourceIds: string[], prompt: string, actorId: string, market: Market): Promise<Turn> {
  const resultSetId = randomUUID();
  const tutorial = state.tutorialId ? TUTORIALS[state.tutorialId] : undefined;
  return {
    tool: "commerce",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: tutorial ? "TUTORIAL_VIDEO_CARD" : state.view,
      resultSetId,
      resourceIds,
      ...(state.listingId ? { resourceId: state.listingId } : {}),
      prompt,
      query: state,
      listings: [],
      commerce: await composePayload(state, resourceIds, resultSetId, actorId, market),
      ...(tutorial ? { tutorial } : {}),
    },
  };
}

function notice(actorId: string, prompt: string, market: Market, view: CommerceSurface = "COMMERCE_NOTICE") {
  return turnFor({ kind: "COMMERCE", ownerId: actorId, view, notice: prompt }, [], prompt, actorId, market);
}

export async function refreshCommercePayload(
  payload: Record<string, unknown>,
  context: { actorId: string; market: Market; query: unknown; resourceIds?: string[]; expiresAt?: Date | null },
) {
  const parsed = CommerceQuery.safeParse(context.query);
  if (!parsed.success || parsed.data.ownerId !== context.actorId) return { view: "COMMERCE_NOTICE", notice: "انتهت صلاحية هذه البطاقة." };
  let state = parsed.data;
  if (state.action && (state.status ?? "PENDING") === "PENDING" && context.expiresAt && context.expiresAt.getTime() <= Date.now())
    state = { ...state, status: "EXPIRED" };
  return composePayload(state, context.resourceIds ?? [], String(payload.resultSetId), context.actorId, context.market);
}

// ─── Confirmations ───────────────────────────────────────────────────────────

export type CommerceActionOutcome = {
  status: "CONFIRMED" | "CANCELLED" | "EXPIRED" | "REJECTED";
  message: string;
  promotionId?: string;
  view?: CommerceSurface;
  checkout?: { subscriptionId: string; url: string; expiresAt: string };
  promotionCheckout?: { promotionId: string; url: string; amountLabel: string; note: string };
};

/**
 * The single place a commercial review is confirmed or cancelled (typed «نعم» or the card
 * button): owner only, latest card only, unexpired. Each action uses its own id as the
 * idempotency key, so repeated confirmations have one financial effect.
 */
export async function applyCommerceAction(input: { actionId: string; actorId: string; market: Market; decision: "CONFIRM" | "CANCEL" }): Promise<CommerceActionOutcome> {
  const checked = await db.transaction(async (tx) => {
    const [set] = await tx.select().from(aiResultSets).where(and(eq(aiResultSets.id, input.actionId), eq(aiResultSets.marketId, input.market.id))).for("update").limit(1);
    if (!set) throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, set.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.kind, "AI")))
      .limit(1);
    const state = parseState(set, input.actorId);
    if (!conversation || !state?.action) throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const settle = async (status: CommerceActionOutcome["status"], message: string, promotionId?: string) => {
      await tx.update(aiResultSets).set({ query: { ...state, status, notice: message, ...(promotionId ? { promotionId } : {}) } }).where(eq(aiResultSets.id, set.id));
      return { done: { status, message, promotionId } as CommerceActionOutcome };
    };
    if (state.status && state.status !== "PENDING")
      return {
        done: {
          status: state.status as CommerceActionOutcome["status"],
          message: state.status === "CONFIRMED" ? state.notice ?? ACTION_LABELS.CONFIRMED : "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء.",
          promotionId: state.promotionId,
        },
      };
    const [newer] = await tx
      .select({ id: aiUiBlocks.id })
      .from(aiUiBlocks)
      .where(and(eq(aiUiBlocks.conversationId, set.conversationId), gt(aiUiBlocks.createdAt, sql`(select ${aiResultSets.createdAt} from ${aiResultSets} where ${aiResultSets.id} = ${set.id})`)))
      .limit(1);
    if ((set.expiresAt && set.expiresAt.getTime() <= Date.now()) || newer)
      return settle("EXPIRED", "انتهت صلاحية هذه المراجعة لأن المحادثة تابعت بعدها أو مضى وقتها. لم يتغير شيء؛ اطلبها من جديد.");
    if (input.decision === "CANCEL") return settle("CANCELLED", "أُلغي الطلب. لم يُخصم أو يُضف أي رصيد.");
    return { state, conversationId: set.conversationId };
  });
  if ("done" in checked) return checked.done!;
  const state = checked.state!;
  const action = state.action!;
  const key = `commerce-action:${input.actionId}`;
  const f = (minor: number) => formatMinorAmount(minor, input.market.minorUnitScale, input.market.currencyCode);
  let outcome: CommerceActionOutcome;
  try {
    if (action.type === "TOPUP") {
      const topup = await createTopupIntent({ userId: input.actorId, market: input.market, amountMinor: action.amountMinor, idempotencyKey: key });
      const settled = await simulateTopupCapture({ userId: input.actorId, market: input.market, topupId: topup.id });
      const balance = await getCommercialBalance(input.actorId, input.market);
      outcome =
        settled.topup.status === "CREDITED"
          ? { status: "CONFIRMED", view: "COMMERCIAL_BALANCE", message: `تم شحن ${settled.topup.amountLabel} بعد تأكيد موثّق من مزوّد الدفع التجريبي (دون تحويل أموال حقيقية). رصيدك المتاح الآن ${balance.availableLabel}.` }
          : { status: "REJECTED", view: "COMMERCIAL_BALANCE", message: "لم يُؤكَّد الدفع، فلم يُضف أي رصيد." };
    } else if (action.type === "PURCHASE" && action.listingId && (await providerDirectApplies({ market: input.market, productId: action.productId, paymentSource: action.paymentSource })).applies) {
      // Jassim Ads Phase 2: «تأكيد» opens the registered provider's page; nothing starts before signed payment confirmation.
      const started = await startProviderPromotionCheckout({ actorId: input.actorId, market: input.market, productId: action.productId, listingId: action.listingId, idempotencyKey: key });
      outcome = {
        status: "CONFIRMED",
        view: "CAMPAIGN_STATUS",
        promotionId: started.promotion.id,
        promotionCheckout: { promotionId: started.promotion.id, url: started.checkoutUrl, amountLabel: started.amountLabel, note: started.note },
        message: `صفحة الدفع الآمنة لـ«${started.promotion.productTypeLabel}» على إعلان «${started.promotion.listingTitle}» جاهزة عبر ${started.providerDisplayName} (${started.amountLabel}). لم يُخصم شيء بعد، ولا يبدأ الترويج قبل تأكيد ${started.providerDisplayName} الموقّع.`,
      };
    } else if (action.type === "PURCHASE") {
      const purchase = await purchaseCommercialProduct({
        actorId: input.actorId,
        market: input.market,
        productId: action.productId,
        listingId: action.listingId,
        budgetMinor: action.budgetMinor,
        paymentSource: action.paymentSource as CommercialPaymentSource,
        idempotencyKey: key,
      });
      if (purchase.promotion) {
        const promotion = purchase.promotion;
        outcome = {
          status: "CONFIRMED",
          view: "CAMPAIGN_STATUS",
          promotionId: promotion.id,
          message:
            promotion.chargingMode === "PREPAID_BUDGET"
              ? `فُعّل «${promotion.productTypeLabel}» لإعلان «${promotion.listingTitle}» وحُجزت ميزانية ${promotion.budgetLabel} من رصيدك. يظهر كخيار «ممول» فقط عند طلب مطابق، ويُخصم من الميزانية لكل تفاعل مؤهل. رصيدك المتاح الآن ${purchase.balance.availableLabel}.`
              : `فُعّل «${promotion.productTypeLabel}» لإعلان «${promotion.listingTitle}» حتى ${promotion.expiresAt.slice(0, 10)}${promotion.paymentSource === "BUNDLE_ENTITLEMENT" ? " باستخدام وحدة من باقتك" : ` وخُصم من رصيدك؛ المتاح الآن ${purchase.balance.availableLabel}`}. يظهر بشارة «ممول» فقط حين يطابق بحث المشتري.`,
        };
      } else
        outcome = {
          status: "CONFIRMED",
          view: "BUNDLE_STATUS",
          message: `أُضيفت وحدات الباقة إلى حسابك (${(purchase.entitlements ?? []).map((item) => `${item.unitsTotal} ${item.productType === "VIP_LISTING" ? "VIP" : item.productType === "REFRESH_LISTING" ? "تجديد" : "مميز"}`).join("، ")}). رصيدك المتاح الآن ${purchase.balance.availableLabel}.`,
        };
    } else if (action.type === "SUBSCRIBE" && subscriptionBillingStatus().connected) {
      // Whop phase 2: «تأكيد» prepares the hosted payment page; the plan activates only from Whop's
      // signed, verified payment. The buyer returns to this same conversation after paying.
      const started = await startSubscriptionCheckout({ actorId: input.actorId, market: input.market, planId: action.planId, businessId: action.businessId, idempotencyKey: key, conversationId: checked.conversationId, origin: configuredAppOrigin() });
      outcome = {
        status: "CONFIRMED",
        view: "BUSINESS_STATUS",
        checkout: { subscriptionId: started.subscriptionId, url: started.checkout.checkoutUrl, expiresAt: started.checkout.expiresAt },
        message: `صفحة الدفع الآمنة لـ«${started.plan.name}» جاهزة عبر Whop. لم يُخصم شيء بعد، ولا تُفعَّل الخطة قبل تأكيد Whop الموقّع؛ ستعود بعد الدفع إلى هذه المحادثة. ${SUBSCRIPTION_TAX_NOTE}`,
      };
    } else if (action.type === "SUBSCRIBE") {
      const subscription = await subscribeBusiness({ actorId: input.actorId, market: input.market, planId: action.planId, idempotencyKey: key, businessId: action.businessId });
      outcome = { status: "CONFIRMED", view: "BUSINESS_STATUS", message: `اشتراكك في «${"planName" in subscription ? subscription.planName : "جاسم بزنس"}» نشط حتى ${"currentPeriodEnd" in subscription ? String(subscription.currentPeriodEnd).slice(0, 10) : ""}. لا تجديد تلقائي، ولا يغيّر ترتيب نتائج البحث.` };
    } else {
      const cancelled = await cancelSubscriptionEverywhere({ actorId: input.actorId, market: input.market });
      outcome = { status: "CONFIRMED", view: "BUSINESS_STATUS", message: cancelled.message };
    }
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (!(typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)) throw error;
    const missing = (error as { missingMinor?: number }).missingMinor;
    outcome = {
      status: "REJECTED",
      view: missing ? "COMMERCIAL_TOPUP_REVIEW" : undefined,
      message: `${error.message}.${missing ? ` يمكنك قول «اشحن ${formatMinorAmount(missing, input.market.minorUnitScale, "").trim()}».` : ""} لم يتغير شيء.`,
    };
    void f;
  }
  await db
    .update(aiResultSets)
    .set({ query: { ...state, status: outcome.status, notice: outcome.message, ...(outcome.promotionId ? { promotionId: outcome.promotionId } : {}), ...(outcome.checkout ? { checkout: outcome.checkout } : {}), ...(outcome.promotionCheckout ? { promotionCheckout: outcome.promotionCheckout } : {}) } })
    .where(and(eq(aiResultSets.id, input.actionId), sql`${aiResultSets.query} ->> 'status' is distinct from 'CONFIRMED'`));
  return outcome;
}

// ─── Turn ────────────────────────────────────────────────────────────────────

export type CommerceTurnInput = { conversationId: string; message: string; market: Market; actorId?: string };

export async function executeCommerceTurn(input: CommerceTurnInput): Promise<Turn | null> {
  const text = normalize(input.message);
  if (!text) return null;
  if (promotionIntent(input.message)?.kind === "ADVICE") return null;
  const sets = input.actorId ? await conversationSets(input.conversationId, input.market.id) : [];
  const latestSet = sets[0];
  const latest = input.actorId ? parseState(latestSet, input.actorId) : undefined;
  const tutorial = tutorialFor(text);
  if (tutorial) {
    if (!input.actorId) {
      return {
        tool: "openSurface",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "TUTORIAL_VIDEO_CARD",
          prompt: `${tutorial.caption} اكتب «فهمت» للعودة إلى المحادثة.`,
          tutorial,
          query: {},
          listings: [],
        },
      };
    }
    const tutorialDraftId = await focusedSellerDraftId(input.conversationId);
    const state: CommerceQuery = {
      ...(latest ?? {
        kind: "COMMERCE",
        ownerId: input.actorId,
        view: "COMMERCE_NOTICE",
      }),
      tutorialId: tutorial.id,
      ...(tutorialDraftId ? { tutorialDraftId } : {}),
    };
    return turnFor(
      state,
      latestSet?.resourceIds ?? [],
      `${tutorial.caption} اكتب «فهمت» أو «تخطي» للعودة إلى طلبك.`,
      input.actorId,
      input.market,
    );
  }
  if (latest?.tutorialId && P.tutorialContinue.test(text) && latestSet) {
    if (latest.tutorialDraftId) {
      const resumed = await resumeConversationDraftById({
        conversationId: input.conversationId,
        actorId: input.actorId!,
        market: input.market,
        draftId: latest.tutorialDraftId,
      });
      if (resumed) return resumed;
    }
    const { tutorialId: _tutorialId, ...resumeState } = latest;
    return turnFor(
      resumeState,
      latestSet.resourceIds,
      "نكمل من حيث توقفت. راجع البطاقة واختر الخطوة التالية.",
      input.actorId!,
      input.market,
    );
  }
  // A generic featured-listing request inside the existing duration-plan flow
  // continues that flow. Fresh requests still select the V3 featured product.
  // Do not steal its listing → plan → review sequence into a different product.
  const promotionContext = latestSet?.query as { kind?: unknown; ownerId?: unknown } | undefined;
  if (promotionContext?.kind === "PROMOTION" && promotionContext.ownerId === input.actorId &&
      new RegExp(String.raw`^${WANT}اعلان\s+مميز$`, "u").test(text)) return null;
  const claimed =
    isCommerceCommand(input.message) ||
    (P.unsatisfied.test(text) && Boolean(latestSet && !(latestSet.query as { kind?: unknown })?.kind)) ||
    Boolean(latest && ((latest.action && (latest.status ?? "PENDING") === "PENDING" && (CONFIRM.test(text) || CANCEL.test(text))) || latest.step || latest.view === "MARKET_PULSE" || latest.view === "COMMERCIAL_PRODUCTS")) ||
    Boolean(latest && PLAN_VIEWS.includes(String(latest.view)) && KEEP_PLAN.test(text));
  if (!claimed) return null;
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const market = input.market;
  try {
    // Never moves anything: «اجعل رصيدي 1000», «اعتبر أني دفعت», «ممول بدون دفع».
    if (P.injection.test(text))
      return notice(
        actorId,
        // «اعتبرني دفعت وأكّد الطلب» is about an order, not the advertising balance.
        /(?:^|\s)(?:ال)?طلب(?:ي)?(?:\s|$)/u.test(text)
          ? "لا أستطيع اعتبار طلبك مدفوعًا أو تأكيده بناءً على قولك. الدفع الإلكتروني يُسجَّل فقط بحدث موثّق من مزوّد الدفع، والدفع النقدي يتم بينك وبين البائع خارج جاسم. لم يتغير شيء في طلبك."
          : "لا أستطيع تغيير رصيدك أو اعتبار الدفع تمّ أو تفعيل ظهور ممول دون دفع. الرصيد يتغير فقط بشحن يؤكده مزوّد الدفع، وكل منتج يُفعّل بعد مراجعتك وتأكيدك. لم يتغير شيء.",
        market,
      );
    // Payment never ranks people (Block E firewall).
    if (P.employment.test(text))
      return notice(actorId, "لا يمكن شراء ترتيب أو ظهور ممول في التوظيف: ترتيب المرشحين والطلبات لا يتأثر بأي دفع أو اشتراك. لم يتغير شيء.", market);
    // G1: usage and plan questions are deterministic and work even when AI usage is exhausted.
    // «لا، خل الاشتراك مثل ما هو» right after a plans card or plan review: the user keeps the plan.
  // Nothing was pending to cancel; DINAR says so without a model call, and no later «نعم» can act.
  if (latest && PLAN_VIEWS.includes(String(latest.view)) && !(latest.action && (latest.status ?? "PENDING") === "PENDING") && KEEP_PLAN.test(text))
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS" }, [], "تمام، يبقى اشتراكك كما هو. لم يتغير شيء ولم يُخصم أي مبلغ.", actorId, market);
  const usage = await aiUsageAndPlansTurn(text, actorId, market, latest);
    if (usage) return usage;
    if (!isPromotionFeatureEnabled()) return notice(actorId, "الخدمات التجارية غير مفعّلة في هذه البيئة. لم يتغير شيء.", market);
    return await commerceTurn(text, input, actorId, market, sets, latestSet, latest);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)
      return notice(actorId, `${error.message}. لم يتغير شيء.`, market);
    throw error;
  }
}

async function commerceTurn(
  text: string,
  input: CommerceTurnInput,
  actorId: string,
  market: Market,
  sets: StoredSet[],
  latestSet: StoredSet | undefined,
  latest: CommerceQuery | undefined,
): Promise<Turn | null> {
  // Decisions apply only to this adapter's own latest pending review.
  if (latest?.action && (latest.status ?? "PENDING") === "PENDING" && (CONFIRM.test(text) || CANCEL.test(text))) {
    const outcome = await applyCommerceAction({ actionId: latestSet!.id, actorId, market, decision: CONFIRM.test(text) ? "CONFIRM" : "CANCEL" });
    const state: CommerceQuery = { kind: "COMMERCE", ownerId: actorId, view: outcome.view ?? "COMMERCE_NOTICE", notice: outcome.message, ...(outcome.promotionId ? { promotionId: outcome.promotionId } : {}), ...(outcome.checkout ? { checkout: outcome.checkout } : {}), ...(outcome.promotionCheckout ? { promotionCheckout: outcome.promotionCheckout } : {}) };
    return turnFor(state, outcome.promotionId ? [outcome.promotionId] : [], outcome.message, actorId, market);
  }

  // Buyer: «ما عجبني شيء / في غيرهم؟» after organic results → paid demand options only.
  if (P.unsatisfied.test(text) && latestSet && !(latestSet.query as { kind?: unknown })?.kind) return unsatisfied(latestSet, actorId, market);

  if (P.businessCancel.test(text)) {
    const status = await getBusinessStatus(actorId, market);
    if (status.status !== "ACTIVE" && status.status !== "PAST_DUE") return notice(actorId, "لا يوجد اشتراك جاسم بزنس نشط لإلغائه.", market, "BUSINESS_STATUS");
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_STATUS", action: { type: "CANCEL_SUBSCRIPTION" }, status: "PENDING" }, [], "هل تريد إيقاف تجديد اشتراكك؟ تبقى مزاياه حتى نهاية الفترة المدفوعة. اكتب «نعم» أو «لا».", actorId, market);
  }
  if (P.businessStatus.test(text)) return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_STATUS" }, [], "حالة اشتراكك في جاسم بزنس.", actorId, market);
  if (P.business.test(text)) return businessReview(actorId, market);

  if (P.history.test(text)) return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "COMMERCIAL_LEDGER_SUMMARY" }, [], "سجل مدفوعاتك لخدمات جاسم التجارية (تجريبي، دون أموال حقيقية).", actorId, market);
  if (P.balance.test(text)) {
    const balance = await getCommercialBalance(actorId, market);
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "COMMERCIAL_BALANCE" }, [], `رصيدك التجاري المتاح ${balance.availableLabel}${balance.reservedMinor ? `، ومحجوز للحملات ${balance.reservedLabel}` : ""}. ${balance.statement}`, actorId, market);
  }
  const topup = text.match(P.topup);
  if (topup) {
    if (!topup[1]) return notice(actorId, "كم تريد أن تشحن؟ مثل «اشحن 20 دينار». الرصيد للاستخدام في خدمات جاسم التجارية فقط.", market);
    const amountMinor = await topupAmountMinor(market, Number(topup[1]));
    return turnFor(
      { kind: "COMMERCE", ownerId: actorId, view: "COMMERCIAL_TOPUP_REVIEW", action: { type: "TOPUP", amountMinor }, status: "PENDING" },
      [],
      `راجع الشحن: ${formatMinorAmount(amountMinor, market.minorUnitScale, market.currencyCode)} إلى رصيدك التجاري (دفع تجريبي TEST_NO_TRANSFER). لن يُضاف شيء قبل تأكيد موثّق من مزوّد الدفع. اكتب «تأكيد» أو «إلغاء».`,
      actorId,
      market,
    );
  }
  if (P.bundleStatus.test(text)) return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUNDLE_STATUS" }, [], "وحدات باقاتك المتبقية.", actorId, market);
  if (P.analytics.test(text)) return analytics(actorId, market, latest, latestSet);

  // Follow-ups inside this adapter's own latest step.
  if (latest?.view === "PROMOTION_TYPE_OPTIONS" && latest.step === "LISTING" && latest.productType && latestSet) {
    const index = ordinalIn(text);
    if (index !== undefined) return chooseProduct(latest.productType, latestSet.resourceIds[index], actorId, market);
  }
  if (latest?.view === "PROMOTION_TYPE_OPTIONS" && latest.step === "LISTING" && !latest.productType && latestSet) {
    const index = ordinalIn(text);
    if (index !== undefined) return promotionOptionsForListing(latestSet.resourceIds[index], actorId, market);
  }
  if (latest?.view === "PROMOTION_TYPE_OPTIONS" && latest.step === "PRODUCT" && latest.listingId && latestSet) {
    const index = ordinalIn(text);
    if (index !== undefined && latestSet.resourceIds[index])
      return productPicked(latestSet.resourceIds[index]!, latest.listingId, actorId, market);
  }
  if (latest?.view === "COMMERCIAL_PRODUCTS" && latestSet) {
    const index = ordinalIn(text);
    if (index !== undefined && latestSet.resourceIds[index]) return productPicked(latestSet.resourceIds[index]!, latest.listingId, actorId, market);
  }
  if (latest?.view === "PROMOTION_TYPE_OPTIONS" && latest.step === "BUDGET" && latest.productId) {
    const budget = text.match(BUDGET);
    if (budget) {
      const minor = majorToMinor(Number(budget[1] ?? budget[2]), market.minorUnitScale);
      return purchaseReview(latest.productId, latest.listingId, actorId, market, minor);
    }
  }
  if (latest?.view === "MARKET_PULSE" && latest.pulse && latestSet) {
    const index = ordinalIn(text);
    if (P.sellForNeed.test(text) || (index !== undefined && /بع|بيع/u.test(text))) {
      const insight = await pulseInsightAt(latest, index ?? 0, actorId, market);
      if (!insight) return notice(actorId, "اختر فرصة ظاهرة في القائمة.", market);
      // A normal SELL flow with a suggested title; the seller confirms every fact.
      return { ...(await notice(actorId, "", market)), redirectMessage: `أريد أبيع ${insight.title}` };
    }
    if (P.demand.test(text)) {
      const insight = await pulseInsightAt(latest, index ?? 0, actorId, market);
      if (insight) return startProduct("DEMAND_CAPTURE", input.message, actorId, market, sets, insight.title);
    }
  }

  // Seller products.
  const semanticPromotion = promotionIntent(input.message);
  if (semanticPromotion?.kind === "ACTION") {
    if (semanticPromotion.productType === "PROMOTION_ENTRY") return promotionEntry(actorId, market);
    if (semanticPromotion.productType) return startProduct(semanticPromotion.productType, input.message, actorId, market, sets);
  }
  if (P.promoteEntry.test(text)) return promotionEntry(actorId, market);
  if (P.demand.test(text)) return startProduct("DEMAND_CAPTURE", input.message, actorId, market, sets);
  if (P.vip.test(text)) return startProduct("VIP_LISTING", input.message, actorId, market, sets);
  if (P.refresh.test(text)) return startProduct("REFRESH_LISTING", input.message, actorId, market, sets);
  if (P.featured.test(text)) return startProduct("FEATURED_LISTING", input.message, actorId, market, sets);
  if (P.sponsoredRecommendation.test(text)) return startProduct("SPONSORED_RECOMMENDATION", input.message, actorId, market, sets);
  if (P.sponsoredSearchIntent.test(text)) return startProduct("SPONSORED_SEARCH", input.message, actorId, market, sets);
  if (P.sponsoredSearch.test(text)) {
    if (!(await commercialProducts(market, { productTypes: ["SPONSORED_SEARCH"] })).length) return null; // the Block E plan path answers «ممول».
    return startProduct("SPONSORED_SEARCH", input.message, actorId, market, sets);
  }
  if (P.bundle.test(text)) {
    const bundles = await commercialProducts(market, { productTypes: ["PROMOTION_BUNDLE"] });
    if (!bundles.length) return notice(actorId, "لا توجد باقات إعلانات مفعّلة في سوقك حاليًا.", market);
    if (bundles.length === 1) return purchaseReview(bundles[0]!.id, undefined, actorId, market);
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "COMMERCIAL_PRODUCTS", productType: "PROMOTION_BUNDLE" }, bundles.map((item) => item.id), "اختر باقة (مثل «الثانية»). الأسعار والمحتوى من إدارة السوق، وتظهر قبل أي تأكيد.", actorId, market);
  }
  if (isMarketPulseQuestion(text) || (latest?.view === "MARKET_PULSE" && /(?:24|7|30)\s*(?:ساعه|يوم|ايام)|الاسبوع|الشهر|اليوم/u.test(text))) return pulse(text, input.message, actorId, market, latest);
  if (latest?.step) return null;
  return null;
}

const LISTING_PROMOTION_TYPES = [
  "FEATURED_LISTING",
  "VIP_LISTING",
  "REFRESH_LISTING",
  "SPONSORED_SEARCH",
  "SPONSORED_RECOMMENDATION",
  "DEMAND_CAPTURE",
] as const;

async function promotionEntry(actorId: string, market: Market): Promise<Turn | null> {
  const owned = await promotableListings(actorId, market);
  const listings = [];
  for (const listing of owned) {
    if ((await commercialProducts(market, { productTypes: [...LISTING_PROMOTION_TYPES], categoryId: listing.categoryId })).length)
      listings.push(listing);
  }
  // Preserve the older standard-plan conversational flow when no V3 listing
  // promotion products are configured in this market.
  if (!listings.length) return null;
  if (listings.length === 1) return promotionOptionsForListing(listings[0]!.id, actorId, market);
  return turnFor(
    { kind: "COMMERCE", ownerId: actorId, view: "PROMOTION_TYPE_OPTIONS", step: "LISTING" },
    listings.map((listing) => listing.id),
    "اختر إعلانك أولًا لعرض خيارات الترويج المتاحة له في سوقك.",
    actorId,
    market,
  );
}

async function promotionOptionsForListing(listingId: string | undefined, actorId: string, market: Market): Promise<Turn> {
  const listing = listingId && (await promotableListings(actorId, market)).find((item) => item.id === listingId);
  if (!listing) return notice(actorId, "هذا الإعلان غير مؤهل أو ليس لك. لم يتغير شيء.", market);
  const products = await commercialProducts(market, { productTypes: [...LISTING_PROMOTION_TYPES], categoryId: listing.categoryId });
  return turnFor(
    { kind: "COMMERCE", ownerId: actorId, view: "PROMOTION_TYPE_OPTIONS", step: "PRODUCT", listingId: listing.id },
    products.map((product) => product.id),
    products.length ? `خيارات الترويج المتاحة لإعلان «${listing.title}» في سوقك. اختر خيارًا لمراجعة تفاصيله.` : "لا توجد خيارات ترويج متاحة لهذا الإعلان في سوقك حاليًا.",
    actorId,
    market,
  );
}

// ─── Buyer: explicit dissatisfaction ─────────────────────────────────────────

async function unsatisfied(set: StoredSet, actorId: string, market: Market): Promise<Turn> {
  const need = needFromSearch(market, set.query as Record<string, unknown>);
  if (need) await markLatestNeedUnsatisfied({ market, userId: actorId, needKey: need.needKey });
  const rescue = need ? await demandOptions(market, need, { excludeIds: set.resourceIds, viewerUserId: actorId }) : { listings: [], sponsoredCampaigns: {} };
  const query = set.query as Record<string, unknown>;
  const sponsoredIds = rescue.listings.map((listing) => listing.id);
  return {
    tool: "searchListings",
    version: 1,
    result: {
      kind: "SEARCH",
      query: {
        search: typeof query.search === "string" ? query.search : "",
        category: null,
        categoryId: typeof query.categoryId === "string" ? query.categoryId : null,
        filters: Array.isArray(query.filters) ? query.filters : [],
        ...(sponsoredIds.length ? { sponsoredIds, sponsoredCampaigns: rescue.sponsoredCampaigns } : {}),
        demandRescue: "USER_UNSATISFIED",
        buyer: {
          message: rescue.listings.length
            ? `فهمت أن النتائج لم تناسبك. لا توجد نتائج عادية أخرى بالشروط نفسها، وهذه ${rescue.listings.length === 1 ? "خيار ممول" : "خيارات ممولة"} تطابق طلبك (شارة «ممول»؛ ليست توصية من جاسم).`
            : "فهمت أن النتائج لم تناسبك. لا توجد خيارات أخرى مطابقة حاليًا؛ يمكنك تعديل الشروط أو توسيع البحث.",
        },
      },
      listings: rescue.listings,
    },
  };
}

// ─── Seller product flows ────────────────────────────────────────────────────

async function startProduct(productType: string, message: string, actorId: string, market: Market, sets: StoredSet[], needTitle?: string): Promise<Turn | null> {
  const listings = (await promotableListings(actorId, market));
  // «جاسم روح بيع لي تلفوني» from a seller with nothing published yet names a new item: that is a
  // sale to start (the listing draft takes it), not the paid «روح بيع لي» product, which needs a listing.
  if (!listings.length && productType === "DEMAND_CAPTURE" && !needTitle) {
    const named = normalize(message).replace(P.demand, " ").replace(/(?:^|\s)(?:جاسم|دينار|لي|هذا|هذي|هذه|هاد|اياه|اياها|الحين|الان|بسرعه)(?=\s|$)/gu, " ").trim();
    if (named.length >= 2) return null;
  }
  if (!listings.length) return notice(actorId, "لا توجد لديك إعلانات منشورة مؤهلة في سوقك الحالي. أنشئ إعلانًا أولًا (مثل «أريد أبيع …»).", market);
  const text = normalize(message);
  const index = ordinalIn(text.replace(/\d+(?:\.\d+)?\s*(?:دينار|دنانير|jod|kwd)/u, ""));
  // Ordinals and «هذا» refer to the seller's own latest listing list; names to own titles.
  const context = sets.find((set) => {
    const kind = (set.query as { kind?: unknown })?.kind;
    const state = parseState(set, actorId);
    return (state?.view === "PROMOTION_TYPE_OPTIONS" && state.step === "LISTING") || kind === "SELLER_CONTEXT" || (kind === "PROMOTION" && (set.query as { ownerId?: unknown }).ownerId === actorId);
  });
  let listingId: string | undefined;
  if (index !== undefined && context) listingId = context.resourceIds[index];
  else if (/(?:^|\s)(?:هذا|هذه|هذي|هاد)(?:\s|$)/u.test(text) && context?.resourceIds.length === 1) listingId = context.resourceIds[0];
  const wanted = needTitle ? needTokens(needTitle) : needTokens(text.replace(P.demand, " ").replace(P.vip, " ").replace(/(?:خل|خلي|اجعل|ارفع|جدد|ميز|اعلان|الاعلان|مميز|ممول|في البحث)/gu, " "));
  if (!listingId && wanted.length) {
    const matches = listings.filter((item) => needCoverage(wanted, item.title) >= 0.5);
    if (matches.length === 1) listingId = matches[0]!.id;
    else if (matches.length > 1) return listingPicker(productType, matches.map((item) => item.id), actorId, market, `لديك ${matches.length} إعلانات تطابق. اختر الإعلان (مثل «الثاني»).`);
  }
  if (!listingId && listings.length === 1) listingId = listings[0]!.id;
  if (!listingId) return listingPicker(productType, listings.map((item) => item.id), actorId, market);
  if (!listings.some((item) => item.id === listingId)) return listingPicker(productType, listings.map((item) => item.id), actorId, market, "هذا الإعلان غير مؤهل أو ليس لك. اختر من إعلاناتك المؤهلة.");
  const budget = normalize(message).match(BUDGET);
  return chooseProduct(productType, listingId, actorId, market, budget ? majorToMinor(Number(budget[1] ?? budget[2]), market.minorUnitScale) : undefined);
}

function listingPicker(productType: string, ids: string[], actorId: string, market: Market, prompt?: string) {
  return turnFor(
    { kind: "COMMERCE", ownerId: actorId, view: "PROMOTION_TYPE_OPTIONS", step: "LISTING", productType },
    ids,
    prompt ?? "اختر الإعلان (مثل «الثاني»). تظهر هنا إعلاناتك المنشورة والمؤهلة في سوقك الحالي فقط.",
    actorId,
    market,
  );
}

async function chooseProduct(productType: string, listingId: string | undefined, actorId: string, market: Market, budgetMinor?: number): Promise<Turn> {
  if (!listingId) return notice(actorId, "اختر رقمًا ظاهرًا في قائمة إعلاناتك.", market);
  const owned = (await promotableListings(actorId, market)).find((item) => item.id === listingId);
  if (!owned) return notice(actorId, "هذا الإعلان غير مؤهل أو ليس لك. لم يتغير شيء.", market);
  const products = await commercialProducts(market, { productTypes: [productType], categoryId: owned.categoryId });
  const label = { FEATURED_LISTING: "الإعلان المميز", VIP_LISTING: "VIP", REFRESH_LISTING: "تجديد الإعلان", DEMAND_CAPTURE: "جاسم روح بيع لي", SPONSORED_SEARCH: "الظهور الممول في البحث", SPONSORED_RECOMMENDATION: "الاقتراح الممول" }[productType] ?? productType;
  if (!products.length) return notice(actorId, `لا يوجد منتج «${label}» مفعّل لفئة «${owned.title}» في سوقك حاليًا.`, market);
  if (products.length > 1)
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "COMMERCIAL_PRODUCTS", productType, listingId }, products.map((item) => item.id), `اختر خيار «${label}» لإعلان «${owned.title}» (مثل «الأول»).`, actorId, market);
  return productPicked(products[0]!.id, listingId, actorId, market, budgetMinor);
}

async function productPicked(productId: string, listingId: string | undefined, actorId: string, market: Market, budgetMinor?: number): Promise<Turn> {
  const product = (await commercialProducts(market, {})).find((item) => item.id === productId);
  if (!product) return notice(actorId, "هذا المنتج لم يعد متاحًا.", market);
  if (product.chargingMode === "PREPAID_BUDGET" && budgetMinor === undefined) {
    const view = commercialProductView(product, market);
    return turnFor(
      { kind: "COMMERCE", ownerId: actorId, view: "PROMOTION_TYPE_OPTIONS", step: "BUDGET", productType: product.productType, productId, ...(listingId ? { listingId } : {}) },
      listingId ? [listingId] : [],
      `${product.productType === "DEMAND_CAPTURE" ? `${DEMAND_CAPTURE_PITCH} ` : ""}كم ميزانيتك للحملة؟ بين ${view.minBudgetLabel} و${view.maxBudgetLabel ?? view.minBudgetLabel}، ويُخصم ${view.unitChargeLabel} لكل تفاعل مؤهل. مثل «ميزانيتي 20».`,
      actorId,
      market,
    );
  }
  return purchaseReview(productId, listingId, actorId, market, budgetMinor);
}

async function purchaseReview(productId: string, listingId: string | undefined, actorId: string, market: Market, budgetMinor?: number): Promise<Turn> {
  const review = await reviewCommercialPurchase({ actorId, market, productId, listingId, budgetMinor });
  const view = REVIEW_SURFACE[review.product.productType] ?? "COMMERCIAL_PRODUCT_REVIEW";
  if (review.failureCode && review.failureCode !== "INSUFFICIENT_BALANCE")
    return notice(actorId, `${review.failure}. لم يتغير شيء.`, market);
  const state: CommerceQuery = {
    kind: "COMMERCE",
    ownerId: actorId,
    view,
    productType: review.product.productType,
    ...(listingId ? { listingId } : {}),
    action: { type: "PURCHASE", productId, ...(listingId ? { listingId } : {}), ...(review.budgetMinor ? { budgetMinor: review.budgetMinor } : {}), paymentSource: review.paymentSource },
    status: "PENDING",
  };
  const what = `${review.product.productTypeLabel}${review.listing ? ` لإعلان «${review.listing.title}»` : ""}`;
  // Jassim Ads Phase 2: a direct fixed-price product is paid through the registered provider, never from the test balance.
  const direct = await providerDirectApplies({ market, productId, paymentSource: review.paymentSource });
  if (direct.applies) {
    const providerPrompt = `راجع ${what} بسعر ${review.amountLabel}، يُدفع عبر صفحة ${direct.provider.displayName} الآمنة. عند «تأكيد» تُفتح صفحة الدفع فقط؛ لا يبدأ الترويج قبل تأكيد ${direct.provider.displayName} الموقّع. اكتب «تأكيد» أو «إلغاء».`;
    return turnFor(state, listingId ? [listingId] : [productId], providerPrompt, actorId, market);
  }
  const pay = review.paymentSource === "BUNDLE_ENTITLEMENT" ? "باستخدام وحدة من باقتك (دون خصم من الرصيد)" : review.budgetLabel ? `بحجز ميزانية ${review.budgetLabel} من رصيدك` : `بسعر ${review.amountLabel} من رصيدك`;
  const prompt = review.sufficient
    ? `راجع ${what} ${pay}. رصيدك بعد التأكيد ${review.balanceAfterLabel}. لن يُفعّل شيء قبل تأكيدك؛ اكتب «تأكيد» أو «إلغاء».`
    : `رصيدك التجاري غير كافٍ لـ${what}: تحتاج إلى شحن ${review.missingLabel} إضافية. قل «اشحن ${review.missingLabel?.split(" ")[0]}» ثم أعد الطلب. لم يتغير شيء.`;
  if (!review.sufficient) return turnFor({ ...state, action: undefined, status: undefined, notice: prompt }, listingId ? [listingId] : [], prompt, actorId, market);
  return turnFor(state, listingId ? [listingId] : [productId], prompt, actorId, market);
}

async function businessReview(actorId: string, market: Market, planId?: string, billingNote = ""): Promise<Turn> {
  const plans = await businessPlans(market);
  const status = await getBusinessStatus(actorId, market);
  if (status.status === "ACTIVE" || status.status === "CANCEL_AT_PERIOD_END")
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_STATUS" }, [], planId ? "لديك اشتراك جاسم بزنس قائم. تغيير الباقة أثناء الفترة غير متاح بعد لأنه لا توجد قواعد احتساب تناسبي معتمدة؛ يمكنك الاشتراك في الباقة الأخرى بعد انتهاء فترتك. لم يتغير شيء." : "لديك اشتراك جاسم بزنس قائم.", actorId, market);
  if (!plans.length) return notice(actorId, "لا توجد خطة جاسم بزنس مفعّلة في سوقك حاليًا. الحساب المجاني يكفي للبيع والشراء وشراء الإعلانات.", market, "BUSINESS_STATUS");
  const plan = plans.find((item) => item.id === planId) ?? plans[0]!;
  if (subscriptionBillingStatus().connected)
    return turnFor(
      { kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_PLAN_REVIEW", action: { type: "SUBSCRIBE", planId: plan.id }, status: "PENDING" },
      [plan.id],
      `راجع «${plan.name}»: ${plan.priceLabel} لكل ${plan.durationDays} يومًا، يُدفع عبر Whop ويتجدد في نهاية كل فترة حتى تلغيه من هنا. ${SUBSCRIPTION_TAX_NOTE} يضيف أدوات أو سعة استخدام فقط ولا يغيّر ترتيب نتائج البحث. اكتب «تأكيد» لفتح صفحة الدفع أو «إلغاء».`,
      actorId,
      market,
    );
  const review = await reviewBusinessSubscription({ actorId, market, planId: plan.id });
  if (!review.sufficient)
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_PLAN_REVIEW", notice: `تحتاج إلى شحن ${review.missingLabel} إضافية للاشتراك.` }, [plan.id], `«${plan.name}» بسعر ${plan.priceLabel} لكل ${plan.durationDays} يومًا. رصيدك غير كافٍ: تحتاج إلى شحن ${review.missingLabel}. لم يتغير شيء.`, actorId, market);
  return turnFor(
    { kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_PLAN_REVIEW", action: { type: "SUBSCRIBE", planId: plan.id }, status: "PENDING" },
    [plan.id],
    `راجع «${plan.name}»: ${plan.priceLabel} لمدة ${plan.durationDays} يومًا من رصيدك التجاري، دون تجديد تلقائي. يضيف أدوات أو سعة استخدام فقط ولا يغيّر ترتيب نتائج البحث.${billingNote ? ` ${billingNote}` : ""} اكتب «تأكيد» أو «إلغاء».`,
    actorId,
    market,
  );
}

const PLAN_VIEWS = ["AI_PLANS", "BUSINESS_PLAN_REVIEW"];
/** «لا، خل الاشتراك مثل ما هو», «خليه زي ما هو», «لا ما أبي أغير»: keep the current plan. */
const KEEP_PLAN = /^(?:(?:لا|لأ)\s+)?(?:(?:خل|خلي|خليه|خليها|خله|خلها|اترك|اتركه|ابق|ابقي)\s+(?:ال)?(?:اشتراك|باقه|خطه)?\S*\s*(?:مثل|زي|كما|متل)\s+(?:ما\s+)?(?:هو|هي|كان|كانت)|ما\s+(?:ابي|اريد|بدي|ابغي|ابغى)\s+(?:اغير|اشترك|ارقي|ترقيه)\S*|لا\s+شكرا|لا)$/u;
const WANTS_TIER_CHANGE = /(?:^|\s)(?:اشترك|اشتراك\s+في|ترقي|ارقي|رقي|رق|فعل|حولني|انقلني|غير|حول|بدل)/u;
/**
 * «غير اشتراكي للخطة الأعلى», «رقني للباقة الأكبر»: a tier named relative to the user's own
 * current tier. It is resolved against the real plans card, never guessed.
 */
const RELATIVE_TIER = /(?:^|\s)(?:(?:الي|الى)\s+)?(?:لل|ال|ل)?(?:خطه|باقه|اشتراك)\s+(?:ال)?(?:اعلي|اعلى|اكبر|احسن|اقوى|اقوي|الي\s+بعدها|التاليه)(?:\s|$)/u;
const PLAN_OBJECT = /(?:اشتراكي|باقتي|خطتي|حسابي|اشتراك|باقه|خطه)/u;
const ASKS_TIER_PRICE = /(?:^|\s)(?:سعر|كم|بكم|الفرق|فرق)(?:\s|$)/u;
/** «أريد Go», «أبي برو»: wanting a named tier is asking for it. */
const WANTS_NAMED_TIER = /^(?:اريد|ابي|ابغي|ابغى|بدي|ودي|حاب)\s+(?:باقه\s+)?(?:go|pro|جو|برو)$/u;

/**
 * «كم باقي من حصتي؟», «اعرض الباقات», «كم سعر برو؟», «أريد ترقية حسابي». Cards are rebuilt
 * from the usage ledger, the policy and the catalog; a tier change only opens the existing
 * Business review, which in turn needs the billing authority (simulation in development).
 */
/**
 * «هل يكفيني حتى نهاية الأسبوع؟»: an estimate from this period's actual pace (usage-turn.ts
 * usageProjection), or an explicit statement that there is not enough data. Never invented.
 */
async function usageSufficiencyNote(actorId: string, market: Market, horizonDays?: number): Promise<string> {
  const summary = await aiUsageSummary({ kind: "USER", userId: actorId, market: market as never });
  const text = summary.resources.find((item) => item.resource === "TEXT_REQUEST");
  if (!text) return "";
  const until = horizonDays ? new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000) : undefined;
  const projection = usageProjection(text, summary.period, new Date(), until);
  const span = horizonDays === 7 ? "حتى نهاية الأسبوع" : horizonDays === 1 ? "حتى نهاية اليوم" : "حتى تجدد الحصة";
  if (projection.kind === "INSUFFICIENT_DATA")
    return `لا تتوفر بيانات استخدام كافية في هذه الفترة لتقدير ما إذا كانت حصتك تكفي ${span}؛ لم أخمّن رقمًا.\n`;
  return projection.likelyToRunOut
    ? `تقديريًا، وبوتيرة استخدامك الحالية (آخر ${projection.basisHours} ساعة)، قد تصل إلى حوالي ${projection.projectedUseAtEnd} طلبًا ${span}، وهذا يتجاوز حدك البالغ ${text.limit}. هذا تقدير وليس حدًا مضمونًا.\n`
    : `تقديريًا، وبوتيرة استخدامك الحالية (آخر ${projection.basisHours} ساعة)، ستستخدم حوالي ${projection.projectedUseAtEnd} من ${text.limit} طلبًا ${span}، فيُتوقع أن تكفيك. هذا تقدير وليس ضمانًا.\n`;
}

/** The AI usage card exactly as the deterministic route builds it; shared with the model's usage read. */
export async function aiUsageCardTurn(actorId: string, market: Market, question: "SUMMARY" | "RENEWAL" | "WHY_STOPPED" = "SUMMARY"): Promise<Turn> {
  const view = await usageCardView(actorId, market);
  return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_USAGE", usageQuestion: question }, [], usageCardPrompt(view, question), actorId, market);
}

async function aiUsageAndPlansTurn(text: string, actorId: string, market: Market, latest: CommerceQuery | undefined): Promise<Turn | null> {
  if (P.aiUsage.test(text)) {
    const question = /تتجدد|يتجدد|تنتجدد/u.test(text) ? "RENEWAL" : /(?:وقف|توقف|يوقف|ما\s+يرد|ما\s+يشتغل)/u.test(text) ? "WHY_STOPPED" : "SUMMARY";
    const view = await usageCardView(actorId, market);
    const sufficiency = /(?:يكفي|يكفيني|بيكفي|بيكفيني|يوصلني|يكمل\s+معي|يلحقني)/u.test(text)
      ? await usageSufficiencyNote(actorId, market, /(?:اسبوع|الاسبوع)/u.test(text) ? 7 : /(?:اليوم|لاخر\s+اليوم|نهايه\s+اليوم)/u.test(text) ? 1 : undefined)
      : "";
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_USAGE", usageQuestion: question }, [], `${sufficiency}${usageCardPrompt(view, question)}`, actorId, market);
  }
  const publicPlans = await publicPlansTurn(text, actorId, market);
  if (publicPlans) return publicPlans;
  let named: "BUSINESS_GO" | "BUSINESS_PRO" | undefined = P.aiPlanTier.test(text) ? (/(?:^|\s)(?:pro|برو)(?:\s|$)/u.test(text) ? "BUSINESS_PRO" : "BUSINESS_GO") : undefined;
  if (!named && RELATIVE_TIER.test(text) && PLAN_OBJECT.test(text) && WANTS_TIER_CHANGE.test(text)) {
    const order = ["FREE", "BUSINESS_GO", "BUSINESS_PRO"] as const;
    const current = (await plansCardView(actorId, market)).currentTier;
    const next = order[Math.max(0, order.indexOf(current as (typeof order)[number])) + 1] as "BUSINESS_GO" | "BUSINESS_PRO" | undefined;
    if (!next)
      return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS" }, [], "أنت على أعلى باقة متاحة بالفعل. لم يتغير شيء.", actorId, market);
    named = next;
  }
  // «اشترك» right after the plans card picks a tier from that card.
  const afterPlans = latest?.view === "AI_PLANS";
  if (!named && !P.aiPlans.test(text) && !(afterPlans && WANTS_TIER_CHANGE.test(text))) return null;
  const view = await plansCardView(actorId, market);
  const wantsChange = (WANTS_TIER_CHANGE.test(text) || (Boolean(named) && WANTS_NAMED_TIER.test(text))) && !ASKS_TIER_PRICE.test(text);
  if (named && (wantsChange || (RELATIVE_TIER.test(text) && WANTS_TIER_CHANGE.test(text)))) {
    const tier = view.tiers.find((item) => item.tier === named)!;
    const order = ["FREE", "BUSINESS_GO", "BUSINESS_PRO"];
    if (view.currentTier === named)
      return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", planFocus: named }, [], `باقتك الحالية هي ${tier.label} بالفعل. لم يتغير شيء.`, actorId, market);
    if (order.indexOf(view.currentTier) > order.indexOf(named))
      return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", planFocus: named }, [], `باقتك الحالية أعلى من ${tier.label}. لا يوجد تخفيض أثناء الفترة؛ تعود حصتك تلقائيًا إلى ما يناسب اشتراكك عند انتهائه. لم يتغير شيء.`, actorId, market);
    if (!tier.priceConfigured || !tier.planId)
      return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", planFocus: named }, [], `لم يُعتمد سعر ${tier.label} بعد في سوقك، لذلك لا يمكن الاشتراك فيها الآن. لم يتغير شيء ولم يُخصم أي مبلغ.`, actorId, market);
    if (!view.billing.simulationAvailable)
      return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", planFocus: named }, [], `${view.billing.note} لم يتغير شيء.`, actorId, market);
    return businessReview(actorId, market, tier.planId, "الفوترة الحقيقية غير متصلة؛ هذا تفعيل تجريبي من رصيد تجريبي (TEST_NO_TRANSFER) دون تحويل أموال.");
  }
  const prompt = wantsChange && !named
    ? `${plansCardPrompt(view)}\nأي باقة تريد؟ قل «اشترك في Go» أو «اشترك في Pro». لن يتغير شيء قبل مراجعتك وتأكيدك.`
    : plansCardPrompt(view, named && ASKS_TIER_PRICE.test(text) ? named : undefined);
  return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", ...(named ? { planFocus: named } : {}) }, [], prompt, actorId, market);
}

// ─── D2: DINAR Business onboarding (conversation) ────────────────────────────

const BUSINESS_ACTION_LABELS: Record<string, { label: string; message?: string; kind: "SEND" | "FORM" | "UPLOAD" | "PUBLISH" }> = {
  COMPLETE_INFO: { label: "أكمل بيانات النشاط", kind: "FORM" },
  START_VERIFICATION: { label: "ارفع المستندات المطلوبة", message: "أبي أرفع السجل التجاري", kind: "SEND" },
  UPLOAD_DOCUMENTS: { label: "ارفع المستند", kind: "UPLOAD" },
  SUBMIT_FOR_REVIEW: { label: "أرسل الطلب للتحقق", message: "أرسل طلب التوثيق", kind: "SEND" },
  VIEW_STATUS: { label: "حالة التحقق", message: "حالة توثيق نشاطي", kind: "SEND" },
  ADD_CATALOG: { label: "أضف قائمة أو منتجات", message: "أريد أن أبيع", kind: "SEND" },
  REVIEW_PLANS: { label: "خطط جاسم", message: "ما الفرق بين جو وبرو وبزنس", kind: "SEND" },
  PUBLISH: { label: "انشر صفحة النشاط", kind: "PUBLISH" },
  UNPUBLISH: { label: "أوقف نشر الصفحة", kind: "PUBLISH" },
  CONNECT_SYSTEM: { label: "ربط نظامك الحالي", message: "أريد ربط مطعمي بنظامي الحالي", kind: "SEND" },
};

/** The DINAR Business card: a projection of the owner's view; actions derive from server state only. */
function businessCard(view: BusinessOwnerView, focus: NonNullable<CommerceQuery["businessFocus"]>) {
  return {
    brand: "DINAR BUSINESS",
    id: view.id,
    focus,
    displayName: view.displayName,
    legalName: view.legalName,
    legalFormLabel: view.legalFormLabel,
    marketId: view.marketId,
    marketLabel: MARKET_LABELS[view.marketId] ?? view.marketId,
    categoryLabel: view.categoryLabel,
    city: view.address.city ?? null,
    registrationNumberLast4: view.registrationNumberLast4,
    status: view.verificationStatus,
    statusLabel: view.verificationStatus === "PENDING_REVIEW" ? "بانتظار التحقق" : view.statusLabel,
    verified: view.verified,
    publicationStatus: view.publicationStatus,
    revision: view.revision,
    missingInfo: view.missingInfo,
    requirements: view.requirements.map((group) => ({ labels: group.labels, kinds: group.anyOf, satisfied: group.satisfied })),
    documents: view.documents.map((doc) => ({ id: doc.id, kindLabel: doc.kindLabel, status: doc.status, scanStatus: doc.scanStatus, scanLabel: doc.scanStatus === "CLEAN" ? "فُحص وسليم" : doc.scanStatus === "INFECTED" ? "رُفض لأسباب أمنية" : "في الحجر حتى يُفحص" })),
    actions: view.actions.map((key) => ({ key, ...BUSINESS_ACTION_LABELS[key]! })),
    listingCount: view.listingCount,
    salesNote: view.listingCount ? `لديك ${view.listingCount} إعلان في هذا السوق.` : "لا توجد مبيعات أو إعلانات سابقة لهذا النشاط في جاسم بعد.",
    lastDecisionReason: view.lastDecisionReason ?? null,
    readiness: view.verification,
    ...(focus === "CONNECT" ? { integrations: view.integrations } : {}),
    privacyNote: "مستندات التحقق خاصة: لا تظهر في الإعلانات ولا للمشترين ولا تُرسل إلى نموذج الذكاء الاصطناعي؛ يراها مراجع جاسم فقط بعد فحصها.",
    honestyNote: view.verified ? null : "هذه بيانات قدّمتها أنت ولم يوثّقها جاسم بعد.",
  };
}

const MARKET_LABELS: Record<string, string> = { KW: "الكويت", JO: "الأردن", SA: "السعودية" };

function businessStatusPrompt(view: BusinessOwnerView): string {
  const name = `«${view.displayName}»`;
  switch (view.verificationStatus) {
    case "DRAFT":
      return `${name} مسودة لم تُرسل للتحقق بعد. ${view.missingInfo.length ? `أحتاج منك: ${view.missingInfo.join(" و")}. ` : ""}قل «أبي أرفع السجل التجاري» لبدء التحقق.`;
    case "DOCUMENTS_REQUIRED": {
      const unmet = view.requirements.filter((group) => !group.satisfied).map((group) => group.labels.join(" أو "));
      return `${name} بانتظار مستنداتك${unmet.length ? `: ينقص ${unmet.join("، ")}` : ""}${view.missingInfo.length ? `، وأحتاج ${view.missingInfo.join(" و")}` : ""}. ${!unmet.length && !view.missingInfo.length ? "كل المطلوب موجود؛ قل «أرسل طلب التوثيق»." : ""}`.trim();
    }
    case "PENDING_REVIEW":
      return `طلب توثيق ${name} بانتظار مراجع جاسم. لم يُوثَّق بعد.${view.verification.scanner === "NOT_CONNECTED" ? " تنبيه: فحص المستندات غير موصول بعد، لذلك لا يمكن إكمال التوثيق الآن؛ طلبك محفوظ." : ""}`;
    case "VERIFIED":
      return `${name} نشاط موثّق من مراجع جاسم.${view.publicationStatus === "PUBLISHED" ? " صفحته منشورة." : " صفحته غير منشورة بعد."}`;
    case "REJECTED":
      return `طلب ${name} مرفوض${view.lastDecisionReason ? `: ${view.lastDecisionReason}` : ""}. يمكنك تقديم طلب جديد بالبيانات الصحيحة.`;
    case "SUSPENDED":
      return `${name} موقوف حاليًا${view.lastDecisionReason ? `: ${view.lastDecisionReason}` : ""}، ومزايا النشاط الموثّق متوقفة حتى تُراجع حالته.`;
    default:
      return `حالة ${name}: ${view.statusLabel}.`;
  }
}

async function businessTurn(actorId: string, market: Market, view: BusinessOwnerView, focus: NonNullable<CommerceQuery["businessFocus"]>, prompt: string, notice?: string) {
  return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_PROFILE", businessId: view.id, businessFocus: focus, ...(notice ? { notice } : {}) }, [view.id], prompt, actorId, market);
}

/** The business a follow-up refers to: the card in context, else the actor's only open one. */
async function businessInFocus(actorId: string, market: Market, latest: CommerceQuery | undefined): Promise<BusinessOwnerView | "AMBIGUOUS" | undefined> {
  if (latest?.view === "BUSINESS_PROFILE" && latest.businessId) {
    const view = await getOwnBusiness(actorId, market, latest.businessId).catch(() => undefined);
    if (view) return view;
  }
  const own = (await listOwnBusinesses(actorId, market)).filter((item) => item.verificationStatus !== "REJECTED");
  if (own.length === 1) return own[0];
  return own.length ? "AMBIGUOUS" : undefined;
}

const NO_BUSINESS = "لا يوجد لديك نشاط تجاري في جاسم في سوقك الحالي. قل مثلًا: «أنا صاحب مطعم اسمه …» مع اسم نشاطك، وأجهّز لك مسودة.";
const AMBIGUOUS_BUSINESS = "لديك أكثر من نشاط؛ افتح بطاقة النشاط المقصود أولًا بقول «اعرض نشاطي» ثم أعد الطلب.";

function errorText(error: unknown): string | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 && error instanceof Error ? error.message : undefined;
}

/**
 * D2.8: «أنا صاحب مطعم سمراء للمشاوي بالكويت», «أبي أرفع السجل التجاري», «وين وصل طلبي؟».
 * Deterministic, no model: the intent is read here, every write goes through lib/business-profiles
 * under the session's account, and the card is rebuilt from the server on every read.
 */
export async function executeBusinessOnboardingTurn(input: CommerceTurnInput): Promise<Turn | null> {
  if (!input.actorId) {
    const intent = businessIntent(input.message, false);
    if (intent?.kind !== "INTRODUCE") return null;
    return { tool: "openSurface", version: 1, result: { kind: "SURFACE", surface: "AUTH", query: {}, listings: [], prompt: "سجّل الدخول أولًا لإضافة نشاطك التجاري؛ يُنشأ النشاط باسم حسابك فقط." } };
  }
  // No database work for messages that cannot be a business request in any context.
  if (!isPossibleBusinessMessage(input.message)) return null;
  const actorId = input.actorId;
  const market = input.market;
  const sets = await conversationSets(input.conversationId, market.id);
  const latest = parseState(sets[0], actorId);
  const inContext = latest?.view === "BUSINESS_PROFILE";
  const intent: BusinessIntent | undefined = businessIntent(input.message, inContext);
  if (!intent) return null;
  const blank = (prompt: string) => turnFor({ kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_PROFILE", notice: prompt }, [], prompt, actorId, market);
  try {
    if (intent.kind === "INTRODUCE") {
      if (intent.marketId && intent.marketId !== market.id)
        return blank(`سوقك الحالي هو ${MARKET_LABELS[market.id] ?? market.id}، والنشاط يُسجَّل في سوق البلد الذي يعمل فيه (${MARKET_LABELS[intent.marketId] ?? intent.marketId}). بدّل سوقك ثم أعد الطلب. لم يُنشأ شيء.`);
      if (!intent.displayName) return blank(`ما اسم ${BUSINESS_CATEGORIES[intent.categoryKey] ?? "نشاطك"} كما تريده أن يظهر للناس؟ اكتب مثلًا: «مطعمي اسمه سمراء للمشاوي». لم يُنشأ شيء بعد.`);
      const idempotencyKey = `conv:${createHash("sha256").update(`${input.conversationId}:${normalizeBusinessText(intent.displayName)}`).digest("hex").slice(0, 40)}`;
      const { created, business } = await createBusinessDraft(actorId, market, { displayName: intent.displayName, categoryKey: intent.categoryKey, idempotencyKey });
      const next = business.missingInfo.length ? `للتحقق أحتاج: ${business.missingInfo.join(" و")}، ثم صورة ${documentRequirementLabel(business)}.` : `للتحقق أحتاج صورة ${documentRequirementLabel(business)}.`;
      const prompt = created
        ? `جهّزت مسودة «${business.displayName}» (${business.categoryLabel}) في سوق ${MARKET_LABELS[market.id] ?? market.id}. المسودة غير موثّقة ولا تظهر للناس بعد، ولا تحتاج اشتراكًا مدفوعًا. ${next}`
        : `لديك بالفعل نشاط «${business.displayName}» بحالة «${business.statusLabel}»؛ لم أنشئ نسخة ثانية. ${businessStatusPrompt(business)}`;
      return businessTurn(actorId, market, business, "OVERVIEW", prompt);
    }
    const focused = await businessInFocus(actorId, market, latest);
    if (!focused) return blank(NO_BUSINESS);
    if (focused === "AMBIGUOUS") return blank(AMBIGUOUS_BUSINESS);
    switch (intent.kind) {
      case "SHOW":
      case "STATUS":
        return businessTurn(actorId, market, focused, "STATUS", businessStatusPrompt(focused));
      case "UPLOAD_DOCUMENT": {
        let view = focused;
        if (view.verificationStatus === "DRAFT") view = await startBusinessVerification(actorId, market, view.id);
        if (view.verificationStatus !== "DOCUMENTS_REQUIRED") return businessTurn(actorId, market, view, "STATUS", `لا يحتاج طلبك مستندات الآن. ${businessStatusPrompt(view)}`);
        const label = DOCUMENT_KIND_LABELS[intent.documentKind];
        return businessTurn(
          actorId,
          market,
          view,
          "UPLOAD",
          `ارفع ${label} من زر «ارفع المستند» في البطاقة (PDF أو صورة JPEG/PNG حتى 10 ميغابايت). يُحفظ بشكل خاص لمراجع جاسم فقط، ولا يظهر في الإعلانات ولا يُرسل إلى نموذج الذكاء.${view.missingInfo.length ? ` وأحتاج أيضًا: ${view.missingInfo.join(" و")}.` : ""}`,
        );
      }
      case "INFO": {
        const view = await updateBusinessProfile(actorId, market, focused.id, {
          expectedRevision: focused.revision,
          ...(intent.legalName ? { legalName: intent.legalName } : {}),
          ...(intent.registrationNumber ? { registrationNumber: intent.registrationNumber } : {}),
          ...(intent.city ? { address: { city: intent.city } } : {}),
        });
        return businessTurn(actorId, market, view, "INFO", `حدّثت بيانات «${view.displayName}» كما كتبتها (غير موثّقة بعد). ${businessStatusPrompt(view)}`);
      }
      case "SUBMIT": {
        const view = await submitBusinessForReview(actorId, market, focused.id);
        return businessTurn(actorId, market, view, "STATUS", businessStatusPrompt(view));
      }
      case "CONNECT_SYSTEM":
        return businessTurn(
          actorId,
          market,
          focused,
          "CONNECT",
          focused.verified
            ? "يمكنك تسجيل طلب ربط بقراءة فقط (القائمة أو المخزون أو الطلبات) من البطاقة. لا يوجد موصّل جاهز لأي نظام حاليًا، ولم يُربط شيء. مفتاح مزوّد جاسم يسمح لنظامك بالإرسال إلى دينار فقط، ولا يمنح دينار دخولًا إلى نظامك."
            : "ربط نظامك متاح بعد توثيق النشاط. يمكنك الآن إضافة قائمتك أو منتجاتك داخل جاسم مباشرة دون أي نظام خارجي. لم يُربط شيء.",
        );
    }
  } catch (error) {
    const message = errorText(error);
    if (!message) throw error;
    const view = await businessInFocus(actorId, market, latest).catch(() => undefined);
    if (view && view !== "AMBIGUOUS") return businessTurn(actorId, market, view, "STATUS", `${message}. لم يتغير شيء.`, `${message}.`);
    return blank(`${message}. لم يتغير شيء.`);
  }
  return null;
}

function documentRequirementLabel(view: BusinessOwnerView) {
  return view.requirements.map((group) => group.labels.join(" أو ")).join(" و") || "السجل التجاري";
}

/** D1: «ما الفرق بين جو وبرو؟», «أبي أشترك في بزنس» — explained from the server's plan overview. */
async function publicPlansTurn(text: string, actorId: string, market: Market): Promise<Turn | null> {
  const named = namedPlanCodes(text);
  const compares = /(?:^|\s)(?:الفرق|فرق|قارن|مقارنه|افضل|احسن)(?:\s|$)/u.test(text) && named.length >= 2;
  const business = named.length === 1 && named[0] === "DINAR_BUSINESS" && (/(?:^|\s)(?:اشترك|اشتراك|ارقي|ترقي|سعر|كم|بكم|خطه|باقه)/u.test(text));
  if (!compares && !business) return null;
  const overview = await subscriptionPlansOverview(actorId, market);
  const plan = (code: PlanCode) => overview.plans.find((item) => item.planCode === code)!;
  if (compares) {
    const lines = named.map((code) => {
      const item = plan(code);
      return `• ${item.name}: ${item.marketPrice?.label ?? "السعر غير معتمد بعملة سوقك بعد"} — ${item.referencePriceLabel}. ${item.description} ${item.eligibilityNote}`;
    });
    const prompt = [...lines, overview.approvals.note, overview.billing.note].filter(Boolean).join("\n");
    return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", publicPlanFocus: named }, [], prompt, actorId, market);
  }
  const item = plan("DINAR_BUSINESS");
  const verified = overview.businesses.filter((entry) => entry.verificationStatus === "VERIFIED");
  const pending = overview.businesses.filter((entry) => entry.verificationStatus !== "VERIFIED" && entry.verificationStatus !== "REJECTED");
  const verification = verified.length
    ? `نشاطك «${verified[0]!.displayName}» موثّق ويمكن ربط الاشتراك به.`
    : pending.length
      ? `نشاطك «${pending[0]!.displayName}» حالته «${pending[0]!.statusLabel}»؛ جاسم بزنس يحتاج نشاطًا موثّقًا أولًا، والدفع لا يوثّق النشاط.`
      : "جاسم بزنس يحتاج نشاطًا تجاريًا موثّقًا من مراجع جاسم. قل «أنا صاحب مطعم اسمه …» لنبدأ.";
  const subscription = overview.subscription.status === "FREE" ? "أنت الآن على الحساب المجاني." : `اشتراكك الحالي: ${overview.currentPlanLabel} (${overview.subscription.statusLabel}).`;
  const billing = subscriptionBillingStatus().connected ? "الدفع يتم عبر مزوّد الفوترة بعد تأكيدك، ولا تُفعّل الخطة قبل تأكيد موثّق منه." : "تفعيل الاشتراك المدفوع غير متاح الآن لأن الفوترة غير موصولة؛ لم يُنشأ اشتراك ولم يُخصم شيء.";
  const prompt = `${item.name}: ${item.referencePriceLabel}${item.marketPrice ? `، وسعره في سوقك ${item.marketPrice.label}` : "؛ سعره بعملة سوقك غير معتمد بعد"}. ${item.description} ${verification} ${subscription} ${billing}`;
  return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "AI_PLANS", publicPlanFocus: ["DINAR_BUSINESS"] }, [], prompt, actorId, market);
}

async function analytics(actorId: string, market: Market, latest: CommerceQuery | undefined, latestSet: StoredSet | undefined): Promise<Turn> {
  const all = await listSellerPromotions(actorId, market);
  if (!all.length) return notice(actorId, "لا توجد لديك حملات بعد. قل «روح بع لي هذا» أو «خل الإعلان مميز».", market);
  // The campaign in context (status card) or all of the seller's campaigns.
  const focus = latest?.promotionId ? [latest.promotionId] : latestSet && (latestSet.query as { kind?: unknown; view?: unknown }).kind === "PROMOTION" && (latestSet.query as { promotionId?: unknown }).promotionId ? [String((latestSet.query as { promotionId: string }).promotionId)] : all.map((item) => item.id);
  const rows = await campaignAnalytics(actorId, market, focus);
  const budgeted = rows.filter((row) => row.budgetLabel);
  const summary = budgeted.length
    ? budgeted.map((row) => `«${row.listingTitle}»: صُرف ${row.spentLabel} من ${row.budgetLabel} وبقي ${row.remainingLabel}`).join("؛ ")
    : `${rows.length} حملة`;
  return turnFor({ kind: "COMMERCE", ownerId: actorId, view: "CAMPAIGN_ANALYTICS" }, focus, `نتائج حملاتك (أرقام مجمّعة من أحداث يتحقق منها الخادم): ${summary}.`, actorId, market);
}

// ─── Market Pulse ────────────────────────────────────────────────────────────

/** The question is about DINAR's own market: «نبض السوق», «في دينار», «عندكم», «عليه طلب» (my item). */
const DINAR_MARKET_ANCHOR = /دينار|dinar|نبض|فرص\s+السوق|(?:^|\s)(?:عندكم|هنا|بالسوق|في\s+السوق|بالمنصه|بالتطبيق|عليه|عليها)(?:\s|$)/u;

async function pulse(text: string, message: string, actorId: string, market: Market, latest: CommerceQuery | undefined): Promise<Turn | null> {
  const policy = await getCommercialPolicy(market.id);
  const entitled = await businessEntitlements(actorId, market);
  const business = entitled.has("MARKET_PULSE_ADVANCED");
  const asked: PulseWindow | undefined = /24\s*ساعه|اليوم|امس/u.test(text) ? "24h" : /30\s*يوم|الشهر|شهر/u.test(text) ? "30d" : /7\s*(?:ايام|يوم)|الاسبوع|اسبوع/u.test(text) ? "7d" : undefined;
  const window: PulseWindow = asked ?? latest?.pulse?.window ?? policy.freePulseWindows[0]!;
  const compare = P.pulseCompare.test(text);
  const allowed = business ? policy.businessPulseWindows : policy.freePulseWindows;
  if (!allowed.includes(window) || (compare && !business)) {
    // Server entitlement, not the client, decides; the free tier keeps its basic pulse.
    const plans = await businessPlans(market);
    return turnFor(
      { kind: "COMMERCE", ownerId: actorId, view: "BUSINESS_PLAN_REVIEW", upsell: true, notice: "هذه الفترة أو المقارنة من مزايا جاسم بزنس." },
      plans.map((plan) => plan.id),
      `${compare ? "مقارنة الفترات" : `نبض السوق لفترة ${window}`} متاح ضمن جاسم بزنس. يمكنك رؤية النبض الأساسي (${policy.freePulseWindows.join("، ")}) مجانًا، أو قول «أبي جاسم بزنس».`,
      actorId,
      market,
    );
  }
  const [categories, cities] = await Promise.all([listMarketplaceCategories(), publishedListingCities(market.id)]);
  const normalized = normalizeSearch(message);
  const category = categories.find((item) => [item.label, ...item.aliases].some((alias) => alias.length >= 3 && normalized.includes(normalizeSearch(alias))));
  const city = cities.find((item) => normalized.includes(normalizeSearch(item)));
  const money = text.match(MONEY);
  const focusMatch = text.match(/(?:الطلب\s+علي|طلب\s+علي)\s+(.+?)(?:\s+مرتفع|\s+عالي|$)/u);
  const mode: PulseMode = P.pulseUnmet.test(text) ? "UNMET" : P.pulseSell.test(text) || money ? "OPPORTUNITIES" : "TOP";
  const state: CommerceQuery = {
    kind: "COMMERCE",
    ownerId: actorId,
    view: focusMatch ? "MARKET_OPPORTUNITY" : "MARKET_PULSE",
    pulse: {
      window,
      mode,
      ...(city ? { city } : {}),
      ...(category && !focusMatch ? { categoryId: category.id } : {}),
      ...(focusMatch ? { needText: focusMatch[1]!.trim().slice(0, 60) } : {}),
      ...(money ? { budgetMinor: majorToMinor(Number(money[1]), market.minorUnitScale) } : {}),
      ...(compare ? { compare: true } : {}),
    },
  };
  const result = await marketPulse({
    market,
    window,
    mode,
    limit: state.view === "MARKET_OPPORTUNITY" ? 1 : business ? policy.businessPulseInsightLimit : policy.freePulseInsightLimit,
    ...(state.pulse!.city ? { city: state.pulse!.city } : {}),
    ...(state.pulse!.categoryId ? { categoryId: state.pulse!.categoryId } : {}),
    ...(state.pulse!.needText ? { needText: state.pulse!.needText } : {}),
    ...(state.pulse!.budgetMinor ? { budgetMinor: state.pulse!.budgetMinor } : {}),
  });
  // «هل الطلب على الذهب عالي هالأيام؟» names no DINAR scope. With DINAR data it gets the card;
  // without, it is a general question, so the model answers it rather than a «no data» card.
  if (result.status !== "OK" && focusMatch && !category && !city && !DINAR_MARKET_ANCHOR.test(text)) return null;
  const windowLabel = { "24h": "آخر 24 ساعة", "7d": "آخر 7 أيام", "30d": "آخر 30 يومًا" }[window];
  const prompt = result.status !== "OK"
    ? `${result.message} (${windowLabel}${city ? `، ${city}` : ""}). لا أعطي أرقامًا دون حد الخصوصية (${result.cohortThreshold} باحثين على الأقل).`
    : mode === "OPPORTUNITIES"
      ? `نبض السوق — ${windowLabel}${city ? ` في ${city}` : ""}: توجد إشارات طلب على ${result.clusters.map((cluster) => `«${cluster.title}»`).join("، ")}${money ? ` ضمن ميزانية ${money[1]} ${market.currencyCode}` : ""}. هذه إشارات مجمّعة وليست وعدًا بربح أو بيع.`
      : `نبض السوق — ${windowLabel}${city ? ` في ${city}` : ""}: ${result.clusters.map((cluster) => `«${cluster.title}» (${approximate(cluster.uniqueDemandActors)} باحثًا)`).join("، ")}. أرقام مجمّعة فقط.`;
  return turnFor(state, result.clusters.map((cluster) => cluster.needKey), prompt, actorId, market);
}

async function pulseInsightAt(state: CommerceQuery, index: number, actorId: string, market: Market) {
  if (!state.pulse) return undefined;
  const entitled = await businessEntitlements(actorId, market);
  const policy = await getCommercialPolicy(market.id);
  const result = await marketPulse({
    market,
    window: state.pulse.window,
    mode: state.pulse.mode,
    limit: entitled.has("MARKET_PULSE_ADVANCED") ? policy.businessPulseInsightLimit : policy.freePulseInsightLimit,
    ...(state.pulse.city ? { city: state.pulse.city } : {}),
    ...(state.pulse.categoryId ? { categoryId: state.pulse.categoryId } : {}),
    ...(state.pulse.needText ? { needText: state.pulse.needText } : {}),
    ...(state.pulse.budgetMinor ? { budgetMinor: state.pulse.budgetMinor } : {}),
  });
  return result.clusters[index];
}

export { PULSE_WINDOW_MS };
export type { CommerceSurface };
