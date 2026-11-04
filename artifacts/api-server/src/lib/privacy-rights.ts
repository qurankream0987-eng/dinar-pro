/**
 * DINAR NEXT pre-integration: user privacy rights, one authority for the API and the conversation.
 *
 * - Access: a summary of what DINAR holds about the signed-in user (own data only).
 * - Export: a bounded machine-readable copy of the user's own records, produced on request after
 *   password re-authentication and never stored server-side; every request is tracked.
 * - Correction: profile fields are self-service (PATCH /account/profile); anything else (phone,
 *   records) is a tracked CORRECTION request for human review.
 * - Deletion: the existing account deletion keeps legally/operationally required records
 *   (DATA_RETENTION_POLICY) and is tracked here as a completed DELETION request.
 * - Consent & preferences: marketing per channel is opt-in; device-location sharing can be
 *   disabled. Every change appends to an append-only consent ledger.
 * - Inquiries, objections, restrictions: tracked requests with an append-only status history.
 *
 * Retention periods and response targets are configuration pending legal approval; nothing here
 * claims legal compliance. No counterparty's personal data is ever included in an export.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  aiUsageCounters,
  conversationSummaries,
  conversations,
  db,
  marketplaceReports,
  messages,
  offers,
  orders,
  personalMemories,
  personalMemoryControls,
  policyAcceptances,
  policyConsentEvents,
  privacyConsentEvents,
  privacyRequestEvents,
  privacyRequests,
  transactionLocations,
  userPrivacyPreferences,
  users,
} from "@workspace/db";
import { DATA_RETENTION_POLICY } from "./policies";
import { listPolicyConsentEvents } from "./policy-lifecycle";
import { logger } from "./logger";
import { notifyUserAfterDecision } from "./notifications";

const fail = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });

export const PRIVACY_REQUEST_KINDS = ["ACCESS", "EXPORT", "CORRECTION", "DELETION", "CONSENT_WITHDRAWAL", "OBJECTION", "RESTRICTION", "INQUIRY"] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
/** Kinds a user files for human handling; ACCESS/EXPORT/DELETION are recorded by their own flows. */
export const USER_FILED_KINDS = ["CORRECTION", "CONSENT_WITHDRAWAL", "OBJECTION", "RESTRICTION", "INQUIRY"] as const;
export const PRIVACY_REQUEST_STATUSES = ["RECEIVED", "IN_REVIEW", "COMPLETED", "REJECTED", "WITHDRAWN"] as const;
type Status = (typeof PRIVACY_REQUEST_STATUSES)[number];
const TERMINAL: readonly Status[] = ["COMPLETED", "REJECTED", "WITHDRAWN"];
const TRANSITIONS: Record<Status, readonly Status[]> = {
  RECEIVED: ["IN_REVIEW", "COMPLETED", "REJECTED", "WITHDRAWN"],
  IN_REVIEW: ["COMPLETED", "REJECTED", "WITHDRAWN"],
  COMPLETED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export const PRIVACY_KIND_LABELS: Record<PrivacyRequestKind, string> = {
  ACCESS: "الاطلاع على بياناتي",
  EXPORT: "تصدير بياناتي",
  CORRECTION: "تصحيح بيانات",
  DELETION: "حذف الحساب",
  CONSENT_WITHDRAWAL: "سحب موافقة",
  OBJECTION: "اعتراض على معالجة",
  RESTRICTION: "تقييد معالجة",
  INQUIRY: "استفسار خصوصية",
};
export const PRIVACY_STATUS_LABELS: Record<Status, string> = {
  RECEIVED: "مستلم",
  IN_REVIEW: "قيد المراجعة",
  COMPLETED: "مكتمل",
  REJECTED: "مرفوض مع السبب",
  WITHDRAWN: "مسحوب",
};

// ─── Configuration pending legal approval ────────────────────────────────────

const RetentionOverride = z.record(z.string().min(1).max(120), z.union([z.number().int().min(0).max(36_500), z.literal("REQUIRES_LAUNCH_COUNTRY_REVIEW")]));

/**
 * Retention periods: DATA_RETENTION_POLICY's handling with periods overridable by
 * DINAR_RETENTION_PERIODS_JSON ({"<record>": days}). `approved` is true only when the owner sets
 * DINAR_RETENTION_APPROVED=true after legal review; until then every period is provisional.
 */
export function retentionPolicy(env: NodeJS.ProcessEnv = process.env) {
  let overrides: z.infer<typeof RetentionOverride> = {};
  try {
    overrides = env.DINAR_RETENTION_PERIODS_JSON ? RetentionOverride.parse(JSON.parse(env.DINAR_RETENTION_PERIODS_JSON)) : {};
  } catch {
    logger.warn({ event: "dinar_retention_config_invalid" }, "DINAR_RETENTION_PERIODS_JSON is invalid; using defaults");
  }
  return {
    approved: env.DINAR_RETENTION_APPROVED === "true",
    records: DATA_RETENTION_POLICY.map((item) => {
      const override = overrides[item.record];
      return { ...item, period: override === undefined ? item.period : typeof override === "number" ? `${override}_DAYS` : override };
    }),
  };
}

/** Response target for tracked requests (DINAR_PRIVACY_RESPONSE_DAYS); absent = not yet approved. */
export function privacyResponseDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const days = Number(env.DINAR_PRIVACY_RESPONSE_DAYS);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}

// ─── Requests ────────────────────────────────────────────────────────────────

type RequestRow = typeof privacyRequests.$inferSelect;
export function privacyRequestView(row: RequestRow) {
  return {
    id: row.id,
    kind: row.kind as PrivacyRequestKind,
    kindLabel: PRIVACY_KIND_LABELS[row.kind as PrivacyRequestKind] ?? row.kind,
    status: row.status as Status,
    statusLabel: PRIVACY_STATUS_LABELS[row.status as Status] ?? row.status,
    channel: row.channel,
    subject: row.subject,
    outcomeCode: row.outcomeCode,
    outcomeNote: row.outcomeNote,
    dueAt: row.dueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Records a request (idempotent per user and key). Completed kinds pass `completed`. */
export async function recordPrivacyRequest(
  input: {
    userId: string;
    kind: PrivacyRequestKind;
    channel: "API" | "CONVERSATION";
    idempotencyKey: string;
    subject?: string | null;
    details?: string | null;
    completed?: { outcomeCode: string; outcomeNote?: string };
  },
  tx: Tx | typeof db = db,
) {
  if (!KEY.test(input.idempotencyKey)) throw fail(400, "مفتاح عدم التكرار غير صالح");
  const [prior] = await tx.select().from(privacyRequests).where(and(eq(privacyRequests.userId, input.userId), eq(privacyRequests.idempotencyKey, input.idempotencyKey)));
  if (prior) {
    if (prior.kind !== input.kind) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
    return { row: prior, created: false };
  }
  const now = new Date();
  const days = privacyResponseDays();
  const status: Status = input.completed ? "COMPLETED" : "RECEIVED";
  const [row] = await tx
    .insert(privacyRequests)
    .values({
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      status,
      channel: input.channel,
      subject: input.subject?.trim().slice(0, 120) || null,
      details: input.details?.trim().slice(0, 2000) || null,
      outcomeCode: input.completed?.outcomeCode ?? null,
      outcomeNote: input.completed?.outcomeNote?.slice(0, 2000) ?? null,
      dueAt: input.completed || days === null ? null : new Date(now.getTime() + days * 86_400_000),
      resolvedAt: input.completed ? now : null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // A concurrent duplicate won the insert: return it.
    const [winner] = await tx.select().from(privacyRequests).where(and(eq(privacyRequests.userId, input.userId), eq(privacyRequests.idempotencyKey, input.idempotencyKey)));
    return { row: winner!, created: false };
  }
  await tx.insert(privacyRequestEvents).values({ id: randomUUID(), requestId: row.id, actorKind: input.completed ? "SYSTEM" : "USER", actorId: input.completed ? null : input.userId, fromStatus: null, toStatus: status, createdAt: now });
  logger.info({ event: "dinar_privacy_request", kind: input.kind, status }, "privacy request recorded");
  return { row, created: true };
}

export const FileRequestBody = z
  .object({
    kind: z.enum(USER_FILED_KINDS),
    subject: z.string().trim().max(120).optional(),
    details: z.string().trim().min(3).max(2000),
    idempotencyKey: z.string().regex(KEY),
  })
  .strict();

export async function fileUserPrivacyRequest(userId: string, body: z.infer<typeof FileRequestBody>, channel: "API" | "CONVERSATION") {
  const open = await db
    .select({ n: count() })
    .from(privacyRequests)
    .where(and(eq(privacyRequests.userId, userId), inArray(privacyRequests.status, ["RECEIVED", "IN_REVIEW"])));
  const [existing] = await db.select().from(privacyRequests).where(and(eq(privacyRequests.userId, userId), eq(privacyRequests.idempotencyKey, body.idempotencyKey)));
  if (!existing && (open[0]?.n ?? 0) >= 10) throw fail(429, "لديك عشرة طلبات خصوصية مفتوحة؛ انتظر الرد على بعضها أولًا.", "TOO_MANY_OPEN_REQUESTS");
  const { row } = await recordPrivacyRequest({ userId, kind: body.kind, channel, idempotencyKey: body.idempotencyKey, subject: body.subject, details: body.details });
  return privacyRequestView(row);
}

export async function listOwnPrivacyRequests(userId: string) {
  const rows = await db.select().from(privacyRequests).where(eq(privacyRequests.userId, userId)).orderBy(desc(privacyRequests.createdAt)).limit(50);
  return rows.map(privacyRequestView);
}

/** Status history of one own request; a foreign id is indistinguishable from a missing one. */
export async function ownPrivacyRequest(userId: string, requestId: string) {
  const [row] = await db.select().from(privacyRequests).where(and(eq(privacyRequests.id, requestId), eq(privacyRequests.userId, userId)));
  if (!row) throw fail(404, "طلب الخصوصية غير موجود");
  const history = await db
    .select({ fromStatus: privacyRequestEvents.fromStatus, toStatus: privacyRequestEvents.toStatus, actorKind: privacyRequestEvents.actorKind, note: privacyRequestEvents.note, createdAt: privacyRequestEvents.createdAt })
    .from(privacyRequestEvents)
    .where(eq(privacyRequestEvents.requestId, row.id))
    .orderBy(privacyRequestEvents.createdAt);
  return { ...privacyRequestView(row), history: history.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })) };
}

async function transition(requestId: string, to: Status, actor: { kind: "USER" | "ADMIN"; id: string }, outcome: { code?: string; note?: string } = {}, ownerId?: string) {
  let requesterId = "";
  const view = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(privacyRequests)
      .where(and(eq(privacyRequests.id, requestId), ...(ownerId ? [eq(privacyRequests.userId, ownerId)] : [])))
      .for("update");
    if (!row) throw fail(404, "طلب الخصوصية غير موجود");
    const from = row.status as Status;
    if (!TRANSITIONS[from].includes(to)) throw fail(409, `لا يمكن نقل الطلب من «${PRIVACY_STATUS_LABELS[from]}» إلى «${PRIVACY_STATUS_LABELS[to]}».`, "INVALID_TRANSITION");
    const now = new Date();
    const terminal = TERMINAL.includes(to);
    const [updated] = await tx
      .update(privacyRequests)
      .set({
        status: to,
        ...(outcome.code ? { outcomeCode: outcome.code.slice(0, 64) } : {}),
        ...(outcome.note ? { outcomeNote: outcome.note.slice(0, 2000) } : {}),
        ...(terminal ? { resolvedAt: now, resolvedBy: actor.kind === "ADMIN" ? actor.id : null } : {}),
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, row.id))
      .returning();
    await tx.insert(privacyRequestEvents).values({ id: randomUUID(), requestId: row.id, actorKind: actor.kind, actorId: actor.id, fromStatus: from, toStatus: to, note: outcome.note?.slice(0, 2000) ?? null, createdAt: now });
    requesterId = row.userId;
    return privacyRequestView(updated!);
  });
  // The requester is told when DINAR acts on their request; their own withdrawal needs no message.
  if (actor.kind === "ADMIN") notifyUserAfterDecision({ recipientId: requesterId, templateKey: "PRIVACY_REQUEST_UPDATED", data: { requestId: view.id, status: view.status } });
  return view;
}

export function withdrawOwnPrivacyRequest(userId: string, requestId: string) {
  return transition(requestId, "WITHDRAWN", { kind: "USER", id: userId }, { code: "WITHDRAWN_BY_USER" }, userId);
}

export const AdminTransitionBody = z
  .object({
    status: z.enum(["IN_REVIEW", "COMPLETED", "REJECTED"]),
    outcomeCode: z.string().regex(/^[A-Z0-9_]{2,64}$/).optional(),
    note: z.string().trim().min(3).max(2000).optional(),
  })
  .strict()
  // A decision always carries its reason for the user.
  .refine((body) => body.status === "IN_REVIEW" || Boolean(body.outcomeCode && body.note), { message: "outcomeCode and note are required to resolve" });

export function adminTransitionPrivacyRequest(adminId: string, requestId: string, body: z.infer<typeof AdminTransitionBody>) {
  return transition(requestId, body.status, { kind: "ADMIN", id: adminId }, { code: body.outcomeCode, note: body.note });
}

export async function adminPrivacyQueue(status?: Status) {
  const rows = await db
    .select({ request: privacyRequests, displayName: users.displayName })
    .from(privacyRequests)
    .innerJoin(users, eq(users.id, privacyRequests.userId))
    .where(status ? eq(privacyRequests.status, status) : inArray(privacyRequests.status, ["RECEIVED", "IN_REVIEW"]))
    .orderBy(privacyRequests.createdAt)
    .limit(100);
  return rows.map((row) => ({ ...privacyRequestView(row.request), userId: row.request.userId, displayName: row.displayName, details: row.request.details }));
}

// ─── Preferences and consent ─────────────────────────────────────────────────

export const CONSENT_KEYS = ["MARKETING_IN_APP", "MARKETING_EMAIL", "MARKETING_SMS", "MARKETING_PUSH", "DEVICE_LOCATION_SHARING"] as const;
type PreferenceRow = typeof userPrivacyPreferences.$inferSelect;
const DEFAULT_PREFERENCES = { marketingInApp: false, marketingEmail: false, marketingSms: false, marketingPush: false, deviceLocationSharing: "ASK_EACH_TIME" as const, version: 0 };

export function preferencesView(row: Pick<PreferenceRow, "marketingInApp" | "marketingEmail" | "marketingSms" | "marketingPush" | "deviceLocationSharing" | "version"> | undefined) {
  const value = row ?? DEFAULT_PREFERENCES;
  return {
    version: value.version,
    communications: {
      /** Order, payment, delivery, security and support notices are part of the service, not marketing. */
      transactional: { inApp: true, editable: false },
      marketing: { inApp: value.marketingInApp, email: value.marketingEmail, sms: value.marketingSms, push: value.marketingPush },
    },
    location: {
      deviceLocationSharing: value.deviceLocationSharing as "ASK_EACH_TIME" | "DISABLED",
      note: "يُطلب إذنك في كل مرة، ويُشارك الموقع مع طرف الطلب فقط ولمدة الطلب. الإيقاف يمنع مشاركة موقع الجهاز؛ يبقى إدخال المدينة والمنطقة يدويًا ممكنًا.",
    },
    /** Outbound email/SMS/push providers are not connected: these choices take effect when they are. */
    deliveryChannelsConnected: { email: false, sms: false, push: false },
  };
}

export async function getPrivacyPreferences(userId: string, tx: Tx | typeof db = db) {
  const [row] = await tx.select().from(userPrivacyPreferences).where(eq(userPrivacyPreferences.userId, userId));
  return preferencesView(row);
}

export const PreferencesPatch = z
  .object({
    expectedVersion: z.number().int().min(0).optional(),
    marketing: z.object({ inApp: z.boolean(), email: z.boolean(), sms: z.boolean(), push: z.boolean() }).partial().strict().optional(),
    deviceLocationSharing: z.enum(["ASK_EACH_TIME", "DISABLED"]).optional(),
  })
  .strict();

/** Applies a preference change; each changed consent appends to the ledger. Stale versions conflict. */
export async function updatePrivacyPreferences(userId: string, patch: z.infer<typeof PreferencesPatch>, source: "API" | "CONVERSATION", policyVersion?: string) {
  return db.transaction(async (tx) => {
    await tx.insert(userPrivacyPreferences).values({ userId, version: 0 }).onConflictDoNothing();
    const [current] = await tx.select().from(userPrivacyPreferences).where(eq(userPrivacyPreferences.userId, userId)).for("update");
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== current!.version) throw fail(409, "تغيرت تفضيلاتك منذ آخر عرض؛ راجعها مجددًا.", "STALE_PREFERENCES");
    const next = {
      marketingInApp: patch.marketing?.inApp ?? current!.marketingInApp,
      marketingEmail: patch.marketing?.email ?? current!.marketingEmail,
      marketingSms: patch.marketing?.sms ?? current!.marketingSms,
      marketingPush: patch.marketing?.push ?? current!.marketingPush,
      deviceLocationSharing: patch.deviceLocationSharing ?? current!.deviceLocationSharing,
    };
    const changes: Array<[(typeof CONSENT_KEYS)[number], boolean]> = [];
    if (next.marketingInApp !== current!.marketingInApp) changes.push(["MARKETING_IN_APP", next.marketingInApp]);
    if (next.marketingEmail !== current!.marketingEmail) changes.push(["MARKETING_EMAIL", next.marketingEmail]);
    if (next.marketingSms !== current!.marketingSms) changes.push(["MARKETING_SMS", next.marketingSms]);
    if (next.marketingPush !== current!.marketingPush) changes.push(["MARKETING_PUSH", next.marketingPush]);
    if (next.deviceLocationSharing !== current!.deviceLocationSharing) changes.push(["DEVICE_LOCATION_SHARING", next.deviceLocationSharing === "ASK_EACH_TIME"]);
    if (!changes.length) return { ...preferencesView(current), changed: [] as string[] };
    const now = new Date();
    const [updated] = await tx
      .update(userPrivacyPreferences)
      .set({ ...next, version: current!.version + 1, updatedAt: now })
      .where(eq(userPrivacyPreferences.userId, userId))
      .returning();
    await tx.insert(privacyConsentEvents).values(changes.map(([consentKey, granted]) => ({ id: randomUUID(), userId, consentKey, granted, source, policyVersion: policyVersion ?? null, createdAt: now })));
    return { ...preferencesView(updated), changed: changes.map(([key]) => key) };
  });
}

/** Server-side gate for device coordinates: the user's own setting, never a client claim. */
export async function deviceLocationSharingAllowed(userId: string, tx: Tx | typeof db = db): Promise<boolean> {
  const [row] = await tx.select({ value: userPrivacyPreferences.deviceLocationSharing }).from(userPrivacyPreferences).where(eq(userPrivacyPreferences.userId, userId));
  return row?.value !== "DISABLED";
}

async function consentHistory(userId: string, limit = 200) {
  const rows = await db
    .select({ consentKey: privacyConsentEvents.consentKey, granted: privacyConsentEvents.granted, source: privacyConsentEvents.source, createdAt: privacyConsentEvents.createdAt })
    .from(privacyConsentEvents)
    .where(eq(privacyConsentEvents.userId, userId))
    .orderBy(desc(privacyConsentEvents.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

// ─── Access and export ───────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  listings: "إعلاناتك",
  ordersAsBuyer: "طلباتك كمشترٍ",
  ordersAsSeller: "طلباتك كبائع",
  messagesSent: "رسائل أرسلتها",
  aiConversations: "محادثاتك مع المساعد",
  personalMemories: "ما يتذكره المساعد عنك",
  conversationSummaries: "ملخصات مشتقة من محادثاتك",
  reportsFiled: "بلاغات قدمتها",
  policyAcceptances: "موافقاتك على السياسات",
  policyConsents: "سجل قراراتك على السياسات",
  sharedLocations: "مواقع شاركتها لطلبات",
  privacyRequests: "طلبات الخصوصية",
} as const;

/** What DINAR holds about the user: own profile and per-category counts. No counterparty data. */
export async function personalDataSummary(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw fail(404, "الحساب غير موجود");
  const n = async (query: Promise<Array<{ n: number }>>) => Number((await query)[0]?.n ?? 0);
  const [listings, ordersAsBuyer, ordersAsSeller, messagesSent, aiConversations, memories, derivedSummaries, reports, acceptances, consents, locations, requests] = await Promise.all([
    n(db.select({ n: count() }).from(offers).where(eq(offers.sellerId, userId))),
    n(db.select({ n: count() }).from(orders).where(eq(orders.buyerId, userId))),
    n(db.select({ n: count() }).from(orders).where(eq(orders.sellerId, userId))),
    n(db.select({ n: count() }).from(messages).where(eq(messages.senderId, userId))),
    n(db.select({ n: count() }).from(conversations).where(and(eq(conversations.ownerUserId, userId), eq(conversations.kind, "AI")))),
    n(db.select({ n: count() }).from(personalMemories).where(and(eq(personalMemories.userId, userId), eq(personalMemories.status, "ACTIVE")))),
    n(db.select({ n: count() }).from(conversationSummaries).where(eq(conversationSummaries.ownerUserId, userId))),
    n(db.select({ n: count() }).from(marketplaceReports).where(eq(marketplaceReports.reporterId, userId))),
    n(db.select({ n: count() }).from(policyAcceptances).where(eq(policyAcceptances.userId, userId))),
    n(db.select({ n: count() }).from(policyConsentEvents).where(eq(policyConsentEvents.userId, userId))),
    n(db.select({ n: count() }).from(transactionLocations).where(and(eq(transactionLocations.sharedBy, userId), isNull(transactionLocations.redactedAt)))),
    n(db.select({ n: count() }).from(privacyRequests).where(eq(privacyRequests.userId, userId))),
  ]);
  const counts = { listings, ordersAsBuyer, ordersAsSeller, messagesSent, aiConversations, personalMemories: memories, conversationSummaries: derivedSummaries, reportsFiled: reports, policyAcceptances: acceptances, policyConsents: consents, sharedLocations: locations, privacyRequests: requests };
  return {
    profile: {
      displayName: user.displayName,
      phone: `${user.phoneCountryCode} ${user.phoneNumber}`,
      phoneVerified: user.phoneVerified,
      accountCountry: user.accountCountry,
      activeMarketId: user.activeMarketId,
      city: user.city,
      area: user.area,
      locale: user.locale,
      timeZone: user.timeZone,
      hasAvatar: Boolean(user.avatarObjectPath),
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    },
    categories: (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((key) => ({ key, label: CATEGORY_LABELS[key], count: counts[key] })),
    preferences: await getPrivacyPreferences(userId),
    retention: retentionPolicy(),
    selfServiceCorrection: ["displayName", "city", "area"],
    notIncluded: ["سجلات التشغيل المؤقتة", "النسخ الاحتياطية", "ما يحتفظ به مزودو الخدمات الخارجيون وفق شروطهم"],
  };
}

const EXPORT_LIMIT = 500;
const bounded = <T>(rows: T[]) => ({ items: rows.slice(0, EXPORT_LIMIT), truncated: rows.length > EXPORT_LIMIT });

/**
 * The user's own records as JSON. Bounded per category (truncation is flagged, never hidden).
 * Counterparties are referenced by role only; device coordinates are withheld pending legal
 * review (listed in `withheld`). Produced on demand and not stored by the server.
 */
export async function buildPersonalDataExport(userId: string) {
  const summary = await personalDataSummary(userId);
  const take = EXPORT_LIMIT + 1;
  const [listingRows, orderRows, messageRows, conversationRows, memoryRows, summaryRows, reportRows, acceptanceRows, locationRows, usageRows, memoryControlRows] = await Promise.all([
    db.select({ id: offers.id, status: offers.status, marketId: offers.marketId, unitPriceMinor: offers.unitPriceMinor, data: offers.data, createdAt: offers.createdAt }).from(offers).where(eq(offers.sellerId, userId)).orderBy(desc(offers.createdAt)).limit(take),
    db.select().from(orders).where(or(eq(orders.buyerId, userId), eq(orders.sellerId, userId))).orderBy(desc(orders.createdAt)).limit(take),
    db.select({ id: messages.id, conversationId: messages.conversationId, body: messages.body, createdAt: messages.createdAt }).from(messages).where(eq(messages.senderId, userId)).orderBy(desc(messages.createdAt)).limit(take),
    db.select({ id: conversations.id, title: conversations.title, kind: conversations.kind, createdAt: conversations.createdAt }).from(conversations).where(eq(conversations.ownerUserId, userId)).orderBy(desc(conversations.createdAt)).limit(take),
    db.select({ topic: personalMemories.topic, kind: personalMemories.kind, label: personalMemories.label, value: personalMemories.value, status: personalMemories.status, lastSeenAt: personalMemories.lastSeenAt }).from(personalMemories).where(eq(personalMemories.userId, userId)).limit(take),
    // Derived, disposable memory: disclosed so the user sees what DINAR keeps beyond their own words.
    db.select({ conversationId: conversationSummaries.conversationId, marketId: conversationSummaries.marketId, summary: conversationSummaries.summary, topics: conversationSummaries.topics, sourceMessageIds: conversationSummaries.sourceMessageIds, messageCount: conversationSummaries.messageCount, derivation: conversationSummaries.derivation, watermarkAt: conversationSummaries.watermarkAt, updatedAt: conversationSummaries.updatedAt }).from(conversationSummaries).where(eq(conversationSummaries.ownerUserId, userId)).orderBy(desc(conversationSummaries.updatedAt)).limit(take),
    db.select({ id: marketplaceReports.id, targetType: marketplaceReports.targetType, reasonCode: marketplaceReports.reasonCode, note: marketplaceReports.note, status: marketplaceReports.status, createdAt: marketplaceReports.createdAt }).from(marketplaceReports).where(eq(marketplaceReports.reporterId, userId)).limit(take),
    db.select({ policyKey: policyAcceptances.policyKey, policyVersion: policyAcceptances.policyVersion, acceptedAt: policyAcceptances.acceptedAt }).from(policyAcceptances).where(eq(policyAcceptances.userId, userId)).limit(take),
    db.select({ orderId: transactionLocations.orderId, purpose: transactionLocations.purpose, source: transactionLocations.source, city: transactionLocations.city, area: transactionLocations.area, addressText: transactionLocations.addressText, createdAt: transactionLocations.createdAt }).from(transactionLocations).where(and(eq(transactionLocations.sharedBy, userId), isNull(transactionLocations.redactedAt))).limit(take),
    db.select({ resource: aiUsageCounters.resource, periodStart: aiUsageCounters.periodStart, consumedRequests: aiUsageCounters.consumedRequests, consumedTokens: aiUsageCounters.consumedTokens }).from(aiUsageCounters).where(eq(aiUsageCounters.ownerKey, `user:${userId}`)).limit(take),
    db.select({ control: personalMemoryControls.control, enabled: personalMemoryControls.enabled }).from(personalMemoryControls).where(eq(personalMemoryControls.userId, userId)),
  ]);
  const ownAiConversationIds = conversationRows.filter((row) => row.kind === "AI").map((row) => row.id).slice(0, 100);
  const assistantRows = ownAiConversationIds.length
    ? await db
        .select({ conversationId: messages.conversationId, body: messages.body, createdAt: messages.createdAt })
        .from(messages)
        .where(and(inArray(messages.conversationId, ownAiConversationIds), eq(messages.actor, "ASSISTANT")))
        .orderBy(desc(messages.createdAt))
        .limit(take)
    : [];
  return {
    format: "DINAR_PERSONAL_DATA_EXPORT",
    version: 1,
    generatedAt: new Date().toISOString(),
    completeness: "BOUNDED" as const,
    perCategoryLimit: EXPORT_LIMIT,
    profile: summary.profile,
    preferences: summary.preferences,
    consentHistory: await consentHistory(userId),
    policyConsentEvents: await listPolicyConsentEvents(userId),
    personalMemoryControls: memoryControlRows,
    listings: bounded(listingRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    orders: bounded(
      orderRows.map((row) => ({
        id: row.id,
        role: row.buyerId === userId ? "BUYER" : "SELLER",
        status: row.status,
        marketId: row.marketId,
        currencyCode: row.currencyCode,
        quantity: row.quantity,
        subtotalMinor: row.subtotalMinor,
        ...(row.sellerId === userId ? { platformFeeMinor: row.platformFeeMinor, sellerAmountMinor: row.sellerAmountMinor } : {}),
        createdAt: row.createdAt.toISOString(),
      })),
    ),
    messagesSent: bounded(messageRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    conversations: bounded(conversationRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    assistantReplies: bounded(assistantRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    personalMemories: bounded(memoryRows.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt.toISOString() }))),
    conversationSummaries: bounded(
      summaryRows.map((row) => ({ ...row, watermarkAt: row.watermarkAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    ),
    reportsFiled: bounded(reportRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    policyAcceptances: bounded(acceptanceRows.map((row) => ({ ...row, acceptedAt: row.acceptedAt.toISOString() }))),
    sharedLocations: bounded(locationRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    aiUsage: bounded(usageRows.map((row) => ({ ...row, periodStart: row.periodStart.toISOString() }))),
    privacyRequests: await listOwnPrivacyRequests(userId),
    withheld: [
      { field: "sharedLocations.latitude/longitude", reason: "إحداثيات الجهاز الدقيقة تُعرض على الطلب نفسه لطرفيه؛ إدراجها في التصدير بانتظار المراجعة القانونية." },
      { field: "orders.counterparty", reason: "بيانات الطرف الآخر شخصية له؛ يُذكر دورك فقط." },
    ],
    retention: summary.retention,
  };
}
