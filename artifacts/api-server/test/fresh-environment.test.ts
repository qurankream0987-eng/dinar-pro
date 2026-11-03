/**
 * Wave 1: a freshly migrated database brought to a usable state, in production mode, exactly as
 * a staging deployment would be: readiness, first administrator, phone-verified login and
 * registration through a registered SMS adapter (an offline capture adapter here: the delivery
 * provider is the owner's open decision), one market activated by the administrator, a listing
 * published, and the built web app served from the API's origin.
 *
 * The caller creates an empty dinar_test_fresh_* database and migrates it with the release runner
 * (migrate-release.mjs, target "disposable") before running this file.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { startS3CompatibleTestServer } from "./s3-compatible-test-server";

const databaseUrl = process.env.DATABASE_URL ?? "";
{
  const target = new URL(databaseUrl);
  assert.equal(target.hostname, "127.0.0.1", "fresh-environment runs only against loopback PostgreSQL");
  assert.match(target.pathname, /^\/dinar_test_fresh_[a-z0-9_]+$/, "fresh-environment needs its own dinar_test_fresh_* database");
}
const webDist = path.resolve(import.meta.dirname, "../../dinar/dist/public");
assert.ok(existsSync(path.join(webDist, "index.html")), "build the web app first (pnpm --filter @workspace/dinar run build)");

const s3 = await startS3CompatibleTestServer({ accessKeyId: "FRESHKEY", secretAccessKey: "fresh-secret-not-real-000000000000", region: "auto", bucket: "dinar-staging" });
// Production mode, as Railway staging would run it. Set before the application is imported.
Object.assign(process.env, {
  NODE_ENV: "production",
  DINAR_DEPLOYMENT_ENV: "staging",
  DINAR_PHONE_VERIFICATION_PROVIDER: "wave1-offline-capture",
  DINAR_WEB_DIST: webDist,
  OBJECT_STORAGE_PROVIDER: "s3",
  OBJECT_STORAGE_S3_ENDPOINT: s3.endpoint,
  OBJECT_STORAGE_S3_REGION: "auto",
  OBJECT_STORAGE_S3_BUCKET: "dinar-staging",
  OBJECT_STORAGE_S3_ACCESS_KEY_ID: "FRESHKEY",
  OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "fresh-secret-not-real-000000000000",
  OBJECT_STORAGE_S3_PUBLIC_PREFIXES: "public",
});
delete process.env.DINAR_DEV_DATABASE_URL;
assert.ok((process.env.SESSION_SECRET ?? "").length >= 32, "SESSION_SECRET (≥32) is provided by the isolation session");

const { default: app } = await import("../src/app");
const { db, pool, markets, users, marketAudit, moderationAudit } = await import("@workspace/db");
const { eq, and } = await import("drizzle-orm");
const { registerPhoneVerificationProvider, unregisterPhoneVerificationProvider } = await import("../src/lib/phone-verification");
const { bootstrapFirstAdmin } = await import("../src/lib/admin-bootstrap");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/** The offline SMS adapter: codes land here instead of a phone. Nothing leaves the process. */
const outbox = new Map<string, string>();
const smsRegistration = {
  family: "SMS" as const,
  providerKey: "wave1-offline-capture",
  mode: "SANDBOX" as const,
  environments: ["staging"] as const,
  marketIds: ["*"] as const,
  create: () => ({
    async sendCode(normalizedPhone: string, code: string) {
      outbox.set(normalizedPhone, code);
      return {};
    },
  }),
};

type Session = { cookie: string };
async function call(route: string, init: { method?: string; body?: unknown; session?: Session; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${origin}/api${route}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json", origin } : {}),
      ...(init.session ? { cookie: init.session.cookie } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text, headers: response.headers };
}
const sessionFrom = (headers: Headers): Session => {
  const cookie = headers.getSetCookie().find((value) => value.startsWith("bdinar_session="));
  assert.ok(cookie, "a session cookie is issued");
  return { cookie: cookie.split(";")[0]! };
};
let phoneSequence = 0;
const nextPhone = () => `79${String(Date.now() % 1_000_000).padStart(6, "0")}${phoneSequence++}`.slice(0, 9);

async function verifyPhone(number: string) {
  const challenge = await call("/auth/phone-verification/challenges", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: number } });
  assert.equal(challenge.status, 202, challenge.text);
  assert.equal(challenge.json.developmentCode, undefined, "production never returns the code");
  const code = outbox.get(`+962${number}`);
  assert.match(code ?? "", /^\d{6}$/);
  const verified = await call("/auth/phone-verification/challenges/verify", { method: "POST", body: { challengeId: challenge.json.challengeId, code } });
  assert.equal(verified.status, 200, verified.text);
  return verified.json.verificationToken as string;
}
const password = "fresh-environment-password-1";

let admin: Session;
let seller: Session;
let buyer: Session;

await test("readiness: a migrated web service is ready without SMS, while phone challenges fail closed", async () => {
  const response = await call("/readyz");
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.status, "ready");
  assert.equal(response.json.checks.database, "ready");
  assert.equal(response.json.checks.migrations, "current");
  assert.equal(response.json.checks.configuration, "ready");
  assert.equal(response.json.checks.phoneVerification, "not_configured");

  const challenge = await call("/auth/phone-verification/challenges", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: nextPhone() } });
  assert.equal(challenge.status, 503, "phone verification remains unavailable without an adapter");

  registerPhoneVerificationProvider(smsRegistration);
  const ready = await call("/readyz");
  assert.equal(ready.status, 200, ready.text);
  assert.deepEqual(ready.json, { status: "ready", checks: { database: "ready", migrations: "current", configuration: "ready", phoneVerification: "ready" } });
});

await test("the fresh database has every market inactive and no administrator", async () => {
  const all = await db.select({ id: markets.id, isActive: markets.isActive, status: markets.status }).from(markets);
  assert.equal(all.length, 249);
  assert.equal(all.filter((market) => market.isActive).length, 0);
  assert.equal((await db.select().from(users).where(eq(users.role, "ADMIN"))).length, 0);
});

await test("first administrator: operator bootstrap, then a phone-verified production login", async () => {
  const number = nextPhone();
  const created = await bootstrapFirstAdmin({ phoneCountryCode: "+962", phoneNumber: number, displayName: "مدير الإطلاق", accountCountry: "JO", password });
  assert.equal(created.outcome, "CREATED");

  // The bootstrap proves nothing about the phone, so production login first demands ownership.
  const blind = await call("/auth/login", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: number, password } });
  assert.equal(blind.status, 401);
  const wrongPassword = await call("/auth/login", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: number, password: "wrong-password-0000", verificationToken: "0".repeat(64) } });
  assert.equal(wrongPassword.status, 401);

  const token = await verifyPhone(number);
  const login = await call("/auth/login", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: number, password, verificationToken: token } });
  assert.equal(login.status, 200, login.text);
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Secure/i, "production session cookies are Secure");
  admin = sessionFrom(login.headers);
  assert.equal(login.json.user.role, "ADMIN");

  // The verification token is single-use.
  const replay = await call("/auth/login", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: number, password, verificationToken: token } });
  assert.equal(replay.status, 200, "an already verified account logs in with its password");
  const [stored] = await db.select().from(users).where(eq(users.id, created.userId));
  assert.equal(stored!.phoneVerified, true);
  const audit = await db.select().from(moderationAudit).where(and(eq(moderationAudit.targetId, created.userId), eq(moderationAudit.action, "FIRST_ADMIN_BOOTSTRAP")));
  assert.equal(audit.length, 1);
});

await test("registration in production: challenge → verify → register, and every shortcut is refused", async () => {
  const number = nextPhone();
  const registration = (extra: Record<string, unknown>) => ({
    displayName: "بائع تجريبي", phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO",
    password, confirmPassword: password, acceptTerms: true, ...extra,
  });
  assert.equal((await call("/auth/register", { method: "POST", body: registration({}) })).status, 400, "no token");
  assert.equal((await call("/auth/register", { method: "POST", body: registration({ verificationToken: "f".repeat(64) }) })).status, 400, "forged token");

  const challenge = await call("/auth/phone-verification/challenges", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: number } });
  const wrong = await call("/auth/phone-verification/challenges/verify", { method: "POST", body: { challengeId: challenge.json.challengeId, code: outbox.get(`+962${number}`) === "000000" ? "111111" : "000000" } });
  assert.equal(wrong.status, 400, "wrong code");
  const verified = await call("/auth/phone-verification/challenges/verify", { method: "POST", body: { challengeId: challenge.json.challengeId, code: outbox.get(`+962${number}`) } });
  assert.equal(verified.status, 200, verified.text);
  const token = verified.json.verificationToken as string;

  const otherPhone = nextPhone();
  assert.equal((await call("/auth/register", { method: "POST", body: { ...registration({ verificationToken: token }), phoneNumber: otherPhone } })).status, 400, "a token is bound to its phone");
  const registered = await call("/auth/register", { method: "POST", body: registration({ verificationToken: token, role: "ADMIN" }) });
  assert.equal(registered.status, 201, registered.text);
  assert.equal(registered.json.user.role, "USER");
  seller = sessionFrom(registered.headers);
  assert.equal((await call("/auth/register", { method: "POST", body: registration({ verificationToken: token }) })).status, 400, "a token is single-use");

  const buyerToken = await verifyPhone(otherPhone);
  const buyerRegistered = await call("/auth/register", { method: "POST", body: { ...registration({ verificationToken: buyerToken }), phoneNumber: otherPhone, displayName: "مشتري تجريبي" } });
  assert.equal(buyerRegistered.status, 201, buyerRegistered.text);
  buyer = sessionFrom(buyerRegistered.headers);
});

await test("market activation: only the administrator, only the chosen market, audited", async () => {
  const configuration = { status: "ACTIVE", fulfilmentMethods: ["PICKUP", "DELIVERY", "SERVICE"], paymentMethods: ["CASH_DIRECT"], restrictedCategories: [], sellerEligibilityMode: "OPEN" };
  assert.equal((await call("/admin/markets/JO", { method: "PATCH", body: configuration, session: seller })).status, 403);
  assert.equal((await call("/admin/markets/JO", { method: "PATCH", body: configuration })).status, 401);

  const listed = await call("/admin/markets", { session: admin });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.length, 249);

  // Owner decision 2026-10-30 #3 (W07): a legacy unit price no longer gates activation; the
  // administrator's explicit configuration does. A price can still be recorded and is audited.
  const unpriced = await call("/admin/markets/JO", { method: "PATCH", body: configuration, session: admin });
  assert.equal(unpriced.status, 200, unpriced.text);
  const price = await call("/admin/markets/JO/prices", { method: "POST", body: { currencyCode: "JOD", unitPriceMinor: 1000 }, session: admin });
  assert.ok([200, 201].includes(price.status), price.text);
  const activated = await call("/admin/markets/JO", { method: "PATCH", body: configuration, session: admin });
  assert.equal(activated.status, 200, activated.text);

  const active = await db.select({ id: markets.id }).from(markets).where(eq(markets.isActive, true));
  assert.deepEqual(active.map((market) => market.id), ["JO"]);
  const audit = await db.select().from(marketAudit).where(eq(marketAudit.marketId, "JO"));
  assert.ok(audit.some((row) => row.action === "CONFIGURATION"));
});

await test("a seller publishes in the activated market and a buyer finds it", async () => {
  // Accounts created while JO was inactive were attached to it; re-login refreshes nothing needed.
  const published = await call("/listings", {
    method: "POST",
    session: seller,
    body: {
      title: "مكتب خشبي للبيع", description: "مكتب خشبي بحالة جيدة جاهز للاستلام من عمّان", category: "أخرى", categoryId: "other", area: "عبدون", city: "عمّان",
      attributes: {}, unitPrice: "45", pricingMode: "NEGOTIABLE", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
    },
  });
  assert.equal(published.status, 201, published.text);
  const found = await call("/listings?search=مكتب", { session: buyer });
  assert.equal(found.status, 200);
  assert.ok(found.json.some((listing: { id: string }) => listing.id === published.json.id), found.text.slice(0, 300));
});

await test("same origin: the built web app, SPA routes, API JSON and the write guard on one origin", async () => {
  const shell = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /<div id="root">/);
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, "the shell references a hashed bundle");
  const bundle = await fetch(`${origin}${asset}`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("cache-control") ?? "", /immutable/);
  for (const route of ["/ai", "/orders", "/account"]) {
    const page = await fetch(`${origin}${route}`, { headers: { accept: "text/html" } });
    assert.equal(page.status, 200, route);
    assert.match(await page.text(), /<div id="root">/, route);
  }
  const api404 = await fetch(`${origin}/api/does-not-exist`);
  assert.equal(api404.status, 404);
  assert.match(api404.headers.get("content-type") ?? "", /json/);
  const me = await call("/auth/me", { session: buyer });
  assert.equal(me.status, 200);
  assert.ok(me.json.user);
  const crossSite = await call("/auth/logout", { method: "POST", body: {}, session: buyer, headers: { origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);
});

await test("SSE: a conversation turn streams through the shared origin with the session cookie", async () => {
  // Production chat stays off unless the operator opts in; the search turn below is deterministic.
  assert.equal((await call("/ai/conversations", { method: "POST", body: {}, session: buyer })).status, 404);
  process.env.DINAR_AI_CHAT = "true";
  const created = await call("/ai/conversations", { method: "POST", body: {}, session: buyer });
  assert.ok([200, 201].includes(created.status), created.text);
  const response = await fetch(`${origin}/api/ai/conversations/${created.json.id}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: buyer.cookie, accept: "text/event-stream" },
    body: JSON.stringify({ message: "ابحث عن مكتب" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await response.text();
  assert.match(events, /^data: \{/m);
  assert.match(events, /مكتب خشبي للبيع/, events.slice(0, 600));
});

await test("unregistering SMS keeps web readiness but blocks phone verification", async () => {
  unregisterPhoneVerificationProvider("wave1-offline-capture");
  const response = await call("/readyz");
  assert.equal(response.status, 200);
  assert.equal(response.json.checks.phoneVerification, "not_configured");
  const challenge = await call("/auth/phone-verification/challenges", { method: "POST", body: { phoneCountryCode: "+962", phoneNumber: nextPhone() } });
  assert.equal(challenge.status, 503);
  assert.equal(s3.requests.filter((request) => request.status === 403).length, 0);
});

// Registered last: with top-level awaited tests, an earlier root after() runs after the first test.
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await s3.close();
  await pool.end();
});
