// Render the existing approved star-free vector; no replacement branding or UI changes.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../artifacts/dinar/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const svg = await readFile(new URL('../artifacts/dinar/public/brand/dinar-mark.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 192, height: 192 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;width:192px;height:192px;background:#041222}svg{width:192px;height:192px;display:block}</style>${svg}`);
  await page.screenshot({ path: new URL('../artifacts/dinar/public/brand/dinar-touch.png', import.meta.url).pathname });
} finally { await browser.close(); }
