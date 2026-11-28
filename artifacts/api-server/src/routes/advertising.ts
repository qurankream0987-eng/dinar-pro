/**
 * Welcome-screen sponsored cards and buyer-authorised demand requests («نبّهني إذا توفر»).
 * Every route is the signed-in user's own data; another user's ids are 404.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import { majorToMinor } from "../lib/commercial-policy";
import { dismissWelcomeCards, displayPlacementCards, displayPlacementEngagement, welcomeSponsoredCards } from "../lib/welcome-ads";
import {
  DEMAND_REQUEST_DISCLOSURE,
  deleteDemandRequest,
  demandCampaignReach,
  listDemandMatches,
  listDemandRequests,
  optOutDemandRequest,
  saveDemandRequest,
} from "../lib/demand-requests";

const router = Router();
const id = z.string().uuid();

/** `key`: the empty conversation's id, or the client's nonce for the new-conversation screen. */
router.get("/ai/welcome-sponsored", requireAuth, async (req, res) => {
  const query = z.object({ key: id, conversationId: id.optional() }).strict().parse(req.query);
  const result = await welcomeSponsoredCards({ actorId: req.actor!.id, welcomeKey: query.key, conversationId: query.conversationId, market: await marketFor(req) });
  res.set("Cache-Control", "no-store").json(result);
});

// Jassim Ads Phase 1: hero carousel and sidebar card. Signed-out visitors allowed (owner decision);
// selection is non-personal and returns nothing unless DINAR_JASSIM_ADS is on.
router.get("/ads/placements", async (req, res) => {
  const query = z.object({ slot: z.enum(["HERO", "SIDEBAR"]), categoryId: z.string().min(1).max(80).optional() }).strict().parse(req.query);
  const result = await displayPlacementCards({ placement: query.slot, market: await marketFor(req), viewerId: req.actor?.id, categoryId: query.categoryId });
  res.set("Cache-Control", "no-store").json(result);
});

// 0084: a click on a hero/sidebar card (listing or store), recorded server-side; returns where to go.
router.post("/ads/placements/engagement", async (req, res) => {
  const body = z.object({ slot: z.enum(["HERO", "SIDEBAR"]), promotionId: z.string().uuid(), kind: z.enum(["LISTING", "STORE"]) }).strict().parse(req.body);
  res.json(await displayPlacementEngagement({ placement: body.slot, promotionId: body.promotionId, kind: body.kind, market: await marketFor(req), viewerId: req.actor?.id }));
});

router.post("/ai/welcome-sponsored/dismiss", requireAuth, async (req, res) => {
  const body = z.object({ key: id }).strict().parse(req.body);
  res.json(await dismissWelcomeCards({ actorId: req.actor!.id, welcomeKey: body.key }));
});

router.get("/demand-requests/disclosure", (_req, res) => {
  res.json({ disclosure: DEMAND_REQUEST_DISCLOSURE });
});

router.post("/demand-requests", requireAuth, async (req, res) => {
  const body = z.object({
    needText: z.string().trim().min(2).max(200),
    city: z.string().trim().min(2).max(60).optional(),
    priceMax: z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/).optional(),
    categoryId: z.string().min(1).max(80).optional(),
    consent: z.literal(true),
  }).strict().parse(req.body);
  const market = await marketFor(req);
  const priceMaxMinor = body.priceMax ? majorToMinor(Number(body.priceMax), market.minorUnitScale) : undefined;
  if (priceMaxMinor !== undefined && !Number.isSafeInteger(priceMaxMinor)) throw Object.assign(new Error("سعر غير صالح"), { status: 400, expose: true });
  res.status(201).json(await saveDemandRequest({ buyerId: req.actor!.id, market, needText: body.needText, city: body.city, priceMaxMinor, categoryId: body.categoryId, consent: body.consent }));
});

router.get("/demand-requests", requireAuth, async (req, res) => {
  res.json({ requests: await listDemandRequests(req.actor!.id) });
});

router.get("/demand-requests/matches", requireAuth, async (req, res) => {
  res.json({ matches: await listDemandMatches(req.actor!.id, await marketFor(req)) });
});

router.post("/demand-requests/:requestId/opt-out", requireAuth, async (req, res) => {
  res.json(await optOutDemandRequest(req.actor!.id, id.parse(req.params.requestId)));
});

router.delete("/demand-requests/:requestId", requireAuth, async (req, res) => {
  res.json(await deleteDemandRequest(req.actor!.id, id.parse(req.params.requestId)));
});

router.get("/promotions/:promotionId/demand-reach", requireAuth, async (req, res) => {
  res.json(await demandCampaignReach(req.actor!.id, id.parse(req.params.promotionId)));
});

export default router;
