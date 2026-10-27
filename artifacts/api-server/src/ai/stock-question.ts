/**
 * A stock question about the listing in view («كم المتبقي؟», «كم حبة باقي؟»,
 * «هل المنتج متوفر؟», «عندك كمية؟», «كم أقدر أطلب؟»).
 *
 * The answer is the inventory record the commerce engine already keeps: the available
 * quantity minus the reservations held by open orders. It is never the model, never a
 * guess and never a promise from the seller. The listing must be in view, in this market,
 * and published; anything else is stated as such without inventing availability. Asking is
 * read-only: it reserves nothing and drafts no inquiry. Detection is a rule about Arabic
 * stock phrasings, not about a product.
 */
import { and, eq } from "drizzle-orm";
import { db, offers } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import type { ToolResult } from "./tool-registry";
import { normalizeBuyerText } from "./buyer-turn";
import { focusedListing } from "./negotiation-turn";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

/** Question words, quantity nouns and generic listing words that name no product. */
const STOP = new Set([
  "كم", "قديش", "قد", "ايش", "شكد", "هل", "في", "فيه", "فيها", "يوجد", "موجود", "موجوده",
  "عندك", "عندكم", "عنك", "منه", "منها", "هذا", "هذه", "هذي", "هال", "هاي",
  "عرض", "اعلان", "منتج", "منتجك", "خدمه", "سلعه", "شي", "شيء", "شو",
  "كميه", "مخزون", "متوفر", "متوفره", "متاح", "متاحه", "متبقي", "متبقيه", "باقي", "باقيه",
  "حبه", "حبات", "قطعه", "قطع", "وحده", "وحدات", "نسخه", "نسخ",
  "اقدر", "بقدر", "يمكن", "ممكن", "اطلب", "اخذ", "اشتري", "ان", "على", "عن", "رقم",
  "بعد", "الان", "حاليا", "اكثر", "اقل", "تقريبا", "مزيد", "سعر", "سعره",
]);
const ORDINALS = new Set(["اول", "اولي", "ثاني", "ثالث", "رابع", "خامس", "سادس", "اخير"]);

/**
 * The shapes of a stock question. A leading request verb is not part of the shape, so a
 * search («أريد لابتوب متوفر») only reaches the resolver through its product words, which
 * the listing-in-view check refuses when they name something else.
 */
const STOCK_QUESTION = new RegExp(
  [
    // «كم المتبقي؟», «كم الكمية المتبقية؟», «قديش باقي؟», «كم متوفر عندك؟»
    String.raw`(?:^|\s)(?:كم|قديش|قد\s+ايش|شكد)\s+(?:ال)?(?:متبقي|متبقيه|باقي|باقيه|متوفر|متوفره|متاح|متاحه|موجود|موجوده|كميه|مخزون|كم)(?=\s|$)`,
    // «كم حبة باقي؟», «كم قطعة متوفرة؟»
    String.raw`(?:^|\s)(?:كم|قديش)\s+(?:حبه|حبات|قطعه|قطع|وحده|وحدات)\s+(?:باقي|باقيه|متبقي|متبقيه|متوفر|متوفره|متاح|متاحه)(?=\s|$)`,
    // «هل المنتج متوفر؟», «هل الخدمة متوفرة؟», «هل يوجد كمية؟»
    String.raw`(?:^|\s)هل\s+(?:\S+\s+){0,3}?(?:متوفر|متوفره|متاح|متاحه|موجود|موجوده|متبقي|متبقيه|باقي|باقيه|كميه|مخزون)(?=\s|$)`,
    // «عندك كمية؟», «في مخزون؟»
    String.raw`(?:^|\s)(?:عندك|عندكم|عنك|في|فيها)\s+(?:ال)?(?:كميه|مخزون|متوفر|متاح)(?=\s|$)`,
    // «كم أقدر أطلب؟», «كم يمكن أطلب؟», «كم أطلب؟»
    String.raw`(?:^|\s)(?:كم|قديش)\s+(?:(?:اقدر|بقدر|يمكن|ممكن)\s+(?:ان\s+)?)?(?:اطلب|اخذ|اشتري)(?=\s|$)`,
  ].join("|"),
  "u",
);

const stripArticle = (token: string) => (token.startsWith("ال") && token.length > 3 ? token.slice(2) : token);

/**
 * The words left after the stock phrasing and the generic words are removed. A named
 * product that the listing in view does not carry («هل يوجد لابتوب متوفر؟» while a bike
 * is in view) keeps the ordinary conversation/search path instead of answering about
 * the wrong listing.
 */
function namesAnotherProduct(text: string, title: string | undefined): boolean {
  const vocabulary = new Set(normalizeBuyerText(title ?? "").split(" ").map(stripArticle));
  return text
    .split(" ")
    .map(stripArticle)
    .some((token) => token && !STOP.has(token) && !ORDINALS.has(token) && !/^\d+$/u.test(token) && !vocabulary.has(token));
}

function clarify(prompt: string): Turn {
  return {
    tool: "stockQuestion",
    version: 1,
    result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt },
  };
}

const STATUS_MEANING: Record<string, string> = {
  PAUSED: "موقوف مؤقتًا من البائع",
  SOLD_OUT: "نفدت كميته",
  ARCHIVED: "مؤرشف",
  MODERATION_HIDDEN: "محجوب للمراجعة",
  MODERATION_REMOVED: "محجوب للمراجعة",
  DRAFT: "لم يُنشر بعد",
};

const WHICH_LISTING =
  "أي عرض تقصد؟ ابحث عن المنتج أو افتح الإعلان، ثم اسألني «كم المتبقي؟».";

export async function executeStockQuestion(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  const { actorId } = input;
  if (!actorId) return null;
  const text = normalizeBuyerText(input.message);
  if (!STOCK_QUESTION.test(text)) return null;

  const listingId = await focusedListing({
    conversationId: input.conversationId,
    market: input.market,
    actorId,
    message: input.message,
  });
  const [row] = listingId
    ? await db
        .select({
          data: offers.data,
          status: offers.status,
          inventoryMode: offers.inventoryMode,
          availableQuantity: offers.availableQuantity,
          reservedQuantity: offers.reservedQuantity,
        })
        .from(offers)
        .where(and(eq(offers.id, listingId), eq(offers.marketId, input.market.id)))
    : [];
  const title = typeof row?.data?.title === "string" ? row.data.title : undefined;
  if (namesAnotherProduct(text, title)) return null;
  if (listingId && !row)
    return clarify("لم أعد أجد هذا العرض في سوقك؛ ابحث عنه من جديد أو افتح إعلانًا آخر، ثم اسألني «كم المتبقي؟».");
  if (!listingId) return clarify(WHICH_LISTING);

  if (row.status !== "PUBLISHED")
    return clarify(
      `حسب سجل الإعلان، «${title ?? "الإعلان"}» غير متاح للشراء الآن لأنه ${STATUS_MEANING[row.status] ?? "غير معروض"}، فلا توجد كمية أستطيع تأكيدها.`,
    );

  if (row.inventoryMode !== "LIMITED")
    return clarify(
      `حسب سجل الإعلان، «${title ?? "الإعلان"}» معروض بكمية غير محدودة يحددها البائع، فلا يوجد رقم متبقٍ أعرضه؛ اسأل البائع إن أردت تأكيد التفاصيل.`,
    );

  const remaining = Math.max(0, (row.availableQuantity ?? 0) - (row.reservedQuantity ?? 0));
  const name = title ?? "الإعلان";
  if (remaining === 0)
    return clarify(
      `حسب سجل الإعلان، لا يوجد متاح الآن من «${name}»: الكمية المسجلة محجوزة كاملة في طلبات قائمة، فلا أستطيع تأكيد توفرها.`,
    );
  return clarify(
    `حسب سجل الإعلان، المتاح الآن من «${name}» ${remaining} ${remaining === 1 ? "قطعة" : "قطع"}. الرقم هو الكمية المسجلة ناقص المحجوز في طلبات قائمة، وليس وعدًا من البائع.`,
  );
}
