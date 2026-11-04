import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder } from "./sc-ui-session.mjs";
import { settleToasts, startConversation } from "./w02u3-ui-session.mjs";

/**
 * Wave 03 D7 — the conversation cart acknowledgement in a real browser.
 *
 * The product thumbnail may fly to the basket only after the canonical REST action returns 2xx.
 * The journey proves the pending state, the confirmed flight, its absence on a failed request, the
 * reduced-motion opt-out, keyboard activation, RTL at phone and desktop widths, the sponsored
 * disclosure and reload consistency. It never fakes a cart mutation: every quantity it reports is
 * read back from the API.
 */
const webBase = process.env.WAVE03_WEB_BASE;
const apiOrigin = process.env.WAVE03_API_ORIGIN;
const buyer = {
  id: process.env.WAVE03_BUYER_ID,
  cookie: process.env.WAVE03_BUYER_COOKIE,
  phone: process.env.WAVE03_BUYER_PHONE,
  password: process.env.WAVE03_PASSWORD,
};
const listings = JSON.parse(process.env.WAVE03_LISTINGS ?? "[]");
const resultPath = process.env.WAVE03_RESULT_PATH;
if (!webBase || !apiOrigin || !buyer.id || !buyer.cookie || !buyer.phone || !buyer.password || !resultPath || listings.length !== 3)
  throw new Error("Missing Wave 03 D7 browser journey configuration.");

const [normalListing, reducedListing, desktopListing] = listings;
const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const observations = {
  normal: {},
  reduced: {},
  desktop: {},
  conversations: {},
};
let failure;
let browser;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function watch(page, label) {
  page.on("pageerror", (error) => recorder.pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") recorder.consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || recorder.allowedHosts.has(url.host) || recorder.fontHosts.has(url.hostname)) return;
    recorder.externalRequests.push(`${label}: ${url.hostname}${url.pathname}`);
  });
}

async function openPass(label, viewport, reducedMotion) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport,
    isMobile: viewport.width < 800,
    hasTouch: viewport.width < 800,
    locale: "ar",
    reducedMotion,
  });
  const separator = buyer.cookie.indexOf("=");
  await context.addCookies([
    {
      name: buyer.cookie.slice(0, separator),
      value: buyer.cookie.slice(separator + 1),
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  // Requests stay same-origin through the web server's /api proxy, exactly like the built
  // deployment. Buffering the turn's SSE response through route.fetch would stall it.
  const page = await context.newPage();
  watch(page, label);
  return { context, page };
}

async function backend(path) {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    headers: { cookie: buyer.cookie },
  });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}

async function cartQuantity(listingId) {
  const cart = await backend("/cart");
  return (cart.find((item) => item.listingId === listingId) ?? {}).quantity ?? 0;
}

async function visibleBadge(page) {
  const badge = page.locator('[data-testid="badge-cart-units"]:visible').first();
  return (await badge.count()) ? (await badge.innerText()).trim() : "0";
}

function probes() {
  window.__wave03 = { states: [], flights: [] };
  const read = (testId) => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!element) return;
    window.__wave03.states.push({
      busy: element.getAttribute("aria-busy"),
      disabled: element.disabled === true,
      label: element.getAttribute("aria-label"),
    });
  };
  const testId = window.__wave03TestId;
  read(testId);
  const observer = new MutationObserver(() => read(testId));
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-busy", "disabled", "aria-label"],
  });
  for (const [kind, event] of [
    ["start", "dinar:cart-flight-start"],
    ["skipped", "dinar:cart-flight-skipped"],
    ["end", "dinar:cart-flight-end"],
  ])
    document.addEventListener(event, (detail) => window.__wave03.flights.push({ kind, detail: detail.detail }));
}

async function installProbes(page, testId) {
  await page.evaluate((id) => (window.__wave03TestId = id), testId);
  await page.evaluate(probes);
}

async function searchPass(page, label, listing) {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await settleToasts(page);
  const conversationId = await startConversation(page);
  await sendSearch(page, listing.title);
  const card = page.getByTestId(`card-ai-result-${listing.id}`);
  await card.waitFor({ state: "visible", timeout: 45_000 });
  // The results container carries the canonical id; `ai-results-more` is a descendant that
  // shares the testid prefix but not the attribute.
  const resultSetId = await page
    .locator("[data-result-set-id]:visible")
    .last()
    .getAttribute("data-result-set-id");
  assert.ok(resultSetId, `${label}: the result card carries its canonical result-set id`);
  observations.conversations[label] = { conversationId, resultSetId };
  return { conversationId, resultSetId, card, add: page.getByTestId(`button-add-to-cart-${listing.id}`) };
}

/** The shared turn waiter expects the assistant count to grow; search is the only text we send. */
async function sendSearch(page, title) {
  const before = await page.locator('[data-testid^="message-assistant-"]').count();
  await page.getByTestId("input-ai-composer").fill(`ابحث عن ${title}`);
  await page.getByTestId("button-send-ai-message").click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  recorder.steps.push({ said: `ابحث عن ${title}` });
}

async function waitForFlight(page, kind, timeout = 10_000) {
  await page.waitForFunction(
    (expected) => window.__wave03?.flights?.some((flight) => flight.kind === expected),
    kind,
    { timeout },
  );
}

async function addAndWait(page, { add, conversationId, label, expectedStatus = 200, beforeMessages }) {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/ai/conversations/${conversationId}/actions/add-to-cart` &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await add.click();
  const response = await responsePromise;
  assert.equal(response.status(), expectedStatus, `${label}: add-to-cart answered ${await response.text()}`);
  if (beforeMessages !== undefined) {
    const after = await page.locator('[data-testid^="message-assistant-"]').count();
    assert.equal(after, beforeMessages, `${label}: a failed add appends no success message`);
  }
  return response;
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });

  // 1) Phone 390px, normal motion: sponsored disclosure, pending state, confirmed flight.
  const normal = await openPass("cart-normal", { width: 390, height: 844 }, "no-preference");
  {
    const { page } = normal;
    const { conversationId, card, add } = await searchPass(page, "normal", normalListing);
    const doc = await page.evaluate(() => ({
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
    }));
    assert.equal(doc.dir, "rtl", "the conversation is RTL");
    assert.equal(doc.lang, "ar", "the document is Arabic");
    await page.waitForFunction(
      (id) => {
        const image = document.querySelector(`[data-testid="card-ai-result-${id}"] img`);
        return image && image.complete && image.naturalWidth > 0;
      },
      normalListing.id,
      { timeout: 30_000 },
    );
    const image = await card.locator("img").first().evaluate((node) => ({
      src: node.getAttribute("src"),
      naturalWidth: node.naturalWidth,
    }));
    assert.match(image.src, /\/api\/storage\/objects\/listing-photos\//, "the card renders the canonical stored photo");
    const sponsored = card.getByTestId(`label-sponsored-${normalListing.id}`);
    assert.equal(await sponsored.innerText(), "إعلان ممول", "the sponsored result is disclosed");
    observations.normal.imageSrc = image.src;
    observations.normal.sponsoredDisclosure = "إعلان ممول";

    await installProbes(page, `button-add-to-cart-${normalListing.id}`);
    await addAndWait(page, { add, conversationId, label: "normal" });
    await waitForFlight(page, "start");
    assert.equal(await page.getByTestId("cart-flight").count(), 1, "the thumbnail flies after the server confirms");
    await waitForFlight(page, "end", 15_000);
    assert.equal(await page.getByTestId("cart-flight").count(), 0, "the flight leaves the DOM when it ends");
    const states = await page.evaluate(() => window.__wave03.states);
    assert.ok(
      states.some((state) => state.busy === "true" && state.disabled),
      `the add control is busy and disabled while the request is in flight: ${JSON.stringify(states)}`,
    );
    assert.ok(
      states.some((state) => state.label === "جارٍ الإضافة إلى السلة"),
      "the busy control announces its state in Arabic",
    );
    assert.equal(await visibleBadge(page), "1", "the server-confirmed add updates the cart badge");
    assert.equal(await cartQuantity(normalListing.id), 1, "the canonical cart holds one unit");
    const flightsBeforeRepeat = (await page.evaluate(() => window.__wave03.flights)).length;
    const repeatResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/ai/conversations/${conversationId}/actions/add-to-cart` &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await add.click();
    assert.equal((await repeatResponse).status(), 200, "a repeated tap reads the stored receipt back");
    await sleep(400);
    assert.equal(
      (await page.evaluate(() => window.__wave03.flights)).length,
      flightsBeforeRepeat,
      "a repeated confirmation of the same card never animates again",
    );
    assert.equal(await visibleBadge(page), "1", "a repeated confirmation adds no second unit");
    assert.equal(await cartQuantity(normalListing.id), 1, "the retry leaves the canonical quantity at one");
    const receipts = (await backend(`/ai/conversations/${conversationId}`)).messages
      .flatMap((message) => message.blocks ?? [])
      .filter((block) => block?.payload?.surface === "CART");
    assert.equal(receipts.length, 1, "the confirmed add is stored once in the conversation");
    observations.normal = {
      ...observations.normal,
      conversationId,
      busyObserved: true,
      flightStarted: true,
      flightRemoved: true,
      repeatFlightCount: 0,
      badge: "1",
      cartQuantity: 1,
      receiptCount: receipts.length,
    };
    checks.push("phone: sponsored disclosure, real stored photo, pending state and a confirmed basket flight at 390px RTL");
  }

  // 2) Phone with reduced motion: the cart changes, the flight is skipped.
  const reduced = await openPass("cart-reduced", { width: 390, height: 844 }, "reduce");
  {
    const { page } = reduced;
    const { conversationId, add } = await searchPass(page, "reduced", reducedListing);
    await installProbes(page, `button-add-to-cart-${reducedListing.id}`);
    await addAndWait(page, { add, conversationId, label: "reduced" });
    await waitForFlight(page, "skipped");
    const flights = await page.evaluate(() => window.__wave03.flights);
    assert.equal(flights[0].detail?.reason, "reduced-motion", "the opt-out is reported by reason");
    assert.equal(await page.getByTestId("cart-flight").count(), 0, "no flight is drawn under reduced motion");
    assert.equal(await visibleBadge(page), "2", "the second confirmed add reaches the badge");
    assert.equal(await cartQuantity(reducedListing.id), 1, "the reduced-motion add still commits on the server");
    observations.reduced = {
      conversationId,
      skippedReason: flights[0].detail?.reason,
      badge: "2",
      cartQuantity: 1,
    };
    checks.push("phone: prefers-reduced-motion skips the flight while the canonical cart still commits");
  }

  // 3) Desktop: a failed canonical add shows the error, no flight, no cart or message change.
  const desktop = await openPass("cart-desktop", { width: 1440, height: 900 }, "no-preference");
  {
    const { page } = desktop;
    const { conversationId, add } = await searchPass(page, "desktop", desktopListing);
    await page.route(
      (url) => url.pathname === `/api/ai/conversations/${conversationId}/actions/add-to-cart`,
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "تعذر إضافة العرض إلى السلة الآن" }),
        });
      },
    );
    await installProbes(page, `button-add-to-cart-${desktopListing.id}`);
    const messagesBefore = await page.locator('[data-testid^="message-assistant-"]').count();
    await addAndWait(page, { add, conversationId, label: "desktop-failure", expectedStatus: 500, beforeMessages: messagesBefore });
    const alert = page.locator('[role="alert"]').first();
    await alert.waitFor({ state: "visible", timeout: 15_000 });
    await sleep(400);
    const flights = await page.evaluate(() => window.__wave03.flights);
    assert.deepEqual(flights, [], "a failed add triggers neither a flight nor a skip");
    assert.equal(await page.getByTestId("cart-flight").count(), 0, "no thumbnail is in flight after a failure");
    assert.equal(await visibleBadge(page), "2", "a failed add leaves the badge unchanged");
    assert.equal(await cartQuantity(desktopListing.id), 0, "a failed add leaves the canonical cart unchanged");
    observations.desktop = {
      conversationId,
      failureAlert: (await alert.innerText()).trim().slice(0, 120),
      flightCount: 0,
      badge: "2",
      cartQuantity: 0,
    };
    checks.push("desktop: a failed canonical add shows an error and never animates or changes the cart");

    // Keyboard activation after the failure: the same control now succeeds and flies.
    // unroute() compares URLs by value, so a predicate route is not removable by identity;
    // removing every route on this page is exact here because the failure pass added the only one.
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(() => (window.__wave03 = { states: [], flights: [] }));
    await add.focus();
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      `button-add-to-cart-${desktopListing.id}`,
      "the add control takes keyboard focus",
    );
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/ai/conversations/${conversationId}/actions/add-to-cart` &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page.keyboard.press("Enter");
    const response = await responsePromise;
    assert.equal(response.status(), 200, "keyboard activation reaches the canonical action");
    await waitForFlight(page, "start");
    await waitForFlight(page, "end", 15_000);
    assert.equal(await visibleBadge(page), "3", "the keyboard-confirmed add reaches the badge");
    assert.equal(await cartQuantity(desktopListing.id), 1, "the keyboard add is one canonical unit");
    await page.reload();
    await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="badge-cart-units"]'), null, { timeout: 30_000 });
    assert.equal(await visibleBadge(page), "3", "reload restores the server cart, not a local count");
    assert.equal(await cartQuantity(desktopListing.id), 1, "reload never duplicates the confirmed add");
    observations.desktop = {
      ...observations.desktop,
      keyboardFlight: true,
      badgeAfterKeyboard: "3",
      badgeAfterReload: "3",
      cartQuantityAfterReload: 1,
    };
    checks.push("desktop: Enter on the focused add control confirms once, flies once, and reload keeps the server cart");
  }
} catch (error) {
  failure = error?.stack ?? String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        failure,
        observations,
        pageErrors: recorder.pageErrors,
        consoleErrors: recorder.consoleErrors,
        externalRequests: recorder.externalRequests,
        modelFallbacks: recorder.modelFallbacks,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => undefined);
}
