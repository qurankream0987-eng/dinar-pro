import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { GetAdminMarketCategoryPolicyAuditResponse } from "@workspace/api-zod";
import {
  db,
  marketAudit,
  marketLegalIntakes,
  marketPriceVersions,
  markets,
  sellerMarketEligibility,
  users,
} from "@workspace/db";
import { currencies } from "@workspace/global";
import { requireAuth } from "../lib/auth";
import {
  allMarkets,
  assertMarketActive,
  marketError,
  resolveMarket,
} from "../lib/markets";
import { listMarketplaceCategories } from "../lib/marketplace-categories";
import { assertCountryActivationReady } from "../lib/country-legal-readiness";
import {
  ARAB_MARKET_IDS,
  arabMarketsReadinessReport,
  verifyMarketTechnicalReadiness,
} from "../lib/market-technical-readiness";

const router = Router();

router.use("/admin", requireAuth, (req, res, next) => {
  if (req.actor!.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة الأسواق فقط" });
    return;
  }
  next();
});

// Technical readiness and legal status of every Arab market, side by side and never merged.
router.get("/admin/markets/arab-readiness", async (_req, res) => {
  res.json({ markets: await arabMarketsReadinessReport() });
});

// Runs the automated technical checks. Records technical readiness only: no legal review,
// counsel signature, owner approval or activation is written or implied.
router.post("/admin/markets/arab-readiness/verify", async (req, res) => {
  const requested = Array.isArray(req.body?.marketIds) ? req.body.marketIds : ARAB_MARKET_IDS;
  const ids = requested.filter((id: unknown): id is string => typeof id === "string" && (ARAB_MARKET_IDS as readonly string[]).includes(id));
  if (!ids.length) throw marketError(400, "لا توجد أسواق عربية صالحة للفحص");
  const results = await verifyMarketTechnicalReadiness(ids, req.actor!.id);
  res.json({ results, markets: await arabMarketsReadinessReport() });
});

router.get("/admin/markets", async (_req, res) => {
  res.json(await allMarkets());
});

router.get("/admin/markets/:id/prices", async (req, res) => {
  res.json(
    await db
      .select()
      .from(marketPriceVersions)
      .where(eq(marketPriceVersions.marketId, String(req.params.id)))
      .orderBy(asc(marketPriceVersions.effectiveFrom)),
  );
});

router.get("/admin/markets/:id/audit", async (req, res) => {
  const marketId = String(req.params.id);
  const [market] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!market) throw marketError(404, "السوق غير موجود");

  const rows = await db
    .select({
      id: marketAudit.id,
      marketId: marketAudit.marketId,
      actorId: marketAudit.actorId,
      actorName: users.displayName,
      action: marketAudit.action,
      data: marketAudit.data,
      createdAt: marketAudit.createdAt,
    })
    .from(marketAudit)
    .innerJoin(users, eq(marketAudit.actorId, users.id))
    .where(
      and(
        eq(marketAudit.marketId, marketId),
        eq(marketAudit.action, "CATEGORY_POLICY"),
      ),
    )
    .orderBy(desc(marketAudit.createdAt))
    .limit(100);
  res.json(GetAdminMarketCategoryPolicyAuditResponse.parse(rows));
});

const config = z
  .object({
    status: z.enum(["ACTIVE", "LIMITED", "COMING_SOON", "DISABLED"]),
    fulfilmentMethods: z
      .array(z.enum(["PICKUP", "DELIVERY", "DIGITAL", "SERVICE", "COURIER"]))
      .min(1)
      .max(5),
    paymentMethods: z.array(z.literal("CASH_DIRECT")).max(1),
    restrictedCategories: z.array(z.string().min(1).max(100)).max(30),
    sellerEligibilityMode: z.enum(["OPEN", "APPROVAL_REQUIRED"]),
  })
  .strict();

router.patch("/admin/markets/:id", async (req, res) => {
  const body = config.parse(req.body);
  const categories = await listMarketplaceCategories(true);
  if (
    body.restrictedCategories.some(
      (value) =>
        !categories.some(
          (category) => category.id === value || category.label === value,
        ),
    )
  ) {
    throw marketError(400, "أحد التصنيفات المحظورة غير موجود");
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, String(req.params.id)))
      .for("update");
    if (!row) throw marketError(404, "السوق غير موجود");

    const current = await resolveMarket(row, tx);
    const isActive = ["ACTIVE", "LIMITED"].includes(body.status);
    if (isActive) {
      // Lock the country-intake row with the market row so a concurrent approval or suspension
      // cannot race the activation decision.
      await tx
        .select({ id: marketLegalIntakes.id })
        .from(marketLegalIntakes)
        .where(eq(marketLegalIntakes.marketId, row.id))
        .for("update")
        .limit(1);
      await assertCountryActivationReady(row.id, tx);
      assertMarketActive({ ...current, status: body.status, isActive });
    }

    const [updated] = await tx
      .update(markets)
      .set({
        ...body,
        isActive,
        unitPriceMinor: current.priceConfigured ? current.unitPriceMinor : null,
        currencyCode: current.currencyCode,
        minorUnitScale: current.minorUnitScale,
        updatedAt: new Date(),
      })
      .where(eq(markets.id, row.id))
      .returning();

    await tx.insert(marketAudit).values({
      id: randomUUID(),
      marketId: row.id,
      actorId: req.actor!.id,
      action: "CONFIGURATION",
      data: { before: row, after: updated },
    });
    if (
      JSON.stringify(row.restrictedCategories) !==
      JSON.stringify(updated.restrictedCategories)
    ) {
      await tx.insert(marketAudit).values({
        id: randomUUID(),
        marketId: row.id,
        actorId: req.actor!.id,
        action: "CATEGORY_POLICY",
        data: {
          before: { restrictedCategories: row.restrictedCategories },
          after: { restrictedCategories: updated.restrictedCategories },
        },
      });
    }
    return resolveMarket(updated, tx);
  });

  res.json(result);
});

const priceInput = z
  .object({
    currencyCode: z
      .string()
      .refine(
        (code) =>
          !!currencies[code] &&
          code !== "XXX" &&
          !["USN", "UYI", "CHE", "CHW"].includes(code),
      ),
    unitPriceMinor: z.number().int().positive().max(2_000_000_000),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

router.post("/admin/markets/:id/prices", async (req, res) => {
  const body = priceInput.parse(req.body);
  const now = new Date();
  const start = body.effectiveFrom ? new Date(body.effectiveFrom) : now;
  if (start.getTime() < now.getTime() - 5000) {
    throw marketError(400, "لا يمكن تغيير سعر بأثر رجعي");
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, String(req.params.id)))
      .for("update");
    if (!row) throw marketError(404, "السوق غير موجود");

    const history = await tx
      .select()
      .from(marketPriceVersions)
      .where(eq(marketPriceVersions.marketId, row.id))
      .orderBy(asc(marketPriceVersions.effectiveFrom));
    if (history.some((price) => price.effectiveFrom.getTime() === start.getTime())) {
      throw marketError(409, "يوجد سعر يبدأ في هذا الوقت");
    }

    const previous = history.filter((price) => price.effectiveFrom < start).at(-1);
    const next = history.find((price) => price.effectiveFrom > start);
    if (previous) {
      await tx
        .update(marketPriceVersions)
        .set({ effectiveTo: start })
        .where(eq(marketPriceVersions.id, previous.id));
    }

    const [version] = await tx
      .insert(marketPriceVersions)
      .values({
        id: randomUUID(),
        marketId: row.id,
        currencyCode: body.currencyCode,
        unitPriceMinor: body.unitPriceMinor,
        minorUnitScale: currencies[body.currencyCode].minorUnitScale,
        effectiveFrom: start,
        effectiveTo: next?.effectiveFrom ?? null,
        createdBy: req.actor!.id,
      })
      .returning();
    if (start <= now) {
      await tx
        .update(markets)
        .set({
          currencyCode: version.currencyCode,
          unitPriceMinor: version.unitPriceMinor,
          minorUnitScale: version.minorUnitScale,
          updatedAt: now,
        })
        .where(eq(markets.id, row.id));
    }
    await tx.insert(marketAudit).values({
      id: randomUUID(),
      marketId: row.id,
      actorId: req.actor!.id,
      action: "PRICE",
      data: version,
    });
    return version;
  });
  res.status(201).json(result);
});

router.put("/admin/markets/:id/sellers/:userId", async (req, res) => {
  const body = z.object({ approved: z.boolean() }).strict().parse(req.body);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, String(req.params.userId)));
  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, String(req.params.id)));
  if (!user || !market) {
    throw marketError(404, "المستخدم أو السوق غير موجود");
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(sellerMarketEligibility)
      .values({ userId: user.id, marketId: market.id, approved: body.approved })
      .onConflictDoUpdate({
        target: [sellerMarketEligibility.userId, sellerMarketEligibility.marketId],
        set: { approved: body.approved, updatedAt: new Date() },
      });
    await tx.insert(marketAudit).values({
      id: randomUUID(),
      marketId: market.id,
      actorId: req.actor!.id,
      action: "SELLER_ELIGIBILITY",
      data: { userId: user.id, approved: body.approved },
    });
  });
  res.json({ ok: true });
});

export default router;
