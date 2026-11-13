/**
 * Twilio Programmable Messaging delivery for DINAR's own phone-verification codes.
 *
 * DINAR generates, hashes, rate-limits and checks the code (lib/auth.ts). This adapter only
 * delivers it through a Twilio Messaging Service, so the sender ID registered for each country
 * (Jordan, Kuwait) is chosen by Twilio. It never logs or returns the phone number or code.
 *
 * Twilio Verify was reviewed. It generates its own code, unless "custom code" is enabled by
 * Twilio Sales, and custom code requires a status report back to Twilio after verification.
 * That needs the plain phone number or a stored verification SID, which DINAR does not keep.
 * Verify is therefore not used here.
 *
 * Registration is only active when the deployment selects it
 * (DINAR_PHONE_VERIFICATION_PROVIDER=twilio-messaging). The staging registration is SANDBOX
 * mode and also requires an explicit allowlist of destination numbers, so a staging
 * deployment cannot message arbitrary numbers or be used for SMS pumping.
 */
import type { PhoneVerificationProvider } from "../phone-verification";
import type { ProviderDeploymentEnvironment, ProviderRegistration } from "../provider-boundaries";

export const TWILIO_MESSAGING_PROVIDER_KEY = "twilio-messaging";
const TWILIO_API = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 10_000;
/** Matches PHONE_VERIFICATION_CODE_TTL_MS: Twilio drops undelivered messages after this. */
const VALIDITY_SECONDS = 600;

export type TwilioMessagingConfiguration = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
  /** E.164 dialling prefixes allowed as destinations, e.g. ["+962", "+965"]. */
  allowedCountryPrefixes: readonly string[];
  /** Exact E.164 destinations; required (non-empty) in staging. */
  stagingAllowlist: readonly string[];
};

export class TwilioDeliveryError extends Error {
  constructor(readonly reason: string, readonly twilioCode?: number) {
    super(`SMS delivery failed: ${reason}${twilioCode ? ` (Twilio ${twilioCode})` : ""}`);
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;
const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);

/** Returns the configuration, or the names (never values) of the settings at fault. */
export function readTwilioMessagingConfiguration(
  env: NodeJS.ProcessEnv,
  environment: ProviderDeploymentEnvironment,
): { configuration: TwilioMessagingConfiguration } | { problems: string[] } {
  const problems: string[] = [];
  const accountSid = env.TWILIO_ACCOUNT_SID ?? "";
  const apiKeySid = env.TWILIO_API_KEY_SID ?? "";
  const apiKeySecret = env.TWILIO_API_KEY_SECRET ?? "";
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID ?? "";
  const allowedCountryPrefixes = list(env.DINAR_SMS_ALLOWED_COUNTRY_PREFIXES);
  const stagingAllowlist = list(env.DINAR_SMS_STAGING_ALLOWLIST);
  if (!/^AC[0-9a-f]{32}$/.test(accountSid)) problems.push("TWILIO_ACCOUNT_SID");
  // A restricted API key, never the account auth token.
  if (!/^SK[0-9a-f]{32}$/.test(apiKeySid)) problems.push("TWILIO_API_KEY_SID");
  if (apiKeySecret.length < 16) problems.push("TWILIO_API_KEY_SECRET");
  if (!/^MG[0-9a-f]{32}$/.test(messagingServiceSid)) problems.push("TWILIO_MESSAGING_SERVICE_SID");
  if (!allowedCountryPrefixes.length || !allowedCountryPrefixes.every((p) => /^\+[1-9]\d{0,3}$/.test(p)))
    problems.push("DINAR_SMS_ALLOWED_COUNTRY_PREFIXES");
  if (environment === "staging" && (!stagingAllowlist.length || !stagingAllowlist.every((n) => E164.test(n))))
    problems.push("DINAR_SMS_STAGING_ALLOWLIST");
  if (environment !== "staging" && stagingAllowlist.length) problems.push("DINAR_SMS_STAGING_ALLOWLIST");
  return problems.length
    ? { problems }
    : { configuration: { accountSid, apiKeySid, apiKeySecret, messagingServiceSid, allowedCountryPrefixes, stagingAllowlist } };
}

export function verificationMessage(code: string) {
  return `رمز التحقق في جاسم: ${code}\nلا تشاركه مع أي أحد. صالح 10 دقائق.`;
}

export function createTwilioMessagingProvider(
  configuration: TwilioMessagingConfiguration,
  environment: ProviderDeploymentEnvironment,
  fetchImpl: typeof fetch = fetch,
): PhoneVerificationProvider {
  const authorization = `Basic ${Buffer.from(`${configuration.apiKeySid}:${configuration.apiKeySecret}`).toString("base64")}`;
  const url = `${TWILIO_API}/Accounts/${configuration.accountSid}/Messages.json`;
  return {
    async sendCode(normalizedPhone, code) {
      if (!E164.test(normalizedPhone)) throw new TwilioDeliveryError("destination is not E.164");
      if (!/^\d{4,10}$/.test(code)) throw new TwilioDeliveryError("code format");
      if (!configuration.allowedCountryPrefixes.some((prefix) => normalizedPhone.startsWith(prefix)))
        throw new TwilioDeliveryError("destination country not enabled");
      if (environment === "staging" && !configuration.stagingAllowlist.includes(normalizedPhone))
        throw new TwilioDeliveryError("destination not on the staging allowlist");
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            To: normalizedPhone,
            MessagingServiceSid: configuration.messagingServiceSid,
            Body: verificationMessage(code),
            ValidityPeriod: String(VALIDITY_SECONDS),
          }),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new TwilioDeliveryError("network or timeout");
      }
      if (!response.ok) {
        let twilioCode: number | undefined;
        try {
          const body = (await response.json()) as { code?: unknown };
          if (typeof body.code === "number") twilioCode = body.code;
        } catch {
          // The provider's body is never echoed.
        }
        throw new TwilioDeliveryError(`HTTP ${response.status}`, twilioCode);
      }
      return {};
    },
  };
}

/**
 * The registration for this deployment, or the setting names that block it. Staging registers
 * in SANDBOX mode (allowlisted numbers only); production in LIVE mode, which phone-verification.ts
 * still refuses unless DINAR_LIVE_PROVIDERS_ENABLED=true.
 */
export function twilioMessagingRegistration(
  env: NodeJS.ProcessEnv,
  environment: ProviderDeploymentEnvironment | undefined,
  fetchImpl: typeof fetch = fetch,
): { registration: ProviderRegistration<"SMS"> } | { problems: string[] } {
  if (environment !== "staging" && environment !== "production") return { problems: ["DINAR_DEPLOYMENT_ENV"] };
  const read = readTwilioMessagingConfiguration(env, environment);
  if ("problems" in read) return read;
  return {
    registration: {
      family: "SMS",
      providerKey: TWILIO_MESSAGING_PROVIDER_KEY,
      mode: environment === "staging" ? "SANDBOX" : "LIVE",
      environments: [environment],
      marketIds: ["*"],
      create: () => createTwilioMessagingProvider(read.configuration, environment, fetchImpl),
    },
  };
}
