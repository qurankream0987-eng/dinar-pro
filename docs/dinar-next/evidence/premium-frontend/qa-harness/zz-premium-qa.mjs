import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const { CS_WEB_BASE: webBase, CS_API_ORIGIN: apiOrigin, CS_COOKIE: cookie, SHOTS: dir, CS_RESULT_PATH: out, FONT_DIR: fontDir, AXE: axePath } = process.env;
const fontFiles = Object.fromEntries(readdirSync(fontDir).filter((f) => f.endsWith(".woff2")).map((f) => [f, readFileSync(`${fontDir}/${f}`)]));
const fontCss = readFileSync(`${fontDir}/plex.css`, "utf8").replace(/https:\/\/fonts\.gstatic\.com\/([^)]+)/g, (_, p) => `https://fonts.gstatic.com/${p}`);
const axe = readFileSync(axePath, "utf8");
const R = { shots: [], checks: [], metrics: {}, failures: [], overflow: [], pageErrors: [], axe: {} };
const ok = (c, m) => { if (c) R.checks.push(m); else R.failures.push(m); };
const browser = await chromium.launch({ headless: true, executablePath: process.env.AUDIT_CHROMIUM, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
async function open(width, height, theme, { reduced = false, auth = true } = {}) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width, height }, deviceScaleFactor: 2, isMobile: width < 768, hasTouch: width < 768, locale: "ar", reducedMotion: reduced ? "reduce" : "no-preference" });
  if (auth) { const i = cookie.indexOf("="); await context.addCookies([{ name: cookie.slice(0, i), value: cookie.slice(i + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]); }
  await context.addInitScript((t) => localStorage.setItem("dinar-theme", t), theme);
  await context.grantPermissions(["camera"], { origin: webBase });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: fontCss, headers: { "access-control-allow-origin": "*" } });
    if (url.hostname === "fonts.gstatic.com") { const f = url.pathname.slice(1).replace(/\//g, "_"); return fontFiles[f] ? route.fulfill({ status: 200, contentType: "font/woff2", body: fontFiles[f], headers: { "access-control-allow-origin": "*" } }) : route.abort(); }
    if (url.pathname.startsWith("/api/") && url.host === new URL(webBase).host) {
      const headers = await route.request().allHeaders();
      for (const h of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[h];
      headers.origin = apiOrigin; headers.referer = `${apiOrigin}/`;
      return route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => R.pageErrors.push(`${width}-${theme}: ${e.message}`));
  return { context, page };
}
const settle = (page) => page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
const shot = async (page, name) => { await settle(page); await page.waitForTimeout(350); await page.screenshot({ path: `${dir}/${name}.png` }); R.shots.push(name); };
const overflow = async (page, name) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (o > 0) R.overflow.push(`${name}:${o}`); };
const plex = (page) => page.evaluate(() => document.fonts.check('16px "IBM Plex Sans Arabic"', "دينار"));
const runAxe = async (page, name) => {
  await page.addScriptTag({ content: axe });
  const res = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") })); });
  R.axe[name] = res;
};
const send = async (page, text) => {
  const before = await page.locator('[data-testid^="message-assistant-"]').count();
  await page.getByRole("textbox", { name: "رسالتك إلى DINAR AI" }).fill(text);
  await page.getByRole("button", { name: "إرسال الرسالة" }).click();
  await page.waitForFunction((c) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > c && !document.querySelector('[aria-busy="true"][data-testid="button-send-ai-message"]'), before, { timeout: 60_000 });
};
const flights = (page) => page.evaluate(() => window.__flights ?? []);
const probe = (page) => page.evaluate(() => { window.__flights = []; for (const n of ["dinar:cart-flight-start", "dinar:cart-flight-end", "dinar:cart-flight-skipped"]) document.addEventListener(n, (e) => window.__flights.push({ n, d: e.detail })); });
const serverCart = async () => { const r = await fetch(`${apiOrigin}/api/cart`, { headers: { cookie, origin: apiOrigin } }); const j = await r.json(); return (Array.isArray(j) ? j : j.items ?? []).reduce((s, i) => s + (i.quantity ?? 0), 0); };

try {
  // 1. Brand points + font + matrix
  for (const theme of ["light", "dark"]) for (const [w, h] of [[320, 640], [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900]]) {
    const { context, page } = await open(w, h, theme);
    await page.goto("/"); await page.getByTestId("button-ai-camera").waitFor({ timeout: 45_000 });
    if (w === 390 && theme === "light") ok(await plex(page), "IBM Plex Sans Arabic is the loaded chat font");
    await page.waitForFunction(() => [...document.querySelectorAll('img[src*="brand/dinar-mark.svg"]')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10_000 }).catch(() => {});
    const marks = await page.evaluate(() => [...document.querySelectorAll('img[src*="brand/dinar-mark.svg"]')].filter((i) => i.getBoundingClientRect().width > 0 && i.complete && i.naturalWidth > 0).length);
    ok(marks >= 1, `${theme}-${w}: the DINAR AI mark is visible and loaded (${marks})`);
    await shot(page, `chat-${theme}-${w}`); await overflow(page, `chat-${theme}-${w}`);
    R.metrics[`composer-${theme}-${w}`] = await page.evaluate(() => { const r = document.querySelector('[data-testid="input-ai-composer"]').getBoundingClientRect(); return Math.round(r.width); });
    await send(page, "ابحث عن ايفون"); await page.locator('[data-testid^="card-ai-result-"]').first().waitFor({ timeout: 30_000 });
    await shot(page, `results-${theme}-${w}`); await overflow(page, `results-${theme}-${w}`);
    await context.close();
  }
  { // wordmark, favicon, account and login, AppShell
    const { context, page } = await open(1280, 800, "light");
    await page.goto("/"); await page.getByTestId("button-ai-camera").waitFor({ timeout: 45_000 });
    ok((await page.locator(".ai-sidebar-wordmark").innerText()).replace(/\s+/g, " ").trim() === "DINAR AI", "sidebar wordmark reads DINAR AI");
    ok(await page.title() === "DINAR AI — دينار", "page title is DINAR AI — دينار");
    const icon = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"));
    const iconRes = await page.request.get(new URL(icon, webBase).href);
    ok(iconRes.ok() && (await iconRes.text()).includes("DINAR AI"), "favicon is the small DINAR AI icon and is served");
    await page.goto("/account"); await settle(page); await page.waitForTimeout(800); await shot(page, "account-light-1280");
    await page.goto("/cart"); await settle(page); await page.waitForTimeout(800); await shot(page, "cart-page-light-1280");
    ok(await page.locator('img[src*="brand/dinar-mark.svg"]').count() >= 1, "app shell pages show the DINAR AI mark");
    await context.close();
    for (const [w, t] of [[390, "light"], [1280, "dark"]]) {
      const guest = await open(w, w < 768 ? 844 : 800, t, { auth: false });
      await guest.page.goto("/login"); await settle(guest.page); await guest.page.waitForTimeout(800);
      await shot(guest.page, `login-${t}-${w}`); await overflow(guest.page, `login-${t}-${w}`);
      ok(await guest.page.locator('img[src*="brand/dinar-mark.svg"]').count() >= 1, `login ${w}: DINAR AI mark present`);
      if (w === 390) await runAxe(guest.page, "login-390");
      await guest.context.close();
    }
  }
  // 2. Camera + composer at phone widths, focus trap/return, reduced motion
  for (const w of [320, 375, 390, 430]) {
    const { context, page } = await open(w, w === 320 ? 640 : 844, "light");
    await page.goto("/"); await page.getByTestId("button-ai-camera").waitFor({ timeout: 45_000 });
    await page.getByRole("textbox", { name: "رسالتك إلى DINAR AI" }).fill("أبحث عن هاتف ايفون بحالة ممتازة وسعر مناسب في عمّان مع شاحن أصلي");
    const box = await page.evaluate(() => { const t = document.querySelector('[data-testid="input-ai-composer"]').getBoundingClientRect(); const s = document.querySelector('[data-testid="button-send-ai-message"]').getBoundingClientRect(); const c = document.querySelector('[data-testid="button-ai-camera"]').getBoundingClientRect(); return { tw: t.width, overlap: !(t.bottom <= s.top || t.top >= s.bottom), sendW: s.width, camW: c.width }; });
    ok(box.tw >= w - 70 && !box.overlap && box.sendW >= 44 && box.camW >= 44, `${w}: composer text ${Math.round(box.tw)}px on its own row; 44px controls; no overlap`);
    await shot(page, `composer-${w}`);
    await page.getByTestId("button-ai-camera").click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="camera-video"]')?.videoWidth ?? 0) > 0, null, { timeout: 20_000 });
    for (let k = 0; k < 9; k++) await page.keyboard.press("Tab");
    ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="camera-capture"]'))), `${w}: Tab stays inside the camera dialog`);
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab");
    ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="camera-capture"]'))), `${w}: Shift+Tab stays inside the camera dialog`);
    await shot(page, `camera-${w}`); await overflow(page, `camera-${w}`);
    if (w === 390) await runAxe(page, "camera-390");
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "button-ai-camera", `${w}: Escape returns focus to the camera button`);
    ok(await page.evaluate(() => { const v = document.querySelector('[data-testid="camera-video"]'); return !v; }), `${w}: camera dialog unmounted after Escape`);
    await context.close();
  }
  { const { context, page } = await open(390, 844, "light", { reduced: true });
    await page.goto("/"); await page.getByTestId("button-ai-camera").waitFor({ timeout: 45_000 }); await page.getByTestId("button-ai-camera").click();
    await page.locator(".dinar-camera-sheet").waitFor({ timeout: 20_000 });
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".dinar-camera-sheet")).animationName);
    ok(anim === "none", "reduced motion: the camera sheet does not animate");
    await page.keyboard.press("Escape");
    await probe(page); await send(page, "ابحث عن ايفون");
    const card = await page.evaluate(() => getComputedStyle(document.querySelector(".ai-result-item")).animationName);
    ok(card === "none", "reduced motion: result cards appear without entrance motion");
    await context.close(); }
  // 3. Cart motion, repeated, failure, duplicate
  { const { context, page } = await open(390, 844, "light");
    await page.goto("/"); await page.getByTestId("button-ai-camera").waitFor({ timeout: 45_000 });
    await probe(page);
    const startCart = await serverCart();
    let confirmed = 0;
    for (const q of ["ابحث عن ايفون", "ابحث عن مصباح طاولة", "ابحث عن تي شيرت"]) {
      await send(page, q);
      const add = page.locator('[data-testid^="button-add-to-cart-"]:not([disabled])').last();
      if (!(await add.count())) { R.failures.push(`no addable card for ${q}`); continue; }
      const before = (await flights(page)).filter((f) => f.n !== "dinar:cart-flight-start").length;
      await add.click();
      const settled = await page.waitForFunction((b) => window.__flights.filter((f) => f.n !== "dinar:cart-flight-start").length > b, before, { timeout: 12_000 }).then(() => true, () => false);
      const alertText = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
      R.metrics[`add-${q}`] = { settled, flights: (await flights(page)).slice(-2), alert: alertText.join(" | ").slice(0, 200), cart: await serverCart() };
      if (!settled) continue;
      confirmed++;
      ok(await page.locator(".dinar-basket-catch").count() >= 0, "catch class toggled");
    }
    const f = await flights(page);
    const starts = f.filter((x) => x.n === "dinar:cart-flight-start").length, ends = f.filter((x) => x.n === "dinar:cart-flight-end").length, skips = f.filter((x) => x.n === "dinar:cart-flight-skipped").length;
    R.metrics.repeated = { confirmed, starts, ends, skips };
    ok(starts + skips === confirmed && ends === starts, `repeated adds: ${confirmed} confirmed adds -> ${starts} flights (all ended) + ${skips} image-less acknowledgements`);
    ok((await serverCart()) === startCart + confirmed, `server cart grew by exactly ${confirmed}`);
    ok(await page.getByTestId("cart-flight").count() === 0, "no flight clone left in the DOM");
    // failure: the server refuses
    await page.route("**/actions/add-to-cart", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "x" }) }));
    await send(page, "ابحث عن ايفون");
    const n0 = (await flights(page)).length; const c0 = await serverCart();
    await page.locator('[data-testid^="button-add-to-cart-"]').last().click();
    await page.waitForTimeout(1200);
    ok((await flights(page)).length === n0, "a failed add shows no flight and no skip");
    ok((await serverCart()) === c0, "a failed add leaves the server cart unchanged");
    await page.unroute("**/actions/add-to-cart");
    // duplicate: double activation produces at most one flight
    await send(page, "ابحث عن مصباح طاولة");
    const n1 = (await flights(page)).filter((x) => x.n === "dinar:cart-flight-start").length;
    const dup = page.locator('[data-testid^="button-add-to-cart-"]').last();
    await dup.dblclick();
    await page.waitForTimeout(1500);
    ok((await flights(page)).filter((x) => x.n === "dinar:cart-flight-start").length - n1 <= 1, "a double activation yields at most one flight");
    R.metrics.cartNotice = await page.getByTestId("cart-confirmation-status").innerText();
    await runAxe(page, "chat-results-390");
    await context.close(); }
  { const { context, page } = await open(1280, 800, "dark");
    await page.goto("/"); await page.getByTestId("button-ai-camera").waitFor({ timeout: 45_000 });
    await send(page, "ابحث عن ايفون");
    await runAxe(page, "chat-results-dark-1280");
    await context.close(); }
} catch (e) { R.failures.push("ERROR " + (e?.stack ?? e)); }
writeFileSync(out, JSON.stringify(R));
await browser.close();
