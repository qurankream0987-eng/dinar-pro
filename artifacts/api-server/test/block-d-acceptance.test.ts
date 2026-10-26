import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  aiUiBlocks,
  db,
  messages,
  offers,
  orderFulfillments,
  orders,
  pool,
  sellerDues,
  transactionLocations,
  users,
} from "@workspace/db";
import { getModelGatewayCallCount, resetModelGatewayCallCount } from "../src/ai/model-gateway";
import { marketFor } from "../src/lib/markets";
import { deactivateOwnAccount, setUserModerationStatus } from "../src/lib/moderation";
import {
  attachTransactionLocation,
  deliveryOptions,
  getDeliveryView,
  selectDeliveryMethod,
  transitionDelivery,
} from "../src/lib/delivery";
import { hasEligibleCourierSupply } from "../src/lib/courier-supply";
import { deliveryIntent, normalizeDeliveryText, scrubStaleLocationPreviews } from "../src/ai/delivery-turn";
import { ensureDriverDraft, reviewDriverProfile, setDriverAvailability, submitDriverProfile } from "../src/lib/driver";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKD_ACCEPTANCE");
// Any model call would throw and be counted; deterministic delivery flows must make none.
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const providerConfigured = Boolean(
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY,
);
const execFileAsync = promisify(execFile);

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
const runId = randomUUID().replaceAll("-", "").slice(0, 8);
// Every URL this suite requests; D16 checks none carries a location.
const requestedUrls: string[] = [];

type ApiResponse = { status: number; data: any; cookie: string; raw: string };
async function request(path: string, method = "GET", body?: unknown, cookie = ""): Promise<ApiResponse> {
  const rateLimited = path.startsWith("/auth/");
  const ip = rateLimited
    ? `198.41.${Math.floor(authSequence / 250) % 250}.${(authSequence++ % 250) + 1}`
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
// Kuwait mobile numbers in the known-valid 51xxxxxx range (see phone fixture notes).
const phoneBase = 51_100_000 + ((Date.now() + process.pid) % 600_000);
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
  const password = `BlockD-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Block D ${label}`,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  const market = await request("/account/market", "PATCH", { marketId }, registered.cookie);
  assert.equal(market.status, 200, market.raw);
  return { id: registered.data.user.id, cookie: registered.cookie, label, password } as Actor & { password: string };
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
type TurnResult = { body: string; surface: string; payload: any; delivery: any; resultSetId: string };
async function turn(
  actor: Actor,
  conversationId: string,
  message: string,
  extra: { location?: unknown; locationRequestId?: string } = {},
): Promise<TurnResult> {
  const before = getModelGatewayCallCount();
  const response = await originalFetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message, ...extra }),
  });
  requestedUrls.push(`${base}/ai/conversations/${conversationId}/turns`);
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const complete = completion(raw);
  assert.ok(complete, `turn "${message}" did not complete: ${raw.slice(0, 300)}`);
  const calls = getModelGatewayCallCount() - before;
  modelCalls.push({ phrase: message, calls });
  assert.equal(calls, 0, `model call for deterministic phrase ${message}`);
  const block = complete.assistantMessage.blocks[0];
  return {
    body: complete.assistantMessage.body,
    surface: block?.payload?.surface,
    payload: block?.payload,
    delivery: block?.payload?.delivery,
    resultSetId: block?.payload?.resultSetId,
  };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

function listingBody(title: string, fulfilmentType: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    description: `اختبار التسليم ${runId}`,
    category: fulfilmentType === "SERVICE" ? "خدمات" : "أخرى",
    categoryId: fulfilmentType === "SERVICE" ? "services" : "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: "20.000",
    inventoryMode: fulfilmentType === "SERVICE" ? "UNLIMITED" : "LIMITED",
    availableQuantity: fulfilmentType === "SERVICE" ? null : 20,
    fulfilmentType,
    imageUrl: "",
    imageUrls: [],
    ...overrides,
  };
}

async function publish(seller: Actor, title: string, fulfilmentType: string) {
  const created = await request("/listings", "POST", listingBody(title, fulfilmentType), seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data as { id: string };
}

async function buy(buyer: Actor, listingId: string, fulfilmentType: string) {
  const created = await request(
    "/orders",
    "POST",
    { listingId, quantity: 1, fulfilmentType, idempotencyKey: `d-${randomUUID()}` },
    buyer.cookie,
  );
  assert.equal(created.status, 201, created.raw);
  return created.data as { id: string };
}

async function acceptOrder(seller: Actor, orderId: string) {
  const accepted = await request(`/orders/${orderId}/accept`, "POST", {}, seller.cookie);
  assert.equal(accepted.status, 200, accepted.raw);
}

async function fulfillment(actor: Actor, orderId: string) {
  return request(`/orders/${orderId}/fulfillment`, "GET", undefined, actor.cookie);
}

async function locationRows(orderId: string) {
  return db.select().from(transactionLocations).where(eq(transactionLocations.orderId, orderId));
}

async function fulfillmentRow(orderId: string) {
  const [row] = await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId));
  return row;
}

async function setById(id: string) {
  const [row] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, id));
  return row!;
}

async function expectStatus(attempt: () => Promise<unknown>, status: number): Promise<boolean> {
  try {
    await attempt();
    return false;
  } catch (error) {
    return (error as { status?: number }).status === status;
  }
}

// Synthetic fixture coordinates only; never a real person's location.
const A = { latitude: 29.111222, longitude: 47.333444, accuracyMeters: 18 };
const B = { latitude: 29.222333, longitude: 47.444555, accuracyMeters: 25 };
const C = { latitude: 29.333444, longitude: 47.555666, accuracyMeters: 12 };
const POOR = { latitude: 29.444555, longitude: 47.666777, accuracyMeters: 900 };
const SERVICE_POINT = { latitude: 29.555666, longitude: 47.777888, accuracyMeters: 30 };
const manualAddress = `عمارة الاختبار ${runId} الطابق الثالث`;
const pickupAddress = `نقطة استلام الاختبار ${runId} قرب الدوار`;
const SENTINELS = [
  ...[A, B, C, POOR, SERVICE_POINT].flatMap((point) => [String(point.latitude), String(point.longitude)]),
  manualAddress,
  pickupAddress,
];
const containsSentinel = (text: string) => SENTINELS.filter((value) => text.includes(value));
// Browser fixtures (D21) included; the runner scans all captured output for these after the suite.
if (process.env.BDINAR_LOG_SENTINELS_FILE)
  await writeFile(
    process.env.BDINAR_LOG_SENTINELS_FILE,
    JSON.stringify({
      coordinates: [...SENTINELS.slice(0, 10), "31.951111", "35.923333"],
      addresses: [manualAddress, pickupAddress, `شارع التجربة ${runId}`],
    }),
  );

let market: Awaited<ReturnType<typeof marketFor>>;
let sellerD: Actor; // seller delivery
let sellerP: Actor; // pickup only
let sellerS: Actor; // service
let sellerB: Actor; // another seller
let buyerA: Actor;
let buyerB: Actor;
let buyerC: Actor;
let buyerE: Actor; // state-machine and account-state probes
let outsider: Actor; // other market
let moderator: Actor;
const listing: Record<string, { id: string }> = {};
const order: Record<string, string> = {};
const conv: Record<string, string> = {};
const results: Record<string, "PASS" | "FAIL"> = {};
const cross = { user: { passed: 0, total: 0 }, order: { passed: 0, total: 0 } };
let browserReport: any;

async function acceptance(id: string, name: string, body: () => Promise<void>) {
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

/** Buyer selects seller delivery in conversation and reaches the location request. */
async function chooseSellerDelivery(buyer: Actor, conversationId: string): Promise<TurnResult> {
  const options = await turn(buyer, conversationId, "أريد توصيل");
  assert.equal(options.surface, "DELIVERY_OPTIONS", options.body);
  const summary = await turn(buyer, conversationId, "توصيل من البائع");
  assert.equal(summary.surface, "DELIVERY_SUMMARY", summary.body);
  assert.equal(summary.delivery.action.status, "PENDING");
  const confirmed = await turn(buyer, conversationId, "نعم");
  assert.equal(confirmed.surface, "LOCATION_PERMISSION_REQUEST", confirmed.body);
  return confirmed;
}

await test("setup: providers off, disposable markets, fresh actors, real orders", async () => {
  resetModelGatewayCallCount();
  assert.equal(providerConfigured, false, "Block D runs with the external AI provider unconfigured");
  [sellerD, sellerP, sellerS, sellerB, buyerA, buyerB, buyerC, buyerE, moderator] = await Promise.all(
    ["Seller Delivery", "Seller Pickup", "Seller Service", "Seller B", "Buyer A", "Buyer B", "Buyer C", "Buyer E", "Moderator"].map((label) => register(label)),
  );
  outsider = await register("Outsider", "KW");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, moderator.id));
  // Fresh migrations intentionally omit courier delivery from the active market.
  // D21 exercises a real eligible courier, so declare that test capability explicitly.
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  market = await marketFor({ actor: { activeMarketId: "JO" } });
  listing.delivery = await publish(sellerD, `مكتب خشبي ${runId}`, "DELIVERY");
  listing.pickup = await publish(sellerP, `دراجة هوائية ${runId}`, "PICKUP");
  listing.service = await publish(sellerS, `صيانة كهرباء ${runId}`, "SERVICE");
  listing.deliveryB = await publish(sellerB, `كرسي مكتب ${runId}`, "DELIVERY");
  order.D1 = (await buy(buyerA, listing.delivery.id, "DELIVERY")).id;
  order.B = (await buy(buyerB, listing.deliveryB.id, "DELIVERY")).id;
  order.P = (await buy(buyerC, listing.pickup.id, "PICKUP")).id;
  order.S = (await buy(buyerC, listing.service.id, "SERVICE")).id;
  order.E = (await buy(buyerE, listing.delivery.id, "DELIVERY")).id;
  for (const actor of [buyerA, buyerB, buyerC, buyerE, sellerD, sellerP, sellerS, sellerB]) conv[actor.label] = await conversation(actor);
});

await acceptance("D19", "no live tracking: no watchPosition, background reader, polling or movement tables", async () => {
  const roots = [join(process.cwd(), "src"), join(process.cwd(), "../dinar/src")];
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        // Calls only: comments documenting the rule are not usage.
        if (/\.watchPosition\s*\(|startLocationUpdates\s*\(|BackgroundGeolocation|setInterval\([^)]*getCurrentPosition/.test(text)) hits.push(path);
      }
    }
  };
  for (const root of roots) await walk(root);
  assert.deepEqual(hits, [], "no continuous or background location API in DINAR source");
  const readers = [];
  for (const root of roots) {
    const walkReaders = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walkReaders(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && (await readFile(path, "utf8")).includes("getCurrentPosition")) readers.push(path);
      }
    };
    await walkReaders(root);
  }
  assert.equal(readers.length, 1, `one explicit one-time reader only: ${readers.join(", ")}`);
  const tables = await pool.query(
    "select tablename from pg_tables where schemaname = 'public' and tablename ~ '(track|gps|movement|position|location_history|location_event|driver_(location|route|point|ping))'",
  );
  assert.deepEqual(tables.rows, [], "no tracking, GPS-point or movement tables");
  // Block F4 driver tables hold lifecycle and assignment only: the one transaction-scoped
  // snapshot table is the only place a coordinate column exists.
  const coordinates = await pool.query(
    "select distinct table_name from information_schema.columns where table_schema = 'public' and column_name ~ '(latitude|longitude)'",
  );
  assert.deepEqual(coordinates.rows.map((row: { table_name: string }) => row.table_name), ["transaction_locations"]);
});

await acceptance("D01", "permission request first; nothing is read or stored until the user acts; manual fallback", async () => {
  const request_ = await chooseSellerDelivery(buyerA, conv["Buyer A"]);
  assert.equal(request_.delivery.request.purpose, "DELIVERY_DESTINATION");
  assert.match(request_.body, /مشاركة موقعي الآن/);
  assert.match(request_.body, /يدويًا/);
  assert.equal(request_.delivery.preview, undefined);
  // The browser denied permission: the client sends nothing. Nothing was persisted.
  assert.equal((await locationRows(order.D1)).length, 0);
  const set = await setById(request_.resultSetId);
  assert.equal(JSON.stringify(set.query).includes("latitude"), false);
  const manual = await turn(buyerA, conv["Buyer A"], "اكتب العنوان يدويًا");
  assert.equal(manual.surface, "MANUAL_ADDRESS", manual.body);
  assert.equal(manual.delivery.request.purpose, "DELIVERY_DESTINATION");
  // Order is intact and still awaiting the seller.
  const [row] = await db.select().from(orders).where(eq(orders.id, order.D1));
  assert.equal(row.status, "CREATED");
  assert.equal((await fulfillmentRow(order.D1)).method, "SELLER_DELIVERY");
});

await acceptance("D03", "cancel at preview: no confirmed location, no delivery mutation", async () => {
  const requested = await turn(buyerA, conv["Buyer A"], "أرسل موقعي");
  assert.equal(requested.surface, "LOCATION_PERMISSION_REQUEST", requested.body);
  const before = await fulfillmentRow(order.D1);
  const preview = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...A },
    locationRequestId: requested.resultSetId,
  });
  assert.equal(preview.surface, "LOCATION_PREVIEW", preview.body);
  assert.equal(preview.delivery.preview.latitude, A.latitude);
  assert.equal(preview.delivery.action.status, "PENDING");
  assert.equal((await locationRows(order.D1)).length, 0, "no persistence before confirm");
  const cancelled = await turn(buyerA, conv["Buyer A"], "إلغاء");
  assert.equal(cancelled.delivery.view, "DELIVERY_NOTICE");
  assert.match(cancelled.body, /لم يُرسل أي موقع/);
  assert.equal((await locationRows(order.D1)).length, 0);
  const after = await fulfillmentRow(order.D1);
  assert.equal(after.version, before.version);
  assert.equal(after.status, before.status);
  // The cancelled preview no longer holds the reading.
  assert.equal(JSON.stringify((await setById(preview.resultSetId)).query).includes(String(A.latitude)), false);
});

await acceptance("D02", "one explicit reading → preview → confirm attaches one order-scoped snapshot", async () => {
  const requested = await turn(buyerA, conv["Buyer A"], "أرسل موقعي");
  assert.equal(requested.surface, "LOCATION_PERMISSION_REQUEST");
  // Poor accuracy is shown as approximate, with retry offered. Extra device fields
  // (altitude, heading, speed) are dropped at the API boundary and never stored.
  const poorPreview = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...POOR, altitude: 9, heading: 90, speed: 3 } as any,
    locationRequestId: requested.resultSetId,
  });
  assert.equal(poorPreview.surface, "LOCATION_PREVIEW", poorPreview.body);
  assert.equal(poorPreview.delivery.preview.poorAccuracy, true);
  assert.match(poorPreview.delivery.preview.accuracyNote, /منخفضة/);
  assert.equal(/altitude|heading|speed/.test(JSON.stringify((await setById(poorPreview.resultSetId)).query)), false);
  const preview = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...A },
    locationRequestId: poorPreview.resultSetId,
  });
  assert.equal(preview.surface, "LOCATION_PREVIEW", "retry from the preview supersedes it");
  assert.equal(JSON.stringify((await setById(poorPreview.resultSetId)).query).includes(String(POOR.latitude)), false);
  assert.equal((await locationRows(order.D1)).length, 0);
  const confirmed = await turn(buyerA, conv["Buyer A"], "تأكيد الموقع");
  assert.equal(confirmed.surface, "LOCATION_CONFIRMED", confirmed.body);
  const rows = await locationRows(order.D1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, "DELIVERY_DESTINATION");
  assert.equal(rows[0].source, "DEVICE");
  assert.equal(rows[0].latitude, A.latitude);
  assert.equal(rows[0].longitude, A.longitude);
  assert.equal(rows[0].accuracyMeters, A.accuracyMeters);
  assert.equal(rows[0].sharedBy, buyerA.id);
  assert.equal(rows[0].marketId, "JO");
  // Settled preview row is scrubbed; stored conversation blocks never hold coordinates.
  assert.equal(JSON.stringify((await setById(preview.resultSetId)).query).includes(String(A.latitude)), false);
  const blocks = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, conv["Buyer A"]));
  assert.deepEqual(containsSentinel(JSON.stringify(blocks)), []);
  // Idempotent: the same destination again changes nothing and creates no second row.
  const again = await db.transaction((tx) =>
    attachTransactionLocation({ actorId: buyerA.id, orderId: order.D1, purpose: "DELIVERY_DESTINATION", location: { source: "DEVICE", ...A }, market }, tx),
  );
  assert.equal(again.changed, false);
  assert.equal((await locationRows(order.D1)).length, 1);
  // Order audit message carries no coordinates.
  const audit = await db.select({ body: messages.body }).from(messages).where(eq(messages.conversationId, order.D1));
  assert.ok(audit.some((message) => /شارك المشتري موقع التسليم/.test(message.body)));
  assert.deepEqual(containsSentinel(JSON.stringify(audit)), []);
});

await acceptance("D04", "manual address without device permission, after review and confirmation", async () => {
  const requested = await chooseSellerDelivery(buyerB, conv["Buyer B"]);
  const manual = await turn(buyerB, conv["Buyer B"], "اكتب العنوان يدويًا");
  assert.equal(manual.surface, "MANUAL_ADDRESS");
  // A submission against the superseded permission request is stale and keeps nothing.
  const stale = await turn(buyerB, conv["Buyer B"], "عنوان تسليم يدوي", {
    location: { source: "MANUAL", city: "عمان", area: "خلدا", addressText: manualAddress },
    locationRequestId: requested.resultSetId,
  });
  assert.equal(stale.delivery.view, "DELIVERY_NOTICE");
  assert.match(stale.body, /انتهت صلاحية/);
  const manualAgain = await turn(buyerB, conv["Buyer B"], "اكتب العنوان يدويًا");
  const preview = await turn(buyerB, conv["Buyer B"], "عنوان تسليم يدوي", {
    location: { source: "MANUAL", city: "عمان", area: "خلدا", addressText: manualAddress, note: "الباب الأزرق" },
    locationRequestId: manualAgain.resultSetId,
  });
  assert.equal(preview.surface, "LOCATION_PREVIEW", preview.body);
  assert.equal(preview.delivery.preview.addressText, manualAddress);
  assert.equal((await locationRows(order.B)).length, 0);
  // A double tap / network retry: two simultaneous confirmations apply once.
  const { applyDeliveryAction } = await import("../src/ai/delivery-turn");
  const outcomes = await Promise.all([
    applyDeliveryAction({ actionId: preview.resultSetId, actorId: buyerB.id, market, decision: "CONFIRM" }),
    applyDeliveryAction({ actionId: preview.resultSetId, actorId: buyerB.id, market, decision: "CONFIRM" }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["CONFIRMED", "CONFIRMED"]);
  assert.equal(outcomes.filter((outcome) => /تمت معالجة/.test(outcome.message)).length, 1);
  assert.equal((await locationRows(order.B)).length, 1);
  const [row] = await locationRows(order.B);
  assert.equal(row.source, "MANUAL");
  assert.equal(row.latitude, null);
  assert.equal(row.addressText, manualAddress);
  assert.equal(row.city, "عمان");
  // The message body the user sent is a fixed label, not the address.
  const sent = await db.select({ body: messages.body }).from(messages).where(eq(messages.conversationId, conv["Buyer B"]));
  assert.deepEqual(containsSentinel(JSON.stringify(sent)), []);
});

await acceptance("D05", "change destination A → B before lock; seller sees B; no history", async () => {
  // The seller accepts the order and the delivery to destination A first.
  await acceptOrder(sellerD, order.D1);
  const accept = await turn(sellerD, conv["Seller Delivery"], "اقبل التوصيل");
  assert.equal(accept.surface, "DELIVERY_ACTION", accept.body);
  const accepted = await turn(sellerD, conv["Seller Delivery"], "نعم");
  assert.equal(accepted.surface, "DELIVERY_STATUS", accepted.body);
  assert.equal((await fulfillmentRow(order.D1)).status, "ACCEPTED");

  const change = await turn(buyerA, conv["Buyer A"], "غير موقع التسليم");
  assert.equal(change.surface, "LOCATION_PERMISSION_REQUEST", change.body);
  const preview = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...B },
    locationRequestId: change.resultSetId,
  });
  assert.equal(preview.delivery.preview.latitude, B.latitude);
  assert.match(preview.delivery.action.lines.join(" "), /تغيير/);
  // Not yet applied.
  assert.equal((await locationRows(order.D1))[0].latitude, A.latitude);
  const confirmed = await turn(buyerA, conv["Buyer A"], "نعم");
  assert.equal(confirmed.surface, "LOCATION_CONFIRMED", confirmed.body);
  const rows = await locationRows(order.D1);
  assert.equal(rows.length, 1, "one current snapshot; no location history");
  assert.equal(rows[0].latitude, B.latitude);
  // The seller must re-accept a changed destination.
  assert.equal((await fulfillmentRow(order.D1)).status, "REQUESTED");
  const sellerView = await fulfillment(sellerD, order.D1);
  assert.equal(sellerView.status, 200, sellerView.raw);
  assert.equal(sellerView.data.role, "SELLER");
  assert.equal(sellerView.data.destination.latitude, B.latitude);
  // A's coordinates exist nowhere any more.
  const dump = await pool.query(
    "select (select count(*) from transaction_locations where latitude = $1) + (select count(*) from ai_result_sets where query::text like $2) + (select count(*) from ai_ui_blocks where payload::text like $2) as n",
    [A.latitude, `%${A.latitude}%`],
  );
  assert.equal(Number(dump.rows[0].n), 0);
});

await acceptance("D06", "stale confirmation: expired or superseded previews never apply", async () => {
  const change = await turn(buyerA, conv["Buyer A"], "غير موقع التسليم");
  const preview = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...C },
    locationRequestId: change.resultSetId,
  });
  assert.equal(preview.surface, "LOCATION_PREVIEW");
  // (a) The confirmation window passes.
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiResultSets.id, preview.resultSetId));
  const late = await turn(buyerA, conv["Buyer A"], "نعم");
  assert.equal(late.delivery.view, "DELIVERY_NOTICE");
  assert.match(late.body, /انتهت صلاحية/);
  assert.equal((await locationRows(order.D1))[0].latitude, B.latitude);
  assert.equal(JSON.stringify((await setById(preview.resultSetId)).query).includes(String(C.latitude)), false);
  // (b) The conversation moves on before «نعم».
  const change2 = await turn(buyerA, conv["Buyer A"], "غير موقع التسليم");
  const preview2 = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...C },
    locationRequestId: change2.resultSetId,
  });
  assert.equal(preview2.surface, "LOCATION_PREVIEW");
  const moved = await turn(buyerA, conv["Buyer A"], "حالة التوصيل");
  assert.equal(moved.surface, "DELIVERY_STATUS");
  const yes = await turn(buyerA, conv["Buyer A"], "نعم");
  assert.match(yes.body, /لا يوجد إجراء/);
  assert.equal((await locationRows(order.D1))[0].latitude, B.latitude);
  assert.equal(JSON.stringify((await setById(preview2.resultSetId)).query).includes(String(C.latitude)), false);
  // (c) A forgotten preview is scrubbed by the periodic sweep once its window passes.
  const change3 = await turn(buyerA, conv["Buyer A"], "غير موقع التسليم");
  const preview3 = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...C },
    locationRequestId: change3.resultSetId,
  });
  await db.update(aiResultSets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiResultSets.id, preview3.resultSetId));
  assert.ok((await scrubStaleLocationPreviews()) >= 1);
  assert.equal(JSON.stringify((await setById(preview3.resultSetId)).query).includes(String(C.latitude)), false);
  const leftover = await pool.query("select count(*) as n from ai_result_sets where query::text like $1", [`%${C.latitude}%`]);
  assert.equal(Number(leftover.rows[0].n), 0);
  await turn(buyerA, conv["Buyer A"], "إلغاء");
});

await acceptance("D07", "pickup: buyer chooses pickup; seller shares an order-scoped pickup point", async () => {
  const pickup = await turn(buyerC, conv["Buyer C"], "أريد استلام شخصي");
  assert.equal(pickup.surface, "DELIVERY_SUMMARY", pickup.body);
  assert.equal(pickup.delivery.orderId, order.P, "the pickup-capable order is resolved, not the service order");
  const confirmed = await turn(buyerC, conv["Buyer C"], "نعم");
  assert.equal(confirmed.surface, "PICKUP_DETAILS", confirmed.body);
  assert.equal((await fulfillmentRow(order.P)).method, "PICKUP");
  // No buyer destination is needed for pickup: in the pickup order's context the
  // request goes to the buyer's only order that needs a place, and names it.
  const share = await turn(buyerC, conv["Buyer C"], "أرسل موقعي");
  assert.equal(share.surface, "LOCATION_PERMISSION_REQUEST", share.body);
  assert.equal(share.delivery.orderId, order.S);
  assert.match(share.body, /صيانة كهرباء/);
  await turn(buyerC, conv["Buyer C"], "إلغاء");
  // With no other candidate order, the pickup order itself explains why nothing is needed.
  const direct = await db.transaction((tx) =>
    expectStatus(() => attachTransactionLocation({ actorId: buyerC.id, orderId: order.P, purpose: "DELIVERY_DESTINATION", location: { source: "DEVICE", ...C }, market }, tx), 409),
  );
  assert.ok(direct, "a pickup order takes no buyer destination");
  assert.equal((await locationRows(order.P)).length, 0);
  // Seller shares a pickup point deliberately, only inside this order — even while the
  // conversation is on another (seller-delivery) order of the same seller.
  await acceptOrder(sellerP, order.P);
  const buyerF = await register("Buyer F");
  const sellerPDelivery = await publish(sellerP, `طاولة ${runId}`, "DELIVERY");
  const orderF = (await buy(buyerF, sellerPDelivery.id, "DELIVERY")).id;
  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyerF.id, orderId: orderF, method: "SELLER_DELIVERY", market }, tx));
  const sellerOrders = await turn(sellerP, conv["Seller Pickup"], "طلباتي");
  const positionF = sellerOrders.payload.resourceIds.indexOf(orderF);
  assert.ok(positionF >= 0 && positionF < 3);
  const openedF = await turn(sellerP, conv["Seller Pickup"], ["الأول", "الثاني", "الثالث"][positionF]);
  assert.equal(openedF.payload.resourceId, orderF);
  const requested = await turn(sellerP, conv["Seller Pickup"], "هذا موقع الاستلام");
  assert.equal(requested.surface, "LOCATION_PERMISSION_REQUEST", requested.body);
  assert.equal(requested.delivery.orderId, order.P, "an irrelevant context order does not capture the request");
  assert.equal(requested.delivery.request.purpose, "PICKUP_POINT");
  const manual = await turn(sellerP, conv["Seller Pickup"], "اكتب العنوان يدويًا");
  const preview = await turn(sellerP, conv["Seller Pickup"], "عنوان تسليم يدوي", {
    location: { source: "MANUAL", city: "عمان", area: "خلدا", addressText: pickupAddress },
    locationRequestId: manual.resultSetId,
  });
  assert.equal(preview.surface, "LOCATION_PREVIEW");
  await turn(sellerP, conv["Seller Pickup"], "نعم");
  const ready = await turn(sellerP, conv["Seller Pickup"], "جاهز للاستلام");
  assert.equal(ready.surface, "DELIVERY_ACTION", ready.body);
  await turn(sellerP, conv["Seller Pickup"], "نعم");
  assert.equal((await fulfillmentRow(order.P)).status, "READY_FOR_PICKUP");
  const buyerView = await fulfillment(buyerC, order.P);
  assert.equal(buyerView.data.pickupPoint.addressText, pickupAddress);
  assert.equal(buyerView.data.pickupPoint.sharedByRole, "SELLER");
  // Seller account location is untouched; the pickup point is not an account field.
  const [seller] = await db.select().from(users).where(eq(users.id, sellerP.id));
  assert.equal(JSON.stringify(seller).includes(pickupAddress), false);
  // Handoff through the existing order authority records PICKED_UP.
  const handoff = await request(`/orders/${order.P}/delivery`, "POST", { proofType: "CODE", proofToken: "4821" }, sellerP.cookie);
  assert.equal(handoff.status, 200, handoff.raw);
  assert.equal(handoff.data.status, "SELLER_MARKED_DELIVERED");
  assert.equal((await fulfillmentRow(order.P)).status, "PICKED_UP");
});

await acceptance("D09", "unsupported method is refused with the available options", async () => {
  const pickup = await turn(buyerA, conv["Buyer A"], "استلام شخصي");
  assert.equal(pickup.surface, "DELIVERY_OPTIONS", pickup.body);
  assert.match(pickup.body, /لا يعرض الاستلام الشخصي/);
  assert.match(pickup.body, /توصيل من البائع/);
  assert.equal((await fulfillmentRow(order.D1)).method, "SELLER_DELIVERY");
  const delivers = await turn(buyerA, conv["Buyer A"], "هل البائع يوصل؟");
  assert.equal(delivers.surface, "DELIVERY_OPTIONS");
  assert.match(delivers.body, /نعم، البائع يوصل/);
  for (const method of ["SELLER_DELIVERY", "COURIER", "EXTERNAL_PROVIDER"] as const)
    assert.ok(
      await expectStatus(() => db.transaction((tx) => selectDeliveryMethod({ actorId: buyerC.id, orderId: order.P, method, market }, tx)), 409),
      method,
    );
});

await acceptance("D10", "state machine: valid path passes; jumps and wrong actors are rejected", async () => {
  // Fresh order E: REQUESTED.
  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyerE.id, orderId: order.E, method: "SELLER_DELIVERY", market }, tx));
  const same = await db.transaction((tx) => selectDeliveryMethod({ actorId: buyerE.id, orderId: order.E, method: "SELLER_DELIVERY", market }, tx));
  assert.equal(same.changed, false, "selecting the same method twice is idempotent");
  const invalid = async (to: any, actor = sellerD, status = 409) =>
    assert.ok(await expectStatus(() => db.transaction((tx) => transitionDelivery({ actorId: actor.id, orderId: order.E, to, market }, tx)), status), `${to} by ${actor.label}`);
  await invalid("DELIVERED");
  await invalid("PICKED_UP");
  await invalid("OUT_FOR_DELIVERY");
  await invalid("READY_FOR_PICKUP");
  // Accepting needs an accepted order and a destination.
  await invalid("ACCEPTED");
  // Legacy handoff cannot jump REQUESTED → delivered.
  await acceptOrder(sellerD, order.E);
  const jump = await request(`/orders/${order.E}/delivery`, "POST", { proofType: "CODE", proofToken: "1111" }, sellerD.cookie);
  assert.equal(jump.status, 409, jump.raw);
  assert.equal((await db.select().from(orders).where(eq(orders.id, order.E)))[0].status, "ACCEPTED");
  await db.transaction((tx) =>
    attachTransactionLocation({ actorId: buyerE.id, orderId: order.E, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", addressText: "عنوان الاختبار E" }, market }, tx),
  );
  // Buyer cannot drive seller transitions.
  await invalid("ACCEPTED", buyerE, 403);
  await db.transaction((tx) => transitionDelivery({ actorId: sellerD.id, orderId: order.E, to: "ACCEPTED", market }, tx));
  const repeat = await db.transaction((tx) => transitionDelivery({ actorId: sellerD.id, orderId: order.E, to: "ACCEPTED", market }, tx));
  assert.equal(repeat.changed, false, "repeating the current state is a no-op");
  await db.transaction((tx) => transitionDelivery({ actorId: sellerD.id, orderId: order.E, to: "OUT_FOR_DELIVERY", market }, tx));
  // Destination is locked once the seller is on the way.
  assert.ok(
    await expectStatus(
      () => db.transaction((tx) => attachTransactionLocation({ actorId: buyerE.id, orderId: order.E, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", addressText: "عنوان آخر" }, market }, tx)),
      409,
    ),
  );
  // Buyer cannot cancel once out for delivery; seller records a failure instead.
  await invalid("CANCELLED", buyerE);
  await db.transaction((tx) => transitionDelivery({ actorId: sellerD.id, orderId: order.E, to: "FAILED", failureReason: "BUYER_UNAVAILABLE", market }, tx));
  const failed = await fulfillmentRow(order.E);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.failureReason, "BUYER_UNAVAILABLE");
  assert.equal((await locationRows(order.E)).length, 0, "an ended arrangement keeps no location");
  const [stillOrder] = await db.select().from(orders).where(eq(orders.id, order.E));
  assert.equal(stillOrder.status, "ACCEPTED", "delivery failure does not cancel or refund the order");
  // Recovery: buyer chooses again; then cancels the arrangement (order untouched).
  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyerE.id, orderId: order.E, method: "SELLER_DELIVERY", market }, tx));
  assert.equal((await fulfillmentRow(order.E)).status, "REQUESTED");
  const conversationE = conv["Buyer E"];
  const cancel = await turn(buyerE, conversationE, "ألغِ التوصيل");
  assert.equal(cancel.surface, "DELIVERY_ACTION", cancel.body);
  const cancelled = await turn(buyerE, conversationE, "نعم");
  assert.match(cancelled.body, /الطلب نفسه لم يُلغَ/);
  assert.equal((await fulfillmentRow(order.E)).status, "CANCELLED");
  assert.equal((await db.select().from(orders).where(eq(orders.id, order.E)))[0].status, "ACCEPTED");
});

await acceptance("D08", "seller delivery: seller sees the authorized destination and advances state", async () => {
  // Open the exact order from the seller's own order list, then ask in that context.
  const listed = await turn(sellerD, conv["Seller Delivery"], "طلباتي");
  assert.equal(listed.surface, "ORDERS_LIST");
  const position = listed.payload.resourceIds.indexOf(order.D1);
  assert.ok(position >= 0 && position < 3);
  const opened = await turn(sellerD, conv["Seller Delivery"], ["الأول", "الثاني", "الثالث"][position]);
  assert.equal(opened.payload.resourceId, order.D1, opened.body);
  const status = await turn(sellerD, conv["Seller Delivery"], "موقع التسليم");
  assert.equal(status.surface, "DELIVERY_STATUS", status.body);
  assert.equal(status.delivery.order.destination.latitude, B.latitude, "seller sees the current destination B");
  const accept2 = await turn(sellerD, conv["Seller Delivery"], "اقبل التوصيل");
  assert.equal(accept2.surface, "DELIVERY_ACTION", accept2.body);
  await turn(sellerD, conv["Seller Delivery"], "نعم");
  const out = await turn(sellerD, conv["Seller Delivery"], "خرج للتوصيل");
  assert.equal(out.surface, "DELIVERY_ACTION", out.body);
  const outConfirmed = await turn(sellerD, conv["Seller Delivery"], "نعم");
  assert.equal(outConfirmed.surface, "DELIVERY_STATUS", outConfirmed.body);
  assert.equal((await fulfillmentRow(order.D1)).status, "OUT_FOR_DELIVERY");
  // Buyer can no longer change the destination.
  const late = await turn(buyerA, conv["Buyer A"], "غير موقع التسليم");
  assert.equal(late.delivery.view, "DELIVERY_NOTICE");
  assert.match(late.body, /خرج الطلب للتوصيل/);
});

await acceptance("D11", "seller handoff does not complete the order; the buyer's confirmation does", async () => {
  const handoffTurn = await turn(sellerD, conv["Seller Delivery"], "تم التوصيل");
  assert.equal(handoffTurn.surface, "ORDER", "final handoff goes to the existing order card with proof");
  const handoff = await request(`/orders/${order.D1}/delivery`, "POST", { proofType: "CODE", proofToken: "7731" }, sellerD.cookie);
  assert.equal(handoff.status, 200, handoff.raw);
  const [row] = await db.select().from(orders).where(eq(orders.id, order.D1));
  assert.equal(row.status, "SELLER_MARKED_DELIVERED");
  assert.equal((await fulfillmentRow(order.D1)).status, "DELIVERED");
  assert.equal((await db.select().from(sellerDues).where(eq(sellerDues.orderId, order.D1))).length, 0, "no due before the buyer confirms");
  const confirm = await request(`/orders/${order.D1}/confirm`, "POST", { received: true }, buyerA.cookie);
  assert.equal(confirm.status, 200, confirm.raw);
  assert.equal(confirm.data.status, "COMPLETED");
  const [due] = await db.select().from(sellerDues).where(eq(sellerDues.orderId, order.D1));
  assert.equal(due.amountMinor, row.platformFeeMinor);
  assert.equal(row.data.commissionRateBps, 1000);
  assert.equal(row.platformFeeMinor, Math.round((row.subtotalMinor * 1000) / 10_000));
  assert.equal(row.data.paymentMode, "TEST_NO_TRANSFER");
  // Completed: precise destination is cleared; coarse history remains for participants.
  const [location] = await locationRows(order.D1);
  assert.equal(location.latitude, null);
  assert.ok(location.redactedAt);
  const view = await fulfillment(buyerA, order.D1);
  assert.equal(view.data.destination.redacted, true);
  assert.equal(view.data.fulfillment.status, "DELIVERED");
  // Pickup order P completes the same way.
  const confirmP = await request(`/orders/${order.P}/confirm`, "POST", { received: true }, buyerC.cookie);
  assert.equal(confirmP.data.status, "COMPLETED");
  assert.equal((await locationRows(order.P))[0].addressText, null);
});

await acceptance("D12", "cross-user: another buyer cannot read or change a destination", async () => {
  const attempts: [string, () => Promise<boolean>][] = [
    ["read REST", async () => (await fulfillment(buyerA, order.B)).status === 404],
    ["read lib", () => expectStatus(() => getDeliveryView({ actorId: buyerA.id, orderId: order.B }), 404)],
    [
      "change",
      () =>
        expectStatus(
          () => db.transaction((tx) => attachTransactionLocation({ actorId: buyerA.id, orderId: order.B, purpose: "DELIVERY_DESTINATION", location: { source: "DEVICE", ...C }, market }, tx)),
          404,
        ),
    ],
    ["select method", () => expectStatus(() => db.transaction((tx) => selectDeliveryMethod({ actorId: buyerA.id, orderId: order.B, method: "SELLER_DELIVERY", market }, tx)), 404)],
    ["cancel", () => expectStatus(() => db.transaction((tx) => transitionDelivery({ actorId: buyerA.id, orderId: order.B, to: "CANCELLED", market }, tx)), 404)],
    ["other conversation turn", async () => (await request(`/ai/conversations/${conv["Buyer B"]}/turns`, "POST", { message: "حالة التوصيل" }, buyerA.cookie)).status === 404],
    ["other market actor read", async () => (await fulfillment(outsider, order.B)).status === 404],
    ["anonymous read", async () => (await request(`/orders/${order.B}/fulfillment`)).status === 401],
  ];
  // Using buyer B's request id inside buyer A's own conversation is stale, not a capability.
  const requestB = await turn(buyerB, conv["Buyer B"], "غير موقع التسليم");
  attempts.push([
    "foreign request id",
    async () => {
      const result = await turn(buyerA, conv["Buyer A"], "مشاركة موقعي الحالي", {
        location: { source: "DEVICE", ...C },
        locationRequestId: requestB.resultSetId,
      });
      return result.delivery.view === "DELIVERY_NOTICE" && (await locationRows(order.B))[0].addressText === manualAddress;
    },
  ]);
  for (const [name, attempt] of attempts) {
    cross.user.total++;
    if (await attempt()) cross.user.passed++;
    else assert.fail(`cross-user attempt succeeded: ${name}`);
  }
  await turn(buyerB, conv["Buyer B"], "إلغاء");
  const [row] = await locationRows(order.B);
  assert.equal(row.addressText, manualAddress);
});

await acceptance("D13", "cross-seller: another seller cannot inspect or update a delivery", async () => {
  const attempts: [string, () => Promise<boolean>][] = [
    ["read", async () => (await fulfillment(sellerB, order.D1)).status === 404],
    ["accept", () => expectStatus(() => db.transaction((tx) => transitionDelivery({ actorId: sellerB.id, orderId: order.E, to: "ACCEPTED", market }, tx)), 404)],
    ["pickup point", () => expectStatus(() => db.transaction((tx) => attachTransactionLocation({ actorId: sellerB.id, orderId: order.P, purpose: "PICKUP_POINT", location: { source: "MANUAL", addressText: "نقطة مزيفة" }, market }, tx)), 404)],
    ["handoff", async () => (await request(`/orders/${order.E}/delivery`, "POST", { proofType: "CODE", proofToken: "0000" }, sellerB.cookie)).status === 404],
  ];
  for (const [name, attempt] of attempts) {
    cross.user.total++;
    if (await attempt()) cross.user.passed++;
    else assert.fail(`cross-seller attempt succeeded: ${name}`);
  }
  // Seller B's own conversation cannot surface seller D's order.
  const status = await turn(sellerB, conv["Seller B"], "حالة التوصيل");
  assert.notEqual(status.delivery?.orderId, order.E);
});

await acceptance("D14", "cross-order: rights on order A are no capability on order B", async () => {
  // Buyer B is authorized on order B only; seller D on D1/E only.
  const attempts: [string, () => Promise<boolean>][] = [
    ["read other order", async () => (await fulfillment(buyerB, order.E)).status === 404],
    ["confirm other handoff", async () => (await request(`/orders/${order.E}/confirm`, "POST", { received: true }, buyerB.cookie)).status === 404],
    ["seller of D1 acts on B", () => expectStatus(() => db.transaction((tx) => transitionDelivery({ actorId: sellerD.id, orderId: order.B, to: "ACCEPTED", market }, tx)), 404)],
    ["buyer of S shares on P", () => expectStatus(() => db.transaction((tx) => attachTransactionLocation({ actorId: buyerB.id, orderId: order.S, purpose: "SERVICE_APPOINTMENT", location: { source: "DEVICE", ...C }, market }, tx)), 404)],
  ];
  // A pending action from buyer B's conversation cannot be applied by buyer A.
  const pending = await turn(buyerB, conv["Buyer B"], "ألغِ التوصيل");
  attempts.push([
    "foreign pending action",
    async () => {
      const { applyDeliveryAction } = await import("../src/ai/delivery-turn");
      return expectStatus(() => applyDeliveryAction({ actionId: pending.resultSetId, actorId: buyerA.id, market, decision: "CONFIRM" }), 404);
    },
  ]);
  for (const [name, attempt] of attempts) {
    cross.order.total++;
    if (await attempt()) cross.order.passed++;
    else assert.fail(`cross-order attempt succeeded: ${name}`);
  }
  await turn(buyerB, conv["Buyer B"], "لا");
  assert.equal((await fulfillmentRow(order.B)).status, "REQUESTED");
});

await acceptance("D25", "market mismatch: a participant with a different active market cannot mutate the order's delivery", async () => {
  // Buyer B and seller B are the real participants of JO order B; both switch to KW.
  const before = { fulfillment: await fulfillmentRow(order.B), locations: await locationRows(order.B) };
  for (const actor of [buyerB, sellerB]) {
    const switched = await request("/account/market", "PATCH", { marketId: "KW" }, actor.cookie);
    assert.equal(switched.status, 200, switched.raw);
  }
  try {
    const [stored] = await db.select().from(users).where(eq(users.id, buyerB.id));
    assert.equal(stored.activeMarketId, "KW");
    const active = await marketFor({ actor: stored });
    const mismatch = async (attempt: () => Promise<unknown>) => {
      try {
        await attempt();
        return false;
      } catch (error) {
        return (error as { status?: number; code?: string }).status === 409 && (error as { code?: string }).code === "MARKET_MISMATCH";
      }
    };
    const attempts: [string, () => Promise<boolean>][] = [
      ["buyer selects method", () => mismatch(() => db.transaction((tx) => selectDeliveryMethod({ actorId: buyerB.id, orderId: order.B, method: "SELLER_DELIVERY", market: active }, tx)))],
      ["buyer attaches destination", () => mismatch(() => db.transaction((tx) => attachTransactionLocation({ actorId: buyerB.id, orderId: order.B, purpose: "DELIVERY_DESTINATION", location: { source: "DEVICE", ...C }, market: active }, tx)))],
      ["seller advances state", () => mismatch(() => db.transaction((tx) => transitionDelivery({ actorId: sellerB.id, orderId: order.B, to: "ACCEPTED", market: active }, tx)))],
      // The conversational endpoint reports business refusals in its normal
      // completed-turn envelope; the HTTP status is not the domain result.
      ["buyer delivery turn", async () => {
        const mismatchConversation = await conversation(buyerB);
        const response = await request(`/ai/conversations/${mismatchConversation}/turns`, "POST", { message: "أريد توصيل" }, buyerB.cookie);
        assert.equal(response.status, 200, response.raw);
        const assistantMessage = completion(response.raw)?.assistantMessage;
        assert.ok(assistantMessage, "market refusal should complete without a delivery action");
        assert.match(assistantMessage.body, /الطلب في سوق آخر.*غيّر السوق النشط/u);
        return true;
      }],
    ];
    for (const [name, attempt] of attempts) assert.ok(await attempt(), `market-mismatch attempt was not rejected: ${name}`);
  } finally {
    for (const actor of [buyerB, sellerB]) {
      const restored = await request("/account/market", "PATCH", { marketId: "JO" }, actor.cookie);
      assert.equal(restored.status, 200, restored.raw);
    }
  }
  assert.deepEqual(await fulfillmentRow(order.B), before.fulfillment, "no delivery mutation");
  assert.deepEqual(await locationRows(order.B), before.locations, "no location change");
});

await acceptance("D23", "service appointment location reuses the same purpose-scoped authority", async () => {
  const requested = await turn(buyerC, conv["Buyer C"], "أرسل موقعي");
  assert.equal(requested.surface, "LOCATION_PERMISSION_REQUEST", requested.body);
  assert.equal(requested.delivery.orderId, order.S);
  assert.equal(requested.delivery.request.purpose, "SERVICE_APPOINTMENT");
  const preview = await turn(buyerC, conv["Buyer C"], "مشاركة موقعي الحالي", {
    location: { source: "DEVICE", ...SERVICE_POINT },
    locationRequestId: requested.resultSetId,
  });
  assert.equal(preview.surface, "LOCATION_PREVIEW");
  await turn(buyerC, conv["Buyer C"], "نعم");
  const [row] = await locationRows(order.S);
  assert.equal(row.purpose, "SERVICE_APPOINTMENT");
  assert.equal(await fulfillmentRow(order.S), undefined, "no delivery record is needed for a service location");
  const providerView = await fulfillment(sellerS, order.S);
  assert.equal(providerView.data.serviceLocation.latitude, SERVICE_POINT.latitude);
});

await acceptance("D15", "public listings, search, profiles and jobs expose no transaction location", async () => {
  const pages = await Promise.all([
    request(`/listings?search=${encodeURIComponent(runId)}`),
    request(`/listings?search=${encodeURIComponent(runId)}`, "GET", undefined, outsider.cookie),
    request(`/listings/${listing.delivery.id}`),
    request(`/listings/${listing.pickup.id}`),
    request(`/listings/${listing.service.id}`),
    request(`/listings/${listing.deliveryB.id}`, "GET", undefined, buyerA.cookie),
    request("/categories"),
    request("/auth/me", "GET", undefined, sellerP.cookie),
    request("/auth/me", "GET", undefined, buyerB.cookie),
    request("/orders", "GET", undefined, buyerB.cookie),
    request("/dashboard", "GET", undefined, sellerD.cookie),
  ]);
  // Job and candidate surfaces in conversation carry no transaction location either.
  const jobsConversation = await conversation(outsider);
  const jobTurns = [
    await turn(outsider, jobsConversation, "أبحث عن وظيفة محاسب"),
    await turn(outsider, jobsConversation, "أبحث عن مرشحين مطور"),
  ];
  const text = [...pages.map((page) => page.raw), ...jobTurns.map((item) => JSON.stringify(item))].join("\n");
  assert.deepEqual(containsSentinel(text), []);
  for (const forbidden of ["latitude", "longitude", "addressText", "transactionLocation", "pickupPoint"])
    assert.equal(pages.slice(0, 7).some((page) => page.raw.includes(forbidden)), false, forbidden);
});

await acceptance("D17", "account state: suspended and deactivated actors cannot mutate; history stays private", async () => {
  // Order E is still open for buyer E; suspension revokes the session and the in-transaction check blocks.
  await db.transaction((tx) =>
    setUserModerationStatus(tx, { actor: { id: moderator.id, role: "ADMIN" }, userId: buyerE.id, status: "SUSPENDED", reason: "Block D suspension probe" }),
  );
  try {
    const blocked = await request(`/ai/conversations/${conv["Buyer E"]}/turns`, "POST", { message: "توصيل من البائع" }, buyerE.cookie);
    assert.equal(blocked.status, 401);
    assert.ok(await expectStatus(() => db.transaction((tx) => selectDeliveryMethod({ actorId: buyerE.id, orderId: order.E, method: "SELLER_DELIVERY", market }, tx)), 403));
  } finally {
    await db.transaction((tx) =>
      setUserModerationStatus(tx, { actor: { id: moderator.id, role: "ADMIN" }, userId: buyerE.id, status: "ACTIVE", reason: "Block D probe restored" }),
    );
  }
  // RESTRICTED may finish existing orders under the existing policy.
  await db.transaction((tx) =>
    setUserModerationStatus(tx, { actor: { id: moderator.id, role: "ADMIN" }, userId: buyerE.id, status: "RESTRICTED", reason: "Block D restriction probe" }),
  );
  try {
    const restricted = await db.transaction((tx) => selectDeliveryMethod({ actorId: buyerE.id, orderId: order.E, method: "SELLER_DELIVERY", market }, tx));
    assert.equal(restricted.changed, true);
  } finally {
    await db.transaction((tx) =>
      setUserModerationStatus(tx, { actor: { id: moderator.id, role: "ADMIN" }, userId: buyerE.id, status: "ACTIVE", reason: "Block D probe restored" }),
    );
  }
  // Buyer A has only completed orders: self-deactivation succeeds and blocks new mutations.
  await db.transaction((tx) => deactivateOwnAccount(tx, buyerA.id));
  assert.ok(
    await expectStatus(
      () => db.transaction((tx) => attachTransactionLocation({ actorId: buyerA.id, orderId: order.D1, purpose: "DELIVERY_DESTINATION", location: { source: "DEVICE", ...C }, market }, tx)),
      403,
    ),
    "a deactivated account cannot mutate",
  );
  const [deactivated] = await db.select({ status: users.status }).from(users).where(eq(users.id, buyerA.id));
  assert.equal(deactivated.status, "DEACTIVATED");
  // The seller's historical view keeps no precise location of the deactivated buyer.
  const sellerHistory = await fulfillment(sellerD, order.D1);
  assert.equal(sellerHistory.status, 200);
  assert.equal(sellerHistory.data.destination.latitude, null);
  assert.equal(sellerHistory.data.destination.redacted, true);
  const publicPages = await request(`/listings?search=${encodeURIComponent(runId)}`);
  assert.deepEqual(containsSentinel(publicPages.raw), []);
});

await acceptance("D18", "history keeps the selected method and commission after seller settings change", async () => {
  const before = await fulfillment(sellerD, order.D1);
  const changed = await request(`/listings/${listing.delivery.id}`, "PATCH", listingBody(`مكتب خشبي ${runId}`, "PICKUP"), sellerD.cookie);
  assert.equal(changed.status, 200, changed.raw);
  const after = await fulfillment(sellerD, order.D1);
  assert.equal(after.data.fulfillment.method, "SELLER_DELIVERY");
  assert.equal(after.data.fulfillment.status, "DELIVERED");
  assert.equal(after.data.capability, before.data.capability);
  assert.equal(after.data.capability, "SELLER_DELIVERY");
  assert.equal(after.data.fee.implemented, false);
  const [row] = await db.select().from(orders).where(eq(orders.id, order.D1));
  assert.equal(row.data.fulfilmentType, "DELIVERY");
  assert.equal(row.data.commissionRateBps, 1000);
  // Open order E also keeps the snapshot: seller delivery remains selectable for it.
  const view = await getDeliveryView({ actorId: buyerE.id, orderId: order.E, market });
  assert.equal(view.options.find((option) => option.method === "SELLER_DELIVERY")!.available, true);
});

await acceptance("D22", "reload restores server state without a new location reading", async () => {
  const detail = await request(`/ai/conversations/${conv["Buyer C"]}`, "GET", undefined, buyerC.cookie);
  assert.equal(detail.status, 200, detail.raw);
  const deliveryBlocks = detail.data.messages.flatMap((message: any) => message.blocks).filter((block: any) => block.payload?.delivery);
  assert.ok(deliveryBlocks.length > 0);
  const confirmed = deliveryBlocks.filter((block: any) => block.payload.delivery.view === "LOCATION_CONFIRMED").at(-1);
  assert.equal(confirmed.payload.delivery.order.serviceLocation.latitude, SERVICE_POINT.latitude, "restored from the server");
  // Settled previews show their outcome only, never the old reading.
  const previews = deliveryBlocks.filter((block: any) => block.payload.delivery.view === "LOCATION_PREVIEW");
  assert.ok(previews.every((block: any) => block.payload.delivery.action.status !== "PENDING" && block.payload.delivery.preview.latitude === null));
  // Stored rows in every conversation hold no coordinates or address text.
  const stored = await pool.query("select payload::text as p from ai_ui_blocks");
  assert.deepEqual(containsSentinel(stored.rows.map((row) => row.p).join("\n")), []);
});

await acceptance("D20", "AI disabled: every deterministic delivery path made zero model calls", async () => {
  assert.equal(providerConfigured, false);
  assert.ok(modelCalls.length >= 40, `exercised ${modelCalls.length} phrases`);
  assert.deepEqual(modelCalls.filter((call) => call.calls !== 0), []);
  assert.equal(getModelGatewayCallCount(), 0);
  // Normalization covers the common phrasings without a model.
  const phrases: [string, string][] = [
    ["أرسل موقعي", "SHARE_LOCATION"],
    ["شارك الموقع", "SHARE_LOCATION"],
    ["هذا موقع التسليم", "SHARE_LOCATION"],
    ["هذا موقع الاستلام", "SHARE_LOCATION"],
    ["أرسل موقع الاستلام للبائع", "SHARE_LOCATION"],
    ["عنوان التسليم", "LOCATION_MENTION"],
    ["غيّر موقع التسليم", "CHANGE_LOCATION"],
    ["غير عنوان التسليم", "CHANGE_LOCATION"],
    ["غير الموقع", "CHANGE_LOCATION_CONTEXT"],
    ["ألغِ الموقع", "CANCEL_LOCATION"],
    ["اكتب العنوان يدويًا", "MANUAL_ADDRESS"],
    ["استلام شخصي", "CHOOSE_PICKUP"],
    ["استلم بنفسي", "CHOOSE_PICKUP"],
    ["أريد توصيل", "DELIVERY_OPTIONS"],
    ["اختر التوصيل", "DELIVERY_OPTIONS"],
    ["توصيل من البائع", "CHOOSE_SELLER_DELIVERY"],
    ["هل البائع يوصل؟", "ASK_SELLER_DELIVERS"],
    ["يوصل", "ASK_SELLER_DELIVERS"],
    ["ألغِ التوصيل", "CANCEL_DELIVERY"],
  ];
  for (const [phrase, expected] of phrases) assert.equal(deliveryIntent(normalizeDeliveryText(phrase)), expected, phrase);
  // Employment and search phrasing that merely contains these words is not claimed.
  for (const phrase of ["أبحث عن وظيفة سائق توصيل", "سيارة للبيع مع توصيل مجاني", "موقعي الإلكتروني"])
    assert.equal(deliveryIntent(normalizeDeliveryText(phrase)), undefined, phrase);
});

await acceptance("D24", "no real delivery provider: courier/provider options unavailable, no external calls", async () => {
  const noSupplyListing = await publish(sellerB, `طلب D24 بلا تغطية ${runId}`, "DELIVERY");
  const [listingRow] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, noSupplyListing.id));
  await db.update(offers).set({ data: { ...listingRow!.data, city: `مدينة D24 ${runId}` } }).where(eq(offers.id, noSupplyListing.id));
  const noSupplyOrder = (await buy(buyerB, noSupplyListing.id, "DELIVERY")).id;
  await acceptOrder(sellerB, noSupplyOrder);
  const view = await fulfillment(buyerB, noSupplyOrder);
  const [orderRow] = await db.select().from(orders).where(eq(orders.id, noSupplyOrder));
  const liveMarket = await marketFor({ actor: { activeMarketId: "JO" } });
  const expectedCourier = deliveryOptions(orderRow!, liveMarket, await hasEligibleCourierSupply(orderRow!))
    .find((candidate) => candidate.method === "COURIER")!.available;
  assert.equal(view.data.options.find((candidate: any) => candidate.method === "COURIER").available, expectedCourier);
  assert.equal(view.data.options.find((candidate: any) => candidate.method === "EXTERNAL_PROVIDER").available, false);
  const rows = await pool.query(
    "select count(*) as n from order_fulfillments where order_id = $1 and method in ('COURIER', 'EXTERNAL_PROVIDER')",
    [noSupplyOrder],
  );
  assert.equal(Number(rows.rows[0].n), 0, "the no-supply order has no courier/provider fulfilment");
  assert.deepEqual(external, []);
});

await acceptance("DB", "invariants: constraints reject invalid rows; one snapshot per order and purpose", async () => {
  // PostgreSQL reports the first failing check by name; overlapping checks are listed.
  const probe = async (statement: string, params: unknown[], constraint: string | string[]) => {
    const allowed = Array.isArray(constraint) ? constraint : [constraint];
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(statement, params);
      assert.fail(`${constraint} accepted an invalid row`);
    } catch (error: any) {
      const cause = error?.constraint ? error : error?.cause;
      assert.ok(allowed.includes(cause?.constraint), `${cause?.constraint ?? error?.message} not in ${allowed}`);
    } finally {
      await client.query("rollback");
      client.release();
    }
  };
  const loc = "insert into transaction_locations (id, order_id, market_id, purpose, source, latitude, longitude, address_text, shared_by) values ($1, $2, 'JO', $3, $4, $5, $6, $7, $8)";
  await probe(loc, [randomUUID(), order.B, "DELIVERY_DESTINATION", "DEVICE", 91, 10, null, buyerB.id], "transaction_locations_coordinates_range");
  await probe(loc, [randomUUID(), order.B, "DELIVERY_DESTINATION", "DEVICE", 10, 181, null, buyerB.id], "transaction_locations_coordinates_range");
  await probe(loc, [randomUUID(), order.B, "HOME", "MANUAL", null, null, "x", buyerB.id], "transaction_locations_purpose_valid");
  await probe(loc, [randomUUID(), order.B, "PICKUP_POINT", "DEVICE", null, null, null, buyerB.id], "transaction_locations_content_present");
  await probe(loc, [randomUUID(), order.B, "DELIVERY_DESTINATION", "MANUAL", null, null, "مكرر", buyerB.id], "transaction_locations_order_purpose_unique");
  await probe(loc, [randomUUID(), "missing-order", "PICKUP_POINT", "MANUAL", null, null, "x", buyerB.id], "transaction_locations_order_id_orders_id_fk");
  const ful = "update order_fulfillments set method = $2, status = $3, failure_reason = $4 where order_id = $1";
  await probe(ful, [order.B, "DRONE", "REQUESTED", null], "order_fulfillments_method_valid");
  await probe(ful, [order.B, "SELLER_DELIVERY", "TELEPORTED", null], ["order_fulfillments_status_valid", "order_fulfillments_status_method_consistent"]);
  await probe(ful, [order.B, "PICKUP", "OUT_FOR_DELIVERY", null], "order_fulfillments_status_method_consistent");
  await probe(ful, [order.B, "SELLER_DELIVERY", "FAILED", null], "order_fulfillments_failure_consistent");
  await probe(
    "insert into order_fulfillments (order_id, market_id, method, status, selected_by, status_changed_by) values ($1, 'JO', 'PICKUP', 'REQUESTED', $2, $2)",
    [order.B, buyerB.id],
    "order_fulfillments_pkey",
  );
  const indexes = await pool.query(
    "select indexdef from pg_indexes where tablename in ('transaction_locations', 'order_fulfillments')",
  );
  assert.equal(indexes.rows.some((row) => /latitude|longitude|gist/i.test(row.indexdef)), false, "no geographic index");
});

await acceptance("D21", "connected browser journeys at 320/360/390/414 (D01, D02, D04, D07, D08, D16, D22)", async () => {
  // Fresh browser actors and orders so the browser drives real flows from the start.
  const browserBuyer = await register("Browser Buyer");
  const browserSeller = await register("Browser Seller");
  const browserPickupBuyer = await register("Browser Pickup Buyer");
  const deliveryListing = await publish(browserSeller, `طاولة تجربة ${runId}`, "DELIVERY");
  const pickupListing = await publish(browserSeller, `مصباح تجربة ${runId}`, "PICKUP");
  const browserCourier = await register("Browser Courier");
  const [deliveryRecord] = await db.select({ data: offers.data }).from(offers).where(eq(offers.id, deliveryListing.id));
  const courierDraft = await ensureDriverDraft({
    userId: browserCourier.id,
    market,
    vehicleType: "CAR",
    serviceCity: String(deliveryRecord?.data?.city ?? ""),
  });
  await submitDriverProfile({ userId: browserCourier.id, market, profileId: courierDraft.profile.id });
  await reviewDriverProfile({ adminId: moderator.id, profileId: courierDraft.profile.id, decision: "APPROVE" });
  await setDriverAvailability({ userId: browserCourier.id, market, availability: "AVAILABLE" });
  const browserOrder = (await buy(browserBuyer, deliveryListing.id, "DELIVERY")).id;
  const pickupOrder = (await buy(browserPickupBuyer, pickupListing.id, "PICKUP")).id;
  await acceptOrder(browserSeller, browserOrder);
  await acceptOrder(browserSeller, pickupOrder);
  const web = await startDinarBrowserTestWeb();
  const resultPath = `/tmp/dinar-blockd-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/block-d-ui-acceptance.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        BLOCKD_WEB_BASE: web.baseUrl,
        BLOCKD_API_ORIGIN: `http://127.0.0.1:${port}`,
        BLOCKD_BUYER_COOKIE: browserBuyer.cookie,
        BLOCKD_SELLER_COOKIE: browserSeller.cookie,
        BLOCKD_PICKUP_BUYER_COOKIE: browserPickupBuyer.cookie,
        BLOCKD_SENTINELS: JSON.stringify(["31.951111", "35.923333", `شارع التجربة ${runId}`]),
        BLOCKD_RUN_ID: runId,
        BLOCKD_UI_RESULT_PATH: resultPath,
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
  console.log("BLOCKD_BROWSER", JSON.stringify({ ...browserReport, checks: browserReport?.checks?.length }));
  if (browserError && !browserReport) throw browserError;
  assert.ok(browserReport, "browser acceptance must report");
  assert.equal(browserReport.failure, undefined, browserReport.failure);
  assert.deepEqual(browserReport.pageErrors, []);
  assert.deepEqual(browserReport.consoleErrors, []);
  assert.equal(browserReport.horizontalOverflow, 0);
  assert.deepEqual(browserReport.externalRequests, []);
  assert.equal(browserReport.urlLeaks, 0);
  assert.equal(browserReport.unexpectedLocationReads, 0);
  assert.equal(browserReport.watchPositionCalls, 0);
  assert.ok(browserReport.explicitAttempts >= 1);
  assert.equal(browserReport.locationReads, browserReport.explicitAttempts, "one device read per explicit attempt");
  // Server state the browser created is real and order-scoped.
  const [destination] = await locationRows(browserOrder);
  assert.equal(destination.purpose, "DELIVERY_DESTINATION");
  assert.equal((await fulfillmentRow(browserOrder)).status, "OUT_FOR_DELIVERY");
  assert.equal((await fulfillmentRow(pickupOrder)).method, "PICKUP");
  const stored = await pool.query("select payload::text as p from ai_ui_blocks");
  assert.equal(stored.rows.some((row) => row.p.includes("31.951111") || row.p.includes(`شارع التجربة ${runId}`)), false);
  assert.equal(getModelGatewayCallCount(), 0, "browser journeys must not reach the model");
});

await acceptance("D16", "URLs and server logs carry no coordinates or address text", async () => {
  assert.deepEqual(requestedUrls.filter((url) => containsSentinel(decodeURIComponent(url)).length), []);
  assert.equal(browserReport?.urlLeaks ?? 0, 0);
  // Application logs are captured by the runner and scanned after the suite (see report).
  // Everything the process prints, server logs included, is captured and scanned by test/run.mjs (LOG_SCAN).
  assert.ok(process.env.BDINAR_LOG_SENTINELS_FILE, "run with BDINAR_LOG_SCAN=1 so the runner scans captured logs");
});

await test("summary", async () => {
  const ids = Object.keys(results).sort();
  const passed = ids.filter((id) => results[id] === "PASS").length;
  console.log(
    "BLOCKD_SUMMARY",
    JSON.stringify({
      passed,
      total: ids.length,
      results,
      crossUser: cross.user,
      crossOrder: cross.order,
      modelCalls: modelCalls.reduce((sum, call) => sum + call.calls, 0),
      deterministicPhrases: modelCalls.length,
      externalRequests: external.length,
      locationReads: browserReport?.locationReads,
      explicitAttempts: browserReport?.explicitAttempts,
      unexpectedLocationReads: browserReport?.unexpectedLocationReads,
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
