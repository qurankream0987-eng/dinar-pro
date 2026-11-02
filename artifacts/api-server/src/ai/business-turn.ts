/**
 * D3-A: the business owner's conversation adapter. Not a second runtime — an intent adapter in the
 * same DINAR conversation that reads the seller's Arabic, resolves the business from server rows,
 * and hands every mutation to the existing authorities:
 *  - setup/profile      → D3 operating metadata linked to canonical D2 identity
 *  - catalog publish    → `createListingForActor` (via lib/business-catalog)
 *  - edit/price/status  → `updateOwnedListing` / `changeOwnedListingStatus`
 *  - orders/insights    → read-only server queries scoped to this business
 * Reviews live in `ai_result_sets` exactly like the block-F foundation: owner-bound, expiring,
 * voided by a newer conversation step, claimed once, and re-authorized by the service inside its
 * transaction. The model never picks a business, a listing, a price or an action.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, businessOperatingProfiles, db, offers, users } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import { normalizeSearch } from "./search-context";
import {
  listMarketplaceCategories,
  type MarketplaceCategoryRow,
} from "../lib/marketplace-categories";
import {
  assertPublishable,
  ownedBusinessForActor,
  recordBusinessAudit,
  requireBusinessCapability,
  resolveBusinessAccess,
  businessWithD2Identity,
  type BusinessAccess,
  type BusinessProfile,
} from "../lib/business-access";
import {
  businessAnalytics,
  businessCatalogSummary,
  businessListingForBusiness,
  businessListings,
  businessOrders,
  changeBusinessListingStatus,
  publishBusinessDraft,
  updateBusinessListing,
  type BusinessListingState,
} from "../lib/business-catalog";
import {
  createBusinessDraft,
  updateBusinessProfile,
} from "../lib/business-profiles";
import { buildListingUpdateBody, parseListingPriceMinor } from "../lib/listing-management";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

export const BUSINESS_ACTION_TTL_MS = 10 * 60 * 1000;
const BUSINESS_TURN_TOOL = "businessTurn";

export type BusinessPayload = Record<string, unknown> & {
  view: string;
  businessId?: string;
  pendingActionId?: string;
  allowedActions?: string[];
};

const DECISION = /^(?:اكد|أكد|اكدلي|تاكيد|تأكيد|نعم|ايوه|ايه|اجل|تم|نفذ|نفّذ|موافق|يلا|confirm|yes)$/u;
const CANCEL = /^(?:الغاء|إلغاء|لا|لأ|تراجع|كنسل|بطل|cancel|no)$/u;

export function normalizeBusinessText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    // Decimal points stay: a price in the message must survive the cleanup.
    .replace(/[؟?!،,؛;:()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:من فضلك|لو سمحت|رجاء|ممكن|يا دينار|دينار|يا)\s+)+/u, "");
}

const has = (text: string, pattern: RegExp) => pattern.test(text);

const SETUP_INTENT = [
  /^(?:ابي|ابغى|ابغي|اريد|ودي|بدي|حاب|احب|احتاج)\s+(?:افتح|اسجل|اضيف|انشئ|اسوي|اعمل|ابدأ|ابدا)\s+(?:لي\s+)?(?:نشاط|متجر|مطعم|مقهى|كافيه|محل|حساب تجاري|بزنس)/u,
  /^(?:سجل|سجّل|اضف|أضف|افتح|انشئ|أنشئ)\s+(?:لي\s+)?(?:نشاطي|نشاط|متجري|مطعمي|محلي|حسابي التجاري)/u,
  /^عندي\s+(?:مطعم|متجر|محل|مقهى|كافيه|مشروع|نشاط|بزنس|مخبز|بوفيه|صالون)/u,
  /^(?:هذا|هذه)\s+نشاطي|^(?:نشاطي التجاري|حسابي التجاري|متجري|مطعمي)$/u,
];

const RESUME_INTENT = /^(?:ارجع|رجعني|افتح|ورني|اعرض)\s+(?:لي\s+)?(?:نشاطي|نشاط|متجري|مطعمي|حسابي التجاري)|^(?:نشاطي|متجري|مطعمي|النشاط)$/u;

const CATALOG_INTENT = /(?:منتجاتي|منتجات النشاط|منتجات المتجر|عروض النشاط|عروضي|قائمه المنتجات|قائمة المنتجات|ورني المنتجات|اعرض المنتجات|اعرض منتجاتي|وش عندي|ايش عندي|شنو عندي)/u;
const COUNT_INTENT = /كم\s+(?:منتج|صنف|عرض|طبق)\s*(?:عندي|في النشاط|في المتجر)?|عدد\s+(?:المنتجات|الاصناف|العروض)/u;
const PAUSE_INTENT = /^(?:اوقف|وقف|عطل|عطّل|اوقفلي|اقفل|اخف)\s+(?:منتج|عرض|صنف|طبق)?\s*(.*)$/u;
const RESUME_INTENT_LISTING = /^(?:فعل|شغل|رجع|ارجع|اعد|أعد|اظهر)\s+(?:منتج|عرض|صنف|طبق)?\s*(.*)$/u;
const PRICE_INTENT = /^(?:غير|عدل|بدل|خفض|ارفع|حدد|خلي|اجعل|حدّث)\s+(?:سعر|سعر\s+منتج|سعر\s+عرض|سعر\s+الصنف)\s*(.*)$/u;
const STOCK_INTENT = /^(?:خلص|نفد|نفّد|صفّر|صفر|مباع|انتهى|ما\s+بقى|مافي)\s+(?:مخزون|منتج|عرض|صنف|طبق)?\s*(.*)$/u;
const DRAFTS_INTENT = /^(?:جهز|حضر|حضّر|اعد|أعد|انشئ|أنشئ|سوي|اعمل|اقترح)\s+(?:لي\s+)?(?:ثلاث|3|ثلاثه|ثلاثة)\s+(?:عروض|منتجات|اصناف|أصناف|اطباق|أطباق)\s*(.*)$/u;
const ORDERS_INTENT = /(?:طلبات|اوردرات|أوردرات)\s+(?:النشاط|المتجر|المطعم|العملاء|المحل)|^(?:وش|كم|اعرض|ورني)\s+(?:ال)?(?:طلبات النشاط|طلبات المتجر|طلبات المطعم)/u;
const INSIGHTS_INTENT = /(?:تحليل|تحليلات|احصائيات|إحصائيات|ملخص|اداء|أداء)\s+(?:النشاط|المتجر|المطعم|المحل)|^(?:كم\s+بعت|مبيعاتي|مبيعات النشاط|ارباحي)/u;
const PROFILE_INTENT = /^(?:بيانات|معلومات|اعدادات|إعدادات)\s+(?:النشاط|المتجر|المطعم)|^(?:عدل|غير)\s+(?:اسم|وصف)\s+(?:النشاط|المتجر|المطعم)/u;

const TYPE_WORDS = {
  RESTAURANT: /(?:مطعم|مقهى|كافيه|كوفي|مطبخ|بوفيه|مشويات|بيتزا|برجر|حلويات|مخبز|كافيتيريا)/u,
  SHOP: /(?:متجر|محل|بقاله|سوبرماركت|ماركت|معرض|مكتبه|صيدليه| boutique|shop|store)/u,
  SERVICE_PROVIDER: /(?:خدمه|خدمات|صيانه|تصليح|تنظيف|تصميم|توصيل|سباك|كهربائي|حلاق|صالون|ورشه|مكتب|استشارات)/u,
} as const;

function detectBusinessType(text: string): "RESTAURANT" | "SHOP" | "SERVICE_PROVIDER" | "OTHER" {
  if (TYPE_WORDS.RESTAURANT.test(text)) return "RESTAURANT";
  if (TYPE_WORDS.SHOP.test(text)) return "SHOP";
  if (TYPE_WORDS.SERVICE_PROVIDER.test(text)) return "SERVICE_PROVIDER";
  return "OTHER";
}

const TYPE_LABELS: Record<string, string> = {
  RESTAURANT: "مطعم",
  SHOP: "متجر",
  SERVICE_PROVIDER: "مزود خدمة",
  OTHER: "نشاط",
};

/** The public display name the seller stated, never a location or a filler word. */
function extractBusinessName(text: string): string | undefined {
  const quoted = /«([^»]{2,80})»|"([^"]{2,80})"/u.exec(text);
  if (quoted) return (quoted[1] ?? quoted[2] ?? "").trim();
  const named = /(?:اسمه|اسمها|باسم|يسمى|تسمى|اسم النشاط)\s*[:：]?\s*(.{2,80})/u.exec(text);
  if (named?.[1]) return named[1].trim();
  const afterKind = /(?:مطعم|مقهى|كافيه|متجر|محل|مشروع|نشاط|بزنس|مخبز|بوفيه|صالون)\s+(.{2,80})/u.exec(text);
  const candidate = afterKind?.[1]?.trim();
  if (!candidate) return undefined;
  if (/^(?:جديد|جديده|صغير|صغيره|كبير|كبيره|في|ب|من|على)(?:\s|$)/u.test(candidate)) return undefined;
  if (/(?:في|بمنطقه|بمدينه|بالسوق)\s/u.test(candidate) && candidate.split(" ").length > 4) return undefined;
  return candidate;
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120);
}

function setupState(business: BusinessProfile): Record<string, unknown> {
  return business.profile ?? {};
}

function nextSetupStep(business: BusinessProfile): "name" | "type" | "description" | "area" | "fulfilment" | "review" {
  const state = setupState(business);
  if (state.setupName !== true) return "name";
  if (state.setupType !== true) return "type";
  if (state.setupDescription !== true) return "description";
  if (state.setupArea !== true && !(typeof state.area === "string" && state.area.trim())) return "area";
  if (state.setupFulfilment !== true) return "fulfilment";
  return "review";
}

const SETUP_PROMPTS: Record<string, string> = {
  name: "ما الاسم التجاري الذي سيظهر للمشترين على نشاطك؟",
  type: "ما نوع النشاط؟ مطعم، متجر، أو مزود خدمة؟",
  description: "اكتب وصفًا قصيرًا يظهر للمشترين (أو قل «تخطى»).",
  area: "في أي مدينة أو منطقة يخدم نشاطك؟ اكتب اسمًا عامًا فقط، لا عنوانًا دقيقًا.",
  fulfilment: "كيف يحصل المشتري على طلبك؟ استلام من الفرع، توصيل، أم الاثنان؟",
  review: "راجع بيانات نشاطك في البطاقة. لن يُشغَّل النشاط إلا بعد ضغطك «تشغيل النشاط».",
};

function setupPayload(business: BusinessProfile, access: BusinessAccess, extra: Record<string, unknown> = {}): BusinessPayload {
  const state = setupState(business);
  const step = nextSetupStep(business);
  return {
    view: "SETUP",
    businessId: business.id,
    name: state.setupName === true ? business.displayName || undefined : undefined,
    businessType: business.businessType,
    businessTypeLabel: TYPE_LABELS[business.businessType] ?? "نشاط",
    status: business.status,
    operatingMode: business.operatingMode,
    identityStatus: business.identityStatus,
    verificationStatus: access.verificationStatus,
    publishable: access.publishable,
    canPublish: access.capabilities.has("business.catalog.publish"),
    missingField: step,
    prompt: SETUP_PROMPTS[step],
    ...extra,
  };
}

function accessPayload(access: BusinessAccess) {
  return {
    verificationStatus: access.verificationStatus,
    publicationEligibility: access.publicationEligibility,
    publishable: access.publishable,
    canPublish: access.capabilities.has("business.catalog.publish"),
    canDraft: access.capabilities.has("business.catalog.draft"),
    canManageProfile: access.capabilities.has("business.profile.manage"),
    actorClass: access.actorClass,
  };
}

function publicationNotice(access: BusinessAccess): string | undefined {
  if (access.publishable) return undefined;
  if (access.verificationStatus !== "VERIFIED")
    return `نشر المنتجات ينتظر مراجعة DINAR لهوية النشاط (${access.verificationStatus}). يمكنك تجهيز المسودات الآن؛ لن يُنشر شيء تلقائيًا.`;
  if (access.publicationEligibility !== "ELIGIBLE")
    return "نشر هذا النشاط موقوف من جهة اعتماد الهوية التجارية.";
  return "النشاط غير نشط حاليًا؛ لا يمكن نشر منتجات جديدة.";
}

async function ownerBusinesses(actorId: string, marketId: string) {
  const rows = await db
    .select()
    .from(businessOperatingProfiles)
    .where(and(
      eq(businessOperatingProfiles.ownerUserId, actorId),
      eq(businessOperatingProfiles.marketId, marketId),
    ))
    .orderBy(desc(businessOperatingProfiles.updatedAt));
  return Promise.all(rows.map(businessWithD2Identity));
}

function businessMentioned(rows: BusinessProfile[], text: string): BusinessProfile | undefined {
  const normalized = ` ${normalizeSearch(text)} `;
  const matches = rows.filter((row) => {
    const name = normalizeSearch(row.displayName);
    return name.length >= 2 && normalized.includes(` ${name} `);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

type ResolvedBusiness = {
  business: BusinessProfile;
  access: BusinessAccess;
  rows: BusinessProfile[];
  ambiguous: boolean;
};

async function resolveBusiness(input: {
  actorId: string;
  marketId: string;
  text: string;
}): Promise<ResolvedBusiness | undefined> {
  const rows = await ownerBusinesses(input.actorId, input.marketId);
  if (!rows.length) return undefined;
  const mentioned = businessMentioned(rows, input.text);
  // An active business is not an implicit default when the owner has several.
  const chosen = mentioned ?? (rows.length === 1 ? rows[0] : undefined);
  if (!chosen) return { business: rows[0]!, access: await resolveBusinessAccess({ business: rows[0]!, actorId: input.actorId, marketId: input.marketId }), rows, ambiguous: true };
  const access = await resolveBusinessAccess({
    business: chosen,
    actorId: input.actorId,
    marketId: input.marketId,
  });
  if (access.actorClass === "NONE") return undefined;
  return { business: chosen, access, rows, ambiguous: false };
}

function businessOutput(
  surface: string,
  business: BusinessPayload,
  prompt: string,
): Turn {
  const resultSetId = typeof business.resultSetId === "string" ? business.resultSetId : undefined;
  return {
    tool: BUSINESS_TURN_TOOL,
    version: 1,
    result: {
      kind: "SURFACE",
      surface,
      query: {},
      listings: [],
      prompt,
      ...(resultSetId ? { resultSetId } : {}),
      business: business as Record<string, unknown>,
    },
  };
}

function selectionTurn(rows: BusinessProfile[], prompt: string): Turn {
  return businessOutput("BUSINESS_PROFILE", {
    view: "PROFILE",
    selection: true,
    businesses: rows.slice(0, 6).map((row) => ({
      businessId: row.id,
      name: row.displayName,
      businessTypeLabel: TYPE_LABELS[row.businessType] ?? "نشاط",
      status: row.status,
      identityStatus: row.identityStatus,
    })),
    allowedActions: [],
  }, prompt);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function saveSetupState(business: BusinessProfile, patch: Record<string, unknown>) {
  const [updated] = await db
    .update(businessOperatingProfiles)
    .set({ profile: { ...business.profile, ...patch }, updatedAt: new Date() })
    .where(eq(businessOperatingProfiles.id, business.id))
    .returning();
  return updated ? businessWithD2Identity(updated) : business;
}

async function updateCanonicalBusinessDraft(
  business: BusinessProfile,
  input: {
    displayName?: string;
    categoryKey?: string;
    description?: string;
  },
) {
  if (!business.d2Revision)
    throw Object.assign(new Error("تعذر قراءة نسخة هوية النشاط من DINAR؛ لم يتغير شيء."), { status: 409 });
  return updateBusinessProfile(
    business.ownerUserId,
    { id: business.marketId },
    business.d2BusinessId,
    { expectedRevision: business.d2Revision, ...input },
  );
}

async function startSetup(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  text: string;
}): Promise<Turn> {
  const rows = await ownerBusinesses(input.actorId, input.market.id);
  if (rows.length > 1) {
    const mentioned = businessMentioned(rows, input.text);
    if (!mentioned)
      return selectionTurn(rows, "لديك أكثر من نشاط. اختر النشاط الذي تريد إدارته:");
    if (mentioned.status !== "DRAFT")
      return resumeTurn({ conversationId: input.conversationId, actorId: input.actorId, market: input.market, rows: [mentioned] });
    const access = await resolveBusinessAccess({ business: mentioned, actorId: input.actorId, marketId: input.market.id });
    return businessOutput("BUSINESS_SETUP", setupPayload(mentioned, access), SETUP_PROMPTS[nextSetupStep(mentioned)] ?? "");
  }
  const draft = rows.find((row) => row.status === "DRAFT");
  if (draft) {
    const access = await resolveBusinessAccess({ business: draft, actorId: input.actorId, marketId: input.market.id });
    return businessOutput("BUSINESS_SETUP", setupPayload(draft, access), SETUP_PROMPTS[nextSetupStep(draft)] ?? "");
  }
  if (rows.length && !rows.some((row) => row.status === "DRAFT")) {
    // §C: an existing business is resumed, never duplicated.
    return resumeTurn({ conversationId: input.conversationId, actorId: input.actorId, market: input.market, rows });
  }
  const type = detectBusinessType(input.text);
  const name = extractBusinessName(input.text);
  const hasTypeInText = type !== "OTHER";
  const categoryKey = type === "RESTAURANT"
    ? "RESTAURANT"
    : type === "SHOP"
      ? "RETAIL"
      : type === "SERVICE_PROVIDER"
        ? "SERVICES"
        : "OTHER";
  const identity = await createBusinessDraft(
    input.actorId,
    { id: input.market.id },
    {
      displayName: name ? normalizeName(name) : "نشاط جديد",
      categoryKey,
      description: "",
      idempotencyKey: createHash("sha256")
        .update(`d3a-business-setup:${input.conversationId}`)
        .digest("hex"),
    },
  );
  const [priorOperatingProfile] = await db
    .select()
    .from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.d2BusinessId, identity.business.id))
    .limit(1);
  if (priorOperatingProfile) {
    const linked = await businessWithD2Identity(priorOperatingProfile);
    const access = await resolveBusinessAccess({ business: linked, actorId: input.actorId, marketId: input.market.id });
    return businessOutput("BUSINESS_SETUP", setupPayload(linked, access), SETUP_PROMPTS[nextSetupStep(linked)] ?? "");
  }
  const [created] = await db
    .insert(businessOperatingProfiles)
    .values({
      id: randomUUID(),
      d2BusinessId: identity.business.id,
      ownerUserId: input.actorId,
      marketId: input.market.id,
      operatingMode: "INTERNAL_DINAR",
      businessType: type,
      displayName: name ? normalizeName(name) : "",
      description: "",
      status: "DRAFT",
      profile: {
        setupName: Boolean(name),
        ...(hasTypeInText ? { setupType: true } : {}),
      },
    })
    .returning();
  const operatingProfile = created ?? (await db
    .select()
    .from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.d2BusinessId, identity.business.id))
    .limit(1))[0];
  if (!operatingProfile) throw new Error("Could not create the D3 operating profile for the D2 identity");
  const linked = await businessWithD2Identity(operatingProfile);
  if (created) await recordBusinessAudit({
    businessId: linked.id,
    actorId: input.actorId,
    action: "BUSINESS_DRAFT_CREATED",
    resourceType: "BUSINESS",
    resourceId: linked.id,
    detail: { businessType: linked.businessType, operatingMode: "INTERNAL_DINAR", d2BusinessId: linked.d2BusinessId },
  });
  const access = await resolveBusinessAccess({ business: linked, actorId: input.actorId, marketId: input.market.id });
  const step = nextSetupStep(linked);
  return businessOutput(
    "BUSINESS_SETUP",
    setupPayload(linked, access, {
      ...(step === "name" ? {} : {}),
    }),
    `أنشأنا مسودة نشاطك داخل DINAR. ${SETUP_PROMPTS[step]}`,
  );
}

/** §C: one business resumes directly; several are offered, never guessed, never another account's. */
async function resumeTurn(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  rows?: BusinessProfile[];
}): Promise<Turn> {
  const rows = input.rows ?? (await ownerBusinesses(input.actorId, input.market.id));
  if (!rows.length) return businessOutput("BUSINESS_PROFILE", { view: "PROFILE", notice: "لا يوجد نشاط بعد.", allowedActions: [] }, "لا يوجد نشاط بعد؛ قل «عندي مطعم» لبدء تسجيل نشاطك.");
  if (rows.length > 1) {
    return selectionTurn(rows, "لديك أكثر من نشاط. اختر النشاط الذي تريد إدارته:");
  }
  const business = rows.find((row) => row.status === "DRAFT") ?? rows[0]!;
  const access = await resolveBusinessAccess({ business, actorId: input.actorId, marketId: input.market.id });
  if (business.status === "DRAFT") {
    return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS[nextSetupStep(business)] ?? "");
  }
  const listings = await businessListings(business, input.market.id);
  const summary = await businessCatalogSummary(business, input.market.id);
  return businessOutput(
    "BUSINESS_PROFILE",
    {
      view: "PROFILE",
      businessId: business.id,
      name: business.displayName,
      description: business.description,
      businessType: business.businessType,
      businessTypeLabel: TYPE_LABELS[business.businessType] ?? "نشاط",
      status: business.status,
      operatingMode: business.operatingMode,
      identityStatus: business.identityStatus,
      ...accessPayload(access),
      summary,
      listings: listings.slice(0, 12).map((row) => listingView(row, input.market)),
      blockedReason: publicationNotice(access),
      publicPath: `/business/${business.id}`,
      allowedActions: access.capabilities.has("business.catalog.read") ? ["CATALOG", "ORDERS", "INSIGHTS"] : [],
    },
    `هذا نشاطك «${business.displayName}». ${summary.published} منتج منشور من ${summary.total}.`,
  );
}

async function answerSetupStep(input: {
  conversationId: string;
  actorId: string;
  marketId: string;
  business: BusinessProfile;
  access: BusinessAccess;
  text: string;
  raw: string;
}): Promise<Turn> {
  const step = nextSetupStep(input.business);
  let business = input.business;
  let access = input.access;
  const skip = /^(?:تخطى|تخطي|سkip|skip|لا|بعدين|لاحقا)$/u.test(input.text);
  const refuse = /(?:ما\s*عندي|بدون|لا\s*املك)\s+(?:سجل|ترخيص)/u.test(input.text);

  // §D: no commercial registration is an honest state, not a field value. Say what it means and
  // keep the draft where it is; verification-gated capabilities stay blocked.
  if (refuse)
    return businessOutput(
      "BUSINESS_SETUP",
      setupPayload(business, access, {
        registrationNotice:
          "بدون سجل تجاري يمكنك تجهيز نشاطك ومسودات منتجاتك، لكن اعتماد الهوية التجارية والنشر للجمهور يبقيان موقوفين حتى يتوفر السجل.",
      }),
      SETUP_PROMPTS[step] ?? "",
    );

  if (step === "name") {
    if (skip) return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS.name!);
    const name = extractBusinessName(input.text) ?? input.raw.trim();
    if (name.length < 2) return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS.name!);
    const displayName = normalizeName(name);
    await updateCanonicalBusinessDraft(business, { displayName });
    const [updated] = await db
      .update(businessOperatingProfiles)
      .set({ displayName, updatedAt: new Date() })
      .where(eq(businessOperatingProfiles.id, business.id))
      .returning();
    business = await saveSetupState(updated ? await businessWithD2Identity(updated) : business, { setupName: true });
  } else if (step === "type") {
    const type = detectBusinessType(input.text);
    const categoryKey = type === "RESTAURANT"
      ? "RESTAURANT"
      : type === "SHOP"
        ? "RETAIL"
        : type === "SERVICE_PROVIDER"
          ? "SERVICES"
          : "OTHER";
    await updateCanonicalBusinessDraft(business, { categoryKey });
    const [updated] = await db
      .update(businessOperatingProfiles)
      .set({ businessType: type, updatedAt: new Date() })
      .where(eq(businessOperatingProfiles.id, business.id))
      .returning();
    business = await saveSetupState(updated ? await businessWithD2Identity(updated) : business, { setupType: true });
  } else if (step === "description") {
    const description = skip ? "" : input.raw.trim().slice(0, 1000);
    await updateCanonicalBusinessDraft(business, { description });
    const [updated] = await db
      .update(businessOperatingProfiles)
      .set({ description, updatedAt: new Date() })
      .where(eq(businessOperatingProfiles.id, business.id))
      .returning();
    business = await saveSetupState(updated ? await businessWithD2Identity(updated) : business, { setupDescription: true });
  } else if (step === "area") {
    if (skip) return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS.area!);
    const area = input.text.replace(/^(?:في|بمنطقه|بمدينه|منطقه)\s*/u, "").slice(0, 120);
    if (area.length < 2) return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS.area!);
    business = await saveSetupState(business, { area, setupArea: true });
  } else if (step === "fulfilment") {
    const both = /(?:الاثنين|كلاهما|الاثنان|both)/u.test(input.text);
    const delivery = /(?:توصيل|دليفري|delivery)/u.test(input.text);
    const pickup = /(?:استلام|فرع|محل|pickup)/u.test(input.text);
    const service = /(?:خدمه|خدمة|في الموقع|عند العميل|onsite)/u.test(input.text);
    const fulfilment = service && !pickup && !delivery ? "SERVICE" : both || (pickup && delivery) ? "BOTH" : delivery ? "DELIVERY" : pickup ? "PICKUP" : undefined;
    if (!fulfilment) return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS.fulfilment!);
    business = await saveSetupState(business, { fulfilment, setupFulfilment: true });
  }

  access = await resolveBusinessAccess({ business, actorId: input.actorId, marketId: input.marketId });
  const next = nextSetupStep(business);
  if (next !== "review")
    return businessOutput("BUSINESS_SETUP", setupPayload(business, access), SETUP_PROMPTS[next]!);
  return reviewSetup({ conversationId: input.conversationId, actorId: input.actorId, marketId: input.marketId, business, access });
}

async function reviewSetup(input: {
  conversationId: string;
  actorId: string;
  marketId: string;
  business: BusinessProfile;
  access: BusinessAccess;
}): Promise<Turn> {
  const business = input.business;
  const access = input.access;
  const state = setupState(business);
  const expiresAt = new Date(Date.now() + BUSINESS_ACTION_TTL_MS);
  const [existing] = await db
    .select({ id: aiResultSets.id })
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, input.conversationId),
      sql`${aiResultSets.query} ->> 'kind' = 'BUSINESS_SETUP'`,
      sql`${aiResultSets.query} ->> 'status' = 'PENDING'`,
      sql`${aiResultSets.query} ->> 'ownerId' = ${input.actorId}`,
      sql`${aiResultSets.query} ->> 'businessId' = ${business.id}`,
    ))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  let reviewId = existing?.id;
  if (!reviewId) {
    reviewId = randomUUID();
    await db.insert(aiResultSets).values({
      id: reviewId,
      conversationId: input.conversationId,
      marketId: input.marketId,
      query: {
        kind: "BUSINESS_SETUP",
        ownerId: input.actorId,
        businessId: business.id,
        expectedVersion: business.version,
        status: "PENDING",
        expiresAt: expiresAt.toISOString(),
      },
      resourceIds: [business.id],
      expiresAt,
    });
  }
  return businessOutput(
    "BUSINESS_PROFILE_REVIEW",
    {
      ...setupPayload(business, access),
      view: "PROFILE_REVIEW",
      description: business.description,
      area: state.area ?? null,
      fulfilment: state.fulfilment ?? null,
      allowedActions: access.capabilities.has("business.profile.manage") ? ["ACTIVATE", "CANCEL"] : [],
      reviewLines: [
        `الاسم: «${business.displayName}»`,
        `النوع: ${TYPE_LABELS[business.businessType] ?? "نشاط"}`,
        `الوصف: ${business.description || "بدون وصف"}`,
        `المنطقة: ${typeof state.area === "string" ? state.area : "غير محددة"}`,
        "التشغيل داخل DINAR فقط (بدون موقع خارجي أو متجر منفصل)",
        "هوية النشاط التجاري تبقى قيد الاعتماد؛ النشر للجمهور يحتاج اعتمادًا مستقلًا",
      ],
      pendingActionId: reviewId,
      expiresAt: expiresAt.toISOString(),
    },
    "راجع بيانات نشاطك. اضغط «تشغيل النشاط» أو أرسل «أكد» للتشغيل.",
  );
}

// ─── Owner catalog commands ──────────────────────────────────────────────────

const money = (minor: number, market: Market) =>
  `${(minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale)} ${market.currencyCode}`;

function listingView(row: BusinessListingState, market: Market) {
  return {
    listingId: row.listingId,
    title: row.title,
    status: row.status,
    priceMinor: row.priceMinor,
    price: row.priceMinor === null ? null : money(row.priceMinor, market),
    currency: market.currencyCode,
    inventoryMode: row.inventoryMode,
    availableQuantity: row.availableQuantity,
    reservedQuantity: row.reservedQuantity,
    category: row.category,
    updatedAt: row.updatedAt,
  };
}

async function catalogTurn(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  business: BusinessProfile;
  access: BusinessAccess;
  text: string;
  countOnly: boolean;
}): Promise<Turn> {
  const listings = await businessListings(input.business, input.market.id);
  const summary = await businessCatalogSummary(input.business, input.market.id);
  const resultSetId = randomUUID();
  await db.insert(aiResultSets).values({
    id: resultSetId,
    conversationId: input.conversationId,
    marketId: input.market.id,
    query: {
      kind: "BUSINESS_CATALOG",
      ownerId: input.actorId,
      businessId: input.business.id,
      listingIds: listings.map((row) => row.listingId),
      status: "READY",
    },
    resourceIds: listings.map((row) => row.listingId),
    expiresAt: new Date(Date.now() + BUSINESS_ACTION_TTL_MS),
  });
  const canManage = input.access.capabilities.has("business.listing.update");
  return businessOutput(
    "BUSINESS_CATALOG",
    {
      view: "CATALOG",
      businessId: input.business.id,
      businessName: input.business.displayName,
      name: input.business.displayName,
      status: input.business.status,
      resultSetId,
      ...accessPayload(input.access),
      summary,
      listings: listings.slice(0, 24).map((row) => listingView(row, input.market)),
      blockedReason: publicationNotice(input.access),
      allowedActions: canManage ? ["PAUSE", "RESUME", "PRICE", "STOCK_OUT", "DRAFTS"] : [],
      empty: listings.length === 0,
    },
    input.countOnly
      ? `لديك ${summary.total} منتجًا: ${summary.published} منشور و${summary.paused} موقوف.`
      : listings.length
        ? `منتجات «${input.business.displayName}» (${summary.total}). اختر منتجًا لإيقافه أو تعديل سعره.`
        : "لا توجد منتجات بعد. قل مثلًا «جهز لي ثلاث عروض: ...» لإعداد مسودات.",
  );
}

async function ordersTurn(input: {
  actorId: string;
  market: Market;
  business: BusinessProfile;
  access: BusinessAccess;
}): Promise<Turn> {
  const orders = await businessOrders(input.business, input.market.id);
  return businessOutput(
    "BUSINESS_ORDERS",
    {
      view: "ORDERS",
      businessId: input.business.id,
      name: input.business.displayName,
      orders: orders.map((order) => ({
        ...order,
        total: `${(order.sellerAmountMinor / 10 ** input.market.minorUnitScale).toFixed(input.market.minorUnitScale)} ${order.currencyCode}`,
      })),
      empty: orders.length === 0,
      ...(orders.length ? {} : { notice: "لا توجد طلبات على منتجات النشاط بعد." }),
      allowedActions: [],
    },
    orders.length ? `آخر ${orders.length} طلبًا على منتجات نشاطك.` : "لا توجد طلبات على منتجات النشاط بعد.",
  );
}

async function insightsTurn(input: {
  actorId: string;
  market: Market;
  business: BusinessProfile;
  access: BusinessAccess;
}): Promise<Turn> {
  const insights = await businessAnalytics(input.business, input.market.id);
  return businessOutput(
    "BUSINESS_INSIGHTS",
    {
      view: "INSIGHTS",
      businessId: input.business.id,
      name: input.business.displayName,
      insights: {
        ...insights,
        completedRevenue: `${(insights.completedRevenueMinor / 10 ** input.market.minorUnitScale).toFixed(input.market.minorUnitScale)} ${input.market.currencyCode}`,
      },
      allowedActions: [],
    },
    `${insights.published} منتج منشور، ${insights.completedOrders} طلب مكتمل.`,
  );
}

async function latestCatalogIds(conversationId: string, actorId: string): Promise<string[]> {
  const [row] = await db
    .select({ resourceIds: aiResultSets.resourceIds, query: aiResultSets.query })
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, conversationId),
      sql`${aiResultSets.query} ->> 'kind' = 'BUSINESS_CATALOG'`,
      sql`${aiResultSets.query} ->> 'ownerId' = ${actorId}`,
    ))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  return row?.resourceIds ?? [];
}

const ORDINALS: Record<string, number> = {
  الاول: 1, الأول: 1, اول: 1, الثاني: 2, الثانى: 2, الثالث: 3, الرابع: 4, الخامس: 5, السادس: 6,
};

async function resolveListingTarget(input: {
  conversationId: string;
  actorId: string;
  business: BusinessProfile;
  marketId: string;
  text: string;
}): Promise<{ listing?: BusinessListingState; ambiguous?: BusinessListingState[] }> {
  const listings = await businessListings(input.business, input.marketId);
  if (!listings.length) return {};
  const cleaned = input.text.replace(/^(?:منتج|عرض|صنف|طبق)\s+/u, "").trim();
  if (!cleaned || /^(?:هذا|هذه|هو|هي|الاخير|الأخير)$/u.test(cleaned)) {
    const ids = await latestCatalogIds(input.conversationId, input.actorId);
    if (ids.length === 1) return { listing: listings.find((row) => row.listingId === ids[0]) };
    return { ambiguous: listings };
  }
  const digit = /^(\d{1,2})$/u.exec(cleaned);
  if (digit) {
    const index = Number(digit[1]) - 1;
    const ids = (await latestCatalogIds(input.conversationId, input.actorId));
    const ordered = ids.map((id) => listings.find((row) => row.listingId === id)).filter(Boolean) as BusinessListingState[];
    const pool = ordered.length ? ordered : listings;
    return pool[index] ? { listing: pool[index] } : { ambiguous: pool };
  }
  const ordinal = ORDINALS[cleaned];
  if (ordinal) {
    const ids = await latestCatalogIds(input.conversationId, input.actorId);
    const ordered = ids.map((id) => listings.find((row) => row.listingId === id)).filter(Boolean) as BusinessListingState[];
    const pool = ordered.length ? ordered : listings;
    return pool[ordinal - 1] ? { listing: pool[ordinal - 1] } : { ambiguous: pool };
  }
  const normalized = normalizeSearch(cleaned);
  const byName = listings.filter((row) => {
    const title = normalizeSearch(row.title);
    return normalized.length >= 2 && (title.includes(normalized) || normalized.includes(title));
  });
  if (byName.length === 1) return { listing: byName[0] };
  if (byName.length > 1) return { ambiguous: byName };
  return { ambiguous: listings };
}

async function pendingReviewTurn(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  business: BusinessProfile;
  action: "PAUSE" | "RESUME" | "PRICE" | "STOCK_OUT" | "ACTIVATE";
  listing?: BusinessListingState;
  newPriceMinor?: number;
  lines: string[];
  title: string;
}): Promise<Turn> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + BUSINESS_ACTION_TTL_MS);
  await db.insert(aiResultSets).values({
    id,
    conversationId: input.conversationId,
    marketId: input.market.id,
    query: {
      kind: "BUSINESS_ACTION",
      ownerId: input.actorId,
      businessId: input.business.id,
      action: input.action,
      listingId: input.listing?.listingId ?? null,
      expectedUpdatedAt: input.listing?.updatedAt ?? null,
      newPriceMinor: input.newPriceMinor ?? null,
      status: "PENDING",
      review: input.lines,
      expiresAt: expiresAt.toISOString(),
    },
    resourceIds: input.listing ? [input.listing.listingId] : [input.business.id],
    expiresAt,
  });
  return businessOutput(
    "BUSINESS_LISTING_REVIEW",
    {
      view: "LISTING_REVIEW",
      businessId: input.business.id,
      businessName: input.business.displayName,
      listingId: input.listing?.listingId,
      title: input.title,
      lines: input.lines,
      pendingActionId: id,
      expiresAt: expiresAt.toISOString(),
      allowedActions: ["CONFIRM", "CANCEL"],
    },
    "راجع التغيير. أرسل «أكد» للتنفيذ أو «إلغاء» للتراجع. لن يُنفَّذ شيء قبل تأكيدك.",
  );
}

async function handleCatalogCommand(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  resolved: ResolvedBusiness;
  text: string;
  raw: string;
}): Promise<Turn | null> {
  const business = input.resolved.business;
  const access = input.resolved.access;
  const listings = await businessListings(business, input.market.id);

  if (has(input.text, CATALOG_INTENT) || has(input.text, COUNT_INTENT)) {
    if (!access.capabilities.has("business.catalog.read")) return deniedTurn(access);
    return catalogTurn({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      business,
      access,
      text: input.text,
      countOnly: has(input.text, COUNT_INTENT) && !has(input.text, CATALOG_INTENT),
    });
  }
  if (has(input.text, ORDERS_INTENT)) {
    if (!access.capabilities.has("business.orders.read")) return deniedTurn(access);
    return ordersTurn({ actorId: input.actorId, market: input.market, business, access });
  }
  if (has(input.text, INSIGHTS_INTENT)) {
    if (!access.capabilities.has("business.analytics.read")) return deniedTurn(access);
    return insightsTurn({ actorId: input.actorId, market: input.market, business, access });
  }
  if (has(input.text, PROFILE_INTENT)) {
    return resumeTurn({ conversationId: input.conversationId, actorId: input.actorId, market: input.market, rows: [business] });
  }
  if (has(input.text, DRAFTS_INTENT)) {
    return prepareDrafts({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      business,
      access,
      text: input.text,
      raw: input.raw,
    });
  }

  const priceMatch = PRICE_INTENT.exec(input.text);
  const pauseMatch = PAUSE_INTENT.exec(input.text);
  const resumeMatch = RESUME_INTENT_LISTING.exec(input.text);
  const stockMatch = STOCK_INTENT.exec(input.text);
  const priceAction = priceMatch ? await priceCommand(priceMatch[1] ?? "", input.market) : undefined;
  if (priceMatch && priceAction) {
    if (!access.capabilities.has("business.listing.update"))
      return deniedTurn(access, "تعديل السعر يحتاج صلاحية تحديث المنتجات.");
    const target = await resolveListingTarget({
      conversationId: input.conversationId,
      actorId: input.actorId,
      business,
      marketId: input.market.id,
      text: priceAction.target,
    });
    if (!target.listing)
      return ambiguousTargetTurn(target.ambiguous ?? listings, input.market, "أي منتج تريد تغيير سعره؟");
    if (target.listing.status === "PUBLISHED") {
      const blocked = publishGate(access);
      if (blocked) return blocked;
    }
    const row = await db.select().from(offers).where(eq(offers.id, target.listing.listingId)).then((rows) => rows[0]);
    if (!row) return ambiguousTargetTurn(listings, input.market, "لم أجد المنتج.");
    return pendingReviewTurn({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      business,
      action: "PRICE",
      listing: target.listing,
      newPriceMinor: priceAction.minor,
      title: `تغيير سعر «${target.listing.title}»`,
      lines: [
        `المنتج: «${target.listing.title}»`,
        `السعر الحالي: ${target.listing.priceMinor === null ? "غير محدد" : money(target.listing.priceMinor, input.market)}`,
        `السعر الجديد: ${money(priceAction.minor, input.market)}`,
      ],
    });
  }

  if (pauseMatch) {
    if (!access.capabilities.has("business.listing.update")) return deniedTurn(access, "إيقاف المنتج يحتاج صلاحية تحديث المنتجات.");
    const target = await resolveListingTarget({
      conversationId: input.conversationId,
      actorId: input.actorId,
      business,
      marketId: input.market.id,
      text: pauseMatch[1] ?? "",
    });
    if (!target.listing) return ambiguousTargetTurn(target.ambiguous ?? listings, input.market, "أي منتج تريد إيقافه؟");
    return pendingReviewTurn({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      business,
      action: "PAUSE",
      listing: target.listing,
      title: `إيقاف «${target.listing.title}»`,
      lines: [
        `المنتج: «${target.listing.title}»`,
        `الحالة الحالية: ${target.listing.status}`,
        "سيتوقف ظهوره للمشترين حتى تعيد تفعيله",
      ],
    });
  }

  if (resumeMatch) {
    if (!access.capabilities.has("business.listing.update")) return deniedTurn(access, "إعادة التفعيل تحتاج صلاحية تحديث المنتجات.");
    const target = await resolveListingTarget({
      conversationId: input.conversationId,
      actorId: input.actorId,
      business,
      marketId: input.market.id,
      text: resumeMatch[1] ?? "",
    });
    if (!target.listing) return ambiguousTargetTurn(target.ambiguous ?? listings, input.market, "أي منتج تريد إعادة تفعيله؟");
    const blocked = publishGate(access);
    if (blocked) return blocked;
    return pendingReviewTurn({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      business,
      action: "RESUME",
      listing: target.listing,
      title: `إعادة تفعيل «${target.listing.title}»`,
      lines: [
        `المنتج: «${target.listing.title}»`,
        "سيعود للظهور في نتائج البحث والسوق",
      ],
    });
  }

  if (stockMatch) {
    if (!access.capabilities.has("business.inventory.manage") && !access.capabilities.has("business.listing.update"))
      return deniedTurn(access, "إدارة المخزون تحتاج صلاحية المخزون.");
    const target = await resolveListingTarget({
      conversationId: input.conversationId,
      actorId: input.actorId,
      business,
      marketId: input.market.id,
      text: stockMatch[1] ?? "",
    });
    if (!target.listing) return ambiguousTargetTurn(target.ambiguous ?? listings, input.market, "أي منتج نفد مخزونه؟");
    return pendingReviewTurn({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      business,
      action: "STOCK_OUT",
      listing: target.listing,
      title: `إيقاف «${target.listing.title}» لنفاد المخزون`,
      lines: [
        `المنتج: «${target.listing.title}»`,
        "نفاد المخزون: يتوقف البيع فورًا حتى يتوفر المخزون",
        "الطلبات السابقة لا تتغير",
      ],
    });
  }
  return null;
}

async function priceCommand(rest: string, market: Market): Promise<{ target: string; minor: number } | undefined> {
  const match = /(\d+(?:[.,]\d{1,3})?)/u.exec(rest);
  if (!match) return undefined;
  const raw = match[1]!.replace(",", ".");
  const target = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`
    .replace(/(?:الى|إلى|ل|بـ|ب)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  try {
    const minor = parseListingPriceMinor(raw, market.currencyCode);
    if (!Number.isFinite(minor)) return undefined;
    return { target, minor };
  } catch {
    return undefined;
  }
}

function ambiguousTargetTurn(listings: BusinessListingState[], market: Market, prompt: string): Turn {
  return businessOutput(
    "BUSINESS_CATALOG",
    {
      view: "CATALOG",
      selection: true,
      listings: listings.slice(0, 6).map((row) => listingView(row, market)),
      allowedActions: [],
    },
    prompt,
  );
}

function deniedTurn(access: BusinessAccess, message = "لا تملك صلاحية هذا الإجراء على النشاط."): Turn {
  return businessOutput(
    "BUSINESS_PROFILE",
    { view: "PROFILE", businessId: access.business?.id, ...accessPayload(access), notice: message, allowedActions: [] },
    message,
  );
}

/** A live publication-facing change needs the same gate as publishing; refuse honestly. */
function publishGate(access: BusinessAccess): Turn | undefined {
  try {
    assertPublishable(access);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "لا يمكن تعديل منشور الآن.";
    return businessOutput(
      "BUSINESS_LISTING_REVIEW",
      { view: "LISTING_REVIEW", businessId: access.business?.id, notice: message, allowedActions: [] },
      `${message} لم يتغير شيء.`,
    );
  }
}

// ─── Three typed drafts ──────────────────────────────────────────────────────

const CATEGORY_FALLBACK: Record<string, string[]> = {
  RESTAURANT: ["مطاعم", "مطعم", "طعام", "وجبات", "اكل"],
  SHOP: ["متجر", "تسوق", "منتجات"],
  SERVICE_PROVIDER: ["خدمات", "خدمه", "خدمة"],
};

async function resolveCategoryFor(
  text: string,
  businessType: string,
): Promise<MarketplaceCategoryRow | undefined> {
  const categories = await listMarketplaceCategories(true);
  const normalized = ` ${normalizeSearch(text)} `;
  const explicit = categories
    .flatMap((row) => [row.label, ...row.aliases].map((alias) => ({ row, alias: normalizeSearch(alias) })))
    .filter(({ alias }) => alias.length >= 2 && normalized.includes(` ${alias} `))
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  if (explicit) return explicit.row;
  const fallbackWords = CATEGORY_FALLBACK[businessType] ?? [];
  const byType = categories.find((row) =>
    [row.label, ...row.aliases].some((alias) => fallbackWords.includes(normalizeSearch(alias))),
  );
  // No category matched: «أخرى» is the honest generic shelf, never a guessed specialised one.
  return byType ?? categories.find((row) => row.id === "other");
}

function splitDraftItems(rest: string): string[] {
  let parts = rest.split(/[،,؛;\n]+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) parts = rest.split(/\s+و\s+/u).map((part) => part.trim()).filter(Boolean);
  // Unpunctuated Arabic lists still end one item where a price is followed by a new word.
  if (parts.length < 2)
    parts = rest
      .split(/(?<=\d(?:[.,]\d{1,3})?)\s+(?=\p{L})/u)
      .map((part) => part.trim())
      .filter(Boolean);
  return parts.slice(0, 6);
}

function draftDescription(title: string, businessName: string): string {
  // The canonical listing body requires a real description; the item's own name alone can be
  // shorter than the minimum, so the seller's business name (never an invented claim) completes it.
  const base = `${title} — ${businessName}`.trim();
  return (base.length >= 10 ? base : `${base} — متاح عبر DINAR`).slice(0, 240);
}

async function prepareDrafts(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  business: BusinessProfile;
  access: BusinessAccess;
  text: string;
  raw: string;
}): Promise<Turn> {
  if (!input.access.capabilities.has("business.catalog.draft"))
    return deniedTurn(input.access, "إعداد المسودات يحتاج صلاحية مسودات الكتالوج.");
  // Prices and Arabic commas survive in the raw message; the normalized text only proves intent.
  const rawRest = /(?:ثلاث|3|ثلاثه|ثلاثة)\s+(?:عروض|منتجات|اصناف|أصناف|اطباق|أطباق)\s*[:：]?\s*(.*)$/u.exec(
    input.raw,
  )?.[1];
  const rest = (rawRest ?? DRAFTS_INTENT.exec(input.text)?.[1] ?? "").replace(/^\s*[:：]\s*/u, "").trim();
  const parts = splitDraftItems(rest);
  const area = typeof input.business.profile?.area === "string" ? input.business.profile.area : "";
  const fulfilment = typeof input.business.profile?.fulfilment === "string" ? input.business.profile.fulfilment : "PICKUP";
  const drafts: Record<string, unknown>[] = [];
  for (const part of parts) {
    const priceMatch = /(\d+(?:[.,]\d{1,3})?)\s*(?:دينار|دنانير|ريال|درهم|KWD|KD)?\s*$/iu.exec(part);
    if (!priceMatch) continue;
    const title = part.slice(0, priceMatch.index).trim();
    if (title.length < 2) continue;
    const category = await resolveCategoryFor(`${title} ${input.business.businessType}`, input.business.businessType);
    const minor = parseListingPriceMinor(priceMatch[1]!.replace(",", "."), input.market.currencyCode);
    drafts.push({
      draftId: randomUUID(),
      title: title.slice(0, 120),
      description: draftDescription(title, input.business.displayName),
      priceMinor: minor,
      price: money(minor, input.market),
      currency: input.market.currencyCode,
      category: category?.label ?? null,
      categoryId: category?.id ?? null,
      area,
      fulfilment,
    });
  }
  if (!drafts.length) {
    return businessOutput(
      "BUSINESS_CATALOG_DRAFT",
      { view: "CATALOG_DRAFT", businessId: input.business.id, drafts: [], empty: true, allowedActions: [] },
      "لم أستخرج أصنافًا وأسعارًا. اكتب مثلًا: «جهز لي ثلاث عروض: شاورما 2.500، برجر 3.250، عصير 1.000».",
    );
  }
  const id = randomUUID();
  await db.insert(aiResultSets).values({
    id,
    conversationId: input.conversationId,
    marketId: input.market.id,
    query: {
      kind: "BUSINESS_CATALOG_DRAFT",
      ownerId: input.actorId,
      businessId: input.business.id,
      drafts,
      status: "PENDING",
    },
    resourceIds: [],
    expiresAt: new Date(Date.now() + BUSINESS_ACTION_TTL_MS),
  });
  return businessOutput(
    "BUSINESS_CATALOG_DRAFT",
    {
      view: "CATALOG_DRAFT",
      businessId: input.business.id,
      businessName: input.business.displayName,
      resultSetId: id,
      drafts,
      ...accessPayload(input.access),
      blockedReason: publicationNotice(input.access),
      allowedActions: ["PUBLISH"],
    },
    `جهزت ${drafts.length} مسودة. لن يُنشر شيء قبل مراجعتك وتأكيدك؛ ${
      input.access.publishable ? "ويمكنك نشرها بعد المراجعة." : "والنشر ينتظر اعتماد هوية النشاط."
    }`,
  );
}

async function publishDraftTurn(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  business: BusinessProfile;
  access: BusinessAccess;
  text: string;
}): Promise<Turn> {
  const [set] = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, input.conversationId),
      sql`${aiResultSets.query} ->> 'kind' = 'BUSINESS_CATALOG_DRAFT'`,
      sql`${aiResultSets.query} ->> 'ownerId' = ${input.actorId}`,
      sql`${aiResultSets.query} ->> 'businessId' = ${input.business.id}`,
    ))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const drafts = Array.isArray((set?.query as { drafts?: unknown })?.drafts)
    ? ((set!.query as { drafts: Record<string, unknown>[] }).drafts)
    : [];
  if (!drafts.length)
    return businessOutput("BUSINESS_CATALOG_DRAFT", { view: "CATALOG_DRAFT", businessId: input.business.id, drafts: [], empty: true, allowedActions: [] }, "لا توجد مسودات محفوظة. جهز المسودات أولًا.");
  const number = /(\d+)/u.exec(input.text)?.[1];
  const draft = number ? drafts[Number(number) - 1] : drafts.length === 1 ? drafts[0] : undefined;
  if (!draft)
    return businessOutput(
      "BUSINESS_CATALOG_DRAFT",
      { view: "CATALOG_DRAFT", businessId: input.business.id, drafts, allowedActions: [] },
      "أي مسودة تريد نشرها؟ اذكر رقمها.",
    );
  // The owner's honest reason first: an unverified identity is pending approval, not a missing
  // permission they could grant themselves. Staff still need the explicit publish grant.
  if (input.access.role === "OWNER") {
    const gate = publishGate(input.access);
    if (gate) return gate;
  }
  if (!input.access.capabilities.has("business.catalog.publish"))
    return deniedTurn(input.access, "النشر يحتاج صلاحية نشر كتالوج النشاط.");
  if (typeof draft.category !== "string" || !draft.category.trim())
    return businessOutput(
      "BUSINESS_CATALOG_DRAFT",
      { view: "CATALOG_DRAFT", businessId: input.business.id, drafts, allowedActions: [] },
      "لم أتعرّف على تصنيف هذه المسودة. اذكر التصنيف (مثل «مطاعم») ثم أعد إعداد المسودات.",
    );
  if (!String(draft.area ?? "").trim())
    return businessOutput(
      "BUSINESS_CATALOG_DRAFT",
      { view: "CATALOG_DRAFT", businessId: input.business.id, drafts, allowedActions: [] },
      "منطقة النشاط غير محددة؛ أكملها من إعدادات النشاط قبل النشر.",
    );
  const body = {
    title: String(draft.title ?? ""),
    description: String(draft.description ?? draft.title ?? ""),
    category: String(draft.category ?? ""),
    ...(typeof draft.categoryId === "string" ? { categoryId: draft.categoryId } : {}),
    area: String(draft.area ?? ""),
    unitPrice: (Number(draft.priceMinor) / 10 ** input.market.minorUnitScale).toFixed(input.market.minorUnitScale),
    pricingMode: "FIXED" as const,
    inventoryMode: "UNLIMITED" as const,
    fulfilmentType: draft.fulfilment === "DELIVERY" ? "DELIVERY" as const : draft.fulfilment === "SERVICE" ? "SERVICE" as const : "PICKUP" as const,
    imageUrl: "",
    imageUrls: [],
    paymentMethods: input.market.paymentMethods.includes("CASH_DIRECT") ? ["CASH_DIRECT" as const] : ["CARD" as const],
  };
  const actionId = randomUUID();
  const expiresAt = new Date(Date.now() + BUSINESS_ACTION_TTL_MS);
  await db.insert(aiResultSets).values({
    id: actionId,
    conversationId: input.conversationId,
    marketId: input.market.id,
    query: {
      kind: "BUSINESS_ACTION",
      ownerId: input.actorId,
      businessId: input.business.id,
      action: "PUBLISH_DRAFT",
      listingId: null,
      body,
      idempotencyKey: String(draft.draftId ?? randomUUID()),
      status: "PENDING",
      review: [`نشر «${body.title}»`, `السعر: ${money(Number(draft.priceMinor), input.market)}`],
      expiresAt: expiresAt.toISOString(),
    },
    resourceIds: [],
    expiresAt,
  });
  return businessOutput(
    "BUSINESS_LISTING_REVIEW",
    {
      view: "LISTING_REVIEW",
      businessId: input.business.id,
      businessName: input.business.displayName,
      title: `نشر «${body.title}»`,
      lines: [`المنتج: «${body.title}»`, `السعر: ${money(Number(draft.priceMinor), input.market)}`, "سيدخل السوق فور التأكيد إن كان النشاط معتمدًا"],
      pendingActionId: actionId,
      expiresAt: expiresAt.toISOString(),
      allowedActions: ["CONFIRM", "CANCEL"],
    },
    "راجع النشر. أرسل «أكد» للتنفيذ أو «إلغاء» للتراجع.",
  );
}

// ─── Confirmation ────────────────────────────────────────────────────────────

type PendingBusinessQuery = {
  kind: "BUSINESS_ACTION";
  ownerId: string;
  businessId: string;
  action: "PAUSE" | "RESUME" | "PRICE" | "STOCK_OUT" | "PUBLISH_DRAFT";
  listingId: string | null;
  expectedUpdatedAt: string | null;
  newPriceMinor: number | null;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  status: "PENDING" | "EXECUTING" | "CONFIRMED" | "CANCELLED" | "EXPIRED" | "FAILED" | "SUPERSEDED" | "UNKNOWN";
  executingAt?: string;
  review: string[];
  expiresAt: string;
};

async function pendingBusinessAction(conversationId: string, actorId: string, actionId: string) {
  const [row] = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.id, actionId),
      eq(aiResultSets.conversationId, conversationId),
      sql`${aiResultSets.query} ->> 'kind' = 'BUSINESS_ACTION'`,
      sql`${aiResultSets.query} ->> 'ownerId' = ${actorId}`,
      sql`${aiResultSets.query} ->> 'status' = 'PENDING'`,
    ))
    .limit(1);
  if (!row) return undefined;
  const query = row.query as PendingBusinessQuery;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
  return { row, query };
}

async function supersedeVisibleBusinessReview(conversationId: string, actorId: string, actionId?: string) {
  if (!actionId) return;
  const [row] = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.id, actionId),
      eq(aiResultSets.conversationId, conversationId),
      sql`${aiResultSets.query} ->> 'ownerId' = ${actorId}`,
      sql`${aiResultSets.query} ->> 'kind' IN ('BUSINESS_SETUP', 'BUSINESS_ACTION')`,
      sql`${aiResultSets.query} ->> 'status' = 'PENDING'`,
    ))
    .limit(1);
  if (!row) return;
  await db
    .update(aiResultSets)
    .set({ query: { ...row.query, status: "SUPERSEDED" } })
    .where(and(
      eq(aiResultSets.id, row.id),
      sql`${aiResultSets.query} ->> 'status' = 'PENDING'`,
    ));
}

/** The newest decision record in this conversation: in flight, or already settled. */
async function settledBusinessDecision(conversationId: string, actorId: string) {
  const [row] = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, conversationId),
      sql`${aiResultSets.query} ->> 'kind' IN ('BUSINESS_SETUP', 'BUSINESS_ACTION')`,
      sql`${aiResultSets.query} ->> 'ownerId' = ${actorId}`,
      sql`${aiResultSets.query} ->> 'status' IN ('EXECUTING', 'UNKNOWN', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED', 'SUPERSEDED')`,
    ))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  return row;
}

async function setupReviewPending(conversationId: string, actorId: string, reviewId: string) {
  const [row] = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.id, reviewId),
      eq(aiResultSets.conversationId, conversationId),
      sql`${aiResultSets.query} ->> 'kind' = 'BUSINESS_SETUP'`,
      sql`${aiResultSets.query} ->> 'ownerId' = ${actorId}`,
      sql`${aiResultSets.query} ->> 'status' = 'PENDING'`,
    ))
    .limit(1);
  return row;
}

async function activateBusiness(input: {
  conversationId: string;
  actorId: string;
  marketId: string;
  reviewId: string;
}): Promise<Turn> {
  const review = await setupReviewPending(input.conversationId, input.actorId, input.reviewId);
  if (!review) return businessOutput("BUSINESS_PROFILE_REVIEW", { view: "PROFILE_REVIEW", allowedActions: [] }, "لا توجد مراجعة تشغيل معلّقة؛ راجع النشاط من جديد.");
  const query = review.query as { businessId?: string; expectedVersion?: number; status?: string };
  if (query.status !== "PENDING") return businessOutput("BUSINESS_PROFILE_REVIEW", { view: "PROFILE_REVIEW", allowedActions: [] }, "تمت معالجة هذه المراجعة من قبل.");
  if (review.expiresAt && review.expiresAt.getTime() <= Date.now()) {
    await db.update(aiResultSets).set({ query: { ...review.query, status: "EXPIRED" } }).where(eq(aiResultSets.id, review.id));
    return businessOutput("BUSINESS_PROFILE_REVIEW", { view: "PROFILE_REVIEW", allowedActions: [] }, "انتهت صلاحية هذه المراجعة. راجع النشاط من جديد.");
  }
  const business = await ownedBusinessFor(input.actorId, input.marketId, query.businessId);
  if (!business) return businessOutput("BUSINESS_PROFILE", { view: "PROFILE", allowedActions: [] }, "النشاط غير موجود.");
  // Activating the D3 operating profile only makes the business manageable inside DINAR.
  // D2 verification and publication eligibility remain mandatory for public listing writes.
  await requireBusinessCapability({ business, actorId: input.actorId, marketId: input.marketId, capability: "business.profile.manage" });
  // One claim only: a second confirmation sees a settled review and changes nothing.
  const [claimed] = await db
    .update(aiResultSets)
    .set({ query: { ...review.query, status: "EXECUTING", executingAt: new Date().toISOString() } })
    .where(and(
      eq(aiResultSets.id, review.id),
      sql`${aiResultSets.query} ->> 'status' = 'PENDING'`,
    ))
    .returning();
  if (!claimed) return businessOutput("BUSINESS_PROFILE_REVIEW", { view: "PROFILE_REVIEW", allowedActions: [] }, "تمت معالجة هذه المراجعة من قبل؛ لم يتغير شيء.");
  try {
    const [updatedRow] = await db
      .update(businessOperatingProfiles)
      .set({ status: "ACTIVE", version: business.version + 1, updatedAt: new Date() })
      .where(and(eq(businessOperatingProfiles.id, business.id), eq(businessOperatingProfiles.version, business.version)))
      .returning();
    if (!updatedRow) throw Object.assign(new Error("تغيّر النشاط منذ المراجعة؛ أعد المراجعة."), { status: 409 });
    const updated = await businessWithD2Identity(updatedRow);
    await recordBusinessAudit({
      businessId: business.id,
      actorId: input.actorId,
      action: "BUSINESS_ACTIVATED",
      resourceType: "BUSINESS",
      resourceId: business.id,
      detail: { operatingMode: "INTERNAL_DINAR", identityStatus: updated.identityStatus },
    });
    await db.update(aiResultSets).set({ query: { ...claimed.query, status: "CONFIRMED" } }).where(eq(aiResultSets.id, review.id));
    const refreshed = await resolveBusinessAccess({ business: updated, actorId: input.actorId, marketId: input.marketId });
    const notice = publicationNotice(refreshed);
    return businessOutput(
      "BUSINESS_PROFILE",
      {
        view: "PROFILE",
        businessId: updated.id,
        name: updated.displayName,
        description: updated.description,
        businessType: updated.businessType,
        businessTypeLabel: TYPE_LABELS[updated.businessType] ?? "نشاط",
        status: updated.status,
        operatingMode: updated.operatingMode,
        identityStatus: updated.identityStatus,
        ...accessPayload(refreshed),
        blockedReason: notice,
        publicPath: `/business/${updated.id}`,
        allowedActions: refreshed.capabilities.has("business.catalog.read") ? ["CATALOG", "ORDERS", "INSIGHTS"] : [],
      },
      `تم تشغيل «${updated.displayName}» داخل DINAR. ${notice ?? "يمكنك الآن إدارة منتجاتك وطلباتك من المحادثة."}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "تعذر تشغيل النشاط.";
    await db.update(aiResultSets).set({ query: { ...claimed.query, status: "FAILED" } }).where(eq(aiResultSets.id, review.id));
    return businessOutput("BUSINESS_PROFILE_REVIEW", { view: "PROFILE_REVIEW", notice: message, allowedActions: [] }, `${message} لم يتغير شيء.`);
  }
}

async function ownedBusinessFor(actorId: string, marketId: string, businessId?: string) {
  if (!businessId) return undefined;
  return ownedBusinessForActor({ businessId, actorId, marketId });
}

async function cancelBusinessAction(input: { conversationId: string; actorId: string; actionId: string }): Promise<Turn | null> {
  const pending = await pendingBusinessAction(input.conversationId, input.actorId, input.actionId);
  if (!pending) return null;
  await db
    .update(aiResultSets)
    .set({ query: { ...pending.query, status: "CANCELLED" } })
    .where(and(eq(aiResultSets.id, pending.row.id), sql`${aiResultSets.query} ->> 'status' = 'PENDING'`));
  return businessOutput(
    "BUSINESS_PROFILE",
    { view: "PROFILE", businessId: pending.query.businessId, notice: "أُلغي الإجراء. لم يتغير شيء.", allowedActions: [] },
    "أُلغي الإجراء. لم يتغير شيء.",
  );
}

/** A reviewed setup can be abandoned: the card offered CANCEL, so CANCEL must settle it. */
async function cancelSetupReview(conversationId: string, actorId: string, reviewId: string): Promise<Turn | null> {
  const review = await setupReviewPending(conversationId, actorId, reviewId);
  if (!review) return null;
  const query = review.query as { businessId?: string; status?: string };
  if (query.status !== "PENDING") return null;
  await db
    .update(aiResultSets)
    .set({ query: { ...review.query, status: "CANCELLED" } })
    .where(and(eq(aiResultSets.id, review.id), sql`${aiResultSets.query} ->> 'status' = 'PENDING'`));
  const message = "أُلغي التشغيل. بقي النشاط مسودة ولم يتغير شيء.";
  return businessOutput(
    "BUSINESS_PROFILE_REVIEW",
    { view: "PROFILE_REVIEW", businessId: query.businessId, notice: message, allowedActions: [] },
    message,
  );
}

async function executeBusinessAction(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  actionId: string;
}): Promise<Turn | null> {
  const pending = await pendingBusinessAction(input.conversationId, input.actorId, input.actionId);
  if (!pending) return null;
  const { row, query } = pending;
  const [claimed] = await db
    .update(aiResultSets)
    .set({ query: { ...query, status: "EXECUTING", executingAt: new Date().toISOString() } })
    .where(and(eq(aiResultSets.id, row.id), sql`${aiResultSets.query} ->> 'status' = 'PENDING'`))
    .returning();
  if (!claimed) return businessOutput("BUSINESS_LISTING_REVIEW", { view: "LISTING_REVIEW", allowedActions: [] }, "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء.");
  const business = await ownedBusinessFor(input.actorId, input.market.id, query.businessId);
  if (!business) return businessOutput("BUSINESS_PROFILE", { view: "PROFILE", allowedActions: [] }, "النشاط غير موجود.");
  try {
    if (query.action === "PUBLISH_DRAFT") {
      const created = await publishBusinessDraft({
        businessId: business.id,
        actor: await actorRow(input.actorId),
        market: input.market,
        body: query.body,
        idempotencyKey: query.idempotencyKey ?? row.id,
      });
      await db.update(aiResultSets).set({ query: { ...claimed.query, status: "CONFIRMED" } }).where(eq(aiResultSets.id, row.id));
      return businessOutput(
        "BUSINESS_PROFILE",
        {
          view: "PROFILE",
          businessId: business.id,
          name: business.displayName,
          status: business.status,
          notice: `نُشر «${created.listing.title}».`,
          allowedActions: ["CATALOG"],
        },
        `نُشر «${created.listing.title}» في السوق.`,
      );
    }
    if (!query.listingId) throw Object.assign(new Error("لم يعد المنتج موجودًا."), { status: 404 });
    if (query.action === "PRICE") {
      const current = await db.select().from(offers).where(eq(offers.id, query.listingId)).then((rows) => rows[0]);
      if (!current) throw Object.assign(new Error("لم يعد المنتج موجودًا."), { status: 404 });
      const body = buildListingUpdateBody(current, input.market);
      if (query.newPriceMinor === null || query.newPriceMinor === undefined) throw Object.assign(new Error("سعر غير صالح."), { status: 400 });
      body.unitPrice = (query.newPriceMinor / 10 ** input.market.minorUnitScale).toFixed(input.market.minorUnitScale);
      await updateBusinessListing({
        businessId: business.id,
        listingId: query.listingId,
        actorId: input.actorId,
        market: input.market,
        body,
        expectedUpdatedAt: query.expectedUpdatedAt ?? undefined,
      });
    } else if (query.action === "PAUSE" || query.action === "STOCK_OUT") {
      await changeBusinessListingStatus({
        businessId: business.id,
        listingId: query.listingId,
        actorId: input.actorId,
        market: input.market,
        action: "PAUSE",
        expectedUpdatedAt: query.expectedUpdatedAt ?? undefined,
      });
    } else if (query.action === "RESUME") {
      await changeBusinessListingStatus({
        businessId: business.id,
        listingId: query.listingId,
        actorId: input.actorId,
        market: input.market,
        action: "RESUME",
        expectedUpdatedAt: query.expectedUpdatedAt ?? undefined,
      });
    }
    await db.update(aiResultSets).set({ query: { ...claimed.query, status: "CONFIRMED" } }).where(eq(aiResultSets.id, row.id));
    const access = await resolveBusinessAccess({ business, actorId: input.actorId, marketId: input.market.id });
    const listings = await businessListings(business, input.market.id);
    return businessOutput(
      "BUSINESS_CATALOG",
      {
        view: "CATALOG",
        businessId: business.id,
        name: business.displayName,
        ...accessPayload(access),
        summary: await businessCatalogSummary(business, input.market.id),
        listings: listings.slice(0, 24).map((row) => listingView(row, input.market)),
        notice: query.action === "PRICE" ? "تم تحديث السعر." : query.action === "RESUME" ? "أُعيد تفعيل المنتج." : "أُوقف المنتج ولم يعد ظاهرًا للمشترين.",
        blockedReason: publicationNotice(access),
        allowedActions: ["PAUSE", "RESUME", "PRICE", "STOCK_OUT", "DRAFTS"],
      },
      query.action === "PRICE" ? "تم تحديث السعر." : query.action === "RESUME" ? "أُعيد تفعيل المنتج." : "أُوقف المنتج ولم يعد ظاهرًا للمشترين.",
    );
  } catch (error) {
    // A Zod failure is a raw developer message: the seller needs an actionable Arabic sentence.
    const message =
      error instanceof Error
        ? (error as { name?: string }).name === "ZodError"
          ? "بيانات المسودة غير مكتملة؛ أعد إعداد المسودات ثم انشرها من جديد."
          : error.message
        : "تعذر تنفيذ الإجراء.";
    const status = (error as { status?: number }).status;
    await db.update(aiResultSets).set({ query: { ...claimed.query, status: "FAILED", notice: message } }).where(eq(aiResultSets.id, row.id));
    return businessOutput(
      "BUSINESS_LISTING_REVIEW",
      {
        view: "LISTING_REVIEW",
        businessId: business.id,
        notice: message,
        stale: status === 409,
        allowedActions: [],
      },
      `${message} لم يتغير شيء.`,
    );
  }
}

async function actorRow(actorId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, actorId));
  if (!row) throw Object.assign(new Error("الحساب غير موجود."), { status: 404 });
  return row;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function latestBusinessPrompt(conversationId: string): Promise<BusinessPayload | undefined> {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const business = block?.payload?.business as BusinessPayload | undefined;
  return business && typeof business.view === "string" ? business : undefined;
}

export async function executeBusinessTurn(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  if (!input.actorId) return null;
  const text = normalizeBusinessText(input.message);
  if (!text) return null;
  const actorId = input.actorId;

  // A bare «أكد»/«إلغاء» belongs to the business only while a business card is the last thing
  // the conversation showed; otherwise it belongs to whatever review the user is answering.
  const lastPrompt = await latestBusinessPrompt(input.conversationId);
  if (DECISION.test(text) && lastPrompt) {
    if (lastPrompt.view === "PROFILE_REVIEW" && lastPrompt.pendingActionId)
      return activateBusiness({
        conversationId: input.conversationId,
        actorId,
        marketId: input.market.id,
        reviewId: lastPrompt.pendingActionId,
      });
    if (lastPrompt.view === "LISTING_REVIEW" && lastPrompt.pendingActionId)
      return executeBusinessAction({
        conversationId: input.conversationId,
        actorId,
        market: input.market,
        actionId: lastPrompt.pendingActionId,
      });
    // Nothing is pending: a repeated «أكد» over a settled business card is answered honestly and
    // executes nothing, instead of falling through to an unrelated handler.
    if (["LISTING_REVIEW", "PROFILE_REVIEW", "PROFILE", "CATALOG"].includes(lastPrompt.view)) {
      const settled = await settledBusinessDecision(input.conversationId, actorId);
      if (settled) {
        const status = (settled.query as { status?: string }).status;
        const message =
          status === "EXECUTING"
            ? "هذا الإجراء قيد المعالجة؛ لن يُنفَّذ مرتين."
            : status === "UNKNOWN"
              ? "لم يتأكد تنفيذ هذا الإجراء؛ راجع النشاط ثم أعد المحاولة."
              : "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء.";
        return businessOutput(
          "BUSINESS_PROFILE_REVIEW",
          { view: "LISTING_REVIEW", businessId: lastPrompt.businessId, notice: message, allowedActions: [] },
          message,
        );
      }
    }
  }
  if (CANCEL.test(text) && lastPrompt?.pendingActionId) {
    if (lastPrompt.view === "LISTING_REVIEW") {
      const cancelled = await cancelBusinessAction({
        conversationId: input.conversationId,
        actorId,
        actionId: lastPrompt.pendingActionId,
      });
      if (cancelled) return cancelled;
    }
    if (lastPrompt.view === "PROFILE_REVIEW") {
      const cancelled = await cancelSetupReview(input.conversationId, actorId, lastPrompt.pendingActionId);
      if (cancelled) return cancelled;
    }
  }
  if (!DECISION.test(text) && !CANCEL.test(text) && lastPrompt?.pendingActionId)
    await supersedeVisibleBusinessReview(input.conversationId, actorId, lastPrompt.pendingActionId);

  const setupIntent = SETUP_INTENT.some((pattern) => has(text, pattern));
  if (setupIntent) {
    return startSetup({ conversationId: input.conversationId, actorId, market: input.market, text: input.message });
  }

  const resolved = await resolveBusiness({ actorId, marketId: input.market.id, text });
  if (!resolved) return null;

  if (resolved.ambiguous) {
    return selectionTurn(resolved.rows, "لديك أكثر من نشاط. اختر النشاط الذي تريد إدارته:");
  }

  const publishDraft = /^انشر\s+(?:المسوده|المسودة|مسوده|مسودة)\s*(\d+)?/u.test(text);
  if (publishDraft) {
    return publishDraftTurn({
      conversationId: input.conversationId,
      actorId,
      market: input.market,
      business: resolved.business,
      access: resolved.access,
      text,
    });
  }

  const command = await handleCatalogCommand({
    conversationId: input.conversationId,
    actorId,
    market: input.market,
    resolved,
    text,
    raw: input.message,
  });
  if (command) return command;

  if (RESUME_INTENT.test(text) || /^افتح\s+نشاط\s+/u.test(text)) {
    return resumeTurn({
      conversationId: input.conversationId,
      actorId,
      market: input.market,
      rows: [resolved.business],
    });
  }

  // A short reply to the last setup question advances that draft; nothing else is claimed.
  const prompt = await latestBusinessPrompt(input.conversationId);
  if (
    prompt?.view === "SETUP" &&
    prompt.businessId === resolved.business.id &&
    resolved.business.status === "DRAFT" &&
    wordCount(input.message) <= 24 &&
    !/[؟?]/u.test(input.message)
  ) {
    return answerSetupStep({
      conversationId: input.conversationId,
      actorId,
      marketId: input.market.id,
      business: resolved.business,
      access: resolved.access,
      text,
      raw: input.message,
    });
  }
  return null;
}

function wordCount(message: string): number {
  return message.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Rebuilds a stored business card from server rows for a reload or another tab. The payload is
 * display-only; actions always re-enter this adapter.
 */
export async function refreshBusinessPayload(
  payload: BusinessPayload,
  conversationId: string,
  actorId: string,
  market: Market,
): Promise<BusinessPayload | undefined> {
  if (!payload.businessId) return payload;
  const business = await ownedBusinessFor(actorId, market.id, payload.businessId);
  if (!business) return undefined;
  const access = await resolveBusinessAccess({ business, actorId, marketId: market.id });
  if (access.actorClass === "NONE") return undefined;
  const base = { ...accessPayload(access), businessId: business.id, name: business.displayName, status: business.status, identityStatus: business.identityStatus };
  switch (payload.view) {
    case "SETUP":
      // A setup card for a business that is no longer a draft is a superseded step, not a state.
      return business.status === "DRAFT"
        ? { ...payload, ...base, businessType: business.businessType, businessTypeLabel: TYPE_LABELS[business.businessType] ?? "نشاط", publishable: access.publishable }
        : undefined;
    case "PROFILE_REVIEW": {
      if (payload.pendingActionId) {
        const [review] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, String(payload.pendingActionId)));
        const status = (review?.query as { status?: string } | undefined)?.status;
        if (!review || status !== "PENDING") return undefined;
      }
      return { ...payload, ...base, businessType: business.businessType, businessTypeLabel: TYPE_LABELS[business.businessType] ?? "نشاط", publishable: access.publishable };
    }
    case "PROFILE":
      return { ...payload, ...base, blockedReason: publicationNotice(access), publicPath: business.status === "ACTIVE" ? `/business/${business.id}` : undefined };
    case "CATALOG": {
      const listings = await businessListings(business, market.id);
      return {
        ...payload,
        ...base,
        summary: await businessCatalogSummary(business, market.id),
        listings: listings.slice(0, 24).map((row) => listingView(row, market)),
        blockedReason: publicationNotice(access),
      };
    }
    case "CATALOG_DRAFT": {
      if (!payload.resultSetId) return payload;
      const [row] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, String(payload.resultSetId)));
      const query = row?.query as { kind?: string; ownerId?: string; businessId?: string; drafts?: unknown } | undefined;
      if (!query || query.kind !== "BUSINESS_CATALOG_DRAFT" || query.ownerId !== actorId || query.businessId !== business.id) return undefined;
      return { ...payload, ...base, drafts: Array.isArray(query.drafts) ? query.drafts : [], blockedReason: publicationNotice(access) };
    }
    case "LISTING_REVIEW": {
      if (!payload.pendingActionId) return payload;
      const [row] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, String(payload.pendingActionId)));
      const query = row?.query as PendingBusinessQuery | undefined;
      if (!query || query.kind !== "BUSINESS_ACTION" || query.ownerId !== actorId || query.businessId !== business.id) return undefined;
      return {
        ...payload,
        ...base,
        lines: query.review,
        pendingActionId: query.status === "PENDING" ? row!.id : undefined,
        allowedActions: query.status === "PENDING" ? ["CONFIRM", "CANCEL"] : [],
        notice: query.status === "PENDING" ? undefined : "تمت معالجة هذا الإجراء.",
      };
    }
    case "ORDERS":
      return { ...payload, ...base, orders: (await businessOrders(business, market.id)).map((order) => ({ ...order, total: `${(order.sellerAmountMinor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale)} ${order.currencyCode}` })) };
    case "INSIGHTS": {
      const insights = await businessAnalytics(business, market.id);
      return { ...payload, ...base, insights: { ...insights, completedRevenue: `${(insights.completedRevenueMinor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale)} ${market.currencyCode}` } };
    }
    default:
      return undefined;
  }
}
