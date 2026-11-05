/**
 * INTELLIGENCE-01 (built on the AI-FOUNDATION-01 harness) — scripted acceptance over real HTTP, PostgreSQL and the production turn
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

const turn = async (text: string, toolSequence: Step[], reply = "MODEL_PROSE") => {
  const user = await fresh();
  script.unshift({ key: text, reply, toolSequence });
  toolSequenceCalls.delete(text);
  const result = await say(user.cookie, user.conv, text);
  return { user, result };
};

test("INT-01 an indirect website-address request reaches Connect domain search through the model, not a keyword", async () => {
  const text = `بفتح متجر عطور ${run} وأبي عنوان حلو له على الإنترنت`;
  assert.equal(/دومين|نطاق|domain/iu.test(text), false, "the utterance never names the capability");
  const { user, result } = await turn(text, [{ name: "searchDomains", arguments: { name: "oudhouse" } }]);
  assert.equal(result.status, 200, result.body);
  assert.equal(matchedScriptKey, text);
  assert.ok(observedToolNames.includes("searchDomains"));
  assert.equal(result.payload.surface, "CONNECT_RESULTS", JSON.stringify(result.payload).slice(0, 400));
  const cards = result.payload.universalCards.cards as any[];
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.equal(card.commerceMode, "EXTERNAL_REFERRAL");
    assert.equal(card.domain.domain, "oudhouse.com");
  }
  assert.equal(await cartLines(user.id), 0);
  assert.equal(await orderLines(user.id), 0, "a referral never creates an internal order");
});

test("INT-02 'can DINAR book?' is answered from the server capability list and partner search, never invented", async () => {
  const text = `تقدر تحجز لي موعد صيانة ${run}؟`;
  const { user, result } = await turn(text, [
    { name: "describeDinarCapabilities", arguments: {} },
    { name: "searchPartnerOffers", arguments: { query: "صيانة" } },
  ]);
  assert.equal(result.status, 200, result.body);
  const capabilities = lastFeedback.find((item) => item.tool === "describeDinarCapabilities");
  assert.equal(capabilities?.status, "SUCCEEDED");
  assert.equal(capabilities.result.kind, "DINAR_CAPABILITIES");
  assert.ok(capabilities.result.notAvailable.some((row: any) => /حجز/u.test(row.topic)), "booking is listed as not available");
  assert.ok(capabilities.result.available.some((row: any) => row.name === "searchListings"));
  assert.equal(result.payload.surface, "CONNECT_RESULTS");
  assert.equal(result.payload.universalCards.cards.length, 0, "no reviewed partner exists in this database; none is invented");
  assert.equal(await orderLines(user.id), 0);
});

test("INT-03 malformed or unsafe tool arguments are rejected by the server, not executed", async () => {
  const text = `افحص لي العنوان ${run}`;
  const { result } = await turn(text, [{ name: "searchDomains", arguments: { domain: "http://user:pw@evil.example/path" } }]);
  assert.equal(result.status, 200, result.body);
  assert.notEqual(result.payload.surface, "CONNECT_RESULTS", "an unsafe domain is never searched");
  assert.ok(lastFeedback.some((item) => item.tool === "searchDomains" && item.status === "REJECTED"));
  const extra = await turn(`${text} مرة ثانية`, [{ name: "searchDomains", arguments: { domain: "a.com", injected: "x" } }]);
  assert.equal(extra.result.status, 200);
  assert.ok(lastFeedback.some((item) => item.tool === "searchDomains" && item.status === "REJECTED"));
});

test("INT-04 negation: 'show prices only' reads but never writes the cart", async () => {
  const text = `لا تضيف شي للسلة، بس ورني أسعار جوال ${run}`;
  const { user, result } = await turn(text, [{ name: "searchListings", arguments: { query: `جوال ${run}` } }]);
  assert.equal(result.status, 200, result.body);
  assert.ok(result.listingIds.length > 0, JSON.stringify({ matchedScriptKey, calls, body: result.body, surface: result.payload.surface, kind: result.payload.kind, feedback: lastFeedback }).slice(0, 900));
  assert.equal(await cartLines(user.id), 0);
  assert.equal(observedToolNames.includes("addToCart"), false, "the direct cart write is never advertised");
});

test("INT-05 every advertised tool is a registered capability and the new reads are read-only", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" }, cookies: {} } as any);
  const advertised = modelToolDefinitions({ actorId: "x", conversationId: "y", market }, ["BUYER"]).map((tool) => tool.name);
  const registered = new Set(Object.values(CAPABILITY_REGISTRY).map((definition) => definition.toolName));
  for (const name of advertised) assert.ok(registered.has(name), `${name} is registered`);
  for (const name of ["searchExternalDomains", "searchConnectPartners", "describeCapabilities"] as const) {
    assert.equal(CAPABILITY_REGISTRY[name].mutation, "READ_ONLY");
    assert.equal(CAPABILITY_REGISTRY[name].availability, "MODEL_TOOL");
  }
  for (const name of ["searchDomains", "searchPartnerOffers", "describeDinarCapabilities"])
    assert.ok((MODEL_LOOP_TOOL_ALLOWLIST as readonly string[]).includes(name));
});

test("INT-06 business overview and order issues are the actor's own rows only", async () => {
  // The seller published two listings above but owns no D3 business: the overview is empty, not invented.
  const sellerConv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id as string;
  const text = `كيف أداء نشاطي ${run}؟`;
  script.unshift({ key: text, reply: "OVERVIEW", toolSequence: [{ name: "readBusinessOverview", arguments: {} }] });
  toolSequenceCalls.delete(text);
  const overview = await say(seller.cookie, sellerConv, text);
  assert.equal(overview.status, 200, overview.body);
  const read = lastFeedback.find((item) => item.tool === "readBusinessOverview");
  assert.equal(read?.status, "SUCCEEDED");
  assert.deepEqual(read.result.businesses, []);

  const buyer = await fresh();
  const issues = `وين وصل استرجاع فلوسي ${run}؟`;
  script.unshift({ key: issues, reply: "ISSUES", toolSequence: [{ name: "readOrderIssues", arguments: {} }] });
  toolSequenceCalls.delete(issues);
  const issueReply = await say(buyer.cookie, buyer.conv, issues);
  assert.equal(issueReply.status, 200, issueReply.body);
  const issueRead = lastFeedback.find((item) => item.tool === "readOrderIssues");
  assert.equal(issueRead?.status, "SUCCEEDED");
  assert.deepEqual(issueRead.result.orders, [], "a new buyer has no disputes or refunds; none are invented");
  assert.match(issueRead.result.note, /REFUND_SUCCEEDED/u);
  const direct = await executeModelTool("readOrderIssues", "{\"actorId\":\"someone-else\"}", { actorId: buyer.id, conversationId: buyer.conv, currentMessageId: "x", market: await marketFor({ actor: { activeMarketId: "JO" }, cookies: {} } as any) }).then(() => "ran", (error) => error.code);
  assert.equal(direct, "CANONICAL_TOOL_REJECTED", "the model cannot pass an actor id");
});

after(async () => {
  server.close();
  await pool.end();
});
