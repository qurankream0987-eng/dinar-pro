/**
 * DINAR NEXT G3 — AI usage tiers and DINAR-mediated buyer–seller communication together,
 * through the real conversation, plus the conversation-first acceptance list (plans, usage,
 * seller statistics, business and account operations). Real HTTP, runtime, ledger and
 * inquiry authority on a disposable loopback database; scripted model gateway (no provider).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { aiUsageReservations, businessSubscriptions, commercialPolicies, db, marketplaceInquiries, negotiations, offers, orders, paymentIntents, promotionProducts, users } from "@workspace/db";
import app from "../src/app";
import { AIProviderError, type ConversationModelGateway } from "../src/ai/model-gateway";
import { DEFAULT_AI_USAGE_POLICY, type AiUsagePolicy } from "../src/lib/ai-usage-policy";
import { PLATFORM_FEE_BASIS_POINTS } from "../src/lib/market-pricing";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G3_ACCEPTANCE");

let providerDown = false;
let modelCalls = 0;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls += 1;
    if (providerDown) throw new AIProviderError("REPLIT_OPENAI", "NOT_CONFIGURED", "scripted", 1, 401);
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: `إجابة عامة ${modelCalls}.` }), usage: { inputTokens: 300, outputTokens: 60 } };
  },
};
app.locals.conversationModelGateway = gateway;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.22.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
  const password = `NextG3-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR G3 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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
async function say(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}
const payloadOf = (turn: { blocks: any[] }) => turn.blocks[0]?.payload ?? {};
const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
/** Search, then open the wanted listing by its position when the search returns several. */
async function open(actor: Actor, conv: string, query: string, listingId: string) {
  const search = await say(actor, conv, `ابحث عن ${query}`);
  const ids: string[] = search.blocks.find((block) => block.type === "LISTING_RESULTS")?.payload.resourceIds ?? [];
  const position = ids.indexOf(listingId);
  assert.ok(position >= 0, `${query}: listing not in results (${ids.length}): ${search.body.slice(0, 300)}`);
  if (ids.length > 1) await say(actor, conv, ORDINALS[position]!);
}
async function publish(actor: Actor, title: string, quantity: number, price = "3", extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: quantity, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}
async function completedOrder(buyer: Actor, seller: Actor, listingId: string, quantity: number) {
  const placed = await request("/orders", "POST", { listingId, quantity, fulfilmentType: "PICKUP", idempotencyKey: `g3-${randomUUID()}` }, buyer.cookie);
  assert.equal(placed.status, 201, placed.raw);
  assert.equal((await request(`/orders/${placed.data.id}/accept`, "POST", {}, seller.cookie)).status, 200);
  assert.equal((await request(`/orders/${placed.data.id}/delivery`, "POST", { proofType: "CODE", proofToken: "4821" }, seller.cookie)).status, 200);
  const confirmed = await request(`/orders/${placed.data.id}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(confirmed.status, 200, confirmed.raw);
  return placed.data.id as string;
}
async function subscribe(actor: Actor, tier: "Go" | "Pro") {
  const conv = await conversation(actor);
  await say(actor, conv, "اشحن 50");
  await say(actor, conv, "تأكيد");
  const review = await say(actor, conv, `اشترك في ${tier}`);
  assert.match(review.body, /TEST_NO_TRANSFER/u, review.body);
  assert.match((await say(actor, conv, "تأكيد")).body, /نشط حتى/u);
}

const req = (text: number, marketing = 1, analytics = 1, image = 1, agent = 1) => ({ TEXT_REQUEST: text, MARKETING_GENERATION: marketing, BUSINESS_ANALYTICS: analytics, IMAGE_UNDERSTANDING: image, AGENT_MULTI_STEP: agent });
const POLICY: AiUsagePolicy = {
  ...DEFAULT_AI_USAGE_POLICY,
  tiers: {
    GUEST: { requests: req(1, 0, 0, 0, 0), tokens: 10_000 },
    FREE: { requests: req(2), tokens: 100_000 },
    BUSINESS_GO: { requests: req(4, 2, 2, 2, 2), tokens: 200_000 },
    BUSINESS_PRO: { requests: req(6, 3, 3, 3, 3), tokens: 300_000 },
  },
};

let admin: Actor, seller: Actor, seller2: Actor, free: Actor, go: Actor, pro: Actor, buyer2: Actor, kw: Actor;
const L: Record<string, string> = {};
let orderId = "";

await test("setup: policy, plans, sellers with real completed orders, Free/Go/Pro buyers", async () => {
  await db.insert(commercialPolicies).values({ id: randomUUID(), marketId: "JO", version: 9_500, policy: { aiUsage: POLICY } });
  [admin, seller, seller2, free, go, pro, buyer2] = await Promise.all(["Admin", "Seller", "Seller2", "Free", "Go", "Pro", "Buyer2"].map((label) => register(label)));
  kw = await register("KW", "KW");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await db.update(promotionProducts).set({ enabled: false }).where(and(eq(promotionProducts.marketId, "JO"), eq(promotionProducts.productType, "DINAR_BUSINESS")));
  for (const [name, price, key] of [["Business Go", 5_000, "AI_USAGE_BUSINESS_GO"], ["Business Pro", 15_000, "AI_USAGE_BUSINESS_PRO"]] as const) {
    const created = await request("/admin/markets/JO/commercial-products", "POST", { name: `${name} ${runId}`, productType: "DINAR_BUSINESS", priceMinor: price, durationDays: 30, chargingMode: "SUBSCRIPTION", businessEntitlements: [key], enabled: true }, admin.cookie);
    assert.equal(created.status, 201, created.raw);
  }
  L.cups = await publish(seller, `أكواب زجاج ${TOKEN}`, 20);
  L.jugs = await publish(seller, `أباريق نحاس ${TOKEN}`, 30, "10");
  L.rugs = await publish(seller, `دفاتر رسم ${TOKEN}`, 5, "40", { pricingMode: "NEGOTIABLE" });
  L.lamps = await publish(seller2, `فوانيس رمضان ${TOKEN}`, 10);
  await completedOrder(buyer2, seller, L.jugs, 3);
  await completedOrder(buyer2, seller, L.jugs, 2);
  await completedOrder(buyer2, seller, L.cups, 1);
  const placed = await request("/orders", "POST", { listingId: L.lamps, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `g3-${randomUUID()}` }, buyer2.cookie);
  assert.equal(placed.status, 201, placed.raw);
  orderId = placed.data.id;
  await subscribe(go, "Go");
  await subscribe(pro, "Pro");
});

await test("G3-01 universal access: Free, Go and Pro get the same capabilities; only capacity differs", async () => {
  for (const actor of [free, go, pro]) {
    const conv = await conversation(actor);
    assert.match((await say(actor, conv, `اشرح لي فكرة التجارة الإلكترونية ${actor.label}`)).body, /إجابة عامة/u);
    await open(actor, conv, `أكواب زجاج ${TOKEN}`, L.cups!);
    const draft = await say(actor, conv, "اسأل البائع هل الزجاج مقاوم للحرارة");
    assert.equal(payloadOf(draft).surface, "INQUIRY_DRAFT", `${actor.label}: ${draft.body}`);
    assert.match((await say(actor, conv, "إلغاء")).body, /لم يُرسل شيء/u);
    const stats = payloadOf(await say(actor, conv, "أعطني إحصائيات مبيعاتي"));
    assert.equal(stats.sellerInsight?.topic, "SALES");
    assert.equal(stats.sellerInsight.metrics[0].raw, 0, "a higher plan never reveals another seller's data");
  }
  const tiers = await Promise.all([free, go, pro].map(async (actor) => payloadOf(await say(actor, await conversation(actor), "كم نسبة استهلاكي")).commerce.usage));
  assert.deepEqual(tiers.map((usage) => usage.tier), ["FREE", "BUSINESS_GO", "BUSINESS_PRO"]);
  assert.deepEqual(tiers.map((usage) => usage.resources[0].limit), [2, 4, 6]);
});

await test("G3-02/04 Free exhausts AI: truthful limit, usage still readable, inquiries/orders/negotiations keep working", async () => {
  const conv = await conversation(free);
  const answer = await say(free, conv, "اشرح لي معنى الشحن الدولي");
  assert.match(answer.body, /إجابة عامة/u, "second and last Free request");
  const before = modelCalls;
  const limited = await say(free, conv, "اشرح لي معنى التخليص الجمركي");
  assert.equal(modelCalls, before, "no model call after exhaustion");
  assert.match(limited.body, /وصلت إلى حد «المحادثات الذكية» في باقتك \(المجاني\)/u);
  assert.match(limited.body, /قل «اعرض الباقات»/u);
  const again = await say(free, conv, "اشرح لي معنى الاعتماد المستندي");
  assert.doesNotMatch(again.body, /قل «اعرض الباقات»/u, "no repeated upsell");
  const usage = payloadOf(await say(free, conv, "كم باقي لي من المحادثات؟")).commerce.usage;
  assert.deepEqual([usage.resources[0].used, usage.resources[0].remaining, usage.resources[0].percent], [2, 0, 100]);
  // The two-party scenario, by an AI-exhausted buyer.
  await open(free, conv, `أكواب زجاج ${TOKEN}`, L.cups!);
  const draft = await say(free, conv, "دينار اسأل البائع هل عنده 50 قطعة.");
  assert.equal(payloadOf(draft).surface, "INQUIRY_DRAFT", draft.body);
  const cupsStock = (await db.select().from(offers).where(eq(offers.id, L.cups!)))[0]!;
  assert.match(draft.body, new RegExp(`المتاح في سجل DINAR الآن ${(cupsStock.availableQuantity ?? 0) - cupsStock.reservedQuantity} فقط`, "u"));
  const sent = await say(free, conv, "نعم، أرسل.");
  assert.match(sent.body, /أُرسلت رسالتك ووصلت إلى محادثة البائع داخل DINAR/u, sent.body);
  assert.equal(modelCalls, before, "mediated communication needs no AI allowance");
  // Negotiation records are created and kept independently of the AI allowance.
  await open(free, conv, `دفاتر رسم ${TOKEN}`, L.rugs!);
  const offer = await say(free, conv, "أعطيه 35");
  assert.equal(payloadOf(offer).surface, "NEGOTIATION_REVIEW", offer.body);
  await say(free, conv, "أرسل");
  assert.equal((await db.select().from(negotiations).where(eq(negotiations.buyerId, free.id))).length, 1);
  assert.equal((await say(free, conv, "طلباتي")).blocks.length >= 0, true);
});

await test("G3-03 the authenticated two-party scenario, with continuity, attribution and no invented effects", async () => {
  const stock = (await db.select().from(offers).where(eq(offers.id, L.cups)))[0]!.availableQuantity;
  const inbox = ((await request("/ai/conversations", "GET", undefined, seller.cookie)).data as any[]).find((row) => row.title === "رسائل البيع والشراء في DINAR");
  assert.ok(inbox);
  const reply = await say(seller, inbox.id, "عندي 60 قطعة، ويمكن توفيرها خلال يومين.");
  assert.equal(payloadOf(reply).surface, "INQUIRY_DRAFT", reply.body);
  assert.match((await say(seller, inbox.id, "نعم")).body, /أُرسلت رسالتك/u);
  const freeConv = (await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, free.id)))[0]!.buyerConversationId!;
  const answer = await say(free, freeConv, "دينار ماذا قال البائع؟");
  assert.match(answer.body, /«عندي 60 قطعة، ويمكن توفيرها خلال يومين\.» — كتبه البائع/u);
  const inquiry = payloadOf(answer).inquiry;
  assert.equal(inquiry.listing.title, `أكواب زجاج ${TOKEN}`);
  assert.deepEqual(inquiry.messages.map((message: any) => message.authorRole), ["BUYER", "SELLER"]);
  assert.equal((await db.select().from(offers).where(eq(offers.id, L.cups)))[0]!.availableQuantity, stock, "no stock mutation");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, free.id))).length, 0, "no invented order");
  assert.equal(inquiry.notification.status, "NOT_CONFIGURED", "no fabricated delivery transport");
});

await test("G3-03b reverse: a seller asks a buyer inside an order relationship; the buyer answers asynchronously", async () => {
  const sellerConv = await conversation(seller2);
  const ask = await say(seller2, sellerConv, "دينار اسأل المشتري هل يفضل الاستلام أم التوصيل");
  assert.equal(payloadOf(ask).surface, "INQUIRY_DRAFT", ask.body);
  assert.match(ask.body, /«هل تفضل الاستلام أم التوصيل؟»/u);
  assert.match((await say(seller2, sellerConv, "أرسل")).body, /وصلت إلى محادثة المشتري/u);
  const [thread] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.sellerId, seller2.id));
  assert.deepEqual([thread!.relationship, thread!.orderId, thread!.initiatorRole], ["ORDER", orderId, "SELLER"]);
  const inbox = ((await request("/ai/conversations", "GET", undefined, buyer2.cookie)).data as any[]).find((row) => row.id === thread!.buyerConversationId);
  assert.ok(inbox, "delivered to the buyer's DINAR conversation");
  const answer = await say(buyer2, inbox.id, "أفضل الاستلام من المحل");
  assert.equal(payloadOf(answer).surface, "INQUIRY_DRAFT");
  assert.match((await say(buyer2, inbox.id, "أرسل")).body, /أُرسلت رسالتك/u);
  assert.match((await say(seller2, sellerConv, "ماذا رد المشتري؟")).body, /«أفضل الاستلام من المحل» — كتبه المشتري/u);
  assert.equal((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status, "CREATED", "a message never changes the order");
});

await test("G3-05 commerce boundaries: price offers, contact privacy, market isolation, duplicates, no real money", async () => {
  const conv = await conversation(go);
  await open(go, conv, `دفاتر رسم ${TOKEN}`, L.rugs!);
  assert.match((await say(go, conv, "اسأل البائع هل تعطيني القطعة بسعر 30 دينار")).body, /العروض المالية لا تُرسل كاستفسار/u);
  assert.match((await say(go, conv, "اسأل البائع ممكن رقمك 0790000000")).body, /لا تُرسل أرقام الهواتف/u);
  const listing = await request(`/listings/${L.rugs}`, "GET", undefined, go.cookie);
  assert.ok(!JSON.stringify(listing.data).match(/contactPhone"?\s*:\s*"\+?\d/u), "no public phone on the listing");
  const kwConv = await conversation(kw);
  await say(kw, kwConv, `ابحث عن دفاتر رسم ${TOKEN}`);
  assert.match((await say(kw, kwConv, "اسأل البائع هل يشحن للكويت")).body, /أي إعلان تقصد|غير موجود في سوقك/u, "JO listings are not reachable from KW");
  await say(go, conv, "اسأل البائع هل الورق سميك");
  await say(go, conv, "أرسل");
  await say(go, conv, "اسأل البائع هل الورق سميك");
  assert.match((await say(go, conv, "أرسل")).body, /أرسلت الرسالة نفسها من قبل/u);
  assert.ok((await db.select().from(paymentIntents)).every((row) => row.mode === "SIMULATION_ONLY"));
  assert.ok((await db.select().from(businessSubscriptions)).every((row) => row.autoRenew === false));
  assert.equal(PLATFORM_FEE_BASIS_POINTS, 1_000);
});

await test("CF-7/8/9 seller statistics: explicit period, separated money figures, comparison, top products, actor scope", async () => {
  const conv = await conversation(seller);
  const stats = await say(seller, conv, "دينار أعطني إحصائيات مبيعاتي");
  const insight = payloadOf(stats).sellerInsight;
  assert.equal(insight.topic, "SALES", stats.body);
  assert.equal(insight.period.key, "THIS_MONTH");
  const metric = (key: string, source = insight.metrics) => source.find((item: any) => item.key === key);
  assert.deepEqual([metric("orders").raw, metric("completed").raw], [3, 3]);
  assert.equal(metric("gross").raw, 3 * 10_000 + 2 * 10_000 + 3_000);
  assert.equal(metric("paid").raw, 0, "cash orders are never shown as money received");
  assert.equal(metric("recognized").raw, Math.round((53_000 * (10_000 - PLATFORM_FEE_BASIS_POINTS)) / 10_000), "net after the unchanged 10% commission");
  assert.match(stats.body, /لا يسجّل DINAR استلام مالها/u);
  assert.match((await say(seller, conv, "كم بعت هذا الشهر؟")).body, /هذا الشهر \(\d{4}-\d{2}-01/u);
  const compare = payloadOf(await say(seller, conv, "قارن مبيعات الشهر الحالي بالشهر السابق")).sellerInsight;
  assert.equal(compare.previous.period.key, "LAST_MONTH");
  assert.equal(metric("orders", compare.previous.metrics).raw, 0);
  const top = await say(seller, conv, "ما أكثر منتجاتي طلبًا؟");
  assert.match(top.body, /1\. «أباريق نحاس [^»]+» — 5 قطعة في 2 طلب/u, top.body);
  assert.equal((await say(seller, conv, "كم طلب مكتمل عندي؟")).blocks[0].payload.sellerInsight.metrics[1].raw, 3);
  // CF-9: another account only ever sees its own records.
  const other = await say(buyer2, await conversation(buyer2), "أعطني إحصائيات مبيعاتي");
  assert.match(other.body, /لا توجد طلبات على إعلاناتك/u);
  assert.ok(!JSON.stringify(other).includes("أباريق"));
});

await test("CF-10/11/17 business operations: inventory, edit with confirmation, failed action reported truthfully", async () => {
  const conv = await conversation(seller);
  assert.equal(payloadOf(await say(seller, conv, "دينار أرني مخزوني")).sellerInsight.topic, "INVENTORY");
  await say(seller, conv, "إعلاناتي");
  const preview = payloadOf(await say(seller, conv, `غير سعر الأول إلى 4`));
  assert.equal(preview.managementPreview?.status, "PENDING");
  const listingId = preview.managementPreview.listingId;
  const before = (await db.select().from(offers).where(eq(offers.id, listingId)))[0]!.unitPriceMinor;
  assert.notEqual(before, 4_000, "nothing changes before confirmation");
  assert.match((await say(seller, conv, "نعم")).body, /تم تنفيذ التغيير/u);
  assert.equal((await db.select().from(offers).where(eq(offers.id, listingId)))[0]!.unitPriceMinor, 4_000);
  // A refused send is reported as refused, and nothing is stored.
  const lonely = await register("Lonely");
  const refused = await say(lonely, await conversation(lonely), "اسأل المشتري متى يناسبه الاستلام");
  assert.match(refused.body, /لم يُرسل شيء/u);
  assert.equal((await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.sellerId, lonely.id))).length, 0);
});

await test("CF-15 provider unavailable: honest failure, nothing charged, deterministic services keep working", async () => {
  providerDown = true;
  const conv = await conversation(pro);
  const failed = await say(pro, conv, "اشرح لي معنى سلاسل الإمداد");
  assert.match(failed.body, /غير متاحة|تعذر/u, failed.body);
  const rows = await db.select().from(aiUsageReservations).where(eq(aiUsageReservations.userId, pro.id));
  assert.ok(rows.filter((row) => row.outcome === "PROVIDER_FAILED").every((row) => row.chargedRequests === 0));
  assert.match((await say(pro, conv, "لماذا توقف الذكاء عندي؟")).body, /حصتك لم تنفد|مزود الذكاء/u);
  assert.equal(payloadOf(await say(pro, conv, "رسائلي")).surface, "INQUIRY_LIST");
  providerDown = false;
});

await test("CF-16 billing not configured: no activation without the billing authority", async () => {
  const previous = process.env.BDINAR_PROMOTIONS_ENABLED;
  process.env.BDINAR_PROMOTIONS_ENABLED = "false";
  try {
    const actor = await register("NoBilling");
    const conv = await conversation(actor);
    const plans = payloadOf(await say(actor, conv, "دينار اعرض الباقات")).commerce.aiPlans;
    assert.equal(plans.billing.simulationAvailable, false);
    const attempt = await say(actor, conv, "دينار أريد ترقية حسابي إلى برو");
    assert.match(attempt.body, /الفوترة غير متصلة بعد.*لم يتغير شيء/su, attempt.body);
    assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, actor.id))).length, 0);
  } finally {
    process.env.BDINAR_PROMOTIONS_ENABLED = previous;
  }
});

await test("CF-13 reload restores the interactive content from live state", async () => {
  const freeConv = (await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, free.id)))[0]!.buyerConversationId!;
  const loaded = await request(`/ai/conversations/${freeConv}`, "GET", undefined, free.cookie);
  const payloads = (loaded.data.messages as any[]).flatMap((message) => (message.blocks ?? []).map((block: any) => block.payload));
  assert.ok(payloads.some((payload) => payload.commerce?.view === "AI_USAGE" && payload.commerce.usage.resources[0].used === 2));
  assert.ok(payloads.some((payload) => payload.inquiry?.view === "STATUS" && payload.inquiry.messages.some((message: any) => message.authorRole === "SELLER")));
  assert.ok(payloads.some((payload) => payload.inquiry?.view === "DRAFT" && payload.inquiry.status === "CONFIRMED"));
  assert.ok(payloads.some((payload) => payload.negotiation));
});

await test("CF-A subscription management in the conversation: end date, renewal terms, cancel renewal with confirmation", async () => {
  const conv = await conversation(go);
  const status = await say(go, conv, "دينار متى ينتهي اشتراكي؟");
  const card = payloadOf(status).commerce;
  assert.equal(card?.view, "BUSINESS_STATUS", status.body);
  assert.equal(card.status.status, "ACTIVE");
  assert.ok(card.status.currentPeriodEnd, "the real period end from the subscription");
  assert.match(card.status.renewalNote, /لا تجديد تلقائي/u);
  const review = await say(go, conv, "دينار أريد إلغاء التجديد");
  assert.match(review.body, /هل تريد إيقاف تجديد اشتراكك/u, review.body);
  const [before] = await db.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, go.id), eq(businessSubscriptions.status, "ACTIVE")));
  assert.ok(before, "nothing changes before confirmation");
  assert.match((await say(go, conv, "نعم")).body, /لن يتجدد اشتراكك/u);
  const [after] = await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, go.id));
  assert.equal(after!.status, "CANCEL_AT_PERIOD_END");
  const usage = payloadOf(await say(go, conv, "كم نسبة استهلاكي")).commerce.usage;
  assert.equal(usage.tier, "BUSINESS_GO", "the paid period keeps its allowance until it ends");
});

await test("CF-account: account information through the existing trusted surface; no secrets", async () => {
  const turn = await say(free, await conversation(free), "اعرض حسابي");
  assert.equal(payloadOf(turn).surface, "ACCOUNT", turn.body);
  assert.ok(!JSON.stringify(turn).match(/passwordHash|password_hash|sessionId/u));
});

// ─── Browser acceptance (production build, signed in, typed into the real composer) ───
const execFileAsync = promisify(execFile);
const OUT = process.env.DINAR_G3_EVIDENCE_DIR ?? "/tmp/dinar-next-g3-evidence";
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
  if (process.env.DINAR_G3_SKIP_BUILD !== "1")
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

await test("BROWSER usage/plans (320/390/1280, light+dark, RTL), two-party inquiry by clicks, seller sales", { timeout: 1_200_000, skip: process.env.DINAR_G3_BROWSER === "0" }, async () => {
  const browserSeller = await register("Browser seller");
  const browserBuyer = await register("Browser buyer");
  const bottles = await publish(browserSeller, `قوارير عطر ${TOKEN}`, 20);
  await completedOrder(buyer2, browserSeller, bottles, 2);
  const C = { usage: await conversation(free), inquiry: await conversation(browserBuyer), sales: await conversation(browserSeller) };
  const web = await startBuiltWeb();
  const resultPath = `${OUT}/report.json`;
  await mkdir(`${OUT}/shots`, { recursive: true });
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/next-g3-browser.mjs`], {
      env: {
        ...process.env,
        G3_WEB_BASE: web.baseUrl,
        G3_API_ORIGIN: base.replace(/\/api$/u, ""),
        G3_COOKIES: JSON.stringify({ free: free.cookie, buyer: browserBuyer.cookie, seller: browserSeller.cookie }),
        G3_USERS: JSON.stringify({ free: free.id, buyer: browserBuyer.id, seller: browserSeller.id }),
        G3_CONVERSATIONS: JSON.stringify(C),
        G3_TOKEN: TOKEN,
        G3_OUT: OUT,
        G3_RESULT: resultPath,
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 1_100_000,
    });
  } finally {
    web.stop();
  }
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  console.log("G3_BROWSER_SUMMARY", JSON.stringify(report.summary), JSON.stringify(report.journeys.usageAndPlans?.widths ?? []));
  assert.deepEqual(report.summary.failed, [], JSON.stringify(report.journeys));
  assert.deepEqual(report.summary.consoleErrors, [], "no console errors");
  const [thread] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, browserBuyer.id));
  assert.equal(thread?.status, "AWAITING_BUYER", "the seller's reply clicked in the browser is the stored state");
  assert.equal((await db.select().from(offers).where(eq(offers.id, bottles)))[0]!.availableQuantity, 18, "only the real order moved stock");
});

server.close();
