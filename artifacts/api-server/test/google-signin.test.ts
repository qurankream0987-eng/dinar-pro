/**
 * Sign in with Google: identity only, never a substitute for SMS phone verification.
 * Tokens are signed locally with a generated RSA key whose JWKS is injected; Google is never
 * contacted (outbound requests are recorded and must be zero).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accountIdentities, db, policyAcceptances, policyConsentEvents, pool, users } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const CLIENT_ID = "123456789012-testclientabc.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) external.push(url.hostname);
  return originalFetch(input, init);
}) as typeof fetch;

const { default: app } = await import("../src/app");
const { setGoogleJwksFetcher } = await import("../src/lib/google-identity");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";
setGoogleJwksFetcher(async () => ({ jwks: { keys: [{ ...(google.publicKey.export({ format: "jwk" }) as any), kid: KID, alg: "RS256", use: "sig" }] }, maxAgeSeconds: 3600 }));

function token(claims: Record<string, unknown>, options: { key?: typeof google.privateKey; header?: Record<string, unknown> } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify(options.header ?? { alg: "RS256", kid: KID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, iat: now, exp: now + 3600, email_verified: true, ...claims })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), options.key ?? google.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

let ip = 0;
type Jar = Map<string, string>;
async function request(path: string, body?: unknown, jar: Jar = new Map(), method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      origin: base.replace("/api", ""),
      "X-Forwarded-For": `198.43.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
      ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const [name, ...value] = pair!.split("=");
    if (/Expires=Thu, 01 Jan 1970/i.test(cookie) || value.join("=") === "") jar.delete(name!);
    else jar.set(name!, value.join("="));
  }
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw, jar };
}

const phoneBase = 51_600_000 + ((Date.now() + process.pid + 13) % 150_000);
let phoneOffset = 0;
const nextPhone = () => String(phoneBase + 3 * phoneOffset++);
async function smsToken(phoneNumber: string) {
  const started = await request("/auth/phone-verification/challenges", { phoneCountryCode: "+965", phoneNumber });
  assert.equal(started.status, 202, started.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  assert.equal(verified.status, 200, verified.raw);
  return verified.data.verificationToken as string;
}
const identityOf = async (subject: string) => (await db.select().from(accountIdentities).where(and(eq(accountIdentities.provider, "GOOGLE"), eq(accountIdentities.subject, subject))))[0];

await test("disabled without a configured client id", async () => {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  try {
    assert.equal((await request("/auth/google", { idToken: token({ sub: "x", email: "x@example.com" }) })).status, 503);
  } finally {
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
  }
});

await test("forged or invalid tokens are refused", async () => {
  const sub = `g-${randomUUID()}`;
  const bad = [
    token({ sub, email: "a@example.com" }, { key: attacker.privateKey }),
    token({ sub, email: "a@example.com", aud: "other.apps.googleusercontent.com" }),
    token({ sub, email: "a@example.com", iss: "https://evil.example" }),
    token({ sub, email: "a@example.com", exp: Math.floor(Date.now() / 1000) - 600 }),
    token({ sub, email: "a@example.com", email_verified: false }),
    token({ sub, email: "a@example.com" }, { header: { alg: "none", kid: KID } }),
    token({ sub, email: "a@example.com" }, { header: { alg: "RS256", kid: "unknown-kid" } }),
    "not.a.token",
  ];
  for (const idToken of bad) {
    const status = (await request("/auth/google", { idToken })).status;
    assert.ok(idToken === "not.a.token" ? status === 400 : status === 401, `${status} ${idToken.slice(0, 30)}`);
  }
  assert.equal((await request("/auth/google", { idToken: token({ sub, email: "a@example.com" }), extra: 1 })).status, 400, "strict body");
  assert.equal(await identityOf(sub), undefined);
});

await test("a new Google user cannot get an account without SMS phone verification", async () => {
  const sub = `g-${randomUUID()}`;
  const before = (await db.select({ id: users.id }).from(users)).length;
  const first = await request("/auth/google", { idToken: token({ sub, email: "New.User@Example.com", name: "مستخدم جوجل" }) });
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.data.status, "PHONE_VERIFICATION_REQUIRED");
  assert.equal(first.data.email, "new.user@example.com");
  assert.ok(first.jar.has("bdinar_google_pending"));
  assert.ok(!first.jar.has("bdinar_session"), "no session before the phone is verified");
  assert.equal((await db.select({ id: users.id }).from(users)).length, before, "nothing created");
  const phoneNumber = nextPhone();
  const noCookie = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true, verificationToken: "a".repeat(64) });
  assert.equal(noCookie.status, 401, "the ticket is bound to this browser");
  const fakeCode = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true, verificationToken: "a".repeat(64) }, first.jar);
  assert.equal(fakeCode.status, 400, "an unverified phone is refused");
  const tampered = new Map(first.jar);
  tampered.set("bdinar_google_pending", first.jar.get("bdinar_google_pending")!.replace(/.$/, (c) => (c === "A" ? "B" : "A")));
  assert.equal((await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true, verificationToken: await smsToken(phoneNumber) }, tampered)).status, 401, "a tampered ticket is refused");
  // Google authentication is not acceptance of JassimAI's terms: without the explicit
  // acknowledgement nothing is created, whatever the Google token says.
  const usersBeforeNoTerms = (await db.select({ id: users.id }).from(users)).length;
  const noTerms = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", verificationToken: await smsToken(phoneNumber) }, first.jar);
  assert.equal(noTerms.status, 400, "completion without acceptTerms is refused");
  const falseTerms = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: false, verificationToken: await smsToken(phoneNumber) }, first.jar);
  assert.equal(falseTerms.status, 400, "acceptTerms:false is refused");
  assert.equal((await db.select({ id: users.id }).from(users)).length, usersBeforeNoTerms, "no account without acknowledgement");
  const created = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true, verificationToken: await smsToken(phoneNumber) }, first.jar);
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.data.status, "CREATED");
  assert.ok(created.jar.has("bdinar_session"));
  assert.ok(!created.jar.has("bdinar_google_pending"), "the ticket is cleared");
  const identity = await identityOf(sub);
  assert.ok(identity);
  const [user] = await db.select().from(users).where(eq(users.id, identity!.userId));
  assert.equal(user!.phoneVerified, true);
  assert.equal(user!.displayName, "مستخدم جوجل");
  assert.ok((await db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, user!.id))).length > 0, "terms acceptance recorded");
  const googleEvents = await db.select().from(policyConsentEvents).where(eq(policyConsentEvents.userId, user!.id));
  assert.ok(googleEvents.length > 0 && googleEvents.every((event) => event.idempotencyKey.startsWith("signup:google:") && event.source === "SIGNUP" && event.decision === "ACCEPTED" && /^[0-9a-f]{64}$/u.test(event.contentSha256)), "the record names the Google channel, the version and the content hash");
  // Later: Google alone signs the linked account in.
  const again = await request("/auth/google", { idToken: token({ sub, email: "new.user@example.com" }) });
  assert.equal(again.data.status, "SIGNED_IN");
  assert.equal(again.data.user.id, user!.id);
  // Replaying the old ticket cannot link the same Google account a second time.
  const replay = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber: nextPhone(), accountCountry: "KW", acceptTerms: true, verificationToken: "b".repeat(64) }, first.jar);
  assert.ok([400, 401].includes(replay.status));
});

await test("an existing phone account is linked only after SMS proof, and only once", async () => {
  const phoneNumber = nextPhone();
  const password = `Existing-${randomUUID().slice(0, 10)}!`;
  const registered = await request("/auth/register", { displayName: "حساب قديم", phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: await smsToken(phoneNumber) });
  assert.equal(registered.status, 201, registered.raw);
  const existingId = registered.data.user.id;
  const phoneEvents = async () => db.select().from(policyConsentEvents).where(eq(policyConsentEvents.userId, existingId));
  const beforeLink = await phoneEvents();
  assert.ok(beforeLink.length > 0 && beforeLink.every((event) => event.idempotencyKey.startsWith("signup:phone:")), "a phone signup records the phone channel");
  const subA = `g-${randomUUID()}`;
  const pendingA = await request("/auth/google", { idToken: token({ sub: subA, email: "owner@example.com" }) });
  const linked = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true, verificationToken: await smsToken(phoneNumber) }, pendingA.jar);
  assert.equal(linked.status, 200, linked.raw);
  assert.equal(linked.data.status, "LINKED");
  assert.equal(linked.data.user.id, existingId, "same account, nothing duplicated");
  assert.deepEqual((await phoneEvents()).map((event) => event.id).sort(), beforeLink.map((event) => event.id).sort(), "linking Google never records a new consent for an existing user");
  const subB = `g-${randomUUID()}`;
  const pendingB = await request("/auth/google", { idToken: token({ sub: subB, email: "someone@example.com" }) });
  const second = await request("/auth/google/complete", { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true, verificationToken: await smsToken(phoneNumber) }, pendingB.jar);
  assert.equal(second.status, 409, "an account holds at most one Google identity");
  assert.equal(await identityOf(subB), undefined);
  // Password sign-in still works for the linked account.
  const login = await request("/auth/login", { phoneCountryCode: "+965", phoneNumber, password });
  assert.equal(login.status, 200, login.raw);
});

await test("deferred mode (no SMS): Google-verified email + phone typed twice; the phone never links or takes over", async () => {
  const saved = { require: process.env.BDINAR_REQUIRE_PHONE_VERIFICATION, mode: process.env.DINAR_PHONE_VERIFICATION_MODE };
  process.env.BDINAR_REQUIRE_PHONE_VERIFICATION = "1";
  process.env.DINAR_PHONE_VERIFICATION_MODE = "DEFERRED_WITH_VERIFIED_EMAIL";
  try {
    const sub = `g-${randomUUID()}`;
    const email = `deferred-${randomUUID().slice(0, 8)}@example.com`;
    const pending = await request("/auth/google", { idToken: token({ sub, email, name: "مستخدم مؤجل" }) });
    assert.equal(pending.status, 200, pending.raw);
    assert.equal(pending.data.status, "PHONE_VERIFICATION_REQUIRED");
    assert.equal(pending.data.phoneMode, "CONFIRM_TWICE");
    const phoneNumber = nextPhone();
    const base = { phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", acceptTerms: true };
    const mismatch = await request("/auth/google/complete", { ...base, phoneNumberConfirm: nextPhone() }, pending.jar);
    assert.equal(mismatch.status, 400, mismatch.raw);
    assert.equal(mismatch.data.code, "PHONE_CONFIRMATION_MISMATCH");
    const missing = await request("/auth/google/complete", base, pending.jar);
    assert.equal(missing.status, 400, "neither SMS token nor confirmation: refused");
    const created = await request("/auth/google/complete", { ...base, phoneNumberConfirm: phoneNumber }, pending.jar);
    assert.equal(created.status, 201, created.raw);
    const [row] = await db.select().from(users).where(eq(users.id, created.data.user.id));
    assert.equal(row!.phoneVerified, false, "the phone stays unverified");
    assert.equal(row!.email, email);
    assert.ok(row!.emailVerifiedAt, "the Google email is the verified identity");
    const me = await request("/auth/me", undefined, created.jar, "GET");
    assert.equal(me.data.user?.id, row!.id, "a session is issued in deferred mode");
    const again = await request("/auth/google", { idToken: token({ sub, email }) });
    assert.equal(again.data.status, "SIGNED_IN", again.raw);
    // An existing account's phone can never be claimed by a new Google identity without SMS.
    const intruder = await request("/auth/google", { idToken: token({ sub: `g-${randomUUID()}`, email: `other-${randomUUID().slice(0, 8)}@example.com` }) });
    const takeover = await request("/auth/google/complete", { ...base, phoneNumberConfirm: phoneNumber }, intruder.jar);
    assert.equal(takeover.status, 409, takeover.raw);
    assert.equal(takeover.data.code, "PHONE_ALREADY_REGISTERED");
    // The same Google email cannot open a second account.
    const dupEmail = await request("/auth/google", { idToken: token({ sub: `g-${randomUUID()}`, email }) });
    const second = nextPhone();
    const dup = await request("/auth/google/complete", { ...base, phoneNumber: second, phoneNumberConfirm: second }, dupEmail.jar);
    assert.equal(dup.status, 409, dup.raw);
    // Turning deferred mode off: the unverified-phone account no longer holds a session.
    delete process.env.DINAR_PHONE_VERIFICATION_MODE;
    const off = await request("/auth/me", undefined, created.jar, "GET");
    assert.equal(off.data.user, null, "strict mode refuses the existing session");
    const offSignIn = await request("/auth/google", { idToken: token({ sub, email }) });
    assert.equal(offSignIn.status, 403, offSignIn.raw);
    const strict = await request("/auth/google", { idToken: token({ sub: `g-${randomUUID()}`, email: `strict-${randomUUID().slice(0, 8)}@example.com` }) });
    assert.equal(strict.data.phoneMode, "SMS");
    const strictPhone = nextPhone();
    const noSms = await request("/auth/google/complete", { ...base, phoneNumber: strictPhone, phoneNumberConfirm: strictPhone }, strict.jar);
    assert.equal(noSms.status, 400, "strict mode still requires the SMS token");
  } finally {
    if (saved.require === undefined) delete process.env.BDINAR_REQUIRE_PHONE_VERIFICATION; else process.env.BDINAR_REQUIRE_PHONE_VERIFICATION = saved.require;
    if (saved.mode === undefined) delete process.env.DINAR_PHONE_VERIFICATION_MODE; else process.env.DINAR_PHONE_VERIFICATION_MODE = saved.mode;
  }
});

await test("no outbound network", () => {
  assert.deepEqual(external, []);
});

await test("teardown", async () => {
  setGoogleJwksFetcher(undefined);
  server.close();
  await pool.end();
});
