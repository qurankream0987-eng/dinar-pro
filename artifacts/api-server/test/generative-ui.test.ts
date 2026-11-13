/**
 * GENERATIVE-UI — the model proposes how verified results are shown; the server resolves every
 * position against its own result set and renders typed cards. Real HTTP, PostgreSQL and the
 * production turn runtime with a scripted gateway: this proves the contract, validation,
 * persistence and fallback, not the presentation judgement of a live model.
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
const run = `ج${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

type Step = { name: string; arguments: Record<string, unknown> };
const script: Array<{
  key: string;
  reply?: string;
  presentation?: unknown;
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
        ...(entry && "presentation" in entry ? { presentation: entry.presentation } : {}),
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

const seller = await register("بائع الواجهة التوليدية");
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
await publish("galaxy", `جوال جالكسي ${run}`, "150");

type Reply = {
  blocks: any[];
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
    blocks,
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

const searchStep: Step = { name: "searchListings", arguments: { query: `جوال ${run}`, filters: [] } };
let scenario = 0;
/** One model-routed turn: the scripted model searches, then answers with the given presentation. */
async function proposed(user: { cookie: string; conv: string }, presentation: unknown) {
  const key = `ساعدني أختار جوال مناسب للتصوير رقم${++scenario} ${run}`;
  const entry: (typeof script)[number] = { key, reply: "هذه خيارات من عروض جاسم.", toolSequence: [searchStep] };
  if (presentation !== undefined) entry.presentation = presentation;
  script.unshift(entry);
  return say(user.cookie, user.conv, key);
}
const ours = (reply: Reply) => reply.listingIds.filter((id) => Object.values(ids).includes(id));
const storedOrder = async (resultSetId: string) =>
  (await db.select({ ids: aiResultSets.resourceIds }).from(aiResultSets).where(eq(aiResultSets.id, resultSetId)))[0]?.ids ?? [];

const user = await fresh();
const baseline = await proposed(user, undefined);
const baseOrder = ours(baseline);

await test("G-UI-01/25 without a proposal the typed result card is unchanged", () => {
  assert.equal(baseline.status, 200);
  assert.equal(baseOrder.length, 3, "three verified listings");
  assert.equal(baseline.payload.composition, undefined);
});

await test("G-UI-01 a valid proposal reorders and highlights verified cards; the stored set follows", async () => {
  const reply = await proposed(user, { version: 1, layout: "GRID", positions: [3, 1], highlight: 1 });
  assert.equal(reply.status, 200);
  assert.deepEqual(ours(reply), [baseOrder[2], baseOrder[0]], "only the chosen positions, in the proposed order");
  assert.deepEqual(reply.payload.composition, { source: "MODEL_PROPOSAL", layout: "GRID", highlightId: baseOrder[0] });
  assert.deepEqual(await storedOrder(reply.payload.resultSetId), [baseOrder[2], baseOrder[0]], "ordinals refer to what is shown");
  // G-UI-03: «الثاني» now opens the second card as displayed, not the second of the raw search.
  const second = await say(user.cookie, user.conv, "الثاني");
  assert.ok(JSON.stringify(second.blocks).includes(baseOrder[0]!), "the second displayed card");
  // G-UI-29: after reload the block restores with its composition from the server.
  const restored = await request(`/ai/conversations/${user.conv}`, "GET", undefined, user.cookie);
  const block = restored.data.messages.flatMap((message: any) => message.blocks ?? []).find((item: any) => item.payload?.resultSetId === reply.payload.resultSetId);
  assert.deepEqual(block?.payload?.composition, { source: "MODEL_PROPOSAL", layout: "GRID", highlightId: baseOrder[0] });
});

await test("G-UI-02 a comparison proposal renders DINAR's own comparison of verified listings", async () => {
  const reply = await proposed(user, { version: 1, layout: "COMPARISON", positions: [1, 2], dimensions: ["PRICE", "CONDITION"] });
  assert.equal(reply.status, 200);
  assert.equal(reply.payload.surface, "COMPARISON");
  const compared = JSON.stringify(reply.payload.comparison ?? {});
  assert.ok(compared.includes(baseOrder[0]!) && compared.includes(baseOrder[1]!), compared.slice(0, 300));
});

const rejected: Array<[string, unknown]> = [
  ["G-UI-06 an out-of-range position (invented result)", { version: 1, layout: "GRID", positions: [9] }],
  ["G-UI-18 a non-object proposal", "<div onclick=alert(1)>"],
  ["G-UI-19 an unknown layout", { version: 1, layout: "HTML", positions: [1] }],
  ["G-UI-19 an unexpected property (forged price)", { version: 1, layout: "GRID", positions: [1], price: 1 }],
  ["G-UI-19 an identifier instead of a position", { version: 1, layout: "GRID", positions: ["00000000-0000-4000-8000-000000000000"] }],
  ["G-UI-20 too many items", { version: 1, layout: "LIST", positions: [1, 2, 3, 4, 5, 6, 7] }],
  ["G-UI-20 a duplicate position", { version: 1, layout: "LIST", positions: [1, 1] }],
  ["highlight of a card that is not shown", { version: 1, layout: "LIST", positions: [1], highlight: 2 }],
  ["a comparison of one item", { version: 1, layout: "COMPARISON", positions: [1] }],
  ["an unsupported version", { version: 2, layout: "GRID" }],
];
for (const [name, presentation] of rejected)
  await test(`${name}: the proposal is rejected and the verified typed card is shown unchanged`, async () => {
    const reply = await proposed(user, presentation);
    assert.equal(reply.status, 200);
    assert.equal(reply.payload.composition, undefined, "no composition is stored");
    assert.deepEqual(ours(reply), baseOrder, "the verified results, in DINAR's order");
    assert.equal(reply.payload.surface, undefined, "no other surface was substituted");
  });

await test("G-UI-28 provider failure after a verified search keeps the verified results", async () => {
  const key = `ساعدني أختار جوال مناسب للتصوير عطل ${run}`;
  script.unshift({ key, toolSequence: [searchStep], failAfterFeedback: true });
  const reply = await say(user.cookie, user.conv, key);
  assert.equal(reply.status, 200);
  assert.equal(reply.payload.composition, undefined);
});

await test("G-UI-26/30 the resolver itself: sponsored results are never DINAR's suggestion; nothing authorizes", async () => {
  const { resolvePresentationProposal } = await import("@workspace/api-zod/surface-composition");
  const listings = [{ id: "a" }, { id: "b", isSponsored: true }];
  assert.deepEqual(resolvePresentationProposal({ version: 1, layout: "GRID", highlight: 2 }, listings), { status: "REJECTED", reason: "SPONSORED_HIGHLIGHT" });
  assert.equal(resolvePresentationProposal({ version: 1, layout: "GRID", highlight: 1 }, listings).status, "LAYOUT");
  assert.deepEqual(resolvePresentationProposal(undefined, listings), { status: "NONE" });
  assert.deepEqual(resolvePresentationProposal({ version: 1, layout: "GRID" }, []), { status: "REJECTED", reason: "NO_VERIFIED_RESULTS" });
  // No action, URL, price or style field exists in the contract at all.
  for (const field of ["action", "url", "href", "price", "style", "html", "onClick"])
    assert.equal(resolvePresentationProposal({ version: 1, layout: "GRID", [field]: "x" }, listings).status, "REJECTED", field);
  // Bounded nesting: a proposal is flat; nested objects are not accepted anywhere.
  assert.equal(resolvePresentationProposal({ version: 1, layout: { type: "STACK", children: [] } }, listings).status, "REJECTED");
});

await test("no order, cart line or listing change comes from any presentation", async () => {
  assert.equal((await db.select({ id: orders.id }).from(orders).where(eq(orders.buyerId, user.id))).length, 0);
  const cart = await db.select({ id: carts.id }).from(carts).where(eq(carts.userId, user.id));
  if (cart[0]) assert.equal((await db.select({ id: cartItems.id }).from(cartItems).where(eq(cartItems.cartId, cart[0].id))).length, 0);
});

after(async () => {
  server.close();
  await pool.end();
});
