import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  authRateLimitBuckets,
  aiResultSets,
  businessAuditEvents,
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
import {
  resolveSellerEmployeeSession,
  sellerEmployeeDraftBindingMatches,
} from "../src/lib/business-delegations";
import { authRateLimitKeyHash, AUTH_RATE_LIMIT_SCOPE } from "../src/lib/auth-rate-limiter";
import { assignListingToBusiness } from "../src/lib/business-catalog-contract";
import { openNegotiation } from "../src/lib/negotiations";
import { INQUIRY_INBOX_TITLE, submitInquiryMessage } from "../src/lib/inquiries";
import { categorySchema, listMarketplaceCategories } from "../src/lib/marketplace-categories";
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
const safeTag = () => randomUUID().replace(/[0-9]/g, "x").slice(0, 8);
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
  const resetConversationModelLimit = async () => {
    await db.delete(authRateLimitBuckets).where(inArray(authRateLimitBuckets.keyHash, [
      authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelActor, owner.id),
      authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelHeavyActor, owner.id),
    ]));
  };
  const businessId = await createBusiness(owner);
  const [business] = await db.select().from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.id, businessId));
  assert.ok(business);

  const listingTitle = `جاكيت شتوي D5 ${safeTag()}`;
  const listingId = await publish(owner, listingTitle, 35);
  await assignListingToBusiness({
    actorId: owner.id,
    marketId: "JO",
    listingId,
    businessId: business!.d2BusinessId,
  });
  const secondListingTitle = `جاكيت صيفي D5 ${safeTag()}`;
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
  const outsideTitle = `مروحة خارج التفويض ${safeTag()}`;
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
  let employeeConversationalReply = "أعددت ردًا للمشتري لمراجعتك.";
  let employeeReplyAfterCorrection: string | undefined;
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
          conversationalReply: modelRequest.includes("SERVER_CHECK") && employeeReplyAfterCorrection
            ? employeeReplyAfterCorrection
            : employeeConversationalReply,
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
  assert.match(negotiationTurn.body, /لم يقبل عرضًا أو يرسل عرضًا مضادًا/u);
  employeeSuggestedAction = "REVIEW_PRICE_OFFER";
  const deniedNegotiation = await say(owner, sellerConversationId, "اقبل عرض السعر المقترح على الجاكيت");
  assert.match(deniedNegotiation.body, /خارج صلاحيات جلسة الموظف/u);
  const [unchangedNegotiation] = await db.select().from(negotiations)
    .where(eq(negotiations.listingId, secondListingId));
  assert.equal(unchangedNegotiation?.status, "OPEN", "a D5 proposal must not accept or counter a negotiation");
  employeeSuggestedAction = "NONE";
  const ownerNegotiationList = await say(owner, sellerConversationId, "اعرض التفاوضات المفتوحة لمراجعة المالك");
  const ownerNegotiationPayload = ownerNegotiationList.blocks
    .find((block) => block.payload?.surface === "NEGOTIATION_LIST")?.payload;
  assert.ok(ownerNegotiationPayload, ownerNegotiationList.body);
  assert.ok(ownerNegotiationList.body.includes("لم يقبل عرضًا") &&
    ownerNegotiationList.body.includes("تأكيد المالك"), ownerNegotiationList.body);
  const modelCallsBeforeOwnerDecision = modelCalls;
  const counterReview = await say(owner, sellerConversationId, "عرض مضاد 2.75");
  assert.match(counterReview.body, /راجع عرضك المضاد/u, counterReview.body);
  const counterReviewPayload = counterReview.blocks
    .find((block) => block.payload?.negotiation?.actionId)?.payload;
  assert.ok(counterReviewPayload, counterReview.body);
  const counterActionId = String(counterReviewPayload.negotiation.actionId);
  const [pendingCounter] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, counterActionId));
  assert.equal((pendingCounter?.query as { action?: string; status?: string } | undefined)?.action, "COUNTER_NEGOTIATION");
  assert.equal((pendingCounter?.query as { status?: string } | undefined)?.status, "PENDING");
  const [beforeCounterConfirmation] = await db.select().from(negotiations)
    .where(eq(negotiations.listingId, secondListingId));
  assert.equal(beforeCounterConfirmation?.status, "OPEN");
  const countered = await say(owner, sellerConversationId, "نعم");
  assert.match(countered.body, /أُرسل عرضك المضاد|أُرسل العرض المضاد|تم إرسال العرض المضاد/u, countered.body);
  const [afterCounterConfirmation] = await db.select().from(negotiations)
    .where(eq(negotiations.listingId, secondListingId));
  assert.equal(afterCounterConfirmation?.status, "COUNTERED");
  assert.ok(Number(afterCounterConfirmation?.counterAmountMinor) > Number(afterCounterConfirmation?.offerAmountMinor));
  assert.equal(modelCalls, modelCallsBeforeOwnerDecision,
    "owner counter and confirmation must use the canonical negotiation engine without an AI call");

  employeeAction = "DRAFT_LISTING";
  const categorySchemas = new Map(
    (await listMarketplaceCategories()).map((row) => [row.id, categorySchema(row)]),
  );
  const categoryDraftCases = [
    { categoryId: "services", itemHint: "خدمة تنظيف", request: "جهز مسودة لخدمة تنظيف منازل" },
    { categoryId: "digital-services", itemHint: "تصميم شعار رقمي", request: "جهز مسودة لخدمة رقمية تصميم شعار" },
    { categoryId: "cars", itemHint: "تويوتا كورولا", request: "جهز مسودة سيارة تويوتا كورولا 2020 مستعملة" },
    { categoryId: "other", itemHint: "ماكينة صناعية", request: "جهز مسودة ماكينة صناعية", chooseCategory: "أخرى" },
  ];
  for (const scenario of categoryDraftCases) {
    const categoryConversationId = await conversation(owner);
    employeeAction = "NONE";
    employeeItemHint = undefined;
    await resetConversationModelLimit();
    await say(owner, categoryConversationId, "يا موظفي الذكي");
    employeeAction = "DRAFT_LISTING";
    employeeItemHint = scenario.itemHint;
    await resetConversationModelLimit();
    let categoryDraftTurn = await say(owner, categoryConversationId, scenario.request);
    let categoryDraft = categoryDraftTurn.blocks
      .find((block) => block.payload?.surface === "SELL")?.payload;
    assert.ok(categoryDraft, categoryDraftTurn.body);
    if (!categoryDraft.draft?.categoryId && "chooseCategory" in scenario) {
      await resetConversationModelLimit();
      categoryDraftTurn = await say(owner, categoryConversationId, scenario.chooseCategory);
      categoryDraft = categoryDraftTurn.blocks
        .find((block) => block.payload?.surface === "SELL")?.payload;
      assert.ok(categoryDraft, categoryDraftTurn.body);
    }
    assert.equal(categoryDraft.draft?.categoryId, scenario.categoryId, categoryDraftTurn.body);
    const schema = categorySchemas.get(scenario.categoryId);
    assert.ok(schema, `acceptance fixture must include category ${scenario.categoryId}`);
    const allowedAttributes = new Set(Object.keys(schema!.attributes));
    const providedAttributes = Object.keys(categoryDraft.draft?.attributes ?? {});
    assert.ok(providedAttributes.every((key) => allowedAttributes.has(key)),
      `${scenario.categoryId} draft must not invent category attributes: ${providedAttributes.join(",")}`);
    const requiredAttributes = Object.entries(schema!.attributes)
      .filter(([, attribute]) => attribute.requiredForPublish)
      .map(([key]) => key);
    const missingAttributes = new Set(
      (categoryDraft.draftReview?.missingFields ?? []).map((field: { field: string }) => field.field),
    );
    for (const key of requiredAttributes)
      assert.ok(categoryDraft.draft?.attributes?.[key] != null || missingAttributes.has(key),
        `${scenario.categoryId} must provide or request required ${key}`);

    if (scenario.categoryId === "services" || scenario.categoryId === "cars") {
      const answers: Record<string, string> = scenario.categoryId === "cars"
        ? {
            category: "سيارات",
            title: "تويوتا كورولا 2020 مستعملة",
            description: "سيارة تويوتا كورولا مستعملة بحالة جيدة",
            price: "12000",
            quantity: "1",
            area: "عمان خلدا",
            fulfilment: "استلام",
            contact: "محادثة DINAR فقط",
            payment_methods: "كاش",
            "attribute:make": "تويوتا",
            "attribute:model": "كورولا",
            "attribute:year": "2020",
            "attribute:condition": "مستعمل",
          }
        : {
            category: "خدمات",
            title: "خدمة تنظيف منازل",
            description: "خدمة تنظيف منازل في عمان مع تحديد الموعد مع المالك",
            price: "حسب الطلب",
            quantity: "1",
            area: "عمان خلدا",
            fulfilment: "خدمة داخل عمان",
            contact: "محادثة DINAR فقط",
            payment_methods: "كاش",
          };
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const missing = (categoryDraft.draftReview?.missingFields ?? []) as Array<{ field: string }>;
        if (!missing.length) break;
        const answer = answers[missing[0]!.field];
        assert.ok(answer, `${scenario.categoryId} workflow needs an owner-provided answer for ${missing[0]!.field}`);
        await resetConversationModelLimit();
        categoryDraftTurn = await say(owner, categoryConversationId, answer);
        categoryDraft = categoryDraftTurn.blocks
          .find((block) => block.payload?.surface === "SELL")?.payload;
        assert.ok(categoryDraft, categoryDraftTurn.body);
      }
      assert.equal(categoryDraft.draftReview?.missingFields?.length, 0,
        `${scenario.categoryId} owner journey must collect all required fields: ${JSON.stringify(categoryDraft.draftReview?.missingFields)}`);

      employeeAction = "REQUEST_PUBLICATION_REVIEW";
      await resetConversationModelLimit();
      const ownerReview = await say(owner, categoryConversationId, "أرسل المسودة لي للمراجعة");
      const ownerReviewPayload = ownerReview.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
      assert.equal(ownerReviewPayload?.draftStep, "publish_review", ownerReview.body);
      const ownerReviewId = String(ownerReviewPayload.resultSetId);
      const [pendingOwnerReview] = await db.select().from(aiResultSets)
        .where(eq(aiResultSets.id, ownerReviewId));
      assert.equal(pendingOwnerReview?.query.action, "PUBLISH_LISTING");
      assert.equal(pendingOwnerReview?.query.status, "PENDING");
      const offersBeforeCategoryApproval = (await db.select({ id: offers.id }).from(offers)
        .where(eq(offers.sellerId, owner.id))).length;
      const approvedCategoryDraft = await say(owner, categoryConversationId, "نعم");
      assert.match(approvedCategoryDraft.body, /تم نشر الإعلان/u, approvedCategoryDraft.body);
      assert.equal((await db.select({ id: offers.id }).from(offers)
        .where(eq(offers.sellerId, owner.id))).length, offersBeforeCategoryApproval + 1,
      `${scenario.categoryId} listing is published only after owner confirmation`);
      employeeAction = "DRAFT_LISTING";
    }
  }

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
  const d5DraftBindings = await db.select().from(businessAuditEvents)
    .where(eq(businessAuditEvents.resourceId, String(sellerDraftPayload.draft?.draftId)));
  const d5DraftBinding = d5DraftBindings.find((event) =>
    event.action === "D5_DRAFT_SCOPE_BOUND" &&
    event.businessId === businessId &&
    event.detail.conversationId === sellerConversationId,
  );
  assert.ok(d5DraftBinding, "D5 draft scope must be stored server-side, not exposed in the conversation card");
  const boundDraftScope = {
    businessId: d5DraftBinding!.businessId,
    conversationId: String(d5DraftBinding!.detail.conversationId),
    marketId: String(d5DraftBinding!.detail.marketId),
    sessionId: String(d5DraftBinding!.detail.sessionId),
  };
  assert.equal(sellerEmployeeDraftBindingMatches(boundDraftScope, boundDraftScope), true);
  assert.equal(sellerEmployeeDraftBindingMatches(boundDraftScope, {
    ...boundDraftScope,
    sessionId: "another-d5-session",
  }), false, "a new or switched D5 session must not inherit an older draft binding");
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

  const reviewAnswers: Record<string, string> = {
    category: "أخرى",
    title: "هاتف آيفون 13 مستعمل",
    description: "هاتف مستعمل مع خدش بسيط على الشاشة",
    price: "15",
    quantity: "1",
    area: "عمان خلدا",
    fulfilment: "استلام",
    contact: "محادثة DINAR فقط",
    payment_methods: "كاش",
  };
  let completedDraftPayload = correctedDraftPayload;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const missing = (completedDraftPayload.draftReview?.missingFields ?? []) as Array<{ field: string }>;
    if (!missing.length) break;
    const answer = reviewAnswers[missing[0]!.field];
    assert.ok(answer, `test fixture needs a seller-provided answer for ${missing[0]!.field}`);
    await resetConversationModelLimit();
    const completion = await say(owner, sellerConversationId, answer);
    completedDraftPayload = completion.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
    assert.ok(completedDraftPayload, completion.body);
  }
  assert.equal(completedDraftPayload.draftReview?.missingFields?.length, 0,
    `the owner completes only required draft fields before review: ${JSON.stringify(completedDraftPayload.draftReview?.missingFields)}`);
  employeeAction = "REQUEST_PUBLICATION_REVIEW";
  await resetConversationModelLimit();
  const publicationReview = await say(owner, sellerConversationId, "أرسل المسودة لي للمراجعة");
  const publicationReviewPayload = publicationReview.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.equal(publicationReviewPayload?.draftStep, "publish_review", publicationReview.body);
  const publicationActionId = publicationReviewPayload.resultSetId as string;
  const [publicationAction] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, publicationActionId));
  assert.equal(publicationAction?.query.action, "PUBLISH_LISTING");
  assert.equal(publicationAction?.query.status, "PENDING");
  assert.equal(publicationAction?.query.delegatedAuthority?.sessionId, (
    await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: sellerConversationId, marketId: "JO" })
  ).state === "ACTIVE" ? (
    await resolveSellerEmployeeSession({ actorId: owner.id, conversationId: sellerConversationId, marketId: "JO" })
  ).session.id : undefined, "publication approval must remain bound to the live D5 grant");
  const duplicatePublicationReview = await say(owner, sellerConversationId, "أرسل المسودة لي للمراجعة");
  const duplicateReviewPayload = duplicatePublicationReview.blocks
    .find((block) => block.payload?.surface === "SELL")?.payload;
  assert.equal(duplicateReviewPayload?.resultSetId, publicationActionId,
    "repeated review requests must reuse the same pending owner review");

  employeeAction = "DRAFT_LISTING";
  employeeItemHint = "iPhone 13";
  const editedAfterReview = await say(owner, sellerConversationId, "خلي السعر 16");
  const editedAfterReviewPayload = editedAfterReview.blocks
    .find((block) => block.payload?.surface === "SELL")?.payload;
  assert.equal(editedAfterReviewPayload?.draft?.unitPrice, "16");
  const staleOwnerApproval = await say(owner, sellerConversationId, "نعم");
  assert.doesNotMatch(staleOwnerApproval.body, /تم نشر الإعلان/u,
    "approval for an older draft version must not publish the edited draft");
  const [unconfirmedStaleAction] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, publicationActionId));
  assert.equal(unconfirmedStaleAction?.query.status, "EXPIRED",
    "an approval tied to the previous draft version must be expired, not left reusable");

  employeeAction = "REQUEST_PUBLICATION_REVIEW";
  await resetConversationModelLimit();
  const refreshedPublicationReview = await say(owner, sellerConversationId, "أرسل المسودة لي للمراجعة");
  const refreshedReviewPayload = refreshedPublicationReview.blocks
    .find((block) => block.payload?.surface === "SELL")?.payload;
  const refreshedPublicationActionId = String(refreshedReviewPayload?.resultSetId);
  assert.equal(refreshedReviewPayload?.draftStep, "publish_review", refreshedPublicationReview.body);
  assert.notEqual(refreshedPublicationActionId, publicationActionId,
    "an edited draft requires a fresh owner review");
  const [refreshedPublicationAction] = await db.select().from(aiResultSets)
    .where(eq(aiResultSets.id, refreshedPublicationActionId));
  assert.equal(refreshedPublicationAction?.query.kind, "ACTION");
  assert.equal(refreshedPublicationAction?.query.action, "PUBLISH_LISTING");
  assert.equal(refreshedPublicationAction?.query.status, "PENDING");
  const refreshedSession = await resolveSellerEmployeeSession({
    actorId: owner.id,
    conversationId: sellerConversationId,
    marketId: "JO",
  });
  assert.equal(refreshedSession.state, "ACTIVE");
  assert.equal(refreshedPublicationAction?.query.delegatedAuthority?.sessionId,
    refreshedSession.state === "ACTIVE" ? refreshedSession.session.id : undefined);
  const countBeforeOwnerApproval = (await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length;
  const ownerApprovedPublication = await say(owner, sellerConversationId, "نعم");
  assert.match(ownerApprovedPublication.body, /تم نشر الإعلان/u);
  const countAfterOwnerApproval = (await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length;
  assert.equal(countAfterOwnerApproval, countBeforeOwnerApproval + 1, "only the owner's confirmed canonical publication creates the listing");
  const [settledPublicationAction] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, refreshedPublicationActionId));
  assert.equal(settledPublicationAction?.query.status, "CONFIRMED");
  const repeatedApproval = await say(owner, sellerConversationId, "نعم");
  const countAfterRepeatedApproval = (await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length;
  assert.equal(countAfterRepeatedApproval, countAfterOwnerApproval, "a repeated owner confirmation cannot publish a duplicate");

  const marketingTitle = `آيفون 13 مستعمل D5 ${safeTag()}`;
  const marketingListingId = await publish(owner, marketingTitle, 8);
  await assignListingToBusiness({
    actorId: owner.id,
    marketId: "JO",
    listingId: marketingListingId,
    businessId: business!.d2BusinessId,
  });
  const [marketingListing] = await db.select().from(offers).where(eq(offers.id, marketingListingId));
  assert.ok(marketingListing);
  await db.update(offers).set({
    data: {
      ...marketingListing!.data,
      description: "هاتف مستعمل مع خدش واضح على الشاشة",
      attributes: { condition: "مستعمل", defect: "خدش واضح على الشاشة" },
    },
  }).where(eq(offers.id, marketingListingId));
  employeeAction = "NONE";
  employeeConversationalReply = "هاتف مضمون لسنتين، الكمية محدودة، وأفضل صفقة اليوم.";
  employeeReplyAfterCorrection = "هاتف آيفون 13 مستعمل يظهر في وصفه خدش واضح على الشاشة.";
  await resetConversationModelLimit();
  const marketingCopy = await say(owner, sellerConversationId, `اكتب إعلانًا جذابًا لهاتف ${marketingTitle} مع الحفاظ على ذكر الخدش والضمان`);
  assert.ok(modelRequest.includes("خدش واضح على الشاشة"), "the model receives defect details from the authorized business listing");
  assert.ok(marketingCopy.body.includes("خدش واضح على الشاشة"), marketingCopy.body);
  assert.ok(!marketingCopy.body.includes("مضمون لسنتين") && !marketingCopy.body.includes("الكمية محدودة"),
    "unsupported warranty and scarcity claims must be rejected and rewritten");
  const [unchangedMarketingListing] = await db.select().from(offers).where(eq(offers.id, marketingListingId));
  assert.equal(unchangedMarketingListing?.data.description, "هاتف مستعمل مع خدش واضح على الشاشة",
    "proposed marketing copy is not silently saved into the published listing");
  employeeConversationalReply = "أعددت ردًا للمشتري لمراجعتك.";
  employeeReplyAfterCorrection = undefined;

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

  const refusedBulkReply = await say(owner, inbox.id, "يا موظفي الذكي، جهز ردًا لكل المشترين");
  assert.match(refusedBulkReply.body, /لا يرسل موظف D5 رسائل جماعية/u);
  assert.notEqual(inquiryOf(refusedBulkReply)?.surface, "INQUIRY_DRAFT");
  assert.equal((await db.select().from(messages)
    .where(eq(messages.conversationId, inquiryRow!.threadConversationId)))
    .filter((row) => row.senderId === owner.id).length, 0,
  "a bulk request must not create a buyer message");

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

await test("D5 tool failure, retry, and revoked publication review stay safe", async () => {
  const owner = await register("Retry Owner");
  const businessId = await createBusiness(owner);
  const grant = await request(`/business/profiles/${businessId}/delegations`, "POST", {
    employee: { type: "INTELLIGENT" },
    capabilities: [
      "business.catalog.read",
      "business.catalog.draft",
      "business.catalog.draft.price",
    ],
    resourceScope: { kind: "BUSINESS" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `d5-retry-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(grant.status, 201, grant.raw);
  const delegationId = grant.data.delegation.id as string;
  const activated = await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(activated.status, 200, activated.raw);
  const conversationId = await conversation(owner);
  let shouldFail = true;
  let action = "DRAFT_LISTING";
  app.locals.conversationModelGateway = {
    proposeToolCall: async () => {
      if (shouldFail) throw new Error("simulated local tool failure");
      return {
        id: `d5-retry-${randomUUID()}`,
        name: "dinarConversationTurn",
        arguments: JSON.stringify({
          responseKind: "CONVERSATIONAL_RESPONSE",
          goal: "SELL",
          sellerEmployeeAction: action,
          entities: { item: "iPhone 13" },
          confidence: 1,
          conversationalReply: "أجهز المسودة وفق التفاصيل التي قدمتها.",
        }),
      };
    },
  } as any;

  const offersBefore = (await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length;
  const failedTool = await say(owner, conversationId, "يا موظفي الذكي، جهز مسودة لهاتف آيفون 13 مستعمل بسعر 12");
  assert.match(failedTool.body, /لم يتغير شيء|لم ينفّذ أي إجراء/u);
  assert.equal((await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length, offersBefore);
  assert.equal((await db.select().from(businessAuditEvents)
    .where(eq(businessAuditEvents.actorId, owner.id)))
    .filter((event) => event.action === "D5_DRAFT_SCOPE_BOUND").length, 0,
  "a failed model/tool turn must not bind or persist a draft");

  shouldFail = false;
  const retry = await say(owner, conversationId, "جهز مسودة لهاتف آيفون 13 مستعمل بسعر 12");
  let draftPayload = retry.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.ok(draftPayload, retry.body);
  const firstDraftId = String(draftPayload.draft?.draftId);
  const repeatedRetry = await say(owner, conversationId, "جهز مسودة لهاتف آيفون 13 مستعمل بسعر 12");
  draftPayload = repeatedRetry.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.equal(draftPayload?.draft?.draftId, firstDraftId,
    "replaying a drafting turn after a lost response must resume the same conversation draft");
  assert.equal((await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length, offersBefore,
  "D5 retries must not publish an offer");

  const answers: Record<string, string> = {
    category: "إلكترونيات",
    title: "هاتف آيفون 13 مستعمل",
    description: "هاتف مستعمل بحالة جيدة",
    price: "12",
    quantity: "1",
    area: "عمان خلدا",
    fulfilment: "استلام",
    contact: "محادثة DINAR فقط",
    payment_methods: "كاش",
  };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const missing = (draftPayload.draftReview?.missingFields ?? []) as Array<{ field: string }>;
    if (!missing.length) break;
    const answer = answers[missing[0]!.field];
    assert.ok(answer, `test fixture needs an owner-provided answer for ${missing[0]!.field}`);
    await db.delete(authRateLimitBuckets).where(inArray(authRateLimitBuckets.keyHash, [
      authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelActor, owner.id),
      authRateLimitKeyHash(AUTH_RATE_LIMIT_SCOPE.conversationModelHeavyActor, owner.id),
    ]));
    const completion = await say(owner, conversationId, answer);
    draftPayload = completion.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
    assert.ok(draftPayload, completion.body);
  }
  assert.equal(draftPayload.draftReview?.missingFields?.length, 0,
    `owner must provide every required field before publication review: ${JSON.stringify(draftPayload.draftReview?.missingFields)}`);

  action = "REQUEST_PUBLICATION_REVIEW";
  const review = await say(owner, conversationId, "أرسل المسودة لي للمراجعة");
  const reviewPayload = review.blocks.find((block) => block.payload?.surface === "SELL")?.payload;
  assert.equal(reviewPayload?.draftStep, "publish_review", review.body);
  const reviewActionId = String(reviewPayload.resultSetId);
  const [pendingReview] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, reviewActionId));
  assert.equal(pendingReview?.query.action, "PUBLISH_LISTING");
  assert.equal(pendingReview?.query.status, "PENDING");

  const revoked = await request(`/business/profiles/${businessId}/delegations/${delegationId}/revoke`, "POST", {
    confirm: true,
    expectedVersion: 2,
  }, owner.cookie);
  assert.equal(revoked.status, 200, revoked.raw);
  const ownerApprovalAfterRevoke = await say(owner, conversationId, "نعم");
  assert.doesNotMatch(ownerApprovalAfterRevoke.body, /تم نشر الإعلان/u);
  assert.equal((await db.select({ id: offers.id }).from(offers)
    .where(eq(offers.sellerId, owner.id))).length, offersBefore,
  "a pending owner publication review cannot publish after D5 grant revocation");
  const [revokedReview] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, reviewActionId));
  assert.notEqual(revokedReview?.query.status, "PENDING");
  app.locals.conversationModelGateway = undefined;
});

await test("D5 withholds inquiry context when multiple buyer threads are unselected", async () => {
  const owner = await register("Multi Inquiry Owner");
  const businessId = await createBusiness(owner);
  const [business] = await db.select().from(businessOperatingProfiles)
    .where(eq(businessOperatingProfiles.id, businessId));
  assert.ok(business);
  const listingId = await publish(owner, `مخزون متعدد المحادثات ${safeTag()}`, 35);
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
    idempotencyKey: `d5-multi-inquiry-${randomUUID()}`,
  }, owner.cookie);
  assert.equal(grant.status, 201, grant.raw);
  const delegationId = grant.data.delegation.id as string;
  const activated = await request(`/business/profiles/${businessId}/delegations/${delegationId}/activate`, "POST", {
    confirm: true,
    expectedVersion: 1,
  }, owner.cookie);
  assert.equal(activated.status, 200, activated.raw);

  const [market] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.ok(market);
  const sellerConversationId = await conversation(owner);
  await say(owner, sellerConversationId, "يا موظفي الذكي");
  const inquiryIds: string[] = [];
  for (const label of ["First", "Second"]) {
    const buyer = await register(`${label} Multi Buyer`);
    const originConversationId = await conversation(buyer);
    const inquiry = await submitInquiryMessage({
      actionId: randomUUID(),
      actorId: buyer.id,
      market: market!,
      target: { kind: "LISTING", listingId },
      body: "هل لديكم مخزون؟",
      provenance: "BUYER_AUTHORED",
      originConversationId,
    });
    inquiryIds.push(inquiry.inquiryId);
  }
  assert.equal(new Set(inquiryIds).size, 2);
  await db.update(marketplaceInquiries).set({ sellerConversationId })
    .where(inArray(marketplaceInquiries.id, inquiryIds));
  const rows = await db.select().from(marketplaceInquiries)
    .where(eq(marketplaceInquiries.sellerConversationId, sellerConversationId));
  assert.equal(rows.filter((row) => inquiryIds.includes(row.id) && row.status === "AWAITING_SELLER").length, 2);

  const session = await resolveSellerEmployeeSession({
    actorId: owner.id,
    conversationId: sellerConversationId,
    marketId: "JO",
  });
  assert.equal(session.state, "ACTIVE");
  if (session.state !== "ACTIVE") throw new Error("expected active D5 session");
  const context = await sellerEmployeeInquiryModelContext({
    actorId: owner.id,
    conversationId: sellerConversationId,
    market: market!,
    session: session.session,
  });
  assert.equal(context, null,
    "two open buyer questions without an explicitly selected inquiry must not enter model context");
});

await new Promise<void>((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
