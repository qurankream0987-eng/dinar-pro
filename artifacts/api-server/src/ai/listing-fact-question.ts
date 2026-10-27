/**
 * A question about a recorded characteristic of the listing in view («هذا الأول كم ماشي؟»,
 * «هل تعمل 8 ساعات متواصلة؟», «كم غرفة نوم فيها؟», «هل هذا شتوي؟»).
 *
 * The answer comes from the record only. When the seller recorded nothing, DINAR says so
 * plainly and offers the existing inquiry review so the buyer can ask — the model is never
 * asked and no value is guessed.
 *
 * Nothing here knows a product. Detection is a rule about Arabic question forms. The facts
 * DINAR can name come from two data sources only: the curated spec vocabularies below (mileage,
 * operating hours, inspection) and the category registry (marketplace_categories.attributes:
 * label, key, options) of the listing's own category. Recorded values are quoted as recorded;
 * a registered characteristic the seller left empty, or a question no recorded field explains,
 * becomes the same unsent inquiry review. A question the layer does not recognise keeps the
 * ordinary conversation path.
 */
import { and, eq } from "drizzle-orm";
import { db, offers } from "@workspace/db";
import type { CategoryAttributeDefinition } from "@workspace/api-zod/marketplace-schemas";
import type { marketFor } from "../lib/markets";
import {
  categoryById,
  categorySchema,
  listMarketplaceCategories,
} from "../lib/marketplace-categories";
import type { ToolResult } from "./tool-registry";
import { latestListingSet, normalizeBuyerText, notice } from "./buyer-turn";
import { draftListingQuestion } from "./inquiry-turn";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

const ORDINALS: Record<string, number> = {
  الاول: 1, اول: 1, الاولي: 1, الثاني: 2, ثاني: 2, الثانيه: 2, الثالث: 3, ثالث: 3, الثالثه: 3,
  الرابع: 4, الرابعه: 4, الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6,
};
const DEICTIC = new Set(["هذا", "هذه", "هذي", "هال", "هاي"]);

const MILEAGE_QUESTION =
  /(?:^|\s)(?:كم|قديش|قد\s+ايش|شكد)\s+(?:ال)?(?:ممشى|ممشي|ماشي|ماشيه|عداد|العداد|عدادها)(?:\s|$)/u;
/** «هل تعمل 8 ساعات متواصلة؟», «هل تشتغل 8 ساعات؟», «كم ساعة تشتغل؟», «كم ساعات التشغيل؟». */
const OPERATING_HOURS_QUESTION =
  /(?:(?:^|\s)(?:هل\s+)?(?:تعمل|تشتغل|يعمل)\s+[\s\S]{0,40}?(?:ساعه|ساعات))|(?:(?:^|\s)(?:كم|قديش|شكد)\s+(?:ساعه|ساعات)\s+(?:ال)?(?:تشتغل|تعمل|تشغيل|عمل|متواصل|متواصله)(?:\s|$))/u;
/** «هل عليها فحص؟», «هل تم فحصها؟», «هل الفحص شامل؟» — a yes/no inspection question. */
const INSPECTION_QUESTION = /(?:^|\s)هل\s+[\s\S]{0,40}?(?:فحص|مفحوص|فاحص)/u;

/**
 * A bare number in a fact question is usually the spec itself («8 ساعات», «220 فولت»), so only
 * ordinal words name a position; a deictic or a single listing in view needs no position.
 */
function positionIn(words: string[], count: number): number | undefined {
  for (const word of words) {
    const position = ORDINALS[word];
    if (position !== undefined) return position;
  }
  if (words.some((word) => DEICTIC.has(word))) return 1;
  return count === 1 ? 1 : undefined;
}

function attributeValue(attributes: unknown, keys: readonly string[]): string | undefined {
  if (!attributes || typeof attributes !== "object") return undefined;
  const record = attributes as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value.toLocaleString("en-US");
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "boolean") return value ? "نعم" : "لا";
  }
  return undefined;
}

/** The curated spec vocabularies: Arabic question forms mapped to the keys they ask about. */
type Fact = {
  test: RegExp;
  /** The value the seller recorded, formatted for the reply; undefined when nothing was recorded. */
  read: (attributes: unknown) => string | undefined;
  missing: (title: string) => string;
  answer: (title: string, value: string) => string;
  /** The drafted message for the seller; the default scopes the buyer's own question to the listing. */
  draft?: (title: string, question: string) => string;
};

const FACTS: readonly Fact[] = [
  {
    test: MILEAGE_QUESTION,
    read: (attributes) => attributeValue(attributes, ["mileage"]),
    missing: (title) => `لم يذكر البائع الممشى في إعلان «${title}». جهّزت سؤالًا للبائع:`,
    answer: (title, value) =>
      `ممشى «${title}» حسب سجل الإعلان: ${value} كم. هذه معلومة من الإعلان نفسه، ولم أفترض غيرها.`,
    draft: (title) => `كم ممشى «${title}»؟`,
  },
  {
    test: OPERATING_HOURS_QUESTION,
    read: (attributes) => attributeValue(attributes, ["operatingHours", "operating_hours"]),
    missing: (title) =>
      `لم يذكر البائع ساعات التشغيل المتواصل في إعلان «${title}»، فلا أستطيع تأكيدها. جهّزت سؤالًا للبائع:`,
    answer: (title, value) =>
      `ساعات التشغيل المتواصل حسب سجل الإعلان: ${value} ساعة. هذه معلومة من الإعلان نفسه، ولم أفترض غيرها.`,
  },
  {
    test: INSPECTION_QUESTION,
    read: (attributes) => attributeValue(attributes, ["inspection", "inspectionResult", "inspected"]),
    missing: (title) =>
      `لا يسجّل إعلان «${title}» نتيجة فحص، ولم يذكر البائع شيئًا عن الفحص، فلا أستطيع تأكيده. جهّزت سؤالًا للبائع:`,
    answer: (title, value) =>
      `ما يسجّله البائع عن الفحص في «${title}»: «${value}». هذه صياغة البائع، ولم أضف شروطًا من عندي.`,
  },
];

// ─── Arabic question shape (no product knowledge) ───────────────────────────

/** The message asks something, rather than stating or requesting. */
const QUESTION = /^(?:(?:يا\s+)?دينار\s+)?(?:(?:لو\s+سمحت|من\s+فضلك|ممكن|طيب)\s+)?(?:هل|كم|قديش|قد\s+ايش|شكد|وش|شو|ايش|ما|ماذا)(?:\s|$)/u;
/** «هل يوجد/توجد/في …» asks whether a listing exists: a search, not a characteristic. */
const EXISTENTIAL = /^(?:(?:يا\s+)?دينار\s+)?(?:(?:لو\s+سمحت|من\s+فضلك|ممكن|طيب)\s+)?هل\s+(?:يوجد|توجد|في|فيه|فيها|عندك|عندكم|لديك|لديكم)(?:\s|$)/u;

const LEAD_WORDS = new Set(["هل", "كم", "قديش", "قد", "شكد", "وش", "شو", "ايش", "ما", "ماذا", "يا", "دينار", "لو", "سمحت", "فضلك", "ممكن", "تكفي", "طيب"]);
const REFERENCE = new Set([
  ...Object.keys(ORDINALS), ...DEICTIC, "هذول", "هذولا", "الاعلان", "العرض", "المنتج", "السلعه",
  "الخدمه", "الجهاز", "المعروض", "المعروضه", "الوحده", "المذكور", "المذكوره",
]);
const FILLER = new Set([
  "في", "فيها", "فيه", "عند", "عنده", "عندها", "عليه", "عليها", "له", "لها", "عنه", "عنها", "هو", "هي",
  "هما", "من", "بخصوص", "عن", "حسب", "سجل", "السجل", "الحالي", "الحاليه", "يحتوي", "تحتوي", "يشمل",
  "تشمل", "يوجد", "توجد", "الموجود", "الموجوده", "كذلك", "ايضا", "فقط", "بس",
]);
/**
 * Words that mean the message is not a question about a recorded characteristic: who can answer,
 * a judgement, a price/stock/purchase, or the listing's presentation. They keep their own paths.
 */
const NOT_A_CHARACTERISTIC = new Set([
  "انت", "انتي", "يمكنك", "تقدر", "تستطيع", "تعرف", "تذكر", "ترشح", "ترشحي", "تنصح", "توصي", "تشرح",
  "تحسب", "ترسل", "تكتب", "تبحث", "تجد", "تفهم", "عندك", "عندكم", "لديك", "لديكم", "لك", "لكم",
  "يمكن", "ينفع", "تنفع", "يصلح", "تصلح", "يناسب", "تناسب", "مناسب", "مناسبه", "افضل", "احسن",
  "تستحق", "يستحق", "يستاهل", "تستاهل", "رخيص", "رخيصه", "غالي", "غاليه", "ممتاز", "ممتازه", "مميز",
  "مميزه", "اصلي", "اصليه", "تقبل", "يقبل", "اقبل", "موافق",
  "سعر", "سعرها", "سعره", "بكم", "ثمن", "تكلفه", "خصم", "تفاوض", "تفاوضي", "دفع", "دفعه", "تقسيط",
  "عربون", "شراء", "اشتري", "اشتريه", "اشتريها", "بيع", "ابيع", "توصيل", "شحن", "متوفر", "متوفره",
  "متاح", "متاحه", "كميه", "كمية", "مخزون", "عروض", "طلبات", "رسائل",
  "صور", "صوره", "صورة", "رقم", "تواصل", "موقع", "عنوان",
]);
/** The same words carry suffixes («يناسبني», «تقدرون», «للبيع»), so their stems decide too. */
const NOT_A_CHARACTERISTIC_STEM =
  /^(?:يناسب|تناسب|مناسب|يصلح|تصلح|ينفع|تنفع|يمكن|ممكن|تقدر|تستطيع|تعرف|تذكر|ترشح|تنصح|توصي|تشرح|تحسب|تقبل|يقبل|يستحق|تستحق|يستاهل|تستاهل|افضل|احسن|رخيص|غالي|تساعد|ساعد|اساعد|تفيد|يفيد|تريد|تحب|تفضل|بيع|ابيع|شراء|اشتري|توصيل|شحن|متوفر|متاح|مخزون|سعر|ثمن|تكلفه|خصم|تفاوض|دفع|تقسيط|عربون)/u;
/** Measurement words: the spec's unit is not part of the characteristic's name. */
const UNIT_WORDS = new Set(["متر", "مترا", "مترين", "كيلو", "كيلومتر", "كيلومترا", "سم", "فولت", "واط", "امبير", "انش", "بوصه", "جيجا", "جيجابايت", "تيرا", "ميجابايت", "ميغابايت", "لتر"]);

const PROCLITICS = ["وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ك", "ل"];
const ENDINGS = ["ات", "ين", "ون", "ها", "هم", "كم", "نا"];

/** A conservative Arabic stem: enough for «غرفة» ↔ «غرف» and «العقار» ↔ «عقار», nothing more. */
function stem(token: string): string {
  let value = token;
  for (const prefix of PROCLITICS)
    if (value.startsWith(prefix) && value.length - prefix.length >= 3) {
      value = value.slice(prefix.length);
      break;
    }
  for (const ending of ENDINGS)
    if (value.endsWith(ending) && value.length - ending.length >= 3) {
      value = value.slice(0, -ending.length);
      break;
    }
  if (value.length >= 4 && value.endsWith("ه")) value = value.slice(0, -1);
  return value;
}

const overlaps = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

const wordsOf = (text: string) => normalizeBuyerText(text).split(/\s+/u).filter(Boolean);
/** A word and its stem: «لابتوب» keeps its ل (a loanword, not a proclitic), «العقار» loses ال. */
const vocabularyOf = (text: string) => {
  const vocabulary = new Set<string>();
  for (const word of wordsOf(text)) {
    vocabulary.add(stem(word));
    vocabulary.add(word);
  }
  return vocabulary;
};

/** One registered characteristic of the listing's category, plus any Arabic-named extra field. */
type Characteristic = {
  key: string;
  label: string;
  stems: Set<string>;
};

function characteristicOf(key: string, label: string, options: readonly string[] | undefined): Characteristic {
  const stems = new Set([...vocabularyOf(label), ...vocabularyOf(key)]);
  for (const option of options ?? []) for (const value of vocabularyOf(option)) stems.add(value);
  return { key, label, stems };
}

function covered(token: string, characteristic: Characteristic): boolean {
  const value = stem(token);
  for (const candidate of characteristic.stems) if (overlaps(value, candidate)) return true;
  return false;
}

/** The tokens left after the question words, the listing reference and the filler words. */
function subjectOf(text: string): string[] {
  return wordsOf(text).filter(
    (word) => !LEAD_WORDS.has(word) && !REFERENCE.has(word) && !FILLER.has(word) && ORDINALS[word] === undefined,
  );
}

/** The registered characteristic the question is about, if the question is fully about one. */
function characteristicOfQuestion(
  subject: readonly string[],
  characteristics: readonly Characteristic[],
  title: string,
): Characteristic | undefined {
  if (!characteristics.length) return undefined;
  const anyVocabulary = new Set(characteristics.flatMap((characteristic) => [...characteristic.stems]));
  const titleStems = vocabularyOf(title);
  // The item's own name («لابتوب», «طاولة») is not a characteristic; a word that is both in the
  // title and in the registry vocabulary is one («شتوي» in «جاكيت شتوي»).
  const tokens = subject.filter((token) => {
    if (/^\d+(?:[.,]\d+)?$/u.test(token) || UNIT_WORDS.has(token)) return false;
    const value = stem(token);
    if (!titleStems.has(value)) return true;
    for (const candidate of anyVocabulary) if (overlaps(value, candidate)) return true;
    return false;
  });
  if (!tokens.length) return undefined;
  let best: Characteristic | undefined;
  let bestScore = 0;
  for (const characteristic of characteristics) {
    let score = 0;
    for (const token of tokens) {
      if (!covered(token, characteristic)) {
        score = -1;
        break;
      }
      score++;
    }
    if (score > bestScore) {
      best = characteristic;
      bestScore = score;
    }
  }
  return best;
}

function characteristicsFor(
  schema: ReturnType<typeof categorySchema> | undefined,
  attributes: unknown,
): Characteristic[] {
  const characteristics = schema
    ? Object.entries(schema.attributes).map(([key, definition]: [string, CategoryAttributeDefinition]) =>
        characteristicOf(key, definition.label, definition.options),
      )
    : [];
  // A generic category may let sellers add fields; an Arabic-named one can be asked about too.
  const known = new Set(schema ? Object.keys(schema.attributes) : []);
  if (attributes && typeof attributes === "object")
    for (const key of Object.keys(attributes as Record<string, unknown>))
      if (!known.has(key) && /[\u0600-\u06FF]/u.test(key)) characteristics.push(characteristicOf(key, key, undefined));
  return characteristics;
}

function recordedAnswer(title: string, characteristic: Characteristic, value: string): string {
  const formatted = /^\d/u.test(value) ? value : `«${value}»`;
  return `حسب سجل الإعلان، ${characteristic.label} في «${title}»: ${formatted}. هذه معلومة من الإعلان نفسه، ولم أفترض غيرها.`;
}

function unrecordedAnswer(title: string, characteristic: Characteristic): string {
  return `لم يذكر البائع ${characteristic.label} في إعلان «${title}». جهّزت سؤالًا للبائع:`;
}

export async function executeListingFactQuestion(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  const { actorId } = input;
  if (!actorId) return null;
  const text = normalizeBuyerText(input.message);
  const fact = FACTS.find((candidate) => candidate.test.test(text));
  const characteristicQuestion =
    !fact &&
    QUESTION.test(text) &&
    !EXISTENTIAL.test(text) &&
    !wordsOf(text).some((word) => NOT_A_CHARACTERISTIC.has(word) || NOT_A_CHARACTERISTIC_STEM.test(stem(word)));
  if (!fact && !characteristicQuestion) return null;

  const set = await latestListingSet(input.conversationId, input.market.id);
  if (!set?.resourceIds.length) return null;
  const position = positionIn(text.split(/\s+/u), set.resourceIds.length);
  if (position === undefined) return null;
  const listingId = set.resourceIds[position - 1];
  if (!listingId)
    return notice(`لا يوجد العرض رقم ${position} ضمن النتائج الحالية. اختر رقمًا ظاهرًا أو ابدأ بحثًا جديدًا.`);

  const [row] = await db
    .select({ data: offers.data })
    .from(offers)
    .where(and(eq(offers.id, listingId), eq(offers.marketId, input.market.id)));
  if (!row) return fact ? notice("هذا العرض لم يعد متاحًا؛ لم أجب من بيانات قديمة.") : null;
  const title = typeof row.data.title === "string" ? row.data.title : "الإعلان";

  if (fact) {
    const value = fact.read(row.data.attributes);
    if (value !== undefined)
      return {
        tool: "listingFactQuestion",
        version: 1,
        result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], prompt: fact.answer(title, value) },
      };
    const question = input.message.trim().replace(/[.؟!]+$/u, "");
    return draftListingQuestion(
      { ...input, actorId },
      listingId,
      fact.draft?.(title, question) ?? `بخصوص «${title}»: ${question}؟`,
      fact.missing(title),
    );
  }

  const categoryId = typeof row.data.categoryId === "string" ? row.data.categoryId : undefined;
  const categoryRow = categoryId
    ? await categoryById(categoryId)
    : (await listMarketplaceCategories(true)).find((candidate) => candidate.label === row.data.category);
  const characteristics = characteristicsFor(categoryRow ? categorySchema(categoryRow) : undefined, row.data.attributes);
  const subject = subjectOf(text);
  const characteristic = characteristicOfQuestion(subject, characteristics, title);
  const question = input.message.trim().replace(/[.؟!]+$/u, "");
  if (characteristic) {
    const value = attributeValue(row.data.attributes, [characteristic.key]);
    if (value !== undefined)
      return {
        tool: "listingFactQuestion",
        version: 1,
        result: {
          kind: "SURFACE",
          surface: "CLARIFY",
          query: {},
          listings: [],
          prompt: recordedAnswer(title, characteristic, value),
        },
      };
    return draftListingQuestion(
      { ...input, actorId },
      listingId,
      `بخصوص «${title}»: ${question}؟`,
      unrecordedAnswer(title, characteristic),
    );
  }

  // No registered field explains the question: name the characteristic the buyer asked about and
  // offer the seller question. The item's own words are not characteristics.
  const titleStems = vocabularyOf(title);
  const asked = subject
    .filter((token) => !/^\d+(?:[.,]\d+)?$/u.test(token) && !UNIT_WORDS.has(token))
    .filter((token) => !titleStems.has(stem(token)));
  if (!asked.length) return null;
  return draftListingQuestion(
    { ...input, actorId },
    listingId,
    `بخصوص «${title}»: ${question}؟`,
    `لا أجد في سجل إعلان «${title}» حقلًا يوضّح «${asked.join(" ")}»، فلا أستطيع تأكيد ذلك من السجل. جهّزت سؤالًا للبائع:`,
  );
}
