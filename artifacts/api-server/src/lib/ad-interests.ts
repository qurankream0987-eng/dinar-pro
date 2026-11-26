/**
 * Interest-based ads («إعلانات ذكية») — the viewer's own, revocable choice.
 *
 *  - Nothing is recorded or used until the viewer turns personalization ON. Absent setting = OFF.
 *  - Only coarse interests are kept: a category id or a normalized keyword, with a decayed score.
 *    Never the message text, never a listing id, never a seller.
 *  - Sensitive subjects (health, religion, politics, intimate life, finance hardship…) are never
 *    recorded, so they can never drive an ad.
 *  - Scores halve every HALF_LIFE_DAYS; anything not seen for RETENTION_DAYS is deleted.
 *  - Turning it OFF (or «امسح اهتماماتي») deletes every stored interest at once.
 *  - Interests only re-order ads that are already eligible for the market: they never make an
 *    ineligible campaign appear and never change a price.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { adInterestSignals, adPersonalizationSettings, db } from "@workspace/db";
import { normalizeSearch } from "../ai/search-context";
import { itemTokens } from "./arabic-search-terms";

export const HALF_LIFE_DAYS = 21;
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const MAX_TERMS_PER_USER = 120;
const MAX_TERMS_PER_SIGNAL = 6;

export type AdPersonalizationStatus = "ON" | "OFF";
export type InterestSource = "SEARCH" | "CART" | "VIEW";
const WEIGHT: Record<InterestSource, number> = { SEARCH: 1, VIEW: 1.5, CART: 3 };

const STOP_WORDS = new Set([
  "في", "من", "مع", "على", "الى", "عن", "او", "و", "ال", "للبيع", "بيع", "جديد", "مستعمل", "نظيف",
  "ممتاز", "اصلي", "حالة", "حاله", "لون", "سعر", "عرض", "قطعة", "قطعه", "بدي", "ابي", "اريد", "ابغى",
  "ابحث", "عندك", "عندكم", "شي", "شيء", "حدا", "لي", "اللي", "هذا", "هذه", "كيف", "وين", "كم", "اقل",
  "اكثر", "رخيص", "غالي", "زين", "حلو", "افضل", "احسن", "دينار", "ريال", "درهم", "جنيه", "ليرة", "دولار",
]);

/**
 * Sensitive subjects: a word that touches one of these is dropped, and a signal whose words touch one
 * records nothing at all (not even its category), so the subject cannot be inferred from the rest.
 */
const SENSITIVE_STEMS = [
  // health and body
  "دواء", "ادوية", "علاج", "مرض", "سرطان", "سكري", "ضغط الدم", "حمل", "اجهاض", "عيادة", "طبيب", "نفسي",
  "اكتئاب", "ادمان", "مخدر", "ايدز", "عقم", "رجيم", "تخسيس",
  // religion and belief
  "دين", "ديني", "مسيحي", "مسلم", "يهودي", "شيعي", "سني", "كنيسة", "مسجد", "صلاة", "حج", "عمرة",
  // politics and origin
  "سياسي", "حزب", "انتخاب", "لاجئ", "لجوء", "عرق", "قبيلة",
  // intimate life
  "جنس", "جنسي", "واقي", "مثلي", "زواج سري", "طلاق",
  // money hardship
  "قرض", "دين مالي", "افلاس", "ديون", "رهن",
].map((word) => normalizeSearch(word));

function isSensitive(text: string): boolean {
  const normalized = ` ${normalizeSearch(text)} `;
  return SENSITIVE_STEMS.some((stem) => normalized.includes(` ${stem}`) || normalized.includes(`${stem} `));
}

/** Normalized keywords worth remembering from a search or a listing title. */
export function interestTerms(text: string): string[] {
  const tokens = normalizeSearch(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^(?:وال|بال|لل|ال)/u, ""))
    .filter((word) => word.length >= 3 && word.length <= 30 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
  return [...new Set(itemTokens(tokens))].slice(0, MAX_TERMS_PER_SIGNAL);
}

export async function getAdPersonalization(userId: string): Promise<AdPersonalizationStatus> {
  const [row] = await db.select({ status: adPersonalizationSettings.status }).from(adPersonalizationSettings).where(eq(adPersonalizationSettings.userId, userId));
  return row?.status === "ON" ? "ON" : "OFF";
}

export async function hasDecidedAdPersonalization(userId: string): Promise<boolean> {
  const [row] = await db.select({ status: adPersonalizationSettings.status }).from(adPersonalizationSettings).where(eq(adPersonalizationSettings.userId, userId));
  return Boolean(row);
}

export async function setAdPersonalization(userId: string, status: AdPersonalizationStatus, now = new Date()) {
  await db.transaction(async (tx) => {
    await tx
      .insert(adPersonalizationSettings)
      .values({ userId, status, decidedAt: now })
      .onConflictDoUpdate({ target: adPersonalizationSettings.userId, set: { status, decidedAt: now } });
    if (status === "OFF") await tx.delete(adInterestSignals).where(eq(adInterestSignals.userId, userId));
  });
  return { status };
}

export async function clearAdInterests(userId: string) {
  await db.delete(adInterestSignals).where(eq(adInterestSignals.userId, userId));
}

const decayed = (score: number, lastSeenAt: Date, now: Date) =>
  score * Math.pow(0.5, Math.max(0, now.getTime() - lastSeenAt.getTime()) / (HALF_LIFE_DAYS * DAY_MS));

/**
 * Records one signal for a viewer who turned personalization ON. Never throws into the caller's
 * flow: an interest is a nicety, never a reason for a search or a cart action to fail.
 */
export async function recordAdInterest(input: { userId: string | undefined; source: InterestSource; categoryId?: string | null; text?: string | null; now?: Date }): Promise<{ recorded: number }> {
  try {
    if (!input.userId) return { recorded: 0 };
    if ((await getAdPersonalization(input.userId)) !== "ON") return { recorded: 0 };
    const text = input.text ?? "";
    if (isSensitive(text)) return { recorded: 0 };
    const now = input.now ?? new Date();
    const weight = WEIGHT[input.source];
    const keys: { kind: "CATEGORY" | "TERM"; key: string }[] = [
      ...(input.categoryId && /^[a-z0-9-]{1,60}$/.test(input.categoryId) ? [{ kind: "CATEGORY" as const, key: input.categoryId }] : []),
      ...interestTerms(text).filter((term) => !isSensitive(term)).map((key) => ({ kind: "TERM" as const, key })),
    ];
    if (!keys.length) return { recorded: 0 };
    await db.transaction(async (tx) => {
      await tx.delete(adInterestSignals).where(and(eq(adInterestSignals.userId, input.userId!), lt(adInterestSignals.lastSeenAt, new Date(now.getTime() - RETENTION_DAYS * DAY_MS))));
      for (const item of keys) {
        const [existing] = await tx
          .select()
          .from(adInterestSignals)
          .where(and(eq(adInterestSignals.userId, input.userId!), eq(adInterestSignals.kind, item.kind), eq(adInterestSignals.key, item.key)))
          .for("update");
        const score = (existing ? decayed(existing.score, existing.lastSeenAt, now) : 0) + weight;
        await tx
          .insert(adInterestSignals)
          .values({ userId: input.userId!, kind: item.kind, key: item.key, score, lastSeenAt: now })
          .onConflictDoUpdate({ target: [adInterestSignals.userId, adInterestSignals.kind, adInterestSignals.key], set: { score, lastSeenAt: now } });
      }
      // Bounded profile: keep the strongest terms only.
      const terms = await tx
        .select({ key: adInterestSignals.key, score: adInterestSignals.score, lastSeenAt: adInterestSignals.lastSeenAt })
        .from(adInterestSignals)
        .where(and(eq(adInterestSignals.userId, input.userId!), eq(adInterestSignals.kind, "TERM")));
      if (terms.length > MAX_TERMS_PER_USER) {
        const weakest = terms
          .map((row) => ({ key: row.key, value: decayed(row.score, row.lastSeenAt, now) }))
          .sort((a, b) => a.value - b.value)
          .slice(0, terms.length - MAX_TERMS_PER_USER);
        for (const row of weakest)
          await tx.delete(adInterestSignals).where(and(eq(adInterestSignals.userId, input.userId!), eq(adInterestSignals.kind, "TERM"), eq(adInterestSignals.key, row.key)));
      }
    });
    return { recorded: keys.length };
  } catch {
    return { recorded: 0 };
  }
}

export type InterestProfile = { categories: Map<string, number>; terms: Map<string, number> };

/** The viewer's current interests (decayed, retention applied). Empty unless personalization is ON. */
export async function interestProfile(userId: string, now = new Date()): Promise<InterestProfile> {
  const profile: InterestProfile = { categories: new Map(), terms: new Map() };
  if ((await getAdPersonalization(userId)) !== "ON") return profile;
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const rows = await db.select().from(adInterestSignals).where(eq(adInterestSignals.userId, userId)).orderBy(desc(adInterestSignals.score));
  for (const row of rows) {
    if (row.lastSeenAt < cutoff) continue;
    const value = decayed(row.score, row.lastSeenAt, now);
    if (value < 0.05) continue;
    (row.kind === "CATEGORY" ? profile.categories : profile.terms).set(row.key, value);
  }
  return profile;
}

/** What the viewer can see and erase: strongest first. */
export async function listAdInterests(userId: string, now = new Date()) {
  const profile = await interestProfile(userId, now);
  const rows = [
    ...[...profile.categories].map(([key, value]) => ({ kind: "CATEGORY" as const, key, strength: value })),
    ...[...profile.terms].map(([key, value]) => ({ kind: "TERM" as const, key, strength: value })),
  ];
  return rows.sort((a, b) => b.strength - a.strength).slice(0, 30).map((row) => ({ ...row, strength: Math.round(row.strength * 100) / 100 }));
}

/**
 * How well one ad's listing matches the viewer: 0 (no match) .. 1 (strong). A keyword match counts
 * across categories, which is how «سيارات» interest reaches «شاحن سيارة» listed under electronics.
 * `reason` names the strongest matching interest, so «لماذا أرى هذا الإعلان؟» is always truthful.
 */
export function interestMatch(profile: InterestProfile, listing: { categoryId?: string | null; text: string }): { boost: number; reason: string | null } {
  if (!profile.categories.size && !profile.terms.size) return { boost: 0, reason: null };
  const strongest = Math.max(1, ...profile.categories.values(), ...profile.terms.values());
  let best: { value: number; reason: string } | undefined;
  let total = 0;
  const category = listing.categoryId ? profile.categories.get(listing.categoryId) : undefined;
  if (category) {
    total += category;
    best = { value: category, reason: `CATEGORY:${listing.categoryId}` };
  }
  for (const term of interestTermsAll(listing.text)) {
    const value = profile.terms.get(term);
    if (!value) continue;
    total += value * 1.2;
    if (!best || value * 1.2 > best.value) best = { value: value * 1.2, reason: `TERM:${term}` };
  }
  if (!best) return { boost: 0, reason: null };
  return { boost: Math.min(1, total / (strongest * 2)), reason: best.reason };
}

/** Every keyword of a listing's text (titles can be longer than one search). */
function interestTermsAll(text: string): string[] {
  return [...new Set(normalizeSearch(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).map((word) => word.replace(/^(?:وال|بال|لل|ال)/u, "")).filter((word) => word.length >= 3 && word.length <= 30 && !STOP_WORDS.has(word)))].slice(0, 40);
}
