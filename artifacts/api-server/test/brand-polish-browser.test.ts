/**
 * Brand polish acceptance in a real browser (built web app served by the API, disposable
 * loopback database, scripted model gateway — no provider call):
 *  - message editing: the pencil on an own message creates an edited branch, the original
 *    conversation stays byte-for-byte, the edit survives a reload, and it works at phone width;
 *  - the smaller sign-in/registration card: bounded width, no horizontal overflow, screenshots;
 *  - the brand assets are served and the favicon/touch icon are the declared PNGs.
 * Screenshots go to DINAR_BRAND_SHOTS_DIR when set.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const here = path.dirname(fileURLToPath(import.meta.url.replace("/.test-build/", "/test/")));
const dist = path.resolve(here, "../../dinar/dist/public");
assert.ok(existsSync(path.join(dist, "index.html")), "build the web app first (pnpm --filter @workspace/dinar run build)");
process.env.DINAR_WEB_DIST = dist;
const { default: app } = await import("../src/app");
const { pool, db, messages } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let modelCalls = 0;
app.locals.conversationModelGateway = {
  async proposeToolCall(input: { role: string; content: unknown }[]) {
    modelCalls++;
    const last = String(input.filter((message) => message.role === "user").at(-1)?.content ?? "");
    const topic = /برتقال/u.test(last.split("USER:").at(-1) ?? last) ? "البرتقال" : /تفاح/u.test(last.split("USER:").at(-1) ?? last) ? "التفاح" : "سؤالك";
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: `جواب عن ${topic}.` }), usage: { inputTokens: 100, outputTokens: 20 } };
  },
};
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { server.close(); await pool.end(); });
const shots = process.env.DINAR_BRAND_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });

async function request(pathname: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
const phoneBase = 51_770_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function register(label: string) {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Bp-${randomUUID().slice(0, 12)}!`;
  const created = await request("/auth/register", "POST", { displayName: `Brand ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  assert.equal(created.status, 201, created.text);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, created.cookie)).status, 200);
  return { id: created.data.user.id as string, cookie: created.cookie };
}

const { chromium } = await import(pathToFileURL(path.resolve(here, "../../dinar/node_modules/@playwright/test/index.mjs")).href);
const chromiumPath = process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
after(async () => { await browser.close(); });
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function signedInPage(cookie: string, width: number, height: number, mobile = false) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: "ar" });
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
  return { context, page };
}

async function editJourney(width: number, height: number, mobile: boolean, label: string) {
  const user = await register(label);
  const { context, page } = await signedInPage(user.cookie, width, height, mobile);
  try {
    await page.goto(`${origin}/ai`, { waitUntil: "networkidle" });
    const composer = page.locator("[data-testid=input-ai-composer]");
    await composer.waitFor({ timeout: 20_000 });
    await composer.fill("حدثني عن التفاح");
    await page.locator("[data-testid=button-send-ai-message]").click();
    await page.getByText("جواب عن التفاح.").first().waitFor({ timeout: 20_000 });

    const list = await request("/ai/conversations", "GET", undefined, user.cookie);
    const original = (list.data.conversations ?? list.data)[0];
    const before = await request(`/ai/conversations/${original.id}`, "GET", undefined, user.cookie);
    const userMessage = before.data.messages.find((message: any) => message.actor === "USER");
    const edit = page.locator(`[data-testid=button-edit-message-${userMessage.id}]`);
    await edit.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(await edit.isVisible(), `${label}: the edit pencil is visible without hover`);
    const box = await edit.boundingBox();
    assert.ok(box && box.width >= 32 && box.height >= 32, `${label}: the pencil is a usable touch target`);
    await edit.click();
    await page.locator(`[data-testid=message-edit-note-${userMessage.id}]`).waitFor({ timeout: 5_000 });
    const field = page.locator(`[data-testid=message-user-${userMessage.id}] textarea`);
    await field.fill("حدثني عن البرتقال");
    const save = page.locator(`[data-testid=button-save-message-edit-${userMessage.id}]`);
    // Double activation must not create two branches.
    await save.dblclick();
    await page.getByText("جواب عن البرتقال.").first().waitFor({ timeout: 20_000 });
    assert.ok(await noOverflow(page), `${label}: no horizontal overflow after the edit`);
    if (shots) await page.screenshot({ path: path.join(shots, `edit-${label}.png`) });

    const after = await request("/ai/conversations", "GET", undefined, user.cookie);
    const all = after.data.conversations ?? after.data;
    assert.equal(all.length, 2, `${label}: exactly one edited branch beside the original`);
    const unchanged = await request(`/ai/conversations/${original.id}`, "GET", undefined, user.cookie);
    assert.deepEqual(
      unchanged.data.messages.map((message: any) => [message.id, message.body]),
      before.data.messages.map((message: any) => [message.id, message.body]),
      `${label}: the original conversation is untouched`,
    );
    const branch = all.find((conversation: any) => conversation.id !== original.id);
    const branchDetail = await request(`/ai/conversations/${branch.id}`, "GET", undefined, user.cookie);
    assert.deepEqual(branchDetail.data.messages.map((message: any) => message.body), ["حدثني عن البرتقال", "جواب عن البرتقال."]);
    const [editedRow] = await db.select().from(messages).where(eq(messages.id, branchDetail.data.messages[0].id));
    assert.equal(editedRow?.metadata.turnStatus, "completed");

    // After a reload the edited branch is what the user sees.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("جواب عن البرتقال.").first().waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText("جواب عن التفاح.").count(), 0, `${label}: the replaced answer is not in the active view`);
  } finally {
    await context.close();
  }
}

test("E1 desktop: edit a sent message, original preserved, survives reload", async () => {
  await editJourney(1440, 900, false, "desktop");
});

test("E2 phone (390px, touch): the same edit works and the pencil is visible without hover", async () => {
  await editJourney(390, 844, true, "mobile");
});

test("E3 another user never sees the owner's conversations or edited branch", async () => {
  const owner = await register("owner");
  const stranger = await register("stranger");
  const conversation = (await request("/ai/conversations", "POST", {}, owner.cookie)).data.id as string;
  const branch = await request(`/ai/conversations/${conversation}/copies`, "POST", {}, owner.cookie);
  assert.equal(branch.status, 201);
  const strangerList = await request("/ai/conversations", "GET", undefined, stranger.cookie);
  const ids = (strangerList.data.conversations ?? strangerList.data).map((row: any) => row.id);
  assert.ok(!ids.includes(conversation) && !ids.includes(branch.data.conversation.id));
  assert.equal((await request(`/ai/conversations/${branch.data.conversation.id}`, "GET", undefined, stranger.cookie)).status, 404);
});

test("R1 sign-in and registration card: bounded and without overflow at 1440/390/320", async () => {
  for (const [width, height] of [[1440, 900], [390, 844], [320, 640]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, locale: "ar" });
    const page = await context.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/u, (route: any) => route.fulfill({ status: 200, body: "" }));
    for (const route of ["/register", "/login"]) {
      await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
      await page.locator("form").first().waitFor({ timeout: 15_000 });
      assert.ok(await noOverflow(page), `${route} ${width}: no horizontal overflow`);
      const formWidth = await page.locator("form").first().evaluate((node: Element) => node.getBoundingClientRect().width);
      assert.ok(formWidth <= 380 + 1, `${route} ${width}: form column ≤ 380px (was ${formWidth})`);
      if (shots) await page.screenshot({ path: path.join(shots, `auth${route.replace("/", "-")}-${width}.png`), fullPage: true });
    }
    await context.close();
  }
});

test("B1 brand assets: favicon and touch icon are the declared PNGs", async () => {
  const shell = await (await fetch(`${origin}/login`)).text();
  assert.match(shell, /rel="icon" type="image\/png" href="\/brand\/jassimai-favicon\.png"/u);
  assert.match(shell, /rel="apple-touch-icon" href="\/brand\/jassimai-touch\.png"/u);
  for (const asset of ["jassimai-favicon.png", "jassimai-touch.png", "jassimai-mark.png", "jassimai-lockup.png"]) {
    const response = await fetch(`${origin}/brand/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get("content-type"), "image/png", asset);
  }
});
