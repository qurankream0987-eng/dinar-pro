/**
 * Wave 03 D9 — seller campaign lifecycle is auditable and serving follows the transition.
 *
 * The canonical promotion tables and routes already own eligibility, budget, expiry, cancellation
 * and disclosure. The missing piece was a durable actor record for seller-initiated PAUSE, RESUME
 * and CANCEL. This suite uses one captured simulated campaign, drives the real seller route, and
 * asserts both the audit trail (once per real change, never for a no-op) and the read-time serving
 * decision. It creates no order, payment, ledger entry or real advertisement spend.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  listingPromotions,
  marketAudit,
  pool,
  promotionProducts,
} from "@workspace/db";
import app from "../src/app";
import { servingCampaignsFor } from "../src/lib/promotions";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE03_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);
const password = "wave03-campaign-password-1";

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
  const number = `79${((Date.now() + 519733 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
  const created = await request("/auth/register", "POST", {
    displayName: name,
    phoneCountryCode: "+962",
    phoneNumber: number,
    accountCountry: "JO",
    password,
    confirmPassword: password,
    acceptTerms: true,
  });
  assert.equal(created.status, 201, created.text);
  const cookie = created.cookie;
  return { id: created.data.user.id as string, cookie };
}

async function publish(cookie: string, title: string) {
  const created = await request(
    "/listings",
    "POST",
    {
      title,
      description: `${title} — وصف لاختبار تدقيق الحملة ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "خلدا",
      city: "عمان",
      attributes: {},
      unitPrice: "9",
      inventoryMode: "LIMITED",
      availableQuantity: 5,
      fulfilmentType: "PICKUP",
      pricingMode: "FIXED",
      imageUrl: "",
      imageUrls: [],
    },
    cookie,
  );
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

const seller = await register(`بائع الحملة ${runId}`);
const otherSeller = await register(`بائع آخر ${runId}`);
const listingId = await publish(seller.cookie, `منتج الحملة ${runId}`);
const [plan] = await db
  .insert(promotionProducts)
  .values({
    id: randomUUID(),
    marketId: "JO",
    categoryId: "other",
    name: `Wave03 D9 ${runId}`,
    priceMinor: 1_000,
    currencyCode: "JOD",
    durationDays: 7,
    enabled: false,
  })
  .returning();
const promotionId = randomUUID();
await db.insert(listingPromotions).values({
  id: promotionId,
  listingId,
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

async function act(cookie: string, action: string) {
  return request(`/promotions/${promotionId}/actions`, "POST", { action }, cookie);
}

async function auditTrail() {
  return db
    .select()
    .from(marketAudit)
    .where(
      and(
        eq(marketAudit.marketId, "JO"),
        eq(marketAudit.actorId, seller.id),
      ),
    )
    .orderBy(asc(marketAudit.createdAt));
}

await test("D9 seller campaign lifecycle writes one audit row per real change and serving follows it", async () => {
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 1, "the captured campaign serves");

  const paused = await act(seller.cookie, "PAUSE");
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.data.status, "PAUSED");
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 0, "a paused campaign never boosts");
  assert.equal((await act(seller.cookie, "PAUSE")).status, 200);
  let trail = await auditTrail();
  assert.deepEqual(trail.map((row) => row.action), ["PROMOTION_PAUSE"], "a repeated pause writes no second row");

  const denied = await act(otherSeller.cookie, "RESUME");
  assert.equal(denied.status, 404, "another seller cannot change the campaign");
  assert.equal((await auditTrail()).length, 1, "a denied attempt writes no audit row");

  const resumed = await act(seller.cookie, "RESUME");
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.data.status, "ACTIVE");
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 1, "a resumed campaign serves again");

  const cancelled = await act(seller.cookie, "CANCEL");
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.data.status, "CANCELLED");
  assert.ok(cancelled.data.endedAt, "cancellation records its end");
  assert.equal((await servingCampaignsFor("JO", [listingId])).length, 0, "a cancelled campaign never serves");
  assert.equal((await act(seller.cookie, "CANCEL")).status, 200);

  trail = await auditTrail();
  assert.deepEqual(
    trail.map((row) => row.action),
    ["PROMOTION_PAUSE", "PROMOTION_RESUME", "PROMOTION_CANCEL"],
    "no-op repeats and denied attempts leave no rows",
  );
  for (const row of trail) {
    assert.equal((row.data as any).promotionId, promotionId);
    assert.equal((row.data as any).listingId, listingId);
    assert.ok((row.data as any).from);
    assert.ok((row.data as any).to);
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
