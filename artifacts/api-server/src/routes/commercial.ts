/**
 * Monetization V3 HTTP surface. Every owner comes from the session, every market from the
 * actor's active market, every price and charge from server policy; request bodies are
 * strict, so client-sent prices, balances, owners, «paid» flags or VIP flags are rejected.
 */
import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  commercialPolicies,
  db,
  demandSignals,
  listingPromotions,
  marketAudit,
  markets,
  promotionAttributions,
  promotionProducts,
  users,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { marketFor, resolveMarket } from "../lib/markets";
import {
  commercialEconomics,
  commercialHistory,
  createTopupIntent,
  getCommercialBalance,
  grantPromotionalCredit,
  receiveTopupWebhook,
  refundEntryToCredit,
  simulateTopupCapture,
  topupAmountMinor,
} from "../lib/commercial-ledger";
import {
  CommercialPolicySchema,
  DEFAULT_COMMERCIAL_POLICY,
  getCommercialPolicy,
  majorToMinor,
  PulseWindow,
} from "../lib/commercial-policy";
import {
  assertPromotionsAvailable,
  campaignAnalytics,
  commercialProductView,
  commercialProducts,
  expireStalePromotions,
  listEntitlements,
  purchaseCommercialProduct,
  reviewCommercialPurchase,
} from "../lib/promotions";
import { canConfigurePromotionCatalog } from "../lib/promotion-policy";
import { recordTokenEvent } from "../lib/promotion-attribution";
import { insightView, marketPulse } from "../lib/market-pulse";
import {
  businessEntitlements,
  businessPlans,
  cancelBusinessSubscription,
  getBusinessStatus,
  reviewBusinessSubscription,
  subscribeBusiness,
} from "../lib/business";
import { PaymentWebhookEventSchema } from "../lib/payments/contracts";
import { applyCommerceAction } from "../ai/commerce-turn";
import { BUSINESS_ENTITLEMENT_KEYS, PLAN_CODES, validateCatalogProductForPlan } from "../lib/subscription-plans";
import { subscriptionPlansOverview } from "../lib/subscription-overview";
import { resolveMarketplaceCategory } from "../lib/marketplace-categories";

const router = Router();
const fail = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
/** A deliberate, user-safe refusal whose message and code reach the client (D1 plan rules). */
const refuse = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });
const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const requireCommercialAdmin: RequestHandler = (req, res, next) => {
  if (!canConfigurePromotionCatalog(req.actor?.role)) {
    res.status(403).json({ error: "تحتاج إلى صلاحية إدارة الخدمات التجارية" });
    return;
  }
  next();
};

async function marketById(id: string) {
  const [row] = await db.select().from(markets).where(eq(markets.id, id)).limit(1);
  if (!row) throw fail(404, "السوق غير موجود");
  return resolveMarket(row);
}

// ─── Seller: balance, top-up, catalog, purchases ─────────────────────────────

router.get("/commercial/balance", requireAuth, async (req, res) => {
  assertPromotionsAvailable();
  const market = await marketFor(req);
  await expireStalePromotions({ sellerId: req.actor!.id });
  res.json({ balance: await getCommercialBalance(req.actor!.id, market), history: await commercialHistory(req.actor!.id, market, 20), entitlements: await listEntitlements(req.actor!.id, market) });
});

const TopupBody = z.object({ amountMajor: z.number().positive().max(1_000_000), idempotencyKey: key }).strict();
router.post("/commercial/topups", requireAuth, async (req, res) => {
  assertPromotionsAvailable();
  const body = TopupBody.parse(req.body);
  const market = await marketFor(req);
  const amountMinor = await topupAmountMinor(market, body.amountMajor);
  res.status(201).json(await createTopupIntent({ userId: req.actor!.id, market, amountMinor, idempotencyKey: body.idempotencyKey }));
});

/** Development/test stand-in for the provider checkout; only the verified webhook credits. */
router.post("/commercial/topups/:id/simulate-capture", requireAuth, async (req, res) => {
  assertPromotionsAvailable();
  z.object({}).strict().parse(req.body ?? {});
  const market = await marketFor(req);
  res.json(await simulateTopupCapture({ userId: req.actor!.id, market, topupId: String(req.params.id) }));
});

/** Provider webhook: signature, amount, currency and provider status must all verify. */
router.post("/commercial/payment-webhooks", async (req, res) => {
  const body = z.object({ event: PaymentWebhookEventSchema, signature: z.string().min(16).max(512) }).strict().parse(req.body);
  res.json(await receiveTopupWebhook(body.event, body.signature));
});

router.get("/commercial/products", requireAuth, async (req, res) => {
  assertPromotionsAvailable();
  const market = await marketFor(req);
  res.json((await commercialProducts(market)).map((product) => commercialProductView(product, market)));
});

const PurchaseBody = z
  .object({
    productId: z.string().min(1).max(80),
    listingId: z.string().min(1).max(80).optional(),
    budgetMajor: z.number().positive().max(1_000_000).optional(),
    paymentSource: z.enum(["COMMERCIAL_BALANCE", "BUNDLE_ENTITLEMENT"]).optional(),
  })
  .strict();
router.post("/commercial/purchase-review", requireAuth, async (req, res) => {
  const body = PurchaseBody.parse(req.body);
  const market = await marketFor(req);
  res.json(
    await reviewCommercialPurchase({
      actorId: req.actor!.id,
      market,
      productId: body.productId,
      listingId: body.listingId,
      budgetMinor: body.budgetMajor === undefined ? undefined : majorToMinor(body.budgetMajor, market.minorUnitScale),
      paymentSource: body.paymentSource,
    }),
  );
});
router.post("/commercial/purchases", requireAuth, async (req, res) => {
  const body = PurchaseBody.extend({ idempotencyKey: key }).strict().parse(req.body);
  const market = await marketFor(req);
  const outcome = await purchaseCommercialProduct({
    actorId: req.actor!.id,
    market,
    productId: body.productId,
    listingId: body.listingId,
    budgetMinor: body.budgetMajor === undefined ? undefined : majorToMinor(body.budgetMajor, market.minorUnitScale),
    paymentSource: body.paymentSource,
    idempotencyKey: body.idempotencyKey,
  });
  res.status(outcome.created ? 201 : 200).json(outcome);
});

router.get("/commercial/entitlements", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  res.json(await listEntitlements(req.actor!.id, market));
});

router.get("/commercial/campaigns/analytics", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  const id = typeof req.query.promotionId === "string" ? req.query.promotionId : undefined;
  // Only the owner's own campaigns are ever read; a foreign id simply yields nothing.
  res.json(await campaignAnalytics(req.actor!.id, market, id ? [id] : undefined));
});

/** Delivery or click of a paid card, accepted only with its opaque signed token. */
router.post("/commercial/attribution", requireAuth, async (req, res) => {
  const body = z.object({ token: z.string().min(20).max(1024), event: z.enum(["IMPRESSION", "DETAIL_OPENED"]) }).strict().parse(req.body);
  const market = await marketFor(req);
  res.json(await recordTokenEvent({ token: body.token, event: body.event, viewerUserId: req.actor!.id, market }));
});

// ─── Market Pulse ────────────────────────────────────────────────────────────

router.get("/market-pulse", requireAuth, async (req, res) => {
  assertPromotionsAvailable();
  const market = await marketFor(req);
  const query = z
    .object({
      window: PulseWindow.default("7d"),
      mode: z.enum(["TOP", "UNMET", "OPPORTUNITIES"]).default("TOP"),
      city: z.string().max(60).optional(),
      categoryId: z.string().max(80).optional(),
      budgetMajor: z.coerce.number().positive().max(1_000_000).optional(),
    })
    .strict()
    .parse(req.query);
  const policy = await getCommercialPolicy(market.id);
  const business = (await businessEntitlements(req.actor!.id, market)).has("MARKET_PULSE_ADVANCED");
  if (!(business ? policy.businessPulseWindows : policy.freePulseWindows).includes(query.window))
    throw fail(402, "هذه الفترة من مزايا دينار بزنس", "SUBSCRIPTION_REQUIRED");
  const result = await marketPulse({
    market,
    window: query.window,
    mode: query.mode,
    limit: business ? policy.businessPulseInsightLimit : policy.freePulseInsightLimit,
    ...(query.city ? { city: query.city } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.budgetMajor ? { budgetMinor: majorToMinor(query.budgetMajor, market.minorUnitScale) } : {}),
  });
  res.json({ ...result, tier: business ? "BUSINESS" : "FREE", clusters: undefined, insights: result.clusters.map((cluster) => insightView(cluster, market)) });
});

// ─── DINAR Business ──────────────────────────────────────────────────────────

router.get("/business/plans", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  res.json(await businessPlans(market));
});
/** D1: the Go / Pro / Business comparison for this account and market (prices from the server). */
router.get("/subscriptions/plans", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  res.json(await subscriptionPlansOverview(req.actor!.id, market));
});
router.get("/business/subscription", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  res.json(await getBusinessStatus(req.actor!.id, market));
});
router.post("/business/subscription-review", requireAuth, async (req, res) => {
  const body = z.object({ planId: z.string().min(1).max(80), businessId: z.string().uuid().optional() }).strict().parse(req.body);
  const market = await marketFor(req);
  res.json(await reviewBusinessSubscription({ actorId: req.actor!.id, market, planId: body.planId, businessId: body.businessId }));
});
router.post("/business/subscriptions", requireAuth, async (req, res) => {
  const body = z.object({ planId: z.string().min(1).max(80), idempotencyKey: key, businessId: z.string().uuid().optional() }).strict().parse(req.body);
  const market = await marketFor(req);
  res.status(201).json(await subscribeBusiness({ actorId: req.actor!.id, market, planId: body.planId, idempotencyKey: body.idempotencyKey, businessId: body.businessId }));
});
router.post("/business/subscription/cancel", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const market = await marketFor(req);
  res.json(await cancelBusinessSubscription({ actorId: req.actor!.id, market }));
});

/** The card button: the same authority as a conversational «تأكيد». */
router.post("/ai/commerce-actions/:id/action", requireAuth, async (req, res) => {
  const body = z.object({ action: z.enum(["CONFIRM", "CANCEL"]) }).strict().parse(req.body);
  const market = await marketFor(req);
  const outcome = await applyCommerceAction({ actionId: String(req.params.id), actorId: req.actor!.id, market, decision: body.action });
  res.json({ status: outcome.status, message: outcome.message, ...(outcome.promotionId ? { promotionId: outcome.promotionId } : {}) });
});

// ─── Admin ───────────────────────────────────────────────────────────────────

const ProductBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    productType: z.enum(["FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING", "SPONSORED_SEARCH", "SPONSORED_RECOMMENDATION", "DEMAND_CAPTURE", "PROMOTION_BUNDLE", "DINAR_BUSINESS", "EXTRA_LISTING_QUOTA", "SPONSORED_SURFACE"]),
    categoryId: z.string().min(1).max(80).optional(),
    priceMinor: z.number().int().positive().max(1_000_000_000),
    durationDays: z.number().int().min(1).max(365),
    chargingMode: z.enum(["FIXED", "PREPAID_BUDGET", "SUBSCRIPTION"]).default("FIXED"),
    maxBudgetMinor: z.number().int().positive().max(1_000_000_000).optional(),
    unitChargeMinor: z.number().int().positive().max(1_000_000_000).optional(),
    priorityWeight: z.number().int().min(1).max(1000).default(100),
    refundPolicy: z.enum(["NON_REFUNDABLE_ON_ACTIVATION", "RELEASE_UNUSED_BUDGET", "UNUSED_UNITS_TO_CREDIT", "NO_REFUND"]).default("NON_REFUNDABLE_ON_ACTIVATION"),
    bundleItems: z.array(z.object({ productType: z.enum(["FEATURED_LISTING", "VIP_LISTING", "REFRESH_LISTING"]), units: z.number().int().min(1).max(1000), durationDays: z.number().int().min(1).max(365), priorityWeight: z.number().int().min(1).max(1000).optional() }).strict()).max(10).default([]),
    entitlementExpiryDays: z.number().int().min(1).max(3650).optional(),
    businessEntitlements: z.array(z.enum(BUSINESS_ENTITLEMENT_KEYS)).max(10).default([]),
    /** D1: the public plan a DINAR_BUSINESS product sells. */
    planCode: z.enum(PLAN_CODES).optional(),
    pricingVersion: z.number().int().min(1).default(1),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
const PLACEMENT_FOR: Record<string, string> = {
  FEATURED_LISTING: "FEATURED",
  VIP_LISTING: "VIP",
  REFRESH_LISTING: "REFRESH",
  SPONSORED_SEARCH: "SPONSORED_SEARCH",
  SPONSORED_RECOMMENDATION: "SPONSORED_RECOMMENDATION",
  DEMAND_CAPTURE: "DEMAND",
};

router.get("/admin/markets/:marketId/commercial-products", requireAuth, requireCommercialAdmin, async (req, res) => {
  const market = await marketById(String(req.params.marketId));
  const rows = await db.select().from(promotionProducts).where(eq(promotionProducts.marketId, market.id)).orderBy(asc(promotionProducts.createdAt));
  res.json(rows.map((row) => ({ ...commercialProductView(row, market), enabled: row.enabled, effectiveFrom: row.effectiveFrom?.toISOString() ?? null, effectiveTo: row.effectiveTo?.toISOString() ?? null })));
});

router.post("/admin/markets/:marketId/commercial-products", requireAuth, requireCommercialAdmin, async (req, res) => {
  const body = ProductBody.parse(req.body);
  const market = await marketById(String(req.params.marketId));
  const placement = PLACEMENT_FOR[body.productType] ?? "NONE";
  if (placement !== "NONE") {
    if (!body.categoryId) throw fail(400, "منتجات الإعلانات تحتاج إلى تصنيف");
    if (!(await resolveMarketplaceCategory(body.categoryId, undefined))) throw fail(404, "التصنيف غير موجود");
  } else if (body.categoryId) throw fail(400, "هذا المنتج لا يرتبط بتصنيف");
  if (body.productType === "PROMOTION_BUNDLE" && !body.bundleItems.length) throw fail(400, "حدّد محتوى الباقة");
  if (body.planCode && body.productType !== "DINAR_BUSINESS") throw refuse(400, "رمز الخطة يخص منتجات دينار بزنس فقط", "PLAN_CODE_INVALID");
  if (body.productType === "DINAR_BUSINESS") {
    const invalid = validateCatalogProductForPlan((await getCommercialPolicy(market.id)).subscriptionPlans, body.planCode ?? null, body.businessEntitlements);
    if (invalid) throw refuse(400, invalid, "PLAN_ENTITLEMENTS_INVALID");
  } else if (body.businessEntitlements.length) throw refuse(400, "المزايا التجارية تخص منتجات دينار بزنس فقط", "PLAN_ENTITLEMENTS_INVALID");
  if ((body.productType === "EXTRA_LISTING_QUOTA" || body.productType === "SPONSORED_SURFACE") && body.enabled)
    throw fail(409, "هذا المنتج مُعدّ ولم يُفعّل بعد (لا يوجد حد للإعلانات في دينار حاليًا)", "PREPARED_NOT_ENABLED");
  try {
    const [row] = await db
      .insert(promotionProducts)
      .values({
        id: randomUUID(),
        marketId: market.id,
        categoryId: placement === "NONE" ? null : body.categoryId!,
        name: body.name,
        placement,
        productType: body.productType,
        chargingMode: body.chargingMode,
        pricingVersion: body.pricingVersion,
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
        effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
        maxBudgetMinor: body.maxBudgetMinor ?? null,
        unitChargeMinor: body.unitChargeMinor ?? null,
        priorityWeight: body.priorityWeight,
        refundPolicy: body.refundPolicy,
        bundleItems: body.bundleItems,
        entitlementExpiryDays: body.entitlementExpiryDays ?? null,
        businessEntitlements: body.businessEntitlements,
        planCode: body.planCode ?? null,
        priceMinor: body.priceMinor,
        currencyCode: market.currencyCode,
        durationDays: body.durationDays,
        enabled: body.enabled,
        createdBy: req.actor!.id,
        updatedBy: req.actor!.id,
      })
      .returning();
    await db.insert(marketAudit).values({ id: randomUUID(), marketId: market.id, actorId: req.actor!.id, action: "COMMERCIAL_PRODUCT_CREATED", data: { productId: row!.id, productType: row!.productType, planCode: row!.planCode, priceMinor: row!.priceMinor, currencyCode: row!.currencyCode, pricingVersion: row!.pricingVersion, durationDays: row!.durationDays, entitlements: row!.businessEntitlements, enabled: row!.enabled } });
    res.status(201).json(commercialProductView(row!, market));
  } catch (error) {
    if ((error as { cause?: { code?: string }; code?: string }).cause?.code === "23505" || (error as { code?: string }).code === "23505")
      throw refuse(409, "توجد خطة مفعّلة بالرمز نفسه في هذا السوق؛ أوقفها أولًا ثم أضف السعر الجديد بإصدار تسعير جديد", "PLAN_ALREADY_ENABLED");
    if ((error as { cause?: { code?: string }; code?: string }).cause?.code === "23514" || (error as { code?: string }).code === "23514")
      throw fail(400, "شروط المنتج غير متسقة (طريقة الاحتساب أو الميزانية أو الفئة)", "PRODUCT_INVALID");
    throw error;
  }
});

/** Disabling stops new sales only; purchased campaigns, units and plans keep their snapshotted terms. */
router.patch("/admin/commercial-products/:id", requireAuth, requireCommercialAdmin, async (req, res) => {
  const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  const [current] = await db.select().from(promotionProducts).where(eq(promotionProducts.id, String(req.params.id)));
  if (!current) throw fail(404, "المنتج غير موجود");
  if (body.enabled && ["EXTRA_LISTING_QUOTA", "SPONSORED_SURFACE"].includes(current.productType))
    throw fail(409, "هذا المنتج مُعدّ ولم يُفعّل بعد", "PREPARED_NOT_ENABLED");
  let row;
  try {
    [row] = await db.update(promotionProducts).set({ enabled: body.enabled, updatedBy: req.actor!.id, updatedAt: new Date() }).where(eq(promotionProducts.id, current.id)).returning();
  } catch (error) {
    if ((error as { cause?: { code?: string }; code?: string }).cause?.code === "23505" || (error as { code?: string }).code === "23505")
      throw refuse(409, "توجد خطة مفعّلة بالرمز نفسه في هذا السوق", "PLAN_ALREADY_ENABLED");
    throw error;
  }
  await db.insert(marketAudit).values({ id: randomUUID(), marketId: current.marketId, actorId: req.actor!.id, action: body.enabled ? "COMMERCIAL_PRODUCT_ENABLED" : "COMMERCIAL_PRODUCT_DISABLED", data: { productId: current.id, productType: current.productType, planCode: current.planCode, priceMinor: current.priceMinor, pricingVersion: current.pricingVersion } });
  res.json({ id: row!.id, enabled: row!.enabled });
});

router.get("/admin/commercial-policies", requireAuth, requireCommercialAdmin, async (req, res) => {
  const marketId = typeof req.query.marketId === "string" ? req.query.marketId : undefined;
  const rows = await db.select().from(commercialPolicies).orderBy(desc(commercialPolicies.version)).limit(50);
  res.json({
    defaults: DEFAULT_COMMERCIAL_POLICY,
    effective: marketId ? await getCommercialPolicy(marketId) : DEFAULT_COMMERCIAL_POLICY,
    versions: rows.filter((row) => !marketId || row.marketId === marketId || row.marketId === null).map((row) => ({ id: row.id, marketId: row.marketId, version: row.version, effectiveFrom: row.effectiveFrom.toISOString(), policy: row.policy })),
  });
});

router.post("/admin/commercial-policies", requireAuth, requireCommercialAdmin, async (req, res) => {
  const body = z.object({ marketId: z.string().min(1).max(8).optional(), policy: CommercialPolicySchema.partial() }).strict().parse(req.body);
  if (body.marketId) await marketById(body.marketId);
  const current = await getCommercialPolicy(body.marketId ?? "");
  const { version: _version, ...base } = current;
  const merged = CommercialPolicySchema.parse({ ...base, ...body.policy });
  // D1: a changed reference price must carry a new price version (the history stays readable).
  for (const code of PLAN_CODES) {
    const before = base.subscriptionPlans.plans[code];
    const after = merged.subscriptionPlans.plans[code];
    if (JSON.stringify(before.referencePrice) !== JSON.stringify(after.referencePrice) && after.priceVersion <= before.priceVersion)
      throw refuse(400, `تغيير سعر ${after.nameAr} يحتاج إصدار تسعير أعلى من ${before.priceVersion}`, "PRICE_VERSION_REQUIRED");
    if (after.priceVersion < before.priceVersion) throw refuse(400, "لا يمكن إرجاع إصدار التسعير", "PRICE_VERSION_REQUIRED");
  }
  const [latest] = await db
    .select({ version: sql<number>`coalesce(max(${commercialPolicies.version}), 0)::int` })
    .from(commercialPolicies)
    .where(body.marketId ? eq(commercialPolicies.marketId, body.marketId) : sql`${commercialPolicies.marketId} is null`);
  const [row] = await db
    .insert(commercialPolicies)
    .values({ id: randomUUID(), marketId: body.marketId ?? null, version: (latest?.version ?? 0) + 1, policy: merged, createdBy: req.actor!.id })
    .returning();
  res.status(201).json({ id: row!.id, marketId: row!.marketId, version: row!.version, policy: row!.policy });
});

router.post("/admin/commercial-credits", requireAuth, requireCommercialAdmin, async (req, res) => {
  const body = z.object({ userId: z.string().min(1).max(80), marketId: z.string().min(1).max(8), amountMajor: z.number().positive().max(100_000), reason: z.string().trim().min(2).max(60), idempotencyKey: key }).strict().parse(req.body);
  const market = await marketById(body.marketId);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.userId));
  if (!user) throw fail(404, "المستخدم غير موجود");
  res.status(201).json(await grantPromotionalCredit({ adminId: req.actor!.id, userId: user.id, market, amountMinor: majorToMinor(body.amountMajor, market.minorUnitScale), reason: body.reason, idempotencyKey: body.idempotencyKey }));
});

router.post("/admin/commercial-refunds", requireAuth, requireCommercialAdmin, async (req, res) => {
  const body = z.object({ entryId: z.string().min(1).max(80), reason: z.string().trim().min(2).max(60) }).strict().parse(req.body);
  res.status(201).json(await refundEntryToCredit(body));
});

/** Revenue, reserved budgets, GMV and commission kept apart; fraud suppression; pulse health. */
router.get("/admin/markets/:marketId/commercial-summary", requireAuth, requireCommercialAdmin, async (req, res) => {
  const market = await marketById(String(req.params.marketId));
  const campaigns = (await db.execute(sql`
    select product_type_snapshot as product, status, count(*)::int as n, coalesce(sum(budget_minor), 0)::int as budget, coalesce(sum(spent_minor), 0)::int as spent
    from listing_promotions where market_id = ${market.id} group by 1, 2 order by 1, 2`)).rows;
  const attribution = (await db
    .select({ eventType: promotionAttributions.eventType, chargeStatus: promotionAttributions.chargeStatus, n: sql<number>`count(*)::int` })
    .from(promotionAttributions)
    .where(eq(promotionAttributions.marketId, market.id))
    .groupBy(promotionAttributions.eventType, promotionAttributions.chargeStatus)) as unknown[];
  const [pulse] = (await db
    .select({ signals: sql<number>`count(*)::int`, needs: sql<number>`count(distinct ${demandSignals.needKey})::int` })
    .from(demandSignals)
    .where(and(eq(demandSignals.marketId, market.id), sql`${demandSignals.createdAt} >= now() - interval '30 days'`))) as { signals: number; needs: number }[];
  const plans = await businessPlans(market);
  const [subs] = (await db.execute(sql`select count(*) filter (where status in ('ACTIVE','CANCEL_AT_PERIOD_END'))::int as active from business_subscriptions where market_id = ${market.id}`)).rows as { active: number }[];
  const live = await db.select({ n: sql<number>`count(*)::int` }).from(listingPromotions).where(and(eq(listingPromotions.marketId, market.id), eq(listingPromotions.status, "ACTIVE")));
  res.json({
    marketId: market.id,
    currencyCode: market.currencyCode,
    economics: await commercialEconomics(market.id),
    activeCampaigns: live[0]?.n ?? 0,
    campaigns,
    attribution,
    marketPulseHealth: { signals30d: pulse?.signals ?? 0, distinctNeeds30d: pulse?.needs ?? 0, cohortThreshold: (await getCommercialPolicy(market.id)).minCohortSize },
    businessPlans: plans.length,
    activeSubscriptions: subs?.active ?? 0,
    realMoneyMoved: false,
  });
});

export default router;
