/**
 * Reconciliation — stock questions and specification questions in the same conversation.
 *
 * The stock layer (T3) answers «كم المتبقي؟» from the inventory record; the specification layer
 * (SC06 + generality) answers «كم ماشي؟», «هل عليها فحص؟» and registry characteristics from the
 * listing record. They run next to each other in one conversation and must not answer each
 * other's questions: a spec question never reads the stock columns, a stock question never reads
 * the spec vocabularies, and neither invokes the model nor writes anything.
 *
 * This suite exists for the integration branch where both engines coexist. It publishes its own
 * fixtures (never seeded data) and checks the database after every conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, marketplaceInquiries, offers, orderItems } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_STOCK_SPEC_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `m${randomUUID().replaceAll("-", "").slice(0, 7)}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", origin: base.replace("/api", "") } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.24.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_600_000 + ((Date.now() + process.pid) % 80_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Mix-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Mix ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
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
  attributes: Record<string, unknown>; quantity?: number; inventoryMode?: "LIMITED" | "UNLIMITED";
}) {
  const title = `${spec.title} ${runId}`;
  const limited = (spec.inventoryMode ?? "LIMITED") === "LIMITED";
  const created = await request("/listings", "POST", {
    title, description: `${spec.description} ${runId}`,
    category: spec.category, categoryId: spec.categoryId, area: "خلدا", city: "عمان",
    attributes: spec.attributes,
    unitPrice: spec.price, inventoryMode: spec.inventoryMode ?? "LIMITED",
    availableQuantity: limited ? (spec.quantity ?? 1) : undefined,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, `${spec.title}: ${created.raw}`);
  return { id: created.data.id as string, title };
}

const newConversation = async (actor: Actor) =>
  (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id as string;

const offerRows = (ids: string[]) => db.select().from(offers).where(inArray(offers.id, ids));

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

const carA = await publish(seller, {
  title: "سيارة تويوتا كورولا 2019", price: "7800", categoryId: "cars", category: "سيارات",
  description: "سيارة بحالة جيدة، صيانة منتظمة",
  attributes: { make: "تويوتا", model: "كورولا", year: 2019, condition: "مستعمل", mileage: 32000, operatingHours: 8, inspection: "مفحوصة بالكامل" }, quantity: 4,
});
const carB = await publish(seller, {
  title: "سيارة هوندا سيفيك 2020", price: "9200", categoryId: "cars", category: "سيارات",
  description: "سيارة عائلية، استخدام خفيف",
  attributes: { make: "هوندا", model: "سيفيك", year: 2020, condition: "مستعمل", mileage: 51000 }, quantity: 2,
});
const flat = await publish(seller, {
  title: "شقة مفروشة", price: "550", categoryId: "property", category: "عقارات",
  description: "شقة مفروشة قريبة من الخدمات",
  attributes: { propertyType: "شقة", transactionType: "إيجار", bedrooms: 3, area: 120 }, quantity: 2,
});
const cleaning = await publish(seller, {
  title: "خدمة تنظيف", price: "25", categoryId: "services", category: "خدمات",
  description: "خدمة تنظيف منازل بالطلب",
  attributes: {}, inventoryMode: "UNLIMITED",
});

const tracked = [carA.id, carB.id, flat.id, cleaning.id];
const before = await offerRows(tracked);

await focused("MIX-1", "a spec question then a stock question about the same listing", async () => {
  const conv = await newConversation(buyer);
  const found = await turn(buyer, conv, `أريد تويوتا ${runId}`);
  assert.ok(listingIds(found.payload).includes(carA.id), `the car is in view: ${found.body}`);

  const mileage = await turn(buyer, conv, "كم ماشي؟");
  assert.match(mileage.body, /ممشى/u, `the spec layer names the mileage: ${mileage.body}`);
  assert.match(mileage.body, /32,000/u, `the recorded mileage is answered: ${mileage.body}`);
  assert.equal(mileage.payload?.surface, "CLARIFY");

  const stock = await turn(buyer, conv, "كم المتبقي؟");
  assert.match(stock.body, /المتاح الآن[^]*\b4\b/u, `the stock layer answers the same listing: ${stock.body}`);
  assert.match(stock.body, /سجل الإعلان/u);
  assert.equal(stock.payload?.surface, "CLARIFY");
});

await focused("MIX-2", "stock, then a spec fact, then stock again — the question decides the layer", async () => {
  const conv = await newConversation(buyer);
  await turn(buyer, conv, `أريد تويوتا ${runId}`);

  const first = await turn(buyer, conv, "كم حبة باقي؟");
  assert.match(first.body, /المتاح الآن[^]*\b4\b/u, `stock first: ${first.body}`);

  const inspection = await turn(buyer, conv, "هل عليها فحص؟");
  assert.match(inspection.body, /مفحوصة بالكامل/u, `the inspection fact is quoted: ${inspection.body}`);
  assert.doesNotMatch(inspection.body, /المتاح الآن/u, "a fact question is not a stock answer");

  const second = await turn(buyer, conv, "هل المنتج متوفر؟");
  assert.match(second.body, /المتاح الآن[^]*\b4\b/u, `stock again, unchanged: ${second.body}`);
});

await focused("MIX-3", "two listings in view: each layer resolves the same ordinal to the same listing", async () => {
  const conv = await newConversation(buyer);
  const found = await turn(buyer, conv, `أريد سيارة ${runId}`);
  const ids = listingIds(found.payload);
  assert.ok(ids.includes(carA.id) && ids.includes(carB.id), `both cars are in view: ${found.body}`);

  const position = (id: string) => ids.indexOf(id) + 1;
  const word = (id: string) => ["الأول", "الثاني", "الثالث"][position(id) - 1]!;
  const expected = [
    { car: carA, mileage: "32,000", quantity: 4 },
    { car: carB, mileage: "51,000", quantity: 2 },
  ];

  for (const { car, mileage, quantity } of expected) {
    const spec = await turn(buyer, conv, `كم ماشي في ${word(car.id)}؟`);
    assert.ok(spec.body.includes(car.title), `${word(car.id)} is ${car.title}: ${spec.body}`);
    assert.match(spec.body, new RegExp(mileage, "u"), `the ${word(car.id)} mileage: ${spec.body}`);

    const stock = await turn(buyer, conv, `كم المتبقي في ${word(car.id)}؟`);
    assert.ok(stock.body.includes(car.title), `${word(car.id)} stock names the same listing: ${stock.body}`);
    assert.match(stock.body, new RegExp(`المتاح الآن من «[^»]*»\\s*${quantity}\\b`, "u"), `${word(car.id)} stock: ${stock.body}`);
  }

  const specFirst = await turn(buyer, conv, `كم ماشي في ${word(carA.id)}؟`);
  const stockSecond = await turn(buyer, conv, `كم المتبقي في ${word(carB.id)}؟`);
  assert.ok(specFirst.body.includes(carA.title));
  assert.ok(stockSecond.body.includes(carB.title), "a different ordinal is a different listing");
  assert.doesNotMatch(stockSecond.body, new RegExp(carA.title, "u"));
});

await focused("MIX-4", "a registry characteristic and the stock of a flat in one conversation", async () => {
  const conv = await newConversation(buyer);
  const found = await turn(buyer, conv, `أريد شقة مفروشة ${runId}`);
  assert.ok(listingIds(found.payload).includes(flat.id), `the flat is in view: ${found.body}`);

  const bedrooms = await turn(buyer, conv, "كم غرفة نوم؟");
  assert.match(bedrooms.body, /غرف النوم/u, `the registry labels the characteristic: ${bedrooms.body}`);
  assert.match(bedrooms.body, /\b3\b/u, `the recorded bedrooms are answered: ${bedrooms.body}`);

  const stock = await turn(buyer, conv, "كم المتبقي؟");
  assert.match(stock.body, /المتاح الآن[^]*\b2\b/u, `the flat's two units: ${stock.body}`);
});

await focused("MIX-5", "an unrecorded service fact opens an unsent review; its stock stays unlimited", async () => {
  const conv = await newConversation(buyer);
  const found = await turn(buyer, conv, `أريد خدمة تنظيف ${runId}`);
  assert.ok(listingIds(found.payload).includes(cleaning.id), `the service is in view: ${found.body}`);

  const warranty = await turn(buyer, conv, "هل تشمل الخدمة الضمان؟");
  assert.match(warranty.body, /الضمان/u, `the record cannot answer it: ${warranty.body}`);
  assert.equal(warranty.payload?.surface, "INQUIRY_DRAFT");
  assert.equal(warranty.payload?.resourceId, cleaning.id);

  const stock = await turn(buyer, conv, "هل الخدمة متوفرة؟");
  assert.match(stock.body, /غير محدود/u, `a service has no unit count: ${stock.body}`);
  assert.doesNotMatch(stock.body, /المتاح الآن[^]*\d/u, `no number for an unlimited service: ${stock.body}`);
  assert.equal(stock.payload?.surface, "CLARIFY");

  const again = await turn(buyer, conv, "كم المتبقي؟");
  assert.match(again.body, /غير محدود/u, `the stock answer is stable: ${again.body}`);
});

await focused("MIX-6", "neither layer wrote: stock, orders and inquiries are unchanged", async () => {
  const after = await offerRows(tracked);
  const state = (rows: typeof before) => rows
    .map((row) => [row.id, row.status, row.availableQuantity, row.reservedQuantity].join(":"))
    .sort();
  assert.deepEqual(state(after), state(before), "asking changed no offer row");

  const placed = await db.select({ id: orderItems.id }).from(orderItems).where(inArray(orderItems.offerId, tracked));
  assert.equal(placed.length, 0, "no order was placed by any question");

  const asked = await db.select({ id: marketplaceInquiries.id }).from(marketplaceInquiries)
    .where(inArray(marketplaceInquiries.listingId, tracked));
  assert.equal(asked.length, 0, "no inquiry was sent by any question");
});

console.log("STOCK_SPEC_SUMMARY", JSON.stringify({
  passed: Object.values(results).filter((value) => value === "PASS").length,
  total: Object.keys(results).length,
  results,
}));
server.close();
