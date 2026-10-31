import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import {
  db,
  conversations,
  marketplacePolicyRules,
  marketplaceReports,
  markets,
  messages,
  moderationAudit,
  moderationReasonCodes,
  offers,
  orders,
  users,
} from "@workspace/db";
import { requireAuth, verifyPassword } from "../lib/auth";
import { createAuthRateLimitMiddleware } from "../lib/auth-rate-limiter";
import { ACCOUNT_STATUS } from "../lib/account-status";
import {
  deactivateOwnAccount,
  moderateEmploymentResource,
  moderateListing,
  recordModerationAudit,
  setUserModerationStatus,
} from "../lib/moderation";
import {
  currentPolicies,
  currentPolicy,
  DATA_RETENTION_POLICY,
} from "../lib/policies";
import {
  policyConsentStatus,
  policyContentSha256,
  policyLifecycleFor,
  recordPolicyDecision,
} from "../lib/policy-lifecycle";
import { PLATFORM_FEE_BASIS_POINTS } from "../lib/market-pricing";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { recordPrivacyRequest } from "../lib/privacy-rights";
import { notifyUserAfterDecision } from "../lib/notifications";
import { responseTargetHours, responseTiming } from "../lib/response-targets";

const router = Router();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

export const REPORTS_PER_DAY_LIMIT = 10;
const TARGET_TYPES = ["LISTING", "USER", "ORDER", "MESSAGE", "AI_ANSWER"] as const;
type TargetType = (typeof TARGET_TYPES)[number];

const reasonText = z.string().trim().min(3).max(1000);

// ---------------------------------------------------------------- policies

router.get("/policies", async (_req, res) => {
  const policies = [];
  for (const document of currentPolicies()) {
    const { sections: _sections, ...summary } = document;
    const registered = await policyLifecycleFor(document.key, document.version);
    policies.push({
      ...summary,
      contentSha256: policyContentSha256(document),
      lifecycle: registered?.lifecycle ?? "NOT_REGISTERED",
    });
  }
  res.json({
    policies,
    fees: {
      commissionRateBps: PLATFORM_FEE_BASIS_POINTS,
      payer: "SELLER",
      buyerFeeBps: 0,
    },
  });
});

router.get("/policies/:key", async (req, res) => {
  const policy = currentPolicy(String(req.params.key));
  if (!policy) throw fail(404, "السياسة غير موجودة");
  const registered = await policyLifecycleFor(policy.key, policy.version);
  res.json({
    ...policy,
    contentSha256: policyContentSha256(policy),
    lifecycle: registered?.lifecycle ?? "NOT_REGISTERED",
  });
});

router.get("/account/policy-acceptances", requireAuth, async (req, res) => {
  const status = await policyConsentStatus(req.actor!.id);
  res.json(status.required);
});

router.post("/account/policy-acceptances", requireAuth, async (req, res) => {
  const body = z
    .object({ key: z.string().max(60), version: z.string().max(40) })
    .strict()
    .parse(req.body);
  const policy = currentPolicy(body.key);
  if (!policy?.requiresAcceptance)
    throw fail(409, "نسخة السياسة غير متاحة للموافقة");
  const { event } = await recordPolicyDecision({
    userId: req.actor!.id,
    key: policy.key,
    version: body.version,
    decision: "ACCEPTED",
    source: "POLICY_REVIEW",
    idempotencyKey: `review:${policy.key}:${body.version}`,
  });
  res.status(201).json({ key: event.key, version: event.version });
});

// ----------------------------------------------------------------- reports

router.get("/reports/reasons", async (req, res) => {
  const targetType = String(req.query.targetType ?? "");
  const rows = await db
    .select()
    .from(moderationReasonCodes)
    .where(eq(moderationReasonCodes.isActive, true))
    .orderBy(moderationReasonCodes.sortOrder);
  res.json(
    rows
      .filter((row) => !targetType || row.targetTypes.includes(targetType))
      .filter((row) => row.targetTypes.length > 0)
      .map((row) => ({
        code: row.code,
        labelAr: row.labelAr,
        labelEn: row.labelEn,
        targetTypes: row.targetTypes,
      })),
  );
});

const CreateReportBody = z
  .object({
    targetType: z.enum(TARGET_TYPES),
    targetId: z.string().min(1).max(100),
    reasonCode: z.string().min(2).max(42),
    note: z.string().max(1000).optional(),
  })
  .strict();

/**
 * Resolves the market a report belongs to, or a uniform 404 if the reporter
 * may not report that target (missing, foreign market, own, not visible).
 */
async function reportableTargetMarket(
  tx: any,
  reporter: typeof users.$inferSelect,
  targetType: TargetType,
  targetId: string,
): Promise<string> {
  const notFound = () => fail(404, "لا يمكن الإبلاغ عن هذا العنصر");
  if (targetType === "LISTING") {
    const [offer] = await tx.select().from(offers).where(eq(offers.id, targetId));
    if (
      !offer ||
      offer.sellerId === reporter.id ||
      offer.marketId !== reporter.activeMarketId
    )
      throw notFound();
    if (offer.status !== "PUBLISHED") {
      const [purchase] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.buyerId, reporter.id), eq(orders.sellerId, offer.sellerId)))
        .limit(1);
      if (!purchase) throw notFound();
    }
    return offer.marketId;
  }
  if (targetType === "ORDER") {
    const [order] = await tx.select().from(orders).where(eq(orders.id, targetId));
    if (!order || ![order.buyerId, order.sellerId].includes(reporter.id))
      throw notFound();
    return order.marketId;
  }
  if (targetType === "MESSAGE") {
    // Only a message the reporter received from the other side of their own order.
    const [message] = await tx.select().from(messages).where(eq(messages.id, targetId));
    if (!message || !message.senderId || message.senderId === reporter.id) throw notFound();
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, message.conversationId));
    if (!conversation || conversation.kind !== "ORDER" || !conversation.orderId) throw notFound();
    const [order] = await tx.select().from(orders).where(eq(orders.id, conversation.orderId));
    if (!order || ![order.buyerId, order.sellerId].includes(reporter.id)) throw notFound();
    return order.marketId;
  }
  if (targetType === "AI_ANSWER") {
    // Reporting an AI answer keeps ids only: the answer text is never copied out of the message.
    const [message] = await tx.select().from(messages).where(eq(messages.id, targetId));
    if (!message) throw notFound();
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, message.conversationId));
    if (!conversation || conversation.kind !== "AI" || conversation.ownerUserId !== reporter.id) throw notFound();
    if (message.senderId === reporter.id) throw notFound();
    if (!conversation.marketId) throw notFound();
    return conversation.marketId;
  }
  if (targetId === reporter.id) throw notFound();
  const [target] = await tx.select().from(users).where(eq(users.id, targetId));
  if (!target || target.status === ACCOUNT_STATUS.deactivated) throw notFound();
  // A user is reportable after a visible interaction: a published listing in
  // the reporter's market, or a shared order.
  const [publicListing] = await tx
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.sellerId, target.id),
        eq(offers.marketId, reporter.activeMarketId),
        eq(offers.status, "PUBLISHED"),
      ),
    )
    .limit(1);
  if (publicListing) return reporter.activeMarketId;
  const [sharedOrder] = await tx
    .select({ marketId: orders.marketId })
    .from(orders)
    .where(
      or(
        and(eq(orders.buyerId, reporter.id), eq(orders.sellerId, target.id)),
        and(eq(orders.sellerId, reporter.id), eq(orders.buyerId, target.id)),
      ),
    )
    .limit(1);
  if (sharedOrder) return sharedOrder.marketId;
  throw notFound();
}

function reportView(row: typeof marketplaceReports.$inferSelect) {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    reasonCode: row.reasonCode,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    // An AI-answer report keeps ids and the reporter's own note only; the answer text is not copied.
    ...(row.targetType === "AI_ANSWER" ? { retention: "IDS_AND_USER_NOTE_ONLY" as const } : {}),
  };
}

router.post("/reports", requireAuth, async (req, res) => {
  // Reporter identity is the authenticated session; strict parsing rejects
  // any reporterId supplied in the body.
  const body = CreateReportBody.parse(req.body);
  if (body.targetType === "AI_ANSWER" && (body.note?.length ?? 0) > 500)
    throw fail(400, "ملاحظة بلاغ إجابة الذكاء الاصطناعي لا تتجاوز 500 حرف");
  const result = await db.transaction(async (tx) => {
    const [reporter] = await tx
      .select()
      .from(users)
      .where(eq(users.id, req.actor!.id))
      .for("update");
    if (!reporter) throw fail(401, "سجّل الدخول للمتابعة");
    const [reason] = await tx
      .select()
      .from(moderationReasonCodes)
      .where(
        and(
          eq(moderationReasonCodes.code, body.reasonCode),
          eq(moderationReasonCodes.isActive, true),
        ),
      );
    if (!reason || !reason.targetTypes.includes(body.targetType))
      throw fail(400, "سبب البلاغ غير صالح لهذا النوع");
    const marketId = await reportableTargetMarket(
      tx,
      reporter,
      body.targetType,
      body.targetId,
    );
    const [existing] = await tx
      .select()
      .from(marketplaceReports)
      .where(
        and(
          eq(marketplaceReports.reporterId, reporter.id),
          eq(marketplaceReports.targetType, body.targetType),
          eq(marketplaceReports.targetId, body.targetId),
          eq(marketplaceReports.status, "OPEN"),
        ),
      );
    if (existing) return { duplicate: true as const, row: existing };
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(marketplaceReports)
      .where(
        and(
          eq(marketplaceReports.reporterId, reporter.id),
          gte(marketplaceReports.createdAt, sql`now() - interval '24 hours'`),
        ),
      );
    if (count >= REPORTS_PER_DAY_LIMIT)
      throw fail(429, "وصلت إلى الحد اليومي للبلاغات. حاول لاحقًا.");
    const [row] = await tx
      .insert(marketplaceReports)
      .values({
        id: randomUUID(),
        reporterId: reporter.id,
        marketId,
        targetType: body.targetType,
        targetId: body.targetId,
        reasonCode: reason.code,
        note: body.note?.trim() ?? "",
      })
      .returning();
    return { duplicate: false as const, row };
  });
  res
    .status(result.duplicate ? 200 : 201)
    .json({ report: reportView(result.row), duplicate: result.duplicate });
});

router.get("/reports/mine", requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(marketplaceReports)
    .where(eq(marketplaceReports.reporterId, req.actor!.id))
    .orderBy(desc(marketplaceReports.createdAt))
    .limit(100);
  res.json(rows.map(reportView));
});

// --------------------------------------------------------- account deletion

const deletionLimit = createAuthRateLimitMiddleware((req) =>
  req.actor ? { scope: "account-deletion-user", value: req.actor.id } : undefined,
);

router.post("/account/deletion", requireAuth, deletionLimit, async (req, res) => {
  const body = z
    .object({ currentPassword: z.string().max(128), confirm: z.literal(true) })
    .strict()
    .parse(req.body);
  if (req.actor!.role === "ADMIN")
    throw fail(409, "حسابات الإدارة تُغلق من خلال فريق التشغيل");
  if (!(await verifyPassword(body.currentPassword, req.actor!.passwordHash)))
    throw fail(400, "كلمة المرور الحالية غير صحيحة");
  const { previousAvatarObjectPath } = await db.transaction(async (tx) => {
    const outcome = await deactivateOwnAccount(tx, req.actor!.id);
    // Tracked like every privacy right; required records are kept per DATA_RETENTION_POLICY.
    await recordPrivacyRequest(
      {
        userId: req.actor!.id,
        kind: "DELETION",
        channel: "API",
        idempotencyKey: `deletion:${req.actor!.id}`,
        completed: { outcomeCode: "ACCOUNT_DEACTIVATED_RECORDS_RETAINED", outcomeNote: "أُغلق الحساب وأُخفيت بياناته الشخصية؛ بقيت سجلات الطلبات والمحاسبة والنزاعات المطلوبة وفق سياسة الاحتفاظ." },
      },
      tx,
    );
    return outcome;
  });
  if (previousAvatarObjectPath) {
    try {
      const file = await new ObjectStorageService().getObjectEntityFile(
        previousAvatarObjectPath,
      );
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      logger.warn({ err: error }, "Deleted account avatar could not be removed");
    }
  }
  res.clearCookie("bdinar_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  res.json({ ok: true, status: ACCOUNT_STATUS.deactivated });
});

// ------------------------------------------------------------------- admin

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};
router.use("/admin", requireAuth, requireAdmin);

async function targetContext(tx: any, targetType: string, targetId: string) {
  if (targetType === "LISTING") {
    const [row] = await tx
      .select({ offer: offers, seller: users })
      .from(offers)
      .innerJoin(users, eq(users.id, offers.sellerId))
      .where(eq(offers.id, targetId));
    if (!row) return null;
    return {
      kind: "LISTING",
      id: row.offer.id,
      title: row.offer.data.title ?? "",
      status: row.offer.status,
      marketId: row.offer.marketId,
      imageUrl: row.offer.data.imageUrl ?? null,
      sellerId: row.seller.id,
      sellerName: row.seller.displayName,
      sellerStatus: row.seller.status,
      createdAt: row.offer.createdAt.toISOString(),
    };
  }
  if (targetType === "ORDER") {
    const [order] = await tx.select().from(orders).where(eq(orders.id, targetId));
    if (!order) return null;
    return {
      kind: "ORDER",
      id: order.id,
      status: order.status,
      marketId: order.marketId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      buyerName: order.data.buyerName ?? "",
      sellerName: order.data.sellerName ?? "",
      title: order.data.listingTitle ?? "",
      subtotalMinor: order.subtotalMinor,
      currency: order.currencyCode,
      minorUnitScale: order.minorUnitScale,
      createdAt: order.createdAt.toISOString(),
    };
  }
  if (targetType === "MESSAGE") {
    const [row] = await tx
      .select({ message: messages, conversation: conversations, sender: users })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(eq(messages.id, targetId));
    if (!row) return null;
    return {
      kind: "MESSAGE",
      id: row.message.id,
      body: row.message.body,
      conversationId: row.message.conversationId,
      orderId: row.conversation.orderId,
      senderId: row.message.senderId,
      senderName: row.sender?.displayName ?? null,
      createdAt: row.message.createdAt.toISOString(),
    };
  }
  if (targetType === "AI_ANSWER") {
    const [row] = await tx
      .select({ message: messages, conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, targetId));
    if (!row) return null;
    // Minimal retention: the generated answer text is not shown to the review queue.
    return {
      kind: "AI_ANSWER",
      id: row.message.id,
      conversationId: row.message.conversationId,
      marketId: row.conversation.marketId,
      senderId: row.message.senderId,
      createdAt: row.message.createdAt.toISOString(),
      contentRetained: false,
    };
  }
  const [user] = await tx.select().from(users).where(eq(users.id, targetId));
  if (!user) return null;
  const [counts] = await tx
    .select({
      listings: sql<number>`(select count(*)::int from offers where seller_id = ${user.id} and status = 'PUBLISHED')`,
      orders: sql<number>`(select count(*)::int from orders where buyer_id = ${user.id} or seller_id = ${user.id})`,
      openReports: sql<number>`(select count(*)::int from marketplace_reports where target_type = 'USER' and target_id = ${user.id} and status = 'OPEN')`,
    })
    .from(sql`(select 1) as one`);
  return {
    kind: "USER",
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    role: user.role,
    accountCountry: user.accountCountry,
    activeMarketId: user.activeMarketId,
    createdAt: user.createdAt.toISOString(),
    publishedListings: counts.listings,
    orders: counts.orders,
    openReports: counts.openReports,
  };
}

router.get("/admin/reports", async (req, res) => {
  const status = String(req.query.status ?? "OPEN");
  if (!["OPEN", "DISMISSED", "ACTIONED", "ALL"].includes(status))
    throw fail(400, "حالة البلاغ غير صالحة");
  const rows = await db
    .select({ report: marketplaceReports, reporterName: users.displayName })
    .from(marketplaceReports)
    .innerJoin(users, eq(users.id, marketplaceReports.reporterId))
    .where(status === "ALL" ? undefined : eq(marketplaceReports.status, status))
    // The open queue is worked oldest first; history reads newest first.
    .orderBy(status === "OPEN" ? asc(marketplaceReports.createdAt) : desc(marketplaceReports.createdAt))
    .limit(200);
  const targetHours = responseTargetHours("DINAR_REPORT_RESPONSE_HOURS");
  const reasons = await db.select().from(moderationReasonCodes);
  const reasonLabel = new Map(reasons.map((row) => [row.code, row.labelAr]));
  res.json(
    await Promise.all(
      rows.map(async ({ report, reporterName }) => ({
        ...reportView(report),
        marketId: report.marketId,
        reasonLabel: reasonLabel.get(report.reasonCode) ?? report.reasonCode,
        reporterId: report.reporterId,
        reporterName,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        resolvedBy: report.resolvedBy,
        resolutionNote: report.resolutionNote,
        ...responseTiming(report.createdAt, report.status === "OPEN", targetHours),
        target: await targetContext(db, report.targetType, report.targetId),
      })),
    ),
  );
});

const ResolveReportBody = z
  .object({
    decision: z.enum(["DISMISS", "ACTION"]),
    action: z
      .enum(["HIDE_LISTING", "REMOVE_LISTING", "RESTRICT_USER", "SUSPEND_USER", "FLAG_AI_ANSWER"])
      .optional(),
    subjectUserId: z.string().max(100).optional(),
    reason: reasonText,
  })
  .strict();

router.post("/admin/reports/:id/resolve", async (req, res) => {
  const body = ResolveReportBody.parse(req.body);
  const actor = { id: req.actor!.id, role: req.actor!.role };
  const report = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(marketplaceReports)
      .where(eq(marketplaceReports.id, String(req.params.id)))
      .for("update");
    if (!row) throw fail(404, "البلاغ غير موجود");
    if (row.status !== "OPEN") throw fail(409, "تمت معالجة البلاغ بالفعل");
    if (body.decision === "ACTION") {
      if (!body.action) throw fail(400, "اختر الإجراء المطلوب");
      if (body.action === "FLAG_AI_ANSWER") {
        // A generated answer is reviewed by a human and flagged; no account, listing or payment
        // changes, and the answer text is not copied into the audit row.
        if (row.targetType !== "AI_ANSWER")
          throw fail(400, "هذا الإجراء يخص بلاغات إجابات الذكاء الاصطناعي فقط");
        await recordModerationAudit(tx, {
          actor,
          action: "AI_ANSWER_FLAGGED",
          targetType: "AI_ANSWER",
          targetId: row.targetId,
          reportId: row.id,
          reason: body.reason,
          after: { reportStatus: "ACTIONED" },
        });
      } else if (row.targetType === "AI_ANSWER") {
        throw fail(400, "قرار بلاغ إجابة الذكاء الاصطناعي لا يغيّر حسابًا أو إعلانًا");
      } else if (body.action === "HIDE_LISTING" || body.action === "REMOVE_LISTING") {
        if (row.targetType !== "LISTING")
          throw fail(400, "هذا الإجراء يخص بلاغات العروض فقط");
        await moderateListing(tx, {
          actor,
          listingId: row.targetId,
          action: body.action === "HIDE_LISTING" ? "HIDE" : "REMOVE",
          reason: body.reason,
          reportId: row.id,
        });
      } else {
        let subject: string;
        if (row.targetType === "USER") subject = row.targetId;
        else if (row.targetType === "LISTING") {
          const [offer] = await tx
            .select({ sellerId: offers.sellerId })
            .from(offers)
            .where(eq(offers.id, row.targetId));
          if (!offer) throw fail(404, "العرض غير موجود");
          subject = offer.sellerId;
        } else if (row.targetType === "MESSAGE") {
          const [message] = await tx
            .select({ senderId: messages.senderId })
            .from(messages)
            .where(eq(messages.id, row.targetId));
          if (!message?.senderId) throw fail(404, "الرسالة غير موجودة");
          subject = message.senderId;
        } else {
          const [order] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, row.targetId));
          if (
            !order ||
            !body.subjectUserId ||
            ![order.buyerId, order.sellerId].includes(body.subjectUserId)
          )
            throw fail(400, "حدد طرفًا من أطراف الطلب");
          subject = body.subjectUserId;
        }
        await setUserModerationStatus(tx, {
          actor,
          userId: subject,
          status: body.action === "RESTRICT_USER" ? "RESTRICTED" : "SUSPENDED",
          reason: body.reason,
          reportId: row.id,
        });
      }
    }
    const now = new Date();
    const status = body.decision === "DISMISS" ? "DISMISSED" : "ACTIONED";
    const [updated] = await tx
      .update(marketplaceReports)
      .set({
        status,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNote: body.reason,
        updatedAt: now,
      })
      .where(eq(marketplaceReports.id, row.id))
      .returning();
    await recordModerationAudit(tx, {
      actor,
      action: `REPORT_${status}`,
      targetType: "REPORT",
      targetId: row.id,
      reportId: row.id,
      reason: body.reason,
      before: { status: row.status },
      after: { status, action: body.action ?? null },
    });
    return updated;
  });
  notifyUserAfterDecision({ recipientId: report.reporterId, templateKey: "REPORT_RESOLVED", data: { reportId: report.id, status: report.status } });
  res.json({ ...reportView(report), resolvedAt: report.resolvedAt?.toISOString() });
});

router.post("/admin/listings/:id/moderation", async (req, res) => {
  const body = z
    .object({ action: z.enum(["HIDE", "RESTORE", "REMOVE"]), reason: reasonText })
    .strict()
    .parse(req.body);
  const updated = await db.transaction((tx) =>
    moderateListing(tx, {
      actor: { id: req.actor!.id, role: req.actor!.role },
      listingId: String(req.params.id),
      action: body.action,
      reason: body.reason,
    }),
  );
  res.json({ id: updated.id, status: updated.status });
});

router.post("/admin/jobs/:id/moderation", async (req, res) => {
  const body = z.object({ action: z.enum(["HIDE", "RESTORE"]), reason: reasonText }).strict().parse(req.body);
  const updated = await db.transaction((tx) =>
    moderateEmploymentResource(tx, {
      actor: { id: req.actor!.id, role: req.actor!.role },
      targetType: "JOB",
      targetId: String(req.params.id),
      action: body.action,
      reason: body.reason,
    }),
  );
  res.json({ id: updated.id, status: updated.status });
});

router.post("/admin/candidate-profiles/:id/moderation", async (req, res) => {
  const body = z.object({ action: z.enum(["HIDE", "RESTORE"]), reason: reasonText }).strict().parse(req.body);
  const updated = await db.transaction((tx) =>
    moderateEmploymentResource(tx, {
      actor: { id: req.actor!.id, role: req.actor!.role },
      targetType: "CANDIDATE_PROFILE",
      targetId: String(req.params.id),
      action: body.action,
      reason: body.reason,
    }),
  );
  res.json({ id: updated.id, visibility: updated.visibility });
});

router.get("/admin/users", async (req, res) => {
  const search = String(req.query.search ?? "").trim().slice(0, 80);
  const status = String(req.query.status ?? "");
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        search
          ? or(eq(users.id, search), ilike(users.displayName, `%${search.replace(/[%_\\]/g, "\\$&")}%`))
          : undefined,
        ["ACTIVE", "RESTRICTED", "SUSPENDED", "DEACTIVATED"].includes(status)
          ? eq(users.status, status)
          : undefined,
      ),
    )
    .orderBy(desc(users.createdAt))
    .limit(50);
  res.json(
    rows.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      status: user.status,
      role: user.role,
      activeMarketId: user.activeMarketId,
      createdAt: user.createdAt.toISOString(),
    })),
  );
});

router.get("/admin/users/:id", async (req, res) => {
  const context = await targetContext(db, "USER", String(req.params.id));
  if (!context) throw fail(404, "الحساب غير موجود");
  res.json(context);
});

router.post("/admin/users/:id/status", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["ACTIVE", "RESTRICTED", "SUSPENDED"]),
      reason: reasonText,
    })
    .strict()
    .parse(req.body);
  const updated = await db.transaction((tx) =>
    setUserModerationStatus(tx, {
      actor: { id: req.actor!.id, role: req.actor!.role },
      userId: String(req.params.id),
      status: body.status,
      reason: body.reason,
    }),
  );
  res.json({ id: updated.id, status: updated.status });
});

router.get("/admin/moderation-audit", async (req, res) => {
  const targetType = String(req.query.targetType ?? "");
  const targetId = String(req.query.targetId ?? "");
  const rows = await db
    .select({ entry: moderationAudit, actorName: users.displayName })
    .from(moderationAudit)
    .innerJoin(users, eq(users.id, moderationAudit.actorId))
    .where(
      and(
        targetType ? eq(moderationAudit.targetType, targetType) : undefined,
        targetId ? eq(moderationAudit.targetId, targetId) : undefined,
      ),
    )
    .orderBy(desc(moderationAudit.createdAt))
    .limit(200);
  res.json(
    rows.map(({ entry, actorName }) => ({
      ...entry,
      actorName,
      createdAt: entry.createdAt.toISOString(),
    })),
  );
});

// ------------------------------------------------- admin policy configuration

router.get("/admin/policy-rules", async (_req, res) => {
  res.json(
    await db
      .select()
      .from(marketplacePolicyRules)
      .orderBy(desc(marketplacePolicyRules.createdAt)),
  );
});

router.post("/admin/policy-rules", async (req, res) => {
  const body = z
    .object({
      marketId: z.string().max(10).nullable().optional(),
      kind: z.enum(["CATEGORY", "RESOURCE_TYPE", "FULFILMENT", "TERM"]),
      value: z.string().trim().min(1).max(120),
      reasonCode: z.string().max(42).default("PROHIBITED_ITEM"),
      note: z.string().max(500).optional(),
    })
    .strict()
    .parse(req.body);
  if (body.marketId) {
    const [market] = await db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, body.marketId));
    if (!market) throw fail(400, "السوق غير موجود");
  }
  const [reason] = await db
    .select()
    .from(moderationReasonCodes)
    .where(eq(moderationReasonCodes.code, body.reasonCode));
  if (!reason) throw fail(400, "سبب السياسة غير صالح");
  const actor = { id: req.actor!.id, role: req.actor!.role };
  const rule = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(marketplacePolicyRules)
      .values({
        id: randomUUID(),
        marketId: body.marketId ?? null,
        kind: body.kind,
        value: body.value,
        reasonCode: body.reasonCode,
        note: body.note ?? "",
        createdBy: actor.id,
        updatedBy: actor.id,
      })
      .returning();
    await recordModerationAudit(tx, {
      actor,
      action: "POLICY_RULE_CREATED",
      targetType: "POLICY_RULE",
      targetId: created.id,
      reason: body.note ?? "",
      after: { marketId: created.marketId, kind: created.kind, value: created.value, isActive: true },
    });
    return created;
  });
  res.status(201).json(rule);
});

router.patch("/admin/policy-rules/:id", async (req, res) => {
  const body = z
    .object({ isActive: z.boolean(), reason: reasonText })
    .strict()
    .parse(req.body);
  const actor = { id: req.actor!.id, role: req.actor!.role };
  const rule = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(marketplacePolicyRules)
      .where(eq(marketplacePolicyRules.id, String(req.params.id)))
      .for("update");
    if (!row) throw fail(404, "القاعدة غير موجودة");
    const [updated] = await tx
      .update(marketplacePolicyRules)
      .set({ isActive: body.isActive, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(marketplacePolicyRules.id, row.id))
      .returning();
    await recordModerationAudit(tx, {
      actor,
      action: body.isActive ? "POLICY_RULE_ENABLED" : "POLICY_RULE_DISABLED",
      targetType: "POLICY_RULE",
      targetId: row.id,
      reason: body.reason,
      before: { isActive: row.isActive },
      after: { isActive: body.isActive },
    });
    return updated;
  });
  res.json(rule);
});

router.get("/admin/reason-codes", async (_req, res) => {
  res.json(
    await db
      .select()
      .from(moderationReasonCodes)
      .orderBy(moderationReasonCodes.sortOrder),
  );
});

router.patch("/admin/reason-codes/:code", async (req, res) => {
  const body = z
    .object({ isActive: z.boolean(), reason: reasonText })
    .strict()
    .parse(req.body);
  const actor = { id: req.actor!.id, role: req.actor!.role };
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(moderationReasonCodes)
      .where(eq(moderationReasonCodes.code, String(req.params.code)))
      .for("update");
    if (!row) throw fail(404, "السبب غير موجود");
    const [next] = await tx
      .update(moderationReasonCodes)
      .set({ isActive: body.isActive, updatedAt: new Date() })
      .where(eq(moderationReasonCodes.code, row.code))
      .returning();
    await recordModerationAudit(tx, {
      actor,
      action: body.isActive ? "REASON_CODE_ENABLED" : "REASON_CODE_DISABLED",
      targetType: "REASON_CODE",
      targetId: row.code,
      reason: body.reason,
      before: { isActive: row.isActive },
      after: { isActive: body.isActive },
    });
    return next;
  });
  res.json(updated);
});

router.get("/admin/policies", (_req, res) => {
  res.json({
    policies: currentPolicies().map(({ sections: _sections, ...summary }) => summary),
    retention: DATA_RETENTION_POLICY,
  });
});

export default router;
