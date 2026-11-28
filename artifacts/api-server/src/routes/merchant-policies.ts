/**
 * Merchant policies (M1). Every route is scoped to a business the actor owns or was granted
 * scopes in (404 otherwise). Sensitive confirmations come from the review card; high-risk ones also
 * need a fresh sign-in, read from the current session row on the server.
 */
import { Router, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, MERCHANT_POLICY_SCOPES, sessions } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { cancelProposal, confirmPolicy, listPolicies, policyHistory, proposePolicy, revokePolicy, setGrant } from "../lib/merchant-policies/engine";

const router = Router();
const id = (value: unknown) => String(value).slice(0, 80);
const noStore: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  next();
};
async function sessionIssuedAt(req: any): Promise<Date | null> {
  if (!req.sessionHash) return null;
  const [row] = await db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, req.sessionHash));
  return row?.createdAt ?? null;
}

router.get("/businesses/:businessId/merchant-policies", requireAuth, noStore, async (req, res) => {
  res.json(await listPolicies({ actorId: req.actor!.id, businessId: id(req.params.businessId) }));
});
router.get("/businesses/:businessId/merchant-policies/history", requireAuth, noStore, async (req, res) => {
  res.json({ events: await policyHistory({ actorId: req.actor!.id, businessId: id(req.params.businessId) }) });
});
router.post("/businesses/:businessId/merchant-policies/proposals", requireAuth, noStore, async (req, res) => {
  const body = z
    .object({
      kind: z.string().min(2).max(40),
      scope: z.object({ kind: z.enum(["STORE", "PRODUCT", "CATEGORY", "REGION"]), ref: z.string().max(120).nullish() }).strict().optional(),
      rule: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(req.body);
  res.status(201).json(await proposePolicy({ actorId: req.actor!.id, businessId: id(req.params.businessId), kind: body.kind, scope: body.scope ? { kind: body.scope.kind, ref: body.scope.ref ?? null } : undefined, rule: body.rule, source: "API" }));
});
router.post("/merchant-policies/:policyId/confirm", requireAuth, noStore, async (req, res) => {
  const body = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(req.body);
  res.json(await confirmPolicy({ actorId: req.actor!.id, policyId: id(req.params.policyId), expectedVersion: body.expectedVersion, channel: "REVIEW_CARD", sessionIssuedAt: await sessionIssuedAt(req) }));
});
router.post("/merchant-policies/:policyId/cancel", requireAuth, noStore, async (req, res) => {
  res.json(await cancelProposal({ actorId: req.actor!.id, policyId: id(req.params.policyId) }));
});
router.post("/merchant-policies/:policyId/revoke", requireAuth, noStore, async (req, res) => {
  const body = z.object({ reason: z.string().min(3).max(300) }).strict().parse(req.body);
  res.json(await revokePolicy({ actorId: req.actor!.id, policyId: id(req.params.policyId), reason: body.reason, sessionIssuedAt: await sessionIssuedAt(req) }));
});
router.put("/businesses/:businessId/merchant-policy-grants/:userId", requireAuth, noStore, async (req, res) => {
  const body = z.object({ scopes: z.array(z.enum(MERCHANT_POLICY_SCOPES)).max(MERCHANT_POLICY_SCOPES.length) }).strict().parse(req.body);
  res.json(await setGrant({ actorId: req.actor!.id, businessId: id(req.params.businessId), granteeUserId: id(req.params.userId), scopes: body.scopes }));
});

export default router;
