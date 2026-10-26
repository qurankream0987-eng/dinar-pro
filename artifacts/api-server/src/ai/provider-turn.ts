/**
 * G1 — provider connections inside the shared DINAR conversation runtime.
 *
 * Deterministic phrases only, no model: «أريد أربط متجري» opens a typed connection
 * review (name, market, scopes, what it can and cannot do); «نعم» creates it through
 * the F0 action foundation. The key itself never enters the conversation: the secret
 * surface only offers a button whose HTTP response carries the key once, so no message,
 * block or result set ever stores it. «اعرض روابط الربط», «بدل المفتاح» and «أوقف الربط»
 * read or change only the actor's own connections through lib/provider-connections.
 */
import { and, desc, eq } from "drizzle-orm";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, db, users } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import {
  DEFAULT_PROVIDER_SCOPES,
  PROVIDER_LIMITS,
  PROVIDER_SCOPE_LABELS,
  type ProviderConnectionView,
  type ProviderScope,
  listProviderConnections,
  normalizeConnectionName,
} from "../lib/provider-connections";
import { type ActionReview, confirmPendingAction, createPendingAction, proposeAction } from "./action-foundation";
import { normalizeDigits } from "./arabic-normalization";
import { normalizeSearch } from "./search-context";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

export const PROVIDER_SURFACES = CONVERSATION_SURFACE_FAMILIES.provider;
const PROVIDER_ACTIONS = ["CREATE_PROVIDER_CONNECTION", "ROTATE_PROVIDER_CREDENTIAL", "REVOKE_PROVIDER_CONNECTION"];
export const PROVIDER_SECRET_WARNING = "احفظ المفتاح الآن، لن نعرضه كاملًا مرة أخرى.";

const text = (message: string) =>
  normalizeDigits(normalizeSearch(message)).replace(/[؟?!،,.«»"]+/g, " ").replace(/\s+/g, " ").trim();

const CREATE =
  /(?:^|\s)(?:اربط|ربط|وصل|اوصل)\s+(?:متجري|نظامي|محلي|متجر|نظام)(?:\s|$)|(?:^|\s)مفتاح\s+(?:api|ربط|الربط|واجه[ةه])(?:\s|$)|(?:^|\s)api\s*key(?:\s|$)/u;
const STATUS = /(?:اعرض|عرض|وريني|افتح)\s+(?:روابط|الروابط|ربط|الربط)|(?:ما\s+|شو\s+)?حال[ةه]\s+(?:الربط|الروابط)|^روابط\s+الربط$/u;
const ROTATE = /^(?:بدل|غير|جدد)\s+(?:ال)?مفتاح(?:\s+(?:ال)?ربط)?(?:\s+(?:رقم\s+)?(\d{1,2}))?$/u;
const REVOKE = /^(?:اوقف|الغ|الغي|افصل)\s+(?:ال)?ربط(?:\s+(?:رقم\s+)?(\d{1,2}))?$/u;
const RENAME = /^(?:سم|سمي|سميه|سمه|الاسم|اسم\s+الربط|غير\s+الاسم\s+(?:الي|ل))\s+(.{1,80})$/u;

export function isExplicitProviderManagementIntent(message: string): boolean {
  const said = text(message);
  return CREATE.test(said) || STATUS.test(said) || ROTATE.test(said) || REVOKE.test(said);
}
/** The same command words on the raw message, so the new name keeps its own spelling. */
const RENAME_PREFIX = /^(?:س[ّ]?م[ّ]?(?:ي|ه|يه)?|الاسم|اسم\s+الربط|غي[ّ]?ر\s+الاسم\s+(?:إلى|الى|ل))\s+/u;
const WITH_DRIVERS = /(?:مع|و)\s*(?:ربط\s+)?(?:ال)?سائقين/u;
const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|انشئ|انشئه|نعم انشئ)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|تراجع|لا تنشئ)$/u;

function turn(surface: (typeof PROVIDER_SURFACES)[number], prompt: string, provider: Record<string, unknown>, resultSetId?: string): Turn {
  return {
    tool: "providerConnection",
    version: 1,
    result: { kind: "SURFACE", surface, query: { kind: "PROVIDER" }, listings: [], prompt, provider, ...(resultSetId ? { resultSetId } : {}) },
  };
}

const scopeView = (scopes: readonly string[]) =>
  scopes.map((scope) => ({ scope, label: PROVIDER_SCOPE_LABELS[scope as ProviderScope] ?? scope }));

function reviewTurn(market: Market, review: ActionReview, details: Record<string, unknown>, prompt: string): Turn {
  return turn("PROVIDER_CONNECTION_REVIEW", prompt, {
    view: "REVIEW",
    review: { actionId: review.actionId, action: review.action, lines: review.lines, expiresAt: review.expiresAt },
    marketId: market.id,
    limits: PROVIDER_LIMITS,
    ...details,
  }, review.actionId);
}

async function statusTurn(actorId: string, prompt?: string): Promise<Turn> {
  const connections = await listProviderConnections(actorId);
  return turn(
    "PROVIDER_STATUS",
    prompt ??
      (connections.length
        ? `لديك ${connections.length} ${connections.length === 1 ? "ربط" : "روابط"}. لا يُعرض المفتاح الكامل هنا أبدًا.`
        : "لا توجد روابط أنظمة بعد. يمكنك بيع منتجاتك مباشرة من المحادثة دون أي ربط، أو قل «أريد أربط متجري» لربط نظامك."),
    { view: "STATUS", connections: connections.map(statusRow), limits: PROVIDER_LIMITS },
  );
}

const statusRow = (connection: ProviderConnectionView) => ({ ...connection, scopes: scopeView(connection.scopes) });

async function createReview(input: { conversationId: string; market: Market; actorId: string }, name: string, scopes: ProviderScope[], lead = "") {
  const review = await createPendingAction({
    conversationId: input.conversationId,
    actorId: input.actorId,
    market: input.market,
    proposal: proposeAction({
      action: "CREATE_PROVIDER_CONNECTION",
      targetResource: input.actorId,
      facts: { name: [{ value: name, source: "USER_DECLARED" }], scopes: [{ value: scopes, source: "DINAR_DERIVED" }] },
    }),
  });
  return reviewTurn(input.market, review, { name, scopes: scopeView(scopes) },
    `${lead}راجع الربط قبل إنشائه: «${name}» في سوق ${input.market.id}. اكتب «نعم» للإنشاء، أو «سمّه …» لتغيير الاسم، أو «لا» للإلغاء. لن يظهر أي مفتاح قبل تأكيدك.`);
}

async function chooseConnection(actorId: string, index: string | undefined) {
  const active = (await listProviderConnections(actorId)).filter((connection) => connection.status === "ACTIVE");
  if (index !== undefined) return { chosen: active[Number(index) - 1], active };
  return { chosen: active.length === 1 ? active[0] : undefined, active };
}

/**
 * Claims explicit provider phrases and decisions on the actor's own provider review.
 * Everything else passes on unchanged.
 */
export async function executeProviderTurn(input: { conversationId: string; message: string; market: Market; actorId?: string }): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const said = text(input.message);
  const context = { conversationId: input.conversationId, market: input.market, actorId };

  const [latestSet] = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, input.conversationId), eq(aiResultSets.marketId, input.market.id)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const pending = latestSet?.query as
    | { kind?: unknown; ownerId?: unknown; status?: unknown; action?: unknown; targetResource?: unknown; structuredInput?: Record<string, { value: unknown }> }
    | undefined;
  const [latestBlock] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, input.conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const reviewOpen =
    pending?.kind === "ACTION" && pending.ownerId === actorId && pending.status === "PENDING" &&
    PROVIDER_ACTIONS.includes(String(pending.action)) && latestBlock?.payload.resultSetId === latestSet!.id;

  // ── Decisions and edits on the actor's own provider review.
  if (reviewOpen) {
    const action = String(pending!.action);
    const rename = action === "CREATE_PROVIDER_CONNECTION" ? RENAME.exec(said) : null;
    if (rename || (action === "CREATE_PROVIDER_CONNECTION" && WITH_DRIVERS.test(said) && !CONFIRM.test(said))) {
      const previousName = String(pending!.structuredInput?.name?.value ?? "");
      const previousScopes = (pending!.structuredInput?.scopes?.value as ProviderScope[] | undefined) ?? [...DEFAULT_PROVIDER_SCOPES];
      const name = rename ? normalizeConnectionName(input.message.trim().replace(RENAME_PREFIX, "")) : previousName;
      const scopes = WITH_DRIVERS.test(said) ? [...new Set<ProviderScope>([...previousScopes, "drivers:link"])] : previousScopes;
      await confirmPendingAction({ actionId: latestSet!.id, actorId, market: input.market, decision: "CANCEL" });
      return createReview(context, name, scopes, "عدّلت المراجعة. ");
    }
    if (CONFIRM.test(said) || CANCEL.test(said)) {
      const outcome = await confirmPendingAction({ actionId: latestSet!.id, actorId, market: input.market, decision: CANCEL.test(said) ? "CANCEL" : "CONFIRM" });
      if (outcome.status === "CANCELLED") return statusTurn(actorId, "أُلغي الطلب؛ لم يتغير شيء ولم يُنشأ أي مفتاح.");
      if (outcome.status === "REVIEW_REQUIRED")
        return reviewTurn(input.market, outcome.review, {}, "تغيّرت البيانات منذ المراجعة. راجع التفاصيل ثم اكتب «نعم».");
      if (outcome.status !== "CONFIRMED") return statusTurn(actorId, outcome.message);
      const connectionId = String(outcome.result?.connectionId ?? "");
      const [connection] = await listProviderConnections(actorId, [connectionId]);
      if (action === "REVOKE_PROVIDER_CONNECTION")
        return statusTurn(
          actorId,
          `أوقفت الربط «${connection?.name ?? ""}»: لم يعد مفتاحه يعمل، وتوقفت ${Number(outcome.result?.pausedListings ?? 0)} من عروضه المنشورة مؤقتًا وبقيت لك لإدارتها. الطلبات والسجلات محفوظة.`,
        );
      return turn(
        "PROVIDER_SECRET_ONCE",
        action === "ROTATE_PROVIDER_CREDENTIAL"
          ? `توقف المفتاح السابق للربط «${connection?.name ?? ""}». اضغط «إنشاء المفتاح وعرضه» لإصدار المفتاح الجديد. ${PROVIDER_SECRET_WARNING}`
          : `أنشأت الربط «${connection?.name ?? ""}» في سوق ${input.market.id}. اضغط «إنشاء المفتاح وعرضه» لإصدار مفتاحه. ${PROVIDER_SECRET_WARNING}`,
        { view: "SECRET_ONCE", connection: connection ? statusRow(connection) : null, warning: PROVIDER_SECRET_WARNING },
      );
    }
  }

  // ── «أريد أربط متجري» / «أريد مفتاح API»: review first, nothing is created yet.
  if (CREATE.test(said) && !/سائق/u.test(said.replace(WITH_DRIVERS, ""))) {
    const [owner] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, actorId));
    const scopes: ProviderScope[] = WITH_DRIVERS.test(said) ? [...DEFAULT_PROVIDER_SCOPES, "drivers:link"] : [...DEFAULT_PROVIDER_SCOPES];
    try {
      return await createReview(context, normalizeConnectionName(`ربط ${owner?.displayName ?? "المتجر"}`.slice(0, 80)), scopes);
    } catch (error) {
      return statusTurn(actorId, `${(error as Error).message}. لم يتغير شيء.`);
    }
  }

  if (STATUS.test(said)) return statusTurn(actorId);

  const rotate = ROTATE.exec(said);
  const revoke = rotate ? null : REVOKE.exec(said);
  if (rotate || revoke) {
    const { chosen, active } = await chooseConnection(actorId, (rotate ?? revoke)![1]);
    if (!active.length) return statusTurn(actorId, "لا يوجد ربط نشط لديك؛ لم يتغير شيء.");
    if (!chosen)
      return statusTurn(actorId, `لديك ${active.length} روابط نشطة. حدّد الرقم، مثل «${rotate ? "بدل المفتاح" : "أوقف الربط"} 1».`);
    try {
      const review = await createPendingAction({
        conversationId: input.conversationId,
        actorId,
        market: input.market,
        proposal: proposeAction({ action: rotate ? "ROTATE_PROVIDER_CREDENTIAL" : "REVOKE_PROVIDER_CONNECTION", targetResource: chosen.id }),
      });
      return reviewTurn(input.market, review, { name: chosen.name, connection: statusRow(chosen) },
        rotate
          ? `هل تريد تبديل مفتاح الربط «${chosen.name}»؟ يتوقف المفتاح الحالي فور التأكيد. اكتب «نعم» أو «لا».`
          : `هل تريد إيقاف الربط «${chosen.name}»؟ اكتب «نعم» أو «لا».`);
    } catch (error) {
      return statusTurn(actorId, `${(error as Error).message}. لم يتغير شيء.`);
    }
  }
  return null;
}
