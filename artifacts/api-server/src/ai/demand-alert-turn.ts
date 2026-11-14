/**
 * «نبّهني إذا توفر»: a buyer saves the latest search as a request that «جاسم روح بيع لي» campaigns
 * may match. Two explicit steps: the request shows exactly what will be stored, for how long and
 * who can see it; only the confirmation «أوافق على حفظ طلب التنبيه» saves it. Nothing is inferred
 * from the conversation beyond the search the buyer just ran.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { aiResultSets, db } from "@workspace/db";
import { DEMAND_REQUEST_DISCLOSURE, saveDemandRequest } from "../lib/demand-requests";
import { normalizeSearch } from "./search-context";
import type { ToolResult } from "./tool-registry";
import type { marketFor } from "../lib/markets";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: 1; result: ToolResult };
const ASK = /^(?:جاسم\s+)?(?:نبهني|بلغني|خبرني|ذكرني)\s+(?:اذا|لو|لما|متى)\s+(?:توفر|توفرت|نزل|نزلت|صار|انضاف|انضافت)/u;
export const DEMAND_ALERT_CONFIRM = "أوافق على حفظ طلب التنبيه";

async function latestSearch(conversationId: string, marketId: string) {
  const [row] = await db
    .select({ query: aiResultSets.query })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId), sql`coalesce(${aiResultSets.query} ->> 'kind', 'SEARCH') = 'SEARCH'`, sql`coalesce(${aiResultSets.query} ->> 'search', '') <> ''`))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const query = row?.query as { search?: string; categoryId?: string | null } | undefined;
  return query?.search ? { search: String(query.search).slice(0, 200), categoryId: query.categoryId ?? undefined } : undefined;
}

const advice = (prompt: string, options?: { label: string; message: string }[]): Turn => ({
  tool: "demandAlert",
  version: 1,
  result: { kind: "SURFACE", surface: "ADVICE", resultSetId: randomUUID(), query: {}, listings: [], prompt, advice: { kind: "CLARIFICATION_REQUIRED", scope: "DINAR_INTERNAL", topic: "DEMAND_ALERT", ...(options ? { options } : {}) } } as ToolResult,
});

export async function executeDemandAlertTurn(input: { conversationId: string; actorId?: string; market: Market; message: string }): Promise<Turn | null> {
  const text = normalizeSearch(input.message).replace(/[؟?!.،,]/gu, " ").trim();
  const confirming = normalizeSearch(input.message).trim() === normalizeSearch(DEMAND_ALERT_CONFIRM);
  if (!confirming && !ASK.test(text)) return null;
  if (!input.actorId) return advice("سجّل الدخول أولًا لأحفظ طلبك وأنبهك إذا توفر.");
  const search = await latestSearch(input.conversationId, input.market.id);
  if (!search) return advice("ابحث أولًا عمّا تريده، ثم اكتب «نبّهني إذا توفر» لأحفظ ذلك الطلب.");
  if (!confirming)
    return advice(`سأحفظ طلبك «${search.search}». ${DEMAND_REQUEST_DISCLOSURE}`, [
      { label: "نعم، احفظ طلبي", message: DEMAND_ALERT_CONFIRM },
      { label: "لا، شكرًا", message: "لا" },
    ]);
  const saved = await saveDemandRequest({ buyerId: input.actorId, market: input.market, needText: search.search, categoryId: search.categoryId, consent: true });
  const until = new Intl.DateTimeFormat("ar", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(saved.request.expiresAt));
  return advice(
    `حفظت طلبك «${saved.request.needText}» حتى ${until}. ${saved.notified ? "يوجد الآن عرض مناسب؛ ستجده في تنبيهاتك." : "سأنبهك داخل جاسم إذا ظهر عرض مناسب."} لن يرى أي بائع هويتك، ويمكنك حذف الطلب في أي وقت.`,
  );
}
