import { Router, type RequestHandler } from "express";
import {
  CreateAdminSecurityIncidentBody,
  CreateAdminSecurityIncidentResponse,
  GetAdminSecurityIncidentParams,
  GetAdminSecurityIncidentResponse,
  ListAdminSecurityIncidentsQueryParams,
  ListAdminSecurityIncidentsResponse,
  TransitionAdminSecurityIncidentBody,
  TransitionAdminSecurityIncidentParams,
  TransitionAdminSecurityIncidentResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import {
  createSecurityIncident,
  getSecurityIncident,
  listSecurityIncidents,
  transitionSecurityIncident,
} from "../lib/d16-readiness";

const router = Router();
const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

router.use("/admin/security/incidents", requireAuth, requireAdmin);

router.get("/admin/security/incidents", async (req, res) => {
  const query = ListAdminSecurityIncidentsQueryParams.parse(req.query);
  res.json(
    ListAdminSecurityIncidentsResponse.parse(
      await listSecurityIncidents(query.status),
    ),
  );
});

router.post("/admin/security/incidents", async (req, res) => {
  const body = CreateAdminSecurityIncidentBody.parse(req.body);
  res.status(201).json(
    CreateAdminSecurityIncidentResponse.parse(
      await createSecurityIncident({
        actorId: req.actor!.id,
        ...body,
        affectedSystems: body.affectedSystems ?? [],
        detectedAt: body.detectedAt?.toISOString(),
      }),
    ),
  );
});

router.get("/admin/security/incidents/:id", async (req, res) => {
  const params = GetAdminSecurityIncidentParams.parse(req.params);
  res.json(
    GetAdminSecurityIncidentResponse.parse(
      await getSecurityIncident(params.id),
    ),
  );
});

router.post("/admin/security/incidents/:id/transition", async (req, res) => {
  const params = TransitionAdminSecurityIncidentParams.parse(req.params);
  const body = TransitionAdminSecurityIncidentBody.parse(req.body);
  res.json(
    TransitionAdminSecurityIncidentResponse.parse(
      await transitionSecurityIncident({
        actorId: req.actor!.id,
        id: params.id,
        ...body,
      }),
    ),
  );
});

export default router;
