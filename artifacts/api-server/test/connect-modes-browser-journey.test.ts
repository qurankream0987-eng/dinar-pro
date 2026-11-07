/**
 * CONNECT-01 browser journey: a real owner and business through the API, then Chromium on the
 * built Connect page (mode choice, persistence, owner change, RTL/widths). No model, no payment.
 */
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
async function call(path: string, cookie = "", body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data, text };
}

await test("CONNECT-01 browser: three modes, persistence after reload, owner change, RTL at 320/390/1280", async () => {
  const password = `Connect-modes-${randomUUID().slice(0, 8)}!`;
  const registered = await call("/auth/register", "", { displayName: "تاجر أوضاع المتصفح", phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(registered.response.status, 201, registered.text);
  const cookie = registered.response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!;
  const business = await call("/business/profiles", cookie, { displayName: `متجر المتصفح ${randomUUID().replace(/[^a-f]/g, "").slice(0, 6)}`, categoryKey: "OTHER", idempotencyKey: randomUUID() });
  assert.equal(business.response.status, 201, business.text);
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-connect-modes-${randomUUID()}.json`;
  let browserError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/connect-modes-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: { ...process.env, CM_WEB_BASE: web.baseUrl, CM_API_ORIGIN: origin, CM_COOKIE: cookie, CM_RESULT_PATH: resultPath },
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  let report: any;
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("CONNECT_MODES_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  // The browser's choices are what the database holds.
  const stored = await pool.query("select participation_mode from connect_partners where business_id=$1", [business.data.business.id]);
  assert.equal(stored.rows[0]?.participation_mode, "HYBRID");
});

after(async () => {
  server.close();
  await pool.end();
});
