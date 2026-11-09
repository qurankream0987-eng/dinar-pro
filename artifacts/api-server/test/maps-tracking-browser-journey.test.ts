/**
 * MAPS browser journey: real Chromium, the built web app (Vite dev), real conversation turns and
 * the real courier flow. The map uses an inline SYNTHETIC style that labels itself on screen, and
 * every position is synthetic test data near Amman: no map, routing or GPS provider is contacted.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db, driverProfiles, markets, pool, users } from "@workspace/db";
import { attachTransactionLocation, selectDeliveryMethod } from "../src/lib/delivery";
import { setDriverAvailability } from "../src/lib/driver";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

// Inline synthetic style: a navy background and a few fake streets. metadata marks it synthetic,
// so the map shows «خريطة اختبار اصطناعية — ليست بيانات حقيقية» on top of every screenshot.
const roads = [
  [[35.900, 31.950], [35.925, 31.950]],
  [[35.900, 31.957], [35.925, 31.957]],
  [[35.905, 31.945], [35.905, 31.962]],
  [[35.912, 31.945], [35.912, 31.962]],
  [[35.920, 31.945], [35.918, 31.962]],
];
process.env.VITE_DINAR_MAP_STYLE_URL = JSON.stringify({
  version: 8,
  metadata: { "dinar:synthetic": true },
  sources: {
    roads: { type: "geojson", data: { type: "FeatureCollection", features: roads.map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } })) } },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0a192a" } },
    { id: "roads-casing", type: "line", source: "roads", paint: { "line-color": "#16304d", "line-width": 9 } },
    { id: "roads", type: "line", source: "roads", paint: { "line-color": "#244a73", "line-width": 5 } },
  ],
});

const { default: app } = await import("../src/app");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const base = `${origin}/api`;
const runId = randomUUID().slice(0, 6);
const CITY = `عمان ${Date.now() % 100_000}`;
let ip = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.42.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` } : {}),
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

type Actor = { id: string; cookie: string; conv: string };
const phoneBase = 51_600_000 + ((Date.now() + process.pid + 7) % 150_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Maps-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: label, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
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
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  return { body: complete.assistantMessage.body as string, payload: complete.assistantMessage.blocks[0]?.payload ?? {} };
}

let JO: Awaited<ReturnType<typeof resolveMarket>>;

async function listingOrder(seller: Actor, buyer: Actor, title: string) {
  const listing = await request("/listings", "POST", {
    title: `${title} ${runId}`, description: `اختبار الخرائط ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: CITY,
    attributes: {}, unitPrice: "10.000", inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "DELIVERY", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "DELIVERY", idempotencyKey: `maps-${randomUUID()}` }, buyer.cookie);
  assert.equal(order.status, 201, order.raw);
  assert.equal((await request(`/orders/${order.data.id}/accept`, "POST", {}, seller.cookie)).status, 200);
  return order.data.id as string;
}

await test("MAPS browser: location picker, methods, honest timeline, synthetic live map, driver controls, completion", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
  const [admin, seller, buyerPick, buyerTrack, driver] = await Promise.all(["مدير الاختبار", "بائع الخرائط", "مشترٍ يختار الموقع", "مشترٍ يتابع التوصيل", "مندوب الاختبار"].map(register));
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  await db.update(users).set({ city: CITY }).where(eq(users.id, driver.id));
  await turn(driver, "أريد أكون سائق بسيارة");
  await turn(driver, "نعم");
  const [profile] = await db.select().from(driverProfiles).where(and(eq(driverProfiles.userId, driver.id), eq(driverProfiles.marketId, "JO")));
  assert.equal((await request(`/admin/drivers/${profile!.id}/review`, "POST", { decision: "APPROVE" }, admin.cookie)).status, 200);
  await setDriverAvailability({ userId: driver.id, market: JO, availability: "AVAILABLE" });

  // Tracking order first, so it is the oldest open courier work («أقبل الأول»): COURIER with a map-pinned destination (synthetic point), open for the driver.
  const trackOrder = await listingOrder(seller, buyerTrack, "طاولة");
  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyerTrack.id, orderId: trackOrder, method: "COURIER", market: JO }, tx));
  await db.transaction((tx) => attachTransactionLocation({ actorId: buyerTrack.id, orderId: trackOrder, purpose: "DELIVERY_DESTINATION", location: { source: "MAP", latitude: 31.9566, longitude: 35.9187 }, market: JO }, tx));

  // Picker order: the buyer is at the location-request step (delivery options were chosen in chat).
  const pickOrder = await listingOrder(seller, buyerPick, "مصباح");
  const options = await turn(buyerPick, "أريد توصيل");
  const summary = await turn(buyerPick, "مندوب يوصل طلبي");
  const request_ = await turn(buyerPick, "نعم");
  void options;
  void summary;

  const web = await startDinarBrowserTestWeb(origin);
  const reportPath = `/tmp/dinar-maps-${randomUUID()}.json`;
  const shots = `${process.cwd()}/../../docs/dinar-next/evidence/maps-tracking`;
  await mkdir(shots, { recursive: true });
  let runError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/maps-tracking-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        MT_WEB: web.baseUrl,
        MT_API: origin,
        MT_REPORT: reportPath,
        MT_SHOTS: shots,
        MT_FIXTURE: JSON.stringify({
          pickBuyer: buyerPick, trackBuyer: buyerTrack, driver, pickOrder, trackOrder,
          pickRequestSurface: request_.payload.surface ?? null,
        }),
      },
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    runError = error;
  } finally {
    await web.stop();
  }
  let report: any;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
    await unlink(reportPath);
  } catch {
    report = undefined;
  }
  console.log("MAPS_TRACKING_BROWSER", JSON.stringify(report));
  if (!report) throw runError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.ok(report.checks.length >= 20, JSON.stringify(report.checks));
});

after(async () => {
  server.close();
  await pool.end();
});
