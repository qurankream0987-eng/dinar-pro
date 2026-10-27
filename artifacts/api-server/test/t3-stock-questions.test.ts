/**
 * T3 — a buyer's stock question about the listing in view.
 *
 * «كم المتبقي؟», «كم حبة باقي؟», «هل المنتج متوفر؟», «عندك كمية؟» and «كم أقدر أطلب؟» are
 * answered from the inventory record the commerce engine already keeps: the available
 * quantity minus the reservations held by open orders. Never the model, never a guess,
 * never a promise from the seller.
 *
 * A question is read-only: asking reserves nothing and creates no inquiry. The listing's
 * status and market are checked first (a paused listing is not answered as available), an
 * unlimited listing has no number to show, and a listing that is not in view is asked
 * about, not guessed. Detection is about Arabic stock phrasings, not about a product.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, marketplaceInquiries, offers, orders } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_T3_ACCEPTANCE");

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = `t${randomUUID().replaceAll("-", "").slice(0, 7)}`;
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
const phoneBase = 51_500_000 + ((Date.now() + process.pid) % 90_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `T3-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR T3 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
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

async function publishListing(
  seller: Actor,
  spec: { title: string; price: string; quantity?: number; mode?: "LIMITED" | "UNLIMITED"; category?: string; categoryId?: string; fulfilment?: string },
) {
  const limited = (spec.mode ?? "LIMITED") === "LIMITED";
  const created = await request("/listings", "POST", {
    title: `${spec.title} ${runId}`,
    description: `${spec.title} للبيع، ${runId}`,
    category: spec.category ?? "أخرى",
    categoryId: spec.categoryId ?? "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: spec.price,
    inventoryMode: spec.mode ?? "LIMITED",
    availableQuantity: limited ? (spec.quantity ?? 1) : null,
    fulfilmentType: spec.fulfilment ?? "PICKUP",
    imageUrl: "",
    imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, `${spec.title}: ${created.raw}`);
  return { id: created.data.id as string, title: `${spec.title} ${runId}` };
}

const newConversation = async (actor: Actor) => {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
};

async function offerState(id: string) {
  const [row] = await db.select().from(offers).where(eq(offers.id, id));
  assert.ok(row, `offer ${id} exists`);
  return { status: row!.status, available: row!.availableQuantity, reserved: row!.reservedQuantity };
}

const inquiriesOn = (id: string) => db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, id));
const buyerOrders = (id: string) => db.select().from(orders).where(eq(orders.buyerId, id));

async function placeOrder(actor: Actor, listingId: string, quantity: number) {
  return request("/orders", "POST", { listingId, quantity, fulfilmentType: "PICKUP", idempotencyKey: randomUUID() }, actor.cookie);
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
const rival1 = await register("rival-one");
const rival2 = await register("rival-two");

const bike = await publishListing(seller, { title: "دراجة هوائية", price: "15", quantity: 5 });
const pillow = await publishListing(seller, { title: "وسادة قطنية", price: "5", mode: "UNLIMITED" });
const cleaning = await publishListing(seller, {
  title: "تنظيف منازل", price: "40", mode: "UNLIMITED", category: "خدمات", categoryId: "services", fulfilment: "SERVICE",
});
const chair = await publishListing(seller, { title: "كرسي خشبي", price: "20", quantity: 4 });
const lamp = await publishListing(seller, { title: "مصباح مكتبي", price: "7", quantity: 1 });
const stoveSmall = await publishListing(seller, { title: "مدفأة كهربائية صغيرة", price: "30", quantity: 5 });
const stoveLarge = await publishListing(seller, { title: "مدفأة كهربائية كبيرة", price: "45", quantity: 7 });
const box = await publishListing(seller, { title: "صندوق تخزين", price: "9", quantity: 3 });

/** Searches the pinned fixture so the suite never measures seeded listings. */
async function view(actor: Actor, conversationId: string, words: string) {
  return turn(actor, conversationId, `أريد ${words} ${runId}`);
}

let bikeConv = "";

await focused("STOCK-1", "«كم المتبقي؟» answers the recorded available quantity without the model", async () => {
  bikeConv = await newConversation(buyer);
  const found = await view(buyer, bikeConv, "دراجة هوائية");
  assert.ok(listingIds(found.payload).includes(bike.id), `the bike is in view: ${found.body}`);
  const before = await offerState(bike.id);
  const answer = await turn(buyer, bikeConv, "كم المتبقي؟");
  assert.match(answer.body, /المتاح الآن[^]*\b5\b/u, `the record's 5 units: ${answer.body}`);
  assert.match(answer.body, /سجل الإعلان/u, "the source of the number is stated");
  assert.equal(answer.payload?.surface, "CLARIFY", `a deterministic answer surface: ${answer.body}`);
  const after = await offerState(bike.id);
  assert.deepEqual([after.available, after.reserved, after.status], [before.available, before.reserved, before.status], "asking changed no stock");
  assert.equal((await inquiriesOn(bike.id)).length, 0, "asking sent no inquiry");
});

await focused("STOCK-2", "the other stock phrasings give the same recorded quantity", async () => {
  for (const message of ["كم حبة باقي؟", "هل المنتج متوفر؟", "عندك كمية؟", "كم أقدر أطلب؟", "كم الكمية المتبقية؟"]) {
    const answer = await turn(buyer, bikeConv, message);
    assert.match(answer.body, /المتاح الآن[^]*\b5\b/u, `${message}: ${answer.body}`);
    assert.equal(answer.payload?.surface, "CLARIFY", `${message}: ${answer.body}`);
  }
  assert.equal((await inquiriesOn(bike.id)).length, 0, "no phrasing sent an inquiry");
});

await focused("STOCK-3", "an unlimited product has no number to show and is not dressed as one", async () => {
  const conv = await newConversation(buyer);
  await view(buyer, conv, "وسادة قطنية");
  const answer = await turn(buyer, conv, "كم المتبقي؟");
  assert.match(answer.body, /غير محدود/u, `the seller publishes without a limit: ${answer.body}`);
  assert.doesNotMatch(answer.body, /المتاح الآن[^]*\d/u, `no invented number: ${answer.body}`);
  const state = await offerState(pillow.id);
  assert.equal(state.available, null);
  assert.equal((await inquiriesOn(pillow.id)).length, 0);
});

await focused("STOCK-4", "a service with unlimited capacity is answered honestly too", async () => {
  const conv = await newConversation(buyer);
  const found = await view(buyer, conv, "تنظيف منازل");
  assert.ok(listingIds(found.payload).includes(cleaning.id), `the service is in view: ${found.body}`);
  const answer = await turn(buyer, conv, "هل الخدمة متوفرة؟");
  assert.match(answer.body, /غير محدود/u, `a service has no unit count: ${answer.body}`);
  assert.doesNotMatch(answer.body, /المتاح الآن[^]*\d/u);
});

await focused("STOCK-5", "a sold-out listing is not answered as available", async () => {
  const conv = await newConversation(buyer);
  await view(buyer, conv, "مصباح مكتبي");
  const placed = await placeOrder(buyer, lamp.id, 1);
  assert.equal(placed.status, 201, placed.raw);
  const state = await offerState(lamp.id);
  assert.deepEqual([state.available, state.reserved], [1, 1], "the only unit is reserved, not consumed");
  const answer = await turn(buyer, conv, "هل المنتج متوفر؟");
  assert.match(answer.body, /لا يوجد متاح الآن|نفد/u, `nothing is available now: ${answer.body}`);
  assert.doesNotMatch(answer.body, /المتاح الآن من[^»]*»\s*[1-9]/u, `no availability invented: ${answer.body}`);
  assert.equal((await inquiriesOn(lamp.id)).length, 0);
});

await focused("STOCK-6", "a paused listing is not answered as available", async () => {
  const conv = await newConversation(buyer);
  await view(buyer, conv, "كرسي خشبي");
  const paused = await request(`/listings/${chair.id}/status`, "PATCH", { action: "PAUSE" }, seller.cookie);
  assert.equal(paused.status, 200, paused.raw);
  assert.equal((await offerState(chair.id)).status, "PAUSED");
  const answer = await turn(buyer, conv, "هل المنتج متوفر؟");
  assert.match(answer.body, /غير متاح|موقوف/u, `the paused status is stated: ${answer.body}`);
  assert.doesNotMatch(answer.body, /المتاح الآن من/u, `no availability for a non-published listing: ${answer.body}`);
  assert.match(answer.body, /سجل الإعلان/u);
});

await focused("STOCK-7", "concurrent reservations are subtracted, and the remaining count is exact", async () => {
  const conv = await newConversation(buyer);
  await view(buyer, conv, "صندوق تخزين");
  const [first, second] = await Promise.all([placeOrder(rival1, box.id, 2), placeOrder(rival2, box.id, 2)]);
  assert.equal([first.status, second.status].filter((status) => status === 201).length, 1, `${first.status}/${second.status}: ${first.raw} | ${second.raw}`);
  const state = await offerState(box.id);
  assert.deepEqual([state.available, state.reserved], [3, 2], "one order of 2 is held, the other was refused");
  const answer = await turn(buyer, conv, "كم المتبقي؟");
  assert.match(answer.body, /المتاح الآن[^]*\b1\b/u, `3 total minus 2 reserved: ${answer.body}`);
  assert.doesNotMatch(answer.body, /المتاح الآن من «[^»]*»\s*3\b/u, "the reserved units are not offered again");
});

await focused("STOCK-8", "an ordinal resolves to that listing's own record", async () => {
  const conv = await newConversation(buyer);
  const found = await view(buyer, conv, "مدفأة كهربائية");
  const ids = listingIds(found.payload);
  assert.ok(ids.includes(stoveSmall.id) && ids.includes(stoveLarge.id), `both stoves are in view: ${found.body}`);
  // Each position must answer with that listing's own record; the two quantities differ so an
  // ignored ordinal would name the wrong title or the wrong number.
  for (const [stove, expected] of [[stoveLarge, 7], [stoveSmall, 5]] as const) {
    const position = ids.indexOf(stove.id) + 1;
    assert.ok(position >= 1 && position <= 3, "each stove has a visible position");
    const word = ["الأول", "الثاني", "الثالث"][position - 1];
    const answer = await turn(buyer, conv, `كم المتبقي في ${word}؟`);
    assert.match(answer.body, new RegExp(`المتاح الآن من «[^»]*»\\s*${expected}\\b`, "u"), `${word} is the ${expected}-unit listing: ${answer.body}`);
    assert.ok(answer.body.includes(stove.title), `the answer names the listing asked about: ${answer.body}`);
    const state = await offerState(stove.id);
    assert.equal(state.available, expected);
  }
});

await focused("STOCK-9", "with no listing in view DINAR asks which listing, never guesses", async () => {
  const conv = await newConversation(buyer);
  for (const message of ["كم المتبقي؟", "هل المنتج متوفر؟"]) {
    const answer = await turn(buyer, conv, message);
    assert.match(answer.body, /أي عرض تقصد/u, `${message}: ${answer.body}`);
    assert.equal(answer.payload?.surface, "CLARIFY");
    assert.doesNotMatch(answer.body, /المتاح الآن/u);
  }
});

await focused("STOCK-10", "a new search that mentions availability is not turned into a stock answer", async () => {
  const conv = await newConversation(buyer);
  const search = await turn(buyer, conv, `أريد لابتوب متوفر ${runId}`);
  assert.doesNotMatch(search.body, /سجل الإعلان|المتاح الآن/u, `a search stays a search: ${search.body}`);
  await view(buyer, conv, "دراجة هوائية");
  const other = await turn(buyer, conv, "هل يوجد لابتوب متوفر؟");
  assert.doesNotMatch(other.body, /المتاح الآن من «[^»]*دراجة/u, `the bike's stock is not the laptop's answer: ${other.body}`);
});

await focused("STOCK-11", "stock questions never placed an extra order", async () => {
  assert.equal((await buyerOrders(buyer.id)).length, 1, "only the intended sold-out order exists for the questioner");
  const lampState = await offerState(lamp.id);
  assert.deepEqual([lampState.available, lampState.reserved], [1, 1], "the last-piece reservation is untouched");
});

console.log("T3_STOCK_SUMMARY", JSON.stringify({ passed: Object.values(results).filter((value) => value === "PASS").length, total: Object.keys(results).length, results }));
server.close();
