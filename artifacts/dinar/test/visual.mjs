import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium' });
const baseURL = 'http://127.0.0.1:4173';
const context = await browser.newContext({ baseURL });
await context.addInitScript(() => localStorage.setItem('bdinar-onboarded', '1'));
const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
const output = '../../docs/visual-qa'; mkdirSync(output, { recursive: true });
const results = [];
async function audit(name, path, width, screenshot = false) {
  await page.setViewportSize({ width, height: 844 }); await page.goto(path); await page.waitForTimeout(450);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, broken: [...document.images].filter(i => i.complete && !i.naturalWidth).length }));
  results.push({ name, width, ...dimensions, ok: dimensions.scroll <= width && dimensions.broken === 0 });
  if (screenshot) await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
}
for (const width of [320,360,375,390,393,414,430,1440]) for (const [name,path] of [['home','/'],['search','/search'],['login','/login'],['register','/register'],['offer','/listings/KW_lst_design']]) await audit(name,path,width,width===390||width===1440);
const login = await context.request.post('/api/auth/login', { data: { phoneCountryCode: '+965', phoneNumber: '50000000', password: 'Development-only-2026!' } }); if (!login.ok()) throw new Error(await login.text());
await context.request.patch('/api/account/market', { data: { marketId: 'KW' } });
await context.request.put('/api/cart', { data: { marketId: 'KW', items: [{ listingId: 'KW_lst_design', quantity: 3 }, { listingId: 'KW_lst_lamp', quantity: 1 }] } });
const placed = await context.request.post('/api/orders', { data: { listingId: 'KW_lst_design', quantity: 1, fulfilmentType: 'DIGITAL', idempotencyKey: randomUUID() } }); const order = await placed.json();
const seller = await browser.newContext({ baseURL }); await seller.addInitScript(() => localStorage.setItem('bdinar-onboarded', '1')); await seller.request.post('/api/auth/login', { data: { phoneCountryCode: '+965', phoneNumber: '50000005', password: 'Development-only-2026!' } });
await seller.request.post(`/api/orders/${order.id}/accept`, { data: {} }); await seller.request.post(`/api/orders/${order.id}/delivery`, { data: { proofType: 'CODE', proofToken: 'ملف التسليم التجريبي' } });
for (const width of [320,360,375,390,393,414,430,1440]) for (const [name,path] of [['profile','/profile'],['settings','/settings'],['notifications','/notifications'],['seller-offers','/seller/offers'],['dues','/seller/dues'],['create','/seller/new'],['seller','/seller'],['orders','/orders'],['order-chat-delivery',`/orders/${order.id}`],['cart','/cart'],['checkout','/checkout']]) await audit(name,path,width,width===390||width===1440);
await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/settings'); await page.getByTestId('button-settings-market').click(); await page.waitForTimeout(400); const dialogBox = await page.getByRole('dialog').boundingBox(); if (!dialogBox || dialogBox.x < 0 || dialogBox.x + dialogBox.width > 390) throw new Error('Dialog clipping'); await page.screenshot({ path: `${output}/market-switcher-390.png`, fullPage: true }); await page.getByTestId('button-market-SA').click(); await page.waitForTimeout(400); await page.screenshot({ path: `${output}/market-confirmation-390.png`, fullPage: true }); await page.getByRole('button', { name: 'الانتقال للسوق' }).click(); await page.waitForTimeout(700); if ((await (await context.request.get('/api/auth/me')).json()).user.activeMarketId !== 'SA') throw new Error('Market switch failed');
await context.request.patch('/api/account/market', { data: { marketId: 'KW' } });
await page.goto(`/orders/${order.id}`); await page.getByTestId('button-open-dispute').click(); await page.getByTestId('button-dispute-next').click(); await page.getByTestId('input-dispute').fill('أحتاج مراجعة تفاصيل التسليم'); await page.getByTestId('input-dispute-evidence').fill('مرجع دليل المتصفح'); await page.getByTestId('button-dispute-next').click(); await page.screenshot({ path: `${output}/dispute-390.png`, fullPage: true }); await page.getByTestId('button-submit-dispute').click(); await page.getByTestId('panel-dispute').waitFor(); const disputeDetail = await (await context.request.get(`/api/orders/${order.id}`)).json(); if (disputeDetail.dispute?.evidence[0]?.reference !== 'مرجع دليل المتصفح') throw new Error('Dispute evidence not persisted'); results.push({name:'dispute-submission',ok:true});
await page.goto('/profile'); await page.getByRole('button', { name: 'تسجيل الخروج' }).click(); await page.waitForURL('/'); await page.goBack(); await page.waitForTimeout(500); const protectedResponse = await context.request.get('/api/orders'); if (protectedResponse.status() !== 401) throw new Error('Logout/back did not protect endpoint'); results.push({ name: 'logout-back', ok: true });
const sellerPage = await seller.newPage(); for (const width of [320,360,375,390,393,414,430,1440]) {
 await sellerPage.setViewportSize({width,height:844}); await sellerPage.goto('/seller/offers/KW_lst_design/edit'); await sellerPage.waitForTimeout(400);
 const scroll=await sellerPage.evaluate(()=>document.documentElement.scrollWidth); results.push({name:'edit',width,scroll,ok:scroll<=width});
 if(width===390||width===1440) await sellerPage.screenshot({path:`${output}/edit-${width}.png`,fullPage:true});
 await sellerPage.goto('/settings'); await sellerPage.getByTestId('button-settings-market').click(); await sellerPage.waitForTimeout(350); const box=await sellerPage.getByRole('dialog').boundingBox(); results.push({name:'market-dialog',width,ok:!!box&&box.x>=0&&box.x+box.width<=width});
}
await page.goto('/'); await page.evaluate(() => document.documentElement.classList.add('dark')); await page.waitForTimeout(1000); await page.screenshot({path:`${output}/home-dark-390.png`,fullPage:true});

await context.request.post('/api/auth/login', { data: { phoneCountryCode: '+965', phoneNumber: '50000000', password: 'Development-only-2026!' } });
await context.addInitScript(() => localStorage.setItem('dinar-theme', 'dark'));
for (const width of [320,360,375,390,393,414,430,1440]) {
  for (const [name,path] of [['home','/'],['search','/search'],['offer','/listings/KW_lst_design'],['profile','/profile'],['settings','/settings'],['notifications','/notifications'],['create','/seller/new'],['seller','/seller'],['seller-offers','/seller/offers'],['dues','/seller/dues'],['orders','/orders'],['order',`/orders/${order.id}`],['cart','/cart'],['checkout','/checkout'],['terms','/terms'],['not-found','/missing-route']])
    await audit(`${name}-dark`,path,width,width===390);
}
writeFileSync(`${output}/results.json`, JSON.stringify({ checks: results.length, failures: results.filter(r=>!r.ok), errors, results }, null, 2));
console.log(JSON.stringify({ checks: results.length, failures: results.filter(r=>!r.ok), errors }));
await browser.close();
if (results.some(r=>!r.ok) || errors.length) process.exitCode=1;
