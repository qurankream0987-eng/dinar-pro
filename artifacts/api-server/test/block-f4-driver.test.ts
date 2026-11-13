import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  aiUiBlocks,
  candidateProfiles,
  courierCommissionReceivables,
  courierCommissionSettlements,
  courierFareAgreements,
  db,
  deliveryAssignments,
  deliveryProgressEvents,
  driverProfiles,
  marketAudit,
  marketPriceVersions,
  markets,
  messages,
  orderFulfillments,
  orders,
  pool,
  sellerDues,
  transactionLocations,
  users,
} from "@workspace/db";
import { confirmPendingAction, createPendingAction, proposeAction } from "../src/ai/action-foundation";
import { deliveryIntent, normalizeDeliveryText } from "../src/ai/delivery-turn";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { attachTransactionLocation, deliveryOptions, getDeliveryView, selectDeliveryMethod, transitionDelivery } from "../src/lib/delivery";
import { assignDelivery, driverHandoff, driverOutForDelivery, recordCourierProgress, ensureDriverDraft, listDeliveryWork, reviewDriverProfile, revokeCourierAssignment, setDriverAvailability, submitDriverProfile } from "../src/lib/driver";
import { recordCourierCommissionAccrual } from "../src/lib/courier-economics";
import { hasEligibleCourierSupply } from "../src/lib/courier-supply";
import { resolveMarket } from "../src/lib/markets";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKF_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const providerConfigured = Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);

// Every outbound request that leaves loopback is recorded: no SMS, payment, delivery,
// map or job provider is ever contacted.
const external: string[] = [];
const originalFetch = globalThis.fetch;
const execFileAsync = promisify(execFile);
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) external.push(url.hostname);
  } catch {
    // Not a URL; not a network request.
  }
  return originalFetch(input, init);
}) as typeof fetch;

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
// Each run works in its own coarse cities, so earlier runs' open work never mixes in.
const CITY = `عمان ${Date.now() % 100_000}`;
const OTHER = `الزرقاء ${Date.now() % 100_000}`;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.40.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}` } : {}),
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
  return {
    status: response.status,
    data,
    raw,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    cacheControl: response.headers.get("cache-control") ?? "",
  };
}

type Actor = { id: string; cookie: string; phone: string; conv: string };
const phoneBase = 51_600_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string, market = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `BlockF4-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR F4 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  if (market !== "KW") assert.equal((await request("/account/market", "PATCH", { marketId: market }, registered.cookie)).status, 200);
  const actor = { id: registered.data.user.id, cookie: registered.cookie, phone: phoneNumber, conv: "" };
  actor.conv = (await request("/ai/conversations", "POST", {}, actor.cookie)).data.id;
  return actor;
}

// ─── False-success accounting: every success phrase is checked against server rows.
const falses = { profile: 0, approval: 0, availability: 0, assignment: 0, delivered: 0 };
const modelCalls: number[] = [];
type Turn = { body: string; payload: any; driver: any; surface: string };
async function turn(actor: Actor, message: string, extra: Record<string, unknown> = {}, conversationId = actor.conv): Promise<Turn> {
  const before = getModelGatewayCallCount();
  const assignedBefore = await activeCount(actor.id);
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message, ...extra }),
  });
  const raw = await response.text();
  const events = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  const complete = events.find((event) => event.type === "complete");
  modelCalls.push(getModelGatewayCallCount() - before);
  assert.ok(complete, `${message}: ${raw.slice(0, 300)}`);
  const body: string = complete.assistantMessage.body;
  const payload = complete.assistantMessage.blocks[0]?.payload ?? {};
  const [profile] = await db.select().from(driverProfiles).where(eq(driverProfiles.userId, actor.id));
  if (/أُرسل طلب تسجيلك/.test(body) && profile?.status !== "PENDING_VERIFICATION") falses.profile++;
  if (/حالة تسجيلك كسائق: معتمد|تم اعتمادك/.test(body) && profile?.status !== "APPROVED") falses.approval++;
  if (/أنت متاح الآن/.test(body) && profile?.availability !== "AVAILABLE") falses.availability++;
  if (/تم قبول مهمة التوصيل/.test(body) && (await activeCount(actor.id)) !== assignedBefore + 1) falses.assignment++;
  if (/^تم التسليم:/.test(body)) {
    const orderId = payload.driver?.assignments?.[0]?.orderId;
    const [fulfillment] = orderId ? await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId)) : [];
    if (fulfillment?.status !== "DELIVERED") falses.delivered++;
  }
  return { body, payload, driver: payload.driver, surface: payload.surface };
}
const activeCount = async (driverId: string) =>
  (await db.select().from(deliveryAssignments).where(and(eq(deliveryAssignments.driverId, driverId), eq(deliveryAssignments.status, "ACCEPTED")))).length;
const profileOf = async (actor: Actor, marketId = "JO") =>
  (await db.select().from(driverProfiles).where(and(eq(driverProfiles.userId, actor.id), eq(driverProfiles.marketId, marketId))))[0];
const setOf = async (id: string) => (await db.select().from(aiResultSets).where(eq(aiResultSets.id, id)))[0]!;
const fulfillmentOf = async (orderId: string) => (await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId)))[0]!;
const assignmentsFor = async (orderId: string) =>
  db.select().from(deliveryAssignments).where(and(eq(deliveryAssignments.orderId, orderId), eq(deliveryAssignments.status, "ACCEPTED")));

const results: Record<string, "PASS" | "FAIL"> = {};
const attacks = { crossDriver: { passed: 0, failed: 0 }, crossMarket: { passed: 0, failed: 0 } };
async function focused(id: string, name: string, body: () => Promise<void>) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}
async function expectRejected(kind: keyof typeof attacks, attempt: () => Promise<unknown>, statuses: number[]) {
  const outcome = await attempt().then((value) => ({ value }), (error) => ({ error }));
  const status = "error" in outcome ? (outcome.error as any)?.status : (outcome.value as any)?.status;
  if (statuses.includes(status)) attacks[kind].passed++;
  else attacks[kind].failed++;
  assert.ok(statuses.includes(status), `${kind} attack not rejected: ${JSON.stringify(outcome).slice(0, 200)}`);
}

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let KW: Awaited<ReturnType<typeof resolveMarket>>;
let admin: Actor, seller: Actor, buyer: Actor, d1: Actor, d2: Actor, d3: Actor, d4: Actor, dk: Actor;
const W: Record<string, string> = {};
const SECRET_ADDRESS = `شارع السر ${runId} بناية 7`;
const SECRET_LAT = 31.987654;
const SECRET_LNG = 35.876543;

/** A real order through the canonical paths, its Block D method and (optionally) destination. */
async function courierOrder(title: string, city: string, options: { method?: "COURIER" | "SELLER_DELIVERY"; destination?: "MANUAL" | "DEVICE" | null; buyerActor?: Actor; market?: typeof JO } = {}) {
  const who = options.buyerActor ?? buyer;
  const market = options.market ?? JO;
  const listing = await request("/listings", "POST", {
    title: `${title} ${runId}`, description: `اختبار التوصيل ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city,
    attributes: {}, unitPrice: (10).toFixed(market.minorUnitScale), inventoryMode: "LIMITED", availableQuantity: 5, fulfilmentType: "DELIVERY", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", { listingId: listing.data.id, quantity: 1, fulfilmentType: "DELIVERY", idempotencyKey: `f4-${randomUUID()}` }, who.cookie);
  assert.equal(order.status, 201, order.raw);
  assert.equal((await request(`/orders/${order.data.id}/accept`, "POST", {}, seller.cookie)).status, 200);
  await db.transaction((tx) => selectDeliveryMethod({ actorId: who.id, orderId: order.data.id, method: options.method ?? "COURIER", market }, tx));
  if (options.destination !== null) {
    const location =
      options.destination === "DEVICE"
        ? { source: "DEVICE" as const, latitude: SECRET_LAT, longitude: SECRET_LNG, accuracyMeters: 12 }
        : { source: "MANUAL" as const, city: CITY, area: "الصويفية", addressText: SECRET_ADDRESS };
      await db.transaction((tx) => attachTransactionLocation({ actorId: who.id, orderId: order.data.id, purpose: "DELIVERY_DESTINATION", location, market }, tx));
  }
  return order.data.id as string;
}

async function simpleOrder(actor: Actor, title: string, fulfilmentType: "PICKUP" | "DELIVERY", city: string) {
  const listing = await request("/listings", "POST", {
    title: `${title} ${runId}`, description: `اختبار خيارات التسليم ${runId}`, category: "أخرى", categoryId: "other",
    area: "خلدا", city, attributes: {}, unitPrice: "10.000", inventoryMode: "LIMITED",
    availableQuantity: 3, fulfilmentType, imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(listing.status, 201, listing.raw);
  const order = await request("/orders", "POST", {
    listingId: listing.data.id, quantity: 1, fulfilmentType, idempotencyKey: `w6-${randomUUID()}`,
  }, actor.cookie);
  assert.equal(order.status, 201, order.raw);
  const accepted = await request(`/orders/${order.data.id}/accept`, "POST", {}, seller.cookie);
  assert.equal(accepted.status, 200, accepted.raw);
  return order.data.id as string;
}

async function agreeCourierFare(
  orderId: string,
  buyerActor: Actor = buyer,
  courierActor: Actor = d1,
  amount = "1.000",
) {
  const proposed = await request(
    `/orders/${orderId}/courier-fare/proposals`,
    "POST",
    { amount, idempotencyKey: `r5-${randomUUID()}` },
    buyerActor.cookie,
  );
  assert.equal(proposed.status, 200, proposed.raw);
  const proposalId = proposed.data.proposal.id;
  const buyerConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    buyerActor.cookie,
  );
  assert.equal(buyerConfirmation.status, 200, buyerConfirmation.raw);
  assert.equal(buyerConfirmation.data.agreed, false);
  const courierConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    courierActor.cookie,
  );
  assert.equal(courierConfirmation.status, 200, courierConfirmation.raw);
  assert.equal(courierConfirmation.data.agreed, true);
  return courierConfirmation.data.agreement;
}

async function completeCourierOrder(
  orderId: string,
  courierActor: Actor,
  buyerActor: Actor,
  amount?: string,
  market = JO,
) {
  const fare = amount ?? `1.${"0".repeat(market.minorUnitScale)}`;
  await assignDelivery({ actorId: courierActor.id, orderId, market });
  const agreement = await agreeCourierFare(orderId, buyerActor, courierActor, fare);
  await startDriverTrip(courierActor, orderId, market);
  await driverHandoff({ actorId: courierActor.id, orderId, market });
  const confirmed = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, buyerActor.cookie);
  assert.equal(confirmed.status, 200, confirmed.raw);
  return agreement;
}

async function startDriverTrip(actor: Actor, orderId: string, market = JO) {
  await recordCourierProgress({ actorId: actor.id, orderId, market, type: "PICKED_UP" });
  return driverOutForDelivery({ actorId: actor.id, orderId, market });
}

const approve = async (actor: Actor, marketId = "JO") =>
  request(`/admin/drivers/${(await profileOf(actor, marketId))!.id}/review`, "POST", { decision: "APPROVE" }, admin.cookie);

async function activateTestMarket(marketId: string) {
  const [market] = await db.select().from(markets).where(eq(markets.id, marketId));
  assert.ok(market, `test market ${marketId} exists`);
  await db.transaction(async (tx) => {
    const [currentPrice] = await tx
      .select()
      .from(marketPriceVersions)
      .where(
        and(
          eq(marketPriceVersions.marketId, marketId),
          isNull(marketPriceVersions.effectiveTo),
        ),
      )
      .limit(1);
    const priceMinor = currentPrice?.unitPriceMinor ?? market.unitPriceMinor ?? 1000;
    if (!currentPrice) {
      const now = new Date();
      await tx.insert(marketPriceVersions).values({
        id: randomUUID(),
        marketId,
        currencyCode: market.currencyCode,
        unitPriceMinor: priceMinor,
        minorUnitScale: market.minorUnitScale,
        effectiveFrom: now,
        effectiveTo: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await tx
      .update(markets)
      .set({ isActive: true, status: "ACTIVE", unitPriceMinor: priceMinor })
      .where(eq(markets.id, marketId));
  });
}

await test("setup: providers off, accounts, admin, JO courier policy", async () => {
  assert.equal(providerConfigured, false, "F4 runs with external model credentials stripped");
  await activateTestMarket("JO");
  await activateTestMarket("KW");
  [admin, seller, buyer, d1, d2, d3, d4] = await Promise.all(["Admin", "Seller", "Buyer", "Driver One", "Driver Two", "Driver Three", "Driver Four"].map((label) => register(label)));
  dk = await register("Driver KW", "KW");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
  // Market policy fixture: JO enables DINAR courier delivery; KW does not.
  await db.execute(sql`update markets set fulfilment_methods = fulfilment_methods || '["COURIER"]'::jsonb where id = 'JO' and not fulfilment_methods ? 'COURIER'`);
  JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
  // One published listing makes this run's city a known DINAR city before onboarding.
  const known = await request("/listings", "POST", {
    title: `كرسي ${runId}`, description: `اختبار ${runId}`, category: "أخرى", categoryId: "other", area: "خلدا", city: CITY,
    attributes: {}, unitPrice: "3.000", inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(known.status, 201, known.raw);
  KW = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "KW")))[0]!);
});

await focused("F4-01", "«أريد أشتغل سائق» starts a real DRAFT driver profile in the same chat", async () => {
  const started = await turn(d1, "دينار أريد أشتغل سائق");
  assert.equal(started.surface, "DRIVER_ONBOARDING", started.body);
  assert.equal(started.payload.employment, undefined, "not an employment flow");
  const profile = await profileOf(d1);
  assert.equal(profile?.status, "DRAFT");
  assert.match(started.body, /ما نوع مركبتك/);
  const again = await turn(d1, "سجلني كسائق");
  assert.equal(again.surface, "DRIVER_ONBOARDING");
  assert.equal((await db.select().from(driverProfiles).where(eq(driverProfiles.userId, d1.id))).length, 1, "one profile per user and market");
  const duplicate = await db.insert(driverProfiles).values({ id: randomUUID(), userId: d1.id, marketId: "JO" }).then(() => "inserted", (error) => error?.cause?.code ?? error?.code);
  assert.equal(duplicate, "23505", "the database refuses a second profile");
  const vehicle = await turn(d1, "سيارة");
  assert.equal((await profileOf(d1))!.vehicleType, "CAR");
  assert.match(vehicle.body, /في أي مدينة/);
  const review = await turn(d1, CITY);
  assert.equal(review.surface, "DRIVER_ONBOARDING_REVIEW", review.body);
  assert.equal(review.driver.profile.serviceCity, CITY);
  assert.deepEqual(review.driver.actions, ["SUBMIT", "EDIT", "CANCEL"]);
  // An edit restages the review; the profile is still a draft.
  const edited = await turn(d1, "دراجة نارية");
  assert.equal(edited.surface, "DRIVER_ONBOARDING_REVIEW");
  assert.equal((await profileOf(d1))!.vehicleType, "MOTORCYCLE");
  assert.equal((await profileOf(d1))!.status, "DRAFT");
});

await focused("F4-02", "facts already known are not asked again", async () => {
  await db.update(users).set({ city: CITY }).where(eq(users.id, d2.id));
  const review = await turn(d2, "أريد أكون سائق بسيارة");
  assert.equal(review.surface, "DRIVER_ONBOARDING_REVIEW", "vehicle from the message, city from the account");
  assert.doesNotMatch(review.body, /ما نوع مركبتك|في أي مدينة/);
  assert.equal((await profileOf(d2))!.serviceCity, CITY);
  assert.equal((await turn(d2, "نعم")).surface, "DRIVER_STATUS");
  const again = await turn(d2, "أريد أكون سائق");
  assert.equal(again.surface, "DRIVER_STATUS", "a submitted profile is reported, not re-asked");
  assert.match(again.body, /بانتظار التحقق/);
});

await focused("F4-03", "submitting never approves; an unverified phone stays pending", async () => {
  const submitted = await turn(d1, "نعم");
  assert.match(submitted.body, /أُرسل طلب تسجيلك كسائق للمراجعة/);
  assert.match(submitted.body, /بانتظار التحقق/);
  assert.doesNotMatch(submitted.body, /معتمد|تم اعتمادك/);
  assert.equal((await profileOf(d1))!.status, "PENDING_VERIFICATION");
  const status = await turn(d1, "ما حالة تسجيلي كسائق؟");
  assert.match(status.body, /بانتظار التحقق/);
  // An unverified account cannot even hold a session (existing auth policy), so the
  // synthetic fixture unverifies the phone after submission: approval is still refused.
  await db.update(users).set({ city: CITY }).where(eq(users.id, d3.id));
  await turn(d3, "أريد أشتغل سائق بسيارة");
  await turn(d3, "نعم");
  assert.equal((await profileOf(d3))!.status, "PENDING_VERIFICATION");
  await db.update(users).set({ phoneVerified: false }).where(eq(users.id, d3.id));
  const refused = await approve(d3);
  assert.equal(refused.status, 409, refused.raw);
  assert.match(refused.raw, /رقم هاتف الحساب غير موثق/);
  assert.equal((await profileOf(d3))!.status, "PENDING_VERIFICATION");
  await db.update(users).set({ phoneVerified: true }).where(eq(users.id, d3.id));
});

await focused("F4-04", "neither the conversation nor the client can approve a driver", async () => {
  const tampered = await turn(d1, "ما حالة تسجيلي كسائق؟", { approved: true, status: "APPROVED", availability: "AVAILABLE", driverId: d2.id, userId: d2.id, marketId: "KW" });
  assert.match(tampered.body, /بانتظار التحقق/);
  assert.equal((await profileOf(d1))!.status, "PENDING_VERIFICATION");
  const id = (await profileOf(d1))!.id;
  assert.equal((await request(`/admin/drivers/${id}/review`, "POST", { decision: "APPROVE" }, d1.cookie)).status, 403, "self-approval");
  assert.equal((await request(`/admin/drivers/${id}/review`, "POST", { decision: "APPROVE" }, seller.cookie)).status, 403);
  assert.equal((await request(`/admin/drivers/${id}/review`, "POST", { decision: "APPROVE", approved: true }, admin.cookie)).status, 400, "strict body");
  const forced = await db.update(driverProfiles).set({ availability: "AVAILABLE" }).where(eq(driverProfiles.id, id)).then(() => "written", (error) => error?.cause?.code ?? error?.code);
  assert.equal(forced, "23514", "the database refuses availability without approval");
  // The explicit administrator path, used as the approval fixture for the rest of the suite.
  for (const actor of [d1, d2]) assert.equal((await approve(actor)).status, 200);
  assert.equal((await profileOf(d1))!.status, "APPROVED");
  const audits = await db.select().from(marketAudit).where(eq(marketAudit.action, "DRIVER_PROFILE_APPROVED"));
  assert.ok(audits.some((row) => row.actorId === admin.id && (row.data as any).driverProfileId === id));
});

await focused("F4-05", "an approved driver's «أنا متاح» / «أنا غير متاح» are server mutations", async () => {
  const on = await turn(d1, "أنا متاح");
  assert.equal(on.surface, "DRIVER_AVAILABILITY");
  assert.match(on.body, /أنت متاح الآن/);
  assert.equal((await profileOf(d1))!.availability, "AVAILABLE");
  assert.match((await turn(d1, "أنا غير متاح")).body, /أنت غير متاح الآن/);
  assert.equal((await profileOf(d1))!.availability, "UNAVAILABLE");
  await turn(d1, "أنا متاح");
  await turn(d1, "وقفني مؤقت");
  assert.equal((await profileOf(d1))!.availability, "UNAVAILABLE");
  await turn(d1, "أنا متاح اليوم");
  assert.equal((await profileOf(d1))!.availability, "AVAILABLE");
  assert.equal((await turn(d2, "أنا متاح")).surface, "DRIVER_AVAILABILITY");
});

await focused("F4-06", "a pending, draft or suspended driver cannot become available", async () => {
  const pending = await turn(d3, "أنا متاح");
  assert.doesNotMatch(pending.body, /أنت متاح الآن/);
  assert.match(pending.body, /بانتظار التحقق/);
  assert.equal((await profileOf(d3))!.availability, "UNAVAILABLE");
  const stranger = await register("Stranger");
  await turn(stranger, "سجلني كسائق");
  const draft = await turn(stranger, "أنا متاح للتوصيل");
  assert.doesNotMatch(draft.body, /أنت متاح الآن/);
  assert.equal((await profileOf(stranger))!.availability, "UNAVAILABLE");
});

let workSetIds: string[] = [];
await focused("F4-07", "an approved, available driver sees only eligible internal DINAR work", async () => {
  W.a = await courierOrder("طاولة أ", CITY, { destination: "MANUAL" });
  W.b = await courierOrder("طاولة ب", CITY, { destination: "DEVICE" });
  W.c = await courierOrder("طاولة ج", CITY, { destination: "MANUAL" });
  const d2Profile = (await profileOf(d2))!;
  await db.update(driverProfiles).set({ serviceCity: OTHER }).where(eq(driverProfiles.id, d2Profile.id));
  try {
    W.zarqa = await courierOrder("طاولة الزرقاء", OTHER, { destination: "MANUAL" });
  } finally {
    await db.update(driverProfiles).set({ serviceCity: CITY }).where(eq(driverProfiles.id, d2Profile.id));
  }
  W.seller = await courierOrder("طاولة بائع", CITY, { method: "SELLER_DELIVERY", destination: "MANUAL" });
  W.noDestination = await courierOrder("طاولة بلا عنوان", CITY, { destination: null });
  W.own = await courierOrder("طاولة السائق", CITY, { destination: "MANUAL", buyerActor: d1 });
  // COURIER is offered only where the market policy enables it.
  const [order] = await db.select().from(orders).where(eq(orders.id, W.a));
  assert.ok((await getDeliveryView({ actorId: buyer.id, orderId: W.a, market: JO })).options.find((option) => option.method === "COURIER")!.available);
  assert.equal(deliveryOptions(order!, KW).find((option) => option.method === "COURIER")!.available, false);
  const list = await turn(d1, "اعرض لي طلبات توصيل");
  assert.equal(list.surface, "DELIVERY_WORK_RESULTS", list.body);
  const ids = list.driver.work.map((card: any) => card.id);
  assert.deepEqual(ids, [W.a, W.b, W.c], "open COURIER work in the driver's city, oldest first");
  workSetIds = (await setOf(list.payload.resultSetId)).resourceIds;
  assert.deepEqual(workSetIds, ids, "persisted as a result set");
  assert.deepEqual((await turn(d1, `اعرض لي توصيلات في ${CITY}`)).driver.work.map((card: any) => card.id), ids);
  assert.deepEqual((await turn(d1, "أعطني الأقرب لمنطقتي")).driver.work.map((card: any) => card.id), ids);
  // Back to the first list for the ordinal tests.
  const again = await turn(d1, "اعرض لي طلبات توصيل");
  workSetIds = (await setOf(again.payload.resultSetId)).resourceIds;
  await turn(d4, `أريد أشتغل سائق بسيارة في ${CITY}`);
  assert.match((await turn(d4, "اعرض لي طلبات توصيل")).body, /قيد الإعداد|لا يمكنك/, "no work before approval");
});

await focused("F4-08", "pre-assignment work leaks no exact location, auth phone or private data", async () => {
  const [stored] = await db.select().from(aiUiBlocks).where(and(eq(aiUiBlocks.conversationId, d1.conv), sql`${aiUiBlocks.payload}->>'surface' = 'DELIVERY_WORK_RESULTS'`)).limit(1);
  const list = await turn(d1, "اعرض لي طلبات توصيل");
  const serialized = JSON.stringify([list, stored]);
  const [buyerRow] = await db.select().from(users).where(eq(users.id, buyer.id));
  const leaks = {
    coordinates: [String(SECRET_LAT), String(SECRET_LNG)].filter((value) => serialized.includes(value)).length,
    phones: [buyer.phone, seller.phone, buyerRow!.normalizedPhone].filter((value) => value && serialized.includes(value)).length,
    privateData: [SECRET_ADDRESS, "DINAR F4 Buyer", "DINAR F4 Seller", "addressText", "buyerId", "sellerId", "normalizedPhone", "latitude"].filter((value) => serialized.includes(value)).length,
  };
  assert.deepEqual(leaks, { coordinates: 0, phones: 0, privateData: 0 });
  for (const card of list.driver.work) assert.deepEqual(Object.keys(card).sort(), ["dropoff", "id", "methodLabel", "pickup", "quantity", "reference", "requestedAt", "title"]);
  console.log("F4_PRIVACY", JSON.stringify(leaks));
});

await focused("F4-09", "«أقبل الثاني» resolves the persisted list, even if database order changes", async () => {
  // Database ordering changes after the list was shown: the third becomes the oldest.
  await db.update(orders).set({ createdAt: new Date(Date.now() - 86_400_000) }).where(eq(orders.id, W.c));
  const review = await turn(d1, "أقبل الثاني");
  assert.equal(review.surface, "DRIVER_ASSIGNMENT_REVIEW", review.body);
  assert.equal(review.driver.card.id, workSetIds[1], "the second item as presented");
  assert.equal(review.driver.card.id, W.b);
  assert.equal((await assignmentsFor(W.b)).length, 0, "nothing assigned before «نعم»");
  const accepted = await turn(d1, "نعم");
  assert.match(accepted.body, /تم قبول مهمة التوصيل/);
  const [assignment] = await assignmentsFor(W.b);
  assert.equal(assignment!.driverId, d1.id);
  const fulfillment = await fulfillmentOf(W.b);
  assert.equal(fulfillment.status, "ACCEPTED");
  assert.equal(fulfillment.statusChangedBy, d1.id);
  // After assignment the driver reads the destination through Block D's participant view only.
  const view = await request(`/orders/${W.b}/fulfillment`, "GET", undefined, d1.cookie);
  assert.equal(view.status, 200, view.raw);
  assert.equal(view.data.role, "DRIVER");
  assert.equal(view.data.destination.latitude, SECRET_LAT);
  assert.equal(view.raw.includes(buyer.phone), false);
  const blocks = await db.select().from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, d1.conv));
  assert.equal(JSON.stringify(blocks).includes(String(SECRET_LAT)), false, "never stored in the conversation");
});

await focused("F4-10", "two drivers racing for one delivery: exactly one assignment", async () => {
  await approve(d4).then((response) => assert.equal(response.status, 409, "d4 is still a draft"));
  // d4's earlier review expired when d4 moved on (F0 stale rule); it is reopened, then sent.
  assert.equal((await turn(d4, "نعم")).surface === "DRIVER_STATUS" && (await profileOf(d4))!.status === "PENDING_VERIFICATION", false);
  assert.equal((await turn(d4, "أريد أشتغل سائق")).surface, "DRIVER_ONBOARDING_REVIEW");
  await turn(d4, "نعم");
  assert.equal((await approve(d4)).status, 200);
  await turn(d4, "أنا متاح");
  const l2 = await turn(d2, "اعرض لي طلبات توصيل");
  const l4 = await turn(d4, "اعرض لي طلبات توصيل");
  const target = W.a;
  const p2 = l2.driver.work.findIndex((card: any) => card.id === target);
  const p4 = l4.driver.work.findIndex((card: any) => card.id === target);
  const ordinal = ["الأول", "الثاني", "الثالث"];
  await turn(d2, `أقبل ${ordinal[p2]}`);
  await turn(d4, `أقبل ${ordinal[p4]}`);
  const [r2, r4] = await Promise.all([turn(d2, "نعم"), turn(d4, "نعم")]);
  const successes = [r2, r4].filter((result) => /تم قبول مهمة التوصيل/.test(result.body)).length;
  const conflicts = [r2, r4].filter((result) => /تم أخذ مهمة التوصيل بالفعل/.test(result.body)).length;
  console.log("F4_RACE", JSON.stringify({ successes, conflicts, active: (await assignmentsFor(target)).length }));
  assert.equal(successes, 1);
  assert.equal(conflicts, 1);
  assert.equal((await assignmentsFor(target)).length, 1);
  // The authority itself under direct concurrency, without the conversation.
  const raced = await courierOrder("طاولة سباق", CITY, { destination: "MANUAL" });
  const outcomes = await Promise.allSettled([assignDelivery({ actorId: d2.id, orderId: raced, market: JO }), assignDelivery({ actorId: d4.id, orderId: raced, market: JO })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason.status, 409);
  assert.equal((await assignmentsFor(raced)).length, 1);
});

await focused("F4-11", "a confirmation shown before another driver accepted is rejected", async () => {
  const list = await turn(d4, "اعرض لي طلبات توصيل");
  const position = list.driver.work.findIndex((card: any) => card.id === W.c);
  assert.ok(position >= 0, list.body);
  await turn(d4, `أقبل ${["الأول", "الثاني", "الثالث"][position]}`);
  await assignDelivery({ actorId: d2.id, orderId: W.c, market: JO });
  const stale = await turn(d4, "نعم");
  assert.doesNotMatch(stale.body, /تم قبول مهمة التوصيل/);
  assert.match(stale.body, /تم أخذ مهمة التوصيل بالفعل/);
  const [assignment] = await assignmentsFor(W.c);
  assert.equal(assignment!.driverId, d2.id, "no theft or overwrite");
});

await focused("F4-12", "cross-driver and cross-user attempts are rejected", async () => {
  // d1 holds W.b. d4 tries to read it, move it, hand it off, or confirm d1's review.
  await expectRejected("crossDriver", () => request(`/orders/${W.b}/fulfillment`, "GET", undefined, d4.cookie), [404]);
  await expectRejected("crossDriver", () => driverOutForDelivery({ actorId: d4.id, orderId: W.b, market: JO }), [404]);
  await expectRejected("crossDriver", () => request(`/orders/${W.b}/delivery`, "POST", { proofType: "PHOTO", proofToken: "x" }, d4.cookie), [403, 404]);
  const pickupEventsBefore = await db
    .select({ id: deliveryProgressEvents.id })
    .from(deliveryProgressEvents)
    .where(and(
      eq(deliveryProgressEvents.orderId, W.b),
      eq(deliveryProgressEvents.type, "PICKED_UP"),
    ));
  for (const unauthorizedCourier of [d4, d2]) {
    await assert.rejects(
      recordCourierProgress({
        actorId: unauthorizedCourier.id,
        orderId: W.b,
        market: JO,
        type: "PICKED_UP",
      }),
      (error: any) => [403, 404].includes(error.status),
    );
  }
  const pickupEventsAfter = await db
    .select({ id: deliveryProgressEvents.id })
    .from(deliveryProgressEvents)
    .where(and(
      eq(deliveryProgressEvents.orderId, W.b),
      eq(deliveryProgressEvents.type, "PICKED_UP"),
    ));
  assert.equal(pickupEventsAfter.length, pickupEventsBefore.length);
  const list = await turn(d1, "اعرض لي طلبات توصيل");
  if (list.driver.work.length) {
    await turn(d1, "أقبل الأول");
    const pendingId = (await db.select().from(aiResultSets).where(eq(aiResultSets.conversationId, d1.conv))).find((set) => (set.query as any).action === "ACCEPT_DELIVERY" && (set.query as any).status === "PENDING")!.id;
    await expectRejected("crossDriver", () => confirmPendingAction({ actionId: pendingId, actorId: d4.id, market: JO, decision: "CONFIRM" }), [404]);
    await turn(d1, "لا");
  }
  await expectRejected("crossDriver", async () => request(`/admin/drivers/${(await profileOf(d1))!.id}/review`, "POST", { decision: "SUSPEND" }, d4.cookie), [403]);
  // Identity fields in the body are ignored: d4's «أنا غير متاح» changes only d4.
  await turn(d4, "أنا غير متاح", { driverId: d1.id, userId: d1.id, assignmentDriverId: d4.id });
  assert.equal((await profileOf(d1))!.availability, "AVAILABLE");
  assert.equal((await profileOf(d4))!.availability, "UNAVAILABLE");
  await turn(d4, "أنا متاح");
  // An invented delivery id is never accepted.
  await expectRejected("crossDriver", () => createPendingAction({ conversationId: d4.conv, actorId: d4.id, market: JO, proposal: proposeAction({ action: "ACCEPT_DELIVERY", targetResource: randomUUID() }) }), [409]);
  // The seller cannot hand off a COURIER order the driver carries.
  await expectRejected("crossDriver", () => db.transaction(async (tx) => {
    const { orderHandoff } = await import("../src/lib/delivery");
    const [row] = await tx.select().from(orders).where(eq(orders.id, W.b));
    return orderHandoff(tx, row!, seller.id, { proofType: "PHOTO", proofToken: "x" }, new Date());
  }), [403, 409]);
  console.log("F4_CROSS_DRIVER", JSON.stringify(attacks.crossDriver));
});

await focused("F4-13", "a driver in another market cannot take this market's work", async () => {
  await db.update(users).set({ city: CITY }).where(eq(users.id, dk.id));
  await turn(dk, "أريد أشتغل سائق بسيارة");
  await turn(dk, "نعم");
  assert.equal((await approve(dk, "KW")).status, 200);
  await turn(dk, "أنا متاح");
  const list = await turn(dk, "اعرض لي طلبات توصيل");
  assert.equal(list.driver?.work?.length ?? 0, 0, "no JO work in KW");
  const open = await courierOrder("طاولة سوق", CITY, { destination: "MANUAL" });
  await expectRejected("crossMarket", () => createPendingAction({ conversationId: dk.conv, actorId: dk.id, market: KW, proposal: proposeAction({ action: "ACCEPT_DELIVERY", targetResource: open }) }), [409]);
  await expectRejected("crossMarket", () => assignDelivery({ actorId: dk.id, orderId: open, market: KW }), [409]);
  await expectRejected("crossMarket", () => assignDelivery({ actorId: dk.id, orderId: open, market: JO }), [409]);
  await assert.rejects(
    recordCourierProgress({ actorId: dk.id, orderId: open, market: KW, type: "PICKED_UP" }),
    (error: any) => [403, 404, 409].includes(error.status),
  );
  assert.equal((await assignmentsFor(open)).length, 0);
  assert.equal(
    (await db.select().from(deliveryProgressEvents).where(eq(deliveryProgressEvents.orderId, open))).length,
    0,
    "wrong-market courier cannot append pickup progress",
  );

  const revokedOrder = await courierOrder("مهمة مسحوبة قبل الاستلام", CITY);
  await assignDelivery({ actorId: d2.id, orderId: revokedOrder, market: JO });
  const revoked = await request(
    `/admin/orders/${revokedOrder}/courier-assignment/revoke`,
    "POST",
    { reason: "test before pickup", idempotencyKey: `wave63-revoke-${randomUUID()}` },
    admin.cookie,
  );
  assert.equal(revoked.status, 200, revoked.raw);
  await assert.rejects(
    recordCourierProgress({ actorId: d2.id, orderId: revokedOrder, market: JO, type: "PICKED_UP" }),
    (error: any) => [403, 404, 409].includes(error.status),
  );
  assert.equal(
    (await db.select().from(deliveryProgressEvents).where(eq(deliveryProgressEvents.orderId, revokedOrder))).length,
    0,
    "released courier cannot append pickup progress",
  );

  const revokeRaceOrder = await courierOrder("سباق الإلغاء والاستلام", CITY);
  await assignDelivery({ actorId: d2.id, orderId: revokeRaceOrder, market: JO });
  const [pickupRace, revokeRace] = await Promise.allSettled([
    recordCourierProgress({ actorId: d2.id, orderId: revokeRaceOrder, market: JO, type: "PICKED_UP" }),
    request(
      `/admin/orders/${revokeRaceOrder}/courier-assignment/revoke`,
      "POST",
      { reason: "concurrent test", idempotencyKey: `wave63-revoke-race-${randomUUID()}` },
      admin.cookie,
    ),
  ]);
  assert.equal(pickupRace.status === "fulfilled" ? revokeRace.status === "fulfilled" && revokeRace.value.status === 409 : true, true);
  if (pickupRace.status === "fulfilled") {
    assert.equal(pickupRace.value.changed, true);
    assert.equal((await assignmentsFor(revokeRaceOrder)).filter((assignment) => assignment.status === "ACCEPTED").length, 1);
    assert.equal((await db.select().from(deliveryProgressEvents).where(and(
      eq(deliveryProgressEvents.orderId, revokeRaceOrder),
      eq(deliveryProgressEvents.type, "PICKED_UP"),
    ))).length, 1);
  } else {
    assert.equal(revokeRace.status, "fulfilled");
    assert.equal((revokeRace as PromiseFulfilledResult<any>).value.status, 200);
    assert.equal((await fulfillmentOf(revokeRaceOrder)).status, "FAILED");
    assert.equal((await assignmentsFor(revokeRaceOrder)).filter((assignment) => assignment.status === "ACCEPTED").length, 0);
    assert.equal((await db.select().from(deliveryProgressEvents).where(eq(deliveryProgressEvents.orderId, revokeRaceOrder))).length, 0);
  }
  console.log("F4_CROSS_MARKET", JSON.stringify(attacks.crossMarket));
});

await focused("F4-14", "a suspended driver or account cannot take new work; history stays", async () => {
  const open = await courierOrder("طاولة إيقاف", CITY, { destination: "MANUAL" });
  assert.equal((await request(`/admin/drivers/${(await profileOf(d4))!.id}/review`, "POST", { decision: "SUSPEND" }, admin.cookie)).status, 200);
  assert.equal((await profileOf(d4))!.availability, "UNAVAILABLE");
  const again = await turn(d4, "أنا متاح");
  assert.doesNotMatch(again.body, /أنت متاح الآن/);
  assert.match((await turn(d4, "اعرض لي طلبات توصيل")).body, /موقوف/);
  await assert.rejects(assignDelivery({ actorId: d4.id, orderId: open, market: JO }), (error: any) => error.status === 409);
  // An account suspension blocks new work even for an approved, available driver.
  await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, d2.id));
  await assert.rejects(assignDelivery({ actorId: d2.id, orderId: open, market: JO }), (error: any) => [403, 409].includes(error.status));
  await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, d2.id));
  assert.equal((await assignmentsFor(open)).length, 0);
  // d2's earlier assignment (W.c) survives d2's account suspension and restoration.
  assert.equal((await assignmentsFor(W.c))[0]!.driverId, d2.id, "assignments are never deleted");
});

await focused("F4-15", "driver delivery commands run through Block D transitions and the order handoff", async () => {
  const pickupNote = await turn(d1, "وصلت لمكان الاستلام");
  assert.match(pickupNote.body, /لم يتغير شيء/);
  assert.equal((await fulfillmentOf(W.b)).status, "ACCEPTED");
  const agreement = await agreeCourierFare(W.b, buyer, d1, "1.000");
  assert.equal(agreement.currencyCode, "JOD");
  assert.equal(agreement.amount, "1.000");
  const early = await turn(d1, "تم التسليم");
  assert.doesNotMatch(early.body, /^تم التسليم:/);
  assert.match(early.body, /خرج للتوصيل/);
  assert.equal((await fulfillmentOf(W.b)).status, "ACCEPTED");
  const pickup = await turn(d1, "استلمت الطلب");
  assert.match(pickup.body, /استلام الطلب من البائع/);
  assert.equal((await fulfillmentOf(W.b)).status, "ACCEPTED");
  const pickupRevoke = await request(`/admin/orders/${W.b}/courier-assignment/revoke`, "POST", {
    reason: "محاولة نقل بعد الاستلام",
    idempotencyKey: `wave63-pickup-custody-${randomUUID()}`,
  }, admin.cookie);
  assert.equal(pickupRevoke.status, 409, pickupRevoke.raw);
  assert.equal((await fulfillmentOf(W.b)).status, "ACCEPTED");
  const out = await turn(d1, "أنا في الطريق");
  assert.equal((await fulfillmentOf(W.b)).status, "OUT_FOR_DELIVERY", out.body);
  const arrival = await turn(d1, "وصلت للعميل");
  assert.match(arrival.body, /وصول المندوب/);
  const done = await turn(d1, "تم التسليم");
  assert.match(done.body, /^تم التسليم:/);
  assert.equal((await fulfillmentOf(W.b)).status, "DELIVERED");
  const [order] = await db.select().from(orders).where(eq(orders.id, W.b));
  assert.equal(order!.status, "SELLER_MARKED_DELIVERED", "the shared order handoff; the buyer still confirms");
  const confirmed = await request(`/orders/${W.b}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(confirmed.status, 200, confirmed.raw);
  const retry = await request(`/orders/${W.b}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(retry.status, 200, retry.raw);
  const priorProvider = app.locals.orderTrackingProvider;
  let terminalProviderCalls = 0;
  app.locals.orderTrackingProvider = {
    getSnapshot: async () => {
      terminalProviderCalls += 1;
      return {
        position: {
          latitude: SECRET_LAT,
          longitude: SECRET_LNG,
          observedAt: new Date().toISOString(),
        },
      };
    },
  };
  try {
    const tracking = await request(`/orders/${W.b}/tracking`, "GET", undefined, buyer.cookie);
    assert.equal(tracking.status, 200, tracking.raw);
    assert.equal(tracking.data.tracking.state, "STOPPED");
    assert.deepEqual(tracking.data.progress.map((event: any) => event.type), [
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "ARRIVED",
      "HANDED_OFF",
      "BUYER_RECEIVED",
    ]);
    assert.deepEqual(tracking.data.progress.map((event: any) => event.actorRole), [
      "COURIER",
      "COURIER",
      "COURIER",
      "COURIER",
      "BUYER",
    ]);
    assert.equal(terminalProviderCalls, 0, "completed receipt must stop before provider retrieval");
  } finally {
    if (priorProvider === undefined) delete app.locals.orderTrackingProvider;
    else app.locals.orderTrackingProvider = priorProvider;
  }
  const [receivable] = await db
    .select()
    .from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, W.b));
  assert.ok(receivable, "a completed DINAR courier trip accrues a receivable");
  assert.equal(receivable.courierId, d1.id);
  assert.equal(receivable.amountMinor, 100);
  assert.equal(receivable.currencyCode, "JOD");
  const [completedOrder] = await db.select().from(orders).where(eq(orders.id, W.b));
  assert.equal(
    (await db.select().from(sellerDues).where(eq(sellerDues.orderId, W.b)))[0]!.amountMinor,
    completedOrder!.platformFeeMinor,
    "courier commission stays out of seller dues",
  );
  assert.equal(
    await db.transaction((tx) =>
      recordCourierCommissionAccrual(tx, completedOrder!, new Date()),
    ),
    false,
    "duplicate terminal processing does not accrue twice",
  );
  assert.equal(
    (await db.select().from(courierCommissionReceivables).where(eq(courierCommissionReceivables.orderId, W.b))).length,
    1,
  );
  const release = await turn(d1, "ألغ");
  assert.notEqual(release.surface, "DRIVER_ASSIGNMENT_REVIEW");
});

await focused("F4-16", "several active deliveries: an ambiguous command asks which one", async () => {
  const x = await courierOrder("طاولة س", CITY, { destination: "MANUAL" });
  const y = await courierOrder("طاولة ص", CITY, { destination: "MANUAL" });
  for (const id of [x, y]) {
    const list = await turn(d1, "اعرض لي طلبات توصيل");
    const position = list.driver.work.findIndex((card: any) => card.id === id);
    await turn(d1, `أقبل ${["الأول", "الثاني", "الثالث", "الرابع", "الخامس"][position]}`);
    assert.match((await turn(d1, "نعم")).body, /تم قبول مهمة التوصيل/);
  }
  const ambiguous = await turn(d1, "استلمت الطلب");
  assert.equal(ambiguous.surface, "DRIVER_ASSIGNMENT_STATUS");
  assert.match(ambiguous.body, /أي مهمة تقصد/);
  assert.deepEqual([(await fulfillmentOf(x)).status, (await fulfillmentOf(y)).status], ["ACCEPTED", "ACCEPTED"], "nothing guessed");
  const listed = ambiguous.driver.assignments.map((row: any) => row.orderId);
  const agreement = await agreeCourierFare(listed[1], buyer, d1);
  assert.equal(agreement.amount, "1.000");
  const chosenPickup = await turn(d1, "استلمت الطلب الثاني");
  assert.equal((await fulfillmentOf(listed[1])).status, "ACCEPTED", chosenPickup.body);
  const chosen = await turn(d1, "أنا في الطريق الأول");
  assert.equal((await fulfillmentOf(listed[1])).status, "OUT_FOR_DELIVERY", chosen.body);
  assert.equal((await fulfillmentOf(listed[0])).status, "ACCEPTED");
});

await focused("F4-17", "reload restores profile, review and assignment state from server rows", async () => {
  const history = await request(`/ai/conversations/${d1.conv}`, "GET", undefined, d1.cookie);
  assert.equal(history.status, 200);
  const blocks = history.data.messages.flatMap((message: any) => message.blocks).filter((block: any) => block.payload.driver);
  const review = blocks.find((block: any) => block.payload.surface === "DRIVER_ONBOARDING_REVIEW" && block.payload.driver.status === "CONFIRMED");
  assert.ok(review, "submitted review shows CONFIRMED");
  assert.equal(review.payload.driver.profile.status, "APPROVED", "the stored PENDING profile is re-read as APPROVED");
  const assigned = blocks.filter((block: any) => block.payload.driver.assignments?.length);
  assert.ok(assigned.some((block: any) => block.payload.driver.assignments.some((row: any) => row.orderId === W.b && row.status === "DELIVERED")));
  const status = await turn(d1, "ما حالة تسجيلي كسائق؟");
  assert.match(status.body, /معتمد/);
  assert.match(status.body, /2 مهمة توصيل نشطة/);
});

await focused("F4-18", "driver onboarding and Block C job search stay separate", async () => {
  const seeker = await register("Job Seeker");
  const job = await turn(seeker, "ابحث لي عن وظيفة سائق عند الشركات");
  assert.ok(!job.driver, job.body);
  assert.equal(await profileOf(seeker), undefined, "no driver profile from a job search");
  console.log("F4_JOB_SEARCH", JSON.stringify({ surface: job.surface, employment: Boolean(job.payload.employment) }));
  assert.ok(job.payload.employment, `Block C employment flow: ${job.body}`);
  const candidatesBefore = (await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, seeker.id))).length;
  const driver = await turn(seeker, "أريد أشتغل سائق مع دينار");
  assert.equal(driver.surface, "DRIVER_ONBOARDING");
  assert.equal(driver.payload.employment, undefined);
  assert.equal((await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, seeker.id))).length, candidatesBefore);
});

await focused("F4-19", "no live tracking anywhere in the driver capability", async () => {
  const files = ["src/ai/driver-turn.ts", "src/lib/driver.ts", "src/lib/delivery.ts", "../dinar/src/features/ai/DriverPanel.tsx"];
  const pattern = /watchPosition|getCurrentPosition|BackgroundGeolocation|startLocationUpdates|setInterval\([^)]*(?:position|location)/;
  const hits = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
  const tables = (await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((row: any) => String(row.table_name));
  const movement = tables.filter((name) => /location_history|gps|tracking|route|movement|driver_locations/.test(name));
  const driverColumns = (await db.execute(sql`select column_name from information_schema.columns where table_name in ('driver_profiles', 'delivery_assignments')`)).rows.map((row: any) => String(row.column_name));
  console.log("F4_TRACKING", JSON.stringify({ watchPosition: hits.length, movementTables: movement.length }));
  assert.deepEqual(hits, []);
  assert.deepEqual(movement, []);
  assert.equal(driverColumns.some((name) => /lat|lng|longitude|coordinate/.test(name)), false);
});

await focused("F4-20", "injected failures never produce a success claim", async () => {
  // Profile: the account is deactivated between review and «نعم».
  const late = await register("Late Driver");
  await db.update(users).set({ city: CITY }).where(eq(users.id, late.id));
  await turn(late, "أريد أشتغل سائق بدراجة نارية");
  await db.update(users).set({ status: "RESTRICTED" }).where(eq(users.id, late.id));
  const submit = await turn(late, "نعم");
  assert.doesNotMatch(submit.body, /أُرسل طلب تسجيلك/);
  assert.equal((await profileOf(late))!.status, "DRAFT");
  await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, late.id));
  // Availability for a pending profile; assignment of taken work; handoff before pickup.
  assert.doesNotMatch((await turn(d3, "أنا متاح")).body, /أنت متاح الآن/);
  const open = await courierOrder("طاولة حقن", CITY, { destination: "MANUAL" });
  const list = await turn(d2, "اعرض لي طلبات توصيل");
  const position = list.driver.work.findIndex((card: any) => card.id === open);
  await turn(d2, `أقبل ${["الأول", "الثاني", "الثالث", "الرابع"][position]}`);
  await db.update(orderFulfillments).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(orderFulfillments.orderId, open));
  assert.doesNotMatch((await turn(d2, "نعم")).body, /تم قبول مهمة التوصيل/);
  const ahead = await turn(d2, "تم التسليم");
  assert.doesNotMatch(ahead.body, /^تم التسليم:/);
  console.log("F4_FALSE_SUCCESS", JSON.stringify(falses));
  assert.deepEqual(falses, { profile: 0, approval: 0, availability: 0, assignment: 0, delivered: 0 });
});

await focused("R5-01", "fare requires both confirmations and accrues only after successful courier completion", async () => {
  const orderId = await courierOrder("أجرة R5", CITY, { destination: "MANUAL" });
  await assignDelivery({ actorId: d2.id, orderId, market: JO });
  const prematureDeparture = await startDriverTrip(d2, orderId).then(() => null, (error) => error as any);
  assert.equal(prematureDeparture?.status, 409);
  assert.equal(prematureDeparture?.code, "COURIER_FARE_REQUIRED");

  const idempotencyKey = `r5-repeat-${randomUUID()}`;
  const firstProposal = await request(
    `/orders/${orderId}/courier-fare/proposals`,
    "POST",
    { amount: "1.500", idempotencyKey },
    buyer.cookie,
  );
  assert.equal(firstProposal.status, 200, firstProposal.raw);
  const repeatedProposal = await request(
    `/orders/${orderId}/courier-fare/proposals`,
    "POST",
    { amount: "1.500", idempotencyKey },
    buyer.cookie,
  );
  assert.equal(repeatedProposal.status, 200, repeatedProposal.raw);
  assert.equal(repeatedProposal.data.idempotent, true);
  assert.equal(repeatedProposal.data.proposal.id, firstProposal.data.proposal.id);
  const proposalId = firstProposal.data.proposal.id;

  const sellerConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    seller.cookie,
  );
  assert.equal(sellerConfirmation.status, 404, sellerConfirmation.raw);
  const buyerConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    buyer.cookie,
  );
  assert.equal(buyerConfirmation.status, 200, buyerConfirmation.raw);
  assert.equal(buyerConfirmation.data.agreed, false);
  const courierConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    d2.cookie,
  );
  assert.equal(courierConfirmation.status, 200, courierConfirmation.raw);
  assert.equal(courierConfirmation.data.agreed, true);
  assert.equal(courierConfirmation.data.agreement.amount, "1.500");
  assert.equal(courierConfirmation.data.agreement.estimatedCommission, "0.150");

  const lockedFare = await request(
    `/orders/${orderId}/courier-fare/proposals`,
    "POST",
    { amount: "2.000", idempotencyKey: `r5-locked-${randomUUID()}` },
    buyer.cookie,
  );
  assert.equal(lockedFare.status, 409, lockedFare.raw);
  const fareView = await request(`/orders/${orderId}/courier-fare`, "GET", undefined, buyer.cookie);
  assert.equal(fareView.status, 200, fareView.raw);
  assert.equal(fareView.data.agreement.amount, "1.500");

  await startDriverTrip(d2, orderId);
  await driverHandoff({ actorId: d2.id, orderId, market: JO });
  const completed = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(completed.status, 200, completed.raw);
  const [receivable] = await db
    .select()
    .from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, orderId));
  assert.ok(receivable);
  assert.equal(receivable.courierId, d2.id);
  assert.equal(receivable.amountMinor, 150);
  assert.equal(receivable.currencyCode, "JOD");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.equal(
    await db.transaction((tx) => recordCourierCommissionAccrual(tx, order!, new Date())),
    false,
  );
  assert.equal(
    (await db.select().from(courierCommissionReceivables).where(eq(courierCommissionReceivables.orderId, orderId))).length,
    1,
  );
});

await focused("R5-02", "pickup, seller delivery, cancelled, failed and unfinished orders create no courier debt", async () => {
  const sellerDeliveryId = await courierOrder("توصيل البائع R5", CITY, {
    method: "SELLER_DELIVERY",
    destination: "MANUAL",
  });
  const [sellerDeliveryOrder] = await db.select().from(orders).where(eq(orders.id, sellerDeliveryId));
  assert.equal(
    await db.transaction((tx) =>
      recordCourierCommissionAccrual(tx, sellerDeliveryOrder!, new Date()),
    ),
    false,
  );
  assert.equal(
    (await db.select().from(courierCommissionReceivables).where(eq(courierCommissionReceivables.orderId, sellerDeliveryId))).length,
    0,
  );

  const unfinishedId = await courierOrder("غير مكتمل R5", CITY, { destination: "MANUAL" });
  await assignDelivery({ actorId: d2.id, orderId: unfinishedId, market: JO });
  await agreeCourierFare(unfinishedId, buyer, d2);
  const [unfinishedOrder] = await db.select().from(orders).where(eq(orders.id, unfinishedId));
  assert.equal(
    await db.transaction((tx) => recordCourierCommissionAccrual(tx, unfinishedOrder!, new Date())),
    false,
  );

  const failedId = await courierOrder("فشل R5", CITY, { destination: "MANUAL" });
  await assignDelivery({ actorId: d2.id, orderId: failedId, market: JO });
  await agreeCourierFare(failedId, buyer, d2);
  await startDriverTrip(d2, failedId);
  await db.transaction((tx) =>
    transitionDelivery(
      { actorId: d2.id, orderId: failedId, to: "FAILED", failureReason: "OTHER", market: JO },
      tx,
    ),
  );
  const [failedOrder] = await db.select().from(orders).where(eq(orders.id, failedId));
  assert.equal(
    await db.transaction((tx) => recordCourierCommissionAccrual(tx, failedOrder!, new Date())),
    false,
  );

  const cancelledId = await courierOrder("ملغى R5", CITY, { destination: "MANUAL" });
  await db.transaction((tx) =>
    transitionDelivery({ actorId: buyer.id, orderId: cancelledId, to: "CANCELLED", market: JO }, tx),
  );
  const [cancelledOrder] = await db.select().from(orders).where(eq(orders.id, cancelledId));
  assert.equal(
    await db.transaction((tx) => recordCourierCommissionAccrual(tx, cancelledOrder!, new Date())),
    false,
  );
  assert.deepEqual(
    (
      await db
        .select()
        .from(courierCommissionReceivables)
        .where(
          and(
            eq(courierCommissionReceivables.orderId, failedId),
            eq(courierCommissionReceivables.status, "OUTSTANDING"),
          ),
        )
    ).length,
    0,
  );
});

await focused("R5-03", "ten unpaid completed deliveries stop new work but preserve active trips and simulated settlement", async () => {
  const accountBefore = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(accountBefore.status, 200, accountBefore.raw);
  const initialCount = accountBefore.data.outstandingDeliveryCount as number;
  assert.ok(initialCount < accountBefore.data.holdThreshold, "fixture driver starts below the hold threshold");

  const activeTrip = await courierOrder("رحلة قائمة وقت الإيقاف R5", CITY, { destination: "MANUAL" });
  await assignDelivery({ actorId: d1.id, orderId: activeTrip, market: JO });
  await agreeCourierFare(activeTrip, buyer, d1);

  const completionsToNine = Math.max(0, accountBefore.data.holdThreshold - 1 - initialCount);
  for (let index = 0; index < completionsToNine; index++) {
    const orderId = await courierOrder(`مكتمل R5 ${index + 1}`, CITY, { destination: "MANUAL" });
    await completeCourierOrder(orderId, d1, buyer);
  }
  const belowThreshold = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(belowThreshold.data.outstandingDeliveryCount, accountBefore.data.holdThreshold - 1);
  assert.equal(belowThreshold.data.hold, false, "nine outstanding deliveries do not trigger the hold");
  const finalOrder = await courierOrder("مكتمل R5 عند العتبة", CITY, { destination: "MANUAL" });
  await completeCourierOrder(finalOrder, d1, buyer);

  const held = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(held.status, 200, held.raw);
  assert.equal(held.data.hold, true);
  assert.equal(held.data.outstandingDeliveryCount, accountBefore.data.holdThreshold);
  const heldEarning = held.data.earningsHistory.find((entry: any) => entry.orderId === finalOrder);
  assert.ok(heldEarning, "completed delivery appears in historical earnings");
  assert.equal(heldEarning.receivableStatus, "OUTSTANDING");
  assert.equal(heldEarning.realPaymentVerified, false);
  assert.equal(heldEarning.currencyCode, JO.currencyCode);
  assert.equal(heldEarning.minorUnitScale, JO.minorUnitScale);
  assert.equal(
    heldEarning.courierShareMinor + heldEarning.commissionMinor,
    heldEarning.agreedFareMinor,
    "commission and courier share preserve the agreed fare snapshot",
  );
  const work = await listDeliveryWork({ userId: d1.id, market: JO, city: CITY });
  assert.deepEqual(work.cards, []);
  assert.match(work.blocked ?? "", /عمولة جاسم مستحقة/);
  assert.equal((await assignmentsFor(activeTrip)).length, 1, "the already accepted trip remains assigned");

  const d2Profile = (await profileOf(d2))!;
  await setDriverAvailability({ userId: d2.id, market: JO, availability: "UNAVAILABLE" });
  try {
    const debtProbeId = await simpleOrder(buyer, "فحص حجز العمولة W6-09", "DELIVERY", CITY);
    const [debtProbe] = await db.select().from(orders).where(eq(orders.id, debtProbeId));
    assert.equal(await hasEligibleCourierSupply(debtProbe!), false, "the only matching approved courier is on the commission hold");
    results["W6-09"] = "PASS";
  } finally {
    await setDriverAvailability({ userId: d2.id, market: JO, availability: "AVAILABLE" });
  }

  const rejectedOrder = await courierOrder("طلب جديد عند الإيقاف R5", CITY, { destination: "MANUAL" });
  const rejected = await assignDelivery({ actorId: d1.id, orderId: rejectedOrder, market: JO })
    .then(() => null, (error) => error as any);
  assert.equal(rejected?.status, 409);
  assert.equal(rejected?.code, "COMMISSION_HOLD");

  await startDriverTrip(d1, activeTrip);
  await driverHandoff({ actorId: d1.id, orderId: activeTrip, market: JO });
  const activeTripCompleted = await request(
    `/orders/${activeTrip}/confirm`,
    "POST",
    { received: true },
    buyer.cookie,
  );
  assert.equal(activeTripCompleted.status, 200, activeTripCompleted.raw);
  const stillHeld = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(stillHeld.data.hold, true);
  assert.equal(stillHeld.data.outstandingDeliveryCount, accountBefore.data.holdThreshold + 1);

  const idempotencyKey = `r5-settlement-${randomUUID()}`;
  const settlementBody = {
    marketId: JO.id,
    currencyCode: JO.currencyCode,
    idempotencyKey,
  };
  const jodOutstanding = await db.select().from(courierCommissionReceivables)
    .where(and(
      eq(courierCommissionReceivables.courierId, d1.id),
      eq(courierCommissionReceivables.marketId, JO.id),
      eq(courierCommissionReceivables.status, "OUTSTANDING"),
    ));
  const expectedJodSettlement = jodOutstanding.reduce((sum, row) => sum + row.amountMinor, 0);
  const settlement = await request(
    "/courier/commission-account/settlements",
    "POST",
    settlementBody,
    d1.cookie,
  );
  assert.equal(settlement.status, 200, settlement.raw);
  assert.equal(settlement.data.realMoneyTransferred, false);
  assert.equal(settlement.data.settlement.mode, "SIMULATION_ONLY");
  assert.equal(settlement.data.settlement.currencyCode, JO.currencyCode);
  assert.equal(settlement.data.settlement.minorUnitScale, JO.minorUnitScale);
  assert.equal(settlement.data.settlement.amountMinor, expectedJodSettlement);
  const repeatedSettlement = await request(
    "/courier/commission-account/settlements",
    "POST",
    settlementBody,
    d1.cookie,
  );
  assert.equal(repeatedSettlement.status, 200, repeatedSettlement.raw);
  assert.equal(repeatedSettlement.data.idempotent, true);
  assert.equal(repeatedSettlement.data.settlement.id, settlement.data.settlement.id);
  const cleared = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(cleared.status, 200, cleared.raw);
  assert.equal(cleared.data.hold, false);
  assert.equal(cleared.data.outstandingDeliveryCount, 0);
  assert.deepEqual(cleared.data.balances, []);
  const clearedEarning = cleared.data.earningsHistory.find((entry: any) => entry.orderId === finalOrder);
  assert.equal(clearedEarning.receivableStatus, "SIMULATION_CLEARED");
  assert.equal(clearedEarning.settlementMode, "SIMULATION_ONLY");
  assert.equal(clearedEarning.realPaymentVerified, false);

  const orderAfterSettlement = await courierOrder("قبول بعد التسوية R5", CITY, { destination: "MANUAL" });
  await assignDelivery({ actorId: d1.id, orderId: orderAfterSettlement, market: JO });
  assert.equal((await assignmentsFor(orderAfterSettlement)).length, 1);
});

await focused("R5-04", "settlement authorization is bound to the courier and active market", async () => {
  const orderId = await courierOrder("عزل تسوية R5", CITY, { destination: "MANUAL" });
  await completeCourierOrder(orderId, d1, buyer);
  const [receivable] = await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, orderId));
  assert.ok(receivable);
  assert.equal(receivable.amountMinor, 100);
  const key = `r5-auth-${randomUUID()}`;
  const body = { marketId: JO.id, currencyCode: JO.currencyCode, idempotencyKey: key };
  const before = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(before.data.courierId, d1.id);
  assert.equal(before.data.balances.find((balance: any) => balance.marketId === JO.id).amount, "0.100");
  assert.deepEqual(Object.keys(before.data).sort(), [
    "balances", "courierId", "hold", "holdThreshold", "outstandingDeliveryCount",
    "realMoneyTransferred", "settlementMode", "earningsHistory",
  ].sort());
  assert.deepEqual(Object.keys(before.data.balances[0]).sort(), [
    "amount", "amountMinor", "currencyCode", "deliveryCount", "marketId", "minorUnitScale",
  ].sort());

  assert.equal((await request("/courier/commission-account/settlements", "POST", body)).status, 401);
  for (const nonCourier of [buyer, seller]) {
    const denied = await request("/courier/commission-account/settlements", "POST", body, nonCourier.cookie);
    assert.equal(denied.status, 403, denied.raw);
  }
  const otherCourier = await request("/courier/commission-account/settlements", "POST", body, d2.cookie);
  assert.equal(otherCourier.status, 200, otherCourier.raw);
  assert.equal(otherCourier.data.settlement.courierId, d2.id);
  assert.equal(
    (await db.select().from(courierCommissionReceivables).where(eq(courierCommissionReceivables.id, receivable.id)))[0]!.status,
    "OUTSTANDING",
    "another courier cannot clear this receivable",
  );
  const isolatedAccount = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(isolatedAccount.data.courierId, d1.id);
  assert.equal(JSON.stringify(isolatedAccount.data).includes(d2.id), false);
  assert.equal(JSON.stringify(isolatedAccount.data).includes(orderId), true);

  const wrongMarket = await request(
    "/courier/commission-account/settlements",
    "POST",
    { ...body, marketId: KW.id, currencyCode: KW.currencyCode },
    d1.cookie,
  );
  assert.equal(wrongMarket.status, 403, wrongMarket.raw);
  const wrongCurrency = await request(
    "/courier/commission-account/settlements",
    "POST",
    { ...body, currencyCode: KW.currencyCode },
    d1.cookie,
  );
  assert.equal(wrongCurrency.status, 409, wrongCurrency.raw);
  await db.update(users).set({ activeMarketId: KW.id }).where(eq(users.id, d1.id));
  try {
    const staleMarket = await request("/courier/commission-account/settlements", "POST", body, d1.cookie);
    assert.equal(staleMarket.status, 403, staleMarket.raw);
  } finally {
    await db.update(users).set({ activeMarketId: JO.id }).where(eq(users.id, d1.id));
  }
  await db.update(markets).set({ isActive: false, status: "COMING_SOON" }).where(eq(markets.id, JO.id));
  try {
    const inactiveMarket = await request("/courier/commission-account/settlements", "POST", body, d1.cookie);
    assert.equal(inactiveMarket.status, 409, inactiveMarket.raw);
  } finally {
    await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, JO.id));
  }

  const mismatchedSnapshot = await db.update(courierCommissionReceivables)
    .set({ minorUnitScale: receivable.minorUnitScale - 1 })
    .where(eq(courierCommissionReceivables.id, receivable.id))
    .returning();
  assert.equal(mismatchedSnapshot.length, 1);
  const rejectedScale = await request("/courier/commission-account/settlements", "POST", body, d1.cookie);
  assert.equal(rejectedScale.status, 409, rejectedScale.raw);
  await db.update(courierCommissionReceivables)
    .set({ minorUnitScale: receivable.minorUnitScale })
    .where(eq(courierCommissionReceivables.id, receivable.id));
  await db.update(courierCommissionReceivables)
    .set({ currencyCode: KW.currencyCode })
    .where(eq(courierCommissionReceivables.id, receivable.id));
  const rejectedCurrencySnapshot = await request("/courier/commission-account/settlements", "POST", body, d1.cookie);
  assert.equal(rejectedCurrencySnapshot.status, 409, rejectedCurrencySnapshot.raw);
  await db.update(courierCommissionReceivables)
    .set({ currencyCode: JO.currencyCode })
    .where(eq(courierCommissionReceivables.id, receivable.id));
  const accountAfterAttacks = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(accountAfterAttacks.data.balances.find((balance: any) => balance.marketId === JO.id).amount, "0.100");
});

await focused("R5-05", "simultaneous settlement requests clear each eligible receivable at most once", async () => {
  const sameKeyOrder = await courierOrder("تزامن المفتاح نفسه R5", CITY, { destination: "MANUAL" });
  await completeCourierOrder(sameKeyOrder, d1, buyer);
  const sameKey = `r5-same-${randomUUID()}`;
  const sameBody = { marketId: JO.id, currencyCode: JO.currencyCode, idempotencyKey: sameKey };
  const [sameA, sameB] = await Promise.all([
    request("/courier/commission-account/settlements", "POST", sameBody, d1.cookie),
    request("/courier/commission-account/settlements", "POST", sameBody, d1.cookie),
  ]);
  assert.equal(sameA.status, 200, sameA.raw);
  assert.equal(sameB.status, 200, sameB.raw);
  assert.equal(sameA.data.settlement.id, sameB.data.settlement.id);
  assert.equal(
    (await db.select().from(courierCommissionSettlements)
      .where(eq(courierCommissionSettlements.idempotencyKey, sameKey))).length,
    1,
  );
  const changedPayload = await request(
    "/courier/commission-account/settlements",
    "POST",
    { ...sameBody, currencyCode: KW.currencyCode },
    d1.cookie,
  );
  assert.equal(changedPayload.status, 409, changedPayload.raw);

  const differentKeysOrder = await courierOrder("تزامن مفتاحين R5", CITY, { destination: "MANUAL" });
  await completeCourierOrder(differentKeysOrder, d1, buyer);
  const different = await Promise.all([
    request("/courier/commission-account/settlements", "POST",
      { marketId: JO.id, currencyCode: JO.currencyCode, idempotencyKey: `r5-race-a-${randomUUID()}` }, d1.cookie),
    request("/courier/commission-account/settlements", "POST",
      { marketId: JO.id, currencyCode: JO.currencyCode, idempotencyKey: `r5-race-b-${randomUUID()}` }, d1.cookie),
  ]);
  assert.deepEqual(different.map((response) => response.status).sort(), [200, 409]);
  const raceReceivable = (await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, differentKeysOrder)))[0]!;
  assert.equal(raceReceivable.status, "SIMULATION_CLEARED");
  assert.ok(raceReceivable.settlementId);
  assert.equal(
    (await db.select().from(courierCommissionSettlements)
      .where(eq(courierCommissionSettlements.id, raceReceivable.settlementId!))).length,
    1,
  );

  const marketRaceOrder = await courierOrder("سباق سوقين R5", CITY, { destination: "MANUAL" });
  await completeCourierOrder(marketRaceOrder, d1, buyer);
  const [marketRaceReceivable] = await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, marketRaceOrder));
  const [authorized, otherMarket] = await Promise.all([
    request("/courier/commission-account/settlements", "POST",
      { marketId: JO.id, currencyCode: JO.currencyCode, idempotencyKey: `r5-market-a-${randomUUID()}` }, d1.cookie),
    request("/courier/commission-account/settlements", "POST",
      { marketId: KW.id, currencyCode: KW.currencyCode, idempotencyKey: `r5-market-b-${randomUUID()}` }, d1.cookie),
  ]);
  assert.equal(authorized.status, 200, authorized.raw);
  assert.equal(otherMarket.status, 403, otherMarket.raw);
  assert.equal(
    (await db.select().from(courierCommissionReceivables)
      .where(eq(courierCommissionReceivables.id, marketRaceReceivable.id)))[0]!.settlementId,
    authorized.data.settlement.id,
  );
  assert.equal(
    (await db.select().from(courierCommissionSettlements)
      .where(and(eq(courierCommissionSettlements.courierId, d1.id), eq(courierCommissionSettlements.marketId, KW.id)))).length,
    0,
  );
});

await focused("R5-06", "released courier fare history stays isolated from replacement commission accrual", async () => {
  const orderId = await courierOrder("استبدال المندوب R5", CITY, { destination: "MANUAL" });
  await assignDelivery({ actorId: d1.id, orderId, market: JO });
  const oldAgreement = await agreeCourierFare(orderId, buyer, d1, "1.500");
  const oldAssignment = (await assignmentsFor(orderId))[0]!;
  const revoked = await revokeCourierAssignment({
    adminId: admin.id,
    orderId,
    market: JO,
    reason: "REPLACEMENT_TEST",
    idempotencyKey: `r5-revoke-${randomUUID()}`,
  });
  assert.equal(revoked.assignmentId, oldAssignment.id);
  assert.equal((await db.select().from(deliveryAssignments)
    .where(eq(deliveryAssignments.id, oldAssignment.id)))[0]!.status, "RELEASED");
  assert.equal((await db.select().from(courierFareAgreements)
    .where(eq(courierFareAgreements.id, oldAgreement.id))).length, 1, "released fare agreement is preserved");

  await db.transaction((tx) => selectDeliveryMethod({ actorId: buyer.id, orderId, method: "COURIER", market: JO }, tx));
  await db.transaction((tx) => attachTransactionLocation({
    actorId: buyer.id,
    orderId,
    purpose: "DELIVERY_DESTINATION",
    location: { source: "MANUAL", city: CITY, area: "الصويفية", addressText: SECRET_ADDRESS },
    market: JO,
  }, tx));
  await assignDelivery({ actorId: d2.id, orderId, market: JO });
  const replacementAgreement = await agreeCourierFare(orderId, buyer, d2, "2.000");
  await startDriverTrip(d2, orderId);
  await driverHandoff({ actorId: d2.id, orderId, market: JO });
  const received = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, buyer.cookie);
  assert.equal(received.status, 200, received.raw);
  const [receivable] = await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, orderId));
  assert.equal(receivable.courierId, d2.id);
  assert.equal(receivable.agreementId, replacementAgreement.id);
  assert.equal(receivable.amountMinor, 200);
  assert.equal((await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.courierId, d1.id)).then((rows) =>
      rows.filter((row) => row.orderId === orderId))).length, 0);
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  assert.equal(await db.transaction((tx) => recordCourierCommissionAccrual(tx, order!, new Date())), false);
  assert.equal((await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, orderId))).length, 1);
});

await focused("R5-07", "SAR and KWD isolated test markets accrue and settle at canonical scales", async () => {
  const testMarkets = [
    { id: "R5_SAR", countryCode: "QX", currencyCode: "SAR", minorUnitScale: 2, fare: "1.23", fareMinor: 123, commissionMinor: 12 },
    { id: "R5_KWD", countryCode: "QY", currencyCode: "KWD", minorUnitScale: 3, fare: "1.234", fareMinor: 1234, commissionMinor: 123 },
  ];
  try {
  for (const fixture of testMarkets) {
    const marketRow = {
      id: fixture.id,
      countryCode: fixture.countryCode,
      countryNameAr: "سوق اختبار معزول",
      countryNameEn: "Isolated test market",
      currencyCode: fixture.currencyCode,
      currencySymbolAr: fixture.currencyCode,
      unitPriceMinor: 1000,
      minorUnitScale: fixture.minorUnitScale,
      isActive: true,
      status: "ACTIVE",
      fulfilmentMethods: ["PICKUP", "DELIVERY", "COURIER"],
      paymentMethods: ["CASH_DIRECT"],
      restrictedCategories: [],
      sellerEligibilityMode: "OPEN",
    };
    await db.insert(markets).values(marketRow);
    const market = await resolveMarket(marketRow as any);
    await db.update(users).set({ activeMarketId: market.id })
      .where(inArray(users.id, [seller.id, buyer.id, d1.id]));
    await db.insert(driverProfiles).values({
      id: randomUUID(),
      userId: d1.id,
      marketId: market.id,
      status: "APPROVED",
      availability: "AVAILABLE",
      vehicleType: "CAR",
      serviceCity: CITY,
      reviewedBy: admin.id,
    });
    const orderId = await courierOrder(`دقة ${fixture.currencyCode}`, CITY, {
      destination: "MANUAL",
      market,
    });
    const agreement = await completeCourierOrder(orderId, d1, buyer, fixture.fare, market);
    assert.equal(agreement.currencyCode, fixture.currencyCode);
    assert.equal(agreement.minorUnitScale, fixture.minorUnitScale);
    assert.equal(agreement.fareMinor, fixture.fareMinor);
    const [receivable] = await db.select().from(courierCommissionReceivables)
      .where(eq(courierCommissionReceivables.orderId, orderId));
    assert.equal(receivable.amountMinor, fixture.commissionMinor);
    assert.equal(receivable.currencyCode, fixture.currencyCode);
    assert.equal(receivable.minorUnitScale, fixture.minorUnitScale);
    const key = `r5-currency-${fixture.currencyCode}-${randomUUID()}`;
    const settlement = await request("/courier/commission-account/settlements", "POST", {
      marketId: market.id,
      currencyCode: fixture.currencyCode,
      idempotencyKey: key,
    }, d1.cookie);
    assert.equal(settlement.status, 200, settlement.raw);
    assert.equal(settlement.data.settlement.amountMinor, fixture.commissionMinor);
    assert.equal(settlement.data.settlement.minorUnitScale, fixture.minorUnitScale);
    assert.equal(settlement.data.settlement.realMoneyTransferred, undefined);
    assert.equal(settlement.data.realMoneyTransferred, false);
    const remaining = await request("/courier/commission-account", "GET", undefined, d1.cookie);
    assert.equal(remaining.data.balances.some((balance: any) => balance.marketId === market.id), false);
    await db.update(users).set({ activeMarketId: JO.id })
      .where(inArray(users.id, [seller.id, buyer.id, d1.id]));
  }
  } finally {
    await db.update(users).set({ activeMarketId: JO.id })
      .where(inArray(users.id, [seller.id, buyer.id, d1.id]));
  }
});

await focused("R5-08", "ten unsettled deliveries across markets trigger the account-wide hold without cross-market clearing", async () => {
  const initial = await request("/courier/commission-account", "GET", undefined, d1.cookie);
  assert.equal(initial.data.outstandingDeliveryCount, 0);
  for (let index = 0; index < 9; index++) {
    const orderId = await courierOrder(`حجز متعدد الأسواق ${index + 1}`, CITY, { destination: "MANUAL" });
    await completeCourierOrder(orderId, d1, buyer);
  }
  const [holdMarketRow] = await db.insert(markets).values({
    id: "R5_HOLD_KWD",
    countryCode: "QZ",
    countryNameAr: "سوق حجز اختبار",
    countryNameEn: "Hold test market",
    currencyCode: "KWD",
    currencySymbolAr: "KWD",
    unitPriceMinor: 1000,
    minorUnitScale: 3,
    isActive: true,
    status: "ACTIVE",
    fulfilmentMethods: ["PICKUP", "DELIVERY", "COURIER"],
    paymentMethods: ["CASH_DIRECT"],
    restrictedCategories: [],
    sellerEligibilityMode: "OPEN",
  }).returning();
  const holdMarket = await resolveMarket(holdMarketRow!);
  await db.insert(driverProfiles).values({
    id: randomUUID(), userId: d1.id, marketId: holdMarket.id, status: "APPROVED",
    availability: "AVAILABLE", vehicleType: "CAR", serviceCity: CITY, reviewedBy: admin.id,
  });
  await db.update(users).set({ activeMarketId: holdMarket.id })
    .where(inArray(users.id, [seller.id, buyer.id, d1.id]));
  try {
    const crossMarketOrder = await courierOrder("العاشر في سوق آخر", CITY, {
      destination: "MANUAL",
      market: holdMarket,
    });
    await completeCourierOrder(crossMarketOrder, d1, buyer, "1.234", holdMarket);
    const held = await request("/courier/commission-account", "GET", undefined, d1.cookie);
    assert.equal(held.data.outstandingDeliveryCount, 10);
    assert.equal(held.data.hold, true);
    assert.equal(held.data.balances.find((balance: any) => balance.marketId === JO.id).deliveryCount, 9);
    assert.equal(held.data.balances.find((balance: any) => balance.marketId === holdMarket.id).deliveryCount, 1);

    const clearedKwd = await request("/courier/commission-account/settlements", "POST", {
      marketId: holdMarket.id,
      currencyCode: holdMarket.currencyCode,
      idempotencyKey: `r5-hold-kwd-${randomUUID()}`,
    }, d1.cookie);
    assert.equal(clearedKwd.status, 200, clearedKwd.raw);
    const nineRemain = await request("/courier/commission-account", "GET", undefined, d1.cookie);
    assert.equal(nineRemain.data.outstandingDeliveryCount, 9);
    assert.equal(nineRemain.data.hold, false);
    assert.equal(nineRemain.data.balances.length, 1);
    assert.equal(nineRemain.data.balances[0].marketId, JO.id);
    assert.equal(nineRemain.data.balances[0].deliveryCount, 9);
  } finally {
    await db.update(users).set({ activeMarketId: JO.id })
      .where(inArray(users.id, [seller.id, buyer.id, d1.id]));
  }
  const clearedJod = await request("/courier/commission-account/settlements", "POST", {
    marketId: JO.id,
    currencyCode: JO.currencyCode,
    idempotencyKey: `r5-hold-jod-${randomUUID()}`,
  }, d1.cookie);
  assert.equal(clearedJod.status, 200, clearedJod.raw);
});

let w6ExactBuyer: Actor;
let w6ExactOrderId: string;
await focused("W6-01", "the buyer's courier request resolves their single owned canonical order without selecting it", async () => {
  w6ExactBuyer = await register("W6 exact-order buyer");
  w6ExactOrderId = await simpleOrder(w6ExactBuyer, "طلب W6 المحدد", "DELIVERY", CITY);
  const response = await turn(w6ExactBuyer, "دينار أبي مندوب يوصل طلبي");
  assert.match(response.body, /مندوب|طلب/);
  assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, w6ExactOrderId))).length, 0, "availability discovery is not a fulfillment mutation");
});

await focused("W6-02", "multiple owned orders require clarification before courier selection", async () => {
  const actor = await register("W6 ambiguous buyer");
  const first = await simpleOrder(actor, "الأول W6", "DELIVERY", CITY);
  const second = await simpleOrder(actor, "الثاني W6", "DELIVERY", CITY);
  const response = await turn(actor, "دينار أبي مندوب يوصل طلبي");
  assert.equal(response.payload.surface, "ORDERS", JSON.stringify(response.payload));
  assert.deepEqual(new Set(response.payload.resourceIds), new Set([first, second]));
  assert.equal((await db.select().from(orderFulfillments).where(inArray(orderFulfillments.orderId, [first, second]))).length, 0);
});

await focused("W6-03", "pickup remains available only for an order whose snapshot and market allow it", async () => {
  const actor = await register("W6 pickup buyer");
  const orderId = await simpleOrder(actor, "استلام W6", "PICKUP", CITY);
  const view = await getDeliveryView({ actorId: actor.id, orderId, market: JO });
  assert.equal(view.options.find((item) => item.method === "PICKUP")?.available, true);
  assert.equal(view.options.find((item) => item.method === "COURIER")?.available, false);
});

await focused("W6-04", "seller delivery follows the order's delivery capability", async () => {
  const actor = await register("W6 seller-delivery buyer");
  const orderId = await simpleOrder(actor, "توصيل البائع W6", "DELIVERY", CITY);
  const view = await getDeliveryView({ actorId: actor.id, orderId, market: JO });
  assert.equal(view.options.find((item) => item.method === "SELLER_DELIVERY")?.available, true);
});

await focused("W6-05", "real approved available in-market courier supply enables the courier option", async () => {
  const [order] = await db.select().from(orders).where(eq(orders.id, w6ExactOrderId));
  assert.equal(await hasEligibleCourierSupply(order!), true);
  assert.equal((await getDeliveryView({ actorId: w6ExactBuyer.id, orderId: w6ExactOrderId, market: JO })).options.find((item) => item.method === "COURIER")?.available, true);
});

await focused("W6-06", "zero matching couriers leaves the courier option explicitly unavailable", async () => {
  const actor = await register("W6 no-supply buyer");
  const orderId = await simpleOrder(actor, "مدينة بلا مندوب W6", "DELIVERY", OTHER);
  const view = await getDeliveryView({ actorId: actor.id, orderId, market: JO });
  const option = view.options.find((item) => item.method === "COURIER")!;
  assert.equal(option.available, false);
  assert.match(option.reason ?? "", /مندوب/);
});

await focused("W6-07", "an unapproved driver does not count as supply", async () => {
  const actor = await register("W6 unapproved-only buyer");
  const orderId = await simpleOrder(actor, "منطقة السائق غير المعتمد W6", "DELIVERY", OTHER);
  const pending = (await profileOf(d3))!;
  await db.update(driverProfiles).set({ serviceCity: OTHER }).where(eq(driverProfiles.id, pending.id));
  try {
    assert.equal(await hasEligibleCourierSupply((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!), false);
  } finally {
    await db.update(driverProfiles).set({ serviceCity: CITY }).where(eq(driverProfiles.id, pending.id));
  }
});

await focused("W6-08", "wrong-market and out-of-area drivers do not count as supply", async () => {
  const actor = await register("W6 wrong-market buyer");
  const orderId = await simpleOrder(actor, "تغطية سوق خاطئ W6", "DELIVERY", OTHER);
  const profile = (await profileOf(d2))!;
  await db.update(driverProfiles).set({ serviceCity: OTHER }).where(eq(driverProfiles.id, profile.id));
  await db.update(users).set({ activeMarketId: "KW" }).where(eq(users.id, d2.id));
  try {
    assert.equal(await hasEligibleCourierSupply((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!), false);
  } finally {
    await db.update(driverProfiles).set({ serviceCity: CITY }).where(eq(driverProfiles.id, profile.id));
    await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, d2.id));
  }
});

await focused("W6-10", "checking availability is read-only and does not reserve or mutate fulfillment", async () => {
  const before = await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, w6ExactOrderId));
  assert.equal(await hasEligibleCourierSupply((await db.select().from(orders).where(eq(orders.id, w6ExactOrderId)))[0]!), true);
  await getDeliveryView({ actorId: w6ExactBuyer.id, orderId: w6ExactOrderId, market: JO });
  const after = await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, w6ExactOrderId));
  assert.deepEqual(after, before);
});

await focused("W6-11", "courier supply disappearing before confirmation creates no fulfillment", async () => {
  const actor = await register("W6 stale-supply buyer");
  const orderId = await simpleOrder(actor, "اختفاء المندوب W6", "DELIVERY", CITY);
  const preview = await turn(actor, "دينار أبي مندوب يوصل طلبي");
  assert.match(preview.body, /مندوب|طلب/);
  const d1Profile = (await profileOf(d1))!;
  const d2Profile = (await profileOf(d2))!;
  await setDriverAvailability({ userId: d1.id, market: JO, availability: "UNAVAILABLE" });
  await setDriverAvailability({ userId: d2.id, market: JO, availability: "UNAVAILABLE" });
  try {
    await turn(actor, "نعم");
    assert.equal((await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId))).length, 0);
    assert.equal((await assignmentsFor(orderId)).length, 0);
  } finally {
    if (d1Profile.status === "APPROVED") await setDriverAvailability({ userId: d1.id, market: JO, availability: "AVAILABLE" });
    if (d2Profile.status === "APPROVED") await setDriverAvailability({ userId: d2.id, market: JO, availability: "AVAILABLE" });
  }
});

await focused("W6-12", "availability results expose no courier identity, phone, or precise location", async () => {
  const view = await getDeliveryView({ actorId: w6ExactBuyer.id, orderId: w6ExactOrderId, market: JO });
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, new RegExp(d1.id));
  assert.doesNotMatch(serialized, new RegExp(d2.id));
  assert.doesNotMatch(serialized, new RegExp(d1.phone));
  assert.doesNotMatch(serialized, new RegExp(SECRET_ADDRESS));
  assert.doesNotMatch(serialized, new RegExp(String(SECRET_LAT)));
});

await focused("W6-13", "admin revocation before pickup preserves the order and immediately removes former-courier access", async () => {
  const orderId = await courierOrder("إلغاء إسناد قبل الاستلام W6.2", CITY);
  await assignDelivery({ actorId: d2.id, orderId, market: JO });
  const before = await request(`/orders/${orderId}/fulfillment`, "GET", undefined, d2.cookie);
  assert.equal(before.status, 200, before.raw);
  assert.match(before.cacheControl, /no-store/);
  assert.equal(before.data.destination.addressText, SECRET_ADDRESS);
  const [active] = await assignmentsFor(orderId);
  const revokeBody = {
    reason: "تعذر التواصل مع المندوب قبل الاستلام",
    idempotencyKey: `w62-revoke-${randomUUID()}`,
  };
  const replays = await Promise.all([
    request(`/admin/orders/${orderId}/courier-assignment/revoke`, "POST", revokeBody, admin.cookie),
    request(`/admin/orders/${orderId}/courier-assignment/revoke`, "POST", revokeBody, admin.cookie),
  ]);
  assert.deepEqual(replays.map((result) => result.status), [200, 200]);
  assert.deepEqual(replays.map((result) => result.data.idempotent).sort(), [false, true]);
  const revoked = replays.find((result) => result.data.idempotent === false)!;
  assert.equal(revoked.data.assignmentId, active!.id);
  assert.equal((await fulfillmentOf(orderId)).status, "FAILED");
  assert.equal((await assignmentsFor(orderId)).length, 0);
  assert.equal((await db.select().from(deliveryAssignments).where(eq(deliveryAssignments.id, active!.id)))[0]!.status, "RELEASED");
  assert.equal((await db.select().from(transactionLocations).where(and(
    eq(transactionLocations.orderId, orderId),
    eq(transactionLocations.purpose, "DELIVERY_DESTINATION"),
  ))).length, 0);
  const staleLocationRead = await request(`/orders/${orderId}/fulfillment`, "GET", undefined, d2.cookie);
  assert.equal(staleLocationRead.status, 404, staleLocationRead.raw);
  const staleFareRead = await request(`/orders/${orderId}/courier-fare`, "GET", undefined, d2.cookie);
  assert.equal(staleFareRead.status, 404, staleFareRead.raw);
  const buyerView = await getDeliveryView({ actorId: buyer.id, orderId, market: JO });
  assert.equal(buyerView.canSelectMethod, true);
  assert.equal((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status, "ACCEPTED");
});

await focused("W6-14", "an assignment already out for delivery cannot be revoked or reassigned", async () => {
  const orderId = await courierOrder("رفض النقل بعد الاستلام W6.2", CITY);
  await assignDelivery({ actorId: d2.id, orderId, market: JO });
  await agreeCourierFare(orderId, buyer, d2);
  await startDriverTrip(d2, orderId);
  const attempted = await request(`/admin/orders/${orderId}/courier-assignment/revoke`, "POST", {
    reason: "طلب إداري لنقل المهمة",
    idempotencyKey: `w62-custody-${randomUUID()}`,
  }, admin.cookie);
  assert.equal(attempted.status, 409, attempted.raw);
  assert.match(attempted.data.error, /حيازة المندوب/);
  assert.equal((await fulfillmentOf(orderId)).status, "OUT_FOR_DELIVERY");
  assert.equal((await assignmentsFor(orderId)).length, 1);
});

await focused("W6-15", "a courier can withdraw before pickup through the conversation and the buyer must arrange delivery again", async () => {
  const city = `مدينة انسحاب ${runId}`;
  const profile = (await profileOf(d3))!;
  await db.update(users).set({ city }).where(eq(users.id, d3.id));
  await db.update(driverProfiles).set({ serviceCity: city }).where(eq(driverProfiles.id, profile.id));
  if (profile.status !== "APPROVED")
    await reviewDriverProfile({ adminId: admin.id, profileId: profile.id, decision: "APPROVE" });
  await setDriverAvailability({ userId: d3.id, market: JO, availability: "AVAILABLE" });
  const withdrawalBuyer = await register("W6.2 voluntary withdrawal buyer");
  const orderId = await courierOrder("طلب انسحاب المندوب", city, { buyerActor: withdrawalBuyer });
  const work = await turn(d3, "اعرض لي طلبات توصيل");
  const position = work.driver.work.findIndex((card: any) => card.id === orderId);
  assert.ok(position >= 0 && position < 5, JSON.stringify(work.driver.work));
  const ordinal = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس"][position]!;
  await turn(d3, `أقبل ${ordinal}`);
  const accepted = await turn(d3, "نعم");
  assert.match(accepted.body, /تم قبول مهمة التوصيل/);
  await agreeCourierFare(orderId, withdrawalBuyer, d3, "1.500");
  const withdrawn = await turn(d3, "لا أستطيع التوصيل");
  assert.match(withdrawn.body, /أُعيدت المهمة/);
  assert.equal((await fulfillmentOf(orderId)).status, "FAILED");
  assert.equal((await assignmentsFor(orderId)).length, 0);
  assert.equal((await request(`/orders/${orderId}/fulfillment`, "GET", undefined, d3.cookie)).status, 404);
  const staleReactivation = await assignDelivery({ actorId: d3.id, orderId, market: JO }).then(
    () => null,
    (error) => error as any,
  );
  assert.equal(staleReactivation?.status, 409, "a released courier cannot reactivate their old assignment");
  const retry = await turn(withdrawalBuyer, "أبي مندوب غيره");
  assert.equal(retry.payload.surface, "DELIVERY_SUMMARY", JSON.stringify(retry.payload));
  assert.equal((await fulfillmentOf(orderId)).status, "FAILED", "a new courier is not assigned before buyer confirmation");
  const confirmedRetry = await turn(withdrawalBuyer, "نعم");
  assert.equal(confirmedRetry.payload.surface, "LOCATION_PERMISSION_REQUEST", JSON.stringify(confirmedRetry.payload));
  assert.equal((await fulfillmentOf(orderId)).status, "REQUESTED");
  assert.equal((await assignmentsFor(orderId)).length, 0);
  await db.transaction((tx) => attachTransactionLocation({
    actorId: withdrawalBuyer.id,
    orderId,
    purpose: "DELIVERY_DESTINATION",
    location: { source: "MANUAL", city, area: "وسط المدينة", addressText: `عنوان جديد ${runId}` },
    market: JO,
  }, tx));
  const replacementProfile = (await profileOf(d2))!;
  await db.update(driverProfiles).set({ serviceCity: city }).where(eq(driverProfiles.id, replacementProfile.id));
  await assignDelivery({ actorId: d2.id, orderId, market: JO });
  const replacementFare = await request(`/orders/${orderId}/courier-fare`, "GET", undefined, d2.cookie);
  assert.equal(replacementFare.status, 200, replacementFare.raw);
  assert.equal(replacementFare.data.agreement, null, "the withdrawn courier's agreed fee does not transfer");
  assert.equal(replacementFare.data.proposal, null);
  assert.equal((await request(`/orders/${orderId}/courier-fare`, "GET", undefined, d3.cookie)).status, 404);
  assert.equal((await db.select().from(courierCommissionReceivables).where(eq(courierCommissionReceivables.orderId, orderId))).length, 0);
  const replacementAgreement = await agreeCourierFare(orderId, withdrawalBuyer, d2, "2.250");
  assert.equal(replacementAgreement.amount, "2.250");
  const agreements = await db.select().from(courierFareAgreements).where(eq(courierFareAgreements.orderId, orderId));
  assert.equal(agreements.length, 2, "the historical and replacement assignments retain separate fare snapshots");
  assert.equal(new Set(agreements.map((agreement) => agreement.assignmentId)).size, 2);
  const historicalAgreement = agreements.find((agreement) => agreement.courierId === d3.id)!;
  assert.equal(historicalAgreement.fareMinor, 1500);
  assert.equal(historicalAgreement.commissionEstimateMinor, 150);
  await startDriverTrip(d2, orderId);
  await driverHandoff({ actorId: d2.id, orderId, market: JO });
  const received = await request(`/orders/${orderId}/confirm`, "POST", { received: true }, withdrawalBuyer.cookie);
  assert.equal(received.status, 200, received.raw);
  const replacementReceivables = await db.select().from(courierCommissionReceivables).where(eq(courierCommissionReceivables.orderId, orderId));
  assert.equal(replacementReceivables.length, 1);
  assert.equal(replacementReceivables[0].courierId, d2.id);
  assert.equal(replacementReceivables[0].amountMinor, 225);
  await db.update(driverProfiles).set({ serviceCity: replacementProfile.serviceCity }).where(eq(driverProfiles.id, replacementProfile.id));
});

await focused("W6-16", "suspending a courier releases pre-pickup work and revokes its private read access", async () => {
  const orderId = await courierOrder("إيقاف المندوب قبل الاستلام W6.2", CITY);
  const profile = (await profileOf(d2))!;
  await assignDelivery({ actorId: d2.id, orderId, market: JO });
  const suspended = await request(`/admin/drivers/${profile.id}/review`, "POST", { decision: "SUSPEND" }, admin.cookie);
  assert.equal(suspended.status, 200, suspended.raw);
  assert.equal((await fulfillmentOf(orderId)).status, "FAILED");
  assert.equal((await assignmentsFor(orderId)).length, 0);
  assert.equal((await request(`/orders/${orderId}/fulfillment`, "GET", undefined, d2.cookie)).status, 404);
  const restored = await reviewDriverProfile({ adminId: admin.id, profileId: profile.id, decision: "APPROVE" });
  assert.equal(restored.status, "APPROVED");
  await setDriverAvailability({ userId: d2.id, market: JO, availability: "AVAILABLE" });
});

await focused("W6-18", "a fare confirmation racing with pre-pickup revocation cannot authorize a released courier", async () => {
  const buyerActor = await register("W6.4 concurrent fare buyer");
  const orderId = await courierOrder("تزامن إلغاء الأجرة W6.4", CITY, { buyerActor });
  await assignDelivery({ actorId: d1.id, orderId, market: JO });
  const proposed = await request(
    `/orders/${orderId}/courier-fare/proposals`,
    "POST",
    { amount: "1.250", idempotencyKey: `w641-race-${randomUUID()}` },
    buyerActor.cookie,
  );
  assert.equal(proposed.status, 200, proposed.raw);
  const proposalId = proposed.data.proposal.id;
  const buyerConfirmation = await request(
    `/orders/${orderId}/courier-fare/confirm`,
    "POST",
    { proposalId },
    buyerActor.cookie,
  );
  assert.equal(buyerConfirmation.status, 200, buyerConfirmation.raw);
  assert.equal(buyerConfirmation.data.agreed, false);

  const [courierConfirmation, revocation] = await Promise.all([
    request(
      `/orders/${orderId}/courier-fare/confirm`,
      "POST",
      { proposalId },
      d1.cookie,
    ),
    request(
      `/admin/orders/${orderId}/courier-assignment/revoke`,
      "POST",
      { reason: "إلغاء متزامن قبل الاستلام", idempotencyKey: `w641-race-revoke-${randomUUID()}` },
      admin.cookie,
    ),
  ]);
  assert.equal(revocation.status, 200, revocation.raw);
  assert.ok(
    [200, 404].includes(courierConfirmation.status),
    courierConfirmation.raw,
  );
  assert.equal((await fulfillmentOf(orderId)).status, "FAILED");
  assert.equal((await assignmentsFor(orderId)).length, 0);
  const agreementRows = await db
    .select()
    .from(courierFareAgreements)
    .where(eq(courierFareAgreements.orderId, orderId));
  if (courierConfirmation.status === 200) {
    assert.equal(agreementRows.length, 1);
    assert.equal(agreementRows[0].courierId, d1.id);
  } else {
    assert.equal(agreementRows.length, 0);
  }
});

await focused("W6-17", "signed-in browser recovery, replacement, privacy, admin revoke and custody boundary", async () => {
  assert.equal(
    deliveryIntent(normalizeDeliveryText("دينار المندوب اعتذر، أبي مندوب ثاني.")),
    "CHOOSE_COURIER",
  );
  const city = `مدينة المتصفح ${runId}`;
  const buyerActor = await register("W6.2 browser buyer");
  const courierA = await register("W6.2 browser courier A");
  const courierB = await register("W6.2 browser courier B");
  const adminCourier = await register("W6.2 browser admin courier");
  const custodyCourier = await register("W6.2 browser custody courier");
  const adminBuyer = await register("W6.2 browser admin-revoke buyer");
  const custodyBuyer = await register("W6.2 browser custody buyer");
  const setupCourier = async (actor: Actor) => {
    const draft = await ensureDriverDraft({ userId: actor.id, market: JO, vehicleType: "CAR", serviceCity: city });
    const submitted = await submitDriverProfile({ userId: actor.id, market: JO, profileId: draft.profile.id });
    assert.equal(submitted.status, "PENDING_VERIFICATION");
    await reviewDriverProfile({ adminId: admin.id, profileId: draft.profile.id, decision: "APPROVE" });
    await setDriverAvailability({ userId: actor.id, market: JO, availability: "AVAILABLE" });
  };
  await Promise.all([
    setupCourier(courierA),
    setupCourier(courierB),
    setupCourier(adminCourier),
    setupCourier(custodyCourier),
  ]);

  const primaryOrderId = await courierOrder("استعادة متصفح", city, { buyerActor });
  const adminOrderId = await courierOrder("إلغاء إداري متصفح", city, { buyerActor: adminBuyer });
  const custodyOrderId = await courierOrder("حيازة متصفح", city, { buyerActor: custodyBuyer });
  await assignDelivery({ actorId: adminCourier.id, orderId: adminOrderId, market: JO });
  await assignDelivery({ actorId: custodyCourier.id, orderId: custodyOrderId, market: JO });
  await agreeCourierFare(custodyOrderId, custodyBuyer, custodyCourier, "1.500");
  await startDriverTrip(custodyCourier, custodyOrderId);

  const originalOrder = (await db.select().from(orders).where(eq(orders.id, primaryOrderId)))[0]!;
  const web = await startDinarBrowserTestWeb();
  let childResult: any;
  try {
    const { stdout } = await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/wave6-2-recovery-browser.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W62_WEB_BASE: web.baseUrl,
        W62_API_ORIGIN: new URL(base).origin,
        W62_PRIMARY_ORDER_ID: primaryOrderId,
        W62_ADMIN_ORDER_ID: adminOrderId,
        W62_CUSTODY_ORDER_ID: custodyOrderId,
        ...Object.fromEntries([
          ["BUYER", buyerActor],
          ["COURIER_A", courierA],
          ["COURIER_B", courierB],
          ["ADMIN", admin],
        ].flatMap(([role, actor]) => [
          [`W62_${role}_COOKIE`, actor.cookie],
          [`W62_${role}_USER_ID`, actor.id],
          [`W62_${role}_CONVERSATION_ID`, actor.conv],
        ])),
      },
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("W62_BROWSER_RESULT "));
    assert.ok(line, stdout.slice(-1500));
    childResult = JSON.parse(line.slice("W62_BROWSER_RESULT ".length));
  } finally {
    await web.stop();
  }

  assert.ok(childResult.checks.length >= 12, JSON.stringify(childResult.checks));
  assert.ok(
    childResult.checks.includes("courier A's stale confirmation cannot restore its assignment after courier B accepts"),
    JSON.stringify(childResult.checks),
  );
  assert.deepEqual(childResult.pageErrors, []);
  assert.deepEqual(childResult.consoleErrors, []);
  assert.deepEqual(childResult.externalRequests, []);
  assert.deepEqual(childResult.urlLeaks, []);
  const primary = await fulfillmentOf(primaryOrderId);
  assert.equal(primary.status, "ACCEPTED");
  assert.equal((await db.select().from(orders).where(eq(orders.id, primaryOrderId)))[0]!.currencyCode, originalOrder.currencyCode);
  const primaryAssignments = await db.select().from(deliveryAssignments).where(eq(deliveryAssignments.orderId, primaryOrderId));
  assert.equal(primaryAssignments.length, 2);
  assert.equal(primaryAssignments.filter((row) => row.status === "ACCEPTED").length, 1);
  assert.equal(primaryAssignments.find((row) => row.driverId === courierA.id)!.status, "RELEASED");
  assert.equal(primaryAssignments.find((row) => row.driverId === courierB.id)!.status, "ACCEPTED");
  assert.equal((await assignmentsFor(adminOrderId)).length, 0);
  assert.equal((await fulfillmentOf(adminOrderId)).status, "FAILED");
  assert.equal((await assignmentsFor(custodyOrderId)).length, 1);
  assert.equal((await fulfillmentOf(custodyOrderId)).status, "OUT_FOR_DELIVERY");
});

await focused("F4-21", "tracking enforces market authorization before and after provider reads and classifies stale snapshots", async () => {
  const trackingBuyer = await register("Wave 6.3 tracking buyer");
  const trackingCourier = await register("Wave 6.3 tracking courier");
  const trackingRival = await register("Wave 6.3 tracking rival");
  const draft = await ensureDriverDraft({
    userId: trackingCourier.id,
    market: JO,
    vehicleType: "CAR",
    serviceCity: CITY,
  });
  await submitDriverProfile({ userId: trackingCourier.id, market: JO, profileId: draft.profile.id });
  await reviewDriverProfile({ adminId: admin.id, profileId: draft.profile.id, decision: "APPROVE" });
  await setDriverAvailability({ userId: trackingCourier.id, market: JO, availability: "AVAILABLE" });
  const orderId = await courierOrder("Wave 6.3 tracking", CITY, { buyerActor: trackingBuyer });
  await assignDelivery({ actorId: trackingCourier.id, orderId, market: JO });
  const concurrentPickup = await Promise.all([
    recordCourierProgress({ actorId: trackingCourier.id, orderId, market: JO, type: "PICKED_UP" }),
    recordCourierProgress({ actorId: trackingCourier.id, orderId, market: JO, type: "PICKED_UP" }),
  ]);
  assert.deepEqual(concurrentPickup.map(({ changed }) => changed).sort(), [false, true]);
  const pickupRows = await db
    .select({ id: deliveryProgressEvents.id })
    .from(deliveryProgressEvents)
    .where(and(
      eq(deliveryProgressEvents.orderId, orderId),
      eq(deliveryProgressEvents.type, "PICKED_UP"),
    ));
  assert.equal(pickupRows.length, 1, "concurrent pickup creates one immutable event");

  const departureRaceOrder = await courierOrder("Wave 6.3 departure pickup race", CITY, { buyerActor: trackingBuyer });
  await assignDelivery({ actorId: trackingCourier.id, orderId: departureRaceOrder, market: JO });
  await agreeCourierFare(departureRaceOrder, trackingBuyer, trackingCourier);
  const [pickupOutcome, departureOutcome] = await Promise.allSettled([
    recordCourierProgress({ actorId: trackingCourier.id, orderId: departureRaceOrder, market: JO, type: "PICKED_UP" }),
    driverOutForDelivery({ actorId: trackingCourier.id, orderId: departureRaceOrder, market: JO }),
  ]);
  assert.equal(pickupOutcome.status, "fulfilled");
  const departureEvents = await db.select().from(deliveryProgressEvents)
    .where(eq(deliveryProgressEvents.orderId, departureRaceOrder));
  assert.equal(departureEvents.filter((event) => event.type === "PICKED_UP").length, 1);
  assert.ok(departureEvents.filter((event) => event.type === "OUT_FOR_DELIVERY").length <= 1);
  if (departureOutcome.status === "fulfilled") {
    assert.equal(departureEvents.filter((event) => event.type === "OUT_FOR_DELIVERY").length, 1);
    assert.equal((await fulfillmentOf(departureRaceOrder)).status, "OUT_FOR_DELIVERY");
  } else {
    assert.equal(departureOutcome.reason?.status, 409);
    assert.equal(departureOutcome.reason?.code, "PICKUP_NOT_CONFIRMED");
    assert.equal(departureEvents.filter((event) => event.type === "OUT_FOR_DELIVERY").length, 0);
    assert.equal((await fulfillmentOf(departureRaceOrder)).status, "ACCEPTED");
  }

  const arrivalRaceOrder = await courierOrder("Wave 6.3 arrival handoff race", CITY, { buyerActor: trackingBuyer });
  await assignDelivery({ actorId: trackingCourier.id, orderId: arrivalRaceOrder, market: JO });
  await agreeCourierFare(arrivalRaceOrder, trackingBuyer, trackingCourier);
  await startDriverTrip(trackingCourier, arrivalRaceOrder);
  const [arrivalOutcome, handoffOutcome] = await Promise.allSettled([
    recordCourierProgress({ actorId: trackingCourier.id, orderId: arrivalRaceOrder, market: JO, type: "ARRIVED" }),
    driverHandoff({ actorId: trackingCourier.id, orderId: arrivalRaceOrder, market: JO }),
  ]);
  assert.equal(handoffOutcome.status, "fulfilled");
  assert.equal(handoffOutcome.value.status, "SELLER_MARKED_DELIVERED");
  const arrivalEvents = await db.select().from(deliveryProgressEvents)
    .where(eq(deliveryProgressEvents.orderId, arrivalRaceOrder));
  const arrivalEvent = arrivalEvents.find((event) => event.type === "ARRIVED");
  const handoffEvent = arrivalEvents.find((event) => event.type === "HANDED_OFF");
  assert.ok(handoffEvent, "handoff records one custody transition");
  assert.equal(arrivalEvents.filter((event) => event.type === "ARRIVED").length, arrivalEvent ? 1 : 0);
  if (arrivalEvent) assert.ok(arrivalEvent.createdAt <= handoffEvent.createdAt, "arrival cannot be appended after handoff");
  else {
    assert.equal(arrivalOutcome.status, "rejected");
    assert.equal((arrivalOutcome as PromiseRejectedResult).reason?.status, 409);
  }

  const repeatedHandoffOrder = await courierOrder("Wave 6.3 repeated handoff", CITY, { buyerActor: trackingBuyer });
  await assignDelivery({ actorId: trackingCourier.id, orderId: repeatedHandoffOrder, market: JO });
  await agreeCourierFare(repeatedHandoffOrder, trackingBuyer, trackingCourier);
  await startDriverTrip(trackingCourier, repeatedHandoffOrder);
  const repeatedHandoffs = await Promise.allSettled([
    driverHandoff({ actorId: trackingCourier.id, orderId: repeatedHandoffOrder, market: JO }),
    driverHandoff({ actorId: trackingCourier.id, orderId: repeatedHandoffOrder, market: JO }),
  ]);
  assert.equal(repeatedHandoffs.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(repeatedHandoffs.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await db.select().from(deliveryProgressEvents).where(and(
    eq(deliveryProgressEvents.orderId, repeatedHandoffOrder),
    eq(deliveryProgressEvents.type, "HANDED_OFF"),
  ))).length, 1, "concurrent handoff appends one immutable event");
  assert.equal((await db.select().from(messages).where(and(
    eq(messages.conversationId, repeatedHandoffOrder),
    eq(messages.body, "سجّل مندوب التوصيل تسليم الطلب؛ بانتظار تأكيد المشتري للاستلام."),
  ))).length, 1, "concurrent handoff sends one completion message");
  const handoffAudits = await db.select().from(marketAudit).where(and(
    eq(marketAudit.action, "DELIVERY_HANDED_OFF"),
    sql`${marketAudit.data}->>'orderId' = ${repeatedHandoffOrder}`,
  ));
  assert.equal(handoffAudits.length, 1, "concurrent handoff writes one audit");
  const receipts = await Promise.all([
    request(`/orders/${repeatedHandoffOrder}/confirm`, "POST", { received: true }, trackingBuyer.cookie),
    request(`/orders/${repeatedHandoffOrder}/confirm`, "POST", { received: true }, trackingBuyer.cookie),
  ]);
  assert.deepEqual(receipts.map((response) => response.status).sort(), [200, 200]);
  assert.equal((await db.select().from(orders).where(eq(orders.id, repeatedHandoffOrder)))[0]!.status, "COMPLETED");
  assert.equal((await db.select().from(courierCommissionReceivables)
    .where(eq(courierCommissionReceivables.orderId, repeatedHandoffOrder))).length, 1,
  "repeated buyer receipt creates one commission receivable");

  const priorProvider = app.locals.orderTrackingProvider;
  let providerMode: "FRESH" | "SWITCH_MARKET" | "STALE" = "FRESH";
  let providerCalls = 0;
  app.locals.orderTrackingProvider = {
    getSnapshot: async () => {
      providerCalls += 1;
      if (providerMode === "SWITCH_MARKET")
        await db.update(users).set({ activeMarketId: "KW" }).where(eq(users.id, trackingBuyer.id));
      return {
        position: {
          latitude: 31.987654,
          longitude: 35.876543,
          observedAt: providerMode === "STALE"
            ? "2000-01-01T00:00:00.000Z"
            : new Date().toISOString(),
        },
      };
    },
  };
  try {
    await db.update(users).set({ activeMarketId: "KW" }).where(eq(users.id, trackingBuyer.id));
    const wrongMarketBuyer = await request(`/orders/${orderId}/tracking`, "GET", undefined, trackingBuyer.cookie);
    assert.equal(wrongMarketBuyer.status, 404, wrongMarketBuyer.raw);
    assert.equal(providerCalls, 0, "a buyer already outside the order market is rejected before provider retrieval");
    await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, trackingBuyer.id));

    const rivalRead = await request(`/orders/${orderId}/tracking`, "GET", undefined, trackingRival.cookie);
    assert.equal(rivalRead.status, 404, rivalRead.raw);
    assert.equal(providerCalls, 0, "a different buyer cannot trigger a provider read");

    await db.update(users).set({ activeMarketId: "KW" }).where(eq(users.id, trackingCourier.id));
    const wrongMarketCourier = await request(`/orders/${orderId}/tracking`, "GET", undefined, trackingCourier.cookie);
    assert.equal(wrongMarketCourier.status, 404, wrongMarketCourier.raw);
    assert.equal(providerCalls, 0, "a courier in another active market cannot trigger a provider read");
    await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, trackingCourier.id));

    const valid = await request(`/orders/${orderId}/tracking`, "GET", undefined, trackingBuyer.cookie);
    assert.equal(valid.status, 200, valid.raw);
    assert.equal(valid.data.tracking.state, "LIVE");
    assert.equal(providerCalls, 1);

    providerMode = "SWITCH_MARKET";
    const response = await request(`/orders/${orderId}/tracking`, "GET", undefined, trackingBuyer.cookie);
    assert.equal(response.status, 404, response.raw);
    assert.equal(response.raw.includes("31.987654"), false);
    assert.equal(response.raw.includes("35.876543"), false);
    assert.equal(providerCalls, 2);

    await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, trackingBuyer.id));
    providerMode = "STALE";
    const stale = await request(`/orders/${orderId}/tracking`, "GET", undefined, trackingBuyer.cookie);
    assert.equal(stale.status, 200, stale.raw);
    assert.equal(stale.data.tracking.state, "STALE");
    assert.equal(stale.data.tracking.position.observedAt, "2000-01-01T00:00:00.000Z");
    assert.equal(providerCalls, 3);
  } finally {
    await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, trackingBuyer.id));
    await db.update(users).set({ activeMarketId: "JO" }).where(eq(users.id, trackingCourier.id));
    if (priorProvider === undefined) delete app.locals.orderTrackingProvider;
    else app.locals.orderTrackingProvider = priorProvider;
  }

  const journeyBuyer = await register("Wave 6.3 signed browser buyer");
  const journeyCourier = await register("Wave 6.3 signed browser courier");
  const journeyDraft = await ensureDriverDraft({
    userId: journeyCourier.id,
    market: JO,
    vehicleType: "CAR",
    serviceCity: CITY,
  });
  await submitDriverProfile({ userId: journeyCourier.id, market: JO, profileId: journeyDraft.profile.id });
  await reviewDriverProfile({ adminId: admin.id, profileId: journeyDraft.profile.id, decision: "APPROVE" });
  await setDriverAvailability({ userId: journeyCourier.id, market: JO, availability: "AVAILABLE" });
  const journeyTitle = `DINAR W63-17 ${runId}`;
  const journeyOrderId = await courierOrder(journeyTitle, CITY, { buyerActor: journeyBuyer });
  const web = await startDinarBrowserTestWeb();
  try {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        process.execPath,
        [`${process.cwd()}/../dinar/test/wave63-delivery-journey-browser.mjs`],
        {
          cwd: `${process.cwd()}/../dinar`,
          env: {
            ...process.env,
            W63_WEB_BASE: web.baseUrl,
            W63_API_ORIGIN: new URL(base).origin,
            W63_ORDER_ID: journeyOrderId,
            W63_ORDER_TITLE: `${journeyTitle} ${runId}`,
            ...Object.fromEntries([
              ["BUYER", journeyBuyer],
              ["COURIER", journeyCourier],
            ].flatMap(([role, actor]) => [
              [`W63_${role}_COOKIE`, actor.cookie],
              [`W63_${role}_USER_ID`, actor.id],
              [`W63_${role}_CONVERSATION_ID`, actor.conv],
            ])),
          },
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ));
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`Signed-in browser journey failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`);
    }
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("W63_BROWSER_RESULT "));
    assert.ok(line, stdout.slice(-2_000));
    const browserResult = JSON.parse(line.slice("W63_BROWSER_RESULT ".length));
    assert.equal(browserResult.status, "PASS", JSON.stringify(browserResult));
    assert.deepEqual(browserResult.pageErrors, []);
    assert.deepEqual(browserResult.consoleErrors, []);
    assert.deepEqual(browserResult.externalRequests, []);
    const events = await db.select().from(deliveryProgressEvents)
      .where(eq(deliveryProgressEvents.orderId, journeyOrderId))
      .orderBy(asc(deliveryProgressEvents.createdAt));
    assert.deepEqual(events.map((event) => event.type), [
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "ARRIVED",
      "HANDED_OFF",
      "BUYER_RECEIVED",
    ]);
    assert.equal((await db.select().from(orders).where(eq(orders.id, journeyOrderId)))[0]!.status, "COMPLETED");
    assert.equal((await fulfillmentOf(journeyOrderId)).status, "DELIVERED");
    console.log("W63-17_SIGNED_BROWSER", JSON.stringify(browserResult));
  } finally {
    await web.stop();
  }
});

await test("summary", async () => {
  const keys = Object.keys(results).sort();
  const w6Keys = keys.filter((id) => /^W6-\d\d$/.test(id));
  const summary = {
    passed: keys.filter((id) => results[id] === "PASS").length,
    total: keys.length,
    results,
    modelCalls: modelCalls.reduce((sum, value) => sum + value, 0),
    externalCalls: external.length,
    attacks,
    falses,
  };
  console.log("BLOCKF4_SUMMARY", JSON.stringify(summary));
  try {
    assert.equal(w6Keys.length, 18, "all W6 acceptance cases are registered");
    assert.equal(w6Keys.filter((id) => results[id] === "PASS").length, 18, "all W6 acceptance cases pass");
    assert.equal(summary.modelCalls, 0);
    assert.equal(summary.externalCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
