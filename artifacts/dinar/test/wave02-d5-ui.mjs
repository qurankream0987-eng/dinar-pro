import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, MODEL_FALLBACK_REPLY, openUser } from "./sc-ui-session.mjs";

/**
 * WAVE 02 / D5 in the real browser. The owner restores the DINAR inquiry inbox, reads the drafted
 * reply exactly as the server rebuilt it, survives a reload, approves it once, and later — after the
 * grant is revoked — reopens the conversation to a rejected card with no action left.
 */
const webBase = process.env.W02D5_WEB_BASE;
const apiOrigin = process.env.W02D5_API_ORIGIN;
const ownerCookie = process.env.W02D5_OWNER_COOKIE;
const ownerId = process.env.W02D5_OWNER_ID;
const conversationId = process.env.W02D5_CONVERSATION_ID;
const phase = process.env.W02D5_PHASE ?? "review";
const resultPath = process.env.W02D5_UI_RESULT_PATH;
if (!webBase || !apiOrigin || !ownerCookie || !ownerId || !conversationId || !resultPath)
  throw new Error("Missing WAVE 02 D5 browser journey configuration.");

const recorder = createRecorder(webBase, apiOrigin);
const checks = [];
let failure;
let browser;
let draft = {};

const cardOf = (page) => page.locator('[data-testid="inquiry-surface"][data-view="DRAFT"]').last();

async function openInbox(page) {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor({ timeout: 45_000 });
  await page.evaluate(
    ([key, id]) => localStorage.setItem(key, id),
    [`dinar-conversation:${ownerId}:JO`, conversationId],
  );
  await page.reload();
  await cardOf(page).waitFor({ state: "visible", timeout: 45_000 });
}

async function cardInfo(page) {
  const card = cardOf(page);
  const status = card.locator('[data-testid="inquiry-draft-status"]');
  return {
    body: (await card.locator("blockquote").first().innerText()).trim(),
    status: await status.count() ? (await status.innerText()).trim() : "",
    sendButtons: await page.locator('[data-testid="inquiry-send"]:visible').count(),
  };
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const owner = await openUser(browser, { webBase, apiOrigin, cookie: ownerCookie, label: `owner-${phase}`, recorder });
  const page = owner.page;

  await openInbox(page);
  draft = await cardInfo(page);

  if (phase === "review") {
    assert.equal(draft.status, "بانتظار موافقتك — لم يُرسل بعد");
    assert.equal(draft.body, "المتوفر حاليًا 35 قطعة.");
    assert.equal(draft.sendButtons, 1, "a pending draft offers exactly one approval");
    checks.push("the owner reads the drafted reply and its pending status in DINAR's own words");

    await owner.widths("D5 draft review", cardOf(page));
    checks.push("the draft review is RTL, overflow-free and named at 320/390/1280");

    // A reload re-reads the same pending card from the server; nothing was sent by reading it.
    await page.reload();
    await cardOf(page).waitFor({ state: "visible", timeout: 45_000 });
    const restored = await cardInfo(page);
    assert.equal(restored.status, "بانتظار موافقتك — لم يُرسل بعد", "the pending reply survives a reload");
    assert.equal(restored.body, draft.body);
    assert.equal(restored.sendButtons, 1);
    checks.push("reload preserves the pending reply; reading it sends nothing");

    const before = await page.locator('[data-testid^="message-assistant-"]').count();
    await owner.click(page.locator('[data-testid="inquiry-send"]:visible').first());
    assert.ok((await page.locator('[data-testid^="message-assistant-"]').count()) > before);
    const confirmation = await page.locator('[data-testid^="message-assistant-"]').last().innerText();
    assert.match(confirmation, /أُرسلت|تم الإرسال/u, confirmation);
    checks.push("the owner's own approval sends the reply once and DINAR reports it");

    await page.reload();
    await page.locator('[data-testid="inquiry-surface"]').last().waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await page.locator('[data-testid="inquiry-send"]:visible').count(), 0, "a settled draft has nothing left to approve");
    assert.match(await page.locator('[data-testid="inquiry-surface"]').last().innerText(), /أُرسلت|انتهت صلاحيتها/u);
    checks.push("after the send a reload shows the settled card with no second approval");
  } else {
    assert.equal(draft.status, "لم تُرسل؛ لم يتغير شيء", "revocation rebuilds the draft as rejected");
    assert.equal(draft.body, "المتوفر حاليًا 17 قطعة.");
    assert.equal(draft.sendButtons, 0, "a rejected draft offers no action");
    checks.push("after revocation the owner still reads the draft, and it cannot be sent");

    await owner.widths("D5 rejected draft", cardOf(page));
    checks.push("the rejected card stays RTL, overflow-free and named at 320/390/1280");

    await page.reload();
    await cardOf(page).waitFor({ state: "visible", timeout: 45_000 });
    const again = await cardInfo(page);
    assert.equal(again.status, "لم تُرسل؛ لم يتغير شيء");
    assert.equal(again.sendButtons, 0);
    checks.push("the revoked decision survives a reload; nothing was ever sent");
  }

  assert.deepEqual(recorder.modelFallbacks, [], "no browser turn fell back to the model");
  assert.ok(recorder.steps.every((step) => !MODEL_FALLBACK_REPLY.test(step.reply)));
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        phase,
        checks: [...checks, ...recorder.checks],
        draft,
        failure,
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
