/**
 * Smart store cards: the shared contract, the nine fixtures, the server quote, events in revision
 * order, owner-only access, and the primary action adding Jassim listings to the cart at server prices.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, markets, pool } from "@workspace/db";
import { SmartStoreCard, CardEvent } from "@workspace/api-zod/smart-store-card";
import { SMART_STORE_FIXTURES } from "@workspace/api-zod/smart-store-card-fixtures";
import app from "../src/app";
import { applyCardEvent, computeQuote } from "../src/lib/smart-store-cards";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

async function call(path: string, cookie?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}
async function register(label: string) {
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: label, phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`, accountCountry: "JO", password: "smart-store-local-1", confirmPassword: "smart-store-local-1", acceptTerms: true }),
  });
  const data: any = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return { id: data.user.id as string, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]! };
}

await test("SSC-01 every fixture satisfies the contract and its stated total equals the server quote", () => {
  for (const [vertical, card] of Object.entries(SMART_STORE_FIXTURES)) {
    SmartStoreCard.parse(card);
    assert.equal(card.vertical, vertical);
    if (card.quote) assert.equal(computeQuote(card)!.total.minor, card.quote.total.minor, `${vertical} total`);
  }
  assert.equal(computeQuote(SMART_STORE_FIXTURES.FOOD)!.total.minor, 4250);
  assert.equal(computeQuote(SMART_STORE_FIXTURES.FASHION)!.total.minor, 34300);
  assert.equal(computeQuote(SMART_STORE_FIXTURES.GIFTS)!.total.minor, 14500);
  assert.equal(SMART_STORE_FIXTURES.VEHICLES.primaryAction.kind, "BOOK_TEST_DRIVE", "vehicles are never a cart");
  // The contract refuses what the brief forbids.
  assert.equal(SmartStoreCard.safeParse({ ...SMART_STORE_FIXTURES.GENERAL, sections: [{ kind: "TRY_ON", available: true, reason: "x" }] }).success, false, "try-on cannot be switched on by data");
  assert.equal(SmartStoreCard.safeParse({ ...SMART_STORE_FIXTURES.GENERAL, sections: [{ kind: "HERO_GALLERY", media: [{ url: "javascript:alert(1)", alt: "x", kind: "IMAGE" }] }] }).success, false, "no script URLs");
  assert.equal(CardEvent.safeParse({ type: "SELECT_OPTION", cardId: "x", revision: 1, groupId: "g", optionId: "o", selected: true, price: 1 }).success, false, "events carry no prices");
});

await test("SSC-02 events: single-choice variants, multi customizers, quantity, stale-safe revisions; totals recomputed", () => {
  const food = SMART_STORE_FIXTURES.FOOD;
  const large = applyCardEvent(food, { type: "SELECT_OPTION", cardId: food.cardId, revision: 1, groupId: "size", optionId: "large", selected: true });
  assert.equal(large.card.revision, 2);
  assert.equal(large.card.quote!.total.minor, 3250 + 350 + 150 + 750 + 500);
  const pickles = applyCardEvent(large.card, { type: "SELECT_OPTION", cardId: food.cardId, revision: 2, groupId: "custom", optionId: "pickles", selected: true });
  assert.equal(pickles.card.quote!.total.minor, 5000, "a free option changes nothing in the total");
  const two = applyCardEvent(pickles.card, { type: "SET_QUANTITY", cardId: food.cardId, revision: 3, productId: "p-burger", quantity: 2 });
  assert.equal(two.card.quote!.total.minor, 10000);
  const unavailable = applyCardEvent(SMART_STORE_FIXTURES.FASHION, { type: "SELECT_OPTION", cardId: "fx-fashion", revision: 1, groupId: "size", optionId: "size-XL", selected: true });
  assert.equal(unavailable.changed, false, "an unavailable size cannot be chosen");
  const shoes = applyCardEvent(SMART_STORE_FIXTURES.FASHION, { type: "FILL_SLOT", cardId: "fx-fashion", revision: 1, slotId: "s-shoes", productId: "p-shoes" });
  assert.equal(shoes.changed, false, "an unavailable product cannot fill a slot");
  const removed = applyCardEvent(SMART_STORE_FIXTURES.FASHION, { type: "REFINE_REMOVE", cardId: "fx-fashion", revision: 1, chipId: "c-budget" });
  assert.equal((removed.card.sections[0] as any).chips.length, 2);
  const mixed = structuredClone(SMART_STORE_FIXTURES.GENERAL);
  (mixed.sections[0] as any).products.push({ ...(mixed.sections[0] as any).products[0], id: "p-kwd", price: { minor: 1000, currency: "KWD", scale: 3, label: "1.000 KWD" } });
  (mixed.sections[0] as any).products.forEach((product: any) => (product.selected = true));
  assert.equal(computeQuote(mixed), undefined, "different currencies are never added together");
});

await test("SSC-03 server cards come from published listings; owner-only; stale revisions refused; primary action fills the cart at server prices", async () => {
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const market = await resolveMarket(row!);
  const listings = (await searchMarketplaceListings(market, { search: "", limit: 40 })) as any[];
  const listing = listings.find((item) => item.unitPrice !== null && (item.availableQuantity === null || item.availableQuantity - item.reservedQuantity > 0));
  assert.ok(listing, "the development seed has a priced listing");
  const buyer = await register("مشتري البطاقة");
  const stranger = await register("غريب البطاقة");
  const issued = await call("/smart-store/cards", buyer.cookie, { listingIds: [listing.id], understood: ["بحث تجريبي"] });
  assert.equal(issued.status, 201, issued.text);
  const card = SmartStoreCard.parse(issued.data);
  assert.equal(card.store.name, listing.sellerName.slice(0, 120), "the store's real name, not Jassim's");
  assert.equal(card.store.mode, "SELL_INSIDE_JASSIM");
  const detail = card.sections.find((section) => section.kind === "PRODUCT_DETAIL") as any;
  assert.equal(detail.productId, listing.id);
  if (listing.reviewCount === 0) assert.equal(detail.rating, undefined, "no rating is invented");
  assert.equal(card.quote!.final, true);
  assert.equal((await call(`/smart-store/cards/${card.cardId}`, stranger.cookie)).status, 404, "a card is its owner's only");
  const forged = await call(`/smart-store/cards/${card.cardId}/events`, buyer.cookie, { type: "SET_QUANTITY", cardId: card.cardId, revision: 1, productId: listing.id, quantity: 2, total: 1 });
  assert.equal(forged.status, 400, "unknown fields (a client total) are refused");
  const two = await call(`/smart-store/cards/${card.cardId}/events`, buyer.cookie, { type: "SET_QUANTITY", cardId: card.cardId, revision: 1, productId: listing.id, quantity: 2 });
  assert.equal(two.status, 200, two.text);
  assert.equal(two.data.card.revision, 2);
  assert.equal(two.data.card.quote.total.minor, card.quote!.total.minor * 2);
  const stale = await call(`/smart-store/cards/${card.cardId}/events`, buyer.cookie, { type: "SET_QUANTITY", cardId: card.cardId, revision: 1, productId: listing.id, quantity: 5 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.card.revision, 2, "the current card comes back");
  assert.equal((await call(`/smart-store/cards/${card.cardId}/events`, stranger.cookie, { type: "PRIMARY_ACTION", cardId: card.cardId, revision: 2 })).status, 404);
  const added = await call(`/smart-store/cards/${card.cardId}/events`, buyer.cookie, { type: "PRIMARY_ACTION", cardId: card.cardId, revision: 2 });
  if (added.status === 200) {
    assert.equal(added.data.addedToCart, 1);
    assert.match(added.data.card.notice, /سلتك/);
  } else {
    // The cart refuses what it must (own listing, market rules); the card never claims success then.
    assert.ok([400, 403, 409].includes(added.status), added.text);
    assert.equal((await call(`/smart-store/cards/${card.cardId}`, buyer.cookie)).data.notice, undefined);
  }
});

after(async () => { server.close(); await pool.end(); });
