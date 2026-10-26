import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { testOnlyPaymentAdapter } from "../src/lib/payments/test-adapter";
import {
  db,
  markets,
  offers,
  orders,
  paymentDisputeEvents,
  paymentEvents,
  paymentIntents,
  paymentReconciliationItems,
  paymentReconciliationRuns,
  paymentRefunds,
  sellerDues,
  users,
  pool,
} from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

if (process.env.BDINAR_DISPOSABLE_TEST_DATABASE !== "1") {
  throw new Error(
    "Wave 4 acceptance writes append-only records and requires a disposable database",
  );
}
requireSafeReplitDevelopmentDatabase("BDINAR_WAVE4_ACCEPTANCE");

const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const phoneBase = 55_000_000 + ((Date.now() + process.pid * 7) % 990_000);
const password = "Wave4-Acceptance-2026!";
const ipBase = parseInt(runId.slice(0, 2), 16);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No test port");
const base = `http://127.0.0.1:${address.port}/api`;

let ipSequence = 0;

type ApiResult = {
  status: number;
  data: any;
  text: string;
  headers: Headers;
};

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult> {
  ipSequence += 1;
  const ip = `198.18.${(ipBase + Math.floor(ipSequence / 250)) % 250}.${(ipSequence % 250) + 1}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": ip,
      ...extraHeaders,
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: response.status, data, text, headers: response.headers };
}

async function registrationProof(phoneNumber: string) {
  const started = await request(
    "/auth/phone-verification/challenges",
    "POST",
    { phoneCountryCode: "+965", phoneNumber },
  );
  assert.equal(started.status, 202, started.text);
  const verified = await request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    {
      challengeId: started.data.challengeId,
      code: started.data.developmentCode,
    },
  );
  assert.equal(verified.status, 200, verified.text);
  return verified.data.verificationToken as string;
}

function count(label: string) {
  console.log(`WAVE4_PASS ${label}`);
}

function expectCheckConstraint(constraint: string) {
  return (error: unknown) => {
    let current = error as
      | { code?: string; constraint?: string; cause?: unknown }
      | undefined;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (current.code === "23514" && current.constraint === constraint) {
        return true;
      }
      current = current.cause as typeof current;
    }
    return false;
  };
}

function expectAppendOnlyTrigger(
  tableName: "payment_events" | "payment_dispute_events" = "payment_events",
) {
  return (error: unknown) => {
    let current = error as
      | { code?: string; message?: string; cause?: unknown }
      | undefined;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (
        current.code === "P0001" &&
        (current.message ?? "").includes(`${tableName} is append-only`)
      ) {
        return true;
      }
      current = current.cause as typeof current;
    }
    return false;
  };
}

async function probePaymentEventAppendOnly(
  intent: typeof paymentIntents.$inferSelect,
) {
  const client = await pool.connect();
  const eventId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SAVEPOINT before_invalid_insert");
    await assert.rejects(
      client.query(
        `INSERT INTO payment_events
          (id, payment_intent_id, provider_key, provider_event_id, event_type,
           amount_minor, currency_code, payload_sha256, mode)
         VALUES ($1, $2, $3, $4, 'CAPTURE_SUCCEEDED', $5, $6, $7, 'LIVE')`,
        [
          randomUUID(),
          intent.id,
          intent.providerKey,
          `wave4-invalid-${randomUUID()}`,
          intent.amountMinor,
          intent.currencyCode,
          "a".repeat(64),
        ],
      ),
      expectCheckConstraint("payment_events_simulation_only"),
    );
    await client.query("ROLLBACK TO SAVEPOINT before_invalid_insert");

    await client.query(
      `INSERT INTO payment_events
        (id, payment_intent_id, provider_key, provider_event_id, event_type,
         amount_minor, currency_code, payload_sha256, mode)
       VALUES ($1, $2, $3, $4, 'CAPTURE_SUCCEEDED', $5, $6, $7, 'SIMULATION_ONLY')`,
      [
        eventId,
        intent.id,
        intent.providerKey,
        `wave4-append-only-${randomUUID()}`,
        intent.amountMinor,
        intent.currencyCode,
        "b".repeat(64),
      ],
    );

    await client.query("SAVEPOINT before_update");
    await assert.rejects(
      client.query(
        "UPDATE payment_events SET amount_minor = amount_minor + 1 WHERE id = $1",
        [eventId],
      ),
      expectAppendOnlyTrigger(),
    );
    await client.query("ROLLBACK TO SAVEPOINT before_update");

    await client.query("SAVEPOINT before_delete");
    await assert.rejects(
      client.query("DELETE FROM payment_events WHERE id = $1", [eventId]),
      expectAppendOnlyTrigger(),
    );
    await client.query("ROLLBACK TO SAVEPOINT before_delete");

    const auditResult = await client.query<{ id: string }>(
      "SELECT id FROM payment_dispute_events LIMIT 1",
    );
    assert.ok(auditResult.rows[0], "a dispute audit fixture must exist");
    const auditEventId = auditResult.rows[0].id;

    await client.query("SAVEPOINT before_audit_update");
    await assert.rejects(
      client.query(
        "UPDATE payment_dispute_events SET amount_minor = amount_minor + 1 WHERE id = $1",
        [auditEventId],
      ),
      expectAppendOnlyTrigger("payment_dispute_events"),
    );
    await client.query("ROLLBACK TO SAVEPOINT before_audit_update");

    await client.query("SAVEPOINT before_audit_delete");
    await assert.rejects(
      client.query("DELETE FROM payment_dispute_events WHERE id = $1", [
        auditEventId,
      ]),
      expectAppendOnlyTrigger("payment_dispute_events"),
    );
    await client.query("ROLLBACK TO SAVEPOINT before_audit_delete");

    await client.query("SAVEPOINT before_audit_truncate");
    await assert.rejects(
      client.query("TRUNCATE TABLE payment_dispute_events"),
      expectAppendOnlyTrigger("payment_dispute_events"),
    );
    await client.query("ROLLBACK TO SAVEPOINT before_audit_truncate");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

test("Wave 4 payment core remains simulation-only and enforces payment boundaries", async () => {
  let offerId: string | undefined;
  try {
    const [saMarket] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, "SA"));
    assert.ok(saMarket, "development seed must configure the SAR market");
    assert.equal(saMarket.currencyCode, "SAR");

    async function register(role: string, offset: number) {
      const phoneNumber = String(phoneBase + offset);
      const result = await request("/auth/register", "POST", {
        displayName: `DINAR Wave 4 ${role} ${runId}`,
        accountCountry: "KW",
        phoneCountryCode: "+965",
        phoneNumber,
        password,
        confirmPassword: password,
        acceptTerms: true,
        verificationToken: await registrationProof(phoneNumber),
      });
      assert.equal(result.status, 201, result.text);
      const id = result.data.user.id as string;
      assert.ok(result.headers.get("set-cookie"), `${role} must have a session`);
      return {
        id,
        cookie: result.headers.get("set-cookie")!.split(";")[0],
      };
    }

    const seller = await register("seller", 0);
    const buyer = await register("buyer", 1);
    const admin = await register("admin", 2);
    await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));

    for (const actor of [seller, buyer, admin]) {
      const marketResult = await request(
        "/account/market",
        "PATCH",
        { marketId: "SA" },
        actor.cookie,
      );
      assert.equal(marketResult.status, 200, marketResult.text);
    }

    const listing = await request(
      "/listings",
      "POST",
      {
        title: `Wave 4 simulation offer ${runId}`,
        description: "Development-only offer for payment simulation acceptance.",
        category: "أخرى",
        categoryId: "other",
        area: "منطقة الاختبار",
        city: "الرياض",
        attributes: {},
        unitPrice: "100.00",
        inventoryMode: "LIMITED",
        availableQuantity: 5,
        fulfilmentType: "PICKUP",
        imageUrl: "",
      },
      seller.cookie,
    );
    assert.equal(listing.status, 201, listing.text);
    offerId = listing.data.id;

    async function checkout(suffix: string) {
      const result = await request(
        "/checkout",
        "POST",
        {
          idempotencyKey: `wave4-${runId}-${suffix}`,
          items: [{ listingId: offerId, quantity: 1, fulfilmentType: "PICKUP" }],
        },
        buyer.cookie,
      );
      assert.equal(result.status, 201, result.text);
      assert.equal(result.data.orders.length, 1);
      const order = result.data.orders[0];
      assert.equal(order.paymentMode, "TEST_NO_TRANSFER");
      return order as { id: string; subtotalMinor: number; currency: string };
    }

    async function createIntent(orderId: string, suffix: string) {
      const response = await request(
        paymentPath,
        "POST",
        { orderId },
        buyer.cookie,
        { "Idempotency-Key": `wave4-create-${runId}-${suffix}` },
      );
      assert.equal(response.status, 201, response.text);
      const [intent] = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, response.data.id));
      assert.ok(intent);
      return intent;
    }

    async function openDispute(orderId: string) {
      const accepted = await request(
        `/orders/${orderId}/accept`,
        "POST",
        {},
        seller.cookie,
      );
      assert.equal(accepted.status, 200, accepted.text);
      const delivered = await request(
        `/orders/${orderId}/delivery`,
        "POST",
        { proofType: "CODE", proofToken: `wave4-${runId}` },
        seller.cookie,
      );
      assert.equal(delivered.status, 200, delivered.text);
      const opened = await request(
        `/orders/${orderId}/confirm`,
        "POST",
        {
          received: false,
          dispute: {
            reason: "لم أستلم الطلب",
            description: "لم يصل المنتج المتفق عليه",
            evidence: ["مرجع Wave 4"],
          },
        },
        buyer.cookie,
      );
      assert.equal(opened.status, 200, opened.text);
      assert.equal(opened.data.status, "DISPUTED");
      const detail = await request(
        `/orders/${orderId}`,
        "GET",
        undefined,
        buyer.cookie,
      );
      assert.equal(detail.status, 200, detail.text);
      assert.ok(detail.data.dispute?.id);
      return detail.data.dispute as { id: string; status: string };
    }

    const firstOrder = await checkout("refund");
    const paymentPath = "/payments/intents";
    const disabledFeatureFlag = process.env.BDINAR_WAVE4_ACCEPTANCE;
    delete process.env.BDINAR_WAVE4_ACCEPTANCE;
    const disabled = await request(
      paymentPath,
      "POST",
      { orderId: firstOrder.id },
      buyer.cookie,
      { "Idempotency-Key": `wave4-off-${runId}` },
    );
    process.env.BDINAR_WAVE4_ACCEPTANCE = disabledFeatureFlag;
    assert.equal(disabled.status, 404, disabled.text);
    count("simulation routes are unavailable without the explicit acceptance flag");

    const unauthenticated = await request(
      paymentPath,
      "POST",
      { orderId: firstOrder.id },
      "",
      { "Idempotency-Key": `wave4-unauth-${runId}` },
    );
    assert.equal(unauthenticated.status, 401, unauthenticated.text);

    const deniedOwnership = await request(
      paymentPath,
      "POST",
      { orderId: firstOrder.id },
      seller.cookie,
      { "Idempotency-Key": `wave4-owner-${runId}` },
    );
    assert.equal(deniedOwnership.status, 404, deniedOwnership.text);

    const intentKey = `wave4-create-${runId}`;
    const created = await request(
      paymentPath,
      "POST",
      { orderId: firstOrder.id },
      buyer.cookie,
      { "Idempotency-Key": intentKey },
    );
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.amountMinor, firstOrder.subtotalMinor);
    assert.equal(created.data.currencyCode, "SAR");
    assert.equal(created.data.mode, "SIMULATION_ONLY");
    const repeatedIntent = await request(
      paymentPath,
      "POST",
      { orderId: firstOrder.id },
      buyer.cookie,
      { "Idempotency-Key": intentKey },
    );
    assert.equal(repeatedIntent.status, 200, repeatedIntent.text);
    assert.equal(repeatedIntent.data.id, created.data.id);

    const conflictingIntent = await request(
      paymentPath,
      "POST",
      { orderId: firstOrder.id },
      buyer.cookie,
      { "Idempotency-Key": `wave4-other-${runId}` },
    );
    assert.equal(conflictingIntent.status, 409, conflictingIntent.text);
    count("order ownership, server-side price authority, and intent idempotency pass");

    const [firstIntent] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, created.data.id));
    assert.ok(firstIntent);
    const invalidSignature = await request(
      "/payments/webhooks/test",
      "POST",
      {
        id: "sim_event_invalid_signature",
        type: "CAPTURE_SUCCEEDED",
        providerIntentId: firstIntent.providerIntentId,
        amountMinor: firstIntent.amountMinor,
        currencyCode: firstIntent.currencyCode,
      },
      "",
      { "X-Payment-Signature": `sha256=${"0".repeat(64)}` },
    );
    assert.equal(invalidSignature.status, 401, invalidSignature.text);

    const capture = testOnlyPaymentAdapter.createCaptureWebhook(
      firstIntent.providerIntentId,
    );
    const captureResult = await request(
      "/payments/webhooks/test",
      "POST",
      capture.event,
      "",
      { "X-Payment-Signature": capture.signature },
    );
    assert.equal(captureResult.status, 200, captureResult.text);
    assert.equal(captureResult.data.duplicate, false);
    assert.equal(captureResult.data.paymentIntent.status, "SIMULATION_CAPTURED");
    const replayedCapture = await request(
      "/payments/webhooks/test",
      "POST",
      capture.event,
      "",
      { "X-Payment-Signature": capture.signature },
    );
    assert.equal(replayedCapture.status, 200, replayedCapture.text);
    assert.equal(replayedCapture.data.duplicate, true);
    count("signed webhook verification and provider-event replay deduplication pass");

    const refundPath = `/admin/payments/intents/${firstIntent.id}/refunds`;
    const unauthorizedRefund = await request(
      refundPath,
      "POST",
      { amountMinor: 1000 },
      buyer.cookie,
      { "Idempotency-Key": `wave4-user-refund-${runId}` },
    );
    assert.equal(unauthorizedRefund.status, 403, unauthorizedRefund.text);

    const firstRefundKey = `wave4-refund-one-${runId}`;
    const partialRefund = await request(
      refundPath,
      "POST",
      { amountMinor: 4000, reason: "simulation acceptance" },
      admin.cookie,
      { "Idempotency-Key": firstRefundKey },
    );
    assert.equal(partialRefund.status, 201, partialRefund.text);
    assert.equal(partialRefund.data.status, "SIMULATED_COMPLETED");
    assert.equal(partialRefund.data.mode, "SIMULATION_ONLY");
    const repeatedRefund = await request(
      refundPath,
      "POST",
      { amountMinor: 4000, reason: "simulation acceptance" },
      admin.cookie,
      { "Idempotency-Key": firstRefundKey },
    );
    assert.equal(repeatedRefund.status, 200, repeatedRefund.text);
    assert.equal(repeatedRefund.data.id, partialRefund.data.id);

    const conflictingRefund = await request(
      refundPath,
      "POST",
      { amountMinor: 3500, reason: "simulation acceptance" },
      admin.cookie,
      { "Idempotency-Key": firstRefundKey },
    );
    assert.equal(conflictingRefund.status, 409, conflictingRefund.text);
    const excessiveRefund = await request(
      refundPath,
      "POST",
      { amountMinor: 7000 },
      admin.cookie,
      { "Idempotency-Key": `wave4-refund-too-much-${runId}` },
    );
    assert.equal(excessiveRefund.status, 409, excessiveRefund.text);

    const finalRefund = await request(
      refundPath,
      "POST",
      { amountMinor: 6000, reason: "simulation close" },
      admin.cookie,
      { "Idempotency-Key": `wave4-refund-two-${runId}` },
    );
    assert.equal(finalRefund.status, 201, finalRefund.text);
    assert.equal(finalRefund.data.status, "SIMULATED_COMPLETED");
    const [fullyRefunded] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, firstIntent.id));
    assert.equal(fullyRefunded.status, "SIMULATION_REFUNDED");
    assert.equal(fullyRefunded.refundedAmountMinor, 10_000);
    count("refund idempotency, role checks, and captured-balance limits pass");

    const secondOrder = await checkout("reconciliation");
    const secondIntentResponse = await request(
      paymentPath,
      "POST",
      { orderId: secondOrder.id },
      buyer.cookie,
      { "Idempotency-Key": `wave4-create-second-${runId}` },
    );
    assert.equal(secondIntentResponse.status, 201, secondIntentResponse.text);
    const [secondIntent] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, secondIntentResponse.data.id));
    assert.ok(secondIntent);

    const refundBeforeCapture = await request(
      `/admin/payments/intents/${secondIntent.id}/refunds`,
      "POST",
      { amountMinor: 1 },
      admin.cookie,
      { "Idempotency-Key": `wave4-early-refund-${runId}` },
    );
    assert.equal(refundBeforeCapture.status, 409, refundBeforeCapture.text);

    const secondCapture = testOnlyPaymentAdapter.createCaptureWebhook(
      secondIntent.providerIntentId,
    );
    const reconcilePath = "/admin/payments/reconcile";
    const deniedReconciliation = await request(
      reconcilePath,
      "POST",
      {},
      buyer.cookie,
    );
    assert.equal(deniedReconciliation.status, 403, deniedReconciliation.text);
    const mismatch = await request(reconcilePath, "POST", {}, admin.cookie);
    assert.equal(mismatch.status, 200, mismatch.text);
    assert.equal(mismatch.data.mode, "SIMULATION_ONLY");
    assert.equal(mismatch.data.mismatchCount, 1);
    const [stillPending] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, secondIntent.id));
    assert.equal(stillPending.status, "SIMULATION_PENDING");

    const secondCaptureResult = await request(
      "/payments/webhooks/test",
      "POST",
      secondCapture.event,
      "",
      { "X-Payment-Signature": secondCapture.signature },
    );
    assert.equal(secondCaptureResult.status, 200, secondCaptureResult.text);
    const matched = await request(reconcilePath, "POST", {}, admin.cookie);
    assert.equal(matched.status, 200, matched.text);
    assert.equal(matched.data.status, "MATCHED");
    assert.equal(matched.data.mismatchCount, 0);
    assert.equal(matched.data.matchedCount, 2);
    count("reconciliation reports drift without mutating payment state");

    const [unchangedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, firstOrder.id));
    assert.equal(unchangedOrder.status, "CREATED");
    assert.equal(unchangedOrder.data.paymentMode, "TEST_NO_TRANSFER");
    const [unchangedCapturedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, secondOrder.id));
    assert.equal(unchangedCapturedOrder.status, "CREATED");
    assert.equal(unchangedCapturedOrder.data.paymentMode, "TEST_NO_TRANSFER");
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, firstOrder.id))
      ).length,
      0,
      "simulation must not create seller dues or claim settlement",
    );
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, secondOrder.id))
      ).length,
      0,
      "simulated capture must not create seller dues or claim settlement",
    );
    const storedEvents = await db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentIntentId, firstIntent.id));
    assert.equal(storedEvents.length, 3);
    count("simulation leaves order accounting and seller settlement untouched");

    const buyerDisputeOrder = await checkout("buyer-dispute");
    const buyerDisputeIntent = await createIntent(
      buyerDisputeOrder.id,
      "buyer-dispute",
    );
    const buyerDispute = await openDispute(buyerDisputeOrder.id);
    let buyerAudit = await db
      .select()
      .from(paymentDisputeEvents)
      .where(eq(paymentDisputeEvents.paymentIntentId, buyerDisputeIntent.id));
    const buyerOpenedAudit = buyerAudit.find(
      (row) => row.eventType === "DISPUTE_OPENED",
    );
    assert.ok(buyerOpenedAudit);
    assert.equal(buyerOpenedAudit.disputeId, buyerDispute.id);
    assert.equal(buyerOpenedAudit.financialOutcome, "HOLD_PENDING");
    assert.equal(buyerOpenedAudit.amountMinor, 0);
    assert.equal(buyerOpenedAudit.commissionRateBps, 1_000);
    let [buyerIntentWhileDisputed] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, buyerDisputeIntent.id));
    assert.equal(buyerIntentWhileDisputed.status, "SIMULATION_DISPUTED");
    assert.equal(buyerIntentWhileDisputed.disputeId, buyerDispute.id);

    const buyerCapture = testOnlyPaymentAdapter.createCaptureWebhook(
      buyerDisputeIntent.providerIntentId,
    );
    const buyerCaptureResult = await request(
      "/payments/webhooks/test",
      "POST",
      buyerCapture.event,
      "",
      { "X-Payment-Signature": buyerCapture.signature },
    );
    assert.equal(buyerCaptureResult.status, 200, buyerCaptureResult.text);
    assert.equal(
      buyerCaptureResult.data.paymentIntent.status,
      "SIMULATION_DISPUTED",
    );
    const replayedBuyerCapture = await request(
      "/payments/webhooks/test",
      "POST",
      buyerCapture.event,
      "",
      { "X-Payment-Signature": buyerCapture.signature },
    );
    assert.equal(replayedBuyerCapture.data.duplicate, true);
    buyerAudit = await db
      .select()
      .from(paymentDisputeEvents)
      .where(eq(paymentDisputeEvents.paymentIntentId, buyerDisputeIntent.id));
    const buyerCaptureAudit = buyerAudit.find(
      (row) => row.eventType === "PAYMENT_CAPTURED",
    );
    assert.ok(buyerCaptureAudit);
    assert.equal(buyerCaptureAudit.financialOutcome, "HOLD_CAPTURED");
    assert.equal(buyerCaptureAudit.amountMinor, buyerDisputeIntent.amountMinor);
    assert.equal(
      buyerAudit.filter((row) => row.eventType === "PAYMENT_CAPTURED").length,
      1,
    );

    const activeDisputeMatch = await request(
      reconcilePath,
      "POST",
      {},
      admin.cookie,
    );
    assert.equal(activeDisputeMatch.status, 200, activeDisputeMatch.text);
    assert.equal(activeDisputeMatch.data.status, "MATCHED");
    assert.equal(activeDisputeMatch.data.matchedCount, 3);
    await db
      .update(paymentIntents)
      .set({ status: "SIMULATION_CAPTURED" })
      .where(eq(paymentIntents.id, buyerDisputeIntent.id));
    const disputeDrift = await request(
      reconcilePath,
      "POST",
      {},
      admin.cookie,
    );
    assert.equal(disputeDrift.status, 200, disputeDrift.text);
    assert.equal(disputeDrift.data.status, "MISMATCHED");
    assert.equal(disputeDrift.data.mismatchCount, 1);
    [buyerIntentWhileDisputed] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, buyerDisputeIntent.id));
    assert.equal(
      buyerIntentWhileDisputed.status,
      "SIMULATION_CAPTURED",
      "reconciliation must report drift without rewriting payment authority",
    );
    await db
      .update(paymentIntents)
      .set({ status: "SIMULATION_DISPUTED" })
      .where(eq(paymentIntents.id, buyerDisputeIntent.id));

    const buyerResolution = await request(
      `/admin/disputes/${buyerDisputeOrder.id}/resolve`,
      "POST",
      { resolution: "BUYER", note: "buyer outcome simulation" },
      admin.cookie,
    );
    assert.equal(buyerResolution.status, 200, buyerResolution.text);
    assert.equal(buyerResolution.data.resolution, "BUYER");
    assert.equal(buyerResolution.data.commissionRateBps, 1_000);
    const [buyerIntentResolved] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, buyerDisputeIntent.id));
    assert.equal(buyerIntentResolved.status, "SIMULATION_BUYER_REFUND_DUE");
    buyerAudit = await db
      .select()
      .from(paymentDisputeEvents)
      .where(eq(paymentDisputeEvents.paymentIntentId, buyerDisputeIntent.id));
    const buyerResolutionAudit = buyerAudit.find(
      (row) => row.eventType === "DISPUTE_RESOLVED",
    );
    assert.ok(buyerResolutionAudit);
    assert.equal(
      buyerResolutionAudit.financialOutcome,
      "BUYER_REFUND_DUE",
    );
    assert.equal(
      buyerResolutionAudit.amountMinor,
      buyerDisputeIntent.amountMinor,
    );
    const buyerRefundAttempt = await request(
      `/admin/payments/intents/${buyerDisputeIntent.id}/refunds`,
      "POST",
      { amountMinor: 1000, reason: "provider integration deferred" },
      admin.cookie,
      { "Idempotency-Key": `wave4-dispute-refund-${runId}` },
    );
    assert.equal(buyerRefundAttempt.status, 409, buyerRefundAttempt.text);
    const buyerResolutionReconcile = await request(
      reconcilePath,
      "POST",
      {},
      admin.cookie,
    );
    assert.equal(buyerResolutionReconcile.data.status, "MATCHED");
    assert.equal(buyerResolutionReconcile.data.matchedCount, 3);
    count("buyer disputes hold capture and record a non-settled refund due");

    const sellerDisputeOrder = await checkout("seller-dispute");
    const sellerDisputeIntent = await createIntent(
      sellerDisputeOrder.id,
      "seller-dispute",
    );
    const sellerCapture = testOnlyPaymentAdapter.createCaptureWebhook(
      sellerDisputeIntent.providerIntentId,
    );
    const sellerCaptureResult = await request(
      "/payments/webhooks/test",
      "POST",
      sellerCapture.event,
      "",
      { "X-Payment-Signature": sellerCapture.signature },
    );
    assert.equal(sellerCaptureResult.status, 200, sellerCaptureResult.text);

    const [legacyOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, sellerDisputeOrder.id));
    const legacyOrderData = { ...legacyOrder.data };
    delete legacyOrderData.commissionRateBps;
    await db
      .update(orders)
      .set({ data: legacyOrderData })
      .where(eq(orders.id, sellerDisputeOrder.id));

    const sellerDispute = await openDispute(sellerDisputeOrder.id);
    const [sellerOpenedAudit] = await db
      .select()
      .from(paymentDisputeEvents)
      .where(eq(paymentDisputeEvents.paymentIntentId, sellerDisputeIntent.id));
    const [sellerCaptureEvent] = await db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentIntentId, sellerDisputeIntent.id));
    assert.equal(sellerOpenedAudit.disputeId, sellerDispute.id);
    assert.equal(sellerOpenedAudit.eventType, "DISPUTE_OPENED");
    assert.equal(sellerOpenedAudit.financialOutcome, "HOLD_CAPTURED");
    assert.equal(sellerCaptureEvent.eventType, "CAPTURE_SUCCEEDED");
    assert.equal(sellerOpenedAudit.sourcePaymentEventId, sellerCaptureEvent.id);
    assert.equal(sellerOpenedAudit.commissionRateBps, 1_000);
    assert.equal(sellerOpenedAudit.platformFeeMinor, legacyOrder.platformFeeMinor);
    assert.equal(sellerOpenedAudit.sellerAmountMinor, legacyOrder.sellerAmountMinor);

    const unauthorizedResolution = await request(
      `/admin/disputes/${sellerDisputeOrder.id}/resolve`,
      "POST",
      { resolution: "SELLER" },
      buyer.cookie,
    );
    assert.equal(unauthorizedResolution.status, 403);
    const sellerResolution = await request(
      `/admin/disputes/${sellerDisputeOrder.id}/resolve`,
      "POST",
      {
        resolution: "SELLER",
        financialOutcome: "BUYER_REFUND_DUE",
        amountMinor: 0,
      },
      admin.cookie,
    );
    assert.equal(sellerResolution.status, 200, sellerResolution.text);
    assert.equal(sellerResolution.data.resolution, "SELLER");
    assert.equal(sellerResolution.data.commissionRateBps, 1_000);
    assert.equal(sellerResolution.data.sellerDueCreated, true);
    const [sellerIntentResolved] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, sellerDisputeIntent.id));
    assert.equal(sellerIntentResolved.status, "SIMULATION_SELLER_RELEASE_DUE");
    const sellerAudit = await db
      .select()
      .from(paymentDisputeEvents)
      .where(eq(paymentDisputeEvents.paymentIntentId, sellerDisputeIntent.id));
    const sellerResolutionAudit = sellerAudit.find(
      (row) => row.eventType === "DISPUTE_RESOLVED",
    );
    assert.ok(sellerResolutionAudit);
    assert.equal(
      sellerResolutionAudit.financialOutcome,
      "SELLER_RELEASE_DUE",
    );
    assert.equal(
      sellerResolutionAudit.amountMinor,
      legacyOrder.sellerAmountMinor,
    );
    const [sellerOrderResolved] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, sellerDisputeOrder.id));
    assert.equal(sellerOrderResolved.data.paymentMode, "TEST_NO_TRANSFER");
    const repeatedResolution = await request(
      `/admin/disputes/${sellerDisputeOrder.id}/resolve`,
      "POST",
      { resolution: "SELLER" },
      admin.cookie,
    );
    assert.equal(repeatedResolution.status, 409);
    const allDisputesReconciled = await request(
      reconcilePath,
      "POST",
      {},
      admin.cookie,
    );
    assert.equal(allDisputesReconciled.data.status, "MATCHED");
    assert.equal(allDisputesReconciled.data.matchedCount, 4);
    count("seller dispute resolution uses saved order amounts and no-transfer mode");

    await assert.rejects(
      db
        .update(paymentIntents)
        .set({ mode: "LIVE" })
        .where(eq(paymentIntents.id, firstIntent.id)),
      expectCheckConstraint("payment_intents_simulation_only"),
    );
    await assert.rejects(
      db
        .update(paymentIntents)
        .set({
          refundedAmountMinor: fullyRefunded.capturedAmountMinor + 1,
        })
        .where(eq(paymentIntents.id, firstIntent.id)),
      expectCheckConstraint("payment_intents_capture_refund_bounds"),
    );
    await assert.rejects(
      db
        .update(paymentEvents)
        .set({ amountMinor: storedEvents[0].amountMinor + 1 })
        .where(eq(paymentEvents.id, storedEvents[0].id)),
      expectAppendOnlyTrigger(),
    );
    await assert.rejects(
      db.delete(paymentEvents).where(eq(paymentEvents.id, storedEvents[0].id)),
      expectAppendOnlyTrigger(),
    );
    await probePaymentEventAppendOnly(secondIntent);
    count(
      "payment and dispute histories allow inserts and reject updates, deletes, and truncates",
    );
    const [storedRefund] = await db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentIntentId, firstIntent.id))
      .limit(1);
    const [storedRun] = await db
      .select()
      .from(paymentReconciliationRuns)
      .where(eq(paymentReconciliationRuns.id, matched.data.id));
    const [storedReconciliationItem] = await db
      .select()
      .from(paymentReconciliationItems)
      .where(eq(paymentReconciliationItems.runId, matched.data.id))
      .limit(1);
    assert.ok(storedRefund);
    assert.ok(storedRun);
    assert.ok(storedReconciliationItem);
    await assert.rejects(
      db
        .update(paymentRefunds)
        .set({ mode: "LIVE" })
        .where(eq(paymentRefunds.id, storedRefund.id)),
      expectCheckConstraint("payment_refunds_simulation_only"),
    );
    await assert.rejects(
      db
        .update(paymentReconciliationRuns)
        .set({ mode: "LIVE" })
        .where(eq(paymentReconciliationRuns.id, storedRun.id)),
      expectCheckConstraint("payment_reconciliation_runs_simulation_only"),
    );
    await assert.rejects(
      db
        .update(paymentReconciliationItems)
        .set({ mode: "LIVE" })
        .where(eq(paymentReconciliationItems.id, storedReconciliationItem.id)),
      expectCheckConstraint("payment_reconciliation_items_simulation_only"),
    );
    count("payment tables enforce simulation-only mode and captured-refund bounds");
    console.log(
      `WAVE4_ACCEPTANCE_PASS ${JSON.stringify({ checks: 10, mode: "SIMULATION_ONLY", provider: "TEST_ADAPTER" })}`,
    );
  } finally {
    console.log("WAVE4_FIXTURES_RETAINED_FOR_DISPOSABLE_DATABASE_TEARDOWN");
  }
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
});