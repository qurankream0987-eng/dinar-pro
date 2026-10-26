import app from "./app";
import { logger } from "./lib/logger";
import { releaseExpiredReservations } from "./routes/marketplace";
import { scrubStaleLocationPreviews } from "./ai/delivery-turn";
import { expireStalePromotions } from "./lib/promotions";
import { validateObjectStorageConfiguration } from "./lib/objectStorage";
import { deploymentConfigurationProblems } from "./lib/deployment-configuration";

validateObjectStorageConfiguration();
// /readyz stays not_ready while any of these remain; the names (never values) help the operator.
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
});
