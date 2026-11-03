import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import {
  db,
  marketLegalCapabilityEvents,
  marketLegalEvidence,
  marketLegalIntakeEvents,
  marketLegalIntakes,
  marketPriceVersions,
  markets,
  securityIncidentEvents,
  users,
  pool,
} from "@workspace/db";
import { DEFAULT_MARKET } from "@workspace/global";
import app from "../src/app";
import {
  assertMarketLegalCapability,
  createSecurityIncident,
  enableMarketCapability,
  marketLegalGateEnforced,
  recordMarketCounselReview,
  requestMarketCapabilityReview,
} from "../src/lib/d16-readiness";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_D16_ACCEPTANCE");
const execFileAsync = promisify(execFile);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 8);
const password = "d16-password-000000001";
let phoneCounter = 0;
let browserTestWeb:
  | Awaited<ReturnType<typeof startDinarBrowserTestWeb>>
  | undefined;

const [marketFixture] = await db
  .select()
  .from(markets)
  .where(eq(markets.id, DEFAULT_MARKET))
  .limit(1);
assert.ok(marketFixture, `Expected migrated market ${DEFAULT_MARKET}`);
await db
  .update(markets)
  .set({
    isActive: true,
    status: "ACTIVE",
    unitPriceMinor: 100,
  })
  .where(eq(markets.id, DEFAULT_MARKET));
await db.insert(marketPriceVersions).values({
  id: randomUUID(),
  marketId: DEFAULT_MARKET,
  currencyCode: marketFixture.currencyCode,
  unitPriceMinor: 100,
  minorUnitScale: marketFixture.minorUnitScale,
  effectiveFrom: new Date(Date.now() - 60_000),
});

type Actor = { id: string; cookie: string };
async function register(name: string): Promise<Actor> {
  const number = `79${((Date.now() + phoneCounter++) % 10_000_000)
    .toString()
    .padStart(7, "0")}`;
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
  return { id: JSON.parse(text).user.id, cookie };
}

async function request(path: string, method = "GET", body?: unknown, actor?: Actor) {
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

async function verifyCountryAdminBrowser(
  adminCookie: string,
  nonAdminCookie: string,
): Promise<void> {
  browserTestWeb ??= await startDinarBrowserTestWeb(origin);
  const resultPath = `/tmp/dinar-d16-country-admin-${runId}.json`;
  let childError: unknown;
  try {
    await execFileAsync(
      process.execPath,
      [`${process.cwd()}/../dinar/test/d16-country-legal-browser.mjs`],
      {
        env: {
          ...process.env,
          D16_COUNTRY_WEB_BASE: browserTestWeb.baseUrl,
          D16_COUNTRY_ADMIN_COOKIE: adminCookie,
          D16_COUNTRY_NON_ADMIN_COOKIE: nonAdminCookie,
          D16_COUNTRY_UI_RESULT_PATH: resultPath,
        },
      },
    );
  } catch (error) {
    childError = error;
  }
  let browserResult: any;
  try {
    browserResult = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    // Preserve a useful process failure when the browser could not emit a result.
  } finally {
    await unlink(resultPath).catch(() => undefined);
  }
  if (childError) throw childError;
  assert.ok(browserResult, "country admin browser acceptance must write a result");
  assert.equal(browserResult.failure, undefined);
  assert.deepEqual(browserResult.pageErrors, []);
  assert.deepEqual(browserResult.result.countries.sort(), ["JO", "KW", "SA"]);
  assert.equal(browserResult.result.direction, "rtl");
  assert.equal(browserResult.result.nonAdminDenied, true);
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

const ordinaryAdmin = await register(`D16 admin ${runId}`);
const counsel = await register(`D16 counsel ${runId}`);
const counselApprover = await register(`D16 counsel approver ${runId}`);
const owner = await register(`D16 owner ${runId}`);
const technical = await register(`D16 technical ${runId}`);
const activator = await register(`D16 activator ${runId}`);
const nonAdmin = await register(`D16 non-admin ${runId}`);
await db
  .update(users)
  .set({ role: "ADMIN" })
  .where(eq(users.id, ordinaryAdmin.id));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, counsel.id));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, counselApprover.id));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, owner.id));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, technical.id));
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, activator.id));

const previousDeployment = process.env.DINAR_DEPLOYMENT_ENV;
const previousCounselIds = process.env.DINAR_COUNSEL_REVIEWER_IDS;
const previousCounselApproverIds = process.env.DINAR_COUNSEL_APPROVER_IDS;
const previousOwnerIds = process.env.DINAR_LEGAL_OWNER_IDS;
const previousTechnicalVerifierIds = process.env.DINAR_LEGAL_TECHNICAL_VERIFIER_IDS;
const previousTechnicalActivatorIds = process.env.DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS;
process.env.DINAR_COUNSEL_REVIEWER_IDS = counsel.id;
process.env.DINAR_COUNSEL_APPROVER_IDS = counselApprover.id;
process.env.DINAR_LEGAL_OWNER_IDS = owner.id;
process.env.DINAR_LEGAL_TECHNICAL_VERIFIER_IDS = technical.id;
process.env.DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS = activator.id;

await test("D16 capabilities fail closed in deployed environments", async () => {
  assert.equal(marketLegalGateEnforced({ NODE_ENV: "development" }), false);
  assert.equal(
    marketLegalGateEnforced({
      NODE_ENV: "development",
      DINAR_DEPLOYMENT_ENV: "production",
    }),
    true,
  );
  assert.equal(
    marketLegalGateEnforced({
      NODE_ENV: "development",
      DINAR_DEPLOYMENT_ENV: "unknown",
    }),
    true,
  );
  const [market] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, DEFAULT_MARKET));
  assert.ok(market);

  await assert.rejects(
    assertMarketLegalCapability(market.id, "BROWSING", db, {
      NODE_ENV: "production",
      DINAR_DEPLOYMENT_ENV: "production",
    }),
    (error: any) => error.code === "COUNTRY_INTAKE_NOT_ACTIVE",
  );
  process.env.DINAR_DEPLOYMENT_ENV = "production";
  const publicBrowse = await request("/listings");
  assert.equal(publicBrowse.status, 409, publicBrowse.text);

  const deniedAdminRead = await request(
    `/admin/compliance/markets/${market.id}/capabilities`,
    "GET",
    undefined,
    nonAdmin,
  );
  assert.equal(deniedAdminRead.status, 403);

  const reviewRequest = await request(
    `/admin/compliance/markets/${market.id}/capabilities/BROWSING/review-request`,
    "POST",
    {},
    ordinaryAdmin,
  );
  assert.equal(reviewRequest.status, 202, reviewRequest.text);
  await assert.rejects(
    assertMarketLegalCapability(market.id, "BROWSING", db, {
      NODE_ENV: "production",
      DINAR_DEPLOYMENT_ENV: "production",
    }),
    (error: any) => error.code === "COUNTRY_INTAKE_NOT_ACTIVE",
  );

  const counselReady = await request(
    `/admin/compliance/markets/${market.id}/capabilities/BROWSING/counsel-review`,
    "POST",
    {
      outcome: "READY_FOR_OWNER_REVIEW",
      reference: `D16-LEGAL-${runId}`,
    },
    counsel,
  );
  assert.equal(counselReady.status, 200, counselReady.text);
  const cannotSelfApprove = await request(
    `/admin/compliance/markets/${market.id}/capabilities/BROWSING/enable`,
    "POST",
    { reference: `D16-OWNER-${runId}` },
    counsel,
  );
  assert.equal(cannotSelfApprove.status, 403);

  const cannotEnableWithoutCountryApproval = await request(
    `/admin/compliance/markets/${market.id}/capabilities/BROWSING/enable`,
    "POST",
    { reference: `D16-OWNER-${runId}` },
    owner,
  );
  assert.equal(cannotEnableWithoutCountryApproval.status, 409);
  await assert.rejects(
    assertMarketLegalCapability(market.id, "BROWSING", db, {
      NODE_ENV: "production",
      DINAR_DEPLOYMENT_ENV: "production",
    }),
    (error: any) => error.code === "COUNTRY_INTAKE_NOT_ACTIVE",
  );
  assert.equal((await request("/listings")).status, 409);

  const [events] = await db
    .select({ count: marketLegalCapabilityEvents.id })
    .from(marketLegalCapabilityEvents)
    .where(eq(marketLegalCapabilityEvents.marketId, market.id));
  assert.ok(events);
  await assert.rejects(
    db
      .delete(marketLegalCapabilityEvents)
      .where(eq(marketLegalCapabilityEvents.marketId, market.id)),
    (error: unknown) => nestedSqlState(error) === "55000",
  );
});

await test("D16-B country intake is scoped, evidence-safe, and cannot bypass approval gates", async () => {
  process.env.DINAR_DEPLOYMENT_ENV = "production";
  const matrix = await request(
    "/admin/compliance/country-readiness",
    "GET",
    undefined,
    ordinaryAdmin,
  );
  assert.equal(matrix.status, 200, matrix.text);
  assert.deepEqual(
    matrix.data.map((row: { marketId: string }) => row.marketId).sort(),
    ["JO", "KW", "SA"],
  );
  assert.ok(matrix.data.every((row: any) => row.activationStatus === "DISABLED"));
  assert.ok(matrix.data.every((row: any) => row.reviewStatus === "NOT_REVIEWED"));
  assert.ok(matrix.data.every((row: any) => row.counselApprovalStatus === "BLOCKED"));

  for (const marketId of ["JO", "KW", "SA"]) {
    const denied = await request(
      `/admin/compliance/country-readiness/${marketId}`,
      "GET",
      undefined,
      nonAdmin,
    );
    assert.equal(denied.status, 403);
  }
  const initial = await request(
    "/admin/compliance/country-readiness/JO",
    "GET",
    undefined,
    ordinaryAdmin,
  );
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.data.topics.length, 16);
  assert.ok(
    initial.data.topics.every(
      (topic: any) =>
        topic.reviewStatus === "NOT_REVIEWED" &&
        topic.disposition === "UNRESOLVED" &&
        topic.officialReference === null &&
        topic.requiredEvidenceTypes.length === 0 &&
        topic.requiredPolicyVersions.length === 0,
    ),
  );
  assert.ok(initial.data.blockers.includes("COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE"));
  assert.equal(initial.data.intake.activationStatus, "DISABLED");

  const reviewRequest = await request(
    "/admin/compliance/country-readiness/JO/review-request",
    "POST",
    {},
    ordinaryAdmin,
  );
  assert.equal(reviewRequest.status, 202, reviewRequest.text);

  const topicInput = {
    disposition: "REQUIRED",
    counselFinding: "Disposable fixture only; no legal conclusion is asserted.",
    officialReference: "FIXTURE-NOT-LEGAL-ADVICE",
    evidenceRequirementStatus: "REQUIREMENTS_SET",
    requiredEvidenceTypes: ["TEST_REGISTRATION"],
    policyRequirementStatus: "VERSIONS_SET",
    requiredPolicyVersions: [{ policyKey: "TEST_POLICY", version: "99.9" }],
  };
  const ordinaryAdminCannotReview = await request(
    "/admin/compliance/country-readiness/JO/topics/OPERATING_ENTITY/review",
    "POST",
    topicInput,
    ordinaryAdmin,
  );
  assert.equal(ordinaryAdminCannotReview.status, 403);

  const reviewedTopic = await request(
    "/admin/compliance/country-readiness/JO/topics/OPERATING_ENTITY/review",
    "POST",
    topicInput,
    counsel,
  );
  assert.equal(reviewedTopic.status, 200, reviewedTopic.text);
  assert.equal(reviewedTopic.data.reviewStatus, "COUNSEL_REVIEWED");

  const evidenceBase = {
    topicKey: "OPERATING_ENTITY",
    evidenceType: "TEST_REGISTRATION",
    referenceCode: `D16-PRIVATE-REF-${runId}-v1`,
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2021-01-01T00:00:00.000Z",
  };
  const firstEvidenceBody = {
    ...evidenceBase,
    documentVersion: "v1",
    idempotencyKey: `D16-country-${runId}-doc-v1`,
  };
  const firstEvidence = await request(
    "/admin/compliance/country-readiness/JO/evidence",
    "POST",
    firstEvidenceBody,
    ordinaryAdmin,
  );
  assert.equal(firstEvidence.status, 201, firstEvidence.text);
  assert.equal(firstEvidence.data.status, "SUBMITTED_UNVERIFIED");

  const duplicateEvidence = await request(
    "/admin/compliance/country-readiness/JO/evidence",
    "POST",
    firstEvidenceBody,
    ordinaryAdmin,
  );
  assert.equal(duplicateEvidence.status, 201, duplicateEvidence.text);
  assert.equal(duplicateEvidence.data.id, firstEvidence.data.id);

  const reusedKey = await request(
    "/admin/compliance/country-readiness/JO/evidence",
    "POST",
    { ...firstEvidenceBody, documentVersion: "different" },
    ordinaryAdmin,
  );
  assert.equal(reusedKey.status, 409);

  const secondEvidence = await request(
    "/admin/compliance/country-readiness/JO/evidence",
    "POST",
    {
      ...evidenceBase,
      referenceCode: `D16-PRIVATE-REF-${runId}-v2`,
      documentVersion: "v2",
      idempotencyKey: `D16-country-${runId}-doc-v2`,
      expiresAt: null,
    },
    ordinaryAdmin,
  );
  assert.equal(secondEvidence.status, 201, secondEvidence.text);

  const ordinaryAdminCannotReviewEvidence = await request(
    `/admin/compliance/country-readiness/evidence/${firstEvidence.data.id}/review`,
    "POST",
    { outcome: "COUNSEL_REVIEWED" },
    ordinaryAdmin,
  );
  assert.equal(ordinaryAdminCannotReviewEvidence.status, 403);
  const evidenceReview = await request(
    `/admin/compliance/country-readiness/evidence/${firstEvidence.data.id}/review`,
    "POST",
    { outcome: "COUNSEL_REVIEWED" },
    counsel,
  );
  assert.equal(evidenceReview.status, 200, evidenceReview.text);
  assert.equal(evidenceReview.data.status, "COUNSEL_REVIEWED");

  const details = await request(
    "/admin/compliance/country-readiness/JO",
    "GET",
    undefined,
    ordinaryAdmin,
  );
  assert.equal(details.status, 200, details.text);
  assert.ok(details.data.evidence.find((row: any) => row.id === firstEvidence.data.id).expired);
  assert.ok(
    details.data.blockers.includes(
      "EVIDENCE_VERSION_CONFLICT:OPERATING_ENTITY:TEST_REGISTRATION",
    ),
  );
  assert.ok(
    details.data.blockers.includes(
      "EVIDENCE_EXPIRED:OPERATING_ENTITY:TEST_REGISTRATION",
    ),
  );
  assert.ok(details.data.blockers.includes("REQUIRED_LEGAL_ENTITY_NOT_ACTIVE"));
  assert.ok(
    details.data.blockers.includes(
      "POLICY_VERSION_NOT_PUBLISHED:OPERATING_ENTITY:TEST_POLICY",
    ),
  );

  const badReference = await request(
    "/admin/compliance/country-readiness/JO/evidence",
    "POST",
    {
      ...firstEvidenceBody,
      idempotencyKey: `D16-country-${runId}-bad-ref`,
      referenceCode: "https://example.invalid/private?token=secret",
    },
    ordinaryAdmin,
  );
  assert.equal(badReference.status, 400);
  const rejectedDocumentPayload = await request(
    "/admin/compliance/country-readiness/JO/evidence",
    "POST",
    {
      ...firstEvidenceBody,
      idempotencyKey: `D16-country-${runId}-unexpected-file`,
      documentContents: "synthetic payload must not be accepted",
    },
    ordinaryAdmin,
  );
  assert.equal(rejectedDocumentPayload.status, 400);

  const incompleteCounselReview = await request(
    "/admin/compliance/country-readiness/JO/counsel-review",
    "POST",
    { referenceCode: `D16-COUNSEL-REVIEW-${runId}` },
    counsel,
  );
  assert.equal(incompleteCounselReview.status, 409);
  const blockedPackage = await request(
    "/admin/compliance/country-readiness/JO",
    "GET",
    undefined,
    ordinaryAdmin,
  );
  assert.equal(blockedPackage.data.intake.reviewStatus, "BLOCKED");

  const ordinaryAdminCannotForgeCounselApproval = await request(
    "/admin/compliance/country-readiness/JO/counsel-approval",
    "POST",
    { referenceCode: `D16-FORGED-COUNSEL-${runId}` },
    ordinaryAdmin,
  );
  assert.equal(ordinaryAdminCannotForgeCounselApproval.status, 403);

  // Simulate a completed review record in this disposable database only. The live route cannot
  // perform this transition; the signature endpoint must still fail closed independently.
  await db
    .update(marketLegalIntakes)
    .set({
      reviewStatus: "COUNSEL_REVIEWED",
      counselReviewedBy: counsel.id,
      counselReviewedAt: new Date(),
      counselReviewReference: `FIXTURE-COUNSEL-REVIEW-${runId}`,
    })
    .where(eq(marketLegalIntakes.marketId, "JO"));
  const missingSignature = await request(
    "/admin/compliance/country-readiness/JO/counsel-approval",
    "POST",
    { referenceCode: `D16-COUNSEL-APPROVAL-${runId}` },
    counselApprover,
  );
  assert.equal(missingSignature.status, 409);
  assert.match(missingSignature.text, /COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE/u);

  const ownerAttempts = await Promise.all([
    request(
      "/admin/compliance/country-readiness/JO/owner-approval",
      "POST",
      { referenceCode: `D16-OWNER-APPROVAL-A-${runId}` },
      owner,
    ),
    request(
      "/admin/compliance/country-readiness/JO/owner-approval",
      "POST",
      { referenceCode: `D16-OWNER-APPROVAL-B-${runId}` },
      owner,
    ),
  ]);
  assert.ok(ownerAttempts.every((attempt) => attempt.status === 409));
  const technicalResult = await request(
    "/admin/compliance/country-readiness/JO/technical-verification",
    "POST",
    { referenceCode: `D16-TECHNICAL-ATTESTATION-${runId}` },
    technical,
  );
  assert.equal(technicalResult.status, 409);
  const activationResult = await request(
    "/admin/compliance/country-readiness/JO/activate",
    "POST",
    { referenceCode: `D16-COUNTRY-ACTIVATION-${runId}` },
    activator,
  );
  assert.equal(activationResult.status, 409);

  const finalState = await request(
    "/admin/compliance/country-readiness/JO",
    "GET",
    undefined,
    ordinaryAdmin,
  );
  assert.equal(finalState.data.intake.activationStatus, "DISABLED");
  assert.equal(finalState.data.intake.counselApprovalStatus, "BLOCKED");
  assert.equal(finalState.data.intake.ownerApprovalStatus, "BLOCKED");
  assert.equal(finalState.data.intake.technicalVerificationStatus, "NOT_RUN");
  assert.ok(finalState.data.events.some((event: any) => event.eventType === "OWNER_APPROVAL_BLOCKED"));
  assert.ok(finalState.data.events.some((event: any) => event.eventType === "TECHNICAL_VERIFICATION_BLOCKED"));
  await verifyCountryAdminBrowser(ordinaryAdmin.cookie, nonAdmin.cookie);
  await assert.rejects(
    db
      .delete(marketLegalIntakeEvents)
      .where(eq(marketLegalIntakeEvents.intakeId, finalState.data.intake.id)),
    (error: unknown) => nestedSqlState(error) === "55000",
  );
  const evidenceRows = await db
    .select()
    .from(marketLegalEvidence)
    .where(eq(marketLegalEvidence.intakeId, finalState.data.intake.id));
  assert.equal(evidenceRows.length, 2);
});

await test("D16 incident response is authenticated, staged, and append-only", async () => {
  const [market] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, DEFAULT_MARKET));
  assert.ok(market);
  const [incident] = await db
    .select({ id: securityIncidentEvents.id })
    .from(securityIncidentEvents)
    .limit(1);
  assert.equal(incident, undefined);

  const deniedCreate = await request(
    "/admin/security/incidents",
    "POST",
    {
      category: "PRIVACY",
      severity: "HIGH",
      summary: `Synthetic D16 test ${runId}`,
      affectedSystems: ["api-server"],
    },
    nonAdmin,
  );
  assert.equal(deniedCreate.status, 403);

  const rejectedReference = await request(
    "/admin/security/incidents",
    "POST",
    {
      category: "PRIVACY",
      severity: "HIGH",
      summary: `Synthetic D16 invalid reference ${runId}`,
      evidenceReference: "https://example.invalid/token?secret=x",
    },
    ordinaryAdmin,
  );
  assert.equal(rejectedReference.status, 400);

  const opened = await request(
    "/admin/security/incidents",
    "POST",
    {
      category: "PRIVACY",
      severity: "HIGH",
      summary: `Synthetic D16 test ${runId}`,
      affectedSystems: ["api-server"],
      evidenceReference: `D16-EVIDENCE-${runId}`,
    },
    ordinaryAdmin,
  );
  assert.equal(opened.status, 201, opened.text);
  const incidentId = opened.data.id as string;
  const incidentPath = `/admin/security/incidents/${incidentId}/transition`;

  const prematureClose = await request(
    incidentPath,
    "POST",
    {
      action: "CLOSE_WITH_POSTMORTEM",
      summary: "Must not close before containment and recovery",
    },
    ordinaryAdmin,
  );
  assert.equal(prematureClose.status, 409, prematureClose.text);

  process.env.DINAR_DEPLOYMENT_ENV = "development";
  const transition = async (
    body: Record<string, unknown>,
    actor: Actor = ordinaryAdmin,
  ) => {
    const result = await request(incidentPath, "POST", body, actor);
    assert.equal(result.status, 200, result.text);
    return result.data;
  };
  await transition({ action: "REQUEST_COUNSEL_REVIEW" });
  const counselReview = await transition(
    {
      action: "RECORD_COUNSEL_REVIEW",
      reference: `D16-INCIDENT-COUNSEL-${runId}`,
    },
    counsel,
  );
  assert.equal(counselReview.counselAssessment, "REVIEWED");
  await transition({
    action: "RECORD_CONTAINMENT",
    summary: "Synthetic containment step recorded",
    reference: `D16-CONTAINMENT-${runId}`,
  });
  await transition({
    action: "RECORD_RECOVERY",
    summary: "Synthetic recovery step recorded",
  });
  await transition({
    action: "CLOSE_WITH_POSTMORTEM",
    summary: "Synthetic post-incident review recorded",
  });

  const detail = await request(
    `/admin/security/incidents/${incidentId}`,
    "GET",
    undefined,
    ordinaryAdmin,
  );
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.data.incident.status, "CLOSED");
  assert.equal(detail.data.events.length, 6);
  await assert.rejects(
    db
      .delete(securityIncidentEvents)
      .where(eq(securityIncidentEvents.incidentId, incidentId)),
    (error: unknown) => nestedSqlState(error) === "55000",
  );
  await assert.rejects(
    createSecurityIncident({
      actorId: ordinaryAdmin.id,
      category: "SECURITY",
      severity: "LOW",
      summary: "Bad reference is rejected",
      affectedSystems: [],
      evidenceReference: "https://example.invalid/token?secret=x",
    }),
    (error: any) => error.code === "REFERENCE_INVALID",
  );
});

await test("country suspension blocks new commerce but preserves existing order history", async () => {
  process.env.DINAR_DEPLOYMENT_ENV = "development";
  const seller = await register(`D16 seller ${runId}`);
  const buyer = await register(`D16 buyer ${runId}`);
  const listing = await request(
    "/listings",
    "POST",
    {
      title: `D16 suspension fixture ${runId}`,
      description: `Disposable order-history fixture ${runId}`,
      category: "أخرى",
      categoryId: "other",
      area: "الصويفية",
      city: "عمّان",
      attributes: {},
      unitPrice: "10",
      pricingMode: "FIXED",
      inventoryMode: "LIMITED",
      availableQuantity: 2,
      fulfilmentType: "PICKUP",
      imageUrl: "",
      imageUrls: [],
      clientRequestId: randomUUID(),
    },
    seller,
  );
  assert.equal(listing.status, 201, listing.text);
  const order = await request(
    "/orders",
    "POST",
    {
      listingId: listing.data.id,
      quantity: 1,
      fulfilmentType: "PICKUP",
      idempotencyKey: `D16-existing-order-${runId}`,
    },
    buyer,
  );
  assert.equal(order.status, 201, order.text);
  const beforeSuspend = await request(`/orders/${order.data.id}`, "GET", undefined, buyer);
  assert.equal(beforeSuspend.status, 200, beforeSuspend.text);

  process.env.DINAR_DEPLOYMENT_ENV = "production";
  const suspended = await request(
    "/admin/compliance/country-readiness/JO/suspend",
    "POST",
    { referenceCode: `D16-SUSPENSION-${runId}` },
    ordinaryAdmin,
  );
  assert.equal(suspended.status, 200, suspended.text);
  assert.equal(suspended.data.activationStatus, "SUSPENDED");

  const newOrder = await request(
    "/orders",
    "POST",
    {
      listingId: listing.data.id,
      quantity: 1,
      fulfilmentType: "PICKUP",
      idempotencyKey: `D16-new-order-after-suspension-${runId}`,
    },
    buyer,
  );
  assert.equal(newOrder.status, 409, newOrder.text);
  const historyAfterSuspend = await request(`/orders/${order.data.id}`, "GET", undefined, buyer);
  assert.equal(historyAfterSuspend.status, 200, historyAfterSuspend.text);
  assert.equal(historyAfterSuspend.data.id, order.data.id);
});

after(async () => {
  if (previousDeployment === undefined) delete process.env.DINAR_DEPLOYMENT_ENV;
  else process.env.DINAR_DEPLOYMENT_ENV = previousDeployment;
  if (previousCounselIds === undefined) delete process.env.DINAR_COUNSEL_REVIEWER_IDS;
  else process.env.DINAR_COUNSEL_REVIEWER_IDS = previousCounselIds;
  if (previousCounselApproverIds === undefined) delete process.env.DINAR_COUNSEL_APPROVER_IDS;
  else process.env.DINAR_COUNSEL_APPROVER_IDS = previousCounselApproverIds;
  if (previousOwnerIds === undefined) delete process.env.DINAR_LEGAL_OWNER_IDS;
  else process.env.DINAR_LEGAL_OWNER_IDS = previousOwnerIds;
  if (previousTechnicalVerifierIds === undefined)
    delete process.env.DINAR_LEGAL_TECHNICAL_VERIFIER_IDS;
  else process.env.DINAR_LEGAL_TECHNICAL_VERIFIER_IDS = previousTechnicalVerifierIds;
  if (previousTechnicalActivatorIds === undefined)
    delete process.env.DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS;
  else process.env.DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS = previousTechnicalActivatorIds;
  await browserTestWeb?.stop();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});
