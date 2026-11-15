/**
 * Deal closure for direct (phase-one) payments: the money moves between the parties in cash or by
 * transfer; the order, the reservation and the closure stay inside Jassim, which never holds money.
 *
 * Owner-approved design (2026-11-07, «نعم اضفه») with the owner's answers of 2026-11-15:
 *  - Buyer-only 4-digit handover code; the seller enters it and the deal closes at once. Five wrong
 *    entries lock the code; it stays valid until the order closes. QR fallback: the seller shows a
 *    QR that opens the buyer's own order page, where the signed-in buyer confirms receipt.
 *  - One-tap confirmation: the buyer's «استلمت» alone closes the deal, from acceptance onwards.
 *  - «تم البيع بدون رمز»: the buyer is asked; confirm → close, dispute → review, 48 h of silence →
 *    close marked «دون رمز».
 *  - One reminder 24 h after acceptance, in the order chat, to both parties.
 *  - «لم يتم / أُلغي»: one side → review (a dispute); both sides → cancel, stock released, no commission.
 *  - Commission follows the existing terminal accounting: recorded on completion, never on
 *    cancellation, pending while disputed; the price/fee snapshot never changes.
 * Fixed rules: the buyer's word never marks money paid; the model cannot close a deal; every step is
 * checked on the server under the order row lock, replays are harmless, and each step is audited.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  deliveryProgressEvents,
  disputes,
  messages,
  orderClosureEvents,
  orderHandoverCodes,
  orders,
  paymentIntents,
  type OrderClosureEventType,
} from "@workspace/db";
import { applyTerminalOrderAccounting } from "./order-terminal-accounting";
import { recordCourierCommissionAccrual } from "./courier-economics";
import { EXECUTABLE_ORDER, recordOrderHandoff } from "./delivery";
import { recordOrderDisputeOpened, recordOrderDisputeResolved } from "./payments/disputes";

export const HANDOVER_CODE_MAX_ATTEMPTS = 5;
export const BUYER_WINDOW_MS = 48 * 60 * 60 * 1000;
export const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;

type OrderRow = typeof orders.$inferSelect;
type Role = "BUYER" | "SELLER";

const fail = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

function roleOf(order: OrderRow, actorId: string): Role {
  if (order.buyerId === actorId) return "BUYER";
  if (order.sellerId === actorId) return "SELLER";
  throw fail(404, "الطلب غير موجود");
}

/** The code is derived, never stored: HMAC(server key, order id, random nonce) → 4 digits. */
export function deriveHandoverCode(orderId: string, nonce: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Handover-code signing key is unavailable");
  const digest = createHmac("sha256", secret).update(`handover\0${orderId}\0${nonce}`).digest();
  return String(digest.readUInt32BE(0) % 10_000).padStart(4, "0");
}

async function audit(tx: any, order: OrderRow, type: OrderClosureEventType, actor: { id: string; role: Role } | null) {
  await tx.insert(orderClosureEvents).values({
    id: randomUUID(),
    orderId: order.id,
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? "SYSTEM",
    type,
  });
}

async function systemMessage(tx: any, orderId: string, body: string) {
  await tx.insert(messages).values({ id: randomUUID(), conversationId: orderId, body });
}

async function codeRow(tx: any, order: OrderRow, lock: boolean) {
  let q = tx.select().from(orderHandoverCodes).where(eq(orderHandoverCodes.orderId, order.id));
  if (lock) q = q.for("update");
  const [row] = await q;
  return row as typeof orderHandoverCodes.$inferSelect | undefined;
}

/** Issued when the seller accepts (and lazily for orders accepted before this feature). */
export async function ensureHandoverCode(tx: any, order: OrderRow) {
  const existing = await codeRow(tx, order, false);
  if (existing) return existing;
  const [created] = await tx
    .insert(orderHandoverCodes)
    .values({ orderId: order.id, nonce: randomBytes(32).toString("hex") })
    .onConflictDoNothing()
    .returning();
  if (!created) return (await codeRow(tx, order, false))!;
  await audit(tx, order, "CODE_ISSUED", null);
  return created;
}

/** States in which the deal can still be closed by the parties. */
const OPEN_FOR_CLOSURE = [...EXECUTABLE_ORDER, "SELLER_MARKED_DELIVERED"];

export type ClosureView = {
  role: Role;
  /** Only ever present for the buyer. */
  handoverCode: string | null;
  codeLocked: boolean;
  attemptsRemaining: number | null;
  soldWithoutCode: boolean;
  buyerWindowEndsAt: string | null;
  closedWithoutCode: boolean;
  reminderSentAt: string | null;
  notCompleted: { buyer: string | null; seller: string | null };
  canEnterCode: boolean;
  canSellWithoutCode: boolean;
  canConfirmReceipt: boolean;
  canReportNotCompleted: boolean;
};

export async function closureView(tx: any, order: OrderRow, actorId: string): Promise<ClosureView> {
  const role = roleOf(order, actorId);
  const closure = (order.data?.closure ?? {}) as Record<string, any>;
  const open = OPEN_FOR_CLOSURE.includes(order.status);
  const executable = EXECUTABLE_ORDER.includes(order.status);
  let code = open ? await codeRow(tx, order, false) : undefined;
  if (!code && open && role === "BUYER") code = await ensureHandoverCode(tx, order);
  const locked = Boolean(code?.lockedAt);
  return {
    role,
    handoverCode: role === "BUYER" && open && code && !code.consumedAt && !locked ? deriveHandoverCode(order.id, code.nonce) : null,
    codeLocked: locked,
    attemptsRemaining: role === "SELLER" && code ? Math.max(0, HANDOVER_CODE_MAX_ATTEMPTS - code.failedAttempts) : null,
    soldWithoutCode: closure.method === "WITHOUT_CODE",
    buyerWindowEndsAt: closure.buyerWindowEndsAt ?? null,
    closedWithoutCode: closure.closedWithoutCode === true,
    reminderSentAt: closure.reminderSentAt ?? null,
    notCompleted: { buyer: closure.notCompleted?.BUYER ?? null, seller: closure.notCompleted?.SELLER ?? null },
    canEnterCode: role === "SELLER" && open && !locked,
    canSellWithoutCode: role === "SELLER" && executable,
    canConfirmReceipt: role === "BUYER" && open,
    canReportNotCompleted: (executable || (order.status === "DISPUTED" && Boolean(closure.notCompleted))) && !closure.notCompleted?.[role],
  };
}

/** Completes the order through the canonical terminal accounting (commission, stock, journal). */
async function complete(tx: any, order: OrderRow, data: Record<string, any>, body: string, now: Date) {
  await recordCourierCommissionAccrual(tx, order, now);
  await applyTerminalOrderAccounting(tx, order, "COMPLETED", now);
  const [updated] = await tx
    .update(orders)
    .set({ status: "COMPLETED", data, updatedAt: now })
    .where(eq(orders.id, order.id))
    .returning();
  await systemMessage(tx, order.id, body);
  return updated as OrderRow;
}

async function buyerReceived(tx: any, order: OrderRow, actorId: string) {
  await tx
    .insert(deliveryProgressEvents)
    .values({ id: randomUUID(), orderId: order.id, marketId: order.marketId, assignmentId: null, actorId, type: "BUYER_RECEIVED" })
    .onConflictDoNothing();
}

export type CodeOutcome =
  | { outcome: "ACCEPTED" | "ALREADY_CLOSED"; order: OrderRow }
  | { outcome: "REJECTED"; attemptsRemaining: number }
  | { outcome: "LOCKED" };

/**
 * Seller enters the buyer's code. A wrong entry is counted and committed (the caller must not roll
 * it back), so the limit cannot be bypassed by retrying. The caller holds the order row lock.
 */
export async function enterHandoverCode(tx: any, order: OrderRow, actorId: string, entered: string, now: Date): Promise<CodeOutcome> {
  if (roleOf(order, actorId) !== "SELLER") throw fail(403, "يُدخل البائع رمز التسليم الذي يعطيه له المشتري");
  if (!/^\d{4}$/.test(entered)) throw fail(400, "رمز التسليم أربعة أرقام");
  const code = await codeRow(tx, order, true);
  if (order.status === "COMPLETED" && code?.consumedAt) return { outcome: "ALREADY_CLOSED", order };
  if (!OPEN_FOR_CLOSURE.includes(order.status)) throw fail(409, "لا يمكن إغلاق الطلب برمز في حالته الحالية");
  if (!code) throw fail(409, "لم يُصدر رمز تسليم لهذا الطلب بعد");
  if (code.lockedAt) return { outcome: "LOCKED" };
  const expected = Buffer.from(deriveHandoverCode(order.id, code.nonce));
  const actual = Buffer.from(entered);
  if (!timingSafeEqual(expected, actual)) {
    const attempts = code.failedAttempts + 1;
    const locked = attempts >= HANDOVER_CODE_MAX_ATTEMPTS;
    await tx
      .update(orderHandoverCodes)
      .set({ failedAttempts: attempts, lockedAt: locked ? now : null, updatedAt: now })
      .where(eq(orderHandoverCodes.orderId, order.id));
    await audit(tx, order, locked ? "CODE_LOCKED" : "CODE_REJECTED", { id: actorId, role: "SELLER" });
    if (locked) {
      await systemMessage(tx, order.id, "قُفل رمز التسليم بعد خمس محاولات خاطئة. يستطيع البائع اختيار «تم البيع بدون رمز» ليُسأل المشتري، أو يؤكد المشتري الاستلام بنفسه.");
      return { outcome: "LOCKED" };
    }
    return { outcome: "REJECTED", attemptsRemaining: HANDOVER_CODE_MAX_ATTEMPTS - attempts };
  }
  await tx.update(orderHandoverCodes).set({ consumedAt: now, updatedAt: now }).where(eq(orderHandoverCodes.orderId, order.id));
  if (order.status !== "SELLER_MARKED_DELIVERED") await recordOrderHandoff(tx, order, actorId, now);
  await buyerReceived(tx, order, order.buyerId);
  await audit(tx, order, "CODE_ACCEPTED", { id: actorId, role: "SELLER" });
  const data = { ...order.data, closure: { ...(order.data?.closure ?? {}), method: "CODE", closedAt: now.toISOString() } };
  return { outcome: "ACCEPTED", order: await complete(tx, order, data, "أُغلقت الصفقة برمز التسليم الصحيح من المشتري.", now) };
}

/** Seller: «تم البيع بدون رمز». The buyer is asked; 48 h of silence closes the deal «دون رمز». */
export async function sellWithoutCode(tx: any, order: OrderRow, actorId: string, now: Date) {
  if (roleOf(order, actorId) !== "SELLER") throw fail(403, "هذا الإجراء للبائع");
  if (order.status === "SELLER_MARKED_DELIVERED" && order.data?.closure?.method === "WITHOUT_CODE") return order;
  if (!EXECUTABLE_ORDER.includes(order.status)) throw fail(409, "لا يمكن تسجيل البيع في حالة الطلب الحالية");
  await recordOrderHandoff(tx, order, actorId, now);
  const buyerWindowEndsAt = new Date(now.getTime() + BUYER_WINDOW_MS).toISOString();
  const data = {
    ...order.data,
    deliveryProof: "WITHOUT_CODE: تم البيع بدون رمز",
    closure: { ...(order.data?.closure ?? {}), method: "WITHOUT_CODE", soldWithoutCodeAt: now.toISOString(), buyerWindowEndsAt },
  };
  const [updated] = await tx
    .update(orders)
    .set({ status: "SELLER_MARKED_DELIVERED", data, updatedAt: now })
    .where(eq(orders.id, order.id))
    .returning();
  await audit(tx, order, "SOLD_WITHOUT_CODE", { id: actorId, role: "SELLER" });
  await systemMessage(tx, order.id, "يقول البائع إنك استلمت المنتج ودفعت. هل هذا صحيح؟ أكّد الاستلام أو افتح مشكلة خلال 48 ساعة؛ بعدها تُغلق الصفقة تلقائيًا دون رمز.");
  return updated as OrderRow;
}

/** Buyer confirmation event, called by the existing confirm route after its own checks. */
export async function recordBuyerConfirmation(tx: any, order: OrderRow, actorId: string) {
  await audit(tx, order, "BUYER_CONFIRMED", { id: actorId, role: "BUYER" });
}

/** «لم يتم» / «أُلغي»: one side opens a review; the other side agreeing cancels without commission. */
export async function reportNotCompleted(
  tx: any,
  order: OrderRow,
  actorId: string,
  outcome: "NOT_COMPLETED" | "CANCELLED",
  now: Date,
): Promise<OrderRow> {
  const role = roleOf(order, actorId);
  const closure = { ...(order.data?.closure ?? {}) } as Record<string, any>;
  const claims = { ...(closure.notCompleted ?? {}) } as Record<Role, string | undefined>;
  if (claims[role]) return order;
  const other: Role = role === "BUYER" ? "SELLER" : "BUYER";
  const label = outcome === "CANCELLED" ? "أُلغيت الصفقة" : "لم تتم الصفقة";

  if (claims[other] && order.status === "DISPUTED") {
    const [dispute] = await tx.select().from(disputes).where(eq(disputes.orderId, order.id)).for("update");
    // A payment captured for this order is never released by the parties alone (refund first).
    const [paid] = await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(and(eq(paymentIntents.orderId, order.id), sql`${paymentIntents.capturedAmountMinor} > ${paymentIntents.refundedAmountMinor}`));
    claims[role] = outcome;
    const data = { ...order.data, closure: { ...closure, notCompleted: claims } };
    await audit(tx, order, "NOT_COMPLETED_CLAIMED", { id: actorId, role });
    if (paid || !dispute || dispute.status !== "OPEN") {
      const [kept] = await tx.update(orders).set({ data, updatedAt: now }).where(eq(orders.id, order.id)).returning();
      await systemMessage(tx, order.id, "اتفق الطرفان على أن الصفقة لم تتم. توجد دفعة مسجلة، لذلك تبقى المراجعة مفتوحة حتى الاسترداد.");
      return kept as OrderRow;
    }
    await applyTerminalOrderAccounting(tx, order, "CANCELLED", now);
    await recordOrderDisputeResolved(tx, order, dispute, "BUYER");
    await tx
      .update(disputes)
      .set({ status: "RESOLVED", resolution: "BUYER", resolvedAt: now, updatedAt: now })
      .where(eq(disputes.id, dispute.id));
    const [cancelled] = await tx
      .update(orders)
      .set({ status: "CANCELLED", data: { ...data, issue: label }, updatedAt: now })
      .where(eq(orders.id, order.id))
      .returning();
    await audit(tx, order, "MUTUAL_CANCELLED", null);
    await systemMessage(tx, order.id, "اتفق الطرفان على أن الصفقة لم تتم: أُلغي الطلب وأُعيد المخزون، ولا عمولة.");
    return cancelled as OrderRow;
  }

  const allowed = EXECUTABLE_ORDER.includes(order.status) || (role === "BUYER" && order.status === "SELLER_MARKED_DELIVERED");
  if (!allowed) throw fail(409, "لا يمكن تسجيل ذلك في حالة الطلب الحالية");
  claims[role] = outcome;
  const [dispute] = await tx
    .insert(disputes)
    .values({
      id: randomUUID(),
      orderId: order.id,
      openedBy: actorId,
      reason: label,
      description: `${role === "BUYER" ? "المشتري" : "البائع"} يقول: ${label}. بانتظار الطرف الآخر أو مراجعة الإدارة.`,
      evidence: [],
    })
    .onConflictDoNothing()
    .returning();
  if (!dispute) throw fail(409, "توجد مراجعة مفتوحة لهذا الطلب");
  await recordOrderDisputeOpened(tx, order, dispute);
  const [updated] = await tx
    .update(orders)
    .set({ status: "DISPUTED", data: { ...order.data, closure: { ...closure, notCompleted: claims } }, updatedAt: now })
    .where(eq(orders.id, order.id))
    .returning();
  await audit(tx, order, "NOT_COMPLETED_CLAIMED", { id: actorId, role });
  await systemMessage(
    tx,
    order.id,
    `${role === "BUYER" ? "المشتري" : "البائع"} يقول: ${label}. إن كنت توافق اضغط «${outcome === "CANCELLED" ? "أُلغي" : "لم يتم"}» فيُلغى الطلب دون عمولة؛ وإلا تراجع الإدارة الحالة.`,
  );
  return updated as OrderRow;
}

/** 48 h of buyer silence after «تم البيع بدون رمز» closes the deal, marked «دون رمز». */
export async function closeExpiredBuyerWindows(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "SELLER_MARKED_DELIVERED"),
        sql`${orders.data}->'closure'->>'method' = 'WITHOUT_CODE'`,
        sql`(${orders.data}->'closure'->>'buyerWindowEndsAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .limit(100);
  let closed = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order || order.status !== "SELLER_MARKED_DELIVERED" || order.data?.closure?.method !== "WITHOUT_CODE") return;
      if (new Date(order.data.closure.buyerWindowEndsAt).getTime() > now.getTime()) return;
      const data = { ...order.data, closure: { ...order.data.closure, closedWithoutCode: true, closedAt: now.toISOString() } };
      await audit(tx, order, "BUYER_WINDOW_CLOSED", null);
      await complete(tx, order, data, "مرت 48 ساعة دون رد من المشتري: أُغلقت الصفقة دون رمز.", now);
      closed += 1;
    });
  }
  return closed;
}

/** One reminder, 24 h after acceptance, while the deal is still open. */
export async function sendClosureReminders(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - REMINDER_AFTER_MS).toISOString();
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        sql`${orders.status} IN ('ACCEPTED', 'IN_PROGRESS')`,
        sql`(${orders.data}->>'acceptedAt')::timestamptz <= ${before}::timestamptz`,
        sql`${orders.data}->'closure'->>'reminderSentAt' IS NULL`,
      ),
    )
    .limit(100);
  let sent = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order || !EXECUTABLE_ORDER.includes(order.status) || order.data?.closure?.reminderSentAt) return;
      const data = { ...order.data, closure: { ...(order.data?.closure ?? {}), reminderSentAt: now.toISOString() } };
      await tx.update(orders).set({ data, updatedAt: now }).where(eq(orders.id, order.id));
      await audit(tx, order, "REMINDER_SENT", null);
      await systemMessage(tx, order.id, "هل تمت الصفقة؟ البائع: «تم البيع». المشتري: «استلمت». أو «لم يتم» / «أُلغي». لا تسلّم المنتج قبل استلام المبلغ ورمز التسليم معًا.");
      sent += 1;
    });
  }
  return sent;
}

