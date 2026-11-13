import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import {
  db,
  legalEntities,
  marketLegalCapabilityApprovals,
  marketLegalCapabilityEvents,
  marketLegalEvidence,
  marketLegalIntakeEvents,
  marketLegalIntakeTopics,
  marketLegalIntakes,
  markets,
  policyRegistryVersions,
} from "@workspace/db";
import { assertAdminActor } from "./admin-authority";

export const COUNTRY_LEGAL_TOPICS = [
  ["OPERATING_ENTITY", "الكيان والتسجيل والترخيص"],
  ["MARKETPLACE_RULES", "صفة المنصة وقواعد السوق"],
  ["SELLER_ELIGIBILITY", "أهلية البائعين والأفراد"],
  ["BUSINESS_KYC", "التحقق من الأنشطة التجارية"],
  ["CONSUMER_PROTECTION", "حقوق المستهلك والإفصاحات"],
  ["FEES_AND_TAX", "الرسوم والضرائب والفوترة"],
  ["PAYMENTS", "المدفوعات ومزودوها"],
  ["DELIVERY_LOGISTICS", "التوصيل واللوجستيات"],
  ["PERSONAL_DATA", "البيانات الشخصية والاحتفاظ"],
  ["EXTERNAL_AI", "معالجة الذكاء الاصطناعي الخارجي"],
  ["MINORS_RESTRICTED_GOODS_ADVERTISING", "القاصرون والسلع المقيدة والإعلانات"],
  ["IP_COMPLAINTS_DISPUTES", "الملكية الفكرية والشكاوى والنزاعات"],
  ["INCIDENT_NOTIFICATION", "الإبلاغ عن الحوادث والجهات المختصة"],
  ["POLICY_VERSIONS", "إصدارات السياسات والموافقات"],
  ["OFFICIAL_REFERENCES", "المراجع الرسمية وتواريخ النفاذ"],
  ["COUNSEL_FINDINGS", "نتيجة المستشار والتحفظات والتعديلات"],
] as const;

export type CountryLegalTopicKey = (typeof COUNTRY_LEGAL_TOPICS)[number][0];
export type CountryLegalDisposition =
  | "REQUIRED"
  | "NOT_REQUIRED"
  | "NOT_APPLICABLE"
  | "BLOCKED";
export type CountryEvidenceReview = "COUNSEL_REVIEWED" | "REJECTED";
type Environment = Record<string, string | undefined>;
const topicLabels = new Map<string, string>(COUNTRY_LEGAL_TOPICS);
const supportedCountries = ["JO", "KW", "SA"] as const;

export class CountryLegalReadinessError extends Error {
  readonly expose = true;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CountryLegalReadinessError";
  }
}

function reject(status: number, code: string, message: string): never {
  throw new CountryLegalReadinessError(status, code, message);
}

function cleanReference(value: string, label: string) {
  const reference = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._/-]{2,199}$/.test(reference))
    reject(400, "REFERENCE_INVALID", `${label} يجب أن يكون رمز مرجع فقط، لا رابطاً أو مستنداً`);
  return reference;
}

function configuredIds(value: string | undefined) {
  return new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

function requireDesignatedActor(
  actorId: string,
  envName: string,
  env: Environment,
  code: string,
) {
  if (!configuredIds(env[envName]).has(actorId))
    reject(403, code, "هذا الإجراء محجوز للمراجع المعيّن");
  if (configuredIds(env.DINAR_LEGAL_OWNER_IDS).has(actorId))
    reject(403, "SEPARATION_OF_DUTIES_REQUIRED", "يجب فصل مراجعة المستشار عن موافقة المالك");
}

function asIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function evidenceView(row: typeof marketLegalEvidence.$inferSelect) {
  return {
    ...row,
    issuedAt: asIso(row.issuedAt),
    expiresAt: asIso(row.expiresAt),
    submittedAt: row.submittedAt.toISOString(),
    reviewedAt: asIso(row.reviewedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expired: Boolean(row.expiresAt && row.expiresAt.valueOf() < Date.now()),
  };
}

function topicView(row: typeof marketLegalIntakeTopics.$inferSelect) {
  return {
    ...row,
    labelAr: topicLabels.get(row.topicKey) ?? row.topicKey,
    effectiveFrom: asIso(row.effectiveFrom),
    effectiveUntil: asIso(row.effectiveUntil),
    reviewedAt: asIso(row.reviewedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function intakeView(row: typeof marketLegalIntakes.$inferSelect) {
  return {
    ...row,
    reviewRequestedAt: asIso(row.reviewRequestedAt),
    counselReviewedAt: asIso(row.counselReviewedAt),
    counselApprovedAt: asIso(row.counselApprovedAt),
    ownerApprovedAt: asIso(row.ownerApprovedAt),
    technicalVerifiedAt: asIso(row.technicalVerifiedAt),
    activatedAt: asIso(row.activatedAt),
    suspendedAt: asIso(row.suspendedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function eventView(row: typeof marketLegalIntakeEvents.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

async function writeEvent(
  tx: any,
  input: {
    intakeId: string;
    eventType:
      | "PACKAGE_INITIALIZED"
      | "EVIDENCE_SUBMITTED"
      | "EVIDENCE_REVIEWED"
      | "EVIDENCE_REJECTED"
      | "COUNSEL_REVIEW_REQUESTED"
      | "TOPIC_REVIEWED"
      | "COUNSEL_REVIEW_RECORDED"
      | "COUNSEL_APPROVAL_BLOCKED"
      | "OWNER_APPROVAL_BLOCKED"
      | "TECHNICAL_VERIFICATION_BLOCKED"
      | "ACTIVATION_BLOCKED"
      | "MARKET_ACTIVATED"
      | "MARKET_SUSPENDED";
    actorId: string;
    toStatus: string;
    fromStatus?: string | null;
    topicKey?: string | null;
    evidenceId?: string | null;
    referenceCode?: string | null;
  },
) {
  await tx.insert(marketLegalIntakeEvents).values({
    id: randomUUID(),
    ...input,
    createdAt: new Date(),
  });
}

async function readPackage(marketId: string, tx: any = db) {
  const [market] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);
  if (!market) reject(404, "MARKET_NOT_FOUND", "السوق غير موجود");
  const [intake] = await tx
    .select()
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.marketId, marketId))
    .limit(1);
  if (!intake) reject(404, "COUNTRY_INTAKE_NOT_INITIALIZED", "حزمة المراجعة غير مهيأة لهذا السوق");
  const [topics, evidence, events, policies, [legalEntity], capabilities] =
    await Promise.all([
      tx
        .select()
        .from(marketLegalIntakeTopics)
        .where(eq(marketLegalIntakeTopics.intakeId, intake.id))
        .orderBy(marketLegalIntakeTopics.topicKey),
      tx
        .select()
        .from(marketLegalEvidence)
        .where(eq(marketLegalEvidence.intakeId, intake.id))
        .orderBy(desc(marketLegalEvidence.createdAt)),
      tx
        .select()
        .from(marketLegalIntakeEvents)
        .where(eq(marketLegalIntakeEvents.intakeId, intake.id))
        .orderBy(desc(marketLegalIntakeEvents.createdAt))
        .limit(250),
      tx
        .select()
        .from(policyRegistryVersions)
        .where(
          and(
            eq(policyRegistryVersions.lifecycle, "PUBLISHED"),
            or(
              eq(policyRegistryVersions.marketScope, marketId),
              eq(policyRegistryVersions.marketScope, "GLOBAL"),
            ),
          ),
        ),
      tx
        .select()
        .from(legalEntities)
        .where(eq(legalEntities.marketId, marketId))
        .limit(1),
      tx
        .select()
        .from(marketLegalCapabilityApprovals)
        .where(eq(marketLegalCapabilityApprovals.marketId, marketId)),
    ]);
  return { market, intake, topics, evidence, events, policies, legalEntity, capabilities };
}

function contentBlockers(
  intake: typeof marketLegalIntakes.$inferSelect,
  topics: typeof marketLegalIntakeTopics.$inferSelect[],
  evidence: typeof marketLegalEvidence.$inferSelect[],
  policies: typeof policyRegistryVersions.$inferSelect[],
  legalEntity: typeof legalEntities.$inferSelect | undefined,
) {
  const blockers = new Set<string>();
  const topicsByKey = new Map(topics.map((topic) => [topic.topicKey, topic]));
  for (const [topicKey] of COUNTRY_LEGAL_TOPICS) {
    const topic = topicsByKey.get(topicKey);
    if (!topic || topic.reviewStatus !== "COUNSEL_REVIEWED" || topic.disposition === "UNRESOLVED" || topic.disposition === "BLOCKED") {
      blockers.add(`TOPIC_UNRESOLVED:${topicKey}`);
      continue;
    }
    if (topic.evidenceRequirementStatus === "NOT_REVIEWED")
      blockers.add(`EVIDENCE_REQUIREMENTS_UNDEFINED:${topicKey}`);
    if (topic.policyRequirementStatus === "NOT_REVIEWED")
      blockers.add(`POLICY_REQUIREMENTS_UNDEFINED:${topicKey}`);
    if (topic.disposition === "REQUIRED" && topic.evidenceRequirementStatus === "REQUIREMENTS_SET") {
      for (const requiredType of topic.requiredEvidenceTypes) {
        const matching = evidence.filter(
          (item) =>
            item.topicKey === topicKey &&
            item.evidenceType === requiredType &&
            item.status !== "REJECTED" &&
            item.status !== "SUPERSEDED",
        );
        const versions = new Set(matching.map((item) => item.documentVersion));
        if (versions.size > 1)
          blockers.add(`EVIDENCE_VERSION_CONFLICT:${topicKey}:${requiredType}`);
        const acceptable = matching.some(
          (item) =>
            item.status === "COUNSEL_REVIEWED" &&
            (!item.expiresAt || item.expiresAt.valueOf() >= Date.now()),
        );
        if (!acceptable)
          blockers.add(`EVIDENCE_MISSING_OR_UNVERIFIED:${topicKey}:${requiredType}`);
      }
    }
    if (topic.disposition === "REQUIRED" && topic.policyRequirementStatus === "VERSIONS_SET") {
      for (const required of topic.requiredPolicyVersions) {
        const current = policies.some(
          (policy) =>
            policy.policyKey === required.policyKey &&
            policy.version === required.version,
        );
        if (!current)
          blockers.add(`POLICY_VERSION_NOT_PUBLISHED:${topicKey}:${required.policyKey}`);
      }
    }
    if (
      topicKey === "OPERATING_ENTITY" &&
      topic.disposition === "REQUIRED" &&
      legalEntity?.status !== "ACTIVE"
    )
      blockers.add("REQUIRED_LEGAL_ENTITY_NOT_ACTIVE");
  }
  for (const item of evidence) {
    if (
      item.status !== "REJECTED" &&
      item.status !== "SUPERSEDED" &&
      item.expiresAt &&
      item.expiresAt.valueOf() < Date.now()
    )
      blockers.add(`EVIDENCE_EXPIRED:${item.topicKey}:${item.evidenceType}`);
  }
  return [...blockers].sort();
}

function ownerApprovalBlockers(
  intake: typeof marketLegalIntakes.$inferSelect,
  content: string[],
) {
  const blockers = [...content];
  if (intake.reviewStatus !== "COUNSEL_REVIEWED")
    blockers.push("COUNSEL_REVIEW_NOT_COMPLETE");
  if (intake.counselApprovalStatus !== "APPROVED")
    blockers.push(intake.counselApprovalBlocker || "COUNSEL_APPROVAL_BLOCKED");
  if (intake.technicalVerificationStatus !== "PASSED")
    blockers.push("TECHNICAL_VERIFICATION_NOT_PASSED");
  return [...new Set(blockers)].sort();
}

function activationBlockers(
  intake: typeof marketLegalIntakes.$inferSelect,
  content: string[],
) {
  const blockers = ownerApprovalBlockers(intake, content);
  if (intake.ownerApprovalStatus !== "APPROVED")
    blockers.push("OWNER_APPROVAL_NOT_RECORDED");
  return [...new Set(blockers)].sort();
}

export async function listCountryLegalReadiness() {
  return Promise.all(
    supportedCountries.map(async (marketId) => {
      try {
        const detail = await getCountryLegalReadiness(marketId);
        return {
          marketId,
          countryCode: detail.market.countryCode,
          countryNameAr: detail.market.countryNameAr,
          countryNameEn: detail.market.countryNameEn,
          marketActive: detail.market.isActive,
          reviewStatus: detail.intake.reviewStatus,
          counselApprovalStatus: detail.intake.counselApprovalStatus,
          ownerApprovalStatus: detail.intake.ownerApprovalStatus,
          technicalVerificationStatus: detail.intake.technicalVerificationStatus,
          activationStatus: detail.intake.activationStatus,
          blockers: detail.blockers,
          topicCount: detail.topics.length,
          reviewedTopicCount: detail.topics.filter(
            (topic: { reviewStatus: string }) => topic.reviewStatus === "COUNSEL_REVIEWED",
          ).length,
        };
      } catch (error) {
        if (error instanceof CountryLegalReadinessError && error.status === 404) throw error;
        throw error;
      }
    }),
  );
}

export async function getCountryLegalReadiness(marketId: string) {
  const data = await readPackage(marketId);
  const content = contentBlockers(
    data.intake,
    data.topics,
    data.evidence,
    data.policies,
    data.legalEntity,
  );
  return {
    market: {
      id: data.market.id,
      countryCode: data.market.countryCode,
      countryNameAr: data.market.countryNameAr,
      countryNameEn: data.market.countryNameEn,
      isActive: data.market.isActive,
      status: data.market.status,
    },
    intake: intakeView(data.intake),
    topics: data.topics.map(topicView),
    evidence: data.evidence.map(evidenceView),
    publishedPolicyVersions: data.policies.map((policy: typeof policyRegistryVersions.$inferSelect) => ({
      policyKey: policy.policyKey,
      version: policy.version,
      marketScope: policy.marketScope,
      effectiveDate: policy.effectiveDate,
      contentSha256: policy.contentSha256,
    })),
    capabilities: data.capabilities.map((capability: typeof marketLegalCapabilityApprovals.$inferSelect) => ({
      capability: capability.capability,
      status: capability.status,
      enabled: capability.status === "ENABLED" && data.intake.activationStatus === "ACTIVE",
    })),
    blockers: activationBlockers(data.intake, content),
    events: data.events.map(eventView),
  };
}

export async function assertCountryActivationReady(marketId: string, tx: any = db) {
  const [intake] = await tx
    .select()
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.marketId, marketId))
    .limit(1);
  if (
    intake?.activationStatus !== "ACTIVE" ||
    intake.counselApprovalStatus !== "APPROVED" ||
    intake.ownerApprovalStatus !== "APPROVED" ||
    intake.technicalVerificationStatus !== "PASSED"
  )
    reject(
      409,
      "COUNTRY_INTAKE_NOT_ACTIVE",
      "السوق محجوب حتى تكتمل مراجعة المستشار والتحقق الفني وموافقة المالك والتفعيل المستقل",
    );
}

export async function submitCountryLegalEvidence(input: {
  actorId: string;
  marketId: string;
  topicKey: CountryLegalTopicKey;
  evidenceType: string;
  documentVersion: string;
  referenceCode: string;
  idempotencyKey: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
}) {
  const evidenceType = input.evidenceType.trim().toUpperCase();
  const documentVersion = input.documentVersion.trim();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(evidenceType))
    reject(400, "EVIDENCE_TYPE_INVALID", "نوع الدليل يجب أن يكون رمزاً واضحاً");
  if (!documentVersion || documentVersion.length > 80)
    reject(400, "EVIDENCE_VERSION_INVALID", "إصدار المستند غير صالح");
  const referenceCode = cleanReference(input.referenceCode, "مرجع الدليل");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))
    reject(400, "IDEMPOTENCY_KEY_INVALID", "مفتاح منع التكرار غير صالح");
  const issuedAt = input.issuedAt ? new Date(input.issuedAt) : null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if ([issuedAt, expiresAt].some((date) => date && Number.isNaN(date.valueOf())))
    reject(400, "EVIDENCE_DATE_INVALID", "تاريخ الدليل غير صالح");
  if (issuedAt && expiresAt && expiresAt < issuedAt)
    reject(400, "EVIDENCE_DATE_RANGE_INVALID", "تاريخ الانتهاء يسبق تاريخ الإصدار");

  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const topic = data.topics.find((item: typeof marketLegalIntakeTopics.$inferSelect) => item.topicKey === input.topicKey);
    if (!topic) reject(404, "COUNTRY_TOPIC_NOT_FOUND", "بند المراجعة غير موجود");
    const [existing] = await tx
      .select()
      .from(marketLegalEvidence)
      .where(
        and(
          eq(marketLegalEvidence.intakeId, data.intake.id),
          eq(marketLegalEvidence.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      const same =
        existing.topicKey === input.topicKey &&
        existing.evidenceType === evidenceType &&
        existing.documentVersion === documentVersion &&
        existing.referenceCode === referenceCode &&
        existing.issuedAt?.toISOString() === issuedAt?.toISOString() &&
        existing.expiresAt?.toISOString() === expiresAt?.toISOString();
      if (!same) reject(409, "IDEMPOTENCY_KEY_REUSED", "استُخدم مفتاح منع التكرار لبيانات مختلفة");
      return evidenceView(existing);
    }
    const [row] = await tx
      .insert(marketLegalEvidence)
      .values({
        id: randomUUID(),
        intakeId: data.intake.id,
        topicKey: input.topicKey,
        evidenceType,
        documentVersion,
        referenceCode,
        issuedAt,
        expiresAt,
        status: "SUBMITTED_UNVERIFIED",
        idempotencyKey: input.idempotencyKey,
        submittedBy: input.actorId,
        submittedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    await writeEvent(tx, {
      intakeId: data.intake.id,
      eventType: "EVIDENCE_SUBMITTED",
      actorId: input.actorId,
      topicKey: input.topicKey,
      evidenceId: row.id,
      toStatus: row.status,
      referenceCode,
    });
    return evidenceView(row);
  });
}

export async function reviewCountryLegalEvidence(input: {
  actorId: string;
  evidenceId: string;
  outcome: CountryEvidenceReview;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  requireDesignatedActor(
    input.actorId,
    "DINAR_COUNSEL_REVIEWER_IDS",
    env,
    "DESIGNATED_COUNSEL_REVIEWER_REQUIRED",
  );
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const [row] = await tx
      .select()
      .from(marketLegalEvidence)
      .where(eq(marketLegalEvidence.id, input.evidenceId))
      .for("update")
      .limit(1);
    if (!row) reject(404, "COUNTRY_EVIDENCE_NOT_FOUND", "مرجع الدليل غير موجود");
    if (row.status !== "SUBMITTED_UNVERIFIED")
      reject(409, "COUNTRY_EVIDENCE_ALREADY_REVIEWED", "مرجع الدليل عولج مسبقاً");
    const now = new Date();
    const status = input.outcome;
    const [updated] = await tx
      .update(marketLegalEvidence)
      .set({ status, reviewedBy: input.actorId, reviewedAt: now, updatedAt: now })
      .where(eq(marketLegalEvidence.id, row.id))
      .returning();
    await writeEvent(tx, {
      intakeId: row.intakeId,
      eventType: status === "COUNSEL_REVIEWED" ? "EVIDENCE_REVIEWED" : "EVIDENCE_REJECTED",
      actorId: input.actorId,
      topicKey: row.topicKey,
      evidenceId: row.id,
      fromStatus: row.status,
      toStatus: status,
      referenceCode: row.referenceCode,
    });
    return evidenceView(updated);
  });
}

export async function reviewCountryLegalTopic(input: {
  actorId: string;
  marketId: string;
  topicKey: CountryLegalTopicKey;
  disposition: CountryLegalDisposition;
  counselFinding: string;
  qualifications?: string | null;
  requiredAmendments?: string | null;
  officialReference: string;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  evidenceRequirementStatus: "REQUIREMENTS_SET" | "NO_REQUIREMENTS";
  requiredEvidenceTypes: string[];
  policyRequirementStatus: "VERSIONS_SET" | "NO_POLICY_REQUIREMENT";
  requiredPolicyVersions: Array<{ policyKey: string; version: string }>;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  requireDesignatedActor(
    input.actorId,
    "DINAR_COUNSEL_REVIEWER_IDS",
    env,
    "DESIGNATED_COUNSEL_REVIEWER_REQUIRED",
  );
  const finding = input.counselFinding.trim();
  const officialReference = cleanReference(input.officialReference, "المرجع الرسمي");
  if (finding.length < 3 || finding.length > 4000)
    reject(400, "COUNSEL_FINDING_INVALID", "ملخص نتيجة المستشار غير صالح");
  if (input.evidenceRequirementStatus === "REQUIREMENTS_SET" && !input.requiredEvidenceTypes.length)
    reject(400, "EVIDENCE_REQUIREMENTS_INVALID", "حدد أنواع الأدلة المطلوبة أو صرّح بعدم وجود متطلبات");
  if (input.evidenceRequirementStatus === "NO_REQUIREMENTS" && input.requiredEvidenceTypes.length)
    reject(400, "EVIDENCE_REQUIREMENTS_INVALID", "لا يمكن إدخال أنواع أدلة مع اختيار عدم وجود متطلبات");
  if (input.policyRequirementStatus === "VERSIONS_SET" && !input.requiredPolicyVersions.length)
    reject(400, "POLICY_REQUIREMENTS_INVALID", "حدد إصدارات السياسات المطلوبة أو صرّح بعدم وجودها");
  if (input.policyRequirementStatus === "NO_POLICY_REQUIREMENT" && input.requiredPolicyVersions.length)
    reject(400, "POLICY_REQUIREMENTS_INVALID", "لا يمكن إدخال إصدارات مع اختيار عدم وجود متطلب");
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  const effectiveUntil = input.effectiveUntil ? new Date(input.effectiveUntil) : null;
  if ([effectiveFrom, effectiveUntil].some((date) => date && Number.isNaN(date.valueOf())))
    reject(400, "LEGAL_EFFECTIVE_DATE_INVALID", "تاريخ النفاذ غير صالح");
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom)
    reject(400, "LEGAL_EFFECTIVE_DATE_RANGE_INVALID", "تاريخ انتهاء النفاذ يسبق بدايته");

  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    if (data.intake.reviewStatus !== "COUNSEL_REVIEW_REQUIRED")
      reject(409, "COUNSEL_REVIEW_NOT_REQUESTED", "يجب طلب مراجعة المستشار أولاً");
    const [topic] = await tx
      .select()
      .from(marketLegalIntakeTopics)
      .where(
        and(
          eq(marketLegalIntakeTopics.intakeId, data.intake.id),
          eq(marketLegalIntakeTopics.topicKey, input.topicKey),
        ),
      )
      .for("update")
      .limit(1);
    if (!topic) reject(404, "COUNTRY_TOPIC_NOT_FOUND", "بند المراجعة غير موجود");
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalIntakeTopics)
      .set({
        disposition: input.disposition,
        reviewStatus: "COUNSEL_REVIEWED",
        evidenceRequirementStatus: input.evidenceRequirementStatus,
        policyRequirementStatus: input.policyRequirementStatus,
        counselFinding: finding,
        qualifications: input.qualifications?.trim() || null,
        requiredAmendments: input.requiredAmendments?.trim() || null,
        officialReference,
        effectiveFrom,
        effectiveUntil,
        requiredEvidenceTypes: [...new Set(input.requiredEvidenceTypes.map((type) => type.trim().toUpperCase()))],
        requiredPolicyVersions: input.requiredPolicyVersions,
        reviewedBy: input.actorId,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(marketLegalIntakeTopics.id, topic.id))
      .returning();
    await writeEvent(tx, {
      intakeId: data.intake.id,
      eventType: "TOPIC_REVIEWED",
      actorId: input.actorId,
      topicKey: input.topicKey,
      fromStatus: topic.reviewStatus,
      toStatus: "COUNSEL_REVIEWED",
      referenceCode: officialReference,
    });
    return topicView(updated);
  });
}

export async function requestCountryCounselReview(input: {
  actorId: string;
  marketId: string;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    if (locked.reviewStatus === "COUNSEL_REVIEW_REQUIRED")
      reject(409, "COUNSEL_REVIEW_ALREADY_REQUESTED", "طلب مراجعة المستشار مفتوح بالفعل");
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalIntakes)
      .set({
        reviewStatus: "COUNSEL_REVIEW_REQUIRED",
        reviewRequestedBy: input.actorId,
        reviewRequestedAt: now,
        updatedAt: now,
      })
      .where(eq(marketLegalIntakes.id, locked.id))
      .returning();
    await writeEvent(tx, {
      intakeId: locked.id,
      eventType: "COUNSEL_REVIEW_REQUESTED",
      actorId: input.actorId,
      fromStatus: locked.reviewStatus,
      toStatus: "COUNSEL_REVIEW_REQUIRED",
    });
    return intakeView(updated);
  });
}

export async function recordCountryCounselReview(input: {
  actorId: string;
  marketId: string;
  referenceCode: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  requireDesignatedActor(
    input.actorId,
    "DINAR_COUNSEL_REVIEWER_IDS",
    env,
    "DESIGNATED_COUNSEL_REVIEWER_REQUIRED",
  );
  const referenceCode = cleanReference(input.referenceCode, "مرجع مراجعة المستشار");
  const result = await db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    if (locked.reviewStatus !== "COUNSEL_REVIEW_REQUIRED")
      reject(409, "COUNSEL_REVIEW_NOT_REQUESTED", "لا يوجد طلب مراجعة مستشار مفتوح");
    const content = contentBlockers(
      locked,
      data.topics,
      data.evidence,
      data.policies,
      data.legalEntity,
    );
    if (content.length) {
      await tx
        .update(marketLegalIntakes)
        .set({ reviewStatus: "BLOCKED", updatedAt: new Date() })
        .where(eq(marketLegalIntakes.id, locked.id));
      await writeEvent(tx, {
        intakeId: locked.id,
        eventType: "COUNSEL_REVIEW_RECORDED",
        actorId: input.actorId,
        fromStatus: locked.reviewStatus,
        toStatus: "BLOCKED",
        referenceCode,
      });
      return { blocked: true as const, blockers: content };
    }
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalIntakes)
      .set({
        reviewStatus: "COUNSEL_REVIEWED",
        counselReviewedBy: input.actorId,
        counselReviewedAt: now,
        counselReviewReference: referenceCode,
        counselApprovalStatus: "BLOCKED",
        counselApprovalBlocker: "COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE",
        updatedAt: now,
      })
      .where(eq(marketLegalIntakes.id, locked.id))
      .returning();
    await writeEvent(tx, {
      intakeId: locked.id,
      eventType: "COUNSEL_REVIEW_RECORDED",
      actorId: input.actorId,
      fromStatus: locked.reviewStatus,
      toStatus: "COUNSEL_REVIEWED",
      referenceCode,
    });
    return { blocked: false as const, intake: intakeView(updated) };
  });
  if (result.blocked)
    reject(409, "COUNSEL_REVIEW_CONTENT_INCOMPLETE", `المراجعة محجوبة: ${result.blockers.join(", ")}`);
  return result.intake;
}

export async function attemptCountryCounselApproval(input: {
  actorId: string;
  marketId: string;
  referenceCode: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  requireDesignatedActor(
    input.actorId,
    "DINAR_COUNSEL_APPROVER_IDS",
    env,
    "DESIGNATED_COUNSEL_APPROVER_REQUIRED",
  );
  const referenceCode = cleanReference(input.referenceCode, "مرجع طلب الموافقة");
  const result = await db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    if (locked.reviewStatus !== "COUNSEL_REVIEWED")
      reject(409, "COUNSEL_REVIEW_REQUIRED", "لا توجد مراجعة مكتملة للموافقة");
    if (locked.counselReviewedBy === input.actorId)
      reject(403, "SEPARATION_OF_DUTIES_REQUIRED", "يجب أن يكون معتمد المستشار شخصاً منفصلاً عن المراجع");
    await writeEvent(tx, {
      intakeId: locked.id,
      eventType: "COUNSEL_APPROVAL_BLOCKED",
      actorId: input.actorId,
      fromStatus: locked.counselApprovalStatus,
      toStatus: "BLOCKED",
      referenceCode,
    });
    return true;
  });
  if (result)
    reject(
      409,
      "COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE",
      "تم حجب الموافقة: لا توجد حالياً آلية موثوقة للتحقق من هوية المستشار وتوقيعه",
    );
}

export async function attemptCountryOwnerApproval(input: {
  actorId: string;
  marketId: string;
  referenceCode: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  if (!configuredIds(env.DINAR_LEGAL_OWNER_IDS).has(input.actorId))
    reject(403, "DESIGNATED_LEGAL_OWNER_REQUIRED", "الموافق غير معيّن لموافقة مالك جاسم");
  const referenceCode = cleanReference(input.referenceCode, "مرجع موافقة المالك");
  const result = await db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    if (
      input.actorId === locked.counselReviewedBy ||
      input.actorId === locked.counselApprovedBy
    )
      reject(403, "SEPARATION_OF_DUTIES_REQUIRED", "يجب فصل مراجعة المستشار عن موافقة المالك");
    const blockers = ownerApprovalBlockers(
      locked,
      contentBlockers(locked, data.topics, data.evidence, data.policies, data.legalEntity),
    );
    if (blockers.length) {
      await writeEvent(tx, {
        intakeId: locked.id,
        eventType: "OWNER_APPROVAL_BLOCKED",
        actorId: input.actorId,
        fromStatus: locked.ownerApprovalStatus,
        toStatus: "BLOCKED",
        referenceCode,
      });
      return { blockers };
    }
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalIntakes)
      .set({
        ownerApprovalStatus: "APPROVED",
        ownerApprovedBy: input.actorId,
        ownerApprovedAt: now,
        ownerApprovalReference: referenceCode,
        updatedAt: now,
      })
      .where(eq(marketLegalIntakes.id, locked.id))
      .returning();
    return { intake: intakeView(updated) };
  });
  if ("intake" in result) return result.intake;
  const blockers = (result as { blockers: string[] }).blockers;
  reject(409, "OWNER_APPROVAL_PREREQUISITES_MISSING", `موافقة المالك محجوبة: ${blockers.join(", ")}`);
}

export async function recordCountryTechnicalVerification(input: {
  actorId: string;
  marketId: string;
  referenceCode: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  requireDesignatedActor(
    input.actorId,
    "DINAR_LEGAL_TECHNICAL_VERIFIER_IDS",
    env,
    "DESIGNATED_TECHNICAL_VERIFIER_REQUIRED",
  );
  const referenceCode = cleanReference(input.referenceCode, "مرجع التحقق الفني");
  await db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    await writeEvent(tx, {
      intakeId: locked.id,
      eventType: "TECHNICAL_VERIFICATION_BLOCKED",
      actorId: input.actorId,
      fromStatus: locked.technicalVerificationStatus,
      toStatus: "NOT_RUN",
      referenceCode,
    });
  });
  reject(
    409,
    "TECHNICAL_ATTESTATION_UNAVAILABLE",
    "التحقق الفني محجوب حتى تتوفر شهادة اختبار موثوقة قابلة للتحقق آلياً",
  );
}

export async function activateCountryReadiness(input: {
  actorId: string;
  marketId: string;
  referenceCode: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  requireDesignatedActor(
    input.actorId,
    "DINAR_LEGAL_TECHNICAL_ACTIVATOR_IDS",
    env,
    "DESIGNATED_TECHNICAL_ACTIVATOR_REQUIRED",
  );
  const referenceCode = cleanReference(input.referenceCode, "مرجع التفعيل الفني");
  const result = await db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    const blockers = activationBlockers(
      locked,
      contentBlockers(locked, data.topics, data.evidence, data.policies, data.legalEntity),
    );
    if (blockers.length) {
      await writeEvent(tx, {
        intakeId: locked.id,
        eventType: "ACTIVATION_BLOCKED",
        actorId: input.actorId,
        fromStatus: locked.activationStatus,
        toStatus: locked.activationStatus,
        referenceCode,
      });
      return { blockers };
    }
    const now = new Date();
    const [updated] = await tx
      .update(marketLegalIntakes)
      .set({
        activationStatus: "ACTIVE",
        activatedBy: input.actorId,
        activatedAt: now,
        updatedAt: now,
      })
      .where(eq(marketLegalIntakes.id, locked.id))
      .returning();
    await writeEvent(tx, {
      intakeId: locked.id,
      eventType: "MARKET_ACTIVATED",
      actorId: input.actorId,
      fromStatus: locked.activationStatus,
      toStatus: "ACTIVE",
      referenceCode,
    });
    return { intake: intakeView(updated) };
  });
  if ("intake" in result) return result.intake;
  const blockers = (result as { blockers: string[] }).blockers;
  reject(409, "COUNTRY_ACTIVATION_PREREQUISITES_MISSING", `تفعيل السوق محجوب: ${blockers.join(", ")}`);
}

export async function suspendCountryReadiness(input: {
  actorId: string;
  marketId: string;
  referenceCode: string;
}) {
  const referenceCode = cleanReference(input.referenceCode, "مرجع الإيقاف");
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const data = await readPackage(input.marketId, tx);
    const [locked] = await tx
      .select()
      .from(marketLegalIntakes)
      .where(eq(marketLegalIntakes.id, data.intake.id))
      .for("update")
      .limit(1);
    const now = new Date();

    // Suspension is a new review boundary, not just a temporary access flag. Retire every
    // capability approval in the same transaction so a later country reactivation cannot revive
    // stale counsel or owner approvals.
    const capabilities = await tx
      .select()
      .from(marketLegalCapabilityApprovals)
      .where(eq(marketLegalCapabilityApprovals.marketId, input.marketId))
      .for("update");
    for (const capability of capabilities) {
      const hasApproval =
        capability.status !== "DISABLED" ||
        capability.counselReference !== null ||
        capability.counselReviewedBy !== null ||
        capability.ownerApprovalReference !== null ||
        capability.ownerApprovedBy !== null;
      if (!hasApproval) continue;
      await tx
        .update(marketLegalCapabilityApprovals)
        .set({
          status: "DISABLED",
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
            eq(marketLegalCapabilityApprovals.id, capability.id),
            eq(marketLegalCapabilityApprovals.status, capability.status),
          ),
        );
      await tx.insert(marketLegalCapabilityEvents).values({
        id: randomUUID(),
        marketId: input.marketId,
        capability: capability.capability,
        eventType: "CAPABILITY_DISABLED",
        fromStatus: capability.status,
        toStatus: "DISABLED",
        actorId: input.actorId,
        reference: referenceCode,
        createdAt: now,
      });
    }

    const [updated] = await tx
      .update(marketLegalIntakes)
      .set({
        activationStatus: "SUSPENDED",
        reviewStatus: "NOT_REVIEWED",
        counselReviewedBy: null,
        counselReviewedAt: null,
        counselReviewReference: null,
        counselApprovalStatus: "BLOCKED",
        counselApprovalBlocker: "COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE",
        counselApprovedBy: null,
        counselApprovedAt: null,
        counselApprovalReference: null,
        ownerApprovalStatus: "BLOCKED",
        ownerApprovedBy: null,
        ownerApprovedAt: null,
        ownerApprovalReference: null,
        technicalVerificationStatus: "NOT_RUN",
        technicalVerifiedBy: null,
        technicalVerifiedAt: null,
        technicalVerificationReference: null,
        suspendedBy: input.actorId,
        suspendedAt: now,
        suspensionReference: referenceCode,
        updatedAt: now,
      })
      .where(eq(marketLegalIntakes.id, locked.id))
      .returning();
    if (locked.counselApprovalStatus !== "BLOCKED") {
      await writeEvent(tx, {
        intakeId: locked.id,
        eventType: "COUNSEL_APPROVAL_BLOCKED",
        actorId: input.actorId,
        fromStatus: locked.counselApprovalStatus,
        toStatus: "BLOCKED",
        referenceCode,
      });
    }
    if (locked.ownerApprovalStatus !== "BLOCKED") {
      await writeEvent(tx, {
        intakeId: locked.id,
        eventType: "OWNER_APPROVAL_BLOCKED",
        actorId: input.actorId,
        fromStatus: locked.ownerApprovalStatus,
        toStatus: "BLOCKED",
        referenceCode,
      });
    }
    if (locked.technicalVerificationStatus !== "NOT_RUN") {
      await writeEvent(tx, {
        intakeId: locked.id,
        eventType: "TECHNICAL_VERIFICATION_BLOCKED",
        actorId: input.actorId,
        fromStatus: locked.technicalVerificationStatus,
        toStatus: "NOT_RUN",
        referenceCode,
      });
    }
    await writeEvent(tx, {
      intakeId: locked.id,
      eventType: "MARKET_SUSPENDED",
      actorId: input.actorId,
      fromStatus: locked.activationStatus,
      toStatus: "SUSPENDED",
      referenceCode,
    });
    return intakeView(updated);
  });
}
