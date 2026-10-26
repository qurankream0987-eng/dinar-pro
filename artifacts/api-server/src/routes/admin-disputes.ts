import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  GetAdminDisputesResponse,
  ResolveAdminDisputeBody,
  ResolveAdminDisputeResponse,
  type AdminDispute,
  type AdminDisputeResolutionResult,
} from "@workspace/api-zod";
import { db, disputes, messages, orders, users } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { applyTerminalOrderAccounting } from "../lib/order-terminal-accounting";
import { recordCourierCommissionAccrual } from "../lib/courier-economics";
import { recordOrderDisputeResolved } from "../lib/payments/disputes";

const router = Router();

router.use("/admin", requireAuth, (req, res, next) => {
  if (req.actor!.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
});

router.get("/admin/disputes", async (_req, res) => {
  const rows = await db
    .select({ dispute: disputes, order: orders })
    .from(disputes)
    .innerJoin(orders, eq(disputes.orderId, orders.id))
    .orderBy(desc(orders.createdAt))
    .limit(100);

  if (!rows.length) {
    res.json([]);
    return;
  }

  const orderIds = rows.map(({ order }) => order.id);
  const userIds = [
    ...new Set(
      rows.flatMap(({ order }) => [order.buyerId, order.sellerId]),
    ),
  ];
  const [people, auditMessages] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds)),
    db
      .select({
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, orderIds),
          eq(messages.contentType, "DISPUTE_RESOLUTION"),
          eq(messages.actor, "ADMIN"),
        ),
      )
      .orderBy(desc(messages.createdAt)),
  ]);

  const personById = new Map(people.map((person) => [person.id, person]));
  const auditByDisputeId = new Map<
    string,
    (typeof auditMessages)[number]
  >();
  for (const auditMessage of auditMessages) {
    const disputeId = auditMessage.metadata.disputeId;
    if (
      typeof disputeId === "string" &&
      !auditByDisputeId.has(disputeId)
    ) {
      auditByDisputeId.set(disputeId, auditMessage);
    }
  }

  const response: AdminDispute[] = rows.map(({ dispute, order }) => {
    const audit = auditByDisputeId.get(dispute.id);
    const resolverId = audit?.senderId ?? null;
    const resolver = resolverId ? personById.get(resolverId) : undefined;
    const resolutionNote =
      typeof audit?.metadata.resolutionNote === "string"
        ? audit.metadata.resolutionNote
        : null;
    const evidence = Array.isArray(dispute.evidence)
      ? dispute.evidence.map((entry) => {
          const item = entry as Record<string, unknown>;
          return {
            type: String(item.type ?? "TEXT"),
            reference: String(item.reference ?? ""),
            submittedBy: String(item.submittedBy ?? dispute.openedBy),
            createdAt: String(
              item.createdAt ?? dispute.createdAt.toISOString(),
            ),
          };
        })
      : [];

    return {
      id: dispute.id,
      orderId: order.id,
      status: dispute.status as AdminDispute["status"],
      reason: dispute.reason,
      description: dispute.description,
      evidence,
      orderStatus: order.status,
      buyerId: order.buyerId,
      buyerName: personById.get(order.buyerId)?.displayName ?? "مشتري",
      sellerId: order.sellerId,
      sellerName: personById.get(order.sellerId)?.displayName ?? "بائع",
      quantity: order.quantity,
      subtotalMinor: order.subtotalMinor,
      currencyCode: order.currencyCode,
      minorUnitScale: order.minorUnitScale,
      commissionRateBps:
        typeof order.data.commissionRateBps === "number"
          ? order.data.commissionRateBps
          : 1_000,
      platformFeeMinor: order.platformFeeMinor,
      sellerAmountMinor: order.sellerAmountMinor,
      createdAt: dispute.createdAt.toISOString(),
      resolution: dispute.resolution,
      resolutionNote,
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      resolvedBy: resolverId,
      resolvedByName: resolver?.displayName ?? null,
    };
  });

  res.json(GetAdminDisputesResponse.parse(response));
});

router.post("/admin/disputes/:orderId/resolve", async (req, res) => {
  const parsed = ResolveAdminDisputeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "بيانات حسم النزاع غير صالحة",
      issues: parsed.error.issues,
    });
    return;
  }

  const orderId = String(req.params.orderId);
  const resolution = parsed.data.resolution;
  const resolutionNote = parsed.data.note?.trim() || null;
  const adminId = req.actor!.id;

  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!order)
      return {
        ok: false as const,
        status: 404,
        message: "الطلب غير موجود",
      };
    if (order.status !== "DISPUTED")
      return {
        ok: false as const,
        status: 409,
        message: "لا يمكن حسم طلب غير متنازع عليه",
      };

    const [dispute] = await tx
      .select()
      .from(disputes)
      .where(eq(disputes.orderId, orderId))
      .for("update");
    if (!dispute)
      return {
        ok: false as const,
        status: 404,
        message: "لا يوجد نزاع مرتبط بهذا الطلب",
      };

    if (
      dispute.status !== "OPEN" ||
      dispute.resolvedAt
    ) {
      return {
        ok: false as const,
        status: 409,
        message: "لا يمكن حسم هذا النزاع إلا مرة واحدة وهو مفتوح",
      };
    }

    const now = new Date();
    const orderStatus =
      resolution === "SELLER" ? ("COMPLETED" as const) : ("CANCELLED" as const);
    if (orderStatus === "COMPLETED")
      await recordCourierCommissionAccrual(tx, order, now);
    const sellerDueCreated = await applyTerminalOrderAccounting(
      tx,
      order,
      orderStatus,
      now,
    );
    await recordOrderDisputeResolved(tx, order, dispute, resolution);
    await tx
      .update(orders)
      .set({ status: orderStatus, updatedAt: now })
      .where(eq(orders.id, orderId));
    await tx
      .update(disputes)
      .set({
        status: "RESOLVED",
        resolution,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(disputes.id, dispute.id));

    const summary =
      resolution === "SELLER"
        ? "حسمت الإدارة النزاع لصالح البائع وأُكمل الطلب وفق القيم المحفوظة. لم يحدث تحصيل أو تحويل أموال."
        : "حسمت الإدارة النزاع لصالح المشتري وأُلغي الطلب وأُعيد المخزون. لم يحدث رد أو تحويل أموال.";
    await tx.insert(messages).values({
      id: randomUUID(),
      conversationId: order.id,
      senderId: adminId,
      actor: "ADMIN",
      contentType: "DISPUTE_RESOLUTION",
      metadata: {
        disputeId: dispute.id,
        resolution,
        resolutionNote,
        resolvedAt: now.toISOString(),
      },
      body: resolutionNote ? `${summary}\nملاحظة الإدارة: ${resolutionNote}` : summary,
    });

    const response: AdminDisputeResolutionResult = {
      orderId,
      disputeStatus: "RESOLVED",
      orderStatus,
      resolution,
      resolutionNote,
      resolvedAt: now.toISOString(),
      resolvedBy: adminId,
      commissionRateBps:
        typeof order.data.commissionRateBps === "number"
          ? order.data.commissionRateBps
          : 1_000,
      platformFeeMinor: order.platformFeeMinor,
      sellerAmountMinor: order.sellerAmountMinor,
      sellerDueCreated,
    };
    return { ok: true as const, response };
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.message });
    return;
  }
  res.json(ResolveAdminDisputeResponse.parse(result.response));
});

export default router;