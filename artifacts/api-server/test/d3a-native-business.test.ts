/**
 * D3-A acceptance: a business runs entirely inside DINAR with no external website.
 *
 * Every test below executes against the real HTTP app and the disposable PostgreSQL database:
 * the same conversation adapter, the same listing authority, the same search and cart. D2 is not
 * published, so a VERIFIED identity exists only through the hard-guarded fixture hook; the
 * production path is proven to stay PENDING_D2 and to refuse publication honestly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  businessAuditEvents,
  businessListingLinks,
  businessOperatingProfiles,
  db,
  markets,
  offers,
  orders,
  pool,
  users,
} from "@workspace/db";
import { buildListingUpdateBody } from "../src/lib/listing-management";
import { resolveMarket } from "../src/lib/markets";
import { getModelGatewayCallCount } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import {
  d2IntegrationStatus,
  registerBusinessIdentityFixture,
} from "../src/lib/d2-business-identity";
import {
  ownedBusinessForActor,
  requireBusinessCapability,
  resolveBusinessAccess,
} from "../src/lib/business-access";
import {
  BUSINESS_CAPABILITIES,
  type BusinessCapability,
} from "../src/lib/business-capabilities";
import { publishBusinessDraft, updateBusinessListing } from "../src/lib/business-catalog";

requireSafeReplitDevelopmentDatabase("BDINAR_D3A_ACCEPTANCE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.BDINAR_D3A_D2_FIXTURES = "development";

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ipSequence = 0;

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

type Actor = { id: string; cookie: string };
const phoneBase = 55_100_000 + ((Date.now() + process.pid) % 300_000);
let phoneOffset = 0;
async function register(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `D3A-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR D3A ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, registered.cookie)).status, 200);
  return { id: registered.data.user.id, cookie: registered.cookie };
}

async function turn(actor: Actor, conversationId: string, message: string) {
  const response = await fetch(`${base}/ai/conversations/${conversationId}/turns`, {
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

const results: Record<string, "PASS" | "FAIL"> = {};
async function focused(id: string, name: string, body: () => Promise<void> | void) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}

let JO: Awaited<ReturnType<typeof resolveMarket>>;
let applicant: Actor;
let verified: Actor;
let buyer: Actor;
let other: Actor;
let staffMember: Actor;
let applicantConv = "";
let verifiedConv = "";
let buyerConv = "";
let otherConv = "";
let applicantBusinessId = "";
let verifiedBusinessId = "";
let otherBusinessId = "";
let setupPayload: Record<string, any>;
let reviewPayload: Record<string, any>;
let activatedPayload: Record<string, any>;
let draftPayload: Record<string, any>;
let draftIds: string[] = [];
let firstDraftIds: string[] = [];
let listingReviewPayload: Record<string, any>;
let catalogPayload: Record<string, any>;
let ordersPayload: Record<string, any>;
let insightsPayload: Record<string, any>;
let burgerId = "";
let juiceId = "";
let shawarmaId = "";
let burgerSnapshot: { createdAt: string; sellerId: string; marketId: string } | undefined;
const surfacesSeen: { payload: Record<string, any>; expected: string }[] = [];
const businessOf = async (id: string) =>
  (await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, id)))[0]!;
const offerOf = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const businessOffers = async (sellerId: string) =>
  db.select().from(offers).where(eq(offers.sellerId, sellerId));
const audits = async (businessId: string) =>
  db.select().from(businessAuditEvents).where(eq(businessAuditEvents.businessId, businessId));

async function completeSetup(actor: Actor, conversationId: string, intro: string, description: string, area: string, fulfilment: string) {
  const started = await turn(actor, conversationId, intro);
  assert.equal(started.business.view, "SETUP", JSON.stringify(started.business));
  const described = await turn(actor, conversationId, description);
  assert.equal(described.business.view, "SETUP", JSON.stringify(described.business));
  const located = await turn(actor, conversationId, area);
  assert.equal(located.business.view, "SETUP", JSON.stringify(located.business));
  const fulfilled = await turn(actor, conversationId, fulfilment);
  assert.equal(fulfilled.business.view, "PROFILE_REVIEW", JSON.stringify(fulfilled.business));
  return fulfilled;
}

async function publishDraft(actor: Actor, conversationId: string, number: number) {
  const review = await turn(actor, conversationId, `انشر المسودة ${number}`);
  assert.equal(review.business.view, "LISTING_REVIEW", JSON.stringify(review.business));
  assert.ok(review.business.pendingActionId, "the publish review must be a pending action");
  return turn(actor, conversationId, "أكد");
}

function keysMatching(value: unknown, pattern: RegExp, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => keysMatching(item, pattern, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(pattern.test(key) ? [`${path}.${key}`] : []),
    ...keysMatching(child, pattern, `${path}.${key}`),
  ]);
}

await test("setup: disposable loopback database, actors and conversations", async () => {
  const [row] = await db.select().from(markets).where(eq(markets.id, "JO"));
  JO = await resolveMarket(row!);
  [applicant, verified, buyer, other, staffMember] = await Promise.all(
    ["Applicant", "Verified", "Buyer", "Other", "Staff"].map(register),
  );
  [applicantConv, verifiedConv, buyerConv, otherConv] = await Promise.all([
    conversation(applicant),
    conversation(verified),
    conversation(buyer),
    conversation(other),
  ]);
});

await focused("D3A-01", "a stated business becomes an INTERNAL_DINAR draft, never a website", async () => {
  setupPayload = await turn(applicant, applicantConv, "عندي مطعم اسمه «مطعم الرمال» في عمان");
  surfacesSeen.push({ payload: setupPayload, expected: "BUSINESS_SETUP" });
  const business = setupPayload.business;
  assert.equal(business.view, "SETUP");
  assert.equal(business.operatingMode, "INTERNAL_DINAR");
  assert.equal(business.identityStatus, "PENDING_D2");
  assert.equal(business.canPublish, false);
  applicantBusinessId = business.businessId;
  assert.ok(applicantBusinessId);
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, applicantBusinessId));
  assert.equal(row!.status, "DRAFT");
  assert.equal(row!.operatingMode, "INTERNAL_DINAR");
  assert.equal(row!.identityStatus, "PENDING_D2");
  assert.equal(row!.d2BusinessId, null);
  assert.equal(row!.ownerUserId, applicant.id);
  assert.equal(row!.marketId, "JO");
  const created = (await audits(applicantBusinessId)).filter((event) => event.action === "BUSINESS_DRAFT_CREATED");
  assert.equal(created.length, 1);
  assert.equal(setupPayload.card.surfaceType, "BUSINESS_SETUP");
  assert.equal(setupPayload.card.resource.kind, "BUSINESS");
  assert.equal(setupPayload.card.resource.id, applicantBusinessId);
  assert.equal(getModelGatewayCallCount(), 0);
});

await focused("D3A-02", "repeating the setup request resumes the same draft instead of duplicating it", async () => {
  const again = await turn(applicant, applicantConv, "عندي مطعم اسمه «مطعم الرمال»");
  assert.equal(again.business.view, "SETUP");
  assert.equal(again.business.businessId, applicantBusinessId);
  const rows = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.ownerUserId, applicant.id));
  assert.equal(rows.length, 1);
});

await focused("D3A-03", "setup asks one conversational question at a time and stores each answer", async () => {
  const described = await turn(applicant, applicantConv, "أطباق شعبية طازجة");
  assert.equal(described.business.view, "SETUP");
  assert.equal(described.business.missingField, "area");
  assert.match(described.business.prompt, /مدينة|منطقة/u);
  const located = await turn(applicant, applicantConv, "في عمان");
  assert.equal(located.business.missingField, "fulfilment");
  const fulfilled = await turn(applicant, applicantConv, "استلام وتوصيل");
  reviewPayload = fulfilled;
  surfacesSeen.push({ payload: reviewPayload, expected: "BUSINESS_PROFILE_REVIEW" });
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, applicantBusinessId));
  assert.equal(row!.description, "أطباق شعبية طازجة");
  assert.equal(row!.profile.area, "عمان");
  assert.equal(row!.profile.fulfilment, "BOTH");
  assert.equal(row!.profile.setupDescription, true);
  assert.equal(row!.profile.setupArea, true);
  assert.equal(row!.profile.setupFulfilment, true);
});

await focused("D3A-04", "no commercial registration is answered honestly and is not stored as a field value", async () => {
  const started = await turn(other, otherConv, "عندي متجر اسمه «متجر النسيم»");
  assert.equal(started.business.view, "SETUP");
  otherBusinessId = started.business.businessId;
  const refusal = await turn(other, otherConv, "ما عندي سجل تجاري");
  assert.equal(refusal.business.view, "SETUP");
  assert.match(refusal.business.registrationNotice, /بدون سجل تجاري/u);
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, otherBusinessId));
  assert.equal(row!.description, "");
  assert.equal(row!.identityStatus, "PENDING_D2");
  const review = await completeSetup(other, otherConv, "عندي متجر اسمه «متجر النسيم»", "هدايا صغيرة", "في عمان", "استلام من الفرع");
  assert.equal(review.business.view, "PROFILE_REVIEW");
});

await focused("D3A-05", "a review exists before anything is activated and the business is still a draft", async () => {
  assert.equal(reviewPayload.business.view, "PROFILE_REVIEW");
  assert.ok(reviewPayload.business.pendingActionId);
  assert.ok(reviewPayload.business.expiresAt);
  assert.deepEqual(reviewPayload.business.allowedActions, ["ACTIVATE", "CANCEL"]);
  assert.ok(reviewPayload.business.reviewLines.some((line: string) => line.includes("DINAR")));
  assert.equal(reviewPayload.card.status.lifecycle, "PENDING_REVIEW");
  assert.equal(reviewPayload.card.pendingReviewId, reviewPayload.business.pendingActionId);
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, applicantBusinessId));
  assert.equal(row!.status, "DRAFT");
  assert.equal(row!.version, 1);
  const [reviewRow] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, reviewPayload.business.pendingActionId));
  assert.equal(reviewRow!.query.kind, "BUSINESS_SETUP");
  assert.equal(reviewRow!.query.status, "PENDING");
  assert.equal(reviewRow!.query.ownerId, applicant.id);
});

await focused("D3A-06", "only an explicit decision activates the business, once, with audit evidence", async () => {
  activatedPayload = await turn(applicant, applicantConv, "أكد");
  surfacesSeen.push({ payload: activatedPayload, expected: "BUSINESS_PROFILE" });
  assert.equal(activatedPayload.business.view, "PROFILE");
  assert.equal(activatedPayload.business.status, "ACTIVE");
  assert.match(activatedPayload.business.blockedReason, /اعتماد هوية النشاط التجاري/u);
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, applicantBusinessId));
  assert.equal(row!.status, "ACTIVE");
  assert.equal(row!.version, 2);
  assert.equal(row!.identityStatus, "PENDING_D2");
  assert.equal((await audits(applicantBusinessId)).filter((event) => event.action === "BUSINESS_ACTIVATED").length, 1);
  assert.equal(activatedPayload.card.status.lifecycle, "READY");
  assert.equal(activatedPayload.card.resource.id, applicantBusinessId);
});

await focused("D3A-07", "a repeated «أكد» is answered, not executed twice", async () => {
  const repeated = await turn(applicant, applicantConv, "أكد");
  assert.match(repeated.business.notice, /تمت معالجة هذا الإجراء من قبل/u);
  assert.deepEqual(repeated.business.allowedActions, []);
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, applicantBusinessId));
  assert.equal(row!.version, 2);
  assert.equal((await audits(applicantBusinessId)).filter((event) => event.action === "BUSINESS_ACTIVATED").length, 1);
});

await focused("D3A-08", "cancelling the setup review leaves the business a draft", async () => {
  const cancelled = await turn(other, otherConv, "إلغاء");
  assert.equal(cancelled.business.view, "PROFILE_REVIEW");
  assert.match(cancelled.business.notice, /أُلغي التشغيل/u);
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, otherBusinessId));
  assert.equal(row!.status, "DRAFT");
  const [reviewRow] = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, otherConv),
      eq(aiResultSets.query.kind as any, "BUSINESS_SETUP"),
    ));
  assert.equal((reviewRow!.query as { status: string }).status, "CANCELLED");
});

await focused("D3A-09", "a buyer has no business authority, even by direct service call", async () => {
  const business = await businessOf(applicantBusinessId);
  const access = await resolveBusinessAccess({ business, actorId: buyer.id, marketId: "JO" });
  assert.equal(access.actorClass, "NONE");
  assert.equal(access.capabilities.size, 0);
  assert.equal(await ownedBusinessForActor({ businessId: applicantBusinessId, actorId: buyer.id, marketId: "JO" }), undefined);
  await assert.rejects(
    requireBusinessCapability({ business, actorId: buyer.id, marketId: "JO", capability: "business.read" }),
    (error: any) => error.status === 404,
  );
});

await focused("D3A-10", "an unverified owner keeps drafts and publication is refused with PENDING_D2", async () => {
  const drafts = await turn(applicant, applicantConv, "جهز لي ثلاث عروض: شاورما 2.500، برجر 3.250، عصير 1.000");
  assert.equal(drafts.business.view, "CATALOG_DRAFT");
  assert.equal(drafts.business.drafts.length, 3);
  assert.deepEqual(drafts.business.drafts.map((draft: any) => draft.priceMinor), [2500, 3250, 1000]);
  const before = (await businessOffers(applicant.id)).length;
  const publish = await turn(applicant, applicantConv, "انشر المسودة 1");
  assert.equal(publish.business.view, "LISTING_REVIEW");
  assert.match(publish.business.notice, /اعتماد هوية النشاط التجاري/u);
  assert.deepEqual(publish.business.allowedActions, []);
  assert.equal((await businessOffers(applicant.id)).length, before);
  const pending = await db
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, applicantConv),
      eq(aiResultSets.query.kind as any, "BUSINESS_ACTION"),
    ));
  assert.equal(pending.length, 0);
  const rows = await db.select().from(businessListingLinks).where(eq(businessListingLinks.businessId, applicantBusinessId));
  assert.equal(rows.length, 0);
});

await focused("D3A-11", "the D2 fixture hook is hard-guarded; production reporting stays PENDING_D2", () => {
  delete process.env.BDINAR_D3A_D2_FIXTURES;
  try {
    assert.equal(d2IntegrationStatus(), "PENDING_D2");
    assert.throws(
      () => registerBusinessIdentityFixture({
        businessId: applicantBusinessId,
        ownerUserId: applicant.id,
        marketId: "JO",
        businessType: "RESTAURANT",
        verificationStatus: "VERIFIED",
        publicationEligibility: "ELIGIBLE",
        membershipPermissions: [...BUSINESS_CAPABILITIES],
        businessStatus: "ACTIVE",
        policyVersion: "D2-test",
      }),
      /BDINAR_D3A_D2_FIXTURES/u,
    );
  } finally {
    process.env.BDINAR_D3A_D2_FIXTURES = "development";
  }
  assert.equal(d2IntegrationStatus(), "FIXTURE");
  const business = db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, applicantBusinessId));
  assert.ok(business);
});

await focused("D3A-12", "a verified business exists inside DINAR and starts from its own onboarding", async () => {
  const review = await completeSetup(verified, verifiedConv, "عندي مطعم اسمه «مطعم الأصيل»", "مأكولات بحرية", "في عمان", "استلام وتوصيل");
  verifiedBusinessId = review.business.businessId;
  const activated = await turn(verified, verifiedConv, "أكد");
  assert.equal(activated.business.view, "PROFILE");
  assert.equal(activated.business.status, "ACTIVE");
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, verifiedBusinessId));
  assert.equal(row!.ownerUserId, verified.id);
  assert.equal(row!.identityStatus, "PENDING_D2");
});

await focused("D3A-13", "verified access comes from the D2 identity, never from the D3 record", async () => {
  registerBusinessIdentityFixture({
    businessId: verifiedBusinessId,
    ownerUserId: verified.id,
    marketId: "JO",
    businessType: "RESTAURANT",
    verificationStatus: "VERIFIED",
    publicationEligibility: "ELIGIBLE",
    membershipPermissions: [...BUSINESS_CAPABILITIES],
    businessStatus: "ACTIVE",
    policyVersion: "D2-2026-11",
    memberships: [{
      userId: staffMember.id,
      role: "STAFF",
      permissions: ["business.catalog.read", "business.orders.read", "business.catalog.draft"],
    }],
  });
  await db.update(businessOperatingProfiles).set({ d2BusinessId: verifiedBusinessId }).where(eq(businessOperatingProfiles.id, verifiedBusinessId));
  const business = await businessOf(verifiedBusinessId);
  const access = await resolveBusinessAccess({ business, actorId: verified.id, marketId: "JO" });
  assert.equal(access.actorClass, "VERIFIED_OWNER");
  assert.equal(access.verified, true);
  assert.equal(access.publishable, true);
  assert.equal(access.policyVersion, "D2-2026-11");
  assert.deepEqual([...access.capabilities].sort(), [...BUSINESS_CAPABILITIES].sort());
});

await focused("D3A-14", "staff receive only the D2-granted capabilities", async () => {
  const business = await businessOf(verifiedBusinessId);
  const access = await resolveBusinessAccess({ business, actorId: staffMember.id, marketId: "JO" });
  assert.equal(access.role, "STAFF");
  assert.equal(access.actorClass, "STAFF");
  assert.deepEqual([...access.capabilities].sort(), ["business.catalog.draft", "business.catalog.read", "business.orders.read"]);
  assert.equal(access.capabilities.has("business.catalog.publish"), false);
  await assert.rejects(
    requireBusinessCapability({ business, actorId: staffMember.id, marketId: "JO", capability: "business.catalog.publish" }),
    (error: any) => error.status === 403,
  );
});

await focused("D3A-15", "the Arabic example becomes three typed drafts with exact minor units", async () => {
  draftPayload = await turn(verified, verifiedConv, "جهز لي ثلاث عروض: شاورما 2.500، برجر 3.250، عصير 1.000");
  surfacesSeen.push({ payload: draftPayload, expected: "BUSINESS_CATALOG_DRAFT" });
  assert.equal(draftPayload.business.view, "CATALOG_DRAFT");
  const drafts = draftPayload.business.drafts;
  assert.equal(drafts.length, 3);
  assert.deepEqual(drafts.map((draft: any) => draft.title), ["شاورما", "برجر", "عصير"]);
  assert.deepEqual(drafts.map((draft: any) => draft.priceMinor), [2500, 3250, 1000]);
  assert.deepEqual(drafts.map((draft: any) => draft.currency), ["JOD", "JOD", "JOD"]);
  assert.ok(drafts.every((draft: any) => draft.categoryId === "other"));
  assert.ok(drafts.every((draft: any) => draft.area === "عمان"));
  assert.deepEqual(draftPayload.business.allowedActions, ["PUBLISH"]);
  assert.equal(draftPayload.card.surfaceType, "BUSINESS_CATALOG_DRAFT");
  assert.equal((await businessOffers(verified.id)).length, 0);
  firstDraftIds = drafts.map((draft: any) => draft.draftId);
});

await focused("D3A-16", "repeating draft preparation creates new typed drafts, never listings", async () => {
  const retried = await turn(verified, verifiedConv, "جهز لي ثلاث عروض: شاورما 2.500، برجر 3.250، عصير 1.000");
  assert.equal(retried.business.view, "CATALOG_DRAFT");
  assert.equal(retried.business.drafts.length, 3);
  draftPayload = retried;
  draftIds = retried.business.drafts.map((draft: any) => draft.draftId);
  assert.ok(draftIds.every((id: string) => !firstDraftIds.includes(id)));
  assert.equal((await businessOffers(verified.id)).length, 0);
});

await focused("D3A-17", "publishing needs a review; nothing is written before confirmation", async () => {
  listingReviewPayload = await turn(verified, verifiedConv, "انشر المسودة 1");
  surfacesSeen.push({ payload: listingReviewPayload, expected: "BUSINESS_LISTING_REVIEW" });
  assert.equal(listingReviewPayload.business.view, "LISTING_REVIEW");
  assert.ok(listingReviewPayload.business.pendingActionId);
  assert.deepEqual(listingReviewPayload.business.allowedActions, ["CONFIRM", "CANCEL"]);
  assert.ok(listingReviewPayload.business.lines.some((line: string) => line.includes("2.500")));
  assert.equal((await businessOffers(verified.id)).length, 0);
  const [action] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, listingReviewPayload.business.pendingActionId));
  assert.equal(action!.query.kind, "BUSINESS_ACTION");
  assert.equal(action!.query.action, "PUBLISH_DRAFT");
  assert.equal(action!.query.status, "PENDING");
  assert.equal(action!.query.idempotencyKey, draftIds[0]);
});

await focused("D3A-18", "confirmation publishes through the canonical listing authority with a link and audit", async () => {
  const published = await turn(verified, verifiedConv, "أكد");
  assert.equal(published.business.view, "PROFILE");
  assert.match(published.business.notice, /نُشر/u);
  shawarmaId = draftIds[0]!;
  const offer = await offerOf(shawarmaId);
  assert.equal(offer.status, "PUBLISHED");
  assert.equal(offer.unitPriceMinor, 2500);
  assert.equal(offer.sellerId, verified.id);
  assert.equal(offer.marketId, "JO");
  const [link] = await db.select().from(businessListingLinks).where(eq(businessListingLinks.listingId, shawarmaId));
  assert.equal(link!.businessId, verifiedBusinessId);
  assert.equal(link!.marketId, "JO");
  assert.ok((await audits(verifiedBusinessId)).some((event) => event.action === "LISTING_PUBLISHED" && event.resourceId === shawarmaId));
  burgerSnapshot = undefined;
  assert.equal((await businessOffers(verified.id)).length, 1);
});

await focused("D3A-19", "repeating a confirmed publish never duplicates the listing or its link", async () => {
  await publishDraft(verified, verifiedConv, 1);
  const rows = await db.select().from(offers).where(eq(offers.id, shawarmaId));
  assert.equal(rows.length, 1);
  const links = await db.select().from(businessListingLinks).where(eq(businessListingLinks.listingId, shawarmaId));
  assert.equal(links.length, 1);
  assert.equal((await businessOffers(verified.id)).length, 1);
  assert.equal((await offerOf(shawarmaId)).unitPriceMinor, 2500);
});

await focused("D3A-20", "the remaining drafts publish with their stated prices", async () => {
  await publishDraft(verified, verifiedConv, 2);
  await publishDraft(verified, verifiedConv, 3);
  burgerId = draftIds[1]!;
  juiceId = draftIds[2]!;
  const burger = await offerOf(burgerId);
  const juice = await offerOf(juiceId);
  assert.equal(burger.unitPriceMinor, 3250);
  assert.equal(juice.unitPriceMinor, 1000);
  assert.equal(burger.status, "PUBLISHED");
  assert.equal(juice.status, "PUBLISHED");
  const links = await db.select().from(businessListingLinks).where(eq(businessListingLinks.businessId, verifiedBusinessId));
  assert.equal(links.length, 3);
  burgerSnapshot = { createdAt: burger.createdAt.toISOString(), sellerId: burger.sellerId, marketId: burger.marketId };
});

await focused("D3A-21", "the catalog card is the server's own catalog summary", async () => {
  catalogPayload = await turn(verified, verifiedConv, "منتجاتي");
  surfacesSeen.push({ payload: catalogPayload, expected: "BUSINESS_CATALOG" });
  const business = catalogPayload.business;
  assert.equal(business.view, "CATALOG");
  assert.equal(business.summary.total, 3);
  assert.equal(business.summary.published, 3);
  assert.equal(business.summary.paused, 0);
  assert.equal(business.businessId, verifiedBusinessId);
  assert.deepEqual(business.listings.map((listing: any) => listing.priceMinor).sort((a: number, b: number) => a - b), [1000, 2500, 3250]);
  assert.ok(business.allowedActions.includes("PAUSE"));
  assert.ok(business.allowedActions.includes("PRICE"));
  assert.equal(catalogPayload.card.surfaceType, "BUSINESS_CATALOG");
  assert.equal(catalogPayload.card.resource.kind, "BUSINESS");
  assert.deepEqual(
    (await db.select().from(businessListingLinks).where(eq(businessListingLinks.businessId, verifiedBusinessId))).length,
    3,
  );
});

await focused("D3A-22", "a price review can be cancelled without changing the listing", async () => {
  const review = await turn(verified, verifiedConv, "غير سعر البرجر إلى 3.750");
  assert.equal(review.business.view, "LISTING_REVIEW");
  assert.ok(review.business.lines.some((line: string) => line.includes("3.250")));
  assert.ok(review.business.lines.some((line: string) => line.includes("3.750")));
  const cancelled = await turn(verified, verifiedConv, "إلغاء");
  assert.match(cancelled.business.notice, /أُلغي الإجراء/u);
  assert.equal((await offerOf(burgerId)).unitPriceMinor, 3250);
  const [action] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, review.business.pendingActionId));
  assert.equal(action!.query.status, "CANCELLED");
});

await focused("D3A-23", "a confirmed price change updates the canonical listing and is audited", async () => {
  const review = await turn(verified, verifiedConv, "غير سعر البرجر إلى 3.750");
  assert.equal(review.business.view, "LISTING_REVIEW");
  const result = await turn(verified, verifiedConv, "أكد");
  assert.equal(result.business.view, "CATALOG");
  assert.match(result.business.notice, /تم تحديث السعر/u);
  const offer = await offerOf(burgerId);
  assert.equal(offer.unitPriceMinor, 3750);
  assert.equal(offer.sellerId, burgerSnapshot!.sellerId);
  assert.equal(offer.marketId, burgerSnapshot!.marketId);
  assert.equal(offer.createdAt.toISOString(), burgerSnapshot!.createdAt);
  assert.ok((await audits(verifiedBusinessId)).some((event) => event.action === "LISTING_UPDATED" && event.resourceId === burgerId));
});

await focused("D3A-24", "a listing changed after its review is refused, never overwritten", async () => {
  const review = await turn(verified, verifiedConv, "غير سعر العصير إلى 1.500");
  assert.equal(review.business.view, "LISTING_REVIEW");
  await db.update(offers).set({ unitPriceMinor: 1750, updatedAt: new Date() }).where(eq(offers.id, juiceId));
  const stale = await turn(verified, verifiedConv, "أكد");
  assert.equal(stale.business.view, "LISTING_REVIEW");
  assert.equal(stale.business.stale, true);
  assert.match(stale.business.notice, /تغيّر العرض منذ المعاينة/u);
  assert.equal((await offerOf(juiceId)).unitPriceMinor, 1750);
  const [action] = await db.select().from(aiResultSets).where(eq(aiResultSets.id, review.business.pendingActionId));
  assert.equal(action!.query.status, "FAILED");
  const fresh = await turn(verified, verifiedConv, "غير سعر العصير إلى 1.500");
  assert.equal(fresh.business.view, "LISTING_REVIEW");
  const done = await turn(verified, verifiedConv, "أكد");
  assert.equal(done.business.view, "CATALOG");
  assert.equal((await offerOf(juiceId)).unitPriceMinor, 1500);
});

await focused("D3A-25", "pause is reviewed, confirmed, and hides the listing from buyers", async () => {
  const review = await turn(verified, verifiedConv, "أوقف منتج العصير");
  assert.equal(review.business.view, "LISTING_REVIEW");
  const paused = await turn(verified, verifiedConv, "أكد");
  assert.match(paused.business.notice, /أُوقف المنتج/u);
  assert.equal((await offerOf(juiceId)).status, "PAUSED");
  const found = await request(`/listings?search=${encodeURIComponent("عصير")}`, "GET", undefined, buyer.cookie);
  assert.equal(found.status, 200);
  assert.ok(!found.data.some((listing: any) => listing.id === juiceId));
});

await focused("D3A-26", "resume is reviewed, confirmed, and returns the listing to search", async () => {
  const blocked = await request(`/listings/${juiceId}`, "GET", undefined, buyer.cookie);
  assert.equal(blocked.status, 404);
  const review = await turn(verified, verifiedConv, "فعل منتج العصير");
  assert.equal(review.business.view, "LISTING_REVIEW");
  const resumed = await turn(verified, verifiedConv, "أكد");
  assert.match(resumed.business.notice, /أُعيد تفعيل المنتج/u);
  assert.equal((await offerOf(juiceId)).status, "PUBLISHED");
  const found = await request(`/listings?search=${encodeURIComponent("عصير")}`, "GET", undefined, buyer.cookie);
  assert.ok(found.data.some((listing: any) => listing.id === juiceId));
});

await focused("D3A-27", "stock-out uses the canonical pause and preserves the listing history", async () => {
  const before = await offerOf(shawarmaId);
  const review = await turn(verified, verifiedConv, "خلص منتج الشاورما");
  assert.equal(review.business.view, "LISTING_REVIEW");
  assert.ok(review.business.lines.some((line: string) => line.includes("نفاد")));
  const done = await turn(verified, verifiedConv, "أكد");
  assert.equal(done.business.view, "CATALOG");
  const after = await offerOf(shawarmaId);
  assert.equal(after.status, "PAUSED");
  assert.equal(after.availableQuantity, before.availableQuantity);
  assert.equal(after.sellerId, before.sellerId);
  assert.equal(after.createdAt.toISOString(), before.createdAt.toISOString());
});

await focused("D3A-28", "buyers discover business listings only through the canonical search", async () => {
  const found = await request(`/listings?search=${encodeURIComponent("برجر")}`, "GET", undefined, buyer.cookie);
  assert.equal(found.status, 200);
  const burger = found.data.find((listing: any) => listing.id === burgerId);
  assert.ok(burger, "the published business listing must be discoverable");
  assert.equal(burger.sellerId, verified.id);
  const paused = await request(`/listings?search=${encodeURIComponent("شاورما")}`, "GET", undefined, buyer.cookie);
  assert.ok(!paused.data.some((listing: any) => listing.id === shawarmaId));
});

await focused("D3A-29", "buyers add a business listing to the canonical cart; no order is invented", async () => {
  const added = await request("/cart", "PUT", { marketId: "JO", items: [{ listingId: burgerId, quantity: 1 }] }, buyer.cookie);
  assert.equal(added.status, 200, added.raw);
  const cart = await request("/cart", "GET", undefined, buyer.cookie);
  assert.equal(cart.status, 200);
  const items = (Array.isArray(cart.data) ? cart.data : cart.data.items ?? cart.data.lines ?? []) as any[];
  assert.ok(items.some((item: any) => item.listingId === burgerId));
  assert.equal((await db.select().from(orders).where(eq(orders.sellerId, verified.id))).length, 0);
});

await focused("D3A-30", "the orders card is an honest empty state, not an invented order", async () => {
  ordersPayload = await turn(verified, verifiedConv, "طلبات النشاط");
  surfacesSeen.push({ payload: ordersPayload, expected: "BUSINESS_ORDERS" });
  assert.equal(ordersPayload.business.view, "ORDERS");
  assert.deepEqual(ordersPayload.business.orders, []);
  assert.equal(ordersPayload.business.empty, true);
  assert.match(ordersPayload.body ?? ordersPayload.business.notice ?? "", /لا توجد/u);
  assert.equal((await db.select().from(orders).where(eq(orders.sellerId, verified.id))).length, 0);
});

await focused("D3A-31", "the insights card is derived from the same rows the owner can inspect", async () => {
  insightsPayload = await turn(verified, verifiedConv, "أداء النشاط");
  surfacesSeen.push({ payload: insightsPayload, expected: "BUSINESS_INSIGHTS" });
  assert.equal(insightsPayload.business.view, "INSIGHTS");
  const insights = insightsPayload.business.insights;
  assert.equal(insights.listings, 3);
  assert.equal(insights.published, 2);
  assert.equal(insights.paused, 1);
  assert.equal(insights.completedOrders, 0);
  assert.equal(insights.completedRevenueMinor, 0);
  assert.equal(insights.completedRevenue, "0.000 JOD");
  const links = await db.select().from(businessListingLinks).where(eq(businessListingLinks.businessId, verifiedBusinessId));
  assert.equal(links.length, insights.listings);
});

await focused("D3A-32", "the public storefront exposes only public fields and live listings", async () => {
  const page = await request(`/businesses/${verifiedBusinessId}`, "GET", undefined, buyer.cookie);
  assert.equal(page.status, 200, page.raw);
  assert.deepEqual(
    Object.keys(page.data).sort(),
    ["businessType", "businessTypeLabel", "currency", "description", "id", "listingCount", "listings", "marketId", "name", "operatingMode", "profile", "verificationStatus", "verified"].sort(),
  );
  assert.equal(page.data.verified, true);
  assert.equal(page.data.verificationStatus, "VERIFIED");
  assert.equal(page.data.operatingMode, "INTERNAL_DINAR");
  assert.equal(page.data.profile.area, "عمان");
  assert.equal(page.data.profile.fulfilment, "BOTH");
  assert.equal(page.data.listingCount, 2);
  assert.deepEqual(page.data.listings.map((listing: any) => listing.id).sort(), [burgerId, juiceId].sort());
  assert.ok(!page.raw.includes("ownerUserId"));
  assert.ok(page.data.listings.every((listing: any) => listing.contactPhone === null));
  assert.ok(!page.raw.includes("audit"));
  assert.ok(!page.raw.includes("insights"));
});

await focused("D3A-33", "a suspended business disappears from the storefront, search and listing pages", async () => {
  await db.update(businessOperatingProfiles).set({ status: "SUSPENDED", updatedAt: new Date() }).where(eq(businessOperatingProfiles.id, verifiedBusinessId));
  const page = await request(`/businesses/${verifiedBusinessId}`, "GET", undefined, buyer.cookie);
  assert.equal(page.status, 404);
  const found = await request(`/listings?search=${encodeURIComponent("برجر")}`, "GET", undefined, buyer.cookie);
  assert.ok(!found.data.some((listing: any) => listing.id === burgerId));
  const detail = await request(`/listings/${burgerId}`, "GET", undefined, buyer.cookie);
  assert.equal(detail.status, 404);
  const ownerView = await request(`/listings/${burgerId}`, "GET", undefined, verified.cookie);
  assert.equal(ownerView.status, 200);
  const access = await resolveBusinessAccess({ business: await businessOf(verifiedBusinessId), actorId: verified.id, marketId: "JO" });
  assert.deepEqual([...access.capabilities], ["business.read"]);
  assert.equal(access.publishable, false);
  await db.update(businessOperatingProfiles).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(businessOperatingProfiles.id, verifiedBusinessId));
  const restored = await request(`/businesses/${verifiedBusinessId}`, "GET", undefined, buyer.cookie);
  assert.equal(restored.status, 200);
});

const listingBody = (title: string, price: string, extra: Record<string, unknown> = {}) => ({
  title,
  description: `وصف ${title}`,
  category: "أخرى",
  categoryId: "other",
  area: "عمان",
  attributes: {},
  unitPrice: price,
  inventoryMode: "UNLIMITED",
  fulfilmentType: "PICKUP",
  imageUrl: "",
  imageUrls: [],
  ...extra,
});

await focused("D3A-34", "a request body cannot attach a listing to a business", async () => {
  const own = await request("/listings", "POST", listingBody("إعلان حقن خاص", "3.000", { businessId: verifiedBusinessId }), verified.cookie);
  assert.equal(own.status, 201, own.raw);
  const foreign = await request("/listings", "POST", listingBody("إعلان حقن آخر", "3.000", { businessId: applicantBusinessId }), verified.cookie);
  assert.equal(foreign.status, 201, foreign.raw);
  for (const id of [own.data.id, foreign.data.id]) {
    const links = await db.select().from(businessListingLinks).where(eq(businessListingLinks.listingId, id));
    assert.equal(links.length, 0);
  }
});

await focused("D3A-35", "another account's listing cannot be changed through a business", async () => {
  const personal = await request("/listings", "POST", listingBody("إعلان شخصي مستقل", "4.000"), other.cookie);
  assert.equal(personal.status, 201, personal.raw);
  const personalId = personal.data.id as string;
  const [row] = await db.select().from(offers).where(eq(offers.id, personalId));
  const body = buildListingUpdateBody(row!, JO);
  await assert.rejects(
    updateBusinessListing({
      businessId: verifiedBusinessId,
      listingId: personalId,
      actorId: verified.id,
      market: JO,
      body,
    }),
    (error: any) => error.status === 404 && /المنتج غير موجود/u.test(error.message),
  );
  assert.equal((await offerOf(personalId)).unitPriceMinor, row!.unitPriceMinor);
});

await focused("D3A-36", "direct service calls deny buyers and staff without publication grants", async () => {
  const [buyerRow] = await db.select().from(users).where(eq(users.id, buyer.id));
  await assert.rejects(
    publishBusinessDraft({ businessId: verifiedBusinessId, actor: buyerRow!, market: JO, body: listingBody("ممنوع", "2.000"), idempotencyKey: randomUUID() }),
    (error: any) => error.status === 404,
  );
  const [staffRow] = await db.select().from(users).where(eq(users.id, staffMember.id));
  await assert.rejects(
    publishBusinessDraft({ businessId: verifiedBusinessId, actor: staffRow!, market: JO, body: listingBody("ممنوع", "2.000"), idempotencyKey: randomUUID() }),
    (error: any) => error.status === 403,
  );
  assert.equal((await businessOffers(buyer.id)).length, 0);
});

await focused("D3A-37", "the audit trail is append-only for updates, deletes and truncates", async () => {
  const [event] = await db.select().from(businessAuditEvents).where(eq(businessAuditEvents.businessId, verifiedBusinessId)).limit(1);
  assert.ok(event);
  await assert.rejects(
    pool.query("UPDATE business_audit_events SET action = action WHERE id = $1", [event!.id]),
    (error: any) => error.code === "23514",
  );
  await assert.rejects(
    pool.query("DELETE FROM business_audit_events WHERE id = $1", [event!.id]),
    (error: any) => error.code === "23514",
  );
  await assert.rejects(
    pool.query("TRUNCATE business_audit_events"),
    (error: any) => error.code === "23514",
  );
  assert.ok((await audits(verifiedBusinessId)).length >= 1);
});

await focused("D3A-38", "the database rejects any D3-claimed identity or external operating mode", async () => {
  await assert.rejects(
    pool.query("UPDATE business_operating_profiles SET identity_status = 'VERIFIED' WHERE id = $1", [verifiedBusinessId]),
    (error: any) => error.code === "23514",
  );
  await assert.rejects(
    pool.query("UPDATE business_operating_profiles SET operating_mode = 'EXTERNAL_WEBSITE' WHERE id = $1", [verifiedBusinessId]),
    (error: any) => error.code === "23514",
  );
  const [row] = await db.select().from(businessOperatingProfiles).where(eq(businessOperatingProfiles.id, verifiedBusinessId));
  assert.equal(row!.identityStatus, "PENDING_D2");
  assert.equal(row!.operatingMode, "INTERNAL_DINAR");
});

await focused("D3A-39", "editing through the business keeps ownership and the historical snapshot", async () => {
  const offer = await offerOf(burgerId);
  assert.equal(offer.sellerId, burgerSnapshot!.sellerId);
  assert.equal(offer.marketId, burgerSnapshot!.marketId);
  assert.equal(offer.createdAt.toISOString(), burgerSnapshot!.createdAt);
  const [link] = await db.select().from(businessListingLinks).where(eq(businessListingLinks.listingId, burgerId));
  assert.equal(link!.businessId, verifiedBusinessId);
  assert.equal(link!.marketId, "JO");
});

await focused("D3A-40", "all eight business surfaces carry a safe envelope with a stable identity", async () => {
  const expected = ["BUSINESS_SETUP", "BUSINESS_PROFILE_REVIEW", "BUSINESS_PROFILE", "BUSINESS_CATALOG", "BUSINESS_CATALOG_DRAFT", "BUSINESS_LISTING_REVIEW", "BUSINESS_ORDERS", "BUSINESS_INSIGHTS"];
  assert.deepEqual(surfacesSeen.map((entry) => entry.expected).sort(), [...expected].sort());
  for (const { payload, expected: surface } of surfacesSeen) {
    const business = payload.business;
    assert.ok(payload.card, `${surface} must carry a card envelope`);
    assert.equal(payload.card.schemaVersion, 1);
    assert.equal(payload.card.surfaceType, surface);
    assert.equal(payload.card.resource.kind, "BUSINESS");
    assert.equal(payload.card.resource.id, business.businessId);
    assert.equal(payload.card.context.role, "SELLER");
    assert.ok(Array.isArray(payload.card.allowedActions));
    for (const action of payload.card.allowedActions) assert.match(action, /^[A-Z][A-Z0-9_]{0,39}$/u);
    assert.deepEqual(
      keysMatching(business, /secret|password|credential|api.?key|token|contact.?phone|owner.?user|identity.?document|registration.?number/iu),
      [],
    );
    assert.ok(!JSON.stringify(business).includes("ownerUserId"));
  }
  const loaded = await request(`/ai/conversations/${verifiedConv}`, "GET", undefined, verified.cookie);
  assert.equal(loaded.status, 200, loaded.raw);
  const blocks = loaded.data.messages
    .flatMap((message: any) => message.blocks)
    .filter((block: any) => block.payload?.business?.view === "CATALOG" && block.payload.business.businessId === verifiedBusinessId);
  assert.ok(blocks.length >= 1);
  const stored = blocks.find((block: any) => block.payload.resultSetId === catalogPayload.business.resultSetId);
  assert.ok(stored, "the catalog card must rehydrate after a reload");
  assert.equal(stored.payload.card.surfaceId, catalogPayload.card.surfaceId);
  assert.equal(stored.payload.card.resource.id, verifiedBusinessId);
  assert.equal(stored.payload.business.listings.find((listing: any) => listing.listingId === shawarmaId).status, "PAUSED");
  assert.equal(getModelGatewayCallCount(), 0);
});

await test("summary", async () => {
  const ids = Object.keys(results).sort();
  console.log("D3A_SUMMARY", JSON.stringify({
    passed: ids.filter((id) => results[id] === "PASS").length,
    total: ids.length,
    results,
    modelCalls: getModelGatewayCallCount(),
  }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
