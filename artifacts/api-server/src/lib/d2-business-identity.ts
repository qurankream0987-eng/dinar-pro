/**
 * D2 business identity integration port (Phase 01).
 *
 * D2 owns business identity and verification. Until D2 publishes its contract and schema, this
 * port reports PENDING_D2 in every real deployment and returns no identity; D3 then operates the
 * business honestly inside DINAR with applicant permissions only (profile/drafts, no publication).
 * A D2 identity is never fabricated, and D3 never writes a verification result.
 *
 * Tests inject isolated fixtures through `registerBusinessIdentityFixture`; that hook is hard
 * guarded by `BDINAR_D3A_D2_FIXTURES=development` and is not reachable in production paths.
 */
import {
  businessCapabilities,
  type BusinessCapability,
} from "./business-capabilities";

export const D2_BUSINESS_TYPES = ["RESTAURANT", "SHOP", "SERVICE_PROVIDER", "OTHER"] as const;
export type D2BusinessType = (typeof D2_BUSINESS_TYPES)[number];

export const D2_VERIFICATION_STATUSES = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED", "SUSPENDED"] as const;
export type D2VerificationStatus = (typeof D2_VERIFICATION_STATUSES)[number];

export const D2_PUBLICATION_ELIGIBILITY = ["ELIGIBLE", "BLOCKED"] as const;
export type D2PublicationEligibility = (typeof D2_PUBLICATION_ELIGIBILITY)[number];

export const D2_BUSINESS_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED", "CLOSED"] as const;
export type D2BusinessStatus = (typeof D2_BUSINESS_STATUSES)[number];

export type D2MembershipRole = "OWNER" | "STAFF";

export type D2BusinessMembership = {
  userId: string;
  role: D2MembershipRole;
  permissions: readonly BusinessCapability[];
};

/**
 * The canonical D2 identity shape D3 consumes. `membershipPermissions` are the D2-granted
 * permissions of the resolved actor; `memberships` is the D3 extension used to recognise staff.
 */
export type D2BusinessIdentity = {
  businessId: string;
  ownerUserId: string;
  marketId: string;
  businessType: D2BusinessType;
  verificationStatus: D2VerificationStatus;
  publicationEligibility: D2PublicationEligibility;
  membershipPermissions: readonly BusinessCapability[];
  businessStatus: D2BusinessStatus;
  policyVersion: string;
  memberships?: readonly D2BusinessMembership[];
};

export type D2ActorIdentity = {
  identity: D2BusinessIdentity;
  role: D2MembershipRole;
  /** The resolved actor's D2 permissions (owner: membershipPermissions; staff: membership entry). */
  permissions: BusinessCapability[];
};

export type D2PortStatus = "PENDING_D2" | "FIXTURE";

const fixtureMode = () => process.env.BDINAR_D3A_D2_FIXTURES === "development";

/** Key: marketId → businessIds; value: identity. Fixtures are process-local and test-only. */
const fixtures = new Map<string, D2BusinessIdentity>();

function identityValid(value: D2BusinessIdentity) {
  return (
    typeof value.businessId === "string" && value.businessId.length > 0 &&
    typeof value.ownerUserId === "string" && value.ownerUserId.length > 0 &&
    typeof value.marketId === "string" && value.marketId.length > 0 &&
    (D2_BUSINESS_TYPES as readonly string[]).includes(value.businessType) &&
    (D2_VERIFICATION_STATUSES as readonly string[]).includes(value.verificationStatus) &&
    (D2_PUBLICATION_ELIGIBILITY as readonly string[]).includes(value.publicationEligibility) &&
    (D2_BUSINESS_STATUSES as readonly string[]).includes(value.businessStatus) &&
    typeof value.policyVersion === "string"
  );
}

/**
 * Test-only fixture registration. Throws outside the disposable test harness: production code has
 * no path that can invent a D2 identity.
 */
export function registerBusinessIdentityFixture(identity: D2BusinessIdentity): void {
  if (!fixtureMode()) throw new Error("D2 fixtures are only available with BDINAR_D3A_D2_FIXTURES=development");
  if (!identityValid(identity)) throw new Error("Invalid D2 business identity fixture");
  fixtures.set(`${identity.marketId}:${identity.businessId}`, {
    ...identity,
    membershipPermissions: businessCapabilities(identity.membershipPermissions),
    memberships: identity.memberships?.map((member) => ({
      ...member,
      permissions: businessCapabilities(member.permissions),
    })),
  });
}

export function clearBusinessIdentityFixtures(): void {
  if (!fixtureMode()) return;
  fixtures.clear();
}

function forActorFixture(actorId: string, marketId: string): D2ActorIdentity | null {
  for (const identity of fixtures.values()) {
    if (identity.marketId !== marketId) continue;
    if (identity.ownerUserId === actorId)
      return {
        identity,
        role: "OWNER",
        permissions: businessCapabilities(identity.membershipPermissions),
      };
    const member = identity.memberships?.find((candidate) => candidate.userId === actorId);
    if (member)
      return {
        identity,
        role: "STAFF",
        permissions: businessCapabilities(member.permissions),
      };
  }
  return null;
}

export interface D2BusinessIdentityPort {
  status(): D2PortStatus;
  /** The D2 identity of the business this actor belongs to in this market, if any. */
  forActor(actorId: string, marketId: string): Promise<D2ActorIdentity | null>;
  /** The D2 identity behind one D3 operating profile's external reference. */
  forBusiness(businessId: string, marketId: string): Promise<D2BusinessIdentity | null>;
}

/**
 * Until D2 is published there is no identity service to call. Reporting PENDING_D2 is the
 * truthful answer; it is not an error and does not block INTERNAL_DINAR profile work.
 */
export const d2BusinessIdentity: D2BusinessIdentityPort = {
  status: () => (fixtureMode() ? "FIXTURE" : "PENDING_D2"),
  async forActor(actorId, marketId) {
    if (!fixtureMode()) return null;
    return forActorFixture(actorId, marketId);
  },
  async forBusiness(businessId, marketId) {
    if (!fixtureMode()) return null;
    return fixtures.get(`${marketId}:${businessId}`) ?? null;
  },
};

export const d2IntegrationStatus = () => d2BusinessIdentity.status();
