/**
 * G1 acceptance: the universal provider source layer.
 *
 * A provider pushes structured data into DINAR through a scoped, revocable credential;
 * everything it creates is an ordinary canonical Listing (or a link to an existing
 * DriverProfile) and is then searched, ordered, paid, promoted and delivered by the
 * existing authorities only. Every case runs through the real HTTP app against a
 * disposable database; plaintext keys live only in this process's memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import app from "../src/app";
import {
  db,
  deliveryAssignments,
  driverProfiles,
  listingPromotions,
  marketAudit,
  markets,
  offers,
  orderFulfillments,
  orders,
  paymentIntents,
  pool,
  providerConnections,
  providerCredentials,
  providerResourceMappings,
  users,
} from "@workspace/db";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { attachTransactionLocation, selectDeliveryMethod } from "../src/lib/delivery";
import { assignDelivery, driverOutForDelivery, listDeliveryWork, recordCourierProgress, setDriverAvailability } from "../src/lib/driver";
import { logger } from "../src/lib/logger";
import { resolveMarket } from "../src/lib/markets";
import { listingSource } from "../src/lib/provider-source";
import { providerListingId } from "../src/lib/provider-sync";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G1_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

// Log secrecy is checked by test/run.mjs (BDINAR_LOG_SCAN=1), which captures the process's
// stdout/stderr at the file-descriptor level, pino's transport worker included. The suite
// hands it only SHA-256 hashes of the secrets plus a canary that must appear.
const sentinelFile = process.env.BDINAR_LOG_SENTINELS_FILE;
assert.ok(sentinelFile, "run with BDINAR_LOG_SCAN=1");

// Every outbound request that leaves loopback is recorded: DINAR never calls a provider.
const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // Not a URL; not a network request.
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
const CITY = `إربد ${Date.now() % 100_000}`;
let ipSequence = 0;

type Response = { status: number; data: any; raw: string; cookie: string; retryAfter: number };
async function request(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.41.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
      ...headers,
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : typeof body === "string" ? body : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", retryAfter: Number(response.headers.get("retry-after") ?? 0) };
}

type Actor = { id: string; cookie: string; phone: string; conv: string };
// +965 516xxxxx–517xxxxx is an allocated KW mobile range; only digits inside it vary.
const phoneBase = 51_600_000 + ((Date.now() + process.pid) % 150_000);
let phoneOffset = 0;
async function register(label: string, market = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `G1-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR G1 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  if (market !== "KW") assert.equal((await request("/account/market", "PATCH", { marketId: market }, registered.cookie)).status, 200);
  const actor = { id: registered.data.user.id, cookie: registered.cookie, phone: phoneNumber, conv: "" };
  actor.conv = (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id;
  return actor;
}

// ─── Chat turns: deterministic, counted for model calls.
const modelCalls = { providerApi: 0, management: 0, chat: 0 };
type Turn = { body: string; payload: any; raw: string };
async function turn(actor: Actor, message: string, bucket: "management" | "chat" = "chat", conversationId = actor.conv): Promise<Turn> {
  const before = getModelGatewayCallCount();
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  modelCalls[bucket] += getModelGatewayCallCount() - before;
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  return { body: complete.assistantMessage.body, payload: complete.assistantMessage.blocks[0]?.payload ?? {}, raw };
}

// ─── Provider API calls. Every response body (never a key-issuing one) is kept for the
// secret and raw-SQL scans. A 429 waits out its Retry-After window and retries.
const providerResponses: string[] = [];
let rateLimitedRetries = 0;
async function api(key: string, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const before = getModelGatewayCallCount();
    const response = await request(`/provider${path}`, method, body, "", { Authorization: `Bearer ${key}`, ...headers });
    modelCalls.providerApi += getModelGatewayCallCount() - before;
    providerResponses.push(response.raw);
    if (response.status !== 429 || attempt >= 6) return response;
    rateLimitedRetries++;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, response.retryAfter) * 1000 + 150));
  }
}

const keys: string[] = [];
const secretOf = (key: string) => key.slice("dnr_".length + 16 + 1);
/** Issues (or rotates) a connection's key through the owner's session route. */
async function issueKey(owner: Actor, connectionId: string) {
  const issued = await request(`/provider-connections/${connectionId}/credentials`, "POST", {}, owner.cookie);
  assert.equal(issued.status, 201, issued.raw.replace(/dnr_[A-Za-z0-9_-]+/g, "dnr_…"));
  keys.push(issued.data.key);
  return issued.data as { key: string; keyPrefix: string; rotated: boolean; connection: any; warning: string };
}
async function newConnection(owner: Actor, body: Record<string, unknown> = {}) {
  const created = await request("/provider-connections", "POST", body, owner.cookie);
  assert.equal(created.status, 201, created.raw.replace(/dnr_[A-Za-z0-9_-]+/g, "dnr_…"));
  keys.push(created.data.key);
  return { id: created.data.connection.id as string, key: created.data.key as string, view: created.data.connection };
}

/** The seller form's full update body for the provider shirt (PATCH /listings/:id). */
const sellerBody = (over: Record<string, unknown> = {}) => ({
  title: "قميص كتان أزرق",
  description: `قميص كتان أزرق مريح للاستخدام اليومي ${runId}`,
  category: "أزياء",
  categoryId: "fashion",
  area: "الحصن",
  city: CITY,
  attributes: { condition: "جديد" },
  unitPrice: "12",
  pricingMode: "FIXED",
  availableQuantity: 5,
  inventoryMode: "LIMITED",
  fulfilmentType: "PICKUP",
  imageUrl: "",
  imageUrls: [],
  contactPhone: null,
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  title: "قميص كتان أزرق",
  description: `قميص كتان أزرق مريح للاستخدام اليومي ${runId}`,
  categoryId: "fashion",
  unitPrice: "10",
  currency: "JOD",
  quantity: 5,
  fulfilmentType: "PICKUP",
  area: "الحصن",
  city: CITY,
  attributes: { condition: "جديد" },
  ...over,
});

const results: Record<string, "PASS" | "FAIL"> = {};
async function focused(id: string, name: string, body: () => Promise<void>) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}
const attacks = {
  crossUser: { passed: 0, failed: 0 },
  crossProvider: { passed: 0, failed: 0 },
  crossMarket: { passed: 0, failed: 0 },
  payload: { passed: 0, failed: 0 },
};
function expectRejected(kind: keyof typeof attacks, response: Response, statuses: number[], label: string) {
  const ok = statuses.includes(response.status);
  attacks[kind][ok ? "passed" : "failed"]++;
  assert.ok(ok, `${kind} attack not rejected (${label}): ${response.status} ${response.raw.slice(0, 200)}`);
}
/** Business effects an attack must never produce, measured from the database. */
let unauthorizedEffects = 0;
const bypass = { moderation: 0, sponsored: 0, payment: 0 };

const offer = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0];
const mappingsFor = async (connectionId: string, externalRef: string) =>
  db.select().from(providerResourceMappings).where(and(eq(providerResourceMappings.connectionId, connectionId), eq(providerResourceMappings.externalRef, externalRef)));
const profileOf = async (actor: Actor, marketId = "JO") =>
  (await db.select().from(driverProfiles).where(and(eq(driverProfiles.userId, actor.id), eq(driverProfiles.marketId, marketId))))[0];
const auditActions = async (connectionId: string) =>
  (await db.select().from(marketAudit).where(sql`${marketAudit.data}->>'connectionId' = ${connectionId}`)).map((row) => row.action);
const SQL_LEAK = /duplicate key|violates|constraint|SQLSTATE|syntax error|relation "|select .* from|insert into|update .* set|\bat [\w.<>]+ \(|node_modules|\/home\/|secret_hash|[a-f0-9]{64}/i;

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let admin: Actor, ownerA: Actor, ownerB: Actor, ownerC: Actor, selfSeller: Actor, buyer: Actor, driver: Actor, pendingDriver: Actor, victim: Actor, driverKW: Actor;
const C: Record<string, string> = {};
const K: Record<string, string> = {};
const L: Record<string, string> = {};
const SECRET_ADDRESS = `شارع الأسرار ${runId} بناية 9`;

await test("setup: accounts, admin, JO courier policy", async () => {
  const providerConfigured = Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);
  assert.equal(providerConfigured, false, "G1 runs with external model credentials stripped");
  [admin, ownerA, ownerB, ownerC, selfSeller, buyer, driver, pendingDriver, victim] = await Promise.all(
    ["Admin", "Owner A", "Owner B", "Owner C", "Self Seller", "Buyer", "Driver", "Pending Driver", "Victim"].map((label) => register(label)),
  );
  driverKW = await register("Driver KW", "KW");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  // Market policy fixture: JO enables DINAR courier delivery (as in Block F4).
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
});

// ─── SELF_SERVICE stays the default path ─────────────────────────────────────

await focused("G1-01", "self-service product still creates a canonical Listing", async () => {
  const created = await request("/listings", "POST", {
    title: "حذاء رياضي أبيض", description: `حذاء رياضي أبيض مقاس 42 ${runId}`, category: "أزياء", categoryId: "fashion", area: "الحصن", city: CITY,
    attributes: { condition: "جديد" }, unitPrice: "10", inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, ownerA.cookie);
  assert.equal(created.status, 201, created.raw);
  L.selfA = created.data.id;
  const row = await offer(L.selfA!);
  assert.equal(row?.status, "PUBLISHED");
  assert.equal(row?.sellerId, ownerA.id);
  assert.equal(await listingSource(L.selfA!), "SELF_SERVICE");
  assert.equal((await db.select().from(providerResourceMappings).where(eq(providerResourceMappings.resourceId, L.selfA!))).length, 0);
});

await focused("G1-02", "self-service selling requires no ProviderConnection", async () => {
  const created = await request("/listings", "POST", {
    title: "قميص قطن أحمر", description: `قميص قطن أحمر للبيع ${runId}`, category: "أزياء", categoryId: "fashion", area: "الحصن", city: CITY,
    attributes: {}, unitPrice: "10", inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, selfSeller.cookie);
  assert.equal(created.status, 201, created.raw);
  L.selfOnly = created.data.id;
  assert.equal((await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, selfSeller.id))).length, 0);
  const status = await turn(selfSeller, "اعرض روابط الربط", "management");
  assert.match(status.body, /لا توجد روابط أنظمة بعد/);
  assert.match(status.body, /دون أي ربط/);
});

// ─── Connections: owner and market are the server's ──────────────────────────

await focused("G1-03", "a provider connection's owner is the authenticated actor", async () => {
  // Conversation path: review first, nothing created until «نعم», no model.
  const review = await turn(ownerA, "أريد مفتاح ربط", "management");
  assert.equal(review.payload.surface, "PROVIDER_CONNECTION_REVIEW", review.body);
  assert.match(review.body, /لن يظهر أي مفتاح قبل تأكيدك/);
  assert.equal((await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ownerA.id))).length, 0, "nothing before «نعم»");
  const confirmed = await turn(ownerA, "نعم", "management");
  assert.equal(confirmed.payload.surface, "PROVIDER_SECRET_ONCE", confirmed.body);
  const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ownerA.id));
  assert.ok(connection, "connection created after «نعم»");
  assert.equal(connection.ownerUserId, ownerA.id);
  assert.equal((await db.select().from(providerCredentials).where(eq(providerCredentials.connectionId, connection.id))).length, 0, "the chat itself never issues a key");
  C.A = connection.id;
  K.A = (await issueKey(ownerA, C.A)).key;
  // HTTP path: a body-named owner is refused outright, never read.
  const forged = await request("/provider-connections", "POST", { name: "forged", ownerId: ownerA.id }, ownerB.cookie);
  expectRejected("crossUser", forged, [400], "body.ownerId");
  assert.equal((await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ownerA.id))).length, 1);
  const own = await newConnection(ownerB, { name: "نظام متجر ب" });
  assert.equal((await db.select().from(providerConnections).where(eq(providerConnections.id, own.id)))[0]!.ownerUserId, ownerB.id);
  C.B = own.id;
  K.B = own.key;
  // At the two-connection cap, an additional connection is rejected without
  // changing either existing connection. Revoke only this test-created extra
  // connection so later cases retain their original fixtures.
  const concurrentAdmissions = await Promise.all([
    request("/provider-connections", "POST", { name: "الربط الثاني" }, ownerB.cookie),
    request("/provider-connections", "POST", { name: "الربط الثالث" }, ownerB.cookie),
  ]);
  assert.deepEqual(concurrentAdmissions.map((response) => response.status).sort(), [201, 409]);
  const admitted = concurrentAdmissions.find((response) => response.status === 201)!;
  keys.push(admitted.data.key);
  const ownerBConnections = await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ownerB.id));
  assert.equal(ownerBConnections.length, 2);
  assert.ok(ownerBConnections.every((connection) => connection.status === "ACTIVE"));
  assert.ok(ownerBConnections.some((connection) => connection.id === C.B));
  const [admittedConnection] = ownerBConnections.filter((connection) => connection.id !== C.B);
  assert.equal(admittedConnection!.status, "ACTIVE", "new-admission cap does not disable existing connections");
  await request(`/provider-connections/${admittedConnection!.id}/revoke`, "POST", {}, ownerB.cookie);
  assert.equal(
    (await db.select().from(providerConnections).where(and(eq(providerConnections.ownerUserId, ownerB.id), eq(providerConnections.status, "ACTIVE")))).length,
    1,
    "only the test-created extra connection is explicitly revoked",
  );
  await db.delete(providerCredentials).where(eq(providerCredentials.connectionId, admittedConnection!.id));
  await db.delete(providerConnections).where(eq(providerConnections.id, admittedConnection!.id));
  // Owner B cannot issue, rotate or revoke owner A's connection.
  expectRejected("crossUser", await request(`/provider-connections/${C.A}/credentials`, "POST", {}, ownerB.cookie), [404], "issue foreign key");
  expectRejected("crossUser", await request(`/provider-connections/${C.A}/revoke`, "POST", {}, ownerB.cookie), [404], "revoke foreign connection");
  const listed = await request("/provider-connections", "GET", undefined, ownerB.cookie);
  assert.ok(!listed.raw.includes(C.A), "owner B never sees owner A's connection");
  assert.ok(!keys.some((key) => listed.raw.includes(secretOf(key))));
  // Unauthenticated management is refused.
  assert.equal((await request("/provider-connections", "POST", {})).status, 401);
});

await focused("G1-04", "the connection's market is the owner's active market", async () => {
  const [a] = await db.select().from(providerConnections).where(eq(providerConnections.id, C.A!));
  const [owner] = await db.select().from(users).where(eq(users.id, ownerA.id));
  assert.equal(a!.marketId, owner!.activeMarketId);
  assert.equal(a!.marketId, "JO");
  const kw = await newConnection(driverKW, { name: "KW system" });
  assert.equal(kw.view.marketId, "KW", "a KW owner's connection is a KW connection");
  C.KW = kw.id;
  const sameMarket = await newConnection(ownerC, { name: "C main", marketId: "JO", scopes: ["listings:read", "listings:write", "drivers:link"] });
  assert.equal(sameMarket.view.marketId, "JO", "naming the owner's own market is accepted");
  C.C = sameMarket.id;
  K.C = sameMarket.key;
});

await focused("G1-05", "a cross-market connection attempt is rejected", async () => {
  const before = (await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ownerB.id))).length;
  expectRejected("crossMarket", await request("/provider-connections", "POST", { name: "foreign", marketId: "KW" }, ownerB.cookie), [409], "body.marketId=KW");
  expectRejected("crossMarket", await request("/provider-connections", "POST", { name: "foreign", marketId: "SA" }, ownerB.cookie), [409], "body.marketId=SA");
  assert.equal((await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ownerB.id))).length, before);
});

// ─── Credentials ─────────────────────────────────────────────────────────────

await focused("G1-06", "credential secrets are generated securely", async () => {
  const scratch = await newConnection(ownerB, { name: "scratch" });
  C.scratch = scratch.id;
  const issued = [scratch.key];
  for (let n = 0; n < 4; n++) issued.push((await issueKey(ownerB, scratch.id)).key);
  for (const key of issued) {
    assert.match(key, /^dnr_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secretOf(key), "base64url").length, 32, "256-bit secret");
  }
  assert.equal(new Set(issued).size, issued.length);
  assert.equal(new Set(issued.map((key) => key.slice(4, 20))).size, issued.length, "distinct public key ids");
  const rows = await db.select().from(providerCredentials).where(eq(providerCredentials.connectionId, scratch.id));
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => !row.revokedAt).length, 1, "one active key per connection");
  for (const row of rows) assert.match(row.secretHash, /^[a-f0-9]{64}$/);
  // The source never compares secrets with ===; it uses timingSafeEqual on hashes.
  const source = readFileSync("src/lib/provider-connections.ts", "utf8");
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /randomBytes\(32\)/);
  assert.equal((await request(`/provider-connections/${scratch.id}/revoke`, "POST", {}, ownerB.cookie)).status, 200);
});

await focused("G1-07", "plaintext credentials are never stored", async () => {
  const secrets = keys.map(secretOf);
  const credentialRows = JSON.stringify(await db.select().from(providerCredentials));
  const connectionRows = JSON.stringify(await db.select().from(providerConnections));
  const auditRows = JSON.stringify(await db.select().from(marketAudit).where(like(marketAudit.action, "PROVIDER_%")));
  for (const secret of secrets) {
    assert.ok(!credentialRows.includes(secret));
    assert.ok(!connectionRows.includes(secret));
    assert.ok(!auditRows.includes(secret));
  }
  assert.equal(await dbOccurrences(secrets), 0);
  const columns = (await db.execute(sql`select column_name from information_schema.columns where table_name = 'provider_credentials'`)).rows.map((row: any) => row.column_name).sort();
  assert.deepEqual(columns, ["connection_id", "created_at", "id", "key_id", "revoked_at", "secret_hash"]);
});

await focused("G1-08", "the full key is returned only by the call that issued it", async () => {
  const secret = secretOf(K.A!);
  const surfaces = [
    await request("/provider-connections", "GET", undefined, ownerA.cookie),
    await api(K.A!, "/connection"),
    await request(`/ai/conversations/${ownerA.conv}`, "GET", undefined, ownerA.cookie),
  ];
  const status = await turn(ownerA, "اعرض روابط الربط", "management");
  assert.equal(status.payload.surface, "PROVIDER_STATUS");
  const keyPrefix = K.A!.slice(0, 20);
  assert.ok(status.raw.includes(keyPrefix), "status shows the safe prefix");
  for (const raw of [...surfaces.map((response) => response.raw), status.raw]) assert.ok(!raw.includes(secret), "no ordinary read returns the secret");
  assert.equal(surfaces[0]!.data.connections[0].keyPrefix, keyPrefix);
  const health = await turn(ownerA, "ما حالة الربط؟", "management");
  assert.equal(health.payload.surface, "PROVIDER_STATUS", health.body);
  assert.ok(!health.raw.includes(secret));
});

await focused("G1-09", "rotation works and the old key is rejected", async () => {
  const oldKey = K.A!;
  assert.equal((await api(oldKey, "/connection")).status, 200);
  const review = await turn(ownerA, "بدل المفتاح", "management");
  assert.equal(review.payload.surface, "PROVIDER_CONNECTION_REVIEW", review.body);
  assert.equal((await api(oldKey, "/connection")).status, 200, "nothing changes before «نعم»");
  const done = await turn(ownerA, "نعم", "management");
  assert.equal(done.payload.surface, "PROVIDER_SECRET_ONCE", done.body);
  const revoked = await api(oldKey, "/connection");
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.code, "REVOKED_CREDENTIAL");
  const fresh = await issueKey(ownerA, C.A!);
  assert.equal(fresh.rotated, false, "the old key was already revoked by the review");
  K.A = fresh.key;
  assert.equal((await api(K.A, "/connection")).status, 200);
  // Direct rotation through the session route revokes the previous key atomically.
  const direct = await issueKey(ownerA, C.A!);
  assert.equal(direct.rotated, true);
  assert.equal((await api(K.A, "/connection")).status, 401);
  K.A = direct.key;
  assert.equal((await api(K.A, "/connection")).status, 200);
  assert.equal((await api(oldKey, "/connection")).status, 401);
  const actions = await auditActions(C.A!);
  for (const action of ["PROVIDER_CONNECTION_CREATED", "PROVIDER_CREDENTIAL_CREATED", "PROVIDER_CREDENTIAL_REVOKED", "PROVIDER_CREDENTIAL_ROTATED"]) assert.ok(actions.includes(action), action);
});

await focused("G1-10", "revocation works, revoked keys are rejected, and keys cannot be enumerated", async () => {
  const doomed = await newConnection(ownerB, { name: "doomed" });
  assert.equal((await api(doomed.key, "/listings/tmp-1", "PUT", item({ title: "مؤقت للاختبار" }))).status, 201);
  const revoked = await request(`/provider-connections/${doomed.id}/revoke`, "POST", {}, ownerB.cookie);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.connection.status, "REVOKED");
  assert.equal(revoked.data.connection.keyPrefix, null);
  const rejected = await api(doomed.key, "/connection");
  assert.equal(rejected.status, 401);
  assert.equal(rejected.data.code, "REVOKED_CREDENTIAL");
  assert.equal((await api(doomed.key, "/listings/tmp-1", "PUT", item({ title: "تعديل بعد الإيقاف" }))).status, 401);
  assert.equal((await offer(providerListingId(doomed.id, "tmp-1")))!.data.title, "مؤقت للاختبار", "no write after revocation");
  // Enumeration: unknown prefix, known prefix with a wrong secret, revoked prefix with a
  // wrong secret and garbage all produce the same response.
  const xff = { "X-Forwarded-For": `203.0.113.${(Date.now() % 200) + 20}` };
  const wrongSecret = (key: string) => `${key.slice(0, 21)}${randomBytes(32).toString("base64url")}`;
  const probes = [
    await api(`dnr_${randomBytes(8).toString("hex")}_${randomBytes(32).toString("base64url")}`, "/connection", "GET", undefined, xff),
    await api(wrongSecret(K.A!), "/connection", "GET", undefined, xff),
    await api(wrongSecret(doomed.key), "/connection", "GET", undefined, xff),
    await api("not-a-key", "/connection", "GET", undefined, xff),
    await request("/provider/connection", "GET", undefined, "", xff),
  ];
  for (const probe of probes) {
    assert.equal(probe.status, 401);
    assert.equal(probe.raw, probes[0]!.raw, "identical response for every invalid key");
  }
  assert.equal(probes[0]!.data.code, "INVALID_CREDENTIAL");
});

// ─── Listings ────────────────────────────────────────────────────────────────

await focused("G1-11", "a provider listing becomes a canonical Listing", async () => {
  const shirt = await api(K.A!, "/listings/shirt-1", "PUT", item());
  assert.equal(shirt.status, 201, shirt.raw);
  assert.equal(shirt.data.result, "CREATED");
  L.shirtA = shirt.data.listing.id;
  assert.equal(L.shirtA, providerListingId(C.A!, "shirt-1"));
  const row = await offer(L.shirtA!);
  assert.equal(row?.status, "PUBLISHED");
  assert.equal(row?.sellerId, ownerA.id);
  assert.equal(row?.marketId, "JO");
  assert.equal(row?.unitPriceMinor, 10_000);
  assert.equal(row?.availableQuantity, 5);
  assert.equal(await listingSource(L.shirtA!), "PROVIDER");
  assert.equal((await mappingsFor(C.A!, "shirt-1")).length, 1);
  // Electronics through the same path, no category engine.
  const phone = await api(K.A!, "/listings/phone-1", "PUT", item({
    title: "سماعات بلوتوث لاسلكية", description: `سماعات بلوتوث لاسلكية بعلبتها ${runId}`, categoryId: "electronics", unitPrice: "25", quantity: 3, attributes: { condition: "جديد" },
  }));
  assert.equal(phone.status, 201, phone.raw);
  L.phoneA = phone.data.listing.id;
  assert.equal((await offer(L.phoneA!))!.data.categoryId, "electronics");
  // The public listing detail is the ordinary one.
  const detail = await request(`/listings/${L.shirtA}`, "GET", undefined, buyer.cookie);
  assert.equal(detail.status, 200, detail.raw);
  assert.equal(detail.data.id, L.shirtA);
  assert.ok((await auditActions(C.A!)).includes("PROVIDER_LISTING_CREATED"));
  const read = await api(K.A!, "/listings/shirt-1");
  assert.equal(read.status, 200);
  assert.equal(read.data.listing.id, L.shirtA);
});

await focused("G1-12", "retrying the same externalRef never duplicates", async () => {
  const before = (await db.select().from(offers).where(eq(offers.sellerId, ownerA.id))).length;
  for (let n = 0; n < 10; n++) {
    const retry = await api(K.A!, "/listings/shirt-1", "PUT", item());
    assert.equal(retry.status, 200, retry.raw);
    assert.equal(retry.data.result, "UNCHANGED");
    assert.equal(retry.data.listing.id, L.shirtA);
  }
  const batch = await api(K.A!, "/listings/batch", "POST", { items: [{ externalRef: "shirt-1", listing: item() }, { externalRef: "phone-1", listing: item({ title: "سماعات بلوتوث لاسلكية", description: `سماعات بلوتوث لاسلكية بعلبتها ${runId}`, categoryId: "electronics", unitPrice: "25", quantity: 3 }) }] });
  assert.equal(batch.status, 200, batch.raw);
  assert.deepEqual(batch.data.results.map((row: any) => row.listingId), [L.shirtA, L.phoneA]);
  assert.equal((await db.select().from(offers).where(eq(offers.sellerId, ownerA.id))).length, before);
  assert.equal((await mappingsFor(C.A!, "shirt-1")).length, 1);
});

await focused("G1-13", "real concurrent pushes of one externalRef create exactly one resource", async () => {
  const concurrent = { id: C.C!, key: K.C! };
  C.Cc = concurrent.id;
  const body = item({ title: "حقيبة جلد بنية", description: `حقيبة جلد بنية متينة ${runId}`, categoryId: "other" });
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => request("/provider/listings/bag-1", "PUT", body, "", { Authorization: `Bearer ${concurrent.key}` })),
  );
  for (const response of responses) providerResponses.push(response.raw);
  const statuses = responses.map((response) => response.status).sort();
  console.log("G1_CONCURRENCY_SAME_REF", JSON.stringify({ statuses }));
  assert.ok(responses.every((response) => response.status === 200 || response.status === 201), JSON.stringify(statuses));
  assert.equal(responses.filter((response) => response.data?.result === "CREATED").length, 1);
  const id = providerListingId(concurrent.id, "bag-1");
  assert.ok(responses.every((response) => response.data.listing.id === id));
  const listings = await db.select().from(offers).where(and(eq(offers.sellerId, ownerC.id), sql`${offers.data}->>'title' = 'حقيبة جلد بنية'`));
  const mappings = await mappingsFor(concurrent.id, "bag-1");
  console.log("G1_CONCURRENCY_COUNTS", JSON.stringify({ listings: listings.length, mappings: mappings.length }));
  assert.equal(listings.length, 1);
  assert.equal(mappings.length, 1);
  for (const response of responses) assert.doesNotMatch(response.raw, SQL_LEAK);
  // Different references on one connection, concurrently: independent and deadlock-free.
  const parallel = concurrent;
  C.Cp = parallel.id;
  const spread = await Promise.all(
    Array.from({ length: 10 }, (_, n) =>
      request(`/provider/listings/cup-${n}`, "PUT", item({ title: `كوب سيراميك ${n}`, description: `كوب سيراميك رقم ${n} ${runId}`, categoryId: "other" }), "", { Authorization: `Bearer ${parallel.key}` })),
  );
  for (const response of spread) providerResponses.push(response.raw);
  console.log("G1_CONCURRENCY_DISTINCT_REFS", JSON.stringify({ statuses: spread.map((response) => response.status).sort() }));
  assert.ok(spread.every((response) => response.status === 201), JSON.stringify(spread.map((response) => [response.status, response.data?.code])));
  assert.equal(
    (await db.select().from(providerResourceMappings).where(and(
      eq(providerResourceMappings.connectionId, parallel.id),
      like(providerResourceMappings.externalRef, "cup-%"),
    ))).length,
    10,
  );
  for (const response of spread) assert.doesNotMatch(response.raw, SQL_LEAK);
});

await focused("G1-14", "the same externalRef under two providers stays isolated", async () => {
  const b = await api(K.B!, "/listings/shirt-1", "PUT", item({ title: "قميص كتان رمادي", description: `قميص كتان رمادي من متجر ب ${runId}` }));
  assert.equal(b.status, 201, b.raw);
  L.shirtB = b.data.listing.id;
  assert.notEqual(L.shirtB, L.shirtA);
  assert.equal((await offer(L.shirtB!))!.sellerId, ownerB.id);
  assert.equal((await offer(L.shirtA!))!.data.title, "قميص كتان أزرق", "A's listing is untouched");
  const [mapA] = await mappingsFor(C.A!, "shirt-1");
  const [mapB] = await mappingsFor(C.B!, "shirt-1");
  assert.equal(mapA!.resourceId, L.shirtA);
  assert.equal(mapB!.resourceId, L.shirtB);
});

await focused("G1-15", "a provider cannot read or modify another provider's resource", async () => {
  expectRejected("crossProvider", await api(K.B!, "/listings/phone-1"), [404], "read A's ref");
  expectRejected("crossProvider", await api(K.B!, "/listings/phone-1", "DELETE"), [404], "archive A's ref");
  expectRejected("crossProvider", await api(K.B!, "/listings/shirt-9", "PUT", { ...item(), listingId: L.shirtA }), [400], "body.listingId");
  expectRejected("crossProvider", await api(K.B!, "/listings/shirt-9", "PUT", { ...item(), providerConnectionId: C.A }), [400], "body.providerConnectionId");
  expectRejected("crossProvider", await api(K.B!, "/listings/shirt-9", "PUT", { ...item(), sellerId: ownerA.id }), [400], "body.sellerId");
  expectRejected("crossProvider", await api(K.B!, "/listings/shirt-9", "PUT", { ...item(), ownerId: ownerA.id }), [400], "body.ownerId");
  expectRejected("crossProvider", await request(`/listings/${L.shirtA}`, "PATCH", sellerBody({ unitPrice: "1", availableQuantity: 5 }), ownerB.cookie), [403, 404], "session PATCH of A's listing");
  const a = await offer(L.shirtA!);
  assert.equal(a!.unitPriceMinor, 10_000);
  assert.equal(a!.status, "PUBLISHED");
  assert.equal((await mappingsFor(C.B!, "shirt-9")).length, 0);
});

await focused("G1-16", "a provider cannot reach a resource outside its connection's market", async () => {
  // Owner A has a self-service listing in KW; nothing in the JO connection can name it.
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, ownerA.cookie)).status, 200);
  const kw = await request("/listings", "POST", {
    title: "مكتب خشبي صغير", description: `مكتب خشبي صغير ${runId}`, category: "أخرى", categoryId: "other", area: "حولي", city: "الكويت",
    attributes: {}, unitPrice: "8", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, ownerA.cookie);
  assert.equal(kw.status, 201, kw.raw);
  L.kwA = kw.data.id;
  // While the owner acts in KW the JO connection is frozen.
  const frozen = await api(K.A!, "/listings/shirt-1", "PUT", item({ unitPrice: "1" }));
  expectRejected("crossMarket", frozen, [409], "owner moved to KW");
  assert.equal(frozen.data.code, "MARKET_MISMATCH");
  assert.equal((await offer(L.shirtA!))!.unitPriceMinor, 10_000);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, ownerA.cookie)).status, 200);
  expectRejected("crossMarket", await api(K.A!, "/listings/desk-1", "PUT", { ...item(), marketId: "KW" }), [400], "body.marketId");
  expectRejected("crossMarket", await api(K.A!, "/listings/desk-1", "PUT", { ...item(), listingId: L.kwA }), [400], "body.listingId (KW)");
  expectRejected("crossMarket", await api(K.A!, "/listings/desk-1", "PUT", item({ currency: "KWD" })), [400], "foreign currency");
  const kwRow = await offer(L.kwA!);
  assert.equal(kwRow!.marketId, "KW");
  assert.equal(kwRow!.data.title, "مكتب خشبي صغير");
  assert.equal((await mappingsFor(C.A!, "desk-1")).length, 0);
  // A KW key cannot write into JO either: its listing lands in KW, priced in KWD.
  const kwKey = await issueKey(driverKW, C.KW!);
  expectRejected("crossMarket", await api(kwKey.key, "/listings/x-1", "PUT", item()), [400], "JOD into KW connection");
  assert.equal((await api(K.A!, "/listings/shirt-1", "PUT", item())).status, 200, "back in JO the connection works again");
});

await focused("G1-17", "provider price follows the source policy", async () => {
  const pushed = await api(K.A!, "/listings/shirt-1", "PUT", item({ unitPrice: "12" }));
  assert.equal(pushed.status, 200, pushed.raw);
  assert.equal(pushed.data.result, "UPDATED");
  assert.equal((await offer(L.shirtA!))!.unitPriceMinor, 12_000);
  // The seller's HTTP edit of a synchronized price is refused, nothing saved.
  const patch = await request(`/listings/${L.shirtA}`, "PATCH", sellerBody({ unitPrice: "9" }), ownerA.cookie);
  assert.equal(patch.status, 409, patch.raw);
  assert.match(patch.data.error, /السعر متزامن/);
  assert.equal((await offer(L.shirtA!))!.unitPriceMinor, 12_000);
  // The chat refuses too, before any review is staged.
  const mine = await turn(ownerA, "اعرض لي إعلاناتي");
  assert.equal(mine.payload.surface, "MY_LISTINGS", mine.body);
  const ids: string[] = mine.payload.resourceIds ?? mine.payload.listings.map((listing: any) => listing.id);
  const change = await turn(ownerA, `غير سعر الإعلان رقم ${ids.indexOf(L.shirtA!) + 1} إلى 9`);
  assert.match(change.body, /متزامن من نظامك/);
  await turn(ownerA, "نعم");
  assert.equal((await offer(L.shirtA!))!.unitPriceMinor, 12_000, "chat never overrides the synced price");
  // A DINAR-side field (contact visibility) stays the seller's.
  const contact = await request(`/listings/${L.shirtA}`, "PATCH", sellerBody({ contactPhone: "+962791234567" }), ownerA.cookie);
  assert.equal(contact.status, 200, contact.raw);
  assert.equal((await offer(L.shirtA!))!.unitPriceMinor, 12_000);
  assert.equal((await request(`/listings/${L.shirtA}`, "PATCH", sellerBody({ contactPhone: null }), ownerA.cookie)).status, 200);
});

await focused("G1-18", "provider inventory follows the source policy", async () => {
  const pushed = await api(K.A!, "/listings/shirt-1", "PUT", item({ unitPrice: "12", quantity: 7 }));
  assert.equal(pushed.data.result, "UPDATED", pushed.raw);
  assert.equal((await offer(L.shirtA!))!.availableQuantity, 7);
  const patch = await request(`/listings/${L.shirtA}`, "PATCH", sellerBody({ availableQuantity: 2 }), ownerA.cookie);
  assert.equal(patch.status, 409, patch.raw);
  assert.match(patch.data.error, /الكمية متزامنة/);
  assert.equal((await offer(L.shirtA!))!.availableQuantity, 7);
});

const ATTACK_FIELDS: Record<string, unknown> = {
  ownerId: "foreign", sellerId: "foreign", marketId: "KW", providerConnectionId: "foreign", listingId: "foreign", driverId: "foreign",
  approved: true, sponsored: true, promoted: true, rankBoost: 999, paid: true, paymentStatus: "SUCCESS", paymentIntentStatus: "CAPTURED",
  commissionBps: 0, moderationApproved: true, sourceType: "SELF_SERVICE", status: "PUBLISHED", isSponsored: true, verified: true,
};
async function attackPayloads(ref: string) {
  for (const [field, value] of Object.entries(ATTACK_FIELDS)) {
    const before = await offer(L.shirtA!);
    const response = await api(K.A!, `/listings/${ref}`, "PUT", { ...item(), [field]: value });
    expectRejected("payload", response, [400], field);
    const after = await offer(L.shirtA!);
    if ((await mappingsFor(C.A!, ref)).length || JSON.stringify(after) !== JSON.stringify(before)) unauthorizedEffects++;
  }
}

await focused("G1-19", "a provider cannot bypass moderation or publication policy", async () => {
  await attackPayloads("attack-1");
  // Admin hides the listing; the provider can neither edit nor un-hide it.
  const hidden = await request(`/admin/listings/${L.shirtA}/moderation`, "POST", { action: "HIDE", reason: "مراجعة اختبار G1" }, admin.cookie);
  assert.equal(hidden.status, 200, hidden.raw);
  const push = await api(K.A!, "/listings/shirt-1", "PUT", item({ unitPrice: "13", quantity: 7 }));
  assert.equal(push.status, 409, push.raw);
  const archive = await api(K.A!, "/listings/shirt-1", "DELETE");
  assert.equal(archive.status, 409, archive.raw);
  const row = await offer(L.shirtA!);
  if (row!.status !== "MODERATION_HIDDEN" || row!.unitPriceMinor !== 12_000) bypass.moderation++;
  assert.equal(row!.status, "MODERATION_HIDDEN");
  assert.equal(row!.unitPriceMinor, 12_000);
  assert.equal((await request(`/admin/listings/${L.shirtA}/moderation`, "POST", { action: "RESTORE", reason: "انتهت المراجعة" }, admin.cookie)).status, 200);
  // A market-restricted category is refused for the provider exactly as for the seller form.
  await db.execute(sql`update markets set restricted_categories = '["cars"]'::jsonb where id = 'JO'`);
  try {
    const restricted = await api(K.A!, "/listings/car-1", "PUT", item({ title: "سيارة سيدان", description: `سيارة سيدان نظيفة ${runId}`, categoryId: "cars", attributes: {} }));
    assert.ok([400, 409].includes(restricted.status), restricted.raw);
    if ((await mappingsFor(C.A!, "car-1")).length) bypass.moderation++;
    assert.equal((await db.select().from(offers).where(eq(offers.id, providerListingId(C.A!, "car-1")))).length, 0);
  } finally {
    await db.execute(sql`update markets set restricted_categories = '[]'::jsonb where id = 'JO'`);
  }
  assert.ok((await auditActions(C.A!)).includes("PROVIDER_RESOURCE_REJECTED"));
  assert.equal(bypass.moderation, 0);
});

await focused("G1-20", "a provider cannot set sponsored state", async () => {
  for (const field of ["sponsored", "promoted", "rankBoost", "isSponsored"]) {
    const response = await api(K.A!, "/listings/shirt-1", "PUT", { ...item({ unitPrice: "12", quantity: 7 }), [field]: field === "rankBoost" ? 999 : true });
    expectRejected("payload", response, [400], field);
  }
  const batch = await api(K.A!, "/listings/batch", "POST", { items: [{ externalRef: "shirt-1", listing: { ...item(), sponsored: true } }] });
  assert.equal(batch.status, 200);
  assert.equal(batch.data.results[0].ok, false);
  const promotions = await db.select().from(listingPromotions).where(inArray(listingPromotions.listingId, [L.shirtA!, L.phoneA!]));
  bypass.sponsored += promotions.length;
  assert.equal(promotions.length, 0, "no promotion from a provider payload");
});

await focused("G1-21", "a provider cannot set paid or payment success", async () => {
  const intentsBefore = (await db.select().from(paymentIntents)).length;
  const ordersBefore = (await db.select().from(orders)).length;
  for (const field of ["paid", "paymentStatus", "paymentIntentStatus", "commissionBps"]) {
    const response = await api(K.A!, "/listings/shirt-1", "PUT", { ...item({ unitPrice: "12", quantity: 7 }), [field]: field === "commissionBps" ? 0 : field === "paid" ? true : "SUCCESS" });
    expectRejected("payload", response, [400], field);
  }
  for (const path of ["/orders", "/payments", "/payments/intents", "/promotions", "/users", "/drivers"]) {
    const response = await api(K.A!, path, "POST", { orderId: "x", status: "CAPTURED" });
    assert.equal(response.status, 404, `${path} is not a provider capability`);
  }
  const intentsAfter = (await db.select().from(paymentIntents)).length;
  const ordersAfter = (await db.select().from(orders)).length;
  bypass.payment += intentsAfter - intentsBefore + ordersAfter - ordersBefore;
  assert.equal(bypass.payment, 0);
});

await focused("G1-22", "a provider service becomes a canonical service Listing found by buyer search", async () => {
  const service = await api(K.A!, "/listings/ac-repair-1", "PUT", item({
    title: "تصليح مكيفات", description: `فني تصليح مكيفات وصيانة دورية للمنازل ${runId}`, categoryId: "services", unitPrice: "15", quantity: null, fulfilmentType: "SERVICE", attributes: {},
  }));
  assert.equal(service.status, 201, service.raw);
  L.acA = service.data.listing.id;
  const row = await offer(L.acA!);
  assert.equal(row!.data.categoryId, "services");
  assert.equal(row!.data.fulfilmentType, "SERVICE");
  assert.equal(row!.unitPriceMinor, 15_000);
  const found = await turn(buyer, "أريد فني مكيفات");
  const ids = (found.payload.listings ?? []).map((listing: any) => listing.id);
  assert.ok(ids.includes(L.acA), `service found: ${found.body}`);
});

await focused("G1-23", "a generic Other provider item works", async () => {
  const unknown = await api(K.A!, "/listings/misc-1", "PUT", item({ title: "مجسم ديكور معدني", description: `مجسم ديكور معدني للمكتب ${runId}`, categoryId: "gadget-unknown-xyz", attributes: {} }));
  assert.equal(unknown.status, 201, unknown.raw);
  assert.equal((await offer(unknown.data.listing.id))!.data.categoryId, "other", "an unknown category is generic Other");
  const named = await api(K.A!, "/listings/misc-2", "PUT", item({ title: "ميدالية مفاتيح جلد", description: `ميدالية مفاتيح جلد يدوية ${runId}`, categoryId: "other", attributes: {} }));
  assert.equal(named.status, 201, named.raw);
  assert.equal((await offer(named.data.listing.id))!.data.categoryId, "other");
});

await focused("G1-24", "provider API model calls = 0", async () => {
  assert.equal(modelCalls.providerApi, 0);
  assert.equal(modelCalls.management, 0);
  // The provider modules import nothing from the model gateway.
  for (const file of ["src/lib/provider-connections.ts", "src/lib/provider-sync.ts", "src/lib/provider-source.ts", "src/routes/provider.ts", "src/ai/provider-turn.ts"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /model-gateway|openai|anthropic/i, file);
});

await focused("G1-25", "buyer search reads provider listings from the local canonical DB only", async () => {
  const externalBefore = external.length;
  const found = await turn(buyer, "أريد قميص كتان");
  const ids = (found.payload.listings ?? []).map((listing: any) => listing.id);
  assert.ok(ids.includes(L.shirtA) && ids.includes(L.shirtB), `provider listings in normal search: ${found.body}`);
  const card = found.payload.listings.find((listing: any) => listing.id === L.shirtA);
  assert.doesNotMatch(JSON.stringify(card), /externalRef|connectionId|providerConnection|PROVIDER|dnr_/);
  assert.notEqual(card.isSponsored, true, "organic by default");
  assert.equal(external.length, externalBefore, "no outbound provider call during search");
  for (const file of ["src/lib/provider-connections.ts", "src/lib/provider-sync.ts", "src/routes/provider.ts"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /\bfetch\(|https?:\/\/|setInterval|node:https?|axios/, `${file} makes no outbound calls`);
});

await focused("G1-26", "a buyer purchases a provider listing through the existing Order and Payment authorities", async () => {
  const providerOrder = await request("/orders", "POST", { listingId: L.phoneA, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `g1-${randomUUID()}` }, buyer.cookie);
  assert.equal(providerOrder.status, 201, providerOrder.raw);
  const twin = await request("/listings", "POST", {
    title: "سماعات سلكية", description: `سماعات سلكية ${runId}`, category: "إلكترونيات", categoryId: "electronics", area: "الحصن", city: CITY,
    attributes: {}, unitPrice: "25", inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, selfSeller.cookie);
  const selfOrder = await request("/orders", "POST", { listingId: twin.data.id, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `g1-${randomUUID()}` }, buyer.cookie);
  assert.equal(selfOrder.status, 201, selfOrder.raw);
  const [p] = await db.select().from(orders).where(eq(orders.id, providerOrder.data.id));
  const [s] = await db.select().from(orders).where(eq(orders.id, selfOrder.data.id));
  assert.equal(p!.sellerId, ownerA.id);
  assert.equal(p!.subtotalMinor, s!.subtotalMinor);
  assert.equal(p!.platformFeeMinor, s!.platformFeeMinor, "same commission rule as SELF_SERVICE");
  assert.equal(p!.sellerAmountMinor, s!.sellerAmountMinor);
  assert.equal((await offer(L.phoneA!))!.reservedQuantity, 1, "canonical inventory reservation");
  const intent = await request("/payments/intents", "POST", { orderId: providerOrder.data.id }, buyer.cookie, { "Idempotency-Key": `g1-pay-${randomUUID()}` });
  assert.equal(intent.status, 201, intent.raw);
  const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, providerOrder.data.id));
  assert.equal(row!.status, "SIMULATION_PENDING");
  assert.equal(row!.mode, "SIMULATION_ONLY");
  L.providerOrder = providerOrder.data.id;
  // A provider re-push keeps the same listing and does not touch the order.
  assert.equal((await api(K.A!, "/listings/phone-1", "PUT", item({ title: "سماعات بلوتوث لاسلكية", description: `سماعات بلوتوث لاسلكية بعلبتها ${runId}`, categoryId: "electronics", unitPrice: "26", quantity: 3 }))).status, 200);
  const [after] = await db.select().from(orders).where(eq(orders.id, providerOrder.data.id));
  assert.equal(after!.unitPriceMinor, p!.unitPriceMinor, "order price is a snapshot");
});

await focused("G1-35a", "provider listings are promotable only through Block E", async () => {
  const product = await request("/admin/markets/JO/promotion-products", "POST", { categoryId: "fashion", name: `G1 ${runId}`, placement: "SEARCH_AND_CHAT", priceMinor: 1500, durationDays: 7, enabled: true }, admin.cookie);
  assert.equal(product.status, 201, product.raw);
  const preview = await request(`/listings/${L.shirtA}/promotion-preview`, "POST", { promotionProductId: product.data.id }, ownerA.cookie);
  assert.equal(preview.status, 200, preview.raw);
  const bought = await request(`/listings/${L.shirtA}/promotions`, "POST", { promotionProductId: product.data.id, confirmed: true, idempotencyKey: `g1:${randomUUID()}` }, ownerA.cookie);
  assert.equal(bought.status, 201, bought.raw);
  const [campaign] = await db.select().from(listingPromotions).where(eq(listingPromotions.listingId, L.shirtA!));
  assert.equal(campaign!.paymentStatus, "SIMULATION_CAPTURED");
  // A later provider push neither creates nor removes promotion state.
  assert.equal((await api(K.A!, "/listings/shirt-1", "PUT", item({ unitPrice: "12", quantity: 6 }))).status, 200);
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.listingId, L.shirtA!))).length, 1);
});

// ─── Drivers: link only ──────────────────────────────────────────────────────

async function onboard(actor: Actor) {
  await db.update(users).set({ city: CITY }).where(eq(users.id, actor.id));
  const review = await turn(actor, "أريد أكون سائق بسيارة");
  assert.equal(review.payload.surface, "DRIVER_ONBOARDING_REVIEW", review.body);
  await turn(actor, "نعم");
  assert.equal((await profileOf(actor))!.status, "PENDING_VERIFICATION");
}

await focused("G1-28", "a provider cannot create a ghost DINAR user or DriverProfile", async () => {
  const usersBefore = (await db.select().from(users)).length;
  const profilesBefore = (await db.select().from(driverProfiles)).length;
  for (const body of [
    { externalRef: "ghost-1", name: "سائق وهمي", phone: "+96551999999" },
    { externalRef: "ghost-1", userId: randomUUID() },
    { externalRef: "ghost-1", driverId: randomUUID(), status: "APPROVED" },
    { externalRef: "ghost-1", linkCode: "dlk_abcdefghijklmnopqrstuvwxyz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  ]) expectRejected("payload", await api(K.C!, "/drivers/link", "POST", body), [400], JSON.stringify(Object.keys(body)));
  for (const path of ["/drivers", "/users", "/drivers/register"]) assert.equal((await api(K.C!, path, "POST", { name: "x" })).status, 404, path);
  assert.equal((await db.select().from(users)).length, usersBefore, "ghost users = 0");
  assert.equal((await db.select().from(driverProfiles)).length, profilesBefore);
});

await focused("G1-29", "a provider cannot link an arbitrary DriverProfile", async () => {
  await onboard(victim);
  const victimProfile = (await profileOf(victim))!;
  // Victim's identity without the victim's consent code: phone, ids, forged and expired codes.
  const forge = (profileId: string, marketId: string, expiresAt: number) => {
    const payload = Buffer.from(`${profileId}|${marketId}|${expiresAt}|${randomBytes(6).toString("hex")}`).toString("base64url");
    return { payload, signature: (secret: string) => createHmac("sha256", secret).update(`dinar-driver-link\0${payload}`).digest("base64url") };
  };
  const unsigned = forge(victimProfile.id, "JO", Date.now() + 60_000);
  const expired = forge(victimProfile.id, "JO", Date.now() - 1_000);
  for (const body of [
    { externalRef: "victim-1", phone: victim.phone },
    { externalRef: "victim-1", userId: victim.id },
    { externalRef: "victim-1", driverId: victimProfile.id },
    { externalRef: "victim-1", linkCode: `dlk_${unsigned.payload}.${randomBytes(32).toString("base64url")}` },
    { externalRef: "victim-1", linkCode: `dlk_${expired.payload}.${expired.signature(process.env.SESSION_SECRET!)}` },
  ]) expectRejected("crossUser", await api(K.C!, "/drivers/link", "POST", body), [400], JSON.stringify(Object.keys(body)));
  // Another driver's real code with the victim's profile id swapped in is not valid.
  const own = await request("/account/driver-link-code", "POST", {}, victim.cookie);
  assert.equal(own.status, 201, own.raw);
  const [codePayload, signature] = own.data.linkCode.slice(4).split(".");
  const swapped = Buffer.from(Buffer.from(codePayload, "base64url").toString("utf8").replace(victimProfile.id, randomUUID())).toString("base64url");
  expectRejected("crossUser", await api(K.C!, "/drivers/link", "POST", { externalRef: "victim-1", linkCode: `dlk_${swapped}.${signature}` }), [400], "tampered code");
  // A JO code cannot be used by a KW connection; a connection without the scope is refused.
  expectRejected("crossProvider", await api(K.A!, "/drivers/link", "POST", { externalRef: "victim-1", linkCode: own.data.linkCode }), [403], "missing drivers:link scope");
  assert.equal((await db.select().from(providerResourceMappings).where(eq(providerResourceMappings.resourceId, victimProfile.id))).length, 0, "arbitrary driver links = 0");
  // A KW driver's code against a JO connection: market mismatch.
  await db.update(users).set({ city: CITY }).where(eq(users.id, driverKW.id));
  await turn(driverKW, "أريد أكون سائق بسيارة");
  await turn(driverKW, "نعم");
  const kwCode = await request("/account/driver-link-code", "POST", {}, driverKW.cookie);
  assert.equal(kwCode.status, 201, kwCode.raw);
  expectRejected("crossMarket", await api(K.C!, "/drivers/link", "POST", { externalRef: "kw-1", linkCode: kwCode.data.linkCode }), [409], "KW driver into JO");
  // An account with no DriverProfile cannot even issue a code.
  assert.equal((await request("/account/driver-link-code", "POST", {}, buyer.cookie)).status, 409);
});

await focused("G1-30", "an authorized real DINAR driver links through the consent code", async () => {
  await onboard(driver);
  const approved = await request(`/admin/drivers/${(await profileOf(driver))!.id}/review`, "POST", { decision: "APPROVE" }, admin.cookie);
  assert.equal(approved.status, 200, approved.raw);
  const before = await profileOf(driver);
  const code = await request("/account/driver-link-code", "POST", {}, driver.cookie);
  assert.equal(code.status, 201, code.raw);
  const linked = await api(K.C!, "/drivers/link", "POST", { externalRef: "drv-1", linkCode: code.data.linkCode });
  assert.equal(linked.status, 200, linked.raw);
  assert.deepEqual(Object.keys(linked.data).sort(), ["availability", "externalRef", "serviceCity", "status", "vehicleType"]);
  assert.equal(linked.data.status, "APPROVED");
  const after = await profileOf(driver);
  assert.deepEqual({ ...after, updatedAt: null }, { ...before, updatedAt: null }, "linking changes nothing on the DriverProfile");
  assert.equal((await db.select().from(providerResourceMappings).where(eq(providerResourceMappings.resourceId, before!.id))).length, 1);
  // Idempotent re-link; a second provider cannot take the same driver.
  assert.equal((await api(K.C!, "/drivers/link", "POST", { externalRef: "drv-1", linkCode: code.data.linkCode })).status, 200);
  const other = await newConnection(ownerB, { name: "B drivers", scopes: ["drivers:link"] });
  expectRejected("crossProvider", await api(other.key, "/drivers/link", "POST", { externalRef: "drv-x", linkCode: code.data.linkCode }), [409], "driver already linked elsewhere");
  assert.ok((await auditActions(C.C!)).includes("PROVIDER_DRIVER_LINKED"));
});

await focused("G1-32", "a provider relationship cannot set APPROVED", async () => {
  await onboard(pendingDriver);
  const code = await request("/account/driver-link-code", "POST", {}, pendingDriver.cookie);
  expectRejected("payload", await api(K.C!, "/drivers/link", "POST", { externalRef: "drv-2", linkCode: code.data.linkCode, status: "APPROVED" }), [400], "status=APPROVED");
  expectRejected("payload", await api(K.C!, "/drivers/link", "POST", { externalRef: "drv-2", linkCode: code.data.linkCode, approved: true }), [400], "approved=true");
  const linked = await api(K.C!, "/drivers/link", "POST", { externalRef: "drv-2", linkCode: code.data.linkCode });
  assert.equal(linked.status, 200, linked.raw);
  assert.equal(linked.data.status, "PENDING_VERIFICATION");
  assert.equal((await profileOf(pendingDriver))!.status, "PENDING_VERIFICATION", "provider can approve: NO");
  assert.equal((await api(K.C!, "/drivers/drv-2", "PUT", { status: "APPROVED" })).status, 404, "no provider route changes a driver");
  assert.equal((await profileOf(pendingDriver))!.status, "PENDING_VERIFICATION");
});

await focused("G1-31", "a linked driver works through the F4 assignment and Block D authorities", async () => {
  const listing = await api(K.C!, "/listings/table-1", "PUT", item({ title: "طاولة خشب", description: `طاولة خشب للتوصيل ${runId}`, categoryId: "other", fulfilmentType: "DELIVERY", attributes: {} }));
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", { listingId: listing.data.listing.id, quantity: 1, fulfilmentType: "DELIVERY", idempotencyKey: `g1-${randomUUID()}` }, buyer.cookie);
  assert.equal(order.status, 201, order.raw);
  assert.equal((await request(`/orders/${order.data.id}/accept`, "POST", {}, ownerC.cookie)).status, 200);
  await setDriverAvailability({ userId: driver.id, market: JO, availability: "AVAILABLE" });
  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyer.id, orderId: order.data.id, method: "COURIER", market: JO }, tx));
  await db.transaction((tx) => attachTransactionLocation({ actorId: buyer.id, orderId: order.data.id, purpose: "DELIVERY_DESTINATION", location: { source: "MANUAL", city: CITY, area: "الصريح", addressText: SECRET_ADDRESS }, market: JO }, tx));
  const work = await listDeliveryWork({ userId: driver.id, market: JO });
  assert.ok(work.cards.some((card) => card.id === order.data.id), JSON.stringify(work));
  await assignDelivery({ actorId: driver.id, orderId: order.data.id, market: JO });
  const [assignment] = await db.select().from(deliveryAssignments).where(eq(deliveryAssignments.orderId, order.data.id));
  assert.equal(assignment!.driverId, driver.id);
  assert.equal(assignment!.status, "ACCEPTED");
  const proposedFare = await request(
    `/orders/${order.data.id}/courier-fare/proposals`,
    "POST",
    { amount: `1.${"0".repeat(JO.minorUnitScale)}`, idempotencyKey: `g1-${randomUUID()}` },
    buyer.cookie,
  );
  assert.equal(proposedFare.status, 200, proposedFare.raw);
  const proposalId = proposedFare.data.proposal.id;
  const buyerFare = await request(`/orders/${order.data.id}/courier-fare/confirm`, "POST", { proposalId }, buyer.cookie);
  assert.equal(buyerFare.status, 200, buyerFare.raw);
  const driverFare = await request(`/orders/${order.data.id}/courier-fare/confirm`, "POST", { proposalId }, driver.cookie);
  assert.equal(driverFare.status, 200, driverFare.raw);
  assert.equal(driverFare.data.agreed, true);
  await recordCourierProgress({ actorId: driver.id, orderId: order.data.id, market: JO, type: "PICKED_UP" });
  await driverOutForDelivery({ actorId: driver.id, orderId: order.data.id, market: JO });
  assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, order.data.id)))[0]!.status, "OUT_FOR_DELIVERY");
  // The provider sees only operational state, never addresses or parties.
  const view = await api(K.C!, "/drivers/drv-1");
  assert.equal(view.status, 200);
  assert.ok(!view.raw.includes(SECRET_ADDRESS));
  // Unlinking ends only the relationship.
  const unlinked = await api(K.C!, "/drivers/drv-1", "DELETE");
  assert.equal(unlinked.status, 200, unlinked.raw);
  assert.equal((await api(K.C!, "/drivers/drv-1")).status, 404);
  assert.equal((await profileOf(driver))!.status, "APPROVED", "DriverProfile kept");
  assert.equal((await db.select().from(users).where(eq(users.id, driver.id))).length, 1, "user kept");
  assert.equal((await db.select().from(deliveryAssignments).where(eq(deliveryAssignments.id, assignment!.id))).length, 1, "assignment history kept");
  // The driver can withdraw consent from every remaining link.
  const withdrawn = await request("/account/driver-links", "DELETE", {}, pendingDriver.cookie);
  assert.equal(withdrawn.status, 200, withdrawn.raw);
  assert.equal(withdrawn.data.unlinked, 1);
  assert.ok((await auditActions(C.C!)).includes("PROVIDER_DRIVER_UNLINKED"));
});

// ─── Revocation and privacy ─────────────────────────────────────────────────

await focused("G1-33", "auth phone auto-publication = 0", async () => {
  const providerListing = await offer(L.acA!);
  assert.equal(providerListing!.data.contactPhone ?? null, null, "provider listings never get the owner's phone");
  const details = [
    await request(`/listings/${L.acA}`, "GET", undefined, buyer.cookie),
    await request(`/listings/${L.shirtB}`, "GET", undefined, buyer.cookie),
    await request(`/listings/${L.phoneA}`, "GET", undefined, buyer.cookie),
  ];
  for (const detail of details) assert.equal(detail.status, 200, detail.raw);
  const surfaces = [
    ...details.map((detail) => detail.raw),
    (await api(K.B!, "/listings/shirt-1")).raw,
    (await api(K.B!, "/connection")).raw,
    (await turn(buyer, "أريد قميص كتان")).raw,
  ];
  const phones = [ownerA.phone, ownerB.phone, ownerC.phone, driver.phone, pendingDriver.phone];
  const leaks = surfaces.reduce((sum, raw) => sum + phones.filter((phone) => raw.includes(phone)).length, 0);
  console.log("G1_PHONE_PUBLICATION", JSON.stringify({ leaks }));
  assert.equal(leaks, 0);
});


await focused("G1-27", "revoking a connection preserves canonical history and resources", async () => {
  const mappedBefore = await db.select().from(providerResourceMappings).where(eq(providerResourceMappings.connectionId, C.A!));
  const listingIds = mappedBefore.map((row) => row.resourceId);
  const review = await turn(ownerA, "أوقف الربط", "management");
  assert.equal(review.payload.surface, "PROVIDER_CONNECTION_REVIEW", review.body);
  assert.equal((await api(K.A!, "/connection")).status, 200, "nothing changes before «نعم»");
  const done = await turn(ownerA, "نعم", "management");
  assert.equal(done.payload.surface, "PROVIDER_STATUS", done.body);
  assert.match(done.body, /أوقفت الربط/);
  const rejected = await api(K.A!, "/listings/shirt-1", "PUT", item({ unitPrice: "1" }));
  assert.equal(rejected.status, 401);
  const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.id, C.A!));
  assert.equal(connection!.status, "REVOKED");
  assert.equal((await db.select().from(providerResourceMappings).where(eq(providerResourceMappings.connectionId, C.A!))).length, mappedBefore.length, "mappings kept as history");
  const rows = await db.select().from(offers).where(inArray(offers.id, listingIds));
  assert.equal(rows.length, listingIds.length, "no listing deleted");
  assert.ok(rows.every((row) => row.status !== "PUBLISHED"), "published provider listings paused");
  assert.equal((await db.select().from(orders).where(eq(orders.id, L.providerOrder!))).length, 1, "orders kept");
  assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, L.providerOrder!))).length, 1, "payments kept");
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.listingId, L.shirtA!))).length, 1, "promotion history kept");
  // The listing is the seller's again: its source is SELF_SERVICE and price is editable.
  assert.equal(await listingSource(L.shirtA!), "SELF_SERVICE");
  const patch = await request(`/listings/${L.shirtA}`, "PATCH", sellerBody({ unitPrice: "11", availableQuantity: 6 }), ownerA.cookie);
  assert.equal(patch.status, 200, patch.raw);
  assert.equal((await offer(L.shirtA!))!.unitPriceMinor, 11_000);
  assert.ok((await auditActions(C.A!)).includes("PROVIDER_CONNECTION_REVOKED"));
});

await focused("G1-34", "provider secret leaks = 0 across database, audit, messages, logs and responses", async () => {
  // Canary: test/run.mjs must see this pino line, proving it captures server logs.
  const canary = `g1-log-canary-${randomUUID()}`;
  logger.error({ canary }, "G1 capture canary");
  // Abuse the boundary with live keys: bad JSON, oversized body, wrong method.
  const live = K.B!;
  const oversized = await api(live, "/listings/big-1", "PUT", { ...item(), description: "x".repeat(200_000) });
  assert.equal(oversized.status, 413);
  const badJson = await api(live, "/listings/bad-1", "PUT", "{not json");
  assert.equal(badJson.status, 400);
  assert.equal((await api(live, "/listings/" + "x".repeat(150), "PUT", item())).status, 400);
  const secrets = keys.map(secretOf);
  writeFileSync(sentinelFile!, JSON.stringify({ secretHashes: secrets.map((secret) => createHash("sha256").update(secret).digest("hex")), canaries: [canary] }));
  const responses = secrets.reduce((sum, secret) => sum + providerResponses.filter((raw) => raw.includes(secret)).length, 0);
  const database = await dbOccurrences(secrets);
  const persisted = await dbOccurrences(secrets, ["messages", "ai_ui_blocks", "ai_result_sets", "market_audit"]);
  const rawSql = providerResponses.filter((raw) => SQL_LEAK.test(raw)).length;
  console.log("G1_SECRET_SCAN", JSON.stringify({ keys: keys.length, responses, database, persisted, rawSql, logs: "see LOG_SCAN" }));
  assert.deepEqual({ responses, database, persisted, rawSql }, { responses: 0, database: 0, persisted: 0, rawSql: 0 });
});

await test("SEC: credential rate limit and bounded payloads", async () => {
  const key = K.C!;
  const burst = await Promise.all(Array.from({ length: 25 }, () => request("/provider/connection", "GET", undefined, "", { Authorization: `Bearer ${key}` })));
  for (const response of burst) providerResponses.push(response.raw);
  const limited = burst.filter((response) => response.status === 429);
  assert.ok(limited.length >= 1, "per-credential limit");
  assert.ok(limited.every((response) => response.retryAfter >= 1 && response.data.code === "RATE_LIMITED"));
  assert.ok(burst.every((response) => response.status === 200 || response.status === 429));
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  for (const [label, body] of [
    ["description", item({ description: "و".repeat(5001) })],
    ["images", item({ images: Array.from({ length: 5 }, (_, n) => `listing-photos/${ownerC.id}/${n}.jpg`) })],
    ["external image", item({ images: ["https://evil.example/x.jpg"] })],
    ["attributes", item({ attributes: Object.fromEntries(Array.from({ length: 31 }, (_, n) => [`a${n}`, "v"])) })],
  ] as const) {
    const response = await api(key, "/listings/bounded-1", "PUT", body);
    assert.equal(response.status, 400, `${label}: ${response.raw}`);
    assert.doesNotMatch(response.raw, SQL_LEAK);
  }
  const batch = await api(key, "/listings/batch", "POST", { items: Array.from({ length: 26 }, (_, n) => ({ externalRef: `b-${n}`, listing: item() })) });
  assert.equal(batch.status, 400);
  assert.equal((await db.select().from(providerResourceMappings).where(like(providerResourceMappings.externalRef, "b-%"))).length, 0);
});

await focused("G1-35", "provider source creates no special search, order, payment or delivery authority", async () => {
  const tables = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((row: any) => String(row.table_name));
  assert.deepEqual(tables.filter((name) => name.startsWith("provider")).sort(), ["provider_connections", "provider_credentials", "provider_resource_mappings"]);
  const files = walk("src");
  const duplicate = /\b(?:class|function|const|type|interface|pgTable\(\s*")\s*(?:Provider(?:Marketplace|Listing|Order|Payment|Delivery|SearchEngine|Driver|Assignment|Promotion)\b|provider_(?:listings|orders|payments|deliveries|drivers|assignments|promotions)\b)/;
  const hits = files.filter((file) => duplicate.test(readFileSync(file, "utf8")));
  console.log("G1_DUPLICATE_AUTHORITIES", JSON.stringify({ hits }));
  assert.deepEqual(hits, []);
  // The provider layer's writes go only through canonical modules.
  const sync = readFileSync("src/lib/provider-sync.ts", "utf8");
  assert.doesNotMatch(sync, /insert\(offers\)|update\(offers\)|insert\(orders\)|insert\(paymentIntents\)|insert\(listingPromotions\)|insert\(deliveryAssignments\)|insert\(users\)|insert\(driverProfiles\)|update\(driverProfiles\)/);
  for (const authority of ["createListingForActor", "updateOwnedListing", "archiveOwnedListing"]) assert.match(sync, new RegExp(authority));
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Rows in every public table (or the named ones) whose text contains any needle. */
async function dbOccurrences(needles: string[], only?: string[]) {
  const tables = only ?? (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows.map((row: any) => String(row.table_name));
  let total = 0;
  for (const table of tables)
    for (const needle of needles) {
      const found = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} t where t::text like ${`%${needle}%`}`);
      total += Number((found.rows[0] as { n: number }).n);
    }
  return total;
}

await test("summary", async () => {
  const keysSorted = Object.keys(results).sort();
  const summary = {
    passed: keysSorted.filter((id) => results[id] === "PASS").length,
    failed: keysSorted.filter((id) => results[id] === "FAIL").length,
    total: keysSorted.length,
    results,
    modelCalls,
    externalCalls: external.length,
    attacks,
    unauthorizedEffects,
    bypass,
    rateLimitedRetries,
  };
  console.log("G1_SUMMARY", JSON.stringify(summary));
  try {
    assert.equal(summary.failed, 0);
    assert.equal(modelCalls.providerApi + modelCalls.management, 0);
    assert.equal(summary.externalCalls, 0);
    assert.equal(unauthorizedEffects, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
