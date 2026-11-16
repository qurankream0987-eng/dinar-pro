/**
 * DINAR NEXT pre-integration: operator readiness of every integration, the subscription plan
 * preview / checkout contract, and the billing webhook intake. Nothing here reports a provider
 * as connected unless an adapter is actually registered, and nothing simulates a payment.
 */
import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { businessSubscriptions, db, promotionProducts } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import { INTEGRATION_READINESS_MATRIX, providerDeploymentEnvironment } from "../lib/market-capability-registry";
import { describeAIModelReadiness } from "../ai/model-gateway";
import { addModelPrice, aiSpendSummary, listModelPrices, spendRequired } from "../lib/ai-spend";
import { monitoringStatus } from "../lib/monitoring";
import { aiUsagePolicyFor } from "../lib/ai-usage";
import { accessPlanFor, aiPlanFor, assertPlanEligibility, businessPlans } from "../lib/business";
import { getCommercialPolicy } from "../lib/commercial-policy";
import { planChangeKind, planCodeOfProduct } from "../lib/subscription-plans";
import { subscriptionEconomics } from "../lib/subscription-economics";
import { getSubscriptionBillingProvider, planChangePreview, receiveBillingWebhook, subscriptionBillingStatus, tierOfEntitlements } from "../lib/subscription-billing";
import { retentionPolicy } from "../lib/privacy-rights";

const router = Router();
const fail = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });
const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

router.get("/admin/integrations/readiness", requireAuth, requireAdmin, async (req, res) => {
  const market = await marketFor(req);
  const policy = await aiUsagePolicyFor(market);
  const billing = subscriptionBillingStatus();
  res.json({
    deploymentEnvironment: providerDeploymentEnvironment() ?? "UNLABELLED",
    liveProvidersEnabled: process.env.DINAR_LIVE_PROVIDERS_ENABLED === "true",
    families: INTEGRATION_READINESS_MATRIX.map((entry) => ({
      ...entry,
      // Only a registered adapter counts as connected; credentials alone never do.
      connected: entry.family === "SUBSCRIPTION_BILLING" ? billing.connected : entry.family === "MONITORING" ? monitoringStatus().connected : false,
    })),
    ai: describeAIModelReadiness(),
    aiUsagePolicy: { approved: policy.approved, version: (policy as { version?: number }).version ?? null },
    aiSpend: { ...(await aiSpendSummary(policy)), required: spendRequired() },
    billing,
    retention: { approved: retentionPolicy().approved },
  });
});

// ─── AI model prices: entered by an admin from the provider's published price or contract ───

const micros = z.number().int().min(0).max(1_000_000_000_000);
const ModelPriceBody = z
  .object({
    provider: z.string().min(1).max(120),
    model: z.string().min(1).max(120),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    inputPerMillionMicros: micros,
    outputPerMillionMicros: micros,
    cachedInputPerMillionMicros: micros.nullable().optional(),
    cacheWriteInputPerMillionMicros: micros.nullable().optional(),
    cacheWrite12hInputPerMillionMicros: micros.nullable().optional(),
    imageUnitMicros: micros.nullable().optional(),
    audioSecondMicros: micros.nullable().optional(),
    requestMicros: micros.optional(),
    source: z.enum(["PROVIDER_PUBLISHED", "CONTRACT"]),
    // Where the number came from (price page URL or contract clause), so it can be checked.
    sourceReference: z.string().trim().min(5).max(300),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

router.get("/admin/ai/model-prices", requireAuth, requireAdmin, async (_req, res) => {
  res.json({ prices: await listModelPrices() });
});

router.post("/admin/ai/model-prices", requireAuth, requireAdmin, async (req, res) => {
  const body = ModelPriceBody.parse(req.body);
  const created = await addModelPrice(req.actor!.id, { ...body, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date() });
  res.status(201).json(created);
});

router.get("/business/plan-change-preview", requireAuth, async (req, res) => {
  const planId = z.string().min(1).max(80).parse(req.query.planId);
  const market = await marketFor(req);
  const plan = (await businessPlans(market)).find((item) => item.id === planId);
  if (!plan) throw fail(404, "خطة جاسم بزنس غير متاحة في سوقك", "PRODUCT_DISABLED");
  const current = await aiPlanFor(req.actor!.id, market);
  const access = await accessPlanFor(req.actor!.id, market);
  const policy = await aiUsagePolicyFor(market);
  const plans = (await getCommercialPolicy(market.id)).subscriptionPlans;
  res.json({
    plan: { id: plan.id, name: plan.name, planCode: plan.planCode, priceLabel: plan.priceLabel, durationDays: plan.durationDays },
    current: { tier: current.tier, plan: access.plan, periodEnd: current.periodEnd?.toISOString() ?? null },
    change: planChangePreview(current, tierOfEntitlements(plan.businessEntitlements ?? [])),
    ...(plan.planCode ? { planChange: planChangeKind(plans, access.plan, plan.planCode) } : {}),
    allowancesApproved: policy.approved,
    billing: subscriptionBillingStatus(),
  });
});

/**
 * Real checkout preparation. Without a registered billing adapter it refuses with
 * BILLING_PROVIDER_NOT_CONNECTED: no subscription row, no charge, no simulated success.
 */
router.post("/business/subscription-checkout", requireAuth, async (req, res) => {
  const body = z.object({ planId: z.string().min(1).max(80), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), businessId: z.string().uuid().optional() }).strict().parse(req.body);
  const billing = subscriptionBillingStatus();
  if (!billing.connected) throw fail(503, "الدفع الحقيقي للاشتراكات غير موصول بعد؛ لم يُنشأ اشتراك ولم يُخصم شيء.", "BILLING_PROVIDER_NOT_CONNECTED");
  const provider = getSubscriptionBillingProvider();
  const market = await marketFor(req);
  const [plan] = await db.select().from(promotionProducts).where(and(eq(promotionProducts.id, body.planId), eq(promotionProducts.marketId, market.id)));
  if (!plan || plan.productType !== "DINAR_BUSINESS" || !(await businessPlans(market)).some((item) => item.id === plan.id)) throw fail(404, "خطة جاسم بزنس غير متاحة في سوقك", "PRODUCT_DISABLED");
  // Eligibility is the server's: Business needs the actor's own VERIFIED business; payment never verifies.
  const planCode = planCodeOfProduct(plan);
  const businessProfileId = await assertPlanEligibility({ actorId: req.actor!.id, market, planCode, businessId: body.businessId });
  const [prior] = await db.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, req.actor!.id), eq(businessSubscriptions.idempotencyKey, body.idempotencyKey)));
  const [live] = prior ? [] : await db.select({ id: businessSubscriptions.id, status: businessSubscriptions.status, planId: businessSubscriptions.planId }).from(businessSubscriptions).where(and(eq(businessSubscriptions.userId, req.actor!.id), eq(businessSubscriptions.marketId, market.id), inArray(businessSubscriptions.status, ["PENDING", "ACTIVE", "PAST_DUE", "CANCEL_AT_PERIOD_END"])));
  // An unpaid checkout for the same plan is resumed (its Whop checkout is reissued idempotently), so an
  // abandoned payment page never locks the buyer out and never creates a second subscription.
  const resumed = live?.status === "PENDING" && live.planId === plan.id ? live : undefined;
  if (live && !resumed) throw fail(409, "لديك اشتراك جاسم بزنس قائم أو قيد الدفع", "ALREADY_SUBSCRIBED");
  const subscriptionId = prior?.id ?? resumed?.id ?? randomUUID();
  if (!prior && !resumed)
    await db.insert(businessSubscriptions).values({
      id: subscriptionId,
      userId: req.actor!.id,
      marketId: market.id,
      planId: plan.id,
      planNameSnapshot: plan.name,
      priceMinorSnapshot: plan.priceMinor,
      currencyCodeSnapshot: plan.currencyCode,
      periodDaysSnapshot: plan.durationDays,
      pricingVersionSnapshot: plan.pricingVersion,
      entitlementsSnapshot: plan.businessEntitlements ?? [],
      planCodeSnapshot: plan.planCode ?? null,
      businessProfileId,
      status: "PENDING",
      idempotencyKey: body.idempotencyKey,
    });
  const checkout = await provider!.createCheckout({ subscriptionId, planId: plan.id, amountMinor: plan.priceMinor, currencyCode: plan.currencyCode, periodDays: plan.durationDays, idempotencyKey: resumed ? `resume-${resumed.id}` : body.idempotencyKey });
  // PENDING grants nothing: entitlements start only from a verified SUBSCRIPTION_ACTIVATED webhook.
  res.status(201).json({ subscriptionId, status: "PENDING", checkout, autoRenew: false });
});

/** D1.6: what each plan could cost DINAR in AI at full use, from configured prices only. */
router.get("/admin/subscription-plans/economics", requireAuth, requireAdmin, async (req, res) => {
  const marketId = z.string().regex(/^[A-Z]{2,8}$/).optional().parse(typeof req.query.marketId === "string" ? req.query.marketId : undefined);
  res.json(await subscriptionEconomics(marketId ?? ""));
});

router.post("/billing/webhooks/:providerKey", async (req, res) => {
  const providerKey = z.string().regex(/^[a-z0-9-]{2,40}$/).parse(req.params.providerKey);
  res.json(await receiveBillingWebhook(providerKey, req.body));
});

export default router;
