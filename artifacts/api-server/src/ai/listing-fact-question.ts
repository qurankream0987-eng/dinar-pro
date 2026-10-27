/**
 * A question about a recorded fact of the listing in view («هذا الأول كم ماشي؟»,
 * «هل تعمل 8 ساعات متواصلة؟»).
 *
 * The answer comes from the listing record only. When the seller recorded nothing, DINAR
 * says so plainly and offers the existing inquiry review so the buyer can ask — the model
 * is never asked and no value is guessed. Detection is a rule about Arabic question words
 * and spec vocabulary, not about a product. The fact table below is the whole list of facts
 * DINAR will answer this way; anything else keeps the ordinary conversation path.
 */
import { and, eq } from "drizzle-orm";
import { db, offers } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import type { ToolResult } from "./tool-registry";
import { latestListingSet, normalizeBuyerText, notice } from "./buyer-turn";
import { draftListingQuestion } from "./inquiry-turn";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

const ORDINALS: Record<string, number> = {
  الاول: 1, اول: 1, الاولي: 1, الثاني: 2, ثاني: 2, الثانيه: 2, الثالث: 3, ثالث: 3, الثالثه: 3,
  الرابع: 4, الرابعه: 4, الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6,
};
const DEICTIC = /^(?:هذا|هذه|هذي|هال|هاي)$/u;

const MILEAGE_QUESTION =
  /(?:^|\s)(?:كم|قديش|قد\s+ايش|شكد)\s+(?:ال)?(?:ممشى|ممشي|ماشي|ماشيه|عداد|العداد|عدادها)(?:\s|$)/u;
/** «هل تعمل 8 ساعات متواصلة؟», «هل تشتغل 8 ساعات؟», «كم ساعة تشتغل؟», «كم ساعات التشغيل؟». */
const OPERATING_HOURS_QUESTION =
  /(?:(?:^|\s)(?:هل\s+)?(?:تعمل|تشتغل|يعمل)\s+[\s\S]{0,40}?(?:ساعه|ساعات))|(?:(?:^|\s)(?:كم|قديش|شكد)\s+(?:ساعه|ساعات)\s+(?:ال)?(?:تشتغل|تعمل|تشغيل|عمل|متواصل|متواصله)(?:\s|$))/u;
/** «هل عليها فحص؟», «هل تم فحصها؟», «هل الفحص شامل؟» — a yes/no inspection question. */
const INSPECTION_QUESTION = /(?:^|\s)هل\s+[\s\S]{0,40}?(?:فحص|مفحوص|فاحص)/u;

/**
 * A bare number in a fact question is usually the spec itself («8 ساعات», «220 فولت»), so only
 * ordinal words name a position; a single listing in view needs no position at all.
 */
function positionIn(words: string[], count: number): number | undefined {
  for (const word of words) {
    const position = ORDINALS[word];
    if (position !== undefined) return position;
  }
  return count === 1 ? 1 : undefined;
}

function attributeValue(attributes: unknown, keys: readonly string[]): string | undefined {
  if (!attributes || typeof attributes !== "object") return undefined;
  const record = attributes as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value.toLocaleString("en-US");
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "boolean") return value ? "نعم" : "لا";
  }
  return undefined;
}

type Fact = {
  test: RegExp;
  /** The value the seller recorded, formatted for the reply; undefined when nothing was recorded. */
  read: (attributes: unknown) => string | undefined;
  missing: (title: string) => string;
  answer: (title: string, value: string) => string;
};

const FACTS: readonly Fact[] = [
  {
    test: MILEAGE_QUESTION,
    read: (attributes) => attributeValue(attributes, ["mileage"]),
    missing: (title) => `لم يذكر البائع الممشى في إعلان «${title}». جهّزت سؤالًا للبائع:`,
    answer: (title, value) =>
      `ممشى «${title}» حسب سجل الإعلان: ${value} كم. هذه معلومة من الإعلان نفسه، ولم أفترض غيرها.`,
  },
  {
    test: OPERATING_HOURS_QUESTION,
    read: (attributes) => attributeValue(attributes, ["operatingHours", "operating_hours"]),
    missing: (title) =>
      `لم يذكر البائع ساعات التشغيل المتواصل في إعلان «${title}»، فلا أستطيع تأكيدها. جهّزت سؤالًا للبائع:`,
    answer: (title, value) =>
      `ساعات التشغيل المتواصل حسب سجل الإعلان: ${value} ساعة. هذه معلومة من الإعلان نفسه، ولم أفترض غيرها.`,
  },
  {
    test: INSPECTION_QUESTION,
    read: (attributes) => attributeValue(attributes, ["inspection", "inspectionResult", "inspected"]),
    missing: (title) =>
      `لا يسجّل إعلان «${title}» نتيجة فحص، ولم يذكر البائع شيئًا عن الفحص، فلا أستطيع تأكيده. جهّزت سؤالًا للبائع:`,
    answer: (title, value) =>
      `ما يسجّله البائع عن الفحص في «${title}»: «${value}». هذه صياغة البائع، ولم أضف شروطًا من عندي.`,
  },
];

export async function executeListingFactQuestion(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  const { actorId } = input;
  if (!actorId) return null;
  const text = normalizeBuyerText(input.message);
  const fact = FACTS.find((candidate) => candidate.test.test(text));
  if (!fact) return null;

  const set = await latestListingSet(input.conversationId, input.market.id);
  if (!set?.resourceIds.length) return null;
  const position = positionIn(text.split(/\s+/u), set.resourceIds.length);
  if (position === undefined) return null;
  const listingId = set.resourceIds[position - 1];
  if (!listingId)
    return notice(`لا يوجد العرض رقم ${position} ضمن النتائج الحالية. اختر رقمًا ظاهرًا أو ابدأ بحثًا جديدًا.`);

  const [row] = await db
    .select({ data: offers.data })
    .from(offers)
    .where(and(eq(offers.id, listingId), eq(offers.marketId, input.market.id)));
  if (!row) return notice("هذا العرض لم يعد متاحًا؛ لم أجب من بيانات قديمة.");
  const title = typeof row.data.title === "string" ? row.data.title : "الإعلان";
  const value = fact.read(row.data.attributes);

  if (value !== undefined)
    return {
      tool: "listingFactQuestion",
      version: 1,
      result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt: fact.answer(title, value) },
    };

  const question = input.message.trim().replace(/[.؟!]+$/u, "");
  return draftListingQuestion(
    { ...input, actorId },
    listingId,
    `بخصوص «${title}»: ${question}؟`,
    fact.missing(title),
  );
}
