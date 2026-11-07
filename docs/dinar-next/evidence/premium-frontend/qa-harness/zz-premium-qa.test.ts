/**
 * CAMERA-SEARCH browser journey: a real buyer, the built web app, Chromium's fake camera, the
 * loopback object store and a local analyzer stand-in (no network, no spend, not Gemma evidence).
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
import type { VisualAnalyzer } from "../src/ai/visual-search";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

app.locals.visualAnalyzer = {
  async analyze() {
    return { status: "ANALYZED", analysis: { isProduct: true, brand: "iPhone", model: "14 Pro", category: "هواتف", keywords: ["ايفون"], confidence: 0.9 } };
  },
} satisfies VisualAnalyzer;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

await test("CAMERA-SEARCH browser: open, capture, preview, retake, cancel, denial, device photo, send, 320 px", async () => {
  const password = `Camera-search-${randomUUID().slice(0, 8)}!`;
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ displayName: "مشتري الكاميرا", phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true }),
  });
  assert.equal(response.status, 201, await response.text());
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!;
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-camera-search-${randomUUID()}.json`;
  let browserError: unknown;
  try {
    await promisify(execFile)(process.execPath, [`${process.cwd()}/../dinar/test/zz-premium-qa.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env, CS_WEB_BASE: web.baseUrl, CS_API_ORIGIN: origin, CS_COOKIE: cookie, CS_RESULT_PATH: resultPath, SHOTS: "/tmp/claude-0/-home-user/062bab8e-2006-50f1-a3f3-93dc51be737f/scratchpad/premium-qa", FONT_DIR: "/tmp/claude-0/-home-user/062bab8e-2006-50f1-a3f3-93dc51be737f/scratchpad/fonts", AXE: "/tmp/claude-0/-home-user/062bab8e-2006-50f1-a3f3-93dc51be737f/scratchpad/axe/package/axe.min.js", AUDIT_CHROMIUM: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
        CS_STORAGE_HOST: localObjectStorage ? new URL(localObjectStorage.endpoint).host : "",
      },
      timeout: 1_500_000,
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
  console.log("PREMIUM_QA", JSON.stringify(report));
  if (browserError && !report) throw browserError;
});

after(async () => {
  server.close();
  await localObjectStorage?.close?.();
  await pool.end();
});
