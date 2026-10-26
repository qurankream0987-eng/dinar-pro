import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { aiResultSets, db, listingPromotions, marketplaceCategories, markets, pool, promotionProducts, users } from "@workspace/db";
import { createListingForActor } from "../src/routes/marketplace";
import { resolveListingBehavior } from "../src/lib/listing-management";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKE_ACCEPTANCE");
process.env.BDINAR_PROMOTIONS_ENABLED = "true";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
// The id is part of every listing and query, so it must be neutral to the deterministic parser:
// letters only. A hex id such as «nlee06eeb» has the shape of a car model code (letters, 2–4
// digits, letters — see search-query.ts) and became a model filter in ~10% of runs.
// DINAR_NL_PROBE_RUN_ID replays a specific run.
const runId =
  process.env.DINAR_NL_PROBE_RUN_ID ??
  `nl${[...randomUUID().replaceAll("-", "").slice(0, 7)].map((char) => "ghjkmnpqrstvwxyz"[parseInt(char, 16)]).join("")}`;
let authIp = 0;
let phoneOffset = 0;
const phoneBase = 51_150_000 + ((Date.now() + process.pid) % 200_000);

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.18.0.${++authIp}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, data: raw ? JSON.parse(raw) : undefined, raw, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function register(label: string) {
  const phone = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber: phone });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Probe-${randomUUID().slice(0, 10)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `NL probe ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber: phone,
    password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id as string, cookie: registered.cookie };
}

async function publish(
  actor: { cookie: string },
  title: string,
  categoryId: string,
  category: string,
  attributes: Record<string, string | number> = {},
  options: { price?: string; quantity?: number } = {},
) {
  const created = await request("/listings", "POST", {
    title: `${title} ${runId}`, description: `${title} probe ${runId}`, category, categoryId,
    area: "خلدا", city: "عمان", attributes, unitPrice: options.price ?? "5", inventoryMode: "LIMITED",
    availableQuantity: options.quantity ?? 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, actor.cookie);
  assert.equal(created.status, 201, `${title}: ${created.raw}`);
  return created.data.id as string;
}

async function conversation(cookie: string) {
  const response = await request("/ai/conversations", "POST", {}, cookie);
  assert.equal(response.status, 201, response.raw);
  return response.data.id as string;
}

async function turn(cookie: string, id: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${id}/turns`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
  assert.ok(complete, `${message}: ${raw.slice(0, 250)}`);
  return { body: complete.assistantMessage.body as string, payload: complete.assistantMessage.blocks[0]?.payload as any };
}

test("narrow VIP, sponsored relevance, and natural-language entry probes", async () => {
  let vipPlanId: string | undefined;
  let carPlanId: string | undefined;
  const campaignIds: string[] = [];
  try {
  const seller = await register("seller");
  const otherSeller = await register("other seller");
  const buyer = await register("buyer");
  const ownShirt = await publish(seller, "تيشرت نايكي أسود", "fashion", "أزياء");
  const organicShirt = await publish(otherSeller, "تيشرت نايكي أزرق", "fashion", "أزياء");
  const sponsoredShirt = await publish(otherSeller, "تيشرت نايكي أخضر", "fashion", "أزياء");
  const carPayload = {
    title: `سيارة سيدان ${runId}`, description: `سيارة سيدان probe ${runId}`,
    category: "سيارات", categoryId: "cars", area: "خلدا", city: "عمان",
    attributes: {
      make: "تويوتا", model: "كامري", year: 2020, mileage: 50_000,
      condition: "مستعمل", fuel: "بنزين", transmission: "أوتوماتيك", color: "أبيض",
    },
    unitPrice: "5", inventoryMode: "LIMITED", availableQuantity: 3,
    fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  };
  const rejectedCar = await request("/listings", "POST", carPayload, otherSeller.cookie);
  assert.equal(rejectedCar.status, 400, rejectedCar.raw);
  assert.deepEqual(rejectedCar.data, { error: "تحقق من البيانات المدخلة" });
  const [carCategory] = await db.select().from(marketplaceCategories).where(eq(marketplaceCategories.id, "cars"));
  assert.equal(carCategory?.isActive, true);
  const carRules = (carCategory?.rules as any)?.inventory;
  assert.equal(carRules?.semantics, "SINGLE");
  assert.deepEqual(carRules?.allowedModes, ["LIMITED"]);
  assert.equal(carRules?.defaultQuantity, 1);
  const carAttributes = carCategory?.attributes as Record<string, any>;
  assert.deepEqual(
    Object.entries(carAttributes).filter(([, definition]) => definition.requiredForPublish).map(([key]) => key).sort(),
    ["condition", "make", "model", "year"],
  );
  assert.deepEqual(carAttributes.condition.options, ["جديد", "مستعمل"]);
  assert.deepEqual(carAttributes.transmission.options, ["أوتوماتيك", "يدوي"]);
  assert.deepEqual(carAttributes.fuel.options, ["بنزين", "ديزل", "كهرباء", "هجين"]);
  assert.deepEqual(resolveListingBehavior(
    carCategory!,
    { unitPrice: "5", inventoryMode: "LIMITED", availableQuantity: 1 },
    "JOD",
  ), { pricingMode: "FIXED", unitPriceMinor: 5_000 });
  const [sellerRow] = await db.select().from(users).where(eq(users.id, otherSeller.id));
  assert.equal(sellerRow?.activeMarketId, "JO");
  const [jordan] = await db.select().from(markets).where(eq(markets.id, "JO"));
  assert.equal(jordan?.isActive, true);
  let internalValidationError: any;
  try {
    await createListingForActor(sellerRow!, carPayload);
  } catch (error) {
    internalValidationError = error;
  }
  assert.equal(internalValidationError?.status, 400);
  assert.equal(internalValidationError?.message, "هذا التصنيف مخصص لعرض وحدة واحدة.");
  console.log("CAR_LISTING_MICROTRIAGE", JSON.stringify({
    httpStatus: rejectedCar.status,
    publicError: rejectedCar.data.error,
    publicCode: rejectedCar.data.code ?? null,
    categoryId: carCategory!.id,
    marketId: sellerRow!.activeMarketId,
    validationStage: "category inventory rules",
    field: "availableQuantity",
    requiredQuantity: 1,
    submittedInventoryMode: carPayload.inventoryMode,
    submittedQuantity: carPayload.availableQuantity,
    internalError: internalValidationError.message,
  }));
  const sponsoredCar = await publish(otherSeller, "تويوتا برادو 2018", "cars", "سيارات", {
    make: "تويوتا", model: "برادو", year: 2018, condition: "مستعمل",
  }, { price: "30000", quantity: 1 });
  const [vipPlan] = await db.insert(promotionProducts).values({
    id: randomUUID(), marketId: "JO", categoryId: "fashion", name: `Probe VIP ${runId}`,
    placement: "VIP", productType: "VIP_LISTING", priceMinor: 7000,
    currencyCode: "JOD", durationDays: 7, enabled: true, createdBy: seller.id,
  }).returning();
  assert.ok(vipPlan);
  vipPlanId = vipPlan.id;
  const [carPlan] = await db.insert(promotionProducts).values({
    id: randomUUID(), marketId: "JO", categoryId: "cars", name: `Probe Car Promotion ${runId}`,
    placement: "VIP", productType: "VIP_LISTING", priceMinor: 7000,
    currencyCode: "JOD", durationDays: 7, enabled: true, createdBy: otherSeller.id,
  }).returning();
  assert.ok(carPlan);
  carPlanId = carPlan.id;
  for (const [listingId, categoryId, product] of [
    [sponsoredShirt, "fashion", vipPlan],
    [sponsoredCar, "cars", carPlan],
  ] as const) {
    const campaignId = randomUUID();
    campaignIds.push(campaignId);
    await db.insert(listingPromotions).values({
      id: campaignId, listingId: listingId!, sellerId: otherSeller.id, marketId: "JO",
      productId: product.id, productNameSnapshot: product.name, categoryIdSnapshot: categoryId,
      priceMinorSnapshot: 7000, currencyCodeSnapshot: "JOD", placementSnapshot: "SEARCH_AND_CHAT",
      durationDaysSnapshot: 7, status: "ACTIVE", paymentStatus: "SIMULATION_CAPTURED",
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
    });
  }

  const before = (await db.select().from(listingPromotions)).length;
  const sellerConv = await conversation(seller.cookie);
  const explanation = await turn(seller.cookie, sellerConv, "وش يعني VIP؟");
  assert.match(explanation.body, /VIP/);
  assert.equal((await db.select().from(listingPromotions)).length, before, "an explanation creates no campaign");

  const vip = await turn(seller.cookie, sellerConv, "أبي VIP لإعلاني الأول");
  assert.equal(vip.payload.surface, "VIP_REVIEW", vip.body);
  assert.match(vip.body, /VIP.*تيشرت نايكي أسود/);
  assert.match(vip.body, /رصيدك التجاري غير كافٍ/);
  const [vipState] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, vip.payload.resultSetId));
  assert.equal((vipState?.query as any)?.view, "VIP_REVIEW");
  assert.equal((vipState?.query as any)?.productType, "VIP_LISTING");
  assert.equal((vipState?.query as any)?.listingId, ownShirt, "the natural-language promotion remains bound to the seller's first listing");
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.listingId, ownShirt))).length, 0, "review does not create a campaign before confirmation");

  const buyerConv = await conversation(buyer.cookie);
  const search = await turn(buyer.cookie, buyerConv, `أبي ملابس ${runId}`);
  const rows = search.payload.listings as Array<{ id: string; isSponsored?: boolean }>;
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes(organicShirt) && ids.includes(sponsoredShirt), "relevant organic and sponsored clothing are eligible");
  assert.ok(!ids.includes(sponsoredCar), "unrelated sponsored car is excluded despite active campaign");
  assert.ok(rows.length > 0);
  assert.equal(rows.find((row) => row.id === sponsoredShirt)?.isSponsored, true, "canonical campaign metadata labels sponsored clothing");
  assert.notEqual(rows.find((row) => row.id === organicShirt)?.isSponsored, true, "organic clothing is not labeled sponsored");
  const carConv = await conversation(buyer.cookie);
  const carSearch = await turn(buyer.cookie, carConv, `أبي سيارة مستعملة ${runId}`);
  const carResult = (carSearch.payload.listings as Array<{ id: string; isSponsored?: boolean }>).find((row) => row.id === sponsoredCar);
  assert.ok(carResult, `the car is eligible under matching intent (runId ${runId}; query ${JSON.stringify(carSearch.payload.query)}; ${carSearch.body.slice(0, 160)})`);
  assert.equal(carResult.isSponsored, true, "its active car campaign serves under matching intent");
  } finally {
    for (const id of campaignIds)
      await db.delete(listingPromotions).where(eq(listingPromotions.id, id));
    if (vipPlanId) await db.delete(promotionProducts).where(eq(promotionProducts.id, vipPlanId));
    if (carPlanId) await db.delete(promotionProducts).where(eq(promotionProducts.id, carPlanId));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
