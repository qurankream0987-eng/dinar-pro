import app from "./app";
import { logger } from "./lib/logger";
import { startSearchIndexMaintenance } from "./lib/marketplace-search-index";
import { onProviderBreakerTransition } from "./ai/model-gateway";
import { releaseExpiredReservations } from "./routes/marketplace";
import { scrubStaleLocationPreviews } from "./ai/delivery-turn";
import { settleAbandonedExecutions } from "./ai/action-recovery";
import { expireStalePromotions } from "./lib/promotions";
import { validateObjectStorageConfiguration } from "./lib/objectStorage";
import { deploymentConfigurationProblems } from "./lib/deployment-configuration";

// Alerting: a provider/model circuit opening is a warning; closing is info. No prompt, user or key.
onProviderBreakerTransition((event) =>
  event.state === "OPEN"
    ? logger.warn({ event: "dinar_ai_provider_circuit_open", ...event }, "AI provider circuit opened")
    : logger.info({ event: "dinar_ai_provider_circuit_closed", ...event }, "AI provider circuit closed"),
);

validateObjectStorageConfiguration();
// Missing required deployment settings keep /readyz not_ready; names (never values) help the operator.
const configurationProblems = deploymentConfigurationProblems();
if (configurationProblems.length)
  logger.warn({ settings: configurationProblems }, "Deployment configuration is incomplete; readiness will report not_ready");

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const sweepExpiredReservations = () => {
  // Unconfirmed location previews never outlive their confirmation window.
  void scrubStaleLocationPreviews().catch((err) =>
    logger.error({ err }, "Failed to scrub expired location previews"),
  );
  // Housekeeping only: serving already ignores expired campaigns on every read.
  void expireStalePromotions().catch((err) =>
    logger.error({ err }, "Failed to mark expired promotions"),
  );
  void releaseExpiredReservations()
    .then((count) => {
      if (count > 0)
        logger.info({ count }, "Expired order reservations released");
    })
    .catch((err) =>
      logger.error({ err }, "Failed to release expired order reservations"),
    );
  // An EXECUTING claim whose process died is settled as UNKNOWN, never re-executed.
  void settleAbandonedExecutions()
    .then((count) => {
      if (count > 0)
        logger.warn({ count }, "Abandoned action executions settled as unknown");
    })
    .catch((err) =>
      logger.error({ err }, "Failed to settle abandoned action executions"),
    );
};
sweepExpiredReservations();
const reservationSweep = setInterval(sweepExpiredReservations, 60_000);
reservationSweep.unref();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // C1: build and refresh search documents in the background (search stays correct without them).
  startSearchIndexMaintenance();
});
