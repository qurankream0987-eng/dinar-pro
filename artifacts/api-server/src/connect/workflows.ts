/**
 * Jassim Connect — multi-company workflows.
 *
 * «Order the sofa from store A, then book its installation with company B for the delivery date».
 * A workflow is an ordered plan (at most four steps) of tools the person may use (Business AI
 * rules), possibly at different companies. The person confirms the WHOLE plan once, after seeing
 * every store and everything that will be sent. Steps then run in order; each is re-decided by the
 * binding law at that moment; a later step may take a scalar value from an earlier step's answer
 * (`{ "$from": { "step": 0, "pointer": "/bookingId" } }`). The first failure stops the plan and the
 * outcome is recorded honestly — a step that already succeeded is reported as done, never hidden.
 *
 *   NO_STEP_BEFORE_CONFIRMATION · STEP_ORDER_IS_THE_PLAN_ORDER · PARTIAL_IS_SAID_ALOUD
 *   Provider answers are untrusted: only scalar values (≤ 200 chars) may flow into a later step,
 *   and they are validated against that step's own schema before anything is sent.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { businessProfiles, connectIntegrations, connectPartners, connectTools, connectWorkflows, db } from "@workspace/db";
import { ConnectNetwork } from "./network";
import { connectError } from "./provider-registry";
import { connectAudit, type ConnectMarket } from "./partners";
import { decideToolUse } from "./binding";
import { executeConnectOperation, toolRoleFor, validateArguments } from "./api-connector";
import { readPointer } from "./tool-cards";

const MAX_STEPS = 4;
const TTL_MS = 10 * 60_000;
const WORKFLOWS_PER_HOUR = 5;

const pointer = z.string().max(200).regex(/^(?:\/[^/~]*(?:~[01][^/~]*)*)+$/);
const StepInput = z.object({ toolId: z.string().uuid(), arguments: z.record(z.string().max(64), z.unknown()).default({}) }).strict();
export const WorkflowInput = z.object({ steps: z.array(StepInput).min(2).max(MAX_STEPS) }).strict();

type FromRef = { step: number; pointer: string };
function isFrom(value: unknown): value is { $from: FromRef } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 1 && "$from" in (value as object));
}

/** Every `$from` must point to an EARLIER step with a valid pointer. Returns the referenced steps. */
function checkReferences(value: unknown, index: number, depth = 0): void {
  if (depth > 8) throw connectError(400, "WORKFLOW_INVALID", "خطة غير صالحة");
  if (isFrom(value)) {
    const ref = z.object({ step: z.number().int().min(0), pointer }).strict().safeParse(value.$from);
    if (!ref.success || ref.data.step >= index) throw connectError(400, "WORKFLOW_INVALID", "كل قيمة منقولة تأتي من خطوة سابقة فقط");
    return;
  }
  if (Array.isArray(value)) value.forEach((item) => checkReferences(item, index, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => checkReferences(item, index, depth + 1));
}
function hasReferences(value: unknown): boolean {
  if (isFrom(value)) return true;
  if (Array.isArray(value)) return value.some(hasReferences);
  if (value && typeof value === "object") return Object.values(value).some(hasReferences);
  return false;
}
/** Replaces references with scalar values from earlier answers; refuses objects or long text. */
export function resolveReferences(value: unknown, answers: readonly unknown[], depth = 0): unknown {
  if (depth > 8) throw connectError(400, "WORKFLOW_INVALID", "خطة غير صالحة");
  if (isFrom(value)) {
    const resolved = readPointer(answers[value.$from.step], value.$from.pointer);
    if (!((typeof resolved === "string" && resolved.length <= 200) || (typeof resolved === "number" && Number.isFinite(resolved)) || typeof resolved === "boolean"))
      throw connectError(409, "WORKFLOW_VALUE_MISSING", "لم تُرجع خطوة سابقة القيمة المطلوبة");
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, answers, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, answers, depth + 1)]));
  return value;
}

async function loadStep(toolId: string) {
  const [row] = await db
    .select({ tool: connectTools, integration: connectIntegrations, store: businessProfiles.displayName })
    .from(connectTools)
    .innerJoin(connectIntegrations, eq(connectIntegrations.id, connectTools.integrationId))
    .innerJoin(connectPartners, eq(connectPartners.id, connectIntegrations.partnerId))
    .innerJoin(businessProfiles, eq(businessProfiles.id, connectPartners.businessId))
    .where(eq(connectTools.id, toolId));
  return row;
}

export type WorkflowSummary = {
  workflowId: string;
  expiresAt: string;
  steps: { index: number; store: string; tool: string; capability: string; access: string; arguments: unknown }[];
  note: string;
};

/** Proposal: validated, stored PENDING, nothing sent. The person sees every store and value. */
export async function proposeConnectWorkflow(input: { actorId: string; market: ConnectMarket; raw: unknown }): Promise<WorkflowSummary> {
  const plan = WorkflowInput.parse(input.raw);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(connectWorkflows)
    .where(and(eq(connectWorkflows.actorId, input.actorId), gt(connectWorkflows.createdAt, new Date(Date.now() - 60 * 60_000))));
  if ((recent?.n ?? 0) >= WORKFLOWS_PER_HOUR) throw connectError(429, "RATE_LIMITED", "تجاوزت عدد الخطط المسموح خلال ساعة");
  const steps: WorkflowSummary["steps"] = [];
  for (const [index, step] of plan.steps.entries()) {
    const row = await loadStep(step.toolId);
    if (!row || !row.tool.operation || !(await toolRoleFor(input.actorId, input.market, row.integration, row.tool))) throw connectError(404, "NOT_FOUND", "إحدى الخدمات غير متاحة لك");
    checkReferences(step.arguments, index);
    // Literal steps are validated now; steps that take values from earlier answers at run time.
    if (!hasReferences(step.arguments)) validateArguments((row.tool.operation as { inputSchema: Parameters<typeof validateArguments>[0] }).inputSchema, step.arguments);
    steps.push({ index, store: row.store.slice(0, 120), tool: row.tool.name, capability: row.tool.capability, access: row.tool.access, arguments: step.arguments });
  }
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(connectWorkflows).values({ id, actorId: input.actorId, marketId: input.market.id, steps: plan.steps, expiresAt });
  return {
    workflowId: id,
    expiresAt: expiresAt.toISOString(),
    steps,
    note: "عند التأكيد تُنفّذ الخطوات بالترتيب، وتُرسل لكل متجر بياناته فقط وفق شروطه. إن فشلت خطوة تتوقف الخطة، ونخبرك بما تم وما لم يتم.",
  };
}

export type WorkflowOutcome = {
  workflowId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  steps: { index: number; store: string; tool: string; status: "SUCCEEDED" | "FAILED" | "SKIPPED"; providerStatus?: number; reason?: string }[];
};

/** The person's single confirmation: runs once, in order, stopping at the first failure. */
export async function confirmConnectWorkflow(input: { actorId: string; market: ConnectMarket; workflowId: string; network?: ConnectNetwork; live?: boolean }): Promise<WorkflowOutcome> {
  const now = new Date();
  const [claimed] = await db
    .update(connectWorkflows)
    .set({ status: "RUNNING", startedAt: now })
    .where(and(eq(connectWorkflows.id, input.workflowId), eq(connectWorkflows.actorId, input.actorId), eq(connectWorkflows.marketId, input.market.id), eq(connectWorkflows.status, "PENDING"), gt(connectWorkflows.expiresAt, now)))
    .returning();
  if (!claimed) {
    const [seen] = await db.select({ actorId: connectWorkflows.actorId, status: connectWorkflows.status }).from(connectWorkflows).where(eq(connectWorkflows.id, input.workflowId));
    if (!seen || seen.actorId !== input.actorId) throw connectError(404, "NOT_FOUND", "الخطة غير موجودة");
    throw connectError(409, seen.status === "PENDING" ? "WORKFLOW_EXPIRED" : "WORKFLOW_ALREADY_USED", seen.status === "PENDING" ? "انتهت صلاحية الخطة؛ اطلبها من جديد" : "نُفّذت هذه الخطة أو أُلغيت من قبل");
  }
  const live = input.live ?? process.env.DINAR_CONNECT_LIVE_CALLS === "true";
  const network = input.network ?? new ConnectNetwork();
  const plan = WorkflowInput.parse({ steps: claimed.steps });
  const answers: unknown[] = [];
  const results: WorkflowOutcome["steps"] = [];
  let failed = false;
  for (const [index, step] of plan.steps.entries()) {
    const row = await loadStep(step.toolId);
    const label = { index, store: row?.store.slice(0, 120) ?? "", tool: row?.tool.name ?? "" };
    if (failed) { results.push({ ...label, status: "SKIPPED" }); continue; }
    try {
      if (!row?.tool.operation) throw connectError(409, "TOOL_NOT_AVAILABLE", "الخدمة غير متاحة");
      // The person and the opening of each tool are re-checked now, step by step.
      const role = await toolRoleFor(input.actorId, input.market, row.integration, row.tool);
      if (!role) throw connectError(409, "TOOL_NOT_AVAILABLE", "الخدمة لم تعد متاحة");
      const args = resolveReferences(step.arguments, answers) as Record<string, unknown>;
      validateArguments((row.tool.operation as { inputSchema: Parameters<typeof validateArguments>[0] }).inputSchema, args);
      const decision = decideToolUse({ binding: row.integration, tool: row.tool, presentedSchemaSha256: row.tool.inputSchemaSha256, confirmed: true, live });
      if (!decision.allowed) throw connectError(409, decision.refusal, "رفضت قواعد الربط هذه الخطوة");
      const executed = await executeConnectOperation(network, row.integration, row.tool, args, decision.access === "WRITE" ? `${claimed.id}:${index}` : undefined);
      answers[index] = executed.data;
      results.push({ ...label, status: "SUCCEEDED", providerStatus: executed.providerStatus });
      await connectAudit(db, row.integration.partnerId, input.actorId, role, "CONNECT_WORKFLOW_STEP", { workflowId: claimed.id, index, toolId: row.tool.id, status: "SUCCEEDED", providerStatus: executed.providerStatus });
    } catch (error) {
      failed = true;
      const reason = ((error as { code?: string }).code ?? "PROVIDER_ERROR").slice(0, 60);
      results.push({ ...label, status: "FAILED", reason });
      if (row) await connectAudit(db, row.integration.partnerId, input.actorId, "SYSTEM", "CONNECT_WORKFLOW_STEP", { workflowId: claimed.id, index, toolId: row.tool.id, status: "FAILED", reason });
    }
  }
  const succeeded = results.filter((step) => step.status === "SUCCEEDED").length;
  const status: WorkflowOutcome["status"] = !failed ? "COMPLETED" : succeeded ? "PARTIAL" : "FAILED";
  // Only statuses are kept; provider answers are not stored.
  await db.update(connectWorkflows).set({ status, results, finishedAt: new Date() }).where(eq(connectWorkflows.id, claimed.id));
  return { workflowId: claimed.id, status, steps: results };
}

export async function cancelConnectWorkflow(input: { actorId: string; workflowId: string }) {
  const [row] = await db
    .update(connectWorkflows)
    .set({ status: "CANCELLED" })
    .where(and(eq(connectWorkflows.id, input.workflowId), eq(connectWorkflows.actorId, input.actorId), eq(connectWorkflows.status, "PENDING")))
    .returning({ id: connectWorkflows.id });
  if (!row) throw connectError(404, "NOT_FOUND", "الخطة غير موجودة");
  return { workflowId: row.id, status: "CANCELLED" as const };
}
