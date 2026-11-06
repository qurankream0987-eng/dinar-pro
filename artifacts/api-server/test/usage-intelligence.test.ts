/**
 * USAGE-INTELLIGENCE — the AI allowance question family (built on the AI-FOUNDATION-01 harness) — scripted acceptance over real HTTP, PostgreSQL and the production turn
 * runtime. A deterministic gateway stands in for a provider: these cases prove orchestration,
 * canonical tool boundaries, authorization re-checks and persistence. They do not prove the
 * language quality of a live provider (LIVE_PROVIDER_NOT_VERIFIED).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { aiResultSets, cartItems, carts, db, messages, orders, pool } from "@workspace/db";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import {
  MODEL_LOOP_TOOL_ALLOWLIST,
  executeModelTool,
  modelToolDefinitions,
  ToolRejectedError,
} from "../src/ai/tool-registry";
import {
  CAPABILITY_NAMES,
  CAPABILITY_REGISTRY,
  LIVE_PROVIDER_STATUS,
  MODEL_TOOL_CAPABILITIES,
} from "../src/ai/capability-registry";
import { marketFor } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_AI_FOUNDATION");
// Intelligence reads: DINAR Connect discovery and self-knowledge exposed as model tools.
const run = `ن${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

type Step = { name: string; arguments: Record<string, unknown> };
const script: Array<{
  key: string;
  reply?: string;
  toolSequence?: Step[];
  delayAfterFeedbackMs?: number;
  failAfterFeedback?: boolean;
  afterSearch?: () => Promise<void>;
}> = [];
const toolSequenceCalls = new Map<string, number>();
let calls = 0;
let unavailable = false;
let sawUntrustedRule = false;
let observedToolNames: string[] = [];
let matchedScriptKey = "";
let lastFeedback: any[] = [];
let lastFeedbackRaw = "";
let lastPromptText = "";

const gateway: ConversationModelGateway = {
  async proposeToolCall(messages, tools) {
    calls++;
    observedToolNames = tools.map((tool) => tool.name);
    if (unavailable) throw new AIProviderError("OPENAI", "UNAVAILABLE", "scripted");
    sawUntrustedRule = messages.some(
      (message) =>
        message.role === "system" &&
        String(message.content).includes("<dinar_tool_results>") &&
        String(message.content).includes("untrusted listing data"),
    );
    const user = [...messages].reverse().find((message) => message.role === "user");
    const text = String(user?.content ?? "");
    lastPromptText = text;
    const entry = script.find((item) => text.includes(item.key));
    matchedScriptKey = entry?.key ?? "";
    const feedbackMatch = text.match(/<dinar_tool_results>([\s\S]*?)<\/dinar_tool_results>/u);
    lastFeedbackRaw = feedbackMatch?.[1] ?? "[]";
    try {
      lastFeedback = JSON.parse(lastFeedbackRaw);
    } catch {
      lastFeedback = [];
    }
    const sawVerifiedRead = lastFeedback.some((item) => item.status === "SUCCEEDED");
    if (entry?.afterSearch && sawVerifiedRead) {
      const hook = entry.afterSearch;
      entry.afterSearch = undefined;
      await hook();
    }
    if (entry?.failAfterFeedback && sawVerifiedRead)
      throw new AIProviderError("OPENAI", "UNAVAILABLE", "scripted outage");
    if (entry?.delayAfterFeedbackMs && sawVerifiedRead)
      await new Promise((resolve) => setTimeout(resolve, entry.delayAfterFeedbackMs));
    if (entry?.toolSequence?.length) {
      const index = toolSequenceCalls.get(entry.key) ?? 0;
      const step = entry.toolSequence[index];
      if (step) {
        toolSequenceCalls.set(entry.key, index + 1);
        let args = { ...step.arguments };
        if (args.fromLatestSearch === true) {
          const priorSearch = [...lastFeedback]
            .reverse()
            .find((item) => item.tool === "searchListings" && item.status === "SUCCEEDED")?.result;
          delete args.fromLatestSearch;
          if (priorSearch?.resultSetId)
            args = step.name === "compareListings"
              ? { resultSetId: priorSearch.resultSetId, positions: args.positions }
              : { resultSetId: priorSearch.resultSetId, resourceId: args.resourceId ?? priorSearch.listings?.[0]?.id };
        }
        return { id: "scripted-tool", name: step.name, arguments: JSON.stringify(args) };
      }
    }
    return {
      id: "scripted",
      name: "dinarConversationTurn",
      arguments: JSON.stringify({
        responseKind: "CONVERSATIONAL_RESPONSE",
        confidence: 0.8,
        conversationalReply: entry?.reply ?? "MODEL_REPLY",
      }),
    };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return {
    status: response.status,
    data,
    text,
    cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "",
  };
}

let phone = 0;
async function register(name: string) {
  // JO mobile numbers are 7[789] + 7 digits; a fixed 79 prefix keeps every generated number valid.
  const number = `79${String((Date.now() + 7919 * phone++) % 10_000_000).padStart(7, "0")}`;
  const password = "ai-foundation-password-1";
  const created = await request("/auth/register", "POST", {
    displayName: name,
    phoneCountryCode: "+962",
    phoneNumber: number,
    accountCountry: "JO",
    password,
    confirmPassword: password,
    acceptTerms: true,
  });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}

const seller = await register("بائع الأساس الذكي");
const ids: Record<string, string> = {};
async function publish(key: string, title: string, price: string, description = `${title} بحالة جيدة`) {
  const created = await request("/listings", "POST", {
    title,
    description,
    category: "إلكترونيات",
    categoryId: "electronics",
    area: "خلدا",
    city: "عمان",
    attributes: { condition: "مستعمل", brand: "DINAR" },
    unitPrice: price,
    inventoryMode: "LIMITED",
    availableQuantity: 5,
    fulfilmentType: "PICKUP",
    pricingMode: "FIXED",
    imageUrl: "",
    imageUrls: [],
    clientRequestId: randomUUID(),
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish("pixel", `جوال بكسل 7 ${run}`, "180");
await publish("redmi", `جوال ريدمي نوت ${run}`, "120");

type Reply = {
  status: number;
  body: string;
  payload: any;
  listingIds: string[];
};
async function say(cookie: string, conv: string, message: string, clientMessageId = randomUUID()): Promise<Reply> {
  calls = 0;
  observedToolNames = [];
  sawUntrustedRule = false;
  lastPromptText = "";
  lastFeedback = [];
  lastFeedbackRaw = "[]";
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ message, clientMessageId }),
  });
  const raw = await response.text();
  const complete = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } })
    .find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  const payload = blocks.find((block: any) => block.payload?.surface)?.payload ?? blocks[0]?.payload ?? {};
  return {
    status: response.status,
    body: String(complete?.assistantMessage?.body ?? ""),
    payload,
    listingIds: ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id),
  };
}

const fresh = async () => {
  const user = await register(`مستخدم ${randomUUID().slice(0, 4)}`);
  const conv = (await request("/ai/conversations", "POST", {}, user.cookie)).data.id as string;
  return { ...user, conv };
};
const cartLines = async (userId: string) => {
  const [cart] = await db.select().from(carts).where(eq(carts.userId, userId));
  return cart ? (await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).length : 0;
};
const orderLines = async (userId: string) =>
  (await db.select().from(orders).where(eq(orders.buyerId, userId))).length;
const resultSetsFor = async (messageId: string) =>
  db.select().from(aiResultSets).where(eq(aiResultSets.messageId, messageId));
const withEnv = async <T>(key: string, value: string, body: () => Promise<T>): Promise<T> => {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};


/**
 * Each case records who interpreted the utterance: the deterministic layer (no model call)
 * or the model (scripted here, so only routing is measured, not live language quality).
 * `expect` names what must hold; `prefer` is "MODEL" where understanding needs semantics.
 */

const accounts: Awaited<ReturnType<typeof fresh>>[] = [];
const conversationFor = async (slot: number) => {
  accounts[slot] ??= await fresh();
  const conv = (await request("/ai/conversations", "POST", {}, accounts[slot]!.cookie)).data.id as string;
  return { ...accounts[slot]!, conv };
};
const probe = async (slot: number, text: string, tools?: Step[], before?: string) => {
  const user = await conversationFor(slot);
  if (before) await say(user.cookie, user.conv, before);
  // The runtime removes a leading address («يا دينار،») before the model reads the message.
  const key = text.replace(/^\s*(?:يا\s+)?دينار[،,\s]*/u, "");
  script.unshift({ key, reply: "MODEL_PROSE", ...(tools ? { toolSequence: tools } : {}) });
  toolSequenceCalls.delete(key);
  const result = await say(user.cookie, user.conv, text);
  return { user, result, modelCalled: calls > 0, surface: result.payload.surface ?? result.payload.kind ?? "TEXT", feedback: [...lastFeedback] };
};
const rows: Record<string, unknown>[] = [];
const record = (id: string, text: string, outcome: Awaited<ReturnType<typeof probe>>) =>
  rows.push({ id, text, interpretedBy: outcome.modelCalled ? "MODEL" : "DETERMINISTIC", surface: outcome.surface, tools: outcome.feedback.filter((item) => item.status === "SUCCEEDED").map((item) => item.tool) });

const PARAPHRASES = [
  "دينار، كم تبقّى من استهلاكي؟", "كم باقي لي من حصتي؟", "استهلكت كم اليوم؟", "متى ترجع لي الرسائل؟",
  "ليش الذكاء وقف عندي؟", "هل أقدر أستخدم الذكاء أكثر؟", "كم باقي من استخدامي هذا الشهر؟",
  // Held out: never used while building the deterministic pattern.
  "كم ضايل إلي؟", "شو استهلكت من الذكاء؟", "عندي مجال أسألك أكثر؟", "هل خلص رصيدي من الرسائل؟", "يا دينار شوفلي اللي باقي بحسابي",
];

for (const [index, text] of PARAPHRASES.entries()) {
  await test(`USG-P${index + 1} ${text}`, async () => {
    // A capable model that does not recognise a fixed phrase still has the grounded read.
    const outcome = await probe(index % 4, text, [{ name: "readAiUsage", arguments: {} }]);
    record(`P${index + 1}`, text, outcome);
    assert.equal(outcome.result.status, 200, outcome.result.body);
    assert.equal(outcome.surface, "AI_USAGE", `${text} → ${outcome.surface} ${JSON.stringify({ key: matchedScriptKey, prompt: lastPromptText.slice(-200), feedback: outcome.feedback, body: outcome.result.body.slice(0, 200) })}`);
    assert.doesNotMatch(outcome.result.body, /MODEL_PROSE_FABRICATED_NUMBER/u);
  });
}

await test("USG-A1 a bare «كم باقي؟» from a buyer with no context is not the seller's listings", async () => {
  const outcome = await probe(1, "كم باقي؟");
  record("A1", "كم باقي؟", outcome);
  assert.notEqual(outcome.surface, "MY_LISTINGS", "a buyer who sells nothing is not shown seller inventory");
  assert.notEqual(outcome.surface, "AI_USAGE", "an ambiguous «how much is left» is not silently read as the AI allowance");
});

await test("USG-A2 «كم باقي منه؟» right after a search answers the stock of the listing in view", async () => {
  const outcome = await probe(2, "كم باقي منه؟", undefined, `ابحث عن جوال ${run}`);
  record("A2", "كم باقي منه؟", outcome);
  assert.notEqual(outcome.surface, "MY_LISTINGS");
  assert.match(outcome.result.body, /5|متوفر|المتاح|الكمية|متبقي|اختر|أي/u, outcome.result.body.slice(0, 300));
});

await test("USG-C2 «يكفيني حتى نهاية الأسبوع؟» is answered deterministically and refuses to guess without data", async () => {
  const outcome = await probe(3, "هل استهلاكي يكفيني حتى نهاية الأسبوع؟");
  record("C2", "هل استهلاكي يكفيني حتى نهاية الأسبوع؟", outcome);
  assert.equal(outcome.modelCalled, false, "no paid call for a usage question");
  assert.equal(outcome.surface, "AI_USAGE");
  assert.match(outcome.result.body, /لا تتوفر بيانات استخدام كافية|تقديريًا/u, outcome.result.body.slice(0, 300));
  assert.match(outcome.result.body, /حتى نهاية الأسبوع/u);
});

await test("USG-C1 «allowance, then my late orders» runs as a bounded two-step plan: usage first, orders on «التالي»", async () => {
  const user = await conversationFor(0);
  // The planner splits the compound request; the model interprets the ambiguous first step.
  script.unshift({ key: "احسب لي المتبقي", reply: "MODEL_PROSE", toolSequence: [{ name: "readAiUsage", arguments: {} }] });
  toolSequenceCalls.delete("احسب لي المتبقي");
  const first = await say(user.cookie, user.conv, "احسب لي المتبقي وبعدها ورني طلباتي المتأخرة");
  const firstSurface = first.payload.surface ?? first.payload.kind;
  rows.push({ id: "C1a", interpretedBy: calls > 0 ? "MODEL" : "DETERMINISTIC", surface: firstSurface, tools: lastFeedback.filter((item) => item.status === "SUCCEEDED").map((item) => item.tool) });
  assert.equal(firstSurface, "AI_USAGE", first.body.slice(0, 300));
  assert.match(first.body, /الخطوة التالية من طلبك: «ورني طلباتي المتأخرة»/u, "the orders step is queued, not dropped");
  assert.equal(first.listingIds.length, 0, "no product search");
  const second = await say(user.cookie, user.conv, "التالي");
  const secondSurface = second.payload.surface ?? second.payload.kind;
  rows.push({ id: "C1b", interpretedBy: calls > 0 ? "MODEL" : "DETERMINISTIC", surface: secondSurface });
  assert.match(String(secondSurface), /ORDER/u, `${secondSurface}: ${second.body.slice(0, 200)}`);
});

await test("USG-G the card's numbers are the server ledger's numbers; the model cannot pass an identity or an unbounded horizon", async () => {
  const user = await conversationFor(0);
  const { aiUsageSummary } = await import("../src/ai/../lib/ai-usage");
  const market = await marketFor({ actor: { activeMarketId: "JO" }, cookies: {} } as any);
  const ledger = await aiUsageSummary({ kind: "USER", userId: user.id, market } as any);
  const context = { actorId: user.id, conversationId: user.conv, currentMessageId: randomUUID(), market };
  const read = await executeModelTool("readAiUsage", "{}", context as any);
  const usage = read.result.aiUsage as any;
  const text = ledger.resources.find((item: any) => item.resource === "TEXT_REQUEST")!;
  const reported = usage.resources.find((item: any) => item.resource === "TEXT_REQUEST");
  assert.deepEqual([reported.used, reported.limit, reported.remaining], [text.used, text.limit, text.remaining]);
  assert.match(usage.note, /not any AI provider's balance/u);
  for (const bad of [JSON.stringify({ userId: "someone-else" }), JSON.stringify({ horizonDays: 90 }), JSON.stringify({ question: "DELETE" })]) {
    const outcome = await executeModelTool("readAiUsage", bad, context as any).then(() => "ran", (error) => error.code);
    assert.equal(outcome, "CANONICAL_TOOL_REJECTED", bad);
  }
});

await test("USG-F the projection is arithmetic on real pace and refuses to project without data", async () => {
  const { usageProjection } = await import("../src/ai/usage-turn");
  const period = { start: "2026-11-01T00:00:00.000Z", renewsAt: "2026-12-01T00:00:00.000Z" };
  const now = new Date("2026-11-11T00:00:00.000Z"); // 10 of 30 days elapsed
  assert.deepEqual(usageProjection({ used: 0, limit: 100, remaining: 100 }, period, now), { kind: "INSUFFICIENT_DATA", reason: "NO_USE_YET" });
  assert.deepEqual(usageProjection({ used: 5, limit: 100, remaining: 95 }, period, new Date("2026-11-01T02:00:00.000Z")), { kind: "INSUFFICIENT_DATA", reason: "PERIOD_TOO_YOUNG" });
  const steady = usageProjection({ used: 30, limit: 100, remaining: 70 }, period, now);
  assert.equal(steady.kind, "PROJECTED");
  if (steady.kind === "PROJECTED") assert.deepEqual([steady.projectedUseAtEnd, steady.likelyToRunOut], [90, false]);
  const heavy = usageProjection({ used: 50, limit: 100, remaining: 50 }, period, now);
  if (heavy.kind === "PROJECTED") assert.deepEqual([heavy.projectedUseAtEnd, heavy.likelyToRunOut], [150, true]);
  const week = usageProjection({ used: 30, limit: 100, remaining: 70 }, period, now, new Date("2026-11-18T00:00:00.000Z"));
  if (week.kind === "PROJECTED") assert.deepEqual([week.projectedUseAtEnd, week.untilLabel], [51, "REQUESTED_DATE"]);
});

after(async () => {
  console.log(`USAGE_INTELLIGENCE ${JSON.stringify(rows)}`);
  server.close();
  await pool.end();
});
