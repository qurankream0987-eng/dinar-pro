/**
 * JassimAI Phase 2 — the model chooses the form, the server supplies the facts.
 *
 * Real HTTP, PostgreSQL and the production turn runtime with a scripted model gateway keyed on
 * the user's words. This proves the contract: display directives are resolved against DINAR's
 * own records, re-display reuses the stored result set (no new search), misfits are explained,
 * forged or malformed directives change nothing, conversations do not leak, persistence holds,
 * and a change of form never touches the cart or an order. It does NOT prove the judgement of a
 * live model: the scripted gateway stands in for it, and every scripted choice is explicit below.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { aiResultSets, db, orders, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_AI_FOUNDATION");
const run = `ج${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

type Step = { name: string; arguments: Record<string, unknown> };
type Entry = { key: string; reply?: string; display?: unknown; tools?: Step[] };
const script: Entry[] = [];
const toolCalls = new Map<string, number>();
let modelCalls = 0;

const gateway: ConversationModelGateway = {
  async proposeToolCall(messages) {
    modelCalls++;
    const user = [...messages].reverse().find((message) => message.role === "user");
    const text = String(user?.content ?? "");
    // The latest user words win: the prompt also carries earlier turns as context.
    const entry = [...script].filter((item) => text.includes(item.key)).sort((a, b) => text.lastIndexOf(b.key) - text.lastIndexOf(a.key))[0];
    const index = toolCalls.get(entry?.key ?? "") ?? 0;
    const step = entry?.tools?.[index];
    if (entry && step) {
      toolCalls.set(entry.key, index + 1);
      return { id: "scripted-tool", name: step.name, arguments: JSON.stringify(step.arguments) };
    }
    return {
      id: "scripted",
      name: "dinarConversationTurn",
      arguments: JSON.stringify({
        responseKind: "CONVERSATIONAL_RESPONSE",
        confidence: 0.8,
        conversationalReply: entry?.reply ?? "MODEL_REPLY",
        ...(entry && "display" in entry ? { display: entry.display } : {}),
      }),
    };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { server.close(); await pool.end(); });

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}

let phone = 0;
async function register(name: string) {
  const number = `79${String((Date.now() + 7919 * phone++ + 31) % 10_000_000).padStart(7, "0")}`;
  const password = "phase2-display-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}

const seller = await register("بائع المرحلة الثانية");
const ids: Record<string, string> = {};
async function publish(key: string, title: string, price: string, condition: string | null) {
  const created = await request("/listings", "POST", {
    title, description: `${title} بحالة جيدة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { brand: "DINAR", ...(condition ? { condition } : {}) }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 5,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish("pixel", `جوال بكسل 7 ${run}`, "180", "مستعمل");
await publish("redmi", `جوال ريدمي نوت ${run}`, "120", "جديد");
await publish("galaxy", `جوال جالكسي ${run}`, "150", "مستعمل");

type Reply = { blocks: any[]; body: string; listingBlock?: any; surfaceBlock?: any };
async function say(cookie: string, conv: string, message: string): Promise<Reply> {
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ message, clientMessageId: randomUUID() }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } })
    .find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  return {
    blocks,
    body: String(complete?.assistantMessage?.body ?? ""),
    listingBlock: blocks.find((block: any) => block.type === "LISTING_RESULTS"),
    surfaceBlock: blocks.find((block: any) => block.type === "SURFACE"),
  };
}
const cartLines = (data: any): Array<{ listingId: string; quantity: number }> => (Array.isArray(data) ? data : data?.items ?? []);
const resultSetCount = async (conv: string) =>
  Number((await db.select({ value: count() }).from(aiResultSets).where(eq(aiResultSets.conversationId, conv)))[0]?.value ?? 0);
const newConversation = async (cookie: string) => (await request("/ai/conversations", "POST", {}, cookie)).data.id as string;
const ours = (listings: Array<{ id: string }>) => listings.map((listing) => listing.id).filter((id) => Object.values(ids).includes(id));

const buyer = await register("مشتري المرحلة الثانية");
const conv = await newConversation(buyer.cookie);
const searchStep: Step = { name: "searchListings", arguments: { query: `جوال ${run}`, filters: [] } };
const measurements: Record<string, { modelCalls: number; newResultSets: number; cartItems?: number }> = {};
async function measured(name: string, cookie: string, conversation: string, message: string) {
  const before = await resultSetCount(conversation);
  modelCalls = 0;
  const reply = await say(cookie, conversation, message);
  const cart = await request("/cart", "GET", undefined, cookie);
  measurements[name] = { modelCalls, newResultSets: (await resultSetCount(conversation)) - before, cartItems: cartLines(cart.data).length };
  return reply;
}

// 1. A simple question stays text.
script.push({ key: `كيف أكتب إعلانًا جيدًا ${run}`, reply: "اكتب عنوانًا واضحًا، ثم الحالة والسعر والصور.", display: { version: 1, format: "TEXT" } });
// 2. A search the model shows as cards (its default).
script.push({ key: `ساعدني ألاقي جوال مناسب للتصوير ${run}`, reply: "هذه خيارات من عروض DINAR.", tools: [searchStep], display: { version: 1, format: "CARDS" } });
// 3/4/10. Re-display of the same results in other forms, across dialects (the model's choice is scripted).
const tablePhrases = [
  `لا، أبيها بجدول ${run}`, // Gulf
  `طب اعرضها كجدول ${run}`, // Levantine / Jordanian
  `عايزها في جدول ${run}`, // Egyptian
  `حوّل النتائج إلى جدول من فضلك ${run}`, // MSA
  `خلني أشوف الأرقام ${run}`, // non-literal
];
for (const key of tablePhrases) script.push({ key, reply: "هذه النتائج نفسها كجدول.", display: { version: 1, format: "TABLE", scope: "LATEST_RESULTS" } });
script.push({ key: `شو الفرق بين الأول والثاني ${run}`, reply: "هذه مقارنة بين أول عرضين.", display: { version: 1, format: "COMPARISON", scope: "LATEST_RESULTS", positions: [1, 2] } });
script.push({ key: `سوها رسم بياني ${run}`, reply: "حاضر.", display: { version: 1, format: "LINE", scope: "LATEST_RESULTS" } });
script.push({ key: `ما أبي رسم، اشرحها لي بالكلام ${run}`, reply: "الأرخص هو ريدمي نوت.\n\n```dinar-chart {\"items\":[{\"label\":\"a\",\"value\":1},{\"label\":\"b\",\"value\":2}]}```", display: { version: 1, format: "TEXT" } });
script.push({ key: `خليها بشكل حلو ${run}`, reply: "حاضر.", display: { version: 1, format: "HTML", values: [999], html: "<script>1</script>" } });
script.push({ key: `حطها مع أرقامي ${run}`, reply: "حاضر.", display: { version: 1, format: "TABLE", scope: "LATEST_RESULTS", rows: [["جوال", "1 JOD"]] } });

let searchSetId = "";
let searchOrder: string[] = [];

test("P2-01 a normal question is answered as text: no card, no table, no chart", async () => {
  const reply = await measured("text-question", buyer.cookie, conv, `كيف أكتب إعلانًا جيدًا ${run}`);
  assert.match(reply.body, /عنوانًا واضحًا/u);
  assert.equal(reply.blocks.filter((block: any) => block.type === "LISTING_RESULTS" || block.payload?.displaySurface).length, 0);
});

test("P2-02 marketplace results come from a real search and show as DINAR cards", async () => {
  const reply = await measured("search", buyer.cookie, conv, `ساعدني ألاقي جوال مناسب للتصوير ${run}`);
  assert.ok(reply.listingBlock, reply.body);
  searchSetId = reply.listingBlock.payload.resultSetId;
  searchOrder = ours(reply.listingBlock.payload.listings);
  assert.equal(searchOrder.length, 3);
  assert.equal(reply.listingBlock.payload.composition, undefined, "CARDS is the default form");
});

test("P2-03/04/15-19 «show it as a table» in five dialects re-shows the same verified results; nothing is searched again", async () => {
  for (const phrase of tablePhrases) {
    const reply = await measured(`table:${phrase.slice(0, 12)}`, buyer.cookie, conv, phrase);
    assert.ok(reply.listingBlock, `${phrase}: ${reply.body}`);
    assert.equal(reply.listingBlock.payload.composition?.layout, "TABLE", phrase);
    assert.equal(reply.listingBlock.payload.resultSetId, searchSetId, "the same dataset, not a new search");
    assert.deepEqual(ours(reply.listingBlock.payload.listings), searchOrder, "same ids, same order");
    const prices = Object.fromEntries(reply.listingBlock.payload.listings.map((listing: any) => [listing.id, listing.unitPrice]));
    assert.equal(prices[ids.redmi], "120.000");
    assert.equal(measurements[`table:${phrase.slice(0, 12)}`]!.newResultSets, 0, "no new result set");
  }
});

test("P2-03 a comparison of the first two uses the same two records", async () => {
  const reply = await measured("compare", buyer.cookie, conv, `شو الفرق بين الأول والثاني ${run}`);
  const surface = reply.surfaceBlock?.payload;
  assert.equal(surface?.surface, "COMPARISON", reply.body);
  const compared = JSON.stringify(surface.comparison ?? surface);
  assert.ok(compared.includes(searchOrder[0]!) && compared.includes(searchOrder[1]!), "the first two of the stored order");
  assert.ok(!compared.includes(searchOrder[2]!), "only the two asked for");
  assert.equal(measurements.compare!.newResultSets <= 1, true);
});

test("P2-12 a chart of listings that have no time series is explained, not drawn", async () => {
  const reply = await measured("line-misfit", buyer.cookie, conv, `سوها رسم بياني ${run}`);
  assert.ok(reply.listingBlock, reply.body);
  assert.match(reply.body, /ليست أرقامًا عبر الزمن/u);
  assert.equal(reply.listingBlock.payload.composition, undefined, "cards stay; no invented chart");
  assert.equal(reply.blocks.some((block: any) => block.payload?.displaySurface), false);
});

test("P2-11 «explain it in words» strips any model chart from the answer", async () => {
  const reply = await measured("text-only", buyer.cookie, conv, `ما أبي رسم، اشرحها لي بالكلام ${run}`);
  assert.match(reply.body, /الأرخص هو ريدمي نوت/u);
  assert.doesNotMatch(reply.body, /dinar-chart/u);
});

test("P2-21/23/24/26 forged or malformed directives change nothing and never carry data", async () => {
  const forged = await measured("forged-format", buyer.cookie, conv, `خليها بشكل حلو ${run}`);
  assert.equal(forged.blocks.some((block: any) => block.payload?.displaySurface || block.payload?.composition), false);
  assert.doesNotMatch(forged.body, /<script>/u);
  const injected = await measured("forged-rows", buyer.cookie, conv, `حطها مع أرقامي ${run}`);
  assert.equal(injected.blocks.some((block: any) => block.payload?.composition?.layout === "TABLE"), false, "a directive carrying rows is refused whole");
  assert.doesNotMatch(JSON.stringify(injected.blocks), /1 JOD/u);
});

test("P2-13 another conversation has no «latest results» to re-show: nothing leaks across conversations", async () => {
  const other = await newConversation(buyer.cookie);
  const reply = await say(buyer.cookie, other, tablePhrases[0]!);
  assert.equal(reply.listingBlock, undefined, reply.body);
  const stranger = await register("غريب المرحلة الثانية");
  const strangerConv = await newConversation(stranger.cookie);
  const leaked = await say(stranger.cookie, strangerConv, tablePhrases[1]!);
  assert.equal(leaked.listingBlock, undefined);
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, stranger.cookie)).status, 404, "another account cannot read this conversation");
});

test("P2-14 a refreshed conversation restores the table form over live records", async () => {
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  assert.equal(reloaded.status, 200, reloaded.text);
  const blocks = (reloaded.data.messages as any[]).flatMap((message) => message.blocks ?? []);
  const tables = blocks.filter((block) => block.type === "LISTING_RESULTS" && block.payload?.composition?.layout === "TABLE");
  assert.equal(tables.length, tablePhrases.length);
  for (const block of tables) assert.deepEqual(ours(block.payload.listings), searchOrder);
});

test("P2-09/27/28 after a change of form, «ضيف الأول» adds the first stored result once; no order is created", async () => {
  const ordersBefore = Number((await db.select({ value: count() }).from(orders).where(eq(orders.buyerId, buyer.id)))[0]?.value ?? 0);
  const cartBefore = await request("/cart", "GET", undefined, buyer.cookie);
  assert.equal(cartLines(cartBefore.data).length, 0, "changing the form added nothing");
  const asked = await say(buyer.cookie, conv, "ضيف الأول للسلة");
  const afterAsk = await request("/cart", "GET", undefined, buyer.cookie);
  if (!cartLines(afterAsk.data).length) {
    // The existing purchase review asks first; only the owner's «نعم» adds it.
    assert.match(asked.body, /نعم|تأكيد|راجع/u, asked.body);
    await say(buyer.cookie, conv, "نعم");
  }
  const cart = await request("/cart", "GET", undefined, buyer.cookie);
  const items = cartLines(cart.data);
  assert.equal(items.length, 1, JSON.stringify(cart.data));
  assert.equal(items[0]!.listingId, searchOrder[0], "the first result of the stored order");
  const ordersAfter = Number((await db.select({ value: count() }).from(orders).where(eq(orders.buyerId, buyer.id)))[0]?.value ?? 0);
  assert.equal(ordersAfter, ordersBefore, "no order without the purchase review");
});

test("P2-ER an expired result set is never re-shown as current", async () => {
  const fresh = await newConversation(buyer.cookie);
  script.push({ key: `دوّر لي جوالات للمقارنة ${run}`, reply: "هذه خيارات.", tools: [{ name: "searchListings", arguments: { query: `جوال ${run}`, filters: [] } }] });
  const found = await say(buyer.cookie, fresh, `دوّر لي جوالات للمقارنة ${run}`);
  assert.ok(found.listingBlock);
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(aiResultSets.conversationId, fresh), eq(aiResultSets.id, found.listingBlock.payload.resultSetId)));
  const stale = await say(buyer.cookie, fresh, tablePhrases[2]!);
  assert.equal(stale.listingBlock?.payload?.composition?.layout === "TABLE", false, "an expired set is not re-shown");
});

test("P2-MEASURE user effort", () => {
  console.log("PHASE2_MEASUREMENTS", JSON.stringify(measurements));
  for (const phrase of tablePhrases) {
    const entry = measurements[`table:${phrase.slice(0, 12)}`]!;
    assert.equal(entry.newResultSets, 0);
    assert.ok(entry.modelCalls <= 2, `${phrase}: ${entry.modelCalls} model calls`);
  }
});

test("P2-PREF the explicit-format floor reads form requests in several dialects and never captures a sale, a purchase or an item", async () => {
  const { displayPreference } = await import("../src/ai/display-preference");
  const format = (message: string) => displayPreference(message)?.format;
  for (const message of ["طب اعرضها كجدول", "سوها جدول", "عايزها في جدول", "حوّل النتائج إلى جدول", "خليها بجدول"]) assert.equal(format(message), "TABLE", message);
  // Comparisons are left to the existing compare handlers and to the model.
  assert.equal(format("قارن الأول والثاني"), undefined);
  assert.equal(format("شو الفرق بينهم؟"), undefined);
  assert.equal(format("رجعها بطاقات"), "CARDS");
  for (const message of ["اعرض جدول خشب بسعر 50", "ضيف الأول للسلة", "أبي جدول دراسي", "قارن", "ابيع جدولي بسعر 20", "اشتري الأول"]) assert.equal(format(message), undefined, message);
});

test("P2-PERSIST a stored display survives the conversation response contract and the client's composed-surface check", async () => {
  const { GetAiConversationResponse } = await import("@workspace/api-zod");
  const { composeBusinessDisplay } = await import("../src/ai/display-composer");
  const { parseComposedSurface } = await import("@workspace/api-zod/surface-composition");
  const surface = composeBusinessDisplay({ version: 1, format: "LINE", scope: "THIS_TURN" }, { businesses: [{ businessId: "b", name: "x", status: "ACTIVE", verified: true, publishable: true, withheld: [], analytics: { completedOrders: 2, completedRevenue: "3.000", currency: "JOD", completedRevenueMinor: 3000, minorUnitScale: 3, monthly: [{ month: "2026-10", completedOrders: 1, revenueMinor: 1000 }, { month: "2026-11", completedOrders: 1, revenueMinor: 2000 }], byCategory: [] } }] }).surface;
  assert.ok(surface && parseComposedSurface(surface));
  const parsed = GetAiConversationResponse.safeParse({
    conversation: (await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie)).data.conversation,
    messages: [{ id: randomUUID(), actor: "ASSISTANT", body: "x", createdAt: new Date().toISOString(), blocks: [{ type: "SURFACE", version: 1, payload: { resultSetId: randomUUID(), listings: [], surface: "BUSINESS_INSIGHTS", displaySurface: surface } }] }],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 2)));
});
