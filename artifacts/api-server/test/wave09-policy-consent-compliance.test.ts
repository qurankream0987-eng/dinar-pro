/**
 * Wave 09 — policy lifecycle, explicit consent, seller verification, age/guardian gates and the
 * legal-entity registry. Every claim is checked against PostgreSQL; no test treats a chat
 * message, a model output or an unconfigured market as consent or approval.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  legalEntities,
  marketComplianceSettings,
  markets,
  minorProtectionDeclarations,
  policyConsentEvents,
  policyRegistryVersions,
  pool,
  sellerVerificationProfiles,
  users,
} from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import app from "../src/app";
import { currentPolicies, currentPolicy } from "../src/lib/policies";
import { policyContentSha256 } from "../src/lib/policy-lifecycle";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W09_ACCEPTANCE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const key = (label: string) => `w09-${label}-${runId}-${randomUUID().slice(0, 6)}`;
const password = "w09-password-000000001";

type Actor = { id: string; cookie: string; marketId: string };
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  actor?: Actor,
) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined
        ? { "content-type": "application/json", origin }
        : {}),
      ...(actor ? { cookie: actor.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

let phoneCounter = 0;
async function register(name: string): Promise<Actor> {
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${String(phoneCounter++ % 10)}`;
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      displayName: name,
      phoneCountryCode: "+962",
      phoneNumber: number,
      accountCountry: "JO",
      password,
      confirmPassword: password,
      acceptTerms: true,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("bdinar_session="))!
    .split(";")[0]!;
  const user = JSON.parse(text).user;
  return { id: user.id, cookie, marketId: user.activeMarketId ?? DEFAULT_MARKET };
}

const seller = await register("بائع W09");
const buyer = await register("مشتري W09");
const admin = await register("إدارة W09");
const guardian = await register("ولي أمر W09");
const minor = await register("قاصر W09");
const minorTwo = await register("قاصر ثانٍ W09");
const stranger = await register("غريب W09");
const marketId = seller.marketId;

await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));
const [market] = await db
  .select({ id: markets.id })
  .from(markets)
  .where(eq(markets.id, marketId));
assert.ok(market, "the acceptance market exists");

async function publish(as: Actor, label: string) {
  return request(
    "/listings",
    "POST",
    {
      title: `${label} ${runId}`,
      description: `وصف تفصيلي لاختبار الالتزام ${label} ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "الصويفية",
      city: "عمّان",
      attributes: {},
      pricingMode: "FIXED",
      inventoryMode: "LIMITED",
      fulfilmentType: "PICKUP",
      unitPrice: "20",
      availableQuantity: 50,
      imageUrl: "",
      imageUrls: [],
      clientRequestId: randomUUID(),
    },
    as,
  );
}

async function settings(patch: Record<string, unknown>) {
  const response = await request(
    `/admin/compliance/markets/${marketId}`,
    "PUT",
    patch,
    admin,
  );
  assert.equal(response.status, 200, response.text);
  return response.data;
}
// ─── Policies and consent ────────────────────────────────────────────────────

await test("policy summaries carry a content hash and an honest unregistered lifecycle", async () => {
  const response = await request("/policies");
  assert.equal(response.status, 200, response.text);
  const terms = response.data.policies.find(
    (policy: any) => policy.key === "terms",
  );
  assert.ok(terms);
  assert.equal(terms.lifecycle, "NOT_REGISTERED");
  assert.equal(
    terms.contentSha256,
    policyContentSha256(currentPolicy("terms")!),
  );
  assert.match(terms.contentSha256, /^[0-9a-f]{64}$/);
});

await test("registration records one explicit signup consent per required policy", async () => {
  const rows = await db
    .select()
    .from(policyConsentEvents)
    .where(eq(policyConsentEvents.userId, seller.id));
  const required = currentPolicies().filter(
    (policy) => policy.requiresAcceptance,
  );
  assert.equal(rows.length, required.length);
  for (const policy of required) {
    const row = rows.find((item) => item.policyKey === policy.key);
    assert.ok(row, `missing signup consent for ${policy.key}`);
    assert.equal(row!.source, "SIGNUP");
    assert.equal(row!.decision, "ACCEPTED");
    assert.equal(row!.contentSha256, policyContentSha256(policy));
    assert.equal(row!.policyVersion, policy.version);
  }
});

await test("a consent decision is explicit, idempotent and never derived from another source", async () => {
  const idempotencyKey = key("consent");
  const body = {
    key: "sponsored-listings",
    version: "2026-10-02",
    decision: "ACCEPTED",
    idempotencyKey,
  };
  const created = await request(
    "/account/policy-decisions",
    "POST",
    body,
    buyer,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.source, "POLICY_REVIEW");
  const repeated = await request(
    "/account/policy-decisions",
    "POST",
    body,
    buyer,
  );
  assert.equal(repeated.status, 200, repeated.text);
  assert.equal(repeated.data.id, created.data.id);
  const reused = await request(
    "/account/policy-decisions",
    "POST",
    { ...body, decision: "DECLINED" },
    buyer,
  );
  assert.equal(reused.status, 409, reused.text);
  const forgedSource = await request(
    "/account/policy-decisions",
    "POST",
    { ...body, source: "MODEL", idempotencyKey: key("consent-model") },
    buyer,
  );
  assert.equal(forgedSource.status, 400, forgedSource.text);
  const signupViaApi = await request(
    "/account/policy-decisions",
    "POST",
    { ...body, source: "SIGNUP", idempotencyKey: key("consent-signup") },
    buyer,
  );
  assert.equal(signupViaApi.status, 400, signupViaApi.text);
});

await test("a required policy cannot be declined and an optional decline stores no acceptance", async () => {
  const declinedRequired = await request(
    "/account/policy-decisions",
    "POST",
    {
      key: "terms",
      version: "2026-10-02",
      decision: "DECLINED",
      idempotencyKey: key("decline-required"),
    },
    buyer,
  );
  assert.equal(declinedRequired.status, 409, declinedRequired.text);
  const declinedOptional = await request(
    "/account/policy-decisions",
    "POST",
    {
      key: "fees",
      version: "2026-10-02",
      decision: "DECLINED",
      idempotencyKey: key("decline-optional"),
    },
    buyer,
  );
  assert.equal(declinedOptional.status, 201, declinedOptional.text);
  assert.equal(declinedOptional.data.decision, "DECLINED");
  const status = await request("/account/policy-consents", "GET", undefined, buyer);
  assert.equal(status.status, 200, status.text);
  const fees = status.data.status.optional.find(
    (policy: any) => policy.key === "fees",
  );
  assert.equal(fees.granted, false);
  const terms = status.data.status.required.find(
    (policy: any) => policy.key === "terms",
  );
  assert.equal(terms.status, "ACCEPTED");
});

await test("the legacy acceptance endpoint now writes an audited consent event", async () => {
  const response = await request(
    "/account/policy-acceptances",
    "POST",
    // The current privacy version (a newer privacy notice supersedes 2026-10-02 for new acceptances).
    { key: "privacy", version: currentPolicy("privacy")!.version },
    stranger,
  );
  assert.equal(response.status, 201, response.text);
  const [row] = await db
    .select()
    .from(policyConsentEvents)
    .where(
      and(
        eq(policyConsentEvents.userId, stranger.id),
        eq(policyConsentEvents.policyKey, "privacy"),
        eq(policyConsentEvents.source, "POLICY_REVIEW"),
      ),
    );
  assert.ok(row);
  assert.equal(row!.decision, "ACCEPTED");
  assert.equal(row!.contentSha256, policyContentSha256(currentPolicy("privacy")!));
  const listed = await request(
    "/account/policy-acceptances",
    "GET",
    undefined,
    stranger,
  );
  assert.equal(listed.status, 200, listed.text);
  const terms = listed.data.find((row: any) => row.key === "terms");
  assert.ok(terms.acceptedAt, "signup acceptance is visible");
  assert.match(terms.contentSha256, /^[0-9a-f]{64}$/);
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

await test("only an administrator can register a policy version and the wording must exist in code", async () => {
  const forbidden = await request(
    "/admin/compliance/policies",
    "POST",
    { key: "terms", version: "2026-10-02" },
    seller,
  );
  assert.equal(forbidden.status, 403, forbidden.text);
  const unknown = await request(
    "/admin/compliance/policies",
    "POST",
    { key: "terms", version: "1999-01-01" },
    admin,
  );
  assert.equal(unknown.status, 409, unknown.text);
  const created = await request(
    "/admin/compliance/policies",
    "POST",
    { key: "terms", version: "2026-10-02" },
    admin,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.lifecycle, "DRAFT");
  assert.equal(created.data.legalReference, null);
  assert.equal(
    created.data.contentSha256,
    policyContentSha256(currentPolicy("terms")!),
  );
  const repeated = await request(
    "/admin/compliance/policies",
    "POST",
    { key: "terms", version: "2026-10-02" },
    admin,
  );
  assert.equal(repeated.status, 200, repeated.text);
  const [row] = await db
    .select()
    .from(policyRegistryVersions)
    .where(eq(policyRegistryVersions.id, created.data.id));
  assert.equal(row!.registeredBy, admin.id);
});

await test("the registry refuses to skip review steps or invent a legal approval", async () => {
  const [draft] = await db
    .select()
    .from(policyRegistryVersions)
    .where(eq(policyRegistryVersions.policyKey, "terms"));
  const skipped = await request(
    `/admin/compliance/policies/${draft!.id}/transition`,
    "POST",
    { action: "APPROVE", legalReference: "REF-001" },
    admin,
  );
  assert.equal(skipped.status, 409, skipped.text);
  const review = await request(
    `/admin/compliance/policies/${draft!.id}/transition`,
    "POST",
    { action: "LEGAL_REVIEW" },
    admin,
  );
  assert.equal(review.status, 200, review.text);
  const withoutReference = await request(
    `/admin/compliance/policies/${draft!.id}/transition`,
    "POST",
    { action: "APPROVE" },
    admin,
  );
  assert.equal(withoutReference.status, 400, withoutReference.text);
  const approved = await request(
    `/admin/compliance/policies/${draft!.id}/transition`,
    "POST",
    { action: "APPROVE", legalReference: "COUNSEL-REF-2026-001" },
    admin,
  );
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.data.lifecycle, "APPROVED");
  assert.equal(approved.data.legalReference, "COUNSEL-REF-2026-001");
  await assert.rejects(
    pool.query(
      `UPDATE policy_registry_versions SET lifecycle = 'DRAFT' WHERE id = $1`,
      [draft!.id],
    ),
    "a backwards lifecycle transition is blocked by the database",
  );
  await assert.rejects(
    pool.query(
      `UPDATE policy_registry_versions SET legal_reference = 'forged' WHERE id = $1`,
      [draft!.id],
    ),
    /an approved legal reference is immutable/,
  );
});

await test("publication is recorded, visible to users and blocks later deletion", async () => {
  const [draft] = await db
    .select()
    .from(policyRegistryVersions)
    .where(eq(policyRegistryVersions.policyKey, "terms"));
  const published = await request(
    `/admin/compliance/policies/${draft!.id}/transition`,
    "POST",
    { action: "PUBLISH" },
    admin,
  );
  assert.equal(published.status, 200, published.text);
  assert.equal(published.data.lifecycle, "PUBLISHED");
  assert.ok(published.data.publishedAt);
  const summaries = await request("/policies");
  const terms = summaries.data.policies.find(
    (policy: any) => policy.key === "terms",
  );
  assert.equal(terms.lifecycle, "PUBLISHED");
  await assert.rejects(
    pool.query(`DELETE FROM policy_registry_versions WHERE id = $1`, [
      draft!.id,
    ]),
    "policy versions cannot be deleted",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO policy_registry_versions
        (id, policy_key, version, lifecycle, content_sha256, effective_date, market_scope)
       VALUES ($1, 'terms', '2099-01-01', 'APPROVED', $2, '2099-01-01', 'GLOBAL')`,
      [randomUUID(), "0".repeat(64)],
    ),
    "a version cannot be created already approved",
  );
  const status = await request("/account/policy-consents", "GET", undefined, seller);
  const termsStatus = status.data.status.required.find(
    (policy: any) => policy.key === "terms",
  );
  assert.equal(termsStatus.lifecycle, "PUBLISHED");
  assert.equal(termsStatus.status, "ACCEPTED");
  assert.deepEqual(status.data.status.materialUpdates, []);
});

// ─── Legal entity registry ──────────────────────────────────────────────────

await test("legal entities start disabled, hold no capabilities and cannot be invented by raw SQL", async () => {
  const forbidden = await request(
    "/admin/compliance/legal-entities",
    "POST",
    {
      marketId,
      legalName: "شركة دينار",
      entityType: "COMPANY",
      registrationCountry: "JO",
    },
    seller,
  );
  assert.equal(forbidden.status, 403, forbidden.text);
  const created = await request(
    "/admin/compliance/legal-entities",
    "POST",
    {
      marketId,
      legalName: "كيان اختبار W09",
      entityType: "COMPANY",
      registrationCountry: "JO",
    },
    admin,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.status, "DISABLED");
  assert.deepEqual(created.data.capabilities, []);
  const duplicate = await request(
    "/admin/compliance/legal-entities",
    "POST",
    {
      marketId,
      legalName: "كيان مكرر",
      entityType: "COMPANY",
      registrationCountry: "JO",
    },
    admin,
  );
  assert.equal(duplicate.status, 409, duplicate.text);
  await assert.rejects(
    pool.query(
      `INSERT INTO legal_entities
        (id, market_id, legal_name, entity_type, registration_country, status, capabilities, activated_at, activated_by)
       VALUES ($1, $2, 'كيان مزيّف', 'COMPANY', 'JO', 'ACTIVE', '["MARKETPLACE"]'::jsonb, now(), $3)`,
      [randomUUID(), marketId, admin.id],
    ),
    "a legal entity cannot be inserted already active",
  );
  const [row] = await db
    .select()
    .from(legalEntities)
    .where(eq(legalEntities.marketId, marketId));
  assert.equal(row!.createdBy, admin.id);
});

await test("the commercial capability gate only exists where a market opted in", async () => {
  const inert = await publish(seller, "قبل تفعيل الكيان");
  assert.equal(inert.status, 201, inert.text);
  await settings({ legalEntityRequired: true });
  const blockedWhileDisabled = await publish(seller, "كيان غير مفعّل");
  assert.equal(blockedWhileDisabled.status, 409, blockedWhileDisabled.text);
  const activated = await request(
    `/admin/compliance/legal-entities/${marketId}/activate`,
    "POST",
    { capabilities: ["MARKETPLACE"] },
    admin,
  );
  assert.equal(activated.status, 200, activated.text);
  assert.equal(activated.data.status, "ACTIVE");
  assert.deepEqual(activated.data.capabilities, ["MARKETPLACE"]);
  const allowed = await publish(seller, "كيان مفعّل");
  assert.equal(allowed.status, 201, allowed.text);
  const deactivated = await request(
    `/admin/compliance/legal-entities/${marketId}/deactivate`,
    "POST",
    {},
    admin,
  );
  assert.equal(deactivated.status, 200, deactivated.text);
  assert.equal(deactivated.data.status, "DISABLED");
  const blockedAfterDisable = await publish(seller, "بعد التعطيل");
  assert.equal(blockedAfterDisable.status, 409, blockedAfterDisable.text);
  await settings({ legalEntityRequired: false });
});

// ─── Seller verification ────────────────────────────────────────────────────

await test("seller verification is risk-based, human-decided and never self-approved", async () => {
  await settings({ sellerVerificationRequired: true });
  const blocked = await publish(seller, "بائع غير موثق");
  assert.equal(blocked.status, 403, blocked.text);
  const submitted = await request(
    "/account/seller-verification",
    "POST",
    {
      marketId,
      requestedLevel: "BASIC",
      evidenceRefs: ["doc:commercial-register"],
      idempotencyKey: key("verify"),
    },
    seller,
  );
  assert.equal(submitted.status, 201, submitted.text);
  assert.equal(submitted.data.status, "PENDING");
  assert.equal(submitted.data.riskBasis, "UNASSESSED");
  const [profileRow] = await db
    .select()
    .from(sellerVerificationProfiles)
    .where(eq(sellerVerificationProfiles.userId, seller.id));
  const queue = await request(
    "/admin/compliance/seller-verifications",
    "GET",
    undefined,
    admin,
  );
  assert.equal(queue.status, 200, queue.text);
  assert.ok(queue.data.some((row: any) => row.id === profileRow!.id));
  const selfDecision = await request(
    `/admin/compliance/seller-verifications/${profileRow!.id}/decision`,
    "POST",
    { decision: "VERIFIED", riskBasis: "LOW" },
    seller,
  );
  assert.equal(selfDecision.status, 403, selfDecision.text);
  const withoutRisk = await request(
    `/admin/compliance/seller-verifications/${profileRow!.id}/decision`,
    "POST",
    { decision: "VERIFIED" },
    admin,
  );
  assert.equal(withoutRisk.status, 400, withoutRisk.text);
  const verified = await request(
    `/admin/compliance/seller-verifications/${profileRow!.id}/decision`,
    "POST",
    { decision: "VERIFIED", riskBasis: "LOW", reason: "سجل تجاري مطابق" },
    admin,
  );
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.data.status, "VERIFIED");
  assert.equal(verified.data.riskBasis, "LOW");
  const afterApproval = await publish(seller, "بائع موثق");
  assert.equal(afterApproval.status, 201, afterApproval.text);
  const second = await request(
    "/account/seller-verification",
    "POST",
    {
      marketId,
      requestedLevel: "ENHANCED",
      evidenceRefs: [],
      idempotencyKey: key("verify-2"),
    },
    stranger,
  );
  assert.equal(second.status, 201, second.text);
  const rejectedWithoutReason = await request(
    `/admin/compliance/seller-verifications/${second.data.id}/decision`,
    "POST",
    { decision: "REJECTED" },
    admin,
  );
  assert.equal(rejectedWithoutReason.status, 400, rejectedWithoutReason.text);
  const rejected = await request(
    `/admin/compliance/seller-verifications/${second.data.id}/decision`,
    "POST",
    { decision: "REJECTED", reason: "الهوية غير واضحة" },
    admin,
  );
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.data.status, "REJECTED");
  await assert.rejects(
    pool.query(
      `UPDATE seller_verification_profiles SET decided_by = user_id WHERE id = $1`,
      [second.data.id],
    ),
    "the seller can never be recorded as their own verifier",
  );
  await settings({ sellerVerificationRequired: false });
});

// ─── Age and guardian protection ────────────────────────────────────────────

await test("age and guardian gates are off until enabled and an adult declaration passes", async () => {
  const inert = await publish(seller, "حماية معطلة");
  assert.equal(inert.status, 201, inert.text);
  await settings({ minorProtectionEnabled: true, guardianConsentRequired: true });
  const undeclared = await publish(seller, "بلا إقرار عمر");
  assert.equal(undeclared.status, 403, undeclared.text);
  const adult = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "ADULT", idempotencyKey: key("adult") },
    seller,
  );
  assert.equal(adult.status, 201, adult.text);
  assert.equal(adult.data.guardianStatus, "NOT_REQUIRED");
  const allowed = await publish(seller, "بالغ مصرح");
  assert.equal(allowed.status, 201, allowed.text);
});

await test("a declared minor is blocked until a distinct guardian grants consent", async () => {
  const declaration = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "MINOR", idempotencyKey: key("minor") },
    minor,
  );
  assert.equal(declaration.status, 201, declaration.text);
  assert.equal(declaration.data.guardianStatus, "PENDING");
  const blocked = await publish(minor, "قاصر بلا موافقة");
  assert.equal(blocked.status, 403, blocked.text);
  const selfConsent = await request(
    "/account/guardian-consent",
    "POST",
    {
      userId: minor.id,
      marketId,
      decision: "GRANTED",
      guardianReference: "SELF",
      idempotencyKey: key("self-guardian"),
    },
    minor,
  );
  assert.equal(selfConsent.status, 403, selfConsent.text);
  const granted = await request(
    "/account/guardian-consent",
    "POST",
    {
      userId: minor.id,
      marketId,
      decision: "GRANTED",
      guardianReference: "guardian-record-118",
      idempotencyKey: key("guardian"),
    },
    guardian,
  );
  assert.equal(granted.status, 201, granted.text);
  assert.equal(granted.data.guardianStatus, "GRANTED");
  assert.equal(granted.data.source, "GUARDIAN_VERIFICATION");
  const [stored] = await db
    .select()
    .from(minorProtectionDeclarations)
    .where(
      and(
        eq(minorProtectionDeclarations.userId, minor.id),
        eq(minorProtectionDeclarations.source, "GUARDIAN_VERIFICATION"),
      ),
    );
  assert.match(stored!.guardianReferenceSha256!, /^[0-9a-f]{64}$/);
  assert.notEqual(stored!.guardianReferenceSha256, "guardian-record-118");
  const allowed = await publish(minor, "قاصر بموافقة ولي");
  assert.equal(allowed.status, 201, allowed.text);
  const secondDecision = await request(
    "/account/guardian-consent",
    "POST",
    {
      userId: minor.id,
      marketId,
      decision: "DENIED",
      guardianReference: "guardian-record-119",
      idempotencyKey: key("guardian-2"),
    },
    guardian,
  );
  assert.equal(secondDecision.status, 409, secondDecision.text);
  const flipToAdult = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "ADULT", idempotencyKey: key("flip") },
    minor,
  );
  assert.equal(flipToAdult.status, 409, flipToAdult.text);
});

await test("a denied guardian decision blocks commerce and consent needs a minor declaration", async () => {
  const declaration = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "MINOR", idempotencyKey: key("minor-2") },
    minorTwo,
  );
  assert.equal(declaration.status, 201, declaration.text);
  const denied = await request(
    "/account/guardian-consent",
    "POST",
    {
      userId: minorTwo.id,
      marketId,
      decision: "DENIED",
      guardianReference: "guardian-record-120",
      idempotencyKey: key("guardian-deny"),
    },
    guardian,
  );
  assert.equal(denied.status, 201, denied.text);
  const blocked = await publish(minorTwo, "قاصر مرفوض");
  assert.equal(blocked.status, 403, blocked.text);
  assert.match(blocked.text, /ولي الأمر/);
  const notMinor = await request(
    "/account/guardian-consent",
    "POST",
    {
      userId: buyer.id,
      marketId,
      decision: "GRANTED",
      guardianReference: "guardian-record-121",
      idempotencyKey: key("guardian-nonminor"),
    },
    guardian,
  );
  assert.equal(notMinor.status, 409, notMinor.text);
  const undeclared = await request(
    "/account/guardian-consent",
    "POST",
    {
      userId: stranger.id,
      marketId,
      decision: "GRANTED",
      guardianReference: "guardian-record-122",
      idempotencyKey: key("guardian-undeclared"),
    },
    guardian,
  );
  assert.equal(undeclared.status, 409, undeclared.text);
});

await test("the buyer side of checkout is gated by the same declaration", async () => {
  const listing = await publish(seller, "عرض لفحص المشتري");
  assert.equal(listing.status, 201, listing.text);
  const blocked = await request(
    "/orders",
    "POST",
    {
      listingId: listing.data.id,
      quantity: 1,
      fulfilmentType: "PICKUP",
      idempotencyKey: key("order-blocked"),
    },
    buyer,
  );
  assert.equal(blocked.status, 403, blocked.text);
  const adult = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "ADULT", idempotencyKey: key("buyer-adult") },
    buyer,
  );
  assert.equal(adult.status, 201, adult.text);
  const allowed = await request(
    "/orders",
    "POST",
    {
      listingId: listing.data.id,
      quantity: 1,
      fulfilmentType: "PICKUP",
      idempotencyKey: key("order-allowed"),
    },
    buyer,
  );
  assert.equal(allowed.status, 201, allowed.text);
});

await test("without a guardian flow a declared minor is blocked outright", async () => {
  await settings({ guardianConsentRequired: false });
  const declaration = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "MINOR", idempotencyKey: key("minor-3") },
    stranger,
  );
  assert.equal(declaration.status, 201, declaration.text);
  assert.equal(declaration.data.guardianStatus, "NOT_REQUIRED");
  const blocked = await publish(stranger, "قاصر بلا مسار ولي");
  assert.equal(blocked.status, 403, blocked.text);
  assert.match(blocked.text, /قاصر/);
  await settings({ minorProtectionEnabled: false, guardianConsentRequired: false });
  const earlyDeclaration = await request(
    "/account/age-declaration",
    "POST",
    { marketId, declaredStatus: "MINOR", idempotencyKey: key("minor-4") },
    guardian,
  );
  assert.equal(earlyDeclaration.status, 409, earlyDeclaration.text);
  assert.match(earlyDeclaration.text, /غير مفعّلة/);
});

// ─── Data rights ────────────────────────────────────────────────────────────

await test("the personal data export includes the consent ledger", async () => {
  const exported = await request(
    "/account/privacy/exports",
    "POST",
    { currentPassword: password, idempotencyKey: key("export") },
    seller,
  );
  assert.equal(exported.status, 200, exported.text);
  const document = exported.data.export;
  assert.ok(Array.isArray(document.policyConsentEvents));
  assert.ok(document.policyConsentEvents.length >= 2);
  assert.ok(
    document.policyConsentEvents.some(
      (event: any) => event.source === "SIGNUP" && event.key === "terms",
    ),
  );
  const summary = await request("/account/privacy", "GET", undefined, seller);
  const category = summary.data.categories.find(
    (row: any) => row.key === "policyConsents",
  );
  assert.ok(category);
  assert.ok(category.count >= 2);
});

await test("market settings record the actor and never claim approval", async () => {
  const response = await request(
    `/admin/compliance/markets/${marketId}`,
    "GET",
    undefined,
    admin,
  );
  assert.equal(response.status, 200, response.text);
  assert.equal(response.data.settings.configured, true);
  const overview = await request(
    "/admin/compliance/markets",
    "GET",
    undefined,
    admin,
  );
  const row = overview.data.find((item: any) => item.marketId === marketId);
  assert.equal(row.commercialActivation, "REQUIRES_OWNER_AUTHORIZATION");
  assert.equal(row.legalEntity.status, "DISABLED");
  const [settingsRow] = await db
    .select()
    .from(marketComplianceSettings)
    .where(eq(marketComplianceSettings.marketId, marketId));
  assert.equal(settingsRow!.updatedBy, admin.id);
  const forbiddenOverview = await request(
    "/admin/compliance/markets",
    "GET",
    undefined,
    stranger,
  );
  assert.equal(forbiddenOverview.status, 403, forbiddenOverview.text);
});

await test("consent events are append-only at the database level", async () => {
  const [row] = await db
    .select()
    .from(policyConsentEvents)
    .where(eq(policyConsentEvents.userId, seller.id))
    .limit(1);
  await assert.rejects(
    pool.query(
      `UPDATE policy_consent_events SET decision = 'DECLINED' WHERE id = $1`,
      [row!.id],
    ),
    "consent events cannot be rewritten",
  );
  await assert.rejects(
    pool.query(`DELETE FROM policy_consent_events WHERE id = $1`, [row!.id]),
    "consent events cannot be deleted",
  );
});

after(async () => {
  server.close();
  await pool.end();
});
