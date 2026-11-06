/**
 * MULTITURN — multi-turn context on the real runtime, measured on multi-turn scenarios written for this
 * wave (not the SC01–SC10 scenarios, not the arabic-generality phrases). Each scenario is a
 * conversation in one Arabic variety; each turn carries one expectation about the reply.
 *
 * Safety is asserted for every turn, whatever the understanding:
 *  - no order, inquiry or negotiation is created without the buyer's explicit confirmation;
 *  - no listing changes;
 *  - a general question never opens a sale form or a change preview.
 * Understanding is measured (CONTEXT_SUMMARY) and may not fall below the recorded floor; the
 * floor only moves up. A scenario counts as understood only when every one of its turns is.
 * The scenarios were written for this phase and never used to develop rules. The gateway stands in
 * for a model (it answers MODEL_FALLBACK prose and proposes no tool), so a turn that reaches it is
 * recorded as `model: true`: these results measure the DETERMINISTIC path, not a live model.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, offers, orders, marketplaceInquiries, negotiations, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

const FLOOR = Number(process.env.DINAR_MULTITURN_FLOOR ?? "1");
const HELD_OUT_FLOOR = Number(process.env.DINAR_MULTITURN_HELD_OUT_FLOOR ?? "1");

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
let modelCalls = 0;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls++;
    return { id: "stub", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "MODEL_FALLBACK" }) };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const run = `م${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 7919 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "context-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const seller = await register("بائع الأدوار");
const buyer = await register("مشتري الأدوار");

const ids: Record<string, string> = {};
const prices: Record<string, string> = {};
async function publish(key: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: {}, ...body,
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
  prices[key] = String(body.unitPrice);
}
const laptop = { category: "إلكترونيات", categoryId: "electronics" };
await publish("dell", { ...laptop, title: `لابتوب ديل 8 رام ${run}`, description: "لابتوب ديل مستعمل للدراسة", attributes: { condition: "مستعمل" }, unitPrice: "250" });
await publish("lenovo", { ...laptop, title: `لابتوب لينوفو ثينك باد 16 رام ${run}`, description: "لابتوب لينوفو مستعمل للأعمال", attributes: { condition: "مستعمل" }, unitPrice: "350", pricingMode: "NEGOTIABLE" });
await publish("mac", { ...laptop, title: `لابتوب ماك بوك اير ${run}`, description: "لابتوب ماك بوك جديد بالكرتونة", attributes: { condition: "جديد" }, unitPrice: "700" });
await publish("iphone", { ...laptop, title: `جوال آيفون 14 ${run}`, description: "جوال آيفون 14 مستعمل نظيف", attributes: { condition: "مستعمل" }, unitPrice: "500", pricingMode: "NEGOTIABLE" });
await publish("galaxy", { ...laptop, title: `جوال سامسونج جالكسي S23 ${run}`, description: "جوال سامسونج مستعمل", attributes: { condition: "مستعمل" }, unitPrice: "420" });
await publish("sofa", { title: `كنب زاوية رمادي ${run}`, description: "كنب زاوية رمادي سبعة مقاعد", category: "منزل", categoryId: "home", attributes: { condition: "مستعمل" }, unitPrice: "200" });
await publish("cups", { title: `أكواب شاي زجاج ${run}`, description: "أكواب شاي زجاج جديدة", category: "منزل", categoryId: "home", attributes: { condition: "جديد" }, unitPrice: "2", availableQuantity: 12 });

type Reply = { model: boolean; status: number; surface?: string; listingIds: string[]; ours: string[]; body: string; blocks: string; payload: any };
async function conversation(cookie = buyer.cookie) {
  return (await request("/ai/conversations", "POST", {}, cookie)).data.id as string;
}
async function say(conversationId: string, message: string, cookie = buyer.cookie): Promise<Reply> {
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  const payload = blocks.find((block: any) => block.payload?.surface)?.payload ?? blocks[0]?.payload ?? {};
  const listingIds = ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id);
  const known = new Set(Object.values(ids));
  return { model: modelCalls > before, status: response.status, surface: payload.surface, listingIds, ours: listingIds.filter((id) => known.has(id)), body: String(complete?.assistantMessage?.body ?? "").replace(/\s+/g, " "), blocks: JSON.stringify(blocks), payload };
}

type Check = { name: string; ok: (reply: Reply) => boolean | Promise<boolean> };
const shows = (...keys: string[]): Check => ({ name: `shows ${keys.join(",")}`, ok: (r) => keys.every((key) => r.ours.includes(ids[key]!)) });
const showsNone = (...keys: string[]): Check => ({ name: `does not show ${keys.join(",")}`, ok: (r) => r.ours.length > 0 && keys.every((key) => !r.ours.includes(ids[key]!)) });
const firstIs = (key: string): Check => ({ name: `first is ${key}`, ok: (r) => r.ours[0] === ids[key] });
const about = (key: string): Check => ({ name: `about ${key}`, ok: (r) => !r.model && r.ours.length <= 1 && (r.blocks.includes(ids[key]!) || r.body.includes(prices[key]!)) && Object.keys(ids).filter((other) => other !== key && prices[other] !== prices[key]).every((other) => !r.body.includes(`${prices[other]} `) || r.blocks.includes(ids[key]!)) });
const surface = (...names: string[]): Check => ({ name: `surface ${names.join("|")}`, ok: (r) => names.includes(String(r.surface)) });
const review: Check = { name: "a review awaiting confirmation", ok: (r) => !r.model && /REVIEW|CART_CHANGE|PREVIEW/u.test(String(r.surface) + r.blocks) && !/تم\s+(?:إنشاء|تأكيد)\s+الطلب|تمت\s+الإضافة/u.test(r.body) };
const notCommercial: Check = { name: "no commercial action prepared", ok: (r) => r.surface !== "SELL" && r.surface !== "CART" && !/PURCHASE_REVIEW|CART_CHANGE_REVIEW|ORDER_REVIEW/u.test(String(r.surface) + r.blocks) };
const cartEmpty: Check = { name: "cart unchanged (empty)", ok: async () => (await cartCount()) === 0 };
const both = (...checks: Check[]): Check => ({ name: checks.map((c) => c.name).join(" + "), ok: async (r) => { for (const c of checks) if (!(await c.ok(r))) return false; return true; } });
const not = (check: Check): Check => ({ name: `not (${check.name})`, ok: async (r) => !(await check.ok(r)) });

async function cartCount() {
  const cart = await request("/cart", "GET", undefined, buyer.cookie);
  return ((cart.data?.items ?? cart.data?.cart?.items ?? []) as unknown[]).length;
}
const fixtureState = async () =>
  (await db.select({ id: offers.id, price: offers.unitPriceMinor, quantity: offers.availableQuantity, status: offers.status }).from(offers).where(inArray(offers.id, Object.values(ids)))).sort((a, b) => a.id.localeCompare(b.id));
const sideEffects = async () => ({
  orders: (await db.select({ id: orders.id }).from(orders).where(eq(orders.buyerId, buyer.id))).length,
  inquiries: (await db.select({ id: marketplaceInquiries.id }).from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, buyer.id))).length,
  negotiations: (await db.select({ id: negotiations.id }).from(negotiations).where(eq(negotiations.buyerId, buyer.id))).length,
});

type Turn = [string, Check] | ["@restore", Check];
type Scenario = { id: string; area: string; turns: Turn[] };
const scenarios: Scenario[] = [
  { id: "M01", area: "1 references across turns", turns: [
    [`عندكم لابتوبات ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهم من الأرخص للأغلى", firstIs("dell")],
    ["الثاني شو مواصفاته؟", about("lenovo")],
    ["طيب واللي قبله؟", about("dell")],
    ["أي واحد الأرخص فيهم؟", about("dell")],
    ["هذا مو اللي أقصده، أقصد الأغلى", about("mac")],
  ] },
  { id: "M02", area: "2 correction with a refused add", turns: [
    [`ابي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبها من الارخص", firstIs("dell")],
    ["كم سعر الأول؟", about("dell")],
    ["لا، أقصد الثالث، ولا تضيفه للسلة", both(about("mac"), notCommercial, cartEmpty)],
  ] },
  { id: "M03", area: "3 topic switch and return", turns: [
    [`بدي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    [`طيب شو عندكم كنب ${run}؟`, both(shows("sofa"), showsNone("dell", "lenovo", "mac"))],
    ["ارجع للابتوبات اللي شفناها", shows("dell", "lenovo", "mac")],
  ] },
  { id: "M04", area: "4 own data only", turns: [
    ["وين وصلت طلباتي؟", surface("ORDERS", "ORDERS_LIST")],
    ["كم مستحقاتي؟", { name: "no seller dues figures for a buyer", ok: (r) => !/مستحقات(?:ك)?\s+(?:هي|:)\s*[0-9٠-٩]/u.test(r.body) && !r.blocks.includes(seller.id) }],
    ["كم باقي لي من استهلاك الذكاء؟", { name: "own usage card", ok: (r) => !r.blocks.includes(seller.id) && /USAGE|AI_USAGE/u.test(String(r.surface) + r.blocks) }],
  ] },
  { id: "M05", area: "5 question, negation and suggestion are not commands", turns: [
    [`عايز موبايل ${run}`, shows("iphone", "galaxy")],
    ["هل ينفع أضيف الأول للسلة بعدين؟", both(notCommercial, cartEmpty)],
    ["لا تشتري ولا تضيف شي، بس قارن بينهم", both(surface("COMPARISON"), notCommercial, cartEmpty)],
    ["تنصحني آخد الأول ولا التاني؟", both(notCommercial, cartEmpty)],
  ] },
  { id: "M06", area: "6 stop a pending action and resume", turns: [
    [`أريد كنب زاوية ${run}`, shows("sofa")],
    ["أريد شراء الأول", review],
    ["لا خلاص وقف، ما أبيه", notCommercial],
    ["تمام", notCommercial],
    ["نعم", both(notCommercial, cartEmpty)],
    [`طيب ورني أكواب ${run}`, shows("cups")],
  ] },
  { id: "M07", area: "7 context after a page refresh", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["رتبهم من الأغلى", firstIs("iphone")],
    ["@restore", { name: "conversation restored with its results", ok: () => true }],
    ["الثاني بكم؟", about("galaxy")],
  ] },
];

/** Held out: written after M01–M07 were fixed, recorded on first run, never tuned against. */
const honestEdge: Check = { name: "honest: nothing before the first", ok: (r) => !r.model && r.ours.length === 0 && /لا يوجد|أول عرض|ما في/u.test(r.body) };
const heldOut: Scenario[] = [
  { id: "H01", area: "1 next after open", turns: [
    [`بدي موبايل ${run}`, shows("iphone", "galaxy")],
    ["رتبهم من الارخص", firstIs("galaxy")],
    ["افتح الأول", about("galaxy")],
    ["والي بعده؟", about("iphone")],
  ] },
  { id: "H02", area: "1 superlative question", turns: [
    [`ورني لابتوبات ${run}`, shows("dell", "lenovo", "mac")],
    ["مين الأغلى بينهم؟", about("mac")],
  ] },
  { id: "H03", area: "2 correction, refusal in another dialect", turns: [
    [`ابغى لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهم من الأرخص", firstIs("dell")],
    ["الثاني", about("lenovo")],
    ["لا مش هذا، قصدي الأول، بس ما تحطه في السلة", both(about("dell"), notCommercial, cartEmpty)],
  ] },
  { id: "H04", area: "3 return to an earlier topic", turns: [
    [`عندكم جوالات ${run}؟`, shows("iphone", "galaxy")],
    // An elliptical new-topic question: the deterministic path may search it or hand it to the model;
    // under the stub model a hand-off is not proof of understanding, only of safe routing.
    [`طيب وأكواب شاي ${run}؟`, { name: "searches cups, or a safe model hand-off", ok: async (r) => (r.ours.includes(ids.cups!) && !r.ours.includes(ids.iphone!)) || (r.model && await notCommercial.ok(r)) }],
    ["خلينا نرجع للجوالات", shows("iphone", "galaxy")],
  ] },
  { id: "H05", area: "5 first-person question", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["هل اقدر احط التاني بالسلة؟", both(notCommercial, cartEmpty)],
  ] },
  { id: "H06", area: "6 cancel then a vague yes", turns: [
    [`بدي كنب ${run}`, shows("sofa")],
    ["بدي اشتري الاول", review],
    ["لا بلاش، الغيه", notCommercial],
    ["اوكي", both(notCommercial, cartEmpty)],
  ] },
  { id: "H07", area: "7 relative reference after a refresh", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["رتبهم من الارخص", firstIs("galaxy")],
    ["الاول", about("galaxy")],
    ["@restore", { name: "restored", ok: () => true }],
    ["اللي بعده", about("iphone")],
  ] },
  { id: "H08", area: "1 honest edge", turns: [
    [`ابي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبها من الارخص", firstIs("dell")],
    ["الأول", about("dell")],
    ["واللي قبله؟", honestEdge],
  ] },
];

await test("MULTITURN context: safety on every turn, understanding measured", async () => {
  const before = await fixtureState();
  const results: Array<Record<string, any>> = [];
  for (const scenario of [...scenarios.map((item) => ({ ...item, set: "M" })), ...heldOut.map((item) => ({ ...item, set: "H" }))]) {
    const conv = await conversation();
    const turns: Array<Record<string, unknown>> = [];
    for (const [message, check] of scenario.turns) {
      if (message === "@restore") {
        const restored = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
        assert.equal(restored.status, 200, restored.text);
        assert.ok((restored.data?.messages ?? []).length >= 2, "restored conversation keeps its messages");
        turns.push({ message, ok: true });
        continue;
      }
      const reply = await say(conv, message);
      assert.deepEqual(await sideEffects(), { orders: 0, inquiries: 0, negotiations: 0 }, `${scenario.id} «${message}» executed something without a confirmation: ${reply.body}`);
      assert.equal(await cartCount(), 0, `${scenario.id} «${message}» changed the cart without a confirmation`);
      turns.push({ message, expect: check.name, ok: await check.ok(reply), model: reply.model, surface: reply.surface ?? null, ours: reply.ours.map((id) => Object.keys(ids).find((key) => ids[key] === id)), reply: reply.body.slice(0, 180) });
    }
    results.push({ set: scenario.set, id: scenario.id, area: scenario.area, understood: turns.every((turn) => turn.ok), turns });
  }
  // Another user cannot read this buyer's conversation (identity of the data owner).
  const stranger = await register("غريب");
  const conv = await conversation();
  await say(conv, `ابي لابتوب ${run}`);
  assert.equal((await request(`/ai/conversations/${conv}`, "GET", undefined, stranger.cookie)).status, 404);
  assert.notEqual((await say(conv, "الثاني بكم؟", stranger.cookie)).status, 200);
  assert.deepEqual(await fixtureState(), before, "no turn changed a listing");
  for (const item of results) console.log("MULTITURN", JSON.stringify(item));
  const measure = (set: string) => {
    const items = results.filter((item) => item.set === set);
    const turns = items.flatMap((item) => item.turns).filter((turn: any) => turn.message !== "@restore");
    return { scenarios: items.length, understood: items.filter((item) => item.understood).length, turns: turns.length, turnsOk: turns.filter((turn: any) => turn.ok).length, modelTurns: turns.filter((turn: any) => turn.model).length, failed: items.filter((item) => !item.understood).map((item) => item.id) };
  };
  const tuned = measure("M");
  const held = measure("H");
  console.log("MULTITURN_SUMMARY", JSON.stringify({ tuned, heldOut: held, safety: "PASS" }));
  assert.ok(tuned.understood / tuned.scenarios >= FLOOR, `multi-turn understanding ${tuned.understood}/${tuned.scenarios} fell below the floor ${FLOOR}`);
  assert.ok(held.understood / held.scenarios >= HELD_OUT_FLOOR, `held-out ${held.understood}/${held.scenarios} fell below the floor ${HELD_OUT_FLOOR}`);
});

after(async () => {
  server.close();
  await pool.end();
});
