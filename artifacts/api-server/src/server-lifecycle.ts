import type { Server } from "node:http";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

type ShutdownOptions = {
  /** Replaceable so a test can observe the exit instead of ending its own process. */
  exit?: (code: number) => void;
  timeoutMs?: number;
  beforeShutdown?: () => void;
};

/**
 * Drains the HTTP server and closes the pool on SIGTERM/SIGINT. A replica that is being
 * replaced stops accepting work and releases its database connections instead of being killed
 * mid-request. Idempotent: a second signal while draining does nothing.
 */
export function installGracefulShutdown(
  server: Server,
  {
    exit = (code) => process.exit(code),
    timeoutMs = 10_000,
    beforeShutdown,
  }: ShutdownOptions = {},
) {
  let draining: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (draining) return draining;
    logger.info({ signal }, "Draining HTTP server and closing the database pool");
    let cleanupFailed = false;
    try {
      beforeShutdown?.();
    } catch (error) {
      cleanupFailed = true;
      logger.error({ signal, err: error }, "Pre-shutdown cleanup failed");
    }
    draining = new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        logger.error({ signal, timeoutMs }, "Graceful shutdown timed out; forcing exit");
        server.closeAllConnections();
        exit(1);
        resolve();
      }, timeoutMs);
      deadline.unref();
      // Stop accepting new connections and let keep-alive sockets go, then close the pool.
      server.closeIdleConnections();
      server.close((serverError) => {
        if (serverError)
          logger.error({ signal, err: serverError }, "HTTP server failed to close cleanly");
        void pool.end().then(
          () => {
          clearTimeout(deadline);
          logger.info({ signal }, "Graceful shutdown complete");
          exit(cleanupFailed || Boolean(serverError) ? 1 : 0);
          resolve();
          },
          (error) => {
            clearTimeout(deadline);
            logger.error({ signal, err: error }, "Database pool failed to close cleanly");
            exit(1);
            resolve();
          },
        );
      });
    });
    return draining;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
