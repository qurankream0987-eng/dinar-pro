/**
 * Sign in with Google (identity only).
 *
 * Google proves an email identity; it never proves phone ownership. A Google identity is
 * therefore linked to a DINAR account only after the existing SMS phone verification
 * succeeds (/auth/google/complete), and DINAR still creates and owns the session.
 *
 * ID tokens (Google Identity Services, "credential") are verified here with Node's crypto:
 * RS256 signature against Google's published JWKS, issuer, audience (our client id),
 * expiry/issued-at with a small skew, and a verified email. Only `openid email profile` data is
 * read. The token and its claims are never logged.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKeyInput } from "node:crypto";

type JsonWebKey = JsonWebKeyInput["key"];

export const GOOGLE_PROVIDER = "GOOGLE" as const;
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLOCK_SKEW_SECONDS = 60;
export const PENDING_TICKET_TTL_MS = 10 * 60_000;
export const GOOGLE_PENDING_COOKIE = "bdinar_google_pending";

export type GoogleIdentity = { subject: string; email: string; emailVerified: true; name: string | null };

type Jwks = { keys: (JsonWebKey & { kid?: string })[] };
export type JwksFetcher = () => Promise<{ jwks: Jwks; maxAgeSeconds: number }>;

const defaultFetcher: JwksFetcher = async () => {
  const response = await fetch(GOOGLE_JWKS_URL, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Google signing keys are unavailable");
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
  return { jwks: (await response.json()) as Jwks, maxAgeSeconds: Math.min(Number(maxAge ?? 3600), 24 * 3600) };
};

let fetcher: JwksFetcher = defaultFetcher;
let cache: { jwks: Jwks; expiresAt: number } | undefined;

/** Tests and a future key-rotation probe replace the fetcher; production uses Google's endpoint. */
export function setGoogleJwksFetcher(next: JwksFetcher | undefined) {
  fetcher = next ?? defaultFetcher;
  cache = undefined;
}

async function signingKey(kid: string, now: number) {
  if (!cache || cache.expiresAt <= now) {
    const { jwks, maxAgeSeconds } = await fetcher();
    cache = { jwks, expiresAt: now + maxAgeSeconds * 1000 };
  }
  let key = cache.jwks.keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    // A rotated key: refresh once before refusing.
    const { jwks, maxAgeSeconds } = await fetcher();
    cache = { jwks, expiresAt: now + maxAgeSeconds * 1000 };
    key = cache.jwks.keys.find((candidate) => candidate.kid === kid);
  }
  return key;
}

export function googleClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  return value && /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(value) ? value : undefined;
}

const invalid = () => Object.assign(new Error("تعذر التحقق من حساب Google. أعد المحاولة."), { status: 401, code: "GOOGLE_TOKEN_INVALID", expose: true });

function decodePart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export async function verifyGoogleIdToken(idToken: unknown, input: { clientId: string; now?: number }): Promise<GoogleIdentity> {
  if (typeof idToken !== "string" || idToken.length > 4096) throw invalid();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalid();
  let header: any;
  let claims: any;
  try {
    header = decodePart(parts[0]!);
    claims = decodePart(parts[1]!);
  } catch {
    throw invalid();
  }
  if (header?.alg !== "RS256" || typeof header.kid !== "string") throw invalid();
  const now = input.now ?? Date.now();
  let key: (JsonWebKey & { kid?: string }) | undefined;
  try {
    key = await signingKey(header.kid, now);
  } catch {
    throw Object.assign(new Error("خدمة Google غير متاحة الآن. أعد المحاولة بعد قليل."), { status: 503, code: "GOOGLE_UNAVAILABLE", expose: true });
  }
  if (!key) throw invalid();
  const signed = verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  if (!signed) throw invalid();
  const seconds = Math.floor(now / 1000);
  if (
    !GOOGLE_ISSUERS.has(claims.iss) ||
    claims.aud !== input.clientId ||
    typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255 ||
    typeof claims.exp !== "number" || claims.exp < seconds - CLOCK_SKEW_SECONDS ||
    typeof claims.iat !== "number" || claims.iat > seconds + CLOCK_SKEW_SECONDS ||
    typeof claims.email !== "string" || claims.email.length > 320 ||
    claims.email_verified !== true
  )
    throw invalid();
  const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 80) : "";
  return { subject: claims.sub, email: claims.email.toLowerCase(), emailVerified: true, name: name || null };
}

/** Short-lived, HMAC-signed proof that this browser just verified a Google identity. */
function ticketSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Session signing key is unavailable");
  return secret;
}

export function issuePendingTicket(identity: GoogleIdentity, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: identity.subject, email: identity.email, name: identity.name, exp: now + PENDING_TICKET_TTL_MS })).toString("base64url");
  const mac = createHmac("sha256", ticketSecret()).update(`google-pending\0${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}

export function readPendingTicket(value: unknown, now = Date.now()): GoogleIdentity | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", ticketSecret()).update(`google-pending\0${payload}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp <= now || typeof data.sub !== "string" || typeof data.email !== "string") return null;
    return { subject: data.sub, email: data.email, emailVerified: true, name: typeof data.name === "string" ? data.name : null };
  } catch {
    return null;
  }
}
