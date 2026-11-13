/**
 * Flexible cards acceptance (owner mission «Premium product evolution», phase 3). Through the one
 * conversation runtime: the seller's draft and buyer results are rearranged on request («كبّر
 * الصورة», «حط السعر فوق», «خل البطاقة أبسط», «التفاصيل تحت الصورة») without any value changing,
 * nothing searched again and nothing published; the model may choose an arrangement but never a
 * value; an explicit example becomes an illustrative, actionless card that can never be bought.
 *
 * Real: API, runtime, deterministic floor, draft and search services, card contract, database.
 * Scripted: the model gateway (no provider), so this proves contracts and authority, not language quality.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, offers, orders, pool } from "@workspace/db";
import { ComposedSurfaceSchema, parseDisplayDirective } from "@workspace/api-zod/surface-composition";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { illustrationSurface } from "../src/ai/card-presentation";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const run = randomUUID().slice(0, 6);

type Plan = (last: string) => Record<string, unknown> | undefined;
let plan: Plan = () => undefined;
let modelCalls = 0;
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/flexible-cards" },
  async proposeToolCall(messages) {
    modelCalls++;
    const last = String(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
    const extra = plan(last) ?? {};
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "تفضل.", ...extra }), usage: { inputTokens: 100, outputTokens: 20 } } as any;
  },
} as ConversationModelGateway;

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = 1;
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `203.0.117.${ipn++ % 250}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_660_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Fc-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Flex ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}
type Turn = { body: string; type: string; payload: any; modelCalls: number };
async function say(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const before = modelCalls;
  const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await r.text();
  const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  assert.ok(done, `${message}: ${raw.slice(0, 300)}`);
  const block = (done.assistantMessage.blocks ?? [])[0] ?? {};
  return { body: String(done.assistantMessage.body), type: String(block.type ?? "TEXT"), payload: block.payload ?? {}, modelCalls: modelCalls - before };
}
const conversation = async (actor: Actor) => (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id as string;
async function publish(seller: Actor, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — بحالة ممتازة للاختبار`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition: "جديد" }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const seller = await account("seller");
const buyer = await account("buyer");
const listingIds = [await publish(seller, `سماعة فلكس ${run} أولى`, "40"), await publish(seller, `سماعة فلكس ${run} ثانية`, "25")];

await test("FC-01 seller draft: arrangement changes, values and publication do not", async () => {
  const conv = await conversation(seller);
  const draft = await say(seller, conv, `جاسم أبي أبيع آيفون 13 برو مستعمل ${run} بسعر 300 دينار`);
  assert.equal(draft.payload.surface, "SELL", draft.body);
  const fields = JSON.stringify(draft.payload.draftReview?.fields ?? []);
  const before = (await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length;

  const larger = await say(seller, conv, "جاسم كبر الصورة");
  assert.equal(larger.payload.surface, "SELL", larger.body);
  assert.deepEqual(larger.payload.cardPresentation, { image: "LARGE" });
  assert.equal(JSON.stringify(larger.payload.draftReview.fields), fields, "every field is the stored one");
  assert.equal(larger.modelCalls, 0, "an arrangement request needs no model");
  assert.match(larger.body, /لم يتغير أي حقل ولم يُنشر شيء/u);

  const priceTop = await say(seller, conv, "حط السعر فوق");
  assert.deepEqual(priceTop.payload.cardPresentation, { image: "LARGE", price: "TOP" }, "wishes accumulate");
  const below = await say(seller, conv, "اعرض التفاصيل تحت الصورة");
  assert.equal(below.payload.cardPresentation.details, "BELOW");
  const simple = await say(seller, conv, "خل البطاقة أبسط");
  assert.equal(simple.payload.cardPresentation.density, "COMPACT");
  assert.equal(JSON.stringify(simple.payload.draftReview.fields), fields);
  assert.equal((await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length, before, "nothing published");
});

await test("FC-02 buyer results: same ids and order, arrangement kept across table and cards", async () => {
  const conv = await conversation(buyer);
  const found = await say(buyer, conv, `جاسم ابحث عن سماعة فلكس ${run}`);
  assert.equal(found.type, "LISTING_RESULTS", found.body);
  const ids: string[] = found.payload.resourceIds;
  assert.deepEqual([...ids].sort(), [...listingIds].sort());
  const large = await say(buyer, conv, "كبر الصورة");
  assert.equal(large.type, "LISTING_RESULTS");
  assert.deepEqual(large.payload.resourceIds, ids, "no new search, same order");
  assert.equal(large.payload.composition?.presentation?.image, "LARGE");
  assert.equal(large.modelCalls, 0);
  const prices = (payload: any) => payload.listings.map((l: any) => `${l.id}:${l.unitPrice}`).sort();
  assert.deepEqual(prices(large.payload), prices(found.payload), "prices are the records' own");
  const table = await say(buyer, conv, "اعرضهم بجدول");
  assert.equal(table.payload.composition?.layout, "TABLE");
  assert.equal(table.payload.composition?.presentation?.image, "LARGE", "the earlier wish survives a format change");
  const cards = await say(buyer, conv, "رجع البطاقات");
  assert.notEqual(cards.payload.composition?.layout, "TABLE");
  assert.equal(cards.payload.composition?.presentation?.image, "LARGE");
  const hidden = await say(buyer, conv, "بدون صور");
  assert.equal(hidden.payload.composition?.presentation?.image, "HIDDEN");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, buyer.id))).length, 0);
});

await test("FC-03 model-chosen arrangement (no floor phrase): applied to the latest results only", async () => {
  const conv = await conversation(buyer);
  await say(buyer, conv, `جاسم ابحث عن سماعة فلكس ${run}`);
  plan = (last) => (/مرتبة/u.test(last) ? { display: { version: 1, format: "CARDS", scope: "LATEST_RESULTS", presentation: { density: "COMPACT", price: "TOP" } } } : undefined);
  try {
    const arranged = await say(buyer, conv, "خليها مرتبة أكثر وكلام أقل لو سمحت");
    assert.equal(arranged.modelCalls, 1);
    assert.deepEqual(arranged.payload.composition?.presentation, { density: "COMPACT", price: "TOP" }, arranged.body);
    // A directive carrying a value (a price) is malformed as a whole and changes nothing.
    assert.equal(parseDisplayDirective({ version: 1, format: "CARDS", scope: "LATEST_RESULTS", presentation: { price: "999" } }), undefined);
    assert.equal(parseDisplayDirective({ version: 1, format: "CARDS", presentation: { image: "LARGE", url: "https://x" } }), undefined);
  } finally { plan = () => undefined; }
});

await test("FC-04 illustrative example: labelled, actionless, never in a commercial turn", async () => {
  const conv = await conversation(buyer);
  plan = (last) => (/مثال/u.test(last) ? { illustration: { title: "تويوتا كامري 2020", subtitle: "سيدان عائلية", fields: [{ label: "الممشى", value: "80 ألف كم" }, { label: "السعر", value: "9,000 دينار" }], body: "بطاقة إعلان سيارة نموذجية." } } : undefined);
  try {
    // After other cards in the same conversation (search results, plans), as in the browser tour.
    await say(buyer, conv, `جاسم ابحث عن سماعة فلكس ${run}`);
    await say(buyer, conv, "ضيف الثاني للسلة");
    await say(buyer, conv, "اعرض الباقات");
    const example = await say(buyer, conv, "ورني مثال لبطاقة إعلان سيارة كيف ممكن تكون");
    assert.ok(example.payload.displaySurface, JSON.stringify({ body: example.body, calls: example.modelCalls, surface: example.payload.surface, advice: example.payload.advice }));
    const surface = ComposedSurfaceSchema.parse(example.payload.displaySurface);
    assert.equal(surface.illustrative, true);
    assert.equal(surface.sections[0]!.type === "header" && surface.sections[0]!.badge?.label, "مثال توضيحي");
    assert.ok(surface.sections.every((section) => section.type !== "actions" && section.type !== "options"), "no buttons at all");
    assert.match(JSON.stringify(surface), /ليس إعلانًا حقيقيًا/u);
  } finally { plan = () => undefined; }
  // The contract itself refuses capabilities, links and verified totals on an example.
  const base = { version: 1, label: "x", size: "MEDIUM", illustrative: true, sections: [{ type: "header", title: "x" }] };
  assert.equal(ComposedSurfaceSchema.safeParse({ ...base, sections: [...base.sections, { type: "actions", items: [{ kind: "SEND", label: "اشتر", message: "اشتر", actionId: "CONFIRM" }] }] }).success, false);
  assert.equal(ComposedSurfaceSchema.safeParse({ ...base, sections: [...base.sections, { type: "actions", items: [{ kind: "SEND", label: "اشتر", message: "اشتر", emphasis: "PRIMARY" }] }] }).success, false);
  assert.equal(ComposedSurfaceSchema.safeParse({ ...base, sections: [...base.sections, { type: "money", lines: [], total: { label: "المجموع", value: "10 JOD", verified: true } }] }).success, false);
  assert.equal(illustrationSurface({ title: "x", imageUrl: "https://evil.example/a.png" }), undefined, "unknown keys reject the illustration");
});

await test("FC-05 an illustration in a commercial turn is dropped", async () => {
  const conv = await conversation(buyer);
  plan = () => ({ goal: "BUY", illustration: { title: "آيفون 15 جديد", fields: [{ label: "السعر", value: "1 دينار" }] } });
  try {
    const turn = await say(buyer, conv, "أبي أشتري جوال جديد رخيص جدًا مثل المثال");
    assert.equal(turn.payload.displaySurface?.illustrative, undefined, JSON.stringify(turn.payload).slice(0, 300));
  } finally { plan = () => undefined; }
});

after(async () => { server.close(); await pool.end(); });
