import app from "./app";
import { closeExpiredBuyerWindows, sendClosureReminders } from "./lib/order-closure";
import { logger } from "./lib/logger";
import { startSearchIndexMaintenance } from "./lib/marketplace-search-index";
import { onProviderBreakerTransition } from "./ai/model-gateway";
import { releaseExpiredReservations } from "./routes/marketplace";
import { scrubStaleLocationPreviews } from "./ai/delivery-turn";
import { settleAbandonedExecutions } from "./ai/action-recovery";
import { expireStalePromotions } from "./lib/promotions";
import { validateObjectStorageConfiguration } from "./lib/objectStorage";
import { startVisualSearchExpirySweep } from "./lib/visual-search-images";
import { expireChatVideos } from "./lib/chat-video";
import { deploymentConfigurationProblems } from "./lib/deployment-configuration";
import { installGracefulShutdown } from "./server-lifecycle";
import { sweepDriverLocationShares } from "./lib/driver-location";
import { registerPhoneVerificationProvider } from "./lib/phone-verification";
import { providerDeploymentEnvironment } from "./lib/market-capability-registry";
import { TWILIO_MESSAGING_PROVIDER_KEY, twilioMessagingRegistration } from "./lib/sms/twilio-messaging";
import { startNotificationEmailWorker } from "./lib/notification-email-outbox";

// Alerting: a provider/model circuit opening is a warning; closing is info. No prompt, user or key.
onProviderBreakerTransition((event) =>
  event.state === "OPEN"
    ? logger.warn({ event: "dinar_ai_provider_circuit_open", ...event }, "AI provider circuit opened")
    : logger.info({ event: "dinar_ai_provider_circuit_closed", ...event }, "AI provider circuit closed"),
);

// SMS delivery is registered only when this deployment selects the Twilio adapter; otherwise
// phone verification stays not_configured. Setting names (never values) are logged.
if (process.env.DINAR_PHONE_VERIFICATION_PROVIDER === TWILIO_MESSAGING_PROVIDER_KEY) {
  const twilio = twilioMessagingRegistration(process.env, providerDeploymentEnvironment());
  if ("registration" in twilio) registerPhoneVerificationProvider(twilio.registration);
  else logger.warn({ settings: twilio.problems }, "Twilio SMS adapter is not configured; phone verification stays not_configured");
}

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

const stopVisualSearchExpirySweep = startVisualSearchExpirySweep({
  onDeleted: (count) => logger.info({ count }, "Expired visual-search photos removed"),
  onError: (err) => logger.error({ err }, "Failed to expire visual-search photos; the next sweep will retry"),
});

// Chat videos are kept for seven days, then removed (lib/chat-video.ts).
const chatVideoSweep = setInterval(() => {
  void expireChatVideos()
    .then((count) => { if (count) logger.info({ count }, "Expired chat videos removed"); })
    .catch((err) => logger.error({ err }, "Failed to expire chat videos; the next sweep will retry"));
}, 60 * 60 * 1000);
chatVideoSweep.unref();

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
  // Deal closure: 48 h buyer windows after «تم البيع بدون رمز» close, and the 24 h reminder is sent.
  void closeExpiredBuyerWindows()
    .then((count) => { if (count > 0) logger.info({ count }, "Deals closed after the 48-hour buyer window"); })
    .catch((err) => logger.error({ err }, "Failed to close expired buyer windows; the next sweep will retry"));
  void sendClosureReminders()
    .then((count) => { if (count > 0) logger.info({ count }, "Deal-closure reminders sent"); })
    .catch((err) => logger.error({ err }, "Failed to send deal-closure reminders; the next sweep will retry"));
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
// Ends idle or no-longer-authorized location sharing and drops expired audit rows.
const sweepDriverLocations = () =>
  void sweepDriverLocationShares()
    .then(({ ended, deleted }) => {
      if (ended || deleted) logger.info({ ended, deleted }, "Driver location sharing housekeeping");
    })
    .catch((err) => logger.error({ err }, "Driver location sharing housekeeping failed; the next sweep will retry"));
sweepDriverLocations();
const driverLocationSweep = setInterval(sweepDriverLocations, 60_000);
driverLocationSweep.unref?.();
sweepExpiredReservations();
const reservationSweep = setInterval(sweepExpiredReservations, 60_000);
reservationSweep.unref();

let stopSearchIndexMaintenance: (() => void) | undefined;
let stopNotificationEmailWorker: (() => void) | undefined;
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  stopNotificationEmailWorker = startNotificationEmailWorker();
  // C1: build and refresh search documents in the background (search stays correct without them).
  stopSearchIndexMaintenance = startSearchIndexMaintenance();
});
installGracefulShutdown(server, {
  beforeShutdown: () => {
    clearInterval(reservationSweep);
    stopVisualSearchExpirySweep();
    stopNotificationEmailWorker?.();
    stopSearchIndexMaintenance?.();
  },
});
