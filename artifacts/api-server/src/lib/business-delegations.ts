import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import {
  aiResultSets,
  businessAuditEvents,
  businessDelegations,
  businessEmployeeSessions,
  businessMemberships,
  businessOperatingProfiles,
  businessProfiles,
  conversations,
  db,
  negotiations,
  offers,
  orderItems,
  orders,
  users,
  type BusinessEmployeeSessionEndReason,
} from "@workspace/db";
import { z } from "zod";

const POLICY_VERSION = "D4_READ_ONLY_V1";
const D5_SESSION_POLICY_VERSION = "D5_EMPLOYEE_SESSION_V1";
const MAX_GRANT_DAYS = 90;
const MAX_CATALOG_ROWS = 100;
const D5_SESSION_TTL_MS = 24 * 60 * 60_000;
const DELEGATABLE_CAPABILITIES = [
  "business.catalog.read",
  "business.catalog.draft",
  "business.catalog.draft.price",
  "business.inventory.read",
  "business.orders.read",
  "business.inquiries.reply",
  "business.messages.send",
  "business.negotiations.escalate",
] as const;
export type SellerEmployeeCapability = typeof DELEGATABLE_CAPABILITIES[number];
const D5_ONLY_CAPABILITIES = DELEGATABLE_CAPABILITIES.filter(
  (capability) => capability !== "business.catalog.read",
);
const BUSINESS_WIDE_CAPABILITIES = new Set<string>(D5_ONLY_CAPABILITIES);
const OWNER_APPROVAL_CAPABILITIES = [
  "business.catalog.draft",
  "business.catalog.draft.price",
  "business.messages.send",
  "business.inquiries.reply",
  "business.negotiations.escalate",
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
  if (input.employee.type === "HUMAN" && input.capabilities.some((capability) => D5_ONLY_CAPABILITIES.includes(capability as typeof D5_ONLY_CAPABILITIES[number]))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "D5 capabilities are available only to the intelligent employee" });
  }
  if (input.capabilities.some((capability) => BUSINESS_WIDE_CAPABILITIES.has(capability)) && input.resourceScope.kind !== "BUSINESS") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resourceScope"], message: "This capability requires business-wide scope" });
  }
});

const confirmationSchema = z.object({
  confirm: z.literal(true),
  expectedVersion: z.number().int().positive(),
}).strict();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type BusinessDelegationTx = Tx;
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
        policyVersion: body.capabilities.some((capability) =>
          D5_ONLY_CAPABILITIES.includes(capability as typeof D5_ONLY_CAPABILITIES[number]),
        ) ? D5_SESSION_POLICY_VERSION : POLICY_VERSION,
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

    if (row.employeeType === "INTELLIGENT" && status !== "ACTIVE") {
      await invalidateEmployeeSessionsForDelegationTx(
        tx,
        row.id,
        input.action === "REVOKE" ? "GRANT_REVOKED" : "GRANT_SUSPENDED",
        input.actorId,
      );
    }

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
  if (expired.employeeType === "INTELLIGENT")
    await invalidateEmployeeSessionsForDelegationTx(tx, expired.id, "GRANT_EXPIRED", actorId);
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
    if (!liveRow.capabilities.includes("business.catalog.read") &&
        !liveRow.capabilities.includes("business.inventory.read")) {
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
        inventoryMode: offers.inventoryMode,
        availableQuantity: offers.availableQuantity,
        reservedQuantity: offers.reservedQuantity,
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
      policyVersion: liveRow.policyVersion,
      listings: rows.map((listing) => ({
        id: listing.id,
        title: typeof listing.data.title === "string" ? listing.data.title : "منتج",
        ...(liveRow.capabilities.includes("business.catalog.read")
          ? {
              category: typeof listing.data.category === "string" ? listing.data.category : null,
              priceMinor: listing.unitPriceMinor,
              pricingMode: listing.pricingMode,
            }
          : {}),
        ...(liveRow.capabilities.includes("business.inventory.read")
          ? {
              inventoryMode: listing.inventoryMode,
              availableQuantity: listing.inventoryMode === "LIMITED"
                ? Math.max(0, (listing.availableQuantity ?? 0) - listing.reservedQuantity)
                : null,
            }
          : {}),
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
  delegationId?: string;
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
      input.delegationId ? eq(businessDelegations.id, input.delegationId) : undefined,
    ))
    .orderBy(asc(businessDelegations.createdAt), asc(businessDelegations.id))
    .limit(input.delegationId ? 1 : 2);
  if (!rows.length || (!input.delegationId && rows.length !== 1)) return null;

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

export type SellerEmployeeSessionContext = {
  id: string;
  delegationId: string;
  businessId: string;
  ownerUserId: string;
  marketId: string;
  capabilities: SellerEmployeeCapability[];
  resourceScope: DelegationScope;
  startedAt: Date;
  expiresAt: Date;
};

export type SellerEmployeeSessionResolution =
  | { state: "NONE" }
  | { state: "ACTIVE"; session: SellerEmployeeSessionContext }
  | { state: "INVALIDATED"; reason: string };

const sessionEndReasonForDelegation = (
  reason: "GRANT_SUSPENDED" | "GRANT_REVOKED" | "GRANT_EXPIRED",
) => reason;

async function invalidatePendingEmployeeActionsForSessionTx(
  tx: Tx,
  input: {
    sessionId: string;
    conversationId: string;
    businessId: string;
    delegationId: string;
    actorId: string;
    reason: BusinessEmployeeSessionEndReason;
  },
) {
  const rows = await tx
    .select()
    .from(aiResultSets)
    .where(and(
      eq(aiResultSets.conversationId, input.conversationId),
      sql`${aiResultSets.query} ->> 'kind' = 'ACTION'`,
      sql`${aiResultSets.query} ->> 'status' in ('PENDING', 'EXECUTING')`,
      sql`${aiResultSets.query} -> 'delegatedAuthority' ->> 'sessionId' = ${input.sessionId}`,
    ))
    .for("update");
  const now = new Date();
  const status = input.reason === "OWNER_STOP"
    ? "CANCELLED"
    : input.reason.includes("EXPIRED") ? "EXPIRED" : "REJECTED";
  for (const row of rows) {
    const query = row.query;
    await tx.update(aiResultSets).set({
      query: {
        ...query,
        status,
        notice: "أُبطل الإجراء المعلّق لانتهاء أو إيقاف جلسة الموظف. لم يُنفّذ شيء.",
        invalidatedAt: now.toISOString(),
        invalidationReason: input.reason,
      },
    }).where(eq(aiResultSets.id, row.id));
    await recordDelegationAudit(tx, {
      businessId: input.businessId,
      actorId: input.actorId,
      action: "D5_PENDING_ACTION_INVALIDATED",
      delegationId: input.delegationId,
      detail: {
        sessionId: input.sessionId,
        actionId: row.id,
        action: query.action,
        previousStatus: query.status,
        status,
        reason: input.reason,
      },
    });
  }
}

async function invalidateEmployeeSessionsForDelegationTx(
  tx: Tx,
  delegationId: string,
  reason: "GRANT_SUSPENDED" | "GRANT_REVOKED" | "GRANT_EXPIRED",
  actorId: string,
) {
  const now = new Date();
  const rows = await tx
    .update(businessEmployeeSessions)
    .set({
      status: "INVALIDATED",
      endedAt: now,
      endReason: sessionEndReasonForDelegation(reason),
      updatedAt: now,
    })
    .where(and(
      eq(businessEmployeeSessions.delegationId, delegationId),
      eq(businessEmployeeSessions.status, "ACTIVE"),
    ))
    .returning({
      id: businessEmployeeSessions.id,
      businessId: businessEmployeeSessions.businessId,
      ownerUserId: businessEmployeeSessions.ownerUserId,
      conversationId: businessEmployeeSessions.conversationId,
    });
  for (const row of rows) {
    await invalidatePendingEmployeeActionsForSessionTx(tx, {
      sessionId: row.id,
      conversationId: row.conversationId,
      businessId: row.businessId,
      delegationId,
      actorId,
      reason,
    });
    await recordDelegationAudit(tx, {
      businessId: row.businessId,
      actorId,
      action: "D5_EMPLOYEE_SESSION_INVALIDATED",
      delegationId,
      detail: { sessionId: row.id, reason, policyVersion: D5_SESSION_POLICY_VERSION },
    });
  }
}

async function invalidateEmployeeSessionTx(
  tx: Tx,
  session: typeof businessEmployeeSessions.$inferSelect,
  reason: BusinessEmployeeSessionEndReason,
  actorId: string,
  status: "ENDED" | "INVALIDATED" | "EXPIRED" = "INVALIDATED",
) {
  const now = new Date();
  const [updated] = await tx
    .update(businessEmployeeSessions)
    .set({ status, endedAt: now, endReason: reason, updatedAt: now })
    .where(and(
      eq(businessEmployeeSessions.id, session.id),
      eq(businessEmployeeSessions.status, "ACTIVE"),
    ))
    .returning({ id: businessEmployeeSessions.id });
  if (updated) {
    await invalidatePendingEmployeeActionsForSessionTx(tx, {
      sessionId: session.id,
      conversationId: session.conversationId,
      businessId: session.businessId,
      delegationId: session.delegationId,
      actorId,
      reason,
    });
    await recordDelegationAudit(tx, {
      businessId: session.businessId,
      actorId,
      action: status === "ENDED" ? "D5_EMPLOYEE_SESSION_ENDED" : "D5_EMPLOYEE_SESSION_INVALIDATED",
      delegationId: session.delegationId,
      detail: { sessionId: session.id, reason, policyVersion: D5_SESSION_POLICY_VERSION },
    });
  }
  return Boolean(updated);
}

function employeeSessionContext(
  row: typeof businessEmployeeSessions.$inferSelect,
  grant: typeof businessDelegations.$inferSelect,
): SellerEmployeeSessionContext {
  return {
    id: row.id,
    delegationId: row.delegationId,
    businessId: row.businessId,
    ownerUserId: row.ownerUserId,
    marketId: row.marketId,
    capabilities: grant.capabilities.filter(
      (capability): capability is SellerEmployeeCapability =>
        (DELEGATABLE_CAPABILITIES as readonly string[]).includes(capability),
    ),
    resourceScope: grant.resourceScope as DelegationScope,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
  };
}

async function authorizeEmployeeSessionTx(
  tx: Tx,
  input: {
    sessionId: string;
    actorId: string;
    conversationId: string;
    marketId: string;
    capability?: SellerEmployeeCapability;
    listingId?: string;
    touch?: boolean;
  },
): Promise<{ session?: SellerEmployeeSessionContext; reason?: string }> {
  const [session] = await tx
    .select()
    .from(businessEmployeeSessions)
    .where(and(
      eq(businessEmployeeSessions.id, input.sessionId),
      eq(businessEmployeeSessions.ownerUserId, input.actorId),
      eq(businessEmployeeSessions.conversationId, input.conversationId),
    ))
    .limit(1);
  if (!session || session.status !== "ACTIVE") return { reason: "SESSION_NOT_ACTIVE" };

  const now = new Date();
  const end = async (
    reason: BusinessEmployeeSessionEndReason,
    status: "INVALIDATED" | "EXPIRED" = "INVALIDATED",
  ) => {
    await invalidateEmployeeSessionTx(tx, session, reason, input.actorId, status);
    return { reason };
  };
  if (session.expiresAt <= now)
    return end("SESSION_EXPIRED", "EXPIRED");
  if (session.marketId !== input.marketId)
    return end("MARKET_CHANGE");

  const [conversation] = await tx
    .select({ id: conversations.id, ownerUserId: conversations.ownerUserId, marketId: conversations.marketId, kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("share")
    .limit(1);
  const [owner] = await tx
    .select({ id: users.id, status: users.status, activeMarketId: users.activeMarketId })
    .from(users)
    .where(eq(users.id, input.actorId))
    .for("share")
    .limit(1);
  if (!conversation || conversation.ownerUserId !== input.actorId || conversation.kind !== "AI")
    return end("ACCOUNT_SWITCH");
  if (!owner || owner.status !== "ACTIVE")
    return end("ACCOUNT_SWITCH");
  if (owner.activeMarketId !== input.marketId || conversation.marketId !== input.marketId)
    return end("MARKET_CHANGE");

  const [grant] = await tx
    .select()
    .from(businessDelegations)
    .where(and(
      eq(businessDelegations.id, session.delegationId),
      eq(businessDelegations.businessId, session.businessId),
      eq(businessDelegations.grantorActorId, input.actorId),
      eq(businessDelegations.marketId, input.marketId),
      eq(businessDelegations.employeeType, "INTELLIGENT"),
    ))
    .for("update")
    .limit(1);
  if (!grant) return end("GRANT_REVOKED");

  let business: typeof businessOperatingProfiles.$inferSelect;
  let identity: typeof businessProfiles.$inferSelect;
  try {
    ({ business, identity } = await lockOwnedBusiness(tx, {
      businessId: grant.businessId,
      actorId: input.actorId,
      marketId: input.marketId,
    }));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "BUSINESS_NOT_FOUND")
      return end("BUSINESS_BLOCKED");
    throw error;
  }
  const liveGrant = await expireGrantIfNeeded(tx, grant, business.d2BusinessId, input.actorId);
  if (liveGrant.status !== "ACTIVE")
    return end(
      liveGrant.status === "EXPIRED" ? "GRANT_EXPIRED" : "GRANT_REVOKED",
      liveGrant.status === "EXPIRED" ? "EXPIRED" : "INVALIDATED",
    );
  if (input.capability && !liveGrant.capabilities.includes(input.capability))
    return { reason: "CAPABILITY_NOT_GRANTED" };

  const resourceScope = liveGrant.resourceScope as DelegationScope;
  if (input.listingId) {
    const [listing] = await tx
      .select({ id: offers.id })
      .from(offers)
      .where(and(
        eq(offers.id, input.listingId),
        eq(offers.businessProfileId, identity.id),
        eq(offers.marketId, input.marketId),
      ))
      .for("share")
      .limit(1);
    if (!listing || (resourceScope.kind === "LISTING_ALLOWLIST" &&
        !resourceScope.listingIds.includes(input.listingId)))
      return { reason: "RESOURCE_OUT_OF_SCOPE" };
  }

  if (input.touch) {
    await tx.update(businessEmployeeSessions)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(and(
        eq(businessEmployeeSessions.id, session.id),
        eq(businessEmployeeSessions.status, "ACTIVE"),
      ));
  }
  if (input.capability) {
    await recordDelegationAudit(tx, {
      businessId: liveGrant.businessId,
      actorId: input.actorId,
      action: "D5_EMPLOYEE_CAPABILITY_AUTHORIZED",
      delegationId: liveGrant.id,
      detail: {
        sessionId: session.id,
        capability: input.capability,
        ...(input.listingId ? { listingId: input.listingId } : {}),
        policyVersion: D5_SESSION_POLICY_VERSION,
      },
    });
  }
  return { session: employeeSessionContext(session, liveGrant) };
}

export async function activateSellerEmployeeSession(input: {
  actorId: string;
  conversationId: string;
  marketId: string;
}): Promise<SellerEmployeeSessionContext> {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: conversations.id, ownerUserId: conversations.ownerUserId, marketId: conversations.marketId, kind: conversations.kind })
      .from(conversations)
      .where(and(
        eq(conversations.id, input.conversationId),
        eq(conversations.ownerUserId, input.actorId),
        eq(conversations.marketId, input.marketId),
        eq(conversations.kind, "AI"),
      ))
      .for("share")
      .limit(1);
    const [owner] = await tx
      .select({ status: users.status, activeMarketId: users.activeMarketId })
      .from(users)
      .where(eq(users.id, input.actorId))
      .for("share")
      .limit(1);
    if (!conversation || !owner || owner.status !== "ACTIVE" || owner.activeMarketId !== input.marketId)
      throw fail(403, "لا يمكن تفعيل جلسة الموظف لهذا الحساب أو السوق", "EMPLOYEE_SESSION_CONTEXT_INVALID");

    const candidates = await tx
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
    if (candidates.length !== 1)
      throw fail(403, "لا يوجد تفويض D4 نشط ووحيد لهذا السوق", "EMPLOYEE_SESSION_GRANT_UNAVAILABLE");

    const grant = candidates[0]!;
    if (!grant.agentConfigurationId ||
        !grant.capabilities.some((capability) => (DELEGATABLE_CAPABILITIES as readonly string[]).includes(capability)))
      throw fail(403, "لا يتيح التفويض صلاحية للموظف الذكي", "EMPLOYEE_SESSION_CAPABILITY_UNAVAILABLE");

    const { business } = await lockOwnedBusiness(tx, {
      businessId: grant.businessId,
      actorId: input.actorId,
      marketId: input.marketId,
    });
    const liveGrant = await expireGrantIfNeeded(tx, grant, business.d2BusinessId, input.actorId);
    if (liveGrant.status !== "ACTIVE")
      throw fail(403, "هذا التفويض غير نشط", "EMPLOYEE_SESSION_GRANT_UNAVAILABLE");

    const previous = await tx
      .select()
      .from(businessEmployeeSessions)
      .where(and(
        eq(businessEmployeeSessions.conversationId, input.conversationId),
        eq(businessEmployeeSessions.ownerUserId, input.actorId),
        eq(businessEmployeeSessions.status, "ACTIVE"),
      ))
      .for("update");
    for (const session of previous)
      await invalidateEmployeeSessionTx(tx, session, "SESSION_RESTARTED", input.actorId, "ENDED");

    const now = new Date();
    const [session] = await tx
      .insert(businessEmployeeSessions)
      .values({
        id: randomUUID(),
        conversationId: input.conversationId,
        businessId: grant.businessId,
        ownerUserId: input.actorId,
        delegationId: grant.id,
        marketId: input.marketId,
        status: "ACTIVE",
        startedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(Math.min(grant.expiresAt.getTime(), now.getTime() + D5_SESSION_TTL_MS)),
      })
      .returning();
    await recordDelegationAudit(tx, {
      businessId: grant.businessId,
      actorId: input.actorId,
      action: "D5_EMPLOYEE_SESSION_STARTED",
      delegationId: grant.id,
      detail: {
        sessionId: session!.id,
        capabilities: liveGrant.capabilities,
        scopeKind: (liveGrant.resourceScope as DelegationScope).kind,
        policyVersion: D5_SESSION_POLICY_VERSION,
      },
    });
    return employeeSessionContext(session!, liveGrant);
  });
}

export async function resolveSellerEmployeeSession(input: {
  actorId: string;
  conversationId: string;
  marketId: string;
}): Promise<SellerEmployeeSessionResolution> {
  const [session] = await db
    .select()
    .from(businessEmployeeSessions)
    .where(and(
      eq(businessEmployeeSessions.conversationId, input.conversationId),
      eq(businessEmployeeSessions.ownerUserId, input.actorId),
      eq(businessEmployeeSessions.status, "ACTIVE"),
    ))
    .limit(1);
  if (!session) {
    const [latest] = await db
      .select()
      .from(businessEmployeeSessions)
      .where(and(
        eq(businessEmployeeSessions.conversationId, input.conversationId),
        eq(businessEmployeeSessions.ownerUserId, input.actorId),
      ))
      .orderBy(desc(businessEmployeeSessions.updatedAt), desc(businessEmployeeSessions.createdAt))
      .limit(1);
    if (!latest || (latest.status === "ENDED" && latest.endReason === "OWNER_STOP"))
      return { state: "NONE" };
    return {
      state: "INVALIDATED",
      reason: latest.endReason ?? "SESSION_NOT_ACTIVE",
    };
  }
  const result = await db.transaction((tx) => authorizeEmployeeSessionTx(tx, {
    ...input,
    sessionId: session.id,
    touch: true,
  }));
  if (!result.session)
    return { state: "INVALIDATED", reason: result.reason ?? "SESSION_NOT_ACTIVE" };
  return { state: "ACTIVE", session: result.session };
}

export async function requireSellerEmployeeCapability(input: {
  actorId: string;
  conversationId: string;
  marketId: string;
  sessionId: string;
  capability: SellerEmployeeCapability;
  listingId?: string;
}): Promise<SellerEmployeeSessionContext> {
  return db.transaction((tx) => assertSellerEmployeeCapabilityTx(tx, input));
}

export async function assertSellerEmployeeCapabilityTx(
  tx: BusinessDelegationTx,
  input: {
    actorId: string;
    conversationId: string;
    marketId: string;
    sessionId: string;
    capability: SellerEmployeeCapability;
    listingId?: string;
  },
): Promise<SellerEmployeeSessionContext> {
  const result = await authorizeEmployeeSessionTx(tx, input);
  if (!result.session) {
    const reason = result.reason ?? "SESSION_NOT_ACTIVE";
    const message = reason === "CAPABILITY_NOT_GRANTED"
      ? "لا يتيح التفويض هذا الإجراء."
      : reason === "RESOURCE_OUT_OF_SCOPE"
        ? "هذا المورد خارج نطاق التفويض."
        : "انتهت صلاحية جلسة الموظف أو لم تعد مخولة. أعد التفعيل بعد مراجعة التفويض.";
    throw fail(403, message, reason);
  }
  return result.session;
}

export type SellerEmployeeOrderSummary = {
  orderId: string;
  status: string;
  currencyCode: string;
  scopedSubtotalMinor: number;
  scopedItemCount: number;
  createdAt: string;
};

/** Reads only order lines belonging to this D5 session's business and resource scope. */
export async function readSellerEmployeeOrders(input: {
  actorId: string;
  conversationId: string;
  marketId: string;
  sessionId: string;
}): Promise<SellerEmployeeOrderSummary[]> {
  return db.transaction(async (tx) => {
    const session = await assertSellerEmployeeCapabilityTx(tx, {
      ...input,
      capability: "business.orders.read",
    });
    const [business] = await tx.select({
      d2BusinessId: businessOperatingProfiles.d2BusinessId,
    }).from(businessOperatingProfiles).where(and(
      eq(businessOperatingProfiles.id, session.businessId),
      eq(businessOperatingProfiles.ownerUserId, input.actorId),
      eq(businessOperatingProfiles.marketId, input.marketId),
    )).for("share").limit(1);
    if (!business) throw fail(403, "تعذر التحقق من نشاط التفويض", "D5_BUSINESS_SCOPE_INVALID");
    const scope = session.resourceScope as DelegationScope;
    const listingScope = scope.kind === "LISTING_ALLOWLIST"
      ? inArray(offers.id, scope.listingIds)
      : undefined;
    const rows = await tx.select({
      orderId: orders.id,
      status: orders.status,
      currencyCode: orders.currencyCode,
      scopedSubtotalMinor: sql<number>`coalesce(sum(${orderItems.subtotalMinor}), 0)::int`,
      scopedItemCount: sql<number>`count(${orderItems.id})::int`,
      createdAt: orders.createdAt,
    }).from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .innerJoin(offers, eq(offers.id, orderItems.offerId))
      .where(and(
        eq(orders.sellerId, input.actorId),
        eq(orders.marketId, input.marketId),
        eq(offers.businessProfileId, business.d2BusinessId),
        eq(offers.marketId, input.marketId),
        listingScope,
      ))
      .groupBy(orders.id)
      .orderBy(desc(orders.createdAt))
      .limit(20);
    await recordDelegationAudit(tx, {
      businessId: session.businessId,
      actorId: input.actorId,
      action: "D5_EMPLOYEE_ORDERS_READ",
      delegationId: session.delegationId,
      detail: { resultCount: rows.length, scopeKind: scope.kind },
    });
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

export type SellerEmployeeNegotiationSummary = {
  negotiationId: string;
  listingId: string;
  title: string;
  status: "OPEN" | "COUNTERED";
  currencyCode: string;
  amountMinor: number | null;
  quantity: number;
  awaitingSeller: boolean;
  expiresAt: string;
};

/** Escalation is a scoped read and audit event; it never accepts or counters an offer. */
export async function escalateSellerEmployeeNegotiations(input: {
  actorId: string;
  conversationId: string;
  marketId: string;
  sessionId: string;
}): Promise<SellerEmployeeNegotiationSummary[]> {
  return db.transaction(async (tx) => {
    const session = await assertSellerEmployeeCapabilityTx(tx, {
      ...input,
      capability: "business.negotiations.escalate",
    });
    const [business] = await tx.select({
      d2BusinessId: businessOperatingProfiles.d2BusinessId,
    }).from(businessOperatingProfiles).where(and(
      eq(businessOperatingProfiles.id, session.businessId),
      eq(businessOperatingProfiles.ownerUserId, input.actorId),
      eq(businessOperatingProfiles.marketId, input.marketId),
    )).for("share").limit(1);
    if (!business) throw fail(403, "تعذر التحقق من نشاط التفويض", "D5_BUSINESS_SCOPE_INVALID");
    const scope = session.resourceScope as DelegationScope;
    const listingScope = scope.kind === "LISTING_ALLOWLIST"
      ? inArray(offers.id, scope.listingIds)
      : undefined;
    const now = new Date();
    const rows = await tx.select({
      negotiationId: negotiations.id,
      listingId: offers.id,
      title: offers.data,
      status: negotiations.status,
      lastActor: negotiations.lastActor,
      currencyCode: negotiations.currencyCode,
      offerAmountMinor: negotiations.offerAmountMinor,
      counterAmountMinor: negotiations.counterAmountMinor,
      quantity: negotiations.quantity,
      expiresAt: negotiations.expiresAt,
    }).from(negotiations)
      .innerJoin(offers, eq(offers.id, negotiations.listingId))
      .where(and(
        eq(negotiations.sellerId, input.actorId),
        eq(negotiations.marketId, input.marketId),
        eq(offers.businessProfileId, business.d2BusinessId),
        eq(offers.marketId, input.marketId),
        inArray(negotiations.status, ["OPEN", "COUNTERED"]),
        gt(negotiations.expiresAt, now),
        listingScope,
      ))
      .orderBy(desc(negotiations.updatedAt))
      .limit(20);
    const summaries = rows.map((row) => ({
      negotiationId: row.negotiationId,
      listingId: row.listingId,
      title: typeof row.title.title === "string" ? row.title.title : "منتج",
      status: row.status as "OPEN" | "COUNTERED",
      currencyCode: row.currencyCode,
      amountMinor: row.counterAmountMinor ?? row.offerAmountMinor,
      quantity: row.quantity,
      awaitingSeller: row.lastActor === "BUYER",
      expiresAt: row.expiresAt.toISOString(),
    }));
    await recordDelegationAudit(tx, {
      businessId: session.businessId,
      actorId: input.actorId,
      action: "D5_NEGOTIATION_ESCALATED",
      delegationId: session.delegationId,
      detail: {
        count: summaries.length,
        negotiationIds: summaries.map((row) => row.negotiationId),
        scopeKind: scope.kind,
      },
    });
    return summaries;
  });
}

export async function invalidateSellerEmployeeSessionsForActorTx(
  tx: BusinessDelegationTx,
  actorId: string,
  reason: "LOGOUT" | "ACCOUNT_SWITCH" | "MARKET_CHANGE" | "OWNER_STOP",
) {
  const rows = await tx
    .select()
    .from(businessEmployeeSessions)
    .where(and(
      eq(businessEmployeeSessions.ownerUserId, actorId),
      eq(businessEmployeeSessions.status, "ACTIVE"),
    ))
    .for("update");
  for (const session of rows) {
    await invalidateEmployeeSessionTx(
      tx,
      session,
      reason,
      actorId,
      reason === "OWNER_STOP" ? "ENDED" : "INVALIDATED",
    );
  }
  return rows.length;
}

export async function invalidateSellerEmployeeSessionsForActor(
  actorId: string,
  reason: "LOGOUT" | "ACCOUNT_SWITCH" | "MARKET_CHANGE" | "OWNER_STOP",
) {
  return db.transaction((tx) =>
    invalidateSellerEmployeeSessionsForActorTx(tx, actorId, reason),
  );
}

export async function endSellerEmployeeSession(input: {
  actorId: string;
  conversationId: string;
  sessionId: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(businessEmployeeSessions)
      .where(and(
        eq(businessEmployeeSessions.id, input.sessionId),
        eq(businessEmployeeSessions.conversationId, input.conversationId),
        eq(businessEmployeeSessions.ownerUserId, input.actorId),
        eq(businessEmployeeSessions.status, "ACTIVE"),
      ))
      .for("update")
      .limit(1);
    if (!session) return false;
    return invalidateEmployeeSessionTx(
      tx,
      session,
      "OWNER_STOP",
      input.actorId,
      "ENDED",
    );
  });
}
