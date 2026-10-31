/**
 * Wave 10 WhatsApp readiness.
 *
 * DINAR wants an official WhatsApp Business channel, but nothing here can send: there is no
 * provider adapter, `delivery_state` is constrained to NOT_SENT, and an intent is only an
 * evaluation. Consent is an append-only ledger fed by an explicit user action; a template must be
 * human-approved; MARKETING and UTILITY categories are kept apart. When no provider is configured
 * the intent is recorded as BLOCKED_PROVIDER_UNAVAILABLE and the in-app record stays the truth.
 */
import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, users, whatsappConsentEvents, whatsappIntents, whatsappTemplates } from "@workspace/db";
import { assertAdminActor } from "./admin-authority";

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });

export const WHATSAPP_TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
export const WHATSAPP_TEMPLATE_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "DISABLED"] as const;
type TemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

/** Only human approval moves a template forward; no provider call is made by any transition. */
const TEMPLATE_TRANSITIONS: Record<TemplateStatus, readonly TemplateStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED"],
  APPROVED: ["DISABLED"],
  REJECTED: [],
  DISABLED: [],
};

export const WHATSAPP_CONSENT_SOURCES = ["IN_APP", "SUPPORT"] as const;

export type WhatsAppDecision =
  | "READY_TO_SEND"
  | "BLOCKED_NO_CONSENT"
  | "BLOCKED_TEMPLATE_NOT_APPROVED"
  | "BLOCKED_TEMPLATE_DISABLED"
  | "BLOCKED_PROVIDER_UNAVAILABLE"
  | "BLOCKED_PAYLOAD_INVALID";

export function whatsappProviderState(env: NodeJS.ProcessEnv = process.env) {
  const name = env.DINAR_WHATSAPP_PROVIDER?.trim() || null;
  return {
    name,
    // Live sending is not implemented on purpose; only a local simulation can reach READY_TO_SEND.
    availability: name === "simulation" ? "SIMULATED" : "NOT_CONFIGURED",
    liveSends: false as const,
  };
}

export function whatsappPhoneHash(normalizedPhone: string) {
  return createHash("sha256").update(normalizedPhone).digest("hex");
}

export async function whatsappConsentStatus(userId: string) {
  const [row] = await db
    .select()
    .from(whatsappConsentEvents)
    .where(eq(whatsappConsentEvents.userId, userId))
    .orderBy(desc(whatsappConsentEvents.createdAt), desc(whatsappConsentEvents.id))
    .limit(1);
  if (!row) return { state: "NO_DECISION" as const, hasConsent: false, source: null, decidedAt: null };
  return {
    state: row.decision as "GRANTED" | "REVOKED",
    hasConsent: row.decision === "GRANTED",
    source: row.source,
    decidedAt: row.createdAt.toISOString(),
  };
}

export const WhatsAppConsentBody = z
  .object({
    decision: z.enum(["GRANTED", "REVOKED"]),
    source: z.enum(WHATSAPP_CONSENT_SOURCES),
  })
  .strict();

/** Consent is an explicit authenticated action; a chat message or model output is not a source. */
export async function recordWhatsAppConsent(userId: string, body: z.infer<typeof WhatsAppConsentBody>) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ phone: users.normalizedPhone, marketId: users.activeMarketId }).from(users).where(eq(users.id, userId));
    if (!user) throw fail(401, "سجّل الدخول للمتابعة");
    if (!user.marketId) throw fail(409, "حدد سوقك قبل تسجيل موافقة واتساب", "MARKET_REQUIRED");
    if (!user.phone) throw fail(409, "لا يوجد رقم هاتف موثّق لهذا الحساب", "PHONE_REQUIRED");
    const [latest] = await tx
      .select()
      .from(whatsappConsentEvents)
      .where(eq(whatsappConsentEvents.userId, userId))
      .orderBy(desc(whatsappConsentEvents.createdAt), desc(whatsappConsentEvents.id))
      .limit(1);
    // Monotonic timestamps keep "latest decision" unambiguous even in the same millisecond.
    const now = new Date();
    const createdAt = latest && latest.createdAt >= now ? new Date(latest.createdAt.getTime() + 1) : now;
    const [inserted] = await tx
      .insert(whatsappConsentEvents)
      .values({
        id: randomUUID(),
        userId,
        marketId: user.marketId,
        phoneHash: whatsappPhoneHash(user.phone),
        decision: body.decision,
        source: body.source,
        createdAt,
      })
      .returning();
    return {
      state: inserted!.decision as "GRANTED" | "REVOKED",
      hasConsent: inserted!.decision === "GRANTED",
      source: inserted!.source,
      decidedAt: inserted!.createdAt.toISOString(),
    };
  });
}

export const CreateWhatsappTemplateBody = z
  .object({
    key: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,60}$/),
    category: z.enum(WHATSAPP_TEMPLATE_CATEGORIES),
    language: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default("ar"),
    body: z.string().trim().min(5).max(1000),
    variableCount: z.number().int().min(0).max(10).default(0),
  })
  .strict();

type TemplateRow = typeof whatsappTemplates.$inferSelect;

export function whatsappTemplateView(row: TemplateRow) {
  return {
    key: row.key,
    category: row.category,
    language: row.language,
    status: row.status as TemplateStatus,
    body: row.body,
    variableCount: row.variableCount,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    providerSubmitted: false,
  };
}

export async function createWhatsappTemplate(adminId: string, body: z.infer<typeof CreateWhatsappTemplateBody>) {
  await assertAdminActor(adminId);
  const placeholders = body.body.match(/\{\{\d+\}\}/g)?.length ?? 0;
  if (placeholders !== body.variableCount) throw fail(400, "عدد المتغيرات لا يطابق عناصر القالب", "VARIABLE_COUNT_MISMATCH");
  const [existing] = await db.select({ key: whatsappTemplates.key }).from(whatsappTemplates).where(eq(whatsappTemplates.key, body.key));
  if (existing) throw fail(409, "مفتاح القالب مستخدم بالفعل", "TEMPLATE_EXISTS");
  const [row] = await db
    .insert(whatsappTemplates)
    .values({
      key: body.key,
      category: body.category,
      language: body.language,
      status: "DRAFT",
      body: body.body,
      variableCount: body.variableCount,
    })
    .returning();
  return whatsappTemplateView(row!);
}

export const WhatsappTemplateStatusBody = z
  .object({ status: z.enum(["SUBMITTED", "APPROVED", "REJECTED", "DISABLED"]) })
  .strict();

export async function transitionWhatsappTemplate(adminId: string, key: string, body: z.infer<typeof WhatsappTemplateStatusBody>) {
  await assertAdminActor(adminId);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(whatsappTemplates).where(eq(whatsappTemplates.key, key)).for("update");
    if (!row) throw fail(404, "القالب غير موجود", "TEMPLATE_NOT_FOUND");
    if (!TEMPLATE_TRANSITIONS[row.status as TemplateStatus].includes(body.status))
      throw fail(409, `لا يمكن نقل القالب من «${row.status}» إلى «${body.status}»`, "INVALID_TRANSITION");
    const now = new Date();
    const [updated] = await tx
      .update(whatsappTemplates)
      .set({
        status: body.status,
        approvedAt: body.status === "APPROVED" ? now : row.approvedAt,
        updatedAt: now,
      })
      .where(eq(whatsappTemplates.key, row.key))
      .returning();
    return whatsappTemplateView(updated!);
  });
}

export async function listWhatsappTemplates() {
  const rows = await db.select().from(whatsappTemplates).orderBy(desc(whatsappTemplates.createdAt));
  return rows.map(whatsappTemplateView);
}

export const WhatsappIntentBody = z
  .object({
    userId: z.string().trim().min(1).max(100),
    templateKey: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,60}$/),
    payload: z.record(z.string(), z.string().max(200)).default({}),
  })
  .strict();

const FORBIDDEN_PAYLOAD_KEY = /(phone|email|token|otp|password|secret)/i;

function payloadProblem(payload: Record<string, string>): string | null {
  const keys = Object.keys(payload);
  if (keys.length > 10) return "too many payload fields";
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) return `invalid field name: ${key}`;
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) return `sensitive field refused: ${key}`;
  }
  return null;
}

type IntentRow = typeof whatsappIntents.$inferSelect;

export function whatsappIntentView(row: IntentRow, provider = whatsappProviderState()) {
  return {
    id: row.id,
    userId: row.userId,
    templateKey: row.templateKey,
    decision: row.decision as WhatsAppDecision,
    detail: row.detail,
    deliveryState: row.deliveryState,
    /** Nothing is ever sent; this field exists so a caller cannot ignore the fact. */
    sent: false as const,
    provider,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Evaluate one would-be message and store the verdict. The ladder is deterministic and every
 * refusal is explicit; a provider outage is a recorded decision, not an exception.
 */
export async function evaluateWhatsappIntent(adminId: string, body: z.infer<typeof WhatsappIntentBody>) {
  await assertAdminActor(adminId);
  const [user] = await db.select({ marketId: users.activeMarketId }).from(users).where(eq(users.id, body.userId));
  if (!user || !user.marketId) throw fail(404, "المستخدم غير موجود في سوق", "USER_NOT_FOUND");
  const [template] = await db.select().from(whatsappTemplates).where(eq(whatsappTemplates.key, body.templateKey));
  if (!template) throw fail(404, "القالب غير موجود", "TEMPLATE_NOT_FOUND");

  const provider = whatsappProviderState();
  let decision: WhatsAppDecision;
  let detail: string;
  if (template.status === "DISABLED") {
    decision = "BLOCKED_TEMPLATE_DISABLED";
    detail = "القالب معطّل ولا يمكن استخدامه";
  } else if (template.status !== "APPROVED") {
    decision = "BLOCKED_TEMPLATE_NOT_APPROVED";
    detail = "القالب لم يعتمده مسؤول بعد";
  } else {
    const problem = payloadProblem(body.payload);
    const consent = await whatsappConsentStatus(body.userId);
    if (problem) {
      decision = "BLOCKED_PAYLOAD_INVALID";
      detail = problem;
    } else if (Object.keys(body.payload).length !== template.variableCount) {
      decision = "BLOCKED_PAYLOAD_INVALID";
      detail = "عدد حقول الرسالة لا يطابق متغيرات القالب";
    } else if (!consent.hasConsent) {
      decision = "BLOCKED_NO_CONSENT";
      detail = "لا توجد موافقة صريحة على رسائل واتساب";
    } else if (provider.availability !== "SIMULATED") {
      decision = "BLOCKED_PROVIDER_UNAVAILABLE";
      detail = "لا يوجد مزود واتساب مهيأ؛ لم يُرسل شيء";
    } else {
      decision = "READY_TO_SEND";
      detail = "جاهزة للإرسال عند تفعيل المزود؛ لم يُرسل شيء في هذه البيئة";
    }
  }

  const [row] = await db
    .insert(whatsappIntents)
    .values({
      id: randomUUID(),
      userId: body.userId,
      marketId: user.marketId,
      templateKey: template.key,
      payload: body.payload,
      decision,
      detail,
      deliveryState: "NOT_SENT",
    })
    .returning();
  return whatsappIntentView(row!, provider);
}

export async function whatsappOverview() {
  const templates = await db.select().from(whatsappTemplates);
  const intents = await db.select().from(whatsappIntents).orderBy(desc(whatsappIntents.createdAt)).limit(200);
  return {
    provider: whatsappProviderState(),
    liveSendsEnabled: false as const,
    templates: {
      total: templates.length,
      byStatus: templates.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
      byCategory: templates.reduce<Record<string, number>>((acc, row) => {
        acc[row.category] = (acc[row.category] ?? 0) + 1;
        return acc;
      }, {}),
    },
    intents: {
      total: intents.length,
      byDecision: intents.reduce<Record<string, number>>((acc, row) => {
        acc[row.decision] = (acc[row.decision] ?? 0) + 1;
        return acc;
      }, {}),
      latest: intents.slice(0, 20).map((row) => whatsappIntentView(row)),
    },
  };
}
