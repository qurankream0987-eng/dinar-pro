/**
 * DINAR NEXT pre-integration: appeals of trust decisions and two-sided dispute evidence.
 * Parties act on their own decisions and orders only; admins decide with a recorded reason.
 */
import { Router, type RequestHandler } from "express";
import { requireAuth } from "../lib/auth";
import {
  AppealBody,
  AppealDecisionBody,
  DisputeEvidenceBody,
  addDisputeEvidence,
  appealQueue,
  decideAppeal,
  ownAppeals,
  submitAppeal,
  withdrawAppeal,
} from "../lib/trust-appeals";

const router = Router();
const id = (value: unknown) => String(value).slice(0, 80);

router.post("/appeals", requireAuth, async (req, res) => {
  res.status(201).json(await submitAppeal(req.actor!.id, AppealBody.parse(req.body)));
});
router.get("/appeals/mine", requireAuth, async (req, res) => {
  res.json(await ownAppeals(req.actor!.id));
});
router.post("/appeals/:id/withdraw", requireAuth, async (req, res) => {
  res.json(await withdrawAppeal(req.actor!.id, id(req.params.id)));
});
router.post("/orders/:id/dispute/evidence", requireAuth, async (req, res) => {
  res.status(201).json(await addDisputeEvidence(req.actor!.id, id(req.params.id), DisputeEvidenceBody.parse(req.body)));
});

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};
router.get("/admin/appeals", requireAuth, requireAdmin, async (_req, res) => {
  res.json(await appealQueue());
});
router.post("/admin/appeals/:id/decision", requireAuth, requireAdmin, async (req, res) => {
  res.json(await decideAppeal(req.actor!.id, id(req.params.id), AppealDecisionBody.parse(req.body)));
});

export default router;
