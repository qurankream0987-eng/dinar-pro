import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  marketLegalCapabilityApprovals,
  marketLegalCapabilityEvents,
  marketLegalIntakes,
  markets,
  securityIncidentEvents,
  securityIncidents,
} from "@workspace/db";
import { assertAdminActor } from "./admin-authority";
import { assertCountryActivationReady } from "./country-legal-readiness";

export const MARKET_LEGAL_CAPABILITIES = [
  "INFORMATION_ONLY",
  "BROWSING",
  "LISTING_PUBLICATION",
  "TRANSACTIONS",
  "CASH_PAYMENT",
  "ELECTRONIC_PAYMENT",
  "BUSINESS_ONBOARDING",
  "DELIVERY_OPERATIONS",
  "RESTRICTED_CATEGORIES",
] as const;

export type MarketLegalCapability = (typeof MARKET_LEGAL_CAPABILITIES)[number];
export type MarketLegalCapabilityStatus =
  | "DISABLED"
  | "COUNSEL_REVIEW_REQUIRED"
  | "OWNER_APPROVAL_REQUIRED"
  | "ENABLED"
  | "BLOCKED";

type Environment = Record<string, string | undefined>;

export class D16ReadinessError extends Error {
  readonly expose = true;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "D16ReadinessError";
  }
}

function reject(status: number, code: string, message: string): never {
  throw new D16ReadinessError(status, code, message);
}

/** Unknown or deployed environments enforce the gate; only explicit test/dev is exempt. */
export function marketLegalGateEnforced(env: Environment = process.env) {
  // The deploy marker wins over NODE_ENV: a deployment can inherit "development" while serving
  // real traffic, so only an editor/test process with no deployment marker may use the exemption.
  if (env.REPLIT_DEPLOYMENT !== undefined) return true;
  const deployment = env.DINAR_DEPLOYMENT_ENV?.trim().toLowerCase();
  if (deployment) {
    return deployment !== "development" && deployment !== "test";
  }
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

function configuredActorIds(envValue: string | undefined) {
  return new Set(
    (envValue ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function requireReference(reference: string, label: string) {
  const value = reference.trim();
  if (!/^[A-Za-z][A-Za-z0-9._/-]{2,199}$/.test(value))
    reject(400, "REFERENCE_INVALID", `${label} يجب أن يكون مرجعاً فقط، لا مستنداً أو بيانات شخصية`);
  return value;
}

async function requireMarket(marketId: string, tx: any) {
  const [market] = await tx
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);
  if (!market) reject(404, "MARKET_NOT_FOUND", "السوق غير موجود");
}

async function readCapability(
  marketId: string,
  capability: MarketLegalCapability,
  tx: any = db,
  lock = false,
) {
  const query = tx
    .select()
    .from(marketLegalCapabilityApprovals)
    .where(
      and(
        eq(marketLegalCapabilityApprovals.marketId, marketId),
        eq(marketLegalCapabilityApprovals.capability, capability),
      ),
    );
  const rows = lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return rows[0];
}

async function countryActivationIsActive(tx: any, marketId: string) {
  const [intake] = await tx
    .select({ activationStatus: marketLegalIntakes.activationStatus })
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.marketId, marketId))
    .limit(1);
  return intake?.activationStatus === "ACTIVE";
}

export async function assertMarketLegalCapability(
  marketId: string,
  capability: MarketLegalCapability,
  tx: any = db,
  env: Environment = process.env,
) {
  if (!marketLegalGateEnforced(env))
    return { enforced: false as const, enabled: true as const };
  await assertCountryActivationReady(marketId, tx);
  const row = await readCapability(marketId, capability, tx);
  if (row?.status !== "ENABLED")
    reject(
      409,
      "MARKET_CAPABILITY_NOT_ENABLED",
      "هذه الخدمة غير متاحة في السوق الحالي قبل اكتمال مراجعة المستشار وموافقة المالك",
    );
  return { enforced: true as const, enabled: true as const };
}

function publicCapabilityRow(
  marketId: string,
  capability: MarketLegalCapability,
  row: typeof marketLegalCapabilityApprovals.$inferSelect | undefined,
  countryActive = true,
) {
  const enabled = row?.status === "ENABLED" && countryActive;
  return {
    marketId,
    capability,
    status: row?.status === "ENABLED" && !countryActive ? "BLOCKED" : row?.status ?? "DISABLED",
    enabled,
    counselReviewRecorded: Boolean(row?.counselReviewedAt),
    ownerApprovalRecorded: Boolean(row?.ownerApprovedAt),
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function marketLegalCapabilityOverview(
  marketId: string,
  tx: any = db,
) {
  const [rows, countryActive] = await Promise.all([
    tx
      .select()
      .from(marketLegalCapabilityApprovals)
      .where(eq(marketLegalCapabilityApprovals.marketId, marketId)),
    countryActivationIsActive(tx, marketId),
  ]);
  const byCapability = new Map<
    string,
    typeof marketLegalCapabilityApprovals.$inferSelect
  >(
    rows.map((row: typeof marketLegalCapabilityApprovals.$inferSelect) => [
      row.capability,
      row,
    ]),
  );
  return {
    marketId,
    enforcement: marketLegalGateEnforced() ? "DEPLOYED_FAIL_CLOSED" : "DEVELOPMENT_TEST_ONLY",
    capabilities: MARKET_LEGAL_CAPABILITIES.map((capability) =>
      publicCapabilityRow(marketId, capability, byCapability.get(capability), countryActive),
    ),
  };
}

export async function adminMarketLegalCapabilityOverview(marketId: string) {
  const [rows, events, countryActive] = await Promise.all([
    db
      .select()
      .from(marketLegalCapabilityApprovals)
      .where(eq(marketLegalCapabilityApprovals.marketId, marketId)),
    db
      .select()
      .from(marketLegalCapabilityEvents)
      .where(eq(marketLegalCapabilityEvents.marketId, marketId))
      .orderBy(desc(marketLegalCapabilityEvents.createdAt))
      .limit(250),
    countryActivationIsActive(db, marketId),
  ]);
  const byCapability = new Map(rows.map((row) => [row.capability, row]));
  return {
    marketId,
    capabilities: MARKET_LEGAL_CAPABILITIES.map((capability) => {
      const row = byCapability.get(capability);
      return {
        ...publicCapabilityRow(marketId, capability, row, countryActive),
        counselReference: row?.counselReference ?? null,
        counselReviewedBy: row?.counselReviewedBy ?? null,
        counselReviewedAt: row?.counselReviewedAt?.toISOString() ?? null,
        ownerApprovalReference: row?.ownerApprovalReference ?? null,
        ownerApprovedBy: row?.ownerApprovedBy ?? null,
        ownerApprovedAt: row?.ownerApprovedAt?.toISOString() ?? null,
      };
    }),
    events: events.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

async function writeCapabilityEvent(
  tx: any,
  input: {
    marketId: string;
    capability: MarketLegalCapability;
    eventType: "REVIEW_REQUESTED" | "COUNSEL_REVIEWED" | "COUNSEL_BLOCKED" | "OWNER_ENABLED" | "CAPABILITY_DISABLED";
    fromStatus: MarketLegalCapabilityStatus | null;
    toStatus: MarketLegalCapabilityStatus;
    actorId: string;
    reference?: string | null;
  },
) {
  await tx.insert(marketLegalCapabilityEvents).values({
    id: randomUUID(),
    ...input,
    createdAt: new Date(),
  });
}

export async function requestMarketCapabilityReview(input: {
  actorId: string;
  marketId: string;
  capability: MarketLegalCapability;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    await requireMarket(input.marketId, tx);
    const existing = await readCapability(input.marketId, input.capability, tx, true);
    if (existing?.status === "ENABLED")
      reject(409, "CAPABILITY_ALREADY_ENABLED", "أوقف الصلاحية قبل طلب مراجعة جديدة");
    const now = new Date();
    if (existing) {
      const [updated] = await tx
        .update(marketLegalCapabilityApprovals)
        .set({
          status: "COUNSEL_REVIEW_REQUIRED",
          counselReference: null,
          counselReviewedBy: null,
          counselReviewedAt: null,
          ownerApprovalReference: null,
          ownerApprovedBy: null,
          ownerApprovedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(marketLegalCapabilityApprovals.id, existing.id),
            eq(marketLegalCapabilityApprovals.status, existing.status),
          ),
        )
        .returning({ id: marketLegalCapabilityApprovals.id });
      if (!updated) reject(409, "CAPABILITY_STATE_CHANGED", "تغيرت حالة المراجعة؛ أعد المحاولة");
    } else {
      await tx.insert(marketLegalCapabilityApprovals).values({
        id: randomUUID(),
        marketId: input.marketId,
        capability: input.capability,
        status: "COUNSEL_REVIEW_REQUIRED",
        createdAt: now,
        updatedAt: now,
      });
    }
    await writeCapabilityEvent(tx, {
      marketId: input.marketId,
      capability: input.capability,
      eventType: "REVIEW_REQUESTED",
      fromStatus: (existing?.status as MarketLegalCapabilityStatus | undefined) ?? null,
      toStatus: "COUNSEL_REVIEW_REQUIRED",
      actorId: input.actorId,
    });
    return publicCapabilityRow(
      input.marketId,
      input.capability,
      await readCapability(input.marketId, input.capability, tx),
    );
  });
}

export async function recordMarketCounselReview(input: {
  actorId: string;
  marketId: string;
  capability: MarketLegalCapability;
  outcome: "READY_FOR_OWNER_REVIEW" | "BLOCK";
  reference: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  if (!configuredActorIds(env.DINAR_COUNSEL_REVIEWER_IDS).has(input.actorId))
    reject(403, "DESIGNATED_COUNSEL_REVIEWER_REQUIRED", "المراجع غير معيّن لمراجعة المستشار");
  if (configuredActorIds(env.DINAR_LEGAL_OWNER_IDS).has(input.actorId))
    reject(403, "SEPARATION_OF_DUTIES_REQUIRED", "يجب فصل مراجعة المستشار عن موافقة المالك");
  const reference = requireReference(input.reference, "مرجع مراجعة المستشار");
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const row = await readCapability(input.marketId, input.capability, tx, true);
    if (!row || row.status !== "COUNSEL_REVIEW_REQUIRED")
      reject(409, "COUNSEL_REVIEW_NOT_REQUESTED", "لا يوجد طلب مراجعة مستشار مفتوح");
    const status =
      input.outcome === "READY_FOR_OWNER_REVIEW"
        ? "OWNER_APPROVAL_REQUIRED"
        : "BLOCKED";
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalCapabilityApprovals)
      .set({
        status,
        counselReference: reference,
        counselReviewedBy: input.actorId,
        counselReviewedAt: now,
        ownerApprovalReference: null,
        ownerApprovedBy: null,
        ownerApprovedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(marketLegalCapabilityApprovals.id, row.id),
          eq(marketLegalCapabilityApprovals.status, row.status),
        ),
      )
      .returning({ id: marketLegalCapabilityApprovals.id });
    if (!updated) reject(409, "CAPABILITY_STATE_CHANGED", "تغيرت حالة المراجعة؛ أعد المحاولة");
    await writeCapabilityEvent(tx, {
      marketId: input.marketId,
      capability: input.capability,
      eventType:
        input.outcome === "READY_FOR_OWNER_REVIEW"
          ? "COUNSEL_REVIEWED"
          : "COUNSEL_BLOCKED",
      fromStatus: "COUNSEL_REVIEW_REQUIRED",
      toStatus: status,
      actorId: input.actorId,
      reference,
    });
    return publicCapabilityRow(
      input.marketId,
      input.capability,
      await readCapability(input.marketId, input.capability, tx),
    );
  });
}

export async function enableMarketCapability(input: {
  actorId: string;
  marketId: string;
  capability: MarketLegalCapability;
  reference: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  if (!configuredActorIds(env.DINAR_LEGAL_OWNER_IDS).has(input.actorId))
    reject(403, "DESIGNATED_LEGAL_OWNER_REQUIRED", "الموافق غير معيّن لموافقة مالك جاسم");
  const reference = requireReference(input.reference, "مرجع موافقة المالك");
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    await assertCountryActivationReady(input.marketId, tx);
    const row = await readCapability(input.marketId, input.capability, tx, true);
    if (!row || row.status !== "OWNER_APPROVAL_REQUIRED")
      reject(409, "COUNSEL_REVIEW_REQUIRED", "يلزم توثيق مراجعة مستشار منفصلة أولاً");
    if (row.counselReviewedBy === input.actorId)
      reject(403, "SEPARATION_OF_DUTIES_REQUIRED", "لا يجوز للمراجع نفسه اعتماد تفعيل الصلاحية");
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalCapabilityApprovals)
      .set({
        status: "ENABLED",
        ownerApprovalReference: reference,
        ownerApprovedBy: input.actorId,
        ownerApprovedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(marketLegalCapabilityApprovals.id, row.id),
          eq(marketLegalCapabilityApprovals.status, row.status),
        ),
      )
      .returning({ id: marketLegalCapabilityApprovals.id });
    if (!updated) reject(409, "CAPABILITY_STATE_CHANGED", "تغيرت حالة الصلاحية؛ أعد المحاولة");
    await writeCapabilityEvent(tx, {
      marketId: input.marketId,
      capability: input.capability,
      eventType: "OWNER_ENABLED",
      fromStatus: "OWNER_APPROVAL_REQUIRED",
      toStatus: "ENABLED",
      actorId: input.actorId,
      reference,
    });
    return publicCapabilityRow(
      input.marketId,
      input.capability,
      await readCapability(input.marketId, input.capability, tx),
    );
  });
}

/** Any administrator can safely close a capability; reopening still requires both designated actors. */
export async function disableMarketCapability(input: {
  actorId: string;
  marketId: string;
  capability: MarketLegalCapability;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    await requireMarket(input.marketId, tx);
    const row = await readCapability(input.marketId, input.capability, tx, true);
    if (!row) return publicCapabilityRow(input.marketId, input.capability, undefined);
    if (row.status === "DISABLED")
      return publicCapabilityRow(input.marketId, input.capability, row);
    const [updated] = await tx
      .update(marketLegalCapabilityApprovals)
      .set({ status: "DISABLED", updatedAt: new Date() })
      .where(
        and(
          eq(marketLegalCapabilityApprovals.id, row.id),
          eq(marketLegalCapabilityApprovals.status, row.status),
        ),
      )
      .returning({ id: marketLegalCapabilityApprovals.id });
    if (!updated) reject(409, "CAPABILITY_STATE_CHANGED", "تغيرت حالة الصلاحية؛ أعد المحاولة");
    await writeCapabilityEvent(tx, {
      marketId: input.marketId,
      capability: input.capability,
      eventType: "CAPABILITY_DISABLED",
      fromStatus: row.status as MarketLegalCapabilityStatus,
      toStatus: "DISABLED",
      actorId: input.actorId,
    });
    return publicCapabilityRow(
      input.marketId,
      input.capability,
      await readCapability(input.marketId, input.capability, tx),
    );
  });
}

export const SECURITY_INCIDENT_CATEGORIES = [
  "SECURITY",
  "PRIVACY",
  "AVAILABILITY",
  "DATA_INTEGRITY",
  "THIRD_PARTY",
  "OTHER",
] as const;
export const SECURITY_INCIDENT_SEVERITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;
export type SecurityIncidentStatus = "OPEN" | "CONTAINED" | "RECOVERED" | "CLOSED";

function optionalReference(reference?: string) {
  if (!reference?.trim()) return null;
  return requireReference(reference, "مرجع الدليل");
}

function incidentView(row: typeof securityIncidents.$inferSelect) {
  return {
    ...row,
    detectedAt: row.detectedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    counselReviewedAt: row.counselReviewedAt?.toISOString() ?? null,
  };
}

async function writeIncidentEvent(
  tx: any,
  input: {
    incidentId: string;
    eventType:
      | "OPENED"
      | "CONTAINMENT_RECORDED"
      | "RECOVERY_RECORDED"
      | "POST_INCIDENT_RECORDED"
      | "COUNSEL_REVIEW_REQUESTED"
      | "COUNSEL_REVIEW_RECORDED"
      | "SEVERITY_CHANGED"
      | "EVIDENCE_REFERENCE_ADDED";
    fromStatus: SecurityIncidentStatus | null;
    toStatus: SecurityIncidentStatus;
    actorId: string;
    reference?: string | null;
  },
) {
  await tx.insert(securityIncidentEvents).values({
    id: randomUUID(),
    ...input,
    createdAt: new Date(),
  });
}

export async function createSecurityIncident(input: {
  actorId: string;
  category: (typeof SECURITY_INCIDENT_CATEGORIES)[number];
  severity: (typeof SECURITY_INCIDENT_SEVERITIES)[number];
  summary: string;
  affectedSystems: string[];
  detectedAt?: string;
  evidenceReference?: string;
}) {
  const summary = input.summary.trim();
  const systems = [...new Set(input.affectedSystems.map((value) => value.trim()))];
  if (summary.length < 3 || summary.length > 1200)
    reject(400, "INCIDENT_SUMMARY_INVALID", "ملخص الحادث يجب أن يكون بين 3 و1200 حرف");
  if (systems.length > 12 || systems.some((value) => !value || value.length > 80))
    reject(400, "INCIDENT_SYSTEMS_INVALID", "قائمة الأنظمة المتأثرة غير صالحة");
  const detectedAt = input.detectedAt ? new Date(input.detectedAt) : new Date();
  if (Number.isNaN(detectedAt.valueOf()))
    reject(400, "INCIDENT_DETECTED_AT_INVALID", "وقت اكتشاف الحادث غير صالح");
  const evidenceReference = optionalReference(input.evidenceReference);
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const id = randomUUID();
    const now = new Date();
    const [row] = await tx
      .insert(securityIncidents)
      .values({
        id,
        category: input.category,
        severity: input.severity,
        status: "OPEN",
        summary,
        affectedSystems: systems,
        detectedAt,
        openedBy: input.actorId,
        evidenceReference,
        counselAssessment: "NOT_ASSESSED",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await writeIncidentEvent(tx, {
      incidentId: id,
      eventType: "OPENED",
      fromStatus: null,
      toStatus: "OPEN",
      actorId: input.actorId,
      reference: evidenceReference,
    });
    return incidentView(row);
  });
}

export async function listSecurityIncidents(status?: SecurityIncidentStatus) {
  const rows = await db
    .select()
    .from(securityIncidents)
    .where(status ? eq(securityIncidents.status, status) : undefined)
    .orderBy(desc(securityIncidents.createdAt))
    .limit(200);
  return rows.map(incidentView);
}

export async function getSecurityIncident(id: string) {
  const [row] = await db
    .select()
    .from(securityIncidents)
    .where(eq(securityIncidents.id, id))
    .limit(1);
  if (!row) reject(404, "INCIDENT_NOT_FOUND", "سجل الحادث غير موجود");
  const events = await db
    .select()
    .from(securityIncidentEvents)
    .where(eq(securityIncidentEvents.incidentId, id))
    .orderBy(desc(securityIncidentEvents.createdAt));
  return {
    incident: incidentView(row),
    events: events.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export type SecurityIncidentAction =
  | "RECORD_CONTAINMENT"
  | "RECORD_RECOVERY"
  | "CLOSE_WITH_POSTMORTEM"
  | "REQUEST_COUNSEL_REVIEW"
  | "RECORD_COUNSEL_REVIEW"
  | "CHANGE_SEVERITY"
  | "ADD_EVIDENCE_REFERENCE";

export async function transitionSecurityIncident(input: {
  actorId: string;
  id: string;
  action: SecurityIncidentAction;
  summary?: string;
  reference?: string;
  severity?: (typeof SECURITY_INCIDENT_SEVERITIES)[number];
  env?: Environment;
}) {
  const reference = optionalReference(input.reference);
  if (input.action === "RECORD_COUNSEL_REVIEW") {
    const env = input.env ?? process.env;
    if (!configuredActorIds(env.DINAR_COUNSEL_REVIEWER_IDS).has(input.actorId))
      reject(403, "DESIGNATED_COUNSEL_REVIEWER_REQUIRED", "المراجع غير معيّن لمراجعة المستشار");
    if (configuredActorIds(env.DINAR_LEGAL_OWNER_IDS).has(input.actorId))
      reject(403, "SEPARATION_OF_DUTIES_REQUIRED", "يجب فصل مراجعة المستشار عن موافقة المالك");
  }
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const [row] = await tx
      .select()
      .from(securityIncidents)
      .where(eq(securityIncidents.id, input.id))
      .for("update");
    if (!row) reject(404, "INCIDENT_NOT_FOUND", "سجل الحادث غير موجود");
    if (row.status === "CLOSED")
      reject(409, "INCIDENT_CLOSED_IMMUTABLE", "لا يمكن تعديل سجل حادث مغلق");
    const now = new Date();
    let status = row.status as SecurityIncidentStatus;
    let eventType:
      | "CONTAINMENT_RECORDED"
      | "RECOVERY_RECORDED"
      | "POST_INCIDENT_RECORDED"
      | "COUNSEL_REVIEW_REQUESTED"
      | "COUNSEL_REVIEW_RECORDED"
      | "SEVERITY_CHANGED"
      | "EVIDENCE_REFERENCE_ADDED";
    let patch: Partial<typeof securityIncidents.$inferInsert> = { updatedAt: now };
    switch (input.action) {
      case "RECORD_CONTAINMENT": {
        const summary = input.summary?.trim() ?? "";
        if (row.status !== "OPEN" || summary.length < 3 || summary.length > 1200)
          reject(409, "INCIDENT_CONTAINMENT_INVALID", "يلزم ملخص احتواء صالح لحادث مفتوح");
        status = "CONTAINED";
        eventType = "CONTAINMENT_RECORDED";
        patch = { ...patch, status, containmentSummary: summary, evidenceReference: reference ?? row.evidenceReference };
        break;
      }
      case "RECORD_RECOVERY": {
        const summary = input.summary?.trim() ?? "";
        if (row.status !== "CONTAINED" || summary.length < 3 || summary.length > 1200)
          reject(409, "INCIDENT_RECOVERY_INVALID", "يلزم تسجيل الاحتواء قبل التعافي");
        status = "RECOVERED";
        eventType = "RECOVERY_RECORDED";
        patch = { ...patch, status, recoverySummary: summary };
        break;
      }
      case "CLOSE_WITH_POSTMORTEM": {
        const summary = input.summary?.trim() ?? "";
        if (row.status !== "RECOVERED" || summary.length < 3 || summary.length > 1200)
          reject(409, "INCIDENT_POSTMORTEM_REQUIRED", "يلزم تسجيل التعافي وملخص ما بعد الحادث");
        status = "CLOSED";
        eventType = "POST_INCIDENT_RECORDED";
        patch = { ...patch, status, postIncidentSummary: summary };
        break;
      }
      case "REQUEST_COUNSEL_REVIEW":
        if (row.counselAssessment !== "NOT_ASSESSED")
          reject(409, "INCIDENT_COUNSEL_REVIEW_EXISTS", "مراجعة المستشار مسجلة بالفعل");
        eventType = "COUNSEL_REVIEW_REQUESTED";
        patch = { ...patch, counselAssessment: "REVIEW_REQUIRED" };
        break;
      case "RECORD_COUNSEL_REVIEW":
        if (row.counselAssessment !== "REVIEW_REQUIRED" || !reference)
          reject(409, "INCIDENT_COUNSEL_REVIEW_NOT_REQUESTED", "اطلب مراجعة المستشار وأرفق مرجعاً أولاً");
        eventType = "COUNSEL_REVIEW_RECORDED";
        patch = {
          ...patch,
          counselAssessment: "REVIEWED",
          counselReference: reference,
          counselReviewedBy: input.actorId,
          counselReviewedAt: now,
        };
        break;
      case "CHANGE_SEVERITY":
        if (!input.severity || input.severity === row.severity)
          reject(400, "INCIDENT_SEVERITY_INVALID", "حدد مستوى خطورة مختلفاً");
        eventType = "SEVERITY_CHANGED";
        patch = { ...patch, severity: input.severity };
        break;
      case "ADD_EVIDENCE_REFERENCE":
        if (!reference)
          reject(400, "INCIDENT_EVIDENCE_REFERENCE_REQUIRED", "أرفق مرجعاً للدليل، ولا ترفع محتواه هنا");
        eventType = "EVIDENCE_REFERENCE_ADDED";
        patch = { ...patch, evidenceReference: reference };
        break;
    }
    const [updated] = await tx
      .update(securityIncidents)
      .set(patch)
      .where(eq(securityIncidents.id, input.id))
      .returning();
    await writeIncidentEvent(tx, {
      incidentId: row.id,
      eventType,
      fromStatus: row.status as SecurityIncidentStatus,
      toStatus: status,
      actorId: input.actorId,
      reference,
    });
    return incidentView(updated);
  });
}
