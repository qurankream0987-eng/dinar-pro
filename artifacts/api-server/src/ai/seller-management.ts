import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  aiResultSets,
  aiUiBlocks,
  conversations,
  db,
  negotiations,
  offers,
  orderItems,
  orders,
} from "@workspace/db";
import { comparablePrices } from "../lib/recommendations";
import { campaignAnalytics, servingCampaignsFor } from "../lib/promotions";
import type { ClaimKind, SellerListingFacts } from "./model-turn";
import { SellerBusinessInsight } from "@workspace/api-zod/conversation-runtime";
import { buildDraftReview, ConversationDraft } from "./listing-draft";
import { listMarketplaceCategories } from "../lib/marketplace-categories";
import { UpdateListingBody } from "@workspace/api-zod";
import {
  sellerEmployeeDraftBinding,
  sellerEmployeeDraftBindingMatches,
} from "../lib/business-delegations";
import {
  type ListingPricingMode,
  type MarketplaceCategorySchema,
} from "@workspace/api-zod/marketplace-schemas";
import type { marketFor } from "../lib/markets";
import { searchMarketplaceListings } from "../lib/marketplace-listings";
import {
  archiveOwnedListing,
  buildListingUpdateBody,
  changeOwnedListingStatus,
  parseListingPriceMinor,
  updateOwnedListing,
} from "../lib/listing-management";
import { listingSource, sourceControlledMessage } from "../lib/provider-source";
import { normalizeListingContactPhone } from "../lib/listing-contact";
import {
  categorySchema as schemaFromRow,
  resolveMarketplaceCategory,
} from "../lib/marketplace-categories";
import { normalizeSearch, resultPosition } from "./search-context";
import { explicitListingOrdinal } from "./arabic-normalization";
import { parseCommandNumbers } from "./action-foundation";
import type { ToolResult } from "./tool-registry";
import { isAiUsageQuestion } from "./usage-intent";
import { SALES_QUESTION, salesPrompt, sellerSalesInsight } from "./seller-sales";

type Market = Awaited<ReturnType<typeof marketFor>>;
type SurfaceTurn = { tool: string; version: 1; result: ToolResult };

const PreviewQuery = z
  .object({
    kind: z.literal("LISTING_PREVIEW"),
    ownerId: z.string().min(1),
    listingId: z.string().min(1),
    operation: z.enum(["UPDATE", "PAUSE", "RESUME", "ARCHIVE"]),
    status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"]),
    expectedUpdatedAt: z.string().datetime(),
    updateBody: z.record(z.string(), z.unknown()).optional(),
    fieldLabel: z.string().min(1).max(40),
    beforeValue: z.string().max(500),
    afterValue: z.string().max(500),
    listingTitle: z.string().min(1).max(250),
    /** The seller's words, so a stale confirmation can be re-reviewed with current values. */
    request: z.string().max(2000).optional(),
    reason: z.enum(["SOLD"]).optional(),
  })
  .strict();

const SellerContextQuery = z
  .object({
    kind: z.literal("SELLER_CONTEXT"),
    ownerId: z.string().min(1),
  })
  .strict();

export type ListingManagementPreview = {
  previewId: string;
  action: "UPDATE" | "PAUSE" | "RESUME" | "ARCHIVE";
  listingId: string;
  listingTitle: string;
  fieldLabel: string;
  beforeValue: string;
  afterValue: string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
};

export function parseListingManagementPreview(
  value: unknown,
): ListingManagementPreview | null {
  const parsed = z
    .object({
      previewId: z.string().uuid(),
      action: z.enum(["UPDATE", "PAUSE", "RESUME", "ARCHIVE"]),
      listingId: z.string().min(1),
      listingTitle: z.string().min(1),
      fieldLabel: z.string().min(1),
      beforeValue: z.string(),
      afterValue: z.string(),
      status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"]),
    })
    .strict()
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseStoredListingManagementPreviewStatus(value: unknown) {
  const parsed = PreviewQuery.safeParse(value);
  return parsed.success ? parsed.data.status : null;
}

function normalizeDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function formatMinor(minor: number, scale: number) {
  const digits = String(minor).padStart(scale + 1, "0");
  if (scale === 0) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function matchTokens(value: string) {
  return normalizeSearch(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^ال/, ""));
}

const UPDATE_VERBS = "(?:غير|عدل|حدث|غيّر|عدّل|حدّث|خلي|خل|اجعل|زود|زيد|زد|نزل|قلل|ارفع|خفض)";
const ORDINAL_WORD =
  "(?:(?:ال)?(?:اول(?:ى|ي)?|ثاني(?:ة|ه)?|ثالث(?:ة|ه)?|رابع(?:ة|ه)?|خامس(?:ة|ه)?|سادس(?:ة|ه)?|سابع(?:ة|ه)?|ثامن(?:ة|ه)?|تاسع(?:ة|ه)?|عاشر(?:ة|ه)?|اخير(?:ة|ه)?))";
/** Optional listing reference between a field and its value: "الإعلان الثاني", "هذه القطعة", "القطعة التي عرضتها". */
const LISTING_TARGET =
  `(?:\\s+(?:هذه|هذا|هذي)?\\s*(?:الاعلان|العرض|المنتج|القطعة|القطعه)(?:\\s+(?:التي|اللي|الي)\\s+\\S+)?)?(?:\\s+(?:هذه|هذا|هذي))?(?:\\s*${ORDINAL_WORD}|\\s+(?:رقم\\s*)?\\d{1,2}(?=\\s+(?:الي|ل|ب)\\s*\\d))?`;

/**
 * The seller's own wording for a value matched on the folded text: «كنبة أنيقة» must be
 * stored as written, not as the search form «كنبه انيقه».
 */
function originalWording(message: string, folded: string): string {
  const raw = message.trim();
  for (let start = 0; start < raw.length; start += 1) {
    const candidate = raw.slice(start).trim();
    if (normalizeDigits(normalizeSearch(candidate)).trim() === folded) return candidate;
  }
  return folded;
}

function getUpdateRequest(message: string):
  | { field: "unitPrice"; value: string }
  | { field: "availableQuantity"; value: number }
  | { field: "city"; value: string }
  | { field: "title"; value: string }
  | { field: "description"; value: string }
  | { field: "contactPhone"; value: string | null }
  | { field: "attribute"; key: string; value: string | number }
  | undefined {
  const text = normalizeDigits(normalizeSearch(message)).trim();
  // "عندي 6 قطع بدل 2": a stock correction in the seller's own words.
  const stock = text.match(/^(?:عندي|لدي|صار عندي|اصبح عندي)\s+(\d{1,7})\s*(?:قطع|قطعة|قطعه|حبات|حبة|حبه)?(?:\s+بدل\s+\d+)?$/u);
  if (stock) return { field: "availableQuantity", value: Number(stock[1]) };
  // «خله بـ275», «خليه بـ5 بدل 10»: a bare price for the listing in focus; «ب» makes it a price.
  const bare = text.replace(/ـ/g, "").match(/^(?:خله|خليه|خليها|خلها|اجعله|اجعلها|صيره|صيرها)\s+(?:ب|بسعر)\s*([0-9]+(?:[.,][0-9]+)?)(?:\s+بدل\s+[0-9.,]+)?$/u);
  if (bare) return { field: "unitPrice", value: bare[1]!.replace(",", ".") };
  if (!new RegExp(`^${UPDATE_VERBS}\\s+`).test(text)) return undefined;
  const verbs = UPDATE_VERBS;
  const ordinal = LISTING_TARGET;

  const price = text.match(
    new RegExp(`^${verbs}\\s+(?:السعر|سعره|سعرها|سعر)${ordinal}(?:\\s+(?:الي|الى|ل|ب))?\\s*([0-9]+(?:[.,][0-9]+)?)(?:\\s+بدل\\s+[0-9.,]+)?(?:\\s|$)`),
  );
  if (price)
    return { field: "unitPrice", value: price[1].replace(",", ".") };

  const quantity = text.match(
    new RegExp(`^${verbs}\\s+(?:الكمية|كمية|عدد(?:ه|ها)?|العدد)${ordinal}\\s+(?:(?:الي|الى|ل|ب)\\s*)?([0-9]+)(?:\\s+بدل\\s+[0-9]+)?(?:\\s|$)`),
  );
  if (quantity)
    return {
      field: "availableQuantity",
      value: Number(quantity[1]),
    };

  const location = text.match(
    new RegExp(`^${verbs}\\s+(?:الموقع|المدينة)${ordinal}\\s+(?:الي|الى|ل|ب)\\s*(.{1,100})$`),
  );
  if (location)
    return { field: "city", value: location[1].trim().replace(/[،,.]+$/, "") };

  const title = text.match(
    new RegExp(`^${verbs}\\s+(?:العنوان|اسم الاعلان|اسم العرض)${ordinal}\\s+(?:الي|الى|ل|ب)\\s*(.{2,200})$`),
  );
  if (title) return { field: "title", value: originalWording(message, title[1].trim()) };

  const description = text.match(
    new RegExp(`^${verbs}\\s+(?:الوصف)${ordinal}\\s+(?:الي|الى|ل|ب)\\s*(.{10,1000})$`),
  );
  if (description)
    return { field: "description", value: originalWording(message, description[1].trim()) };
  const contact = text.match(
    new RegExp(`^${verbs}\\s+(?:رقم التواصل|رقم الهاتف|التواصل)(?:\\s+لهذا\\s+(?:الاعلان|العرض))?\\s+(?:الي|الى|ل|ب)\\s*(.{1,80})$`),
  );
  if (contact) {
    const value = contact[1].trim();
    if (/^(?:محادثة فقط|داخل التطبيق فقط|بدون رقم|لا رقم)$/u.test(value))
      return { field: "contactPhone", value: null };
    return { field: "contactPhone", value };
  }
  return undefined;
}

/** «خله 250» on a listing already in the seller's own context: the number is its price. */
function bareContextPrice(message: string): { field: "unitPrice"; value: string } | undefined {
  const match = normalizeDigits(normalizeSearch(message)).trim().match(/^(?:خله|خليه|خليها|خلها|اجعله|اجعلها)\s+([0-9]+(?:[.,][0-9]+)?)$/u);
  return match ? { field: "unitPrice", value: match[1]!.replace(",", ".") } : undefined;
}

function getAttributeUpdateRequest(
  message: string,
  schema?: MarketplaceCategorySchema,
):
  | { field: "attribute"; key: string; value: string | number }
  | undefined {
  if (!schema) return undefined;
  const text = normalizeDigits(normalizeSearch(message)).trim();
  const command = text.match(
    /^(?:غير|عدل|حدث|غيّر|عدّل|حدّث|خلي|اجعل)\s+(.+)$/u,
  );
  if (!command) return undefined;
  const body = command[1];
  const entries = Object.entries(schema.attributes).sort(
    ([, a], [, b]) => b.label.length - a.label.length,
  );
  for (const [key, item] of entries) {
    const aliases = [...new Set([item.label, key.replace(/[_-]/g, " ")])];
    for (const alias of aliases) {
      const escaped = normalizeSearch(alias).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const match = body.match(
        new RegExp(
          `^${escaped}(?:\\s+(?:(?:في|لهذا)\\s+)?(?:الاعلان|العرض)(?:\\s+(?:الاول|الاولى|الثاني|الثانية|الثالث|الثالثة|[1-3]))?)?\\s*(?:الي|الى|ل|ب)?\\s*(.{1,100})$`,
          "u",
        ),
      );
      const rawValue = match?.[1]?.trim();
      if (!rawValue) continue;
      if (item.type !== "number")
        return { field: "attribute", key, value: rawValue };
      const numeric = rawValue.match(
        /^([0-9]+(?:[.,][0-9]+)?)\s*(?:(?:الف|الاف|k)(?:\s*(?:كم|كيلو(?:متر)?))?)?$/iu,
      );
      if (!numeric) continue;
      const multiplier = /(?:الف|الاف|k)/iu.test(rawValue) ? 1000 : 1;
      const value = Number(numeric[1].replace(",", ".")) * multiplier;
      if (Number.isFinite(value)) return { field: "attribute", key, value };
    }
  }
  return undefined;
}

function openListingPhrase(message: string) {
  const text = normalizeSearch(message).trim();
  if (resultPosition(text) !== undefined) return undefined;
  const match = text.match(/^(?:افتح|اعرض|شوف)\s+(?:اعلان|عرض)\s+(.+)$/);
  return match?.[1]?.trim();
}

function isConfirmPhrase(message: string) {
  return /^(?:(?:تمام|طيب|اوكي|خلاص)\s+)?(?:نعم|اكيد|اكد|تأكيد|تاكيد|موافق|أكد|أكد التعديل|تأكيد التعديل|نعم اكد|نعم تأكيد|نفذ|نفذه|نفذ التعديل|تمام)[!.؟]?$/i.test(
    normalizeSearch(message).trim(),
  );
}

function isCancelPhrase(message: string) {
  return /^(?:الغاء|الغي|إلغاء|لا|الغاء التعديل|إلغاء التعديل|تراجع)[!.؟]?$/i.test(
    normalizeSearch(message).trim(),
  );
}

/** A seller reporting a sale ("الثالث اتباع", "بعته"); questions are never read as one. */
function soldPhrase(message: string) {
  const text = normalizeSearch(message);
  if (/[؟?]|(?:^|\s)هل(?:\s|$)/u.test(text)) return false;
  return /(?:^|\s)(?:اتباع|انباع|اتباعت|انباعت|بعته|بعتها|تم بيعه|تم بيعها)(?:\s|$|[،,.])/u.test(text);
}

function statusOrArchiveOperation(message: string) {
  // «وقف الإعلان الثاني مؤقتًا»: how long the pause lasts does not change which listing it is.
  const text = normalizeSearch(message).trim().replace(/[،,.!؟]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\s+(?:مؤقتا|موقتا|مؤقت|موقت|حاليا|الحين|الان|شوي)$/u, "");
  const target = `(?:\\s+(?:الاعلان|العرض))?\\s*(?:${ORDINAL_WORD}|رقم\\s*\\d{1,2}|القديم|الاقدم)?`;
  if (soldPhrase(text) || new RegExp(`(?:^|\\s)(?:شيله|شيلها|احذفه|احذفها|ازله|ازيله|ازيلها|ارشفه|ارشفها)$`).test(text))
    return "ARCHIVE" as const;
  if (new RegExp(`^(?:وقف|اوقف|ايقاف|عطل)${target}$`).test(text)) return "PAUSE" as const;
  if (new RegExp(`^(?:رجع|اعِد|اعد|استأنف|استانف|شغل)\\s+(?:تفعيل\\s+)?${ORDINAL_WORD}$`).test(text)) return "RESUME" as const;
  const ordinal =
    "(?:\\s+(?:الاعلان|العرض))?\\s*(?:الاول(?:ى|ي)?|الثاني(?:ة)?|الثالث(?:ة)?|[1-3])?";
  if (new RegExp(`^(?:وقف|اوقف|ايقاف|عطل)\\s+(?:الاعلان|العرض)(?:ه|ها)?${ordinal}$`).test(text))
    return "PAUSE" as const;
  if (new RegExp(`^(?:رجع|اعِد|اعد|استأنف|شغل)\\s+(?:تفعيل\\s+)?(?:الاعلان|العرض)(?:ه|ها)?${ordinal}$`).test(text))
    return "RESUME" as const;
  if (new RegExp(`^(?:احذف|حذف|ارشف|أرشف)\\s+(?:الاعلان|العرض)(?:ه|ها)?${ordinal}$`).test(text))
    return "ARCHIVE" as const;
  // «وقّف إعلان الطاولة»: the listing named after the verb (resolved by namedStatusTarget).
  const named = namedStatusTarget(message);
  if (named) return named.action;
  return undefined;
}

/** «وقف إعلان الطاولة», «رجع عرض الأكواب», «احذف اعلان الكنبة»: a status verb and a listing name. */
function namedStatusTarget(message: string): { action: "PAUSE" | "RESUME" | "ARCHIVE"; name: string } | undefined {
  const text = normalizeSearch(message).trim().replace(/[،,.!؟]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\s+(?:مؤقتا|موقتا|مؤقت|موقت|حاليا|الحين|الان|شوي)$/u, "");
  const match = text.match(/^(وقف|اوقف|ايقاف|عطل|رجع|اعد|استانف|شغل|فعل|احذف|حذف|ارشف)\s+(?:ال)?(?:اعلان|عرض)\s+(\S.{1,40})$/u);
  if (!match) return undefined;
  const name = match[2]!.trim();
  if (new RegExp(`^(?:رقم\\s*)?(?:${ORDINAL_WORD}|\\d{1,2})$`, "u").test(name)) return undefined;
  const verb = match[1]!;
  const action = /^(?:وقف|اوقف|ايقاف|عطل)$/u.test(verb) ? "PAUSE" : /^(?:احذف|حذف|ارشف)$/u.test(verb) ? "ARCHIVE" : "RESUME";
  return { action, name };
}

/** «وقفه», «رجعها»: a status verb whose object is the listing already open. */
function pronounStatusOperation(message: string) {
  const text = normalizeSearch(message).trim().replace(/[،,.!؟]+/g, "").trim();
  if (/^(?:وقفه|وقفها|اوقفه|اوقفها|عطله|عطلها)$/u.test(text)) return "PAUSE" as const;
  if (/^(?:رجعه|رجعها|شغله|شغلها|فعله|فعلها)$/u.test(text)) return "RESUME" as const;
  return undefined;
}

function isListingManagementSurface(message: string) {
  return /^(?:(?:اعرض|افتح|شوف|وريني|ارني)(?:\s+لي)?\s+)?(?:عروضي|اعلاناتي|ادارة عروضي|قوائمي|عروضي المنشورة)$/.test(
    normalizeSearch(message).trim(),
  );
}

async function latestConversationSets(
  conversationId: string,
  marketId: string,
) {
  return db
    .select()
    .from(aiResultSets)
    .where(
      and(
        eq(aiResultSets.conversationId, conversationId),
        eq(aiResultSets.marketId, marketId),
      ),
    )
    .orderBy(desc(aiResultSets.createdAt))
    .limit(20);
}

async function currentSellerContext(
  conversationId: string,
  market: Market,
  ownerId: string,
) {
  const sets = await latestConversationSets(conversationId, market.id);
  const latest = sets.find(
    (set) => !set.expiresAt || set.expiresAt.getTime() > Date.now(),
  );
  if (!latest) return null;
  const preview = PreviewQuery.safeParse(latest.query);
  if (preview.success) {
    if (preview.data.ownerId !== ownerId) return null;
    if (preview.data.status === "PENDING") return { pendingPreview: latest };
    return { resourceIds: latest.resourceIds, resultSetId: latest.id };
  }
  const context = SellerContextQuery.safeParse(latest.query);
  if (!context.success || context.data.ownerId !== ownerId) return null;
  return { resourceIds: latest.resourceIds, resultSetId: latest.id };
}

async function resolveCurrentOwnedListings(
  market: Market,
  ownerId: string,
  resourceIds?: string[],
) {
  return searchMarketplaceListings(market, {
    ownSellerId: ownerId,
    ...(resourceIds ? { allowedIds: resourceIds } : {}),
    limit: 24,
  });
}

export async function makeSellerContextResult(
  context: {
    conversationId: string;
    market: Market;
    actorId: string;
  },
  listings: Awaited<ReturnType<typeof resolveCurrentOwnedListings>>,
  prompt: string,
  resourceId?: string,
): Promise<SurfaceTurn> {
  const resultSetId = randomUUID();
  const resourceIds = listings.map((listing) => listing.id);
  return {
    tool: "sellerListingManagement",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "MY_LISTINGS",
      resultSetId,
      resourceIds,
      resourceId,
      query: { kind: "SELLER_CONTEXT", ownerId: context.actorId },
      listings: [],
      prompt,
    },
  };
}

async function ownedListingRow(
  listingId: string,
  market: Market,
  ownerId: string,
) {
  const [row] = await db
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.id, listingId),
        eq(offers.sellerId, ownerId),
        eq(offers.marketId, market.id),
      ),
    )
    .limit(1);
  if (!row || !["PUBLISHED", "PAUSED"].includes(row.status)) return null;
  return row;
}

async function createListingPreview(
  context: {
    conversationId: string;
    market: Market;
    actorId: string;
  },
  listingId: string,
  operation: "UPDATE" | "PAUSE" | "RESUME" | "ARCHIVE",
  message: string,
  /** A change already read from the conversation (context-intent.ts), instead of parsing `message`. */
  explicit?: { field: "unitPrice"; value: string },
): Promise<SurfaceTurn> {
  const row = await ownedListingRow(
    listingId,
    context.market,
    context.actorId,
  );
  if (!row) {
    return makeSellerContextResult(
      context,
      [],
      "لم يعد هذا العرض متاحًا للإدارة في سوقك الحالي. افتح «إعلاناتي» وحدد عرضًا منشورًا أو متوقفًا.",
    );
  }

  let fieldLabel = "الحالة";
  let beforeValue = row.status === "PUBLISHED" ? "منشور" : "متوقف";
  let afterValue = "";
  let updateBody: Record<string, unknown> | undefined;

  if (operation === "UPDATE") {
    const categoryRow = await resolveMarketplaceCategory(
      typeof row.data.categoryId === "string" ? row.data.categoryId : undefined,
      typeof row.data.category === "string" ? row.data.category : "",
    );
    const schema = categoryRow ? schemaFromRow(categoryRow) : undefined;
    const requested =
      explicit ?? getUpdateRequest(message) ?? bareContextPrice(message) ?? getAttributeUpdateRequest(message, schema);
    if (!requested)
      return makeSellerContextResult(
        context,
        await resolveCurrentOwnedListings(context.market, context.actorId, [
          listingId,
        ]),
        "اكتب التغيير بوضوح، مثل: «غير السعر إلى 12» أو «خلي الكمية 3» أو «غير رقم التواصل لهذا الإعلان إلى …». لم يتم حفظ أي تغيير.",
        listingId,
      );
    // G1: a provider-synchronized field is changed at its source, never by a local override.
    if (requested.field !== "contactPhone" && (await listingSource(listingId)) === "PROVIDER")
      return makeSellerContextResult(
        context,
        await resolveCurrentOwnedListings(context.market, context.actorId, [listingId]),
        sourceControlledMessage([requested.field]),
        listingId,
      );
    const body = buildListingUpdateBody(row, context.market);
    if (schema?.rules.inventory.semantics === "NON_STOCK") {
      body.inventoryMode = "UNLIMITED";
      body.availableQuantity = null;
    }
    fieldLabel =
      requested.field === "unitPrice"
        ? "السعر"
        : requested.field === "availableQuantity"
          ? "الكمية"
          : requested.field === "city"
            ? "الموقع"
            : requested.field === "title"
              ? "العنوان"
            : requested.field === "description"
              ? "الوصف"
              : requested.field === "attribute"
                ? schema?.attributes[requested.key]?.label ?? requested.key
                : "رقم التواصل";
    if (requested.field === "unitPrice") {
      const pricing = schema?.rules.pricing;
      const pricingMode: ListingPricingMode | undefined =
        row.pricingMode === "OPEN_TO_OFFERS"
          ? "OPEN_TO_OFFERS"
          : row.pricingMode === "NEGOTIABLE"
            ? "NEGOTIABLE"
            : row.pricingMode === "FIXED"
              ? "FIXED"
              : undefined;
      if (
        !pricingMode ||
        (pricing && !pricing.allowedModes.includes(pricingMode))
      )
        return makeSellerContextResult(
          context,
          await resolveCurrentOwnedListings(context.market, context.actorId, [
            listingId,
          ]),
          "هذا التصنيف لا يسمح بتحديد سعر ثابت. لم يتم حفظ أي تغيير.",
          listingId,
        );
      const nextMinor = parseListingPriceMinor(
        requested.value,
        context.market.currencyCode,
      );
      if (
        pricing &&
        (nextMinor < pricing.minAmountMinor ||
          nextMinor > pricing.maxAmountMinor)
      )
        return makeSellerContextResult(
          context,
          await resolveCurrentOwnedListings(context.market, context.actorId, [
            listingId,
          ]),
          "السعر خارج النطاق المعتمد لهذا التصنيف. لم يتم حفظ أي تغيير.",
          listingId,
        );
      beforeValue =
        row.unitPriceMinor === null
          ? "بالإتفاق مع البائع"
          : formatMinor(row.unitPriceMinor, context.market.minorUnitScale);
      afterValue = formatMinor(nextMinor, context.market.minorUnitScale);
      body.unitPrice = afterValue;
      body.pricingMode = pricingMode;
    } else if (requested.field === "availableQuantity") {
      if (
        !Number.isSafeInteger(requested.value) ||
        requested.value < 1 ||
        requested.value > 1_000_000
      )
        return makeSellerContextResult(
          context,
          await resolveCurrentOwnedListings(context.market, context.actorId, [
            listingId,
          ]),
          "الكمية يجب أن تكون عددًا صحيحًا بين 1 و1,000,000. لم يتم حفظ أي تغيير.",
          listingId,
        );
      if (
        schema?.rules.inventory.semantics === "NON_STOCK" ||
        (schema?.rules.inventory.semantics === "SINGLE" &&
          requested.value !== 1)
      )
        return makeSellerContextResult(
          context,
          await resolveCurrentOwnedListings(context.market, context.actorId, [
            listingId,
          ]),
          schema?.rules.inventory.semantics === "SINGLE"
            ? "هذا التصنيف مخصص لوحدة واحدة. لم يتم حفظ أي تغيير."
            : "هذا التصنيف لا يستخدم كمية مخزون. لم يتم حفظ أي تغيير.",
          listingId,
        );
      beforeValue =
        row.inventoryMode === "UNLIMITED"
          ? "غير محدودة"
          : String(row.availableQuantity ?? 0);
      afterValue = String(requested.value);
      body.inventoryMode = "LIMITED";
      body.availableQuantity = requested.value;
    } else if (requested.field === "city") {
      beforeValue = String(row.data.city ?? "غير محدد");
      afterValue = requested.value;
      body.city = requested.value;
    } else if (requested.field === "title") {
      beforeValue = String(row.data.title ?? "");
      afterValue = requested.value;
      body.title = requested.value;
    } else if (requested.field === "description") {
      beforeValue = String(row.data.description ?? "");
      afterValue = requested.value;
      body.description = requested.value;
    } else if (requested.field === "attribute") {
      const attributes =
        row.data.attributes &&
        typeof row.data.attributes === "object" &&
        !Array.isArray(row.data.attributes)
          ? (row.data.attributes as Record<string, string | number>)
          : {};
      beforeValue = String(attributes[requested.key] ?? "غير محدد");
      afterValue = String(requested.value);
      body.attributes = { ...attributes, [requested.key]: requested.value };
    } else {
      const normalizedPhone =
        requested.value === null
          ? null
          : normalizeListingContactPhone(requested.value);
      beforeValue =
        typeof row.data.contactPhone === "string"
          ? row.data.contactPhone
          : "محادثة جاسم فقط";
      afterValue = normalizedPhone ?? "محادثة جاسم فقط";
      body.contactPhone = normalizedPhone;
    }
    updateBody = body;
  } else if (operation === "PAUSE") {
    afterValue = "متوقف";
  } else if (operation === "RESUME") {
    afterValue = "منشور";
  } else if (soldPhrase(message)) {
    // Block B has no separate SOLD state for listings: a sold item is archived, history kept.
    fieldLabel = "الحالة";
    beforeValue = row.status === "PUBLISHED" ? "منشور" : "متوقف";
    afterValue = "تم البيع — سيُؤرشف ويختفي من البحث، وتبقى الطلبات والسجلات";
  } else {
    fieldLabel = "الأرشفة";
    beforeValue = row.status === "PUBLISHED" ? "منشور" : "متوقف";
    afterValue = "مؤرشف — سيختفي من البحث مع بقاء الطلبات السابقة";
  }

  const previewId = randomUUID();
  const query = {
    kind: "LISTING_PREVIEW",
    ownerId: context.actorId,
    listingId: row.id,
    operation,
    status: "PENDING",
    expectedUpdatedAt: row.updatedAt.toISOString(),
    ...(updateBody ? { updateBody } : {}),
    fieldLabel,
    beforeValue,
    afterValue,
    listingTitle: String(row.data.title ?? "إعلان"),
    request: message.slice(0, 2000),
    ...(operation === "ARCHIVE" && soldPhrase(message) ? { reason: "SOLD" as const } : {}),
  };
  return {
    tool: "sellerListingManagement",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "MY_LISTINGS",
      resultSetId: previewId,
      resourceIds: [row.id],
      resourceId: row.id,
      query,
      listings: [],
      managementPreview: {
        previewId,
        action: operation,
        listingId: row.id,
        listingTitle: String(row.data.title ?? "إعلان"),
        fieldLabel,
        beforeValue,
        afterValue,
        status: "PENDING",
      },
      prompt:
        operation === "ARCHIVE"
          ? "راجع الأرشفة قبل التأكيد. لا تُحذف الطلبات أو السجلات التاريخية."
          : "هذه معاينة فقط؛ لم يتغير الإعلان. أكّد أو ألغِ.",
    },
  };
}

/**
 * A price change for the seller's own listing in context: the same owner-checked review the
 * typed «غير السعر إلى …» opens. Nothing changes until the seller confirms it.
 */
export async function reviewListingPriceChange(
  context: { conversationId: string; market: Market; actorId: string },
  listingId: string,
  amount: number,
): Promise<SurfaceTurn> {
  return createListingPreview(context, listingId, "UPDATE", "", { field: "unitPrice", value: String(amount) });
}

export async function applyListingPreviewAction(input: {
  previewId: string;
  ownerId: string;
  market: Market;
  action: "CONFIRM" | "CANCEL";
}) {
  return db.transaction(async (tx) => {
    const [set] = await tx
      .select()
      .from(aiResultSets)
      .where(
        and(
          eq(aiResultSets.id, input.previewId),
          eq(aiResultSets.marketId, input.market.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!set) throw Object.assign(new Error("المعاينة غير موجودة"), { status: 404 });
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, set.conversationId),
          eq(conversations.ownerUserId, input.ownerId),
          eq(conversations.marketId, input.market.id),
          eq(conversations.kind, "AI"),
        ),
      )
      .limit(1);
    if (!conversation)
      throw Object.assign(new Error("المعاينة غير موجودة"), { status: 404 });

    const parsed = PreviewQuery.safeParse(set.query);
    if (
      !parsed.success ||
      parsed.data.ownerId !== input.ownerId ||
      !set.resourceIds.includes(parsed.data.listingId)
    )
      throw Object.assign(new Error("المعاينة غير صالحة"), { status: 409 });
    const preview = parsed.data;
    if (preview.status !== "PENDING")
      return { status: preview.status, listingId: preview.listingId };
    if (set.expiresAt && set.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(aiResultSets)
        .set({ query: { ...preview, status: "EXPIRED" } })
        .where(eq(aiResultSets.id, set.id));
      return { status: "EXPIRED" as const, listingId: preview.listingId };
    }
    if (input.action === "CANCEL") {
      await tx
        .update(aiResultSets)
        .set({ query: { ...preview, status: "CANCELLED" } })
        .where(eq(aiResultSets.id, set.id));
      return { status: "CANCELLED" as const, listingId: preview.listingId };
    }

    if (preview.operation === "UPDATE") {
      const body = UpdateListingBody.parse(preview.updateBody);
      await updateOwnedListing(
        {
          listingId: preview.listingId,
          ownerId: input.ownerId,
          market: input.market,
          body,
          expectedUpdatedAt: preview.expectedUpdatedAt,
        },
        tx,
      );
    } else if (preview.operation === "PAUSE" || preview.operation === "RESUME") {
      await changeOwnedListingStatus(
        {
          listingId: preview.listingId,
          ownerId: input.ownerId,
          market: input.market,
          action: preview.operation,
          expectedUpdatedAt: preview.expectedUpdatedAt,
        },
        tx,
      );
    } else {
      await archiveOwnedListing(
        {
          listingId: preview.listingId,
          ownerId: input.ownerId,
          market: input.market,
          expectedUpdatedAt: preview.expectedUpdatedAt,
        },
        tx,
      );
    }
    await tx
      .update(aiResultSets)
      .set({ query: { ...preview, status: "CONFIRMED" } })
      .where(eq(aiResultSets.id, set.id));
    return { status: "CONFIRMED" as const, listingId: preview.listingId };
  });
}

export async function executeSellerListingManagementTurn(input: {
  conversationId: string;
  currentMessageId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<SurfaceTurn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const context = {
    conversationId: input.conversationId,
    market: input.market,
    actorId,
  };
  const latestSets = await latestConversationSets(
    input.conversationId,
    input.market.id,
  );
  const latestPreview = latestSets
    .map((set) => ({ set, parsed: PreviewQuery.safeParse(set.query) }))
    .find(
      ({ parsed }) =>
        parsed.success &&
        parsed.data.ownerId === actorId &&
        parsed.data.status === "PENDING",
    );
  if (latestPreview) {
    if (isConfirmPhrase(input.message) || isCancelPhrase(input.message)) {
      const preview = latestPreview.parsed.success ? latestPreview.parsed.data : undefined;
      const expire = () =>
        db
          .update(aiResultSets)
          .set({ query: { ...preview, status: "EXPIRED" } })
          .where(eq(aiResultSets.id, latestPreview.set.id));
      // A confirmation applies only to the review the seller is looking at: once the
      // conversation produced a newer result, an old preview is never executed.
      if (latestSets[0]?.id !== latestPreview.set.id && preview) {
        await expire();
        return makeSellerContextResult(
          context,
          [],
          "انتهت صلاحية المعاينة السابقة لأن المحادثة تابعت بعدها. لم يتغير الإعلان؛ اطلب التغيير من جديد.",
          preview.listingId,
        );
      }
      let outcome: Awaited<ReturnType<typeof applyListingPreviewAction>>;
      try {
        outcome = await applyListingPreviewAction({
          previewId: latestPreview.set.id,
          ownerId: actorId,
          market: input.market,
          action: isConfirmPhrase(input.message) ? "CONFIRM" : "CANCEL",
        });
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (!preview || typeof status !== "number" || status >= 500) throw error;
        await expire();
        // The listing changed since the review: the old confirmation is void; review again
        // with the current values instead of applying what the seller saw before.
        if (status === 409 && preview.request) {
          const fresh = await createListingPreview(context, preview.listingId, preview.operation, preview.request);
          fresh.result.prompt = `تغيّر الإعلان منذ المعاينة، فألغيت التأكيد السابق. هذه معاينة جديدة بالقيم الحالية؛ أكّد أو ألغِ.`;
          return fresh;
        }
        return makeSellerContextResult(
          context,
          [],
          `${error instanceof Error ? error.message : "تعذر تنفيذ التغيير"}. لم يتغير الإعلان.`,
          preview.listingId,
        );
      }
      const owned = await resolveCurrentOwnedListings(input.market, actorId, [
        outcome.listingId,
      ]);
      return makeSellerContextResult(
        context,
        owned,
        outcome.status === "CONFIRMED"
          ? "تم تنفيذ التغيير بعد تأكيدك. جرى تحديث القائمة من بيانات السوق."
          : outcome.status === "CANCELLED"
            ? "أُلغيت المعاينة. لم يتغير الإعلان."
            : "انتهت صلاحية المعاينة. لم يتغير الإعلان؛ افتح الإعلان واطلب المعاينة من جديد.",
        outcome.listingId,
      );
    }
    return {
      tool: "sellerListingManagement",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "MY_LISTINGS",
        resultSetId: latestPreview.set.id,
        resourceIds: latestPreview.set.resourceIds,
        resourceId: latestPreview.parsed.success
          ? latestPreview.parsed.data.listingId
          : undefined,
        query: {},
        listings: [],
        prompt: "هناك تغيير بانتظارك. أكّده أو ألغِ المعاينة قبل بدء تغيير آخر.",
      },
    };
  }

  if (isListingManagementSurface(input.message)) {
    const listings = await resolveCurrentOwnedListings(input.market, actorId);
    return makeSellerContextResult(
      context,
      listings,
      listings.length
        ? `هذه إعلاناتك في السوق الحالي (${listings.length}). يمكنك فتح إعلان بالاسم أو اختيار رقم من القائمة.`
        : "لا توجد إعلانات لك في هذا السوق حاليًا.",
    );
  }

  const openPhrase = openListingPhrase(input.message);
  let action = statusOrArchiveOperation(input.message);
  let update = getUpdateRequest(input.message);
  // «خله 250» right after price advice or «إعلاناتي»: a bare number is a price only while
  // the seller's own listing context is the current one; elsewhere it is never claimed.
  const bareNumber = bareContextPrice(input.message);
  if (!update && bareNumber && (await currentSellerContext(input.conversationId, input.market, actorId))) update = bareNumber;
  // «وقفه» / «رجعه» likewise belong to the open listing only; elsewhere (a job post's «رجعها»)
  // they are never claimed.
  const pronounAction = pronounStatusOperation(input.message);
  if (!action && pronounAction && (await currentSellerContext(input.conversationId, input.market, actorId))) action = pronounAction;
  const isContactCommand =
    /^(?:غير|عدل|حدث|خلي|اجعل)\s+(?:رقم التواصل|رقم الهاتف|التواصل)/u.test(
      normalizeSearch(input.message).trim(),
    );
  const hasUpdateIntent =
    Boolean(update || isContactCommand) ||
    new RegExp(`^${UPDATE_VERBS}\\s+.+\\s+(?:الي|الى|ل|ب)\\s+.+$`, "u").test(
      normalizeSearch(input.message).trim(),
    );
  // A listing noun makes an ordinal explicit; otherwise the shared F0 parser reads each
  // number by the phrase that owns it, so "غير سعر الثاني إلى 7" is listing 2, price 7.
  const listingOrdinal = explicitListingOrdinal(input.message);
  const phraseOrdinal = parseCommandNumbers(input.message).ordinal;
  const ordinal = hasUpdateIntent || action
    ? listingOrdinal ?? (phraseOrdinal !== undefined ? phraseOrdinal - 1 : undefined)
    : resultPosition(input.message);
  const hasManagementCommand =
    Boolean(openPhrase || action || hasUpdateIntent) ||
    ordinal !== undefined;
  if (!hasManagementCommand) return null;

  const current = await currentSellerContext(
    input.conversationId,
    input.market,
    actorId,
  );
  const pendingPreview =
    current && "pendingPreview" in current
      ? current.pendingPreview
      : undefined;
  if (pendingPreview) {
    return {
      tool: "sellerListingManagement",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "MY_LISTINGS",
        resultSetId: pendingPreview.id,
        resourceIds: pendingPreview.resourceIds,
        query: {},
        listings: [],
        prompt: "هناك معاينة تغيير معلّقة. أكّدها أو ألغِها أولًا.",
      },
    };
  }
  let selectedIds: string[] = [];
  if (openPhrase) {
    const candidates = await resolveCurrentOwnedListings(
      input.market,
      actorId,
    );
    const wanted = matchTokens(openPhrase);
    const exact = candidates.filter(
      (listing) =>
        normalizeSearch(listing.title) === normalizeSearch(openPhrase),
    );
    const matched =
      exact.length > 0
        ? exact
        : candidates.filter((listing) => {
            const titleTokens = matchTokens(listing.title);
            return wanted.length > 0 && wanted.every((token) => titleTokens.includes(token));
          });
    selectedIds = matched.map((listing) => listing.id);
    if (selectedIds.length === 1) {
      const result = await makeSellerContextResult(
        context,
        candidates.filter((listing) => listing.id === selectedIds[0]),
        `فتحت «${matched[0].title}». يمكنك تعديل حقل عام أو إيقافه أو استئنافه أو أرشفته.`,
        selectedIds[0],
      );
      return result;
    }
    return makeSellerContextResult(
      context,
      matched,
      selectedIds.length
        ? `وجدت ${selectedIds.length} إعلانات متشابهة. اختر رقم الإعلان المقصود من القائمة.`
        : "لم أجد إعلانًا بهذا الاسم ضمن إعلاناتك في السوق الحالي. لم يتم إجراء أي تغيير.",
    );
  }

  if (ordinal !== undefined) {
    if (!current?.resourceIds?.length) {
      if (!action && !hasUpdateIntent) return null;
      return makeSellerContextResult(
        context,
        [],
        "اعرض «إعلاناتي» أولًا، ثم اختر رقمًا ظاهرًا فيها. لم يتم إجراء أي تغيير.",
      );
    }
    const refreshed = await resolveCurrentOwnedListings(
      input.market,
      actorId,
      current.resourceIds,
    );
    const listingId = current.resourceIds[ordinal];
    if (!listingId || !refreshed.some((item) => item.id === listingId))
      return makeSellerContextResult(
        context,
        refreshed,
        "هذا الرقم غير موجود في قائمة إعلاناتك الحالية. اختر رقمًا ظاهرًا في القائمة.",
      );
    const selected = refreshed.find((item) => item.id === listingId)!;
    if (hasUpdateIntent)
      return createListingPreview(context, listingId, "UPDATE", input.message);
    if (action)
      return createListingPreview(context, listingId, action, input.message);
    return makeSellerContextResult(
      context,
      [selected],
      `حددت «${selected.title}». يمكنك تعديل حقل عام أو إيقافه أو استئنافه أو أرشفته.`,
      listingId,
    );
  }

  // A named listing wins over whatever is in focus, and resolves only among the seller's own.
  const namedStatus = action ? namedStatusTarget(input.message) : undefined;
  if (namedStatus) {
    const own = (await resolveCurrentOwnedListings(input.market, actorId)).filter((listing) => ["PUBLISHED", "PAUSED"].includes(String(listing.status)));
    const wanted = matchTokens(namedStatus.name);
    const matches = own.filter((listing) => {
      const titleTokens = matchTokens(listing.title);
      return wanted.length > 0 && wanted.every((token) => titleTokens.some((word) => word.includes(token)));
    });
    if (matches.length === 1) return createListingPreview(context, matches[0]!.id, namedStatus.action, input.message);
    return makeSellerContextResult(
      context,
      matches,
      matches.length
        ? `لديك ${matches.length} إعلانات تطابق «${namedStatus.name}». أي واحد تقصد؟ اختر رقمه ثم أعد الطلب. لم يتغير شيء.`
        : `لم أجد إعلانًا باسم «${namedStatus.name}» ضمن إعلاناتك في هذا السوق. لم يتغير شيء.`,
    );
  }

  const currentIds = current?.resourceIds ?? [];
  const refreshed = currentIds.length
    ? await resolveCurrentOwnedListings(input.market, actorId, currentIds)
    : [];
  let listingId = currentIds.length === 1 && refreshed.length === 1
    ? refreshed[0].id
    : undefined;
  if (!listingId) listingId = await implicitListing(input.message, input.market, actorId, Boolean(action));
  // G2 «غير سعر الجاكيت إلى 8»: a name resolves only against the seller's own active
  // listings; two plausible matches are a question, never a guess.
  const named = !listingId && hasUpdateIntent ? namedListingCommand(input.message) : undefined;
  if (named) {
    const own = (await resolveCurrentOwnedListings(input.market, actorId)).filter((listing) => ["PUBLISHED", "PAUSED"].includes(String(listing.status)));
    const wanted = matchTokens(named.name);
    const matches = own.filter((listing) => {
      const titleTokens = matchTokens(listing.title);
      return wanted.length > 0 && wanted.every((token) => titleTokens.some((word) => word.includes(token)));
    });
    if (matches.length === 1) return createListingPreview(context, matches[0]!.id, "UPDATE", named.canonical);
    if (matches.length > 1)
      return makeSellerContextResult(context, matches, `لديك ${matches.length} إعلانات تطابق «${named.name}». أي واحد تقصد؟ اختر رقمه ثم أعد الطلب. لم يتغير شيء.`);
  }
  if (!listingId)
    return makeSellerContextResult(
      context,
      refreshed,
      "حدّد إعلانًا بالاسم أو افتح إعلانًا من «إعلاناتي» أولًا. لا يمكن تطبيق التغيير على قائمة غير محددة.",
    );
  if (hasUpdateIntent)
    return createListingPreview(context, listingId, "UPDATE", input.message);
  if (action)
    return createListingPreview(context, listingId, action, input.message);
  return null;
}

/** «غير سعر الجاكيت إلى 8» → the name «الجاكيت» and the same command without it. */
function namedListingCommand(message: string): { name: string; canonical: string } | undefined {
  const text = normalizeDigits(normalizeSearch(message)).trim();
  const match = text.match(
    new RegExp(`^(${UPDATE_VERBS})\\s+(السعر|سعر|الكمية|كمية|الكميه|كميه)\\s+(.{2,40}?)\\s+((?:الي|الى|ل|ب)\\s*[0-9]+(?:[.,][0-9]+)?)$`, "u"),
  );
  if (!match) return undefined;
  const name = match[3]!.trim();
  if (new RegExp(`^(?:هذه|هذا|هذي)?\\s*(?:الاعلان|العرض|المنتج|القطعة|القطعه)?\\s*${ORDINAL_WORD}?$`, "u").test(name)) return undefined;
  const field = /^(?:ال)?سعر$/u.test(match[2]!) ? "السعر" : "الكمية";
  return { name, canonical: `${match[1]} ${field} ${match[4]}` };
}

/**
 * References that name a listing by a server fact rather than a position: "الإعلان القديم"
 * is the seller's oldest active listing; "القطعة التي عرضتها" is their only active one.
 * Anything else stays ambiguous and DINAR asks which listing.
 */
async function implicitListing(message: string, market: Market, ownerId: string, isAction: boolean) {
  const text = normalizeSearch(message);
  const active = (await db
    .select({ id: offers.id, createdAt: offers.createdAt })
    .from(offers)
    .where(and(eq(offers.sellerId, ownerId), eq(offers.marketId, market.id))))
    .filter(Boolean);
  const live = (await resolveCurrentOwnedListings(market, ownerId))
    .filter((listing) => ["PUBLISHED", "PAUSED"].includes(String(listing.status)))
    .map((listing) => listing.id);
  const candidates = active.filter((row) => live.includes(row.id));
  if (isAction && /(?:^|\s)(?:القديم|الاقدم)(?:\s|$|[،,.])/u.test(text) && candidates.length)
    return [...candidates].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]!.id;
  if (/(?:التي|اللي|الي)\s+(?:عرضتها|عرضته|نزلتها|نزلته|نشرتها|نشرته)/u.test(text) && candidates.length === 1)
    return candidates[0]!.id;
  return undefined;
}

export async function latestPreviewStatus(
  previewId: string,
  conversationId: string,
  marketId: string,
) {
  const [set] = await db
    .select({ query: aiResultSets.query })
    .from(aiResultSets)
    .where(
      and(
        eq(aiResultSets.id, previewId),
        eq(aiResultSets.conversationId, conversationId),
        eq(aiResultSets.marketId, marketId),
      ),
    )
    .limit(1);
  const parsed = PreviewQuery.safeParse(set?.query);
  return parsed.success ? parsed.data.status : undefined;
}
// ─── Block F1: seller advice (facts only, nothing is changed) ────────────────

const PRICE_ADVICE =
  /(?:^|\s)(?:كم|بكم)\s+(?:احط|اضع|حط|اخلي|ابيع|اعرض|اسعر)(?:ه|ها)?(?:\s|$)|(?:^|\s)(?:اقترح|انصحني)\s+(?:لي\s+)?(?:ب)?سعر|(?:^|\s)(?:ما|شو|ايش)\s+(?:هو\s+)?السعر\s+المناسب/u;
const WHY_NOT_SELLING =
  /(?:^|\s)(?:ليش|لماذا|ليه|لم)(?:\s|$).*(?:ينباع|يتباع|ينبيع|يبيع|مبيع|يشتري|يشتريه|حدا|احد)/u;

function formatPrice(value: number | null, market: Market) {
  return value === null ? "—" : value.toFixed(market.minorUnitScale).replace(/\.?0+$/, "") || "0";
}

function priceAdviceText(stats: Awaited<ReturnType<typeof comparablePrices>>, market: Market) {
  if (!stats.count) return "لم أجد عروضًا مشابهة كافية داخل جاسم لاقتراح سعر. لم أغيّر السعر.";
  if (stats.count < 3)
    return `وجدت ${stats.count} ${stats.count === 1 ? "عرضًا مشابهًا" : "عرضين مشابهين"} فقط داخل جاسم (${formatPrice(stats.min, market)}${stats.count > 1 ? `–${formatPrice(stats.max, market)}` : ""} ${market.currencyCode})؛ البيانات قليلة لاقتراح سعر. لم أغيّر السعر.`;
  return `وجدت ${stats.count} عروض مشابهة داخل جاسم. النطاق ${formatPrice(stats.min, market)}–${formatPrice(stats.max, market)} ${market.currencyCode}. الوسيط ${formatPrice(stats.median, market)}. هذه معلومة للاسترشاد فقط؛ لا تضمن البيع، ولم أغيّر السعر.`;
}

async function adviceTarget(input: { conversationId: string; message: string; market: Market; actorId: string }) {
  const sets = await latestConversationSets(input.conversationId, input.market.id);
  const context = sets.find((set) => SellerContextQuery.safeParse(set.query).success);
  const owned = context && (context.query as { ownerId?: string }).ownerId === input.actorId ? context.resourceIds : [];
  const ordinal = parseCommandNumbers(input.message).ordinal;
  if (ordinal !== undefined) return owned[ordinal - 1];
  if (owned.length === 1) return owned[0];
  const live = (await resolveCurrentOwnedListings(input.market, input.actorId)).filter((listing) =>
    ["PUBLISHED", "PAUSED"].includes(String(listing.status)),
  );
  return live.length === 1 ? live[0]!.id : undefined;
}

// ─── Seller business assistance (Command C) ─────────────────────────────────
// Each answer is a real aggregation over the seller's own rows in the active market.
const INVENTORY =
  // «البضاعة اللي أعرضها»: what the seller lists, named by a relative clause.
  /(?:^|\s)(?:ال)?(?:بضاعه|بضاعة|منتجات|اغراض|اشياء|عروض|اعلانات)\s+(?:اللي|التي|الي)\s+(?:ا|ن)?(?:عرض|نزل|نشر|حط|بيع)\S*(?:\s|$)|(?:^|\s)(?:شو|وش|ايش|ماذا|ما)\s+(?:عندي|لدي)\s+(?:معروض|منشور|اعلانات|بضاعه|بضاعة|عروض)(?:\s|$)|(?:^|\s)(?:بضاعتي|مخزوني|المخزون|منتجاتي)(?:\s|$)|(?:^|\s)كم\s+(?:بقي|باقي|ظل|ضل|تبقي|متبقي|متوفر|المتاح|الكميه)(?:\s|$)/u;
const SELLER_ORDERS =
  /(?:^|\s)كم\s+(?:طلب|طلبا|طلبات)\s*(?:عندي|لي|وصلني|جاني|وصلتني|علي)(?:\s|$)|(?:^|\s)(?:طلبات|طلب)\s+(?:الزباين|الزبائن|العملاء|المشترين)(?:\s|$)|(?:^|\s)(?:مبيعاتي|كم\s+بعت)(?:\s|$)/u;
// «قارن أول إعلانين عندي», «قارن إعلاناتي»: comparing the seller's own listings is the
// per-listing performance view, not a comparison of search results.
const PERFORMANCE =
  /(?:^|\s)(?:اداء|كيف\s+ماشي(?:ه)?|نتائج)\s+(?:عروضي|اعلاناتي|منتجاتي|اعلاني|عرضي|متجري|مبيعاتي)(?:\s|$)|^(?:قارن|قارنلي)\s(?:.*\s)?(?:اعلاناتي|منتجاتي|(?:اعلان|اعلانين|منتج|منتجين)\s+(?:عندي|لي))(?:\s|$)/u;
const IMPROVE =
  /(?:^|\s)(?:اقترح|انصحني|ساعدني)(?:\s+(?:لي|علي))?\s+(?:كيف\s+)?(?:احسن|اطور|تحسين|تطوير)(?:\s|$)|(?:^|\s)كيف\s+(?:احسن|اطور)\s+(?:الاعلان|اعلاني|العرض|عرضي)(?:\s|$)/u;

/** The folded message without punctuation, so «عروضي؟» still ends on a word boundary. */
const businessText = (message: string) =>
  normalizeSearch(message).replace(/[ًٌٍَُِّْ]/gu, "").replace(/[؟?!.,،:;«»"'()]/gu, " ").replace(/\s+/gu, " ").trim();

const BARE_REMAINING = /^(?:دينار\s+)?كم\s+(?:بقي|باقي|ظل|ضل|تبقي|متبقي|متوفر|المتاح|الكميه)(?:\s+(?:منه|منها|منهم))?$/u;

/**
 * «كم باقي؟», «كم باقي منه؟» with no seller wording: it may be the stock of the listing in view,
 * the seller's own stock, or something else entirely; the caller decides from context.
 */
export function isBareRemainingQuestion(message: string): boolean {
  return BARE_REMAINING.test(businessText(message));
}

/** Stock, orders, performance and improvement questions about the seller's own listings. */
export function isSellerBusinessQuestion(message: string): boolean {
  // «كم باقي من حصتي؟» is about the AI allowance, not stock (G1 usage card).
  if (isAiUsageQuestion(message)) return false;
  const text = businessText(message);
  return SALES_QUESTION.test(text) || SELLER_ORDERS.test(text) || PERFORMANCE.test(text) || IMPROVE.test(text) || (INVENTORY.test(text) && !isMarketingRequest(message));
}

/** Copywriting the model drafts from the seller's facts; never a tutorial or an ad purchase. */
const MARKETING_REQUEST =
  /(?:^|\s)(?:اكتب|اذكر)\s+(?:ان|انه|انها|في\s+الاعلان)\s|(?:^|\s)اكتب(?:\s+لي)?\s+(?:\S+\s+){0,2}(?:اعلان|اعلانا|وصف|وصفا|منشور|منشورا|بوست|صيغ|صيغه|عنوان|عنوانا|رد|ردا)|(?:^|\s)(?:حسن|طور|اعد\s+كتابه)\s+(?:وصف|عنوان|الوصف|العنوان)|(?:^|\s)(?:ثلاث|3|عده|عدة)\s+صيغ|(?:^|\s)كيف\s+ارد\s+علي\s+(?:زبون|عميل|مشتري)|(?:^|\s)كيف\s+(?:اعرض|ابرز|اوضح)\s+(?:مميزات|ميزات|مزايا)|(?:^|\s)(?:جاسم\s+)?(?:سوق|سوقلي|روج|روجلي)(?:\s+(?:لي|ل))?\s+(?:\S+\s+){0,2}?(?:منتج\S*|المنتج|اعلان\S*|الاعلان|بضاع\S*|خدمت\S*|الخدم[هة]|عرض\S*|العرض|متجري|هذا|هذي|هذه|اياه|اياها)(?:\s|$)|(?:^|\s)(?:اعمل|سوي|سويلي|ابي|اريد|ابغي)(?:\s+(?:لي|ل))?\s+(?:\S+\s+){0,1}?(?:دعاي[هة]|ترويج|حمل[هة]\s+تسويقي[هة]|اعلان\s+تسويقي|منشور\s+تسويقي|نص\s+تسويقي)(?:\s|$)/u;
export function isMarketingRequest(message: string): boolean {
  return MARKETING_REQUEST.test(businessText(message));
}

const CLAIM_PATTERNS: [ClaimKind, RegExp][] = [
  ["SCARCITY", /كمي[هة]\s+(?:\S+\s+)?(?:محدود[هة]?|قليل[هة]?)|(?:العدد|الكمي[هة])\s+محدود|اخر\s+(?:قطع[هة]|حب[هة]|واحد[هة])|باقي\s+(?:\S+\s+)?(?:قطع[هة]?|حب[هة]|حبات|واحد[هة])|ينفد|نفاد|قبل\s+ما\s+يخلص/u],
  ["URGENCY", /لفتر[هة]\s+محدود[هة]|اليوم\s+فقط|ينتهي\s+العرض|العرض\s+ينتهي|بسرع[هة]\s+قبل|اخر\s+فرص[هة]|لا\s+تفوت|سارع|(?:اطلب|اتصل|احجز)\s+(?:الان|حالا|فورا)|لو\s+(?:تسلمته|اشتريته|اخذته|طلبته)\s+اليوم/u],
  ["WARRANTY", /ضمان|كفال[هة]/u],
  ["CERTIFICATION", /شهاد[هة]|معتمد|مرخص|اصلي|وكال[هة]/u],
  ["DISCOUNT", /خصم|تخفيض|تنزيلات|عرض\s+خاص|بدل\s+\d|كان\s+سعر[هة]|السعر\s+القديم/u],
  ["SOCIAL_PROOF", /تقييم|نجوم|الاكثر\s+مبيع|زبا[يئ]ن\s+راضين|مئات|الاف\s+(?:الزبا[يئ]ن|العملاء)|كثير\s+(?:ناس|من\s+الناس|زبا[يئ]ن|عملاء)/u],
];

// In drafted copy a claim is an assertion («عليه ضمان سنتين», «خصم 10»), not a mention of the
// topic («الضمان: [تحقق]», «بدون وعد بخصم»), which the seller-request patterns above accept.
const COPY_CLAIM_PATTERNS: [ClaimKind, RegExp][] = [
  ["SCARCITY", CLAIM_PATTERNS[0]![1]],
  ["URGENCY", CLAIM_PATTERNS[1]![1]],
  ["WARRANTY", /(?:عليه|عليها|يشمل|تشمل|مع|معه|معها|يوجد|فيه|فيها|يتوفر|متوفر|ب)\s+(?:ال)?(?:ضمان|كفال[هة])|ضمان[اًا]?\s+(?:لمد[هة]|\d|سن[هة]|سنتين|سنوات|شهر|اشهر|ذهبي|شامل|رسمي|الوكيل|وكال[هة])|مكفول/u],
  ["CERTIFICATION", /(?:^|\s)(?:معتمد|معتمده|مرخص|مرخصه|اصلي|اصليه)(?:\s|$)|شهاد[هة]\s+(?:\S+\s+)?(?:رسمي[هة]?|معتمد[هة]?)/u],
  ["DISCOUNT", /(?:خصم|تخفيض)\s+(?:\d|بقيم|بنسب|خاص|حصري|على|لل)|عرض\s+خاص|بدل\s+\d|كان\s+سعر[هة]|السعر\s+القديم|تنزيلات/u],
  ["SOCIAL_PROOF", CLAIM_PATTERNS[5]![1]],
];
const NEGATED_CLAIM =
  /(?:بدون|دون|بلا|لا\s+يوجد|لا\s+يشمل|لا\s+تشمل|ما\s+في|ما\s+فيه|مو|ليس|ليست|غير|لا|لن)\s+(?:\S+\s+){0,3}?(?:ب|ال)?(?:خصم|تخفيض|ضمان|كفال[هة]|عرض|شهاد[هة]|استعجال)\S*/gu;

/**
 * Claim language in drafted copy that the listing facts do not support. Quoted «…» / "…"
 * text (the model naming what it refuses), [placeholders] and negations are not claims.
 */
export function unsupportedCopyClaims(reply: string, facts: SellerListingFacts | null): ClaimKind[] {
  const copy = businessText(reply.replace(/«[^»]*»|"[^"]*"|“[^”]*”|\[[^\]]*\]/gu, " ")).replace(NEGATED_CLAIM, " ");
  const allowed = new Set(
    (facts?.claimCheck ?? []).filter((item) => item.status !== "UNSUPPORTED").map((item) => item.claim),
  );
  if (facts) {
    const sellerText = normalizeSearch([facts.sellerProvided.title, facts.sellerProvided.description, ...Object.values(facts.sellerProvided.attributes)].join(" "));
    for (const [claim, pattern] of CLAIM_PATTERNS)
      if ((claim === "WARRANTY" || claim === "CERTIFICATION") && pattern.test(sellerText)) allowed.add(claim);
    if (typeof facts.dinarRecord.available === "number" && facts.dinarRecord.available <= 1) allowed.add("SCARCITY");
  }
  return COPY_CLAIM_PATTERNS.filter(([claim, pattern]) => !allowed.has(claim) && pattern.test(copy)).map(([claim]) => claim);
}

function checkClaims(message: string, record: SellerListingFacts["dinarRecord"], provided: SellerListingFacts["sellerProvided"]): SellerListingFacts["claimCheck"] {
  const asked = normalizeSearch(message);
  const sellerText = normalizeSearch([provided.title, provided.description, ...Object.values(provided.attributes)].join(" "));
  return CLAIM_PATTERNS.filter(([, pattern]) => pattern.test(asked)).map(([claim, pattern]) => {
    if (claim === "SCARCITY") {
      const available = record.available;
      return typeof available === "number" && available <= 1
        ? { claim, status: "SUPPORTED_BY_DINAR_RECORD" as const, basis: `الكمية المسجلة ${available}` }
        : { claim, status: "UNSUPPORTED" as const, basis: available === "UNLIMITED" ? "الكمية المسجلة غير محدودة" : `الكمية المسجلة ${available ?? "غير معروفة"}` };
    }
    if (claim === "WARRANTY" || claim === "CERTIFICATION")
      return pattern.test(sellerText)
        ? { claim, status: "SELLER_CLAIM_ONLY" as const, basis: "مذكور في وصف البائع ولم يتحقق منه جاسم" }
        : { claim, status: "UNSUPPORTED" as const, basis: "غير مذكور في بيانات الإعلان" };
    return { claim, status: "UNSUPPORTED" as const, basis: claim === "DISCOUNT" ? "لا يوجد سعر سابق أو خصم مسجل" : claim === "URGENCY" ? "لا توجد مدة عرض مسجلة" : "لا توجد تقييمات أو أرقام مبيعات مسجلة" };
  });
}

/**
 * The seller's own listing (or draft) in focus, as provenance-labelled facts for the model's
 * marketing help. Only the actor's own rows in the active market; never contact or location.
 */
export async function sellerListingFacts(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId: string;
  /** Present for D5: only these catalog rows are inside the employee's live business grant. */
  allowedListingIds?: string[];
  /** D5 drafts are usable only when the server marked them for this business. */
  employeeBusinessId?: string;
  employeeSessionId?: string;
}): Promise<SellerListingFacts | null> {
  const allowedIds = input.allowedListingIds
    ? [...new Set(input.allowedListingIds)].slice(0, 100)
    : undefined;
  if (allowedIds && !allowedIds.length) return null;
  const requestedListingId = await adviceTarget(input).catch(() => undefined);
  let listingId = allowedIds
    ? requestedListingId && allowedIds.includes(requestedListingId) ? requestedListingId : undefined
    : requestedListingId;
  if (allowedIds && !listingId) {
    const rows = await db.select().from(offers).where(and(
      eq(offers.sellerId, input.actorId),
      eq(offers.marketId, input.market.id),
      inArray(offers.id, allowedIds),
    ));
    const query = normalizeSearch(input.message);
    const named = rows.filter((row) => {
      const title = normalizeSearch(String(row.data.title ?? ""));
      return title.length >= 3 && query.includes(title);
    });
    if (named.length === 1) listingId = named[0]!.id;
    else if (!named.length && rows.length === 1) listingId = rows[0]!.id;
  }
  if (listingId) {
    const [row] = await db.select().from(offers).where(and(
      eq(offers.id, listingId),
      eq(offers.sellerId, input.actorId),
      eq(offers.marketId, input.market.id),
      ...(allowedIds ? [inArray(offers.id, allowedIds)] : []),
    ));
    if (row) {
      const record: SellerListingFacts["dinarRecord"] = {
        price: row.unitPriceMinor === null ? null : formatMinor(row.unitPriceMinor, input.market.minorUnitScale),
        currency: input.market.currencyCode,
        pricingMode: row.pricingMode,
        category: typeof row.data.category === "string" ? row.data.category : null,
        status: row.status,
        available: row.inventoryMode === "UNLIMITED" ? "UNLIMITED" : row.availableQuantity === null ? null : Math.max(0, row.availableQuantity - row.reservedQuantity),
      };
      const provided = {
        title: String(row.data.title ?? ""),
        description: String(row.data.description ?? ""),
        attributes: Object.fromEntries(Object.entries(row.data.attributes ?? {}).filter(([, value]) => value != null && value !== "").map(([key, value]) => [key, String(value)])),
      };
      return { source: "PUBLISHED_LISTING", dinarRecord: record, sellerProvided: provided, claimCheck: checkClaims(input.message, record, provided) };
    }
  }
  const [latest] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, input.conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
  const payload = latest?.payload as Record<string, unknown> | undefined;
  const draft = payload?.surface === "SELL" && payload.draftStep !== "cancelled" ? ConversationDraft.safeParse(payload.draft) : undefined;
  if (!draft?.success || !draft.data.title) return null;
  if (input.employeeBusinessId) {
    const binding = draft.data.draftId
      ? await sellerEmployeeDraftBinding({ actorId: input.actorId, draftId: draft.data.draftId })
      : undefined;
    if (!sellerEmployeeDraftBindingMatches(binding, {
      businessId: input.employeeBusinessId,
      conversationId: input.conversationId,
      marketId: input.market.id,
      sessionId: input.employeeSessionId ?? "",
    })) return null;
    const title = normalizeSearch(draft.data.title);
    const query = normalizeSearch(input.message);
    const refersToDraft = title.length >= 3 && query.includes(title) ||
      /(?:هذا|هذه|المسوده|مسودتي|اعلاني|اعلانه)/u.test(query);
    if (!refersToDraft) return null;
  }
  const record: SellerListingFacts["dinarRecord"] = {
    price: draft.data.unitPrice ?? null,
    currency: input.market.currencyCode,
    pricingMode: draft.data.pricingMode ?? "FIXED",
    category: draft.data.category ?? null,
    status: "DRAFT",
    available: draft.data.inventoryMode === "UNLIMITED"
      ? "UNLIMITED"
      : draft.data.availableQuantity !== undefined && Number.isFinite(Number(draft.data.availableQuantity)) ? Number(draft.data.availableQuantity) : null,
  };
  const provided = {
    title: draft.data.title,
    description: draft.data.description ?? "",
    attributes: Object.fromEntries(Object.entries(draft.data.attributes ?? {}).map(([key, value]) => [key, String(value)])),
  };
  return { source: "DRAFT", dinarRecord: record, sellerProvided: provided, claimCheck: checkClaims(input.message, record, provided) };
}

type OwnedRow = typeof offers.$inferSelect;
const availableText = (row: OwnedRow) =>
  row.inventoryMode === "UNLIMITED"
    ? "غير محدود"
    : `${Math.max(0, (row.availableQuantity ?? 0) - row.reservedQuantity)} متاح${row.reservedQuantity ? ` (و${row.reservedQuantity} محجوز لطلبات)` : ""}`;
const STATUS_TEXT: Record<string, string> = { PUBLISHED: "منشور", PAUSED: "موقوف", DRAFT: "مسودة", ARCHIVED: "مؤرشف" };

async function ownedRows(market: Market, actorId: string): Promise<OwnedRow[]> {
  return db.select().from(offers).where(and(eq(offers.sellerId, actorId), eq(offers.marketId, market.id), ne(offers.status, "ARCHIVED"))).orderBy(desc(offers.updatedAt)).limit(24);
}

async function inventoryTurn(input: { conversationId: string; message: string; market: Market; actorId: string }): Promise<SurfaceTurn> {
  const context = { conversationId: input.conversationId, market: input.market, actorId: input.actorId };
  const asksOne = /(?:^|\s)كم\s+(?:بقي|باقي|ظل|ضل|تبقي|متبقي|متوفر|المتاح|الكميه)(?:\s|$)/u.test(businessText(input.message));
  const focused = asksOne ? await adviceTarget(input) : undefined;
  const rows = await ownedRows(input.market, input.actorId);
  const target = focused ? rows.find((row) => row.id === focused) : undefined;
  const shown = target ? [target] : rows;
  const listings = await resolveCurrentOwnedListings(input.market, input.actorId, shown.map((row) => row.id));
  const prompt = !rows.length
    ? "لا توجد لديك إعلانات في هذا السوق بعد. قل «أبي أبيع …» لتبدأ إعلانًا."
    : target
      ? `«${String(target.data.title ?? "")}»: ${availableText(target)}. الحالة: ${STATUS_TEXT[target.status] ?? target.status}. الكمية من سجل جاسم؛ لتعديلها قل «عندي 5 قطع».`
      : asksOne && rows.length > 1
        ? `أي منتج تقصد؟ هذه كميات إعلاناتك:\n${rows.map((row, index) => `${index + 1}. «${String(row.data.title ?? "")}» — ${availableText(row)}`).join("\n")}`
        : `بضاعتك في هذا السوق (${rows.length}):\n${rows.map((row, index) => `${index + 1}. «${String(row.data.title ?? "")}» — ${availableText(row)} — ${STATUS_TEXT[row.status] ?? row.status}`).join("\n")}`;
  const result = await makeSellerContextResult(context, listings, prompt, target?.id);
  result.result.sellerInsight = SellerBusinessInsight.parse({
    kind: "BUSINESS_SUMMARY",
    topic: "INVENTORY",
    source: "DINAR_ONLY",
    metrics: shown.map((row) => ({ listingId: row.id, label: String(row.data.title ?? "").slice(0, 250), value: availableText(row), status: row.status })),
  });
  return result;
}

const COMPLETED_ORDER = new Set(["BUYER_CONFIRMED", "COMPLETED"]);
const CLOSED_ORDER = new Set(["CANCELLED", "EXPIRED", "DISPUTED"]);

async function ordersTurn(input: { conversationId: string; market: Market; actorId: string }): Promise<SurfaceTurn> {
  const context = { conversationId: input.conversationId, market: input.market, actorId: input.actorId };
  const rows = await db.select({ status: orders.status, total: count() }).from(orders)
    .where(and(eq(orders.sellerId, input.actorId), eq(orders.marketId, input.market.id))).groupBy(orders.status);
  const sum = (match: (status: string) => boolean) => rows.filter((row) => match(row.status)).reduce((total, row) => total + Number(row.total), 0);
  const completed = sum((status) => COMPLETED_ORDER.has(status));
  const closed = sum((status) => CLOSED_ORDER.has(status));
  const all = sum(() => true);
  const active = all - completed - closed;
  const prompt = all
    ? `طلبات على إعلاناتك في هذا السوق: ${all}. قيد التنفيذ ${active}، مكتملة ${completed}، ملغاة أو مغلقة ${closed}. الأرقام من سجل طلبات جاسم فقط.`
    : "لا توجد طلبات على إعلاناتك في هذا السوق بعد.";
  const result = await makeSellerContextResult(context, [], prompt);
  result.result.sellerInsight = SellerBusinessInsight.parse({
    kind: "BUSINESS_SUMMARY",
    topic: "ORDERS",
    source: "DINAR_ONLY",
    metrics: [
      { key: "all", label: "كل الطلبات", value: all },
      { key: "active", label: "قيد التنفيذ", value: active },
      { key: "completed", label: "مكتملة", value: completed },
      { key: "closed", label: "ملغاة أو مغلقة", value: closed },
    ],
  });
  return result;
}

/** Period-explicit sales from the seller's own order and payment records (conversation-first C). */
async function salesTurn(input: { conversationId: string; market: Market; actorId: string }, text: string): Promise<SurfaceTurn> {
  const insight = await sellerSalesInsight(input.actorId, input.market, text);
  const asksTop = /(?:اكثر|افضل)\s+(?:منتجاتي|اعلاناتي|عروضي|منتج)|(?:^|\s)(?:ال)?اكثر\s+(?:شي\s+|شيء\s+)?(?:مبيعا|بيعا|مبيع)(?:\s|$)/u.test(text);
  const result = await makeSellerContextResult({ conversationId: input.conversationId, market: input.market, actorId: input.actorId }, [], salesPrompt(insight, asksTop));
  result.result.sellerInsight = insight;
  return result;
}

async function performanceTurn(input: { conversationId: string; market: Market; actorId: string }): Promise<SurfaceTurn> {
  const context = { conversationId: input.conversationId, market: input.market, actorId: input.actorId };
  const rows = (await ownedRows(input.market, input.actorId)).filter((row) => ["PUBLISHED", "PAUSED"].includes(row.status)).slice(0, 10);
  if (!rows.length) return makeSellerContextResult(context, [], "لا توجد لديك إعلانات منشورة في هذا السوق لقياس أدائها.");
  const ids = rows.map((row) => row.id);
  const [orderCounts, negotiationCounts] = await Promise.all([
    db.select({ offerId: orderItems.offerId, total: count() }).from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.sellerId, input.actorId), eq(orders.marketId, input.market.id), inArray(orderItems.offerId, ids))).groupBy(orderItems.offerId),
    db.select({ listingId: negotiations.listingId, total: count() }).from(negotiations)
      .where(and(eq(negotiations.sellerId, input.actorId), inArray(negotiations.listingId, ids))).groupBy(negotiations.listingId),
  ]);
  const ordersBy = new Map(orderCounts.map((row) => [row.offerId, Number(row.total)]));
  const offersBy = new Map(negotiationCounts.map((row) => [row.listingId, Number(row.total)]));
  // Paid-campaign analytics exist only where a campaign ran; promotions may be unavailable.
  let campaigns: Awaited<ReturnType<typeof campaignAnalytics>> = [];
  let campaignsAvailable = true;
  try {
    campaigns = await campaignAnalytics(input.actorId, input.market);
  } catch {
    campaignsAvailable = false;
  }
  const metrics = rows.map((row) => {
    const title = String(row.data.title ?? "");
    const campaign = campaigns.find((item) => item.listingTitle === title);
    return {
      listingId: row.id,
      label: title.slice(0, 250),
      orders: ordersBy.get(row.id) ?? 0,
      priceOffers: offersBy.get(row.id) ?? 0,
      ...(campaign ? { campaignImpressions: campaign.qualifiedImpressions, campaignEngagements: campaign.qualifiedEngagements } : {}),
    };
  });
  const lines = metrics.map((item, index) =>
    `${index + 1}. «${item.label}» — طلبات ${item.orders}، عروض أسعار ${item.priceOffers}${"campaignImpressions" in item ? `، ظهور مموّل مؤهل ${item.campaignImpressions}` : ""}`,
  );
  const prompt = [
    "أداء إعلاناتك من سجل جاسم:",
    ...lines,
    "لا يسجّل جاسم مشاهدات الإعلانات العادية، لذلك لا أستطيع إعطاء أرقام مشاهدات.",
    ...(campaignsAvailable ? [] : ["إحصاءات الترويج غير متاحة الآن."]),
  ].join("\n");
  const listings = await resolveCurrentOwnedListings(input.market, input.actorId, ids);
  const result = await makeSellerContextResult(context, listings, prompt);
  result.result.sellerInsight = SellerBusinessInsight.parse({ kind: "BUSINESS_SUMMARY", topic: "PERFORMANCE", source: "DINAR_ONLY", metrics });
  return result;
}

/**
 * "كم أحط سعر؟" and "ليش إعلاني ما ينباع؟" for the seller's own draft or listing. Prices
 * come only from comparable DINAR listings; listing factors are stated as possibilities.
 */
export async function executeSellerAdviceTurn(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<SurfaceTurn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const text = businessText(input.message);
  const scoped = { conversationId: input.conversationId, message: input.message, market: input.market, actorId };
  if (SALES_QUESTION.test(text)) return salesTurn(scoped, text);
  if (SELLER_ORDERS.test(text)) return ordersTurn(scoped);
  if (PERFORMANCE.test(text)) return performanceTurn(scoped);
  if (INVENTORY.test(text) && !isMarketingRequest(input.message)) return inventoryTurn(scoped);
  const wantsPrice = PRICE_ADVICE.test(text);
  const wantsImprove = !wantsPrice && IMPROVE.test(text);
  const wantsWhy = !wantsPrice && (wantsImprove || WHY_NOT_SELLING.test(text));
  if (!wantsPrice && !wantsWhy) return null;
  const context = { conversationId: input.conversationId, market: input.market, actorId };
  const configured = (await listMarketplaceCategories()).map(schemaFromRow);

  if (wantsPrice) {
    const [latest] = await db
      .select({ payload: aiUiBlocks.payload })
      .from(aiUiBlocks)
      .where(eq(aiUiBlocks.conversationId, input.conversationId))
      .orderBy(desc(aiUiBlocks.createdAt))
      .limit(1);
    const payload = latest?.payload as Record<string, unknown> | undefined;
    const draft = payload?.surface === "SELL" && payload.draftStep !== "cancelled" ? ConversationDraft.safeParse(payload.draft) : undefined;
    if (draft?.success) {
      const schema = configured.find((category) => category.id === draft.data.categoryId || category.label === draft.data.category);
      const stats = await comparablePrices(input.market, {
        categoryId: schema?.id,
        title: draft.data.title ?? "",
        attributes: draft.data.attributes,
        sellerId: actorId,
      });
      // The draft stays the current resource: same draft, same step, advice added.
      return {
        tool: "sellerAdvice",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "SELL",
          query: {},
          listings: [],
          draft: draft.data,
          draftStep: typeof payload!.draftStep === "string" ? payload!.draftStep : "review",
          draftReview: buildDraftReview(draft.data, configured),
          sellerInsight: { kind: "PRICE_SUGGESTION", ...stats, suggestedBy: "DINAR_DERIVED" },
          prompt: priceAdviceText(stats, input.market),
        },
      };
    }
  }

  const listingId = await adviceTarget({ ...input, actorId });
  if (!listingId) {
    const listings = await resolveCurrentOwnedListings(input.market, actorId);
    return makeSellerContextResult(context, listings, "أي إعلان تقصد؟ اختر رقمًا من «إعلاناتي» ثم اسأل مرة أخرى.");
  }
  const [row] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.id, listingId), eq(offers.sellerId, actorId), eq(offers.marketId, input.market.id)));
  if (!row) return makeSellerContextResult(context, [], "لم أجد هذا الإعلان ضمن إعلاناتك في السوق الحالي.");
  const schema = configured.find((category) => category.id === row.data.categoryId);
  const title = String(row.data.title ?? "");
  const stats = await comparablePrices(input.market, {
    categoryId: schema?.id,
    title,
    attributes: row.data.attributes,
    excludeIds: [row.id],
    sellerId: actorId,
  });
  const listings = await resolveCurrentOwnedListings(input.market, actorId, [row.id]);
  if (wantsPrice) {
    const result = await makeSellerContextResult(context, listings, priceAdviceText(stats, input.market), row.id);
    result.result.sellerInsight = { kind: "PRICE_SUGGESTION", listingId: row.id, ...stats, suggestedBy: "DINAR_DERIVED" };
    return result;
  }

  const factors: { key: string; kind: "FACT" | "POSSIBLE_FACTOR"; text: string }[] = [];
  const price = row.unitPriceMinor === null ? null : row.unitPriceMinor / 10 ** input.market.minorUnitScale;
  if (row.status !== "PUBLISHED")
    factors.push({ key: "status", kind: "FACT", text: "الإعلان غير منشور حاليًا، لذلك لا يظهر للمشترين." });
  if (row.inventoryMode === "LIMITED" && (row.availableQuantity ?? 0) - row.reservedQuantity <= 0)
    factors.push({ key: "stock", kind: "FACT", text: "الكمية المتاحة صفر، فلا يمكن طلبه." });
  if (price !== null && stats.median !== null && price > stats.median * 1.15)
    factors.push({
      key: "price",
      kind: "POSSIBLE_FACTOR",
      text: `قد يكون أحد العوامل: سعرك ${formatPrice(price, input.market)} أعلى من الوسيط ${formatPrice(stats.median, input.market)} لـ${stats.count} عروض مشابهة داخل جاسم.`,
    });
  else if (stats.median !== null)
    factors.push({ key: "price", kind: "FACT", text: `سعرك ضمن نطاق ${stats.count} عروض مشابهة داخل جاسم (${formatPrice(stats.min, input.market)}–${formatPrice(stats.max, input.market)}).` });
  else factors.push({ key: "price", kind: "FACT", text: "لا توجد عروض مشابهة كافية داخل جاسم للمقارنة بالسعر." });
  const images = [row.data.imageUrl, ...(Array.isArray(row.data.imageUrls) ? row.data.imageUrls : [])].filter(Boolean);
  if (!images.length) factors.push({ key: "photos", kind: "POSSIBLE_FACTOR", text: "قد يكون أحد العوامل: لا توجد صور للإعلان." });
  const description = String(row.data.description ?? "");
  if (description.trim().length < 40)
    factors.push({ key: "description", kind: "POSSIBLE_FACTOR", text: `قد يكون أحد العوامل: الوصف قصير (${description.trim().length} حرفًا).` });
  const missingAttributes = Object.entries(schema?.attributes ?? {})
    .filter(([key]) => row.data.attributes?.[key] == null || row.data.attributes?.[key] === "")
    .map(([, definition]) => definition.label);
  if (missingAttributes.length)
    factors.push({ key: "attributes", kind: "POSSIBLE_FACTOR", text: `قد يكون أحد العوامل: خصائص غير معبأة (${missingAttributes.join("، ")}).` });
  const ageDays = Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000);
  factors.push({ key: "age", kind: "FACT", text: `منشور منذ ${ageDays} ${ageDays === 1 ? "يوم" : "أيام"}.` });
  const promoted = (await servingCampaignsFor(input.market.id, [row.id])).length > 0;
  factors.push({ key: "promotion", kind: "FACT", text: promoted ? "عليه ترويج نشط حاليًا." : "لا يوجد ترويج نشط حاليًا." });
  factors.push({ key: "engagement", kind: "FACT", text: "لا تتوفر لدي بيانات مشاهدات أو تفاعل لهذا الإعلان." });
  const result = await makeSellerContextResult(
    context,
    listings,
    [
      wantsImprove
        ? `اقتراحات لتحسين «${title}» من بيانات جاسم فقط (لن أغيّر شيئًا دون مراجعتك):`
        : `لا يمكنني تأكيد سبب عدم البيع، لكن هذه عوامل قد تؤثر في «${title}»:`,
      ...factors.map((factor) => `• ${factor.text}`),
      ...(wantsImprove ? ["لصياغة وصف أفضل قل «اكتب وصفًا أفضل»، ولتطبيقه قل «غيّر الوصف إلى …» ثم أكّد."] : []),
    ].join("\n"),
    row.id,
  );
  result.result.sellerInsight = { kind: "LISTING_FACTORS", listingId: row.id, factors, comparables: stats, source: "DINAR_ONLY" };
  return result;
}

/** Refuse an explicitly fabricated public claim without asking a provider to generate it. */
export function explicitMarketingTruthRefusal(message: string): string | undefined {
  const text=message.replace(/[أإآ]/gu,'ا').replace(/ة/gu,'ه').replace(/\s+/gu,' ').trim();
  if(!/^(?:اكتب|اعمل|انشئ|صمم)(?:لي)?\s/u.test(text))return undefined;
  if(/(?:تقييمات|تعليقات)\s+(?:عملاء|زبائن|زباين)\s+(?:وهميه|مختلقه|مزيفه)/u.test(text))return 'لا أقدّم تقييمات مختلقة على أنها آراء عملاء حقيقية. أستطيع مساعدتك في طلب تقييمات صادقة؛ لم أنشر شيئًا.';
  if(/خصم\s+\d+[%٪]/u.test(text)&&/(?:ما\s+عندنا|ليس\s+لدينا|لا\s+يوجد)\s+خصم/u.test(text))return 'لا أكتب خصمًا على أنه حقيقي بينما ذكرت أنه غير موجود. يمكن إعداد نص صادق دون هذه الدعوى؛ لم أنشر شيئًا.';
  return undefined;
}
