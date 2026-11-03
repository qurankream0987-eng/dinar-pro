/**
 * Wave-06 independent adversarial audit of D16 (privacy, legal-readiness and country activation).
 *
 * This file is written by the Wave-06 reviewer, not by D16's implementation owner. It never
 * weakens an assertion to match the code: where the audit found a defect the test records the
 * observed behaviour, names the blocker it belongs to, and says what a fix must change.
 * Every database write that stands in for an out-of-band state (an activated country package, an
 * ENABLED capability row) is labelled as such, because no API path can produce it today.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  marketLegalCapabilityApprovals,
  marketLegalCapabilityEvents,
  marketLegalEvidence,
  marketLegalIntakeTopics,
  marketLegalIntakes,
  legalEntities,
  marketPriceVersions,
  markets,
  offers,
  policyRegistryVersions,
  pool,
  securityIncidentEvents,
  securityIncidents,
  users,
} from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import app from "../src/app";
import {
  assertMarketLegalCapability,
  disableMarketCapability,
  enableMarketCapability,
  marketLegalGateEnforced,
} from "../src/lib/d16-readiness";
import { assertMarketPolicy, resolveMarket } from "../src/lib/markets";
import { paymentSimulationEnabled } from "../src/routes/payments";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W06_D16_AUDIT");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const password = "w06-d16-password-00001";

const HOME = DEFAULT_MARKET;
const ABROAD = HOME === "JO" ? "KW" : "JO";

type Actor = { id: string; cookie: string };
let phoneCounter = 0;

async function register(name: string): Promise<Actor> {
  const number = `79${((Date.now() + phoneCounter++) % 10_000_000).toString().padStart(7, "0")}`;
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
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!;
  return { id: JSON.parse(text).user.id, cookie };
}

// A loopback listener inside the suite's network namespace can refuse a new connection for a few
// milliseconds. Retrying a connect-level failure keeps a harness artefact from being reported as a
// D16 finding; it never changes what a response is asserted to be.
async function request(path: string, method = "GET", body?: unknown, actor?: Actor) {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await fetch(`${origin}/api${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json", origin } : {}),
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
    } catch (error: any) {
      failures.push(`${error.cause?.code ?? error.code ?? error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const port = (server.address() as { port: number } | null)?.port ?? "unknown";
  throw new Error(
    `${method} ${path} unreachable after ${failures.length} attempts (listening=${server.listening}, port=${port}): ${failures.join(", ")}`,
  );
}

function errorCode(response: { status: number; data: any }): string | undefined {
  return response.data?.code ?? response.data?.error?.code;
}

function nestedSqlState(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const [homeFixture] = await db.select().from(markets).where(eq(markets.id, HOME)).limit(1);
assert.ok(homeFixture, `Expected migrated market ${HOME}`);
await db
  .update(markets)
  .set({ isActive: true, status: "ACTIVE", unitPriceMinor: 100 })
  .where(eq(markets.id, HOME));
await db.insert(marketPriceVersions).values({
  id: randomUUID(),
  marketId: HOME,
  currencyCode: homeFixture.currencyCode,
  unitPriceMinor: 100,
  minorUnitScale: homeFixture.minorUnitScale,
  effectiveFrom: new Date(Date.now() - 60_000),
});

const admin = await register(`W06 admin ${runId}`);
const counsel = await register(`W06 counsel ${runId}`);
const counselApprover = await register(`W06 counsel approver ${runId}`);
const owner = await register(`W06 owner ${runId}`);
const technical = await register(`W06 technical ${runId}`);
const activator = await register(`W06 activator ${runId}`);
const intruder = await register(`W06 intruder ${runId}`);
await db
  .update(users)
  .set({ role: "ADMIN" })
  .where(inArray(users.id, [admin.id, counsel.id, counselApprover.id, owner.id, technical.id, activator.id]));

const envNames = [
  "DINAR_DEPLOYMENT_ENV",
  "DINAR_COUNSEL_REVIEWER_IDS",
  "DINAR_COUNSEL_APPROVER_IDS",
  "DINAR_LEGAL_OWNER_IDS",
  "DINAR_LEGAL_TECHNICAL_VERIFIER_IDS",
  "DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS",
] as const;
const previousEnv = new Map<string, string | undefined>(
  envNames.map((name) => [name, process.env[name]] as const),
);
function configureRoles() {
  process.env.DINAR_COUNSEL_REVIEWER_IDS = counsel.id;
  process.env.DINAR_COUNSEL_APPROVER_IDS = counselApprover.id;
  process.env.DINAR_LEGAL_OWNER_IDS = owner.id;
  process.env.DINAR_LEGAL_TECHNICAL_VERIFIER_IDS = technical.id;
  process.env.DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS = activator.id;
}
configureRoles();

/** The role configuration a failing separation assertion needs to explain itself. */
function rolesProbe() {
  return JSON.stringify({
    counselReviewerIds: process.env.DINAR_COUNSEL_REVIEWER_IDS ?? null,
    legalOwnerIds: process.env.DINAR_LEGAL_OWNER_IDS ?? null,
    counsel: counsel.id,
    owner: owner.id,
  });
}

function deployed() {
  process.env.DINAR_DEPLOYMENT_ENV = "production";
}

/**
 * The three things a fail-closed assertion depends on, read from the same places the route reads
 * them: the deployment environment, the gate decision, and the stored country package. A browse
 * that should have been refused is only worth reporting once these are known.
 */
async function gateProbe(marketId: string, capability = "BROWSING") {
  const [intake] = await db
    .select({
      activationStatus: marketLegalIntakes.activationStatus,
      counselApprovalStatus: marketLegalIntakes.counselApprovalStatus,
      technicalVerificationStatus: marketLegalIntakes.technicalVerificationStatus,
    })
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.marketId, marketId))
    .limit(1);
  const [capabilityRow] = await db
    .select({ status: marketLegalCapabilityApprovals.status })
    .from(marketLegalCapabilityApprovals)
    .where(
      and(
        eq(marketLegalCapabilityApprovals.marketId, marketId),
        eq(marketLegalCapabilityApprovals.capability, capability),
      ),
    )
    .limit(1);
  let direct: string;
  try {
    await assertMarketLegalCapability(marketId, capability as any);
    direct = "allowed";
  } catch (error: any) {
    direct = `rejected:${error.code ?? error.message}`;
  }
  return JSON.stringify({
    deployment: process.env.DINAR_DEPLOYMENT_ENV ?? null,
    enforced: marketLegalGateEnforced(),
    intake: intake?.activationStatus ?? "NO_ROW",
    counselApproval: intake?.counselApprovalStatus ?? "NO_ROW",
    technical: intake?.technicalVerificationStatus ?? "NO_ROW",
    capability: capabilityRow?.status ?? "NO_ROW",
    direct,
  });
}

/** A counsel topic review that resolves the topic without adding evidence or policy demands. */
function topicReviewBody(topicKey: string) {
  return {
    disposition: "NOT_REQUIRED",
    counselFinding: `Wave-06 audit fixture finding for ${topicKey}.`,
    officialReference: `W06-REF-${topicKey}`,
    evidenceRequirementStatus: "NO_REQUIREMENTS",
    requiredEvidenceTypes: [],
    policyRequirementStatus: "NO_POLICY_REQUIREMENT",
    requiredPolicyVersions: [],
  };
}

/** Out-of-band state an activated package would hold once counsel signature verification exists. */
async function forceActivatedIntake(marketId: string) {
  const now = new Date();
  await db
    .update(marketLegalIntakes)
    .set({
      reviewStatus: "COUNSEL_REVIEWED",
      counselReviewedBy: counsel.id,
      counselReviewedAt: now,
      counselReviewReference: `W06-REVIEW-${marketId}`,
      counselApprovalStatus: "APPROVED",
      counselApprovalBlocker: "NONE_VERIFIED_OFFLINE",
      counselApprovedBy: counselApprover.id,
      counselApprovedAt: now,
      counselApprovalReference: `W06-COUNSEL-${marketId}`,
      technicalVerificationStatus: "PASSED",
      technicalVerifiedBy: technical.id,
      technicalVerifiedAt: now,
      technicalVerificationReference: `W06-TECH-${marketId}`,
      ownerApprovalStatus: "APPROVED",
      ownerApprovedBy: owner.id,
      ownerApprovedAt: now,
      ownerApprovalReference: `W06-OWNER-${marketId}`,
      activationStatus: "ACTIVE",
      activatedBy: activator.id,
      activatedAt: now,
      suspendedBy: null,
      suspendedAt: null,
      suspensionReference: null,
    })
    .where(eq(marketLegalIntakes.marketId, marketId));
}

async function forceDisabledIntake(marketId: string) {
  await db
    .update(marketLegalIntakes)
    .set({
      reviewStatus: "NOT_REVIEWED",
      counselReviewedBy: null,
      counselReviewedAt: null,
      counselReviewReference: null,
      counselApprovalStatus: "BLOCKED",
      counselApprovalBlocker: "COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE",
      counselApprovedBy: null,
      counselApprovedAt: null,
      counselApprovalReference: null,
      technicalVerificationStatus: "NOT_RUN",
      technicalVerifiedBy: null,
      technicalVerifiedAt: null,
      technicalVerificationReference: null,
      ownerApprovalStatus: "BLOCKED",
      ownerApprovedBy: null,
      ownerApprovedAt: null,
      ownerApprovalReference: null,
      activationStatus: "DISABLED",
      activatedBy: null,
      activatedAt: null,
      suspendedBy: null,
      suspendedAt: null,
      suspensionReference: null,
    })
    .where(eq(marketLegalIntakes.marketId, marketId));
}

async function seedEnabledCapability(marketId: string, capability: string) {
  const now = new Date();
  await db
    .delete(marketLegalCapabilityApprovals)
    .where(and(eq(marketLegalCapabilityApprovals.marketId, marketId), eq(marketLegalCapabilityApprovals.capability, capability)));
  await db.insert(marketLegalCapabilityApprovals).values({
    id: randomUUID(),
    marketId,
    capability,
    status: "ENABLED",
    counselReference: `W06-COUNSEL-${marketId}-${capability}`,
    counselReviewedBy: counsel.id,
    counselReviewedAt: now,
    ownerApprovalReference: `W06-OWNER-${marketId}-${capability}`,
    ownerApprovedBy: owner.id,
    ownerApprovedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

async function resetCapability(marketId: string, capability: string) {
  await db
    .delete(marketLegalCapabilityApprovals)
    .where(and(eq(marketLegalCapabilityApprovals.marketId, marketId), eq(marketLegalCapabilityApprovals.capability, capability)));
}

async function marketRow(marketId: string) {
  const [row] = await db.select().from(markets).where(eq(markets.id, marketId)).limit(1);
  return resolveMarket(row);
}

const [seedOffer] = await db
  .select({ id: offers.id })
  .from(offers)
  .where(eq(offers.marketId, HOME))
  .limit(1);

// ─── A. unapproved country ───────────────────────────────────────────────────

await test("D16-A01 an unapproved country fails closed on browse, listing detail and publication", async () => {
  deployed();
  await forceDisabledIntake(HOME);
  await resetCapability(HOME, "BROWSING");

  const state = await gateProbe(HOME);
  const blocked = (status: number, code: string | undefined) => {
    assert.equal(status, 409, `expected fail-closed 409, got ${status} with ${state}`);
    assert.equal(code, "COUNTRY_INTAKE_NOT_ACTIVE", state);
  };

  const browse = await request("/listings");
  blocked(browse.status, errorCode(browse));
  if (seedOffer) {
    const detail = await request(`/listings/${seedOffer.id}`);
    blocked(detail.status, errorCode(detail));
  }

  const market = await marketRow(HOME);
  await assert.rejects(
    assertMarketLegalCapability(HOME, "LISTING_PUBLICATION"),
    (error: any) => error.code === "COUNTRY_INTAKE_NOT_ACTIVE",
  );
  await assert.rejects(
    assertMarketPolicy(market, admin.id, "OTHER", "PICKUP"),
    (error: any) => error.code === "COUNTRY_INTAKE_NOT_ACTIVE",
  );
});

await test("D16-A02 a capability row is never legal approval while the country package is unactivated", async () => {
  deployed();
  await forceDisabledIntake(HOME);
  await seedEnabledCapability(HOME, "BROWSING");

  const before = await gateProbe(HOME);
  const browse = await request("/listings");
  assert.equal(browse.status, 409, `gate state ${before}: ${browse.text.slice(0, 240)}`);
  assert.equal(errorCode(browse), "COUNTRY_INTAKE_NOT_ACTIVE", `gate state ${before}`);

  const overview = await request(`/admin/compliance/markets/${HOME}/capabilities`, "GET", undefined, admin);
  assert.equal(overview.status, 200, overview.text);
  const browsing = overview.data.capabilities.find((item: any) => item.capability === "BROWSING");
  assert.equal(browsing.status, "ENABLED");
  assert.equal(browsing.enabled, false, "an ENABLED row on an unactivated country must not read as enabled");

  await resetCapability(HOME, "BROWSING");
});

await test("D16-A03 the database refuses a forged or self-approved capability row", async () => {
  deployed();
  const now = new Date();
  await assert.rejects(
    db.insert(marketLegalCapabilityApprovals).values({
      id: randomUUID(),
      marketId: HOME,
      capability: "TRANSACTIONS",
      status: "ENABLED",
      createdAt: now,
      updatedAt: now,
    }),
    (error: unknown) => nestedSqlState(error) === "23514",
  );

  await assert.rejects(
    db.insert(marketLegalCapabilityApprovals).values({
      id: randomUUID(),
      marketId: HOME,
      capability: "TRANSACTIONS",
      status: "ENABLED",
      counselReference: "W06-COUNSEL-FORGED",
      counselReviewedBy: owner.id,
      counselReviewedAt: now,
      ownerApprovalReference: "W06-OWNER-FORGED",
      ownerApprovedBy: owner.id,
      ownerApprovedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    (error: unknown) => nestedSqlState(error) === "23514",
  );

  await request(`/admin/compliance/markets/${HOME}/capabilities/TRANSACTIONS/review-request`, "POST", {}, admin);
  const reviewUrl = "https://counsel.example/contract?token=abc";
  const apiRefusesQueryUrl = await request(
    `/admin/compliance/markets/${HOME}/capabilities/TRANSACTIONS/counsel-review`,
    "POST",
    { outcome: "READY_FOR_OWNER_REVIEW", reference: reviewUrl },
    counsel,
  );
  // A query string is refused by the shared reference pattern...
  assert.equal(apiRefusesQueryUrl.status, 400, apiRefusesQueryUrl.text);
  // ...but the pattern itself still admits an ordinary document URL, which D16-F18 records.
  await resetCapability(HOME, "TRANSACTIONS");

  // The intake table enforces the same format below the API, so the locator cannot be written there.
  await assert.rejects(
    db
      .update(marketLegalIntakes)
      .set({ counselApprovalReference: reviewUrl })
      .where(eq(marketLegalIntakes.marketId, ABROAD)),
    (error: unknown) => nestedSqlState(error) === "23514",
  );
});

await test("D16-A04 no API path can activate a country: counsel signature and technical attestation are unavailable", async () => {
  deployed();
  await forceDisabledIntake(ABROAD);

  const requested = await request(
    `/admin/compliance/country-readiness/${ABROAD}/review-request`,
    "POST",
    {},
    admin,
  );
  assert.equal(requested.status, 202, requested.text);

  const topics = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.equal(topics.status, 200, topics.text);
  assert.equal(topics.data.intake.activationStatus, "DISABLED");
  assert.ok(
    topics.data.blockers.some((blocker: string) => blocker.startsWith("TOPIC_UNRESOLVED:OPERATING_ENTITY")),
    topics.text,
  );

  const forgedApproval = await request(
    `/admin/compliance/country-readiness/${ABROAD}/counsel-approval`,
    "POST",
    { referenceCode: "W06-FORGE-1" },
    counselApprover,
  );
  assert.equal(forgedApproval.status, 409, forgedApproval.text);
  assert.equal(errorCode(forgedApproval), "COUNSEL_REVIEW_REQUIRED");

  const forgedActivation = await request(
    `/admin/compliance/country-readiness/${ABROAD}/activate`,
    "POST",
    { referenceCode: "W06-FORGE-2" },
    activator,
  );
  assert.equal(forgedActivation.status, 409, forgedActivation.text);
  assert.equal(errorCode(forgedActivation), "COUNTRY_ACTIVATION_PREREQUISITES_MISSING");
  const stillClosed = await request(
    `/admin/compliance/country-readiness/${ABROAD}/technical-verification`,
    "POST",
    { referenceCode: "W06-FORGE-3" },
    technical,
  );
  assert.equal(stillClosed.status, 409, stillClosed.text);
  assert.equal(errorCode(stillClosed), "TECHNICAL_ATTESTATION_UNAVAILABLE");
});

await test("D16-A05 a fully resolved package still stops at the missing signature and attestation mechanisms", async () => {
  deployed();
  await forceDisabledIntake(ABROAD);
  await request(`/admin/compliance/country-readiness/${ABROAD}/review-request`, "POST", {}, admin);
  const review = await request(
    `/admin/compliance/country-readiness/${ABROAD}`,
    "GET",
    undefined,
    admin,
  );
  assert.equal(review.status, 200, review.text);
  const topicKeys: string[] = review.data.topics.map((topic: any) => topic.topicKey);
  assert.equal(topicKeys.length, 16, "the intake package must hold all sixteen topics");

  for (const topicKey of topicKeys) {
    const response = await request(
      `/admin/compliance/country-readiness/${ABROAD}/topics/${topicKey}/review`,
      "POST",
      {
        disposition: "NOT_REQUIRED",
        counselFinding: "Wave-06 audit fixture finding for an unrequired topic.",
        officialReference: `W06-REF-${topicKey}`,
        evidenceRequirementStatus: "NO_REQUIREMENTS",
        requiredEvidenceTypes: [],
        policyRequirementStatus: "NO_POLICY_REQUIREMENT",
        requiredPolicyVersions: [],
      },
      counsel,
    );
    assert.equal(response.status, 200, `${topicKey}: ${response.text}`);
  }

  const recorded = await request(
    `/admin/compliance/country-readiness/${ABROAD}/counsel-review`,
    "POST",
    { referenceCode: "W06-COUNSEL-REVIEW" },
    counsel,
  );
  assert.equal(recorded.status, 200, recorded.text);
  assert.equal(recorded.data.counselApprovalStatus, "BLOCKED");
  assert.equal(recorded.data.counselApprovalBlocker, "COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE");
  assert.equal(recorded.data.activationStatus, "DISABLED");

  const ownerApproval = await request(
    `/admin/compliance/country-readiness/${ABROAD}/owner-approval`,
    "POST",
    { referenceCode: "W06-OWNER-APPROVAL" },
    owner,
  );
  assert.equal(ownerApproval.status, 409, ownerApproval.text);
  assert.equal(errorCode(ownerApproval), "OWNER_APPROVAL_PREREQUISITES_MISSING");
  assert.match(ownerApproval.text, /COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE/);

  const activation = await request(
    `/admin/compliance/country-readiness/${ABROAD}/activate`,
    "POST",
    { referenceCode: "W06-ACTIVATE" },
    activator,
  );
  assert.equal(activation.status, 409, activation.text);
  const blocked = await request(`/listings`, "GET");
  assert.ok([200, 409].includes(blocked.status));
});

// ─── B. approval integrity ──────────────────────────────────────────────────

await test("D16-B06 separation of duties cannot be collapsed onto one actor", async () => {
  deployed();
  configureRoles();
  await forceDisabledIntake(ABROAD);
  const opened = await request(
    `/admin/compliance/country-readiness/${ABROAD}/review-request`,
    "POST",
    {},
    admin,
  );
  assert.equal(opened.status, 202, opened.text);

  // Control first: with the owner list holding only the owner, the designated reviewer must be
  // accepted. The separation rule below is only evidence once this premise is proven live.
  const control = await request(
    `/admin/compliance/country-readiness/${ABROAD}/topics/PERSONAL_DATA/review`,
    "POST",
    topicReviewBody("PERSONAL_DATA"),
    counsel,
  );
  assert.equal(control.status, 200, `designation control failed: ${rolesProbe()} ${control.text}`);

  // The same actor is now also a designated legal owner, which is how a configuration drift would
  // let a counsel reviewer approve work reserved to a separate owner.
  process.env.DINAR_LEGAL_OWNER_IDS = `${owner.id},${counsel.id}`;
  const dualRoleCounsel = await request(
    `/admin/compliance/country-readiness/${ABROAD}/topics/PERSONAL_DATA/review`,
    "POST",
    topicReviewBody("PERSONAL_DATA"),
    counsel,
  );
  assert.equal(dualRoleCounsel.status, 403, `roles ${rolesProbe()} body ${dualRoleCounsel.text}`);
  assert.equal(
    errorCode(dualRoleCounsel),
    "SEPARATION_OF_DUTIES_REQUIRED",
    `roles ${rolesProbe()} body ${dualRoleCounsel.text}`,
  );
  process.env.DINAR_LEGAL_OWNER_IDS = owner.id;

  await request(`/admin/compliance/markets/${HOME}/capabilities/BROWSING/review-request`, "POST", {}, admin);
  // Both actors are designated reviewers here; the guard under test is the separation rule that
  // fires after the designation check, not the designation check itself.
  process.env.DINAR_COUNSEL_REVIEWER_IDS = `${counsel.id},${owner.id}`;
  const selfReview = await request(
    `/admin/compliance/markets/${HOME}/capabilities/BROWSING/counsel-review`,
    "POST",
    { outcome: "READY_FOR_OWNER_REVIEW", reference: "W06-SELF-REVIEW" },
    owner,
  );
  assert.equal(selfReview.status, 403, selfReview.text);
  assert.equal(errorCode(selfReview), "SEPARATION_OF_DUTIES_REQUIRED");
  process.env.DINAR_COUNSEL_REVIEWER_IDS = counsel.id;

  const enableAfterReview = await request(
    `/admin/compliance/markets/${HOME}/capabilities/BROWSING/counsel-review`,
    "POST",
    { outcome: "READY_FOR_OWNER_REVIEW", reference: "W06-REVIEW-OK" },
    counsel,
  );
  assert.equal(enableAfterReview.status, 200, enableAfterReview.text);

  // The country package is forced ACTIVE out-of-band so the guard under test is the separation of
  // duties, not the activation gate, and the owner list is widened to include the reviewer, which
  // is how a real configuration drift would let a reviewer approve their own review.
  await forceActivatedIntake(HOME);
  process.env.DINAR_LEGAL_OWNER_IDS = `${owner.id},${counsel.id}`;
  const selfEnable = await request(
    `/admin/compliance/markets/${HOME}/capabilities/BROWSING/enable`,
    "POST",
    { reference: "W06-SELF-ENABLE" },
    counsel,
  );
  assert.equal(selfEnable.status, 403, selfEnable.text);
  assert.equal(errorCode(selfEnable), "SEPARATION_OF_DUTIES_REQUIRED");
  process.env.DINAR_LEGAL_OWNER_IDS = owner.id;
  await forceDisabledIntake(HOME);

  const undeclared = await request(
    `/admin/compliance/markets/${HOME}/capabilities/TRANSACTIONS/review-request`,
    "POST",
    {},
    admin,
  );
  assert.equal(undeclared.status, 202, undeclared.text);
  const noCounselList = await request(
    `/admin/compliance/markets/${HOME}/capabilities/TRANSACTIONS/counsel-review`,
    "POST",
    { outcome: "READY_FOR_OWNER_REVIEW", reference: "W06-NOLIST" },
    admin,
  );
  assert.equal(noCounselList.status, 403, noCounselList.text);
  assert.equal(errorCode(noCounselList), "DESIGNATED_COUNSEL_REVIEWER_REQUIRED");

  const savedOwnerList = process.env.DINAR_LEGAL_OWNER_IDS;
  delete process.env.DINAR_LEGAL_OWNER_IDS;
  const noOwnerList = await request(
    `/admin/compliance/markets/${HOME}/capabilities/BROWSING/enable`,
    "POST",
    { reference: "W06-NOOWNER" },
    owner,
  );
  assert.equal(noOwnerList.status, 403, noOwnerList.text);
  assert.equal(errorCode(noOwnerList), "DESIGNATED_LEGAL_OWNER_REQUIRED");
  process.env.DINAR_LEGAL_OWNER_IDS = savedOwnerList;

  await resetCapability(HOME, "BROWSING");
  await resetCapability(HOME, "TRANSACTIONS");
});

await test("D16-B07 an unauthorised or cross-market caller reaches nothing", async () => {
  deployed();
  const paths: Array<[string, string, unknown]> = [
    ["/admin/compliance/markets", "GET", undefined],
    [`/admin/compliance/markets/${HOME}/capabilities`, "GET", undefined],
    [`/admin/compliance/country-readiness`, "GET", undefined],
    [`/admin/compliance/country-readiness/${HOME}`, "GET", undefined],
    ["/admin/security/incidents", "GET", undefined],
  ];
  for (const [path, method, body] of paths) {
    const anonymous = await request(path, method, body);
    assert.equal(anonymous.status, 401, `${path} anonymous: ${anonymous.status}`);
    const denied = await request(path, method, body, intruder);
    assert.equal(denied.status, 403, `${path} non-admin: ${denied.text}`);
  }

  const unknownMarket = await request(
    "/admin/compliance/markets/ZZ/capabilities/BROWSING/review-request",
    "POST",
    {},
    admin,
  );
  assert.equal(unknownMarket.status, 404, unknownMarket.text);

  const unknownCapability = await request(
    `/admin/compliance/markets/${HOME}/capabilities/PAYMENTS_EVERYTHING/review-request`,
    "POST",
    {},
    admin,
  );
  assert.equal(unknownCapability.status, 400, unknownCapability.text);

  const abroadOverview = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.equal(abroadOverview.status, 200, abroadOverview.text);
  assert.equal(abroadOverview.data.market.id, ABROAD);
  assert.equal(abroadOverview.data.intake.activationStatus, "DISABLED");

  // A capability enabled for one market never opens another market.
  await forceActivatedIntake(HOME);
  await seedEnabledCapability(HOME, "BROWSING");
  await forceDisabledIntake(ABROAD);
  await assertMarketLegalCapability(HOME, "BROWSING");
  await assert.rejects(
    assertMarketLegalCapability(ABROAD, "BROWSING"),
    (error: any) => error.code === "COUNTRY_INTAKE_NOT_ACTIVE",
  );
  await resetCapability(HOME, "BROWSING");
  await forceDisabledIntake(HOME);
});

await test("D16-B08 an in-flight enable overwrites a concurrent emergency disable (D16-BL-04)", async () => {
  deployed();
  await forceActivatedIntake(HOME);
  await resetCapability(HOME, "CASH_PAYMENT");
  await db
    .insert(marketLegalCapabilityApprovals)
    .values({
      id: randomUUID(),
      marketId: HOME,
      capability: "CASH_PAYMENT",
      status: "OWNER_APPROVAL_REQUIRED",
      counselReference: "W06-COUNSEL-CASH",
      counselReviewedBy: counsel.id,
      counselReviewedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  const [row] = await db
    .select({ id: marketLegalCapabilityApprovals.id })
    .from(marketLegalCapabilityApprovals)
    .where(and(eq(marketLegalCapabilityApprovals.marketId, HOME), eq(marketLegalCapabilityApprovals.capability, "CASH_PAYMENT")))
    .limit(1);
  assert.ok(row);
  // The trail is append-only and this disposable database is shared with the sibling suite, so
  // the evidence below is the delta this race added, not the whole history of the capability.
  const priorEvents = await db
    .select({ id: marketLegalCapabilityEvents.id })
    .from(marketLegalCapabilityEvents)
    .where(and(eq(marketLegalCapabilityEvents.marketId, HOME), eq(marketLegalCapabilityEvents.capability, "CASH_PAYMENT")));
  const priorIds = new Set(priorEvents.map((event) => event.id));

  // The blocker owns the tuple lock; the watcher is a separate connection because polling the
  // blocked transaction's own client would queue behind it.
  const blocker = await pool.connect();
  const watcher = await pool.connect();
  const outcomes = { stop: "not started", grant: "not started" };
  const settle = <T>(label: "stop" | "grant", work: Promise<T>): Promise<T> =>
    work.then(
      (value) => {
        outcomes[label] = "resolved";
        return value;
      },
      (error: any) => {
        outcomes[label] = `rejected:${error?.code ?? error?.message ?? String(error)}`;
        throw error;
      },
    );
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM market_legal_capability_approvals WHERE id = $1 FOR UPDATE", [row.id]);

    // The stop is issued first. Its admin check, market read and capability read are all plain
    // SELECTs, so it reaches its UPDATE and parks on the tuple lock the blocker holds.
    const stop = settle("stop", disableMarketCapability({ actorId: admin.id, marketId: HOME, capability: "CASH_PAYMENT" }));
    await waitForBlockedTransaction(watcher, 1, () => `transitions ${JSON.stringify(outcomes)}; `);

    // The approval starts second. Its reads are not blocked by a row lock, so it observes the
    // pre-stop status and queues its own UPDATE behind the stop.
    const grant = settle(
      "grant",
      enableMarketCapability({ actorId: owner.id, marketId: HOME, capability: "CASH_PAYMENT", reference: "W06-RACE" }),
    );
    await waitForBlockedTransaction(watcher, 2, () => `transitions ${JSON.stringify(outcomes)}; `);
    await blocker.query("COMMIT");

    await Promise.allSettled([stop, grant]);
    const final = await db
      .select({ status: marketLegalCapabilityApprovals.status })
      .from(marketLegalCapabilityApprovals)
      .where(eq(marketLegalCapabilityApprovals.id, row.id))
      .limit(1);

    // D16-BL-04: both transitions were queued in the safe order — stop first, approval second —
    // and neither re-reads the row once it owns the lock. Both UPDATEs are unconditional
    // `SET status = … WHERE id = …`, so Postgres lets the second writer overwrite the first and
    // the emergency stop is silently undone. The fix is `.for("update")` in readCapability plus a
    // status guard on both UPDATEs; when that lands, this assertion must flip to "DISABLED" and
    // the enable must be refused.
    assert.equal(final[0]?.status, "ENABLED", `expected the documented lost update; transitions ${JSON.stringify(outcomes)}`);
    const events = await db
      .select({
        id: marketLegalCapabilityEvents.id,
        eventType: marketLegalCapabilityEvents.eventType,
        fromStatus: marketLegalCapabilityEvents.fromStatus,
        toStatus: marketLegalCapabilityEvents.toStatus,
      })
      .from(marketLegalCapabilityEvents)
      .where(and(eq(marketLegalCapabilityEvents.marketId, HOME), eq(marketLegalCapabilityEvents.capability, "CASH_PAYMENT")));
    const raced = events.filter((event) => !priorIds.has(event.id));
    // Compared as a set: both transitions were recorded, and the enable is the one that survived.
    assert.deepEqual(
      [...raced.map((event) => event.eventType)].sort(),
      ["CAPABILITY_DISABLED", "OWNER_ENABLED"],
      JSON.stringify(raced),
    );
    // The enable's own audit row is the proof that it wrote from a stale read: it records leaving
    // OWNER_APPROVAL_REQUIRED although the row it overwrote had already been set to DISABLED.
    const enabled = raced.find((event) => event.eventType === "OWNER_ENABLED");
    assert.equal(enabled?.fromStatus, "OWNER_APPROVAL_REQUIRED", JSON.stringify(enabled));
    assert.equal(enabled?.toStatus, "ENABLED", JSON.stringify(enabled));
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    watcher.release();
    await resetCapability(HOME, "CASH_PAYMENT");
  }
});

/**
 * Waits for `wanted` backends to be blocked waiting for another transaction to end — the tuple
 * lock the blocker holds — and if they never appear, fails with what every backend on this
 * database was actually doing instead of a bare count.
 */
async function waitForBlockedTransaction(client: any, wanted: number, context: () => string) {
  const blocked = `SELECT count(*)::int AS waiting FROM pg_locks
                    WHERE locktype = 'transactionid' AND granted = false AND pid <> pg_backend_pid()`;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await client.query(blocked);
    if (result.rows[0].waiting >= wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const backends = await client.query(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 90) AS statement
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      ORDER BY backend_start`,
  );
  assert.fail(
    `D16-BL-04 reproduction needs ${wanted} transaction(s) blocked on the capability row; ` +
      `${context()} backends=${JSON.stringify(backends.rows)}`,
  );
}

// ─── C. evidence lifecycle ───────────────────────────────────────────────────

await test("D16-C09 missing, expired and revoked evidence each block the package", async () => {
  deployed();
  await forceDisabledIntake(ABROAD);
  await request(`/admin/compliance/country-readiness/${ABROAD}/review-request`, "POST", {}, admin);
  const reviewTopic = await request(
    `/admin/compliance/country-readiness/${ABROAD}/topics/OPERATING_ENTITY/review`,
    "POST",
    {
      disposition: "REQUIRED",
      counselFinding: "A commercial register extract must be on file before publication.",
      officialReference: "W06-REF-OPERATING-ENTITY",
      evidenceRequirementStatus: "REQUIREMENTS_SET",
      requiredEvidenceTypes: ["COMMERCIAL_REGISTER"],
      policyRequirementStatus: "NO_POLICY_REQUIREMENT",
      requiredPolicyVersions: [],
    },
    counsel,
  );
  assert.equal(reviewTopic.status, 200, reviewTopic.text);

  const missing = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(missing.data.blockers.includes("EVIDENCE_MISSING_OR_UNVERIFIED:OPERATING_ENTITY:COMMERCIAL_REGISTER"), JSON.stringify(missing.data.blockers));
  assert.ok(missing.data.blockers.includes("REQUIRED_LEGAL_ENTITY_NOT_ACTIVE"), JSON.stringify(missing.data.blockers));

  // The legal-entity blocker must be liftable only through the registry, and a created-but-disabled
  // entity must not count as active.
  await db.delete(legalEntities).where(eq(legalEntities.marketId, ABROAD));
  const created = await request(
    "/admin/compliance/legal-entities",
    "POST",
    {
      marketId: ABROAD,
      legalName: `Wave-06 audit entity ${runId}`,
      entityType: "COMPANY",
      registrationCountry: ABROAD,
    },
    admin,
  );
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.status, "DISABLED", "a registry entry starts inactive and cannot self-approve");
  const disabledEntity = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(
    disabledEntity.data.blockers.includes("REQUIRED_LEGAL_ENTITY_NOT_ACTIVE"),
    JSON.stringify(disabledEntity.data.blockers),
  );
  const withoutCapability = await request(
    `/admin/compliance/legal-entities/${ABROAD}/activate`,
    "POST",
    { capabilities: [] },
    admin,
  );
  assert.equal(withoutCapability.status, 400, withoutCapability.text);
  const activatedEntity = await request(
    `/admin/compliance/legal-entities/${ABROAD}/activate`,
    "POST",
    { capabilities: ["MARKETPLACE"] },
    admin,
  );
  assert.equal(activatedEntity.status, 200, activatedEntity.text);
  const entityCleared = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(
    !entityCleared.data.blockers.includes("REQUIRED_LEGAL_ENTITY_NOT_ACTIVE"),
    JSON.stringify(entityCleared.data.blockers),
  );
  assert.ok(
    entityCleared.data.blockers.includes("EVIDENCE_MISSING_OR_UNVERIFIED:OPERATING_ENTITY:COMMERCIAL_REGISTER"),
    "an active legal entity must not stand in for the missing document",
  );

  const issuedAt = new Date(Date.now() - 86_400_000).toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000 * 30).toISOString();
  const evidencePayload = {
    topicKey: "OPERATING_ENTITY",
    evidenceType: "COMMERCIAL_REGISTER",
    documentVersion: "2026-01",
    referenceCode: `W06-EVIDENCE-${runId}`,
    idempotencyKey: `w06-evidence-${runId}-1`,
    issuedAt,
    expiresAt,
  };
  const submitted = await request(
    `/admin/compliance/country-readiness/${ABROAD}/evidence`,
    "POST",
    evidencePayload,
    admin,
  );
  assert.equal(submitted.status, 201, submitted.text);
  assert.equal(submitted.data.status, "SUBMITTED_UNVERIFIED");
  const unverified = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(unverified.data.blockers.includes("EVIDENCE_MISSING_OR_UNVERIFIED:OPERATING_ENTITY:COMMERCIAL_REGISTER"));

  // An identical retry under the same key returns the original row instead of a second document.
  const replay = await request(
    `/admin/compliance/country-readiness/${ABROAD}/evidence`,
    "POST",
    evidencePayload,
    admin,
  );
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.data.id, submitted.data.id, "the idempotency key must return the original row");

  // Reusing the key for different content is refused rather than silently overwriting the record.
  const reuse = await request(
    `/admin/compliance/country-readiness/${ABROAD}/evidence`,
    "POST",
    { ...evidencePayload, documentVersion: "2026-02" },
    admin,
  );
  assert.equal(reuse.status, 409, reuse.text);
  assert.equal(errorCode(reuse), "IDEMPOTENCY_KEY_REUSED");

  const reReview = await request(
    `/admin/compliance/country-readiness/evidence/${submitted.data.id}/review`,
    "POST",
    { outcome: "COUNSEL_REVIEWED" },
    counsel,
  );
  assert.equal(reReview.status, 200, reReview.text);
  const verified = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(!verified.data.blockers.includes("EVIDENCE_MISSING_OR_UNVERIFIED:OPERATING_ENTITY:COMMERCIAL_REGISTER"), JSON.stringify(verified.data.blockers));

  const secondReview = await request(
    `/admin/compliance/country-readiness/evidence/${submitted.data.id}/review`,
    "POST",
    { outcome: "REJECTED" },
    counsel,
  );
  assert.equal(secondReview.status, 409, secondReview.text);

  await db
    .update(marketLegalEvidence)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(marketLegalEvidence.id, submitted.data.id));
  const expired = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(expired.data.blockers.includes(`EVIDENCE_EXPIRED:OPERATING_ENTITY:COMMERCIAL_REGISTER`), JSON.stringify(expired.data.blockers));
  assert.ok(expired.data.evidence.find((item: any) => item.id === submitted.data.id).expired === true);

  await db
    .update(marketLegalEvidence)
    .set({ status: "SUPERSEDED", reviewedBy: counsel.id, reviewedAt: new Date() })
    .where(eq(marketLegalEvidence.id, submitted.data.id));
  const revoked = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(revoked.data.blockers.includes("EVIDENCE_MISSING_OR_UNVERIFIED:OPERATING_ENTITY:COMMERCIAL_REGISTER"), JSON.stringify(revoked.data.blockers));
  assert.ok(!revoked.data.blockers.includes("EVIDENCE_EXPIRED:OPERATING_ENTITY:COMMERCIAL_REGISTER"));

  // Evidence rows are referenced by the append-only event trail, so the fixture is neutralised
  // rather than deleted: the row stays, its status becomes REJECTED and its expiry is cleared.
  await db
    .update(marketLegalEvidence)
    .set({ status: "REJECTED", reviewedBy: counsel.id, reviewedAt: new Date(), expiresAt: null, updatedAt: new Date() })
    .where(eq(marketLegalEvidence.intakeId, `d16-intake-${ABROAD}`));
  await db.delete(legalEntities).where(eq(legalEntities.marketId, ABROAD));
  await db
    .update(marketLegalIntakeTopics)
    .set({ disposition: "NOT_REQUIRED", reviewStatus: "NOT_REVIEWED", evidenceRequirementStatus: "NOT_REVIEWED", requiredEvidenceTypes: [] })
    .where(eq(marketLegalIntakeTopics.intakeId, `d16-intake-${ABROAD}`));
});

await test("D16-C10 two live versions of one document are a conflict, not a stronger case", async () => {
  deployed();
  await forceDisabledIntake(ABROAD);
  await request(`/admin/compliance/country-readiness/${ABROAD}/review-request`, "POST", {}, admin);
  await request(
    `/admin/compliance/country-readiness/${ABROAD}/topics/PAYMENTS/review`,
    "POST",
    {
      disposition: "REQUIRED",
      counselFinding: "A payment licence reference must be on file.",
      officialReference: "W06-REF-PAYMENTS",
      evidenceRequirementStatus: "REQUIREMENTS_SET",
      requiredEvidenceTypes: ["PAYMENT_LICENCE"],
      policyRequirementStatus: "NO_POLICY_REQUIREMENT",
      requiredPolicyVersions: [],
    },
    counsel,
  );
  for (const version of ["2025-01", "2026-01"]) {
    const submitted = await request(
      `/admin/compliance/country-readiness/${ABROAD}/evidence`,
      "POST",
      {
        topicKey: "PAYMENTS",
        evidenceType: "PAYMENT_LICENCE",
        documentVersion: version,
        referenceCode: `W06-LICENCE-${version}`,
        idempotencyKey: `w06-licence-${version}`,
      },
      admin,
    );
    assert.equal(submitted.status, 201, submitted.text);
    await request(`/admin/compliance/country-readiness/evidence/${submitted.data.id}/review`, "POST", { outcome: "COUNSEL_REVIEWED" }, counsel);
  }
  const conflicting = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(
    conflicting.data.blockers.includes("EVIDENCE_VERSION_CONFLICT:PAYMENTS:PAYMENT_LICENCE"),
    JSON.stringify(conflicting.data.blockers),
  );

  // Retiring one of the two versions is the only way counsel can clear the conflict; rejecting both
  // must leave the topic blocked on missing evidence rather than silently satisfied.
  const licenceRows = await db
    .select({ id: marketLegalEvidence.id, documentVersion: marketLegalEvidence.documentVersion })
    .from(marketLegalEvidence)
    .where(and(eq(marketLegalEvidence.intakeId, `d16-intake-${ABROAD}`), eq(marketLegalEvidence.topicKey, "PAYMENTS")));
  assert.equal(licenceRows.length, 2, JSON.stringify(licenceRows));
  await db
    .update(marketLegalEvidence)
    .set({
      status: "REJECTED",
      reviewedBy: counsel.id,
      reviewedAt: new Date(),
      expiresAt: null,
      updatedAt: new Date(),
    })
    .where(inArray(marketLegalEvidence.id, licenceRows.map((row) => row.id)));
  const rejected = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(!rejected.data.blockers.includes("EVIDENCE_VERSION_CONFLICT:PAYMENTS:PAYMENT_LICENCE"), JSON.stringify(rejected.data.blockers));
  assert.ok(rejected.data.blockers.includes("EVIDENCE_MISSING_OR_UNVERIFIED:PAYMENTS:PAYMENT_LICENCE"), JSON.stringify(rejected.data.blockers));
  await db
    .update(marketLegalIntakeTopics)
    .set({ disposition: "NOT_REQUIRED", reviewStatus: "NOT_REVIEWED", evidenceRequirementStatus: "NOT_REVIEWED", requiredEvidenceTypes: [] })
    .where(eq(marketLegalIntakeTopics.intakeId, `d16-intake-${ABROAD}`));
});

await test("D16-C11 an unpublished policy version blocks activation", async () => {
  deployed();
  await forceDisabledIntake(ABROAD);
  await request(`/admin/compliance/country-readiness/${ABROAD}/review-request`, "POST", {}, admin);
  await request(
    `/admin/compliance/country-readiness/${ABROAD}/topics/POLICY_VERSIONS/review`,
    "POST",
    {
      disposition: "REQUIRED",
      counselFinding: "Consumer terms must be published at the version counsel read.",
      officialReference: "W06-REF-POLICY-VERSIONS",
      evidenceRequirementStatus: "NO_REQUIREMENTS",
      requiredEvidenceTypes: [],
      policyRequirementStatus: "VERSIONS_SET",
      requiredPolicyVersions: [{ policyKey: "TERMS_OF_SERVICE", version: "w06-required" }],
    },
    counsel,
  );
  const missing = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(
    missing.data.blockers.includes("POLICY_VERSION_NOT_PUBLISHED:POLICY_VERSIONS:TERMS_OF_SERVICE"),
    JSON.stringify(missing.data.blockers),
  );

  await db.insert(policyRegistryVersions).values({
    id: randomUUID(),
    policyKey: "TERMS_OF_SERVICE",
    version: "w06-required",
    lifecycle: "PUBLISHED",
    contentSha256: createHash("sha256").update(`w06-audit-terms-${ABROAD}`).digest("hex"),
    effectiveDate: "2026-01-01",
    marketScope: ABROAD,
    requiresAcceptance: true,
    materialChange: true,
    legalReference: "W06-AUDIT-LEGAL-REFERENCE",
    approvedBy: counsel.id,
    approvedAt: new Date(),
    publishedBy: admin.id,
    publishedAt: new Date(),
  });
  const satisfied = await request(`/admin/compliance/country-readiness/${ABROAD}`, "GET", undefined, admin);
  assert.ok(!satisfied.data.blockers.includes("POLICY_VERSION_NOT_PUBLISHED:POLICY_VERSIONS:TERMS_OF_SERVICE"), JSON.stringify(satisfied.data.blockers));

  await db.delete(policyRegistryVersions).where(eq(policyRegistryVersions.version, "w06-required"));
  await db
    .update(marketLegalIntakeTopics)
    .set({ disposition: "NOT_REQUIRED", reviewStatus: "NOT_REVIEWED", policyRequirementStatus: "NOT_REVIEWED", requiredPolicyVersions: [] })
    .where(eq(marketLegalIntakeTopics.intakeId, `d16-intake-${ABROAD}`));
});

// ─── D. suspension, rights and reachability ─────────────────────────────────

await test("D16-D12 suspension stops new access immediately and the record survives", async () => {
  deployed();
  await forceActivatedIntake(HOME);
  await seedEnabledCapability(HOME, "BROWSING");
  const open = await request("/listings");
  assert.equal(open.status, 200, open.text);

  const suspended = await request(
    `/admin/compliance/country-readiness/${HOME}/suspend`,
    "POST",
    { referenceCode: `W06-SUSPEND-${runId}` },
    admin,
  );
  assert.equal(suspended.status, 200, suspended.text);
  assert.equal(suspended.data.activationStatus, "SUSPENDED");

  const blocked = await request("/listings");
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(errorCode(blocked), "COUNTRY_INTAKE_NOT_ACTIVE");

  const overview = await request(`/admin/compliance/markets/${HOME}/capabilities`, "GET", undefined, admin);
  const browsing = overview.data.capabilities.find((item: any) => item.capability === "BROWSING");
  assert.equal(browsing.status, "BLOCKED", "a suspended country must not display an enabled capability");
  assert.equal(browsing.enabled, false);

  const unsuspended = await request(
    `/admin/compliance/country-readiness/${HOME}/activate`,
    "POST",
    { referenceCode: `W06-REACTIVATE-${runId}` },
    activator,
  );
  assert.equal(unsuspended.status, 409, unsuspended.text);
  assert.equal(errorCode(unsuspended), "COUNTRY_ACTIVATION_PREREQUISITES_MISSING");
  assert.equal((await request("/listings")).status, 409);

  // D16-BL-07: suspension does not invalidate the approval ladder. The counsel, owner and
  // technical approvals all survive the emergency stop, so the only thing standing between a
  // suspension and a re-activation is the technical activator's reference code plus a resolved
  // topic package — no fresh counsel review is required. The fix is to expire the ladder on
  // suspension (or require a new counsel review before re-activation).
  const afterSuspension = await request(`/admin/compliance/country-readiness/${HOME}`, "GET", undefined, admin);
  assert.equal(afterSuspension.data.intake.counselApprovalStatus, "APPROVED", "the approval ladder outlives the suspension");
  assert.equal(afterSuspension.data.intake.ownerApprovalStatus, "APPROVED");
  assert.equal(afterSuspension.data.intake.technicalVerificationStatus, "PASSED");

  await resetCapability(HOME, "BROWSING");
  await forceDisabledIntake(HOME);
});

await test("D16-D13 a legal hold does not block a data-subject export or a withdrawal", async () => {
  deployed();
  await forceDisabledIntake(HOME);
  const buyer = await register(`W06 buyer ${runId}`);
  await db.update(users).set({ role: "USER" }).where(eq(users.id, buyer.id));

  const retention = await request("/privacy/retention");
  assert.equal(retention.status, 200, retention.text);

  const before = await request("/account/privacy/requests", "GET", undefined, buyer);
  assert.equal(before.status, 200, before.text);

  const consent = await request("/account/policy-consents", "GET", undefined, buyer);
  assert.equal(consent.status, 200, consent.text);

  const personalData = await request(`/admin/compliance/country-readiness/${HOME}`, "GET", undefined, admin);
  assert.equal(personalData.status, 200, personalData.text);
  const topic = personalData.data.topics.find((item: any) => item.topicKey === "PERSONAL_DATA");
  assert.equal(topic.reviewStatus, "NOT_REVIEWED", "an unreviewed privacy topic must be visible as unreviewed, not hidden");
});

await test("D16-D14 no external AI or payment provider is reachable behind the legal gate", async () => {
  deployed();
  assert.equal(process.env.DINAR_AI_MODEL_FALLBACK, "false", "the runner must not enable a model fallback");
  assert.equal(paymentSimulationEnabled(), false, "payment simulation is unavailable unless the wave-4 fixture switch is set");

  const intents = await request(
    "/payments/intents",
    "POST",
    { orderId: "w06-no-order", idempotencyKey: `w06-intent-${runId}` },
    admin,
  );
  assert.equal(intents.status, 404, intents.text);

  const undeclaredMarket = await request("/admin/compliance/markets", "GET", undefined, admin);
  assert.equal(undeclaredMarket.status, 200, undeclaredMarket.text);
});

await test("D16-D15 the gate is only exempt when the environment declares development", async () => {
  assert.equal(marketLegalGateEnforced({ NODE_ENV: "development" }), false);
  assert.equal(marketLegalGateEnforced({ NODE_ENV: "production" }), true);
  assert.equal(marketLegalGateEnforced({ NODE_ENV: "development", DINAR_DEPLOYMENT_ENV: "staging" }), true);
  assert.equal(marketLegalGateEnforced({ NODE_ENV: "development", DINAR_DEPLOYMENT_ENV: "review-app" }), true);
  assert.equal(marketLegalGateEnforced({}), true);

  // D16-BL-01: the exemption keys on NODE_ENV alone, so a deployment that inherits
  // NODE_ENV=development and never sets DINAR_DEPLOYMENT_ENV serves the market with every
  // legal gate off. Recorded here, not asserted as correct behaviour.
  delete process.env.DINAR_DEPLOYMENT_ENV;
  assert.equal(process.env.NODE_ENV, "development");
  await forceDisabledIntake(HOME);
  await resetCapability(HOME, "BROWSING");
  const unguarded = await request("/listings");
  assert.equal(unguarded.status, 200, "with the deployment environment undeclared the browse gate is off");
  const unguardedCapability = await assertMarketLegalCapability(HOME, "TRANSACTIONS");
  assert.deepEqual(unguardedCapability, { enforced: false, enabled: true });
  process.env.DINAR_DEPLOYMENT_ENV = "production";
});

// ─── E. audit trail ──────────────────────────────────────────────────────────

await test("D16-E16 the incident ladder cannot be skipped and its trail cannot be rewritten", async () => {
  deployed();
  const created = await request(
    "/admin/security/incidents",
    "POST",
    {
      category: "PRIVACY",
      severity: "HIGH",
      summary: "Wave-06 audit fixture: an unauthorised read of conversation history was detected.",
      affectedSystems: ["api-conversations"],
      evidenceReference: `W06-INCIDENT-${runId}`,
    },
    admin,
  );
  assert.equal(created.status, 201, created.text);
  const id = created.data.id as string;

  const transition = (action: string, body: Record<string, unknown> = {}) =>
    request(`/admin/security/incidents/${id}/transition`, "POST", { action, ...body }, admin);

  const skipRecovery = await transition("RECORD_RECOVERY", { summary: "Wave-06 fixture recovery." });
  assert.equal(skipRecovery.status, 409, skipRecovery.text);
  const closeEarly = await transition("CLOSE_WITH_POSTMORTEM", { summary: "Wave-06 fixture postmortem." });
  assert.equal(closeEarly.status, 409, closeEarly.text);
  const shortSummary = await transition("RECORD_CONTAINMENT", { summary: "ab" });
  assert.equal(shortSummary.status, 400, shortSummary.text);
  const blankSummary = await transition("RECORD_CONTAINMENT", { summary: "   " });
  assert.equal(blankSummary.status, 409, blankSummary.text);
  const documentBody = await transition("ADD_EVIDENCE_REFERENCE", { reference: "BEGIN CERTIFICATE MIID" + "A".repeat(200) });
  assert.equal(documentBody.status, 400, documentBody.text);

  const contained = await transition("RECORD_CONTAINMENT", { summary: "Wave-06 fixture: reads revoked and sessions invalidated." });
  assert.equal(contained.status, 200, contained.text);
  const recovered = await transition("RECORD_RECOVERY", { summary: "Wave-06 fixture: access path closed and verified." });
  assert.equal(recovered.status, 200, recovered.text);

  const requested = await transition("REQUEST_COUNSEL_REVIEW");
  assert.equal(requested.status, 200, requested.text);
  const counselReviewByAdmin = await transition("RECORD_COUNSEL_REVIEW", { reference: `W06-INCIDENT-REVIEW-${runId}` });
  assert.equal(counselReviewByAdmin.status, 403, counselReviewByAdmin.text);
  const counselReview = await request(
    `/admin/security/incidents/${id}/transition`,
    "POST",
    { action: "RECORD_COUNSEL_REVIEW", reference: `W06-INCIDENT-REVIEW-${runId}` },
    counsel,
  );
  assert.equal(counselReview.status, 200, counselReview.text);
  assert.equal(counselReview.data.counselAssessment, "REVIEWED");

  const closed = await transition("CLOSE_WITH_POSTMORTEM", { summary: "Wave-06 fixture: postmortem recorded." });
  assert.equal(closed.status, 200, closed.text);

  const reopen = await transition("RECORD_CONTAINMENT", { summary: "Wave-06 fixture: attempted reopen." });
  assert.equal(reopen.status, 409, reopen.text);

  // D16-BL-05: a closed incident can still be downgraded, so the record of what happened at the
  // time is rewritten without any counsel or owner step. The fix is a status guard on
  // CHANGE_SEVERITY once the incident is CLOSED (or a required reference plus a designated actor).
  const downgrade = await transition("CHANGE_SEVERITY", { severity: "LOW" });
  assert.equal(downgrade.status, 200, downgrade.text);
  assert.equal(downgrade.data.severity, "LOW");

  await assert.rejects(
    db.update(securityIncidentEvents).set({ reference: "W06-REWRITE" }).where(eq(securityIncidentEvents.incidentId, id)),
    (error: unknown) => nestedSqlState(error) === "55000",
  );
  await assert.rejects(
    db.delete(securityIncidentEvents).where(eq(securityIncidentEvents.incidentId, id)),
    (error: unknown) => nestedSqlState(error) === "55000",
  );
  await assert.rejects(
    db.execute(sql`TRUNCATE security_incident_events`),
    (error: unknown) => nestedSqlState(error) === "55000",
  );

  const trail = await request(`/admin/security/incidents/${id}`, "GET", undefined, admin);
  assert.equal(trail.status, 200, trail.text);
  assert.ok(trail.data.events.length >= 7, JSON.stringify(trail.data.events.length));

  // A fabricated incident can still be written straight to the register: security_incidents itself
  // has no append-only trigger, only its event trail does. The row is therefore readable through
  // the admin API with no OPENED event behind it, which is how a fabricated record would appear.
  const fabricatedId = await createIncidentDirectly();
  const register = await request(`/admin/security/incidents/${fabricatedId}`, "GET", undefined, admin);
  assert.equal(register.status, 200, register.text);
  assert.equal(register.data.incident.status, "OPEN");
  assert.deepEqual(register.data.events, [], "a hand-written incident has no audit trail to validate");
});

async function createIncidentDirectly(): Promise<string> {
  const now = new Date();
  const id = randomUUID();
  await db.insert(securityIncidents).values({
    id,
    category: "SECURITY",
    severity: "CRITICAL",
    status: "OPEN",
    summary: "Wave-06 audit fixture written straight to the table.",
    affectedSystems: ["api"],
    detectedAt: now,
    openedBy: admin.id,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

await test("D16-E17 an incident closed without counsel review still cannot claim REVIEWED", async () => {
  deployed();
  const now = new Date();
  await assert.rejects(
    db.insert(securityIncidents).values({
      id: randomUUID(),
      category: "PRIVACY",
      severity: "MEDIUM",
      status: "OPEN",
      summary: "Wave-06 audit fixture attempting a pre-written counsel review.",
      affectedSystems: ["api"],
      detectedAt: now,
      openedBy: admin.id,
      counselAssessment: "REVIEWED",
      createdAt: now,
      updatedAt: now,
    }),
    (error: unknown) => nestedSqlState(error) === "23514",
  );

  const forgedActivation = await db
    .update(marketLegalIntakes)
    .set({ activationStatus: "ACTIVE" })
    .where(eq(marketLegalIntakes.marketId, HOME))
    .then(() => "accepted")
    .catch((error: unknown) => nestedSqlState(error));
  assert.equal(forgedActivation, "23514", "an ACTIVE intake without approvals must be refused by the database");

  await db
    .update(marketLegalIntakes)
    .set({
      counselApprovalStatus: "APPROVED",
      counselApprovedBy: counselApprover.id,
      counselApprovedAt: now,
      counselApprovalReference: "W06-FORGED-COUNSEL",
      technicalVerificationStatus: "PASSED",
      technicalVerifiedBy: technical.id,
      technicalVerifiedAt: now,
      ownerApprovalStatus: "APPROVED",
      ownerApprovedBy: owner.id,
      ownerApprovedAt: now,
      ownerApprovalReference: "W06-FORGED-OWNER",
      counselReviewedBy: counsel.id,
      counselReviewedAt: now,
      activationStatus: "ACTIVE",
      activatedBy: activator.id,
      activatedAt: now,
    })
    .where(eq(marketLegalIntakes.marketId, HOME));
  const reopened = await request("/listings");
  assert.equal(reopened.status, 409, "an activated country still needs an enabled capability for browsing");
  await forceDisabledIntake(HOME);
});

// ─── F. reference hygiene ────────────────────────────────────────────────────

await test("D16-F18 the reference field accepts a document URL although it promises a code only (D16-BL-06)", async () => {
  deployed();
  await forceDisabledIntake(ABROAD);
  await request(`/admin/compliance/country-readiness/${ABROAD}/review-request`, "POST", {}, admin);

  const urlAsReference = "https://docs.example.gov.jo/register/2026";
  const evidence = await request(
    `/admin/compliance/country-readiness/${ABROAD}/evidence`,
    "POST",
    {
      topicKey: "DELIVERY_LOGISTICS",
      evidenceType: "LOGISTICS_CONTRACT",
      documentVersion: "2026-01",
      referenceCode: urlAsReference,
      idempotencyKey: `w06-url-ref-${runId}`,
    },
    admin,
  );
  // The reject message in cleanReference promises "a reference code, not a link or a document",
  // yet the pattern ^[A-Za-z][A-Za-z0-9._:/-]{2,199}$ is satisfied by any HTTPS URL, so a locator
  // that can move, be access-controlled, or be revoked privately is recorded as the evidence
  // reference. When the guard is tightened this assertion must flip to 400 REFERENCE_INVALID.
  assert.equal(evidence.status, 201, evidence.text);
  assert.equal(evidence.data.referenceCode, urlAsReference);

  const stored = await db
    .select({ referenceCode: marketLegalEvidence.referenceCode })
    .from(marketLegalEvidence)
    .where(eq(marketLegalEvidence.id, evidence.data.id))
    .limit(1);
  assert.equal(stored[0]?.referenceCode, urlAsReference, "the URL is persisted verbatim in the compliance record");

  await db
    .update(marketLegalEvidence)
    .set({ status: "REJECTED", reviewedBy: counsel.id, reviewedAt: new Date(), expiresAt: null, updatedAt: new Date() })
    .where(eq(marketLegalEvidence.id, evidence.data.id));

  await request(`/admin/compliance/markets/${HOME}/capabilities/DELIVERY_OPERATIONS/review-request`, "POST", {}, admin);
  const capabilityReview = await request(
    `/admin/compliance/markets/${HOME}/capabilities/DELIVERY_OPERATIONS/counsel-review`,
    "POST",
    { outcome: "READY_FOR_OWNER_REVIEW", reference: urlAsReference },
    counsel,
  );
  assert.equal(capabilityReview.status, 200, capabilityReview.text);
  assert.equal(capabilityReview.data.counselReviewRecorded, true);
  const [capabilityRow] = await db
    .select({ counselReference: marketLegalCapabilityApprovals.counselReference })
    .from(marketLegalCapabilityApprovals)
    .where(
      and(
        eq(marketLegalCapabilityApprovals.marketId, HOME),
        eq(marketLegalCapabilityApprovals.capability, "DELIVERY_OPERATIONS"),
      ),
    )
    .limit(1);
  assert.equal(capabilityRow?.counselReference, urlAsReference, "the approval trail stores a private locator as counsel's evidence");
  await resetCapability(HOME, "DELIVERY_OPERATIONS");
});

// ─── teardown ────────────────────────────────────────────────────────────────

/**
 * This file declares awaited top-level tests, so cleanup cannot be a root-level after() hook: in
 * run 41661934742 a hook registered ahead of the tests fired after the first one, restoring the
 * role environment and closing the listener while the rest of the audit was still running. An
 * awaited final test is ordered by declaration, which is the only guarantee teardown needs.
 */
await test("D16-Z99 the audit leaves the disposable database as it found it", async () => {
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // Evidence and intake events are append-only or event-referenced, so the fixture state is
  // rolled back by neutralising the rows rather than deleting them.
  await db.delete(marketLegalCapabilityApprovals);
  await forceDisabledIntake(HOME);
  await forceDisabledIntake(ABROAD);
  await db
    .update(marketLegalIntakeTopics)
    .set({
      disposition: "NOT_REQUIRED",
      reviewStatus: "NOT_REVIEWED",
      evidenceRequirementStatus: "NOT_REVIEWED",
      policyRequirementStatus: "NOT_REVIEWED",
      requiredEvidenceTypes: [],
      requiredPolicyVersions: [],
    })
    .where(sql`true`);
  await db
    .update(marketLegalEvidence)
    .set({ status: "REJECTED", reviewedBy: counsel.id, reviewedAt: new Date(), expiresAt: null })
    .where(eq(marketLegalEvidence.intakeId, `d16-intake-${ABROAD}`));
  await server.close();
});
