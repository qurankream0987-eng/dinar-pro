import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const webBase = process.env.BLOCKC_WEB_BASE;
const apiOrigin = process.env.BLOCKC_API_ORIGIN;
const employerCookie = process.env.BLOCKC_EMPLOYER_COOKIE;
const candidateCookie = process.env.BLOCKC_CANDIDATE_COOKIE;
const browserEmployerCookie = process.env.BLOCKC_BROWSER_EMPLOYER_COOKIE;
const browserCandidateCookie = process.env.BLOCKC_BROWSER_CANDIDATE_COOKIE;
const browserCandidateLoginPhone = process.env.BLOCKC_BROWSER_CANDIDATE_LOGIN_PHONE;
const browserCandidateContact = process.env.BLOCKC_BROWSER_CANDIDATE_CONTACT;
const runId = process.env.BLOCKC_RUN_ID;
const resultPath = process.env.BLOCKC_UI_RESULT_PATH;
if (
  !webBase ||
  !apiOrigin ||
  !employerCookie ||
  !candidateCookie ||
  !browserEmployerCookie ||
  !browserCandidateCookie ||
  !browserCandidateLoginPhone ||
  !browserCandidateContact ||
  !runId ||
  !resultPath
)
  throw new Error("Missing Block C browser acceptance configuration.");

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
let staticFontRequests = 0;
let horizontalOverflow = 0;
let failure;
let browser;
const contexts = [];
let page;

const allowedHosts = new Set([new URL(webBase).host, new URL(apiOrigin).host]);
const fontHosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

async function settle() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

const assistantMessages = () => page.locator('[data-testid^="message-assistant-"]');
const latestAssistant = () => assistantMessages().last();

async function waitForTurn({ assistantCount, surfaceTestId, surfaceCount }) {
  await page.waitForFunction(
    ({ assistantCount, surfaceTestId, surfaceCount }) => {
      const sendButton = document.querySelector(
        '[data-testid="button-send-ai-message"]',
      );
      const responseRendered = surfaceTestId
        ? [...document.querySelectorAll("[data-testid]")].filter(
            (element) => element.getAttribute("data-testid") === surfaceTestId,
          ).length > surfaceCount
        : document.querySelectorAll('[data-testid^="message-assistant-"]')
            .length > assistantCount;
      return (
        responseRendered &&
        sendButton?.getAttribute("aria-label") === "إرسال الرسالة"
      );
    },
    { assistantCount, surfaceTestId, surfaceCount },
    { timeout: 60_000 },
  );
  await settle();
}

async function sendTurn(text) {
  const assistantCount = await assistantMessages().count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await waitForTurn({ assistantCount });
}

async function sendTurnForSurface(text, surfaceTestId) {
  const assistantCount = await assistantMessages().count();
  const surfaceCount = await page.getByTestId(surfaceTestId).count();
  await page.getByTestId("input-ai-composer").fill(text);
  await page.getByTestId("button-send-ai-message").click();
  await waitForTurn({ assistantCount, surfaceTestId, surfaceCount });
}

/** A surface button sends the same conversational command as typing it. */
async function clickTurn(locator) {
  const assistantCount = await assistantMessages().count();
  await locator.click();
  await waitForTurn({ assistantCount });
}

async function confirmBrowserAction(action) {
  await action.getByTestId("employment-action-confirm").click();
  const status = action.getByTestId("employment-action-status");
  await status.waitFor();
  assert.equal(await status.getAttribute("data-status"), "CONFIRMED");
}

async function measure(label, width, visible) {
  await page.setViewportSize({ width, height: 844 });
  await settle();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    direction: getComputedStyle(
      document.querySelector(".dinar-chatgpt") ?? document.documentElement,
    ).direction,
  }));
  if (Math.max(dimensions.scrollWidth, dimensions.bodyScrollWidth) > dimensions.width) {
    horizontalOverflow += 1;
    throw new Error(`${label} ${width}px: horizontal overflow ${JSON.stringify(dimensions)}`);
  }
  assert.equal(dimensions.direction, "rtl", `${label} ${width}px must stay RTL`);
  const composer = await page.getByTestId("input-ai-composer").boundingBox();
  assert.ok(
    composer && composer.y >= 0 && composer.y + composer.height <= dimensions.height,
    `${label} ${width}px: composer obscured`,
  );
  if (visible) {
    await visible.scrollIntoViewIfNeeded();
    const box = await visible.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= dimensions.width + 0.5 && box.width > 0,
      `${label} ${width}px: content clipped ${JSON.stringify({ box, dimensions })}`,
    );
    const overflowing = await visible.evaluate((element) =>
      [element, ...element.querySelectorAll("*")].filter(
        (node) => node.getBoundingClientRect().right > window.innerWidth + 0.5 || node.getBoundingClientRect().left < -0.5,
      ).length,
    );
    assert.equal(overflowing, 0, `${label} ${width}px: ${overflowing} descendants outside the viewport`);
    const buttons = await visible.locator("button").evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    assert.ok(buttons.every((height) => height >= 32), `${label} ${width}px: touch targets ${buttons}`);
  }
  checks.push(`${label} ${width}px: RTL, no horizontal overflow, composer visible, content and buttons inside the viewport`);
}

async function mobile(label, visible) {
  for (const width of [320, 360, 390, 414]) await measure(label, width, visible);
  await page.setViewportSize({ width: 390, height: 844 });
}

const candidateSearchText = "أبحث عن مطور Front-end في عمان خبرة 3 سنوات";
const jobSearchText = "أريد وظيفة Front-end";
const digitsOnly = (value) => value.replace(/\D/g, "");

async function newConversation() {
  await page.goto("/");
  await page.getByTestId("input-ai-composer").waitFor();
  const button = page
    .locator('[data-testid="button-new-conversation-header"]:visible, [data-testid="button-new-conversation"]:visible')
    .first();
  if (!(await button.isVisible()))
    await page.locator('[data-testid="button-toggle-conversation-history"]:visible').first().click();
  await button.waitFor({ state: "visible" });
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ai/conversations" &&
      response.request().method() === "POST",
  );
  await button.click();
  assert.equal((await created).status(), 201);
  await page.getByRole("heading", { name: "كيف أساعدك اليوم؟", exact: true }).waitFor();
}

async function openSession(cookie) {
  const context = await browser.newContext({
    baseURL: webBase,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ar",
  });
  contexts.push(context);
  const separator = cookie.indexOf("=");
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      domain: new URL(webBase).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    for (const header of ["host", "origin", "referer", "content-length", "sec-fetch-site"])
      delete headers[header];
    headers.origin = apiOrigin;
    headers.referer = `${apiOrigin}/`;
    await route.fulfill({
      response: await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers }),
    });
  });
  const opened = await context.newPage();
  opened.on("pageerror", (error) => pageErrors.push(error.message));
  opened.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  opened.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || allowedHosts.has(url.host)) return;
    if (fontHosts.has(url.hostname)) staticFontRequests += 1;
    else externalRequests.push(`${url.hostname}${url.pathname}`);
  });
  return opened;
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });

  // ── Candidate journey ──
  page = await openSession(candidateCookie);
  await newConversation();
  await sendTurn("أريد وظيفة React عن بعد");
  const results = latestAssistant().getByTestId("employment-job_search_results");
  await results.waitFor();
  assert.ok((await results.locator('[data-testid^="employment-job-"]').count()) >= 1);
  checks.push("candidate job search renders server job cards");
  await mobile("job search results", results);

  await clickTurn(results.getByRole("button", { name: "التفاصيل" }).first());
  const details = latestAssistant().getByTestId("employment-job_details");
  await details.waitFor();
  await details.getByTestId("employment-match-signals").waitFor();
  checks.push("details button opens the exact job with transparent match signals");
  await mobile("job details", details);

  await sendTurn("أريد وظيفة Front-end");
  const frontend = latestAssistant().getByTestId("employment-job_search_results");
  await frontend.waitFor();
  await clickTurn(frontend.getByRole("button", { name: "تقديم" }).first());
  const review = latestAssistant().getByTestId("employment-application_review");
  await review.waitFor();
  const action = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await action.getByTestId("employment-action-confirm").waitFor();
  checks.push("apply button renders APPLICATION_REVIEW without submitting");
  await mobile("application review", latestAssistant());
  await action.getByTestId("employment-action-cancel").click();
  await action.getByTestId("employment-action-status").waitFor();
  assert.equal(await action.getByTestId("employment-action-status").getAttribute("data-status"), "CANCELLED");
  checks.push("cancel button cancels the exact pending application");

  await page.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const reloaded = latestAssistant().getByTestId("employment-action-status");
  await reloaded.waitFor();
  assert.equal(await reloaded.getAttribute("data-status"), "CANCELLED");
  checks.push("reload restores the conversation and the settled action status from the server");

  await sendTurnForSurface("اعرض سيرتي", "employment-cv_profile");
  const profile = latestAssistant().getByTestId("employment-cv_profile");
  await profile.waitFor();
  await profile.getByTestId("employment-cv-visibility").waitFor();
  checks.push("CV profile renders the structured profile with its visibility");
  await mobile("cv profile", profile);

  await sendTurn("اعرض طلبات التوظيف");
  const applications = latestAssistant().getByTestId("employment-my_applications");
  await applications.waitFor();
  assert.ok((await applications.locator('[data-testid^="employment-application-"]').count()) >= 1);
  checks.push("MY_APPLICATIONS renders the candidate's real applications");
  await mobile("my applications", applications);

  // ── Employer journey ──
  page = await openSession(employerCookie);
  await newConversation();
  await sendTurn("اعرض وظائفي");
  const myJobs = latestAssistant().getByTestId("employment-my_jobs");
  await myJobs.waitFor();
  assert.ok((await myJobs.locator('[data-testid^="employment-job-"]').count()) >= 3);
  checks.push("MY_JOBS renders the employer's own jobs with status and applicant counts");
  await mobile("my jobs", myJobs);

  await sendTurn("أريد موظف مصمم واجهات في عمان");
  const draft = latestAssistant().getByTestId("employment-job_draft");
  await draft.waitFor();
  checks.push("job draft renders and asks only the next missing field");
  await mobile("job draft", draft);
  for (const line of [
    "Figma و Photoshop و HTML و CSS و JavaScript و TypeScript و React و Vue و Angular و Flutter",
    "بدون خبرة",
    "دوام جزئي هجين",
    "من 300 إلى 450",
  ])
    await sendTurn(line);
  const jobReview = latestAssistant().getByTestId("employment-job_review");
  await jobReview.waitFor();
  checks.push("JOB_REVIEW shows the exact draft that will be published");
  await mobile("job review with long skills", jobReview);
  const publish = jobReview.getByTestId("employment-action-confirm");
  await publish.click();
  const status = jobReview.getByTestId("employment-action-status");
  await status.waitFor();
  assert.equal(await status.getAttribute("data-status"), "CONFIRMED");
  checks.push("publish button publishes through the scoped action endpoint");

  // ── Isolated candidate/employer privacy and lifecycle journey ──
  const candidateTitle = `C23 Front-end Engineer ${runId}`;
  const jobTitle = `C23 Front-end Engineer ${runId}`;
  const browserCandidatePage = await openSession(browserCandidateCookie);
  page = browserCandidatePage;
  await newConversation();
  await sendTurn("أريد أنشئ ملف وظيفي");
  let browserProfile = latestAssistant().getByTestId("employment-cv_profile");
  await browserProfile.waitFor();
  assert.equal(
    await browserProfile.getByTestId("employment-cv-visibility").getAttribute("data-visibility"),
    "PRIVATE",
  );
  await sendTurn("أنا مطور Front-end عندي خبرة 3 سنوات React");
  await sendTurn("أضف TypeScript");
  await sendTurn("أسكن في عمان");
  await sendTurn(`رقم التواصل ${browserCandidateContact}`);
  await sendTurn(`غير المسمى إلى ${candidateTitle}`);
  browserProfile = latestAssistant().getByTestId("employment-cv_profile");
  await browserProfile.waitFor();
  assert.ok((await browserProfile.innerText()).includes(candidateTitle));
  await mobile("private editable candidate profile", browserProfile);
  checks.push("candidate profile starts private and is editable");

  const browserEmployerPage = await openSession(browserEmployerCookie);
  page = browserEmployerPage;
  await newConversation();
  await sendTurn(candidateSearchText);
  let candidates = latestAssistant().getByTestId("employment-candidate_search_results");
  await candidates.waitFor();
  assert.equal(await candidates.getByText(candidateTitle, { exact: true }).count(), 0);
  await mobile("private candidate discovery results", candidates);
  checks.push("employer discovery excludes private candidate profiles");

  page = browserCandidatePage;
  await sendTurn("اجعل ملفي ظاهر لأصحاب العمل");
  browserProfile = latestAssistant().getByTestId("employment-cv_profile");
  await browserProfile.waitFor();
  assert.equal(
    await browserProfile.getByTestId("employment-cv-visibility").getAttribute("data-visibility"),
    "DISCOVERABLE",
  );
  await mobile("discoverable candidate profile", browserProfile);

  page = browserEmployerPage;
  await sendTurn(candidateSearchText);
  candidates = latestAssistant().getByTestId("employment-candidate_search_results");
  await candidates.waitFor();
  let candidateCard = candidates
    .locator('[data-testid^="employment-candidate-"]')
    .filter({ hasText: candidateTitle });
  assert.equal(await candidateCard.count(), 1, "the discoverable fixture candidate appears exactly once");
  const selectedContact = candidateCard.getByTestId("employment-candidate-contact");
  await selectedContact.waitFor();
  assert.ok(
    digitsOnly(await selectedContact.innerText()).endsWith(digitsOnly(browserCandidateContact)),
    "employers see only the candidate-selected contact number",
  );
  assert.equal(
    (await browserEmployerPage.locator("body").innerText()).includes(browserCandidateLoginPhone),
    false,
    "the candidate's account login phone is never exposed",
  );
  await mobile("discoverable candidate search results", candidates);
  await clickTurn(candidateCard.getByRole("button", { name: "الملف" }));
  const candidateDetails = latestAssistant().getByTestId("employment-candidate_details");
  await candidateDetails.waitFor();
  assert.ok((await candidateDetails.innerText()).includes(candidateTitle));
  await mobile("candidate discovery details", candidateDetails);
  checks.push("employer discovery shows candidate-selected contact, never login phone");

  page = browserCandidatePage;
  await sendTurn("اخف ملفي");
  browserProfile = latestAssistant().getByTestId("employment-cv_profile");
  await browserProfile.waitFor();
  assert.equal(
    await browserProfile.getByTestId("employment-cv-visibility").getAttribute("data-visibility"),
    "PRIVATE",
  );
  await mobile("private candidate profile after hiding", browserProfile);

  page = browserEmployerPage;
  await sendTurn(candidateSearchText);
  candidates = latestAssistant().getByTestId("employment-candidate_search_results");
  await candidates.waitFor();
  assert.equal(await candidates.getByText(candidateTitle, { exact: true }).count(), 0);
  await mobile("hidden candidate search results", candidates);
  checks.push("candidate profile privacy immediately removes discovery access");

  await browserEmployerPage.reload();
  page = browserEmployerPage;
  await page.getByTestId("input-ai-composer").waitFor();
  const restoredCandidateDetails = browserEmployerPage.getByTestId("employment-candidate_details");
  await restoredCandidateDetails.first().waitFor();
  const restoredCandidateSearches = browserEmployerPage.getByTestId("employment-candidate_search_results");
  assert.ok(
    (await restoredCandidateSearches.count()) >= 3,
    "reloaded employer history includes the earlier private, discoverable, and hidden searches",
  );
  for (let index = 0; index < await restoredCandidateSearches.count(); index += 1) {
    const restoredSearchText = await restoredCandidateSearches.nth(index).innerText();
    assert.equal(restoredSearchText.includes(candidateTitle), false, "old search results no longer show the hidden candidate");
    assert.equal(
      digitsOnly(restoredSearchText).includes(digitsOnly(browserCandidateContact)),
      false,
      "old search results no longer show the hidden candidate's selected contact",
    );
    assert.equal(
      digitsOnly(restoredSearchText).includes(digitsOnly(browserCandidateLoginPhone)),
      false,
      "old search results never show the candidate's login phone",
    );
  }
  for (let index = 0; index < await restoredCandidateDetails.count(); index += 1) {
    const restoredDetailsText = await restoredCandidateDetails.nth(index).innerText();
    assert.ok(restoredDetailsText.includes("لم يعد هذا الملف ظاهرًا"), "old candidate details explain that the profile is no longer visible");
    assert.equal(restoredDetailsText.includes(candidateTitle), false, "old candidate details no longer show the hidden profile");
    assert.equal(
      digitsOnly(restoredDetailsText).includes(digitsOnly(browserCandidateContact)),
      false,
      "old candidate details no longer show the hidden candidate's selected contact",
    );
    assert.equal(
      digitsOnly(restoredDetailsText).includes(digitsOnly(browserCandidateLoginPhone)),
      false,
      "old candidate details never show the candidate's login phone",
    );
  }
  checks.push("reloaded employer conversation removes hidden candidate data from old search cards and details");

  // Employer job creation and an explicit title edit use only the isolated employer.
  await sendTurnForSurface(
    "أريد موظف Front-end Engineer في عمان",
    "employment-job_draft",
  );
  const jobDraft = latestAssistant().getByTestId("employment-job_draft");
  await jobDraft.waitFor();
  await mobile("browser fixture job draft", jobDraft);
  for (const line of [
    "React و TypeScript",
    "خبرة 3 سنوات",
    "دوام كامل وهجين",
    "من 700 إلى 900",
  ])
    await sendTurn(line);
  const browserJobReview = latestAssistant().getByTestId("employment-job_review");
  await browserJobReview.waitFor();
  await mobile("browser fixture job review", browserJobReview);
  let browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض وظائفي");
  let browserMyJobs = latestAssistant().getByTestId("employment-my_jobs");
  await browserMyJobs.waitFor();
  assert.equal(await browserMyJobs.locator(':scope > [data-testid^="employment-job-"]').count(), 1);
  await mobile("browser employer jobs before edit", browserMyJobs);

  await sendTurn(`غير المسمى إلى ${jobTitle}`);
  browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await browserAction.waitFor();
  await mobile("job title edit confirmation", latestAssistant());
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض وظائفي");
  browserMyJobs = latestAssistant().getByTestId("employment-my_jobs");
  await browserMyJobs.waitFor();
  let fixtureJob = browserMyJobs
    .locator('[data-testid^="employment-job-"]')
    .filter({ hasText: jobTitle });
  assert.equal(await fixtureJob.count(), 1, "the edited title is persisted");
  await mobile("edited employer job", browserMyJobs);

  // Pause removes the job from candidate results; resume restores it.
  await sendTurn("وقف الوظيفة الأولى");
  browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await browserAction.waitFor();
  await mobile("job pause confirmation", latestAssistant());
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض وظائفي");
  browserMyJobs = latestAssistant().getByTestId("employment-my_jobs");
  fixtureJob = browserMyJobs.locator('[data-testid^="employment-job-"]').filter({ hasText: jobTitle });
  await fixtureJob.waitFor();
  assert.ok((await fixtureJob.getByTestId("employment-job-status").innerText()).includes("موقوفة"));
  await mobile("paused employer job", browserMyJobs);

  page = browserCandidatePage;
  await newConversation();
  await sendTurn(jobSearchText);
  let jobResults = latestAssistant().getByTestId("employment-job_search_results");
  await jobResults.waitFor();
  assert.equal(await jobResults.getByText(jobTitle, { exact: true }).count(), 0);
  await mobile("paused job hidden from candidates", jobResults);

  page = browserEmployerPage;
  await sendTurn("أعد نشر الوظيفة الأولى");
  browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await browserAction.waitFor();
  await mobile("job resume confirmation", latestAssistant());
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض وظائفي");
  browserMyJobs = latestAssistant().getByTestId("employment-my_jobs");
  fixtureJob = browserMyJobs.locator('[data-testid^="employment-job-"]').filter({ hasText: jobTitle });
  await fixtureJob.waitFor();
  assert.ok((await fixtureJob.getByTestId("employment-job-status").innerText()).includes("منشورة"));
  await mobile("resumed employer job", browserMyJobs);

  page = browserCandidatePage;
  await sendTurn(jobSearchText);
  jobResults = latestAssistant().getByTestId("employment-job_search_results");
  await jobResults.waitFor();
  const matchingJob = jobResults
    .locator('[data-testid^="employment-job-"]')
    .filter({ hasText: jobTitle });
  assert.equal(await matchingJob.count(), 1, "the resumed fixture job is discoverable");
  await clickTurn(matchingJob.getByRole("button", { name: "تقديم" }));
  const applicationReview = latestAssistant().getByTestId("employment-application_review");
  await applicationReview.waitFor();
  assert.ok((await applicationReview.innerText()).includes(candidateTitle));
  await mobile("candidate application review", latestAssistant());
  browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض طلبات التوظيف");
  let browserApplications = latestAssistant().getByTestId("employment-my_applications");
  await browserApplications.waitFor();
  let ownApplication = browserApplications
    .locator('[data-testid^="employment-application-"]')
    .filter({ hasText: jobTitle });
  assert.equal(await ownApplication.count(), 1);
  await mobile("submitted candidate application", browserApplications);

  await clickTurn(ownApplication.getByRole("button", { name: "سحب الطلب" }));
  browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await browserAction.waitFor();
  await mobile("candidate withdrawal confirmation", latestAssistant());
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض طلبات التوظيف");
  browserApplications = latestAssistant().getByTestId("employment-my_applications");
  ownApplication = browserApplications
    .locator('[data-testid^="employment-application-"]')
    .filter({ hasText: jobTitle });
  await ownApplication.waitFor();
  assert.ok((await ownApplication.getByTestId("employment-application-status").innerText()).includes("مسحوب"));
  await mobile("withdrawn candidate application", browserApplications);
  checks.push("candidate submits and withdraws an application through the browser");

  // The employer can pause/resume and close only this fixture job; history remains.
  page = browserEmployerPage;
  await sendTurn("اعرض وظائفي");
  browserMyJobs = latestAssistant().getByTestId("employment-my_jobs");
  await browserMyJobs.waitFor();
  await sendTurn("أغلق الوظيفة الأولى");
  browserAction = latestAssistant().locator('[data-testid^="employment-action-"]').first();
  await browserAction.waitFor();
  await mobile("job close confirmation", latestAssistant());
  await confirmBrowserAction(browserAction);
  await sendTurn("اعرض وظائفي");
  browserMyJobs = latestAssistant().getByTestId("employment-my_jobs");
  fixtureJob = browserMyJobs.locator('[data-testid^="employment-job-"]').filter({ hasText: jobTitle });
  await fixtureJob.waitFor();
  assert.ok((await fixtureJob.getByTestId("employment-job-status").innerText()).includes("مغلقة"));
  await mobile("closed employer job", browserMyJobs);
  await clickTurn(fixtureJob.getByRole("button", { name: "المتقدمون" }));
  const applicationList = latestAssistant().getByTestId("employment-application_list");
  await applicationList.waitFor();
  const historicalApplication = applicationList
    .locator('[data-testid^="employment-application-"]')
    .filter({ hasText: candidateTitle });
  await historicalApplication.waitFor();
  await applicationList.getByTestId("employment-match-signals").first().waitFor();
  assert.ok((await historicalApplication.getByTestId("employment-application-status").innerText()).includes("مسحوب"));
  assert.equal(
    digitsOnly(await historicalApplication.innerText()).includes(digitsOnly(browserCandidateContact)),
    false,
    "private profile contact is removed from retained application history",
  );
  assert.equal(
    (await browserEmployerPage.locator("body").innerText()).includes(browserCandidateLoginPhone),
    false,
    "retained application history never exposes the login phone",
  );
  await mobile("private historical application list", applicationList);
  checks.push("APPLICATION_LIST renders employer applicants with job-related signals only");

  await browserEmployerPage.reload();
  page = browserEmployerPage;
  await page.getByTestId("input-ai-composer").waitFor();
  const restoredApplicationList = browserEmployerPage.getByTestId("employment-application_list").last();
  await restoredApplicationList.waitFor();
  const restoredApplication = restoredApplicationList
    .locator('[data-testid^="employment-application-"]')
    .filter({ hasText: candidateTitle });
  await restoredApplication.waitFor();
  assert.ok(
    (await restoredApplication.getByTestId("employment-application-status").innerText()).includes("مسحوب"),
    "employer reload preserves the withdrawn application in the closed job's history",
  );
  assert.equal(
    digitsOnly(await restoredApplication.innerText()).includes(digitsOnly(browserCandidateContact)),
    false,
    "candidate-selected private contact stays hidden from reloaded employer history",
  );
  assert.equal(
    digitsOnly(await browserEmployerPage.locator("body").innerText()).includes(digitsOnly(browserCandidateLoginPhone)),
    false,
    "candidate login phone stays hidden from reloaded employer history",
  );
  await sendTurnForSurface("اعرض وظائفي", "employment-my_jobs");
  browserMyJobs = browserEmployerPage.getByTestId("employment-my_jobs").last();
  await browserMyJobs.waitFor();
  fixtureJob = browserMyJobs.locator('[data-testid^="employment-job-"]').filter({ hasText: jobTitle });
  await fixtureJob.waitFor();
  assert.ok((await fixtureJob.getByTestId("employment-job-status").innerText()).includes("مغلقة"));
  await mobile("reloaded closed-job application history", restoredApplicationList);
  checks.push("employer reload preserves closed-job history and hides private candidate contact");

  page = browserCandidatePage;
  await browserCandidatePage.reload();
  await page.getByTestId("input-ai-composer").waitFor();
  const restoredCandidateApplications = browserCandidatePage
    .getByTestId("employment-my_applications")
    .last();
  await restoredCandidateApplications.waitFor();
  const restoredOwnApplication = restoredCandidateApplications
    .locator('[data-testid^="employment-application-"]')
    .filter({ hasText: jobTitle });
  await restoredOwnApplication.waitFor();
  assert.ok(
    (await restoredOwnApplication.getByTestId("employment-application-status").innerText()).includes(
      "مسحوب",
    ),
    "candidate reload restores the withdrawn application before the next turn",
  );
  await sendTurnForSurface(jobSearchText, "employment-job_search_results");
  jobResults = browserCandidatePage.getByTestId("employment-job_search_results").last();
  await jobResults.waitFor();
  assert.equal(await jobResults.getByText(jobTitle, { exact: true }).count(), 0);
  await mobile("closed job hidden from candidates", jobResults);
  browserApplications = browserCandidatePage.getByTestId("employment-my_applications").last();
  await browserApplications.waitFor();
  ownApplication = browserApplications
    .locator('[data-testid^="employment-application-"]')
    .filter({ hasText: jobTitle });
  await ownApplication.waitFor();
  assert.ok(
    (await ownApplication.getByTestId("employment-application-status").innerText()).includes("مسحوب"),
    "candidate reload preserves the withdrawn application status",
  );
  checks.push("candidate reload keeps the application withdrawn and the closed job out of discovery");
  checks.push("employer edits, pauses, resumes, and closes its own job");
  checks.push("closed jobs leave candidate discovery while application history remains private");
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  for (const context of contexts) {
    try {
      for (const opened of context.pages())
        await opened.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // Reported through the check list; cleanup continues.
    }
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }
  writeFileSync(
    resultPath,
    JSON.stringify(
      { checks, pageErrors, consoleErrors, horizontalOverflow, externalRequests, staticFontRequests, failure },
      null,
      2,
    ),
  );
  await browser?.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
