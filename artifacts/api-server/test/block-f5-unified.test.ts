/**
 * Block F5 — unified intelligent experience: connected, cross-authority journeys through
 * the public conversation route the DINAR UI uses. Only image turns (Object Storage is a
 * provider boundary) and explicit admin/fixture steps call server code directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  aiUiBlocks,
  candidateProfiles,
  cartItems,
  carts,
  db,
  deliveryAssignments,
  driverProfiles,
  jobApplications,
  jobs,
  listingPromotions,
  markets,
  messages,
  offers,
  orderFulfillments,
  orders,
  paymentIntents,
  pool,
  promotionProducts,
  transactionLocations,
  users,
} from "@workspace/db";
import { confirmPendingAction, conversationContext, createPendingAction, proposeAction } from "../src/ai/action-foundation";
import { executeAiConversationTurn } from "../src/ai/conversation-runtime";
import { readDraftSnapshot } from "../src/ai/draft-actions";
import { DeterministicPhotoSuggestionProvider } from "../src/ai/listing-photo-intelligence";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { attachTransactionLocation, selectDeliveryMethod } from "../src/lib/delivery";
import { resolveMarket } from "../src/lib/markets";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const execFileAsync = promisify(execFile);
const providerConfigured = Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);

// Every outbound request that leaves loopback is recorded: no marketplace, job, delivery,
// map, SMS, payment or ad provider is ever contacted.
const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // Not a URL; not a network request.
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port as number;
const base = `http://127.0.0.1:${port}/api`;
const runId = randomUUID().slice(0, 6);
const CITY = `عمان ${Date.now() % 100_000}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.70.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
      ...headers,
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
  return {
    status: response.status,
    data,
    raw,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    cacheControl: response.headers.get("cache-control") ?? "",
  };
}

type Actor = { id: string; cookie: string; phone: string; conv: string; label: string };
const phoneBase = 51_200_000 + ((Date.now() + process.pid) % 500_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  assert.equal(started.status, 202, `challenge ${phoneNumber}: ${started.raw}`);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `BlockF5-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F5 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  await db.update(users).set({ city: CITY }).where(eq(users.id, registered.data.user.id));
  const actor = { id: registered.data.user.id, cookie: registered.cookie, phone: phoneNumber, conv: "", label };
  actor.conv = (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id;
  return actor;
}

// ─── Turns and false-success accounting ──────────────────────────────────────

const falses = { listing: 0, listingUpdate: 0, order: 0, payment: 0, promotion: 0, availability: 0, assignment: 0 };
const modelCalls: { phrase: string; calls: number }[] = [];
type Turn = { body: string; payload: any; surface: string | undefined };
const countOwned = async (actor: Actor) => {
  const [listings, ordersCount, intents, promos, assigned, profile] = await Promise.all([
    db.select({ id: offers.id, status: offers.status, price: offers.unitPriceMinor }).from(offers).where(eq(offers.sellerId, actor.id)),
    db.select({ id: orders.id }).from(orders).where(eq(orders.buyerId, actor.id)),
    db.select({ id: paymentIntents.id }).from(paymentIntents).where(eq(paymentIntents.buyerId, actor.id)),
    db.select({ id: listingPromotions.id }).from(listingPromotions).where(and(eq(listingPromotions.sellerId, actor.id), eq(listingPromotions.status, "ACTIVE"))),
    db.select({ id: deliveryAssignments.id }).from(deliveryAssignments).where(and(eq(deliveryAssignments.driverId, actor.id), eq(deliveryAssignments.status, "ACCEPTED"))),
    db.select({ availability: driverProfiles.availability }).from(driverProfiles).where(eq(driverProfiles.userId, actor.id)),
  ]);
  return { listings, orders: ordersCount.length, intents: intents.length, promos: promos.length, assigned: assigned.length, available: profile[0]?.availability === "AVAILABLE" };
};
async function turn(actor: Actor, message: string, extra: Record<string, unknown> = {}, conversationId = actor.conv): Promise<Turn> {
  const before = await countOwned(actor);
  const calls = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message, ...extra }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  modelCalls.push({ phrase: message, calls: getModelGatewayCallCount() - calls });
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  const body: string = complete.assistantMessage.body;
  const payload = complete.assistantMessage.blocks[0]?.payload ?? {};
  const after = await countOwned(actor);
  const published = after.listings.filter((row) => row.status === "PUBLISHED").length - before.listings.filter((row) => row.status === "PUBLISHED").length;
  if (/تم نشر الإعلان/.test(body) && published !== 1) falses.listing++;
  if (/تم تنفيذ التغيير/.test(body) && JSON.stringify(after.listings) === JSON.stringify(before.listings)) falses.listingUpdate++;
  if (/تم إنشاء الطلب|تم الشراء/.test(body) && after.orders !== before.orders + 1) falses.order++;
  if (/طلب دفع تجريبي لطلب/.test(body) && after.intents !== before.intents + 1) falses.payment++;
  if (/تم الدفع(?! التجريبي)/.test(body)) falses.payment++;
  if (/تم الدفع التجريبي .*وتفعيل ترويج/.test(body) && after.promos !== before.promos + 1) falses.promotion++;
  if (/أنت متاح الآن/.test(body) && !after.available) falses.availability++;
  if (/تم قبول مهمة التوصيل/.test(body) && after.assigned !== before.assigned + 1) falses.assignment++;
  return { body, payload, surface: payload.surface ?? (payload.listings ? "LISTING_RESULTS" : undefined) };
}

/** An image turn through the same shared runtime; only the image provider is deterministic. */
async function imageTurn(actor: Actor, message: string, suggestions: unknown[]) {
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const imagePath = `/objects/uploads/${randomUUID()}`;
  const userMessageId = randomUUID();
  await db.insert(messages).values({ id: userMessageId, conversationId: actor.conv, senderId: actor.id, body: message, actor: "USER", contentType: "TEXT", metadata: { turnStatus: "completed", imageObjectPaths: [imagePath] } });
  const calls = getModelGatewayCallCount();
  const result = (
    await executeAiConversationTurn(
      { conversationId: actor.conv, currentMessageId: userMessageId, message, market: await resolveMarket(row!), actorId: actor.id, imageObjectPaths: [imagePath] },
      { photoSuggestionProvider: new DeterministicPhotoSuggestionProvider(suggestions.map((item: any) => ({ ...item, imageObjectPath: imagePath }))) },
    )
  ).result;
  modelCalls.push({ phrase: `[image] ${message}`, calls: getModelGatewayCallCount() - calls });
  const assistantId = randomUUID();
  await db.insert(messages).values({ id: assistantId, conversationId: actor.conv, body: result.prompt ?? "", actor: "ASSISTANT", contentType: "TEXT" });
  await db.insert(aiUiBlocks).values({
    id: randomUUID(), conversationId: actor.conv, messageId: assistantId, blockType: "SURFACE", version: 1, ordinal: 0,
    payload: { resultSetId: randomUUID(), listings: [], surface: result.surface, draft: result.draft, draftStep: result.draftStep, draftReview: result.draftReview },
  });
  return result;
}

async function publish(actor: Actor, title: string, price: string, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف مفصل للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: CITY,
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "DELIVERY", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
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
const attacks = { passed: 0, failed: 0 };
async function rejected(attempt: () => Promise<unknown>, statuses: number[], label: string) {
  const outcome = await attempt().then((value) => ({ value }), (error) => ({ error }));
  const status = "error" in outcome ? (outcome.error as any)?.status : (outcome.value as any)?.status;
  if (statuses.includes(status)) attacks.passed++;
  else attacks.failed++;
  assert.ok(statuses.includes(status), `${label}: ${JSON.stringify(outcome).slice(0, 220)}`);
}
const setOf = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;
const offerOf = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const pendingOf = async (conversationId: string, action: string) =>
  (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, conversationId))).filter((set) => (set.query as any).action === action && (set.query as any).status === "PENDING").at(-1);
const ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
const positionOf = (ids: string[], id: string) => {
  const index = ids.indexOf(id);
  assert.ok(index >= 0 && index < ORDINALS.length, `listing ${id} is shown (${ids.length})`);
  return ORDINALS[index]!;
};

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let admin: Actor, seller: Actor, buyer: Actor, promoter: Actor, shopper: Actor, multi: Actor, driver: Actor, rival: Actor, candidate: Actor, employer: Actor, sideSeller: Actor;
let trackedOrderId = "";
const L: Record<string, string> = {};
const approve = async (actor: Actor) =>
  request(`/admin/drivers/${(await db.select().from(driverProfiles).where(eq(driverProfiles.userId, actor.id)))[0]!.id}/review`, "POST", { decision: "APPROVE" }, admin.cookie);

/** A real COURIER order: canonical checkout, seller accept, Block D method and destination. */
async function courierOrder(title: string) {
  const listing = await publish(sideSeller, `${title} ${runId}`, "10");
  const [listingRow] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, listing));
  await db.update(offers).set({ data: { ...listingRow!.data, city: CITY } }).where(eq(offers.id, listing));
  const order = await request("/orders", "POST", { listingId: listing, quantity: 1, fulfilmentType: "DELIVERY", idempotencyKey: `f5-${randomUUID()}` }, shopper.cookie);
  assert.equal(order.status, 201, order.raw);
  assert.equal((await request(`/orders/${order.data.id}/accept`, "POST", {}, sideSeller.cookie)).status, 200);
  await db.transaction((tx) => selectDeliveryMethod({ actorId: shopper.id, orderId: order.data.id, method: "COURIER", market: JO }, tx));
  await db.transaction((tx) => attachTransactionLocation({ actorId: shopper.id, orderId: order.data.id, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", city: CITY, area: "الصويفية", addressText: `شارع خاص ${runId} بناية 3` }, market: JO }, tx));
  return order.data.id as string;
}

async function agreeCourierFare(orderId: string, buyerActor: Actor, courierActor: Actor) {
  const proposed = await request(
    `/orders/${orderId}/courier-fare/proposals`,
    "POST",
    { amount: "1.000", idempotencyKey: `f5-${randomUUID()}` },
    buyerActor.cookie,
  );
  assert.equal(proposed.status, 200, proposed.raw);
  const proposalId = proposed.data.proposal.id;
  const buyerConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    buyerActor.cookie,
  );
  assert.equal(buyerConfirmation.status, 200, buyerConfirmation.raw);
  assert.equal(buyerConfirmation.data.agreed, false);
  const courierConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    courierActor.cookie,
  );
  assert.equal(courierConfirmation.status, 200, courierConfirmation.raw);
  assert.equal(courierConfirmation.data.agreed, true);
}

await test("setup: providers off, accounts, catalogue, policies", async () => {
  assert.equal(providerConfigured, false, "F5 runs with model credentials stripped");
  [admin, seller, buyer, promoter, shopper, multi, driver, rival, candidate, employer, sideSeller] = await Promise.all(
    ["Admin", "Seller", "Buyer", "Promoter", "Shopper", "Multi", "Driver", "Rival", "Candidate", "Employer", "Side Seller"].map(register),
  );
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
  // Fashion (with one listing missing its condition, so comparison shows «unknown»).
  for (const [key, title, price, condition] of [
    ["teeBlack5", "تيشيرت نايكي أسود مقاس L", "5", "جديد"],
    ["teeBlack7", "تيشيرت نايكي أسود مقاس L", "7", "مستعمل"],
    ["teeBlack6", "تيشيرت نايكي أسود مقاس L", "6", null],
    ["teeWhite4", "تيشيرت نايكي أبيض مقاس L", "4", "جديد"],
    ["teeBlackM", "تيشيرت نايكي أسود مقاس M", "6", "جديد"],
  ] as const)
    L[key] = await publish(sideSeller, title, price, { category: "أزياء", categoryId: "fashion", attributes: condition ? { condition } : {} });
  // Food, service, vehicles: the same generic listing authority.
  L.broast4 = await publish(sideSeller, `بروستد دجاج وجبة عائلية ${runId}`, "4");
  L.broast3 = await publish(sideSeller, `بروستد حار ${runId}`, "3");
  L.ac = await publish(sideSeller, `صيانة وتصليح مكيفات ${runId}`, "15", { category: "خدمات", categoryId: "services", fulfilmentType: "SERVICE", inventoryMode: "UNLIMITED", availableQuantity: null });
  for (const [year, price] of [[2021, "14000"], [2020, "12500"], [2018, "9000"], [2022, "16000"]] as const)
    L[`prado${year}`] = await publish(sideSeller, `تويوتا برادو ${year} ${runId}`, price, {
      category: "سيارات", categoryId: "cars", fulfilmentType: "PICKUP", availableQuantity: 1,
      attributes: { make: "تويوتا", model: "برادو", year, mileage: 50000, condition: "مستعمل", fuel: "بنزين", transmission: "أوتوماتيك", color: "أبيض" },
    });
  // Promotion plans configured by the market (Block E), price fixed by the plan.
  for (const categoryId of ["other", "fashion"])
    await db.insert(promotionProducts).values({ id: randomUUID(), marketId: "JO", categoryId, name: `أسبوع ${categoryId} ${runId}`, placement: "SEARCH_AND_CHAT", priceMinor: 2000, currencyCode: "JOD", durationDays: 7, enabled: true, createdBy: admin.id });
});

// ─── Seller ──────────────────────────────────────────────────────────────────

let publishedId = "";
await focused("F5-01", "seller: image draft → complete facts → «انشره» → Block B publish → «إعلاناتي»", async () => {
  const image = await imageTurn(seller, "أريد أبيع هذا", [{ field: "category", value: "electronics", confidence: 0.8 }, { field: "color", value: "أسود", confidence: 0.6 }]);
  assert.equal(image.surface, "SELL");
  const guessed = (image.draftReview as any).fields.find((field: any) => field.field === "category");
  assert.deepEqual([guessed.source, guessed.needsConfirmation], ["IMAGE_INFERRED", true], "image facts stay provisional");
  const stated = await turn(seller, "هذا آيفون 14 برو 256، نظيف، أبيعه بـ290");
  assert.equal(stated.surface, "SELL");
  assert.doesNotMatch(stated.body, /الموديل|السعة|الحالة|ما السعر/, "model, storage, condition and price are not asked again");
  assert.equal(stated.payload.draft.unitPrice, "290");
  // A text draft in the same conversation goes all the way to publication.
  await turn(seller, "أريد أبيع آيفون 14 برو 256 نظيف بـ290");
  for (const answer of ["قطعة واحدة", CITY, "محادثة فقط", "كاش"]) await turn(seller, answer);
  const review = await turn(seller, "انشره");
  assert.match(review.body, /هل تريد نشر الإعلان/);
  assert.equal((await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length, 0, "nothing before «نعم»");
  const done = await turn(seller, "نعم");
  assert.match(done.body, /تم نشر الإعلان/);
  const [row] = await db.select().from(offers).where(eq(offers.sellerId, seller.id));
  assert.equal(row!.status, "PUBLISHED");
  assert.deepEqual([row!.pricingMode, row!.unitPriceMinor], ["FIXED", 290_000], "canonical publication persists the seller's exact fixed price");
  assert.ok((row!.data as any).__publishFingerprint, "published by the Block B authority");
  publishedId = row!.id;
  const again = await turn(seller, "نعم");
  assert.equal((await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length, 1, "a repeated «نعم» publishes nothing");
  assert.doesNotMatch(again.body, /تم نشر الإعلان/);
  const mine = await turn(seller, "اعرض لي إعلاناتي");
  assert.equal(mine.surface, "MY_LISTINGS");
  assert.ok(JSON.stringify(mine.payload).includes(publishedId));
});

await focused("F5-02", "«خله بـ275», price advice and «خله 250» change only the listing in focus", async () => {
  const other = await publish(seller, `مزهرية ${runId}`, "12");
  const list = await turn(seller, "اعرض لي إعلاناتي");
  const ids = list.payload.resourceIds as string[];
  const ambiguous = await turn(seller, "خله بـ275");
  assert.match(ambiguous.body, /حدّد إعلانًا|أي إعلان/, "two listings: no guess");
  assert.equal(ids.length, 2);
  // The listing in focus: opened by name from «إعلاناتي».
  await turn(seller, "اعرض لي إعلاناتي");
  await turn(seller, "افتح إعلان آيفون 14 برو 256");
  const preview = await turn(seller, "خله بـ275");
  assert.match(preview.body, /معاينة/, preview.body);
  assert.match((await turn(seller, "نعم")).body, /تم تنفيذ التغيير/);
  assert.equal((await offerOf(publishedId)).unitPriceMinor, 275_000);
  assert.equal((await offerOf(other)).unitPriceMinor, 12_000, "the other listing is untouched");
  // Price guidance from internal comparables only, then the seller's own decision wins.
  await turn(seller, "اعرض لي إعلاناتي");
  await turn(seller, `افتح إعلان آيفون 14 برو 256`);
  const advice = await turn(seller, "كم أحط سعر؟");
  assert.equal(advice.payload.sellerInsight?.kind, "PRICE_SUGGESTION", advice.body);
  assert.equal(advice.payload.sellerInsight.source ?? "DINAR_ONLY", "DINAR_ONLY");
  assert.doesNotMatch(advice.body, /مضمون|سيُباع حتمًا|guarantee/);
  const decide = await turn(seller, "خله 250");
  assert.match(decide.body, /معاينة/, decide.body);
  await turn(seller, "نعم");
  assert.equal((await offerOf(publishedId)).unitPriceMinor, 250_000, "the seller's decision overrides the suggestion");
  assert.equal((await offerOf(other)).unitPriceMinor, 12_000);
});

await focused("F5-03", "«خلاص اتباع، شيله» archives through the listing authority; history is kept", async () => {
  await turn(seller, "اعرض لي إعلاناتي");
  await turn(seller, "افتح إعلان آيفون 14 برو 256");
  const review = await turn(seller, "خلاص اتباع، شيله");
  assert.match(review.body, /الأرشفة|أرشف/);
  assert.equal((await offerOf(publishedId)).status, "PUBLISHED", "nothing before confirmation");
  await turn(seller, "نعم");
  const row = await offerOf(publishedId);
  assert.equal(row.status, "ARCHIVED");
  assert.ok(row, "the row is kept, not destroyed");
});

await focused("F5-04", "interrupted draft → buyer search → resume; several drafts are a choice", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id;
  const s = { ...seller, conv };
  await turn(s, "أريد أبيع هذه الطاولة الخشبية بـ20");
  const before = (await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length;
  assert.equal((await turn(s, "ابحث لي عن آيفون")).surface, "LISTING_RESULTS");
  const back = await turn(s, "كمل الإعلان اللي قبل");
  assert.equal(back.surface, "SELL");
  assert.match(back.body, /الطاولة الخشبية/);
  await turn(s, "أريد أبيع قطعة غريبة للمنزل بـ3");
  await turn(s, "ابحث لي عن تيشرت");
  const choice = await turn(s, "كمل الإعلان");
  assert.match(choice.body, /مسودات غير مكتملة/);
  const shown = choice.payload.resourceIds as string[];
  assert.equal(shown.length, 2, "both drafts offered, none guessed");
  // Reload between the choice and the answer: the choice is server-backed.
  const history = await request(`/ai/conversations/${conv}`, "GET", undefined, seller.cookie);
  assert.ok(history.data.messages.flatMap((message: any) => message.blocks).some((block: any) => block.payload.draftStep === "choose_draft"));
  const picked = await turn(s, "الثاني");
  assert.equal(picked.payload.draft.draftId, shown[1], "the second draft as presented");
  assert.equal((await db.select().from(offers).where(eq(offers.sellerId, seller.id))).length, before, "no accidental publish");
});

// ─── Buyer ───────────────────────────────────────────────────────────────────

let rankedIds: string[] = [];
await focused("F5-05", "natural buyer search refined turn by turn, never restarted", async () => {
  const first = await turn(buyer, "أريد تيشرت نايكي مميز بـ5");
  assert.ok(first.payload.listings.length >= 3, first.body);
  await turn(buyer, "خله أسود");
  await turn(buyer, "مقاس L");
  const ceiling = await turn(buyer, "ما عندي مشكلة إلى 7");
  const state = (await setOf(ceiling.payload.resultSetId)).query as any;
  assert.deepEqual([state.buyer.color, state.buyer.size, state.buyer.maxPrice, state.buyer.targetPrice], ["اسود", "l", 7, 5], "every constraint kept");
  const ids = ceiling.payload.listings.map((listing: any) => listing.id);
  assert.ok(ids.includes(L.teeBlack5) && ids.includes(L.teeBlack7) && !ids.includes(L.teeWhite4) && !ids.includes(L.teeBlackM));
  const detail = await turn(buyer, "الثاني");
  assert.equal(detail.payload.presentation, "DETAILS");
  assert.equal(detail.payload.listings[0].id, ids[1], "ordinal detail resolves against the canonical displayed order");
});

await focused("F5-06", "cheapest, best value (explained), condition first, comparison with unknowns", async () => {
  const cheapest = await turn(buyer, "الأرخص");
  const prices = cheapest.payload.listings.map((listing: any) => Number(listing.unitPrice));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const best = await turn(buyer, "لا، أبي الأفضل مقابل السعر");
  assert.match(best.body, /تقديري/);
  assert.ok(best.payload.listings.every((listing: any) => Array.isArray(listing.recommendationReasons)), "each place explained");
  const condition = await turn(buyer, "ما يهمني السعر، أهم شيء الحالة");
  assert.match(condition.body, /الحالة أولًا/);
  rankedIds = (await setOf(condition.payload.resultSetId)).resourceIds;
  const compare = await turn(buyer, "قارن الأول والثالث");
  assert.equal(compare.surface, "COMPARISON");
  const conditionRow = compare.payload.comparison.rows.find((row: any) => row.label === "الحالة");
  const unknownIndex = [rankedIds[0], rankedIds[2]].indexOf(L.teeBlack6);
  if (unknownIndex >= 0) assert.equal(conditionRow.values[unknownIndex], null, "an unstated condition stays unknown");
});

let orderId = "";
await focused("F5-07", "results → review → quantity → «وصله لي» → order → one-time location → simulated payment", async () => {
  const second = rankedIds[1]!;
  const item = await turn(buyer, "أبي الثاني");
  assert.equal(item.payload.purchaseReview.listingId, second);
  assert.equal((await turn(buyer, "أبي اثنين")).payload.purchaseReview.quantity, 2);
  const delivery = await turn(buyer, "وصله لي");
  assert.equal(delivery.payload.purchaseReview.stage, "ORDER");
  assert.equal(delivery.payload.purchaseReview.fulfilment, "SELLER_DELIVERY");
  const placed = await turn(buyer, "نعم");
  assert.equal(placed.surface, "ORDER", placed.body);
  orderId = placed.payload.resourceId;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.deepEqual([order!.quantity, order!.data.commissionRateBps, order!.data.paymentMode], [2, 1000, "TEST_NO_TRANSFER"]);
  const requested = await turn(buyer, "أرسل موقعي");
  assert.equal(requested.surface, "LOCATION_PERMISSION_REQUEST");
  const preview = await turn(buyer, "مشاركة موقعي الحالي", { location: { source: "DEVICE", latitude: 31.955555, longitude: 35.944444, accuracyMeters: 14 }, locationRequestId: requested.payload.resultSetId });
  assert.equal(preview.surface, "LOCATION_PREVIEW");
  assert.equal((await turn(buyer, "نعم")).surface, "LOCATION_CONFIRMED");
  const pay = await turn(buyer, "ادفع");
  assert.equal(pay.surface, "PAYMENT_REVIEW");
  assert.equal(pay.payload.purchaseReview.total, (order!.subtotalMinor / 1000).toFixed(3));
  await turn(buyer, "كاش");
  const intent = await turn(buyer, "نعم", { paid: true, paymentStatus: "SUCCESS", total: 1 });
  assert.match(intent.body, /لم يُنشأ طلب دفع إلكتروني ولم تُحوَّل أموال/);
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, orderId))).length, 0, "cash does not create an electronic payment intent");
  assert.equal((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status, "CREATED", "payment review and cash intent do not accept or pay the order");
});

await focused("F5-08", "price and stock change during the conversation: no stale order", async () => {
  const list = await turn(buyer, "أريد تيشرت نايكي مميز بـ5");
  const ids = list.payload.listings.map((listing: any) => listing.id);
  await turn(buyer, `أبي ${positionOf(ids, L.teeBlack5)}`);
  await turn(buyer, "اطلبه الآن");
  await db.update(offers).set({ unitPriceMinor: 8_000, updatedAt: new Date() }).where(eq(offers.id, L.teeBlack5));
  const changed = await turn(buyer, "نعم");
  assert.match(changed.body, /تغير السعر من 5\.000 JOD إلى 8\.000 JOD/);
  assert.equal(changed.payload.purchaseReview.status, "PENDING", "a fresh review");
  await db.update(offers).set({ unitPriceMinor: 5_000, updatedAt: new Date() }).where(eq(offers.id, L.teeBlack5));
  await turn(buyer, "إلغاء");
  const again = await turn(buyer, "أريد تيشرت نايكي مميز بـ5");
  const againIds = again.payload.listings.map((listing: any) => listing.id);
  await turn(buyer, `أبي ${positionOf(againIds, L.teeBlack5)}`);
  await turn(buyer, "أبي اثنين");
  await turn(buyer, "اطلبه الآن");
  const row = await offerOf(L.teeBlack5);
  await db.update(offers).set({ availableQuantity: row.reservedQuantity + 1, updatedAt: new Date() }).where(eq(offers.id, L.teeBlack5));
  const fewer = await turn(buyer, "نعم");
  assert.match(fewer.body, /المتوفر الآن 1 فقط/);
  assert.equal(fewer.payload.purchaseReview.quantity, 1, "a new decision on the valid quantity");
  await turn(buyer, "إلغاء");
  await db.update(offers).set({ availableQuantity: row.availableQuantity, updatedAt: new Date() }).where(eq(offers.id, L.teeBlack5));
});

// ─── Promotion ───────────────────────────────────────────────────────────────

let promotedId = "";
await focused("F5-09", "«روّج الثاني» → real plans → «أسبوع» → review → simulated activation; numbers never collide", async () => {
  await publish(promoter, `ثريا كبيرة ${runId}`, "60", { attributes: { condition: "مستعمل" } });
  promotedId = await publish(promoter, `ثريا نحاسية ${runId}`, "45", { attributes: { condition: "مستعمل" } });
  const list = await turn(promoter, "اعرض لي إعلاناتي");
  const ids = list.payload.resourceIds as string[];
  const options = await turn(promoter, `روّج ${positionOf(ids, promotedId)}`);
  assert.equal(options.surface, "PROMOTION_OPTIONS", options.body);
  const review = await turn(promoter, "أسبوع");
  assert.equal(review.surface, "PROMOTION_REVIEW");
  assert.match(review.body, /7 أيام بسعر 2\.000 JOD/);
  // «روّج الإعلان الثاني لمدة 7 أيام»: listing 2, duration 7 — then cancelled.
  await turn(promoter, "اعرض لي إعلاناتي");
  const numbered = await turn(promoter, "روّج الإعلان الثاني لمدة 7 أيام");
  assert.equal(numbered.surface, "PROMOTION_REVIEW");
  assert.match(numbered.body, new RegExp((await offerOf(ids[1]!)).data.title as string));
  assert.match(numbered.body, /7 أيام/);
  await turn(promoter, "إلغاء");
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.sellerId, promoter.id))).filter((row) => row.status === "ACTIVE").length, 0);
  await turn(promoter, "اعرض لي إعلاناتي");
  await turn(promoter, `روّج ${positionOf(ids, promotedId)}`);
  await turn(promoter, "أسبوع");
  const confirmed = await turn(promoter, "تأكيد", { promotionPrice: 1, sponsored: true, commissionBps: 0 });
  assert.match(confirmed.body, /دون تحويل أموال حقيقية/);
  const [campaign] = await db.select().from(listingPromotions).where(and(eq(listingPromotions.listingId, promotedId), eq(listingPromotions.status, "ACTIVE")));
  assert.deepEqual([campaign!.paymentStatus, campaign!.priceMinorSnapshot, campaign!.durationDaysSnapshot], ["SIMULATION_CAPTURED", 2000, 7], "price from the plan, not the client");
});

await focused("F5-10", "sponsored results are labelled and never «best» because they paid", async () => {
  const found = await turn(shopper, "أريد ثريا");
  const sponsored = found.payload.listings.filter((listing: any) => listing.isSponsored).map((listing: any) => listing.id);
  assert.ok(sponsored.includes(promotedId), found.body);
  const labelled = found.payload.listings.filter((listing: any) => listing.id === promotedId).every((listing: any) => listing.isSponsored === true);
  assert.ok(labelled, "paid slot carries its label");
  const best = await turn(shopper, "أي واحد أفضل؟");
  assert.match(best.body, /الممولة لا تحصل على أي أفضلية/);
  assert.ok(best.payload.listings.every((listing: any) => !listing.isSponsored), "no paid slot in a chosen ranking");
  const order = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
  assert.equal(order.data.commissionRateBps, 1000, "promotion never changes order commission");
});

// ─── Employment and driver ───────────────────────────────────────────────────

await focused("F5-11", "«وظفني» → Block C candidate profile; facts reused; nothing applied or exposed", async () => {
  const start = await turn(candidate, "دينار وظفني");
  assert.equal(start.surface, "CV_PROFILE", start.body);
  assert.match(start.body, /مسماك المهني/);
  const facts = await turn(candidate, "أنا مصمم جرافيك وعندي خبرة 4 سنوات");
  assert.equal(facts.surface, "CV_PROFILE");
  const [profile] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidate.id));
  assert.match(profile!.professionalTitle ?? "", /مصمم جرافيك/);
  assert.equal(profile!.experienceYears, 4);
  assert.equal(profile!.visibility, "PRIVATE");
  assert.equal((await db.select().from(jobApplications).where(eq(jobApplications.candidateUserId, candidate.id))).length, 0, "no automatic application");
});

await focused("F5-12", "«أريد موظف …» → Block C employer job draft; nothing published or matched externally", async () => {
  const draft = await turn(employer, "أريد موظف Front-end في عمان خبرة سنتين");
  assert.equal(draft.surface, "JOB_DRAFT", draft.body);
  assert.equal((await db.select().from(jobs).where(eq(jobs.ownerUserId, employer.id))).length, 0, "a draft until the employer confirms");
});

await focused("F5-13", "DINAR driver onboarding and job search stay separate", async () => {
  const job = await turn(rival, "ابحث لي عن وظيفة سائق عند شركة");
  assert.equal(job.surface, "JOB_SEARCH_RESULTS");
  assert.equal((await db.select().from(driverProfiles).where(eq(driverProfiles.userId, rival.id))).length, 0);
  const onboarding = await turn(rival, "أريد أشتغل سائق مع دينار");
  assert.equal(onboarding.surface, "DRIVER_ONBOARDING", onboarding.body);
  assert.match(onboarding.body, /ما نوع مركبتك/, "only the missing vehicle is asked; the city came from the account");
  assert.equal(onboarding.payload.employment, undefined);
});

await focused("F5-14", "driver: onboarding → admin approval → «أنا متاح» → work → «أقبل الثاني» → Block D", async () => {
  assert.equal((await turn(driver, "أريد أشتغل سائق")).surface, "DRIVER_ONBOARDING");
  assert.equal((await turn(driver, "سيارة")).surface, "DRIVER_ONBOARDING_REVIEW");
  await turn(driver, "نعم");
  assert.equal((await approve(driver)).status, 200);
  assert.match((await turn(driver, "أنا متاح")).body, /أنت متاح الآن/);
  const work = [await courierOrder("طاولة أ"), await courierOrder("طاولة ب")];
  const list = await turn(driver, "اعرض لي توصيلات");
  const ids = (await setOf(list.payload.resultSetId)).resourceIds;
  assert.ok(work.every((id) => ids.includes(id)), list.body);
  const review = await turn(driver, "أقبل الثاني");
  assert.equal(review.payload.driver.card.id, ids[1]);
  assert.match((await turn(driver, "نعم")).body, /تم قبول مهمة التوصيل/);
  assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, ids[1]!)))[0]!.status, "ACCEPTED");
  await agreeCourierFare(ids[1]!, shopper, driver);
  const pickup = await turn(driver, "وصلت لمكان الاستلام");
  assert.match(pickup.body, /لم يتغير شيء/);
  const pickupRecorded = await turn(driver, "استلمت الطلب");
  assert.match(pickupRecorded.body, /استلام الطلب من البائع/);
  assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, ids[1]!)))[0]!.status, "ACCEPTED");
  await turn(driver, "أنا في الطريق");
  assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, ids[1]!)))[0]!.status, "OUT_FOR_DELIVERY");
  trackedOrderId = ids[1]!;
});

await focused("F5-14A", "orders: typed history, stable ordinals, truthful tracking and terminal stop", async () => {
  const list = await turn(shopper, "طلباتي");
  assert.equal(list.surface, "ORDERS_LIST");
  const stored = await setOf(list.payload.resultSetId);
  assert.deepEqual(stored.resourceIds, list.payload.resourceIds, "ordinals follow the server-stored order");
  assert.ok(stored.resourceIds.includes(trackedOrderId));

  const statusChoices = await turn(shopper, "أين طلبي؟");
  assert.equal(statusChoices.surface, "ORDER_SELECTOR");
  const statusChoice = await turn(shopper, "الثاني");
  assert.equal(statusChoice.surface, "ORDER_STATUS");
  assert.equal(statusChoice.payload.resourceId, statusChoices.payload.resourceIds[1]);

  const statusChoicesAgain = await turn(shopper, "وين طلبي؟");
  assert.equal(statusChoicesAgain.surface, "ORDER_SELECTOR");
  const statusChoiceAgain = await turn(shopper, "الثاني");
  assert.equal(statusChoiceAgain.surface, "ORDER_STATUS");
  assert.equal(statusChoiceAgain.payload.resourceId, statusChoicesAgain.payload.resourceIds[1]);

  const trackingChoices = await turn(shopper, "تتبع طلبي");
  assert.equal(trackingChoices.surface, "ORDER_SELECTOR");
  const trackingChoice = await turn(shopper, "الثاني");
  assert.equal(trackingChoice.surface, "ORDER_TRACKING");
  assert.equal(trackingChoice.payload.resourceId, trackingChoices.payload.resourceIds[1]);

  const driverChoices = await turn(shopper, "وين السائق؟");
  assert.equal(driverChoices.surface, "ORDER_SELECTOR", JSON.stringify(driverChoices));
  const driverChoice = await turn(shopper, "الثاني");
  assert.equal(driverChoice.surface, "ORDER_TRACKING");
  assert.equal(driverChoice.payload.resourceId, trackingChoices.payload.resourceIds[1]);

  const mapShown = await turn(shopper, "افتح الخريطة");
  assert.equal(mapShown.surface, "ORDER_TRACKING");
  assert.equal(mapShown.payload.resourceId, trackingChoice.payload.resourceId);
  assert.notEqual(mapShown.payload.hideMap, true);
  const mapHidden = await turn(shopper, "أخفِ الخريطة");
  assert.equal(mapHidden.surface, "ORDER_TRACKING");
  assert.equal(mapHidden.payload.resourceId, trackingChoice.payload.resourceId);
  assert.equal(mapHidden.payload.hideMap, true);

  const unavailable = await request(
    `/orders/${trackedOrderId}/tracking`,
    "GET",
    undefined,
    shopper.cookie,
  );
  assert.equal(unavailable.status, 200, unavailable.raw);
  assert.equal(unavailable.cacheControl.includes("no-store"), true);
  assert.equal(unavailable.data.delivery.status, "OUT_FOR_DELIVERY");
  assert.deepEqual(unavailable.data.tracking, {
    state: "UNAVAILABLE",
    reason: "NO_PROVIDER",
  });
  assert.equal("position" in unavailable.data.tracking, false, "no invented or cached location");
  assert.equal("eta" in unavailable.data.tracking, false, "no invented arrival estimate");
  await rejected(
    () => request(`/orders/${trackedOrderId}/tracking`, "GET", undefined, rival.cookie),
    [404],
    "nonparticipant tracking",
  );

  await db
    .update(orderFulfillments)
    .set({ status: "DELIVERED", updatedAt: new Date() })
    .where(eq(orderFulfillments.orderId, trackedOrderId));
  try {
    const stopped = await request(
      `/orders/${trackedOrderId}/tracking`,
      "GET",
      undefined,
      shopper.cookie,
    );
    assert.equal(stopped.data.tracking.state, "STOPPED", "terminal delivery never retrieves a location");
  } finally {
    await db
      .update(orderFulfillments)
      .set({ status: "OUT_FOR_DELIVERY", updatedAt: new Date() })
      .where(eq(orderFulfillments.orderId, trackedOrderId));
  }
});

await focused("F5-15", "one user, one chat: seller → buyer → seller → driver → employment, no mode switch", async () => {
  const surfaces: (string | undefined)[] = [];
  const say = async (message: string) => {
    const result = await turn(multi, message);
    surfaces.push(result.surface);
    return result;
  };
  await say("أريد أبيع هذه الطاولة بـ20");
  await say("ابحث لي عن تيشرت نايكي بـ5");
  await say("اعرض لي إعلاناتي");
  await say("أريد أشتغل سائق");
  await say("سيارة");
  await say("نعم");
  assert.equal((await approve(multi)).status, 200);
  await say("أنا متاح");
  await say("ابحث لي عن وظيفة مصمم");
  assert.deepEqual(surfaces, ["SELL", "LISTING_RESULTS", "MY_LISTINGS", "DRIVER_ONBOARDING", "DRIVER_ONBOARDING_REVIEW", "DRIVER_STATUS", "DRIVER_AVAILABILITY", "JOB_SEARCH_RESULTS"]);
  const conversations = await request("/ai/conversations", "GET", undefined, multi.cookie);
  assert.equal(conversations.data.conversations?.length ?? conversations.data.length, 1, "one chat");
});

// ─── Generality ──────────────────────────────────────────────────────────────

await focused("F5-16", "a service is sold and found through the generic listing and search authorities", async () => {
  const draft = await turn(rival, "أنا أصلح مكيفات، اعرض خدمتي بـ15");
  assert.equal(draft.surface, "SELL");
  assert.equal(draft.payload.draft.fulfilmentType, "SERVICE", "not asked again");
  assert.doesNotMatch(draft.body, /كيف يحصل المشتري/);
  const found = await turn(shopper, "أريد فني مكيفات");
  assert.ok(found.payload.listings.some((listing: any) => listing.id === L.ac), found.body);
  const detail = await turn(shopper, "الأول وش يقدم؟");
  assert.equal(detail.payload.presentation, "DETAILS");
  assert.equal(detail.payload.listings[0].id, L.ac);
  assert.equal(detail.payload.listings[0].fulfilmentType, "SERVICE");
  const before = (await countOwned(shopper)).orders;
  const next = await turn(shopper, "أبيه");
  assert.equal(next.surface, "PURCHASE_REVIEW");
  assert.equal(next.payload.purchaseReview.listingId, L.ac);
  assert.equal((await countOwned(shopper)).orders, before, "service intent opens a review; it does not create an order or booking");
});

await focused("F5-17", "food: a need is clarified; «رخيص» orders by price; ordinal and quantity stay distinct", async () => {
  const hungry = await turn(shopper, "أنا جائع");
  assert.equal(hungry.surface, "CLARIFY");
  const cheap = await turn(shopper, "أريد بروستد رخيص");
  const ids = cheap.payload.listings.map((listing: any) => listing.id);
  assert.ok(ids.includes(L.broast3) && ids.includes(L.broast4), cheap.body);
  const prices = cheap.payload.listings.map((listing: any) => Number(listing.unitPrice));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const pick = await turn(shopper, "الأول، أبي اثنين");
  assert.equal(pick.payload.purchaseReview.listingId, ids[0]);
  assert.equal(pick.payload.purchaseReview.quantity, 2);
  await turn(shopper, "إلغاء");
});

await focused("F5-18", "vehicles: structured filters, cheapest, best value with a raised ceiling", async () => {
  const found = await turn(shopper, "أريد برادو من 2020 وفوق أقل من 15 ألف");
  const ids = found.payload.listings.map((listing: any) => listing.id);
  assert.deepEqual([...ids].sort(), [L.prado2020, L.prado2021].sort(), found.body);
  const cheapest = await turn(shopper, "الأرخص");
  assert.equal(cheapest.payload.listings[0].id, L.prado2020);
  const raised = await turn(shopper, "لا، الأفضل حتى لو أغلى ألف");
  assert.match(raised.body, /16000/);
  assert.ok(raised.payload.listings.some((listing: any) => listing.id === L.prado2022), "the raised ceiling admits the 16,000 one");
  assert.ok(!raised.payload.listings.some((listing: any) => listing.id === L.prado2018), "the year filter still holds");
});

await focused("F5-19", "a generic «other» product uses the generic draft; no domain-specific agents exist", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, rival.cookie)).data.id;
  const draft = await turn({ ...rival, conv }, "أريد أبيع قطعة غريبة للمنزل بـ3");
  assert.equal(draft.surface, "SELL");
  assert.equal(draft.payload.draft.categoryId, "home", "«للمنزل» is the home category, not real estate");
  assert.equal(draft.payload.draft.unitPrice, "3");
  const files = await readdir("src/ai");
  const agents = files.filter((file) => /(?:seller|buyer|driver|vehicle|food|promotion|service)[-_]?agent/i.test(file));
  assert.deepEqual(agents, []);
});

// ─── Cross-cutting ───────────────────────────────────────────────────────────

await focused("F5-20", "a stale «نعم» never crosses a topic change: publish, purchase, promotion, assignment", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, rival.cookie)).data.id;
  const r = { ...rival, conv };
  await turn(r, "أريد أبيع آيفون 13 نظيف بـ200");
  for (const answer of ["قطعة واحدة", CITY, "محادثة فقط", "كاش"]) await turn(r, answer);
  assert.match((await turn(r, "انشره")).body, /هل تريد نشر/);
  await turn(r, "ابحث لي عن تيشرت");
  await turn(r, "نعم");
  assert.equal((await db.select().from(offers).where(eq(offers.sellerId, rival.id))).filter((row) => row.status === "PUBLISHED").length, 0, "no stale publication");
  // Purchase.
  const list = await turn(r, "أريد تيشرت نايكي مميز بـ5");
  await turn(r, `أبي ${positionOf(list.payload.listings.map((listing: any) => listing.id), L.teeBlack5)}`);
  await turn(r, "اطلبه الآن");
  await turn(r, "ابحث لي عن ثريا");
  await turn(r, "نعم");
  assert.equal((await db.select().from(orders).where(eq(orders.buyerId, rival.id))).length, 0, "no stale order");
  // Promotion.
  const promoConv = (await request("/ai/conversations", "POST", {}, promoter.cookie)).data.id;
  const p = { ...promoter, conv: promoConv };
  const mine = await turn(p, "اعرض لي إعلاناتي");
  const other = (mine.payload.resourceIds as string[]).find((id) => id !== promotedId)!;
  await turn(p, `روّج ${positionOf(mine.payload.resourceIds, other)}`);
  await turn(p, "أسبوع");
  await turn(p, "ابحث لي عن تيشرت");
  await turn(p, "تأكيد");
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.listingId, other))).length, 0, "no stale campaign");
  // Driver assignment.
  const open = await courierOrder("طاولة ج");
  const work = await turn(driver, "اعرض لي توصيلات");
  await turn(driver, `أقبل ${positionOf((await setOf(work.payload.resultSetId)).resourceIds, open)}`);
  await turn(driver, "ابحث لي عن تيشرت");
  await turn(driver, "نعم");
  assert.equal((await db.select().from(deliveryAssignments).where(eq(deliveryAssignments.orderId, open))).length, 0, "no stale assignment");
});

await focused("F5-21", "reload restores seller, buyer, purchase, promotion and driver state from server rows", async () => {
  const blocksOf = async (actor: Actor, conversationId = actor.conv) =>
    (await request(`/ai/conversations/${conversationId}`, "GET", undefined, actor.cookie)).data.messages.flatMap((message: any) => message.blocks);
  assert.ok((await blocksOf(seller)).some((block: any) => block.payload.draft?.draftId), "listing drafts");
  const buyerBlocks = await blocksOf(buyer);
  assert.ok(buyerBlocks.some((block: any) => block.type === "LISTING_RESULTS" && block.payload.listings.some((listing: any) => listing.recommendationReasons)), "ranked results");
  assert.ok(buyerBlocks.some((block: any) => block.payload.purchaseReview?.stage === "ORDER" && block.payload.purchaseReview.status === "CONFIRMED"), "purchase review status");
  assert.ok(buyerBlocks.some((block: any) => block.payload.surface === "PAYMENT_REVIEW" && block.payload.purchaseReview.selectedPaymentMethod === "CASH_DIRECT"), "cash choice restored from server rows");
  assert.ok((await blocksOf(promoter)).some((block: any) => block.payload.surface === "PROMOTION_REVIEW"), "promotion review");
  assert.ok((await blocksOf(driver)).some((block: any) => block.payload.surface === "DELIVERY_WORK_RESULTS" && block.payload.driver.work.length), "driver work");
  const context = await conversationContext({ conversationId: buyer.conv, actorId: buyer.id, market: JO });
  assert.ok(context.currentResultSet?.resourceIds.length, "context rebuilt from server rows");
});

await focused("F5-22", "injected failures never become success messages", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, candidate.cookie)).data.id;
  const c = { ...candidate, conv };
  // Listing publish: the draft carries an image the storage authority cannot verify.
  await imageTurn(c, "أريد أبيع هذا", []);
  await turn(c, "هذا آيفون 12 نظيف بـ150");
  for (const answer of ["قطعة واحدة", CITY, "محادثة فقط", "كاش"]) await turn(c, answer);
  await turn(c, "انشره");
  const failedPublish = await turn(c, "نعم");
  assert.doesNotMatch(failedPublish.body, /تم نشر الإعلان/);
  // Listing update on an archived listing.
  await turn(seller, "اعرض لي إعلاناتي");
  // Order creation with a suspended seller.
  const list = await turn(c, "أريد تيشرت نايكي مميز بـ5");
  await turn(c, `أبي ${positionOf(list.payload.listings.map((listing: any) => listing.id), L.teeBlack7)}`);
  await turn(c, "اطلبه الآن");
  await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, sideSeller.id));
  const failedOrder = await turn(c, "نعم");
  await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, sideSeller.id));
  assert.doesNotMatch(failedOrder.body, /تم إنشاء الطلب/);
  // Payment with the simulation authority switched off.
  const saved = process.env.BDINAR_WAVE4_ACCEPTANCE;
  process.env.BDINAR_WAVE4_ACCEPTANCE = "off";
  const failedPay = await turn(buyer, "ادفع");
  process.env.BDINAR_WAVE4_ACCEPTANCE = saved;
  assert.doesNotMatch(failedPay.body, /طلب دفع تجريبي لطلب|تم الدفع/);
  // Promotion activation after the plan is withdrawn between review and confirmation.
  const promoConv = (await request("/ai/conversations", "POST", {}, promoter.cookie)).data.id;
  const p = { ...promoter, conv: promoConv };
  const mine = await turn(p, "اعرض لي إعلاناتي");
  const other = (mine.payload.resourceIds as string[]).find((id) => id !== promotedId)!;
  await turn(p, `روّج ${positionOf(mine.payload.resourceIds, other)}`);
  await turn(p, "أسبوع");
  await db.update(promotionProducts).set({ enabled: false }).where(eq(promotionProducts.categoryId, "other"));
  const failedPromo = await turn(p, "تأكيد");
  await db.update(promotionProducts).set({ enabled: true }).where(eq(promotionProducts.categoryId, "other"));
  assert.doesNotMatch(failedPromo.body, /وتفعيل ترويج/);
  // Driver availability for a pending profile; assignment of taken work.
  await turn(rival, "نعم");
  assert.doesNotMatch((await turn(rival, "أنا متاح")).body, /أنت متاح الآن/);
  console.log("F5_FALSE_SUCCESS", JSON.stringify(falses));
  assert.deepEqual(falses, { listing: 0, listingUpdate: 0, order: 0, payment: 0, promotion: 0, availability: 0, assignment: 0 });
});

await focused("F5-23", "cross-user and client-authority attacks are rejected or ignored", async () => {
  const sellerPending = await (async () => {
    await turn(seller, "اعرض لي إعلاناتي");
    return createPendingAction({ conversationId: seller.conv, actorId: seller.id, market: JO, proposal: proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: (await db.select().from(offers).where(and(eq(offers.sellerId, seller.id), eq(offers.status, "PUBLISHED"))))[0]!.id, facts: { price: [{ value: "1", source: "USER_DECLARED" }] } }) });
  })();
  await rejected(() => confirmPendingAction({ actionId: sellerPending.actionId, actorId: rival.id, market: JO, decision: "CONFIRM" }), [404], "use A's pending confirmation");
  await rejected(() => createPendingAction({ conversationId: rival.conv, actorId: rival.id, market: JO, proposal: proposeAction({ action: "UPDATE_LISTING_PRICE", targetResource: promotedId, facts: { price: [{ value: "1", source: "USER_DECLARED" }] } }) }), [409], "edit A's listing");
  const [aDraft] = (await db.select().from(aiUiBlocks).where(and(eq(aiUiBlocks.conversationId, seller.conv), sql`${aiUiBlocks.payload}->'draft'->>'draftId' is not null`))).slice(-1);
  const draftId = (aDraft!.payload as any).draft.draftId;
  assert.equal(await readDraftSnapshot(rival.id, draftId), undefined, "B cannot read A's draft");
  await rejected(() => createPendingAction({ conversationId: rival.conv, actorId: rival.id, market: JO, proposal: proposeAction({ action: "PUBLISH_LISTING", targetResource: draftId }) }), [409], "resume/publish A's draft");
  await rejected(() => request(`/ai/conversations/${buyer.conv}`, "GET", undefined, rival.cookie), [404], "read A's result sets");
  await rejected(() => request(`/ai/conversations/${buyer.conv}/turns`, "POST", { message: "نعم" }, rival.cookie), [404], "act in A's chat");
  await rejected(() => request(`/orders/${orderId}/fulfillment`, "GET", undefined, rival.cookie), [404], "A's delivery");
  await rejected(async () => request(`/admin/drivers/${(await db.select().from(driverProfiles).where(eq(driverProfiles.userId, driver.id)))[0]!.id}/review`, "POST", { decision: "SUSPEND" }, rival.cookie), [403], "change A's driver status");
  await rejected(() => createPendingAction({ conversationId: rival.conv, actorId: rival.id, market: JO, proposal: proposeAction({ action: "ACCEPT_DELIVERY", targetResource: randomUUID() }) }), [409], "invented delivery id");
  await rejected(() => createPendingAction({ conversationId: rival.conv, actorId: rival.id, market: JO, proposal: proposeAction({ action: "ADD_TO_CART", targetResource: `invented-${runId}`, facts: { quantity: [{ value: 1, source: "USER_DECLARED" }] } }) }), [409], "invented listing id");
  await rejected(() => createPendingAction({ conversationId: rival.conv, actorId: rival.id, market: JO, proposal: proposeAction({ action: "CREATE_PAYMENT_INTENT", targetResource: randomUUID() }) }), [409], "invented order id");
  await rejected(() => confirmPendingAction({ actionId: randomUUID(), actorId: rival.id, market: JO, decision: "CONFIRM" }), [404], "invented action id");
  await rejected(() => request("/payments/intents", "POST", { orderId, amountMinor: 1, paymentStatus: "SUCCESS" }, buyer.cookie, { "Idempotency-Key": `f5-${randomUUID()}` }), [400, 404], "paid / amount override");
  // Identity and authority fields in a turn body are ignored.
  const spoof = { ownerId: seller.id, sellerId: seller.id, buyerId: seller.id, driverId: driver.id, approved: true, paid: true, paymentStatus: "SUCCESS", sponsored: true, promotionPrice: 1, commissionBps: 0, marketId: "KW" };
  await turn(rival, "أنا متاح", spoof);
  assert.notEqual((await db.select().from(driverProfiles).where(eq(driverProfiles.userId, rival.id)))[0]?.status, "APPROVED");
  assert.equal((await db.select().from(users).where(eq(users.id, rival.id)))[0]!.activeMarketId, "JO");
  console.log("F5_ATTACKS", JSON.stringify(attacks));
  assert.equal(attacks.failed, 0);
});

await focused("F5-24", "privacy audit over every stored conversation row", async () => {
  const [blocks, sets, assistant] = await Promise.all([db.select().from(aiUiBlocks), db.select().from(aiResultSets), db.select().from(messages).where(eq(messages.actor, "ASSISTANT"))]);
  const stored = JSON.stringify([blocks, sets, assistant]);
  const people = [seller, buyer, promoter, shopper, multi, driver, rival, candidate, employer, sideSeller];
  const userRows = await db.select().from(users).where(inArray(users.id, people.map((person) => person.id)));
  const intents = await db.select().from(paymentIntents);
  const leaks = {
    authPhones: [...people.map((person) => person.phone), ...userRows.map((row) => row.normalizedPhone)].filter((value) => value && stored.includes(value)).length,
    preciseLocation: ["31.955555", "35.944444"].filter((value) => stored.includes(value)).length,
    privateAddress: stored.includes(`شارع خاص ${runId}`) ? 1 : 0,
    paymentSecrets: intents.filter((row) => stored.includes(row.providerIntentId)).length,
    candidatePrivate: 0,
  };
  // Another user's view of a private candidate never contains the profile.
  const found = await turn(employer, "ابحث عن مصمم جرافيك خبرة 3 سنوات");
  if (JSON.stringify(found.payload).includes(candidate.id) || /مصمم جرافيك/.test(JSON.stringify(found.payload.employment?.candidates ?? []))) leaks.candidatePrivate++;
  const locations = await db.select().from(transactionLocations).where(eq(transactionLocations.orderId, orderId));
  assert.equal(locations.length, 1, "the precise reading lives only on its order");
  console.log("F5_PRIVACY", JSON.stringify(leaks));
  assert.deepEqual(leaks, { authPhones: 0, preciseLocation: 0, privateAddress: 0, paymentSecrets: 0, candidatePrivate: 0 });
});

let browserReport: any;
await focused("F5-25", "deterministic commands use no model; connected UI journeys at 320/360/390/414", async () => {
  const total = modelCalls.reduce((sum, item) => sum + item.calls, 0);
  console.log("F5_MODEL_CALLS", JSON.stringify({ total, phrases: modelCalls.length }));
  assert.equal(total, 0, JSON.stringify(modelCalls.filter((item) => item.calls)));
  const web = await startDinarBrowserTestWeb(`http://127.0.0.1:${port}`);
  const resultPath = `/tmp/dinar-f5-ui-${runId}.json`;
  const uiBuyer = await register("UI Buyer");
  const uiSeller = await register("UI Seller");
  const uiDriver = await register("UI Driver");
  const uiCandidate = await register("UI Candidate");
  const uiListingIds = [
    await publish(uiSeller, `ثريا كريستال ${runId}`, "40", { attributes: { condition: "جديد" } }),
    await publish(uiSeller, `ثريا كريستال صغيرة ${runId}`, "35", { attributes: { condition: "مستعمل" } }),
  ];
  await courierOrder("طاولة واجهة");
  // The UI driver is approved by the administrator path before the browser session.
  for (const message of ["أريد أشتغل سائق", "سيارة", "نعم"]) await turn(uiDriver, message);
  assert.equal((await approve(uiDriver)).status, 200);
  assert.match((await turn(uiDriver, "أنا متاح")).body, /أنت متاح الآن/);
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/block-f5-ui-acceptance.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        F5_WEB_BASE: web.baseUrl,
        F5_API_ORIGIN: `http://127.0.0.1:${port}`,
        F5_BUYER_COOKIE: uiBuyer.cookie,
        F5_SELLER_COOKIE: uiSeller.cookie,
        F5_DRIVER_COOKIE: uiDriver.cookie,
        F5_CANDIDATE_COOKIE: uiCandidate.cookie,
        F5_UI_LISTING_IDS: JSON.stringify(uiListingIds),
        F5_SELLER_COOKIES: JSON.stringify(Object.fromEntries(
          [seller, sideSeller, promoter, shopper, multi, uiSeller].map((actor) => [actor.id, actor.cookie]),
        )),
        F5_RUN_ID: runId,
        F5_CITY: CITY,
        F5_UI_RESULT_PATH: resultPath,
      },
      timeout: 900_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  try {
    browserReport = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    browserReport = undefined;
  }
  console.log("F5_BROWSER", JSON.stringify({ ...browserReport, checks: browserReport?.checks?.length }));
  if (browserError && !browserReport) throw browserError;
  assert.equal(browserReport.failure, undefined, browserReport.failure);
  assert.deepEqual(browserReport.pageErrors, []);
  assert.deepEqual(browserReport.consoleErrors, []);
  assert.equal(browserReport.horizontalOverflow, 0);
  assert.deepEqual(browserReport.externalRequests, []);
  assert.ok(
    (browserReport.runtimeEvents ?? []).every((event: any) =>
      event.type === "error" &&
      event.message === "ResizeObserver loop completed with undelivered notifications.",
    ),
    `unexpected browser runtime events: ${JSON.stringify(browserReport.runtimeEvents)}`,
  );
});

await focused("F5-26", "an empty internal search persists a real empty result set", async () => {
  const conversation = await request("/ai/conversations", "POST", {}, buyer.cookie);
  const conversationId = conversation.data.id as string;
  const absent = `W2Absent${randomUUID().replaceAll("-", "")}`;
  const empty = await turn(buyer, `أبحث عن كرسي ${absent}`, {}, conversationId);
  assert.equal(empty.surface, "LISTING_RESULTS");
  assert.deepEqual(empty.payload.listings, []);
  assert.equal(empty.payload.presentation, "RESULTS");
  assert.match(empty.body, /لم أجد|لا توجد/);
  const resultSet = await setOf(empty.payload.resultSetId);
  assert.deepEqual(resultSet.resourceIds, []);
});

await test("summary", async () => {
  const keys = Object.keys(results).sort();
  const summary = {
    passed: keys.filter((id) => results[id] === "PASS").length,
    total: keys.length,
    results,
    modelCalls: modelCalls.reduce((sum, item) => sum + item.calls, 0),
    externalCalls: external.length,
    attacks,
    falses,
  };
  console.log("BLOCKF5_SUMMARY", JSON.stringify(summary));
  assert.equal(summary.externalCalls, 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
