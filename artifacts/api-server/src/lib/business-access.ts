/**
 * Server-side business authorization. Every business read and mutation resolves the actor here,
 * from trusted rows plus the D2 port; nothing in a request, a message or a model reply grants a
 * capability. Catalog services call this again inside their transaction before writing.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { businessAuditEvents, businessOperatingProfiles, db } from "@workspace/db";
import {
  BUSINESS_CAPABILITIES,
  PUBLICATION_CAPABILITIES,
  businessCapabilities,
  type BusinessCapability,
} from "./business-capabilities";
import {
  d2BusinessIdentity,
  type D2BusinessIdentity,
  type D2PublicationEligibility,
  type D2VerificationStatus,
} from "./d2-business-identity";

export type BusinessProfile = typeof businessOperatingProfiles.$inferSelect & {
  identityStatus?: D2VerificationStatus | "PENDING_D2";
  d2Revision?: number | null;
};
export type BusinessActorClass = "APPLICANT" | "VERIFIED_OWNER" | "STAFF" | "NONE";

export type BusinessAccess = {
  business: BusinessProfile;
  actorClass: BusinessActorClass;
  role: "OWNER" | "STAFF" | "NONE";
  capabilities: Set<BusinessCapability>;
  identity: D2BusinessIdentity | null;
  verificationStatus: D2VerificationStatus | "PENDING_D2";
  publicationEligibility: D2PublicationEligibility | "PENDING_D2";
  businessStatus: "DRAFT" | "ACTIVE" | "SUSPENDED" | "CLOSED";
  policyVersion: string;
  verified: boolean;
  publishable: boolean;
};

export const APPLICANT_CAPABILITIES: readonly BusinessCapability[] = [
  "business.read",
  "business.profile.manage",
  "business.catalog.read",
  "business.catalog.draft",
  "business.orders.read",
  "business.analytics.read",
];

export const NO_ACCESS: BusinessAccess = {
  business: null as unknown as BusinessProfile,
  actorClass: "NONE",
  role: "NONE",
  capabilities: new Set(),
  identity: null,
  verificationStatus: "PENDING_D2",
  publicationEligibility: "PENDING_D2",
  businessStatus: "DRAFT",
  policyVersion: "PENDING_D2",
  verified: false,
  publishable: false,
};

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export async function resolveBusinessAccess(input: {
  business: BusinessProfile;
  actorId: string;
  marketId: string;
}): Promise<BusinessAccess> {
  const { business, actorId, marketId } = input;
  if (business.marketId !== marketId) return { ...NO_ACCESS, business };
  const isOwner = business.ownerUserId === actorId;
  // A closed business is not operable by anyone through D3; its owner may still read it.
  if (business.status === "CLOSED")
    return {
      ...NO_ACCESS,
      business,
      role: isOwner ? "OWNER" : "NONE",
      actorClass: isOwner ? "APPLICANT" : "NONE",
      capabilities: new Set(isOwner ? ["business.read"] : []),
    };

  if (!business.d2BusinessId || !isOwner) return { ...NO_ACCESS, business };
  const resolved = await d2BusinessIdentity.forBusinessActor(
    business.d2BusinessId,
    actorId,
    marketId,
  );
  if (!resolved) return { ...NO_ACCESS, business };
  const identity = resolved.identity;
  // Fail closed on any disagreement between D2 and the D3 profile.
  if (
    identity.marketId !== marketId ||
    identity.ownerUserId !== business.ownerUserId ||
    (business.d2BusinessId !== null && business.d2BusinessId !== identity.businessId)
  )
    return { ...NO_ACCESS, business, identity };

  // D2 currently has no staff grant path. Do not infer STAFF from a D3 operating row.
  if (resolved.role !== "OWNER" || identity.ownerUserId !== actorId)
    return { ...NO_ACCESS, business, identity };
  const role = "OWNER";
  const suspended =
    identity.businessStatus === "SUSPENDED" ||
    identity.businessStatus === "CLOSED" ||
    identity.verificationStatus === "SUSPENDED" ||
    business.status === "SUSPENDED";
  const verified = identity.verificationStatus === "VERIFIED";
  const eligible = identity.publicationEligibility === "ELIGIBLE";
  const granted = businessCapabilities(resolved.permissions);

  let capabilities: Set<BusinessCapability>;
  if (suspended) {
    capabilities = new Set(
      role === "OWNER"
        ? ["business.read"]
        : granted.includes("business.catalog.read")
          ? ["business.catalog.read"]
          : [],
    );
  } else if (!verified) {
    capabilities = new Set(
      role === "OWNER"
        ? APPLICANT_CAPABILITIES
        : granted.filter((capability) => capability === "business.catalog.read" || capability === "business.orders.read"),
    );
  } else if (role === "OWNER") {
    capabilities = new Set(BUSINESS_CAPABILITIES);
  } else {
    capabilities = new Set(granted);
  }
  if (!eligible) for (const capability of PUBLICATION_CAPABILITIES) capabilities.delete(capability);

  return {
    business,
    actorClass: verified ? "VERIFIED_OWNER" : "APPLICANT",
    role,
    capabilities,
    identity,
    verificationStatus: identity.verificationStatus,
    publicationEligibility: identity.publicationEligibility,
    businessStatus: identity.businessStatus,
    policyVersion: identity.policyVersion,
    verified,
    publishable: verified && eligible && identity.businessStatus === "ACTIVE" && business.status === "ACTIVE",
  };
}

/** Resolves one of the actor's own businesses by id; another account's business is a 404. */
export async function ownedBusinessForActor(input: {
  businessId: string;
  actorId: string;
  marketId: string;
}): Promise<BusinessProfile | undefined> {
  const [row] = await db
    .select()
    .from(businessOperatingProfiles)
    .where(and(
      eq(businessOperatingProfiles.id, input.businessId),
      eq(businessOperatingProfiles.ownerUserId, input.actorId),
      eq(businessOperatingProfiles.marketId, input.marketId),
    ))
    .limit(1);
  return row ? businessWithD2Identity(row) : undefined;
}

/** Adds the current D2 state for display; the persisted D3 row is never its source. */
export async function businessWithD2Identity(
  business: typeof businessOperatingProfiles.$inferSelect,
): Promise<BusinessProfile & {
  identityStatus: D2VerificationStatus | "PENDING_D2";
  d2Revision: number | null;
}> {
  const identity = business.d2BusinessId
    ? await d2BusinessIdentity.forBusiness(business.d2BusinessId, business.marketId)
    : null;
  return {
    ...business,
    ...(identity ? {
      ownerUserId: identity.ownerUserId,
      marketId: identity.marketId,
      displayName: identity.displayName ?? business.displayName,
      businessType: identity.businessType,
      description: identity.description ?? business.description,
    } : {}),
    identityStatus: identity?.verificationStatus ?? "PENDING_D2",
    d2Revision: identity?.revision ?? null,
  };
}

export async function requireBusinessCapability(input: {
  business: BusinessProfile;
  actorId: string;
  marketId: string;
  capability: BusinessCapability;
}): Promise<BusinessAccess> {
  const access = await resolveBusinessAccess(input);
  if (access.actorClass === "NONE") throw fail(404, "النشاط غير موجود");
  if (!access.capabilities.has(input.capability))
    throw fail(403, "لا تملك صلاحية تنفيذ هذا الإجراء على هذا النشاط");
  return access;
}

/** Verified identity and publication eligibility are both required; drafts never substitute. */
export function assertPublishable(access: BusinessAccess) {
  if (access.publishable) return;
  if (access.verificationStatus === "PENDING_D2")
    throw fail(
      409,
      "نشر منتجات النشاط ينتظر اعتماد هوية النشاط التجاري في DINAR. يمكنك إعداد المسودات الآن؛ لن يُنشر شيء قبل الاعتماد.",
      "BUSINESS_IDENTITY_PENDING_D2",
    );
  if (access.verificationStatus !== "VERIFIED")
    throw fail(
      409,
      "لا يمكن نشر منتجات النشاط قبل التحقق من هويته التجارية. المسودات محفوظة ولا تُنشر تلقائيًا.",
      "BUSINESS_NOT_VERIFIED",
    );
  if (access.publicationEligibility !== "ELIGIBLE")
    throw fail(409, "نشر هذا النشاط موقوف من جهة اعتماد الهوية التجارية؛ راجع حالتك قبل إعادة المحاولة.", "BUSINESS_NOT_ELIGIBLE");
  throw fail(409, "النشاط غير نشط حاليًا؛ لا يمكن نشر منتجات جديدة.", "BUSINESS_NOT_ACTIVE");
}

export function recordBusinessAudit(input: {
  businessId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
  executor?: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;
}) {
  const executor = input.executor ?? db;
  return executor.insert(businessAuditEvents).values({
    id: randomUUID(),
    businessId: input.businessId,
    actorId: input.actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    detail: input.detail ?? {},
  });
}
