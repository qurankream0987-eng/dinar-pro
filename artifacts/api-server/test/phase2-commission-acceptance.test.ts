import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { and, desc, eq, inArray, lte, or } from "drizzle-orm";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import app from "../src/app";
import {
  checkoutRequests,
  conversations,
  db,
  disputes,
  marketAudit,
  markets,
  messages,
  offers,
  orderItems,
  orders,
  policyAcceptances,
  pool,
  phoneVerificationChallenges,
  sellerDues,
  sellerMarketEligibility,
  sessions,
  users,
} from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_PHASE2_ACCEPTANCE");
const execFileAsync = promisify(execFile);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api`;
let authRequestSequence = 0;
const verificationChallengeIds: string[] = [];

type ApiResponse = {
  status: number;
  data: any;
  cookie: string;
  raw: string;
};

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = "",
): Promise<ApiResponse> {
  const authRateLimitedPath = [
    "/auth/register",
    "/auth/login",
    "/auth/phone-verification/challenges",
    "/auth/phone-verification/challenges/verify",
    "/account/password",
  ].includes(path);
  const authIp = authRateLimitedPath
    ? `198.18.${Math.floor(authRequestSequence / 250) % 250}.${(authRequestSequence++ % 250) + 1}`
    : undefined;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(["POST", "PATCH", "PUT", "DELETE"].includes(method)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Cookie: token } : {}),
      ...(authIp ? { "X-Forwarded-For": authIp } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

async function registrationProof(phoneNumber: string) {
  const started = await request(
    "/auth/phone-verification/challenges",
    "POST",
    { phoneCountryCode: "+965", phoneNumber },
  );
  assert.equal(started.status, 202, started.raw);
  verificationChallengeIds.push(started.data.challengeId);
  const verified = await request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    {
      challengeId: started.data.challengeId,
      code: started.data.developmentCode,
    },
  );
  assert.equal(verified.status, 200, verified.raw);
  assert.equal(verified.cookie, "");
  return verified.data.verificationToken as string;
}

async function resolveDisputeThroughAdminUi(
  webBase: string,
  adminCookie: string,
  orderId: string,
  resolution: "BUYER" | "SELLER",
  note: string,
  runId: string,
) {
  const resultPath = `/tmp/dinar-phase2-admin-${runId}-${orderId}.json`;
  let childError: unknown;
  try {
    await execFileAsync(
      process.execPath,
      [`${process.cwd()}/../dinar/test/admin-disputes-ui-acceptance.mjs`],
      {
        env: {
          ...process.env,
          PHASE2_WEB_BASE: webBase,
          PHASE2_API_ORIGIN: new URL(base).origin,
          PHASE2_ADMIN_COOKIE: adminCookie,
          PHASE2_ORDER_ID: orderId,
          PHASE2_RESOLUTION: resolution,
          PHASE2_NOTE: note,
          PHASE2_UI_RESULT_PATH: resultPath,
        },
      },
    );
  } catch (error) {
    childError = error;
  }

  let browserResult: any;
  try {
    browserResult = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    // Preserve the browser process error if no result was produced.
  } finally {
    await unlink(resultPath).catch(() => undefined);
  }
  if (childError) throw childError;
  assert.ok(browserResult, "admin browser acceptance must write its result");
  assert.equal(browserResult.failure, undefined);
  assert.deepEqual(browserResult.pageErrors, []);
  assert.equal(browserResult.result?.status, 200);
  return browserResult.result.data;
}

await test("Phase 2 snapshots the current 10% commission through checkout and order outcomes", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const createdUserIds: string[] = [];
  let offerId: string | undefined;
  let sellerId: string | undefined;
  let buyerId: string | undefined;
  let sellerCookie = "";
  let buyerCookie = "";
  let browserTestWeb:
    | Awaited<ReturnType<typeof startDinarBrowserTestWeb>>
    | undefined;

  try {
    const [saMarket] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, "SA"));
    assert.ok(saMarket, "the development SAR market must be configured");
    assert.equal(saMarket.currencyCode, "SAR");
    assert.equal(saMarket.minorUnitScale, 2);
    assert.equal(saMarket.isActive, true);
    assert.ok(["ACTIVE", "LIMITED"].includes(saMarket.status));
    assert.ok(saMarket.paymentMethods.includes("CASH_DIRECT"));

    const [legacyBefore] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, "dev_order_complete"));
    assert.ok(
      legacyBefore,
      "the development seed must contain its pre-existing completed legacy order",
    );
    const [legacyDueBefore] = await db
      .select()
      .from(sellerDues)
      .where(eq(sellerDues.orderId, legacyBefore.id));
    assert.ok(legacyDueBefore, "the legacy completed order must retain its due");
    assert.equal(legacyBefore.status, "COMPLETED");
    assert.equal(legacyBefore.data.commissionRateBps ?? 1_000, 1_000);
    assert.equal(legacyBefore.subtotalMinor, 1_000);
    assert.equal(legacyBefore.platformFeeMinor, 100);
    assert.equal(legacyBefore.sellerAmountMinor, 900);
    assert.equal(legacyDueBefore.amountMinor, 100);

    const phoneBase =
      50_000_000 + ((Date.now() + process.pid) % 899_000);
    const password = "Phase2-Acceptance-2026!";
    const register = async (
      role: "Seller" | "Buyer" | "Admin",
      phoneOffset: number,
    ) => {
      const result = await request("/auth/register", "POST", {
        displayName: `DINAR Phase 2 ${role} ${runId.slice(0, 8)}`,
        accountCountry: "KW",
        phoneCountryCode: "+965",
        phoneNumber: String(phoneBase + phoneOffset),
        password,
        confirmPassword: password,
        acceptTerms: true,
        verificationToken: await registrationProof(String(phoneBase + phoneOffset)),
      });
      assert.equal(result.status, 201, result.raw);
      const id = result.data.user.id as string;
      createdUserIds.push(id);
      assert.ok(result.cookie, `${role} registration must establish a session`);
      return { id, cookie: result.cookie };
    };

    const seller = await register("Seller", 0);
    sellerId = seller.id;
    sellerCookie = seller.cookie;
    const buyer = await register("Buyer", 1);
    buyerId = buyer.id;
    buyerCookie = buyer.cookie;
    const admin = await register("Admin", 2);
    await db
      .update(users)
      .set({ role: "ADMIN" })
      .where(eq(users.id, admin.id));

    for (const token of [sellerCookie, buyerCookie, admin.cookie]) {
      const switched = await request(
        "/account/market",
        "PATCH",
        { marketId: "SA" },
        token,
      );
      assert.equal(switched.status, 200, switched.raw);
    }

    const createdOffer = await request(
      "/listings",
      "POST",
      {
        title: `Phase 2 commission proof ${runId.slice(0, 8)}`,
        description:
          "Development-only offer for persisted transaction acceptance.",
        category: "أخرى",
        categoryId: "other",
        area: "منطقة الاختبار",
        city: "الرياض",
        attributes: {},
        unitPrice: "100.00",
        inventoryMode: "LIMITED",
        availableQuantity: 4,
        fulfilmentType: "PICKUP",
        imageUrl: "",
      },
      sellerCookie,
    );
    assert.equal(createdOffer.status, 201, createdOffer.raw);
    offerId = createdOffer.data.id;
    const [persistedOffer] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, offerId));
    assert.ok(persistedOffer, "the published transaction offer must persist");
    assert.equal(persistedOffer.marketId, "SA");
    assert.equal(persistedOffer.unitPriceMinor, 10_000);

    const checkout = async (suffix: string) => {
      const result = await request(
        "/checkout",
        "POST",
        {
          idempotencyKey: `phase2-${runId}-${suffix}`,
          items: [
            {
              listingId: offerId,
              quantity: 1,
              fulfilmentType: "PICKUP",
            },
          ],
        },
        buyerCookie,
      );
      assert.equal(result.status, 201, result.raw);
      assert.equal(result.data.orders.length, 1);
      return result.data.orders[0];
    };

    const completedOrder = await checkout("completed");
    const completedOrderId = completedOrder.id as string;
    assert.equal(completedOrder.status, "CREATED");
    assert.equal(completedOrder.total, "100.00");
    assert.equal(completedOrder.currency, "SAR");
    assert.equal(completedOrder.subtotalMinor, 10_000);
    assert.equal(completedOrder.platformFeeMinor, 1_000);
    assert.equal(completedOrder.sellerAmountMinor, 9_000);
    assert.equal(completedOrder.commissionRateBps, 1_000);
    assert.equal(completedOrder.paymentMode, "TEST_NO_TRANSFER");

    const [newOrderAtCheckout] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, completedOrderId));
    assert.ok(newOrderAtCheckout, "checkout must persist the new order");
    assert.equal(newOrderAtCheckout.status, "CREATED");
    assert.equal(newOrderAtCheckout.data.commissionRateBps, 1_000);
    assert.equal(newOrderAtCheckout.data.paymentMode, "TEST_NO_TRANSFER");
    assert.equal(newOrderAtCheckout.subtotalMinor, 10_000);
    assert.equal(newOrderAtCheckout.platformFeeMinor, 1_000);
    assert.equal(newOrderAtCheckout.sellerAmountMinor, 9_000);
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, completedOrderId))
      ).length,
      0,
      "checkout must not create a completed-sale due",
    );

    const accepted = await request(
      `/orders/${completedOrderId}/accept`,
      "POST",
      {},
      sellerCookie,
    );
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal(accepted.data.status, "ACCEPTED");
    const delivered = await request(
      `/orders/${completedOrderId}/delivery`,
      "POST",
      { proofType: "CODE", proofToken: `PHASE2-${runId.slice(0, 12)}` },
      sellerCookie,
    );
    assert.equal(delivered.status, 200, delivered.raw);
    assert.equal(delivered.data.status, "SELLER_MARKED_DELIVERED");
    const confirmed = await request(
      `/orders/${completedOrderId}/confirm`,
      "POST",
      { received: true, issue: null },
      buyerCookie,
    );
    assert.equal(confirmed.status, 200, confirmed.raw);
    assert.equal(confirmed.data.status, "COMPLETED");

    const persistedOrderResponse = await request(
      `/orders/${completedOrderId}`,
      "GET",
      undefined,
      buyerCookie,
    );
    assert.equal(persistedOrderResponse.status, 200, persistedOrderResponse.raw);
    assert.equal(persistedOrderResponse.data.status, "COMPLETED");
    assert.equal(persistedOrderResponse.data.commissionRateBps, 1_000);
    assert.equal(persistedOrderResponse.data.platformFeeMinor, 1_000);
    assert.equal(persistedOrderResponse.data.sellerAmountMinor, 9_000);

    const repeatedConfirmation = await request(
      `/orders/${completedOrderId}/confirm`,
      "POST",
      { received: true, issue: null },
      buyerCookie,
    );
    assert.equal(repeatedConfirmation.status, 200, repeatedConfirmation.raw);
    assert.equal(repeatedConfirmation.data.status, "COMPLETED");
    const retriedCheckout = await request(
      "/checkout",
      "POST",
      {
        idempotencyKey: `phase2-${runId}-completed`,
        items: [
          {
            listingId: offerId,
            quantity: 1,
            fulfilmentType: "PICKUP",
          },
        ],
      },
      buyerCookie,
    );
    assert.equal(retriedCheckout.status, 201, retriedCheckout.raw);
    assert.equal(retriedCheckout.data.orders.length, 1);
    assert.equal(retriedCheckout.data.orders[0].id, completedOrderId);
    assert.equal(retriedCheckout.data.orders[0].status, "COMPLETED");

    const [completedDue] = await db
      .select()
      .from(sellerDues)
      .where(eq(sellerDues.orderId, completedOrderId));
    assert.ok(completedDue, "completion must create the seller due");
    assert.equal(completedDue.amountMinor, 1_000);
    assert.equal(completedDue.currencyCode, "SAR");
    assert.equal(completedDue.status, "PENDING");
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, completedOrderId))
      ).length,
      1,
      "completion retries must leave exactly one due",
    );
    const sellerDueResponse = await request(
      "/seller-dues",
      "GET",
      undefined,
      sellerCookie,
    );
    assert.equal(sellerDueResponse.status, 200, sellerDueResponse.raw);
    const apiDue = sellerDueResponse.data.find(
      (due: any) => due.orderId === completedOrderId,
    );
    assert.ok(apiDue);
    assert.equal(apiDue.amount, "10.00");
    assert.match(apiDue.reason, /10%/);
    assert.match(apiDue.reason, /لا يتوفر سداد إلكتروني/);

    const cancelledOrder = await checkout("cancelled");
    const cancelledOrderId = cancelledOrder.id as string;
    const cancelled = await request(
      `/orders/${cancelledOrderId}/cancel`,
      "POST",
      { reason: "لم أعد بحاجة إلى الطلب" },
      buyerCookie,
    );
    assert.equal(cancelled.status, 200, cancelled.raw);
    assert.equal(cancelled.data.status, "CANCELLED");
    const cancelledDues = await db
      .select()
      .from(sellerDues)
      .where(eq(sellerDues.orderId, cancelledOrderId));
    assert.equal(cancelledDues.length, 0);

    const disputedOrder = await checkout("disputed");
    const disputedOrderId = disputedOrder.id as string;
    const disputedAccepted = await request(
      `/orders/${disputedOrderId}/accept`,
      "POST",
      {},
      sellerCookie,
    );
    assert.equal(disputedAccepted.status, 200, disputedAccepted.raw);
    const disputedDelivery = await request(
      `/orders/${disputedOrderId}/delivery`,
      "POST",
      { proofType: "CODE", proofToken: `DISPUTE-${runId.slice(0, 12)}` },
      sellerCookie,
    );
    assert.equal(disputedDelivery.status, 200, disputedDelivery.raw);
    const dispute = await request(
      `/orders/${disputedOrderId}/confirm`,
      "POST",
      {
        received: false,
        dispute: {
          reason: "لم أستلم الطلب",
          description: "لم يصل الطلب كما تم الاتفاق عليه.",
          evidence: ["تأكيد اختبار التطوير"],
        },
      },
      buyerCookie,
    );
    assert.equal(dispute.status, 200, dispute.raw);
    assert.equal(dispute.data.status, "DISPUTED");
    const persistedDispute = await db
      .select()
      .from(disputes)
      .where(eq(disputes.orderId, disputedOrderId));
    assert.equal(persistedDispute.length, 1);
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, disputedOrderId))
      ).length,
      0,
      "an unresolved dispute must not create the completed-sale due",
    );

    const unauthenticatedResolution = await request(
      `/admin/disputes/${disputedOrderId}/resolve`,
      "POST",
      { resolution: "SELLER" },
    );
    assert.equal(unauthenticatedResolution.status, 401);
    const sellerResolutionAttempt = await request(
      `/admin/disputes/${disputedOrderId}/resolve`,
      "POST",
      { resolution: "SELLER" },
      sellerCookie,
    );
    assert.equal(sellerResolutionAttempt.status, 403);
    const buyerResolutionAttempt = await request(
      `/admin/disputes/${disputedOrderId}/resolve`,
      "POST",
      { resolution: "SELLER" },
      buyerCookie,
    );
    assert.equal(buyerResolutionAttempt.status, 403);

    const nonDisputedResolution = await request(
      `/admin/disputes/${completedOrderId}/resolve`,
      "POST",
      { resolution: "SELLER" },
      admin.cookie,
    );
    assert.equal(nonDisputedResolution.status, 409);
    const adminDisputesBeforeResolution = await request(
      "/admin/disputes",
      "GET",
      undefined,
      admin.cookie,
    );
    assert.equal(adminDisputesBeforeResolution.status, 200);
    const adminDisputeBeforeResolution = adminDisputesBeforeResolution.data.find(
      (entry: any) => entry.orderId === disputedOrderId,
    );
    assert.equal(adminDisputeBeforeResolution?.status, "OPEN");
    assert.equal(adminDisputeBeforeResolution?.orderStatus, "DISPUTED");
    assert.equal(adminDisputeBeforeResolution?.commissionRateBps, 1_000);

    browserTestWeb ??= await startDinarBrowserTestWeb();
    const sellerResolutionData = await resolveDisputeThroughAdminUi(
      browserTestWeb.baseUrl,
      admin.cookie,
      disputedOrderId,
      "SELLER",
      "اعتماد نتيجة الاختبار لصالح البائع",
      runId,
    );
    const sellerResolution: ApiResponse = {
      status: 200,
      data: sellerResolutionData,
      cookie: "",
      raw: JSON.stringify(sellerResolutionData),
    };
    assert.equal(sellerResolution.status, 200, sellerResolution.raw);
    assert.equal(sellerResolution.data.disputeStatus, "RESOLVED");
    assert.equal(sellerResolution.data.orderStatus, "COMPLETED");
    assert.equal(sellerResolution.data.resolution, "SELLER");
    assert.equal(sellerResolution.data.resolvedBy, admin.id);
    assert.equal(sellerResolution.data.commissionRateBps, 1_000);
    assert.equal(sellerResolution.data.platformFeeMinor, 1_000);
    assert.equal(sellerResolution.data.sellerAmountMinor, 9_000);
    assert.equal(sellerResolution.data.sellerDueCreated, true);

    const sellerResolvedOrder = await request(
      `/orders/${disputedOrderId}`,
      "GET",
      undefined,
      buyerCookie,
    );
    assert.equal(sellerResolvedOrder.status, 200, sellerResolvedOrder.raw);
    assert.equal(sellerResolvedOrder.data.status, "COMPLETED");
    assert.equal(sellerResolvedOrder.data.commissionRateBps, 1_000);
    assert.equal(sellerResolvedOrder.data.platformFeeMinor, 1_000);
    assert.equal(sellerResolvedOrder.data.sellerAmountMinor, 9_000);
    assert.equal(sellerResolvedOrder.data.dispute.status, "RESOLVED");
    assert.equal(sellerResolvedOrder.data.dispute.resolution, "SELLER");
    assert.ok(sellerResolvedOrder.data.dispute.resolvedAt);
    const sellerResolutionAudit = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, disputedOrderId),
          eq(messages.contentType, "DISPUTE_RESOLUTION"),
        ),
      );
    assert.equal(sellerResolutionAudit.length, 1);
    assert.equal(sellerResolutionAudit[0].senderId, admin.id);
    assert.equal(sellerResolutionAudit[0].actor, "ADMIN");
    assert.equal(
      sellerResolutionAudit[0].metadata.resolutionNote,
      "اعتماد نتيجة الاختبار لصالح البائع",
    );

    const repeatedDifferentResolution = await request(
      `/admin/disputes/${disputedOrderId}/resolve`,
      "POST",
      { resolution: "BUYER", note: "يجب ألا يستبدل القرار النهائي" },
      admin.cookie,
    );
    assert.equal(repeatedDifferentResolution.status, 409);
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, disputedOrderId))
      ).length,
      1,
      "a repeated resolution must not create another due",
    );
    assert.equal(
      (
        await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, disputedOrderId),
              eq(messages.contentType, "DISPUTE_RESOLUTION"),
            ),
          )
      ).length,
      1,
      "a repeated resolution must not duplicate the audit event",
    );

    const buyerOutcomeOrder = await checkout("buyer-sided-dispute");
    const buyerOutcomeOrderId = buyerOutcomeOrder.id as string;
    const buyerOutcomeAccepted = await request(
      `/orders/${buyerOutcomeOrderId}/accept`,
      "POST",
      {},
      sellerCookie,
    );
    assert.equal(buyerOutcomeAccepted.status, 200, buyerOutcomeAccepted.raw);
    const buyerOutcomeDelivered = await request(
      `/orders/${buyerOutcomeOrderId}/delivery`,
      "POST",
      { proofType: "CODE", proofToken: `BUYER-DISPUTE-${runId.slice(0, 8)}` },
      sellerCookie,
    );
    assert.equal(buyerOutcomeDelivered.status, 200, buyerOutcomeDelivered.raw);
    const buyerOutcomeDispute = await request(
      `/orders/${buyerOutcomeOrderId}/confirm`,
      "POST",
      {
        received: false,
        dispute: {
          reason: "لم أستلم الطلب",
          description: "لم يصل الطلب كما تم الاتفاق عليه.",
          evidence: ["دليل اختبار حسم المشتري"],
        },
      },
      buyerCookie,
    );
    assert.equal(buyerOutcomeDispute.status, 200, buyerOutcomeDispute.raw);
    assert.equal(buyerOutcomeDispute.data.status, "DISPUTED");
    const buyerResolutionData = await resolveDisputeThroughAdminUi(
      browserTestWeb!.baseUrl,
      admin.cookie,
      buyerOutcomeOrderId,
      "BUYER",
      "اعتماد نتيجة الاختبار لصالح المشتري",
      runId,
    );
    const buyerResolution: ApiResponse = {
      status: 200,
      data: buyerResolutionData,
      cookie: "",
      raw: JSON.stringify(buyerResolutionData),
    };
    assert.equal(buyerResolution.status, 200, buyerResolution.raw);
    assert.equal(buyerResolution.data.disputeStatus, "RESOLVED");
    assert.equal(buyerResolution.data.orderStatus, "CANCELLED");
    assert.equal(buyerResolution.data.resolution, "BUYER");
    assert.equal(buyerResolution.data.sellerDueCreated, false);
    const buyerResolvedOrder = await request(
      `/orders/${buyerOutcomeOrderId}`,
      "GET",
      undefined,
      buyerCookie,
    );
    assert.equal(buyerResolvedOrder.status, 200, buyerResolvedOrder.raw);
    assert.equal(buyerResolvedOrder.data.status, "CANCELLED");
    assert.equal(buyerResolvedOrder.data.dispute.status, "RESOLVED");
    assert.equal(buyerResolvedOrder.data.dispute.resolution, "BUYER");
    assert.ok(buyerResolvedOrder.data.dispute.resolvedAt);
    assert.equal(
      (
        await db
          .select()
          .from(sellerDues)
          .where(eq(sellerDues.orderId, buyerOutcomeOrderId))
      ).length,
      0,
      "buyer-sided resolution must not create a completed-sale due",
    );
    const adminDisputesAfterResolution = await request(
      "/admin/disputes",
      "GET",
      undefined,
      admin.cookie,
    );
    assert.equal(adminDisputesAfterResolution.status, 200);
    const resolvedAdminDispute = adminDisputesAfterResolution.data.find(
      (entry: any) => entry.orderId === disputedOrderId,
    );
    assert.equal(resolvedAdminDispute?.status, "RESOLVED");
    assert.equal(resolvedAdminDispute?.orderStatus, "COMPLETED");
    assert.equal(resolvedAdminDispute?.resolvedBy, admin.id);
    assert.equal(
      resolvedAdminDispute?.resolutionNote,
      "اعتماد نتيجة الاختبار لصالح البائع",
    );

    const [completedOrderAfterRetry] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, completedOrderId));
    const [legacyAfter] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, legacyBefore.id));
    const [legacyDueAfter] = await db
      .select()
      .from(sellerDues)
      .where(eq(sellerDues.orderId, legacyBefore.id));
    assert.equal(completedOrderAfterRetry?.status, "COMPLETED");
    assert.equal(completedOrderAfterRetry?.data.commissionRateBps, 1_000);
    assert.equal(legacyAfter?.data.commissionRateBps, legacyBefore.data.commissionRateBps);
    assert.equal(legacyAfter?.subtotalMinor, legacyBefore.subtotalMinor);
    assert.equal(legacyAfter?.platformFeeMinor, legacyBefore.platformFeeMinor);
    assert.equal(legacyAfter?.sellerAmountMinor, legacyBefore.sellerAmountMinor);
    assert.equal(legacyDueAfter?.id, legacyDueBefore.id);
    assert.equal(legacyDueAfter?.amountMinor, legacyDueBefore.amountMinor);
    assert.equal(legacyDueAfter?.status, legacyDueBefore.status);

    const [offerAfterOutcomes] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, offerId));
    assert.equal(offerAfterOutcomes?.availableQuantity, 2);
    assert.equal(offerAfterOutcomes?.reservedQuantity, 0);
    console.log(
      "PHASE2 persisted development transaction acceptance:",
      JSON.stringify({
        currency: "SAR",
        gross: "100.00",
        commission: "10.00",
        sellerEntitlement: "90.00",
        commissionRateBps: completedOrderAfterRetry?.data.commissionRateBps,
        completedOrderId,
        completedOrderStatus: completedOrderAfterRetry?.status,
        completedSellerDueMinor: completedDue.amountMinor,
        completedSellerDueRows: 1,
        cancelledOrderStatus: cancelled.data.status,
        cancelledSellerDueRows: cancelledDues.length,
        disputedOrderStatus: dispute.data.status,
        disputedSellerDueRows: 0,
        sellerResolvedOrderStatus: sellerResolution.data.orderStatus,
        sellerResolvedDueMinor: sellerResolution.data.platformFeeMinor,
        buyerResolvedOrderStatus: buyerResolution.data.orderStatus,
        legacyFallbackBps: legacyBefore.data.commissionRateBps ?? 1_000,
        legacyFeeMinor: legacyAfter?.platformFeeMinor,
        paymentMode: "TEST_NO_TRANSFER",
      }),
    );
  } finally {
    await browserTestWeb?.stop();
    if (verificationChallengeIds.length)
      await db
        .delete(phoneVerificationChallenges)
        .where(
          inArray(
            phoneVerificationChallenges.id,
            verificationChallengeIds,
          ),
        );
    // The disposable suite drops its whole database after completion. Keep append-only
    // delivery history and its referenced test records intact until that drop.
    const dropDatabaseAfterTest =
      process.env.BDINAR_DISPOSABLE_TEST_DATABASE === "1" &&
      process.env.BDINAR_DISPOSABLE_ACCEPTANCE_DB === "1";
    if (createdUserIds.length && !dropDatabaseAfterTest) {
      const ownedOrders = await db
        .select({ id: orders.id })
        .from(orders)
        .where(
          or(
            inArray(orders.buyerId, createdUserIds),
            inArray(orders.sellerId, createdUserIds),
          ),
        );
      const orderIds = ownedOrders.map((row) => row.id);
      if (orderIds.length) {
        await db.delete(disputes).where(inArray(disputes.orderId, orderIds));
        await db
          .delete(sellerDues)
          .where(inArray(sellerDues.orderId, orderIds));
        await db
          .delete(messages)
          .where(inArray(messages.conversationId, orderIds));
        await db
          .delete(conversations)
          .where(inArray(conversations.orderId, orderIds));
        await db
          .delete(orderItems)
          .where(inArray(orderItems.orderId, orderIds));
        await db.delete(orders).where(inArray(orders.id, orderIds));
      }
      await db
        .delete(checkoutRequests)
        .where(inArray(checkoutRequests.userId, createdUserIds));
      const ownedOffers = await db
        .select({ id: offers.id })
        .from(offers)
        .where(inArray(offers.sellerId, createdUserIds));
      const ownedOfferIds = ownedOffers.map((row) => row.id);
      if (ownedOfferIds.length)
        await db.delete(offers).where(inArray(offers.id, ownedOfferIds));
      await db
        .delete(marketAudit)
        .where(inArray(marketAudit.actorId, createdUserIds));
      await db
        .delete(sellerMarketEligibility)
        .where(inArray(sellerMarketEligibility.userId, createdUserIds));
      await db
        .delete(policyAcceptances)
        .where(inArray(policyAcceptances.userId, createdUserIds));
      await db
        .delete(sessions)
        .where(inArray(sessions.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
      const remainingUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, createdUserIds));
      assert.equal(remainingUsers.length, 0, "Phase 2 test users must be removed");
    }
    if (offerId && !sellerId && !dropDatabaseAfterTest)
      await db.delete(offers).where(eq(offers.id, offerId));
  }
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
});