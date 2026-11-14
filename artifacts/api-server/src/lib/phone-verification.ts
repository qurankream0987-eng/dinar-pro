import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { providerDeploymentEnvironment } from "./market-capability-registry";
import type { ProviderRegistration } from "./provider-boundaries";

export const PHONE_VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
export const PHONE_VERIFICATION_MAX_ATTEMPTS = 5;

export type PhoneVerificationDeliveryResult = {
  developmentCode?: string;
};

export interface PhoneVerificationProvider {
  sendCode(
    normalizedPhone: string,
    code: string,
  ): Promise<PhoneVerificationDeliveryResult>;
}

/** The development adapter returns the code to the caller; it never serves staging or production. */
class DevelopmentPhoneVerificationProvider implements PhoneVerificationProvider {
  async sendCode(
    _normalizedPhone: string,
    code: string,
  ): Promise<PhoneVerificationDeliveryResult> {
    return { developmentCode: code };
  }
}

const developmentProvider = new DevelopmentPhoneVerificationProvider();

/**
 * Staging and production deliver codes through an SMS adapter registered at startup under the key
 * DINAR_PHONE_VERIFICATION_PROVIDER names (the vendor is the owner's decision; none is bundled).
 * Platform-wide like monitoring, not per market: a challenge precedes any market and carries only
 * a phone number, whose dialling code can be shared by several countries.
 * As with monitoring, the registration must match the labelled deployment environment
 * (DINAR_DEPLOYMENT_ENV), and a LIVE adapter also needs DINAR_LIVE_PROVIDERS_ENABLED=true.
 * Without one, challenges answer 503 and /readyz reports phoneVerification=not_configured.
 */
const registrations = new Map<string, ProviderRegistration<"SMS">>();
let active: { registration: ProviderRegistration<"SMS">; provider: PhoneVerificationProvider } | undefined;

/** Registration is server code, never configuration from a request. */
export function registerPhoneVerificationProvider(registration: ProviderRegistration<"SMS">) {
  registrations.set(registration.providerKey, registration);
  active = undefined;
}
export function unregisterPhoneVerificationProvider(providerKey: string) {
  registrations.delete(providerKey);
  active = undefined;
}

function resolveRegisteredProvider(): ProviderRegistration<"SMS"> | undefined {
  const key = process.env.DINAR_PHONE_VERIFICATION_PROVIDER;
  const environment = providerDeploymentEnvironment();
  if (!key || !environment || environment === "development") return undefined;
  const mode = environment === "staging" ? "SANDBOX" : "LIVE";
  if (mode === "LIVE" && process.env.DINAR_LIVE_PROVIDERS_ENABLED !== "true") return undefined;
  const registration = registrations.get(key);
  if (!registration || registration.mode !== mode || !registration.environments.includes(environment)) return undefined;
  return registration;
}

export function getPhoneVerificationProvider():
  | PhoneVerificationProvider
  | undefined {
  // The development provider returns the code in the API response. It is only ever used when
  // the deployment itself resolves to development: a service labelled staging or production
  // (DINAR_DEPLOYMENT_ENV) never falls back to it, even if NODE_ENV was left at development.
  if ((process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") && providerDeploymentEnvironment() === "development")
    return developmentProvider;
  const registration = resolveRegisteredProvider();
  if (!registration) return undefined;
  if (active?.registration !== registration) {
    const created = Promise.resolve(registration.create());
    active = { registration, provider: { sendCode: async (phone, code) => (await created).sendCode(phone, code) } };
  }
  return active.provider;
}

export function phoneVerificationStatus(): "ready" | "not_configured" {
  return getPhoneVerificationProvider() ? "ready" : "not_configured";
}

export function newPhoneVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function newRegistrationVerificationToken(): string {
  return randomBytes(32).toString("hex");
}

export function phoneVerificationDigest(
  purpose: "phone" | "code" | "registration-token",
  value: string,
): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Phone-verification signing key is unavailable");
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`)
    .digest("hex");
}

export function matchesPhoneVerificationCode(
  storedHash: string,
  challengeId: string,
  code: string,
): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(
    phoneVerificationDigest("code", `${challengeId}\0${code}`),
    "hex",
  );
  return expected.length === actual.length && expected.length > 0
    ? timingSafeEqual(expected, actual)
    : false;
}