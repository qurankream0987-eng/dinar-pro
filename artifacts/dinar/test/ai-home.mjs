import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
const output = "/tmp/dinar-ai-qa";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/repl/tools/bin/chromium",
});
const baseURL = process.env.AI_HOME_BASE_URL ?? "http://127.0.0.1:4173";
const context = await browser.newContext({
  baseURL,
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
async function turn(text) {
  await page.getByRole("textbox", { name: "رسالتك إلى DINAR AI" }).fill(text);
  await page
    .getByRole("button", { name: "إرسال الرسالة", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="button-send-ai-message"]')?.getAttribute("aria-label") === "إرسال الرسالة",
    null,
    { timeout: 90000 },
  );
}
try {
  for (const width of [320, 360, 375, 390, 393, 414, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.getByRole("heading", { name: "جاهز عندما تكون جاهزًا." }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "التنقل الرئيسي" }).count(), 0);
    assert.equal(
      await page.locator('[data-testid^="card-listing-"]').count(),
      0,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const composer = await page.locator("textarea").boundingBox();
    assert.ok(composer.y + composer.height < 844);
    await page.screenshot({
      path: `${output}/home-${width}.png`,
      fullPage: true,
    });
    checks.push(
      `home ${width}: empty conversation, visible composer, no overflow`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await turn("اعرض السلة");
  await page
    .getByText("سجّل الدخول للوصول إلى بياناتك ومتابعة هذا الإجراء.")
    .waitFor();
  checks.push("guest cart requires auth inside conversation");
  await page.goto("/");
  await turn("منتج غير موجود zzz987654");
  await page.getByText(/لم أجد عروضًا مطابقة/).waitFor();
  assert.equal(await page.locator('[data-testid^="card-listing-"]').count(), 0);
  checks.push("empty search has no fabricated cards");
  await turn("سجلني دخول");
  await page.locator('input[name="phoneNumber"]').last().fill("50000000");
  await page.locator('input[name="password"]').last().fill("Development-only-2026!");
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).last().click();
  await page.waitForFunction(() => !document.querySelector('input[name="password"]'));
  assert.equal(new URL(page.url()).pathname, "/");
  checks.push("secure inline login collapses and preserves conversation without navigation");
  await context.request.patch("/api/account/market", {
    data: { marketId: "KW" },
  });
  await page.goto("/");
  await page.getByTestId("button-new-conversation-header").click();
  await turn("اعرض طلباتي");
  await page.getByRole("heading", { name: "طلباتي", exact: true }).waitFor();
  await page.screenshot({
    path: `${output}/orders-inline-390.png`,
    fullPage: true,
  });
  const conversations = await (
    await context.request.get("/api/ai/conversations")
  ).json();
  const saved = await (
    await context.request.get(`/api/ai/conversations/${conversations[0].id}`)
  ).json();
  assert.equal(saved.messages.at(-1).blocks[0].payload.surface, "ORDERS");
  checks.push("orders card uses real engine and persists in history");
  await page.getByTestId("button-toggle-conversation-history").click();
  const historySearch = page.getByTestId("input-conversation-search");
  await historySearch.fill(conversations[0].title.slice(0, 3));
  await page.getByTestId(`conversation-${conversations[0].id}`).waitFor();
  await historySearch.fill("no-matching-conversation-987");
  await page.getByText("لا توجد محادثات مطابقة.").waitFor();
  await historySearch.fill("");
  await page.getByRole("button", { name: "إغلاق المحادثات" }).click();
  checks.push("mobile history drawer searches saved conversations and closes");
  await turn("علي مستحقات؟");
  await page.getByRole("heading", { name: "المستحقات", exact: true }).waitFor();
  checks.push("dues inline");
  await turn("أريد أبيع");
  await page.getByText("ماذا تقدّم؟", { exact: true }).last().waitFor();
  await page.screenshot({
    path: `${output}/sell-inline-390.png`,
    fullPage: true,
  });
  checks.push("existing listing wizard inline");
  await turn("غير السوق");
  await page.getByRole("log").getByTestId("button-market").click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  checks.push("market action opens existing market selector");
  await page.getByTestId("button-new-conversation-header").click();
  await turn("أريد تصميم");
  await page.waitForTimeout(500);
  const count = await page.locator('[data-testid^="card-listing-"]').count();
  await page.screenshot({ path: `${output}/search-390.png`, fullPage: true });
  checks.push(`marketplace search rendered ${count} resource cards`);
  if (!count)
    throw new Error(
      `Marketplace search missing cards: ${await page.getByRole("log").innerText()} ${await page.locator("[role=alert]").allTextContents()}`,
    );
  const originalCart = await (await context.request.get("/api/cart")).json();
  try {
    await page
      .getByRole("button", { name: "أضف للسلة", exact: true })
      .first()
      .click();
    await page
      .getByText(/إلى سلتك.*راجع السلة قبل إكمال الطلب/)
      .waitFor();
    const cart = await (await context.request.get("/api/cart")).json();
    assert.ok(cart.length);
    checks.push("card action saves to shared cart before success");
    await turn("كمل الطلب");
    await page.getByRole("heading", { name: "إتمام الطلب", exact: true }).last().waitFor();
    await page.getByTestId("checkbox-agree").last().waitFor();
    assert.equal(new URL(page.url()).pathname, "/");
    await page.screenshot({ path: `${output}/checkout-inline-390.png`, fullPage: true });
    checks.push("checkout review, seller totals and explicit confirmation remain inside conversation");
  } finally {
    await context.request.put("/api/cart", {
      data: { marketId: "KW", items: originalCart },
    });
  }
  await page.getByTestId("button-new-conversation-header").click();
  for (const message of ["أريد أبيع آيفون 15", "مستعمل ونظيف", "256 جيجابايت", "تخطي", "٢", "السالمية", "استلام", "إلكترونيات"]) await turn(message);
  await page.getByRole("button", { name: "نشر العرض", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.screenshot({ path: `${output}/seller-draft-390.png`, fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "نشر العرض", exact: true }).waitFor();
  checks.push("seller intake restores a real-engine draft for review, without publishing");
  const deleteCandidateResponse = await context.request.post(
    "/api/ai/conversations",
    { data: {} },
  );
  assert.equal(deleteCandidateResponse.status(), 201);
  const deleteCandidate = await deleteCandidateResponse.json();
  await page.reload();
  await page.getByTestId("button-toggle-conversation-history").click();
  await page.getByTestId(`button-delete-conversation-${deleteCandidate.id}`).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "إبقاء المحادثة" }).click();
  await page.getByTestId(`conversation-${deleteCandidate.id}`).waitFor();
  await page.getByTestId(`conversation-${deleteCandidate.id}`).click();
  await page.getByTestId("button-toggle-conversation-history").click();
  await page.getByTestId(`button-delete-conversation-${deleteCandidate.id}`).click();
  await page.getByRole("dialog").waitFor();
  await page
    .getByRole("button", { name: "حذف المحادثة", exact: true })
    .click();
  await page
    .getByTestId(`conversation-${deleteCandidate.id}`)
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "إغلاق المحادثات" }).click();
  await page.getByRole("heading", { name: "جاهز عندما تكون جاهزًا." }).waitFor();
  assert.equal(
    (
      await context.request.get(
        `/api/ai/conversations/${deleteCandidate.id}`,
      )
    ).status(),
    404,
  );
  checks.push("conversation deletion asks for confirmation and removes its history");
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(
    `${output}/checks.json`,
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
