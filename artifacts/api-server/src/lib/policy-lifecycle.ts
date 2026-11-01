import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  markets,
  policyAcceptances,
  policyConsentEvents,
  policyRegistryVersions,
} from "@workspace/db";
import { assertAdminActor } from "./admin-authority";
import {
  currentPolicies,
  currentPolicy,
  type PolicyDocument,
} from "./policies";

/**
 * Wave 09: lifecycle and consent authority for policies. Wording stays in lib/policies.ts
 * (PENDING_LEGAL_APPROVAL until counsel signs off). This module never writes legal text and
 * never turns a model response into consent: only an explicit user decision with a server-
 * derived source is recorded.
 */
export class PolicyLifecycleError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PolicyLifecycleError";
  }
}

function reject(status: number, code: string, message: string): never {
  throw new PolicyLifecycleError(message, status, code);
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Deterministic content hash: section order is part of what a person accepted. */
export function policyContentSha256(document: PolicyDocument) {
  return sha256(
    JSON.stringify({
      key: document.key,
      version: document.version,
      effectiveDate: document.effectiveDate,
      titleAr: document.titleAr,
      titleEn: document.titleEn,
      summaryAr: document.summaryAr,
      requiresAcceptance: document.requiresAcceptance,
      sections: document.sections.map(({ heading, body }) => ({ heading, body })),
    }),
  );
}

export function policyRegistryView(
  row: typeof policyRegistryVersions.$inferSelect,
) {
  return {
    id: row.id,
    key: row.policyKey,
    version: row.version,
    lifecycle: row.lifecycle,
    contentSha256: row.contentSha256,
    effectiveDate: row.effectiveDate,
    marketScope: row.marketScope,
    requiresAcceptance: row.requiresAcceptance,
    materialChange: row.materialChange,
    legalReference: row.legalReference,
    registeredBy: row.registeredBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
  };
}

export function policyConsentEventView(
  row: typeof policyConsentEvents.$inferSelect,
) {
  return {
    id: row.id,
    key: row.policyKey,
    version: row.policyVersion,
    contentSha256: row.contentSha256,
    decision: row.decision,
    source: row.source,
    decidedAt: row.createdAt.toISOString(),
  };
}

async function registryRow(
  tx: any,
  key: string,
  version: string,
  scope = "GLOBAL",
) {
  const [row] = await tx
    .select()
    .from(policyRegistryVersions)
    .where(
      and(
        eq(policyRegistryVersions.policyKey, key),
        eq(policyRegistryVersions.version, version),
        eq(policyRegistryVersions.marketScope, scope),
      ),
    );
  return row as typeof policyRegistryVersions.$inferSelect | undefined;
}

async function publishedVersion(tx: any, key: string, scope = "GLOBAL") {
  const [row] = await tx
    .select()
    .from(policyRegistryVersions)
    .where(
      and(
        eq(policyRegistryVersions.policyKey, key),
        eq(policyRegistryVersions.lifecycle, "PUBLISHED"),
        eq(policyRegistryVersions.marketScope, scope),
      ),
    )
    .limit(1);
  return row as typeof policyRegistryVersions.$inferSelect | undefined;
}

/**
 * Transitional rule: until a published registry version exists, the current built-in
 * document is the accepted wording (today it is explicitly PENDING_LEGAL_APPROVAL). Once a
 * version is published, only that version can be accepted.
 */
async function acceptanceVersion(tx: any, document: PolicyDocument) {
  return (await publishedVersion(tx, document.key))?.version ?? document.version;
}

/**
 * The one answer to "which version of each required policy must this user have accepted?",
 * shared by the W09 consent API and the commerce gate (lib/policy-gate.ts): the registry's
 * PUBLISHED version when there is one, else the wording's own version in lib/policies.ts.
 */
export async function requiredAcceptanceVersions(tx: any = db): Promise<Array<{ document: PolicyDocument; version: string }>> {
  const required = currentPolicies().filter((document) => document.requiresAcceptance);
  return Promise.all(required.map(async (document) => ({ document, version: await acceptanceVersion(tx, document) })));
}

export async function policyLifecycleFor(
  key: string,
  version: string,
  scope = "GLOBAL",
) {
  return policyRegistryViewOrNull(
    await registryRow(db, key, version, scope),
  );
}

function policyRegistryViewOrNull(
  row: typeof policyRegistryVersions.$inferSelect | undefined,
) {
  return row ? policyRegistryView(row) : null;
}

export async function registerPolicyVersion(input: {
  actorId: string;
  key: string;
  version: string;
  marketScope?: string;
  materialChange?: boolean;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const document = currentPolicy(input.key);
    if (!document) reject(404, "POLICY_NOT_FOUND", "السياسة غير معروفة");
    if (input.version !== document.version)
      reject(
        409,
        "UNKNOWN_POLICY_VERSION",
        "لا يمكن تسجيل نسخة لا توجد صياغتها المعتمدة في الكود",
      );
    const scope = input.marketScope ?? "GLOBAL";
    if (scope !== "GLOBAL") {
      const [market] = await tx
        .select({ id: markets.id })
        .from(markets)
        .where(eq(markets.id, scope));
      if (!market) reject(404, "MARKET_NOT_FOUND", "السوق غير موجود");
    }
    const contentSha256 = policyContentSha256(document);
    const existing = await registryRow(tx, document.key, document.version, scope);
    if (existing) {
      if (existing.contentSha256 !== contentSha256)
        reject(
          409,
          "POLICY_CONTENT_CHANGED",
          "محتوى النسخة المسجلة يختلف عن الصياغة الحالية",
        );
      return { version: policyRegistryView(existing), created: false };
    }
    const [created] = await tx
      .insert(policyRegistryVersions)
      .values({
        id: randomUUID(),
        policyKey: document.key,
        version: document.version,
        lifecycle: "DRAFT",
        contentSha256,
        effectiveDate: document.effectiveDate,
        marketScope: scope,
        requiresAcceptance: document.requiresAcceptance,
        materialChange: input.materialChange ?? false,
        registeredBy: input.actorId,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const concurrent = await registryRow(
        tx,
        document.key,
        document.version,
        scope,
      );
      if (concurrent) return { version: policyRegistryView(concurrent), created: false };
      reject(409, "POLICY_REGISTRY_CONFLICT", "تعذر تسجيل نسخة السياسة");
    }
    return { version: policyRegistryView(created), created: true };
  });
}

const TRANSITIONS = {
  LEGAL_REVIEW: { from: "DRAFT", to: "LEGAL_REVIEW" },
  APPROVE: { from: "LEGAL_REVIEW", to: "APPROVED" },
  PUBLISH: { from: "APPROVED", to: "PUBLISHED" },
  SUPERSEDE: { from: "PUBLISHED", to: "SUPERSEDED" },
} as const;
export type PolicyTransitionAction = keyof typeof TRANSITIONS;

export async function transitionPolicyVersion(input: {
  actorId: string;
  id: string;
  action: PolicyTransitionAction;
  legalReference?: string;
}) {
  return db.transaction(async (tx) => {
    await assertAdminActor(input.actorId, tx);
    const transition = TRANSITIONS[input.action];
    if (!transition) reject(400, "INVALID_POLICY_ACTION", "إجراء دورة حياة غير معروف");
    const [row] = await tx
      .select()
      .from(policyRegistryVersions)
      .where(eq(policyRegistryVersions.id, input.id))
      .for("update");
    if (!row) reject(404, "POLICY_VERSION_NOT_FOUND", "نسخة السياسة غير موجودة");
    if (row.lifecycle !== transition.from)
      reject(
        409,
        "POLICY_TRANSITION_INVALID",
        `لا يمكن الانتقال من ${row.lifecycle} إلى ${transition.to}`,
      );
    const now = new Date();
    const patch: Partial<typeof policyRegistryVersions.$inferInsert> = {
      lifecycle: transition.to,
      updatedAt: now,
    };
    if (input.action === "APPROVE") {
      const reference = input.legalReference?.trim() ?? "";
      if (reference.length < 3)
        reject(
          400,
          "LEGAL_REFERENCE_REQUIRED",
          "الموافقة تحتاج مرجعًا خارجيًا من المراجعة القانونية",
        );
      patch.approvedAt = now;
      patch.approvedBy = input.actorId;
      patch.legalReference = reference;
    }
    if (input.action === "PUBLISH") {
      const today = now.toISOString().slice(0, 10);
      if (row.effectiveDate > today)
        reject(
          409,
          "POLICY_NOT_YET_EFFECTIVE",
          "لا تُنشر السياسة قبل تاريخ سريانها",
        );
      patch.publishedAt = now;
      patch.publishedBy = input.actorId;
      const others = await tx
        .select()
        .from(policyRegistryVersions)
        .where(
          and(
            eq(policyRegistryVersions.policyKey, row.policyKey),
            eq(policyRegistryVersions.marketScope, row.marketScope),
            eq(policyRegistryVersions.lifecycle, "PUBLISHED"),
          ),
        )
        .for("update");
      for (const other of others) {
        if (other.id === row.id) continue;
        await tx
          .update(policyRegistryVersions)
          .set({
            lifecycle: "SUPERSEDED",
            supersededAt: now,
            supersededBy: input.actorId,
            updatedAt: now,
          })
          .where(eq(policyRegistryVersions.id, other.id));
      }
    }
    if (input.action === "SUPERSEDE") {
      patch.supersededAt = now;
      patch.supersededBy = input.actorId;
    }
    const [updated] = await tx
      .update(policyRegistryVersions)
      .set(patch)
      .where(eq(policyRegistryVersions.id, row.id))
      .returning();
    return policyRegistryView(updated);
  });
}

export async function listPolicyRegistry() {
  const rows = await db
    .select()
    .from(policyRegistryVersions)
    .orderBy(desc(policyRegistryVersions.createdAt));
  return rows.map(policyRegistryView);
}

/**
 * Records one explicit decision. `source` is chosen by trusted server code, never by the
 * request body, and there is intentionally no path that accepts a model-generated sentence.
 */
export async function recordPolicyDecision(input: {
  userId: string;
  key: string;
  version: string;
  decision: "ACCEPTED" | "DECLINED";
  source: "SIGNUP" | "POLICY_REVIEW" | "API";
  idempotencyKey: string;
}) {
  return db.transaction(async (tx) => {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))
      reject(400, "IDEMPOTENCY_KEY_REQUIRED", "مفتاح طلب غير صالح");
    if (!["ACCEPTED", "DECLINED"].includes(input.decision))
      reject(400, "CONSENT_DECISION_REQUIRED", "القرار يجب أن يكون صريحًا");
    const document = currentPolicy(input.key);
    if (!document) reject(404, "POLICY_NOT_FOUND", "السياسة غير معروفة");
    const resolved = await acceptanceVersion(tx, document);
    if (input.version !== resolved) {
      const row = await registryRow(tx, input.key, input.version);
      if (row?.lifecycle === "SUPERSEDED")
        reject(409, "POLICY_SUPERSEDED", "هذه النسخة استُبدلت ولا تُقبل الآن");
      reject(409, "POLICY_VERSION_NOT_CURRENT", "النسخة ليست السارية للموافقة");
    }
    if (input.decision === "DECLINED" && document.requiresAcceptance)
      reject(
        409,
        "REQUIRED_POLICY_CANNOT_BE_DECLINED",
        "لا يمكن رفض سياسة إلزامية والاستمرار في استخدام الخدمة",
      );
    const contentSha256 = policyContentSha256(document);
    const [existing] = await tx
      .select()
      .from(policyConsentEvents)
      .where(
        and(
          eq(policyConsentEvents.userId, input.userId),
          eq(policyConsentEvents.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      if (
        existing.policyKey !== input.key ||
        existing.policyVersion !== input.version ||
        existing.decision !== input.decision ||
        existing.source !== input.source ||
        existing.contentSha256 !== contentSha256
      )
        reject(409, "IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم لقرار مختلف");
      return { event: policyConsentEventView(existing), created: false };
    }
    const [created] = await tx
      .insert(policyConsentEvents)
      .values({
        id: randomUUID(),
        userId: input.userId,
        policyKey: input.key,
        policyVersion: input.version,
        contentSha256,
        decision: input.decision,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [concurrent] = await tx
        .select()
        .from(policyConsentEvents)
        .where(
          and(
            eq(policyConsentEvents.userId, input.userId),
            eq(policyConsentEvents.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (concurrent) return { event: policyConsentEventView(concurrent), created: false };
      reject(409, "CONSENT_CONFLICT", "تعذر تسجيل القرار");
    }
    if (input.decision === "ACCEPTED") {
      await tx
        .insert(policyAcceptances)
        .values({
          userId: input.userId,
          policyKey: input.key,
          policyVersion: input.version,
        })
        .onConflictDoNothing();
    }
    return { event: policyConsentEventView(created), created: true };
  });
}

function latestByKey(
  rows: Array<typeof policyConsentEvents.$inferSelect>,
) {
  const map = new Map<string, typeof policyConsentEvents.$inferSelect>();
  for (const row of rows) {
    const key = `${row.policyKey}\u0000${row.policyVersion}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

export async function policyConsentStatus(userId: string) {
  const [acceptances, events] = await Promise.all([
    db
      .select()
      .from(policyAcceptances)
      .where(eq(policyAcceptances.userId, userId)),
    db
      .select()
      .from(policyConsentEvents)
      .where(eq(policyConsentEvents.userId, userId))
      .orderBy(desc(policyConsentEvents.createdAt)),
  ]);
  const latest = latestByKey(events);
  const required = [];
  const optional = [];
  const materialUpdates = [];
  for (const document of currentPolicies()) {
    const contentSha256 = policyContentSha256(document);
    const resolved = (await publishedVersion(db, document.key))?.version ?? document.version;
    const accepted = acceptances.find(
      (row) =>
        row.policyKey === document.key && row.policyVersion === resolved,
    );
    const decision = latest.get(`${document.key}\u0000${resolved}`);
    const row = await registryRow(db, document.key, document.version);
    const lifecycle = row?.lifecycle ?? "NOT_REGISTERED";
    if (document.requiresAcceptance) {
      required.push({
        key: document.key,
        version: resolved,
        titleAr: document.titleAr,
        titleEn: document.titleEn,
        contentSha256,
        lifecycle,
        status: accepted ? "ACCEPTED" : "PENDING",
        acceptedAt: accepted?.acceptedAt.toISOString() ?? null,
      });
    } else {
      optional.push({
        key: document.key,
        version: resolved,
        titleAr: document.titleAr,
        titleEn: document.titleEn,
        contentSha256,
        lifecycle,
        granted:
          decision?.decision === "ACCEPTED"
            ? true
            : decision?.decision === "DECLINED"
              ? false
              : null,
        decidedAt: decision?.createdAt.toISOString() ?? null,
      });
    }
    if (
      document.requiresAcceptance &&
      row?.lifecycle === "PUBLISHED" &&
      row.materialChange &&
      !accepted
    )
      materialUpdates.push({
        key: document.key,
        version: resolved,
        contentSha256,
        reason: "MATERIAL_CHANGE",
      });
  }
  return {
    required,
    optional,
    pendingRequired: required.filter((row) => row.status === "PENDING"),
    materialUpdates,
    consentEvidence: "EXPLICIT_USER_ACTION_ONLY",
  };
}

export async function listPolicyConsentEvents(userId: string, limit = 200) {
  const rows = await db
    .select()
    .from(policyConsentEvents)
    .where(eq(policyConsentEvents.userId, userId))
    .orderBy(desc(policyConsentEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(policyConsentEventView);
}

/** Signup rows are built from the same document and resolved version the API would accept. */
export async function signupConsentRows(userId: string, tx: any = db) {
  const rows: Array<typeof policyConsentEvents.$inferInsert> = [];
  for (const document of currentPolicies()) {
    if (!document.requiresAcceptance) continue;
    const version = await acceptanceVersion(tx, document);
    rows.push({
      id: randomUUID(),
      userId,
      policyKey: document.key,
      policyVersion: version,
      contentSha256: policyContentSha256(document),
      decision: "ACCEPTED" as const,
      source: "SIGNUP" as const,
      idempotencyKey: `signup:${document.key}:${version}`,
    });
  }
  return rows;
}
