/**
 * WAVE 05 / D13 — graceful shutdown as a measured lifecycle, not a promise in a doc.
 *
 * A replica being replaced on Railway receives SIGTERM. This suite starts the real app on a
 * loopback port, proves it serves, then sends the signal and measures what the deployment
 * actually needs: the listener closes, the pool is ended, the exit code is 0, and a second
 * signal does not run the drain twice.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app";
import { pool } from "@workspace/db";
import { installGracefulShutdown } from "../src/server-lifecycle";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE05_SHUTDOWN");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

const report: Record<string, unknown> = {};
after(() => {
  console.log("WAVE05_D13_SHUTDOWN", JSON.stringify(report));
});

test("SD-01 the server serves, drains on SIGTERM, ends its pool and exits 0 once", async () => {
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200, "the replica serves before the signal");

  const exits: number[] = [];
  const shutdown = installGracefulShutdown(server, {
    exit: (code) => exits.push(code),
    timeoutMs: 5_000,
  });

  const startedAt = Date.now();
  process.emit("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (exits.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const drainMs = Date.now() - startedAt;

  assert.deepEqual(exits, [0], "the drain completes with a clean exit code");
  assert.equal(server.listening, false, "the listener stops accepting connections");

  let refused = false;
  try {
    await fetch(`${origin}/healthz`);
  } catch {
    refused = true;
  }
  assert.ok(refused, "a new connection is refused after the drain");

  let poolClosed = false;
  try {
    await pool.query("select 1");
  } catch {
    poolClosed = true;
  }
  assert.ok(poolClosed, "the database pool is ended, releasing the server's connections");

  // A second signal while draining must not run the drain or exit again.
  process.emit("SIGINT");
  await shutdown("SIGTERM");
  assert.deepEqual(exits, [0], "repeated signals are idempotent");

  report.shutdown = {
    signal: "SIGTERM",
    exitCodes: exits,
    drainMs,
    listenerClosed: !server.listening,
    newConnectionRefused: refused,
    poolEnded: poolClosed,
    repeatedSignalRanDrainAgain: false,
  };
});
