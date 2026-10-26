import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import app from "../src/app";
import { aiUiBlocks, db, messages, offers, orders, paymentIntents, pool, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G3_ACCEPTANCE");
const execFileAsync = promisify(execFile);
const originalFetch = globalThis.fetch;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const apiPort = (server.address() as any).port as number;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
let authIpSequence = 1;
const syntheticKuwaitPhone = (offset: number) =>
  String(50_000_000 + ((process.pid + offset) % 1_000_000));
const request = async (path: string, method = "GET", body?: unknown, cookie = "", extraHeaders: Record<string, string> = {}) => {
  const response = await originalFetch(`${apiOrigin}/api${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(path.startsWith("/auth/") ? { "x-forwarded-for": `198.93.78.${authIpSequence++}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
};

async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = (probe.address() as any).port as number;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

await test("authenticated contact browser microclosure", async () => {
  const phoneNumber = process.env.BDINAR_CONTACT_TEST_PHONE || syntheticKuwaitPhone(0);
  assert.match(phoneNumber ?? "", /^5\d{7}$/, "use only a synthetic Kuwait mobile number");
  const challenge = await request("/auth/phone-verification/challenges", "POST", {
    phoneCountryCode: "+965",
    phoneNumber,
  });
  assert.equal(challenge.status, 202, challenge.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: challenge.data.challengeId,
    code: challenge.data.developmentCode,
  });
  assert.equal(verified.status, 200, verified.raw);
  const password = `Contact-${process.pid}-test!`;
  const registered = await request("/auth/register", "POST", {
    displayName: "DINAR contact browser test",
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  const actorId = registered.data.user.id as string;
  const cookie = registered.cookie;
  assert.ok(cookie, "authenticated browser session cookie");
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, cookie)).status, 200);

  const webPort = await availablePort();
  const webBase = `http://127.0.0.1:${webPort}`;
  const web = spawn("pnpm", ["--filter", "@workspace/dinar", "run", "serve"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(webPort), BASE_PATH: "/", NODE_ENV: "production" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let webOutput = "";
  web.stdout?.on("data", (chunk) => { webOutput += chunk.toString(); });
  web.stderr?.on("data", (chunk) => { webOutput += chunk.toString(); });
  const resultPath = `/tmp/dinar-contact-browser-${process.pid}.json`;
  const beforeCalls = getModelGatewayCallCount();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await originalFetch(webBase);
        ready = response.ok && (await response.text()).includes('<div id="root"');
      } catch {}
      if (ready) break;
      if (web.exitCode !== null) throw new Error(`Vite preview exited: ${webOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, `Vite preview did not start: ${webOutput}`);
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/contact-browser-microclosure.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        CONTACT_WEB_BASE: webBase,
        CONTACT_API_ORIGIN: apiOrigin,
        CONTACT_COOKIE: cookie,
        CONTACT_ACCOUNT_PHONE: phoneNumber,
        CONTACT_RESULT_PATH: resultPath,
      },
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const report = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(report.failure, undefined, report.failure);
    assert.deepEqual(report.consoleErrors, []);
    assert.equal(report.accountPhoneInConsole, false);
    assert.equal(report.accountPhonePublishedDescription, false);
    assert.equal(report.accountPhoneCopiedToDraftText, false);
    assert.equal(report.approvalSurvivedReload, true);
    assert.equal(report.draftSurvivedReload, true);
    assert.equal(report.alternatePublishedCorrectly, true);
    assert.equal(report.autoPublished, false);
    assert.equal(report.conversationOnly, true);
    assert.equal(report.categoryCollision, true);
    assert.equal(report.paymentPreference, true);
    assert.equal(report.helperSecondary, true);
    assert.equal(report.openToOffers, true);
    assert.deepEqual(report.providerRequests, []);

    const [authUser] = await db.select({ normalizedPhone: users.normalizedPhone }).from(users).where(eq(users.id, actorId));
    assert.equal(authUser!.normalizedPhone, `+965${phoneNumber}`);
    const accountDrafts = report.accountDraftIds as string[];
    assert.equal(new Set(accountDrafts).size, 1, "reload retained one canonical draft");
    const ownListings = await request("/listings?own=true", "GET", undefined, cookie);
    assert.equal(ownListings.status, 200, ownListings.raw);
    assert.equal(ownListings.data.length, 1, "only the explicitly published alternate-phone listing exists");
    assert.equal(ownListings.data[0].contactPhone, report.alternateNumber);
    assert.deepEqual(ownListings.data[0].paymentMethods, ["CASH_DIRECT"]);
    assert.notEqual(ownListings.data[0].contactPhone, authUser!.normalizedPhone);
    const publicListing = await request(`/listings/${ownListings.data[0].id}`, "GET", undefined, "", { cookie: "bdinar_guest_market=JO" });
    assert.equal(publicListing.status, 200, publicListing.raw);
    assert.equal(publicListing.data.contactPhone, null, "seller-approved contact remains private in public listing details");
    assert.ok(!publicListing.raw.includes(authUser!.normalizedPhone), "authentication phone is absent from the public detail response");
    const sellerOffers = await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, actorId));
    assert.equal(sellerOffers.length, 1);

    const otherPhone = process.env.BDINAR_CONTACT_OTHER_PHONE || syntheticKuwaitPhone(1);
    assert.match(otherPhone ?? "", /^5\d{7}$/);
    const otherChallenge = await request("/auth/phone-verification/challenges", "POST", {
      phoneCountryCode: "+965", phoneNumber: otherPhone,
    });
    assert.equal(otherChallenge.status, 202, otherChallenge.raw);
    const otherVerified = await request("/auth/phone-verification/challenges/verify", "POST", {
      challengeId: otherChallenge.data.challengeId, code: otherChallenge.data.developmentCode,
    });
    assert.equal(otherVerified.status, 200, otherVerified.raw);
    const otherRegistered = await request("/auth/register", "POST", {
      displayName: "DINAR contact boundary test",
      accountCountry: "KW",
      phoneCountryCode: "+965",
      phoneNumber: otherPhone,
      password: `Contact-other-${process.pid}!`,
      confirmPassword: `Contact-other-${process.pid}!`,
      acceptTerms: true,
      verificationToken: otherVerified.data.verificationToken,
    });
    assert.equal(otherRegistered.status, 201, otherRegistered.raw);
    assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, otherRegistered.cookie)).status, 200);
    const createdOrder = await request("/orders", "POST", {
      listingId: ownListings.data[0].id, quantity: 1, fulfilmentType: "PICKUP",
      idempotencyKey: `contact-release-${process.pid}`,
    }, otherRegistered.cookie);
    assert.equal(createdOrder.status, 201, createdOrder.raw);
    const orderId = createdOrder.data.id as string;
    const beforeCash = await request(`/orders/${orderId}/contact`, "GET", undefined, otherRegistered.cookie);
    assert.equal(beforeCash.status, 404, "order creation alone does not authorize contact");
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, orderId));
    await db.update(orders).set({ data: { ...orderRow!.data, selectedPaymentMethod: "CARD" } }).where(eq(orders.id, orderId));
    await db.insert(paymentIntents).values({
      id: `contact-intent-${process.pid}`,
      orderId,
      buyerId: otherRegistered.data.user.id,
      providerKey: "test-adapter",
      providerIntentId: `contact-provider-${process.pid}`,
      idempotencyKey: `contact-idempotency-${process.pid}`,
      amountMinor: createdOrder.data.subtotalMinor,
      currencyCode: createdOrder.data.currency,
      status: "SIMULATION_PENDING",
      mode: "SIMULATION_ONLY",
    });
    const cardIntent = await request(`/orders/${orderId}/contact`, "GET", undefined, otherRegistered.cookie);
    assert.equal(cardIntent.status, 404, "a simulated card intent is not payment proof");
    const forgedClaims = await request(
      `/orders/${orderId}/contact?status=CREATED&selectedPaymentMethod=CASH_DIRECT&buyerId=${otherRegistered.data.user.id}`,
      "GET",
      undefined,
      otherRegistered.cookie,
    );
    assert.equal(forgedClaims.status, 404, "client-supplied status, payment, or owner claims cannot authorize release");
    assert.equal((await request("/account/market", "PATCH", { marketId: "KW" }, otherRegistered.cookie)).status, 200);
    assert.equal((await request(`/orders/${orderId}/contact`, "GET", undefined, otherRegistered.cookie)).status, 404, "a different active market blocks release");
    assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, otherRegistered.cookie)).status, 200);
    await db.update(orders).set({ data: { ...orderRow!.data, selectedPaymentMethod: "CASH_DIRECT" } }).where(eq(orders.id, orderId));
    const cashContact = await request(`/orders/${orderId}/contact`, "GET", undefined, otherRegistered.cookie);
    assert.equal(cashContact.status, 200, cashContact.raw);
    assert.equal(cashContact.data.contacts?.[0]?.phone, report.alternateNumber, "eligible confirmed cash order releases only the seller-approved number");
    const buyerConversation = await request("/ai/conversations", "POST", {}, otherRegistered.cookie);
    assert.equal(buyerConversation.status, 201, buyerConversation.raw);
    const buyerConversationId = buyerConversation.data.id as string;
    const messageId = `contact-release-${process.pid}-${orderId}`;
    await db.insert(messages).values({
      id: messageId,
      conversationId: buyerConversationId,
      actor: "ASSISTANT",
      body: "تم التحقق من صلاحية التواصل لهذا الطلب. بيانات التواصل أدناه.",
    });
    await db.insert(aiUiBlocks).values({
      id: `${messageId}-block`,
      conversationId: buyerConversationId,
      messageId,
      blockType: "SURFACE",
      version: 1,
      ordinal: 0,
      payload: {
        resultSetId: `${messageId}-results`,
        listings: [],
        surface: "ORDER",
        resourceIds: [orderId],
        resourceId: orderId,
        sellerContactRequested: true,
      },
    });
    const buyerBrowserResult = `${resultPath}.buyer`;
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/contact-release-buyer-browser.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        CONTACT_WEB_BASE: webBase,
        CONTACT_API_ORIGIN: apiOrigin,
        CONTACT_BUYER_COOKIE: otherRegistered.cookie,
        CONTACT_BUYER_USER_ID: otherRegistered.data.user.id,
        CONTACT_CONVERSATION_ID: buyerConversationId,
        CONTACT_EXPECTED_NUMBER: report.alternateNumber,
        CONTACT_RESULT_PATH: buyerBrowserResult,
      },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const buyerBrowser = JSON.parse(await readFile(buyerBrowserResult, "utf8"));
    assert.equal(buyerBrowser.contactRendered, true);
    assert.equal(buyerBrowser.consoleErrors.length, 0, buyerBrowser.consoleErrors.join("\n"));
    assert.equal(buyerBrowser.providerRequests.length, 0);
    const [consentedOffer] = await db.select().from(offers).where(eq(offers.id, ownListings.data[0].id));
    await db.update(offers).set({ data: { ...consentedOffer!.data, contactPhone: null } }).where(eq(offers.id, ownListings.data[0].id));
    assert.equal((await request(`/orders/${orderId}/contact`, "GET", undefined, otherRegistered.cookie)).status, 404, "revoked seller consent blocks later reads");
    await db.update(offers).set({ data: consentedOffer!.data }).where(eq(offers.id, ownListings.data[0].id));
    const sellerCannotReadContact = await request(`/orders/${orderId}/contact`, "GET", undefined, cookie);
    assert.equal(sellerCannotReadContact.status, 404);
    const guessedContact = await request("/orders/unknown-order/contact", "GET", undefined, otherRegistered.cookie);
    assert.equal(guessedContact.status, 404);
    const cancelled = await request(`/orders/${orderId}/cancel`, "POST", { reason: "test cancellation" }, otherRegistered.cookie);
    assert.equal(cancelled.status, 200, cancelled.raw);
    const revoked = await request(`/orders/${orderId}/contact`, "GET", undefined, otherRegistered.cookie);
    assert.equal(revoked.status, 404, "canceled order blocks future contact retrieval");
    const deniedHistory = await request(
      `/ai/conversations/${report.firstConversationId}`,
      "GET",
      undefined,
      otherRegistered.cookie,
    );
    assert.ok([403, 404].includes(deniedHistory.status), "another seller cannot access contact conversation");
    assert.equal(getModelGatewayCallCount() - beforeCalls, 0, "no live/model calls");
    console.log("CONTACT_BROWSER_MICROCLOSURE", JSON.stringify({
      authenticated: true,
      approval: true,
      draftReload: true,
      alternatePublished: true,
      conversationOnly: report.conversationOnly,
      categoryCollision: report.categoryCollision,
      consoleErrors: report.consoleErrors.length,
      autoPublished: report.autoPublished,
      crossSellerDenied: deniedHistory.status,
      providerRequests: report.providerRequests.length,
      modelCalls: 0,
    }));
  } finally {
    await unlink(resultPath).catch(() => undefined);
    await unlink(`${resultPath}.buyer`).catch(() => undefined);
    if (web.pid) {
      try { process.kill(-web.pid, "SIGTERM"); } catch { web.kill("SIGTERM"); }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
