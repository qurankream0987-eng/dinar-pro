/** Real welcome actions against Command E's authenticated/anonymous server sessions. */
export async function verifyWelcomeActions({ browser, contextFor, openConversation, measure, out }) {
  const failures = [], runs = [];
  const actions = [
    ['buy','welcome-buy','send'], ['sell','welcome-sell','send'], ['compare','welcome-compare','compose'],
    ['image','button-prompt-ابحث بالصور','image'], ['code','button-prompt-ساعدني في البرمجة','compose'],
    ['plan','button-prompt-خطط معي','compose'], ['idea','button-prompt-اقترح فكرة','compose'],
    ['advertise','button-prompt-أنشئ إعلانًا','compose'], ['analyze','button-prompt-حلّل منتجي','compose'],
  ];
  for (const actor of ['buyer', 'anonymous']) {
    for (const [id, testId, behavior] of actions) {
      const context = await contextFor(browser, 390, 'dark', 'buyer');
      if (actor === 'anonymous') await context.clearCookies();
      const page = await context.newPage();
      const mutations = [], errors = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(request.method())) mutations.push(url.pathname);
      });
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await openConversation(page, 'buyer', null);
        const before = mutations.length;
        const input = page.getByTestId('input-ai-composer');
        const button = page.getByTestId(testId);
        await button.scrollIntoViewIfNeeded();
        await button.focus();
        let fileChooser = false;
        page.on('filechooser', () => { fileChooser = true; });
        await page.keyboard.press('Enter');
        if (behavior === 'send') {
          await page.waitForFunction(() => document.querySelector('[data-testid^="message-user-"]') || document.querySelector('[role="dialog"]'), null, { timeout: 20000 });
          await page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute('aria-busy') !== 'true', null, { timeout: 30000 });
          if (actor === 'buyer') {
            const answer = await page.locator('[data-testid^="message-assistant-"]').last().innerText();
            if (id === 'buy' && !/تبي|تريد|تبحث|منتج|خدمة|تشتري/u.test(answer)) throw new Error('buy entry must request a real item');
            if (id === 'sell' && !/تصنيف|صف المنتج|تبيع|إعلان/u.test(answer)) throw new Error('sell entry must request real listing information');
          }
        } else if (behavior === 'image') {
          await page.waitForTimeout(250);
          if (!(await input.inputValue()).includes('للصورة المرفقة')) throw new Error('image action must preserve search intent instead of the empty-photo listing default');
          if (actor === 'buyer' && !fileChooser) throw new Error('authenticated image action did not open the existing file chooser');
          if (actor === 'anonymous' && fileChooser) throw new Error('anonymous upload bypassed the existing gate');
        } else {
          if (!(await input.inputValue()).trim()) throw new Error('action did not prefill composer');
          await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'input-ai-composer', null, { timeout: 3000 });
          if (!await input.evaluate(el => document.activeElement === el)) throw new Error('prefill did not focus composer');
        }
        const posted = mutations.slice(before);
        if (posted.some(path => /\/(orders|payments|listings|cart|promotions)(\/|$)/.test(path))) throw new Error('welcome action mutated a commerce resource');
        if (behavior !== 'send' && posted.some(path => /\/turns$/.test(path))) throw new Error('prefill/attachment unexpectedly invoked the model');
        if (errors.length) throw new Error(errors.join('; '));
        const layout = await page.evaluate(measure);
        if (layout.scrollOverflow > 1) throw new Error('action transition overflow');
        await page.screenshot({ path: `${out}/welcome-${actor}-${id}.png` });
        runs.push({ actor, id, behavior, posted, fileChooser, layout, errors });
      } catch (error) { failures.push(`${actor}/${id}: ${error.message}`); }
      finally { await context.close(); }
    }
  }
  return { runs, failures };
}

/** Cart is a persisted read surface in the unified conversation, not a standalone page. */
export async function verifyCartNavigation({ browser, contextFor, openConversation, conversations, out }) {
  const runs = [], failures = [];
  for (const width of [320, 1440]) {
    const context = await contextFor(browser, width, 'dark', 'buyer');
    const page = await context.newPage();
    const forbidden = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (!['GET','HEAD','OPTIONS'].includes(request.method()) && /\/(orders|payments|listings|cart|promotions)(\/|$)/.test(path)) forbidden.push(path);
    });
    const api = path => page.evaluate(async path => {
      const response = await fetch('/api' + path);
      return { status: response.status, data: await response.json() };
    }, path);
    const selected = () => page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('dinar-conversation:'))?.[1]);
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    let stage = 'select original';
    try {
      const original = conversations.negotiation.id;
      // Select through real UI: openConversation's screenshot helper installs a reload-time
      // localStorage override, which would invalidate a persistence/navigation check.
      const chooseOriginal = async () => {
        if (width < 1024) await page.getByTestId('button-toggle-conversation-history').first().click();
        const item = page.getByTestId('conversation-' + original);
        if (!await item.isVisible()) await page.getByTestId('button-toggle-all-conversations').click();
        await item.click();
        await page.waitForFunction(id => Object.entries(localStorage).some(([key,value]) => key.startsWith('dinar-conversation:') && value === id), original);
      };
      await page.goto('/');
      await page.getByTestId('input-ai-composer').waitFor();
      await chooseOriginal();
      await page.locator('[data-testid^="message-assistant-"]').first().waitFor();
      const before = await api('/ai/conversations/' + original);
      check(before.status === 200, 'original pending conversation is readable by its owner');
      const cartBefore = await api('/cart');
      const ordersBefore = await api('/orders');
      check(cartBefore.status === 200 && ordersBefore.status === 200, 'cart and orders snapshots are authenticated successful reads');
      stage = 'open cart';
      await page.locator('[data-testid="link-cart"]:visible, [data-testid="footer-cart"]:visible, [data-testid="sidebar-cart"]:visible').first().click();
      await page.waitForFunction(() => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute('aria-busy') !== 'true' && /السلة|سلتك/u.test(document.querySelector('[data-testid^="message-assistant-"]')?.textContent ?? ''), null, { timeout:30000 });
      const cartId = await selected();
      check(cartId && cartId !== original, 'cart opens its own read conversation without replacing the pending conversation');
      const cartDetail = await api('/ai/conversations/' + cartId);
      check(cartDetail.data.messages.some(message => message.blocks?.some(block => block.payload?.surface === 'CART')), 'server transcript contains the actual CART surface');
      check(['/','/ai'].includes(new URL(page.url()).pathname), 'cart stays in the unified conversation shell');
      check(!new URL(page.url()).searchParams.has('openSurface'), 'read command is consumed, not replayable by refresh');
      await page.screenshot({path:out + '/cart-open-' + width + '.png'});
      const steps = [];
      for (const operation of ['reload','goBack','goForward']) {
        stage = operation;
        await page[operation]();
        await page.getByTestId('input-ai-composer').waitFor();
        await page.waitForFunction(id => Object.entries(localStorage).some(([key,value]) => key.startsWith('dinar-conversation:') && value === id), cartId);
        await page.waitForFunction(() => /السلة|سلتك/u.test(document.querySelector('[data-testid^="message-assistant-"]')?.textContent ?? ''), null, { timeout:30000 });
        const restored = await api('/ai/conversations/' + cartId);
        check(JSON.stringify(restored.data.messages) === JSON.stringify(cartDetail.data.messages), operation + ' restores the stored cart without replaying a turn');
        check(JSON.stringify((await api('/cart')).data) === JSON.stringify(cartBefore.data), operation + ' preserves exact cart contents');
        steps.push({ operation, url:page.url(), conversationId:cartId, cartUnchanged:true });
      }
      stage = 'restore pending conversation';
      await chooseOriginal();
      const originalAssistant = before.data.messages.find(message => message.actor === 'ASSISTANT');
      await page.getByTestId('message-assistant-' + originalAssistant.id).waitFor({state:'visible'});
      const after = await api('/ai/conversations/' + original);
      check(JSON.stringify(after.data) === JSON.stringify(before.data), 'closing cart by selecting original conversation preserves its pending state and confirmations');
      check(JSON.stringify((await api('/orders')).data) === JSON.stringify(ordersBefore.data), 'cart navigation creates no order');
      check(JSON.stringify((await api('/cart')).data) === JSON.stringify(cartBefore.data), 'opening and closing cart changes no quantities');
      check(!forbidden.length, 'navigation must never call financial or commerce mutation endpoints');
      stage = 'cross-user isolation';
      const other = await contextFor(browser, width, 'dark', 'seller');
      const otherPage = await other.newPage();
      await otherPage.goto('/');
      const foreignStatus = await otherPage.evaluate(async id => (await fetch('/api/ai/conversations/' + id)).status, original);
      check([403,404].includes(foreignStatus), 'another user cannot read the original pending conversation');
      await other.close();
      await page.screenshot({path:out + '/cart-navigation-' + width + '.png'});
      runs.push({width, original, cartId, steps, pendingPreserved:true, foreignStatus, forbidden});
    } catch(error) {
      failures.push(width + '/' + stage + ': ' + error.message);
      await page.screenshot({path:out + '/cart-navigation-failure-' + width + '.png'}).catch(() => {});
    }
    finally { await context.close(); }
  }
  return {runs, failures};
}
