import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Presentation/interaction contract tests. All API responses are local fixtures;
// this does not claim to validate server business authority or real payments.
const output = process.env.PREMIUM_UI_OUTPUT ?? '/tmp/dinar-frontend-closure';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL: process.env.PREMIUM_UI_BASE ?? 'http://127.0.0.1:4173', viewport: { width: 1440, height: 900 } });
const errors = [], consoleErrors = [], expectedConsoleErrors = [], checks = [], turns = [];
const market = { id: 'KW', status: 'ACTIVE', isActive: true, priceConfigured: true, countryNameEn: 'Kuwait', countryNameAr: 'الكويت', countryCode: 'KW', currencyCode: 'KWD', currencySymbolAr: 'د.ك', unitPriceMinor: 1000, minorUnitScale: 3, fulfilmentMethods: ['PICKUP'], paymentMethods: ['CASH'], restrictedCategories: [], sellerEligibilityMode: 'OPEN' };
const surface = (name, extra) => ({ type: 'SURFACE', version: 1, payload: { resultSetId: `fixture-${name}`, listings: [], surface: name, ...extra } });
let blocks = [], delay = 0, fixtureUser = null, fixtureMessages = [], previewFailure = false, keyRequests = 0;
let privacyExports = [], privacyExportFailure = false;
let orderFixtures = [], orderFailure = false, orderDelay = 0, fareFixture, commissionFixture, apiFailure = false, trackingFixture = {orderId:'order-ui',orderStatus:'PENDING',delivery:null,tracking:{state:'UNAVAILABLE',reason:'NO_PROVIDER'},progress:[{type:'PICKED_UP',occurredAt:'2026-10-14T10:00:00.000Z',actorRole:'COURIER'}]};
const memory = (view='MY_INTERESTS', groups=[{label:'تفضيلات صرحت بها',items:[{topic:'camping',label:'التخييم',reason:'قلت إنك تفضله'}]},{label:'اهتمامات متكررة',items:[{topic:'engineering',label:'الهندسة',reason:'تكررت في محادثاتك ويمكنك تصحيحها'}]},{label:'أشياء لا تفضلها',items:[{topic:'football',label:'كرة القدم',reason:'طلبت عدم اقتراحها'}]}]) => surface(view,{memory:{view,groups}});
const commerce = (view, fields={}) => surface(view,{commerce:{view,paymentMode:'TEST_NO_TRANSFER',autoRenew:false,...fields}});
const balance = {availableLabel:'25.00 USD',promoLabel:'0.00 USD',reservedLabel:'5.00 USD',spentLabel:'2.00 USD',statement:'رصيد لخدمات جاسم التجارية فقط؛ لا يمكن سحبه أو تحويله.'};
const product = (name,priceLabel,durationDays,productTypeLabel=name) => ({name,priceLabel,durationDays,productTypeLabel,currencyCode:'USD',bundleItems:[]});
const summary = {id:'fixture-conversation',title:'محادثة اختبار',marketId:'KW',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const listings = ['listing-first','listing-second'].map((id,index)=>({id,title:index?'Samsung S24 سامسونج':'iPhone 15 آيفون',description:'عرض تجريبي للواجهة فقط',category:'إلكترونيات',categoryId:'electronics',attributes:{},price:'100',unitPrice:'100',currencyCode:'KWD',currency:'KWD',sellerName:'بائع تجريبي',pricingMode:'FIXED',status:'PUBLISHED',fulfilmentType:'PICKUP',inventoryMode:'LIMITED',availableQuantity:2,reservedQuantity:0,condition:'USED',imageUrl:null,seller:{id:'fixture-user',displayName:'بائع تجريبي',avatarObjectPath:null},sellerId:'fixture-user',city:'الكويت',area:'السالمية',isSponsored:false,reviewCount:0,rating:0}));
await context.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  let body;
  if (path === '/api/auth/me') body = { user: fixtureUser };
  else if (path === '/api/markets') body = [market];
  else if (path === '/api/policies') body = {policies:[],fees:{commissionRateBps:100,payer:'SELLER',buyerFeeBps:0}};
  else if (path === '/api/ai/conversations') body = [summary];
  else if (path === '/api/ai/conversations/fixture-conversation') body = {...summary,messages:fixtureMessages};
  else if (path === '/api/orders') { if (orderDelay) await new Promise(resolve=>setTimeout(resolve,orderDelay)); if (orderFailure) { await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'SQL migration fixture failure'})}); return; } body = orderFixtures; }
  else if (path.endsWith('/tracking') || path.endsWith('/courier-fare') || path === '/api/courier/commission-account') {
    if(apiFailure) {await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'SQL migration failure API key sk-fixture-secret'})});return;}
    body = path.endsWith('/tracking') ? trackingFixture : path.endsWith('/courier-fare') ? fareFixture : commissionFixture;
  }
  else if (path === '/api/orders/order-ui') body = orderFixtures[0];
  else if (path === '/api/listings') body = listings;
  else if (path.startsWith('/api/listings/')) body = listings.find(item=>item.id===path.split('/').at(-1));
  else if (path === '/api/ai/preview') {
    turns.push(route.request().postDataJSON());
    if (previewFailure) {
      await route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:'fixture_unavailable'})});
      return;
    }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    body = { body: 'هذه استجابة اختبار لواجهة دينار. راجع التفاصيل قبل التأكيد.', blocks };
  } else if (path === '/api/account/privacy/exports') {
    privacyExports.push(route.request().postDataJSON());
    if (privacyExportFailure) { await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'كلمة المرور غير صحيحة',code:'REAUTHENTICATION_FAILED'})}); return; }
    body = { requestId: 'privacy-fixture-request-0001', export: { account: { displayName: 'مستخدم الواجهة' }, withheld: ['deviceCoordinates'] } };
  } else if (path.endsWith('/credentials')) {
    keyRequests++; await new Promise(resolve=>setTimeout(resolve,350));
    body = { key: 'fixture_only_secret_do_not_use' };
  }
  else body = [];
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
// Preserve existing font loading in the product; avoid network dependence in QA.
await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (message.text().includes('503') && message.location().url.includes('/api/')) expectedConsoleErrors.push(message.text());
  else if (message.text().includes('401') && message.location().url.endsWith('/api/account/privacy/exports')) expectedConsoleErrors.push(message.text());
  else consoleErrors.push(message.text());
});
async function capture(options) { await page.waitForTimeout(220); return page.screenshot(options); }
const composer = page.getByTestId('input-ai-composer');
const send = page.getByTestId('button-send-ai-message');
const sizes = [1600,1440,1280,1100,1024,800,650,414,390,360,320].map(width => [width,844]);
async function ready() {
  await composer.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute('aria-label') === 'إرسال الرسالة');
}
async function home() {
  await page.goto('/');
  await page.evaluate(() => sessionStorage.removeItem('dinar-guest-handoff'));
  await page.reload();
  await page.getByRole('heading', { name: 'كيف أساعدك اليوم؟' }).waitFor();
}
async function fits(label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: page overflow`);
  if (page.viewportSize().width <= 1023) {
    const lane = await page.locator('.ai-home-content').evaluate(el => {
      const style = getComputedStyle(el, '::before');
      return { height: parseFloat(style.height), zIndex: style.zIndex, pointerEvents: style.pointerEvents };
    });
    assert.ok(lane.height >= 60 && lane.zIndex === '4' && lane.pointerEvents === 'none', `${label}: mobile control has a non-interactive opaque top lane`);
  }
  if (await page.getByTestId('home-scroll-region').count()) await page.getByTestId('home-scroll-region').evaluate(el=>el.scrollTop=el.scrollHeight);
  const box = await page.locator('.ai-composer-box').boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1, `${label}: composer obstruction`);
  if (page.viewportSize().width <= 360) {
    const textWidth = await page.locator('[data-testid="input-ai-composer"]').evaluate(el => el.getBoundingClientRect().width);
    assert.ok(textWidth >= 160, `${label}: composer text area remains usable (${textWidth}px)`);
  }
  // Phones hide the helper inside a conversation (AiChat.css); a hidden helper cannot clip.
  const helper = page.locator('.ai-composer-helper');
  if (await helper.count() && await helper.isVisible()) {
    const help = await helper.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(help && help.y >= 0 && help.y + help.height <= viewport.height - 23, `${label}: helper clipping or missing edge clearance`);
  }
  const thread = page.getByTestId('conversation-thread');
  if (await thread.count()) {
    const history = await thread.boundingBox();
    const dock = await page.locator('.dinar-chat-dock').boundingBox();
    assert.ok(history.y + history.height <= dock.y + 1, `${label}: chat history/composer overlap`);
  }
  const scrollRegions = await page.locator('.ai-shell').evaluate(shell => [...shell.querySelectorAll('*')].filter(el => {
    const style = getComputedStyle(el);
    return ['auto','scroll'].includes(style.overflowY) && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && el.tagName !== 'TEXTAREA' && !el.closest('.ai-history');
  }).length);
  assert.ok(scrollRegions <= 1, `${label}: accidental nested vertical scroll regions`);
  const buttonDefects = await page.locator('button').evaluateAll(buttons => buttons.filter(el => el.getClientRects().length).flatMap(el => {
    const rect = el.getBoundingClientRect();
    const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim();
    const errors = [];
    if (!name) errors.push('unnamed button');
    if (el.scrollWidth > el.clientWidth + 2 && !el.closest('.ai-result-rail')) errors.push(`button text overflow: ${name}`);
    if (rect.width < 39 || rect.height < 39) errors.push(`small button: ${name} ${rect.width}x${rect.height}`);
    return errors;
  }));
  assert.deepEqual(buttonDefects, [], `${label}: button accessibility and geometry`);
  checks.push(label);
}
async function turn(text) {
  await composer.fill(text);
  assert.equal(await send.isEnabled(), true);
  assert.ok((await send.evaluate(el=>getComputedStyle(el).backgroundImage)).includes('gradient'));
  await capture({path:`${output}/composer-ready.png`});
  await send.click();
  await ready();
  await page.locator('[data-testid^="message-assistant-"]').last().waitFor();
}
async function restore(messages) {
  await page.evaluate(messages => sessionStorage.setItem('dinar-guest-handoff', JSON.stringify({ marketId: 'KW', messages, context: {} })), messages);
  await page.reload();
  await ready();
}
const message = (id, blocks) => ({ id, role: 'ASSISTANT', body: 'مراجعة التفاصيل', createdAt: new Date().toISOString(), blocks });

// These are browser rendering/interaction contract checks, never real authenticated E2E.
const counters={horizontalOverflow:0,clippedPrimaryCTA:0,composerOverlap:0,brokenRTL:0,secretUILeak:0,crossUserMemoryUILeak:0,preciseGPSTranscriptLeak:0};
const widths={};
const result={testingMode:'CONTRACT_FIXTURES',authenticatedBrowserTest:'BLOCKED',checks,counters,widths};
async function allWidths(label) {
  for(const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    await fits(`${label} ${width}`);
    assert.equal(await page.locator('.dinar-chatgpt').evaluate(el=>getComputedStyle(el).direction),'rtl');
    const sidebar=page.locator('aside#ai-conversation-history');
    if(width>=1024) {
      await sidebar.waitFor({state:'visible'});
      const box=await sidebar.boundingBox();
      const expectedSidebarWidth=width>=1350?264:260;
      assert.ok(Math.abs(box.width-expectedSidebarWidth)<1 && box.x>=0 && box.x<=24,`${width}: physical left ${expectedSidebarWidth}px sidebar`);
    } else {
      assert.equal(await sidebar.count(),0);
      const trigger=page.locator('[data-testid="button-toggle-conversation-history"]:visible').first();
      await trigger.click();
      const drawer=page.getByRole('dialog',{name:'سجل المحادثات'});
      await drawer.waitFor();
      assert.equal(await drawer.evaluate(el=>el.contains(document.activeElement)),true,'drawer focus');
      await page.keyboard.press('Escape');
      await drawer.waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement?.matches('[data-testid="button-toggle-conversation-history"]'));
      assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'drawer restores focus');
    }
    widths[width]='PASS';
  }
}
async function fixture(blocksToShow, id='fixture-surface') {
  if(fixtureUser) {
    fixtureMessages=[{...message(id,blocksToShow),actor:'ASSISTANT',body:'تفاصيل طلبك من دينار'}];
    await page.evaluate(()=>localStorage.setItem('dinar-conversation:fixture-user:KW','fixture-conversation'));
    await page.reload(); await ready();
  } else await restore([message(id,blocksToShow)]);
  await page.waitForTimeout(120);
}
async function sentBy(action, expected) {
  const previous=turns.length;
  blocks=[memory('MEMORY_UPDATED',[])];
  await action();
  await page.waitForFunction(()=>document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute('aria-label')==='إرسال الرسالة');
  await page.waitForTimeout(150);
  assert.equal(turns.length,previous+1,'one canonical conversational request');
  assert.equal(turns.at(-1).message,expected);
}
const driver=surface('DRIVER_ASSIGNMENT_STATUS',{driver:{view:'DRIVER_ASSIGNMENT_STATUS',assignments:[{orderId:'order-ui',reference:'طلب تجريبي',title:'توصيل معدات تخييم',statusLabel:'مهمة جارية',dropoff:{city:'الكويت',area:'السالمية'}}]}});
const proposal={id:'proposal-fixture',fareMinor:3000,currencyCode:'KWD',minorUnitScale:3,amount:'3.000',status:'PENDING',proposedByMe:false,buyerConfirmed:false,courierConfirmed:false,canConfirm:true,createdAt:new Date().toISOString()};
const baseFare={orderId:'order-ui',status:'AWAITING_CONFIRMATION',role:'COURIER',currencyCode:'KWD',minorUnitScale:3,proposal,agreement:null};
const noCommission={courierId:'fixture-user',outstandingDeliveryCount:0,hold:false,holdThreshold:10,settlementMode:'SIMULATION_ONLY',realMoneyTransferred:false,balances:[],earningsHistory:[]};
try {
  if(process.env.PREMIUM_UI_SKIP_LIVE_API_PROBE==='1') {
    result.developmentRuntime='SKIPPED_FOR_DISPOSABLE_DATABASE';
    result.authenticatedBrowserTest='BLOCKED';
    checks.push('contract browser fixtures: live API probe skipped to avoid non-disposable database access');
  } else {
    // Public development runtime probe, without intercepted authentication or injected cookies.
    const liveContext=await browser.newContext({baseURL:process.env.PREMIUM_UI_BASE??'http://127.0.0.1:4173'});
    const livePage=await liveContext.newPage();
    const auth=await liveContext.request.get('/api/auth/me');
    result.developmentRuntime=auth.status()===200?'AVAILABLE':'UNAVAILABLE';
    const authBody=await auth.json();
    result.authenticatedBrowserTest=authBody.user?'AVAILABLE_SESSION_NOT_EXERCISED':'BLOCKED';
    await livePage.goto('/');
    await livePage.getByTestId('input-ai-composer').waitFor();
    checks.push('real development browser: unauthenticated homepage, no auth bypass');
    await liveContext.close();
  }

  await home(); await ready();
  const units=await page.evaluate(async()=>{
    const {normalizeMemory,MemorySummary}=await import('/src/features/ai/MemorySummary.tsx');
    const {normalizeCommercial}=await import('/src/features/ai/CommercialSurface.tsx');
    const {friendlyError}=await import('/src/lib/errors.ts');
    const {privateTranscript}=await import('/src/features/ai/transcript-privacy.ts');
    return {
      memoryRendererDirection:MemorySummary({memory:{view:'MY_INTERESTS',groups:[]}}).props.dir,
      malformedMemory:normalizeMemory({view:'MY_INTERESTS',groups:[{label:'bad',items:[null]}]}),
      inventedMoneyMode:normalizeCommercial({view:'COMMERCIAL_BALANCE',paymentMode:'LIVE_PAYMENTS'}),
      safeArabic: friendlyError({data:{error:'تعذر إكمال الطلب الآن.'}}),
      secretError:friendlyError({data:{error:'خطأ API key sk-fixture-secret'}}),
      transcript:privateTranscript('موقعي 29.123456, 48.654321 API key sk-fixture-private OTP 123456 4111111111111111'),
      money:privateTranscript('الأجرة 3.000 KWD؛ اشتراك جاسم 20.00 USD'),
    };
  });
  assert.equal(units.memoryRendererDirection,'rtl');assert.equal(units.malformedMemory,null);assert.equal(units.inventedMoneyMode,null);
  assert.equal(units.safeArabic,'تعذر إكمال الطلب الآن.');assert.ok(!units.secretError.includes('sk-fixture'));
  assert.ok(!/29\.123456|48\.654321|sk-fixture|123456|4111111111111111/.test(units.transcript));
  assert.ok(units.money.includes('3.000 KWD')&&units.money.includes('20.00 USD'));
  checks.push('frontend unit contracts: typed validation, safe Arabic errors, transcript privacy, server money unchanged');
  await allWidths('empty conversation');
  await fixture([memory()]); await page.getByTestId('personal-memory').waitFor();
  assert.ok((await page.getByTestId('personal-memory').innerText()).includes('تفضيلات صرحت بها'));
  assert.ok((await page.getByTestId('personal-memory').innerText()).includes('اهتمامات متكررة'));
  assert.equal(await page.getByRole('heading',{name:'كيف أساعدك اليوم؟'}).count(),0);
  await allWidths('personal memory');
  await capture({path:`${output}/memory-320.png`});
  await page.getByTestId('memory-add').click();
  const editor=page.getByRole('dialog',{name:'تذكر تفضيلًا'}); await editor.waitFor();
  assert.equal(await editor.evaluate(el=>el.contains(document.activeElement)),true);
  assert.equal(await page.getByTestId('memory-editor-submit').isDisabled(),true);
  await page.getByTestId('memory-editor-input').fill('البرمجة');
  await sentBy(()=>page.getByTestId('memory-editor-submit').click(),'تذكر أني أحب البرمجة');
  await fixture([memory()]);
  await page.getByRole('button',{name:'عدّل اهتمام التخييم',exact:true}).click();
  await page.getByTestId('memory-editor-input').fill('الرياضة');
  await sentBy(()=>page.getByTestId('memory-editor-submit').click(),'عدّل تفضيلي التخييم إلى الرياضة');
  await fixture([memory()]);
  await sentBy(()=>page.getByRole('button',{name:'احذف اهتمام التخييم',exact:true}).click(),'احذف اهتمام التخييم');
  await fixture([memory()]);
  await sentBy(()=>page.getByRole('button',{name:'لا تستخدم كرة القدم في الاقتراحات',exact:true}).click(),'لا تقترح لي كرة القدم');
  await fixture([memory()]);
  await sentBy(()=>page.getByTestId('memory-view').click(),'جاسم، ماذا تعرف عن اهتماماتي؟');
  for(const view of ['MY_INTERESTS','MEMORY_SUMMARY','MEMORY_UPDATED','MEMORY_CONFIRMATION','MEMORY_REMOVED']) {
    await fixture([memory(view,[])]); await page.getByTestId('personal-memory').waitFor();
    assert.ok((await page.getByTestId('personal-memory').innerText()).length>20,'no blank confirmation/empty surface');
  }
  await fixture([memory()]); previewFailure=true;
  await page.getByRole('button',{name:'احذف اهتمام التخييم',exact:true}).click();
  await page.getByRole('alert').last().waitFor();
  assert.equal(await page.getByTestId('personal-memory').count(),1,'no fabricated removal after rejection');
  assert.equal((await page.locator('body').innerText()).includes('fixture_unavailable'),false);
  previewFailure=false;
  checks.push('memory view/add/update/forget/negative, dialogs, truthful rejection, nonblank states');

  // Unknown/private fields are never interpreted as visible profile data.
  for(const forbidden of ['API key sk-fixture-private','29.123456, 48.654321','تشخيص السكري']) {
    await fixture([memory('MEMORY_SUMMARY',[{label:'اهتمامات',items:[{topic:'private',label:forbidden,reason:'محتوى مرفوض'}]}])]);
    assert.equal((await page.locator('body').innerText()).includes(forbidden),false);
  }
  await fixture([memory()]);
  await page.evaluate(()=>sessionStorage.removeItem('dinar-guest-handoff'));
  await page.reload(); await ready();
  assert.equal(await page.getByTestId('personal-memory').count(),0,'profile is not shown without its conversation payload');
  await restore([{...message('private-transcript',[]),body:'موقعي 29.123456, 48.654321 API key sk-fixture-private OTP 123456 4111111111111111'}]);
  const transcriptText=await page.getByTestId('conversation-thread').innerText();
  counters.secretUILeak=(transcriptText.match(/sk-fixture-private|123456|4111111111111111/g)||[]).length;
  counters.preciseGPSTranscriptLeak=(transcriptText.match(/29\.123456|48\.654321/g)||[]).length;
  assert.equal(counters.secretUILeak,0);assert.equal(counters.preciseGPSTranscriptLeak,0);
  checks.push('sensitive, secret and precise-location memory payloads excluded; transcript redaction; no profile without its conversation');

  const commercialCases=[
    ['COMMERCIAL_BALANCE',{balance,monthSpentLabel:'2.00 USD'}],
    ['COMMERCIAL_LEDGER_SUMMARY',{balance,history:[]}],
    ['COMMERCIAL_TOPUP_REVIEW',{topup:{amountLabel:'5.00 USD',balanceAfterLabel:'30.00 USD',verificationNote:'الشحن بعد التأكيد فقط'},action:{type:'TOPUP',status:'PENDING',statusLabel:'بانتظار تأكيدك'}}],
    ['FEATURED_REVIEW',{review:{product:product('مميز','2.00 USD',3),amountLabel:'2.00 USD',balanceAfterLabel:'23.00 USD',sufficient:true},action:{type:'PURCHASE',status:'PENDING',statusLabel:'بانتظار تأكيدك'}}],
    ['VIP_REVIEW',{review:{product:product('VIP','5.00 USD',7),amountLabel:'5.00 USD',sufficient:true},action:{type:'PURCHASE',status:'PENDING',statusLabel:'بانتظار تأكيدك'}}],
    ['REFRESH_REVIEW',{review:{product:product('تحديث الظهور','0.50 USD',0),amountLabel:'0.50 USD',sufficient:true}}],
    ['BUNDLE_REVIEW',{review:{product:{...product('باقة الترويج','10.00 USD',0),bundleItems:[{productTypeLabel:'تحديث الظهور',units:10,durationDays:0}]},amountLabel:'10.00 USD',sufficient:true}}],
    ['BUNDLE_STATUS',{balance,entitlements:[{productTypeLabel:'تحديث الظهور',unitsRemaining:7,status:'ACTIVE'}]}],
    ['DEMAND_CAPTURE_REVIEW',{review:{product:{...product('روح بِع لي','5.00 USD',7),minBudgetLabel:'5.00 USD',unitChargeLabel:'0.50 USD'},budgetLabel:'5.00 USD',sufficient:true,pitch:'عرضك يظهر لمن يبحثون عما يناسبه؛ لا ضمان للبيع.'}}],
    ['COMMERCIAL_PRODUCT_REVIEW',{review:{product:product('ظهور ممول في البحث','5.00 USD',7),sufficient:true}}],
    ['COMMERCIAL_PRODUCTS',{products:[product('البحث الممول','5.00 USD',7),product('التوصيات الممولة','5.00 USD',7),product('10 تحديثات','3.00 USD',0)]}],
    ['PROMOTION_TYPE_OPTIONS',{step:'BUDGET',product:{...product('روح بِع لي','5.00 USD',7),unitChargeLabel:'0.50 USD'}}],
    ['CAMPAIGN_STATUS',{promotion:{listingTitle:'معدات تخييم',effectiveStatus:'ACTIVE',productTypeLabel:'مميز',budgetLabel:'5.00 USD',spentLabel:'1.00 USD',remainingLabel:'4.00 USD'}}],
    ['CAMPAIGN_ANALYTICS',{campaigns:[{listingTitle:'معدات تخييم',effectiveStatus:'ACTIVE',qualifiedImpressions:20,qualifiedEngagements:2,ordersAttributed:1,conversionRate:'50%',spentLabel:'1.00 USD'}],privacyNote:'أرقام مجمعة فقط؛ لا تعرض معلومات المشترين.'}],
    ['MARKET_PULSE',{pulse:{status:'AVAILABLE',message:'إشارات مجمعة من بحث المستخدمين',windowLabel:'آخر 7 أيام',disclaimer:'ليست وعدًا بربح أو بيع.',insights:[{title:'معدات تخييم',demandLabel:'حوالي 20 باحثًا',unmetLabel:'50% لم يجدوا المناسب',supplyLabel:'5 عروض',ratioLabel:'4 باحثين لكل عرض',priceRangeLabel:'حتى 50.00 USD',trendLabel:'صاعد',canActivateDemandCapture:true}]}}],
    ['MARKET_OPPORTUNITY',{pulse:{status:'INSUFFICIENT_DATA',message:'لا تكفي البيانات',windowLabel:'آخر 24 ساعة',disclaimer:'إشارات مجمعة فقط.',insights:[]}}],
    ['BUSINESS_PLAN_REVIEW',{review:{plan:product('جاسم بزنس','20.00 USD',30),sufficient:true,renewalNote:'لا تجديد تلقائي'},action:{type:'SUBSCRIBE',status:'PENDING',statusLabel:'بانتظار تأكيدك'}}],
    ['BUSINESS_STATUS',{status:{status:'ACTIVE',statusLabel:'نشط',planName:'جاسم بزنس',priceLabel:'20.00 USD',currentPeriodEnd:'2026-11-08T00:00:00Z',entitlementLabels:['إشارات سوق متقدمة'],renewalNote:'لا تجديد تلقائي'}}],
    ['COMMERCE_NOTICE',{notice:'الخدمة غير متاحة في سوقك حاليًا.'}],
  ];
  for(const [view,fields] of commercialCases) {
    await fixture([commerce(view,fields)]); await page.getByTestId('commercial-surface').waitFor();
    assert.equal(await page.getByTestId('commercial-surface').getAttribute('data-view'),view);
    for(const [width,height] of [[1440,844],[390,844],[320,844]]) {await page.setViewportSize({width,height});await fits(`${view} ${width}`);}
    assert.ok((await page.getByTestId('commercial-simulation').innerText()).includes('لا تنتقل أموال حقيقية'));
  }
  await fixture([commerce('PROMOTION_TYPE_OPTIONS',{step:'BUDGET'})]);
  await page.getByTestId('commercial-budget').fill('5');
  let commandCount=turns.length; blocks=[];
  await page.getByRole('button',{name:'مراجعة الميزانية',exact:true}).click();await ready();
  assert.equal(turns.length,commandCount+1);assert.equal(turns.at(-1).message,'ميزانيتي 5');
  const pulseFields=commercialCases.find(([view])=>view==='MARKET_PULSE')[1];
  await fixture([commerce('MARKET_PULSE',pulseFields)]);commandCount=turns.length;blocks=[];
  await page.getByRole('button',{name:'مراجعة روح بِع لي',exact:true}).click();await ready();
  assert.equal(turns.length,commandCount+1);assert.equal(turns.at(-1).message,'روح بع لي');
  checks.push('canonical commercial budget and first Market Pulse demand commands');
  await fixture([commerce('FEATURED_REVIEW',{review:{product:product('مميز','2.00 USD',3),sufficient:false,missingLabel:'2.00 USD'},action:{type:'PURCHASE',status:'PENDING',statusLabel:'بانتظار تأكيدك'}})]);
  assert.equal(await page.getByTestId('commercial-confirm').isDisabled(),true);
  await fixture([commerce('COMMERCIAL_BALANCE',{balance})]);await allWidths('commercial balance');
  checks.push('all commercial surfaces; server prices; no paid/trust/organic claims; insufficient balance disabled');

  // Authenticated presentation fixtures only. No real credentials/session are supplied.
  fixtureUser={id:'fixture-user',role:'USER',displayName:'مستخدم الواجهة',activeMarketId:'KW',avatarObjectPath:null,city:'الكويت',area:'السالمية',status:'ACTIVE',accountCountry:'KW',phoneVerified:false,normalizedPhone:'',locale:'ar',timeZone:'Asia/Kuwait',administrativeArea:'',createdAt:new Date().toISOString()};
  orderFixtures=[];
  await fixture([surface('ORDERS_LIST',{resourceIds:[]})]);await page.getByTestId('state-orders-empty').waitFor();
  orderDelay=800;await page.reload();await page.getByRole('status',{name:'جارٍ تحميل طلباتك'}).waitFor();await page.getByTestId('state-orders-empty').waitFor();orderDelay=0;
  orderFailure=true;await page.reload();await page.getByRole('button',{name:'إعادة المحاولة',exact:true}).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('SQL migration'),false);orderFailure=false;
  orderFixtures=[{id:'order-ui',listingId:'listing-first',listingTitle:'معدات تخييم مع اسم عربي طويل يناسب الرحلات',listingImageUrl:null,buyerId:'fixture-user',sellerId:'fixture-seller',buyerName:'مستخدم الواجهة',sellerName:'بائع تجريبي',quantity:1,unitPrice:'10.000',total:'10.000',currency:'KWD',status:'CREATED',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),fulfilmentType:'PICKUP',items:[],commission:'0.100',commissionRateBps:100}];
  // One known order opens its detail directly (ConversationContent); several still show rows.
  await fixture([surface('ORDER_STATUS',{resourceIds:['order-ui']})]);await page.getByRole('list',{name:'مراحل الطلب'}).waitFor();
  assert.equal(await page.getByTestId('row-order-order-ui').count(),0,'a single order status opens the order, not a list');await allWidths('ORDER_STATUS');
  for(const view of ['ORDERS_LIST','ORDER_SELECTOR']) {await fixture([surface(view,{resourceIds:['order-ui']})]);await page.getByTestId('row-order-order-ui').waitFor();await allWidths(view);}
  checks.push('orders list/selector/status, server status, empty/loading/error and mobile');
  await page.getByTestId('row-order-order-ui').click();
  await page.getByRole('list',{name:'مراحل الطلب'}).waitFor();
  for(const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`order detail/timeline ${width}: page overflow`);
    assert.equal(await page.getByRole('list',{name:'مراحل الطلب'}).isVisible(),true);
  }
  for(const status of ['ACCEPTED','BUYER_CONFIRMED']) {
    orderFixtures[0].status=status;await page.reload();await ready();await page.getByTestId('row-order-order-ui').click();await page.getByRole('list',{name:'مراحل الطلب'}).waitFor();
    assert.equal(await page.getByTestId(`status-${status}`).isVisible(),true);
  }
  orderFixtures[0].status='CANCELLED';await page.reload();await ready();await page.getByTestId('row-order-order-ui').click();await page.getByTestId('status-CANCELLED').waitFor();
  assert.ok((await page.locator('body').innerText()).includes('أُلغي الطلب'));
  orderFixtures[0].status='CREATED';await page.goto('/');await ready();
  checks.push('order details/timeline all widths; canonical created, accepted, confirmed and cancelled states');

  await fixture([surface('ORDER_TRACKING',{resourceId:'order-ui'})]);await page.getByTestId('order-tracking-order-ui').waitFor();await page.getByText('استلم المندوب الطلب').waitFor();await allWidths('tracking');
  for(const state of ['UNAVAILABLE','STALE','STOPPED','LIVE']) {
    trackingFixture={orderId:'order-ui',orderStatus:'PENDING',delivery:null,tracking:{state,reason:'NO_PROVIDER',latitude:29.123456,longitude:48.654321},progress:[{type:'PICKED_UP',occurredAt:'2026-10-14T10:00:00.000Z',actorRole:'COURIER'}]};
    await page.reload();
    await page.getByTestId('order-tracking-order-ui').waitFor();
    await page.getByText('استلم المندوب الطلب').waitFor();
    await page.waitForTimeout(150);
    const trackingText=await page.locator('body').innerText();
    assert.equal(trackingText.includes('29.123456'),false);
    assert.equal(trackingText.includes('بيانات الموقع قديمة وليست مباشرة'),state==='STALE');
  }
  apiFailure=true;await page.reload();await page.getByRole('button',{name:'إعادة تحميل التتبع'}).waitFor();apiFailure=false;
  await page.getByRole('button',{name:'إعادة تحميل التتبع'}).click();await page.waitForTimeout(200);
  checks.push('tracking live/stale/stopped/unavailable and retry; no coordinates in transcript');

  commissionFixture=noCommission;
  for(const [label,changes,expected] of [['proposal',{},'PROPOSED'],['buyer confirmed',{buyerConfirmed:true},'AWAITING_COURIER_CONFIRMATION'],['courier confirmed',{courierConfirmed:true},'AWAITING_BUYER_CONFIRMATION']]) {
    fareFixture={...baseFare,proposal:{...proposal,...changes}};await fixture([driver]);await page.getByTestId('courier-fare-card').waitFor();
    assert.equal(await page.getByTestId('courier-fare-card').getAttribute('data-confirmation-state'),expected);
    await allWidths(`fare ${label}`);
  }
  fareFixture={...baseFare,status:'AGREED',agreement:{id:'agreement-fixture',proposalId:'proposal-fixture',fareMinor:3000,currencyCode:'KWD',minorUnitScale:3,amount:'3.000',estimatedCommissionMinor:300,estimatedCommission:'0.300',commissionRateBps:1000,agreedAt:new Date().toISOString()}};
  commissionFixture={...noCommission,outstandingDeliveryCount:7,balances:[{marketId:'KW',currencyCode:'KWD',minorUnitScale:3,amountMinor:2100,deliveryCount:7,amount:'2.100'}]};
  await fixture([driver]);await page.getByTestId('courier-fare-agreement').waitFor();
  assert.ok((await page.getByTestId('courier-fare-agreement').innerText()).includes('3.000 KWD'));
  assert.ok((await page.getByTestId('courier-unsettled-count').innerText()).includes('7 / 10'));
  await allWidths('agreed fare and commission');
  commissionFixture={...commissionFixture,outstandingDeliveryCount:10,hold:true};await page.reload();await page.getByTestId('courier-commission-hold').waitFor();
  assert.ok((await page.getByTestId('courier-commission-hold').innerText()).includes('تم إيقاف استقبال'));
  await capture({path:`${output}/courier-hold-320.png`});
  apiFailure=true;await page.reload();await page.getByText('تعذر تحميل أجرة التوصيل لهذا الطلب.').waitFor();
  assert.equal((await page.locator('body').innerText()).includes('sk-fixture-secret'),false);apiFailure=false;
  checks.push('fare proposal/next-confirmation/agreement, server commission 7/10 and hold; safe error/retry');
  // Phones and tablets reach the search context only through this launcher (no top bar since 4ed2b01).
  await fixture([{type:'LISTING_RESULTS',version:1,payload:{resultSetId:'context-results',listings,resourceIds:listings.map(item=>item.id),searchState:{search:'آيفون',filters:[]}}}],'search-context');
  for(const [width,height] of [[390,844],[320,844]]) {
    await page.setViewportSize({width,height});const launcher=page.getByTestId('button-open-search-context-desktop');await launcher.waitFor();
    const box=await launcher.boundingBox();assert.ok(box&&box.height>=40&&box.x>=0&&box.x+box.width<=width+1,`search context launcher ${width}: visible touch target`);
    await launcher.click();await page.locator('#ai-context-drawer').waitFor();
    await page.keyboard.press('Escape');await page.locator('#ai-context-drawer').waitFor({state:'hidden'});await fits(`search context ${width}`);
  }
  await page.setViewportSize({width:1440,height:900});
  checks.push('search context launcher on phones opens and closes the context drawer');
  // Conversation privacy cards: the export password goes only to /account/privacy/exports,
  // never into a conversation turn, and the card stays RTL and unclipped on small screens.
  const privacyExport={view:'PRIVACY_EXPORT',status:'AWAITING_REAUTHENTICATION',includes:['الحساب والتفضيلات','الإعلانات والطلبات','رسائلك ومحادثاتك'],notice:'أدخل كلمة المرور في النموذج أدناه (لا تكتبها في المحادثة). تُسلَّم النسخة مباشرة ولا تُحفظ على الخادم.'};
  const privacyCenter={view:'CONTROL_NOTICE',tone:'INFO',title:'بياناتك لدى دينار',lines:['الحساب: الاسم والمدينة والهاتف المُتحقق منه','المحادثات: 3'],options:[{label:'صدّر بياناتي',message:'صدّر بياناتي'}]};
  await fixture([surface('CONTROL_NOTICE',{control:privacyCenter})],'privacy-center');await page.getByTestId('control-notice').waitFor();
  assert.ok((await page.getByTestId('control-notice').innerText()).includes('بياناتك لدى دينار'));
  for(const [width,height] of [[1440,844],[390,844],[320,844]]) {await page.setViewportSize({width,height});await fits(`privacy center ${width}`);}
  await fixture([surface('PRIVACY_EXPORT',{control:privacyExport})],'privacy-export');const card=page.getByTestId('control-privacy-export');await card.waitFor();
  assert.equal(await card.evaluate(el=>getComputedStyle(el).direction),'rtl');
  for(const [width,height] of [[1440,844],[390,844],[320,844]]) {await page.setViewportSize({width,height});await fits(`privacy export ${width}`);
    const button=await page.getByTestId('button-privacy-export').boundingBox();assert.ok(button&&button.x>=0&&button.x+button.width<=width+1,`privacy export ${width}: clipped submit`);}
  assert.equal(await page.getByTestId('button-privacy-export').isDisabled(),true,'no export without a password');
  const turnsBeforeExport=turns.length,exportPassword='Fixture-Export-Passw0rd';
  privacyExportFailure=true;await page.getByTestId('input-privacy-export-password').fill(exportPassword);await page.getByTestId('button-privacy-export').click();
  await card.locator('[role="alert"]').waitFor();assert.equal(await card.getAttribute('data-status'),'FAILED');privacyExportFailure=false;
  const download=page.waitForEvent('download');await page.getByTestId('button-privacy-export').click();
  assert.match((await download).suggestedFilename(),/^dinar-data-privacy-.*\.json$/);
  await page.waitForFunction(()=>document.querySelector('[data-testid="control-privacy-export"]')?.getAttribute('data-status')==='DONE');
  assert.equal(privacyExports.length,2);assert.ok(privacyExports.every(request=>request.currentPassword===exportPassword&&/^export-/.test(request.idempotencyKey)));
  assert.equal(new Set(privacyExports.map(request=>request.idempotencyKey)).size,2,'each submit is its own export request');
  assert.equal(turns.length,turnsBeforeExport,'export never posts a conversation turn');
  assert.equal(JSON.stringify(turns).includes(exportPassword),false,'password never enters a conversation turn');
  assert.equal((await page.locator('body').innerText()).includes(exportPassword),false,'password never rendered');
  assert.equal(await page.getByTestId('input-privacy-export-password').count(),0,'form cleared after export');
  await page.setViewportSize({width:1440,height:900});
  checks.push('privacy center and export cards: RTL, 1440/390/320 fit, password only to the export endpoint, download, safe failure');
  fixtureMessages=[{...message('owner-one',[memory()]),actor:'ASSISTANT'}];
  await page.reload();await page.getByTestId('personal-memory').waitFor();
  fixtureUser={...fixtureUser,id:'fixture-second-user'};fixtureMessages=[];
  await page.reload();await ready();
  counters.crossUserMemoryUILeak=await page.getByTestId('personal-memory').count();
  assert.equal(counters.crossUserMemoryUILeak,0,'second user must not retain first user memory UI');
  checks.push('separate fixture accounts: no prior account personal-memory UI');

  // Recover high-value scroll behavior from the retired harness using the current guest thread.
  fixtureUser=null;
  const longHistory=Array.from({length:90},(_,i)=>({
    id:`history-${i}`,
    role:i%2?'ASSISTANT':'USER',
    body:`جاسم ${i} — نص عربي للمراجعة `.repeat(10),
    createdAt:new Date().toISOString(),
    blocks:[],
  }));
  await restore(longHistory);
  const thread=page.getByTestId('conversation-thread');
  const threadBox=await thread.boundingBox();
  assert.ok(threadBox,'history thread is measurable');
  await page.mouse.move(threadBox.x+threadBox.width/2,threadBox.y+threadBox.height/2);
  await page.mouse.wheel(0,-350);
  await page.waitForFunction(()=>{
    const el=document.querySelector('[data-testid="conversation-thread"]');
    return el && el.scrollTop>0 && el.scrollHeight-el.clientHeight-el.scrollTop>96;
  });
  await page.getByTestId('button-return-to-latest').waitFor();
  await page.evaluate(async()=>{
    const el=document.querySelector('[data-testid="conversation-thread"]');
    let previous=el.scrollTop,stableFrames=0;
    for(let frame=0;frame<180&&stableFrames<5;frame++){
      await new Promise(requestAnimationFrame);
      const current=el.scrollTop;
      stableFrames=Math.abs(current-previous)<0.5?stableFrames+1:0;
      previous=current;
    }
  });
  const anchoredScroll=await thread.evaluate(el=>el.scrollTop);
  await composer.fill('قراءة السجل');
  const typedScroll=await thread.evaluate(el=>el.scrollTop);
  assert.ok(Math.abs(typedScroll-anchoredScroll)<5,`typing does not move a reader away from older messages (${anchoredScroll} → ${typedScroll})`);
  await thread.evaluate(el=>el.scrollTop=0);
  await page.getByTestId('button-load-older-messages').click();
  assert.equal(await page.locator('[data-testid^="message-"]').count(),80,'load older adds one history page');
  await page.getByTestId('button-return-to-latest').click();
  await page.waitForFunction(()=>{const el=document.querySelector('[data-testid="conversation-thread"]');return el.scrollHeight-el.scrollTop-el.clientHeight<96;});
  checks.push('older-message loading, scroll anchor during typing, return-to-latest');

  const offlineDraft='رسالة محفوظة بلا اتصال';
  const turnsBeforeOffline=turns.length;
  await context.setOffline(true);
  await page.waitForFunction(()=>navigator.onLine===false);
  await composer.fill(offlineDraft);
  assert.equal(await send.isDisabled(),true,'offline composer blocks send');
  await page.getByText('أنت غير متصل. ستبقى رسالتك هنا حتى يعود الاتصال.').waitFor();
  assert.equal(turns.length,turnsBeforeOffline,'offline attempt never reaches the turn endpoint');
  await context.setOffline(false);
  await page.waitForFunction(()=>navigator.onLine===true);
  assert.equal(await composer.inputValue(),offlineDraft,'draft survives reconnect');
  assert.equal(await send.isDisabled(),false,'composer becomes usable again online');
  await composer.fill('');
  checks.push('simulated offline browser: send blocked, no turn request, draft retained after reconnect');

  // Exercise the actual shared Button primitive in a test-only host, never a product route.
  await page.evaluate(async()=>{
    const [{Button},reactModule,domModule]=await Promise.all([
      import('/src/ui/Button.tsx'),
      import('/node_modules/.vite/deps/react.js'),
      import('/node_modules/.vite/deps/react-dom_client.js'),
    ]);
    const React=reactModule.default??reactModule;
    const {createRoot}=domModule.default??domModule;
    const host=document.createElement('div');host.id='button-qa';host.dir='rtl';
    host.style.cssText='position:fixed;inset:0;z-index:1000;overflow:auto;background:#061321;padding:24px;color:#f4f7fc';
    document.body.append(host);
    const labels={primary:'تأكيد الإجراء',secondary:'عرض التفاصيل',ghost:'إلغاء',danger:'حذف',success:'إجراء مؤكد',nav:'المحادثات'};
    const root=createRoot(host);
    const controls=Object.entries(labels).map(([variant,label])=>React.createElement(Button,{key:variant,variant,'data-testid':`variant-${variant}`,onClick:()=>host.dataset.clicks=String(Number(host.dataset.clicks||0)+1)},label));
    controls.push(React.createElement(Button,{key:'disabled',disabled:true,'data-testid':'variant-disabled'},'غير متاح'));
    controls.push(React.createElement(Button,{key:'loading',loading:true,'data-testid':'variant-loading'},'جارٍ النشر'));
    root.render(React.createElement('div',{style:{maxWidth:940,margin:'0 auto',display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:16}},...controls));
    window.__buttonQaUnmount=()=>{root.unmount();host.remove();};
  });
  const primary=page.getByTestId('variant-primary');
  await primary.waitFor();
  for(const [width,height] of sizes){
    await page.setViewportSize({width,height});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`shared buttons fit ${width}px`);
    await capture({path:`${output}/button-variants-${width}-${height}.png`});
  }
  await page.setViewportSize({width:1440,height:900});
  await primary.hover();await page.mouse.down();await page.waitForTimeout(180);
  assert.ok((await primary.evaluate(el=>getComputedStyle(el).transform)).includes('0.985'),'pressed state is visible');
  await page.mouse.up();await page.keyboard.press('Tab');await primary.focus();
  assert.equal(await primary.evaluate(el=>getComputedStyle(el).outlineWidth),'2px','keyboard focus remains visible');
  assert.equal(await page.getByTestId('variant-disabled').isDisabled(),true);
  assert.equal(await page.getByTestId('variant-loading').isDisabled(),true);
  assert.equal(await page.getByTestId('variant-loading').getAttribute('aria-busy'),'true');
  await primary.press('Enter');
  assert.equal(await page.locator('#button-qa').getAttribute('data-clicks'),'2');
  await page.emulateMedia({reducedMotion:'reduce'});await primary.hover();
  assert.equal(await primary.evaluate(el=>getComputedStyle(el).transform),'none','reduced motion removes press transform');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>window.__buttonQaUnmount());
  checks.push('shared button variants, hover/press, keyboard focus, disabled/loading and reduced motion');

  // Render the actual shared card/header components for the complete conversational family
  // inventory, then check their real boxes rather than inferred CSS tokens or mocked markup.
  await page.evaluate(async()=>{
    const [primitiveModule,reactModule,domModule]=await Promise.all([
      import('/src/features/ai/surface/primitives.tsx'),
      import('/node_modules/.vite/deps/react.js'),
      import('/node_modules/.vite/deps/react-dom_client.js'),
    ]);
    const React=reactModule.default??reactModule;
    const {createRoot}=domModule.default??domModule;
    const {SurfaceCard,SurfaceHeader}=primitiveModule;
    const families=[
      ['إعلانات المنتجات','عروض المنتجات','نتائج البحث','TAG'],
      ['مقارنة المنتجات','مقارنة الخيارات','ملخص المقارنة','CHART'],
      ['التفاوض','عرض سعر ينتظر موافقتك','المبلغ الحالي','HANDSHAKE'],
      ['مراجعة الشراء','مراجعة طلبك','إجمالي الطلب','CART'],
      ['مراجعة الدفع','طريقة الدفع المتاحة','لا تُحوّل أموالًا','RECEIPT'],
      ['التوصيل','تفاصيل الاستلام والتوصيل','الحالة الحالية','TRUCK'],
      ['التتبع','آخر تحديث للتسليم','معلومات داخل جاسم','PIN'],
      ['عمليات السائق','طلبات التوصيل المتاحة','تأكيد قبل التنفيذ','USER'],
      ['خدمات المزود','حالة اتصال المزود','بيانات محمية','INFO'],
      ['الاستفسارات','طلب تواصل مع البائع','بانتظار الرد','SEND'],
      ['الترويج','خطة الترويج','السعر غير معتمد بعد','MEGAPHONE'],
      ['التوظيف','تقديم وظيفي','راجع التفاصيل','BRIEFCASE'],
      ['تحليلات البائع','ملخص المبيعات','من سجل جاسم','CHART'],
      ['الباقات','خطط الاستخدام','السعر غير معتمد بعد','GAUGE'],
      ['استهلاك AI','استهلاكك الحالي','تجدد الحصة حسب السياسة','SPARKLE'],
      ['إعدادات الحساب','إدارة التفضيلات','تستطيع تعديلها لاحقًا','USER'],
    ];
    const host=document.createElement('div');host.id='surface-header-qa';host.className='dinar-chatgpt';host.dir='rtl';
    host.style.cssText='position:fixed;inset:0;z-index:1000;display:block;overflow:auto;padding:16px;background:var(--chat-ground)';
    document.body.append(host);
    const root=createRoot(host);
    root.render(React.createElement('div',{style:{maxWidth:960,margin:'0 auto',display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))',gap:12}},
      ...families.map(([family,title,subtitle,icon],index)=>React.createElement('div',{'data-family':family,key:family},
        React.createElement(SurfaceCard,{label:family,testId:`header-card-${index}`},
          React.createElement(SurfaceHeader,{title:index===15?'إعدادات الحساب والتفضيلات والخصوصية في مساحة واحدة':title,subtitle,icon,badge:index%3===0?{label:'حالة واضحة',tone:'INFO'}:undefined,source:index%4===0?'من جاسم':undefined})
        )
      ))
    ));
    window.__surfaceHeaderQaUnmount=()=>{root.unmount();host.remove();};
  });
  for(const scheme of ['light','dark']){
    await page.evaluate(scheme=>document.documentElement.classList.toggle('dark',scheme==='dark'),scheme);
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});
      const boxes=await page.evaluate(()=>[...document.querySelectorAll('#surface-header-qa [data-family]')].map(wrapper=>{
        const card=wrapper.querySelector('.ds-card'),header=wrapper.querySelector('.ds-header');
        const icon=wrapper.querySelector('.ds-header-icon'),title=wrapper.querySelector('.ds-title');
        return {family:wrapper.dataset.family,card:card.getBoundingClientRect().toJSON(),header:header.getBoundingClientRect().toJSON(),icon:icon.getBoundingClientRect().toJSON(),title:title.getBoundingClientRect().toJSON()};
      }));
      assert.equal(boxes.length,16,`${width}/${scheme}: every shared-header family rendered`);
      for(const box of boxes){
        assert.ok(Math.abs(box.icon.top-box.title.top)<=1,`${width}/${scheme} ${box.family}: icon and title top-align`);
        assert.ok(box.title.right<=box.icon.left+1,`${width}/${scheme} ${box.family}: RTL title stays beside icon`);
        assert.ok(box.card.left>=0&&box.card.right<=width+1,`${width}/${scheme} ${box.family}: card fits viewport`);
      }
      if([320,390,1280].includes(width))await capture({path:`${output}/surface-headers-${width}-${scheme}.png`});
    }
  }
  await page.evaluate(()=>window.__surfaceHeaderQaUnmount());
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  checks.push('actual SurfaceCard/SurfaceHeader DOM: icon-title alignment for 16 families at 11 widths × 2 themes');

  // Capture real full-body specialized renderers from fixture-backed conversation blocks.
  // These are local presentation fixtures, not persisted orders, payments, or delivery history.
  const specializedScreens=[
    {name:'orders-list',block:surface('ORDERS_LIST',{resourceIds:['order-ui']}),selector:'[data-testid="row-order-order-ui"]'},
    {name:'order-status',block:surface('ORDER_STATUS',{resourceIds:['order-ui']}),selector:'[aria-label="مراحل الطلب"]'},
    {name:'tracking',block:surface('ORDER_TRACKING',{resourceId:'order-ui'}),selector:'[data-testid="order-tracking-order-ui"]'},
    {name:'courier-fare',block:driver,selector:'[data-testid="courier-fare-card"]'},
    {name:'privacy-control',block:surface('CONTROL_NOTICE',{control:privacyCenter}),selector:'[data-testid="control-notice"]'},
    {name:'privacy-export',block:surface('PRIVACY_EXPORT',{control:privacyExport}),selector:'[data-testid="control-privacy-export"]'},
  ];
  for(const item of specializedScreens){
    for(const scheme of ['light','dark']){
      await page.evaluate(scheme=>{localStorage.setItem('dinar-theme',scheme);document.documentElement.classList.toggle('dark',scheme==='dark');},scheme);
      for(const [width,height] of [[320,844],[390,844],[1280,900]]){
        await page.setViewportSize({width,height});
        await fixture([item.block],`visual-${item.name}`);
        const surfaceBody=page.locator(item.selector).first();
        await surfaceBody.waitFor();
        const box=await surfaceBody.boundingBox();
        assert.ok(box&&box.width>0&&box.height>0,`${item.name} body renders at ${width}/${scheme}`);
        await fits(`${item.name} ${width} ${scheme}`);
        await capture({path:`${output}/specialized-${item.name}-${width}-${scheme}.png`});
      }
    }
    checks.push(`${item.name}: full-body mobile/desktop screenshots in light and dark themes`);
  }
  await page.evaluate(()=>{localStorage.setItem('dinar-theme','light');document.documentElement.classList.remove('dark');});

  await page.setViewportSize({width:390,height:844});
  await page.goto('/policies');
  await page.getByRole('heading',{name:'الشروط والسياسات',exact:true}).waitFor();
  await capture({path:`${output}/policies-standalone-390.png`});
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light','chat theme does not leak into standalone policy pages');
  checks.push('standalone policy route keeps its own theme');

  assert.deepEqual(errors,[],'no browser exceptions');
  assert.deepEqual(consoleErrors,[],'no unexpected browser errors');
  result.status='PASS';
} catch(error) {
  result.status='FAIL';result.failure=error.stack;await page.screenshot({path:`${output}/failure.png`}).catch(()=>{});throw error;
} finally {
  writeFileSync(`${output}/report.json`,JSON.stringify({...result,pageErrors:errors,consoleErrors},null,2));
  console.log(JSON.stringify(result,null,2));
  await browser.close();
}
