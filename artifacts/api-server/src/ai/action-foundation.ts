/**
 * Block F0 — the generic action foundation shared by every conversational adapter.
 *
 * Not a runtime: it reads and writes only server rows (`ai_result_sets`, `ai_ui_blocks`)
 * and delegates every mutation to an existing domain authority. The model may propose an
 * action name and inputs; only names in ACTION_REGISTRY can be reviewed or executed.
 *
 * Invariant: UNDERSTAND → REVIEW → CONFIRM → RE-READ SERVER STATE → EXECUTE. A pending
 * action is scoped to actor, action, resource, expected server state and expiry; any
 * newer conversation step or changed state invalidates it.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  CONVERSATION_ACTION_REGISTRY,
  type ConversationActionId,
} from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, conversations, db, driverProfiles, markets, messages, offers, orders, paymentIntents, providerConnections, providerCredentials, users } from "@workspace/db";
import { isMarketAvailable, resolveMarket, type marketFor } from "../lib/markets";
import {
  assertSellerEmployeeCapabilityTx,
  invalidateSellerEmployeeSessionsForActorTx,
  requireSellerEmployeeCapability,
  type SellerEmployeeCapability,
} from "../lib/business-delegations";
import { buildListingUpdateBody, parseListingPriceMinor, updateOwnedListing } from "../lib/listing-management";
import { addMarketplaceCartItem } from "../lib/marketplace-cart";
import { METHOD_LABELS, deliveryOptions, selectDeliveryMethod, type DeliveryMethod } from "../lib/delivery";
import { checkoutForActor } from "../routes/marketplace";
import { createTestPaymentIntent, paymentSimulationEnabled } from "../routes/payments";
import {
  DRIVER_STATUS_LABELS,
  WORK_STATE_MESSAGES,
  assignDelivery,
  deliveryWorkState,
  missingDriverFields,
  submitDriverProfile,
} from "../lib/driver";
import { publishDraft, readDraftSnapshot } from "./draft-actions";
import { containsPriceOffer, inquiryBodyProblem, inquiryPreconditions, parseTargetKey, submitInquiryMessage, type InquiryProvenance } from "../lib/inquiries";
import {
  MAX_ACTIVE_PROVIDER_CONNECTIONS,
  PROVIDER_SCOPE_LABELS,
  type ProviderScope,
  createProviderConnection,
  revokeProviderConnection,
  revokeProviderCredential,
} from "../lib/provider-connections";
import { UpdateListingBody } from "@workspace/api-zod";
import { findOrdinalMention, foldArabicLetters, normalizeDigits, parseResultReference } from "./arabic-normalization";
import { parsePromotionDuration } from "./promotion-turn";
import {
  acceptedNegotiationForCheckout,
  awaitingRole,
  decideNegotiation,
  effectiveStatus,
  listingNegotiable,
  negotiationForParty,
  NEGOTIATION_STATUS_LABELS,
  OFFER_ABOVE_LISTED,
  openNegotiation,
  resolveCommercialUnitPrice,
  roleOf,
} from "../lib/negotiations";
import {
  directPurchaseAllowed,
  priceRepresentationOf,
  proposalCeilingMinor,
  type PriceRepresentation,
} from "@workspace/api-zod/listing-pricing";

type Market = Awaited<ReturnType<typeof marketFor>>;

export const NEGOTIABLE_NEEDS_AGREEMENT =
  "سعر هذا الإعلان قابل للتفاوض؛ اتفق مع البائع على السعر أولًا (مثلًا: «اعرض عليه 20» أو «اطلب آخر سعر»)";
/** Starting amounts and quotation listings are never bought at the advertised amount. */
const needsAgreementMessage = (representation?: PriceRepresentation | null) =>
  representation === "STARTING_FROM"
    ? "هذا السعر يبدأ من المبلغ المعلن وليس سعرًا نهائيًا؛ اتفق مع البائع على السعر أولًا (مثلًا: «اطلب تسعيرة» أو «اعرض عليه 20»)"
    : representation === "QUOTE_REQUIRED"
      ? "هذا الإعلان بالتسعيرة؛ اطلب تسعيرة من البائع ثم اقبلها أو فاوض عليها قبل الشراء"
      : NEGOTIABLE_NEEDS_AGREEMENT;
type StoredSet = typeof aiResultSets.$inferSelect;

export const ACTION_PENDING_TTL_MS = 10 * 60 * 1000;
const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// ─── Fact provenance ─────────────────────────────────────────────────────────

export { FACT_SOURCES, resolveFact, type Fact, type FactSource } from "./fact-provenance";
import { resolveFact, type Fact } from "./fact-provenance";
import { currentTurnId } from "./turn-context";

export function resolveFacts(candidates: Record<string, readonly Fact[]>): Record<string, Fact> {
  return Object.fromEntries(Object.entries(candidates).map(([field, facts]) => [field, resolveFact(facts)]));
}

// ─── Command numbers ─────────────────────────────────────────────────────────

export type ParsedCommand = {
  /** 1-based position the user named ("الثاني" → 2). */
  ordinal?: number;
  price?: string;
  quantity?: number;
  durationDays?: number;
  /** "هذا"/"هذه": the resource currently in focus. */
  deictic: boolean;
};

export function normalizeCommandText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:()«»"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const QUANTITY_WORDS: Record<string, number> = {
  قطعتين: 2, حبتين: 2, قطعتان: 2, اثنتين: 2, اثنين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5,
};
const NOUNS = "(?:الاعلان|اعلان|العرض|المنتج|السياره|الشقه|الخدمه|القطعه|الخيار|النتيجه|رقم)";

/**
 * Each number is read by the phrase that owns it, then removed, so a value is never
 * taken for a position: "غير سعر الإعلان الثاني إلى 5" → ordinal 2, price 5;
 * "أريد قطعتين من المنتج الثالث" → quantity 2, ordinal 3.
 */
/**
 * "اجعل سعر هذه القطعة 5": a price command's final bare number is the price, unless it
 * names a position — right after "رقم", or after a listing noun that is not "this …".
 */
function finalPriceNumber(text: string): RegExpMatchArray | null {
  const match = text.match(/(?:سعر|السعر|سعره|سعرها)(?:\s+\S+){0,4}?\s+(\d+(?:\.\d+)?)$/u);
  if (!match) return null;
  const words = text.split(/\s+/);
  const before = words.at(-2) ?? "";
  const twoBefore = words.at(-3) ?? "";
  if (before === "رقم") return null;
  if (new RegExp(`^${NOUNS}$`, "u").test(before) && !/^(?:هذه|هذا|هذي|هاي)$/u.test(twoBefore)) return null;
  return match;
}

export function parseCommandNumbers(message: string): ParsedCommand {
  let text = normalizeCommandText(message);
  const result: ParsedCommand = { deictic: /(?:^|\s)(?:هذا|هذه|هاد|هذي|هادا|هاي)(?:\s|$)/u.test(text) };
  const duration = parsePromotionDuration(text);
  if (duration) {
    result.durationDays = duration.days;
    text = duration.rest;
  }
  // "5 بدل 10": the first number is the new value, the second the old one; neither is a position.
  const swap = text.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+بدل\s+(\d+(?:\.\d+)?)(?=\s|$)/u);
  if (swap) {
    if (/(?:قطع|كميه|عدد|حبات)/u.test(text) && !/سعر/u.test(text)) result.quantity = Number(swap[1]);
    else result.price = swap[1];
    text = text.replace(swap[0], " ");
  }
  const price = result.price !== undefined ? null : text.match(/(?:سعر|السعر|سعره|سعرها|بسعر)(?:\s+\S+){0,3}?\s+(?:الي|الى|ل|ب|يصير)\s*(\d+(?:\.\d+)?)(?=\s|$)/u)
    ?? text.match(/(?:^|\s)ب\s*(\d+(?:\.\d+)?)(?=\s|$)/u)
    // "اجعل سعر هذه القطعة 5": a price command's final bare number is the price.
    ?? finalPriceNumber(text);
  if (price) {
    result.price = price[1];
    text = text.replace(price[0], (whole) => whole.replace(price[1]!, " ")).trim();
  }
  const quantity = text.match(/(?:^|\s)(\d{1,3})\s*(?:قطع|قطعه|حبات|حبه|حبة|نسخ|وحدات)(?=\s|$)/u);
  if (quantity) {
    result.quantity = Number(quantity[1]);
    text = text.replace(quantity[0], " ");
  } else {
    const word = text.split(/\s+/).find((token, index, all) =>
      QUANTITY_WORDS[token] !== undefined && (/^قطع|^حب/.test(token) || /^(?:قطع|قطعه|حبات)$/.test(all[index + 1] ?? "")),
    );
    if (word) {
      result.quantity = QUANTITY_WORDS[word];
      text = text.replace(word, " ");
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  const numbered = text.match(new RegExp(`(?:^|\\s)${NOUNS}\\s*(?:رقم\\s*)?(\\d{1,2})(?=\\s|$)`, "u"));
  const whole = parseResultReference(text);
  const mention = findOrdinalMention(text);
  const index = numbered
    ? Number(numbered[1]) - 1
    : whole?.kind === "INDEX"
      ? whole.index
      : mention?.kind === "INDEX"
        ? mention.index
        : undefined;
  if (index !== undefined && index >= 0 && index < 24) result.ordinal = index + 1;
  return result;
}

// ─── Stable references ───────────────────────────────────────────────────────

const ACTION_KIND = "ACTION";
const isListingSet = (set: StoredSet, actorId: string) => {
  const query = (set.query ?? {}) as { kind?: unknown; ownerId?: unknown };
  if (query.kind === undefined) return true; // buyer search / recommendation result sets
  return query.kind === "SELLER_CONTEXT" && query.ownerId === actorId;
};

async function conversationSets(conversationId: string, marketId: string, limit = 20): Promise<StoredSet[]> {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(limit);
}

const live = (set: StoredSet) => !set.expiresAt || set.expiresAt.getTime() > Date.now();

/** The resource in focus: an opened result, or the one listing a seller surface selected. */
async function focusedResource(conversationId: string): Promise<{ resourceId: string; resultSetId: string } | undefined> {
  const [block] = await db
    .select({ blockType: aiUiBlocks.blockType, payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .innerJoin(messages, eq(aiUiBlocks.messageId, messages.id))
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const payload = (block?.payload ?? {}) as { presentation?: unknown; resourceIds?: unknown; resourceId?: unknown; resultSetId?: unknown };
  if (typeof payload.resultSetId !== "string") return undefined;
  if (block!.blockType === "LISTING_RESULTS" && payload.presentation === "DETAILS" && Array.isArray(payload.resourceIds) && typeof payload.resourceIds[0] === "string")
    return { resourceId: payload.resourceIds[0], resultSetId: payload.resultSetId };
  if (typeof payload.resourceId === "string") return { resourceId: payload.resourceId, resultSetId: payload.resultSetId };
  return undefined;
}

export type ResolvedReference = { resourceId: string; resultSetId: string; ordinal?: number };

/**
 * "الثاني", "الإعلان الأول", "السيارة الثالثة" resolve only against the latest live,
 * persisted result set this actor may act on; "هذا" resolves to the resource in focus.
 * Nothing is resolved from model memory, and an out-of-range ordinal resolves to nothing.
 */
export async function resolveReference(input: {
  conversationId: string;
  marketId: string;
  actorId: string;
  message: string;
}): Promise<ResolvedReference | undefined> {
  const parsed = parseCommandNumbers(input.message);
  if (parsed.ordinal !== undefined) {
    const set = (await conversationSets(input.conversationId, input.marketId)).find(
      (candidate) => live(candidate) && isListingSet(candidate, input.actorId),
    );
    const resourceId = set?.resourceIds[parsed.ordinal - 1];
    return set && resourceId ? { resourceId, resultSetId: set.id, ordinal: parsed.ordinal } : undefined;
  }
  if (parsed.deictic) return focusedResource(input.conversationId);
  return undefined;
}

// ─── Action contract ─────────────────────────────────────────────────────────

export type ActionProposal = {
  action: string;
  targetResource?: string;
  structuredInput: Record<string, Fact>;
  missingFields: string[];
  requiresConfirmation: boolean;
};

type ServerSnapshot = {
  actorStatus: string;
  actorMarketId: string;
  resourceMarketId: string;
  resourceStatus: string;
  ownerId: string;
  unitPriceMinor: number | null;
  available: number | null;
  version: string;
  /** The listing's fulfilment type, when the resource is a listing. */
  fulfilmentType?: string;
  /** A server-written explanation for a non-actionable state. */
  reason?: string;
  /** Universal negotiation: whether the listing accepts price proposals. */
  negotiable?: boolean;
  /** Canonical listing pricing mode; guide prices are not checkout ceilings. */
  pricingMode?: string;
  /** What the listing price means; decides direct purchase and the proposal ceiling. */
  priceRepresentation?: PriceRepresentation | null;
  /** Only a definite asking price (FIXED) is bought without an agreement. */
  directPurchase?: boolean;
  /** G2: the public listing price when this buyer has a private agreed price. */
  publicUnitPriceMinor?: number | null;
  /** G2: the quantity an agreed price covers. */
  agreedQuantity?: number;
  /** G2: the authenticated party role for a negotiation action. */
  negotiationRole?: "BUYER" | "SELLER";
  /** NEXT G2: the actor's role and the listing title in an inquiry thread. */
  inquiryRole?: "BUYER" | "SELLER";
  inquiryTitle?: string;
};

type ActionDefinition = {
  /** Inputs that must be known before a review can be shown. */
  required: string[];
  requiresConfirmation: boolean;
  /** Who may act on the resource and in which states. */
  allowed: (snapshot: ServerSnapshot, actorId: string, input: Record<string, unknown>) => string | undefined;
  reviewLines: (snapshot: ServerSnapshot, input: Record<string, unknown>, market: Market) => string[];
  /** Re-reads the resource the action targets; listings by default. */
  read?: (actorId: string, resourceId: string, tx?: any) => Promise<ServerSnapshot | undefined>;
  /** Runs the existing authority; may return the identity of what it created. */
  execute: (input: {
    actionId: string;
    actorId: string;
    market: Market;
    resourceId: string;
    values: Record<string, unknown>;
    expected: ServerSnapshot;
    delegatedAuthority?: DelegatedActionAuthority;
  }) => Promise<void | Record<string, unknown>>;
};

const money = (minor: number | null, market: Market) =>
  minor === null ? "بالاتفاق" : `${(minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale)} ${market.currencyCode}`;

/**
 * NEXT G2: an inquiry target (`listing:…`, `inquiry:…`, `negotiation:…`, `order:…`) read as a
 * snapshot. The inquiry authority decides who may write to whom; a refusal becomes `reason`.
 */
async function readInquiryTarget(actorId: string, key: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const target = parseTargetKey(key);
  if (!target) return undefined;
  const [actor] = await tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId));
  if (!actor) return undefined;
  const base = { actorStatus: actor.status, actorMarketId: actor.activeMarketId, resourceMarketId: actor.activeMarketId, unitPriceMinor: null, available: null };
  try {
    const relationship = await inquiryPreconditions(actorId, { id: actor.activeMarketId }, target);
    const [listing] = await tx.select({ status: offers.status, data: offers.data }).from(offers).where(eq(offers.id, relationship.listingId));
    return {
      ...base,
      resourceMarketId: relationship.marketId,
      resourceStatus: listing?.status ?? "UNAVAILABLE",
      ownerId: relationship.actorRole === "BUYER" ? relationship.sellerId : relationship.buyerId,
      version: `${relationship.relationship}:${relationship.inquiry?.status ?? "NEW"}`,
      inquiryRole: relationship.actorRole,
      inquiryTitle: typeof listing?.data.title === "string" ? listing.data.title : "الإعلان",
    };
  } catch (error) {
    if (!(error instanceof Error) || typeof (error as { status?: unknown }).status !== "number") throw error;
    return { ...base, resourceStatus: "UNAVAILABLE", ownerId: "", version: "refused", reason: error.message };
  }
}

// ─── Universal product control: browsing market and profile ───────────────────

/** `market:<from>><to>`: the conversation's market and the requested browsing market. */
const MARKET_SWITCH_KEY = /^market:([A-Za-z0-9_-]{1,32})>([A-Za-z0-9_-]{1,32})$/;
export const marketSwitchKey = (from: string, to: string) => `market:${from}>${to}`;

async function readMarketSwitch(actorId: string, key: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const match = MARKET_SWITCH_KEY.exec(key);
  if (!match) return undefined;
  const [, from, to] = match as unknown as [string, string, string];
  const [[actor], [row]] = await Promise.all([
    tx.select({ status: users.status }).from(users).where(eq(users.id, actorId)),
    tx.select().from(markets).where(eq(markets.id, to)),
  ]);
  if (!actor || !row) return undefined;
  const target = await resolveMarket(row, tx);
  const available = isMarketAvailable(target);
  return {
    actorStatus: actor.status,
    // The switch is account-scoped: it is checked against the conversation it was reviewed in.
    actorMarketId: from,
    resourceMarketId: from,
    resourceStatus: available ? "AVAILABLE" : "UNAVAILABLE",
    ownerId: actorId,
    unitPriceMinor: null,
    available: null,
    version: `${target.id}:${target.status}:${target.isActive}:${target.priceVersionId ?? target.unitPriceMinor}`,
    ...(available ? {} : { reason: `سوق ${target.countryNameAr} غير متاح للتصفح حاليًا` }),
  };
}

/** `profile:<actor>@<market>`: the owner's own profile, reviewed inside one conversation. */
const PROFILE_KEY = /^profile:([^@\s]{1,80})@([A-Za-z0-9_-]{1,32})$/;
export const profileKey = (actorId: string, marketId: string) => `profile:${actorId}@${marketId}`;

export function displayNameProblem(name: string): string | undefined {
  const value = name.trim();
  if (value.length < 2) return "الاسم قصير جدًا (حرفان على الأقل)";
  if (value.length > 80) return "الاسم أطول من 80 حرفًا";
  if (/\d[\d\s-]{5,}\d|https?:\/\/|www\.|@/u.test(value)) return "لا يمكن أن يتضمن الاسم رقم هاتف أو بريدًا أو رابطًا";
  return undefined;
}

async function readOwnProfile(actorId: string, key: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const match = PROFILE_KEY.exec(key);
  if (!match || match[1] !== actorId) return undefined;
  const [actor] = await tx.select({ status: users.status, displayName: users.displayName, updatedAt: users.updatedAt }).from(users).where(eq(users.id, actorId));
  if (!actor) return undefined;
  return {
    actorStatus: actor.status,
    actorMarketId: match[2]!,
    resourceMarketId: match[2]!,
    resourceStatus: "ACTIVE",
    ownerId: actorId,
    unitPriceMinor: null,
    available: null,
    version: `${actor.updatedAt.toISOString()}:${actor.displayName}`,
  };
}

/** Only these names can ever be reviewed or executed; each delegates to an existing authority. */
export const ACTION_REGISTRY: Record<string, ActionDefinition> = {
  /**
   * The account's active browsing market. Seller eligibility, business licensing and legal
   * country are separate authorities and never change here. The conversation follows the new
   * market, so result sets from the old one can no longer be resolved for new mutations;
   * existing orders keep their own market and currency snapshots.
   */
  SWITCH_MARKET: {
    required: ["targetResource", "fromName", "toName", "toCurrency"],
    requiresConfirmation: true,
    read: readMarketSwitch,
    allowed: (snapshot) => snapshot.reason,
    reviewLines: (_snapshot, input) => [
      `من: سوق ${String(input.fromName)}`,
      `إلى: سوق ${String(input.toName)} — الأسعار بعملة ${String(input.toCurrency)}`,
      "تتحدث نتائج البحث والعروض لتطابق السوق الجديد",
      "طلباتك السابقة تبقى في سوقها وبعملتها الأصلية",
      "لا يغيّر بلد حسابك أو أهلية البيع أو أي ترخيص",
    ],
    execute: async ({ actionId, actorId, resourceId }) => {
      const to = MARKET_SWITCH_KEY.exec(resourceId)![2]!;
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(markets).where(eq(markets.id, to)).for("share");
        if (!row || !isMarketAvailable(await resolveMarket(row, tx))) throw fail(409, "السوق لم يعد متاحًا للتصفح", "MARKET_UNAVAILABLE");
        await invalidateSellerEmployeeSessionsForActorTx(tx, actorId, "MARKET_CHANGE");
        const [set] = await tx.select({ conversationId: aiResultSets.conversationId }).from(aiResultSets).where(eq(aiResultSets.id, actionId));
        await tx.update(users).set({ activeMarketId: to, updatedAt: new Date() }).where(eq(users.id, actorId));
        await tx
          .update(conversations)
          .set({ marketId: to, updatedAt: new Date() })
          .where(and(eq(conversations.id, set!.conversationId), eq(conversations.ownerUserId, actorId), eq(conversations.kind, "AI")));
        return { marketId: to };
      });
    },
  },
  /** The owner's display name, with the same rules as PATCH /account/profile. */
  UPDATE_DISPLAY_NAME: {
    required: ["targetResource", "displayName", "before"],
    requiresConfirmation: true,
    read: readOwnProfile,
    allowed: (snapshot, actorId, input) => (snapshot.ownerId !== actorId ? "لا يمكنك تعديل حساب آخر" : displayNameProblem(String(input.displayName ?? ""))),
    reviewLines: (_snapshot, input) => [
      `الاسم الحالي: «${String(input.before)}»`,
      `الاسم الجديد: «${String(input.displayName).trim()}»`,
      "يظهر للطرف الآخر في طلباتك ورسائلك",
      "لا يغيّر رقم هاتفك أو كلمة المرور",
    ],
    execute: async ({ actorId, values }) => {
      const [row] = await db
        .update(users)
        .set({ displayName: String(values.displayName).trim(), updatedAt: new Date() })
        .where(eq(users.id, actorId))
        .returning({ displayName: users.displayName });
      if (!row) throw fail(404, "الحساب غير موجود");
      return { displayName: row.displayName };
    },
  },
  /** NEXT G2: one buyer–seller message, sent verbatim only after its author confirms it. */
  SEND_INQUIRY_MESSAGE: {
    required: ["targetResource", "body", "provenance"],
    requiresConfirmation: true,
    read: readInquiryTarget,
    allowed: (snapshot, _actorId, input) => {
      if (snapshot.reason) return snapshot.reason;
      const problem = inquiryBodyProblem(String(input.body ?? ""), snapshot.inquiryTitle ?? undefined);
      if (problem) return problem;
      if (containsPriceOffer(String(input.body ?? ""))) return "الرسالة تتضمن عرض سعر؛ العروض المالية تُرسل عبر التفاوض";
      return undefined;
    },
    reviewLines: (snapshot, input) => [
      `إلى: ${snapshot.inquiryRole === "SELLER" ? "المشتري" : "البائع"} — بخصوص «${snapshot.inquiryTitle ?? "الإعلان"}»`,
      ...(typeof input.sourceQuestion === "string"
        ? [`سؤال المشتري: «${String(input.sourceQuestion).slice(0, 240)}»`]
        : []),
      ...(input.inventorySnapshot && typeof input.inventorySnapshot === "object"
        ? [(() => {
            const fact = input.inventorySnapshot as { inventoryMode?: unknown; availableQuantity?: unknown };
            if (fact.inventoryMode === "UNLIMITED")
              return "نمط المخزون المسجل عند إعداد الرد: غير محدود؛ لا يوجد رقم كمية.";
            return typeof fact.availableQuantity === "number"
              ? `المخزون المحدود المسجل عند إعداد الرد: ${fact.availableQuantity} متاح`
              : "المخزون المحدود المسجل عند إعداد الرد: لا يوجد رقم محدد للكمية.";
          })()]
        : []),
      `الرسالة كما ستصل: «${String(input.body)}»`,
      input.provenance === "DINAR_DRAFT_APPROVED" ? "صاغ DINAR هذه الرسالة؛ لن تُرسل إلا بموافقتك" : "بكلماتك كما كتبتها",
      "استفسار وليس عرض سعر ولا طلب شراء، ولا يغيّر المخزون",
      "لا يُشارك رقم هاتفك أو عنوانك",
    ],
    execute: async ({ actionId, actorId, market, resourceId, values, delegatedAuthority }) => {
      if (delegatedAuthority && !delegatedAuthority.listingId)
        throw fail(403, "الرد المفوّض غير مرتبط بعرض محدد", "D5_INQUIRY_SCOPE_REQUIRED");
      const [set] = await db.select({ conversationId: aiResultSets.conversationId }).from(aiResultSets).where(eq(aiResultSets.id, actionId));
      const sent = await submitInquiryMessage({
        actionId,
        actorId,
        market,
        target: parseTargetKey(resourceId)!,
        body: String(values.body),
        provenance: values.provenance as InquiryProvenance,
        originConversationId: set!.conversationId,
        ...(typeof values.sourceQuestion === "string" ? { sourceQuestion: values.sourceQuestion } : {}),
        ...(delegatedAuthority
          ? { delegatedAuthority: { ...delegatedAuthority, listingId: delegatedAuthority.listingId! } }
          : {}),
      });
      return { inquiryId: sent.inquiryId, messageId: sent.messageId, duplicate: sent.duplicate, replied: sent.replied };
    },
  },
  UPDATE_LISTING_PRICE: {
    required: ["targetResource", "price"],
    requiresConfirmation: true,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId
        ? "العرض غير موجود"
        : !["PUBLISHED", "PAUSED"].includes(snapshot.resourceStatus)
          ? "لا يمكن تعديل هذا العرض في حالته الحالية"
          : undefined,
    reviewLines: (snapshot, input, market) => [
      `السعر الحالي: ${money(snapshot.unitPriceMinor, market)}`,
      `السعر الجديد: ${money(parseListingPriceMinor(String(input.price), market.currencyCode), market)}`,
    ],
    execute: async ({ actorId, market, resourceId, values, expected }) => {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(offers).where(eq(offers.id, resourceId));
        if (!row) throw fail(404, "العرض غير موجود");
        const body = buildListingUpdateBody(row, market);
        body.unitPrice = (parseListingPriceMinor(String(values.price), market.currencyCode) / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale);
        await updateOwnedListing(
          { listingId: resourceId, ownerId: actorId, market, body: UpdateListingBody.parse(body), expectedUpdatedAt: expected.version },
          tx,
        );
      });
    },
  },
  ADD_TO_CART: {
    required: ["targetResource", "quantity"],
    requiresConfirmation: true,
    read: readListingForBuyer,
    allowed: (snapshot, actorId, input) =>
      snapshot.ownerId === actorId
        ? "لا يمكنك شراء عرضك"
        : snapshot.resourceStatus !== "PUBLISHED"
          ? "العرض غير متاح حاليًا"
          : // Same rule as checkout and PLACE_ORDER: only a definite asking price enters the cart without an agreement.
            !snapshot.directPurchase && snapshot.agreedQuantity === undefined
            ? needsAgreementMessage(snapshot.priceRepresentation)
            : snapshot.agreedQuantity !== undefined && Number(input.quantity) > snapshot.agreedQuantity
              ? `السعر المتفق عليه يشمل ${snapshot.agreedQuantity} فقط`
              : undefined,
    reviewLines: (snapshot, input, market) => [
      snapshot.publicUnitPriceMinor !== undefined
        ? `السعر المتفق عليه: ${money(snapshot.unitPriceMinor, market)} (السعر المعلن ${money(snapshot.publicUnitPriceMinor, market)})`
        : `السعر: ${money(snapshot.unitPriceMinor, market)}`,
      `الكمية: ${String(input.quantity)}`,
    ],
    execute: async ({ actorId, market, resourceId, values }) => {
      await addMarketplaceCartItem({ userId: actorId, expectedMarketId: market.id, listingId: resourceId, quantity: Number(values.quantity) });
    },
  },
  /** Block F3: one listing becomes an order through the canonical checkout authority. */
  PLACE_ORDER: {
    required: ["targetResource", "quantity"],
    requiresConfirmation: true,
    read: readListingForBuyer,
    allowed: (snapshot, actorId, input) => {
      if (snapshot.ownerId === actorId) return "لا يمكنك شراء عرضك";
      if (snapshot.resourceStatus !== "PUBLISHED") return "العرض غير متاح حاليًا";
      if (snapshot.unitPriceMinor === null) return "هذا العرض بلا سعر معلن؛ اتفق مع البائع على السعر أولًا";
      // Same rule as checkout: without an accepted agreement only a definite asking price is ordered.
      if (!snapshot.directPurchase && snapshot.agreedQuantity === undefined)
        return needsAgreementMessage(snapshot.priceRepresentation);
      if (snapshot.available !== null && snapshot.available <= 0) return "المنتج لم يعد متوفرًا";
      const quantity = Number(input.quantity);
      if (snapshot.agreedQuantity !== undefined && quantity > snapshot.agreedQuantity)
        return `السعر المتفق عليه يشمل ${snapshot.agreedQuantity} فقط`;
      if (snapshot.available !== null && quantity > snapshot.available) return `المتوفر الآن ${snapshot.available} فقط`;
      if (typeof input.fulfilment === "string" && !fulfilmentAvailable(snapshot.fulfilmentType, input.fulfilment))
        return "طريقة التوصيل هذه لم تعد متاحة";
      return undefined;
    },
    reviewLines: (snapshot, input, market) => [
      snapshot.publicUnitPriceMinor !== undefined
        ? `السعر المتفق عليه: ${money(snapshot.unitPriceMinor, market)} (السعر المعلن ${money(snapshot.publicUnitPriceMinor, market)})`
        : `السعر: ${money(snapshot.unitPriceMinor, market)}`,
      `الكمية: ${String(input.quantity)}`,
      `الإجمالي: ${money(snapshot.unitPriceMinor === null ? null : snapshot.unitPriceMinor * Number(input.quantity), market)}`,
      typeof input.fulfilment === "string"
        ? `التسليم: ${METHOD_LABELS[input.fulfilment as DeliveryMethod] ?? input.fulfilment}`
        : "التسليم: تختاره بعد إنشاء الطلب",
      "الدفع: تجريبي دون تحويل أموال",
    ],
    execute: async ({ actionId, actorId, market, resourceId, values, expected }) => {
      // The idempotency key is the reviewed action: retries return the same order.
      const placed = await checkoutForActor(
        actorId,
        [{ listingId: resourceId, quantity: Number(values.quantity), fulfilmentType: expected.fulfilmentType ?? "" }],
        `dinar-f3-order-${actionId}`,
      );
      const orderId = String(placed.orders[0]!.id);
      if (typeof values.fulfilment !== "string") return { orderId };
      // The order exists now; a fulfilment rejection is reported, never hidden or faked.
      try {
        await db.transaction((tx) => selectDeliveryMethod({ actorId, orderId, method: values.fulfilment as DeliveryMethod, market }, tx));
        return { orderId, fulfilment: values.fulfilment };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return { orderId, fulfilmentError: typeof status === "number" && status < 500 && error instanceof Error ? error.message : "تعذر تحديد طريقة التسليم" };
      }
    },
  },
  /** Block F5: a complete conversational draft, published through the Block B authority. */
  PUBLISH_LISTING: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: async (actorId, draftId, tx) => (await readDraftSnapshot(actorId, draftId, tx))?.snapshot,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId
        ? "المسودة غير موجودة"
        : snapshot.resourceStatus === "PUBLISHED"
          ? "نُشر هذا الإعلان من قبل"
          : snapshot.resourceStatus === "CANCELLED"
            ? "أُلغيت هذه المسودة"
            : snapshot.resourceStatus !== "COMPLETE"
              ? "المسودة ناقصة"
              : undefined,
    reviewLines: () => ["يُنشر عبر نموذج النشر نفسه بعد التحقق من البيانات الحالية"],
    execute: async ({ actionId, actorId, resourceId }) => publishDraft({ actionId, actorId, draftId: resourceId }),
  },
  /** Block F4: a driver sends a complete DRAFT profile for administrator review. */
  SUBMIT_DRIVER_PROFILE: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readDriverProfileSnapshot,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId
        ? "ملف السائق غير موجود"
        : snapshot.resourceStatus === "DRAFT_INCOMPLETE"
          ? "ملف السائق ناقص"
          : snapshot.resourceStatus !== "DRAFT"
            ? `طلب التسجيل ${DRIVER_STATUS_LABELS[snapshot.resourceStatus] ?? ""} بالفعل`
            : undefined,
    reviewLines: () => ["يُرسل الطلب لمراجعة إدارة DINAR؛ لا يُعتمد تلقائيًا"],
    execute: async ({ actorId, market, resourceId }) => {
      const profile = await submitDriverProfile({ userId: actorId, market, profileId: resourceId });
      return { driverProfileId: profile.id, status: profile.status };
    },
  },
  /** Block F4: a driver takes one open COURIER delivery; the assignment is atomic. */
  ACCEPT_DELIVERY: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readDeliveryWorkSnapshot,
    allowed: (snapshot) =>
      snapshot.resourceStatus === "OPEN"
        ? undefined
        : (snapshot.reason ?? WORK_STATE_MESSAGES[snapshot.resourceStatus as keyof typeof WORK_STATE_MESSAGES] ?? "مهمة التوصيل هذه لم تعد متاحة"),
    reviewLines: () => ["تُسند المهمة إليك وحدك بعد التحقق من أنها ما زالت متاحة"],
    execute: async ({ actorId, market, resourceId }) => {
      const assignment = await assignDelivery({ actorId, orderId: resourceId, market });
      return { orderId: assignment.orderId, assignmentId: assignment.assignmentId };
    },
  },
  /** Block F3: a test-only payment intent through the Wave 4 payment authority. */
  CREATE_PAYMENT_INTENT: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readOrderSnapshot,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId
        ? "الطلب غير موجود"
        : snapshot.resourceStatus === "PAYMENT_STARTED"
          ? "بدأ دفع هذا الطلب من قبل"
          : snapshot.resourceStatus !== "PAYABLE"
            ? "الطلب لم يعد قابلًا للدفع"
            : undefined,
    reviewLines: (snapshot, _input, market) => [
      `المبلغ المستحق: ${money(snapshot.unitPriceMinor, market)}`,
      "الدفع: تجريبي (SIMULATION_ONLY) دون تحويل أموال حقيقية",
    ],
    execute: async ({ actionId, actorId, resourceId }) => {
      if (!paymentSimulationEnabled()) throw fail(409, "الدفع غير متاح في هذه البيئة");
      const intent = await createTestPaymentIntent({ buyerId: actorId, orderId: resourceId, idempotencyKey: `dinar-f3-pay-${actionId}` });
      return { orderId: resourceId, paymentIntentId: intent.id, paymentStatus: intent.status, mode: intent.mode, amountMinor: intent.amountMinor };
    },
  },
  /** G2: a buyer sends a price proposal on any listing through the negotiation authority. */
  SEND_NEGOTIATION_OFFER: {
    required: ["targetResource", "amountMinor", "quantity"],
    requiresConfirmation: true,
    allowed: (snapshot, actorId, input) => {
      if (snapshot.ownerId === actorId) return "لا يمكنك التفاوض على عرضك";
      if (snapshot.resourceStatus !== "PUBLISHED") return "العرض غير متاح حاليًا";
      if (!snapshot.negotiable) return "تسعير هذا الإعلان غير متاح للتفاوض حاليًا";
      const ceiling = proposalCeilingMinor(snapshot.priceRepresentation ?? null, snapshot.unitPriceMinor);
      if (ceiling !== null && Number(input.amountMinor) > ceiling) return OFFER_ABOVE_LISTED;
      if (snapshot.available !== null && Number(input.quantity) > snapshot.available) return `المتوفر الآن ${snapshot.available} فقط`;
      return undefined;
    },
    reviewLines: (snapshot, input, market) => [
      snapshot.unitPriceMinor === null
        ? snapshot.priceRepresentation === "QUOTE_REQUIRED" ? "السعر: حسب تسعيرة البائع" : "السعر المعلن: لا يوجد"
        : snapshot.priceRepresentation === "STARTING_FROM"
          ? `يبدأ من: ${money(snapshot.unitPriceMinor, market)} (ليس سعرًا نهائيًا)`
          : snapshot.priceRepresentation === "OPEN_TO_OFFERS"
            ? `السعر الاسترشادي: ${money(snapshot.unitPriceMinor, market)}`
            : `السعر المطلوب: ${money(snapshot.unitPriceMinor, market)}`,
      `عرضك: ${money(Number(input.amountMinor), market)}`,
      `الكمية: ${String(input.quantity)}`,
      "يصل العرض للبائع فقط، ولا يتغير السعر المعلن",
    ],
    execute: async ({ actorId, market, resourceId, values }) => {
      const negotiation = await openNegotiation({ buyerId: actorId, listingId: resourceId, amountMinor: Number(values.amountMinor), quantity: Number(values.quantity), market });
      return { negotiationId: negotiation.id, status: negotiation.status };
    },
  },
  /** A buyer asks the seller for their price through the same negotiation authority. */
  REQUEST_BEST_PRICE: {
    required: ["targetResource", "quantity"],
    requiresConfirmation: true,
    allowed: (snapshot, actorId, input) => {
      if (snapshot.ownerId === actorId) return "لا يمكنك التفاوض على عرضك";
      if (snapshot.resourceStatus !== "PUBLISHED") return "العرض غير متاح حاليًا";
      if (!snapshot.negotiable) return "تسعير هذا الإعلان غير متاح للتفاوض حاليًا؛ لن يُرسل طلب";
      if (snapshot.available !== null && Number(input.quantity) > snapshot.available)
        return `المتوفر الآن ${snapshot.available} فقط`;
      return undefined;
    },
    reviewLines: (snapshot) => [
      snapshot.priceRepresentation === "QUOTE_REQUIRED" || snapshot.priceRepresentation === "STARTING_FROM"
        ? "طلب تسعيرة من البائع؛ ليس عرضًا ملزمًا"
        : "طلب معرفة أفضل سعر من البائع",
      "لن يرسل DINAR سعرًا نيابةً عن البائع",
      "تصلك تسعيرة البائع لتقبلها أو تفاوض عليها",
      "لن يتغير السعر المعلن",
    ],
    execute: async ({ actorId, market, resourceId, values }) => {
      const negotiation = await openNegotiation({
        buyerId: actorId,
        listingId: resourceId,
        type: "BEST_PRICE_REQUEST",
        quantity: Number(values.quantity),
        market,
      });
      return { negotiationId: negotiation.id, status: negotiation.status };
    },
  },
  /** G2: the seller answers a buyer's open offer with a counter amount. */
  COUNTER_NEGOTIATION: {
    required: ["targetResource", "amountMinor"],
    requiresConfirmation: true,
    read: readNegotiationSnapshot,
    allowed: negotiationTurnAllowed(),
    reviewLines: (snapshot, input, market) => [
      snapshot.unitPriceMinor === null
        ? "طلب المشتري معرفة أفضل سعر"
        : `المبلغ الحالي: ${money(snapshot.unitPriceMinor, market)}`,
      `عرضك المضاد: ${money(Number(input.amountMinor), market)}`,
      "يصل للمشتري فقط، ولا يتغير السعر المعلن",
    ],
    execute: async ({ actorId, market, resourceId, values, expected }) => {
      const negotiation = await decideNegotiation({ actorId, negotiationId: resourceId, decision: "COUNTER", amountMinor: Number(values.amountMinor), market, expectedVersion: Number(expected.version) });
      return { negotiationId: negotiation.id, status: negotiation.status };
    },
  },
  /** G2: the party the negotiation awaits accepts the amount on the table. */
  ACCEPT_NEGOTIATION: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readNegotiationSnapshot,
    allowed: negotiationTurnAllowed(),
    reviewLines: (snapshot, _input, market) => [
      `السعر المتفق عليه: ${money(snapshot.unitPriceMinor, market)}`,
      "يُستخدم هذا السعر لطلبك أنت فقط ولا يتغير السعر المعلن",
      "يُعاد التحقق من توفر المنتج عند إنشاء الطلب",
    ],
    execute: async ({ actorId, market, resourceId, expected }) => {
      const negotiation = await decideNegotiation({ actorId, negotiationId: resourceId, decision: "ACCEPT", market, expectedVersion: Number(expected.version) });
      return { negotiationId: negotiation.id, status: negotiation.status };
    },
  },
  /** G2: the party the negotiation awaits declines it. */
  REJECT_NEGOTIATION: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readNegotiationSnapshot,
    allowed: negotiationTurnAllowed(),
    reviewLines: (snapshot, _input, market) => [`المبلغ المعروض: ${money(snapshot.unitPriceMinor, market)}`, "يُغلق عرض السعر دون أي طلب"],
    execute: async ({ actorId, market, resourceId, expected }) => {
      const negotiation = await decideNegotiation({ actorId, negotiationId: resourceId, decision: "REJECT", market, expectedVersion: Number(expected.version) });
      return { negotiationId: negotiation.id, status: negotiation.status };
    },
  },
  WITHDRAW_NEGOTIATION: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readNegotiationSnapshot,
    allowed: (snapshot) => {
      if (!snapshot.resourceStatus.startsWith("AWAITING_"))
        return `عرض السعر ${snapshot.reason ?? "مغلق"} بالفعل`;
      // The seller withdraws only its own counter that awaits the buyer.
      if (snapshot.negotiationRole === "SELLER" && snapshot.resourceStatus !== "AWAITING_OTHER")
        return "يسحب البائع عرضه المقابل فقط؛ لعرض المشتري استخدم الرفض";
      return undefined;
    },
    reviewLines: (snapshot, _input, market) => [
      `المبلغ الحالي: ${snapshot.unitPriceMinor === null ? "طلب معرفة أفضل سعر" : money(snapshot.unitPriceMinor, market)}`,
      snapshot.negotiationRole === "SELLER" ? "سيُسحب عرضك المقابل دون حذف سجل التفاوض" : "سيُسحب عرضك النشط دون حذف سجل التفاوض",
    ],
    execute: async ({ actorId, market, resourceId, expected }) => {
      const negotiation = await decideNegotiation({ actorId, negotiationId: resourceId, decision: "WITHDRAW", market, expectedVersion: Number(expected.version) });
      return { negotiationId: negotiation.id, status: negotiation.status };
    },
  },
  /** G1: the owner opens a provider connection in its active market; no key is shown here. */
  CREATE_PROVIDER_CONNECTION: {
    required: ["targetResource", "name", "scopes"],
    requiresConfirmation: true,
    read: readProviderOwnerSnapshot,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId
        ? "غير مسموح"
        : snapshot.resourceStatus === "LIMIT"
          ? `لديك ${MAX_ACTIVE_PROVIDER_CONNECTIONS} روابط نشطة؛ أوقف ربطًا قبل إنشاء آخر`
          : undefined,
    reviewLines: (_snapshot, input, market) => [
      `اسم الربط: ${String(input.name)}`,
      `السوق: ${market.id}`,
      ...(input.scopes as ProviderScope[]).map((scope) => `صلاحية: ${PROVIDER_SCOPE_LABELS[scope]}`),
    ],
    execute: async ({ actorId, values }) => {
      const connection = await createProviderConnection({ ownerId: actorId, name: String(values.name), scopes: values.scopes as string[] });
      return { connectionId: connection.id, name: connection.name };
    },
  },
  /** G1: «بدل المفتاح» — the current key stops now; the owner issues the new one once. */
  ROTATE_PROVIDER_CREDENTIAL: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readProviderConnectionSnapshot,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId ? "الربط غير موجود" : snapshot.resourceStatus !== "ACTIVE" ? "هذا الربط موقوف" : undefined,
    reviewLines: () => ["يتوقف المفتاح الحالي فورًا", "يُنشأ مفتاح جديد ويُعرض لك مرة واحدة فقط"],
    execute: async ({ actorId, resourceId }) => {
      const outcome = await revokeProviderCredential({ ownerId: actorId, connectionId: resourceId });
      return { connectionId: resourceId, revokedKeys: outcome.revoked };
    },
  },
  /** G1: «أوقف الربط» — key revoked, listings paused, history kept. */
  REVOKE_PROVIDER_CONNECTION: {
    required: ["targetResource"],
    requiresConfirmation: true,
    read: readProviderConnectionSnapshot,
    allowed: (snapshot, actorId) =>
      snapshot.ownerId !== actorId ? "الربط غير موجود" : snapshot.resourceStatus !== "ACTIVE" ? "هذا الربط موقوف بالفعل" : undefined,
    reviewLines: () => [
      "يتوقف مفتاح الربط ولا يقبل DINAR أي مزامنة جديدة منه",
      "تتوقف العروض المنشورة من هذا الربط مؤقتًا وتبقى لك لإدارتها",
      "تبقى الطلبات والمدفوعات والسجلات كما هي",
    ],
    execute: async ({ actorId, resourceId }) => {
      const outcome = await revokeProviderConnection({ ownerId: actorId, connectionId: resourceId });
      return { connectionId: resourceId, pausedListings: outcome.pausedListings, unlinkedDrivers: outcome.unlinkedDrivers };
    },
  },
};

/** G2: a listing as this buyer would buy it: an unconsumed accepted negotiation overrides the price. */
export async function readListingForBuyer(actorId: string, listingId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const snapshot = await readServerSnapshot(actorId, listingId, tx);
  if (!snapshot) return undefined;
  const agreed = await acceptedNegotiationForCheckout(tx, actorId, listingId);
  const price = resolveCommercialUnitPrice(snapshot, agreed);
  if (!agreed || !price || price.source !== "NEGOTIATED_PRICE") return snapshot;
  return {
    ...snapshot,
    ...(price.listedUnitPriceMinor !== null
      ? { publicUnitPriceMinor: price.listedUnitPriceMinor }
      : {}),
    unitPriceMinor: price.unitPriceMinor,
    agreedQuantity: agreed.quantity,
    version: `${snapshot.version}|negotiation:${agreed.id}:${agreed.version}`,
  };
}

/** G2: a negotiation as one of its parties sees it; anyone else reads nothing. */
async function readNegotiationSnapshot(actorId: string, negotiationId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const [[actor], row] = await Promise.all([
    tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId)),
    negotiationForParty(actorId, negotiationId, tx),
  ]);
  if (!actor || !row) return undefined;
  const role = roleOf(row, actorId);
  if (!role) return undefined;
  const status = effectiveStatus(row);
  const awaiting = awaitingRole(row);
  return {
    actorStatus: actor.status,
    actorMarketId: actor.activeMarketId,
    resourceMarketId: row.marketId,
    resourceStatus: awaiting === null ? status : awaiting === role ? `AWAITING_${role}` : "AWAITING_OTHER",
    ownerId: actorId,
    unitPriceMinor: status === "COUNTERED" ? row.counterAmountMinor : row.offerAmountMinor,
    available: null,
    version: String(row.version),
    reason: NEGOTIATION_STATUS_LABELS[status],
    negotiationRole: role,
  };
}

function negotiationTurnAllowed(role?: "BUYER" | "SELLER") {
  return (snapshot: ServerSnapshot) => {
    if (snapshot.resourceStatus === "AWAITING_OTHER") return "عرض السعر بانتظار رد الطرف الآخر";
    if (!snapshot.resourceStatus.startsWith("AWAITING_")) return `عرض السعر ${snapshot.reason ?? "مغلق"} بالفعل`;
    if (role && snapshot.resourceStatus !== `AWAITING_${role}`) return role === "SELLER" ? "العرض المضاد للبائع فقط" : "هذا القرار للمشتري فقط";
    return undefined;
  };
}

/** G1: the account itself as the target of a new provider connection. */
async function readProviderOwnerSnapshot(actorId: string, ownerId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const [owner] = await tx.select({ id: users.id, status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, ownerId));
  if (!owner) return undefined;
  const [{ active }] = await tx
    .select({ active: count() })
    .from(providerConnections)
    .where(and(eq(providerConnections.ownerUserId, owner.id), eq(providerConnections.status, "ACTIVE")));
  return {
    actorStatus: owner.status,
    actorMarketId: owner.activeMarketId,
    resourceMarketId: owner.activeMarketId,
    resourceStatus: Number(active) >= MAX_ACTIVE_PROVIDER_CONNECTIONS ? "LIMIT" : "READY",
    ownerId: actorId === owner.id ? owner.id : "",
    unitPriceMinor: null,
    available: null,
    version: String(active),
  };
}

/** G1: a provider connection as its owner may rotate or revoke it. */
async function readProviderConnectionSnapshot(actorId: string, connectionId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const [[actor], [connection]] = await Promise.all([
    tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId)),
    tx.select().from(providerConnections).where(eq(providerConnections.id, connectionId)),
  ]);
  if (!actor || !connection) return undefined;
  const [key] = await tx
    .select({ keyId: providerCredentials.keyId })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.connectionId, connection.id), isNull(providerCredentials.revokedAt)));
  return {
    actorStatus: actor.status,
    actorMarketId: actor.activeMarketId,
    resourceMarketId: connection.marketId,
    resourceStatus: connection.status,
    ownerId: connection.ownerUserId,
    unitPriceMinor: null,
    available: null,
    version: `${connection.status}:${key?.keyId ?? "none"}`,
  };
}

/** Block F4: a driver profile as its owner may submit it. */
async function readDriverProfileSnapshot(actorId: string, profileId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const [[actor], [profile]] = await Promise.all([
    tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId)),
    tx.select().from(driverProfiles).where(eq(driverProfiles.id, profileId)),
  ]);
  if (!actor || !profile) return undefined;
  return {
    actorStatus: actor.status,
    actorMarketId: actor.activeMarketId,
    resourceMarketId: profile.marketId,
    resourceStatus: profile.status === "DRAFT" && missingDriverFields(profile, { id: profile.marketId }).length ? "DRAFT_INCOMPLETE" : profile.status,
    ownerId: profile.userId,
    unitPriceMinor: null,
    available: null,
    version: String(profile.version),
  };
}

/** Block F4: an order as delivery work for this driver, with every eligibility fact. */
async function readDeliveryWorkSnapshot(actorId: string, orderId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const state = await deliveryWorkState(actorId, orderId, tx);
  if (!state) return undefined;
  return {
    actorStatus: state.actorStatus,
    actorMarketId: state.actorMarketId,
    resourceMarketId: state.orderMarketId,
    resourceStatus: state.code,
    ownerId: "",
    unitPriceMinor: null,
    available: null,
    version: state.version,
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

/** Block D's methods for a listing, read the way an order snapshotting it would be. */
export function listingFulfilmentOptions(listingFulfilment: string | undefined, market?: Market) {
  const asOrder = { data: { fulfilmentType: listingFulfilment ?? "" } } as unknown as Parameters<typeof deliveryOptions>[0];
  return deliveryOptions(asOrder, market)
    .filter((option) => option.available)
    .map((option) => ({ method: option.method, label: option.label }));
}

const fulfilmentAvailable = (listingFulfilment: string | undefined, method: string) =>
  listingFulfilmentOptions(listingFulfilment).some((option) => option.method === method);

/** An order as the payment authority will see it: payable only while CREATED, reserved and unpaid. */
async function readOrderSnapshot(actorId: string, orderId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const [[actor], [order], [intent]] = await Promise.all([
    tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId)),
    tx.select().from(orders).where(eq(orders.id, orderId)),
    tx.select({ id: paymentIntents.id }).from(paymentIntents).where(eq(paymentIntents.orderId, orderId)),
  ]);
  if (!actor || !order) return undefined;
  const status =
    order.status !== "CREATED"
      ? order.status
      : order.data.paymentMode !== "TEST_NO_TRANSFER" || !order.reservationExpiresAt || order.reservationExpiresAt.getTime() <= Date.now()
        ? "NOT_PAYABLE"
        : intent
          ? "PAYMENT_STARTED"
          : "PAYABLE";
  return {
    actorStatus: actor.status,
    actorMarketId: actor.activeMarketId,
    resourceMarketId: order.marketId,
    resourceStatus: status,
    ownerId: order.buyerId,
    unitPriceMinor: order.subtotalMinor,
    available: null,
    version: `${order.updatedAt.toISOString()}|${intent?.id ?? ""}`,
  };
}

export class UnknownActionError extends Error {
  readonly status = 400;
  constructor(name: string) {
    super(`Unregistered action: ${name.slice(0, 60)}`);
    this.name = "UnknownActionError";
  }
}

/**
 * Builds a typed proposal from facts already known. Missing fields are only the required
 * inputs still unknown, so DINAR asks for nothing the user already gave.
 */
export function proposeAction(input: {
  action: string;
  targetResource?: string;
  facts?: Record<string, readonly Fact[]>;
}): ActionProposal {
  const definition = Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, input.action) ? ACTION_REGISTRY[input.action] : undefined;
  if (!definition) throw new UnknownActionError(input.action);
  const conversationAction = Object.prototype.hasOwnProperty.call(
    CONVERSATION_ACTION_REGISTRY,
    input.action,
  )
    ? CONVERSATION_ACTION_REGISTRY[input.action as ConversationActionId]
    : undefined;
  if (!conversationAction)
    throw new Error(`Registered action ${input.action} has no conversation contract.`);
  if (
    conversationAction.routeKind !== "STATE_CHANGING_ACTION" ||
    conversationAction.authorization !== "AUTHENTICATED" ||
    conversationAction.confirmationRequired !== definition.requiresConfirmation
  )
    throw new Error(`Registered action ${input.action} violates its conversation contract.`);
  const structuredInput = resolveFacts(input.facts ?? {});
  const missingFields = definition.required.filter((field) =>
    field === "targetResource" ? !input.targetResource : (structuredInput[field]?.value ?? null) === null,
  );
  return {
    action: input.action,
    ...(input.targetResource ? { targetResource: input.targetResource } : {}),
    structuredInput,
    missingFields,
    requiresConfirmation: conversationAction.confirmationRequired,
  };
}

/** Facts stated in one command, each marked as the user's own statement. */
export function commandFacts(message: string): Record<string, Fact[]> {
  const parsed = parseCommandNumbers(message);
  const facts: Record<string, Fact[]> = {};
  if (parsed.price !== undefined) facts.price = [{ value: parsed.price, source: "USER_DECLARED" }];
  if (parsed.quantity !== undefined) facts.quantity = [{ value: parsed.quantity, source: "USER_DECLARED" }];
  if (parsed.durationDays !== undefined) facts.durationDays = [{ value: parsed.durationDays, source: "USER_DECLARED" }];
  return facts;
}

// ─── Server state ────────────────────────────────────────────────────────────

/** Re-reads everything a confirmation depends on; nothing comes from the conversation. */
export async function readServerSnapshot(actorId: string, resourceId: string, tx: any = db): Promise<ServerSnapshot | undefined> {
  const [[actor], [row]] = await Promise.all([
    tx.select({ status: users.status, activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actorId)),
    tx.select().from(offers).where(eq(offers.id, resourceId)),
  ]);
  if (!actor || !row) return undefined;
  return {
    actorStatus: actor.status,
    actorMarketId: actor.activeMarketId,
    resourceMarketId: row.marketId,
    resourceStatus: row.status,
    ownerId: row.sellerId,
    unitPriceMinor: row.unitPriceMinor,
    available: row.inventoryMode === "UNLIMITED" ? null : (row.availableQuantity ?? 0) - row.reservedQuantity,
    version: row.updatedAt.toISOString(),
    fulfilmentType: typeof row.data?.fulfilmentType === "string" ? row.data.fulfilmentType : undefined,
    negotiable: listingNegotiable(row),
    pricingMode: row.pricingMode,
    priceRepresentation: priceRepresentationOf(row),
    directPurchase: directPurchaseAllowed(priceRepresentationOf(row), row.unitPriceMinor),
  };
}

/** Server facts about a resource, for review and context. */
export function serverFacts(snapshot: ServerSnapshot | undefined): Record<string, Fact> {
  if (!snapshot) return {};
  return {
    status: { value: snapshot.resourceStatus, source: "SERVER_FACT" },
    unitPriceMinor: { value: snapshot.unitPriceMinor, source: "SERVER_FACT" },
    available: { value: snapshot.available, source: "SERVER_FACT" },
  };
}

function invalidReason(
  snapshot: ServerSnapshot | undefined,
  actorId: string,
  market: Market,
  definition: ActionDefinition,
  values: Record<string, unknown>,
): string | undefined {
  if (!snapshot) return definition.read ? "الطلب غير موجود" : "العرض لم يعد موجودًا";
  if (snapshot.actorStatus !== "ACTIVE") return "حسابك غير نشط حاليًا";
  if (snapshot.actorMarketId !== market.id || snapshot.resourceMarketId !== market.id)
    return definition.read ? "هذا الطلب ليس في سوقك الحالي" : "العرض ليس في سوقك الحالي";
  if (snapshot.resourceStatus.startsWith("MODERATION_")) return "العرض موقوف بقرار إداري";
  return definition.allowed(snapshot, actorId, values);
}

const readFor = (definition: ActionDefinition) => definition.read ?? readServerSnapshot;

const sameState = (a: ServerSnapshot, b: ServerSnapshot) =>
  a.version === b.version &&
  a.resourceStatus === b.resourceStatus &&
  a.unitPriceMinor === b.unitPriceMinor &&
  a.available === b.available &&
  a.actorStatus === b.actorStatus &&
  a.actorMarketId === b.actorMarketId &&
  a.resourceMarketId === b.resourceMarketId &&
  a.fulfilmentType === b.fulfilmentType &&
  a.negotiable === b.negotiable &&
  a.priceRepresentation === b.priceRepresentation;

// ─── Pending actions ─────────────────────────────────────────────────────────

type PendingQuery = {
  kind: typeof ACTION_KIND;
  ownerId: string;
  action: string;
  targetResource: string;
  structuredInput: Record<string, Fact>;
  expected: ServerSnapshot;
  status: "PENDING" | "EXECUTING" | "CONFIRMED" | "CANCELLED" | "EXPIRED" | "SUPERSEDED" | "REJECTED";
  review: string[];
  notice?: string;
  /** The turns that opened and last settled this action (turn-context.ts). */
  openedByTurn?: string;
  settledByTurn?: string;
  /** What the authority created, e.g. the order id; set only after it succeeded. */
  result?: Record<string, unknown>;
  /** D5 send reviews are bound to the active session and exact business listing. */
  delegatedAuthority?: {
    sessionId: string;
    capabilities: SellerEmployeeCapability[];
    listingId?: string;
    inventorySnapshot?: {
      inventoryMode: "LIMITED" | "UNLIMITED";
      availableQuantity: number | null;
      recordedAvailableQuantity: number | null;
      reservedQuantity: number;
    };
  };
};

export type DelegatedActionAuthority = NonNullable<PendingQuery["delegatedAuthority"]>;

export type ActionReview = { actionId: string; action: string; targetResource: string; lines: string[]; expiresAt: string };

/**
 * REVIEW: validates the proposal against current server state and stores the exact
 * state the user is about to confirm. Incomplete proposals are never stored.
 */
export async function createPendingAction(input: {
  conversationId: string;
  actorId: string;
  market: Market;
  proposal: ActionProposal;
  delegatedAuthority?: DelegatedActionAuthority;
}): Promise<ActionReview> {
  const { proposal } = input;
  const definition = Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, proposal.action) ? ACTION_REGISTRY[proposal.action] : undefined;
  if (!definition) throw new UnknownActionError(proposal.action);
  if (proposal.missingFields.length || !proposal.targetResource)
    throw fail(400, `معلومات ناقصة: ${proposal.missingFields.join("، ")}`, "MISSING_FIELDS");
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.marketId, input.market.id)));
  if (!conversation) throw fail(404, "المحادثة غير موجودة");
  const snapshot = await readFor(definition)(input.actorId, proposal.targetResource);
  const values = Object.fromEntries(Object.entries(proposal.structuredInput).map(([key, fact]) => [key, fact.value]));
  const reason = invalidReason(snapshot, input.actorId, input.market, definition, values);
  if (reason) throw fail(409, reason);
  if (input.delegatedAuthority) {
    for (const capability of input.delegatedAuthority.capabilities) {
      await requireSellerEmployeeCapability({
        actorId: input.actorId,
        conversationId: input.conversationId,
        marketId: input.market.id,
        sessionId: input.delegatedAuthority.sessionId,
        capability,
        listingId: input.delegatedAuthority.listingId,
      });
    }
  }
  const review = definition.reviewLines(snapshot!, values, input.market);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ACTION_PENDING_TTL_MS);
  const query: PendingQuery = {
    kind: ACTION_KIND,
    ownerId: input.actorId,
    action: proposal.action,
    targetResource: proposal.targetResource,
    structuredInput: proposal.structuredInput,
    expected: snapshot!,
    status: "PENDING",
    review,
    ...(input.delegatedAuthority ? { delegatedAuthority: input.delegatedAuthority } : {}),
    ...(currentTurnId() ? { openedByTurn: currentTurnId() } : {}),
  };
  await db.insert(aiResultSets).values({
    id,
    conversationId: input.conversationId,
    marketId: input.market.id,
    query,
    resourceIds: [proposal.targetResource],
    expiresAt,
  });
  return { actionId: id, action: proposal.action, targetResource: proposal.targetResource, lines: review, expiresAt: expiresAt.toISOString() };
}

/**
 * A pending review can no longer be confirmed once it expired or the conversation moved on past
 * it (a newer result set, or any newer card that is not this review's own or about it). The
 * confirmation path and the receipt view (action-receipts.ts) apply this same rule.
 */
export async function pendingActionLapsed(set: { id: string; conversationId: string; expiresAt: Date | null }, tx: any = db): Promise<boolean> {
  if (set.expiresAt && set.expiresAt.getTime() <= Date.now()) return true;
  // Compared in SQL: database timestamps are finer than a JavaScript Date.
  const createdAt = sql`(select ${aiResultSets.createdAt} from ${aiResultSets} where ${aiResultSets.id} = ${set.id})`;
  const newerSet = await tx
    .select({ id: aiResultSets.id })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, set.conversationId), ne(aiResultSets.id, set.id), gt(aiResultSets.createdAt, createdAt)))
    .limit(1);
  const newerBlock = await tx
    .select({ id: aiUiBlocks.id })
    .from(aiUiBlocks)
    // The review's own card is written after the action row; it never expires the action.
    // G2: an answer that only discussed this pending action (it carries the action's id)
    // keeps it pending; anything else the conversation did since voids it.
    .where(and(
      eq(aiUiBlocks.conversationId, set.conversationId),
      gt(aiUiBlocks.createdAt, createdAt),
      sql`${aiUiBlocks.payload} ->> 'resultSetId' is distinct from ${set.id}`,
      sql`${aiUiBlocks.payload} ->> 'relatesToAction' is distinct from ${set.id}`,
    ))
    .limit(1);
  return newerSet.length > 0 || newerBlock.length > 0;
}

const settledBy = () => (currentTurnId() ? { settledByTurn: currentTurnId() } : {});

export type ConfirmOutcome =
  | {
      status: "CONFIRMED" | "CANCELLED" | "EXPIRED" | "REJECTED" | "IN_PROGRESS";
      message: string;
      result?: Record<string, unknown>;
      /** True only when this call performed the transition; a lost race is settled, not executed. */
      executed?: boolean;
    }
  | { status: "REVIEW_REQUIRED"; message: string; review: ActionReview };

/**
 * CONFIRM → RE-READ → EXECUTE. Only the owner, only while the action is unexpired and
 * still the latest step of the conversation. If anything it depends on changed, the old
 * confirmation is void and a new review is returned instead of executing.
 */
export async function confirmPendingAction(input: {
  actionId: string;
  actorId: string;
  market: Market;
  decision: "CONFIRM" | "CANCEL";
}): Promise<ConfirmOutcome> {
  const claimed = await db.transaction(async (tx) => {
    // D5 lock order is grant → action. Revocation takes the same order before
    // invalidating pending rows, so a confirmation cannot deadlock or pass a
    // revocation that already owns the grant lock.
    const [candidate] = await tx.select().from(aiResultSets)
      .where(eq(aiResultSets.id, input.actionId))
      .limit(1);
    const candidateQuery = candidate?.query as PendingQuery | undefined;
    if (!candidate || candidateQuery?.kind !== ACTION_KIND || candidateQuery.ownerId !== input.actorId)
      throw fail(404, "الإجراء غير موجود");
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, candidate.conversationId), eq(conversations.ownerUserId, input.actorId)));
    if (!conversation || candidate.marketId !== input.market.id) throw fail(404, "الإجراء غير موجود");
    if (input.decision === "CONFIRM" && candidateQuery.status === "PENDING" && candidateQuery.delegatedAuthority) {
      try {
        for (const capability of candidateQuery.delegatedAuthority.capabilities) {
          await assertSellerEmployeeCapabilityTx(tx, {
            actorId: input.actorId,
            conversationId: candidate.conversationId,
            marketId: input.market.id,
            sessionId: candidateQuery.delegatedAuthority.sessionId,
            capability,
            listingId: candidateQuery.delegatedAuthority.listingId,
          });
        }
      } catch (error) {
        const errorStatus = (error as { status?: unknown })?.status;
        if (typeof errorStatus !== "number" || errorStatus >= 500) throw error;
        const [set] = await tx.select().from(aiResultSets)
          .where(eq(aiResultSets.id, input.actionId))
          .for("update");
        const query = set?.query as PendingQuery | undefined;
        const message = `${error instanceof Error ? error.message : "انتهت صلاحية التفويض"}. لم يُنفّذ شيء.`;
        if (set && query?.kind === ACTION_KIND && query.ownerId === input.actorId && query.status === "PENDING") {
          await tx.update(aiResultSets).set({
            query: {
              ...query,
              status: "REJECTED",
              notice: message,
              invalidatedAt: new Date().toISOString(),
              invalidationReason: "AUTHORIZATION_RECHECK_FAILED",
            },
          }).where(eq(aiResultSets.id, set.id));
        }
        return { done: { status: "REJECTED", message, executed: false } as ConfirmOutcome };
      }
    }
    const [set] = await tx.select().from(aiResultSets)
      .where(eq(aiResultSets.id, input.actionId))
      .for("update");
    const query = set?.query as PendingQuery | undefined;
    if (!set || query?.kind !== ACTION_KIND || query.ownerId !== input.actorId)
      throw fail(404, "الإجراء غير موجود");
    if (set.conversationId !== candidate.conversationId || set.marketId !== candidate.marketId)
      throw fail(404, "الإجراء غير موجود");
    const settle = async (status: PendingQuery["status"], message: string) => {
      await tx.update(aiResultSets).set({ query: { ...query, status, notice: message, ...settledBy() } }).where(eq(aiResultSets.id, set.id));
      return { done: { status, message, executed: status === "CANCELLED" } as ConfirmOutcome };
    };
    if (query.status === "EXECUTING") return { done: { status: "IN_PROGRESS", message: "الإجراء قيد التنفيذ.", executed: false } as ConfirmOutcome };
    if (query.status !== "PENDING")
      return { done: { status: query.status === "SUPERSEDED" ? "EXPIRED" : query.status, message: "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء.", executed: false } as ConfirmOutcome };
    if (await pendingActionLapsed(set, tx))
      return settle("EXPIRED", "انتهت صلاحية هذا التأكيد لأن المحادثة تابعت بعده أو مضى وقته. لم يتغير شيء.");
    if (input.decision === "CANCEL") return settle("CANCELLED", "أُلغي الإجراء. لم يتغير شيء.");
    const definition = ACTION_REGISTRY[query.action];
    if (!definition) return settle("REJECTED", "إجراء غير مسجل؛ لم يتغير شيء.");
    const current = await readFor(definition)(input.actorId, query.targetResource, tx);
    const pendingValues = Object.fromEntries(Object.entries(query.structuredInput).map(([key, fact]) => [key, fact.value]));
    const reason = invalidReason(current, input.actorId, input.market, definition, pendingValues);
    if (reason) return settle("REJECTED", `${reason}. لم يتغير شيء.`);
    if (!sameState(current!, query.expected)) {
      await settle("SUPERSEDED", "تغيّرت بيانات العرض منذ المراجعة؛ يلزم تأكيد جديد.");
      return { stale: true, query };
    }
    await tx.update(aiResultSets).set({ query: { ...query, status: "EXECUTING", ...settledBy() } }).where(eq(aiResultSets.id, set.id));
    return { execute: true, query, conversationId: set.conversationId };
  });
  if ("done" in claimed) return claimed.done!;
  const query = claimed.query!;
  if ("stale" in claimed) {
    const set = (await db.select().from(aiResultSets).where(eq(aiResultSets.id, input.actionId)))[0]!;
    const review = await createPendingAction({
      conversationId: set.conversationId,
      actorId: input.actorId,
      market: input.market,
      proposal: {
        action: query.action,
        targetResource: query.targetResource,
        structuredInput: query.structuredInput,
        missingFields: [],
        requiresConfirmation: true,
      },
      ...(query.delegatedAuthority ? { delegatedAuthority: query.delegatedAuthority } : {}),
    });
    return { status: "REVIEW_REQUIRED", message: "تغيّرت بيانات العرض منذ المراجعة. راجع التفاصيل الجديدة ثم أكّد.", review };
  }
  const values = Object.fromEntries(Object.entries(query.structuredInput).map(([key, fact]) => [key, fact.value]));
  let outcome: { status: "CONFIRMED" | "REJECTED"; message: string; result?: Record<string, unknown>; executed: boolean };
  try {
    const result = await ACTION_REGISTRY[query.action]!.execute({
      actionId: input.actionId,
      actorId: input.actorId,
      market: input.market,
      resourceId: query.targetResource,
      values,
      expected: query.expected,
      ...(query.delegatedAuthority ? { delegatedAuthority: query.delegatedAuthority } : {}),
    });
    outcome = { status: "CONFIRMED", message: "تم التنفيذ بعد تأكيدك والتحقق من البيانات الحالية.", executed: true, ...(result ? { result } : {}) };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (!(typeof status === "number" && status < 500 && error instanceof Error)) {
      await db.update(aiResultSets).set({ query: { ...query, status: "REJECTED", notice: "تعذر التنفيذ.", ...settledBy() } }).where(eq(aiResultSets.id, input.actionId));
      throw error;
    }
    outcome = { status: "REJECTED", message: `${error.message}. لم يتغير شيء.`, executed: false };
  }
  await db
    .update(aiResultSets)
    .set({ query: { ...query, status: outcome.status, notice: outcome.message, ...(outcome.result ? { result: outcome.result } : {}), ...settledBy() } })
    .where(eq(aiResultSets.id, input.actionId));
  return outcome;
}

// ─── Conversation context ────────────────────────────────────────────────────

export type ConversationContext = {
  currentGoal: string | null;
  currentResource: string | null;
  currentResultSet: { id: string; resourceIds: string[] } | null;
  currentSelection: string | null;
  knownFacts: Record<string, Fact>;
  missingFacts: string[];
  pendingAction: { actionId: string; action: string; targetResource: string; review: string[]; expiresAt: string | null } | null;
};

/**
 * The orchestration context, rebuilt entirely from server rows on every call, so it
 * survives reloads and never depends on model memory.
 */
export async function conversationContext(input: {
  conversationId: string;
  actorId: string;
  market: Market;
}): Promise<ConversationContext> {
  const sets = (await conversationSets(input.conversationId, input.market.id)).filter(live);
  const pendingSet = sets.find((set) => {
    const query = set.query as Partial<PendingQuery>;
    return query.kind === ACTION_KIND && query.ownerId === input.actorId && query.status === "PENDING";
  });
  const pending = pendingSet?.query as PendingQuery | undefined;
  const resultSet = sets.find((set) => isListingSet(set, input.actorId));
  const focus = await focusedResource(input.conversationId);
  const currentResource = focus?.resourceId ?? null;
  const selection = pending?.targetResource ?? currentResource;
  const pendingDefinition = pending ? ACTION_REGISTRY[pending.action] : undefined;
  const snapshot = selection ? await (pendingDefinition ? readFor(pendingDefinition) : readServerSnapshot)(input.actorId, selection) : undefined;
  const latestKind = (sets[0]?.query as { kind?: unknown } | undefined)?.kind;
  return {
    currentGoal: pending?.action ?? (typeof latestKind === "string" ? latestKind : sets[0] ? "SEARCH" : null),
    currentResource,
    currentResultSet: resultSet ? { id: resultSet.id, resourceIds: resultSet.resourceIds } : null,
    currentSelection: selection,
    knownFacts: { ...(pending?.structuredInput ?? {}), ...serverFacts(snapshot) },
    missingFacts: [],
    pendingAction: pending
      ? {
          actionId: pendingSet!.id,
          action: pending.action,
          targetResource: pending.targetResource,
          review: pending.review,
          expiresAt: pendingSet!.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
}
