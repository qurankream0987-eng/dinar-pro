/**
 * DINAR NEXT — universal conversational product control. Theme, subscriptions, browsing market,
 * seller eligibility, account settings and recipient-addressed location sharing through the one
 * conversation: real HTTP, runtime, action foundation and delivery/inquiry authorities on a
 * disposable loopback database, with a scripted model gateway (no provider).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  aiResultSets,
  businessSubscriptions,
  conversations,
  db,
  deliveryAssignments,
  driverProfiles,
  marketplaceInquiries,
  markets,
  paymentIntents,
  sellerMarketEligibility,
  transactionLocations,
  users,
} from "@workspace/db";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import { attachTransactionLocation, selectDeliveryMethod } from "../src/lib/delivery";
import { assignDelivery } from "../src/lib/driver";
import { resolveMarket } from "../src/lib/markets";
import { countriesIn, marketRequest, themeRequest } from "../src/ai/product-control-turn";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

requireSafeReplitDevelopmentDatabase("BDINAR_UCC_ACCEPTANCE");

let providerDown = false;
let modelCalls = 0;
/** What the scripted model answers for the next call (default: a general answer). */
let nextModelTurn: Record<string, unknown> | undefined;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls += 1;
    if (providerDown) throw new AIProviderError("REPLIT_OPENAI", "NOT_CONFIGURED", "scripted", 1, 401);
    const turn = nextModelTurn ?? { responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: `إجابة عامة ${modelCalls}: البرمجة كتابة تعليمات يفهمها الحاسوب.` };
    nextModelTurn = undefined;
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify(turn), usage: { inputTokens: 300, outputTokens: 60 } };
  },
};
app.locals.conversationModelGateway = gateway;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
/** Arabic search token: listing search folds Arabic text; hex ids are not searchable words. */
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.41.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string; label: string };
const phoneBase = 51_630_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Ucc-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR UCC ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, label };
}
async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}
type Turn = { body: string; blocks: any[] };
async function say(actor: Actor, conversationId: string, message: string, extra: Record<string, unknown> = {}): Promise<Turn> {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: actor.cookie }, body: JSON.stringify({ message, ...extra }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}
const payloadOf = (turn: Turn) => turn.blocks[0]?.payload ?? {};
const controlOf = (turn: Turn) => payloadOf(turn).control;
const activeMarket = async (actor: Actor) => (await db.select({ activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, actor.id)))[0]!.activeMarketId;
const conversationMarket = async (id: string) => (await db.select({ marketId: conversations.marketId }).from(conversations).where(eq(conversations.id, id)))[0]!.marketId;
async function history(actor: Actor, conversationId: string) {
  const detail = await request(`/ai/conversations/${conversationId}`, "GET", undefined, actor.cookie);
  assert.equal(detail.status, 200, detail.raw);
  return (detail.data.messages as any[]).flatMap((message) => message.blocks ?? []).map((block) => block.payload).filter((payload) => payload?.control);
}
async function publish(actor: Actor, title: string, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف اختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: "3", inventoryMode: "LIMITED", availableQuantity: 9, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}
async function order(buyer: Actor, seller: Actor, listingId: string, fulfilmentType: "PICKUP" | "DELIVERY") {
  const placed = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType, idempotencyKey: `ucc-${randomUUID()}` }, buyer.cookie);
  assert.equal(placed.status, 201, placed.raw);
  assert.equal((await request(`/orders/${placed.data.id}/accept`, "POST", {}, seller.cookie)).status, 200);
  return placed.data.id as string;
}
const marketRow = async (id: string) => {
  const [row] = await db.select().from(markets).where(eq(markets.id, id));
  return resolveMarket(row!);
};

const buyer = await register("مشتري");
const seller = await register("بائع");
const stranger = await register("غريب");
const results: Record<string, "PASS"> = {};
const pass = (id: string) => (results[id] = "PASS");

// ─── Understanding (slot extraction, not fixed sentences) ─────────────────────

test("UCC-00 theme, country and market slots are understood from varied wording; look-alikes are not", () => {
  for (const [message, theme] of [
    ["دينار اجعل التطبيق بالوضع الفاتح.", "LIGHT"],
    ["دينار حوّل التطبيق للوضع الداكن", "DARK"],
    ["دينار خلي التطبيق لايت مود", "LIGHT"],
    ["دينار فعل الوضع الداكن", "DARK"],
    ["دينار ارجع للوضع حسب الجهاز", "SYSTEM"],
    ["switch the app to dark mode", "DARK"],
    ["الوضع الليلي", "DARK"],
  ] as const)
    assert.equal(themeRequest(message), theme, message);
  for (const message of ["ما هو الوضع الداكن في ويندوز؟", "ابحث عن قميص أسود", "اريد حذاء ابيض", "كيف افعل الوضع الداكن في vs code", "اريد سيارة لونها اسود"])
    assert.equal(themeRequest(message), undefined, message);
  assert.deepEqual(countriesIn("أريد أستخدم السوق السعودي"), ["SA"]);
  assert.deepEqual(countriesIn("حول سوقي من الأردن إلى الكويت"), ["JO", "KW"]);
  assert.deepEqual(countriesIn("أريد تصفح عروض الإمارات"), ["AE"]);
  assert.deepEqual(countriesIn("أنا في عمان"), [], "«عمان» alone is Amman, never Oman");
  assert.equal(marketRequest("دينار أريد العمل في السوق السعودي")?.intent, "BROWSE");
  assert.equal(marketRequest("دينار غيّر سوقي إلى الكويت")?.intent, "BROWSE");
  assert.deepEqual(marketRequest("دينار حول سوقي للسعودية"), { intent: "BROWSE", countries: ["SA"] });
  assert.deepEqual(marketRequest("حول سوقي للأردن"), { intent: "BROWSE", countries: ["JO"] });
  assert.equal(marketRequest("دينار أريد البيع في الأردن")?.intent, "SELL");
  assert.equal(marketRequest("عندي سيارة للبيع في الكويت"), undefined, "an item for sale stays a listing draft");
  assert.equal(marketRequest("ابحث عن سيارة في السعودية"), undefined, "a search with a place is not a market switch");
  assert.equal(marketRequest("غير بلد إقامتي إلى السعودية")?.intent, "RESIDENCE");
  pass("UCC-00");
});

// ─── A. Theme ────────────────────────────────────────────────────────────────

test("UCC-A theme: light, dark, system as client actions; success only after the device acknowledges; reload and idempotency", async () => {
  const conv = await conversation(buyer);
  const before = modelCalls;
  const light = await say(buyer, conv, "دينار اجعل التطبيق بالوضع الفاتح.");
  assert.equal(payloadOf(light).surface, "APP_THEME");
  assert.deepEqual(controlOf(light).clientAction, { type: "SET_THEME", theme: "LIGHT" });
  assert.equal(controlOf(light).status, "REQUESTED");
  assert.doesNotMatch(light.body, /تم/u, "the server never claims the theme was applied");
  const dark = await say(buyer, conv, "دينار حوّل التطبيق للوضع الداكن");
  assert.equal(controlOf(dark).clientAction.theme, "DARK");
  const system = await say(buyer, conv, "دينار ارجع للوضع حسب الجهاز");
  assert.equal(controlOf(system).clientAction.theme, "SYSTEM");
  assert.equal(modelCalls, before, "deterministic control needs no model call");

  const id = payloadOf(dark).resultSetId;
  const ack = await request(`/ai/conversations/${conv}/control-actions/${id}/acknowledgement`, "POST", { status: "APPLIED" }, buyer.cookie);
  assert.equal(ack.status, 200, ack.raw);
  assert.equal(ack.data.status, "APPLIED");
  const late = await request(`/ai/conversations/${conv}/control-actions/${id}/acknowledgement`, "POST", { status: "FAILED" }, buyer.cookie);
  assert.equal(late.data.status, "APPLIED", "an acknowledgement is recorded once");
  const failedId = payloadOf(system).resultSetId;
  assert.equal((await request(`/ai/conversations/${conv}/control-actions/${failedId}/acknowledgement`, "POST", { status: "FAILED" }, buyer.cookie)).data.status, "FAILED");
  assert.equal((await request(`/ai/conversations/${conv}/control-actions/${id}/acknowledgement`, "POST", { status: "APPLIED" }, stranger.cookie)).status, 404, "another user cannot acknowledge");
  assert.equal((await request(`/ai/conversations/${conv}/control-actions/${randomUUID()}/acknowledgement`, "POST", { status: "APPLIED" }, buyer.cookie)).status, 404);
  assert.equal((await request(`/ai/conversations/${conv}/control-actions/${id}/acknowledgement`, "POST", { status: "DONE" }, buyer.cookie)).status, 400, "only APPLIED or FAILED");

  const restored = await history(buyer, conv);
  assert.deepEqual(restored.map((payload) => payload.control.status), ["REQUESTED", "APPLIED", "FAILED"], "reload shows each device outcome");

  // A theme question or a product colour is not a theme change.
  const question = await say(buyer, conv, "ما هو الوضع الداكن في ويندوز؟");
  assert.equal(controlOf(question), undefined);
  pass("UCC-A");
});

// ─── B. Subscriptions ────────────────────────────────────────────────────────

test("UCC-B plans, Go/Pro, pay my subscription: real plan state, no invented price, no activation without verified billing", async () => {
  const conv = await conversation(buyer);
  for (const message of ["دينار اعرض باقاتك", "دينار أريد الاشتراك", "دينار أريد Go", "دينار أريد Pro", "دينار أريد دفع اشتراكي", "دينار كم تكلفة برو؟"]) {
    const turn = await say(buyer, conv, message);
    assert.equal(payloadOf(turn).surface, "AI_PLANS", `${message}: ${turn.body}`);
    assert.doesNotMatch(turn.body, /تم\s+(?:الاشتراك|التفعيل|الدفع)/u, message);
  }
  const go = await say(buyer, conv, "دينار أريد Go");
  assert.match(go.body, /جاسم جو|Go/u);
  assert.match(go.body, /(?:لم يُعتمد سعر|غير متصل|لم يتغير شيء)/u, "unapproved price or billing stated honestly");
  const fake = await say(buyer, conv, "تم الدفع، فعّل Pro الآن");
  assert.doesNotMatch(fake.body, /(?:فعّلت|تم\s+التفعيل|اشتراكك\s+نشط)/u, "a claimed payment activates nothing");
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, buyer.id))).length, 0, "no subscription row");
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.buyerId, buyer.id))).length, 0, "no payment intent");
  const forged = await request("/business/subscriptions", "POST", { planId: "BUSINESS_PRO", idempotencyKey: randomUUID() }, buyer.cookie);
  assert.ok(forged.status >= 400 && forged.status < 500, `unapproved plan cannot be activated directly: ${forged.status}`);
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, buyer.id))).length, 0);
  const usage = await say(buyer, conv, "دينار كم نسبة استهلاكي؟");
  assert.equal(payloadOf(usage).surface, "AI_USAGE");
  pass("UCC-B");
});

// ─── C. Markets ──────────────────────────────────────────────────────────────

test("UCC-C browsing market: review, confirm, listings and currency follow; old orders keep their snapshot; cancel, expiry, unsupported, idempotent", async () => {
  const jordanian = await register("بائع أردني");
  const saudi = await register("بائع سعودي", "SA");
  const shopper = await register("متسوق");
  const joListing = await publish(jordanian, `أكواب زجاج ${TOKEN}`);
  const saListing = await publish(saudi, `أباريق نحاس ${TOKEN}`, { city: "الرياض", area: "العليا" });
  const oldOrder = await order(shopper, jordanian, joListing, "PICKUP");
  const before = (await request(`/orders/${oldOrder}`, "GET", undefined, shopper.cookie)).data;

  const conv = await conversation(shopper);
  const review = await say(shopper, conv, "دينار أريد أستخدم السوق السعودي");
  assert.equal(payloadOf(review).surface, "MARKET_SWITCH_REVIEW", review.body);
  assert.equal(controlOf(review).status, "AWAITING_CONFIRMATION");
  assert.equal(controlOf(review).to.marketId, "SA");
  assert.equal(controlOf(review).to.currencyCode, "SAR");
  assert.equal(await activeMarket(shopper), "JO", "nothing changes before confirmation");

  const done = await say(shopper, conv, "نعم، حوّل السوق");
  assert.equal(payloadOf(done).surface, "MARKET_SWITCH_STATUS", done.body);
  assert.equal(controlOf(done).status, "SUCCEEDED");
  assert.equal(await activeMarket(shopper), "SA");
  assert.equal(await conversationMarket(conv), "SA", "the conversation follows the new market");
  const again = await say(shopper, conv, "نعم");
  assert.match(again.body, /تمت معالجة/u, "a repeated confirmation changes nothing");
  assert.equal(await activeMarket(shopper), "SA");

  const search = await say(shopper, conv, `ابحث عن أباريق نحاس ${TOKEN}`);
  const ids: string[] = search.blocks.find((block) => block.type === "LISTING_RESULTS")?.payload.resourceIds ?? [];
  assert.ok(ids.includes(saListing), `Saudi listing found: ${search.body.slice(0, 200)}`);
  const joSearch = await say(shopper, conv, `ابحث عن أكواب زجاج ${TOKEN}`);
  assert.ok(!(joSearch.blocks.find((block) => block.type === "LISTING_RESULTS")?.payload.resourceIds ?? []).includes(joListing), "Jordanian listing no longer offered");
  const listings: any[] = search.blocks.find((block) => block.type === "LISTING_RESULTS")?.payload.listings ?? [];
  assert.ok(listings.every((listing) => !listing.currencyCode || listing.currencyCode === "SAR"), "prices in SAR");

  const after = (await request(`/orders/${oldOrder}`, "GET", undefined, shopper.cookie)).data;
  assert.equal(before.marketId, "JO");
  assert.equal(before.currency, "JOD");
  assert.deepEqual(
    { marketId: after.marketId, currency: after.currency, subtotalMinor: after.subtotalMinor, unitPriceMinor: after.unitPriceMinor, minorUnitScale: after.minorUnitScale },
    { marketId: before.marketId, currency: before.currency, subtotalMinor: before.subtotalMinor, unitPriceMinor: before.unitPriceMinor, minorUnitScale: before.minorUnitScale },
    "the old order keeps its market and financial snapshot",
  );

  const kuwait = await say(shopper, conv, "دينار غيّر سوقي إلى الكويت");
  assert.equal(controlOf(kuwait).to.marketId, "KW");
  const cancelled = await say(shopper, conv, "إلغاء");
  assert.equal(controlOf(cancelled).status, "CANCELLED");
  assert.equal(await activeMarket(shopper), "SA");

  const late = await say(shopper, conv, "حول سوقي للأردن");
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiResultSets.id, payloadOf(late).resultSetId));
  const expired = await say(shopper, conv, "نعم");
  assert.equal(controlOf(expired).status, "EXPIRED", expired.body);
  assert.equal(await activeMarket(shopper), "SA", "an expired confirmation cannot execute");

  const emirates = await say(shopper, conv, "دينار أريد تصفح عروض الإمارات");
  assert.equal(controlOf(emirates).view, "CONTROL_NOTICE");
  assert.equal(controlOf(emirates).tone, "UNAVAILABLE");
  assert.ok((controlOf(emirates).options ?? []).length >= 1, "available markets offered");
  await db.insert(markets).values({ id: "QA", countryCode: "QA", countryNameAr: "قطر", countryNameEn: "Qatar", currencyCode: "QAR", currencySymbolAr: "ر.ق", unitPriceMinor: 100, minorUnitScale: 2, isActive: false, status: "COMING_SOON" }).onConflictDoNothing();
  const qatar = await say(shopper, conv, "حول سوقي إلى قطر");
  assert.equal(controlOf(qatar).tone, "UNAVAILABLE", qatar.body);
  assert.equal(await activeMarket(shopper), "SA");

  const residence = await say(shopper, conv, "غير بلد إقامتي إلى الأردن");
  assert.equal(controlOf(residence).tone, "REFUSED");
  const [{ accountCountry }] = await db.select({ accountCountry: users.accountCountry }).from(users).where(eq(users.id, shopper.id));
  assert.equal(accountCountry, "KW", "legal country untouched");
  pass("UCC-C");
});

test("UCC-C2 seller cross-border eligibility is read, never granted, from the conversation", async () => {
  const merchant = await register("تاجر", "SA");
  const conv = await conversation(merchant);
  const open = await say(merchant, conv, "دينار أريد البيع في الأردن");
  assert.equal(controlOf(open).view, "CONTROL_NOTICE", open.body);
  assert.equal(await activeMarket(merchant), "SA", "asking about selling changes nothing");
  await db.update(markets).set({ sellerEligibilityMode: "APPROVAL_REQUIRED" }).where(eq(markets.id, "KW"));
  try {
    const gated = await say(merchant, conv, "أريد البيع في الكويت");
    assert.equal(controlOf(gated).tone, "REFUSED", gated.body);
    assert.match(gated.body, /موافقة/u);
    assert.equal((await db.select().from(sellerMarketEligibility).where(eq(sellerMarketEligibility.userId, merchant.id))).length, 0, "no eligibility granted");
  } finally {
    await db.update(markets).set({ sellerEligibilityMode: "OPEN" }).where(eq(markets.id, "KW"));
  }
  pass("UCC-C2");
});

// ─── D. Model discovery, topic switching, no sticky modes ────────────────────

test("UCC-D model-named capability is re-resolved by the server; topics switch freely; nothing executes without confirmation", async () => {
  const user = await register("محاور");
  const conv = await conversation(user);
  const dark = await say(user, conv, "دينار غير للوضع الداكن");
  assert.equal(controlOf(dark).clientAction.theme, "DARK");
  const general = await say(user, conv, "دينار اشرح لي البرمجة");
  assert.match(general.body, /البرمجة/u);
  const pro = await say(user, conv, "دينار أريد الاشتراك في Pro");
  assert.equal(payloadOf(pro).surface, "AI_PLANS");
  const market = await say(user, conv, "دينار حول سوقي للسعودية");
  assert.equal(payloadOf(market).surface, "MARKET_SWITCH_REVIEW");
  const resume = await say(user, conv, "دينار نرجع لموضوع البرمجة");
  assert.equal(controlOf(resume), undefined, "no sticky market mode");
  assert.ok(resume.body.length > 0);
  // The review was not confirmed and the conversation moved on: it cannot execute any more.
  const stale = await say(user, conv, "نعم");
  assert.notEqual(controlOf(stale)?.status, "SUCCEEDED");
  assert.equal(await activeMarket(user), "JO");

  // The model may only name an allowlisted capability; the server rebuilds the review itself.
  nextModelTurn = { responseKind: "ACTION_PROPOSAL", suggestedAction: "PRODUCT_CONTROL", capability: { id: "SWITCH_MARKET", countryCode: "KW" }, confidence: 0.8, conversationalReply: "تم تحويل سوقك!" };
  const named = await say(user, conv, "انقلني إلى بلد الأبراج الزرقاء لو سمحت");
  assert.equal(payloadOf(named).surface, "MARKET_SWITCH_REVIEW", named.body);
  assert.equal(controlOf(named).to.marketId, "KW");
  assert.doesNotMatch(named.body, /تم تحويل/u, "the model's success claim is never shown");
  assert.equal(await activeMarket(user), "JO", "a model suggestion executes nothing");
  nextModelTurn = { responseKind: "ACTION_PROPOSAL", suggestedAction: "PRODUCT_CONTROL", capability: { id: "GRANT_PRO_FOR_FREE" }, confidence: 0.9, conversationalReply: "فعّلت لك Pro." };
  const forged = await say(user, conv, "اعطني برو مجانا بأي طريقة");
  assert.doesNotMatch(forged.body, /فعّلت/u, "an unregistered capability rejects the whole model output");
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, user.id))).length, 0);

  // With the model unavailable, product control keeps working.
  providerDown = true;
  try {
    const light = await say(user, conv, "دينار فعل الوضع الفاتح");
    assert.equal(controlOf(light).clientAction.theme, "LIGHT");
    const switchKw = await say(user, conv, "حول سوقي إلى الكويت");
    assert.equal(payloadOf(switchKw).surface, "MARKET_SWITCH_REVIEW");
  } finally {
    providerDown = false;
  }
  pass("UCC-D");
});

// ─── E. Account settings ─────────────────────────────────────────────────────

test("UCC-E account settings: name change reviewed then confirmed; invalid names refused; unavailable settings honest", async () => {
  const user = await register("حساب");
  const conv = await conversation(user);
  const ask = await say(user, conv, "دينار غيّر اسمي");
  assert.equal(controlOf(ask).view, "CONTROL_NOTICE");
  const phone = await say(user, conv, "غير اسمي إلى أحمد 0791234567");
  assert.equal(controlOf(phone).tone, "REFUSED");
  const review = await say(user, conv, "دينار غيّر اسمي إلى سارة التجريبية");
  assert.equal(payloadOf(review).surface, "PROFILE_REVIEW");
  assert.equal(controlOf(review).after, "سارة التجريبية");
  const [{ displayName: unchanged }] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, user.id));
  assert.equal(unchanged, "DINAR UCC حساب", "the name registered above is unchanged before confirmation");
  const done = await say(user, conv, "نعم");
  assert.equal(controlOf(done).status, "SUCCEEDED", done.body);
  const [{ displayName }] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, user.id));
  assert.equal(displayName, "سارة التجريبية");
  const me = await request("/auth/me", "GET", undefined, user.cookie);
  assert.equal(me.data.user?.displayName ?? me.data.displayName, "سارة التجريبية");

  // Pre-integration closure: preferences now have an authority (lib/privacy-rights); the card
  // still says honestly that outbound email/SMS/push channels are not connected.
  const notifications = await say(user, conv, "دينار غير تفضيلات الإشعارات");
  assert.equal(controlOf(notifications).tone, "INFO");
  assert.ok(controlOf(notifications).lines.some((line: string) => /غير موصولة/u.test(line)));
  const business = await say(user, conv, "دينار عدل وصف مطعمي");
  assert.equal(controlOf(business).tone, "UNAVAILABLE");
  const account = await say(user, conv, "دينار أرني بيانات حسابي");
  assert.equal(payloadOf(account).surface, "ACCOUNT");
  const logout = await say(user, conv, "دينار سجلني خروج");
  assert.equal(payloadOf(logout).surface, "LOGOUT");

  const restored = await history(user, conv);
  const profileCards = restored.filter((payload) => payload.control.view === "PROFILE_REVIEW");
  assert.equal(profileCards.at(-1)?.control.status, "SUCCEEDED", "reload shows the confirmed review as done");
  pass("UCC-E");
});

// ─── F. Location ─────────────────────────────────────────────────────────────

test("UCC-F location: own order only, assigned driver only, public business area only, private home refused", async () => {
  const shop = await register("مطعم");
  const customer = await register("زبون");
  const driver = await register("سائق");
  const otherDriver = await register("سائق آخر");
  // COURIER is offered only where the market policy enables it (as in the F4 suite).
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  const JO = await marketRow("JO");

  // No order: nothing to share with anyone.
  const conv = await conversation(customer);
  const none = await say(customer, conv, "دينار أرسل موقعي للسائق المسؤول عن طلبي");
  assert.match(none.body, /لا يوجد مندوب/u, none.body);

  // Seller-delivered order: «سأرسل لك موقعي» opens the one-time location request for it.
  const deliveryListing = await publish(shop, `وجبة توصيل ${runId}`, { fulfilmentType: "DELIVERY" });
  const sellerDelivered = await order(customer, shop, deliveryListing, "DELIVERY");
  await db.transaction((tx) => selectDeliveryMethod({ actorId: customer.id, orderId: sellerDelivered, method: "SELLER_DELIVERY", market: JO }, tx));
  const offer = await say(customer, conv, "دينار سأرسل لك موقعي");
  assert.equal(payloadOf(offer).surface, "LOCATION_PERMISSION_REQUEST", offer.body);
  const cancelled = await say(customer, conv, "إلغاء");
  assert.match(cancelled.body, /أُلغيت مشاركة الموقع/u);
  assert.equal((await db.select().from(transactionLocations).where(eq(transactionLocations.orderId, sellerDelivered))).length, 0, "cancelled: nothing stored");
  const manual = await say(customer, conv, "أريد أكتب العنوان يدويا");
  assert.equal(payloadOf(manual).surface, "MANUAL_ADDRESS", manual.body);
  const preview = await say(customer, conv, "عنواني", { location: { source: "MANUAL", city: "عمان", area: "الصويفية", addressText: "شارع الوكالات عمارة 9" }, locationRequestId: payloadOf(manual).resultSetId });
  assert.equal(payloadOf(preview).surface, "LOCATION_PREVIEW", preview.body);
  const confirmed = await say(customer, conv, "نعم");
  assert.equal(payloadOf(confirmed).surface, "LOCATION_CONFIRMED", confirmed.body);
  assert.equal((await db.select().from(transactionLocations).where(eq(transactionLocations.orderId, sellerDelivered))).length, 1);

  // Courier order: only the driver who accepted it can read the destination.
  for (const actor of [driver, otherDriver])
    await db.insert(driverProfiles).values({ id: randomUUID(), userId: actor.id, marketId: "JO", status: "APPROVED", availability: "AVAILABLE", vehicleType: "CAR", serviceCity: "عمان" });
  const courierListing = await publish(shop, `وجبة مندوب ${runId}`, { fulfilmentType: "DELIVERY" });
  const courier = await order(customer, shop, courierListing, "DELIVERY");
  await db.transaction((tx) => selectDeliveryMethod({ actorId: customer.id, orderId: courier, method: "COURIER", market: JO }, tx));
  const unassigned = await say(customer, conv, "دينار أرسل موقعي للسائق المسؤول عن طلبي");
  assert.match(unassigned.body, /لا يوجد مندوب/u, "no assigned driver yet: nothing is sent");
  await db.transaction((tx) => attachTransactionLocation({ actorId: customer.id, orderId: courier, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", city: "عمان", area: "خلدا", addressText: "خلف المخبز الأزرق" }, market: JO }, tx));
  await assignDelivery({ actorId: driver.id, orderId: courier, market: JO });
  assert.equal((await db.select().from(deliveryAssignments).where(and(eq(deliveryAssignments.orderId, courier), eq(deliveryAssignments.status, "ACCEPTED")))).length, 1);
  const toDriver = await say(customer, conv, "دينار أرسل موقعي للسائق المسؤول عن طلبي");
  assert.match(toDriver.body, /مندوب التوصيل المُسنَد/u, toDriver.body);
  assert.equal((await request(`/orders/${courier}/fulfillment`, "GET", undefined, driver.cookie)).status, 200, "assigned driver reads the destination");
  assert.equal((await request(`/orders/${courier}/fulfillment`, "GET", undefined, otherDriver.cookie)).status, 404, "another driver is denied");
  assert.equal((await request(`/orders/${courier}/fulfillment`, "GET", undefined, stranger.cookie)).status, 404);

  // Business location: pickup point inside a pickup order, else the listing's public area via an existing inquiry.
  const loner = await register("مطعم بلا عملاء");
  const nobody = await say(loner, await conversation(loner), "دينار أرسل موقع مطعمي إلى العميل الذي طلب زيارته");
  assert.match(nobody.body, /لا يمكنني مراسلة مشترٍ/u, "no relationship: nothing sent");
  const cafe = await register("مقهى");
  const shopConv = await conversation(cafe);
  const pickupListing = await publish(cafe, `فوانيس رمضان ${TOKEN}`);
  const askConv = await conversation(customer);
  const search = await say(customer, askConv, `ابحث عن فوانيس رمضان ${TOKEN}`);
  assert.ok((search.blocks.find((block) => block.type === "LISTING_RESULTS")?.payload.resourceIds ?? []).includes(pickupListing));
  await say(customer, askConv, "اسأل البائع هل يمكن زيارة المطعم مساء");
  await say(customer, askConv, "أرسل");
  assert.equal((await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.sellerId, cafe.id))).length, 1);
  const home = await say(cafe, shopConv, "أرسل عنوان بيتي للعميل");
  assert.equal(controlOf(home).tone, "REFUSED");
  const precise = await say(cafe, shopConv, "أرسل موقع مطعمي للعميل: شارع الجامعة بناية 12");
  assert.equal(controlOf(precise).tone, "REFUSED", "a precise address never goes through a message");
  const publicArea = await say(cafe, shopConv, "دينار أرسل موقع مطعمي إلى العميل الذي طلب زيارته");
  assert.equal(payloadOf(publicArea).surface, "INQUIRY_DRAFT", publicArea.body);
  assert.match(publicArea.body, /خلدا، عمان/u);
  assert.doesNotMatch(publicArea.body, /شارع|بناية|\d{3,}/u);
  const sent = await say(cafe, shopConv, "أرسل");
  assert.match(sent.body, /أُرسل|وصل|تم الإرسال|أرسلت/u, sent.body);
  const reply = await say(customer, askConv, "ماذا رد البائع؟");
  assert.match(reply.body, /موقعنا العام: خلدا، عمان/u, reply.body);

  // A confirmed pickup order: the seller's pickup point, seen by that order's buyer only.
  const pickupOrder = await order(customer, cafe, pickupListing, "PICKUP");
  await db.transaction((tx) => selectDeliveryMethod({ actorId: customer.id, orderId: pickupOrder, method: "PICKUP", market: JO }, tx));
  const pickup = await say(cafe, shopConv, "أرسل موقع مطعمي للعميل");
  assert.equal(payloadOf(pickup).surface, "LOCATION_PERMISSION_REQUEST", pickup.body);
  assert.match(pickup.body, /موقع نشاطك العام/u);
  pass("UCC-F");
});

// ─── G. Browser ──────────────────────────────────────────────────────────────

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
async function startBuiltWeb() {
  const webPort = await availablePort();
  const env = { ...process.env, PORT: String(webPort), BASE_PATH: "/", NODE_ENV: "production" };
  if (process.env.DINAR_UCC_SKIP_BUILD !== "1")
    await execFileAsync("pnpm", ["--filter", "@workspace/dinar", "run", "build"], { cwd: process.cwd(), env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const child = spawn("pnpm", ["--filter", "@workspace/dinar", "run", "serve"], { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const stop = () => {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok && (await response.text()).includes('<div id="root"')) return { baseUrl, stop };
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`vite preview exited:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stop();
  throw new Error(`vite preview did not start:\n${output}`);
}

test("UCC-G browser: theme at 11 widths (reload, system, tabs), market by click, profile by keyboard, compact cards, no overflow", { timeout: 1_500_000, skip: process.env.DINAR_UCC_BROWSER === "0" }, async () => {
  const OUT = process.env.UCC_OUT ?? `/tmp/dinar-ucc-${runId}`;
  const actors = { theme: await register("متصفح المظهر"), market320: await register("متصفح السوق 320"), market1280: await register("متصفح السوق 1280"), profile: await register("متصفح الاسم"), tabs: await register("متصفح التبويبات") };
  const C = Object.fromEntries(await Promise.all(Object.entries(actors).map(async ([key, actor]) => [key, await conversation(actor)])));
  const web = await startBuiltWeb();
  const resultPath = `${OUT}/report.json`;
  await mkdir(`${OUT}/shots`, { recursive: true });
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/universal-control-browser.mjs`], {
      env: {
        ...process.env,
        UCC_WEB_BASE: web.baseUrl,
        UCC_API_ORIGIN: base.replace(/\/api$/u, ""),
        UCC_COOKIES: JSON.stringify(Object.fromEntries(Object.entries(actors).map(([key, actor]) => [key, actor.cookie]))),
        UCC_USERS: JSON.stringify(Object.fromEntries(Object.entries(actors).map(([key, actor]) => [key, actor.id]))),
        UCC_CONVERSATIONS: JSON.stringify(C),
        UCC_OUT: OUT,
        UCC_RESULT: resultPath,
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 1_400_000,
    });
  } finally {
    web.stop();
  }
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  console.log("UCC_BROWSER_SUMMARY", JSON.stringify(report.summary), JSON.stringify(report.journeys.themeAtEveryWidth?.widths ?? []));
  assert.deepEqual(report.summary.failed, [], JSON.stringify(report.journeys));
  assert.deepEqual(report.summary.consoleErrors, [], "no console errors");
  assert.equal(await activeMarket(actors.market320), "SA", "the click confirmed the switch on the server");
  pass("UCC-G");
});

test("UCC-SUMMARY", () => {
  console.log("UCC_SUMMARY", JSON.stringify(results));
  server.close();
});
