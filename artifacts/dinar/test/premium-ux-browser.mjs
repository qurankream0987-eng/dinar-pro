import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * PREMIUM UX (Command 03) in real Chromium against the built app and the real API:
 *  - performance: time to a usable chat, LCP, CLS, long tasks, heap, long-history render and
 *    scroll frame stability, time from send to a rendered result card;
 *  - visual matrix: 8 widths × light/dark/system on a conversation holding a product grid, a
 *    comparison, a settings card and a Connect card, with layout assertions and screenshots;
 *  - journeys not covered by older suites: UX03 history search, UX08 subscription change then
 *    cancel, UX16 Connect from chat, UX24 markup injection rendered as text, reduced motion.
 * The browser never calls the model (asserted by the driver).
 */
const env = process.env;
const webBase = env.PUX_WEB_BASE;
const apiOrigin = env.PUX_API_ORIGIN;
const cookie = env.PUX_COOKIE;
const userId = env.PUX_USER_ID;
const matrixConversation = env.PUX_MATRIX_CONVERSATION;
const longConversation = env.PUX_LONG_CONVERSATION;
const historyTitleWord = env.PUX_HISTORY_WORD;
const fresh = JSON.parse(env.PUX_FRESH ?? "[]");
const run = env.PUX_RUN;
const phase = env.PUX_PHASE ?? "after";
const resultPath = env.PUX_RESULT_PATH;
const shots = env.PUX_SHOTS_DIR;
if (!webBase || !apiOrigin || !cookie || !userId || !matrixConversation || !longConversation || !resultPath || !shots)
  throw new Error("Missing premium UX browser configuration.");
mkdirSync(shots, { recursive: true });

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const perf = {};
const matrix = [];
const failures = [];
let browser;

async function restore(page, conversationId) {
  // The open chat saves its current conversation on unload, so the key is set while the chat
  // is not mounted (/connect), then the chat opens straight onto it.
  await page.goto("/connect");
  await page.evaluate(([key, id]) => localStorage.setItem(key, id), [`dinar-conversation:${userId}:JO`, conversationId]);
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  const active = await page.evaluate((key) => localStorage.getItem(key), `dinar-conversation:${userId}:JO`);
  assert.equal(active, conversationId, "the requested conversation is the one open");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function step(name, work) {
  try {
    await work();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    const page = globalThis.__puxPage;
    if (page) {
      await page.screenshot({ path: `${shots}/${phase}-FAIL-${name.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40)}.png` }).catch(() => undefined);
      failures.push(`  state: ${await page.evaluate(() => JSON.stringify({ url: location.pathname, assistant: document.querySelectorAll('[data-testid^="message-assistant-"]').length, user: document.querySelectorAll('[data-testid^="message-user-"]').length, send: document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label"), alert: document.querySelector('[role="alert"]')?.textContent?.slice(0, 120) })).catch(() => "?")}`);
    }
  }
}

try {
  browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const user = await openUser(browser, { webBase, apiOrigin, cookie, label: `pux-${phase}`, recorder });
  const page = user.page;
  globalThis.__puxPage = page;
  await page.addInitScript(() => {
    window.__pux = { cls: 0, lcp: 0, longTasks: 0, longTaskMs: 0 };
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__pux.cls += entry.value; }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => { const last = list.getEntries().at(-1); if (last) window.__pux.lcp = last.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) { window.__pux.longTasks += 1; window.__pux.longTaskMs += entry.duration; } }).observe({ type: "longtask", buffered: true });
  });

  // ── Performance: cold load to a usable chat ──────────────────────────────────
  await step("PERF cold load to a usable chat", async () => {
    const started = Date.now();
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="input-ai-composer"]')?.hasAttribute("disabled"));
    perf.timeToUsableChatMs = Date.now() - started;
    const nav = await page.evaluate(() => {
      const entry = performance.getEntriesByType("navigation")[0];
      return { domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd), loadMs: Math.round(entry.loadEventEnd) };
    });
    Object.assign(perf, nav);
    await page.waitForTimeout(500);
    Object.assign(perf, await page.evaluate(() => ({ lcpMs: Math.round(window.__pux.lcp), clsInitial: Number(window.__pux.cls.toFixed(4)), longTasksAtLoad: window.__pux.longTasks, longTaskMsAtLoad: Math.round(window.__pux.longTaskMs) })));
    perf.jsHeapMbAtLoad = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10);
  });

  // ── Performance: long history render and scroll stability ──────────────────────
  await step("PERF long history renders and scrolls without long frames", async () => {
    const started = Date.now();
    await restore(page, longConversation);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="message-assistant-"]').length >= 10, null, { timeout: 45_000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    perf.longHistoryRenderMs = Date.now() - started;
    perf.longHistoryMessages = await page.locator('[data-testid^="message-"]').count();
    perf.domNodesLongHistory = await page.evaluate(() => document.querySelectorAll("*").length);
    const frames = await page.evaluate(async () => {
      const scroller = [...document.querySelectorAll("*")].find((node) => node.scrollHeight > node.clientHeight + 200 && getComputedStyle(node).overflowY !== "visible") ?? document.scrollingElement;
      const deltas = [];
      let last = performance.now();
      const top = scroller.scrollTop;
      for (let index = 0; index < 60; index += 1) {
        scroller.scrollTop = top - (index + 1) * 60;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        deltas.push(now - last);
        last = now;
      }
      deltas.sort((a, b) => a - b);
      return { p50: Math.round(deltas[30]), p95: Math.round(deltas[56]), max: Math.round(deltas.at(-1)), over50ms: deltas.filter((value) => value > 50).length };
    });
    perf.scrollFrames = frames;
    perf.jsHeapMbLongHistory = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10);
    assert.ok(frames.over50ms <= 3, `scroll produced ${frames.over50ms} frames over 50 ms`);
  });

  // ── Performance: send to a rendered result card ─────────────────────────────
  await step("PERF send to a rendered product card", async () => {
    await restore(page, fresh[0]);
    const before = await page.locator('[data-testid^="card-ai-result-"]').count();
    const started = Date.now();
    await user.say(`ابي جوال ${run}`);
    await page.waitForFunction((count) => document.querySelectorAll('[data-testid^="card-ai-result-"]').length > count, before, { timeout: 30_000 });
    perf.sendToCardMs = Date.now() - started;
    perf.inputLatencyMs = await page.evaluate(async () => {
      const input = document.querySelector('[data-testid="input-ai-composer"]');
      const started = performance.now();
      input.focus();
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ا" }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Math.round(performance.now() - started);
    });
  });

  // ── UX03: history search finds the earlier conversation ──────────────────────
  await step("UX03 history search filters to the matching conversation", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const search = page.getByTestId("input-conversation-search");
    if (!(await search.isVisible())) await page.getByTestId("button-toggle-conversation-history").first().click();
    await search.fill(historyTitleWord);
    await page.locator(`[data-testid="conversation-${longConversation}"]`).waitFor({ state: "visible", timeout: 15_000 });
    await page.setViewportSize({ width: 390, height: 844 });
  });

  // ── UX08: subscription change, then keep the plan ───────────────────────────
  await step("UX08 plan change shows real plans; «لا، خله» keeps it; «نعم» does nothing", async () => {
    await restore(page, fresh[1]);
    const change = await user.say("غير اشتراكي للخطة الأعلى.");
    assert.match(await change.innerText(), /لم يتغير شيء/u);
    const keep = await user.say("لا، خل الاشتراك مثل ما هو.");
    assert.match(await keep.innerText(), /يبقى اشتراكك كما هو/u);
    await user.say("نعم", { allowFallback: true });
  });

  // ── UX24: markup in a message is text, never markup ─────────────────────────
  await step("UX24 injected markup is rendered as text; no dialog, no element", async () => {
    await restore(page, fresh[2]);
    let dialog = false;
    page.once("dialog", (d) => { dialog = true; void d.dismiss(); });
    const payload = `<img src=x onerror="alert(1)"><script>alert(2)</script> ${run}`;
    await user.say(payload, { allowFallback: true });
    const userBubble = page.locator('[data-testid^="message-user-"]').last();
    assert.ok((await userBubble.innerText()).includes("<img src=x"), "shown as typed text");
    assert.equal(await userBubble.locator("img, script").count(), 0);
    assert.equal(dialog, false);
  });

  // ── UX16: Connect entry from the conversation ───────────────────────────────
  await step("UX16 «أبي أسجل متجري في دينار كونكت» leads to Connect without a mutation", async () => {
    const reply = await user.say("أبي أسجل متجري في دينار كونكت", { allowFallback: true });
    perf.ux16Reply = (await reply.innerText()).replace(/\s+/g, " ").slice(0, 600);
    if (phase === "after") assert.match(perf.ux16Reply, /DINAR Connect.*\/connect.*لم يُسجَّل أي شيء في Connect بعد/u);
  });

  // ── Visual matrix ───────────────────────────────────────────────────────────
  const widths = [320, 360, 390, 430, 768, 1024, 1440, 1920];
  for (const theme of ["light", "dark", "system"]) {
    await page.emulateMedia({ colorScheme: theme === "system" ? "dark" : "light", reducedMotion: "no-preference" });
    await page.evaluate((value) => { if (value === "system") localStorage.removeItem("dinar-theme"); else localStorage.setItem("dinar-theme", value); }, theme);
    await restore(page, matrixConversation);
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid^="message-assistant-"]').length >= 4, null, { timeout: 45_000 });
    } catch (error) {
      await page.screenshot({ path: `${shots}/${phase}-matrix-restore-failure-${theme}.png`, fullPage: true });
      throw error;
    }
    perf[`matrixCards_${theme}`] = await page.locator('[data-testid^="card-ai-result-"]').count();
    for (const width of widths) {
      await step(`VISUAL ${theme} ${width}px`, async () => {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const layout = await page.evaluate(() => {
          const root = document.documentElement;
          const offenders = [...document.querySelectorAll("main *")]
            .filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.right > root.clientWidth + 1 && !node.closest('[data-testid^="ai-results-carousel-"],[role="region"],.overflow-x-auto'); })
            .slice(0, 3)
            .map((node) => node.getAttribute("data-testid") || node.tagName);
          return { overflow: root.scrollWidth - root.clientWidth, dir: getComputedStyle(document.body).direction || document.documentElement.dir, dark: root.classList.contains("dark"), offenders };
        });
        matrix.push({ theme, width, ...layout });
        assert.ok(layout.overflow <= 1, `horizontal overflow ${layout.overflow}px ${layout.offenders.join(",")}`);
        assert.equal(layout.dark, theme !== "light", "theme applied");
        await page.screenshot({ path: `${shots}/${phase}-${theme}-${width}.png`, fullPage: false });
      });
    }
  }

  // ── Reduced motion and a short viewport (mobile keyboard open) ─────────────────
  await step("REDUCED MOTION: no running CSS animation longer than 10 ms", async () => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.evaluate(() => localStorage.setItem("dinar-theme", "light"));
    await restore(page, matrixConversation);
    await page.setViewportSize({ width: 390, height: 844 });
    await user.say(`ابي جوال ${run}`);
    const long = await page.evaluate(() =>
      document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming?.();
        return animation.playState === "running" && timing && Number(timing.duration) > 10;
      }).length,
    );
    assert.equal(long, 0, `${long} animations still run under reduced motion`);
    await page.screenshot({ path: `${shots}/${phase}-reduced-motion-390.png` });
  });
  await step("KEYBOARD OPEN (390×420): composer visible and inside the viewport", async () => {
    await page.setViewportSize({ width: 390, height: 420 });
    await page.getByTestId("input-ai-composer").focus();
    const box = await page.getByTestId("input-ai-composer").boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 420 + 1, JSON.stringify(box));
    await page.screenshot({ path: `${shots}/${phase}-keyboard-open-390.png` });
  });
  perf.clsTotal = await page.evaluate(() => Number(window.__pux.cls.toFixed(4)));
} catch (error) {
  failures.push(`fatal: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  writeFileSync(resultPath, JSON.stringify({
    phase, checks, failures, perf, matrix,
    pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors,
    externalRequests: recorder.externalRequests, modelFallbacks: recorder.modelFallbacks, steps: recorder.steps,
  }, null, 2));
  await browser?.close().catch(() => undefined);
}
