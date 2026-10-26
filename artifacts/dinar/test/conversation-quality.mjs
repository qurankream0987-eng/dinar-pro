import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const baseURL = process.env.AI_HOME_BASE_URL ?? 'http://127.0.0.1:4175';
const output = process.env.AI_QUALITY_OUTPUT ?? '/tmp/dinar-conversation-quality';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/repl/tools/bin/chromium' });
const errors = [], checks = [];
const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const sizes = [[320,568],[360,800],[375,812],[390,844],[393,852],[414,896],[430,932],[1440,900]];
const composer = page.getByTestId('input-ai-composer');
async function ready() { await page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute('aria-label') === 'إرسال الرسالة'); }
async function turn(text) { await composer.fill(text); await page.getByTestId('button-send-ai-message').click(); await ready(); }
async function screenshot(name) { await page.waitForTimeout(250); await page.screenshot({ path: `${output}/${name}.png` }); }
async function fits(label) {
  await page.waitForFunction(() => Math.abs(parseFloat(document.documentElement.style.getPropertyValue("--ai-viewport-height")) - visualViewport.height) < 2);
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, body: document.body.scrollHeight }));
  assert.ok(size.scroll <= size.width, `${label}: horizontal overflow ${JSON.stringify(size)}`);
  const box = await page.locator('.ai-composer-box').boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= size.height, `${label}: composer obscured`);
  checks.push(label);
}
try {
  await page.goto('/'); await page.getByRole('heading', {name:'جاهز عندما تكون جاهزًا.'}).waitFor();
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => {localStorage.setItem('dinar-theme', theme); document.documentElement.classList.toggle('dark',theme === 'dark');}, theme);
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height}); await fits(`${theme} empty ${width}x${height}`); await screenshot(`${theme}-empty-${width}`);
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByTestId('button-toggle-conversation-history').click();
  const drawer = page.getByRole('dialog', { name: 'سجل المحادثات' }); await drawer.waitFor();
  for(let i=0;i<10;i++) { await page.keyboard.press('Tab'); assert.ok(await drawer.evaluate(el=>el.contains(document.activeElement)), 'drawer focus escaped'); }
  await screenshot('dark-history-390'); await page.keyboard.press('Escape');
  assert.ok(await page.getByTestId('button-toggle-conversation-history').evaluate(el=>el===document.activeElement));
  checks.push('drawer traps focus, Escape closes and returns focus');
  const searchResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/preview') && response.request().postDataJSON()?.message === 'أريد تصميم');
  await turn('أريد تصميم');
  const payload = await (await searchResponse).json();
  const ids = payload.blocks[0].payload.listings.map(item=>item.id);
  assert.ok(ids.length>1,'real search needs multiple existing listings');
  const result = page.locator('[data-testid^="message-assistant-"]').last();
  const rendered = await result.locator('[data-testid^="card-ai-result-"]').evaluateAll(elements=>elements.map(el=>el.dataset.testid.replace('card-ai-result-','')));
  assert.deepEqual(rendered,ids,'visual result order differs from API order');
  const first = await result.locator('[data-testid^="card-ai-result-"]').nth(0).boundingBox();
  const second = await result.locator('[data-testid^="card-ai-result-"]').nth(1).boundingBox();
  assert.ok(first.x>second.x,'RTL carousel first result should start on the right');
  checks.push('real carousel order matches runtime references and RTL starts on right');
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
    for(const [width,height] of sizes) {await page.setViewportSize({width,height});await fits(`${theme} carousel ${width}x${height}`);await screenshot(`${theme}-results-${width}`);}
  }
  await page.setViewportSize({width:390,height:844});
  await page.reload(); await page.getByRole('log').waitFor();
  assert.ok(await page.getByText('أريد تصميم',{exact:true}).count());
  const filterResponse = page.waitForResponse(response=>response.url().endsWith('/api/ai/preview') && response.request().postDataJSON()?.message==='بدينار فقط');
  await turn('بدينار فقط');
  assert.equal((await filterResponse).request().postDataJSON().query,payload.query);
  checks.push('guest refresh restores messages and contextual query');
  await page.getByTestId('button-new-conversation-header').click();
  await turn('أريد تيشيرت'); await turn('الأسود فقط'); await turn('بدينار فقط'); await turn('الثاني');
  checks.push('requested shirt/filter/reference sequence executed against real data');
  await screenshot('requested-search-sequence-390');
  await context.setOffline(true);
  await composer.fill('رسالة محفوظة بلا اتصال');
  assert.equal(await page.getByTestId('button-send-ai-message').isDisabled(),true);
  await page.getByText('أنت غير متصل. ستبقى رسالتك هنا حتى يعود الاتصال.').waitFor();
  await context.setOffline(false); assert.equal(await composer.inputValue(),'رسالة محفوظة بلا اتصال');
  checks.push('offline send disabled and draft survives reconnect');
  await page.getByTestId('button-new-conversation-header').click();
  await page.route('**/api/ai/preview',route=>route.abort('failed'));
  await turn('أريد تيشيرت'); await page.getByTestId('button-retry-ai-turn').waitFor();
  assert.equal(await composer.inputValue(),'أريد تيشيرت');
  await page.unroute('**/api/ai/preview');
  await page.getByTestId('button-retry-ai-turn').click(); await ready();
  assert.equal(await page.getByText('أريد تيشيرت',{exact:true}).count(),1);
  checks.push('real transport failure retains draft and explicit retry avoids duplicate local messages');
  await page.getByTestId('button-new-conversation-header').click();
  // Text-only restored-history fixture exercises long dynamic-height chat without fabricated commerce.
  await page.evaluate(() => {
    const messages=Array.from({length:90},(_,index)=>({id:`long-${index}`,role:index%2?'ASSISTANT':'USER',body:index%2?'هذه إجابة عربية طويلة توضّح الخيارات المتاحة وتترك القرار لك. '.repeat(5):`السؤال ${index} عن DINAR، السعر KWD 1.000، والرابط https://example.com/${'long'.repeat(15)}`,createdAt:new Date().toISOString(),blocks:[]}));
    sessionStorage.setItem('dinar-guest-handoff',JSON.stringify({marketId:'KW',messages,context:{}}));
  });
  await page.reload(); await page.getByRole('log').waitFor();
  assert.equal(await page.locator('[data-testid^="message-"]').count(),40);
  const thread=page.getByTestId('conversation-thread');
  await thread.evaluate(el=>{el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-100}));el.scrollTop=300});await page.waitForTimeout(100);
  await page.getByTestId('button-return-to-latest').waitFor();
  const before=await thread.evaluate(el=>el.scrollTop);
  await composer.fill('مسودة أثناء قراءة الرسائل');
  assert.ok(Math.abs(await thread.evaluate(el=>el.scrollTop)-before)<5,'typing moved reading position');
  await thread.evaluate(el=>el.scrollTop=0); await page.getByTestId('button-load-older-messages').click();
  assert.equal(await page.locator('[data-testid^="message-"]').count(),80);
  assert.ok(await thread.evaluate(el=>el.scrollTop)>0,'loading older messages lost anchor');
  await page.getByTestId('button-return-to-latest').click(); await page.waitForTimeout(500);
  assert.ok(await thread.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)<96);
  checks.push('long history loads incrementally, preserves anchor, typing leaves reader position, jump returns to bottom');
  await composer.fill('سطر عربي طويل مع English 123\n'.repeat(12));
  assert.ok(await composer.evaluate(el=>el.scrollHeight>el.clientHeight && el.clientHeight<=176));
  await composer.focus();
  await page.setViewportSize({width:390,height:480});
  await fits('focused keyboard-sized viewport 390x480'); await screenshot('keyboard-sized-390');
  checks.push('multiline composer caps height and internally scrolls');
  await page.setViewportSize({width:390,height:844});await screenshot('long-conversation-390');
  // The same domain engines provide inline auth and checkout; never confirm or pay.
  await page.getByTestId('button-new-conversation-header').click();await turn('سجلني دخول');
  for(const [width,height] of sizes.slice(0,7)){await page.setViewportSize({width,height});await fits(`auth ${width}x${height}`);await screenshot(`auth-${width}`);}
  await page.locator('input[name="phoneNumber"]').last().fill('50000000');await page.locator('input[name="password"]').last().fill('Development-only-2026!');await page.getByRole('button',{name:'تسجيل الدخول',exact:true}).last().click();
  await page.waitForFunction(()=>!document.querySelector('input[name="password"]'));
  const originalCart=await (await context.request.get('/api/cart')).json();
  await page.getByTestId('button-new-conversation-header').click(); await turn('كمل الطلب');
  assert.deepEqual(await (await context.request.get('/api/cart')).json(),originalCart,'new chat modified cart');
  for(const [width,height] of sizes.slice(0,7)){await page.setViewportSize({width,height});await fits(`checkout ${width}x${height}`);await screenshot(`checkout-${width}`);}
  checks.push('new chat preserves engine cart; checkout surfaces inspected without confirming');
  assert.deepEqual(errors,[]);
} finally {
  writeFileSync(`${output}/checks.json`,JSON.stringify({checks,errors,physicalKeyboard:'Not tested: focused viewport resizing is a browser simulation.'},null,2));
  console.log(JSON.stringify({checks,errors},null,2));await browser.close();
}
