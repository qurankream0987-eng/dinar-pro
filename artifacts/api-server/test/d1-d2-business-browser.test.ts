/**
 * D1/D2 browser acceptance: the real API in this process (disposable loopback database, loopback
 * S3-compatible storage, MOCKED in-process document scanner, no billing provider), the DINAR
 * production build served by `vite preview`, and ../dinar/test/d1-d2-business-browser.mjs driving
 * Chromium on mobile and desktop. Afterwards the server state is checked against what the browser did.
 */
import { localObjectStorage } from "./local-object-storage";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { businessProfiles, businessSubscriptions, businessVerificationDocuments, db, pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { registerBusinessDocumentScanner } from "../src/lib/business-profiles";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_D1D2_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const execFileAsync = promisify(execFile);
const originalFetch = globalThis.fetch;
registerBusinessDocumentScanner({ scannerKey: "mock-scanner", async scan() { return "CLEAN"; } });

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port as number;
const base = `http://127.0.0.1:${port}/api`;
const runId = randomUUID().slice(0, 6);
let ipSequence = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), "X-Forwarded-For": `198.61.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_790_000 + ((Date.now() + process.pid) % 9_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `D1d2-${randomUUID().slice(0, 12)}!`;
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.62.0.${phoneOffset}` },
    body: JSON.stringify({ displayName: `DINAR d12 ui ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken }),
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, cookie)).status, 200);
  return { id: data.user.id, cookie };
}
async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port: free } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}
async function startBuiltWeb() {
  const webPort = await availablePort();
  const env = { ...process.env, PORT: String(webPort), BASE_PATH: "/", NODE_ENV: "production" };
  await execFileAsync("pnpm", ["--filter", "@workspace/dinar", "run", "build"], { cwd: process.cwd(), env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const child = spawn("pnpm", ["--filter", "@workspace/dinar", "run", "serve"], { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const stop = async () => {
    if (child.exitCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await originalFetch(baseUrl);
      if (response.ok && (await response.text()).includes('<div id="root"')) return { baseUrl, stop };
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null) throw new Error(`vite preview exited:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stop();
  throw new Error(`vite preview did not start:\n${output}`);
}

let owner: Actor;
let other: Actor;
let report: any;
await test("setup: two KW accounts on the free plan", async () => {
  owner = await register(`owner-${runId}`);
  other = await register(`other-${runId}`);
});

await test("D2-16 browser: DINAR Business card and plans on mobile and desktop (Chromium, production build)", async () => {
  const web = await startBuiltWeb();
  const resultPath = `/tmp/dinar-d12-ui-${runId}.json`;
  const pdfPath = `/tmp/dinar-d12-ui-${runId}.pdf`;
  await writeFile(pdfPath, Buffer.concat([Buffer.from("%PDF-1.4\n% DINAR browser test\n"), Buffer.alloc(256, 0x20), Buffer.from("\n%%EOF\n")]));
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/d1-d2-business-browser.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: { ...process.env, D12_WEB_BASE: web.baseUrl, D12_API_ORIGIN: `http://127.0.0.1:${port}`, D12_COOKIES: JSON.stringify({ owner: owner.cookie, other: other.cookie }), D12_PDF_PATH: pdfPath, D12_RESULT_PATH: resultPath },
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
    await unlink(pdfPath).catch(() => undefined);
  }
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("D12_BROWSER", JSON.stringify({ results: report?.results, counters: report?.counters, failure: report?.failure, report: report?.report }));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(Object.values(report.results).filter((value) => value !== "PASS"), []);
  assert.equal(Object.keys(report.results).length, 8);
});

await test("server truth behind the browser journey", async () => {
  const rows = await db.select().from(businessProfiles).where(eq(businessProfiles.ownerUserId, owner.id));
  assert.equal(rows.length, 1, "one business, created once through the conversation");
  const [business] = rows;
  assert.deepEqual([business!.displayName, business!.marketId, business!.categoryKey, business!.verificationStatus, business!.registrationNumberLast4], ["سمراء للمشاوي", "KW", "GRILL_RESTAURANT", "PENDING_REVIEW", "3456"]);
  const docs = await db.select().from(businessVerificationDocuments).where(and(eq(businessVerificationDocuments.businessId, business!.id), eq(businessVerificationDocuments.status, "UPLOADED")));
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.scanStatus, "CLEAN");
  assert.equal((await db.select().from(businessProfiles).where(eq(businessProfiles.ownerUserId, other.id))).length, 0);
  assert.equal((await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.userId, owner.id))).length, 0, "the Business question created no subscription");
  assert.equal(getModelGatewayCallCount(), 0);
});

after(async () => {
  server.close();
  await localObjectStorage?.close();
  await pool.end();
});
