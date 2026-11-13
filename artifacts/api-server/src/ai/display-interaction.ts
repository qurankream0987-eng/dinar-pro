/**
 * Phase 3 — working with what is on screen. The conversation's latest display decides what an
 * interaction applies to: product results (a stored result set) or the owner's business figures
 * (a server-composed display). Every operation re-reads canonical records under the actor's own
 * authority, never searches again, never reads a figure from model output, and never touches a
 * cart, order, listing or payment. A request that does not fit the active display is not applied.
 */
import { and, desc, eq } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, conversations, db } from "@workspace/db";
import { mergePresentation, type CardPresentation, type DisplayDirective } from "@workspace/api-zod/surface-composition";
import { composeBusinessDisplay, NOT_PROFIT_NOTE } from "./display-composer";
import type { DisplayInteraction } from "./display-preference";
import { normalizeSearch } from "./search-context";
import type { ToolResult } from "./tool-registry";

type Context = {
  conversationId: string;
  currentMessageId: string;
  message: string;
  market: Parameters<typeof import("./model-read-capabilities").readBusinessOverview>[0]["market"];
  actorId?: string;
};
type Turn = { tool: string; version: 1; result: ToolResult };

/** The latest display in this conversation: products (with their block layout) or business figures. */
export async function activeDisplay(conversationId: string): Promise<
  | { kind: "LISTINGS"; resultSetId: string; layout?: string; presentation?: CardPresentation }
  | { kind: "BUSINESS" }
  | { kind: "DRAFT"; payload: Record<string, any>; presentation?: CardPresentation }
  | undefined
> {
  const [latest] = await db
    .select({ blockType: aiUiBlocks.blockType, payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt), desc(aiUiBlocks.ordinal))
    .limit(1);
  if (!latest) return undefined;
  const payload = latest.payload as Record<string, any>;
  if (latest.blockType === "LISTING_RESULTS" && typeof payload.resultSetId === "string" && Array.isArray(payload.resourceIds) && payload.resourceIds.length)
    return { kind: "LISTINGS", resultSetId: payload.resultSetId, layout: payload.composition?.layout, presentation: payload.composition?.presentation };
  // The seller's open draft card (not yet published or cancelled): only its arrangement can change here.
  if (latest.blockType === "SURFACE" && payload.surface === "SELL" && payload.draft && payload.draftReview && !["published", "cancelled"].includes(String(payload.draftStep ?? "")))
    return { kind: "DRAFT", payload, presentation: payload.cardPresentation };
  if (latest.blockType === "SURFACE" && payload.displaySurface && payload.surface === "BUSINESS_INSIGHTS")
    return { kind: "BUSINESS" };
  return undefined;
}

const fmt = (minor: number, scale: number, currency: string) => `${(minor / 10 ** scale).toFixed(scale)} ${currency}`;
const MONTH = new Intl.DateTimeFormat("ar", { month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (month: string) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? month : MONTH.format(date);
};

/**
 * Applies an interaction to the active display. Returns null when there is no matching display
 * (the request then takes the ordinary path: the model or DINAR's own handlers).
 */
export async function applyDisplayInteraction(context: Context, interaction: DisplayInteraction): Promise<Turn | null> {
  if (!context.actorId) return null;
  const active = await activeDisplay(context.conversationId);
  if (!active) return null;
  if (active.kind === "LISTINGS") return listingInteraction(context, interaction, active);
  if (active.kind === "DRAFT") return draftInteraction(context, interaction, active);
  if (interaction.kind === "PRESENT") return null;
  return businessInteraction(context, interaction);
}

/**
 * «كبّر الصورة» on the seller's draft: the same draft card, re-shown with the new arrangement. The
 * conversation must be the actor's own; the draft, its review and its photos are the stored ones.
 */
async function draftInteraction(context: Context, interaction: DisplayInteraction, active: { payload: Record<string, any>; presentation?: CardPresentation }): Promise<Turn | null> {
  if (interaction.kind !== "PRESENT") return null;
  const [owner] = await db.select({ id: conversations.ownerUserId }).from(conversations).where(eq(conversations.id, context.conversationId));
  if (!owner || owner.id !== context.actorId) return null;
  const { payload } = active;
  return {
    tool: "openSurface",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "SELL",
      query: {},
      listings: [],
      draft: payload.draft,
      draftStep: payload.draftStep,
      draftReview: payload.draftReview,
      cardPresentation: mergePresentation(active.presentation, interaction.presentation),
      prompt: "هذه مسودتك نفسها بالترتيب الذي طلبته؛ لم يتغير أي حقل ولم يُنشر شيء.",
    } as ToolResult,
  };
}

async function listingInteraction(context: Context, interaction: DisplayInteraction, active: { resultSetId: string; layout?: string; presentation?: CardPresentation }): Promise<Turn | null> {
  if (interaction.kind === "ANALYZE") return null;
  const { executeRegisteredTool } = await import("./tool-registry");
  const tools = { conversationId: context.conversationId, market: context.market };
  let restored: ToolResult;
  try {
    restored = (await executeRegisteredTool("restoreResults", JSON.stringify({ resultSetId: active.resultSetId }), tools)).result;
  } catch {
    return null;
  }
  const presentation = interaction.kind === "PRESENT" ? mergePresentation(active.presentation, interaction.presentation) : active.presentation;
  const keepLayout = active.layout === "TABLE" || presentation
    ? { composition: { source: "MODEL_PROPOSAL" as const, layout: (active.layout === "TABLE" ? "TABLE" : active.layout ?? "CAROUSEL") as "TABLE" | "GRID" | "CAROUSEL" | "LIST", ...(presentation ? { presentation } : {}) } }
    : {};
  if (interaction.kind === "PRESENT")
    return {
      tool: "restoreResults",
      version: 1,
      result: { ...restored, ...keepLayout, query: { ...restored.query, buyer: { message: "هذه البطاقات نفسها بالترتيب الذي طلبته، دون بحث جديد ودون تغيير أي سعر أو تفصيل.", authority: "DINAR", display: true } } },
    };
  if (interaction.kind === "FORMAT") {
    const format = interaction.directive.format;
    if (format === "TABLE" || format === "CARDS")
      return {
        tool: "restoreResults",
        version: 1,
        result: {
          ...restored,
          ...(format === "TABLE" ? { composition: { source: "MODEL_PROPOSAL", layout: "TABLE", ...(presentation ? { presentation } : {}) } } : { composition: presentation ? { source: "MODEL_PROPOSAL", layout: "CAROUSEL", presentation } : undefined }),
          query: { ...restored.query, buyer: { message: format === "TABLE" ? "هذه النتائج نفسها كجدول، دون بحث جديد." : "رجعت النتائج نفسها كبطاقات.", authority: "DINAR", display: true } },
        },
      };
    return {
      tool: "restoreResults",
      version: 1,
      result: { ...restored, ...keepLayout, query: { ...restored.query, buyer: { message: "هذه نتائج عروض وليست أرقامًا عبر الزمن أو نسبًا من كل، فلا أرسمها كرسم بياني. يمكنني عرضها كجدول أو ترتيبها حسب السعر.", authority: "DINAR", display: true } } },
    };
  }
  // SORT and FILTER: the same records, reordered or narrowed, as a new derived result set so that
  // «الأول/الثاني/الأخير» afterwards mean what the user now sees. Nothing is searched again.
  let listings = [...restored.listings];
  let note: string;
  if (interaction.kind === "SORT") {
    const price = (listing: (typeof listings)[number]) => (listing.unitPrice === null ? undefined : Number(listing.unitPrice));
    listings.sort((a, b) => {
      const left = price(a);
      const right = price(b);
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1; // a price to agree is never treated as zero
      if (right === undefined) return -1;
      return interaction.direction === "ASC" ? left - right : right - left;
    });
    const unpriced = listings.filter((listing) => listing.unitPrice === null).length;
    note = `رتبت النتائج نفسها ${interaction.direction === "ASC" ? "من الأرخص إلى الأغلى" : "من الأغلى إلى الأرخص"}${unpriced ? `؛ ${unpriced === 1 ? "عرض سعره بالاتفاق في آخر القائمة" : "العروض التي سعرها بالاتفاق في آخر القائمة"}` : ""}. «الأول» و«الثاني» تعني الآن هذا الترتيب.`;
  } else if ("city" in interaction) {
    // City names are compared after the same Arabic folding as search («عمّان» = «عمان», «الزرقاء» = «زرقاء»).
    const fold = (value: string) => normalizeSearch(value).replace(/^ال/u, "");
    const wanted = fold(interaction.city);
    const before = listings.length;
    listings = listings.filter((listing) => fold(String(listing.city ?? "")) === wanted);
    if (!listings.length)
      return { tool: "restoreResults", version: 1, result: { ...restored, ...keepLayout, query: { ...restored.query, buyer: { message: `لا يوجد بين النتائج الحالية عرض في «${interaction.city}». أبقيت النتائج كما هي؛ يمكنك طلب بحث جديد في هذه المدينة.`, authority: "DINAR", display: true } } } };
    note = `أبقيت ${listings.length} من ${before} عروض في «${interaction.city}»، دون بحث جديد.`;
  } else {
    const available = (listing: (typeof listings)[number]) =>
      listing.inventoryMode === "UNLIMITED" || (listing.availableQuantity ?? 0) - (listing.reservedQuantity ?? 0) > 0;
    const before = listings.length;
    listings = listings.filter(available);
    if (!listings.length) return { tool: "restoreResults", version: 1, result: { ...restored, ...keepLayout, query: { ...restored.query, buyer: { message: "لا يوجد عرض متوفر الآن بين هذه النتائج؛ أبقيتها كما هي.", authority: "DINAR", display: true } } } };
    note = before === listings.length ? "كل هذه النتائج متوفرة الآن." : `أبقيت ${listings.length} من ${before} عروض متوفرة الآن.`;
  }
  return {
    tool: "searchListings",
    version: 1,
    result: {
      kind: "SEARCH",
      query: { ...restored.query, derivedFrom: active.resultSetId, displayOperation: interaction.kind === "SORT" ? `SORT_PRICE_${interaction.direction}` : "city" in interaction ? "FILTER_CITY" : "FILTER_AVAILABLE", buyer: { message: note, authority: "DINAR", display: true } },
      listings,
      ...keepLayout,
    },
  };
}

async function businessInteraction(context: Context, interaction: DisplayInteraction): Promise<Turn | null> {
  if (interaction.kind === "SORT" || interaction.kind === "FILTER" || interaction.kind === "PRESENT") return null;
  const { readBusinessOverview } = await import("./model-read-capabilities");
  // A fresh read under this actor's own authority: figures are never carried over from the old card.
  const read = await readBusinessOverview({ conversationId: context.conversationId, currentMessageId: context.currentMessageId, market: context.market, actorId: context.actorId } as any);
  const overview = read.businessOverview;
  if (interaction.kind === "FORMAT") {
    const directive: DisplayDirective = { ...interaction.directive, scope: "THIS_TURN" };
    const display = composeBusinessDisplay(directive, overview);
    return { tool: "readBusinessOverview", version: 1, result: { ...read, ...(display.surface ? { displaySurface: display.surface } : {}), prompt: display.notice ?? "هذه أرقامك نفسها من سجلات جاسم بالشكل الذي طلبته." } as ToolResult };
  }
  const business = [...(overview?.businesses ?? [])].filter((entry) => entry.analytics?.monthly).sort((a, b) => (b.analytics!.completedOrders ?? 0) - (a.analytics!.completedOrders ?? 0))[0];
  const analytics = business?.analytics;
  if (!analytics?.monthly?.length || analytics.minorUnitScale === undefined)
    return { tool: "readBusinessOverview", version: 1, result: { ...read, prompt: "لا تتوفر أرقام مبيعات شهرية لهذا النشاط حتى أحسب منها." } as ToolResult };
  const scale = analytics.minorUnitScale;
  const currency = analytics.currency;
  const months = analytics.monthly;
  const answer = monthAnalysis(interaction.op, months, scale, currency);
  const display = composeBusinessDisplay({ version: 1, format: "TABLE", scope: "THIS_TURN" }, overview);
  return { tool: "readBusinessOverview", version: 1, result: { ...read, ...(display.surface ? { displaySurface: display.surface } : {}), prompt: `${answer}\n\n${NOT_PROFIT_NOTE}` } as ToolResult };
}

/**
 * Deterministic arithmetic over the server's monthly integers (minor units). Ties go to the
 * earliest month; a window without any completed order says so instead of naming a «best» month.
 */
export function monthAnalysis(op: "MAX" | "MIN" | "MAX_VS_MIN" | "LAST_VS_PREVIOUS", months: { month: string; completedOrders: number; revenueMinor: number }[], scale: number, currency: string): string {
  if (!months.some((row) => row.completedOrders > 0)) return "لا توجد طلبات مكتملة في الأشهر المعروضة، فلا يوجد شهر أعلى أو أقل.";
  const max = months.reduce((best, row) => (row.revenueMinor > best.revenueMinor ? row : best), months[0]!);
  const min = months.reduce((low, row) => (row.revenueMinor < low.revenueMinor ? row : low), months[0]!);
  const line = (row: { month: string; revenueMinor: number; completedOrders: number }) => `${monthName(row.month)}: ${fmt(row.revenueMinor, scale, currency)} من ${row.completedOrders} ${row.completedOrders === 1 ? "طلب مكتمل" : "طلبات مكتملة"}`;
  if (op === "MAX") return `الشهر الأعلى إيرادًا مكتملًا هو ${line(max)}.`;
  if (op === "MIN") return `الشهر الأقل إيرادًا مكتملًا هو ${line(min)}.`;
  if (op === "MAX_VS_MIN") return `الأعلى ${line(max)}، والأقل ${line(min)}؛ الفرق ${fmt(max.revenueMinor - min.revenueMinor, scale, currency)}.`;
  const last = months.at(-1)!;
  const previous = months.at(-2);
  if (!previous) return `لا يوجد شهر سابق في الفترة المعروضة للمقارنة مع ${monthName(last.month)}.`;
  const diff = last.revenueMinor - previous.revenueMinor;
  const pct = previous.revenueMinor > 0 ? ` (${diff >= 0 ? "+" : ""}${((diff / previous.revenueMinor) * 100).toFixed(1)}٪)` : "";
  return `${line(last)}، مقابل ${line(previous)}؛ ${diff === 0 ? "لا تغيير" : diff > 0 ? `زيادة ${fmt(diff, scale, currency)}` : `انخفاض ${fmt(-diff, scale, currency)}`}${pct}. هذه أرقام السجلات فقط؛ أسباب التغير لا تظهر فيها.`;
}

const ORDINAL_WORDS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];

/**
 * «افتح الأرخص», «ضيف الأغلى للسلة»: an action on the cheapest or priciest item *of the active
 * display* is rewritten as the ordinal of that item in the order the user sees, so the existing
 * open/add handlers (and their reviews) resolve it. Prices are the live records; an item whose
 * price is agreed is never «the cheapest». Ties keep the displayed order. Returns undefined when
 * there is no active product display or no priced item.
 */
export async function superlativeAsOrdinal(context: Context, normalized: string): Promise<string | undefined> {
  const match = normalized.match(/^((?:افتح|ضيف|اضف|حط|اختار|اختر|خذ))(?:\s+لي)?\s+(?:ال)?(ارخص|اغلي)(?:\s+(?:واحد|وحده|منهم|فيهم|بينهم))?((?:\s+\S+){0,3})$/u);
  // «أبي الأرخص فقط» is a ranking preference (buyer-turn), not an action on one item.
  if (!match || !context.actorId || /(?:^|\s)(?:فقط|بس)(?=\s|$)/u.test(match[3] ?? "")) return undefined;
  const active = await activeDisplay(context.conversationId);
  if (active?.kind !== "LISTINGS") return undefined;
  const [stored] = await db.select({ ids: aiResultSets.resourceIds }).from(aiResultSets).where(and(eq(aiResultSets.id, active.resultSetId), eq(aiResultSets.conversationId, context.conversationId)));
  if (!stored?.ids?.length) return undefined;
  const { executeRegisteredTool } = await import("./tool-registry");
  let listings: ToolResult["listings"];
  try {
    listings = (await executeRegisteredTool("restoreResults", JSON.stringify({ resultSetId: active.resultSetId }), { conversationId: context.conversationId, market: context.market })).result.listings;
  } catch {
    return undefined;
  }
  const priced = listings.map((listing, index) => ({ index, price: listing.unitPrice === null ? undefined : Number(listing.unitPrice) })).filter((entry) => entry.price !== undefined && Number.isFinite(entry.price));
  if (!priced.length) return undefined;
  const pick = priced.reduce((best, entry) => (match[2] === "ارخص" ? entry.price! < best.price! : entry.price! > best.price!) ? entry : best, priced[0]!);
  const ordinal = ORDINAL_WORDS[pick.index];
  if (!ordinal) return undefined;
  return `${match[1]} ${ordinal}${match[3] ?? ""}`.trim();
}
