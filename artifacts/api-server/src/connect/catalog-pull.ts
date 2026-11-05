import { db } from "@workspace/db";
import { ConnectCatalogSyncInput } from "@workspace/api-zod/connect-platform";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { consumeRateLimit } from "../lib/auth-rate-limiter";
import { parseConnectCatalogDocument } from "./catalog-document";
import { readWebsiteCatalog } from "./website-catalog";
import { readReviewedMcpCatalog } from "./mcp-catalog";
import { readConnectOAuthGrant } from "./oauth";
import { isMarketAvailable } from "../lib/markets";
import { ConnectNetwork } from "./network";
import { connectError } from "./provider-registry";
import { lockOwnedConnectIntegration, readyConnectIntegration, importConnectOwnerCatalog, assertConnectCatalogCategory, type ConnectMarket } from "./partners";
/** Bounded JSON only. Provider documents cannot register prompts/tools or choose
 * navigation hosts, credentials, internal orders or another ingestion runtime. */
export async function readStructuredConnectCatalog(network: ConnectNetwork, endpoint: string, hostname: string, authorization?: string) {
  const response = await network.request(endpoint, [hostname], authorization ? { headers: { authorization } } : {});
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(response.contentType))
    throw connectError(502, "PROVIDER_INVALID_CONTENT_TYPE", "يلزم كتالوج JSON موثق؛ لم تُفسر صفحة أو تعليمات المزوّد");
  return parseConnectCatalogDocument(response.text);
}
export async function syncConnectCatalog(actorId: string, market: ConnectMarket, integrationId: string, raw: unknown, network = new ConnectNetwork()) {
  const input = ConnectCatalogSyncInput.parse(raw);
  const source = await db.transaction(async tx => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const ready = await readyConnectIntegration(tx, integrationId, "CATALOG_IMPORT", true);
    if (ready.partner.id !== partnerId || ready.integration.revision !== input.expectedRevision)
      throw connectError(409, "STALE_INTEGRATION", "تغيرت نسخة الموصل؛ راجعها مجددًا");
    if (!isMarketAvailable(market)) throw connectError(409, "MARKET_UNAVAILABLE", "السوق غير متاح");
    if (!["FEED", "API", "OAUTH", "MCP", "WEBSITE"].includes(ready.integration.kind) || !ready.integration.endpointUrl || !ready.integration.capabilities.includes("CATALOG_READ"))
      throw connectError(409, "STRUCTURED_PULL_NOT_CONFIGURED", "يلزم موصل API أو تغذية JSON للقراءة مع عنوان معتمد");
    await assertMarketLegalCapability(market.id, "LISTING_PUBLICATION", tx);
    const websiteCategoryId = ready.integration.kind === "WEBSITE" && typeof ready.integration.config.websiteCategoryId === "string" ? ready.integration.config.websiteCategoryId : undefined;
    if (ready.integration.kind === "WEBSITE") {
      if (!websiteCategoryId) throw connectError(409, "WEBSITE_MAPPING_REQUIRED", "يلزم تصنيف صريح تمت مراجعته لفهرسة الصفحة");
      await assertConnectCatalogCategory(tx, market, websiteCategoryId);
    }
    const oauth = (ready.integration.kind === "OAUTH" || ready.integration.config.oauth) ? await readConnectOAuthGrant(tx, integrationId, ready) : null;
    return { kind: ready.integration.kind, websiteCategoryId, allowedPathPrefixes: ready.integration.config.allowedPathPrefixes as string[], reviewedTools: ready.integration.config.reviewedTools, revision: ready.integration.revision, endpointUrl: ready.integration.endpointUrl, siteId: ready.site.id, hostname: ready.site.hostname,
      ...(oauth ? { oauthGrantId: oauth.row.id, oauthGrantExpiresAt: oauth.grant.expiresAt, authorization: `Bearer ${oauth.grant.accessToken}` } : {}) };

  });
  const limited = await consumeRateLimit([
    { scope: "connect-catalog-pull", value: integrationId },
    { scope: "connect-catalog-pull-owner", value: actorId },
    { scope: "connect-catalog-pull-host", value: source.hostname },
  ], 60, 10);
  if (limited) throw connectError(429, "RATE_LIMITED", "طلبات مزامنة كثيرة؛ حاول لاحقًا");
  // Never hold database locks while a provider is responding. The shared import
  // path rechecks current ownership, approval, site and revision before commit.
  if (source.kind === "WEBSITE") {
    const websiteObservation = await readWebsiteCatalog(network, source.endpointUrl, { hostname: source.hostname, allowedPathPrefixes: source.allowedPathPrefixes, categoryId: source.websiteCategoryId! });
    return importConnectOwnerCatalog(actorId, market, integrationId, null, { ...source, websiteObservation });
  }
  const batch = source.kind === "MCP"
    ? await readReviewedMcpCatalog(network, source.endpointUrl, source.hostname, source.reviewedTools, source.authorization)
    : await readStructuredConnectCatalog(network, source.endpointUrl, source.hostname, source.authorization);
  return importConnectOwnerCatalog(actorId, market, integrationId, batch, source);
}
