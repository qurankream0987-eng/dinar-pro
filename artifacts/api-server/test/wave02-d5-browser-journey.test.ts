/**
 * WAVE 02 / D4 + D5 — the seller-employee reply in a real browser.
 *
 * The business, its grant and the D5 session are created through DINAR's own HTTP turns; the two
 * customer inquiries arrive through the canonical inquiry authority. The scripted model only
 * proposes a drafted reply. Chromium then restores the inbox conversation, reloads, approves the
 * reply once, and — after the owner revokes the grant — finds the rebuilt card rejected with no
 * action left. Every browser turn is deterministic: the scripted model call count cannot move
 * while the page is driving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { eq, inArray } from "drizzle-orm";
import {
  authRateLimitBuckets,
  businessOperatingProfiles,
  db,
  markets,
  marketplaceInquiries,
  messages,
  pool,
} from "@workspace/db";
import app from "../src/app";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { authRateLimitKeyHash, AUTH_RATE_LIMIT_SCOPE } from "../src/lib/auth-rate-limiter";
import { assignListingToBusiness } from "../src/lib/business-catalog-contract";
import { INQUIRY_INBOX_TITLE, submitInquiryMessage } from "../src/lib/inquiries";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE02_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const runId = randomUUID().slice(0, 6);
let ipSequence = 0;

type Actor = { id: string; cookie: string };

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `192.0.2.${(ipSequence++ % 250) + 1}` } : {}),
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

let phone = 0;
async function register(name: string): Promise<Actor> {
  const number = `79${((Date.now() + 104729 * ++phone) % 10_000_000).toString().padStart(7, "0")}`;
  const password = `W02-browser-${randomUUID().slice(0, 10)}!`;
  const created = await request("/auth/register", "POST", {
    displayName: name,
    phoneCountryCode: "+962",
    phoneNumber: number,
    accountCountry: "JO",
    password,
    confirmPassword: password,
    acceptTerms: true,
  });
  assert.equal(created.status, 201, created.raw);
  return { id: created.data.user.id, cookie: created.cookie };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

async function say(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${message}: ${raw.slice(0, 400)}`);
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 500)}`);
  return { body: complete.assistantMessage.body as string, blocks: (complete.assistantMessage.blocks ?? []) as any[] };
}

async function publish(actor: Actor, title: string, quantity: number) {
  const created = await request("/listings", "POST", {
    title,
    description: `${title} — وصف اختبار المتصفح`,
    category: "أخرى",
    categoryId: "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: "5",
    inventoryMode: "LIMITED",
    availableQuantity: quantity,
    fulfilmentType: "PICKUP",
    imageUrl: "",
    imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

async function attachToListingBusiness(actor: Actor, businessProfileId: string, listingId: string) {
  const [business] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, businessProfileId));
  assert.ok(business);
  await assignListingToBusiness({ actorId: actor.id, marketId: "JO", listingId, businessId: business!.d2BusinessId });
}

const ALL_CAPABILITIES = [
  "business.catalog.read",
  "business.catalog.draft",
  "business.catalog.draft.price",
  "business.inventory.read",
  "business.orders.read",
  "business.inquiries.reply",
  "business.messages.send",
  "business.negotiations.escalate",
] as const;

async function resetModelLimit(actorId: string) {
  await db.delete(authRateLimitBuckets).where(inArray(authRateLimitBuckets.keyHash, [
    authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelActor, actorId),
    authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelHeavyActor, actorId),
  ]));
}

type Scripted = { action: string; replyText?: string };
let scriptedCalls = 0;
let step: Scripted = { action: "NONE" };

function installScriptedModel() {
  app.locals.conversationModelGateway = {
    proposeToolCall: async () => {
      scriptedCalls += 1;
      return {
        id: `w02-browser-model-${randomUUID()}`,
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: "CONVERSATIONAL_RESPONSE",
          goal: "SELL",
          suggestedAction: "NONE",
          sellerEmployeeAction: step.action,
          ...(step.replyText ? { sellerEmployeeReply: step.replyText } : {}),
          confidence: 1,
          conversationalReply: "تم إعداد ما طلبته لمراجعتك.",
        }),
      };
    },
  } as any;
}

const threadOwnerMessages = async (conversationId: string) =>
  (await db.select().from(messages).where(eq(messages.conversationId, conversationId))).filter((row) => row.senderId === owner.id).length;

async function runUi(phase: "review" | "revoked", extra: Record<string, string> = {}) {
  const web = await startDinarBrowserTestWeb(base.replace(/\/api$/u, ""));
  const resultPath = `/tmp/dinar-w02-d5-ui-${runId}-${phase}.json`;
  let browserError: unknown;
  const callsBefore = getModelGatewayCallCount();
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/wave02-d5-ui.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        W02D5_WEB_BASE: web.baseUrl,
        W02D5_API_ORIGIN: base.replace(/\/api$/u, ""),
        W02D5_OWNER_COOKIE: owner.cookie,
        W02D5_OWNER_ID: owner.id,
        W02D5_CONVERSATION_ID: inboxId,
        W02D5_PHASE: phase,
        W02D5_UI_RESULT_PATH: resultPath,
        ...extra,
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
  console.log(`W02_D5_BROWSER_${phase.toUpperCase()}`, JSON.stringify(report));
  if (browserError && !report) throw browserError;
  assert.ok(report, `the ${phase} browser journey wrote its report`);
  assert.equal(report.failure, undefined, report.failure);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.horizontalOverflow, 0);
  assert.equal(getModelGatewayCallCount(), callsBefore, "a browser turn never calls the model");
  return report;
}

const owner = await register(`بائع الموجة الثانية ${runId}`);
const buyer = await register(`مشتري الموجة الثانية ${runId}`);
let businessId = "";
let delegationId = "";
let inboxId = "";
let secondListingId = "";
let originConversationId = "";
let firstThreadConversationId = "";
let secondThreadConversationId = "";

await test("W02-D5 browser setup: business, grant, session and two customer inquiries", async () => {
  const setupConversation = await conversation(owner);
  const businessTurn = await say(owner, setupConversation, "عندي متجر اسمه متجر الموجة الثانية للمتصفح");
  businessId = businessTurn.blocks.find((block) => block.payload?.business)?.payload.business.businessId as string;
  assert.ok(businessId, businessTurn.body);

  const firstListingId = await publish(owner, `جاكيت متصفح أ ${runId}`, 35);
  secondListingId = await publish(owner, `جاكيت متصفح ب ${runId}`, 17);
  await attachToListingBusiness(owner, businessId, firstListingId);
  await attachToListingBusiness(owner, businessId, secondListingId);

  const created = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: ALL_CAPABILITIES,
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `w02-browser-grant-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(created.status, 201, created.raw);
  delegationId = created.data.delegation.id as string;
  const activated = await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(activated.status, 200, activated.raw);

  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market);
  const buyerConversation = await conversation(buyer);
  const firstInquiry = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyer.id,
    market: market!,
    target: { kind: "LISTING", listingId: firstListingId },
    body: "عندك 50 قطعة؟",
    provenance: "BUYER_AUTHORED",
    originConversationId: buyerConversation,
  });
  const inbox = (await request("/ai/conversations", "GET", undefined, owner.cookie)).data
    .find((row: any) => row.title === INQUIRY_INBOX_TITLE);
  assert.ok(inbox, "the customer inquiry opens the DINAR inbox");
  inboxId = inbox.id as string;

  installScriptedModel();
  step = { action: "NONE" };
  await say(owner, inboxId, "يا موظفي الذكي");
  step = { action: "DRAFT_INQUIRY_REPLY", replyText: "المتوفر حاليًا 35 قطعة." };
  await resetModelLimit(owner.id);
  const draft = await say(owner, inboxId, "جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  const payload = draft.blocks.find((block) => block.payload?.inquiry?.view === "DRAFT")?.payload;
  assert.ok(payload, draft.body);
  assert.equal(payload.inquiry.status, "PENDING");

  const [firstInquiryRow] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, firstInquiry.inquiryId));
  assert.ok(firstInquiryRow);
  firstThreadConversationId = firstInquiryRow!.threadConversationId;
  originConversationId = buyerConversation;
});

await test("W02-D5 browser: the pending reply survives a reload and is sent exactly once from the page", async () => {
  const report = await runUi("review");
  assert.ok(report.checks.length >= 6, `expected the full review journey, got ${report.checks.length}`);
  assert.equal(report.draft.body, "المتوفر حاليًا 35 قطعة.");
  assert.equal(await threadOwnerMessages(firstThreadConversationId), 1, "one approved reply reaches the customer");
});

await test("W02-D5 browser: revocation rebuilds the card rejected with nothing left to approve", async () => {
  // The second customer writes only now, so the first draft stays the newest card the page shows.
  const [secondMarket] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const secondInquiry = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyer.id,
    market: secondMarket!,
    target: { kind: "LISTING", listingId: secondListingId },
    body: "هل يتوفر 17 حبة؟",
    provenance: "BUYER_AUTHORED",
    originConversationId,
  });
  const [secondInquiryRow] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, secondInquiry.inquiryId));
  assert.ok(secondInquiryRow);
  secondThreadConversationId = secondInquiryRow!.threadConversationId;

  // A fresh pending draft for the second customer is what revocation must invalidate.
  step = { action: "DRAFT_INQUIRY_REPLY", replyText: "المتوفر حاليًا 17 قطعة." };
  await resetModelLimit(owner.id);
  const draft = await say(owner, inboxId, "جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  const payload = draft.blocks.find((block) => block.payload?.inquiry?.view === "DRAFT")?.payload;
  assert.ok(payload, draft.body);
  assert.equal(payload.inquiry.status, "PENDING");

  const revoked = await request(`/business/profiles/${businessId}/delegations/${delegationId}/revoke`, "POST", {
    confirm: true,
    expectedVersion: 2,
  }, owner.cookie);
  assert.equal(revoked.status, 200, revoked.raw);

  const report = await runUi("revoked");
  assert.ok(report.checks.length >= 4, `expected the revoked journey, got ${report.checks.length}`);
  assert.equal(report.draft.status, "لم تُرسل؛ لم يتغير شيء", "the rebuilt card shows DINAR's rejected status");
  assert.equal(await threadOwnerMessages(secondThreadConversationId), 0, "a revoked approval sends nothing");
});

test.after(async () => {
  app.locals.conversationModelGateway = undefined;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});
