/**
 * Employment inside the shared DINAR conversation runtime.
 *
 * This is an intent and query adapter, not a second runtime: every list, opened
 * item, draft and pending action is an ordinary `ai_result_sets` row of kind
 * EMPLOYMENT, rendered as an ordinary SURFACE block. Ordinals resolve only
 * against those server-stored rows, and every mutation is a pending action that
 * an explicit confirmation from the same actor must apply.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
import {
  aiResultSets,
  aiUiBlocks,
  candidateProfiles,
  conversations,
  db,
  jobApplications,
  jobs,
  users,
} from "@workspace/db";
import type { marketFor } from "../lib/markets";
import { extractListingContactPhone } from "../lib/listing-contact";
import {
  CandidateSearchState,
  JOB_FIELD_PROMPTS,
  JobChanges,
  JobDraft,
  JobSearchState,
  ProfileChanges,
  applicationCounts,
  applicationReadiness,
  applicationsForOwnedJob,
  candidateApplicationView,
  candidateCardView,
  candidateMatchInput,
  changeApplicationStatus,
  changeOwnedJobStatus,
  draftSalarySummary,
  emptyJobSearch,
  employerApplicationView,
  ensureOwnProfile,
  jobMatchInput,
  matchSignals,
  nextJobDraftField,
  ownApplications,
  ownProfile,
  ownProfileView,
  ownedJobs,
  ownerJobView,
  publicJobView,
  publishJobDraft,
  relevanceOrder,
  searchCandidates,
  searchJobs,
  submitApplication,
  updateOwnProfile,
  updateOwnedJob,
  withdrawOwnApplication,
  type JobStatusAction,
} from "../lib/employment";
import { backIntent } from "./intent";
import { findOrdinalMention, parseResultReference } from "./arabic-normalization";
import {
  EMPLOYMENT_LABELS,
  WORKPLACE_LABELS,
  automaticDecisionRequested,
  canonicalSkill,
  cityAliasWords,
  employmentOrdinal,
  noSalaryAnswer,
  normalizeEmploymentText,
  parseCity,
  parseEmploymentTypes,
  parseExperienceYears,
  parseKnownSkills,
  parseRole,
  parseSalary,
  parseSkillList,
  parseWorkplaceModes,
  protectedTraitsRequested,
  roleAliasWords,
  skillAliasWords,
  type EmploymentType,
  type WorkplaceMode,
} from "./employment-parser";
import type { ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

export const EMPLOYMENT_SURFACES = CONVERSATION_SURFACE_FAMILIES.employment;
export type EmploymentSurface = (typeof EMPLOYMENT_SURFACES)[number];

/** A pending action expires quickly and whenever the conversation moves on. */
export const EMPLOYMENT_PENDING_TTL_MS = 15 * 60 * 1000;

/** Stored lifetime of an employment result set; pending actions live only briefly. */
export function employmentStateExpiry(query: unknown, now = Date.now()): Date | undefined {
  const parsed = EmploymentQuery.safeParse(query);
  if (!parsed.success) return undefined;
  return new Date(now + (parsed.data.view === "PENDING_ACTION" ? EMPLOYMENT_PENDING_TTL_MS : 30 * 24 * 60 * 60 * 1000));
}

const PendingAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PUBLISH_JOB"), draft: JobDraft }).strict(),
  z
    .object({
      type: z.literal("UPDATE_JOB"),
      jobId: z.string().min(1),
      changes: JobChanges,
      expectedVersion: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("JOB_STATUS"),
      jobId: z.string().min(1),
      statusAction: z.enum(["PAUSE", "RESUME", "CLOSE", "ARCHIVE"]),
    })
    .strict(),
  z.object({ type: z.literal("APPLY"), jobId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("WITHDRAW"), applicationId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("APPLICATION_STATUS"),
      jobId: z.string().min(1),
      applicationId: z.string().min(1),
      status: z.enum(["SHORTLISTED", "REJECTED"]),
    })
    .strict(),
]);
type PendingAction = z.infer<typeof PendingAction>;
const ActionStatus = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"]);

const EmploymentQuery = z
  .object({
    kind: z.literal("EMPLOYMENT"),
    ownerId: z.string().min(1),
    view: z.enum([
      "JOB_SEARCH",
      "JOB",
      "MY_JOBS",
      "JOB_DRAFT",
      "PROFILE",
      "CANDIDATE_SEARCH",
      "CANDIDATE",
      "APPLICATION_LIST",
      "MY_APPLICATIONS",
      "PENDING_ACTION",
      "NOTICE",
    ]),
    jobSearch: JobSearchState.optional(),
    candidateSearch: CandidateSearchState.optional(),
    jobId: z.string().optional(),
    audience: z.enum(["PUBLIC", "OWNER"]).optional(),
    parentResultSetId: z.string().optional(),
    draft: JobDraft.optional(),
    action: PendingAction.optional(),
    status: ActionStatus.optional(),
  })
  .strict();
type EmploymentQuery = z.infer<typeof EmploymentQuery>;
type StoredSet = typeof aiResultSets.$inferSelect;

export function isEmploymentQuery(query: unknown): boolean {
  return (query as { kind?: unknown } | null)?.kind === "EMPLOYMENT";
}

// ─── Phrases ─────────────────────────────────────────────────────────────────

const CONFIRM =
  /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نعم اكد|نعم انشر|انشر|نشر|انشرها|انشر الوظيفة|تاكيد النشر|تاكيد التقديم|قدم|نعم قدم|اسحب|نعم اسحب|تاكيد السحب|تاكيد التغيير|نفذ)$/u;
/** Bare agreement words; command words like «قدم» stay commands when nothing is pending. */
const GENERIC_CONFIRM = /^(?:نعم|اكيد|اكد|تاكيد|موافق|تمام|اوكي|ok|yes|نعم اكد|نفذ)$/u;
const CANCEL = /^(?:لا|كلا|الغاء|الغ|الغي|الغيه|الغيها|تراجع|لا تنشر|لا تقدم|الغ الوظيفة|الغ الاعلان|الغ الطلب|لا شكرا)$/u;

const has = (text: string, pattern: RegExp) => pattern.test(text);

function rawAfter(message: string, keyword: RegExp): string | undefined {
  const match = keyword.exec(message);
  if (!match) return undefined;
  return message.slice(match.index + match[0].length).trim().replace(/^[:：\-–]\s*/, "").trim();
}

/** A trailing target number in a command: "... إلى 800", "... من 600 إلى 800". */
function targetSalary(message: string) {
  const text = normalizeEmploymentText(message);
  const range = text.match(/(?:الى|الي|ل|يصير|ليصبح)\s+(?:من\s+)?(\d{1,7})\s*(?:الى|الي|-|حتى|حتي)\s*(\d{1,7})\s*$/u);
  if (range) return { min: Number(range[1]), max: Number(range[2]), period: parseSalary(message)?.period ?? "MONTH" as const };
  const single = text.match(/(?:الى|الي|ل|يصير|ليصبح|ب)\s*(\d{1,7})(?:\s+(?:دينار|دنانير|ريال|دولار|شهريا|بالشهر))*\s*$/u);
  if (single) return { min: Number(single[1]), period: parseSalary(message)?.period ?? "MONTH" as const };
  return parseSalary(message);
}

/** Role/title phrase stated after a role noun, kept in the user's own spelling. */
export function statedJobTitle(message: string): string | undefined {
  const match = message.match(
    /(?:موظف[ةه]?|موظفين|وظيفة|وظيفه|مطلوب)\s+(?!(?:في|ب|على|لي|عن)\s)(.+?)(?=\s+(?:في|ب|بمدينة|براتب|راتب|بخبرة|خبرة|خبره|دوام|عن بعد|ريموت|حضوري|هجين|يعرف|عنده|مع|و?مهارات)(?:\s|$)|[،,.]|$)/u,
  );
  let title = match?.[1]?.trim();
  if (!title || title.length < 2 || title.length > 80) return undefined;
  if (/^(?:جديد|جديدة|لي|عندي)$/u.test(title)) return undefined;
  // A bare technology role ("Front-end") names a developer role; the review shows it for correction.
  if (/^[A-Za-z][A-Za-z.+#\s-]*$/.test(title) && !/(?:developer|engineer|designer|manager|analyst|lead|specialist|accountant)/i.test(title))
    title = `${title} Developer`;
  return title;
}

const LABELLED_TITLE =
  /(?:خلي|خلّي|غير|غيّر|عدل|اجعل)?\s*(?:ال)?مسمى(?:\s+الوظيفي)?\s*(?:الى|إلى|ل|يكون|:)?\s*/u;

export function labelledTitle(message: string): string | undefined {
  if (!/مسمى/u.test(message)) return undefined;
  const value = rawAfter(message, LABELLED_TITLE)?.replace(/^(?:الى|إلى)\s+/u, "").trim();
  return value && value.length >= 2 && value.length <= 120 ? value : undefined;
}

function addOrRemoveSkills(message: string): { add: string[]; remove: string[] } {
  const text = normalizeEmploymentText(message);
  const remove = /^(?:احذف|حذف|امسح|شيل|ازل|ازالة)\s/u.test(text);
  const add = /^(?:اضف|ضيف|زيد|اضافة|حط)\s/u.test(text) || /(?:اني|انني)\s+(?:اعرف|اتقن)/u.test(text);
  if (!remove && !add) return { add: [], remove: [] };
  const body = message
    .replace(/^\s*(?:أضف|اضف|ضيف|زيد|إضافة|اضافة|حط|احذف|حذف|امسح|شيل|أزل|ازل)\s+/u, "")
    .replace(/^(?:أن(?:ي|ني)?|ان(?:ي|ني)?)\s+(?:أعرف|اعرف|أتقن|اتقن)\s+/u, "")
    .replace(/^(?:مهارة|مهارات|المهارة)\s+/u, "");
  const skills = parseSkillList(body);
  // Words naming the CV, profile or a job are never skills.
  const fallback = skills.length
    ? skills
    : body.split(/\s*(?:،|,|\s+و\s*)\s*/u).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 40 && item.split(/\s+/).length <= 3 && !/(?:سير|ملف|وظيف|اعلان|طلب|رقم|تواصل)/u.test(normalizeEmploymentText(item)));
  return remove ? { add: [], remove: fallback.map(canonicalSkill) } : { add: fallback.map(canonicalSkill), remove: [] };
}

// ─── Parsing requests ────────────────────────────────────────────────────────

const STOP_WORDS = new Set(
  [
    "اريد", "ابحث", "عن", "بدي", "ابغي", "ابي", "احتاج", "دور", "دورلي", "لي", "على", "علي", "في", "من", "الى", "و",
    "وظيفة", "وظيفه", "وظائف", "شغل", "عمل", "فرصة", "فرص", "مجال", "كـ", "ك", "مع", "او", "اللي", "يكون", "عنده", "عندها",
    "خبرة", "خبره", "سنة", "سنه", "سنوات", "سنين", "سنتين", "دوام", "كامل", "جزئي", "عن بعد", "بعد", "ريموت", "حضوري", "هجين",
    "هايبرد", "عقد", "تدريب", "راتب", "براتب", "فوق", "اكثر", "اقل", "مرشح", "مرشحا", "مرشحين", "مرشحة", "موظف", "موظفين", "شخص",
    "مدينة", "بمدينة", "الاحدث", "احدث", "الاعلى", "اعلى", "رتب", "حسب", "دينار", "شهريا", "remote", "job", "jobs", "a",
  ].map(normalizeEmploymentText),
);

let consumedPattern: RegExp | undefined;

/** Content words not consumed by any structured lexicon become required text terms. */
function leftoverTerms(text: string): string[] {
  // One alternation, longest phrases first, compiled once: linear in the message length.
  consumedPattern ??= new RegExp(
    `\\s(?:و|ب|ل|ف)?(?:ال)?(?:${[...new Set([...roleAliasWords(), ...skillAliasWords(), ...cityAliasWords()])]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})(?=\\s)`,
    "gu",
  );
  return ` ${text} `
    .replace(consumedPattern, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
    .slice(0, 4);
}

function sortIntent(text: string): JobSearchState["sort"] | undefined {
  if (/(?:الاعلي|اعلي|الاعلى|اعلى|الاكبر)\s+(?:راتب|راتبا)/u.test(text)) return "SALARY_DESC";
  if (/(?:الاحدث|احدث|الجديدة|الجديد)/u.test(text)) return "NEWEST";
  return undefined;
}

export function parseJobSearch(message: string): JobSearchState {
  const text = normalizeEmploymentText(message);
  const role = parseRole(message);
  const skills = parseKnownSkills(message).filter((skill) => !role || normalizeEmploymentText(skill) !== normalizeEmploymentText(role));
  const salary = parseSalary(message);
  return {
    terms: [...(role ? [role] : []), ...leftoverTerms(text)].slice(0, 6),
    skills,
    ...(parseCity(message) ? { city: parseCity(message)! } : {}),
    workplaceModes: parseWorkplaceModes(message),
    employmentTypes: parseEmploymentTypes(message),
    ...(salary && /(?:فوق|اكثر|علي الاقل|على الاقل|من)/u.test(text) ? { minSalary: salary.min } : {}),
    sort: sortIntent(text) ?? "NEWEST",
  };
}

function hasJobConstraints(state: JobSearchState): boolean {
  return Boolean(
    state.terms.length || state.skills.length || state.city || state.workplaceModes.length ||
      state.employmentTypes.length || state.minSalary,
  );
}

function refineJobSearch(previous: JobSearchState, message: string): JobSearchState | undefined {
  const next = parseJobSearch(message);
  const sort = sortIntent(normalizeEmploymentText(message));
  if (!hasJobConstraints(next) && !sort) return undefined;
  return {
    terms: [...new Set([...previous.terms, ...next.terms])].slice(0, 8),
    skills: [...new Set([...previous.skills, ...next.skills])].slice(0, 10),
    ...(next.city ?? previous.city ? { city: next.city ?? previous.city } : {}),
    workplaceModes: next.workplaceModes.length ? next.workplaceModes : previous.workplaceModes,
    employmentTypes: next.employmentTypes.length ? next.employmentTypes : previous.employmentTypes,
    ...(next.minSalary ?? previous.minSalary ? { minSalary: next.minSalary ?? previous.minSalary } : {}),
    sort: sort ?? previous.sort,
  };
}

export function parseCandidateSearch(message: string): CandidateSearchState {
  const text = normalizeEmploymentText(message);
  const role = parseRole(message);
  const experience = parseExperienceYears(message);
  return {
    terms: [...(role ? [role] : []), ...leftoverTerms(text)].slice(0, 6),
    skills: parseKnownSkills(message).filter((skill) => !role || normalizeEmploymentText(skill) !== normalizeEmploymentText(role)),
    ...(parseCity(message) ? { city: parseCity(message)! } : {}),
    ...(experience !== undefined && experience > 0 ? { minExperienceYears: experience } : {}),
    workplaceModes: parseWorkplaceModes(message),
  };
}

/** Protected words are removed before any structured parsing; they never reach a filter. */
export function withoutProtectedWords(message: string): string {
  return normalizeEmploymentText(message)
    .replace(
      /(?:^|\s)(?:من|ذو|ذات|يكون)?\s*(?:دين|ديانة|ديانه|مسلم|مسلمة|مسيحي|مسيحية|سني|سنية|شيعي|شيعية|طائفة|طائفه|درزي|يهودي|ملحد|متدين|متدينة|محجبة|محجبه|ذكر|ذكور|انثى|انثي|اناث|رجل|رجال|امراة|نساء|بنت|بنات|شاب|شباب|فتاة|male|female|عمر|عمره|عمرها|سن|مواليد|متزوج|متزوجة|اعزب|عزباء|مطلق|مطلقة|ارمل|اولاد|اطفال|حامل|حمل|معاق|معاقة|اعاقة|اعاقه|مريض|مرض|صحته|سليم|سليمة|جنسية|جنسيه|اردني|اردنية|كويتي|كويتية|سعودي|سعودية|مصري|مصرية|سوري|سورية|عراقي|فلسطيني|هندي|اجنبي|اجنبية|وافد|وافدة|عرق|اصل|لون|بشرة|سياسي|سياسية|حزب|حزبي|نقابة|نقابي|معين|معينة)(?=\s|$)/gu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDraftFacts(message: string): Partial<JobDraft> {
  const modes = parseWorkplaceModes(message);
  const types = parseEmploymentTypes(message);
  const experience = parseExperienceYears(message);
  const salary = parseSalary(message);
  const city = parseCity(message);
  const skills = parseKnownSkills(message);
  return {
    ...(skills.length ? { skills } : {}),
    ...(experience !== undefined ? { minExperienceYears: experience, experienceAsked: true } : {}),
    ...(modes[0] ? { workplaceMode: modes[0] } : {}),
    ...(types[0] ? { employmentType: types[0] } : {}),
    ...(city ? { city } : {}),
    ...(salary ? { salary } : {}),
  };
}

function mergeDraft(draft: JobDraft, facts: Partial<JobDraft>): JobDraft {
  const skills = [...draft.skills];
  for (const skill of facts.skills ?? [])
    if (!skills.some((existing) => normalizeEmploymentText(existing) === normalizeEmploymentText(skill))) skills.push(skill);
  return JobDraft.parse({ ...draft, ...facts, skills: skills.slice(0, 30) });
}

/** Answer to the field the draft is asking for; returns undefined when it is not an answer. */
export function answerDraftField(draft: JobDraft, message: string): JobDraft | undefined {
  const field = nextJobDraftField(draft);
  const text = normalizeEmploymentText(message);
  switch (field) {
    case "title": {
      const title = labelledTitle(message) ?? statedJobTitle(message) ?? message.trim();
      if (title.length < 2 || title.length > 120 || title.split(/\s+/).length > 8) return undefined;
      return JobDraft.parse({ ...draft, title });
    }
    case "skills": {
      const listed = parseSkillList(message);
      const skills = listed.length
        ? listed
        : message.split(/\s*(?:،|,|\s+و\s*)\s*/u).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 40 && item.split(/\s+/).length <= 3);
      if (!skills.length || message.split(/\s+/).length > 12) return undefined;
      return mergeDraft(draft, { skills });
    }
    case "experience": {
      const years = parseExperienceYears(message) ?? (/^(?:لا|لا يشترط|بدون)$/u.test(text) ? 0 : /^\d{1,2}$/.test(text) ? Number(text) : undefined);
      if (years === undefined) return undefined;
      return JobDraft.parse({ ...draft, minExperienceYears: years, experienceAsked: true });
    }
    case "employment": {
      const modes = parseWorkplaceModes(message);
      const types = parseEmploymentTypes(message);
      if (!modes.length && !types.length) return undefined;
      return JobDraft.parse({
        ...draft,
        ...(modes[0] ? { workplaceMode: modes[0] } : {}),
        ...(types[0] ? { employmentType: types[0] } : {}),
      });
    }
    case "city": {
      const city = parseCity(message) ?? (message.trim().split(/\s+/).length <= 2 && message.trim().length <= 30 ? message.trim() : undefined);
      if (!city) return undefined;
      return JobDraft.parse({ ...draft, city });
    }
    case "salary": {
      if (noSalaryAnswer(message)) return JobDraft.parse({ ...draft, salary: null });
      const salary = parseSalary(message) ?? (/^\d{1,7}$/.test(text) ? { min: Number(text), period: "MONTH" as const } : targetSalary(message));
      if (!salary) return undefined;
      return JobDraft.parse({ ...draft, salary });
    }
    default:
      return undefined;
  }
}

/** Labelled corrections the employer can make at any time before publishing. */
export function correctDraft(draft: JobDraft, message: string): JobDraft | undefined {
  const text = normalizeEmploymentText(message);
  const title = labelledTitle(message);
  if (title) return JobDraft.parse({ ...draft, title });
  const skillEdit = addOrRemoveSkills(message);
  if (skillEdit.add.length || skillEdit.remove.length) {
    const kept = draft.skills.filter((skill) => !skillEdit.remove.some((removed) => normalizeEmploymentText(removed) === normalizeEmploymentText(skill)));
    return mergeDraft({ ...draft, skills: kept }, { skills: skillEdit.add });
  }
  if (/(?:^|\s)(?:الراتب|راتب)(?:\s|$)/u.test(text)) {
    if (/(?:بدون|احذف|لا)\s/u.test(text) && !/\d/.test(text)) return JobDraft.parse({ ...draft, salary: null });
    const salary = targetSalary(message);
    if (salary) return JobDraft.parse({ ...draft, salary });
  }
  const description = rawAfter(message, /(?:^|\s)(?:الوصف|وصف الوظيفة)\s*(?:هو|:)?\s*/u);
  if (description && description.length >= 5) return JobDraft.parse({ ...draft, description: description.slice(0, 4000) });
  return undefined;
}

function draftTitleFromMessage(message: string): string | undefined {
  return labelledTitle(message) ?? statedJobTitle(message);
}

/** Facts a candidate states about themself; nothing is inferred beyond the words used. */
export function parseProfileFacts(message: string): ProfileChanges {
  const text = normalizeEmploymentText(message);
  const changes: ProfileChanges = {};
  const title =
    labelledTitle(message) ??
    message.match(/(?:^|\s)(?:أنا|انا)\s+(.+?)(?=\s+(?:عندي|لدي|أعرف|اعرف|وأعرف|واعرف|و|في|من|بخبرة|خبرة|أسكن|اسكن|مقيم)(?:\s|$)|[،,.]|$)/u)?.[1]?.trim();
  if (title && title.length >= 2 && title.length <= 120 && !/^(?:مهتم|ابحث|أبحث)/u.test(title)) changes.professionalTitle = title;
  const years = parseExperienceYears(message);
  if (years !== undefined && /(?:عندي|لدي|خبرتي|خبرة|خبره)/u.test(text)) changes.experienceYears = years;
  const skillEdit = addOrRemoveSkills(message);
  const knownSkills = parseKnownSkills(message);
  if (skillEdit.add.length) changes.addSkills = skillEdit.add;
  else if (knownSkills.length && /(?:عندي|لدي|اعرف|اتقن|خبرة|مهارات|مهاراتي)/u.test(text)) changes.addSkills = knownSkills;
  if (skillEdit.remove.length) changes.removeSkills = skillEdit.remove;
  const worked = message.match(/(?:اشتغلت|عملت|اشتغل|كنت)\s+(.+?)\s+(?:في|لدى|عند|مع)\s+(?:شركة\s+)?(.+?)(?:\s+من\s+(\d{4})\s+(?:إلى|الى|حتى|لـ|ل)\s+(\d{4}))?\s*$/u);
  if (worked) {
    changes.addExperience = {
      role: worked[1]!.trim().slice(0, 120),
      organization: worked[2]!.trim().slice(0, 120),
      ...(worked[3] ? { startYear: Number(worked[3]) } : {}),
      ...(worked[4] ? { endYear: Number(worked[4]) } : {}),
    };
  }
  const studied = message.match(/(?:درست|تخصصي|تخصص|خريج|خريجة|بكالوريوس|ماجستير|دبلوم|دكتوراه)\s+(?:في\s+)?(.+?)(?:\s+(?:من|في)\s+(?:جامعة|كلية|معهد)\s+(.+?))?\s*$/u);
  if (studied && !worked) {
    const qualification = message.match(/بكالوريوس|ماجستير|دبلوم|دكتوراه/u)?.[0];
    changes.addEducation = {
      field: studied[1]!.trim().slice(0, 120),
      ...(qualification ? { qualification } : {}),
      ...(studied[2] ? { institution: studied[2].trim().slice(0, 120) } : {}),
    };
  }
  const city = parseCity(message);
  if (city && /(?:اسكن|مقيم|مقيمة|مدينتي|موقعي|انا في|انا من|اعيش)/u.test(text)) changes.city = city;
  const modes = parseWorkplaceModes(message);
  if (modes.length && /(?:افضل|اريد|ابحث|ابغي|بدي|احب|يناسبني|فقط)/u.test(text)) changes.workplacePreferences = modes;
  const types = parseEmploymentTypes(message);
  if (types.length && /(?:افضل|اريد|ابحث|ابغي|بدي|احب|يناسبني|فقط)/u.test(text)) changes.employmentTypePreferences = types;
  const link = message.match(/(?:https?:\/\/)?(?:www\.)?(?:github\.com|behance\.net|linkedin\.com|gitlab\.com|dribbble\.com|[a-z0-9-]+\.(?:dev|io|me|com|net|org))(?:\/[^\s]*)?/iu)?.[0];
  if (link && /(?:رابط|موقعي|بورتفوليو|portfolio|github|behance|اعمالي)/iu.test(message)) changes.addPortfolioLink = link;
  const contact = extractListingContactPhone(message);
  if (contact.phone) changes.contactPhone = contact.phone;
  if (/(?:احذف|امسح|شيل|اخف)\s+(?:رقم\s+)?(?:التواصل|رقمي|الرقم)/u.test(text)) changes.contactPhone = null;
  if (/(?:اجعل|خلي|اظهر|افتح)\s+(?:ملفي|سيرتي)?\s*(?:ظاهر|ظاهرا|مرئي|مرئيا|متاح|متاحا|عام|عاما)|اظهر\s+(?:ملفي|سيرتي)|ملفي\s+(?:ظاهر|مرئي)/u.test(text))
    changes.visibility = "DISCOVERABLE";
  if (/(?:اخف|اخفي|اجعل|خلي)\s+(?:ملفي|سيرتي)?\s*(?:خاص|خاصا|مخفي|مخفيا|سري)|اخف\s+(?:ملفي|سيرتي)|اوقف\s+(?:ظهور|اكتشاف)/u.test(text))
    changes.visibility = "PRIVATE";
  const summary = rawAfter(message, /(?:^|\s)(?:نبذة|نبذتي|ملخص|الملخص)\s*(?:عني)?\s*(?::|هي|هو)?\s*/u);
  if (summary && summary.length >= 10) changes.summary = summary.slice(0, 2000);
  return changes;
}

function hasProfileChanges(changes: ProfileChanges): boolean {
  return Object.keys(changes).length > 0;
}

// ─── Intent detection ────────────────────────────────────────────────────────

function intentOf(text: string) {
  return {
    myJobs: has(text, /(?:^|\s)(?:وظائفي|الوظائف التي نشرتها|الوظائف اللي نشرتها|وظائف شركتي)(?=\s|$)/u),
    applicants: has(text, /(?:^|\s)(?:المتقدمين|المتقدمون|المتقدمات|متقدمين|طلبات التوظيف على|من تقدم)(?=\s|$)/u),
    myApplications: has(text, /(?:طلبات التوظيف|طلبات التقديم|طلباتي الوظيفية|طلبات الوظائف|تقديماتي|الوظائف التي قدمت عليها|الوظائف اللي قدمت عليها)/u),
    plainMyRequests: has(text, /^(?:اعرض|عرض|افتح|وريني|شوف)?\s*طلباتي$/u),
    cvShow: has(text, /^(?:اعرض|افتح|وريني|شوف|عرض)\s+(?:سيرتي|سيرتي الذاتية|ملفي الوظيفي|cv)$|^(?:سيرتي|ملفي الوظيفي)$/u),
    cvCreate: has(text, /(?:انشئ|انشا|اعمل|سوي|ابني|اكتب|جهز|اريد|اضف)\s+(?:لي\s+)?(?:انشئ\s+)?(?:سيرة|سيره|السيرة|سيرتي|ملف وظيفي|ملفا وظيفيا|ملفي الوظيفي|cv)/u),
    // «وظفني»: the person wants work; DINAR starts from their own candidate profile.
    employMe: has(text, /(?:^|\s)(?:وظفني|وظفوني|توظيفي|ابي اتوظف|اريد اتوظف|بدي اتوظف|ابغي اتوظف|ساعدني القى شغل|ساعدني القى وظيفه)(?=\s|$)/u),
    jobCreate:
      has(text, /(?:انشئ|انشا|انشر|اعمل|اضف|نزل|اكتب)\s+(?:لي\s+)?(?:اعلان\s+)?(?:وظيفة|وظيفه)(?=\s|$)/u) ||
      has(text, /(?:^|\s)(?:اريد|احتاج|ابحث عن|بدي|نحتاج|مطلوب|نبحث عن|ابغي|ابي)\s+(?:موظف|موظفة|موظفه|موظفين)(?=\s|$)/u) ||
      has(text, /(?:^|\s)(?:احتاج|اريد|بدي|نحتاج|ابحث عن)\s+(?:شخص|حدا|احد)\s+(?:يساعد|يساعدني|يشتغل|يعمل|للعمل|لمساعدتي)/u),
    candidateSearch:
      has(text, /(?:^|\s)(?:مرشح|مرشحا|مرشحين|مرشحة|مرشحون|سير ذاتية|السير الذاتية)(?=\s|$)/u) ||
      (Boolean(parseRole(text)) &&
        has(text, /(?:^|\s)(?:خبرة|خبره|بخبرة|عنده خبرة|عندها خبرة)(?=\s|$)/u) &&
        has(text, /(?:^|\s)(?:ابحث عن|اريد|احتاج|بدي|دور|دورلي|ابغي)(?=\s|$)/u) &&
        !has(text, /(?:^|\s)(?:وظيفة|وظيفه|وظائف|شغل)(?=\s|$)/u)),
    jobSearch:
      has(text, /(?:^|\s)(?:وظيفة|وظيفه|وظائف|فرصة عمل|فرص عمل|فرصة تدريب|تدريب عملي|internship|jobs?)(?=\s|$)/u) ||
      has(text, /(?:^|\s)(?:ابحث عن|اريد|بدي|احتاج|ابغي)\s+(?:عمل|شغل|تدريب)(?=\s|$)/u),
    apply: has(text, /(?:^|\s)(?:قدم|قدملي|قدم لي|قدمني|اريد التقديم|اريد اقدم|بدي اقدم|ابغي اقدم|سجلني)(?=\s|$)/u),
    open: has(text, /^(?:افتح|اعرض|عرض|تفاصيل|شوف|وريني)(?=\s|$)/u),
    withdraw: has(text, /(?:^|\s)(?:اسحب|سحب|الغ تقديمي|الغ طلبي)(?=\s|$)/u),
    shortlist: has(text, /(?:القائمة المختصرة|القائمه المختصره|shortlist)/u),
    reject: has(text, /^(?:ارفض|رفض)\s/u),
    pause: has(text, /(?:^|\s)(?:وقف|اوقف|ايقاف|عطل)(?=\s|$)/u),
    resume: has(text, /(?:اعد نشر|اعد تفعيل|اعادة نشر|اعادة تفعيل|فعل|انشرها من جديد|اعد نشرها|رجعها|شغلها)/u),
    close: has(text, /(?:^|\s)(?:اغلق|سكر|اقفل|اغلاق)(?=\s|$)/u),
    archive: has(text, /^(?:احذف|ارشف|حذف|ارشفة)\s+(?:ال)?وظيف/u) || has(text, /^(?:احذف|ارشف)(?:ها)?$/u),
    jobEdit: has(text, /^(?:غير|غيّر|عدل|عدّل|خلي|خليها|اجعل|اجعلها|حدث|اضف|احذف|زيد)(?=\s|$)/u),
  };
}

// ─── State ───────────────────────────────────────────────────────────────────

async function conversationSets(conversationId: string, marketId: string) {
  return db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(30);
}

function parseState(set: StoredSet | undefined, actorId: string): EmploymentQuery | undefined {
  if (!set) return undefined;
  const parsed = EmploymentQuery.safeParse(set.query);
  return parsed.success && parsed.data.ownerId === actorId ? parsed.data : undefined;
}

async function latestBlockSurface(conversationId: string): Promise<string | undefined> {
  const [block] = await db
    .select({ payload: aiUiBlocks.payload })
    .from(aiUiBlocks)
    .where(eq(aiUiBlocks.conversationId, conversationId))
    .orderBy(desc(aiUiBlocks.createdAt))
    .limit(1);
  const surface = block?.payload.surface;
  return typeof surface === "string" ? surface : block ? "LISTING_RESULTS" : undefined;
}

async function expirePending(set: StoredSet, state: EmploymentQuery) {
  if (state.view !== "PENDING_ACTION" || state.status !== "PENDING") return;
  await db
    .update(aiResultSets)
    .set({ query: { ...state, status: "EXPIRED" } })
    .where(eq(aiResultSets.id, set.id));
}

// ─── Rendering ───────────────────────────────────────────────────────────────

type Rendered = {
  surface: EmploymentSurface;
  prompt: string;
  query: EmploymentQuery;
  resourceIds: string[];
  employment: Record<string, unknown>;
};

function turn(rendered: Rendered): Turn {
  const resultSetId = randomUUID();
  return {
    tool: "employment",
    version: 1,
    result: {
      kind: "SURFACE",
      surface: rendered.surface,
      resultSetId,
      resourceIds: rendered.resourceIds,
      prompt: rendered.prompt,
      query: rendered.query,
      listings: [],
      employment: {
        view: rendered.surface,
        ...rendered.employment,
        ...(rendered.query.view === "PENDING_ACTION"
          ? { action: { ...(rendered.employment.action as object), actionId: resultSetId, status: "PENDING" } }
          : {}),
      },
    },
  };
}

/** A notice keeps the list the user was on as context, so ordinals and follow-ups still resolve. */
function notice(actorId: string, prompt: string, extra: Record<string, unknown> = {}, contextSetId?: string): Turn {
  return turn({
    surface: "EMPLOYMENT_NOTICE",
    prompt,
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "NOTICE", ...(contextSetId ? { parentResultSetId: contextSetId } : {}) },
    resourceIds: [],
    employment: { notice: prompt, ...extra },
  });
}

function jobLines(job: ReturnType<typeof publicJobView>): string[] {
  return [
    `المسمى: ${job.title}`,
    `المهارات: ${job.skills.join("، ") || "—"}`,
    `الخبرة: ${job.minExperienceYears == null ? "غير محددة" : job.minExperienceYears === 0 ? "بدون خبرة" : `${job.minExperienceYears} سنوات على الأقل`}`,
    `الدوام: ${EMPLOYMENT_LABELS[job.employmentType as EmploymentType]} · ${WORKPLACE_LABELS[job.workplaceMode as WorkplaceMode]}`,
    `المكان: ${job.city || "عن بعد"}`,
    `الراتب: ${job.salary ?? "غير معلن"}`,
  ];
}

function draftView(draft: JobDraft, market: Market) {
  return {
    draftId: draft.draftId,
    title: draft.title ?? null,
    description: draft.description ?? null,
    skills: draft.skills,
    minExperienceYears: draft.minExperienceYears ?? null,
    city: draft.city ?? null,
    workplaceMode: draft.workplaceMode ?? null,
    employmentType: draft.employmentType ?? null,
    salary: draft.salary === null ? "غير معلن" : draft.salary ? draftSalarySummary(draft, market) : null,
  };
}

function renderDraft(actorId: string, draft: JobDraft, market: Market, lead = ""): Rendered {
  const field = nextJobDraftField(draft);
  if (field)
    return {
      surface: "JOB_DRAFT",
      prompt: `${lead}${JOB_FIELD_PROMPTS[field]}`.trim(),
      query: { kind: "EMPLOYMENT", ownerId: actorId, view: "JOB_DRAFT", draft },
      resourceIds: [],
      employment: { draft: draftView(draft, market), missingField: field },
    };
  const view = draftView(draft, market);
  return {
    surface: "JOB_REVIEW",
    prompt: `${lead}راجع إعلان الوظيفة كما سيُنشر تمامًا. لن يُنشر شيء قبل تأكيدك.`.trim(),
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "PENDING_ACTION", action: { type: "PUBLISH_JOB", draft }, status: "PENDING" },
    resourceIds: [],
    employment: {
      draft: view,
      action: { type: "PUBLISH_JOB", title: draft.title, confirmLabel: "نشر", lines: [] },
    },
  };
}

async function renderJobResults(actorId: string, market: Market, state: JobSearchState, parentResultSetId?: string, allowedIds?: string[]): Promise<Rendered> {
  const rows = await searchJobs(market, state, allowedIds ? { allowedIds } : {});
  const profile = await ownProfile(actorId, market);
  const jobsView = rows.map((row) => ({
    ...publicJobView(row, market.minorUnitScale),
    ...(profile ? { signals: matchSignals(jobMatchInput(row), candidateMatchInput(profile)) } : {}),
  }));
  const filters = [
    ...state.terms,
    ...state.skills,
    ...(state.city ? [state.city] : []),
    ...state.workplaceModes.map((mode) => WORKPLACE_LABELS[mode]),
    ...state.employmentTypes.map((type) => EMPLOYMENT_LABELS[type]),
  ];
  return {
    surface: "JOB_SEARCH_RESULTS",
    prompt: rows.length
      ? `وجدت ${rows.length} وظائف منشورة في DINAR تطابق طلبك.`
      : "لم أجد وظائف منشورة في DINAR تطابق طلبك حاليًا. جرّب إزالة أحد الشروط.",
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "JOB_SEARCH", jobSearch: state, ...(parentResultSetId ? { parentResultSetId } : {}) },
    resourceIds: rows.map((row) => row.id),
    employment: { jobs: jobsView, filters },
  };
}

async function renderMyJobs(actorId: string, market: Market, lead = ""): Promise<Rendered> {
  const rows = await ownedJobs(actorId, market);
  const counts = await applicationCounts(rows.map((row) => row.id));
  return {
    surface: "MY_JOBS",
    prompt: `${lead}${rows.length ? `لديك ${rows.length} وظائف. اختر رقم الوظيفة لإدارتها.` : "لا توجد وظائف منشورة لك بعد. قل «أريد موظف…» لإنشاء وظيفة."}`.trim(),
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "MY_JOBS" },
    resourceIds: rows.map((row) => row.id),
    employment: { jobs: rows.map((row) => ownerJobView(row, market.minorUnitScale, counts.get(row.id) ?? 0)) },
  };
}

async function renderOwnerJob(actorId: string, market: Market, jobId: string, parentResultSetId?: string, lead = ""): Promise<Rendered | undefined> {
  const [row] = await ownedJobs(actorId, market, [jobId]);
  if (!row) return undefined;
  const counts = await applicationCounts([row.id]);
  return {
    surface: "JOB_DETAILS",
    prompt: `${lead}وظيفتك «${row.title}». يمكنك تعديلها أو إيقافها أو إغلاقها أو عرض المتقدمين.`.trim(),
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "JOB", jobId: row.id, audience: "OWNER", ...(parentResultSetId ? { parentResultSetId } : {}) },
    resourceIds: [row.id],
    employment: { job: ownerJobView(row, market.minorUnitScale, counts.get(row.id) ?? 0), audience: "OWNER" },
  };
}

async function renderPublicJob(actorId: string, market: Market, jobId: string, parentResultSetId?: string): Promise<Rendered | undefined> {
  const [row] = await searchJobs(market, emptyJobSearch(), { allowedIds: [jobId] });
  if (!row) return undefined;
  const profile = await ownProfile(actorId, market);
  const applications = await ownApplications(actorId, market);
  const applied = applications.find((item) => item.job.id === row.id);
  return {
    surface: "JOB_DETAILS",
    prompt: `تفاصيل وظيفة «${row.title}». قل «قدم» للتقديم بعد مراجعة الطلب.`,
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "JOB", jobId: row.id, audience: "PUBLIC", ...(parentResultSetId ? { parentResultSetId } : {}) },
    resourceIds: [row.id],
    employment: {
      job: publicJobView(row, market.minorUnitScale),
      audience: "PUBLIC",
      ...(profile ? { signals: matchSignals(jobMatchInput(row), candidateMatchInput(profile)) } : {}),
      ...(applied ? { applicationStatus: applied.application.status } : {}),
    },
  };
}

function renderProfile(actorId: string, profile: NonNullable<Awaited<ReturnType<typeof ownProfile>>>, lead = ""): Rendered {
  const missing = !profile.professionalTitle
    ? " أضف مسمّاك المهني، مثل «أنا محاسب»."
    : !profile.skills.length
      ? " أضف مهاراتك، مثل «أضف Excel»."
      : "";
  return {
    surface: "CV_PROFILE",
    prompt: `${lead}${lead ? " " : ""}هذا ملفك الوظيفي. ${profile.visibility === "PRIVATE" ? "الملف خاص ولا يظهر لأصحاب العمل في البحث." : "الملف ظاهر لأصحاب العمل في البحث داخل DINAR."}${missing}`.trim(),
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "PROFILE" },
    resourceIds: [profile.id],
    employment: { profile: ownProfileView(profile) },
  };
}

async function renderCandidates(actorId: string, market: Market, state: CandidateSearchState, ignoredTraits: string[], parentResultSetId?: string, allowedIds?: string[]): Promise<Rendered> {
  const rows = await searchCandidates(market, actorId, state, allowedIds ? { allowedIds } : {});
  const ignored = ignoredTraits.length
    ? ` لا يبحث DINAR ولا يرتّب المرشحين حسب ${ignoredTraits.join(" أو ")}؛ استخدمت المعايير المهنية فقط.`
    : "";
  return {
    surface: "CANDIDATE_SEARCH_RESULTS",
    prompt: `${rows.length ? `وجدت ${rows.length} ملفات مهنية ظاهرة تطابق المعايير المهنية.` : "لم أجد ملفات مهنية ظاهرة تطابق هذه المعايير المهنية."}${ignored}`,
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "CANDIDATE_SEARCH", candidateSearch: state, ...(parentResultSetId ? { parentResultSetId } : {}) },
    resourceIds: rows.map((row) => row.id),
    employment: {
      candidates: rows.map((row) => candidateCardView(row)),
      ...(ignoredTraits.length ? { ignoredCriteria: ignoredTraits } : {}),
    },
  };
}

async function renderApplicationList(actorId: string, market: Market, jobId: string, lead = ""): Promise<Rendered> {
  const { job, applications } = await applicationsForOwnedJob(actorId, market, jobId);
  return {
    surface: "APPLICATION_LIST",
    prompt: `${lead}${applications.length ? `المتقدمون على «${job.title}»: ${applications.length}. القرار لك؛ المؤشرات تقارن المتطلبات المعلنة فقط.` : `لا يوجد متقدمون على «${job.title}» بعد.`}`.trim(),
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "APPLICATION_LIST", jobId: job.id },
    resourceIds: applications.map((row) => row.application.id),
    employment: {
      job: { id: job.id, title: job.title, status: job.status },
      applications: applications.map((row) => employerApplicationView(row, job)),
    },
  };
}

async function renderMyApplications(actorId: string, market: Market, lead = ""): Promise<Rendered> {
  const rows = await ownApplications(actorId, market);
  return {
    surface: "MY_APPLICATIONS",
    prompt: `${lead}${rows.length ? `لديك ${rows.length} طلبات توظيف.` : "لم تقدّم على أي وظيفة بعد."}`.trim(),
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "MY_APPLICATIONS" },
    resourceIds: rows.map((row) => row.application.id),
    employment: { applications: rows.map((row) => candidateApplicationView(row, market.minorUnitScale)) },
  };
}

function pending(actorId: string, surface: EmploymentSurface, action: PendingAction, prompt: string, view: Record<string, unknown>, parentResultSetId?: string): Rendered {
  return {
    surface,
    prompt,
    query: { kind: "EMPLOYMENT", ownerId: actorId, view: "PENDING_ACTION", action, status: "PENDING", ...(parentResultSetId ? { parentResultSetId } : {}) },
    resourceIds: [
      "jobId" in action ? action.jobId : "applicationId" in action ? action.applicationId : action.draft.draftId,
    ],
    employment: view,
  };
}

// ─── Applying pending actions ────────────────────────────────────────────────

export type EmploymentActionOutcome = {
  status: "CONFIRMED" | "CANCELLED" | "EXPIRED";
  message: string;
  type: PendingAction["type"];
  jobId?: string;
  applicationId?: string;
};

/**
 * The single authority for confirming or cancelling an employment action, used by
 * both the conversation ("نعم") and the action button. Only the actor who owns the
 * conversation may decide, only while the action is still the latest step.
 */
export async function applyEmploymentAction(input: {
  actionId: string;
  actorId: string;
  market: Market;
  decision: "CONFIRM" | "CANCEL";
}): Promise<EmploymentActionOutcome> {
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
    if (!conversation || !state || state.view !== "PENDING_ACTION" || !state.action)
      throw Object.assign(new Error("الإجراء غير موجود"), { status: 404 });
    const action = state.action;
    const base = {
      type: action.type,
      ...("jobId" in action ? { jobId: action.jobId } : {}),
      ...("applicationId" in action ? { applicationId: action.applicationId } : {}),
    };
    const finish = async (status: EmploymentActionOutcome["status"], message: string, extra: Partial<EmploymentActionOutcome> = {}) => {
      await tx.update(aiResultSets).set({ query: { ...state, status } }).where(eq(aiResultSets.id, set.id));
      return { ...base, ...extra, status, message } as EmploymentActionOutcome;
    };
    if (state.status && state.status !== "PENDING")
      return { ...base, status: state.status as EmploymentActionOutcome["status"], message: "تمت معالجة هذا الإجراء من قبل؛ لم يتغير شيء." };
    // Compared in SQL: a JS Date would drop the microseconds and make the action's own block look newer.
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
      return finish("EXPIRED", "انتهت صلاحية هذا الإجراء لأن المحادثة تابعت بعده. لم يتغير شيء؛ اطلبه من جديد.");
    if (input.decision === "CANCEL") return finish("CANCELLED", "أُلغي الإجراء. لم يتغير شيء.");

    switch (action.type) {
      case "PUBLISH_JOB": {
        const { job, created } = await publishJobDraft({ actorId: input.actorId, market: input.market, draft: action.draft });
        return finish("CONFIRMED", created ? `نُشرت وظيفة «${job.title}» في DINAR.` : `وظيفة «${job.title}» منشورة بالفعل؛ لم تُنشأ نسخة ثانية.`, { jobId: job.id });
      }
      case "UPDATE_JOB": {
        const job = await updateOwnedJob({ jobId: action.jobId, actorId: input.actorId, market: input.market, changes: action.changes, expectedVersion: action.expectedVersion }, tx);
        return finish("CONFIRMED", `حُدّثت وظيفة «${job.title}». الطلبات السابقة تبقى كما قُدّمت.`);
      }
      case "JOB_STATUS": {
        const job = await changeOwnedJobStatus({ jobId: action.jobId, actorId: input.actorId, market: input.market, action: action.statusAction }, tx);
        const label = { PAUSE: "أُوقفت", RESUME: "أُعيد نشر", CLOSE: "أُغلقت", ARCHIVE: "أُرشفت" }[action.statusAction];
        return finish("CONFIRMED", `${label} وظيفة «${job.title}». طلبات المتقدمين محفوظة.`);
      }
      case "APPLY": {
        const { application, created } = await submitApplication({ actorId: input.actorId, market: input.market, jobId: action.jobId });
        return finish("CONFIRMED", created ? "أُرسل طلبك. صاحب العمل هو من يقرر؛ تتابع الحالة من «طلبات التوظيف»." : "سبق أن قدّمت على هذه الوظيفة؛ لم يُنشأ طلب ثانٍ.", { applicationId: application.id });
      }
      case "WITHDRAW": {
        await withdrawOwnApplication({ actorId: input.actorId, market: input.market, applicationId: action.applicationId }, tx);
        return finish("CONFIRMED", "سُحب طلبك. يبقى سجل التقديم محفوظًا.");
      }
      case "APPLICATION_STATUS": {
        await changeApplicationStatus({ actorId: input.actorId, market: input.market, applicationId: action.applicationId, status: action.status }, tx);
        return finish("CONFIRMED", action.status === "SHORTLISTED" ? "نُقل المتقدم إلى القائمة المختصرة بقرارك." : "سُجّل قرارك بعدم المتابعة مع هذا المتقدم.");
      }
    }
  });
}

/** Current status of a stored pending action, for rendering history. */
export function storedEmploymentActionStatus(query: unknown): string | undefined {
  const parsed = EmploymentQuery.safeParse(query);
  return parsed.success && parsed.data.view === "PENDING_ACTION" ? parsed.data.status : undefined;
}

// ─── Turn ────────────────────────────────────────────────────────────────────

function resolveIndex(message: string, noun: Parameters<typeof employmentOrdinal>[1], allowBare: boolean): number | undefined {
  const explicit = employmentOrdinal(message, noun);
  if (explicit !== undefined) return explicit;
  if (!allowBare) return undefined;
  const reference = parseResultReference(message) ?? findOrdinalMention(message);
  return reference?.kind === "INDEX" ? reference.index : undefined;
}

async function setById(conversationId: string, marketId: string, id: string | undefined) {
  if (!id) return undefined;
  const [set] = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.id, id), eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)));
  return set;
}

async function jobForManagement(
  actorId: string,
  market: Market,
  message: string,
  state: EmploymentQuery | undefined,
  resourceIds: string[],
): Promise<{ jobId?: string; problem?: string }> {
  const index = employmentOrdinal(message, "JOB");
  if (index !== undefined) {
    if (state?.view !== "MY_JOBS")
      return { problem: "اعرض «وظائفي» أولًا ثم اختر رقم الوظيفة. لم يتغير شيء." };
    const jobId = resourceIds[index];
    return jobId ? { jobId } : { problem: "هذا الرقم غير موجود في قائمة وظائفك الحالية. لم يتغير شيء." };
  }
  if (state?.view === "JOB" && state.audience === "OWNER" && state.jobId) return { jobId: state.jobId };
  if (state?.view === "APPLICATION_LIST" && state.jobId) return { jobId: state.jobId };
  if (state?.view === "MY_JOBS" && resourceIds.length === 1) return { jobId: resourceIds[0] };
  const titled = await ownedJobs(actorId, market);
  const text = normalizeEmploymentText(message);
  const byTitle = titled.filter((job) => text.includes(normalizeEmploymentText(job.title)) || (parseRole(message) && parseRole(job.title) === parseRole(message)));
  if (byTitle.length === 1) return { jobId: byTitle[0]!.id };
  return { problem: "حدّد الوظيفة: اعرض «وظائفي» ثم اذكر رقمها، مثل «الوظيفة الثانية». لم يتغير شيء." };
}

export function jobEditChanges(message: string): JobChanges | undefined {
  const text = normalizeEmploymentText(message);
  const changes: JobChanges = {};
  const title = labelledTitle(message);
  if (title) changes.title = title;
  if (/(?:^|\s)(?:الراتب|راتب)(?:\s|$)/u.test(text)) {
    if (/(?:بدون|احذف|اخف)\s/u.test(text) && !/\d/.test(text)) changes.salary = null;
    else {
      const salary = targetSalary(message);
      if (salary) changes.salary = salary;
    }
  }
  if (/(?:الموقع|المدينة|مكان العمل)/u.test(text)) {
    const city = parseCity(message);
    if (city) changes.city = city;
  }
  const modes = parseWorkplaceModes(message);
  if (modes[0] && /^(?:خلي|خليها|اجعل|اجعلها|غير|عدل)/u.test(text)) changes.workplaceMode = modes[0];
  const types = parseEmploymentTypes(message);
  if (types[0] && /^(?:خلي|خليها|اجعل|اجعلها|غير|عدل)/u.test(text) && !/الراتب|راتب/u.test(text)) changes.employmentType = types[0];
  const years = parseExperienceYears(message);
  if (years !== undefined && /خبر/u.test(text)) changes.minExperienceYears = years;
  const skills = addOrRemoveSkills(message);
  if (skills.add.length) changes.addSkills = skills.add;
  if (skills.remove.length) changes.removeSkills = skills.remove;
  const description = rawAfter(message, /(?:^|\s)(?:الوصف|وصف الوظيفة)\s*(?:الى|إلى|:)?\s*/u);
  if (description && description.length >= 5) changes.description = description;
  return Object.keys(changes).length ? JobChanges.parse(changes) : undefined;
}

function describeChanges(changes: JobChanges): string[] {
  const lines: string[] = [];
  if (changes.title) lines.push(`المسمى ← ${changes.title}`);
  if (changes.salary === null) lines.push("الراتب ← غير معلن");
  else if (changes.salary) lines.push(`الراتب ← ${changes.salary.max ? `${changes.salary.min} – ${changes.salary.max}` : changes.salary.min}`);
  if (changes.city) lines.push(`المدينة ← ${changes.city}`);
  if (changes.workplaceMode) lines.push(`مكان العمل ← ${WORKPLACE_LABELS[changes.workplaceMode]}`);
  if (changes.employmentType) lines.push(`الدوام ← ${EMPLOYMENT_LABELS[changes.employmentType]}`);
  if (changes.minExperienceYears !== undefined) lines.push(`الخبرة ← ${changes.minExperienceYears ?? "غير محددة"}`);
  if (changes.addSkills?.length) lines.push(`إضافة مهارات ← ${changes.addSkills.join("، ")}`);
  if (changes.removeSkills?.length) lines.push(`حذف مهارات ← ${changes.removeSkills.join("، ")}`);
  if (changes.description) lines.push("تحديث الوصف");
  return lines;
}

async function afterAction(actorId: string, market: Market, outcome: EmploymentActionOutcome, contextSetId?: string): Promise<Turn> {
  const lead = `${outcome.message} `;
  if (outcome.status !== "CONFIRMED") return notice(actorId, outcome.message, { outcome: outcome.status }, contextSetId);
  switch (outcome.type) {
    case "PUBLISH_JOB": {
      const rendered = await renderOwnerJob(actorId, market, outcome.jobId!, undefined, lead);
      return rendered ? turn(rendered) : notice(actorId, outcome.message);
    }
    case "UPDATE_JOB":
    case "JOB_STATUS":
      return turn(await renderMyJobs(actorId, market, lead));
    case "APPLY":
    case "WITHDRAW":
      return turn(await renderMyApplications(actorId, market, lead));
    case "APPLICATION_STATUS":
      return turn(await renderApplicationList(actorId, market, outcome.jobId!, lead));
  }
}

type EmploymentTurnInput = {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
};

/** Authority rejections (validation, policy, lifecycle) answer as a notice; nothing changes. */
export async function executeEmploymentTurn(input: EmploymentTurnInput): Promise<Turn | null> {
  try {
    return await employmentTurn(input);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (input.actorId && typeof status === "number" && status >= 400 && status < 500 && error instanceof Error)
      return notice(input.actorId, `${error.message} لم يتغير شيء.`);
    throw error;
  }
}

async function employmentTurn(input: EmploymentTurnInput): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actorId = input.actorId;
  const { market, message } = input;
  const text = normalizeEmploymentText(message);
  const intent = intentOf(text);

  const [sets, blockSurface] = await Promise.all([
    conversationSets(input.conversationId, market.id),
    latestBlockSurface(input.conversationId),
  ]);
  const contextActive = (EMPLOYMENT_SURFACES as readonly string[]).includes(blockSurface ?? "");
  const latestSet = sets[0];
  const latestEmploymentSet = sets.find((set) => isEmploymentQuery(set.query));
  const latestState = parseState(latestEmploymentSet, actorId);
  const isCurrent = contextActive && latestEmploymentSet !== undefined && latestSet?.id === latestEmploymentSet.id;
  let state = isCurrent ? latestState : undefined;
  let stateSet = isCurrent ? latestEmploymentSet : undefined;
  if (state?.view === "NOTICE" && state.parentResultSetId) {
    const parent = await setById(input.conversationId, market.id, state.parentResultSetId);
    const parentState = parseState(parent, actorId);
    state = parentState?.view === "PENDING_ACTION" ? undefined : parentState;
    stateSet = state ? parent : undefined;
  }
  const say = (prompt: string, extra: Record<string, unknown> = {}) => notice(actorId, prompt, extra, stateSet?.id);

  // Pending action: only the immediately following confirmation may apply it.
  if (latestEmploymentSet && latestState?.view === "PENDING_ACTION" && latestState.status === "PENDING") {
    const expired = !isCurrent || (latestEmploymentSet.expiresAt?.getTime() ?? Infinity) <= Date.now();
    if (!expired && (CONFIRM.test(text) || CANCEL.test(text))) {
      const outcome = await applyEmploymentAction({
        actionId: latestEmploymentSet.id,
        actorId,
        market,
        decision: CONFIRM.test(text) ? "CONFIRM" : "CANCEL",
      });
      if (outcome.status === "CANCELLED" && latestState.action?.type === "PUBLISH_JOB")
        return notice(actorId, "أُلغي إعلان الوظيفة قبل النشر. لم يُنشر شيء.");
      return afterAction(actorId, market, outcome, latestState.parentResultSetId);
    }
    await expirePending(latestEmploymentSet, latestState);
    // A correction during review continues the same draft.
    if (!expired && latestState.action?.type === "PUBLISH_JOB") {
      state = { kind: "EMPLOYMENT", ownerId: actorId, view: "JOB_DRAFT", draft: latestState.action.draft };
    } else if (!expired) {
      const parent = await setById(input.conversationId, market.id, latestState.parentResultSetId);
      state = parseState(parent, actorId);
      stateSet = parent;
    }
  }

  const applyCommand = /^(?:قدم|قدم لي|نعم قدم)$/u.test(text) && state?.view === "JOB" && state.audience === "PUBLIC";
  if (contextActive && (CONFIRM.test(text) || CANCEL.test(text)) && state?.view !== "JOB_DRAFT" && !applyCommand)
    return say("لا يوجد إجراء بانتظار التأكيد الآن. لم يتغير شيء.");

  if (automaticDecisionRequested(message) && (contextActive || /متقدم|مرشح/u.test(text)))
    return notice(
      actorId,
      "لا يتخذ DINAR قرارات توظيف تلقائية: لا قبول ولا رفض ولا قائمة مختصرة بالذكاء الاصطناعي. أعرض لك المؤشرات المهنية المعلنة، والقرار لك لكل متقدم على حدة.",
    );

  // Job draft: answers, corrections, cancel.
  if (state?.view === "JOB_DRAFT" && state.draft) {
    let draft = state.draft;
    if (/^(?:الغاء|الغ|الغي|تراجع)$|^(?:الغ|الغاء)\s+(?:الوظيفة|الاعلان|المسودة)/u.test(text))
      return notice(actorId, "أُلغي إعلان الوظيفة قبل النشر. لم يُنشر شيء.");
    const strongOther = intent.myJobs || intent.cvCreate || intent.cvShow || intent.myApplications || (intent.jobSearch && !intent.jobCreate && /^(?:اريد|ابحث|بدي)/u.test(text));
    if (!strongOther) {
      const corrected = correctDraft(draft, message);
      const answered = corrected ? undefined : answerDraftField(draft, message);
      const facts = corrected || answered ? {} : parseDraftFacts(message);
      const next = corrected ?? answered ?? (Object.keys(facts).length ? mergeDraft(draft, facts) : undefined);
      if (next) return turn(renderDraft(actorId, next, market));
      if (message.split(/\s+/).length <= 8)
        return turn(renderDraft(actorId, draft, market, "لم أتعرف على الإجابة. "));
    }
  }

  // Strong, context-free intents.
  if (intent.jobCreate && !intent.myJobs) {
    const draft = JobDraft.parse({
      draftId: randomUUID(),
      skills: [],
      ...parseDraftFacts(message),
      ...(draftTitleFromMessage(message) ? { title: draftTitleFromMessage(message) } : {}),
    });
    const role = parseRole(message);
    const described = !draft.title && !role && message.trim().length > 12;
    return turn(
      renderDraft(
        actorId,
        described ? { ...draft, description: message.trim().slice(0, 4000) } : draft,
        market,
        described ? "حفظت وصفك كما هو. " : "",
      ),
    );
  }
  if (intent.myJobs && !intent.applicants) return turn(await renderMyJobs(actorId, market));
  if (intent.cvCreate || intent.cvShow || intent.employMe) {
    const facts = parseProfileFacts(message);
    const profile = hasProfileChanges(facts)
      ? await updateOwnProfile(actorId, market, facts)
      : await ensureOwnProfile(actorId, market);
    const lead = intent.employMe
      ? profile.professionalTitle
        ? `ملفك الوظيفي جاهز («${profile.professionalTitle}»). قل «ابحث لي عن وظيفة» لأعرض وظائف DINAR المناسبة؛ لا يُقدَّم على أي وظيفة دون تأكيدك.`
        : "لأبحث لك عن وظائف داخل DINAR أحتاج ملفك الوظيفي: أخبرني بمسماك المهني وسنوات خبرتك، مثل «أنا محاسب وعندي خبرة 3 سنوات». الملف خاص افتراضيًا."
      : intent.cvCreate
        ? "أنشأت ملفك الوظيفي وهو خاص افتراضيًا."
        : "";
    return turn(renderProfile(actorId, profile, lead));
  }
  if (intent.myApplications || (intent.plainMyRequests && contextActive && state && ["JOB_SEARCH", "JOB", "MY_APPLICATIONS", "PROFILE"].includes(state.view) && state.audience !== "OWNER"))
    return turn(await renderMyApplications(actorId, market));
  if (intent.applicants) {
    const target = await jobForManagement(actorId, market, message, state, stateSet?.resourceIds ?? []);
    if (!target.jobId) return say(target.problem!);
    return turn(await renderApplicationList(actorId, market, target.jobId));
  }

  // Context-bound commands.
  if (state && stateSet) {
    const ids = stateSet.resourceIds;
    if (backIntent(message)) {
      const parent = await setById(input.conversationId, market.id, state.parentResultSetId);
      const parentState = parseState(parent, actorId);
      if (parent && parentState?.view === "JOB_SEARCH" && parentState.jobSearch)
        return turn({ ...(await renderJobResults(actorId, market, parentState.jobSearch, parentState.parentResultSetId, parent.resourceIds)), prompt: "عدت إلى نتائج الوظائف السابقة بالترتيب نفسه." });
      if (parent && parentState?.view === "CANDIDATE_SEARCH" && parentState.candidateSearch)
        return turn({ ...(await renderCandidates(actorId, market, parentState.candidateSearch, [], parentState.parentResultSetId, parent.resourceIds)), prompt: "عدت إلى نتائج المرشحين السابقة بالترتيب نفسه." });
      if (parent && parentState?.view === "MY_JOBS") return turn(await renderMyJobs(actorId, market));
      return say("لا توجد قائمة سابقة للعودة إليها هنا.");
    }

    if (state.view === "JOB_SEARCH" || (state.view === "JOB" && state.audience === "PUBLIC")) {
      if (intent.apply) {
        const index = resolveIndex(message, "JOB", state.view === "JOB_SEARCH");
        const jobId = state.view === "JOB" && index === undefined ? state.jobId : index !== undefined && state.view === "JOB_SEARCH" ? ids[index] : undefined;
        if (!jobId) return say("حدّد الوظيفة برقمها من النتائج الظاهرة، مثل «قدم على الثانية». لم يُرسل أي طلب.");
        const ready = await applicationReadiness(actorId, market, jobId);
        if (!ready.ok)
          return notice(
            actorId,
            ready.reason === "PROFILE_MARKET_MISMATCH"
              ? "ملفك الوظيفي مرتبط بسوق آخر ولا يمكن استخدامه أو نقله تلقائيًا إلى السوق الحالي."
              : ready.reason === "PROFILE_INCOMPLETE"
              ? "أنشئ ملفك الوظيفي بمسمى مهني أولًا، مثل «أنشئ لي سيرة، أنا محاسب». لم يُرسل أي طلب."
              : ready.reason === "OWN_JOB"
                ? "هذه وظيفتك؛ لا يمكنك التقديم عليها."
                : "هذه الوظيفة لم تعد تستقبل طلبات.",
          );
        if (ready.existing)
          return turn(await renderMyApplications(actorId, market, "سبق أن قدّمت على هذه الوظيفة؛ لن يُنشأ طلب ثانٍ. "));
        return turn(
          pending(
            actorId,
            "APPLICATION_REVIEW",
            { type: "APPLY", jobId },
            "راجع طلب التقديم. لن يُرسل شيء قبل «تأكيد التقديم».",
            {
              job: publicJobView(ready.job, market.minorUnitScale),
              profile: candidateCardView(ready.profile),
              signals: matchSignals(jobMatchInput(ready.job), candidateMatchInput(ready.profile)),
              action: {
                type: "APPLY",
                title: ready.job.title,
                confirmLabel: "تأكيد التقديم",
                lines: [
                  `ستُرسل ملفك «${ready.profile.professionalTitle}» إلى صاحب العمل.`,
                  ready.profile.contactMode === "PROFILE_CONTACT"
                    ? "سيرى صاحب العمل رقم التواصل الذي أضفته لملفك (وليس رقم دخولك)."
                    : "لن يظهر أي رقم تواصل؛ رقم دخولك لا يُشارك أبدًا.",
                ],
              },
            },
            stateSet.id,
          ),
        );
      }
      if (state.view === "JOB_SEARCH") {
        const index = intent.open ? resolveIndex(message, "JOB", true) : parseResultReference(message)?.kind === "INDEX" ? (parseResultReference(message) as { index: number }).index : employmentOrdinal(message, "JOB");
        if (index !== undefined) {
          const jobId = ids[index];
          if (!jobId) return say(`النتائج الحالية فيها ${ids.length} وظائف فقط. اختر رقمًا ظاهرًا.`);
          const rendered = await renderPublicJob(actorId, market, jobId, stateSet.id);
          return rendered ? turn(rendered) : notice(actorId, "لم تعد هذه الوظيفة متاحة.");
        }
        if (state.jobSearch && !intent.jobSearch && !intent.jobCreate && !intent.candidateSearch) {
          const refined = refineJobSearch(state.jobSearch, message);
          if (refined) return turn(await renderJobResults(actorId, market, refined));
        }
      }
    }

    if (state.view === "MY_JOBS" || (state.view === "JOB" && state.audience === "OWNER")) {
      const statusAction: JobStatusAction | undefined = intent.archive ? "ARCHIVE" : intent.close ? "CLOSE" : intent.resume ? "RESUME" : intent.pause ? "PAUSE" : undefined;
      const changes = statusAction ? undefined : intent.jobEdit ? jobEditChanges(message) : undefined;
      if (statusAction || changes) {
        const target = await jobForManagement(actorId, market, message, state, ids);
        if (!target.jobId) return say(target.problem!);
        const [job] = await ownedJobs(actorId, market, [target.jobId]);
        if (!job) return say("الوظيفة غير موجودة ضمن وظائفك.");
        const view = ownerJobView(job, market.minorUnitScale, 0);
        if (statusAction) {
          const label = { PAUSE: "إيقاف", RESUME: "إعادة نشر", CLOSE: "إغلاق", ARCHIVE: "أرشفة" }[statusAction];
          return turn(
            pending(actorId, "EMPLOYMENT_ACTION", { type: "JOB_STATUS", jobId: job.id, statusAction }, `هل تريد ${label} وظيفة «${job.title}»؟ أكّد أو ألغِ.`, {
              job: view,
              action: {
                type: "JOB_STATUS",
                title: job.title,
                confirmLabel: `تأكيد ${label}`,
                lines: statusAction === "CLOSE" || statusAction === "ARCHIVE"
                  ? ["لن تستقبل الوظيفة طلبات جديدة. الطلبات الحالية تبقى محفوظة."]
                  : [],
              },
            }, stateSet.id),
          );
        }
        return turn(
          pending(actorId, "EMPLOYMENT_ACTION", { type: "UPDATE_JOB", jobId: job.id, changes: changes!, expectedVersion: job.version }, `معاينة تعديل «${job.title}». لم يتغير شيء بعد؛ أكّد أو ألغِ.`, {
            job: view,
            action: { type: "UPDATE_JOB", title: job.title, confirmLabel: "تأكيد التغيير", lines: describeChanges(changes!) },
          }, stateSet.id),
        );
      }
      if (state.view === "MY_JOBS") {
        const index = resolveIndex(message, "JOB", true);
        if (index !== undefined && (intent.open || parseResultReference(message))) {
          const jobId = ids[index];
          if (!jobId) return say(`قائمة وظائفك فيها ${ids.length} فقط. اختر رقمًا ظاهرًا.`);
          const rendered = await renderOwnerJob(actorId, market, jobId, stateSet.id);
          return rendered ? turn(rendered) : notice(actorId, "الوظيفة غير موجودة ضمن وظائفك.");
        }
      }
    }

    if (state.view === "APPLICATION_LIST" && state.jobId) {
      const index = resolveIndex(message, "APPLICANT", true);
      if ((intent.shortlist || intent.reject) && index !== undefined) {
        const applicationId = ids[index];
        if (!applicationId) return say(`قائمة المتقدمين فيها ${ids.length} فقط.`);
        const { applications, job } = await applicationsForOwnedJob(actorId, market, state.jobId, [applicationId]);
        const row = applications[0];
        if (!row) return say("المتقدم غير موجود ضمن طلبات وظيفتك.");
        const status = intent.shortlist ? "SHORTLISTED" : "REJECTED";
        return turn(
          pending(actorId, "EMPLOYMENT_ACTION", { type: "APPLICATION_STATUS", jobId: job.id, applicationId, status },
            status === "SHORTLISTED" ? "هل تريد نقل هذا المتقدم إلى القائمة المختصرة؟ هذا قرارك أنت." : "هل تريد تسجيل عدم المتابعة مع هذا المتقدم؟ هذا قرارك أنت.",
            {
              application: employerApplicationView(row, job),
              action: {
                type: "APPLICATION_STATUS",
                title: row.application.candidateSnapshot.professionalTitle ?? "",
                confirmLabel: status === "SHORTLISTED" ? "تأكيد القائمة المختصرة" : "تأكيد القرار",
                lines: [],
              },
            }, stateSet.id),
        );
      }
    }

    if (state.view === "MY_APPLICATIONS") {
      const index = resolveIndex(message, "APPLICATION", true);
      if (intent.withdraw) {
        if (index === undefined) return say("حدّد الطلب برقمه، مثل «اسحب الطلب الثاني». لم يتغير شيء.");
        const applicationId = ids[index];
        if (!applicationId) return say(`لديك ${ids.length} طلبات فقط في القائمة الحالية.`);
        const [row] = await ownApplications(actorId, market, [applicationId]);
        if (!row) return say("الطلب غير موجود ضمن طلباتك.");
        if (row.application.status === "WITHDRAWN") return say("هذا الطلب مسحوب بالفعل.");
        return turn(
          pending(actorId, "EMPLOYMENT_ACTION", { type: "WITHDRAW", applicationId }, `هل تريد سحب طلبك على «${row.job.title}»؟ أكّد أو ألغِ.`, {
            application: candidateApplicationView(row, market.minorUnitScale),
            action: { type: "WITHDRAW", title: row.job.title, confirmLabel: "تأكيد السحب", lines: ["يبقى سجل التقديم محفوظًا لدى صاحب العمل بحالة «مسحوب»."] },
          }, stateSet.id),
        );
      }
    }

    if (state.view === "CANDIDATE_SEARCH") {
      const index = intent.open || parseResultReference(message) ? resolveIndex(message, "CANDIDATE", true) : employmentOrdinal(message, "CANDIDATE");
      if (index !== undefined) {
        const profileId = ids[index];
        if (!profileId) return say(`النتائج الحالية فيها ${ids.length} ملفات فقط.`);
        const [row] = await searchCandidates(market, actorId, state.candidateSearch ?? { terms: [], skills: [], workplaceModes: [] }, { allowedIds: [profileId] });
        if (!row) return say("لم يعد هذا الملف ظاهرًا للبحث.");
        return turn({
          surface: "CANDIDATE_DETAILS",
          prompt: "الملف المهني كما نشره صاحبه. لا يعرض DINAR أي بيانات شخصية أو حساسة.",
          query: { kind: "EMPLOYMENT", ownerId: actorId, view: "CANDIDATE", parentResultSetId: stateSet.id },
          resourceIds: [row.id],
          employment: { candidate: candidateCardView(row) },
        });
      }
      if (state.candidateSearch && !intent.candidateSearch && !intent.jobSearch) {
        const traits = protectedTraitsRequested(message);
        const next = parseCandidateSearch(withoutProtectedWords(message));
        if (next.city || next.minExperienceYears !== undefined || next.skills.length || next.workplaceModes.length || traits.length) {
          const merged = {
            ...state.candidateSearch,
            skills: [...new Set([...state.candidateSearch.skills, ...next.skills])],
            ...(next.city ? { city: next.city } : {}),
            ...(next.minExperienceYears !== undefined ? { minExperienceYears: next.minExperienceYears } : {}),
            ...(next.workplaceModes.length ? { workplaceModes: next.workplaceModes } : {}),
          };
          return turn(await renderCandidates(actorId, market, merged, traits));
        }
      }
    }

    if (state.view === "PROFILE") {
      const facts = parseProfileFacts(message);
      if (hasProfileChanges(facts)) {
        const profile = await updateOwnProfile(actorId, market, facts);
        return turn(renderProfile(actorId, profile, "حدّثت ملفك."));
      }
    }
  }

  // Profile edits stated in the first person outside the profile view.
  if (/^(?:اضف|احذف)\s+(?:اني|انني|ان|أن)\s/u.test(text) || /(?:سيرتي|ملفي الوظيفي|ملفي المهني)/u.test(text)) {
    const facts = parseProfileFacts(message);
    if (hasProfileChanges(facts)) {
      const profile = await updateOwnProfile(actorId, market, facts);
      return turn(renderProfile(actorId, profile, "حدّثت ملفك."));
    }
  }

  if (intent.candidateSearch) {
    const traits = protectedTraitsRequested(message);
    const query = parseCandidateSearch(withoutProtectedWords(message));
    if (!query.terms.length && !query.skills.length && query.minExperienceYears === undefined && !query.city)
      return say(`${traits.length ? `لا يبحث DINAR حسب ${traits.join(" أو ")}. ` : ""}اذكر المعايير المهنية: المسمى، المهارات، الخبرة أو المدينة.`, traits.length ? { ignoredCriteria: traits } : {});
    return turn(await renderCandidates(actorId, market, query, traits));
  }

  if (intent.jobSearch && !intent.jobCreate && !intent.apply && !(intent.pause || intent.close || intent.resume || intent.archive || intent.jobEdit)) {
    const query = parseJobSearch(message);
    return turn(await renderJobResults(actorId, market, query));
  }

  if (contextActive && (intent.pause || intent.close || intent.resume || intent.archive) && /وظيف/u.test(text))
    return say("اعرض «وظائفي» أولًا ثم اختر رقم الوظيفة. لم يتغير شيء.");

  return null;
}

/** Live re-validation for history: hidden profiles and unavailable jobs drop out. */
export async function refreshEmploymentPayload(
  payload: Record<string, unknown>,
  context: { actorId: string; market: Market; query?: unknown },
): Promise<Record<string, unknown>> {
  const employment = payload.employment as Record<string, unknown> | undefined;
  if (!employment) return payload;
  const ids = Array.isArray(payload.resourceIds) ? payload.resourceIds.filter((id): id is string => typeof id === "string") : [];
  if (employment.view === "CANDIDATE_SEARCH_RESULTS" || employment.view === "CANDIDATE_DETAILS") {
    const rows = await searchCandidates(context.market, context.actorId, { terms: [], skills: [], workplaceModes: [] }, { allowedIds: ids });
    return {
      ...payload,
      employment: {
        ...employment,
        ...(employment.view === "CANDIDATE_DETAILS"
          ? { candidate: rows[0] ? candidateCardView(rows[0]) : null }
          : { candidates: rows.map((row) => candidateCardView(row)) }),
      },
    };
  }
  if (employment.view === "JOB_SEARCH_RESULTS") {
    const rows = await searchJobs(context.market, emptyJobSearch(), { allowedIds: ids });
    const visible = new Set(rows.map((row) => row.id));
    const jobsList = Array.isArray(employment.jobs) ? employment.jobs : [];
    return { ...payload, employment: { ...employment, jobs: jobsList.filter((job: any) => visible.has(job?.id)) } };
  }
  const status = storedEmploymentActionStatus(context.query);
  const withStatus =
    status && employment.action && typeof employment.action === "object"
      ? { ...employment, action: { ...(employment.action as object), status } }
      : employment;
  return {
    ...payload,
    employment: await withCurrentApplicationViews(withStatus, {
      actorId: context.actorId,
      market: context.market,
    }),
  };
}

/**
 * Stored conversation blocks may predate snapshot-authoritative application
 * views. Rebuild employer cards from application rows on history reads so old
 * blocks cannot restore live CV fields or contact removed since rendering.
 */
async function withCurrentApplicationViews(
  employment: Record<string, unknown>,
  context: { actorId: string; market: Market },
): Promise<Record<string, unknown>> {
  const cards: Record<string, unknown>[] = [];
  const collect = (value: unknown) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { id?: unknown }).id === "string" &&
      (value as { candidate?: unknown }).candidate &&
      typeof (value as { candidate?: unknown }).candidate === "object"
    )
      cards.push(value as Record<string, unknown>);
  };
  for (const application of Array.isArray(employment.applications) ? employment.applications : [])
    collect(application);
  collect(employment.application);
  if (!cards.length) return employment;
  const rows = await db
    .select({
      application: jobApplications,
      profile: candidateProfiles,
      candidateStatus: users.status,
      job: jobs,
    })
    .from(jobApplications)
    .innerJoin(candidateProfiles, eq(candidateProfiles.id, jobApplications.candidateProfileId))
    .innerJoin(users, eq(users.id, candidateProfiles.userId))
    .innerJoin(jobs, eq(jobs.id, jobApplications.jobId))
    .where(
      and(
        inArray(jobApplications.id, [...new Set(cards.map((card) => String(card.id)))]),
        eq(jobs.ownerUserId, context.actorId),
        eq(jobs.marketId, context.market.id),
        eq(jobApplications.marketId, context.market.id),
        eq(candidateProfiles.marketId, context.market.id),
      ),
    );
  const byApplicationId = new Map(rows.map((row) => [row.application.id, row]));
  const refreshCard = (value: Record<string, unknown>) => {
    const row = byApplicationId.get(String(value.id));
    return row ? employerApplicationView(row, row.job) : undefined;
  };

  if (Array.isArray(employment.applications)) {
    employment.applications = employment.applications.flatMap((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !(value as { candidate?: unknown }).candidate
      )
        return [value];
      const refreshed = refreshCard(value as Record<string, unknown>);
      return refreshed ? [refreshed] : [];
    });
  }
  const singleApplication = employment.application;
  if (
    singleApplication &&
    typeof singleApplication === "object" &&
    !Array.isArray(singleApplication) &&
    (singleApplication as { candidate?: unknown }).candidate
  ) {
    const refreshed = refreshCard(singleApplication as Record<string, unknown>);
    if (refreshed) employment.application = refreshed;
    else delete employment.application;
  }
  return employment;
}
