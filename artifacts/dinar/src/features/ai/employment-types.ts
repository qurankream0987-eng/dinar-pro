/** Allowlisted employment views sent by the server (Block C). The client only renders them. */
import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";
export const EMPLOYMENT_SURFACES = CONVERSATION_SURFACE_FAMILIES.employment;
export type EmploymentSurface = (typeof EMPLOYMENT_SURFACES)[number];

export type MatchSignal = {
  kind: "SKILL" | "EXPERIENCE" | "WORKPLACE" | "EMPLOYMENT_TYPE" | "LOCATION";
  status: "MET" | "NOT_MET" | "UNKNOWN";
  label: string;
};

export type EmploymentJob = {
  id: string;
  title: string;
  description: string;
  skills: string[];
  minExperienceYears: number | null;
  city: string;
  workplaceMode: "ONSITE" | "REMOTE" | "HYBRID";
  employmentType: "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP";
  salary: string | null;
  publishedAt: string;
  status?: string;
  applicationCount?: number;
  signals?: MatchSignal[];
};

export type EmploymentCandidate = {
  id: string;
  professionalTitle: string;
  skills: string[];
  experienceYears: number | null;
  experiences: { role: string; organization?: string; startYear?: number; endYear?: number }[];
  education: { field: string; qualification?: string; institution?: string }[];
  city: string;
  workplacePreferences: string[];
  employmentTypePreferences: string[];
  portfolioLinks: string[];
  contactPhone: string | null;
  summary?: string;
  visibility?: "PRIVATE" | "DISCOVERABLE";
};

export type EmploymentDraft = {
  draftId: string;
  title: string | null;
  description: string | null;
  skills: string[];
  minExperienceYears: number | null;
  city: string | null;
  workplaceMode: string | null;
  employmentType: string | null;
  salary: string | null;
};

export type EmploymentApplication = {
  id: string;
  status: "SUBMITTED" | "VIEWED" | "SHORTLISTED" | "REJECTED" | "WITHDRAWN";
  submittedAt: string;
  job?: { id: string; title: string; status: string; city: string; workplaceMode: string; employmentType: string; salary: string | null };
  submittedJob?: { title: string; salary: string | null; version: number };
  submitted?: { professionalTitle: string; skills: string[]; experienceYears: number | null; city: string };
  candidate?: EmploymentCandidate;
  signals?: MatchSignal[];
};

export type EmploymentAction = {
  actionId: string;
  type: string;
  title: string;
  confirmLabel: string;
  lines: string[];
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
};

export type EmploymentPayload = {
  view: EmploymentSurface;
  jobs?: EmploymentJob[];
  job?: EmploymentJob;
  audience?: "PUBLIC" | "OWNER";
  draft?: EmploymentDraft;
  missingField?: string;
  profile?: EmploymentCandidate;
  candidates?: EmploymentCandidate[];
  candidate?: EmploymentCandidate | null;
  applications?: EmploymentApplication[];
  application?: EmploymentApplication;
  signals?: MatchSignal[];
  applicationStatus?: string;
  action?: EmploymentAction;
  filters?: string[];
  ignoredCriteria?: string[];
  notice?: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasId = (value: unknown) => isObject(value) && typeof value.id === "string";
const listOf = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every(hasId));

/** Shape check of a server employment payload; anything unexpected is not rendered. */
export function normalizeEmployment(value: unknown, surface: string): EmploymentPayload | null {
  if (!isObject(value) || value.view !== surface) return null;
  if (!(EMPLOYMENT_SURFACES as readonly string[]).includes(surface)) return null;
  if (!listOf(value.jobs) || !listOf(value.candidates) || !listOf(value.applications)) return null;
  if (value.job !== undefined && !hasId(value.job)) return null;
  if (value.profile !== undefined && !hasId(value.profile)) return null;
  if (value.action !== undefined) {
    const action = value.action;
    if (
      !isObject(action) ||
      typeof action.actionId !== "string" ||
      !["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"].includes(String(action.status)) ||
      !Array.isArray(action.lines)
    )
      return null;
  }
  return value as unknown as EmploymentPayload;
}
