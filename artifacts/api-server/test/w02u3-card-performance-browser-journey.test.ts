/**
 * W02U-3 — CR-15 long-conversation benchmark in real Chromium.
 *
 * Seeds the buyer's three conversations with 40, 100 and 500 stored messages (fixture rows in the
 * disposable database only), then runs artifacts/dinar/test/w02u3-card-performance-ui.mjs on 320
 * and 1280 viewports. The journey opens every transcript cold three times per viewport and records
 * median/p95 open time, thread DOM nodes and bubble counts. The wrapper re-checks the budgets and
 * the stored transcript lengths; the model gateway is never involved.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, messages, pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W02U3_BROWSER");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);
const password = "w02u3-performance-password-1";

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  // Jordanian mobiles are 9 digits starting 79 (the format the other suites register with).
  const number = `79${((Date.now() + 871203 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { id: created.data.user.id as string, cookie: created.cookie, phone: number };
}
async function conversation() {
  const created = await request("/ai/conversations", "POST", {}, buyer.cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

async function populate(conversationId: string, size: number, endMarker: string) {
  const base = Date.now() - size * 1_000;
  const rows = Array.from({ length: size }, (_, index) => ({
    id: randomUUID(),
    conversationId,
    senderId: index % 2 === 0 ? buyer.id : null,
    actor: index % 2 === 0 ? "USER" : "ASSISTANT",
    body: index === size - 1 ? `سجل طويل ${endMarker}` : `رسالة قياس ${index + 1} من ${size}`,
    contentType: "TEXT",
    metadata: { fixture: "w02u3-performance" },
    createdAt: new Date(base + index * 1_000),
  }));
  for (let offset = 0; offset < rows.length; offset += 100)
    await db.insert(messages).values(rows.slice(offset, offset + 100));
}

const buyer = await register(`مشتري الأداء ${runId}`);
const sizes = [40, 100, 500];
const targets: { size: number; conversationId: string; endMarker: string }[] = [];
for (const size of sizes) {
  const conversationId = await conversation();
  const endMarker = `W02U3-PERF-END-${size}-${runId}`;
  await populate(conversationId, size, endMarker);
  targets.push({ size, conversationId, endMarker });
}

await test("W02U3 CR-15 real browser: 40/100/500-message transcripts stay within the performance budgets", async () => {
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-w02u3-performance-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/w02u3-card-performance-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02U3_WEB_BASE: web.baseUrl,
        W02U3_API_ORIGIN: origin,
        W02U3_BUYER_ID: buyer.id,
        W02U3_BUYER_COOKIE: buyer.cookie,
        W02U3_BUYER_PHONE: buyer.phone,
        W02U3_PASSWORD: password,
        W02U3_PERF_TARGETS: JSON.stringify(targets),
        W02U3_PERF_RESULT_PATH: resultPath,
      },
      timeout: 900_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
    // A timed-out child keeps its diagnostics in the captured stream; surface the tail.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (stderr) console.error(`W02U3_PERF_STDERR_TAIL\n${stderr.slice(-6000)}`);
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
  console.log("W02U3_PERF", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, "the performance journey wrote its report");
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.modelFallbacks, []);
  assert.equal(report.samples.length, sizes.length * 2 * 3, "three cold samples per size and viewport");
  assert.ok(report.samples.every((sample: any) => sample.bubbles === 40), "every transcript renders the same 40-bubble window");
  assert.ok(report.samples.every((sample: any) => sample.nodes <= 8_000), "thread DOM stays under 8000 nodes");
  for (const view of ["320", "1280"]) {
    for (const size of sizes) {
      const group = report.summary[`${view}/${size}`];
      assert.ok(group, `missing the ${view}/${size} group`);
      assert.equal(group.samples, 3);
      assert.ok(group.median <= 2_500, `${view}/${size} median ${group.median}ms exceeds 2500ms`);
      assert.ok(group.p95 <= 4_000, `${view}/${size} p95 ${group.p95}ms exceeds 4000ms`);
    }
    const small = report.summary[`${view}/40`].nodesMedian;
    const large = report.summary[`${view}/500`].nodesMedian;
    assert.ok(large <= small * 1.6, `${view}: thread DOM grew ${small} → ${large} nodes`);
  }
  assert.equal(report.windowing.length, 2, "one window extension per viewport");
  assert.equal(report.typing.length, 2, "typing is checked on both viewport widths");
  for (const entry of report.typing) {
    assert.equal(entry.edits, 12);
    assert.equal(entry.assistantBodyRenders, 0, "completed history stays memoized while drafting");
  }
  assert.equal(report.edits.length, 2, "current-state edit actions are checked on both widths");
  for (const entry of report.edits) assert.notEqual(entry.branch, entry.original);
  for (const entry of report.windowing) {
    assert.ok(entry.after === entry.before * 2, `the older batch doubles the window: ${entry.before} → ${entry.after}`);
    assert.ok(entry.nodes <= 8_000);
  }
  assert.ok(report.checks.length >= 6, `expected the full performance journey, got ${report.checks.length} checks`);

  for (const target of targets) {
    const stored = await db.select().from(messages).where(eq(messages.conversationId, target.conversationId));
    assert.equal(stored.length, target.size, `the ${target.size}-message transcript is real`);
  }
  assert.equal(getModelGatewayCallCount(), modelCallsBefore, "the benchmark never reaches the model");
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
