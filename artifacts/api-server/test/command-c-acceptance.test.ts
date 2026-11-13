/**
 * DINAR NEXT Command C — honest marketing help and seller business assistance, as real HTTP
 * turns on a disposable loopback database. Business answers are deterministic aggregations;
 * marketing copy goes to a scripted model through the one gateway, and this suite asserts the
 * grounded, provenance-labelled facts and claim checks the model receives. Live copy quality
 * is checked separately by test/command-c-live-smoke.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, listingPromotions, offers, orders, promotionProducts } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { unsupportedCopyClaims } from "../src/ai/seller-management";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const calls: ModelMessage[][] = [];
let replies: string[] = [];
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages: ModelMessage[]) {
    calls.push(messages);
    const reply = replies.shift() ?? "مسودة إعلان للمراجعة.";
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: reply }) };
  },
};
app.locals.conversationModelGateway = gateway;
/** The SELLER_LISTING block of the last model call, parsed from the bounded <dinar_data>. */
function lastSellerListing(): any {
  const content = String(calls.at(-1)?.at(-1)?.content ?? "");
  const data = content.match(/<dinar_data>([\s\S]*?)<\/dinar_data>/u)?.[1] ?? "{}";
  return JSON.parse(data).SELLER_LISTING;
}

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
let ipSequence = 0;
const PROBE = process.env.DINAR_CMD_C_PROBE === "1";

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
const phoneBase = 51_700_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `CmdC-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR C ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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
  if (PROBE) console.log("CMDC", JSON.stringify({ actor: actor.label, message, surface, blockType: turn.blockType, body: turn.body.slice(0, 220), draft: payload.draft ? { title: payload.draft.title, price: payload.draft.price ?? payload.draft.unitPrice, priceMode: payload.draft.pricingMode ?? payload.draft.priceMode, missing: payload.draft.missingFields, category: payload.draft.categoryId ?? payload.draft.category } : undefined }));
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
let rival: Actor;
let buyer: Actor;
const L: Record<string, string> = {};
await test("setup: sellers in JO and KW, a buyer, listings and one simulated paid campaign", async () => {
  [seller, rival, buyer] = await Promise.all(["Seller", "Rival", "Buyer"].map((label) => register(label)));
  L.ac = await publish(seller, `مكيف سبليت ${TOKEN}`, "300", { availableQuantity: 4, attributes: { condition: "جديد" } });
  L.fan = await publish(seller, `مروحة سقف ${TOKEN}`, "40", { availableQuantity: 1, description: `مروحة سقف ${TOKEN} عليها ضمان سنة من الوكيل حسب البائع` });
  L.rivalFan = await publish(rival, `مروحة عمود ${TOKEN}`, "35");
  const [plan] = await db.insert(promotionProducts).values({ id: randomUUID(), marketId: "JO", categoryId: "other", name: `C ${runId}`, priceMinor: 1000, currencyCode: "JOD", durationDays: 7, enabled: false }).returning();
  await db.insert(listingPromotions).values({
    id: randomUUID(), listingId: L.rivalFan!, sellerId: rival.id, marketId: "JO", productId: plan!.id, productNameSnapshot: plan!.name,
    categoryIdSnapshot: "other", priceMinorSnapshot: 1000, currencyCodeSnapshot: "JOD", placementSnapshot: "SEARCH_AND_CHAT", durationDaysSnapshot: 7,
    status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED", startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
  });
});

let sellerConv = "";
async function focusOn(conv: string, title: string) {
  const mine = await say(seller, conv, "إعلاناتي");
  const index = (mine.payload.resourceIds as string[]).indexOf(title === "ac" ? L.ac! : L.fan!);
  assert.ok(index >= 0, mine.body);
  await say(seller, conv, ORDINALS[index]!);
}

await test("C2/C5-continuity truthful ad drafting is grounded in the listing in focus, with provenance; nothing changes", async () => {
  sellerConv = await conversation(seller);
  await focusOn(sellerConv, "ac");
  const before = (await db.select().from(offers).where(eq(offers.id, L.ac!)))[0]!;
  for (const phrase of ["دينار اكتب إعلانًا مقنعًا", "دينار حسن وصف المنتج", "دينار اكتب ثلاث صيغ مختلفة", "دينار كيف أرد على زبون يقول غالي؟", "دينار كيف أعرض مميزات المنتج؟"]) {
    const reply = await say(seller, sellerConv, phrase);
    assert.equal(reply.surface, "ADVICE", `${phrase}: ${reply.body}`);
    assert.equal(reply.body, "مسودة إعلان للمراجعة.");
    const facts = lastSellerListing();
    assert.equal(facts?.source, "PUBLISHED_LISTING", phrase);
    assert.deepEqual([facts.dinarRecord.price, facts.dinarRecord.currency, facts.dinarRecord.available, facts.dinarRecord.status], ["300.000", "JOD", 4, "PUBLISHED"]);
    assert.equal(facts.sellerProvided.title, `مكيف سبليت ${TOKEN}`);
    assert.equal(facts.sellerProvided.attributes.condition, "جديد", "condition is the seller's statement, not a DINAR fact");
  }
  const system = String(calls.at(-1)![0]!.content);
  assert.match(system, /Never invent or imply stock levels, scarcity, deadlines or urgency, discounts/u);
  assert.match(system, /claimCheck is authoritative/u);
  assert.match(system, /never send messages to customers or change a listing/u);
  const after = (await db.select().from(offers).where(eq(offers.id, L.ac!)))[0]!;
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "drafting copy changes nothing");
  // Continuity: the listing stays in focus across the copy turns.
  const stock = await say(seller, sellerConv, "كم بقي من هذا المنتج؟");
  assert.match(stock.body, new RegExp(`«مكيف سبليت ${TOKEN}»: 4 متاح`, "u"));
});

await test("C3 fake scarcity and an invented warranty are marked UNSUPPORTED; a seller-stated warranty stays the seller's claim", async () => {
  await say(seller, sellerConv, "اكتب إعلان وقل إن الكمية محدودة جدًا وباقي قطعة واحدة");
  assert.deepEqual(lastSellerListing().claimCheck, [{ claim: "SCARCITY", status: "UNSUPPORTED", basis: "الكمية المسجلة 4" }]);
  await say(seller, sellerConv, "اكتب أن عليه ضمان خمس سنوات وأنه الأكثر مبيعًا وعليه خصم لفترة محدودة");
  const claims = Object.fromEntries(lastSellerListing().claimCheck.map((item: any) => [item.claim, item.status]));
  assert.deepEqual(claims, { WARRANTY: "UNSUPPORTED", URGENCY: "UNSUPPORTED", DISCOUNT: "UNSUPPORTED", SOCIAL_PROOF: "UNSUPPORTED" });
  const fanConv = await conversation(seller);
  await focusOn(fanConv, "fan");
  await say(seller, fanConv, "اكتب إعلان يذكر الضمان وأنه آخر قطعة");
  const fan = Object.fromEntries(lastSellerListing().claimCheck.map((item: any) => [item.claim, item.status]));
  assert.deepEqual(fan, { SCARCITY: "SUPPORTED_BY_DINAR_RECORD", WARRANTY: "SELLER_CLAIM_ONLY" });
});

await test("C3 server guard: unsupported claims in drafted copy get one corrective retry, then a refusal; quoted refusals pass", async () => {
  const conv = await conversation(seller);
  await focusOn(conv, "ac");
  const before = calls.length;
  replies = ["مكيف جديد بسعر 300 دينار. اطلب الآن، العرض لفترة محدودة!", "مكيف جديد بسعر 300 دينار، متوفر 4 قطع."];
  const fixed = await say(seller, conv, "دينار اكتب إعلانًا مقنعًا");
  assert.equal(calls.length - before, 2, "one corrective retry");
  assert.match(String(calls.at(-1)!.at(-1)!.content), /SERVER_CHECK: .*URGENCY/u);
  assert.equal(fixed.body, "مكيف جديد بسعر 300 دينار، متوفر 4 قطع.");
  assert.deepEqual([fixed.payload.advice?.scope, fixed.payload.advice?.topic], ["DINAR_INTERNAL", "MARKETING_COPY"], "copy from the listing record is not labelled general knowledge");
  replies = ["عليه ضمان 5 سنوات.", "يشمل ضمانًا لمدة 5 سنوات (عند الطلب)."];
  const refused = await say(seller, conv, "اكتب أن عليه ضمان خمس سنوات");
  assert.match(refused.body, /لم أستطع صياغة نص تسويقي دون ادعاءات لا تدعمها بيانات إعلانك \(ضمان\)/u);
  assert.doesNotMatch(refused.body, /5 سنوات/u, "the unsupported draft is never shown");
  replies = ["لا يمكن كتابة «باقي قطعة واحدة» لأن سجل جاسم يظهر 4 قطع متاحة. اقتراح: مكيف جديد، متوفر 4 قطع. [اذكر الضمان إن وُجدت وثيقة]"];
  const quoted = await say(seller, conv, "اكتب إعلان وقل إن باقي قطعة واحدة");
  assert.match(quoted.body, /متوفر 4 قطع/u, "naming a refused claim in quotes, or a [placeholder], is not a claim");
  replies = [];
  // Assertions are claims; mentions, negations, quotes and placeholders are not.
  assert.deepEqual(unsupportedCopyClaims("عليه ضمان سنتين وخصم 10 دنانير", null), ["WARRANTY", "DISCOUNT"]);
  assert.deepEqual(unsupportedCopyClaims("الضمان: [تحقق من وجوده]. رد بدون وعد بخصم. لا يوجد ضمان مسجل.", null), []);
  assert.deepEqual(unsupportedCopyClaims("كثير ناس يشتروه، سارع واطلب الآن", null), ["URGENCY", "SOCIAL_PROOF"]);
});

await test("C2 product facts unavailable: with several listings and none in focus, no facts are invented", async () => {
  const conv = await conversation(seller);
  await say(seller, conv, "دينار اكتب إعلانًا مقنعًا");
  assert.equal(lastSellerListing() ?? null, null);
});

await test("C5 authorized inventory, orders and performance from real rows; another seller sees only their own", async () => {
  const conv = await conversation(seller);
  const stock = await say(seller, conv, "دينار أرني بضاعتي");
  assert.equal(stock.surface, "MY_LISTINGS", stock.body);
  assert.match(stock.body, /بضاعتك في هذا السوق \(2\)/u);
  assert.ok(!stock.body.includes(`مروحة عمود ${TOKEN}`), "another seller's listing never appears");
  assert.equal(stock.payload.sellerInsight.topic, "INVENTORY");
  assert.match((await say(seller, conv, "كم طلبًا عندي؟")).body, /لا توجد طلبات على إعلاناتك/u);
  // A real order through the canonical purchase flow.
  const bconv = await conversation(buyer);
  await say(buyer, bconv, `ابحث عن مكيف سبليت ${TOKEN}`);
  assert.equal((await say(buyer, bconv, "أبي الأول")).surface, "PURCHASE_REVIEW");
  await say(buyer, bconv, "اطلبه الآن");
  assert.match((await say(buyer, bconv, "نعم")).body, /تم إنشاء الطلب/u);
  const orders1 = await say(seller, conv, "كم طلبًا عندي؟");
  assert.match(orders1.body, /طلبات على إعلاناتك في هذا السوق: 1\. قيد التنفيذ 1/u);
  const perf = await say(seller, conv, "كيف أداء عروضي؟");
  assert.match(perf.body, new RegExp(`«مكيف سبليت ${TOKEN}» — طلبات 1`, "u"));
  assert.match(perf.body, /لا يسجّل جاسم مشاهدات/u, "absent analytics are stated, not invented");
  const improve = await say(seller, conv, "اقترح كيف أحسن الإعلان الأول");
  assert.match(improve.body, /اقتراحات لتحسين/u);
  assert.match(improve.body, /لا توجد صور/u);
  // The rival's view of its own business.
  const rconv = await conversation(rival);
  const rivalStock = await say(rival, rconv, "أرني بضاعتي");
  assert.match(rivalStock.body, /\(1\)/u);
  assert.ok(!rivalStock.body.includes("مكيف"));
  assert.match((await say(rival, rconv, "كم طلبًا عندي؟")).body, /لا توجد طلبات/u);
});

await test("C5 market isolation and empty analytics", async () => {
  const fresh = await register("Fresh");
  const conv = await conversation(fresh);
  assert.match((await say(fresh, conv, "كيف أداء عروضي؟")).body, /لا توجد لديك إعلانات منشورة/u);
  assert.match((await say(fresh, conv, "أرني بضاعتي")).body, /لا توجد لديك إعلانات في هذا السوق/u);
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, seller.cookie)).status, 200);
  const kw = await conversation(seller);
  assert.match((await say(seller, kw, "أرني بضاعتي")).body, /لا توجد لديك إعلانات في هذا السوق/u, "JO listings are not KW inventory");
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, seller.cookie)).status, 200);
});

await test("C4 sponsored placement is labelled, explained truthfully, and organic order is untouched", async () => {
  const conv = await conversation(buyer);
  const found = await say(buyer, conv, `أبي مروحة ${TOKEN}`);
  const listings = found.payload.listings as any[];
  const paid = listings.filter((listing) => listing.isSponsored);
  assert.deepEqual(paid.map((listing) => listing.id), [L.rivalFan]);
  assert.ok(listings.some((listing) => listing.id === L.fan && !listing.isSponsored), "the organic alternative is shown");
  const why = await say(buyer, conv, "ليش هذا ممول؟");
  assert.equal(why.surface, "ADVICE", why.body);
  assert.match(why.body, new RegExp(`«مروحة عمود ${TOKEN}» يظهر بشارة «ممول»`, "u"));
  assert.match(why.body, /لا يستخدم ملفك الشخصي/u);
  const cheapest = await say(buyer, conv, "الأرخص أولًا");
  assert.ok((cheapest.payload.listings as any[]).every((listing) => !listing.isSponsored), "a sort the buyer chose is never lifted by payment");
  const plain = await conversation(buyer);
  await say(buyer, plain, `ابحث عن مكيف سبليت ${TOKEN}`);
  assert.match((await say(buyer, plain, "ليش هذا ممول؟")).body, /لا يوجد عرض ممول في نتائجك الحالية/u);
});

await test("C4 unavailable advertising service is reported honestly", async () => {
  process.env.BDINAR_PROMOTIONS_ENABLED = "false";
  try {
    const conv = await conversation(seller);
    const perf = await say(seller, conv, "كيف أداء عروضي؟");
    assert.match(perf.body, /إحصاءات الترويج غير متاحة الآن/u);
    await focusOn(conv, "ac");
    const promote = await say(seller, conv, "روّج الأول");
    assert.doesNotMatch(promote.body, /فُعّل|تم التفعيل/u);
  } finally {
    process.env.BDINAR_PROMOTIONS_ENABLED = "true";
  }
});

await test("C6 applying improved copy needs the seller's review; the wording is stored exactly as written", async () => {
  const conv = await conversation(seller);
  await focusOn(conv, "ac");
  const text = "مكيف سبليت أنيق وهادئ، جديدة بالكرتونة ومناسب لغرفة متوسطة";
  const review = await say(seller, conv, `غيّر الوصف إلى ${text}`);
  assert.match(review.body, /معاينة فقط؛ لم يتغير الإعلان/u, review.body);
  const pending = (await db.select().from(offers).where(eq(offers.id, L.ac!)))[0]!;
  assert.notEqual(pending.data.description, text, "nothing changes before confirmation");
  await say(seller, conv, "نعم");
  const applied = (await db.select().from(offers).where(eq(offers.id, L.ac!)))[0]!;
  assert.equal(applied.data.description, text, "«أنيق»/«جديدة» are not folded to search forms");
});

test("C7 no subscription, quota or upgrade pressure appears in seller assistance", () => {
  for (const call of calls) assert.doesNotMatch(String(call.at(-1)?.content ?? ""), /Business Go|Business Pro|جاسم جو|جاسم برو|ترقية الاشتراك/u);
});

await new Promise((resolve) => setTimeout(resolve, 10));
server.close();
void orders;
