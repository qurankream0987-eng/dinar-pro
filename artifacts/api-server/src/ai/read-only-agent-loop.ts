/**
 * AI-04 — Bounded Read-Only Autonomous Tool Loop (ReAct / Parallel Read-Only Tool Execution).
 * Feature-flagged (DINAR_AI_READONLY_LOOP=1). Chains up to MAX_HOPS read-only tools in one turn
 * (e.g., search + compare + seller trust + stock check) while HARD-BLOCKING any write/money tool.
 */

export const MAX_AGENT_HOPS = 4;
export const MAX_AGENT_TOOL_CALLS = 8;
export const DEFAULT_AGENT_TIMEOUT_MS = 6000;

export const READ_ONLY_TOOL_ALLOWLIST = new Set([
  "search_listings",
  "get_listing_facts",
  "compare_listings",
  "check_listing_stock",
  "get_seller_rating",
  "get_market_status",
  "get_order_status",
  "recall_conversation_history",
  "get_usage_quota",
]);

const WRITE_OR_MONEY_PATTERN = /(?:create|update|delete|publish|confirm|pay|checkout|charge|refund|cancel|accept|reject|send_message|place_order|transfer|withdraw)/i;

export function isReadOnlyAgentLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DINAR_AI_READONLY_LOOP?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function isSafeReadOnlyTool(toolName: string): boolean {
  if (WRITE_OR_MONEY_PATTERN.test(toolName)) return false;
  return READ_ONLY_TOOL_ALLOWLIST.has(toolName);
}

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolResult {
  id: string;
  name: string;
  status: "OK" | "BLOCKED_REQUIRES_CONFIRMATION" | "ERROR";
  data?: unknown;
  error?: string;
}

export type AgentPlannerStep =
  | { kind: "FINAL"; reply: string }
  | { kind: "TOOLS"; calls: AgentToolCall[] };

export interface ReadOnlyLoopOutcome {
  status: "COMPLETED" | "BLOCKED_WRITE_ATTEMPT" | "HOP_LIMIT_REACHED" | "TIMEOUT";
  reply?: string;
  hops: number;
  blockedTools: string[];
  trace: AgentToolResult[];
}

export async function runBoundedReadOnlyLoop(input: {
  planNext: (hop: number, trace: AgentToolResult[]) => Promise<AgentPlannerStep>;
  executeReadOnlyTool: (call: AgentToolCall) => Promise<unknown>;
  maxHops?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}): Promise<ReadOnlyLoopOutcome> {
  const maxHops = Math.max(1, Math.min(MAX_AGENT_HOPS, input.maxHops ?? MAX_AGENT_HOPS));
  const maxCalls = Math.max(1, Math.min(MAX_AGENT_TOOL_CALLS, input.maxToolCalls ?? MAX_AGENT_TOOL_CALLS));
  const deadline = Date.now() + Math.max(500, input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);

  const trace: AgentToolResult[] = [];
  const blockedTools: string[] = [];
  let totalCalls = 0;

  for (let hop = 1; hop <= maxHops; hop++) {
    if (Date.now() > deadline) {
      return { status: "TIMEOUT", hops: hop - 1, blockedTools, trace };
    }
    const step = await input.planNext(hop, trace);
    if (step.kind === "FINAL") {
      return { status: "COMPLETED", reply: step.reply, hops: hop, blockedTools, trace };
    }

    const unsafe = step.calls.filter((c) => !isSafeReadOnlyTool(c.name));
    if (unsafe.length > 0) {
      for (const u of unsafe) {
        blockedTools.push(u.name);
        trace.push({ id: u.id, name: u.name, status: "BLOCKED_REQUIRES_CONFIRMATION", error: "Write or financial actions require explicit user confirmation." });
      }
      return { status: "BLOCKED_WRITE_ATTEMPT", hops: hop, blockedTools, trace };
    }

    const remaining = maxCalls - totalCalls;
    const batch = step.calls.slice(0, Math.max(0, remaining));
    if (batch.length === 0) {
      return { status: "HOP_LIMIT_REACHED", hops: hop, blockedTools, trace };
    }
    totalCalls += batch.length;

    const results = await Promise.all(
      batch.map(async (call): Promise<AgentToolResult> => {
        try {
          const data = await input.executeReadOnlyTool(call);
          return { id: call.id, name: call.name, status: "OK", data };
        } catch (err) {
          return { id: call.id, name: call.name, status: "ERROR", error: err instanceof Error ? err.message : "Tool failed" };
        }
      }),
    );
    trace.push(...results);
  }

  return { status: "HOP_LIMIT_REACHED", hops: maxHops, blockedTools, trace };
}
