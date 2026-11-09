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
        if (actor === 'buyer' && id === 'code') {
          const savedDraft = await input.inputValue();
          await page.getByTestId('link-cart').first().click();
          await page.waitForURL('**/cart');
          await page.goBack();
          await input.waitFor({ state: 'visible' });
          await page.waitForFunction(value => document.querySelector('[data-testid="input-ai-composer"]')?.value === value, savedDraft);
          await page.goForward();
          await page.waitForURL('**/cart');
          await page.goBack();
          await input.waitFor({ state: 'visible' });
          await page.waitForFunction(value => document.querySelector('[data-testid="input-ai-composer"]')?.value === value, savedDraft);
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
