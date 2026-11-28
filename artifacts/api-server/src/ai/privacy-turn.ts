/**
 * Privacy rights in the one DINAR conversation: what DINAR holds about me, export my data,
 * communication and location-sharing preferences, and tracked privacy requests.
 *
 * An intent adapter of product control, not a runtime. Every read and write goes to
 * `lib/privacy-rights.ts` (the same authority as the API) for the signed-in user only. The
 * export needs the account password, which is never typed into the chat: the card opens a
 * compact form that re-authenticates directly against the API. Preference changes are
 * reversible and recorded in the consent ledger; requests are tracked with a status history.
 */
import { createHash, randomUUID } from "node:crypto";
import { ProductControlPayload } from "@workspace/api-zod/conversation-runtime";
import {
  PRIVACY_KIND_LABELS,
  fileUserPrivacyRequest,
  getPrivacyPreferences,
  listOwnPrivacyRequests,
  personalDataSummary,
  privacyResponseDays,
  updatePrivacyPreferences,
} from "../lib/privacy-rights";
import { currentPolicy } from "../lib/policies";
import type { ToolResult } from "./tool-registry";

type Turn = { tool: string; version: number; result: ToolResult };
type Input = { conversationId: string; message: string; actorId: string };
type Notice = Extract<ProductControlPayload, { view: "CONTROL_NOTICE" }>;

const VIEW = /(?:^|\s)(?:ما|ماذا|وش|ايش)?\s*(?:ال)?(?:بيانات|معلومات)\s+(?:التي|اللي|الي)\s+(?:تحتفظ|تحتفظون|تعرف|تعرفون|تخزن|تخزنون|يحفظ|يحتفظ|يعرف)(?:ها)?(?:\s+(?:بها|به))?\s+(?:دينار\s+)?عني|^(?:اعرض|ارني|ورني|وريني|شو|ما)\s+(?:هي\s+)?بياناتي(?:\s+الشخصيه)?$|^(?:مركز|لوحه)\s+(?:ال)?خصوصيه$|^خصوصيتي$|^(?:اعرض|افتح)\s+(?:ال)?خصوصيه$/u;
const EXPORT = /(?:^|\s)(?:صدر|صدري|اصدر|تصدير|نزل|نزلي|انزل|تنزيل|حمل|حملي|احمل|تحميل|ارسل\s+لي|اعطني)\s+(?:لي\s+)?(?:نسخه\s+(?:من\s+)?)?(?:كل\s+|جميع\s+)?(?:بياناتي|البيانات\s+الشخصيه|بياناتي\s+الشخصيه)(?:\s|$)/u;
/** Marketing *messages to me* — never «إعلانات ترويجية لمتجري», which is buying a promotion. */
const MARKETING = /(?:ال)?(?:رسائل|اشعارات|تنبيهات|ايميلات|مراسلات)\s+(?:ال)?(?:تسويقيه|ترويجيه|التسويق|الترويج|العروض)|(?:ال)?عروض\s+(?:ال)?تسويقيه/u;
const STOP = /(?:^|\s)(?:اوقف|اوقفي|وقف|الغ|الغي|امنع|اطفئ|عطل|لا\s+(?:اريد|ابي|ابغي|ترسل))(?:\s|$)/u;
const START = /(?:^|\s)(?:فعل|شغل|اسمح|اوافق\s+علي)(?:\s|$)|(?:^|\s)اسمح\s+ب/u;
const DEVICE_LOCATION = /(?:مشاركه\s+(?:ال)?موقع(?:ي)?|موقع\s+(?:ال)?جهاز(?:ي)?|الموقع\s+الجغرافي|تحديد\s+(?:ال)?موقع)/u;
const NOTIFICATIONS = /(?:^|\s)(?:ال)?(?:اشعارات|تنبيهات|notifications)(?:\s|$)/u;
const SETTING_WORD = /(?:^|\s)(?:تفضيلات|اعدادات|اوقف|فعل|غير|عدل|الغ|الغي|اطفئ)(?:\s|$)/u;
const REQUESTS = /^(?:اعرض\s+|ما\s+|وين\s+)?(?:حاله\s+)?طلبات(?:ي)?\s+(?:ال)?خصوصيه$|^(?:ما|شو)\s+(?:حاله|وضع)\s+طلب(?:ي)?\s+(?:ال)?خصوصيه$/u;
const OBJECTION = /^(?!.*(?:التصنيف|تصنيفي))(?:اعترض|اريد\s+(?:ان\s+)?اعترض|اريد\s+الاعتراض|اعتراض)\s+علي\s+(?:\S+\s*){2,}/u;
const INQUIRY = /^(?:عندي\s+|لدي\s+)?(?:استفسار|سؤال|شكوى)\s+(?:عن|حول|بخصوص|في)\s+(?:ال)?خصوصيه/u;
const CORRECTION = /^(?:اريد\s+)?(?:صحح|اصحح|تصحيح|عدل|تعديل|غير|تغيير)\s+(?:رقم\s+(?:هاتفي|جوالي|الهاتف)|رقمي|بياناتي\s+(?:في|عند)\s+دينار)/u;
const CHANNELS: [keyof NonNullable<Parameters<typeof updatePrivacyPreferences>[1]["marketing"]>, RegExp][] = [
  ["email", /(?:بريد|ايميل|email)/u],
  ["sms", /(?:رسائل\s+نصيه|sms|اس\s+ام\s+اس)/u],
  ["push", /(?:اشعارات\s+(?:ال)?جوال|اشعارات\s+(?:ال)?هاتف|push)/u],
  ["inApp", /(?:داخل\s+(?:ال)?تطبيق)/u],
];

function controlTurn(control: ProductControlPayload, prompt: string): Turn {
  return {
    tool: "productControl",
    version: 1,
    result: { kind: "SURFACE", surface: control.view, resultSetId: randomUUID(), prompt, query: {}, listings: [], control: ProductControlPayload.parse(control) },
  };
}
function notice(title: string, lines: string[], tone: Notice["tone"] = "INFO", options?: Notice["options"]): Turn {
  return controlTurn({ view: "CONTROL_NOTICE", tone, title, lines: lines.slice(0, 6), ...(options?.length ? { options: options.slice(0, 6) } : {}) }, [title, ...lines].join(" "));
}

const PRIVACY_OPTIONS = [
  { label: "صدّر بياناتي", message: "صدّر بياناتي" },
  { label: "تفضيلات التواصل", message: "تفضيلات الإشعارات" },
  { label: "أوقف الرسائل التسويقية", message: "أوقف الرسائل التسويقية" },
  { label: "طلبات الخصوصية", message: "طلبات الخصوصية" },
];

async function summaryTurn(actorId: string): Promise<Turn> {
  const summary = await personalDataSummary(actorId);
  const held = summary.categories.filter((item) => item.count > 0).slice(0, 4).map((item) => `${item.label}: ${item.count}`);
  const marketing = summary.preferences.communications.marketing;
  const anyMarketing = marketing.inApp || marketing.email || marketing.sms || marketing.push;
  return notice("بياناتك في جاسم", [
    `الحساب: ${summary.profile.displayName} · ${summary.profile.phone}${summary.profile.city ? ` · ${summary.profile.city}` : ""}.`,
    held.length ? `${held.join("، ")}.` : "لا توجد سجلات أخرى مرتبطة بحسابك بعد.",
    `الرسائل التسويقية: ${anyMarketing ? "مفعّلة لبعض القنوات" : "متوقفة"} · مشاركة موقع الجهاز: ${summary.preferences.location.deviceLocationSharing === "DISABLED" ? "متوقفة" : "بإذنك في كل مرة"}.`,
    summary.retention.approved ? "مدد الاحتفاظ معتمدة ومنشورة في سياسة الخصوصية." : "مدد الاحتفاظ ما زالت بانتظار المراجعة القانونية؛ لا تُحذف سجلات المعاملات المطلوبة عند حذف الحساب.",
    "يمكنك تعديل اسمك ومدينتك ومنطقتك من الحساب، أو طلب تصحيح غيرها.",
  ], "INFO", PRIVACY_OPTIONS);
}

function exportTurn(): Turn {
  return controlTurn(
    { view: "PRIVACY_EXPORT", status: "AWAITING_REAUTHENTICATION", includes: ["الحساب والتفضيلات", "الإعلانات والطلبات", "رسائلك ومحادثاتك", "ما يتذكره المساعد", "البلاغات والموافقات وطلبات الخصوصية"], notice: "أدخل كلمة المرور في النموذج أدناه (لا تكتبها في المحادثة). تُسلَّم النسخة مباشرة ولا تُحفظ على الخادم." },
    "تصدير بياناتك يتطلب تأكيد كلمة المرور في النموذج المرفق؛ لا تكتبها في المحادثة.",
  );
}

async function preferencesTurn(actorId: string, changed?: string[]): Promise<Turn> {
  const preferences = await getPrivacyPreferences(actorId);
  const marketing = preferences.communications.marketing;
  const onOff = (value: boolean) => (value ? "مفعّلة" : "متوقفة");
  return notice(changed?.length ? "تم تحديث تفضيلاتك" : "تفضيلات التواصل والموقع", [
    "إشعارات الطلبات والدفع والتوصيل والأمان جزء من الخدمة وتصل داخل التطبيق.",
    `الرسائل التسويقية — داخل التطبيق: ${onOff(marketing.inApp)}، البريد: ${onOff(marketing.email)}، الرسائل النصية: ${onOff(marketing.sms)}، إشعارات الجوال: ${onOff(marketing.push)}.`,
    `مشاركة موقع الجهاز: ${preferences.location.deviceLocationSharing === "DISABLED" ? "متوقفة (يبقى الإدخال اليدوي للمدينة والمنطقة)" : "يُطلب إذنك في كل مرة، ولطرف الطلب فقط"}.`,
    "قنوات البريد والرسائل النصية وإشعارات الجوال غير موصولة بعد؛ يُطبَّق اختيارك عند ربطها.",
    ...(changed?.length ? ["سُجّل التغيير في سجل موافقاتك ويمكنك التراجع عنه في أي وقت."] : []),
  ], "INFO", [
    marketing.inApp || marketing.email || marketing.sms || marketing.push
      ? { label: "أوقف الرسائل التسويقية", message: "أوقف الرسائل التسويقية" }
      : { label: "فعّل العروض داخل التطبيق", message: "فعّل الرسائل التسويقية داخل التطبيق" },
    preferences.location.deviceLocationSharing === "DISABLED"
      ? { label: "اسمح بمشاركة الموقع عند الطلب", message: "اسمح بمشاركة موقعي" }
      : { label: "أوقف مشاركة الموقع", message: "أوقف مشاركة موقعي" },
  ]);
}

async function requestsTurn(actorId: string): Promise<Turn> {
  const requests = await listOwnPrivacyRequests(actorId);
  if (!requests.length) return notice("لا توجد طلبات خصوصية", ["لم تقدّم أي طلب بعد. يمكنك طلب تصحيح أو تقديم اعتراض أو استفسار هنا."], "INFO", PRIVACY_OPTIONS.slice(0, 2));
  return notice("طلبات الخصوصية", requests.slice(0, 5).map((item) => `${item.kindLabel} — ${item.statusLabel}${item.outcomeNote ? `: ${item.outcomeNote}` : ""} (${item.createdAt.slice(0, 10)})`));
}

async function fileTurn(input: Input, kind: "OBJECTION" | "INQUIRY" | "CORRECTION"): Promise<Turn> {
  const key = `conv-${createHash("sha256").update(`${input.conversationId}\0${input.message}`).digest("hex").slice(0, 40)}`;
  try {
    const request = await fileUserPrivacyRequest(input.actorId, { kind, details: input.message.slice(0, 2000), idempotencyKey: key }, "CONVERSATION");
    const days = privacyResponseDays();
    return notice(`استلمنا طلبك: ${PRIVACY_KIND_LABELS[kind]}`, [
      `رقم الطلب ${request.id.slice(0, 8)} — الحالة: ${request.statusLabel}.`,
      days ? `يراجعه فريق جاسم، والمدة المستهدفة للرد ${days} يومًا.` : "يراجعه فريق جاسم؛ مدة الرد الرسمية لم تُعتمد بعد.",
      "لم يتغير شيء في بياناتك حتى يُقرر الطلب، وسيظهر القرار وسببه في «طلبات الخصوصية».",
    ], "INFO", [{ label: "طلبات الخصوصية", message: "طلبات الخصوصية" }]);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status && status < 500 && error instanceof Error) return notice("تعذر تسجيل الطلب", [`${error.message} لم يتغير شيء.`], "REFUSED");
    throw error;
  }
}

function channelsIn(text: string) {
  return CHANNELS.filter(([, pattern]) => pattern.test(text)).map(([channel]) => channel);
}

/** Claims only privacy requests it can resolve; everything else returns null. */
export async function executePrivacyTurn(input: Input, text: string): Promise<Turn | null> {
  if (EXPORT.test(text)) return exportTurn();
  if (REQUESTS.test(text)) return requestsTurn(input.actorId);
  if (OBJECTION.test(text)) return fileTurn(input, "OBJECTION");
  if (INQUIRY.test(text)) return fileTurn(input, "INQUIRY");
  if (CORRECTION.test(text)) return fileTurn(input, "CORRECTION");
  const policyVersion = currentPolicy("privacy")?.version;
  if (DEVICE_LOCATION.test(text) && (STOP.test(text) || START.test(text))) {
    const updated = await updatePrivacyPreferences(input.actorId, { deviceLocationSharing: STOP.test(text) ? "DISABLED" : "ASK_EACH_TIME" }, "CONVERSATION", policyVersion);
    return preferencesTurn(input.actorId, updated.changed);
  }
  if (MARKETING.test(text) && (STOP.test(text) || START.test(text))) {
    const stop = STOP.test(text);
    const named = channelsIn(text);
    // Stopping without a channel stops every channel; consent is only ever given per channel.
    const channels = named.length ? named : stop ? (["inApp", "email", "sms", "push"] as const) : (["inApp"] as const);
    const marketing = Object.fromEntries(channels.map((channel) => [channel, !stop]));
    const updated = await updatePrivacyPreferences(input.actorId, { marketing }, "CONVERSATION", policyVersion);
    return preferencesTurn(input.actorId, updated.changed);
  }
  if (NOTIFICATIONS.test(text) && SETTING_WORD.test(text)) return preferencesTurn(input.actorId);
  if (VIEW.test(text)) return summaryTurn(input.actorId);
  return null;
}
