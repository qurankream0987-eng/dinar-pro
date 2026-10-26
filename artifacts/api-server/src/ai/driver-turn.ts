/**
 * Block F4 — the driver capability inside the shared DINAR conversation runtime.
 *
 * Not a driver app or agent: the same account and conversation that buys and sells can
 * register as a driver, state its availability, see open DINAR deliveries and carry one.
 * Every step reads or writes through lib/driver (profile, availability, atomic
 * assignment) and Block D (fulfilment transitions, order handoff). Lists are persisted
 * result sets of kind DRIVER so «الثاني» keeps meaning what was shown; reviews are F0
 * pending actions. No location is read: work is matched by coarse city only.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, db, deliveryAssignments, deliveryProgressEvents, driverProfiles, orderFulfillments, users } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import { publishedListingCities } from "../lib/marketplace-listings";
import { STATUS_LABELS, statusLabel, transitionDelivery, type DeliveryMethod, type DeliveryStatus } from "../lib/delivery";
import {
  DRIVER_FIELD_LABELS,
  DRIVER_STATUS_LABELS,
  VEHICLE_LABELS,
  activeDriverAssignments,
  driverHandoff,
  driverOutForDelivery,
  recordCourierProgress,
  driverProfileFor,
  ensureDriverDraft,
  listDeliveryWork,
  missingDriverFields,
  setDriverAvailability,
  type DeliveryWorkCard,
  type DriverProfileRow,
  type VehicleType,
} from "../lib/driver";
import { confirmPendingAction, createPendingAction, parseCommandNumbers, proposeAction, type ActionReview } from "./action-foundation";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type StoredSet = typeof aiResultSets.$inferSelect;

export const DRIVER_SURFACES = CONVERSATION_SURFACE_FAMILIES.driver;
type DriverSurface = (typeof DRIVER_SURFACES)[number];

const DriverQuery = z
  .object({
    kind: z.literal("DRIVER"),
    ownerId: z.string().min(1),
    view: z.enum(DRIVER_SURFACES),
    city: z.string().max(100).optional(),
    exclude: z.array(z.string().max(200)).max(24).optional(),
  })
  .strict();
type DriverQuery = z.infer<typeof DriverQuery>;

export function isDriverQuery(query: unknown): boolean {
  return (query as { kind?: unknown } | null)?.kind === "DRIVER";
}

/** Work lists and questions are short-lived; status views keep for 30 days. */
export function driverStateExpiry(query: unknown, now = Date.now()): Date | undefined {
  const parsed = DriverQuery.safeParse(query);
  if (!parsed.success) return undefined;
  const short = ["DELIVERY_WORK_RESULTS", "DRIVER_ONBOARDING", "DRIVER_ASSIGNMENT_STATUS"].includes(parsed.data.view);
  return new Date(now + (short ? 30 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000));
}

// ─── Phrases ─────────────────────────────────────────────────────────────────

export function normalizeDriverText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.()«»"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:يا\s+)?دينار|من فضلك|لو سمحت)\s+/u, "")
    .replace(/\s+مع\s+دينار$/u, "");
}

const DRIVER_NOUN = String.raw`(?:سائق|سواق|مندوب(?:\s+توصيل)?|موصل|كابتن)`;
const AS = String.raw`(?:ك\s*)?`;
/** Explicit job-search language belongs to Block C employment, never to driver onboarding. */
const EMPLOYMENT_WORDS = /(?:^|\s)(?:وظيفه|وظائف|وظيفة|الشركات|شركات|شركه|راتب|توظيف|ابحث|دور لي|فرصه عمل)(?:\s|$)/u;
const ONBOARD = [
  new RegExp(String.raw`(?:^|\s)(?:اشتغل|اعمل|اكون|اصير|صير|اصبح|انضم)\s+${AS}${DRIVER_NOUN}(?:\s|$)`, "u"),
  new RegExp(String.raw`(?:^|\s)(?:سجلني|سجل|سجلوني)\s+${AS}${DRIVER_NOUN}(?:\s|$)`, "u"),
  /(?:^|\s)(?:اوصل|اوصل لكم|توصيل)\s+(?:ال)?طلبات(?:\s|$)/u,
  new RegExp(String.raw`كيف\s+(?:اصير|اكون|اصبح|اشتغل|اسجل)\s+${AS}${DRIVER_NOUN}`, "u"),
];

/** Explicit driver-onboarding language must not be claimed by broad job search. */
export function isDriverOnboardingIntent(message: string): boolean {
  const text = normalizeDriverText(message);
  return !EMPLOYMENT_WORDS.test(text) && ONBOARD.some((pattern) => pattern.test(text));
}
const STATUS = new RegExp(
  String.raw`(?:حاله|وضع)\s+(?:تسجيلي|طلبي|ملفي|حسابي)\s+${AS}${DRIVER_NOUN}|(?:حالتي|وضعي)\s+${AS}${DRIVER_NOUN}|هل\s+(?:تم\s+)?(?:اعتمادي|قبولي)\s+${AS}${DRIVER_NOUN}`,
  "u",
);
const AVAILABLE = /^(?:انا\s+)?(?:متاح|جاهز)(?:\s+(?:اليوم|الان|الحين|للتوصيل|كسائق|للطلبات|للعمل))?$/u;
const UNAVAILABLE =
  /^(?:انا\s+)?(?:غير|مو|مش|لست)\s+متاح(?:\s+(?:اليوم|الان|الحين|للتوصيل))?$|^(?:وقفني|اوقفني|وقف استقبال المهام|اوقف استقبال المهام)(?:\s+(?:مؤقت|مؤقتا|اليوم|الان|الحين))?$/u;
const WORK =
  /^(?:(?:اعرض|ورني|وريني|ارني|اعطني|شوف|ابي|اريد)\s+(?:لي\s+)?)?(?:طلبات|مهام|مهمات)\s+(?:ال)?توصيل(?:\s+(?:في|ب)\s+(.+))?$|^(?:(?:اعرض|ورني|وريني|ارني|اعطني)\s+(?:لي\s+)?)?(?:ال)?توصيلات(?:\s+(?:في|ب)\s+(.+))?$/u;
const NEAR = /(?:الاقرب|اقرب|قريبه|القريبه)\s+(?:من\s+|الي\s+)?ل?(?:منطقتي|منطقه عملي|مدينتي)/u;
const EARNINGS_HISTORY =
  /(?:كم\s+(?:ربحت|دخلت)\s+(?:من\s+)?(?:التوصيل|التوصيلات)|(?:ارني|ورني|وريني|اعرض)\s+(?:لي\s+)?توصيلات(?:ي)?\s+(?:السابقة|السابقه)|(?:سجل|تاريخ)\s+(?:ارباح|دخل)\s+(?:التوصيل|التوصيلات))/u;
const ACCEPT = /^(?:اقبل|قبول|خذ|خذلي|ابي|اريد|بدي)\s+(?:لي\s+)?(?:(?:الطلب|المهمه|التوصيل|مهمه)\s+)?(.+)$/u;
const DECLINE = /^(?:تجاهل|اخف|اخفي|لا اريد|لا ابي|ما ابي|ما اريد)\s+(?:(?:الطلب|المهمه)\s+)?(.+)$/u;
const AT_PICKUP = /^(?:انا\s+)?وصلت\s+(?:ل|الي\s+|عند\s+)?(?:مكان|نقطه|موقع)\s+الاستلام$|^وصلت\s+عند\s+البائع$/u;
const PICKED_UP = /^(?:(?:انا\s+)?استلمت(?:\s+(?:الطلب|المهمه|الشحنه|الاغراض))?|استلمت الاغراض من البائع)(?:\s+(.+))?$/u;
const ARRIVED = /^(?:(?:انا\s+)?(?:وصلت|انا)\s+(?:عند|الى|لدى)\s+(?:باب|المشتري|العميل)|وصلت للمشتري|وصلت للعميل(?:\s+في الطلب)?|انا عند الباب)(?:\s+(.+))?$/u;
const OUT = /^(?:(?:انا\s+)?(?:في|بال|على)\s*الطريق|خرجت\s+للتوصيل)(?:\s+(.+))?$/u;
const DELIVERED = /^(?:تم\s+(?:التسليم|التوصيل|تسليم الطلب|توصيل الطلب)|سلمت(?:\s+الطلب)?|وصلت\s+الطلب)(?:\s+(.+))?$/u;
const RELEASE = /^(?:الغ|الغي|الغاء|الغ المهمه|الغاء المهمه|ما اقدر اوصل|لا استطيع التوصيل)$/u;
const CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|ارسل|ارسله|اقبل|قبول)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|تراجع|لا شكرا)$/u;

const VEHICLE_WORDS: [VehicleType, RegExp][] = [
  ["MOTORCYCLE", /(?:دراجه ناريه|موتور|موتوسيكل|ماطور|دباب)/u],
  ["BICYCLE", /(?:دراجه هوائيه|بسكليت|سيكل|دراجه)/u],
  ["CAR", /(?:سياره|سيارتي|بسيارتي|كار|بسياره)/u],
];
const vehicleIn = (text: string) => VEHICLE_WORDS.find(([, pattern]) => pattern.test(text))?.[0];
const fold = (value: string) => normalizeDriverText(value).replace(/^ال/u, "");

/** A coarse city named in the message, from the market's own published cities; the most specific name wins. */
function cityIn(text: string, known: string[]): string | undefined {
  const words = ` ${text} `;
  return [...known].sort((a, b) => b.length - a.length).find((city) => {
    const folded = normalizeDriverText(city);
    return folded.length >= 2 && (words.includes(` ${folded} `) || words.includes(` ب${folded} `) || words.includes(` في ${folded} `));
  });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function profileView(profile: DriverProfileRow | undefined, phoneVerified: boolean, market: Market) {
  if (!profile) return null;
  const missing = missingDriverFields(profile, market);
  const remaining = [
    ...missing.map((field) => DRIVER_FIELD_LABELS[field]!),
    ...(!phoneVerified ? ["توثيق رقم هاتف الحساب"] : []),
    ...(["DRAFT", "PENDING_VERIFICATION"].includes(profile.status) ? ["مراجعة إدارة DINAR"] : []),
  ];
  return {
    id: profile.id,
    marketId: profile.marketId,
    status: profile.status,
    statusLabel: DRIVER_STATUS_LABELS[profile.status],
    availability: profile.availability,
    vehicleType: profile.vehicleType,
    vehicleLabel: profile.vehicleType ? VEHICLE_LABELS[profile.vehicleType as VehicleType] : null,
    serviceCity: profile.serviceCity,
    phoneVerified,
    remaining,
  };
}

function turn(view: DriverSurface, prompt: string, driver: Record<string, unknown>, state?: { query: DriverQuery; resourceIds: string[] }, resultSetId?: string): Turn {
  const id = resultSetId ?? (state ? randomUUID() : undefined);
  return {
    tool: "driver",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: view,
      ...(id ? { resultSetId: id } : {}),
      ...(state ? { resourceIds: state.resourceIds, ...(state.resourceIds.length === 1 ? { resourceId: state.resourceIds[0] } : {}) } : {}),
      query: state?.query ?? {},
      listings: [],
      driver: { view, ...driver },
      prompt,
    },
  };
}

const notice = (prompt: string, view: DriverSurface = "DRIVER_STATUS") => turn(view, prompt, { notice: prompt });

// ─── Steps ───────────────────────────────────────────────────────────────────

type Context = { conversationId: string; market: Market; actorId: string };

async function phoneVerified(actorId: string) {
  const [user] = await db.select({ phoneVerified: users.phoneVerified }).from(users).where(eq(users.id, actorId));
  return Boolean(user?.phoneVerified);
}

async function statusTurn(ctx: Context, lead = ""): Promise<Turn> {
  const profile = await driverProfileFor(ctx.actorId, ctx.market.id);
  if (!profile) return notice(`${lead}لست مسجلًا كسائق في هذا السوق بعد. قل «أريد أشتغل سائق» لبدء التسجيل.`.trim());
  const view = profileView(profile, await phoneVerified(ctx.actorId), ctx.market)!;
  const active = await activeDriverAssignments(ctx.actorId, ctx.market.id);
  const detail =
    profile.status === "APPROVED"
      ? `أنت ${profile.availability === "AVAILABLE" ? "متاح" : "غير متاح"} حاليًا${active.length ? `، ولديك ${active.length} مهمة توصيل نشطة` : ""}.`
      : profile.status === "PENDING_VERIFICATION"
        ? "طلبك بانتظار مراجعة إدارة DINAR؛ لا يُعتمد تلقائيًا."
        : profile.status === "SUSPENDED"
          ? "لا يمكنك استلام مهام توصيل حاليًا."
          : `بقي: ${view.remaining.join("، ")}.`;
  return turn("DRIVER_STATUS", `${lead}حالة تسجيلك كسائق: ${view.statusLabel}. ${detail}`.trim(), { profile: view, activeAssignments: active.length });
}

async function onboardingStep(ctx: Context, text: string, lead = ""): Promise<Turn> {
  const existing = await driverProfileFor(ctx.actorId, ctx.market.id);
  if (existing && existing.status !== "DRAFT") return statusTurn(ctx, "لديك تسجيل كسائق بالفعل. ");
  const [[user], cities] = await Promise.all([
    db.select({ city: users.city }).from(users).where(eq(users.id, ctx.actorId)),
    publishedListingCities(ctx.market.id),
  ]);
  const known = [...new Set([...cities, ...(user?.city ? [user.city] : [])])];
  const vehicle = vehicleIn(text);
  // Facts already known are reused: a city named now, else the account's own city.
  const city = cityIn(text, known) ?? (!existing?.serviceCity && user?.city ? user.city : undefined);
  let profile: DriverProfileRow;
  try {
    profile = (await ensureDriverDraft({ userId: ctx.actorId, market: ctx.market, vehicleType: vehicle, serviceCity: city })).profile;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error) return notice(`${error.message} لم يُنشأ أي تسجيل.`);
    throw error;
  }
  const verified = await phoneVerified(ctx.actorId);
  const missing = missingDriverFields(profile, ctx.market);
  if (missing.length) {
    const ask =
      missing[0] === "vehicleType"
        ? "ما نوع مركبتك؟ سيارة، دراجة نارية، أو دراجة هوائية."
        : `في أي مدينة ستعمل؟${known.length ? ` مثل: ${known.slice(0, 4).join("، ")}.` : ""}`;
    return turn(
      "DRIVER_ONBOARDING",
      `${lead}بدأنا تسجيلك كسائق توصيل في DINAR (الحالة: قيد الإعداد). ${ask}`.trim(),
      { profile: profileView(profile, verified, ctx.market), ask: missing },
      { query: { kind: "DRIVER", ownerId: ctx.actorId, view: "DRIVER_ONBOARDING" }, resourceIds: [profile.id] },
    );
  }
  const review = await createPendingAction({ ...ctx, proposal: proposeAction({ action: "SUBMIT_DRIVER_PROFILE", targetResource: profile.id }) });
  return reviewTurn(ctx, profile, verified, review, lead);
}

function reviewTurn(ctx: Context, profile: DriverProfileRow, verified: boolean, review: ActionReview, lead = ""): Turn {
  const view = profileView(profile, verified, ctx.market)!;
  return turn(
    "DRIVER_ONBOARDING_REVIEW",
    `${lead}راجع تسجيلك كسائق: ${view.vehicleLabel}، مدينة العمل ${view.serviceCity}، السوق ${ctx.market.id}، الهاتف ${verified ? "موثق" : "غير موثق"}. بعد الإرسال يراجعه فريق DINAR ولا يُعتمد تلقائيًا. اكتب «نعم» للإرسال، أو عدّل المركبة أو المدينة، أو «إلغاء».`.trim(),
    { profile: view, actionId: review.actionId, status: "PENDING", actions: ["SUBMIT", "EDIT", "CANCEL"], expiresAt: review.expiresAt },
    undefined,
    review.actionId,
  );
}

async function availabilityTurn(ctx: Context, availability: "AVAILABLE" | "UNAVAILABLE"): Promise<Turn> {
  try {
    const profile = await setDriverAvailability({ userId: ctx.actorId, market: ctx.market, availability });
    const view = profileView(profile, await phoneVerified(ctx.actorId), ctx.market);
    return turn(
      "DRIVER_AVAILABILITY",
      availability === "AVAILABLE"
        ? `أنت متاح الآن لاستلام مهام التوصيل في ${profile.serviceCity}. لا يستخدم DINAR موقعك؛ تظهر لك المهام حسب مدينة عملك. قل «اعرض لي طلبات توصيل».`
        : "أنت غير متاح الآن؛ لن تظهر لك مهام جديدة. مهامك المقبولة تبقى كما هي.",
      { profile: view },
    );
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error)
      return notice(`${error.message} لم يتغير شيء.`, "DRIVER_AVAILABILITY");
    throw error;
  }
}

async function workTurn(ctx: Context, filter: { city?: string; near?: boolean }, exclude: string[] = [], lead = ""): Promise<Turn> {
  const profile = await driverProfileFor(ctx.actorId, ctx.market.id);
  const city = filter.near ? (profile?.serviceCity ?? undefined) : filter.city;
  const work = await listDeliveryWork({ userId: ctx.actorId, market: ctx.market, city, exclude });
  if (work.blocked) return notice(`${lead}${work.blocked}`.trim(), "DELIVERY_WORK_RESULTS");
  const where = city ? `في ${city}` : `في منطقة عملك (${work.serviceCity})`;
  return turn(
    "DELIVERY_WORK_RESULTS",
    `${lead}${
      work.cards.length
        ? `وجدت ${work.cards.length} ${work.cards.length === 1 ? "مهمة توصيل" : "مهام توصيل"} داخل DINAR ${where}. تظهر المناطق التقريبية فقط؛ تفاصيل التسليم تظهر بعد قبول المهمة. قل «أقبل الأول» مثلًا.`
        : `لا توجد مهام توصيل متاحة الآن ${where}.`
    }`.trim(),
    { work: work.cards, city: city ?? null, serviceCity: work.serviceCity ?? null },
    { query: { kind: "DRIVER", ownerId: ctx.actorId, view: "DELIVERY_WORK_RESULTS", ...(city ? { city } : {}), ...(exclude.length ? { exclude } : {}) }, resourceIds: work.cards.map((card) => card.id) },
  );
}

async function assignmentReview(ctx: Context, orderId: string, card: DeliveryWorkCard | undefined): Promise<Turn> {
  let review: ActionReview;
  try {
    review = await createPendingAction({ ...ctx, proposal: proposeAction({ action: "ACCEPT_DELIVERY", targetResource: orderId }) });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error)
      return notice(`${error.message}. لم يتغير شيء؛ قل «اعرض لي طلبات توصيل» لتحديث القائمة.`, "DRIVER_ASSIGNMENT_REVIEW");
    throw error;
  }
  return turn(
    "DRIVER_ASSIGNMENT_REVIEW",
    `مهمة ${card?.reference ?? ""}: «${card?.title ?? ""}» من ${card?.pickup.city ?? ""}${card?.pickup.area ? ` - ${card.pickup.area}` : ""} إلى ${card?.dropoff.city ?? ""}${card?.dropoff.area ? ` - ${card.dropoff.area}` : ""}. اكتب «نعم» لقبولها أو «لا».`,
    { card: card ?? null, actionId: review.actionId, status: "PENDING", actions: ["ACCEPT", "DECLINE"], expiresAt: review.expiresAt },
    undefined,
    review.actionId,
  );
}

async function activeChoice(ctx: Context, phrase: string): Promise<Turn> {
  const active = await activeDriverAssignments(ctx.actorId, ctx.market.id);
  return turn(
    "DRIVER_ASSIGNMENT_STATUS",
    `لديك ${active.length} مهام توصيل نشطة؛ أي مهمة تقصد؟ قل مثلًا «${phrase} الأول». لم يتغير شيء.`,
    { assignments: active.map(assignmentView), ambiguous: true },
    { query: { kind: "DRIVER", ownerId: ctx.actorId, view: "DRIVER_ASSIGNMENT_STATUS" }, resourceIds: active.map((row) => row.orderId) },
  );
}

const assignmentView = (row: { orderId: string; reference: string; title: string; status: string; dropoff: { city: string; area: string } | null }) => ({
  orderId: row.orderId,
  reference: row.reference,
  title: row.title,
  status: row.status,
  statusLabel: statusLabel("COURIER", row.status as DeliveryStatus),
  dropoff: row.dropoff,
});

// ─── Turn ────────────────────────────────────────────────────────────────────

async function recentSets(conversationId: string, marketId: string): Promise<StoredSet[]> {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(12);
}

const live = (set: StoredSet) => !set.expiresAt || set.expiresAt.getTime() > Date.now();
const driverState = (set: StoredSet | undefined, actorId: string, view?: DriverSurface) => {
  const parsed = DriverQuery.safeParse(set?.query);
  return parsed.success && parsed.data.ownerId === actorId && (!view || parsed.data.view === view) && live(set!) ? parsed.data : undefined;
};

/** A position in a persisted list, or undefined when out of range; never a guessed id. */
function pick(set: StoredSet | undefined, message: string): string | undefined {
  if (!set) return undefined;
  const parsed = parseCommandNumbers(message);
  if (parsed.ordinal !== undefined) return set.resourceIds[parsed.ordinal - 1];
  if (parsed.deictic && set.resourceIds.length === 1) return set.resourceIds[0];
  return undefined;
}

const failureNotice = (error: unknown, view: DriverSurface) => {
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status < 500 && error instanceof Error) return notice(`${error.message} لم يتغير شيء.`, view);
  throw error;
};

/**
 * Claims explicit driver phrases, decisions on the actor's own driver review, answers
 * to its own onboarding question, and delivery commands from a driver with active work.
 * Everything else passes on unchanged.
 */
export async function executeDriverTurn(input: { conversationId: string; message: string; market: Market; actorId?: string }): Promise<Turn | null> {
  if (!input.actorId) return null;
  const ctx: Context = { conversationId: input.conversationId, market: input.market, actorId: input.actorId };
  const text = normalizeDriverText(input.message);
  if (EARNINGS_HISTORY.test(text))
    return turn(
      "DRIVER_EARNINGS_HISTORY",
      "هذا سجل التوصيلات المكتملة وعمولاتها المحاسبية. المستحقات غير المحصلة والتسوية التجريبية موضحتان لكل عملية؛ لا يثبت السجل استلام أموال حقيقية.",
      {},
      {
        query: {
          kind: "DRIVER",
          ownerId: input.actorId,
          view: "DRIVER_EARNINGS_HISTORY",
        },
        resourceIds: [],
      },
    );
  const sets = await recentSets(input.conversationId, input.market.id);
  const latest = sets[0];
  const pending = latest?.query as { kind?: unknown; ownerId?: unknown; status?: unknown; action?: unknown; targetResource?: unknown } | undefined;
  const driverPending =
    latest && live(latest) && pending?.kind === "ACTION" && pending.ownerId === ctx.actorId && pending.status === "PENDING" &&
    (pending.action === "SUBMIT_DRIVER_PROFILE" || pending.action === "ACCEPT_DELIVERY")
      ? (pending.action as "SUBMIT_DRIVER_PROFILE" | "ACCEPT_DELIVERY")
      : undefined;

  // ── Decisions on the actor's own latest driver review.
  if (driverPending && (CONFIRM.test(text) || CANCEL.test(text))) {
    const outcome = await confirmPendingAction({ actionId: latest!.id, actorId: ctx.actorId, market: ctx.market, decision: CANCEL.test(text) ? "CANCEL" : "CONFIRM" });
    if (driverPending === "SUBMIT_DRIVER_PROFILE") {
      if (outcome.status === "CONFIRMED" && outcome.result?.status === "PENDING_VERIFICATION")
        return statusTurn(ctx, "أُرسل طلب تسجيلك كسائق للمراجعة. ");
      if (outcome.status === "REVIEW_REQUIRED") {
        const profile = (await driverProfileFor(ctx.actorId, ctx.market.id))!;
        return reviewTurn(ctx, profile, await phoneVerified(ctx.actorId), outcome.review, "تغيّر ملفك منذ المراجعة. ");
      }
      return notice(outcome.status === "CANCELLED" ? "أُلغي إرسال التسجيل؛ بقي ملفك قيد الإعداد ولم يُرسل." : outcome.message, "DRIVER_ONBOARDING_REVIEW");
    }
    if (outcome.status === "CONFIRMED" && outcome.result?.assignmentId) {
      const [row] = (await activeDriverAssignments(ctx.actorId, ctx.market.id)).filter((item) => item.orderId === outcome.result!.orderId);
      return turn(
        "DRIVER_ASSIGNMENT_STATUS",
        `تم قبول مهمة التوصيل ${row?.reference ?? ""}؛ أصبحت مسندة إليك وحدك. تفاصيل التسليم الدقيقة في بطاقة الطلب فقط. عند استلامك الطلب من البائع قل «استلمت الطلب».`,
        { assignments: row ? [assignmentView(row)] : [] },
        { query: { kind: "DRIVER", ownerId: ctx.actorId, view: "DRIVER_ASSIGNMENT_STATUS" }, resourceIds: [String(outcome.result.orderId)] },
      );
    }
    if (outcome.status === "REVIEW_REQUIRED") return assignmentReview(ctx, outcome.review.targetResource, undefined);
    return notice(
      outcome.status === "CANCELLED" ? "تجاهلت هذه المهمة؛ لم يتغير شيء." : `${outcome.message} قل «اعرض لي طلبات توصيل» لتحديث القائمة.`,
      "DRIVER_ASSIGNMENT_REVIEW",
    );
  }

  // ── Edits on the onboarding review, and answers to the onboarding question.
  const onboardingOpen = driverPending === "SUBMIT_DRIVER_PROFILE" || driverState(latest, ctx.actorId, "DRIVER_ONBOARDING");
  if (onboardingOpen && !EMPLOYMENT_WORDS.test(text)) {
    const known = await publishedListingCities(ctx.market.id);
    if (vehicleIn(text) || cityIn(` ${text} `, known) || known.some((city) => fold(city) === fold(text))) {
      if (driverPending)
        await db.update(aiResultSets).set({ query: { ...(latest!.query as object), status: "SUPERSEDED", notice: "استُبدلت بمراجعة أحدث." } }).where(eq(aiResultSets.id, latest!.id));
      const exact = known.find((city) => fold(city) === fold(text));
      return onboardingStep(ctx, exact ? `في ${normalizeDriverText(exact)}` : text);
    }
  }

  if (STATUS.test(text)) return statusTurn(ctx);
  if (!EMPLOYMENT_WORDS.test(text) && ONBOARD.some((pattern) => pattern.test(text))) return onboardingStep(ctx, text);

  const hasProfile = Boolean(await driverProfileFor(ctx.actorId, ctx.market.id));
  if (AVAILABLE.test(text) || UNAVAILABLE.test(text)) {
    if (!hasProfile && AVAILABLE.test(text) && !/(?:توصيل|سائق)/u.test(text)) return null;
    return availabilityTurn(ctx, AVAILABLE.test(text) ? "AVAILABLE" : "UNAVAILABLE");
  }
  const work = text.match(WORK);
  if (work || NEAR.test(text)) {
    if (!hasProfile) return notice("لست مسجلًا كسائق بعد. قل «أريد أشتغل سائق» لبدء التسجيل.", "DELIVERY_WORK_RESULTS");
    return workTurn(ctx, { city: (work?.[1] ?? work?.[2])?.trim(), near: NEAR.test(text) });
  }

  // ── Selection on the latest persisted work list (stable ordinals).
  const workSet = sets.find((set) => driverState(set, ctx.actorId, "DELIVERY_WORK_RESULTS"));
  const workContext = workSet && (latest?.id === workSet.id || driverPending === "ACCEPT_DELIVERY");
  if (workContext) {
    const accept = text.match(ACCEPT);
    const decline = text.match(DECLINE);
    if (accept || decline) {
      const reviewed = driverPending === "ACCEPT_DELIVERY" ? String(pending!.targetResource) : undefined;
      const orderId = pick(workSet, input.message) ?? (parseCommandNumbers(input.message).deictic ? reviewed : undefined);
      if (!orderId) return notice("هذا الرقم غير موجود في قائمة المهام الحالية؛ اختر مهمة ظاهرة.", "DELIVERY_WORK_RESULTS");
      if (decline) {
        const state = driverState(workSet, ctx.actorId)!;
        return workTurn(ctx, { city: state.city }, [...(state.exclude ?? []), orderId], "أخفيت هذه المهمة من قائمتك. ");
      }
      const card = (await listDeliveryWork({ userId: ctx.actorId, market: ctx.market })).cards.find((item) => item.id === orderId);
      return assignmentReview(ctx, orderId, card);
    }
  }

  // ── Delivery commands from a driver who holds active work.
  const isOut = OUT.test(text);
  const isDelivered = DELIVERED.test(text);
  const isPickup = PICKED_UP.test(text);
  const isArrival = ARRIVED.test(text);
  const isAtPickup = AT_PICKUP.test(text);
  const isRelease = RELEASE.test(text) && Boolean(driverState(latest, ctx.actorId, "DRIVER_ASSIGNMENT_STATUS"));
  if (isOut || isDelivered || isPickup || isArrival || isAtPickup || isRelease) {
    const active = await activeDriverAssignments(ctx.actorId, ctx.market.id);
    if (!active.length) return null;
    if (isRelease) {
      const named = parseCommandNumbers(input.message);
      const orderId =
        named.ordinal !== undefined || named.deictic
          ? pick(sets.find((set) => driverState(set, ctx.actorId, "DRIVER_ASSIGNMENT_STATUS")), input.message)
          : active.length === 1
            ? active[0]!.orderId
            : undefined;
      const row = active.find((item) => item.orderId === orderId);
      if (!row) return activeChoice(ctx, "ألغ المهمة");
      const selectedOrderId = row.orderId;
      if (row.status !== "ACCEPTED")
        return notice("المهمة في حالة «خرج للتوصيل»؛ لا يمكن إعادة إسنادها قبل حلّ حيازة الطرد يدويًا مع دعم DINAR. لم يتغير شيء.", "DRIVER_ASSIGNMENT_STATUS");
      const [pickup] = await db.select({ id: deliveryProgressEvents.id }).from(deliveryProgressEvents).where(and(
        eq(deliveryProgressEvents.orderId, selectedOrderId),
        eq(deliveryProgressEvents.type, "PICKED_UP"),
      ));
      if (pickup)
        return notice("استلمت الطرد بالفعل؛ لا يمكن إعادة المهمة ذاتيًا. تواصل مع دعم DINAR لحل الحيازة بأمان. لم يتغير شيء.", "DRIVER_ASSIGNMENT_STATUS");
      try {
        await db.transaction((tx) =>
          transitionDelivery(
            { actorId: ctx.actorId!, orderId: selectedOrderId, to: "FAILED", failureReason: "OTHER", market: ctx.market },
            tx,
          ),
        );
        return notice(`أُعيدت المهمة ${row.reference} إلى المشتري لإعادة ترتيب التوصيل. أُلغي وصولك إلى عنوان التسليم؛ لم يُلغَ الطلب ولم تُنقل أجرة إلى مندوب آخر.`, "DRIVER_ASSIGNMENT_STATUS");
      } catch (error) {
        return failureNotice(error, "DRIVER_ASSIGNMENT_STATUS");
      }
    }
    if (isAtPickup)
      return notice("لا يسجّل DINAR حالة «وصلت لمكان الاستلام»؛ لم يتغير شيء. عند استلامك الطلب من البائع قل «استلمت الطلب».", "DRIVER_ASSIGNMENT_STATUS");
    const listSet = sets.find((set) => driverState(set, ctx.actorId, "DRIVER_ASSIGNMENT_STATUS"));
    const named = parseCommandNumbers(input.message);
    const orderId =
      named.ordinal !== undefined || named.deictic
        ? pick(listSet, input.message)
        : active.length === 1
          ? active[0]!.orderId
          : undefined;
    // Consequential transitions are never guessed between several deliveries.
    if (!orderId || !active.some((row) => row.orderId === orderId))
      return active.length > 1 || named.ordinal !== undefined || named.deictic
        ? activeChoice(ctx, isOut || isPickup ? "استلمت الطلب" : isArrival ? "وصلت عند الباب" : "تم التسليم")
        : notice("لم أحدد المهمة. لم يتغير شيء.", "DRIVER_ASSIGNMENT_STATUS");
    const row = active.find((item) => item.orderId === orderId)!;
    try {
      if (isPickup || isArrival) {
        const result = await recordCourierProgress({
          actorId: ctx.actorId,
          orderId,
          market: ctx.market,
          type: isPickup ? "PICKED_UP" : "ARRIVED",
        });
        const label = isPickup ? "استلام الطلب من البائع" : "وصول المندوب إلى المشتري";
        return turn(
          "DRIVER_ASSIGNMENT_STATUS",
          `${result.changed ? "سُجّل" : "كان مسجلًا بالفعل"} ${label} لمهمة ${row.reference}.`,
          { assignments: [assignmentView(row)] },
          { query: { kind: "DRIVER", ownerId: ctx.actorId, view: "DRIVER_ASSIGNMENT_STATUS" }, resourceIds: [orderId] },
        );
      }
      if (isOut) {
        await driverOutForDelivery({ actorId: ctx.actorId, orderId, market: ctx.market });
        return turn(
          "DRIVER_ASSIGNMENT_STATUS",
          `سُجّل «${STATUS_LABELS.OUT_FOR_DELIVERY}» لمهمة ${row.reference}. عند التسليم قل «تم التسليم».`,
          { assignments: [assignmentView({ ...row, status: "OUT_FOR_DELIVERY" })] },
          { query: { kind: "DRIVER", ownerId: ctx.actorId, view: "DRIVER_ASSIGNMENT_STATUS" }, resourceIds: [orderId] },
        );
      }
      await driverHandoff({ actorId: ctx.actorId, orderId, market: ctx.market });
      const [fulfillment] = await db.select({ status: orderFulfillments.status }).from(orderFulfillments).where(eq(orderFulfillments.orderId, orderId));
      return turn(
        "DRIVER_ASSIGNMENT_STATUS",
        `تم التسليم: سُجّل تسليم مهمة ${row.reference}، وبانتظار تأكيد المشتري للاستلام.`,
        { assignments: [assignmentView({ ...row, status: fulfillment?.status ?? "DELIVERED" })] },
      );
    } catch (error) {
      return failureNotice(error, "DRIVER_ASSIGNMENT_STATUS");
    }
  }
  return null;
}

/** History reload: driver views show the profile, assignment and review as they are now. */
export async function refreshDriverPayload(
  payload: Record<string, unknown>,
  context: { actorId: string; market: Market; query?: unknown; expiresAt?: Date | null },
): Promise<Record<string, unknown>> {
  const driver = { ...((payload.driver ?? {}) as Record<string, unknown>) };
  const profileId = (driver.profile as { id?: unknown } | null | undefined)?.id;
  if (typeof profileId === "string") {
    const [profile] = await db.select().from(driverProfiles).where(and(eq(driverProfiles.id, profileId), eq(driverProfiles.userId, context.actorId)));
    driver.profile = profile ? profileView(profile, await phoneVerified(context.actorId), context.market) : null;
  }
  if (typeof driver.actionId === "string") {
    const stored = context.query as { kind?: unknown; status?: unknown } | undefined;
    let status = stored?.kind === "ACTION" && typeof stored.status === "string" ? stored.status : "EXPIRED";
    if (status === "PENDING" && context.expiresAt && context.expiresAt.getTime() <= Date.now()) status = "EXPIRED";
    driver.status = status === "SUPERSEDED" ? "EXPIRED" : status;
  }
  if (Array.isArray(driver.assignments)) {
    const refreshed = [];
    for (const item of driver.assignments as { orderId: string }[]) {
      const [[assignment], [fulfillment]] = await Promise.all([
        db.select().from(deliveryAssignments).where(and(eq(deliveryAssignments.orderId, item.orderId), eq(deliveryAssignments.driverId, context.actorId))).orderBy(desc(deliveryAssignments.createdAt)).limit(1),
        db.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, item.orderId)),
      ]);
      if (!assignment) continue;
      refreshed.push({
        ...item,
        assignmentStatus: assignment.status,
        status: fulfillment?.status ?? null,
        statusLabel: fulfillment ? statusLabel(fulfillment.method as DeliveryMethod, fulfillment.status as DeliveryStatus) : null,
      });
    }
    driver.assignments = refreshed;
  }
  return driver;
}
