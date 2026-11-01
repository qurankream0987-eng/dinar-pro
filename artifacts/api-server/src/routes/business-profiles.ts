/**
 * D2 HTTP surface for DINAR Business identity. The owner is always the session's account and the
 * market its active market; a stranger gets 404 for every record and document. Review decisions
 * are ADMIN-only and come from lib/business-profiles (the single verification authority).
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import { assignListingToBusiness, businessListingAssociation } from "../lib/business-catalog-contract";
import {
  businessForReviewer,
  businessReviewQueue,
  completeDocumentUpload,
  createBusinessDraft,
  decideBusinessVerification,
  documentContentForReviewer,
  getOwnBusiness,
  isBusinessReviewer,
  listOwnBusinesses,
  publicBusiness,
  requestBusinessIntegration,
  requestDocumentUpload,
  setBusinessPublication,
  startBusinessVerification,
  submitBusinessForReview,
  updateBusinessProfile,
} from "../lib/business-profiles";

const router = Router();
const id = (value: unknown) => String(value ?? "");
const requireReviewer: RequestHandler = (req, res, next) => {
  if (!isBusinessReviewer(req.actor?.role)) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  next();
};

router.get("/business/profiles", requireAuth, async (req, res) => {
  res.json(await listOwnBusinesses(req.actor!.id, await marketFor(req)));
});
router.post("/business/profiles", requireAuth, async (req, res) => {
  const result = await createBusinessDraft(req.actor!.id, await marketFor(req), req.body);
  res.status(result.created ? 201 : 200).json(result);
});
router.get("/business/profiles/:id", requireAuth, async (req, res) => {
  res.json(await getOwnBusiness(req.actor!.id, await marketFor(req), id(req.params.id)));
});
router.patch("/business/profiles/:id", requireAuth, async (req, res) => {
  res.json(await updateBusinessProfile(req.actor!.id, await marketFor(req), id(req.params.id), req.body));
});
router.post("/business/profiles/:id/start-verification", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await startBusinessVerification(req.actor!.id, await marketFor(req), id(req.params.id)));
});
router.post("/business/profiles/:id/documents/upload-url", requireAuth, async (req, res) => {
  res.json(await requestDocumentUpload(req.actor!.id, await marketFor(req), id(req.params.id), req.body));
});
router.post("/business/profiles/:id/documents/:documentId/complete", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await completeDocumentUpload(req.actor!.id, await marketFor(req), id(req.params.id), id(req.params.documentId)));
});
router.post("/business/profiles/:id/submit", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await submitBusinessForReview(req.actor!.id, await marketFor(req), id(req.params.id)));
});
router.post("/business/profiles/:id/publication", requireAuth, async (req, res) => {
  const body = z.object({ publish: z.boolean() }).strict().parse(req.body);
  res.json(await setBusinessPublication(req.actor!.id, await marketFor(req), id(req.params.id), body.publish));
});
router.post("/business/profiles/:id/integration-requests", requireAuth, async (req, res) => {
  res.status(201).json(await requestBusinessIntegration(req.actor!.id, await marketFor(req), id(req.params.id), req.body));
});

/** Integration: link or unlink one of the owner's listings to one of the owner's businesses. */
router.post("/business/profiles/:id/listings/:listingId", requireAuth, async (req, res) => {
  const body = z.object({ linked: z.boolean() }).strict().parse(req.body);
  const market = await marketFor(req);
  await getOwnBusiness(req.actor!.id, market, id(req.params.id));
  res.json(await assignListingToBusiness({ actorId: req.actor!.id, marketId: market.id, listingId: id(req.params.listingId), businessId: body.linked ? id(req.params.id) : null, unlinkFrom: id(req.params.id) }));
});
router.get("/business/profiles/:id/listings", requireAuth, async (req, res) => {
  await getOwnBusiness(req.actor!.id, await marketFor(req), id(req.params.id));
  res.json(await businessListingAssociation(id(req.params.id)));
});

/** Public: a published, verified business only (404 for drafts, pending, rejected, suspended). */
router.get("/businesses/:id", async (req, res) => {
  res.json(await publicBusiness(id(req.params.id)));
});

router.get("/admin/business-verification", requireAuth, requireReviewer, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json(await businessReviewQueue(req.actor!, status));
});
router.get("/admin/business-verification/:id", requireAuth, requireReviewer, async (req, res) => {
  res.json(await businessForReviewer(req.actor!, id(req.params.id)));
});
router.post("/admin/business-verification/:id/decision", requireAuth, requireReviewer, async (req, res) => {
  res.json(await decideBusinessVerification(req.actor!, id(req.params.id), req.body));
});
router.get("/admin/business-verification/documents/:documentId/content", requireAuth, requireReviewer, async (req, res) => {
  const content = await documentContentForReviewer(req.actor!, id(req.params.documentId));
  res.setHeader("Content-Type", content.contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(content.bytes);
});

export default router;
