import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { aiResultSets, conversations, db } from "@workspace/db";
import {
  UniversalCardsPayloadSchema,
  ConnectOutboundInputSchema,
} from "@workspace/api-zod/connect";
import { requireAuth } from "../lib/auth";
import { consumeRateLimit } from "../lib/auth-rate-limiter";
import { marketFor, isMarketAvailable } from "../lib/markets";
import { normalizeDomain } from "../connect/domains";
import {
  connectError,
  externalDestination,
} from "../connect/provider-registry";
import * as oauth from "../connect/oauth";
import { syncConnectCatalog } from "../connect/catalog-pull";
import { ConnectNetwork } from "../connect/network";
import * as sites from "../connect/sites";
import * as team from "../connect/team";
import * as partners from "../connect/partners";
import * as agreements from "../connect/agreements";
import * as apiConnector from "../connect/api-connector";
import * as binding from "../connect/binding";
import * as vault from "../connect/credential-vault";
import * as toolCards from "../connect/tool-cards";
import * as workflows from "../connect/workflows";
import { connectIntegrations as connectIntegrationsTable, connectTools } from "@workspace/db";
import { ConnectFinancialReceiptSchema } from "@workspace/api-zod/connect-platform";
import { connectDiagnostics } from "../connect/diagnostics";
import { importConnectOffer, previewConnectImport } from "../connect/catalog-import";
import { connectPartnerReport } from "../connect/reports";
import {
  receiveConnectEvent,
  financeConnectTransaction,
} from "../connect/finance";
import {
  assertConnectTestDependencyInjection,
  publicConnectAddresses,
} from "../connect/network";
import { authenticateProviderKey } from "../lib/provider-connections";
import { markets } from "@workspace/db";
import { resolveMarket } from "../lib/markets";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
const router = Router();
router.get("/connect/partners/:id/diagnostics",requireAuth,async(req,res)=>res.set("Cache-Control","no-store").json(await connectDiagnostics(req.actor!,await marketFor(req),idParam(req.params.id),req.query)));
router.get("/admin/connect/partners/:id/diagnostics",requireAuth,async(req,res)=>res.set("Cache-Control","no-store").json(await connectDiagnostics(req.actor!,await marketFor(req),idParam(req.params.id),req.query,true)));

router.get("/connect/partners/:id/team", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await team.listConnectTeam(req.actor!.id, await marketFor(req), idParam(req.params.id))));
router.post("/connect/partners/:id/team", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await team.grantConnectTeam(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body)));
router.delete("/connect/partners/:id/team/:delegationId", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await team.removeConnectTeam(req.actor!.id, await marketFor(req), idParam(req.params.id), idParam(req.params.delegationId), req.body)));
router.get("/connect/partners/:id/catalog", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await team.connectTeamCatalog(req.actor!.id, await marketFor(req), idParam(req.params.id))));
// Mode A: owner-confirmed move of one Connect catalog offer into a normal DINAR listing (free).
router.get("/connect/partners/:id/offers/:offerId/import", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await previewConnectImport({ actorId: req.actor!.id, market: await marketFor(req), partnerId: idParam(req.params.id), offerId: idParam(req.params.offerId) })));
router.post("/connect/partners/:id/offers/:offerId/import", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await importConnectOffer({ actorId: req.actor!.id, market: await marketFor(req), partnerId: idParam(req.params.id), offerId: idParam(req.params.offerId), body: req.body })));
router.get("/connect/partners/:id/report", requireAuth, async (req, res) =>
  res
    .set("Cache-Control", "no-store")
    .json(
      await connectPartnerReport(
        req.actor!,
        await marketFor(req),
        idParam(req.params.id),
        req.query,
      ),
    ),
);
router.get(
  "/admin/connect/partners/:id/report",
  requireAuth,
  async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(
        await connectPartnerReport(
          req.actor!,
          await marketFor(req),
          idParam(req.params.id),
          req.query,
          true,
        ),
      ),
);
router.post(
  "/admin/connect/partners/:id/agreements",
  requireAuth,
  async (req, res) =>
    res
      .status(201)
      .json(
        await agreements.proposeConnectAgreement(
          req.actor!,
          await marketFor(req),
          idParam(req.params.id),
          req.body,
        ),
      ),
);
router.get("/connect/partners/:id/agreements", requireAuth, async (req, res) =>
  res.json(
    await agreements.listConnectAgreements(
      req.actor!.id,
      await marketFor(req),
      idParam(req.params.id),
    ),
  ),
);
router.post("/connect/agreements/:id/accept", requireAuth, async (req, res) =>
  res.json(
    await agreements.acceptConnectAgreement(
      req.actor!.id,
      await marketFor(req),
      idParam(req.params.id),
      req.body,
    ),
  ),
);
router.get(
  "/connect/offers/:id/referral-terms",
  requireAuth,
  async (req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json(
        await agreements.connectReferralTerms(
          await marketFor(req),
          idParam(req.params.id),
        ),
      ),
);
router.post("/connect/privacy/attribution", requireAuth, async (req, res) => {
  z.object({ granted: z.literal(false) })
    .strict()
    .parse(req.body);
  res.json(await agreements.withdrawConnectAttribution(req.actor!.id));
});
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
function connectNetworkFor(req: import("express").Request) {
  const injected = req.app.locals.connectNetwork;
  if (injected) assertConnectTestDependencyInjection();
  return injected instanceof ConnectNetwork ? injected : undefined;
}
router.get("/connect/integrations/:id/oauth/status", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await oauth.connectOAuthStatus(req.actor!.id, await marketFor(req), idParam(req.params.id))));
router.post("/connect/integrations/:id/oauth/start", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await oauth.startConnectOAuth(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body)));
router.post("/connect/integrations/:id/oauth/refresh", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await oauth.refreshConnectOAuth(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body, connectNetworkFor(req))));
router.post("/connect/integrations/:id/oauth/disconnect", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await oauth.disconnectConnectOAuth(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body)));
router.get("/connect/oauth/callback", requireAuth, async (req, res) => {
  await oauth.completeConnectOAuth(req.actor!.id, await marketFor(req), req.query, connectNetworkFor(req));
  res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").redirect(303, new URL("/connect", process.env.APP_ORIGIN!).href);
});
router.post("/connect/integrations/:id/sync", requireAuth, async (req, res) => {
  res.set("Cache-Control", "no-store").json(await syncConnectCatalog(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body, connectNetworkFor(req)));
});
router.post("/connect/sites/:id/challenge", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await sites.renewConnectSiteChallenge(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body)));
router.post("/connect/sites/:id/revoke", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await sites.revokeConnectSite(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body)));
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
router.post("/connect/partners/:id/participation-mode", requireAuth, async (req, res) =>
  res.set("Cache-Control", "no-store").json(
    await partners.changeConnectParticipationMode(
      req.actor!.id,
      await marketFor(req),
      idParam(req.params.id),
      req.body,
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
async function connectProviderRequest(req: import("express").Request) {
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
  return { context, market: await resolveMarket(row) };
}
router.post("/connect/provider/events", async (req, res) => {
  const { context, market } = await connectProviderRequest(req);
  res.json(
    ConnectFinancialReceiptSchema.parse(
      await receiveConnectEvent(context, market, req.body),
    ),
  );
});
router.post(
  "/admin/connect/transactions/:id/finance",
  requireAuth,
  async (req, res) =>
    res.json(
      ConnectFinancialReceiptSchema.parse(
        await financeConnectTransaction(
          req.actor!,
          await marketFor(req),
          idParam(req.params.id),
          req.body,
        ),
      ),
    ),
);
router.post("/connect/provider/catalog", async (req, res) => {
  const { context, market } = await connectProviderRequest(req);
  res.json(
    await partners.importConnectProviderCatalog(context, req.body, market),
  );
});
const outboundInput = ConnectOutboundInputSchema;

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
  await assertMarketLegalCapability(market.id, "BROWSING");
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
  let attribution:
    { referralId: string; agreementId: string; expiresAt: string } | undefined;
  if (card.domain) {
    if (body.trackingConsent)
      throw connectError(
        409,
        "ATTRIBUTION_NOT_SUPPORTED",
        "لا يوجد اتفاق إحالة مع هذا المزوّد؛ تابع دون تتبع",
      );
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
    if (body.trackingConsent) {
      attribution = await agreements.createConnectReferral({
        actorId: req.actor!.id,
        market,
        offerId: card.id,
        conversationId: source.conversationId,
        resultSetId: source.id,
        cardId: card.id,
        expectedAgreementId: body.expectedAgreementId,
        expectedTermsDigest: body.expectedTermsDigest,
        expectedPrivacyPolicyVersion: body.expectedPrivacyPolicyVersion,
      });
      destinationRecord.referralId = attribution.referralId;
    }
  }
  const id = randomUUID();
  // Reuse the existing owner-scoped, expiring conversation record infrastructure.
  // This is a navigation capability, not an order, pending purchase or commission event.
  await db.insert(aiResultSets).values({
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
      tracking: attribution ? "CONSENTED" : "NOT_TRACKED",
      ...(attribution ?? {}),
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
  await assertMarketLegalCapability(market.id, "BROWSING");
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
      const referral =
        typeof link.query.referralId === "string"
          ? await agreements.connectReferralForNavigation(
              tx,
              idParam(link.query.referralId),
              req.actor!.id,
              ready.offer.id,
            )
          : null;
      return {
        url: partners.connectOfferDestination(
          ready.integration,
          ready.site,
          ready.offer.targetPath,
          referral?.id,
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
// ─── Stage 3: API connectors (owner only). Discovery proposes; the owner authorizes; writes need confirmation.
const toolArguments = z.record(z.string().max(64), z.unknown());
router.post("/connect/integrations/:id/api-tools", requireAuth, async (req, res) => {
  const body = z.union([
    z.object({ source: z.literal("OPENAPI"), document: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ source: z.literal("DISCOVER") }).strict(),
    z.object({ source: z.literal("GRAPHQL"), operations: z.array(z.unknown()).max(100) }).strict(),
  ]).parse(req.body);
  const market = await marketFor(req);
  const id = idParam(req.params.id);
  let proposed;
  if (body.source === "GRAPHQL") proposed = apiConnector.proposeGraphqlTools(body.operations);
  else if (body.source === "OPENAPI") proposed = apiConnector.proposeOpenApiTools(body.document);
  else {
    const [row] = await db.select().from(connectIntegrationsTable).where(eq(connectIntegrationsTable.id, id));
    if (!row?.endpointUrl) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
    await partners.connectAccess(req.actor!.id, market.id, row.partnerId, "OWNER");
    const found = await apiConnector.discoverOpenApiDocument(connectNetworkFor(req) ?? new ConnectNetwork(), row.endpointUrl);
    if (!found) throw connectError(404, "API_DESCRIPTION_NOT_FOUND", "لم يُعثر على وصف OpenAPI في المسارات المعروفة للموصل");
    proposed = apiConnector.proposeOpenApiTools(found.document);
  }
  res.status(201).json(await apiConnector.importApiTools(req.actor!.id, market, id, proposed));
});
router.get("/connect/integrations/:id/api-tools", requireAuth, async (req, res) => {
  const market = await marketFor(req);
  const id = idParam(req.params.id);
  const [row] = await db.select().from(connectIntegrationsTable).where(eq(connectIntegrationsTable.id, id));
  if (!row) throw connectError(404, "NOT_FOUND", "الموصل غير موجود");
  await partners.connectAccess(req.actor!.id, market.id, row.partnerId, "OWNER");
  const tools = await db.select().from(connectTools).where(eq(connectTools.integrationId, id));
  // The owner reviews the full operation and its digest before authorizing; credentials never appear.
  res.set("Cache-Control", "no-store").json({
    lifecycle: row.lifecycle,
    verificationFailure: row.verificationFailure,
    credential: await vault.connectCredentialStatus(id),
    grantedCapabilities: row.grantedCapabilities,
    tools: tools.map((tool) => ({ id: tool.id, name: tool.name, capability: tool.capability, access: tool.access, status: tool.status, digest: tool.inputSchemaSha256, operation: tool.operation, openToCustomers: tool.access === "READ" ? tool.publicRead : tool.customerWrite })),
  });
});
router.post("/connect/integrations/:id/capabilities", requireAuth, async (req, res) => {
  const body = z.object({ capabilities: z.array(z.string().max(16)).max(14) }).strict().parse(req.body);
  res.json(await binding.grantConnectCapabilities(req.actor!.id, await marketFor(req), idParam(req.params.id), body.capabilities));
});
router.post("/connect/integrations/:id/api-tools/:toolId/authorize", requireAuth, async (req, res) => {
  const body = z.object({ reviewedDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(req.body);
  res.json(await binding.authorizeConnectTool(req.actor!.id, await marketFor(req), idParam(req.params.id), idParam(req.params.toolId), body.reviewedDigest));
});
router.post("/connect/integrations/:id/api-tools/:toolId/revoke", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await binding.revokeConnectTool(req.actor!.id, await marketFor(req), idParam(req.params.id), idParam(req.params.toolId)));
});
router.post("/connect/integrations/:id/api-tools/call", requireAuth, async (req, res) => {
  const body = z.object({ toolName: z.string().min(1).max(64), arguments: toolArguments }).strict().parse(req.body);
  const result = await apiConnector.callConnectTool({ actorId: req.actor!.id, market: await marketFor(req), integrationId: idParam(req.params.id), toolName: body.toolName, arguments: body.arguments, network: connectNetworkFor(req) });
  res.set("Cache-Control", "no-store").status(result.status === "CONFIRMATION_REQUIRED" ? 202 : result.status === "REFUSED" ? 409 : 200).json(result);
});
// Stage 5a: the owner seals their system's key (never returned) and verifies with one read tool.
router.post("/connect/integrations/:id/credential", requireAuth, async (req, res) => {
  res.set("Cache-Control", "no-store").status(201).json(await vault.sealConnectCredential(req.actor!.id, await marketFor(req), idParam(req.params.id), req.body));
});
router.post("/connect/integrations/:id/verify", requireAuth, async (req, res) => {
  const body = z.object({ toolId: z.string().uuid(), arguments: toolArguments.optional() }).strict().parse(req.body);
  res.set("Cache-Control", "no-store").json(await vault.verifyConnectBinding(req.actor!.id, await marketFor(req), idParam(req.params.id), body, connectNetworkFor(req) ?? new ConnectNetwork()));
});
// Smart cards from the store's system: the owner maps a READ tool and may open it to customers.
router.post("/connect/integrations/:id/api-tools/:toolId/card", requireAuth, async (req, res) => {
  res.json(await toolCards.setConnectToolCard(req.actor!.id, await marketFor(req), idParam(req.params.id), idParam(req.params.toolId), req.body));
});
router.post("/connect/integrations/:id/api-tools/:toolId/customer-access", requireAuth, async (req, res) => {
  res.json(await toolCards.setConnectToolCustomerAccess(req.actor!.id, await marketFor(req), idParam(req.params.id), idParam(req.params.toolId), req.body));
});
router.post("/smart-store/cards/from-connector", requireAuth, async (req, res) => {
  const body = z.object({ integrationId: z.string().uuid(), toolId: z.string().uuid(), arguments: toolArguments.optional(), conversationId: z.string().min(1).max(80).optional() }).strict().parse(req.body);
  res.status(201).set("Cache-Control", "no-store").json(await toolCards.issueCardFromConnector({ actorId: req.actor!.id, market: await marketFor(req), ...body, network: connectNetworkFor(req) }));
});
// Multi-company workflows: proposed (nothing sent), confirmed once by the same person, run in order.
router.post("/connect/workflows", requireAuth, async (req, res) => {
  res.status(202).set("Cache-Control", "no-store").json(await workflows.proposeConnectWorkflow({ actorId: req.actor!.id, market: await marketFor(req), raw: req.body }));
});
router.post("/connect/workflows/:id/confirm", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.set("Cache-Control", "no-store").json(await workflows.confirmConnectWorkflow({ actorId: req.actor!.id, market: await marketFor(req), workflowId: idParam(req.params.id), network: connectNetworkFor(req) }));
});
router.post("/connect/workflows/:id/cancel", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await workflows.cancelConnectWorkflow({ actorId: req.actor!.id, workflowId: idParam(req.params.id) }));
});
router.post("/connect/action-confirmations/:id/confirm", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const result = await apiConnector.confirmToolCall({ actorId: req.actor!.id, market: await marketFor(req), confirmationId: idParam(req.params.id), network: connectNetworkFor(req) });
  res.set("Cache-Control", "no-store").status(result.status === "REFUSED" ? 409 : 200).json(result);
});
router.post("/connect/action-confirmations/:id/cancel", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await apiConnector.cancelToolCall({ actorId: req.actor!.id, confirmationId: idParam(req.params.id) }));
});

export default router;
