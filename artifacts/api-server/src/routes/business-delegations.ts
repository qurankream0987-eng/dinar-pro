import { Router } from "express";
import { z } from "zod";
import {
  ActivateBusinessDelegationBody,
  ActivateBusinessDelegationResponse,
  CreateBusinessDelegationBody,
  CreateBusinessDelegationResponse,
  GetDelegatedBusinessCatalogResponse,
  ListBusinessDelegationsResponse,
  ResumeBusinessDelegationBody,
  ResumeBusinessDelegationResponse,
  RevokeBusinessDelegationBody,
  RevokeBusinessDelegationResponse,
  SuspendBusinessDelegationBody,
  SuspendBusinessDelegationResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import {
  activateBusinessDelegation,
  createBusinessDelegation,
  delegatedBusinessCatalog,
  listBusinessDelegations,
  resumeBusinessDelegation,
  revokeBusinessDelegation,
  suspendBusinessDelegation,
} from "../lib/business-delegations";

const router = Router();
const id = (value: unknown) => z.string().uuid().parse(String(value ?? ""));

router.get("/business/profiles/:id/delegations", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  res.setHeader("Cache-Control", "no-store");
  const result = await listBusinessDelegations({
    actorId: req.actor!.id,
    marketId: market.id,
    businessId: id(req.params.id),
  });
  res.json(ListBusinessDelegationsResponse.parse(result));
});

router.post("/business/profiles/:id/delegations", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  CreateBusinessDelegationBody.parse(req.body);
  const result = await createBusinessDelegation({
    actorId: req.actor!.id,
    marketId: market.id,
    businessId: id(req.params.id),
    body: req.body,
  });
  res.status(result.created ? 201 : 200).json(CreateBusinessDelegationResponse.parse(result));
});

router.post("/business/profiles/:id/delegations/:delegationId/activate", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  const result = await activateBusinessDelegation({
    actorId: req.actor!.id,
    marketId: market.id,
    businessId: id(req.params.id),
    delegationId: id(req.params.delegationId),
    body: ActivateBusinessDelegationBody.parse(req.body),
  });
  res.json(ActivateBusinessDelegationResponse.parse(result));
});

router.post("/business/profiles/:id/delegations/:delegationId/suspend", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  const result = await suspendBusinessDelegation({
    actorId: req.actor!.id,
    marketId: market.id,
    businessId: id(req.params.id),
    delegationId: id(req.params.delegationId),
    body: SuspendBusinessDelegationBody.parse(req.body),
  });
  res.json(SuspendBusinessDelegationResponse.parse(result));
});

router.post("/business/profiles/:id/delegations/:delegationId/resume", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  const result = await resumeBusinessDelegation({
    actorId: req.actor!.id,
    marketId: market.id,
    businessId: id(req.params.id),
    delegationId: id(req.params.delegationId),
    body: ResumeBusinessDelegationBody.parse(req.body),
  });
  res.json(ResumeBusinessDelegationResponse.parse(result));
});

router.post("/business/profiles/:id/delegations/:delegationId/revoke", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  const result = await revokeBusinessDelegation({
    actorId: req.actor!.id,
    marketId: market.id,
    businessId: id(req.params.id),
    delegationId: id(req.params.delegationId),
    body: RevokeBusinessDelegationBody.parse(req.body),
  });
  res.json(RevokeBusinessDelegationResponse.parse(result));
});

router.get("/business/delegations/:delegationId/catalog", requireAuth, async (req, res): Promise<void> => {
  const market = await marketFor(req);
  res.setHeader("Cache-Control", "no-store");
  const result = await delegatedBusinessCatalog({
    delegationId: id(req.params.delegationId),
    marketId: market.id,
    principal: { type: "HUMAN", userId: req.actor!.id },
  });
  res.json(GetDelegatedBusinessCatalogResponse.parse(result));
});

export default router;
