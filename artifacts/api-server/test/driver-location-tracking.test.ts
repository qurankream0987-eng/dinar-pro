/**
 * First-party driver location sharing (migration 0061) on top of the existing Block D / F4
 * courier flow. Every coordinate here is SYNTHETIC test data near Amman; no device, map,
 * routing or tracking provider is contacted (outbound requests are recorded and must be zero).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import app from "../src/app";
import { db, deliveryAssignments, driverLocationShares, driverProfiles, markets, messages, orderFulfillments, pool, users } from "@workspace/db";
import { attachTransactionLocation, selectDeliveryMethod } from "../src/lib/delivery";
import { assignDelivery, driverHandoff, driverOutForDelivery, recordCourierProgress, revokeCourierAssignment, setDriverAvailability } from "../src/lib/driver";
import {
  ENDED_RETENTION_MS,
  IDLE_EXPIRY_MS,
  MIN_UPDATE_INTERVAL_MS,
  startDriverLocationSharing,
  sweepDriverLocationShares,
  updateDriverLocation,
} from "../src/lib/driver-location";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // not a URL
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const CITY = `عمان ${Date.now() % 100_000}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.41.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
  return { status: response.status, data, raw, cacheControl: response.headers.get("cache-control") ?? "", cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string; conv: string };
const phoneBase = 51_600_000 + ((Date.now() + process.pid) % 150_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Tracking-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR GPS ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, `${phoneNumber} ${started.raw} ${verified.raw} ${registered.raw}`);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  const actor = { id: registered.data.user.id, cookie: registered.cookie, conv: "" };
  actor.conv = (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id;
  return actor;
}

async function turn(actor: Actor, message: string) {
  const response = await fetch(`${base}/ai/conversations/${actor.conv}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  assert.ok(complete, raw.slice(0, 300));
  return complete.assistantMessage.body as string;
}

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let admin: Actor, seller: Actor, buyer: Actor, otherBuyer: Actor, driver: Actor, otherDriver: Actor;
// Synthetic positions (not real people): a short drive inside Amman.
const P1 = { latitude: 31.9539, longitude: 35.9106 };
const P2 = { latitude: 31.9545, longitude: 35.9120 };
const AQABA = { latitude: 29.5267, longitude: 35.0078 };

async function becomeDriver(actor: Actor) {
  await db.update(users).set({ city: CITY }).where(eq(users.id, actor.id));
  await turn(actor, "أريد أكون سائق بسيارة");
  await turn(actor, "نعم");
  const [profile] = await db.select().from(driverProfiles).where(and(eq(driverProfiles.userId, actor.id), eq(driverProfiles.marketId, "JO")));
  assert.equal((await request(`/admin/drivers/${profile!.id}/review`, "POST", { decision: "APPROVE" }, admin.cookie)).status, 200);
  await setDriverAvailability({ userId: actor.id, market: JO, availability: "AVAILABLE" });
}

async function courierOrder(who: Actor = buyer) {
  const listing = await request("/listings", "POST", {
    title: `طاولة تتبع ${runId}`, description: `اختبار التتبع المباشر ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: CITY,
    attributes: {}, unitPrice: "10.000", inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "DELIVERY", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "DELIVERY", idempotencyKey: `gps-${randomUUID()}` }, who.cookie);
  assert.equal(order.status, 201, order.raw);
  assert.equal((await request(`/orders/${order.data.id}/accept`, "POST", {}, seller.cookie)).status, 200);
  await db.transaction((tx) => selectDeliveryMethod({ actorId: who.id, orderId: order.data.id, method: "COURIER", market: JO }, tx));
  await db.transaction((tx) => attachTransactionLocation({ actorId: who.id, orderId: order.data.id, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", city: CITY, area: "الصويفية", addressText: `عنوان اختبار ${runId}` }, market: JO }, tx));
  return order.data.id as string;
}

const at = (ms: number) => new Date(ms).toISOString();
const share = async (orderId: string) => (await db.select().from(driverLocationShares).where(eq(driverLocationShares.orderId, orderId)))[0];
const tracking = (orderId: string, actor: Actor) => request(`/orders/${orderId}/tracking`, "GET", undefined, actor.cookie);
const post = (orderId: string, path: string, body: unknown, actor: Actor) => request(`/courier/orders/${orderId}/location-sharing/${path}`, "POST", body, actor.cookie);
let seq = 0;
const fix = (point: { latitude: number; longitude: number }, observedAt = new Date(), accuracyMeters = 12) => ({ ...point, accuracyMeters, observedAt: observedAt.toISOString(), sequence: ++seq });

let orderA: string;

await test("setup: JO courier market, accounts, two approved drivers", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
  [admin, seller, buyer, otherBuyer, driver, otherDriver] = await Promise.all(["Admin", "Seller", "Buyer", "Other Buyer", "Driver", "Other Driver"].map(register));
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await becomeDriver(driver);
  await becomeDriver(otherDriver);
});

await test("sharing needs the assignment and explicit consent; strangers learn nothing", async () => {
  orderA = await courierOrder();
  assert.equal((await post(orderA, "start", { consent: true }, driver)).status, 404, "not assigned yet");
  await assignDelivery({ actorId: driver.id, orderId: orderA, market: JO });
  assert.equal((await post(orderA, "start", {}, driver)).status, 400, "consent is required");
  assert.equal((await post(orderA, "start", { consent: false }, driver)).status, 400);
  for (const actor of [otherDriver, buyer, seller, otherBuyer]) assert.equal((await post(orderA, "start", { consent: true }, actor)).status, 404);
  assert.equal((await post(orderA, "location", fix(P1), otherDriver)).status, 404, "another driver cannot inject a position");
  const started = await post(orderA, "start", { consent: true }, driver);
  assert.equal(started.status, 200, started.raw);
  assert.equal(started.data.active, true);
  assert.match(started.cacheControl, /no-store/);
  const before = await tracking(orderA, buyer);
  assert.equal(before.data.tracking.state, "UNAVAILABLE", "sharing started but no fix yet: nothing invented");
});

await test("an accepted fix reaches only the order's buyer, live and no-store", async () => {
  const accepted = await post(orderA, "location", fix(P1), driver);
  assert.equal(accepted.status, 202, accepted.raw);
  const view = await tracking(orderA, buyer);
  assert.match(view.cacheControl, /no-store/);
  assert.equal(view.data.tracking.state, "LIVE");
  assert.equal(view.data.tracking.position.latitude, P1.latitude);
  assert.equal(view.data.tracking.route, null, "no routing provider: no route");
  assert.equal(view.data.tracking.eta, null, "no routing provider: no ETA");
  const sellerView = await tracking(orderA, seller);
  assert.equal(sellerView.data.tracking.state, "UNAVAILABLE");
  assert.ok(!sellerView.raw.includes(String(P1.latitude)), "the seller never receives the driver's coordinates");
  assert.equal((await tracking(orderA, otherBuyer)).status, 404, "another buyer gets 404");
  const strangerOrder = await courierOrder(otherBuyer);
  const crossed = await tracking(strangerOrder, otherBuyer);
  assert.ok(!crossed.raw.includes(String(P1.latitude)), "no cross-order leakage");
  const audit = await db.select({ body: messages.body }).from(messages).where(sql`${messages.body} like ${"%" + String(P1.latitude) + "%"}`);
  assert.equal(audit.length, 0, "coordinates never enter conversation or audit messages");
});

await test("replays, out-of-order and too-frequent updates are refused", async () => {
  const last = seq;
  const replay = await post(orderA, "location", { ...fix(P2), sequence: last }, driver);
  assert.equal(replay.status, 409);
  assert.equal(replay.data.reason, "DUPLICATE_OR_OUT_OF_ORDER");
  const tooSoon = await post(orderA, "location", fix(P2), driver);
  assert.equal(tooSoon.status, 429, "minimum interval between accepted fixes");
  assert.ok(Number(tooSoon.data.retryAfterMs) > 0);
  const now = Date.now() + MIN_UPDATE_INTERVAL_MS + 100;
  const later = await updateDriverLocation({ actorId: driver.id, orderId: orderA, marketId: "JO", update: fix(P2, new Date(now)), now: new Date(now) });
  assert.equal(later.accepted, true);
  const older = await updateDriverLocation({ actorId: driver.id, orderId: orderA, marketId: "JO", update: fix(P1, new Date(now - 60_000)), now: new Date(now + MIN_UPDATE_INTERVAL_MS + 100) });
  assert.deepEqual(older, { accepted: false, reason: "DUPLICATE_OR_OUT_OF_ORDER" }, "a fix observed before the stored one is never applied");
});

await test("server-side validation: future, old, inaccurate, null island and teleporting fixes", async () => {
  const base = Date.now() + 3 * MIN_UPDATE_INTERVAL_MS;
  const call = (update: any, now = base) => updateDriverLocation({ actorId: driver.id, orderId: orderA, marketId: "JO", update, now: new Date(now) }).then(() => "ok", (e) => e.code);
  assert.equal(await call(fix(P2, new Date(base + 60_000))), "TIMESTAMP_IN_FUTURE");
  assert.equal(await call(fix(P2, new Date(base - 10 * 60_000))), "TIMESTAMP_TOO_OLD");
  assert.equal(await call(fix(P2, new Date(base), 9_000)), "ACCURACY_TOO_LOW");
  assert.equal(await call({ latitude: 0, longitude: 0, accuracyMeters: 5, observedAt: at(base), sequence: ++seq }), "INVALID_POSITION");
  assert.equal(await call(fix(AQABA, new Date(base))), "IMPLAUSIBLE_MOVEMENT", "Amman → Aqaba in seconds is refused");
  assert.equal((await post(orderA, "location", { ...fix(P2), extra: 1 }, driver)).status, 400, "strict body");
  assert.equal((await post(orderA, "location", { ...fix(P2), latitude: 91 }, driver)).status, 400);
});

await test("a stale fix is labelled STALE, never shown as current", async () => {
  const now = Date.now() + 6 * MIN_UPDATE_INTERVAL_MS;
  await updateDriverLocation({ actorId: driver.id, orderId: orderA, marketId: "JO", update: fix(P2, new Date(Date.now() - 100_000)), now: new Date(now) }).catch(() => undefined);
  const [row] = await db.select().from(driverLocationShares).where(eq(driverLocationShares.orderId, orderA));
  // Force the stored fix older than the live window (90 s) to verify the label.
  await db.update(driverLocationShares).set({ observedAt: new Date(Date.now() - 100_000) }).where(eq(driverLocationShares.assignmentId, row!.assignmentId));
  const view = await tracking(orderA, buyer);
  assert.equal(view.data.tracking.state, "STALE");
});

await test("stopping clears coordinates; later fixes are refused; the buyer sees no position", async () => {
  const stopped = await post(orderA, "stop", {}, driver);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.active, false);
  const row = await share(orderA);
  assert.equal(row!.status, "ENDED");
  assert.equal(row!.endReason, "DRIVER_STOPPED");
  assert.equal(row!.latitude, null);
  assert.equal(row!.observedAt, null);
  assert.equal((await post(orderA, "location", fix(P1), driver)).status, 409);
  assert.equal((await tracking(orderA, buyer)).data.tracking.state, "UNAVAILABLE");
  const forced = await db.update(driverLocationShares).set({ latitude: 1, longitude: 1, observedAt: new Date() }).where(eq(driverLocationShares.orderId, orderA)).then(() => "written", (e) => e?.cause?.code ?? e?.code);
  assert.equal(forced, "23514", "the database refuses a position on an ended session");
});

await test("delivery completion ends sharing and tracking stops", async () => {
  assert.equal((await post(orderA, "start", { consent: true }, driver)).status, 200, "a restart is a fresh session");
  assert.equal((await share(orderA))!.sequence, 0);
  // R5: going out for delivery needs a courier fare both parties confirmed (existing rule, unchanged).
  const proposed = await request(`/orders/${orderA}/courier-fare/proposals`, "POST", { amount: "1.000", idempotencyKey: `gps-${randomUUID()}` }, buyer.cookie);
  assert.equal(proposed.status, 200, proposed.raw);
  for (const actor of [buyer, driver])
    assert.equal((await request(`/orders/${orderA}/courier-fare/confirm`, "POST", { proposalId: proposed.data.proposal.id }, actor.cookie)).status, 200);
  await recordCourierProgress({ actorId: driver.id, orderId: orderA, market: JO, type: "PICKED_UP" });
  await driverOutForDelivery({ actorId: driver.id, orderId: orderA, market: JO });
  assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderA)))[0]!.status, "OUT_FOR_DELIVERY");
  const now = Date.now() + 10 * MIN_UPDATE_INTERVAL_MS;
  assert.equal((await updateDriverLocation({ actorId: driver.id, orderId: orderA, marketId: "JO", update: fix(P1, new Date(now)), now: new Date(now) })).accepted, true);
  assert.equal((await tracking(orderA, buyer)).data.tracking.state === "UNAVAILABLE", false, "live during the trip");
  await driverHandoff({ actorId: driver.id, orderId: orderA, market: JO });
  const row = await share(orderA);
  assert.equal(row!.status, "ENDED");
  assert.equal(row!.endReason, "DELIVERY_ENDED");
  assert.equal(row!.latitude, null);
  assert.equal((await tracking(orderA, buyer)).data.tracking.state, "STOPPED");
  assert.equal((await post(orderA, "start", { consent: true }, driver)).status === 200, false, "no sharing after delivery");
});

await test("revoking the assignment ends sharing immediately", async () => {
  const orderB = await courierOrder();
  await assignDelivery({ actorId: otherDriver.id, orderId: orderB, market: JO });
  assert.equal((await post(orderB, "start", { consent: true }, otherDriver)).status, 200);
  assert.equal((await post(orderB, "location", fix(P1), otherDriver)).status, 202);
  await revokeCourierAssignment({ adminId: admin.id, orderId: orderB, market: JO, reason: "اختبار سحب المهمة", idempotencyKey: `gps-revoke-${randomUUID()}` });
  const row = await share(orderB);
  assert.equal(row!.status, "ENDED");
  assert.equal(row!.endReason, "ASSIGNMENT_ENDED");
  assert.equal(row!.latitude, null);
  const [assignment] = await db.select().from(deliveryAssignments).where(eq(deliveryAssignments.orderId, orderB));
  assert.equal(assignment!.status, "RELEASED");
});

await test("sweep: idle sessions expire, orphaned sessions end, ended rows are deleted after retention", async () => {
  const orderC = await courierOrder();
  await assignDelivery({ actorId: otherDriver.id, orderId: orderC, market: JO });
  await startDriverLocationSharing({ actorId: otherDriver.id, orderId: orderC, marketId: "JO", consent: true });
  const idle = await sweepDriverLocationShares(new Date(Date.now() + IDLE_EXPIRY_MS + 60_000));
  assert.ok(idle.ended >= 1, JSON.stringify({ idle, row: await share(orderC) }));
  assert.equal((await share(orderC))!.endReason, "EXPIRED");
  const purge = await sweepDriverLocationShares(new Date(Date.now() + IDLE_EXPIRY_MS + ENDED_RETENTION_MS + 120_000));
  assert.ok(purge.deleted >= 1);
  assert.equal(await share(orderC), undefined);
});

await test("disabled deployments refuse sharing and serve no position", async () => {
  const saved = process.env.DINAR_DRIVER_LOCATION_SHARING;
  process.env.DINAR_DRIVER_LOCATION_SHARING = "disabled";
  try {
    const orderD = await courierOrder();
    await assignDelivery({ actorId: driver.id, orderId: orderD, market: JO });
    const refused = await post(orderD, "start", { consent: true }, driver);
    assert.equal(refused.status, 503);
  } finally {
    if (saved === undefined) delete process.env.DINAR_DRIVER_LOCATION_SHARING;
    else process.env.DINAR_DRIVER_LOCATION_SHARING = saved;
  }
});

await test("no outbound network", () => {
  assert.deepEqual(external, []);
});

await test("teardown", async () => {
  server.close();
  await pool.end();
});
