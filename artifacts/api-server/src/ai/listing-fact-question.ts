/**
 * A question about a recorded fact of the listing in view («هذا الأول كم ماشي؟»).
 *
 * The answer comes from the listing record only. When the seller recorded nothing, DINAR
 * says so plainly and offers the existing inquiry review so the buyer can ask — the model
 * is never asked and no value is guessed. Detection is a rule about Arabic question words
 * and the mileage vocabulary, not about a product.
 */
import { and, eq } from "drizzle-orm";
import { db, offers } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import type { ToolResult } from "./tool-registry";
import { latestListingSet, normalizeBuyerText, notice } from "./buyer-turn";
import { draftListingQuestion } from "./inquiry-turn";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

const POSITIONS: Record<string, number> = {
  الاول: 1, اول: 1, الاولي: 1, الثاني: 2, ثاني: 2, الثانيه: 2, الثالث: 3, ثالث: 3, الثالثه: 3,
  الرابع: 4, الرابعه: 4, الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6,
};
const DEICTIC = /^(?:هذا|هذه|هذي|هال|هاي)$/u;
const MILEAGE_QUESTION =
  /(?:^|\s)(?:كم|قديش|قد\s+ايش|شكد)\s+(?:ال)?(?:ممشى|ممشي|ماشي|ماشيه|عداد|العداد|عدادها)(?:\s|$)/u;

function positionIn(words: string[]): number | undefined {
  for (const word of words) {
    const position = POSITIONS[word] ?? (/^\d{1,2}$/u.test(word) ? Number(word) : undefined);
    if (position !== undefined) return position;
  }
  return undefined;
}

function recordedMileage(attributes: unknown): number | undefined {
  if (!attributes || typeof attributes !== "object") return undefined;
  const value = (attributes as Record<string, unknown>).mileage;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^\d.]/gu, "")) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export async function executeListingFactQuestion(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  const { actorId } = input;
  if (!actorId) return null;
  const text = normalizeBuyerText(input.message);
  if (!MILEAGE_QUESTION.test(text)) return null;

  const set = await latestListingSet(input.conversationId, input.market.id);
  if (!set?.resourceIds.length) return null;
  const words = text.split(/\s+/u);
  const position = positionIn(words) ?? (words.some((word) => DEICTIC.test(word)) ? 1 : undefined);
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
  const mileage = recordedMileage(row.data.attributes);

  if (mileage !== undefined)
    return {
      tool: "listingFactQuestion",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "CLARIFY",
        query: {},
        listings: [],
        prompt: `ممشى «${title}» حسب سجل الإعلان: ${mileage.toLocaleString("en-US")} كم. هذه معلومة من الإعلان نفسه، ولم أفترض غيرها.`,
      },
    };

  return draftListingQuestion(
    { ...input, actorId },
    listingId,
    `كم ممشى «${title}»؟`,
    `لم يذكر البائع الممشى في إعلان «${title}». جهّزت سؤالًا للبائع:`,
  );
}
