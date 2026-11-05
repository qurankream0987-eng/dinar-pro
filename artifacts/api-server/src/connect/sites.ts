import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db, connectSites, connectIntegrations, providerConnections, providerCredentials } from "@workspace/db";
import { ConnectSiteCommandInput } from "@workspace/api-zod/connect-platform";
import { connectAccess, connectAudit, type ConnectTx, type ConnectMarket } from "./partners";
import { connectError } from "./provider-registry";
async function ownedSite(tx: ConnectTx, actorId: string, market: ConnectMarket, siteId: string) {
  const [initial] = await tx.select({ partnerId: connectSites.partnerId }).from(connectSites).where(eq(connectSites.id, siteId));
  if (!initial) throw connectError(404, "NOT_FOUND", "الموقع غير موجود");
  await connectAccess(actorId, market.id, initial.partnerId, "OWNER", tx, true);
  const [site] = await tx.select().from(connectSites)
    .where(and(eq(connectSites.id, siteId), eq(connectSites.partnerId, initial.partnerId))).for("update");
  if (!site) throw connectError(404, "NOT_FOUND", "الموقع غير موجود");
  return site;
}
export async function renewConnectSiteChallenge(actorId: string, market: ConnectMarket, siteId: string, raw: unknown) {
  ConnectSiteCommandInput.parse(raw);
  return db.transaction(async tx => {
    const site = await ownedSite(tx, actorId, market, siteId);
    if (site.status === "REVOKED") throw connectError(409, "SITE_REVOKED", "الموقع ملغى؛ يلزم ربط جديد ومراجعة مستقلة");
    const value = `dinar-connect-verification=${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await tx.update(connectSites).set({ challengeDigest: createHash("sha256").update(value).digest("hex"), challengeExpiresAt: expiresAt, updatedAt: new Date() }).where(eq(connectSites.id, site.id));
    await connectAudit(tx, site.partnerId, actorId, "OWNER", "SITE_CHALLENGE_RENEWED", { siteId, expiresAt: expiresAt.toISOString() });
    // Existing ownership evidence keeps its original expiry; renewal alone never
    // extends verification and never stores/logs the plaintext challenge.
    return { id: site.id, hostname: site.hostname, status: site.status, validUntil: site.validUntil?.toISOString() ?? null,
      challengeExpiresAt: expiresAt.toISOString(), challenge: { recordName: `_dinar-connect.${site.hostname}`, value } };
  });
}
export async function revokeConnectSite(actorId: string, market: ConnectMarket, siteId: string, raw: unknown) {
  ConnectSiteCommandInput.parse(raw);
  return db.transaction(async tx => {
    const site = await ownedSite(tx, actorId, market, siteId);
    if (site.status === "REVOKED") return { id: site.id, status: "REVOKED", idempotent: true };
    // Parent UPDATE is held before site/integration/credential locks. All provider
    // writes and credential issuance first take this same parent lock, so none
    // can commit a new authorization after site-wide revocation commits.
    const integrations = await tx.select().from(connectIntegrations)
      .where(and(eq(connectIntegrations.partnerId, site.partnerId), eq(connectIntegrations.siteId, site.id))).for("update");
    const now = new Date();
    for (const integration of integrations) {
      await tx.update(connectIntegrations).set({ status: "REVOKED", updatedAt: now }).where(eq(connectIntegrations.id, integration.id));
      if (integration.providerConnectionId) {
        await tx.update(providerCredentials).set({ revokedAt: now }).where(eq(providerCredentials.connectionId, integration.providerConnectionId));
        await tx.update(providerConnections).set({ status: "REVOKED", revokedAt: now, updatedAt: now }).where(eq(providerConnections.id, integration.providerConnectionId));
      }
    }
    await tx.update(connectSites).set({ status: "REVOKED", challengeExpiresAt: now, updatedAt: now }).where(eq(connectSites.id, site.id));
    await connectAudit(tx, site.partnerId, actorId, "OWNER", "SITE_REVOKED", { siteId, integrationsRetired: integrations.map(integration => integration.id) });
    return { id: site.id, status: "REVOKED", integrationsRetired: integrations.length, idempotent: false };
  });
}
