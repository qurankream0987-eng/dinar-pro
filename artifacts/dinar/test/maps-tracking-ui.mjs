/**
 * MAPS browser acceptance (driven by maps-tracking-browser-journey.test.ts). Real Chromium against
 * the Vite web app and the real API. All positions are SYNTHETIC test data; the inline map style
 * labels itself «خريطة اختبار اصطناعية» so no screenshot can pass for live data.
 */
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const env = process.env;
const WEB = env.MT_WEB;
const API = env.MT_API;
const SHOTS = env.MT_SHOTS;
const F = JSON.parse(env.MT_FIXTURE);
const report = { checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], failure: undefined };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`CHECK FAILED: ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
const SYNTH_A = { latitude: 31.9521, longitude: 35.9061 };
const SYNTH_B = { latitude: 31.9532, longitude: 35.9083 };
const allowed = new Set([new URL(WEB).host, new URL(API).host, "fonts.googleapis.com", "fonts.gstatic.com"]);

const browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });

async function open(actor, { width = 390, height = 844, geolocation, reducedMotion, denyGeolocation } = {}) {
  const context = await browser.newContext({
    baseURL: WEB, viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600, locale: "ar",
    deviceScaleFactor: 2, ...(geolocation ? { geolocation, permissions: ["geolocation"] } : {}),
    ...(reducedMotion ? { reducedMotion: "reduce" } : {}),
  });
  if (denyGeolocation)
    // Simulated browser denial (headless Chromium never answers an ungranted prompt).
    await context.addInitScript(() => {
      const denied = { code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "denied" };
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_ok, fail) => setTimeout(() => fail(denied), 50), watchPosition: (_ok, fail) => { setTimeout(() => fail(denied), 50); return 1; }, clearWatch: () => undefined } });
    });
  await context.addInitScript(({ conversationId, userId }) => localStorage.setItem(`dinar-conversation:${userId}:JO`, conversationId), { conversationId: actor.conv, userId: actor.id });
  const split = actor.cookie.indexOf("=");
  await context.addCookies([{ name: actor.cookie.slice(0, split), value: actor.cookie.slice(split + 1), domain: new URL(WEB).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"]) delete headers[header];
    headers.origin = API;
    headers.referer = `${API}/`;
    await route.fulfill({ response: await route.fetch({ url: `${API}${url.pathname}${url.search}`, headers }) });
  });
  await context.addInitScript(() => window.addEventListener("unhandledrejection", (event) => console.error("UNHANDLED " + (event.reason?.stack || event.reason))));
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => message.type() === "error" && report.consoleErrors.push(message.text().slice(0, 600)));
  page.on("request", (request) => {
    const host = new URL(request.url()).host;
    if (!allowed.has(host) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) report.externalRequests.push(host);
  });
  page.on("response", async (response) => {
    if (response.url().includes("/location-sharing/location")) {
      let body = null;
      try { body = JSON.parse(response.request().postData() ?? "null"); } catch {}
      report.sharingResponses = report.sharingResponses ?? [];
      report.sharingResponses.push({ status: response.status(), sequence: body?.sequence, observedAt: body?.observedAt, latitude: body?.latitude });
    }
  });
  return { context, page };
}

async function api(actor, path, method = "GET", body) {
  const response = await fetch(`${API}/api${path}`, {
    method,
    headers: { Cookie: actor.cookie, origin: API, ...(method !== "GET" ? { "content-type": "application/json" } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function turn(actor, message) {
  const response = await fetch(`${API}/api/ai/conversations/${actor.conv}/turns`, { method: "POST", headers: { Cookie: actor.cookie, origin: API, "content-type": "application/json" }, body: JSON.stringify({ message }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  return { body: complete?.assistantMessage?.body ?? "", surface: complete?.assistantMessage?.blocks?.[0]?.payload?.surface };
}
const lastMessage = (page) => page.locator('[data-testid^="message-assistant-"]').last();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  // ── 1. Location selection: denial, manual fallback, pick on map, preview ───────────────
  const pick = await open(F.pickBuyer, { denyGeolocation: true });
  await pick.page.goto("/", { waitUntil: "networkidle" });
  await lastMessage(pick.page).getByTestId("delivery-share-location").waitFor({ timeout: 30_000 });
  check("location request offers device, manual and map choices", await lastMessage(pick.page).getByTestId("delivery-manual-address").isVisible() && await lastMessage(pick.page).getByTestId("delivery-pick-on-map").isVisible());
  await pick.page.screenshot({ path: `${SHOTS}/01-location-request-mobile.png` });
  await lastMessage(pick.page).getByTestId("delivery-share-location").click();
  await lastMessage(pick.page).getByTestId("delivery-location-problem").waitFor({ timeout: 20_000 });
  check("GPS denial (simulated in the browser) is explained and nothing is sent", /لم يُسمح|تعذر/.test(await lastMessage(pick.page).getByTestId("delivery-location-problem").innerText()));
  check("manual entry stays available after denial", await lastMessage(pick.page).getByTestId("delivery-manual-address").isVisible());
  await pick.page.screenshot({ path: `${SHOTS}/01b-location-denied-mobile.png` });
  await lastMessage(pick.page).getByTestId("delivery-pick-on-map").click();
  const pickerMap = lastMessage(pick.page).getByTestId("delivery-picker-map");
  await pickerMap.waitFor({ timeout: 30_000 });
  await pick.page.waitForSelector('[data-testid="delivery-picker-map"][data-ready="true"]', { timeout: 90_000 });
  check("synthetic map is labelled on screen", await lastMessage(pick.page).getByTestId("delivery-picker-map-synthetic-label").isVisible());
  check("no point is assumed before the user chooses", await lastMessage(pick.page).getByTestId("delivery-map-use-point").isDisabled());
  const box = await pickerMap.locator("canvas").boundingBox();
  await pick.page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await pick.page.locator('[data-testid="map-marker-selection"]').waitFor({ timeout: 10_000 });
  const marker = await pick.page.locator('[data-testid="map-marker-selection"]').boundingBox();
  await pick.page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
  await pick.page.mouse.down();
  await pick.page.mouse.move(marker.x + 40, marker.y + 25, { steps: 8 });
  await pick.page.mouse.up();
  check("tap selects and drag adjusts the delivery point", await lastMessage(pick.page).getByTestId("delivery-map-use-point").isEnabled());
  await pick.page.screenshot({ path: `${SHOTS}/01c-map-picker-mobile.png` });
  await lastMessage(pick.page).getByTestId("delivery-map-use-point").click();
  await pick.page.locator('[data-testid="delivery-location-preview"]').last().waitFor({ timeout: 30_000 });
  const previewText = await pick.page.locator('[data-testid="delivery-location-preview"]').last().innerText();
  check("preview names the source honestly (chosen on the map, not the device)", /نقطة اخترتها على الخريطة/.test(previewText), previewText);
  check("preview never prints coordinates", !/31\.9|35\.9/.test(previewText));
  check("confirm and edit-on-map actions are offered", await lastMessage(pick.page).getByTestId("delivery-confirm-location").isVisible() && await lastMessage(pick.page).getByTestId("delivery-adjust-on-map").isVisible());
  await pick.page.waitForSelector('[data-testid="delivery-preview-map"][data-ready="true"]', { timeout: 30_000 });
  await pick.page.screenshot({ path: `${SHOTS}/01d-map-preview-mobile.png` });
  check("picker flow has no horizontal overflow at 390 px", (await overflow(pick.page)) === 0);
  await lastMessage(pick.page).getByTestId("delivery-confirm-location").click();
  await wait(1500);

  // ── 2. Delivery-method comparison (the earlier card in the same conversation) ───────────
  const methods = pick.page.locator('[data-testid^="message-assistant-"]').first();
  await methods.scrollIntoViewIfNeeded();
  check("delivery options card is present", /استلام|مندوب|توصيل/.test(await methods.innerText()));
  await methods.screenshot({ path: `${SHOTS}/02-delivery-methods-mobile.png` });

  // ── 5. Driver: open work, accept (two-step confirmation), fare agreed, trip started ─────
  const work = await turn(F.driver, "اعرض لي طلبات توصيل");
  check("driver sees open delivery work", work.surface === "DELIVERY_WORK_RESULTS", work.surface);
  const driverView = await open(F.driver, { geolocation: SYNTH_A });
  await driverView.page.goto("/", { waitUntil: "networkidle" });
  await lastMessage(driverView.page).waitFor();
  await driverView.page.screenshot({ path: `${SHOTS}/05-driver-assignment-mobile.png` });
  await turn(F.driver, "أقبل الأول");
  const accepted = await turn(F.driver, "نعم");
  check("assignment accepted through the existing confirmation", /تم قبول مهمة التوصيل/.test(accepted.body), accepted.body);
  const proposal = await api(F.trackBuyer, `/orders/${F.trackOrder}/courier-fare/proposals`, "POST", { amount: "1.500", idempotencyKey: `maps-fare-${Date.now()}` });
  check("courier fare proposed by the buyer (existing R5 rule)", proposal.status === 200, proposal.data);
  for (const actor of [F.trackBuyer, F.driver]) {
    const confirmed = await api(actor, `/orders/${F.trackOrder}/courier-fare/confirm`, "POST", { proposalId: proposal.data.proposal.id });
    check("courier fare confirmed", confirmed.status === 200, confirmed.data);
  }
  await turn(F.driver, "استلمت الطلب");
  const onTheWay = await turn(F.driver, "أنا في الطريق");
  void onTheWay;

  // ── 3. Buyer: honest timeline before any GPS ───────────────────────────────────────────
  let tracked = await turn(F.trackBuyer, "تتبع طلبي");
  if (tracked.surface === "ORDER_SELECTOR") tracked = await turn(F.trackBuyer, "الأول");
  check("buyer reaches the tracking card in the conversation", tracked.surface === "ORDER_TRACKING", tracked);
  const buyerView = await open(F.trackBuyer);
  await buyerView.page.goto("/", { waitUntil: "networkidle" });
  const card = buyerView.page.locator(`[data-testid="order-tracking-${F.trackOrder}"]`).last();
  await card.waitFor({ timeout: 30_000 });
  const stateBefore = await card.getByTestId(`tracking-live-state-${F.trackOrder}`).getAttribute("data-state");
  check("no GPS yet: tracking says unavailable instead of inventing a position", stateBefore === "UNAVAILABLE", stateBefore);
  check("no driver marker without a shared position", (await card.locator('[data-testid="map-marker-driver"]').count()) === 0);
  check("progress timeline shows the real events", /استلم المندوب|بدأ التوصيل/.test(await card.innerText()));
  await card.screenshot({ path: `${SHOTS}/03-tracking-without-gps-mobile.png` });

  // ── 6. Driver starts sharing: explicit consent, visible indicator ───────────────────────
  await driverView.page.reload({ waitUntil: "networkidle" });
  const start = driverView.page.getByTestId("driver-sharing-start").last();
  await start.waitFor({ timeout: 30_000 });
  await start.click();
  const consent = driverView.page.getByTestId("driver-sharing-consent").last();
  check("consent explains scope before anything is shared", /فقط آخر موقع|لا يُحفظ مسار/.test(await consent.innerText()));
  await driverView.page.getByTestId("driver-sharing-consent-accept").last().click();
  await driverView.page.getByTestId("driver-sharing-active").last().waitFor({ timeout: 20_000 });
  await driverView.page.waitForSelector('[data-testid="driver-sharing-state"][data-state="SHARING"]', { timeout: 30_000 });
  check("an always-visible indicator shows sharing is active", await driverView.page.getByTestId("driver-sharing-active").last().isVisible());
  await driverView.page.getByTestId("driver-sharing-active").last().scrollIntoViewIfNeeded();
  await driverView.page.screenshot({ path: `${SHOTS}/06-driver-active-sharing-mobile.png` });

  // ── 4. Buyer: live position from the driver's (synthetic) device ────────────────────────
  await buyerView.page.reload({ waitUntil: "networkidle" });
  const liveCard = buyerView.page.locator(`[data-testid="order-tracking-${F.trackOrder}"]`).last();
  await buyerView.page.waitForSelector(`[data-testid="tracking-live-state-${F.trackOrder}"][data-state="LIVE"]`, { timeout: 30_000 });
  await buyerView.page.waitForSelector(`[data-testid="tracking-map-${F.trackOrder}"][data-ready="true"]`, { timeout: 30_000 });
  await liveCard.locator('[data-testid="map-marker-driver"]').waitFor({ timeout: 15_000 });
  check("live driver marker and destination marker are both drawn", (await liveCard.locator('[data-testid="map-marker-destination"]').count()) === 1);
  check("synthetic data is labelled on the live map", await liveCard.getByTestId(`tracking-map-${F.trackOrder}-synthetic-label`).isVisible());
  check("last update time is shown", /آخر تحديث للموقع/.test(await liveCard.innerText()));
  check("no ETA is invented", !/وقت الوصول المتوقع:|يصل خلال/.test(await liveCard.innerText()));
  const before = await liveCard.locator('[data-testid="map-marker-driver"]').boundingBox();
  await liveCard.screenshot({ path: `${SHOTS}/04-live-tracking-synthetic-mobile.png` });
  // A second synthetic fix: the device moves, the server accepts it after the minimum interval.
  await driverView.context.setGeolocation(SYNTH_B);
  await wait(7_000);
  await buyerView.page.waitForTimeout(11_000);
  const after = await liveCard.locator('[data-testid="map-marker-driver"]').boundingBox();
  const serverView = await api(F.trackBuyer, `/orders/${F.trackOrder}/tracking`);
  const sharing = await api(F.driver, `/courier/orders/${F.trackOrder}/location-sharing`);
  const sent = await driverView.page.evaluate(() => window.__dinarSharingLog ?? null);
  check("the marker moves only because a newer validated fix arrived", before && after && (Math.abs(before.x - after.x) + Math.abs(before.y - after.y)) > 1, { before, after, server: serverView.data?.tracking?.position, sharing: sharing.data, sent });
  const desktop = await open(F.trackBuyer, { width: 1280, height: 860 });
  await desktop.page.goto("/", { waitUntil: "networkidle" });
  await desktop.page.waitForSelector(`[data-testid="tracking-map-${F.trackOrder}"][data-ready="true"]`, { timeout: 30_000 });
  await desktop.page.locator(`[data-testid="order-tracking-${F.trackOrder}"]`).last().screenshot({ path: `${SHOTS}/04b-live-tracking-synthetic-desktop.png` });
  const reduced = await open(F.trackBuyer, { reducedMotion: true });
  await reduced.page.goto("/", { waitUntil: "networkidle" });
  await reduced.page.waitForSelector(`[data-testid="tracking-map-${F.trackOrder}"][data-ready="true"]`, { timeout: 30_000 });
  check("reduced motion renders the same live card", await reduced.page.locator('[data-testid="map-marker-driver"]').count() >= 1);
  const narrow = await open(F.trackBuyer, { width: 320, height: 720 });
  await narrow.page.goto("/", { waitUntil: "networkidle" });
  await narrow.page.waitForSelector(`[data-testid="tracking-map-${F.trackOrder}"][data-ready="true"]`, { timeout: 30_000 });
  check("no horizontal overflow at 320 px", (await overflow(narrow.page)) === 0);
  await narrow.page.locator(`[data-testid="order-tracking-${F.trackOrder}"]`).last().screenshot({ path: `${SHOTS}/04c-live-tracking-synthetic-320.png` });

  // ── Authorization from the browser's point of view ─────────────────────────────────────
  const stranger = await api(F.pickBuyer, `/orders/${F.trackOrder}/tracking`);
  check("another user cannot read this order's tracking", stranger.status === 404, stranger.status);
  const injected = await api(F.pickBuyer, `/courier/orders/${F.trackOrder}/location-sharing/location`, "POST", { ...SYNTH_A, accuracyMeters: 5, observedAt: new Date().toISOString(), sequence: 999 });
  check("a non-driver cannot inject a position", injected.status === 404, injected.status);

  // ── 7. Delivery completed: sharing ends, tracking stops ─────────────────────────────────
  const handoff = await turn(F.driver, "تم التسليم");
  check("handoff recorded through the existing flow", /تم التسليم/.test(handoff.body), handoff.body);
  await buyerView.page.reload({ waitUntil: "networkidle" });
  await buyerView.page.waitForSelector(`[data-testid="tracking-live-state-${F.trackOrder}"][data-state="STOPPED"]`, { timeout: 30_000 });
  check("after delivery no map or driver position is shown", (await buyerView.page.locator('[data-testid="map-marker-driver"]').count()) === 0);
  await buyerView.page.locator(`[data-testid="order-tracking-${F.trackOrder}"]`).last().screenshot({ path: `${SHOTS}/07-delivered-tracking-stopped-mobile.png` });
  const sharingAfter = await api(F.driver, `/courier/orders/${F.trackOrder}/location-sharing`);
  check("the driver's sharing session ended with the delivery", sharingAfter.data.active === false && sharingAfter.data.endReason === "DELIVERY_ENDED", sharingAfter.data);
  await driverView.page.reload({ waitUntil: "networkidle" });
  await driverView.page.screenshot({ path: `${SHOTS}/07b-driver-after-delivery-mobile.png` });
  check("buyer tracking page has no horizontal overflow", (await overflow(buyerView.page)) === 0);
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  await browser.close();
  await writeFile(env.MT_REPORT, JSON.stringify(report, null, 2));
}
