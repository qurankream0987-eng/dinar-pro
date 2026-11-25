/** Smart store cards: issue from Jassim listings, read, and apply browser events (owner only). */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import { handleSmartStoreEvent, issueSmartStoreCard, readSmartStoreCard, smartStoreCardForMessage } from "../lib/smart-store-cards";

const router = Router();
const uuid = z.string().uuid();

router.post("/smart-store/cards", requireAuth, async (req, res) => {
  const body = z
    .object({ listingIds: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/)).min(1).max(24), conversationId: z.string().min(1).max(80).optional(), understood: z.array(z.string().min(1).max(60)).max(8).optional() })
    .strict()
    .parse(req.body);
  res.status(201).set("Cache-Control", "no-store").json(await issueSmartStoreCard({ actorId: req.actor!.id, market: await marketFor(req), ...body }));
});
router.get("/smart-store/cards", requireAuth, async (req, res) => {
  const messageId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/).parse(req.query.messageId);
  res.set("Cache-Control", "no-store").json({ card: await smartStoreCardForMessage(req.actor!.id, messageId) });
});
router.get("/smart-store/cards/:id", requireAuth, async (req, res) => {
  res.set("Cache-Control", "no-store").json(await readSmartStoreCard(req.actor!.id, uuid.parse(req.params.id)));
});
router.post("/smart-store/cards/:id/events", requireAuth, async (req, res) => {
  const cardId = uuid.parse(req.params.id);
  if (!req.body || typeof req.body !== "object" || (req.body as { cardId?: unknown }).cardId !== cardId) {
    res.status(400).json({ error: "تحقق من البيانات المدخلة" });
    return;
  }
  const result = await handleSmartStoreEvent({ actorId: req.actor!.id, market: await marketFor(req), event: req.body });
  res.status("stale" in result && result.stale ? 409 : 200).set("Cache-Control", "no-store").json(result);
});

export default router;
