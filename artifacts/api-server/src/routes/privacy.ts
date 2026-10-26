/**
 * DINAR NEXT pre-integration: privacy rights API. Every route acts on the signed-in user's own
 * data; sensitive operations (export) re-authenticate with the current password. Admin routes
 * handle tracked requests with a mandatory reason. The conversation uses the same authority.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth, verifyPassword } from "../lib/auth";
import { AUTH_RATE_LIMIT_SCOPE, consumeRateLimit } from "../lib/auth-rate-limiter";
import {
  AdminTransitionBody,
  FileRequestBody,
  PRIVACY_REQUEST_STATUSES,
  PreferencesPatch,
  adminPrivacyQueue,
  adminTransitionPrivacyRequest,
  buildPersonalDataExport,
  fileUserPrivacyRequest,
  getPrivacyPreferences,
  listOwnPrivacyRequests,
  ownPrivacyRequest,
  personalDataSummary,
  recordPrivacyRequest,
  retentionPolicy,
  updatePrivacyPreferences,
  withdrawOwnPrivacyRequest,
} from "../lib/privacy-rights";
import { currentPolicy } from "../lib/policies";

const router = Router();
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Sensitive privacy operations share one per-user budget (fails closed when unavailable). */
const privacyLimit = (max: number): RequestHandler => async (req, res, next) => {
  try {
    const limited = await consumeRateLimit([{ scope: AUTH_RATE_LIMIT_SCOPE.privacyUser, value: `${req.actor!.id}:${req.path}` }], 3600, max);
    if (limited) {
      res.setHeader("Retry-After", String(limited.retryAfterSeconds));
      res.status(429).json({ error: "طلبات كثيرة. حاول لاحقًا." });
      return;
    }
  } catch {
    res.setHeader("Retry-After", "30");
    res.status(503).json({ error: "تعذر التحقق من المحاولات الآن. حاول لاحقًا." });
    return;
  }
  next();
};

router.get("/privacy/retention", (_req, res) => {
  res.json(retentionPolicy());
});

router.get("/account/privacy", requireAuth, async (req, res) => {
  res.json(await personalDataSummary(req.actor!.id));
});

const ExportBody = z.object({ currentPassword: z.string().min(1).max(128), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }).strict();
router.post("/account/privacy/exports", requireAuth, privacyLimit(5), async (req, res) => {
  const body = ExportBody.parse(req.body);
  if (!(await verifyPassword(body.currentPassword, req.actor!.passwordHash))) throw fail(400, "كلمة المرور الحالية غير صحيحة");
  const exported = await buildPersonalDataExport(req.actor!.id);
  const { row } = await recordPrivacyRequest({
    userId: req.actor!.id,
    kind: "EXPORT",
    channel: "API",
    idempotencyKey: body.idempotencyKey,
    completed: { outcomeCode: "EXPORT_DELIVERED", outcomeNote: "سُلّمت نسخة محدودة من بياناتك مباشرةً؛ لم تُحفظ نسخة منها على الخادم." },
  });
  res.setHeader("Content-Disposition", `attachment; filename="dinar-export-${row.id}.json"`);
  res.json({ requestId: row.id, export: exported });
});

router.get("/account/privacy/preferences", requireAuth, async (req, res) => {
  res.json(await getPrivacyPreferences(req.actor!.id));
});

router.patch("/account/privacy/preferences", requireAuth, privacyLimit(60), async (req, res) => {
  const patch = PreferencesPatch.parse(req.body);
  res.json(await updatePrivacyPreferences(req.actor!.id, patch, "API", currentPolicy("privacy")?.version));
});

router.get("/account/privacy/requests", requireAuth, async (req, res) => {
  res.json(await listOwnPrivacyRequests(req.actor!.id));
});

router.post("/account/privacy/requests", requireAuth, privacyLimit(20), async (req, res) => {
  res.status(201).json(await fileUserPrivacyRequest(req.actor!.id, FileRequestBody.parse(req.body), "API"));
});

router.get("/account/privacy/requests/:id", requireAuth, async (req, res) => {
  res.json(await ownPrivacyRequest(req.actor!.id, String(req.params.id).slice(0, 80)));
});

router.post("/account/privacy/requests/:id/withdraw", requireAuth, async (req, res) => {
  res.json(await withdrawOwnPrivacyRequest(req.actor!.id, String(req.params.id).slice(0, 80)));
});

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

router.get("/admin/privacy-requests", requireAuth, requireAdmin, async (req, res) => {
  const status = z.enum(PRIVACY_REQUEST_STATUSES).optional().parse(typeof req.query.status === "string" ? req.query.status : undefined);
  res.json(await adminPrivacyQueue(status));
});

router.post("/admin/privacy-requests/:id/status", requireAuth, requireAdmin, async (req, res) => {
  res.json(await adminTransitionPrivacyRequest(req.actor!.id, String(req.params.id).slice(0, 80), AdminTransitionBody.parse(req.body)));
});

export default router;
