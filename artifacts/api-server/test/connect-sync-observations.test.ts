import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { ConnectSyncObservationSchema } from "@workspace/api-zod/connect-platform";
import {
  recordConnectSyncObservation,
  safeConnectSyncFailure,
} from "../src/connect/sync-observations";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
await test("diagnostic failures use only supported reason codes without provider messages or arbitrary error codes", () => {
  assert.equal(
    safeConnectSyncFailure({
      code: "PROVIDER_TIMEOUT",
      message: "synthetic-observation-secret-canary",
    }),
    "PROVIDER_TIMEOUT",
  );
  for (const error of [
    null,
    undefined,
    "synthetic-observation-secret-canary",
    { code: "synthetic-observation-secret-canary", message: "do not expose" },
    { code: 7 },
  ])
    assert.equal(safeConnectSyncFailure(error), "UNEXPECTED_FAILURE");
});
await test("sync observations cannot acquire raw messages, secrets or contradictory outcomes", () => {
  const observation = {
    integrationId: "fd373bf0-9d5c-4b83-b0fa-a2c6761d71a4",
    outcome: "COMPLETED",
    reason: null,
    reviewedRevision: 1,
    durationMs: 0,
  };
  assert.ok(ConnectSyncObservationSchema.safeParse(observation).success);
  for (const patch of [
    { reason: "PROVIDER_TIMEOUT" },
    { outcome: "FAILED" },
    { durationMs: -1 },
    { reviewedRevision: 0 },
    { accessToken: "synthetic-observation-secret-canary" },
    { rawResponse: "private" },
  ])
    assert.equal(
      ConnectSyncObservationSchema.safeParse({ ...observation, ...patch })
        .success,
      false,
    );
});
await test("malformed diagnostic data is never written and cannot turn a completed caller operation into a failure", async () => {
  const before = (
    await pool.query("select count(*)::text n from connect_audit_events")
  ).rows[0].n;
  await assert.doesNotReject(
    recordConnectSyncObservation("invalid-fixture-actor", {} as never, {
      accessToken: "synthetic-observation-secret-canary",
    }),
  );
  assert.equal(
    (await pool.query("select count(*)::text n from connect_audit_events"))
      .rows[0].n,
    before,
  );
});
after(async () => {
  await pool.end();
});
