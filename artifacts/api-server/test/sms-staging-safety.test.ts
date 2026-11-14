/**
 * SMS staging safety (owner request): no real SMS, no network. Twilio is a synthetic fetch.
 *   SS-01 provider selection matrix across NODE_ENV × DINAR_DEPLOYMENT_ENV × live flag;
 *   SS-02 a deployment labelled staging never returns a verification code in the API response,
 *         even when NODE_ENV was left at development, and the code goes only to the provider;
 *   SS-03 staging delivers only to allowlisted numbers and allowed country prefixes;
 *   SS-04 wrong, expired and reused codes are refused; attempts are capped; requests are
 *         rate-limited per phone number.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, phoneVerificationChallenges, pool } from "@workspace/db";
import app from "../src/app";
import { AUTH_RATE_LIMIT_MAX_ATTEMPTS } from "../src/lib/auth-rate-limiter";
import { getPhoneVerificationProvider, registerPhoneVerificationProvider, unregisterPhoneVerificationProvider, PHONE_VERIFICATION_MAX_ATTEMPTS } from "../src/lib/phone-verification";
import { TWILIO_MESSAGING_PROVIDER_KEY, twilioMessagingRegistration } from "../src/lib/sms/twilio-messaging";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const hex = (n: number) => "a".repeat(n);
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: `AC${hex(32)}`, TWILIO_API_KEY_SID: `SK${hex(32)}`, TWILIO_API_KEY_SECRET: "synthetic-secret-0123456789",
  TWILIO_MESSAGING_SERVICE_SID: `MG${hex(32)}`, DINAR_SMS_ALLOWED_COUNTRY_PREFIXES: "+962,+965",
};
const sent: { to: string; body: string }[] = [];
const fakeTwilio = (async (_url: string, init: RequestInit) => {
  const form = new URLSearchParams(String(init.body));
  sent.push({ to: form.get("To")!, body: form.get("Body")! });
  return new Response(JSON.stringify({ sid: `SM${hex(32)}`, status: "accepted" }), { status: 201, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const saved = { ...process.env };
function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["NODE_ENV", "DINAR_DEPLOYMENT_ENV", "DINAR_LIVE_PROVIDERS_ENABLED", "DINAR_PHONE_VERIFICATION_PROVIDER", "DINAR_SMS_STAGING_ALLOWLIST"]) delete process.env[key];
  Object.assign(process.env, values);
}
function register(environment: "staging" | "production", allowlist?: string) {
  unregisterPhoneVerificationProvider(TWILIO_MESSAGING_PROVIDER_KEY);
  const result = twilioMessagingRegistration({ ...TWILIO_ENV, ...(allowlist ? { DINAR_SMS_STAGING_ALLOWLIST: allowlist } : {}) }, environment, fakeTwilio);
  assert.ok("registration" in result, JSON.stringify(result));
  registerPhoneVerificationProvider(result.registration);
}
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
let ipn = Math.floor(Math.random() * 30_000);
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "X-Forwarded-For": `203.0.${(ipn >> 8) & 255}.${ipn++ & 255}` }, body: JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw };
};
after(async () => { process.env = saved; unregisterPhoneVerificationProvider(TWILIO_MESSAGING_PROVIDER_KEY); server.close(); await pool.end(); });

test("SS-01 provider selection: development only without a staging/production label; live needs its own flag", () => {
  setEnv({ NODE_ENV: "development" });
  assert.ok(getPhoneVerificationProvider(), "plain development: development provider");
  setEnv({ NODE_ENV: "development", DINAR_DEPLOYMENT_ENV: "staging" });
  assert.equal(getPhoneVerificationProvider(), undefined, "staging label + NODE_ENV=development + no provider: 503, never the code-returning provider");
  setEnv({ NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "staging", DINAR_PHONE_VERIFICATION_PROVIDER: "twilio-messaging" });
  assert.equal(getPhoneVerificationProvider(), undefined, "selected but not registered (configuration invalid): fails closed");
  register("staging", "+962790000001");
  assert.ok(getPhoneVerificationProvider(), "staging: the SANDBOX Twilio registration");
  setEnv({ NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "production", DINAR_PHONE_VERIFICATION_PROVIDER: "twilio-messaging" });
  register("production");
  assert.equal(getPhoneVerificationProvider(), undefined, "production without DINAR_LIVE_PROVIDERS_ENABLED: refused");
  setEnv({ NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "production", DINAR_PHONE_VERIFICATION_PROVIDER: "twilio-messaging", DINAR_LIVE_PROVIDERS_ENABLED: "true" });
  assert.ok(getPhoneVerificationProvider(), "production LIVE only with the explicit live flag");
  assert.throws(() => { const r = twilioMessagingRegistration({ ...TWILIO_ENV, DINAR_SMS_STAGING_ALLOWLIST: "+962790000001" }, "production", fakeTwilio); if ("problems" in r) throw new Error(r.problems.join()); }, /DINAR_SMS_STAGING_ALLOWLIST/, "a staging allowlist is refused in production");
  const missing = twilioMessagingRegistration({ ...TWILIO_ENV }, "staging", fakeTwilio);
  assert.ok("problems" in missing && missing.problems.includes("DINAR_SMS_STAGING_ALLOWLIST"), "staging requires an allowlist");
});

test("SS-02/03 staging: no code in the response even with NODE_ENV=development; allowlist and prefixes enforced", async () => {
  setEnv({ NODE_ENV: "development", DINAR_DEPLOYMENT_ENV: "staging", DINAR_PHONE_VERIFICATION_PROVIDER: "twilio-messaging" });
  register("staging", "+962791234567");
  sent.length = 0;
  const ok = await post("/auth/phone-verification/challenges", { phoneCountryCode: "+962", phoneNumber: "791234567" });
  assert.equal(ok.status, 202, ok.raw);
  assert.equal(ok.data.developmentCode, undefined, "the code never appears in a staging response");
  assert.doesNotMatch(ok.raw, /\b\d{6}\b/, "no six-digit code anywhere in the response");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.body, /رمز التحقق في جاسم: \d{6}/, "the code goes only to the provider");
  const outside = await post("/auth/phone-verification/challenges", { phoneCountryCode: "+962", phoneNumber: "791234568" });
  assert.equal(outside.status, 503, "a number outside the staging allowlist is not messaged");
  const foreign = await post("/auth/phone-verification/challenges", { phoneCountryCode: "+966", phoneNumber: "501234567" });
  assert.equal(foreign.status, 503, "a country outside the allowed prefixes is not messaged");
  assert.equal(sent.length, 1, "only the allowlisted number was ever sent to");
});

test("SS-04 wrong, expired and reused codes are refused; attempts capped; requests rate-limited", async () => {
  setEnv({ NODE_ENV: "development" });
  const phone = `79${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const challenge = await post("/auth/phone-verification/challenges", { phoneCountryCode: "+962", phoneNumber: phone });
  assert.equal(challenge.status, 202, challenge.raw);
  const { challengeId, developmentCode } = challenge.data;
  const wrongCode = developmentCode === "000000" ? "111111" : "000000";
  assert.equal((await post("/auth/phone-verification/challenges/verify", { challengeId, code: wrongCode })).status, 400, "wrong code");
  const good = await post("/auth/phone-verification/challenges/verify", { challengeId, code: developmentCode });
  assert.equal(good.status, 200, good.raw);
  assert.ok(good.data.verificationToken);
  assert.equal((await post("/auth/phone-verification/challenges/verify", { challengeId, code: developmentCode })).status, 400, "a code is single-use");

  const second = await post("/auth/phone-verification/challenges", { phoneCountryCode: "+962", phoneNumber: `78${phone.slice(2)}` });
  await db.update(phoneVerificationChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(phoneVerificationChallenges.id, second.data.challengeId));
  assert.equal((await post("/auth/phone-verification/challenges/verify", { challengeId: second.data.challengeId, code: second.data.developmentCode })).status, 400, "expired code");

  const third = await post("/auth/phone-verification/challenges", { phoneCountryCode: "+962", phoneNumber: `77${phone.slice(2)}` });
  for (let i = 0; i < PHONE_VERIFICATION_MAX_ATTEMPTS; i++)
    await post("/auth/phone-verification/challenges/verify", { challengeId: third.data.challengeId, code: third.data.developmentCode === "000000" ? "222222" : "000000" });
  assert.equal((await post("/auth/phone-verification/challenges/verify", { challengeId: third.data.challengeId, code: third.data.developmentCode })).status, 400, "after the attempt cap even the right code is refused");

  const statuses: number[] = [];
  for (let i = 0; i <= AUTH_RATE_LIMIT_MAX_ATTEMPTS; i++) statuses.push((await post("/auth/phone-verification/challenges", { phoneCountryCode: "+962", phoneNumber: `79${String(Number(phone.slice(2)) + 1).padStart(7, "0")}` })).status);
  assert.equal(statuses.at(-1), 429, `request ${AUTH_RATE_LIMIT_MAX_ATTEMPTS + 1} for one number within the window is rate-limited (${statuses.join(",")})`);
  assert.ok(statuses.slice(0, AUTH_RATE_LIMIT_MAX_ATTEMPTS).every((s) => s === 202), "below the limit every request is accepted");
  void randomUUID;
});
