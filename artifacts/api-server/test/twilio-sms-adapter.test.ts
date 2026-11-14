/** Twilio SMS adapter contract: no network, an injected fetch records each request. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTwilioMessagingProvider,
  readTwilioMessagingConfiguration,
  twilioMessagingRegistration,
  TwilioDeliveryError,
  TWILIO_MESSAGING_PROVIDER_KEY,
} from "../src/lib/sms/twilio-messaging";
import {
  getPhoneVerificationProvider,
  phoneVerificationStatus,
  registerPhoneVerificationProvider,
  unregisterPhoneVerificationProvider,
} from "../src/lib/phone-verification";

const AC = `AC${"a".repeat(32)}`, SK = `SK${"b".repeat(32)}`, MG = `MG${"c".repeat(32)}`;
const SECRET = "test-secret-value-0123456789";
const base = {
  TWILIO_ACCOUNT_SID: AC, TWILIO_API_KEY_SID: SK, TWILIO_API_KEY_SECRET: SECRET, TWILIO_MESSAGING_SERVICE_SID: MG,
  DINAR_SMS_ALLOWED_COUNTRY_PREFIXES: "+962,+965", DINAR_SMS_STAGING_ALLOWLIST: "+962790000001,+96550000001",
};

function recorder(status = 201, body: unknown = { sid: "SM1" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const config = () => {
  const read = readTwilioMessagingConfiguration(base, "staging");
  assert.ok("configuration" in read, JSON.stringify(read));
  return read.configuration;
};

await test("configuration reports setting names only, never values", () => {
  const read = readTwilioMessagingConfiguration({ ...base, TWILIO_API_KEY_SID: "auth-token-instead", DINAR_SMS_STAGING_ALLOWLIST: "" }, "staging");
  assert.ok("problems" in read);
  assert.deepEqual(read.problems.sort(), ["DINAR_SMS_STAGING_ALLOWLIST", "TWILIO_API_KEY_SID"]);
  assert.ok(!JSON.stringify(read).includes(SECRET));
});

await test("a staging allowlist is refused in production", () => {
  const read = readTwilioMessagingConfiguration(base, "production");
  assert.ok("problems" in read && read.problems.includes("DINAR_SMS_STAGING_ALLOWLIST"));
  const { DINAR_SMS_STAGING_ALLOWLIST: _omit, ...prod } = base;
  assert.ok("configuration" in readTwilioMessagingConfiguration(prod, "production"));
});

await test("sends one form POST through the messaging service with an API key", async () => {
  const { calls, fetchImpl } = recorder();
  const provider = createTwilioMessagingProvider(config(), "staging", fetchImpl);
  assert.deepEqual(await provider.sendCode("+962790000001", "123456"), {});
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from(`${SK}:${SECRET}`).toString("base64")}`);
  const form = new URLSearchParams(String(init.body));
  assert.equal(form.get("To"), "+962790000001");
  assert.equal(form.get("MessagingServiceSid"), MG);
  assert.equal(form.get("ValidityPeriod"), "600");
  assert.equal(form.get("From"), null);
  assert.match(form.get("Body")!, /رمز التحقق في جاسم: 123456/);
});

await test("staging refuses numbers outside the allowlist and countries outside the prefixes", async () => {
  const { calls, fetchImpl } = recorder();
  const provider = createTwilioMessagingProvider(config(), "staging", fetchImpl);
  await assert.rejects(provider.sendCode("+962790000999", "123456"), /allowlist/);
  await assert.rejects(provider.sendCode("+14155550100", "123456"), /country not enabled/);
  await assert.rejects(provider.sendCode("0790000001", "123456"), /E\.164/);
  await assert.rejects(provider.sendCode("+962790000001", "12ab"), /code format/);
  assert.equal(calls.length, 0);
});

await test("provider errors carry the Twilio code but never the phone, code or response body", async () => {
  const { fetchImpl } = recorder(400, { code: 21610, message: "secret detail +962790000001" });
  const provider = createTwilioMessagingProvider(config(), "staging", fetchImpl);
  const error = await provider.sendCode("+962790000001", "654321").catch((e) => e);
  assert.ok(error instanceof TwilioDeliveryError);
  assert.equal(error.twilioCode, 21610);
  for (const leaked of ["+962790000001", "654321", "secret detail", SECRET]) assert.ok(!error.message.includes(leaked));
});

await test("network failure and timeout become a delivery error", async () => {
  const failing = (async () => { throw new Error("ECONNRESET to api.twilio.com"); }) as unknown as typeof fetch;
  await assert.rejects(createTwilioMessagingProvider(config(), "staging", failing).sendCode("+962790000001", "123456"), /network or timeout/);
});

await test("registry: staging registers SANDBOX; selection, environment and live gate are enforced", async () => {
  const saved = { ...process.env };
  try {
    const { calls, fetchImpl } = recorder();
    const reg = twilioMessagingRegistration(base, "staging", fetchImpl);
    assert.ok("registration" in reg);
    assert.equal(reg.registration.mode, "SANDBOX");
    assert.deepEqual(reg.registration.environments, ["staging"]);
    registerPhoneVerificationProvider(reg.registration);
    process.env.NODE_ENV = "production";
    process.env.DINAR_DEPLOYMENT_ENV = "staging";
    delete process.env.DINAR_PHONE_VERIFICATION_PROVIDER;
    assert.equal(phoneVerificationStatus(), "not_configured");
    process.env.DINAR_PHONE_VERIFICATION_PROVIDER = TWILIO_MESSAGING_PROVIDER_KEY;
    assert.equal(phoneVerificationStatus(), "ready");
    await getPhoneVerificationProvider()!.sendCode("+962790000001", "111111");
    assert.equal(calls.length, 1);
    // A staging registration never serves production.
    process.env.DINAR_DEPLOYMENT_ENV = "production";
    assert.equal(phoneVerificationStatus(), "not_configured");
    // A production (LIVE) registration still needs DINAR_LIVE_PROVIDERS_ENABLED=true.
    const { DINAR_SMS_STAGING_ALLOWLIST: _o, ...prodEnv } = base;
    const prod = twilioMessagingRegistration(prodEnv, "production", fetchImpl);
    assert.ok("registration" in prod && prod.registration.mode === "LIVE");
    registerPhoneVerificationProvider(prod.registration);
    delete process.env.DINAR_LIVE_PROVIDERS_ENABLED;
    assert.equal(phoneVerificationStatus(), "not_configured");
  } finally {
    unregisterPhoneVerificationProvider(TWILIO_MESSAGING_PROVIDER_KEY);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
