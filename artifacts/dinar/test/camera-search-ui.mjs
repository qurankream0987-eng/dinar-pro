import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRecorder, openUser } from "./sc-ui-session.mjs";

/**
 * Photo search in the real browser: Chromium's fake camera stands in for the device camera. Open,
 * capture, preview, retake, cancel (tracks stopped every time), denied permission, a photo from
 * the device, sending to DINAR in the one conversation, match badges, and 320 px phones.
 */
const env = process.env;
const { CS_WEB_BASE: webBase, CS_API_ORIGIN: apiOrigin, CS_COOKIE: cookie, CS_RESULT_PATH: resultPath, CS_STORAGE_HOST: storageHost } = env;
if (!webBase || !apiOrigin || !cookie || !resultPath) throw new Error("Missing camera search browser configuration.");

const recorder = createRecorder(webBase, apiOrigin);
if (storageHost) recorder.allowedHosts.add(storageHost);
const checks = [];
let failure;
let browser;
let denied;
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const liveTracks = (page) => page.evaluate(() => (window.__cam?.getTracks() ?? []).filter((track) => track.readyState === "live").length);
const remember = (page) => page.evaluate(() => { window.__cam = document.querySelector('[data-testid="camera-video"]')?.srcObject ?? null; });

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const buyer = await openUser(browser, { webBase, apiOrigin, cookie, label: "camera", recorder });
  const page = buyer.page;
  await buyer.context.grantPermissions(["camera"], { origin: webBase });
  await page.goto("/");
  const cameraButton = page.getByTestId("button-ai-camera");
  await cameraButton.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await cameraButton.getAttribute("aria-label"), "ابحث بصورة");

  // Open → live preview from the camera.
  await cameraButton.click();
  const dialog = page.getByTestId("camera-capture");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.getAttribute("role"), "dialog");
  await page.waitForFunction(() => (document.querySelector('[data-testid="camera-video"]')?.videoWidth ?? 0) > 0, null, { timeout: 20_000 });
  await remember(page);
  assert.equal(await liveTracks(page), 1);
  checks.push("the camera opens inside the conversation after permission, with a live preview");
  await buyer.widths("camera dialog", dialog, [320, 390, 1280]);
  checks.push("the camera dialog fits 320/390/1280 without horizontal overflow");

  // Capture → preview; the camera is released while the buyer reviews.
  await page.getByTestId("camera-shutter").click();
  await page.getByTestId("camera-preview").waitFor({ state: "visible" });
  assert.equal(await liveTracks(page), 0, "capturing stops the camera");
  checks.push("capture shows a preview and stops the camera tracks");

  // Retake → camera live again; cancel → dialog gone, tracks stopped.
  await page.getByTestId("camera-retake").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="camera-video"]')?.videoWidth ?? 0) > 0, null, { timeout: 20_000 });
  await remember(page);
  assert.equal(await liveTracks(page), 1);
  await page.getByTestId("camera-cancel").click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await liveTracks(page), 0, "cancel stops the camera");
  checks.push("retake restarts the camera; cancel closes the dialog and stops every track");

  // Escape also closes and releases the camera.
  await cameraButton.click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="camera-video"]')?.videoWidth ?? 0) > 0, null, { timeout: 20_000 });
  await remember(page);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await liveTracks(page), 0);
  checks.push("Escape closes the camera and stops its tracks");

  // Capture and send with no text: the default request goes to DINAR with the private photo.
  await cameraButton.click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="camera-video"]')?.videoWidth ?? 0) > 0, null, { timeout: 20_000 });
  await page.getByTestId("camera-shutter").click();
  await page.getByTestId("camera-confirm").click();
  await dialog.waitFor({ state: "detached" });
  await page.getByAltText("صورة المنتج الذي تبحث عنه").waitFor({ state: "visible" });
  const uploads = [];
  page.on("request", (request) => { if (request.url().includes("/upload-url")) uploads.push(new URL(request.url()).pathname); });
  await page.getByRole("button", { name: "إرسال الرسالة" }).click();
  const badge = page.locator('[data-testid^="label-visual-match-"]').first();
  await badge.waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await badge.getAttribute("data-match"), "EXACT");
  assert.ok(uploads.every((path) => path.endsWith("/account/visual-search/upload-url")) && uploads.length === 1, JSON.stringify(uploads));
  const reply = await buyer.latest().innerText();
  assert.match(reply, /من الصورة فهمت/);
  checks.push("a captured photo is uploaded privately, searched by DINAR, and real cards carry match badges");
  await buyer.widths("photo search results", buyer.latest(), [320, 390, 1280]);
  checks.push("photo search results fit 320/390/1280");

  // A photo from the device with the buyer's own words.
  await cameraButton.click();
  // Chosen immediately, before the camera finished opening: the late camera must not take over.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("camera-choose").click()]);
  await chooser.setFiles({ name: "product.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await page.getByTestId("camera-preview").waitFor({ state: "visible", timeout: 10_000 }).catch(async () => {
    throw new Error(`device photo not previewed: state=${await page.getByTestId("camera-capture").getAttribute("data-state")} dialog=${await page.getByTestId("camera-capture").count()} message=${await page.getByTestId("camera-message").innerText().catch(() => "?")} html=${(await page.getByTestId("camera-capture").innerHTML().catch(() => "")).replace(/<svg.*?<\/svg>/g, "").slice(0, 3000)}`);
  });
  await page.waitForTimeout(1500);
  assert.equal(await page.getByTestId("camera-preview").isVisible(), true, "the chosen photo stays in preview");
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="camera-video"]')?.srcObject ?? null), null, "no camera stream behind the preview");
  await page.getByTestId("camera-confirm").click();
  await page.getByRole("textbox", { name: "رسالتك إلى DINAR AI" }).fill("دينار أريد هذا المنتج");
  const before = await page.locator('[data-testid^="message-assistant-"]').count();
  await page.getByRole("button", { name: "إرسال الرسالة" }).click();
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count, before, { timeout: 60_000 });
  await page.locator('[data-testid^="label-visual-match-"]').nth(1).waitFor({ state: "visible", timeout: 60_000 });
  checks.push("a photo chosen from the device is sent with the buyer's message");

  // The conversation continues after photo results, in text, with the badges still in place.
  await page.reload();
  await page.locator('[data-testid^="label-visual-match-"]').first().waitFor({ state: "visible", timeout: 45_000 });
  checks.push("match badges are still on the cards after reloading the conversation");
  const beforeFollowUp = await page.locator('[data-testid^="message-assistant-"]').count();
  await page.getByRole("textbox", { name: "رسالتك إلى DINAR AI" }).fill("رتبها من الأرخص");
  await page.getByRole("button", { name: "إرسال الرسالة" }).click();
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > count, beforeFollowUp, { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid^="message-assistant-"]:last-of-type [aria-busy="true"]'), null, { timeout: 60_000 });
  assert.doesNotMatch(await buyer.latest().innerText(), /من الصورة فهمت/);
  checks.push("the buyer continues the conversation in text after photo results");

  // An unsupported file is refused before any upload.
  await cameraButton.click();
  const [gif] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("camera-choose").click()]);
  await gif.setFiles({ name: "x.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  assert.match(await page.getByTestId("camera-message").innerText(), /JPEG أو PNG أو WebP/);
  await page.getByTestId("camera-cancel").click();
  checks.push("an unsupported file is refused in the dialog");
  await buyer.context.close();

  // Denied permission: an honest message, no live preview, the device photo path stays open.
  denied = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH ?? env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const refused = await openUser(denied, { webBase, apiOrigin, cookie, label: "camera-denied", recorder });
  await refused.context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await refused.page.goto("/");
  await refused.page.getByTestId("button-ai-camera").click();
  await refused.page.getByText("لم يُسمح باستخدام الكاميرا").waitFor({ timeout: 20_000 });
  assert.equal(await refused.page.getByTestId("camera-shutter").isDisabled(), true);
  assert.equal(await refused.page.getByTestId("camera-choose").isEnabled(), true);
  await refused.widths("camera denied", refused.page.getByTestId("camera-capture"), [320, 390]);
  checks.push("denied camera permission explains itself and leaves the device photo option, at 320/390");

  // No camera on the device.
  const rp = refused.page;
  await rp.getByTestId("camera-cancel").click();
  await rp.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("none", "NotFoundError")); });
  await rp.getByTestId("button-ai-camera").click();
  await rp.getByText("تعذر فتح الكاميرا. اختر صورة من جهازك بدلًا من ذلك.").waitFor({ timeout: 20_000 });
  assert.equal(await rp.getByTestId("camera-shutter").isDisabled(), true);
  await rp.getByTestId("camera-cancel").click();
  checks.push("a device without a camera gets an honest message and the device photo option");

  // A slow camera closed while it is still starting is stopped the moment it arrives.
  await rp.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => setTimeout(() => {
      const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
      canvas.getContext("2d").fillRect(0, 0, 64, 64);
      window.__late = canvas.captureStream(5);
      resolve(window.__late);
    }, 1200));
  });
  await rp.getByTestId("button-ai-camera").click();
  assert.equal(await rp.getByTestId("camera-capture").getAttribute("data-state"), "starting");
  await rp.getByTestId("camera-cancel").click();
  await rp.waitForTimeout(2000);
  assert.equal(await rp.evaluate(() => window.__late.getTracks().every((track) => track.readyState === "ended")), true, "the late stream was stopped");
  assert.equal(await rp.getByTestId("camera-capture").count(), 0);
  checks.push("closing the camera during initialisation stops the late stream and leaves no dialog");

  // Keyboard and accessible names; no motion is imposed.
  await rp.emulateMedia({ reducedMotion: "reduce" });
  await rp.getByTestId("button-ai-camera").focus();
  await rp.keyboard.press("Enter");
  const kbDialog = rp.getByTestId("camera-capture");
  await kbDialog.waitFor({ state: "visible" });
  assert.equal(await kbDialog.getAttribute("aria-modal"), "true");
  assert.equal(await kbDialog.getAttribute("aria-label"), "البحث بصورة");
  for (const id of ["camera-cancel", "camera-choose", "camera-shutter"]) {
    const name = (await rp.getByTestId(id).getAttribute("aria-label")) ?? (await rp.getByTestId(id).innerText());
    assert.ok(name.trim().length > 0, `${id} has an accessible name`);
  }
  const motion = await kbDialog.evaluate((node) => [node, ...node.querySelectorAll("*")].map((el) => getComputedStyle(el)).filter((style) => style.animationName !== "none" || (parseFloat(style.transitionDuration) || 0) > 0.3).length);
  assert.equal(motion, 0, "no long animation or transition in the camera dialog");
  await rp.keyboard.press("Escape");
  await kbDialog.waitFor({ state: "detached" });
  checks.push("the camera opens and closes by keyboard, controls are named, and no motion is imposed (reduced motion)");
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  writeFileSync(resultPath, JSON.stringify({
    checks: [...checks, ...recorder.checks],
    failure,
    pageErrors: recorder.pageErrors,
    consoleErrors: recorder.consoleErrors,
    externalRequests: recorder.externalRequests,
    horizontalOverflow: recorder.horizontalOverflow,
  }, null, 2));
  await browser?.close().catch(() => undefined);
  await denied?.close().catch(() => undefined);
}
