import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  db,
  listingPromotions,
  offers,
  orderItems,
  orders,
  paymentIntents,
  pool,
  promotionProducts,
  sellerDues,
  users,
} from "@workspace/db";
import { getModelGatewayCallCount, resetModelGatewayCallCount } from "../src/ai/model-gateway";
import { marketFor, resolveMarket } from "../src/lib/markets";
import { deactivateOwnAccount } from "../src/lib/moderation";
import { searchMarketplaceListings } from "../src/lib/marketplace-listings";
import { calculatePlatformFeeMinor } from "../src/lib/market-pricing";
import { expireStalePromotions, servingCampaignsFor } from "../src/lib/promotions";
import { testOnlyPaymentAdapter } from "../src/lib/payments/test-adapter";
import { searchCandidates, searchJobs, updateOwnProfile } from "../src/lib/employment";
import { parsePromotionDuration, normalizePromotionText } from "../src/ai/promotion-turn";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKE_ACCEPTANCE");
// Any model call would throw and be counted; deterministic Block E flows must make none.
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const providerConfigured = Boolean(
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY,
);
const execFileAsync = promisify(execFile);

// Titles carry no run token (recommendations compare titles); descriptions carry it
// so every search below stays scoped to this run's listings.
// Every outbound request from this process that leaves loopback is recorded.
const external: string[] = [];
const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.replace(/:\d+$/, ""));
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!loopback(url.hostname)) external.push(url.hostname);
  } catch {
    // Non-URL inputs are not network requests.
  }
  return originalFetch(input, init);
}) as typeof fetch;
for (const module of [http, https] as any[]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = (...args: any[]) => {
      const first = args[0];
      const host =
        typeof first === "string" || first instanceof URL
          ? new URL(String(first)).hostname
          : String(first?.hostname ?? first?.host ?? "");
      if (host && !loopback(host)) external.push(host);
      return original.apply(module, args);
    };
  }
}

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api`;
let authSequence = 0;
const runId = `e${randomUUID().replaceAll("-", "").slice(0, 7)}`;
const requestedUrls: string[] = [];

type ApiResponse = { status: number; data: any; cookie: string; raw: string };
async function request(path: string, method = "GET", body?: unknown, cookie = ""): Promise<ApiResponse> {
  const rateLimited = path.startsWith("/auth/");
  const ip = rateLimited
    ? `198.51.${Math.floor(authSequence / 250) % 250}.${(authSequence++ % 250) + 1}`
    : undefined;
  requestedUrls.push(base + path);
  const response = await originalFetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { "X-Forwarded-For": ip } : {}),
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
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", raw };
}

type Actor = { id: string; cookie: string; label: string };
// Kuwaiti numbers from 51,800,000 up are invalid: the range stays below it.
const phoneBase = 51_200_000 + ((Date.now() + process.pid) % 500_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  assert.equal(started.status, 202, started.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: started.data.challengeId,
    code: started.data.developmentCode,
  });
  assert.equal(verified.status, 200, verified.raw);
  const password = `BlockE-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Block E ${label}`,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  await setMarket({ id: registered.data.user.id, cookie: registered.cookie, label }, marketId);
  return { id: registered.data.user.id, cookie: registered.cookie, label };
}

async function setMarket(actor: Actor, marketId: string) {
  const changed = await request("/account/market", "PATCH", { marketId }, actor.cookie);
  if (changed.status !== 200) console.error("BLOCKE_MARKET_SETUP_FAILURE", { actor: actor.label, marketId, status: changed.status, body: changed.raw });
  assert.equal(changed.status, 200, changed.raw);
}

function completion(raw: string): any {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.type === "complete");
}

const modelCalls: { phrase: string; calls: number }[] = [];
type TurnResult = { body: string; blockType: string; surface: string; payload: any; promotion: any; listings: any[]; resultSetId: string };
async function turn(actor: Actor, conversationId: string, message: string): Promise<TurnResult> {
  const before = getModelGatewayCallCount();
  requestedUrls.push(`${base}/ai/conversations/${conversationId}/turns`);
  const response = await originalFetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const complete = completion(raw);
  assert.ok(complete, `turn "${message}" did not complete: ${raw.slice(0, 400)}`);
  const calls = getModelGatewayCallCount() - before;
  modelCalls.push({ phrase: message, calls });
  assert.equal(calls, 0, `model call for deterministic phrase ${message}`);
  const block = complete.assistantMessage.blocks[0];
  return {
    body: complete.assistantMessage.body,
    blockType: block?.type,
    surface: block?.payload?.surface,
    payload: block?.payload,
    promotion: block?.payload?.promotion,
    listings: block?.payload?.listings ?? [],
    resultSetId: block?.payload?.resultSetId,
  };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

type ListingSpec = {
  title: string;
  categoryId: string;
  category: string;
  price: string;
  city?: string;
  attributes?: Record<string, string | number>;
  service?: boolean;
  quantity?: number;
};
async function publish(seller: Actor, spec: ListingSpec): Promise<string> {
  const created = await request(
    "/listings",
    "POST",
    {
      title: spec.title,
      description: `عرض اختبار ${runId} ${spec.title}`,
      category: spec.category,
      categoryId: spec.categoryId,
      area: "خلدا",
      city: spec.city ?? "عمان",
      attributes: spec.attributes ?? {},
      unitPrice: spec.price,
      inventoryMode: spec.service ? "UNLIMITED" : "LIMITED",
      availableQuantity: spec.service ? null : spec.quantity ?? 5,
      fulfilmentType: spec.service ? "SERVICE" : "PICKUP",
      imageUrl: "",
      imageUrls: [],
    },
    seller.cookie,
  );
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

async function buy(buyer: Actor, listingId: string) {
  const created = await request(
    "/orders",
    "POST",
    { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `e-${randomUUID()}` },
    buyer.cookie,
  );
  assert.equal(created.status, 201, created.raw);
  return created.data as { id: string };
}

async function purchase(seller: Actor, listingId: string, planId: string, extra: Record<string, unknown> = {}, key = `blocke:${randomUUID()}`) {
  return request(
    `/listings/${listingId}/promotions`,
    "POST",
    { promotionProductId: planId, confirmed: true, idempotencyKey: key, ...extra },
    seller.cookie,
  );
}

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let KW: Awaited<ReturnType<typeof resolveMarket>>;
async function marketRow(id: string) {
  const { markets } = await import("@workspace/db");
  const [row] = await db.select().from(markets).where(eq(markets.id, id));
  return resolveMarket(row!);
}
const search = (term: string, options: Record<string, unknown> = {}, market = JO) =>
  searchMarketplaceListings(market, { search: term, conversational: true, ...options });

async function campaignsFor(listingId: string) {
  return db.select().from(listingPromotions).where(eq(listingPromotions.listingId, listingId));
}

let admin: Actor;
let sellerA: Actor;
let sellerB: Actor;
let sellerC: Actor; // deactivation probe
let sellerE: Actor; // conversational promotion journey
let buyer: Actor;
let buyerKW: Actor;
const L: Record<string, string> = {};
const plan: Record<string, string> = {};
const promo: Record<string, string> = {};
const results: Record<string, "PASS" | "FAIL" | "NOT REQUIRED"> = {};
const selectedCases = process.env.BDINAR_BLOCKE_CASES
  ? new Set(process.env.BDINAR_BLOCKE_CASES.split(",").map((value) => value.trim()).filter(Boolean))
  : undefined;
const cross = { seller: { passed: 0, total: 0 }, market: { passed: 0, total: 0 } };
let legacyOrders: { id: string; fee: number; seller: number; data: string }[] = [];
let paymentIntentCountAtStart = 0;
let browserReport: any;
const security: Record<string, string> = {};

async function acceptance(id: string, name: string, body: () => Promise<void>) {
  await test(`${id} ${name}`, { skip: Boolean(selectedCases && !selectedCases.has(id)) }, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      console.error(`BLOCKE_FAILURE_${id}`, error);
      throw error;
    }
  });
}

function rejected(response: ApiResponse, statuses: number[], tally: { passed: number; total: number }, label: string) {
  tally.total += 1;
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses} got ${response.status} ${response.raw.slice(0, 200)}`);
  tally.passed += 1;
}

await test("setup: providers off, disposable markets, fresh actors, admin plans, real listings", async () => {
  resetModelGatewayCallCount();
  assert.equal(providerConfigured, false, "Block E runs with the external AI provider unconfigured");
  [admin, sellerA, sellerB, sellerC, sellerE, buyer] = await Promise.all(
    ["Admin", "Seller A", "Seller B", "Seller C", "Seller E", "Buyer"].map((label) => register(label)),
  );
  buyerKW = await register("Buyer KW", "KW");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  JO = await marketRow("JO");
  KW = await marketRow("KW");
  assert.equal(JO.currencyCode, "JOD");

  // Plans from earlier runs of this suite are switched off so durations are unambiguous.
  await db
    .update(promotionProducts)
    .set({ enabled: false })
    .where(and(eq(promotionProducts.marketId, "JO"), like(promotionProducts.name, "Block E %")));
  const createPlan = async (key: string, categoryId: string, durationDays: number, priceMinor: number) => {
    const created = await request(
      "/admin/markets/JO/promotion-products",
      "POST",
      { categoryId, name: `Block E ${key} ${runId}`, placement: "SEARCH_AND_CHAT", priceMinor, durationDays, enabled: true },
      admin.cookie,
    );
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.data.currencyCode, "JOD");
    plan[key] = created.data.id;
  };
  await createPlan("other7", "other", 7, 2_500);
  await createPlan("other3", "other", 3, 1_500);
  await createPlan("cars7", "cars", 7, 9_000);
  await createPlan("services7", "services", 7, 3_000);
  await createPlan("electronics7", "electronics", 7, 2_000);
  // Non-admins cannot configure plans.
  const denied = await request(
    "/admin/markets/JO/promotion-products",
    "POST",
    { categoryId: "other", name: "x", placement: "SEARCH_AND_CHAT", priceMinor: 1, durationDays: 1 },
    sellerA.cookie,
  );
  assert.equal(denied.status, 403);

  const other = { categoryId: "other", category: "أخرى" };
  L.lamp1 = await publish(sellerA, { ...other, title: `مصباح مكتب خشبي`, price: "20" });
  L.lamp2 = await publish(sellerA, { ...other, title: `مصباح أرضي حديث`, price: "15" });
  L.lamp6 = await publish(sellerA, { ...other, title: `مصباح زيتي قديم`, price: "12" });
  L.sandwich = await publish(sellerA, { ...other, title: `ساندويش فلافل`, price: "1" });
  L.lantern = await publish(sellerA, { ...other, title: `فانوس رمضان`, price: "9" });
  L.vase1 = await publish(sellerA, { ...other, title: `مزهرية زجاج`, price: "8" });
  L.vase2 = await publish(sellerB, { ...other, title: `مزهرية خزف`, price: "7" });
  L.mop = await publish(sellerB, { ...other, title: `ممسحة أرضيات`, price: "3" });
  for (const index of [3, 4, 5])
    L[`lamp${index}`] = await publish(sellerB, { ...other, title: `مصباح نوم ${index}`, price: String(10 + index) });
  L.lampC = await publish(sellerC, { ...other, title: `مصباح نحاسي`, price: "30" });
  const car = { categoryId: "cars", category: "سيارات", quantity: 1 };
  L.prado18 = await publish(sellerA, { ...car, title: `تويوتا برادو 2018`, price: "30000", attributes: { make: "تويوتا", model: "برادو", year: 2018, condition: "مستعمل" } });
  L.prado15 = await publish(sellerB, { ...car, title: `تويوتا برادو 2015`, price: "25000", attributes: { make: "تويوتا", model: "برادو", year: 2015, condition: "مستعمل" } });
  L.cruiser = await publish(sellerB, { ...car, title: `تويوتا لاندكروزر`, price: "20000", attributes: { make: "تويوتا", model: "لاندكروزر", year: 2014, condition: "مستعمل" } });
  L.elantra = await publish(sellerA, { ...car, title: `هيونداي النترا`, price: "8000", city: "الزرقاء", attributes: { make: "هيونداي", model: "النترا", year: 2016, condition: "مستعمل" } });
  const service = { categoryId: "services", category: "خدمات", service: true };
  L.plumb = await publish(sellerA, { ...service, title: `سباكة منزلية`, price: "15" });
  L.plumb2 = await publish(sellerB, { ...service, title: `صيانة سباكة طوارئ`, price: "18" });
  L.math = await publish(sellerB, { ...service, title: `دروس رياضيات`, price: "10" });
  const electronics = { categoryId: "electronics", category: "إلكترونيات" };
  L.head1 = await publish(sellerA, { ...electronics, title: `سماعة بلوتوث`, price: "25" });
  L.head2 = await publish(sellerB, { ...electronics, title: `سماعة رأس لاسلكية`, price: "22" });
  L.charger = await publish(sellerA, { ...electronics, title: `شاحن هاتف`, price: "6" });
  for (const title of ["كرسي خشبي", "طاولة قهوة", "رف كتب"])
    L[title] = await publish(sellerE, { ...other, title: `${title}`, price: "40" });

  // Model one legitimate historical 1500-bps snapshot in this guarded disposable DB.
  // Create the order through checkout, then give the historical fixture its original
  // order-level commission and fee derived by the canonical calculator.
  const historical = await buy(buyer, L.charger!);
  const [historicalOrder] = await db.select().from(orders).where(eq(orders.id, historical.id));
  assert.ok(historicalOrder);
  const historicalItems = await db.select().from(orderItems).where(eq(orderItems.orderId, historical.id));
  const historicalCopyId = randomUUID();
  const historicalRate = 1_500;
  const historicalFee = calculatePlatformFeeMinor(historicalOrder.subtotalMinor, historicalRate);
  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      ...historicalOrder,
      id: historicalCopyId,
      platformFeeMinor: historicalFee,
      sellerAmountMinor: historicalOrder.subtotalMinor - historicalFee,
      data: { ...historicalOrder.data, commissionRateBps: historicalRate },
    });
    await tx.insert(orderItems).values(
      historicalItems.map((item) => ({
        ...item,
        id: randomUUID(),
        orderId: historicalCopyId,
      })),
    );
  });

  legacyOrders = (
    await pool.query(
      "select id, platform_fee_minor as fee, seller_amount_minor as seller, data::text as data from orders where coalesce((data->>'commissionRateBps')::int, 1000) <> 1000 order by id",
    )
  ).rows;
  [{ count: paymentIntentCountAtStart }] = (await pool.query("select count(*)::int as count from payment_intents")).rows;
});

// ─── Commission invariant ────────────────────────────────────────────────────

await acceptance("E01", "a normal new order uses the current 1000 bps commission", async () => {
  const created = await buy(buyer, L.charger!);
  const [row] = await db.select().from(orders).where(eq(orders.id, created.id));
  assert.equal(row!.data.commissionRateBps, 1000);
  assert.equal(row!.platformFeeMinor, Math.round((row!.subtotalMinor * 1000) / 10_000));
  assert.equal(row!.sellerAmountMinor, row!.subtotalMinor - row!.platformFeeMinor);
});

// ─── Promotions over REST ────────────────────────────────────────────────────

await acceptance("E31", "client price tampering is rejected and the server price is used", async () => {
  const tampered = await purchase(sellerA, L.lamp1!, plan.other7!, { priceMinor: 1 });
  assert.equal(tampered.status, 400, tampered.raw);
  const status = await purchase(sellerA, L.lamp1!, plan.other7!, { status: "ACTIVE" });
  assert.equal(status.status, 400, status.raw);
  const paid = await purchase(sellerA, L.lamp1!, plan.other7!, { paymentStatus: "SIMULATION_CAPTURED" });
  assert.equal(paid.status, 400, paid.raw);
  assert.equal((await campaignsFor(L.lamp1!)).length, 0, "rejected requests create nothing");
  const bought = await purchase(sellerA, L.lamp1!, plan.other7!);
  assert.equal(bought.status, 201, bought.raw);
  assert.equal(bought.data.priceMinor, 2_500);
  assert.equal(bought.data.priceLabel, "2.500 JOD");
  assert.equal(bought.data.status, "ACTIVE");
  promo.lamp1 = bought.data.id;
  security.clientPriceTampering = "REJECTED";
  security.statusTampering = "REJECTED";
});

await acceptance("E37", "promotion payment is simulated through the test adapter and moves no money", async () => {
  const [row] = await campaignsFor(L.lamp1!);
  assert.equal(row!.paymentMode, "DEVELOPMENT_SIMULATED");
  assert.equal(row!.paymentStatus, "SIMULATION_CAPTURED");
  assert.equal(row!.paymentProviderKey, "TEST_ADAPTER");
  assert.match(row!.paymentReference ?? "", /^sim_intent_/);
  const snapshot = await testOnlyPaymentAdapter.getSnapshot(row!.paymentReference!);
  assert.equal(snapshot?.status, "CAPTURED");
  assert.equal(snapshot?.capturedAmountMinor, 2_500);
  const view = await request(`/promotions/${row!.id}`, "GET", undefined, sellerA.cookie);
  assert.equal(view.data.paymentMode, "TEST_NO_TRANSFER");
  assert.equal(view.data.autoRenew, false);
  // A promotion is not an order payment.
  const [{ count }] = (await pool.query("select count(*)::int as count from payment_intents")).rows;
  assert.equal(count, paymentIntentCountAtStart, "no order payment intent is created for a promotion");
  const sellerOrders = await db.select().from(orders).where(eq(orders.buyerId, sellerA.id));
  assert.equal(sellerOrders.length, 0);
  const dues = await db.select().from(sellerDues).where(eq(sellerDues.sellerId, sellerA.id));
  assert.equal(dues.length, 0);
});

await acceptance("E10", "a relevant promoted listing is labelled sponsored in search", async () => {
  const found = await search(`مصباح ${runId}`);
  const lamp1 = found.find((item) => item.id === L.lamp1);
  assert.ok(lamp1, "promoted listing is found");
  assert.equal(lamp1.isSponsored, true);
  assert.equal(found[0]!.id, L.lamp1, "the one sponsored listing takes the first slot");
  assert.ok(found.filter((item) => item.id !== L.lamp1).every((item) => item.isSponsored !== true));
});

await acceptance("E18", "a listing that is both organic and sponsored appears once", async () => {
  const found = await search(`مصباح ${runId}`);
  assert.equal(found.filter((item) => item.id === L.lamp1).length, 1);
  assert.equal(new Set(found.map((item) => item.id)).size, found.length);
});

await acceptance("E11", "payment does not create relevance", async () => {
  const bought = await purchase(sellerA, L.sandwich!, plan.other3!);
  assert.equal(bought.status, 201, bought.raw);
  promo.sandwich = bought.data.id;
  for (const term of [`برادو ${runId}`, `سيارة برادو ${runId}`, `مصباح ${runId}`, `سماعة ${runId}`]) {
    const found = await search(term);
    assert.ok(!found.some((item) => item.id === L.sandwich), `${term} must not include the paid sandwich`);
  }
  // It still serves where it is genuinely relevant.
  const relevant = await search(`فلافل ${runId}`);
  assert.equal(relevant[0]?.id, L.sandwich);
  assert.equal(relevant[0]?.isSponsored, true);
});

await acceptance("E12", "an explicit hard filter always wins over promotion", async () => {
  const found = await search(`مصباح ${runId}`, { filters: [{ field: "price", operator: "lt", value: 18 }] });
  assert.ok(!found.some((item) => item.id === L.lamp1), "the promoted 20 JOD lamp fails the price ceiling");
  assert.ok(found.some((item) => item.id === L.lamp2));
  const otherCity = await search(`مصباح ${runId}`, { filters: [{ field: "city", operator: "eq", value: "الزرقاء" }] });
  assert.ok(!otherCity.some((item) => item.id === L.lamp1));
  const category = await search(`مصباح ${runId}`, { categoryId: "electronics" });
  assert.equal(category.length, 0);
});

await acceptance("E13", "a market A promotion never appears in market B", async () => {
  const found = await search(`مصباح ${runId}`, {}, KW);
  assert.equal(found.length, 0);
  const conv = await conversation(buyerKW);
  const result = await turn(buyerKW, conv, `مصباح ${runId}`);
  assert.ok(!result.listings.some((item: any) => item.id === L.lamp1));
});

await acceptance("E19", "the sponsored slot cap keeps organic results", async () => {
  for (const key of ["lamp3", "lamp4", "lamp5"]) {
    const bought = await purchase(sellerB, L[key]!, plan.other7!);
    assert.equal(bought.status, 201, bought.raw);
    promo[key] = bought.data.id;
  }
  const found = await search(`مصباح ${runId}`);
  const sponsored = found.filter((item) => item.isSponsored);
  assert.equal(sponsored.length, 2, "at most two paid slots per page");
  assert.deepEqual(found.slice(0, 2).map((item) => item.isSponsored), [true, true], "paid slots lead and are labelled");
  assert.ok(found.length >= 6, "organic lamps remain");
  assert.equal(new Set(found.map((item) => item.id)).size, found.length);
  // A user-chosen order (not the default view) is never reordered or labelled by payment.
  const sorted = await search(`مصباح ${runId}`, { sort: "PRICE_ASC" });
  assert.ok(sorted.every((item) => !item.isSponsored));
  const prices = sorted.map((item) => Number(item.unitPrice));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  // The web search page always sends the default order (NEWEST): it keeps the capped,
  // labelled slots; a user-chosen order does not.
  const web = await request(`/listings?search=${encodeURIComponent(runId)}&sort=NEWEST`, "GET", undefined, buyer.cookie);
  const webPaid = web.data.filter((item: any) => item.isSponsored);
  assert.equal(webPaid.length, 2);
  assert.deepEqual(web.data.slice(0, 2).map((item: any) => item.isSponsored), [true, true]);
  for (const item of webPaid) assert.equal((await servingCampaignsFor("JO", [item.id])).length, 1);
  const cheapest = await request(`/listings?search=${encodeURIComponent(runId)}&sort=PRICE_ASC`, "GET", undefined, buyer.cookie);
  assert.ok(cheapest.data.every((item: any) => item.isSponsored !== true));
});

await acceptance("E09", "repeated and concurrent confirmations create one campaign and one intent", async () => {
  const key = `blocke-same:${randomUUID()}`;
  const responses = await Promise.all(Array.from({ length: 5 }, () => purchase(sellerA, L.lamp6!, plan.other7!, {}, key)));
  const ids = new Set(responses.map((response) => response.data?.id));
  assert.equal(ids.size, 1, JSON.stringify(responses.map((response) => response.raw.slice(0, 120))));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.ok(responses.every((response) => [200, 201].includes(response.status)));
  const rows = await campaignsFor(L.lamp6!);
  assert.equal(rows.length, 1);
  assert.equal(new Set(rows.map((row) => row.paymentReference)).size, 1);
  promo.lamp6 = rows[0]!.id;
  // Reusing a key for a different request is refused.
  const reused = await purchase(sellerA, L.lamp2!, plan.other7!, {}, key);
  assert.equal(reused.status, 409);
  // Different keys racing on one listing: exactly one wins; no boost stacking.
  const race = await Promise.all(Array.from({ length: 4 }, () => purchase(sellerA, L.head1!, plan.electronics7!)));
  assert.equal(race.filter((response) => response.status === 201).length, 1, race.map((r) => r.status).join(","));
  assert.equal(race.filter((response) => response.status === 409).length, 3);
  const live = (await campaignsFor(L.head1!)).filter((row) => ["PENDING_PAYMENT", "ACTIVE", "PAUSED"].includes(row.status));
  assert.equal(live.length, 1);
  security.duplicateActivation = "REJECTED";
});

await acceptance("E08", "a failed simulated payment never activates", async () => {
  const declined = await purchase(sellerA, L.lantern!, plan.other7!, { simulatedPaymentOutcome: "DECLINE" });
  assert.equal(declined.status, 201, declined.raw);
  assert.equal(declined.data.status, "PAYMENT_FAILED");
  assert.equal(declined.data.paymentStatus, "SIMULATION_FAILED");
  assert.equal(declined.data.serving, false);
  assert.equal((await servingCampaignsFor("JO", [L.lantern!])).length, 0);
  const found = await search(`فانوس ${runId}`);
  assert.equal(found[0]?.id, L.lantern);
  assert.notEqual(found[0]?.isSponsored, true);
  // A failed attempt does not block a new explicit purchase.
  const retried = await purchase(sellerA, L.lantern!, plan.other7!);
  assert.equal(retried.data.status, "ACTIVE");
  promo.lantern = retried.data.id;
});

await acceptance("E17", "an expired campaign never serves even while its row still says ACTIVE", async () => {
  // Fixture: a captured campaign whose window ended, as if no sweeper had run.
  const now = Date.now();
  const [stale] = await db
    .insert(listingPromotions)
    .values({
      id: randomUUID(),
      listingId: L.vase1!,
      sellerId: sellerA.id,
      marketId: "JO",
      productId: plan.other7!,
      productNameSnapshot: "expired fixture",
      categoryIdSnapshot: "other",
      priceMinorSnapshot: 2_500,
      currencyCodeSnapshot: "JOD",
      placementSnapshot: "SEARCH_AND_CHAT",
      durationDaysSnapshot: 7,
      status: "ACTIVE",
      paymentStatus: "SIMULATION_CAPTURED",
      startsAt: new Date(now - 8 * 86_400_000),
      expiresAt: new Date(now - 86_400_000),
    })
    .returning();
  promo.expired = stale!.id;
  assert.equal((await servingCampaignsFor("JO", [L.vase1!])).length, 0);
  const found = await search(`مزهرية زجاج ${runId}`);
  assert.equal(found[0]?.id, L.vase1);
  assert.notEqual(found[0]?.isSponsored, true);
  const view = await request(`/promotions/${stale!.id}`, "GET", undefined, sellerA.cookie);
  assert.equal(view.data.status, "ACTIVE");
  assert.equal(view.data.effectiveStatus, "EXPIRED");
  assert.equal(view.data.serving, false);
  const paused = await request(`/promotions/${stale!.id}/actions`, "POST", { action: "RESUME" }, sellerA.cookie);
  assert.equal(paused.status, 409, "an expired campaign cannot be revived");
});

await acceptance("E38", "expiry never renews, charges again or creates a new campaign", async () => {
  const before = await pool.query("select count(*)::int as count from listing_promotions where listing_id = $1", [L.vase1]);
  const referencesBefore = await pool.query("select count(distinct payment_reference)::int as count from listing_promotions");
  await expireStalePromotions();
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.expired!));
  assert.equal(row!.status, "EXPIRED");
  const after = await pool.query("select count(*)::int as count from listing_promotions where listing_id = $1", [L.vase1]);
  assert.equal(after.rows[0].count, before.rows[0].count);
  const referencesAfter = await pool.query("select count(distinct payment_reference)::int as count from listing_promotions");
  assert.equal(referencesAfter.rows[0].count, referencesBefore.rows[0].count);
  // Terminal campaigns are final at the database level too.
  await assert.rejects(
    pool.query("update listing_promotions set status = 'ACTIVE' where id = $1", [promo.expired]),
    /terminal status is final/,
  );
});

await acceptance("E14", "moderation stops sponsored and organic serving; history is kept", async () => {
  const hidden = await request(`/admin/listings/${L.lamp1}/moderation`, "POST", { action: "HIDE", reason: "Block E moderation probe" }, admin.cookie);
  assert.equal(hidden.status, 200, hidden.raw);
  const found = await search(`مصباح ${runId}`);
  assert.ok(!found.some((item) => item.id === L.lamp1));
  assert.ok(!(await search(`مكتب خشبي ${runId}`)).length);
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.lamp1!));
  assert.equal(row!.status, "ACTIVE", "campaign history is retained");
  const view = await request(`/promotions/${promo.lamp1}`, "GET", undefined, sellerA.cookie);
  assert.equal(view.data.serving, false);
  const restored = await request(`/admin/listings/${L.lamp1}/moderation`, "POST", { action: "RESTORE", reason: "Block E restore probe" }, admin.cookie);
  assert.equal(restored.status, 200, restored.raw);
  const back = await search(`مكتب خشبي ${runId}`);
  assert.equal(back[0]?.id, L.lamp1);
  assert.equal(back[0]?.isSponsored, true, "restored resource with a still-valid campaign may serve again");
  security.moderatedActivePromotion = "HIDDEN";
});

await acceptance("E15", "a deactivated seller's campaign stops serving; history is kept", async () => {
  const bought = await purchase(sellerC, L.lampC!, plan.other7!);
  assert.equal(bought.data.status, "ACTIVE");
  promo.lampC = bought.data.id;
  assert.equal((await search(`مصباح نحاسي ${runId}`))[0]?.isSponsored, true);
  await db.transaction((tx) => deactivateOwnAccount(tx, sellerC.id));
  assert.equal((await search(`مصباح نحاسي ${runId}`)).length, 0);
  assert.ok(!(await search(`مصباح ${runId}`)).some((item) => item.id === L.lampC));
  const rows = await campaignsFor(L.lampC!);
  assert.equal(rows.length, 1, "campaign history remains");
  security.deactivatedSellerPromotion = "HIDDEN";
});

await acceptance("E16", "pausing or archiving a promoted listing stops serving without extending the window", async () => {
  const [before] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.lamp6!));
  const paused = await request(`/listings/${L.lamp6}/status`, "PATCH", { action: "PAUSE" }, sellerA.cookie);
  assert.equal(paused.status, 200, paused.raw);
  assert.ok(!(await search(`زيتي ${runId}`)).length);
  assert.equal((await request(`/promotions/${promo.lamp6}`, "GET", undefined, sellerA.cookie)).data.serving, false);
  const resumed = await request(`/listings/${L.lamp6}/status`, "PATCH", { action: "RESUME" }, sellerA.cookie);
  assert.equal(resumed.status, 200, resumed.raw);
  const [after] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.lamp6!));
  assert.equal(after!.expiresAt.toISOString(), before!.expiresAt.toISOString(), "no automatic extension");
  assert.equal((await request(`/promotions/${promo.lamp6}`, "GET", undefined, sellerA.cookie)).data.serving, true);
  // Inventory exhausted (TRACKED stock) also stops paid visibility.
  await db.update(offers).set({ availableQuantity: 0 }).where(eq(offers.id, L.lamp6!));
  assert.ok(!(await search(`زيتي ${runId}`)).length);
  assert.equal((await request(`/promotions/${promo.lamp6}`, "GET", undefined, sellerA.cookie)).data.serving, false);
  await db.update(offers).set({ availableQuantity: 5 }).where(eq(offers.id, L.lamp6!));
  // Archive: serving stops and the record stays.
  const archived = await request(`/listings/${L.sandwich}`, "DELETE", undefined, sellerA.cookie);
  assert.equal(archived.status, 200, archived.raw);
  assert.ok(!(await search(`فلافل ${runId}`)).length);
  const view = await request(`/promotions/${promo.sandwich}`, "GET", undefined, sellerA.cookie);
  assert.equal(view.status, 200);
  assert.equal(view.data.serving, false);
});

await acceptance("E02", "an order for a promoted listing uses the current 1000 bps commission", async () => {
  assert.equal((await request(`/promotions/${promo.lamp1}`, "GET", undefined, sellerA.cookie)).data.serving, true);
  const created = await buy(buyer, L.lamp1!);
  const [row] = await db.select().from(orders).where(eq(orders.id, created.id));
  assert.equal(row!.data.commissionRateBps, 1000);
  assert.equal(row!.platformFeeMinor, Math.round((row!.subtotalMinor * 1000) / 10_000));
});

await acceptance("E39", "an accepted campaign keeps its price snapshot after the plan changes", async () => {
  const changed = await request(`/admin/markets/JO/promotion-products/${plan.other7}`, "PATCH", { priceMinor: 3_000 }, admin.cookie);
  assert.equal(changed.status, 200, changed.raw);
  assert.equal((await request(`/promotions/${promo.lamp1}`, "GET", undefined, sellerA.cookie)).data.priceMinor, 2_500);
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.lamp1!));
  assert.equal(row!.priceMinorSnapshot, 2_500);
  const fresh = await purchase(sellerA, L.lamp2!, plan.other7!);
  assert.equal(fresh.status, 201, fresh.raw);
  assert.equal(fresh.data.priceMinor, 3_000);
  promo.lamp2 = fresh.data.id;
  await assert.rejects(
    pool.query("update listing_promotions set price_minor_snapshot = 1 where id = $1", [promo.lamp1]),
    /contract snapshot is immutable/,
  );
});

await acceptance("E40", "a disabled plan stops new purchases; existing campaigns run to their end", async () => {
  const disabled = await request(`/admin/markets/JO/promotion-products/${plan.other3}`, "PATCH", { enabled: false }, admin.cookie);
  assert.equal(disabled.status, 200, disabled.raw);
  const preview = await request(`/listings/${L.vase2}/promotion-preview`, "POST", { promotionProductId: plan.other3 }, sellerB.cookie);
  assert.equal(preview.status, 404);
  const rejectedPurchase = await purchase(sellerB, L.vase2!, plan.other3!);
  assert.equal(rejectedPurchase.status, 404);
  assert.equal((await campaignsFor(L.vase2!)).length, 0);
  // The sandwich campaign was bought on this plan: it keeps its own window (policy).
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.sandwich!));
  assert.equal(row!.status, "ACTIVE");
  const plans = await request("/promotion-products", "GET", undefined, sellerB.cookie);
  assert.ok(!plans.data.some((item: any) => item.id === plan.other3));
});

await acceptance("E32", "a client-supplied sponsored flag never makes a listing sponsored", async () => {
  const created = await request(
    "/listings",
    "POST",
    {
      title: `كوب سيراميك ${runId}`,
      description: `عرض اختبار ${runId} كوب`,
      category: "أخرى",
      categoryId: "other",
      area: "خلدا",
      city: "عمان",
      attributes: {},
      unitPrice: "2",
      inventoryMode: "LIMITED",
      availableQuantity: 3,
      fulfilmentType: "PICKUP",
      imageUrl: "",
      imageUrls: [],
      isSponsored: true,
      sponsored: true,
      promotionScore: 999,
      rank: 1,
    },
    sellerB.cookie,
  );
  assert.equal(created.status, 201, created.raw);
  L.cup = created.data.id;
  assert.notEqual(created.data.isSponsored, true);
  // Even stored listing data claiming sponsorship is ignored.
  await pool.query(`update offers set data = data || '{"isSponsored": true}'::jsonb where id = $1`, [L.cup]);
  const found = await search(`كوب ${runId}`);
  assert.equal(found[0]?.id, L.cup);
  assert.notEqual(found[0]?.isSponsored, true);
  const rest = await request(`/listings?search=${encodeURIComponent(`كوب سيراميك ${runId}`)}&sponsored=true`, "GET", undefined, buyer.cookie);
  assert.ok(rest.data.every((item: any) => item.isSponsored !== true));
  security.clientSponsoredFlag = "REJECTED";
});

await acceptance("E30", "seller B cannot read, buy for, pause, resume, cancel or inspect seller A campaigns", async () => {
  const id = promo.lamp1!;
  rejected(await request(`/promotions/${id}`, "GET", undefined, sellerB.cookie), [404], cross.seller, "read");
  for (const action of ["PAUSE", "RESUME", "CANCEL"])
    rejected(await request(`/promotions/${id}/actions`, "POST", { action }, sellerB.cookie), [404], cross.seller, action);
  rejected(await purchase(sellerB, L.lamp2!, plan.other7!), [404], cross.seller, "purchase for another seller's listing");
  rejected(
    await request(`/listings/${L.elantra}/promotion-preview`, "POST", { promotionProductId: plan.cars7 }, sellerB.cookie),
    [404],
    cross.seller,
    "preview another seller's listing",
  );
  const list = await request("/promotions", "GET", undefined, sellerB.cookie);
  cross.seller.total += 1;
  assert.ok(list.data.every((item: any) => [promo.lamp3, promo.lamp4, promo.lamp5].includes(item.id)), "analytics list is own-only");
  cross.seller.passed += 1;
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, id));
  assert.equal(row!.status, "ACTIVE", "nothing changed");
  // Status tampering: only server-defined transitions exist.
  const tamper = await request(`/promotions/${promo.lamp6}/actions`, "POST", { action: "ACTIVATE" }, sellerA.cookie);
  assert.equal(tamper.status, 400);
  const setStatus = await request(`/promotions/${promo.lamp6}/actions`, "POST", { action: "PAUSE", status: "ACTIVE" }, sellerA.cookie);
  assert.equal(setStatus.status, 400);
  // The order payment webhook path cannot activate a promotion.
  const webhook = await request(
    "/payments/webhooks/test",
    "POST",
    { id: "evt_x", type: "CAPTURE_SUCCEEDED", providerIntentId: row!.paymentReference, amountMinor: 1, currencyCode: "JOD" },
  );
  assert.ok([401, 404].includes(webhook.status), webhook.raw);
  // The admin campaign view is administrator-only.
  rejected(await request("/admin/markets/JO/promotions", "GET", undefined, sellerB.cookie), [403], cross.seller, "admin view");
  const adminView = await request("/admin/markets/JO/promotions", "GET", undefined, admin.cookie);
  assert.equal(adminView.status, 200);
  assert.ok(adminView.data.some((item: any) => item.id === id));
  assert.ok(!JSON.stringify(adminView.data).match(/phone|latitude|longitude|addressText/i));
});

await acceptance("E93", "cross-market purchase and management are refused", async () => {
  await setMarket(sellerA, "KW");
  try {
    rejected(await request(`/promotions/${promo.lamp1}`, "GET", undefined, sellerA.cookie), [404], cross.market, "read in KW");
    for (const action of ["PAUSE", "CANCEL"])
      rejected(await request(`/promotions/${promo.lamp1}/actions`, "POST", { action }, sellerA.cookie), [404], cross.market, action);
    rejected(await purchase(sellerA, L.head1!, plan.electronics7!), [404], cross.market, "buy JO listing from KW");
    const conv = await conversation(sellerA);
    const listed = await turn(sellerA, conv, "اعرض حملاتي");
    cross.market.total += 1;
    assert.equal(listed.promotion.promotions.length, 0, "KW shows no JO campaigns");
    cross.market.passed += 1;
  } finally {
    await setMarket(sellerA, "JO");
  }
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.lamp1!));
  assert.equal(row!.status, "ACTIVE");
});

// ─── Conversational seller flow ──────────────────────────────────────────────

let sellerConv = "";
let reviewActionId = "";
await acceptance("E04", "«روّج إعلاني» shows only the seller's own eligible listings", async () => {
  sellerConv = await conversation(sellerE);
  const options = await turn(sellerE, sellerConv, "روّج إعلاني");
  assert.equal(options.surface, "PROMOTION_OPTIONS", options.body);
  assert.equal(options.promotion.step, "LISTING");
  const ids = options.promotion.listings.map((item: any) => item.id).sort();
  assert.deepEqual(ids, [L["كرسي خشبي"], L["طاولة قهوة"], L["رف كتب"]].sort());
  const price = await turn(sellerE, sellerConv, "كم سعر الترويج؟");
  assert.equal(price.surface, "PROMOTION_OPTIONS");
  assert.equal(price.promotion.step, "INFO");
  const otherPlans = price.promotion.planGroups.find((group: any) => group.categoryId === "other");
  assert.ok(otherPlans.plans.some((item: any) => item.id === plan.other7 && item.priceLabel === "3.000 JOD"));
  // Explicit picker path: listing → plan → review → cancel creates nothing.
  const picker = await turn(sellerE, sellerConv, "أريد إعلان مميز");
  assert.equal(picker.promotion.step, "LISTING");
  const plans = await turn(sellerE, sellerConv, "الأول");
  assert.equal(plans.promotion.step, "PLAN", plans.body);
  assert.equal(plans.promotion.listing.id, picker.promotion.listings[0].id);
  const reviewed = await turn(sellerE, sellerConv, "أسبوع");
  assert.equal(reviewed.surface, "PROMOTION_REVIEW", reviewed.body);
  const cancelled = await turn(sellerE, sellerConv, "إلغاء");
  assert.match(cancelled.body, /أُلغي طلب الترويج/);
  assert.equal((await campaignsFor(picker.promotion.listings[0].id)).length, 0);
});

await acceptance("W5-A1", "generic promotion entry selects an owned listing and only canonical V3 products", async () => {
  const productIds = [randomUUID(), randomUUID()];
  await db.update(promotionProducts)
    .set({ enabled: false })
    .where(and(eq(promotionProducts.marketId, "JO"), like(promotionProducts.name, "Wave5 %")));
  await db.insert(promotionProducts).values([
    { id: productIds[0]!, marketId: "JO", categoryId: "other", name: `Wave5 Featured ${runId}`, placement: "FEATURED", productType: "FEATURED_LISTING", priceMinor: 5_000, currencyCode: "JOD", durationDays: 7, enabled: true, createdBy: admin.id },
    { id: productIds[1]!, marketId: "JO", categoryId: "other", name: `Wave5 VIP ${runId}`, placement: "VIP", productType: "VIP_LISTING", priceMinor: 7_000, currencyCode: "JOD", durationDays: 7, enabled: true, createdBy: admin.id },
  ]);
  try {
    const conv = await conversation(sellerE);
    const picker = await turn(sellerE, conv, "روّج إعلاني");
    assert.equal(picker.surface, "PROMOTION_TYPE_OPTIONS");
    assert.equal(picker.payload.commerce.step, "LISTING");
    const products = await turn(sellerE, conv, "الثاني");
    assert.equal(products.surface, "PROMOTION_TYPE_OPTIONS");
    assert.equal(products.payload.commerce.step, "PRODUCT");
    assert.equal(products.payload.commerce.products.length, 2);
    assert.deepEqual(new Set(products.payload.commerce.products.map((item: any) => item.id)), new Set(productIds));
    const review = await turn(sellerE, conv, "الثاني");
    assert.equal(review.surface, "VIP_REVIEW");
    assert.match(review.body, /رصيدك التجاري غير كافٍ/);
    assert.equal(review.payload.commerce.action, undefined);
    assert.equal((await campaignsFor(products.payload.commerce.listing.id)).length, 0);

    // Fund only through the canonical disposable TEST_NO_TRANSFER flow, then
    // prove an exact pending review activates one canonical V3 campaign.
    const topupConv = await conversation(sellerE);
    const topup = await turn(sellerE, topupConv, "اشحن 10 دينار");
    assert.equal(topup.surface, "COMMERCIAL_TOPUP_REVIEW", topup.body);
    assert.match(topup.body, /TEST_NO_TRANSFER/);
    const credited = await turn(sellerE, topupConv, "تأكيد");
    assert.match(credited.body, /دون تحويل أموال حقيقية/);

    const activationConv = await conversation(sellerE);
    const ownListings = await turn(sellerE, activationConv, "روّج إعلاني");
    const vipListingPicker = await turn(sellerE, activationConv, "أبي VIP لإعلاني");
    assert.equal(vipListingPicker.surface, "PROMOTION_TYPE_OPTIONS");
    assert.equal(vipListingPicker.payload.commerce.productType, "VIP_LISTING");
    const vipReview = await turn(sellerE, activationConv, "الأول");
    assert.equal(vipReview.surface, "VIP_REVIEW", vipReview.body);
    assert.equal(vipReview.payload.commerce.review.product.id, productIds[1]);
    assert.equal(vipReview.payload.commerce.review.listing.id, ownListings.payload.commerce.listings[0].id);
    assert.equal(vipReview.payload.commerce.action.status, "PENDING");
    assert.match(vipReview.body, /لن يُفعّل شيء قبل تأكيدك/);
    assert.equal((await campaignsFor(ownListings.payload.commerce.listings[0].id)).length, 0);

    const activated = await turn(sellerE, activationConv, "تأكيد");
    assert.equal(activated.surface, "CAMPAIGN_STATUS", activated.body);
    const afterConfirm = await campaignsFor(ownListings.payload.commerce.listings[0].id);
    assert.equal(afterConfirm.length, 1, "one V3 campaign is created");
    promo.sellerEVip = afterConfirm[0]!.id;
    assert.deepEqual([afterConfirm[0]!.status, afterConfirm[0]!.paymentStatus, afterConfirm[0]!.paymentSource, afterConfirm[0]!.productTypeSnapshot], ["ACTIVE", "BALANCE_CHARGED", "COMMERCIAL_BALANCE", "VIP_LISTING"]);
    await turn(sellerE, activationConv, "تأكيد");
    assert.equal((await campaignsFor(ownListings.payload.commerce.listings[0].id)).length, 1, "a repeated confirmation creates no duplicate campaign");
  } finally {
    for (const id of productIds) {
      const { rows } = await pool.query("select 1 from listing_promotions where product_id = $1 limit 1", [id]);
      if (rows.length === 0) await db.delete(promotionProducts).where(eq(promotionProducts.id, id));
      else await db.update(promotionProducts).set({ enabled: false }).where(eq(promotionProducts.id, id));
    }
  }
});

await acceptance("E05", "«روّج الإعلان الثاني لمدة 7 أيام» reads ordinal 2 and 7 days", async () => {
  assert.deepEqual(parsePromotionDuration(normalizePromotionText("روّج الإعلان الثاني لمدة 7 أيام")), { days: 7, rest: "روج الاعلان الثاني" });
  assert.equal(parsePromotionDuration(normalizePromotionText("روّج المنتج الأول لمدة أسبوع"))?.days, 7);
  assert.equal(parsePromotionDuration(normalizePromotionText("روّج الإعلان الثالث لمدة ٣ أيام"))?.days, 3);
  const mine = await turn(sellerE, sellerConv, "إعلاناتي");
  assert.equal(mine.surface, "MY_LISTINGS", mine.body);
  const [context] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, mine.resultSetId));
  assert.ok(context!.resourceIds.length >= 3);
  const reviewed = await turn(sellerE, sellerConv, "روّج الإعلان الثاني لمدة 7 أيام");
  assert.equal(reviewed.surface, "PROMOTION_REVIEW", reviewed.body);
  assert.equal(reviewed.promotion.review.listingId, context!.resourceIds[1]);
  assert.equal(reviewed.promotion.review.plan.durationDays, 7);
  reviewActionId = reviewed.promotion.action.actionId;
});

await acceptance("E06", "the review shows listing, placement, duration, price and currency before anything is active", async () => {
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, reviewActionId));
  const listingId = (set!.query as any).action.listingId;
  const history = await request(`/ai/conversations/${sellerConv}`, "GET", undefined, sellerE.cookie);
  const block = history.data.messages.at(-1).blocks[0];
  const review = block.payload.promotion.review;
  assert.equal(review.listingId, listingId);
  assert.ok(["كرسي خشبي", "طاولة قهوة", "رف كتب"].includes(review.listingTitle));
  assert.equal(review.plan.durationDays, 7);
  assert.equal(review.plan.priceLabel, "3.000 JOD");
  assert.equal(review.plan.currencyCode, "JOD");
  assert.match(review.placementLabel, /إعلان ممول/);
  assert.equal(block.payload.promotion.action.status, "PENDING");
  assert.equal(block.payload.promotion.autoRenew, false);
  assert.equal((await campaignsFor(listingId)).length, 0, "nothing is bought before confirmation");
});

await acceptance("E07", "explicit confirmation pays through the simulation and activates", async () => {
  const confirmed = await turn(sellerE, sellerConv, "تأكيد");
  assert.equal(confirmed.surface, "PROMOTION_STATUS", confirmed.body);
  assert.match(confirmed.body, /دون تحويل أموال حقيقية/);
  assert.equal(confirmed.promotion.promotion.status, "ACTIVE");
  assert.equal(confirmed.promotion.promotion.paymentStatus, "SIMULATION_CAPTURED");
  promo.sellerE = confirmed.promotion.promotion.id;
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, promo.sellerE!));
  assert.equal(row!.idempotencyKey, `promotion-action:${reviewActionId}`);
  assert.equal((await testOnlyPaymentAdapter.getSnapshot(row!.paymentReference!))?.status, "CAPTURED");
  // Repeated and concurrent confirmation of the same review: one campaign, one intent.
  const again = await Promise.all(
    Array.from({ length: 3 }, () => request(`/ai/promotion-actions/${reviewActionId}/action`, "POST", { action: "CONFIRM" }, sellerE.cookie)),
  );
  assert.ok(again.every((response) => response.status === 200 && response.data.promotionId === promo.sellerE));
  assert.equal((await campaignsFor(row!.listingId)).length, 1);
  // Another seller cannot use this action.
  const foreign = await request(`/ai/promotion-actions/${reviewActionId}/action`, "POST", { action: "CONFIRM" }, sellerB.cookie);
  assert.equal(foreign.status, 404);
  const found = await search(`${(await db.select().from(offers).where(eq(offers.id, row!.listingId)))[0]!.data.title} ${runId}`);
  assert.equal(found[0]?.isSponsored, true);
});

await acceptance("E-MANAGE", "«اعرض حملاتي», pause, resume and cancel by persisted ordinals", async () => {
  const list = await turn(sellerE, sellerConv, "اعرض حملاتي");
  assert.equal(list.surface, "MY_PROMOTIONS");
  const listedIds = list.promotion.promotions.map((item: any) => item.id);
  assert.equal(listedIds.length, 2, "both campaigns created by this seller's fixtures are listed");
  assert.deepEqual(new Set(listedIds), new Set([promo.sellerE, promo.sellerEVip]));
  const firstId = listedIds[0];
  const [row] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, firstId));
  const paused = await turn(sellerE, sellerConv, "أوقف الترويج الأول");
  assert.equal(paused.promotion.promotion.status, "PAUSED", paused.body);
  assert.equal(paused.promotion.promotion.id, firstId, "ordinal targets the first persisted campaign");
  assert.equal((await servingCampaignsFor("JO", [row!.listingId])).length, 0, "paused stops serving immediately");
  const resumed = await turn(sellerE, sellerConv, "استأنف الترويج");
  assert.equal(resumed.promotion.promotion.status, "ACTIVE", resumed.body);
  assert.equal(resumed.promotion.promotion.id, firstId);
  const [after] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, firstId));
  assert.equal(after!.expiresAt.toISOString(), row!.expiresAt.toISOString(), "resume never extends");
  const details = await turn(sellerE, sellerConv, "ما الذي يعمل الآن؟");
  assert.equal(details.surface, "MY_PROMOTIONS");
  // Invented ordinals never mutate anything.
  const invented = await turn(sellerE, sellerConv, "أوقف الترويج رقم 9");
  assert.match(invented.body, /غير موجود/);
  const [stillActive] = await db.select().from(listingPromotions).where(eq(listingPromotions.id, firstId));
  assert.equal(stillActive!.status, "ACTIVE");
});

// ─── Recommendations ─────────────────────────────────────────────────────────

const reasonsOk = (anchor: any, item: any) => {
  for (const reason of item.recommendationReasons ?? []) {
    if (reason === "من نفس الفئة") assert.equal(item.categoryId, anchor.categoryId);
    else if (reason === "أرخص مما شاهدته") assert.ok(Number(item.unitPrice) < Number(anchor.unitPrice), reason);
    else if (reason === "قريب من سعر ما شاهدته")
      assert.ok(Math.abs(Number(item.unitPrice) - Number(anchor.unitPrice)) / Number(anchor.unitPrice) <= 0.2, reason);
    else if (reason.startsWith("متوفر في ")) assert.equal(item.city, reason.slice("متوفر في ".length));
    else if (reason.startsWith("نفس ")) {
      for (const pair of reason.slice(4).split("، ")) {
        const [, value] = pair.split(": ");
        assert.ok(Object.values(item.attributes ?? {}).map(String).includes(value!), reason);
        assert.ok(Object.values(anchor.attributes ?? {}).map(String).includes(value!), reason);
      }
    } else if (reason === "مشابه لما شاهدته") assert.ok(item.categoryId === anchor.categoryId);
    else assert.fail(`unexpected reason ${reason}`);
  }
};
async function liveListing(id: string) {
  return (await searchMarketplaceListings(JO, { search: "", allowedIds: [id], limit: 1 }))[0]!;
}

await acceptance("E20", "a generic product gets similar internal alternatives", async () => {
  const conv = await conversation(buyer);
  const found = await turn(buyer, conv, `ابحث عن سماعة بلوتوث ${runId}`);
  assert.equal(found.listings[0]?.id, L.head1, found.body);
  const opened = await turn(buyer, conv, "الأول");
  assert.equal(opened.payload.presentation, "DETAILS");
  const similar = await turn(buyer, conv, "أرني أشياء مشابهة");
  assert.equal(similar.blockType, "LISTING_RESULTS", similar.body);
  const ids = similar.listings.map((item: any) => item.id);
  assert.ok(ids.includes(L.head2), "the other headset is similar");
  assert.ok(!ids.includes(L.head1), "the viewed listing is not repeated");
  assert.ok(!ids.includes(L.charger), "an unrelated electronics item is not similar");
  const anchor = await liveListing(L.head1!);
  for (const item of similar.listings) reasonsOk(anchor, item);
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, similar.resultSetId));
  assert.equal((set!.query as any).recommendation.anchorId, L.head1);
  assert.deepEqual(set!.resourceIds, ids, "recommendations are a persisted result set");
});

let carConv = "";
let carRecommendation: TurnResult;
await acceptance("E21", "vehicle: similar but cheaper through the same generic recommender", async () => {
  carConv = await conversation(buyer);
  const found = await turn(buyer, carConv, `ابحث عن برادو ${runId}`);
  const shown = found.listings.map((item: any) => item.id);
  assert.deepEqual([...shown].sort(), [L.prado18, L.prado15].sort(), found.body);
  carRecommendation = await turn(buyer, carConv, "أرني شيء مشابه لكن أرخص");
  assert.equal(carRecommendation.blockType, "LISTING_RESULTS", carRecommendation.body);
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, carRecommendation.resultSetId));
  const anchor = await liveListing((set!.query as any).recommendation.anchorId);
  assert.ok(shown.includes(anchor.id));
  const ids = carRecommendation.listings.map((item: any) => item.id);
  assert.ok(ids.includes(L.cruiser), "a cheaper Toyota is suggested");
  assert.ok(carRecommendation.listings.every((item: any) => item.categoryId === "cars"));
  assert.ok(carRecommendation.listings.every((item: any) => Number(item.unitPrice) < Number(anchor.unitPrice)));
  assert.ok(!ids.some((id: string) => shown.includes(id)), "shown results are not repeated");
  const cruiser = carRecommendation.listings.find((item: any) => item.id === L.cruiser);
  assert.ok(cruiser.recommendationReasons.some((reason: string) => reason.includes("تويوتا")));
  for (const item of carRecommendation.listings) reasonsOk(anchor, item);
});

await acceptance("E24", "«الثاني» opens the exact second recommendation; invented ids are rejected", async () => {
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, carRecommendation.resultSetId));
  assert.ok(set!.resourceIds.length >= 2, "at least two recommendations");
  const opened = await turn(buyer, carConv, "الثاني");
  assert.equal(opened.payload.presentation, "DETAILS");
  assert.equal(opened.listings[0]?.id, set!.resourceIds[1]);
  const invented = await request(
    `/ai/conversations/${carConv}/actions/add-to-cart`,
    "POST",
    { resultSetId: carRecommendation.resultSetId, resourceId: randomUUID() },
    buyer.cookie,
  );
  assert.equal(invented.status, 409);
  const foreignSet = await request(
    `/ai/conversations/${carConv}/actions/add-to-cart`,
    "POST",
    { resultSetId: randomUUID(), resourceId: set!.resourceIds[0] },
    buyer.cookie,
  );
  assert.equal(foreignSet.status, 409);
});

await acceptance("E25", "«أرخص» and «في عمان» refine the recommendation with safe filters", async () => {
  const back = await turn(buyer, carConv, "رجعني");
  assert.equal(back.resultSetId, carRecommendation.resultSetId);
  const cheaper = await turn(buyer, carConv, "أرخص");
  assert.equal(cheaper.blockType, "LISTING_RESULTS", cheaper.body);
  assert.notEqual(cheaper.resultSetId, carRecommendation.resultSetId, "a new persisted result set");
  const prices = cheaper.listings.map((item: any) => Number(item.unitPrice));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const [set] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, cheaper.resultSetId));
  const anchor = await liveListing((set!.query as any).recommendation.anchorId);
  assert.ok(prices.every((price: number) => price < Number(anchor.unitPrice)));
  const amman = await turn(buyer, carConv, "في عمان");
  assert.equal(amman.blockType, "LISTING_RESULTS", amman.body);
  assert.ok(amman.listings.length > 0);
  assert.ok(amman.listings.every((item: any) => item.city === "عمان"));
  assert.ok(!amman.listings.some((item: any) => item.id === L.elantra), "Zarqa listing filtered out");
  for (const item of [...cheaper.listings, ...amman.listings]) reasonsOk(anchor, item);
});

await acceptance("E22", "service alternatives use the same generic mechanism", async () => {
  const conv = await conversation(buyer);
  const found = await turn(buyer, conv, `ابحث عن سباكة منزلية ${runId}`);
  assert.equal(found.listings[0]?.id, L.plumb, found.body);
  await turn(buyer, conv, "الأول");
  const alternatives = await turn(buyer, conv, "اقترح لي بدائل");
  const ids = alternatives.listings.map((item: any) => item.id);
  assert.ok(ids.includes(L.plumb2));
  assert.ok(!ids.includes(L.math), "an unrelated service is not an alternative");
  assert.ok(!ids.includes(L.plumb));
  const anchor = await liveListing(L.plumb!);
  for (const item of alternatives.listings) reasonsOk(anchor, item);
});

await acceptance("E23", "generic «Other» listings are recommendable", async () => {
  const conv = await conversation(buyer);
  await turn(buyer, conv, `ابحث عن مزهرية زجاج ${runId}`);
  await turn(buyer, conv, "الأول");
  const similar = await turn(buyer, conv, "أرني من نفس النوع");
  assert.equal(similar.blockType, "LISTING_RESULTS", similar.body);
  const ids = similar.listings.map((item: any) => item.id);
  assert.ok(ids.includes(L.vase2));
  assert.ok(!ids.includes(L.mop));
  assert.doesNotMatch(similar.body, /غير مدعوم|UNSUPPORTED/);
});

await acceptance("E26", "every recommendation reason corresponds to a real signal", async () => {
  // Checked per listing in E20–E25; here the advice-only path (no context) is checked too.
  const conv = await conversation(buyer);
  const advice = await turn(buyer, conv, "ما الذي تنصحني به؟");
  assert.equal(advice.blockType, "LISTING_RESULTS", advice.body);
  assert.ok(advice.listings.length > 0);
  for (const item of advice.listings) assert.deepEqual(item.recommendationReasons, ["من أحدث العروض في سوقك"]);
  const created = advice.listings.map((item: any) => new Date(item.createdAt).getTime());
  assert.deepEqual(created, [...created].sort((a, b) => b - a), "newest first, as the reason says");
});

await acceptance("E27", "a relevant promoted listing may take one labelled recommendation slot; an irrelevant one never", async () => {
  for (const key of ["plumb2", "math"]) {
    const bought = await purchase(sellerB, L[key]!, plan.services7!);
    assert.equal(bought.data.status, "ACTIVE", bought.raw);
    promo[key] = bought.data.id;
  }
  const conv = await conversation(buyer);
  await turn(buyer, conv, `ابحث عن سباكة منزلية ${runId}`);
  await turn(buyer, conv, "الأول");
  const alternatives = await turn(buyer, conv, "أرني بدائل");
  assert.ok(alternatives.listings.some((item: any) => item.id === L.plumb2), "relevant promoted service is recommended");
  // One labelled slot, taken by a relevant serving campaign (earlier runs in the same
  // disposable database may own an identical relevant listing with its own campaign).
  const sponsored = alternatives.listings.filter((item: any) => item.isSponsored);
  assert.equal(sponsored.length, 1);
  assert.equal(alternatives.listings[0].id, sponsored[0].id);
  assert.match(sponsored[0].title, /سباكة/);
  assert.equal((await servingCampaignsFor("JO", [sponsored[0].id])).length, 1);
  assert.ok(!alternatives.listings.some((item: any) => /رياضيات/.test(item.title)), "paid irrelevant service never appears");
});

await acceptance("E33", "reload restores promotion state and recommendation context from the server", async () => {
  const history = await request(`/ai/conversations/${sellerConv}`, "GET", undefined, sellerE.cookie);
  const blocks = history.data.messages.flatMap((message: any) => message.blocks);
  const review = blocks.find((block: any) => block.payload.resultSetId === reviewActionId);
  assert.equal(review.payload.promotion.action.status, "CONFIRMED");
  const list = blocks.filter((block: any) => block.payload.surface === "MY_PROMOTIONS").at(-1);
  assert.equal(list.payload.promotion.promotions[0].status, "ACTIVE");
  const cars = await request(`/ai/conversations/${carConv}`, "GET", undefined, buyer.cookie);
  const restored = cars.data.messages
    .flatMap((message: any) => message.blocks)
    .find((block: any) => block.payload.resultSetId === carRecommendation.resultSetId);
  assert.ok(restored.payload.listings.every((item: any) => Array.isArray(item.recommendationReasons)));
});

// ─── Firewalls ───────────────────────────────────────────────────────────────

const source = async (relative: string) => readFile(join(process.cwd(), relative), "utf8");
const blockESources = [
  "src/lib/promotions.ts",
  "src/lib/recommendations.ts",
  "src/ai/promotion-turn.ts",
  "src/routes/promotions.ts",
];

await acceptance("E28", "money never enters employment matching or ranking", async () => {
  for (const file of ["src/lib/employment.ts", "src/ai/employment-turn.ts", "src/ai/employment-parser.ts"]) {
    const text = await source(file);
    assert.doesNotMatch(text, /promotion|sponsor|listing_promotions|listingPromotions|recommend/i, file);
  }
  for (const file of blockESources)
    assert.doesNotMatch(await source(file), /from "\.\.?\/(?:lib\/)?employment|candidateProfiles|jobApplications|\bjobs\b/, file);
  await updateOwnProfile(sellerA.id, JO, { professionalTitle: "فني سباكة", addSkills: [`سباكة${runId}`], visibility: "DISCOVERABLE", city: "عمان" });
  await updateOwnProfile(sellerB.id, JO, { professionalTitle: "فني سباكة", addSkills: [`سباكة${runId}`], visibility: "DISCOVERABLE", city: "عمان" });
  const state = { terms: [], skills: [`سباكة${runId}`], workplaceModes: [] };
  const before = (await searchCandidates(JO, buyer.id, state)).map((row) => row.id);
  const jobsBefore = (await searchJobs(JO, { terms: [], skills: [], workplaceModes: [], employmentTypes: [], sort: "RELEVANCE" })).map((row) => row.id);
  // Seller A buys yet another promotion; candidate and job ranking must not move.
  const bought = await purchase(sellerA, L.plumb!, plan.services7!);
  assert.equal(bought.data.status, "ACTIVE");
  const after = (await searchCandidates(JO, buyer.id, state)).map((row) => row.id);
  const jobsAfter = (await searchJobs(JO, { terms: [], skills: [], workplaceModes: [], employmentTypes: [], sort: "RELEVANCE" })).map((row) => row.id);
  assert.deepEqual(after, before);
  assert.deepEqual(jobsAfter, jobsBefore);
  assert.equal(before.length, 2);
});

await acceptance("E29", "precise transaction location, auth phone and protected data never feed promotion or recommendation", async () => {
  for (const file of [...blockESources, "src/ai/intent.ts"]) {
    const text = await source(file);
    assert.doesNotMatch(text, /transactionLocations|transaction_locations|latitude|longitude|accuracyMeters|addressText|normalizedPhone|phoneNumber|users\.city|religion|ethnic|gender|nationality/i, file);
  }
  const conv = await conversation(buyer);
  await turn(buyer, conv, `مزهرية زجاج ${runId}`);
  const nearby = await turn(buyer, conv, "أريد منتجات قريبة");
  const text = JSON.stringify(nearby.payload);
  assert.doesNotMatch(text, /latitude|longitude|addressText|normalizedPhone/);
  const promotions = await request("/promotions", "GET", undefined, sellerA.cookie);
  assert.doesNotMatch(JSON.stringify(promotions.data), /latitude|longitude|addressText|phone|buyer|viewer/i);
});

await acceptance("E03", "historical commission snapshots are unchanged", async () => {
  assert.ok(legacyOrders.length > 0, "the isolated test fixture includes a historical commission snapshot");
  const now = (
    await pool.query(
      "select id, platform_fee_minor as fee, seller_amount_minor as seller, data::text as data from orders where id = any($1) order by id",
      [legacyOrders.map((row) => row.id)],
    )
  ).rows;
  assert.deepEqual(now, legacyOrders);
  assert.ok(now.some((row) => JSON.parse(row.data).commissionRateBps === 1500), "the historical 1500-bps snapshot remains intact");
});

await acceptance("E35", "deterministic Block E phrases make zero model calls", async () => {
  assert.equal(providerConfigured, false);
  assert.ok(modelCalls.length >= 30);
  assert.equal(modelCalls.reduce((sum, call) => sum + call.calls, 0), 0);
  for (const phrase of ["روّج إعلاني", "اعرض حملاتي", "أوقف الترويج الأول", "أرني أشياء مشابهة", "أرخص", "الثاني"])
    assert.ok(modelCalls.some((call) => call.phrase === phrase), phrase);
  assert.equal(getModelGatewayCallCount(), 0);
});

await acceptance("E36", "no external marketplace, recommendation or ad network request", async () => {
  assert.deepEqual(external, []);
  for (const file of blockESources)
    assert.doesNotMatch(
      await source(file),
      /https?:\/\/|amazon|ebay|temu|aliexpress|google|facebook|opensooq|stripe|paypal|myfatoorah|knet|fetch\(/i,
      file,
    );
});

// ─── Connected browser journeys ─────────────────────────────────────────────

await acceptance("E34", "connected seller promotion and buyer recommendation journeys at 320/360/390/414", async () => {
  const browserSeller = await register("Browser Seller");
  const browserBuyer = await register("Browser Buyer");
  const listingTitle = `ثريا كريستال فاخرة جدًا بإضاءة دافئة ${runId}`;
  const promoted = await publish(browserSeller, { categoryId: "other", category: "أخرى", title: listingTitle, price: "45" });
  await publish(browserSeller, { categoryId: "other", category: "أخرى", title: `ثريا نحاسية ${runId}`, price: "35" });
  await publish(browserSeller, { categoryId: "other", category: "أخرى", title: `ثريا صغيرة ${runId}`, price: "25" });
  const web = await startDinarBrowserTestWeb();
  const resultPath = `/tmp/dinar-blocke-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/block-e-ui-acceptance.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        BLOCKE_WEB_BASE: web.baseUrl,
        BLOCKE_API_ORIGIN: `http://127.0.0.1:${port}`,
        BLOCKE_SELLER_COOKIE: browserSeller.cookie,
        BLOCKE_BUYER_COOKIE: browserBuyer.cookie,
        BLOCKE_RUN_ID: runId,
        BLOCKE_LISTING_TITLE: listingTitle,
        BLOCKE_LISTING_ID: promoted,
        BLOCKE_UI_RESULT_PATH: resultPath,
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
  console.log("BLOCKE_BROWSER", JSON.stringify({ ...browserReport, checks: browserReport?.checks?.length }));
  if (browserError && !browserReport) throw browserError;
  assert.ok(browserReport, "browser acceptance must report");
  assert.equal(browserReport.failure, undefined, browserReport.failure);
  assert.deepEqual(browserReport.pageErrors, []);
  assert.deepEqual(browserReport.consoleErrors, []);
  assert.equal(browserReport.horizontalOverflow, 0);
  assert.deepEqual(browserReport.externalRequests, []);
  assert.equal(browserReport.unlabeledSponsored, 0);
  // Server state the browser created is real.
  const rows = await campaignsFor(promoted);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "ACTIVE");
  assert.equal(rows[0]!.paymentStatus, "SIMULATION_CAPTURED");
  assert.equal(browserReport.commerce.listingId, promoted);
  assert.equal(browserReport.commerce.checkoutRequests, 1);
  const actualOrders = await db.select().from(orders).where(eq(orders.buyerId, browserBuyer.id));
  assert.equal(actualOrders.length, 1, "the fresh browser buyer has exactly one authoritative order");
  const ordered = actualOrders[0]!;
  assert.equal(ordered.id, browserReport.commerce.orderId);
  assert.equal(ordered.sellerId, browserSeller.id);
  assert.equal(ordered.status, "CREATED");
  assert.equal(ordered.currencyCode, "JOD");
  assert.equal(ordered.subtotalMinor, 45_000);
  assert.equal(ordered.platformFeeMinor + ordered.sellerAmountMinor, ordered.subtotalMinor);
  assert.equal(ordered.orderLineIntegrityVersion, 1);
  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, ordered.id));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.offerId, promoted);
  assert.equal(lines[0]!.quantity, 1);
  assert.equal(lines[0]!.unitPriceMinor, 45_000);
  const [stock] = await db.select().from(offers).where(eq(offers.id, promoted));
  assert.equal(stock?.reservedQuantity, 1, "checkout reserves the advertised stock through the canonical service");
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, ordered.id))).length, 0, "cash checkout never creates a paid provider intent");
  assert.equal(getModelGatewayCallCount(), 0, "browser journeys must not reach the model");
});

await test("cleanup: switch off this run's plans", async () => {
  await db
    .update(promotionProducts)
    .set({ enabled: false })
    .where(and(eq(promotionProducts.marketId, "JO"), like(promotionProducts.name, `Block E % ${runId}`)));
});

await test("summary", async () => {
  if (selectedCases) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    return;
  }
  const ids = Object.keys(results).sort();
  const passed = ids.filter((id) => results[id] === "PASS").length;
  const unlabeledSponsored = 0;
  console.log(
    "BLOCKE_SUMMARY",
    JSON.stringify({
      passed,
      total: ids.length,
      results,
      crossSeller: cross.seller,
      crossMarket: cross.market,
      security,
      modelCalls: modelCalls.reduce((sum, call) => sum + call.calls, 0),
      deterministicPhrases: modelCalls.length,
      externalRequests: external.length,
      unlabeledSponsored: unlabeledSponsored + (browserReport?.unlabeledSponsored ?? 0),
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
