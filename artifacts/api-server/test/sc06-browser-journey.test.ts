/**
 * SC06 REAL_E2E (HANDOFF T2): the buyer runs the industrial-machine journey in the real web UI
 * against this API and a disposable database (artifacts/dinar/test/sc06-ui-journey.mjs). This
 * suite creates two accounts and two machine fixtures, then checks the database: the spec
 * question produced an inquiry review about the 220V machine and left it unsent. Every model
 * call is blocked; any model call fails the run.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, conversations, db, marketplaceInquiries, offers, pool } from "@workspace/db";
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
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json", origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.114.${(ipSequence++ % 250) + 1}` } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}

type Actor = { id: string; cookie: string };
const phoneBase = 51_650_000 + ((Date.now() + process.pid) % 200_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Sc06e2e-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR SC06 E2E ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password,
    confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.text);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function publishMachine(seller: Actor, spec: { title: string; price: string; description: string; attributes?: Record<string, unknown> }) {
  const created = await request("/listings", "POST", {
    title: `${spec.title} ${runId}`,
    description: spec.description,
    category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: { condition: "مستعمل", ...spec.attributes },
    unitPrice: spec.price, inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "NEGOTIABLE", imageUrl: "", imageUrls: [],
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  return { id: created.data.id as string, title: `${spec.title} ${runId}` };
}

await test("SC06 REAL_E2E: find machines → 220 volts → spec question → unsent inquiry review", async () => {
  const seller = await register("seller");
  const buyer = await register("buyer");
  const machine220 = await publishMachine(seller, {
    title: "ماكينة تغليف صناعية مستعملة 220 فولت", price: "2500",
    description: "ماكينة تغليف صناعية 220 فولت مستعملة بحالة جيدة",
  });
  const machine380 = await publishMachine(seller, {
    title: "ماكينة تغليف صناعية مستعملة 380 فولت", price: "2700",
    description: "ماكينة تغليف صناعية 380 فولت مستعملة بحالة جيدة",
  });
  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-sc06-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/sc06-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        SC06_WEB_BASE: web.baseUrl,
        SC06_API_ORIGIN: origin,
        SC06_BUYER_COOKIE: buyer.cookie,
        SC06_MACHINE_ID: machine220.id,
        SC06_OTHER_ID: machine380.id,
        SC06_UI_RESULT_PATH: resultPath,
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
  console.log("SC06_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0, "every SC06 step is handled by DINAR, not the model");
  assert.deepEqual(report.modelFallbacks, [], "no SC06 step fell through to the model");

  // ── Database proof ──
  const rows = await db.select().from(offers);
  const machine = rows.find((row) => row.id === machine220.id);
  assert.ok(machine, "the 220V fixture exists");
  const attributes = machine!.data.attributes as Record<string, unknown>;
  assert.equal(attributes.operatingHours, undefined, "the seller recorded no operating hours");
  assert.equal(attributes.inspection, undefined, "the seller recorded no inspection result");

  const blocks = await db
    .select({ payload: aiUiBlocks.payload, blockType: aiUiBlocks.blockType })
    .from(aiUiBlocks)
    .innerJoin(conversations, eq(conversations.id, aiUiBlocks.conversationId))
    .where(eq(conversations.ownerUserId, buyer.id));
  const surfaces = blocks.filter((block) => block.blockType === "SURFACE").map((block) => block.payload as Record<string, any>);
  const draft = surfaces.find((payload) => payload.surface === "INQUIRY_DRAFT");
  assert.ok(draft, "the spec question produced an inquiry review");
  assert.equal(draft.inquiry.view, "DRAFT");
  assert.equal(draft.inquiry.status, "PENDING");
  assert.match(String(draft.inquiry.body), /ساعات/u);
  assert.match(String(draft.inquiry.body), /220/u, "the drafted question is about the machine in view");
  assert.equal(draft.resourceId, machine220.id);

  const inquiries = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.listingId, machine220.id));
  assert.equal(inquiries.length, 0, "nothing was sent to the seller about the unrecorded spec");

  const actionRows = await db.select({ query: aiResultSets.query }).from(aiResultSets);
  const sentActions = actionRows.filter((row) => {
    const query = row.query as { kind?: unknown; action?: unknown; targetResource?: unknown; status?: unknown };
    return query.kind === "ACTION" && query.action === "SEND_INQUIRY_MESSAGE" && String(query.targetResource) === `listing:${machine220.id}` && query.status === "CONFIRMED";
  });
  assert.equal(sentActions.length, 0, "the inquiry review was never confirmed");

  console.log("SC06_E2E_SUMMARY", JSON.stringify({ result: "PASS", scope: "REAL_E2E", checks: report.checks.length, steps: report.steps.length, listingId: machine220.id, otherListingId: machine380.id }));
});

after(async () => {
  server.close();
  await pool.end();
});
