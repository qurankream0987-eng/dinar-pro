/**
 * Wave 03 D7 — the canonical conversation cart action, proved in a real browser.
 *
 * Fixtures: a seller with three photographed fixed-price listings, one already-captured
 * simulated campaign for the sponsored disclosure, and a buyer session. The browser journey
 * (`artifacts/dinar/test/wave03-d7-cart-ui.mjs`) adds each listing through the conversation card,
 * once with motion, once under reduced motion, once after a forced failure and once by keyboard.
 * It writes a JSON report with the flight, pending, disclosure, RTL and reload observations.
 *
 * This suite then re-reads the cart and the stored receipts from the API and repeats the same
 * canonical request: a retry must return the one stored receipt, never a second cart unit, and a
 * failed request must change neither. No model call is reachable.
 */
import "./local-object-storage";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  db,
  listingPromotions,
  messages,
  pool,
  promotionProducts,
} from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE03_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);
const password = "wave03-cart-password-1";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WQAAAABJRU5ErkJggg==",
  "base64",
);

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json", origin } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 741113 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
  const created = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      displayName: name,
      phoneCountryCode: "+962",
      phoneNumber: number,
      accountCountry: "JO",
      password,
      confirmPassword: password,
      acceptTerms: true,
    }),
  });
  const text = await created.text();
  assert.equal(created.status, 201, text);
  const data = JSON.parse(text);
  return {
    id: data.user.id as string,
    cookie: created.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!,
    phone: number,
  };
}

async function listingPhoto(cookie: string) {
  const ticket = await request(
    "/account/listing-photos/upload-url",
    "POST",
    { size: image.length, contentType: "image/png" },
    cookie,
  );
  assert.equal(ticket.status, 200, ticket.text);
  const uploaded = await fetch(ticket.data.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: image,
  });
  assert.equal(uploaded.status, 200);
  const completed = await request(
    "/account/listing-photos/complete",
    "POST",
    { objectPath: ticket.data.objectPath },
    cookie,
  );
  assert.equal(completed.status, 200, completed.text);
  return completed.data.objectPath as string;
}

async function publish(sellerCookie: string, title: string, price: string) {
  const imageUrl = await listingPhoto(sellerCookie);
  const created = await request(
    "/listings",
    "POST",
    {
      title,
      description: `${title} — وصف لاختبار سلة المحادثة ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "خلدا",
      city: "عمان",
      attributes: {},
      unitPrice: price,
      inventoryMode: "LIMITED",
      availableQuantity: 5,
      fulfilmentType: "PICKUP",
      pricingMode: "FIXED",
      imageUrl,
      imageUrls: [],
    },
    sellerCookie,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.imageUrl, imageUrl);
  return created.data.id as string;
}

async function cartQuantity(listingId: string, cookie: string) {
  const cart = await request("/cart", "GET", undefined, cookie);
  assert.equal(cart.status, 200, cart.text);
  return (cart.data as any[]).find((item) => item.listingId === listingId)?.quantity ?? 0;
}

function conversationCartReceipts(view: any) {
  const found: any[] = [];
  for (const message of view?.messages ?? [])
    for (const block of message.blocks ?? [])
      if (block?.payload?.surface === "CART") found.push({ message, block });
  return found;
}

const seller = await register(`بائع السلة ${runId}`);
const buyer = await register(`مشتري السلة ${runId}`);
const titles = {
  normal: `لوحة سلة الوصول ${runId}`,
  reduced: `حقيبة سلة الوصول ${runId}`,
  desktop: `ساعة سلة الوصول ${runId}`,
};
const listings = [
  { id: await publish(seller.cookie, titles.normal, "9"), title: titles.normal },
  { id: await publish(seller.cookie, titles.reduced, "7"), title: titles.reduced },
  { id: await publish(seller.cookie, titles.desktop, "6"), title: titles.desktop },
];

// A captured simulated campaign on the first listing only: the browser must disclose it.
const [plan] = await db
  .insert(promotionProducts)
  .values({
    id: randomUUID(),
    marketId: "JO",
    categoryId: "other",
    name: `Wave03 D7 ${runId}`,
    priceMinor: 1_000,
    currencyCode: "JOD",
    durationDays: 7,
    enabled: false,
  })
  .returning();
await db.insert(listingPromotions).values({
  id: randomUUID(),
  listingId: listings[0]!.id,
  sellerId: seller.id,
  marketId: "JO",
  productId: plan!.id,
  productNameSnapshot: plan!.name,
  categoryIdSnapshot: "other",
  priceMinorSnapshot: 1_000,
  currencyCodeSnapshot: "JOD",
  placementSnapshot: "SEARCH_AND_CHAT",
  durationDaysSnapshot: 7,
  status: "ACTIVE",
  paymentStatus: "SIMULATION_CAPTURED",
  startsAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 86_400_000),
});

await test("D7 conversation cart: confirmed flight, truthful failure, reduced motion, keyboard and reload", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const health = await fetch(`${origin}/api/healthz`);
  assert.equal(health.status, 200);
  const csp = health.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  assert.match(health.headers.get("permissions-policy") ?? "", /microphone=\(self\)/);
  assert.equal(health.headers.get("strict-transport-security"), null, "HSTS stays production-only");
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = join(tmpdir(), `dinar-wave03-d7-${runId}.json`);
  let browserError: unknown;
  try {
    await execFileAsync(
      process.execPath,
      [`${process.cwd()}/../dinar/test/wave03-d7-cart-ui.mjs`],
      {
        cwd: `${process.cwd()}/../dinar`,
        env: {
          ...process.env,
          WAVE03_WEB_BASE: web.baseUrl,
          WAVE03_API_ORIGIN: origin,
          WAVE03_BUYER_ID: buyer.id,
          WAVE03_BUYER_COOKIE: buyer.cookie,
          WAVE03_BUYER_PHONE: buyer.phone,
          WAVE03_PASSWORD: password,
          WAVE03_LISTINGS: JSON.stringify(listings),
          WAVE03_RESULT_PATH: resultPath,
        },
        timeout: 900_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }

  let report: any;
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("WAVE03_D7", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the cart journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.ok(report.checks.length >= 4, `expected the four cart passes, got ${report.checks.length}`);
  assert.equal(report.observations.normal.sponsoredDisclosure, "إعلان ممول");
  assert.match(report.observations.normal.imageSrc, /\/api\/storage\/objects\/listing-photos\//);
  assert.equal(report.observations.normal.busyObserved, true);
  assert.equal(report.observations.normal.flightStarted, true);
  assert.equal(report.observations.normal.flightRemoved, true);
  assert.equal(report.observations.reduced.skippedReason, "reduced-motion");
  assert.equal(report.observations.reduced.cartQuantity, 1, "reduced motion still commits the cart once");
  assert.equal(report.observations.desktop.flightCount, 0, "a failed add never animates");
  assert.ok(report.observations.desktop.failureAlert.length > 0, "the failure is visible to the user");
  assert.equal(report.observations.desktop.keyboardFlight, true);
  assert.equal(report.observations.desktop.badgeAfterReload, "3");
  assert.equal(report.observations.desktop.cartQuantityAfterReload, 1);

  for (const listing of listings)
    assert.equal(await cartQuantity(listing.id, buyer.cookie), 1, `${listing.title} is present exactly once`);

  const conversations = report.observations.conversations;
  for (const [pass, listing] of [
    ["normal", listings[0]!],
    ["reduced", listings[1]!],
    ["desktop", listings[2]!],
  ] as const) {
    const view = await request(`/ai/conversations/${conversations[pass].conversationId}`, "GET", undefined, buyer.cookie);
    assert.equal(view.status, 200, view.text);
    const receipts = conversationCartReceipts(view.data);
    assert.equal(receipts.length, 1, `${pass}: one stored receipt for ${listing.title}`);
    assert.equal(receipts[0]!.block.payload.surface, "CART");
  }

  // A retry of the same canonical card request returns the stored receipt and never adds again.
  const normalId = conversations.normal.conversationId as string;
  const normalSet = conversations.normal.resultSetId as string;
  const first = await request(
    `/ai/conversations/${normalId}/actions/add-to-cart`,
    "POST",
    { resultSetId: normalSet, resourceId: listings[0]!.id },
    buyer.cookie,
  );
  assert.equal(first.status, 200, first.text);
  const second = await request(
    `/ai/conversations/${normalId}/actions/add-to-cart`,
    "POST",
    { resultSetId: normalSet, resourceId: listings[0]!.id },
    buyer.cookie,
  );
  assert.equal(second.status, 200, second.text);
  assert.equal(first.data.assistantMessage.id, second.data.assistantMessage.id, "the receipt is stored once");
  assert.equal(await cartQuantity(listings[0]!.id, buyer.cookie), 1, "retries never add a second unit");
  const stored = await db.select().from(messages).where(eq(messages.conversationId, normalId));
  assert.equal(
    stored.filter((row) => Boolean((row.metadata as any)?.cardAddKey)).length,
    1,
    "the card key is written once",
  );

  // A stale/unknown result set is rejected and changes nothing.
  const desktopId = conversations.desktop.conversationId as string;
  const rejected = await request(
    `/ai/conversations/${desktopId}/actions/add-to-cart`,
    "POST",
    { resultSetId: randomUUID(), resourceId: listings[2]!.id },
    buyer.cookie,
  );
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(await cartQuantity(listings[2]!.id, buyer.cookie), 1, "a rejected request leaves the cart untouched");
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "the cart action never reaches the model");

  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const production = await fetch(`${origin}/api/healthz`);
    assert.equal(
      production.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
