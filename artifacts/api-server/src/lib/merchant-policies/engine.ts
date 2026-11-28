/**
 * Merchant policy engine (M1). A merchant says what they want in natural language; the
 * conversation turns it into a typed proposal; this engine validates it against the kind's schema,
 * checks the actor's explicit permission scope, detects conflicts with what is active, and
 * activates it only after the confirmation its sensitivity requires:
 *
 *   NORMAL     confirmation in the conversation
 *   SENSITIVE  a review card showing the change and its effect, then an explicit confirmation
 *              naming the exact proposal and version
 *   HIGH_RISK  as SENSITIVE, plus a fresh sign-in through the platform's own login (the session
 *              must be younger than REAUTH_WINDOW_MS); never a password or code in the chat
 *
 * The owner (business_profiles.owner_user_id) holds every scope. Anyone else holds only the scopes
 * the owner granted explicitly; financial scopes are never implied by another scope. Every change is
 * an append-only event with actor, time and before/after (payout details masked).
 *
 * Enforcement elsewhere reads only ACTIVE, validated rules through `effectivePolicy`.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { businessProfiles, db, MERCHANT_POLICY_SCOPES, merchantPolicies, merchantPolicyEvents, merchantPolicyGrants, users } from "@workspace/db";
import { isPolicyKind, maskRule, POLICY_KINDS, type PolicyKind, type PolicyScope, type ScopeKind, type Sensitivity } from "./kinds";

type Policy = typeof merchantPolicies.$inferSelect;
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export class MerchantPolicyError extends Error {
  readonly expose = true;
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "MerchantPolicyError";
  }
}
const reject = (status: number, code: string, message: string, detail?: unknown): never => {
  throw new MerchantPolicyError(status, code, message, detail);
};

// ── Authority ─────────────────────────────────────────────────────────────────────────────────

export type Authority = { businessId: string; marketId: string; role: "OWNER" | "DELEGATE"; scopes: PolicyScope[] };

/** 404 for a business the actor has nothing to do with, so its existence is not disclosed. */
export async function authorityFor(tx: any, actorId: string, businessId: string): Promise<Authority> {
  const [business] = await tx.select({ id: businessProfiles.id, ownerUserId: businessProfiles.ownerUserId, marketId: businessProfiles.marketId }).from(businessProfiles).where(eq(businessProfiles.id, businessId));
  if (!business) reject(404, "BUSINESS_NOT_FOUND", "النشاط غير موجود");
  if (business.ownerUserId === actorId) return { businessId, marketId: business.marketId, role: "OWNER", scopes: [...MERCHANT_POLICY_SCOPES] };
  const [grant] = await tx
    .select()
    .from(merchantPolicyGrants)
    .where(and(eq(merchantPolicyGrants.businessId, businessId), eq(merchantPolicyGrants.granteeUserId, actorId), eq(merchantPolicyGrants.status, "ACTIVE")));
  if (!grant) reject(404, "BUSINESS_NOT_FOUND", "النشاط غير موجود");
  return { businessId, marketId: business.marketId, role: "DELEGATE", scopes: grant.scopes as PolicyScope[] };
}

/** Businesses where the actor may manage at least one policy kind. */
export async function manageableBusinesses(actorId: string) {
  const owned = await db.select({ id: businessProfiles.id, name: businessProfiles.displayName }).from(businessProfiles).where(eq(businessProfiles.ownerUserId, actorId));
  const granted = await db
    .select({ id: businessProfiles.id, name: businessProfiles.displayName })
    .from(merchantPolicyGrants)
    .innerJoin(businessProfiles, eq(businessProfiles.id, merchantPolicyGrants.businessId))
    .where(and(eq(merchantPolicyGrants.granteeUserId, actorId), eq(merchantPolicyGrants.status, "ACTIVE")));
  const seen = new Map<string, { id: string; name: string }>();
  for (const row of [...owned, ...granted]) seen.set(row.id, row);
  return [...seen.values()];
}

function requireScope(authority: Authority, kind: PolicyKind) {
  const needed = POLICY_KINDS[kind].scope;
  if (!authority.scopes.includes(needed))
    reject(403, "PERMISSION_REQUIRED", `ليست لديك صلاحية «${needed}» لتغيير ${POLICY_KINDS[kind].labelAr}. اطلبها من مالك النشاط.`, { scope: needed });
}

// ── Audit ─────────────────────────────────────────────────────────────────────────────────────

async function audit(tx: any, input: { businessId: string; actorId: string; event: string; policy?: Policy | null; grantId?: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; detail?: Record<string, unknown> }) {
  const kind = input.policy && isPolicyKind(input.policy.kind) ? input.policy.kind : null;
  await tx.insert(merchantPolicyEvents).values({
    id: randomUUID(),
    businessId: input.businessId,
    policyId: input.policy?.id ?? null,
    grantId: input.grantId ?? null,
    actorId: input.actorId,
    event: input.event,
    before: kind ? maskRule(kind, input.before ?? null) : input.before ?? null,
    after: kind ? maskRule(kind, input.after ?? null) : input.after ?? null,
    detail: input.detail ?? {},
  });
}

// ── Conflicts ─────────────────────────────────────────────────────────────────────────────────

export type Conflict = { code: string; messageAr: string; withPolicyId: string; withKind: string };

const sameScope = (a: { scopeKind: string; scopeRef: string | null }, b: { scopeKind: string; scopeRef: string | null }) => a.scopeKind === b.scopeKind && (a.scopeRef ?? "") === (b.scopeRef ?? "");

/**
 * Contradictions between a proposal and what is ACTIVE. A same-kind, same-scope rule is a
 * replacement (shown as before/after), not a conflict. A product-level rule over a store-level one
 * is a deliberate override, not a conflict.
 */
export function detectConflicts(proposal: { kind: string; scopeKind: string; scopeRef: string | null; rule: Record<string, any> }, active: Policy[]): Conflict[] {
  const out: Conflict[] = [];
  const find = (kind: string, scoped = true) => active.filter((p) => p.kind === kind && (!scoped || sameScope(p, proposal)));
  const r = proposal.rule;
  const add = (p: Policy, code: string, messageAr: string) => out.push({ code, messageAr, withPolicyId: p.id, withKind: p.kind });
  if (proposal.kind === "PAYMENT_METHODS" && !r.methods.some((m: { code: string }) => m.code === "COD"))
    for (const p of find("COD_AREAS", false)) add(p, "COD_AREAS_WITHOUT_COD", "هذه الطرق لا تشمل الدفع عند الاستلام، بينما توجد سياسة مناطق للدفع عند الاستلام. احذف المناطق أو أضف الدفع عند الاستلام.");
  if (proposal.kind === "COD_AREAS")
    for (const p of find("PAYMENT_METHODS", false))
      if (!(p.rule as any).methods?.some((m: { code: string }) => m.code === "COD")) add(p, "COD_NOT_ACCEPTED", "طرق الدفع الحالية لا تشمل الدفع عند الاستلام؛ أضفه أولًا قبل تحديد مناطقه.");
  if (proposal.kind === "PRE_ORDER" && r.enabled)
    for (const p of find("OUT_OF_STOCK")) if ((p.rule as any).action === "NOT_SOLD") add(p, "PREORDER_VS_NOT_SOLD", "سياسة نفاد المخزون تقول إن المنتج لا يُباع، وهذا يتعارض مع السماح بالطلب المسبق.");
  if (proposal.kind === "OUT_OF_STOCK" && r.action === "NOT_SOLD")
    for (const p of find("PRE_ORDER")) if ((p.rule as any).enabled) add(p, "NOT_SOLD_VS_PREORDER", "الطلب المسبق مفعّل لهذا النطاق، وهذا يتعارض مع «لا يُباع».");
  if (proposal.kind === "DISCOUNT" && r.percentBps)
    for (const p of find("PRICE_NEGOTIATION")) {
      const max = (p.rule as any).maxDiscountBps;
      if ((p.rule as any).allowed && typeof max === "number" && r.percentBps > max) add(p, "DISCOUNT_ABOVE_NEGOTIATION_LIMIT", `الخصم ${r.percentBps / 100}% أكبر من الحد الأقصى للتفاوض ${max / 100}% لنفس النطاق.`);
    }
  if (proposal.kind === "PRICE_NEGOTIATION" && r.allowed && typeof r.maxDiscountBps === "number")
    for (const p of find("DISCOUNT")) {
      const pct = (p.rule as any).percentBps;
      if (typeof pct === "number" && pct > r.maxDiscountBps) add(p, "NEGOTIATION_BELOW_ACTIVE_DISCOUNT", `يوجد خصم فعّال ${pct / 100}% أكبر من الحد الجديد للتفاوض.`);
    }
  if (proposal.kind === "PAYMENT_GATEWAY" && r.enabled === false)
    for (const p of find("PAYMENT_METHODS", false)) if ((p.rule as any).keepStoreGateway) add(p, "GATEWAY_DISABLED_BUT_KEPT", "سياسة طرق الدفع تقول إبقاء بوابة المتجر، وهذا الاقتراح يوقفها.");
  return out;
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────

const SCOPE_LABEL: Record<ScopeKind, string> = { STORE: "المتجر كله", PRODUCT: "منتج", CATEGORY: "تصنيف", REGION: "منطقة" };
export function policyView(p: Policy, opts: { reveal?: boolean } = {}) {
  const kind = p.kind as PolicyKind;
  return {
    id: p.id,
    kind,
    kindLabel: POLICY_KINDS[kind]?.labelAr ?? kind,
    scope: { kind: p.scopeKind, ref: p.scopeRef, label: `${SCOPE_LABEL[p.scopeKind as ScopeKind] ?? p.scopeKind}${p.scopeRef ? `: ${p.scopeRef}` : ""}` },
    rule: opts.reveal ? p.rule : maskRule(kind, p.rule),
    sensitivity: p.sensitivity as Sensitivity,
    status: p.status,
    version: p.version,
    source: p.source,
    proposedBy: p.proposedBy,
    confirmedBy: p.confirmedBy,
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    provenance: "MERCHANT_POLICY" as const,
  };
}

async function activeFor(tx: any, businessId: string): Promise<Policy[]> {
  return tx.select().from(merchantPolicies).where(and(eq(merchantPolicies.businessId, businessId), eq(merchantPolicies.status, "ACTIVE")));
}

// ── Propose ───────────────────────────────────────────────────────────────────────────────────

export type ProposalInput = {
  actorId: string;
  businessId: string;
  kind: string;
  scope?: { kind: ScopeKind; ref?: string | null };
  rule: unknown;
  source: "CHAT" | "API";
  sourceText?: string;
};

export async function proposePolicy(input: ProposalInput) {
  if (!isPolicyKind(input.kind)) reject(400, "UNKNOWN_POLICY_KIND", "نوع السياسة غير معروف.");
  const kind = input.kind as PolicyKind;
  const definition = POLICY_KINDS[kind];
  const scopeKind = input.scope?.kind ?? "STORE";
  const scopeRef = scopeKind === "STORE" ? null : input.scope?.ref?.trim() || null;
  if (!(definition.scopes as readonly string[]).includes(scopeKind)) reject(400, "SCOPE_NOT_ALLOWED", `${definition.labelAr} لا تُحدد على مستوى «${SCOPE_LABEL[scopeKind]}».`);
  if (scopeKind !== "STORE" && !scopeRef) reject(400, "SCOPE_REF_REQUIRED", "حدد المنتج أو التصنيف أو المنطقة.");
  const parsed = definition.rule.safeParse(input.rule);
  if (!parsed.success) reject(400, "RULE_INVALID", `لم أفهم السياسة بشكل كامل؛ تحتاج توضيحًا: ${parsed.error.issues.map((i) => i.message).join("، ")}`, { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  const rule = parsed.data as Record<string, unknown>;
  return db.transaction(async (tx) => {
    const authority = await authorityFor(tx, input.actorId, input.businessId);
    requireScope(authority, kind);
    const active = await activeFor(tx, input.businessId);
    const current = active.find((p) => p.kind === kind && sameScope(p, { scopeKind, scopeRef }));
    if (current && JSON.stringify(current.rule) === JSON.stringify(rule)) reject(409, "NO_CHANGE", "هذه السياسة مطبقة بالفعل بنفس القيم.");
    const conflicts = detectConflicts({ kind, scopeKind, scopeRef, rule }, active);
    // An earlier unconfirmed proposal for the same kind and scope is cancelled by the newer one.
    const pending: Policy[] = await tx.select().from(merchantPolicies).where(and(eq(merchantPolicies.businessId, input.businessId), eq(merchantPolicies.kind, kind), eq(merchantPolicies.status, "PROPOSED"))).for("update");
    for (const p of pending.filter((p) => sameScope(p, { scopeKind, scopeRef }))) {
      await tx.update(merchantPolicies).set({ status: "CANCELLED", closedAt: new Date(), updatedAt: new Date() }).where(eq(merchantPolicies.id, p.id));
      await audit(tx, { businessId: input.businessId, actorId: input.actorId, event: "PROPOSAL_SUPERSEDED", policy: p, before: p.rule, after: null });
    }
    const id = randomUUID();
    const [row] = await tx
      .insert(merchantPolicies)
      .values({
        id,
        businessId: input.businessId,
        marketId: authority.marketId,
        kind,
        scopeKind,
        scopeRef,
        rule,
        sensitivity: definition.sensitivity,
        status: "PROPOSED",
        source: input.source,
        sourceText: input.sourceText?.slice(0, 500) ?? null,
        version: (current?.version ?? 0) + 1,
        supersedesId: current?.id ?? null,
        proposedBy: input.actorId,
      })
      .returning();
    await audit(tx, { businessId: input.businessId, actorId: input.actorId, event: "PROPOSED", policy: row, before: current?.rule ?? null, after: rule, detail: { conflicts: conflicts.map((c) => c.code), role: authority.role } });
    return reviewOf(row, current ?? null, conflicts);
  });
}

function effectsAr(kind: PolicyKind, before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const label = POLICY_KINDS[kind].labelAr;
  const lines = [before ? `سيستبدل ${label} الحالية (النسخة السابقة تبقى في السجل).` : `سياسة جديدة لـ${label}.`];
  if (kind === "ORDERING_PAUSED" && after.paused) lines.push("لن يستطيع العملاء إنشاء طلبات جديدة حتى تعيد التفعيل.");
  if (kind === "PAYMENT_METHODS") lines.push("ستتغير طرق الدفع التي يعرضها جاسم على المشترين في الطلبات الجديدة.");
  if (kind === "DISCOUNT" || kind === "PRICE_NEGOTIATION") lines.push("يؤثر على السعر الذي قد يقدمه جاسم للمشترين؛ الطلبات السابقة لا تتغير.");
  if (kind === "PAYOUT_DETAILS") lines.push("ستتغير بيانات استقبال الأموال التي تُعرض للمشترين.");
  if (kind === "PAYMENT_GATEWAY") lines.push("لا يوجد تكامل بوابة مفعّل بعد؛ هذا يسجل رغبتك فقط ولا يشغّل أي دفع.");
  if (kind === "OUT_OF_STOCK" && after.promiseDate === null) lines.push("لن يَعِد جاسم بموعد توفر محدد.");
  return lines;
}

function reviewOf(policy: Policy, current: Policy | null, conflicts: Conflict[]) {
  const kind = policy.kind as PolicyKind;
  const sensitivity = policy.sensitivity as Sensitivity;
  return {
    kind: "MERCHANT_POLICY_REVIEW" as const,
    policy: policyView(policy),
    before: current ? policyView(current) : null,
    effects: effectsAr(kind, current?.rule ?? null, policy.rule),
    conflicts,
    confirmation: sensitivity === "NORMAL" ? "CHAT_CONFIRM" : sensitivity === "SENSITIVE" ? "EXPLICIT_REVIEW" : "EXPLICIT_REVIEW_AND_FRESH_SIGN_IN",
    canConfirm: conflicts.length === 0,
  };
}

// ── Confirm, cancel, revoke ───────────────────────────────────────────────────────────────────

export async function confirmPolicy(input: { actorId: string; policyId: string; expectedVersion: number; channel: "CHAT" | "REVIEW_CARD"; sessionIssuedAt?: Date | null }) {
  return db.transaction(async (tx) => {
    const [policy]: Policy[] = await tx.select().from(merchantPolicies).where(eq(merchantPolicies.id, input.policyId)).for("update");
    if (!policy) reject(404, "POLICY_NOT_FOUND", "السياسة غير موجودة");
    const authority = await authorityFor(tx, input.actorId, policy!.businessId);
    const kind = policy!.kind as PolicyKind;
    requireScope(authority, kind);
    if (policy!.status !== "PROPOSED") reject(409, "NOT_PROPOSED", "هذا الاقتراح لم يعد بانتظار التأكيد.");
    if (policy!.version !== input.expectedVersion) reject(409, "VERSION_CHANGED", "تغيّر الاقتراح منذ عرضه؛ راجع النسخة الحالية.");
    if (policy!.sensitivity !== "NORMAL" && input.channel !== "REVIEW_CARD")
      reject(409, "REVIEW_CONFIRMATION_REQUIRED", "هذا تغيير حساس: أكّده من بطاقة المراجعة بعد قراءة آثاره.");
    if (policy!.sensitivity === "HIGH_RISK" && (!input.sessionIssuedAt || Date.now() - input.sessionIssuedAt.getTime() > REAUTH_WINDOW_MS))
      reject(401, "FRESH_SIGN_IN_REQUIRED", "هذا تغيير مالي عالي الخطورة: سجّل الدخول من جديد عبر صفحة الدخول الرسمية ثم أكّد خلال 10 دقائق. لا نطلب كلمة المرور في المحادثة.");
    const active = await activeFor(tx, policy!.businessId);
    const conflicts = detectConflicts(policy!, active.filter((p) => p.id !== policy!.supersedesId));
    if (conflicts.length) reject(409, "POLICY_CONFLICT", "يوجد تعارض مع سياسة فعّالة؛ يحتاج توضيحًا قبل التفعيل.", { conflicts });
    const now = new Date();
    const previous = active.find((p) => p.kind === policy!.kind && sameScope(p, policy!));
    if (previous) {
      await tx.update(merchantPolicies).set({ status: "REPLACED", closedAt: now, updatedAt: now }).where(eq(merchantPolicies.id, previous.id));
      await audit(tx, { businessId: policy!.businessId, actorId: input.actorId, event: "REPLACED", policy: previous, before: previous.rule, after: policy!.rule, detail: { by: policy!.id } });
    }
    const [activated] = await tx.update(merchantPolicies).set({ status: "ACTIVE", confirmedBy: input.actorId, confirmedAt: now, updatedAt: now }).where(eq(merchantPolicies.id, policy!.id)).returning();
    await audit(tx, { businessId: policy!.businessId, actorId: input.actorId, event: "CONFIRMED", policy: activated, before: previous?.rule ?? null, after: activated.rule, detail: { channel: input.channel, sensitivity: policy!.sensitivity, role: authority.role, freshSignIn: policy!.sensitivity === "HIGH_RISK" } });
    return policyView(activated);
  });
}

export async function cancelProposal(input: { actorId: string; policyId: string }) {
  return db.transaction(async (tx) => {
    const [policy]: Policy[] = await tx.select().from(merchantPolicies).where(eq(merchantPolicies.id, input.policyId)).for("update");
    if (!policy) reject(404, "POLICY_NOT_FOUND", "السياسة غير موجودة");
    requireScope(await authorityFor(tx, input.actorId, policy!.businessId), policy!.kind as PolicyKind);
    if (policy!.status !== "PROPOSED") reject(409, "NOT_PROPOSED", "لا يوجد اقتراح بانتظار التأكيد.");
    const [row] = await tx.update(merchantPolicies).set({ status: "CANCELLED", closedAt: new Date(), updatedAt: new Date() }).where(eq(merchantPolicies.id, policy!.id)).returning();
    await audit(tx, { businessId: policy!.businessId, actorId: input.actorId, event: "CANCELLED", policy: row, before: policy!.rule, after: null });
    return policyView(row);
  });
}

/** Revoking needs the same scope; a HIGH_RISK policy needs a fresh sign-in to revoke as well. */
export async function revokePolicy(input: { actorId: string; policyId: string; reason: string; sessionIssuedAt?: Date | null }) {
  if (!input.reason?.trim()) reject(400, "REASON_REQUIRED", "اذكر سبب الإلغاء.");
  return db.transaction(async (tx) => {
    const [policy]: Policy[] = await tx.select().from(merchantPolicies).where(eq(merchantPolicies.id, input.policyId)).for("update");
    if (!policy) reject(404, "POLICY_NOT_FOUND", "السياسة غير موجودة");
    const authority = await authorityFor(tx, input.actorId, policy!.businessId);
    requireScope(authority, policy!.kind as PolicyKind);
    if (policy!.status !== "ACTIVE") reject(409, "NOT_ACTIVE", "السياسة غير فعّالة.");
    if (policy!.sensitivity === "HIGH_RISK" && (!input.sessionIssuedAt || Date.now() - input.sessionIssuedAt.getTime() > REAUTH_WINDOW_MS))
      reject(401, "FRESH_SIGN_IN_REQUIRED", "سجّل الدخول من جديد ثم ألغِ السياسة خلال 10 دقائق.");
    const [row] = await tx.update(merchantPolicies).set({ status: "REVOKED", closedAt: new Date(), updatedAt: new Date() }).where(eq(merchantPolicies.id, policy!.id)).returning();
    await audit(tx, { businessId: policy!.businessId, actorId: input.actorId, event: "REVOKED", policy: row, before: policy!.rule, after: null, detail: { reason: input.reason.trim().slice(0, 300) } });
    return policyView(row);
  });
}

// ── Reads for enforcement (M2+) and for the owner ─────────────────────────────────────────────

/**
 * The rule that applies to a product, most specific first: PRODUCT, then CATEGORY, then REGION,
 * then STORE. Returns the validated rule with its provenance, or null when the merchant set none.
 */
export async function effectivePolicy(businessId: string, kind: PolicyKind, context: { productId?: string; categoryId?: string; region?: string } = {}) {
  const rows: Policy[] = await db.select().from(merchantPolicies).where(and(eq(merchantPolicies.businessId, businessId), eq(merchantPolicies.kind, kind), eq(merchantPolicies.status, "ACTIVE")));
  const pick =
    rows.find((r) => r.scopeKind === "PRODUCT" && context.productId && r.scopeRef === context.productId) ??
    rows.find((r) => r.scopeKind === "CATEGORY" && context.categoryId && r.scopeRef === context.categoryId) ??
    rows.find((r) => r.scopeKind === "REGION" && context.region && r.scopeRef === context.region) ??
    rows.find((r) => r.scopeKind === "STORE");
  if (!pick) return null;
  const parsed = POLICY_KINDS[kind].rule.safeParse(pick.rule);
  return parsed.success ? { rule: parsed.data, policyId: pick.id, version: pick.version, scope: pick.scopeKind, provenance: "MERCHANT_POLICY" as const } : null;
}

export async function listPolicies(input: { actorId: string; businessId: string }) {
  const authority = await authorityFor(db, input.actorId, input.businessId);
  const rows: Policy[] = await db.select().from(merchantPolicies).where(and(eq(merchantPolicies.businessId, input.businessId), inArray(merchantPolicies.status, ["ACTIVE", "PROPOSED"]))).orderBy(asc(merchantPolicies.kind), desc(merchantPolicies.createdAt));
  // Payout details are revealed only to someone holding that scope.
  return { role: authority.role, scopes: authority.scopes, policies: rows.map((p) => policyView(p, { reveal: p.kind === "PAYOUT_DETAILS" ? authority.scopes.includes("policy.payout_details") : true })) };
}

export async function policyHistory(input: { actorId: string; businessId: string }) {
  const authority = await authorityFor(db, input.actorId, input.businessId);
  if (authority.role !== "OWNER" && !authority.scopes.includes("policy.financial_data")) reject(403, "PERMISSION_REQUIRED", "سجل التغييرات للمالك أو لمن لديه صلاحية البيانات المالية.");
  const events = await db.select().from(merchantPolicyEvents).where(eq(merchantPolicyEvents.businessId, input.businessId)).orderBy(asc(merchantPolicyEvents.createdAt));
  return events.map((e) => ({ event: e.event, policyId: e.policyId, grantId: e.grantId, actorId: e.actorId, before: e.before, after: e.after, detail: e.detail, at: e.createdAt.toISOString() }));
}

// ── Grants (owner only) ───────────────────────────────────────────────────────────────────────

export async function setGrant(input: { actorId: string; businessId: string; granteeUserId: string; scopes: string[] }) {
  const unknown = input.scopes.filter((s) => !(MERCHANT_POLICY_SCOPES as readonly string[]).includes(s));
  if (unknown.length) reject(400, "UNKNOWN_SCOPE", `صلاحيات غير معروفة: ${unknown.join("، ")}`);
  return db.transaction(async (tx) => {
    const authority = await authorityFor(tx, input.actorId, input.businessId);
    if (authority.role !== "OWNER") reject(403, "OWNER_ONLY", "تفويض الصلاحيات للمالك فقط.");
    if (input.granteeUserId === input.actorId) reject(400, "SELF_GRANT", "المالك يملك كل الصلاحيات أصلًا.");
    const [grantee] = await tx.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, input.granteeUserId));
    if (!grantee || grantee.status !== "ACTIVE") reject(404, "USER_NOT_FOUND", "المستخدم غير موجود.");
    const [existing] = await tx.select().from(merchantPolicyGrants).where(and(eq(merchantPolicyGrants.businessId, input.businessId), eq(merchantPolicyGrants.granteeUserId, input.granteeUserId), eq(merchantPolicyGrants.status, "ACTIVE"))).for("update");
    const scopes = [...new Set(input.scopes)].sort();
    const now = new Date();
    if (existing) {
      if (!scopes.length) {
        await tx.update(merchantPolicyGrants).set({ status: "REVOKED", updatedAt: now, version: existing.version + 1 }).where(eq(merchantPolicyGrants.id, existing.id));
        await audit(tx, { businessId: input.businessId, actorId: input.actorId, event: "GRANT_REVOKED", grantId: existing.id, before: { scopes: existing.scopes }, after: null, detail: { grantee: input.granteeUserId } });
        return { granteeUserId: input.granteeUserId, scopes: [], status: "REVOKED" };
      }
      await tx.update(merchantPolicyGrants).set({ scopes, updatedAt: now, version: existing.version + 1 }).where(eq(merchantPolicyGrants.id, existing.id));
      await audit(tx, { businessId: input.businessId, actorId: input.actorId, event: "GRANT_CHANGED", grantId: existing.id, before: { scopes: existing.scopes }, after: { scopes }, detail: { grantee: input.granteeUserId } });
      return { granteeUserId: input.granteeUserId, scopes, status: "ACTIVE" };
    }
    if (!scopes.length) reject(400, "NO_SCOPES", "حدد صلاحية واحدة على الأقل.");
    const id = randomUUID();
    await tx.insert(merchantPolicyGrants).values({ id, businessId: input.businessId, granteeUserId: input.granteeUserId, scopes, status: "ACTIVE", grantedBy: input.actorId });
    await audit(tx, { businessId: input.businessId, actorId: input.actorId, event: "GRANT_CREATED", grantId: id, before: null, after: { scopes }, detail: { grantee: input.granteeUserId } });
    return { granteeUserId: input.granteeUserId, scopes, status: "ACTIVE" };
  });
}
