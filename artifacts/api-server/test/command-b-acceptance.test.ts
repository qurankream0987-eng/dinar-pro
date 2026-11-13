/**
 * DINAR NEXT Command B — the owner's natural phrasings for selling, buying, negotiating and
 * ordering, sent as real HTTP turns through the one runtime on a disposable loopback database.
 * No model is configured: every path here must be served by the canonical deterministic
 * authorities. Deeper per-authority coverage lives in block-f1..f5, g2 (G2-21..38), block-d
 * and r5/W6 suites; this suite proves the phrasings and the end-to-end agreed-price flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, negotiations, offers, orders } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { surfaceIntent } from "../src/ai/intent";
import { calculatePlatformFeeMinor } from "../src/lib/market-pricing";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;
const PROBE = process.env.DINAR_CMD_B_PROBE === "1";

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.18.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
const phoneBase = 51_500_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `CmdB-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR B ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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

type Turn = { body: string; payload: any; surface?: string; blockType?: string };
async function say(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  const block = complete.assistantMessage.blocks?.[0];
  const payload = block?.payload ?? {};
  const surface = payload.surface ?? (payload.listings ? "LISTING_RESULTS" : undefined);
  const turn = { body: complete.assistantMessage.body as string, payload, surface, blockType: block?.type };
  if (PROBE) console.log("CMDB", JSON.stringify({ actor: actor.label, message, surface, blockType: turn.blockType, body: turn.body.slice(0, 220), draft: payload.draft ? { title: payload.draft.title, price: payload.draft.price ?? payload.draft.unitPrice, priceMode: payload.draft.pricingMode ?? payload.draft.priceMode, missing: payload.draft.missingFields, category: payload.draft.categoryId ?? payload.draft.category } : undefined }));
  return turn;
}

async function publish(actor: Actor, title: string, price: string, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
async function openListing(actor: Actor, conv: string, search: string, listingId: string) {
  const found = await say(actor, conv, `ابحث عن ${search}`);
  const ids = found.payload.resourceIds as string[];
  assert.ok(ids?.includes(listingId), `${search}: ${found.body}`);
  const opened = await say(actor, conv, ORDINALS[ids.indexOf(listingId)]!);
  assert.equal(opened.payload.resourceIds?.[0], listingId, opened.body);
  return opened;
}

let seller: Actor;
let buyer: Actor;
let stranger: Actor;
const L: Record<string, string> = {};
await test("setup: disposable loopback DB, fresh actors, one negotiable listing", async () => {
  [seller, buyer, stranger] = await Promise.all(["Seller", "Buyer", "Stranger"].map((label) => register(label)));
  L.table = await publish(seller, `طاولة خشب ${TOKEN}`, "25", { pricingMode: "NEGOTIABLE" });
});

const modelCallsBefore = getModelGatewayCallCount();
const draftOf = (turn: Turn) => turn.payload.draft as { title?: string; unitPrice?: string; price?: string; categoryId?: string; pricingMode?: string };
const sellerOffers = async () =>
  (await db.select({ id: offers.id, data: offers.data, unitPriceMinor: offers.unitPriceMinor, pricingMode: offers.pricingMode }).from(offers).where(eq(offers.sellerId, seller.id)));

await test("B2 seller phrasings open the canonical draft with the facts already given", async () => {
  const phone = await say(seller, await conversation(seller), "دينار بيع لي هاتفي المستعمل");
  assert.equal(phone.surface, "SELL", phone.body);
  assert.equal(draftOf(phone).title, "هاتفي المستعمل");
  const table = await say(seller, await conversation(seller), "دينار أريد أعرض طاولة بـ20");
  assert.equal(table.surface, "SELL", table.body);
  assert.deepEqual([draftOf(table).title, draftOf(table).unitPrice ?? draftOf(table).price], ["طاولة", "20"]);
  const service = await say(seller, await conversation(seller), "دينار عندي خدمة تنظيف");
  assert.equal(service.surface, "SELL", service.body);
  assert.deepEqual([draftOf(service).title, draftOf(service).categoryId], ["خدمة تنظيف", "services"]);
  assert.match(service.body, /كيف تريد التسعير/u, "the service category is known; pricing is the next missing fact");
  const machine = await say(seller, await conversation(seller), "دينار أبي أبيع ماكينة صناعية");
  assert.equal(draftOf(machine).title, "ماكينة صناعية");
  assert.match(machine.body, /أخرى/u, "the general category fallback is offered");
  // «روح بيع لي هذا» stays the paid «دينار — روح بِع لي» promotion product, not a new draft.
  assert.notEqual(surfaceIntent("دينار روح بيع لي هذا"), "SELL");
  assert.equal(surfaceIntent("بيع لي إعلاني"), undefined);
  assert.equal((await sellerOffers()).length, 1, "starting drafts publishes nothing");
});

await test("B2 no-price listing: offered options are understood, absent price is never «free», publication needs explicit confirmation", async () => {
  const conv = await conversation(seller);
  let view = await say(seller, conv, "أبي أبيع كنبة");
  const answers: [RegExp, string][] = [
    [/اختر تصنيف/u, "منزل"],
    [/صف العرض/u, "كنبة ثلاث مقاعد مستعملة بحالة نظيفة"],
    [/كيف تريد التسعير/u, "قدّم عرضك"],
    [/الكمية/u, "1"],
    [/المنطقة/u, "خلدا"],
    [/تواصل/u, "محادثة جاسم فقط"],
    [/دفع/u, "كاش"],
  ];
  const seen: string[] = [];
  for (let step = 0; step < 10 && !/راجع بيانات المسودة/u.test(view.body); step += 1) {
    const match = answers.find(([question]) => question.test(view.body));
    assert.ok(match, `unexpected draft question: ${view.body}`);
    assert.ok(!seen.includes(match[1]), `the draft asked again after «${match[1]}»: ${view.body}`);
    seen.push(match[1]);
    view = await say(seller, conv, match[1]);
  }
  assert.equal(draftOf(view).categoryId, "home", "«منزل» as offered is the Home category, not real estate");
  assert.equal(draftOf(view).pricingMode, "OPEN_TO_OFFERS");
  assert.equal(draftOf(view).unitPrice, undefined, "no price was invented");
  const confirm = await say(seller, conv, "انشره");
  assert.match(confirm.body, /بسعر بالاتفاق/u);
  assert.equal((await sellerOffers()).length, 1, "nothing is published before «نعم»");
  const published = await say(seller, conv, "نعم");
  assert.match(published.body, /تم نشر الإعلان «كنبة»/u);
  const sofa = (await sellerOffers()).find((row) => (row.data as { title?: string }).title === "كنبة");
  assert.ok(sofa);
  assert.deepEqual([sofa.pricingMode, sofa.unitPriceMinor], ["OPEN_TO_OFFERS", null]);
  const publicView = await request(`/listings/${sofa.id}`, "GET", undefined, buyer.cookie);
  assert.equal(publicView.status, 200, publicView.raw);
  assert.ok(!publicView.data.contactPhone, "public listings carry no private contact");
  const again = await say(seller, conv, "نعم");
  assert.doesNotMatch(again.body, /تم نشر/u);
  assert.equal((await sellerOffers()).filter((row) => (row.data as { title?: string }).title === "كنبة").length, 1, "a repeated «نعم» publishes nothing more");
  // «سعر قابل للتفاوض» then a bare amount keeps the chosen mode.
  const conv2 = await conversation(seller);
  view = await say(seller, conv2, "أبي أبيع مكتب خشب");
  if (/اختر تصنيف/u.test(view.body)) view = await say(seller, conv2, "منزل");
  if (/صف العرض/u.test(view.body)) view = await say(seller, conv2, "مكتب خشب متين بحالة ممتازة");
  assert.match(view.body, /كيف تريد التسعير/u);
  view = await say(seller, conv2, "سعر قابل للتفاوض");
  assert.match(view.body, /ما السعر المطلوب/u);
  view = await say(seller, conv2, "30");
  assert.deepEqual([draftOf(view).pricingMode, draftOf(view).unitPrice], ["NEGOTIABLE", "30"]);
  // «سعر ثابت» is the category default; choosing it explicitly must still move on to the amount.
  const conv3 = await conversation(seller);
  view = await say(seller, conv3, "أبي أبيع رف كتب");
  if (/اختر تصنيف/u.test(view.body)) view = await say(seller, conv3, "منزل");
  if (/صف العرض/u.test(view.body)) view = await say(seller, conv3, "رف كتب خشبي بخمسة أدراج بحالة جيدة");
  assert.match(view.body, /كيف تريد التسعير/u);
  view = await say(seller, conv3, "سعر ثابت");
  assert.match(view.body, /ما السعر المطلوب/u, "the pricing question is not asked again");
  view = await say(seller, conv3, "15");
  assert.deepEqual([draftOf(view).pricingMode, draftOf(view).unitPrice], ["FIXED", "15"]);
});

let negotiationConv = "";
let sellerConv = "";
await test("B4 best price, offer, counteroffers and acceptance use the owner's phrasings", async () => {
  negotiationConv = await conversation(buyer);
  await openListing(buyer, negotiationConv, `طاولة خشب ${TOKEN}`, L.table!);
  const best = await say(buyer, negotiationConv, "دينار اطلب آخر سعر");
  assert.equal(best.surface, "NEGOTIATION_REVIEW", best.body);
  assert.match(best.body, /أفضل سعر/u);
  await say(buyer, negotiationConv, "إلغاء");
  const offer = await say(buyer, negotiationConv, "اعرض عليه 20");
  assert.equal(offer.surface, "NEGOTIATION_REVIEW", offer.body);
  assert.deepEqual([offer.payload.negotiation.listedPrice, offer.payload.negotiation.offerAmount], ["25.000", "20.000"]);
  assert.equal((await db.select().from(negotiations).where(eq(negotiations.buyerId, buyer.id))).length, 0, "a review sends nothing");
  assert.equal((await say(buyer, negotiationConv, "إرسال العرض")).surface, "NEGOTIATION_STATUS");
  sellerConv = await conversation(seller);
  assert.equal((await say(seller, sellerConv, "هل عندي عروض؟")).surface, "NEGOTIATION_LIST");
  const aboveList = await say(seller, sellerConv, "قله 26");
  assert.equal(aboveList.surface, "NEGOTIATION_REVIEW");
  const refused = (await say(seller, sellerConv, "نعم")).body;
  assert.match(refused, /أعلى من السعر المعلن/u, "a counter above the listed price is refused, not sent");
  assert.doesNotMatch(refused, /يمكنك الشراء بالسعر المعلن/u, "no direct purchase is promised: NEGOTIABLE needs an agreement");
  await say(seller, sellerConv, "هل عندي عروض؟");
  await say(seller, sellerConv, "قله 24");
  assert.equal((await say(seller, sellerConv, "نعم")).surface, "NEGOTIATION_STATUS");
  const seen = await say(buyer, negotiationConv, "وش صار على عرضي؟");
  assert.match(seen.body, /البائع عرض 24\.000/u);
  const counter = await say(buyer, negotiationConv, "هو طلب 24، قل له 22");
  assert.equal(counter.surface, "NEGOTIATION_REVIEW", counter.body);
  assert.match(counter.body, /22\.000/u);
  await say(buyer, negotiationConv, "نعم");
  await say(seller, sellerConv, "هل عندي عروض؟");
  assert.match((await say(seller, sellerConv, "موافق")).body, /قبول عرض 22\.000/u);
  await say(seller, sellerConv, "نعم");
  const [row] = await db.select().from(negotiations).where(and(eq(negotiations.buyerId, buyer.id), eq(negotiations.listingId, L.table!)));
  assert.deepEqual([row!.status, row!.agreedAmountMinor], ["ACCEPTED", 22_000]);
  const [listing] = await db.select({ unitPriceMinor: offers.unitPriceMinor }).from(offers).where(eq(offers.id, L.table!));
  assert.equal(listing!.unitPriceMinor, 25_000, "the public listing price is unchanged");
});

await test("B5 the agreed price flows into the canonical order; confirmation is explicit and idempotent", async () => {
  await say(buyer, negotiationConv, "وش صار على عرضي؟");
  const review = await say(buyer, negotiationConv, "اطلبه");
  assert.equal(review.surface, "PURCHASE_REVIEW", review.body);
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, buyer.id))).length, 0, "a review creates no order");
  const placed = await say(buyer, negotiationConv, "نعم");
  assert.match(placed.body, /تم إنشاء الطلب/u);
  assert.match(placed.body, /لم يُدفع أي شيء/u, "no payment is claimed");
  await say(buyer, negotiationConv, "نعم");
  await say(buyer, negotiationConv, "اطلبه");
  await say(buyer, negotiationConv, "نعم");
  const placedOrders = await db.select().from(orders).where(eq(orders.buyerId, buyer.id));
  assert.equal(placedOrders.length, 1, "repeated confirmations create one order");
  const order = placedOrders[0]!;
  assert.deepEqual([order.sellerId, order.unitPriceMinor, order.subtotalMinor], [seller.id, 22_000, 22_000]);
  assert.equal(order.platformFeeMinor, calculatePlatformFeeMinor(22_000), "the approved commission rule is unchanged");
});

await test("B5 a negotiable listing without an agreement: the order review refuses honestly, as checkout does", async () => {
  const direct = await register("Direct");
  const conv = await conversation(direct);
  const found = await say(direct, conv, `ابحث عن طاولة خشب ${TOKEN}`);
  const ids = found.payload.resourceIds as string[];
  assert.ok(ids?.includes(L.table!), found.body);
  const chosen = await say(direct, conv, `أبي ${ORDINALS[ids.indexOf(L.table!)]}`);
  assert.notEqual(chosen.surface, "PURCHASE_REVIEW", "no cart review is offered that the cart and checkout would refuse");
  assert.match(chosen.body, /قابل للتفاوض؛ اتفق مع البائع على السعر أولًا/u, chosen.body);
  const review = await say(direct, conv, "اطلبه الآن");
  assert.notEqual(review.surface, "PURCHASE_REVIEW", "no order review is offered that checkout would refuse");
  assert.doesNotMatch(review.body, /تغير المخزون/u);
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, direct.id))).length, 0);
  const forced = await request("/orders", "POST", { listingId: L.table, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `cmdb-${randomUUID()}` }, direct.cookie);
  assert.equal(forced.status, 409, forced.raw);
  assert.match(forced.data?.error ?? forced.raw, /يحتاج هذا العرض إلى الاتفاق على السعر/u, "the refusal names the real reason");
});

await test("B6 negotiable listing: the cart holds it only at an agreed price; agreeing at the listed price is possible", async () => {
  const cartBuyer = await register("Cart");
  const putCart = (quantity: number) => request("/cart", "PUT", { marketId: "JO", items: [{ listingId: L.table, quantity }] }, cartBuyer.cookie);
  const unagreed = await putCart(1);
  assert.equal(unagreed.status, 409, unagreed.raw);
  assert.match(unagreed.data?.error ?? unagreed.raw, /اتفق مع البائع على السعر قبل إضافته إلى السلة/u);
  const conv = await conversation(cartBuyer);
  const found = await say(cartBuyer, conv, `ابحث عن طاولة خشب ${TOKEN}`);
  const ids = found.payload.resourceIds as string[];
  const added = await say(cartBuyer, conv, `أضف ${ORDINALS[ids.indexOf(L.table!)]} إلى السلة`);
  assert.notEqual(added.surface, "PURCHASE_REVIEW", "no cart review is offered for an unagreed negotiable price");
  assert.match(added.body, /قابل للتفاوض/u, added.body);
  assert.deepEqual((await request("/cart", "GET", undefined, cartBuyer.cookie)).data, [], "nothing entered the cart");

  await openListing(cartBuyer, conv, `طاولة خشب ${TOKEN}`, L.table!);
  const atList = await say(cartBuyer, conv, "اعرض عليه 25");
  assert.equal(atList.surface, "NEGOTIATION_REVIEW", atList.body);
  assert.equal(atList.payload.negotiation.offerAmount, "25.000");
  assert.equal((await say(cartBuyer, conv, "إرسال العرض")).surface, "NEGOTIATION_STATUS", "an offer at the listed price is sent");
  const above = await say(cartBuyer, conv, "اعرض عليه 30");
  assert.match(above.body, /أعلى من السعر المعلن/u, "an offer above the listed price is refused");
  const sellerTurns = await conversation(seller);
  await say(seller, sellerTurns, "هل عندي عروض؟");
  assert.match((await say(seller, sellerTurns, "موافق")).body, /قبول عرض 25\.000/u);
  await say(seller, sellerTurns, "نعم");
  const [agreement] = await db.select().from(negotiations).where(and(eq(negotiations.buyerId, cartBuyer.id), eq(negotiations.listingId, L.table!)));
  assert.deepEqual([agreement!.status, agreement!.agreedAmountMinor, agreement!.quantity], ["ACCEPTED", 25_000, 1]);

  assert.equal((await putCart(1)).status, 200, "with an agreement the cart accepts the line");
  const [line] = (await request("/cart", "GET", undefined, cartBuyer.cookie)).data;
  assert.deepEqual([line.agreedPrice, line.unitPrice, line.listedUnitPrice, line.availableQuantity], [true, "25.000", "25.000", 1]);
  const tooMany = await putCart(2);
  assert.equal(tooMany.status, 409, tooMany.raw);
  assert.match(tooMany.data?.error ?? tooMany.raw, /السعر المتفق عليه يشمل 1 فقط/u);
  const checkedOut = await request("/checkout", "POST", { items: [{ listingId: L.table, quantity: 1, fulfilmentType: "PICKUP" }], idempotencyKey: `cmdb-${randomUUID()}` }, cartBuyer.cookie);
  assert.equal(checkedOut.status, 201, checkedOut.raw);
  const [order] = await db.select().from(orders).where(eq(orders.buyerId, cartBuyer.id));
  assert.deepEqual([order!.unitPriceMinor, order!.platformFeeMinor], [25_000, calculatePlatformFeeMinor(25_000)]);
  const [consumed] = await db.select().from(negotiations).where(eq(negotiations.id, agreement!.id));
  assert.equal(consumed!.orderId, order!.id, "the agreement is consumed by exactly this order");
  assert.deepEqual((await request("/cart", "GET", undefined, cartBuyer.cookie)).data, [], "checkout cleared the ordered line");
  const again = await putCart(1);
  assert.equal(again.status, 409, "a consumed agreement cannot be reused through the cart");
});

await test("B7/B8 wrong actor and wrong market reach nothing", async () => {
  const conv = await conversation(stranger);
  const offersSeen = await say(stranger, conv, "هل عندي عروض؟");
  assert.doesNotMatch(offersSeen.body, new RegExp(TOKEN, "u"), "another user's negotiation is invisible");
  const order = await say(stranger, conv, "اطلبه");
  assert.notEqual(order.surface, "PURCHASE_REVIEW");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, stranger.id))).length, 0);
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, stranger.cookie)).status, 200);
  const kwConv = await conversation(stranger);
  const found = await say(stranger, kwConv, `ابحث عن طاولة خشب ${TOKEN}`);
  assert.ok(!(found.payload.resourceIds ?? []).includes(L.table), "a JO listing never appears in the KW market");
});

test("B: every path above was deterministic (no model call)", () => {
  assert.equal(getModelGatewayCallCount(), modelCallsBefore);
});

await new Promise((resolve) => setTimeout(resolve, 10));
server.close();
