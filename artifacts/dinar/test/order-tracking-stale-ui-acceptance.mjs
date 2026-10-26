import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const baseURL = process.env.PREMIUM_UI_BASE ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
const trackingText = "بيانات الموقع قديمة وليست مباشرة";
const block = {
  type: "SURFACE",
  version: 1,
  payload: { resultSetId: "fixture-tracking", listings: [], surface: "ORDER_TRACKING", resourceId: "order-ui" },
};
const message = {
  id: "fixture-tracking-message",
  role: "ASSISTANT",
  body: "تفاصيل طلبك من دينار",
  createdAt: new Date().toISOString(),
  blocks: [block],
};
const market = {
  id: "KW",
  status: "ACTIVE",
  isActive: true,
  priceConfigured: true,
  countryNameEn: "Kuwait",
  countryNameAr: "الكويت",
  countryCode: "KW",
  currencyCode: "KWD",
  currencySymbolAr: "د.ك",
  unitPriceMinor: 1000,
  minorUnitScale: 3,
  fulfilmentMethods: ["PICKUP"],
  paymentMethods: ["CASH"],
  restrictedCategories: [],
  sellerEligibilityMode: "OPEN",
};
const staleTracking = {
  orderId: "order-ui",
  orderStatus: "PENDING",
  delivery: null,
  tracking: {
    state: "STALE",
    position: { latitude: 29.123456, longitude: 48.654321, observedAt: "2026-10-14T10:00:00.000Z" },
    route: null,
    eta: null,
  },
  progress: [{ type: "PICKED_UP", occurredAt: "2026-10-14T10:00:00.000Z", actorRole: "COURIER" }],
};

await context.addInitScript((initialMessage) => {
  sessionStorage.setItem("dinar-guest-handoff", JSON.stringify({
    marketId: "KW",
    messages: [initialMessage],
    context: {},
  }));
}, message);
await context.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  let body = [];
  if (path === "/api/auth/me") body = { user: null };
  else if (path === "/api/markets") body = [market];
  else if (path === "/api/policies") body = { policies: [], fees: { commissionRateBps: 100, payer: "SELLER", buyerFeeBps: 0 } };
  else if (path === "/api/ai/conversations") body = [];
  else if (path.endsWith("/tracking")) body = staleTracking;
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
});

try {
  const page = await context.newPage();
  await page.goto("/");
  await page.getByTestId("order-tracking-order-ui").waitFor();
  for (const width of [375, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const surface = page.getByTestId("order-tracking-order-ui");
    await surface.waitFor();
    const text = await surface.innerText();
    assert.ok(text.includes(trackingText), `${width}px: stale state is explicitly labeled`);
    assert.ok(!text.includes("29.123456") && !text.includes("48.654321"), `${width}px: coordinates are not shown`);
    const box = await surface.boundingBox();
    assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1, `${width}px: tracking surface fits viewport`);
  }
  console.log("ORDER_TRACKING_STALE_UI_PASS widths=375,430,768,1440 staleLabel=true coordinatesHidden=true");
} finally {
  await context.close();
  await browser.close();
}
