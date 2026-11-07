/**
 * MULTISTEP-INTELLIGENCE — discovery, compound goals, partner and policy reads (built on the AI-FOUNDATION-01 harness) — scripted acceptance over real HTTP, PostgreSQL and the production turn
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


const succeeded = (feedback: any[]) => feedback.filter((item) => item.status === "SUCCEEDED").map((item) => item.tool);

await test("MS-01 «ماذا تستطيع أن تفعل لي؟» is answered from the registry, filtered by the user's own roles", async () => {
  const outcome = await probe(0, "ماذا تستطيع أن تفعل لي؟", [{ name: "describeDinarCapabilities", arguments: {} }]);
  record("MS-01", "ماذا تستطيع أن تفعل لي؟", outcome);
  const catalog = outcome.feedback.find((item) => item.tool === "describeDinarCapabilities")?.result;
  assert.ok(catalog, JSON.stringify(outcome.feedback).slice(0, 300));
  const names = catalog.available.map((row: any) => row.name);
  for (const expected of ["readAiUsage", "searchListings", "readOrders", "readCart", "readPolicy"]) assert.ok(names.includes(expected), expected);
  assert.equal(names.includes("readSellerDues"), false, "a buyer is not offered seller dues");
  assert.ok(catalog.notAvailable.length > 0, "unsupported tasks are listed");
  assert.ok(catalog.external.some((row: any) => row.name === "searchDomains"));
  // The seller in this suite owns listings: the same question shows seller capabilities.
  const sellerConv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id as string;
  script.unshift({ key: "وش تقدر تسوي لمتجري؟", reply: "MODEL_PROSE", toolSequence: [{ name: "describeDinarCapabilities", arguments: {} }] });
  toolSequenceCalls.delete("وش تقدر تسوي لمتجري؟");
  await say(seller.cookie, sellerConv, "وش تقدر تسوي لمتجري؟");
  const sellerCatalog = lastFeedback.find((item) => item.tool === "describeDinarCapabilities")?.result;
  assert.ok(sellerCatalog.available.some((row: any) => row.name === "readSellerDues"), "a seller is offered seller dues");
});

await test("MS-02 a coffee-business project: name, domain, then designer, as a bounded plan with honest external results", async () => {
  const user = await conversationFor(1);
  const text = "أريد أفتح مشروع قهوة. ساعدني أختار اسمًا، وابحث عن دومين، وبعدها شوف لي مصمم شعار";
  // The planner splits; each step the model interprets uses only real capabilities.
  const steps = [
    // Keyed on each step's distinctive word: the planner trims connectors from step text.
    { key: "اسم", tools: [] as Step[] },
    { key: "دومين", tools: [{ name: "searchDomains", arguments: { name: "qahwahouse" } }] },
    { key: "مصمم", tools: [{ name: "searchPartnerOffers", arguments: { query: "تصميم شعار" } }] },
  ];
  for (const step of steps) {
    script.unshift({ key: step.key, reply: "MODEL_PROSE", toolSequence: step.tools });
    toolSequenceCalls.delete(step.key);
  }
  const outcomes: { surface: string; body: string; tools: string[] }[] = [];
  let reply = await say(user.cookie, user.conv, text);
  outcomes.push({ surface: reply.payload.surface ?? reply.payload.kind ?? "TEXT", body: reply.body, tools: succeeded(lastFeedback) });
  for (let turn = 0; turn < 4 && /الخطوة التالية/u.test(reply.body); turn += 1) {
    reply = await say(user.cookie, user.conv, "التالي");
    outcomes.push({ surface: reply.payload.surface ?? reply.payload.kind ?? "TEXT", body: reply.body, tools: succeeded(lastFeedback) });
  }
  rows.push({ id: "MS-02", steps: outcomes.map((item) => ({ surface: item.surface, tools: item.tools, body: item.body.slice(0, 160) })) });
  const all = outcomes.flatMap((item) => item.tools);
  assert.ok(outcomes.length >= 2, `the goal ran as a plan: ${JSON.stringify(outcomes.map((item) => item.body.slice(0, 80)))}`);
  assert.ok(all.includes("searchDomains"), "the domain step used the real Connect search");
  const domainCard = outcomes.find((item) => item.tools.includes("searchDomains"));
  assert.equal(domainCard?.surface, "CONNECT_RESULTS");
  for (const item of outcomes) assert.doesNotMatch(item.body, /(?:تم|قمت ب)\s*(?:تسجيل|حجز|شراء)\s+(?:النطاق|الدومين|المصمم)/u, "no claim of a purchase or booking");
  assert.equal(await orderLines(user.id), 0);
  assert.equal(await cartLines(user.id), 0);
});

await test("MS-03 «شوف استهلاكي وطلباتي المتأخرة وأخبرني ماذا أحتاج أسوي» reads usage, orders and issues in one bounded turn", async () => {
  const text = "شوف استهلاكي وطلباتي المتأخرة وأخبرني ماذا أحتاج أسوي";
  const outcome = await probe(2, text, [
    { name: "readAiUsage", arguments: {} },
    { name: "readOrders", arguments: {} },
    { name: "readOrderIssues", arguments: {} },
  ]);
  record("MS-03", text, outcome);
  const tools = succeeded(outcome.feedback);
  // Either the deterministic usage route answers first (no paid call) or the model reads all three.
  if (outcome.modelCalled) for (const tool of ["readAiUsage", "readOrders", "readOrderIssues"]) assert.ok(tools.includes(tool), `${tool}: ${JSON.stringify(outcome.feedback).slice(0, 300)}`);
  assert.notEqual(outcome.surface, "SEARCH");
  assert.equal(outcome.result.listingIds.length, 0);
});

await test("MS-04 policy questions are answered from the published policy, not model memory", async () => {
  const outcome = await probe(3, "شو سياسة الاسترجاع عندكم بالضبط؟", [{ name: "readPolicy", arguments: {} }]);
  record("MS-04", "شو سياسة الاسترجاع عندكم بالضبط؟", outcome);
  const listed = outcome.feedback.find((item) => item.tool === "readPolicy");
  assert.equal(listed?.status, "SUCCEEDED", JSON.stringify(outcome.feedback).slice(0, 300));
  assert.ok(listed.result.policies.length >= 3);
  for (const policy of listed.result.policies) assert.ok(policy.key && policy.version && policy.legalReviewStatus);
  const market = await marketFor({ actor: { activeMarketId: "JO" }, cookies: {} } as any);
  const user = await conversationFor(3);
  const key = listed.result.policies[0].key;
  const one = await executeModelTool("readPolicy", JSON.stringify({ key }), { actorId: user.id, conversationId: user.conv, currentMessageId: randomUUID(), market } as any);
  assert.equal((one.result as any).policies.length, 1);
  for (const bad of [JSON.stringify({ key: "../../etc" }), JSON.stringify({ key: "no-such-policy" })]) {
    const code = await executeModelTool("readPolicy", bad, { actorId: user.id, conversationId: user.conv, currentMessageId: randomUUID(), market } as any).then(() => "ran", (error) => error.code);
    assert.notEqual(code, "ran", bad);
  }
});

await test("MS-05 DINAR Connect status: a non-partner gets an honest empty answer; no identity can be passed", async () => {
  const outcome = await probe(0, "وش وضع شراكة شركتي في دينار كونكت؟", [{ name: "readConnectPartnerStatus", arguments: {} }]);
  record("MS-05", "وش وضع شراكة شركتي في دينار كونكت؟", outcome);
  const read = outcome.feedback.find((item) => item.tool === "readConnectPartnerStatus");
  assert.equal(read?.status, "SUCCEEDED");
  assert.deepEqual(read.result.partners, []);
  assert.match(read.result.note, /a click is not revenue/u);
  const user = await conversationFor(0);
  const market = await marketFor({ actor: { activeMarketId: "JO" }, cookies: {} } as any);
  const forged = await executeModelTool("readConnectPartnerStatus", JSON.stringify({ partnerId: randomUUID() }), { actorId: user.id, conversationId: user.conv, currentMessageId: randomUUID(), market } as any).then(() => "ran", (error) => error.code);
  assert.equal(forged, "CANONICAL_TOOL_REJECTED");
});

await test("MS-06 a bare «كم باقي؟» with no context gets one precise clarification, not a guess", async () => {
  const outcome = await probe(1, "كم باقي؟");
  record("MS-06", "كم باقي؟", outcome);
  assert.equal(outcome.surface, "CLARIFY");
  assert.equal(outcome.modelCalled, false);
  assert.ok((outcome.result.body.match(/[؟?]/gu) ?? []).length >= 1, outcome.result.body);
});

await test("MS-07 a refused tool is reported honestly: no success text for a target the server rejects", async () => {
  const text = `افحص لي حالة الطلب ${randomUUID()}`;
  const outcome = await probe(2, text, [{ name: "readFulfillment", arguments: { orderId: randomUUID() } }]);
  record("MS-07", text, outcome);
  const read = outcome.feedback.find((item) => item.tool === "readFulfillment");
  if (outcome.modelCalled) {
    assert.equal(read?.status, "REJECTED", JSON.stringify(outcome.feedback).slice(0, 300));
    assert.doesNotMatch(outcome.result.body, /MODEL_PROSE/u, "the model's prose is withheld when every read was refused");
  }
});

after(async () => {
  console.log(`MULTISTEP_INTELLIGENCE ${JSON.stringify(rows)}`);
  server.close();
  await pool.end();
});
