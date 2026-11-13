import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { aiResultSets, cartItems, carts, db, listingPromotions, pool, promotionProducts } from "@workspace/db";
import { confirmPendingAction } from "../src/ai/action-foundation";
import { resolveMarket } from "../src/lib/markets";
import { markets } from "@workspace/db";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `b${randomUUID().replaceAll("-", "").slice(0, 7)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.20.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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

type Actor = { id: string; cookie: string };
const phoneBase = 51_150_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `BlockF2-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F2 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

type Turn = { body: string; payload: any };
async function turn(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const before = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  assert.equal(getModelGatewayCallCount() - before, 0, `model call for ${message}`);
  return { body: complete.assistantMessage.body, payload: complete.assistantMessage.blocks[0]?.payload };
}


type Spec = { title: string; price: string; condition?: string; seller: Actor };
async function publish(spec: Spec) {
  const created = await request("/listings", "POST", {
    title: spec.title,
    description: `${spec.title} — قطن مريح وخياطة متينة، اختبار ${runId}`,
    category: "أزياء", categoryId: "fashion", area: "خلدا", city: "عمان",
    attributes: spec.condition ? { condition: spec.condition } : {},
    unitPrice: spec.price, inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, spec.seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

const results: Record<string, "PASS" | "FAIL"> = {};
async function focused(id: string, name: string, body: () => Promise<void>) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}

let sellerA: Actor;
let sellerB: Actor;
let buyer: Actor;
const T: Record<string, string> = {};
let conv = "";
let rankConv = "";
const ids = (turnResult: Turn) => (turnResult.payload?.listings ?? []).map((listing: any) => listing.id);
const setOf = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;
const newConversation = async (actor = buyer) => (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id as string;

await test("setup: fresh sellers, buyer, fashion listings and one paid placement", async () => {
  [sellerA, sellerB, buyer] = await Promise.all(["Seller A", "Seller B", "Buyer"].map(register));
  T.blackL5 = await publish({ title: "تيشيرت نايكي أسود مقاس L", price: "5", condition: "جديد", seller: sellerA });
  T.blackM6 = await publish({ title: "تيشيرت نايكي أسود مقاس M", price: "6", condition: "جديد", seller: sellerA });
  T.whiteL4 = await publish({ title: "تيشيرت نايكي أبيض مقاس L", price: "4", condition: "مستعمل", seller: sellerA });
  T.blackL7 = await publish({ title: "تيشيرت نايكي أسود مقاس L", price: "7", condition: "مستعمل", seller: sellerB });
  T.blackL9 = await publish({ title: "تيشيرت نايكي أسود مقاس L", price: "9", condition: "جديد", seller: sellerB });
  T.grey = await publish({ title: "تيشيرت نايكي رمادي", price: "6", seller: sellerB });
  T.adidas = await publish({ title: "تيشيرت أديداس أسود مقاس L", price: "5", condition: "جديد", seller: sellerB });
  // Fixture: an already captured simulated campaign on a weaker listing (used, pricier).
  const [plan] = await db.insert(promotionProducts).values({ id: randomUUID(), marketId: "JO", categoryId: "fashion", name: `F2 ${runId}`, priceMinor: 1000, currencyCode: "JOD", durationDays: 7, enabled: false }).returning();
  await db.insert(listingPromotions).values({
    id: randomUUID(), listingId: T.blackL7!, sellerId: sellerB.id, marketId: "JO", productId: plan!.id, productNameSnapshot: plan!.name,
    categoryIdSnapshot: "fashion", priceMinorSnapshot: 1000, currencyCodeSnapshot: "JOD", placementSnapshot: "SEARCH_AND_CHAT", durationDaysSnapshot: 7,
    status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED", startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
  });
  conv = await newConversation();
});

await focused("F2-01", "natural search: category, brand words, target price and a preference", async () => {
  const found = await turn(buyer, conv, `أريد تيشرت نايكي مميز بسعر 5 ${runId}`);
  const set = await setOf(found.payload.resultSetId);
  const state = (set.query as any).buyer;
  assert.equal(state.categoryId, "fashion");
  assert.equal(state.targetPrice, 5);
  assert.equal(state.quality, true);
  assert.ok(!state.filters.some((filter: any) => filter.field === "price"), "a target price is not an exact filter");
  assert.ok(!ids(found).includes(T.adidas), "brand words must match");
  assert.ok(ids(found).includes(T.blackL5) && ids(found).includes(T.blackL9));
  const organic = found.payload.listings.filter((listing: any) => !listing.isSponsored);
  assert.equal(organic[0].id, T.blackL5, "closest to the target price first");
  assert.match(found.body, /«مميز» تفضيل شخصي لا أستطيع التحقق منه/);
});

let narrowed: Turn;
await focused("F2-02", "multi-turn deltas keep the earlier constraints", async () => {
  const black = await turn(buyer, conv, "خله أسود");
  assert.ok(ids(black).length && ids(black).every((id: string) => [T.blackL5, T.blackM6, T.blackL7, T.blackL9].includes(id)));
  const large = await turn(buyer, conv, "مقاس L");
  assert.deepEqual(new Set(ids(large)), new Set([T.blackL5, T.blackL7, T.blackL9]));
  narrowed = await turn(buyer, conv, "إلى 7 عادي");
  assert.deepEqual(new Set(ids(narrowed)), new Set([T.blackL5, T.blackL7]));
  const state = ((await setOf(narrowed.payload.resultSetId)).query as any).buyer;
  assert.deepEqual([state.color, state.size, state.maxPrice, state.targetPrice, state.categoryId], ["اسود", "l", 7, 5, "fashion"]);
  assert.match(narrowed.body, /اللون اسود، المقاس L، حتى 7 JOD/);
});

await focused("F2-03", "«أرخص واحد» orders the current constraints by price", async () => {
  const cheapest = await turn(buyer, conv, "أرخص واحد");
  assert.deepEqual(ids(cheapest), [T.blackL5, T.blackL7]);
  assert.ok(cheapest.payload.listings.every((listing: any) => !listing.isSponsored), "a chosen order carries no paid slot");
  assert.match(cheapest.payload.listings[0].recommendationReasons[0], /^السعر 5/);
});

let bestValue: Turn;
await focused("F2-04", "best value is explained, deterministic and not a claimed truth", async () => {
  bestValue = await turn(buyer, conv, "الأفضل مقابل السعر");
  assert.deepEqual(ids(bestValue), [T.blackL5, T.blackL7]);
  assert.match(bestValue.body, /تقديريًا/);
  assert.match(bestValue.body, /ليس حكمًا قاطعًا/);
  assert.ok(bestValue.payload.listings[0].recommendationReasons.includes("الحالة: جديد"));
  const again = await turn(buyer, conv, "الأفضل");
  assert.deepEqual(ids(again), ids(bestValue), "same signals, same order");
});

await focused("F2-09", "paid placement stays labelled and never makes a listing «best»", async () => {
  const paidConv = await newConversation();
  const found = await turn(buyer, paidConv, `أبي تيشرت نايكي أسود ${runId}`);
  assert.equal(found.payload.listings[0].id, T.blackL7);
  assert.equal(found.payload.listings[0].isSponsored, true, "the default view labels the paid slot");
  const best = await turn(buyer, paidConv, "الأفضل مقابل السعر");
  assert.ok(best.payload.listings.every((listing: any) => !listing.isSponsored));
  assert.notEqual(best.payload.listings[0].id, T.blackL7, "payment is not a ranking signal");
  assert.match(best.body, /العروض الممولة لا تحصل على أي أفضلية/);
  for (const listing of best.payload.listings) assert.ok(!listing.recommendationReasons.some((reason: string) => /ممول|إعلان/.test(reason)));
});

await focused("F2-05", "an explicit priority overrides the default ranking", async () => {
  rankConv = await newConversation();
  await turn(buyer, rankConv, `أريد تيشرت نايكي ${runId}`);
  const cheapest = await turn(buyer, rankConv, "أبي الأرخص فقط");
  assert.equal(ids(cheapest)[0], T.whiteL4);
  const condition = await turn(buyer, rankConv, "ما يهمني السعر، أهم شيء الحالة");
  const first = condition.payload.listings[0];
  assert.equal(first.attributes.condition, "جديد");
  assert.notEqual(first.id, T.whiteL4);
  const used = condition.payload.listings.findIndex((listing: any) => listing.attributes?.condition === "مستعمل");
  const unknown = condition.payload.listings.findIndex((listing: any) => !listing.attributes?.condition);
  assert.ok(condition.payload.listings.slice(0, used).every((listing: any) => listing.attributes.condition === "جديد"));
  assert.ok(unknown > used, "an unknown condition never outranks a stated one");
  assert.match(condition.body, /الحالة أولًا/);
});

await focused("F2-06", "comparison shows current server facts side by side", async () => {
  const set = await setOf((await turn(buyer, rankConv, "رجعني")).payload.resultSetId);
  const compared = await turn(buyer, rankConv, "قارن الأول والثالث");
  assert.equal(compared.payload.surface, "COMPARISON");
  const comparison = compared.payload.comparison;
  assert.deepEqual(comparison.listings.map((listing: any) => listing.id), [set.resourceIds[0], set.resourceIds[2]]);
  const price = comparison.rows.find((row: any) => row.label === "السعر");
  const rows = await Promise.all([set.resourceIds[0], set.resourceIds[2]].map(async (id) => (await db.select().from((await import("@workspace/db")).offers).where(eq((await import("@workspace/db")).offers.id, id!)))[0]!));
  assert.deepEqual(price.values, rows.map((row) => `${(row.unitPriceMinor! / 1000).toFixed(3)} JOD`));
  assert.match(compared.body, /جاسم فقط/);
});

await focused("F2-07", "an unknown field stays unknown; nothing is invented", async () => {
  const unknownConv = await newConversation();
  const found = await turn(buyer, unknownConv, `أبي تيشرت نايكي رمادي ${runId}`);
  assert.deepEqual(ids(found), [T.grey]);
  await turn(buyer, unknownConv, `أبي تيشرت نايكي ${runId}`);
  const set = await setOf((await turn(buyer, unknownConv, "الأرخص")).payload.resultSetId);
  const grey = set.resourceIds.indexOf(T.grey!) + 1;
  const other = grey === 1 ? 2 : 1;
  const compared = await turn(buyer, unknownConv, `قارن ${Math.min(grey, other)} و ${Math.max(grey, other)}`);
  const condition = compared.payload.comparison.rows.find((row: any) => row.label === "الحالة");
  const greyColumn = compared.payload.comparison.listings.findIndex((listing: any) => listing.id === T.grey);
  assert.equal(condition.values[greyColumn], null, "condition not stated by the seller stays null («لم يذكر البائع»)");
  const labels = compared.payload.comparison.rows.map((row: any) => row.label);
  for (const invented of ["الماركة", "الخامة", "المقاس", "اللون"]) assert.ok(!labels.includes(invented), `${invented} is not a registry field`);
  assert.equal(compared.payload.comparison.unknownLabel, "لم يذكر البائع");
});

await focused("F2-08", "similar and cheaper alternatives reuse the Block E recommender", async () => {
  const recConv = await newConversation();
  await turn(buyer, recConv, `تيشرت نايكي أسود مقاس L ${runId}`);
  await turn(buyer, recConv, "الأول");
  const similar = await turn(buyer, recConv, "أرني شيء مشابه");
  const set = await setOf(similar.payload.resultSetId);
  assert.ok((set.query as any).recommendation, "a Block E recommendation result set");
  assert.ok(similar.payload.listings.length > 0);
  assert.ok(similar.payload.listings.every((listing: any) => Array.isArray(listing.recommendationReasons)));
  const cheaper = await turn(buyer, recConv, "شيء أرخص");
  assert.equal(((await setOf(cheaper.payload.resultSetId)).query as any).recommendation.cheaper, true);
  const alternatives = await turn(buyer, recConv, "بدائل");
  assert.ok(((await setOf(alternatives.payload.resultSetId)).query as any).recommendation);
});

let reviewId = "";
await focused("F2-10", "«أبي الثاني» resolves the stable result set to a purchase review; nothing is paid", async () => {
  const list = await setOf((await turn(buyer, conv, "الأفضل مقابل السعر")).payload.resultSetId);
  const review = await turn(buyer, conv, "أبي الثاني");
  assert.equal(review.payload.surface, "PURCHASE_REVIEW");
  assert.equal(review.payload.purchaseReview.listingId, list.resourceIds[1]);
  assert.equal(review.payload.purchaseReview.quantity, 1);
  assert.equal(review.payload.purchaseReview.status, "PENDING");
  reviewId = review.payload.purchaseReview.actionId;
  const [cartBefore] = await db.select().from(carts).where(eq(carts.userId, buyer.id));
  assert.equal(cartBefore ? (await db.select().from(cartItems).where(eq(cartItems.cartId, cartBefore.id))).length : 0, 0, "no cart change before confirmation");
  const done = await turn(buyer, conv, "نعم");
  assert.equal(done.payload.surface, "CART");
  assert.match(done.body, /لم يُدفع أي شيء/);
  const [cart] = await db.select().from(carts).where(eq(carts.userId, buyer.id));
  assert.deepEqual((await db.select().from(cartItems).where(eq(cartItems.cartId, cart!.id))).map((item) => [item.offerId, item.quantity]), [[list.resourceIds[1], 1]]);
  await turn(buyer, conv, "الأفضل مقابل السعر");
  const two = await turn(buyer, conv, "أريد قطعتين من المنتج الأول");
  assert.equal(two.payload.purchaseReview.quantity, 2);
  assert.equal(two.payload.purchaseReview.total, "10.000");
  await turn(buyer, conv, "إلغاء");
});

await focused("F2-11", "invented ids and out-of-range positions are rejected", async () => {
  await turn(buyer, conv, "الأفضل مقابل السعر");
  const missing = await turn(buyer, conv, "أبي العاشر");
  assert.notEqual(missing.payload?.surface, "PURCHASE_REVIEW");
  assert.match(missing.body, /غير موجود/);
  const compare = await turn(buyer, conv, "قارن الأول والعاشر");
  assert.notEqual(compare.payload?.surface, "COMPARISON");
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const invented = await confirmPendingAction({ actionId: randomUUID(), actorId: buyer.id, market: await resolveMarket(row!), decision: "CONFIRM" }).catch((error) => error);
  assert.equal(invented.status, 404);
  const foreign = await confirmPendingAction({ actionId: reviewId, actorId: sellerA.id, market: await resolveMarket(row!), decision: "CONFIRM" }).catch((error) => error);
  assert.equal(foreign.status, 404);
  const cart = await request(`/ai/conversations/${conv}/actions/add-to-cart`, "POST", { resultSetId: randomUUID(), resourceId: T.blackL5 }, buyer.cookie);
  assert.equal(cart.status, 409);
});

await focused("F2-12", "reload restores constraints, reasons, comparison and review status", async () => {
  const history = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
  const blocks = history.data.messages.flatMap((message: any) => message.blocks);
  const ranked = blocks.filter((block: any) => block.type === "LISTING_RESULTS" && block.payload.listings.some((listing: any) => listing.recommendationReasons));
  assert.ok(ranked.length, "ranking reasons restored");
  const review = blocks.find((block: any) => block.payload.purchaseReview?.actionId === reviewId);
  assert.equal(review.payload.purchaseReview.status, "CONFIRMED");
  const rankHistory = await request(`/ai/conversations/${rankConv}`, "GET", undefined, buyer.cookie);
  assert.ok(rankHistory.data.messages.flatMap((message: any) => message.blocks).some((block: any) => block.payload.surface === "COMPARISON" && block.payload.comparison.rows.length));
  const latest = await setOf(narrowed.payload.resultSetId);
  assert.equal((latest.query as any).buyer.maxPrice, 7, "constraints live in the persisted result set");
});

await test("summary", async () => {
  const keys = Object.keys(results).sort();
  console.log("BLOCKF2_SUMMARY", JSON.stringify({ passed: keys.filter((id) => results[id] === "PASS").length, total: keys.length, results, modelCalls: getModelGatewayCallCount() }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
