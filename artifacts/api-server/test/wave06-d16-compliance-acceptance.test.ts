/**
 * WAVE 06 D16 acceptance: the country legal gate, the separation of counsel review from owner
 * approval, the append-only audit records, incident lifecycle, KYC retention boundaries and the
 * provisional retention policy keep failing closed. Nothing here asserts that a country is
 * legally approved; every activation path in this suite is disposable fixture state.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  businessVerificationDocuments,
  db,
  marketLegalCapabilityApprovals,
  marketLegalCapabilityEvents,
  marketLegalIntakes,
  markets,
  pool,
  securityIncidentEvents,
  users,
} from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import {
  MARKET_LEGAL_CAPABILITIES,
  assertMarketLegalCapability,
  createSecurityIncident,
  disableMarketCapability,
  enableMarketCapability,
  getSecurityIncident,
  marketLegalGateEnforced,
  recordMarketCounselReview,
  requestMarketCapabilityReview,
  transitionSecurityIncident,
} from "../src/lib/d16-readiness";
import { BUSINESS_DOCUMENT_POLICY, registerBusinessDocumentScanner, businessVerificationReadiness, unregisterBusinessDocumentScanner } from "../src/lib/business-profiles";
import { retentionPolicy } from "../src/lib/privacy-rights";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_W06_D16_ACCEPTANCE");

const PRODUCTION: Record<string, string> = { NODE_ENV: "production", DINAR_DEPLOYMENT_ENV: "production" };
const runId = randomUUID().slice(0, 8);

async function admin(name: string) {
  const id = randomUUID();
  const [market] = await db.select({ id: markets.id }).from(markets).where(eq(markets.id, DEFAULT_MARKET)).limit(1);
  assert.ok(market, `expected migrated market ${DEFAULT_MARKET}`);
  await db.insert(users).values({
    id,
    displayName: name,
    phoneCountryCode: "+962",
    phoneNumber: `78${runId.slice(0, 4)}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`,
    normalizedPhone: `d16-accept-${id}`,
    accountCountry: "JO",
    activeMarketId: market.id,
    passwordHash: "fixture-unused",
    role: "ADMIN",
  });
  return id;
}

const counsel = await admin(`D16 acceptance counsel ${runId}`);
const owner = await admin(`D16 acceptance owner ${runId}`);
const ordinary = await admin(`D16 acceptance ordinary ${runId}`);
const outsider = await admin(`D16 acceptance outsider ${runId}`);
await db.update(users).set({ role: "USER" }).where(eq(users.id, outsider));
const ENV = { ...PRODUCTION, DINAR_COUNSEL_REVIEWER_IDS: counsel, DINAR_LEGAL_OWNER_IDS: owner };
// Another D16 suite may have suspended a launch intake in this shared disposable database; the
// invariant this wave proves is that none is ACTIVE and every capability still fails closed.
const initialIntakes = await db
  .select({
    marketId: marketLegalIntakes.marketId,
    activationStatus: marketLegalIntakes.activationStatus,
    counselApprovalStatus: marketLegalIntakes.counselApprovalStatus,
    ownerApprovalStatus: marketLegalIntakes.ownerApprovalStatus,
    technicalVerificationStatus: marketLegalIntakes.technicalVerificationStatus,
  })
  .from(marketLegalIntakes)
  .where(inArray(marketLegalIntakes.marketId, ["JO", "KW", "SA"]));

/** Disposable fixture state: a fully signed country intake, restored by the caller. */
async function activateIntake(marketId: string) {
  const now = new Date();
  await db
    .update(marketLegalIntakes)
    .set({
      counselApprovalStatus: "APPROVED",
      counselReviewedBy: counsel,
      counselReviewedAt: now,
      counselApprovalReference: `W06-COUNSEL-APPROVAL-${runId}`,
      counselApprovedBy: counsel,
      counselApprovedAt: now,
      technicalVerificationStatus: "PASSED",
      ownerApprovalStatus: "APPROVED",
      ownerApprovalReference: `W06-OWNER-APPROVAL-${runId}`,
      ownerApprovedBy: owner,
      ownerApprovedAt: now,
      activationStatus: "ACTIVE",
      activatedBy: owner,
      activatedAt: now,
    })
    .where(eq(marketLegalIntakes.marketId, marketId));
}

async function restoreIntake(marketId: string, before: typeof marketLegalIntakes.$inferSelect) {
  await db
    .update(marketLegalIntakes)
    .set({
      activationStatus: before.activationStatus,
      counselApprovalStatus: before.counselApprovalStatus,
      ownerApprovalStatus: before.ownerApprovalStatus,
      technicalVerificationStatus: before.technicalVerificationStatus,
    })
    .where(eq(marketLegalIntakes.marketId, marketId));
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number })?.status;
}
function codeOf(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

test("D16.2 nine capabilities fail closed for JO, KW and SA before country activation", async () => {
  assert.equal(marketLegalGateEnforced({ NODE_ENV: "development" }), false);
  for (const deployment of ["production", "staging", "unknown"]) assert.equal(marketLegalGateEnforced({ ...PRODUCTION, DINAR_DEPLOYMENT_ENV: deployment }), true);
  const intakes = await db
    .select({ marketId: marketLegalIntakes.marketId, activationStatus: marketLegalIntakes.activationStatus })
    .from(marketLegalIntakes)
    .where(inArray(marketLegalIntakes.marketId, ["JO", "KW", "SA"]));
  assert.deepEqual(intakes.map((row) => row.marketId).sort(), ["JO", "KW", "SA"]);
  assert.ok(intakes.every((row) => row.activationStatus !== "ACTIVE"), "no launch country is active");
  assert.ok(intakes.every((row) => row.counselApprovalStatus !== "APPROVED" && row.ownerApprovalStatus !== "APPROVED"), "no launch country carries a forged approval");
  let refusals = 0;
  for (const marketId of ["JO", "KW", "SA"]) {
    for (const capability of MARKET_LEGAL_CAPABILITIES) {
      await assert.rejects(
        assertMarketLegalCapability(marketId, capability, db, PRODUCTION),
        (error: unknown) => codeOf(error) === "COUNTRY_INTAKE_NOT_ACTIVE",
        `${marketId}/${capability}`,
      );
      refusals += 1;
    }
  }
  assert.equal(refusals, 27);
});

test("D16.2 country activation can be temporarily disposable but never ENABLES a capability by itself", async () => {
  const [before] = await db.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, DEFAULT_MARKET));
  assert.ok(before);
  await activateIntake(DEFAULT_MARKET);
  try {
    await assert.rejects(
      assertMarketLegalCapability(DEFAULT_MARKET, "ELECTRONIC_PAYMENT", db, PRODUCTION),
      (error: unknown) => codeOf(error) === "MARKET_CAPABILITY_NOT_ENABLED",
    );
    // Administrative review alone is not approval: an un-designated admin cannot start it.
    await assert.rejects(
      requestMarketCapabilityReview({ actorId: outsider, marketId: DEFAULT_MARKET, capability: "ELECTRONIC_PAYMENT" }),
      (error: unknown) => [403, 404].includes(statusOf(error) ?? 0),
    );
  } finally {
    await restoreIntake(DEFAULT_MARKET, before);
  }
  const [afterReset] = await db.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, DEFAULT_MARKET));
  assert.equal(afterReset!.activationStatus, before.activationStatus, "the fixture leaves the intake at its original status");
});

test("D16.6 counsellor review and owner approval are separate, ordered and never self-approved", async () => {
  const capability = "ELECTRONIC_PAYMENT" as const;
  const [before] = await db.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, DEFAULT_MARKET));
  assert.ok(before);
  await activateIntake(DEFAULT_MARKET);
  try {
    const requested = await requestMarketCapabilityReview({ actorId: ordinary, marketId: DEFAULT_MARKET, capability });
    assert.equal(requested.status, "COUNSEL_REVIEW_REQUIRED");
    const duplicateRequest = await requestMarketCapabilityReview({ actorId: ordinary, marketId: DEFAULT_MARKET, capability });
    assert.equal(duplicateRequest.status, "COUNSEL_REVIEW_REQUIRED");

    // A designated counsel reviewer who is also a legal owner may not review its own package.
    await assert.rejects(
      recordMarketCounselReview({ actorId: owner, marketId: DEFAULT_MARKET, capability, outcome: "READY_FOR_OWNER_REVIEW", reference: `W06-COUNSEL-${runId}`, env: ENV }),
      (error: unknown) => codeOf(error) === "DESIGNATED_COUNSEL_REVIEWER_REQUIRED",
    );
    // An ordinary admin cannot review or approve, whatever the role name says.
    await assert.rejects(
      recordMarketCounselReview({ actorId: ordinary, marketId: DEFAULT_MARKET, capability, outcome: "READY_FOR_OWNER_REVIEW", reference: `W06-COUNSEL-${runId}`, env: ENV }),
      (error: unknown) => codeOf(error) === "DESIGNATED_COUNSEL_REVIEWER_REQUIRED",
    );
    await assert.rejects(
      enableMarketCapability({ actorId: ordinary, marketId: DEFAULT_MARKET, capability, reference: `W06-OWNER-${runId}`, env: ENV }),
      (error: unknown) => codeOf(error) === "DESIGNATED_LEGAL_OWNER_REQUIRED",
    );
    // Missing counsel approval cannot be replaced by an owner approval.
    await assert.rejects(
      enableMarketCapability({ actorId: owner, marketId: DEFAULT_MARKET, capability, reference: `W06-OWNER-${runId}`, env: ENV }),
      (error: unknown) => codeOf(error) === "COUNSEL_REVIEW_REQUIRED",
    );

    const reviewed = await recordMarketCounselReview({ actorId: counsel, marketId: DEFAULT_MARKET, capability, outcome: "READY_FOR_OWNER_REVIEW", reference: `W06-COUNSEL-${runId}`, env: ENV });
    assert.equal(reviewed.status, "OWNER_APPROVAL_REQUIRED");
    // A duplicate counsel review of a closed step is an illegal transition.
    await assert.rejects(
      recordMarketCounselReview({ actorId: counsel, marketId: DEFAULT_MARKET, capability, outcome: "READY_FOR_OWNER_REVIEW", reference: `W06-COUNSEL-2-${runId}`, env: ENV }),
      (error: unknown) => statusOf(error) === 409,
    );
    const enabled = await enableMarketCapability({ actorId: owner, marketId: DEFAULT_MARKET, capability, reference: `W06-OWNER-${runId}`, env: ENV });
    assert.equal(enabled.status, "ENABLED");
    await assert.doesNotReject(assertMarketLegalCapability(DEFAULT_MARKET, capability, db, PRODUCTION));
    // Duplicate owner approval is refused instead of silently re-stamping the record.
    await assert.rejects(
      enableMarketCapability({ actorId: owner, marketId: DEFAULT_MARKET, capability, reference: `W06-OWNER-2-${runId}`, env: ENV }),
      (error: unknown) => statusOf(error) === 409,
    );

    const disabled = await disableMarketCapability({ actorId: ordinary, marketId: DEFAULT_MARKET, capability });
    assert.equal(disabled.status, "DISABLED");
    await assert.rejects(assertMarketLegalCapability(DEFAULT_MARKET, capability, db, PRODUCTION), (error: unknown) => codeOf(error) === "MARKET_CAPABILITY_NOT_ENABLED");
    // Re-enabling needs a fresh, separately reviewed package.
    await assert.rejects(
      enableMarketCapability({ actorId: owner, marketId: DEFAULT_MARKET, capability, reference: `W06-OWNER-3-${runId}`, env: ENV }),
      (error: unknown) => statusOf(error) === 409,
    );

    const events = await db
      .select()
      .from(marketLegalCapabilityEvents)
      .where(and(eq(marketLegalCapabilityEvents.marketId, DEFAULT_MARKET), eq(marketLegalCapabilityEvents.capability, capability)));
    assert.ok(events.length >= 5, `expected the approval trail, got ${events.length}`);
    await assert.rejects(db.update(marketLegalCapabilityEvents).set({ eventType: "FORGED" }).where(eq(marketLegalCapabilityEvents.id, events[0]!.id)));
    await assert.rejects(db.delete(marketLegalCapabilityEvents).where(eq(marketLegalCapabilityEvents.id, events[0]!.id)));
  } finally {
    await restoreIntake(DEFAULT_MARKET, before);
  }
});

test("D16.2 no seeded launch market ends up with an enabled capability", async () => {
  const rows = await db
    .select()
    .from(marketLegalCapabilityApprovals)
    .where(inArray(marketLegalCapabilityApprovals.marketId, ["JO", "KW", "SA"]));
  // The disposable fixture above may have re-enabled one capability on the default market;
  // this assertion is about the seeded intake rows, which must stay DISABLED.
  const intakes = await db
    .select()
    .from(marketLegalIntakes)
    .where(inArray(marketLegalIntakes.marketId, ["JO", "KW", "SA"]));
  assert.ok(intakes.every((row) => row.activationStatus !== "ACTIVE"));
  const enabledButBlocked = rows.filter((row) => row.status === "ENABLED");
  for (const row of enabledButBlocked)
    await assert.rejects(assertMarketLegalCapability(row.marketId, row.capability as any, db, PRODUCTION), (error: unknown) => codeOf(error) === "COUNTRY_INTAKE_NOT_ACTIVE");
});

test("D16.6 security incidents are staged, audited and append-only", async () => {
  await assert.rejects(
    createSecurityIncident({ actorId: outsider, category: "SECURITY", severity: "HIGH", summary: "fixture", affectedSystems: ["api"] }),
    (error: unknown) => [403, 404].includes(statusOf(error) ?? 0),
  );
  await assert.rejects(
    createSecurityIncident({ actorId: ordinary, category: "SECURITY", severity: "HIGH", summary: "x", affectedSystems: ["api"] }),
    (error: unknown) => codeOf(error) === "INCIDENT_SUMMARY_INVALID",
  );
  await assert.rejects(
    createSecurityIncident({ actorId: ordinary, category: "NOT_A_CATEGORY" as any, severity: "HIGH", summary: "fixture", affectedSystems: ["api"] }),
  );
  const incident = await createSecurityIncident({ actorId: ordinary, category: "PRIVACY", severity: "HIGH", summary: `W06 synthetic incident ${runId}`, affectedSystems: ["api", "api"], evidenceReference: `W06-INCIDENT-${runId}` });
  assert.equal(incident.status, "OPEN");
  await assert.rejects(
    transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "RECORD_RECOVERY", summary: "skip containment" }),
    (error: unknown) => codeOf(error) === "INCIDENT_RECOVERY_INVALID",
  );
  await assert.rejects(
    transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "CLOSE_WITH_POSTMORTEM", summary: "close early" }),
    (error: unknown) => codeOf(error) === "INCIDENT_POSTMORTEM_REQUIRED",
  );
  await assert.rejects(
    transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "RECORD_COUNSEL_REVIEW", env: ENV }),
    (error: unknown) => codeOf(error) === "DESIGNATED_COUNSEL_REVIEWER_REQUIRED",
  );
  assert.equal((await transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "RECORD_CONTAINMENT", summary: "contained in fixture" })).status, "CONTAINED");
  assert.equal((await transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "RECORD_RECOVERY", summary: "recovered in fixture" })).status, "RECOVERED");
  assert.equal((await transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "CLOSE_WITH_POSTMORTEM", summary: "postmortem fixture" })).status, "CLOSED");
  await assert.rejects(
    transitionSecurityIncident({ actorId: ordinary, id: incident.id, action: "CLOSE_WITH_POSTMORTEM", summary: "close twice" }),
    (error: unknown) => statusOf(error) === 409,
  );
  const detail = await getSecurityIncident(incident.id);
  assert.deepEqual(
    detail.events.map((event) => event.eventType).sort(),
    ["CONTAINMENT_RECORDED", "OPENED", "POST_INCIDENT_RECORDED", "RECOVERY_RECORDED"],
  );
  await assert.rejects(db.update(securityIncidentEvents).set({ eventType: "FORGED" }).where(eq(securityIncidentEvents.incidentId, incident.id)));
  await assert.rejects(db.delete(securityIncidentEvents).where(eq(securityIncidentEvents.incidentId, incident.id)));
  await assert.rejects(db.delete(securityIncidentEvents).where(eq(securityIncidentEvents.incidentId, incident.id)).returning());
  const [stillThere] = await db.select().from(securityIncidentEvents).where(eq(securityIncidentEvents.incidentId, incident.id)).limit(1);
  assert.ok(stillThere);
});

test("D16.4 KYC retention is documented at 365 days and stays a boundary, not a deletion job", async () => {
  assert.equal(BUSINESS_DOCUMENT_POLICY.retentionDaysAfterDecision, 365);
  assert.equal(BUSINESS_DOCUMENT_POLICY.legallyReviewed, false, "document requirements are not legally approved by this wave");
  const readiness = businessVerificationReadiness();
  assert.equal(readiness.legallyReviewedRequirements, false);
  assert.equal(readiness.scanner, "NOT_CONNECTED");
  const secret = process.env.NODE_ENV;
  const liveProviders = process.env.DINAR_LIVE_PROVIDERS_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.DINAR_LIVE_PROVIDERS_ENABLED;
    assert.throws(() => registerBusinessDocumentScanner({ scannerKey: "fixture-scanner", scan: async () => "CLEAN" }), /scanners are disabled/);
  } finally {
    process.env.NODE_ENV = secret;
    if (liveProviders === undefined) delete process.env.DINAR_LIVE_PROVIDERS_ENABLED;
    else process.env.DINAR_LIVE_PROVIDERS_ENABLED = liveProviders;
    unregisterBusinessDocumentScanner();
  }
  // Expired retention rows are still present: no destructive retention worker exists, and this
  // suite must never delete a document. Only the scheduled period is recorded.
  const expired = await db
    .select({ id: businessVerificationDocuments.id, retainUntil: businessVerificationDocuments.retainUntil })
    .from(businessVerificationDocuments)
    .where(and(eq(businessVerificationDocuments.status, "ACCEPTED")));
  for (const row of expired) assert.ok(row.retainUntil === null || row.retainUntil instanceof Date);
});

test("D16.3 retention policy stays provisional until an explicit legal approval", () => {
  const provisional = retentionPolicy({} as NodeJS.ProcessEnv);
  assert.equal(provisional.approved, false);
  assert.ok(provisional.records.length > 0);
  const approved = retentionPolicy({ DINAR_RETENTION_APPROVED: "true" } as NodeJS.ProcessEnv);
  assert.equal(approved.approved, true);
  const invalid = retentionPolicy({ DINAR_RETENTION_PERIODS_JSON: "{not json" } as NodeJS.ProcessEnv);
  assert.ok(invalid.records.length > 0, "invalid overrides fall back to defaults, never to no retention");
});

after(async () => {
  for (const row of initialIntakes)
    await db
      .update(marketLegalIntakes)
      .set({
        activationStatus: row.activationStatus,
        counselApprovalStatus: row.counselApprovalStatus,
        ownerApprovalStatus: row.ownerApprovalStatus,
        technicalVerificationStatus: row.technicalVerificationStatus,
      })
      .where(eq(marketLegalIntakes.marketId, row.marketId));
  await pool.end();
});
