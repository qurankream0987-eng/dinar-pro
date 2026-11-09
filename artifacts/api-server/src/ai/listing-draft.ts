import {
  validateCategoryAttributesAgainstSchema,
  type MarketplaceCategorySchema,
  type ListingPricingMode,
} from "@workspace/api-zod/marketplace-schemas";
import { and, desc, eq } from "drizzle-orm";
import { aiUiBlocks, conversations, db } from "@workspace/db";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "./tool-registry";
import { FACT_SOURCES, resolveFact, type Fact, type FactSource } from "./fact-provenance";
import { normalizeSearchNumberText, parseStructuredSearch } from "./search-query";
import { hasCategoryAlias, normalizeSearch } from "./search-context";
import { hasExplicitMarketplaceSearchIntent } from "./marketplace-intent";
import { stripCorrectionPrefix } from "./intent";
import {
  categorySchema as schemaFromRow,
  listMarketplaceCategories,
} from "../lib/marketplace-categories";
import { extractListingContactPhone } from "../lib/listing-contact";
import { reserveAiUsage, settleAiUsage } from "../lib/ai-usage";
import {
  collectListingPhotoSuggestions,
  LISTING_PHOTO_UNCERTAINTIES,
  type ListingPhotoSuggestionProvider,
  type ListingPhotoUncertainty,
} from "./listing-photo-intelligence";
import { priceProposal } from "./price-proposal";
import { priceEdit } from "./context-intent";

import { applyDraftFieldEdit, draftFieldEdit, statedQuantity } from "./draft-field-edit";

export const ConversationDraft = z.object({
  draftId: z.string().uuid().optional(),
  category: z.string().max(100).optional(),
  categoryId: z.string().max(80).optional(),
  title: z.string().max(120).optional(),
  description: z.string().max(5000).optional(),
  imageUrl: z.string().max(2000).optional(),
  imageUrls: z.array(z.string().max(2000)).max(3).optional(),
  contactPhone: z.string().max(30).optional(),
  contactPreference: z
    .enum(["CHAT_ONLY", "LISTING_PHONE", "ACCOUNT_PHONE"])
    .optional(),
  availableQuantity: z.string().max(10).optional(),
  inventoryMode: z.enum(["LIMITED", "UNLIMITED"]).optional(),
  area: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  unitPrice: z.string().max(32).optional(),
  pricingMode: z.enum(["FIXED", "NEGOTIABLE", "OPEN_TO_OFFERS"]).optional(),
  /** The seller picked the pricing mode from the offered options (even the category default); only the amount is missing. */
  pricingModeChosen: z.boolean().optional(),
  /**
   * What the price means when it is not a definite asking price: a starting amount (the draft
   * keeps collecting it as a FIXED price) or a seller quotation (no price). Published as
   * OPEN_TO_OFFERS with data.priceRepresentation; neither is bought without an agreement.
   */
  priceRepresentation: z.enum(["STARTING_FROM", "QUOTE_REQUIRED"]).optional(),
  paymentMethods: z.array(z.enum(["CASH_DIRECT", "CARD"])).min(1).max(2).optional(),
  attributes: z.record(z.string(), z.union([z.string().max(160), z.number().finite()])).optional(),
  fulfilmentType: z.enum(["PICKUP", "DELIVERY", "SERVICE", "DIGITAL"]).optional(),
  /** G2: the seller accepts price offers («قابل للمساومة»). */
  negotiable: z.boolean().optional(),
  /** Block F provenance per draft field ("attributes.color" for attributes). */
  sources: z.record(z.string().max(100), z.enum(FACT_SOURCES)).optional(),
});

const prompts: Record<string, string> = {
  title: "ماذا تريد أن تعرض؟ اكتب عنوانًا واضحًا.",
  description: "صف العرض أو الخدمة بما لا يقل عن 10 أحرف.",
  price: "ما السعر المطلوب بعملة السوق؟",
  quantity: "هل هي قطعة واحدة، كمية محدودة، أم خدمة/منتج متاح دون حد؟",
  area: "ما المدينة أو المنطقة العامة؟ لا ترسل عنوانًا دقيقًا أو إحداثيات.",
  fulfilment: "كيف يحصل المشتري على العرض؟ استلام، خدمة، أو منتج رقمي.",
  contact:
    "كيف تحب المشتري يتواصل معك؟ اختر محادثة DINAR فقط، أرسل رقمًا مخصصًا لهذا الإعلان، أو قل «استخدم رقم حسابي المسجل» للموافقة صراحةً على مشاركته.",
  contact_account_confirmation:
    "تقصد رقم الدخول المسجل في حسابك؟ لن أشاركه إلا بعد موافقتك الصريحة. قل «نعم» لاستخدامه، أو أرسل رقمًا آخر، أو اختر محادثة DINAR فقط.",
  payment_methods: "وبالنسبة للدفع، تفضل كاش، فيزا داخل دينار، أو الاثنين؟",
  category: "اختر تصنيفًا نشطًا من سجل التصنيفات.",
  review: "راجع بيانات المسودة في البطاقة. لن يُنشر العرض إلا عند ضغطك زر «نشر العرض» ومراجعة التأكيد.",
};

const isUnpricedMode = (mode?: ListingPricingMode) =>
  mode === "OPEN_TO_OFFERS";
/** A seller who will quote after learning the buyer's requirements (normalized text). */
const SELLER_QUOTE = /حسب التسعيره|بالتسعيره|حسب الطلب|حسب المتطلبات|بعد معرفه (?:المتطلبات|التفاصيل)|(?:اعطي|ارسل) تسعيره|يطلب تسعيره/u;
const QUOTE_WORDS = SELLER_QUOTE;

/** Sets (or, with undefined, clears) the draft's non-binding price meaning. */
function setPriceRepresentation(
  draft: { priceRepresentation?: "STARTING_FROM" | "QUOTE_REQUIRED" },
  representation: "STARTING_FROM" | "QUOTE_REQUIRED" | undefined,
) {
  if (representation) draft.priceRepresentation = representation;
  else delete draft.priceRepresentation;
}

type DraftPaymentMethods = ("CASH_DIRECT" | "CARD")[];

export function parseSellerPaymentMethods(
  message: string,
  allowBareChoice = false,
): DraftPaymentMethods | undefined {
  const normalized = normalizeSearch(message);
  if (
    !allowBareChoice &&
    !/(?:الدفع|طريقة الدفع|كاش|نقد|cash|فيزا|بطاق|visa|card|كرت)/u.test(normalized)
  )
    return undefined;
  const hasCash = /كاش|نقد|cash/u.test(normalized);
  const hasCard = /فيزا|بطاق|(?:^|\s)كرت(?:\s|$)|visa|card/u.test(normalized);
  if (
    /الاثنين|كليهما|both/u.test(normalized) &&
    (allowBareChoice || /الدفع|طريقة الدفع/u.test(normalized))
  )
    return ["CASH_DIRECT", "CARD"];
  if (hasCash && hasCard)
    return ["CASH_DIRECT", "CARD"];
  if (hasCash) return ["CASH_DIRECT"];
  if (hasCard) return ["CARD"];
  return undefined;
}

const unpricedModeFor = (
  pricing: MarketplaceCategorySchema["rules"]["pricing"],
): ListingPricingMode | undefined =>
  pricing.allowedModes.includes("OPEN_TO_OFFERS")
    ? "OPEN_TO_OFFERS"
    : undefined;

const PRICE_CURRENCY =
  "(?:دينار(?:اً|ا)?|دنانير|ريال(?:اً|ا)?|ريالات|درهم|دراهم|دولار(?:اً|ا)?|دولارات|جنيه|جنيهات|فلس)";
// The amount starts at the first digit of its run (a later start can only match where the first
// does, and the first is leftmost), so a long digit run is scanned once instead of once per digit.
/** Exported for the differential test only (hostile-input-performance HIP-04). Not global: exec from 0. */
export const INITIAL_PRICE_AMOUNT = new RegExp(
  `(?:بمبلغ\\s*|بسعر\\s*|سعر(?:ها|ه)?\\s*|بـ?\\s*)?(?<!\\d[\\d٬,]*)(\\d[\\d٬,]*(?:\\.\\d+)?)\\s*${PRICE_CURRENCY}`,
);

function extractInitialUnitPrice(
  message: string,
): { value: number; start: number; end: number } | undefined {
  const normalized = normalizeSearchNumberText(message);
  const currency = PRICE_CURRENCY;
  const half = new RegExp(`(?:بنص|نصف|نص)\\s*${currency}`).exec(normalized);
  if (half)
    return {
      value: 0.5,
      start: half.index,
      end: half.index + half[0].length,
    };

  const amount = INITIAL_PRICE_AMOUNT.exec(normalized) ??
    // "بـ290" / "بسعر 290" without a currency word: the price phrase still owns the number.
    /(?:^|\s)(?:بمبلغ\s*|بسعر\s*|بـ\s*|ب\s?)(\d[\d٬,]*(?:\.\d+)?)(?=\s|$|[،,.])/u.exec(normalized);
  if (!amount) return undefined;
  const value = Number(amount[1].replace(/[٬,]/g, ""));
  return Number.isFinite(value) && value > 0
    ? { value, start: amount.index, end: amount.index + amount[0].length }
    : undefined;
}

function extractInitialQuantity(message: string): number | undefined {
  const normalized = normalizeSearchNumberText(message);
  const match = /(?:عندي|لدي|كمية|الكمية)\s*(\d{1,7})/.exec(normalized);
  // «عندي جهاز واحد», «قطعة وحدة»: one unit written as a word.
  if (!match && /(?:(?:عندي|لدي)\s+\S+|(?:^|\s)(?:قطعه|قطعة|حبه|حبة))\s+(?:واحد|واحده|واحدة|وحده|وحدة|1)(?=\s|$|[،,.])/u.test(normalized))
    return 1;
  if (!match) return undefined;
  const quantity = Number(match[1]);
  return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 1_000_000
    ? quantity
    : undefined;
}

function cleanTitle(message: string): string {
  const normalized = normalizeSearchNumberText(message);
  const serviceOffer = normalized.match(
    /^\s*(?:أنا|انا)\s+(.+?)\s+(?:و)?(?:أريد|اريد)?\s*(?:أعرض|اعرض|أقدم|اقدم|أوفر|اوفر)\s+(?:خدمتي|الخدمة|خدمة)(?=\s|$)/u,
  );
  if (serviceOffer?.[1]) {
    return `خدمة ${serviceOffer[1].trim()}`.slice(0, 120);
  }
  const initialPrice = extractInitialUnitPrice(normalized);
  let title = (initialPrice
    ? normalized.slice(0, initialPrice.start)
    : normalized
  ).trim();

  title = title
    // «دينار، بيع لي هاتفي»: the assistant's name and «بيع لي» are not part of the item.
    .replace(/^\s*(?:يا\s+)?دينار\s*[،,:]?\s*/u, "")
    .replace(/^\s*(?:بع|بيع)\s+لي\s+/u, "")
    .replace(/^\s*(?:عندي|لدي|كمية|الكمية)\s*\d+\s*/iu, "")
    .replace(/^\s*(?:أنا|انا|أريد|اريد|أبي|ابي|أبغى|ابغى|بدي|ودي|أحتاج|احتاج|أملك|املك|عندي|لدي)(?=\s|$)\s*/iu, "")
    .replace(
      // «أبيعه»: the attached pronoun is the draft's item, not a new title word.
      /^\s*(?:(?:أن|ان)\s*)?(?:أبيع|ابيع|أعرض|اعرض|انشر|أقدم|اقدم|أوفر|اوفر)(?:ها|ه(?=\s|$))?\s*/iu,
      "",
    )
    .replace(/^\s*(?:للبيع|بيع)\s*/iu, "")
    .replace(/^\s*(?:عندي|لدي|كمية|الكمية)\s*\d+\s*/i, "")
    .replace(/\s*(?:موجود(?:ة)?|متوفر(?:ة)?|الموقع|للاستلام|في منطقة|مدينة|محافظة)\s+.*$/iu, "")
    .replace(/\s*[,،]?\s*(?:الحبة|للحبة)\s*$/i, "")
    .replace(/\s*[,،]?\s*للبيع.*$/i, "")
    // «كنبة بدي بيعها»: the trailing wish is not part of the item's name.
    .replace(/\s*[,،]?\s*(?:و)?(?:بدي|ابي|اريد|أريد|ابغى|حاب|ودي)\s+(?:ا|أ|ن)?(?:بيع|ابيع)\S*\s*$/u, "")
    // A dangling price word only as its own word: «ذهب» keeps its final «ب».
    .replace(/(?:^|\s)(?:بسعر|بمبلغ|سعر(?:ها|ه)?|بـ?)\s*$/iu, "")
    .trim();
  const detail = /\s+(?=(?:نظيف(?:ة)?|ممتاز(?:ة)?|حالته|حالتها|بحالة|طوله|طولها|عرضه|عرضها|مقاسه|مقاسها|لونه|لونها|معه|معها|يشمل|تشمل)(?=\s|$))/iu.exec(
    title,
  );
  if (detail) title = title.slice(0, detail.index).trim();
  // «أريد أن أبيع شيئًا» names no item; the tanween and other marks never make it a title.
  if (
    /^(?:هذا|هذه|هذي|هاذا|ذلك|شيء|شيئا|شيئ|شي|حاجة|حاجه|حاجات|أشياء|اشياء|أغراض|اغراض|منتج|غرض|المعروض|الشيء|صورة|صور|إعلان|اعلان|عرض|جديد)$/i.test(
      title.replace(/[\u064B-\u0652]/gu, ""),
    )
  )
    return "";
  return title.slice(0, 120);
}

function initialArea(message: string) {
  const match =
    /(?:موجود(?:ة)?|متوفر(?:ة)?|الموقع|للاستلام|في منطقة)\s*(?:في|ب(?:ـ)?)?\s*([^،,؛;.!?\n]+)/iu.exec(
      message,
    );
  const area = match?.[1]
    ?.trim()
    .replace(/^(?:في|ب(?:ـ)?|منطقة)\s*/u, "")
    .trim();
  return area && !/^(?:مدينة|محافظة)\s/u.test(area)
    ? area.slice(0, 200)
    : undefined;
}

function initialDescription(
  message: string,
  price?: { start: number; end: number },
  title?: string,
) {
  let description = message;
  if (price) description = description.replace(message.slice(price.start, price.end), " ");
  if (title) {
    const titleWithoutCondition = title
      .replace(/\s+(?:مستعمل(?:ة)?|جديد(?:ة)?)$/iu, "")
      .trim();
    description = description.replace(titleWithoutCondition || title, " ");
  }
  description = description
    .replace(/^\s*(?:يا\s+)?دينار\s*[،,:]?\s*/u, "")
    .replace(/^\s*(?:بع|بيع)\s+لي\s+/u, "")
    .replace(/^\s*(?:أريد|اريد|أبي|ابي|أبغى|ابغى|أحتاج|احتاج)(?=\s|$)\s*/iu, "")
    .replace(/^\s*(?:(?:أن|ان)\s*)?(?:أبيع|ابيع|أعرض|اعرض|انشر|أقدم|اقدم|أوفر|اوفر|للبيع|بيع)\s*[,،]?\s*/iu, "")
    .replace(/(?:عندي|لدي|كمية|الكمية)\s*\d{1,7}/gu, " ")
    .replace(/(?:السعر|بسعر|بمبلغ)\s*[:：]?\s*/gu, " ")
    .replace(/(?:الحبة|للحبة)\s*[,،]?\s*/gu, " ");
  description = description.replace(
    /(?:موجود(?:ة)?|متوفر(?:ة)?|الموقع|للاستلام|في منطقة)\s*(?:في|ب(?:ـ)?)?\s*[^،,؛;.!?\n]+/iu,
    " ",
  );
  description = description.replace(
    /(?:في\s+)?(?:مدينة|محافظة)\s+[^،,؛;.!?\n]+/iu,
    " ",
  );
  description = description
    .replace(/(?:^|\s)و?(?:هذه|هذا|هذي|هاي)\s+(?:صورته|صورتها|صوره|صورة|الصورة|الصوره|صوري|الصور)(?=\s|$|[،,.])/gu, " ")
    .replace(/[،,؛;.!؟\s]+/g, " ")
    // "أريد أبيع هذا" with photos: a bare demonstrative describes nothing.
    .replace(/^(?:إعلان|اعلان|عرض|هذا|هذه|هاد|هاذا|هذي|هاي|ذا|هيدا|هيدي)$/iu, "")
    .trim();
  // Short details ("نظيف") stay with the item they describe, in the seller's own words.
  if (description && description.length < 10 && title) description = `${title} — ${description}`;
  return description.slice(0, 4000);
}

/**
 * "الحالة مستعمل" names a field explicitly, so it is a seller correction for that field,
 * never the answer to whichever step (title, description…) the draft happens to be on.
 */
function isLabelledFieldCorrection(
  message: string,
  schema: MarketplaceCategorySchema | undefined,
): boolean {
  const text = normalizeSearch(message);
  if (!schema || text.split(" ").length > 8) return false;
  const labels = [
    ...Object.values(schema.attributes).map((definition) => definition.label),
    "الحالة",
    "السعر",
  ].map(normalizeSearch);
  return labels.some((label) => label && text.startsWith(`${label} `));
}

function isNaturalAttributeCorrection(
  message: string,
  schema: MarketplaceCategorySchema | undefined,
): boolean {
  const text = normalizeSearch(message);
  return Boolean(
    schema &&
      (/^(?:لا\s*[،,]?\s*)?(?:اقصد|قصدي)\s+/u.test(text) ||
        /^لا\s*[،,]?\s*(?:جديد|جديدة|مستعمل|مستعملة)$/u.test(text)),
  );
}

function explicitConfiguredCategory(
  message: string,
  configured?: readonly MarketplaceCategorySchema[],
): MarketplaceCategorySchema | undefined {
  if (!configured?.length) return undefined;
  // A reply that is exactly a category's label (as offered in «اختر تصنيف العرض») names that
  // category, even when another category lists the same word as an alias («منزل»).
  const whole = normalizeSearch(message).trim();
  const labelled = configured.find((schema) => normalizeSearch(schema.label) === whole);
  if (labelled) return labelled;
  const match = (configured ?? [])
    .flatMap((schema) =>
      [schema.label, ...schema.aliases].map((alias) => ({
        schema,
        alias: normalizeSearch(alias),
      })),
    )
    .filter(({ alias }) => alias.length >= 2 && hasCategoryAlias(message, alias, { possessive: true }))
    .sort((a, b) => b.alias.length - a.alias.length);
  // A word two categories share, written as a purpose («للمنزل»: for the home), names
  // the category whose own label it is, not the other category's alias.
  const [best, second] = match;
  const purposeWords = new Set(normalizeSearch(message).split(/\s+/).flatMap((word) => (word.startsWith("لل") ? [word.slice(2)] : word.startsWith("ل") ? [word.slice(1)] : [])));
  if (best && second && best.alias === second.alias && purposeWords.has(best.alias)) {
    const labelled = match.find((item) => item.alias === best.alias && normalizeSearch(item.schema.label) === item.alias);
    if (labelled) return labelled.schema;
  }
  return best?.schema;
}

function isCategoryOnlySelection(
  message: string,
  category: MarketplaceCategorySchema,
): boolean {
  const title = normalizeSearch(cleanTitle(message));
  return [category.label, ...category.aliases].some(
    (alias) => normalizeSearch(alias) === title,
  );
}

function categoryFromSaleText(
  message: string,
  configured?: readonly MarketplaceCategorySchema[],
): string | undefined {
  if (!configured?.length) return undefined;
  const explicitCategory = explicitConfiguredCategory(message, configured);
  if (explicitCategory) return explicitCategory.label;

  const explicitServiceOffer =
    /(?:أعرض|اعرض|أقدم|اقدم|أوفر|اوفر)\s+(?:خدمتي|الخدمة|خدمة)/u.test(
      message,
    );
  if (explicitServiceOffer) {
    const serviceCategory = configured.find(
      (schema) =>
        schema.resourceType === "SERVICE" &&
        schema.aliases.some((alias) =>
          ["خدمة", "خدمات", "service", "services"].includes(
            normalizeSearch(alias),
          ),
        ),
    );
    if (serviceCategory) return serviceCategory.label;
  }

  const inferred = parseStructuredSearch(message, undefined, configured);
  return configured.find(
    (category) => category.id === inferred?.categoryId,
  )?.label;
}

function categoryForDraft(
  draft: z.infer<typeof ConversationDraft>,
  configured: readonly MarketplaceCategorySchema[],
) {
  return (
    configured.find(
      (schema) =>
        schema.id === draft.categoryId || schema.label === draft.category,
    )
  );
}

/**
 * Short draft (owner decision): contact defaults to DINAR chat (phones are shown to both parties
 * once the seller accepts an order) and payment to direct settlement between the parties (in-app
 * card is not offered yet). Both appear in the review and change by saying so in the chat.
 */
function applyShortDraftDefaults(draft: z.infer<typeof ConversationDraft>) {
  if (!draft.contactPreference) {
    draft.contactPreference = "CHAT_ONLY";
    draft.sources = { ...(draft.sources ?? {}), contactPreference: "DINAR_DERIVED" };
  }
  if (!draft.paymentMethods?.length) {
    draft.paymentMethods = ["CASH_DIRECT"];
    draft.sources = { ...(draft.sources ?? {}), paymentMethods: "DINAR_DERIVED" };
  }
}

function missingDraftSteps(
  draft: z.infer<typeof ConversationDraft>,
  configured: readonly MarketplaceCategorySchema[],
) : string[] {
  const schema = categoryForDraft(draft, configured);
  if (!schema) return ["category"];
  const missing: string[] = [];
  const required = new Set([
    ...schema.rules.sellerDraft.requiredFields,
    "TITLE",
    "DESCRIPTION",
    "PRICE",
    "FULFILMENT",
    "LOCATION",
    "CONTACT",
  ]);
  const inventory = schema.rules.inventory;
  const pricing = schema.rules.pricing;
  if (inventory.semantics === "NON_STOCK") {
    draft.inventoryMode = "UNLIMITED";
    delete draft.availableQuantity;
  } else if (inventory.semantics === "SINGLE") {
    draft.inventoryMode = "LIMITED";
    draft.availableQuantity = "1";
  } else if (
    !draft.inventoryMode &&
    !required.has("INVENTORY")
  ) {
    draft.inventoryMode = inventory.defaultMode;
    if (inventory.defaultMode === "LIMITED")
      draft.availableQuantity = String(inventory.defaultQuantity ?? 1);
  }
  if (!draft.pricingMode && pricing.allowedModes.length === 1)
    draft.pricingMode = pricing.defaultMode;
  applyShortDraftDefaults(draft);

  for (const [key, definition] of Object.entries(schema.attributes))
    if (
      definition.requiredForPublish &&
      (draft.attributes?.[key] == null ||
        (typeof draft.attributes[key] === "string" && !draft.attributes[key].trim()))
    )
      missing.push(`attribute:${key}`);

  for (const field of required) {
    if (field === "TITLE" && (!draft.title || draft.title.trim().length < 3))
      missing.push("title");
    if (
      field === "DESCRIPTION" &&
      (!draft.description || draft.description.trim().length < 10)
    )
      missing.push("description");
    if (
      field === "PRICE" &&
      !(isUnpricedMode(draft.pricingMode) &&
        pricing.allowedModes.includes(draft.pricingMode!)) &&
      !draft.unitPrice
    )
      missing.push("price");
    if (
      field === "INVENTORY" &&
      inventory.semantics === "TRACKED" &&
      !draft.inventoryMode
    )
      missing.push("quantity");
    if (field === "LOCATION" && (!draft.area || draft.area.trim().length < 2))
      missing.push("area");
    if (field === "FULFILMENT" && !draft.fulfilmentType) missing.push("fulfilment");
    if (field === "CONTACT" && !draft.contactPreference) missing.push("contact");
  }
  if (!draft.paymentMethods?.length) missing.push("payment_methods");
  return missing;
}

/** First missing step; "review" when the draft is complete. */
function nextDraftStep(
  draft: z.infer<typeof ConversationDraft>,
  configured: readonly MarketplaceCategorySchema[],
) {
  return missingDraftSteps(draft, configured)[0] ?? "review";
}

// ─── Block F: provenance and typed review ────────────────────────────────────

type Draft = z.infer<typeof ConversationDraft>;
const TRACKED_FIELDS = ["title", "description", "unitPrice", "availableQuantity", "inventoryMode", "area", "fulfilmentType", "contactPreference", "paymentMethods"] as const;

function draftFieldValues(draft: Draft): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of TRACKED_FIELDS) if (draft[field] !== undefined) values[field] = String(draft[field]);
  if (draft.categoryId ?? draft.category) values.category = String(draft.categoryId ?? draft.category);
  const images = [draft.imageUrl, ...(draft.imageUrls ?? [])].filter(Boolean);
  if (images.length) values.images = images.join("|");
  for (const [key, value] of Object.entries(draft.attributes ?? {})) values[`attributes.${key}`] = String(value);
  return values;
}

/** Marks every field whose value changed with the source that changed it. */
function markDraftSources(before: Draft, draft: Draft, source: FactSource) {
  const previous = draftFieldValues(before);
  const current = draftFieldValues(draft);
  const sources = { ...(draft.sources ?? {}) };
  for (const [field, value] of Object.entries(current)) if (previous[field] !== value) sources[field] = source;
  for (const field of Object.keys(sources)) if (current[field] === undefined) delete sources[field];
  draft.sources = sources;
}

/** Runs the step rules and marks the defaults they fill in as DINAR-derived. */
function nextDraftStepWithSources(draft: Draft, configured: readonly MarketplaceCategorySchema[]) {
  const before = structuredClone(draft);
  const step = nextDraftStep(draft, configured);
  markDraftSources(before, draft, "DINAR_DERIVED");
  return step;
}

const STEP_LABELS: Record<string, string> = {
  category: "التصنيف",
  title: "العنوان",
  description: "الوصف",
  price: "السعر",
  quantity: "الكمية",
  area: "المنطقة",
  fulfilment: "طريقة الاستلام",
  contact: "طريقة التواصل",
  payment_methods: "طرق الدفع",
};

export type DraftReviewField = { field: string; label: string; value: string | number | null; source: FactSource; needsConfirmation: boolean };
export type DraftReview = {
  fields: DraftReviewField[];
  missingFields: { field: string; label: string }[];
  actions: ("PUBLISH" | "EDIT" | "CANCEL")[];
};

/**
 * The typed draft review: each value with its provenance, image guesses only where the
 * seller has not stated the field (and marked as needing confirmation), and every
 * still-missing required field, so DINAR asks only for those.
 */
export function buildDraftReview(
  input: Draft,
  configured: readonly MarketplaceCategorySchema[],
  suggestions: readonly { field: string; value: string | number }[] = [],
): DraftReview {
  const draft = structuredClone(input);
  const schema = categoryForDraft(draft, configured);
  const sourceOf = (field: string): FactSource => draft.sources?.[field] ?? "USER_DECLARED";
  const fields: DraftReviewField[] = [];
  const push = (field: string, label: string, candidates: Fact<string | number>[]) => {
    const fact = resolveFact(candidates);
    fields.push({ field, label, value: fact.value, source: fact.source, needsConfirmation: fact.source === "IMAGE_INFERRED" });
  };
  const suggested = (field: string): Fact<string | number>[] =>
    suggestions.filter((item) => item.field === field).map((item) => ({ value: item.value, source: "IMAGE_INFERRED" }));
  const categorySuggestion = suggested("category").map((fact) => ({
    ...fact,
    value: configured.find((category) => category.id === fact.value || category.label === fact.value)?.label ?? null,
  }));
  push("title", "العنوان", [
    ...suggested("title"),
    { value: draft.title ?? null, source: sourceOf("title") },
  ]);
  push("description", "الوصف", [
    ...suggested("description"),
    { value: draft.description ?? null, source: sourceOf("description") },
  ]);
  push("category", "التصنيف", [...categorySuggestion, { value: schema?.label ?? null, source: sourceOf("category") }]);
  push("unitPrice", "السعر", [{ value: draft.unitPrice ?? null, source: sourceOf("unitPrice") }]);
  push("availableQuantity", "الكمية", [
    { value: draft.inventoryMode === "UNLIMITED" ? "غير محدودة" : draft.availableQuantity ?? null, source: sourceOf(draft.inventoryMode === "UNLIMITED" ? "inventoryMode" : "availableQuantity") },
  ]);
  const attributeKeys = new Set([
    ...Object.keys(schema?.attributes ?? {}),
    ...Object.keys(draft.attributes ?? {}),
    ...suggestions
      .map((item) => item.field)
      .filter((field) => !["category", "title", "description"].includes(field)),
  ]);
  for (const key of attributeKeys) {
    const own = draft.attributes?.[key];
    const candidates: Fact<string | number>[] = [...suggested(key), { value: own ?? null, source: sourceOf(`attributes.${key}`) }];
    if (own == null && !candidates.some((fact) => fact.value != null)) continue;
    push(`attributes.${key}`, schema?.attributes[key]?.label ?? key, candidates);
  }
  const images = [draft.imageUrl, ...(draft.imageUrls ?? [])].filter(Boolean).length;
  push("images", "الصور", [{ value: images || null, source: sourceOf("images") }]);
  push("area", "المنطقة (عامة)", [{ value: draft.area ?? null, source: sourceOf("area") }]);
  if (draft.contactPreference) {
    const contactLabel =
      draft.contactPreference === "ACCOUNT_PHONE"
        ? "رقم الحساب — موافقة صريحة"
        : draft.contactPreference === "LISTING_PHONE"
          ? "رقم مخصص لهذا الإعلان"
          : "محادثة DINAR فقط";
    push("contactPreference", "طريقة التواصل", [
      { value: contactLabel, source: sourceOf("contactPreference") },
    ]);
  }
  if (draft.paymentMethods?.length) {
    const labels = draft.paymentMethods.map((method) =>
      method === "CASH_DIRECT" ? "كاش" : "فيزا داخل DINAR",
    );
    push("paymentMethods", "طرق الدفع", [
      { value: labels.join(" + "), source: sourceOf("paymentMethods") },
    ]);
  }
  if (draft.priceRepresentation)
    push("priceRepresentation", "معنى السعر", [{
      value: draft.priceRepresentation === "STARTING_FROM" ? "يبدأ من — ليس سعرًا نهائيًا" : "حسب التسعيرة — ترسلها للمشتري",
      source: sourceOf("priceRepresentation"),
    }]);
  // Universal negotiation: «final» describes the displayed price; buyers may still propose one.
  if (draft.negotiable !== undefined) push("negotiable", "التفاوض على السعر", [{ value: draft.negotiable ? "يقبل عروض الأسعار" : "سعر محدد؛ ويبقى للمشتري تقديم عرض", source: sourceOf("negotiable") }]);
  const missingFields = missingDraftSteps(draft, configured).map((step) => ({
    field: step,
    label: step.startsWith("attribute:")
      ? schema?.attributes[step.slice("attribute:".length)]?.label ?? step
      : STEP_LABELS[step] ?? step,
  }));
  return { fields, missingFields, actions: missingFields.length ? ["EDIT", "CANCEL"] : ["PUBLISH", "EDIT", "CANCEL"] };
}

export function promptForDraftStep(
  step: string,
  draft: z.infer<typeof ConversationDraft>,
  configured: readonly MarketplaceCategorySchema[],
) {
  const schema = categoryForDraft(draft, configured);
  if (step.startsWith("attribute:")) {
    const key = step.slice("attribute:".length);
    const definition = categoryForDraft(draft, configured)?.attributes[key];
    if (!definition) return prompts.review;
    const options = definition.options?.length
      ? ` القيم المتاحة: ${definition.options.join("، ")}.`
      : "";
    return `ما قيمة ${definition.label}؟${options}`;
  }
  if (step === "category")
    return "صف المنتج أو الخدمة التي تريد عرضها بكلماتك؛ لا تحتاج لاختيار تصنيف.";
  if (step === "payment_methods") return prompts.payment_methods;
  if (step === "price" && schema) {
    const modes = schema.rules.pricing.allowedModes;
    const modeNames: Record<ListingPricingMode, string> = {
      FIXED: "سعر ثابت",
      NEGOTIABLE: "سعر قابل للتفاوض",
      OPEN_TO_OFFERS: "قدّم عرضك (السعر اختياري)",
    };
    // After «سعر قابل للتفاوض» or «سعر ثابت» only the amount is missing. A mode equal to the
    // category default counts only when the seller chose it (the default is pre-set on the draft).
    const modeChosen =
      draft.pricingMode !== undefined &&
      (draft.pricingMode !== schema.rules.pricing.defaultMode || draft.pricingModeChosen === true) &&
      !isUnpricedMode(draft.pricingMode) &&
      draft.unitPrice === undefined;
    return modes.length > 1 && !modeChosen
      ? `كيف تريد التسعير؟ اختر: ${modes.map((mode) => modeNames[mode]).join("، ")}، أو اكتب المبلغ مباشرة.`
      : "ما السعر المطلوب بعملة السوق؟";
  }
  if (step === "quantity" && schema) {
    return schema.rules.inventory.allowedModes.includes("UNLIMITED")
      ? "ما الكمية المتاحة؟ اكتب عددًا صحيحًا، أو اكتب «غير محدود»."
      : "كم وحدة متاحة؟ اكتب عددًا صحيحًا.";
  }
  return prompts[step] ?? prompts.review;
}

function consumeDraftAnswer(
  draft: z.infer<typeof ConversationDraft>,
  step: string,
  message: string,
  configured: readonly MarketplaceCategorySchema[],
) {
  const text = message.trim();
  const normalized = normalizeSearchNumberText(text).trim();
  const schema = categoryForDraft(draft, configured);

  if (step === "payment_methods") {
    const methods = parseSellerPaymentMethods(text, true);
    if (!methods) return false;
    draft.paymentMethods = methods;
    return true;
  }

  if (step.startsWith("attribute:")) {
    const key = step.slice("attribute:".length);
    const definition = schema?.attributes[key];
    if (!definition) return false;
    const value =
      definition.type === "number"
        ? Number(normalized.replace(/[٬,]/g, ""))
        : text;
    if (
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && !value.trim())
    )
      return false;
    const candidate = { ...(draft.attributes ?? {}), [key]: value };
    const validated = validateCategoryAttributesAgainstSchema(
      draft.category ?? "",
      candidate,
      schema,
      false,
    );
    if (!validated.ok) return false;
    draft.attributes = validated.attributes;
    return true;
  }

  if (step === "title" && text.length >= 3) {
    draft.title = (cleanTitle(text) || text).slice(0, 120);
    return true;
  }
  if (step === "description" && text.length >= 10) {
    draft.description = text.slice(0, 5000);
    return true;
  }
  if (step === "price") {
    const pricing = schema?.rules.pricing;
    const normalizedIntent = normalizeSearch(text);
    if (
      pricing?.allowedModes.includes("OPEN_TO_OFFERS") &&
      (/بدون سعر|شيل السعر|احذف السعر|حسب الاتفاق|اتفاق مع البائع|بعد المعاينة|يحدد لاحق|يحدد عند|سعر مفتوح|يقدمون عروض|يقدموا عروض/.test(
        normalizedIntent,
      ) || QUOTE_WORDS.test(normalizedIntent))
    ) {
      draft.pricingMode = "OPEN_TO_OFFERS";
      delete draft.unitPrice;
      setPriceRepresentation(draft, QUOTE_WORDS.test(normalizedIntent) ? "QUOTE_REQUIRED" : undefined);
      return true;
    }
    // The options offered in the question, typed back as offered («قدّم عرضك», «سعر ثابت»).
    if (pricing?.allowedModes.includes("OPEN_TO_OFFERS") && /(?:^|\s)(?:قد+م|قدّم)\s+عرضك|استقبل\s+عروض|اقبل\s+عروض/u.test(`${text} ${normalizedIntent}`)) {
      draft.pricingMode = "OPEN_TO_OFFERS";
      delete draft.unitPrice;
      setPriceRepresentation(draft, undefined);
      return true;
    }
    const chosenMode: ListingPricingMode | undefined = /^(?:سعر\s+)?قابل\s+(?:للتفاوض|للمساومه|للمساومة)$/u.test(normalizedIntent)
      ? "NEGOTIABLE"
      : /^سعر\s+ثابت$/u.test(normalizedIntent)
        ? "FIXED"
        : undefined;
    if (chosenMode && pricing?.allowedModes.includes(chosenMode)) {
      // The mode is chosen; the amount is still asked for («ما السعر المطلوب…»).
      draft.pricingMode = chosenMode;
      draft.pricingModeChosen = true;
      setPriceRepresentation(draft, undefined);
      return true;
    }
    const parsed = extractInitialUnitPrice(text);
    const bare = normalized.match(/^(\d+(?:\.\d+)?)$/);
    const value = parsed?.value ?? (bare ? Number(bare[1]) : undefined);
    if (value && Number.isFinite(value) && value > 0) {
      const startingFrom = /ابتداء من|يبدا من|السعر يبدا من/.test(
        normalizedIntent,
      );
      const wantsNegotiable = /قابل للتفاوض|قابل للمساومة|للتفاوض|للمساومة/.test(normalizedIntent);
      const mode: ListingPricingMode | undefined = wantsNegotiable
        ? pricing?.allowedModes.includes("NEGOTIABLE")
          ? "NEGOTIABLE"
          : undefined
        : startingFrom
        ? pricing?.allowedModes.includes("FIXED")
          ? "FIXED"
          : undefined
        : draft.pricingMode && !isUnpricedMode(draft.pricingMode) && pricing?.allowedModes.includes(draft.pricingMode)
          ? draft.pricingMode
          : pricing?.allowedModes.includes("FIXED")
            ? "FIXED"
            : pricing?.defaultMode;
      if (!mode || !pricing?.allowedModes.includes(mode)) return false;
      draft.unitPrice = String(value);
      draft.pricingMode = mode;
      // A starting amount stays non-binding; a plain amount keeps an earlier starting meaning only
      // when the seller does not switch to another mode.
      if (startingFrom) setPriceRepresentation(draft, "STARTING_FROM");
      else if (wantsNegotiable || draft.priceRepresentation === "QUOTE_REQUIRED") setPriceRepresentation(draft, undefined);
      return true;
    }
  }
  if (step === "quantity") {
    const inventory = schema?.rules.inventory;
    if (inventory?.semantics === "NON_STOCK") {
      draft.inventoryMode = "UNLIMITED";
      delete draft.availableQuantity;
      return true;
    }
    if (inventory?.semantics === "SINGLE") {
      draft.inventoryMode = "LIMITED";
      draft.availableQuantity = "1";
      return true;
    }
    if (/^(?:نعم|اي|أيوه|ايوه|قطعة واحدة|واحدة|واحد|واحده|قطعة)$/u.test(normalizeSearch(text))) {
      if (!inventory?.allowedModes.includes("LIMITED")) return false;
      draft.inventoryMode = "LIMITED";
      draft.availableQuantity = "1";
      return true;
    }
    if (/غير محدود|دون حد|لا ينفد/u.test(normalizeSearch(text))) {
      if (!inventory?.allowedModes.includes("UNLIMITED")) return false;
      draft.inventoryMode = "UNLIMITED";
      delete draft.availableQuantity;
      return true;
    }
    const stated = /^\d+$/.test(normalized) ? Number(normalized) : statedQuantity(text);
    if (stated !== undefined) {
      const quantity = stated;
      if (
        inventory?.allowedModes.includes("LIMITED") &&
        Number.isSafeInteger(quantity) &&
        quantity > 0 &&
        quantity <= 1_000_000
      ) {
        draft.inventoryMode = "LIMITED";
        draft.availableQuantity = String(quantity);
        return true;
      }
    }
  }
  if (step === "area" && text.length >= 2) {
    const parsed = parseStructuredSearch(text, {
      search: "",
      categoryId: schema?.id,
      filters: [],
    }, configured);
    const city = parsed?.filters.find(
      (filter) => filter.field === "city" && typeof filter.value === "string",
    )?.value;
    draft.city = typeof city === "string" ? city.slice(0, 100) : text.slice(0, 100);
    draft.area = initialArea(text) ?? text.slice(0, 200);
    return true;
  }
  if (step === "fulfilment") {
    const method = /استلام/u.test(text)
      ? "PICKUP"
      : /رقمي/u.test(text)
        ? "DIGITAL"
        : /خدمة/u.test(text)
          ? "SERVICE"
          : undefined;
    if (method) {
      draft.fulfilmentType = method;
      return true;
    }
  }
  if (step === "contact") {
    if (hasPersonalNumberIntent(text)) return false;
    if (explicitAccountPhoneConsent(text)) {
      delete draft.contactPhone;
      draft.contactPreference = "ACCOUNT_PHONE";
      return true;
    }
    const contact = extractListingContactPhone(text);
    if (contact.phone) {
      draft.contactPhone = contact.phone;
      draft.contactPreference = "LISTING_PHONE";
      return true;
    }
    if (/محادثة|داخل التطبيق|بدون رقم|لا رقم|لا اريد رقم|خاص/u.test(normalizeSearch(text))) {
      delete draft.contactPhone;
      draft.contactPreference = "CHAT_ONLY";
      return true;
    }
  }
  if (step === "contact_account_confirmation") {
    const normalized = normalizeSearch(text);
    if (/^(?:نعم|اي|أيوه|ايوه|أكيد|اكيد|موافق|موافقة|استخدمه|اعتمده)$/u.test(normalized)) {
      delete draft.contactPhone;
      draft.contactPreference = "ACCOUNT_PHONE";
      return true;
    }
    if (
      /^(?:لا|كلا|لا شكرا|لا شكرًا)$/u.test(normalized) ||
      /^(?:لا\s*[،,]?\s*)?(?:لا تستخدم|لا تستعمل|ما ابي|ما ابغى)\s+(?:رقمي|رقم حسابي)$/u.test(normalized)
    )
      return true;
    const contact = extractListingContactPhone(text);
    if (contact.phone) {
      draft.contactPhone = contact.phone;
      draft.contactPreference = "LISTING_PHONE";
      return true;
    }
    if (/محادثة|داخل التطبيق|بدون رقم|لا رقم|لا اريد رقم|خاص/u.test(normalized)) {
      delete draft.contactPhone;
      draft.contactPreference = "CHAT_ONLY";
      return true;
    }
  }
  return false;
}

function explicitAccountPhoneConsent(message: string) {
  const normalized = normalizeSearch(message);
  return /(?:استخدم|استخدمي|اعتمد|اعتمدي|حط|حطي|خل|خلي)\s+(?:لي\s+)?(?:رقم\s+)?(?:حسابي|رقمي\s+المسجل|رقم\s+حسابي|رقم\s+الدخول)|(?:رقم\s+حسابي|رقمي\s+المسجل)\s+(?:للتواصل|للاعلان|للإعلان)/u.test(normalized);
}

function hasPersonalNumberIntent(message: string) {
  const normalized = normalizeSearch(message);
  return /^(?:(?:(?:التواصل|للتواصل)\s+)?(?:على|علي)\s+(?:رقمي|رقم\s+حسابي)|برقمي|رقمي|رقم\s+حسابي)$/u.test(normalized);
}

function updateDraftImages(
  draft: z.infer<typeof ConversationDraft>,
  message: string,
  uploadedPaths: readonly string[],
) {
  const images = [
    ...(draft.imageUrl ? [draft.imageUrl] : []),
    ...(draft.imageUrls ?? []),
  ];
  const normalized = normalizeSearch(message);
  const remove = /(?:احذف|ازيل|شيل)\s+(?:الصورة|الصوره)\s*(الاولى|الاول|الثانيه|الثانية|الثالثه|الثالثة|[1-4١-٤])/u.exec(normalized);
  const replace = /(?:استبدل|بدل|غير)\s+(?:الصورة|الصوره)\s*(الاولى|الاول|الثانيه|الثانية|الثالثه|الثالثة|[1-4١-٤])/u.exec(normalized);
  const positionText = remove?.[1] ?? replace?.[1];
  const index =
    positionText === "الاولى" || positionText === "الاول" || positionText === "1" || positionText === "١" ? 0 :
    positionText === "الثانيه" || positionText === "الثانية" || positionText === "2" || positionText === "٢" ? 1 :
    positionText === "الثالثه" || positionText === "الثالثة" || positionText === "3" || positionText === "٣" ? 2 :
    positionText === "4" || positionText === "٤" ? 3 : undefined;
  if (remove && index !== undefined && index < images.length)
    images.splice(index, 1);
  if (uploadedPaths.length) {
    const uniqueUploads = [...new Set(uploadedPaths)];
    if (replace && index !== undefined && index < images.length)
      images.splice(index, 1, ...uniqueUploads);
    else images.push(...uniqueUploads);
  }
  const uniqueImages = [...new Set(images)];
  if (uniqueImages.length > 4)
    throw Object.assign(new Error("يمكن إرفاق أربع صور كحد أقصى."), {
      status: 400,
    });
  if (uniqueImages[0]) draft.imageUrl = uniqueImages[0];
  else delete draft.imageUrl;
  if (uniqueImages.length > 1) draft.imageUrls = uniqueImages.slice(1);
  else delete draft.imageUrls;
}

export function structuredDraftUpdates(
  draft: z.infer<typeof ConversationDraft>,
  message: string,
  configured: readonly MarketplaceCategorySchema[] = [],
): { draft: z.infer<typeof ConversationDraft>; changed: boolean } {
  let changed = false;
  const paymentMethods = parseSellerPaymentMethods(message);
  if (paymentMethods) {
    draft.paymentMethods = paymentMethods;
    changed = true;
  }
  const contact = extractListingContactPhone(message);
  if (contact.phone) {
    draft.contactPhone = contact.phone;
    draft.contactPreference = "LISTING_PHONE";
    changed = true;
  }
  if (!contact.phone && explicitAccountPhoneConsent(message)) {
    delete draft.contactPhone;
    draft.contactPreference = "ACCOUNT_PHONE";
    changed = true;
  }
  if (
    draft.contactPreference === "ACCOUNT_PHONE" &&
    /^(?:لا\s*[،,]?\s*)?(?:لا تستخدم|لا تستعمل|ما ابي|ما ابغى)\s+(?:رقمي|رقم حسابي)$/u.test(normalizeSearch(message))
  ) {
    delete draft.contactPhone;
    delete draft.contactPreference;
    return { draft, changed: true };
  }
  if (/محادثة فقط|داخل التطبيق فقط|بدون رقم|لا رقم|لا أريد رقم/u.test(message)) {
    delete draft.contactPhone;
    draft.contactPreference = "CHAT_ONLY";
    changed = true;
  }
  const area = initialArea(contact.text);
  if (area) {
    draft.area = area;
    changed = true;
  }
  message = contact.text;
  const previousSchema = categoryForDraft(draft, configured);
  const selectedCategory = explicitConfiguredCategory(message, configured);
  if (selectedCategory && selectedCategory.id !== previousSchema?.id) {
    const keepUnclassifiedData = !previousSchema;
    const pendingAttributes = keepUnclassifiedData ? draft.attributes : undefined;
    const pendingPrice = keepUnclassifiedData ? draft.unitPrice : undefined;
    const pendingPricingMode =
      keepUnclassifiedData &&
      draft.pricingMode &&
      selectedCategory.rules.pricing.allowedModes.includes(draft.pricingMode)
        ? draft.pricingMode
        : undefined;
    const pendingQuantity = keepUnclassifiedData
      ? draft.availableQuantity
      : undefined;
    draft.category = selectedCategory.label;
    draft.categoryId = selectedCategory.id;
    delete draft.attributes;
    const pricing = selectedCategory.rules.pricing;
    draft.pricingMode =
      pendingPricingMode ??
      (pricing.allowedModes.includes("FIXED") ? "FIXED" : pricing.defaultMode);
    if (
      pendingPrice &&
      !isUnpricedMode(draft.pricingMode) &&
      pricing.allowedModes.includes(draft.pricingMode)
    )
      draft.unitPrice = pendingPrice;
    else delete draft.unitPrice;

    if (pendingAttributes) {
      const validated = validateCategoryAttributesAgainstSchema(
        selectedCategory.label,
        pendingAttributes,
        selectedCategory,
        false,
      );
      if (validated.ok && Object.keys(validated.attributes).length)
        draft.attributes = validated.attributes;
    }

    if (selectedCategory.rules.inventory.semantics === "NON_STOCK") {
      draft.inventoryMode = "UNLIMITED";
      delete draft.availableQuantity;
    } else if (selectedCategory.rules.inventory.semantics === "SINGLE") {
      draft.inventoryMode = "LIMITED";
      draft.availableQuantity = "1";
    } else {
      const inventory = selectedCategory.rules.inventory;
      const quantity = Number(pendingQuantity);
      if (
        inventory.allowedModes.includes("LIMITED") &&
        Number.isSafeInteger(quantity) &&
        quantity > 0 &&
        quantity <= 1_000_000
      ) {
        draft.inventoryMode = "LIMITED";
        draft.availableQuantity = String(quantity);
      } else if (
        !selectedCategory.rules.sellerDraft.requiredFields.includes(
          "INVENTORY",
        ) &&
        inventory.defaultMode === "LIMITED"
      ) {
        draft.inventoryMode = "LIMITED";
        draft.availableQuantity = String(inventory.defaultQuantity ?? 1);
      } else if (
        !selectedCategory.rules.sellerDraft.requiredFields.includes(
          "INVENTORY",
        ) &&
        inventory.defaultMode === "UNLIMITED"
      ) {
        draft.inventoryMode = "UNLIMITED";
        delete draft.availableQuantity;
      } else {
        delete draft.inventoryMode;
        delete draft.availableQuantity;
      }
    }
    if (selectedCategory.resourceType === "SERVICE")
      draft.fulfilmentType = "SERVICE";
    else if (previousSchema) delete draft.fulfilmentType;
    else draft.fulfilmentType = "PICKUP";
    changed = true;
  }
  const schema = categoryForDraft(draft, configured);
  if (!schema) {
    const normalizedIntent = normalizeSearch(message);
    const quoteRequested =
      /بدون سعر|شيل السعر|احذف السعر|حسب الاتفاق|اتفاق مع البائع|بعد المعاينة|يحدد لاحق|يحدد عند|سعر مفتوح|يقدمون عروض|يقدموا عروض/.test(
        normalizedIntent,
      );
    const startingPriceRequested =
      /ابتداء من|يبدا من|السعر يبدا من/.test(normalizedIntent);
    const pendingPrice = extractInitialUnitPrice(message);
    if (quoteRequested || QUOTE_WORDS.test(normalizedIntent)) {
      draft.pricingMode = "OPEN_TO_OFFERS";
      delete draft.unitPrice;
      setPriceRepresentation(draft, QUOTE_WORDS.test(normalizedIntent) ? "QUOTE_REQUIRED" : undefined);
      changed = true;
    } else if (startingPriceRequested || pendingPrice) {
      // A starting amount is collected like a price but published as STARTING_FROM, never as binding.
      draft.pricingMode = "FIXED";
      if (pendingPrice) draft.unitPrice = String(pendingPrice.value);
      setPriceRepresentation(draft, startingPriceRequested ? "STARTING_FROM" : undefined);
      changed = true;
    }

    const pendingQuantity = extractInitialQuantity(message);
    if (pendingQuantity !== undefined) {
      draft.availableQuantity = String(pendingQuantity);
      changed = true;
    }

    const condition = /مستعمل(?:ة)?/u.test(normalizedIntent)
      ? "مستعمل"
      : /جديد(?:ة)?/u.test(normalizedIntent)
        ? "جديد"
        : undefined;
    if (condition) {
      draft.attributes = { ...(draft.attributes ?? {}), condition };
      changed = true;
    }

    const description = initialDescription(
      message,
      pendingPrice,
      draft.title,
    );
    if (/\p{L}/u.test(description)) {
      const existing = draft.description?.trim();
      const alreadyIncluded =
        existing &&
        normalizeSearch(existing).includes(normalizeSearch(description));
      if (!alreadyIncluded) {
        draft.description = [existing, description]
          .filter(Boolean)
          .join(" ")
          .slice(0, 5000);
        changed = true;
      }
    }
    return { draft, changed };
  }
  const pricing = schema.rules.pricing;
  const normalizedIntent = normalizeSearch(message);
  const quoteRequested =
    /بدون سعر|شيل السعر|احذف السعر|حسب الاتفاق|اتفاق مع البائع|بعد المعاينة|يحدد لاحق|يحدد عند|سعر مفتوح|يقدمون عروض|يقدموا عروض/.test(
      normalizedIntent,
    ) || QUOTE_WORDS.test(normalizedIntent);
  if (quoteRequested && pricing.allowedModes.includes("OPEN_TO_OFFERS")) {
    draft.pricingMode = "OPEN_TO_OFFERS";
    delete draft.unitPrice;
    setPriceRepresentation(draft, QUOTE_WORDS.test(normalizedIntent) ? "QUOTE_REQUIRED" : undefined);
    changed = true;
  } else {
    const explicitPrice = extractInitialUnitPrice(message);
    if (explicitPrice) {
      const mode =
        draft.pricingMode && pricing.allowedModes.includes(draft.pricingMode)
          ? draft.pricingMode
          : pricing.defaultMode;
      if (pricing.allowedModes.includes(mode)) {
        draft.unitPrice = String(explicitPrice.value);
        draft.pricingMode = mode;
        changed = true;
      }
    }
  }
  const bareAmount = normalizeSearchNumberText(message)
    .trim()
    .replace(/[,،]/g, "")
    .match(/^(\d+(?:\.\d+)?)\s*(ألف|الف|مليون|k)?$/i);
  if (bareAmount) {
    const multiplier =
      /^(?:ألف|الف|k)$/i.test(bareAmount[2] ?? "") ? 1_000 :
      /^مليون$/i.test(bareAmount[2] ?? "") ? 1_000_000 : 1;
    const value = Number(bareAmount[1]) * multiplier;
    if (Number.isFinite(value) && value > 0) {
      if (!draft.unitPrice) {
        const priceMode = schema.rules.pricing.allowedModes.includes("FIXED")
          ? "FIXED"
          : schema.rules.pricing.defaultMode;
        if (
          !isUnpricedMode(priceMode) &&
          schema.rules.pricing.allowedModes.includes(priceMode)
        )
        return {
          draft: {
            ...draft,
            unitPrice: String(value),
            pricingMode: priceMode,
          },
          changed: true,
        };
      }
      if (schema.attributes.mileage && multiplier >= 1_000) {
        const attributes = { ...(draft.attributes ?? {}), mileage: value };
        const normalized = validateCategoryAttributesAgainstSchema(
          draft.category ?? "",
          attributes,
          schema,
          false,
        );
        if (normalized.ok)
          return {
            draft: { ...draft, attributes: normalized.attributes },
            changed: true,
          };
      }
    }
  }
  const correctionText = message.replace(
    /^\s*(?:لا\s*[،,]?\s*)?(?:أقصد|اقصد|قصدي)\s+/u,
    "",
  );
  const parsed = parseStructuredSearch(correctionText, {
    search: "",
    categoryId: schema.id,
    filters: [],
  }, configured);
  if (!parsed?.filters.length) return { draft, changed };

  const attributes = { ...(draft.attributes ?? {}) };
  let unitPrice = draft.unitPrice;
  let pricingMode = draft.pricingMode;
  for (const filter of parsed.filters) {
    if (filter.field === "price" && filter.operator === "eq") {
      unitPrice = String(filter.value);
      pricingMode =
        !isUnpricedMode(schema.rules.pricing.defaultMode)
          ? schema.rules.pricing.defaultMode
          : schema.rules.pricing.allowedModes.includes("FIXED")
            ? "FIXED"
            : "OPEN_TO_OFFERS";
      changed = true;
    } else if (
      schema.attributes[filter.field] &&
      (filter.operator === "eq" || filter.operator === "contains")
    ) {
      const previousValue = attributes[filter.field];
      attributes[filter.field] = filter.value;
      if (
        filter.field === "audience" &&
        typeof previousValue === "string" &&
        typeof filter.value === "string" &&
        draft.title
      ) {
        draft.title = draft.title.replace(previousValue, filter.value);
      }
      changed = true;
    } else if (filter.field === "city" && typeof filter.value === "string") {
      draft.city = filter.value;
      changed = true;
    }
  }
  const normalized = validateCategoryAttributesAgainstSchema(
    draft.category ?? "",
    attributes,
    schema,
    false,
  );
  if (normalized.ok) {
    return {
      draft: {
        ...draft,
        ...(unitPrice ? { unitPrice } : {}),
        ...(pricingMode ? { pricingMode } : {}),
        attributes: normalized.attributes,
      },
      changed,
    };
  }
  return { draft, changed: false };
}

/** Long whitespace runs make the `\s*…\s*` draft patterns backtrack; meaning never depends on them. */
/** «خلنا نحطه 500», «حطه بـ500», «سعره 500»: the price of the draft in progress. */
function draftPricePhrase(message: string): { value: number } | undefined {
  const text = normalizeSearchNumberText(normalizeSearch(message)).replace(/ـ/g, "").trim();
  const match = text.match(/^(?:(?:خلنا|خلينا|خل|خلي|نبي|ابي)\s+)?(?:نحطه|نحطها|حطه|حطها|نخليه|نخليها|خليه|خليها|خله|خلها|سعره|سعرها|السعر)\s+(?:يكون\s+)?(?:ب\s*)?(\d+(?:\.\d+)?)$/u);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? { value } : undefined;
}

/** «قابل للمساومة» / «السعر نهائي»: whether the seller accepts price offers, if they said. */
export function negotiableStatement(message: string): boolean | undefined {
  const text = normalizeSearch(message);
  if (/(?:غير قابل|مو قابل|مش قابل|ما يقبل|لا يقبل)\s+(?:لل)?(?:مساومه|مساومة|تفاوض|نقاش)|السعر (?:نهائي|ثابت)|(?:بدون|ما في|مافي)\s+(?:مساومه|مساومة|تفاوض)/u.test(text))
    return false;
  if (/قابل\s+(?:لل)?(?:مساومه|مساومة|تفاوض|نقاش|للتفاوض)|(?:يقبل|اقبل)\s+(?:ال)?(?:مساومه|مساومة|تفاوض|عروض)|فيه مجال (?:للتفاوض|بالسعر)/u.test(text))
    return true;
  return undefined;
}

/**
 * «لا، البطارية 89٪» after the seller wrote «البطارية 86٪»: an explicit correction of a fact in
 * the seller's own description replaces that one value and keeps everything else.
 */
function correctDescribedFact(draft: z.infer<typeof ConversationDraft>, message: string): boolean {
  const said = message.trim();
  const body = stripCorrectionPrefix(said.replace(/^\s*(?:لا|لأ|عفوا|عفوًا|تصحيح)\s*[,،:]\s*/u, "")).trim();
  if (!draft.description || body === said) return false;
  const fact = /^(\S+(?:\s+\S+)?)\s+(\S+)$/u.exec(body);
  if (!fact) return false;
  const label = fact[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stated = new RegExp(`(${label}\\s*[:：]?\\s*)([^\\s،,.؛]+)`, "u");
  const current = stated.exec(draft.description);
  if (!current || current[2] === fact[2]) return false;
  draft.description = draft.description.replace(stated, (_whole, prefix: string) => `${prefix}${fact[2]}`);
  return true;
}

function collapseWhitespace(message: string): string {
  return message.replace(/[^\S\n]+/g, " ").replace(/\n{2,}/g, "\n");
}

export function createInitialSaleDraft(
  rawMessage: string,
  configured?: readonly MarketplaceCategorySchema[],
  imageObjectPaths: readonly string[] = [],
): {
  draft: z.infer<typeof ConversationDraft>;
  step: string;
} {
  const message = collapseWhitespace(rawMessage);
  const contact = extractListingContactPhone(message);
  const saleText = contact.text;
  const firstClause = saleText.split(/[،,؛;.\n]/u, 1)[0]?.trim() ?? "";
  const title = cleanTitle(firstClause);
  const category = categoryFromSaleText(saleText, configured);
  const schema = configured?.find((candidate) => candidate.label === category);
  const structured = category
     ? parseStructuredSearch(saleText, {
        search: "",
        categoryId: schema?.id,
        filters: [],
       }, configured)
    : undefined;
  const parsedPrice = structured?.filters.find(
    (filter) => filter.field === "price" && filter.operator === "eq",
  );
  const initialPrice = extractInitialUnitPrice(saleText);
  const initialUnitPrice = initialPrice?.value ??
    (typeof parsedPrice?.value === "number" ? parsedPrice.value : undefined);
  const initialQuantity = extractInitialQuantity(saleText);
  const attributes: Record<string, string | number> = {};
  for (const filter of structured?.filters ?? []) {
    if (
      schema?.attributes[filter.field] &&
      (filter.operator === "eq" || filter.operator === "contains")
    )
      attributes[filter.field] = filter.value;
  }
  const parsedArea = initialArea(saleText);
  const cityFilter = structured?.filters.find(
    (filter) => filter.field === "city" && typeof filter.value === "string",
  );
  const city =
    typeof cityFilter?.value === "string" ? cityFilter.value.slice(0, 100) : "";
  const description =
    initialDescription(saleText, initialPrice, title);
  const condition = /مستعمل(?:ة)?/u.test(normalizeSearch(saleText))
    ? "مستعمل"
    : /جديد(?:ة)?/u.test(normalizeSearch(saleText))
      ? "جديد"
      : undefined;
  if (
    condition &&
    (!schema || schema.attributes.condition || schema.allowAdditionalAttributes) &&
    attributes.condition == null
  )
    attributes.condition = condition;
  const service = schema?.resourceType === "SERVICE";
  const offersOwnService =
    service && /(?:خدمتي|خدماتي|خدمه|خدمة)/u.test(saleText) && !/رقمي/u.test(normalizeSearch(schema!.label));
  const pricingRules = schema?.rules.pricing;
  const quoteRequested =
    (/بدون سعر|شيل السعر|احذف السعر|حسب الاتفاق|اتفاق مع البائع|بعد المعاينة|يحدد لاحق|يحدد عند|سعر مفتوح|يقدمون عروض|يقدموا عروض/.test(
      normalizeSearch(saleText),
    ) || SELLER_QUOTE.test(normalizeSearch(saleText))) &&
    (!pricingRules || Boolean(unpricedModeFor(pricingRules)));
  const startingPriceRequested =
    /ابتداء من|يبدا من|السعر يبدا من/.test(normalizeSearch(saleText)) &&
    (!pricingRules || pricingRules.allowedModes.includes("FIXED"));
  const sellerQuoteRequested = quoteRequested && SELLER_QUOTE.test(normalizeSearch(saleText));
  const negotiablePriceRequested =
    initialUnitPrice !== undefined &&
    negotiableStatement(saleText) &&
    (!pricingRules || pricingRules.allowedModes.includes("NEGOTIABLE"));
  const pricingMode: ListingPricingMode | undefined = pricingRules
    ? quoteRequested
      ? unpricedModeFor(pricingRules)
      : startingPriceRequested
        ? "FIXED"
        : negotiablePriceRequested
          ? "NEGOTIABLE"
        : initialUnitPrice !== undefined &&
            pricingRules.allowedModes.includes("FIXED")
          ? "FIXED"
          : pricingRules.defaultMode
    : quoteRequested
      ? "OPEN_TO_OFFERS"
      : startingPriceRequested
        ? "FIXED"
        : negotiablePriceRequested
          ? "NEGOTIABLE"
        : undefined;
  const inventoryRules = schema?.rules.inventory;
  const effectiveQuantity =
    inventoryRules?.semantics === "SINGLE"
      ? 1
      : inventoryRules?.allowedModes.includes("LIMITED")
        ? initialQuantity
        : undefined;
  const chatOnly =
    /محادثة فقط|داخل التطبيق فقط|بدون رقم|لا رقم/u.test(saleText);
  const paymentMethods = parseSellerPaymentMethods(saleText);
  const contactPreference = chatOnly
    ? "CHAT_ONLY" as const
    : explicitAccountPhoneConsent(saleText) && !contact.phone
      ? "ACCOUNT_PHONE" as const
    : contact.phone
      ? "LISTING_PHONE" as const
      : undefined;
  const area = parsedArea ?? city;
  const uniqueImages = [...new Set(imageObjectPaths)].slice(0, 4);
  const negotiable = negotiableStatement(saleText);
  const draft: z.infer<typeof ConversationDraft> = {
    draftId: randomUUID(),
    ...(title.length >= 3 ? { title } : {}),
    ...(description ? { description } : {}),
    ...(uniqueImages[0] ? { imageUrl: uniqueImages[0] } : {}),
    ...(uniqueImages.length > 1
      ? { imageUrls: uniqueImages.slice(1) }
      : {}),
    ...(!chatOnly && contact.phone ? { contactPhone: contact.phone } : {}),
    ...(contactPreference ? { contactPreference } : {}),
    ...(paymentMethods ? { paymentMethods } : {}),
    ...(area ? { area: area.slice(0, 200) } : {}),
    ...(city ? { city } : {}),
    ...(category ? { category } : {}),
    ...(schema?.id ? { categoryId: schema.id } : {}),
    ...(pricingMode ? { pricingMode } : {}),
    ...(startingPriceRequested && initialUnitPrice !== undefined && pricingMode === "FIXED"
      ? { priceRepresentation: "STARTING_FROM" as const }
      : sellerQuoteRequested && isUnpricedMode(pricingMode)
        ? { priceRepresentation: "QUOTE_REQUIRED" as const }
        : {}),
    ...(initialUnitPrice !== undefined && !isUnpricedMode(pricingMode)
      ? { unitPrice: String(initialUnitPrice) }
      : {}),
    ...(inventoryRules?.semantics === "NON_STOCK"
      ? {
          inventoryMode: "UNLIMITED" as const,
        }
      : effectiveQuantity !== undefined
        ? {
            inventoryMode: "LIMITED" as const,
            availableQuantity: String(effectiveQuantity),
          }
        : !schema && initialQuantity !== undefined
          ? {
              availableQuantity: String(initialQuantity),
            }
        : inventoryRules?.semantics === "SINGLE"
          ? { inventoryMode: "LIMITED" as const, availableQuantity: "1" }
        : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...(negotiable !== undefined ? { negotiable } : {}),
    ...(schema && !service ? { fulfilmentType: "PICKUP" as const } : {}),
    // «اعرض خدمتي» in a non-digital service category: the buyer receives a service.
    ...(service && offersOwnService ? { fulfilmentType: "SERVICE" as const } : {}),
  };
  // Everything above came from the seller's words, except what DINAR derived itself.
  markDraftSources({}, draft, "USER_DECLARED");
  // The seller declared the category only by naming it; "آيفون" → electronics is DINAR's inference.
  if (draft.categoryId && schema && !normalizeSearch(saleText).includes(normalizeSearch(schema.label)))
    draft.sources!.category = "DINAR_DERIVED";
  if (draft.fulfilmentType && (!service || offersOwnService)) draft.sources!.fulfilmentType = "DINAR_DERIVED";
  const step = nextDraftStepWithSources(draft, configured ?? []);
  return {
    draft,
    step,
  };
}

/** Image suggestions stay attached to the draft's review until the seller states the field. */
type PhotoCandidate = {
  field: string;
  value: string | number;
  confidence: number;
  imageObjectPath: string;
};

function previousSuggestions(
  previous: Record<string, unknown> | undefined,
): PhotoCandidate[] {
  const list = previous?.photoSuggestions ?? (previous?.draftReview as { suggestions?: unknown } | undefined)?.suggestions;
  return Array.isArray(list)
    ? list.filter((item): item is PhotoCandidate => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<PhotoCandidate>;
        return typeof candidate.field === "string" &&
          (typeof candidate.value === "string" ||
            (typeof candidate.value === "number" && Number.isFinite(candidate.value))) &&
          typeof candidate.confidence === "number" &&
          candidate.confidence >= 0 &&
          candidate.confidence <= 1 &&
          typeof candidate.imageObjectPath === "string";
      }).slice(0, 12)
    : [];
}

function previousPhotoUncertainties(
  previous: Record<string, unknown> | undefined,
): ListingPhotoUncertainty[] {
  const values = previous?.photoSuggestionUncertainties;
  return Array.isArray(values)
    ? values.filter(
        (value): value is ListingPhotoUncertainty =>
          typeof value === "string" &&
          LISTING_PHOTO_UNCERTAINTIES.includes(
            value as ListingPhotoUncertainty,
          ),
      )
    : [];
}

function photoSuggestionCommand(message: string):
  | "CONFIRM"
  | "IGNORE"
  | "EDIT"
  | undefined {
  const normalized = normalizeSearch(message).trim();
  if (/^(?:اكد|اعتمد|استخدم)\s+(?:اقتراحات|اقتراح|تفاصيل)\s+الصور$/u.test(normalized))
    return "CONFIRM";
  if (/^(?:تجاهل|ارفض)\s+(?:اقتراحات|اقتراح)\s+الصور$/u.test(normalized))
    return "IGNORE";
  if (/^تعديل\s+اقتراحات\s+الصور\s*:/u.test(normalized))
    return "EDIT";
  return undefined;
}

export function isListingPhotoSuggestionCommand(message: string): boolean {
  return photoSuggestionCommand(message) !== undefined;
}

export function isListingPhotoTitleCorrection(message: string): boolean {
  return /^(?:لا\s*[،,]?\s*)?(?:هذا|هذه|هذي|هاذا)\s+.{3,120}$/u.test(
    collapseWhitespace(message),
  );
}

export async function hasPendingListingPhotoSuggestions(
  conversationId: string,
): Promise<boolean> {
  const [latest] = await db
    .select()
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  return latest?.payload.surface === "SELL" &&
    previousSuggestions(latest.payload).length > 0 &&
    !["published", "cancelled", "choose_draft"].includes(
      String(latest.payload.draftStep ?? ""),
    );
}

function mergePhotoSuggestions(
  existing: readonly PhotoCandidate[],
  incoming: readonly PhotoCandidate[],
): PhotoCandidate[] {
  const byField = new Map<string, PhotoCandidate>();
  for (const suggestion of [...existing, ...incoming]) {
    const current = byField.get(suggestion.field);
    if (!current || suggestion.confidence >= current.confidence)
      byField.set(suggestion.field, suggestion);
  }
  return [...byField.values()].slice(0, 12);
}

function unresolvedPhotoSuggestions(
  draft: z.infer<typeof ConversationDraft>,
  candidates: readonly PhotoCandidate[],
  configured: readonly MarketplaceCategorySchema[],
): PhotoCandidate[] {
  const suggestedCategory = candidates.find((candidate) => candidate.field === "category");
  // Attribute candidates may accompany a tentative category proposal. Resolve them
  // against that registry schema for review, without applying the category or values.
  const schema =
    categoryForDraft(draft, configured) ??
    configured.find(
      (category) =>
        category.id === suggestedCategory?.value ||
        category.label === suggestedCategory?.value,
    );
  return candidates.filter((candidate) => {
    if (candidate.field === "category")
      return !draft.categoryId && !draft.category;
    if (candidate.field === "title") return !draft.title;
    if (candidate.field === "description") return !draft.description;
    const field = candidate.field.startsWith("attributes.")
      ? candidate.field.slice("attributes.".length)
      : candidate.field;
    return Boolean(
      schema?.attributes[field] &&
        draft.attributes?.[field] === undefined &&
        !forbiddenPhotoAttribute(field),
    );
  });
}

function applyPhotoCandidates(
  input: z.infer<typeof ConversationDraft>,
  candidates: readonly PhotoCandidate[],
  configured: readonly MarketplaceCategorySchema[],
): z.infer<typeof ConversationDraft> {
  let draft = structuredClone(input);
  const categoryCandidate = candidates.find(
    (candidate) => candidate.field === "category",
  );
  if (!draft.categoryId && !draft.category && categoryCandidate) {
    const category = configured.find(
      (candidate) =>
        candidate.id === categoryCandidate.value ||
        candidate.label === categoryCandidate.value,
    );
    if (category)
      draft = structuredDraftUpdates(draft, category.label, configured).draft;
  }

  const schema = categoryForDraft(draft, configured);
  for (const candidate of candidates) {
    if (candidate.field === "title" && !draft.title && typeof candidate.value === "string")
      draft.title = candidate.value.slice(0, 120);
    else if (
      candidate.field === "description" &&
      !draft.description &&
      typeof candidate.value === "string"
    )
      draft.description = candidate.value.slice(0, 500);
    else if (schema && !forbiddenPhotoAttribute(candidate.field)) {
      const field = candidate.field.startsWith("attributes.")
        ? candidate.field.slice("attributes.".length)
        : candidate.field;
      if (!schema.attributes[field] || draft.attributes?.[field] !== undefined)
        continue;
      const checked = validateCategoryAttributesAgainstSchema(
        schema.label,
        { [field]: candidate.value },
        schema,
        false,
      );
      if (checked.ok && checked.attributes[field] !== undefined)
        draft.attributes = {
          ...(draft.attributes ?? {}),
          [field]: checked.attributes[field]!,
        };
    }
  }
  return draft;
}

function forbiddenPhotoAttribute(field: string) {
  return /^(?:category|title|description|unitPrice|price|availableQuantity|quantity|warranty|authenticity|ownership|seller|contact|city|area|market|legal|license|identity)$/iu.test(
    field.replace(/^attributes\./u, ""),
  );
}

function photoCorrectionTitle(message: string) {
  const match = collapseWhitespace(message).match(
    /^(?:لا\s*[،,]?\s*)?(?:هذا|هذه|هذي|هاذا)\s+(.{3,120})$/u,
  );
  if (!match?.[1]) return undefined;
  const title = cleanTitle(match[1]);
  return title.length >= 3 ? title : undefined;
}

export function applyUserPhotoTitleCorrection(
  input: z.infer<typeof ConversationDraft>,
  message: string,
): z.infer<typeof ConversationDraft> | undefined {
  const title = photoCorrectionTitle(message);
  if (!title) return undefined;
  const draft = structuredClone(input);
  draft.title = title;
  draft.sources = { ...(draft.sources ?? {}), title: "USER_DECLARED" };
  return draft;
}

function applyPhotoSuggestionEdit(
  draftInput: z.infer<typeof ConversationDraft>,
  rawMessage: string,
  candidates: readonly PhotoCandidate[],
  configured: readonly MarketplaceCategorySchema[],
): z.infer<typeof ConversationDraft> {
  const values = new Map<string, string>();
  for (const line of rawMessage.split(/\r?\n/u).slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const label = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).replace(/\s+/gu, " ").trim();
    values.set(label, value);
  }

  let draft = structuredClone(draftInput);
  const targetCategoryLabel = values.get("التصنيف المقترح");
  const targetCategory = targetCategoryLabel
    ? configured.find((category) =>
        category.id === targetCategoryLabel || category.label === targetCategoryLabel,
      )
    : undefined;
  if (targetCategory && !draft.categoryId)
    draft = structuredDraftUpdates(draft, targetCategory.label, configured).draft;

  const title = values.get("العنوان المقترح");
  if (title && title.length >= 3) draft.title = title.slice(0, 120);
  const description = values.get("الوصف المقترح");
  if (description) draft.description = description.slice(0, 500);

  const schema = categoryForDraft(draft, configured);
  if (!schema) return draft;
  const attributes: Record<string, string | number> = {
    ...(draft.attributes ?? {}),
  };
  for (const [label, rawValue] of values) {
    const match = label.match(/^خاصية\s+«(.{1,80})»$/u);
    if (!match?.[1]) continue;
    const field = Object.entries(schema.attributes).find(
      ([key, definition]) =>
        key === match[1] || definition.label === match[1],
    )?.[0];
    if (!field || forbiddenPhotoAttribute(field)) continue;
    const prior = candidates.find((candidate) => candidate.field === field);
    const value: string | number =
      typeof prior?.value === "number" && rawValue !== "" && Number.isFinite(Number(rawValue))
        ? Number(rawValue)
        : rawValue;
    const checked = validateCategoryAttributesAgainstSchema(
      schema.label,
      { [field]: value },
      schema,
      false,
    );
    if (checked.ok && checked.attributes[field] !== undefined)
      attributes[field] = checked.attributes[field]!;
  }
  if (Object.keys(attributes).length) draft.attributes = attributes;
  return draft;
}

/** Drafts remain conversation data. Publication always uses the existing seller form and its explicit button. */
// A draft in progress expects short field answers. A question, a marketplace search or an
// open request («اشرح لي…», «عندي مشكلة في كود…») is an interruption: it is answered by
// its own handler and the draft stays saved for «كمل إعلاني».
const DRAFT_INTERRUPTION =
  /[؟?]|(?:^|\s)(?:اشرح|وضح|اكتب\s+لي|علمني|ترجم|لخص|خطط|جاوبني|عندي\s+(?:مشكله|مشكلة|سؤال|استفسار)|ساعدني\s+(?:في|ب)|قارن\s+بين|حدثني|احكي\s+لي|ما\s+(?:هو|هي|معنى|الفرق)|وش\s+(?:الفرق|معنى|يعني)|ليش|لماذا|كيف|شلون|explain|write|teach|translate|summari[sz]e|help\s+me)(?=\s|$)/iu;
/** «ارجع لموضوع الطاقة», «نرجع للموضوع السابق»: returning to an earlier subject of the chat. */
const TOPIC_RETURN = /(?:^|\s)(?:ارجع|نرجع|رجعنا|خلينا\s+نرجع|back)\s+(?:to\s+(?:the\s+)?|ل|لل|الى\s+|الي\s+)?(?:ال)?(?:موضوع|topic|subject)/iu;
/** A question or open general request («اشرح…», «اكتب لي…», «كيف…؟»), never a product name. */
export function isGeneralRequest(message: string): boolean {
  const normalized = normalizeSearch(message);
  return DRAFT_INTERRUPTION.test(message) || DRAFT_INTERRUPTION.test(normalized) || TOPIC_RETURN.test(normalized);
}
export function isDraftInterruption(message: string): boolean {
  // «لا قصدي بدون سعر» corrects the draft; only a real search request leaves it.
  return isGeneralRequest(message) || hasExplicitMarketplaceSearchIntent(stripCorrectionPrefix(message));
}

export async function listingDraft(
  conversationId: string,
  rawMessage: string,
  surface?: string,
  imageObjectPaths: readonly string[] = [],
  photoSuggestionProvider?: ListingPhotoSuggestionProvider,
  actorId?: string,
): Promise<ToolResult | undefined> {
  if (surface && surface !== "SELL") return;
  const originalMessage = rawMessage.trim();
  const message = collapseWhitespace(rawMessage);
  const configured = (await listMarketplaceCategories()).map(schemaFromRow);
  const categoryPrompt = configured.length
    ? `اختر تصنيف العرض: ${configured.map((category) => category.label).join("، ")}.`
    : "لا توجد تصنيفات نشطة متاحة لإنشاء مسودة.";
  const [latest] = await db
    .select()
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  // A published draft or a draft-choice list (Block F5) is not a draft in progress.
  const latestDraft =
    latest?.payload.surface === "SELL" && !["published", "choose_draft"].includes(String(latest.payload.draftStep ?? ""))
      ? latest.payload
      : undefined;
  // An explicit field edit also reaches a draft that is not the last reply (another answer came in
  // between); bare answers keep the strict rule so they never hijack another conversation.
  const previous = latestDraft ?? (draftFieldEdit(message) && !imageObjectPaths.length ? await resumableDraftPayload(conversationId) : undefined);
  const previousPhotoCandidates = previousSuggestions(previous);
  const priorPhotoUncertainties = previousPhotoUncertainties(previous);
  const photoAction = photoSuggestionCommand(originalMessage);
  const titleCorrection =
    previousPhotoCandidates.some((candidate) => candidate.field === "title") &&
    isListingPhotoTitleCorrection(originalMessage)
      ? photoCorrectionTitle(originalMessage)
      : undefined;
  if (
    previous?.draft &&
    previousPhotoCandidates.length &&
    (photoAction || titleCorrection)
  ) {
    const before = ConversationDraft.parse(previous.draft);
    let draft = structuredClone(before);
    let activeCandidates = previousPhotoCandidates;
    let prompt = "";
    if (photoAction === "CONFIRM") {
      draft = applyPhotoCandidates(draft, previousPhotoCandidates, configured);
      activeCandidates = [];
      prompt = "أضفت الاقتراحات التي أكّدتها إلى المسودة. راجعها وأكمل التفاصيل الناقصة؛ لن يُنشر العرض دون تأكيدك.";
    } else if (photoAction === "IGNORE") {
      activeCandidates = [];
      prompt = "تجاهلت اقتراحات الصور، وبقيت الصور في مسودتك. أخبرني بتفاصيل العرض التي تريد إضافتها.";
    } else if (photoAction === "EDIT") {
      draft = applyPhotoSuggestionEdit(
        draft,
        originalMessage,
        previousPhotoCandidates,
        configured,
      );
      activeCandidates = unresolvedPhotoSuggestions(
        draft,
        previousPhotoCandidates,
        configured,
      );
      prompt = "حفظت تعديلاتك في مسودة الإعلان. أكمل التفاصيل الناقصة أو راجع المسودة.";
    } else if (titleCorrection) {
      draft =
        applyUserPhotoTitleCorrection(draft, originalMessage) ?? draft;
      activeCandidates = unresolvedPhotoSuggestions(
        draft,
        previousPhotoCandidates,
        configured,
      );
      prompt = "تم اعتماد تصحيحك للعنوان. يمكنك متابعة تفاصيل المسودة.";
    }
    markDraftSources(before, draft, "USER_DECLARED");
    const photoActionStep = nextDraftStepWithSources(draft, configured);
    const activeCandidatesWithStatus = mergePhotoSuggestions(
      [],
      activeCandidates,
    );
    return {
      kind: "SURFACE",
      surface: "SELL",
      query: {},
      listings: [],
      draft,
      draftStep: photoActionStep,
      draftReview: buildDraftReview(draft, configured, activeCandidatesWithStatus),
      ...(activeCandidatesWithStatus.length
        ? {
            photoSuggestionStatus: "SUGGESTIONS" as const,
            photoSuggestions: activeCandidatesWithStatus,
          }
        : {}),
      ...(activeCandidatesWithStatus.length &&
      priorPhotoUncertainties.length
        ? { photoSuggestionUncertainties: priorPhotoUncertainties }
        : {}),
      prompt,
    };
  }
  if (
    previous?.draft &&
    /^(?:الغاء|الغي|الغ)(?:\s+(?:الاعلان|المسودة))?$/u.test(
      normalizeSearch(message),
    )
  ) {
    return {
      kind: "SURFACE",
      surface: "SELL",
      query: {},
      listings: [],
      draftStep: "cancelled",
      prompt: "أُلغيت مسودة الإعلان. ابدأ من جديد عندما تكون مستعدًا.",
    };
  }
  // «أعرض 15» / «بعرض 15 بدل 20» name an amount and no item: in a draft, its asking price.
  const proposedPrice = priceProposal(message)?.amount;
  // «عدّل السعر», «خليه 15», «بدي أنزلها من 20 إلى 15», «خلّي البداية من 30»: the draft's price (R3E).
  const draftEdit = previous?.draft && !imageObjectPaths.length && !draftFieldEdit(message) ? priceEdit(message) : undefined;
  if (
    !imageObjectPaths.length &&
    surface !== "SELL" &&
    !(previous?.draft && (proposedPrice !== undefined || draftEdit)) &&
    (!previous?.draft ||
      /^(?:أريد|اريد|ابحث|أبحث|اعرض|افتح|غير سوق)/.test(message) ||
      isDraftInterruption(message))
  )
    return;

  let draft = ConversationDraft.parse(previous?.draft ?? {});
  let step =
    typeof previous?.draftStep === "string" ? previous.draftStep : "title";
  let editAck: string | undefined;
  // A change with no amount is asked about, never taken as the answer to the current step.
  if (draftEdit && draftEdit.amount === undefined) {
    const { resultSetId: _resultSetId, ...kept } = (previous ?? {}) as Record<string, unknown>;
    return {
      ...kept,
      kind: "SURFACE",
      surface: "SELL",
      query: {},
      listings: [],
      draft,
      draftStep: step,
      prompt: `ما السعر الجديد للمسودة؟ اكتب مثل «خليه 15»${draft.unitPrice ? `؛ السعر الحالي ${draft.unitPrice}` : ""}. لم يتغير شيء.`,
    } as ToolResult;
  }
  // "اعرض هذا بـ10" / "بيعه بـ10" names no new item: it edits the draft in progress;
  // so does «خلنا نحطه 500» (G2).
  const explicitEdit = previous?.draft && !imageObjectPaths.length ? draftFieldEdit(message) : undefined;
  const deicticPrice = previous?.draft && !imageObjectPaths.length && !explicitEdit
    ? (draftEdit?.amount !== undefined ? { value: draftEdit.amount } : undefined) ?? (!cleanTitle(message) ? extractInitialUnitPrice(message) : undefined) ?? draftPricePhrase(message) ?? (proposedPrice !== undefined ? { value: proposedPrice } : undefined)
    : undefined;
  const startsAnotherSale =
    surface === "SELL" &&
    // «بدي أبيعه ب300»: the attached pronoun is the item of the draft in progress.
    /^(?:(?:ابي|ابغى|اريد|بدي)\s+(?:ان\s+)?(?:ابيع|اعرض|اقدم|اوفر)(?!ه|ها|هم)|(?:ابيع|اعرض|انشر)\b)/u.test(
      normalizeSearch(message),
    );
  const startNewDraft =
    !deicticPrice && (!previous?.draft || startsAnotherSale);
  if (startNewDraft) {
    const initial = createInitialSaleDraft(
      message,
      configured,
      imageObjectPaths,
    );
    draft = initial.draft;
    step = initial.step;
  } else {
    const text = message.trim();
    const before = structuredClone(draft);
    if (deicticPrice) {
      draft.unitPrice = String(deicticPrice.value);
      if (isUnpricedMode(draft.pricingMode)) draft.pricingMode = "FIXED";
      // «البداية من 30» keeps the amount non-binding (STARTING_FROM), as the price step does.
      if (draftEdit?.startingFrom) setPriceRepresentation(draft, "STARTING_FROM");
    }
    updateDraftImages(draft, text, imageObjectPaths);
    // An explicit field edit («الكمية 2», «غيّر العنوان إلى …», «احذف … من الوصف») applies to its
    // own field whatever is being asked now; the current question is not consumed by it.
    const fieldEdit = explicitEdit;
    if (fieldEdit?.field === "contactPhone") {
      const contact = extractListingContactPhone(text);
      if (contact.phone) {
        draft.contactPhone = contact.phone;
        draft.contactPreference = "LISTING_PHONE";
        editAck = "أضفت رقم التواصل لهذا الإعلان.";
      } else editAck = "لم أتعرف على رقم صالح؛ اكتبه كاملًا مع رمز الدولة.";
    } else if (fieldEdit?.field === "contactChatOnly") {
      delete draft.contactPhone;
      draft.contactPreference = "CHAT_ONLY";
      editAck = "سيكون التواصل عبر محادثة دينار فقط.";
    } else if (fieldEdit) {
      const outcome = applyDraftFieldEdit(draft, fieldEdit, categoryForDraft(draft, configured)?.rules.inventory);
      editAck = outcome.ok ? outcome.ack : outcome.reason;
    }
    const accountPhoneIntent =
      step === "contact" && hasPersonalNumberIntent(text);
    const categorySelection = accountPhoneIntent || fieldEdit
      ? undefined
      : explicitConfiguredCategory(text, configured);
    const categoryChanges =
      categorySelection !== undefined &&
      categorySelection.id !== categoryForDraft(draft, configured)?.id;
    const activeSchema = categoryForDraft(draft, configured);
    const correction =
      !fieldEdit &&
      !categoryChanges &&
      (isLabelledFieldCorrection(text, activeSchema) ||
        isNaturalAttributeCorrection(text, activeSchema))
        ? structuredDraftUpdates(draft, text, configured)
        : undefined;
    if (correction?.changed) draft = correction.draft;
    const accountPhoneClarification =
      !categoryChanges &&
      !correction?.changed &&
      accountPhoneIntent;
    const factCorrected = !fieldEdit && !categoryChanges && !correction?.changed && correctDescribedFact(draft, text);
    const stepAnswerConsumed = fieldEdit || categoryChanges || correction?.changed || factCorrected
      ? false
      : accountPhoneClarification
        ? true
        : consumeDraftAnswer(draft, step, text, configured);
    if (
      !fieldEdit &&
      (!stepAnswerConsumed || step === "title" || step === "description") &&
      !correction?.changed &&
      !factCorrected
    ) {
      const updates = structuredDraftUpdates(draft, text, configured);
      if (updates.changed) draft = updates.draft;
    }
    if (
      categoryChanges &&
      (step === "category" || step === "title") &&
      categorySelection &&
      !isCategoryOnlySelection(text, categorySelection)
    )
      consumeDraftAnswer(draft, "title", text, configured);
    // «ب300 وقابل للتفاوض، عندي جهاز واحد»: a price answer may also state the quantity.
    if (step === "price" && stepAnswerConsumed && draft.availableQuantity === undefined) {
      const stated = extractInitialQuantity(text);
      const inventory = categoryForDraft(draft, configured)?.rules.inventory;
      if (stated !== undefined && inventory?.allowedModes.includes("LIMITED") && inventory.semantics !== "NON_STOCK") {
        draft.inventoryMode = "LIMITED";
        draft.availableQuantity = String(stated);
      }
    }
    const negotiable = negotiableStatement(text);
    if (negotiable !== undefined) draft.negotiable = negotiable;
    markDraftSources(before, draft, "USER_DECLARED");
    const following = nextDraftStepWithSources(draft, configured);
    step =
      accountPhoneClarification
        ? "contact_account_confirmation"
        : /^(?:راجع|مراجعة|اعرض المسودة|راجع المسودة|انتهيت)$/u.test(
        normalizeSearch(text),
      )
        ? "review"
        : following;
  }

  if (step !== "cancelled" && step !== "published") applyShortDraftDefaults(draft);
  const uploadedImages = [...new Set(imageObjectPaths)].slice(0, 4);
  // G1: image understanding is metered. Without allowance the photos are still attached and
  // the draft continues manually; nothing is inferred and nothing is charged.
  const imageUsage = uploadedImages.length && photoSuggestionProvider && actorId
    ? await reserveImageUnderstanding(conversationId, actorId, photoSuggestionProvider)
    : undefined;
  // No reservation (no signed-in owner or market) means no paid vision call: never unmetered.
  const photoAnalysis = uploadedImages.length
    ? photoSuggestionProvider && !imageUsage?.ok
      ? { status: "UNAVAILABLE" as const, suggestions: [] }
      : await collectListingPhotoSuggestions({
          imageObjectPaths: uploadedImages,
          schema: configured.find(
            (candidate) =>
              candidate.id === draft.categoryId ||
              candidate.label === draft.category,
          ),
          categories: configured,
          provider: photoSuggestionProvider,
          actorId,
        })
    : undefined;
  if (imageUsage?.ok) {
    const vision = visionModelOf(photoSuggestionProvider);
    const called = photoAnalysis?.status !== "UNAVAILABLE";
    await settleAiUsage(imageUsage.reservation.id, {
      outcome: photoAnalysis?.status === "FAILED" ? "PROVIDER_FAILED" : called ? "SUCCESS" : "CANCELLED",
      providerCalls: called ? 1 : 0,
      ...vision,
      ...(called
        ? { calls: [{ kind: "PRIMARY" as const, outcome: photoAnalysis?.status === "FAILED" ? ("FAILED" as const) : ("SUCCESS" as const), provider: vision.provider, model: vision.model, imageUnits: uploadedImages.length }] }
        : {}),
    });
  }
  const mergedPhotoSuggestions = photoAnalysis
    ? mergePhotoSuggestions(
        previous?.draft ? previousPhotoCandidates : [],
        photoAnalysis.suggestions,
      )
    : previous?.draft
      ? previousPhotoCandidates
      : [];
  const activePhotoSuggestions = unresolvedPhotoSuggestions(
    draft,
    mergedPhotoSuggestions,
    configured,
  );
  const activePhotoUncertainties = [
    ...new Set([
      ...(previous?.draft ? priorPhotoUncertainties : []),
      ...(photoAnalysis?.uncertainties ?? []),
    ]),
  ];
  // Suggestions the draft already answers (e.g. a condition the seller wrote) are not shown;
  // with none left, the status and note must not announce suggestions.
  const shownPhotoStatus =
    photoAnalysis?.status === "SUGGESTIONS" && !activePhotoSuggestions.length
      ? "NO_SUGGESTIONS"
      : photoAnalysis?.status;
  const photoNote = imageUsage && !imageUsage.ok
    ? "أُرفقت الصور بالمسودة. حصة «فهم الصور» في باقتك نفدت لهذه الفترة، فلم أحلل الصور؛ أكمل التفاصيل كتابةً. قل «كم باقي من حصتي؟» لمعرفة موعد التجديد."
    : photoAnalysis
    ? {
        UNAVAILABLE:
          "أُرفقت الصور بالمسودة. اقتراحات الخصائص من الصور غير مفعّلة؛ لم أستنتج تفاصيل أو سعرًا.",
        FAILED:
          "أُرفقت الصور بالمسودة، لكن تعذّر إعداد اقتراحات آمنة منها. يمكنك كتابة التفاصيل.",
        NO_SUGGESTIONS:
          "أُرفقت الصور بالمسودة. لا توجد خصائص آمنة لاقتراحها من هذه الصور؛ يمكنك كتابة التفاصيل.",
        SUGGESTIONS:
          "أُرفقت الصور بالمسودة، وهذه اقتراحات اختيارية تحتاج إلى مراجعتك.",
      }[shownPhotoStatus!]
    : "";
  return {
    kind: "SURFACE",
    surface: "SELL",
    query: {},
    listings: [],
    draft,
    draftStep: step,
    draftReview: buildDraftReview(
      draft,
      configured,
      activePhotoSuggestions,
    ),
    ...(activePhotoSuggestions.length
      ? {
          photoSuggestionStatus:
            photoAnalysis?.status === "FAILED" && !photoAnalysis.suggestions.length
              ? "FAILED" as const
              : "SUGGESTIONS" as const,
          photoSuggestions: activePhotoSuggestions,
        }
      : photoAnalysis
      ? {
          photoSuggestionStatus: shownPhotoStatus!,
          photoSuggestions: [],
        }
      : {}),
    ...(activePhotoUncertainties.length
      ? { photoSuggestionUncertainties: activePhotoUncertainties }
      : {}),
    prompt: [
      editAck,
      step === "category"
        ? categoryPrompt
        : promptForDraftStep(step, draft, configured),
      photoNote,
    ].filter(Boolean).join(" "),
  };
}

/** The vision provider/model as the adapter declares it (UNKNOWN when it does not: then unpriced). */
function visionModelOf(provider: ListingPhotoSuggestionProvider | undefined): { provider: string; model: string } {
  const declared = (provider as { capability?: () => { provider?: string; model?: string } } | undefined)?.capability?.();
  return { provider: declared?.provider ?? "UNKNOWN", model: declared?.model ?? "UNKNOWN" };
}

async function reserveImageUnderstanding(conversationId: string, actorId: string, provider?: ListingPhotoSuggestionProvider) {
  const [conversation] = await db
    .select({ marketId: conversations.marketId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.ownerUserId, actorId)));
  if (!conversation?.marketId) return undefined;
  return reserveAiUsage({
    owner: { kind: "USER", userId: actorId, market: { id: conversation.marketId } },
    resource: "IMAGE_UNDERSTANDING",
    idempotencyKey: `image:${conversationId}:${randomUUID()}`,
    expectedModel: visionModelOf(provider),
  });
}

/** Keeps an open seller draft from being replaced by a conversational side question. */
/** The newest SELL draft still in progress among recent replies, for explicit field edits only. */
export async function resumableDraftPayload(conversationId: string): Promise<Record<string, any> | undefined> {
  const recent = await db
    .select()
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(25);
  const sell = recent.find((block) => block.payload.surface === "SELL");
  if (!sell?.payload.draft) return undefined;
  return ["published", "choose_draft", "cancelled"].includes(String(sell.payload.draftStep ?? "")) ? undefined : sell.payload;
}

export async function hasResumableListingDraft(conversationId: string): Promise<boolean> {
  return Boolean(await resumableDraftPayload(conversationId));
}

export async function hasActiveListingDraft(conversationId: string): Promise<boolean> {
  const [latest] = await db
    .select()
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  return Boolean(
    latest?.payload.surface === "SELL" &&
      !["published", "choose_draft", "cancelled"].includes(
        String(latest.payload.draftStep ?? ""),
      ),
  );
}
