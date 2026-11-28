/**
 * Payment Preferences & Agreement acceptance. Real API, real conversation runtime, a disposable
 * loopback database. No payment provider, no network, no money: the system under test only
 * records how buyer and seller agreed to settle and what each of them said.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { aiUiBlocks, db, dealPaymentAgreements, dealPaymentCatalogChanges, dealPaymentEvents, markets, offers, orders, paymentIntents, pool, users } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
delete process.env.DINAR_DEAL_PAYMENTS;

const { default: app } = await import("../src/app");
const { COUNTRY_SEED, offerableMethods, resolveCountry, methodsInText } = await import("../src/lib/deal-payments/catalog");
const { selectDeliveryMethod, attachTransactionLocation, transitionDelivery } = await import("../src/lib/delivery");
const { resolveMarket } = await import("../src/lib/markets");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
after(async () => {
  server.close();
  await pool.end();
});
let ip = Math.floor(Math.random() * 20_000);
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.47.${(ip >> 8) & 255}.${ip++ & 255}` },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw, cache: response.headers.get("cache-control") ?? "", cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_300_000 + ((Date.now() + process.pid + 71) % 150_000);
let offset = 0;
type Actor = { id: string; cookie: string; name: string };
async function register(name: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Deal-${randomUUID().slice(0, 10)}!`;
  const registered = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id as string, cookie: registered.cookie, name };
}

await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
const seller = await register("متجر أحمد");
const buyer = await register("مشتري الصفقة");
const stranger = await register("شخص غريب");
const admin = await register("مسؤول الدفع");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));

async function listing(title: string, fulfilmentType: "PICKUP" | "DELIVERY", owner = seller) {
  const created = await request("/listings", "POST", {
    title: `${title} ${randomUUID().slice(0, 4)}`, description: "منتج للاختبار فقط لا يباع", category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: "50.000", inventoryMode: "LIMITED", availableQuantity: 20, fulfilmentType, imageUrl: "", imageUrls: [],
  }, owner.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
async function order(listingId: string, fulfilmentType: "PICKUP" | "DELIVERY", who = buyer) {
  const created = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType, idempotencyKey: `deal-${randomUUID()}` }, who.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
const card = (orderId: string, who: Actor) => request(`/orders/${orderId}/deal-card`, "GET", undefined, who.cookie);
const act = (orderId: string, who: Actor, action: Record<string, unknown>, expectedVersion?: number) =>
  request(`/orders/${orderId}/deal-card/actions`, "POST", { action, ...(expectedVersion ? { expectedVersion } : {}) }, who.cookie);
const setMethods = (who: Actor, methods: unknown[], replace = true) => request("/deal-payments/seller-methods", "PUT", { methods, replace }, who.cookie);

const pickupListing = await listing("سماعة لاسلكية", "PICKUP");
const deliveryListing = await listing("سماعة توصيل", "DELIVERY");

test("DP-01 countries: 22 Arab countries, each with its own currency and only sourced methods offered", async () => {
  assert.equal(COUNTRY_SEED.length, 22);
  assert.equal(new Set(COUNTRY_SEED.map((c) => c.countryCode)).size, 22);
  const res = await request("/deal-payments/countries");
  assert.equal(res.status, 200, res.raw);
  const byCode = new Map(res.data.countries.map((c: any) => [c.countryCode, c]));
  assert.equal(byCode.size, 22);
  assert.equal((byCode.get("JO") as any).currencyCode, "JOD");
  assert.equal((byCode.get("EG") as any).currencyCode, "EGP");
  assert.equal((byCode.get("SA") as any).currencyCode, "SAR");
  for (const c of res.data.countries)
    for (const m of c.methods) if (m.status === "ACTIVE") assert.ok(m.source, `${c.countryCode}/${m.code} is ACTIVE without a source`);
  const eg = await resolveCountry("EG");
  assert.ok(!offerableMethods(eg, "EGP").some((m) => m.code === "INSTAPAY"), "a named local scheme is not offered until verified");
  assert.ok(offerableMethods(await resolveCountry("JO"), "JOD").some((m) => m.code === "CLIQ"));
  assert.ok(!offerableMethods(await resolveCountry("SY"), "SYP").some((m) => m.code === "BANK_TRANSFER"), "disrupted banking stays under review");
  assert.deepEqual(offerableMethods(await resolveCountry("JO"), "EGP"), [], "a method is only offered in the country's currency");
  assert.equal(methodsInText("أقبل كليك أو تحويل بنكي", ["CLIQ", "BANK_TRANSFER"]).codes.sort().join(), "BANK_TRANSFER,CLIQ");
  assert.equal(methodsInText("كاش", ["COD", "CASH_IN_PERSON"]).ambiguousCash, true, "bare «كاش» with both options asks instead of guessing");
});

test("DP-02 seller preferences: one method, several methods, no invented or unavailable method, no secrets stored", async () => {
  const one = await setMethods(seller, [{ code: "CLIQ" }]);
  assert.equal(one.status, 200, one.raw);
  assert.deepEqual(one.data.accepted.filter((m: any) => !m.paused).map((m: any) => m.code), ["CLIQ"]);
  assert.equal((await setMethods(seller, [{ code: "INSTAPAY" }])).status, 409, "InstaPay is not a Jordan method");
  assert.equal((await setMethods(seller, [{ code: "MADE_UP" }])).status, 409);
  assert.equal((await setMethods(seller, [{ code: "CLIQ", instructions: { alias: "4111 1111 1111 1111" } }])).data.code, "CARD_NUMBER_REFUSED");
  assert.equal((await setMethods(seller, [{ code: "CLIQ", instructions: { note: "أرسل لي رمز التحقق OTP" } }])).data.code, "SECRET_REFUSED");
  assert.equal((await setMethods(seller, [{ code: "CLIQ", instructions: { iban: "x" } }])).data.code, "INSTRUCTION_FIELD_NOT_ALLOWED", "only the method's own fields");
  assert.equal((await setMethods(seller, [{ code: "OTHER_AGREED" }])).data.code, "CUSTOM_LABEL_REQUIRED");
  const many = await setMethods(seller, [
    { code: "CLIQ", instructions: { beneficiaryName: "أحمد", alias: "AHMAD.SHOP" } },
    { code: "COD" },
    { code: "BANK_TRANSFER", instructions: { beneficiaryName: "أحمد", iban: "JO71CBJO0000000000001234567890" } },
  ]);
  assert.equal(many.status, 200, many.raw);
  assert.deepEqual(many.data.accepted.filter((m: any) => !m.paused).map((m: any) => m.code).sort(), ["BANK_TRANSFER", "CLIQ", "COD"]);
  assert.match(many.cache, /no-store/);
  assert.equal((await request("/deal-payments/seller-methods", "GET")).status, 401);
  assert.equal((await setMethods(seller, [{ code: "CLIQ" }], false)).status, 200, "a partial update keeps the instructions");
  const kept = await request("/deal-payments/seller-methods", "GET", undefined, seller.cookie);
  assert.equal(kept.data.accepted.find((m: any) => m.code === "CLIQ").instructions.alias, "AHMAD.SHOP");
});

let direct = "";
test("DP-03 direct payment: buyer picks an accepted method; instructions only after agreement and the seller's consent; no verification claimed", async () => {
  direct = await order(pickupListing, "PICKUP");
  const first = await card(direct, buyer);
  assert.equal(first.status, 200, first.raw);
  assert.match(first.cache, /no-store/);
  assert.equal(first.data.status, "WAITING_FOR_BUYER");
  assert.deepEqual(first.data.acceptedMethods.map((m: any) => m.code).sort(), ["BANK_TRANSFER", "CLIQ", "COD"]);
  assert.equal(first.data.acceptedMethods.find((m: any) => m.code === "COD").available, false, "COD needs delivery");
  assert.equal(first.data.instructions, null);
  assert.ok(!first.raw.includes("AHMAD.SHOP"), "no instructions before agreement");
  assert.equal(first.data.currency, "JOD");
  assert.equal(first.data.buyerName, null, "the buyer's name is not echoed to the buyer card");
  assert.equal((await card(direct, seller)).data.buyerName, buyer.name, "the seller sees the buyer");

  // Strangers: 404 on read and write.
  assert.equal((await card(direct, stranger)).status, 404);
  assert.equal((await act(direct, stranger, { type: "CHOOSE", method: "CLIQ" })).status, 404);
  assert.equal((await request(`/orders/${direct}/deal-card`)).status, 401);

  const cod = await act(direct, buyer, { type: "CHOOSE", method: "COD" });
  assert.deepEqual([cod.status, cod.data.code], [409, "COD_UNAVAILABLE"], "no COD on a pickup order");

  const chosen = await act(direct, buyer, { type: "CHOOSE", method: "CLIQ" });
  assert.equal(chosen.status, 200, chosen.raw);
  assert.equal(chosen.data.card.status, "AWAITING_PAYMENT");
  assert.equal(chosen.data.card.agreedMethod.code, "CLIQ");
  assert.deepEqual(chosen.data.card.approvals, { seller: true, buyer: true });
  assert.equal(chosen.data.card.instructions, null, "ON_REQUEST: the seller has not shared yet");
  assert.equal(chosen.data.card.instructionsState, "NOT_SHARED_YET");
  assert.equal((await act(direct, buyer, { type: "SHARE_INSTRUCTIONS" })).status, 403, "only the seller shares");

  const shared = await act(direct, seller, { type: "SHARE_INSTRUCTIONS" });
  assert.equal(shared.status, 200, shared.raw);
  const forBuyer = await card(direct, buyer);
  assert.deepEqual(forBuyer.data.instructions, { beneficiaryName: "أحمد", alias: "AHMAD.SHOP" }, "only the agreed method's instructions");
  assert.ok(!forBuyer.raw.includes("JO71CBJO"), "the bank details of another method are never shown");
  assert.equal(forBuyer.data.payment.platformVerified, false);
  assert.match(forBuyer.data.notice, /لا يستلم جاسم الأموال/);

  // The seller cannot report the buyer's payment; the buyer's report is only a claim.
  assert.equal((await act(direct, seller, { type: "REPORT_PAID" })).status, 403);
  assert.equal((await act(direct, buyer, { type: "CONFIRM_RECEIPT" })).status, 403, "the buyer cannot confirm receipt");
  const paid = await act(direct, buyer, { type: "REPORT_PAID", note: "حولت عبر كليك" });
  assert.equal(paid.data.card.status, "BUYER_REPORTED_PAID");
  assert.equal(paid.data.card.payment.verification, "UNVERIFIED_BUYER_CLAIM");
  assert.ok(!/تم التحقق|مؤكد/.test(paid.data.card.statusLabel.replace("غير مؤكد", "")), "never shown as verified");
  assert.equal((await act(direct, buyer, { type: "CHOOSE", method: "BANK_TRANSFER" })).data.code, "PAYMENT_ALREADY_REPORTED");
  const received = await act(direct, seller, { type: "CONFIRM_RECEIPT" });
  assert.equal(received.data.card.status, "SELLER_CONFIRMED_RECEIPT");
  assert.equal(received.data.card.payment.verification, "SELLER_ATTESTED");
  assert.equal(received.data.card.payment.platformVerified, false);
  assert.equal((await act(direct, buyer, { type: "CANCEL" })).data.code, "ALREADY_SETTLED");

  // Nothing financial exists for this order: no payment intent, the order itself is untouched.
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, direct))).length, 0);
  const [orderRow] = await db.select().from(orders).where(eq(orders.id, direct));
  assert.equal(orderRow!.status, "CREATED", "agreement never changes order status");
  const events = await db.select().from(dealPaymentEvents).where(eq(dealPaymentEvents.orderId, direct));
  assert.deepEqual(events.map((e) => e.event), ["CREATED", "METHOD_CONFIRMED", "INSTRUCTIONS_SHARED", "BUYER_REPORTED_PAID", "SELLER_CONFIRMED_RECEIPT"]);
  assert.deepEqual(events.map((e) => e.actorRole), ["SYSTEM", "BUYER", "SELLER", "BUYER", "SELLER"]);
});

test("DP-04 a method the seller did not accept is a proposal; the seller decides; changing it re-asks", async () => {
  const id = await order(pickupListing, "PICKUP");
  const proposed = await act(id, buyer, { type: "CHOOSE", method: "CASH_IN_PERSON" });
  assert.equal(proposed.status, 200, proposed.raw);
  assert.equal(proposed.data.card.status, "PAYMENT_METHOD_PROPOSED");
  assert.equal(proposed.data.card.agreedMethod, null, "not agreed by the buyer alone");
  assert.deepEqual(proposed.data.card.approvals, { seller: false, buyer: true });
  assert.equal((await act(id, buyer, { type: "RESPOND", accept: true })).data.code, "OWN_PROPOSAL");
  assert.equal((await act(id, buyer, { type: "REPORT_PAID" })).data.code, "NOT_AWAITING_PAYMENT");

  // The buyer changes the proposal before the seller answers (scenario 5).
  const other = await act(id, buyer, { type: "CHOOSE", method: "OTHER_AGREED", customLabel: "زين كاش" });
  assert.equal(other.data.card.proposal.label, "زين كاش");
  assert.equal(other.data.card.proposal.awaiting, "SELLER");
  // The seller rejects (scenario 6): nothing is agreed, the buyer can choose again.
  const rejected = await act(id, seller, { type: "RESPOND", accept: false });
  assert.equal(rejected.data.card.status, "WAITING_FOR_BUYER");
  assert.equal(rejected.data.card.agreedMethod, null);
  // A new proposal, accepted by the seller.
  await act(id, buyer, { type: "CHOOSE", method: "CASH_IN_PERSON" });
  const accepted = await act(id, seller, { type: "RESPOND", accept: true });
  assert.equal(accepted.data.card.status, "AWAITING_PAYMENT");
  assert.equal(accepted.data.card.agreedMethod.code, "CASH_IN_PERSON");
  assert.equal(accepted.data.card.instructionsState, "NOT_APPLICABLE");
});

test("DP-05 changing an agreed method needs the other party; a rejected change keeps the earlier agreement", async () => {
  const id = await order(pickupListing, "PICKUP");
  await act(id, buyer, { type: "CHOOSE", method: "CLIQ" });
  await act(id, seller, { type: "SHARE_INSTRUCTIONS" });
  assert.ok((await card(id, buyer)).data.instructions);
  const change = await act(id, buyer, { type: "CHOOSE", method: "BANK_TRANSFER" });
  assert.equal(change.data.card.status, "PAYMENT_METHOD_PROPOSED", "even an accepted method needs re-approval after agreement");
  assert.equal(change.data.card.agreedMethod, null);
  assert.equal((await card(id, buyer)).data.instructions, null, "instructions from the old agreement disappear");
  const kept = await act(id, seller, { type: "RESPOND", accept: false });
  assert.equal(kept.data.card.status, "AWAITING_PAYMENT");
  assert.equal(kept.data.card.agreedMethod.code, "CLIQ", "rejected change: earlier agreement stays");
  // The seller proposes a change; the buyer must approve it.
  const sellerChange = await act(id, seller, { type: "CHOOSE", method: "BANK_TRANSFER" });
  assert.equal(sellerChange.data.card.proposal.awaiting, "BUYER");
  assert.equal((await act(id, seller, { type: "RESPOND", accept: true })).data.code, "OWN_PROPOSAL");
  const approved = await act(id, buyer, { type: "RESPOND", accept: true });
  assert.equal(approved.data.card.agreedMethod.code, "BANK_TRANSFER");
});

test("DP-06 cash on delivery: needs delivery and a covered area; delivery is not collection; only the seller confirms collection", async () => {
  // Restrict COD to one area.
  await setMethods(seller, [{ code: "COD", codAreas: ["خلدا"] }], false);
  const id = await order(deliveryListing, "DELIVERY");
  let view = await card(id, buyer);
  assert.equal(view.data.acceptedMethods.find((m: any) => m.code === "COD").available, false, "no delivery chosen yet");
  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyer.id, orderId: id, method: "SELLER_DELIVERY", market: JO }, tx));
  view = await card(id, buyer);
  assert.match(view.data.acceptedMethods.find((m: any) => m.code === "COD").reason, /موقع التسليم/);
  await db.transaction((tx) => attachTransactionLocation({ actorId: buyer.id, orderId: id, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", city: "عمان", area: "الجبيهة", addressText: "شارع الجامعة" }, market: JO }, tx));
  const outside = await act(id, buyer, { type: "CHOOSE", method: "COD" });
  assert.deepEqual([outside.status, outside.data.code], [409, "COD_UNAVAILABLE"], "area not covered by the seller's COD");
  await setMethods(seller, [{ code: "COD", codAreas: ["خلدا", "الجبيهة"] }], false);
  const cod = await act(id, buyer, { type: "CHOOSE", method: "COD" });
  assert.equal(cod.status, 200, cod.raw);
  assert.equal(cod.data.card.status, "COD_PENDING_DELIVERY");
  assert.deepEqual(cod.data.card.cod, { amountDue: "50.000", currency: "JOD", collected: false });
  assert.equal((await act(id, buyer, { type: "REPORT_PAID" })).data.code, "COD_PAYS_ON_DELIVERY");
  assert.equal((await act(id, buyer, { type: "COD_COLLECTED" })).status, 403, "the buyer cannot record collection");
  assert.equal((await act(id, seller, { type: "CONFIRM_RECEIPT" })).status, 409, "COD uses its own collection action");

  // The seller accepts the order and marks it out for delivery: still not collected.
  assert.equal((await request(`/orders/${id}/accept`, "POST", {}, seller.cookie)).status, 200);
  await db.transaction((tx) => transitionDelivery({ actorId: seller.id, orderId: id, target: "ACCEPTED", market: JO } as any, tx)).catch(() => undefined);
  view = await card(id, seller);
  assert.equal(view.data.status, "COD_PENDING_DELIVERY", "delivery progress never marks cash collected");
  const collected = await act(id, seller, { type: "COD_COLLECTED" });
  assert.equal(collected.data.card.status, "COD_COLLECTED");
  assert.equal(collected.data.card.cod.collected, true);
  const [event] = await db.select().from(dealPaymentEvents).where(and(eq(dealPaymentEvents.orderId, id), eq(dealPaymentEvents.event, "COD_COLLECTED")));
  assert.deepEqual([event!.actorId, event!.actorRole, (event!.detail as any).verification], [seller.id, "SELLER", "SELLER_ATTESTED"]);
});

test("DP-07 a method the country does not offer is refused even if proposed; currencies follow the country", async () => {
  const id = await order(pickupListing, "PICKUP");
  const refused = await act(id, buyer, { type: "CHOOSE", method: "INSTAPAY" });
  assert.deepEqual([refused.status, refused.data.code], [409, "METHOD_NOT_AVAILABLE_IN_COUNTRY"]);
  assert.equal((await act(id, buyer, { type: "CHOOSE", method: "NOPE" })).data.code, "UNKNOWN_METHOD");
  for (const [code, currency] of [["KW", "KWD"], ["EG", "EGP"], ["MA", "MAD"], ["IQ", "IQD"], ["SO", "SOS"]] as const) {
    const c = await resolveCountry(code);
    assert.equal(c!.currencyCode, currency);
    assert.ok(offerableMethods(c, currency).some((m) => m.code === "COD"), `${code}: cash on delivery offered`);
    assert.deepEqual(offerableMethods(c, "JOD"), [], `${code}: no JOD methods`);
  }
});

test("DP-08 multi-item orders: the accepted methods are the intersection of every item's restriction", async () => {
  const a = await listing("قطعة أ", "PICKUP");
  const b = await listing("قطعة ب", "PICKUP");
  const [rowB] = await db.select().from(offers).where(eq(offers.id, b));
  await db.update(offers).set({ data: { ...(rowB!.data as object), dealPaymentMethods: ["CLIQ"] } }).where(eq(offers.id, b));
  const checkout = await request("/checkout", "POST", { items: [{ listingId: a, quantity: 1, fulfilmentType: "PICKUP" }, { listingId: b, quantity: 2, fulfilmentType: "PICKUP" }], idempotencyKey: `deal-multi-${randomUUID()}` }, buyer.cookie);
  assert.equal(checkout.status, 201, checkout.raw);
  const orderId = checkout.data.orders[0].id as string;
  const view = await card(orderId, buyer);
  assert.equal(view.data.items.length, 2);
  assert.deepEqual(view.data.acceptedMethods.map((m: any) => m.code), ["CLIQ"]);
  assert.equal((await act(orderId, buyer, { type: "CHOOSE", method: "BANK_TRANSFER" })).data.card.status, "PAYMENT_METHOD_PROPOSED", "outside the intersection it is only a proposal");
});

test("DP-09 cancellation: either party cancels the agreement; a cancelled order hides instructions and refuses changes", async () => {
  const id = await order(pickupListing, "PICKUP");
  await act(id, buyer, { type: "CHOOSE", method: "CLIQ" });
  await act(id, seller, { type: "SHARE_INSTRUCTIONS" });
  const cancelled = await act(id, buyer, { type: "CANCEL", reason: "غيرت رأيي" });
  assert.equal(cancelled.data.card.status, "CANCELLED");
  assert.equal(cancelled.data.card.instructions, null);
  assert.deepEqual(cancelled.data.card.actions, []);
  assert.equal((await act(id, seller, { type: "CHOOSE", method: "CLIQ" })).data.code, "AGREEMENT_CANCELLED");

  const other = await order(pickupListing, "PICKUP");
  await act(other, buyer, { type: "CHOOSE", method: "CLIQ" });
  await act(other, seller, { type: "SHARE_INSTRUCTIONS" });
  assert.equal((await request(`/orders/${other}/cancel`, "POST", { reason: "لم أعد أحتاجه" }, buyer.cookie)).status, 200);
  const closed = await card(other, buyer);
  assert.equal(closed.data.status, "CANCELLED");
  assert.equal(closed.data.instructions, null, "a cancelled order never shows payment details");
  assert.equal((await act(other, buyer, { type: "REPORT_PAID" })).data.code, "ORDER_CLOSED");
});

test("DP-10 concurrency and stale cards: one version wins, a stale card is refused, a double click is not recorded twice", async () => {
  const id = await order(pickupListing, "PICKUP");
  const v = (await card(id, buyer)).data.version as number;
  const results = await Promise.all([act(id, buyer, { type: "CHOOSE", method: "CLIQ" }, v), act(id, buyer, { type: "CHOOSE", method: "CLIQ" }, v)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await db.select().from(dealPaymentEvents).where(and(eq(dealPaymentEvents.orderId, id), eq(dealPaymentEvents.event, "METHOD_CONFIRMED")))).length, 1);
  assert.equal((await act(id, buyer, { type: "REPORT_PAID" }, v)).data.code, "AGREEMENT_CHANGED");
  assert.equal((await db.select().from(dealPaymentAgreements).where(eq(dealPaymentAgreements.orderId, id))).length, 1, "one agreement per order");
  assert.equal((await request(`/orders/${id}/deal-card/actions`, "POST", { action: { type: "REPORT_PAID", verified: true } }, buyer.cookie)).status, 400, "strict body: no client-claimed verification");
});

test("DP-11 admin: catalog changes need a reason, ACTIVE needs a source, history is append-only; status fixes are audited", async () => {
  const body = { countryCode: "EG", methodCode: "INSTAPAY", status: "ACTIVE", reason: "تحقق من الموقع الرسمي" };
  assert.equal((await request("/admin/deal-payments/catalog-changes", "POST", body, seller.cookie)).status, 403);
  assert.equal((await request("/admin/deal-payments/catalog-changes", "POST", body, admin.cookie)).data.code, "SOURCE_REQUIRED");
  const ok = await request("/admin/deal-payments/catalog-changes", "POST", { ...body, sourceReference: "Central Bank of Egypt — InstaPay (test reference)" }, admin.cookie);
  assert.equal(ok.status, 201, ok.raw);
  assert.ok(offerableMethods(await resolveCountry("EG"), "EGP").some((m) => m.code === "INSTAPAY"), "active without a deploy");
  const paused = await request("/admin/deal-payments/catalog-changes", "POST", { countryCode: "EG", methodCode: null, status: "UNAVAILABLE", reason: "إيقاف مؤقت للاختبار" }, admin.cookie);
  assert.equal(paused.status, 201, paused.raw);
  assert.deepEqual(offerableMethods(await resolveCountry("EG"), "EGP"), [], "an unavailable country offers nothing");
  assert.ok(offerableMethods(await resolveCountry("JO"), "JOD").length > 0, "other countries are unaffected");
  await request("/admin/deal-payments/catalog-changes", "POST", { countryCode: "EG", methodCode: null, status: "LIMITED", reason: "إعادة" }, admin.cookie);
  assert.equal((await request("/admin/deal-payments/catalog-changes", "POST", { countryCode: "EG", methodCode: "NEW_WALLET", status: "LIMITED", reason: "x y z" }, admin.cookie)).data.code, "NEW_METHOD_NEEDS_DEFINITION");
  await assert.rejects(db.execute(sql`UPDATE deal_payment_catalog_changes SET reason = 'edited'`), (e: any) => /append-only/.test(String(e?.cause?.message ?? e?.message)));
  await assert.rejects(db.insert(dealPaymentCatalogChanges).values({ id: randomUUID(), countryCode: "EG", methodCode: "X", status: "ACTIVE", reason: "r", actorId: admin.id }), "DB refuses ACTIVE without a source");

  const id = await order(pickupListing, "PICKUP");
  await card(id, buyer);
  assert.equal((await request(`/admin/deal-payments/orders/${id}/status`, "POST", { status: "DISPUTED" }, admin.cookie)).status, 400, "reason required");
  assert.equal((await request(`/admin/deal-payments/orders/${id}/status`, "POST", { status: "DISPUTED", reason: "بلاغ" }, seller.cookie)).status, 403);
  const fixed = await request(`/admin/deal-payments/orders/${id}/status`, "POST", { status: "CANCELLED", reason: "طلب الطرفين" }, admin.cookie);
  assert.equal(fixed.status, 200, fixed.raw);
  const [audit] = await db.select().from(dealPaymentEvents).where(and(eq(dealPaymentEvents.orderId, id), eq(dealPaymentEvents.event, "ADMIN_STATUS_SET")));
  assert.deepEqual([audit!.actorId, audit!.actorRole, (audit!.detail as any).reason], [admin.id, "ADMIN", "طلب الطرفين"]);
  await assert.rejects(db.execute(sql`DELETE FROM deal_payment_events WHERE order_id = ${id}`), (e: any) => /append-only/.test(String(e?.cause?.message ?? e?.message)));
});

test("DP-12 seller non-payment report: buyer claim → seller says not received → DISPUTED; nothing is decided for them", async () => {
  const id = await order(pickupListing, "PICKUP");
  await act(id, buyer, { type: "CHOOSE", method: "BANK_TRANSFER" });
  assert.equal((await act(id, seller, { type: "REPORT_NOT_RECEIVED" })).data.code, "NOTHING_REPORTED");
  await act(id, buyer, { type: "REPORT_PAID" });
  const disputed = await act(id, seller, { type: "REPORT_NOT_RECEIVED", note: "لم يصل التحويل" });
  assert.equal(disputed.data.card.status, "DISPUTED");
  assert.ok(disputed.data.card.actions.includes("CONFIRM_RECEIPT"), "the seller can still confirm later");
});

// ── The conversation ─────────────────────────────────────────────────────────────────────────

async function conversation(who: Actor) {
  const created = await request("/ai/conversations", "POST", {}, who.cookie);
  assert.equal(created.status, 201, created.raw);
  const conversationId = created.data.conversation?.id ?? created.data.id;
  const turn = async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: who.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
    const payload = complete.assistantMessage.blocks[0]?.payload ?? {};
    return { body: complete.assistantMessage.body as string, payload, deal: payload.dealCard };
  };
  return { conversationId: conversationId as string, turn };
}

test("DP-13 chat: the seller states methods, the buyer asks and chooses, both confirm in their own words", async () => {
  const s = await conversation(seller);
  const accepted = await s.turn("أقبل كليك أو الدفع عند الاستلام");
  assert.match(accepted.body, /سأعرض للمشتري/);
  assert.match(accepted.body, /كليك/);
  const view = await request("/deal-payments/seller-methods", "GET", undefined, seller.cookie);
  assert.ok(view.data.accepted.some((m: any) => m.code === "CLIQ" && !m.paused));
  const unknown = await s.turn("أقبل انستاباي");
  assert.match(unknown.body, /غير متاحة/, "no unavailable method is added");

  const id = await order(pickupListing, "PICKUP");
  const reference = id.replace(/-/g, "").slice(0, 8);
  const b = await conversation(buyer);
  const asked = await b.turn(`هل يقبل البائع كليك ${reference}`);
  assert.equal(asked.payload.surface, "DEAL_CARD", asked.body);
  assert.match(asked.body, /نعم، البائع يقبل/);
  assert.equal(asked.deal.status, "WAITING_FOR_BUYER", "a question does not choose");
  const chose = await b.turn("أفضل كليك");
  assert.equal(chose.deal.status, "AWAITING_PAYMENT", chose.body);
  assert.match(chose.body, /تم الاتفاق/);
  const privacy = await b.turn("لا أريد مشاركة رقم حسابي قبل تأكيد الشراء");
  assert.match(privacy.body, /لن تُشارك/);

  const sv = await conversation(seller);
  const shared = await sv.turn(`شارك بيانات الدفع ${reference}`);
  assert.match(shared.body, /شاركت بيانات الدفع/);
  const paid = await b.turn("دفعت");
  assert.equal(paid.deal.status, "BUYER_REPORTED_PAID");
  assert.match(paid.body, /ليس تأكيدًا/);
  const received = await sv.turn("استلمت المبلغ");
  assert.equal(received.deal.status, "SELLER_CONFIRMED_RECEIPT");
  assert.match(received.body, /لم يتحقق منه جاسم/);

  // Stored chat blocks hold the order id only: no instructions, no names, no amounts.
  const stored = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, b.conversationId));
  const dealBlocks = stored.filter((row) => (row.payload as any)?.dealCard);
  assert.ok(dealBlocks.length >= 3);
  for (const row of dealBlocks) assert.deepEqual(Object.keys((row.payload as any).dealCard).sort(), ["kind", "orderId"]);
  assert.ok(!JSON.stringify(stored).includes("AHMAD.SHOP"));
  // Read back: rebuilt for the reader; a stranger reading the conversation is refused by the conversation itself.
  const history = await request(`/ai/conversations/${b.conversationId}`, "GET", undefined, buyer.cookie);
  assert.equal(history.status, 200, history.raw.slice(0, 300));
  assert.ok(history.raw.includes("SELLER_CONFIRMED_RECEIPT"), "the stored card is rebuilt from live state");
  assert.equal((await request(`/ai/conversations/${b.conversationId}`, "GET", undefined, stranger.cookie)).status, 404);

  const ambiguous = await b.turn(`هل أستطيع الدفع كاش ${(await order(deliveryListing, "DELIVERY")).replace(/-/g, "").slice(0, 8)}`);
  assert.match(ambiguous.body, /عند التوصيل|عند الاستلام/, ambiguous.body);
});

test("DP-14 separation: the agreement never touches the ads wallet, subscriptions or order payments", async () => {
  const touched = await db.execute(sql`SELECT
    (SELECT count(*) FROM payment_intents pi JOIN deal_payment_agreements d ON d.order_id = pi.order_id)::int AS intents,
    (SELECT count(*) FROM information_schema.columns WHERE table_name LIKE 'deal_payment%' AND column_name SIMILAR TO '%(balance|ledger|escrow|payout|settlement)%')::int AS money_columns`);
  assert.deepEqual(touched.rows[0], { intents: 0, money_columns: 0 });
});

test("DP-15 switched off: no routes and no chat turn", async () => {
  process.env.DINAR_DEAL_PAYMENTS = "false";
  try {
    assert.equal((await request("/deal-payments/countries")).status, 404);
    assert.equal((await card(direct, buyer)).status, 404);
  } finally {
    delete process.env.DINAR_DEAL_PAYMENTS;
  }
});

test("DP-16 chat: a buyer proposal waits for the seller's «موافق»; pay-after-delivery is answered from the seller's choices", async () => {
  await setMethods(seller, [{ code: "CLIQ" }], true);
  const id = await order(pickupListing, "PICKUP");
  const reference = id.replace(/-/g, "").slice(0, 8);
  const b = await conversation(buyer);
  const after = await b.turn(`أريد الدفع بعد وصول المنتج ${reference}`);
  assert.match(after.body, /لم يذكر الدفع عند الاستلام/, after.body);
  const proposed = await b.turn("أقترح تحويل بنكي");
  assert.equal(proposed.deal.status, "PAYMENT_METHOD_PROPOSED", proposed.body);
  assert.match(proposed.body, /لم تُعتمد بعد/);
  const s = await conversation(seller);
  const shown = await s.turn(`تفاصيل الصفقة ${reference}`);
  assert.equal(shown.deal.proposal.awaiting, "SELLER", shown.body);
  const agreed = await s.turn("موافق");
  assert.equal(agreed.deal.status, "AWAITING_PAYMENT", agreed.body);
  assert.equal(agreed.deal.agreedMethod.code, "BANK_TRANSFER");
  // «موافق» with no deal card in view is left to the other flows.
  const other = await conversation(seller);
  const untouched = await other.turn("موافق");
  assert.notEqual(untouched.payload.surface, "DEAL_CARD");
});
