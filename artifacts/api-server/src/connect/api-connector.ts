/**
 * Jassim Connect — Stage 3: discovery and standard API connectors (OpenAPI 3, named GraphQL operations).
 *
 * A provider's API description is untrusted input. It may only PROPOSE tools: each operation is
 * recorded as DISCOVERED, pinned to the digest of its whole operation (method, path, parameters,
 * schema), and nothing runs until the business owner authorizes it (Stage 2). A read executes when
 * `decideToolUse` allows it. A write never executes from a request or a model: it creates a
 * confirmation of the exact arguments, and only the same person's confirmation runs it — once, with
 * the confirmation id as the provider's Idempotency-Key. Provider answers return as untrusted data.
 *
 *   HTTP_METHOD_DECIDES_ACCESS: a provider cannot label a POST as a read.
 *   NO_HEADER_OR_COOKIE_PARAMETERS: credentials never travel as tool arguments.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { connectActionConfirmations, connectIntegrations, connectTools, db } from "@workspace/db";
import { ConnectNetwork } from "./network";
import { connectError, validateExternalUrl } from "./provider-registry";
import { parseBoundedConnectProviderJson } from "./catalog-document";
import { connectAccess, connectAudit, lockOwnedConnectIntegration, type ConnectMarket } from "./partners";
import { credentialHeaders } from "./credential-vault";
import { capabilityMutates, decideToolUse, isConnectCapability, recordDiscoveredTools, toolSchemaDigest, type ConnectCapability } from "./binding";

// ─── Operations ──────────────────────────────────────────────────────────────────────────────────

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; maxLength?: number; minimum?: number; maximum?: number; items?: JsonSchema; maxItems?: number };
export type ApiOperation =
  | { protocol: "OPENAPI"; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; pathParams: string[]; queryParams: string[]; body: boolean; inputSchema: JsonSchema }
  | { protocol: "GRAPHQL"; operationType: "query" | "mutation"; document: string; inputSchema: JsonSchema };
export type ProposedTool = { name: string; capability: ConnectCapability; operation: ApiOperation };

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DEFAULT_CAPABILITY: Record<string, ConnectCapability> = { GET: "READ", POST: "CREATE", PUT: "UPDATE", PATCH: "UPDATE", DELETE: "DELETE" };
const invalid = (detail: string) => connectError(422, "API_DESCRIPTION_INVALID", `وصف واجهة المزوّد غير صالح: ${detail}`);

/** A provider may refine the capability only within the access class its HTTP method implies. */
function capabilityFor(method: string, hinted: unknown): ConnectCapability {
  const fallback = DEFAULT_CAPABILITY[method]!;
  if (!isConnectCapability(hinted)) return fallback;
  return capabilityMutates(hinted) === capabilityMutates(fallback) ? hinted : fallback;
}

/** Keeps the subset of JSON Schema the validator enforces; anything else is dropped, never trusted. */
function simplifySchema(raw: unknown, refs: Record<string, unknown>, depth = 0): JsonSchema {
  if (depth > 6 || !raw || typeof raw !== "object") return {};
  let node = raw as Record<string, unknown>;
  if (typeof node.$ref === "string") {
    const match = /^#\/components\/schemas\/([A-Za-z0-9_.-]{1,64})$/.exec(node.$ref);
    if (!match || !refs[match[1]!]) throw invalid("مرجع مخطط غير محلي");
    node = refs[match[1]!] as Record<string, unknown>;
  }
  const out: JsonSchema = {};
  if (typeof node.type === "string" && ["object", "string", "number", "integer", "boolean", "array"].includes(node.type)) out.type = node.type;
  if (Array.isArray(node.enum)) out.enum = node.enum.filter((value) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 50);
  if (typeof node.maxLength === "number") out.maxLength = Math.min(node.maxLength, 4000);
  if (typeof node.minimum === "number") out.minimum = node.minimum;
  if (typeof node.maximum === "number") out.maximum = node.maximum;
  if (out.type === "array") {
    out.items = simplifySchema(node.items, refs, depth + 1);
    out.maxItems = Math.min(typeof node.maxItems === "number" ? node.maxItems : 50, 50);
  }
  if (node.properties && typeof node.properties === "object") {
    const entries = Object.entries(node.properties as Record<string, unknown>).slice(0, 50);
    out.type = "object";
    out.properties = Object.fromEntries(entries.filter(([key]) => PARAM.test(key)).map(([key, value]) => [key, simplifySchema(value, refs, depth + 1)]));
    if (Array.isArray(node.required)) out.required = (node.required as unknown[]).filter((key): key is string => typeof key === "string" && key in out.properties!);
  }
  return out;
}

/** Proposes tools from an OpenAPI 3 document. Header and cookie parameters are refused outright. */
export function proposeOpenApiTools(doc: unknown): ProposedTool[] {
  if (!doc || typeof doc !== "object") throw invalid("ليس كائن JSON");
  const root = doc as Record<string, unknown>;
  if (typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) throw invalid("يُقبل OpenAPI 3 فقط");
  const refs = ((root.components as Record<string, unknown> | undefined)?.schemas ?? {}) as Record<string, unknown>;
  const tools: ProposedTool[] = [];
  for (const [path, item] of Object.entries((root.paths ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!/^\/[A-Za-z0-9_.~\-/{}]*$/.test(path) || path.includes("..") || path.length > 200) throw invalid("مسار غير صالح");
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = item?.[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const name = op.operationId;
      if (typeof name !== "string" || !NAME.test(name)) throw invalid("كل عملية تحتاج operationId صالحًا");
      const params = [...((item.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])].map((value) => {
        const resolved = value as Record<string, unknown>;
        if (typeof resolved.$ref === "string") throw invalid("مراجع المعاملات غير مدعومة");
        return resolved;
      });
      if (params.some((param) => param.in === "header" || param.in === "cookie")) throw invalid("معاملات الترويسات والكوكيز غير مسموحة");
      const pathParams = params.filter((param) => param.in === "path").map((param) => String(param.name));
      const queryParams = params.filter((param) => param.in === "query").map((param) => String(param.name));
      if (![...pathParams, ...queryParams].every((key) => PARAM.test(key))) throw invalid("اسم معامل غير صالح");
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
      if (placeholders.sort().join() !== [...pathParams].sort().join()) throw invalid("معاملات المسار لا تطابق القالب");
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const param of params) {
        properties[String(param.name)] = simplifySchema(param.schema, refs);
        if (param.required || param.in === "path") required.push(String(param.name));
      }
      const bodySchema = ((op.requestBody as Record<string, any> | undefined)?.content?.["application/json"]?.schema) as unknown;
      const body = method !== "get" && method !== "delete" && bodySchema !== undefined;
      if (body) {
        if ("body" in properties) throw invalid("اسم المعامل body محجوز");
        properties.body = simplifySchema(bodySchema, refs);
        if ((op.requestBody as Record<string, unknown>).required) required.push("body");
      }
      const upper = method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      tools.push({ name, capability: capabilityFor(upper, op["x-jassim-capability"]), operation: { protocol: "OPENAPI", method: upper, path, pathParams, queryParams, body, inputSchema: { type: "object", properties, required } } });
      if (tools.length > 100) throw invalid("أكثر من 100 عملية");
    }
  }
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw invalid("operationId مكرر");
  return tools;
}

/** Named GraphQL operations the owner registers. One operation per document; no subscriptions. */
export function proposeGraphqlTools(operations: unknown): ProposedTool[] {
  if (!Array.isArray(operations) || operations.length > 100) throw invalid("قائمة عمليات GraphQL غير صالحة");
  return operations.map((raw) => {
    const op = raw as { name?: unknown; document?: unknown; variables?: unknown; capability?: unknown };
    if (typeof op.name !== "string" || !NAME.test(op.name) || typeof op.document !== "string" || op.document.length > 4000) throw invalid("عملية GraphQL غير صالحة");
    const stripped = op.document.replace(/#[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const heads = [...stripped.matchAll(/(?:^|\})\s*(query|mutation|subscription|fragment)\b/g)].map((match) => match[1]);
    if (heads.length !== 1 || (heads[0] !== "query" && heads[0] !== "mutation")) throw invalid("كل وثيقة GraphQL عملية واحدة: query أو mutation");
    const operationType = heads[0] as "query" | "mutation";
    const fallback: ConnectCapability = operationType === "query" ? "READ" : "UPDATE";
    const capability = isConnectCapability(op.capability) && capabilityMutates(op.capability) === (operationType === "mutation") ? op.capability : fallback;
    const inputSchema = simplifySchema(op.variables ?? { type: "object", properties: {} }, {});
    return { name: op.name, capability, operation: { protocol: "GRAPHQL" as const, operationType, document: op.document, inputSchema: { ...inputSchema, type: "object" } } };
  });
}

// ─── Argument validation (bounded subset; unknown keys refused) ─────────────────────────────────

export function validateArguments(schema: JsonSchema, value: unknown, path = "arguments", depth = 0): void {
  const fail = () => connectError(400, "TOOL_ARGUMENTS_INVALID", `قيمة غير صالحة في ${path.slice(0, 80)}`);
  if (depth > 8) throw fail();
  if (schema.enum && !schema.enum.includes(value as never)) throw fail();
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
      const properties = schema.properties ?? {};
      for (const key of Object.keys(value)) if (!(key in properties)) throw fail();
      for (const key of schema.required ?? []) if ((value as Record<string, unknown>)[key] === undefined) throw fail();
      for (const [key, child] of Object.entries(properties)) {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) validateArguments(child, item, `${path}.${key}`, depth + 1);
      }
      return;
    }
    case "string":
      if (typeof value !== "string" || value.length > (schema.maxLength ?? 2000)) throw fail();
      return;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) throw fail();
      if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw fail();
      return;
    case "boolean":
      if (typeof value !== "boolean") throw fail();
      return;
    case "array":
      if (!Array.isArray(value) || value.length > (schema.maxItems ?? 50)) throw fail();
      value.forEach((item, index) => validateArguments(schema.items ?? {}, item, `${path}[${index}]`, depth + 1));
      return;
    default:
      // An untyped schema accepts only plain scalars, never nested provider-shaped objects.
      if (value !== null && typeof value === "object") throw fail();
  }
}

export function argumentsDigest(value: unknown) {
  return toolSchemaDigest(value);
}

// ─── Owner: discover and import ─────────────────────────────────────────────────────────────────

/** Looks for an OpenAPI description at the connector's own origin (well-known paths only). */
export async function discoverOpenApiDocument(network: ConnectNetwork, endpointUrl: string) {
  const origin = new URL(endpointUrl);
  for (const path of ["/.well-known/openapi.json", "/openapi.json"]) {
    const url = `${origin.origin}${path}`;
    try {
      const response = await network.request(url, [origin.hostname]);
      if (!/json/i.test(response.contentType)) continue;
      return { url, document: parseBoundedConnectProviderJson(response.text) };
    } catch (error) {
      if ((error as { code?: string }).code === "PRIVATE_ENDPOINT") throw error;
    }
  }
  return undefined;
}

/** Records proposed tools as DISCOVERED for the owner's review. Nothing becomes usable here. */
export async function importApiTools(actorId: string, market: ConnectMarket, integrationId: string, proposed: readonly ProposedTool[]) {
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [row] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId));
    if (row!.kind !== "API") throw connectError(409, "INTEGRATION_KIND_MISMATCH", "هذا الموصل ليس من نوع API");
    const recorded = await recordDiscoveredTools(
      tx,
      integrationId,
      proposed.map((tool) => ({ name: tool.name, capability: tool.capability, inputSchema: tool.operation, operation: tool.operation as unknown as Record<string, unknown> })),
    );
    // What the connector supports is what it described; granting remains the owner's separate act.
    const supported = [...new Set([...(((row!.config as { supportedCapabilities?: string[] }).supportedCapabilities) ?? []), ...proposed.map((tool) => tool.capability)])];
    await tx.update(connectIntegrations).set({ config: { ...(row!.config as object), supportedCapabilities: supported }, updatedAt: new Date() }).where(eq(connectIntegrations.id, integrationId));
    await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_API_TOOLS_DISCOVERED", { integrationId, discovered: recorded.length, proposed: proposed.length });
    return { discovered: recorded.length, supportedCapabilities: supported };
  });
}

// ─── Calls ───────────────────────────────────────────────────────────────────────────────────────

const CONFIRMATION_TTL_MS = 10 * 60_000;

export type ToolCallResult =
  | { status: "EXECUTED"; access: "READ" | "WRITE"; providerStatus: number; result: { source: "PROVIDER"; trusted: false; data: unknown } }
  | { status: "CONFIRMATION_REQUIRED"; confirmationId: string; expiresAt: string; summary: { tool: string; capability: string; arguments: Record<string, unknown> } }
  | { status: "REFUSED"; refusal: string };

type ToolRow = typeof connectTools.$inferSelect;
type IntegrationRow = typeof connectIntegrations.$inferSelect;

/** Server-side only: the sealed credential becomes headers here and nowhere else. */
export async function executeConnectOperation(network: ConnectNetwork, integration: IntegrationRow, tool: ToolRow, args: Record<string, unknown>, idempotencyKey?: string) {
  const credential = await credentialHeaders(integration.id);
  const operation = tool.operation as unknown as ApiOperation;
  if (!integration.endpointUrl) throw connectError(409, "ENDPOINT_MISSING", "عنوان الموصل غير محدد");
  const base = new URL(validateExternalUrl(integration.endpointUrl, [new URL(integration.endpointUrl).hostname]));
  const headers: Record<string, string> = { accept: "application/json", ...credential, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) };
  let url: URL;
  let method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  let body: string | undefined;
  if (operation.protocol === "OPENAPI") {
    const path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(args[key])));
    url = new URL(`${base.pathname.replace(/\/+$/, "")}${path}`, base.origin);
    for (const key of operation.queryParams) if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
    method = operation.method;
    if (operation.body && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers["content-type"] = "application/json";
    }
  } else {
    url = base;
    method = "POST";
    body = JSON.stringify({ query: operation.document, variables: args });
    headers["content-type"] = "application/json";
  }
  const response = await network.request(url.href, [base.hostname], { method, headers, body, allowEmptyResponse: true, allowedQueryKeys: operation.protocol === "OPENAPI" ? operation.queryParams : [] });
  let data: unknown = null;
  if (response.text && /json/i.test(response.contentType)) data = parseBoundedConnectProviderJson(response.text);
  if (operation.protocol === "GRAPHQL" && data && typeof data === "object" && Array.isArray((data as { errors?: unknown }).errors) && (data as { errors: unknown[] }).errors.length)
    throw connectError(502, "PROVIDER_REPORTED_ERROR", "أبلغ المزوّد عن خطأ في العملية");
  return { providerStatus: response.status, data };
}

async function loadCallable(actorId: string, market: ConnectMarket, integrationId: string, toolName: string) {
  const [integration] = await db.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId));
  if (!integration) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
  // Stage 3: the business owner operates their own connector. Buyers act through Business AI later.
  await connectAccess(actorId, market.id, integration.partnerId, "OWNER");
  const tools = await db.select().from(connectTools).where(and(eq(connectTools.integrationId, integrationId), eq(connectTools.name, toolName), inArray(connectTools.status, ["AUTHORIZED", "DISCOVERED"])));
  // The latest authorized version is the callable one; a newer, unreviewed description is not.
  const tool = tools.find((item) => item.status === "AUTHORIZED") ?? tools[0];
  return { integration, tool };
}

/**
 * One entry for every tool call. Reads run now when allowed; writes return a confirmation and run
 * only through `confirmToolCall` by the same person.
 */
export async function callConnectTool(input: { actorId: string; market: ConnectMarket; integrationId: string; toolName: string; arguments: Record<string, unknown>; network?: ConnectNetwork; live?: boolean }): Promise<ToolCallResult> {
  const { integration, tool } = await loadCallable(input.actorId, input.market, input.integrationId, input.toolName);
  if (!tool?.operation) return { status: "REFUSED", refusal: "TOOL_NOT_AUTHORIZED" };
  validateArguments((tool.operation as unknown as ApiOperation).inputSchema, input.arguments);
  const live = input.live ?? process.env.DINAR_CONNECT_LIVE_CALLS === "true";
  const decision = decideToolUse({ binding: integration, tool, presentedSchemaSha256: tool.inputSchemaSha256, confirmed: false, live });
  if (!decision.allowed) {
    if (decision.refusal !== "CONFIRMATION_REQUIRED") return { status: "REFUSED", refusal: decision.refusal };
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
    await db.insert(connectActionConfirmations).values({ id, integrationId: integration.id, toolId: tool.id, actorId: input.actorId, argumentsDigest: argumentsDigest(input.arguments), arguments: input.arguments, expiresAt });
    return { status: "CONFIRMATION_REQUIRED", confirmationId: id, expiresAt: expiresAt.toISOString(), summary: { tool: tool.name, capability: tool.capability, arguments: input.arguments } };
  }
  const executed = await executeConnectOperation(input.network ?? new ConnectNetwork(), integration, tool, input.arguments);
  return { status: "EXECUTED", access: decision.access, providerStatus: executed.providerStatus, result: { source: "PROVIDER", trusted: false, data: executed.data } };
}

/** The person's confirmation: consumed once, re-decided against the binding as it is now. */
export async function confirmToolCall(input: { actorId: string; market: ConnectMarket; confirmationId: string; network?: ConnectNetwork; live?: boolean }): Promise<ToolCallResult> {
  const now = new Date();
  const [claimed] = await db
    .update(connectActionConfirmations)
    .set({ status: "EXECUTING", consumedAt: now })
    .where(and(eq(connectActionConfirmations.id, input.confirmationId), eq(connectActionConfirmations.actorId, input.actorId), eq(connectActionConfirmations.status, "PENDING"), gt(connectActionConfirmations.expiresAt, now)))
    .returning();
  if (!claimed) {
    const [seen] = await db.select({ status: connectActionConfirmations.status, actorId: connectActionConfirmations.actorId }).from(connectActionConfirmations).where(eq(connectActionConfirmations.id, input.confirmationId));
    if (!seen || seen.actorId !== input.actorId) throw connectError(404, "NOT_FOUND", "التأكيد غير موجود");
    return { status: "REFUSED", refusal: seen.status === "PENDING" ? "CONFIRMATION_EXPIRED" : "CONFIRMATION_ALREADY_USED" };
  }
  const finish = async (status: "SUCCEEDED" | "FAILED", resultStatus: number | null) => {
    await db.update(connectActionConfirmations).set({ status, resultStatus }).where(eq(connectActionConfirmations.id, claimed.id));
  };
  const [integration] = await db.select().from(connectIntegrations).where(eq(connectIntegrations.id, claimed.integrationId));
  const [tool] = await db.select().from(connectTools).where(eq(connectTools.id, claimed.toolId));
  await connectAccess(input.actorId, input.market.id, integration!.partnerId, "OWNER");
  if (argumentsDigest(claimed.arguments) !== claimed.argumentsDigest) {
    await finish("FAILED", null);
    return { status: "REFUSED", refusal: "ARGUMENTS_CHANGED" };
  }
  const live = input.live ?? process.env.DINAR_CONNECT_LIVE_CALLS === "true";
  const decision = decideToolUse({ binding: integration!, tool, presentedSchemaSha256: tool!.inputSchemaSha256, confirmed: true, live });
  if (!decision.allowed) {
    await finish("FAILED", null);
    return { status: "REFUSED", refusal: decision.refusal };
  }
  try {
    const executed = await executeConnectOperation(input.network ?? new ConnectNetwork(), integration!, tool!, claimed.arguments, claimed.id);
    await finish("SUCCEEDED", executed.providerStatus);
    await connectAudit(db, integration!.partnerId, input.actorId, "OWNER", "CONNECT_TOOL_WRITE_EXECUTED", { integrationId: integration!.id, toolId: tool!.id, capability: tool!.capability, providerStatus: executed.providerStatus, argumentsDigest: claimed.argumentsDigest });
    return { status: "EXECUTED", access: "WRITE", providerStatus: executed.providerStatus, result: { source: "PROVIDER", trusted: false, data: executed.data } };
  } catch (error) {
    // The provider may or may not have applied it; the record says FAILED and the same idempotency key
    // is never reused for a different call. The person can ask the provider's status, not retry blindly.
    await finish("FAILED", null);
    await connectAudit(db, integration!.partnerId, input.actorId, "OWNER", "CONNECT_TOOL_WRITE_FAILED", { integrationId: integration!.id, toolId: tool!.id, code: (error as { code?: string }).code ?? "PROVIDER_ERROR" });
    throw error;
  }
}

/** The digest the owner reviews before authorizing: the whole operation, not only its schema. */
export function apiOperationDigest(operation: ApiOperation) {
  return toolSchemaDigest(operation);
}

/** The person declines a pending write; nothing is sent. */
export async function cancelToolCall(input: { actorId: string; confirmationId: string }) {
  const [row] = await db
    .update(connectActionConfirmations)
    .set({ status: "CANCELLED" })
    .where(and(eq(connectActionConfirmations.id, input.confirmationId), eq(connectActionConfirmations.actorId, input.actorId), eq(connectActionConfirmations.status, "PENDING")))
    .returning({ id: connectActionConfirmations.id });
  if (!row) throw connectError(404, "NOT_FOUND", "التأكيد غير موجود");
  return { confirmationId: row.id, status: "CANCELLED" as const };
}
