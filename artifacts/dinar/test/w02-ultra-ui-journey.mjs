import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * W02-ULTRA in the real DINAR UI: a buyer compares listings from two unrelated categories and
 * reads the card itself — every row says where its value comes from, a characteristic the other
 * category does not have reads «لا ينطبق», an empty one «لم يذكر البائع», and the computed facts
 * are labelled as computed. Then the card's stability: after newer turns, the reader goes back to
 * the comparison and the viewport changes (rotation, keyboard, width) — the card stays in view.
 * Fixtures come from the suite through the API; every user action below is the UI's.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("W02U_WEB_BASE");
const apiOrigin = env("W02U_API_ORIGIN");
const run = env("W02U_RUN");
const resultPath = env("W02U_UI_RESULT_PATH");
const shotDir = process.env.W02U_SHOT_DIR;
const WIDTHS = [320, 375, 390, 428, 768, 1280];
const recorder = createRecorder(webBase, apiOrigin);
const outcome = {};
const sessions = [];
let failure;
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie: env("W02U_BUYER_COOKIE"), label: "buyer", recorder });
  sessions.push(buyer);
  await buyer.context.route(/fonts\.(googleapis|gstatic)\.com/u, (route) => route.fulfill({ status: 204, contentType: "text/css", body: "" }));

  await buyer.newConversation();
  const found = await buyer.say(`ابحث عن ${run}`);
  await found.getByTestId("ai-results-list").waitFor();
  await buyer.say("رتبهم من الأرخص");
  const compared = await buyer.say("قارن الأول والثاني والثالث");
  const card = compared.getByTestId("comparison");
  await card.waitFor();
  const text = (await card.innerText()).replace(/\s+/g, " ");
  assert.match(text, /كما ذكره البائع/u, "seller-provided rows are labelled");
  assert.match(text, /من سجل DINAR/u, "record rows are labelled");
  assert.match(text, /لا ينطبق/u, "a characteristic the other category lacks reads «لا ينطبق»");
  assert.match(text, /لم يذكر البائع/u, "an empty characteristic reads «لم يذكر البائع»");
  const highlights = card.getByTestId("comparison-highlights");
  await highlights.waitFor();
  assert.equal(await highlights.getAttribute("aria-label"), "حقائق محسوبة من المقارنة");
  assert.match(await highlights.innerText(), /الأقل السعر|الأقل/u);
  assert.equal(await card.getAttribute("aria-label"), "مقارنة العروض", "the card has an accessible name");
  outcome.comparisonText = text.slice(0, 400);
  await buyer.widths("W02U comparison", card, WIDTHS);
  if (shotDir)
    for (const width of WIDTHS) {
      await buyer.page.setViewportSize({ width, height: 844 });
      await card.scrollIntoViewIfNeeded();
      await buyer.page.screenshot({ path: `${shotDir}/w02u-comparison-${width}.png` });
    }
  recorder.checks.push("comparison card: sources, «لا ينطبق», «لم يذكر البائع» and computed facts rendered at six widths");

  // ── «Which one» answers render as text: no card is needed for a one-line fact ──
  const which = await buyer.say("أيهم السعر أقل؟");
  assert.equal(await which.getByTestId("comparison").count(), 0, "a one-line answer is text, not another comparison card");

  // ── Scroll stability: back to the older card, then the viewport changes ──
  await buyer.say("كيف أختار بين عرضين؟", { allowFallback: true });
  await buyer.say("شكرا", { allowFallback: true });
  // The comparison is now an older message: address it directly, not as «the latest reply».
  const older = buyer.page.getByTestId("comparison").first();
  await buyer.page.setViewportSize({ width: 390, height: 844 });
  await older.scrollIntoViewIfNeeded();
  await buyer.page.waitForTimeout(400);
  for (const width of [320, 768, 375]) {
    await buyer.page.setViewportSize({ width, height: 700 });
    await buyer.page.waitForTimeout(500);
    const box = await older.boundingBox();
    const viewport = buyer.page.viewportSize();
    assert.ok(box && box.y + box.height > 0 && box.y < viewport.height, `the older card stays in view after resizing to ${width}px: ${JSON.stringify(box)}`);
  }
  recorder.checks.push("an older card stays in view when the viewport changes after the reader returned to it");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify({ failure, ...outcome, checks: recorder.checks, steps: recorder.steps, modelFallbacks: recorder.modelFallbacks, pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors, externalRequests: recorder.externalRequests, horizontalOverflow: recorder.horizontalOverflow }),
  );
  for (const session of sessions) await session.context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
