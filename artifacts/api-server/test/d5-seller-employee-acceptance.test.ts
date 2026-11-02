import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  aiResultSets,
  businessOperatingProfiles,
  marketplaceInquiryEvents,
  marketplaceInquiries,
  markets,
  messages,
  offers,
  db,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { sellerEmployeeInquiryModelContext } from "../src/ai/inquiry-turn";
import { resolveSellerEmployeeSession } from "../src/lib/business-delegations";
import { assignListingToBusiness } from "../src/lib/business-catalog-contract";
import { INQUIRY_INBOX_TITLE, submitInquiryMessage } from "../src/lib/inquiries";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_D5_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;

type Actor = { id: string; cookie: string; phoneNumber: string; password: string };

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `203.0.113.${(ipSequence++ % 250) + 1}` } : {}),
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

const phoneBase = 55_800_000 + ((Date.now() + process.pid) % 100_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `D5-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR D5 ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie, phoneNumber, password };
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
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 500)}`);
  return {
    body: complete.assistantMessage.body as string,
    blocks: (complete.assistantMessage.blocks ?? []) as any[],
  };
}

const inquiryOf = (turn: { blocks: any[] }) => turn.blocks.find((block) => block.payload?.inquiry)?.payload;

async function createBusiness(actor: Actor): Promise<string> {
  const id = await conversation(actor);
  const turn = await say(actor, id, "عندي متجر اسمه متجر الموظف التجريبي");
  const business = turn.blocks.find((block) => block.payload?.business)?.payload.business;
  assert.equal(business?.view, "SETUP", turn.body);
  return business.businessId as string;
}

async function publish(actor: Actor, title: string, quantity: number) {
  const created = await request("/listings", "POST", {
    title,
    description: `${title} — وصف اختبار D5`,
    category: "أخرى",
    categoryId: "other",
    area: "خلدا",
    city: "عمان",
    attributes: {},
    unitPrice: "3",
    inventoryMode: "LIMITED",
    availableQuantity: quantity,
    fulfilmentType: "PICKUP",
    imageUrl: "",
    imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}

await test("D5 owner approves one model-drafted G2 reply grounded in the assigned inquiry", async () => {
  const owner = await register("Reply Owner");
  const buyer = await register("Reply Buyer");
  const businessId = await createBusiness(owner);
  const [business] = await db.select().from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.id, businessId));
  assert.ok(business);

  const listingTitle = `جاكيت شتوي D5 ${randomUUID().slice(0, 8)}`;
  const listingId = await publish(owner, listingTitle, 35);
  await assignListingToBusiness({
    actorId: owner.id,
    marketId: "JO",
    listingId,
    businessId: business!.d2BusinessId,
  });

  const grant = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: [
      "business.catalog.read",
      "business.inventory.read",
      "business.inquiries.reply",
      "business.messages.send",
    ],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `d5-reply-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(grant.status, 201, grant.raw);
  const delegationId = grant.data.delegation.id as string;
  const activated = await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(activated.status, 200, activated.raw);

  const buyerConversationId = await conversation(buyer);
  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market);
  const sentInquiry = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyer.id,
    market: market!,
    target: { kind: "LISTING", listingId },
    body: "عندك 50 قطعة؟",
    provenance: "BUYER_AUTHORED",
    originConversationId: buyerConversationId,
  });
  assert.equal(sentInquiry.duplicate, false);
  const inquiryId = sentInquiry.inquiryId;

  const conversations = await request("/ai/conversations", "GET", undefined, owner.cookie);
  const inbox = (conversations.data as any[]).find((row) => row.title === INQUIRY_INBOX_TITLE);
  assert.ok(inbox, "the buyer's G2 inquiry must be delivered to the seller's DINAR inbox");

  let draftedReply = "المتوفر حاليًا 35 قطعة. أستطيع الاستفسار عن إمكانية توفير الكمية المتبقية.";
  const standardStockReply = draftedReply;
  let modelRequest = "";
  let modelCalls = 0;
  app.locals.conversationModelGateway = {
    proposeToolCall: async (input: unknown) => {
      modelCalls += 1;
      modelRequest = JSON.stringify(input);
      return {
        id: `d5-reply-${randomUUID()}`,
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: "CONVERSATIONAL_RESPONSE",
          goal: "SELL",
          suggestedAction: "NONE",
          sellerEmployeeAction: "DRAFT_INQUIRY_REPLY",
          sellerEmployeeReply: draftedReply,
          confidence: 1,
          conversationalReply: "أعددت ردًا للمشتري لمراجعتك.",
        }),
      };
    },
  } as any;

  const [inquiryRow] = await db.select().from(marketplaceInquiries)
    .where(eq(marketplaceInquiries.id, inquiryId));
  const buyerThreadMessages = await db.select().from(messages)
    .where(eq(messages.conversationId, inquiryRow!.threadConversationId));
  const buyerMessage = buyerThreadMessages.find((row) => row.senderId === buyer.id)!;
  await db.update(messages).set({ body: "عندك 50 قطعة؟ اتصل على 962791234567" })
    .where(eq(messages.id, buyerMessage.id));
  const screenedTurn = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  assert.notEqual(inquiryOf(screenedTurn)?.surface, "INQUIRY_DRAFT");
  assert.ok(!modelRequest.includes("962791234567"), "buyer contact details must be screened before model context");
  assert.ok(!modelRequest.includes("عندك 50 قطعة"), "contact-bearing buyer text must not reach the model");
  await db.update(messages).set({ body: "عندك 50 قطعة؟" })
    .where(eq(messages.id, buyerMessage.id));

  const sessionResolution = await resolveSellerEmployeeSession({
    actorId: owner.id,
    conversationId: inbox.id,
    marketId: "JO",
  });
  assert.equal(sessionResolution.state, "ACTIVE");
  if (sessionResolution.state !== "ACTIVE") throw new Error("expected active persisted employee session");
  const modelContextInput = {
    actorId: owner.id,
    conversationId: inbox.id,
    market: market!,
    session: sessionResolution.session,
  };
  let inventoryContext = await sellerEmployeeInquiryModelContext(modelContextInput);
  assert.equal(inventoryContext?.availableQuantity, 35);
  await db.update(offers).set({ availableQuantity: 0 }).where(eq(offers.id, listingId));
  inventoryContext = await sellerEmployeeInquiryModelContext(modelContextInput);
  assert.equal(inventoryContext?.inventoryMode, "LIMITED");
  assert.equal(inventoryContext?.availableQuantity, 0, "zero stock must not be confused with an unknown quantity");
  await db.update(offers).set({ inventoryMode: "UNLIMITED", availableQuantity: null }).where(eq(offers.id, listingId));
  inventoryContext = await sellerEmployeeInquiryModelContext(modelContextInput);
  assert.equal(inventoryContext?.inventoryMode, "UNLIMITED");
  assert.equal(inventoryContext?.availableQuantity, null, "unlimited inventory has no numeric stock count");
  await db.update(offers).set({ inventoryMode: "LIMITED", availableQuantity: 0 }).where(eq(offers.id, listingId));
  draftedReply = "متوفر لدينا.";
  const falseAvailability = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري");
  assert.notEqual(inquiryOf(falseAvailability)?.surface, "INQUIRY_DRAFT");
  assert.match(falseAvailability.body, /المخزون المسجل صفر/u);
  await db.update(offers).set({ inventoryMode: "LIMITED", availableQuantity: 35 }).where(eq(offers.id, listingId));
  draftedReply = "نفد المخزون.";
  const falseUnavailability = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري");
  assert.notEqual(inquiryOf(falseUnavailability)?.surface, "INQUIRY_DRAFT");
  assert.match(falseUnavailability.body, /يخالف المخزون المسجل/u);
  draftedReply = "المتوفر حاليًا 50 قطعة.";
  const mismatchedQuantity = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري");
  assert.notEqual(inquiryOf(mismatchedQuantity)?.surface, "INQUIRY_DRAFT");
  assert.match(mismatchedQuantity.body, /كمية لا تطابق/u);
  draftedReply = "سيصل مخزون جديد غدًا.";
  const inventedRestock = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري");
  assert.notEqual(inquiryOf(inventedRestock)?.surface, "INQUIRY_DRAFT");
  assert.match(inventedRestock.body, /موعد إعادة توفير مسجل/u);
  draftedReply = standardStockReply;
  await db.update(offers).set({ inventoryMode: "LIMITED", availableQuantity: 35 }).where(eq(offers.id, listingId));

  const employeeDraft = await say(owner, inbox.id, "جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  const review = inquiryOf(employeeDraft);
  assert.equal(review?.surface, "INQUIRY_DRAFT", employeeDraft.body);
  assert.equal(review.inquiry.status, "PENDING");
  assert.equal(review.inquiry.provenance, "DINAR_DRAFT_APPROVED");
  assert.equal(review.inquiry.body, draftedReply);
  assert.ok(modelRequest.includes("عندك 50 قطعة؟"), "the model must receive the exact assigned buyer question");
  assert.ok(modelRequest.includes("35"), "the model must receive only the recorded available stock");
  assert.match(employeeDraft.body, /مشتري/u);
  assert.match(employeeDraft.body, new RegExp(listingTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));

  const [beforeApproval] = await db.select().from(marketplaceInquiries)
    .where(eq(marketplaceInquiries.id, inquiryId));
  const threadMessagesBefore = await db.select().from(messages)
    .where(eq(messages.conversationId, beforeApproval!.threadConversationId));
  assert.equal(threadMessagesBefore.filter((row) => row.senderId === owner.id).length, 0,
    "a model proposal is only a draft");
  const replyEventsBefore = await db.select().from(marketplaceInquiryEvents)
    .where(eq(marketplaceInquiryEvents.inquiryId, inquiryId));
  assert.equal(replyEventsBefore.filter((row) => row.eventType === "INQUIRY_REPLIED").length, 0);

  await db.update(offers).set({ availableQuantity: 34 }).where(eq(offers.id, listingId));
  const staleApproval = await say(owner, inbox.id, "أرسل");
  assert.match(staleApproval.body, /تغير المخزون/u, staleApproval.body);
  const [staleAction] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, review.inquiry.actionId));
  assert.equal((staleAction!.query as { status?: string }).status, "REJECTED");
  const messagesAfterStaleApproval = await db.select().from(messages)
    .where(eq(messages.conversationId, beforeApproval!.threadConversationId));
  assert.equal(messagesAfterStaleApproval.filter((row) => row.senderId === owner.id).length, 0);
  assert.equal((await db.select().from(marketplaceInquiryEvents)
    .where(eq(marketplaceInquiryEvents.inquiryId, inquiryId)))
    .filter((row) => row.eventType === "INQUIRY_REPLIED").length, 0);

  draftedReply = "المتوفر حاليًا 34 قطعة.";
  const refreshedDraft = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  const refreshedReview = inquiryOf(refreshedDraft);
  assert.equal(refreshedReview?.inquiry.body, draftedReply);
  assert.ok(modelRequest.includes("34"), "the refreshed model context must use current stock");
  const approved = await say(owner, inbox.id, "أرسل");
  assert.match(approved.body, /أُرسلت رسالتك ووصلت إلى محادثة المشتري/u, approved.body);
  const duplicateApproval = await say(owner, inbox.id, "أرسل");
  assert.doesNotMatch(duplicateApproval.body, /أُرسلت رسالتك ووصلت/u);
  const threadMessagesAfter = await db.select().from(messages)
    .where(eq(messages.conversationId, beforeApproval!.threadConversationId));
  const replies = threadMessagesAfter.filter((row) => row.senderId === owner.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.body, draftedReply);
  assert.equal((await db.select().from(marketplaceInquiryEvents)
    .where(eq(marketplaceInquiryEvents.inquiryId, inquiryId)))
    .filter((row) => row.eventType === "INQUIRY_REPLIED").length, 1);

  const nextQuestion = await submitInquiryMessage({
    actionId: randomUUID(),
    actorId: buyer.id,
    market: market!,
    target: { kind: "LISTING", listingId },
    body: "هل يمكنني معرفة خيارات التسليم؟",
    provenance: "BUYER_AUTHORED",
    originConversationId: buyerConversationId,
  });
  assert.equal(nextQuestion.inquiryId, inquiryId);
  draftedReply = "سأراجع خيارات التسليم المتاحة وأوافيك بالتفاصيل.";
  const pendingBeforeRevoke = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري");
  const revokeReview = inquiryOf(pendingBeforeRevoke);
  assert.equal(revokeReview?.inquiry.status, "PENDING");
  const revoke = await request(`/business/profiles/${businessId}/delegations/${delegationId}/revoke`, "POST", {
    confirm: true,
    expectedVersion: 2,
  }, owner.cookie);
  assert.equal(revoke.status, 200, revoke.raw);
  const modelCallsBeforeBlockedConfirmation = modelCalls;
  const blockedApproval = await say(owner, inbox.id, "أرسل");
  assert.match(blockedApproval.body, /انتهت صلاحية جلسة الموظف|لم تعد مخولة/u, blockedApproval.body);
  assert.equal(modelCalls, modelCallsBeforeBlockedConfirmation, "revoked D5 approval must not call the model");
  const finalThreadMessages = await db.select().from(messages)
    .where(eq(messages.conversationId, beforeApproval!.threadConversationId));
  assert.equal(finalThreadMessages.filter((row) => row.senderId === owner.id).length, 1,
    "revocation prevents a pending employee draft from sending");

  const noInventoryGrant = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: [
      "business.catalog.read",
      "business.inquiries.reply",
      "business.messages.send",
    ],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `d5-no-inventory-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(noInventoryGrant.status, 201, noInventoryGrant.raw);
  const noInventoryDelegationId = noInventoryGrant.data.delegation.id as string;
  const noInventoryActivated = await request(`/business/profiles/${businessId}/delegations/${noInventoryDelegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(noInventoryActivated.status, 200, noInventoryActivated.raw);
  const noInventoryReply = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا على استفسار المشتري اعتمادًا على مخزوني");
  assert.notEqual(inquiryOf(noInventoryReply)?.surface, "INQUIRY_DRAFT");
  assert.ok(!modelRequest.includes("هل يمكنني معرفة خيارات التسليم؟"),
    "without inventory.read, the assigned buyer question is withheld from model context");
  assert.equal((await db.select().from(messages)
    .where(eq(messages.conversationId, beforeApproval!.threadConversationId)))
    .filter((row) => row.senderId === owner.id).length, 1,
    "missing inventory authority cannot create another owner-reviewed send");

  const buyerReload = await request(`/ai/conversations/${buyerConversationId}`, "GET", undefined, buyer.cookie);
  assert.equal(buyerReload.status, 200, buyerReload.raw);
  assert.ok(JSON.stringify(buyerReload.data).includes("المتوفر حاليًا 34 قطعة."), "the buyer receives the one approved reply in DINAR");

  app.locals.conversationModelGateway = undefined;
});

await new Promise<void>((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
