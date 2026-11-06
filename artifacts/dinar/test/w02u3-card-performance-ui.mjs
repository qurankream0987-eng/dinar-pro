import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder } from "./sc-ui-session.mjs";
import { settleToasts, signIn } from "./w02u3-ui-session.mjs";

/**
 * W02U-3 — CR-15 long-conversation benchmark.
 *
 * A fixture seeds real transcripts of 40, 100 and 500 messages. The app windows the thread at 40
 * bubbles, so the benchmark measures the same cold-open path for every size: a fresh page, no
 * saved conversation, open the history drawer, open that conversation, and wait until its last
 * message is rendered. Each size is opened three times per viewport after a full reload, so every
 * sample is a cold client load. The report carries per-group median/p95, thread DOM nodes and
 * bubble counts; the wrapper re-checks the budgets and the stored transcript lengths.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const buyer = {
  id: process.env.W02U3_BUYER_ID,
  cookie: process.env.W02U3_BUYER_COOKIE,
  phone: process.env.W02U3_BUYER_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const targets = JSON.parse(process.env.W02U3_PERF_TARGETS ?? "[]");
const resultPath = process.env.W02U3_PERF_RESULT_PATH;
if (!webBase || !apiOrigin || !buyer.id || !buyer.cookie || !buyer.phone || !buyer.password || !targets.length || !resultPath)
  throw new Error("Missing W02U-3 performance journey configuration.");

const budgets = {
  loadP95Ms: 4_000,
  loadMedianMs: 2_500,
  bubbleCap: 40,
  domCap: 8_000,
  growthFactor: 1.6,
};
const viewports = [
  { label: "320", width: 320, height: 844, mobile: true },
  { label: "1280", width: 1280, height: 900, mobile: false },
];
const reps = 3;

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const samples = [];
const windowing = [];
const typing = [];
const edits = [];
let failure;
let browser;

function watch(page, label) {
  page.on("pageerror", (error) => recorder.pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") recorder.consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${label}: ${url.hostname}${url.pathname}`);
  });
}

const bubblesOf = (page) =>
  page.locator('[data-testid="conversation-thread"] [data-testid^="message-user-"], [data-testid="conversation-thread"] [data-testid^="message-assistant-"]').count();

const threadShape = (page) =>
  page.evaluate(() => {
    const thread = document.querySelector('[data-testid="conversation-thread"]');
    return {
      nodes: thread ? thread.querySelectorAll("*").length : 0,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      threadOverflow: thread ? thread.scrollWidth - thread.clientWidth : 0,
    };
  });

const progress = (step) => console.error(`W02U3_PERF_PROGRESS ${new Date().toISOString()} ${step}`);

async function coldState(page) {
  progress("cold:goto");
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  progress("cold:composer");
  await settleToasts(page);
  progress("cold:settled");
}

async function openTarget(page, target, mobile) {
  // Below 1024px the history lives in a drawer behind the toggle; above it the aside is persistent.
  if (mobile) {
    const toggle = page.getByTestId("button-toggle-conversation-history");
    if ((await toggle.getAttribute("aria-expanded").catch(() => null)) !== "true") await toggle.click();
  }
  const item = page.getByTestId(`conversation-${target.conversationId}`);
  await item.waitFor({ state: "visible", timeout: 45_000 });
  progress(`open:${target.messages ?? ""}:item-visible`);
  const startedAt = Date.now();
  await item.click();
  await page
    .locator('[data-testid="conversation-thread"]')
    .getByText(target.endMarker, { exact: false })
    .first()
    .waitFor({ timeout: 30_000 });
  return Date.now() - startedAt;
}

function statsOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return { median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted.at(-1), samples: sorted.length };
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  for (const viewport of viewports) {
    const context = await browser.newContext({
      baseURL: webBase,
      viewport: { width: viewport.width, height: viewport.height },
      ...(viewport.mobile ? { isMobile: true, hasTouch: true } : {}),
      locale: "ar",
    });
    // The isolated harness returns an empty stylesheet for Google Fonts. Fulfill the same stub
    // in-process so repeated cold navigations do not depend on TLS-stub connection reuse.
    await context.route("https://fonts.googleapis.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "/* sandbox font stub */" }),
    );
    await context.route("https://fonts.gstatic.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "font/woff2", body: "" }),
    );
    // Count real AssistantBody executions in Vite's test-only response. Nothing is
    // instrumented in the application source or production bundle.
    await context.route("**/src/features/ai/ConversationContent.tsx*", async (route) => {
      try {
        const response = await route.fetch({ maxRetries: 2 });
        const body = await response.text();
        const instrumented = body.replace(
          /function AssistantBody\([\s\S]*?\)\s*\{/,
          "$& globalThis.__dinarAssistantBodyRenders = (globalThis.__dinarAssistantBodyRenders ?? 0) + 1;",
        );
        await route.fulfill({ response, body: instrumented });
      } catch {
        // Cold navigation can cancel an in-flight module. A failed active load
        // still fails the page-error, loaded-marker, or instrumentation checks.
        await route.abort("failed").catch(() => undefined);
      }
    });
    const page = await context.newPage();
    watch(page, viewport.label);
    await signIn(page, buyer);

    for (const target of targets) {
      for (let rep = 0; rep < reps; rep++) {
        await coldState(page);
        const ms = await openTarget(page, target, viewport.mobile);
        const bubbles = await bubblesOf(page);
        const shape = await threadShape(page);
        assert.equal(bubbles, budgets.bubbleCap, `${viewport.label} ${target.size}: the thread renders only its window (${bubbles} bubbles)`);
        assert.ok(shape.nodes <= budgets.domCap, `${viewport.label} ${target.size}: ${shape.nodes} thread nodes exceed ${budgets.domCap}`);
        assert.equal(shape.documentOverflow, 0, `${viewport.label} ${target.size}: document overflow ${shape.documentOverflow}`);
        assert.equal(shape.threadOverflow, 0, `${viewport.label} ${target.size}: thread overflow ${shape.threadOverflow}`);
        if (target.size > budgets.bubbleCap)
          assert.equal(await page.getByTestId("button-load-older-messages").count(), 1, `${viewport.label} ${target.size}: older messages are offered, not rendered`);
        samples.push({ viewport: viewport.label, size: target.size, rep, ms, bubbles, nodes: shape.nodes });
      }
    }

    // One explicit window extension in the largest transcript: one more batch, still bounded.
    const largest = targets.reduce((best, target) => (target.size > best.size ? target : best), targets[0]);
    await coldState(page);
    await openTarget(page, largest, viewport.mobile);
    const before = await bubblesOf(page);
    await page.getByTestId("button-load-older-messages").click();
    await page.waitForFunction((count) => document.querySelectorAll('[data-testid="conversation-thread"] [data-testid^="message-"]').length > count, before, { timeout: 15_000 });
    const after = await bubblesOf(page);
    const shape = await threadShape(page);
    assert.ok(after > before && after <= budgets.bubbleCap * 2, `the older batch is bounded: ${before} → ${after}`);
    assert.ok(shape.nodes <= budgets.domCap, `${shape.nodes} nodes after loading older messages`);
    windowing.push({ viewport: viewport.label, size: largest.size, before, after, nodes: shape.nodes });
    const composer = page.getByTestId("input-ai-composer");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const beforeTyping = await page.evaluate(() => globalThis.__dinarAssistantBodyRenders);
    assert.ok(beforeTyping > 0, "the real assistant renderer was instrumented and executed");
    for (let index = 1; index <= 12; index++) await composer.fill("مسودة جديدة ".repeat(index));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const afterTyping = await page.evaluate(() => globalThis.__dinarAssistantBodyRenders);
    typing.push({ viewport: viewport.label, edits: 12, assistantBodyRenders: afterTyping - beforeTyping });
    assert.equal(afterTyping, beforeTyping, "typing a draft must not reparse completed assistant history");
    // The stable edit callback must read the currently selected transcript, not
    // the first conversation captured when the page mounted.
    const editButton = page.locator('[data-testid^="button-edit-message-"]').last();
    const editId = (await editButton.getAttribute("data-testid")).replace("button-edit-message-", "");
    await editButton.click();
    const editedBody = "ابحث عن ثلاجة";
    await page.getByTestId(`textarea-edit-message-${editId}`).fill(editedBody);
    const [copied, turn] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/ai/conversations/${largest.conversationId}/copies` && response.request().method() === "POST"),
      page.waitForResponse((response) => /\/api\/ai\/conversations\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === "POST"),
      page.getByTestId(`button-save-message-edit-${editId}`).click(),
    ]);
    assert.ok(copied.ok(), "editing creates an owned conversation branch");
    const { conversation: branch } = await copied.json();
    assert.equal(typeof branch.id, "string", "the copy response contains its conversation identity");
    assert.notEqual(branch.id, largest.conversationId, "the original history is preserved");
    assert.equal(new URL(turn.url()).pathname, `/api/ai/conversations/${branch.id}/turns`, "the reply is sent on the current edit branch");
    assert.ok(turn.ok());
    // The client cancels its SSE reader once the «complete» event arrives, so Playwright never
    // reports this response as finished; the rendered branch is the observable completion.
    await page.locator('[data-testid="conversation-thread"]').getByText(editedBody, { exact: true }).waitFor({ timeout: 45_000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
      null,
      { timeout: 45_000 },
    );
    edits.push({ viewport: viewport.label, original: largest.conversationId, branch: branch.id });
    await context.close();
  }

  const groups = {};
  for (const sample of samples) {
    const key = `${sample.viewport}/${sample.size}`;
    (groups[key] ??= []).push(sample);
  }
  const summary = {};
  for (const [key, group] of Object.entries(groups)) {
    const timing = statsOf(group.map((sample) => sample.ms));
    const nodes = statsOf(group.map((sample) => sample.nodes));
    summary[key] = { ...timing, nodesMedian: nodes.median };
    assert.ok(timing.p95 <= budgets.loadP95Ms, `${key}: p95 ${timing.p95}ms exceeds ${budgets.loadP95Ms}ms`);
    assert.ok(timing.median <= budgets.loadMedianMs, `${key}: median ${timing.median}ms exceeds ${budgets.loadMedianMs}ms`);
  }
  for (const viewport of viewports) {
    const small = summary[`${viewport.label}/${targets[0].size}`];
    const large = summary[`${viewport.label}/${targets.at(-1).size}`];
    assert.ok(large.nodesMedian <= small.nodesMedian * budgets.growthFactor, `${viewport.label}: thread DOM grew ${small.nodesMedian} → ${large.nodesMedian} nodes`);
  }
  checks.push(`CR-15: 40/100/500-message transcripts open cold within ${budgets.loadMedianMs}ms median / ${budgets.loadP95Ms}ms p95 on 320 and 1280`);
  checks.push("CR-15: the thread windows at 40 bubbles for every transcript size");
  checks.push("CR-15: one older batch loads on demand and stays bounded");
  checks.push("CR-15: thread DOM nodes do not grow with transcript size");
  checks.push("CR-15: 320px has no horizontal overflow in the long thread");
  checks.push("CR-15: cold loads repeat three times per size and viewport on a fresh client");
  checks.push("CR-15: draft edits do not re-render completed assistant bodies");
  checks.push("CR-15: stable actions edit the current conversation and preserve its original history");

  writeFileSync(
    resultPath,
    JSON.stringify({ checks, failure: undefined, budgets, views: viewports.map(({ label }) => label), reps, samples, summary, windowing, typing, edits, pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors, externalRequests: recorder.externalRequests, modelFallbacks: recorder.modelFallbacks }, null, 2),
  );
  await browser.close();
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  writeFileSync(
    resultPath,
    JSON.stringify({ checks, failure, budgets, views: viewports.map(({ label }) => label), reps, samples, windowing, typing, edits, pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors, externalRequests: recorder.externalRequests, modelFallbacks: recorder.modelFallbacks }, null, 2),
  );
  await browser?.close().catch(() => undefined);
}
