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
 * Contract version 2 (integration): explicit business ↔ listing links (offers.business_profile_id,
 * migration 0047) so one owner can run several businesses. Additive changes keep the version.
 */
import { and, eq, inArray } from "drizzle-orm";
import { businessMemberships, businessProfiles, businessSubscriptions, db, offers } from "@workspace/db";

export const BUSINESS_CATALOG_CONTRACT_VERSION = 2 as const;

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
 * Business ↔ listing association, version 2: EXPLICIT. A listing belongs to a business only when
 * offers.business_profile_id names it (same owner and market, enforced by service and DB trigger).
 * Compatibility: an owner with exactly one open business keeps the v1 meaning for listings not
 * linked to any business (they count as that business's catalog) until they link them.
 */
export async function businessListingAssociation(businessId: string) {
  const identity = await businessIdentity(businessId);
  if (!identity) return undefined;
  const open = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(and(eq(businessProfiles.ownerUserId, identity.ownerUserId), eq(businessProfiles.marketId, identity.marketId), inArray(businessProfiles.verificationStatus, ["DRAFT", "DOCUMENTS_REQUIRED", "PENDING_REVIEW", "VERIFIED", "SUSPENDED"])));
  const soleBusiness = open.length === 1 && open[0]!.id === businessId;
  const rows = await db
    .select({ id: offers.id, status: offers.status, businessProfileId: offers.businessProfileId })
    .from(offers)
    .where(and(eq(offers.sellerId, identity.ownerUserId), eq(offers.marketId, identity.marketId), inArray(offers.status, ["DRAFT", "PUBLISHED", "PAUSED", "SOLD_OUT"])));
  const mine = rows.filter((row) => row.businessProfileId === businessId || (soleBusiness && row.businessProfileId === null));
  return {
    mode: "EXPLICIT" as const,
    implicitUnlinked: soleBusiness,
    businessId,
    ownerUserId: identity.ownerUserId,
    marketId: identity.marketId,
    listingIds: mine.map((row) => row.id),
    linkedListingIds: mine.filter((row) => row.businessProfileId === businessId).map((row) => row.id),
    publishedListingIds: mine.filter((row) => row.status === "PUBLISHED").map((row) => row.id),
    showAsBusiness: publicationEligibility(identity).catalogAsBusiness,
  };
}

const refuse = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

/**
 * Links (or unlinks, businessId = null) one of the owner's listings to one of the owner's
 * businesses in the same market. Strangers get 404 for both. REJECTED businesses take no
 * listings; DRAFT ones may (preparation), but nothing is shown as the business until VERIFIED.
 */
export async function assignListingToBusiness(input: { actorId: string; marketId: string; listingId: string; businessId: string | null; unlinkFrom?: string }) {
  return db.transaction(async (tx) => {
    const [listing] = await tx.select({ id: offers.id, sellerId: offers.sellerId, marketId: offers.marketId, businessProfileId: offers.businessProfileId }).from(offers).where(eq(offers.id, input.listingId)).for("update");
    if (!listing || listing.sellerId !== input.actorId || listing.marketId !== input.marketId) throw refuse(404, "الإعلان غير موجود", "LISTING_NOT_FOUND");
    if (!input.businessId && input.unlinkFrom && listing.businessProfileId !== input.unlinkFrom) throw refuse(409, "الإعلان غير مرتبط بهذا النشاط", "LISTING_NOT_LINKED");
    if (input.businessId) {
      const [business] = await tx.select().from(businessProfiles).where(eq(businessProfiles.id, input.businessId));
      if (!business || business.ownerUserId !== input.actorId || business.marketId !== listing.marketId) throw refuse(404, "النشاط التجاري غير موجود", "BUSINESS_NOT_FOUND");
      if (business.verificationStatus === "REJECTED") throw refuse(409, "لا يمكن ربط إعلان بطلب مرفوض", "BUSINESS_REJECTED");
    }
    await tx.update(offers).set({ businessProfileId: input.businessId }).where(eq(offers.id, listing.id));
    return { listingId: listing.id, businessId: input.businessId };
  });
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
