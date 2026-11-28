import { Router } from "express";
import { z } from "zod";
import { composePaymentOptions } from "../lib/merchant-policies/payment-options";
import { createStoreCheckoutSession, getStoreCheckoutOrderStatus } from "../lib/store-checkout/service";
import { requireAuth } from "../lib/auth";

const storeCheckoutRouter = Router();
export default storeCheckoutRouter;

const createSessionSchema = z.object({
  orderId: z.string().min(1),
  adapterId: z.string().min(1),
  idempotencyKey: z.string().min(4).max(128),
  returnUrl: z.string().url().optional(),
});

storeCheckoutRouter.post("/store-checkout/sessions", requireAuth, async (req, res, next) => {
  try {
    const parsed = createSessionSchema.parse(req.body ?? {});
    const result = await createStoreCheckoutSession({
      orderId: parsed.orderId,
      buyerId: req.user!.id,
      adapterId: parsed.adapterId,
      idempotencyKey: parsed.idempotencyKey,
      returnUrl: parsed.returnUrl,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

storeCheckoutRouter.get("/store-checkout/orders/:orderId/status", requireAuth, async (req, res, next) => {
  try {
    const card = await getStoreCheckoutOrderStatus(String(req.params.orderId), req.user!.id);
    if (!card) {
      res.status(404).json({ error: "لا توجد جلسة دفع لهذا الطلب." });
      return;
    }
    res.json({ card });
  } catch (error) {
    next(error);
  }
});

storeCheckoutRouter.get("/orders/:orderId/payment-options", requireAuth, async (req, res, next) => {
  try {
    const card = await composePaymentOptions({
      orderId: String(req.params.orderId),
      actorId: req.user!.id,
    });
    if (!card) {
      res.status(404).json({ error: "خيارات الدفع غير متاحة لهذا الطلب." });
      return;
    }
    res.json({ card });
  } catch (error) {
    next(error);
  }
});
