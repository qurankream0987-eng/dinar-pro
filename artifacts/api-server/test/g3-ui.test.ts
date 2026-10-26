/**
 * G3 acceptance: the premium conversational UI, proven in a real browser.
 *
 * The real API runs in this process against a disposable loopback database; the DINAR
 * frontend is the production build (`vite build`) served by `vite preview`. Playwright
 * (Chromium) drives connected journeys at 320/360/390/414 and 1280 px. The model is a
 * controlled in-process provider (no live AI); no payment, delivery, SMS, maps or
 * marketplace provider is contacted. This file prepares fixtures, runs
 * ../dinar/test/g3-ui-acceptance.mjs and checks its report against server state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import app from "../src/app";
import {
  db,
  markets,
  listingPromotions,
  negotiations,
  offers,
  orders,
  paymentIntents,
  pool,
  promotionProducts,
  providerConnections,
  aiUiBlocks,
  conversations,
  tutorialLearningEvents,
  users,
} from "@workspace/db";
import { getModelGatewayCallCount, type ConversationModelGateway } from "../src/ai/model-gateway";
import { attachTransactionLocation, selectDeliveryMethod } from "../src/lib/delivery";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G3_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";
const execFileAsync = promisify(execFile);
const providerConfigured = Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);

// The controlled model: it answers open questions with untrusted-looking markup, which
// must render as inert text.
const MODEL_MARKUP = `<script>window.__xss="model"</script><img src=x onerror="window.__xss='model-img'"> رأي عام للنقاش`;
let sellerDraftSuggestionEnabled = false;
const controlledModel: ConversationModelGateway = {
  async proposeToolCall(messages) {
    const prompt = messages.map((message) => message.content).join("\n");
    if (
      sellerDraftSuggestionEnabled &&
      /\b(?:sell|selling|list|listing)\b/i.test(prompt) &&
      /\bcamera\b/i.test(prompt)
    )
      return {
        id: "g3-seller-draft",
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: "ACTION_PROPOSAL",
          goal: "SELL",
          entities: { item: "camera" },
          suggestedAction: "CREATE_LISTING_DRAFT",
          confidence: 0.98,
          conversationalReply: "I can help prepare a draft for the camera.",
        }),
      };
    return { id: "g3", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.6, conversationalReply: MODEL_MARKUP }) };
  },
};
app.locals.conversationModelGateway = controlledModel;

const external: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // Not a URL.
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port as number;
const base = `http://127.0.0.1:${port}/api`;
const runId = randomUUID().slice(0, 6);
const TOKEN = [...runId].map((char) => "قمزدلفنسعرطبكهوج"[parseInt(char, 16)]).join("");
const CITY = `السلط ${Date.now() % 100_000}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.93.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
      ...headers,
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string; phone: string; label: string };
const phoneBase = 51_600_000 + ((Date.now() + process.pid) % 100_000);
let phoneOffset = 0;
async function register(label: string, activeMarketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  assert.equal(started.status, 202, started.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `G3-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR G3 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: activeMarketId }, registered.cookie)).status, 200);
  await db.update(users).set({ city: CITY }).where(eq(users.id, registered.data.user.id));
  return { id: registered.data.user.id, cookie: registered.cookie, phone: phoneNumber, label };
}

async function publish(actor: Actor, title: string, price: string, extra: Record<string, unknown> = {}) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — وصف مفصل للاختبار ${runId}`, category: "أخرى", categoryId: "other", area: "الصويفية", city: CITY,
    attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "DELIVERY", imageUrl: "", imageUrls: [], ...extra,
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const { port: free } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

/** The production build of the DINAR frontend, served by `vite preview`. */
async function startBuiltWeb() {
  const webPort = await availablePort();
  const env = { ...process.env, PORT: String(webPort), BASE_PATH: "/", NODE_ENV: "production" };
  await execFileAsync("pnpm", ["--filter", "@workspace/dinar", "run", "build"], { cwd: process.cwd(), env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const child = spawn("pnpm", ["--filter", "@workspace/dinar", "run", "serve"], { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const stop = async () => {
    if (child.exitCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await originalFetch(baseUrl);
      if (response.ok && (await response.text()).includes("<div id=\"root\"")) return { baseUrl, stop };
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null) throw new Error(`vite preview exited:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stop();
  throw new Error(`vite preview did not start:\n${output}`);
}

const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
let JO: Awaited<ReturnType<typeof resolveMarket>>;
const COORDS = { latitude: 31.954321, longitude: 35.912345 };

await test("setup: accounts, catalogue, a delivery with a precise location, a malicious provider listing", async () => {
  assert.equal(providerConfigured, false, "G3 runs with live model credentials stripped");
  const [seller, buyer, buyerTwo, providerOwner, providerHostile, driver, worker, multi, hostile, receiver, admin] = await Promise.all(
    ["Seller", "Buyer", "Buyer Two", "Provider", "Provider Hostile", "Driver", "Worker", "Multi", "Hostile", "Receiver", "Admin"].map((label) => register(label)),
  );
  sellerDraftSuggestionEnabled = true;
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin!.id));
  JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
  Object.assign(cookies, { seller: seller!.cookie, buyer: buyer!.cookie, buyerTwo: buyerTwo!.cookie, provider: providerOwner!.cookie, driver: driver!.cookie, worker: worker!.cookie, multi: multi!.cookie, receiver: receiver!.cookie });
  ids.seller = seller!.id;
  ids.buyerTwo = buyerTwo!.id;
  ids.buyer = buyer!.id;
  ids.providerOwner = providerOwner!.id;
  ids.receiver = receiver!.id;
  ids.buyerPhone = buyer!.phone;
  // Seller: three jackets (one negotiable at 10), a laptop, and an «Other» listing.
  ids.jacket = await publish(seller!, `جاكيت جلد ${TOKEN}`, "10", { category: "أزياء", categoryId: "fashion", attributes: { condition: "جديد" }, pricingMode: "NEGOTIABLE" });
  ids.jacketWool = await publish(seller!, `جاكيت صوف ${TOKEN}`, "12", { category: "أزياء", categoryId: "fashion", attributes: { condition: "مستعمل" } });
  ids.jacketRain = await publish(seller!, `جاكيت مطري ${TOKEN} Waterproof Edition طويل جدًا لاختبار الالتفاف`, "9", { category: "أزياء", categoryId: "fashion" });
  ids.laptop = await publish(seller!, `لابتوب ${TOKEN}`, "280", { category: "إلكترونيات", categoryId: "electronics" });
  ids.vase = await publish(seller!, `مزهرية ${TOKEN}`, "7");
  ids.wall = await publish(multi!, `ساعة جدار ${TOKEN}`, "15");
  // Untrusted text in a listing, rendered by every buyer surface.
  ids.hostile = await publish(hostile!, `<img src=x onerror="window.__xss='title'"> كوب ${TOKEN}`, "4", {
    description: `<script>window.__xss='description'</script> javascript:alert(1) <a href="javascript:window.__xss='href'">اضغط</a> ${runId}`,
  });
  for (const categoryId of ["fashion", "other"])
    await db.insert(promotionProducts).values({ id: randomUUID(), marketId: "JO", categoryId, name: `أسبوع ${categoryId} ${runId}`, placement: "SEARCH_AND_CHAT", priceMinor: 2000, currencyCode: "JOD", durationDays: 7, enabled: true, createdBy: admin!.id });
  const [fashionPlan] = await db.select().from(promotionProducts).where(and(eq(promotionProducts.marketId, "JO"), eq(promotionProducts.categoryId, "fashion")));
  assert.ok(fashionPlan, "a simulated fashion promotion plan exists");
  const sponsoredUnpriced = await request("/listings", "POST", {
    title: `تيشرت بلا سعر ${TOKEN}`, description: `قميص بدون سعر للاختبار ${TOKEN}`,
    category: "أزياء", categoryId: "fashion", area: "الصويفية", city: CITY,
    attributes: {}, unitPrice: null, pricingMode: "OPEN_TO_OFFERS",
    inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "DELIVERY",
    imageUrl: "", imageUrls: [],
  }, seller!.cookie);
  assert.equal(sponsoredUnpriced.status, 201, sponsoredUnpriced.raw);
  ids.sponsoredUnpriced = sponsoredUnpriced.data.id;
  await db.insert(listingPromotions).values({
    id: randomUUID(), listingId: ids.sponsoredUnpriced, sellerId: seller!.id, marketId: "JO",
    productId: fashionPlan.id, productNameSnapshot: fashionPlan.name, categoryIdSnapshot: "fashion",
    priceMinorSnapshot: fashionPlan.priceMinor, currencyCodeSnapshot: fashionPlan.currencyCode,
    placementSnapshot: "SEARCH_AND_CHAT", durationDaysSnapshot: fashionPlan.durationDays,
    status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED",
    startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
  });
  // A provider listing whose title is markup.
  const connection = await request("/provider-connections", "POST", { name: `مزود ${runId}` }, providerHostile!.cookie);
  assert.equal(connection.status, 201);
  const pushed = await request("/provider/listings/x-1", "PUT", {
    title: `<script>window.__xss='provider'</script> فنجان ${TOKEN}`, description: `منتج من نظام متصل ${runId}`, categoryId: "other", unitPrice: "3", currency: "JOD", quantity: 4, fulfilmentType: "PICKUP", area: "الحصن", city: CITY,
  }, "", { Authorization: `Bearer ${connection.data.key}` });
  assert.equal(pushed.status, 201, pushed.raw);
  // A seller-delivery order with a precise device destination (Block D authority).
  const order = await request("/orders", "POST", { listingId: ids.vase, quantity: 1, fulfilmentType: "DELIVERY", idempotencyKey: `g3-${randomUUID()}` }, receiver!.cookie);
  assert.equal(order.status, 201, order.raw);
  ids.deliveryOrder = order.data.id;
  await db.transaction((tx) => selectDeliveryMethod({ actorId: receiver!.id, orderId: order.data.id, method: "SELLER_DELIVERY", market: JO }, tx));
  await db.transaction((tx) => attachTransactionLocation({ actorId: receiver!.id, orderId: order.data.id, purpose: "DELIVERY_DESTINATION", location: { source: "DEVICE", ...COORDS }, market: JO }, tx));
  // An employment profile whose text is markup.
  await request(`/ai/conversations`, "POST", {}, worker!.cookie);
});

await test("a closed guest market rejects selection and replay without switching markets", async () => {
  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market, "Jordan market fixture exists");
  const previousIsActive = market.isActive;
  const offersBefore = (await db.select({ id: offers.id }).from(offers)).length;
  const ordersBefore = (await db.select({ id: orders.id }).from(orders)).length;
  try {
    const selected = await request("/account/market", "PATCH", {
      marketId: "JO",
    });
    assert.equal(selected.status, 200, selected.raw);
    assert.match(selected.cookie, /^bdinar_guest_market=JO$/);

    await db.update(markets).set({ isActive: false }).where(eq(markets.id, "JO"));

    const staleSelection = await request(
      "/account/market",
      "PATCH",
      { marketId: "JO" },
      selected.cookie,
    );
    assert.equal(staleSelection.status, 409, staleSelection.raw);
    const identity = await request("/auth/me", "GET", undefined, selected.cookie);
    assert.equal(identity.data.marketId, "JO", "a closed choice is not silently replaced");

    const catalog = await request("/markets");
    const jordan = catalog.data.find((entry: { id: string }) => entry.id === "JO");
    assert.equal(jordan?.isActive, false, "the selector catalog reports the closed market");

    const search = await request(
      "/ai/preview",
      "POST",
      { message: "ابحث عن كاميرا", marketId: "JO" },
      selected.cookie,
    );
    const seller = await request(
      "/ai/preview",
      "POST",
      { message: "I want to sell a camera", marketId: "JO" },
      selected.cookie,
    );
    const surfaces = (response: typeof search) =>
      (response.data.blocks ?? []).map(
        (block: { type: string; payload?: { surface?: string } }) =>
          block.payload?.surface ?? block.type,
      );
    assert.deepEqual(surfaces(search), ["MARKET_SELECTOR"]);
    assert.deepEqual(surfaces(seller), ["MARKET_SELECTOR"]);
    assert.equal((await db.select({ id: offers.id }).from(offers)).length, offersBefore);
    assert.equal((await db.select({ id: orders.id }).from(orders)).length, ordersBefore);
    console.log(
      "CLOSED_MARKET_SELECTION",
      JSON.stringify({
        rejectedStatus: staleSelection.status,
        selectedMarketAfterClosure: identity.data.marketId,
        searchSurface: surfaces(search)[0],
        sellerSurface: surfaces(seller)[0],
        catalogShowsClosed: jordan?.isActive === false,
      }),
    );
  } finally {
    await db
      .update(markets)
      .set({ isActive: previousIsActive })
      .where(eq(markets.id, "JO"));
  }
});

await test("owner order status and tracking remain available after market closure", async () => {
  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market, "Jordan market fixture exists");
  assert.ok(ids.deliveryOrder, "a legitimate receiver-owned delivery order exists");
  const previousIsActive = market.isActive;
  const ownerConversation = await request(
    "/ai/conversations",
    "POST",
    {},
    cookies.receiver,
  );
  assert.equal(ownerConversation.status, 201, ownerConversation.raw);
  const conversationId = ownerConversation.data.id as string;
  const otherConversation = await request(
    "/ai/conversations",
    "POST",
    {},
    cookies.buyer,
  );
  assert.equal(otherConversation.status, 201, otherConversation.raw);

  const completeAssistant = (response: Awaited<ReturnType<typeof request>>) => {
    const event = response.raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((item) => item.type === "complete");
    assert.ok(event?.assistantMessage, `completed turn: ${response.raw.slice(0, 500)}`);
    return event.assistantMessage as {
      body: string;
      blocks: Array<{ payload?: { surface?: string; resourceId?: string; resourceIds?: string[] } }>;
    };
  };
  const turn = async (id: string, message: string, cookie: string) => {
    const response = await request(
      `/ai/conversations/${id}/turns`,
      "POST",
      { message },
      cookie,
    );
    assert.equal(response.status, 200, `${message}: ${response.raw.slice(0, 500)}`);
    return completeAssistant(response);
  };
  const containsOwnedOrder = (message: ReturnType<typeof completeAssistant>) =>
    message.blocks.some(
      (block) =>
        block.payload?.resourceId === ids.deliveryOrder ||
        block.payload?.resourceIds?.includes(ids.deliveryOrder!),
    );

  const offersBefore = (await db.select({ id: offers.id }).from(offers)).length;
  const ordersBefore = (await db.select({ id: orders.id }).from(orders)).length;
  try {
    await db.update(markets).set({ isActive: false }).where(eq(markets.id, "JO"));

    const list = await turn(conversationId, "اعرض طلباتي", cookies.receiver!);
    assert.ok(containsOwnedOrder(list), "the owner can open their existing order");

    const status = await turn(conversationId, "وين طلبي؟", cookies.receiver!);
    assert.ok(
      ["ORDER_STATUS", "ORDER_TRACKING"].includes(
        status.blocks[0]?.payload?.surface ?? "",
      ),
      "the owner's existing order status remains available",
    );
    assert.ok(containsOwnedOrder(status));

    const tracking = await turn(conversationId, "تتبع طلبي", cookies.receiver!);
    assert.equal(tracking.blocks[0]?.payload?.surface, "ORDER_TRACKING");
    assert.ok(containsOwnedOrder(tracking), "tracking references the owner's existing order");

    const denied = await request(
      `/ai/conversations/${conversationId}/turns`,
      "POST",
      { message: "وين طلبي؟" },
      cookies.buyer,
    );
    assert.notEqual(denied.status, 200, "another participant cannot use the owner's conversation");
    assert.doesNotMatch(denied.raw, new RegExp(ids.deliveryOrder!));

    const otherOrders = await turn(
      otherConversation.data.id,
      "اعرض طلباتي",
      cookies.buyer!,
    );
    assert.equal(
      containsOwnedOrder(otherOrders),
      false,
      "another participant's order list does not reveal this order",
    );

    const search = await turn(conversationId, "ابحث عن جاكيت", cookies.receiver!);
    assert.equal(
      search.blocks.some((block) => block.payload?.surface === "LISTING_RESULTS"),
      false,
      "new search is blocked in the inactive market",
    );
    const seller = await turn(
      conversationId,
      "أريد أبيع كاميرا",
      cookies.receiver!,
    );
    assert.equal(
      seller.blocks.some((block) => block.payload?.surface === "SELL"),
      false,
      "a new seller flow is blocked in the inactive market",
    );
    assert.equal((await db.select({ id: offers.id }).from(offers)).length, offersBefore);
    assert.equal((await db.select({ id: orders.id }).from(orders)).length, ordersBefore);
    console.log(
      "CLOSED_MARKET_ORDER",
      JSON.stringify({
        orderList: containsOwnedOrder(list),
        orderStatus: containsOwnedOrder(status),
        tracking: containsOwnedOrder(tracking),
        otherParticipantDenied: denied.status !== 200,
        newSearchBlocked: !search.blocks.some(
          (block) => block.payload?.surface === "LISTING_RESULTS",
        ),
        newSellerFlowBlocked: !seller.blocks.some(
          (block) => block.payload?.surface === "SELL",
        ),
      }),
    );
  } finally {
    await db
      .update(markets)
      .set({ isActive: previousIsActive })
      .where(eq(markets.id, "JO"));
  }
});

let report: any;
await test("G3 browser acceptance (production build, real API, Chromium)", async () => {
  const beforeCalls = getModelGatewayCallCount();
  const web = await startBuiltWeb();
  const resultPath = `/tmp/dinar-g3-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/g3-ui-acceptance.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        G3_WEB_BASE: web.baseUrl,
        G3_API_ORIGIN: `http://127.0.0.1:${port}`,
        G3_COOKIES: JSON.stringify(cookies),
        G3_IDS: JSON.stringify(ids),
        G3_TOKEN: TOKEN,
        G3_CITY: CITY,
        G3_COORDS: JSON.stringify(COORDS),
        G3_RESULT_PATH: resultPath,
      },
      timeout: 1_500_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("G3_BROWSER", JSON.stringify({ ...report, checks: report?.checks?.length, checkList: undefined }));
  if (browserError && !report) throw browserError;
  report.modelCalls = getModelGatewayCallCount() - beforeCalls;
  assert.equal(report.failure, undefined, report.failure);
});

await test("server truth behind the browser journeys", async () => {
  assert.ok(report, "browser report");
  assert.ok(report.tutorialBrowser, "authenticated tutorial browser journey was recorded");
  assert.equal(report.tutorialBrowser.actorId, ids.seller);
  assert.equal(report.tutorialBrowser.marketId, "JO");
  assert.equal(report.tutorialBrowser.draftId, report.tutorialBrowser.resumedDraftId);
  assert.equal(report.tutorialBrowser.fallbackIsLocalAnimation, true);
  assert.equal(report.tutorialBrowser.continuationRecorded, true);
  const [tutorialEvent] = await db
    .select()
    .from(tutorialLearningEvents)
    .where(eq(tutorialLearningEvents.id, report.tutorialBrowser.openedEventId));
  assert.ok(tutorialEvent, "browser event exists in the database after the browser run");
  assert.equal(tutorialEvent.userId, ids.seller);
  assert.equal(tutorialEvent.tutorialId, "SELL_FIRST_LISTING");
  assert.equal(tutorialEvent.eventType, "TUTORIAL_OPENED");
  const [tutorialConversation] = await db
    .select({ ownerUserId: conversations.ownerUserId, marketId: conversations.marketId })
    .from(conversations)
    .where(eq(conversations.id, report.tutorialBrowser.conversationId));
  assert.deepEqual(tutorialConversation, { ownerUserId: ids.seller, marketId: "JO" });
  const tutorialDraftBlocks = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, report.tutorialBrowser.conversationId));
  assert.ok(
    tutorialDraftBlocks.some(({ payload }) =>
      payload.surface === "SELL" &&
      payload.draft?.draftId === report.tutorialBrowser.draftId &&
      payload.draft?.title?.includes("معطف شتوي"),
    ),
    "persisted seller draft identity and title survived the tutorial round trip",
  );
  assert.deepEqual(report.guestMarketGate, {
    marketId: "KW",
    searchStatus: 200,
    sellerIntentStatus: 200,
    sellerIntentSurface: "MARKET_SELECTOR",
    sellerIntentStartedDraft: false,
    sellerAdviceStatus: 200,
    selectedMarketId: "JO",
    resumedMarketId: "JO",
    resumedUserMessageCount: 1,
    sellerResumeRequiresAuth: true,
    sellerResumeSurface: "SELL",
  });
  assert.equal(report.staleMarketSelection.staleChoiceStatus, 409);
  assert.equal(report.staleMarketSelection.selectedMarketAfter, "KW");
  assert.deepEqual(report.staleMarketSelection.previewMarketIds, ["KW"]);
  assert.equal(report.staleMarketSelection.originalIntentCount, 1);
  assert.deepEqual(
    report.staleMarketSelection.displayedMarketIds,
    report.staleMarketSelection.refreshedAvailableIds,
  );
  assert.ok(
    !report.staleMarketSelection.displayedMarketIds.includes("JO"),
    "the refreshed selector no longer offers the closed market",
  );
  const rollout = await db
    .select({ id: markets.id, isActive: markets.isActive, status: markets.status })
    .from(markets)
    .where(eq(markets.id, "KW"));
  assert.deepEqual(rollout.map(({ id, isActive, status }) => [id, isActive, status]), [["KW", true, "ACTIVE"]]);
  // Journey A: the seller's conversational draft was published by the canonical authority.
  const published = await db.select().from(offers).where(and(eq(offers.sellerId, ids.seller!), sql`${offers.data}->>'title' like ${"%معطف شتوي%"}`));
  assert.equal(published.length, 1, "exactly one listing published from the chat draft");
  assert.equal(published[0]!.unitPriceMinor, 11000, "the edited price was published");
  // Journey C: private agreed price on the order; public price unchanged.
  const [deal] = await db.select().from(negotiations).where(and(eq(negotiations.buyerId, ids.buyerTwo!), eq(negotiations.listingId, ids.jacket!)));
  assert.deepEqual([deal!.status, deal!.agreedAmountMinor], ["ACCEPTED", 8000]);
  assert.equal((await db.select().from(offers).where(eq(offers.id, ids.jacket!)))[0]!.unitPriceMinor, 10000);
  if (report.negotiatedOrder) {
    const [order] = await db.select().from(orders).where(and(eq(orders.buyerId, ids.buyerTwo!), eq(orders.sellerId, ids.seller!)));
    assert.equal(order!.unitPriceMinor, 8000);
  }
  // Journey B: no payment marked paid.
  const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.buyerId, ids.buyer!));
  for (const intent of intents) assert.notEqual(intent.status, "SUCCEEDED", "simulation intents are never paid by the UI");
  // Journey D: the connection ends revoked.
  const connections = await db.select().from(providerConnections).where(eq(providerConnections.ownerUserId, ids.providerOwner!));
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.status, "REVOKED");
  assert.deepEqual(external, [], "no external provider contacted by the API");
  const results = report.results as Record<string, string>;
  const g3 = Object.keys(results).filter((key) => key.startsWith("G3-"));
  const journeys = Object.keys(results).filter((key) => key.startsWith("J-"));
  console.log(
    "G3_SUMMARY",
    JSON.stringify({
      acceptance: { passed: g3.filter((key) => results[key] === "PASS").length, total: 32, missing: Array.from({ length: 32 }, (_, i) => `G3-${String(i + 1).padStart(2, "0")}`).filter((key) => !results[key]) },
      journeys: { passed: journeys.filter((key) => results[key] === "PASS").length, total: 7 },
      counters: report.counters,
      modelCalls: report.modelCalls,
      widths: report.widths,
    }),
  );
  assert.equal(g3.length, 32, `all 32 G3 checks recorded: ${JSON.stringify(results)}`);
  assert.ok(g3.every((key) => results[key] === "PASS"), JSON.stringify(results));
  assert.equal(journeys.length, 7);
  assert.ok(journeys.every((key) => results[key] === "PASS"), JSON.stringify(results));
  for (const key of ["UI-SG-IPHONE", "UI-SG-TABLE", "UI-SG-SERVICE", "UI-N04", "UI-N36"])
    assert.equal(results[key], "PASS", `${key}: ${JSON.stringify(results[key])}`);
  for (const [key, value] of Object.entries(report.counters as Record<string, number>)) assert.equal(value, 0, `${key} = ${value}`);
});

await test("teardown", async () => {
  server.close();
  await pool.end();
});
