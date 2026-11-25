import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export type ResendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
};

export class ResendEmailError extends Error {
  constructor(readonly code: string) {
    super("Resend email delivery failed");
    this.name = "ResendEmailError";
  }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function resendEmailConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM_EMAIL?.trim();
  return apiKey && from && EMAIL_SHAPE.test(from) ? { apiKey, from } : undefined;
}

export function stagingEmailAllowlist(env: NodeJS.ProcessEnv = process.env) {
  if (env.DINAR_DEPLOYMENT_ENV !== "staging") return [];
  return (env.DINAR_EMAIL_STAGING_ALLOWLIST ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => EMAIL_SHAPE.test(email));
}

export function isStagingEmailRecipientAllowed(to: string, env: NodeJS.ProcessEnv = process.env) {
  return stagingEmailAllowlist(env).includes(to.trim().toLowerCase());
}

export function jassimaiPublicUrl(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.JASSIMAI_PUBLIC_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

export function newEmailVerificationCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function emailVerificationDigest(
  userId: string,
  email: string,
  challengeId: string,
  code: string,
  secret = process.env.SESSION_SECRET,
) {
  if (!secret) throw new ResendEmailError("EMAIL_VERIFICATION_SECRET_MISSING");
  return createHmac("sha256", secret)
    .update(`email-verification\u0000${userId}\u0000${email}\u0000${challengeId}\u0000${code}`)
    .digest("hex");
}

export function secureDigestEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createEmailUnsubscribeToken(
  userId: string,
  email: string,
  secret = process.env.SESSION_SECRET,
) {
  if (!secret) throw new ResendEmailError("EMAIL_UNSUBSCRIBE_SECRET_MISSING");
  const signature = createHmac("sha256", secret)
    .update(`email-unsubscribe\u0000${userId}\u0000${email}`)
    .digest("hex");
  return `${userId}.${signature}`;
}

export function verifyEmailUnsubscribeToken(
  token: string,
  userId: string,
  email: string,
  secret = process.env.SESSION_SECRET,
) {
  if (!secret) return false;
  const [tokenUserId, signature, extra] = token.split(".");
  if (extra !== undefined || tokenUserId !== userId || !signature) return false;
  const expected = createEmailUnsubscribeToken(userId, email, secret).split(".")[1]!;
  return secureDigestEqual(signature, expected);
}

export async function sendResendEmail(
  input: ResendEmailInput,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.DINAR_DEPLOYMENT_ENV !== "staging")
    throw new ResendEmailError("RESEND_STAGING_ONLY");
  if (!isStagingEmailRecipientAllowed(input.to, env))
    throw new ResendEmailError("RESEND_STAGING_RECIPIENT_NOT_ALLOWED");
  const configuration = resendEmailConfiguration(env);
  if (!configuration) throw new ResendEmailError("RESEND_NOT_CONFIGURED");
  if (!EMAIL_SHAPE.test(input.to) || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256)
    throw new ResendEmailError("RESEND_INVALID_EMAIL");

  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: configuration.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.headers ? { headers: input.headers } : {}),
      }),
    });
  } catch {
    throw new ResendEmailError("RESEND_NETWORK_ERROR");
  }

  if (!response.ok) throw new ResendEmailError(`RESEND_HTTP_${response.status}`);
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ResendEmailError("RESEND_INVALID_RESPONSE");
  }
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !result.id)
    throw new ResendEmailError("RESEND_INVALID_RESPONSE");
  return { providerMessageId: result.id };
}
