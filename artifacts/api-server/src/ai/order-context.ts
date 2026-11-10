import { randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { aiResultSets, aiUiBlocks, conversations, db, orders } from "@workspace/db";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import { resultPosition } from "./search-context";
import type { ToolResult } from "./tool-registry";

const ACTIVE_ORDER_STATUSES = new Set([
  "CREATED",
  "PAYMENT_PENDING",
  "PAID",
  "ACCEPTED",
  "IN_PROGRESS",
  "SELLER_MARKED_DELIVERED",
]);
const ORDER_SURFACES = new Set([
  "ORDERS_LIST",
  "ORDER_SELECTOR",
  "ORDER_STATUS",
  "ORDER_TRACKING",
]);

type OrderPurpose = "LIST" | "STATUS" | "TRACKING" | "RECEIPT" | "ISSUE";

function normalized(message: string) {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requestFor(message: string, surface?: string): OrderPurpose | "HIDE_MAP" | "SHOW_MAP" | undefined {
  const text = normalized(message);
  if (/(?:فاتوره|ايصال|الفاتوره|الايصال)/u.test(text) && /(?:طلب|طلبي|الطلبات)/u.test(text))
    return "RECEIPT";
  // «لم أستلم الطلب، افتح لي شكوى»: a problem with an order the buyer is waiting for.
  if (/(?:لم|ما)\s+(?:استلم|استلمت|يوصل|يوصلني|وصل|وصلني)|(?:شكوي|شكوه|نزاع|بلاغ)\s/u.test(`${text} `) && /(?:طلب|شكوي|شكوه|نزاع|استلم)/u.test(text))
    return "ISSUE";
  if (/(?:اخف|اخفي|اغلق|اقفل).{0,16}الخريطه/u.test(text)) return "HIDE_MAP";
  if (/(?:اظهر|اعرض|افتح|ورني).{0,16}الخريطه/u.test(text)) return "SHOW_MAP";
  if (/طلباتي|(?:اعرض|افتح|ورني).{0,12}(?:الطلبات|طلباتي)|سجل الطلبات/u.test(text))
    return "LIST";
  if (
    /تتبع|الموقع المباشر|الخريطه|موعد الوصول|(?:وين|اين|مكان|موقع).{0,14}(?:السائق|المندوب)|(?:السائق|المندوب).{0,14}(?:وين|اين|موقع)/u.test(
      text,
    )
  )
    return "TRACKING";
  if (/وين طلبي|اين طلبي|حاله طلبي|حاله الطلب|تفاصيل الطلب|وضع الطلب|متى يصل|متى يوصل/u.test(text))
    return "STATUS";
  if (surface === "ORDERS") return "LIST";
  return undefined;
}

function isOrderFollowup(message: string) {
  return /كلم البائع|اكد الاستلام|(?:طيب\s+)?وين\s+وصل|وينه|وينها|حالتها|حالته|وضعه|وضعها|متى يوصل|متى يصل/u.test(
    normalized(message),
  );
}

async function loadOrderSet(id: string, conversationId: string, marketId: string, ownerId: string) {
  const [set] = await db
    .select()
    .from(aiResultSets)
    .where(
      and(
        eq(aiResultSets.id, id),
        eq(aiResultSets.conversationId, conversationId),
        eq(aiResultSets.marketId, marketId),
      ),
    )
    .limit(1);
  if (
    !set ||
    (set.expiresAt !== null && set.expiresAt.getTime() <= Date.now()) ||
    (set.query as { kind?: unknown; ownerId?: unknown } | null)?.kind !== "ORDERS" ||
    (set.query as { ownerId?: unknown } | null)?.ownerId !== ownerId
  )
    return undefined;
  return set;
}

async function latestOrderState(conversationId: string, marketId: string, ownerId: string) {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const payload = block?.payload as Record<string, unknown> | undefined;
  const surface = payload?.surface;
  const resultSetId = payload?.resultSetId;
  if (
    typeof surface !== "string" ||
    !ORDER_SURFACES.has(surface) ||
    typeof resultSetId !== "string"
  )
    return undefined;
  const set = await loadOrderSet(resultSetId, conversationId, marketId, ownerId);
  if (!set) return undefined;
  const blockIds = Array.isArray(payload?.resourceIds)
    ? payload.resourceIds.filter((id): id is string => typeof id === "string")
    : [];
  const ids = set.resourceIds.filter((id): id is string => blockIds.includes(id));
  return {
    surface,
    set,
    ids,
    query: set.query as Record<string, unknown>,
    resourceId:
      typeof payload?.resourceId === "string" ? payload.resourceId : undefined,
  };
}

function orderSurface(input: {
  surface: string;
  ownerId: string;
  marketId: string;
  ids?: string[];
  orderId?: string;
  purpose: OrderPurpose;
  prompt: string;
  sourceResultSetId?: string;
  hideMap?: boolean;
}): ToolResult {
  const resultSetId = randomUUID();
  return {
    kind: "SURFACE",
    surface: input.surface,
    resultSetId,
    resourceIds: input.ids ?? [],
    resourceId: input.orderId,
    hideMap: input.hideMap,
    query: {
      kind: "ORDERS",
      ownerId: input.ownerId,
      purpose: input.purpose,
      orderId: input.orderId,
      sourceResultSetId: input.sourceResultSetId,
    },
    listings: [],
    prompt: input.prompt,
  };
}

function rankForList(status: string) {
  if (ACTIVE_ORDER_STATUSES.has(status)) return 0;
  if (status === "COMPLETED" || status === "BUYER_CONFIRMED") return 1;
  if (status === "CANCELLED") return 2;
  if (status === "DISPUTED") return 3;
  return 4;
}

/** Resolves only server-stored order IDs for the conversation owner. Never mutates an order. */
export async function orderContext(
  conversationId: string,
  marketId: string,
  message: string,
  surface?: string,
  actorId?: string,
): Promise<ToolResult | undefined> {
  const request = requestFor(message, surface);
  const position = resultPosition(message);
  const isFollowup = position !== undefined || isOrderFollowup(message);
  if (!request && surface !== "ORDERS" && !isFollowup) return undefined;
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conversation?.ownerUserId) {
    if (request || surface === "ORDERS")
      return {
        kind: "SURFACE",
        surface: "AUTH",
        query: {},
        listings: [],
        prompt: "سجّل الدخول لعرض طلباتك ومتابعة حالتها.",
      };
    return undefined;
  }
  const ownerId = conversation.ownerUserId;
  if (actorId && actorId !== ownerId) return undefined;

  const latest = await latestOrderState(conversationId, marketId, ownerId);
  // Relative selections belong to the currently displayed domain; do not consume listing,
  // draft, or other conversation ordinals as order references.
  if (!request && !latest) return undefined;
  if (request === "HIDE_MAP" || request === "SHOW_MAP") {
    if (!latest || latest.surface !== "ORDER_TRACKING") return undefined;
    const orderId =
      latest.resourceId ??
      (typeof latest.query.orderId === "string" ? latest.query.orderId : undefined);
    if (!orderId) return undefined;
    return orderSurface({
      surface: "ORDER_TRACKING",
      ownerId,
      marketId,
      ids: [orderId],
      orderId,
      purpose: "TRACKING",
      sourceResultSetId:
        typeof latest.query.sourceResultSetId === "string"
          ? latest.query.sourceResultSetId
          : latest.set.id,
      hideMap: request === "HIDE_MAP",
      prompt: request === "HIDE_MAP" ? "أخفيت مساحة الخريطة." : "أظهرت مساحة الخريطة.",
    });
  }

  if (request === "LIST") {
    const rows = await db
      .select({ id: orders.id, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(or(eq(orders.buyerId, ownerId), eq(orders.sellerId, ownerId)))
      .orderBy(desc(orders.createdAt));
    rows.sort(
      (a, b) =>
        rankForList(a.status) - rankForList(b.status) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
    return orderSurface({
      surface: "ORDERS_LIST",
      ownerId,
      marketId,
      ids: rows.map((row) => row.id),
      purpose: "LIST",
      prompt: rows.length ? "هذه طلباتك مرتبة حسب حالتها الحالية." : "لا توجد لديك طلبات بعد.",
    });
  }

  // A dispute is opened only from the order itself, after the seller has recorded the hand-off,
  // with the buyer's own description; chat text alone never opens one.
  if (request === "ISSUE") {
    const awaiting = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.buyerId, ownerId), eq(orders.marketId, marketId), eq(orders.status, "SELLER_MARKED_DELIVERED")))
      .orderBy(desc(orders.createdAt));
    const how = "لم أفتح نزاعًا من نص المحادثة. اضغط «الإبلاغ عن مشكلة» في بطاقة الطلب واختر «لم أستلم الطلب» واكتب ما حدث، فيُسجَّل نزاع واحد مرتبط بالطلب وتراجعه الإدارة.";
    if (awaiting.length === 1)
      return orderSurface({ surface: "ORDER_STATUS", ownerId, marketId, ids: [awaiting[0]!.id], orderId: awaiting[0]!.id, purpose: "ISSUE", prompt: `هذا طلبك الذي سجّل البائع تسليمه. ${how}` });
    if (awaiting.length > 1)
      return orderSurface({ surface: "ORDER_SELECTOR", ownerId, marketId, ids: awaiting.map((row) => row.id), purpose: "ISSUE", prompt: `لديك عدة طلبات سجّل بائعوها التسليم. اختر الطلب المقصود. ${how}` });
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.buyerId, ownerId), eq(orders.marketId, marketId)))
      .orderBy(desc(orders.createdAt));
    return orderSurface({
      surface: "ORDERS_LIST",
      ownerId,
      marketId,
      ids: rows.map((row) => row.id),
      purpose: "ISSUE",
      prompt: rows.length
        ? "لا يوجد لديك طلب سجّل بائعه التسليم بعد، لذلك لا يمكن فتح نزاع على الاستلام الآن. هذه طلباتك وحالتها الحالية؛ افتح الطلب من القائمة لمراسلة البائع."
        : "لا توجد لديك طلبات في هذا السوق لفتح شكوى عليها.",
    });
  }

  if (request === "RECEIPT") {
    const completed = await db
      .select({ id: orders.id, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.buyerId, ownerId), eq(orders.status, "COMPLETED")))
      .orderBy(desc(orders.createdAt));
    if (!completed.length)
      return orderSurface({
        surface: "ORDER_STATUS",
        ownerId,
        marketId,
        purpose: "RECEIPT",
        prompt: "لا يوجد إيصال لطلب مكتمل في سجل مشترياتك بعد.",
      });
    if (completed.length > 1)
      return orderSurface({
        surface: "ORDER_SELECTOR",
        ownerId,
        marketId,
        ids: completed.map((row) => row.id),
        purpose: "RECEIPT",
        prompt: "لديك عدة طلبات مكتملة. اختر الطلب الذي تريد إيصالَه.",
      });
    const orderId = completed[0]!.id;
    return orderSurface({
      surface: "ORDER_STATUS",
      ownerId,
      marketId,
      ids: [orderId],
      orderId,
      purpose: "RECEIPT",
      prompt: "هذا إيصال الطلب المكتمل من بيانات الطلب المسجلة.",
    });
  }

  if (!request && !isFollowup) return undefined;
  const purpose: OrderPurpose =
    (latest?.query.purpose === "RECEIPT" && isFollowup)
      ? "RECEIPT"
      :
    request === "TRACKING" ||
    (latest?.query.purpose === "TRACKING" && isFollowup)
      ? "TRACKING"
      : "STATUS";

  if (!request || request === "STATUS" || request === "TRACKING") {
    if (
      position === undefined &&
      (latest?.surface === "ORDER_TRACKING" || latest?.surface === "ORDER_STATUS") &&
      isFollowup
    ) {
      const currentOrderId =
        latest.resourceId ??
        (typeof latest.query.orderId === "string" ? latest.query.orderId : undefined);
      if (currentOrderId)
        return orderSurface({
          surface: purpose === "TRACKING" ? "ORDER_TRACKING" : "ORDER_STATUS",
          ownerId,
          marketId,
          ids: [currentOrderId],
          orderId: currentOrderId,
          purpose,
          sourceResultSetId: latest.set.id,
          prompt:
            purpose === "TRACKING"
              ? "هذه بطاقة التتبع. لا تظهر بيانات موقع حي إلا عند توفر مصدر معتمد."
              : "هذه أحدث حالة مسجلة لهذا الطلب.",
        });
    }

    if (position !== undefined && latest) {
      const sourceId =
        typeof latest.query.sourceResultSetId === "string"
          ? latest.query.sourceResultSetId
          : latest.set.id;
      const sourceSet =
        (await loadOrderSet(sourceId, conversationId, marketId, ownerId)) ?? latest.set;
      const orderId = sourceSet.resourceIds[position];
      if (typeof orderId === "string") {
        const [ownedOrder] = await db
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.id, orderId),
              or(eq(orders.buyerId, ownerId), eq(orders.sellerId, ownerId)),
            ),
          )
          .limit(1);
        if (ownedOrder)
          return orderSurface({
            surface: purpose === "TRACKING" ? "ORDER_TRACKING" : "ORDER_STATUS",
            ownerId,
            marketId,
            ids: [ownedOrder.id],
            orderId: ownedOrder.id,
            purpose,
            sourceResultSetId: sourceSet.id,
            prompt:
              purpose === "TRACKING"
                ? "هذه بطاقة التتبع. لا تظهر بيانات موقع حي إلا عند توفر مصدر معتمد."
                : "هذه أحدث حالة مسجلة لهذا الطلب.",
          });
      }
      return {
        kind: "SURFACE",
        surface: "CLARIFY",
        query: {},
        listings: [],
        prompt: "لم أجد هذا الترتيب ضمن طلباتك المعروضة. افتح «طلباتي» لاختيار طلب آخر.",
      };
    }

    const rows = await db
      .select({ id: orders.id, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(or(eq(orders.buyerId, ownerId), eq(orders.sellerId, ownerId)))
      .orderBy(desc(orders.createdAt));
    const active = rows.filter((row) => ACTIVE_ORDER_STATUSES.has(row.status));
    if (active.length === 0) {
      const recent = rows.slice(0, 24).map((row) => row.id);
      return orderSurface({
        surface: "ORDERS_LIST",
        ownerId,
        marketId,
        ids: recent,
        purpose: "LIST",
        prompt: rows.length
          ? "لا يوجد طلب نشط الآن. هذه أحدث طلباتك."
          : "لا توجد لديك طلبات بعد.",
      });
    }
    if (active.length > 1)
      return orderSurface({
        surface: "ORDER_SELECTOR",
        ownerId,
        marketId,
        ids: active.map((row) => row.id),
        purpose,
        prompt: "لديك أكثر من طلب نشط. اختر رقم الطلب الذي تقصده.",
      });
    const orderId = active[0]!.id;
    return orderSurface({
      surface: purpose === "TRACKING" ? "ORDER_TRACKING" : "ORDER_STATUS",
      ownerId,
      marketId,
      ids: [orderId],
      orderId,
      purpose,
      sourceResultSetId: latest?.set.id,
      prompt:
        purpose === "TRACKING"
          ? "هذه بطاقة التتبع. لا تظهر بيانات موقع حي إلا عند توفر مصدر معتمد."
          : "هذه أحدث حالة مسجلة لهذا الطلب.",
    });
  }
  return undefined;
}
