import { db } from "@workspace/db";
import {
  CONNECT_SYNC_FAILURE_REASONS,
  ConnectSyncObservationSchema,
} from "@workspace/api-zod/connect-platform";
import { logger } from "../lib/logger";
import {
  connectAudit,
  lockOwnedConnectIntegration,
  type ConnectMarket,
} from "./partners";
export function safeConnectSyncFailure(error: unknown) {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return (
    CONNECT_SYNC_FAILURE_REASONS.find((reason) => reason === code) ??
    "UNEXPECTED_FAILURE"
  );
}
/** A diagnostic append can never invalidate an already committed catalog receipt. */
export async function recordConnectSyncObservation(
  actorId: string,
  market: ConnectMarket,
  raw: unknown,
) {
  try {
    const observation = ConnectSyncObservationSchema.parse(raw);
    await db.transaction(async (tx) => {
      const { partnerId } = await lockOwnedConnectIntegration(
        tx,
        actorId,
        market,
        observation.integrationId,
      );
      await connectAudit(
        tx,
        partnerId,
        actorId,
        "OWNER",
        `CATALOG_SYNC_${observation.outcome}`,
        observation,
      );
    });
  } catch {
    logger.warn(
      { event: "CONNECT_SYNC_AUDIT_UNAVAILABLE" },
      "Connect sync diagnostic append unavailable; live health remains unverified",
    );
  }
}
