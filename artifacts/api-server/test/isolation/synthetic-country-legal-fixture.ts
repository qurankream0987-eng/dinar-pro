import { eq } from "drizzle-orm";
import {
  db,
  marketLegalIntakes,
  markets,
  users,
} from "@workspace/db";

type FixtureEnvironment = Record<string, string | undefined>;

export function assertSyntheticCountryLegalFixtureEnvironment(
  env: FixtureEnvironment = process.env,
) {
  if (
    env.NODE_ENV !== "development" ||
    (env.DINAR_DEPLOYMENT_ENV !== undefined &&
      env.DINAR_DEPLOYMENT_ENV !== "development") ||
    env.REPLIT_DEPLOYMENT !== undefined
  ) {
    throw new Error(
      "Synthetic country-legal fixtures are unavailable in deployed or production environments.",
    );
  }
  if (
    env.BDINAR_MARKET_LEGAL_ACCEPTANCE !== "development" ||
    env.BDINAR_DISPOSABLE_ACCEPTANCE_DB !== "1" ||
    env.BDINAR_DISPOSABLE_TEST_DATABASE !== "1" ||
    env.DINAR_MARKET_LEGAL_TEST_FIXTURE !== "1"
  ) {
    throw new Error(
      "Synthetic country-legal fixtures require explicit acceptance authorization and disposable-database guards.",
    );
  }
  if (!env.DATABASE_URL || env.DATABASE_URL !== env.DINAR_DEV_DATABASE_URL) {
    throw new Error(
      "Synthetic country-legal fixtures require the same explicit test URL for DATABASE_URL and DINAR_DEV_DATABASE_URL.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("Synthetic country-legal fixture database URL is invalid.");
  }
  if (
    !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
    !/^dinar_test_legal_[a-z0-9_]+$/iu.test(parsed.pathname.slice(1))
  ) {
    throw new Error(
      "Synthetic country-legal fixtures require a dinar_test_legal_* loopback database.",
    );
  }
  return parsed.pathname.slice(1);
}

/**
 * Mimics only the unavailable external signature and technical-certificate verifiers.
 * This file is test-only, is excluded from Docker images, and refuses all non-disposable
 * or deployment-marked environments. All other review, role, owner, activation, and market
 * configuration transitions must still pass through the authenticated application routes.
 */
export async function applySyntheticExternalCountryVerification(input: {
  marketId: string;
  reviewerId: string;
  counselApproverId: string;
  ownerId: string;
  technicalVerifierId: string;
  technicalActivatorId: string;
  referenceSuffix: string;
}) {
  assertSyntheticCountryLegalFixtureEnvironment();
  const actorIds = [
    input.reviewerId,
    input.counselApproverId,
    input.ownerId,
    input.technicalVerifierId,
    input.technicalActivatorId,
  ];
  if (new Set(actorIds).size !== actorIds.length) {
    throw new Error("Synthetic legal fixture requires separate role identities.");
  }

  const actorRows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.role, "ADMIN"));
  const adminIds = new Set(actorRows.map((row) => row.id));
  if (actorIds.some((id) => !adminIds.has(id))) {
    throw new Error("Every synthetic legal role must resolve to an isolated admin identity.");
  }

  const marketRows = await db
    .select({ id: markets.id, status: markets.status, isActive: markets.isActive })
    .from(markets);
  if (
    marketRows.some(
      (market) =>
        market.isActive || market.status === "ACTIVE" || market.status === "LIMITED",
    )
  ) {
    throw new Error(
      "Synthetic legal approval refused because a market is already active in the test database.",
    );
  }

  const otherIntakes = await db
    .select()
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.activationStatus, "ACTIVE"));
  if (otherIntakes.length !== 0) {
    throw new Error(
      "Synthetic legal approval refused because another intake is already active.",
    );
  }

  return db.transaction(async (tx) => {
    const [market] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, input.marketId))
      .for("update")
      .limit(1);
    if (
      !market ||
      market.isActive ||
      market.status === "ACTIVE" ||
      market.status === "LIMITED"
    ) {
      throw new Error("Synthetic test market is missing or already active.");
    }

    const [intake] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.marketId, input.marketId))
      .for("update")
      .limit(1);
    if (
      !intake ||
      intake.reviewStatus !== "COUNSEL_REVIEWED" ||
      intake.counselReviewedBy !== input.reviewerId ||
      intake.counselApprovalStatus !== "BLOCKED" ||
      intake.ownerApprovalStatus !== "BLOCKED" ||
      intake.technicalVerificationStatus !== "NOT_RUN" ||
      intake.activationStatus !== "DISABLED"
    ) {
      throw new Error(
        "Synthetic external verification can only follow the real API review stage on an inactive market.",
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(marketLegalIntakes)
      .set({
        counselApprovalStatus: "APPROVED",
        counselApprovalBlocker: "TEST_ONLY_SYNTHETIC_EXTERNAL_SIGNATURE",
        counselApprovedBy: input.counselApproverId,
        counselApprovedAt: now,
        counselApprovalReference: `TEST-ONLY-COUNSEL-${input.referenceSuffix}`,
        technicalVerificationStatus: "PASSED",
        technicalVerifiedBy: input.technicalVerifierId,
        technicalVerifiedAt: now,
        technicalVerificationReference: `TEST-ONLY-TECHNICAL-${input.referenceSuffix}`,
        updatedAt: now,
      })
      .where(eq(marketLegalIntakes.id, intake.id))
      .returning();
    return updated;
  });
}
