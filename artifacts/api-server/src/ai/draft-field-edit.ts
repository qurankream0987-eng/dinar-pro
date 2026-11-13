/**
 * Explicit conversational edits of a listing draft («الكمية 2», «غيّر العنوان إلى …»,
 * «المدينة إربد», «أضف للوصف أن …», «احذف كلمة … من الوصف», «الوصف: …»).
 *
 * A seller corrects the draft in their own words at any point, not only when that field is
 * being asked. Each edit names its field explicitly, so it can never be mistaken for a search,
 * a memory command or an answer to another question. Values come from the seller's own text.
 */
const TASHKEEL = /[ً-ْٰـ]/g;
const ARABIC_DIGITS: Record<string, string> = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
const clean = (text: string) => text.replace(TASHKEEL, "").replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d).replace(/\s+/g, " ").trim();

const QUANTITY_WORDS: Record<string, number> = {
  واحد: 1, واحدة: 1, واحده: 1, حبة: 1, حبه: 1, قطعة: 1, قطعه: 1,
  اثنين: 2, اثنان: 2, ثنتين: 2, حبتين: 2, قطعتين: 2,
  ثلاث: 3, ثلاثة: 3, ثلاثه: 3, اربع: 4, أربع: 4, اربعة: 4, أربعة: 4, خمس: 5, خمسة: 5, خمسه: 5,
};

/** A quantity stated in words or digits («2», «الكمية 2», «عندي حبتين», «3 قطع»). */
export function statedQuantity(text: string): number | undefined {
  const value = clean(text);
  const digits = value.match(/(?:^|\s)(\d{1,7})(?=\s|$)/);
  if (digits) {
    const n = Number(digits[1]);
    return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000 ? n : undefined;
  }
  for (const word of value.split(" ")) if (QUANTITY_WORDS[word]) return QUANTITY_WORDS[word];
  return undefined;
}

export type DraftFieldEdit =
  | { field: "quantity"; quantity: number }
  | { field: "unlimited" }
  | { field: "title"; value: string }
  | { field: "city"; value: string }
  | { field: "area"; value: string }
  | { field: "descriptionAppend"; value: string }
  | { field: "descriptionRemove"; value: string }
  | { field: "descriptionReplace"; value: string }
  | { field: "contactPhone" }
  | { field: "contactChatOnly" };

const VERB_CHANGE = "(?:غير|عدل|خلي|بدل|حط|اجعل|صحح)";
const TO = "(?:الى|إلى|ل|لـ|ليصير|ليكون|يصير|يكون|:)?";

export function draftFieldEdit(message: string): DraftFieldEdit | undefined {
  const text = clean(message);
  if (!text || text.length > 600) return undefined;
  let m: RegExpMatchArray | null;
  if (/^(?:رقم التواصل|رقم الاعلان|رقم الإعلان|رقمي للاعلان|رقمي للإعلان)\s*(?:هو|:)?\s*\+?[\d\s-]{7,20}$/u.test(text)) return { field: "contactPhone" };
  if (/^(?:التواصل|خلي التواصل|اجعل التواصل)\s+(?:عبر|في|من خلال)?\s*(?:المحادثة|محادثة دينار|الشات)\s*(?:فقط)?$/u.test(text)) return { field: "contactChatOnly" };
  if ((m = text.match(/^(?:الكمية|الكميه|العدد|عدد القطع|عددها|عدده)\s*(?:هي|صارت|صار|=|:)?\s*(.+)$/u))) {
    if (/غير محدود|بدون حد|مفتوح/.test(m[1]!)) return { field: "unlimited" };
    const quantity = statedQuantity(m[1]!);
    return quantity ? { field: "quantity", quantity } : undefined;
  }
  if ((m = text.match(new RegExp(`^(?:${VERB_CHANGE}\\s+)?(?:العنوان|اسم الاعلان|اسم الإعلان|اسم المنتج)\\s*${TO}\\s*(.{3,120})$`, "u")))) {
    if (!/^(?:الى|إلى|:)?\s*$/.test(m[1]!)) return { field: "title", value: m[1]!.replace(/^(?:الى|إلى|:)\s*/u, "").trim() };
  }
  if ((m = text.match(new RegExp(`^(?:${VERB_CHANGE}\\s+)?(?:المدينة|المدينه)\\s*(?:هي|${TO})\\s*(.{2,60})$`, "u"))))
    return { field: "city", value: m[1]!.trim() };
  if ((m = text.match(new RegExp(`^(?:${VERB_CHANGE}\\s+)?(?:المنطقة|المنطقه|الحي)\\s*(?:هي|${TO})\\s*(.{2,80})$`, "u"))))
    return { field: "area", value: m[1]!.trim() };
  if ((m = text.match(/^(?:اضف|أضف|ضيف|زيد|زد|اكتب)\s+(?:لل|ل|على ال|الى ال|إلى ال|في ال)وصف\s*(?:ان|أن|:)?\s*(.{2,500})$/u)))
    return { field: "descriptionAppend", value: m[1]!.trim() };
  if ((m = text.match(/^(?:احذف|شيل|امسح|اشطب)\s+(?:كلمة|كلمه|عبارة|عباره|جملة|جمله)?\s*[«"']?(.{1,120}?)[»"']?\s+من\s+الوصف$/u)))
    return { field: "descriptionRemove", value: m[1]!.trim() };
  // «غيّر الوصف إلى …» / «الوصف: …» replace it; «خلي الوصف أحلى» asks for an improvement, not new text.
  if ((m = text.match(new RegExp(`^(?:(?:${VERB_CHANGE})\\s+الوصف\\s*(?:الى|إلى|:)|الوصف\\s*(?:الجديد)?\\s*:)\\s*(.{10,5000})$`, "u"))))
    if (!/^(?:احلى|أحلى|اوضح|أوضح|افضل|أفضل|اجمل|أجمل|اقصر|أقصر|اطول|أطول)(?:\s|$)/u.test(m[1]!.trim()))
      return { field: "descriptionReplace", value: m[1]!.trim() };
  return undefined;
}

type EditableDraft = {
  title?: string;
  description?: string;
  city?: string;
  area?: string;
  availableQuantity?: string;
  inventoryMode?: "LIMITED" | "UNLIMITED";
};

/** Applies one edit. Returns the Arabic acknowledgement, or a refusal that leaves the draft unchanged. */
export function applyDraftFieldEdit(
  draft: EditableDraft,
  edit: DraftFieldEdit,
  inventory: { allowedModes: readonly string[]; semantics?: string } | undefined,
): { ok: true; ack: string } | { ok: false; reason: string } {
  switch (edit.field) {
    case "quantity":
      if (inventory?.semantics === "SINGLE" && edit.quantity !== 1) return { ok: false, reason: "هذا التصنيف لقطعة واحدة فقط؛ لم أغيّر الكمية." };
      if (inventory && !inventory.allowedModes.includes("LIMITED")) return { ok: false, reason: "هذا التصنيف لا يستخدم كمية محدودة؛ لم أغيّر الكمية." };
      draft.inventoryMode = "LIMITED";
      draft.availableQuantity = String(edit.quantity);
      return { ok: true, ack: `حدّثت الكمية إلى ${edit.quantity}.` };
    case "unlimited":
      if (inventory && !inventory.allowedModes.includes("UNLIMITED")) return { ok: false, reason: "هذا التصنيف يحتاج عددًا محددًا؛ اكتب الكمية رقمًا." };
      draft.inventoryMode = "UNLIMITED";
      delete draft.availableQuantity;
      return { ok: true, ack: "جعلت الكمية غير محدودة." };
    case "title":
      draft.title = edit.value.slice(0, 120);
      return { ok: true, ack: `غيّرت العنوان إلى «${draft.title}».` };
    case "city":
      draft.city = edit.value.slice(0, 100);
      return { ok: true, ack: `حدّثت المدينة إلى ${draft.city}.` };
    case "area":
      draft.area = edit.value.slice(0, 200);
      return { ok: true, ack: `حدّثت المنطقة إلى ${draft.area}.` };
    case "descriptionAppend": {
      const current = draft.description?.trim() ?? "";
      const next = current ? `${current}\n${edit.value}` : edit.value;
      if (next.length > 5000) return { ok: false, reason: "الوصف طويل جدًا؛ اختصره قليلًا ثم أعد المحاولة." };
      draft.description = next;
      return { ok: true, ack: "أضفت ذلك إلى الوصف." };
    }
    case "descriptionRemove": {
      const current = draft.description ?? "";
      const pattern = new RegExp(edit.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu");
      if (!pattern.test(current)) return { ok: false, reason: `لم أجد «${edit.value}» في الوصف؛ لم يتغير شيء.` };
      draft.description = current.replace(pattern, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([،.,])/g, "$1").trim();
      return { ok: true, ack: `حذفت «${edit.value}» من الوصف.` };
    }
    case "descriptionReplace":
      draft.description = edit.value.slice(0, 5000);
      return { ok: true, ack: "استبدلت الوصف بما كتبته." };
    case "contactPhone":
    case "contactChatOnly":
      return { ok: true, ack: "" };
  }
}

/**
 * «لا، خله 14 برو» on a draft titled «آيفون 13 برو»: a correction of the model or number in the
 * title, recognised only when it shares a word with the current title and names no currency (so
 * «خليه 15» stays a price edit). Returns the corrected title, or undefined.
 */
const foldLetters = (value: string) => value.replace(/[أإآ]/gu, "ا").replace(/ة/gu, "ه").replace(/ى/gu, "ي").toLowerCase();
export function titleCorrection(message: string, title: string | undefined): string | undefined {
  if (!title) return undefined;
  let text = message.trim().replace(/[.!؟?]+$/u, "");
  const negated = /^(?:لا|لأ|لاء|مو|مش)[،,\s]+/u.test(text);
  text = text.replace(/^(?:لا|لأ|لاء|مو|مش)[،,\s]+/u, "");
  const verb = /^(?:قصدي|اقصد|أقصد|بل|خله|خليه|خلها|خليها|خلي|خل|غيره|غيرها|صححه|صححها|صحح)\s+/u;
  if (!negated && !verb.test(text)) return undefined;
  const rest = text.replace(verb, "").trim();
  if (rest.length < 3 || rest.length > 40 || !/\d/u.test(rest) || !/[^\d\s]{2,}/u.test(rest)) return undefined;
  if (/(?:دينار|دنانير|jod|kwd|ريال|درهم|ليره|ليرة|سعر|بسعر|بـ?\s*\d)/iu.test(rest)) return undefined;
  const foldedTitle = foldLetters(title);
  const restWords = foldLetters(rest).split(/\s+/u).filter((word) => /[^\d]/u.test(word) && word.length >= 2);
  for (const word of restWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // «13 برو» → «14 برو» (number before the shared word) or «ايفون 13» → «ايفون 14» (after it).
    for (const pattern of [new RegExp(`\\S*\\d\\S*\\s+${escaped}(?=\\s|$)`, "u"), new RegExp(`${escaped}\\s+\\S*\\d\\S*`, "u")]) {
      const match = pattern.exec(foldedTitle);
      if (match) return `${title.slice(0, match.index)}${rest}${title.slice(match.index + match[0].length)}`.replace(/\s+/gu, " ").trim();
    }
  }
  return undefined;
}
