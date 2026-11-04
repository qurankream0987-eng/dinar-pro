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
import {
  connectError,
  externalDestination,
} from "../connect/provider-registry";
import * as partners from "../connect/partners";
import {
  assertConnectTestDependencyInjection,
  publicConnectAddresses,
} from "../connect/network";
import { authenticateProviderKey } from "../lib/provider-connections";
import { markets } from "@workspace/db";
import { resolveMarket } from "../lib/markets";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
const router = Router();
router.get("/admin/connect/review", requireAuth, async (req, res) =>
  res.json(await partners.connectReviewQueue(req.actor!, await marketFor(req))),
);
const idParam = (value: unknown) => z.string().uuid().parse(value);
function dnsFor(req: import("express").Request) {
  if (req.app.locals.connectDns) assertConnectTestDependencyInjection();
  return req.app.locals.connectDns;
}
router.get("/connect/partners", requireAuth, async (req, res) =>
  res.json(
    await partners.listConnectPartners(
      req.actor!.id,
      (await marketFor(req)).id,
    ),
  ),
);
router.post("/connect/partners", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  const registered = await partners.registerConnectPartner(
    req.actor!.id,
    market,
    req.body,
  );
  res
    .status(201)
    .json(await partners.partnerView(req.actor!.id, market.id, registered.id));
});
router.get("/connect/partners/:id", requireAuth, async (req, res) =>
  res.json(
    await partners.partnerView(
      req.actor!.id,
      (await marketFor(req)).id,
      idParam(req.params.id),
    ),
  ),
);
router.post("/connect/partners/:id/sites", requireAuth, async (req, res) =>
  res
    .status(201)
    .json(
      await partners.createConnectSite(
        req.actor!.id,
        await marketFor(req),
        idParam(req.params.id),
        req.body,
      ),
    ),
);
router.post("/connect/sites/:id/verify", requireAuth, async (req, res) =>
  res.json(
    await partners.verifyConnectSite(
      req.actor!.id,
      await marketFor(req),
      idParam(req.params.id),
      dnsFor(req),
    ),
  ),
);
router.post("/connect/partners/:id/submit", requireAuth, async (req, res) =>
  res.json(
    await partners.submitConnectPartner(
      req.actor!.id,
      await marketFor(req),
      idParam(req.params.id),
    ),
  ),
);
router.post(
  "/admin/connect/partners/:id/review",
  requireAuth,
  async (req, res) =>
    res.json(
      await partners.reviewConnectPartner(
        req.actor!,
        await marketFor(req),
        idParam(req.params.id),
        req.body,
      ),
    ),
);
router.post(
  "/connect/partners/:id/integrations",
  requireAuth,
  async (req, res) =>
    res
      .status(201)
      .json(
        await partners.createConnectIntegration(
          req.actor!.id,
          await marketFor(req),
          idParam(req.params.id),
          req.body,
        ),
      ),
);
router.post(
  "/admin/connect/integrations/:id/review",
  requireAuth,
  async (req, res) =>
    res.json(
      await partners.reviewConnectIntegration(
        req.actor!,
        await marketFor(req),
        idParam(req.params.id),
        req.body,
        dnsFor(req),
      ),
    ),
);
router.post(
  "/connect/integrations/:id/credentials",
  requireAuth,
  async (req, res) =>
    res
      .status(201)
      .json(
        await partners.issueConnectCredential(
          req.actor!.id,
          await marketFor(req),
          idParam(req.params.id),
        ),
      ),
);
for (const [path, status] of [
  ["suspend", "SUSPENDED"],
  ["revoke", "REVOKED"],
  ["resume", "APPROVED"],
] as const)
  router.post(
    `/connect/integrations/:id/${path}`,
    requireAuth,
    async (req, res) =>
      res.json(
        await partners.setConnectIntegrationStatus(
          req.actor!.id,
          await marketFor(req),
          idParam(req.params.id),
          status,
        ),
      ),
  );
router.post(
  "/connect/integrations/:id/catalog",
  requireAuth,
  async (req, res) =>
    res.json(
      await partners.importConnectOwnerCatalog(
        req.actor!.id,
        await marketFor(req),
        idParam(req.params.id),
        req.body,
      ),
    ),
);
router.get("/connect/catalog", requireAuth, async (req, res) =>
  res.json(
    await partners.discoverConnectCatalog(
      await marketFor(req),
      z
        .string()
        .max(120)
        .parse(req.query.search ?? ""),
    ),
  ),
);
router.post("/connect/provider/catalog", async (req, res) => {
  const context = await authenticateProviderKey(
    /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1],
  );
  const limited = await consumeRateLimit(
    [{ scope: "connect-provider-key", value: context.credentialId }],
    10,
    20,
  );
  if (limited)
    throw connectError(429, "RATE_LIMITED", "طلبات كثيرة؛ حاول لاحقًا.");
  const [row] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, context.connection.marketId));
  if (!row) throw connectError(404, "NOT_FOUND", "السوق غير موجود");
  res.json(
    await partners.importConnectProviderCatalog(
      context,
      req.body,
      await resolveMarket(row),
    ),
  );
});
const outboundInput = z
  .object({
    resultSetId: z.string().uuid(),
    cardId: z.string().min(1).max(400),
    trackingConsent: z.literal(false).default(false),
  })
  .strict();

async function ownedResult(id: string, actorId: string, marketId: string) {
  const [row] = await db
    .select({ result: aiResultSets })
    .from(aiResultSets)
    .innerJoin(conversations, eq(conversations.id, aiResultSets.conversationId))
    .where(
      and(
        eq(aiResultSets.id, id),
        eq(conversations.ownerUserId, actorId),
        eq(aiResultSets.marketId, marketId),
      ),
    );
  if (
    !row ||
    (row.result.expiresAt && row.result.expiresAt.getTime() <= Date.now())
  )
    throw connectError(
      404,
      "CARD_UNAVAILABLE",
      "البطاقة غير متاحة أو انتهت صلاحيتها؛ أعد البحث في المحادثة.",
    );
  return row.result;
}
router.post("/connect/outbound", requireAuth, async (req, res) => {
  const body = outboundInput.parse(req.body);
  const market = await marketFor(req);
  await assertMarketLegalCapability(market.id,"BROWSING");
  if (req.actor!.status !== "ACTIVE" || !isMarketAvailable(market))
    throw connectError(
      403,
      "CONNECTION_UNAVAILABLE",
      "هذه الإحالة غير متاحة في سياق الحساب الحالي.",
    );
  const limited = await consumeRateLimit(
    [{ scope: "connect-outbound-actor", value: req.actor!.id }],
    60,
    20,
  );
  if (limited)
    throw connectError(429, "RATE_LIMITED", "طلبات كثيرة؛ حاول لاحقًا.");
  const source = await ownedResult(body.resultSetId, req.actor!.id, market.id);
  if (source.query.kind !== "CONNECT")
    throw connectError(404, "CARD_UNAVAILABLE", "بطاقة الإحالة غير موجودة.");
  const payload = UniversalCardsPayloadSchema.parse(
    source.query.universalCards,
  );
  const card = payload.cards.find((card) => card.id === body.cardId);
  if (
    !card ||
    card.commerceMode !== "EXTERNAL_REFERRAL" ||
    card.externalActions.length !== 1 ||
    card.externalActions[0]!.targetId !== body.cardId
  )
    throw connectError(
      404,
      "CARD_UNAVAILABLE",
      "هذه البطاقة لا تمنح إجراء إحالة خارجيًا.",
    );
  let destinationRecord: Record<string, string>;
  if (card.domain) {
    const domain = normalizeDomain(card.domain.domain);
    externalDestination(card.domain.providerId, domain);
    destinationRecord = { providerId: card.domain.providerId, domain };
  } else {
    await db.transaction(async (tx) => {
      const ready = await partners.approvedConnectOffer(
        tx,
        idParam(card.id),
        market,
      );
      if (ready.partner.id !== card.providerId)
        throw connectError(404, "CARD_UNAVAILABLE", "مصدر البطاقة غير متاح");
      partners.connectOfferDestination(
        ready.integration,
        ready.site,
        ready.offer.targetPath,
      );
    });
    destinationRecord = { providerId: card.providerId!, offerId: card.id };
  }
  const id = randomUUID();
  // Reuse the existing owner-scoped, expiring conversation record infrastructure.
  // This is a navigation capability, not an order, pending purchase or commission event.
  await db
    .insert(aiResultSets)
    .values({
      id,
      conversationId: source.conversationId,
      marketId: source.marketId,
      messageId: source.messageId,
      query: {
        kind: "CONNECT_OUTBOUND",
        ...destinationRecord,
        sourceResultSetId: source.id,
        sourceCardId: card.id,
      },
      resourceIds: [],
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
  res
    .status(201)
    .set("Cache-Control", "no-store")
    .json({
      openPath: `/api/connect/outbound/${id}`,
      tracking: "NOT_TRACKED",
      checkoutLocation: "EXTERNAL",
      internalOrderCreated: false,
    });
});
router.get("/connect/outbound/:id", requireAuth, async (req, res) => {
  if (Object.keys(req.query).length)
    throw connectError(
      400,
      "UNSAFE_EXTERNAL_URL",
      "لا تُقبل معاملات إعادة توجيه في رابط الإحالة.",
    );
  const market = await marketFor(req);
  await assertMarketLegalCapability(market.id,"BROWSING");
  const id = z.string().uuid().parse(req.params.id);
  if (req.actor!.status !== "ACTIVE" || !isMarketAvailable(market))
    throw connectError(
      403,
      "CONNECTION_UNAVAILABLE",
      "الإحالة غير متاحة حاليًا.",
    );
  const link = await ownedResult(id, req.actor!.id, market.id);
  if (
    link.query.kind !== "CONNECT_OUTBOUND" ||
    typeof link.query.providerId !== "string"
  )
    throw connectError(404, "CARD_UNAVAILABLE", "الرابط غير موجود.");
  await ownedResult(
    String(link.query.sourceResultSetId),
    req.actor!.id,
    market.id,
  );
  let target: string;
  if (typeof link.query.domain === "string")
    target = externalDestination(
      link.query.providerId,
      normalizeDomain(link.query.domain),
    );
  else {
    const destination = await db.transaction(async (tx) => {
      const ready = await partners.approvedConnectOffer(
        tx,
        idParam(link.query.offerId),
        market,
      );
      if (ready.partner.id !== link.query.providerId)
        throw connectError(404, "CARD_UNAVAILABLE", "مصدر البطاقة غير متاح");
      return {
        url: partners.connectOfferDestination(
          ready.integration,
          ready.site,
          ready.offer.targetPath,
        ),
        host: ready.site.hostname,
      };
    });
    await publicConnectAddresses(destination.host, dnsFor(req));
    target = destination.url;
  }
  res
    .set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    })
    .redirect(303, target);
});
export default router;
