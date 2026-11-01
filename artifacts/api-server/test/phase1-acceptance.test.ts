import { after, test } from "node:test";
import { deleteDisposableUsers } from "./disposable-user-cleanup";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { localObjectStorage } from "./local-object-storage";
import app from "../src/app";
import {
  aiResultSets,
  aiUiBlocks,
  cartItems,
  carts,
  checkoutRequests,
  conversations,
  db,
  disputes,
  marketAudit,
  marketplaceCategoryAudit,
  markets,
  messages,
  offers,
  orderItems,
  orders,
  marketplaceCategories,
  policyAcceptances,
  phoneVerificationChallenges,
  pool,
  sellerDues,
  sellerMarketEligibility,
  sessions,
  users,
} from "@workspace/db";
import {
  getModelGatewayCallCount,
  resetModelGatewayCallCount,
} from "../src/ai/model-gateway";
import { phase1DevelopmentListings } from "./phase1-dev-fixtures";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { defaultMarketplaceCategoryRules } from "@workspace/api-zod/marketplace-schemas";
import { DeterministicPhotoSuggestionProvider } from "../src/ai/listing-photo-intelligence";

requireSafeReplitDevelopmentDatabase("BDINAR_PHASE1_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const execFileAsync = promisify(execFile);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api`;
let authRequestSequence = 0;
const verificationChallengeIds: string[] = [];

type ApiResponse = {
  status: number;
  data: any;
  cookie: string;
  raw: string;
};

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = "",
): Promise<ApiResponse> {
  const effectiveBody =
    body === undefined && ["POST", "DELETE"].includes(method) ? {} : body;
  const authRateLimitedPath = [
    "/auth/register",
    "/auth/login",
    "/auth/phone-verification/challenges",
    "/auth/phone-verification/challenges/verify",
    "/account/password",
  ].includes(path);
  const authIp = authRateLimitedPath
    ? `198.18.${Math.floor(authRequestSequence / 250) % 250}.${(authRequestSequence++ % 250) + 1}`
    : undefined;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(!["GET", "HEAD", "OPTIONS"].includes(method)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Cookie: token } : {}),
      ...(authIp ? { "X-Forwarded-For": authIp } : {}),
    },
    body: effectiveBody === undefined ? undefined : JSON.stringify(effectiveBody),
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
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    raw,
  };
}

async function registrationProof(phoneNumber: string) {
  const started = await request(
    "/auth/phone-verification/challenges",
    "POST",
    { phoneCountryCode: "+965", phoneNumber },
  );
  assert.equal(started.status, 202, started.raw);
  verificationChallengeIds.push(started.data.challengeId);
  const verified = await request(
    "/auth/phone-verification/challenges/verify",
    "POST",
    {
      challengeId: started.data.challengeId,
      code: started.data.developmentCode,
    },
  );
  assert.equal(verified.status, 200, verified.raw);
  assert.equal(verified.cookie, "");
  return verified.data.verificationToken as string;
}

function parseCompletion(raw: string): any {
  const events = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return undefined;
      }
    });
  return events.find((event) => event?.type === "complete");
}

function blockPayload(complete: any): any {
  return complete?.assistantMessage?.blocks?.[0]?.payload;
}

function filterFor(set: any, field: string): any {
  return (set.query.filters ?? []).find((filter: any) => filter.field === field);
}

function assertFilter(
  set: any,
  field: string,
  operator: string,
  value: string | number,
): void {
  const filter = filterFor(set, field);
  assert.ok(filter, `expected ${field} filter in ${JSON.stringify(set.query)}`);
  assert.equal(filter.operator, operator);
  assert.equal(String(filter.value), String(value));
}

await test("Phase 1 persisted marketplace acceptance journeys", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const createdUserIds: string[] = [];
  const ownedOfferIds: string[] = [];
  const conversationIds: string[] = [];
  const uploadedPhotoObjectPaths: string[] = [];
  const initialAuditIds = new Set<string>();
  const modelCalls: Array<{ phrase: string; calls: number }> = [];
  let cookie = "";
  let activeMarketBefore: string | undefined;
  let buyerId: string | undefined;
  let goldenBuyerId: string | undefined;
  let goldenBuyerCookie = "";
  let goldenOrderId: string | undefined;
  let goldenPhotoOfferId: string | undefined;
  let browserTestWeb:
    | Awaited<ReturnType<typeof startDinarBrowserTestWeb>>
    | undefined;
  let testCategoryId: string | undefined;
  let serviceAliasesBefore: string[] | undefined;
  let kwRestrictionsBefore: string[] | undefined;
  let kwSellerEligibilityModeBefore: string | undefined;

  const createConversation = async (): Promise<string> => {
    const response = await request("/ai/conversations", "POST", {}, cookie);
    assert.equal(response.status, 201, response.raw);
    conversationIds.push(response.data.id);
    return response.data.id;
  };

  const turn = async (
    conversationId: string,
    phrase: string,
    requireNoModelCall = true,
    imageObjectPaths?: string[],
  ): Promise<any> => {
    const before = getModelGatewayCallCount();
    const response = await fetch(
      `${base}/ai/conversations/${conversationId}/turns`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ message: phrase, imageObjectPaths }),
      },
    );
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const complete = parseCompletion(raw);
    assert.ok(complete, `missing completed turn for ${phrase}: ${raw}`);
    const calls = getModelGatewayCallCount() - before;
    modelCalls.push({ phrase, calls });
    if (requireNoModelCall)
      assert.equal(
        calls,
        0,
        `unexpected model call for deterministic phrase ${phrase}`,
      );
    return complete;
  };

  const latestResultSet = async (conversationId: string): Promise<any> => {
    const [result] = await db
      .select()
      .from(aiResultSets)
      .where(eq(aiResultSets.conversationId, conversationId))
      .orderBy(desc(aiResultSets.createdAt))
      .limit(1);
    assert.ok(result, `no persisted result set for ${conversationId}`);
    return result;
  };

  try {
    resetModelGatewayCallCount();

    const configuredMarkets = await db
      .select({
        id: markets.id,
        currencyCode: markets.currencyCode,
        minorUnitScale: markets.minorUnitScale,
        isActive: markets.isActive,
        status: markets.status,
      })
      .from(markets)
      .where(inArray(markets.id, ["KW", "JO"]));
    assert.equal(configuredMarkets.length, 2);
    for (const market of configuredMarkets) {
      assert.equal(market.isActive, true, `${market.id} must be active`);
      assert.ok(
        ["ACTIVE", "LIMITED"].includes(market.status),
        `${market.id} must be searchable`,
      );
    }
    const marketById = new Map(configuredMarkets.map((market) => [market.id, market]));

    const phoneBase =
      50_000_000 + ((Date.now() + process.pid) % 900_000);
    const registrationPassword = "Phase1-Acceptance-2026!";
    const registered = await request(
      "/auth/register",
      "POST",
      {
        displayName: `DINAR Phase 1 Test ${runId.slice(0, 8)}`,
        accountCountry: "KW",
        phoneCountryCode: "+965",
        phoneNumber: String(phoneBase),
        password: registrationPassword,
        confirmPassword: registrationPassword,
        acceptTerms: true,
        verificationToken: await registrationProof(String(phoneBase)),
      },
    );
    assert.equal(registered.status, 201, registered.raw);
    buyerId = registered.data.user.id;
    createdUserIds.push(buyerId);
    cookie = registered.cookie;
    assert.ok(cookie, "registration should establish an authenticated session");
    const goldenBuyerRegistered = await request(
      "/auth/register",
      "POST",
      {
        displayName: `DINAR Phase 1 Golden Buyer ${runId.slice(0, 8)}`,
        accountCountry: "KW",
        phoneCountryCode: "+965",
        phoneNumber: String(phoneBase + 2),
        password: registrationPassword,
        confirmPassword: registrationPassword,
        acceptTerms: true,
        verificationToken: await registrationProof(String(phoneBase + 2)),
      },
    );
    assert.equal(goldenBuyerRegistered.status, 201, goldenBuyerRegistered.raw);
    const goldenBuyerRegisteredId = goldenBuyerRegistered.data.user.id as string;
    goldenBuyerId = goldenBuyerRegisteredId;
    createdUserIds.push(goldenBuyerRegisteredId);
    goldenBuyerCookie = goldenBuyerRegistered.cookie;
    assert.ok(
      goldenBuyerCookie,
      "the golden-journey buyer should have an authenticated session",
    );

    const [buyerRow] = await db
      .select({ activeMarketId: users.activeMarketId })
      .from(users)
      .where(eq(users.id, buyerId));
    activeMarketBefore = buyerRow?.activeMarketId;
    assert.ok(activeMarketBefore, "registered test user must have an active market");

    const auditBefore = await db
      .select({ id: marketAudit.id })
      .from(marketAudit)
      .where(eq(marketAudit.actorId, buyerId));
    for (const row of auditBefore) initialAuditIds.add(row.id);

    const [buyer] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, buyerId));

    const fixtureIdByKey = new Map<string, string>();
    for (const { marketId, listing } of phase1DevelopmentListings) {
      const market = marketById.get(marketId);
      assert.ok(market, `missing configured market ${marketId}`);
      const id = `phase1_acceptance_${runId}_${listing.id}`;
      fixtureIdByKey.set(listing.id, id);
      ownedOfferIds.push(id);
      await db.insert(offers).values({
        id,
        sellerId: buyerId,
        marketId,
        status: "PUBLISHED",
        unitPriceMinor: Math.round(
          Number(listing.unitPrice) * 10 ** market.minorUnitScale,
        ),
        inventoryMode: listing.inventoryMode,
        availableQuantity: listing.availableQuantity,
        reservedQuantity: 0,
        data: {
          ...listing,
          id,
          sellerId: buyerId,
          sellerName: buyer.displayName,
          testFixture: "phase1-acceptance",
          testOwned: true,
          rating: 0,
          reviewCount: 0,
        },
      });
    }

    const kwChange = await request(
      "/account/market",
      "PATCH",
      { marketId: "KW" },
      cookie,
    );
    assert.equal(kwChange.status, 200, kwChange.raw);

    const carConversationId = await createConversation();
    await turn(carConversationId, "أريد مرسيدس");
    let resultSet = await latestResultSet(carConversationId);
    assert.equal(resultSet.marketId, "KW");
    assert.equal(resultSet.query.categoryId, "cars");
    assertFilter(resultSet, "make", "contains", "مرسيدس");

    const mercedesIds = phase1DevelopmentListings
      .filter(({ marketId, listing }) => marketId === "KW" && listing.attributes.make === "مرسيدس")
      .map(({ listing }) => fixtureIdByKey.get(listing.id)!);
    assert.ok(mercedesIds.every((id) => resultSet.resourceIds.includes(id)));

    await turn(carConversationId, "2022 وفوق");
    resultSet = await latestResultSet(carConversationId);
    assert.equal(resultSet.query.categoryId, "cars");
    assertFilter(resultSet, "make", "contains", "مرسيدس");
    assertFilter(resultSet, "year", "gte", 2022);
    assert.ok(
      resultSet.resourceIds.includes(
        fixtureIdByKey.get("dev_phase1_mercedes_2022_a")!,
      ),
    );
    assert.ok(
      !resultSet.resourceIds.includes(
        fixtureIdByKey.get("dev_phase1_mercedes_2021")!,
      ),
    );

    await turn(carConversationId, "أقل من 20 ألف");
    resultSet = await latestResultSet(carConversationId);
    assertFilter(resultSet, "make", "contains", "مرسيدس");
    assertFilter(resultSet, "year", "gte", 2022);
    assertFilter(resultSet, "price", "lt", 20_000);
    assert.ok(
      resultSet.resourceIds.includes(
        fixtureIdByKey.get("dev_phase1_mercedes_2022_a")!,
      ),
    );
    assert.ok(
      resultSet.resourceIds.includes(
        fixtureIdByKey.get("dev_phase1_mercedes_2023")!,
      ),
    );
    assert.ok(
      !resultSet.resourceIds.includes(
        fixtureIdByKey.get("dev_phase1_mercedes_2024")!,
      ),
    );
    const resultSetId = resultSet.id;
    const orderedIds = [...resultSet.resourceIds];
    assert.ok(orderedIds.length >= 2, "ordinal reference requires at least two results");

    const detail = await turn(carConversationId, "الثانية");
    const detailPayload = blockPayload(detail);
    assert.ok(detailPayload, "second result should render a detail card");
    assert.equal(detailPayload.resultSetId, resultSetId);
    assert.equal(detailPayload.resourceIds?.[0], orderedIds[1]);

    await turn(carConversationId, "رجوع");
    resultSet = await latestResultSet(carConversationId);
    assert.equal(resultSet.query.categoryId, "cars");
    assertFilter(resultSet, "make", "contains", "مرسيدس");
    assertFilter(resultSet, "year", "gte", 2022);
    assertFilter(resultSet, "price", "lt", 20_000);
    assert.deepEqual(resultSet.resourceIds, orderedIds);

    await turn(carConversationId, "خليها أقل من 18 ألف");
    resultSet = await latestResultSet(carConversationId);
    assertFilter(resultSet, "make", "contains", "مرسيدس");
    assertFilter(resultSet, "year", "gte", 2022);
    assertFilter(resultSet, "price", "lt", 18_000);
    assert.equal(
      (resultSet.query.filters as any[]).filter((filter) => filter.field === "price").length,
      1,
      "price refinement should replace, not accumulate, the previous price filter",
    );

    await turn(carConversationId, "في عمان فقط");
    resultSet = await latestResultSet(carConversationId);
    assertFilter(resultSet, "make", "contains", "مرسيدس");
    assertFilter(resultSet, "year", "gte", 2022);
    assertFilter(resultSet, "price", "lt", 18_000);
    assertFilter(resultSet, "city", "contains", "عمان");

    const emptyConversationId = await createConversation();
    await turn(emptyConversationId, "أريد مرسيدس موديل 2099");
    const emptySet = await latestResultSet(emptyConversationId);
    assert.equal(emptySet.marketId, "KW");
    assertFilter(emptySet, "make", "contains", "مرسيدس");
    assertFilter(emptySet, "year", "eq", 2099);
    assert.deepEqual(emptySet.resourceIds, []);

    const inactiveId = fixtureIdByKey.get("dev_phase1_mercedes_2021")!;
    await db
      .update(offers)
      .set({ status: "DRAFT" })
      .where(eq(offers.id, inactiveId));
    const inactiveConversationId = await createConversation();
    await turn(inactiveConversationId, "أريد مرسيدس");
    const inactiveSet = await latestResultSet(inactiveConversationId);
    assert.ok(!inactiveSet.resourceIds.includes(inactiveId));
    await db
      .update(offers)
      .set({ status: "PUBLISHED" })
      .where(eq(offers.id, inactiveId));

    const joChange = await request(
      "/account/market",
      "PATCH",
      { marketId: "JO" },
      cookie,
    );
    assert.equal(joChange.status, 200, joChange.raw);
    const propertyConversationId = await createConversation();
    await turn(
      propertyConversationId,
      "أريد شقة للإيجار في عمان غرفتين أقل من 350",
    );
    const propertySet = await latestResultSet(propertyConversationId);
    assert.equal(propertySet.marketId, "JO");
    assert.equal(propertySet.query.categoryId, "property");
    assertFilter(propertySet, "transactionType", "contains", "إيجار");
    assertFilter(propertySet, "city", "contains", "عمان");
    assertFilter(propertySet, "bedrooms", "eq", 2);
    assertFilter(propertySet, "price", "lt", 350);
    assert.ok(
      propertySet.resourceIds.includes(
        fixtureIdByKey.get("dev_phase1_property_apartment")!,
      ),
    );

    const jordanCarConversationId = await createConversation();
    await turn(jordanCarConversationId, "أريد مرسيدس");
    const jordanCarSet = await latestResultSet(jordanCarConversationId);
    assert.equal(jordanCarSet.marketId, "JO");
    assert.ok(
      mercedesIds.every((id) => !jordanCarSet.resourceIds.includes(id)),
      "Jordan search must not expose Kuwait-only fixtures",
    );
    if (jordanCarSet.resourceIds.length) {
      const scopedRows = await db
        .select({ id: offers.id, marketId: offers.marketId })
        .from(offers)
        .where(inArray(offers.id, jordanCarSet.resourceIds));
      assert.ok(scopedRows.every((row) => row.marketId === "JO"));
    }

    const backToKw = await request(
      "/account/market",
      "PATCH",
      { marketId: "KW" },
      cookie,
    );
    assert.equal(backToKw.status, 200, backToKw.raw);

    const sellConversationId = await createConversation();
    const initialDraft = await turn(sellConversationId, "أريد أبيع كامري 2020");
    let draftPayload = blockPayload(initialDraft);
    assert.equal(draftPayload?.surface, "SELL");
    assert.equal(draftPayload?.draft?.category, "سيارات");
    assert.match(draftPayload?.draft?.title ?? "", /كامري/);
    assert.equal(draftPayload?.draft?.attributes?.make, "تويوتا");
    assert.equal(draftPayload?.draft?.attributes?.model, "كامري");
    assert.equal(draftPayload?.draft?.attributes?.year, 2020);

    const afterPrice = await turn(sellConversationId, "8500");
    draftPayload = blockPayload(afterPrice);
    assert.equal(draftPayload?.draft?.unitPrice, "8500");

    const afterMileage = await turn(sellConversationId, "90 ألف");
    draftPayload = blockPayload(afterMileage);
    assert.equal(draftPayload?.draft?.unitPrice, "8500");
    assert.equal(draftPayload?.draft?.attributes?.mileage, 90_000);

    const description = "سيارة مستعملة بحالة جيدة، لون أبيض، وفحصها حديث.";
    const sellerAnswers: Record<string, string> = {
      description,
      "attribute:condition": "مستعمل",
      "attribute:mileage": "90000",
      quantity: "1",
      area: "الشويخ",
      fulfilment: "استلام",
      contact: "محادثة فقط",
      payment_methods: "كاش",
    };
    let review = afterMileage;
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = blockPayload(review);
      if (current?.draftStep === "review") break;
      const answer = sellerAnswers[current?.draftStep];
      assert.ok(answer, `Unexpected required seller field: ${current?.draftStep}`);
      review = await turn(sellConversationId, answer);
    }
    draftPayload = blockPayload(review);
    assert.equal(draftPayload?.surface, "SELL");
    assert.equal(draftPayload?.draftStep, "review");
    assert.equal(draftPayload?.draft?.unitPrice, "8500");
    assert.equal(draftPayload?.draft?.attributes?.mileage, 90_000);

    const persistedConversation = await request(
      `/ai/conversations/${sellConversationId}`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(persistedConversation.status, 200, persistedConversation.raw);
    assert.equal(
      persistedConversation.data.messages.at(-1).blocks[0].payload.draft.attributes
        .mileage,
      90_000,
      "draft values should survive loading the saved conversation",
    );

    const beforePublish = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.sellerId, buyerId), eq(offers.marketId, "KW")));
    const publish = await request(
      "/listings",
      "POST",
      {
        title: draftPayload.draft.title,
        description: draftPayload.draft.description,
        category: draftPayload.draft.category,
        area: draftPayload.draft.area,
        city: "الكويت",
        attributes: {
          ...draftPayload.draft.attributes,
          make: "تويوتا",
          model: "كامري",
          year: 2020,
          mileage: 90_000,
          condition: "مستعمل",
          color: "أبيض",
        },
        unitPrice: draftPayload.draft.unitPrice,
        inventoryMode: draftPayload.draft.inventoryMode,
        availableQuantity: Number(draftPayload.draft.availableQuantity),
        fulfilmentType: draftPayload.draft.fulfilmentType,
        imageUrl: draftPayload.draft.imageUrl ?? "",
      },
      cookie,
    );
    assert.equal(publish.status, 201, publish.raw);
    const publishedId = publish.data.id as string;
    ownedOfferIds.push(publishedId);
    const cancelDraftConversation = await createConversation();
    await turn(cancelDraftConversation, "أريد أبيع سماعة مستعملة");
    const cancelledDraft = blockPayload(await turn(cancelDraftConversation, "الغِ الإعلان"));
    assert.equal(cancelledDraft.draftStep, "cancelled");
    assert.equal(cancelledDraft.draft, undefined);
    const [publishedAfterDraftCancel] = await db.select().from(offers).where(eq(offers.id, publishedId));
    assert.equal(publishedAfterDraftCancel.status, "PUBLISHED");
    const afterPublish = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.sellerId, buyerId), eq(offers.marketId, "KW")));
    assert.equal(afterPublish.length, beforePublish.length + 1);

    const publishedSearchConversationId = await createConversation();
    await turn(publishedSearchConversationId, "أريد كامري 2020");
    const publishedSearchSet = await latestResultSet(
      publishedSearchConversationId,
    );
    assert.ok(publishedSearchSet.resourceIds.includes(publishedId));

    const [serviceCategory] = await db
      .select({ aliases: marketplaceCategories.aliases })
      .from(marketplaceCategories)
      .where(eq(marketplaceCategories.id, "services"));
    assert.ok(serviceCategory, "the registry should include the generic services category");
    serviceAliasesBefore = serviceCategory.aliases;
    await db
      .update(users)
      .set({ role: "ADMIN" })
      .where(eq(users.id, buyerId));
    const categoryId = `agri-equipment-${runId.slice(0, 8)}`;
    const categoryCreated = await request(
      "/admin/categories",
      "POST",
      {
        id: categoryId,
        label: "معدات زراعية",
        labelEn: "Agricultural equipment",
        parentId: null,
        aliases: ["معدات زراعية", "مضخة مياه"],
        resourceType: "PRODUCT",
        renderer: "GENERIC",
        attributes: {},
        searchFilters: {},
        allowAdditionalAttributes: true,
        rules: defaultMarketplaceCategoryRules("PRODUCT"),
        isActive: true,
      },
      cookie,
    );
    assert.equal(categoryCreated.status, 201, categoryCreated.raw);
    testCategoryId = categoryId;
    const translatorAliases = await request(
      "/admin/categories/services",
      "PATCH",
      { aliases: [...new Set([...serviceAliasesBefore, "مترجم", "مترجمة"])] },
      cookie,
    );
    assert.equal(translatorAliases.status, 200, translatorAliases.raw);
    assert.ok(
      (await request("/categories")).data.some(
        (category: any) => category.id === categoryId,
      ),
      "the new category should be available through the public registry",
    );

    const publishGenericDraft = async (
      prompt: string,
      replies: string[],
      expected: {
        categoryId: string;
        title?: string;
        unitPrice: number;
        quantity: number | null;
        fulfilmentType: string;
        marketId?: string;
        area?: string;
        city?: string;
        attributes?: Record<string, string | number>;
      },
    ) => {
      const conversationId = await createConversation();
      let complete = await turn(conversationId, prompt);
      const trace: Array<{ reply: string; draftStep: unknown; draft: unknown }> = [];
      const recordStep = (reply: string, result: any) => {
        const resultPayload = blockPayload(result);
        trace.push({
          reply,
          draftStep: resultPayload?.draftStep,
          draft: resultPayload?.draft,
        });
      };
      recordStep(prompt, complete);
      const category = (await request("/categories")).data.find(
        (entry: any) => entry.id === expected.categoryId,
      );
      assert.ok(category);
      for (let attempt = 0; attempt < 16; attempt++) {
        const current = blockPayload(complete);
        if (current?.draftStep === "review") break;
        const field = current?.draftStep;
        const answer: Record<string, string | undefined> = {
          category: category.label,
          title: expected.title,
          description: replies.find((reply) => reply.length >= 10 && reply !== "محادثة فقط"),
          price: String(expected.unitPrice),
          quantity: expected.quantity === null ? undefined : String(expected.quantity),
          area: expected.area ?? replies.find((reply) => ["عمان", "الكويت", "خلدا", "عن بعد"].includes(reply)),
          fulfilment: expected.fulfilmentType === "SERVICE" ? "خدمة" : "استلام",
          contact: "محادثة فقط",
          payment_methods: "كاش",
        };
        const reply = field?.startsWith("attribute:")
          ? String(expected.attributes?.[field.slice(10)] ?? (field === "attribute:condition" ? "مستعمل" : ""))
          : answer[field];
        assert.ok(reply, `Missing acceptance answer for ${field}`);
        complete = await turn(conversationId, reply);
        recordStep(reply, complete);
      }
      const payload = blockPayload(complete);
      assert.equal(payload?.surface, "SELL");
      assert.equal(
        payload?.draftStep,
        "review",
        JSON.stringify({ prompt, trace }, null, 2),
      );
      assert.equal(payload?.draft?.categoryId, expected.categoryId);
      if (expected.title)
        assert.equal(payload?.draft?.title, expected.title);
      assert.equal(Number(payload?.draft?.unitPrice), expected.unitPrice);
      if (expected.area !== undefined)
        assert.equal(payload?.draft?.area, expected.area);
      if (expected.city !== undefined)
        assert.equal(payload?.draft?.city, expected.city);
      for (const [key, value] of Object.entries(expected.attributes ?? {}))
        assert.equal(payload?.draft?.attributes?.[key], value);
      const isService = expected.fulfilmentType === "SERVICE";
      if (isService) {
        assert.equal(payload?.draft?.inventoryMode, "UNLIMITED");
        assert.equal(payload?.draft?.availableQuantity ?? null, null);
      } else {
        assert.equal(Number(payload?.draft?.availableQuantity), expected.quantity);
      }
      assert.equal(payload?.draft?.fulfilmentType, expected.fulfilmentType);

      const body = {
        title: payload.draft.title,
        description: payload.draft.description,
        category: payload.draft.category,
        categoryId: payload.draft.categoryId,
        area: payload.draft.area,
        city: payload.draft.city ?? "الكويت",
        attributes: payload.draft.attributes ?? {},
        unitPrice: payload.draft.unitPrice,
        inventoryMode:
          payload.draft.inventoryMode ??
          (isService ? "UNLIMITED" : "LIMITED"),
        availableQuantity: isService
          ? null
          : Number(payload.draft.availableQuantity ?? "1"),
        fulfilmentType: payload.draft.fulfilmentType,
        imageUrl: payload.draft.imageUrl ?? "",
      };
      const created = await request("/listings", "POST", body, cookie);
      assert.equal(created.status, 201, created.raw);
      const id = created.data.id as string;
      ownedOfferIds.push(id);
      const [persisted] = await db
        .select()
        .from(offers)
        .where(eq(offers.id, id));
      assert.ok(persisted, `the published offer ${id} must persist`);
      assert.equal(persisted.status, "PUBLISHED");
      assert.equal(persisted.data.categoryId, expected.categoryId);
      const expectedMarketId = expected.marketId ?? "KW";
      assert.equal(persisted.marketId, expectedMarketId);
      assert.equal(
        persisted.unitPriceMinor,
        Math.round(
          expected.unitPrice *
            10 ** marketById.get(expectedMarketId)!.minorUnitScale,
        ),
      );
      assert.equal(persisted.inventoryMode, isService ? "UNLIMITED" : "LIMITED");
      assert.equal(persisted.availableQuantity, expected.quantity);
      return { id, conversationId, body, payload, persisted };
    };

    const soilOffer = await publishGenericDraft(
      "أريد أبيع جهاز قياس رطوبة للتربة",
      [
        "18",
        "جهاز قياس رطوبة للتربة بحالة جيدة ويعمل بشكل طبيعي.",
        "تخطي",
        "تخطي",
        "2",
        "عمان",
        "استلام",
        "أخرى",
        "محادثة فقط",
      ],
      {
        categoryId: "other",
        title: "جهاز قياس رطوبة للتربة",
        unitPrice: 18,
        quantity: 2,
        fulfilmentType: "PICKUP",
      },
    );
    const mercedesOffer = await publishGenericDraft(
      "أريد أبيع مرسيدس C200 موديل 2021 ماشية 70 ألف",
      ["سيارة مستعملة بحالة جيدة وصيانتها منتظمة.", "عمان"],
      {
        categoryId: "cars", unitPrice: 8500, quantity: 1, fulfilmentType: "PICKUP",
        attributes: { make: "مرسيدس", model: "c200", year: 2021, mileage: 70000, condition: "مستعمل" },
      },
    );
    const electricianOffer = await publishGenericDraft(
      "أنا كهربائي وأريد أعرض خدمتي في عمان",
      ["خدمة صيانة كهرباء منزلية وفحص الأعطال.", "عمان"],
      { categoryId: "services", unitPrice: 25, quantity: null, fulfilmentType: "SERVICE", title: "خدمة كهربائي" },
    );
    const tableOffer = await publishGenericDraft(
      "أريد أبيع طاولة خشب مستعملة بـ 15 دينار",
      [
        "طاولة خشب مستعملة بحالة جيدة للاستخدام المنزلي.",
        "تخطي",
        "تخطي",
        "1",
        "عمان",
        "استلام",
        "أخرى",
        "محادثة فقط",
      ],
      {
        categoryId: "other",
        title: "طاولة خشب مستعملة",
        unitPrice: 15,
        quantity: 1,
        fulfilmentType: "PICKUP",
      },
    );
    const cupsOffer = await publishGenericDraft(
      "عندي 200 كوب مطبوع للبيع، الحبة بنص دينار",
      [
        "أكواب مطبوعة بحالة جديدة.",
        "تخطي",
        "تخطي",
        "200",
        "الكويت",
        "استلام",
        "أخرى",
        "محادثة فقط",
      ],
      {
        categoryId: "other",
        title: "كوب مطبوع",
        unitPrice: 0.5,
        quantity: 200,
        fulfilmentType: "PICKUP",
      },
    );
    const translationOffer = await publishGenericDraft(
      "أريد أعرض خدمة ترجمة",
      [
        "10",
        "خدمة ترجمة نصوص من العربية إلى الإنجليزية.",
        "تخطي",
        "تخطي",
        "1",
        "عن بعد",
        "خدمة",
        "خدمات",
        "محادثة فقط",
      ],
      {
        categoryId: "services",
        title: "خدمة ترجمة",
        unitPrice: 10,
        quantity: null,
        fulfilmentType: "SERVICE",
      },
    );
    const agriculturalOffer = await publishGenericDraft(
      "أريد أبيع مضخة مياه زراعية",
      [
        "50",
        "مضخة مياه زراعية بحالة جيدة.",
        "تخطي",
        "تخطي",
        "1",
        "الكويت",
        "استلام",
        "معدات زراعية",
        "محادثة فقط",
      ],
      {
        categoryId,
        title: "مضخة مياه زراعية",
        unitPrice: 50,
        quantity: 1,
        fulfilmentType: "PICKUP",
      },
    );

    const sellerJoMarket = await request(
      "/account/market",
      "PATCH",
      { marketId: "JO" },
      cookie,
    );
    assert.equal(sellerJoMarket.status, 200, sellerJoMarket.raw);
    const propertyOffer = await publishGenericDraft(
      "عندي شقة للإيجار في عمان ثلاث غرف",
      [
        "شقة سكنية من ثلاث غرف مناسبة للعائلة وبحالة جيدة.",
        "1",
        "محادثة فقط",
      ],
      {
        categoryId: "property",
        unitPrice: 350,
        quantity: 1,
        fulfilmentType: "PICKUP",
        marketId: "JO",
        city: "عمان",
        area: "عمان",
        attributes: {
          propertyType: "شقة",
          transactionType: "إيجار",
          bedrooms: 3,
        },
      },
    );
    assert.match(propertyOffer.payload?.draft?.title ?? "", /شقة/u);
    assert.equal(propertyOffer.persisted.data.city, "عمان");
    assert.equal(propertyOffer.persisted.data.attributes?.propertyType, "شقة");
    assert.equal(propertyOffer.persisted.data.attributes?.transactionType, "إيجار");
    assert.equal(propertyOffer.persisted.data.attributes?.bedrooms, 3);
    const sellerKwMarket = await request(
      "/account/market",
      "PATCH",
      { marketId: "KW" },
      cookie,
    );
    assert.equal(sellerKwMarket.status, 200, sellerKwMarket.raw);

    const searchAndOpen = async (phrase: string, offerId: string) => {
      const conversationId = await createConversation();
      await turn(conversationId, phrase);
      const resultSet = await latestResultSet(conversationId);
      assert.ok(
        resultSet.resourceIds.includes(offerId),
        `${phrase} should return persisted offer ${offerId}`,
      );
      const index = resultSet.resourceIds.indexOf(offerId);
      const ordinal = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة"][
        index
      ];
      assert.ok(ordinal, `offer ${offerId} should appear in the first five results`);
      const detail = await turn(conversationId, ordinal);
      assert.equal(blockPayload(detail)?.resourceIds?.[0], offerId);
      return { conversationId, resultSet };
    };

    await searchAndOpen("أريد جهاز قياس رطوبة للتربة", soilOffer.id);
    await searchAndOpen("أريد طاولة خشب", tableOffer.id);
    const translatorAliasConversation = await createConversation();
    await turn(translatorAliasConversation, "أحتاج مترجم");
    const translatorAliasSet = await latestResultSet(
      translatorAliasConversation,
    );
    assert.equal(translatorAliasSet.query.categoryId, "services");
    await searchAndOpen("أحتاج خدمة ترجمة", translationOffer.id);
    const newCategorySearch = await searchAndOpen(
      "أريد مضخة مياه",
      agriculturalOffer.id,
    );
    assert.equal(newCategorySearch.resultSet.query.categoryId, categoryId);

    const sellerCookie = cookie;
    try {
      assert.notEqual(
        goldenBuyerId,
        buyerId,
        "the discovery actor must be separate from the seller",
      );
      cookie = goldenBuyerCookie;
      const buyerKwMarket = await request(
        "/account/market",
        "PATCH",
        { marketId: "KW" },
        cookie,
      );
      assert.equal(buyerKwMarket.status, 200, buyerKwMarket.raw);
      const buyerGeneric = await searchAndOpen(
        "أريد جهاز قياس رطوبة للتربة",
        soilOffer.id,
      );
      assert.equal(buyerGeneric.resultSet.marketId, "KW");
      const buyerVehicle = await searchAndOpen(
        "أريد كامري 2020",
        publishedId,
      );
      assert.equal(buyerVehicle.resultSet.marketId, "KW");
      const mercedesBuyerConversation = await createConversation();
      await turn(mercedesBuyerConversation, "أريد مرسيدس C200");
      await turn(mercedesBuyerConversation, "من 2020 وفوق");
      await turn(mercedesBuyerConversation, "أقل من 9000");
      const createdMercedesResults = await latestResultSet(mercedesBuyerConversation);
      assert.ok(createdMercedesResults.resourceIds.includes(mercedesOffer.id));
      const editedMercedes = await request(`/listings/${mercedesOffer.id}`, "PATCH", { ...mercedesOffer.body, unitPrice: "8000" }, sellerCookie);
      assert.equal(editedMercedes.status, 200, editedMercedes.raw);
      await searchAndOpen("أريد مرسيدس C200 أقل من 9000", mercedesOffer.id);
      const buyerCurrentMercedes = await request(`/listings/${mercedesOffer.id}`, "GET", undefined, cookie);
      assert.equal(Number(buyerCurrentMercedes.data.unitPrice), 8000);
      await searchAndOpen("أحتاج كهربائي في عمان", electricianOffer.id);
      assert.equal(buyerVehicle.resultSet.query.categoryId, "cars");
      const buyerService = await searchAndOpen(
        "أحتاج خدمة ترجمة",
        translationOffer.id,
      );
      assert.equal(buyerService.resultSet.marketId, "KW");
      assert.equal(buyerService.resultSet.query.categoryId, "services");

      const buyerJoMarket = await request(
        "/account/market",
        "PATCH",
        { marketId: "JO" },
        cookie,
      );
      assert.equal(buyerJoMarket.status, 200, buyerJoMarket.raw);
      const buyerProperty = await searchAndOpen(
        "أريد شقة للإيجار 3 غرف في عمان بسعر 350",
        propertyOffer.id,
      );
      assert.equal(buyerProperty.resultSet.marketId, "JO");
      assert.equal(buyerProperty.resultSet.query.categoryId, "property");
      assertFilter(
        buyerProperty.resultSet,
        "propertyType",
        "contains",
        "شقة",
      );
      assertFilter(
        buyerProperty.resultSet,
        "transactionType",
        "contains",
        "إيجار",
      );
      assertFilter(buyerProperty.resultSet, "bedrooms", "eq", 3);
      assertFilter(buyerProperty.resultSet, "city", "contains", "عمان");
      // Block F2: «بسعر 350» is a target price the results rank around, not an exact filter.
      assert.equal(buyerProperty.resultSet.query.buyer.targetPrice, 350);
      assert.equal(filterFor(buyerProperty.resultSet, "price"), undefined);
    } finally {
      cookie = sellerCookie;
    }

    const outsiderRegistered = await request(
      "/auth/register",
      "POST",
      {
        displayName: `DINAR Phase 1 Outsider ${runId.slice(0, 8)}`,
        accountCountry: "KW",
        phoneCountryCode: "+965",
        phoneNumber: String(phoneBase + 1),
        password: registrationPassword,
        confirmPassword: registrationPassword,
        acceptTerms: true,
        verificationToken: await registrationProof(String(phoneBase + 1)),
      },
    );
    assert.equal(outsiderRegistered.status, 201, outsiderRegistered.raw);
    const outsiderId = outsiderRegistered.data.user.id as string;
    createdUserIds.push(outsiderId);
    const unauthorizedRead = await request(
      `/ai/conversations/${sellConversationId}`,
      "GET",
      undefined,
      outsiderRegistered.cookie,
    );
    assert.ok(
      [403, 404].includes(unauthorizedRead.status),
      `foreign seller draft should be private; got ${unauthorizedRead.status}`,
    );

    const fixtureForAuthorization = phase1DevelopmentListings.find(
      ({ listing }) => listing.id === "dev_phase1_mercedes_2022_a",
    )!.listing;
    const foreignUpdate = await request(
      `/listings/${fixtureIdByKey.get("dev_phase1_mercedes_2022_a")}`,
      "PATCH",
      {
        title: fixtureForAuthorization.title,
        description: fixtureForAuthorization.description,
        category: fixtureForAuthorization.category,
        area: fixtureForAuthorization.area,
        city: fixtureForAuthorization.city,
        attributes: fixtureForAuthorization.attributes,
        unitPrice: fixtureForAuthorization.unitPrice,
        inventoryMode: fixtureForAuthorization.inventoryMode,
        availableQuantity: fixtureForAuthorization.availableQuantity,
        fulfilmentType: fixtureForAuthorization.fulfilmentType,
        imageUrl: fixtureForAuthorization.imageUrl,
      },
      outsiderRegistered.cookie,
    );
    assert.ok(
      [403, 404].includes(foreignUpdate.status),
      `another seller must not edit this offer; got ${foreignUpdate.status}`,
    );
    const foreignDelete = await request(
      `/listings/${fixtureIdByKey.get("dev_phase1_mercedes_2022_a")}`,
      "DELETE",
      undefined,
      outsiderRegistered.cookie,
    );
    assert.ok(
      [403, 404].includes(foreignDelete.status),
      `another seller must not delete this offer; got ${foreignDelete.status}`,
    );
    const foreignPublish = await request(
      `/ai/conversations/${sellConversationId}/turns`,
      "POST",
      { message: "نشر العرض" },
      outsiderRegistered.cookie,
    );
    assert.ok(
      [403, 404].includes(foreignPublish.status),
      "another user must not publish a seller's conversation draft",
    );

    const [kwPolicyBefore] = await db
      .select({
        restrictedCategories: markets.restrictedCategories,
        sellerEligibilityMode: markets.sellerEligibilityMode,
      })
      .from(markets)
      .where(eq(markets.id, "KW"));
    assert.ok(kwPolicyBefore, "Kuwait market policy must exist");
    kwRestrictionsBefore = kwPolicyBefore.restrictedCategories;
    kwSellerEligibilityModeBefore = kwPolicyBefore.sellerEligibilityMode;

    await db
      .update(markets)
      .set({ sellerEligibilityMode: "APPROVAL_REQUIRED" })
      .where(eq(markets.id, "KW"));
    const buyerEligibility = await db
      .select({ userId: sellerMarketEligibility.userId })
      .from(sellerMarketEligibility)
      .where(
        and(
          eq(sellerMarketEligibility.userId, buyerId),
          eq(sellerMarketEligibility.marketId, "KW"),
        ),
      );
    assert.equal(buyerEligibility.length, 0);
    const ineligibleSellerPublish = await request(
      "/listings",
      "POST",
      soilOffer.body,
      cookie,
    );
    assert.equal(ineligibleSellerPublish.status, 403);
    const ineligibleSellerCheckout = await request(
      "/checkout",
      "POST",
      {
        idempotencyKey: `phase1-${runId}-ineligible-checkout`,
        items: [
          {
            listingId: soilOffer.id,
            quantity: 1,
            fulfilmentType: "PICKUP",
          },
        ],
      },
      outsiderRegistered.cookie,
    );
    assert.equal(
      ineligibleSellerCheckout.status,
      403,
      ineligibleSellerCheckout.raw,
    );
    await db
      .update(markets)
      .set({ sellerEligibilityMode: kwSellerEligibilityModeBefore })
      .where(eq(markets.id, "KW"));

    const guestFallbackPublish = await request(
      "/listings",
      "POST",
      soilOffer.body,
      "",
    );
    assert.equal(guestFallbackPublish.status, 401);

    const renamedCategoryLabel = "معدات زراعية محدثة";
    await db
      .update(markets)
      .set({
        restrictedCategories: [
          ...new Set([...kwRestrictionsBefore, "معدات زراعية"]),
        ],
      })
      .where(eq(markets.id, "KW"));
    const renamedCategory = await request(
      `/admin/categories/${categoryId}`,
      "PATCH",
      { label: renamedCategoryLabel },
      cookie,
    );
    assert.equal(renamedCategory.status, 200, renamedCategory.raw);
    const [policyAfterRename] = await db
      .select({ restrictedCategories: markets.restrictedCategories })
      .from(markets)
      .where(eq(markets.id, "KW"));
    assert.ok(policyAfterRename.restrictedCategories.includes(categoryId));
    if (!kwRestrictionsBefore.includes("معدات زراعية"))
      assert.ok(!policyAfterRename.restrictedCategories.includes("معدات زراعية"));
    await db
      .update(markets)
      .set({ restrictedCategories: kwRestrictionsBefore })
      .where(eq(markets.id, "KW"));

    const [renamedCategoryRow] = await db
      .select({ label: marketplaceCategories.label })
      .from(marketplaceCategories)
      .where(eq(marketplaceCategories.id, categoryId));
    assert.equal(renamedCategoryRow?.label, renamedCategoryLabel);
    const [renamedOfferRow] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, agriculturalOffer.id));
    assert.equal(renamedOfferRow?.data.category, renamedCategoryLabel);
    assert.equal(
      (await request(`/listings/${agriculturalOffer.id}`, "GET", undefined, cookie))
        .status,
      200,
    );
    const renamedCategorySearch = await searchAndOpen(
      "أريد مضخة مياه",
      agriculturalOffer.id,
    );
    assert.equal(renamedCategorySearch.resultSet.query.categoryId, categoryId);

    await db
      .update(markets)
      .set({
        restrictedCategories: [
          ...new Set([...kwRestrictionsBefore, categoryId, "other"]),
        ],
      })
      .where(eq(markets.id, "KW"));
    const restrictedAgriculturalPublish = await request(
      "/listings",
      "POST",
      { ...agriculturalOffer.body, category: renamedCategoryLabel },
      cookie,
    );
    assert.equal(restrictedAgriculturalPublish.status, 409);
    const restrictedOtherPublish = await request(
      "/listings",
      "POST",
      {
        ...soilOffer.body,
        title: "عرض اختبار تصنيف أخرى",
        category: "أخرى",
        categoryId: "other",
      },
      cookie,
    );
    assert.equal(restrictedOtherPublish.status, 409);

    for (const [phrase, offerId] of [
      ["أريد مضخة مياه", agriculturalOffer.id],
      ["أريد جهاز قياس رطوبة للتربة", soilOffer.id],
    ]) {
      const restrictedSearchConversation = await createConversation();
      await turn(restrictedSearchConversation, phrase);
      const restrictedResultSet = await latestResultSet(
        restrictedSearchConversation,
      );
      assert.ok(!restrictedResultSet.resourceIds.includes(offerId));
    }
    for (const offerId of [agriculturalOffer.id, soilOffer.id]) {
      const hiddenDetail = await request(
        `/listings/${offerId}`,
        "GET",
        undefined,
        outsiderRegistered.cookie,
      );
      assert.notEqual(hiddenDetail.status, 200);
      const hiddenCheckout = await request(
        "/checkout",
        "POST",
        {
          idempotencyKey: `phase1-${runId}-restricted-${offerId}`,
          items: [
            {
              listingId: offerId,
              quantity: 1,
              fulfilmentType: "PICKUP",
            },
          ],
        },
        outsiderRegistered.cookie,
      );
      assert.equal(hiddenCheckout.status, 409);
    }
    await db
      .update(markets)
      .set({ restrictedCategories: kwRestrictionsBefore })
      .where(eq(markets.id, "KW"));

    if (process.env.BDINAR_PHASE1_SKIP_BROWSER === "1") {
      console.log(
        "PHASE1 browser UI acceptance: skipped by explicit API-only flag",
      );
    } else {
      // The dev server's /api proxy must point at this suite's API: without a target it fell back
      // to 127.0.0.1:8080, so any request reaching the proxy instead of the page route got a 500.
      browserTestWeb = await startDinarBrowserTestWeb(new URL(base).origin);
      const browserResultPath = `/tmp/dinar-phase1-ui-${runId}.json`;
      const browserModelCallsBefore = getModelGatewayCallCount();
      let browserProcessError: unknown;
      try {
        await execFileAsync(
        process.execPath,
        [
          `${process.cwd()}/../dinar/test/phase1-ui-acceptance.mjs`,
        ],
        {
          cwd: process.cwd(),
          timeout: 360_000,
          maxBuffer: 2_000_000,
          env: {
            ...process.env,
            CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
            PHASE1_WEB_BASE: browserTestWeb.baseUrl,
            PHASE1_API_ORIGIN: new URL(base).origin,
            PHASE1_COOKIE: cookie,
            PHASE1_GOLDEN_BUYER_COOKIE: goldenBuyerCookie,
            PHASE1_GOLDEN_CONTACT_PHONE: `+965${phoneBase}`,
            PHASE1_INITIAL_CONVERSATION_IDS: JSON.stringify(conversationIds),
            PHASE1_EXPECTED_INITIAL_CAR_IDS: JSON.stringify([
              fixtureIdByKey.get("dev_phase1_mercedes_2021"),
              fixtureIdByKey.get("dev_phase1_mercedes_2022_a"),
              fixtureIdByKey.get("dev_phase1_mercedes_2023"),
              fixtureIdByKey.get("dev_phase1_mercedes_2024"),
            ]),
            PHASE1_EXPECTED_CAR_IDS: JSON.stringify([
              fixtureIdByKey.get("dev_phase1_mercedes_2022_a"),
              fixtureIdByKey.get("dev_phase1_mercedes_2023"),
            ]),
            PHASE1_EXPECTED_PROPERTY_ID: fixtureIdByKey.get(
              "dev_phase1_property_apartment",
            ),
            PHASE1_EXPECTED_GENERIC_TABLE_ID: tableOffer.id,
            PHASE1_EXPECTED_GENERIC_SERVICE_ID: translationOffer.id,
            PHASE1_EXPECTED_AGRICULTURAL_ID: agriculturalOffer.id,
            PHASE1_UI_RESULT_PATH: browserResultPath,
          },
        },
      );
      } catch (error) {
        browserProcessError = error;
      }
      let browserResult: any;
      try {
        browserResult = JSON.parse(await readFile(browserResultPath, "utf8"));
      } catch {
        // Preserve the child error below; there may be no result if Chromium failed to launch.
      } finally {
        await unlink(browserResultPath).catch(() => undefined);
      }
      if (browserResult) {
        conversationIds.push(...(browserResult.createdConversationIds ?? []));
        if (browserResult.publishedOfferId)
          ownedOfferIds.push(browserResult.publishedOfferId);
        uploadedPhotoObjectPaths.push(
          ...(browserResult.uploadedPhotoPaths ?? []).filter(
            (path: unknown): path is string => typeof path === "string",
          ),
        );
        goldenOrderId = browserResult.goldenOrderId;
        goldenPhotoOfferId = browserResult.photoOfferId;
        console.log(
          "PHASE1 browser UI acceptance:",
          JSON.stringify({
            checks: browserResult.checks,
            pageErrors: browserResult.pageErrors,
            consoleErrors: browserResult.consoleErrors,
            // Diagnostics only: the responses behind any «Failed to load resource» error.
            failedResponses: browserResult.failedResponses,
            expectedMarketConversationConflicts:
              browserResult.expectedMarketConversationConflicts,
            publishedOffer: Boolean(browserResult.publishedOfferId),
            failure: browserResult.failure,
          }),
        );
        assert.equal(browserResult.failure, undefined);
        assert.deepEqual(browserResult.pageErrors, []);
        const expectedConflictConsoleMessage =
          "Failed to load resource: the server responded with a status of 409 (Conflict)";
        assert.deepEqual(
          browserResult.consoleErrors,
          browserResult.expectedMarketConversationConflicts.map(
            () => expectedConflictConsoleMessage,
          ),
        );
        assert.ok(browserResult.checks.length >= 5);
      }
      if (browserProcessError) throw browserProcessError;
      assert.ok(browserResult, "browser acceptance must write its cleanup report");
      const browserModelCallDelta =
        getModelGatewayCallCount() - browserModelCallsBefore;
      modelCalls.push({ phrase: "browser UI acceptance", calls: browserModelCallDelta });
      assert.equal(
        browserModelCallDelta,
        0,
        "browser acceptance must not attempt model calls",
      );
      assert.ok(goldenPhotoOfferId, "the browser must publish the photo-first offer");
      assert.ok(goldenOrderId, "the browser must complete the golden buyer order");
      assert.ok(goldenBuyerId, "the golden buyer test account must be registered");

      const [goldenOffer] = await db
        .select()
        .from(offers)
        .where(eq(offers.id, goldenPhotoOfferId));
      assert.ok(goldenOffer, "the photo-first offer must persist in the database");
      const correctionConversationId = await createConversation();
      const correctionPhoto = String(goldenOffer.data.imageUrl);
      app.locals.listingPhotoSuggestionProvider = new DeterministicPhotoSuggestionProvider([
        { field: "condition", value: "جديد", confidence: 0.6, imageObjectPath: correctionPhoto },
      ]);
      let correctionPayload: any;
      try {
        // A condition the seller already wrote is never re-suggested from the photo, and the
        // status then says so instead of announcing suggestions that are not there.
        const stated = blockPayload(
          await turn(
            await createConversation(),
            "أريد أبيع سماعة إلكترونيات جديدة، سماعة بلوتوث تعمل بشكل جيد، السعر 180 دينار، الكمية 1، موجود في عمان، محادثة فقط",
            true,
            [correctionPhoto],
          ),
        );
        assert.equal(stated.draft.attributes?.condition, "جديد");
        assert.deepEqual([stated.photoSuggestionStatus, stated.photoSuggestions], ["NO_SUGGESTIONS", []]);
        // Here the photo is the only source of the condition: it is suggested, and the seller's correction wins.
        const suggested = await turn(
          correctionConversationId,
          "أريد أبيع سماعة إلكترونيات، سماعة بلوتوث تعمل بشكل جيد، السعر 180 دينار، الكمية 1، موجود في عمان، محادثة فقط",
          true,
          [correctionPhoto],
        );
        const proposed = blockPayload(suggested);
        assert.equal(proposed.draft.attributes?.condition, undefined, "the message states no condition");
        assert.equal(proposed.photoSuggestionStatus, "SUGGESTIONS");
        assert.equal(proposed.photoSuggestions[0].value, "جديد");
        correctionPayload = blockPayload(await turn(correctionConversationId, "الحالة مستعمل"));
        assert.equal(correctionPayload.draft.attributes.condition, "مستعمل");
        for (let attempt = 0; attempt < 8 && correctionPayload.draftStep !== "review"; attempt++) {
          const answers: Record<string, string> = {
            description: "سماعة بلوتوث تعمل بشكل جيد ولونها أسود.",
            price: "180", quantity: "1", area: "عمان", fulfilment: "استلام", contact: "محادثة فقط", payment_methods: "كاش",
          };
          assert.ok(answers[correctionPayload.draftStep], correctionPayload.draftStep);
          correctionPayload = blockPayload(await turn(correctionConversationId, answers[correctionPayload.draftStep]));
        }
        assert.equal(correctionPayload.draftStep, "review");
        const confirmed = correctionPayload.draft;
        const correctedPublication = await request("/listings", "POST", {
          ...confirmed,
          availableQuantity: Number(confirmed.availableQuantity),
          imageUrls: confirmed.imageUrls ?? [],
          contactPhone: null,
        }, cookie);
        assert.equal(correctedPublication.status, 201, correctedPublication.raw);
        ownedOfferIds.push(correctedPublication.data.id);
        const [correctedRow] = await db.select().from(offers).where(eq(offers.id, correctedPublication.data.id));
        assert.equal(correctedRow.data.attributes?.condition, "مستعمل");
        assert.equal(correctedRow.data.imageUrl, correctionPhoto);
        console.log("BLOCKB_PHOTO_CORRECTION persisted seller-confirmed condition");
      } finally {
        delete app.locals.listingPhotoSuggestionProvider;
      }
      assert.equal(goldenOffer.sellerId, buyerId);
      assert.equal(goldenOffer.marketId, "JO");
      assert.equal(goldenOffer.unitPriceMinor, 430 * 10 ** 3);
      assert.ok(JSON.stringify(goldenOffer.data).includes("91%"));
      const contactDigits = String(goldenOffer.data.contactPhone ?? "").replace(
        /\D/g,
        "",
      );
      assert.ok(
        contactDigits.endsWith(String(phoneBase)),
        "the review must save the registered seller's development contact",
      );
      const offerMediaPaths = [
        goldenOffer.data.imageUrl,
        ...(Array.isArray(goldenOffer.data.imageUrls)
          ? goldenOffer.data.imageUrls
          : []),
      ].filter((path): path is string => typeof path === "string");
      assert.equal(new Set(offerMediaPaths).size, 2);
      assert.deepEqual(
        [...new Set(offerMediaPaths)].sort(),
        [...new Set(uploadedPhotoObjectPaths)].sort(),
      );

      const [goldenOrder] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, goldenOrderId));
      assert.ok(goldenOrder, "the browser-created order must persist");
      assert.equal(goldenOrder.buyerId, goldenBuyerId);
      assert.equal(goldenOrder.sellerId, buyerId);
      assert.equal(goldenOrder.marketId, "JO");
      assert.equal(goldenOrder.status, "COMPLETED");
      assert.equal(goldenOrder.subtotalMinor, 430_000);
      assert.equal(goldenOrder.data.commissionRateBps, 1_000);
      assert.equal(goldenOrder.data.paymentMode, "TEST_NO_TRANSFER");
      assert.equal(goldenOrder.platformFeeMinor, 43_000);
      assert.equal(goldenOrder.sellerAmountMinor, 387_000);
      const goldenDues = await db
        .select()
        .from(sellerDues)
        .where(eq(sellerDues.orderId, goldenOrderId));
      assert.equal(goldenDues.length, 1, "completion must create exactly one due");
      assert.equal(goldenDues[0].amountMinor, goldenOrder.platformFeeMinor, "the due is the 10% platform fee (43.000)");
      assert.equal(goldenDues[0].status, "PENDING");
    }

    console.log(
      "PHASE1 deterministic model-call deltas:",
      JSON.stringify(modelCalls),
    );
    assert.equal(
      getModelGatewayCallCount(),
      0,
      "no model/provider call should be attempted during deterministic acceptance",
    );

    const managementCallsBefore = getModelGatewayCallCount();
    const managementConversationId = await createConversation();
    const sellerListings = await turn(managementConversationId, "إعلاناتي");
    const sellerListingsPayload = blockPayload(sellerListings);
    assert.equal(sellerListingsPayload?.surface, "MY_LISTINGS");
    assert.ok(sellerListingsPayload?.resourceIds.includes(tableOffer.id));

    const openedOwnedListing = await turn(
      managementConversationId,
      "افتح إعلان الطاولة",
    );
    assert.equal(blockPayload(openedOwnedListing)?.resourceId, tableOffer.id);

    const cancelledEdit = await turn(
      managementConversationId,
      "غير السعر إلى 12",
    );
    const cancelledEditPreview = blockPayload(cancelledEdit)?.managementPreview;
    assert.equal(cancelledEditPreview?.action, "UPDATE");
    assert.equal(cancelledEditPreview?.fieldLabel, "السعر");
    assert.equal(cancelledEditPreview?.afterValue, "12.000");
    const [unchangedAfterPreview] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(
      unchangedAfterPreview?.unitPriceMinor,
      tableOffer.persisted.unitPriceMinor,
      "a preview must not save the listing before explicit confirmation",
    );
    const foreignPreviewConfirmation = await request(
      `/ai/listing-management-previews/${cancelledEditPreview.previewId}/action`,
      "POST",
      { action: "CONFIRM" },
      outsiderRegistered.cookie,
    );
    assert.equal(foreignPreviewConfirmation.status, 404);
    const cancelAction = await request(
      `/ai/listing-management-previews/${cancelledEditPreview.previewId}/action`,
      "POST",
      { action: "CANCEL" },
      cookie,
    );
    assert.equal(cancelAction.status, 200, cancelAction.raw);
    assert.equal(cancelAction.data.status, "CANCELLED");
    const cancelledHistory = await request(
      `/ai/conversations/${managementConversationId}`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(cancelledHistory.status, 200, cancelledHistory.raw);
    const cancelledPreviewBlock = cancelledHistory.data.messages
      .flatMap((message: any) => message.blocks)
      .find(
        (block: any) =>
          block.payload.managementPreview?.previewId ===
          cancelledEditPreview.previewId,
      );
    assert.equal(
      cancelledPreviewBlock?.payload.managementPreview.status,
      "CANCELLED",
      "preview cancellation survives conversation reload",
    );

    const confirmedEdit = await turn(
      managementConversationId,
      "غير السعر إلى 12",
    );
    const confirmedEditPreview = blockPayload(confirmedEdit)?.managementPreview;
    assert.equal(confirmedEditPreview?.action, "UPDATE");
    const confirmedPrice = await turn(managementConversationId, "نعم");
    assert.match(confirmedPrice.assistantMessage?.body ?? "", /تحديث القائمة/);
    const [tableAfterConfirmedEdit] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(tableAfterConfirmedEdit?.unitPriceMinor, 12_000);
    const confirmedHistory = await request(
      `/ai/conversations/${managementConversationId}`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(confirmedHistory.status, 200, confirmedHistory.raw);
    const confirmedPreviewBlock = confirmedHistory.data.messages
      .flatMap((message: any) => message.blocks)
      .find(
        (block: any) =>
          block.payload.managementPreview?.previewId ===
          confirmedEditPreview.previewId,
      );
    assert.equal(
      confirmedPreviewBlock?.payload.managementPreview.status,
      "CONFIRMED",
      "confirmed preview state survives conversation reload",
    );

    const quantityBefore = Number(
      tableAfterConfirmedEdit?.availableQuantity ?? 0,
    );
    const quantityAfter = quantityBefore + 1;
    const quantityEdit = await turn(
      managementConversationId,
      `غير الكمية إلى ${quantityAfter}`,
    );
    const quantityPreview = blockPayload(quantityEdit)?.managementPreview;
    assert.equal(
      quantityPreview?.action,
      "UPDATE",
      "the quantity value must not be mistaken for a listing number",
    );
    assert.equal(quantityPreview?.fieldLabel, "الكمية");
    assert.equal(quantityPreview?.afterValue, String(quantityAfter));
    const [unchangedQuantity] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(
      unchangedQuantity?.availableQuantity,
      quantityBefore,
      "a quantity preview must not update inventory before confirmation",
    );
    await turn(managementConversationId, "نعم");
    const [tableAfterQuantityEdit] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(tableAfterQuantityEdit?.availableQuantity, quantityAfter);

    const locationBefore = String(tableAfterQuantityEdit?.data.city ?? "");
    const locationEdit = await turn(
      managementConversationId,
      "غير الموقع إلى الزرقاء",
    );
    const locationPreview = blockPayload(locationEdit)?.managementPreview;
    assert.equal(locationPreview?.action, "UPDATE");
    assert.equal(locationPreview?.fieldLabel, "الموقع");
    assert.equal(locationPreview?.afterValue, "الزرقاء");
    const [unchangedLocation] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(
      unchangedLocation?.data.city ?? "",
      locationBefore,
      "a location preview must not update the listing before confirmation",
    );
    await turn(managementConversationId, "نعم");
    const [tableAfterLocationEdit] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(tableAfterLocationEdit?.data.city, "الزرقاء");

    await turn(managementConversationId, "وقف الإعلان");
    const [stillPublishedAfterPausePreview] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(stillPublishedAfterPausePreview?.status, "PUBLISHED");
    await turn(managementConversationId, "نعم");
    const [pausedByConversation] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(pausedByConversation?.status, "PAUSED");

    await turn(managementConversationId, "رجع الإعلان");
    await turn(managementConversationId, "نعم");
    const [resumedByConversation] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(resumedByConversation?.status, "PUBLISHED");

    const archivePreview = await turn(
      managementConversationId,
      "احذف الإعلان",
    );
    const archivePreviewPayload = blockPayload(archivePreview)?.managementPreview;
    assert.equal(archivePreviewPayload?.action, "ARCHIVE");
    assert.match(archivePreviewPayload?.afterValue ?? "", /مؤرشف/);
    const [stillPublishedBeforeArchiveConfirmation] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(stillPublishedBeforeArchiveConfirmation?.status, "PUBLISHED");
    await turn(managementConversationId, "نعم");
    const [archivedByConversation] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, tableOffer.id));
    assert.equal(archivedByConversation?.status, "ARCHIVED");

    const managementGatewayAttempts =
      getModelGatewayCallCount() - managementCallsBefore;
    assert.equal(
      managementGatewayAttempts,
      0,
      "seller listing management must not need generic model calls",
    );
    console.log(
      "PHASE1 seller-management acceptance:",
      JSON.stringify({
        persistedPriceMinor: tableAfterConfirmedEdit?.unitPriceMinor,
        status: archivedByConversation?.status,
        cancelledPreviewSurvivedReload: true,
        confirmedPreviewSurvivedReload: true,
        foreignConfirmationStatus: foreignPreviewConfirmation.status,
        gatewayAttempts: managementGatewayAttempts,
      }),
    );

    const directRouteListingId = fixtureIdByKey.get(
      "dev_phase1_mercedes_2022_a",
    );
    assert.ok(directRouteListingId);
    const unauthenticatedPause = await request(
      `/listings/${directRouteListingId}/status`,
      "PATCH",
      { action: "PAUSE" },
    );
    assert.equal(unauthenticatedPause.status, 401);
    const foreignPause = await request(
      `/listings/${directRouteListingId}/status`,
      "PATCH",
      { action: "PAUSE" },
      outsiderRegistered.cookie,
    );
    assert.equal(foreignPause.status, 404);

    const pausedListing = await request(
      `/listings/${directRouteListingId}/status`,
      "PATCH",
      { action: "PAUSE" },
      cookie,
    );
    assert.equal(pausedListing.status, 200, pausedListing.raw);
    assert.equal(pausedListing.data.status, "PAUSED");
    const repeatedPause = await request(
      `/listings/${directRouteListingId}/status`,
      "PATCH",
      { action: "PAUSE" },
      cookie,
    );
    assert.equal(repeatedPause.status, 200, repeatedPause.raw);
    assert.equal(repeatedPause.data.status, "PAUSED");

    const resumedListing = await request(
      `/listings/${directRouteListingId}/status`,
      "PATCH",
      { action: "RESUME" },
      cookie,
    );
    assert.equal(resumedListing.status, 200, resumedListing.raw);
    assert.equal(resumedListing.data.status, "PUBLISHED");
    const archivedListing = await request(
      `/listings/${directRouteListingId}`,
      "DELETE",
      undefined,
      cookie,
    );
    assert.equal(archivedListing.status, 200, archivedListing.raw);
    assert.equal(archivedListing.data.status, "ARCHIVED");
    const [archivedRow] = await db
      .select()
      .from(offers)
      .where(eq(offers.id, directRouteListingId));
    assert.equal(archivedRow?.status, "ARCHIVED");
  } finally {
    await browserTestWeb?.stop();
    // The guarded runner gives this suite a fresh disposable database and drops it afterwards.
    // Orders now carry append-only delivery history, so their rows (and the users, offers and
    // conversations they reference) stay until that drop; uploaded objects are still removed.
    const dropDatabaseAfterTest =
      process.env.BDINAR_DISPOSABLE_TEST_DATABASE === "1" &&
      process.env.BDINAR_DISPOSABLE_ACCEPTANCE_DB === "1";
    if (kwRestrictionsBefore !== undefined)
      await db
        .update(markets)
        .set({ restrictedCategories: kwRestrictionsBefore })
        .where(eq(markets.id, "KW"));
    if (kwSellerEligibilityModeBefore !== undefined)
      await db
        .update(markets)
        .set({ sellerEligibilityMode: kwSellerEligibilityModeBefore })
        .where(eq(markets.id, "KW"));
    if (serviceAliasesBefore)
      await db
        .update(marketplaceCategories)
        .set({ aliases: serviceAliasesBefore })
        .where(eq(marketplaceCategories.id, "services"));

    if (verificationChallengeIds.length)
      await db
        .delete(phoneVerificationChallenges)
        .where(
          inArray(
            phoneVerificationChallenges.id,
            verificationChallengeIds,
          ),
        );
    if (createdUserIds.length) {
      // Recover any rows created by the browser child even if it failed before
      // returning its cleanup report. These users were registered by this run.
      const ownedConversations = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            inArray(conversations.ownerUserId, createdUserIds),
            eq(conversations.kind, "AI"),
          ),
        );
      conversationIds.push(...ownedConversations.map((row) => row.id));
      const sellerOffers = await db
        .select({ id: offers.id })
        .from(offers)
        .where(inArray(offers.sellerId, createdUserIds));
      ownedOfferIds.push(...sellerOffers.map((row) => row.id));

      const ownedOrders = await db
        .select({ id: orders.id })
        .from(orders)
        .where(
          or(
            inArray(orders.buyerId, createdUserIds),
            inArray(orders.sellerId, createdUserIds),
          ),
        );
      const ownedOrderIds = ownedOrders.map((row) => row.id);
      const ownedCarts = await db
        .select({ id: carts.id })
        .from(carts)
        .where(inArray(carts.userId, createdUserIds));
      const ownedCartIds = ownedCarts.map((row) => row.id);
      const objectPaths = new Set<string>();
      const collectObjectPaths = (value: unknown): void => {
        if (typeof value === "string") {
          const objectPathIndex = value.indexOf("/objects/");
          if (objectPathIndex >= 0)
            objectPaths.add(value.slice(objectPathIndex).split(/[?#]/)[0]);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(collectObjectPaths);
          return;
        }
        if (typeof value === "object" && value !== null)
          Object.values(value).forEach(collectObjectPaths);
      };
      uploadedPhotoObjectPaths.forEach(collectObjectPaths);
      const savedOffers = await db
        .select({ data: offers.data })
        .from(offers)
        .where(inArray(offers.sellerId, createdUserIds));
      savedOffers.forEach((row) => collectObjectPaths(row.data));
      const userConversationIds = ownedConversations.map((row) => row.id);
      if (userConversationIds.length) {
        const savedUiBlocks = await db
          .select({ payload: aiUiBlocks.payload })
          .from(aiUiBlocks)
          .where(inArray(aiUiBlocks.conversationId, userConversationIds));
        savedUiBlocks.forEach((row) => collectObjectPaths(row.payload));
      }
      const storage = new ObjectStorageService();
      for (const objectPath of objectPaths) {
        if (!objectPath.includes("/objects/")) continue;
        await (await storage.getObjectEntityFile(objectPath)).delete({
          ignoreNotFound: true,
        });
      }

      if (!dropDatabaseAfterTest) {
        if (ownedOrderIds.length) {
          await db
            .delete(disputes)
            .where(inArray(disputes.orderId, ownedOrderIds));
          await db
            .delete(sellerDues)
            .where(inArray(sellerDues.orderId, ownedOrderIds));
          await db
            .delete(messages)
            .where(inArray(messages.conversationId, ownedOrderIds));
          await db
            .delete(conversations)
            .where(inArray(conversations.orderId, ownedOrderIds));
          await db
            .delete(orderItems)
            .where(inArray(orderItems.orderId, ownedOrderIds));
          await db.delete(orders).where(inArray(orders.id, ownedOrderIds));
        }
        if (ownedCartIds.length)
          await db
            .delete(cartItems)
            .where(inArray(cartItems.cartId, ownedCartIds));
        if (ownedCartIds.length)
          await db.delete(carts).where(inArray(carts.id, ownedCartIds));
        await db
          .delete(checkoutRequests)
          .where(inArray(checkoutRequests.userId, createdUserIds));
      }
    }
    if (!dropDatabaseAfterTest) {
      const uniqueConversationIds = [...new Set(conversationIds)];
      const uniqueOwnedOfferIds = [...new Set(ownedOfferIds)];
      if (uniqueConversationIds.length) {
        await db
          .delete(aiUiBlocks)
          .where(inArray(aiUiBlocks.conversationId, uniqueConversationIds));
        await db
          .delete(messages)
          .where(inArray(messages.conversationId, uniqueConversationIds));
        await db
          .delete(aiResultSets)
          .where(inArray(aiResultSets.conversationId, uniqueConversationIds));
        await db
          .delete(conversations)
          .where(inArray(conversations.id, uniqueConversationIds));
      }
      if (uniqueOwnedOfferIds.length)
        await db.delete(offers).where(inArray(offers.id, uniqueOwnedOfferIds));
      if (createdUserIds.length)
        await db
          .delete(marketplaceCategoryAudit)
          .where(inArray(marketplaceCategoryAudit.actorId, createdUserIds));
      if (createdUserIds.length)
        await db
          .delete(marketAudit)
          .where(inArray(marketAudit.actorId, createdUserIds));
      if (testCategoryId)
        await db
          .delete(marketplaceCategories)
          .where(eq(marketplaceCategories.id, testCategoryId));

      if (buyerId) {
        if (activeMarketBefore)
          await db
            .update(users)
            .set({ activeMarketId: activeMarketBefore })
            .where(eq(users.id, buyerId));
        const auditRows = await db
          .select({ id: marketAudit.id })
          .from(marketAudit)
          .where(eq(marketAudit.actorId, buyerId));
        const newAuditIds = auditRows
          .map((row) => row.id)
          .filter((id) => !initialAuditIds.has(id));
        if (newAuditIds.length)
          await db
            .delete(marketAudit)
            .where(inArray(marketAudit.id, newAuditIds));
      }

      if (createdUserIds.length) {
        await db
          .delete(sellerMarketEligibility)
          .where(inArray(sellerMarketEligibility.userId, createdUserIds));
        await db
          .delete(policyAcceptances)
          .where(inArray(policyAcceptances.userId, createdUserIds));
        await db
          .delete(sessions)
          .where(inArray(sessions.userId, createdUserIds));
        await deleteDisposableUsers(createdUserIds);

        const remainingUsers = await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, createdUserIds));
        const remainingOffers = await db
          .select({ id: offers.id })
          .from(offers)
          .where(inArray(offers.sellerId, createdUserIds));
        const remainingConversations = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(inArray(conversations.ownerUserId, createdUserIds));
        const remainingOrders = await db
          .select({ id: orders.id })
          .from(orders)
          .where(
            or(
              inArray(orders.buyerId, createdUserIds),
              inArray(orders.sellerId, createdUserIds),
            ),
          );
        const remainingCarts = await db
          .select({ id: carts.id })
          .from(carts)
          .where(inArray(carts.userId, createdUserIds));
        const remainingCheckoutRequests = await db
          .select({ idempotencyKey: checkoutRequests.idempotencyKey })
          .from(checkoutRequests)
          .where(inArray(checkoutRequests.userId, createdUserIds));
        assert.equal(remainingUsers.length, 0, "test users must be removed");
        assert.equal(remainingOffers.length, 0, "test offers must be removed");
        assert.equal(
          remainingConversations.length,
          0,
          "test conversations must be removed",
        );
        assert.equal(remainingOrders.length, 0, "test orders must be removed");
        assert.equal(remainingCarts.length, 0, "test carts must be removed");
        assert.equal(
          remainingCheckoutRequests.length,
          0,
          "test checkout requests must be removed",
        );
      }
      if (testCategoryId) {
        const remainingCategory = await db
          .select({ id: marketplaceCategories.id })
          .from(marketplaceCategories)
          .where(eq(marketplaceCategories.id, testCategoryId));
        assert.equal(remainingCategory.length, 0, "test category must be removed");
      }
    }
    if (serviceAliasesBefore) {
      const [restoredServices] = await db
        .select({ aliases: marketplaceCategories.aliases })
        .from(marketplaceCategories)
        .where(eq(marketplaceCategories.id, "services"));
      assert.deepEqual(restoredServices?.aliases, serviceAliasesBefore);
    }
    if (
      kwRestrictionsBefore !== undefined &&
      kwSellerEligibilityModeBefore !== undefined
    ) {
      const [restoredMarket] = await db
        .select({
          restrictedCategories: markets.restrictedCategories,
          sellerEligibilityMode: markets.sellerEligibilityMode,
        })
        .from(markets)
        .where(eq(markets.id, "KW"));
      assert.deepEqual(
        restoredMarket?.restrictedCategories,
        kwRestrictionsBefore,
      );
      assert.equal(
        restoredMarket?.sellerEligibilityMode,
        kwSellerEligibilityModeBefore,
      );
    }
  }
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await localObjectStorage?.close();
  await pool.end();
});
