/**
 * Jassim Connect — Stage 5a: the outbound credential vault and the verification step.
 *
 *   SETUP_LINK_CREATED != CREDENTIAL_STORED != AUTHENTICATED != VERIFIED
 *   A credential is written once and never read back by any person, route or model.
 *
 * The business owner seals the key their own system issued (API key header, bearer token or basic
 * credential). It is encrypted with AES-256-GCM bound to the connector id (DINAR_CONNECT_VAULT_KEY),
 * and becomes request headers only inside `credentialHeaders`, which only the connector's own
 * request path calls. Rotating a key makes the binding unproven again. Revoking the connector
 * retires every key (`retireConnectSecrets`).
 *
 * Verification is the owner's act: one authorized READ tool is called with the sealed key. A
 * success moves AUTHORIZED → AUTHENTICATED → VERIFIED; a refusal by the provider is recorded and
 * the binding stays unusable. Nothing else ever marks a binding VERIFIED.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { connectIntegrations, connectSecrets, connectTools, db } from "@workspace/db";
import { ConnectNetwork, decryptConnectSecret, encryptConnectSecret } from "./network";
import { connectError } from "./provider-registry";
import { connectAudit, lockOwnedConnectIntegration, type ConnectMarket } from "./partners";
import { advanceBindingLifecycle, capabilityMutates, type BindingLifecycle } from "./binding";

const KIND = "API_CREDENTIAL";
const printable = (max: number) => z.string().min(1).max(max).regex(/^[\x21-\x7e]+$/, "رموز غير مسموحة");

export const CredentialInput = z.discriminatedUnion("method", [
  z.object({ method: z.literal("BEARER"), token: printable(4096) }).strict(),
  z.object({ method: z.literal("API_KEY_HEADER"), headerName: z.enum(["x-api-key", "authorization"]), value: printable(4096) }).strict(),
  z.object({ method: z.literal("BASIC"), username: z.string().min(1).max(256).regex(/^[^:\r\n]+$/), password: z.string().min(1).max(1024).regex(/^[^\r\n]+$/) }).strict(),
]);
export type CredentialInput = z.infer<typeof CredentialInput>;

function toHeaders(credential: CredentialInput): Record<string, string> {
  switch (credential.method) {
    case "BEARER":
      return { authorization: `Bearer ${credential.token}` };
    case "API_KEY_HEADER":
      return { [credential.headerName]: credential.value };
    case "BASIC":
      return { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}` };
  }
}

/** Owner seals (or rotates) the connector's key. Returns no secret material, only a short fingerprint. */
export async function sealConnectCredential(actorId: string, market: ConnectMarket, integrationId: string, raw: unknown) {
  const credential = CredentialInput.parse(raw);
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [row] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId)).for("update");
    if (row!.kind !== "API") throw connectError(409, "INTEGRATION_KIND_MISMATCH", "هذا الموصل ليس من نوع API");
    if (row!.status !== "APPROVED" || row!.lifecycle === "REVOKED") throw connectError(409, "INTEGRATION_NOT_APPROVED", "الموصل غير معتمد حاليًا");
    const now = new Date();
    await tx.update(connectSecrets).set({ revokedAt: now }).where(and(eq(connectSecrets.integrationId, integrationId), eq(connectSecrets.kind, KIND), isNull(connectSecrets.revokedAt)));
    await tx.insert(connectSecrets).values({ id: randomUUID(), integrationId, kind: KIND, ciphertext: encryptConnectSecret(JSON.stringify(credential), integrationId), revision: row!.revision });
    const lifecycle = await advanceBindingLifecycle(tx, integrationId, (row!.lifecycle as BindingLifecycle) === "SETUP_PENDING" ? "CREDENTIAL_SEALED" : "CREDENTIAL_ROTATED");
    const fingerprint = createHash("sha256").update(JSON.stringify(credential)).digest("hex").slice(0, 8);
    await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_CREDENTIAL_SEALED", { integrationId, method: credential.method, fingerprint });
    return { integrationId, method: credential.method, fingerprint, lifecycle };
  });
}

/** Server-side only. No route, model tool or view may call this. */
export async function credentialHeaders(integrationId: string): Promise<Record<string, string>> {
  const [row] = await db
    .select()
    .from(connectSecrets)
    .where(and(eq(connectSecrets.integrationId, integrationId), eq(connectSecrets.kind, KIND), isNull(connectSecrets.revokedAt)))
    .orderBy(desc(connectSecrets.createdAt))
    .limit(1);
  if (!row) return {};
  return toHeaders(CredentialInput.parse(JSON.parse(decryptConnectSecret(row.ciphertext, integrationId))));
}

/** What the owner may see: whether a key is sealed, its method and fingerprint, never its value. */
export async function connectCredentialStatus(integrationId: string) {
  const [row] = await db
    .select({ createdAt: connectSecrets.createdAt })
    .from(connectSecrets)
    .where(and(eq(connectSecrets.integrationId, integrationId), eq(connectSecrets.kind, KIND), isNull(connectSecrets.revokedAt)))
    .orderBy(desc(connectSecrets.createdAt))
    .limit(1);
  return { sealed: Boolean(row), sealedAt: row?.createdAt.toISOString() ?? null };
}

/**
 * The owner's verification: one authorized READ tool, called with the sealed key. The tool's
 * required arguments come from the owner; the provider's answer is not returned in full, only its status.
 */
export async function verifyConnectBinding(actorId: string, market: ConnectMarket, integrationId: string, input: { toolId: string; arguments?: Record<string, unknown> }, network = new ConnectNetwork()) {
  const { validateArguments, executeConnectOperation } = await import("./api-connector");
  const prepared = await db.transaction(async (tx) => {
    await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [row] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId)).for("update");
    if (row!.status !== "APPROVED" || row!.approvedRevision !== row!.revision) throw connectError(409, "INTEGRATION_NOT_APPROVED", "الموصل غير معتمد حاليًا");
    if (row!.lifecycle !== "AUTHORIZED") throw connectError(409, row!.lifecycle === "VERIFIED" ? "ALREADY_VERIFIED" : "CREDENTIAL_REQUIRED", "يلزم حفظ مفتاح الموصل أولًا");
    const [tool] = await tx.select().from(connectTools).where(and(eq(connectTools.id, input.toolId), eq(connectTools.integrationId, integrationId)));
    if (!tool || tool.status !== "AUTHORIZED" || !tool.operation) throw connectError(409, "TOOL_NOT_AUTHORIZED", "اختر أداة قراءة معتمدة للتحقق");
    if (capabilityMutates(tool.capability)) throw connectError(409, "VERIFY_WITH_READ_ONLY", "التحقق يتم بأداة قراءة فقط؛ لا يُرسل أي تغيير");
    return { row: row!, tool };
  });
  const args = input.arguments ?? {};
  validateArguments((prepared.tool.operation as { inputSchema: Parameters<typeof validateArguments>[0] }).inputSchema, args);
  let outcome: { ok: true; status: number } | { ok: false; code: string };
  try {
    const executed = await executeConnectOperation(network, prepared.row, prepared.tool, args);
    outcome = { ok: true, status: executed.providerStatus };
  } catch (error) {
    outcome = { ok: false, code: (error as { code?: string }).code ?? "PROVIDER_ERROR" };
  }
  return db.transaction(async (tx) => {
    // The binding may have changed while the provider answered (revoked, rotated): re-check.
    const [current] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId)).for("update");
    if (current!.lifecycle !== "AUTHORIZED" || current!.status !== "APPROVED") throw connectError(409, "BINDING_CHANGED", "تغيّر الموصل أثناء التحقق؛ أعد المحاولة");
    if (!outcome.ok) {
      await tx.update(connectIntegrations).set({ verificationFailure: outcome.code.slice(0, 80), updatedAt: new Date() }).where(eq(connectIntegrations.id, integrationId));
      await connectAudit(tx, current!.partnerId, actorId, "OWNER", "CONNECT_VERIFICATION_FAILED", { integrationId, code: outcome.code });
      return { verified: false as const, lifecycle: "AUTHORIZED" as const, failure: outcome.code };
    }
    await advanceBindingLifecycle(tx, integrationId, "PROVIDER_ANSWERED");
    await advanceBindingLifecycle(tx, integrationId, "VERIFIED");
    await connectAudit(tx, current!.partnerId, actorId, "OWNER", "CONNECT_VERIFIED", { integrationId, toolId: prepared.tool.id, providerStatus: outcome.status });
    return { verified: true as const, lifecycle: "VERIFIED" as const, providerStatus: outcome.status };
  });
}
