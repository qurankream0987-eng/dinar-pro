import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  marketLegalIntakes,
  markets,
  pool,
  users,
} from "@workspace/db";
import { hashPassword, normalizePhone, verifyPassword } from "../src/lib/auth";
import { COUNTRY_LEGAL_TOPICS } from "../src/lib/country-legal-readiness";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import {
  applySyntheticExternalCountryVerification,
  assertSyntheticCountryLegalFixtureEnvironment,
} from "./isolation/synthetic-country-legal-fixture";

requireSafeReplitDevelopmentDatabase("BDINAR_MARKET_LEGAL_ACCEPTANCE");
assertSyntheticCountryLegalFixtureEnvironment();
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
process.env.DINAR_DEPLOYMENT_ENV = "development";

// The adjacent W02U3 and D15 acceptance journeys use Jordanian test accounts.
const TEST_MARKET = "JO";
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const runId = randomUUID().slice(0, 10);
const password = `local-only-${randomUUID()}-fixture`;
let actorSequence = 0;
const phonePlans: Record<
  string,
  { countryCode: string; nationalPrefix: string; suffixDigits: number }
> = {
  JO: { countryCode: "+962", nationalPrefix: "79", suffixDigits: 7 },
  KW: { countryCode: "+965", nationalPrefix: "5000000", suffixDigits: 1 },
  SA: { countryCode: "+966", nationalPrefix: "5", suffixDigits: 8 },
};
const phonePlan = phonePlans[TEST_MARKET];
if (!phonePlan) throw new Error(`No isolated phone fixture plan for ${TEST_MARKET}.`);
const currencyCodeByMarket: Record<string, string> = {
  JO: "JOD",
  KW: "KWD",
  SA: "SAR",
};
const currencyCode = currencyCodeByMarket[TEST_MARKET];
if (!currencyCode) throw new Error(`No isolated currency fixture for ${TEST_MARKET}.`);

type Actor = { id: string; role: "ADMIN" | "USER"; cookie: string };

async function createActor(
  name: string,
  role: Actor["role"],
  passwordHash: string,
): Promise<Actor> {
  actorSequence += 1;
  const suffix = actorSequence.toString().padStart(phonePlan.suffixDigits, "0");
  const nationalPhone = `${phonePlan.nationalPrefix}${suffix}`;
  const id = `test_country_legal_${randomUUID()}`;
  await db.insert(users).values({
    id,
    displayName: name,
    phoneCountryCode: phonePlan.countryCode,
    phoneNumber: nationalPhone,
    normalizedPhone: `${phonePlan.countryCode}${nationalPhone}`,
    accountCountry: TEST_MARKET,
    activeMarketId: TEST_MARKET,
    passwordHash,
    phoneVerified: true,
    role,
  });
  const normalizedPhone = normalizePhone(phonePlan.countryCode, nationalPhone)
    .normalizedPhone;
  assert.equal(normalizedPhone, `${phonePlan.countryCode}${nationalPhone}`);
  assert.equal(await verifyPassword(password, passwordHash), true);

  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-forwarded-for": `198.51.100.${actorSequence}`,
    },
    body: JSON.stringify({
      phoneCountryCode: phonePlan.countryCode,
      phoneNumber: nationalPhone,
      password,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("bdinar_session="))
    ?.split(";")[0];
  assert.ok(cookie, "login must issue a normal DINAR session");
  const body = JSON.parse(text);
  assert.equal(body.user.id, id);
  assert.equal(body.user.role, role);
  return { id, role, cookie };
}

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
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

const marketConfiguration = {
  status: "ACTIVE",
  fulfilmentMethods: ["PICKUP", "DELIVERY", "SERVICE"],
  paymentMethods: ["CASH_DIRECT"],
  restrictedCategories: [],
  sellerEligibilityMode: "OPEN",
};

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

await test("isolated legal stages unlock only the synthetic market through normal APIs", async () => {
  const databaseName = assertSyntheticCountryLegalFixtureEnvironment();
  assert.match(databaseName, /^dinar_test_legal_/u);

  const startingMarkets = await db
    .select({ id: markets.id, status: markets.status, isActive: markets.isActive })
    .from(markets);
  const neighborMarketId = startingMarkets.find(
    (market) => market.id !== TEST_MARKET,
  )?.id;
  assert.ok(neighborMarketId, "the disposable database must include an inactive neighbor market");
  assert.equal(startingMarkets.length, 249);
  assert.ok(startingMarkets.every((market) => !market.isActive));
  assert.ok(
    startingMarkets.every(
      (market) => market.status !== "ACTIVE" && market.status !== "LIMITED",
    ),
  );

  const startingIntakes = await db.select().from(marketLegalIntakes);
  assert.ok(startingIntakes.length >= 3);
  assert.ok(startingIntakes.every((intake) => intake.activationStatus === "DISABLED"));
  assert.ok(startingIntakes.every((intake) => intake.counselApprovalStatus === "BLOCKED"));

  const passwordHash = await hashPassword(password);
  // Auth has no public role-management API by design. These synthetic identities are inserted
  // only in this guarded, disposable database; each obtains its session through /auth/login.
  const actors = {
    marketAdmin: await createActor(`Legal test market admin ${runId}`, "ADMIN", passwordHash),
    intakeAdmin: await createActor(`Legal test intake admin ${runId}`, "ADMIN", passwordHash),
    reviewer: await createActor(`Legal test counsel reviewer ${runId}`, "ADMIN", passwordHash),
    counselApprover: await createActor(`Legal test counsel approver ${runId}`, "ADMIN", passwordHash),
    owner: await createActor(`Legal test owner ${runId}`, "ADMIN", passwordHash),
    technicalVerifier: await createActor(`Legal test technical verifier ${runId}`, "ADMIN", passwordHash),
    technicalActivator: await createActor(`Legal test technical activator ${runId}`, "ADMIN", passwordHash),
    ordinaryUser: await createActor(`Legal test ordinary user ${runId}`, "USER", passwordHash),
  };
  const separatedRoleIds = [
    actors.reviewer.id,
    actors.counselApprover.id,
    actors.owner.id,
    actors.technicalVerifier.id,
    actors.technicalActivator.id,
    actors.marketAdmin.id,
    actors.intakeAdmin.id,
  ];
  assert.equal(new Set(separatedRoleIds).size, separatedRoleIds.length);

  process.env.DINAR_COUNSEL_REVIEWER_IDS = actors.reviewer.id;
  process.env.DINAR_COUNSEL_APPROVER_IDS = actors.counselApprover.id;
  process.env.DINAR_LEGAL_OWNER_IDS = actors.owner.id;
  process.env.DINAR_LEGAL_TECHNICAL_VERIFIER_IDS = actors.technicalVerifier.id;
  process.env.DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS = actors.technicalActivator.id;

  assert.throws(
    () =>
      assertSyntheticCountryLegalFixtureEnvironment({
        ...process.env,
        DINAR_DEPLOYMENT_ENV: "production",
      }),
    /unavailable in deployed or production environments/u,
  );
  assert.throws(
    () =>
      assertSyntheticCountryLegalFixtureEnvironment({
        ...process.env,
        REPLIT_DEPLOYMENT: "true",
      }),
    /unavailable in deployed or production environments/u,
  );

  process.env.DINAR_DEPLOYMENT_ENV = "production";
  const unapprovedMarketActivation = await request(
    `/admin/markets/${TEST_MARKET}`,
    "PATCH",
    marketConfiguration,
    actors.marketAdmin,
  );
  assert.equal(unapprovedMarketActivation.status, 409, unapprovedMarketActivation.text);
  assert.equal(unapprovedMarketActivation.data.code, "COUNTRY_INTAKE_NOT_ACTIVE");
  const unapprovedCountryActivation = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/activate`,
    "POST",
    { referenceCode: `TEST-ONLY-${TEST_MARKET}-ACTIVATE-${runId}` },
    actors.technicalActivator,
  );
  assert.equal(unapprovedCountryActivation.status, 409);

  const activeBeforeReview = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.isActive, true));
  assert.deepEqual(activeBeforeReview, []);

  process.env.DINAR_DEPLOYMENT_ENV = "development";
  const nonAdminRead = await request(
    "/admin/compliance/country-readiness",
    "GET",
    undefined,
    actors.ordinaryUser,
  );
  assert.equal(nonAdminRead.status, 403);

  const reviewRequest = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/review-request`,
    "POST",
    {},
    actors.intakeAdmin,
  );
  assert.equal(reviewRequest.status, 202, reviewRequest.text);

  const topicInput = {
    disposition: "NOT_APPLICABLE",
    counselFinding:
      "TEST-ONLY synthetic acceptance fixture; not legal advice or a real market approval.",
    officialReference: "TEST-ONLY-NO-LEGAL-CONCLUSION",
    evidenceRequirementStatus: "NO_REQUIREMENTS",
    requiredEvidenceTypes: [],
    policyRequirementStatus: "NO_POLICY_REQUIREMENT",
    requiredPolicyVersions: [],
  };
  const deniedTopicReview = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/topics/OPERATING_ENTITY/review`,
    "POST",
    topicInput,
    actors.intakeAdmin,
  );
  assert.equal(deniedTopicReview.status, 403);

  for (const [topicKey] of COUNTRY_LEGAL_TOPICS) {
    const topicReview = await request(
      `/admin/compliance/country-readiness/${TEST_MARKET}/topics/${topicKey}/review`,
      "POST",
      topicInput,
      actors.reviewer,
    );
    assert.equal(topicReview.status, 200, `${topicKey}: ${topicReview.text}`);
    assert.equal(topicReview.data.reviewStatus, "COUNSEL_REVIEWED");
  }

  const counselReview = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/counsel-review`,
    "POST",
    { referenceCode: `TEST-ONLY-COUNSEL-REVIEW-${runId}` },
    actors.reviewer,
  );
  assert.equal(counselReview.status, 200, counselReview.text);
  assert.equal(counselReview.data.reviewStatus, "COUNSEL_REVIEWED");

  const unavailableCounselSignature = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/counsel-approval`,
    "POST",
    { referenceCode: `TEST-ONLY-COUNSEL-SIGNATURE-${runId}` },
    actors.counselApprover,
  );
  assert.equal(unavailableCounselSignature.status, 409);
  assert.match(unavailableCounselSignature.text, /COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE/u);

  const unavailableTechnicalAttestation = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/technical-verification`,
    "POST",
    { referenceCode: `TEST-ONLY-TECHNICAL-ATTESTATION-${runId}` },
    actors.technicalVerifier,
  );
  assert.equal(unavailableTechnicalAttestation.status, 409);
  assert.match(unavailableTechnicalAttestation.text, /TECHNICAL_ATTESTATION_UNAVAILABLE/u);

  const externalVerification = await applySyntheticExternalCountryVerification({
    marketId: TEST_MARKET,
    reviewerId: actors.reviewer.id,
    counselApproverId: actors.counselApprover.id,
    ownerId: actors.owner.id,
    technicalVerifierId: actors.technicalVerifier.id,
    technicalActivatorId: actors.technicalActivator.id,
    referenceSuffix: runId,
  });
  assert.equal(externalVerification.counselApprovalStatus, "APPROVED");
  assert.equal(externalVerification.technicalVerificationStatus, "PASSED");
  assert.equal(externalVerification.ownerApprovalStatus, "BLOCKED");
  assert.equal(externalVerification.activationStatus, "DISABLED");

  const ownerApproval = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/owner-approval`,
    "POST",
    { referenceCode: `TEST-ONLY-OWNER-APPROVAL-${runId}` },
    actors.owner,
  );
  assert.equal(ownerApproval.status, 204, ownerApproval.text);

  process.env.DINAR_DEPLOYMENT_ENV = "production";
  const unapprovedNeighborActivation = await request(
    `/admin/markets/${neighborMarketId}`,
    "PATCH",
    marketConfiguration,
    actors.marketAdmin,
  );
  assert.equal(unapprovedNeighborActivation.status, 409);
  assert.equal(unapprovedNeighborActivation.data.code, "COUNTRY_INTAKE_NOT_ACTIVE");

  const price = await request(
    `/admin/markets/${TEST_MARKET}/prices`,
    "POST",
    { currencyCode, unitPriceMinor: 100 },
    actors.marketAdmin,
  );
  assert.ok(price.status === 200 || price.status === 201, price.text);

  const legalActivation = await request(
    `/admin/compliance/country-readiness/${TEST_MARKET}/activate`,
    "POST",
    { referenceCode: `TEST-ONLY-COUNTRY-ACTIVATION-${TEST_MARKET}-${runId}` },
    actors.technicalActivator,
  );
  assert.equal(legalActivation.status, 204, legalActivation.text);

  const marketActivation = await request(
    `/admin/markets/${TEST_MARKET}`,
    "PATCH",
    marketConfiguration,
    actors.marketAdmin,
  );
  assert.equal(marketActivation.status, 200, marketActivation.text);
  assert.equal(marketActivation.data.isActive, true);

  const activeMarkets = await db
    .select({ id: markets.id, isActive: markets.isActive })
    .from(markets)
    .where(eq(markets.isActive, true));
  assert.deepEqual(activeMarkets.map((market) => market.id), [TEST_MARKET]);

  const [approvedIntake] = await db
    .select()
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.marketId, TEST_MARKET));
  assert.equal(approvedIntake!.counselReviewedBy, actors.reviewer.id);
  assert.equal(approvedIntake!.counselApprovedBy, actors.counselApprover.id);
  assert.equal(approvedIntake!.technicalVerifiedBy, actors.technicalVerifier.id);
  assert.equal(approvedIntake!.ownerApprovedBy, actors.owner.id);
  assert.equal(approvedIntake!.activatedBy, actors.technicalActivator.id);
  assert.equal(approvedIntake!.activationStatus, "ACTIVE");

  const unchangedNeighborIntakes = await db
    .select()
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.activationStatus, "DISABLED"));
  assert.ok(unchangedNeighborIntakes.length >= 2);
  assert.ok(
    unchangedNeighborIntakes.every(
      (intake) =>
        intake.marketId !== TEST_MARKET &&
        intake.counselApprovalStatus === "BLOCKED" &&
        intake.ownerApprovalStatus === "BLOCKED" &&
        intake.technicalVerificationStatus === "NOT_RUN",
    ),
  );

  const routes: string[] = [];
  const visit = (stack: any[]) => {
    for (const layer of stack ?? []) {
      if (layer.route?.path) routes.push(String(layer.route.path));
      if (layer.handle?.stack) visit(layer.handle.stack);
    }
  };
  visit((app as any).router?.stack ?? (app as any)._router?.stack);
  assert.ok(!routes.some((path) => /test-only|synthetic-legal/u.test(path)));
});
