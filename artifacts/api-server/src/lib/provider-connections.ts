/**
 * G1 provider connection and credential authority.
 *
 * - A connection belongs to the authenticated owner and to the owner's ACTIVE market at
 *   creation; it never moves to another market. A client-named market must equal it.
 * - Scopes are an explicit allowlist with no wildcard, admin, payment or promotion scope.
 * - A credential is `dnr_<keyId>_<secret>`: keyId is a public lookup prefix, the secret
 *   is 256 random bits and only its SHA-256 is stored. The full key is returned once, by
 *   the call that issued it, and never again. At most one credential is active per
 *   connection, so rotation revokes the old key in the same transaction.
 * - Revoking a connection revokes its key, pauses its listings through the canonical
 *   status authority and ends driver links; listings, orders and audit rows are kept.
 * Audit rows go to market_audit and carry ids and the public key prefix, never a secret.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  marketAudit,
  markets,
  offers,
  providerConnections,
  providerCredentials,
  providerResourceMappings,
  users,
} from "@workspace/db";
import { changeOwnedListingStatus } from "./listing-management";
import { assertMarketActive, resolveMarket } from "./markets";

export const PROVIDER_SCOPES = ["listings:read", "listings:write", "drivers:link"] as const;
export type ProviderScope = (typeof PROVIDER_SCOPES)[number];
export const DEFAULT_PROVIDER_SCOPES: ProviderScope[] = ["listings:read", "listings:write"];
/** Conservative admission cap: existing connections are not revoked by this policy. */
export const MAX_ACTIVE_PROVIDER_CONNECTIONS = 2;
export const PROVIDER_SCOPE_LABELS: Record<ProviderScope, string> = {
  "listings:read": "قراءة العروض المتزامنة",
  "listings:write": "إنشاء وتحديث العروض والأسعار والمخزون",
  "drivers:link": "ربط سائقين لديهم حساب DINAR ووافقوا على الربط",
};
/** What a connection can never do, whatever its scopes. */
export const PROVIDER_LIMITS = [
  "لا يتجاوز المراجعة والإشراف وسياسات السوق",
  "لا يروّج العروض ولا يغيّر ترتيبها",
  "لا ينشئ طلبات ولا يغيّر حالة الدفع أو العمولة",
  "لا ينشئ حسابات ولا يعتمد سائقين",
];

export type ProviderErrorCode =
  | "INVALID_CREDENTIAL"
  | "REVOKED_CREDENTIAL"
  | "CONNECTION_UNAVAILABLE"
  | "SCOPE_DENIED"
  | "MARKET_MISMATCH"
  | "INVALID_PAYLOAD"
  | "RESOURCE_CONFLICT"
  | "RESOURCE_NOT_FOUND"
  | "RATE_LIMITED";

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProviderErrorCode,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
export const providerError = (status: number, code: ProviderErrorCode, message: string, issues?: string[]) =>
  new ProviderError(status, code, message, issues);

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

type Connection = typeof providerConnections.$inferSelect;
type Owner = typeof users.$inferSelect;

export async function providerAudit(tx: any, marketId: string, actorId: string, action: string, data: Record<string, unknown>) {
  await tx.insert(marketAudit).values({ id: randomUUID(), marketId, actorId, action, data });
}

// ─── Credentials ─────────────────────────────────────────────────────────────

const KEY_PATTERN = /^dnr_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;
const secretHash = (keyId: string, secret: string) =>
  createHash("sha256").update(`dinar-provider-credential\0${keyId}\0${secret}`).digest("hex");
/** Compared when no credential matches, so unknown and wrong keys cost the same. */
const DECOY_HASH = secretHash("0".repeat(16), "0".repeat(43));
export const keyPrefix = (keyId: string) => `dnr_${keyId}`;

function newCredentialMaterial() {
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { keyId, key: `dnr_${keyId}_${secret}`, hash: secretHash(keyId, secret) };
}

function sameHash(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type ProviderContext = {
  credentialId: string;
  keyId: string;
  connection: Connection;
  owner: Owner;
};

/**
 * Resolves a bearer key to its connection, owner and market. Unknown and wrong keys
 * share one generic error; REVOKED_CREDENTIAL is only told to a caller holding the
 * exact (revoked) key.
 */
export async function authenticateProviderKey(presented: string | undefined): Promise<ProviderContext> {
  const invalid = () => providerError(401, "INVALID_CREDENTIAL", "مفتاح الربط غير صالح");
  const match = presented ? KEY_PATTERN.exec(presented) : null;
  if (!match) throw invalid();
  const [, keyId, secret] = match;
  const [row] = await db
    .select({ credential: providerCredentials, connection: providerConnections, owner: users })
    .from(providerCredentials)
    .innerJoin(providerConnections, eq(providerConnections.id, providerCredentials.connectionId))
    .innerJoin(users, eq(users.id, providerConnections.ownerUserId))
    .where(eq(providerCredentials.keyId, keyId!))
    .limit(1);
  const verified = sameHash(row?.credential.secretHash ?? DECOY_HASH, secretHash(keyId!, secret!));
  if (!row || !verified) throw invalid();
  if (row.credential.revokedAt || row.connection.status !== "ACTIVE")
    throw providerError(401, "REVOKED_CREDENTIAL", "تم إلغاء مفتاح الربط هذا");
  if (row.owner.status !== "ACTIVE" || !row.owner.phoneVerified)
    throw providerError(403, "CONNECTION_UNAVAILABLE", "حساب مالك الربط غير نشط حاليًا");
  return { credentialId: row.credential.id, keyId: keyId!, connection: row.connection, owner: row.owner };
}

export function assertProviderScope(context: ProviderContext, scope: ProviderScope) {
  if (!context.connection.scopes.includes(scope))
    throw providerError(403, "SCOPE_DENIED", "صلاحيات هذا الربط لا تسمح بهذه العملية");
}

/**
 * Re-checks, inside the caller's write transaction, that the key and connection are
 * still live and the owner still acts in the connection's market. FOR KEY SHARE makes a
 * concurrent revoke or rotation (FOR UPDATE) wait until this write commits, so no write
 * starts after it, while concurrent writes may still record their sync time on the row
 * (a non-key update); FOR SHARE would deadlock two writers upgrading to that update.
 */
export async function assertProviderStillAuthorized(tx: any, context: ProviderContext) {
  // Same lock order as revoke and rotation (connection, then credential): no deadlock.
  const connection = (
    await tx.execute(sql`
      select p.status, u.status as owner_status, u.phone_verified, u.active_market_id
      from provider_connections p
      join users u on u.id = p.owner_user_id
      where p.id = ${context.connection.id}
      for key share of p`)
  ).rows[0] as { status: string; owner_status: string; phone_verified: boolean; active_market_id: string } | undefined;
  const credential = (
    await tx.execute(sql`select revoked_at from provider_credentials where id = ${context.credentialId} for share`)
  ).rows[0] as { revoked_at: Date | null } | undefined;
  if (!connection || !credential || credential.revoked_at || connection.status !== "ACTIVE")
    throw providerError(401, "REVOKED_CREDENTIAL", "تم إلغاء مفتاح الربط هذا");
  if (connection.owner_status !== "ACTIVE" || !connection.phone_verified)
    throw providerError(403, "CONNECTION_UNAVAILABLE", "حساب مالك الربط غير نشط حاليًا");
  if (connection.active_market_id !== context.connection.marketId)
    throw providerError(409, "MARKET_MISMATCH", "سوق حساب المالك الحالي يختلف عن سوق هذا الربط");
}

export async function markProviderSync(tx: any, connectionId: string) {
  await tx
    .update(providerConnections)
    .set({ lastSuccessfulSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(providerConnections.id, connectionId));
}

// ─── Owner-side management ───────────────────────────────────────────────────

export function normalizeProviderScopes(requested: readonly string[] | undefined): ProviderScope[] {
  if (!requested?.length) return [...DEFAULT_PROVIDER_SCOPES];
  const unknown = requested.filter((scope) => !(PROVIDER_SCOPES as readonly string[]).includes(scope));
  if (unknown.length) throw fail(400, "صلاحيات الربط غير معروفة", "INVALID_SCOPE");
  return PROVIDER_SCOPES.filter((scope) => requested.includes(scope));
}

export function normalizeConnectionName(name: string | undefined): string {
  const value = (name ?? "").replace(/\s+/g, " ").trim() || "ربط نظام المتجر";
  if (value.length > 80) throw fail(400, "اسم الربط يجب ألا يتجاوز 80 حرفًا");
  return value;
}

async function ownerMarket(owner: Pick<Owner, "activeMarketId">, tx: any) {
  const [row] = await tx.select().from(markets).where(eq(markets.id, owner.activeMarketId));
  if (!row) throw fail(404, "السوق غير موجود");
  const market = await resolveMarket(row, tx);
  assertMarketActive(market);
  return market;
}

/** Creates the connection in the owner's active market; it has no key until one is issued. */
export async function createProviderConnection(input: {
  ownerId: string;
  name?: string;
  scopes?: readonly string[];
  requestedMarketId?: string;
}): Promise<Connection> {
  const name = normalizeConnectionName(input.name);
  const scopes = normalizeProviderScopes(input.scopes);
  return db.transaction(async (tx) => {
    const [owner] = await tx.select().from(users).where(eq(users.id, input.ownerId)).for("update");
    if (!owner || owner.status !== "ACTIVE" || !owner.phoneVerified) throw fail(403, "حسابك غير نشط حاليًا");
    if (input.requestedMarketId !== undefined && input.requestedMarketId !== owner.activeMarketId)
      throw fail(409, "يُنشأ الربط في سوقك الحالي فقط", "MARKET_MISMATCH");
    const market = await ownerMarket(owner, tx);
    const [{ active }] = await tx
      .select({ active: count() })
      .from(providerConnections)
      .where(and(eq(providerConnections.ownerUserId, owner.id), eq(providerConnections.status, "ACTIVE")));
    if (Number(active) >= MAX_ACTIVE_PROVIDER_CONNECTIONS)
      throw fail(409, `لديك ${MAX_ACTIVE_PROVIDER_CONNECTIONS} روابط نشطة؛ أوقف ربطًا قبل إنشاء آخر.`);
    const [connection] = await tx
      .insert(providerConnections)
      .values({ id: randomUUID(), ownerUserId: owner.id, marketId: market.id, name, scopes, status: "ACTIVE" })
      .returning();
    await providerAudit(tx, market.id, owner.id, "PROVIDER_CONNECTION_CREATED", { connectionId: connection!.id, scopes });
    return connection!;
  });
}

async function ownedConnection(tx: any, ownerId: string, connectionId: string, lock = false) {
  let query = tx
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.id, connectionId), eq(providerConnections.ownerUserId, ownerId)));
  if (lock) query = query.for("update");
  const [row] = await query;
  if (!row) throw fail(404, "الربط غير موجود");
  return row as Connection;
}

async function revokeActiveCredentials(tx: any, connection: Connection, ownerId: string, reason: string) {
  const revoked = await tx
    .update(providerCredentials)
    .set({ revokedAt: new Date() })
    .where(and(eq(providerCredentials.connectionId, connection.id), isNull(providerCredentials.revokedAt)))
    .returning({ keyId: providerCredentials.keyId });
  for (const credential of revoked as { keyId: string }[])
    await providerAudit(tx, connection.marketId, ownerId, "PROVIDER_CREDENTIAL_REVOKED", {
      connectionId: connection.id,
      keyPrefix: keyPrefix(credential.keyId),
      reason,
    });
  return revoked.length as number;
}

/**
 * Issues the connection's key, revoking any active one first (rotation). The returned
 * key is the only copy; callers hand it to the owner directly and never persist it.
 */
export async function issueProviderCredential(input: { ownerId: string; connectionId: string }) {
  return db.transaction(async (tx) => {
    const connection = await ownedConnection(tx, input.ownerId, input.connectionId, true);
    if (connection.status !== "ACTIVE") throw fail(409, "هذا الربط موقوف؛ أنشئ ربطًا جديدًا");
    const rotated = (await revokeActiveCredentials(tx, connection, input.ownerId, "ROTATION")) > 0;
    const material = newCredentialMaterial();
    await tx.insert(providerCredentials).values({
      id: randomUUID(),
      connectionId: connection.id,
      keyId: material.keyId,
      secretHash: material.hash,
    });
    await providerAudit(tx, connection.marketId, input.ownerId, rotated ? "PROVIDER_CREDENTIAL_ROTATED" : "PROVIDER_CREDENTIAL_CREATED", {
      connectionId: connection.id,
      keyPrefix: keyPrefix(material.keyId),
    });
    return { connection, key: material.key, keyPrefix: keyPrefix(material.keyId), rotated };
  });
}

/** «بدل المفتاح» after review: the old key stops now; the new one is issued separately. */
export async function revokeProviderCredential(input: { ownerId: string; connectionId: string }) {
  return db.transaction(async (tx) => {
    const connection = await ownedConnection(tx, input.ownerId, input.connectionId, true);
    if (connection.status !== "ACTIVE") throw fail(409, "هذا الربط موقوف بالفعل");
    return { connection, revoked: await revokeActiveCredentials(tx, connection, input.ownerId, "ROTATION") };
  });
}

/**
 * «أوقف الربط»: the connection and its key stop working; its published listings are
 * paused through the canonical status authority and become the seller's to manage;
 * driver links end. Nothing is deleted from listings, orders, payments or audit.
 */
export async function revokeProviderConnection(input: { ownerId: string; connectionId: string }) {
  return db.transaction(async (tx) => {
    const connection = await ownedConnection(tx, input.ownerId, input.connectionId, true);
    if (connection.status === "REVOKED") return { connection, pausedListings: 0, unlinkedDrivers: 0 };
    await revokeActiveCredentials(tx, connection, input.ownerId, "CONNECTION_REVOKED");
    const [revoked] = await tx
      .update(providerConnections)
      .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(providerConnections.id, connection.id))
      .returning();
    const [marketRow] = await tx.select().from(markets).where(eq(markets.id, connection.marketId));
    const market = await resolveMarket(marketRow, tx);
    const mapped = await tx
      .select({ id: offers.id })
      .from(providerResourceMappings)
      .innerJoin(offers, eq(offers.id, providerResourceMappings.resourceId))
      .where(
        and(
          eq(providerResourceMappings.connectionId, connection.id),
          eq(providerResourceMappings.resourceType, "LISTING"),
          eq(offers.status, "PUBLISHED"),
          eq(offers.sellerId, input.ownerId),
        ),
      );
    for (const listing of mapped as { id: string }[])
      await changeOwnedListingStatus({ listingId: listing.id, ownerId: input.ownerId, market, action: "PAUSE" }, tx);
    const drivers = await tx
      .delete(providerResourceMappings)
      .where(and(eq(providerResourceMappings.connectionId, connection.id), eq(providerResourceMappings.resourceType, "DRIVER_PROFILE")))
      .returning({ externalRef: providerResourceMappings.externalRef, resourceId: providerResourceMappings.resourceId });
    for (const driver of drivers as { externalRef: string; resourceId: string }[])
      await providerAudit(tx, connection.marketId, input.ownerId, "PROVIDER_DRIVER_UNLINKED", {
        connectionId: connection.id,
        externalRef: driver.externalRef,
        driverProfileId: driver.resourceId,
        reason: "CONNECTION_REVOKED",
      });
    await providerAudit(tx, connection.marketId, input.ownerId, "PROVIDER_CONNECTION_REVOKED", {
      connectionId: connection.id,
      pausedListings: mapped.length,
      unlinkedDrivers: drivers.length,
    });
    return { connection: revoked as Connection, pausedListings: mapped.length as number, unlinkedDrivers: drivers.length as number };
  });
}

export type ProviderConnectionView = {
  id: string;
  name: string;
  marketId: string;
  status: string;
  scopes: string[];
  keyPrefix: string | null;
  mappedListings: number;
  linkedDrivers: number;
  createdAt: string;
  revokedAt: string | null;
  lastSuccessfulSyncAt: string | null;
};

/** The owner's connections; an allowlisted view that never contains a key or hash. */
export async function listProviderConnections(ownerId: string, connectionIds?: string[]): Promise<ProviderConnectionView[]> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.ownerUserId, ownerId),
        ...(connectionIds ? [inArray(providerConnections.id, connectionIds.length ? connectionIds : [""])] : []),
      ),
    )
    .orderBy(desc(providerConnections.createdAt))
    .limit(20);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [keys, mappings] = await Promise.all([
    db
      .select({ connectionId: providerCredentials.connectionId, keyId: providerCredentials.keyId })
      .from(providerCredentials)
      .where(and(inArray(providerCredentials.connectionId, ids), isNull(providerCredentials.revokedAt))),
    db
      .select({ connectionId: providerResourceMappings.connectionId, type: providerResourceMappings.resourceType, total: count() })
      .from(providerResourceMappings)
      .where(inArray(providerResourceMappings.connectionId, ids))
      .groupBy(providerResourceMappings.connectionId, providerResourceMappings.resourceType),
  ]);
  const totals = (id: string, type: string) => Number(mappings.find((row) => row.connectionId === id && row.type === type)?.total ?? 0);
  return rows.map((row) => {
    const key = keys.find((item) => item.connectionId === row.id);
    return {
      id: row.id,
      name: row.name,
      marketId: row.marketId,
      status: row.status,
      scopes: row.scopes,
      keyPrefix: key ? keyPrefix(key.keyId) : null,
      mappedListings: totals(row.id, "LISTING"),
      linkedDrivers: totals(row.id, "DRIVER_PROFILE"),
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
    };
  });
}
