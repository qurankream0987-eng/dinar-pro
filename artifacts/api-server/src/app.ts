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
app.use((req, res, next) => {
  res.setHeader("X-Request-Id", String(req.id));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
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

app.use(cookieParser());
// Operational probes stay outside session lookup so liveness remains useful
// during database outages and readiness can report dependency failure itself.
app.use("/api", health);
app.use("/api", sessionMiddleware, router);
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
