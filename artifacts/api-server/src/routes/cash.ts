/**
 * Wave 08: direct cash attestations and a separate cash refund engine. Available only in
 * development; every state change is participant-scoped and recorded server-side.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import {
  cashEngineEnabled,
  cashForOrder,
  claimCashPayment,
  claimCashRefundRepayment,
  confirmCashPayment,
  confirmCashRefundReceipt,
  denyCashPayment,
  disputeCashPayment,
  disputeCashRefundRepayment,
  openCashRefundCase,
  withdrawCashRefundCase,
} from "../lib/payments/cash";

const router = Router();
const id = (value: unknown) => String(value).slice(0, 80);

const requireCashEngine: RequestHandler = (_req, res, next) => {
  if (!cashEngineEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};
// Integration fix: the guard covers the cash paths only. A path-less router.use here hid every
// route mounted after this router (the whole API) whenever the engine is off, i.e. in production.
router.use(["/orders/:id/cash-payment", "/orders/:id/cash", "/orders/:id/cash-refunds", "/cash-refunds"], requireCashEngine);

const Evidence = z.array(z.string().trim().min(1).max(500)).max(10).default([]);
const ClaimBody = z
  .object({
    note: z.string().trim().max(500).optional(),
    evidence: Evidence,
  })
  .strict();
const ConfirmBody = z
  .object({
    note: z.string().trim().max(500).optional(),
    evidence: Evidence,
  })
  .strict();
const ReasonBody = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const RefundBody = z
  .object({
    amountMinor: z.number().int().positive().max(2_000_000_000),
    reason: z.string().trim().min(3).max(500),
    evidence: Evidence,
  })
  .strict();
const RepaymentBody = z
  .object({
    note: z.string().trim().min(3).max(500),
    evidence: Evidence,
  })
  .strict();

function readIdempotencyKey(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
) {
  const value = req.get("Idempotency-Key");
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    res.status(400).json({ error: "Idempotency-Key is required" });
    return undefined;
  }
  return value;
}

router.post("/orders/:id/cash-payment/claim", requireAuth, async (req, res, next) => {
  const idempotencyKey = readIdempotencyKey(req, res);
  if (!idempotencyKey) return;
  try {
    const body = ClaimBody.parse(req.body);
    const result = await claimCashPayment({
      buyerId: req.actor!.id,
      orderId: id(req.params.id),
      idempotencyKey,
      note: body.note,
      evidence: body.evidence,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/cash-payment/confirm", requireAuth, async (req, res, next) => {
  try {
    const body = ConfirmBody.parse(req.body);
    res.json(
      await confirmCashPayment({
        sellerId: req.actor!.id,
        orderId: id(req.params.id),
        note: body.note,
        evidence: body.evidence,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/cash-payment/deny", requireAuth, async (req, res, next) => {
  try {
    const body = ReasonBody.parse(req.body);
    res.json(
      await denyCashPayment({
        sellerId: req.actor!.id,
        orderId: id(req.params.id),
        reason: body.reason,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/cash-payment/dispute", requireAuth, async (req, res, next) => {
  try {
    const body = ReasonBody.parse(req.body);
    res.json(
      await disputeCashPayment({
        buyerId: req.actor!.id,
        orderId: id(req.params.id),
        reason: body.reason,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/orders/:id/cash", requireAuth, async (req, res, next) => {
  try {
    res.json(await cashForOrder({ actorId: req.actor!.id, orderId: id(req.params.id) }));
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/cash-refunds", requireAuth, async (req, res, next) => {
  const idempotencyKey = readIdempotencyKey(req, res);
  if (!idempotencyKey) return;
  try {
    const body = RefundBody.parse(req.body);
    const result = await openCashRefundCase({
      actorId: req.actor!.id,
      orderId: id(req.params.id),
      idempotencyKey,
      amountMinor: body.amountMinor,
      reason: body.reason,
      evidence: body.evidence,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/cash-refunds/:id/repayment-claim", requireAuth, async (req, res, next) => {
  try {
    const body = RepaymentBody.parse(req.body);
    res.json(
      await claimCashRefundRepayment({
        sellerId: req.actor!.id,
        refundId: id(req.params.id),
        note: body.note,
        evidence: body.evidence,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/cash-refunds/:id/confirm", requireAuth, async (req, res, next) => {
  try {
    res.json(
      await confirmCashRefundReceipt({
        buyerId: req.actor!.id,
        refundId: id(req.params.id),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/cash-refunds/:id/dispute", requireAuth, async (req, res, next) => {
  try {
    const body = ReasonBody.parse(req.body);
    res.json(
      await disputeCashRefundRepayment({
        buyerId: req.actor!.id,
        refundId: id(req.params.id),
        reason: body.reason,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/cash-refunds/:id/withdraw", requireAuth, async (req, res, next) => {
  try {
    res.json(
      await withdrawCashRefundCase({
        actorId: req.actor!.id,
        refundId: id(req.params.id),
      }),
    );
  } catch (error) {
    next(error);
  }
});

export default router;
