import { randomBytes, randomUUID } from "node:crypto";
import {
  aiResultSets,
  candidateProfiles,
  cartItems,
  carts,
  checkoutRequests,
  conversations,
  emailVerificationChallenges,
  messages,
  moderationAudit,
  notificationEmailJobs,
  offers,
  orders,
  jobs,
  privacyConsentEvents,
  userPrivacyPreferences,
  users,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { ACCOUNT_STATUS, revokeUserSessions } from "./account-status";

const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

export const OPEN_ORDER_STATUSES = [
  "CREATED",
  "PAYMENT_PENDING",
  "PAID",
  "ACCEPTED",
  "IN_PROGRESS",
  "SELLER_MARKED_DELIVERED",
  "BUYER_CONFIRMED",
  "DISPUTED",
] as const;

type Actor = { id: string; role: string };

export async function recordModerationAudit(
  tx: any,
  entry: {
    actor: Actor;
    action: string;
    targetType:
      | "LISTING"
      | "USER"
      | "ORDER"
      | "MESSAGE"
      | "AI_ANSWER"
      | "REPORT"
      | "POLICY_RULE"
      | "REASON_CODE"
      | "JOB"
      | "CANDIDATE_PROFILE";
    targetId: string;
    reportId?: string | null;
    reason?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    createdAt?: Date;
  },
) {
  await tx.insert(moderationAudit).values({
    id: randomUUID(),
    actorId: entry.actor.id,
    actorRole: entry.actor.role,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    reportId: entry.reportId ?? null,
    reason: (entry.reason ?? "").slice(0, 1000),
    before: entry.before ?? null,
    after: entry.after ?? null,
    ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
  });
}

export type ListingModerationAction = "HIDE" | "RESTORE" | "REMOVE";

/**
 * Admin-only listing moderation. Moderated listings leave discovery because
 * every public path requires status PUBLISHED, and sellers cannot manage
 * MODERATION_* rows because owner management accepts only PUBLISHED/PAUSED.
 * Rows are never deleted, so historical orders keep their references.
 */
export async function moderateListing(
  tx: any,
  input: {
    actor: Actor;
    listingId: string;
    action: ListingModerationAction;
    reason: string;
    reportId?: string | null;
  },
) {
  const [row] = await tx
    .select()
    .from(offers)
    .where(eq(offers.id, input.listingId))
    .for("update");
  if (!row) throw fail(404, "العرض غير موجود");
  const now = new Date();
  let status: string;
  let moderation: Record<string, unknown>;
  if (input.action === "HIDE") {
    if (["MODERATION_HIDDEN", "MODERATION_REMOVED", "ARCHIVED"].includes(row.status))
      throw fail(409, "لا يمكن إخفاء العرض في حالته الحالية");
    status = "MODERATION_HIDDEN";
    moderation = { state: "HIDDEN", previousStatus: row.status, at: now.toISOString() };
  } else if (input.action === "RESTORE") {
    if (row.status !== "MODERATION_HIDDEN")
      throw fail(409, "يمكن استعادة العروض المخفية بقرار إداري فقط");
    const previous = row.data.moderation?.previousStatus;
    status = ["PUBLISHED", "PAUSED", "SOLD_OUT", "DRAFT"].includes(previous)
      ? previous
      : "PAUSED";
    moderation = { state: "RESTORED", previousStatus: row.status, at: now.toISOString() };
  } else {
    if (row.status === "MODERATION_REMOVED")
      throw fail(409, "العرض محذوف إداريًا بالفعل");
    status = "MODERATION_REMOVED";
    moderation = { state: "REMOVED", previousStatus: row.status, at: now.toISOString() };
  }
  const [updated] = await tx
    .update(offers)
    .set({ status, data: { ...row.data, moderation }, updatedAt: now })
    .where(eq(offers.id, row.id))
    .returning();
  await recordModerationAudit(tx, {
    actor: input.actor,
    action: `LISTING_${input.action}`,
    targetType: "LISTING",
    targetId: row.id,
    reportId: input.reportId,
    reason: input.reason,
    before: { status: row.status },
    after: { status },
  });
  return updated as typeof offers.$inferSelect;
}

export type EmploymentModerationTarget = "JOB" | "CANDIDATE_PROFILE";
export type EmploymentModerationAction = "HIDE" | "RESTORE";

async function latestEmploymentModeration(tx: any, targetType: EmploymentModerationTarget, targetId: string) {
  const [row] = await tx
    .select()
    .from(moderationAudit)
    .where(and(eq(moderationAudit.targetType, targetType), eq(moderationAudit.targetId, targetId)))
    .orderBy(desc(moderationAudit.createdAt), desc(moderationAudit.id))
    .limit(1);
  return row as typeof moderationAudit.$inferSelect | undefined;
}

export async function assertEmploymentResourceNotModerated(
  tx: any,
  targetType: EmploymentModerationTarget,
  targetId: string,
) {
  const latest = await latestEmploymentModeration(tx, targetType, targetId);
  if (latest?.action === `${targetType}_HIDE`)
    throw fail(409, "هذا المحتوى مخفي بقرار إداري ولا يمكن تعديله حاليًا.");
}

/** Employment moderation shares the existing admin authority and audit trail. */
export async function moderateEmploymentResource(
  tx: any,
  input: {
    actor: Actor;
    targetType: EmploymentModerationTarget;
    targetId: string;
    action: EmploymentModerationAction;
    reason: string;
    reportId?: string | null;
  },
) {
  if (input.actor.role !== "ADMIN") throw fail(403, "هذه الصفحة متاحة لإدارة السوق فقط");

  if (input.targetType === "JOB") {
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, input.targetId)).for("update");
    if (!row) throw fail(404, "الوظيفة غير موجودة");
    const latest = await latestEmploymentModeration(tx, input.targetType, input.targetId);
    const held = latest?.action === `${input.targetType}_HIDE`;
    const now = new Date(Math.max(Date.now(), latest ? latest.createdAt.getTime() + 1 : 0));
    let status: string;
    if (input.action === "HIDE") {
      if (held) throw fail(409, "الوظيفة مخفية بقرار إداري بالفعل");
      if (!["PUBLISHED", "PAUSED"].includes(row.status))
        throw fail(409, "لا يمكن إخفاء الوظيفة في حالتها الحالية");
      status = "PAUSED";
    } else {
      if (!held) throw fail(409, "يمكن استعادة الوظائف المخفية بقرار إداري فقط");
      const prior = latest?.before?.status;
      status = prior === "PUBLISHED" || prior === "PAUSED" ? prior : "PAUSED";
    }
    const [updated] = await tx
      .update(jobs)
      .set({ status, updatedAt: now })
      .where(eq(jobs.id, row.id))
      .returning();
    await recordModerationAudit(tx, {
      actor: input.actor,
      action: `JOB_${input.action}`,
      targetType: "JOB",
      targetId: row.id,
      reportId: input.reportId,
      reason: input.reason,
      before: { status: row.status },
      after: { status },
      createdAt: now,
    });
    return updated;
  }

  const [row] = await tx
    .select()
    .from(candidateProfiles)
    .where(eq(candidateProfiles.id, input.targetId))
    .for("update");
  if (!row) throw fail(404, "الملف المهني غير موجود");
  const latest = await latestEmploymentModeration(tx, input.targetType, input.targetId);
  const held = latest?.action === `${input.targetType}_HIDE`;
  const now = new Date(Math.max(Date.now(), latest ? latest.createdAt.getTime() + 1 : 0));
  if (input.action === "HIDE" && held)
    throw fail(409, "الملف المهني مخفي بقرار إداري بالفعل");
  if (input.action === "RESTORE" && !held)
    throw fail(409, "يمكن استعادة الملفات المخفية بقرار إداري فقط");

  // Restoring a profile does not opt its owner back into discovery.
  const [updated] = await tx
    .update(candidateProfiles)
    .set({ visibility: "PRIVATE", updatedAt: now })
    .where(eq(candidateProfiles.id, row.id))
    .returning();
  await recordModerationAudit(tx, {
    actor: input.actor,
    action: `CANDIDATE_PROFILE_${input.action}`,
    targetType: "CANDIDATE_PROFILE",
    targetId: row.id,
    reportId: input.reportId,
    reason: input.reason,
    before: { visibility: row.visibility },
    after: { visibility: "PRIVATE" },
    createdAt: now,
  });
  return updated;
}

export async function setUserModerationStatus(
  tx: any,
  input: {
    actor: Actor;
    userId: string;
    status: "ACTIVE" | "RESTRICTED" | "SUSPENDED";
    reason: string;
    reportId?: string | null;
  },
) {
  if (input.userId === input.actor.id)
    throw fail(409, "لا يمكن تغيير حالة حسابك الإداري بنفسك");
  const [row] = await tx
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .for("update");
  if (!row) throw fail(404, "الحساب غير موجود");
  if (row.role === "ADMIN")
    throw fail(409, "لا يمكن تقييد حساب إداري من هذه الواجهة");
  if (row.status === ACCOUNT_STATUS.deactivated)
    throw fail(409, "الحساب محذوف ولا يمكن إعادة تفعيله");
  const now = new Date();
  const [updated] = await tx
    .update(users)
    .set({ status: input.status, statusChangedAt: now, updatedAt: now })
    .where(eq(users.id, row.id))
    .returning();
  // RESTRICTED keeps sessions (status is re-read on every commerce write);
  // SUSPENDED loses every session immediately.
  if (input.status === ACCOUNT_STATUS.suspended)
    await revokeUserSessions(row.id, tx);
  await recordModerationAudit(tx, {
    actor: input.actor,
    action: `USER_${input.status}`,
    targetType: "USER",
    targetId: row.id,
    reportId: input.reportId,
    reason: input.reason,
    before: { status: row.status },
    after: { status: input.status },
  });
  return updated as typeof users.$inferSelect;
}

/**
 * Owner-initiated account deletion. Personal profile data is anonymized and
 * sessions revoked, while orders, commission snapshots, dues, disputes,
 * reports and audit rows stay intact (see DATA_RETENTION_POLICY).
 */
export async function deactivateOwnAccount(tx: any, userId: string) {
  const [row] = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  if (!row || row.status === ACCOUNT_STATUS.deactivated)
    throw fail(404, "الحساب غير موجود");
  const [openOrder] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        or(eq(orders.buyerId, userId), eq(orders.sellerId, userId)),
        inArray(orders.status, [...OPEN_ORDER_STATUSES]),
      ),
    )
    .limit(1);
  if (openOrder)
    throw fail(
      409,
      "لديك طلبات أو نزاعات مفتوحة. أكملها أو ألغها قبل حذف الحساب.",
    );
  const now = new Date();
  const listings = await tx
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.sellerId, userId),
        inArray(offers.status, [
          "DRAFT",
          "PUBLISHED",
          "PAUSED",
          "SOLD_OUT",
          "MODERATION_HIDDEN",
        ]),
      ),
    )
    .for("update");
  for (const listing of listings)
    await tx
      .update(offers)
      .set({
        status: "ARCHIVED",
        data: {
          ...listing.data,
          contactPhone: null,
          archivedReason: "ACCOUNT_DELETED",
        },
        updatedAt: now,
      })
      .where(eq(offers.id, listing.id));

  const [preferences] = await tx
    .select({ marketingEmail: userPrivacyPreferences.marketingEmail, version: userPrivacyPreferences.version })
    .from(userPrivacyPreferences)
    .where(eq(userPrivacyPreferences.userId, userId))
    .for("update");
  if (preferences?.marketingEmail) {
    await tx.update(userPrivacyPreferences).set({
      marketingEmail: false,
      version: preferences.version + 1,
      updatedAt: now,
    }).where(eq(userPrivacyPreferences.userId, userId));
    await tx.insert(privacyConsentEvents).values({
      id: randomUUID(),
      userId,
      consentKey: "MARKETING_EMAIL",
      granted: false,
      source: "API",
      createdAt: now,
    });
  }
  await tx.update(notificationEmailJobs).set({
    status: "CANCELLED",
    leaseExpiresAt: null,
    lastErrorCode: "ACCOUNT_DEACTIVATED",
  }).where(and(
    eq(notificationEmailJobs.recipientId, userId),
    inArray(notificationEmailJobs.status, ["PENDING", "PROCESSING"]),
  ));
  await tx.update(emailVerificationChallenges)
    .set({ consumedAt: now })
    .where(and(
      eq(emailVerificationChallenges.userId, userId),
      isNull(emailVerificationChallenges.consumedAt),
    ));

  const userCarts = await tx
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.userId, userId));
  if (userCarts.length) {
    const cartIds = userCarts.map((cart: { id: string }) => cart.id);
    await tx.delete(cartItems).where(inArray(cartItems.cartId, cartIds));
    await tx.delete(carts).where(inArray(carts.id, cartIds));
  }
  await tx.delete(checkoutRequests).where(eq(checkoutRequests.userId, userId));

  const aiConversations = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.ownerUserId, userId), eq(conversations.kind, "AI")),
    );
  if (aiConversations.length) {
    const ids = aiConversations.map((item: { id: string }) => item.id);
    await tx.delete(aiResultSets).where(inArray(aiResultSets.conversationId, ids));
    await tx.delete(messages).where(inArray(messages.conversationId, ids));
    await tx.delete(conversations).where(inArray(conversations.id, ids));
  }

  await tx
    .update(users)
    .set({
      displayName: "حساب محذوف",
      phoneCountryCode: "",
      phoneNumber: "",
      normalizedPhone: `deleted:${userId}`,
      city: "",
      area: "",
      administrativeArea: "",
      avatarObjectPath: null,
      email: null,
      emailVerifiedAt: null,
      phoneVerified: false,
      passwordHash: `disabled:${randomBytes(32).toString("hex")}`,
      status: ACCOUNT_STATUS.deactivated,
      statusChangedAt: now,
      deactivatedAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
  await revokeUserSessions(userId, tx);
  await recordModerationAudit(tx, {
    actor: { id: userId, role: row.role },
    action: "ACCOUNT_DELETED",
    targetType: "USER",
    targetId: userId,
    reason: "OWNER_REQUEST",
    before: { status: row.status },
    after: {
      status: ACCOUNT_STATUS.deactivated,
      archivedListings: listings.length,
    },
  });
  return { previousAvatarObjectPath: row.avatarObjectPath as string | null };
}

