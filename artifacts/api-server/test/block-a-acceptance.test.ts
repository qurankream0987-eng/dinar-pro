import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, desc, eq, inArray } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  db,
  markets,
  offers,
  pool,
  users,
} from "@workspace/db";
import {
  getModelGatewayCallCount,
  resetModelGatewayCallCount,
} from "../src/ai/model-gateway";
import { normalizeSearch } from "../src/ai/search-context";
import { executeRegisteredTool, ToolRejectedError } from "../src/ai/tool-registry";
import { DeterministicPhotoSuggestionProvider } from "../src/ai/listing-photo-intelligence";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKA_ACCEPTANCE");
// Any model call would throw and be counted; deterministic journeys must make none.
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const providerConfigured = Boolean(
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY,
);
const execFileAsync = promisify(execFile);

// Every outbound request from this process that leaves loopback is recorded by phase.
const external: { phase: string; host: string }[] = [];
let phase = "setup";
const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.replace(/:\d+$/, ""));
const recordUrl = (target: unknown) => {
  try {
    const url =
      target instanceof URL
        ? target
        : typeof target === "string"
          ? new URL(target)
          : target instanceof Request
            ? new URL(target.url)
            : undefined;
    if (url && !loopback(url.hostname)) external.push({ phase, host: url.hostname });
  } catch {
    // Non-URL inputs are request option objects handled below.
  }
};
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  recordUrl(input);
  return originalFetch(input, init);
}) as typeof fetch;
for (const module of [http, https] as any[]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = (...args: any[]) => {
      const first = args[0];
      if (typeof first === "string" || first instanceof URL) recordUrl(first);
      else if (first && typeof first === "object") {
        const host = String(first.hostname ?? first.host ?? "");
        if (host && !loopback(host)) external.push({ phase, host });
      }
      return original.apply(module, args);
    };
  }
}

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api`;
let authRequestSequence = 0;

type ApiResponse = { status: number; data: any; cookie: string; raw: string };

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
): Promise<ApiResponse> {
  const rateLimited = path.startsWith("/auth/");
  const ip = rateLimited
    ? `198.19.${Math.floor(authRequestSequence / 250) % 250}.${(authRequestSequence++ % 250) + 1}`
    : undefined;
  const effectiveBody =
    body === undefined && ["POST", "DELETE", "PATCH"].includes(method) ? {} : body;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { "X-Forwarded-For": ip } : {}),
    },
    body: effectiveBody === undefined ? undefined : JSON.stringify(effectiveBody),
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
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    raw,
  };
}

async function register(label: string, phoneNumber: string): Promise<{ id: string; cookie: string }> {
  const started = await request("/auth/phone-verification/challenges", "POST", {
    phoneCountryCode: "+965",
    phoneNumber,
  });
  assert.equal(started.status, 202, started.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: started.data.challengeId,
    code: started.data.developmentCode,
  });
  assert.equal(verified.status, 200, verified.raw);
  const password = `BlockA-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Block A ${label}`,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.ok(registered.cookie);
  const market = await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie);
  assert.equal(market.status, 200, market.raw);
  return { id: registered.data.user.id, cookie: registered.cookie };
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
const accepted: Record<string, string> = {};
let inventedIdsAccepted = 0;

async function turn(
  cookie: string,
  conversationId: string,
  message: string,
  imageObjectPaths?: string[],
): Promise<{ body: string; block: any; payload: any }> {
  const before = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message, ...(imageObjectPaths ? { imageObjectPaths } : {}) }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const complete = completion(raw);
  assert.ok(complete, `turn "${message}" did not complete: ${raw}`);
  const calls = getModelGatewayCallCount() - before;
  modelCalls.push({ phrase: message, calls });
  assert.equal(calls, 0, `model call for deterministic phrase ${message}`);
  const block = complete.assistantMessage.blocks[0];
  return { body: complete.assistantMessage.body, block, payload: block?.payload };
}

async function conversation(cookie: string): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

async function latestSet(conversationId: string) {
  const [row] = await db
    .select()
    .from(aiResultSets)
    .where(eq(aiResultSets.conversationId, conversationId))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  return row;
}

async function resultSetCount(conversationId: string): Promise<number> {
  return (
    await db
      .select({ id: aiResultSets.id })
      .from(aiResultSets)
      .where(eq(aiResultSets.conversationId, conversationId))
  ).length;
}

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
const fixtureIds: string[] = [];
const uploadedPhotos: string[] = [];
let browserWeb: Awaited<ReturnType<typeof startDinarBrowserTestWeb>> | undefined;

type Fixture = {
  key: string;
  categoryId: string;
  category: string;
  title: string;
  price: number;
  city: string;
  attributes?: Record<string, string | number>;
  status?: string;
  quantity?: number;
  createdOffsetMinutes: number;
};

/** Independent oracle: the published JO offers a buyer may discover, read straight from the DB. */
async function discoverable() {
  const rows = await db
    .select({ offer: offers, sellerStatus: users.status })
    .from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId))
    .where(and(eq(offers.marketId, "JO"), eq(offers.status, "PUBLISHED")));
  return rows
    .filter(
      ({ offer, sellerStatus }) =>
        sellerStatus === "ACTIVE" &&
        (offer.inventoryMode === "UNLIMITED" ||
          (offer.availableQuantity ?? 0) - offer.reservedQuantity > 0),
    )
    .map(({ offer }) => offer);
}
const text = (offer: typeof offers.$inferSelect) =>
  normalizeSearch(
    [
      offer.data.title,
      offer.data.description,
      offer.data.category,
      offer.data.city,
      offer.data.area,
      ...Object.values(offer.data.attributes ?? {}),
    ].join(" "),
  );
const priceOf = (offer: typeof offers.$inferSelect) => (offer.unitPriceMinor ?? 0) / 1000;
const attr = (offer: typeof offers.$inferSelect, field: string) =>
  offer.data.attributes?.[field];

await test("DINAR Block A conversational marketplace intelligence acceptance", async () => {
  resetModelGatewayCallCount();
  assert.equal(providerConfigured, false, "A10 runs with the external AI provider unconfigured");
  const [jo] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(jo?.isActive && jo.minorUnitScale === 3, "JO must be an active 3-decimal market");

  // Kuwaiti numbers from 51,800,000 up are invalid: the range stays below it.
  const phoneBase = 51_000_000 + ((Date.now() + process.pid) % 700_000);
  const buyer = await register("Buyer", String(phoneBase));
  const seller = await register("Seller", String(phoneBase + 3));
  const intruder = await register("Other", String(phoneBase + 6));

  const fixtures: Fixture[] = [
    // A01 electronics
    { key: "headsetBlack", categoryId: "electronics", category: "إلكترونيات", title: "سماعة آيفون لاسلكية سوداء", price: 45, city: "عمان", attributes: { condition: "جديد" }, createdOffsetMinutes: 1 },
    { key: "headsetWhite", categoryId: "electronics", category: "إلكترونيات", title: "سماعة آيفون لاسلكية بيضاء", price: 40, city: "عمان", attributes: { condition: "جديد" }, createdOffsetMinutes: 2 },
    { key: "phoneBlack", categoryId: "electronics", category: "إلكترونيات", title: "هاتف سامسونج أسود", price: 220, city: "عمان", attributes: { condition: "مستعمل" }, createdOffsetMinutes: 3 },
    { key: "headsetPaused", categoryId: "electronics", category: "إلكترونيات", title: "سماعة آيفون سوداء موقوفة", price: 30, city: "عمان", attributes: { condition: "جديد" }, status: "PAUSED", createdOffsetMinutes: 4 },
    // A02 vehicles
    { key: "benz2019", categoryId: "cars", category: "سيارات", title: "مرسيدس C200 موديل 2019", price: 7800, city: "عمان", attributes: { make: "مرسيدس", model: "C200", year: 2019, mileage: 90000, condition: "مستعمل" }, createdOffsetMinutes: 5 },
    { key: "benz2021", categoryId: "cars", category: "سيارات", title: "مرسيدس C200 موديل 2021", price: 8500, city: "عمان", attributes: { make: "مرسيدس", model: "C200", year: 2021, mileage: 70000, condition: "مستعمل" }, createdOffsetMinutes: 6 },
    { key: "benz2022", categoryId: "cars", category: "سيارات", title: "مرسيدس C180 موديل 2022", price: 7000, city: "عمان", attributes: { make: "مرسيدس", model: "C180", year: 2022, mileage: 40000, condition: "مستعمل" }, createdOffsetMinutes: 7 },
    { key: "benz2023", categoryId: "cars", category: "سيارات", title: "مرسيدس E200 موديل 2023", price: 9500, city: "عمان", attributes: { make: "مرسيدس", model: "E200", year: 2023, mileage: 20000, condition: "جديد" }, createdOffsetMinutes: 8 },
    { key: "benzIrbid", categoryId: "cars", category: "سيارات", title: "مرسيدس C200 موديل 2021 إربد", price: 6000, city: "إربد", attributes: { make: "مرسيدس", model: "C200", year: 2021, mileage: 80000, condition: "مستعمل" }, createdOffsetMinutes: 9 },
    { key: "camry", categoryId: "cars", category: "سيارات", title: "تويوتا كامري 2022", price: 6500, city: "عمان", attributes: { make: "تويوتا", model: "كامري", year: 2022, mileage: 30000, condition: "مستعمل" }, createdOffsetMinutes: 10 },
    // A03 property
    { key: "flatRent3", categoryId: "property", category: "عقارات", title: "شقة للإيجار ثلاث غرف في عبدون", price: 450, city: "عمان", attributes: { propertyType: "شقة", transactionType: "إيجار", bedrooms: 3, bathrooms: 2, area: 160 }, createdOffsetMinutes: 11 },
    { key: "flatRent2", categoryId: "property", category: "عقارات", title: "شقة للإيجار غرفتين", price: 300, city: "عمان", attributes: { propertyType: "شقة", transactionType: "إيجار", bedrooms: 2, bathrooms: 1, area: 100 }, createdOffsetMinutes: 12 },
    { key: "flatSale3", categoryId: "property", category: "عقارات", title: "شقة للبيع ثلاث غرف", price: 95000, city: "عمان", attributes: { propertyType: "شقة", transactionType: "بيع", bedrooms: 3, bathrooms: 2, area: 170 }, createdOffsetMinutes: 13 },
    { key: "flatIrbid3", categoryId: "property", category: "عقارات", title: "شقة للإيجار ثلاث غرف", price: 250, city: "إربد", attributes: { propertyType: "شقة", transactionType: "إيجار", bedrooms: 3, bathrooms: 1, area: 140 }, createdOffsetMinutes: 14 },
    // A04 home goods and services
    { key: "sofaCheap", categoryId: "home", category: "منزل", title: "كنب زاوية رمادي", price: 250, city: "عمان", attributes: { condition: "مستعمل" }, createdOffsetMinutes: 15 },
    { key: "sofaDear", categoryId: "home", category: "منزل", title: "كنب جلد فاخر", price: 400, city: "عمان", attributes: { condition: "جديد" }, createdOffsetMinutes: 16 },
    { key: "lamp", categoryId: "home", category: "منزل", title: "مصباح أرضي", price: 35, city: "عمان", attributes: { condition: "جديد" }, createdOffsetMinutes: 17 },
    { key: "cleaning", categoryId: "services", category: "خدمات", title: "خدمة تنظيف منازل شاملة", price: 25, city: "عمان", createdOffsetMinutes: 18 },
  ];
  const ids = new Map<string, string>();
  const createdBase = Date.now() - 60 * 60 * 1000;
  for (const fixture of fixtures) {
    const id = `blocka_${runId}_${fixture.key}`;
    ids.set(fixture.key, id);
    fixtureIds.push(id);
    await db.insert(offers).values({
      id,
      sellerId: seller.id,
      marketId: "JO",
      status: fixture.status ?? "PUBLISHED",
      unitPriceMinor: Math.round(fixture.price * 1000),
      inventoryMode: "LIMITED",
      availableQuantity: fixture.quantity ?? 1,
      reservedQuantity: 0,
      createdAt: new Date(createdBase + fixture.createdOffsetMinutes * 60_000),
      data: {
        title: fixture.title,
        description: `${fixture.title}. بيانات قبول Block A.`,
        category: fixture.category,
        categoryId: fixture.categoryId,
        city: fixture.city,
        area: "",
        attributes: fixture.attributes ?? {},
        imageUrl: "",
        imageUrls: [],
        fulfilmentType: fixture.categoryId === "services" ? "SERVICE" : "PICKUP",
        sellerName: "DINAR Block A Seller",
        rating: 0,
        reviewCount: 0,
        testFixture: "block-a-acceptance",
        testOwned: true,
      },
    });
  }
  const id = (key: string) => ids.get(key)!;
  const offerIds = new Set((await db.select({ id: offers.id }).from(offers)).map((row) => row.id));
  const assertReal = (resourceIds: string[]) => {
    for (const resourceId of resourceIds)
      assert.ok(offerIds.has(resourceId), `result ${resourceId} must be a persisted DINAR offer`);
  };

  phase = "discovery";
  // A01 — generic electronics search, open, back to the same set.
  {
    const conversationId = await conversation(buyer.cookie);
    const search = await turn(buyer.cookie, conversationId, "أريد سماعة آيفون سوداء");
    assert.equal(search.block.type, "LISTING_RESULTS");
    const set = await latestSet(conversationId);
    assert.equal(set.query.categoryId, "electronics");
    const expected = (await discoverable())
      .filter((offer) => offer.data.categoryId === "electronics")
      .filter((offer) => ["سماع", "ايفون", "اسود"].every((word) => text(offer).includes(word)))
      .map((offer) => offer.id);
    assert.deepEqual([...set.resourceIds].sort(), [...expected].sort());
    assert.ok(set.resourceIds.includes(id("headsetBlack")));
    for (const excluded of ["headsetWhite", "phoneBlack", "headsetPaused"])
      assert.ok(!set.resourceIds.includes(id(excluded)), `${excluded} must not match`);
    assertReal(set.resourceIds);
    assert.deepEqual(search.payload.listings.map((listing: any) => listing.id), set.resourceIds);
    const opened = await turn(buyer.cookie, conversationId, "افتح الأولى");
    assert.equal(opened.payload.presentation, "DETAILS");
    assert.equal(opened.payload.resultSetId, set.id);
    assert.deepEqual(opened.payload.listings.map((listing: any) => listing.id), [set.resourceIds[0]]);
    const setsBeforeBack = await resultSetCount(conversationId);
    const back = await turn(buyer.cookie, conversationId, "رجعني للنتائج");
    assert.equal(back.payload.resultSetId, set.id);
    assert.deepEqual(back.payload.resourceIds, set.resourceIds);
    assert.equal(await resultSetCount(conversationId), setsBeforeBack, "back must not run a new search");
    accepted.A01 = "PASS";
  }

  // A02 — multi-turn vehicle refinement, sort and ordinal.
  let vehicleConversationId = "";
  let vehicleSortedIds: string[] = [];
  {
    const conversationId = await conversation(buyer.cookie);
    vehicleConversationId = conversationId;
    const cars = (await discoverable()).filter((offer) => offer.data.categoryId === "cars");
    const benz = cars.filter((offer) => normalizeSearch(String(attr(offer, "make") ?? "")).includes("مرسيدس"));
    const steps: [string, (offer: typeof offers.$inferSelect) => boolean][] = [
      ["أريد مرسيدس", () => true],
      ["من 2020 وفوق", (offer) => Number(attr(offer, "year")) >= 2020],
      ["أقل من 9000", (offer) => priceOf(offer) < 9000],
      ["في عمان فقط", (offer) => normalizeSearch(String(offer.data.city)).includes("عمان")],
    ];
    let pool = benz;
    for (const [phrase, keep] of steps) {
      await turn(buyer.cookie, conversationId, phrase);
      pool = pool.filter(keep);
      const set = await latestSet(conversationId);
      assert.equal(set.query.categoryId, "cars", phrase);
      assert.deepEqual([...set.resourceIds].sort(), pool.map((offer) => offer.id).sort(), phrase);
      assertReal(set.resourceIds);
    }
    const sorted = await turn(buyer.cookie, conversationId, "وريني الأرخص");
    const sortedSet = await latestSet(conversationId);
    assert.equal(sortedSet.query.sort, "PRICE_ASC");
    vehicleSortedIds = [...pool].sort((a, b) => priceOf(a) - priceOf(b)).map((offer) => offer.id);
    assert.deepEqual(sortedSet.resourceIds, vehicleSortedIds);
    assert.deepEqual(sorted.payload.resourceIds, vehicleSortedIds);
    assert.ok(vehicleSortedIds.length >= 2);
    assert.deepEqual(vehicleSortedIds.slice(0, 2), [id("benz2022"), id("benz2021")]);
    const second = await turn(buyer.cookie, conversationId, "الثانية");
    assert.equal(second.payload.resultSetId, sortedSet.id);
    assert.deepEqual(second.payload.listings.map((listing: any) => listing.id), [vehicleSortedIds[1]]);
    accepted.A02 = "PASS";
  }

  // A03 — property: purpose, rooms and city without number contamination.
  {
    const conversationId = await conversation(buyer.cookie);
    // A prior result set exists, so a misread "3" would open a result instead of searching.
    await turn(buyer.cookie, conversationId, "أريد عقارات");
    const search = await turn(buyer.cookie, conversationId, "أريد شقة للإيجار 3 غرف في عمان");
    assert.equal(search.block.type, "LISTING_RESULTS");
    assert.notEqual(search.payload.presentation, "DETAILS");
    const set = await latestSet(conversationId);
    const filters = Object.fromEntries(
      set.query.filters.map((filter: any) => [filter.field, [filter.operator, filter.value]]),
    );
    assert.equal(set.query.categoryId, "property");
    assert.deepEqual(filters.bedrooms, ["eq", 3]);
    assert.deepEqual(filters.transactionType, ["contains", "إيجار"]);
    assert.deepEqual(filters.city, ["contains", "عمان"]);
    const expected = (await discoverable()).filter(
      (offer) =>
        offer.data.categoryId === "property" &&
        Number(attr(offer, "bedrooms")) === 3 &&
        normalizeSearch(String(attr(offer, "transactionType"))).includes("ايجار") &&
        normalizeSearch(String(attr(offer, "propertyType"))).includes("شقة") &&
        normalizeSearch(String(offer.data.city)).includes("عمان"),
    );
    assert.deepEqual([...set.resourceIds].sort(), expected.map((offer) => offer.id).sort());
    assert.ok(set.resourceIds.includes(id("flatRent3")));
    assertReal(set.resourceIds);
    accepted.A03 = "PASS";
  }

  // A04 — categories far from cars/property through the same runtime.
  {
    const conversationId = await conversation(buyer.cookie);
    await turn(buyer.cookie, conversationId, "أريد كنب أقل من 300");
    const set = await latestSet(conversationId);
    assert.equal(set.query.categoryId, "home");
    const expected = (await discoverable()).filter(
      (offer) =>
        offer.data.categoryId === "home" &&
        text(offer).includes("كنب") &&
        priceOf(offer) < 300,
    );
    assert.deepEqual([...set.resourceIds].sort(), expected.map((offer) => offer.id).sort());
    assert.ok(set.resourceIds.includes(id("sofaCheap")));
    for (const excluded of ["sofaDear", "lamp"])
      assert.ok(!set.resourceIds.includes(id(excluded)), `${excluded} must not match`);
    const service = await conversation(buyer.cookie);
    await turn(buyer.cookie, service, "أريد خدمة تنظيف في عمان");
    const serviceSet = await latestSet(service);
    assert.equal(serviceSet.query.categoryId, "services");
    assert.ok(serviceSet.resourceIds.includes(id("cleaning")));
    assertReal(serviceSet.resourceIds);
    accepted.A04 = "PASS";
  }

  // A05 — real empty state; nothing invented; follow-up ordinal asks instead of guessing.
  {
    const conversationId = await conversation(buyer.cookie);
    const empty = await turn(buyer.cookie, conversationId, "أريد مرسيدس أقل من 5");
    assert.equal(empty.block.type, "LISTING_RESULTS");
    assert.deepEqual(empty.payload.listings, []);
    assert.deepEqual(empty.payload.resourceIds, []);
    assert.ok(empty.payload.searchState.filters.some((filter: any) => filter.field === "price"));
    assert.match(empty.body, /لم أجد/);
    assert.deepEqual((await latestSet(conversationId)).resourceIds, []);
    const ordinal = await turn(buyer.cookie, conversationId, "الثانية");
    assert.equal(ordinal.payload.surface, "CLARIFY");
    const history = await request(`/ai/conversations/${conversationId}`, "GET", undefined, buyer.cookie);
    const restored = history.data.messages.flatMap((message: any) => message.blocks)
      .find((block: any) => block.type === "LISTING_RESULTS");
    assert.deepEqual(restored?.payload.listings, [], "empty state survives reload as a typed block");
    accepted.A05 = "PASS";
  }

  // A06 — ordinal safety for buyers and sellers.
  {
    const conversationId = await conversation(buyer.cookie);
    await turn(buyer.cookie, conversationId, "أريد مرسيدس");
    const set = await latestSet(conversationId);
    assert.ok(set.resourceIds.length >= 3);
    const opened = await turn(buyer.cookie, conversationId, "افتح الثانية");
    assert.deepEqual(opened.payload.listings.map((listing: any) => listing.id), [set.resourceIds[1]]);
    // "3" here is a price bound, not "open result 3".
    const bounded = await turn(buyer.cookie, conversationId, "أقل من 3");
    assert.notEqual(bounded.payload.presentation, "DETAILS");
    assert.deepEqual((await latestSet(conversationId)).query.filters.find((filter: any) => filter.field === "price"), {
      field: "price", operator: "lt", value: 3,
    });
    const outOfRange = await turn(buyer.cookie, conversationId, "افتح الخامسة");
    assert.equal(outOfRange.payload.surface, "CLARIFY");

    const sellerConversation = await conversation(seller.cookie);
    const mine = await turn(seller.cookie, sellerConversation, "عروضي");
    const ownIds: string[] = mine.payload.resourceIds;
    assert.ok(ownIds.length >= 2, JSON.stringify(mine.payload));
    const [before] = await db.select().from(offers).where(eq(offers.id, ownIds[1]));
    const preview = await turn(seller.cookie, sellerConversation, "غير سعر الإعلان الثاني إلى 50");
    assert.equal(preview.payload.managementPreview?.listingId, ownIds[1]);
    assert.equal(preview.payload.managementPreview?.status, "PENDING");
    assert.match(preview.payload.managementPreview?.afterValue ?? "", /50/);
    const [after] = await db.select().from(offers).where(eq(offers.id, ownIds[1]));
    assert.equal(after.unitPriceMinor, before.unitPriceMinor, "a preview must not mutate price");
    await turn(seller.cookie, sellerConversation, "إلغاء");
    accepted.A06 = "PASS";
  }

  // A07 — back restores the exact set, order and IDs after details.
  {
    const conversationId = vehicleConversationId;
    const set = await latestSet(conversationId);
    await turn(buyer.cookie, conversationId, "افتح الأولى");
    const count = await resultSetCount(conversationId);
    const back = await turn(buyer.cookie, conversationId, "رجعني");
    assert.equal(back.payload.resultSetId, set.id);
    assert.deepEqual(back.payload.resourceIds, vehicleSortedIds);
    assert.equal(back.payload.searchState.sort, "PRICE_ASC");
    assert.equal(await resultSetCount(conversationId), count);
    accepted.A07 = "PASS";
  }

  // A08 — reload: persisted history rehydrates live blocks; context keeps resolving.
  {
    const history = await request(`/ai/conversations/${vehicleConversationId}`, "GET", undefined, buyer.cookie);
    assert.equal(history.status, 200);
    const listingBlocks = history.data.messages
      .flatMap((message: any) => message.blocks)
      .filter((block: any) => block.type === "LISTING_RESULTS");
    const last = listingBlocks.at(-1);
    assert.deepEqual(last.payload.listings.map((listing: any) => listing.id), vehicleSortedIds);
    const again = await turn(buyer.cookie, vehicleConversationId, "الثانية");
    assert.deepEqual(again.payload.listings.map((listing: any) => listing.id), [vehicleSortedIds[1]]);
    accepted.A08 = "PASS (API)";
  }

  // A11 — invented, foreign and stale references are rejected.
  {
    const conversationId = vehicleConversationId;
    const set = await latestSet(conversationId);
    const attempts: [string, () => Promise<number>][] = [
      ["random result set", async () => (await request(`/ai/conversations/${conversationId}/actions/add-to-cart`, "POST", { resultSetId: randomUUID(), resourceId: set.resourceIds[0] }, buyer.cookie)).status],
      ["invented listing id", async () => (await request(`/ai/conversations/${conversationId}/actions/add-to-cart`, "POST", { resultSetId: set.id, resourceId: `blocka_${runId}_invented` }, buyer.cookie)).status],
      ["listing outside the set", async () => (await request(`/ai/conversations/${conversationId}/actions/add-to-cart`, "POST", { resultSetId: set.id, resourceId: id("headsetBlack") }, buyer.cookie)).status],
      ["another user's conversation", async () => (await request(`/ai/conversations/${conversationId}`, "GET", undefined, intruder.cookie)).status],
      ["another user's result set", async () => {
        const own = await conversation(intruder.cookie);
        return (await request(`/ai/conversations/${own}/actions/add-to-cart`, "POST", { resultSetId: set.id, resourceId: set.resourceIds[0] }, intruder.cookie)).status;
      }],
    ];
    for (const [label, attempt] of attempts) {
      const status = await attempt();
      if (status < 400) inventedIdsAccepted += 1;
      assert.ok([404, 409].includes(status), `${label} must be rejected, got ${status}`);
    }
    const [jordan] = await db.select().from(markets).where(eq(markets.id, "JO"));
    for (const resourceId of [`blocka_${runId}_invented`, id("headsetBlack")]) {
      try {
        await executeRegisteredTool(
          "getResource",
          JSON.stringify({ resultSetId: set.id, resourceId }),
          { conversationId, market: jordan as any },
        );
        inventedIdsAccepted += 1;
      } catch (error) {
        assert.ok(error instanceof ToolRejectedError);
      }
    }
    // Guest preview has no server result set; a client ID still passes publication filters.
    const guest = await request("/ai/preview", "POST", {
      message: "الأولى",
      marketId: "KW",
      resourceIds: [id("headsetPaused")],
      searchState: { search: "", filters: [] },
    });
    assert.equal(guest.status, 200);
    const leaked = (guest.data.blocks ?? []).flatMap((block: any) => block.payload.listings ?? [])
      .some((listing: any) => listing.id === id("headsetPaused"));
    if (leaked) inventedIdsAccepted += 1;
    assert.equal(leaked, false, "a paused listing must not be reachable by a client-supplied ID");
    const unknown = await turn(buyer.cookie, conversationId, "افتح رقم 24");
    assert.equal(unknown.payload.surface, "CLARIFY");
    assert.equal(inventedIdsAccepted, 0);
    accepted.A11 = "PASS";
  }

  // A10 — no provider configured, and no deterministic phrase reached the model gateway.
  assert.equal(getModelGatewayCallCount(), 0);
  accepted.A10 = "PASS (API)";

  const discoveryExternal = external.filter((call) => call.phase === "discovery");
  assert.deepEqual(discoveryExternal, [], "marketplace discovery must not leave DINAR");

  // A09 — photo-first foundation: structured proposal, seller correction wins, nothing published.
  phase = "photo";
  // Real photo uploads use the configured Object Storage provider; it runs only when authorized.
  if (process.env.BDINAR_OBJECT_STORAGE_ACCEPTANCE === "authorized") {
    process.env.BDINAR_A09_STORAGE_RUN_ID = runId;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const unauthenticatedUpload = await request(
      "/account/listing-photos/upload-url",
      "POST",
      { contentType: "image/png", size: png.length },
    );
    assert.equal(unauthenticatedUpload.status, 401);
    assert.equal(
      (await request(
        "/account/listing-photos/upload-url",
        "POST",
        { contentType: "image/svg+xml", size: png.length },
        seller.cookie,
      )).status,
      400,
    );
    assert.equal(
      (await request(
        "/account/listing-photos/upload-url",
        "POST",
        { contentType: "image/png", size: 5 * 1024 * 1024 + 1 },
        seller.cookie,
      )).status,
      400,
    );
    const paths: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const upload = await request("/account/listing-photos/upload-url", "POST", { contentType: "image/png", size: png.length }, seller.cookie);
      assert.equal(upload.status, 200, upload.raw);
      assert.match(upload.data.objectPath, new RegExp(`/acceptance-A09-${runId}-seller-${seller.id}-`));
      try {
        await new ObjectStorageService().getObjectEntityFile(upload.data.objectPath);
        assert.fail("A09 upload key already exists; refusing to overwrite it.");
      } catch (error) {
        assert.equal((error as Error).name, "ObjectNotFoundError");
      }
      const sealedPath = upload.data.objectPath.replace(
        "/acceptance-A09-",
        "/sealed-acceptance-A09-",
      );
      try {
        await new ObjectStorageService().getObjectEntityFile(sealedPath);
        assert.fail("A09 sealed key already exists; refusing to reuse it.");
      } catch (error) {
        assert.equal((error as Error).name, "ObjectNotFoundError");
      }
      uploadedPhotos.push(upload.data.objectPath);
      uploadedPhotos.push(sealedPath);
      const put = await originalFetch(upload.data.uploadURL, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png });
      assert.ok(put.ok, `photo upload failed: ${put.status}`);
      const done = await request("/account/listing-photos/complete", "POST", { objectPath: upload.data.objectPath }, seller.cookie);
      assert.equal(done.status, 200, done.raw);
      assert.equal(done.data.objectPath, sealedPath);
      paths.push(done.data.objectPath);
    }
    assert.equal(
      (await request(
        "/account/listing-photos/complete",
        "POST",
        { objectPath: paths[0] },
        intruder.cookie,
      )).status,
      403,
    );
    assert.equal(
      (await request(
        "/account/listing-photos/complete",
        "POST",
        { objectPath: `/objects/listing-photos/${seller.id}/not-a-generated-key.png` },
        seller.cookie,
      )).status,
      403,
    );
    const offersBefore = (await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, seller.id))).length;
    app.locals.listingPhotoSuggestionProvider = new DeterministicPhotoSuggestionProvider([
      { field: "category", value: "electronics", confidence: 0.82, imageObjectPath: paths[0] },
      { field: "condition", value: "مستعمل", confidence: 0.64, imageObjectPath: paths[1] },
      { field: "price", value: 999, confidence: 0.9, imageObjectPath: paths[0] },
      { field: "title", value: "iPhone 15 Pro 256GB أصلي 100%", confidence: 0.9, imageObjectPath: paths[0] },
    ]);
    try {
      const conversationId = await conversation(seller.cookie);
      const proposed = await turn(seller.cookie, conversationId, "أريد أبيع هذا", paths);
      assert.equal(proposed.payload.surface, "SELL");
      assert.equal(proposed.payload.photoSuggestionStatus, "SUGGESTIONS");
      assert.deepEqual(
        proposed.payload.photoSuggestions.map((suggestion: any) => [suggestion.field, suggestion.value]),
        [["category", "إلكترونيات"], ["condition", "مستعمل"]],
      );
      assert.deepEqual(
        [proposed.payload.draft.imageUrl, ...(proposed.payload.draft.imageUrls ?? [])],
        paths,
      );
      assert.equal(proposed.payload.draft.unitPrice, undefined, "AI must not set a price");
      assert.equal(proposed.payload.draft.attributes?.condition, undefined, "suggestions are not applied");
      assert.equal(proposed.payload.draft.description, undefined, "a demonstrative is not a description");
      const chosen = await turn(seller.cookie, conversationId, "إلكترونيات");
      assert.equal(chosen.payload.draft.categoryId, "electronics");
      const corrected = await turn(seller.cookie, conversationId, "لا، جديد");
      assert.equal(corrected.payload.draft.title, undefined, "a field correction is not a title");
      assert.equal(corrected.payload.draft.attributes?.condition, "جديد");
      // Re-analysis of the same photos proposes again but cannot overwrite the seller's value.
      const reanalysed = await turn(seller.cookie, conversationId, "هذه الصور نفسها", paths);
      assert.equal(reanalysed.payload.draft.draftId, corrected.payload.draft.draftId, "photos continue the same draft");
      assert.equal(reanalysed.payload.draft.attributes?.condition, "جديد");
      assert.equal(reanalysed.payload.photoSuggestionStatus, "SUGGESTIONS");
      const offersAfter = (await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, seller.id))).length;
      assert.equal(offersAfter, offersBefore, "no automatic publication");
    } finally {
      delete app.locals.listingPhotoSuggestionProvider;
    }
    accepted.A09 = "PASS";
  } else {
    // Without storage, prove the same draft runtime keeps a labelled seller correction.
    const offersBefore = (await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, seller.id))).length;
    const conversationId = await conversation(seller.cookie);
    const started = await turn(seller.cookie, conversationId, "أريد أبيع سماعة بلوتوث");
    assert.equal(started.payload.surface, "SELL");
    const title = started.payload.draft.title;
    const corrected = await turn(seller.cookie, conversationId, "الحالة مستعمل");
    assert.equal(corrected.payload.draft.attributes?.condition, "مستعمل");
    assert.equal(corrected.payload.draft.title, title, "a field correction is not a title");
    assert.equal(corrected.payload.draft.draftId, started.payload.draft.draftId);
    const offersAfter = (await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, seller.id))).length;
    assert.equal(offersAfter, offersBefore, "no automatic publication");
    accepted.A09 = "PROVIDER-BOUNDARY (photo upload not run; text correction PASS)";
  }

  // Browser: connected UI, mobile widths, reload (A01/A02/A05/A07/A08/A12).
  phase = "browser";
  browserWeb = await startDinarBrowserTestWeb();
  const resultPath = `/tmp/dinar-blocka-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(
      process.execPath,
      [`${process.cwd()}/../dinar/test/block-a-ui-acceptance.mjs`],
      {
        cwd: `${process.cwd()}/../dinar`,
        env: {
          ...process.env,
          BLOCKA_WEB_BASE: browserWeb.baseUrl,
          BLOCKA_API_ORIGIN: `http://127.0.0.1:${port}`,
          BLOCKA_COOKIE: buyer.cookie,
          BLOCKA_SELLER_COOKIE: seller.cookie,
          BLOCKA_A09_IMAGE_BASE64: process.env.BDINAR_OBJECT_STORAGE_ACCEPTANCE === "authorized"
            ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
            : "",
          BLOCKA_EXPECTED_SORTED_IDS: JSON.stringify(vehicleSortedIds),
          BLOCKA_UI_RESULT_PATH: resultPath,
        },
        timeout: 600_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
  } catch (error) {
    browserError = error;
  }
  let browser: any;
  try {
    browser = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    browser = undefined;
  }
  console.log("BLOCKA_BROWSER", JSON.stringify(browser));
  if (process.env.BDINAR_OBJECT_STORAGE_ACCEPTANCE === "authorized" && browser?.a09?.objectPaths)
    uploadedPhotos.push(...browser.a09.objectPaths);
  if (browserError && !browser) throw browserError;
  assert.ok(browser, "browser acceptance must report");
  assert.equal(browser.failure, undefined, browser.failure);
  assert.deepEqual(browser.pageErrors, []);
  assert.deepEqual(browser.consoleErrors, []);
  assert.equal(browser.horizontalOverflow, 0);
  assert.deepEqual(browser.marketplaceExternalRequests, []);
  if (process.env.BDINAR_OBJECT_STORAGE_ACCEPTANCE === "authorized") {
    assert.equal(browser.a09?.uploadRequests, 1);
    assert.equal(browser.a09?.uploadRequestsAfterReload, 1);
    assert.equal(browser.a09?.storageRequests, 1);
    assert.equal(browser.a09?.uploadLoadingObserved, true);
    assert.ok(browser.a09?.objectPaths?.length >= 2);
    assert.equal(
      (await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, seller.id))).length,
      fixtureIds.length,
      "photo upload and seller draft edits do not publish an offer",
    );
    accepted.A09 = "PASS";
  }
  assert.equal(getModelGatewayCallCount(), 0, "browser journeys must not reach the model");
  accepted.A12 = "PASS";
  accepted.A08 = "PASS";
  accepted.A10 = "PASS";

  console.log(
    "BLOCKA_SUMMARY",
    JSON.stringify({
      accepted,
      modelCalls: modelCalls.reduce((sum, item) => sum + item.calls, 0),
      deterministicPhrases: modelCalls.length,
      inventedIdsAccepted,
      externalByPhase: external.reduce<Record<string, string[]>>((byPhase, call) => {
        (byPhase[call.phase] ??= []).push(call.host);
        return byPhase;
      }, {}),
      browser: {
        checks: browser.checks.length,
        staticFontRequests: browser.staticFontRequests,
      },
    }),
  );
});

after(async () => {
  phase = "cleanup";
  delete app.locals.listingPhotoSuggestionProvider;
  if (fixtureIds.length)
    await db.delete(offers).where(inArray(offers.id, fixtureIds)).catch(() => undefined);
  const storage = new ObjectStorageService();
  const cleanupManifest = [...new Set(uploadedPhotos)];
  for (const objectPath of cleanupManifest) {
    if (
      !objectPath.startsWith("/objects/listing-photos/") ||
      !objectPath.includes(`acceptance-A09-${runId}-seller-`)
    )
      throw new Error("A09 cleanup manifest contains a key outside this run.");
    try {
      const file = await storage.getObjectEntityFile(objectPath);
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      if ((error as Error).name !== "ObjectNotFoundError") throw error;
    }
    try {
      await storage.getObjectEntityFile(objectPath);
      throw new Error("An A09 test object remains after cleanup.");
    } catch (error) {
      if ((error as Error).name !== "ObjectNotFoundError") throw error;
    }
  }
  delete process.env.BDINAR_A09_STORAGE_RUN_ID;
  if (cleanupManifest.length)
    console.log("A09_STORAGE_CLEANUP", JSON.stringify({
      createdKeys: cleanupManifest.length,
      deletedKeys: cleanupManifest.length,
      remainingKeys: 0,
      unrelatedObjectsDeleted: 0,
    }));
  await browserWeb?.stop();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
