import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { DRIVER_STATUS_LABELS, reviewDriverProfile, revokeCourierAssignment } from "../lib/driver";
import { marketFor } from "../lib/markets";

/**
 * Block F4: the only path to an APPROVED driver. The conversation can draft and submit a
 * profile but never approve it; a market administrator reviews it here.
 */
const router = Router();

const ReviewBody = z.object({ decision: z.enum(["APPROVE", "SUSPEND"]) }).strict();

router.post("/admin/drivers/:id/review", requireAuth, async (req, res) => {
  const parsed = ReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات المراجعة غير صالحة" });
    return;
  }
  const profile = await reviewDriverProfile({ adminId: req.actor!.id, profileId: String(req.params.id), decision: parsed.data.decision });
  res.json({ id: profile.id, status: profile.status, statusLabel: DRIVER_STATUS_LABELS[profile.status], availability: profile.availability });
});

const RevokeAssignmentBody = z.object({
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().min(12).max(128),
}).strict();

router.post("/admin/orders/:id/courier-assignment/revoke", requireAuth, async (req, res) => {
  const parsed = RevokeAssignmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "سبب إلغاء الإسناد مطلوب" });
    return;
  }
  const result = await revokeCourierAssignment({
    adminId: req.actor!.id,
    orderId: String(req.params.id),
    market: await marketFor(req),
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  res.json(result);
});

export default router;
