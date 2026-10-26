import { Router, type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, paymentIntents, paymentRefunds } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  attachProviderRefundId,
  createPaymentIntent,
  createRefundRequest,
  receivePaymentWebhook,
  reconcilePayments,
} from "../lib/payments/service";
import { PaymentWebhookEventSchema } from "../lib/payments/contracts";
import { testOnlyPaymentAdapter } from "../lib/payments/test-adapter";

const router = Router();

const CreateIntentBody = z
  .object({
    orderId: z.string().min(1).max(180),
  })
  .strict();

const CreateRefundBody = z
  .object({
    amountMinor: z.number().int().positive().max(2_000_000_000),
    reason: z.string().trim().max(500).default(""),
  })
  .strict();

export function paymentSimulationEnabled() {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.BDINAR_WAVE4_ACCEPTANCE === "development" &&
    process.env.REPLIT_DEPLOYMENT === undefined
  );
}

const requireSimulation: RequestHandler = (_req, res, next) => {
  if (!paymentSimulationEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

function readIdempotencyKey(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) {
  const value = req.get("Idempotency-Key");
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    res.status(400).json({ error: "Idempotency-Key is required" });
    return undefined;
  }
  return value;
}

/** Creates a SIMULATION_ONLY intent for a buyer's order; shared by the route and Block F3. */
export async function createTestPaymentIntent(input: { buyerId: string; orderId: string; idempotencyKey: string }) {
  const providerIntentId = testOnlyPaymentAdapter.allocateIntentReference();
  const intent = await createPaymentIntent({
    buyerId: input.buyerId,
    orderId: input.orderId,
    idempotencyKey: input.idempotencyKey,
    providerKey: testOnlyPaymentAdapter.providerKey,
    providerIntentId,
  });
  if (intent.created) {
    testOnlyPaymentAdapter.registerIntent(providerIntentId, {
      amountMinor: intent.amountMinor,
      currencyCode: intent.currencyCode,
    });
  }
  return intent;
}

router.use(requireSimulation);

router.post("/payments/intents", requireAuth, async (req, res, next) => {
  const parsed = CreateIntentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment intent request" });
    return;
  }
  const idempotencyKey = readIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  try {
    const intent = await createTestPaymentIntent({
      buyerId: req.actor!.id,
      orderId: parsed.data.orderId,
      idempotencyKey,
    });
    res.status(intent.created ? 201 : 200).json(intent);
  } catch (error) {
    next(error);
  }
});

router.post("/payments/webhooks/test", async (req, res, next) => {
  const parsed = PaymentWebhookEventSchema.safeParse(req.body);
  const signature = req.get("x-payment-signature") ?? "";
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment webhook event" });
    return;
  }
  try {
    const result = await receivePaymentWebhook({
      adapter: testOnlyPaymentAdapter,
      event: parsed.data,
      signature,
    });
    res.json({ ...result, mode: "SIMULATION_ONLY" });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/admin/payments/intents/:id/refunds",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    const parsed = CreateRefundBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid refund request" });
      return;
    }
    const idempotencyKey = readIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    try {
      const paymentIntentId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      if (!paymentIntentId) {
        res.status(404).json({ error: "Payment intent was not found" });
        return;
      }
      const [intent] = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, paymentIntentId));
      if (!intent) {
        res.status(404).json({ error: "Payment intent was not found" });
        return;
      }

      const refund = await createRefundRequest({
        paymentIntentId: intent.id,
        idempotencyKey,
        amountMinor: parsed.data.amountMinor,
        reason: parsed.data.reason,
      });
      if (refund.status === "REQUESTED") {
        const signedWebhook = testOnlyPaymentAdapter.createRefundWebhook({
          providerIntentId: intent.providerIntentId,
          amountMinor: refund.amountMinor,
          currencyCode: refund.currencyCode,
          idempotencyKey: `${intent.id}:${idempotencyKey}`,
        });
        const event = signedWebhook.event;
        if (event.type !== "REFUND_SUCCEEDED")
          throw new Error("Test adapter returned an unexpected event type");
        await attachProviderRefundId(refund.id, event.providerRefundId);
        await receivePaymentWebhook({
          adapter: testOnlyPaymentAdapter,
          event,
          signature: signedWebhook.signature,
        });
      }

      const [updatedRefund] = await db
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, refund.id));
      res.status(refund.status === "REQUESTED" ? 201 : 200).json({
        id: updatedRefund.id,
        paymentIntentId: updatedRefund.paymentIntentId,
        amountMinor: updatedRefund.amountMinor,
        currencyCode: updatedRefund.currencyCode,
        status: updatedRefund.status,
        mode: updatedRefund.mode,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin/payments/reconcile",
  requireAuth,
  requireAdmin,
  async (_req, res, next) => {
    try {
      res.json(await reconcilePayments(testOnlyPaymentAdapter));
    } catch (error) {
      next(error);
    }
  },
);

export default router;