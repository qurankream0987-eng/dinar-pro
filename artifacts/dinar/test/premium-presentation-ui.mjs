// Additional visual acceptance, using Command E's real authenticated application context.
// Does not mock a conversation, card, cart or API response.
export async function verifyPremiumPresentation({ browser, contextFor, openConversation, measure, out }) {
  const runs = [];
  const failures = [];
  for (const viewport of [{ width: 390, height: 800 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    for (const preference of ["no-preference", "reduce"]) {
      const context = await contextFor(browser, viewport.width, "dark", "buyer");
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: preference });
      await page.addInitScript(() => {
        window.__entranceFrames = [];
        window.__frameIntervals = [];
        window.__layoutShift = 0;
        let last;
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__layoutShift += entry.value; }).observe({ type: 'layout-shift', buffered: true });
        const frame = (time) => {
          if (last) window.__frameIntervals.push(time - last);
          last = time;
          const el = document.querySelector(".ai-welcome");
          if (el) window.__entranceFrames.push(Number(getComputedStyle(el).opacity));
          if (window.__entranceFrames.length < 90) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await openConversation(page, "buyer", null);
      await page.waitForFunction(() => {
        const el = document.querySelector(".ai-welcome");
        return el && Number(getComputedStyle(el).opacity) >= .999;
      });
      const initialLayout = await page.evaluate(measure);
      const entrance = await page.evaluate(() => window.__entranceFrames);
      const performance = await page.evaluate(() => ({ frameIntervals: window.__frameIntervals, layoutShift: window.__layoutShift, heapBytes: window.performance.memory?.usedJSHeapSize ?? null, blurSurfaces: [...document.querySelectorAll('*')].filter(el => getComputedStyle(el).backdropFilter !== 'none').length }));
      const composer = page.getByTestId("input-ai-composer");
      const beforeFocus = await page.locator('.ai-composer-box').evaluate(el => ({ border: getComputedStyle(el).borderColor, shadow: getComputedStyle(el).boxShadow }));
      await composer.focus();
      await page.keyboard.type("اختبار الكتابة");
      const focus = await composer.evaluate(el => ({ active: document.activeElement === el, outline: getComputedStyle(el).outlineStyle, value: el.value }));
      await page.waitForTimeout(180);
      const afterFocus = await page.locator('.ai-composer-box').evaluate(el => ({ border: getComputedStyle(el).borderColor, shadow: getComputedStyle(el).boxShadow }));
      const focusedLayout = await page.evaluate(measure);
      await composer.fill("");
      await page.screenshot({ path: `${out}/premium-${viewport.width}x${viewport.height}-${preference}.png` });
      await page.locator('.premium-action-card').first().hover();
      // Sample RAF without screenshots, full-DOM style walks or test polling in the window.
      performance.interactionFrameIntervals = await page.evaluate(() => new Promise(resolve => {
        const intervals = []; let last;
        const sample = time => { if (last) intervals.push(time-last); last=time; if (intervals.length >= 90) resolve(intervals); else requestAnimationFrame(sample); };
        requestAnimationFrame(sample);
      }));
      const reduced = await page.evaluate(() => [...document.querySelectorAll(".ai-welcome, .ai-starter, .ai-composer-box")].every(el => getComputedStyle(el).transitionDuration.split(",").every(t => parseFloat(t) === 0) && getComputedStyle(el).animationName === "none"));
      const check = (ok, label) => { if (!ok) failures.push(`premium ${viewport.width}/${preference}: ${label}`); };
      check(initialLayout.scrollOverflow <= 1 && !initialLayout.overflowing.length, "initial viewport overflow");
      check(initialLayout.composerVisible && focusedLayout.composerVisible, "composer must stay visible before and during typing");
      check(focus.active && focus.value === "اختبار الكتابة" && (focus.outline !== "none" || beforeFocus.border !== afterFocus.border || beforeFocus.shadow !== afterFocus.shadow), "visible keyboard focus and responsive input");
      check(!initialLayout.unnamed.length && !errors.length, "named controls and no page errors");
      check(preference === "reduce" ? entrance.every(n => n >= .999) && reduced : entrance.some(n => n < .99), "motion preference must control visible entrance");
      runs.push({ viewport, preference, initialLayout, focusedLayout, focus, beforeFocus, afterFocus, entrance, performance, reduced, errors });
      await context.close();
    }
  }
  return { runs, failures };
}
