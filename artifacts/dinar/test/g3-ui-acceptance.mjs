import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

/**
 * G3 — premium conversational UI, connected journeys in the production build against the
 * real API and a disposable database. Every check is recorded by its G3 id; a failure is
 * recorded and the run continues, so the report shows the whole picture.
 */
const webBase = process.env.G3_WEB_BASE;
const apiOrigin = process.env.G3_API_ORIGIN;
const cookies = JSON.parse(process.env.G3_COOKIES ?? "{}");
const ids = JSON.parse(process.env.G3_IDS ?? "{}");
const TOKEN = process.env.G3_TOKEN;
const city = process.env.G3_CITY;
const coords = JSON.parse(process.env.G3_COORDS ?? "{}");
const resultPath = process.env.G3_RESULT_PATH;
if (!webBase || !apiOrigin || !TOKEN || !city || !resultPath) throw new Error("Missing G3 browser acceptance configuration.");

const WIDTHS = [320, 360, 390, 414];
const checks = [];
const results = {};
const failures = {};
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
let expectedResourceErrors = 0;
let expectedConflictErrors = 0;
let guestMarketGate;
let staleMarketSelection;
const counters = {
  horizontalOverflow: 0,
  clippedPrimaryActions: 0,
  composerObstruction: 0,
  unreachableButtons: 0,
  pageErrors: 0,
  unexpectedConsoleErrors: 0,
  unexpectedExternalRequests: 0,
  falseBusinessSuccess: 0,
  falsePaymentSuccess: 0,
  falseTrustClaims: 0,
  secretUrlLeaks: 0,
  secretConsoleLeaks: 0,
  secretResurrections: 0,
  preciseLocationTextLeaks: 0,
  authPhoneLeaks: 0,
  xssExecutions: 0,
  staleSurfaces: 0,
  technicalErrorLeaks: 0,
};
const widths = Object.fromEntries([...WIDTHS, 1280].map((width) => [width, "PASS"]));
let browser;
let page;
const contexts = [];
const consoleTexts = [];
const urlsSeen = [];
const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

async function record(id, name, body) {
  try {
    await body();
    results[id] = "PASS";
    checks.push(`${id} ${name}`);
  } catch (error) {
    results[id] = "FAIL";
    const last = await latestAssistant().innerText({ timeout: 2000 }).catch(() => "");
    const location = error instanceof Error ? error.stack?.split("\n").slice(1, 3).join(" ").trim() : "";
    failures[id] = `${error instanceof Error ? error.message.split("\n")[0] : String(error)}${location ? ` @ ${location}` : ""} || LAST: ${last.replace(/\s+/g, " ").slice(0, 400)}`;
  }
}
/** A journey passes only when every check nested in it passed. */
function nestedPassed(...keys) {
  const failed = keys.filter((key) => results[key] !== "PASS");
  assert.equal(failed.length, 0, `nested checks failed: ${failed.join(", ")}`);
}

async function settle() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const assistantMessages = () => page.locator('[data-testid^="message-assistant-"]');
const latestAssistant = () => assistantMessages().last();
async function waitForTurn(before) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="message-assistant-"]').length > count &&
      document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    before,
    { timeout: 60_000 },
  );
  await settle();
}
async function sendTurn(text) {
  const before = await assistantMessages().count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await waitForTurn(before);
  return latestAssistant();
}
async function clickTurn(locator) {
  const before = await assistantMessages().count();
  await locator.click();
  await waitForTurn(before);
  return latestAssistant();
}
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ");
/** The answer to the first missing draft field (the one DINAR is asking for). */
function answerFor(missingText) {
  const first = missingText.replace(/^.*?ناقص:\s*/, "").split("،")[0]?.trim() ?? "";
  return /التصنيف/.test(first) ? "أزياء" : /المنطقة/.test(first) ? city : /التواصل/.test(first) ? "محادثة فقط" : /الكمية/.test(first) ? "قطعة واحدة" : /طرق الدفع|الدفع/.test(first) ? "كاش" : "انتهيت";
}

/** Layout invariants for one surface at one width; each violation is counted. */
async function measure(label, width, visible) {
  await page.setViewportSize({ width, height: width >= 1000 ? 900 : 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    direction: getComputedStyle(document.querySelector(".dinar-chatgpt") ?? document.documentElement).direction,
  }));
  const problems = [];
  if (dimensions.scrollWidth > dimensions.width) {
    counters.horizontalOverflow++;
    problems.push(`horizontal overflow ${dimensions.scrollWidth}>${dimensions.width}`);
  }
  if (dimensions.direction !== "rtl") problems.push("not RTL");
  const composer = await page.getByTestId("input-ai-composer").boundingBox();
  if (!composer || composer.y < 0 || composer.y + composer.height > dimensions.height) {
    counters.composerObstruction++;
    problems.push("composer not fully visible");
  }
  await visible.evaluate((element) => element.scrollIntoView({ block: "nearest", behavior: "instant" }));
  await settle();
  const box = await visible.boundingBox();
  if (!box || box.x < -0.5 || box.x + box.width > dimensions.width + 0.5) {
    counters.clippedPrimaryActions++;
    problems.push(`surface clipped ${JSON.stringify(box)}`);
  }
  const layout = await visible.evaluate((element) => {
    const inCarousel = (node) => node.closest('[role="region"][data-testid^="ai-results-carousel-"]');
    // Any other intentional swipe row (the narrow-screen comparison cards) scrolls inside itself.
    const inSwipeRow = (node) => {
      const region = node.parentElement?.closest('[role="region"]');
      return Boolean(region && ["auto", "scroll"].includes(getComputedStyle(region).overflowX));
    };
    const outside = [element, ...element.querySelectorAll("*")].filter((node) => {
      if (inCarousel(node) || inSwipeRow(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.right > window.innerWidth + 0.5 || rect.left < -0.5);
    }).length;
    const dock = document.querySelector(".dinar-chat-dock")?.getBoundingClientRect();
    const buttons = [...element.querySelectorAll("button")]
      .filter((node) => !inCarousel(node) && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
      .map((node) => {
        node.scrollIntoView({ block: "center", behavior: "instant" });
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          name: node.getAttribute("aria-label") || node.textContent?.trim() || "",
          height: rect.height,
          width: rect.width,
          reachable: Boolean(hit && (hit === node || node.contains(hit))),
          underDock: Boolean(dock && rect.top + rect.height / 2 > dock.top),
          hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 60)}[${hit.getAttribute("data-testid") ?? ""}] rect=${Math.round(rect.top)}/${Math.round(rect.left)} dock=${Math.round(dock?.top ?? -1)} vh=${window.innerHeight}` : "none",
        };
      });
    return { outside, buttons };
  });
  if (layout.outside) {
    counters.clippedPrimaryActions++;
    problems.push(`${layout.outside} descendants outside the viewport`);
  }
  for (const button of layout.buttons) {
    if (!button.name) problems.push("unnamed button");
    if (button.height < 32) problems.push(`small touch target «${button.name}» ${button.height}px`);
    if (!button.reachable || button.underDock) {
      counters.unreachableButtons++;
      problems.push(`unreachable «${button.name}» (${button.hit})`);
    }
  }
  if (problems.length) {
    widths[width] = "FAIL";
    throw new Error(`${label} ${width}px: ${problems.join("; ")}`);
  }
  checks.push(`${label} ${width}px: RTL, no overflow, composer visible, named reachable buttons`);
}
async function mobile(label, visible) {
  for (const width of WIDTHS) await measure(label, width, visible);
  // Opt-in visual evidence: the measured card itself at a phone and a desktop width, both themes.
  if (process.env.G3_SHOTS) {
    const name = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await settle();
        await visible.scrollIntoViewIfNeeded();
        await visible.screenshot({ path: `${process.env.G3_SHOTS}/${name}-${width}-${scheme}.png` });
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
}

async function newConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const button = page.locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible').first();
  if (!(await button.isVisible())) await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ai/conversations" && response.request().method() === "POST");
  await button.click();
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
}

async function openSession(cookie) {
  const context = await browser.newContext({ baseURL: webBase, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar" });
  contexts.push(context);
  if (cookie) {
    const separator = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(webBase).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  }
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    try {
      await route.fulfill({ response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }) });
    } catch {
      // The page navigated or reloaded while this request was in flight.
      await route.abort().catch(() => undefined);
    }
  });
  const opened = await context.newPage();
  opened.on("pageerror", (error) => pageErrors.push(error.message));
  opened.on("dialog", async (dialog) => {
    counters.xssExecutions++;
    await dialog.dismiss();
  });
  opened.on("console", (message) => {
    consoleTexts.push(message.text());
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  opened.on("framenavigated", (frame) => urlsSeen.push(frame.url()));
  opened.on("request", (request) => {
    urlsSeen.push(request.url());
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host) || fontHosts.has(url.hostname)) return;
    externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  return opened;
}

/** The server's view of the current conversation, through the same session. */
async function serverConversation() {
  // The most recently updated conversation is the one just used.
  const list = await page.evaluate(async () => (await (await fetch("/api/ai/conversations", { credentials: "include" })).json()));
  const conversationId = list[0]?.id;
  const response = await page.evaluate(async (cid) => {
    const reply = await fetch(`/api/ai/conversations/${cid}`, { credentials: "include" });
    return { status: reply.status, body: await reply.json() };
  }, conversationId);
  return response;
}
const latestListingBlock = (conversation) =>
  conversation.body.messages.flatMap((message) => message.blocks).filter((block) => block.type === "LISTING_RESULTS").at(-1);
const xssFlag = () => page.evaluate(() => window.__xss);
async function chatText() {
  return (await page.locator("main, body").first().innerText()).replace(/\s+/g, " ");
}
const TRUST_CLAIMS = /موثق من الحكومة|تم التحقق من الهوية|فحص أمني|تتبع مباشر|سائق مضمون|شهادة موثقة|مهارة موثقة|مرشح موثق/;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const uiSellerListingIds = {};
let tutorialBrowser;

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });

  await record("G3-31", "guest selects an active market and resumes the same search exactly once", async () => {
    page = await openSession("");
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor();

    const preview = async (message) =>
      page.evaluate(async (text) => {
        const response = await fetch("/api/ai/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, marketId: "KW" }),
        });
        return { status: response.status, body: await response.json() };
      }, message);

    const search = await preview("ابحث عن كاميرا");
    assert.equal(search.status, 200, JSON.stringify(search.body));
    assert.equal(search.body.blocks?.[0]?.payload?.surface, "MARKET_SELECTOR");

    const sellerIntent = await preview("I want to sell a camera");
    assert.equal(sellerIntent.status, 200, JSON.stringify(sellerIntent.body));
    assert.equal(
      sellerIntent.body.blocks?.[0]?.payload?.surface,
      "MARKET_SELECTOR",
      "market-bound seller intent waits for an explicit active-market choice",
    );
    assert.equal(sellerIntent.body.requiresAuth, undefined);

    const sellerAdvice = await preview("وش أبيع؟");
    assert.equal(sellerAdvice.status, 200, JSON.stringify(sellerAdvice.body));
    assert.match(sellerAdvice.body.body, /رأي عام للنقاش/);
    assert.ok(
      !(sellerAdvice.body.blocks ?? []).some((block) =>
        block.type === "LISTING_RESULTS" || block.payload?.guestSellerIntent === true,
      ),
      "seller advice did not search or start a listing draft",
    );

    const previewRequests = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/ai/preview")
      ) {
        try {
          previewRequests.push(JSON.parse(request.postData() ?? "{}"));
        } catch {
          // Ignore unrelated or malformed requests; the assertions below fail clearly.
        }
      }
    });
    await page.getByTestId("input-ai-composer").fill("ابحث عن كاميرا");
    await page.getByTestId("button-send-ai-message").click();
    await page.getByTestId("card-market-selector").waitFor();
    await page.getByTestId("button-inline-market-JO").click();
    await page
      .getByTestId("card-market-selector")
      .waitFor({ state: "detached", timeout: 30_000 });
    const userMessageCount = await page.locator('[data-role="user"]').count();
    const selectedMarket = await page.evaluate(async () =>
      (await (await fetch("/api/auth/me", { credentials: "include" })).json())
        .marketId,
    );
    const resumedSearchRequests = previewRequests.filter(
      (request) => request.message === "ابحث عن كاميرا",
    );
    assert.deepEqual(
      resumedSearchRequests.map((request) => request.marketId),
      ["KW", "JO"],
      "the original turn is replayed once against the explicitly selected market",
    );
    assert.equal(resumedSearchRequests[1]?.resourceIds, undefined);
    assert.equal(
      userMessageCount,
      1,
      `the user turn is not duplicated in the transcript (found ${userMessageCount})`,
    );
    assert.equal(selectedMarket, "JO", "the server retains the guest's validated choice");
    const sellerResumed = await page.evaluate(async () => {
      const response = await fetch("/api/ai/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: "I want to sell a camera",
          marketId: "JO",
        }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(sellerResumed.status, 200, JSON.stringify(sellerResumed.body));
    assert.equal(sellerResumed.body.requiresAuth, true);
    assert.equal(
      sellerResumed.body.blocks?.[0]?.payload?.surface,
      "SELL",
    );
    assert.equal(
      sellerResumed.body.blocks?.[0]?.payload?.guestSellerIntent,
      true,
      "the seller intent is held for authentication without creating a draft",
    );

    guestMarketGate = {
      marketId: "KW",
      searchStatus: search.status,
      sellerIntentStatus: sellerIntent.status,
      sellerIntentSurface: sellerIntent.body.blocks?.[0]?.payload?.surface,
      sellerIntentStartedDraft: false,
      sellerAdviceStatus: sellerAdvice.status,
      selectedMarketId: selectedMarket,
      resumedMarketId: resumedSearchRequests[1]?.marketId,
      resumedUserMessageCount: userMessageCount,
      sellerResumeRequiresAuth: sellerResumed.body.requiresAuth,
      sellerResumeSurface: sellerResumed.body.blocks?.[0]?.payload?.surface,
    };
  });

  await record("G3-32", "stale guest market selection refreshes choices without replaying intent", async () => {
    page = await openSession("");
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor();
    const initialMarkets = await page.evaluate(async () =>
      (await (await fetch("/api/markets")).json())
        .filter((market) => market.isActive)
        .map((market) => market.id),
    );
    assert.ok(initialMarkets.includes("JO"), "Jordan is initially selectable");

    const previewRequests = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/ai/preview")
      ) {
        try {
          previewRequests.push(JSON.parse(request.postData() ?? "{}"));
        } catch {
          // The assertions below report an unexpected request shape.
        }
      }
    });

    let staleChoicePatchCount = 0;
    let catalogRefreshCount = 0;
    let refreshedAvailableIds = [];
    await page.route("**/api/account/market", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      staleChoicePatchCount++;
      expectedConflictErrors++;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "هذا السوق غير متاح للتصفح حاليًا. اختر سوقًا نشطًا بسعر وحدة معتمد.",
        }),
      });
    });
    await page.route("**/api/markets", async (route) => {
      catalogRefreshCount++;
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"])
        delete headers[header];
      headers.origin = apiOrigin;
      headers.referer = `${apiOrigin}/`;
      const response = await route.fetch({
        url: `${apiOrigin}${url.pathname}${url.search}`,
        headers,
      });
      const closeMarket = staleChoicePatchCount > 0;
      const markets = (await response.json()).map((market) =>
        closeMarket && market.id === "JO"
          ? { ...market, isActive: false, status: "COMING_SOON", priceConfigured: false }
          : market,
      );
      refreshedAvailableIds = markets
        .filter(
          (market) =>
            market.isActive &&
            ["ACTIVE", "LIMITED"].includes(market.status) &&
            market.priceConfigured &&
            market.unitPriceMinor >= 1,
        )
        .map((market) => market.id)
        .sort();
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify(markets),
      });
    });

    await page.getByTestId("input-ai-composer").fill("ابحث عن كاميرا");
    await page.getByTestId("button-send-ai-message").click();
    await page.getByTestId("card-market-selector").waitFor();
    await page.getByTestId("button-inline-market-JO").click();
    await page.locator('[role="alert"]').first().waitFor();
    console.log(
      "STALE_MARKET_SELECTION_BROWSER",
      JSON.stringify({
        staleChoicePatchCount,
        catalogRefreshCount,
        previewMarketIds: previewRequests.map((request) => request.marketId),
      }),
    );
    await page.getByTestId("button-inline-market-JO").waitFor({ state: "detached" });
    await page.getByTestId("card-market-selector").waitFor();

    const selectedMarketAfter = await page.evaluate(async () =>
      (await (await fetch("/api/auth/me", { credentials: "include" })).json()).marketId,
    );
    const userMessages = await page.locator('[data-role="user"]').allInnerTexts();
    const displayedMarketIds = await page
      .locator('[data-testid^="button-inline-market-"]')
      .evaluateAll((nodes) =>
        nodes
          .map((node) =>
            (node.getAttribute("data-testid") ?? "").replace("button-inline-market-", ""),
          )
          .sort(),
      );
    assert.equal(staleChoicePatchCount, 1);
    assert.equal(
      catalogRefreshCount,
      1,
      "the stale-selection rejection refreshes the catalog",
    );
    assert.deepEqual(displayedMarketIds, refreshedAvailableIds);
    assert.deepEqual(
      previewRequests.map((request) => request.marketId),
      ["KW"],
      "the rejected selection does not replay the search",
    );
    assert.equal(selectedMarketAfter, "KW", "the guest is not silently switched");
    assert.equal(userMessages.length, 1, "the original user intent remains single");
    assert.match(userMessages[0] ?? "", /ابحث عن كاميرا/);
    if (refreshedAvailableIds.length === 0)
      await page.getByText("لا يوجد سوق متاح للاختيار حاليًا.", { exact: true }).waitFor();

    staleMarketSelection = {
      staleChoiceStatus: 409,
      selectedMarketAfter,
      previewMarketIds: previewRequests.map((request) => request.marketId),
      originalIntentCount: userMessages.length,
      displayedMarketIds,
      refreshedAvailableIds,
    };
  });

  // ════ Seller ════
  page = await openSession(cookies.seller);
  await newConversation();

  await record("G3-04", "image attachment: local preview, remove, failed upload keeps text and photo, retry", async () => {
    const fileInput = page.locator('form[aria-label="إرسال رسالة"] input[type="file"]');
    await fileInput.setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: PNG }]);
    const preview = page.getByRole("img", { name: "معاينة صورة الإعلان 1" });
    await preview.waitFor();
    assert.match(await preview.getAttribute("src"), /^blob:/, "a local preview; no storage path");
    const remove = page.getByRole("button", { name: "إزالة الصورة 1" });
    assert.ok((await remove.boundingBox()).height >= 32, "remove target ≥ 32px");
    await remove.click();
    await preview.waitFor({ state: "detached" });
    await fileInput.setInputFiles([{ name: "b.png", mimeType: "image/png", buffer: PNG }]);
    await page.getByRole("img", { name: "معاينة صورة الإعلان 1" }).waitFor();
    await page.route("**/api/account/listing-photos/upload-url", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: 'error: relation "listing_photos" does not exist at /home/runner/workspace/src/x.ts:12' }) }),
    );
    expectedResourceErrors++;
    await page.getByTestId("input-ai-composer").fill("أريد أبيع هذه الصورة");
    await page.getByTestId("button-send-ai-message").click();
    const alert = page.locator('.dinar-chat-dock [role="alert"]');
    await alert.waitFor();
    const alertText = await textOf(alert);
    if (/relation|\/home\/|\.ts:|stack|SQL/i.test(alertText)) counters.technicalErrorLeaks++;
    assert.doesNotMatch(alertText, /relation|\/home\/|\.ts:/);
    await page.getByTestId("button-retry-ai-turn").waitFor();
    assert.equal(await page.getByTestId("input-ai-composer").inputValue(), "أريد أبيع هذه الصورة", "the text is kept");
    await page.getByRole("img", { name: "معاينة صورة الإعلان 1" }).waitFor();
    await page.unroute("**/api/account/listing-photos/upload-url");
    // Object storage is a provider boundary: send the text alone after removing the photo.
    await page.getByRole("button", { name: "إزالة الصورة 1" }).click();
    const before = await assistantMessages().count();
    await page.getByTestId("button-retry-ai-turn").click();
    await waitForTurn(before);
    const users = await page.locator('[data-testid^="message-user-"]').filter({ hasText: "أريد أبيع هذه الصورة" }).count();
    assert.equal(users, 1, "retry does not duplicate the message");
  });

  await record("G3-03", "send / processing / failure / retry / offline states are truthful", async () => {
    while (await page.getByRole("button", { name: /^إزالة الصورة/ }).count()) await page.getByRole("button", { name: /^إزالة الصورة/ }).first().click();
    // The processing state is observed as it happens: a neutral status and a busy button.
    await page.evaluate(() => {
      window.__g3Seen = { status: "", busy: false, statuses: [] };
      const observer = new MutationObserver(() => {
        const texts = [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent ?? "").filter(Boolean);
        for (const text of texts) if (!window.__g3Seen.statuses.includes(text)) window.__g3Seen.statuses.push(text);
        const status = texts.find((text) => /أجهز ردك|أبحث داخل DINAR/.test(text));
        if (status) window.__g3Seen.status = status;
        if (document.querySelector('[data-testid="button-send-ai-message"][aria-label="دينار يعمل الآن"]')) window.__g3Seen.busy = true;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      window.__g3Observer = observer;
    });
    await sendTurn(`ابحث عن لابتوب ${TOKEN}`);
    const seen = await page.evaluate(() => {
      window.__g3Observer.disconnect();
      return window.__g3Seen;
    });
    assert.ok(seen.busy, "the send button showed a busy state");
    assert.match(seen.status, /أجهز ردك|أبحث داخل DINAR/, `a neutral processing status was shown; saw ${JSON.stringify(seen.statuses)}`);
    // Every status shown while processing stays neutral, not only the one that matched.
    for (const status of seen.statuses) assert.doesNotMatch(status, /الذكاء|أفكر|يفكّ?ر|AI/, "no claimed AI reasoning");
    // A failed turn: friendly Arabic, no internals, retryable, not duplicated.
    await page.route("**/api/ai/conversations/*/turns", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "error: duplicate key value violates unique constraint at /home/runner/workspace/src/routes/ai.ts:900" }) }),
    { times: 1 });
    expectedResourceErrors++;
    await page.getByTestId("input-ai-composer").fill("اعرض لي إعلاناتي");
    await page.getByTestId("button-send-ai-message").click();
    const alert = page.locator('.dinar-chat-dock [role="alert"]');
    await alert.waitFor();
    const text = await textOf(alert);
    if (/duplicate key|\/home\/|\.ts:|constraint/.test(text)) counters.technicalErrorLeaks++;
    assert.doesNotMatch(text, /duplicate key|\/home\/|\.ts:|constraint/);
    const retry = page.getByTestId("button-retry-ai-turn");
    await retry.waitFor();
    const before2 = await assistantMessages().count();
    await retry.click();
    await waitForTurn(before2);
    assert.equal(await page.locator('[data-testid^="message-user-"]').filter({ hasText: "اعرض لي إعلاناتي" }).count(), 1);
    // Offline: a plain notice; the composer stays usable for typing.
    await page.context().setOffline(true);
    await page.getByText("أنت غير متصل").waitFor();
    await page.getByTestId("input-ai-composer").fill("رسالة محفوظة");
    await page.context().setOffline(false);
    await page.getByText("أنت غير متصل").waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("input-ai-composer").inputValue(), "رسالة محفوظة");
    await page.getByTestId("input-ai-composer").fill("");
  });

  await record("J-A", "seller: draft → price advice → edit price → review → publish only on server success", async () => {
    await newConversation();
    const draft = await sendTurn(`عندي معطف شتوي ${TOKEN} جديد بـ12 وقابل للمساومة`);
    const card = draft.getByTestId("draft-review");
    await card.waitFor();
    await record("G3-05", "seller draft typed card shows only known facts, incl. negotiable", async () => {
      await card.getByTestId("draft-field-negotiable").waitFor();
      assert.match(await textOf(card.getByTestId("draft-field-unitPrice")), /12/);
      assert.match(await textOf(card.getByTestId("draft-field-negotiable")), /يقبل عروض الأسعار/);
      assert.doesNotMatch(await textOf(card), /null|undefined|IMAGE_INFERRED|USER_DECLARED/);
      await mobile("SELL draft card", card);

      const before = await serverConversation();
      const originalDraftId = before.body.messages
        .flatMap((message) => message.blocks)
        .map((block) => block.payload.draft?.draftId)
        .find(Boolean);
      const user = await page.evaluate(async (url) =>
        (await (await fetch(url, { credentials: "include" })).json()).user,
      new URL("/api/auth/me", webBase).href);
      const openedRequest = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/ai/learning-history" &&
        response.request().method() === "POST",
      );
      await sendTurn("كيف أبيع؟");
      const tutorialCard = latestAssistant().getByTestId("tutorial-video-card");
      await tutorialCard.waitFor();
      const openedResponse = await openedRequest;
      assert.equal(openedResponse.status(), 201);
      const openedEvent = await openedResponse.json();
      assert.equal(openedEvent.tutorialId, "SELL_FIRST_LISTING");
      assert.equal(openedEvent.eventType, "TUTORIAL_OPENED");
      assert.match(await textOf(tutorialCard), /شرح صامت/);
      assert.equal(await tutorialCard.locator("video").count(), 0, "the step animation is not represented as a video");

      const reloaded = page.waitForResponse((response) =>
        new URL(response.url()).pathname.startsWith("/api/ai/conversations/") &&
        response.request().method() === "GET",
      );
      await page.reload();
      await page.getByTestId("input-ai-composer").waitFor();
      await reloaded;
      const restoredTutorial = page.getByTestId("tutorial-video-card").last();
      await restoredTutorial.waitFor();
      assert.match(await textOf(restoredTutorial), /شرح صامت/);
      const tutorialViewportWidths = [320, 375, 430, 768, 1440];
      for (const width of tutorialViewportWidths)
        await measure(`TUTORIAL ${width}px`, width, restoredTutorial);
      await page.setViewportSize({ width: 390, height: 844 });
      await settle();
      const ownHistory = await page.evaluate(async (url) =>
        (await (await fetch(url, { credentials: "include" })).json()),
      new URL("/api/ai/learning-history", webBase).href);
      assert.ok(ownHistory.some((event) => event.id === openedEvent.id));

      const sellerPage = page;
      const otherPage = await openSession(cookies.buyer);
      const otherHistory = await otherPage.evaluate(async (url) =>
        (await (await fetch(url, { credentials: "include" })).json()),
      new URL("/api/ai/learning-history", webBase).href);
      assert.equal(otherHistory.some((event) => event.id === openedEvent.id), false);
      await otherPage.context().close();
      page = sellerPage;

      const continuationRequest = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/ai/learning-history" &&
        response.request().method() === "POST",
      );
      const resumedTurn = await clickTurn(restoredTutorial.getByRole("button", { name: "فهمت" }));
      assert.equal((await continuationRequest).status(), 201);
      const continuedHistory = await page.evaluate(async (url) =>
        (await (await fetch(url, { credentials: "include" })).json()),
      new URL("/api/ai/learning-history", webBase).href);
      assert.ok(
        continuedHistory.some((event) =>
          event.tutorialId === "SELL_FIRST_LISTING" &&
          event.eventType === "CONTINUATION_TRIGGERED",
        ),
        "continuation is persisted for the signed-in seller",
      );
      const resumedCard = resumedTurn.getByTestId("draft-review");
      await resumedCard.waitFor();
      assert.match(await textOf(resumedCard.getByTestId("draft-field-title")), /معطف شتوي/);
      assert.match(await textOf(resumedCard.getByTestId("draft-field-unitPrice")), /12/);
      const resumedConversation = await serverConversation();
      const resumedDraft = resumedConversation.body.messages
        .flatMap((message) => message.blocks)
        .map((block) => block.payload)
        .find((payload) => payload.surface === "SELL" && payload.draft?.draftId === originalDraftId);
      assert.ok(resumedDraft, "the same owned draft is restored after tutorial help");
      const identity = await page.evaluate(async (url) =>
        (await (await fetch(url, { credentials: "include" })).json()),
      new URL("/api/auth/me", webBase).href);
      assert.equal(identity.user.id, user.id);
      assert.equal(identity.marketId, "JO");
      tutorialBrowser = {
        actorId: user.id,
        openedEventId: openedEvent.id,
        conversationId: resumedConversation.body.conversation.id,
        draftId: originalDraftId,
        resumedDraftId: resumedDraft.draft.draftId,
        marketId: identity.marketId,
        fallbackIsLocalAnimation: await restoredTutorial.locator("video").count() === 0,
        viewportWidths: tutorialViewportWidths,
        continuationRecorded: continuedHistory.some((event) =>
          event.tutorialId === "SELL_FIRST_LISTING" &&
          event.eventType === "CONTINUATION_TRIGGERED",
        ),
      };
      const helper = latestAssistant().getByTestId("seller-manual-helper");
      await helper.locator("summary").click();
      await helper.getByTestId("input-seller-manual-answer").fill("خلنا نحطه 11");
      const assistantCount = await assistantMessages().count();
      await helper.getByTestId("button-seller-manual-answer").click();
      await waitForTurn(assistantCount);
      const manualEdit = latestAssistant().getByTestId("draft-review");
      assert.match(await textOf(manualEdit.getByTestId("draft-field-unitPrice")), /11/);
      const after = await serverConversation();
      const resultingDraftIds = new Set(
        after.body.messages
          .flatMap((message) => message.blocks)
          .map((block) => block.payload.draft?.draftId)
          .filter(Boolean),
      );
      assert.equal(resultingDraftIds.size, 1, "manual help updates the one canonical draft");
      assert.equal([...resultingDraftIds][0], originalDraftId);
    });
    for (let index = 0; index < 5; index++) {
      const missing = latestAssistant().getByTestId("draft-missing");
      if (!(await missing.count())) break;
      await sendTurn(answerFor(await textOf(missing)));
    }
    const advice = await sendTurn("كم أحط سعر؟");
    assert.match(await textOf(advice), /داخل DINAR/);
    let edited = await sendTurn("خلنا نحطه 11");
    assert.match(await textOf(edited.getByTestId("draft-field-unitPrice")), /11/);
    for (let index = 0; index < 5; index++) {
      const missing = edited.getByTestId("draft-missing");
      if (!(await missing.count())) break;
      edited = await sendTurn(answerFor(await textOf(missing)));
    }
    const publish = edited.getByTestId("draft-publish");
    await publish.waitFor();
    const review = await clickTurn(publish);
    await record("G3-06", "publish review is visibly unexecuted; success only after the server", async () => {
      await review.getByTestId("pending-notice").waitFor();
      assert.match(await textOf(review), /هل تريد نشر الإعلان/);
      if (/تم نشر الإعلان/.test(await textOf(review))) counters.falseBusinessSuccess++;
      const mine = await page.evaluate(async () => (await (await fetch("/api/listings?own=true", { credentials: "include" })).text()));
      assert.ok(!mine.includes("معطف شتوي"), "not published before confirmation");
      await mobile("SELL publish review", review);
      const done = await clickTurn(review.getByTestId("draft-publish-confirm"));
      assert.match(await textOf(done), /تم نشر الإعلان/);
    });
    nestedPassed("G3-05", "G3-06");
  });

  async function publishUnpricedSellerJourney({ id, start, category, detail, desktop }) {
    await newConversation();
    await sendTurn(start);
    const initial = latestAssistant().getByTestId("draft-review");
    await initial.waitFor();
    for (let index = 0; index < 12; index++) {
      const missing = latestAssistant().getByTestId("draft-missing");
      if (!(await missing.count())) break;
      const text = await textOf(missing);
      const first = text.replace(/^.*?ناقص:\s*/, "").split("،")[0]?.trim() ?? "";
      let answer = answerFor(text);
      if (/التصنيف/.test(first)) answer = category;
      else if (/الكمية/.test(first)) answer = id === "service" ? "حسب الطلب" : "قطعة واحدة";
      else if (/العنوان|الوصف/.test(first)) answer = detail;
      else if (/السعر/.test(first)) answer = "بدون سعر";
      else if (/التسليم|طريقة التنفيذ/.test(first)) answer = id === "service" ? "تقديم الخدمة" : "استلام";
      else if (/الحالة/.test(first)) answer = "مستعمل";
      await sendTurn(answer);
    }
    await sendTurn("خله بدون سعر، يستقبل عروض");
    const draft = latestAssistant().getByTestId("draft-review");
    await draft.waitFor();
    const conversation = await serverConversation();
    const savedDrafts = conversation.body.messages.flatMap((message) => message.blocks)
      .map((block) => block.payload?.draft).filter(Boolean);
    const savedDraft = savedDrafts.at(-1);
    assert.equal(savedDraft?.pricingMode, "OPEN_TO_OFFERS");
    assert.equal(savedDraft?.unitPrice ?? null, null);
    assert.doesNotMatch(await textOf(draft), /500|1,000|مجاني/);
    if (desktop) await measure(`${id} seller draft`, 1280, draft);
    else await mobile(`${id} seller draft`, draft);
    const helper = latestAssistant().getByTestId("seller-manual-helper");
    assert.equal(await helper.getAttribute("open"), null, "compact helper stays optional");
    const review = await clickTurn(draft.getByTestId("draft-publish"));
    await review.getByTestId("pending-notice").waitFor();
    assert.match(await textOf(review), /هل تريد نشر الإعلان/);
    const before = await page.evaluate(async () => (await (await fetch("/api/listings?own=true", { credentials: "include" })).json()));
    const beforeIds = new Set(before.map((row) => row.id));
    await clickTurn(review.getByTestId("draft-publish-confirm"));
    assert.match(await textOf(latestAssistant()), /تم نشر الإعلان/);
    const own = await page.evaluate(async () => (await (await fetch("/api/listings?own=true", { credentials: "include" })).json()));
    assert.equal(own.length, before.length + 1);
    const listing = own.find((row) => !beforeIds.has(row.id));
    assert.ok(listing, "the seller published one new listing through the conversation");
    uiSellerListingIds[id] = listing.id;
    assert.equal(listing.pricingMode, "OPEN_TO_OFFERS");
    assert.equal(listing.unitPrice, null);
    assert.deepEqual(listing.paymentMethods, ["CASH_DIRECT"]);
    assert.equal(listing.city, city);
    assert.equal(listing.contactPhone ?? null, null);
    await page.reload();
    await page.getByTestId("input-ai-composer").waitFor();
    const refreshed = await page.evaluate(async () => (await (await fetch("/api/listings?own=true", { credentials: "include" })).json()));
    assert.ok(refreshed.some((row) => row.id === listing.id), "published listing persists across reload");
    assert.equal(new URL(page.url()).pathname, "/");
  }

  await record("UI-SG-IPHONE", "browser seller publishes unpriced iPhone on desktop", async () => {
    await publishUnpricedSellerJourney({
      id: "iphone",
      start: `أبي أبيع آيفون 16 برو ماكس مستعمل ${TOKEN}`,
      category: "إلكترونيات",
      detail: `آيفون 16 برو ماكس مستعمل نظيف ${TOKEN}`,
      desktop: true,
    });
  });
  await record("UI-SG-TABLE", "browser seller publishes unpriced non-phone product on mobile", async () => {
    await publishUnpricedSellerJourney({
      id: "table",
      start: `أبي أبيع طاولة مكتب مستعملة ${TOKEN}`,
      category: "أخرى",
      detail: `طاولة مكتب مستعملة ${TOKEN}`,
      desktop: false,
    });
  });
  await record("UI-SG-SERVICE", "browser seller publishes an unpriced service on mobile", async () => {
    await publishUnpricedSellerJourney({
      id: "service",
      start: `أقدم خدمة تنظيف منازل ${TOKEN}`,
      category: "خدمات",
      detail: `خدمة تنظيف منازل ${TOKEN}`,
      desktop: false,
    });
  });
  await record("UI-N04", "buyer search renders the seller-published unpriced iPhone as an offer, not a free item", async () => {
    page = await openSession(cookies.buyer);
    await newConversation();
    const search = await sendTurn(`ابحث عن آيفون 16 برو ماكس ${TOKEN}`);
    const card = page.getByTestId(`card-ai-result-${uiSellerListingIds.iphone}`);
    await card.waitFor();
    await card.getByText("قدّم عرضك", { exact: true }).waitFor();
    assert.doesNotMatch(await textOf(card), /مجاني|0\.000|0 دينار/);
    await mobile("unpriced iPhone search card", card);
    page = await openSession(cookies.seller);
    await newConversation();
  });
  await record("UI-N36", "a sponsored unpriced listing keeps both its paid-placement label and truthful offer price", async () => {
    page = await openSession(cookies.buyer);
    await newConversation();
    const search = await sendTurn(`ابحث عن تيشرت بلا سعر ${TOKEN}`);
    const card = page.getByTestId(`card-ai-result-${ids.sponsoredUnpriced}`);
    await card.waitFor();
    await card.getByTestId(`label-sponsored-${ids.sponsoredUnpriced}`).waitFor();
    await card.getByText("قدّم عرضك", { exact: true }).waitFor();
    assert.doesNotMatch(await textOf(card), /مجاني|0\.000|0 دينار/);
    await mobile("sponsored unpriced card", card);
    page = await openSession(cookies.seller);
    await newConversation();
  });

  await record("G3-07", "MY_LISTINGS compact rows inside the conversation", async () => {
    const listings = await sendTurn("اعرض لي إعلاناتي");
    const rows = listings.locator('[data-testid^="chat-seller-listing-"]');
    await rows.first().waitFor();
    assert.ok((await rows.count()) >= 5);
    await mobile("MY_LISTINGS", listings);
  });

  await record("G3-15", "pending actions are visibly unexecuted (price change review)", async () => {
    const preview = await sendTurn(`غير سعر جاكيت مطري ${TOKEN} إلى 8`);
    const notice = preview.getByTestId("pending-notice");
    await notice.waitFor();
    assert.match(await textOf(notice), /لم يتغير/);
    await mobile("price change review", preview);
    const listing = await page.evaluate(async (id) => (await (await fetch(`/api/listings/${id}`, { credentials: "include" })).json()), ids.jacketRain);
    assert.equal(listing.unitPrice, "9.000", "unchanged before confirmation");
    await sendTurn("إلغاء");
  });

  await record("G3-14", "interrupt a draft with a search, then resume the same draft", async () => {
    await newConversation();
    await sendTurn("أريد أبيع جاكيت أحمر");
    const search = await sendTurn(`لحظة دور لي على لابتوب ${TOKEN}`);
    await search.getByTestId("ai-results-list").waitFor();
    assert.match(await textOf(search), /محفوظة/);
    const back = await sendTurn("رجعنا للجاكيت");
    await back.getByTestId("draft-review").waitFor();
    assert.match(await textOf(back.getByTestId("draft-field-title")), /جاكيت أحمر/);
    const conversation = await serverConversation();
    const draftIds = new Set(conversation.body.messages.flatMap((message) => message.blocks).map((block) => block.payload.draft?.draftId).filter(Boolean));
    assert.equal(draftIds.size, 1, "one draft, no duplicate");
  });

  await record("G3-13", "clarification quick actions send the same words as typing", async () => {
    await sendTurn("أريد أبيع جاكيت أزرق");
    const ask = await sendTurn("رجعنا للجاكيت");
    const options = ask.getByTestId("clarification-options");
    await options.waitFor();
    const buttons = options.getByRole("button");
    assert.equal(await buttons.count(), 2);
    const label = (await buttons.first().innerText()).trim();
    await mobile("clarification chips", ask);
    const chosen = await clickTurn(buttons.first());
    await chosen.getByTestId("draft-review").waitFor();
    assert.match(await textOf(chosen.getByTestId("draft-field-title")), new RegExp(label));
    const user = await page.locator('[data-testid^="message-user-"]').last().innerText();
    assert.equal(user.trim(), "الأول", "the chip sent the ordinal a user would type");
  });

  await record("G3-20", "promotion review and canonical sponsored state", async () => {
    await newConversation();
    await sendTurn("روّج إعلاني");
    const options = latestAssistant().getByTestId("promotion-surface-promotion_options");
    await options.waitFor();
    const row = options.locator('[data-testid^="promotion-listing-"]').filter({ hasText: "جاكيت جلد" });
    await clickTurn(row.first().getByRole("button").first());
    const plans = latestAssistant().getByTestId("promotion-surface-promotion_options");
    await plans.getByTestId("promotion-plans").waitFor();
    await clickTurn(plans.getByTestId("promotion-plan-1").getByRole("button"));
    const review = latestAssistant().getByTestId("promotion-surface-promotion_review");
    await review.getByTestId("pending-notice").waitFor();
    assert.match(await textOf(review), /JOD/);
    await mobile("PROMOTION_REVIEW", review);
    await sendTurn("إلغاء");
  });

  // ════ Buyer ════
  page = await openSession(cookies.buyer);
  await newConversation();
  let jacketIds = [];
  await record("J-B", "buyer: search → carousel → advice → comparison → second item → truthful next steps", async () => {
    const results = await sendTurn(`ابحث عن جاكيت ${TOKEN}`);
    const list = results.getByTestId("ai-results-list");
    await list.waitFor();
    await record("G3-08", "contained RTL carousel, no viewport overflow, more indicated", async () => {
      const carousel = list.locator('[role="region"][data-testid^="ai-results-carousel-"]');
      const sizes = await carousel.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth, dir: getComputedStyle(node).direction }));
      assert.equal(sizes.dir, "rtl");
      await list.getByTestId("ai-results-more").waitFor();
      await mobile("SEARCH carousel", list);
      assert.ok(sizes.scroll >= sizes.client);
    });
    await record("G3-09", "visible positions match the persisted result set; «الثاني» opens #2", async () => {
      const conversation = await serverConversation();
      const block = latestListingBlock(conversation);
      jacketIds = block.payload.resourceIds;
      const shown = await list.locator('[data-testid^="card-ai-result-"]').evaluateAll((nodes) =>
        nodes.map((node) => ({ id: node.getAttribute("data-resource-id"), badge: node.querySelector('[data-testid^="result-position-"]')?.textContent?.trim() })),
      );
      assert.deepEqual(shown.map((item) => item.id), jacketIds, "client order = server ResultSet");
      assert.deepEqual(shown.map((item) => item.badge), jacketIds.map((_, index) => String(index + 1)));
      const second = await sendTurn("الثاني");
      const details = second.getByTestId("ai-results-details");
      await details.waitFor();
      assert.equal(await details.locator('[data-testid^="card-ai-result-"]').first().getAttribute("data-resource-id"), jacketIds[1]);
    });
    const advice = await sendTurn("وش تنصحني؟");
    await advice.getByTestId("advice").waitFor();
    await advice.getByTestId("advice-recommendation").waitFor();
    await mobile("grounded advice (results)", advice.getByTestId("advice"));
    await record("G3-11", "comparison readable at 320–414", async () => {
      const comparison = await sendTurn("قارن الأول والثاني");
      await comparison.getByTestId("comparison").waitFor();
      assert.match(await textOf(comparison.getByTestId("comparison")), /غير معروف|السعر/);
      await mobile("COMPARISON", comparison.getByTestId("comparison"));
    });
    await record("G3-18", "purchase review: item stage adds to cart, order stage creates the order", async () => {
      const item = await sendTurn("أبي الثاني");
      const review = item.getByTestId("purchase-review");
      await review.waitFor();
      await review.getByTestId("pending-notice").waitFor();
      assert.match(await textOf(review.getByTestId("purchase-confirm")), /السلة/, "says it adds to the cart");
      await mobile("PURCHASE_REVIEW item", review);
      const order = await clickTurn(review.getByTestId("purchase-continue"));
      const orderReview = order.getByTestId("purchase-review");
      assert.match(await textOf(orderReview.getByTestId("purchase-confirm")), /تأكيد الطلب/);
      assert.match(await textOf(orderReview), /الإجمالي/);
      if (/تم إنشاء الطلب/.test(await textOf(order))) counters.falseBusinessSuccess++;
      const placed = await clickTurn(orderReview.getByTestId("purchase-confirm"));
      assert.match(await textOf(placed), /تم إنشاء الطلب/);
      assert.match(await textOf(placed), /لم يُدفع أي شيء/);
    });
    await record("G3-19", "payment review is simulation and never says paid", async () => {
      const payment = await sendTurn("ادفع");
      const review = payment.getByTestId("purchase-review");
      await review.waitFor();
      assert.match(await textOf(review), /SIMULATION_ONLY|تجريبي/);
      await review.getByTestId("pending-notice").waitFor();
      await mobile("PAYMENT_REVIEW", review);
      const cardChoice = review.getByTestId("purchase-payment-CARD");
      const paymentChoice = (await cardChoice.count()) ? cardChoice : review.getByTestId("purchase-payment-CASH_DIRECT");
      await clickTurn(paymentChoice);
      const selectedReview = latestAssistant().getByTestId("purchase-review");
      const after = await clickTurn(selectedReview.getByTestId("purchase-confirm"));
      const text = await textOf(after);
      if (/تم الدفع(?! التجريبي)/.test(text)) counters.falsePaymentSuccess++;
      assert.match(text, /لم تُحوَّل/);
    });
    nestedPassed("G3-08", "G3-09", "G3-11", "G3-18", "G3-19");
  });

  await record("G3-12", "grounded advice shows compact DINAR basis", async () => {
    const estimate = await sendTurn(`كم تتوقع سعر جاكيت ${TOKEN}؟`);
    const grounding = estimate.getByTestId("advice-grounding");
    await grounding.waitFor();
    assert.match(await textOf(grounding), /اعتمدت على 2 عروض مشابهة داخل DINAR/);
    assert.match(await textOf(grounding), /النطاق 9–12/);
    assert.doesNotMatch(await textOf(estimate), /SQL|resultSet|minor|query/i);
    await mobile("grounded advice (estimate)", estimate.getByTestId("advice"));
  });

  await record("G3-10", "a generic «Other» listing renders like any other", async () => {
    const vase = await sendTurn(`ابحث عن مزهرية ${TOKEN}`);
    const card = vase.locator(`[data-testid="card-ai-result-${ids.vase}"]`);
    await card.waitFor();
    assert.match(await textOf(card), /مزهرية/);
    assert.match(await textOf(card), /7/);
    assert.doesNotMatch(await textOf(vase), /غير مدعوم|غير متاحة حاليًا/);
  });

  await record("G3-27", "untrusted listing, provider and model text renders inert", async () => {
    const hostile = await sendTurn(`ابحث عن كوب ${TOKEN}`);
    const card = hostile.locator(`[data-testid="card-ai-result-${ids.hostile}"]`);
    await card.waitFor();
    assert.match(await card.innerText(), /<img src=x/, "markup shown as text");
    await card.getByRole("button", { name: "عرض التفاصيل" }).click();
    await page.waitForTimeout(800);
    const provider = await sendTurn(`ابحث عن فنجان ${TOKEN}`);
    assert.match(await provider.innerText(), /<script>/);
    const model = await sendTurn("وش رأيك بالأكواب الزجاجية؟");
    assert.match(await model.innerText(), /<script>/, "model markup is text");
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    if (await xssFlag()) counters.xssExecutions++;
    assert.equal(await xssFlag(), undefined);
    assert.equal(counters.xssExecutions, 0);
  });

  await record("G3-29", "desktop 1280: readable max width, composer aligned", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await settle();
    const layout = await page.evaluate(() => {
      const message = [...document.querySelectorAll('[data-testid^="message-assistant-"] > div')].at(-1)?.getBoundingClientRect();
      const composer = document.querySelector(".ai-composer-box")?.getBoundingClientRect();
      return { message: message && { left: message.left, width: message.width }, composer: composer && { left: composer.left, width: composer.width }, scroll: document.documentElement.scrollWidth, width: window.innerWidth };
    });
    assert.ok(layout.scroll <= layout.width, "no overflow");
    assert.ok(layout.message.width <= 960, `message width ${layout.message.width}`);
    // The approved wide desktop layout keeps the composer within the same readable maximum as messages.
    assert.ok(layout.composer.width <= 960, `composer width ${layout.composer.width}`);
    const messageCenter = layout.message.left + layout.message.width / 2;
    const composerCenter = layout.composer.left + layout.composer.width / 2;
    assert.ok(Math.abs(messageCenter - composerCenter) <= 140, `aligned ${messageCenter} vs ${composerCenter}`);
    await measure("desktop thread", 1280, latestAssistant());
    await page.setViewportSize({ width: 390, height: 844 });
  });

  // ════ Negotiation (buyer two ⇄ seller) ════
  const buyerTwo = await openSession(cookies.buyerTwo);
  const sellerPage = await openSession(cookies.seller);
  await record("J-C", "offer 7 → counter 8 → accept → private 8 → order at 8, public price 10", async () => {
    page = buyerTwo;
    await newConversation();
    const results = await sendTurn(`ابحث عن جاكيت جلد ${TOKEN}`);
    await results.getByTestId("ai-results-list").waitFor();
    const resourceIds = await results.locator('[data-testid^="card-ai-result-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-resource-id")));
    const position = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس"][resourceIds.indexOf(ids.jacket)];
    await sendTurn(position);
    const offer = await sendTurn("غالي، أعطيه 7");
    const review = offer.getByTestId("negotiation-review");
    await record("G3-16", "negotiation offer / counter / accept surfaces are truthful", async () => {
      await review.waitFor();
      assert.match(await textOf(review.getByTestId("negotiation-public-price")), /^10 /);
      assert.match(await textOf(review), /لم يُرسل/);
      await review.getByTestId("pending-notice").waitFor();
      await mobile("NEGOTIATION offer review", review);
      const sent = await clickTurn(review.getByTestId("negotiation-send"));
      assert.match(await textOf(sent.getByTestId("negotiation-status")), /أُرسل عرضك/);
      page = sellerPage;
      await newConversation();
      const list = await sendTurn("هل عندي عروض؟");
      const item = list.getByTestId("negotiation-item");
      await item.first().waitFor();
      assert.match(await textOf(item.first()), /عرض المشتري 7/);
      await mobile("NEGOTIATION seller list", list.getByTestId("negotiation-list"));
      const counter = await sendTurn("عرض مضاد 8");
      await counter.getByTestId("pending-notice").waitFor();
      const countered = await clickTurn(counter.getByTestId("negotiation-confirm"));
      assert.equal(await countered.getByTestId("negotiation-status").getAttribute("data-status"), "COUNTERED");
      page = buyerTwo;
      const seen = await sendTurn("وش صار على عرضي؟");
      assert.match(await textOf(seen.getByTestId("negotiation-counter")), /^8 /);
      const accepted = await clickTurn(seen.getByTestId("negotiation-confirm"));
      const status = accepted.getByTestId("negotiation-status");
      assert.equal(await status.getAttribute("data-status"), "ACCEPTED");
      await mobile("NEGOTIATION accepted", status);
    });
    await record("G3-17", "the private price never replaces the public price", async () => {
      const status = latestAssistant().getByTestId("negotiation-status");
      assert.match(await textOf(status.getByTestId("negotiation-agreed")), /^8 /);
      assert.match(await textOf(status.getByTestId("negotiation-public-price")), /^10 /);
      const order = await clickTurn(status.getByTestId("negotiation-order"));
      const purchase = order.getByTestId("purchase-review");
      assert.match(await textOf(purchase.getByTestId("purchase-agreed-price")), /^8/);
      assert.match(await textOf(purchase.getByTestId("purchase-public-price")), /^10/);
      const placed = await clickTurn(purchase.getByTestId("purchase-confirm"));
      assert.match(await textOf(placed), /تم إنشاء الطلب/);
      // Another buyer still sees 10 and none of this negotiation.
      page = await openSession(cookies.buyer);
      await newConversation();
      const publicView = await sendTurn(`ابحث عن جاكيت جلد ${TOKEN}`);
      const card = publicView.locator(`[data-testid="card-ai-result-${ids.jacket}"]`);
      await card.waitFor();
      assert.match(await textOf(card), /10/);
      assert.doesNotMatch(await textOf(card), /\b8\.000\b/);
      const mine = await sendTurn("وش صار على عرضي؟");
      assert.doesNotMatch(await textOf(mine), /جاكيت جلد/);
    });
    nestedPassed("G3-16", "G3-17");
  });

  // ════ Provider ════
  page = await openSession(cookies.provider);
  await newConversation();
  let providerKey = "";
  await record("J-D", "provider key: review → confirm → one-time key → reload hidden → replacement warning → revoke", async () => {
    await record("G3-22", "provider secret shown once, never in URL or console, gone after reload", async () => {
      const review = await sendTurn("أريد مفتاح ربط");
      const panel = review.getByTestId("provider-panel");
      await panel.getByTestId("pending-notice").waitFor();
      await mobile("PROVIDER review", panel);
      const created = await clickTurn(panel.getByTestId("provider-confirm"));
      const secretPanel = created.getByTestId("provider-panel");
      await secretPanel.getByTestId("provider-replace-notice").waitFor();
      await secretPanel.getByTestId("provider-issue-key").click();
      const secret = secretPanel.getByTestId("provider-secret");
      await secret.waitFor();
      providerKey = (await secret.locator("code").innerText()).trim();
      assert.match(providerKey, /^dnr_/);
      await mobile("PROVIDER secret once", secretPanel);
      const history = page.waitForResponse((response) => /\/api\/ai\/conversations\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname));
      await page.reload();
      assert.equal((await history).status(), 200, "provider history loads with HTTP 200");
      await page.getByTestId("input-ai-composer").waitFor();
      await page.getByTestId("provider-panel").first().waitFor();
      assert.equal(await page.getByTestId("provider-secret").count(), 0);
      if ((await page.content()).includes(providerKey)) counters.secretResurrections++;
      assert.equal(counters.secretResurrections, 0);
      const rotate = await sendTurn("بدل المفتاح");
      await rotate.getByTestId("pending-notice").waitFor();
      const rotated = await clickTurn(rotate.getByTestId("provider-confirm"));
      await rotated.getByTestId("provider-replace-notice").waitFor();
      const revoke = await sendTurn("أوقف الربط");
      const revoked = await clickTurn(revoke.getByTestId("provider-confirm"));
      await sendTurn("اعرض روابط الربط");
      assert.match(await textOf(latestAssistant()), /موقوف/);
      void revoked;
    });
    nestedPassed("G3-22");
  });

  // ════ Driver / employment / location ════
  page = await openSession(cookies.driver);
  await newConversation();
  await record("J-E", "DINAR driver path: onboarding → review → status → availability → work", async () => {
    await record("G3-21", "driver surfaces are truthful; no invented trust", async () => {
      const onboarding = await sendTurn("أريد أشتغل سائق مع دينار");
      await onboarding.getByTestId("driver-panel").waitFor();
      assert.equal(await page.locator('[data-testid^="employment-"]').count(), 0, "no employment surface");
      const review = await sendTurn("سيارة");
      await review.getByTestId("pending-notice").waitFor();
      await mobile("DRIVER onboarding review", review.getByTestId("driver-panel"));
      const submitted = await clickTurn(review.getByTestId("driver-confirm"));
      assert.doesNotMatch(await textOf(submitted), /معتمد|تمت الموافقة/);
      const available = await sendTurn("أنا متاح");
      assert.match(await textOf(available), /لا يمكن تفعيل الإتاحة|لم يتغير شيء/);
      await sendTurn("اعرض لي توصيلات");
      if (TRUST_CLAIMS.test(await chatText())) counters.falseTrustClaims++;
      assert.equal(counters.falseTrustClaims, 0);
    });
    nestedPassed("G3-21");
  });

  page = await openSession(cookies.worker);
  await newConversation();
  await record("J-F", "«أبي وظيفة سائق» → employment, never driver onboarding", async () => {
    await record("G3-23", "employment surfaces keep trust and privacy", async () => {
      const job = await sendTurn("أبي وظيفة سائق");
      await job.locator('[data-testid^="employment-"]').first().waitFor();
      assert.equal(await job.getByTestId("driver-panel").count(), 0);
      await sendTurn("أريد أنشئ ملف وظيفي");
      const profile = await sendTurn("أنا <b onmouseover=\"window.__xss='cv'\">سائق</b> عندي خبرة 3 سنوات");
      const cv = profile.locator('[data-testid^="employment-"]').first();
      await cv.waitFor();
      await mobile("CV profile", cv);
      if (TRUST_CLAIMS.test(await chatText()) || /موثّق|موثق/.test(await textOf(cv))) counters.falseTrustClaims++;
      assert.equal(counters.falseTrustClaims, 0);
      assert.equal(await xssFlag(), undefined);
      if ((await chatText()).includes(ids.buyerPhone)) counters.authPhoneLeaks++;
    });
    nestedPassed("G3-23");
  });

  page = await openSession(cookies.receiver);
  await newConversation();
  await record("G3-24", "location / delivery: no precise coordinates in chat text", async () => {
    const status = await sendTurn("حالة التوصيل");
    await status.locator('[data-testid^="delivery-"]').first().waitFor();
    await mobile("DELIVERY status", status.locator('[data-testid^="delivery-"]').first());
    const bodies = await page.locator(".ai-message-text").allInnerTexts();
    const lat = String(coords.latitude).slice(0, 6);
    const lng = String(coords.longitude).slice(0, 6);
    for (const body of bodies) if (body.includes(lat) || body.includes(lng)) counters.preciseLocationTextLeaks++;
    // An unrelated account's delivery view shows nothing of this order.
    page = await openSession(cookies.multi);
    await newConversation();
    await sendTurn("حالة التوصيل");
    const unrelated = await chatText();
    if (unrelated.includes(lat) || unrelated.includes(lng)) counters.preciseLocationTextLeaks++;
    assert.equal(counters.preciseLocationTextLeaks, 0);
  });

  // ════ One account, many goals ════
  await record("J-G", "multi-role: draft → search → back to draft → promotion advice → provider status", async () => {
    await record("G3-30", "the same account switches goals with no mode UI", async () => {
      await newConversation();
      const draft = await sendTurn("أريد أبيع ساعة يد بـ20");
      await draft.getByTestId("draft-review").waitFor();
      const search = await sendTurn(`لحظة دور لي على جاكيت ${TOKEN}`);
      await search.getByTestId("ai-results-list").waitFor();
      const back = await sendTurn("رجعنا للساعة");
      assert.match(await textOf(back.getByTestId("draft-field-title")), /ساعة يد/);
      const mine = await sendTurn("اعرض لي إعلاناتي");
      await mine.locator('[data-testid^="chat-seller-listing-"]').first().waitFor();
      await sendTurn("الأول");
      const advice = await sendTurn("تنصحني أروج الإعلان؟");
      await advice.getByTestId("advice").waitFor();
      assert.match(await textOf(advice), /لم أروّج شيئًا/);
      const provider = await sendTurn("اعرض روابط الربط");
      await provider.waitFor();
      assert.doesNotMatch(await chatText(), /وضع البائع|وضع المشتري|وضع السائق|SELLER MODE|BUYER MODE|DRIVER MODE/);
    });
    nestedPassed("G3-30");
  });

  // ════ History, accessibility, overall ════
  await record("G3-25", "history reload keeps truthful typed state; no stale pending, no secret", async () => {
    for (const [cookieName, label] of [["buyerTwo", "negotiation"], ["buyer", "purchase"], ["provider", "provider"]]) {
      page = await openSession(cookies[cookieName]);
      await page.goto("/");
      await page.getByTestId("input-ai-composer").waitFor();
      const list = await page.evaluate(async () => (await (await fetch("/api/ai/conversations", { credentials: "include" })).json()));
      assert.ok(list.length > 0, `${label} has history`);
      for (const conversation of list.slice(0, 6)) {
        const toggle = page.locator('[data-testid="button-toggle-conversation-history"]:visible').first();
        const item = page.locator(`button[data-testid="conversation-${conversation.id}"]`);
        if (!(await item.isVisible()) && (await toggle.count())) await toggle.click();
        const history = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/ai/conversations/${conversation.id}` && response.request().method() === "GET");
        await item.click();
        const response = await history;
        assert.equal(response.status(), 200, `${label} history ${conversation.id}`);
        await page.locator('[data-testid^="message-assistant-"]').first().waitFor();
        await settle();
        counters.staleSurfaces += await page.getByTestId("pending-notice").count();
        if (providerKey && (await page.content()).includes(providerKey)) counters.secretResurrections++;
      }
    }
    assert.equal(counters.staleSurfaces, 0, "settled reviews show no pending state after reload");
    assert.equal(counters.secretResurrections, 0);
  });

  await record("G3-28", "accessibility: names, touch targets, keyboard path to the composer, image alts", async () => {
    page = await openSession(cookies.buyer);
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor();
    let reached = false;
    for (let index = 0; index < 60 && !reached; index++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "input-ai-composer");
    }
    assert.ok(reached, "keyboard reaches the composer");
    const unnamed = await page.locator("button:visible").evaluateAll((nodes) => nodes.filter((node) => !(node.getAttribute("aria-label") || node.textContent?.trim())).length);
    assert.equal(unnamed, 0);
    assert.equal(await page.locator("img:not([alt])").count(), 0);
  });

  await record("G3-26", "technical failures are normalized to plain Arabic with a recovery action", async () => {
    page = await openSession(cookies.buyer);
    await page.goto("/");
    await page.getByTestId("input-ai-composer").waitFor();
    const list = await page.evaluate(async () => (await (await fetch("/api/ai/conversations", { credentials: "include" })).json()));
    const target = list[0].id;
    let hits = 0;
    await page.route(`**/api/ai/conversations/${target}`, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      hits++;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "TypeError: Cannot read properties of undefined\n    at Object.<anonymous> (/home/runner/workspace/artifacts/api-server/src/routes/ai.ts:640:12)\n    at ZodError: [{\"code\":\"invalid_type\"}] select * from messages" }) });
    });
    const toggle = page.locator('[data-testid="button-toggle-conversation-history"]:visible').first();
    const item = page.locator(`button[data-testid="conversation-${target}"]`);
    if (!(await item.isVisible()) && (await toggle.count())) await toggle.click();
    await item.click();
    const alert = page.locator('[role="alert"]').filter({ hasText: /تعذّر|تعذر/ }).first();
    await alert.waitFor({ timeout: 45_000 });
    const text = await page.locator("body").innerText();
    if (/Object\.<anonymous>|\/home\/runner|ZodError|select \*|TypeError/.test(text)) counters.technicalErrorLeaks++;
    assert.doesNotMatch(text, /Object\.<anonymous>|\/home\/runner|ZodError|select \*|TypeError/);
    await page.unroute(`**/api/ai/conversations/${target}`);
    expectedResourceErrors += hits;
    await alert.getByRole("button", { name: "إعادة المحاولة" }).click();
    await page.locator('[data-testid^="message-assistant-"]').first().waitFor();
    assert.equal(counters.technicalErrorLeaks, 0);
  });
} catch (error) {
  failures.run = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  for (const context of contexts) {
    for (const opened of context.pages()) await opened.waitForLoadState("networkidle").catch(() => undefined);
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }
  await browser?.close();
}

// Layout-wide checks recorded from every measurement above.
results["G3-01"] = Object.values(widths).every((value) => value === "PASS") && counters.horizontalOverflow === 0 ? "PASS" : "FAIL";
results["G3-02"] = counters.composerObstruction === 0 && counters.horizontalOverflow === 0 && checks.some((check) => check.includes("320px")) ? "PASS" : "FAIL";
for (const journey of ["J-A", "J-B", "J-C", "J-D", "J-E", "J-F", "J-G"]) results[journey] ??= "FAIL";
const providerKeyPattern = /dnr_[A-Za-z0-9_-]{20,}/;
counters.secretUrlLeaks = urlsSeen.filter((url) => providerKeyPattern.test(decodeURIComponent(url))).length;
counters.secretConsoleLeaks = consoleTexts.filter((text) => providerKeyPattern.test(text)).length;
counters.pageErrors = pageErrors.length;
const resourceErrors = consoleErrors.filter((text) => /status of 500|ERR_INTERNET_DISCONNECTED/.test(text));
const conflictErrors = consoleErrors.filter((text) => /status of 409/.test(text));
const unexpected = consoleErrors.filter((text) => !/status of 500|ERR_INTERNET_DISCONNECTED|status of 409/.test(text));
counters.unexpectedConsoleErrors =
  unexpected.length +
  Math.max(0, resourceErrors.filter((text) => /status of 500/.test(text)).length - expectedResourceErrors) +
  Math.max(0, conflictErrors.length - expectedConflictErrors);
counters.unexpectedExternalRequests = externalRequests.length;
const failure = Object.keys(failures).length ? JSON.stringify(failures, null, 1) : undefined;
  writeFileSync(resultPath, JSON.stringify({ results, counters, widths, checks, checkList: checks, pageErrors, consoleErrors: unexpected, externalRequests, guestMarketGate, staleMarketSelection, tutorialBrowser, failure }, null, 2));
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
