/**
 * Command A — bounded sequencing of compound requests («أبي أبيع طاولة، وبعدها ابحث لي عن كرسي»).
 *
 * A compound message is split on explicit sequencing words into at most MAX_STEPS steps.
 * Only the first step runs in the turn that asked for it; later steps are recorded on that
 * user message's metadata and run one per «التالي», each re-entering the ordinary runtime,
 * so authentication, market gates, reviews and confirmations apply exactly as if typed.
 * Nothing is executed implicitly: a step that is itself a confirmation is never queued, and
 * a plan is bound to the actor and market that created it.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, messages } from "@workspace/db";
import {
  CONVERSATION_ACTION_REGISTRY,
  type ConversationActionId,
} from "@workspace/api-zod/conversation-runtime";

export const MAX_STEPS = 3;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

export type TaskStepStatus = "DONE" | "PENDING" | "BLOCKED" | "FAILED" | "CANCELLED";
export type TaskStep = {
  index: number;
  text: string;
  intent: ConversationActionId;
  requiresConfirmation: boolean;
  status: TaskStepStatus;
  /** What actually happened: the tool and surface the runtime returned, never a claim. */
  result?: { tool: string; surface?: string };
  reason?: string;
};
export type TaskPlan = {
  version: 1;
  actorId: string;
  marketId: string;
  createdAt: string;
  steps: TaskStep[];
  /** Steps beyond MAX_STEPS are not silently dropped: the user is told. */
  truncated?: boolean;
};

// «وبعدها / وبعدين / بعد ذلك / ثم / and then» between two non-empty requests, and «وكمان /
// وأيضًا / and also» when it opens a new sentence («كم بقي من حصتي؟ وكمان اشرح لي …»).
const CONNECTOR =
  /\s*[،,]?\s*(?:^|\s)(?:و?بعدها|و?بعدين|و?بعد\s+(?:ذلك|كذا|هذا|هذي)|و?ثم|and\s+then|then)(?=\s)\s*|\s*[؟?.!،,]\s*(?:وكمان|وايضا|وأيضا|وأيضًا|وايضًا|and\s+also)(?=\s)\s*/iu;
const CONFIRMATION_ONLY =
  /^(?:نعم|ايه|إيه|أكيد|اكيد|أكد|اكد|موافق|تمام|اوكي|أوكي|ok|yes|نفذ|انشر(?:ه|ها)?|ادفع|اشتر(?:ه|يه)?|اقبل|وافق)$/iu;
const CONTINUE =
  /^(?:(?:يا\s+)?دينار\s+)?(?:التالي|الخطوه\s+التاليه|الخطوة\s+التالية|كمل\s+(?:الطلب|الخطوه|الخطوة)\s+(?:التالي|الثاني|التالية|التاليه)|نفذ\s+(?:التالي|الخطوه\s+التاليه|الخطوة\s+التالية)|next(?:\s+step)?)[.!؟?]*$/iu;
const CANCEL_PLAN =
  /^(?:الغ|الغي|ألغ|ألغي|الغاء|إلغاء)\s+(?:الخطوات|باقي\s+(?:الطلب|الخطوات)|الخطوات\s+الباقيه|الخطوات\s+الباقية)$/iu;

export function splitCompoundRequest(message: string): { steps: string[]; truncated: boolean } | undefined {
  const parts = message
    .split(CONNECTOR)
    .map((part) => part.replace(/^[\s،,.]+|[\s،,.]+$/gu, "").trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part.length < 2)) return undefined;
  return { steps: parts.slice(0, MAX_STEPS), truncated: parts.length > MAX_STEPS };
}

export const isPlanContinuation = (message: string) => CONTINUE.test(message.trim());
export const isPlanCancellation = (message: string) => CANCEL_PLAN.test(message.trim());

export function buildTaskPlan(input: {
  steps: string[];
  truncated: boolean;
  actorId: string;
  marketId: string;
  intentOf: (text: string) => ConversationActionId;
  now?: Date;
}): TaskPlan {
  return {
    version: 1,
    actorId: input.actorId,
    marketId: input.marketId,
    createdAt: (input.now ?? new Date()).toISOString(),
    ...(input.truncated ? { truncated: true } : {}),
    steps: input.steps.map((text, index) => {
      const intent = input.intentOf(text);
      const definition = CONVERSATION_ACTION_REGISTRY[intent];
      // A confirmation must answer a review the user has seen; it is never queued.
      const blocked = CONFIRMATION_ONLY.test(text.trim());
      return {
        index,
        text,
        intent,
        requiresConfirmation: definition.confirmationRequired,
        status: blocked ? "BLOCKED" : "PENDING",
        ...(blocked ? { reason: "CONFIRMATION_MUST_BE_EXPLICIT" } : {}),
      };
    }),
  };
}

export function nextPendingStep(plan: TaskPlan): TaskStep | undefined {
  return plan.steps.find((step) => step.status === "PENDING");
}

export function completeStep(plan: TaskPlan, index: number, result: TaskStep["result"]): TaskPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.index === index ? { ...step, status: "DONE", ...(result ? { result } : {}) } : step,
    ),
  };
}

export function failStep(plan: TaskPlan, index: number, reason: string): TaskPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.index === index ? { ...step, status: "FAILED", reason } : step)),
  };
}

export function cancelPending(plan: TaskPlan): TaskPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.status === "PENDING" ? { ...step, status: "CANCELLED" } : step)),
  };
}

function isTaskPlan(value: unknown): value is TaskPlan {
  const plan = value as TaskPlan | undefined;
  return Boolean(
    plan &&
      plan.version === 1 &&
      typeof plan.actorId === "string" &&
      typeof plan.marketId === "string" &&
      typeof plan.createdAt === "string" &&
      Array.isArray(plan.steps) &&
      plan.steps.length <= MAX_STEPS,
  );
}

/**
 * The newest plan recorded in this conversation by this actor. Only the latest plan is live:
 * a newer compound request supersedes an older one.
 */
export async function latestTaskPlan(
  conversationId: string,
  actorId: string,
  now = Date.now(),
): Promise<{ plan: TaskPlan; messageId: string } | undefined> {
  const rows = await db
    .select({ id: messages.id, metadata: messages.metadata, senderId: messages.senderId })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "USER")))
    .orderBy(desc(messages.createdAt))
    .limit(40);
  for (const row of rows) {
    const plan = (row.metadata as Record<string, unknown> | null)?.taskPlan;
    if (!isTaskPlan(plan)) continue;
    if (row.senderId !== actorId || plan.actorId !== actorId) return undefined;
    if (now - Date.parse(plan.createdAt) > PLAN_TTL_MS) return undefined;
    return { plan, messageId: row.id };
  }
  return undefined;
}

/** The plain-language status line appended to the assistant's reply. */
export function taskPlanNotice(plan: TaskPlan): string {
  const next = nextPendingStep(plan);
  const blocked = plan.steps.filter((step) => step.status === "BLOCKED");
  const lines: string[] = [];
  if (next) lines.push(`الخطوة التالية من طلبك: «${next.text}». قل «التالي» لأنفذها، أو «ألغ باقي الطلب».`);
  else if (plan.steps.every((step) => step.status !== "PENDING") && plan.steps.length > 1)
    lines.push("انتهت خطوات طلبك المركّب.");
  if (blocked.length)
    lines.push(`لم أضع «${blocked.map((step) => step.text).join("»، «")}» في الطابور: التأكيد يكون برسالة مستقلة بعد أن ترى المراجعة.`);
  if (plan.truncated) lines.push(`أتابع حتى ${MAX_STEPS} خطوات في الطلب الواحد؛ أرسل الباقي بعد ذلك.`);
  return lines.join("\n");
}
