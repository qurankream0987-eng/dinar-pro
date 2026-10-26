/**
 * Deterministic Arabic/English employment language: roles, skills, experience,
 * workplace mode, employment type, salary, cities and employment ordinals.
 * No model is involved; every value here is either stated by the user or absent.
 */
import {
  foldArabicLetters,
  normalizeDigits,
  normalizeNumberWords,
  parseResultReference,
  type ResultReference,
} from "./arabic-normalization";

export const WORKPLACE_MODES = ["ONSITE", "REMOTE", "HYBRID"] as const;
export type WorkplaceMode = (typeof WORKPLACE_MODES)[number];
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const SALARY_PERIODS = ["HOUR", "DAY", "MONTH", "YEAR"] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const WORKPLACE_LABELS: Record<WorkplaceMode, string> = {
  ONSITE: "حضوري",
  REMOTE: "عن بعد",
  HYBRID: "هجين",
};
export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  FULL_TIME: "دوام كامل",
  PART_TIME: "دوام جزئي",
  CONTRACT: "عقد",
  INTERNSHIP: "تدريب",
};
export const PERIOD_LABELS: Record<SalaryPeriod, string> = {
  HOUR: "بالساعة",
  DAY: "يوميًا",
  MONTH: "شهريًا",
  YEAR: "سنويًا",
};

let lastInput: string | undefined;
let lastOutput = "";

/**
 * Folded, digit-normalized, lower-case text with punctuation reduced to spaces.
 * One turn normalizes the same message in every parser, so the last result is reused.
 */
export function normalizeEmploymentText(message: string): string {
  if (message === lastInput) return lastOutput;
  lastOutput = normalizeUncached(message);
  lastInput = message;
  return lastOutput;
}

function normalizeUncached(message: string): string {
  return normalizeNumberWords(
    foldArabicLetters(normalizeDigits(message))
      .replace(/[؟?!،,؛;:()«»"']+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Whole-word match that also accepts the و/ب/ف clitics ("دوام كامل وهجين"). */
function hasWord(text: string, pattern: string): boolean {
  return new RegExp(`(?:^|\\s)(?:و|ب|ف)?(?:${pattern})(?=\\s|$)`, "u").test(text);
}

// Skills keep their human-readable canonical spelling; aliases only map known spellings.
const SKILL_ALIASES: [string, string[]][] = [
  ["React", ["react", "reactjs", "react.js", "رياكت", "ريأكت"]],
  ["TypeScript", ["typescript", "ts", "تايب سكريبت", "تايبسكريبت"]],
  ["JavaScript", ["javascript", "js", "جافاسكريبت", "جافا سكريبت"]],
  ["Node.js", ["node.js", "nodejs", "node", "نود", "نود جي اس"]],
  ["PHP", ["php", "بي اتش بي"]],
  ["Java", ["java", "جافا"]],
  ["Python", ["python", "بايثون"]],
  ["SQL", ["sql", "اس كيو ال"]],
  ["HTML", ["html"]],
  ["CSS", ["css"]],
  ["Vue", ["vue", "vue.js", "vuejs"]],
  ["Angular", ["angular"]],
  ["Flutter", ["flutter", "فلاتر"]],
  ["Figma", ["figma", "فيجما"]],
  ["Photoshop", ["photoshop", "فوتوشوب"]],
  ["AutoCAD", ["autocad", "اوتوكاد"]],
  ["Excel", ["excel", "اكسل", "اكسيل"]],
  ["محاسبة", ["محاسبة", "محاسبه", "accounting"]],
  ["مبيعات", ["مبيعات", "sales", "بيع"]],
  ["خدمة عملاء", ["خدمة عملاء", "خدمه عملاء", "customer service"]],
  ["تسويق", ["تسويق", "marketing"]],
  ["إدارة مخزون", ["مخزن", "المخزن", "مخزون", "المخزون", "ادارة مخزون", "ادارة المخزن", "inventory"]],
];

/** Role nouns that name a profession; used for titles, candidate search and job search. */
const ROLE_WORDS: [string, string[]][] = [
  ["محاسب", ["محاسب", "محاسبة", "محاسبه", "accountant"]],
  ["مندوب مبيعات", ["مندوب مبيعات", "مندوبة مبيعات", "موظف مبيعات", "sales representative"]],
  ["مطور Front-end", ["front-end", "frontend", "فرونت اند", "فرونت"]],
  ["مطور Back-end", ["back-end", "backend", "باك اند"]],
  ["مطور Full-stack", ["full-stack", "fullstack", "فل ستاك"]],
  ["مبرمج", ["مبرمج", "مبرمجة", "programmer", "developer", "مطور", "مطورة", "engineer"]],
  ["مصمم", ["مصمم", "مصممة", "designer", "مصمم جرافيك"]],
  ["كاتب محتوى", ["كاتب محتوى", "كاتبة محتوى", "content writer"]],
  ["خدمة عملاء", ["موظف خدمة عملاء", "خدمة عملاء"]],
  ["مدرس", ["مدرس", "مدرسة", "معلم", "معلمة", "teacher"]],
  ["سائق", ["سائق", "driver"]],
  ["مساعد إداري", ["مساعد اداري", "مساعدة ادارية", "سكرتير", "سكرتيرة"]],
];

const CITY_WORDS: [string, string[]][] = [
  ["عمان", ["عمان", "amman"]],
  ["إربد", ["اربد", "irbid"]],
  ["الزرقاء", ["الزرقاء", "zarqa"]],
  ["العقبة", ["العقبة", "العقبه", "aqaba"]],
  ["السلط", ["السلط"]],
  ["مادبا", ["مادبا"]],
  ["الكويت", ["الكويت", "مدينة الكويت", "kuwait city"]],
  ["حولي", ["حولي", "hawalli"]],
  ["السالمية", ["السالمية", "السالميه", "salmiya"]],
  ["الفروانية", ["الفروانية", "الفروانيه"]],
  ["الجهراء", ["الجهراء"]],
  ["الأحمدي", ["الاحمدي"]],
  ["الرياض", ["الرياض", "riyadh"]],
  ["جدة", ["جدة", "جده", "jeddah"]],
  ["الدمام", ["الدمام", "dammam"]],
  ["الخبر", ["الخبر"]],
  ["مكة", ["مكة", "مكه"]],
];

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CompiledLexicon = { value: string; patterns: RegExp[] }[];
const compiledLexicons = new WeakMap<[string, string[]][], CompiledLexicon>();

/** Aliases are folded and compiled once per lexicon, not on every message. */
function compiled(lexicon: [string, string[]][]): CompiledLexicon {
  let entries = compiledLexicons.get(lexicon);
  if (!entries) {
    entries = lexicon.map(([value, aliases]) => ({
      value,
      // Arabic clitics: و/ب/ل/ف and the article ("بالمبيعات", "والمخزن").
      patterns: aliases.map(
        (alias) => new RegExp(`(?:^|\\s)(?:و|ب|ل|ف)?(?:ال)?${escape(normalizeEmploymentText(alias))}(?=\\s|$)`, "u"),
      ),
    }));
    compiledLexicons.set(lexicon, entries);
  }
  return entries;
}

function lexiconMatches(text: string, lexicon: [string, string[]][]): string[] {
  const found: { value: string; index: number }[] = [];
  for (const { value, patterns } of compiled(lexicon)) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        found.push({ value, index: match.index });
        break;
      }
    }
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.value);
}

let skillByAlias: Map<string, string> | undefined;

export function canonicalSkill(value: string): string {
  skillByAlias ??= new Map(
    SKILL_ALIASES.flatMap(([canonical, aliases]) =>
      aliases.map((alias) => [normalizeEmploymentText(alias), canonical] as const),
    ),
  );
  return skillByAlias.get(normalizeEmploymentText(value)) ?? value.trim();
}

export function sameSkill(a: string, b: string): boolean {
  return normalizeEmploymentText(canonicalSkill(a)) === normalizeEmploymentText(canonicalSkill(b));
}

/** Known skills named anywhere in the text. */
export function parseKnownSkills(message: string): string[] {
  return lexiconMatches(normalizeEmploymentText(message), SKILL_ALIASES);
}

/**
 * A skills answer ("React و TypeScript", "Excel, محاسبة"): known skills plus any
 * explicitly listed Latin technology tokens. Free prose is never turned into skills.
 */
export function parseSkillList(message: string): string[] {
  const known = parseKnownSkills(message);
  const latin = (message.match(/[A-Za-z][A-Za-z0-9.+#-]{0,30}/g) ?? [])
    .filter((token) => !/^(?:and|or|the|with|skills?|developer|engineer)$/i.test(token))
    .map(canonicalSkill);
  const all = [...known, ...latin];
  return all.filter(
    (skill, index) => all.findIndex((other) => sameSkill(other, skill)) === index,
  ).slice(0, 30);
}

/** The most specific role named; specific entries precede generic ones in the lexicon. */
export function parseRole(message: string): string | undefined {
  const text = normalizeEmploymentText(message);
  return compiled(ROLE_WORDS).find(({ patterns }) => patterns.some((pattern) => pattern.test(text)))?.value;
}

/** Every alias word the role lexicon knows, for removing role words from free text. */
export function roleAliasWords(): string[] {
  return ROLE_WORDS.flatMap(([value, aliases]) => [value, ...aliases]).map(normalizeEmploymentText);
}

export function skillAliasWords(): string[] {
  return SKILL_ALIASES.flatMap(([value, aliases]) => [value, ...aliases]).map(normalizeEmploymentText);
}

export function cityAliasWords(): string[] {
  return CITY_WORDS.flatMap(([value, aliases]) => [value, ...aliases]).map(normalizeEmploymentText);
}

export function roleSearchTerms(role: string): string[] {
  const entry = ROLE_WORDS.find(([value]) => value === role);
  return entry ? [entry[0], ...entry[1]] : [role];
}

export function parseCity(message: string): string | undefined {
  return lexiconMatches(normalizeEmploymentText(message), CITY_WORDS)[0];
}

export function cityAliases(city: string): string[] {
  const entry = CITY_WORDS.find(([value]) => value === city);
  return entry ? [entry[0], ...entry[1]] : [city];
}

export function parseWorkplaceModes(message: string): WorkplaceMode[] {
  const text = normalizeEmploymentText(message);
  const modes: WorkplaceMode[] = [];
  if (hasWord(text, "عن بعد|عن بعد فقط|ريموت|remote|من البيت|من المنزل")) modes.push("REMOTE");
  if (hasWord(text, "هجين|هايبرد|hybrid|مختلط")) modes.push("HYBRID");
  if (hasWord(text, "حضوري|حضوريا|من المكتب|في المكتب|onsite|on-site")) modes.push("ONSITE");
  return modes;
}

export function parseEmploymentTypes(message: string): EmploymentType[] {
  const text = normalizeEmploymentText(message);
  const types: EmploymentType[] = [];
  if (hasWord(text, "دوام كامل|دوام كلي|full time|full-time|فل تايم")) types.push("FULL_TIME");
  if (hasWord(text, "دوام جزئي|part time|part-time|بارت تايم|نص دوام")) types.push("PART_TIME");
  if (hasWord(text, "عقد|بعقد|مؤقت|contract|فريلانس|freelance")) types.push("CONTRACT");
  if (hasWord(text, "تدريب|تدريب عملي|internship|متدرب|انترنشيب")) types.push("INTERNSHIP");
  return types;
}

/** Declared years of experience: "خبرة سنتين", "3 سنوات React", "بدون خبرة" → 0. */
export function parseExperienceYears(message: string): number | undefined {
  const text = normalizeEmploymentText(message);
  if (hasWord(text, "بدون خبرة|لا يشترط خبرة|لا تشترط خبرة|بلا خبرة|حديث تخرج|حديثي التخرج|no experience"))
    return 0;
  if (/(?:^|\s)(?:خبرة|خبره|بخبرة)?\s*سنتين(?=\s|$)/u.test(text) && /خبر|سنتين/.test(text)) return 2;
  const numeric = text.match(
    /(?:^|\s)(\d{1,2})\s*(?:\+\s*)?(?:سنة|سنه|سنوات|سنين|عام|اعوام|years?|yrs?)(?=\s|$)/u,
  );
  if (numeric && /خبر|experience|سنوات|سنين|years?/.test(text)) return Number(numeric[1]);
  if (/(?:^|\s)(?:خبرة|خبره)\s+(?:سنة|سنه)(?:\s+واحدة)?(?=\s|$)/u.test(text)) return 1;
  return undefined;
}

export type SalaryInput = { min: number; max?: number; period: SalaryPeriod };

/**
 * Salary in major units: "راتب 700", "من 600 إلى 800", "800 دينار شهري".
 * Unspecified periods are monthly and shown in the review so the employer can correct them.
 */
export function parseSalary(message: string): SalaryInput | undefined {
  const text = normalizeEmploymentText(message);
  const period: SalaryPeriod = hasWord(text, "بالساعة|بالساعه|ساعة|للساعة|hourly")
    ? "HOUR"
    : hasWord(text, "يومي|يوميا|باليوم|daily")
      ? "DAY"
      : hasWord(text, "سنوي|سنويا|بالسنة|yearly|annual")
        ? "YEAR"
        : "MONTH";
  const range = text.match(/(?:^|\s)(?:من|بين)\s+(\d{2,7})\s*(?:الى|الي|حتى|حتي|و|-)\s*(\d{2,7})(?=\s|$)/u);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low >= 1 && high >= low) return { min: low, max: high, period };
  }
  const single = text.match(
    /(?:راتب|الراتب|راتبها|راتبه|براتب|بمعاش|معاش)\s*(?:يبدا من|من|الى|الي|ل|ب|يصير)?\s*(\d{1,7})(?=\s|$)/u,
  ) ?? text.match(/(?:^|\s)(\d{2,7})\s*(?:دينار|دنانير|ريال|دولار|jd|jod|kwd|sar)(?=\s|$)/u);
  if (single) {
    const value = Number(single[1]);
    if (value >= 1) return { min: value, period };
  }
  return undefined;
}

export function noSalaryAnswer(message: string): boolean {
  const text = normalizeEmploymentText(message);
  return /^(?:لا|بدون|بدون راتب|لا اريد|غير معلن|حسب الخبرة|يحدد لاحقا|تخطي|تخطى|لاحقا)$/u.test(text);
}

/**
 * Job ordinal in an employer/candidate command ("الوظيفة الثانية", "المتقدم الثالث",
 * "الطلب رقم 2"). A later number in the same command is a value, never this ordinal.
 */
export function employmentOrdinal(
  message: string,
  nouns: "JOB" | "APPLICANT" | "APPLICATION" | "CANDIDATE" | "ANY",
): number | undefined {
  const text = normalizeEmploymentText(message);
  const nounPattern = {
    JOB: "الوظيفة|الوظيفه|وظيفة|وظيفه",
    APPLICANT: "المتقدم|المتقدمة|المتقدمه|متقدم",
    APPLICATION: "الطلب|طلب",
    CANDIDATE: "المرشح|المرشحة|المرشحه|مرشح",
    ANY: "الوظيفة|الوظيفه|المتقدم|المتقدمة|الطلب|المرشح|المرشحة|النتيجة|النتيجه",
  }[nouns];
  const match = text.match(
    new RegExp(`(?:^|\\s)(?:${nounPattern})\\s+(?:رقم\\s+)?(\\S+)(?=\\s|$)`, "u"),
  );
  if (!match) return undefined;
  const token = match[1]!;
  const numeric = token.match(/^(\d{1,2})$/);
  if (numeric) {
    const value = Number(numeric[1]);
    return value >= 1 && value <= 24 ? value - 1 : undefined;
  }
  const reference = parseResultReference(token);
  return reference?.kind === "INDEX" ? reference.index : undefined;
}

/** A whole-utterance or embedded ordinal word ("الثانية", "افتح الثالثة"). */
export function bareOrdinal(message: string): ResultReference | undefined {
  return parseResultReference(message);
}

// Requests that would select or rank people by protected or sensitive characteristics.
const PROTECTED_PATTERNS: [string, RegExp][] = [
  ["الدين أو الطائفة", /(?:^|\s)(?:دين|ديانة|ديانه|مسلم|مسلمة|مسيحي|مسيحية|سني|سنية|شيعي|شيعية|طائفة|طائفه|درزي|يهودي|ملحد|متدين|متدينة|محجبة|محجبه)(?=\s|$)/u],
  ["الجنس", /(?:^|\s)(?:ذكر|ذكور|انثى|انثي|اناث|رجل|رجال|امراة|امرأة|نساء|بنت|بنات|شاب|شباب|فتاة|male|female)(?=\s|$)/u],
  ["العمر أو تاريخ الميلاد", /(?:^|\s)(?:عمر|عمره|عمرها|سن|سنه تحت|اقل من \d+ سنة|مواليد|صغير السن|كبير السن|عمره اقل|age)(?=\s|$)/u],
  ["الحالة العائلية", /(?:^|\s)(?:متزوج|متزوجة|اعزب|عزباء|مطلق|مطلقة|ارمل|اولاد|اطفال|حامل|حمل)(?=\s|$)/u],
  ["الصحة أو الإعاقة", /(?:^|\s)(?:معاق|معاقة|اعاقة|اعاقه|مريض|مرض|صحته|سليم|سليمة)(?=\s|$)/u],
  ["الجنسية أو الأصل", /(?:^|\s)(?:جنسية|جنسيه|اردني|اردنية|كويتي|كويتية|سعودي|سعودية|مصري|مصرية|سوري|سورية|عراقي|فلسطيني|هندي|اجنبي|اجنبية|وافد|وافدة|عرق|اصل|لون|بشرة|ابيض البشرة)(?=\s|$)/u],
  ["الانتماء السياسي أو النقابي", /(?:^|\s)(?:سياسي|سياسية|حزب|حزبي|نقابة|نقابي)(?=\s|$)/u],
];

/** Protected categories named in a people search. They are reported and never become filters. */
export function protectedTraitsRequested(message: string): string[] {
  const text = normalizeEmploymentText(message);
  return PROTECTED_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

/** "اختر الأفضل وارفض الباقين تلقائيًا" — an automatic employment decision request. */
export function automaticDecisionRequested(message: string): boolean {
  const text = normalizeEmploymentText(message);
  return (
    /تلقائ/.test(text) && /(?:ارفض|اقبل|وظف|عين|اختر|انقل|ضع|اختار)/.test(text)
  ) || /(?:ارفض|استبعد)\s+(?:الباقين|البقية|الباقي|الكل|الجميع)/.test(text)
    || /(?:اختر|اختار|وظف|عين)\s+(?:لي\s+)?(?:الافضل|احسن)/.test(text);
}

export function hasSkillsWord(message: string): boolean {
  return /مهار/.test(normalizeEmploymentText(message));
}
