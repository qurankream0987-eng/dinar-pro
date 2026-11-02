import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import {
  businessAuditEvents,
  businessDelegations,
  businessMemberships,
  businessOperatingProfiles,
  businessProfiles,
  db,
  offers,
  users,
} from "@workspace/db";
import { z } from "zod";

const POLICY_VERSION = "D4_READ_ONLY_V1";
const MAX_GRANT_DAYS = 90;
const MAX_CATALOG_ROWS = 100;
const DELEGATABLE_CAPABILITIES = ["business.catalog.read"] as const;
const OWNER_APPROVAL_CAPABILITIES = [
  "business.catalog.draft",
  "business.catalog.publish",
  "business.listing.update",
  "business.inventory.manage",
  "business.orders.read",
  "business.analytics.read",
  "business.profile.manage",
] as const;

const capabilitySchema = z.enum(DELEGATABLE_CAPABILITIES);
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BUSINESS") }).strict(),
  z.object({
    kind: z.literal("LISTING_ALLOWLIST"),
    listingIds: z.array(z.string().uuid()).min(1).max(MAX_CATALOG_ROWS),
  }).strict(),
]);

export const createBusinessDelegationSchema = z.object({
  employee: z.discriminatedUnion("type", [
    z.object({ type: z.literal("HUMAN"), userId: z.string().uuid() }).strict(),
    z.object({ type: z.literal("INTELLIGENT") }).strict(),
  ]),
  capabilities: z.array(capabilitySchema).min(1).max(DELEGATABLE_CAPABILITIES.length),
  resourceScope: scopeSchema,
  expiresAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().min(8).max(120),
}).strict().superRefine((input, context) => {
  if (new Set(input.capabilities).size !== input.capabilities.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "Duplicate capabilities are not allowed" });
  }
});

const confirmationSchema = z.object({
  confirm: z.literal(true),
  expectedVersion: z.number().int().positive(),
}).strict();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DelegationScope = z.infer<typeof scopeSchema>;
type Principal =
  | { type: "HUMAN"; userId: string }
  | { type: "INTELLIGENT"; configurationId: string };

const fail = (status: number, message: string, code: string) =>
  Object.assign(new Error(message), { status, code });

function publicDelegation(row: typeof businessDelegations.$inferSelect) {
  return {
    id: row.id,
    businessId: row.businessId,
    marketId: row.marketId,
    employee: row.employeeType === "HUMAN"
      ? { type: "HUMAN" as const, userId: row.employeeUserId }
      : { type: "INTELLIGENT" as const, configurationId: row.agentConfigurationId },
    capabilities: row.capabilities,
    resourceScope: row.resourceScope,
    approvalRequiredCapabilities: row.approvalRequiredCapabilities,
    status: row.status,
    policyVersion: row.policyVersion,
    version: row.version,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    expiredAt: row.expiredAt,
  };
}

async function recordDelegationAudit(
  tx: Tx,
  input: {
    businessId: string;
    actorId: string;
    action: string;
    delegationId: string;
    detail?: Record<string, unknown>;
  },
) {
  await tx.insert(businessAuditEvents).values({
    id: randomUUID(),
    businessId: input.businessId,
    actorId: input.actorId,
    action: input.action,
    resourceType: "DELEGATION",
    resourceId: input.delegationId,
    detail: { policyVersion: POLICY_VERSION, ...(input.detail ?? {}) },
  });
}

/**
 * Lock and verify the established D2 owner and D3 operating rows. D4 never creates a parallel
 * business identity; grants are rejected if the canonical owner relationship has drifted.
 */
async function lockOwnedBusiness(
  tx: Tx,
  input: { businessId: string; actorId: string; marketId: string },
) {
  const [business] = await tx
    .select()
    .from(businessOperatingProfiles)
    .where(and(
      eq(businessOperatingProfiles.id, input.businessId),
      eq(businessOperatingProfiles.ownerUserId, input.actorId),
      eq(businessOperatingProfiles.marketId, input.marketId),
    ))
    .for("update")
    .limit(1);
  if (!business) throw fail(404, "النشاط غير موجود", "BUSINESS_NOT_FOUND");

  const [identity] = await tx
    .select()
    .from(businessProfiles)
    .where(and(
      eq(businessProfiles.id, business.d2BusinessId),
      eq(businessProfiles.ownerUserId, input.actorId),
      eq(businessProfiles.marketId, input.marketId),
    ))
    .for("share")
    .limit(1);
  if (!identity || ["SUSPENDED", "REJECTED"].includes(identity.verificationStatus))
    throw fail(404, "النشاط غير موجود", "BUSINESS_NOT_FOUND");

  const [ownerMembership] = await tx
    .select()
    .from(businessMemberships)
    .where(and(
      eq(businessMemberships.businessId, identity.id),
      eq(businessMemberships.userId, input.actorId),
      eq(businessMemberships.status, "ACTIVE"),
      inArray(businessMemberships.role, ["APPLICANT", "VERIFIED_OWNER"]),
    ))
    .for("share")
    .limit(1);
  if (!ownerMembership || business.status === "SUSPENDED" || business.status === "CLOSED")
    throw fail(404, "النشاط غير موجود", "BUSINESS_NOT_FOUND");

  return { business, identity };
}

function sameDelegationRequest(
  existing: typeof businessDelegations.$inferSelect,
  input: z.infer<typeof createBusinessDelegationSchema>,
  employeeUserId: string | null,
  configurationId: string | null,
  expiresAt: Date,
) {
  const scope = existing.resourceScope as DelegationScope;
  return existing.employeeType === input.employee.type &&
    existing.employeeUserId === employeeUserId &&
    existing.agentConfigurationId === configurationId &&
    JSON.stringify(existing.capabilities) === JSON.stringify([...input.capabilities].sort()) &&
    JSON.stringify(scope) === JSON.stringify(input.resourceScope) &&
    existing.expiresAt.getTime() === expiresAt.getTime();
}

export async function createBusinessDelegation(input: {
  actorId: string;
  marketId: string;
  businessId: string;
  body: unknown;
}) {
  const body = createBusinessDelegationSchema.parse(input.body);
  const expiresAt = new Date(body.expiresAt);
  const now = new Date();
  if (!Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime() + 5 * 60_000 ||
      expiresAt.getTime() > now.getTime() + MAX_GRANT_DAYS * 24 * 60 * 60_000) {
    throw fail(400, "مدة التفويض يجب أن تكون من خمس دقائق إلى 90 يومًا", "DELEGATION_EXPIRY_INVALID");
  }

  return db.transaction(async (tx) => {
    const { business, identity } = await lockOwnedBusiness(tx, input);
    const employeeUserId = body.employee.type === "HUMAN" ? body.employee.userId : null;
    const configurationId = body.employee.type === "INTELLIGENT" ? randomUUID() : null;

    if (employeeUserId) {
      if (employeeUserId === input.actorId) throw fail(400, "لا يمكن تفويض المالك لنفسه", "DELEGATION_EMPLOYEE_INVALID");
      const [employee] = await tx.select().from(users).where(eq(users.id, employeeUserId)).for("share").limit(1);
      if (!employee || employee.status !== "ACTIVE")
        throw fail(400, "حساب الموظف غير متاح", "DELEGATION_EMPLOYEE_INVALID");
    }

    if (body.resourceScope.kind === "LISTING_ALLOWLIST") {
      const matching = await tx
        .select({ id: offers.id })
        .from(offers)
        .where(and(
          eq(offers.businessProfileId, identity.id),
          eq(offers.marketId, input.marketId),
          eq(offers.status, "PUBLISHED"),
          inArray(offers.id, body.resourceScope.listingIds),
        ));
      if (matching.length !== body.resourceScope.listingIds.length)
        throw fail(400, "نطاق المنتجات يتضمن منتجًا غير منشور أو خارج هذا النشاط", "DELEGATION_SCOPE_INVALID");
    }

    const [existing] = await tx
      .select()
      .from(businessDelegations)
      .where(and(
        eq(businessDelegations.businessId, input.businessId),
        eq(businessDelegations.grantorActorId, input.actorId),
        eq(businessDelegations.idempotencyKey, body.idempotencyKey),
      ))
      .for("share")
      .limit(1);
    if (existing) {
      if (!sameDelegationRequest(existing, body, employeeUserId, existing.agentConfigurationId, expiresAt))
        throw fail(409, "مفتاح الطلب استُخدم لتفويض مختلف", "DELEGATION_IDEMPOTENCY_CONFLICT");
      return { created: false, delegation: publicDelegation(existing) };
    }

    const [row] = await tx
      .insert(businessDelegations)
      .values({
        id: randomUUID(),
        businessId: input.businessId,
        marketId: input.marketId,
        grantorActorId: input.actorId,
        employeeType: body.employee.type,
        employeeUserId,
        agentConfigurationId: configurationId,
        capabilities: [...body.capabilities].sort(),
        resourceScope: body.resourceScope,
        approvalRequiredCapabilities: [...OWNER_APPROVAL_CAPABILITIES],
        status: "DRAFT",
        policyVersion: POLICY_VERSION,
        idempotencyKey: body.idempotencyKey,
        version: 1,
        expiresAt,
      })
      .returning();
    await recordDelegationAudit(tx, {
      businessId: input.businessId,
      actorId: input.actorId,
      action: "DELEGATION_CREATED",
      delegationId: row!.id,
      detail: { employeeType: row!.employeeType, capabilities: row!.capabilities, scopeKind: body.resourceScope.kind },
    });
    return { created: true, delegation: publicDelegation(row!) };
  });
}

async function setStaffMembership(
  tx: Tx,
  input: { businessIdentityId: string; userId: string; grantorId: string; active: boolean },
) {
  const [membership] = await tx
    .select()
    .from(businessMemberships)
    .where(and(
      eq(businessMemberships.businessId, input.businessIdentityId),
      eq(businessMemberships.userId, input.userId),
    ))
    .for("update")
    .limit(1);
  const status = input.active ? "ACTIVE" : "REVOKED";
  if (membership) {
    if (["APPLICANT", "VERIFIED_OWNER", "ADMIN"].includes(membership.role))
      throw fail(409, "لا يمكن منح دور الموظف على عضوية ذات دور أعلى", "DELEGATION_MEMBERSHIP_CONFLICT");
    await tx.update(businessMemberships)
      .set({ role: "STAFF", status, grantedBy: input.active ? input.grantorId : membership.grantedBy, updatedAt: new Date() })
      .where(eq(businessMemberships.id, membership.id));
  } else if (input.active) {
    await tx.insert(businessMemberships).values({
      id: randomUUID(),
      businessId: input.businessIdentityId,
      userId: input.userId,
      role: "STAFF",
      status: "ACTIVE",
      grantedBy: input.grantorId,
    });
  }
}

async function hasOtherActiveHumanGrant(
  tx: Tx,
  input: { delegationId: string; businessId: string; userId: string },
) {
  const [other] = await tx
    .select({ id: businessDelegations.id })
    .from(businessDelegations)
    .where(and(
      eq(businessDelegations.businessId, input.businessId),
      eq(businessDelegations.employeeType, "HUMAN"),
      eq(businessDelegations.employeeUserId, input.userId),
      eq(businessDelegations.status, "ACTIVE"),
      ne(businessDelegations.id, input.delegationId),
    ))
    .limit(1);
  return Boolean(other);
}

async function mutateDelegation(input: {
  actorId: string;
  marketId: string;
  businessId: string;
  delegationId: string;
  body: unknown;
  action: "ACTIVATE" | "SUSPEND" | "RESUME" | "REVOKE";
}) {
  const body = confirmationSchema.parse(input.body);
  return db.transaction(async (tx) => {
    const { identity } = await lockOwnedBusiness(tx, input);
    const [row] = await tx
      .select()
      .from(businessDelegations)
      .where(and(
        eq(businessDelegations.id, input.delegationId),
        eq(businessDelegations.businessId, input.businessId),
        eq(businessDelegations.grantorActorId, input.actorId),
        eq(businessDelegations.marketId, input.marketId),
      ))
      .for("update")
      .limit(1);
    if (!row) throw fail(404, "التفويض غير موجود", "DELEGATION_NOT_FOUND");
    if (row.version !== body.expectedVersion)
      throw fail(409, "تغير التفويض؛ حدّث الصفحة ثم أعد التأكيد", "DELEGATION_VERSION_CONFLICT");

    const now = new Date();
    let status: typeof row.status;
    let action: string;
    if (input.action === "ACTIVATE") {
      if (row.status !== "DRAFT" || row.expiresAt <= now)
        throw fail(409, "لا يمكن تفعيل هذا التفويض", "DELEGATION_TRANSITION_INVALID");
      if (row.employeeType === "HUMAN" && row.employeeUserId) {
        const [employee] = await tx.select().from(users).where(eq(users.id, row.employeeUserId)).for("share").limit(1);
        if (!employee || employee.status !== "ACTIVE")
          throw fail(409, "حساب الموظف غير متاح", "DELEGATION_EMPLOYEE_INVALID");
        await setStaffMembership(tx, {
          businessIdentityId: identity.id,
          userId: row.employeeUserId,
          grantorId: input.actorId,
          active: true,
        });
      }
      status = "ACTIVE";
      action = "DELEGATION_ACTIVATED";
    } else if (input.action === "SUSPEND") {
      if (row.status !== "ACTIVE") throw fail(409, "لا يمكن إيقاف هذا التفويض", "DELEGATION_TRANSITION_INVALID");
      status = "SUSPENDED";
      action = "DELEGATION_SUSPENDED";
    } else if (input.action === "RESUME") {
      if (row.status !== "SUSPENDED" || row.expiresAt <= now)
        throw fail(409, "لا يمكن استئناف هذا التفويض", "DELEGATION_TRANSITION_INVALID");
      if (row.employeeType === "HUMAN" && row.employeeUserId) {
        const [employee] = await tx.select().from(users).where(eq(users.id, row.employeeUserId)).for("share").limit(1);
        if (!employee || employee.status !== "ACTIVE")
          throw fail(409, "حساب الموظف غير متاح", "DELEGATION_EMPLOYEE_INVALID");
        await setStaffMembership(tx, {
          businessIdentityId: identity.id,
          userId: row.employeeUserId,
          grantorId: input.actorId,
          active: true,
        });
      }
      status = "ACTIVE";
      action = "DELEGATION_RESUMED";
    } else {
      if (["REVOKED", "EXPIRED"].includes(row.status))
        throw fail(409, "هذا التفويض منتهٍ بالفعل", "DELEGATION_TRANSITION_INVALID");
      status = "REVOKED";
      action = "DELEGATION_REVOKED";
    }

    const [updated] = await tx
      .update(businessDelegations)
      .set({
        status,
        ...(input.action === "ACTIVATE" ? { activatedAt: now } : {}),
        ...(input.action === "REVOKE" ? { revokedAt: now } : {}),
        version: row.version + 1,
        updatedAt: now,
      })
      .where(and(
        eq(businessDelegations.id, row.id),
        eq(businessDelegations.version, body.expectedVersion),
      ))
      .returning();
    if (!updated) throw fail(409, "تغير التفويض؛ حدّث الصفحة ثم أعد التأكيد", "DELEGATION_VERSION_CONFLICT");

    if (row.employeeType === "HUMAN" && row.employeeUserId && status !== "ACTIVE" &&
        !(await hasOtherActiveHumanGrant(tx, { delegationId: row.id, businessId: row.businessId, userId: row.employeeUserId }))) {
      await setStaffMembership(tx, {
        businessIdentityId: identity.id,
        userId: row.employeeUserId,
        grantorId: input.actorId,
        active: false,
      });
    }

    await recordDelegationAudit(tx, {
      businessId: input.businessId,
      actorId: input.actorId,
      action,
      delegationId: row.id,
      detail: { previousVersion: row.version, version: updated.version },
    });
    return publicDelegation(updated);
  });
}

type DelegationMutationInput = Omit<Parameters<typeof mutateDelegation>[0], "action">;

export async function activateBusinessDelegation(input: DelegationMutationInput) {
  return mutateDelegation({ ...input, action: "ACTIVATE" });
}

export async function suspendBusinessDelegation(input: DelegationMutationInput) {
  return mutateDelegation({ ...input, action: "SUSPEND" });
}

export async function resumeBusinessDelegation(input: DelegationMutationInput) {
  return mutateDelegation({ ...input, action: "RESUME" });
}

export async function revokeBusinessDelegation(input: DelegationMutationInput) {
  return mutateDelegation({ ...input, action: "REVOKE" });
}

export async function listBusinessDelegations(input: {
  actorId: string;
  marketId: string;
  businessId: string;
}) {
  return db.transaction(async (tx) => {
    await lockOwnedBusiness(tx, input);
    const rows = await tx
      .select()
      .from(businessDelegations)
      .where(and(
        eq(businessDelegations.businessId, input.businessId),
        eq(businessDelegations.grantorActorId, input.actorId),
        eq(businessDelegations.marketId, input.marketId),
      ))
      .orderBy(asc(businessDelegations.createdAt), asc(businessDelegations.id));
    return { delegations: rows.map(publicDelegation), policyVersion: POLICY_VERSION };
  });
}

async function expireGrantIfNeeded(
  tx: Tx,
  row: typeof businessDelegations.$inferSelect,
  identityBusinessId: string,
  actorId: string,
) {
  const now = new Date();
  if (row.status !== "ACTIVE" || row.expiresAt > now) return row;
  const [expired] = await tx
    .update(businessDelegations)
    .set({ status: "EXPIRED", expiredAt: now, version: row.version + 1, updatedAt: now })
    .where(and(
      eq(businessDelegations.id, row.id),
      eq(businessDelegations.status, "ACTIVE"),
      lte(businessDelegations.expiresAt, now),
      eq(businessDelegations.version, row.version),
    ))
    .returning();
  if (!expired) return row;
  if (expired.employeeType === "HUMAN" && expired.employeeUserId &&
      !(await hasOtherActiveHumanGrant(tx, {
        delegationId: expired.id,
        businessId: expired.businessId,
        userId: expired.employeeUserId,
      }))) {
    await setStaffMembership(tx, {
      businessIdentityId: identityBusinessId,
      userId: expired.employeeUserId,
      grantorId: expired.grantorActorId,
      active: false,
    });
  }
  await recordDelegationAudit(tx, {
    businessId: expired.businessId,
    actorId,
    action: "DELEGATION_EXPIRED",
    delegationId: expired.id,
    detail: { version: expired.version },
  });
  return expired;
}

/**
 * The principal is supplied by trusted server code, never by a model-selected tool argument.
 * The public HTTP route constructs only the HUMAN form from the authenticated session.
 */
export async function delegatedBusinessCatalog(input: {
  delegationId: string;
  marketId: string;
  principal: Principal;
}) {
  const result = await db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(businessDelegations)
      .where(eq(businessDelegations.id, input.delegationId))
      .limit(1);
    if (!initial || initial.marketId !== input.marketId)
      throw fail(404, "التفويض غير موجود", "DELEGATION_NOT_FOUND");

    const [business] = await tx
      .select()
      .from(businessOperatingProfiles)
      .where(and(
        eq(businessOperatingProfiles.id, initial.businessId),
        eq(businessOperatingProfiles.marketId, input.marketId),
      ))
      .for("share")
      .limit(1);
    if (!business) throw fail(404, "التفويض غير موجود", "DELEGATION_NOT_FOUND");

    const [row] = await tx
      .select()
      .from(businessDelegations)
      .where(and(
        eq(businessDelegations.id, input.delegationId),
        eq(businessDelegations.businessId, business.id),
        eq(businessDelegations.marketId, input.marketId),
      ))
      .for("update")
      .limit(1);
    if (!row) throw fail(404, "التفويض غير موجود", "DELEGATION_NOT_FOUND");

    const principalMatches = row.employeeType === input.principal.type &&
      (input.principal.type === "HUMAN"
        ? row.employeeUserId === input.principal.userId
        : row.agentConfigurationId === input.principal.configurationId);
    if (!principalMatches) {
      await recordDelegationAudit(tx, {
        businessId: row.businessId,
        actorId: input.principal.type === "HUMAN" ? input.principal.userId : row.grantorActorId,
        action: "DELEGATED_ACCESS_REJECTED",
        delegationId: row.id,
        detail: { reason: "PRINCIPAL_MISMATCH" },
      });
      return { denied: { status: 404, message: "التفويض غير موجود", code: "DELEGATION_NOT_FOUND" } as const };
    }

    const actorId = input.principal.type === "HUMAN" ? input.principal.userId : row.grantorActorId;
    const liveRow = await expireGrantIfNeeded(tx, row, business.d2BusinessId, actorId);
    if (liveRow.status !== "ACTIVE") {
      await recordDelegationAudit(tx, {
        businessId: row.businessId,
        actorId,
        action: "DELEGATED_ACCESS_REJECTED",
        delegationId: row.id,
        detail: { reason: liveRow.status === "EXPIRED" ? "EXPIRED" : "NOT_ACTIVE" },
      });
      return { denied: { status: 403, message: "هذا التفويض غير نشط", code: "DELEGATION_NOT_ACTIVE" } as const };
    }
    if (!liveRow.capabilities.includes("business.catalog.read")) {
      await recordDelegationAudit(tx, {
        businessId: row.businessId,
        actorId,
        action: "DELEGATED_ACCESS_REJECTED",
        delegationId: row.id,
        detail: { reason: "CAPABILITY_NOT_GRANTED" },
      });
      return { denied: { status: 403, message: "لا يتيح هذا التفويض عرض المنتجات", code: "DELEGATION_CAPABILITY_DENIED" } as const };
    }

    const [identity] = await tx
      .select()
      .from(businessProfiles)
      .where(and(
        eq(businessProfiles.id, business.d2BusinessId),
        eq(businessProfiles.ownerUserId, liveRow.grantorActorId),
        eq(businessProfiles.marketId, input.marketId),
      ))
      .for("share")
      .limit(1);
    const [ownerMembership] = await tx
      .select()
      .from(businessMemberships)
      .where(and(
        eq(businessMemberships.businessId, business.d2BusinessId),
        eq(businessMemberships.userId, liveRow.grantorActorId),
        eq(businessMemberships.status, "ACTIVE"),
        inArray(businessMemberships.role, ["APPLICANT", "VERIFIED_OWNER"]),
      ))
      .for("share")
      .limit(1);
    if (!identity || !ownerMembership || ["SUSPENDED", "REJECTED"].includes(identity.verificationStatus) ||
        business.status === "SUSPENDED" || business.status === "CLOSED") {
      await recordDelegationAudit(tx, {
        businessId: row.businessId,
        actorId,
        action: "DELEGATED_ACCESS_REJECTED",
        delegationId: row.id,
        detail: { reason: "BUSINESS_ACCESS_BLOCKED" },
      });
      return { denied: { status: 403, message: "توقف الوصول إلى هذا النشاط", code: "DELEGATION_BUSINESS_BLOCKED" } as const };
    }

    if (input.principal.type === "HUMAN") {
      const [employee] = await tx.select().from(users)
        .where(eq(users.id, input.principal.userId)).for("share").limit(1);
      const [membership] = await tx.select().from(businessMemberships)
        .where(and(
          eq(businessMemberships.businessId, identity.id),
          eq(businessMemberships.userId, input.principal.userId),
          eq(businessMemberships.role, "STAFF"),
          eq(businessMemberships.status, "ACTIVE"),
        ))
        .for("share")
        .limit(1);
      if (!employee || employee.status !== "ACTIVE" || !membership) {
        await recordDelegationAudit(tx, {
          businessId: row.businessId,
          actorId: input.principal.userId,
          action: "DELEGATED_ACCESS_REJECTED",
          delegationId: row.id,
          detail: { reason: "MEMBERSHIP_NOT_ACTIVE" },
        });
        return { denied: { status: 403, message: "عضوية الموظف غير نشطة", code: "DELEGATION_MEMBERSHIP_INACTIVE" } as const };
      }
    }

    const resourceScope = liveRow.resourceScope as DelegationScope;
    const conditions = [
      eq(offers.businessProfileId, identity.id),
      eq(offers.marketId, input.marketId),
      eq(offers.status, "PUBLISHED"),
    ];
    if (resourceScope.kind === "LISTING_ALLOWLIST")
      conditions.push(inArray(offers.id, resourceScope.listingIds));
    const rows = await tx
      .select({
        id: offers.id,
        unitPriceMinor: offers.unitPriceMinor,
        pricingMode: offers.pricingMode,
        data: offers.data,
      })
      .from(offers)
      .where(and(...conditions))
      .orderBy(asc(offers.createdAt), asc(offers.id))
      .limit(MAX_CATALOG_ROWS);

    await recordDelegationAudit(tx, {
      businessId: row.businessId,
      actorId,
      action: "DELEGATED_CATALOG_READ",
      delegationId: row.id,
      detail: { resultCount: rows.length, scopeKind: resourceScope.kind },
    });
    return { data: {
      businessId: row.businessId,
      businessName: business.displayName,
      policyVersion: POLICY_VERSION,
      listings: rows.map((listing) => ({
        id: listing.id,
        title: typeof listing.data.title === "string" ? listing.data.title : "منتج",
        category: typeof listing.data.category === "string" ? listing.data.category : null,
        priceMinor: listing.unitPriceMinor,
        pricingMode: listing.pricingMode,
      })),
    } };
  });
  if ("denied" in result && result.denied)
    throw fail(result.denied.status, result.denied.message, result.denied.code);
  return result.data;
}

/**
 * Resolve the seller employee only from the authenticated owner's live D4 grants.
 * No grant id, business id, employee identity, capability, or scope is model-selectable.
 * Ambiguous grants fail closed instead of letting the model choose its own authority.
 */
export async function delegatedSellerModelContext(input: {
  actorId: string;
  marketId: string;
}) {
  const rows = await db
    .select()
    .from(businessDelegations)
    .where(and(
      eq(businessDelegations.grantorActorId, input.actorId),
      eq(businessDelegations.marketId, input.marketId),
      eq(businessDelegations.employeeType, "INTELLIGENT"),
      eq(businessDelegations.status, "ACTIVE"),
      gt(businessDelegations.expiresAt, new Date()),
    ))
    .orderBy(asc(businessDelegations.createdAt), asc(businessDelegations.id))
    .limit(2);
  if (rows.length !== 1) return null;

  const grant = rows[0]!;
  if (!grant.agentConfigurationId) return null;
  try {
    return await delegatedBusinessCatalog({
      delegationId: grant.id,
      marketId: input.marketId,
      principal: { type: "INTELLIGENT", configurationId: grant.agentConfigurationId },
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if ([
      "DELEGATION_NOT_FOUND",
      "DELEGATION_NOT_ACTIVE",
      "DELEGATION_CAPABILITY_DENIED",
      "DELEGATION_BUSINESS_BLOCKED",
    ].includes(String(code))) return null;
    throw error;
  }
}
