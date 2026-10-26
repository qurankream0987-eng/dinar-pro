import { z } from "zod";

export const MEMORY_KINDS = ["SESSION_CONTEXT", "EXPLICIT_PREFERENCES", "INFERRED_INTERESTS", "NEGATIVE_PREFERENCES", "BEHAVIORAL_SIGNALS", "LONG_TERM_FACTS", "CONVERSATION_STYLE", "RECENT_CONTEXT"] as const;
export const MEMORY_SOURCES = ["EXPLICIT_USER_STATEMENT", "CONVERSATION", "SEARCH", "LISTING_VIEW", "SAVE", "PURCHASE", "SELLER_ACTIVITY", "REPEATED_TOPIC", "USER_CORRECTION"] as const;
export const CandidateMemory = z.object({
  kind: z.enum(MEMORY_KINDS), topic: z.string().trim().min(2).max(80),
  evidence: z.string().trim().min(2).max(160),
  value: z.string().trim().min(2).max(120).optional(),
}).strict();
export type Candidate = z.infer<typeof CandidateMemory>;
export type Source = typeof MEMORY_SOURCES[number];
export type Kind = typeof MEMORY_KINDS[number];
export type Topic = { key: string; label: string; parent?: string; aliases: string[] };
export type Memory = {
  userId: string; topic: string; label: string; parent: string | null; kind: Kind;
  value: string | null; signalCount: number; confidence: number; sourceTypes: Source[];
  firstSeenAt: Date; lastSeenAt: Date; status: "ACTIVE" | "SUPPRESSED" | "FORGOTTEN";
  conversationId: string | null;
};
export function normalizeTopic(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\u064B-\u065F\u0670ـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}
// Data-driven aliases, not branches by user type. Additional topics need no schema change.
export const TOPICS: Topic[] = [
  { key: "sports", label: "الرياضة", aliases: ["sports", "رياضة", "رياضه"] },
  { key: "football", label: "كرة القدم", parent: "sports", aliases: ["football", "كرة القدم", "كرة", "كورة", "كوره", "الكورة"] },
  { key: "real-madrid", label: "ريال مدريد", parent: "football", aliases: ["ريال مدريد", "real madrid"] },
  { key: "champions-league", label: "دوري أبطال أوروبا", parent: "football", aliases: ["champions league", "دوري ابطال اوروبا"] },
  { key: "education", label: "التعليم", aliases: ["education", "تعليم", "دراسة"] },
  { key: "university", label: "الجامعة", parent: "education", aliases: ["university", "جامعة", "الجامعة", "جامعي"] },
  { key: "science", label: "العلوم", parent: "education", aliases: ["science", "علوم", "الديناميكا الحرارية", "thermodynamics"] },
  { key: "engineering", label: "الهندسة", parent: "science", aliases: ["engineering", "هندسة", "الهندسة"] },
  { key: "chemistry", label: "الكيمياء", parent: "science", aliases: ["chemistry", "كيمياء", "الكيمياء"] },
  { key: "automotive", label: "السيارات", aliases: ["automotive", "cars", "car", "سيارة", "سياره", "سيارات", "السيارات", "السيارة"] },
  { key: "toyota", label: "تويوتا", parent: "automotive", aliases: ["toyota", "تويوتا"] },
  { key: "prado", label: "برادو", parent: "toyota", aliases: ["prado", "برادو", "البرادو"] },
  { key: "bmw", label: "BMW", parent: "automotive", aliases: ["bmw", "بي ام دبليو"] },
  { key: "japanese-cars", label: "السيارات اليابانية", parent: "automotive", aliases: ["japanese cars", "السيارات اليابانية", "سيارات يابانية"] },
  { key: "american-cars", label: "السيارات الأمريكية", parent: "automotive", aliases: ["american cars", "سيارات امريكية", "السيارات الامريكية"] },
  { key: "suv", label: "سيارات SUV", parent: "automotive", aliases: ["suv", "دفع رباعي"] },
  { key: "off-road", label: "الطرق الوعرة", parent: "automotive", aliases: ["off road", "off-road", "طرق وعرة"] },
  { key: "outdoors", label: "الأنشطة الخارجية", aliases: ["outdoors", "انشطة خارجية"] },
  { key: "camping", label: "التخييم", parent: "outdoors", aliases: ["camping", "التخييم", "تخييم", "خيمة", "خيمه", "خيام"] },
  { key: "fitness", label: "اللياقة", aliases: ["fitness", "لياقة", "اللياقة", "تمارين"] },
  { key: "gym", label: "النادي الرياضي", parent: "fitness", aliases: ["gym", "جيم", "نادي رياضي"] },
  { key: "running", label: "الجري", parent: "fitness", aliases: ["running", "جري", "الجري"] },
  { key: "general-health-content", label: "محتوى الصحة العامة", aliases: ["general health", "صحة", "الصحة", "صحي", "تغذية", "nutrition"] },
  { key: "technology", label: "التقنية", aliases: ["technology", "تقنية", "تكنولوجيا", "الكترونيات"] },
  { key: "programming", label: "البرمجة", parent: "technology", aliases: ["programming", "برمجة", "البرمجة"] },
  { key: "ai", label: "الذكاء الاصطناعي", parent: "technology", aliases: ["ai", "الذكاء الاصطناعي", "ذكاء اصطناعي"] },
  { key: "food", label: "الطعام", aliases: ["food", "طعام", "مطاعم", "طبخ", "cooking"] },
  ...["travel", "fashion", "home", "business"].map(key => ({ key, label: key, aliases: [key] })),
];
const aliases = new Map(TOPICS.flatMap(t => [t.key, t.label, ...t.aliases].map(a => [normalizeTopic(a), t] as const)));
export function topicIdentity(value: string): Topic {
  const normalized = normalizeTopic(value);
  return aliases.get(normalized) ?? { key: normalized.replace(/ /g, "-"), label: normalized, aliases: [normalized] };
}
export function discoverTopics(text: string): Topic[] {
  const normalized = ` ${normalizeTopic(text)} `;
  const found = TOPICS.filter(t => [t.label, ...t.aliases].some(a => normalized.includes(` ${normalizeTopic(a)} `) || normalized.includes(` و${normalizeTopic(a)} `)));
  return found.filter(t => !found.some(child => child.parent === t.key));
}
const PRIVATE = /password|passcode|\botp\b|api[ _-]?key|secret|token|credential|card|cvv|iban|gps|latitude|longitude|passport|identity document|كلمة (?:المرور|السر)|رمز (?:التحقق|الدخول)|مفتاح|بطاقة|حساب بنكي|جواز|هوية|احداثيات|موقعي|دينر_|dnr_|sk-[a-z0-9]|https?:|[\w.+-]+@[\w.-]+|\d{4,}|[٠-٩]{4,}|[-+]?\d{1,3}[.,]\d{3,}/iu;
const SENSITIVE = /diabet|cancer|diagnos|disease|depress|bipolar|autis|adhd|hiv|pregnan|religio|muslim|christian|jewish|politic|democrat|republican|sexual|gay|lesbian|ethnic|race|criminal|arrest|bankrupt|debt|financial distress|سكري|سرطان|مرض|تشخيص|اكتئاب|توحد|حامل|دين(?:ي|ية)|مسلم|مسيحي|يهودي|سياسي|سياسة|انتخاب|مثلي|عرق|قبيلة|جنائي|سجن|ديون|افلاس|ضائقة|مريض/iu;
export function safeMemoryText(text: string): boolean {
  const normalized = normalizeTopic(text);
  const additionalSensitive = /asthma|epilepsy|schizophren|anxiety disorder|alzheimer|parkinson|hypertension|insulin|disab|socialis|communis|fascis|conservativ|liberal|atheis|sunni|shia|\barab\b|\bkurd\b|\bblack\b|\bwhite\b|ربو|صرع|فصام|زهايمر|باركنسون|ضغط الدم|انسولين|اعاقة|اشتراكي|شيوعي|ملحد|سني|شيعي|(?:انا|اني) (?:عربي|كردي|اسود|ابيض)/iu;
  return text.length <= 500 && !PRIVATE.test(text) && !SENSITIVE.test(normalized) && !additionalSensitive.test(normalized) && !/[A-Za-z0-9_-]{32,}/.test(text);
}
const STYLE: Record<string, string[]> = {
  "short-answers": ["اجابات قصيرة", "ردود قصيرة", "اختصر", "short answers"],
  "detailed-answers": ["شرح مفصل", "بالتفصيل", "detailed answers"],
  "comparisons": ["افضل المقارنات", "احب المقارنات", "prefer comparisons"],
  "direct-recommendations": ["توصيات مباشرة", "direct recommendations"],
  "arabic-dialect": [
    "باللهجة الخليجية",
    "باللهجة العراقية",
    "باللهجة المصرية",
    "باللهجة الأردنية",
    "باللهجة الاردنية",
    "باللهجة السعودية",
    "باللهجة الكويتية",
    "باللهجة الإماراتية",
    "باللهجة البحرينية",
    "باللهجة العمانية",
    "باللهجة الشامية",
    "باللهجة السورية",
    "باللهجة اللبنانية",
    "باللهجة الفلسطينية",
    "باللهجة اليمنية",
    "باللهجة الحجازية",
    "باللهجة النجدية",
    "باللهجة المغربية",
    "باللهجة التونسية",
    "باللهجة الجزائرية",
    "باللهجة السودانية",
    "بالعربية الفصحى",
    "jordanian arabic",
    "jordanian dialect",
    "saudi arabic",
    "saudi dialect",
    "kuwaiti arabic",
    "kuwaiti dialect",
    "gulf arabic",
    "gulf dialect",
    "egyptian arabic",
    "iraqi arabic",
    "levantine arabic",
    "modern standard arabic",
  ],
};
export function extractDeterministic(text: string): Candidate[] {
  if (!safeMemoryText(text)) return [];
  const normalized = normalizeTopic(text);
  const negative = /(?:لا|ما) (?:احب|افضل)|لا تقترح|do not (?:like|recommend)|don.t like/i.test(normalized);
  const explicit = /(?:انا )?(?:احب|افضل)|تذكر|i (?:love|like|prefer)|remember/i.test(normalized);
  const negativeStyle =
    /(?:لا|ما|مش|مو)\s*(?:احب|افضل|اريد|ابي|ابغي|تفضل|تتكلم|تكلمني|تستخدم|ترد)|\b(?:do not|dont|never)\s+(?:prefer|like|want|use|speak|reply)\b|\bnot\b.{0,50}\b(?:dialect|arabic)\b|\bnever\b.{0,50}\b(?:dialect|arabic)\b/.test(
      normalized,
    );
  const explicitStyle =
    /(?:\b(?:i prefer|i like|my preferred|remember (?:that )?i (?:prefer|like))\b|(?:انا )?(?:احب|افضل)(?:\s|$)|(?:تذكر|احفظ).{0,40}(?:لهجة|dialect)|(?:دائما|دايما|always).{0,60}(?:كلمني|تكلم|رد|استخدم|speak|reply|use))/i.test(
      normalized,
    );
  const thirdParty = /لصديقي|لصديق|ليس لي|مو لي|for (?:my |a )?friend|not for me/i.test(normalized);
  if (thirdParty) return [];
  const candidates: Candidate[] = [];
  if (/انا طالب (?:جامعي|في الجامعة)|i am a university student/i.test(normalized)) candidates.push({ kind: "LONG_TERM_FACTS", topic: "university-study", value: "طالب جامعي", evidence: text.slice(0,160) });
  // Parse clauses independently, so a rejection never becomes a positive preference.
  for (const clause of text.split(/[،,;.\n]|\s+(?:لكن|but)\s+/iu)) {
    const n = normalizeTopic(clause);
    const neg = /(?:لا|ما) (?:احب|افضل)|لا تقترح|do not (?:like|recommend)|don.t like/i.test(n);
    const pos = /(?:انا )?(?:احب|افضل)|تذكر|i (?:love|like|prefer)|remember/i.test(n);
    for (const topic of discoverTopics(clause)) candidates.push({ kind: neg ? "NEGATIVE_PREFERENCES" : pos ? "EXPLICIT_PREFERENCES" : "INFERRED_INTERESTS", topic: topic.key, evidence: clause.trim().slice(0, 160) });
  }
  for (const [topic, variants] of Object.entries(STYLE)) {
    if (!explicitStyle || negativeStyle) continue;
    const match = variants.find(v => normalized.includes(normalizeTopic(v)));
    if (match) candidates.push({ kind: "CONVERSATION_STYLE", topic, value: match, evidence: match });
  }
  // Generic explicit preferences can introduce arbitrary topics without a taxonomy edit.
  if (!candidates.length && (explicit || negative)) {
    const remainder = normalized.replace(/^.*?(?:احب|افضل|تذكر اني احب|i love|i like|i prefer|remember that i like)\s+/i, "").trim();
    if (remainder !== normalized && remainder.length >= 2 && remainder.length <= 80)
      candidates.push({ kind: negative ? "NEGATIVE_PREFERENCES" : "EXPLICIT_PREFERENCES", topic: remainder, evidence: text.slice(0, 160) });
  }
  return candidates;
}
export function validateCandidate(raw: unknown, text: string, source: Source, ai = false): Candidate | null {
  const parsed = CandidateMemory.safeParse(raw);
  if (!parsed.success || !safeMemoryText(text)) return null;
  const candidate = parsed.data;
  if (![candidate.topic, candidate.evidence, candidate.value ?? "safe"].every(safeMemoryText)) return null;
  if (!normalizeTopic(text).includes(normalizeTopic(candidate.evidence))) return null;
  if (ai) {
    // Models cannot invent durable facts, authority, corrections or user style.
    if (candidate.kind !== "INFERRED_INTERESTS") return null;
    const identity = topicIdentity(candidate.topic);
    if (![identity.key, identity.label, ...identity.aliases].some(a => normalizeTopic(candidate.evidence).includes(normalizeTopic(a)))) return null;
  }
  if (["EXPLICIT_PREFERENCES", "NEGATIVE_PREFERENCES", "CONVERSATION_STYLE", "LONG_TERM_FACTS"].includes(candidate.kind) && !["EXPLICIT_USER_STATEMENT", "USER_CORRECTION"].includes(source)) return null;
  return candidate;
}
export function decayedConfidence(memory: Memory, now: Date): number {
  const days = Math.max(0, (now.getTime() - memory.lastSeenAt.getTime()) / 86400000);
  const halfLife = ["EXPLICIT_PREFERENCES", "NEGATIVE_PREFERENCES", "LONG_TERM_FACTS", "CONVERSATION_STYLE"].includes(memory.kind) ? 730 : memory.kind === "RECENT_CONTEXT" ? 14 : memory.kind === "SESSION_CONTEXT" ? 1 : 90;
  return memory.confidence * Math.pow(0.5, days / halfLife);
}
export function accumulatedConfidence(count: number, explicit: boolean): number {
  return explicit ? 0.98 : Math.min(0.9, 1 - Math.pow(0.82, count));
}
export function descendants(key: string, memories: Memory[]): Set<string> {
  const result = new Set([key]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of [...TOPICS, ...memories.map(m => ({ key: m.topic, parent: m.parent }))])
      if (t.parent && result.has(t.parent) && !result.has(t.key)) { result.add(t.key); changed = true; }
  }
  return result;
}
export function rankRelevantMemories(memories: Memory[], query: string, now: Date, conversationId?: string): Memory[] {
  const explicitTopics = discoverTopics(query);
  const normalized = normalizeTopic(query);
  const keys = new Set(explicitTopics.map(t => t.key));
  // Parents support broad requests; sibling brands do not qualify for explicit brand requests.
  for (const t of explicitTopics) for (const k of descendants(t.key, memories)) keys.add(k);
  const continuation = /نكمل|كنا نتكلم|المرة الماضية|continue|last time/.test(normalized);
  const negatives = memories.filter(m => m.status === "ACTIVE" && m.kind === "NEGATIVE_PREFERENCES");
  const excluded = new Set(negatives.flatMap(m => [...descendants(m.topic, memories)]));
  return memories.filter(m => m.status === "ACTIVE" && (m.kind === "NEGATIVE_PREFERENCES" || !excluded.has(m.topic)))
    .filter(m => m.kind !== "BEHAVIORAL_SIGNALS" && (m.kind !== "SESSION_CONTEXT" || m.conversationId === conversationId))
    .filter(m => !["INFERRED_INTERESTS", "RECENT_CONTEXT", "SESSION_CONTEXT"].includes(m.kind) || m.signalCount >= 2 || m.sourceTypes.includes("EXPLICIT_USER_STATEMENT"))
    .filter(m => decayedConfidence(m, now) >= 0.3)
    .filter(m => keys.has(m.topic) || normalized.includes(normalizeTopic(m.label)) || m.kind === "CONVERSATION_STYLE" || (continuation && !explicitTopics.length && m.kind === "RECENT_CONTEXT" && m.lastSeenAt.getTime() === Math.max(...memories.filter(r => r.status === "ACTIVE" && r.kind === "RECENT_CONTEXT").map(r => r.lastSeenAt.getTime()))))
    .sort((a, b) => decayedConfidence(b, now) - decayedConfidence(a, now) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .slice(0, 6);
}
