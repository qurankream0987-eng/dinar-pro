/**
 * Jassim Connect — Stage 2: the binding law, ported from the jassem runtime into dinar-pro.
 *
 *   CONNECTED  != VERIFIED            (a row or a link is not a working connection)
 *   SUPPORTED  != GRANTED             (what the provider can do is not what this business allowed)
 *   READ       != WRITE               (a read grant contains nothing of write)
 *   DISCOVERED_TOOL != AUTHORIZED_TOOL (a provider listing a tool authorizes nothing)
 *   MODEL      != SECRET STORE        (no credential, endpoint or raw schema reaches the model)
 *   PROVIDER_WRITE_PERMISSION != JASSIM_ACTION_AUTHORITY (every write needs the person's confirmation)
 *
 * This module decides whether a call MAY happen; it never plans, never calls a provider and never
 * declares a business fact. Later stages (OpenAPI / MCP / GraphQL connectors) call `decideToolUse`
 * before every provider request and refuse when it refuses.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { connectIntegrations, connectTools, db } from "@workspace/db";
import { connectError } from "./provider-registry";
import { connectAudit, lockOwnedConnectIntegration, type ConnectMarket, type ConnectTx } from "./partners";

// ─── Vocabulary: general, closed, naming no industry ─────────────────────────────────────────────

export const CONNECT_CAPABILITIES = [
  "READ", "SEARCH", "DISCOVER", "OBSERVE", "TRACK",
  "CREATE", "UPDATE", "DELETE", "BOOK", "SCHEDULE", "MESSAGE", "PAY", "REFUND", "CANCEL",
] as const;
export type ConnectCapability = (typeof CONNECT_CAPABILITIES)[number];

const MUTATING: ReadonlySet<string> = new Set(["CREATE", "UPDATE", "DELETE", "BOOK", "SCHEDULE", "MESSAGE", "PAY", "REFUND", "CANCEL"]);
/** Read and write are different sets, not two levels of one permission. */
export function capabilityMutates(capability: string) {
  return MUTATING.has(capability);
}
export function isConnectCapability(value: unknown): value is ConnectCapability {
  return typeof value === "string" && (CONNECT_CAPABILITIES as readonly string[]).includes(value);
}

export const BINDING_LIFECYCLE = ["SETUP_PENDING", "AUTHORIZED", "AUTHENTICATED", "VERIFIED", "SUSPENDED", "REVOKED"] as const;
export type BindingLifecycle = (typeof BINDING_LIFECYCLE)[number];
export type LifecycleEvent = "CREDENTIAL_SEALED" | "PROVIDER_ANSWERED" | "VERIFIED" | "VERIFICATION_FAILED" | "SUSPEND" | "RESUME" | "REVOKE" | "CREDENTIAL_ROTATED";

/** Each arrow is one fact. No event skips a step; REVOKED is terminal. */
export function nextLifecycle(from: BindingLifecycle, event: LifecycleEvent): BindingLifecycle | { refused: string } {
  if (from === "REVOKED") return { refused: "BINDING_REVOKED" };
  switch (event) {
    case "REVOKE":
      return "REVOKED";
    case "SUSPEND":
      return "SUSPENDED";
    case "CREDENTIAL_SEALED":
      return from === "SETUP_PENDING" ? "AUTHORIZED" : { refused: "CREDENTIAL_ALREADY_SEALED" };
    case "CREDENTIAL_ROTATED":
      // A new credential is unproven: back to AUTHORIZED until the provider answers again.
      return from === "SUSPENDED" ? { refused: "BINDING_SUSPENDED" } : "AUTHORIZED";
    case "PROVIDER_ANSWERED":
      return from === "AUTHORIZED" ? "AUTHENTICATED" : { refused: "NOT_AUTHORIZED_YET" };
    case "VERIFIED":
      return from === "AUTHENTICATED" ? "VERIFIED" : { refused: "NOT_AUTHENTICATED_YET" };
    case "VERIFICATION_FAILED":
      return from === "AUTHENTICATED" || from === "VERIFIED" ? "AUTHORIZED" : { refused: "NOT_AUTHENTICATED_YET" };
    case "RESUME":
      // Resuming never restores trust: the binding must be authenticated and verified again.
      return from === "SUSPENDED" ? "AUTHORIZED" : { refused: "NOT_SUSPENDED" };
  }
}

// ─── The decision ────────────────────────────────────────────────────────────────────────────────

export type ToolUseRefusal =
  | "INTEGRATION_NOT_APPROVED"
  | "BINDING_NOT_VERIFIED"
  | "CAPABILITY_NOT_GRANTED"
  | "TOOL_NOT_AUTHORIZED"
  | "TOOL_SCHEMA_CHANGED"
  | "LIVE_MODE_REQUIRED"
  | "CONFIRMATION_REQUIRED";

export type ToolUseDecision =
  | { allowed: true; access: "READ" | "WRITE"; capability: ConnectCapability }
  | { allowed: false; refusal: ToolUseRefusal };

export type BindingFacts = {
  status: string;
  revision: number;
  approvedRevision: number | null;
  mode: string;
  lifecycle: string;
  grantedCapabilities: readonly string[];
};
export type ToolFacts = { status: string; capability: string; access: string; inputSchemaSha256: string } | undefined;

/**
 * Pure: may this tool be used now? A write additionally needs `confirmed` — the person's own
 * confirmation of this exact call, issued by the server (never model output).
 * `live` is false for simulation, which may read but never write to a real provider.
 */
export function decideToolUse(input: { binding: BindingFacts; tool: ToolFacts; presentedSchemaSha256: string; confirmed: boolean; live: boolean }): ToolUseDecision {
  const { binding, tool } = input;
  if (binding.status !== "APPROVED" || binding.approvedRevision !== binding.revision) return { allowed: false, refusal: "INTEGRATION_NOT_APPROVED" };
  if (binding.lifecycle !== "VERIFIED") return { allowed: false, refusal: "BINDING_NOT_VERIFIED" };
  if (!tool || tool.status !== "AUTHORIZED") return { allowed: false, refusal: "TOOL_NOT_AUTHORIZED" };
  if (tool.inputSchemaSha256 !== input.presentedSchemaSha256) return { allowed: false, refusal: "TOOL_SCHEMA_CHANGED" };
  if (!isConnectCapability(tool.capability) || !binding.grantedCapabilities.includes(tool.capability)) return { allowed: false, refusal: "CAPABILITY_NOT_GRANTED" };
  const write = capabilityMutates(tool.capability);
  if (write && (!input.live || binding.mode !== "LIVE")) return { allowed: false, refusal: "LIVE_MODE_REQUIRED" };
  if (write && !input.confirmed) return { allowed: false, refusal: "CONFIRMATION_REQUIRED" };
  return { allowed: true, access: write ? "WRITE" : "READ", capability: tool.capability };
}

/** A stable digest of a tool's input schema (key order independent). */
export function toolSchemaDigest(schema: unknown): string {
  const canonical = (value: unknown, depth = 0): string => {
    if (depth > 32) throw connectError(400, "SCHEMA_TOO_DEEP", "مخطط الأداة عميق جدًا");
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    return JSON.stringify(value ?? null);
  };
  return createHash("sha256").update(canonical(schema)).digest("hex");
}

/**
 * What the model may see of a binding: names, capabilities and access only. Never an endpoint,
 * credential, header, raw schema or provider description (provider text is untrusted input).
 */
export function modelToolView(tools: readonly { id: string; name: string; capability: string; access: string; status: string }[]) {
  return tools
    .filter((tool) => tool.status === "AUTHORIZED")
    .map((tool) => ({ toolId: tool.id, name: tool.name.slice(0, 64), capability: tool.capability, access: tool.access as "READ" | "WRITE", requiresConfirmation: tool.access === "WRITE" }));
}

// ─── Owner acts (business owner only; audited) ──────────────────────────────────────────────────

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Records what a provider listed. Discovery never authorizes; a changed schema is a new tool. */
export async function recordDiscoveredTools(tx: ConnectTx, integrationId: string, tools: readonly { name: string; inputSchema: unknown; capability: string }[]) {
  if (tools.length > 100) throw connectError(400, "TOO_MANY_TOOLS", "عدد الأدوات أكبر من المسموح");
  const recorded: string[] = [];
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name) || !isConnectCapability(tool.capability)) throw connectError(400, "TOOL_INVALID", "أداة غير صالحة");
    const digest = toolSchemaDigest(tool.inputSchema);
    const [row] = await tx
      .insert(connectTools)
      .values({ id: randomUUID(), integrationId, name: tool.name, inputSchemaSha256: digest, capability: tool.capability, access: capabilityMutates(tool.capability) ? "WRITE" : "READ" })
      .onConflictDoNothing()
      .returning({ id: connectTools.id });
    if (row) recorded.push(row.id);
  }
  return recorded;
}

/** The owner grants capabilities to a binding; only ones it was approved to support. */
export async function grantConnectCapabilities(actorId: string, market: ConnectMarket, integrationId: string, capabilities: readonly string[]) {
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [row] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId)).for("update");
    const wanted = [...new Set(capabilities)];
    if (!wanted.every(isConnectCapability)) throw connectError(400, "CAPABILITY_INVALID", "صلاحية غير معروفة");
    const supported = new Set((row!.config as { supportedCapabilities?: unknown }).supportedCapabilities as string[] | undefined ?? []);
    if (!wanted.every((capability) => supported.has(capability))) throw connectError(409, "CAPABILITY_NOT_SUPPORTED", "الموصل لا يدعم هذه الصلاحية");
    await tx.update(connectIntegrations).set({ grantedCapabilities: wanted, updatedAt: new Date() }).where(eq(connectIntegrations.id, integrationId));
    await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_CAPABILITIES_GRANTED", { integrationId, capabilities: wanted });
    return { integrationId, grantedCapabilities: wanted };
  });
}

/** DISCOVERED → AUTHORIZED by the owner, pinned to the digest the owner reviewed. */
export async function authorizeConnectTool(actorId: string, market: ConnectMarket, integrationId: string, toolId: string, reviewedSchemaSha256: string) {
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [tool] = await tx.select().from(connectTools).where(and(eq(connectTools.id, toolId), eq(connectTools.integrationId, integrationId))).for("update");
    if (!tool) throw connectError(404, "NOT_FOUND", "الأداة غير موجودة");
    if (tool.inputSchemaSha256 !== reviewedSchemaSha256) throw connectError(409, "TOOL_SCHEMA_CHANGED", "تغيّر مخطط الأداة بعد مراجعتك؛ راجعه من جديد");
    if (tool.status === "REVOKED") throw connectError(409, "TOOL_REVOKED", "الأداة ملغاة");
    if (tool.status !== "AUTHORIZED") {
      await tx.update(connectTools).set({ status: "AUTHORIZED", authorizedBy: actorId, authorizedAt: new Date() }).where(eq(connectTools.id, toolId));
      await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_TOOL_AUTHORIZED", { integrationId, toolId, name: tool.name, capability: tool.capability, access: tool.access });
    }
    return { toolId, status: "AUTHORIZED" as const };
  });
}

export async function revokeConnectTool(actorId: string, market: ConnectMarket, integrationId: string, toolId: string) {
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [tool] = await tx
      .update(connectTools)
      .set({ status: "REVOKED", revokedAt: new Date() })
      .where(and(eq(connectTools.id, toolId), eq(connectTools.integrationId, integrationId), inArray(connectTools.status, ["DISCOVERED", "AUTHORIZED"])))
      .returning();
    if (!tool) throw connectError(404, "NOT_FOUND", "الأداة غير موجودة");
    await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_TOOL_REVOKED", { integrationId, toolId });
    return { toolId, status: "REVOKED" as const };
  });
}

/** Server-side lifecycle step (system actor), refused when the step is not the next fact. */
export async function advanceBindingLifecycle(tx: ConnectTx, integrationId: string, event: LifecycleEvent, failure?: string) {
  const [row] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId)).for("update");
  if (!row) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
  const next = nextLifecycle(row.lifecycle as BindingLifecycle, event);
  if (typeof next !== "string") throw connectError(409, next.refused, "خطوة غير مسموحة في دورة حياة الموصل");
  const now = new Date();
  await tx
    .update(connectIntegrations)
    .set({
      lifecycle: next,
      ...(next === "AUTHENTICATED" ? { authenticatedAt: now } : {}),
      ...(next === "VERIFIED" ? { verifiedAt: now, verificationFailure: null } : {}),
      ...(next === "AUTHORIZED" ? { verifiedAt: null, authenticatedAt: null } : {}),
      ...(event === "VERIFICATION_FAILED" ? { verificationFailure: (failure ?? "VERIFICATION_FAILED").slice(0, 80) } : {}),
      updatedAt: now,
    })
    .where(eq(connectIntegrations.id, integrationId));
  await connectAudit(tx, row.partnerId, null, "SYSTEM", "CONNECT_BINDING_LIFECYCLE", { integrationId, from: row.lifecycle, to: next, event });
  return next;
}

/** Loads the facts for `decideToolUse` in one place (read-only). */
export async function toolUseFacts(integrationId: string, toolName: string, presentedSchemaSha256: string) {
  const [binding] = await db.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId));
  if (!binding) return undefined;
  const [tool] = await db
    .select()
    .from(connectTools)
    .where(and(eq(connectTools.integrationId, integrationId), eq(connectTools.name, toolName), eq(connectTools.inputSchemaSha256, presentedSchemaSha256)));
  const [anyVersion] = tool ? [tool] : await db.select().from(connectTools).where(and(eq(connectTools.integrationId, integrationId), eq(connectTools.name, toolName), eq(connectTools.status, "AUTHORIZED")));
  return { binding, tool: tool ?? anyVersion };
}
