/**
 * Block C employment authorities: jobs, candidate profiles and applications.
 *
 * Every mutation takes the authenticated actor id and enforces ownership in the
 * SQL predicate itself. Views are explicit allowlists; database rows are never
 * spread into responses. Matching is transparent and job-related only, and no
 * function here makes an employment decision on anyone's behalf.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  candidateProfiles,
  db,
  jobApplications,
  jobs,
  users,
} from "@workspace/db";
import { assertAccountCanTransact } from "./account-status";
import { normalizeListingContactPhone } from "./listing-contact";
import { assertPublicListingLocation } from "./location-policy";
import { assertMarketActive, type marketFor } from "./markets";
import { assertEmploymentResourceNotModerated } from "./moderation";
import { activePolicyRules, matchingPolicyRule } from "./publication-policy";
import {
  EMPLOYMENT_LABELS,
  EMPLOYMENT_TYPES,
  PERIOD_LABELS,
  SALARY_PERIODS,
  WORKPLACE_LABELS,
  WORKPLACE_MODES,
  cityAliases,
  normalizeEmploymentText,
  roleSearchTerms,
  sameSkill,
  type EmploymentType,
  type SalaryPeriod,
  type WorkplaceMode,
} from "../ai/employment-parser";

type Market = Awaited<ReturnType<typeof marketFor>>;
type JobRow = typeof jobs.$inferSelect;
type ProfileRow = typeof candidateProfiles.$inferSelect;
type ApplicationRow = typeof jobApplications.$inferSelect;

const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });
const PROFILE_MARKET_MISMATCH_MESSAGE =
  "ملفك الوظيفي مرتبط بسوق آخر ولا يمكن استخدامه أو نقله تلقائيًا إلى السوق الحالي.";

// ─── Job drafts ──────────────────────────────────────────────────────────────

export const JobDraft = z
  .object({
    draftId: z.string().uuid(),
    title: z.string().trim().min(2).max(120).optional(),
    description: z.string().max(4000).optional(),
    skills: z.array(z.string().trim().min(1).max(60)).max(30),
    minExperienceYears: z.number().int().min(0).max(50).optional(),
    experienceAsked: z.boolean().optional(),
    city: z.string().trim().min(2).max(60).optional(),
    workplaceMode: z.enum(WORKPLACE_MODES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    salary: z
      .object({
        min: z.number().positive().max(10_000_000),
        max: z.number().positive().max(10_000_000).optional(),
        period: z.enum(SALARY_PERIODS),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type JobDraft = z.infer<typeof JobDraft>;

export type JobDraftField =
  | "title"
  | "skills"
  | "experience"
  | "employment"
  | "city"
  | "salary";

/** The next missing field, in a fixed, short order. `undefined` means ready for review. */
export function nextJobDraftField(draft: JobDraft): JobDraftField | undefined {
  if (!draft.title) return "title";
  if (!draft.skills.length) return "skills";
  if (draft.minExperienceYears === undefined && !draft.experienceAsked) return "experience";
  if (!draft.employmentType || !draft.workplaceMode) return "employment";
  if (draft.workplaceMode !== "REMOTE" && !draft.city) return "city";
  if (draft.salary === undefined) return "salary";
  return undefined;
}

export const JOB_FIELD_PROMPTS: Record<JobDraftField, string> = {
  title: "ما المسمى الوظيفي؟ مثل: محاسب، مندوب مبيعات، مطور Front-end.",
  skills: "ما المهارات المطلوبة؟ اكتبها مفصولة بفواصل، مثل: React، TypeScript.",
  experience: "كم سنة خبرة تشترط؟ يمكنك كتابة «بدون خبرة».",
  employment: "ما نوع الدوام ومكان العمل؟ مثل: دوام كامل وهجين، أو دوام جزئي عن بعد.",
  city: "في أي مدينة مكان العمل؟",
  salary: "هل تريد ذكر الراتب؟ اكتب المبلغ أو المدى (مثل: من 600 إلى 800)، أو «بدون».",
};

// ─── Money ───────────────────────────────────────────────────────────────────

function toMinor(major: number, market: Market): number {
  return Math.round(major * 10 ** market.minorUnitScale);
}

function formatMinor(minor: number, scale: number): string {
  const value = minor / 10 ** scale;
  return Number.isInteger(value) ? String(value) : value.toFixed(scale);
}

export function salarySummary(
  input: {
    salaryMinMinor: number | null;
    salaryMaxMinor: number | null;
    salaryCurrency: string | null;
    salaryPeriod: string | null;
  },
  scale: number,
): string | null {
  if (input.salaryMinMinor == null || !input.salaryCurrency || !input.salaryPeriod) return null;
  const period = PERIOD_LABELS[input.salaryPeriod as SalaryPeriod] ?? "";
  const min = formatMinor(input.salaryMinMinor, scale);
  const amount =
    input.salaryMaxMinor != null && input.salaryMaxMinor !== input.salaryMinMinor
      ? `${min} – ${formatMinor(input.salaryMaxMinor, scale)}`
      : min;
  return `${amount} ${input.salaryCurrency} ${period}`.trim();
}

export function draftSalarySummary(draft: JobDraft, market: Market): string | null {
  if (!draft.salary) return null;
  return salarySummary(
    {
      salaryMinMinor: toMinor(draft.salary.min, market),
      salaryMaxMinor: draft.salary.max ? toMinor(draft.salary.max, market) : null,
      salaryCurrency: market.currencyCode,
      salaryPeriod: draft.salary.period,
    },
    market.minorUnitScale,
  );
}

// ─── Policy (Wave 3 moderation reuse) ────────────────────────────────────────

const POLICY_BLOCK_MESSAGE =
  "هذا المحتوى غير مسموح به وفق سياسة السوق الحالية. راجع قواعد السوق قبل النشر.";

async function assertEmploymentContentPolicy(
  market: Market,
  actorId: string,
  text: string,
  location: { city?: string; area?: string },
  tx: any,
) {
  await assertAccountCanTransact(actorId, tx);
  assertMarketActive(market);
  assertPublicListingLocation({ city: location.city ?? "", area: location.area ?? "" });
  const rule = matchingPolicyRule(await activePolicyRules(market.id, tx), {
    resourceType: "JOB",
    text,
  });
  if (rule)
    throw Object.assign(new Error(POLICY_BLOCK_MESSAGE), {
      status: 409,
      code: "POLICY_RESTRICTED",
    });
}

function jobPolicyText(job: { title: string; description?: string; skills: readonly string[] }) {
  return [job.title, job.description ?? "", ...job.skills].join(" ");
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/** Publishes exactly one job per employer draft; retries return the same job. */
export async function publishJobDraft(input: {
  actorId: string;
  market: Market;
  draft: JobDraft;
}): Promise<{ job: JobRow; created: boolean }> {
  const draft = JobDraft.parse(input.draft);
  if (nextJobDraftField(draft) !== undefined || !draft.title || !draft.workplaceMode || !draft.employmentType)
    throw fail(400, "أكمل بيانات الوظيفة المطلوبة قبل النشر.");
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.ownerUserId, input.actorId), eq(jobs.publishKey, draft.draftId)));
    if (existing) return { job: existing, created: false };
    await assertEmploymentContentPolicy(
      input.market,
      input.actorId,
      jobPolicyText({ title: draft.title!, description: draft.description, skills: draft.skills }),
      { city: draft.city },
      tx,
    );
    const salary = draft.salary;
    const [inserted] = await tx
      .insert(jobs)
      .values({
        id: randomUUID(),
        ownerUserId: input.actorId,
        marketId: input.market.id,
        status: "PUBLISHED",
        title: draft.title!,
        description: draft.description ?? "",
        skills: draft.skills,
        minExperienceYears: draft.minExperienceYears ?? null,
        city: draft.city ?? "",
        workplaceMode: draft.workplaceMode!,
        employmentType: draft.employmentType!,
        salaryMinMinor: salary ? toMinor(salary.min, input.market) : null,
        salaryMaxMinor: salary?.max ? toMinor(salary.max, input.market) : null,
        salaryCurrency: salary ? input.market.currencyCode : null,
        salaryPeriod: salary ? salary.period : null,
        publishKey: draft.draftId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { job: inserted, created: true };
    // A concurrent confirmation won the unique (owner, publish key) race.
    const [winner] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.ownerUserId, input.actorId), eq(jobs.publishKey, draft.draftId)));
    return { job: winner!, created: false };
  });
}

export const JobChanges = z
  .object({
    title: z.string().trim().min(2).max(120).optional(),
    description: z.string().max(4000).optional(),
    addSkills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    removeSkills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    minExperienceYears: z.number().int().min(0).max(50).nullable().optional(),
    city: z.string().trim().min(2).max(60).optional(),
    workplaceMode: z.enum(WORKPLACE_MODES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    salary: z
      .object({
        min: z.number().positive().max(10_000_000),
        max: z.number().positive().max(10_000_000).optional(),
        period: z.enum(SALARY_PERIODS),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type JobChanges = z.infer<typeof JobChanges>;

async function ownedJobForUpdate(tx: any, jobId: string, actorId: string, market: Market) {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.ownerUserId, actorId), eq(jobs.marketId, market.id)))
    .for("update");
  if (!row) throw fail(404, "الوظيفة غير موجودة ضمن وظائفك.");
  return row as JobRow;
}

export async function updateOwnedJob(
  input: { jobId: string; actorId: string; market: Market; changes: JobChanges; expectedVersion?: number },
  tx: any = db,
): Promise<JobRow> {
  if (tx === db) return db.transaction((inner) => updateOwnedJob(input, inner));
  await assertAccountCanTransact(input.actorId, tx);
  const changes = JobChanges.parse(input.changes);
  const row = await ownedJobForUpdate(tx, input.jobId, input.actorId, input.market);
  await assertEmploymentResourceNotModerated(tx, "JOB", row.id);
  if (row.status === "ARCHIVED") throw fail(409, "لا يمكن تعديل وظيفة مؤرشفة.");
  if (input.expectedVersion !== undefined && row.version !== input.expectedVersion)
    throw fail(409, "تغيّرت الوظيفة منذ المعاينة. اطلب المعاينة من جديد.");
  let skills = [...row.skills];
  for (const skill of changes.removeSkills ?? [])
    skills = skills.filter((existing) => !sameSkill(existing, skill));
  for (const skill of changes.addSkills ?? [])
    if (!skills.some((existing) => sameSkill(existing, skill))) skills.push(skill);
  const workplaceMode = changes.workplaceMode ?? (row.workplaceMode as WorkplaceMode);
  const city = changes.city ?? row.city;
  if (workplaceMode !== "REMOTE" && !city) throw fail(400, "حدّد مدينة العمل لوظيفة غير عن بعد.");
  if (!skills.length) throw fail(400, "يجب أن تبقى مهارة واحدة على الأقل.");
  const next = {
    title: changes.title ?? row.title,
    description: changes.description ?? row.description,
    skills,
    minExperienceYears:
      changes.minExperienceYears === undefined ? row.minExperienceYears : changes.minExperienceYears,
    city,
    workplaceMode,
    employmentType: changes.employmentType ?? row.employmentType,
    ...(changes.salary === undefined
      ? {}
      : changes.salary === null
        ? { salaryMinMinor: null, salaryMaxMinor: null, salaryCurrency: null, salaryPeriod: null }
        : {
            salaryMinMinor: toMinor(changes.salary.min, input.market),
            salaryMaxMinor: changes.salary.max ? toMinor(changes.salary.max, input.market) : null,
            salaryCurrency: input.market.currencyCode,
            salaryPeriod: changes.salary.period,
          }),
  };
  if (["PUBLISHED", "PAUSED"].includes(row.status))
    await assertEmploymentContentPolicy(input.market, input.actorId, jobPolicyText(next), { city }, tx);
  const [updated] = await tx
    .update(jobs)
    .set({ ...next, version: row.version + 1, updatedAt: new Date() })
    .where(and(eq(jobs.id, row.id), eq(jobs.ownerUserId, input.actorId)))
    .returning();
  return updated;
}

export type JobStatusAction = "PAUSE" | "RESUME" | "CLOSE" | "ARCHIVE";

export async function changeOwnedJobStatus(
  input: { jobId: string; actorId: string; market: Market; action: JobStatusAction },
  tx: any = db,
): Promise<JobRow> {
  if (tx === db) return db.transaction((inner) => changeOwnedJobStatus(input, inner));
  await assertAccountCanTransact(input.actorId, tx);
  const row = await ownedJobForUpdate(tx, input.jobId, input.actorId, input.market);
  await assertEmploymentResourceNotModerated(tx, "JOB", row.id);
  const now = new Date();
  let set: Partial<JobRow>;
  if (input.action === "PAUSE") {
    if (row.status !== "PUBLISHED") throw fail(409, "يمكن إيقاف الوظائف المنشورة فقط.");
    set = { status: "PAUSED" };
  } else if (input.action === "RESUME") {
    if (row.status !== "PAUSED") throw fail(409, "يمكن إعادة نشر الوظائف الموقوفة فقط.");
    await assertEmploymentContentPolicy(input.market, input.actorId, jobPolicyText(row), { city: row.city }, tx);
    set = { status: "PUBLISHED" };
  } else if (input.action === "CLOSE") {
    if (!["PUBLISHED", "PAUSED"].includes(row.status)) throw fail(409, "هذه الوظيفة مغلقة أو مؤرشفة بالفعل.");
    set = { status: "CLOSED", closedAt: now };
  } else {
    if (row.status === "ARCHIVED") throw fail(409, "هذه الوظيفة مؤرشفة بالفعل.");
    set = { status: "ARCHIVED", archivedAt: now };
  }
  // Applications are never deleted; closing or archiving only stops new ones.
  const [updated] = await tx
    .update(jobs)
    .set({ ...set, updatedAt: now })
    .where(and(eq(jobs.id, row.id), eq(jobs.ownerUserId, input.actorId)))
    .returning();
  return updated;
}

/** The employer's own jobs in display order (newest publication first, stable under edits). */
export async function ownedJobs(actorId: string, market: Market, ids?: readonly string[]) {
  if (ids && !ids.length) return [];
  const rows: JobRow[] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.ownerUserId, actorId),
        eq(jobs.marketId, market.id),
        ...(ids ? [inArray(jobs.id, [...ids])] : [ne(jobs.status, "ARCHIVED")]),
      ),
    )
    .orderBy(desc(jobs.publishedAt), desc(jobs.id))
    .limit(24);
  return ids ? ids.flatMap((id) => rows.filter((row) => row.id === id)) : rows;
}

export const JobSearchState = z
  .object({
    terms: z.array(z.string().trim().min(1).max(60)).max(8),
    skills: z.array(z.string().trim().min(1).max(60)).max(10),
    city: z.string().trim().min(2).max(60).optional(),
    workplaceModes: z.array(z.enum(WORKPLACE_MODES)).max(3),
    employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(4),
    minSalary: z.number().positive().max(10_000_000).optional(),
    sort: z.enum(["RELEVANCE", "NEWEST", "SALARY_DESC"]),
  })
  .strict();
export type JobSearchState = z.infer<typeof JobSearchState>;

function jobText(row: JobRow): string {
  return normalizeEmploymentText([row.title, row.description, ...row.skills].join(" "));
}

function termMatches(text: string, term: string): boolean {
  return roleSearchTerms(term).some((alias) => {
    const folded = normalizeEmploymentText(alias);
    return folded.length > 0 && text.includes(folded);
  });
}

/** DINAR-internal job discovery: published jobs of active employers in this market only. */
export async function searchJobs(
  market: Market,
  state: JobSearchState,
  options: { allowedIds?: readonly string[] } = {},
): Promise<JobRow[]> {
  const query = JobSearchState.parse(state);
  if (options.allowedIds && !options.allowedIds.length) return [];
  const rows: { job: JobRow }[] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(users, eq(users.id, jobs.ownerUserId))
    .where(
      and(
        eq(jobs.marketId, market.id),
        eq(jobs.status, "PUBLISHED"),
        eq(users.status, "ACTIVE"),
        ...(options.allowedIds ? [inArray(jobs.id, [...options.allowedIds])] : []),
      ),
    )
    .orderBy(desc(jobs.publishedAt), desc(jobs.id))
    .limit(200);
  const minSalaryMinor = query.minSalary ? toMinor(query.minSalary, market) : undefined;
  const matched = rows
    .map(({ job }) => job)
    .filter((job) => {
      const text = jobText(job);
      if (!query.terms.every((term) => termMatches(text, term))) return false;
      if (!query.skills.every((skill) => job.skills.some((own) => sameSkill(own, skill)))) return false;
      if (query.city && !cityAliases(query.city).some((alias) => normalizeEmploymentText(alias) === normalizeEmploymentText(job.city)))
        return false;
      if (query.workplaceModes.length && !query.workplaceModes.includes(job.workplaceMode as WorkplaceMode)) return false;
      if (query.employmentTypes.length && !query.employmentTypes.includes(job.employmentType as EmploymentType)) return false;
      if (minSalaryMinor !== undefined && (job.salaryMaxMinor ?? job.salaryMinMinor ?? -1) < minSalaryMinor) return false;
      return true;
    });
  if (options.allowedIds)
    return options.allowedIds.flatMap((id) => matched.filter((job) => job.id === id));
  if (query.sort === "SALARY_DESC")
    return matched
      .filter((job) => job.salaryMinMinor != null)
      .sort((a, b) => (b.salaryMaxMinor ?? b.salaryMinMinor!) - (a.salaryMaxMinor ?? a.salaryMinMinor!))
      .slice(0, 24);
  return matched.slice(0, 24);
}

// ─── Candidate profiles ──────────────────────────────────────────────────────

export const ExperienceEntry = z
  .object({
    role: z.string().trim().min(2).max(120),
    organization: z.string().trim().max(120).optional(),
    startYear: z.number().int().min(1950).max(2100).optional(),
    endYear: z.number().int().min(1950).max(2100).optional(),
  })
  .strict();
export const EducationEntry = z
  .object({
    qualification: z.string().trim().max(120).optional(),
    field: z.string().trim().min(2).max(120),
    institution: z.string().trim().max(120).optional(),
  })
  .strict();

export const ProfileChanges = z
  .object({
    professionalTitle: z.string().trim().min(2).max(120).optional(),
    summary: z.string().trim().max(2000).optional(),
    addSkills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    removeSkills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    experienceYears: z.number().int().min(0).max(60).optional(),
    addExperience: ExperienceEntry.optional(),
    addEducation: EducationEntry.optional(),
    city: z.string().trim().min(2).max(60).optional(),
    workplacePreferences: z.array(z.enum(WORKPLACE_MODES)).max(3).optional(),
    employmentTypePreferences: z.array(z.enum(EMPLOYMENT_TYPES)).max(4).optional(),
    addPortfolioLink: z.string().trim().max(300).optional(),
    contactPhone: z.string().trim().max(30).nullable().optional(),
    visibility: z.enum(["PRIVATE", "DISCOVERABLE"]).optional(),
  })
  .strict();
export type ProfileChanges = z.infer<typeof ProfileChanges>;

export async function ownProfile(actorId: string, market?: Market): Promise<ProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(candidateProfiles)
    .where(
      market
        ? and(eq(candidateProfiles.userId, actorId), eq(candidateProfiles.marketId, market.id))
        : eq(candidateProfiles.userId, actorId),
    );
  return row;
}

/** Creates the actor's own profile once; the default is PRIVATE and contact-free. */
export async function ensureOwnProfile(actorId: string, market: Market, tx: any = db): Promise<ProfileRow> {
  let [row] = await tx
    .select()
    .from(candidateProfiles)
    .where(eq(candidateProfiles.userId, actorId))
    .for("update");
  if (row && row.marketId !== market.id) throw fail(409, PROFILE_MARKET_MISMATCH_MESSAGE);
  if (!row) {
    await tx
      .insert(candidateProfiles)
      .values({ id: randomUUID(), userId: actorId, marketId: market.id })
      .onConflictDoNothing();
    [row] = await tx.select().from(candidateProfiles).where(eq(candidateProfiles.userId, actorId));
  }
  if (!row) throw fail(500, "تعذر فتح الملف الوظيفي.");
  if (row.marketId !== market.id) throw fail(409, PROFILE_MARKET_MISMATCH_MESSAGE);
  return row as ProfileRow;
}

function validPortfolioLink(value: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw fail(400, "رابط الملف غير صالح.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw fail(400, "رابط الملف غير صالح.");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || url.username || url.password)
    throw fail(400, "رابط الملف غير صالح.");
  return url.toString().slice(0, 300);
}

/** Updates only the actor's own profile; user-stated facts are stored as given. */
export async function updateOwnProfile(
  actorId: string,
  market: Market,
  input: ProfileChanges,
): Promise<ProfileRow> {
  const changes = ProfileChanges.parse(input);
  return db.transaction(async (tx) => {
    await assertAccountCanTransact(actorId, tx);
    const current = await ensureOwnProfile(actorId, market, tx);
    await assertEmploymentResourceNotModerated(tx, "CANDIDATE_PROFILE", current.id);
    let skills = [...current.skills];
    for (const skill of changes.removeSkills ?? [])
      skills = skills.filter((existing) => !sameSkill(existing, skill));
    for (const skill of changes.addSkills ?? [])
      if (!skills.some((existing) => sameSkill(existing, skill))) skills.push(skill);
    const contactPhone =
      changes.contactPhone === undefined
        ? current.contactPhone
        : normalizeListingContactPhone(changes.contactPhone);
    const next = {
      professionalTitle: changes.professionalTitle ?? current.professionalTitle,
      summary: changes.summary ?? current.summary,
      skills: skills.slice(0, 40),
      experienceYears: changes.experienceYears ?? current.experienceYears,
      experiences: changes.addExperience
        ? [...current.experiences, changes.addExperience].slice(-20)
        : current.experiences,
      education: changes.addEducation
        ? [...current.education, changes.addEducation].slice(-10)
        : current.education,
      city: changes.city ?? current.city,
      workplacePreferences: changes.workplacePreferences ?? current.workplacePreferences,
      employmentTypePreferences: changes.employmentTypePreferences ?? current.employmentTypePreferences,
      portfolioLinks: changes.addPortfolioLink
        ? [...new Set([...current.portfolioLinks, validPortfolioLink(changes.addPortfolioLink)])].slice(-5)
        : current.portfolioLinks,
      contactPhone,
      contactMode: contactPhone ? "PROFILE_CONTACT" : "NO_DIRECT_CONTACT",
      visibility: changes.visibility ?? current.visibility,
    };
    if (next.visibility === "DISCOVERABLE") {
      if (!next.professionalTitle) throw fail(400, "أضف مسمى مهنيًا قبل إظهار ملفك لأصحاب العمل.");
      await assertEmploymentContentPolicy(
        market,
        actorId,
        [next.professionalTitle, next.summary, ...next.skills].join(" "),
        { city: next.city },
        tx,
      );
    } else {
      assertPublicListingLocation({ city: next.city, area: current.area });
    }
    const [updated] = await tx
      .update(candidateProfiles)
      .set({ ...next, updatedAt: new Date() })
      .where(and(eq(candidateProfiles.id, current.id), eq(candidateProfiles.userId, actorId)))
      .returning();
    return updated;
  });
}

export const CandidateSearchState = z
  .object({
    terms: z.array(z.string().trim().min(1).max(60)).max(8),
    skills: z.array(z.string().trim().min(1).max(60)).max(10),
    city: z.string().trim().min(2).max(60).optional(),
    minExperienceYears: z.number().int().min(0).max(60).optional(),
    workplaceModes: z.array(z.enum(WORKPLACE_MODES)).max(3),
  })
  .strict();
export type CandidateSearchState = z.infer<typeof CandidateSearchState>;

/**
 * Discoverable, active candidates in this market. Only job-related fields are
 * queried; the input type has no slot for any personal characteristic.
 */
export async function searchCandidates(
  market: Market,
  viewerId: string,
  state: CandidateSearchState,
  options: { allowedIds?: readonly string[] } = {},
): Promise<ProfileRow[]> {
  const query = CandidateSearchState.parse(state);
  if (options.allowedIds && !options.allowedIds.length) return [];
  const rows: { profile: ProfileRow }[] = await db
    .select({ profile: candidateProfiles })
    .from(candidateProfiles)
    .innerJoin(users, eq(users.id, candidateProfiles.userId))
    .where(
      and(
        eq(candidateProfiles.marketId, market.id),
        eq(candidateProfiles.visibility, "DISCOVERABLE"),
        eq(users.status, "ACTIVE"),
        ne(candidateProfiles.userId, viewerId),
        ...(options.allowedIds ? [inArray(candidateProfiles.id, [...options.allowedIds])] : []),
      ),
    )
    .orderBy(desc(candidateProfiles.updatedAt), desc(candidateProfiles.id))
    .limit(200);
  const matched = rows
    .map(({ profile }) => profile)
    .filter((profile) => {
      const text = normalizeEmploymentText(
        [profile.professionalTitle, ...profile.skills, ...profile.experiences.map((entry) => String(entry.role ?? ""))].join(" "),
      );
      if (!query.terms.every((term) => termMatches(text, term))) return false;
      if (!query.skills.every((skill) => profile.skills.some((own) => sameSkill(own, skill)))) return false;
      if (query.city && !cityAliases(query.city).some((alias) => normalizeEmploymentText(alias) === normalizeEmploymentText(profile.city)))
        return false;
      if (query.minExperienceYears !== undefined && (profile.experienceYears ?? -1) < query.minExperienceYears)
        return false;
      if (
        query.workplaceModes.length &&
        profile.workplacePreferences.length &&
        !query.workplaceModes.some((mode) => profile.workplacePreferences.includes(mode))
      )
        return false;
      return true;
    });
  if (options.allowedIds)
    return options.allowedIds.flatMap((id) => matched.filter((profile) => profile.id === id));
  return matched.slice(0, 24);
}

// ─── Matching (transparent, job-related only) ────────────────────────────────

/** The only job fields matching may read. */
export type JobMatchInput = {
  skills: readonly string[];
  minExperienceYears: number | null;
  workplaceMode: string;
  employmentType: string;
  city: string;
};
/** The only candidate fields matching may read: no name, photo, age or personal trait. */
export type CandidateMatchInput = {
  skills: readonly string[];
  experienceYears: number | null;
  workplacePreferences: readonly string[];
  employmentTypePreferences: readonly string[];
  city: string;
};
export type MatchSignal = {
  kind: "SKILL" | "EXPERIENCE" | "WORKPLACE" | "EMPLOYMENT_TYPE" | "LOCATION";
  status: "MET" | "NOT_MET" | "UNKNOWN";
  label: string;
};

export function jobMatchInput(row: JobMatchInput): JobMatchInput {
  return {
    skills: row.skills,
    minExperienceYears: row.minExperienceYears,
    workplaceMode: row.workplaceMode,
    employmentType: row.employmentType,
    city: row.city,
  };
}

export function candidateMatchInput(row: CandidateMatchInput): CandidateMatchInput {
  return {
    skills: row.skills,
    experienceYears: row.experienceYears,
    workplacePreferences: row.workplacePreferences,
    employmentTypePreferences: row.employmentTypePreferences,
    city: row.city,
  };
}

/**
 * Explainable signals comparing declared job requirements with declared candidate
 * facts. Signals inform a human; they never hire, reject or shortlist anyone.
 */
export function matchSignals(job: JobMatchInput, candidate: CandidateMatchInput): MatchSignal[] {
  const signals: MatchSignal[] = job.skills.map((skill) => {
    const met = candidate.skills.some((own) => sameSkill(own, skill));
    return {
      kind: "SKILL",
      status: met ? "MET" : "NOT_MET",
      label: met ? `مهارة ${skill} مطابقة` : `مهارة ${skill} غير مذكورة في الملف`,
    };
  });
  if (job.minExperienceYears != null && job.minExperienceYears > 0) {
    signals.push(
      candidate.experienceYears == null
        ? { kind: "EXPERIENCE", status: "UNKNOWN", label: `الحد الأدنى ${job.minExperienceYears} سنوات؛ الخبرة غير مذكورة` }
        : candidate.experienceYears >= job.minExperienceYears
          ? { kind: "EXPERIENCE", status: "MET", label: `${candidate.experienceYears} سنوات خبرة تحقق الحد الأدنى ${job.minExperienceYears}` }
          : { kind: "EXPERIENCE", status: "NOT_MET", label: `${candidate.experienceYears} سنوات خبرة أقل من الحد الأدنى المعلن ${job.minExperienceYears}` },
    );
  }
  const mode = job.workplaceMode as WorkplaceMode;
  if (candidate.workplacePreferences.length) {
    const met = candidate.workplacePreferences.includes(mode);
    signals.push({
      kind: "WORKPLACE",
      status: met ? "MET" : "NOT_MET",
      label: met
        ? `تفضيل العمل ${WORKPLACE_LABELS[mode]} يطابق الوظيفة`
        : `يفضّل المرشح ${candidate.workplacePreferences.map((value) => WORKPLACE_LABELS[value as WorkplaceMode]).join(" أو ")}؛ الوظيفة ${WORKPLACE_LABELS[mode]}`,
    });
  }
  const type = job.employmentType as EmploymentType;
  if (candidate.employmentTypePreferences.length) {
    const met = candidate.employmentTypePreferences.includes(type);
    signals.push({
      kind: "EMPLOYMENT_TYPE",
      status: met ? "MET" : "NOT_MET",
      label: met
        ? `نوع الدوام ${EMPLOYMENT_LABELS[type]} مطابق`
        : `يفضّل المرشح ${candidate.employmentTypePreferences.map((value) => EMPLOYMENT_LABELS[value as EmploymentType]).join(" أو ")}؛ الوظيفة ${EMPLOYMENT_LABELS[type]}`,
    });
  }
  if (mode !== "REMOTE" && job.city && candidate.city) {
    const met = cityAliases(job.city).some((alias) => normalizeEmploymentText(alias) === normalizeEmploymentText(candidate.city));
    signals.push({
      kind: "LOCATION",
      status: met ? "MET" : "NOT_MET",
      label: met ? `المدينة ${job.city} مطابقة` : `مدينة المرشح ${candidate.city}؛ مكان العمل ${job.city}`,
    });
  }
  return signals;
}

/** Ordering aid only: the number of met declared criteria. Never a decision. */
export function relevanceOrder(signals: readonly MatchSignal[]): number {
  return signals.filter((signal) => signal.status === "MET").length;
}

// ─── Applications ────────────────────────────────────────────────────────────

function jobSnapshot(job: JobRow, scale: number) {
  return {
    title: job.title,
    version: job.version,
    city: job.city,
    workplaceMode: job.workplaceMode,
    employmentType: job.employmentType,
    salary: salarySummary(job, scale),
    skills: job.skills,
  };
}

function candidateSnapshot(profile: ProfileRow) {
  return {
    professionalTitle: profile.professionalTitle,
    skills: profile.skills,
    experienceYears: profile.experienceYears,
    city: profile.city,
    workplacePreferences: profile.workplacePreferences,
    employmentTypePreferences: profile.employmentTypePreferences,
  };
}

/** What an application review needs before anything is submitted. */
export async function applicationReadiness(
  actorId: string,
  market: Market,
  jobId: string,
): Promise<
  | { ok: true; job: JobRow; profile: ProfileRow; existing?: ApplicationRow }
  | {
      ok: false;
      reason: "JOB_UNAVAILABLE" | "OWN_JOB" | "PROFILE_INCOMPLETE" | "PROFILE_MARKET_MISMATCH";
      job?: JobRow;
    }
> {
  await assertAccountCanTransact(actorId);
  const [job] = await searchJobs(market, emptyJobSearch(), { allowedIds: [jobId] });
  if (!job) return { ok: false, reason: "JOB_UNAVAILABLE" };
  if (job.ownerUserId === actorId) return { ok: false, reason: "OWN_JOB", job };
  const profile = await ownProfile(actorId);
  if (profile && profile.marketId !== market.id) return { ok: false, reason: "PROFILE_MARKET_MISMATCH", job };
  if (!profile?.professionalTitle) return { ok: false, reason: "PROFILE_INCOMPLETE", job };
  const [existing] = await db
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.jobId, job.id), eq(jobApplications.candidateUserId, actorId)));
  return { ok: true, job, profile, ...(existing ? { existing } : {}) };
}

/** One logical application per candidate and job; a repeat returns the existing one. */
export async function submitApplication(input: {
  actorId: string;
  market: Market;
  jobId: string;
}): Promise<{ application: ApplicationRow; created: boolean }> {
  return db.transaction(async (tx) => {
    await assertAccountCanTransact(input.actorId, tx);
    const [job] = await tx
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(users, eq(users.id, jobs.ownerUserId))
      .where(
        and(
          eq(jobs.id, input.jobId),
          eq(jobs.marketId, input.market.id),
          eq(users.status, "ACTIVE"),
        ),
      )
      .for("share", { of: jobs });
    const [profile] = await tx
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.userId, input.actorId))
      .for("share");
    if (profile && profile.marketId !== input.market.id) throw fail(409, PROFILE_MARKET_MISMATCH_MESSAGE);
    if (profile) await assertEmploymentResourceNotModerated(tx, "CANDIDATE_PROFILE", profile.id);
    const [existing] = await tx
      .select()
      .from(jobApplications)
      .where(and(eq(jobApplications.jobId, input.jobId), eq(jobApplications.candidateUserId, input.actorId)));
    if (existing) return { application: existing, created: false };
    if (!job || job.job.status !== "PUBLISHED")
      throw fail(409, "هذه الوظيفة لا تستقبل طلبات جديدة.");
    if (job.job.ownerUserId === input.actorId) throw fail(409, "لا يمكنك التقديم على وظيفتك.");
    if (!profile?.professionalTitle) throw fail(400, "أكمل ملفك الوظيفي قبل التقديم.");
    const [inserted] = await tx
      .insert(jobApplications)
      .values({
        id: randomUUID(),
        jobId: job.job.id,
        candidateUserId: input.actorId,
        candidateProfileId: profile.id,
        marketId: input.market.id,
        jobSnapshot: jobSnapshot(job.job, input.market.minorUnitScale),
        candidateSnapshot: candidateSnapshot(profile),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { application: inserted, created: true };
    const [winner] = await tx
      .select()
      .from(jobApplications)
      .where(and(eq(jobApplications.jobId, input.jobId), eq(jobApplications.candidateUserId, input.actorId)));
    return { application: winner!, created: false };
  });
}

export async function withdrawOwnApplication(
  input: { actorId: string; market: Market; applicationId: string },
  tx: any = db,
): Promise<ApplicationRow> {
  if (tx === db) return db.transaction((inner) => withdrawOwnApplication(input, inner));
  await assertAccountCanTransact(input.actorId, tx);
  const [row] = await tx
    .select()
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.id, input.applicationId),
        eq(jobApplications.candidateUserId, input.actorId),
        eq(jobApplications.marketId, input.market.id),
      ),
    )
    .for("update");
  if (!row) throw fail(404, "الطلب غير موجود ضمن طلباتك.");
  if (row.status === "WITHDRAWN") return row;
  const now = new Date();
  const [updated] = await tx
    .update(jobApplications)
    .set({ status: "WITHDRAWN", withdrawnAt: now, updatedAt: now })
    .where(and(eq(jobApplications.id, row.id), eq(jobApplications.candidateUserId, input.actorId)))
    .returning();
  return updated;
}

export type EmployerApplicationStatus = "SHORTLISTED" | "REJECTED";

/** A human employer's explicit decision on one application of their own job. */
export async function changeApplicationStatus(
  input: { actorId: string; market: Market; applicationId: string; status: EmployerApplicationStatus },
  tx: any = db,
): Promise<ApplicationRow> {
  if (tx === db) return db.transaction((inner) => changeApplicationStatus(input, inner));
  await assertAccountCanTransact(input.actorId, tx);
  const [row] = await tx
    .select({ application: jobApplications })
    .from(jobApplications)
    .innerJoin(jobs, eq(jobs.id, jobApplications.jobId))
    .where(
      and(
        eq(jobApplications.id, input.applicationId),
        eq(jobs.ownerUserId, input.actorId),
        eq(jobs.marketId, input.market.id),
      ),
    )
    .for("update", { of: jobApplications });
  if (!row) throw fail(404, "المتقدم غير موجود ضمن طلبات وظائفك.");
  if (row.application.status === "WITHDRAWN") throw fail(409, "سحب المتقدم طلبه؛ لا يمكن تغيير حالته.");
  const now = new Date();
  const [updated] = await tx
    .update(jobApplications)
    .set({ status: input.status, statusChangedBy: input.actorId, statusChangedAt: now, updatedAt: now })
    .where(eq(jobApplications.id, row.application.id))
    .returning();
  return updated;
}

export async function ownApplications(actorId: string, market: Market, ids?: readonly string[]) {
  if (ids && !ids.length) return [];
  const rows: { application: ApplicationRow; job: JobRow }[] = await db
    .select({ application: jobApplications, job: jobs })
    .from(jobApplications)
    .innerJoin(jobs, eq(jobs.id, jobApplications.jobId))
    .where(
      and(
        eq(jobApplications.candidateUserId, actorId),
        eq(jobApplications.marketId, market.id),
        eq(jobs.marketId, market.id),
        ...(ids ? [inArray(jobApplications.id, [...ids])] : []),
      ),
    )
    .orderBy(desc(jobApplications.submittedAt), desc(jobApplications.id))
    .limit(24);
  return ids ? ids.flatMap((id) => rows.filter((row) => row.application.id === id)) : rows;
}

/**
 * Applications for one of the employer's own jobs. Opening the list is the
 * employer's own action, so unseen applications become VIEWED.
 */
export async function applicationsForOwnedJob(
  actorId: string,
  market: Market,
  jobId: string,
  ids?: readonly string[],
) {
  const [job] = await ownedJobs(actorId, market, [jobId]);
  if (!job) throw fail(404, "الوظيفة غير موجودة ضمن وظائفك.");
  if (ids && !ids.length) return { job, applications: [] };
  const rows: { application: ApplicationRow; profile: ProfileRow; candidateStatus: string }[] = await db
    .select({ application: jobApplications, profile: candidateProfiles, candidateStatus: users.status })
    .from(jobApplications)
    .innerJoin(candidateProfiles, eq(candidateProfiles.id, jobApplications.candidateProfileId))
    .innerJoin(users, eq(users.id, candidateProfiles.userId))
    .where(
      and(
        eq(jobApplications.jobId, job.id),
        eq(jobApplications.marketId, market.id),
        eq(candidateProfiles.marketId, market.id),
        ...(ids ? [inArray(jobApplications.id, [...ids])] : []),
      ),
    )
    .orderBy(jobApplications.submittedAt, jobApplications.id)
    .limit(50);
  const unseen = rows
    .filter((row) => row.application.status === "SUBMITTED")
    .map((row) => row.application.id);
  if (unseen.length) {
    const [owner] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, actorId));
    if (owner?.status === "ACTIVE") {
      const now = new Date();
      await db
        .update(jobApplications)
        .set({ status: "VIEWED", statusChangedBy: actorId, statusChangedAt: now, updatedAt: now })
        .where(and(inArray(jobApplications.id, unseen), eq(jobApplications.status, "SUBMITTED")));
      for (const row of rows) if (unseen.includes(row.application.id)) row.application.status = "VIEWED";
    }
  }
  const ordered = ids ? ids.flatMap((id) => rows.filter((row) => row.application.id === id)) : rows;
  return { job, applications: ordered };
}

export async function applicationCounts(jobIds: readonly string[]): Promise<Map<string, number>> {
  if (!jobIds.length) return new Map();
  const rows: { jobId: string; count: number }[] = await db
    .select({ jobId: jobApplications.jobId, count: sql<number>`count(*)::int` })
    .from(jobApplications)
    .where(and(inArray(jobApplications.jobId, [...jobIds]), ne(jobApplications.status, "WITHDRAWN")))
    .groupBy(jobApplications.jobId);
  return new Map(rows.map((row) => [row.jobId, row.count]));
}

export function emptyJobSearch(): JobSearchState {
  return { terms: [], skills: [], workplaceModes: [], employmentTypes: [], sort: "NEWEST" };
}

// ─── Allowlisted views ───────────────────────────────────────────────────────

export function publicJobView(row: JobRow, scale: number) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    skills: row.skills,
    minExperienceYears: row.minExperienceYears,
    city: row.city,
    workplaceMode: row.workplaceMode,
    employmentType: row.employmentType,
    salary: salarySummary(row, scale),
    publishedAt: row.publishedAt.toISOString(),
  };
}

export function ownerJobView(row: JobRow, scale: number, applicationCount: number) {
  return {
    ...publicJobView(row, scale),
    status: row.status,
    applicationCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function experienceView(entries: readonly Record<string, unknown>[]) {
  return entries.flatMap((entry) => {
    const parsed = ExperienceEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function educationView(entries: readonly Record<string, unknown>[]) {
  return entries.flatMap((entry) => {
    const parsed = EducationEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What an employer may see of a discoverable or applying candidate. */
export function candidateCardView(row: ProfileRow, options: { allowContact?: boolean } = {}) {
  const allowContact = options.allowContact ?? row.visibility === "DISCOVERABLE";
  return {
    id: row.id,
    professionalTitle: row.professionalTitle,
    skills: row.skills,
    experienceYears: row.experienceYears,
    experiences: experienceView(row.experiences),
    education: educationView(row.education),
    city: row.city,
    workplacePreferences: row.workplacePreferences,
    employmentTypePreferences: row.employmentTypePreferences,
    portfolioLinks: row.portfolioLinks,
    // Only a phone the candidate deliberately added to this profile; never the login phone.
    contactPhone: allowContact && row.contactMode === "PROFILE_CONTACT" ? row.contactPhone : null,
  };
}

/** The candidate's own view, including privacy settings. */
export function ownProfileView(row: ProfileRow) {
  return {
    ...candidateCardView(row, { allowContact: true }),
    summary: row.summary,
    visibility: row.visibility,
    contactMode: row.contactMode,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function candidateApplicationView(row: { application: ApplicationRow; job: JobRow }, scale: number) {
  return {
    id: row.application.id,
    status: row.application.status,
    submittedAt: row.application.submittedAt.toISOString(),
    job: {
      id: row.job.id,
      title: row.job.title,
      status: row.job.status,
      city: row.job.city,
      workplaceMode: row.job.workplaceMode,
      employmentType: row.job.employmentType,
      salary: salarySummary(row.job, scale),
    },
    // What the candidate applied to, even if the job changed later.
    submittedJob: {
      title: String(row.application.jobSnapshot.title ?? row.job.title),
      salary: (row.application.jobSnapshot.salary as string | null | undefined) ?? null,
      version: Number(row.application.jobSnapshot.version ?? 1),
    },
  };
}

export function employerApplicationView(
  row: { application: ApplicationRow; profile: ProfileRow; candidateStatus: string },
  job: JobRow,
) {
  const snapshot = row.application.candidateSnapshot;
  const historicalCandidate = {
    professionalTitle: typeof snapshot.professionalTitle === "string" ? snapshot.professionalTitle : "",
    skills: Array.isArray(snapshot.skills) ? snapshot.skills.map(String) : [],
    experienceYears: typeof snapshot.experienceYears === "number" ? snapshot.experienceYears : null,
    city: typeof snapshot.city === "string" ? snapshot.city : "",
    workplacePreferences: Array.isArray(snapshot.workplacePreferences)
      ? snapshot.workplacePreferences.map(String)
      : [],
    employmentTypePreferences: Array.isArray(snapshot.employmentTypePreferences)
      ? snapshot.employmentTypePreferences.map(String)
      : [],
  };
  const canShowCurrentContact =
    row.candidateStatus === "ACTIVE" &&
    row.profile.visibility === "DISCOVERABLE" &&
    row.profile.contactMode === "PROFILE_CONTACT";
  return {
    id: row.application.id,
    status: row.application.status,
    submittedAt: row.application.submittedAt.toISOString(),
    submitted: {
      professionalTitle: historicalCandidate.professionalTitle,
      skills: historicalCandidate.skills,
      experienceYears: historicalCandidate.experienceYears,
      city: historicalCandidate.city,
    },
    // Never read current CV fields into application history. Contact alone is
    // live because the candidate's current privacy and account state control it.
    candidate: {
      id: row.profile.id,
      ...historicalCandidate,
      experiences: [],
      education: [],
      portfolioLinks: [],
      contactPhone: canShowCurrentContact ? row.profile.contactPhone : null,
    },
    submittedJobVersion: Number(row.application.jobSnapshot.version ?? 1),
    signals: matchSignals(jobMatchInput(job), candidateMatchInput(historicalCandidate)),
  };
}
