/**
 * Wave 10 trust-ops routes: support cases, fraud signals and WhatsApp readiness.
 *
 * Every /admin endpoint sits behind the same session + ADMIN check as the rest of trust & safety.
 * Users reach only their own cases and their own WhatsApp consent; a wrong case id is a 404.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import {
  AssignSupportCaseBody,
  CreateSupportCaseBody,
  StaffReplyBody,
  SupportStatusBody,
  addUserSupportMessage,
  assignSupportCase,
  createSupportCase,
  getSupportCase,
  ownSupportCases,
  queuedSupportStatus,
  staffReplyToSupportCase,
  supportQueue,
  transitionSupportCase,
} from "../lib/support-cases";
import {
  RecordFraudSignalBody,
  ReviewFraudSignalBody,
  fraudOverview,
  fraudSignalsFor,
  recordFraudSignal,
  reviewFraudSignal,
} from "../lib/fraud-signals";
import {
  CreateWhatsappTemplateBody,
  WhatsAppConsentBody,
  WhatsappIntentBody,
  WhatsappTemplateStatusBody,
  createWhatsappTemplate,
  evaluateWhatsappIntent,
  listWhatsappTemplates,
  recordWhatsAppConsent,
  transitionWhatsappTemplate,
  whatsappConsentStatus,
  whatsappOverview,
  whatsappProviderState,
} from "../lib/whatsapp-readiness";

const router = Router();

const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.actor) {
    res.status(401).json({ error: "سجّل الدخول للمتابعة" });
    return;
  }
  if (req.actor.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

const SupportMessageBody = z.object({ message: z.string().trim().min(1).max(4000) }).strict();

// ------------------------------------------------------------------ user support

router.get("/account/support/cases", requireAuth, async (req, res) => {
  res.json({ cases: await ownSupportCases(req.actor!.id) });
});

router.post("/account/support/cases", requireAuth, async (req, res) => {
  const body = CreateSupportCaseBody.parse(req.body);
  res.status(201).json({ case: await createSupportCase(req.actor!.id, body) });
});

router.get("/account/support/cases/:id", requireAuth, async (req, res) => {
  res.json(await getSupportCase({ id: req.actor!.id, role: req.actor!.role }, String(req.params.id)));
});

router.post("/account/support/cases/:id/messages", requireAuth, async (req, res) => {
  const body = SupportMessageBody.parse(req.body);
  res.status(201).json(await addUserSupportMessage(req.actor!.id, String(req.params.id), body.message));
});

// ---------------------------------------------------------------- user WhatsApp

router.get("/account/whatsapp/consent", requireAuth, async (req, res) => {
  res.json({ consent: await whatsappConsentStatus(req.actor!.id), provider: whatsappProviderState() });
});

router.post("/account/whatsapp/consent", requireAuth, async (req, res) => {
  const body = WhatsAppConsentBody.parse(req.body);
  res.status(201).json({ consent: await recordWhatsAppConsent(req.actor!.id, body) });
});

// ------------------------------------------------------------------ admin support

router.use("/admin/support", requireAuth, requireAdmin);

router.get("/admin/support/cases", async (_req, res) => {
  res.json({ cases: await supportQueue(), byStatus: await queuedSupportStatus() });
});

router.get("/admin/support/cases/:id", async (req, res) => {
  res.json(await getSupportCase({ id: req.actor!.id, role: req.actor!.role }, String(req.params.id)));
});

router.post("/admin/support/cases/:id/messages", async (req, res) => {
  const body = StaffReplyBody.parse(req.body);
  res.status(201).json(await staffReplyToSupportCase(req.actor!.id, String(req.params.id), body));
});

router.post("/admin/support/cases/:id/assign", async (req, res) => {
  const body = AssignSupportCaseBody.parse(req.body);
  res.json({ case: await assignSupportCase(req.actor!.id, String(req.params.id), body.staffId) });
});

router.post("/admin/support/cases/:id/status", async (req, res) => {
  const body = SupportStatusBody.parse(req.body);
  res.json({ case: await transitionSupportCase(req.actor!.id, String(req.params.id), body) });
});

// -------------------------------------------------------------------- admin fraud

router.use("/admin/fraud", requireAuth, requireAdmin);

router.get("/admin/fraud/signals", async (req, res) => {
  const subjectType = typeof req.query.subjectType === "string" ? req.query.subjectType : undefined;
  const subjectId = typeof req.query.subjectId === "string" ? req.query.subjectId : undefined;
  res.json({ signals: await fraudSignalsFor({ subjectType, subjectId }) });
});

router.post("/admin/fraud/signals", async (req, res) => {
  const body = RecordFraudSignalBody.parse(req.body);
  res.status(201).json(await recordFraudSignal({ ...body, createdBy: req.actor!.id }));
});

router.post("/admin/fraud/signals/:id/review", async (req, res) => {
  const body = ReviewFraudSignalBody.parse(req.body);
  res.status(201).json(await reviewFraudSignal(req.actor!.id, String(req.params.id), body));
});

router.get("/admin/fraud/overview", async (_req, res) => {
  res.json(await fraudOverview());
});

// ----------------------------------------------------------------- admin WhatsApp

router.use("/admin/whatsapp", requireAuth, requireAdmin);

router.get("/admin/whatsapp/templates", async (_req, res) => {
  res.json({ templates: await listWhatsappTemplates() });
});

router.post("/admin/whatsapp/templates", async (req, res) => {
  const body = CreateWhatsappTemplateBody.parse(req.body);
  res.status(201).json({ template: await createWhatsappTemplate(req.actor!.id, body) });
});

router.post("/admin/whatsapp/templates/:key/status", async (req, res) => {
  const body = WhatsappTemplateStatusBody.parse(req.body);
  res.json({ template: await transitionWhatsappTemplate(req.actor!.id, String(req.params.key), body) });
});

router.post("/admin/whatsapp/intents", async (req, res) => {
  const body = WhatsappIntentBody.parse(req.body);
  res.status(201).json({ intent: await evaluateWhatsappIntent(req.actor!.id, body) });
});

router.get("/admin/whatsapp/overview", async (_req, res) => {
  res.json(await whatsappOverview());
});

export default router;
