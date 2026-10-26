/**
 * Delivery and one-time location sharing inside the shared DINAR conversation runtime.
 *
 * Like employment, this is an intent adapter, not a second runtime: every surface is
 * an ordinary SURFACE block and every step an `ai_result_sets` row of kind DELIVERY.
 * Mutations are pending actions that only the same actor's immediate confirmation
 * applies, through the delivery authority in lib/delivery.
 *
 * Location safety: the device is read only by the client after an explicit tap, once
 * per tap. The reading arrives as structured turn input against a server-issued
 * request, becomes a LOCATION_PREVIEW pending action, and is attached to the order
 * only on confirmation. Settled, expired or superseded previews have their location
 * scrubbed; stored conversation blocks never contain coordinates or address text.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, conversations, db, deliveryAssignments, orderFulfillments, orders } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import {
  DELIVERY_FAILURE_REASONS,
  DELIVERY_FEE_NOTE,
  DELIVERY_TRANSITION_TARGETS,
  FAILURE_LABELS,
  LOCATION_PURPOSES,
  LocationInput,
  METHOD_LABELS,
  PURPOSE_LABELS,
  POOR_ACCURACY_METERS,
  STATUS_LABELS,
  accuracyNote,
  attachTransactionLocation,
  checkLocationAllowed,
  checkTransition,
  deliveryCapability,
  deliveryOptions,
  getDeliveryView,
  normalizeLocationInput,
  orderReference,
  participantOrder,
  purposeFor,
  selectDeliveryMethod,
  transitionDelivery,
  type DeliveryFailureReason,
  type DeliveryMethod,
  type DeliveryTransitionTarget,
  type DeliveryView,
  type LocationPurpose,
} from "../lib/delivery";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type StoredSet = typeof aiResultSets.$inferSelect;

export const DELIVERY_SURFACES = CONVERSATION_SURFACE_FAMILIES.delivery;
export type DeliverySurface = (typeof DELIVERY_SURFACES)[number];

/** Pending confirmations and location requests are short-lived. */
export const DELIVERY_PENDING_TTL_MS = 10 * 60 * 1000;

const PendingAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SELECT_METHOD"), method: z.enum(["PICKUP", "SELLER_DELIVERY", "COURIER"]) }).strict(),
  z
    .object({
      type: z.literal("SHARE_LOCATION"),
      purpose: z.enum(LOCATION_PURPOSES),
      // Removed once the action is settled, expired or superseded.
      location: LocationInput.optional(),
      source: z.enum(["DEVICE", "MANUAL"]),
      replacing: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("TRANSITION"),
      to: z.enum(DELIVERY_TRANSITION_TARGETS),
      failureReason: z.enum(DELIVERY_FAILURE_REASONS).optional(),
    })
    .strict(),
]);
type PendingAction = z.infer<typeof PendingAction>;
const ActionStatus = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "REJECTED"]);

const DeliveryQuery = z
  .object({
    kind: z.literal("DELIVERY"),
    ownerId: z.string().min(1),
    orderId: z.string().min(1),
    view: z.enum(DELIVERY_SURFACES),
    purpose: z.enum(LOCATION_PURPOSES).optional(),
    action: PendingAction.optional(),
    status: ActionStatus.optional(),
    notice: z.string().max(600).optional(),
  })
  .strict();
type DeliveryQuery = z.infer<typeof DeliveryQuery>;

export function isDeliveryQuery(query: unknown): boolean {
  return (query as { kind?: unknown } | null)?.kind === "DELIVERY";
}

/** Stored lifetime: requests and pending actions live briefly, views for 30 days. */
export function deliveryStateExpiry(query: unknown, now = Date.now()): Date | undefined {
  const parsed = DeliveryQuery.safeParse(query);
  if (!parsed.success) return undefined;
  const shortLived = parsed.data.action !== undefined || ["LOCATION_PERMISSION_REQUEST", "MANUAL_ADDRESS"].includes(parsed.data.view);
  return new Date(now + (shortLived ? DELIVERY_PENDING_TTL_MS : 30 * 24 * 60 * 60 * 1000));
}

// ─── Phrases ─────────────────────────────────────────────────────────────────

/** Block A folding plus ة→ه and punctuation removal; phrases are matched as whole messages. */
export function normalizeDeliveryText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:من فضلك|لو سمحت|رجاء|ممكن|يا دينار|دينار)\s+)+/, "")
    .replace(/\s+(?:من فضلك|لو سمحت|رجاء)$/, "");
}

const WANT = String.raw`(?:(?:انا\s+)?(?:اريد|ابي|ابغى|بدي|اود|حاب|ودي)\s+(?:ان\s+)?)?`;
const PLACE = String.raw`(?:موقعي|الموقع|عنواني|العنوان|(?:موقع|عنوان|مكان|نقطه)\s+(?:التسليم|التوصيل|الاستلام))`;
const re = (body: string) => new RegExp(`^${WANT}${body}$`, "u");

export type DeliveryIntent =
  | "SHARE_LOCATION"
  | "CHANGE_LOCATION"
  | "CHANGE_LOCATION_CONTEXT"
  | "MANUAL_ADDRESS"
  | "CANCEL_LOCATION"
  | "LOCATION_MENTION"
  | "CHOOSE_PICKUP"
  | "CHOOSE_SELLER_DELIVERY"
  | "CHOOSE_COURIER"
  | "DELIVERY_OPTIONS"
  | "ASK_SELLER_DELIVERS"
  | "CANCEL_DELIVERY"
  | "STATUS"
  | "SELLER_ACCEPT"
  | "SELLER_OUT"
  | "SELLER_READY"
  | "SELLER_FAILED"
  | "SELLER_HANDOFF";

/** Small, separate phrase sets rather than one large expression. */
const INTENTS: [DeliveryIntent, RegExp][] = [
  ["SHARE_LOCATION", re(String.raw`(?:ارسل|ابعث|شارك|اعط|حدد|ارسال|مشاركه)\s+(?:له\s+|لك\s+)?${PLACE}(?:\s+(?:للبائع|الى البائع|للمشتري|الحالي|الان|الآن))*`)],
  ["SHARE_LOCATION", re(String.raw`(?:هذا|هذه|هنا)\s+(?:هو\s+|هي\s+)?(?:موقع|عنوان|مكان|نقطه)\s+(?:التسليم|التوصيل|الاستلام)`)],
  // «سأرسل لك موقعي», «استخدم موقعي الحالي للتوصيل»: the user offers a location for their order.
  ["SHARE_LOCATION", re(String.raw`(?:سارسل|سابعث|ساشارك|راح\s+ارسل|بارسل|برسل|ح\s*ارسل)(?:\s+(?:لك|لكم))?\s+(?:موقعي|عنواني|الموقع|لوكيشني)(?:\s+(?:الحالي|الان|الآن))?|سارسلك\s+(?:موقعي|عنواني)`)],
  ["SHARE_LOCATION", re(String.raw`(?:استخدم|استعمل|خذ)\s+(?:موقعي|مكاني)(?:\s+الحالي)?(?:\s+(?:للتوصيل|للتسليم|للطلب|لطلبي))?`)],
  ["CHANGE_LOCATION", re(String.raw`(?:غير|عدل|بدل|حدث|تغيير|تعديل)\s+(?:موقع|عنوان|مكان|نقطه)\s+(?:التسليم|التوصيل|الاستلام)`)],
  ["CHANGE_LOCATION_CONTEXT", re(String.raw`(?:غير|عدل|بدل|حدث)\s+(?:الموقع|العنوان|موقعي|عنواني)`)],
  ["MANUAL_ADDRESS", re(String.raw`(?:(?:اكتب|ادخل|ساكتب|بكتب|كتابه|ادخال)\s+(?:ال)?عنوان(?:ي)?(?:\s+(?:يدويا|بنفسي|التسليم|التوصيل))*|عنوان يدوي|ادخال يدوي|يدويا)`)],
  ["CANCEL_LOCATION", re(String.raw`(?:الغ|الغي|الغاء|اوقف|لا تشارك|لا ترسل)\s+(?:مشاركه\s+)?(?:الموقع|موقعي)`)],
  ["LOCATION_MENTION", re(String.raw`(?:موقع|عنوان|مكان)\s+(?:التسليم|التوصيل)`)],
  ["CHOOSE_PICKUP", re(String.raw`(?:اختر\s+|اختيار\s+)?(?:استلام شخصي|الاستلام الشخصي|استلام بنفسي|استلم بنفسي|استلمه بنفسي|استلمها بنفسي|ساستلم بنفسي|باستلم بنفسي|استلام من البائع)`)],
  ["CHOOSE_SELLER_DELIVERY", re(String.raw`(?:اختر\s+|اختيار\s+)?(?:توصيل من البائع|التوصيل من البائع|البائع يوصل(?:ه|ها)?(?:\s+لي)?|يوصله البائع|يوصلها البائع)`)],
  ["CHOOSE_COURIER", re(String.raw`(?:مندوب(?:\s+توصيل)?\s+(?:يوصل|يوصلني|يوصلها|يوصله)(?:\s+(?:لي|طلبي|الطلب))?|توصيل من مندوب DINAR|مندوب دينار|(?:ابي|اريد|ودي|بدي)\s+مندوب(?:\s+توصيل)?\s+(?:غيره|اخر|ثاني))`)],
  ["CHOOSE_COURIER", re(String.raw`(?:المندوب\s+اعتذر\s+)?(?:ابي|اريد|ودي|بدي)\s+مندوب(?:\s+توصيل)?\s+(?:غيره|اخر|ثاني)`)],
  ["DELIVERY_OPTIONS", re(String.raw`(?:توصيل|التوصيل|اختر التوصيل|اختيار التوصيل|خيارات التوصيل|طرق التوصيل|طرق التسليم|خيارات التسليم|توصيل للبيت|وصلوه لي|وصله لي)`)],
  ["ASK_SELLER_DELIVERS", /^(?:هل\s+)?(?:البائع\s+)?(?:يوصل|يوجد توصيل|في توصيل|فيه توصيل|متوفر توصيل)(?:\s+(?:الطلب|لي|هذا الطلب))?$/u],
  ["CANCEL_DELIVERY", re(String.raw`(?:الغ|الغي|الغاء)\s+(?:التوصيل|ترتيب التسليم|الاستلام الشخصي|طلب التوصيل)`)],
  ["STATUS", /^(?:(?:ما\s+)?(?:حاله|تفاصيل|متابعه|وين|اين)\s+(?:التوصيل|التسليم|الاستلام|نقطه الاستلام|مكان الاستلام)|(?:نقطه|مكان) الاستلام)$/u],
  ["SELLER_ACCEPT", /^(?:اقبل|قبول|اوافق على|موافق على|وافق على|قبلت)\s+(?:التوصيل|طلب التوصيل)$/u],
  ["SELLER_OUT", /^(?:(?:خرج|خرجت|طلعت|انطلقت|طلع)\s+(?:للتوصيل|بالطلب|الطلب)|(?:الطلب\s+)?(?:في|على|بال)\s*الطريق|خرج الطلب للتوصيل)$/u],
  ["SELLER_READY", /^(?:الطلب\s+)?جاهز\s+للاستلام$/u],
  ["SELLER_FAILED", /^(?:(?:تعذر|فشل)\s+(?:التوصيل|التسليم)(?:\s+.+)?|المشتري\s+(?:غير متاح|لا يرد|ما يرد|مش موجود))$/u],
  ["SELLER_HANDOFF", /^(?:(?:تم|تمت)\s+(?:التوصيل|التسليم)|سلمت(?:\s+الطلب)?|وصلت\s+الطلب)$/u],
];

export function deliveryIntent(text: string): DeliveryIntent | undefined {
  return INTENTS.find(([, pattern]) => pattern.test(text))?.[0];
}

const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|نعم اكد|اكد الموقع|تاكيد الموقع|نعم ارسل|ارسل|اعتمد|اعتمده)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا ترسل|لا تشارك|لا شكرا)$/u;

function failureReasonOf(text: string): DeliveryFailureReason {
  if (/المشتري|لا يرد|ما يرد|غير متاح|مش موجود/u.test(text)) return "BUYER_UNAVAILABLE";
  if (/العنوان|الموقع|الوصول/u.test(text)) return "ADDRESS_UNREACHABLE";
  if (/البائع|لا استطيع|ما اقدر/u.test(text)) return "SELLER_UNABLE";
  return "OTHER";
}

// ─── State ───────────────────────────────────────────────────────────────────

function parseState(set: StoredSet | undefined, actorId: string): DeliveryQuery | undefined {
  if (!set) return undefined;
  const parsed = DeliveryQuery.safeParse(set.query);
  return parsed.success && parsed.data.ownerId === actorId ? parsed.data : undefined;
}

const scrubbedQuery = (state: DeliveryQuery, status: z.infer<typeof ActionStatus>): DeliveryQuery => ({
  ...state,
  status,
  ...(state.action?.type === "SHARE_LOCATION"
    ? { action: { type: "SHARE_LOCATION", purpose: state.action.purpose, source: state.action.source, replacing: state.action.replacing } }
    : {}),
});

/**
 * Removes the candidate location from SHARE_LOCATION previews that expired or were
 * superseded. Runs on every delivery turn and from the server's periodic sweep, so
 * an unconfirmed reading never outlives its short confirmation window.
 */
export async function scrubStaleLocationPreviews(input: { conversationId?: string; keepId?: string } = {}) {
  const result = await db.execute(sql`
    update ${aiResultSets}
    set query = jsonb_set(jsonb_set(${aiResultSets.query}, '{action}', (${aiResultSets.query} -> 'action') - 'location'), '{status}', '"EXPIRED"')
    where ${aiResultSets.query} ->> 'kind' = 'DELIVERY'
      and ${aiResultSets.query} -> 'action' ->> 'type' = 'SHARE_LOCATION'
      and ${aiResultSets.query} -> 'action' ? 'location'
      and ${aiResultSets.query} ->> 'status' = 'PENDING'
      and (
        ${aiResultSets.expiresAt} <= now()
        ${input.conversationId ? sql`or (${aiResultSets.conversationId} = ${input.conversationId} ${input.keepId ? sql`and ${aiResultSets.id} <> ${input.keepId}` : sql``})` : sql``}
      )
  `);
  return result.rowCount ?? 0;
}

async function conversationSets(conversationId: string, marketId: string) {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(10);
}

async function latestBlockPayload(conversationId: string): Promise<Record<string, unknown> | undefined> {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  return block?.payload;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const PRECISE_KEYS = ["latitude", "longitude", "accuracyMeters", "accuracyNote", "addressText", "note"] as const;

function coarse<T extends Record<string, unknown> | null | undefined>(location: T): T {
  if (!location) return location;
  const copy: Record<string, unknown> = { ...location };
  for (const key of PRECISE_KEYS) if (key in copy) copy[key] = null;
  return copy as T;
}

/** The copy of a delivery payload that may be stored in conversation history. */
export function storableDeliveryPayload(payload: Record<string, unknown> | undefined) {
  if (!payload) return payload;
  const order = payload.order as Record<string, unknown> | undefined;
  return {
    ...payload,
    ...(order
      ? {
          order: {
            ...order,
            destination: coarse(order.destination as Record<string, unknown> | null),
            pickupPoint: coarse(order.pickupPoint as Record<string, unknown> | null),
            serviceLocation: coarse(order.serviceLocation as Record<string, unknown> | null),
          },
        }
      : {}),
    ...(payload.preview ? { preview: coarse(payload.preview as Record<string, unknown>) } : {}),
  };
}

function previewOf(action: Extract<PendingAction, { type: "SHARE_LOCATION" }>) {
  const location = action.location;
  return {
    purpose: action.purpose,
    purposeLabel: PURPOSE_LABELS[action.purpose],
    source: action.source,
    latitude: location?.source === "DEVICE" ? location.latitude : null,
    longitude: location?.source === "DEVICE" ? location.longitude : null,
    accuracyMeters: location?.source === "DEVICE" ? (location.accuracyMeters ?? null) : null,
    accuracyNote: location?.source === "DEVICE" ? accuracyNote(location.accuracyMeters) : null,
    poorAccuracy: location?.source === "DEVICE" && (location.accuracyMeters ?? 0) > POOR_ACCURACY_METERS,
    city: location?.source === "MANUAL" ? (location.city ?? "") : "",
    area: location?.source === "MANUAL" ? (location.area ?? "") : "",
    addressText: location?.source === "MANUAL" ? location.addressText : null,
    note: location?.note ?? null,
    available: Boolean(location),
  };
}

const CONFIRM_LABELS: Record<string, string> = {
  SELECT_METHOD: "تأكيد الطريقة",
  SHARE_LOCATION: "تأكيد الموقع",
  TRANSITION: "تأكيد",
};

function actionLines(action: PendingAction, view: DeliveryView | undefined): string[] {
  const ref = view ? [`الطلب: ${view.listingTitle} · #${view.orderRef}`] : [];
  switch (action.type) {
    case "SELECT_METHOD":
      return [
        ...ref,
        `طريقة التسليم: ${METHOD_LABELS[action.method]}`,
        action.method === "SELLER_DELIVERY"
          ? `موقع التسليم: ${view?.destination ? "سيبقى الموقع الحالي ما لم تغيّره" : "ستشارك موقع التسليم بعد التأكيد"}`
          : "نقطة الاستلام: يحددها البائع داخل الطلب؛ لن يُنشر عنوانه",
        `رسوم التوصيل: ${DELIVERY_FEE_NOTE}`,
      ];
    case "SHARE_LOCATION":
      return [
        ...ref,
        `${action.replacing ? "تغيير" : "مشاركة"} ${PURPOSE_LABELS[action.purpose]} مع ${action.purpose === "PICKUP_POINT" ? "المشتري" : "البائع"} في هذا الطلب فقط.`,
        "لن يظهر في الإعلانات أو البحث أو ملفك العام، ولن يُستخدم لطلبات أخرى.",
      ];
    case "TRANSITION":
      return [
        ...ref,
        action.to === "CANCELLED"
          ? "إلغاء ترتيب التسليم فقط؛ الطلب نفسه يبقى قائمًا ويمكن اختيار طريقة جديدة."
          : action.to === "FAILED"
            ? `تسجيل تعذر التسليم: ${FAILURE_LABELS[action.failureReason ?? "OTHER"]}. لا يغيّر ذلك الدفع أو حالة الطلب.`
            : `تغيير حالة التسليم إلى: ${STATUS_LABELS[action.to]}`,
      ];
  }
}

/**
 * Builds the allowlisted delivery payload from a stored state row and live order
 * state. Used for new turns and when history is reloaded, so redactions, settled
 * actions and lost access are always reflected.
 */
async function composePayload(state: DeliveryQuery, resultSetId: string, actorId: string, market: Market) {
  let order: DeliveryView | undefined;
  try {
    order = await getDeliveryView({ actorId, orderId: state.orderId, market });
  } catch {
    order = undefined;
  }
  const payload: Record<string, unknown> = { view: state.view, orderId: state.orderId, ...(order ? { order } : {}) };
  if (state.notice) payload.notice = state.notice;
  if (state.view === "LOCATION_PERMISSION_REQUEST" || state.view === "MANUAL_ADDRESS")
    payload.request = {
      requestId: resultSetId,
      purpose: state.purpose,
      purposeLabel: state.purpose ? PURPOSE_LABELS[state.purpose] : undefined,
    };
  if (state.action) {
    payload.action = {
      actionId: resultSetId,
      type: state.action.type,
      status: state.status ?? "PENDING",
      lines: actionLines(state.action, order),
      confirmLabel: CONFIRM_LABELS[state.action.type],
    };
    if (state.action.type === "SHARE_LOCATION")
      payload.preview = previewOf(state.status === "PENDING" ? state.action : { ...state.action, location: undefined });
  }
  return order ? payload : { ...payload, notice: state.notice ?? "لم يعد هذا الطلب متاحًا لك." };
}

async function turnFor(state: DeliveryQuery, prompt: string, actorId: string, market: Market): Promise<Turn> {
  const resultSetId = randomUUID();
  return {
    tool: "delivery",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: state.view,
      resultSetId,
      resourceIds: [state.orderId],
      resourceId: state.orderId,
      prompt,
      query: state,
      listings: [],
      delivery: await composePayload(state, resultSetId, actorId, market),
    },
  };
}

/** A notice without an order context keeps no state and offers no action. */
function plainNotice(prompt: string): Turn {
  return {
    tool: "delivery",
    version: 1,
    result: { kind: "SURFACE", surface: "DELIVERY_NOTICE", prompt, query: {}, listings: [], delivery: { view: "DELIVERY_NOTICE", notice: prompt } },
  };
}

/** History reload: rebuild from the stored row and live authorization. */
export async function refreshDeliveryPayload(
  payload: Record<string, unknown>,
  context: { actorId: string; market: Market; query: unknown; expiresAt?: Date | null },
): Promise<Record<string, unknown>> {
  const parsed = DeliveryQuery.safeParse(context.query);
  if (!parsed.success || parsed.data.ownerId !== context.actorId) {
    const delivery = (payload.delivery ?? {}) as Record<string, unknown>;
    return { view: delivery.view ?? "DELIVERY_NOTICE", notice: typeof delivery.notice === "string" ? delivery.notice : "انتهت صلاحية هذه البطاقة." };
  }
  let state = parsed.data;
  if (state.status === "PENDING" && context.expiresAt && context.expiresAt.getTime() <= Date.now())
    state = scrubbedQuery(state, "EXPIRED");
  return composePayload(state, String(payload.resultSetId), context.actorId, context.market);
}

// ─── Applying pending actions ────────────────────────────────────────────────

export type DeliveryActionOutcome = {
  status: "CONFIRMED" | "CANCELLED" | "EXPIRED" | "REJECTED";
  message: string;
  action: PendingAction;
  orderId: string;
};

/**
 * The single authority for confirming or cancelling a delivery action. Only the
 * conversation owner may decide, only while the action is the latest step and
 * unexpired. Every settlement scrubs a previewed location from the stored row.
 */
export async function applyDeliveryAction(input: {
  actionId: string;
  actorId: string;
  market: Market;
  decision: "CONFIRM" | "CANCEL";
}): Promise<DeliveryActionOutcome> {
  return db.transaction(async (tx) => {
    const [set] = await tx
      .select()
      .from(aiResultSets)
      .where(and(eq(aiResultSets.id, input.actionId), eq(aiResultSets.marketId, input.market.id)))
      .for("update")
      .limit(1);
    if (!set) throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, set.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.kind, "AI")))
      .limit(1);
    const state = parseState(set, input.actorId);
    if (!conversation || !state?.action) throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const action = state.action;
    const finish = async (status: DeliveryActionOutcome["status"], message: string) => {
      await tx.update(aiResultSets).set({ query: scrubbedQuery(state, status) }).where(eq(aiResultSets.id, set.id));
      return { status, message, action, orderId: state.orderId };
    };
    if (state.status && state.status !== "PENDING")
      return {
        status: state.status as DeliveryActionOutcome["status"],
        message:
          state.status === "EXPIRED"
            ? "انتهت صلاحية هذا الإجراء. لم يتغير شيء؛ اطلبه من جديد."
            : "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء.",
        action,
        orderId: state.orderId,
      };
    const [newer] = await tx
      .select({ id: aiUiBlocks.id })
      .from(aiUiBlocks)
      .where(
        and(
          eq(aiUiBlocks.conversationId, set.conversationId),
          gt(aiUiBlocks.createdAt, sql`(select ${aiResultSets.createdAt} from ${aiResultSets} where ${aiResultSets.id} = ${set.id})`),
        ),
      )
      .limit(1);
    if ((set.expiresAt && set.expiresAt.getTime() <= Date.now()) || newer)
      return finish("EXPIRED", "انتهت صلاحية هذا الإجراء لأن المحادثة تابعت بعده أو مضى وقته. لم يتغير شيء؛ اطلبه من جديد.");
    if (input.decision === "CANCEL")
      return finish(
        "CANCELLED",
        action.type === "SHARE_LOCATION" ? "أُلغيت مشاركة الموقع. لم يُرسل أي موقع." : "أُلغي الإجراء. لم يتغير شيء.",
      );
    const base = { actorId: input.actorId, orderId: state.orderId, market: input.market };
    try {
      // A savepoint keeps the action row writable if the authority rejects.
      const message = await tx.transaction(async (sp) => {
        switch (action.type) {
          case "SELECT_METHOD": {
            const result = await selectDeliveryMethod({ ...base, method: action.method }, sp);
            return result.changed
              ? `تم اختيار ${METHOD_LABELS[action.method]} لهذا الطلب.`
              : `${METHOD_LABELS[action.method]} مختار بالفعل؛ لم يتغير شيء.`;
          }
          case "SHARE_LOCATION": {
            if (!action.location) throw Object.assign(new Error("انتهت صلاحية الموقع المعروض."), { status: 409 });
            const result = await attachTransactionLocation({ ...base, purpose: action.purpose, location: action.location }, sp);
            if (!result.changed) return `${PURPOSE_LABELS[action.purpose]} مُرسل بالفعل؛ لم يتغير شيء.`;
            return result.replaced
              ? `تم تحديث ${PURPOSE_LABELS[action.purpose]}. يرى الطرف الآخر في الطلب الموقع الجديد فقط.`
              : `تم إرسال ${PURPOSE_LABELS[action.purpose]} إلى الطرف الآخر في هذا الطلب فقط.`;
          }
          case "TRANSITION": {
            const result = await transitionDelivery({ ...base, to: action.to, failureReason: action.failureReason }, sp);
            return result.changed
              ? action.to === "CANCELLED"
                ? "أُلغي ترتيب التسليم. الطلب نفسه لم يُلغَ."
                : `حالة التسليم الآن: ${STATUS_LABELS[action.to]}.`
              : "الحالة مسجلة بالفعل؛ لم يتغير شيء.";
          }
        }
      });
      return finish("CONFIRMED", message);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)
        return finish("REJECTED", `${error.message} لم يتغير شيء.`);
      throw error;
    }
  });
}

// ─── Turn ────────────────────────────────────────────────────────────────────

export type DeliveryTurnInput = {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
  location?: unknown;
  locationRequestId?: string;
};

const BUYER_INTENTS: DeliveryIntent[] = ["CHOOSE_PICKUP", "CHOOSE_SELLER_DELIVERY", "CHOOSE_COURIER", "DELIVERY_OPTIONS", "ASK_SELLER_DELIVERS", "MANUAL_ADDRESS", "CHANGE_LOCATION", "CHANGE_LOCATION_CONTEXT"];
const SELLER_INTENTS: DeliveryIntent[] = ["SELLER_ACCEPT", "SELLER_OUT", "SELLER_READY", "SELLER_FAILED", "SELLER_HANDOFF"];
const ARRANGEABLE = ["CREATED", "ACCEPTED", "IN_PROGRESS"];

/** Authority rejections answer as a notice; nothing changes. */
export async function executeDeliveryTurn(input: DeliveryTurnInput): Promise<Turn | null> {
  try {
    return await deliveryTurn(input);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (input.actorId && typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)
      return plainNotice(`${error.message} لم يتغير شيء.`);
    throw error;
  }
}

async function deliveryTurn(input: DeliveryTurnInput): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const { market } = input;
  const text = normalizeDeliveryText(input.message);
  const structured = input.location !== undefined;
  const intent = structured ? undefined : deliveryIntent(text);

  const [sets, blockPayload] = await Promise.all([
    conversationSets(input.conversationId, market.id),
    latestBlockPayload(input.conversationId),
  ]);
  const latestSet = sets[0];
  // Context is a delivery block whose own state row is the newest one in this conversation.
  const contextActive =
    Boolean(blockPayload?.delivery) && latestSet !== undefined && blockPayload?.resultSetId === latestSet.id;
  const latestState = contextActive ? parseState(latestSet, actorId) : undefined;
  const isConfirm = CONFIRM.test(text);
  const isCancel = CANCEL.test(text);

  // Nothing to do here: leave the turn to the rest of the runtime.
  if (!structured && !intent && !(contextActive && (isConfirm || isCancel))) return null;
  if (intent === "CHANGE_LOCATION_CONTEXT" && !contextActive) return null;
  // During a listing draft or an employment flow, words like «استلام» or «توصيل» answer
  // that flow; only an explicit location request is claimed there.
  if (
    !structured &&
    (blockPayload?.surface === "SELL" || blockPayload?.employment) &&
    intent !== "SHARE_LOCATION" &&
    intent !== "CHANGE_LOCATION"
  )
    return null;

  // Superseded previews never keep a location.
  await scrubStaleLocationPreviews({ conversationId: input.conversationId, keepId: latestSet?.id });

  // ── Pending action: only the immediately following decision applies it.
  if (!structured && latestState?.action && latestState.status === "PENDING" && (isConfirm || isCancel || intent === "CANCEL_LOCATION")) {
    const outcome = await applyDeliveryAction({ actionId: latestSet!.id, actorId, market, decision: isConfirm ? "CONFIRM" : "CANCEL" });
    return afterAction(outcome, actorId, market);
  }
  if (!structured && contextActive && (isConfirm || isCancel || intent === "CANCEL_LOCATION")) {
    if ((isCancel || intent === "CANCEL_LOCATION") && latestState && ["LOCATION_PERMISSION_REQUEST", "MANUAL_ADDRESS"].includes(latestState.view))
      return turnFor(
        { kind: "DELIVERY", ownerId: actorId, orderId: latestState.orderId, view: "DELIVERY_NOTICE", notice: "أُلغيت مشاركة الموقع. لم يُقرأ أو يُرسل أي موقع." },
        "أُلغيت مشاركة الموقع. لم يُقرأ أو يُرسل أي موقع.",
        actorId,
        market,
      );
    return plainNotice("لا يوجد إجراء توصيل بانتظار التأكيد الآن. لم يتغير شيء.");
  }

  // ── Structured location submission against a server-issued request.
  if (structured) return submitLocation(input, actorId, market, latestSet, latestState);

  // ── Resolve the order from the conversation context or the actor's orders.
  const contextOrderId =
    (latestState?.orderId && contextActive ? latestState.orderId : undefined) ??
    (blockPayload?.surface === "ORDER" && typeof blockPayload.resourceId === "string" ? blockPayload.resourceId : undefined);
  const resolved = await resolveOrder(actorId, market, intent!, contextOrderId);
  if ("turn" in resolved) return resolved.turn;
  const { order, role } = resolved;
  const view = await getDeliveryView({ actorId, orderId: order.id, market });
  const state = (extra: Partial<DeliveryQuery> & Pick<DeliveryQuery, "view">): DeliveryQuery => ({
    kind: "DELIVERY",
    ownerId: actorId,
    orderId: order.id,
    ...extra,
  });
  const say = (notice: string, surface: DeliverySurface = "DELIVERY_NOTICE") => turnFor(state({ view: surface, notice }), notice, actorId, market);
  const statusSurface: DeliverySurface = view.fulfillment?.method === "PICKUP" ? "PICKUP_DETAILS" : "DELIVERY_STATUS";

  switch (intent!) {
    case "STATUS":
      return turnFor(state({ view: statusSurface }), statusPrompt(view), actorId, market);
    case "LOCATION_MENTION":
      if (role === "SELLER") return turnFor(state({ view: statusSurface }), statusPrompt(view), actorId, market);
      return requestLocation(order.id, role, actorId, market, false);
    case "SHARE_LOCATION":
      return requestLocation(order.id, role, actorId, market, false);
    case "CHANGE_LOCATION":
    case "CHANGE_LOCATION_CONTEXT":
      return requestLocation(order.id, role, actorId, market, true);
    case "MANUAL_ADDRESS": {
      const purpose = purposeFor(order, role);
      await checkLocationAllowed({ actorId, orderId: order.id, purpose, market });
      return turnFor(
        state({ view: "MANUAL_ADDRESS", purpose }),
        `اكتب ${PURPOSE_LABELS[purpose]} لطلب «${view.listingTitle}». ستراجعه قبل إرساله، ولن يراه إلا الطرف الآخر في هذا الطلب.`,
        actorId,
        market,
      );
    }
    case "DELIVERY_OPTIONS":
    case "ASK_SELLER_DELIVERS": {
      const available = view.options.filter((option) => option.available);
      const lead =
        intent === "ASK_SELLER_DELIVERS"
          ? view.options.find((option) => option.method === "SELLER_DELIVERY")?.available
            ? "نعم، البائع يوصل هذا الطلب."
            : "لا، البائع لا يوصل هذا الطلب."
          : "";
      const body = available.length
        ? `${lead} الطرق المتاحة لطلب «${view.listingTitle}»: ${available.map((option) => option.label).join("، ")}. اختر واحدة.`
        : `${lead} لا توجد طريقة تسليم متاحة لهذا الطلب داخل DINAR؛ تواصل مع ${role === "BUYER" ? "البائع" : "المشتري"} داخل الطلب.`;
      return turnFor(state({ view: "DELIVERY_OPTIONS" }), body.trim(), actorId, market);
    }
    case "CHOOSE_PICKUP":
    case "CHOOSE_SELLER_DELIVERY":
    case "CHOOSE_COURIER": {
      if (role !== "BUYER") return say("اختيار طريقة الاستلام للمشتري فقط.");
      const method: DeliveryMethod = intent === "CHOOSE_PICKUP" ? "PICKUP" : intent === "CHOOSE_COURIER" ? "COURIER" : "SELLER_DELIVERY";
      const option = view.options.find((candidate) => candidate.method === method)!;
      if (!option.available) {
        const offered = view.options.filter((candidate) => candidate.available).map((candidate) => candidate.label);
        return turnFor(
          state({ view: "DELIVERY_OPTIONS" }),
          `${option.reason} ${offered.length ? `المتاح لهذا الطلب: ${offered.join("، ")}.` : "لا توجد طريقة تسليم متاحة لهذا الطلب."} لم يتغير شيء.`,
          actorId,
          market,
        );
      }
      if (!view.canSelectMethod && view.fulfillment?.method !== method)
        return say("بدأ تنفيذ التسليم؛ لا يمكن تغيير الطريقة الآن. لم يتغير شيء.", statusSurface);
      if (view.fulfillment?.method === method && !["CANCELLED", "FAILED"].includes(view.fulfillment.status))
        return turnFor(state({ view: statusSurface }), `${METHOD_LABELS[method]} مختار بالفعل لهذا الطلب. ${statusPrompt(view)}`, actorId, market);
      return turnFor(
        state({ view: "DELIVERY_SUMMARY", action: { type: "SELECT_METHOD", method }, status: "PENDING" }),
        `ملخص التسليم لطلب «${view.listingTitle}». لم يتغير شيء بعد؛ أكّد أو ألغِ.`,
        actorId,
        market,
      );
    }
    case "CANCEL_DELIVERY": {
      await checkTransition({ actorId, orderId: order.id, to: "CANCELLED", market });
      return turnFor(
        state({ view: "DELIVERY_ACTION", action: { type: "TRANSITION", to: "CANCELLED" }, status: "PENDING" }),
        "هل تريد إلغاء ترتيب التسليم؟ الطلب نفسه لا يُلغى. أكّد أو ألغِ.",
        actorId,
        market,
      );
    }
    case "SELLER_ACCEPT":
    case "SELLER_OUT":
    case "SELLER_READY":
    case "SELLER_FAILED": {
      const to: DeliveryTransitionTarget =
        intent === "SELLER_ACCEPT" ? "ACCEPTED" : intent === "SELLER_OUT" ? "OUT_FOR_DELIVERY" : intent === "SELLER_READY" ? "READY_FOR_PICKUP" : "FAILED";
      const check = await checkTransition({ actorId, orderId: order.id, to, market });
      if (check.repeat) return turnFor(state({ view: statusSurface }), `الحالة «${STATUS_LABELS[to]}» مسجلة بالفعل؛ لم يتغير شيء.`, actorId, market);
      const failureReason = to === "FAILED" ? failureReasonOf(text) : undefined;
      return turnFor(
        state({ view: "DELIVERY_ACTION", action: { type: "TRANSITION", to, ...(failureReason ? { failureReason } : {}) }, status: "PENDING" }),
        `هل تريد تسجيل «${STATUS_LABELS[to]}» لطلب «${view.listingTitle}»؟ أكّد أو ألغِ.`,
        actorId,
        market,
      );
    }
    case "SELLER_HANDOFF":
      // The final handoff stays with the existing order authority and its proof.
      return {
        tool: "delivery",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "ORDER",
          resourceIds: [order.id],
          resourceId: order.id,
          prompt: view.awaitingHandoff
            ? "سجّل التسليم مع إثباته من بطاقة الطلب. يكتمل الطلب فقط بعد تأكيد المشتري للاستلام."
            : `لا يمكن تسجيل التسليم بعد: حالة التسليم «${view.fulfillment ? view.fulfillment.statusLabel : "غير محددة"}». حدّثها أولًا، أو افتح بطاقة الطلب.`,
          query: {},
          listings: [],
        },
      };
    case "CANCEL_LOCATION":
      return say("لا توجد مشاركة موقع جارية الآن. لم يتغير شيء.");
  }
}

function statusPrompt(view: DeliveryView): string {
  if (!view.fulfillment)
    return view.role === "BUYER"
      ? `لم تختر طريقة التسليم لطلب «${view.listingTitle}» بعد.`
      : `لم يختر المشتري طريقة التسليم لطلب «${view.listingTitle}» بعد.`;
  const where =
    view.fulfillment.method === "PICKUP"
      ? view.pickupPoint
        ? " نقطة الاستلام محددة في البطاقة."
        : " لم يحدد البائع نقطة الاستلام بعد."
      : view.destination
        ? view.destination.redacted
          ? " حُذفت تفاصيل الموقع الدقيقة بعد انتهاء الطلب."
          : " موقع التسليم محدد في البطاقة."
        : " بانتظار موقع التسليم من المشتري.";
  return `${view.fulfillment.methodLabel} · ${view.fulfillment.statusLabel}.${where}`;
}

async function requestLocation(orderId: string, role: "BUYER" | "SELLER", actorId: string, market: Market, change: boolean, lead?: string): Promise<Turn> {
  const { order } = await participantOrder(db, orderId, actorId);
  const purpose = purposeFor(order, role);
  await checkLocationAllowed({ actorId, orderId, purpose, market });
  const view = await getDeliveryView({ actorId, orderId, market });
  const why =
    purpose === "PICKUP_POINT"
      ? "يحتاج المشتري نقطة الاستلام لهذا الطلب."
      : purpose === "SERVICE_APPOINTMENT"
        ? "يحتاج مقدم الخدمة موقع تقديمها لهذا الطلب."
        : "يحتاج البائع موقع التسليم لتوصيل هذا الطلب.";
  const current = purpose === "PICKUP_POINT" ? view.pickupPoint : purpose === "SERVICE_APPOINTMENT" ? view.serviceLocation : view.destination;
  return turnFor(
    { kind: "DELIVERY", ownerId: actorId, orderId, view: "LOCATION_PERMISSION_REQUEST", purpose },
    `${lead ? `${lead} ` : ""}${change && current ? "تغيير " : ""}${PURPOSE_LABELS[purpose]} لطلب «${view.listingTitle}». ${why} لن يُقرأ موقع جهازك إلا عند ضغطك «مشاركة موقعي الآن»، مرة واحدة، وستراجعه قبل إرساله. يمكنك بدلًا من ذلك كتابة العنوان يدويًا.`,
    actorId,
    market,
  );
}

async function submitLocation(
  input: DeliveryTurnInput,
  actorId: string,
  market: Market,
  latestSet: StoredSet | undefined,
  latestState: DeliveryQuery | undefined,
): Promise<Turn> {
  const anchorValid =
    latestSet !== undefined &&
    latestState !== undefined &&
    latestSet.id === input.locationRequestId &&
    (!latestSet.expiresAt || latestSet.expiresAt.getTime() > Date.now()) &&
    (latestState.view === "LOCATION_PERMISSION_REQUEST" ||
      latestState.view === "MANUAL_ADDRESS" ||
      (latestState.view === "LOCATION_PREVIEW" && latestState.status === "PENDING"));
  if (!anchorValid) {
    // Nothing is kept from a submission against a stale request.
    return plainNotice("انتهت صلاحية طلب مشاركة الموقع. اكتب «أرسل موقعي» من جديد. لم يُحفظ أي موقع.");
  }
  const purpose = latestState!.purpose ?? (latestState!.action?.type === "SHARE_LOCATION" ? latestState!.action.purpose : undefined);
  if (!purpose) return plainNotice("طلب الموقع غير صالح. لم يُحفظ أي موقع.");
  // A retry from a preview supersedes it.
  if (latestState!.view === "LOCATION_PREVIEW")
    await db.update(aiResultSets).set({ query: scrubbedQuery(latestState!, "EXPIRED") }).where(eq(aiResultSets.id, latestSet!.id));
  const location = normalizeLocationInput(input.location);
  await checkLocationAllowed({ actorId, orderId: latestState!.orderId, purpose, market });
  const view = await getDeliveryView({ actorId, orderId: latestState!.orderId, market });
  const current = purpose === "PICKUP_POINT" ? view.pickupPoint : purpose === "SERVICE_APPOINTMENT" ? view.serviceLocation : view.destination;
  const poor = location.source === "DEVICE" && (location.accuracyMeters ?? 0) > POOR_ACCURACY_METERS;
  return turnFor(
    {
      kind: "DELIVERY",
      ownerId: actorId,
      orderId: latestState!.orderId,
      view: "LOCATION_PREVIEW",
      purpose,
      action: { type: "SHARE_LOCATION", purpose, location, source: location.source, replacing: Boolean(current && !current.redacted) },
      status: "PENDING",
    },
    `راجع ${PURPOSE_LABELS[purpose]} قبل إرساله. لم يُرسل شيء بعد.${poor ? " دقة الموقع منخفضة؛ يمكنك إعادة المحاولة أو كتابة العنوان يدويًا." : ""}`,
    actorId,
    market,
  );
}

async function afterAction(outcome: DeliveryActionOutcome, actorId: string, market: Market): Promise<Turn> {
  const base = { kind: "DELIVERY" as const, ownerId: actorId, orderId: outcome.orderId };
  if (outcome.status !== "CONFIRMED") return turnFor({ ...base, view: "DELIVERY_NOTICE", notice: outcome.message }, outcome.message, actorId, market);
  const view = await getDeliveryView({ actorId, orderId: outcome.orderId, market });
  const statusSurface: DeliverySurface = view.fulfillment?.method === "PICKUP" ? "PICKUP_DETAILS" : "DELIVERY_STATUS";
  if (outcome.action.type === "SELECT_METHOD" && ["SELLER_DELIVERY", "COURIER"].includes(outcome.action.method) && !view.destination) {
    const next = await requestLocation(outcome.orderId, "BUYER", actorId, market, false);
    next.result.prompt = `${outcome.message} ${next.result.prompt}`;
    return next;
  }
  if (outcome.action.type === "SHARE_LOCATION")
    return turnFor({ ...base, view: "LOCATION_CONFIRMED", purpose: outcome.action.purpose }, outcome.message, actorId, market);
  return turnFor({ ...base, view: statusSurface }, `${outcome.message} ${statusPrompt(view)}`, actorId, market);
}

/**
 * Context order first (re-authorized) when it fits the request; otherwise the actor's
 * single relevant order. A context order that does not fit is used only when nothing
 * else does, so its specific rejection can be explained.
 */
async function resolveOrder(
  actorId: string,
  market: Market,
  intent: DeliveryIntent,
  contextOrderId: string | undefined,
): Promise<{ order: typeof orders.$inferSelect; role: "BUYER" | "SELLER" } | { turn: Turn }> {
  const relevantFor = (row: typeof orders.$inferSelect, fulfillment: typeof orderFulfillments.$inferSelect | undefined) => {
    const capability = deliveryCapability(row);
    const isSeller = row.sellerId === actorId;
    switch (intent) {
      case "LOCATION_MENTION":
        // A seller asking about «موقع التسليم» wants to see it.
        return isSeller
          ? fulfillment !== undefined && fulfillment.status !== "CANCELLED"
          : capability === "SELLER_DELIVERY" || capability === "SERVICE";
      case "SHARE_LOCATION":
      case "CHANGE_LOCATION":
      case "CHANGE_LOCATION_CONTEXT":
      case "MANUAL_ADDRESS":
        return isSeller ? fulfillment?.method === "PICKUP" : capability === "SELLER_DELIVERY" || capability === "SERVICE";
      case "CHOOSE_PICKUP":
      case "CHOOSE_SELLER_DELIVERY":
      case "CHOOSE_COURIER":
      case "DELIVERY_OPTIONS":
      case "ASK_SELLER_DELIVERS":
        return capability === "PICKUP_ONLY" || capability === "SELLER_DELIVERY";
      default:
        return fulfillment !== undefined && fulfillment.status !== "CANCELLED";
    }
  };
  let contextFallback: { order: typeof orders.$inferSelect; role: "BUYER" | "SELLER" } | undefined;
  if (contextOrderId) {
    try {
      const participant = await participantOrder(db, contextOrderId, actorId);
      // A driver's assigned order is the driver adapter's (Block F4), not this one's.
      if (participant.order.marketId === market.id && participant.role !== "DRIVER") {
        const resolved = participant as { order: typeof orders.$inferSelect; role: "BUYER" | "SELLER" };
        const [fulfillment] = await db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, resolved.order.id));
        if (relevantFor(resolved.order, fulfillment)) return resolved;
        contextFallback = resolved;
      }
    } catch {
      // Fall through to the actor's own orders; a foreign id is never used.
    }
  }
  const roleFilter = BUYER_INTENTS.includes(intent)
    ? eq(orders.buyerId, actorId)
    : SELLER_INTENTS.includes(intent)
      ? eq(orders.sellerId, actorId)
      : or(eq(orders.buyerId, actorId), eq(orders.sellerId, actorId));
  const statuses = intent === "STATUS" || intent === "SELLER_HANDOFF" ? [...ARRANGEABLE, "SELLER_MARKED_DELIVERED"] : ARRANGEABLE;
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.marketId, market.id), roleFilter, inArray(orders.status, statuses)))
    .orderBy(desc(orders.createdAt))
    .limit(25);
  const fulfillments = rows.length
    ? await db.select().from(orderFulfillments).where(inArray(orderFulfillments.orderId, rows.map((row) => row.id)))
    : [];
  const byOrder = new Map(fulfillments.map((row) => [row.orderId, row]));
  const relevant = rows.filter((row) => relevantFor(row, byOrder.get(row.id)));
  if (relevant.length === 0 && contextFallback) return contextFallback;
  if (relevant.length === 1) return { order: relevant[0], role: relevant[0].buyerId === actorId ? "BUYER" : "SELLER" };
  if (relevant.length === 0) {
    // If a matching delivery exists only in another selected market, refuse clearly
    // without exposing its details or treating it as a current-market order.
    const otherMarketRows = await db
      .select()
      .from(orders)
      .where(and(ne(orders.marketId, market.id), roleFilter, inArray(orders.status, statuses)))
      .orderBy(desc(orders.createdAt))
      .limit(25);
    const otherMarketFulfillments = otherMarketRows.length
      ? await db.select().from(orderFulfillments).where(inArray(orderFulfillments.orderId, otherMarketRows.map((row) => row.id)))
      : [];
    const otherMarketByOrder = new Map(otherMarketFulfillments.map((row) => [row.orderId, row]));
    if (otherMarketRows.some((row) => relevantFor(row, otherMarketByOrder.get(row.id))))
      return { turn: plainNotice("هذا الطلب في سوق آخر. غيّر السوق النشط قبل متابعة التوصيل؛ لم يتغير شيء.") };
    return {
      turn: plainNotice(
        intent === "SHARE_LOCATION" || intent === "CHANGE_LOCATION" || intent === "MANUAL_ADDRESS" || intent === "LOCATION_MENTION"
          ? "لا يوجد طلب قائم يحتاج موقعًا الآن. لا يشارك DINAR موقعك إلا داخل طلب محدد وبعد تأكيدك."
          : "لا يوجد طلب قائم يخص التسليم في سوقك الحالي.",
      ),
    };
  }
  return {
    turn: {
      tool: "delivery",
      version: 1,
      result: {
        kind: "SURFACE",
        surface: "ORDERS",
        resourceIds: relevant.map((row) => row.id),
        prompt: "لديك أكثر من طلب. اختر الطلب بترتيبه (مثل «الأول» أو «الثاني»)، ثم أعد طلبك.",
        query: {},
        listings: [],
      },
    },
  };
}


// ─── Recipient-addressed sharing (universal product control) ───────────────────

/** Several matching orders: the user picks one by position, then repeats the request. */
function chooseOrder(orderIds: string[]): Turn {
  return {
    tool: "delivery",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: "ORDERS",
      resourceIds: orderIds,
      prompt: "لديك أكثر من طلب. اختر الطلب بترتيبه (مثل «الأول» أو «الثاني»)، ثم أعد طلبك.",
      query: {},
      listings: [],
    },
  };
}

async function refusedAsNotice(run: () => Promise<Turn | null>): Promise<Turn | null> {
  try {
    return await run();
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)
      return plainNotice(`${error.message} لم يُشارك أي موقع.`);
    throw error;
  }
}

/**
 * «أرسل موقعي للسائق المسؤول عن طلبي». Only the order's own buyer, only for a COURIER order
 * whose driver has accepted it: the delivery destination is the one location that driver can
 * read (lib/delivery participantOrder), and it is removed once the delivery settles. No other
 * driver, and no recipient named by the user or the model, can be addressed.
 */
export function shareLocationWithAssignedDriver(input: DeliveryTurnInput): Promise<Turn | null> {
  return refusedAsNotice(async () => {
    if (!input.actorId) return null;
    const actorId = input.actorId;
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(orderFulfillments, eq(orderFulfillments.orderId, orders.id))
      .innerJoin(deliveryAssignments, and(eq(deliveryAssignments.orderId, orders.id), eq(deliveryAssignments.status, "ACCEPTED")))
      .where(and(eq(orders.buyerId, actorId), eq(orders.marketId, input.market.id), eq(orderFulfillments.method, "COURIER"), inArray(orders.status, ARRANGEABLE)))
      .orderBy(desc(orders.createdAt))
      .limit(10);
    if (!rows.length)
      return plainNotice("لا يوجد مندوب توصيل مُسنَد لأي طلب قائم لك في سوقك الحالي، لذلك لن أرسل موقعك لأي سائق. يصل موقع التسليم فقط إلى المندوب الذي قبل توصيل طلبك. لم يُشارك أي موقع.");
    if (rows.length > 1) return chooseOrder(rows.map((row) => row.id));
    const orderId = rows[0]!.id;
    const view = await getDeliveryView({ actorId, orderId, market: input.market });
    const state: DeliveryQuery = { kind: "DELIVERY", ownerId: actorId, orderId, view: "DELIVERY_STATUS" };
    if (view.destination && !view.canChangeDestination)
      return turnFor(state, `موقع التسليم لطلب «${view.listingTitle}» مُرسل بالفعل، ويراه مندوب التوصيل المُسنَد لهذا الطلب فقط. لا يمكن تغييره الآن لأن التوصيل بدأ. لم يتغير شيء.`, actorId, input.market);
    if (view.destination)
      return turnFor(state, `موقع التسليم لطلب «${view.listingTitle}» مُرسل بالفعل، ويراه مندوب التوصيل المُسنَد لهذا الطلب فقط. لتغييره قل «غيّر موقع التسليم». لم يتغير شيء.`, actorId, input.market);
    return requestLocation(orderId, "BUYER", actorId, input.market, false, "سيصل موقعك إلى مندوب التوصيل المُسنَد لهذا الطلب فقط، ويُحذف بعد انتهاء التوصيل.");
  });
}

/**
 * «أرسل موقع مطعمي للعميل»: the seller's pickup point for a confirmed PICKUP order, seen only by
 * that order's buyer. Returns null when the seller has no such order, so the caller can fall back
 * to the public area through an existing inquiry (never a precise address outside an order).
 */
export function shareBusinessPickupPoint(input: DeliveryTurnInput): Promise<Turn | null> {
  return refusedAsNotice(async () => {
    if (!input.actorId) return null;
    const actorId = input.actorId;
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(orderFulfillments, eq(orderFulfillments.orderId, orders.id))
      .where(and(eq(orders.sellerId, actorId), eq(orders.marketId, input.market.id), eq(orderFulfillments.method, "PICKUP"), inArray(orders.status, ARRANGEABLE)))
      .orderBy(desc(orders.createdAt))
      .limit(10);
    if (!rows.length) return null;
    if (rows.length > 1) return chooseOrder(rows.map((row) => row.id));
    return requestLocation(rows[0]!.id, "SELLER", actorId, input.market, false, "هذا موقع نشاطك العام لاستلام الطلب، ويراه مشتري هذا الطلب فقط. لا تشارك عنوان سكنك الخاص.");
  });
}
