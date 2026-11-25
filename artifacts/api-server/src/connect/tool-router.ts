/**
 * Jassim Connect — Stage 4: dynamic tool routing.
 *
 * The model never sees a provider's full tool list and never names a tool it was not given. It asks
 * `findConnectTools` with the person's need; the router returns at most five AUTHORIZED tools from
 * the person's own verified connectors, ranked by deterministic server code (capability intent +
 * name overlap). `useConnectTool` then goes through the Stage 3 entry, so the Stage 2 law decides:
 * a read runs, a write only becomes a confirmation card the person confirms in the app.
 *
 *   ROUTER_CHOOSES_FROM_AUTHORIZED_ONLY · ROUTER_NEVER_EXECUTES_A_WRITE
 *   PROVIDER_DESCRIPTIONS_NEVER_RANK (provider text is untrusted; only the tool name and the
 *   owner-granted capability are used)
 */
import { and, eq, inArray } from "drizzle-orm";
import { businessProfiles, connectIntegrations, connectPartners, connectTools, db } from "@workspace/db";
import { modelToolView, type ConnectCapability } from "./binding";
import { callConnectTool, type ToolCallResult } from "./api-connector";
import type { ConnectMarket } from "./partners";

const INTENTS: { pattern: RegExp; capabilities: ConnectCapability[]; words: string[] }[] = [
  { pattern: /(?:ابحث|بحث|دور|فتش|اعرض|ورني|search|find|look ?up)/iu, capabilities: ["SEARCH", "READ"], words: ["search", "find", "list"] },
  { pattern: /(?:احجز|حجز|موعد|book|reserve|reservation)/iu, capabilities: ["BOOK", "SCHEDULE", "CREATE"], words: ["book", "booking", "reservation", "appointment"] },
  { pattern: /(?:جدول|رتب موعد|schedule)/iu, capabilities: ["SCHEDULE", "BOOK"], words: ["schedule", "appointment"] },
  { pattern: /(?:الغ|إلغاء|الغاء|كنسل|cancel)/iu, capabilities: ["CANCEL"], words: ["cancel"] },
  { pattern: /(?:تتبع|وين وصل|شحن|شحنة|track|shipment|delivery)/iu, capabilities: ["TRACK", "OBSERVE", "READ"], words: ["track", "shipment", "delivery", "status"] },
  { pattern: /(?:انشئ|أنشئ|اضف|أضف|سجل|create|add|new)/iu, capabilities: ["CREATE"], words: ["create", "add", "new"] },
  { pattern: /(?:عدل|غير|حدث|update|change|edit)/iu, capabilities: ["UPDATE"], words: ["update", "edit", "change"] },
  { pattern: /(?:احذف|امسح|delete|remove)/iu, capabilities: ["DELETE"], words: ["delete", "remove"] },
  { pattern: /(?:ارسل|أرسل|راسل|رسالة|message|send)/iu, capabilities: ["MESSAGE"], words: ["message", "send", "notify"] },
  { pattern: /(?:ادفع|دفع|pay|payment)/iu, capabilities: ["PAY"], words: ["pay", "payment", "charge"] },
  { pattern: /(?:استرجاع|استرداد|refund)/iu, capabilities: ["REFUND"], words: ["refund"] },
  { pattern: /(?:كم|سعر|متوفر|توفر|تفاصيل|حالة|price|stock|available|details|status|show|get)/iu, capabilities: ["READ", "OBSERVE"], words: ["get", "read", "price", "stock", "status", "detail"] },
];
/** A small, fixed Arabic → English glossary for object nouns in tool names. */
const NOUNS: [RegExp, string[]][] = [
  [/(?:منتج|سلعة|صنف|منتجات)/u, ["item", "product", "sku"]],
  [/(?:طلب|طلبات|اوردر)/u, ["order"]],
  [/(?:عميل|زبون)/u, ["customer", "client"]],
  [/(?:مخزون|كمية)/u, ["stock", "inventory"]],
  [/(?:فاتورة)/u, ["invoice"]],
  [/(?:طاولة|مطعم)/u, ["table", "reservation"]],
  [/(?:غرفة|فندق)/u, ["room", "hotel"]],
  [/(?:مقعد|رحلة|تذكرة)/u, ["seat", "trip", "ticket"]],
  [/(?:شحنة|طرد)/u, ["shipment", "parcel"]],
  [/(?:موعد)/u, ["appointment", "slot"]],
];

export function nameTokens(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/** Deterministic score: intent capability match dominates; name words break ties. */
export function rankTools<T extends { name: string; capability: string }>(need: string, tools: readonly T[], limit = 5) {
  const matched = INTENTS.filter((intent) => intent.pattern.test(need));
  const capabilities = new Map<string, number>();
  matched.forEach((intent) => intent.capabilities.forEach((capability, index) => capabilities.set(capability, Math.max(capabilities.get(capability) ?? 0, 3 - index))));
  const words = new Set([
    ...matched.flatMap((intent) => intent.words),
    ...NOUNS.filter(([pattern]) => pattern.test(need)).flatMap(([, list]) => list),
    ...need.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2),
  ]);
  return tools
    .map((tool) => {
      const tokens = nameTokens(tool.name);
      const overlap = tokens.filter((token) => [...words].some((word) => token.startsWith(word) || word.startsWith(token))).length;
      return { tool, score: (capabilities.get(tool.capability) ?? 0) * 10 + overlap * 3 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
}

/** The person's own verified connectors (business owner) in this market and their authorized tools. */
async function ownAuthorizedTools(actorId: string, marketId: string) {
  const integrations = await db
    .select({ id: connectIntegrations.id, name: connectIntegrations.name, lifecycle: connectIntegrations.lifecycle, status: connectIntegrations.status })
    .from(connectIntegrations)
    .innerJoin(connectPartners, eq(connectPartners.id, connectIntegrations.partnerId))
    .innerJoin(businessProfiles, eq(businessProfiles.id, connectPartners.businessId))
    .where(and(eq(businessProfiles.ownerUserId, actorId), eq(connectPartners.marketId, marketId), eq(connectIntegrations.kind, "API"), eq(connectIntegrations.status, "APPROVED"), eq(connectIntegrations.lifecycle, "VERIFIED")));
  if (!integrations.length) return [];
  const tools = await db.select().from(connectTools).where(and(inArray(connectTools.integrationId, integrations.map((row) => row.id)), eq(connectTools.status, "AUTHORIZED")));
  const names = new Map(integrations.map((row) => [row.id, row.name]));
  return tools.map((tool) => ({ ...tool, connectorName: names.get(tool.integrationId) ?? "" }));
}

/** Model tool: up to five authorized tools for this need, as names and capabilities only. */
export async function findConnectTools(input: { actorId: string; market: ConnectMarket; need: string }) {
  const tools = await ownAuthorizedTools(input.actorId, input.market.id);
  const ranked = rankTools(input.need, tools);
  const views = new Map(modelToolView(ranked.map((entry) => entry.tool)).map((view) => [view.toolId, view]));
  return {
    connectedSystems: new Set(tools.map((tool) => tool.integrationId)).size,
    tools: ranked.map((entry) => {
      const tool = entry.tool;
      const operation = tool.operation as { inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } } | null;
      return {
        ...views.get(tool.id)!,
        connector: tool.connectorName.slice(0, 60),
        // Argument names and types only (owner-reviewed), never provider descriptions.
        arguments: Object.fromEntries(Object.entries(operation?.inputSchema?.properties ?? {}).slice(0, 20).map(([key, value]) => [key, value?.type ?? "value"])),
        requiredArguments: operation?.inputSchema?.required ?? [],
      };
    }),
    note: tools.length
      ? "أدوات معتمدة من صاحب النشاط فقط. القراءة تُنفّذ مباشرة؛ أي تغيير (حجز، إنشاء، إلغاء، دفع) يظهر للمستخدم بطاقة تأكيد ولا يُنفّذ قبل تأكيده."
      : "لا يوجد نظام موصول وموثّق بأدوات معتمدة لهذا الحساب.",
  };
}

/**
 * Model tool: uses one tool returned by `findConnectTools`. The model's arguments are validated by
 * the Stage 3 entry; a write returns a confirmation card for the person, never a success.
 */
export async function useConnectTool(input: { actorId: string; market: ConnectMarket; toolId: string; arguments: Record<string, unknown>; network?: import("./network").ConnectNetwork }): Promise<ToolCallResult & { connector?: string }> {
  const tools = await ownAuthorizedTools(input.actorId, input.market.id);
  const tool = tools.find((item) => item.id === input.toolId);
  // A tool id the router did not offer this person (another business, revoked, unverified) is refused.
  if (!tool) return { status: "REFUSED", refusal: "TOOL_NOT_AVAILABLE" };
  const result = await callConnectTool({ actorId: input.actorId, market: input.market, integrationId: tool.integrationId, toolName: tool.name, arguments: input.arguments, network: input.network });
  if (result.status === "EXECUTED" && result.access === "WRITE") throw new Error("ROUTER_EXECUTED_WRITE"); // structurally impossible: guarded
  return { ...result, connector: tool.connectorName };
}

