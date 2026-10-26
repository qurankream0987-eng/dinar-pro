import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { aiResultSets, aiUiBlocks, conversations, db, markets, messages, offers, pool } from "@workspace/db";
import { resolveMarket } from "../src/lib/markets";
import { executeAiConversationTurn } from "../src/ai/conversation-runtime";
import { DeterministicPhotoSuggestionProvider } from "../src/ai/listing-photo-intelligence";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `s${randomUUID().replaceAll("-", "").slice(0, 7)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.19.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
// Kuwaiti numbers from 51,800,000 up are invalid: the range stays below it.
const phoneBase = 51_400_000 + ((Date.now() + process.pid) % 300_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `BlockF1-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F1 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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

/**
 * Photo uploads need Object Storage (provider boundary), so an image turn runs through the
 * same shared runtime with a deterministic image provider, and is stored in the same
 * conversation tables the turn route writes.
 */
async function imageTurn(actor: Actor, conversationId: string, message: string, suggestions: unknown[]): Promise<Turn> {
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const imagePath = `/objects/uploads/${randomUUID()}`;
  const userMessageId = randomUUID();
  await db.insert(messages).values({ id: userMessageId, conversationId, senderId: actor.id, body: message, actor: "USER", contentType: "TEXT", metadata: { turnStatus: "completed", imageObjectPaths: [imagePath] } });
  const execution = await executeAiConversationTurn(
    { conversationId, currentMessageId: userMessageId, message, market: await resolveMarket(row!), actorId: actor.id, imageObjectPaths: [imagePath] },
    { photoSuggestionProvider: new DeterministicPhotoSuggestionProvider(suggestions.map((item: any) => ({ ...item, imageObjectPath: imagePath }))) },
  );
  const result = execution.result;
  const payload = {
    resultSetId: randomUUID(), listings: [], surface: result.surface, draft: result.draft, draftStep: result.draftStep, draftReview: result.draftReview,
    photoSuggestionStatus: result.photoSuggestionStatus, photoSuggestions: result.photoSuggestions,
  };
  const assistantId = randomUUID();
  await db.insert(messages).values({ id: assistantId, conversationId, body: result.prompt ?? "", actor: "ASSISTANT", contentType: "TEXT" });
  await db.insert(aiUiBlocks).values({ id: randomUUID(), conversationId, messageId: assistantId, blockType: "SURFACE", version: 1, payload, ordinal: 0 });
  return { body: result.prompt ?? "", payload };
}

async function publish(seller: Actor, title: string, price: string, categoryId = "other", category = "أخرى", extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `اختبار F1 ${runId} ${title}`, category, categoryId, area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], ...extra,
  }, seller.cookie);
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

/** Shown 1-based position of a listing in the latest «إعلاناتي» list (archived rows are listed too). */
const at = (ids: string[], id: string) => ids.indexOf(id) + 1;
const offer = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const field = (review: any, name: string) => review.fields.find((item: any) => item.field === name);
let seller: Actor;
let rival: Actor;
const L: string[] = [];
let conv = "";
let imageConv = "";
async function myListings(conversationId = conv, actor = seller) {
  const shown = await turn(actor, conversationId, "اعرض لي إعلاناتي");
  assert.equal(shown.payload.surface, "MY_LISTINGS", shown.body);
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, shown.payload.resultSetId));
  return set!.resourceIds;
}

await test("setup: fresh sellers, listings and DINAR comparables", async () => {
  [seller, rival] = await Promise.all(["Seller", "Rival"].map(register));
  // Seller's own listings, oldest first.
  for (const [title, price] of [["مزهرية زجاج", "10"], ["مزهرية خزف", "20"], ["مزهرية نحاس", "30"]] as const) L.push(await publish(seller, title, price));
  // Another seller's comparable items: the only source of price guidance.
  for (const price of ["250", "270", "280"]) await publish(rival, `آيفون 14 برو ${runId}`, price, "electronics", "إلكترونيات");
  for (const price of ["12", "15", "18"]) await publish(rival, `مزهرية ملونة`, price);
  conv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id;
  imageConv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id;
});

await focused("F1-01", "an image starts a provisional draft; image facts stay unconfirmed", async () => {
  const first = await imageTurn(seller, imageConv, "أريد أبيع هذا", [
    { field: "category", value: "cars", confidence: 0.82 },
    { field: "storage", value: "256", confidence: 0.9 },
    { field: "authenticity", value: "أصلي", confidence: 0.9 },
  ]);
  assert.equal(first.payload.surface, "SELL");
  assert.equal(first.payload.draft.title, undefined, "no title invented from an image");
  assert.equal(first.payload.draft.unitPrice, undefined, "no price invented");
  assert.equal(first.payload.draft.categoryId, undefined, "the image's category stays a suggestion");
  const category = field(first.payload.draftReview, "category");
  assert.deepEqual([category.value, category.source, category.needsConfirmation], ["سيارات", "IMAGE_INFERRED", true]);
  const serialized = JSON.stringify(first.payload);
  assert.doesNotMatch(serialized, /storage|authenticity|أصلي/, "forbidden image facts are never kept");
  assert.ok(first.payload.draftReview.missingFields.some((item: any) => item.field === "category"));
  assert.deepEqual(first.payload.draftReview.actions, ["EDIT", "CANCEL"], "no publish while required fields are missing");
});

await focused("F1-02", "complete input is not asked again; «اعرض هذا بـX» edits the same draft", async () => {
  const draftConv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id;
  const first = await imageTurn(seller, draftConv, "أريد أبيع آيفون 14 برو 256 نظيف بـ290 وهذه صورته", []);
  const draft = first.payload.draft;
  assert.equal(draft.unitPrice, "290");
  assert.match(draft.title, /آيفون 14 برو 256/);
  assert.match(draft.description, /نظيف/);
  assert.equal(draft.categoryId, "electronics");
  const missing = first.payload.draftReview.missingFields.map((item: any) => item.field);
  for (const asked of ["title", "price", "description", "category"]) assert.ok(!missing.includes(asked), `${asked} is not asked again`);
  assert.ok(!["title", "price", "description"].includes(first.payload.draftStep));
  assert.equal(field(first.payload.draftReview, "unitPrice").source, "USER_DECLARED");
  assert.equal(field(first.payload.draftReview, "category").source, "DINAR_DERIVED");
  const edited = await turn(seller, draftConv, "اعرض هذا بـ300");
  assert.equal(edited.payload.surface, "SELL");
  assert.equal(edited.payload.draft.draftId, draft.draftId, "same draft, not a new one");
  assert.equal(edited.payload.draft.unitPrice, "300");
  assert.equal(edited.payload.draft.imageUrl, draft.imageUrl, "the photo stays attached");
  // Price guidance for the draft: DINAR listings only; the draft price is unchanged.
  const advice = await turn(seller, draftConv, "كم أحط سعر؟");
  assert.equal(advice.payload.surface, "SELL");
  assert.equal(advice.payload.draft.draftId, draft.draftId);
  assert.equal(advice.payload.draft.unitPrice, "300");
  assert.deepEqual(
    [advice.payload.sellerInsight.count, advice.payload.sellerInsight.min, advice.payload.sellerInsight.max, advice.payload.sellerInsight.median, advice.payload.sellerInsight.source],
    [3, 250, 280, 270, "DINAR_ONLY"],
  );
  assert.match(advice.body, /وجدت 3 عروض مشابهة داخل DINAR\. النطاق 250–280 JOD\. الوسيط 270/);
  assert.match(advice.body, /لم أغيّر السعر/);
  assert.equal(edited.payload.draftReview.actions.includes("PUBLISH"), edited.payload.draftReview.missingFields.length === 0);
});

await focused("F1-03", "an explicit seller correction overrides the image guess", async () => {
  const carConv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id;
  const first = await imageTurn(seller, carConv, "أريد أبيع سيارة تويوتا", [{ field: "color", value: "أزرق", confidence: 0.7 }]);
  assert.equal(first.payload.draft.categoryId, "cars");
  const guessed = field(first.payload.draftReview, "attributes.color");
  assert.deepEqual([guessed.value, guessed.source, guessed.needsConfirmation], ["أزرق", "IMAGE_INFERRED", true]);
  assert.equal(first.payload.draft.attributes?.color, undefined, "the guess is not written into the draft");
  const corrected = await turn(seller, carConv, "اللون أسود");
  const color = field(corrected.payload.draftReview, "attributes.color");
  assert.deepEqual([color.value, color.source, color.needsConfirmation], ["أسود", "USER_DECLARED", false]);
  assert.equal(corrected.payload.draft.sources["attributes.color"], "USER_DECLARED");
});

await focused("F1-04", "«هذه القطعة» edits the selected listing with old and new price", async () => {
  const ids = await myListings();
  const selected = await turn(seller, conv, "الثاني");
  assert.equal(selected.payload.resourceId, ids[1]);
  const preview = await turn(seller, conv, "اجعل سعر هذه القطعة 5 بدل 20");
  const management = preview.payload.managementPreview;
  assert.deepEqual([management.listingId, management.beforeValue, management.afterValue, management.status], [ids[1], "20.000", "5.000", "PENDING"]);
  assert.equal((await offer(ids[1]!)).unitPriceMinor, 20_000, "nothing changes before confirmation");
  const done = await turn(seller, conv, "نعم");
  assert.match(done.body, /تم تنفيذ التغيير/);
  assert.equal((await offer(ids[1]!)).unitPriceMinor, 5_000);
});

await focused("F1-05", "MY_LISTINGS ordinals: price, pause and resume by stable identity", async () => {
  let ids = await myListings();
  const price = await turn(seller, conv, "غير سعر الثاني إلى 7");
  assert.deepEqual([price.payload.managementPreview.listingId, price.payload.managementPreview.afterValue], [ids[1], "7.000"]);
  await turn(seller, conv, "نعم");
  assert.equal((await offer(ids[1]!)).unitPriceMinor, 7_000);
  ids = await myListings();
  const pause = await turn(seller, conv, "وقف الأول");
  assert.deepEqual([pause.payload.managementPreview.listingId, pause.payload.managementPreview.action], [ids[0], "PAUSE"]);
  await turn(seller, conv, "نعم");
  assert.equal((await offer(ids[0]!)).status, "PAUSED");
  ids = await myListings();
  const resume = await turn(seller, conv, "رجع الأول");
  assert.deepEqual([resume.payload.managementPreview.listingId, resume.payload.managementPreview.action], [ids[0], "RESUME"]);
  await turn(seller, conv, "نعم");
  assert.equal((await offer(ids[0]!)).status, "PUBLISHED");
});

await focused("F1-06", "sold/remove archives after confirmation; history is kept", async () => {
  let ids = await myListings();
  const oldest = await turn(seller, conv, "الإعلان القديم اتباع، شيله");
  assert.equal(oldest.payload.managementPreview.listingId, L[0], "«القديم» is the seller's oldest active listing");
  await turn(seller, conv, "لا");
  assert.equal((await offer(L[0]!)).status, "PUBLISHED");
  ids = await myListings();
  const sold = await turn(seller, conv, `الإعلان رقم ${at(ids, L[2]!)} اتباع، شيله`);
  const management = sold.payload.managementPreview;
  assert.deepEqual([management.listingId, management.action, management.fieldLabel], [L[2], "ARCHIVE", "الحالة"]);
  assert.match(management.afterValue, /تم البيع/);
  assert.equal((await offer(L[2]!)).status, "PUBLISHED", "confirmation comes first");
  await turn(seller, conv, "نعم");
  const archived = await offer(L[2]!);
  assert.equal(archived.status, "ARCHIVED");
  assert.ok(archived.data.title, "the listing row and its history remain");
  // A buyer-style question is never read as a seller marking a sale.
  const question = await turn(rival, (await request("/ai/conversations", "POST", {}, rival.cookie)).data.id, "هل الثاني تم بيعه؟");
  assert.equal(question.payload?.managementPreview, undefined);
});

await focused("F1-07", "quantity changes go through the inventory authority", async () => {
  let ids = await myListings();
  const more = await turn(seller, conv, "زود كمية الثاني إلى 6");
  assert.deepEqual([more.payload.managementPreview.listingId, more.payload.managementPreview.beforeValue, more.payload.managementPreview.afterValue], [ids[1], "4", "6"]);
  await turn(seller, conv, "نعم");
  assert.equal((await offer(ids[1]!)).availableQuantity, 6);
  ids = await myListings();
  await turn(seller, conv, `الإعلان رقم ${at(ids, L[0]!)}`);
  const stock = await turn(seller, conv, "عندي 6 قطع بدل 4");
  assert.deepEqual([stock.payload.managementPreview.listingId, stock.payload.managementPreview.afterValue], [L[0], "6"]);
  await turn(seller, conv, "نعم");
  assert.equal((await offer(L[0]!)).availableQuantity, 6);
});

await focused("F1-08", "price guidance and «why not selling» use DINAR facts only and change nothing", async () => {
  let ids = await myListings();
  const before = await offer(L[0]!);
  const advice = await turn(seller, conv, `كم أحط سعر الإعلان رقم ${at(ids, L[0]!)}؟`);
  const insight = advice.payload.sellerInsight;
  assert.equal(insight.kind, "PRICE_SUGGESTION");
  assert.equal(insight.listingId, L[0]);
  assert.deepEqual([insight.count, insight.min, insight.max, insight.median, insight.source], [3, 12, 18, 15, "DINAR_ONLY"]);
  assert.equal((await offer(L[0]!)).unitPriceMinor, before.unitPriceMinor, "price is never changed automatically");
  ids = await myListings();
  const why = await turn(seller, conv, `ليش الإعلان رقم ${at(ids, L[0]!)} ما ينباع؟`);
  assert.equal(why.payload.sellerInsight.listingId, L[0]);
  assert.equal(why.payload.sellerInsight.kind, "LISTING_FACTORS");
  assert.match(why.body, /لا يمكنني تأكيد سبب عدم البيع/);
  assert.match(why.body, /قد يكون أحد العوامل: لا توجد صور/);
  assert.match(why.body, /لا يوجد ترويج نشط حاليًا/);
  assert.match(why.body, /لا تتوفر لدي بيانات مشاهدات/);
  assert.doesNotMatch(why.body, /بسبب|السبب هو|لأن سعرك/);
  for (const factor of why.payload.sellerInsight.factors)
    if (factor.kind === "POSSIBLE_FACTOR") assert.match(factor.text, /^قد يكون أحد العوامل/);
});

await focused("F1-09", "an ambiguous contextual edit asks which listing", async () => {
  await myListings();
  const before = await Promise.all(L.map(offer));
  const asked = await turn(seller, conv, "اجعل سعر هذه القطعة 5");
  assert.equal(asked.payload.managementPreview, undefined);
  assert.match(asked.body, /حدّد إعلانًا/);
  const after = await Promise.all(L.map(offer));
  assert.deepEqual(after.map((row) => row.unitPriceMinor), before.map((row) => row.unitPriceMinor));
});

await focused("F1-10", "a stale confirmation is re-reviewed; a later unrelated «نعم» changes nothing", async () => {
  let ids = await myListings();
  const target = L[1]!;
  await turn(seller, conv, `غير سعر الإعلان رقم ${at(ids, target)} إلى 9`);
  // The listing changes through Block B after the review.
  assert.equal((await request(`/listings/${target}/status`, "PATCH", { action: "PAUSE" }, seller.cookie)).status, 200);
  assert.equal((await request(`/listings/${target}/status`, "PATCH", { action: "RESUME" }, seller.cookie)).status, 200);
  const again = await turn(seller, conv, "نعم");
  assert.match(again.body, /تغيّر الإعلان منذ المعاينة/);
  assert.equal(again.payload.managementPreview.status, "PENDING");
  assert.notEqual((await offer(target)).unitPriceMinor, 9_000, "the old confirmation did not execute");
  await turn(seller, conv, "نعم");
  assert.equal((await offer(target)).unitPriceMinor, 9_000);
  ids = await myListings();
  await turn(seller, conv, `غير سعر الإعلان رقم ${at(ids, target)} إلى 11`);
  await turn(seller, conv, "اعرض حملاتي"); // the conversation moves on to another surface
  const late = await turn(seller, conv, "نعم");
  assert.doesNotMatch(late.body, /تم تنفيذ التغيير/);
  assert.equal((await offer(target)).unitPriceMinor, 9_000);
});

await focused("F1-11", "another seller cannot reach these listings or previews", async () => {
  const rivalConv = (await request("/ai/conversations", "POST", {}, rival.cookie)).data.id;
  const before = await Promise.all(L.map(offer));
  const rivalIds = await myListings(rivalConv, rival);
  assert.ok(rivalIds.every((id) => !L.includes(id)), "MY_LISTINGS is owner-only");
  await turn(rival, rivalConv, "غير سعر الثاني إلى 1");
  await turn(rival, rivalConv, "نعم");
  await turn(rival, (await request("/ai/conversations", "POST", {}, rival.cookie)).data.id, "الإعلان الثالث اتباع، شيله");
  const shown = await myListings();
  const preview = await turn(seller, conv, `غير سعر الإعلان رقم ${at(shown, L[0]!)} إلى 3`);
  const foreign = await request(`/ai/listing-management-previews/${preview.payload.managementPreview.previewId}/action`, "POST", { action: "CONFIRM" }, rival.cookie);
  assert.equal(foreign.status, 404);
  await turn(seller, conv, "لا");
  const after = await Promise.all(L.map(offer));
  assert.deepEqual(after.map((row) => [row.unitPriceMinor, row.status]), before.map((row) => [row.unitPriceMinor, row.status]));
});

await focused("F1-12", "reload restores drafts, provenance and confirmations from the server", async () => {
  const history = await request(`/ai/conversations/${imageConv}`, "GET", undefined, seller.cookie);
  assert.equal(history.status, 200);
  const sell = history.data.messages.flatMap((message: any) => message.blocks).find((block: any) => block.payload.surface === "SELL");
  assert.equal(field(sell.payload.draftReview, "category").source, "IMAGE_INFERRED");
  const sellerHistory = await request(`/ai/conversations/${conv}`, "GET", undefined, seller.cookie);
  const previews = sellerHistory.data.messages.flatMap((message: any) => message.blocks).filter((block: any) => block.payload.managementPreview);
  assert.ok(previews.some((block: any) => block.payload.managementPreview.status === "CONFIRMED"));
  assert.ok(previews.some((block: any) => block.payload.managementPreview.status === "EXPIRED"));
  assert.ok(previews.every((block: any) => block.payload.managementPreview.status !== "PENDING"));
  const [owner] = await db.select().from(conversations).where(eq(conversations.id, conv));
  assert.equal(owner!.ownerUserId, seller.id);
});

await test("summary", async () => {
  const ids = Object.keys(results).sort();
  console.log("BLOCKF1_SUMMARY", JSON.stringify({ passed: ids.filter((id) => results[id] === "PASS").length, total: ids.length, results, modelCalls: getModelGatewayCallCount() }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
