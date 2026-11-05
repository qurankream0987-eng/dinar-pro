import { z } from "zod";
import { CONNECT_MCP_CATALOG_TOOL, CONNECT_MCP_CATALOG_INPUT_SHA256, CONNECT_MCP_CATALOG_INPUT_SCHEMA } from "@workspace/api-zod/connect-platform";
import { ConnectNetwork } from "./network";
import { connectDigest } from "./partners";
import { connectError } from "./provider-registry";
import { parseConnectCatalogDocument, parseBoundedConnectProviderJson } from "./catalog-document";
const PROTOCOL = "2025-06-18";
const manifest = z.array(z.object({ name: z.literal(CONNECT_MCP_CATALOG_TOOL), inputSchemaSha256: z.literal(CONNECT_MCP_CATALOG_INPUT_SHA256), readOnly: z.literal(true), capability: z.literal("CATALOG_READ") }).strict()).length(1);
const record = z.record(z.string(), z.unknown());
const invalid = () => connectError(502, "MCP_INVALID_RESPONSE", "لم يؤكد موصل MCP عقد كتالوج القراءة المعتمد");
function responseMessage(text: string, contentType: string, expectedId: number) {
  if (/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(contentType)) {
    try { return parseBoundedConnectProviderJson(text); } catch { throw invalid(); }
  }
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType)) throw invalid();
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let data: string[] = [], found: unknown, frames = 0;
  for (const line of lines) {
    if (!line) {
      if (!data.length) continue;
      if (++frames > 32) throw invalid();
      let frame: unknown; try { frame = parseBoundedConnectProviderJson(data.join("\n")); } catch { throw invalid(); }
      data = [];
      const parsed = record.safeParse(frame); if (!parsed.success || parsed.data.jsonrpc !== "2.0") throw invalid();
      if (typeof parsed.data.method === "string") { if ("id" in parsed.data) throw invalid(); continue; }
      if (parsed.data.id !== expectedId || found !== undefined) throw invalid();
      found = frame;
    } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line === "data") data.push("");
    // SSE comments/event/id/retry are transport metadata, never instructions.
  }
  if (data.length || found === undefined) throw invalid();
  return found;
}
/** A fixed catalog connector, never a provider tool registry or action executor.
 * No server instructions, arbitrary tool names, text content or URLs are returned. */
export async function readReviewedMcpCatalog(network: ConnectNetwork, endpoint: string, hostname: string, rawManifest: unknown, authorization?: string) {
  if (!manifest.safeParse(rawManifest).success || connectDigest(CONNECT_MCP_CATALOG_INPUT_SCHEMA) !== CONNECT_MCP_CATALOG_INPUT_SHA256)
    throw connectError(409, "MCP_REVIEW_REQUIRED", "يلزم اعتماد عقد قراءة الكتالوج ومخططه المحدد أولًا");
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) };
  const rpc = async (method: string, id?: number, params?: unknown) => {
    const response = await network.request(endpoint, [hostname], { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), allowEmptyResponse: id === undefined });
    if (id === undefined) { if (response.status !== 202 || response.text.trim()) throw invalid(); return { result: {}, headers: response.headers }; }
    const message = record.safeParse(responseMessage(response.text, response.contentType, id));
    if (!message.success || message.data.jsonrpc !== "2.0" || message.data.id !== id || "error" in message.data) throw invalid();
    const result = record.safeParse(message.data.result); if (!result.success) throw invalid();
    return { result: result.data, headers: response.headers };
  };
  const initialized = await rpc("initialize", 1, { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "DINARConnect", version: "1.0" } });
  const serverInfo = z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }).safeParse(initialized.result.serverInfo);
  if (initialized.result.protocolVersion !== PROTOCOL || !serverInfo.success || !record.safeParse(initialized.result.capabilities).success ||
      !record.safeParse((initialized.result.capabilities as Record<string, unknown>).tools).success) throw invalid();
  const session = initialized.headers.get("mcp-session-id");
  if (session !== null) { if (!/^[\x21-\x7e]{1,256}$/.test(session)) throw invalid(); headers["mcp-session-id"] = session; }
  headers["mcp-protocol-version"] = PROTOCOL;
  try {
  await rpc("notifications/initialized");
  const listed = await rpc("tools/list", 2);
  if (!Array.isArray(listed.result.tools) || listed.result.tools.length > 100) throw invalid();
  const matches = listed.result.tools.filter(tool => record.safeParse(tool).success && (tool as Record<string, unknown>).name === CONNECT_MCP_CATALOG_TOOL);
  if (matches.length !== 1) throw invalid();
  const tool = matches[0] as Record<string, unknown>, annotations = record.safeParse(tool.annotations);
  if (!annotations.success || annotations.data.readOnlyHint !== true || annotations.data.destructiveHint !== false || !record.safeParse(tool.inputSchema).success) throw invalid();
  try { if (connectDigest(tool.inputSchema) !== CONNECT_MCP_CATALOG_INPUT_SHA256) throw invalid(); } catch { throw invalid(); }
  const called = await rpc("tools/call", 3, { name: CONNECT_MCP_CATALOG_TOOL, arguments: {} });
  if ((called.result.isError !== undefined && called.result.isError !== false) || !Array.isArray(called.result.content) || called.result.content.length > 100) throw invalid();
  // Only structured output is authoritative. Text content/instructions are ignored.
  if (!record.safeParse(called.result.structuredContent).success) throw invalid();
  return parseConnectCatalogDocument(JSON.stringify(called.result.structuredContent));
  } finally {
    if (session !== null) {
      // Documented session cleanup only; no arbitrary HTTP write operation.
      // A provider may reject termination (405); never claim remote revocation.
      await network.request(endpoint, [hostname], { method: "DELETE", headers, endMcpSession: true }).catch(() => undefined);
    }
  }

}
