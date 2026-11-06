// DINAR experience upgrade — browser acceptance, driven by
// api-server/test/experience-upgrade-acceptance.test.ts. The production build, signed in,
// against the real API on a disposable database; the model is the suite's scripted gateway.
// Every step is a real click or keystroke; every check is measured in the rendered page.
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const webBase = process.env.XP_WEB_BASE;
const apiOrigin = process.env.XP_API_ORIGIN;
const cookies = JSON.parse(process.env.XP_COOKIES ?? "{}");
const users = JSON.parse(process.env.XP_USERS ?? "{}");
const auth = JSON.parse(process.env.XP_AUTH ?? "{}");
const out = process.env.XP_OUT;
const resultPath = process.env.XP_RESULT;
if (!webBase || !apiOrigin || !out || !resultPath) throw new Error("Missing experience-upgrade browser configuration.");

const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440, 1600];
const report = { journeys: {}, layout: [], summary: {} };
const failed = [];
const failures = [];
const consoleErrors = [];

async function open(browser, actor, { width = 390, height, scheme = "light", motion = "reduce", conversationId } = {}) {
  const mobile = width < 768;
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width, height: height ?? (mobile ? 760 : 900) },
    isMobile: mobile,
    hasTouch: mobile,
    locale: "ar",
    reducedMotion: motion,
    colorScheme: scheme,
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
      // The page or context may already be gone (and the route with it).
      await route.abort().catch(() => {});
    }
  });
  // Runs before the first navigation only: a reload keeps whatever the app stored.
  await context.addInitScript(([key, id]) => {
    try {
      if (sessionStorage.getItem("xp-initialised")) return;
      sessionStorage.setItem("xp-initialised", "1");
      localStorage.setItem("bdinar-onboarded", "1");
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    } catch {}
  }, [`dinar-conversation:${users[actor]}:JO`, conversationId ?? ""]);
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${actor}@${width}: ${message.text().slice(0, 200)}`); });
  page.on("pageerror", (error) => consoleErrors.push(`${actor}@${width}: ${String(error).slice(0, 200)}`));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ready(page);
  return { context, page };
}
/** Per-page holds on /api/auth/me, applied inside the one proxy route (stacked routes race). */
const identityGates = new WeakMap();
const identityFailures = new WeakSet();
/** `clientIp` gives a guest journey its own guest-preview allowance (20 per 15 minutes per IP). */
async function openRegisteredUserJourney(browser, { clientIp } = {}) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 390, height: 820 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
    reducedMotion: "reduce",
  });
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      let page;
      try { page = route.request().frame().page(); } catch {}
      const gate = page && identityGates.get(page);
      if (gate) await gate;
      if (page && identityFailures.has(page)) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary local identity fault fixture" }) });
        return;
      }
    }
    const headers = { ...route.request().headers(), origin: apiOrigin, referer: `${apiOrigin}/`, ...(clientIp ? { "x-forwarded-for": clientIp } : {}) };
    try {
      await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
    } catch {
      // The page or context may already be gone (and the route with it).
      await route.abort().catch(() => {});
    }
  });
  await context.addInitScript(() => {
    try {
      if (sessionStorage.getItem("qa-registered-users-initialized")) return;
      sessionStorage.setItem("qa-registered-users-initialized", "1");
      localStorage.setItem("bdinar-onboarded", "1");
      for (const key of Object.keys(localStorage))
        if (key.startsWith("dinar-conversation:")) localStorage.removeItem(key);
    } catch {}
  });
  const page = await context.newPage();
  const expectedHttpRejections = [];
  const apiRejectionCounts = new Map();
  page.on("response", (response) => {
    const status = response.status();
    const path = new URL(response.url()).pathname;
    const injectedIdentityFailure = status === 503 && path === "/api/auth/me" && identityFailures.has(page);
    if (((status === 404 || status === 409) && path.startsWith("/api/")) || injectedIdentityFailure) {
      expectedHttpRejections.push({ status, path });
      apiRejectionCounts.set(status, (apiRejectionCounts.get(status) ?? 0) + 1);
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Chromium reports fetch()'s expected authorization rejections as console errors.
    // The test asserts the actual 404/409 responses; 503 is accepted only for the explicit local identity fault above.
    const match = message.text().match(/Failed to load resource: the server responded with a status of (404|409|503)/u);
    if (match) {
      const status = Number(match[1]);
      const count = apiRejectionCounts.get(status) ?? 0;
      if (count > 0) {
        apiRejectionCounts.set(status, count - 1);
        return;
      }
    }
    consoleErrors.push(`registered-users: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`registered-users: ${String(error).slice(0, 200)}`));
  return { context, page, expectedHttpRejections };
}
/** Every guest-handoff call a page makes, with the identity it claimed and what the server said. */
function trackHandoffs(page) {
  const calls = [];
  page.on("response", async (response) => {
    if (!new URL(response.url()).pathname.endsWith("/ai/conversations/guest-handoff")) return;
    let body = {};
    try { body = JSON.parse(response.request().postData() ?? "{}"); } catch {}
    const entry = { status: response.status(), userId: body.userId, handoffId: body.handoffId, messages: body.messages?.length ?? 0 };
    calls.push(entry);
    try { entry.error = (await response.json()).error; } catch {}
  });
  return calls;
}
async function loginInBrowser(page, actor) {
  try {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
  } catch (error) {
    // Right after logout the app may still be navigating on its own, which aborts this goto.
    if (!String(error).includes("ERR_ABORTED")) throw error;
    await page.waitForLoadState("domcontentloaded");
    await page.goto("/login", { waitUntil: "domcontentloaded" });
  }
  const phoneInput = page.locator('input[name="phoneNumber"]');
  try {
    await phoneInput.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(`login form missing for ${actor}; url=${page.url()}; body=${(await page.locator("body").innerText()).slice(0, 500)}`);
  }
  await phoneInput.fill(auth[actor].phoneNumber);
  await page.locator('input[name="password"]').fill(auth[actor].password);
  await page.getByTestId("button-auth-submit").click();
  await ready(page);
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return { status: response.status, body: await response.json().catch(() => ({})) };
  });
  check(me.status === 200 && (me.body.user ?? me.body).id === users[actor], `${actor} authenticated through the login form`, JSON.stringify(me.body));
}
// Logout replaces the document. Probe its real shared cookie jar outside that document,
// so navigation cannot destroy a pending evaluate or turn an expected 401 into a console error.
async function expectSignedOut(page) {
  await expect.poll(async () => {
    const request = page.context().request;
    const identity = await request.get(`${apiOrigin}/api/auth/me`, { timeout: 5_000 });
    const body = await identity.json();
    const protectedRead = await request.get(`${apiOrigin}/api/ai/conversations`, { timeout: 5_000 });
    return { identityStatus: identity.status(), user: body.user, protectedStatus: protectedRead.status() };
  }, { timeout: 15_000 }).toEqual({ identityStatus: 200, user: null, protectedStatus: 401 });
}
async function ready(page) {
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
const assistants = (page) => page.locator('[data-testid^="message-assistant-"]');
async function settle(page, before) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(250);
  const latest = assistants(page).last();
  return { locator: latest, text: (await latest.innerText()).replace(/\s+/g, " ") };
}
async function send(page, text) {
  const startedAt = Date.now();
  const before = await assistants(page).count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.waitForSelector('[data-testid="button-send-ai-message"]:not([disabled])', { timeout: 10_000 });
  await page.getByTestId("button-send-ai-message").click();
  return { ...(await settle(page, before)), turnSettledMs: Date.now() - startedAt };
}
async function startFirstCardTimer(page) {
  await page.evaluate(() => {
    const start = performance.now();
    window.__dinarFirstCardMs = null;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.ai-thread [data-testid^="card-ai-result-"]')) {
        window.__dinarFirstCardMs = performance.now() - start;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
async function readFirstCardTimer(page) {
  return page.evaluate(() => window.__dinarFirstCardMs);
}
async function click(page, locator) {
  const before = await assistants(page).count();
  await locator.click();
  return settle(page, before);
}
const check = (condition, label, detail = "") => {
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ""}`);
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shot = (page, name) => page.screenshot({ path: `${out}/shots/${name}.png` });
async function journey(name, run) {
  const started = Date.now();
  try {
    const details = await run();
    report.journeys[name] = { status: "PASS", ms: Date.now() - started, ...(details ?? {}) };
  } catch (error) {
    failed.push(name);
    failures.push({ name, error: String(error?.stack ?? error).slice(0, 1200) });
    report.journeys[name] = { status: "FAIL", error: String(error?.message ?? error).slice(0, 600) };
  }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
try {
  // ── 1. Layout matrix: header, starters, composer, sidebar at 11 widths × light/dark.
  await journey("layout-matrix", async () => {
    for (const scheme of ["light", "dark"]) {
      for (const width of WIDTHS) {
        const { context, page } = await open(browser, "layout", { width, scheme });
        try {
          const label = `${width}-${scheme}`;
          const m = await page.evaluate(() => {
            const box = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
            const visible = (el) => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
            const header = document.querySelector('[data-testid="ai-topbar"]');
            const trigger = document.querySelector(".ai-mobile-sidebar-trigger");
            const newChat = [...document.querySelectorAll('[data-testid="button-new-conversation-mobile"], [data-testid="button-new-conversation"]')].filter(visible);
            const starters = [...document.querySelectorAll(".ai-starter")];
            const group = document.querySelector(".ai-starters");
            const composer = document.querySelector(".ai-composer-box");
            const textarea = document.querySelector('[data-testid="input-ai-composer"]');
            const sidebar = document.querySelector("#ai-conversation-history");
            const bg = getComputedStyle(document.querySelector(".dinar-chatgpt")).backgroundColor;
            return {
              dir: document.querySelector(".dinar-chatgpt")?.getAttribute("dir") ?? getComputedStyle(document.querySelector(".dinar-chatgpt")).direction,
              headerVisible: visible(header),
              header: box(header),
              headerButtons: header ? [...header.querySelectorAll("button")].filter(visible).map((b) => ({ id: b.dataset.testid, name: b.getAttribute("aria-label") ?? b.textContent.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })) : [],
              triggerVisible: visible(trigger),
              trigger: box(trigger),
              triggerName: trigger?.getAttribute("aria-label") ?? "",
              triggerId: trigger?.dataset.testid ?? null,
              newChatVisible: newChat.length,
              starters: starters.map((s) => ({ ...box(s), text: s.textContent.trim() })),
              group: box(group),
              groupScroll: group ? { scroll: group.scrollWidth, client: group.clientWidth, overflowX: getComputedStyle(group).overflowX } : null,
              composer: box(composer),
              composerTextWidth: box(textarea)?.width ?? 0,
              fontSize: parseFloat(getComputedStyle(textarea).fontSize),
              sidebarVisible: visible(sidebar) && sidebar.getBoundingClientRect().width > 0,
              sidebar: box(sidebar),
              heading: Boolean([...document.querySelectorAll("h1")].find((h) => h.textContent.includes("كيف أساعدك اليوم"))),
              bg,
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
            };
          });
          const result = { label, overflow: await overflow(page), ...m };
          report.layout.push({ label, overflow: result.overflow, header: m.header?.height ?? 0, starters: m.starters.length, groupHeight: Math.round(m.group?.height ?? 0), composerBottom: Math.round(m.composer?.bottom ?? 0), font: m.fontSize, sidebar: m.sidebarVisible });
          check(result.overflow <= 0, `${label}: no horizontal page overflow`, String(result.overflow));
          check(m.heading, `${label}: greeting visible`);
          check(m.starters.length === 6, `${label}: six compact starters`, String(m.starters.length));
          for (const starter of m.starters)
            check(starter.height >= 36 && starter.height <= 44, `${label}: starter «${starter.text}» is compact and touchable`, String(starter.height));
          if (width < 768) {
            // Phones: one swipeable row; every starter can be brought fully into view.
            check(m.group.height <= 48, `${label}: starters use a single row`, String(m.group.height));
            check(m.groupScroll.overflowX === "auto", `${label}: starter row scrolls inside itself`);
            for (const text of m.starters.map((starter) => starter.text)) {
              const reach = await page.getByTestId(`button-prompt-${text}`).evaluate((el) => { el.scrollIntoView({ inline: "nearest", block: "nearest" }); const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
              check(reach, `${label}: starter «${text}» reachable by swiping`);
            }
            await page.locator(".ai-starters").evaluate((el) => (el.scrollLeft = 0));
          } else {
            for (const starter of m.starters)
              check(starter.left >= 0 && starter.right <= m.innerWidth, `${label}: starter «${starter.text}» fits the viewport`);
            check(m.group.height <= 100, `${label}: starters take little vertical space`, String(m.group.height));
          }
          check(m.composer && m.composer.bottom <= m.innerHeight && m.composer.left >= 0 && m.composer.right <= m.innerWidth, `${label}: composer fully on screen`, JSON.stringify(m.composer));
          if (width <= 360)
            check(m.composerTextWidth >= 160, `${label}: composer keeps a usable text area`, `${m.composerTextWidth}px`);
          check(m.group.bottom <= m.composer.top, `${label}: starters sit above the composer`);
          const luminance = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
          check(scheme === "dark" ? luminance(m.bg) < 0.25 : luminance(m.bg) > 0.75, `${label}: ${scheme} palette applied`, m.bg);
          // Approved design (4ed2b01): no phone top bar; one floating sidebar control at the
          // inline start (right in RTL) opens the drawer, which holds New Chat and history.
          check(!m.headerVisible, `${label}: no top bar`);
          if (width < 1024) {
            check(m.triggerVisible && m.triggerId === "button-toggle-conversation-history", `${label}: floating sidebar control`);
            check(m.trigger.width >= 44 && m.trigger.height >= 44, `${label}: 44px sidebar control`, JSON.stringify(m.trigger));
            check(Boolean(m.triggerName), `${label}: sidebar control is named`);
            check(m.trigger.right >= m.innerWidth - 24 && m.trigger.top >= 0, `${label}: sidebar control at the RTL start edge`, JSON.stringify(m.trigger));
            check(m.trigger.bottom <= m.group.top, `${label}: sidebar control never covers the starters`);
            check(m.newChatVisible === 0, `${label}: no New Chat on the empty screen`);
            check(m.fontSize >= 16, `${label}: composer ≥ 16px (no zoom on focus)`, String(m.fontSize));
            check(!m.sidebarVisible, `${label}: sidebar is a drawer, not a column`);
          } else {
            check(!m.triggerVisible, `${label}: no floating sidebar control on desktop`);
            check(m.sidebarVisible && m.sidebar.width >= 240 && m.sidebar.width <= 300, `${label}: stable desktop sidebar`, JSON.stringify(m.sidebar));
          }
          await shot(page, `layout-${label}`);
        } finally {
          await context.close();
        }
      }
    }
    return { cases: report.layout.length };
  });

  // ── 2. A starter never locks the chat; formatted answers render safely; the draft resumes.
  let flowConversation;
  await journey("starter-free-topic-resume-390", async () => {
    const { context, page } = await open(browser, "main", { width: 390 });
    try {
      const sidebarControl = page.getByTestId("button-toggle-conversation-history");
      const sell = await click(page, page.getByTestId("button-prompt-أريد أن أبيع شيئًا"));
      check(/تصنيف|صف المنتج/u.test(sell.text), "seller draft started", sell.text.slice(0, 160));
      // New Chat lives in the drawer (drawer-390); the drawer control stays reachable mid-chat.
      check(await sidebarControl.isVisible(), "sidebar control stays available once the chat has messages");
      check((await page.locator(".ai-starter").count()) === 0, "starter cards are gone after the conversation begins");
      const answer = await send(page, "اشرح لي React hooks");
      check(/React Hooks/u.test(answer.text), "programming answer in the same conversation", answer.text.slice(0, 160));
      const code = answer.locator.getByTestId("message-code-block");
      check(await code.isVisible(), "fenced code renders as a code block");
      const rendering = await answer.locator.evaluate((node) => {
        const pre = node.querySelector(".ai-code-block pre");
        const table = node.querySelector(".ai-rich-table");
        const lead = node.querySelector(".ai-rich-text > p");
        return {
          codeDirection: getComputedStyle(pre).direction,
          codeAlign: getComputedStyle(pre).textAlign,
          tableScrolls: table.scrollWidth > table.clientWidth,
          tableInside: table.getBoundingClientRect().right <= window.innerWidth && table.getBoundingClientRect().left >= 0,
          leadDir: lead?.getAttribute("dir"),
          htmlInjected: node.querySelectorAll("script, iframe, img[onerror]").length,
          chip: node.querySelector('.ai-message-actions [data-testid="advice"]')?.textContent ?? null,
          copy: Boolean(node.querySelector('[data-testid="button-copy-message"]')),
        };
      });
      check(rendering.codeDirection === "ltr" && rendering.codeAlign === "left", "code stays LTR inside the RTL thread", JSON.stringify(rendering));
      check(rendering.tableScrolls && rendering.tableInside, "a wide table scrolls inside its own container", JSON.stringify(rendering));
      check(rendering.leadDir === "rtl", "an Arabic paragraph that starts with an English term stays RTL", String(rendering.leadDir));
      check(rendering.htmlInjected === 0, "no executable markup");
      check(rendering.copy && /معلومة عامة/u.test(rendering.chip ?? ""), "copy action and provenance sit together", JSON.stringify(rendering));
      check((await overflow(page)) <= 0, "no page overflow with code and table at 390");
      await shot(page, "flow-answer-390");
      const resumed = await send(page, "نرجع للإعلان السابق");
      check(/رجعنا إلى مسودة/u.test(resumed.text), "the unfinished draft resumes", resumed.text.slice(0, 160));
      flowConversation = await page.evaluate((key) => localStorage.getItem(key), `dinar-conversation:${users.main}:JO`);
      await page.reload();
      await ready(page);
      await page.locator('[data-testid^="message-user-"]').nth(2).waitFor({ timeout: 20_000 });
      check((await page.locator('[data-testid^="message-user-"]').count()) === 3, "reload restores every turn once");
      check(await page.getByTestId("message-code-block").isVisible(), "formatted answer is rebuilt after reload");
      await shot(page, "flow-reloaded-390");
    } finally {
      await context.close();
    }
  });

  // ── 3. Drawer: scroll lock, Escape and overlay dismissal, focus return, selection, New Chat.
  await journey("drawer-390", async () => {
    const { context, page } = await open(browser, "main", { width: 390, conversationId: flowConversation });
    try {
      const toggle = page.getByTestId("button-toggle-conversation-history");
      await toggle.click();
      const drawer = page.getByRole("dialog", { name: "سجل المحادثات" });
      await drawer.waitFor();
      check(await page.evaluate(() => document.body.hasAttribute("data-scroll-locked")), "background scroll is locked");
      const geometry = await drawer.evaluate((el) => { const r = el.getBoundingClientRect(); return { right: r.right, left: r.left, width: r.width, vw: window.innerWidth }; });
      check(Math.abs(geometry.right - geometry.vw) <= 1 && geometry.width <= geometry.vw * 0.9, "RTL drawer opens from the right and leaves an overlay edge", JSON.stringify(geometry));
      check(await drawer.getByTestId("button-new-conversation").isVisible(), "New Chat lives in the drawer");
      await shot(page, "drawer-390");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "button-toggle-conversation-history");
      await toggle.click();
      await drawer.waitFor();
      await page.mouse.click(12, 400);
      await drawer.waitFor({ state: "hidden" });
      check(!(await page.evaluate(() => document.body.hasAttribute("data-scroll-locked"))), "overlay tap closes and unlocks scrolling");
      await toggle.click();
      await drawer.getByTestId("button-new-conversation").click();
      await drawer.waitFor({ state: "hidden" });
      await page.getByRole("heading", { name: "كيف أساعدك اليوم؟" }).waitFor();
      await toggle.click();
      const item = drawer.getByTestId(`conversation-${flowConversation}`);
      check((await item.innerText()).includes("عرض منتج للبيع"), "conversation title in history", await item.innerText());
      await item.click();
      await drawer.waitFor({ state: "hidden" });
      await page.getByTestId("message-code-block").waitFor();
      check(await page.locator(`#conversation-history-list`).count() === 0, "drawer closes after selecting a conversation");
    } finally {
      await context.close();
    }
  });

  // ── 4. Compose-type starters only fill the composer; nothing is sent.
  await journey("compose-starter", async () => {
    const { context, page } = await open(browser, "main", { width: 375 });
    try {
      let turns = 0;
      page.on("request", (requestEvent) => { if (/\/ai\/conversations\/[^/]+\/turns$|\/ai\/conversations$/u.test(requestEvent.url()) && requestEvent.method() === "POST") turns += 1; });
      await page.getByTestId("button-prompt-ساعدني في البرمجة").click();
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "input-ai-composer", undefined, { timeout: 3_000 }).catch(() => {});
      const state = await page.evaluate(() => ({ value: document.querySelector('[data-testid="input-ai-composer"]').value, focused: document.activeElement?.getAttribute("data-testid") }));
      check(state.value === "ساعدني في البرمجة: " && state.focused === "input-ai-composer", "prefill placed in a focused composer", JSON.stringify(state));
      await page.waitForTimeout(400);
      check(turns === 0 && (await page.locator('[data-testid^="message-user-"]').count()) === 0, "nothing was sent");
    } finally {
      await context.close();
    }
  });

  // ── 5. Desktop sidebar: rename, delete with confirmation, shortcut, collapse/expand.
  await journey("desktop-sidebar-1280", async () => {
    const { context, page } = await open(browser, "main", { width: 1280, conversationId: flowConversation });
    try {
      await page.getByTestId("message-code-block").waitFor();
      const item = page.locator(`#conversation-history-list [data-testid="conversation-${flowConversation}"]`);
      check(await item.getAttribute("aria-current") === "page", "active conversation is marked");
      await item.hover();
      await page.getByTestId(`button-conversation-menu-${flowConversation}`).click();
      await page.getByTestId(`menuitem-rename-conversation-${flowConversation}`).click();
      const field = page.getByTestId(`input-rename-conversation-${flowConversation}`);
      await field.waitFor();
      await field.fill("دروس React");
      await field.press("Enter");
      await page.waitForFunction((id) => document.querySelector(`[data-testid="conversation-${id}"]`)?.textContent?.includes("دروس React"), flowConversation);
      await page.reload();
      await ready(page);
      await page.waitForFunction((id) => document.querySelector(`[data-testid="conversation-${id}"]`)?.textContent?.includes("دروس React"), flowConversation, { timeout: 20_000 });
      // A throwaway conversation, deleted only after the confirmation dialog.
      await page.keyboard.press("Control+Shift+O");
      await page.getByRole("heading", { name: "كيف أساعدك اليوم؟" }).waitFor();
      await send(page, "مرحبا");
      const throwaway = await page.evaluate((key) => localStorage.getItem(key), `dinar-conversation:${users.main}:JO`);
      check(throwaway && throwaway !== flowConversation, "keyboard shortcut started a new conversation");
      await page.locator(`[data-testid="conversation-${throwaway}"]`).hover();
      await page.getByTestId(`button-conversation-menu-${throwaway}`).click();
      await page.getByTestId(`button-delete-conversation-${throwaway}`).click();
      const confirm = page.getByTestId("dialog-confirm");
      await confirm.waitFor();
      check(await page.locator(`[data-testid="conversation-${throwaway}"]`).isVisible(), "nothing is deleted before confirming");
      await shot(page, "delete-confirm-1280");
      await confirm.getByTestId("button-confirm-action").click();
      await page.locator(`[data-testid="conversation-${throwaway}"]`).waitFor({ state: "detached" });
      check(await page.locator(`[data-testid="conversation-${flowConversation}"]`).isVisible(), "other conversations stay");
      await page.getByTestId("button-collapse-conversation-sidebar").click();
      await page.getByTestId("button-expand-conversation-sidebar").waitFor();
      const widths = await page.evaluate(() => ({ thread: document.querySelector(".dinar-chat-conversation").getBoundingClientRect().width, vw: innerWidth }));
      check(widths.thread > widths.vw - 120, "collapsing gives the chat the width", JSON.stringify(widths));
      await page.getByTestId("button-expand-conversation-sidebar").click();
      await page.locator("#ai-conversation-history").waitFor();
      await shot(page, "desktop-sidebar-1280");
    } finally {
      await context.close();
    }
  });

  // ── 6. Business and account surfaces from the conversation (dark, phone).
  await journey("business-surfaces-390-dark", async () => {
    const { context, page } = await open(browser, "seller", { width: 390, scheme: "dark" });
    try {
      const usage = await send(page, "كم بقي من حصتي؟");
      await usage.locator.getByTestId("usage-meter").first().waitFor();
      const plans = await send(page, "دينار اعرض الباقات");
      await plans.locator.getByTestId("ai-plans").waitFor();
      check(/السعر غير معتمد بعد/u.test(plans.text), "no invented plan price");
      const sales = await send(page, "دينار أعطني إحصائيات مبيعاتي");
      await sales.locator.getByTestId("sales-summary").waitFor();
      check((await sales.locator.getByTestId("sales-metric-orders").innerText()).includes("1"), "sales metrics from the real order");
      check((await overflow(page)) <= 0, "business cards fit at 390");
      await shot(page, "business-390-dark");
    } finally {
      await context.close();
    }
  });

  // ── 7. Accessibility and motion: names, targets, reduced motion, short screens.
  await journey("accessibility-motion", async () => {
    for (const motion of ["reduce", "no-preference"]) {
      const { context, page } = await open(browser, "layout", { width: 390, motion });
      try {
        const animation = await page.evaluate(() => {
          // The thinking indicator is the animated DINAR mark (f9888c0), not dots.
          const probe = document.createElement("span");
          probe.className = "ai-typing";
          probe.innerHTML = '<span class="ai-typing-avatar"><svg class="ai-typing-mark"></svg></span>';
          document.querySelector(".dinar-chatgpt").append(probe);
          const name = getComputedStyle(probe.querySelector(".ai-typing-mark")).animationName;
          probe.remove();
          return name;
        });
        check(motion === "reduce" ? animation === "none" : animation !== "none", `typing animation honours ${motion}`, animation);
        if (motion === "reduce") {
          const unnamed = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length && !(b.getAttribute("aria-label") || b.textContent.trim() || b.getAttribute("title"))).map((b) => b.outerHTML.slice(0, 120)));
          check(unnamed.length === 0, "every visible button has an accessible name", unnamed.join(" | "));
          const small = await page.evaluate(() => [...document.querySelectorAll('.ai-mobile-sidebar-trigger, .ai-composer-box button')].filter((b) => b.getClientRects().length).map((b) => b.getBoundingClientRect()).filter((r) => r.width < 40 || r.height < 40).length);
          check(small === 0, "sidebar and composer controls are ≥ 40px");
        }
      } finally {
        await context.close();
      }
    }
    const { context, page } = await open(browser, "layout", { width: 390, height: 520 });
    try {
      const short = await page.evaluate(() => ({
        logo: getComputedStyle(document.querySelector(".ai-welcome-logo")).display,
        composerBottom: document.querySelector(".ai-composer-box").getBoundingClientRect().bottom,
        h: innerHeight,
      }));
      check(short.logo === "none" && short.composerBottom <= short.h, "a short screen drops decoration and keeps the composer", JSON.stringify(short));
      await shot(page, "short-390x520");
    } finally {
      await context.close();
    }
  });

  // ── Registered-user acceptance: real login/logout, conversational market change,
  // market-bound history, and a second account in the same browser context.
  await journey("registered-market-account-isolation", async () => {
    const { context, page, expectedHttpRejections } = await openRegisteredUserJourney(browser);
    const handoffCalls = trackHandoffs(page);
    try {
      await loginInBrowser(page, "registeredA");
      const first = await send(page, "اشرح لي ما هي الطاقة الشمسية");
      check(first.text.length > 0, "User A can start a general AI conversation");
      const aConversation = await page.evaluate((key) => localStorage.getItem(key), `dinar-conversation:${users.registeredA}:JO`);
      check(Boolean(aConversation), "the first turn created User A's Jordan conversation");

      const joSearch = await send(page, `ابحث عن ألواح شمسية ${process.env.XP_TOKEN}`);
      check(joSearch.text.includes(process.env.XP_TOKEN), "Jordan search displays its matching offer", joSearch.text.slice(0, 240));
      const marketReview = await send(page, "دينار حول سوقي إلى الكويت");
      const reviewCard = marketReview.locator.getByTestId("control-market");
      await reviewCard.waitFor();
      check(/الكويت/u.test(await reviewCard.innerText()), "the conversation proposes Kuwait");
      const beforeConfirm = await assistants(page).count();
      await reviewCard.getByTestId("control-confirm").click();
      await settle(page, beforeConfirm);
      await page.locator('[data-testid="control-market"][data-status="SUCCEEDED"]').last().waitFor({ timeout: 20_000 });
      const marketAfterSwitch = await page.evaluate(async () => {
        const response = await fetch("/api/auth/me");
        const body = await response.json();
        return response.status === 200 ? (body.user ?? body).activeMarketId : null;
      });
      check(marketAfterSwitch === "KW", "the confirmed switch is authorized and persisted by the server", String(marketAfterSwitch));
      const kwKey = `dinar-conversation:${users.registeredA}:KW`;
      check(await page.evaluate((key) => localStorage.getItem(key), kwKey) === aConversation, "the original conversation remains open in its new market context");
      await page.getByTestId("button-toggle-conversation-history").click();
      const marketChip = page.getByTestId("button-market");
      await marketChip.waitFor();
      check((await marketChip.getAttribute("aria-label")).includes("الكويت"), "the browsing market indicator shows Kuwait");
      await marketChip.click();
      const kuwaitOption = page.getByTestId("button-market-KW");
      await kuwaitOption.waitFor();
      check(/KWD/u.test(await kuwaitOption.innerText()), "Kuwait is paired with KWD in the market selector");
      await page.keyboard.press("Escape");
      await page.getByTestId("sheet-market").waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "سجل المحادثات" }).waitFor({ state: "hidden" });

      const kwSearch = await send(page, `ابحث عن ألواح شمسية ${process.env.XP_TOKEN}`);
      check(kwSearch.text.includes(`${process.env.XP_TOKEN} الكويت`), "the same conversation's new search uses Kuwait inventory", kwSearch.text.slice(0, 300));
      await page.reload();
      await ready(page);
      await page.getByText(`${process.env.XP_TOKEN} الكويت`, { exact: false }).first().waitFor({ timeout: 20_000 });
      const restoredConversation = await page.evaluate((key) => localStorage.getItem(key), kwKey);
      check(restoredConversation === aConversation, "reload restores the same conversation under Kuwait", `expected=${aConversation}; actual=${restoredConversation}`);
      await page.getByTestId("button-toggle-conversation-history").click();
      check((await page.getByTestId("button-market").getAttribute("aria-label")).includes("الكويت"), "reload preserves the selected market");

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await page.getByTestId("button-settings-logout").click();
      await page.getByTestId("dialog-confirm").getByTestId("button-confirm-action").click();
      await expectSignedOut(page);

      await loginInBrowser(page, "registeredB");
      const historyDrawer = page.getByTestId("button-toggle-conversation-history");
      await historyDrawer.click();
      check(await page.getByTestId(`conversation-${aConversation}`).count() === 0, "User B cannot see User A's conversation in the rendered history");
      await page.keyboard.press("Escape");
      const privateRead = await page.evaluate(async (id) => {
        const response = await fetch(`/api/ai/conversations/${id}`);
        return response.status;
      }, aConversation);
      const privateTurn = await page.evaluate(async (id) => {
        const response = await fetch(`/api/ai/conversations/${id}/turns`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "اعرض الرسائل" }),
        });
        return response.status;
      }, aConversation);
      check(privateRead === 404 && privateTurn === 404, "User B's real API requests cannot read or write User A's Kuwait conversation", `${privateRead}/${privateTurn}`);
      const generalB = await send(page, "اشرح لي الفرق بين الشمسية والرياح");
      check(generalB.text.length > 0, "general AI remains available after switching accounts");
      // Neither account came from a guest session: no handoff may be attempted at all, so the
      // only rejections left are this journey's two deliberate cross-account probes.
      check(handoffCalls.length === 0, "no guest handoff for registered users' own conversations", JSON.stringify(handoffCalls));
      const rejections = expectedHttpRejections.filter(({ path }) => path.startsWith("/api/ai/"));
      check(rejections.length === 2 && rejections.every(({ status }) => status === 404), "only the two deliberate 404 probes were rejected", JSON.stringify(rejections));
      return {
        accountA: "login/logout/browser login",
        selectedMarket: "KW",
        currency: "KWD",
        crossAccountConversation: `${privateRead}/${privateTurn}`,
        guestHandoffCalls: handoffCalls.length,
        expectedHttpRejections: expectedHttpRejections.filter(({ path }) => path.includes("guest-handoff") || path.includes("conversations/")),
      };
    } finally {
      await context.close();
    }
  });

  // ── 10. Guest handoff races: a guest transcript moves into the account that signs in, once,
  //    whatever reloads, other tabs and account changes happen around it. Responses are delayed
  //    (the request reaches the server at once, with the cookie it was sent with, as on a slow
  //    network) so the client sees them after the page or the identity has moved on.
  // ── Guest topic memory: an early general question survives commerce, account and unrelated
  // turns plus a reload, and «ارجع لموضوع …» resumes it. Only bounded hints are uploaded.
  await journey("guest-topic-resume-390", async () => {
    const { context, page } = await openRegisteredUserJourney(browser, { clientIp: "198.18.200.7" });
    const previews = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/ai/preview")) previews.push(request.postDataJSON());
    });
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await ready(page);
      const opening = "دينار اشرح لي الطاقة الشمسية للمنازل";
      await send(page, opening);
      let search = await send(page, `ابحث عن ألواح شمسية ${process.env.XP_TOKEN}`);
      const jordan = search.locator.getByTestId("button-inline-market-JO");
      if (await jordan.count()) search = await click(page, jordan);
      for (const text of ["اعرض طلباتي", "Explain recursion briefly", "ابحث عن ثلاجة مستعملة", "كم تكلف صيانة المكيف عادة؟", "ابحث عن لابتوب"]) await send(page, text);
      const resumed = await send(page, "ارجع لموضوع الطاقة الشمسية");
      check(resumed.text.includes(opening), "the guest resumes the early topic", resumed.text.slice(0, 200));
      check((await resumed.locator.locator('[data-testid^="card-ai-result-"]').count()) === 0, "no card on a resumed topic");
      const last = previews.at(-1);
      check(last.history.length === 10 && !last.history.some((item) => item.body === opening), "history stays the last 10 messages", String(last.history.length));
      check(last.earlierUserTopics.includes(opening) && last.earlierUserTopics.length <= 6 && last.earlierUserTopics.every((topic) => topic.length <= 160), "only bounded hints carry the early topic", JSON.stringify(last.earlierUserTopics));
      check(JSON.stringify(last).length < 16_000, "the request stays small", String(JSON.stringify(last).length));
      const usersBefore = await page.locator('[data-testid^="message-user-"]').count();
      await page.reload();
      await ready(page);
      await page.locator('[data-testid^="message-user-"]').nth(usersBefore - 1).waitFor({ timeout: 20_000 });
      check((await page.locator('[data-testid^="message-user-"]').count()) === usersBefore, "reload restores each guest turn once");
      const afterReload = await send(page, "طيب نرجع للموضوع الأول");
      check(afterReload.text.includes(opening), "the topic is still resumable after a reload", afterReload.text.slice(0, 200));
      check((await overflow(page)) <= 0, "no page overflow at 390");
      await shot(page, "guest-topic-resume-390");
      return { previews: previews.length, hints: previews.at(-1).earlierUserTopics.length, requestBytes: JSON.stringify(previews.at(-1)).length };
    } finally {
      await context.close();
    }
  });

  await journey("guest-handoff-races", async () => {
    const token = process.env.XP_TOKEN;
    const record = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("dinar-guest-handoff") ?? "null"));
    const conversationAs = (page, id) => page.evaluate(async (cid) => {
      const response = await fetch(`/api/ai/conversations/${cid}`);
      return { status: response.status, body: response.status === 200 ? await response.json() : null };
    }, id);
    const delayHandoffResponse = async (context) => {
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      await context.route("**/api/ai/conversations/guest-handoff", async (route) => {
        const url = new URL(route.request().url());
        const headers = { ...route.request().headers(), origin: apiOrigin, referer: `${apiOrigin}/` };
        const response = await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers });
        await gate;
        try { await route.fulfill({ response }); } catch { /* the page that asked is gone */ }
      }, { times: 1 });
      return release;
    };
    const guestSearch = async (page) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await ready(page);
      let asked = await send(page, `ابحث عن ألواح شمسية ${token}`);
      // A fresh guest first chooses an active market; the same search then resumes once.
      const jordan = asked.locator.getByTestId("button-inline-market-JO");
      if (await jordan.count()) asked = await click(page, jordan);
      check(asked.text.includes(token), "the guest search is answered", asked.text.slice(0, 200));
      const kept = await record(page);
      check(kept?.messages?.length >= 2 && !kept.targetUserId, "the guest transcript is kept for this tab, unbound", JSON.stringify(kept)?.slice(0, 160));
      return kept.handoffId;
    };
    const details = {};

    // (a) Legitimate transfer, with a reload while the handoff response is still pending.
    {
      const { context, page } = await openRegisteredUserJourney(browser);
      const calls = trackHandoffs(page);
      try {
        const handoffId = await guestSearch(page);
        const release = await delayHandoffResponse(context);
        await loginInBrowser(page, "handoffC");
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("dinar-guest-handoff") ?? "{}").targetUserId, undefined, { timeout: 15_000 });
        await page.reload({ waitUntil: "domcontentloaded" });
        release();
        await ready(page);
        await page.waitForFunction(() => !sessionStorage.getItem("dinar-guest-handoff"), undefined, { timeout: 30_000 });
        await page.getByText(`ابحث عن ألواح شمسية ${token}`).first().waitFor({ timeout: 20_000 });
        const stored = await conversationAs(page, handoffId);
        const guestQuestions = stored.body?.messages?.filter((m) => (m.actor ?? m.role) === "USER" && m.body.includes(token)) ?? [];
        check(stored.status === 200 && guestQuestions.length === 1, "the guest conversation now belongs to the account, once", `${stored.status}/${guestQuestions.length}`);
        check(calls.length >= 1 && calls.every((c) => c.status < 300 && c.handoffId === handoffId && c.userId === users.handoffC), "every handoff call is the same handoff, for the signed-in account, and succeeds", JSON.stringify(calls));
        details.reloadDuringPending = { calls: calls.length, statuses: calls.map((c) => c.status) };
      } finally {
        await context.close();
      }
    }

    // (b) Sign-in in another tab while this tab holds a guest transcript.
    {
      const { context, page } = await openRegisteredUserJourney(browser);
      const guestTab = trackHandoffs(page);
      try {
        const handoffId = await guestSearch(page);
        const other = await context.newPage();
        const otherCalls = trackHandoffs(other);
        await loginInBrowser(other, "handoffD");
        check(otherCalls.length === 0, "the tab that signed in had no guest transcript and sends nothing", JSON.stringify(otherCalls));
        // The guest tab learns the new identity on its next load and moves its own transcript.
        await page.reload({ waitUntil: "domcontentloaded" });
        await ready(page);
        await page.waitForFunction(() => !sessionStorage.getItem("dinar-guest-handoff"), undefined, { timeout: 30_000 });
        check(guestTab.length === 1 && guestTab[0].status < 300 && guestTab[0].userId === users.handoffD && guestTab[0].handoffId === handoffId, "one handoff, for the account now signed in", JSON.stringify(guestTab));
        await other.close();
        details.otherTabLogin = { guestTabCalls: guestTab.length, signInTabCalls: otherCalls.length };
      } finally {
        await context.close();
      }
    }

    // (c) A pending handoff in one tab; the account logs out in another tab and a different
    //     account signs in; only then does the delayed response arrive.
    {
      const { context, page } = await openRegisteredUserJourney(browser);
      const calls = trackHandoffs(page);
      try {
        const handoffId = await guestSearch(page);
        const release = await delayHandoffResponse(context);
        await loginInBrowser(page, "handoffE");
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("dinar-guest-handoff") ?? "{}").targetUserId, undefined, { timeout: 15_000 });
        const other = await context.newPage();
        await other.goto("/settings", { waitUntil: "domcontentloaded" });
        await other.getByTestId("button-settings-logout").click();
        await other.getByTestId("dialog-confirm").getByTestId("button-confirm-action").click();
        await expectSignedOut(other);
        await loginInBrowser(other, "handoffF");
        // The first tab now loads as F while E's response is still in flight: E's pending
        // handoff is discarded — not sent as F, not shown, not reported to F as an error.
        await page.reload({ waitUntil: "domcontentloaded" });
        await ready(page);
        await page.waitForTimeout(800);
        check((await record(page)) === null, "E's pending handoff record is removed for F");
        check((await page.getByText("المحادثة محفوظة للحساب الذي بدأها").count()) === 0, "F is not shown E's handoff state");
        // Only now does E's delayed response arrive; the page that asked for it is gone.
        release();
        await page.waitForTimeout(800);
        check((await record(page)) === null, "the late response does not bring E's record back");
        check(calls.every((c) => c.userId === users.handoffE), "no handoff is ever attempted as F", JSON.stringify(calls));
        check((await page.getByText(`ابحث عن ألواح شمسية ${token}`).count()) === 0, "F's page shows nothing of E's guest conversation");
        const asF = await conversationAs(page, handoffId);
        check(asF.status === 404, "F cannot read E's transferred conversation", String(asF.status));
        const fHistory = await page.evaluate(async () => (await (await fetch("/api/ai/conversations")).json()));
        check(!JSON.stringify(fHistory).includes(handoffId), "E's conversation is not in F's history");
        await other.close();
        details.logoutOtherTabThenSwitch = { calls: calls.map((c) => c.status), fRead: asF.status };
      } finally {
        await context.close();
      }
    }
    return details;
  });

  // ── 11. Search follow-ups in the conversation: the visible result cards follow «فقط المستعملة»,
  //    «رتب الأرخص» and «افتح الثاني» on the same result set (blue 120 used, black 90 new,
  //    silver 150 used).
  // ── 12. Several tabs, one browser: another tab signs out and in as someone else while this one
  //    is in the background. On return nothing of the previous account shows or can be used until
  //    the server answers who is signed in (that answer is held back here), and then it is gone.
  //    Headless Chromium keeps every page "visible", so leaving and returning are emulated by the
  //    document's own visibilitychange.
  await journey("multi-tab-identity", async () => {
    const { context, page: tab1, expectedHttpRejections } = await openRegisteredUserJourney(browser);
    const tab2 = await context.newPage();
    tab2.on("pageerror", (error) => consoleErrors.push(`multi-tab: ${String(error).slice(0, 200)}`));
    const handoffCalls = [tab1, tab2].map(trackHandoffs);
    // Tab 1's API traffic, with whom each identity answer named: reported if the journey fails.
    const apiLog = [];
    tab1.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (!path.startsWith("/api/")) return;
      const entry = `${response.request().method()} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${response.status()}`;
      apiLog.push(entry);
      if (path === "/api/auth/me")
        void response.json().then((body) => { apiLog[apiLog.indexOf(entry)] = `${entry} user=${body?.user?.id === users.registeredA ? "A" : body?.user?.id === users.registeredB ? "B" : String(body?.user?.id ?? null)}`; }).catch(() => {});
    });
    // Returning to a tab also brings it to the front, as a person switching tabs would.
    const visibility = async (page, state) => {
      if (state === "visible") await page.bringToFront();
      await page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    };
    // The identity answer for one tab is held back until released (a slow network).
    const holdIdentity = (page) => {
      let release;
      identityGates.set(page, new Promise((resolve) => (release = resolve)));
      return async () => {
        identityGates.delete(page);
        release();
      };
    };
    const visibleText = (page) => page.locator("body").innerText();
    // The open conversation for a user in whichever market they are in (A was moved to Kuwait earlier).
    const openConversation = (page, userId) =>
      page.evaluate((prefix) => {
        const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
        return key ? localStorage.getItem(key) : null;
      }, `dinar-conversation:${userId}:`);
    const signOut = async (page) => {
      await page.bringToFront();
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await page.getByTestId("button-settings-logout").click();
      await page.getByTestId("dialog-confirm").getByTestId("button-confirm-action").click();
      await expectSignedOut(page);
    };
    try {
      await loginInBrowser(tab1, "registeredA");
      const secretA = `ملاحظة${[...process.env.XP_TOKEN].reverse().join("")}خاصة`;
      await send(tab1, `اشرح لي ${secretA}`);
      const aConversation = await openConversation(tab1, users.registeredA);
      check(Boolean(aConversation) && (await visibleText(tab1)).includes(secretA), "A's conversation is on screen in tab 1", `${aConversation}`);
      await visibility(tab1, "hidden");

      // Tab 2, well inside the identity's 30 s freshness: A signs out, B signs in.
      await signOut(tab2);
      await loginInBrowser(tab2, "registeredB");

      // Tab 1 returns; the identity answer is delayed.
      const releaseA = holdIdentity(tab1);
      await visibility(tab1, "visible");
      await tab1.getByTestId("identity-verifying").waitFor();
      const pending = await tab1.evaluate(() => {
        const content = document.querySelector(".ai-home-content");
        // Read at once, without waiting for a frame: a background tab may not tick any.
        return { hidden: getComputedStyle(content).visibility === "hidden", inert: content.inert === true };
      });
      check(pending.hidden && pending.inert, "while the identity is pending, tab 1's private content is hidden and inert", JSON.stringify(pending));
      check(!(await visibleText(tab1)).includes(secretA), "no text of A's conversation is visible while pending");
      await releaseA();
      await tab1.getByTestId("identity-verifying").waitFor({ state: "detached" });
      await tab1.waitForFunction((id) => !document.documentElement.innerHTML.includes(id), aConversation, { timeout: 15_000 });
      const html1 = await tab1.content();
      check(!html1.includes(secretA) && !html1.includes(aConversation), "after the answer, A's messages and conversation id are gone from tab 1's DOM");
      await tab1.getByTestId("button-toggle-conversation-history").click();
      check(await tab1.getByTestId(`conversation-${aConversation}`).count() === 0, "B's history in tab 1 does not list A's conversation");
      await tab1.keyboard.press("Escape");
      const probes = await tab1.evaluate(async (id) => [
        (await fetch(`/api/ai/conversations/${id}`)).status,
        (await fetch(`/api/ai/conversations/${id}/turns`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "اعرض الرسائل" }) })).status,
      ], aConversation);
      check(probes.join() === "404,404", "the server still refuses A's conversation to B (404/404)", probes.join());

      // Tab 1 now works as B; then B signs out in tab 2 while tab 1 is in the background.
      const secretB = `مسودة${[...process.env.XP_TOKEN].reverse().join("")}ثانية`;
      await send(tab1, `اشرح لي ${secretB}`);
      const bConversation = await openConversation(tab1, users.registeredB);
      check(Boolean(bConversation) && bConversation !== aConversation, "tab 1 continues as B in B's own conversation");
      await visibility(tab1, "hidden");
      await signOut(tab2);
      const releaseB = holdIdentity(tab1);
      await visibility(tab1, "visible");
      await tab1.getByTestId("identity-verifying").waitFor();
      check(!(await visibleText(tab1)).includes(secretB), "B's conversation is not visible while the sign-out is being confirmed");
      await releaseB();
      await tab1.getByTestId("identity-verifying").waitFor({ state: "detached" });
      await tab1.waitForFunction((id) => !document.documentElement.innerHTML.includes(id), bConversation, { timeout: 15_000 });
      check(!(await tab1.content()).includes(secretB), "after sign-out elsewhere, tab 1 keeps nothing of B");
      // Through the context's own request client: same cookies as the tabs, nothing in their consoles.
      const guestRead = (await context.request.get(`${apiOrigin}/api/ai/conversations/${bConversation}`, { headers: { origin: apiOrigin } })).status();
      check(guestRead === 401 || guestRead === 404, "a signed-out tab cannot read B's conversation", String(guestRead));

      const handoffs = handoffCalls.flat();
      check(handoffs.length === 0, "no guest handoff from either tab: neither held a guest transcript", JSON.stringify(handoffs));
      const rejections = expectedHttpRejections.filter(({ path }) => path.startsWith("/api/ai/"));
      check(rejections.length >= 2 && rejections.every(({ status }) => status === 404), "only the deliberate 404 probes were rejected", JSON.stringify(rejections));
      await shot(tab1, "multi-tab-after-signout-390");
      return { switchWithin30s: "A→B", pendingHiddenAndInert: true, crossAccount: probes.join("/"), signedOutRead: guestRead, guestHandoffCalls: handoffs.length };
    } catch (error) {
      await shot(tab1, "multi-tab-failure").catch(() => {});
      throw new Error(`${error.message} — tab 1 API: ${JSON.stringify(apiLog.slice(-12))}; text: ${(await tab1.locator("body").innerText().catch(() => "")).slice(-400)}`);
    } finally {
      await context.close();
    }
  });

  await journey("search-follow-ups", async () => {
    const item = [...process.env.XP_TOKEN].reverse().join("") + "ات";
    const shown = (turn) => turn.locator.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) =>
      cards.map((card) => (/أزرق/u.test(card.innerText) ? "blue" : /أسود/u.test(card.innerText) ? "black" : /فضي/u.test(card.innerText) ? "silver" : "other")));
    const details = {};
    for (const [width, scheme] of [[390, "light"], [1280, "dark"]]) {
      const { context, page } = await open(browser, "main", { width, scheme });
      try {
        const isFirstCard = (await assistants(page).count()) === 0;
        if (isFirstCard) {
          // A fresh conversation has no prior result cards, so this measures the first useful
          // card from send to DOM insertion under the scripted model gateway.
          await startFirstCardTimer(page);
        }
        const all = await send(page, `ابحث عن ${item}`);
        check((await shown(all)).sort().join() === "black,blue,silver", "the search shows the three offers", JSON.stringify(await shown(all)));
        const firstCardMs = isFirstCard ? await readFirstCardTimer(page) : 0;
        check(Number.isFinite(firstCardMs) && firstCardMs > 0, "first useful card latency captured", String(firstCardMs));
        const used = await send(page, "فقط المستعملة");
        check((await shown(used)).sort().join() === "blue,silver", "only the used offers remain", JSON.stringify(await shown(used)));
        const cheapest = await send(page, "رتب الأرخص");
        check((await shown(cheapest)).join() === "blue,silver", "cheapest first, filter kept", JSON.stringify(await shown(cheapest)));
        const second = await send(page, "افتح الثاني");
        check((await shown(second)).join() === "silver", "«الثاني» opens the second visible offer", JSON.stringify(await shown(second)));
        check((await overflow(page)) <= 0, `no page overflow at ${width}`);
        // The opened details load after the turn; evidence shows them loaded, not their skeleton.
        await page.waitForLoadState("networkidle").catch(() => {});
        await shot(page, `search-follow-ups-${width}-${scheme}`);

        // «ماذا لو كان السعر أقل بـ10%؟» on the opened negotiable listing (120): a calculation
        // card, then its button opens the ordinary offer review — nothing is sent.
        const hyp = [...process.env.XP_TOKEN].reverse().join("") + "وس";
        const found = await send(page, `ابحث عن ${hyp} قابل للتفاوض`);
        const cards = await found.locator.locator('[data-testid^="card-ai-result-"]').evaluateAll((items) => items.map((card) => /قابل للتفاوض/u.test(card.innerText)));
        await send(page, `افتح ${["الأول", "الثاني"][cards.indexOf(true)]}`);
        const calc = await send(page, "ماذا لو كان السعر أقل بـ10%؟");
        const card = calc.locator.getByTestId("negotiation-hypothetical");
        await card.waitFor();
        check((await card.getByTestId("hypothetical-price").innerText()).includes("108"), "the calculated price is shown");
        check((await card.locator('[data-emphasis="GOLD"], [data-verified]').count()) === 0, "a calculation is never gold");
        check((await card.boundingBox()).width <= 441, "the calculation card is compact", String((await card.boundingBox()).width));
        await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: `${out}/shots/hypothetical-${width}-${scheme}.png` });
        const review = await click(page, card.getByTestId("hypothetical-offer"));
        const reviewCard = review.locator.getByTestId("negotiation-review");
        await reviewCard.waitFor();
        check((await reviewCard.getByTestId("negotiation-offer").innerText()).includes("108"), "the review carries the calculated amount");
        check((await reviewCard.getByTestId("pending-notice").innerText()).includes("لم يُرسل"), "the review says nothing was sent");
        check((await calc.locator.getByTestId("hypothetical-offer").count()) === 0, "the superseded calculation offers nothing");
        await reviewCard.screenshot({ path: `${out}/shots/hypothetical-review-${width}-${scheme}.png` });
        await send(page, "إلغاء");
        check((await overflow(page)) <= 0, `no page overflow after the calculation at ${width}`);
        details[`${width}-${scheme}`] = {
          all: 3,
          used: 2,
          sorted: "blue,silver",
          opened: "silver",
          hypothetical: "108 → review",
          firstUsefulCardMs: Math.round(firstCardMs),
          firstTurnSettledMs: all.turnSettledMs,
          followUpTurnSettledMs: [used.turnSettledMs, cheapest.turnSettledMs, second.turnSettledMs],
        };
      } finally {
        await context.close();
      }
    }
    return details;
  });

  // ── 9. Composed surfaces: cards built from the shared primitives over real records, updated
  //    by follow-ups (typed or pressed), restored after reload, inert once superseded.
  await journey("composed-surfaces", async () => {
    const cardFacts = (locator) => locator.locator(".ds-card").first().evaluate((card) => {
      const box = card.getBoundingClientRect();
      const clipped = [...card.querySelectorAll(".ds-metric-value, .ds-total, .ds-fact dd, .ds-option-subtitle, button")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > box.right + 1 || el.getBoundingClientRect().left < box.left - 1).length;
      return { width: Math.round(box.width), size: card.parentElement?.getAttribute("data-size"), clipped, buttons: card.querySelectorAll("button").length };
    });
    const details = { widths: [] };
    const { context, page } = await open(browser, "seller", { width: 390 });
    try {
      // Seller analytics from the seller's own completed order.
      const sales = await send(page, "دينار كيف كانت مبيعاتي هذا الشهر؟");
      await sales.locator.getByTestId("sales-summary").waitFor();
      check((await sales.locator.getByTestId("sales-metric-orders").innerText()).includes("1"), "orders metric from the real order");
      check((await sales.locator.locator(".ds-metrics").count()) === 1, "composed from the metrics primitive");
      // `settle` returns the newest message; pin this card by position before the conversation moves on.
      const firstSales = assistants(page).nth((await assistants(page).count()) - 1);
      // A pressed follow-up is a conversation turn: the period changes from server data.
      const week = await click(page, firstSales.getByTestId("sales-period-week"));
      check(/آخر 7 أيام/u.test(await week.locator.getByTestId("sales-period").innerText()), "period follow-up applied", week.text.slice(0, 200));
      check((await firstSales.locator(".ds-card button").count()) === 0, "a superseded card offers no actions");
      // A typed follow-up reaches the same card type: comparison with the previous period.
      const compared = await click(page, week.locator.getByTestId("sales-compare"));
      check(/مقابل/u.test(await compared.locator.getByTestId("sales-period").innerText()), "comparison rendered", compared.text.slice(0, 200));
      check((await compared.locator.locator(".ds-metric-previous").count()) >= 1, "previous values shown beside current ones");
      details.salesFollowUps = ["THIS_MONTH", "LAST_7_DAYS", "LAST_7_DAYS vs previous"];

      // Plans and usage: configured tiers only; follow-up from the card.
      const plans = await send(page, "دينار اعرض الباقات");
      await plans.locator.getByTestId("ai-plans").waitFor();
      check((await plans.locator.getByTestId("ai-plan").count()) === 3, "three configured tiers");
      check(!/الأكثر|غير محدود|unlimited/iu.test(plans.text), "no popularity or unlimited claim");
      check(/السعر غير معتمد بعد|مجانًا/u.test(plans.text), "prices only from configuration");
      await plans.locator.getByTestId("ai-plans-billing").waitFor();
      const usage = await click(page, plans.locator.getByTestId("plans-show-usage"));
      await usage.locator.getByTestId("ai-usage").waitFor();
      check((await usage.locator.getByRole("progressbar").count()) >= 2, "usage meters from quota records");
      const usageCard = await cardFacts(usage.locator);
      check(usageCard.size === "COMPACT" && usageCard.width <= 440, "a small card stays small", JSON.stringify(usageCard));

      // Keyboard: the live card's actions are reachable and visibly focused.
      const action = usage.locator.getByTestId("usage-show-plans");
      await action.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const focus = await action.evaluate((el) => ({ focused: document.activeElement === el, visible: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).boxShadow !== "none", height: el.getBoundingClientRect().height }));
      check(focus.focused && focus.visible && focus.outline, "visible keyboard focus", JSON.stringify(focus));
      check(focus.height >= 40, "touch target", JSON.stringify(focus));

      // General chat continues without commerce UI after the business cards.
      const general = await send(page, "دينار اشرح لي TypeScript");
      check((await general.locator.locator(".ds-card, .ai-surface").count()) === 0, "no card for a programming question");
      check((await general.locator.locator("pre").count()) >= 1, "code rendered as a code block");

      // Reload: the same cards come back from the stored conversation, live actions only on the latest.
      const before = await page.locator(".ds-card").count();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("input-ai-composer").waitFor({ timeout: 30_000 });
      await page.locator(".ds-card").nth(before - 1).waitFor({ timeout: 30_000 });
      check((await page.locator(".ds-card").count()) === before, "surfaces restored after reload", `${before}`);
      check((await page.getByTestId("sales-period-week").count()) === 0 || !(await page.getByTestId("sales-period-week").first().isVisible()), "restored history cards stay inert");
      check((await overflow(page)) <= 0, "no page overflow at 390");
      await shot(page, "composed-390-light");
    } finally {
      await context.close();
    }
    for (const [width, scheme] of [[320, "light"], [390, "dark"], [768, "light"], [1280, "dark"], [1600, "light"]]) {
      const view = await open(browser, "seller", { width, scheme });
      try {
        const sales = await send(view.page, "قارن مبيعاتي هذا الشهر بالفترة السابقة");
        await sales.locator.getByTestId("sales-summary").waitFor();
        const salesCard = await cardFacts(sales.locator);
        await sales.locator.locator(".ds-card").first().screenshot({ path: `${out}/shots/composed-sales-${width}-${scheme}.png` });
        const plans = await send(view.page, "دينار اعرض الباقات");
        await plans.locator.getByTestId("ai-plans").waitFor();
        const plansCard = await cardFacts(plans.locator);
        // Columns actually occupied: auto-fit leaves collapsed 0px tracks, which hold nothing.
        const columns = await plans.locator.locator(".ds-options").evaluate((el) => new Set([...el.children].map((item) => Math.round(item.getBoundingClientRect().left))).size);
        check(salesCard.clipped === 0 && plansCard.clipped === 0, `no clipped values at ${width}`, JSON.stringify({ salesCard, plansCard }));
        check((await overflow(view.page)) <= 0, `no page overflow at ${width}`);
        if (width <= 430) check(columns === 1, `plans stack on a phone at ${width}`, `${columns}`);
        if (width >= 1280) check(columns === 3 && plansCard.width <= 880, `plans side by side, bounded at ${width}`, JSON.stringify({ columns, plansCard }));
        await plans.locator.scrollIntoViewIfNeeded();
        await shot(view.page, `composed-${width}-${scheme}`);
        details.widths.push({ width, scheme, sales: salesCard.width, plans: plansCard.width, columns });
      } finally {
        await view.context.close();
      }
    }
    return details;
  });
  // Functional audit: an exposed account link must reach its existing canonical view.
  await journey("account-notification-navigation", async () => {
    const { context, page } = await openRegisteredUserJourney(browser);
    try {
      await loginInBrowser(page, "main");
      await page.goto("/profile", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: "التنبيهات", exact: true }).click();
      await expect(page.getByRole("heading", { name: "التنبيهات", exact: true })).toBeVisible({ timeout: 5_000 });
      check(new URL(page.url()).pathname === "/notifications", "notification link reaches its named destination", page.url());
      const response = await context.request.get(`${apiOrigin}/api/orders`);
      check(response.status() === 200 && Array.isArray(await response.json()), "notifications use the authenticated canonical order source");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "التنبيهات", exact: true })).toBeVisible();
      const orderId = process.env.XP_NOTIFICATION_ORDER;
      check(Boolean(orderId), "canonical pending-receipt fixture supplied");
      const row = page.getByTestId(`row-order-${orderId}`);
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByTestId("button-confirm-receipt")).toBeVisible({ timeout: 5_000 });
      check(new URL(page.url()).searchParams.get("order") === orderId, "notification preserves its exact order in navigation", page.url());
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("button-confirm-receipt")).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("heading", { name: "التنبيهات", exact: true })).toBeVisible();
      await expect(page.getByTestId(`row-order-${orderId}`)).toBeVisible();
      await page.getByTestId(`row-order-${orderId}`).click();
      await expect(page.getByTestId("button-confirm-receipt")).toBeVisible();
      const detailProfiles = [];
      for (const width of [320, 360, 390, 430, 768, 1024, 1440, 1920]) {
        for (const scheme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: width < 768 ? 820 : 900 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(page.getByTestId("button-confirm-receipt")).toBeVisible();
          const facts = await page.evaluate(() => ({
            dir: document.documentElement.dir,
            dark: document.documentElement.classList.contains("dark"),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          }));
          check(facts.dir === "rtl" && facts.dark === (scheme === "dark") && facts.overflow <= 0,
            `authoritative notification order at ${width}/${scheme}`, JSON.stringify(facts));
          await shot(page, `notification-order-${width}-${scheme}`);
          detailProfiles.push({ width, scheme, ...facts });
        }
      }
      await page.setViewportSize({ width: 390, height: 820 });
      const visibility = (state) => page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
      await visibility("hidden");
      const other = await context.newPage();
      await other.goto("/settings", { waitUntil: "domcontentloaded" });
      await other.getByTestId("button-settings-logout").click();
      await other.getByTestId("dialog-confirm").getByTestId("button-confirm-action").click();
      await expectSignedOut(other);
      await loginInBrowser(other, "registeredB");
      let release;
      identityGates.set(page, new Promise((resolve) => { release = resolve; }));
      try {
        await visibility("visible");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        check(!(await page.getByTestId("button-confirm-receipt").isVisible()), "old owner's private order is hidden while session identity is revalidated");
      } finally {
        identityGates.delete(page);
        release();
      }
      const privateRead = await context.request.get(`${apiOrigin}/api/orders/${orderId}`);
      check(privateRead.status() === 404, "the new account cannot read the notification owner's order");
      await expect(page.getByTestId("button-confirm-receipt")).toHaveCount(0);
      await other.close();
      // Leave the old private detail route before observing the malformed-reference case:
      // its legitimate account-switch refetch is independent of this input.
      await page.goto("/notifications", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "التنبيهات", exact: true })).toBeVisible();
      const invalidOrderRequests = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/orders/") || path.startsWith("/api/admin/") || path.startsWith("/admin/")) invalidOrderRequests.push(path);
      });
      await page.goto(`/notifications?order=${encodeURIComponent("../../admin/markets")}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("رابط الطلب غير صحيح.", { exact: true })).toBeVisible();
      check(invalidOrderRequests.length === 0, "malformed order references never become an API path", JSON.stringify(invalidOrderRequests));
      await context.clearCookies();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator('input[name="phoneNumber"]')).toBeVisible();
      check((await context.request.get(`${apiOrigin}/api/orders`)).status() === 401, "anonymous notifications cannot read orders");
      return { source: "GET /api/orders", orderId, detailProfiles, reload: "same canonical order", back: "notification list", accountSwitch: "old order masked; new account 404", invalidReference: "no order API request", anonymous: "login required; orders 401", execution: "no receipt confirmation" };
    } finally {
      await shot(page, "audit-notification-navigation").catch(() => {});
      await context.close();
    }
  });

  await journey("site-cart-navigation", async () => {
    const { context, page } = await open(browser, "main", { width: 390 });
    try {
      await page.locator('[data-testid="link-cart"]:visible').first().click();
      await expect(page.getByTestId("page-cart")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId(`row-cart-item-${process.env.XP_CART_LISTING}`)).toBeVisible();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId(`row-cart-item-${process.env.XP_CART_LISTING}`)).toBeVisible();
      return { persistedListing: process.env.XP_CART_LISTING, source: "canonical conversation CART surface and GET /api/cart" };
    } finally { await shot(page, "audit-site-cart-navigation").catch(() => {}); await context.close(); }
  });

  await journey("profile-commerce-navigation", async () => {
    const { context, page } = await open(browser, "seller", { width: 390 });
    const visited = [];
    try {
      for (const [shortcut, target] of [["offers", "listings"], ["sales", "sales"], ["dues", "dues"]]) {
        await page.goto("/profile", { waitUntil: "domcontentloaded" });
        await page.getByTestId(`link-profile-${shortcut}`).click();
        if (target === "listings") await expect(page.locator('[data-testid^="chat-seller-listing-"]').first()).toBeVisible({ timeout: 5_000 });
        if (target === "sales") await expect(page.getByTestId("sales-summary")).toBeVisible({ timeout: 5_000 });
        if (target === "dues") await expect(page.getByTestId("text-dues-total").first()).toBeVisible({ timeout: 5_000 });
        check((await page.getByTestId("input-ai-composer").count()) === 1, "account shortcuts reuse the one conversation runtime");
        await shot(page, `audit-profile-${shortcut}`);
        visited.push(shortcut);
      }
      return { visited, authority: "existing seller listings, sales and dues services" };
    } finally { await shot(page, "audit-profile-commerce-navigation").catch(() => {}); await context.close(); }
  });

  await journey("protected-unsaved-form-revalidation", async () => {
    const { context, page } = await openRegisteredUserJourney(browser);
    try {
      await loginInBrowser(page, "draftOwner");
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      const field = page.getByLabel("الاسم الظاهر", { exact: true });
      const persisted = await field.inputValue();
      const draft = `اسم غير محفوظ ${process.env.XP_TOKEN}`;
      await field.fill(draft);
      await page.getByTestId("button-settings-logout").click();
      await expect(page.getByTestId("dialog-confirm")).toBeVisible();
      let release;
      identityGates.set(page, new Promise((resolve) => { release = resolve; }));
      const visibility = (value) => page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
        document.dispatchEvent(new Event("visibilitychange"));
      }, value);
      try {
        await visibility("hidden");
        await visibility("visible");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        check(!(await field.isVisible()), "private form hidden while identity is unknown");
        check(!(await page.getByTestId("dialog-confirm").isVisible()), "portalled private dialog hidden while identity is unknown");
      } finally { identityGates.delete(page); release(); }
      await expect(field).toBeVisible();
      const recovered = { value: await field.inputValue(), dialog: await page.getByTestId("dialog-confirm").isVisible() };
      check(recovered.value === draft && recovered.dialog, "same-account verification preserves unsaved input and its reviewed dialog", JSON.stringify(recovered));
      await page.getByTestId("dialog-confirm").getByRole("button", { name: "تراجع", exact: true }).click();
      const me = await context.request.get(`${apiOrigin}/api/auth/me`);
      check(me.status() === 200 && (await me.json()).user.displayName === persisted, "verification and cancellation do not save or log out");
      return { privateForm: "hidden pending identity", privatePortal: "hidden pending identity", sameAccount: "draft and dialog preserved", writes: "none" };
    } finally { await shot(page, "audit-unsaved-form-revalidation").catch(() => {}); await context.close(); }
  });

  await journey("site-search-and-selling-entry", async () => {
    const { context, page } = await open(browser, "main", { width: 1440 });
    try {
      await page.goto("/profile", { waitUntil: "domcontentloaded" });
      const query = `ألواح شمسية ${process.env.XP_TOKEN}`;
      const search = page.getByRole("searchbox", { name: "البحث في العروض", exact: true });
      await search.fill(query);
      await search.press("Enter");
      const composer = page.getByTestId("input-ai-composer");
      await expect(composer).toHaveValue(`ابحث عن ${query}`, { timeout: 5_000 });
      const found = await click(page, page.getByTestId("button-send-ai-message"));
      check(found.text.includes(process.env.XP_TOKEN), "header search reaches authoritative internal results", found.text.slice(0, 250));
      await expect(found.locator.locator('[data-testid^="card-ai-result-"]').first()).toBeVisible();
      await page.setViewportSize({ width: 390, height: 820 });
      await page.goto("/profile", { waitUntil: "domcontentloaded" });
      await page.getByTestId("nav-discover").click();
      await expect(composer).toHaveValue(/^ابحث عن/u);
      await page.goto("/profile", { waitUntil: "domcontentloaded" });
      await page.getByTestId("nav-seller").click();
      await expect(composer).toHaveValue("أريد أن أبيع ");
      return { desktopSearch: "query preserved then explicitly sent", discover: "search draft", sell: "existing sell draft; no automatic publication" };
    } finally { await shot(page, "audit-site-search-and-selling-entry").catch(() => {}); await context.close(); }
  });

  await journey("protected-failed-identity-revalidation", async () => {
    const { context, page } = await openRegisteredUserJourney(browser);
    const visibility = (value) => page.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }, value);
    try {
      await loginInBrowser(page, "draftOwner");
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      const field = page.getByLabel("الاسم الظاهر", { exact: true });
      const privateDraft = `مسودة خاصة ${process.env.XP_TOKEN}`;
      await field.fill(privateDraft);
      await page.getByTestId("button-settings-logout").click();
      await expect(page.getByTestId("dialog-confirm")).toBeVisible();
      identityFailures.add(page);
      const failedRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/me" && response.status() === 503);
      await visibility("hidden");
      await visibility("visible");
      await failedRead;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(!(await field.isVisible()), "failed identity verification never reveals cached private data");
      check(!(await page.getByTestId("dialog-confirm").isVisible()), "failed identity verification never reveals a private portal");
      const other = await context.newPage();
      await other.goto("/settings", { waitUntil: "domcontentloaded" });
      await other.getByTestId("button-settings-logout").click();
      await other.getByTestId("dialog-confirm").getByTestId("button-confirm-action").click();
      await expectSignedOut(other);
      await loginInBrowser(other, "registeredB");
      await page.bringToFront();
      const failedAgain = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/me" && response.status() === 503);
      await visibility("visible");
      await failedAgain;
      const retry = page.getByTestId("button-retry-private-identity");
      await expect(retry).toBeVisible();
      check(!(await field.isVisible()), "old draft stays hidden after another account signs in");
      identityFailures.delete(page);
      await retry.click();
      await expect(field).toBeVisible();
      const me = await context.request.get(`${apiOrigin}/api/auth/me`);
      const actual = (await me.json()).user;
      check(me.status() === 200 && actual.id === users.registeredB, "retry verifies the actual new server identity");
      check((await field.inputValue()) === actual.displayName && (await field.inputValue()) !== privateDraft, "another account never inherits the previous account's unsaved form");
      await expect(page.getByTestId("dialog-confirm")).toHaveCount(0);
      await other.close();
      return { fault: "explicit local auth/me 503", privacy: "form and portal remain hidden", retry: "server-verified B; old local state discarded" };
    } finally { identityFailures.delete(page); await shot(page, "audit-failed-identity-revalidation").catch(() => {}); await context.close(); }
  });

  await journey("cart-queued-cross-account-isolation", async () => {
    const { context, page } = await openRegisteredUserJourney(browser, { clientIp: "198.18.201.10" });
    let releaseAck = () => {};
    try {
      await loginInBrowser(page, "cartOwner");
      await page.goto("/cart", { waitUntil: "domcontentloaded" });
      const listingId = process.env.XP_CART_LISTING;
      await expect(page.getByTestId(`row-cart-item-${listingId}`)).toBeVisible();
      let firstReceiptStatus;
      const ack = new Promise((resolve) => { releaseAck = resolve; });
      let putCount = 0;
      const writes = [];
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/api/cart" && response.request().method() === "PUT") writes.push(response.status());
      });
      await context.route("**/api/cart", async (route) => {
        if (route.request().method() !== "PUT" || route.request().frame().page() !== page || ++putCount !== 1) return route.fallback();
        const response = await route.fetch({ url: `${apiOrigin}/api/cart`, headers: { ...route.request().headers(), origin: apiOrigin, referer: `${apiOrigin}/`, "x-forwarded-for": "198.18.201.10" } });
        firstReceiptStatus = response.status();
        await ack;
        await route.fulfill({ response }).catch(() => {});
      });
      await page.getByTestId(`button-increase-${listingId}`).click();
      await expect.poll(() => firstReceiptStatus, { timeout: 10_000 }).toBe(200);
      await page.getByTestId(`button-increase-${listingId}`).click();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const other = await context.newPage();
      await other.goto("/settings", { waitUntil: "domcontentloaded" });
      await other.getByTestId("button-settings-logout").click();
      await other.getByTestId("dialog-confirm").getByTestId("button-confirm-action").click();
      await expectSignedOut(other);
      await loginInBrowser(other, "cartOther");
      check((await (await context.request.get(`${apiOrigin}/api/cart`)).json()).length === 0, "new account starts with its own empty cart");
      releaseAck();
      await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(2);
      const identityAfterAck = await (await context.request.get(`${apiOrigin}/api/auth/me`)).json();
      check(identityAfterAck.user.id === users.cartOther, "the new account is still the authenticated actor after the late acknowledgement");
      const cart = await (await context.request.get(`${apiOrigin}/api/cart`)).json();
      check(cart.length === 0, "queued previous-account cart mutation never changes the new account's cart", JSON.stringify({ writes, rows: cart.map((item) => ({ listingId: item.listingId, quantity: item.quantity })) }));
      check(writes[0] === 200 && writes[1] === 409, "stale queued actor intent is explicitly rejected", JSON.stringify(writes));
      await other.close();
      return { initialOwnerReceipt: writes[0], staleQueuedIntent: writes[1], newAccountCart: "empty", state: "verified with canonical API" };
    } finally { releaseAck(); await shot(page, "audit-cart-queued-cross-account").catch(() => {}); await context.close(); }
  });

  await journey("registered-phone-signup", async () => {
    const { context, page } = await openRegisteredUserJourney(browser, { clientIp: "198.18.202.11" });
    try {
      await page.goto("/register", { waitUntil: "domcontentloaded" });
      const phone = String(50_000_000 + ((Date.now() + process.pid) % 999_000));
      const password = `LocalOnly-${crypto.randomUUID()}!`;
      await page.locator('input[name="displayName"]').fill(`مستخدم تدقيق ${process.env.XP_TOKEN}`);
      await page.locator('input[name="phoneNumber"]').fill(phone);
      await page.locator('input[name="password"]').fill(password);
      await page.locator('input[name="confirmPassword"]').fill(password);
      await page.locator('input[name="acceptTerms"]').check();
      const submit = page.getByTestId("button-auth-submit");
      const challengeRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/phone-verification/challenges" && r.request().method() === "POST");
      await submit.click();
      const challengeResponse = await challengeRead;
      const challenge = await challengeResponse.json();
      check(challengeResponse.ok() && /^\d{6}$/u.test(challenge.developmentCode), "explicit local development phone provider supplies a real challenge, not a verification bypass");
      await page.getByTestId("input-phone-verification-code").fill(challenge.developmentCode);
      const proofRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/phone-verification/challenges/verify" && r.request().method() === "POST");
      await submit.click();
      check((await proofRead).ok(), "phone ownership proof is verified through the real API");
      await expect(submit).toHaveText("إنشاء الحساب");
      const accountRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/register" && r.request().method() === "POST");
      await submit.click();
      const accountResponse = await accountRead;
      const submitted = accountResponse.request().postDataJSON();
      check(accountResponse.status() === 201 && typeof submitted.verificationToken === "string" && submitted.verificationToken.length > 0 && submitted.acceptTerms === true, "registration consumes verified phone proof and explicit terms consent");
      await ready(page);
      const me = await context.request.get(`${apiOrigin}/api/auth/me`);
      const registered = (await me.json()).user;
      check(me.status() === 200 && registered.phoneVerified === true, "new browser session belongs to the phone-verified registered account");
      return { createdUserId: registered.id, registrationStatus: accountResponse.status(), phoneVerified: true, verificationProofInRequest: true, transport: "LOCAL_DEVELOPMENT_PROVIDER; not live SMS" };
    } finally { await shot(page, "audit-registered-phone-signup").catch(() => {}); await context.close(); }
  });

  await journey("admin-market-category-promotion-controls", async () => {
    const { context, page } = await open(browser, "admin", { width: 1440 });
    const nonce = Date.now().toString(36);
    const categoryId = `audit-ui-${nonce}`;
    const categoryLabel = `تصنيف تدقيق ${process.env.XP_TOKEN}`;
    const updatedCategoryLabel = `${categoryLabel} محدث`;
    const planName = `خطة تدقيق ${nonce}`;
    try {
      await page.goto("/admin/categories", { waitUntil: "domcontentloaded" });
      await page.getByLabel("معرّف ثابت بالإنجليزية", { exact: true }).fill(categoryId);
      await page.getByLabel("اسم التصنيف بالعربية", { exact: true }).fill(categoryLabel);
      await page.getByLabel("Name in English", { exact: true }).fill(`Audit ${nonce}`);
      const categoryCreated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/categories" && r.request().method() === "POST");
      await page.getByRole("button", { name: "إضافة التصنيف", exact: true }).click();
      const categoryReceipt = await categoryCreated;
      check(categoryReceipt.status() === 201 && (await categoryReceipt.json()).id === categoryId, "category creation has a canonical backend receipt");
      await page.getByRole("button", { name: `تعديل ${categoryLabel}`, exact: true }).click();
      await page.getByLabel("اسم التصنيف بالعربية", { exact: true }).fill(updatedCategoryLabel);
      const categoryUpdated = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/categories/${categoryId}` && r.request().method() === "PATCH");
      await page.getByRole("button", { name: "حفظ التغييرات", exact: true }).click();
      check((await categoryUpdated).status() === 200, "category update persisted");
      const audit = await context.request.get(`${apiOrigin}/api/admin/categories/${categoryId}/audit`);
      check(audit.status() === 200 && (await audit.json()).length >= 2, "category create/update audit persists");
      await page.goto("/admin/promotions", { waitUntil: "domcontentloaded" });
      await page.getByLabel("السوق", { exact: true }).selectOption("JO");
      await page.getByLabel("التصنيف", { exact: true }).selectOption(categoryId);
      await page.getByLabel("اسم الخطة", { exact: true }).fill(planName);
      await page.getByLabel("السعر (JOD)", { exact: true }).fill("2.500");
      await page.getByLabel("المدة بالأيام", { exact: true }).fill("7");
      const planCreated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/markets/JO/promotion-products" && r.request().method() === "POST");
      await page.getByRole("button", { name: "إضافة الخطة", exact: true }).click();
      const planReceipt = await planCreated;
      const plan = await planReceipt.json();
      check(planReceipt.status() === 201 && plan.priceMinor === 2_500 && plan.currencyCode === "JOD", "promotion catalog amount/currency are server receipts");
      await page.locator("li").filter({ has: page.getByText(planName, { exact: true }) }).getByRole("button", { name: "تعديل", exact: true }).click();
      await page.getByRole("checkbox", { name: "الخطة متاحة للبائعين", exact: true }).uncheck();
      const planUpdated = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/markets/JO/promotion-products/${plan.id}` && r.request().method() === "PATCH");
      await page.getByRole("button", { name: "حفظ التعديل", exact: true }).click();
      check((await planUpdated).status() === 200, "promotion plan can be disabled through its actual editor");
      await page.goto("/admin/markets", { waitUntil: "domcontentloaded" });
      await page.getByTestId("button-select-market-JO").click();
      await page.getByTestId("input-market-unit-price").fill("5.000");
      await page.getByTestId("radio-price-immediate").check();
      const priceCreated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/markets/JO/prices" && r.request().method() === "POST");
      await page.getByTestId("button-create-market-price").click();
      const priceReceipt = await priceCreated;
      check(priceReceipt.status() === 201, "market price editor persists a new reviewed fixture price version");
      await page.getByTestId("button-select-market-KW").click();
      await expect(page.getByTestId("form-market-configuration-KW")).toBeVisible();
      await page.getByTestId("select-market-status").selectOption("DISABLED");
      const configUpdated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/markets/KW" && r.request().method() === "PATCH");
      await page.getByTestId("button-save-market-configuration").click();
      check((await configUpdated).status() === 200, "market can be safely disabled through the actual configuration form");
      const profiles = [];
      for (const path of ["/admin/categories", "/admin/promotions", "/admin/markets"]) {
        for (const width of [320, 360, 390, 430, 768, 1024, 1440, 1920]) {
          for (const scheme of ["light", "dark"]) {
            await page.setViewportSize({ width, height: width < 768 ? 820 : 900 });
            await page.emulateMedia({ colorScheme: scheme });
            await page.goto(path, { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: path.endsWith("categories") ? "إدارة التصنيفات" : path.endsWith("promotions") ? "إدارة الترويج" : "إدارة الأسواق", exact: true }).first()).toBeVisible();
            if (path.endsWith("categories")) await expect(page.getByRole("button", { name: `تعديل ${updatedCategoryLabel}`, exact: true })).toBeVisible();
            if (path.endsWith("promotions")) {
              await expect(page.getByText(planName, { exact: true })).toBeVisible();
              await expect(page.getByLabel("التصنيف", { exact: true }).locator(`option[value="${categoryId}"]`)).toHaveCount(1);
            }
            if (path.endsWith("markets")) {
              await page.getByTestId("button-select-market-JO").click();
              await expect(page.getByTestId("form-market-configuration-JO")).toBeVisible();
              await expect(page.getByTestId(`checkbox-restricted-category-${categoryId}`)).toBeVisible();
            }
            const facts = await page.evaluate(() => {
              const named = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.labels ? [...el.labels].map((l) => l.innerText).join(" ") : "") || el.textContent || "").trim();
              const visible = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; });
              return { dir: document.documentElement.dir, dark: document.documentElement.classList.contains("dark"), overflow: document.documentElement.scrollWidth - innerWidth, unnamed: visible.filter((el) => !named(el)).map((el) => el.tagName) };
            });
            check(facts.dir === "rtl" && facts.dark === (scheme === "dark") && facts.overflow <= 0 && facts.unnamed.length === 0, `admin editor ${path} ${width}/${scheme}`, JSON.stringify(facts));
            await shot(page, `admin-${path.split("/").at(-1)}-${width}-${scheme}`);
            profiles.push({ path, width, scheme, ...facts });
          }
        }
      }
      return { categoryId, updatedCategoryLabel, planId: plan.id, priceMinor: 2_500, planEnabled: false, marketPriceVersion: "JO fixture changed; immutable order snapshot asserted by backend", disabledMarket: "KW", profiles };
    } finally { await shot(page, "audit-admin-controls").catch(() => {}); await context.close(); }
  });

} finally {
  await browser.close();
}

report.summary = { failed, consoleErrors, journeys: Object.keys(report.journeys).length, layoutCases: report.layout.length };
report.failures = failures;
await writeFile(resultPath, JSON.stringify(report, null, 2));
if (failed.length) console.error(JSON.stringify(failures, null, 2));
