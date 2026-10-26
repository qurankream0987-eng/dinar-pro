import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, driverProfiles } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import {
  confirmCourierFare,
  getCourierCommissionAccount,
  getCourierFareView,
  proposeCourierFare,
  settleCourierCommissionSimulation,
} from "../lib/courier-economics";
import { assertMarketActive, marketError, marketFor } from "../lib/markets";

const router: IRouter = Router();
const FareProposalBody = z
  .object({
    amount: z.string().min(1).max(32),
    idempotencyKey: z.string().min(12).max(128),
  })
  .strict();
const FareConfirmBody = z.object({ proposalId: z.string().min(1).max(128) }).strict();
const SettlementBody = z
  .object({
    marketId: z.string().min(1).max(128),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    idempotencyKey: z.string().min(12).max(128),
  })
  .strict();

router.get("/orders/:id/courier-fare", requireAuth, async (req, res) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  res.set("Pragma", "no-cache");
  const market = await marketFor(req);
  const view = await db.transaction((tx) =>
    getCourierFareView(
      { actorId: req.actor!.id, orderId: String(req.params.id), market },
      tx,
    ),
  );
  res.json(view);
});

router.post("/orders/:id/courier-fare/proposals", requireAuth, async (req, res) => {
  const body = FareProposalBody.parse(req.body);
  const market = await marketFor(req);
  const result = await db.transaction((tx) =>
    proposeCourierFare(
      {
        actorId: req.actor!.id,
        orderId: String(req.params.id),
        market,
        amount: body.amount,
        idempotencyKey: body.idempotencyKey,
      },
      tx,
    ),
  );
  res.json(result);
});

router.post("/orders/:id/courier-fare/confirm", requireAuth, async (req, res) => {
  const body = FareConfirmBody.parse(req.body);
  const market = await marketFor(req);
  const result = await db.transaction((tx) =>
    confirmCourierFare(
      {
        actorId: req.actor!.id,
        orderId: String(req.params.id),
        market,
        proposalId: body.proposalId,
      },
      tx,
    ),
  );
  res.json(result);
});

router.get("/courier/commission-account", requireAuth, async (req, res) => {
  res.json(
    await getCourierCommissionAccount(
      { courierId: req.actor!.id },
      db,
    ),
  );
});

router.post("/courier/commission-account/settlements", requireAuth, async (req, res) => {
  const body = SettlementBody.parse(req.body);
  const result = await db.transaction(async (tx) => {
    const market = await marketFor(req, tx, true);
    assertMarketActive(market);
    if (body.marketId !== market.id)
      throw marketError(403, "لا يمكن تسوية عمولة خارج سوقك النشط.");
    if (body.currencyCode !== market.currencyCode)
      throw marketError(409, "عملة التسوية لا تطابق عملة السوق النشط.");
    const [profile] = await tx
      .select({ id: driverProfiles.id })
      .from(driverProfiles)
      .where(
        and(
          eq(driverProfiles.userId, req.actor!.id),
          eq(driverProfiles.marketId, market.id),
        ),
      )
      .limit(1);
    if (!profile)
      throw marketError(403, "تسوية عمولة التوصيل متاحة لحساب مندوب مسجل في السوق النشط فقط.");
    return settleCourierCommissionSimulation(
      {
        courierId: req.actor!.id,
        market: {
          id: market.id,
          currencyCode: market.currencyCode,
          minorUnitScale: market.minorUnitScale,
        },
        idempotencyKey: body.idempotencyKey,
      },
      tx,
    );
  });
  res.json({
    settlement: result.settlement,
    idempotent: result.idempotent,
    realMoneyTransferred: false,
  });
});

export default router;
