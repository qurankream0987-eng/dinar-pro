// JassimAI Phase 1 — browser acceptance for tables and charts. Builds the harness with esbuild
// (real components, the app's built CSS), serves it from a loopback HTTP server, and checks the
// four viewport classes, sorting, keyboard use, reduced motion, data fidelity and invalid input.
// Prerequisite: `pnpm --filter @workspace/dinar run build` (the stylesheet comes from dist).
// Usage: node test/phase1-intelligent-ui.mjs [screenshotDir]
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// esbuild is not a dependency of the web app: use the copy Vite already ships with.
const viteRequire = createRequire(createRequire(import.meta.url).resolve("vite"));
const { build } = viteRequire("esbuild");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const assets = path.join(root, "dist/public/assets");
const css = readdirSync(assets).filter((name) => name.endsWith(".css")).map((name) => readFileSync(path.join(assets, name), "utf8")).join("\n");
if (!css.includes("ds-table")) throw new Error("dist stylesheet predates Phase 1: run the web build first");
const bundle = await build({
  entryPoints: [path.join(root, "test/phase1-ui-harness.tsx")], bundle: true, write: false, format: "esm", splitting: true,
  outdir: "/h", tsconfig: path.join(root, "tsconfig.json"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
});
const files = new Map(bundle.outputFiles.map((file) => [path.basename(file.path), file.contents]));
const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/phase1-ui-harness.js"></script></body></html>`;
const server = createServer((request, response) => {
  const name = path.basename(request.url ?? "/");
  if (files.has(name)) { response.writeHead(200, { "content-type": "text/javascript" }); return response.end(files.get(name)); }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const record = (id, name, status, detail = "") => { results.push({ id, name, status, detail }); console.log(`${status.padEnd(6)} ${id} ${name}${detail ? ` — ${detail}` : ""}`); };
async function check(id, name, body) {
  try { await body(); record(id, name, "PASS"); } catch (error) { record(id, name, "FAIL", String(error?.message ?? error).slice(0, 300)); }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
async function open(width, height, options = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ...options });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(url);
  await page.waitForSelector("[data-testid=ds-series-line] svg .recharts-line-curve", { timeout: 15_000 });
  await page.waitForSelector("[data-testid=ds-series-donut] svg .recharts-pie-sector", { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ds-series-donut] svg .recharts-pie-sector").length >= 6, null, { timeout: 15_000 });
  // Recharts adds the dots when the draw-in animation ends (immediately under reduced motion).
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ds-series-line] .recharts-line-dots").length >= 2, null, { timeout: 15_000 });
  return page;
}

for (const [id, width, height] of [["F31", 320, 720], ["F32", 390, 844], ["F33", 768, 1024], ["F34", 1440, 900]]) {
  await check(id, `viewport ${width}px: no page overflow, charts drawn, tables scroll inside their region`, async () => {
    const page = await open(width, height);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `page overflows by ${overflow}px`);
    for (const region of await page.locator(".ds-table-scroll").all()) {
      const box = await region.boundingBox();
      assert(box && box.x >= -1 && box.x + box.width <= width + 1, "a table region leaves the viewport");
    }
    const tip = await page.locator("[data-testid=ds-series-line] .ds-series-canvas").first().boundingBox();
    assert(tip && tip.width <= width, "chart wider than the viewport");
    if (shots) await page.screenshot({ path: path.join(shots, `phase1-${width}.png`), fullPage: true });
    await page.close();
  });
}

const page = await open(390, 844);

await check("A1", "a time series renders as a line with one point per given value", async () => {
  const dots = await page.locator("[data-testid=answer-line] .recharts-line-dots circle").count();
  assert(dots === 4, `expected 4 dots, got ${dots}`);
});
await check("A2", "category shares render as a donut with one sector per part and a legend", async () => {
  assert(await page.locator("[data-testid=answer-donut] .recharts-pie-sector").count() === 3, "sector count");
  assert(await page.locator("[data-testid=answer-donut] .ds-legend li").count() === 3, "legend count");
});
await check("A8/A6", "the figures table equals the source payload exactly, including zero and negative", async () => {
  const cells = await page.locator("[data-testid=answer-line] [data-testid=ds-series-table] td").allTextContents();
  assert(JSON.stringify(cells) === JSON.stringify(["2,310 USD", "-15 USD", "0 USD", "2,405.75 USD"]), JSON.stringify(cells));
});
await check("D-INSIGHTS", "the insights card shows the server's monthly series and table, with source and period", async () => {
  const card = page.locator("[data-testid=business-insights]");
  assert(await card.locator("[data-testid=ds-series-line] .recharts-line-dots circle").count() === 6, "six recorded months");
  const revenue = await card.locator("[data-testid=ds-table] tbody td[data-kind=MONEY]").allInnerTexts();
  assert(JSON.stringify(revenue) === JSON.stringify(["95.000 JOD", "0.000 JOD", "210.250 JOD", "180.000 JOD", "402.750 JOD", "346.500 JOD"]), JSON.stringify(revenue));
  assert((await card.innerText()).includes("حسب شهر الطلب"), "source shown");
  const ticks = await card.locator(".recharts-yAxis .recharts-cartesian-axis-tick-value").allTextContents();
  assert(ticks.length && ticks.every((tick) => !/K|M/.test(tick)) && Math.max(...ticks.map(Number)) <= 1000, `axis is not in JOD: ${ticks}`);
});
await check("B10", "a missing comparison value reads «غير متوفر», never zero", async () => {
  const missing = await page.locator("[data-testid=answer-table] .ds-table-missing").allInnerTexts();
  assert(missing.length === 2 && missing.every((text) => text === "غير متوفر"), JSON.stringify(missing));
});
await check("B11", "sorting reorders rows and never changes a value", async () => {
  const card = page.locator("[data-testid=business-insights]");
  const before = (await card.locator("[data-testid=ds-table] tbody tr").allInnerTexts()).sort();
  await card.locator("[data-testid=ds-sort-revenue]").click();
  const asc = await card.locator("[data-testid=ds-table] tbody td[data-kind=MONEY]").allInnerTexts();
  assert(asc[0] === "0.000 JOD" && asc.at(-1) === "402.750 JOD", JSON.stringify(asc));
  await card.locator("[data-testid=ds-sort-revenue]").click();
  const desc = await card.locator("[data-testid=ds-table] tbody td[data-kind=MONEY]").allInnerTexts();
  assert(desc[0] === "402.750 JOD", JSON.stringify(desc));
  const after = (await card.locator("[data-testid=ds-table] tbody tr").allInnerTexts()).sort();
  assert(JSON.stringify(before) === JSON.stringify(after), "values changed while sorting");
  assert(await card.locator("th[aria-sort=descending]").count() === 1, "aria-sort reflects the order");
});
await check("B12", "mixed Arabic/English text keeps its own direction; amounts are isolated LTR", async () => {
  const dir = await page.locator("[data-testid=answer-table] tbody th span[dir=auto]").first().evaluate((node) => getComputedStyle(node).direction);
  assert(dir === "ltr", `Latin product name direction ${dir}`);
  const ar = await page.locator("[data-testid=answer-table] tbody tr").nth(1).locator("th span[dir=auto]").evaluate((node) => getComputedStyle(node).direction);
  assert(ar === "rtl", `Arabic product name direction ${ar}`);
});
await check("B13", "an 8-column table scrolls inside its own region on a phone", async () => {
  const region = page.locator("[data-testid=answer-table] .ds-table-scroll");
  const [scroll, client] = await region.evaluate((node) => [node.scrollWidth, node.clientWidth]);
  assert(scroll > client, "expected horizontal scrolling inside the region");
});
await check("F35", "keyboard: the table region and sort buttons are reachable and Enter sorts", async () => {
  const card = page.locator("[data-testid=business-insights]");
  await card.locator("[data-testid=ds-sort-orders]").focus();
  await page.keyboard.press("Enter");
  assert(await card.locator("th[aria-sort=ascending]").count() === 1, "Enter did not sort");
  assert(await page.locator(".ds-table-scroll").first().getAttribute("tabindex") === "0", "scroll region not focusable");
});
await check("F36", "accessible structure: captions, scoped headers, figure labels and a figures table for every chart", async () => {
  assert(await page.locator(".ds-table caption").count() >= 3, "captions");
  assert(await page.locator(".ds-table thead th[scope=col]").count() >= 3, "column headers");
  assert(await page.locator(".ds-table tbody th[scope=row]").count() >= 6, "row headers");
  for (const chart of await page.locator(".ds-series").all()) {
    assert((await chart.getAttribute("aria-label"))?.length > 5, "chart summary");
    assert(await chart.locator("[data-testid=ds-series-table]").count() === 1, "figures table");
    assert(await chart.locator(".ds-series-canvas").getAttribute("aria-hidden") === "true", "drawing hidden from AT");
  }
});
await check("D19/D20", "an unknown section or malformed card fails safely and executes nothing", async () => {
  assert(await page.locator("[data-testid=composed-surface-invalid]").count() === 1, "invalid surface notice");
  assert(await page.locator("[data-testid=h-invalid] .answer-card-pending").count() === 1, "malformed card placeholder");
  assert(await page.evaluate(() => window.__pwned) === undefined, "script executed");
  assert(await page.locator("script:not([src])").count() === 0, "inline script injected");
});
await check("C16", "charts and tables render no action controls", async () => {
  assert(await page.locator(".ds-series button, .ds-table td button, .ds-table tbody th button").count() === 0, "action inside data");
});
await check("P2-LISTINGS", "the model-chosen table of listings shows the live records: a negotiable price is not zero, a missing condition is unavailable", async () => {
  const table = page.locator("[data-testid=h-p2-listings] [data-testid=ds-table]");
  assert(await table.locator("tbody tr").count() === 3, "three rows");
  const prices = await table.locator("tbody td[data-kind=MONEY]").allInnerTexts();
  assert(JSON.stringify(prices) === JSON.stringify(["520.000 JOD", "بالاتفاق", "149.990 JOD"]), JSON.stringify(prices));
  assert((await table.locator("tbody tr").nth(2).innerText()).includes("غير متوفر"), "missing condition");
  assert(await page.locator("[data-testid=h-p2-listings] button:not(.ds-table-sort)").count() === 0, "no action in the table");
});
await check("P2-BUSINESS", "the server-composed business display renders: totals, monthly line, exact table and the not-profit note", async () => {
  const card = page.locator("[data-testid=h-p2-business] [data-testid=model-display]");
  assert(await card.locator(".ds-metric").count() === 2, "two totals");
  assert(await card.locator("[data-testid=ds-series-line] .recharts-line-dots circle").count() === 6, "six months");
  assert((await card.innerText()).includes("وليست ربحًا"), "revenue is not profit");
  const donut = page.locator("[data-testid=h-p2-donut] [data-testid=ds-series-donut]");
  assert(await donut.locator(".recharts-pie-sector").count() === 3, "three category shares");
  const shares = (await donut.locator(".ds-legend li").allInnerTexts()).map((text) => text.match(/(\d+\.\d)%/u)?.[1]);
  assert(JSON.stringify(shares) === JSON.stringify(["72.9", "20.3", "6.8"]), JSON.stringify(shares));
});
await check("P3-ACTIONS", "suggested next steps: few, labelled, keyboard-usable, touch-sized, and they only send an utterance", async () => {
  const actions = page.locator("[data-testid=h-p2-business] [data-testid^=display-next-]");
  assert(await actions.count() === 3, "three next steps");
  for (const button of await actions.all()) {
    const box = await button.boundingBox();
    assert(box && box.height >= 32, `touch target ${box?.height}`);
  }
  await page.locator("[data-testid=display-next-max]").focus();
  await page.keyboard.press("Enter");
  const sent = await page.evaluate(() => window.__sent ?? []);
  assert(JSON.stringify(sent) === JSON.stringify(["أي شهر كان الأعلى؟"]), JSON.stringify(sent));
});
await page.close();

await check("F37", "reduced motion: charts draw without animation", async () => {
  const reduced = await open(390, 844, { reducedMotion: "reduce" });
  const animated = await reduced.locator("[data-testid=answer-line] .recharts-line-curve").evaluate((node) => node.getAttribute("stroke-dasharray"));
  assert(!animated || !animated.includes(" 0px"), `line is mid-animation (${animated})`);
  await reduced.close();
});
await check("F38", "loading and console: no page errors while charts load lazily", async () => {
  assert(errors.length === 0, errors.join(" | ").slice(0, 300));
});

await browser.close();
server.close();
const failed = results.filter((result) => result.status !== "PASS");
console.log(`PHASE1_UI_SUMMARY ${JSON.stringify({ pass: results.length - failed.length, fail: failed.length, total: results.length })}`);
process.exit(failed.length ? 1 : 0);
