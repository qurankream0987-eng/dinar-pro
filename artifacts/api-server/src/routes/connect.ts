import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { aiResultSets, conversations, db } from "@workspace/db";
import { UniversalCardsPayloadSchema } from "@workspace/api-zod/connect";
import { requireAuth } from "../lib/auth";
import { consumeRateLimit } from "../lib/auth-rate-limiter";
import { marketFor, isMarketAvailable } from "../lib/markets";
import { normalizeDomain } from "../connect/domains";
import { connectError, externalDestination } from "../connect/provider-registry";
const router = Router();
const outboundInput = z.object({ resultSetId: z.string().uuid(), cardId: z.string().min(1).max(400), trackingConsent: z.literal(false).default(false) }).strict();

async function ownedResult(id: string, actorId: string, marketId: string) {
  const [row] = await db.select({ result: aiResultSets }).from(aiResultSets).innerJoin(conversations, eq(conversations.id, aiResultSets.conversationId)).where(and(eq(aiResultSets.id, id), eq(conversations.ownerUserId, actorId), eq(aiResultSets.marketId, marketId)));
  if (!row || (row.result.expiresAt && row.result.expiresAt.getTime() <= Date.now())) throw connectError(404, "CARD_UNAVAILABLE", "البطاقة غير متاحة أو انتهت صلاحيتها؛ أعد البحث في المحادثة.");
  return row.result;
}
router.post("/connect/outbound", requireAuth, async (req, res) => {
  const body = outboundInput.parse(req.body); const market = await marketFor(req);
  if (req.actor!.status !== "ACTIVE" || !isMarketAvailable(market)) throw connectError(403, "CONNECTION_UNAVAILABLE", "هذه الإحالة غير متاحة في سياق الحساب الحالي.");
  const limited = await consumeRateLimit([{ scope: "connect-outbound-actor", value: req.actor!.id }], 60, 20);
  if (limited) throw connectError(429, "RATE_LIMITED", "طلبات كثيرة؛ حاول لاحقًا.");
  const source = await ownedResult(body.resultSetId, req.actor!.id, market.id);
  if (source.query.kind !== "CONNECT") throw connectError(404, "CARD_UNAVAILABLE", "بطاقة الإحالة غير موجودة.");
  const payload = UniversalCardsPayloadSchema.parse(source.query.universalCards);
  const card = payload.cards.find(card => card.id === body.cardId);
  if (!card || card.commerceMode !== "EXTERNAL_REFERRAL" || !card.domain || card.externalActions.length !== 1 || card.externalActions[0]!.targetId !== body.cardId) throw connectError(404, "CARD_UNAVAILABLE", "هذه البطاقة لا تمنح إجراء إحالة خارجيًا.");
  const domain = normalizeDomain(card.domain.domain);
  externalDestination(card.domain.providerId, domain);
  const id = randomUUID();
  // Reuse the existing owner-scoped, expiring conversation record infrastructure.
  // This is a navigation capability, not an order, pending purchase or commission event.
  await db.insert(aiResultSets).values({ id, conversationId: source.conversationId, marketId: source.marketId, messageId: source.messageId, query: { kind: "CONNECT_OUTBOUND", providerId: card.domain.providerId, domain, sourceResultSetId: source.id, sourceCardId: card.id }, resourceIds: [], expiresAt: new Date(Date.now() + 5 * 60_000) });
  res.status(201).set("Cache-Control", "no-store").json({ openPath: `/api/connect/outbound/${id}`, tracking: "NOT_TRACKED", checkoutLocation: "EXTERNAL", internalOrderCreated: false });
});
router.get("/connect/outbound/:id", requireAuth, async (req, res) => {
  if (Object.keys(req.query).length) throw connectError(400, "UNSAFE_EXTERNAL_URL", "لا تُقبل معاملات إعادة توجيه في رابط الإحالة.");
  const market = await marketFor(req); const id = z.string().uuid().parse(req.params.id);
  if (req.actor!.status !== "ACTIVE" || !isMarketAvailable(market)) throw connectError(403, "CONNECTION_UNAVAILABLE", "الإحالة غير متاحة حاليًا.");
  const link = await ownedResult(id, req.actor!.id, market.id);
  if (link.query.kind !== "CONNECT_OUTBOUND" || typeof link.query.providerId !== "string" || typeof link.query.domain !== "string") throw connectError(404, "CARD_UNAVAILABLE", "الرابط غير موجود.");
  await ownedResult(String(link.query.sourceResultSetId), req.actor!.id, market.id);
  const target = externalDestination(link.query.providerId, normalizeDomain(link.query.domain));
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }).redirect(303, target);
});
export default router;
