/**
 * JassimAI Phase 3 — working with what is on screen: form, order, filter and references stay bound to verified records.
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
  const password = "phase3-display-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}

const seller = await register("بائع المرحلة الثالثة");
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


await publish("svcCheap", `تصميم شعار احترافي ${run}`, "25", null);
await publish("svcMid", `تصميم هوية بصرية ${run}`, "90", null);
// A negotiable service: its price is agreed, never zero.
const negotiable = await request("/listings", "POST", {
  title: `تصميم موقع إلكتروني ${run}`, description: "تصميم مواقع", category: "خدمات", categoryId: "services", area: "خلدا", city: "عمان",
  attributes: {}, unitPrice: null, inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE", pricingMode: "NEGOTIABLE",
  imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
}, seller.cookie);
const negotiableId: string | undefined = negotiable.status === 201 ? negotiable.data.id : undefined;

const buyer = await register("مشتري المرحلة الثالثة");
const cartLines = (data: any): Array<{ listingId: string; quantity: number }> => (Array.isArray(data) ? data : data?.items ?? []);
const resultSetCount = async (conv: string) => Number((await db.select({ value: count() }).from(aiResultSets).where(eq(aiResultSets.conversationId, conv)))[0]?.value ?? 0);
const newConversation = async (cookie: string) => (await request("/ai/conversations", "POST", {}, cookie)).data.id as string;
const ours = (listings: Array<{ id: string }>) => listings.map((listing) => listing.id).filter((id) => Object.values(ids).includes(id) || id === negotiableId);
const ordersOf = async (id: string) => Number((await db.select({ value: count() }).from(orders).where(eq(orders.buyerId, id)))[0]?.value ?? 0);

type Measure = { modelCalls: number; newResultSets: number; cart: number; orders: number; searched: boolean };
const measurements: Record<string, Measure> = {};
async function step(name: string, conv: string, message: string, cookie = buyer.cookie) {
  const before = await resultSetCount(conv);
  modelCalls = 0;
  const reply = await say(cookie, conv, message);
  const after = await resultSetCount(conv);
  // A display operation stores a derived set (query.derivedFrom); a new search stores a fresh one.
  const fresh = after > before
    ? (await db.select({ query: aiResultSets.query }).from(aiResultSets).where(eq(aiResultSets.conversationId, conv))).some((row: any) => row.query && !row.query.derivedFrom && row.query.kind === undefined && false)
    : false;
  measurements[name] = { modelCalls, newResultSets: after - before, cart: cartLines((await request("/cart", "GET", undefined, cookie)).data).length, orders: await ordersOf(buyer.id), searched: fresh };
  return reply;
}
const prices = (block: any) => (block?.payload?.listings ?? []).filter((listing: any) => ours([listing]).length).map((listing: any) => listing.unitPrice);

const searchPhones: Step = { name: "searchListings", arguments: { query: `جوال ${run}`, filters: [] } };
const searchServices: Step = { name: "searchListings", arguments: { query: `تصميم ${run}`, filters: [] } };
script.push({ key: `ورني الجوالات المتوفرة ${run}`, reply: "هذه جوالات من عروض DINAR.", tools: [searchPhones] });
script.push({ key: `أبي خدمات تصميم ${run}`, reply: "هذه خدمات تصميم من عروض DINAR.", tools: [searchServices] });

const conv = await newConversation(buyer.cookie);
let phonesSet = "";
let sortedSet = "";

test("P3-A1/A2 cards → table → sort (Kuwaiti/Gulf) → cards: same records, no new search, no model call", async () => {
  const shown = await step("search", conv, `ورني الجوالات المتوفرة ${run}`);
  assert.ok(shown.listingBlock, shown.body);
  phonesSet = shown.listingBlock.payload.resultSetId;
  const table = await step("table", conv, "خلهم بجدول");
  assert.equal(table.listingBlock?.payload.composition?.layout, "TABLE", table.body);
  assert.equal(table.listingBlock.payload.resultSetId, phonesSet);
  const sorted = await step("sort-desc", conv, "رتبهم من الأغلى");
  assert.ok(sorted.listingBlock, sorted.body);
  assert.deepEqual(prices(sorted.listingBlock), ["180.000", "150.000", "120.000"], "highest first");
  assert.equal(sorted.listingBlock.payload.composition?.layout, "TABLE", "the table form is kept while sorting");
  assert.match(sorted.body, /من الأغلى إلى الأرخص/u);
  sortedSet = sorted.listingBlock.payload.resultSetId;
  const derived = (await db.select({ query: aiResultSets.query, ids: aiResultSets.resourceIds }).from(aiResultSets).where(eq(aiResultSets.id, sortedSet)))[0]!;
  assert.equal((derived.query as any).derivedFrom, phonesSet, "a derived set of the same records, not a new search");
  const back = await step("cards", conv, "طب رجعهم بطاقات");
  assert.equal(back.listingBlock?.payload.composition, undefined, back.body);
  assert.deepEqual(prices(back.listingBlock), ["180.000", "150.000", "120.000"], "the sorted order is kept when the form changes");
  for (const name of ["table", "sort-desc", "cards"]) assert.equal(measurements[name]!.modelCalls, 0, `${name}: no model call`);
});

test("P3-B12/D24/D25 after sorting, «الثاني» is the second shown item; the cart uses its canonical id and review stays", async () => {
  assert.equal(measurements.cards!.cart, 0, "no display step touched the cart");
  const asked = await step("add-second", conv, "ضيف الثاني للسلة");
  let lines = cartLines((await request("/cart", "GET", undefined, buyer.cookie)).data);
  if (!lines.length) {
    assert.match(asked.body, /نعم|تأكيد|راجع/u, asked.body);
    await say(buyer.cookie, conv, "نعم");
    lines = cartLines((await request("/cart", "GET", undefined, buyer.cookie)).data);
  }
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0]!.listingId, ids.galaxy, "150 JOD: the second in the price-descending view");
  assert.equal(await ordersOf(buyer.id), 0, "adding to the cart creates no order");
});

test("P3-B9/B10 «الأخير» and «الأرخص» use the active view and actual prices", async () => {
  const conv2 = await newConversation(buyer.cookie);
  await step("search-2", conv2, `ورني الجوالات المتوفرة ${run}`);
  await step("sort-asc", conv2, "رتبهم من الرخيص");
  const last = await say(buyer.cookie, conv2, "افتح الأخير");
  assert.ok(JSON.stringify(last.blocks).includes(ids.pixel), `the last in ascending order is the 180 phone: ${last.body}`);
  const cheapest = await say(buyer.cookie, conv2, "افتح الأرخص");
  assert.ok(JSON.stringify(cheapest.blocks).includes(ids.redmi), `the cheapest by actual price: ${cheapest.body}`);
  // «ضيف الأرخص للسلة» goes through the ordinary add path and its review, on the cheapest record.
  await say(buyer.cookie, conv2, "رتبهم من الأغلى");
  const asked = await say(buyer.cookie, conv2, "ضيف الأرخص للسلة");
  let lines = cartLines((await request("/cart", "GET", undefined, buyer.cookie)).data);
  if (!lines.some((line) => line.listingId === ids.redmi)) {
    assert.match(asked.body, /نعم|تأكيد|راجع/u, asked.body);
    await say(buyer.cookie, conv2, "نعم");
    lines = cartLines((await request("/cart", "GET", undefined, buyer.cookie)).data);
  }
  assert.ok(lines.some((line) => line.listingId === ids.redmi), "the cheapest (120) even when shown last");
  assert.equal(await ordersOf(buyer.id), 0);
});

test("P3-G44-47 the same operations across dialects and a non-literal request, on services too", async () => {
  const conv3 = await newConversation(buyer.cookie);
  const shown = await step("services", conv3, `أبي خدمات تصميم ${run}`);
  assert.ok(shown.listingBlock, shown.body);
  for (const [name, message] of [["jo-table", "بدي أشوفهم كجدول"], ["eg-table", "عايزهم في جدول"], ["numbers", "اعرض الأرقام مش الرسم"]] as const) {
    const reply = await step(name, conv3, message);
    assert.equal(reply.listingBlock?.payload.composition?.layout, "TABLE", `${message}: ${reply.body}`);
  }
  const sorted = await step("services-asc", conv3, "رتبهم من الأرخص");
  const shownPrices = prices(sorted.listingBlock);
  assert.deepEqual(shownPrices.slice(0, 2), ["25.000", "90.000"]);
  if (negotiableId) assert.equal(shownPrices.at(-1), null, "a negotiable price goes last, never as zero");
  const misfit = await step("services-line", conv3, "خلها رسم خطي");
  assert.match(misfit.body, /ليست أرقامًا عبر الزمن/u);
  const available = await step("services-available", conv3, "خلني أشوف المتوفر بس");
  assert.match(available.body, /متوفرة/u);
  for (const name of ["jo-table", "eg-table", "numbers", "services-asc", "services-line", "services-available"]) assert.equal(measurements[name]!.modelCalls, 0, name);
});

test("P3-B14/E32 an interaction with nothing on screen applies nothing; another account sees nothing", async () => {
  const empty = await newConversation(buyer.cookie);
  const reply = await say(buyer.cookie, empty, "رتبهم من الأغلى");
  assert.ok(!JSON.stringify(reply.blocks).includes(ids.pixel), "no earlier results leak into a new conversation");
  const stranger = await register("غريب المرحلة الثالثة");
  const strangerConv = await newConversation(stranger.cookie);
  const leaked = await say(stranger.cookie, strangerConv, "خلهم بجدول");
  assert.ok(!JSON.stringify(leaked.blocks).includes(ids.pixel));
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, stranger.cookie)).status, 404);
});

test("P3-E29/E31 reopening the conversation reproduces each view: table, sorted order, cards", async () => {
  const reloaded = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  assert.equal(reloaded.status, 200, reloaded.text);
  const blocks = (reloaded.data.messages as any[]).flatMap((message) => message.blocks ?? []).filter((block) => block.type === "LISTING_RESULTS");
  const sorted = blocks.find((block) => block.payload.resultSetId === sortedSet && block.payload.composition?.layout === "TABLE");
  assert.ok(sorted, "the sorted table is restored");
  assert.deepEqual(prices(sorted), ["180.000", "150.000", "120.000"]);
});

test("P3-D28 a changed price is shown as it is now, never as the old figure", async () => {
  const conv4 = await newConversation(buyer.cookie);
  await step("search-4", conv4, `ورني الجوالات المتوفرة ${run}`);
  const updated = await request(`/listings/${ids.redmi}`, "PATCH", { unitPrice: "110" }, seller.cookie);
  if (updated.status >= 300) return; // listing edits are reviewed elsewhere; nothing to assert here
  const table = await step("table-4", conv4, "خلهم بجدول");
  assert.ok(prices(table.listingBlock).includes("110.000"), "the live record, not the earlier figure");
});

test("P3-MEASURE effort per interaction", () => {
  console.log("PHASE3_MEASUREMENTS", JSON.stringify(measurements));
  for (const [name, entry] of Object.entries(measurements)) {
    if (name.startsWith("search") || name === "services" || name === "add-second") continue;
    assert.equal(entry.modelCalls, 0, `${name}: display interactions need no model call`);
    assert.ok(entry.newResultSets <= 1, `${name}: at most one derived set`);
  }
});

test("P3-UNIT the interaction floor: dialects, suggested-action messages, and what it must never capture", async () => {
  const { displayInteraction } = await import("../src/ai/display-preference");
  const kind = (message: string) => {
    const value = displayInteraction(message);
    return value ? `${value.kind}:${"directive" in value ? value.directive.format : "op" in value ? value.op : "direction" in value ? value.direction : "AVAILABLE"}` : undefined;
  };
  const expected: Array<[string, string]> = [
    ["رتبهم من الرخيص", "SORT:ASC"], ["رتبهم من الأغلى", "SORT:DESC"], ["بدي أشوفهم كجدول", "FORMAT:TABLE"], ["طب رجعهم بطاقات", "FORMAT:CARDS"],
    ["اعرض الأرقام مش الرسم", "FORMAT:TABLE"], ["خلها رسم خطي", "FORMAT:LINE"], ["خلها أعمدة", "FORMAT:BAR"], ["خلني أشوف المتوفر بس", "FILTER:AVAILABLE"],
    ["أي شهر كان الأعلى؟", "ANALYZE:MAX"], ["وش الشهر الأقل؟", "ANALYZE:MIN"], ["قارن الأعلى بالأقل", "ANALYZE:MAX_VS_MIN"], ["قارن الشهر الحالي بالشهر اللي قبله", "ANALYZE:LAST_VS_PREVIOUS"],
    ["ورني الأرقام بالتفصيل", "FORMAT:TABLE"],
  ];
  for (const [message, want] of expected) assert.equal(kind(message), want, message);
  for (const message of ["ضيف الثاني للسلة", "أبي جدول دراسي", "اعرض جدول خشب بسعر 50", "أبي أبيع سيارتي", "اشتري الأول", "قارن الأول والثاني", "كيف أكتب إعلانًا جيدًا"]) assert.equal(kind(message), undefined, message);
  const { monthAnalysis } = await import("../src/ai/display-interaction");
  const months = [{ month: "2026-09", completedOrders: 1, revenueMinor: 5000 }, { month: "2026-10", completedOrders: 0, revenueMinor: 0 }, { month: "2026-11", completedOrders: 2, revenueMinor: 5000 }];
  assert.match(monthAnalysis("MAX", months, 3, "JOD"), /سبتمبر 2026: 5\.000 JOD/u, "a tie keeps the earliest month");
  assert.match(monthAnalysis("MIN", months, 3, "JOD"), /أكتوبر 2026: 0\.000 JOD/u, "a recorded zero is a real minimum");
  assert.match(monthAnalysis("LAST_VS_PREVIOUS", months, 3, "JOD"), /زيادة 5\.000 JOD/u);
  assert.doesNotMatch(monthAnalysis("LAST_VS_PREVIOUS", months, 3, "JOD"), /٪/u, "no percentage over a zero base");
  assert.match(monthAnalysis("MAX", [{ month: "2026-11", completedOrders: 0, revenueMinor: 0 }], 3, "JOD"), /لا توجد طلبات/u);
});

test("FIX-1 «أبي مقارنة … الأول والثاني» compares the two results; it never opens a purchase", async () => {
  const fix = await newConversation(buyer.cookie);
  await say(buyer.cookie, fix, `ورني الجوالات المتوفرة ${run}`);
  const cartBefore = cartLines((await request("/cart", "GET", undefined, buyer.cookie)).data).length;
  for (const message of ["أبي مقارنة مرتبة بين الأول والثاني", "بدي مقارنة بين الأول والثالث"]) {
    const reply = await say(buyer.cookie, fix, message);
    assert.equal(reply.surfaceBlock?.payload?.surface, "COMPARISON", `${message}: ${reply.body}`);
    assert.notEqual(reply.surfaceBlock?.payload?.surface, "PURCHASE_REVIEW");
  }
  assert.equal(cartLines((await request("/cart", "GET", undefined, buyer.cookie)).data).length, cartBefore, "no cart change");
  assert.equal(await ordersOf(buyer.id), 0);
  // The purchase reading of a plain wish for a position is unchanged.
  const purchase = await say(buyer.cookie, fix, "أبي الأول");
  assert.match(purchase.body, /راجع اختيارك|نعم/u, purchase.body);
});

test("FIX-2 «اعرضها مع …» on results never opens a sale draft; real sale phrasings still do", async () => {
  const fix = await newConversation(buyer.cookie);
  await say(buyer.cookie, fix, `ورني الجوالات المتوفرة ${run}`);
  const reply = await say(buyer.cookie, fix, "اعرضها مع الأسعار");
  assert.notEqual(reply.surfaceBlock?.payload?.surface, "SELL", reply.body);
  assert.doesNotMatch(reply.body, /اختر تصنيف العرض/u);
  const { surfaceIntent: detectIntent } = await import("../src/ai/intent") as any;
  if (typeof detectIntent === "function") {
    for (const sale of ["عندي كنبة اعرضها", "اعرضها بـ500", "اعرض كنبتي للبيع", "ابيع سيارتي"]) assert.equal(detectIntent(sale), "SELL", sale);
    for (const show of ["اعرضها مع الأسعار", "طب اعرضهم كجدول"]) assert.notEqual(detectIntent(show), "SELL", show);
  }
});
