/**
 * Claude 02 (SC01/SC03/SC06/SC07/SC10): everyday Arabic phrasings must reach DINAR's own
 * deterministic services instead of falling through to the model or opening the wrong surface.
 * Found by test/sc-scenarios-probe.test.ts: «ورني طاولات» fell to the model, «اعرض لي الماكينات»
 * and «البضاعة اللي أعرضها» opened the SELL form, «هاتفي» did not name the phone category,
 * «زد كمية …», «وقف الإعلان الثاني مؤقتًا» and «وش الأكثر مبيعًا؟» fell to the model, and a
 * complaint about an undelivered order fell to the model. Every write still needs a confirmed
 * preview; nothing here lets the model act.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, disputes, offers, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

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
const run = randomUUID().slice(0, 6);

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
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${phone++ % 10}`;
  const password = "sc-routing-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}
const reem = await register("ريم بائعة اختبار");
const other = await register("بائع آخر");
const buyer = await register("مشتري اختبار");
const ids: Record<string, string> = {};
async function publish(cookie: string, key: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: {}, ...body,
  }, cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish(reem, "cups", { title: `أكواب قهوة سيراميك ${run}`, description: "أكواب قهوة سيراميك جديدة", category: "منزل", categoryId: "home", attributes: { condition: "جديد" }, unitPrice: "3", availableQuantity: 5 });
await publish(reem, "table", { title: `طاولة سنديان مستعملة ${run}`, description: "طاولة طعام مستعملة بحالة ممتازة", category: "منزل", categoryId: "home", attributes: { condition: "مستعمل" }, unitPrice: "100", pricingMode: "NEGOTIABLE" });
await publish(other, "machine", { title: `ماكينة تغليف صناعية مستعملة ${run}`, description: "ماكينة تغليف 220 فولت مستعملة", category: "أخرى", categoryId: "other", attributes: { condition: "مستعمل" }, unitPrice: "2500", pricingMode: "NEGOTIABLE" });

async function conversation(cookie: string) {
  return (await request("/ai/conversations", "POST", {}, cookie)).data.id as string;
}
async function say(cookie: string, conv: string, message: string) {
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  const payload = complete?.assistantMessage?.blocks?.[0]?.payload ?? {};
  return {
    model: modelCalls > before,
    payload,
    surface: payload.surface as string | undefined,
    listingIds: ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id),
    body: String(complete?.assistantMessage?.body ?? raw.slice(0, 300)),
  };
}
const describe = (turn: Awaited<ReturnType<typeof say>>) => JSON.stringify({ draft: turn.payload.draft?.draftId?.slice(0, 8), step: turn.payload.draftStep, model: turn.model, surface: turn.surface, listings: turn.listingIds.length, body: turn.body.slice(0, 200) });

await test("SC03/SC06: «ورني …» and «اعرض لي …» are searches, not the model and not the SELL form", async () => {
  const conv = await conversation(buyer);
  const tables = await say(buyer, conv, "دينار، ورني طاولات مستعملة");
  assert.equal(tables.model, false, describe(tables));
  assert.ok(tables.listingIds.includes(ids.table!), describe(tables));
  const machines = await say(buyer, await conversation(buyer), "اعرض لي الماكينات 220 فولت فقط");
  assert.notEqual(machines.surface, "SELL", describe(machines));
  assert.equal(machines.model, false, describe(machines));
  assert.ok(machines.listingIds.includes(ids.machine!), describe(machines));
});

await test("SC01: «أبي أبيع هاتفي المستعمل» starts a draft in the phone category", async () => {
  const conv = await conversation(other);
  const turn = await say(other, conv, "دينار أبي أبيع هاتفي المستعمل");
  assert.equal(turn.surface, "SELL", describe(turn));
  assert.equal(turn.payload.draft?.categoryId, "electronics", describe(turn));
});

await test("SC01: the seller's own words fill one draft; a correction changes one field; review never publishes", async () => {
  const seller = await register("سالم بائع اختبار");
  const conv = await conversation(seller);
  const start = await say(seller, conv, "دينار أبي أبيع هاتفي المستعمل");
  const draftId = start.payload.draft?.draftId;
  assert.ok(draftId, describe(start));
  const specs = await say(seller, conv, "آيفون 13، 128 جيجا، مستعمل، البطارية 86٪، ومعه الشاحن");
  assert.equal(specs.payload.draft?.draftId, draftId, describe(specs));
  // The battery lives in the description; the rest of the draft carries random UUIDs, where two
  // hex digits such as «86» occur by chance, so only the corrected field may be read.
  assert.match(String(specs.payload.draft?.description ?? ""), /86/u, describe(specs));
  const price = await say(seller, conv, "بدي أبيعه ب 300 وقابل للتفاوض، عندي جهاز واحد، والاستلام في منطقتي");
  assert.equal(price.surface, "SELL", describe(price));
  assert.equal(price.payload.draft?.draftId, draftId, describe(price));
  assert.equal(price.payload.draft?.unitPrice, "300", describe(price));
  assert.equal(price.payload.draft?.availableQuantity, "1", "«عندي جهاز واحد» is the quantity");
  assert.ok(price.payload.draft?.pricingMode === "NEGOTIABLE" || price.payload.draft?.negotiable === true, describe(price));
  const corrected = await say(seller, conv, "لا، البطارية 89٪")
  assert.equal(corrected.model, false, describe(corrected));
  assert.equal(corrected.payload.draft?.draftId, draftId, describe(corrected));
  assert.match(String(corrected.payload.draft?.description ?? ""), /89/u, describe(corrected));
  assert.doesNotMatch(String(corrected.payload.draft?.description ?? ""), /86/u, "the old battery value is replaced, not kept");
  assert.equal(corrected.payload.draft?.unitPrice, "300", "other fields are kept");
  const review = await say(seller, conv, "اعرض الإعلان قبل النشر");
  assert.equal(review.surface, "SELL", describe(review));
  assert.equal(review.payload.draft?.draftId, draftId, `the same draft is reviewed, not a new one: ${describe(review)}`);
  assert.ok(review.payload.draftReview, describe(review));
  const published = await request("/listings?mine=1", "GET", undefined, seller);
  assert.ok(!JSON.stringify(published.data ?? "").includes("آيفون 13"), "nothing is published without the seller's confirmation");
});

await test("SC07: the seller's own stock, best seller, quantity and pause are DINAR services with previews", async () => {
  const conv = await conversation(reem);
  const stock = await say(reem, conv, "دينار ورّني البضاعة اللي أعرضها عندك وكم بقي منها");
  assert.notEqual(stock.surface, "SELL", describe(stock));
  assert.equal(stock.model, false, describe(stock));
  assert.match(stock.body, new RegExp(`أكواب قهوة سيراميك ${run}`, "u"), describe(stock));
  assert.doesNotMatch(stock.body, new RegExp(`ماكينة تغليف صناعية مستعملة ${run}`, "u"), "another seller's listing never appears");

  const best = await say(reem, conv, "وش الأكثر مبيعًا؟");
  assert.equal(best.model, false, describe(best));
  assert.ok(best.payload.sellerInsight, describe(best));

  const more = await say(reem, conv, "زد كمية أكواب القهوة إلى 10");
  assert.equal(more.model, false, describe(more));
  assert.equal(more.payload.managementPreview?.listingId, ids.cups, describe(more));
  assert.equal((await db.select().from(offers).where(eq(offers.id, ids.cups!)))[0]!.availableQuantity, 5, "preview only");
  assert.match((await say(reem, conv, "نعم")).body, /تم تنفيذ التغيير/u);
  assert.equal((await db.select().from(offers).where(eq(offers.id, ids.cups!)))[0]!.availableQuantity, 10);

  await say(reem, conv, "اعرض إعلاناتي");
  const pause = await say(reem, conv, "وقف الإعلان الثاني مؤقتًا");
  assert.equal(pause.model, false, describe(pause));
  assert.equal(pause.payload.managementPreview?.action, "PAUSE", describe(pause));

  // Another seller naming Reem's listing never gets a preview for it.
  const stranger = await say(other, await conversation(other), "زد كمية أكواب القهوة إلى 10");
  assert.notEqual(stranger.payload.managementPreview?.listingId, ids.cups, describe(stranger));
});

await test("SC10: a complaint about an undelivered order opens the buyer's orders, never a model reply or a silent dispute", async () => {
  const disputesBefore = (await db.select().from(disputes)).length;
  const complaint = await say(buyer, await conversation(buyer), "لم أستلم الطلب، افتح لي شكوى");
  assert.equal(complaint.model, false, describe(complaint));
  // This buyer has no order whose hand-off the seller recorded, so DINAR says a receipt dispute
  // cannot be opened yet instead of pretending one was.
  assert.equal(complaint.surface, "ORDERS_LIST", describe(complaint));
  assert.match(complaint.body, /لا يمكن فتح نزاع|لا توجد لديك طلبات/u, describe(complaint));
  assert.doesNotMatch(complaint.body, /(?:فتحت|تم فتح)\s+(?:نزاع|شكوى)/u, describe(complaint));
  assert.equal((await db.select().from(disputes)).length, disputesBefore, "no dispute is opened from chat text alone");
});

after(async () => {
  server.close();
  await pool.end();
});
