/**
 * D2 → Qoder native-business catalog: the stable, typed, read-only contract over DINAR Business
 * identity. Catalog work reads business state ONLY through this module; it never writes
 * business_profiles, business_memberships or business_verification_* (lib/business-profiles is the
 * single writer) and never infers verification from payment or from a subscription.
 *
 * Four separate facts, never merged:
 *   1. verification   — DRAFT … VERIFIED / REJECTED / SUSPENDED (reviewer authority only);
 *   2. publication    — UNPUBLISHED / PUBLISHED, only ever PUBLISHED while VERIFIED (DB CHECK);
 *   3. membership     — APPLICANT / VERIFIED_OWNER (ADMIN / STAFF defined, not grantable yet);
 *   4. paid plan      — a live DINAR_BUSINESS subscription linked to the business (billing authority).
 *
 * Contract version 1. Additive changes keep the version; any change of meaning bumps it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { businessMemberships, businessProfiles, businessSubscriptions, db, offers } from "@workspace/db";

export const BUSINESS_CATALOG_CONTRACT_VERSION = 1 as const;

export const BUSINESS_VERIFICATION_STATES = ["DRAFT", "DOCUMENTS_REQUIRED", "PENDING_REVIEW", "VERIFIED", "REJECTED", "SUSPENDED"] as const;
export type BusinessVerificationState = (typeof BUSINESS_VERIFICATION_STATES)[number];
export const BUSINESS_ROLES = ["APPLICANT", "VERIFIED_OWNER", "ADMIN", "STAFF"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** Who moves the verification state, and from where. The only writer is lib/business-profiles. */
export const BUSINESS_LIFECYCLE: ReadonlyArray<{ from: BusinessVerificationState | null; to: BusinessVerificationState; actor: "APPLICANT" | "REVIEWER" }> = [
  { from: null, to: "DRAFT", actor: "APPLICANT" },
  { from: "DRAFT", to: "DOCUMENTS_REQUIRED", actor: "APPLICANT" },
  { from: "DOCUMENTS_REQUIRED", to: "PENDING_REVIEW", actor: "APPLICANT" },
  { from: "PENDING_REVIEW", to: "VERIFIED", actor: "REVIEWER" },
  { from: "PENDING_REVIEW", to: "REJECTED", actor: "REVIEWER" },
  { from: "DOCUMENTS_REQUIRED", to: "REJECTED", actor: "REVIEWER" },
  { from: "PENDING_REVIEW", to: "DOCUMENTS_REQUIRED", actor: "REVIEWER" },
  { from: "VERIFIED", to: "SUSPENDED", actor: "REVIEWER" },
  { from: "SUSPENDED", to: "VERIFIED", actor: "REVIEWER" },
];

export type BusinessIdentity = {
  contractVersion: typeof BUSINESS_CATALOG_CONTRACT_VERSION;
  businessId: string;
  marketId: string;
  ownerUserId: string;
  displayName: string;
  categoryKey: string;
  verification: BusinessVerificationState;
  verified: boolean;
  suspended: boolean;
  published: boolean;
  verifiedAt: string | null;
  revision: number;
};

export type BusinessMembership = { businessId: string; userId: string; role: BusinessRole; active: boolean };

export const BUSINESS_CATALOG_ACTIONS = [
  "VIEW_PRIVATE",
  "EDIT_PROFILE",
  "PREPARE_CATALOG",
  "PUBLISH_CATALOG_AS_BUSINESS",
  "PUBLISH_PROFILE",
  "REQUEST_INTEGRATION",
  "SUBSCRIBE_BUSINESS_PLAN",
] as const;
export type BusinessCatalogAction = (typeof BUSINESS_CATALOG_ACTIONS)[number];
export type PermissionDecision = { allowed: boolean; reason: "OK" | "NOT_A_MEMBER" | "MEMBERSHIP_REVOKED" | "ROLE_NOT_GRANTABLE" | "NOT_VERIFIED" | "SUSPENDED" | "REJECTED" | "NOT_VERIFIED_OWNER" };

const deny = (reason: PermissionDecision["reason"]): PermissionDecision => ({ allowed: false, reason });

/**
 * Pure permission rule (no I/O): the catalog decides with this and nothing else.
 *  - private view / profile edits: the active applicant or verified owner (not REJECTED);
 *  - preparing catalog items: also allowed for drafts — as ordinary listings of the owner;
 *  - anything shown AS the business (publication, catalog "by business", integrations, Business plan):
 *    VERIFIED (not suspended) and the VERIFIED_OWNER membership.
 * ADMIN / STAFF memberships have no grant path in D2 and are denied until a later phase defines them.
 */
export function businessPermission(identity: BusinessIdentity, membership: BusinessMembership | undefined, action: BusinessCatalogAction): PermissionDecision {
  if (!membership || membership.businessId !== identity.businessId) return deny("NOT_A_MEMBER");
  if (!membership.active) return deny("MEMBERSHIP_REVOKED");
  if (membership.role === "ADMIN" || membership.role === "STAFF") return deny("ROLE_NOT_GRANTABLE");
  if (identity.verification === "REJECTED") return deny("REJECTED");
  if (action === "VIEW_PRIVATE" || action === "EDIT_PROFILE") return { allowed: true, reason: "OK" };
  if (action === "PREPARE_CATALOG") return identity.suspended ? deny("SUSPENDED") : { allowed: true, reason: "OK" };
  if (identity.suspended) return deny("SUSPENDED");
  if (!identity.verified) return deny("NOT_VERIFIED");
  if (membership.role !== "VERIFIED_OWNER") return deny("NOT_VERIFIED_OWNER");
  return { allowed: true, reason: "OK" };
}

/** Publication eligibility, from state only. A paid plan is not a condition, and never sufficient. */
export function publicationEligibility(identity: BusinessIdentity) {
  const reasons: string[] = [];
  if (identity.suspended) reasons.push("SUSPENDED");
  else if (!identity.verified) reasons.push("NOT_VERIFIED");
  return { profile: reasons.length === 0, catalogAsBusiness: reasons.length === 0, reasons, paidPlanRequired: false as const };
}

function identityOf(row: typeof businessProfiles.$inferSelect): BusinessIdentity {
  return {
    contractVersion: BUSINESS_CATALOG_CONTRACT_VERSION,
    businessId: row.id,
    marketId: row.marketId,
    ownerUserId: row.ownerUserId,
    displayName: row.displayName,
    categoryKey: row.categoryKey,
    verification: row.verificationStatus as BusinessVerificationState,
    verified: row.verificationStatus === "VERIFIED",
    suspended: row.verificationStatus === "SUSPENDED",
    published: row.publicationStatus === "PUBLISHED",
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

export async function businessIdentity(businessId: string): Promise<BusinessIdentity | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(businessId)) return undefined;
  const [row] = await db.select().from(businessProfiles).where(eq(businessProfiles.id, businessId));
  return row ? identityOf(row) : undefined;
}

export async function businessMembershipOf(userId: string, businessId: string): Promise<BusinessMembership | undefined> {
  const [row] = await db.select().from(businessMemberships).where(and(eq(businessMemberships.businessId, businessId), eq(businessMemberships.userId, userId)));
  return row ? { businessId: row.businessId, userId: row.userId, role: row.role as BusinessRole, active: row.status === "ACTIVE" } : undefined;
}

/** One call for the catalog: identity, the actor's membership and the decision for an action. */
export async function authorizeBusinessAction(userId: string, businessId: string, action: BusinessCatalogAction) {
  const identity = await businessIdentity(businessId);
  if (!identity) return { identity: undefined, decision: deny("NOT_A_MEMBER") };
  return { identity, decision: businessPermission(identity, await businessMembershipOf(userId, businessId), action) };
}

/**
 * Business ↔ listing association, version 1: IMPLICIT. A business's catalog is its owner's own
 * listings in the business's market (the canonical listing and inventory services, no copy).
 * There is no business_id on offers yet; adding one (and which listings belong to which of several
 * businesses of one owner) is the catalog phase's decision and a new migration.
 */
export async function businessListingAssociation(businessId: string) {
  const identity = await businessIdentity(businessId);
  if (!identity) return undefined;
  const rows = await db
    .select({ id: offers.id, status: offers.status })
    .from(offers)
    .where(and(eq(offers.sellerId, identity.ownerUserId), eq(offers.marketId, identity.marketId), inArray(offers.status, ["DRAFT", "PUBLISHED", "PAUSED", "SOLD_OUT"])));
  return {
    mode: "OWNER_MARKET_IMPLICIT" as const,
    businessId,
    ownerUserId: identity.ownerUserId,
    marketId: identity.marketId,
    listingIds: rows.map((row) => row.id),
    publishedListingIds: rows.filter((row) => row.status === "PUBLISHED").map((row) => row.id),
    showAsBusiness: publicationEligibility(identity).catalogAsBusiness,
  };
}

/** The paid-plan fact, kept apart: a live DINAR_BUSINESS subscription linked to this business. */
export async function businessPlanStatus(businessId: string) {
  const rows = await db
    .select({ status: businessSubscriptions.status, periodEnd: businessSubscriptions.currentPeriodEnd })
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.businessProfileId, businessId), eq(businessSubscriptions.planCodeSnapshot, "DINAR_BUSINESS")));
  const live = rows.find((row) => ["ACTIVE", "CANCEL_AT_PERIOD_END"].includes(row.status) && row.periodEnd && row.periodEnd.getTime() > Date.now());
  return { paid: Boolean(live), status: live?.status ?? (rows.length ? "NOT_LIVE" : "NONE"), grantsOnlyWhileVerified: true as const };
}
