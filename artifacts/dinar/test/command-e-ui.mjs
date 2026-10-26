// DINAR NEXT Command E browser evidence. Driven by api-server/test/command-e-ui.test.ts.
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const webBase = process.env.E_WEB_BASE;
const apiOrigin = process.env.E_API_ORIGIN;
const cookies = JSON.parse(process.env.E_COOKIES ?? "{}");
const users = JSON.parse(process.env.E_USERS ?? "{}");
const conversations = JSON.parse(process.env.E_CONVERSATIONS ?? "{}");
const out = process.env.E_OUT;
const resultPath = process.env.E_RESULT;
const widths = (process.env.E_WIDTHS ?? "320,375,390,430,768,1024,1440,1600").split(",").map(Number);
if (!webBase || !apiOrigin || !out || !resultPath) throw new Error("Missing Command E browser configuration.");

const report = { runs: [], perf: {}, journeys: {}, summary: {} };
const failures = [];

async function contextFor(browser, width, theme, actor) {
  const mobile = width < 768;
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width, height: mobile ? 800 : 900 },
    isMobile: mobile,
    hasTouch: width < 1024,
    locale: "ar",
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const cookie = cookies[actor];
  const separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = { ...route.request().headers(), origin: apiOrigin, referer: `${apiOrigin}/` };
    try {
      await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
    } catch {
      await route.abort();
    }
  });
  return context;
}

/** Layout, naming and target-size facts of the page as rendered. */
function measure() {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const describe = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}` : ""}`;
  const hidden = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) return true;
    }
    return false;
  };
  const clippedByScroller = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        const rect = node.getBoundingClientRect();
        if (rect.right <= vw + 1 && rect.left >= -1) return true;
      }
    }
    return false;
  };
  const overflowing = [];
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if ((rect.right > vw + 1 || rect.left < -1) && !hidden(el) && !clippedByScroller(el))
      overflowing.push(`${describe(el)} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
  }
  const controls = [...document.querySelectorAll("button, a[href], [role=button], input:not([type=hidden]), textarea, select")].filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !hidden(el) && rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  });
  const nameOf = (el) =>
    (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") ||
      (el.getAttribute("aria-labelledby") ? document.getElementById(el.getAttribute("aria-labelledby"))?.textContent : "") ||
      el.textContent || el.querySelector("img[alt]")?.getAttribute("alt") || (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : "") || "").trim();
  const unnamed = controls.filter((el) => !nameOf(el)).map(describe);
  const inlineLink = (el) => el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("p, li");
  const small = controls
    // A visually hidden skip link (.sr-only until focused) is not a tap target.
    .filter((el) => !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !inlineLink(el) && !(el.classList.contains("sr-only") && document.activeElement !== el))
    .filter((el) => { const rect = el.getBoundingClientRect(); return rect.width < 40 || rect.height < 40; })
    .map((el) => { const rect = el.getBoundingClientRect(); return `${describe(el)} ${Math.round(rect.width)}x${Math.round(rect.height)}`; });
  const composer = document.querySelector('[data-testid="input-ai-composer"]');
  const crect = composer?.getBoundingClientRect();
  return {
    dir: document.documentElement.dir || getComputedStyle(document.body).direction,
    scrollOverflow: document.documentElement.scrollWidth - vw,
    overflowing: [...new Set(overflowing)].slice(0, 12),
    unnamed: [...new Set(unnamed)].slice(0, 12),
    small: [...new Set(small)].slice(0, 20),
    composerVisible: Boolean(crect && crect.bottom <= vh + 1 && crect.top >= 0 && crect.height > 0),
    dark: document.documentElement.classList.contains("dark"),
  };
}

async function openConversation(page, actor, conversationId) {
  await page.addInitScript(([key, id]) => { try { localStorage.setItem(key, id); } catch {} }, [`dinar-conversation:${users[actor]}:JO`, conversationId ?? ""]);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="input-ai-composer"]', { timeout: 30000 });
  if (conversationId) await page.waitForSelector('[data-testid^="message-assistant-"]', { timeout: 30000 });
  await page.waitForTimeout(400);
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const only = process.env.E_SCENARIOS?.split(",");
const scenarios = [["empty", "buyer", null], ...Object.entries(conversations).map(([name, item]) => [name, item.actor, item.id])]
  .filter(([name]) => !only || only.includes(name));
try {
  for (const theme of (process.env.E_THEMES ?? "light,dark").split(",")) {
    for (const width of widths) {
      for (const [name, actor, id] of scenarios) {
        // Dark mode at every width for the core screens; the full set in light.
        if (theme === "dark" && ![320, 390, 768, 1440].includes(width)) continue;
        const context = await contextFor(browser, width, theme, actor);
        const page = await context.newPage();
        const errors = [];
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 200)); });
        page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
        try {
          await openConversation(page, actor, id);
          const metrics = await page.evaluate(measure);
          // Optional diagnostic: E_PROBE is a function body evaluated in the page.
          if (process.env.E_PROBE) metrics.probe = await page.evaluate(new Function(process.env.E_PROBE)).catch((error) => String(error));
          const shot = `${name}-${width}-${theme}.png`;
          await page.screenshot({ path: `${out}/shots/${shot}` });
          report.runs.push({ name, width, theme, ...metrics, errors, shot });
        } catch (error) {
          failures.push(`${name}@${width}/${theme}: ${String(error).slice(0, 200)}`);
        }
        await context.close();
      }
    }
  }

  // Journeys that need interaction.
  for (const width of [390, 1440]) {
    const context = await contextFor(browser, width, "light", "buyer");
    const page = await context.newPage();
    try {
      await openConversation(page, "buyer", conversations.long.id);
      if (width < 1024) {
        // On phones the history opens from the header menu; the rail button is desktop-only.
        await page.click('[data-testid="button-toggle-conversation-history"]');
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${out}/shots/sidebar-drawer-${width}.png` });
        const drawer = await page.evaluate(measure);
        report.journeys[`sidebarDrawer${width}`] = { overflowing: drawer.overflowing, unnamed: drawer.unnamed };
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        report.journeys[`drawerClosesOnEscape${width}`] = !(await page.locator('[data-testid="button-close-conversation-drawer"]').isVisible().catch(() => false));
      } else {
        await page.screenshot({ path: `${out}/shots/sidebar-desktop-${width}.png` });
      }
      // Scroll away from the latest message, then come back.
      const scroller = page.locator('[data-testid="conversation-thread"]');
      // A real wheel gesture: programmatic scrollTop changes deliberately do not unpin the thread.
      const box = await scroller.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < 6; step += 1) { await page.mouse.wheel(0, -1500); await page.waitForTimeout(80); }
      await page.waitForTimeout(500);
      const returnButton = page.locator('[data-testid="button-return-to-latest"]');
      const returnVisible = await returnButton.isVisible().catch(() => false);
      if (returnVisible) await returnButton.click();
      await page.waitForTimeout(600);
      const lastVisible = await page.locator('[data-testid^="message-assistant-"]').last().isVisible();
      report.journeys[`scrollToLatest${width}`] = { returnVisible, lastVisible };
      // Keyboard navigation reaches the composer and shows focus.
      await page.locator('[data-testid="input-ai-composer"]').focus();
      report.journeys[`composerFocusable${width}`] = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "input-ai-composer");
    } catch (error) {
      failures.push(`journey@${width}: ${String(error).slice(0, 200)}`);
    }
    await context.close();
  }

  // Load cost of the chat at 390px (cold cache).
  {
    const context = await contextFor(browser, 390, "light", "buyer");
    const page = await context.newPage();
    const started = Date.now();
    await openConversation(page, "buyer", conversations.general.id);
    report.perf = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource");
      const js = resources.filter((entry) => entry.name.endsWith(".js"));
      const css = resources.filter((entry) => entry.name.endsWith(".css"));
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        jsFiles: js.length,
        jsTransferKB: Math.round(js.reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0) / 1024),
        cssTransferKB: Math.round(css.reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0) / 1024),
        domContentLoadedMs: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      };
    });
    report.perf.firstAnswerVisibleMs = Date.now() - started;
    await context.close();
  }
} finally {
  await browser.close();
}

const touch = (run) => run.width < 1024;
report.summary = {
  runs: report.runs.length,
  rtl: [...new Set(report.runs.map((run) => run.dir))],
  overflow: report.runs.filter((run) => run.scrollOverflow > 1 || run.overflowing.length).map((run) => `${run.name}@${run.width}/${run.theme}: +${run.scrollOverflow}px ${run.overflowing.slice(0, 3).join(" | ")}`),
  unnamedControls: [...new Set(report.runs.flatMap((run) => run.unnamed.map((item) => `${run.name}@${run.width}: ${item}`)))].slice(0, 40),
  smallTapTargets: [...new Set(report.runs.filter(touch).flatMap((run) => run.small.map((item) => `${run.width}: ${item}`)))].slice(0, 60),
  composerHidden: report.runs.filter((run) => !run.composerVisible).map((run) => `${run.name}@${run.width}/${run.theme}`),
  consoleErrors: [...new Set(report.runs.flatMap((run) => run.errors))].slice(0, 20),
  darkApplied: report.runs.filter((run) => run.theme === "dark").every((run) => run.dark),
  journeys: report.journeys,
  perf: report.perf,
  failures,
};
await writeFile(resultPath, JSON.stringify(report, null, 2));
