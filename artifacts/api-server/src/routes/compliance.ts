/**
 * Wave 09 compliance API: policy lifecycle + explicit consent, age/guardian declarations,
 * seller verification and the legal-entity registry. Wording stays PENDING_LEGAL_APPROVAL and
 * nothing here records an approval, a verified seller or a guardian consent on its own.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { DEFAULT_MARKET } from "@workspace/global";
import { requireAuth } from "../lib/auth";
import {
  LEGAL_ENTITY_CAPABILITIES,
  activateLegalEntity,
  createLegalEntity,
  deactivateLegalEntity,
  declareAgeStatus,
  decideSellerVerification,
  listLegalEntities,
  marketComplianceOverview,
  minorProtectionStatus,
  recordGuardianConsent,
  sellerVerificationQueue,
  sellerVerificationStatus,
  submitSellerVerification,
  complianceSettings,
  updateComplianceSettings,
  legalEntityFor,
  legalEntityView,
} from "../lib/compliance";
import {
  listPolicyConsentEvents,
  listPolicyRegistry,
  policyConsentStatus,
  recordPolicyDecision,
  registerPolicyVersion,
  transitionPolicyVersion,
} from "../lib/policy-lifecycle";

const router = Router();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

function actorMarket(req: any) {
  return req.actor?.activeMarketId ?? DEFAULT_MARKET;
}

// ─── Market transparency ─────────────────────────────────────────────────────

router.get("/markets/:marketId/compliance", async (req, res) => {
  const settings = await complianceSettings(String(req.params.marketId));
  // Public surface: safeguards that affect a person, without internal actor or entity details.
  res.json({
    marketId: settings.marketId,
    sellerVerificationRequired: settings.sellerVerificationRequired,
    minorProtectionEnabled: settings.minorProtectionEnabled,
    minimumAge: settings.minimumAge,
    guardianConsentRequired: settings.guardianConsentRequired,
    legalEntityRequired: settings.legalEntityRequired,
    commercialActivation: "REQUIRES_OWNER_AUTHORIZATION",
  });
});

// ─── Policies and consent ────────────────────────────────────────────────────

router.get("/account/policy-consents", requireAuth, async (req, res) => {
  res.json({
    status: await policyConsentStatus(req.actor!.id),
    events: await listPolicyConsentEvents(req.actor!.id),
  });
});

const DecisionBody = z
  .object({
    key: z.string().min(2).max(60),
    version: z.string().min(1).max(40),
    decision: z.enum(["ACCEPTED", "DECLINED"]),
    source: z.enum(["POLICY_REVIEW", "API"]).default("POLICY_REVIEW"),
    idempotencyKey: IdempotencyKey,
  })
  .strict();

router.post("/account/policy-decisions", requireAuth, async (req, res) => {
  const body = DecisionBody.parse(req.body);
  const { event, created } = await recordPolicyDecision({
    userId: req.actor!.id,
    key: body.key,
    version: body.version,
    decision: body.decision,
    source: body.source,
    idempotencyKey: body.idempotencyKey,
  });
  res.status(created ? 201 : 200).json(event);
});

// ─── Age and guardian ────────────────────────────────────────────────────────

router.get("/account/compliance", requireAuth, async (req, res) => {
  const marketId =
    typeof req.query.marketId === "string" && req.query.marketId.length <= 32
      ? req.query.marketId
      : actorMarket(req);
  res.json({
    marketId,
    policies: await policyConsentStatus(req.actor!.id),
    minorProtection: await minorProtectionStatus(req.actor!.id, marketId),
    sellerVerification: await sellerVerificationStatus(req.actor!.id, marketId),
  });
});

const AgeBody = z
  .object({
    marketId: z.string().min(2).max(32),
    declaredStatus: z.enum(["ADULT", "MINOR"]),
    idempotencyKey: IdempotencyKey,
  })
  .strict();

router.post("/account/age-declaration", requireAuth, async (req, res) => {
  const body = AgeBody.parse(req.body);
  const { declaration, created } = await declareAgeStatus({
    userId: req.actor!.id,
    marketId: body.marketId,
    declaredStatus: body.declaredStatus,
    idempotencyKey: body.idempotencyKey,
  });
  res.status(created ? 201 : 200).json(declaration);
});

const GuardianBody = z
  .object({
    userId: z.string().min(1).max(64),
    marketId: z.string().min(2).max(32),
    decision: z.enum(["GRANTED", "DENIED"]),
    guardianReference: z.string().trim().min(3).max(200),
    idempotencyKey: IdempotencyKey,
  })
  .strict();

router.post("/account/guardian-consent", requireAuth, async (req, res) => {
  const body = GuardianBody.parse(req.body);
  const { declaration, created } = await recordGuardianConsent({
    guardianId: req.actor!.id,
    userId: body.userId,
    marketId: body.marketId,
    decision: body.decision,
    guardianReference: body.guardianReference,
    idempotencyKey: body.idempotencyKey,
  });
  res.status(created ? 201 : 200).json(declaration);
});

// ─── Seller verification ─────────────────────────────────────────────────────

router.get("/account/seller-verification", requireAuth, async (req, res) => {
  const marketId =
    typeof req.query.marketId === "string" && req.query.marketId.length <= 32
      ? req.query.marketId
      : actorMarket(req);
  res.json(await sellerVerificationStatus(req.actor!.id, marketId));
});

const VerificationBody = z
  .object({
    marketId: z.string().min(2).max(32),
    requestedLevel: z.enum(["BASIC", "ENHANCED"]),
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
    idempotencyKey: IdempotencyKey,
  })
  .strict();

router.post("/account/seller-verification", requireAuth, async (req, res) => {
  const body = VerificationBody.parse(req.body);
  const { profile, created } = await submitSellerVerification({
    userId: req.actor!.id,
    marketId: body.marketId,
    requestedLevel: body.requestedLevel,
    evidenceRefs: body.evidenceRefs,
    idempotencyKey: body.idempotencyKey,
  });
  res.status(created ? 201 : 200).json(profile);
});

// ─── Admin: policy registry ──────────────────────────────────────────────────

router.use("/admin/compliance", requireAuth, requireAdmin);

router.get("/admin/compliance/policies", async (_req, res) => {
  res.json(await listPolicyRegistry());
});

const RegisterBody = z
  .object({
    key: z.string().min(2).max(60),
    version: z.string().min(1).max(40),
    marketScope: z.string().min(2).max(32).optional(),
    materialChange: z.boolean().optional(),
  })
  .strict();

router.post("/admin/compliance/policies", async (req, res) => {
  const body = RegisterBody.parse(req.body);
  const { version, created } = await registerPolicyVersion({
    actorId: req.actor!.id,
    key: body.key,
    version: body.version,
    marketScope: body.marketScope,
    materialChange: body.materialChange,
  });
  res.status(created ? 201 : 200).json(version);
});

const TransitionBody = z
  .object({
    action: z.enum(["LEGAL_REVIEW", "APPROVE", "PUBLISH", "SUPERSEDE"]),
    legalReference: z.string().trim().min(3).max(200).optional(),
  })
  .strict();

router.post("/admin/compliance/policies/:id/transition", async (req, res) => {
  const body = TransitionBody.parse(req.body);
  res.json(
    await transitionPolicyVersion({
      actorId: req.actor!.id,
      id: String(req.params.id),
      action: body.action,
      legalReference: body.legalReference,
    }),
  );
});

// ─── Admin: seller verification ──────────────────────────────────────────────

router.get("/admin/compliance/seller-verifications", async (req, res) => {
  const status = z
    .enum(["PENDING", "VERIFIED", "REJECTED"])
    .safeParse(req.query.status);
  res.json(await sellerVerificationQueue(status.success ? status.data : "PENDING"));
});

const DecideBody = z
  .object({
    decision: z.enum(["VERIFIED", "REJECTED"]),
    riskBasis: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

router.post(
  "/admin/compliance/seller-verifications/:id/decision",
  async (req, res) => {
    const body = DecideBody.parse(req.body);
    res.json(
      await decideSellerVerification({
        actorId: req.actor!.id,
        id: String(req.params.id),
        decision: body.decision,
        riskBasis: body.riskBasis,
        reason: body.reason,
      }),
    );
  },
);

// ─── Admin: markets and legal entities ───────────────────────────────────────

router.get("/admin/compliance/markets", async (_req, res) => {
  res.json(await marketComplianceOverview());
});

router.get("/admin/compliance/markets/:marketId", async (req, res) => {
  const marketId = String(req.params.marketId);
  const entity = await legalEntityFor(marketId);
  res.json({
    settings: await complianceSettings(marketId),
    legalEntity: entity ? legalEntityView(entity) : null,
  });
});

const SettingsBody = z
  .object({
    sellerVerificationRequired: z.boolean().optional(),
    minorProtectionEnabled: z.boolean().optional(),
    minimumAge: z.number().int().min(13).max(21).optional(),
    guardianConsentRequired: z.boolean().optional(),
    legalEntityRequired: z.boolean().optional(),
  })
  .strict();

router.put("/admin/compliance/markets/:marketId", async (req, res) => {
  const body = SettingsBody.parse(req.body);
  if (!Object.keys(body).length)
    throw fail(400, "لا يوجد أي تغيير مطلوب");
  res.json(
    await updateComplianceSettings({
      actorId: req.actor!.id,
      marketId: String(req.params.marketId),
      patch: body,
    }),
  );
});

router.get("/admin/compliance/legal-entities", async (_req, res) => {
  res.json(await listLegalEntities());
});

const EntityBody = z
  .object({
    marketId: z.string().min(2).max(32),
    legalName: z.string().trim().min(2).max(200),
    entityType: z.enum(["COMPANY", "INDIVIDUAL", "PARTNERSHIP"]),
    registrationCountry: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

router.post("/admin/compliance/legal-entities", async (req, res) => {
  const body = EntityBody.parse(req.body);
  res
    .status(201)
    .json(await createLegalEntity({ actorId: req.actor!.id, ...body }));
});

const ActivateBody = z
  .object({ capabilities: z.array(z.enum(LEGAL_ENTITY_CAPABILITIES)).min(1) })
  .strict();

router.post(
  "/admin/compliance/legal-entities/:marketId/activate",
  async (req, res) => {
    const body = ActivateBody.parse(req.body);
    res.json(
      await activateLegalEntity({
        actorId: req.actor!.id,
        marketId: String(req.params.marketId),
        capabilities: body.capabilities,
      }),
    );
  },
);

router.post(
  "/admin/compliance/legal-entities/:marketId/deactivate",
  async (req, res) => {
    res.json(
      await deactivateLegalEntity({
        actorId: req.actor!.id,
        marketId: String(req.params.marketId),
      }),
    );
  },
);

export default router;
