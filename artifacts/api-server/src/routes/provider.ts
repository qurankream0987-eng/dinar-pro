import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { AUTH_RATE_LIMIT_SCOPE, consumeRateLimit, normalizeClientIp } from "../lib/auth-rate-limiter";
import { logger } from "../lib/logger";
import {
  PROVIDER_LIMITS,
  PROVIDER_SCOPES,
  type ProviderContext,
  ProviderError,
  authenticateProviderKey,
  createProviderConnection,
  issueProviderCredential,
  listProviderConnections,
  providerError,
  revokeProviderConnection,
} from "../lib/provider-connections";
import {
  archiveProviderListing,
  createDriverLinkCode,
  linkProviderDriver,
  readProviderDriver,
  readProviderListing,
  unlinkOwnDriverProfile,
  unlinkProviderDriver,
  upsertProviderListing,
  upsertProviderListingBatch,
} from "../lib/provider-sync";

/**
 * G1 provider boundary. `/provider/*` authenticates a bearer provider key (never the
 * browser session) and then calls the same canonical authorities the app uses.
 * `/provider-connections` and the driver link endpoints are session routes for the
 * owner and the driver themselves.
 */
const router = Router();

/** Twenty requests per key per ten seconds, on the shared HMAC-keyed buckets. */
export const PROVIDER_RATE_WINDOW_SECONDS = 10;
const INVALID_KEY_WINDOW_SECONDS = 60;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      provider?: ProviderContext;
    }
  }
}

const SECRET_WARNING = "احفظ المفتاح الآن، لن نعرضه كاملًا مرة أخرى.";

function rateLimited(retryAfterSeconds: number) {
  return Object.assign(providerError(429, "RATE_LIMITED", "طلبات كثيرة. حاول لاحقًا."), { retryAfterSeconds });
}

const providerAuth: RequestHandler = async (req, res, next) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
  let context: ProviderContext;
  try {
    context = await authenticateProviderKey(bearer);
  } catch (error) {
    // Guessing keys is limited per client address; a key's own bucket is never touched.
    if (error instanceof ProviderError && error.code === "INVALID_CREDENTIAL") {
      const decision = await consumeRateLimit(
        [{ scope: AUTH_RATE_LIMIT_SCOPE.providerInvalid, value: normalizeClientIp(req.ip || req.socket.remoteAddress || "") }],
        INVALID_KEY_WINDOW_SECONDS,
      );
      if (decision) throw rateLimited(decision.retryAfterSeconds);
    }
    throw error;
  }
  const decision = await consumeRateLimit(
    [{ scope: AUTH_RATE_LIMIT_SCOPE.providerCredential, value: context.credentialId }],
    PROVIDER_RATE_WINDOW_SECONDS,
  );
  if (decision) throw rateLimited(decision.retryAfterSeconds);
  if (context.owner.activeMarketId !== context.connection.marketId)
    throw providerError(409, "MARKET_MISMATCH", "سوق حساب المالك الحالي يختلف عن سوق هذا الربط");
  req.provider = context;
  next();
};

const provider = (req: Request) => req.provider!;
const ref = (req: Request) => String(req.params.externalRef);

router.use("/provider", providerAuth);

router.get("/provider/connection", async (req, res) => {
  const [view] = await listProviderConnections(provider(req).owner.id, [provider(req).connection.id]);
  res.json(view);
});

router.put("/provider/listings/:externalRef", async (req, res) => {
  const outcome = await upsertProviderListing(provider(req), ref(req), req.body);
  res.status(outcome.result === "CREATED" ? 201 : 200).json(outcome);
});

router.get("/provider/listings/:externalRef", async (req, res) => {
  res.json(await readProviderListing(provider(req), ref(req)));
});

router.delete("/provider/listings/:externalRef", async (req, res) => {
  res.json(await archiveProviderListing(provider(req), ref(req)));
});

router.post("/provider/listings/batch", async (req, res) => {
  res.json(await upsertProviderListingBatch(provider(req), req.body));
});

router.post("/provider/drivers/link", async (req, res) => {
  res.json(await linkProviderDriver(provider(req), req.body));
});

router.get("/provider/drivers/:externalRef", async (req, res) => {
  res.json(await readProviderDriver(provider(req), ref(req)));
});

router.delete("/provider/drivers/:externalRef", async (req, res) => {
  res.json(await unlinkProviderDriver(provider(req), ref(req)));
});

// Provider errors are machine-readable and never carry stack, SQL, hashes or ids of
// other owners. Anything else falls through to the app's generic 5xx handler.
router.use("/provider", ((error, _req, res, next) => {
  if (error instanceof ProviderError) {
    if (error.status === 429) res.setHeader("Retry-After", String((error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 1));
    res.status(error.status).json({ error: error.message, code: error.code, ...(error.issues ? { issues: error.issues } : {}) });
    return;
  }
  if (error?.name === "ZodError" || error?.type === "entity.parse.failed") {
    res.status(400).json({ error: "بيانات الطلب غير صالحة", code: "INVALID_PAYLOAD" });
    return;
  }
  logger.error({ code: error?.code ?? "PROVIDER_REQUEST_FAILED" }, "Provider request failed");
  res.status(500).json({ error: "تعذر إتمام العملية. حاول لاحقًا.", code: "INTERNAL_ERROR" });
  void next;
}) as import("express").ErrorRequestHandler);

// ─── Owner management (browser session) ──────────────────────────────────────

const CreateConnectionBody = z
  .object({
    name: z.string().max(80).optional(),
    scopes: z.array(z.enum(PROVIDER_SCOPES)).max(PROVIDER_SCOPES.length).optional(),
    marketId: z.string().max(10).optional(),
  })
  .strict();

router.get("/provider-connections", requireAuth, async (req, res) => {
  res.json({ connections: await listProviderConnections(req.actor!.id), limits: PROVIDER_LIMITS });
});

/** Creates the connection and its first key; the key appears in this response only. */
router.post("/provider-connections", requireAuth, async (req, res) => {
  const body = CreateConnectionBody.parse(req.body);
  const connection = await createProviderConnection({
    ownerId: req.actor!.id,
    name: body.name,
    scopes: body.scopes,
    requestedMarketId: body.marketId,
  });
  const issued = await issueProviderCredential({ ownerId: req.actor!.id, connectionId: connection.id });
  const [view] = await listProviderConnections(req.actor!.id, [connection.id]);
  res.status(201).json({ connection: view, key: issued.key, keyPrefix: issued.keyPrefix, warning: SECRET_WARNING });
});

/** Issues a new key and revokes the previous one in the same transaction. */
router.post("/provider-connections/:id/credentials", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const issued = await issueProviderCredential({ ownerId: req.actor!.id, connectionId: String(req.params.id) });
  const [view] = await listProviderConnections(req.actor!.id, [issued.connection.id]);
  res.status(201).json({ connection: view, key: issued.key, keyPrefix: issued.keyPrefix, rotated: issued.rotated, warning: SECRET_WARNING });
});

router.post("/provider-connections/:id/revoke", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const outcome = await revokeProviderConnection({ ownerId: req.actor!.id, connectionId: String(req.params.id) });
  const [view] = await listProviderConnections(req.actor!.id, [outcome.connection.id]);
  res.json({ connection: view, pausedListings: outcome.pausedListings, unlinkedDrivers: outcome.unlinkedDrivers });
});

// ─── Driver consent (browser session) ────────────────────────────────────────

router.post("/account/driver-link-code", requireAuth, async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.status(201).json(await createDriverLinkCode({ userId: req.actor!.id }));
});

router.delete("/account/driver-links", requireAuth, async (req, res) => {
  res.json(await unlinkOwnDriverProfile({ userId: req.actor!.id }));
});

export default router;
