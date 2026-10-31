/**
 * D2 business identity adapter.
 *
 * Business identity, ownership, verification and publication are read from the canonical D2
 * tables. D3 contributes only operating metadata and never creates or fabricates identity state.
 * Staff access has no grant path here.
 */
import { and, eq } from "drizzle-orm";
import {
  businessMemberships,
  businessProfiles,
  db,
} from "@workspace/db";
import {
  businessCapabilities,
  type BusinessCapability,
} from "./business-capabilities";

export const D2_BUSINESS_TYPES = ["RESTAURANT", "SHOP", "SERVICE_PROVIDER", "OTHER"] as const;
export type D2BusinessType = (typeof D2_BUSINESS_TYPES)[number];

export const D2_VERIFICATION_STATUSES = [
  "DRAFT",
  "DOCUMENTS_REQUIRED",
  "PENDING_REVIEW",
  "VERIFIED",
  "REJECTED",
  "SUSPENDED",
] as const;
export type D2VerificationStatus = (typeof D2_VERIFICATION_STATUSES)[number];

export const D2_PUBLICATION_ELIGIBILITY = ["ELIGIBLE", "BLOCKED"] as const;
export type D2PublicationEligibility = (typeof D2_PUBLICATION_ELIGIBILITY)[number];

export const D2_BUSINESS_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED", "CLOSED"] as const;
export type D2BusinessStatus = (typeof D2_BUSINESS_STATUSES)[number];
export type D2MembershipRole = "OWNER";

export type D2BusinessIdentity = {
  businessId: string;
  ownerUserId: string;
  marketId: string;
  displayName?: string;
  description?: string;
  categoryKey?: string;
  revision?: number;
  businessType: D2BusinessType;
  verificationStatus: D2VerificationStatus;
  publicationEligibility: D2PublicationEligibility;
  membershipPermissions: readonly BusinessCapability[];
  businessStatus: D2BusinessStatus;
  policyVersion: string;
};

export type D2ActorIdentity = {
  identity: D2BusinessIdentity;
  role: D2MembershipRole;
  permissions: BusinessCapability[];
};

export type D2PortStatus = "CONNECTED" | "FIXTURE";

const fixtures = new Map<string, D2BusinessIdentity>();
const fixtureMode = () => process.env.BDINAR_D3A_D2_FIXTURES === "development";

export function registerBusinessIdentityFixture(identity: D2BusinessIdentity): void {
  if (!fixtureMode()) throw new Error("D2 fixtures are restricted to the development acceptance suite");
  if (!identity.businessId || !identity.ownerUserId || !identity.marketId)
    throw new Error("Invalid D2 business identity fixture");
  fixtures.set(`${identity.marketId}:${identity.businessId}`, {
    ...identity,
    membershipPermissions: businessCapabilities(identity.membershipPermissions ?? []),
  });
}

export function clearBusinessIdentityFixtures(): void {
  if (fixtureMode()) fixtures.clear();
}

const businessTypeForCategory = (key: string): D2BusinessType => {
  if (["RESTAURANT", "GRILL_RESTAURANT", "CAFE", "BAKERY"].includes(key)) return "RESTAURANT";
  if (["RETAIL", "FASHION", "ELECTRONICS", "GROCERY", "BEAUTY", "AUTOMOTIVE"].includes(key)) return "SHOP";
  if (["HOME_SERVICES", "SERVICES"].includes(key)) return "SERVICE_PROVIDER";
  return "OTHER";
};

function identityFromRow(row: typeof businessProfiles.$inferSelect): D2BusinessIdentity {
  const verificationStatus = row.verificationStatus as D2VerificationStatus;
  const verified = verificationStatus === "VERIFIED";
  const suspended = verificationStatus === "SUSPENDED";
  const rejected = verificationStatus === "REJECTED";
  return {
    businessId: row.id,
    ownerUserId: row.ownerUserId,
    marketId: row.marketId,
    displayName: row.displayName,
    description: row.description,
    categoryKey: row.categoryKey,
    revision: row.revision,
    businessType: businessTypeForCategory(row.categoryKey),
    verificationStatus,
    publicationEligibility: verified && row.publicationStatus === "PUBLISHED" ? "ELIGIBLE" : "BLOCKED",
    // D3 derives owner capabilities from this canonical owner relationship and verification state.
    // D2 does not grant staff permissions to this integration.
    membershipPermissions: [],
    businessStatus: suspended ? "SUSPENDED" : rejected ? "CLOSED" : verified ? "ACTIVE" : "DRAFT",
    policyVersion: "D2_BUSINESS_PROFILE_V1",
  };
}

export interface D2BusinessIdentityPort {
  status(): D2PortStatus;
  forActor(actorId: string, marketId: string): Promise<D2ActorIdentity | null>;
  forBusiness(businessId: string, marketId: string): Promise<D2BusinessIdentity | null>;
  forBusinessActor(businessId: string, actorId: string, marketId: string): Promise<D2ActorIdentity | null>;
}

export const d2BusinessIdentity: D2BusinessIdentityPort = {
  status: () => fixtureMode() ? "FIXTURE" : "CONNECTED",
  async forBusiness(businessId, marketId) {
    if (fixtureMode()) {
      const fixture = fixtures.get(`${marketId}:${businessId}`);
      if (fixture) return fixture;
    }
    const [row] = await db
      .select()
      .from(businessProfiles)
      .where(and(eq(businessProfiles.id, businessId), eq(businessProfiles.marketId, marketId)))
      .limit(1);
    return row ? identityFromRow(row) : null;
  },
  async forBusinessActor(businessId, actorId, marketId) {
    const identity = await this.forBusiness(businessId, marketId);
    if (!identity || identity.ownerUserId !== actorId) return null;
    if (fixtureMode() && fixtures.has(`${marketId}:${businessId}`))
      return { identity, role: "OWNER", permissions: businessCapabilities(identity.membershipPermissions ?? []) };
    const [membership] = await db
      .select({ role: businessMemberships.role, status: businessMemberships.status })
      .from(businessMemberships)
      .where(and(
        eq(businessMemberships.businessId, businessId),
        eq(businessMemberships.userId, actorId),
      ))
      .limit(1);
    if (!membership || membership.status !== "ACTIVE" || !["APPLICANT", "VERIFIED_OWNER"].includes(membership.role))
      return null;
    return { identity, role: "OWNER", permissions: businessCapabilities([]) };
  },
  async forActor(actorId, marketId) {
    if (fixtureMode()) {
      const fixture = [...fixtures.values()].find((identity) =>
        identity.marketId === marketId && identity.ownerUserId === actorId,
      );
      if (fixture) return { identity: fixture, role: "OWNER", permissions: businessCapabilities(fixture.membershipPermissions ?? []) };
    }
    const rows = await db
      .select({ id: businessProfiles.id })
      .from(businessProfiles)
      .innerJoin(
        businessMemberships,
        and(
          eq(businessMemberships.businessId, businessProfiles.id),
          eq(businessMemberships.userId, actorId),
          eq(businessMemberships.status, "ACTIVE"),
        ),
      )
      .where(and(
        eq(businessProfiles.ownerUserId, actorId),
        eq(businessProfiles.marketId, marketId),
      ))
      .limit(2);
    if (rows.length !== 1) return null;
    return this.forBusinessActor(rows[0]!.id, actorId, marketId);
  },
};

export const d2IntegrationStatus = () => d2BusinessIdentity.status();
