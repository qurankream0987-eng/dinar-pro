import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder } from "./sc-ui-session.mjs";
import {
  backend,
  cartQuantity,
  conversationReview,
  openPage,
  purchaseCard,
  sendTurn,
  sleep,
  startConversation,
  signIn,
  signOut,
  waitForCardLifecycle,
} from "./w02u3-ui-session.mjs";

/**
 * W02U-3 — CR-04/CR-05 account switch and logout/re-login in the real browser.
 *
 * A signs in through the real login form, opens a pending review, and a re-read of that
 * conversation is held mid-flight. A signs out through the real account flow while the delayed
 * response lands; B signs in through the same form. B must see none of A's transcript, card,
 * conversation or session, even when the delayed response is released, when the page reloads, and
 * when A's conversation id is planted in B's own storage key. The backend refuses B's reads and
 * turns with A's conversation id. A's review is then settled by A's other client while A is
 * signed out; signing back in must restore A's history from the server with the settled
 * lifecycle, not the stale pending card.
 */
const webBase = process.env.W02U3_WEB_BASE;
const apiOrigin = process.env.W02U3_API_ORIGIN;
const a = {
  cookie: process.env.W02U3_A_COOKIE,
  id: process.env.W02U3_A_ID,
  phone: process.env.W02U3_A_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const b = {
  cookie: process.env.W02U3_B_COOKIE,
  id: process.env.W02U3_B_ID,
  phone: process.env.W02U3_B_PHONE,
  password: process.env.W02U3_PASSWORD,
};
const firstTitle = process.env.W02U3_FIRST_TITLE;
const secondTitle = process.env.W02U3_SECOND_TITLE;
const firstListingId = process.env.W02U3_FIRST_LISTING_ID;
const secondListingId = process.env.W02U3_SECOND_LISTING_ID;
const resultPath = process.env.W02U3_SESSIONS_RESULT_PATH;
if (!webBase || !apiOrigin || !a.cookie || !a.id || !a.phone || !b.cookie || !b.id || !b.phone || !b.password || !firstTitle || !secondTitle || !firstListingId || !secondListingId || !resultPath)
  throw new Error("Missing W02U-3 sessions journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
const surfaces = {};
const sessions = {};
let failure;
let browser;
let context;
let page;
let aConversationId;

const cardOf = () => page.locator('[data-testid="purchase-review"][data-card-lifecycle]').last();

// The mobile history drawer is a Radix dialog: its overlay makes the toggle behind it
// unclickable, so it is closed through its own control (or Escape), never through the toggle.
async function historyOpen() {
  const toggle = page.getByTestId("button-toggle-conversation-history");
  return (await toggle.getAttribute("aria-expanded").catch(() => null)) === "true";
}

async function openHistory() {
  if (!(await historyOpen())) {
    const toggle = page.getByTestId("button-toggle-conversation-history");
    await toggle.waitFor({ state: "visible", timeout: 15_000 });
    await toggle.click();
  }
  await page.getByTestId("input-conversation-search").waitFor({ timeout: 15_000 });
}

async function closeHistory() {
  if (!(await historyOpen())) return;
  // Escape closes the Radix dialog without any pointer movement. A toast hosts above the
  // drawer's own close button at the top-centre of the phone viewport, so a click there hovers
  // the toast (which pauses its dismissal) and never reaches the button.
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="button-toggle-conversation-history"]')?.getAttribute("aria-expanded") !== "true",
    null,
    { timeout: 15_000 },
  );
}

async function noStaleData(label, extra = {}) {
  const cardCount = await page.locator('[data-testid="purchase-review"]').count();
  assert.ok(cardCount >= (extra.cards ?? 0), `${label}: expected ${extra.cards ?? 0} review cards, found ${cardCount}`);
  if (extra.surfaceId)
    assert.equal(await page.locator(`[data-testid="purchase-review"][data-card-surface-id="${extra.surfaceId}"]`).count(), 0, `${label}: a foreign card identity is rendered`);
  const html = await page.content();
  assert.ok(!html.includes(aConversationId), `${label}: a foreign conversation id is rendered`);
  if (extra.surfaceId) assert.ok(!html.includes(extra.surfaceId), `${label}: a foreign card identity is rendered`);
  const text = await page.locator("body").innerText();
  assert.ok(!text.includes(firstTitle), `${label}: a foreign conversation title is rendered`);
  if (extra.conversationId) {
    await openHistory();
    assert.equal(await page.getByTestId(`conversation-${extra.conversationId}`).count(), 0, `${label}: a foreign conversation is listed`);
    await closeHistory();
  }
}

function cookieValue(cookieHeader, name) {
  const part = cookieHeader.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  ({ context, page } = await openPage(browser, { webBase, label: "tab", recorder }));

  // ── CR-04: A signs in, opens a pending review ───────────────────────────────
  await signIn(page, a);
  aConversationId = await startConversation(page);
  await sendTurn(page, recorder, `ابحث عن ${firstTitle}`);
  await sendTurn(page, recorder, "ابي الأول");
  const aCard = await purchaseCard(page);
  assert.equal(aCard.lifecycle, "PENDING_REVIEW");
  assert.ok(aCard.surfaceId, "A's review has a server identity");
  surfaces.aPending = { conversationId: aConversationId, surfaceId: aCard.surfaceId, lifecycle: aCard.lifecycle };
  assert.equal(await cartQuantity(apiOrigin, a.cookie, firstListingId), 0, "a pending review has no effect yet");
  checks.push("CR-04: A signs in through the login form and sees a pending review with a server identity");

  // ── CR-04: a re-read is delayed across the switch ───────────────────────────
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let firstHeld;
  const sawHeld = new Promise((resolve) => {
    firstHeld = resolve;
  });
  let heldSeen = false;
  await context.route(`**/api/ai/conversations/${aConversationId}`, async (route) => {
    if (route.request().method() !== "GET" || heldSeen) return route.fallback();
    heldSeen = true;
    firstHeld();
    try {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
      sessions.delayedResponseDelivered = true;
    } catch {
      sessions.delayedResponseDelivered = sessions.delayedResponseDelivered ?? false;
    }
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await Promise.race([
    sawHeld,
    sleep(20_000).then(() => {
      throw new Error("the conversation re-read was not requested");
    }),
  ]);
  sessions.delayedResponseHeld = true;
  checks.push("CR-04: a re-read of A's conversation is held in flight while the account switches");

  // ── CR-04/CR-05: A signs out through the real flow, releasing the delay ─────
  await page.goto("/settings");
  await page.getByTestId("button-settings-logout").waitFor({ timeout: 45_000 });
  await page.getByTestId("button-settings-logout").click();
  await page.getByTestId("button-confirm-action").click();
  releaseGate();
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await noStaleData("after A logs out", { conversationId: aConversationId, surfaceId: aCard.surfaceId, cards: 0 });
  checks.push("CR-05: signing out removes A's authenticated transcript");

  // ── CR-04/CR-05: B signs in on the same browser ─────────────────────────────
  await signIn(page, b);
  await noStaleData("B after sign-in", { conversationId: aConversationId, surfaceId: aCard.surfaceId, cards: 0 });
  const bSession = (await context.cookies()).find((cookie) => cookie.name === "bdinar_session");
  assert.ok(bSession, "the browser carries one session cookie");
  assert.notEqual(bSession.value, cookieValue(a.cookie, "bdinar_session"), "the session cookie belongs to B now");
  const bKeys = await page.evaluate(() => Object.keys(localStorage));
  sessions.aKeyPresent = bKeys.some((key) => key.startsWith(`dinar-conversation:${a.id}:`));
  sessions.bKey = bKeys.find((key) => key.startsWith(`dinar-conversation:${b.id}:`)) ?? null;
  checks.push("CR-04: B signs in through the same login form and inherits none of A's view");

  // The delayed response lands, then a focus re-read runs in B's tab.
  await sleep(2500);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(1500);
  await noStaleData("B after the delayed response", { conversationId: aConversationId, surfaceId: aCard.surfaceId, cards: 0 });
  checks.push("CR-04: a delayed response from A's session cannot restore A's transcript in B's session");

  // ── CR-04: the backend refuses B on A's conversation ────────────────────────
  const hostileRead = await backend(apiOrigin, b.cookie, `/ai/conversations/${aConversationId}`);
  assert.equal(hostileRead.status, 404, `B reading A's conversation: ${hostileRead.status} ${hostileRead.text.slice(0, 200)}`);
  const hostileTurn = await backend(apiOrigin, b.cookie, `/ai/conversations/${aConversationId}/turns`, "POST", { message: "نعم", clientMessageId: randomUUID() });
  assert.equal(hostileTurn.status, 404, `B driving A's review: ${hostileTurn.status} ${hostileTurn.text.slice(0, 200)}`);
  assert.equal(await cartQuantity(apiOrigin, a.cookie, firstListingId), 0, "B's refused turn changes nothing for A");
  const stillPending = await conversationReview(apiOrigin, a.cookie, aConversationId);
  assert.equal(stillPending?.card?.status?.lifecycle, "PENDING_REVIEW", "A's review is untouched by B");
  checks.push("CR-04: the backend refuses B's read and B's turn on A's conversation");

  // ── CR-04/CR-05: B's own conversations work normally ────────────────────────
  const bConversationId = await startConversation(page);
  await sendTurn(page, recorder, `ابحث عن ${secondTitle}`);
  await sendTurn(page, recorder, "ابي الأول");
  const bCard = await purchaseCard(page);
  assert.equal(bCard.lifecycle, "PENDING_REVIEW");
  assert.notEqual(bCard.surfaceId, aCard.surfaceId, "B's review has its own identity");
  surfaces.bPending = { conversationId: bConversationId, surfaceId: bCard.surfaceId, lifecycle: bCard.lifecycle };
  await page.getByTestId("purchase-confirm").click();
  await waitForCardLifecycle(page, "CONFIRMED");
  assert.equal(await cartQuantity(apiOrigin, b.cookie, secondListingId), 1, "B's own confirmation is authorized");
  assert.equal(await cartQuantity(apiOrigin, a.cookie, firstListingId), 0, "and it never touches A's cart");
  checks.push("CR-04: B can open and settle a conversation of their own");

  // ── CR-05: reload keeps the accounts apart ──────────────────────────────────
  await page.reload();
  await cardOf().waitFor({ state: "visible", timeout: 45_000 });
  const bReloaded = await purchaseCard(page);
  assert.equal(bReloaded.lifecycle, "CONFIRMED", "B's settled card reloads from the server");
  assert.deepEqual(bReloaded.buttons, [], "B's settled card has no action");
  await noStaleData("B after reload", { conversationId: aConversationId, surfaceId: aCard.surfaceId, cards: 1 });
  assert.equal(await cartQuantity(apiOrigin, b.cookie, secondListingId), 1, "the reload repeats no effect");
  checks.push("CR-05: a reload keeps B's state and none of A's");

  // A's conversation id planted in B's own key must not be opened.
  const plantKey = await page.evaluate(
    ({ bId, foreign }) => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith(`dinar-conversation:${bId}:`)) ?? `dinar-conversation:${bId}:JO`;
      localStorage.setItem(key, foreign);
      return localStorage.getItem(key) === foreign;
    },
    { bId: b.id, foreign: aConversationId },
  );
  assert.equal(plantKey, true);
  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await sleep(1500);
  // The planted id is not in B's server list, so the page opens empty rather than opening it.
  await noStaleData("B after a planted foreign id", { conversationId: aConversationId, surfaceId: aCard.surfaceId, cards: 0 });
  await openHistory();
  const bItem = page.getByTestId(`conversation-${bConversationId}`);
  assert.equal(await bItem.isVisible().catch(() => false), true, "B's own conversation remains listed");
  await bItem.click();
  await waitForCardLifecycle(page, "CONFIRMED", 45_000);
  await noStaleData("B restores their own conversation", { surfaceId: aCard.surfaceId, cards: 1 });
  checks.push("CR-05: a planted foreign conversation id is never opened by B");

  // ── CR-05: A's own client settles the review while A is signed out ─────────
  const settled = await backend(apiOrigin, a.cookie, `/ai/conversations/${aConversationId}/turns`, "POST", { message: "نعم", clientMessageId: randomUUID() });
  assert.equal(settled.status, 200, `A's other client confirms: ${settled.status} ${settled.text.slice(0, 200)}`);
  assert.equal(await cartQuantity(apiOrigin, a.cookie, firstListingId), 1, "A's other client confirmation reaches A's cart");
  const settledCard = await conversationReview(apiOrigin, a.cookie, aConversationId);
  assert.equal(settledCard?.card?.status?.lifecycle, "CONFIRMED", "the server stores the settled lifecycle");
  checks.push("CR-05: A's review is settled on the server while A is signed out");

  // ── CR-05: B signs out, A signs back in ─────────────────────────────────────
  await signOut(page);
  await noStaleData("after B logs out", { cards: 0 });
  await signIn(page, a);
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  if (!(await cardOf().isVisible().catch(() => false))) {
    await openHistory();
    const item = page.getByTestId(`conversation-${aConversationId}`);
    assert.equal(await item.isVisible().catch(() => false), true, "A's conversation is listed for A");
    await item.click();
  }
  await waitForCardLifecycle(page, "CONFIRMED", 45_000);
  const restored = await purchaseCard(page);
  assert.equal(restored.surfaceId, aCard.surfaceId, "A's history keeps the review identity");
  assert.deepEqual(restored.buttons, [], "the settled review offers no stale action");
  const restoredText = await page.locator("body").innerText();
  assert.ok(restoredText.includes(firstTitle), "A's own conversation is restored");
  assert.ok(!restoredText.includes(secondTitle), "B's conversation is not visible to A");
  await openHistory();
  assert.equal(await page.getByTestId(`conversation-${bConversationId}`).count(), 0, "B's conversation is not listed for A");
  assert.equal(await cartQuantity(apiOrigin, a.cookie, firstListingId), 1, "the restored card does not repeat the effect");
  checks.push("CR-05: A's legitimate history returns from the server with its current authoritative lifecycle");

  assert.deepEqual(recorder.modelFallbacks, [], "no deterministic turn fell back to the model");
  surfaces.aRestored = { surfaceId: restored.surfaceId, lifecycle: restored.lifecycle };
  sessions.staleResponseLeak = false;
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        checks,
        failure,
        surfaces,
        sessions,
        pageErrors: recorder.pageErrors,
        consoleErrors: recorder.consoleErrors,
        externalRequests: recorder.externalRequests,
        horizontalOverflow: recorder.horizontalOverflow,
        steps: recorder.steps,
        modelFallbacks: recorder.modelFallbacks,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => undefined);
}
