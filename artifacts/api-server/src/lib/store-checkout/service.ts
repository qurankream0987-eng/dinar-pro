import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  offers,
  orderItems,
  orders,
  storeCheckoutAdapters,
  storeCheckoutSessions,
  storeCheckoutWebhookEvents,
} from "@workspace/db";
import { CustomOpenApiStoreAdapter } from "./custom-openapi-adapter";
import { SimulatedStoreGatewayAdapter } from "./simulated-adapter";
import {
  isStoreCheckoutEnabled,
  type StoreCheckoutAdapter,
  type StoreCheckoutAdapterKind,
  type StoreCheckoutAdapterRecord,
} from "./types";

function toRecord(row: typeof storeCheckoutAdapters.$inferSelect): StoreCheckoutAdapterRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    marketId: row.marketId,
    adapterKind: row.adapterKind as StoreCheckoutAdapterKind,
    displayName: row.displayName,
    enabled: row.enabled,
    supportedCountries: row.supportedCountries ?? [],
    supportedCurrencies: row.supportedCurrencies ?? [],
    minAmountMinor: row.minAmountMinor,
    maxAmountMinor: row.maxAmountMinor,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

export function buildStoreCheckoutAdapter(record: StoreCheckoutAdapterRecord): StoreCheckoutAdapter {
  if (record.adapterKind === "SIMULATED_GATEWAY") {
    return new SimulatedStoreGatewayAdapter(record);
  }
  return new CustomOpenApiStoreAdapter(record);
}

export interface PaymentStatusCard {
  kind: "PAYMENT_STATUS";
  orderId: string;
  sessionId?: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED" | "MISMATCH_REVIEW";
  amountMinor: number;
  currencyCode: string;
  checkoutUrl?: string;
  adapterName?: string;
  paidAt?: string;
  note: string;
}

export function buildPaymentStatusCard(input: {
  orderId: string;
  sessionId?: string;
  status: PaymentStatusCard["status"];
  amountMinor: number;
  currencyCode: string;
  checkoutUrl?: string;
  adapterName?: string;
  paidAt?: Date | null;
}): PaymentStatusCard {
  const notes: Record<PaymentStatusCard["status"], string> = {
    PENDING: "بانتظار إتمام الدفع عبر بوابة المتجر الخارجية. لن يتأكد الدفع قبل وصول إشعار موثّق من البوابة.",
    PAID: "تم تأكيد الدفع بنجاح عبر إشعار موثّق من بوابة المتجر.",
    FAILED: "لم يكتمل الدفع لدى بوابة المتجر. يمكنك إعادة المحاولة أو اختيار وسيلة أخرى.",
    EXPIRED: "انتهت صلاحية جلسة الدفع.",
    CANCELLED: "تم إلغاء جلسة الدفع.",
    MISMATCH_REVIEW: "تم إيقاف تأكيد الدفع مؤقتًا للمراجعة بسبب عدم تطابق المبلغ أو العملة أو الطلب.",
  };
  return {
    kind: "PAYMENT_STATUS",
    orderId: input.orderId,
    sessionId: input.sessionId,
    status: input.status,
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    checkoutUrl: input.checkoutUrl,
    adapterName: input.adapterName,
    paidAt: input.paidAt ? input.paidAt.toISOString() : undefined,
    note: notes[input.status],
  };
}

async function resolveOrderBusinessId(orderId: string): Promise<string | null> {
  const [item] = await db
    .select({ businessProfileId: offers.businessProfileId })
    .from(orderItems)
    .innerJoin(offers, eq(orderItems.offerId, offers.id))
    .where(eq(orderItems.orderId, orderId))
    .limit(1);
  return item?.businessProfileId ?? null;
}

export async function createStoreCheckoutSession(input: {
  orderId: string;
  buyerId: string;
  adapterId: string;
  idempotencyKey: string;
  returnUrl?: string;
}): Promise<{
  created: boolean;
  session: typeof storeCheckoutSessions.$inferSelect;
  card: PaymentStatusCard;
}> {
  if (!isStoreCheckoutEnabled()) {
    throw Object.assign(new Error("بوابة دفع المتاجر معطلة حاليًا."), {
      status: 409,
      code: "STORE_CHECKOUT_DISABLED",
      expose: true,
    });
  }
  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order || order.buyerId !== input.buyerId) {
    throw Object.assign(new Error("الطلب غير موجود."), { status: 404, code: "ORDER_NOT_FOUND", expose: true });
  }
  if (order.status === "PAID" || order.status === "CANCELLED") {
    throw Object.assign(new Error("لا يمكن فتح جلسة دفع لهذا الطلب."), {
      status: 409,
      code: "ORDER_NOT_PAYABLE",
      expose: true,
    });
  }
  const businessId = await resolveOrderBusinessId(order.id);
  const [adapterRow] = await db
    .select()
    .from(storeCheckoutAdapters)
    .where(eq(storeCheckoutAdapters.id, input.adapterId))
    .limit(1);
  if (!adapterRow || !businessId || adapterRow.businessId !== businessId) {
    throw Object.assign(new Error("بوابة المتجر غير متاحة لهذا الطلب."), {
      status: 404,
      code: "ADAPTER_NOT_FOUND",
      expose: true,
    });
  }
  const record = toRecord(adapterRow);
  const adapter = buildStoreCheckoutAdapter(record);
  const shippingMinor = Number(
    (order.data as Record<string, unknown> | null)?.shippingPolicy &&
      typeof (order.data as any).shippingPolicy?.feeMinor === "number"
      ? (order.data as any).shippingPolicy.feeMinor
      : 0,
  );
  const totalMinor = order.subtotalMinor + shippingMinor;
  if (!adapter.supports({ country: order.countryCode, currency: order.currencyCode, amountMinor: totalMinor })) {
    throw Object.assign(new Error("بوابة المتجر لا تدعم هذه الدولة أو العملة أو المبلغ."), {
      status: 409,
      code: "ADAPTER_UNSUPPORTED",
      expose: true,
    });
  }

  const [existing] = await db
    .select()
    .from(storeCheckoutSessions)
    .where(
      and(
        eq(storeCheckoutSessions.orderId, order.id),
        eq(storeCheckoutSessions.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      created: false,
      session: existing,
      card: buildPaymentStatusCard({
        orderId: existing.orderId,
        sessionId: existing.id,
        status: existing.status as PaymentStatusCard["status"],
        amountMinor: existing.amountMinor,
        currencyCode: existing.currencyCode,
        checkoutUrl: existing.checkoutUrl,
        adapterName: record.displayName,
        paidAt: existing.paidAt,
      }),
    };
  }

  const sessionId = randomUUID();
  const created = await adapter.createSession({
    sessionId,
    orderId: order.id,
    amountMinor: totalMinor,
    currencyCode: order.currencyCode,
    buyerId: input.buyerId,
    returnUrl: input.returnUrl,
  });

  const [inserted] = await db
    .insert(storeCheckoutSessions)
    .values({
      id: sessionId,
      orderId: order.id,
      businessId,
      marketId: order.marketId,
      buyerId: input.buyerId,
      adapterId: record.id,
      adapterKind: record.adapterKind,
      providerSessionId: created.providerSessionId,
      checkoutUrl: created.checkoutUrl,
      amountMinor: totalMinor,
      currencyCode: order.currencyCode,
      status: "PENDING",
      idempotencyKey: input.idempotencyKey,
    })
    .returning();

  return {
    created: true,
    session: inserted!,
    card: buildPaymentStatusCard({
      orderId: inserted!.orderId,
      sessionId: inserted!.id,
      status: "PENDING",
      amountMinor: inserted!.amountMinor,
      currencyCode: inserted!.currencyCode,
      checkoutUrl: inserted!.checkoutUrl,
      adapterName: record.displayName,
    }),
  };
}

export async function getStoreCheckoutOrderStatus(
  orderId: string,
  actorId: string,
): Promise<PaymentStatusCard | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || (order.buyerId !== actorId && order.sellerId !== actorId)) return null;
  const [latest] = await db
    .select()
    .from(storeCheckoutSessions)
    .where(eq(storeCheckoutSessions.orderId, orderId))
    .orderBy(desc(storeCheckoutSessions.createdAt))
    .limit(1);
  if (!latest) return null;
  const [adapterRow] = await db
    .select({ displayName: storeCheckoutAdapters.displayName })
    .from(storeCheckoutAdapters)
    .where(eq(storeCheckoutAdapters.id, latest.adapterId))
    .limit(1);
  return buildPaymentStatusCard({
    orderId: latest.orderId,
    sessionId: latest.id,
    status: latest.status as PaymentStatusCard["status"],
    amountMinor: latest.amountMinor,
    currencyCode: latest.currencyCode,
    checkoutUrl: latest.checkoutUrl,
    adapterName: adapterRow?.displayName,
    paidAt: latest.paidAt,
  });
}

export async function receiveStoreCheckoutWebhook(input: {
  adapterId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}): Promise<{ status: number; outcome: "APPLIED" | "DUPLICATE" | "REJECTED" | "IGNORED"; reason?: string }> {
  const [adapterRow] = await db
    .select()
    .from(storeCheckoutAdapters)
    .where(eq(storeCheckoutAdapters.id, input.adapterId))
    .limit(1);
  if (!adapterRow) {
    return { status: 404, outcome: "REJECTED", reason: "UNKNOWN_ADAPTER" };
  }
  let parsedBody: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input.rawBody.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsedBody = parsed as Record<string, unknown>;
    }
  } catch {
    return { status: 400, outcome: "REJECTED", reason: "INVALID_JSON" };
  }

  const record = toRecord(adapterRow);
  const adapter = buildStoreCheckoutAdapter(record);
  const verification = await adapter.verifyWebhook({
    headers: input.headers,
    rawBody: input.rawBody,
    parsedBody,
  });

  if (!verification.valid || !verification.eventId || !verification.providerSessionId) {
    return {
      status: verification.reason === "INVALID_SIGNATURE" || verification.reason === "MISSING_SIGNATURE" ? 401 : 400,
      outcome: "REJECTED",
      reason: verification.reason ?? "INVALID_WEBHOOK",
    };
  }

  const providerState =
    verification.eventType === "PAID"
      ? await adapter.fetchSessionState(verification.providerSessionId)
      : null;

  return db.transaction(async (tx) => {
    const [existingEvent] = await tx
      .select()
      .from(storeCheckoutWebhookEvents)
      .where(
        and(
          eq(storeCheckoutWebhookEvents.adapterId, record.id),
          eq(storeCheckoutWebhookEvents.eventId, verification.eventId!),
        ),
      )
      .limit(1);
    if (existingEvent) {
      return { status: 200, outcome: "DUPLICATE" as const, reason: "ALREADY_PROCESSED" };
    }

    const [session] = await tx
      .select()
      .from(storeCheckoutSessions)
      .where(
        and(
          eq(storeCheckoutSessions.adapterId, record.id),
          eq(storeCheckoutSessions.providerSessionId, verification.providerSessionId!),
        ),
      )
      .limit(1);
    if (!session) {
      await tx.insert(storeCheckoutWebhookEvents).values({
        id: randomUUID(),
        adapterId: record.id,
        eventId: verification.eventId!,
        eventType: verification.eventType ?? "IGNORED",
        outcome: "REJECTED",
        reason: "UNKNOWN_SESSION",
        payload: parsedBody,
      });
      return { status: 404, outcome: "REJECTED" as const, reason: "UNKNOWN_SESSION" };
    }

    if (verification.eventType === "PAID") {
      const orderMismatch =
        (verification.orderId && verification.orderId !== session.orderId) ||
        (providerState?.orderId && providerState.orderId !== session.orderId);
      const amountMismatch =
        verification.amountMinor !== session.amountMinor ||
        (providerState?.amountMinor !== undefined && providerState.amountMinor !== session.amountMinor);
      const currencyMismatch =
        verification.currencyCode !== session.currencyCode ||
        (providerState?.currencyCode !== undefined && providerState.currencyCode !== session.currencyCode);
      const providerNotPaid = !providerState || providerState.status !== "PAID";

      if (orderMismatch || amountMismatch || currencyMismatch || providerNotPaid) {
        await tx
          .update(storeCheckoutSessions)
          .set({ status: "MISMATCH_REVIEW", updatedAt: new Date() })
          .where(and(eq(storeCheckoutSessions.id, session.id), eq(storeCheckoutSessions.status, "PENDING")));
        await tx.insert(storeCheckoutWebhookEvents).values({
          id: randomUUID(),
          adapterId: record.id,
          eventId: verification.eventId!,
          sessionId: session.id,
          eventType: "PAID",
          outcome: "REJECTED",
          reason: providerNotPaid ? "PROVIDER_STATE_NOT_PAID" : "AMOUNT_CURRENCY_ORDER_MISMATCH",
          payload: parsedBody,
        });
        return {
          status: 200,
          outcome: "REJECTED" as const,
          reason: providerNotPaid ? "PROVIDER_STATE_NOT_PAID" : "AMOUNT_CURRENCY_ORDER_MISMATCH",
        };
      }

      const now = new Date();
      await tx
        .update(storeCheckoutSessions)
        .set({
          status: "PAID",
          paidEventId: verification.eventId!,
          paidAt: now,
          updatedAt: now,
        })
        .where(eq(storeCheckoutSessions.id, session.id));

      await tx
        .update(orders)
        .set({
          status: "PAID",
          updatedAt: now,
        })
        .where(eq(orders.id, session.orderId));

      await tx.insert(storeCheckoutWebhookEvents).values({
        id: randomUUID(),
        adapterId: record.id,
        eventId: verification.eventId!,
        sessionId: session.id,
        eventType: "PAID",
        outcome: "APPLIED",
        payload: parsedBody,
      });
      return { status: 200, outcome: "APPLIED" as const };
    }

    if (
      verification.eventType === "FAILED" ||
      verification.eventType === "EXPIRED" ||
      verification.eventType === "CANCELLED"
    ) {
      await tx
        .update(storeCheckoutSessions)
        .set({ status: verification.eventType, updatedAt: new Date() })
        .where(and(eq(storeCheckoutSessions.id, session.id), eq(storeCheckoutSessions.status, "PENDING")));
      await tx.insert(storeCheckoutWebhookEvents).values({
        id: randomUUID(),
        adapterId: record.id,
        eventId: verification.eventId!,
        sessionId: session.id,
        eventType: verification.eventType,
        outcome: "APPLIED",
        payload: parsedBody,
      });
      return { status: 200, outcome: "APPLIED" as const };
    }

    await tx.insert(storeCheckoutWebhookEvents).values({
      id: randomUUID(),
      adapterId: record.id,
      eventId: verification.eventId!,
      sessionId: session.id,
      eventType: "IGNORED",
      outcome: "IGNORED",
      payload: parsedBody,
    });
    return { status: 200, outcome: "IGNORED" as const };
  });
}
