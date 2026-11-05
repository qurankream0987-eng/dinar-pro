import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { sessionMiddleware } from "./lib/auth";
import pinoHttp from "pino-http";
import router from "./routes";
import health from "./routes/health";
import { logger, serializeSafeError } from "./lib/logger";
import { reportServerError } from "./lib/monitoring";
import { createDevelopmentListingPhotoSuggestionProvider } from "./ai/groq-listing-photo-provider";
import { ListingImagePolicyReviewError } from "./ai/listing-image-policy-review";
import { createWebFrontend } from "./lib/web-frontend";

const app: Express = express();
const listingPhotoSuggestionProvider =
  createDevelopmentListingPhotoSuggestionProvider();
if (listingPhotoSuggestionProvider)
  app.locals.listingPhotoSuggestionProvider = listingPhotoSuggestionProvider;
// Replit routes requests through one trusted ingress proxy. Keep the hop count
// explicit; trusting every forwarded hop would let callers spoof their IP.
app.set("trust proxy", 1);

function normalizeOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function firstForwardedValue(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(",")[0]?.trim() || undefined;
}

function expectedRequestOrigin(req: Request) {
  if (process.env.APP_ORIGIN) return normalizeOrigin(process.env.APP_ORIGIN);

  const forwardedHost = firstForwardedValue(req.headers["x-forwarded-host"]);
  const forwardedProto = firstForwardedValue(req.headers["x-forwarded-proto"]);
  if (
    process.env.TRUST_PROXY_ORIGIN === "true" &&
    forwardedHost &&
    (forwardedProto === "http" || forwardedProto === "https")
  ) {
    try {
      const forwarded = new URL(`${forwardedProto}://${forwardedHost}`);
      if (
        !forwarded.username &&
        !forwarded.password &&
        forwarded.pathname === "/" &&
        !forwarded.search &&
        !forwarded.hash
      )
        return forwarded.origin;
    } catch {
      // Ignore malformed proxy headers and fall back to the direct request origin.
    }
  }

  return normalizeOrigin(`${req.protocol}://${req.get("host")}`);
}

function replitOrigins() {
  const domains = [
    process.env.REPLIT_DEV_DOMAIN,
    ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
  ];
  return domains.flatMap((domain) => {
    const value = domain?.trim();
    if (!value) return [];
    const origin = normalizeOrigin(
      value.includes("://") ? value : `https://${value}`,
    );
    return origin ? [origin] : [];
  });
}

app.use(
  pinoHttp({
    logger,
    genReqId: () => randomUUID(),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
      err: serializeSafeError,
    },
  }),
);
app.disable("x-powered-by");

/**
 * The built SPA loads only its own modules, styles and API. Google Fonts is the one
 * declared external origin; images and recorded audio stay same-origin or blob/data.
 * Listing photos upload straight to the configured object store with a presigned PUT, so that
 * origin (and an explicit deployment allowlist) is added to connect-src and nothing else.
 */
const CONTENT_SECURITY_POLICY_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Replit Preview embeds the app in a platform-controlled frame. Keep the allowlist narrow;
  // X-Frame-Options cannot express it and would override this policy in older browsers.
  "frame-ancestors 'self' https://replit.com https://*.replit.com https://*.replit.dev",
];
function browserConnectOrigins() {
  const origins = new Set<string>();
  const configured = process.env.CSP_CONNECT_EXTRA_ORIGINS ?? "";
  for (const value of configured.split(",")) {
    const origin = normalizeOrigin(value.trim());
    if (origin) origins.add(origin);
  }
  if (process.env.OBJECT_STORAGE_PROVIDER === "s3") {
    const origin = normalizeOrigin(process.env.OBJECT_STORAGE_S3_ENDPOINT);
    if (origin) origins.add(origin);
  }
  return ["'self'", ...origins].join(" ");
}
function contentSecurityPolicy() {
  return [
    ...CONTENT_SECURITY_POLICY_DIRECTIVES.map((directive) =>
      directive.startsWith("frame-ancestors ") && (
        process.env.NODE_ENV === "production" ||
        process.env.DINAR_DEPLOYMENT_ENV === "staging" ||
        process.env.DINAR_DEPLOYMENT_ENV === "production"
      ) ? "frame-ancestors 'self'" : directive,
    ),
    `connect-src ${browserConnectOrigins()}`,
  ].join("; ");
}
const PERMISSIONS_POLICY = [
  "camera=(self)",
  "microphone=(self)",
  "geolocation=(self)",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
].join(", ");

app.use((req, res, next) => {
  res.setHeader("X-Request-Id", String(req.id));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  if (process.env.NODE_ENV === "production")
    // Subdomain coverage stays opt-in: it is only safe once every subdomain of the approved
    // domain is HTTPS-only, and no approved domain inventory exists in this repository yet.
    res.setHeader(
      "Strict-Transport-Security",
      process.env.HSTS_INCLUDE_SUBDOMAINS === "true"
        ? "max-age=31536000; includeSubDomains"
        : "max-age=31536000",
    );
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.origin;
    const normalizedOrigin = normalizeOrigin(origin);
    const expected = expectedRequestOrigin(req);
    const allowedOrigins = new Set(replitOrigins());
    if (expected) allowedOrigins.add(expected);
    const contentType = req.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const voiceTranscriptionUpload =
      req.path === "/api/ai/voice-transcription" &&
      ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"].includes(contentType ?? "");
    if (
      (origin &&
        (!normalizedOrigin || !allowedOrigins.has(normalizedOrigin))) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (!req.is("application/json") && !voiceTranscriptionUpload)
    ) {
      res.status(403).json({ error: "طلب غير مسموح" });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "128kb" }));
app.use(express.urlencoded({ extended: true }));
// Zod 3 records one issue per failing array element (GHSA-mrhx-c7xc-m3w5): 128 KB of JSON can
// hold ~65k elements and ~24 MB of issues. The largest request array any schema allows is 250,
// so whole-body array elements are bounded before any route schema runs.
export const MAX_JSON_ARRAY_ELEMENTS = 2000;
function exceedsArrayBound(body: unknown) {
  let elements = 0;
  const pending: unknown[] = [body];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      elements += value.length;
      if (elements > MAX_JSON_ARRAY_ELEMENTS) return true;
      pending.push(...value);
    } else if (value && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
  return false;
}
app.use((req, res, next) => {
  if (exceedsArrayBound(req.body)) {
    res.status(413).json({ error: "حجم البيانات المرسلة أكبر من المسموح" });
    return;
  }
  next();
});

app.use(cookieParser());
// Operational probes stay outside session lookup so liveness remains useful
// during database outages and readiness can report dependency failure itself.
app.use("/api", health);
app.use("/api", sessionMiddleware, router);
// Unknown API paths are always a JSON 404; previously only the payments simulation gate
// answered them, so enabling the simulation exposed Express's HTML 404.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
if (process.env.DINAR_WEB_DIST) app.use(createWebFrontend(process.env.DINAR_WEB_DIST));
/** The single API error boundary; exported so its reporting can be exercised in isolation. */
export function apiErrorHandler(error: any, req: any, res: any, _next: any) {
  const imageReviewError =
    error instanceof ListingImagePolicyReviewError ? error : undefined;
  const status = imageReviewError
    ? imageReviewError.status
    : error.name === "ZodError" || error.type === "entity.parse.failed"
      ? 400
      : error.status || 500;
  // `expose: true` marks a deliberate, user-safe refusal (e.g. «provider not connected»): its
  // message and code are returned even for a 5xx, and it is not logged as a failure.
  const exposed = error.expose === true && typeof error.message === "string";
  if (status >= 500 && !exposed) {
    req.log.error({ err: error }, "API request failed");
    void reportServerError(error, req.id);
  }
  res.status(status).json({
    error:
      imageReviewError
        ? imageReviewError.message
        : status === 400 && !exposed
        ? "تحقق من البيانات المدخلة"
        : status >= 500 && !exposed
          ? "تعذر إتمام العملية. حاول لاحقًا."
          : error.message,
    ...(imageReviewError ? { code: imageReviewError.code } : {}),
    ...(exposed && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? { code: error.code } : {}),
    ...(error.issues && status === 409 ? { issues: error.issues } : {}),
  });
}
app.use(apiErrorHandler);

export default app;
