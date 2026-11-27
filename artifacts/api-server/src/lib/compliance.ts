import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  legalEntities,
  marketComplianceSettings,
  markets,
  minorProtectionDeclarations,
  sellerVerificationProfiles,
} from "@workspace/db";
import { assertAdminActor } from "./admin-authority";

/**
 * Wave 09: market compliance. Every safeguard here is off until an operator turns it on for a
 * specific market, and no migration seeds a legal entity, a verified seller or a guardian
 * consent. Nothing in this module asserts regulatory compliance; it records decisions.
 */
export class ComplianceError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ComplianceError";
  }
}

function reject(status: number, code: string, message: string): never {
  throw new ComplianceError(message, status, code);
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** Capabilities a legal entity can hold. Commerce only consumes MARKETPLACE and PAYMENTS today. */
export const LEGAL_ENTITY_CAPABILITIES = [
  "MARKETPLACE",
  "PAYMENTS",
  "COMMISSION",
  "SUPPORT",
  "DATA_CONTROLLER",
] as const;
export type LegalEntityCapability = (typeof LEGAL_ENTITY_CAPABILITIES)[number];

export const ENTITY_TYPES = ["COMPANY", "INDIVIDUAL", "PARTNERSHIP"] as const;

const DEFAULT_SETTINGS = {
  sellerVerificationRequired: false,
  minorProtectionEnabled: false,
  minimumAge: 18,
  guardianConsentRequired: false,
  legalEntityRequired: false,
} as const;

type SettingsRow = typeof marketComplianceSettings.$inferSelect;

export function complianceSettingsView(
  marketId: string,
  row: SettingsRow | undefined,
) {
  const value = row ?? { ...DEFAULT_SETTINGS };
  return {
    marketId,
    sellerVerificationRequired: value.sellerVerificationRequired,
    minorProtectionEnabled: value.minorProtectionEnabled,
    minimumAge: value.minimumAge,
    guardianConsentRequired: value.guardianConsentRequired,
    legalEntityRequired: value.legalEntityRequired,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    /** Absence of a row is meaningful: every safeguard is off, not "approved". */
    configured: Boolean(row),
  };
}

export async function complianceSettings(marketId: string, tx: any = db) {
  const [row] = await tx
    .select()
    .from(marketComplianceSettings)
    .where(eq(marketComplianceSettings.marketId, marketId));
  return complianceSettingsView(marketId, row);
}

async function requireMarket(marketId: string, tx: any = db) {
  const [row] = await tx
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!row) reject(404, "MARKET_NOT_FOUND", "السوق غير موجود");
}

export async function updateComplianceSettings(input: {
  actorId: string;
  marketId: string;
  patch: {
    sellerVerificationRequired?: boolean;
    minorProtectionEnabled?: boolean;
    minimumAge?: number;
    guardianConsentRequired?: boolean;
    legalEntityRequired?: boolean;
  };
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    await requireMarket(input.marketId, tx);
    const [existing] = await tx
      .select()
      .from(marketComplianceSettings)
      .where(eq(marketComplianceSettings.marketId, input.marketId))
      .for("update");
    const base = existing ?? { ...DEFAULT_SETTINGS };
    const next = {
      sellerVerificationRequired:
        input.patch.sellerVerificationRequired ??
        base.sellerVerificationRequired,
      minorProtectionEnabled:
        input.patch.minorProtectionEnabled ?? base.minorProtectionEnabled,
      minimumAge: input.patch.minimumAge ?? base.minimumAge,
      guardianConsentRequired:
        input.patch.guardianConsentRequired ?? base.guardianConsentRequired,
      legalEntityRequired:
        input.patch.legalEntityRequired ?? base.legalEntityRequired,
    };
    if (next.minimumAge < 13 || next.minimumAge > 21)
      reject(400, "MINIMUM_AGE_OUT_OF_RANGE", "العمر الأدنى يجب أن يكون بين 13 و21");
    if (next.guardianConsentRequired && !next.minorProtectionEnabled)
      reject(
        409,
        "GUARDIAN_REQUIRES_MINOR_PROTECTION",
        "موافقة ولي الأمر لا تُفعّل دون حماية القُصّر",
      );
    const now = new Date();
    if (existing) {
      await tx
        .update(marketComplianceSettings)
        .set({ ...next, updatedBy: input.actorId, updatedAt: now })
        .where(eq(marketComplianceSettings.marketId, input.marketId));
    } else {
      await tx.insert(marketComplianceSettings).values({
        marketId: input.marketId,
        ...next,
        updatedBy: input.actorId,
        createdAt: now,
        updatedAt: now,
      });
    }
    const [saved] = await tx
      .select()
      .from(marketComplianceSettings)
      .where(eq(marketComplianceSettings.marketId, input.marketId));
    return complianceSettingsView(input.marketId, saved);
  });
}

// ─── Legal entity registry ───────────────────────────────────────────────────

type EntityRow = typeof legalEntities.$inferSelect;

export function legalEntityView(row: EntityRow) {
  return {
    marketId: row.marketId,
    legalName: row.legalName,
    entityType: row.entityType,
    registrationCountry: row.registrationCountry,
    status: row.status,
    capabilities: row.capabilities,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
  };
}

export async function legalEntityFor(marketId: string, tx: any = db) {
  const [row] = await tx
    .select()
    .from(legalEntities)
    .where(eq(legalEntities.marketId, marketId));
  return row as EntityRow | undefined;
}

export async function listLegalEntities() {
  const rows = await db.select().from(legalEntities).orderBy(legalEntities.marketId);
  return rows.map(legalEntityView);
}

export async function createLegalEntity(input: {
  actorId: string;
  marketId: string;
  legalName: string;
  entityType: (typeof ENTITY_TYPES)[number];
  registrationCountry: string;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    await requireMarket(input.marketId, tx);
    const legalName = input.legalName.trim();
    if (legalName.length < 2 || legalName.length > 200)
      reject(400, "LEGAL_NAME_INVALID", "اسم الكيان القانوني غير صالح");
    if (!ENTITY_TYPES.includes(input.entityType))
      reject(400, "ENTITY_TYPE_INVALID", "نوع الكيان غير معروف");
    if (!/^[A-Z]{2}$/.test(input.registrationCountry))
      reject(400, "COUNTRY_INVALID", "رمز دولة التسجيل غير صالح");
    if (await legalEntityFor(input.marketId, tx))
      reject(409, "LEGAL_ENTITY_EXISTS", "لهذا السوق كيان قانوني مسجل بالفعل");
    const now = new Date();
    const [created] = await tx
      .insert(legalEntities)
      .values({
        id: randomUUID(),
        marketId: input.marketId,
        legalName,
        entityType: input.entityType,
        registrationCountry: input.registrationCountry,
        status: "DISABLED",
        capabilities: [],
        createdBy: input.actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return legalEntityView(created);
  });
}

function normalizeCapabilities(raw: readonly string[]) {
  const unique = [...new Set(raw)];
  for (const capability of unique)
    if (!LEGAL_ENTITY_CAPABILITIES.includes(capability as LegalEntityCapability))
      reject(400, "CAPABILITY_INVALID", `الصلاحية «${capability}» غير معروفة`);
  if (!unique.length)
    reject(400, "CAPABILITY_REQUIRED", "التفعيل يحتاج صلاحية واحدة على الأقل");
  return unique;
}

export async function activateLegalEntity(input: {
  actorId: string;
  marketId: string;
  capabilities: readonly string[];
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const [row] = await tx
      .select()
      .from(legalEntities)
      .where(eq(legalEntities.marketId, input.marketId))
      .for("update");
    if (!row) reject(404, "LEGAL_ENTITY_NOT_FOUND", "لا يوجد كيان قانوني لهذا السوق");
    if (row.status === "ACTIVE")
      reject(409, "LEGAL_ENTITY_ALREADY_ACTIVE", "الكيان القانوني مفعّل بالفعل");
    const capabilities = normalizeCapabilities(input.capabilities);
    const now = new Date();
    const [updated] = await tx
      .update(legalEntities)
      .set({
        status: "ACTIVE",
        capabilities,
        activatedAt: now,
        activatedBy: input.actorId,
        updatedAt: now,
      })
      .where(eq(legalEntities.id, row.id))
      .returning();
    return legalEntityView(updated);
  });
}

export async function deactivateLegalEntity(input: {
  actorId: string;
  marketId: string;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const [row] = await tx
      .select()
      .from(legalEntities)
      .where(eq(legalEntities.marketId, input.marketId))
      .for("update");
    if (!row) reject(404, "LEGAL_ENTITY_NOT_FOUND", "لا يوجد كيان قانوني لهذا السوق");
    if (row.status !== "ACTIVE")
      reject(409, "LEGAL_ENTITY_NOT_ACTIVE", "الكيان القانوني غير مفعّل");
    const now = new Date();
    const [updated] = await tx
      .update(legalEntities)
      .set({
        status: "DISABLED",
        deactivatedAt: now,
        deactivatedBy: input.actorId,
        updatedAt: now,
      })
      .where(eq(legalEntities.id, row.id))
      .returning();
    return legalEntityView(updated);
  });
}

/** Enforces the entity gate only where a market explicitly opted in, never silently. */
export async function requireCommercialCapability(
  marketId: string,
  capability: LegalEntityCapability,
  tx: any = db,
) {
  const settings = await complianceSettings(marketId, tx);
  if (!settings.legalEntityRequired)
    return { enforced: false as const, capability };
  const entity = await legalEntityFor(marketId, tx);
  if (!entity)
    reject(
      409,
      "LEGAL_ENTITY_REQUIRED",
      "لم يُفعّل كيان قانوني لهذا السوق بعد؛ النشاط التجاري غير متاح",
    );
  if (entity.status !== "ACTIVE" || !entity.capabilities.includes(capability))
    reject(
      409,
      "COMMERCIAL_CAPABILITY_NOT_ACTIVATED",
      `صلاحية «${capability}» غير مفعّلة لهذا السوق`,
    );
  return { enforced: true as const, capability };
}

// ─── Seller verification ─────────────────────────────────────────────────────

type VerificationRow = typeof sellerVerificationProfiles.$inferSelect;

export function sellerVerificationView(row: VerificationRow) {
  return {
    id: row.id,
    marketId: row.marketId,
    requestedLevel: row.requestedLevel,
    status: row.status,
    riskBasis: row.riskBasis,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
  };
}

export async function latestSellerVerification(
  userId: string,
  marketId: string,
  tx: any = db,
) {
  const [row] = await tx
    .select()
    .from(sellerVerificationProfiles)
    .where(
      and(
        eq(sellerVerificationProfiles.userId, userId),
        eq(sellerVerificationProfiles.marketId, marketId),
      ),
    )
    .orderBy(desc(sellerVerificationProfiles.createdAt))
    .limit(1);
  return row as VerificationRow | undefined;
}

export async function sellerVerificationStatus(
  userId: string,
  marketId: string,
) {
  const row = await latestSellerVerification(userId, marketId);
  return {
    marketId,
    required: (await complianceSettings(marketId)).sellerVerificationRequired,
    profile: row ? sellerVerificationView(row) : null,
  };
}

export async function submitSellerVerification(input: {
  userId: string;
  marketId: string;
  requestedLevel: "BASIC" | "ENHANCED";
  evidenceRefs?: string[];
  idempotencyKey: string;
}) {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
    reject(400, "IDEMPOTENCY_KEY_REQUIRED", "مفتاح طلب غير صالح");
  if (!["BASIC", "ENHANCED"].includes(input.requestedLevel))
    reject(400, "VERIFICATION_LEVEL_INVALID", "مستوى التوثيق غير معروف");
  const evidenceRefs = (input.evidenceRefs ?? []).map((item) => item.trim());
  if (evidenceRefs.length > 5 || evidenceRefs.some((item) => !item || item.length > 200))
    reject(400, "EVIDENCE_INVALID", "المراجع المرفقة غير صالحة");
  return db.transaction(async (tx) => {
    await requireMarket(input.marketId, tx);
    const [existing] = await tx
      .select()
      .from(sellerVerificationProfiles)
      .where(
        and(
          eq(sellerVerificationProfiles.userId, input.userId),
          eq(sellerVerificationProfiles.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      if (
        existing.marketId !== input.marketId ||
        existing.requestedLevel !== input.requestedLevel
      )
        reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لطلب توثيق مختلف");
      return { profile: sellerVerificationView(existing), created: false };
    }
    const now = new Date();
    const [created] = await tx
      .insert(sellerVerificationProfiles)
      .values({
        id: randomUUID(),
        userId: input.userId,
        marketId: input.marketId,
        requestedLevel: input.requestedLevel,
        status: "PENDING",
        riskBasis: "UNASSESSED",
        evidenceRefs,
        submittedAt: now,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { profile: sellerVerificationView(created), created: true };
  });
}

export async function decideSellerVerification(input: {
  actorId: string;
  id: string;
  decision: "VERIFIED" | "REJECTED";
  riskBasis?: "LOW" | "MEDIUM" | "HIGH";
  reason?: string;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const [row] = await tx
      .select()
      .from(sellerVerificationProfiles)
      .where(eq(sellerVerificationProfiles.id, input.id))
      .for("update");
    if (!row)
      reject(404, "VERIFICATION_NOT_FOUND", "طلب التوثيق غير موجود");
    if (row.userId === input.actorId)
      reject(403, "SELF_VERIFICATION_FORBIDDEN", "لا يوثّق البائع نفسه");
    if (row.status !== "PENDING")
      reject(409, "VERIFICATION_ALREADY_DECIDED", "تم البت في طلب التوثيق مسبقًا");
    const reason = input.reason?.trim() ?? "";
    if (input.decision === "REJECTED" && reason.length < 3)
      reject(400, "REJECTION_REASON_REQUIRED", "رفض التوثيق يحتاج سببًا مكتوبًا");
    if (input.decision === "VERIFIED" && !input.riskBasis)
      reject(
        400,
        "RISK_BASIS_REQUIRED",
        "قبول التوثيق يحتاج أساس مخاطر محددًا، لا يُفترض تلقائيًا",
      );
    const now = new Date();
    const [updated] = await tx
      .update(sellerVerificationProfiles)
      .set({
        status: input.decision,
        riskBasis:
          input.decision === "VERIFIED" && input.riskBasis
            ? input.riskBasis
            : row.riskBasis,
        decidedAt: now,
        decidedBy: input.actorId,
        decisionReason: reason || null,
        updatedAt: now,
      })
      .where(eq(sellerVerificationProfiles.id, row.id))
      .returning();
    return sellerVerificationView(updated);
  });
}

export async function sellerVerificationQueue(status: "PENDING" | "VERIFIED" | "REJECTED" = "PENDING") {
  const rows = await db
    .select()
    .from(sellerVerificationProfiles)
    .where(eq(sellerVerificationProfiles.status, status))
    .orderBy(sellerVerificationProfiles.submittedAt)
    .limit(100);
  return rows.map((row) => ({ ...sellerVerificationView(row), userId: row.userId }));
}

/** Gate used when a market requires verification: only a human decision counts as evidence. */
export async function assertSellerVerification(
  userId: string,
  marketId: string,
  tx: any = db,
) {
  const settings = await complianceSettings(marketId, tx);
  if (!settings.sellerVerificationRequired)
    return { required: false as const };
  const [verified] = await tx
    .select({ id: sellerVerificationProfiles.id })
    .from(sellerVerificationProfiles)
    .where(
      and(
        eq(sellerVerificationProfiles.userId, userId),
        eq(sellerVerificationProfiles.marketId, marketId),
        eq(sellerVerificationProfiles.status, "VERIFIED"),
      ),
    )
    .limit(1);
  if (!verified)
    reject(
      403,
      "SELLER_VERIFICATION_REQUIRED",
      "النشر واستقبال الطلبات في هذا السوق يتطلب توثيق البائع",
    );
  return { required: true as const };
}

// ─── Minor protection ────────────────────────────────────────────────────────

type DeclarationRow = typeof minorProtectionDeclarations.$inferSelect;

export function minorDeclarationView(row: DeclarationRow | undefined) {
  if (!row) return null;
  return {
    declaredStatus: row.declaredStatus,
    guardianStatus: row.guardianStatus,
    source: row.source,
    decidedAt: row.guardianDecidedAt?.toISOString() ?? null,
    declaredAt: row.createdAt.toISOString(),
  };
}

export async function latestMinorDeclaration(
  userId: string,
  marketId: string,
  tx: any = db,
) {
  const [row] = await tx
    .select()
    .from(minorProtectionDeclarations)
    .where(
      and(
        eq(minorProtectionDeclarations.userId, userId),
        eq(minorProtectionDeclarations.marketId, marketId),
      ),
    )
    .orderBy(desc(minorProtectionDeclarations.createdAt))
    .limit(1);
  return row as DeclarationRow | undefined;
}

/**
 * A self-declaration is append-only. A recorded MINOR status cannot be overwritten by a later
 * "adult" claim, and a guardian decision is never replaced by a fresh self-declaration.
 */
export async function declareAgeStatus(input: {
  userId: string;
  marketId: string;
  declaredStatus: "ADULT" | "MINOR";
  idempotencyKey: string;
}) {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
    reject(400, "IDEMPOTENCY_KEY_REQUIRED", "مفتاح طلب غير صالح");
  if (!["ADULT", "MINOR"].includes(input.declaredStatus))
    reject(400, "AGE_STATUS_INVALID", "الحالة العمرية غير معروفة");
  return db.transaction(async (tx) => {
    await requireMarket(input.marketId, tx);
    const settings = await complianceSettings(input.marketId, tx);
    const latest = await latestMinorDeclaration(input.userId, input.marketId, tx);
    const [existing] = await tx
      .select()
      .from(minorProtectionDeclarations)
      .where(
        and(
          eq(minorProtectionDeclarations.userId, input.userId),
          eq(minorProtectionDeclarations.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      if (
        existing.marketId !== input.marketId ||
        existing.declaredStatus !== input.declaredStatus
      )
        reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لإقرار مختلف");
      return { declaration: minorDeclarationView(existing)!, created: false };
    }
    if (latest?.source === "GUARDIAN_VERIFICATION")
      reject(
        409,
        "AGE_STATUS_ALREADY_DECIDED",
        "قرار ولي الأمر مسجل ولا يُستبدل بإقرار ذاتي",
      );
    if (latest?.declaredStatus === "MINOR" && input.declaredStatus === "ADULT")
      reject(
        409,
        "AGE_STATUS_LOCKED",
        "سُجلت حالتك كقاصر؛ لا يمكن تغييرها بإقرار ذاتي",
      );
    if (
      input.declaredStatus === "MINOR" &&
      !settings.minorProtectionEnabled
    )
      reject(
        409,
        "MINOR_PROTECTION_NOT_ENABLED",
        "حماية القُصّر غير مفعّلة في هذا السوق بعد",
      );
    const now = new Date();
    const [created] = await tx
      .insert(minorProtectionDeclarations)
      .values({
        id: randomUUID(),
        userId: input.userId,
        marketId: input.marketId,
        declaredStatus: input.declaredStatus,
        guardianStatus:
          input.declaredStatus === "ADULT"
            ? "NOT_REQUIRED"
            : settings.guardianConsentRequired
              ? "PENDING"
              : "NOT_REQUIRED",
        source: "SELF_DECLARATION",
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      })
      .returning();
    return { declaration: minorDeclarationView(created)!, created: true };
  });
}

/** Only a guardian account, distinct from the minor, can record this decision. */
export async function recordGuardianConsent(input: {
  guardianId: string;
  userId: string;
  marketId: string;
  decision: "GRANTED" | "DENIED";
  guardianReference: string;
  idempotencyKey: string;
}) {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
    reject(400, "IDEMPOTENCY_KEY_REQUIRED", "مفتاح طلب غير صالح");
  if (input.guardianId === input.userId)
    reject(403, "GUARDIAN_ACTOR_INVALID", "لا يسجل المستخدم موافقة ولي أمره بنفسه");
  if (!["GRANTED", "DENIED"].includes(input.decision))
    reject(400, "GUARDIAN_DECISION_INVALID", "قرار ولي الأمر غير معروف");
  const reference = input.guardianReference?.trim() ?? "";
  if (reference.length < 3 || reference.length > 200)
    reject(
      400,
      "GUARDIAN_REFERENCE_REQUIRED",
      "يجب إرفاق مرجع موثق لقرار ولي الأمر",
    );
  return db.transaction(async (tx) => {
    await requireMarket(input.marketId, tx);
    const [existing] = await tx
      .select()
      .from(minorProtectionDeclarations)
      .where(
        and(
          eq(minorProtectionDeclarations.userId, input.userId),
          eq(minorProtectionDeclarations.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      if (
        existing.marketId !== input.marketId ||
        existing.source !== "GUARDIAN_VERIFICATION"
      )
        reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لقرار مختلف");
      return { declaration: minorDeclarationView(existing)!, created: false };
    }
    const latest = await latestMinorDeclaration(input.userId, input.marketId, tx);
    if (!latest || latest.declaredStatus !== "MINOR")
      reject(
        409,
        "AGE_STATUS_NOT_MINOR",
        "لا يوجد إقرار بأن المستخدم قاصر في هذا السوق",
      );
    if (latest.source === "GUARDIAN_VERIFICATION")
      reject(409, "GUARDIAN_DECISION_EXISTS", "قرار ولي الأمر مسجل مسبقًا");
    const now = new Date();
    const [created] = await tx
      .insert(minorProtectionDeclarations)
      .values({
        id: randomUUID(),
        userId: input.userId,
        marketId: input.marketId,
        declaredStatus: "MINOR",
        guardianStatus: input.decision,
        guardianReferenceSha256: createHash("sha256")
          .update(reference)
          .digest("hex"),
        guardianDecidedAt: now,
        source: "GUARDIAN_VERIFICATION",
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      })
      .returning();
    return { declaration: minorDeclarationView(created)!, created: true };
  });
}

/**
 * Commerce gate. When protection is enabled, an adult declaration passes; a minor passes only
 * with a recorded guardian GRANT, and is blocked outright when the market does not run a
 * guardian flow. No age is inferred from any other data.
 */
export async function assertMinorProtection(
  userId: string,
  marketId: string,
  tx: any = db,
) {
  const settings = await complianceSettings(marketId, tx);
  if (!settings.minorProtectionEnabled)
    return { enabled: false as const };
  const latest = await latestMinorDeclaration(userId, marketId, tx);
  if (!latest)
    reject(
      403,
      "AGE_DECLARATION_REQUIRED",
      "يجب إقرار الحالة العمرية قبل استخدام الخدمة في هذا السوق",
    );
  if (latest!.declaredStatus === "ADULT")
    return { enabled: true as const, status: "ADULT" as const };
  if (!settings.guardianConsentRequired)
    reject(
      403,
      "MINOR_COMMERCE_BLOCKED",
      "لا يمكن إتمام نشاط تجاري لحساب قاصر في هذا السوق",
    );
  if (latest!.guardianStatus === "GRANTED")
    return { enabled: true as const, status: "MINOR_WITH_GUARDIAN" as const };
  if (latest!.guardianStatus === "DENIED")
    reject(403, "GUARDIAN_CONSENT_DENIED", "لم تُمنح موافقة ولي الأمر");
  reject(
    403,
    "GUARDIAN_CONSENT_REQUIRED",
    "يلزم إتمام موافقة ولي الأمر قبل النشاط التجاري",
  );
}

export async function minorProtectionStatus(userId: string, marketId: string) {
  const settings = await complianceSettings(marketId);
  const latest = await latestMinorDeclaration(userId, marketId);
  return {
    marketId,
    enabled: settings.minorProtectionEnabled,
    guardianConsentRequired: settings.guardianConsentRequired,
    minimumAge: settings.minimumAge,
    declaration: minorDeclarationView(latest),
    commercialAccess:
      !settings.minorProtectionEnabled
        ? "NOT_GATED"
        : !latest
          ? "DECLARATION_REQUIRED"
          : latest.declaredStatus === "ADULT"
            ? "ALLOWED"
            : latest.guardianStatus === "GRANTED"
              ? "ALLOWED_WITH_GUARDIAN"
              : latest.guardianStatus === "DENIED"
                ? "DENIED"
                : "GUARDIAN_PENDING",
  };
}

export async function marketComplianceOverview() {
  const [settingsRows, entityRows, marketRows] = await Promise.all([
    db.select().from(marketComplianceSettings),
    db.select().from(legalEntities),
    db.select({ id: markets.id, currencyCode: markets.currencyCode, status: markets.status, isActive: markets.isActive }).from(markets),
  ]);
  const settingsByMarket = new Map(settingsRows.map((row) => [row.marketId, row]));
  const entityByMarket = new Map(entityRows.map((row) => [row.marketId, row]));
  return marketRows.map((market) => ({
    currencyCode: market.currencyCode,
    marketActive: (market.isActive && ["ACTIVE", "LIMITED"].includes(market.status)) || (market as { operationMode?: string }).operationMode === "PRE_LEGAL",
    ...complianceSettingsView(market.id, settingsByMarket.get(market.id)),
    legalEntity: entityByMarket.has(market.id)
      ? legalEntityView(entityByMarket.get(market.id)!)
      : null,
    /** Nothing below is a legal approval; it is what the registry currently records. */
    commercialActivation: "REQUIRES_OWNER_AUTHORIZATION",
  }));
}
