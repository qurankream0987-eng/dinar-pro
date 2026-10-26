// Dev helper: screenshot routes. Usage: node test/shots.mjs <outDir> <width> <as:guest|buyer|seller> [dark] route...
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const [out, width, as, ...rest] = process.argv.slice(2);
const dark = rest[0] === 'dark'; const routes = dark ? rest.slice(1) : rest;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium' });
const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: Number(width), height: 844 }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' });
await ctx.addInitScript(() => { localStorage.setItem('bdinar-onboarded', '1'); });
const phones = { buyer: '50000000', seller: '50000005' };
if (phones[as]) { const r = await ctx.request.post('/api/auth/login', { data: { phoneCountryCode: '+965', phoneNumber: phones[as], password: 'Development-only-2026!' } }); if (!r.ok()) throw new Error(await r.text()); }
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
for (const route of routes) {
  await page.goto(route); await page.waitForTimeout(900);
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, w: innerWidth }));
  const name = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
  await page.screenshot({ path: `${out}/${name}-${width}${dark ? '-dark' : ''}.png`, fullPage: process.env.FULL === '1' });
  console.log(route, m.scroll > m.w ? `OVERFLOW ${m.scroll}` : 'ok');
}
if (errors.length) console.log('ERRORS', errors.slice(0, 8));
await browser.close();
