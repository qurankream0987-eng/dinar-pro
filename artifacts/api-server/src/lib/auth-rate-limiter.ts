import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { authRateLimitBuckets, db } from "@workspace/db";
import { logger } from "./logger";

export const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 20;
export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 900;
export const AUTH_RATE_LIMIT_BACKEND_RETRY_SECONDS = 30;

export const AUTH_RATE_LIMIT_SCOPE = {
  ip: "auth-ip",
  loginPhone: "login-phone",
  registrationPhone: "registration-phone",
  phoneVerificationPhone: "phone-verification-phone",
  phoneVerificationChallenge: "phone-verification-challenge",
  passwordUser: "password-user",
  providerCredential: "provider-credential",
  providerInvalid: "provider-invalid-ip",
  guestAiPreview: "guest-ai-preview-ip",
  conversationModelActor: "conversation-model-actor",
  conversationModelHeavyActor: "conversation-model-heavy-actor",
  inquiryActor: "inquiry-actor",
  privacyUser: "privacy-user",
} as const;

export type AuthRateLimitIdentity = {
  scope: string;
  value: string;
};

export type AuthRateLimitDecision = {
  retryAfterSeconds: number;
} | null;

export type AuthRateLimitConsumer = (
  clientIp: string,
  identity?: AuthRateLimitIdentity,
) => Promise<AuthRateLimitDecision>;

let lastCleanupAt = 0;

export function normalizeClientIp(value: string): string {
  const input = value.trim();
  const bracketed = input.match(/^\[([^\]]+)\](?::\d+)?$/);
  const address = (bracketed?.[1] ?? input).split("%", 1)[0];
  if (!address) throw new Error("Client IP address is missing");

  if (isIP(address) === 4) return `ipv4:${address}`;
  if (isIP(address) !== 6)
    throw new Error("Client IP address is invalid");

  const mappedV4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedV4 && isIP(mappedV4) === 4) return `ipv4:${mappedV4}`;

  const canonical = new URL(`http://[${address}]/`).hostname
    .slice(1, -1)
    .toLowerCase();
  return `ipv6:${canonical}`;
}

export function authRateLimitKeyHash(scope: string, value: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Authentication rate-limit signing key is unavailable");
  return createHmac("sha256", secret)
    .update(`${scope}\0${value}`)
    .digest("hex");
}

async function pruneExpiredBuckets() {
  const now = Date.now();
  if (now - lastCleanupAt < 60_000) return;
  lastCleanupAt = now;
  void db
    .delete(authRateLimitBuckets)
    .where(sql`${authRateLimitBuckets.resetAt} <= clock_timestamp()`)
    .catch((error: { code?: string }) => {
      logger.warn(
        { code: error?.code ?? "AUTH_RATE_LIMIT_CLEANUP" },
        "Expired authentication rate-limit buckets could not be pruned",
      );
    });
}

export const consumeAuthRateLimit: AuthRateLimitConsumer = async (
  rawClientIp,
  identity,
) =>
  consumeRateLimit(
    [
      { scope: AUTH_RATE_LIMIT_SCOPE.ip, value: normalizeClientIp(rawClientIp) },
      ...(identity ? [identity] : []),
    ],
    AUTH_RATE_LIMIT_WINDOW_SECONDS,
  );

/**
 * The shared fixed-window counter: every identity is an HMAC-keyed bucket allowing
 * AUTH_RATE_LIMIT_MAX_ATTEMPTS per window. Authentication uses a 15-minute window;
 * the provider API (G1) reuses the same buckets with a short window.
 */
export async function consumeRateLimit(
  identities: AuthRateLimitIdentity[],
  windowSeconds: number,
  maxAttempts = AUTH_RATE_LIMIT_MAX_ATTEMPTS,
): Promise<AuthRateLimitDecision> {
  const keys = identities.map((identity) => authRateLimitKeyHash(identity.scope, identity.value));

  const buckets = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
    const consumed: Array<{ attempts: number; resetAt: Date }> = [];
    for (const keyHash of keys) {
      const [bucket] = await tx
        .insert(authRateLimitBuckets)
        .values({
          keyHash,
          attempts: 1,
          resetAt: sql`clock_timestamp() + make_interval(secs => ${windowSeconds})`,
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: authRateLimitBuckets.keyHash,
          set: {
            attempts: sql`CASE
              WHEN ${authRateLimitBuckets.resetAt} <= clock_timestamp() THEN 1
              ELSE LEAST(${authRateLimitBuckets.attempts} + 1, ${maxAttempts + 1})
            END`,
            resetAt: sql`CASE
              WHEN ${authRateLimitBuckets.resetAt} <= clock_timestamp()
                THEN clock_timestamp() + make_interval(secs => ${windowSeconds})
              ELSE ${authRateLimitBuckets.resetAt}
            END`,
            updatedAt: sql`clock_timestamp()`,
          },
        })
        .returning({
          attempts: authRateLimitBuckets.attempts,
          resetAt: authRateLimitBuckets.resetAt,
        });
      if (!bucket) throw new Error("Rate-limit counter update returned no row");
      consumed.push(bucket);
    }
    return consumed;
  });

  pruneExpiredBuckets();

  const blocked = buckets.filter(
    (bucket) => bucket.attempts > maxAttempts,
  );
  if (!blocked.length) return null;
  return {
    retryAfterSeconds: Math.max(
      1,
      ...blocked.map((bucket) =>
        Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000),
      ),
    ),
  };
}

export function createAuthRateLimitMiddleware(
  getIdentity?: (request: Request) => AuthRateLimitIdentity | undefined,
  consume: AuthRateLimitConsumer = consumeAuthRateLimit,
): RequestHandler {
  return (request, response, next) => {
    void Promise.resolve()
      .then(() =>
        consume(
          request.ip || request.socket.remoteAddress || "",
          getIdentity?.(request),
        ),
      )
      .then((decision) => {
        if (decision) {
          response.setHeader("Retry-After", String(decision.retryAfterSeconds));
          response
            .status(429)
            .json({ error: "محاولات كثيرة. حاول لاحقًا." });
          return;
        }
        next();
      })
      .catch((error: { code?: string }) => {
        logger.error(
          { code: error?.code ?? "AUTH_RATE_LIMIT_BACKEND" },
          "Authentication rate-limit authority unavailable",
        );
        response.setHeader(
          "Retry-After",
          String(AUTH_RATE_LIMIT_BACKEND_RETRY_SECONDS),
        );
        response
          .status(503)
          .json({ error: "تعذر التحقق من المحاولات الآن. حاول لاحقًا." });
      });
  };
}