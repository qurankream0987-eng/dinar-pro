/**
 * Universal product control inside the one DINAR conversation: app theme, the account's
 * browsing market, seller-market eligibility, profile name, privacy rights and communication
 * preferences (privacy-turn.ts), and location sharing addressed to a driver or a customer.
 *
 * An intent adapter like the others, not a runtime. It extracts slots from the user's words
 * (a theme value, a country, a recipient) rather than matching fixed sentences, resolves them
 * against server registries, and hands every mutation to an existing authority:
 *  - theme       → a CLIENT action the device applies and acknowledges (nothing server-side)
 *  - market/name → F0 pending actions (owner-bound, expiring, re-validated, executed once)
 *  - location    → the delivery authority (order participants only) or the inquiry authority
 * The model may name a capability (PRODUCT_CAPABILITY_CATALOG); the server re-enters here
 * with that capability's canonical utterance, so a suggestion never executes anything itself.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { countries } from "@workspace/global";
import {
  THEME_LABELS,
  ProductControlPayload,
  type ThemePreferenceValue,
} from "@workspace/api-zod/conversation-runtime";
import { aiResultSets, aiUiBlocks, db, markets, sellerMarketEligibility, users } from "@workspace/db";
import { allMarkets, isMarketAvailable, type marketFor } from "../lib/markets";
import { findPreciseLocationLeak } from "../lib/location-policy";
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";
import {
  confirmPendingAction,
  createPendingAction,
  displayNameProblem,
  marketSwitchKey,
  profileKey,
  type ActionReview,
} from "./action-foundation";
import { shareBusinessPickupPoint, shareLocationWithAssignedDriver } from "./delivery-turn";
import { draftPublicBusinessLocation } from "./inquiry-turn";
import { executeRegisteredTool, type ToolResult } from "./tool-registry";
import { executePrivacyTurn } from "./privacy-turn";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };
type Input = { conversationId: string; message: string; market: Market; actorId?: string };

export const CONTROL_PENDING_ACTIONS = ["SWITCH_MARKET", "UPDATE_DISPLAY_NAME"] as const;

// ─── Text ────────────────────────────────────────────────────────────────────

export function normalizeControlText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .replace(/ة/g, "ه")
    .replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:من فضلك|لو سمحت|رجاء|ممكن|يا دينار|دينار|يا)\s+)+/u, "")
    .replace(/\s+(?:من فضلك|لو سمحت|رجاء|يا دينار)$/u, "");
}

/** A request to act, as opposed to a question about something («ما هو الوضع الداكن؟»). */
const ACT = String.raw`(?:اجعل|اجعله|خل|خلي|خليه|حول|حوله|غير|غيره|بدل|فعل|شغل|اقلب|ارجع|رجع|رجعه|ضع|حط|استخدم|اعتمد|نفذ|انقل|انقلني|حولني|افتح|اريد|ابي|ابغي|ابغى|بدي|ودي|حاب|اود|switch|set|turn|enable|make|use|change|go)`;
const QUESTION = /^(?:ما|ماذا|ماهو|ماهي|شو|وش|ايش|كيف|ليش|لماذا|هل|متي|what|how|why|is|does)(?:\s|$)/u;

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEME_SUBJECT = /(?:^|\s)(?:لل|بال|ال|ل|ب)?(?:وضع|مود|ثيم|مظهر|خلفيه|شاشه|الوان|واجهه|تطبيق)(?:\s|$)|(?:^|\s)(?:mode|theme|appearance)(?:\s|$)/u;
const THEME_VALUES: [ThemePreferenceValue, RegExp][] = [
  ["SYSTEM", /(?:حسب|مثل|نفس|تبع|اعدادات|وضع)\s+(?:ال)?(?:جهاز|نظام|جوال|هاتف|موبايل)|(?:^|\s)(?:تلقائي|التلقائي|اوتوماتيك|system|auto|automatic)(?:\s|$)/u],
  ["DARK", /(?:^|\s)(?:لل|بال|ال|ل|ب)?(?:داكن|دارك|ليلي|مظلم|معتم|اسود|سوداء|غامق)(?:\s|$)|(?:^|\s)dark(?:\s|$)/u],
  ["LIGHT", /(?:^|\s)(?:لل|بال|ال|ل|ب)?(?:فاتح|لايت|نهاري|ابيض|بيضاء|مضيء|مضيئ)(?:\s|$)|(?:^|\s)light(?:\s|$)/u],
];
/** Theme words about something else: other software, or a product the user wants to buy. */
const THEME_ELSEWHERE = /(?:ويندوز|windows|اندرويد|android|ايفون|iphone|ماك|vs\s*code|فيجوال|كروم|chrome|يوتيوب|واتساب|whatsapp|اكسل|excel|ابحث|دور|اشتري|للبيع|قميص|سياره|فستان|لون\s+(?:ال)?(?:منتج|سياره))/u;

export function themeRequest(message: string): ThemePreferenceValue | undefined {
  const text = normalizeControlText(message);
  if (QUESTION.test(text) || THEME_ELSEWHERE.test(text) || text.split(" ").length > 12) return undefined;
  const value = THEME_VALUES.find(([, pattern]) => pattern.test(text))?.[0];
  if (!value) return undefined;
  const acting = new RegExp(`(?:^|\\s)${ACT}(?:\\s|$)`, "u").test(text);
  // «لايت مود», «الوضع الداكن» on their own are a clear setting; anything else needs a verb.
  const bare = /^(?:ال)?(?:وضع\s+)?(?:ال)?(?:داكن|دارك|فاتح|لايت|ليلي|نهاري)(?:\s+(?:مود|mode))?$|^(?:dark|light)\s+mode$/u.test(text);
  return (acting && THEME_SUBJECT.test(text)) || bare ? value : undefined;
}

// ─── Markets ─────────────────────────────────────────────────────────────────

type CountryForm = { form: string; code: string };
const ENGLISH_ALIASES: Record<string, string[]> = { SA: ["saudi", "ksa"], AE: ["uae", "emirates", "dubai"], US: ["usa"], GB: ["uk"] };
/** Short Arabic names a full registry name does not contain («الإمارات», «السعودية»). */
const ARABIC_ALIASES: Record<string, string[]> = { SA: ["السعوديه", "سعوديه", "سعودي", "السعودي"], AE: ["الامارات", "امارات", "اماراتي", "دبي"], OM: ["سلطنه عمان", "عماني"], US: ["امريكا", "امريكي"], GB: ["بريطانيا"] };
/** «عمان» is also Jordan's capital; it never names Oman alone. */
const AMBIGUOUS = new Set(["عمان"]);

const COUNTRY_FORMS: CountryForm[] = (() => {
  const forms: CountryForm[] = [];
  for (const country of countries) {
    const name = foldArabicLetters(country.countryNameAr).replace(/ة/g, "ه").trim();
    const base = name.replace(/^ال/u, "");
    const candidates = new Set([name]);
    if (!name.includes(" ")) {
      candidates.add(base);
      // Nisba adjectives: «الكويت» → «كويتي», «الأردن» → «اردني», «مصر» → «مصري».
      const stem = base.replace(/[هاي]$/u, "");
      candidates.add(`${stem}ي`);
      candidates.add(`ال${stem}ي`);
    }
    for (const alias of ARABIC_ALIASES[country.countryCode] ?? []) candidates.add(alias);
    candidates.add(country.countryNameEn.toLowerCase());
    for (const alias of ENGLISH_ALIASES[country.countryCode] ?? []) candidates.add(alias);
    for (const form of candidates) if (form.length >= 3 && !AMBIGUOUS.has(form)) forms.push({ form, code: country.countryCode });
  }
  // A form two countries share names neither.
  const counts = new Map<string, number>();
  for (const { form } of forms) counts.set(form, (counts.get(form) ?? 0) + 1);
  return forms.filter(({ form }) => counts.get(form) === 1).sort((a, b) => b.form.length - a.form.length);
})();

/** Every country named in the text, in order of appearance (prefixes such as «لل», «بال» allowed). */
export function countriesIn(message: string): string[] {
  const text = ` ${normalizeControlText(message).toLowerCase()} `;
  const found: { code: string; at: number }[] = [];
  for (const { form, code } of COUNTRY_FORMS) {
    const pattern = new RegExp(`(?:\\s)(?:و|ف|ب|ل|لل|بال|وال|فال|في\\s+)?${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s)`, "u");
    const match = pattern.exec(text);
    if (match && !found.some((item) => item.code === code)) found.push({ code, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.code);
}

type MarketIntent = "BROWSE" | "SELL" | "RESIDENCE" | "PICK";
const MARKET_NOUN = /(?:^|\s)(?:ال)?(?:سوق|سوقي|اسواق|عروض|اعلانات|منتجات)(?:\s|$)|(?:^|\s)market(?:\s|$)/u;
/** Selling *in a market* («أريد البيع في الأردن»), not an item for sale («عندي سيارة للبيع في الكويت»). */
const SELL_IN_MARKET = /(?:^|\s)(?:ابيع|البيع|اوسع|توسيع|انقل|ابدا\s+البيع|اعمل\s+كبائع|sell|selling)(?:\s+\S+){0,2}\s+(?:في|ب|داخل|الي|الى|ل|in)(?:\s|$)|(?:^|\s)(?:نشاطي|تجارتي|متجري|مطعمي)\s+(?:الي|الى|في|ل)(?:\s|$)|(?:^|\s)(?:البيع|ابيع)\s+(?:بال|في\s+ال|لل)?سوق/u;
const OWNS_ITEM = /(?:^|\s)(?:عندي|لدي|املك|للبيع)(?:\s|$)/u;
const RESIDENCE_WORDS = /(?:اقامتي|الاقامه|جنسيتي|الجنسيه|بلد\s+(?:حسابي|الحساب|اقامتي)|دوله\s+(?:حسابي|الحساب|الاقامه)|البلد\s+القانوني|بلدي\s+القانوني|الدوله\s+المسجله)/u;
const PICK_MARKET = /^(?:غير|بدل|حول)\s+(?:ال)?سوق(?:ي)?$|^(?:اريد|ابي|ابغي)\s+(?:اغير|ابدل)\s+(?:ال)?سوق(?:ي)?$/u;

export function marketRequest(message: string): { intent: MarketIntent; countries: string[] } | undefined {
  const text = normalizeControlText(message);
  if (PICK_MARKET.test(text)) return { intent: "PICK", countries: [] };
  if (QUESTION.test(text) && !/(?:^|\s)(?:ممكن|اقدر|يمكنني)(?:\s|$)/u.test(text)) return undefined;
  const named = countriesIn(text);
  if (RESIDENCE_WORDS.test(text) && new RegExp(`(?:^|\\s)${ACT}(?:\\s|$)`, "u").test(text)) return { intent: "RESIDENCE", countries: named };
  if (!named.length) return undefined;
  if (SELL_IN_MARKET.test(text) && !OWNS_ITEM.test(text)) return { intent: "SELL", countries: named };
  const acting = new RegExp(`(?:^|\\s)(?:${ACT}|تصفح|اتصفح|اعمل|اشتغل|انتقل|ادخل|اعرض|ورني|وريني)(?:\\s|$)`, "u").test(text);
  return acting && MARKET_NOUN.test(text) ? { intent: "BROWSE", countries: named } : undefined;
}

// ─── Account ─────────────────────────────────────────────────────────────────

const NAME_CHANGE = /^(?:اريد\s+|ابي\s+|ابغي\s+|ممكن\s+)?(?:ان\s+)?(?:غير|اغير|عدل|اعدل|بدل|ابدل|حدث|تغيير|تعديل)\s+(?:اسمي|الاسم|اسم\s+(?:حسابي|الحساب|العرض|المستخدم))(?:\s|$)/u;
const BUSINESS_PROFILE = /(?:غير|عدل|بدل|حدث|تغيير|تعديل|احفظ|سجل)\s+(?:وصف|اسم|ساعات\s+عمل|عنوان|موقع|شعار)\s+(?:مطعمي|متجري|محلي|نشاطي|شركتي|مكتبي|ورشتي|صالوني)/u;
const ACCOUNT_VIEW = /^(?:(?:ارني|ورني|وريني|اعرض|اظهر|شوف)\s+)?(?:بيانات|معلومات|تفاصيل)\s+(?:حسابي|الحساب)$|^(?:افتح|اعرض)\s+(?:ال)?(?:اعدادات|إعدادات)(?:\s+(?:ال)?(?:خصوصيه|حساب|الحساب))?$/u;

/** «غيّر اسمي إلى سارة أحمد» → «سارة أحمد», from the user's own text (letters kept as typed). */
export function requestedDisplayName(message: string): string | undefined {
  const raw = message.trim().replace(/^(?:(?:يا\s+)?دينار[،,\s]+)/u, "");
  const match = raw.match(/(?:اسمي|الاسم|اسم\s+\S+)\s+(?:إلى|الى|ل|لـ|ليصبح|ليكون|يصير|يكون|:|=)\s*(.+)$/u);
  const value = match?.[1]?.replace(/^[«"']|[»"'.!؟?]+$/gu, "").trim();
  return value || undefined;
}

// ─── Location recipients ─────────────────────────────────────────────────────

const SHARE_VERB = /(?:^|\s)(?:ارسل|ابعث|شارك|اعط|وصل|ارسال|مشاركه|send|share)(?:\s|$)/u;
const SELF_PLACE = /(?:^|\s)(?:موقعي|عنواني|مكاني|لوكيشني)(?:\s|$)/u;
const BUSINESS_PLACE = /(?:موقع|عنوان|مكان|لوكيشن)\s+(?:ال)?(?:مطعمي|متجري|محلي|مكتبي|مشغلي|ورشتي|صالوني|شركتي|نشاطي|مطعم|متجر|محل|معرضي|عيادتي)/u;
const HOME_PLACE = /(?:موقع|عنوان|مكان)\s+(?:بيتي|منزلي|سكني|شقتي|البيت|المنزل)/u;
const TO_DRIVER = /(?:^|\s)(?:لل|الى\s+ال|الي\s+ال|ل)(?:سائق|سواق|مندوب|كابتن|موصل|دليفري|ديلفري)/u;
const TO_CUSTOMER = /(?:^|\s)(?:لل|الى\s+ال|الي\s+ال|ل)(?:عميل|زبون|زبائن|مشتري|زائر|عملاء)/u;

type LocationRoute = "DRIVER" | "BUSINESS" | "HOME_TO_CUSTOMER";
export function locationRecipientRequest(message: string): LocationRoute | undefined {
  const text = normalizeControlText(message);
  if (QUESTION.test(text) || !SHARE_VERB.test(text)) return undefined;
  if (HOME_PLACE.test(text) && TO_CUSTOMER.test(text)) return "HOME_TO_CUSTOMER";
  if (BUSINESS_PLACE.test(text)) return "BUSINESS";
  if (SELF_PLACE.test(text) && TO_DRIVER.test(text)) return "DRIVER";
  return undefined;
}

// ─── Turns ───────────────────────────────────────────────────────────────────

function controlTurn(
  surface: ProductControlPayload["view"],
  control: ProductControlPayload,
  prompt: string,
  options: { resultSetId?: string; query?: Record<string, unknown> } = {},
): Turn {
  return {
    tool: "productControl",
    version: 1,
    result: {
      kind: "SURFACE",
      surface,
      resultSetId: options.resultSetId ?? randomUUID(),
      prompt,
      query: options.query ?? {},
      listings: [],
      control: ProductControlPayload.parse(control),
    },
  };
}

function notice(title: string, lines: string[], tone: "INFO" | "UNAVAILABLE" | "REFUSED" = "INFO", options?: { label: string; message: string }[]): Turn {
  return controlTurn("CONTROL_NOTICE", { view: "CONTROL_NOTICE", tone, title, lines, ...(options?.length ? { options } : {}) }, [title, ...lines].join(" "));
}

const refusal = (error: unknown): string | undefined => {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status < 500 && error instanceof Error ? error.message : undefined;
};

function themeTurn(actorId: string, theme: ThemePreferenceValue): Turn {
  const label = THEME_LABELS[theme];
  const resultSetId = randomUUID();
  // Success is never claimed here: the card reports «تم» only after the device applied it.
  return controlTurn(
    "APP_THEME",
    { view: "APP_THEME", clientAction: { type: "SET_THEME", theme }, status: "REQUESTED", label },
    `${label}.`,
    { resultSetId, query: { kind: "CONTROL", ownerId: actorId, view: "APP_THEME", theme, status: "REQUESTED" } },
  );
}

type MarketRef = { marketId: string; countryNameAr: string; currencyCode: string };
const refOf = (market: Pick<Market, "id" | "countryNameAr" | "currencyCode">): MarketRef => ({ marketId: market.id, countryNameAr: market.countryNameAr, currencyCode: market.currencyCode });

async function availableMarketOptions(exclude: string) {
  const rows = (await allMarkets()).filter((row) => row.id !== exclude && isMarketAvailable(row));
  return rows.slice(0, 6).map((row) => ({ label: `سوق ${row.countryNameAr}`, message: `حوّل سوقي إلى ${row.countryNameAr}` }));
}

async function marketTurn(input: Input & { actorId: string }, request: { intent: MarketIntent; countries: string[] }): Promise<Turn> {
  const current = input.market;
  if (request.intent === "RESIDENCE")
    return notice("بلد الحساب لا يتغير من المحادثة", [
      "بلد حسابك وإقامتك وبياناتك القانونية ليست إعداد تصفح، ولا يغيّرها جاسم بناءً على طلب في المحادثة.",
      "يمكنك تغيير السوق الذي تتصفحه فقط، مثل «حوّل سوقي إلى الكويت».",
    ], "REFUSED");
  const code = request.countries.filter((value) => value !== current.id).at(-1) ?? request.countries.at(-1)!;
  const country = countries.find((item) => item.countryCode === code)!;
  const [row] = await db.select().from(markets).where(eq(markets.id, code));
  const resolved = row ? (await allMarkets()).find((item) => item.id === row.id) : undefined;
  if (!resolved || !isMarketAvailable(resolved)) {
    const options = await availableMarketOptions(current.id);
    return notice(`سوق ${country.countryNameAr} غير متاح في جاسم حاليًا`, [
      resolved ? "هذا السوق غير مفعّل للتصفح بعد." : "لا يوجد سوق جاسم لهذه الدولة حتى الآن.",
      "لم يتغير سوقك ولا أسعارك.",
    ], "UNAVAILABLE", options);
  }
  if (request.intent === "SELL") return sellerEligibilityTurn(input, resolved);
  const [actor] = await db.select({ activeMarketId: users.activeMarketId }).from(users).where(eq(users.id, input.actorId));
  if (resolved.id === current.id && actor?.activeMarketId === current.id)
    return notice(`أنت تتصفح سوق ${resolved.countryNameAr} بالفعل`, [`الأسعار معروضة بعملة ${resolved.currencyCode}. لم يتغير شيء.`]);
  try {
    const review = await createPendingAction({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: current,
      proposal: {
        action: "SWITCH_MARKET",
        targetResource: marketSwitchKey(current.id, resolved.id),
        structuredInput: {
          fromName: { value: current.countryNameAr, source: "SERVER_FACT" },
          toName: { value: resolved.countryNameAr, source: "SERVER_FACT" },
          toCurrency: { value: resolved.currencyCode, source: "SERVER_FACT" },
        },
        missingFields: [],
        requiresConfirmation: true,
      },
    });
    return marketReviewTurn(review, refOf(current), refOf(resolved));
  } catch (error) {
    const message = refusal(error);
    if (message) return notice("تعذر تجهيز تغيير السوق", [`${message}. لم يتغير شيء.`], "REFUSED");
    throw error;
  }
}

const MARKET_UNCHANGED = ["طلباتك السابقة تبقى في سوقها وبعملتها الأصلية", "لا يتغير بلد حسابك ولا أهلية البيع"];

function marketReviewTurn(review: ActionReview, from: MarketRef, to: MarketRef): Turn {
  return controlTurn(
    "MARKET_SWITCH_REVIEW",
    { view: "MARKET_SWITCH_REVIEW", status: "AWAITING_CONFIRMATION", from, to, unchanged: MARKET_UNCHANGED },
    `تحويل سوق التصفح من ${from.countryNameAr} إلى ${to.countryNameAr}؟ أكّد أو ألغِ.`,
    { resultSetId: review.actionId, query: { kind: "ACTION_REVIEW" } },
  );
}

/** Selling in a market is the seller-eligibility authority's decision; nothing changes here. */
async function sellerEligibilityTurn(input: Input & { actorId: string }, target: Market): Promise<Turn> {
  const switchOption = target.id === input.market.id ? [] : [{ label: `حوّل سوقي إلى ${target.countryNameAr}`, message: `حوّل سوقي إلى ${target.countryNameAr}` }];
  if (target.sellerEligibilityMode !== "APPROVAL_REQUIRED")
    return notice(`البيع في سوق ${target.countryNameAr} متاح دون موافقة مسبقة`, [
      "تنشر إعلاناتك في السوق الذي تتصفحه، وتُسعّر بعملته " + `(${target.currencyCode}).`,
      "تبقى قواعد السوق والتصنيفات المحظورة سارية عند النشر. لم يتغير شيء بعد.",
    ], "INFO", switchOption);
  const [approved] = await db
    .select({ approved: sellerMarketEligibility.approved })
    .from(sellerMarketEligibility)
    .where(and(eq(sellerMarketEligibility.userId, input.actorId), eq(sellerMarketEligibility.marketId, target.id), eq(sellerMarketEligibility.approved, true)));
  return approved
    ? notice(`أنت مؤهل للبيع في سوق ${target.countryNameAr}`, ["أهليتك معتمدة لهذا السوق. لم يتغير شيء بعد."], "INFO", switchOption)
    : notice(`البيع في سوق ${target.countryNameAr} يتطلب موافقة على أهلية البائع`, [
        "لا يمكن النشر أو استقبال الطلبات هناك قبل اعتماد أهليتك من إدارة السوق.",
        "يمكنك التصفح في هذا السوق، لكن جاسم لا يمنح أهلية البيع من المحادثة. لم يتغير شيء.",
      ], "REFUSED", switchOption);
}

async function displayNameTurn(input: Input & { actorId: string }): Promise<Turn> {
  const wanted = requestedDisplayName(input.message);
  const [actor] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, input.actorId));
  if (!wanted)
    return notice("ما الاسم الجديد؟", [`اسمك الحالي «${actor?.displayName ?? ""}». اكتب مثلًا «غيّر اسمي إلى سارة أحمد». لم يتغير شيء.`]);
  const problem = displayNameProblem(wanted);
  if (problem) return notice("لا يمكن اعتماد هذا الاسم", [`${problem}. لم يتغير شيء.`], "REFUSED");
  if (wanted.trim() === actor?.displayName) return notice("هذا اسمك الحالي بالفعل", ["لم يتغير شيء."]);
  try {
    const review = await createPendingAction({
      conversationId: input.conversationId,
      actorId: input.actorId,
      market: input.market,
      proposal: {
        action: "UPDATE_DISPLAY_NAME",
        targetResource: profileKey(input.actorId, input.market.id),
        structuredInput: {
          displayName: { value: wanted.trim(), source: "USER_DECLARED" },
          before: { value: actor?.displayName ?? "", source: "SERVER_FACT" },
        },
        missingFields: [],
        requiresConfirmation: true,
      },
    });
    return controlTurn(
      "PROFILE_REVIEW",
      { view: "PROFILE_REVIEW", status: "AWAITING_CONFIRMATION", field: "displayName", fieldLabel: "الاسم", before: actor?.displayName ?? "", after: wanted.trim() },
      `تغيير اسمك إلى «${wanted.trim()}»؟ أكّد أو ألغِ.`,
      { resultSetId: review.actionId, query: { kind: "ACTION_REVIEW" } },
    );
  } catch (error) {
    const message = refusal(error);
    if (message) return notice("تعذر تجهيز تغيير الاسم", [`${message}. لم يتغير شيء.`], "REFUSED");
    throw error;
  }
}

async function locationTurn(input: Input & { actorId: string }, route: LocationRoute): Promise<Turn | null> {
  if (route === "HOME_TO_CUSTOMER")
    return notice("لن أرسل عنوان سكنك لعميل", [
      "عنوان المنزل خاص؛ لا يرسله جاسم للعملاء عبر الرسائل.",
      "لاستلام طلب مؤكد يمكنك تحديد نقطة استلام عامة داخل الطلب نفسه. لم يُشارك أي موقع.",
    ], "REFUSED");
  if (route === "DRIVER") return shareLocationWithAssignedDriver(input);
  // A typed precise address never goes to a customer outside an order.
  if (findPreciseLocationLeak(input.message))
    return notice("لن أرسل عنوانًا دقيقًا عبر الرسائل", ["العنوان الدقيق يُشارك فقط كنقطة استلام داخل طلب مؤكد. لم يُرسل شيء."], "REFUSED");
  return (await shareBusinessPickupPoint(input)) ?? draftPublicBusinessLocation(input);
}

// ─── Confirmations ───────────────────────────────────────────────────────────

const CONFIRM = /^(?:نعم|اي|ايوه|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نفذ|اعتمد|حول|غير|نعم\s+(?:حول|غير|اكد|نفذ)(?:\s+(?:السوق|الاسم))?|اكد\s+(?:التحويل|التغيير|السوق|الاسم))$/u;
const CANCEL = /^(?:لا|كلا|الغ|الغي|الغاء|تراجع|لا\s+شكرا|لا\s+تغير|لا\s+تحول)$/u;

/** The newest step in this conversation, if it is one of this adapter's pending reviews. */
async function latestControlAction(conversationId: string, actorId: string) {
  const [latest] = await db
    .select()
    .from(aiResultSets)
    .where(eq(aiResultSets.conversationId, conversationId))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  const query = latest?.query as { kind?: string; ownerId?: string; action?: string; status?: string; targetResource?: string; structuredInput?: Record<string, { value: unknown }> } | undefined;
  if (!latest || query?.kind !== "ACTION" || query.ownerId !== actorId || !(CONTROL_PENDING_ACTIONS as readonly string[]).includes(String(query.action))) return undefined;
  return { set: latest, query };
}

async function decide(input: Input & { actorId: string }, decision: "CONFIRM" | "CANCEL"): Promise<Turn | null> {
  const pending = await latestControlAction(input.conversationId, input.actorId);
  if (!pending) return null;
  // A settled review answers a repeated «نعم» (idempotent) only while its card is still the newest.
  if (pending.query.status !== "PENDING") {
    const [block] = await db.select({ payload: aiUiBlocks.payload }).from(aiUiBlocks).where(eq(aiUiBlocks.conversationId, input.conversationId)).orderBy(desc(aiUiBlocks.createdAt)).limit(1);
    if (!(block?.payload as { control?: unknown } | undefined)?.control) return null;
    return notice("تمت معالجة هذا الطلب من قبل", ["لم يتغير شيء."]);
  }
  const values = Object.fromEntries(Object.entries(pending.query.structuredInput ?? {}).map(([key, fact]) => [key, fact.value]));
  const outcome = await confirmPendingAction({ actionId: pending.set.id, actorId: input.actorId, market: input.market, decision });
  const status = outcome.status === "CONFIRMED" ? "SUCCEEDED" : outcome.status === "CANCELLED" ? "CANCELLED" : outcome.status === "EXPIRED" ? "EXPIRED" : "FAILED";
  if (pending.query.action === "SWITCH_MARKET") {
    const [, from, to] = /^market:([^>]+)>(.+)$/.exec(pending.query.targetResource ?? "") ?? [];
    const all = await allMarkets();
    const fromRow = all.find((row) => row.id === from);
    const toRow = all.find((row) => row.id === to);
    if (!fromRow || !toRow) return notice("تعذر قراءة السوق", ["لم يتغير شيء."], "REFUSED");
    const message =
      status === "SUCCEEDED"
        ? `أصبح سوق التصفح ${toRow.countryNameAr}، والأسعار بعملة ${toRow.currencyCode}.`
        : status === "CANCELLED"
          ? "أُلغي تغيير السوق. لم يتغير شيء."
          : outcome.message;
    return controlTurn(
      "MARKET_SWITCH_STATUS",
      { view: "MARKET_SWITCH_STATUS", status, from: refOf(fromRow), to: refOf(toRow), unchanged: status === "SUCCEEDED" ? MARKET_UNCHANGED : [], notice: message },
      message,
    );
  }
  const after = String(values.displayName ?? "");
  const message =
    status === "SUCCEEDED" ? `أصبح اسمك «${after}».` : status === "CANCELLED" ? "أُلغي تغيير الاسم. لم يتغير شيء." : outcome.message;
  return controlTurn(
    "PROFILE_STATUS",
    { view: "PROFILE_STATUS", status, field: "displayName", fieldLabel: "الاسم", before: String(values.before ?? ""), after, notice: message },
    message,
  );
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function executeProductControlTurn(input: Input): Promise<Turn | null> {
  const text = normalizeControlText(input.message);
  if (!text) return null;
  const theme = themeRequest(input.message);
  // Appearance is a device preference: guests and signed-in users alike.
  if (theme) return themeTurn(input.actorId ?? "GUEST", theme);
  if (!input.actorId) return null;
  const actor = { ...input, actorId: input.actorId };

  if (CONFIRM.test(text) || CANCEL.test(text)) return decide(actor, CONFIRM.test(text) ? "CONFIRM" : "CANCEL");

  const location = locationRecipientRequest(input.message);
  if (location) return locationTurn(actor, location);

  const market = marketRequest(input.message);
  // «غيّر السوق» with no country opens the existing market selector workflow (intent.ts MARKET).
  if (market && market.intent !== "PICK") return marketTurn(actor, market);

  if (NAME_CHANGE.test(text)) return displayNameTurn(actor);
  if (BUSINESS_PROFILE.test(text))
    return notice("بيانات نشاطك في بطاقة جاسم بزنس", [
      "وصف نشاطك وساعات عمله وعنوانه تُعدّل من بطاقة جاسم بزنس؛ وصف كل إعلان يُعدّل من الإعلان نفسه.",
      "لم يتغير شيء.",
    ], "UNAVAILABLE", [{ label: "اعرض نشاطي", message: "اعرض نشاطي" }, { label: "اعرض إعلاناتي", message: "اعرض إعلاناتي" }]);
  if (ACCOUNT_VIEW.test(text)) {
    const surface = /اعدادات/u.test(text) ? "SETTINGS" : "ACCOUNT";
    return executeRegisteredTool("openSurface", JSON.stringify({ surface }), { conversationId: input.conversationId, market: input.market, actorId: input.actorId });
  }
  // Privacy rights and communication/location preferences (lib/privacy-rights authority).
  return executePrivacyTurn({ conversationId: input.conversationId, message: input.message, actorId: input.actorId }, text);
}

// ─── History and client acknowledgement ──────────────────────────────────────

const REVIEW_STATUS: Record<string, "AWAITING_CONFIRMATION" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED"> = {
  PENDING: "AWAITING_CONFIRMATION",
  EXECUTING: "AWAITING_CONFIRMATION",
  CONFIRMED: "SUCCEEDED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  SUPERSEDED: "EXPIRED",
  REJECTED: "FAILED",
};

/**
 * History reload: a theme card shows the device's recorded acknowledgement, a market or
 * profile review shows its pending action's real status (expired once its time has passed).
 * Anything that no longer parses is dropped rather than shown as it was.
 */
export async function refreshControlPayload(payload: unknown, resultSetId: string, conversationId: string): Promise<ProductControlPayload | undefined> {
  const parsed = ProductControlPayload.safeParse(payload);
  if (!parsed.success) return undefined;
  const control = parsed.data;
  if (control.view !== "APP_THEME" && control.view !== "MARKET_SWITCH_REVIEW" && control.view !== "PROFILE_REVIEW") return control;
  const [set] = await db
    .select({ query: aiResultSets.query, expiresAt: aiResultSets.expiresAt })
    .from(aiResultSets)
    .where(and(eq(aiResultSets.id, resultSetId), eq(aiResultSets.conversationId, conversationId)));
  const status = String((set?.query as { status?: unknown } | undefined)?.status ?? "");
  if (control.view === "APP_THEME")
    return { ...control, status: status === "APPLIED" || status === "FAILED" ? status : control.status };
  const mapped = REVIEW_STATUS[status] ?? "EXPIRED";
  const expired = mapped === "AWAITING_CONFIRMATION" && status === "PENDING" && (!set?.expiresAt || set.expiresAt.getTime() <= Date.now());
  return { ...control, status: expired ? "EXPIRED" : mapped };
}

/**
 * The device's own report that it applied (or could not apply) a requested theme. Recorded
 * once, only by the request's owner; a repeated or late report returns the recorded outcome.
 */
export async function acknowledgeClientAction(input: { conversationId: string; resultSetId: string; actorId: string; status: "APPLIED" | "FAILED" }) {
  return db.transaction(async (tx) => {
    const [set] = await tx
      .select()
      .from(aiResultSets)
      .where(and(eq(aiResultSets.id, input.resultSetId), eq(aiResultSets.conversationId, input.conversationId)))
      .for("update");
    const query = set?.query as { kind?: string; ownerId?: string; view?: string; status?: string } | undefined;
    if (!set || query?.kind !== "CONTROL" || query.view !== "APP_THEME" || query.ownerId !== input.actorId)
      throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    if (query.status !== "REQUESTED") return { status: query.status as "APPLIED" | "FAILED" };
    await tx.update(aiResultSets).set({ query: { ...query, status: input.status } }).where(eq(aiResultSets.id, set.id));
    return { status: input.status };
  });
}
