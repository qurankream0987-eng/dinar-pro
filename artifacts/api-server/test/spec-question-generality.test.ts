/**
 * Generality of fact questions beyond cars and machines.
 *
 * The acceptance tests so far asked about mileage and operating hours. This suite proves the
 * same behaviour on categories those tests never used: a flat (bedrooms/area/bathrooms), a
 * jacket (season/audience), a laptop and a table (condition), and a house-cleaning service
 * whose seller filled no registered characteristic at all. Nothing here names a car or a
 * machine, and no rule here may know a product: the characteristics come from the category
 * registry (marketplace_categories.attributes) and from what the seller recorded.
 *
 * A recorded characteristic is answered from the record; an unrecorded one says so and opens
 * the existing inquiry review, unsent. A question the record cannot answer opens nothing
 * invented: it names the characteristic and offers the same review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, marketplaceInquiries } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_SC06_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `g${randomUUID().replaceAll("-", "").slice(0, 7)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", origin: base.replace("/api", "") } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.23.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_400_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Gen-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Gen ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
    confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
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
    headers: { "Content-Type": "application/json", Cookie: actor.cookie, origin: base.replace("/api", "") },
    body: JSON.stringify({ message, clientMessageId: randomUUID() }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } })
    .find((event: any) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  assert.equal(getModelGatewayCallCount() - before, 0, `model call for «${message}»`);
  return { body: complete.assistantMessage.body, payload: complete.assistantMessage.blocks[0]?.payload };
}

const listingIds = (payload: any) => (payload?.listings ?? []).map((listing: any) => listing.id);

async function publish(seller: Actor, spec: {
  title: string; price: string; categoryId: string; category: string; description: string;
  attributes: Record<string, unknown>; inventoryMode?: string;
}) {
  const title = `${spec.title} ${runId}`;
  const created = await request("/listings", "POST", {
    title, description: `${spec.description} ${runId}`,
    category: spec.category, categoryId: spec.categoryId, area: "خلدا", city: "عمان",
    attributes: spec.attributes,
    unitPrice: spec.price, inventoryMode: spec.inventoryMode ?? "LIMITED",
    availableQuantity: spec.inventoryMode === "UNLIMITED" ? undefined : 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return { id: created.data.id as string, title };
}

async function newConversation() {
  return (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;
}

async function sentTo(listingId: string) {
  return db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, listingId));
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

const seller = await register("seller");
const buyer = await register("buyer");

// Property: the registry records bedrooms, bathrooms and area; the first flat has no bathrooms.
const flat3 = await publish(seller, {
  title: "شقة مفروشة للإيجار في خلدا", price: "550", categoryId: "property", category: "عقارات",
  description: "شقة مفروشة للإيجار في خلدا، قريبة من الخدمات والمواصلات",
  attributes: { propertyType: "شقة", transactionType: "إيجار", bedrooms: 3, area: 120 },
});
const flat2 = await publish(seller, {
  title: "شقة صغيرة للإيجار في تلاع العلي", price: "380", categoryId: "property", category: "عقارات",
  description: "شقة صغيرة للإيجار في تلاع العلي، مناسبة لشخص واحد",
  attributes: { propertyType: "شقة", transactionType: "إيجار", bedrooms: 2, bathrooms: 1, area: 85 },
});
// Fashion: season recorded, audience not recorded.
const jacket = await publish(seller, {
  title: "جاكيت شتوي رجالي", price: "45", categoryId: "fashion", category: "أزياء",
  description: "جاكيت شتوي رجالي بحالة ممتازة",
  attributes: { condition: "جديد", season: "شتوي" },
});
// Electronics and home: only the registered condition, recorded differently.
const laptop = await publish(seller, {
  title: "لابتوب للبيع بحالة جيدة", price: "180", categoryId: "electronics", category: "إلكترونيات",
  description: "لابتوب مستعمل للبيع بحالة جيدة",
  attributes: { condition: "مستعمل" },
});
const table = await publish(seller, {
  title: "طاولة طعام خشبية", price: "70", categoryId: "home", category: "منزل",
  description: "طاولة طعام خشبية جديدة",
  attributes: { condition: "جديد" },
});
// Services: the registry has no characteristics; nothing but the listing itself is recorded.
const cleaning = await publish(seller, {
  title: "خدمة تنظيف منازل", price: "25", categoryId: "services", category: "خدمات",
  description: "خدمة تنظيف منازل بالطلب",
  attributes: {}, inventoryMode: "UNLIMITED",
});

await focused("GEN-1", "a recorded property characteristic is answered from the record", async () => {
  const conv = await newConversation();
  const found = await turn(buyer, conv, `أريد شقة للإيجار ${runId}`);
  const foundIds = listingIds(found.payload);
  assert.ok(foundIds.includes(flat3.id) && foundIds.includes(flat2.id), `both flats are found: ${found.body}`);
  assert.notEqual(found.payload?.surface, "INQUIRY_DRAFT", "a search is not a question");
  const first = foundIds[0] === flat3.id ? flat3 : flat2;
  const recorded = first === flat3 ? { bedrooms: 3, area: 120 } : { bedrooms: 2, area: 85 };
  const bedrooms = await turn(buyer, conv, "كم غرفة نوم في الأولى؟");
  assert.match(bedrooms.body, /غرف النوم/u, `the answer names the recorded characteristic: ${bedrooms.body}`);
  assert.match(bedrooms.body, new RegExp(String(recorded.bedrooms), "u"), `the recorded bedrooms are answered: ${bedrooms.body}`);
  assert.ok(bedrooms.body.includes(first.title), "the answer is about the first listing in view");
  assert.doesNotMatch(bedrooms.body, /لم يذكر البائع/u);
  assert.notEqual(bedrooms.payload?.surface, "INQUIRY_DRAFT", "a recorded value needs no seller question");
  const area = await turn(buyer, conv, "كم مساحة الأولى؟");
  assert.match(area.body, new RegExp(String(recorded.area), "u"), `the recorded area is answered: ${area.body}`);
  assert.doesNotMatch(area.body, /لم يذكر البائع/u);
});

await focused("GEN-2", "an unrecorded property characteristic says so and opens an unsent review", async () => {
  const conv = await newConversation();
  const found = await turn(buyer, conv, `أريد شقة للإيجار ${runId}`);
  const ids = listingIds(found.payload);
  const position = ids.indexOf(flat3.id) + 1;
  assert.ok(position >= 1 && position <= 6, `the first flat is visible in the list: ${ids.join(",")}`);
  const word = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة", "السادسة"][position - 1]!;
  const question = await turn(buyer, conv, `كم حمام في ${word}؟`);
  assert.match(question.body, /لم يذكر البائع الحمامات/u, `the record has no bathrooms for that flat: ${question.body}`);
  assert.equal(question.payload?.surface, "INQUIRY_DRAFT", `expected an inquiry review: ${question.body}`);
  assert.equal(question.payload?.inquiry?.view, "DRAFT");
  assert.equal(question.payload?.inquiry?.status, "PENDING");
  assert.match(String(question.payload?.inquiry?.body ?? ""), /حمام/u, "the drafted question asks about the bathrooms");
  assert.equal(question.payload?.resourceId, flat3.id, "the review is about the flat in view");
  assert.equal((await sentTo(flat3.id)).length, 0, "nothing was sent to the seller");
});

await focused("GEN-3", "a recorded fashion characteristic is answered; an unrecorded one is a review", async () => {
  const conv = await newConversation();
  const found = await turn(buyer, conv, `أريد جاكيت شتوي ${runId}`);
  assert.ok(listingIds(found.payload).includes(jacket.id), `the jacket is found: ${found.body}`);
  const season = await turn(buyer, conv, "هل هذا شتوي؟");
  assert.match(season.body, /الموسم/u, `the answer names the season: ${season.body}`);
  assert.match(season.body, /شتوي/u, "the recorded season is quoted");
  assert.notEqual(season.payload?.surface, "INQUIRY_DRAFT", "a recorded season needs no seller question");
  const audience = await turn(buyer, conv, "هل هو رجالي؟");
  assert.match(audience.body, /لم يذكر البائع الفئة/u, `the audience is not recorded: ${audience.body}`);
  assert.equal(audience.payload?.surface, "INQUIRY_DRAFT");
  assert.equal(audience.payload?.inquiry?.view, "DRAFT");
  assert.match(String(audience.payload?.inquiry?.body ?? ""), /رجالي/u, "the drafted question asks about the audience");
  assert.equal(audience.payload?.resourceId, jacket.id);
  assert.equal((await sentTo(jacket.id)).length, 0, "nothing was sent about the audience either");
});

await focused("GEN-4", "an option question is answered with the recorded option, not the asked one", async () => {
  const conv = await newConversation();
  const found = await turn(buyer, conv, `أريد لابتوب مستعمل ${runId}`);
  assert.ok(listingIds(found.payload).includes(laptop.id), `the laptop is found: ${found.body}`);
  const question = await turn(buyer, conv, "هل اللابتوب جديد؟");
  assert.match(question.body, /الحالة/u, `the answer names the recorded condition: ${question.body}`);
  assert.match(question.body, /مستعمل/u, "the record says used, not new");
  assert.notEqual(question.payload?.surface, "INQUIRY_DRAFT");
  assert.doesNotMatch(question.body, /لم يذكر البائع/u);
});

await focused("GEN-5", "a recorded home characteristic is answered for a different product", async () => {
  const conv = await newConversation();
  await turn(buyer, conv, `أريد طاولة طعام ${runId}`);
  const question = await turn(buyer, conv, "هل الطاولة جديدة؟");
  assert.match(question.body, /جديد/u, `the recorded condition is answered: ${question.body}`);
  assert.notEqual(question.payload?.surface, "INQUIRY_DRAFT");
});

await focused("GEN-6", "a service with no registered characteristics asks the seller instead of inventing", async () => {
  const conv = await newConversation();
  const found = await turn(buyer, conv, `أريد خدمة تنظيف ${runId}`);
  assert.ok(listingIds(found.payload).includes(cleaning.id), `the service is found: ${found.body}`);
  const question = await turn(buyer, conv, "هل تشمل الخدمة الضمان؟");
  assert.match(question.body, /(?:لا أجد في سجل|لا يسجّل)[^]*الضمان/u, `the record cannot answer it: ${question.body}`);
  assert.equal(question.payload?.surface, "INQUIRY_DRAFT", `expected an inquiry review: ${question.body}`);
  assert.equal(question.payload?.inquiry?.view, "DRAFT");
  assert.equal(question.payload?.inquiry?.status, "PENDING");
  assert.match(String(question.payload?.inquiry?.body ?? ""), /الضمان/u, "the drafted question asks about the warranty");
  assert.equal(question.payload?.resourceId, cleaning.id);
  assert.equal((await sentTo(cleaning.id)).length, 0, "nothing was sent to the service seller");
});

await focused("GEN-7", "search and ranking keep their own path", async () => {
  const conv = await newConversation();
  const found = await turn(buyer, conv, `أريد شقة للإيجار ${runId}`);
  assert.notEqual(found.payload?.surface, "INQUIRY_DRAFT", "a search is never a review");
  const ranked = await turn(buyer, conv, "أرخص");
  assert.notEqual(ranked.payload?.surface, "INQUIRY_DRAFT", "a ranking is never a review");
  assert.ok(listingIds(ranked.payload).length > 0, `the ranking keeps the list: ${ranked.body}`);
});

console.log("GENERALITY_SUMMARY", JSON.stringify({
  passed: Object.values(results).filter((value) => value === "PASS").length,
  total: Object.keys(results).length,
  results,
}));
server.close();
