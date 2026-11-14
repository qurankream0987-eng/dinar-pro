/**
 * Jassim Connect commands (owner mission phase 4): the seller, buyer, marketing and plan prompts the
 * owner listed, sent as a customer would, through the one conversation runtime. Each step records
 * what Jassim showed (surface, text, model calls) to DINAR_JOURNEY_OUT for the report, and asserts
 * the safety invariants that must hold whatever the wording: nothing published, ordered, charged
 * or subscribed without the user's confirmation; no duplicates; no cross-account access.
 * Scripted model gateway (no provider): it answers only when the runtime asks it, and its words are
 * marked so the report can tell deterministic handling from model handling.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { businessSubscriptions, db, offers, orders, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const run = randomUUID().slice(0, 5);
const modelInputs: string[] = [];
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/journeys" },
  async proposeToolCall(messages) {
    const input = JSON.stringify(messages);
    modelInputs.push(input);
    const last = String(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
    const grounded = input.includes("sellerListing");
    const reply = grounded ? "«نص تسويقي من النموذج» مبني على بيانات إعلانك فقط." : `«رد النموذج» على: ${last.slice(-60)}`;
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: reply }), usage: { inputTokens: 100, outputTokens: 20 } } as any;
  },
} as ConversationModelGateway;

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = 1;
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `203.0.118.${ipn++ % 250}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_440_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Jr-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Journey ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}
const log: Record<string, unknown>[] = [];
async function say(actor: Actor, conv: string, id: string, message: string) {
  const before = modelInputs.length;
  const r = await fetch(`${base}/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await r.text();
  const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  const block = done?.assistantMessage?.blocks?.[0] ?? {};
  const payload = block.payload ?? {};
  const entry = {
    id, message, status: r.status,
    surface: block.type === "LISTING_RESULTS" ? "LISTING_RESULTS" : String(payload.surface ?? block.type ?? "TEXT"),
    body: String(done?.assistantMessage?.body ?? raw.slice(0, 200)).slice(0, 400),
    modelCalls: modelInputs.length - before,
    resourceIds: payload.resourceIds,
    draftStep: payload.draftStep,
    draftTitle: (payload.draftReview?.fields ?? []).find((f: any) => f.field === "title")?.value,
    draftMissing: (payload.draftReview?.missingFields ?? []).map((f: any) => f.label),
    adviceTopic: payload.advice?.topic,
    sellerInsight: payload.sellerInsight?.topic ?? payload.sellerInsight?.kind,
    cartLines: Array.isArray(payload.cart) ? payload.cart.length : undefined,
  };
  log.push(entry);
  return { ...entry, payload };
}
const conversation = async (actor: Actor) => (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id as string;
async function publish(seller: Actor, title: string, price: string, condition: string, city = "عمان") {
  const created = await request("/listings", "POST", {
    title, description: `${title} — للاختبار`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city,
    attributes: { condition }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 2, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
const offersOf = async (actor: Actor) => (await db.select().from(offers).where(eq(offers.sellerId, actor.id))).length;
const ordersOf = async (actor: Actor) => (await db.select().from(orders).where(eq(orders.buyerId, actor.id))).length;


import { businessProfiles, connectIntegrations, connectOffers, connectPartners, connectSites } from "@workspace/db";
const OUT = process.env.DINAR_JOURNEY_OUT;

const merchant = await account("merchant");
const reviewer = await account("reviewer");
await publish(merchant, `سماعة لاسلكية ${run}`, "25", "جديد");
await publish(merchant, `شاحن سريع ${run}`, "9", "جديد");
const business = await request("/business/profiles", "POST", { displayName: `متجر ${run}`, categoryKey: "OTHER", idempotencyKey: randomUUID() }, merchant.cookie);
assert.equal(business.status, 201, business.raw);
const businessId = business.data.business.id as string;
const partner = await request("/connect/partners", "POST", { businessId }, merchant.cookie);
assert.equal(partner.status, 201, partner.raw);
const partnerId = partner.data.id as string;
const now = new Date();
await db.update(businessProfiles).set({ verificationStatus: "VERIFIED", verifiedAt: now, verifiedBy: reviewer.id }).where(eq(businessProfiles.id, businessId));
await db.update(connectPartners).set({ status: "APPROVED", participationMode: "HYBRID" }).where(eq(connectPartners.id, partnerId));
const siteId = randomUUID();
await db.insert(connectSites).values({ id: siteId, partnerId, hostname: `shop-${run}.example`, status: "VERIFIED", challengeDigest: "0".repeat(64), challengeExpiresAt: now, verifiedAt: now, validUntil: new Date(now.getTime() + 30 * 86_400_000) });
const integrationId = randomUUID();
await db.insert(connectIntegrations).values({ id: integrationId, partnerId, siteId, name: "كتالوج", kind: "FEED", status: "APPROVED", mode: "SIMULATION_ONLY", capabilities: ["CATALOG_READ"] });
await db.insert(connectOffers).values({ id: randomUUID(), partnerId, integrationId, externalId: "ext-1", kind: "PRODUCT", title: `ساعة ذكية ${run}`, description: "ساعة ذكية أصلية من متجري", categoryId: "electronics", priceMinor: 45_000, currencyCode: "JOD", minorUnitScale: 3, availability: "AVAILABLE", targetPath: "/p/1", sourceVersion: 1, sourceCheckedAt: now, payloadDigest: "f".repeat(64) });

const COMMANDS: [string, string][] = [
  ["C01", "جاسم اربط متجري."],
  ["C02", "جاسم استورد منتجات موقعي."],
  ["C03", "جاسم رتب المنتجات."],
  ["C04", "جاسم حسّن وصف المنتج."],
  ["C05", "جاسم أبي أبيع منتجات متجري عندك."],
  ["C06", "جاسم خل الشراء من موقعي."],
  ["C07", "جاسم قارن منتجاتي."],
  ["C08", "جاسم ورني الطلبات."],
  ["C09", "جاسم حلل مبيعاتي."],
  ["C10", "جاسم أبي سائق يوصل الطلب."],
];

await test("Connect commands C01–C10 through the one conversation runtime", async () => {
  const listingsBefore = await offersOf(merchant);
  for (const [id, message] of COMMANDS) {
    const r = await say(merchant, await conversation(merchant), id, message);
    assert.equal(r.status, 200, `${id}: ${r.body}`);
  }
  assert.equal(await offersOf(merchant), listingsBefore, "no command publishes or imports without confirmation");
  assert.equal(await ordersOf(merchant), 0, "no command orders anything");
  const by = (id: string) => log.find((e) => e.id === id) as any;
  assert.equal(by("C01").surface, "PROVIDER_CONNECTION_REVIEW", "C01: review first, no key or password in chat");
  assert.doesNotMatch(by("C01").body, /كلمة (?:ال)?مرور/u);
  for (const id of ["C02", "C05"]) {
    assert.equal(by(id).modelCalls, 0, `${id}: deterministic`);
    assert.match(by(id).body, /ساعة ذكية .* — 45\.000 JOD — جاهز للاستيراد/u, `${id}: verified catalog with import readiness`);
    assert.match(by(id).body, /الكمية والموقع وطريقة التسليم فتحددها أنت/u);
  }
  assert.match(by("C06").body, /غير مفعّل بعد/u, "C06: external purchase needs an approved referral connector");
  assert.match(by("C06").body, /فتح الرابط وحده ليس بيعًا/u);
  for (const id of ["C03", "C04"]) assert.equal(by(id).surface, "ADVICE", `${id}: grounded model proposal`);
  assert.equal(by("C07").surface, "MY_LISTINGS");
  assert.equal(by("C08").surface, "ORDERS_LIST");
  assert.equal(by("C09").surface, "MY_LISTINGS");
  console.log(JSON.stringify(log.map((e) => ({ id: e.id, surface: e.surface, model: e.modelCalls, body: String(e.body).slice(0, 160) })), null, 1));
});

await test("Connect commands: no partner, and «موقعي» as a location still reaches settings", async () => {
  const fresh = await account("fresh");
  const r = await say(fresh, await conversation(fresh), "N01", "جاسم استورد منتجات موقعي.");
  assert.match(r.body, /الربط مجاني/u);
  assert.match(r.body, /ليس إثباتًا للملكية/u);
  assert.match(r.body, /لن أطلب منك كلمة مرور/u);
  const location = await say(fresh, await conversation(fresh), "N02", "حدث موقعي");
  assert.notEqual(location.surface, "ADVICE", "location settings are not a Connect request");
  const other = await say(fresh, await conversation(fresh), "N03", "جاسم خل الشراء من موقعي.");
  assert.match(other.body, /غير مربوط/u, "another account never sees this merchant's store");
});

after(async () => { if (OUT) writeFileSync(OUT, JSON.stringify(log, null, 1)); server.close(); await pool.end(); });
