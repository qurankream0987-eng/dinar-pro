import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * SC06 end to end in the real DINAR UI (docs/dinar-next/HANDOFF_FOR_NEXT_AGENT.md T2): a buyer
 * asks for an industrial packaging machine, narrows the results to 220 volts, then asks whether
 * it runs 8 continuous hours — a spec the listing does not record. DINAR answers from the record
 * («لم يذكر البائع ساعات التشغيل») and opens the inquiry review «أسأل البائع؟»; nothing is sent.
 * The calling suite checks the database afterwards.
 *
 * The fixtures are created by the suite through the API; every user action below is the UI's.
 */
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const webBase = env("SC06_WEB_BASE");
const apiOrigin = env("SC06_API_ORIGIN");
const machineId = env("SC06_MACHINE_ID");
const otherMachineId = env("SC06_OTHER_ID");
const resultPath = env("SC06_UI_RESULT_PATH");
const recorder = createRecorder(webBase, apiOrigin);
const outcome = {};
const sessions = [];
let failure;
let browser;

const cardIds = (reply) =>
  reply.locator('[data-testid^="card-ai-result-"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-resource-id")));

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie: env("SC06_BUYER_COOKIE"), label: "buyer", recorder });
  sessions.push(buyer);
  // Presentation fonts never leave the machine: answering them locally keeps the run self-contained.
  await buyer.context.route(/fonts\.(googleapis|gstatic)\.com/u, (route) => route.fulfill({ status: 204, contentType: "text/css", body: "" }));

  // ── 1. The machines are found ──
  await buyer.newConversation();
  const found = await buyer.say("أريد ماكينة صناعية مستعملة لتغليف المنتجات");
  await found.getByTestId("ai-results-list").waitFor();
  const foundIds = await cardIds(found);
  assert.ok(foundIds.includes(machineId), `the 220V machine is found: ${foundIds}`);
  assert.ok(foundIds.includes(otherMachineId), `the 380V machine is found: ${foundIds}`);
  outcome.foundIds = foundIds;

  // ── 2. Only the 220-volt machine stays ──
  const filtered = await buyer.say("اعرض لي الماكينات 220 فولت فقط");
  await filtered.getByTestId("ai-results-list").waitFor();
  const filteredIds = await cardIds(filtered);
  assert.deepEqual(filteredIds, [machineId], `only the 220V machine stays: ${filteredIds}`);
  await buyer.widths("SC06 buyer results", filtered.getByTestId("ai-results-list"));
  recorder.checks.push("two machines found, then narrowed to the 220V one");

  // ── 3. «هل تعمل 8 ساعات متواصلة؟» — an unsent inquiry review, never an invented answer ──
  const question = await buyer.say("هل تعمل 8 ساعات متواصلة؟");
  const replyText = await question.innerText();
  assert.match(replyText, /لم يذكر البائع ساعات التشغيل/u, `a deterministic answer, not the model: ${replyText.slice(0, 300)}`);
  const inquiry = question.getByTestId("inquiry-surface");
  await inquiry.waitFor();
  assert.equal(await inquiry.getAttribute("data-view"), "DRAFT", "the answer opens a draft review");
  const draftText = await inquiry.getByTestId("inquiry-draft").innerText();
  assert.match(draftText, /ساعات/u, `the drafted question asks about the operating hours: ${draftText.slice(0, 200)}`);
  assert.match(await inquiry.getByTestId("inquiry-draft-status").innerText(), /بانتظار|مراجعة|لم يُرسل/u);
  assert.equal(await question.getByTestId("inquiry-message").count(), 0, "nothing was sent to the seller");
  await buyer.widths("SC06 spec review", inquiry);
  outcome.draftText = draftText.replace(/\s+/g, " ").slice(0, 300);
  recorder.checks.push("«هل تعمل 8 ساعات متواصلة؟» answered from the record and left the question unsent");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(
    resultPath,
    JSON.stringify({ failure, ...outcome, checks: recorder.checks, steps: recorder.steps, modelFallbacks: recorder.modelFallbacks, pageErrors: recorder.pageErrors, consoleErrors: recorder.consoleErrors, externalRequests: recorder.externalRequests, horizontalOverflow: recorder.horizontalOverflow }, null, 2),
  );
  for (const session of sessions) await session.context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
