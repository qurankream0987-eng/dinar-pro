import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  ChangeSellerPromotionBody,
  ChangeSellerPromotionParams,
  ChangeSellerPromotionResponse,
  ConfirmListingPromotionBody,
  ConfirmListingPromotionResponse,
  GetAdminMarketPromotionsResponse,
  GetSellerPromotionParams,
  GetSellerPromotionResponse,
  GetSellerPromotionsResponse,
  CreateAdminPromotionProductBody,
  CreateAdminPromotionProductResponse,
  GetAdminPromotionProductsResponse,
  GetPromotionProductsResponse,
  PreviewListingPromotionBody,
  PreviewListingPromotionResponse,
  UpdateAdminPromotionProductBody,
  UpdateAdminPromotionProductResponse,
} from "@workspace/api-zod";
import {
  db,
  marketAudit,
  markets,
  promotionProducts,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  assertMarketActive,
  marketFor,
  resolveMarket,
} from "../lib/markets";
import {
  categoryIsRestricted,
  listMarketplaceCategories,
  resolveMarketplaceCategory,
} from "../lib/marketplace-categories";
import {
  canConfigurePromotionCatalog,
  isPromotionFeatureEnabled,
  isPromotionSimulationEnabled,
} from "../lib/promotion-policy";
import {
  adminMarketPromotions,
  changePromotion,
  getSellerPromotion,
  listSellerPromotions,
  purchasePromotion,
  reviewPromotion,
} from "../lib/promotions";

const router = Router();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });
const assertPromotionFeatureEnabled = () => {
  if (!isPromotionFeatureEnabled()) {
    throw fail(503, "عروض الترويج غير مفعلة في هذه البيئة");
  }
};

const requirePromotionAdmin: RequestHandler = (req, res, next) => {
  if (!canConfigurePromotionCatalog(req.actor?.role)) {
    res.status(403).json({ error: "تحتاج إلى صلاحية إدارة العروض الترويجية" });
    return;
  }
  next();
};

async function promotionMarketById(id: string) {
  const [row] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, id))
    .limit(1);
  if (!row) throw fail(404, "السوق غير موجود");
  return resolveMarket(row);
}

async function promotionCategory(
  categoryId: string,
  market: Awaited<ReturnType<typeof promotionMarketById>>,
  tx: any = db,
) {
  const category = await resolveMarketplaceCategory(categoryId, undefined, tx);
  if (!category) throw fail(404, "التصنيف غير موجود أو غير نشط");
  if (categoryIsRestricted(market, category)) {
    throw fail(400, "لا يمكن ترويج عروض هذا التصنيف في السوق");
  }
  return category;
}

router.get("/promotion-products", requireAuth, async (req, res) => {
  assertPromotionFeatureEnabled();
  const market = await marketFor(req);
  assertMarketActive(market);
  const rows = await db
    .select()
    .from(promotionProducts)
    .where(
      and(
        eq(promotionProducts.marketId, market.id),
        eq(promotionProducts.enabled, true),
      ),
    )
    .orderBy(asc(promotionProducts.priceMinor), asc(promotionProducts.name));
  const categories = new Map(
    (await listMarketplaceCategories()).map((category) => [
      category.id,
      category,
    ]),
  );
  const products = rows.filter(
    (product) => {
      // The Block E plan list; the rest of the commercial catalog has its own route.
      if (product.productType !== "STANDARD_PROMOTION" || !product.categoryId) return false;
      const category = categories.get(product.categoryId);
      return (
        product.currencyCode === market.currencyCode &&
        !!category &&
        !categoryIsRestricted(market, category)
      );
    },
  );
  res.json(GetPromotionProductsResponse.parse(products));
});

router.post(
  "/listings/:id/promotion-preview",
  requireAuth,
  async (req, res) => {
    const body = PreviewListingPromotionBody.strict().parse(req.body);
    assertPromotionFeatureEnabled();
    const market = await marketFor(req);
    assertMarketActive(market);
    const review = await reviewPromotion({
      actorId: req.actor!.id,
      market,
      listingId: String(req.params.id),
      productId: body.promotionProductId,
    });
    res.json(
      PreviewListingPromotionResponse.parse({
        listingId: review.listingId,
        productId: review.plan.id,
        productName: review.plan.name,
        categoryId: review.categoryId,
        priceMinor: review.plan.priceMinor,
        currencyCode: review.plan.currencyCode,
        placement: review.plan.placement,
        durationDays: review.plan.durationDays,
        simulationOnly: true,
        simulationEnabled: isPromotionSimulationEnabled(),
        warning:
          "محاكاة تطوير فقط: لا يتم خصم أو تحصيل أي مبلغ حقيقي ولا تنشأ فاتورة أو محفظة أو مستحقات. لا تجديد تلقائي.",
      }),
    );
  },
);

// The seller never sends a price, status, or payment result: the plan is server
// state and activation depends only on the simulated payment authority.
router.post(
  "/listings/:id/promotions",
  requireAuth,
  async (req, res) => {
    const body = ConfirmListingPromotionBody.strict().parse(req.body);
    const market = await marketFor(req);
    assertMarketActive(market);
    const outcome = await purchasePromotion({
      actorId: req.actor!.id,
      market,
      listingId: String(req.params.id),
      productId: body.promotionProductId,
      idempotencyKey: body.idempotencyKey,
      simulateDecline: body.simulatedPaymentOutcome === "DECLINE",
    });
    res
      .status(outcome.created ? 201 : 200)
      .json(ConfirmListingPromotionResponse.parse(outcome.promotion));
  },
);

router.get("/promotions", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  res.json(
    GetSellerPromotionsResponse.parse(
      await listSellerPromotions(req.actor!.id, market),
    ),
  );
});

router.get("/promotions/:id", requireAuth, async (req, res) => {
  const { id } = GetSellerPromotionParams.parse(req.params);
  const market = await marketFor(req);
  res.json(
    GetSellerPromotionResponse.parse(
      await getSellerPromotion(req.actor!.id, market, id),
    ),
  );
});

router.post("/promotions/:id/actions", requireAuth, async (req, res) => {
  const { id } = ChangeSellerPromotionParams.parse(req.params);
  const body = ChangeSellerPromotionBody.strict().parse(req.body);
  const market = await marketFor(req);
  const outcome = await changePromotion({
    actorId: req.actor!.id,
    market,
    promotionId: id,
    action: body.action,
  });
  res.json(ChangeSellerPromotionResponse.parse(outcome.promotion));
});

router.get(
  "/admin/markets/:marketId/promotions",
  requireAuth,
  requirePromotionAdmin,
  async (req, res) => {
    assertPromotionFeatureEnabled();
    const market = await promotionMarketById(String(req.params.marketId));
    res.json(
      GetAdminMarketPromotionsResponse.parse(await adminMarketPromotions(market)),
    );
  },
);

router.get(
  "/admin/markets/:marketId/promotion-products",
  requireAuth,
  requirePromotionAdmin,
  async (req, res) => {
    assertPromotionFeatureEnabled();
    const marketId = String(req.params.marketId);
    await promotionMarketById(marketId);
    const rows = await db
      .select()
      .from(promotionProducts)
      .where(eq(promotionProducts.marketId, marketId))
      .orderBy(asc(promotionProducts.createdAt));
    res.json(GetAdminPromotionProductsResponse.parse(rows));
  },
);

router.post(
  "/admin/markets/:marketId/promotion-products",
  requireAuth,
  requirePromotionAdmin,
  async (req, res) => {
    const body = CreateAdminPromotionProductBody.strict().parse(req.body);
    assertPromotionFeatureEnabled();
    const name = body.name.trim();
    if (!name) throw fail(400, "أدخل اسمًا صالحًا لخطة الترويج");
    const marketId = String(req.params.marketId);
    const market = await promotionMarketById(marketId);
    await promotionCategory(body.categoryId, market);

    const created = await db.transaction(async (tx) => {
      const [product] = await tx
        .insert(promotionProducts)
        .values({
          id: randomUUID(),
          marketId,
          categoryId: body.categoryId,
          name,
          placement: body.placement,
          priceMinor: body.priceMinor,
          currencyCode: market.currencyCode,
          durationDays: body.durationDays,
          enabled: body.enabled,
          createdBy: req.actor!.id,
          updatedBy: req.actor!.id,
        })
        .returning();
      await tx.insert(marketAudit).values({
        id: randomUUID(),
        marketId,
        actorId: req.actor!.id,
        action: "PROMOTION_PRODUCT_CREATE",
        data: { after: product },
      });
      return product;
    });
    res.status(201).json(CreateAdminPromotionProductResponse.parse(created));
  },
);

router.patch(
  "/admin/markets/:marketId/promotion-products/:id",
  requireAuth,
  requirePromotionAdmin,
  async (req, res) => {
    const body = UpdateAdminPromotionProductBody.strict().parse(req.body);
    assertPromotionFeatureEnabled();
    if (Object.keys(body).length === 0) {
      throw fail(400, "أدخل تغييرًا واحدًا على الأقل");
    }
    const name = body.name?.trim();
    if (body.name !== undefined && !name) {
      throw fail(400, "أدخل اسمًا صالحًا لخطة الترويج");
    }
    const marketId = String(req.params.marketId);
    const market = await promotionMarketById(marketId);
    const [before] = await db
      .select()
      .from(promotionProducts)
      .where(
        and(
          eq(promotionProducts.id, String(req.params.id)),
          eq(promotionProducts.marketId, marketId),
        ),
      )
      .limit(1);
    if (!before) throw fail(404, "خطة الترويج غير موجودة في هذا السوق");

    if (
      body.currencyCode !== undefined &&
      body.currencyCode !== market.currencyCode
    ) {
      throw fail(400, "يجب أن تطابق العملة عملة السوق الحالية");
    }
    const nextCurrencyCode = body.currencyCode ?? before.currencyCode;
    const nextEnabled = body.enabled ?? before.enabled;
    if (
      nextCurrencyCode !== before.currencyCode &&
      body.priceMinor === undefined
    ) {
      throw fail(400, "عند تغيير العملة يجب تحديث السعر معها");
    }
    if (nextEnabled && nextCurrencyCode !== market.currencyCode) {
      if (
        body.currencyCode !== market.currencyCode ||
        body.priceMinor === undefined
      ) {
        throw fail(
          400,
          "لتفعيل الخطة بعد تغيير عملة السوق، حدّث العملة والسعر معًا",
        );
      }
    }
    if (body.categoryId !== undefined) {
      await promotionCategory(body.categoryId, market);
    }

    const updated = await db.transaction(async (tx) => {
      const [product] = await tx
        .update(promotionProducts)
        .set({
          ...body,
          ...(name !== undefined ? { name } : {}),
          currencyCode: nextCurrencyCode,
          updatedBy: req.actor!.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(promotionProducts.id, before.id),
            eq(promotionProducts.marketId, marketId),
          ),
        )
        .returning();
      await tx.insert(marketAudit).values({
        id: randomUUID(),
        marketId,
        actorId: req.actor!.id,
        action: "PROMOTION_PRODUCT_UPDATE",
        data: { before, after: product },
      });
      return product;
    });
    res.json(UpdateAdminPromotionProductResponse.parse(updated));
  },
);

export default router;