import { db } from "@workspace/db";
import { ConnectCatalogBatch, ConnectCatalogSyncInput } from "@workspace/api-zod/connect-platform";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { consumeRateLimit } from "../lib/auth-rate-limiter";
import { readConnectOAuthGrant } from "./oauth";
import { isMarketAvailable } from "../lib/markets";
import { ConnectNetwork } from "./network";
import { connectError } from "./provider-registry";
import { lockOwnedConnectIntegration, readyConnectIntegration, importConnectOwnerCatalog, type ConnectMarket } from "./partners";
/** Bounded JSON only. Provider documents cannot register prompts/tools or choose
 * navigation hosts, credentials, internal orders or another ingestion runtime. */
export async function readStructuredConnectCatalog(network: ConnectNetwork, endpoint: string, hostname: string, authorization?: string) {
  const response = await network.request(endpoint, [hostname], authorization ? { headers: { authorization } } : {});
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(response.contentType))
    throw connectError(502, "PROVIDER_INVALID_CONTENT_TYPE", "يلزم كتالوج JSON موثق؛ لم تُفسر صفحة أو تعليمات المزوّد");
  let parsed: unknown;
  try { parsed = JSON.parse(response.text); }
  catch { throw connectError(502, "PROVIDER_INVALID_CATALOG", "كتالوج المزوّد ليس JSON صالحًا"); }
  let entries = 0;
  const bounded = (value: unknown, depth = 0): void => {
    if (depth > 12 || ++entries > 5000) throw connectError(502, "PROVIDER_INVALID_CATALOG", "كتالوج المزوّد يتجاوز حدود البنية");
    if (Array.isArray(value)) { if (value.length > 100) throw connectError(502, "PROVIDER_INVALID_CATALOG", "عدد عناصر المزوّد يتجاوز حد الدفعة"); value.forEach(item => bounded(item, depth + 1)); }
    else if (value && typeof value === "object") Object.values(value).forEach(item => bounded(item, depth + 1));
  };
  bounded(parsed);
  const result = ConnectCatalogBatch.safeParse(parsed);
  if (!result.success) throw connectError(502, "PROVIDER_INVALID_CATALOG", "حقول كتالوج المزوّد لا تطابق العقد المعتمد؛ لم يُستورد شيء");
  return result.data;
}
export async function syncConnectCatalog(actorId: string, market: ConnectMarket, integrationId: string, raw: unknown, network = new ConnectNetwork()) {
  const input = ConnectCatalogSyncInput.parse(raw);
  const source = await db.transaction(async tx => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const ready = await readyConnectIntegration(tx, integrationId, "CATALOG_IMPORT", true);
    if (ready.partner.id !== partnerId || ready.integration.revision !== input.expectedRevision)
      throw connectError(409, "STALE_INTEGRATION", "تغيرت نسخة الموصل؛ راجعها مجددًا");
    if (!isMarketAvailable(market)) throw connectError(409, "MARKET_UNAVAILABLE", "السوق غير متاح");
    if (!["FEED", "API", "OAUTH"].includes(ready.integration.kind) || !ready.integration.endpointUrl || !ready.integration.capabilities.includes("CATALOG_READ"))
      throw connectError(409, "STRUCTURED_PULL_NOT_CONFIGURED", "يلزم موصل API أو تغذية JSON للقراءة مع عنوان معتمد");
    await assertMarketLegalCapability(market.id, "LISTING_PUBLICATION", tx);
    const oauth = ready.integration.kind === "OAUTH" ? await readConnectOAuthGrant(tx, integrationId, ready) : null;
    return { revision: ready.integration.revision, endpointUrl: ready.integration.endpointUrl, siteId: ready.site.id, hostname: ready.site.hostname,
      ...(oauth ? { oauthGrantId: oauth.row.id, oauthGrantExpiresAt: oauth.grant.expiresAt, authorization: `Bearer ${oauth.grant.accessToken}` } : {}) };

  });
  const limited = await consumeRateLimit([{ scope: "connect-catalog-pull", value: integrationId }], 60, 10);
  if (limited) throw connectError(429, "RATE_LIMITED", "طلبات مزامنة كثيرة؛ حاول لاحقًا");
  // Never hold database locks while a provider is responding. The shared import
  // path rechecks current ownership, approval, site and revision before commit.
  const batch = await readStructuredConnectCatalog(network, source.endpointUrl, source.hostname, source.authorization);
  return importConnectOwnerCatalog(actorId, market, integrationId, batch, source);
}
