/**
 * Loopback rehearsal of the staging end-to-end journey: the same script that runs against
 * staging (artifacts/dinar/test/staging-e2e-journey.mjs), here against the built web app, the
 * development SMS adapter, the loopback object store and the fixture JO market. No network.
 */
import { localObjectStorage } from "./local-object-storage";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { pool } from "@workspace/db";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

await test("staging journey rehearsal: register, login, photo, listing, search card, cart, checkout, orders", async () => {
  const web = await startDinarBrowserTestWeb(origin);
  const reportPath = `/tmp/dinar-staging-rehearsal-${randomUUID()}.json`;
  const phone = () => `+96279${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;
  let runError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/staging-e2e-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        STG_BASE: web.baseUrl,
        STG_LOCAL_REHEARSAL: "1",
        STG_SELLER_PHONE: phone(),
        STG_BUYER_PHONE: phone(),
        STG_REPORT: reportPath,
        STG_SHOTS: `/tmp/dinar-staging-rehearsal-shots`,
      },
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    runError = error;
  } finally {
    await web.stop();
  }
  let report: any;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
    await unlink(reportPath);
  } catch {
    report = undefined;
  }
  console.log("STAGING_REHEARSAL", JSON.stringify(report));
  if (!report) throw runError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.ok(report.checks.length >= 20, JSON.stringify(report.checks));
  void localObjectStorage;
});

after(async () => {
  server.close();
  await localObjectStorage?.close?.();
  await pool.end();
});
