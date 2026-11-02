import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  authRateLimitBuckets,
  aiResultSets,
  businessDelegations,
  businessOperatingProfiles,
  marketplaceInquiryEvents,
  marketplaceInquiries,
  markets,
  messages,
  negotiations,
  offers,
  orderItems,
  orders,
  db,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import app from "../src/app";
import { refreshInquiryPayload, sellerEmployeeInquiryModelContext } from "../src/ai/inquiry-turn";
import { resolveSellerEmployeeSession } from "../src/lib/business-delegations";
import { authRateLimitKeyHash, AUTH_RATE_LIMIT_SCOPE } from "../src/lib/auth-rate-limiter";
import { assignListingToBusiness } from "../src/lib/business-catalog-contract";
import { openNegotiation } from "../src/lib/negotiations";
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

async function publish(actor: Actor, title: string, quantity: number, negotiable = false) {
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
    negotiable,
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
  const secondListingTitle = `جاكيت صيفي D5 ${randomUUID().slice(0, 8)}`;
  const secondListingId = await publish(owner, secondListingTitle, 17, true);
  await assignListingToBusiness({
    actorId: owner.id,
    marketId: "JO",
    listingId: secondListingId,
    businessId: business!.d2BusinessId,
  });
  const otherOwner = await register("Other Seller");
  const otherBusinessId = await createBusiness(otherOwner);
  const [otherBusiness] = await db.select().from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.id, otherBusinessId));
  assert.ok(otherBusiness);
  const outsideTitle = `مروحة خارج التفويض ${randomUUID().slice(0, 8)}`;
  const outsideListingId = await publish(otherOwner, outsideTitle, 11);
  await assignListingToBusiness({
    actorId: otherOwner.id,
    marketId: "JO",
    listingId: outsideListingId,
    businessId: otherBusiness!.d2BusinessId,
  });

  const grant = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: [
      "business.catalog.read",
      "business.catalog.draft",
      "business.catalog.draft.price",
      "business.inventory.read",
      "business.orders.read",
      "business.negotiations.escalate",
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
  let employeeAction = "DRAFT_INQUIRY_REPLY";
  let employeeSuggestedAction = "NONE";
  let employeeItemHint: string | undefined;
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
          suggestedAction: employeeSuggestedAction,
          sellerEmployeeAction: employeeAction,
          ...(employeeAction === "DRAFT_INQUIRY_REPLY" ? { sellerEmployeeReply: draftedReply } : {}),
          ...(employeeItemHint ? { entities: { item: employeeItemHint } } : {}),
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
  const sellerConversationId = await conversation(owner);
  employeeAction = "ANSWER_CATALOG";
  employeeItemHint = listingTitle;
  const catalogFact = await say(owner, sellerConversationId, `يا موظفي الذكي، ما تصنيف ${listingTitle}؟`);
  assert.ok(catalogFact.body.includes(listingTitle), catalogFact.body);
  assert.ok(catalogFact.body.includes("أخرى"), catalogFact.body);
  const unknownCatalogFact = await say(owner, sellerConversationId, `هل بطارية ${listingTitle} سعتها 5000؟`);
  assert.match(unknownCatalogFact.body, /لا تسجل بيانات العرض الحالية هذه المواصفة/u);
  assert.ok(!unknownCatalogFact.body.includes("5000"), "unknown product specifications must not be invented");

  employeeAction = "READ_INVENTORY";
  employeeItemHint = listingTitle;
  const verifiedStock = await say(owner, sellerConversationId, `كم المخزون المسجل في ${listingTitle}؟`);
  assert.match(verifiedStock.body, /35 متاح/u);
  await db.update(offers).set({ availableQuantity: 0 }).where(eq(offers.id, listingId));
  const zeroStock = await say(owner, sellerConversationId, `كم المخزون المسجل في ${listingTitle}؟`);
  assert.match(zeroStock.body, /غير متاح حاليًا/u);
  assert.ok(!zeroStock.body.includes("35 متاح"));
  await db.update(offers).set({ inventoryMode: "UNLIMITED", availableQuantity: null }).where(eq(offers.id, listingId));
  const unlimitedStock = await say(owner, sellerConversationId, `كم المخزون المسجل في ${listingTitle}؟`);
  assert.match(unlimitedStock.body, /الكمية غير محددة/u);
  assert.ok(!unlimitedStock.body.includes("0 متاح") && !unlimitedStock.body.includes("35 متاح"));
  await db.update(offers).set({ inventoryMode: "LIMITED", availableQuantity: 35 }).where(eq(offers.id, listingId));
  employeeItemHint = "جاكيت";
  const ambiguousStock = await say(owner, sellerConversationId, "كم مخزون الجاكيت؟");
  assert.match(ambiguousStock.body, /أكثر من عرض مطابق/u);
  assert.ok(!ambiguousStock.body.includes("35 متاح") && !ambiguousStock.body.includes("17 متاح"));
  employeeItemHint = outsideTitle;
  const outOfScopeStock = await say(owner, sellerConversationId, `كم مخزون ${outsideTitle}؟`);
  assert.match(outOfScopeStock.body, /لم أتمكن من تحديد عرض واحد/u);
  assert.ok(!outOfScopeStock.body.includes("11 متاح"), "D5 must not reveal inventory from another business");

  employeeAction = "READ_ORDERS";
  const orderId = `d5-order-${randomUUID()}`;
  const unitPriceMinor = 3 * 10 ** market!.minorUnitScale;
  // This reservation-only row exists solely inside the local-suite disposable database; no
  // payment, settlement, or persistent financial history is created.
  await db.insert(orders).values({
    id: orderId,
    buyerId: buyer.id,
    sellerId: owner.id,
    marketId: market!.id,
    countryCode: market!.countryCode,
    currencyCode: market!.currencyCode,
    minorUnitScale: market!.minorUnitScale,
    unitPriceMinor,
    quantity: 2,
    subtotalMinor: unitPriceMinor * 2,
    platformFeeMinor: 0,
    sellerAmountMinor: unitPriceMinor * 2,
    status: "RESERVED",
    data: {},
  });
  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId,
    offerId: listingId,
    quantity: 2,
    unitPriceMinor,
    subtotalMinor: unitPriceMinor * 2,
    data: { title: listingTitle },
  });
  const orderTurn = await say(owner, sellerConversationId, "اعرض طلبات النشاط");
  assert.ok(orderTurn.body.includes(orderId.slice(-8)), orderTurn.body);
  assert.ok(orderTurn.body.includes("RESERVED"), "the authorized order status must be read from the stored order");
  assert.ok(!orderTurn.body.includes(buyer.id), "order read must not disclose buyer identifiers");

  employeeAction = "ESCALATE_NEGOTIATION";
  const openedNegotiation = await openNegotiation({
    buyerId: buyer.id,
    listingId: secondListingId,
    type: "BUYER_PRICE_OFFER",
    amountMinor: 2.5 * 10 ** market!.minorUnitScale,
    quantity: 1,
    market: market!,
  });
  assert.equal(openedNegotiation.status, "OPEN");
  const negotiationTurn = await say(owner, sellerConversationId, "اعرض التفاوضات المفتوحة لمراجعة المالك");
  assert.ok(negotiationTurn.body.includes(secondListingTitle), negotiationTurn.body);
  assert.match(negotiationTurn.body, /لم أقبل عرضًا أو أرسل مقابلاً/u);
  employeeSuggestedAction = "REVIEW_PRICE_OFFER";
  const deniedNegotiation = await say(owner, sellerConversationId, "اقبل عرض السعر المقترح على الجاكيت");
  assert.match(deniedNegotiation.body, /خارج صلاحيات جلسة الموظف/u);
  const [unchangedNegotiation] = await db.select().from(negotiations)
    .where(eq(negotiations.listingId, secondListingId));
  assert.equal(unchangedNegotiation?.status, "OPEN", "a D5 proposal must not accept or counter a negotiation");
  employeeSuggestedAction = "NONE";

  employeeAction = "DRAFT_LISTING";
  employeeItemHint = "iPhone 13";
  const offersBeforeDraft = await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id));
  const sellerDraft = await say(owner, sellerConversationId, "جهز مسودة إعلان لهاتف آيفون 13 مستعمل بحالة جيدة وسعره 12");
  const sellerDraftPayload = sellerDraft.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.ok(sellerDraftPayload, sellerDraft.body);
  assert.match(String(sellerDraftPayload.draft?.title ?? ""), /آيفون 13/u);
  assert.equal(sellerDraftPayload.draft?.attributes?.condition, "مستعمل");
  assert.equal(sellerDraftPayload.draft?.unitPrice, "12");
  const offersAfterDraft = await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id));
  assert.equal(offersAfterDraft.length, offersBeforeDraft.length, "D5 may draft but must not publish a listing");
  const correctedSellerDraft = await say(owner, sellerConversationId, "خلي السعر 15");
  const correctedDraftPayload = correctedSellerDraft.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.ok(correctedDraftPayload, correctedSellerDraft.body);
  assert.equal(correctedDraftPayload.draft?.unitPrice, "15", "D5 price corrections must update the same unpublished draft");
  const deniedPublish = await say(owner, sellerConversationId, "انشر المسودة");
  assert.match(deniedPublish.body, /النشر يحتاج مراجعة المالك/u);
  const offersAfterDeniedPublish = await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id));
  assert.equal(offersAfterDeniedPublish.length, offersBeforeDraft.length, "D5 must not publish a drafted listing");
  employeeAction = "DRAFT_INQUIRY_REPLY";
  employeeItemHint = undefined;
  draftedReply = "تم استلام المبلغ بالكامل.";
  const falsePaymentClaim = await say(owner, sellerConversationId, "جهز ردًا على استفسار المشتري");
  assert.match(falsePaymentClaim.body, /لا يوجد في جلسة الموظف سجل مالي/u);
  assert.notEqual(inquiryOf(falsePaymentClaim)?.surface, "INQUIRY_DRAFT");
  draftedReply = standardStockReply;
  // The acceptance covers two separate workflows, not rate-limit behavior. Reset only
  // this test actor's conversation buckets in the disposable database between them.
  await db.delete(authRateLimitBuckets).where(inArray(authRateLimitBuckets.keyHash, [
    authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelActor, owner.id),
    authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelHeavyActor, owner.id),
  ]));
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
  assert.equal(refreshedReview?.inquiry.body, draftedReply, `${refreshedDraft.body}\n${JSON.stringify(refreshedDraft.blocks)}`);
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
  let releaseGrantLock!: () => void;
  let resolveGrantLockReady!: () => void;
  const grantLockReady = new Promise<void>((resolve) => { resolveGrantLockReady = resolve; });
  const grantLockRelease = new Promise<void>((resolve) => { releaseGrantLock = resolve; });
  const grantLockHolder = db.transaction(async (tx) => {
    await tx.select({ id: businessDelegations.id })
      .from(businessDelegations)
      .where(eq(businessDelegations.id, delegationId))
      .for("update");
    resolveGrantLockReady();
    await grantLockRelease;
  });
  await grantLockReady;
  const revokePromise = request(`/business/profiles/${businessId}/delegations/${delegationId}/revoke`, "POST", {
    confirm: true,
    expectedVersion: 2,
  }, owner.cookie);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const approvalPromise = say(owner, inbox.id, "أرسل");
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseGrantLock();
  const [revoke, blockedApproval] = await Promise.all([revokePromise, approvalPromise]);
  await grantLockHolder;
  assert.equal(revoke.status, 200, revoke.raw);
  const [invalidatedPendingAction] = await db.select().from(aiResultSets)
    .where(eq(aiResultSets.id, revokeReview!.inquiry.actionId));
  assert.equal((invalidatedPendingAction?.query as Record<string, unknown> | undefined)?.status, "REJECTED",
    "revoking a D5 grant must durably invalidate its pending review");
  const refreshedRevokedCard = await refreshInquiryPayload(
    { view: "DRAFT", actionId: revokeReview!.inquiry.actionId, body: draftedReply, lines: [] },
    owner.id,
    market!,
  );
  assert.equal(refreshedRevokedCard.status, "REJECTED", "rehydrated card must lose active approval state");
  const modelCallsBeforeBlockedConfirmation = modelCalls;
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
