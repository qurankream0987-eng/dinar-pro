import { and, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, connectOauthStates, connectSecrets, connectIntegrations } from "@workspace/db";
import { ConnectCatalogSyncInput, ConnectOAuthConfiguration } from "@workspace/api-zod/connect-platform";
import { assertMarketLegalCapability } from "../lib/d16-readiness";
import { consumeRateLimit } from "../lib/auth-rate-limiter";
import { isMarketAvailable } from "../lib/markets";
import { ConnectNetwork, decryptConnectSecret, encryptConnectSecret, assertConnectTestDependencyInjection } from "./network";
import { connectError, validateExternalUrl } from "./provider-registry";
import { lockOwnedConnectIntegration, readyConnectIntegration, connectDigest, connectAudit, type ConnectTx, type ConnectMarket } from "./partners";
import { retireConnectSecrets } from "./secret-lifecycle";
const verifierSchema = z.object({ verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/), revision: z.number().int().positive(), digest: z.string(), redirectUri: z.string().url() }).strict();
const grantSchema = z.object({ stateId: z.string().uuid(), accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.string().datetime(), digest: z.string(), scope: z.literal("catalog.read") }).strict();
const tokenResponse = z.object({ access_token: z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/).max(8192), refresh_token: z.string().regex(/^[\x21-\x7e]+$/).max(8192).optional(), token_type: z.enum(["Bearer", "bearer"]), expires_in: z.number().int().positive().max(86400), scope: z.literal("catalog.read") });
const digestState = (state: string) => createHash("sha256").update(state).digest("hex");
function callbackUri() {
  let url: URL;
  try { url = new URL(process.env.APP_ORIGIN ?? ""); }
  catch { throw connectError(503, "OAUTH_ORIGIN_UNCONFIGURED", "يلزم أصل HTTPS ثابت للعودة من المزوّد"); }
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
    try { assertConnectTestDependencyInjection(); }
    catch { throw connectError(503, "OAUTH_ORIGIN_UNCONFIGURED", "يلزم أصل HTTPS ثابت للعودة من المزوّد"); }
  }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw connectError(503, "OAUTH_ORIGIN_UNCONFIGURED", "يلزم أصل HTTPS ثابت للعودة من المزوّد");
  return new URL("/api/connect/oauth/callback", url.origin).href;
}
function sourceIdentity(ready: Awaited<ReturnType<typeof readyConnectIntegration>>) {
  const config = ConnectOAuthConfiguration.safeParse(ready.integration.config.oauth);
  if (ready.integration.kind !== "OAUTH" || ready.integration.mode !== "SIMULATION_ONLY" || !ready.integration.endpointUrl || !config.success ||
      !ready.integration.capabilities.includes("CATALOG_READ") || !ready.integration.capabilities.includes("CATALOG_IMPORT"))
    throw connectError(409, "OAUTH_NOT_CONFIGURED", "يلزم ربط OAuth عام للقراءة فقط تمت مراجعته");
  const oauth = { ...config.data, authorizationEndpoint: validateExternalUrl(config.data.authorizationEndpoint, [ready.site.hostname]), tokenEndpoint: validateExternalUrl(config.data.tokenEndpoint, [ready.site.hostname]) };
  return { oauth, digest: connectDigest({ oauth, endpoint: ready.integration.endpointUrl, siteId: ready.site.id, revision: ready.integration.revision }) };
}
async function ownedOAuth(tx: ConnectTx, actorId: string, market: ConnectMarket, integrationId: string, expectedRevision?: number) {
  await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
  const ready = await readyConnectIntegration(tx, integrationId, "CATALOG_READ", true);
  if (!isMarketAvailable(market)) throw connectError(409, "MARKET_UNAVAILABLE", "السوق غير متاح");
  if (expectedRevision !== undefined && ready.integration.revision !== expectedRevision) throw connectError(409, "STALE_INTEGRATION", "تغيرت نسخة الربط؛ راجعها مجددًا");
  await assertMarketLegalCapability(market.id, "BUSINESS_ONBOARDING", tx);
  return { ready, ...sourceIdentity(ready) };
}
async function budget(integrationId: string) {
  if (await consumeRateLimit([{ scope: "connect-oauth", value: integrationId }], 60, 10)) throw connectError(429, "RATE_LIMITED", "طلبات ربط كثيرة؛ حاول لاحقًا");
}
export async function startConnectOAuth(actorId: string, market: ConnectMarket, integrationId: string, raw: unknown) {
  const input = ConnectCatalogSyncInput.parse(raw), redirectUri = callbackUri();
  await db.transaction(tx => ownedOAuth(tx, actorId, market, integrationId, input.expectedRevision));
  await budget(integrationId);
  return db.transaction(async tx => {
    const { ready, oauth, digest } = await ownedOAuth(tx, actorId, market, integrationId, input.expectedRevision);
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    const ciphertext = encryptConnectSecret(JSON.stringify({ verifier, revision: ready.integration.revision, digest, redirectUri }), integrationId);
    await retireConnectSecrets(tx, integrationId);
    await tx.insert(connectOauthStates).values({ id: randomUUID(), integrationId, userId: actorId, stateDigest: digestState(state), verifierCiphertext: ciphertext, expiresAt: new Date(Date.now() + 10 * 60_000) });
    await connectAudit(tx, ready.partner.id, actorId, "OWNER", "OAUTH_AUTHORIZATION_STARTED", { integrationId, revision: ready.integration.revision, scope: "catalog.read" });
    const url = new URL(oauth.authorizationEndpoint);
    for (const [name, value] of Object.entries({ response_type: "code", client_id: oauth.clientId, redirect_uri: redirectUri, scope: "catalog.read", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) url.searchParams.set(name, value);
    return { authorizationUrl: validateExternalUrl(url.href, [ready.site.hostname], ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]), expiresInSeconds: 600, scope: "catalog.read" };
  });
}
async function exchange(network: ConnectNetwork, source: { oauth: z.infer<typeof ConnectOAuthConfiguration>; hostname: string }, form: URLSearchParams) {
  form.set("client_id", source.oauth.clientId);
  const result = await network.request(source.oauth.tokenEndpoint, [source.hostname], { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(result.contentType)) throw connectError(502, "OAUTH_INVALID_RESPONSE", "لم يؤكد المزوّد تفويض قراءة صالحًا");
  let value: unknown; try { value = JSON.parse(result.text); } catch { throw connectError(502, "OAUTH_INVALID_RESPONSE", "لم يؤكد المزوّد تفويض قراءة صالحًا"); }
  const parsed = tokenResponse.safeParse(value);
  if (!parsed.success) throw connectError(502, "OAUTH_INVALID_RESPONSE", "لم يؤكد المزوّد نطاق القراءة ونوع الرمز وصلاحيته");
  return parsed.data;
}
async function storeGrant(tx: ConnectTx, integrationId: string, state: { id: string; verifierCiphertext: string }, grant: z.infer<typeof grantSchema>, revision: number) {
  const [current] = await tx.select().from(connectOauthStates).where(eq(connectOauthStates.id, state.id)).for("update");
  if (!current || current.verifierCiphertext !== state.verifierCiphertext || !current.consumedAt)
    throw connectError(409, "OAUTH_GRANT_CHANGED", "تغير تفويض الحساب أثناء الاتصال؛ أعد الربط");
  await tx.update(connectSecrets).set({ revokedAt: new Date() }).where(and(eq(connectSecrets.integrationId, integrationId), eq(connectSecrets.kind, "OAUTH_GRANT"), isNull(connectSecrets.revokedAt)));
  await tx.insert(connectSecrets).values({ id: randomUUID(), integrationId, kind: "OAUTH_GRANT", ciphertext: encryptConnectSecret(JSON.stringify(grant), integrationId), revision });
}
export async function completeConnectOAuth(actorId: string, market: ConnectMarket, raw: unknown, network = new ConnectNetwork()) {
  const input = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(2048).regex(/^[^\u0000-\u0020\u007f]+$/).optional(), error: z.string().regex(/^[a-z_]{1,80}$/).optional(), error_description: z.string().max(500).optional() })
    .strict().refine(value => Boolean(value.code) !== Boolean(value.error), "Exactly one code or provider error is required").parse(raw);
  const claim = await db.transaction(async tx => {
    const [initial] = await tx.select().from(connectOauthStates).where(and(eq(connectOauthStates.stateDigest, digestState(input.state)), eq(connectOauthStates.userId, actorId)));
    if (!initial) throw connectError(404, "NOT_FOUND", "طلب الربط غير موجود");
    const source = await ownedOAuth(tx, actorId, market, initial.integrationId);
    const [state] = await tx.select().from(connectOauthStates).where(eq(connectOauthStates.id, initial.id)).for("update");
    if (!state || state.consumedAt || state.expiresAt.getTime() <= Date.now()) throw connectError(409, "OAUTH_STATE_UNAVAILABLE", "انتهى طلب الربط أو استُخدم من قبل");
    const verifier = verifierSchema.parse(JSON.parse(decryptConnectSecret(state.verifierCiphertext, initial.integrationId)));
    if (verifier.revision !== source.ready.integration.revision || verifier.digest !== source.digest || verifier.redirectUri !== callbackUri()) throw connectError(409, "STALE_INTEGRATION", "تغير إعداد الربط؛ ابدأ تفويضًا جديدًا");
    await tx.update(connectOauthStates).set({ consumedAt: new Date() }).where(eq(connectOauthStates.id, state.id));
    if (input.error) await connectAudit(tx, source.ready.partner.id, actorId, "OWNER", "OAUTH_AUTHORIZATION_DECLINED", { integrationId: initial.integrationId });
    return { state, verifier, oauth: source.oauth, digest: source.digest, hostname: source.ready.site.hostname };
  });
  if (input.error) return { connected: false, reason: "PROVIDER_DECLINED" };
  await budget(claim.state.integrationId);
  const token = await exchange(network, claim, new URLSearchParams({ grant_type: "authorization_code", code: input.code!, redirect_uri: claim.verifier.redirectUri, code_verifier: claim.verifier.verifier }));
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  return db.transaction(async tx => {
    const source = await ownedOAuth(tx, actorId, market, claim.state.integrationId, claim.verifier.revision);
    if (source.digest !== claim.digest) throw connectError(409, "STALE_INTEGRATION", "تغير الربط أثناء التفويض");
    await storeGrant(tx, claim.state.integrationId, claim.state, { stateId: claim.state.id, accessToken: token.access_token, refreshToken: token.refresh_token ?? null, expiresAt, digest: source.digest, scope: "catalog.read" }, source.ready.integration.revision);
    await connectAudit(tx, source.ready.partner.id, actorId, "OWNER", "OAUTH_READ_AUTHORIZED", { integrationId: claim.state.integrationId, scope: "catalog.read" });
    return { connected: true, scope: "catalog.read", expiresInSeconds: token.expires_in };
  });
}
export async function readConnectOAuthGrant(tx: ConnectTx, integrationId: string, ready: Awaited<ReturnType<typeof readyConnectIntegration>>, requireUnexpired = true) {
  const rows = await tx.select().from(connectSecrets).where(and(eq(connectSecrets.integrationId, integrationId), eq(connectSecrets.kind, "OAUTH_GRANT"), isNull(connectSecrets.revokedAt))).for("update");
  if (rows.length !== 1) throw connectError(409, "OAUTH_NOT_CONNECTED", "أعد تفويض حساب القراءة أولًا");
  const row = rows[0]!, grant = grantSchema.parse(JSON.parse(decryptConnectSecret(row.ciphertext, integrationId)));
  if (grant.digest !== sourceIdentity(ready).digest || row.revision !== ready.integration.revision || (requireUnexpired && Date.parse(grant.expiresAt) <= Date.now())) throw connectError(409, "OAUTH_GRANT_UNAVAILABLE", "انتهى تفويض القراءة أو تغير الربط");
  const [state] = await tx.select().from(connectOauthStates).where(eq(connectOauthStates.id, grant.stateId)).for("share");
  if (!state || state.verifierCiphertext === "RETIRED") throw connectError(409, "OAUTH_GRANT_UNAVAILABLE", "تغير تفويض الحساب");
  return { row, grant, state };
}
export async function refreshConnectOAuth(actorId: string, market: ConnectMarket, integrationId: string, raw: unknown, network = new ConnectNetwork()) {
  const input = ConnectCatalogSyncInput.parse(raw);
  const claim = await db.transaction(async tx => {
    const source = await ownedOAuth(tx, actorId, market, integrationId, input.expectedRevision);
    const current = await readConnectOAuthGrant(tx, integrationId, source.ready, false);
    if (!current.grant.refreshToken) throw connectError(409, "OAUTH_REAUTHORIZE_REQUIRED", "هذا المزوّد يتطلب إعادة التفويض");
    await tx.update(connectSecrets).set({ revokedAt: new Date() }).where(eq(connectSecrets.id, current.row.id));
    return { ...current, oauth: source.oauth, digest: source.digest, hostname: source.ready.site.hostname };
  });
  await budget(integrationId);
  const token = await exchange(network, claim, new URLSearchParams({ grant_type: "refresh_token", refresh_token: claim.grant.refreshToken! }));
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  return db.transaction(async tx => {
    const source = await ownedOAuth(tx, actorId, market, integrationId, input.expectedRevision);
    if (source.digest !== claim.digest) throw connectError(409, "STALE_INTEGRATION", "تغير الربط أثناء التجديد");
    await storeGrant(tx, integrationId, claim.state, { ...claim.grant, accessToken: token.access_token, refreshToken: token.refresh_token ?? claim.grant.refreshToken, expiresAt }, source.ready.integration.revision);
    await connectAudit(tx, source.ready.partner.id, actorId, "OWNER", "OAUTH_READ_REFRESHED", { integrationId });
    return { connected: true, scope: "catalog.read", expiresInSeconds: token.expires_in };
  });
}
export async function disconnectConnectOAuth(actorId: string, market: ConnectMarket, integrationId: string, raw: unknown) {
  const input = ConnectCatalogSyncInput.parse(raw);
  return db.transaction(async tx => {
    const { access } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [integration] = await tx.select().from(connectIntegrations).where(eq(connectIntegrations.id, integrationId)).for("update");
    if (!integration || integration.kind !== "OAUTH" || integration.revision !== input.expectedRevision) throw connectError(409, "STALE_INTEGRATION", "تغيرت نسخة الربط");
    await retireConnectSecrets(tx, integrationId);
    await connectAudit(tx, access.partner.id, actorId, "OWNER", "OAUTH_LOCALLY_DISCONNECTED", { integrationId });
    return { disconnected: true, providerAuthorizationRevoked: false };
  });
}
/** Owner-facing metadata only; tokens never leave this service. */
export async function connectOAuthStatus(actorId: string, market: ConnectMarket, integrationId: string) {
  return db.transaction(async tx => {
    const source = await ownedOAuth(tx, actorId, market, integrationId);
    try {
      const { grant } = await readConnectOAuthGrant(tx, integrationId, source.ready, false);
      return { connected: Date.parse(grant.expiresAt) > Date.now(), canRefresh: Boolean(grant.refreshToken), expiresAt: grant.expiresAt, scope: "catalog.read" as const };
    } catch (error) {
      if (!["OAUTH_NOT_CONNECTED", "OAUTH_GRANT_UNAVAILABLE"].includes((error as { code?: string }).code ?? "")) throw error;
      return { connected: false, canRefresh: false, expiresAt: null, scope: null };
    }
  });
}
