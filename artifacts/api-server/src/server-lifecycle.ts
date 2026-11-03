import type { Server } from "node:http";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

type ShutdownOptions = {
  /** Replaceable so a test can observe the exit instead of ending its own process. */
  exit?: (code: number) => void;
  timeoutMs?: number;
};

/**
 * Drains the HTTP server and closes the pool on SIGTERM/SIGINT. A replica that is being
 * replaced stops accepting work and releases its database connections instead of being killed
 * mid-request. Idempotent: a second signal while draining does nothing.
 */
export function installGracefulShutdown(
  server: Server,
  { exit = (code) => process.exit(code), timeoutMs = 10_000 }: ShutdownOptions = {},
) {
  let draining: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (draining) return draining;
    logger.info({ signal }, "Draining HTTP server and closing the database pool");
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
      server.close(() => {
        void pool.end().finally(() => {
          clearTimeout(deadline);
          logger.info({ signal }, "Graceful shutdown complete");
          exit(0);
          resolve();
        });
      });
    });
    return draining;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
