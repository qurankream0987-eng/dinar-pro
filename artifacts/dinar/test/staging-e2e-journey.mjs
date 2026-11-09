#!/usr/bin/env node
/**
 * DINAR staging end-to-end journey (real Chromium against a deployed staging site).
 *
 * Preconditions, which this script checks but never creates:
 *   - an SMS adapter is registered (/api/readyz phoneVerification=ready);
 *   - the market in STG_MARKET (default JO) is ACTIVE through the governance workflow;
 *   - the two phone numbers are on DINAR_SMS_STAGING_ALLOWLIST and held by the operator.
 *
 * The operator types each SMS code when prompted. Nothing is bypassed: registration, login,
 * listing creation, the presigned photo PUT (exercising bucket CORS), search, cards, cart,
 * simulated checkout and the order view all go through the real browser and the public API.
 *
 * Usage:
 *   STG_BASE=https://dinar-staging-app-staging.up.railway.app \
 *   STG_SELLER_PHONE=+9627XXXXXXXX STG_BUYER_PHONE=+9627YYYYYYYY \
 *   node artifacts/dinar/test/staging-e2e-journey.mjs
 * Output: one JSON report (STG_REPORT, default ./staging-e2e-report.json) plus screenshots.
 */
import { chromium } from "@playwright/test";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";

const BASE = (process.env.STG_BASE ?? "").replace(/\/$/, "");
const MARKET = process.env.STG_MARKET ?? "JO";
const REPORT = process.env.STG_REPORT ?? "staging-e2e-report.json";
const SHOTS = process.env.STG_SHOTS ?? "staging-e2e-shots";
// STG_LOCAL_REHEARSAL=1 allows a loopback http dry run whose development SMS adapter returns the
// code in the challenge response; it is refused for any non-loopback origin.
const REHEARSAL = process.env.STG_LOCAL_REHEARSAL === "1";
if (REHEARSAL ? !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE) : !/^https:\/\//.test(BASE))
  throw new Error("STG_BASE must be the https staging origin (or http://127.0.0.1:<port> with STG_LOCAL_REHEARSAL=1)");
const phones = { seller: process.env.STG_SELLER_PHONE, buyer: process.env.STG_BUYER_PHONE };
for (const [role, phone] of Object.entries(phones))
  if (!/^\+9\d{9,13}$/.test(phone ?? "")) throw new Error(`STG_${role.toUpperCase()}_PHONE must be E.164`);

const run = randomUUID().slice(0, 8);
const report = { base: BASE, market: MARKET, run, startedAt: new Date().toISOString(), checks: [], failure: undefined, consoleErrors: [], pageErrors: [], externalHosts: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`CHECK FAILED: ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
};
const rl = createInterface({ input: process.stdin, output: process.stderr });
const split = (e164) => {
  // Jordan +962 / Kuwait +965: three-digit country codes.
  return { phoneCountryCode: e164.slice(0, 4), phoneNumber: e164.slice(4) };
};
// A 1×1 JPEG (synthetic product photo) used for the listing image.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

const executablePath = process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
await mkdir(SHOTS, { recursive: true });

async function actor(role, viewport) {
  const context = await browser.newContext({ viewport, locale: "ar" });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && report.consoleErrors.push(`${role}: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => report.pageErrors.push(`${role}: ${e.message.slice(0, 200)}`));
  page.on("request", (r) => {
    const host = new URL(r.url()).host;
    if (host !== new URL(BASE).host && !report.externalHosts.includes(host)) report.externalHosts.push(host);
  });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // Same-origin fetch from the real page: cookies, Origin checks and CSP all apply.
  const api = (method, path, body) =>
    page.evaluate(async ({ method, path, body }) => {
      // State-changing requests are JSON-only (CSRF rule), so a POST without a body sends {}.
      const write = method !== "GET";
      const response = await fetch(path, { method, headers: write ? { "content-type": "application/json", "idempotency-key": crypto.randomUUID() } : {}, body: write ? JSON.stringify(body ?? {}) : undefined, credentials: "same-origin" });
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
      return { status: response.status, json };
    }, { method, path: `/api${path}`, body });
  return { context, page, api };
}

async function registerAndLogin(role, a) {
  const phone = split(phones[role]);
  const challenge = await a.api("POST", "/auth/phone-verification/challenges", phone);
  check(`${role}: SMS challenge accepted`, challenge.status === 202, challenge);
  const code = REHEARSAL && challenge.json.developmentCode
    ? challenge.json.developmentCode
    : (await rl.question(`SMS code received on ${phones[role]} (${role}): `)).trim();
  const verified = await a.api("POST", "/auth/phone-verification/challenges/verify", { challengeId: challenge.json.challengeId, code });
  check(`${role}: SMS code verified`, verified.status === 200 && verified.json.verificationToken, verified.status);
  const password = `Stg-${run}-${role}-Aa1!`;
  const registered = await a.api("POST", "/auth/register", {
    displayName: role === "seller" ? `بائع تجريبي ${run}` : `مشتري تجريبي ${run}`,
    ...phone, accountCountry: MARKET, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.json.verificationToken,
  });
  check(`${role}: account registered`, registered.status === 201, registered.status);
  const me = await a.api("GET", "/auth/me");
  check(`${role}: session established`, me.json?.user?.id, me.status);
  // Logout + login proves the password path; a second SMS is not required for login.
  const out = await a.api("POST", "/auth/logout");
  check(`${role}: logout`, out.status < 300, out.status);
  const login = await a.api("POST", "/auth/login", { ...phone, password });
  check(`${role}: login`, login.status === 200, login.status);
  return me.json.user;
}

let failure;
try {
  const health = await fetch(`${BASE}/api/readyz`).then((r) => r.json());
  check("readiness: database, migrations and phone verification ready", health.checks?.database === "ready" && health.checks?.migrations === "current" && health.checks?.phoneVerification === "ready", health);
  const markets = await fetch(`${BASE}/api/markets`).then((r) => r.json());
  check(`market ${MARKET} active through governance`, markets.some((m) => m.id === MARKET && m.isActive), markets.filter((m) => m.isActive).map((m) => m.id));

  const seller = await actor("seller", { width: 1280, height: 800 });
  await registerAndLogin("seller", seller);

  // Listing photo: presigned PUT from the browser to the bucket (bucket CORS), then completion.
  const upload = await seller.api("POST", "/account/listing-photos/upload-url", { contentType: "image/jpeg", size: JPEG.length });
  check("seller: listing photo upload URL issued", upload.status === 200 && upload.json.uploadURL, upload.status);
  const put = await seller.page.evaluate(async ({ url, bytes }) => {
    const r = await fetch(url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(bytes) });
    return r.status;
  }, { url: upload.json.uploadURL, bytes: [...JPEG] });
  check("seller: browser PUT to bucket allowed by CORS", put >= 200 && put < 300, put);
  const complete = await seller.api("POST", "/account/listing-photos/complete", { objectPath: upload.json.objectPath });
  check("seller: listing photo completed", complete.status === 200, complete);

  const title = `هاتف تجريبي ${run}`;
  const listing = await seller.api("POST", "/listings", {
    title, description: `منتج تجريبي لاختبار بيئة ستيجنغ فقط (${run}). لا يُباع.`, category: "إلكترونيات", area: "عبدون", city: "عمّان", attributes: { condition: "جديد" },
    unitPrice: "10", inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "PICKUP", imageUrl: complete.json.objectPath, imageUrls: [],
  });
  check("seller: listing created", listing.status === 201, listing);
  const published = listing.json.status === "PUBLISHED" ? listing : await seller.api("PATCH", `/listings/${listing.json.id}/status`, { action: "RESUME" });
  check("seller: listing published (or awaiting configured review)", [200, 201].includes(published.status), published.status);
  await seller.page.screenshot({ path: `${SHOTS}/seller.png` });

  const buyer = await actor("buyer", { width: 390, height: 844 });
  await registerAndLogin("buyer", buyer);
  await buyer.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const box = buyer.page.getByLabel("رسالتك إلى DINAR AI");
  await box.fill(`ابحث عن هاتف تجريبي ${run}`);
  await box.press("Enter");
  const card = buyer.page.getByText(title).first();
  await card.waitFor({ timeout: 30_000 });
  check("buyer: conversation search shows the listing card", await card.isVisible());
  await buyer.page.screenshot({ path: `${SHOTS}/buyer-search.png` });

  const cart = await buyer.api("PUT", "/cart", { marketId: MARKET, items: [{ listingId: listing.json.id, quantity: 1 }] });
  check("buyer: cart updated from server prices", cart.status === 200, cart.status);
  const order = await buyer.api("POST", "/checkout", { items: [{ listingId: listing.json.id, quantity: 1, fulfilmentType: "PICKUP" }], idempotencyKey: `stg-checkout-${run}-0001` });
  check("buyer: simulated checkout created an order", order.status === 201 || order.status === 200, order);
  const orders = await buyer.api("GET", "/orders");
  check("buyer: order visible in orders", JSON.stringify(orders.json).includes(listing.json.id), orders.status);
  const sellerOrders = await seller.api("GET", "/orders");
  check("seller: order visible to seller", JSON.stringify(sellerOrders.json).includes(listing.json.id), sellerOrders.status);
  const stranger = await buyer.api("PATCH", `/listings/${listing.json.id}/status`, { action: "PAUSE" });
  check("buyer cannot change the seller's listing", [403, 404].includes(stranger.status), stranger.status);
  await buyer.page.goto(`${BASE}/orders`, { waitUntil: "networkidle" });
  await buyer.page.screenshot({ path: `${SHOTS}/buyer-orders.png` });
  const overflow = await buyer.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("buyer: no horizontal overflow at 390 px", overflow === 0, overflow);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  rl.close();
  await browser.close();
  report.failure = failure;
  report.finishedAt = new Date().toISOString();
  await writeFile(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ failure, passed: report.checks.filter((c) => c.ok).length, checks: report.checks.length }));
  process.exitCode = failure ? 1 : 0;
}
