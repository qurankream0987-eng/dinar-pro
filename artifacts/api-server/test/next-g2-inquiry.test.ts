/**
 * DINAR NEXT G2 — buyer–seller inquiries mediated by DINAR, two real authenticated parties.
 * Real HTTP, real conversation runtime, real inquiry authority on a disposable loopback
 * database. The model gateway only records calls (inquiries must not need it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { conversations, db, marketplaceInquiries, marketplaceInquiryEvents, messages, negotiations, offers, orders, users } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { inquiryForParty, inquiryPreconditions, INQUIRY_INBOX_TITLE, submitInquiryMessage } from "../src/lib/inquiries";
import { refreshInquiryPayload } from "../src/ai/inquiry-turn";
import { AUTH_RATE_LIMIT_SCOPE, consumeRateLimit } from "../src/lib/auth-rate-limiter";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");

const modelInputs: ModelMessage[][] = [];
const gateway: ConversationModelGateway = {
  async proposeToolCall(input: ModelMessage[]) {
    modelInputs.push(input);
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "إجابة عامة." }) };
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
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.21.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
const phoneBase = 51_620_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `NextG2-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR G2 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 400)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}
const inquiryOf = (turn: { blocks: any[] }) => turn.blocks.find((block) => block.payload?.inquiry)?.payload;

async function publish(actor: Actor, title: string, quantity: number, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: "3", inventoryMode: "LIMITED", availableQuantity: quantity, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

async function reload(actor: Actor, conversationId: string) {
  const loaded = await request(`/ai/conversations/${conversationId}`, "GET", undefined, actor.cookie);
  assert.equal(loaded.status, 200, loaded.raw);
  return loaded.data.messages as any[];
}
const inquiryBlocks = (rows: any[]) => rows.flatMap((row) => (row.blocks ?? []).map((block: any) => ({ body: row.body, payload: block.payload }))).filter((item) => item.payload?.inquiry);

let seller: Actor;
let buyer: Actor;
let stranger: Actor;
let kwBuyer: Actor;
let cups = "";
let plates = "";
let buyerConv = "";
let sellerInbox = "";
let inquiryId = "";

const eventsOf = async (id: string) => (await db.select().from(marketplaceInquiryEvents).where(eq(marketplaceInquiryEvents.inquiryId, id))).map((row) => row.eventType);

await test("setup: seller with two listings (20 and 60 in stock), buyer, stranger, KW buyer", async () => {
  [seller, buyer, stranger] = await Promise.all(["Seller", "Buyer", "Stranger"].map((label) => register(label)));
  kwBuyer = await register("KW Buyer", "KW");
  cups = await publish(seller, `أكواب سيراميك ${TOKEN}`, 20);
  plates = await publish(seller, `صحون فخار ${TOKEN}`, 60);
});

await test("G2-01/11 buyer asks about stock; with no listing in view DINAR asks which listing", async () => {
  buyerConv = await conversation(buyer);
  const unclear = await say(buyer, buyerConv, "دينار اسأل البائع هل عنده 50 قطعة");
  assert.match(unclear.body, /أي إعلان تقصد/u);
  assert.equal(inquiryOf(unclear)?.surface, "INQUIRY_NOTICE");
  const search = await say(buyer, buyerConv, `ابحث عن أكواب سيراميك ${TOKEN}`);
  assert.ok(search.blocks.some((block) => block.type === "LISTING_RESULTS"), search.body);
});

await test("G2-02 inventory already answers: no message is sent, the fact is labelled as a DINAR record", async () => {
  const conv = await conversation(buyer);
  await say(buyer, conv, `ابحث عن صحون فخار ${TOKEN}`);
  const answered = await say(buyer, conv, "دينار اسأل البائع هل عنده 50 قطعة");
  assert.match(answered.body, /سجل DINAR يُظهر توفر 60 قطعة/u, answered.body);
  assert.match(answered.body, /لم أرسل شيئًا للبائع/u);
  assert.equal(inquiryOf(answered).inquiry.fact.source, "DINAR_RECORD");
  assert.equal((await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, plates))).length, 0);
  // G2-03 explicit seller confirmation is still possible.
  const confirm = await say(buyer, conv, "اسأل البائع للتأكيد هل عنده 50 قطعة");
  assert.equal(inquiryOf(confirm)?.surface, "INQUIRY_DRAFT", confirm.body);
  assert.match(confirm.body, /هل تتوفر لديكم كمية 50 قطعة من «صحون فخار/u);
  assert.match((await say(buyer, conv, "لا")).body, /أُلغيت الرسالة؛ لم يُرسل شيء/u);
});

await test("G2-04 short stock: no promise of 50; a DINAR draft is shown and sent only after approval", async () => {
  const before = modelInputs.length;
  const draft = await say(buyer, buyerConv, "دينار اسأل البائع هل عنده 50 قطعة");
  const payload = inquiryOf(draft);
  assert.equal(payload?.surface, "INQUIRY_DRAFT", draft.body);
  assert.match(draft.body, /المتاح في سجل DINAR الآن 20 فقط، فلا أستطيع وعدك بـ50/u);
  assert.equal(payload.inquiry.provenance, "DINAR_DRAFT_APPROVED");
  assert.equal(payload.inquiry.status, "PENDING");
  assert.equal((await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, cups))).length, 0, "nothing sent before approval");
  const sent = await say(buyer, buyerConv, "أرسل");
  assert.match(sent.body, /أُرسلت رسالتك ووصلت إلى محادثة البائع داخل DINAR/u, sent.body);
  assert.match(sent.body, /لا توجد إشعارات خارجية مفعّلة/u);
  const status = inquiryOf(sent);
  assert.equal(status?.surface, "INQUIRY_STATUS");
  inquiryId = status.inquiry.inquiryId;
  assert.equal(status.inquiry.statusLabel, "بانتظار رد البائع");
  assert.deepEqual((await eventsOf(inquiryId)).sort(), ["INQUIRY_DELIVERED", "INQUIRY_SUBMITTED"]);
  assert.equal(modelInputs.length, before, "inquiries never call the model");
  const [row] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, inquiryId));
  assert.deepEqual([row!.buyerId, row!.sellerId, row!.listingId, row!.status, row!.relationship], [buyer.id, seller.id, cups, "AWAITING_SELLER", "LISTING_INQUIRY"]);
  assert.equal(row!.buyerConversationId, buyerConv);
});

await test("G2-05/09/20 the seller receives the real inquiry asynchronously in DINAR (offline recipient, no notification transport)", async () => {
  const listed = await request("/ai/conversations", "GET", undefined, seller.cookie);
  const inbox = (listed.data as any[]).find((row) => row.title === INQUIRY_INBOX_TITLE);
  assert.ok(inbox, "the inbox conversation was created for the seller");
  sellerInbox = inbox.id;
  const [delivered] = await db.select().from(marketplaceInquiryEvents).where(and(eq(marketplaceInquiryEvents.inquiryId, inquiryId), eq(marketplaceInquiryEvents.eventType, "INQUIRY_DELIVERED")));
  assert.deepEqual(delivered!.detail, { channel: "IN_APP", notification: "NOT_CONFIGURED" });
  assert.ok(!(await eventsOf(inquiryId)).includes("INQUIRY_READ"), "delivery is not a read");
  const rows = await reload(seller, sellerInbox);
  const incoming = inquiryBlocks(rows).find((item) => item.payload.surface === "INQUIRY_INCOMING")!;
  assert.match(incoming.body, /وصلتك رسالة من المشتري بخصوص «أكواب سيراميك/u);
  assert.match(incoming.body, /صاغه DINAR ووافق عليه المرسل قبل الإرسال/u);
  assert.equal(incoming.payload.inquiry.role, "SELLER");
  assert.equal(incoming.payload.inquiry.messages[0].provenance, "DINAR_DRAFT_APPROVED");
  assert.equal(incoming.payload.inquiry.notification.status, "NOT_CONFIGURED");
  assert.ok(!JSON.stringify(rows).includes(buyer.id), "the buyer's account id is not exposed");
  assert.ok((await eventsOf(inquiryId)).includes("INQUIRY_READ"), "opening it is the read receipt");
  const buyerStatus = await say(buyer, buyerConv, "دينار ماذا رد البائع؟");
  assert.match(buyerStatus.body, /لم يرد البائع بعد/u);
  assert.match(buyerStatus.body, /وقد فتحها/u);
});

await test("G2-06/18 the seller replies naturally: reviewed, sent verbatim, no stock change, no order", async () => {
  const before = await db.select().from(offers).where(eq(offers.id, cups));
  const draft = await say(seller, sellerInbox, "عندي 60 قطعة، ويمكن توفيرها خلال يومين.");
  assert.equal(inquiryOf(draft)?.surface, "INQUIRY_DRAFT", draft.body);
  assert.match(draft.body, /سأرسل ردك إلى المشتري كما كتبته دون تعديل/u);
  assert.equal(inquiryOf(draft).inquiry.provenance, "SELLER_AUTHORED");
  const sent = await say(seller, sellerInbox, "نعم");
  assert.match(sent.body, /أُرسلت رسالتك ووصلت إلى محادثة المشتري/u, sent.body);
  assert.ok((await eventsOf(inquiryId)).includes("INQUIRY_REPLIED"));
  const after = await db.select().from(offers).where(eq(offers.id, cups));
  assert.deepEqual([after[0]!.availableQuantity, after[0]!.updatedAt.getTime()], [before[0]!.availableQuantity, before[0]!.updatedAt.getTime()], "an informal reply never changes inventory");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, buyer.id))).length, 0);
  assert.equal((await db.select().from(negotiations).where(eq(negotiations.buyerId, buyer.id))).length, 0);
});

await test("G2-07/19 the buyer gets the attributed reply in the original conversation, also after reload", async () => {
  const rows = await reload(buyer, buyerConv);
  const delivered = rows.filter((row) => /ردّ البائع على رسالتك/u.test(row.body));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].body, /«عندي 60 قطعة، ويمكن توفيرها خلال يومين\.»/u);
  assert.match(delivered[0].body, /كتبه البائع؛ نُقل كما هو دون تعديل من DINAR/u);
  const answer = await say(buyer, buyerConv, "دينار ماذا قال البائع؟");
  assert.match(answer.body, /ردّ البائع بخصوص «أكواب سيراميك/u);
  assert.match(answer.body, /«عندي 60 قطعة، ويمكن توفيرها خلال يومين\.» — كتبه البائع/u);
  assert.match(answer.body, /لا يعني تغييرًا في المخزون أو طلب شراء/u);
  const view = inquiryOf(answer).inquiry;
  assert.deepEqual(view.messages.map((message: any) => [message.authorRole, message.provenance]), [["BUYER", "DINAR_DRAFT_APPROVED"], ["SELLER", "SELLER_AUTHORED"]]);
  assert.equal(view.listing.availableLabel, "20 متاح الآن في سجل جاسم", "structured fact shown separately from the seller's statement");
  const again = await reload(buyer, buyerConv);
  const drafts = inquiryBlocks(again).filter((item) => item.payload.surface === "INQUIRY_DRAFT");
  assert.equal(drafts.at(-1)!.payload.inquiry.status, "CONFIRMED", "the draft card shows its real outcome after reload");
  const statuses = inquiryBlocks(again).filter((item) => item.payload.surface === "INQUIRY_STATUS");
  assert.ok(statuses.at(-1)!.payload.inquiry.messages.some((message: any) => message.authorRole === "SELLER"));
});

await test("G2-08 the seller asks the buyer an authorized question inside the existing thread", async () => {
  const draft = await say(seller, sellerInbox, "دينار اسأل المشتري كم قطعة يريد");
  assert.equal(inquiryOf(draft)?.surface, "INQUIRY_DRAFT", draft.body);
  assert.match(draft.body, /«كم قطعة تريد؟»/u);
  assert.equal(inquiryOf(draft).inquiry.provenance, "DINAR_DRAFT_APPROVED");
  assert.match((await say(seller, sellerInbox, "أرسل")).body, /أُرسلت رسالتك/u);
  const tell = await say(seller, sellerInbox, "دينار وضح للمشتري أن التجهيز يحتاج يومين");
  assert.match(tell.body, /«التجهيز يحتاج يومين\.»/u, tell.body);
  assert.match((await say(seller, sellerInbox, "نعم")).body, /أُرسلت رسالتك/u);
  const rows = await reload(buyer, buyerConv);
  assert.ok(rows.some((row) => /«كم قطعة تريد؟»/u.test(row.body) && /صاغه DINAR ووافق عليه المرسل/u.test(row.body)));
  const status = await say(buyer, buyerConv, "ماذا رد البائع");
  assert.match(status.body, /3 رسائل/u, status.body);
  // A bare «نعم» under a delivered yes/no question is an answer, reviewed before sending.
  const seller2 = await register("Yes-no seller");
  const lamp = await publish(seller2, `مصابيح زيت ${TOKEN}`, 3);
  const yesBuyer = await register("Yes-no buyer");
  const yesConv = await conversation(yesBuyer);
  await say(yesBuyer, yesConv, `ابحث عن مصابيح زيت ${TOKEN}`);
  await say(yesBuyer, yesConv, "اسأل البائع هل المصباح يعمل بالكاز");
  await say(yesBuyer, yesConv, "أرسل");
  const seller2Inbox = ((await request("/ai/conversations", "GET", undefined, seller2.cookie)).data as any[]).find((row) => row.title === INQUIRY_INBOX_TITLE);
  await say(seller2, seller2Inbox.id, "اسأل المشتري هل تريد التوصيل");
  await say(seller2, seller2Inbox.id, "أرسل");
  const yes = await say(yesBuyer, yesConv, "نعم");
  assert.equal(inquiryOf(yes)?.surface, "INQUIRY_DRAFT", yes.body);
  assert.match(yes.body, /«نعم»/u);
  assert.match((await say(yesBuyer, yesConv, "نعم")).body, /أُرسلت رسالتك/u);
  void lamp;
  // The buyer answers under the incoming question.
  const reply = await say(buyer, buyerConv, "أحتاج 40 قطعة فقط");
  assert.equal(inquiryOf(reply)?.surface, "INQUIRY_DRAFT", reply.body);
  assert.match((await say(buyer, buyerConv, "أرسل")).body, /أُرسلت رسالتك/u);
});

await test("G2-10 duplicate submission: a repeated confirmation and a repeated identical message are not sent twice", async () => {
  const again = await say(buyer, buyerConv, "أرسل");
  assert.doesNotMatch(again.body, /أُرسلت رسالتك ووصلت/u);
  const count = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(messages).where(eq(messages.conversationId, (await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, inquiryId)))[0]!.threadConversationId)))[0]!.n);
  const before = await count();
  await say(buyer, buyerConv, "اسأل البائع هل يوصل إلى إربد");
  await say(buyer, buyerConv, "أرسل");
  await say(buyer, buyerConv, "اسأل البائع هل يوصل إلى إربد");
  const duplicate = await say(buyer, buyerConv, "أرسل");
  assert.match(duplicate.body, /أرسلت الرسالة نفسها من قبل/u, duplicate.body);
  assert.equal(await count(), before + 1);
  // Idempotent at the authority too: the same confirmed action id stores one message.
  const actionId = randomUUID();
  const market = { id: "JO", minorUnitScale: 3, currencyCode: "JOD" };
  const first = await submitInquiryMessage({ actionId, actorId: buyer.id, market, target: { kind: "INQUIRY", inquiryId }, body: "سؤال إضافي عن اللون", provenance: "BUYER_AUTHORED", originConversationId: buyerConv });
  const second = await submitInquiryMessage({ actionId, actorId: buyer.id, market, target: { kind: "INQUIRY", inquiryId }, body: "سؤال إضافي عن اللون", provenance: "BUYER_AUTHORED", originConversationId: buyerConv });
  assert.deepEqual([first.duplicate, second.duplicate, second.messageId], [false, true, first.messageId]);
});

await test("G2-16 spam: unanswered-message limit, rate limit, contact details and unsolicited contact are refused", async () => {
  // The buyer has now sent 3 messages since the seller's last one.
  const blocked = await say(buyer, buyerConv, "اسأل البائع هل اللون أبيض");
  const sent = await say(buyer, buyerConv, "أرسل");
  assert.match(`${blocked.body}\n${sent.body}`, /أرسلت 3 رسائل دون رد/u);
  const phone = await say(buyer, buyerConv, "اسأل البائع ممكن تتصل علي 0791234567");
  assert.match(phone.body, /لا تُرسل أرقام الهواتف/u);
  const spammer = await register("Spammer");
  for (let index = 0; index < 12; index += 1) await consumeRateLimit([{ scope: AUTH_RATE_LIMIT_SCOPE.inquiryActor, value: spammer.id }], 3600, 12);
  const conv = await conversation(spammer);
  await say(spammer, conv, `ابحث عن صحون فخار ${TOKEN}`);
  await say(spammer, conv, "اسأل البائع هل يوجد لون أزرق");
  const limited = await say(spammer, conv, "أرسل");
  assert.match(limited.body, /أرسلت رسائل كثيرة خلال وقت قصير/u, limited.body);
  // A seller cannot contact a buyer with whom there is no inquiry, offer or order.
  const lonelySeller = await register("Lonely seller");
  const refused = await say(lonelySeller, await conversation(lonelySeller), "اسأل المشتري كم قطعة يريد");
  assert.match(refused.body, /لا يمكنني مراسلة مشترٍ ليس بينك وبينه استفسار أو عرض سعر أو طلب/u);
});

await test("G2-12/13 wrong seller, own listing and cross-market requests are refused", async () => {
  const conv = await conversation(seller);
  await say(seller, conv, `ابحث عن صحون فخار ${TOKEN}`);
  assert.match((await say(seller, conv, "اسأل البائع هل عنده لون أحمر")).body, /هذا إعلانك؛ لا يمكنك مراسلة نفسك/u);
  await assert.rejects(inquiryPreconditions(kwBuyer.id, { id: "KW" }, { kind: "LISTING", listingId: cups }), /الإعلان غير موجود في سوقك الحالي/u);
  await assert.rejects(inquiryPreconditions(buyer.id, { id: "KW" }, { kind: "INQUIRY", inquiryId }), /في سوق آخر/u);
  await assert.rejects(inquiryPreconditions(stranger.id, { id: "JO" }, { kind: "INQUIRY", inquiryId }), /الاستفسار غير موجود/u);
});

await test("G2-14 unauthorized: another account can neither read the thread nor the conversations", async () => {
  assert.equal((await request(`/ai/conversations/${buyerConv}`, "GET", undefined, stranger.cookie)).status, 404);
  assert.equal((await request(`/ai/conversations/${sellerInbox}`, "GET", undefined, stranger.cookie)).status, 404);
  assert.equal(await inquiryForParty(stranger.id, inquiryId), undefined);
  const forged = await refreshInquiryPayload({ view: "STATUS", inquiryId }, stranger.id, { id: "JO", minorUnitScale: 3, currencyCode: "JOD", countryCode: "JO" } as any);
  assert.equal(forged.view, "NOTICE");
  assert.ok(!JSON.stringify(forged).includes("60 قطعة"));
  const [thread] = await db.select().from(conversations).where(eq(conversations.id, (await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, inquiryId)))[0]!.threadConversationId));
  assert.deepEqual([thread!.kind, thread!.ownerUserId], ["INQUIRY", null], "the thread is not anyone's AI conversation");
  const listed = await request("/ai/conversations", "GET", undefined, buyer.cookie);
  assert.ok(!(listed.data as any[]).some((row) => row.id === thread!.id));
});

await test("G2-15 suspended participant: no new messages reach or leave a suspended account", async () => {
  const other = await register("Other seller");
  await publish(other, `مصابيح نحاس ${TOKEN}`, 5);
  const conv = await conversation(stranger);
  await say(stranger, conv, `ابحث عن مصابيح نحاس ${TOKEN}`);
  await db.update(users).set({ status: "SUSPENDED", statusChangedAt: new Date() }).where(eq(users.id, other.id));
  const refused = await say(stranger, conv, "اسأل البائع هل يوجد توصيل");
  assert.match(refused.body, /البائع غير متاح للمراسلة حاليًا/u, refused.body);
  assert.equal((await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.sellerId, other.id))).length, 0);
});

await test("G2-17 a price-negotiation question is routed away from inquiries: no inquiry, no offer created", async () => {
  const conv = await conversation(stranger);
  await say(stranger, conv, `ابحث عن صحون فخار ${TOKEN}`);
  const offersBefore = (await db.select().from(negotiations).where(eq(negotiations.buyerId, stranger.id))).length;
  const priced = await say(stranger, conv, "دينار اسأل البائع هل تعطيني 50 قطعة بمبلغ 100؟");
  assert.match(priced.body, /العروض المالية لا تُرسل كاستفسار/u, priced.body);
  assert.equal(inquiryOf(priced).inquiry.failure, "PRICE_OFFER");
  assert.equal((await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, stranger.id))).length, 0);
  assert.equal((await db.select().from(negotiations).where(eq(negotiations.buyerId, stranger.id))).length, offersBefore);
});

await test("G2-18b a seller's future-stock statement is delivered as a statement only", async () => {
  // The seller answers the buyer's latest messages; nothing in inventory moves.
  const stock = (await db.select().from(offers).where(eq(offers.id, cups)))[0]!.availableQuantity;
  await say(seller, sellerInbox, "رد عليه: ما عندي 50 الآن، أقدر أوفرها الأسبوع القادم");
  assert.match((await say(seller, sellerInbox, "نعم")).body, /أُرسلت رسالتك/u);
  assert.equal((await db.select().from(offers).where(eq(offers.id, cups)))[0]!.availableQuantity, stock);
  assert.match((await say(buyer, buyerConv, "ماذا رد البائع")).body, /أقدر أوفرها الأسبوع القادم/u);
});

await test("G2-21 the other party's words are never fed to the model as history", async () => {
  const before = modelInputs.length;
  await say(buyer, buyerConv, "اشرح لي فائدة السيراميك في المطبخ");
  assert.equal(modelInputs.length, before + 1);
  const sent = JSON.stringify(modelInputs.at(-1));
  assert.ok(!sent.includes("أقدر أوفرها الأسبوع القادم"), "delivered seller text is excluded from model input");
});

await test("G2-22 list, close and block controls", async () => {
  const list = await say(seller, sellerInbox, "هل عندي استفسارات؟");
  assert.equal(inquiryOf(list)?.surface, "INQUIRY_LIST");
  assert.ok(inquiryOf(list).inquiry.items.some((item: any) => item.inquiryId === inquiryId));
  const blocked = await say(buyer, buyerConv, "احظر هذا البائع");
  assert.match(blocked.body, /أوقفت المراسلة مع هذا الطرف/u, blocked.body);
  assert.ok((await eventsOf(inquiryId)).includes("INQUIRY_BLOCKED"));
  const attempt = await say(seller, sellerInbox, "اسأل المشتري متى يناسبه التسليم");
  assert.match(attempt.body, /المراسلة بينكما موقوفة/u, attempt.body);
});

server.close();
