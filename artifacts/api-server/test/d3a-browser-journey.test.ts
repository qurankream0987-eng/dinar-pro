/**
 * D3-A real Chromium acceptance: the owner runs one INTERNAL_DINAR business through the DINAR
 * conversation UI — setup answers, activation review, typed drafts, one publish review per draft,
 * the catalog, orders and insights — and opens the DINAR-hosted public page; a buyer opens that
 * page and reaches the listing through the canonical search. The database must show exactly the
 * three published listings, their business links and the audits, and the browser must report no
 * page error, console error, external request, horizontal overflow or model call.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import app from "../src/app";
import {
  businessAuditEvents,
  businessListingLinks,
  businessOperatingProfiles,
  db,
  offers,
  orders,
  pool,
} from "@workspace/db";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { registerBusinessIdentityFixture } from "../src/lib/d2-business-identity";
import { BUSINESS_CAPABILITIES } from "../src/lib/business-capabilities";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_D3A_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.BDINAR_D3A_D2_FIXTURES = "development";

const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 6);
let ipSequence = 0;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.51.100.${(ipSequence++ % 250) + 1}` } : {}),
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

type Actor = { id: string; name: string; phoneNumber: string; cookie: string };
const phoneBase = 55_100_000 + ((Date.now() + process.pid) % 300_000);
let phoneOffset = 0;
const password = `D3A-UI-${randomUUID().slice(0, 12)}!`;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const name = `DINAR D3A UI ${label} ${runId}`;
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const registered = await request("/auth/register", "POST", {
    displayName: name, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, name, phoneNumber, cookie: registered.cookie };
}

async function turn(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${origin}/api/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, raw.slice(0, 400));
  return complete.assistantMessage.blocks[0]?.payload as Record<string, any>;
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

await test("D3A REAL_UI: one business is created, activated, published, managed and discovered inside DINAR", async () => {
  const owner = await register("Owner");
  const buyer = await register("Buyer");
  const conversationId = await conversation(owner);
  await conversation(buyer);

  // The conversation exists in the draft state before the browser opens it; the owner answers the
  // remaining setup questions in the real UI.
  const started = await turn(owner, conversationId, "عندي مطعم اسمه «مطعم الرمال» في عمان");
  assert.equal(started.business.view, "SETUP", JSON.stringify(started.business));
  const businessId = started.business.businessId as string;
  assert.ok(businessId, "the intro created the operating profile");
  // D2's trusted identity is injected only through the hard-guarded fixture port; D3 never writes a
  // verification result, and the D3 profile's own identity_status stays PENDING_D2.
  registerBusinessIdentityFixture({
    businessId,
    ownerUserId: owner.id,
    marketId: "JO",
    businessType: "RESTAURANT",
    verificationStatus: "VERIFIED",
    publicationEligibility: "ELIGIBLE",
    membershipPermissions: [...BUSINESS_CAPABILITIES],
    businessStatus: "ACTIVE",
    policyVersion: "D2-2026-11",
  });
  await db.update(businessOperatingProfiles).set({ d2BusinessId: businessId }).where(eq(businessOperatingProfiles.id, businessId));

  const modelCallsBefore = getModelGatewayCallCount();
  const web = await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-d3a-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/d3a-business-ui-journey.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        D3A_WEB_BASE: web.baseUrl,
        D3A_API_ORIGIN: origin,
        D3A_RUN_ID: runId,
        D3A_USER_ID: owner.id,
        D3A_CONVERSATION_ID: conversationId,
        D3A_BUSINESS_ID: businessId,
        D3A_BUSINESS_NAME: "مطعم الرمال",
        D3A_OWNER_NAME: owner.name,
        D3A_OWNER_PHONE: owner.phoneNumber,
        D3A_OWNER_COOKIE: owner.cookie,
        D3A_BUYER_COOKIE: buyer.cookie,
        D3A_UI_RESULT_PATH: resultPath,
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
  console.log("D3A_BROWSER", JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, [], "no page error");
  assert.deepEqual(report.consoleErrors, [], "no console error");
  assert.deepEqual(report.externalRequests, [], "no external request");
  assert.equal(report.horizontalOverflow, 0, "no horizontal overflow");
  assert.deepEqual(report.modelFallbacks, [], "no step fell through to the model");
  assert.equal(getModelGatewayCallCount() - modelCallsBefore, 0, "the journey made no model call");
  assert.deepEqual(
    [...report.surfaces].sort(),
    ["business-catalog", "business-catalog-draft", "business-insights", "business-listing-review", "business-orders", "business-profile", "business-profile-review", "business-setup"],
    "every one of the eight business card families rendered in the real UI",
  );

  // ── Database proof ──
  const [business] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, businessId));
  assert.equal(business!.status, "ACTIVE");
  assert.equal(business!.identityStatus, "PENDING_D2", "D3 never turns its own profile into a verification");
  assert.equal(business!.d2BusinessId, businessId);

  const rows = await db.select().from(offers).where(eq(offers.sellerId, owner.id));
  assert.equal(rows.length, 3, "exactly the three drafts became listings");
  assert.deepEqual(rows.map((row) => row.unitPriceMinor).sort((a, b) => a - b), [1000, 2500, 3250]);
  assert.ok(rows.every((row) => row.status === "PUBLISHED"));
  assert.ok(rows.every((row) => row.marketId === "JO"));
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [...report.listingIds].sort(),
    "the storefront shows exactly the published listings",
  );

  const links = await db.select().from(businessListingLinks).where(eq(businessListingLinks.businessId, businessId));
  assert.equal(links.length, 3, "every published listing is linked to the business");
  assert.ok(links.every((link) => link.marketId === "JO"));

  const audits = await db.select().from(businessAuditEvents).where(eq(businessAuditEvents.businessId, businessId));
  assert.equal(audits.filter((event) => event.action === "BUSINESS_ACTIVATED").length, 1);
  const published = audits.filter((event) => event.action === "LISTING_PUBLISHED");
  assert.equal(published.length, 3);
  assert.deepEqual(published.map((event) => event.resourceId).sort(), [...report.listingIds].sort());

  assert.equal((await db.select().from(orders).where(eq(orders.sellerId, owner.id))).length, 0, "no order was invented");

  console.log("D3A_UI_SUMMARY", JSON.stringify({
    result: "PASS",
    scope: "REAL_UI",
    businessId,
    listings: rows.length,
    surfaces: report.surfaces.length,
    checks: report.checks.length,
    steps: report.steps.length,
    searchHits: report.searchResults.length,
  }));
});

after(async () => {
  server.close();
  await pool.end();
});
