import { chromium } from '@playwright/test';
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium'});
const context = await browser.newContext({baseURL:'http://127.0.0.1:4173',viewport:{width:390,height:844}}); await context.addInitScript(() => localStorage.setItem('bdinar-onboarded', '1')); const page=await context.newPage(); let checks=0;
function check(value,message){if(!value)throw new Error(message);checks++;}
const phone='5'+String(Date.now()).slice(-7);const password='Browser-acceptance-2026!';
await page.goto('/register');await page.locator('[name=displayName]').fill('تجربة المتصفح');await page.locator('[name=phoneNumber]').fill(phone);await page.locator('[name=password]').fill(password);await page.locator('[name=confirmPassword]').fill(password);await page.locator('[name=acceptTerms]').check();await page.getByRole('button',{name:'إنشاء الحساب',exact:true}).click();await page.waitForURL('/');check((await context.request.get('/api/auth/me')).ok(),'Registration session');
await page.goto('/seller/new');await page.getByLabel('عنوان العرض').fill('عرض المتصفح المتكامل');await page.getByLabel('ماذا تشمل الوحدة؟').fill('خدمة تجريبية واضحة تشمل تصميم وحدة واحدة');await page.getByRole('button',{name:'التالي',exact:true}).click();await page.getByRole('button',{name:'التالي',exact:true}).click();await page.getByTestId('input-listing-quantity').fill('9');await page.getByRole('button',{name:'التالي',exact:true}).click();await page.getByLabel('المنطقة العامة').fill('مدينة الاختبار');await page.getByRole('button',{name:'التالي',exact:true}).click();await page.getByRole('button',{name:'نشر العرض',exact:true}).click();await page.waitForURL(/\/listings\//);const offerId=page.url().split('/').pop();check(!!offerId,'Wizard published');
await page.goto(`/seller/offers/${offerId}/edit`);await page.getByTestId('input-edit-listing-title').count().then(async count=>{if(count)await page.getByTestId('input-edit-listing-title').fill('عرض معدل');});check((await context.request.get(`/api/listings/${offerId}`)).ok(),'Published offer readable');
for(const id of ['KW_lst_design','KW_lst_shirts']) {await page.goto(`/listings/${id}`);await page.getByTestId('input-listing-quantity-selector').fill('2');await page.getByTestId('button-add-to-cart').click();await page.waitForTimeout(300);}
await page.goto('/cart');await page.waitForTimeout(300);const cart=await (await context.request.get('/api/cart')).json();check(cart.length===2&&cart.every(i=>i.quantity===2),'Persisted multi-seller cart');
await page.getByTestId('button-cart-checkout').click();await page.waitForURL('/checkout');await page.getByRole('checkbox').check();await page.getByTestId('button-cart-checkout').click();await page.waitForURL('/orders');const orders=await (await context.request.get('/api/orders')).json();check(orders.length===2,'Multi-seller checkout created two orders');check(orders.every(o=>o.total==='2.000'),'Integer price snapshots');

for (const order of orders) {
  const seller = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 } });
  await seller.addInitScript(() => localStorage.setItem('bdinar-onboarded', '1'));
  const login = await seller.request.post('/api/auth/login', { data: { phoneCountryCode: '+965', phoneNumber: order.sellerId === 'usr_seller_5' ? '50000005' : '50000002', password: 'Development-only-2026!' } });
  check(login.ok(), 'Seller login');
  const sp = await seller.newPage(); await sp.goto(`/orders/${order.id}`);
  await sp.getByTestId('button-accept-order').click();
  await sp.getByTestId('input-order-message').fill('بدأ تنفيذ الطلب'); await sp.getByTestId('button-send-message').click();
  await sp.getByTestId('input-delivery-proof').fill('مرجع اختبار المتصفح'); await sp.getByTestId('button-mark-delivered').click();
  await sp.getByRole('button', { name: 'نعم، تم التسليم', exact: true }).click();
  await sp.getByTestId('status-SELLER_MARKED_DELIVERED').waitFor();
  await page.goto(`/orders/${order.id}`);
  await page.getByTestId('button-confirm-receipt').click(); await page.getByRole('button', { name: 'نعم، استلمته', exact: true }).click();
  await page.getByTestId('status-COMPLETED').waitFor();
  const dues = await (await seller.request.get('/api/seller-dues')).json();
  check(dues.some(d => d.orderId === order.id && d.amount === '0.200'), 'Exact completion fee');
  check((await (await context.request.get(`/api/orders/${order.id}/messages`)).json()).some(m => m.body === 'بدأ تنفيذ الطلب'), 'Persisted seller chat');
  await seller.close();
}
for (const market of ['SA', 'JO', 'KW']) {
  await page.goto('/settings'); await page.getByTestId('button-settings-market').click();
  await page.getByTestId(`button-market-${market}`).click(); await page.getByTestId('button-confirm-market').click(); await page.waitForURL('/');
  const me = await (await context.request.get('/api/auth/me')).json();
  check(me.user.activeMarketId === market && me.user.accountCountry === 'KW', 'Market switch preserves account country');
  const listings = await (await context.request.get('/api/listings')).json();
  check(listings.length > 0 && listings.every(o => o.marketId === market), 'Isolated market discovery');
}
await page.goto('/profile');await page.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await page.waitForURL('/');await page.goBack();await page.waitForTimeout(300);check((await context.request.get('/api/cart')).status()===401,'Logout/back rejects cart');
console.log(JSON.stringify({checks,failures:0}));await browser.close();
