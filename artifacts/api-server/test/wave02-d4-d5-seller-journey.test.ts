/**
 * WAVE 02 / D4 + D5 — the intelligent employee delegation and seller journey, end to end.
 *
 * One owner, one business, one D4 grant and one persisted D5 session are driven through the real
 * HTTP conversation route with a scripted model gateway. The model only proposes an employee
 * action; every send, counter and publication is decided by DINAR's existing reviews and by the
 * owner's confirmation. The database is the authority: each turn is checked against the stored
 * inquiry thread, negotiation, audit trail and action receipts.
 *
 * Scenarios (mission list): a seller receives more than one customer inquiry, the employee drafts
 * accurate replies, the owner approves each reply, a customer asks for a discount, the employee
 * escalates it, the seller confirms the authorized change, revocation blocks later employee
 * actions, a failed operation produces no success receipt, and a replayed approval has one effect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  aiResultSets,
  authRateLimitBuckets,
  businessAuditEvents,
  businessDelegations,
  businessOperatingProfiles,
  db,
  markets,
  marketplaceInquiries,
  messages,
  negotiations,
  offers,
  orders,
} from "@workspace/db";
import app from "../src/app";
import { authRateLimitKeyHash, AUTH_RATE_LIMIT_SCOPE } from "../src/lib/auth-rate-limiter";
import { assignListingToBusiness } from "../src/lib/business-catalog-contract";
import { resolveSellerEmployeeSession } from "../src/lib/business-delegations";
import { INQUIRY_INBOX_TITLE, submitInquiryMessage } from "../src/lib/inquiries";
import { openNegotiation } from "../src/lib/negotiations";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_WAVE02_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;

type Actor = { id: string; cookie: string; phoneNumber: string };

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

const phoneBase = 51_690_000 + ((Date.now() + process.pid) % 4_000);
let phoneOffset = 0;
const safeTag = () => randomUUID().replace(/[0-9]/g, "x").slice(0, 8);
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `W02-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR W02 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, phoneNumber };
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
  return {
    body: complete.assistantMessage.body as string,
    blocks: (complete.assistantMessage.blocks ?? []) as any[],
  };
}

async function createBusiness(actor: Actor): Promise<string> {
  const id = await conversation(actor);
  const turn = await say(actor, id, "عندي متجر اسمه متجر الموجة الثانية التجريبي");
  const business = turn.blocks.find((block) => block.payload?.business)?.payload.business;
  assert.equal(business?.view, "SETUP", turn.body);
  return business.businessId as string;
}

async function publish(actor: Actor, title: string, quantity: number, negotiable = false) {
  const created = await request("/listings", "POST", {
    title,
    description: `${title} — وصف اختبار الموجة الثانية`,
    category: "أخرى",
    categoryId: "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: "3",
    inventoryMode: "LIMITED",
    availableQuantity: quantity,
    negotiable,
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

async function createGrant(actor: Actor, businessId: string, capabilities: readonly string[]) {
  const created = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities,
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `w02-grant-${randomUUID()}`,
  }, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.delegation.id as string;
}

async function activateGrant(actor: Actor, businessId: string, delegationId: string) {
  const activated = await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, actor.cookie);
  assert.equal(activated.status, 200, activated.raw);
}

async function resetModelLimit(actorId: string) {
  await db.delete(authRateLimitBuckets).where(inArray(authRateLimitBuckets.keyHash, [
    authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelActor, actorId),
    authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelHeavyActor, actorId),
  ]));
}

type Scripted = {
  action: string;
  replyText?: string;
  item?: string;
  suggestedAction?: string;
  conversationalReply?: string;
  fail?: boolean;
};

/** The scripted model: it proposes one action and never executes anything itself. */
async function scriptModel(owner: Actor, script: () => Scripted) {
  let calls = 0;
  let lastRequest = "";
  app.locals.conversationModelGateway = {
    proposeToolCall: async (input: unknown) => {
      calls += 1;
      lastRequest = JSON.stringify(input);
      const step = script();
      if (step.fail) throw new Error("simulated D5 model failure");
      return {
        id: `w02-model-${randomUUID()}`,
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: "CONVERSATIONAL_RESPONSE",
          goal: "SELL",
          suggestedAction: step.suggestedAction ?? "NONE",
          sellerEmployeeAction: step.action,
          ...(step.replyText ? { sellerEmployeeReply: step.replyText } : {}),
          ...(step.item ? { entities: { item: step.item } } : {}),
          confidence: 1,
          conversationalReply: step.conversationalReply ?? "تم إعداد ما طلبته لمراجعتك.",
        }),
      };
    },
  } as any;
  return {
    get calls() { return calls; },
    get lastRequest() { return lastRequest; },
  };
}

const auditFor = async (actorId: string, action: string) =>
  db.select().from(businessAuditEvents).where(and(
    eq(businessAuditEvents.actorId, actorId),
    eq(businessAuditEvents.action, action),
  ));

const threadMessages = async (threadConversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, threadConversationId));

const draftOf = (turn: { blocks: any[] }) =>
  turn.blocks.find((block) => block.payload?.inquiry?.view === "DRAFT")?.payload ?? null;

const inquiryOf = (turn: { blocks: any[] }) =>
  turn.blocks.find((block) => block.payload?.inquiry)?.payload.inquiry ?? null;

await test("W02-D4: creation, scope, refusal, expiry, revocation and audit stay server-owned", async () => {
  const owner = await register("D4 Owner");
  const other = await register("D4 Other Owner");
  const businessId = await createBusiness(owner);
  const listingId = await publish(owner, `منتج التفويض ${safeTag()}`, 5);
  await attachToListingBusiness(owner, businessId, listingId);

  // A human employee may not receive D5 capabilities; unknown fields and duplicate capabilities fail.
  const humanD5 = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "HUMAN", userId: other.id },
    capabilities: ["business.catalog.read", "business.messages.send"],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: `w02-human-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(humanD5.status, 400, humanD5.raw);
  const duplicate = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: ["business.catalog.read", "business.catalog.read"],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: `w02-duplicate-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(duplicate.status, 400, duplicate.raw);
  const unknownField = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: ["business.catalog.read"],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: `w02-unknown-${randomUUID()}`,
    grantAdmin: true,
  }, owner.cookie);
  assert.equal(unknownField.status, 400, unknownField.raw);
  assert.equal((await db.select().from(businessDelegations).where(eq(businessDelegations.businessId, businessId))).length, 0);
  assert.equal((await auditFor(owner.id, "DELEGATION_CREATED")).length, 0, "a refused request writes no audit");

  // Another account cannot read, activate or revoke this business's delegation.
  const delegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  assert.equal((await request(`/business/profiles/${businessId}/delegations`, "GET", undefined, other.cookie)).status, 404);
  assert.equal((await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", { confirm: true, expectedVersion: 1 }, other.cookie)).status, 404);
  assert.equal((await request(`/business/profiles/${businessId}/delegations/${delegationId}/revoke`, "POST", { confirm: true, expectedVersion: 1 }, other.cookie)).status, 404);

  // The server clock governs activation: a stored grant already past its expiry cannot start.
  await db.update(businessDelegations)
    .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 5_000) })
    .where(eq(businessDelegations.id, delegationId));
  const expiredActivation = await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(expiredActivation.status, 409, expiredActivation.raw);
  assert.match(expiredActivation.raw, /لا يمكن تفعيل هذا التفويض/u);
  const [staleRow] = await db.select().from(businessDelegations).where(eq(businessDelegations.id, delegationId));
  assert.equal(staleRow?.status, "DRAFT", "a refused activation changes nothing");

  // A live grant that passes its expiry is settled by the authorization path itself: the stored
  // row becomes EXPIRED and the running session is invalidated before any capability is returned.
  const expiringDelegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  await activateGrant(owner, businessId, expiringDelegationId);
  const expiringConversationId = await conversation(owner);
  await say(owner, expiringConversationId, "يا موظفي الذكي");
  assert.equal((await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: expiringConversationId, marketId: "JO" })).state, "ACTIVE");
  await db.update(businessDelegations)
    .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 5_000) })
    .where(eq(businessDelegations.id, expiringDelegationId));
  const expiredResolution = await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: expiringConversationId, marketId: "JO" });
  assert.equal(expiredResolution.state, "INVALIDATED");
  assert.equal((expiredResolution as { reason?: string }).reason, "GRANT_EXPIRED");
  const [expiredRow] = await db.select().from(businessDelegations).where(eq(businessDelegations.id, expiringDelegationId));
  assert.equal(expiredRow?.status, "EXPIRED", "the grant expires in the database, not by a client claim");
  assert.ok(expiredRow?.expiredAt);
  assert.ok((await auditFor(owner.id, "DELEGATION_EXPIRED")).length >= 1);

  // A live grant that is revoked stops the session and leaves one audit trail.
  const liveDelegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  await activateGrant(owner, businessId, liveDelegationId);
  const sellerConversationId = await conversation(owner);
  await say(owner, sellerConversationId, "يا موظفي الذكي");
  assert.equal((await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: sellerConversationId, marketId: "JO" })).state, "ACTIVE");
  const revoked = await request(`/business/profiles/${businessId}/delegations/${liveDelegationId}/revoke`, "POST", { confirm: true, expectedVersion: 2 }, owner.cookie);
  assert.equal(revoked.status, 200, revoked.raw);
  assert.equal((await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: sellerConversationId, marketId: "JO" })).state, "INVALIDATED");
  assert.ok((await auditFor(owner.id, "DELEGATION_CREATED")).length >= 2);
  assert.ok((await auditFor(owner.id, "DELEGATION_REVOKED")).length >= 1);
  assert.ok((await auditFor(owner.id, "D5_EMPLOYEE_SESSION_STARTED")).length >= 2);
  assert.ok((await auditFor(owner.id, "D5_EMPLOYEE_SESSION_INVALIDATED")).length >= 2);
  app.locals.conversationModelGateway = undefined;
});

await test("W02-D5: two customers, accurate drafts, and one owner-reviewed send per reply", async () => {
  const owner = await register("Reply Owner");
  const buyerOne = await register("Buyer One");
  const buyerTwo = await register("Buyer Two");
  const businessId = await createBusiness(owner);
  const firstTitle = `جاكيت شتوي W02 ${safeTag()}`;
  const firstListingId = await publish(owner, firstTitle, 35);
  await attachToListingBusiness(owner, businessId, firstListingId);
  const secondTitle = `جاكيت صيفي W02 ${safeTag()}`;
  const secondListingId = await publish(owner, secondTitle, 17);
  await attachToListingBusiness(owner, businessId, secondListingId);
  const delegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  await activateGrant(owner, businessId, delegationId);

  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market);
  const buyerOneConversation = await conversation(buyerOne);
  const firstInquiry = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyerOne.id,
    market: market!,
    target: { kind: "LISTING", listingId: firstListingId },
    body: "عندك 50 قطعة؟",
    provenance: "BUYER_AUTHORED",
    originConversationId: buyerOneConversation,
  });
  const inbox = (await request("/ai/conversations", "GET", undefined, owner.cookie)).data
    .find((row: any) => row.title === INQUIRY_INBOX_TITLE);
  assert.ok(inbox, "the first customer inquiry opens the DINAR inquiry inbox");
  const inboxId = inbox.id as string;

  let step: Scripted = { action: "NONE", conversationalReply: "جلسة الموظف الذكي جاهزة لاستفسارات مشتريك." };
  const model = await scriptModel(owner, () => step);
  await say(owner, inboxId, "يا موظفي الذكي");
  assert.equal((await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: inboxId, marketId: "JO" })).state, "ACTIVE");

  // The employee sees only the assigned, screened question and the recorded stock.
  step = { action: "DRAFT_INQUIRY_REPLY", replyText: "المتوفر حاليًا 35 قطعة." };
  await resetModelLimit(owner.id);
  const firstDraft = await say(owner, inboxId, "جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  const firstDraftPayload = draftOf(firstDraft);
  assert.ok(firstDraftPayload, firstDraft.body);
  assert.equal(firstDraftPayload.inquiry.body, "المتوفر حاليًا 35 قطعة.");
  assert.match(model.lastRequest, /عندك 50 قطعة/u, "the model receives the buyer's screened question");
  assert.match(model.lastRequest, /35/u, "the assigned listing's recorded stock is supplied as a server fact");
  assert.match(firstDraft.body, /لن يُرسل شيء قبل موافقتك/u);

  const [firstInquiryRow] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, firstInquiry.inquiryId));
  assert.ok(firstInquiryRow);
  assert.equal((await threadMessages(firstInquiryRow!.threadConversationId)).filter((row) => row.senderId === owner.id).length, 0,
    "drafting sends nothing");

  await say(owner, inboxId, "أرسل");
  assert.equal((await threadMessages(firstInquiryRow!.threadConversationId)).filter((row) => row.senderId === owner.id).length, 1,
    "the owner's confirmation sends exactly one reply");
  const buyerView = await request(`/ai/conversations/${buyerOneConversation}`, "GET", undefined, buyerOne.cookie);
  assert.ok(JSON.stringify(buyerView.data).includes("المتوفر حاليًا 35 قطعة."), "the buyer receives the approved reply in DINAR");
  const [awaitingBuyer] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, firstInquiry.inquiryId));
  assert.equal(awaitingBuyer?.status, "AWAITING_BUYER");

  // A second customer writes about a different listing; the latest inbound card is the thread in view.
  const buyerTwoConversation = await conversation(buyerTwo);
  const secondInquiry = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyerTwo.id,
    market: market!,
    target: { kind: "LISTING", listingId: secondListingId },
    body: "هل يتوفر 17 حبة؟",
    provenance: "BUYER_AUTHORED",
    originConversationId: buyerTwoConversation,
  });
  step = { action: "DRAFT_INQUIRY_REPLY", replyText: "المتوفر حاليًا 17 قطعة." };
  await resetModelLimit(owner.id);
  const secondDraft = await say(owner, inboxId, "جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  const secondDraftPayload = draftOf(secondDraft);
  assert.ok(secondDraftPayload, secondDraft.body);
  assert.equal(secondDraftPayload.inquiry.body, "المتوفر حاليًا 17 قطعة.", "the reply is grounded in the second listing's stock");
  assert.equal(secondDraftPayload.inquiry.inquiry.inquiryId, secondInquiry.inquiryId);
  assert.match(model.lastRequest, /17 حبة|هل يتوفر/u);
  assert.doesNotMatch(model.lastRequest, /عندك 50 قطعة/u, "another customer's private question never enters the context");
  await say(owner, inboxId, "أرسل");

  const [firstThread, secondThread] = await Promise.all([
    db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, firstInquiry.inquiryId)).then((rows) => rows[0]!),
    db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, secondInquiry.inquiryId)).then((rows) => rows[0]!),
  ]);
  assert.equal((await threadMessages(firstThread.threadConversationId)).filter((row) => row.senderId === owner.id).length, 1);
  assert.equal((await threadMessages(secondThread.threadConversationId)).filter((row) => row.senderId === owner.id).length, 1);
  const firstReply = (await threadMessages(firstThread.threadConversationId)).find((row) => row.senderId === owner.id)!;
  const secondReply = (await threadMessages(secondThread.threadConversationId)).find((row) => row.senderId === owner.id)!;
  assert.match(firstReply.body, /35/u);
  assert.match(secondReply.body, /17/u);
  assert.equal(secondThread.status, "AWAITING_BUYER");
  assert.ok((await auditFor(owner.id, "D5_EMPLOYEE_CAPABILITY_AUTHORIZED")).length >= 2);

  // Replaying the approval: the review is settled, nothing else is sent and nothing claims success.
  const replay = await say(owner, inboxId, "أرسل");
  assert.match(replay.body, /لم يُرسل شيء/u, replay.body);
  assert.doesNotMatch(replay.body, /أُرسلت رسالتك ووصلت/u, replay.body);
  assert.equal((await threadMessages(secondThread.threadConversationId)).filter((row) => row.senderId === owner.id).length, 1,
    "a replayed approval must not send a second message");
  app.locals.conversationModelGateway = undefined;
});

await test("W02-D5: discount escalation, employee refusal, and the owner's confirmed counter", async () => {
  const owner = await register("Negotiation Owner");
  const buyer = await register("Negotiation Buyer");
  const businessId = await createBusiness(owner);
  const title = `جاكيت تفاوض W02 ${safeTag()}`;
  const listingId = await publish(owner, title, 20, true);
  await attachToListingBusiness(owner, businessId, listingId);
  const delegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  await activateGrant(owner, businessId, delegationId);
  const sellerConversationId = await conversation(owner);

  let step: Scripted = { action: "NONE", conversationalReply: "جلسة الموظف جاهزة." };
  const model = await scriptModel(owner, () => step);
  await say(owner, sellerConversationId, "يا موظفي الذكي");

  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const opened = await openNegotiation({
    buyerId: buyer.id,
    listingId,
    type: "BUYER_PRICE_OFFER",
    amountMinor: 2.5 * 10 ** market!.minorUnitScale,
    quantity: 1,
    market: market!,
  });
  assert.equal(opened.status, "OPEN");

  // The employee may only escalate; the offer stays exactly as the buyer sent it.
  step = { action: "ESCALATE_NEGOTIATION" };
  await resetModelLimit(owner.id);
  const escalated = await say(owner, sellerConversationId, "اعرض التفاوضات المفتوحة لمراجعة المالك");
  assert.ok(escalated.body.includes(title), escalated.body);
  assert.match(escalated.body, /لم يقبل عرضًا أو يرسل عرضًا مضادًا/u);
  const [openRow] = await db.select().from(negotiations).where(eq(negotiations.listingId, listingId));
  assert.equal(openRow?.status, "OPEN");
  assert.equal(openRow?.counterAmountMinor, null);
  assert.ok((await auditFor(owner.id, "D5_NEGOTIATION_ESCALATED")).length >= 1);

  // A model proposal to accept the discount is refused by the employee action guard.
  step = { action: "ESCALATE_NEGOTIATION", suggestedAction: "REVIEW_PRICE_OFFER" };
  await resetModelLimit(owner.id);
  const denied = await say(owner, sellerConversationId, `اقبل عرض السعر المقترح على ${title}`);
  assert.match(denied.body, /خارج صلاحيات جلسة الموظف/u);
  const [afterDenied] = await db.select().from(negotiations).where(eq(negotiations.listingId, listingId));
  assert.equal(afterDenied?.status, "OPEN", "the employee never accepts or counters");

  // The owner's counter is a review, then an explicit confirmation in the canonical engine —
  // neither step is a model decision, so the scripted gateway is never called again.
  // Re-showing the authorized list keeps the one open offer in view for the owner's decision.
  step = { action: "ESCALATE_NEGOTIATION" };
  await resetModelLimit(owner.id);
  const ownerNegotiationList = await say(owner, sellerConversationId, "اعرض التفاوضات المفتوحة لمراجعة المالك");
  const ownerNegotiationPayload = ownerNegotiationList.blocks
    .find((block) => block.payload?.surface === "NEGOTIATION_LIST")?.payload;
  assert.ok(ownerNegotiationPayload, ownerNegotiationList.body);
  assert.ok(ownerNegotiationList.body.includes("تأكيد المالك"), ownerNegotiationList.body);
  const callsBeforeCounter = model.calls;
  const counterReview = await say(owner, sellerConversationId, "عرض مضاد 3");
  assert.match(counterReview.body, /راجع عرضك المضاد/u, counterReview.body);
  const counterPayload = counterReview.blocks.find((block) => block.payload?.negotiation?.actionId)?.payload;
  assert.ok(counterPayload, counterReview.body);
  const counterActionId = String(counterPayload.negotiation.actionId);
  const [pendingCounter] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, counterActionId));
  assert.equal((pendingCounter?.query as any)?.action, "COUNTER_NEGOTIATION");
  assert.equal((pendingCounter?.query as any)?.status, "PENDING");
  const [beforeConfirm] = await db.select().from(negotiations).where(eq(negotiations.listingId, listingId));
  assert.equal(beforeConfirm?.status, "OPEN", "nothing changes before the owner confirms");

  const confirmed = await say(owner, sellerConversationId, "نعم");
  assert.match(confirmed.body, /أُرسل عرضك المضاد|أُرسل العرض المضاد|تم إرسال العرض المضاد/u, confirmed.body);
  const [countered] = await db.select().from(negotiations).where(eq(negotiations.listingId, listingId));
  assert.equal(countered?.status, "COUNTERED");
  assert.equal(countered?.counterAmountMinor, 3 * 10 ** market!.minorUnitScale);
  assert.equal(model.calls, callsBeforeCounter, "the review and the confirmation are canonical, not model decisions");
  const replay = await say(owner, sellerConversationId, "نعم");
  assert.doesNotMatch(replay.body, /أُرسل عرضك المضاد|تم إرسال العرض المضاد/u);
  const [afterReplay] = await db.select().from(negotiations).where(eq(negotiations.listingId, listingId));
  assert.equal(afterReplay?.status, "COUNTERED", "a replayed confirmation has one effect");
  app.locals.conversationModelGateway = undefined;
});

await test("W02-D5: the employee drafts but never publishes, and a failed turn leaves no receipt", async () => {
  const owner = await register("Draft Owner");
  const businessId = await createBusiness(owner);
  const listingId = await publish(owner, `منتج مسودة W02 ${safeTag()}`, 4);
  await attachToListingBusiness(owner, businessId, listingId);
  const delegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  await activateGrant(owner, businessId, delegationId);
  const sellerConversationId = await conversation(owner);
  const offersBefore = (await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, owner.id))).length;

  let step: Scripted = { action: "NONE", conversationalReply: "جلسة الموظف جاهزة." };
  const model = await scriptModel(owner, () => step);
  await say(owner, sellerConversationId, "يا موظفي الذكي");

  // A draft is a draft: the employee creates no listing and no pending publication.
  step = { action: "DRAFT_LISTING", item: "خدمة تنظيف" };
  await resetModelLimit(owner.id);
  const draft = await say(owner, sellerConversationId, "جهز مسودة لخدمة تنظيف منازل");
  const sellPayload = draft.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.equal(sellPayload?.draft?.categoryId, "services", draft.body);
  assert.equal((await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, owner.id))).length, offersBefore,
    "drafting publishes nothing");
  assert.equal((await db.select().from(aiResultSets).where(and(
    eq(aiResultSets.conversationId, sellerConversationId),
    eq(aiResultSets.marketId, "JO"),
  ))).filter((row) => (row.query as any)?.action === "PUBLISH_LISTING").length, 0);

  // An explicit publish request is refused by the employee action handler.
  step = { action: "DRAFT_LISTING", item: "خدمة تنظيف" };
  await resetModelLimit(owner.id);
  const refusedPublish = await say(owner, sellerConversationId, "انشر المسودة");
  assert.match(refusedPublish.body, /النشر يحتاج مراجعة المالك/u, refusedPublish.body);
  assert.equal((await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, owner.id))).length, offersBefore);

  // A model/tool failure produces an honest refusal, no draft, and no success claim.
  step = { action: "DRAFT_LISTING", fail: true };
  await resetModelLimit(owner.id);
  const callsBeforeFailure = model.calls;
  const failed = await say(owner, sellerConversationId, "جهز مسودة لهاتف مستعمل");
  assert.match(failed.body, /لم يتغير شيء|لم ينفّذ أي إجراء|تعذر/u);
  assert.doesNotMatch(failed.body, /تم (?:النشر|الإرسال|الإنشاء)/u);
  assert.ok(model.calls > callsBeforeFailure, "the failure came from the model call, not a silent skip");
  assert.equal((await db.select({ id: offers.id }).from(offers).where(eq(offers.sellerId, owner.id))).length, offersBefore);
  app.locals.conversationModelGateway = undefined;
});

await test("W02-D5: grant revocation invalidates the pending reply and blocks later employee turns", async () => {
  const owner = await register("Revocation Owner");
  const buyer = await register("Revocation Buyer");
  const businessId = await createBusiness(owner);
  const title = `منتج الإبطال W02 ${safeTag()}`;
  const listingId = await publish(owner, title, 12);
  await attachToListingBusiness(owner, businessId, listingId);
  const delegationId = await createGrant(owner, businessId, ALL_CAPABILITIES);
  await activateGrant(owner, businessId, delegationId);

  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  const buyerConversation = await conversation(buyer);
  const inquiry = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyer.id,
    market: market!,
    target: { kind: "LISTING", listingId },
    body: "هل يتوفر 12 قطعة؟",
    provenance: "BUYER_AUTHORED",
    originConversationId: buyerConversation,
  });
  const inboxId = (await request("/ai/conversations", "GET", undefined, owner.cookie)).data
    .find((row: any) => row.title === INQUIRY_INBOX_TITLE).id as string;

  let step: Scripted = { action: "NONE", conversationalReply: "جلسة الموظف جاهزة." };
  const model = await scriptModel(owner, () => step);
  await say(owner, inboxId, "يا موظفي الذكي");
  step = { action: "DRAFT_INQUIRY_REPLY", replyText: "المتوفر حاليًا 12 قطعة." };
  await resetModelLimit(owner.id);
  const draft = await say(owner, inboxId, "جهز ردًا على استفسار المشتري");
  const draftPayload = draftOf(draft);
  assert.ok(draftPayload, draft.body);
  const actionId = String(draftPayload.inquiry.actionId);
  const [beforeRevoke] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, actionId));
  assert.equal((beforeRevoke?.query as any)?.status, "PENDING");

  const revoked = await request(`/business/profiles/${businessId}/delegations/${delegationId}/revoke`, "POST", {
    confirm: true,
    expectedVersion: 2,
  }, owner.cookie);
  assert.equal(revoked.status, 200, revoked.raw);
  const [afterRevoke] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, actionId));
  assert.equal((afterRevoke?.query as any)?.status, "REJECTED", "revocation invalidates the pending employee action");
  assert.equal((afterRevoke?.query as any)?.invalidationReason, "GRANT_REVOKED");
  assert.ok((await auditFor(owner.id, "D5_PENDING_ACTION_INVALIDATED")).length >= 1);

  const callsBeforeApproval = model.calls;
  const blockedApproval = await say(owner, inboxId, "أرسل");
  assert.match(blockedApproval.body, /انتهت صلاحية جلسة الموظف|لم تعد مخولة/u, blockedApproval.body);
  assert.equal(model.calls, callsBeforeApproval, "a revoked session never calls the model");
  const [inquiryRow] = await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.id, inquiry.inquiryId));
  assert.equal((await threadMessages(inquiryRow!.threadConversationId)).filter((row) => row.senderId === owner.id).length, 0,
    "a revoked approval sends nothing");
  // Reopening the conversation shows the same draft card, rebuilt by the inquiry authority as
  // rejected: the owner can read what the employee wrote but has nothing left to approve.
  const rehydrated = await request(`/ai/conversations/${inboxId}`, "GET", undefined, owner.cookie);
  assert.equal(rehydrated.status, 200, rehydrated.raw);
  const rehydratedDraft = (rehydrated.data.messages as any[])
    .flatMap((message) => message.blocks ?? [])
    .find((block) => block.payload?.inquiry?.view === "DRAFT" && block.payload.inquiry.actionId === actionId)?.payload.inquiry;
  assert.ok(rehydratedDraft, "the rejected draft card survives a reload");
  assert.equal(rehydratedDraft.status, "REJECTED");
  assert.equal(rehydratedDraft.body, "المتوفر حاليًا 12 قطعة.", "the owner still reads the drafted text");
  app.locals.conversationModelGateway = undefined;
});

await new Promise<void>((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
