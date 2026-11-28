/**
 * Open payment choice: the parties may agree on any direct method; Jassim negotiates it, collects
 * the seller's details in a protected form, and never presents an unverified method as verified or
 * an instructions card as an integrated checkout. Real API and conversation runtime, disposable
 * loopback database, no network, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { aiUiBlocks, db, dealPaymentEvents, markets, messages, conversations } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
delete process.env.DINAR_DEAL_PAYMENTS;

const { default: app } = await import("../src/app");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
after(async () => {
  server.close();
  const { pool } = await import("@workspace/db");
  await pool.end();
});
let ip = Math.floor(Math.random() * 20_000);
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.51.${(ip >> 8) & 255}.${ip++ & 255}` },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const phoneBase = 51_600_000 + ((Date.now() + process.pid + 41) % 140_000);
let offset = 0;
type Actor = { id: string; cookie: string };
async function register(name: string, market: "JO" | "KW" | "EG" = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Open-${randomUUID().slice(0, 10)}!`;
  const registered = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(registered.status, 201, registered.raw);
  const switched = await request("/account/market", "PATCH", { marketId: market }, registered.cookie);
  assert.equal(switched.status, 200, `${market}: ${switched.raw}`);
  return { id: registered.data.user.id as string, cookie: registered.cookie };
}

for (const id of ["JO", "KW", "EG"]) await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, id));

async function listing(owner: Actor, price: string) {
  const created = await request("/listings", "POST", {
    title: `منتج ${randomUUID().slice(0, 4)}`, description: "منتج للاختبار فقط لا يباع", category: "أخرى", categoryId: "other", area: "المنطقة", city: "المدينة",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 20, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, owner.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
async function order(listingId: string, who: Actor) {
  const created = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `open-${randomUUID()}` }, who.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
const card = (orderId: string, who: Actor) => request(`/orders/${orderId}/deal-card`, "GET", undefined, who.cookie);
const instructions = (orderId: string, who: Actor) => request(`/orders/${orderId}/deal-card/instructions`, "GET", undefined, who.cookie);
const act = (orderId: string, who: Actor, action: Record<string, unknown>) => request(`/orders/${orderId}/deal-card/actions`, "POST", { action }, who.cookie);
async function conversation(who: Actor) {
  const created = await request("/ai/conversations", "POST", {}, who.cookie);
  assert.equal(created.status, 201, created.raw);
  const conversationId = (created.data.conversation?.id ?? created.data.id) as string;
  const turn = async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: who.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
    const payload = complete.assistantMessage.blocks[0]?.payload ?? {};
    return { body: complete.assistantMessage.body as string, deal: payload.dealCard };
  };
  return { conversationId, turn };
}
const ref = (orderId: string) => orderId.replace(/-/g, "").slice(0, 8);

const joSeller = await register("بائع أردني");
const joBuyer = await register("مشتري أردني");
const stranger = await register("غريب");

test("OM-01/02 Jordan: seller accepts CliQ and cash; buyer picks CliQ and opens the protected instructions", async () => {
  const s = await conversation(joSeller);
  const said = await s.turn("أقبل كليك وكاش يدا بيد");
  assert.match(said.body, /سأعرض للمشتري/);
  const view = await request("/deal-payments/seller-methods", "GET", undefined, joSeller.cookie);
  assert.deepEqual(view.data.accepted.filter((m: any) => !m.paused).map((m: any) => m.code).sort(), ["CASH_IN_PERSON", "CLIQ"]);
  const id = await order(await listing(joSeller, "250.000"), joBuyer);
  const b = await conversation(joBuyer);
  const chosen = await b.turn(`أفضل كليك ${ref(id)}`);
  assert.equal(chosen.deal.status, "AWAITING_PAYMENT", chosen.body);
  assert.equal(chosen.deal.agreedMethod.standing, "VERIFIED_METHOD");
  assert.equal(chosen.deal.instructionsState, "SELLER_TO_PROVIDE");
  assert.match(chosen.body, /المساحة المحمية/);
  // The seller provides the CliQ alias in the protected form (REST), never in the chat.
  const sc = await conversation(joSeller);
  const typed = await sc.turn(`بيانات كليك ${ref(id)} JO71CBJO0000000000001234567890`);
  assert.match(typed.body, /لم أحفظ هذه البيانات من المحادثة/);
  assert.equal((await instructions(id, joBuyer)).status, 404, "nothing shared from chat text");
  const provided = await act(id, joSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { beneficiaryName: "أحمد", alias: "AHMAD.SHOP" } });
  assert.equal(provided.status, 200, provided.raw);
  const opened = await instructions(id, joBuyer);
  assert.deepEqual(opened.data.instructions, { beneficiaryName: "أحمد", alias: "AHMAD.SHOP" });
  assert.match(opened.data.notice, /لا ينفذ التحويل ولا يتحقق/);
  assert.equal(opened.data.merchantCheckoutLink, null, "an instructions card is not a checkout");
  const viewed = await db.select().from(dealPaymentEvents).where(and(eq(dealPaymentEvents.orderId, id), eq(dealPaymentEvents.event, "INSTRUCTIONS_VIEWED")));
  assert.equal(viewed.length, 1);
  assert.ok(!JSON.stringify(viewed[0]!.detail).includes("AHMAD"), "the audit log holds no payment values");
});

test("OM-03..06 Kuwait: buyer asks for KNET (not pre-listed); Jassim asks the seller; KNET needs the seller's merchant checkout; a refusal keeps the agreement", async () => {
  const kwSeller = await register("بائع كويتي", "KW");
  const kwBuyer = await register("مشتري كويتي", "KW");
  await request("/deal-payments/seller-methods", "PUT", { methods: [{ code: "BANK_TRANSFER" }], replace: true }, kwSeller.cookie);
  const id = await order(await listing(kwSeller, "20.000"), kwBuyer);
  const first = await card(id, kwBuyer);
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.data.currency, "KWD");
  const b = await conversation(kwBuyer);
  const asked = await b.turn(`أريد الدفع عن طريق كي نت ${ref(id)}`);
  assert.equal(asked.deal.status, "PAYMENT_METHOD_PROPOSED", asked.body);
  assert.equal(asked.deal.proposal.code, "KNET");
  assert.equal(asked.deal.proposal.awaiting, "SELLER");
  // Jassim asks the seller in the order's own thread.
  const [thread] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.orderId, id));
  const notes = await db.select({ body: messages.body }).from(messages).where(eq(messages.conversationId, thread!.id));
  assert.ok(notes.some((n) => /يقترح الدفع عبر «كي نت \(KNET\)»/.test(n.body)), notes.map((n) => n.body).join(" | "));
  // Seller accepts; KNET requires the seller's own merchant payment link, not a personal card.
  const accepted = await act(id, kwSeller, { type: "RESPOND", accept: true });
  assert.equal(accepted.data.card.status, "AWAITING_PAYMENT");
  assert.equal(accepted.data.card.agreedMethod.requiresMerchantCheckout, true);
  assert.equal(accepted.data.card.checkout.integrated, false);
  assert.equal((await act(id, kwSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { beneficiaryName: "متجر" } })).data.code, "MERCHANT_CHECKOUT_REQUIRED");
  assert.equal((await act(id, kwSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { paymentLink: "http://pay.example/x" } })).data.code, "PAYMENT_LINK_INVALID");
  assert.equal((await act(id, kwSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { paymentLink: "https://pay.example/x", beneficiaryName: "4111 1111 1111 1111" } })).data.code, "CARD_NUMBER_REFUSED");
  const ok = await act(id, kwSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { beneficiaryName: "متجر الكويت", paymentLink: "https://pay.example/checkout/123" } });
  assert.equal(ok.status, 200, ok.raw);
  const opened = await instructions(id, kwBuyer);
  assert.equal(opened.data.merchantCheckoutLink, "https://pay.example/checkout/123", "the seller's own link, labelled as such on the card");
  // A later change the seller refuses leaves the KNET agreement unchanged.
  await act(id, kwBuyer, { type: "CHOOSE", method: "WAMD" });
  const refused = await act(id, kwSeller, { type: "RESPOND", accept: false });
  assert.deepEqual([refused.data.card.status, refused.data.card.agreedMethod.code], ["AWAITING_PAYMENT", "KNET"]);
});

test("OM-07/08 Wamd agreed in chat; a wallet the catalog does not know is negotiated and flagged unverified", async () => {
  const kwSeller = await register("بائع ومض", "KW");
  const kwBuyer = await register("مشتري ومض", "KW");
  await request("/deal-payments/seller-methods", "PUT", { methods: [{ code: "BANK_TRANSFER" }], replace: true }, kwSeller.cookie);
  const id = await order(await listing(kwSeller, "15.000"), kwBuyer);
  const b = await conversation(kwBuyer);
  const wamd = await b.turn(`أفضل الدفع عن طريق ومض ${ref(id)}`);
  assert.equal(wamd.deal.proposal.code, "WAMD", wamd.body);
  assert.equal((await act(id, kwSeller, { type: "RESPOND", accept: true })).data.card.agreedMethod.code, "WAMD");

  const other = await order(await listing(kwSeller, "9.000"), kwBuyer);
  const wallet = await b.turn(`أريد الدفع عن طريق محفظة نجمة ${ref(other)}`);
  assert.equal(wallet.deal.status, "PAYMENT_METHOD_PROPOSED", wallet.body);
  assert.match(wallet.deal.proposal.code, /^DECLARED:/);
  assert.equal(wallet.deal.proposal.label, "محفظه نجمه");
  const agreed = await act(other, kwSeller, { type: "RESPOND", accept: true });
  assert.equal(agreed.data.card.agreedMethod.standing, "USER_DECLARED_METHOD");
  assert.match(agreed.data.card.agreedMethod.standingLabel, /لم يتحقق منها جاسم/);
  assert.deepEqual(agreed.data.card.instructionFields, ["beneficiaryName", "walletProvider", "walletNumber", "phone", "accountNumber", "note"]);
  const s = await conversation(kwSeller);
  const zain = await s.turn("أقبل زين كاش");
  assert.match(zain.body, /زين كاش/);
  assert.match(zain.body, /لم يتحقق جاسم من توفرها/);
  const view = await request("/deal-payments/seller-methods", "GET", undefined, kwSeller.cookie);
  assert.ok(view.data.accepted.some((m: any) => m.code.startsWith("DECLARED:") && m.label === "زين كاش"), "a wallet named «… كاش» is not cash on delivery");
  assert.ok(!view.data.accepted.some((m: any) => m.code === "COD" && !m.paused));
});

test("OM-09 a bank transfer in another Arab country (Egypt) with its own currency and IBAN check", async () => {
  const egSeller = await register("بائع مصري", "EG");
  const egBuyer = await register("مشتري مصري", "EG");
  await request("/deal-payments/seller-methods", "PUT", { methods: [{ code: "BANK_TRANSFER" }], replace: true }, egSeller.cookie);
  const id = await order(await listing(egSeller, "500.00"), egBuyer);
  const chosen = await act(id, egBuyer, { type: "CHOOSE", method: "BANK_TRANSFER" });
  assert.equal(chosen.status, 200, chosen.raw);
  assert.equal(chosen.data.card.currency, "EGP");
  assert.equal((await act(id, egSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { iban: "not-an-iban" } })).data.code, "IBAN_INVALID");
  assert.equal((await act(id, egSeller, { type: "PROVIDE_INSTRUCTIONS", instructions: { beneficiaryName: "محمد", bankName: "بنك", iban: "EG380019000500000000263180002" } })).status, 200);
  assert.equal((await instructions(id, egBuyer)).data.instructions.bankName, "بنك");
});

test("OM-10/11 hidden until approved; never in chat history; strangers see nothing", async () => {
  const id = await order(await listing(joSeller, "30.000"), joBuyer);
  await act(id, joBuyer, { type: "CHOOSE", method: "CLIQ" });
  assert.equal((await instructions(id, joBuyer)).status, 404, "seller has not approved sharing for this deal");
  const b = await conversation(joBuyer);
  await b.turn(`تفاصيل الصفقة ${ref(id)}`);
  await act(id, joSeller, { type: "SHARE_INSTRUCTIONS" });
  await b.turn(`تفاصيل الصفقة ${ref(id)}`);
  assert.equal((await instructions(id, stranger)).status, 404);
  assert.equal((await instructions(id, joSeller)).status, 200, "the seller may see what they shared");
  const stored = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, b.conversationId));
  assert.ok(!JSON.stringify(stored).includes("AHMAD"), "no payment value in stored blocks");
  const history = await request(`/ai/conversations/${b.conversationId}`, "GET", undefined, joBuyer.cookie);
  assert.ok(!history.raw.includes("AHMAD.SHOP"), "no payment value in the conversation as read back");
  const [thread] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.orderId, id));
  const notes = await db.select({ body: messages.body }).from(messages).where(eq(messages.conversationId, thread!.id));
  assert.ok(!notes.some((n) => n.body.includes("AHMAD")), "order-thread notices never quote payment values");
});

test("OM-12/13/14 no fake checkout; unsupported is honest and does not block other methods", async () => {
  const id = await order(await listing(joSeller, "12.000"), joBuyer);
  const view = await card(id, joBuyer);
  assert.ok(view.data.acceptedMethods.every((m: any) => m.standing !== "INTEGRATED_PROVIDER"), "nothing is presented as an integrated checkout");
  assert.equal(view.data.checkout.integrated, false);
  // An admin marks a method UNAVAILABLE in Jordan: it is refused with a reason; the rest still works.
  const admin = await register("مسؤول");
  const { users } = await import("@workspace/db");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  assert.equal((await request("/admin/deal-payments/catalog-changes", "POST", { countryCode: "JO", methodCode: "STC_PAY", status: "UNAVAILABLE", reason: "غير متاحة في الأردن" }, admin.cookie)).status, 201);
  const refused = await act(id, joBuyer, { type: "CHOOSE", method: "STC_PAY" });
  assert.deepEqual([refused.status, refused.data.code], [409, "METHOD_UNSUPPORTED_FOR_THIS_TRANSACTION"]);
  assert.match(refused.data.error ?? refused.raw, /اختر وسيلة أخرى/);
  assert.equal((await act(id, joBuyer, { type: "CHOOSE", method: "CLIQ" })).status, 200, "other methods still work");
  const b = await conversation(joBuyer);
  const said = await b.turn(`أفضل الدفع عن طريق STC Pay ${ref(await order(await listing(joSeller, "5.000"), joBuyer))}`);
  assert.match(said.body, /غير متاحة في الأردن حاليًا/, said.body);
});

test("OM-15 no conversion, fees or availability are assumed", async () => {
  const id = await order(await listing(joSeller, "40.000"), joBuyer);
  const view = await card(id, joBuyer);
  assert.ok(!/exchange|fxRate|سعر الصرف|رسوم التحويل/i.test(view.raw));
  assert.equal(view.data.currency, "JOD");
  assert.equal(view.data.total, "40.000");
});
