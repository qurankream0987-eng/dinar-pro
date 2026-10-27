/**
 * SC02 REAL_E2E (HANDOFF T1): the buyer runs the Prado journey in the real web UI against this
 * API and a disposable database (artifacts/dinar/test/sc02-ui-journey.mjs). This suite creates
 * two accounts and three car fixtures, then checks the database: the comparison labels the
 * unrecorded mileage, the mileage question left its inquiry review unsent, the negotiation is
 * AGREED at the offered amount, and exactly one order exists at that amount.
 * Every model call is blocked; any model call fails the run.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, conversations, db, marketplaceInquiries, negotiations, offers, orderItems, orders, pool } from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const runId = randomUUID().slice(0, 6);
const OFFER_AMOUNT = 4000;
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.113.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_550_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Sc02e2e-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR SC02 E2E ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
    confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.text);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function publishCar(seller: Actor, spec: { title: string; year: number; price: string; mileage?: number }) {
  const created = await request("/listings", "POST", {
    title: `${spec.title} ${runId}`,
    description: `سيارة ${spec.title} مستعملة للبيع، فحص كامل`,
    category: "سيارات", categoryId: "cars", area: "خلدا", city: "عمان",
    attributes: { make: "تويوتا", model: "برادو", year: spec.year, condition: "مستعمل", ...(spec.mileage ? { mileage: spec.mileage } : {}) },
    unitPrice: spec.price, inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "NEGOTIABLE", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  return created.data.id as string;
}

await test("SC02 REAL_E2E: narrow → sort → compare → «كم ماشي؟» → offer → agreement → order", async () => {
  const seller = await register("seller");
  const buyer = await register("buyer");
  const noMileageId = await publishCar(seller, { title: "تويوتا برادو 2020", year: 2020, price: "3200" });
  const offerListingId = await publishCar(seller, { title: "تويوتا برادو 2021", year: 2021, price: "4500", mileage: 60000 });
  await publishCar(seller, { title: "تويوتا برادو 2022", year: 2022, price: "5000", mileage: 30000 });
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-sc02-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/sc02-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        SC02_WEB_BASE: web.baseUrl,
        SC02_API_ORIGIN: origin,
        SC02_BUYER_COOKIE: buyer.cookie,
        SC02_SELLER_COOKIE: seller.cookie,
        SC02_NO_MILEAGE_ID: noMileageId,
        SC02_OFFER_ID: offerListingId,
        SC02_OFFER_AMOUNT: String(OFFER_AMOUNT),
        SC02_UI_RESULT_PATH: resultPath,
      },
      timeout: 900_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  let report: any;
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    report = undefined;
  }
  console.log("SC02_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0, "every SC02 step is handled by DINAR, not the model");
  assert.deepEqual(report.modelFallbacks, [], "no SC02 step fell through to the model");

  // ── Database proof ──
  const rows = await db.select().from(offers);
  const noMileage = rows.find((row) => row.id === noMileageId);
  const offered = rows.find((row) => row.id === offerListingId);
  assert.ok(noMileage && offered, "the fixtures exist");
  assert.equal((noMileage!.data.attributes as Record<string, unknown>).mileage, undefined, "the cheapest car really has no recorded mileage");
  assert.equal((offered!.data.attributes as Record<string, unknown>).mileage, 60000, "the second car records its mileage");

  const blocks = await db
    .select({ payload: aiUiBlocks.payload, blockType: aiUiBlocks.blockType })
    .from(aiUiBlocks)
    .innerJoin(conversations, eq(conversations.id, aiUiBlocks.conversationId))
    .where(eq(conversations.ownerUserId, buyer.id));
  const surfaces = blocks.filter((block) => block.blockType === "SURFACE").map((block) => block.payload as Record<string, any>);
  const comparison = surfaces.find((payload) => payload.surface === "COMPARISON");
  assert.ok(comparison, "the comparison reached the conversation store");
  assert.equal(comparison.comparison.unknownLabel, "لم يذكر البائع");
  const mileageRow = comparison.comparison.rows.find((row: any) => /ممشى|ماشي|mileage/iu.test(String(row.label)));
  assert.ok(mileageRow, "the comparison carries the mileage row");
  assert.ok(mileageRow.values.some((value: unknown) => value === null), "the unrecorded mileage stays empty, not invented");
  const draft = surfaces.find((payload) => payload.surface === "INQUIRY_DRAFT");
  assert.ok(draft, "the mileage question produced an inquiry review");
  assert.equal(draft.inquiry.view, "DRAFT");
  assert.equal(draft.inquiry.status, "PENDING");
  assert.match(String(draft.inquiry.body), /ممشى/u);
  assert.equal(draft.resourceId, noMileageId, "the drafted question is about the car in view");

  const inquiries = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, noMileageId));
  assert.equal(inquiries.length, 0, "nothing was sent to the seller about the unrecorded mileage");

  const actionRows = await db.select({ query: aiResultSets.query }).from(aiResultSets);
  const sentActions = actionRows.filter((row) => {
    const query = row.query as { kind?: unknown; action?: unknown; targetResource?: unknown; status?: unknown };
    return query.kind === "ACTION" && query.action === "SEND_INQUIRY_MESSAGE" && String(query.targetResource) === `listing:${noMileageId}` && query.status === "CONFIRMED";
  });
  assert.equal(sentActions.length, 0, "the inquiry review was never confirmed");

  const [negotiation] = await db.select().from(negotiations).where(and(eq(negotiations.listingId, offerListingId), eq(negotiations.buyerId, buyer.id)));
  assert.ok(negotiation, "the offer opened a negotiation");
  assert.equal(negotiation!.status, "AGREED");
  assert.equal(negotiation!.agreedAmountMinor, OFFER_AMOUNT * 10 ** negotiation!.minorUnitScale);

  const buyerOrders = await db.select().from(orders).where(eq(orders.buyerId, buyer.id));
  assert.equal(buyerOrders.length, 1, "exactly one order");
  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, buyerOrders[0]!.id));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.offerId, offerListingId, "the order is for the agreed car");
  assert.equal(buyerOrders[0]!.unitPriceMinor, OFFER_AMOUNT * 10 ** buyerOrders[0]!.minorUnitScale, "the order uses the agreed amount, not the asking price");
  assert.equal(buyerOrders[0]!.status, "CREATED");
  console.log("SC02_E2E_SUMMARY", JSON.stringify({ result: "PASS", scope: "REAL_E2E", checks: report.checks.length, steps: report.steps.length, listingId: offerListingId, noMileageId, orderId: buyerOrders[0]!.id }));
});

after(async () => {
  server.close();
  await pool.end();
});
