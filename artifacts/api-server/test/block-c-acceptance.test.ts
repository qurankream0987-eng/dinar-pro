import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { and, desc, eq, inArray } from "drizzle-orm";
import app from "../src/app";
import {
  aiResultSets,
  candidateProfiles,
  db,
  jobApplications,
  jobs,
  marketplacePolicyRules,
  pool,
  users,
} from "@workspace/db";
import {
  getModelGatewayCallCount,
  resetModelGatewayCallCount,
} from "../src/ai/model-gateway";
import {
  applicationReadiness,
  applicationsForOwnedJob,
  changeApplicationStatus,
  changeOwnedJobStatus,
  emptyJobSearch,
  employerApplicationView,
  ensureOwnProfile,
  ownApplications,
  ownProfile,
  publishJobDraft,
  searchCandidates,
  searchJobs,
  submitApplication,
  updateOwnProfile,
  updateOwnedJob,
  withdrawOwnApplication,
} from "../src/lib/employment";
import { marketFor } from "../src/lib/markets";
import { deactivateOwnAccount, setUserModerationStatus } from "../src/lib/moderation";
import { refreshEmploymentPayload } from "../src/ai/employment-turn";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";

requireSafeReplitDevelopmentDatabase("BDINAR_BLOCKC_ACCEPTANCE");
// Any model call would throw and be counted; deterministic employment flows must make none.
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const providerConfigured = Boolean(
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY,
);
const execFileAsync = promisify(execFile);

// Every outbound request from this process that leaves loopback is recorded.
const external: string[] = [];
const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.replace(/:\d+$/, ""));
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!loopback(url.hostname)) external.push(url.hostname);
  } catch {
    // Non-URL inputs are not network requests.
  }
  return originalFetch(input, init);
}) as typeof fetch;
for (const module of [http, https] as any[]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = (...args: any[]) => {
      const first = args[0];
      const host =
        typeof first === "string" || first instanceof URL
          ? new URL(String(first)).hostname
          : String(first?.hostname ?? first?.host ?? "");
      if (host && !loopback(host)) external.push(host);
      return original.apply(module, args);
    };
  }
}

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api`;
let authSequence = 0;
const runId = randomUUID().replaceAll("-", "").slice(0, 8);

type ApiResponse = { status: number; data: any; cookie: string; raw: string };
async function request(path: string, method = "GET", body?: unknown, cookie = ""): Promise<ApiResponse> {
  const rateLimited = path.startsWith("/auth/");
  const ip = rateLimited
    ? `198.20.${Math.floor(authSequence / 250) % 250}.${(authSequence++ % 250) + 1}`
    : undefined;
  const response = await originalFetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { "X-Forwarded-For": ip } : {}),
    },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", raw };
}

type Actor = { id: string; cookie: string; phone: string; label: string };
// Kuwait mobile numbers in the known-valid 51xxxxxx range (see phone fixture notes).
const phoneBase = 51_100_000 + ((Date.now() + process.pid) % 600_000);
let phoneOffset = 0;
async function register(label: string, marketId = "JO"): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * phoneOffset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  assert.equal(started.status, 202, started.raw);
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", {
    challengeId: started.data.challengeId,
    code: started.data.developmentCode,
  });
  assert.equal(verified.status, 200, verified.raw);
  const password = `BlockC-${randomUUID().slice(0, 12)}!`;
  const registered = await request("/auth/register", "POST", {
    displayName: `DINAR Block C ${label}`,
    accountCountry: "KW",
    phoneCountryCode: "+965",
    phoneNumber,
    password,
    confirmPassword: password,
    acceptTerms: true,
    verificationToken: verified.data.verificationToken,
  });
  assert.equal(registered.status, 201, registered.raw);
  const market = await request("/account/market", "PATCH", { marketId }, registered.cookie);
  assert.equal(market.status, 200, market.raw);
  return { id: registered.data.user.id, cookie: registered.cookie, phone: phoneNumber, label };
}

function completion(raw: string): any {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.type === "complete");
}

const modelCalls: { phrase: string; calls: number }[] = [];
// Every employment payload returned to any actor, scanned for leaks in C21.
const payloadLog: string[] = [];
// Phrases that reached marketplace listing search instead of an employment surface.
const marketplaceRouted: string[] = [];
type TurnResult = { body: string; payload: any; employment: any };
async function turn(actor: Actor, conversationId: string, message: string): Promise<TurnResult> {
  const before = getModelGatewayCallCount();
  const response = await originalFetch(`${base}/ai/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: actor.cookie },
    body: JSON.stringify({ message }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const complete = completion(raw);
  assert.ok(complete, `turn "${message}" did not complete: ${raw.slice(0, 500)}`);
  const calls = getModelGatewayCallCount() - before;
  modelCalls.push({ phrase: message, calls });
  assert.equal(calls, 0, `model call for deterministic phrase ${message}`);
  const block = complete.assistantMessage.blocks[0];
  if (block?.payload?.employment) payloadLog.push(JSON.stringify(block));
  else if (block?.type === "LISTING_RESULTS") marketplaceRouted.push(message);
  return { body: complete.assistantMessage.body, payload: block?.payload, employment: block?.payload?.employment };
}

async function conversation(actor: Actor): Promise<string> {
  const created = await request("/ai/conversations", "POST", {}, actor.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id;
}

async function latestSet(conversationId: string) {
  const [row] = await db
    .select()
    .from(aiResultSets)
    .where(eq(aiResultSets.conversationId, conversationId))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(1);
  return row!;
}

async function jobsOf(actor: Actor) {
  return db.select().from(jobs).where(eq(jobs.ownerUserId, actor.id)).orderBy(desc(jobs.publishedAt));
}

async function expectStatus(attempt: Promise<unknown> | (() => Promise<unknown>), status: number): Promise<boolean> {
  try {
    await (typeof attempt === "function" ? attempt() : attempt);
    return false;
  } catch (error) {
    return (error as { status?: number }).status === status;
  }
}

/** Creates a job through the real conversational draft and explicit publish. */
async function createJobViaChat(actor: Actor, lines: string[]): Promise<string> {
  const conversationId = await conversation(actor);
  let last: TurnResult | undefined;
  for (const line of lines) last = await turn(actor, conversationId, line);
  assert.equal(last!.payload.surface, "JOB_REVIEW", JSON.stringify(last!.employment));
  const published = await turn(actor, conversationId, "نشر");
  assert.equal(published.payload.surface, "JOB_DETAILS", published.body);
  return published.employment.job.id;
}

async function publishFixtureJob(
  actor: Actor,
  market: Awaited<ReturnType<typeof marketFor>>,
  title: string,
) {
  const result = await publishJobDraft({
    actorId: actor.id,
    market,
    draft: {
      draftId: randomUUID(),
      title,
      skills: ["React"],
      minExperienceYears: 1,
      workplaceMode: "REMOTE",
      employmentType: "FULL_TIME",
      salary: null,
    },
  });
  return result.job;
}

let employerA: Actor;
let employerB: Actor;
let candidateA: Actor;
let candidateB: Actor;
let candidateC: Actor;
let candidateD: Actor;
let browserCandidate: Actor;
let browserEmployer: Actor;
let outsider: Actor;
let moderator: Actor;
const job: Record<string, string> = {};
const results: Record<string, "PASS" | "FAIL"> = {};
let applicationA1 = "";
let c05CandidateApplicationId = "";
let c05CandidateJobId = "";
let c05EmployerJobId = "";
let c05KuwaitJobId = "";
let c05ContactView: any;
let c05ContactPhone = "";
let jobSearchIds: string[] = [];
let crossEmployer = { passed: 0, total: 0 };
let crossCandidate = { passed: 0, total: 0 };
const createdRuleIds: string[] = [];

async function acceptance(id: string, name: string, body: () => Promise<void>) {
  await test(`${id} ${name}`, async () => {
    try {
      await body();
      results[id] = "PASS";
    } catch (error) {
      results[id] = "FAIL";
      throw error;
    }
  });
}

await test("setup: providers off, disposable market, fresh actors", async () => {
  resetModelGatewayCallCount();
  assert.equal(providerConfigured, false, "Block C runs with the external AI provider unconfigured");
  employerA = await register("Employer A");
  employerB = await register("Employer B");
  candidateA = await register("Candidate A");
  candidateB = await register("Candidate B");
  candidateC = await register("Candidate C");
  candidateD = await register("Candidate D");
  browserCandidate = await register("C23 Browser Candidate");
  browserEmployer = await register("C23 Browser Employer");
  outsider = await register("Outsider", "KW");
  moderator = await register("C0.5 Moderator");
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, moderator.id));
});

await acceptance("C01", "employer creates a job conversationally with explicit publish", async () => {
  const conversationId = await conversation(employerA);
  let step = await turn(employerA, conversationId, "أريد موظف Front-end في عمان");
  assert.equal(step.payload.surface, "JOB_DRAFT");
  assert.equal(step.employment.draft.title, "Front-end Developer");
  assert.equal(step.employment.draft.city, "عمان");
  assert.equal(step.employment.missingField, "skills");
  step = await turn(employerA, conversationId, "React و TypeScript");
  assert.deepEqual(step.employment.draft.skills, ["React", "TypeScript"]);
  assert.equal(step.employment.missingField, "experience");
  step = await turn(employerA, conversationId, "خبرة سنتين");
  assert.equal(step.employment.draft.minExperienceYears, 2);
  assert.equal(step.employment.missingField, "employment");
  step = await turn(employerA, conversationId, "دوام كامل وهجين");
  assert.equal(step.employment.draft.employmentType, "FULL_TIME");
  assert.equal(step.employment.draft.workplaceMode, "HYBRID");
  assert.equal(step.employment.missingField, "salary", "city was already known and is not asked again");
  step = await turn(employerA, conversationId, "من 700 إلى 900");
  assert.equal(step.payload.surface, "JOB_REVIEW");
  assert.equal(step.employment.action.status, "PENDING");
  assert.match(step.employment.draft.salary, /700 – 900 JOD/);
  assert.equal((await jobsOf(employerA)).length, 0, "no job before explicit publish");
  const reviewActionId = step.employment.action.actionId;
  const published = await turn(employerA, conversationId, "نشر");
  assert.equal(published.payload.surface, "JOB_DETAILS");
  const [row] = await jobsOf(employerA);
  assert.ok(row);
  assert.equal(row.ownerUserId, employerA.id);
  assert.equal(row.marketId, "JO");
  assert.equal(row.status, "PUBLISHED");
  assert.equal(row.title, "Front-end Developer");
  assert.deepEqual(row.skills, ["React", "TypeScript"]);
  assert.equal(row.minExperienceYears, 2);
  assert.equal(row.city, "عمان");
  assert.equal(row.workplaceMode, "HYBRID");
  assert.equal(row.employmentType, "FULL_TIME");
  assert.equal(row.salaryMinMinor, 700_000);
  assert.equal(row.salaryMaxMinor, 900_000);
  assert.equal(row.salaryCurrency, "JOD");
  assert.equal(row.salaryPeriod, "MONTH");
  job.frontend = row.id;

  // Idempotent publication: a network retry of the same confirmation and a repeated «نشر».
  const retry = await request(`/ai/employment-actions/${reviewActionId}/action`, "POST", { action: "CONFIRM" }, employerA.cookie);
  assert.equal(retry.status, 200, retry.raw);
  assert.equal(retry.data.status, "CONFIRMED");
  const repeat = await turn(employerA, conversationId, "نشر");
  assert.notEqual(repeat.payload.surface, "JOB_DETAILS");
  assert.equal((await jobsOf(employerA)).length, 1, "one logical job");
});

await acceptance("C01b", "drafts keep corrections, cancel cleanly, and never invent a title", async () => {
  const conversationId = await conversation(employerB);
  let step = await turn(employerB, conversationId, "أريد موظف React developer");
  assert.equal(step.employment.draft.title, "React developer");
  step = await turn(employerB, conversationId, "خلي المسمى Front-end Engineer");
  assert.equal(step.employment.draft.title, "Front-end Engineer", "the employer's correction wins");
  step = await turn(employerB, conversationId, "React");
  assert.equal(step.employment.draft.title, "Front-end Engineer");
  const cancelled = await turn(employerB, conversationId, "إلغاء");
  assert.equal(cancelled.payload.surface, "EMPLOYMENT_NOTICE");
  assert.equal((await jobsOf(employerB)).length, 0);

  const unclassified = await conversation(employerB);
  const vague = await turn(employerB, unclassified, "أحتاج شخص يساعدني بالمبيعات والمخزن");
  assert.equal(vague.payload.surface, "JOB_DRAFT");
  assert.equal(vague.employment.draft.title, null, "no confident title is invented");
  assert.equal(vague.employment.draft.description, "أحتاج شخص يساعدني بالمبيعات والمخزن");
  assert.deepEqual(vague.employment.draft.skills, ["مبيعات", "إدارة مخزون"]);
  assert.equal(vague.employment.missingField, "title");
});

await acceptance("C01c", "rapid double confirmation creates one logical job", async () => {
  const conversationId = await conversation(employerB);
  for (const line of ["أريد موظف مندوب مبيعات في عمان", "مبيعات، خدمة عملاء", "بدون خبرة", "دوام جزئي حضوري"])
    await turn(employerB, conversationId, line);
  const review = await turn(employerB, conversationId, "راتب 400");
  assert.equal(review.payload.surface, "JOB_REVIEW");
  const actionId = review.employment.action.actionId;
  const responses = await Promise.all(
    [0, 1, 2].map(() => request(`/ai/employment-actions/${actionId}/action`, "POST", { action: "CONFIRM" }, employerB.cookie)),
  );
  for (const response of responses) assert.equal(response.status, 200, response.raw);
  assert.equal(responses.filter((response) => response.data.status === "CONFIRMED").length, 3);
  const rows = await jobsOf(employerB);
  assert.equal(rows.length, 1, "one logical job after triple submission");
  job.sales = rows[0]!.id;
});

await test("fixtures: more real jobs through the same conversational path", async () => {
  job.accountant = await createJobViaChat(employerA, [
    "أريد موظف محاسب في عمان",
    "Excel، محاسبة",
    "خبرة 3 سنوات",
    "دوام كامل حضوري",
    "700",
  ]);
  job.react = await createJobViaChat(employerA, [
    "أنشئ لي إعلان وظيفة React Developer",
    "React و TypeScript",
    "خبرة سنتين",
    "دوام كامل عن بعد",
    "بدون",
  ]);
  job.onsiteReact = await createJobViaChat(employerB, [
    "أريد موظف React Engineer في عمان",
    "React",
    "خبرة 3 سنوات",
    "دوام كامل حضوري",
    "بدون",
  ]);
  const [react] = await db.select().from(jobs).where(eq(jobs.id, job.react));
  assert.equal(react!.workplaceMode, "REMOTE");
  assert.equal(react!.city, "", "a remote job is not given an invented city");
  assert.equal(react!.salaryMinMinor, null);
});

await acceptance("C02", "a different candidate finds the exact employer-created job", async () => {
  const conversationId = await conversation(candidateA);
  let step = await turn(candidateA, conversationId, "أريد وظيفة Front-end");
  assert.equal(step.payload.surface, "JOB_SEARCH_RESULTS");
  assert.ok(step.payload.resourceIds.includes(job.frontend));
  step = await turn(candidateA, conversationId, "في عمان");
  assert.ok(step.payload.resourceIds.includes(job.frontend));
  step = await turn(candidateA, conversationId, "هجين");
  assert.deepEqual(step.payload.resourceIds, [job.frontend], "Front-end + Amman + hybrid is exactly the persisted job");
  const set = await latestSet(conversationId);
  assert.deepEqual((set.query as any).jobSearch.workplaceModes, ["HYBRID"]);
  assert.equal((set.query as any).jobSearch.city, "عمان");
});

await acceptance("C03", "ordinal opens the exact displayed job; invented ids are rejected", async () => {
  const conversationId = await conversation(candidateA);
  const list = await turn(candidateA, conversationId, "أريد وظيفة دوام كامل");
  jobSearchIds = list.payload.resourceIds;
  assert.ok(jobSearchIds.length >= 3, JSON.stringify(jobSearchIds));
  const opened = await turn(candidateA, conversationId, "افتح الثانية");
  assert.equal(opened.payload.surface, "JOB_DETAILS");
  assert.equal(opened.employment.job.id, jobSearchIds[1]);
  assert.equal(opened.payload.resourceIds[0], jobSearchIds[1]);
  const back = await turn(candidateA, conversationId, "رجعني");
  assert.deepEqual(back.payload.resourceIds, jobSearchIds);
  const outOfRange = await turn(candidateA, conversationId, "افتح الوظيفة رقم 20");
  assert.equal(outOfRange.payload.surface, "EMPLOYMENT_NOTICE");
  const invented = await request(`/ai/employment-actions/${randomUUID()}/action`, "POST", { action: "CONFIRM" }, candidateA.cookie);
  assert.equal(invented.status, 404);
  const malformed = await request("/ai/employment-actions/not-a-uuid/action", "POST", { action: "CONFIRM" }, candidateA.cookie);
  assert.equal(malformed.status, 400);
});

await acceptance("C04", "back restores the same job result set; refinement stays contextual", async () => {
  const conversationId = await conversation(candidateA);
  const list = await turn(candidateA, conversationId, "أريد وظيفة دوام كامل");
  const ids = list.payload.resourceIds;
  await turn(candidateA, conversationId, "الثانية");
  const back = await turn(candidateA, conversationId, "رجعني");
  assert.equal(back.payload.surface, "JOB_SEARCH_RESULTS");
  assert.deepEqual(back.payload.resourceIds, ids);
  const remote = await turn(candidateA, conversationId, "عن بعد");
  assert.deepEqual(remote.payload.resourceIds, [job.react]);
  const set = await latestSet(conversationId);
  assert.deepEqual((set.query as any).jobSearch.employmentTypes, ["FULL_TIME"], "earlier constraint kept");
  assert.deepEqual((set.query as any).jobSearch.workplaceModes, ["REMOTE"]);
});

await acceptance("C05", "employer ordinal management keeps salary and ordinal numbers apart", async () => {
  const conversationId = await conversation(employerA);
  const mine = await turn(employerA, conversationId, "اعرض وظائفي");
  assert.equal(mine.payload.surface, "MY_JOBS");
  const ids: string[] = mine.payload.resourceIds;
  assert.deepEqual(ids, [job.react, job.accountant, job.frontend]);
  const before = await db.select().from(jobs).where(inArray(jobs.id, ids));
  const preview = await turn(employerA, conversationId, "غير راتب الوظيفة الثانية إلى 800");
  assert.equal(preview.payload.surface, "EMPLOYMENT_ACTION");
  assert.equal(preview.employment.job.id, ids[1], "ordinal 2, not job #800");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, ids[1]!)))[0]!.salaryMinMinor, 700_000, "preview does not mutate");
  const confirmed = await turn(employerA, conversationId, "نعم");
  assert.equal(confirmed.payload.surface, "MY_JOBS");
  const after = await db.select().from(jobs).where(inArray(jobs.id, ids));
  const byId = (rows: typeof after, id: string) => rows.find((row) => row.id === id)!;
  assert.equal(byId(after, ids[1]!).salaryMinMinor, 800_000);
  assert.equal(byId(after, ids[1]!).version, byId(before, ids[1]!).version + 1);
  for (const id of [ids[0]!, ids[2]!]) {
    assert.equal(byId(after, id).salaryMinMinor, byId(before, id).salaryMinMinor);
    assert.equal(byId(after, id).version, byId(before, id).version);
  }
  const refreshed = await request(`/ai/conversations/${conversationId}`, "GET", undefined, employerA.cookie);
  assert.equal(refreshed.status, 200, refreshed.raw);
  const refreshedBlocks = refreshed.data.messages.flatMap((message: any) => message.blocks);
  const refreshedJobs = refreshedBlocks.filter((block: any) => block.payload.surface === "MY_JOBS").at(-1);
  const refreshedTarget = refreshedJobs?.payload.employment.jobs.find((item: any) => item.id === ids[1]);
  assert.ok(refreshedTarget);
  assert.match(refreshedTarget.salary, /800/, "the confirmed edit is still present after reload");
  await turn(employerA, conversationId, "وقف الوظيفة الثالثة");
  await turn(employerA, conversationId, "نعم");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, ids[2]!)))[0]!.status, "PAUSED");
  // A paused job leaves discovery.
  const seeker = await conversation(candidateD);
  const hidden = await turn(candidateD, seeker, "أريد وظيفة Front-end");
  assert.ok(!hidden.payload.resourceIds.includes(job.frontend));
  await turn(employerA, conversationId, "أعد نشر الوظيفة الثالثة");
  await turn(employerA, conversationId, "نعم");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, ids[2]!)))[0]!.status, "PUBLISHED");
  const shown = await turn(candidateD, seeker, "أريد وظيفة Front-end");
  assert.ok(shown.payload.resourceIds.includes(job.frontend));
  // A later unrelated «نعم» confirms nothing.
  const stale = await turn(employerA, conversationId, "نعم");
  assert.equal(stale.payload.surface, "EMPLOYMENT_NOTICE");
});

await acceptance("C06", "a candidate builds a structured profile; private by default", async () => {
  const conversationId = await conversation(candidateA);
  const created = await turn(candidateA, conversationId, "أريد أنشئ ملف وظيفي");
  assert.equal(created.payload.surface, "CV_PROFILE");
  assert.equal(created.employment.profile.visibility, "PRIVATE");
  for (const line of [
    "أنا مطور Front-end عندي خبرة 3 سنوات React",
    "أضف TypeScript و PHP",
    "درست هندسة برمجيات في جامعة اليرموك",
    "اشتغلت مطور واجهات في شركة نجمة من 2021 إلى 2024",
    "أسكن في عمان",
    "أفضل العمل هجين ودوام كامل",
  ])
    await turn(candidateA, conversationId, line);
  const [profile] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateA.id));
  assert.ok(profile);
  assert.equal(profile.professionalTitle, "مطور Front-end");
  assert.equal(profile.experienceYears, 3);
  assert.deepEqual(profile.skills, ["React", "TypeScript", "PHP"]);
  assert.deepEqual(profile.education, [{ field: "هندسة برمجيات", institution: "اليرموك" }]);
  assert.deepEqual(profile.experiences, [{ role: "مطور واجهات", organization: "نجمة", startYear: 2021, endYear: 2024 }]);
  assert.equal(profile.city, "عمان");
  assert.deepEqual(profile.workplacePreferences, ["HYBRID"]);
  assert.deepEqual(profile.employmentTypePreferences, ["FULL_TIME"]);
  assert.equal(profile.visibility, "PRIVATE");
  assert.equal(profile.contactMode, "NO_DIRECT_CONTACT");
  assert.equal(profile.contactPhone, null, "the login phone is never copied into the profile");
});

await acceptance("C07", "CV edits persist across reload without touching the account", async () => {
  const [userBefore] = await db.select().from(users).where(eq(users.id, candidateA.id));
  const conversationId = await conversation(candidateA);
  await turn(candidateA, conversationId, "اعرض سيرتي");
  await turn(candidateA, conversationId, "أضف TypeScript");
  await turn(candidateA, conversationId, "احذف PHP");
  const renamed = await turn(candidateA, conversationId, "غير المسمى إلى Front-end Engineer");
  assert.equal(renamed.employment.profile.professionalTitle, "Front-end Engineer");
  const history = await request(`/ai/conversations/${conversationId}`, "GET", undefined, candidateA.cookie);
  assert.equal(history.status, 200);
  const last = history.data.messages.flatMap((message: any) => message.blocks).filter((block: any) => block.payload.surface === "CV_PROFILE").at(-1);
  assert.equal(last.payload.employment.profile.professionalTitle, "Front-end Engineer");
  const [profile] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateA.id));
  assert.deepEqual(profile!.skills, ["React", "TypeScript"]);
  const [userAfter] = await db.select().from(users).where(eq(users.id, candidateA.id));
  for (const field of ["displayName", "phoneNumber", "normalizedPhone", "city", "area", "status", "activeMarketId"] as const)
    assert.equal(userAfter![field], userBefore![field], `account ${field} unchanged`);
});

await acceptance("C08", "visibility controls discovery; applications survive hiding", async () => {
  const candidateConversation = await conversation(candidateB);
  await turn(candidateB, candidateConversation, "أنشئ لي سيرة، أنا محاسب عندي خبرة 3 سنوات");
  await turn(candidateB, candidateConversation, "أضف Excel ومحاسبة");
  await turn(candidateB, candidateConversation, "أسكن في عمان");
  await turn(candidateB, candidateConversation, `رقم التواصل 9${String(phoneBase).slice(1, 8)}`);
  const [profile] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateB.id));
  assert.equal(profile!.visibility, "PRIVATE");
  const search = "أبحث عن محاسب في عمان خبرة 3 سنوات";
  const employerConversation = await conversation(employerA);
  const hidden = await turn(employerA, employerConversation, search);
  assert.equal(hidden.payload.surface, "CANDIDATE_SEARCH_RESULTS");
  assert.ok(!hidden.payload.resourceIds.includes(profile!.id), "PRIVATE profile is not discoverable");
  const shown = await turn(candidateB, candidateConversation, "اجعل ملفي ظاهر لأصحاب العمل");
  assert.equal(shown.employment.profile.visibility, "DISCOVERABLE");
  const found = await turn(employerA, employerConversation, search);
  assert.ok(found.payload.resourceIds.includes(profile!.id), "DISCOVERABLE profile is found");
  const details = await turn(employerA, employerConversation, "افتح المرشح الأول");
  assert.equal(details.payload.surface, "CANDIDATE_DETAILS");
  assert.equal(details.employment.candidate.id, profile!.id);
  assert.equal(details.employment.candidate.professionalTitle, profile!.professionalTitle);
  assert.equal(details.employment.candidate.contactPhone, profile!.contactPhone);
  // Apply while discoverable, then hide: the application remains.
  const apply = await conversation(candidateB);
  const results = await turn(candidateB, apply, "أريد وظيفة محاسب");
  const index = results.payload.resourceIds.indexOf(job.accountant);
  assert.ok(index >= 0);
  await turn(candidateB, apply, `قدم على الوظيفة رقم ${index + 1}`);
  await turn(candidateB, apply, "تأكيد التقديم");
  const hiddenAgain = await turn(candidateB, candidateConversation, "اخف ملفي");
  assert.equal(hiddenAgain.employment.profile.visibility, "PRIVATE");
  const gone = await turn(employerA, employerConversation, search);
  assert.ok(!gone.payload.resourceIds.includes(profile!.id), "hidden again → not discoverable");
  // Reload: the earlier employer result block no longer shows the hidden profile.
  const history = await request(`/ai/conversations/${employerConversation}`, "GET", undefined, employerA.cookie);
  const candidateBlocks = history.data.messages.flatMap((message: any) => message.blocks).filter((block: any) => block.payload.surface === "CANDIDATE_SEARCH_RESULTS");
  assert.ok(candidateBlocks.length >= 2, "history includes both the earlier discoverable result and the fresh hidden search");
  for (const block of candidateBlocks)
    assert.ok(!block.payload.employment.candidates.some((candidate: any) => candidate.id === profile!.id));
  const detailBlocks = history.data.messages
    .flatMap((message: any) => message.blocks)
    .filter((block: any) => block.payload.surface === "CANDIDATE_DETAILS");
  assert.ok(detailBlocks.length > 0, "history retains the earlier candidate detail surface");
  for (const block of detailBlocks) {
    assert.equal(block.payload.employment.candidate, null, "hidden candidate details are removed from history");
    const serialized = JSON.stringify(block.payload.employment);
    assert.equal(serialized.includes(profile!.professionalTitle), false, "hidden professional details do not remain in history");
    assert.equal(serialized.includes(profile!.contactPhone), false, "hidden candidate contact does not remain in history");
    assert.equal(serialized.includes(candidateB.phone), false, "candidate login phone is never exposed in history");
  }
  for (const block of candidateBlocks) {
    const serialized = JSON.stringify(block.payload.employment.candidates);
    assert.equal(serialized.includes(profile!.contactPhone), false, "hidden candidate contact is removed from old search cards");
    assert.equal(serialized.includes(candidateB.phone), false, "candidate login phone is never exposed in old search cards");
  }
  const applications = await db.select().from(jobApplications).where(eq(jobApplications.candidateUserId, candidateB.id));
  assert.equal(applications.length, 1, "existing application remains after hiding");
});

await acceptance("C09", "employer finds the exact discoverable accountant by job-related criteria", async () => {
  const candidateConversation = await conversation(candidateB);
  await turn(candidateB, candidateConversation, "اعرض سيرتي");
  await turn(candidateB, candidateConversation, "اجعل ملفي ظاهر لأصحاب العمل");
  const [profile] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateB.id));
  const employerConversation = await conversation(employerA);
  const found = await turn(employerA, employerConversation, "أبحث عن محاسب في عمان خبرة 3 سنوات");
  assert.ok(found.payload.resourceIds.includes(profile!.id));
  const set = await latestSet(employerConversation);
  assert.deepEqual((set.query as any).candidateSearch, {
    terms: ["محاسب"],
    skills: [],
    city: "عمان",
    minExperienceYears: 3,
    workplaceModes: [],
  });
  const card = found.employment.candidates.find((candidate: any) => candidate.id === profile!.id);
  assert.equal(card.professionalTitle, "محاسب");
  assert.deepEqual(card.skills, ["Excel", "محاسبة"]);
  // Too much required experience excludes the candidate deterministically.
  const stricter = await turn(employerA, employerConversation, "أبحث عن محاسب في عمان خبرة 5 سنوات");
  assert.ok(!stricter.payload.resourceIds.includes(profile!.id));
});

await acceptance("C10", "application review first, then one real application on confirmation", async () => {
  const conversationId = await conversation(candidateA);
  const list = await turn(candidateA, conversationId, "أريد وظيفة React في عمان");
  assert.deepEqual(list.payload.resourceIds, [job.onsiteReact, job.frontend]);
  const review = await turn(candidateA, conversationId, "قدم لي على الوظيفة الثانية");
  assert.equal(review.payload.surface, "APPLICATION_REVIEW");
  assert.equal(review.employment.job.id, job.frontend);
  assert.equal(review.employment.action.status, "PENDING");
  assert.equal((await db.select().from(jobApplications).where(eq(jobApplications.candidateUserId, candidateA.id))).length, 0, "no application before confirmation");
  const done = await turn(candidateA, conversationId, "تأكيد التقديم");
  assert.equal(done.payload.surface, "MY_APPLICATIONS");
  const rows = await db.select().from(jobApplications).where(eq(jobApplications.candidateUserId, candidateA.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.jobId, job.frontend);
  assert.equal(rows[0]!.status, "SUBMITTED");
  assert.equal(rows[0]!.jobSnapshot.title, "Front-end Developer");
  assert.equal(rows[0]!.candidateSnapshot.professionalTitle, "Front-end Engineer");
  applicationA1 = rows[0]!.id;
  // Retry of the same confirmation does not create a second application.
  const retry = await request(`/ai/employment-actions/${review.employment.action.actionId}/action`, "POST", { action: "CONFIRM" }, candidateA.cookie);
  assert.equal(retry.data.status, "CONFIRMED");
});

await acceptance("C11", "repeat and concurrent submissions stay one application per job", async () => {
  const conversationId = await conversation(candidateA);
  await turn(candidateA, conversationId, "أريد وظيفة React في عمان");
  const again = await turn(candidateA, conversationId, "قدم لي على الوظيفة الثانية");
  assert.equal(again.payload.surface, "MY_APPLICATIONS", "an existing application is shown, not re-reviewed");
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const concurrent = await Promise.all([0, 1, 2].map(() => submitApplication({ actorId: candidateA.id, market, jobId: job.frontend })));
  assert.equal(concurrent.filter((item) => item.created).length, 0);
  // A new job: concurrent confirmations of one review create exactly one row.
  const list = await turn(candidateA, conversationId, "أريد وظيفة React عن بعد");
  assert.deepEqual(list.payload.resourceIds, [job.react]);
  const review = await turn(candidateA, conversationId, "قدم على الأولى");
  const actionId = review.employment.action.actionId;
  await Promise.all([0, 1].map(() => request(`/ai/employment-actions/${actionId}/action`, "POST", { action: "CONFIRM" }, candidateA.cookie)));
  const rows = await db.select().from(jobApplications).where(eq(jobApplications.candidateUserId, candidateA.id));
  assert.equal(rows.filter((row) => row.jobId === job.frontend).length, 1);
  assert.equal(rows.filter((row) => row.jobId === job.react).length, 1);
});

await acceptance("C12", "employer sees the real applicant; another employer cannot", async () => {
  const conversationId = await conversation(employerA);
  const list = await turn(employerA, conversationId, "اعرض المتقدمين على وظيفة Front-end");
  assert.equal(list.payload.surface, "APPLICATION_LIST");
  assert.deepEqual(list.payload.resourceIds, [applicationA1]);
  const application = list.employment.applications[0];
  assert.equal(application.submitted.professionalTitle, "Front-end Engineer");
  assert.equal(application.status, "VIEWED", "opening the list is the employer's own viewing action");
  const other = await conversation(employerB);
  const denied = await turn(employerB, other, "اعرض المتقدمين على وظيفة Front-end");
  assert.notEqual(denied.payload.surface, "APPLICATION_LIST");
  assert.ok(!JSON.stringify(denied.employment ?? {}).includes(applicationA1));
});

await acceptance("C13", "status changes only by explicit human decision; auto-decisions refused", async () => {
  const conversationId = await conversation(employerA);
  await turn(employerA, conversationId, "اعرض المتقدمين على وظيفة Front-end");
  const refused = await turn(employerA, conversationId, "اختر الأفضل وارفض الباقين تلقائيًا");
  assert.equal(refused.payload.surface, "EMPLOYMENT_NOTICE");
  assert.match(refused.body, /لا يتخذ جاسم قرارات توظيف تلقائية/);
  assert.equal((await db.select().from(jobApplications).where(eq(jobApplications.id, applicationA1)))[0]!.status, "VIEWED");
  await turn(employerA, conversationId, "اعرض المتقدمين على وظيفة Front-end");
  const preview = await turn(employerA, conversationId, "ضع المتقدم الأول في القائمة المختصرة");
  assert.equal(preview.payload.surface, "EMPLOYMENT_ACTION");
  assert.equal((await db.select().from(jobApplications).where(eq(jobApplications.id, applicationA1)))[0]!.status, "VIEWED", "preview only");
  await turn(employerA, conversationId, "نعم");
  const [row] = await db.select().from(jobApplications).where(eq(jobApplications.id, applicationA1));
  assert.equal(row!.status, "SHORTLISTED");
  assert.equal(row!.statusChangedBy, employerA.id, "the authorized human employer made the change");
});

await acceptance("C14", "candidate withdraws by ordinal with confirmation; history preserved", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const currentApplications = await ownApplications(candidateA.id, market);
  if (currentApplications.length < 2) {
    const missingJobId = [job.react, job.accountant, job.frontend].find(
      (jobId) => !currentApplications.some((item) => item.job.id === jobId),
    );
    assert.ok(missingJobId, "withdrawal fixture can add a second application without relying on another acceptance test");
    await submitApplication({ actorId: candidateA.id, market, jobId: missingJobId });
  }
  const conversationId = await conversation(candidateA);
  await turn(candidateA, conversationId, "أريد وظيفة React");
  const mine = await turn(candidateA, conversationId, "اعرض طلباتي");
  assert.equal(mine.payload.surface, "MY_APPLICATIONS", "«طلباتي» after job search means job applications");
  const ids: string[] = mine.payload.resourceIds;
  assert.equal(ids.length, 2);
  const target = ids[1]!;
  const preview = await turn(candidateA, conversationId, "اسحب الطلب الثاني");
  assert.equal(preview.payload.surface, "EMPLOYMENT_ACTION");
  const cancel = await turn(candidateA, conversationId, "إلغاء");
  assert.equal(cancel.payload.surface, "EMPLOYMENT_NOTICE");
  assert.notEqual((await db.select().from(jobApplications).where(eq(jobApplications.id, target)))[0]!.status, "WITHDRAWN");
  await turn(candidateA, conversationId, "اعرض طلباتي");
  await turn(candidateA, conversationId, "اسحب الطلب الثاني");
  await turn(candidateA, conversationId, "نعم");
  const [row] = await db.select().from(jobApplications).where(eq(jobApplications.id, target));
  assert.equal(row!.status, "WITHDRAWN");
  assert.ok(row!.withdrawnAt);
  const candidateHistory = await request(`/ai/conversations/${conversationId}`, "GET", undefined, candidateA.cookie);
  assert.equal(candidateHistory.status, 200, candidateHistory.raw);
  const afterReload = await turn(candidateA, conversationId, "اعرض طلباتي");
  assert.equal(afterReload.payload.surface, "MY_APPLICATIONS");
  assert.ok(afterReload.payload.resourceIds.includes(target), "the withdrawn application remains in candidate history after reload");
  const withdrawnCard = afterReload.employment.applications.find((item: any) => item.id === target);
  assert.equal(withdrawnCard?.status, "WITHDRAWN", "the application remains withdrawn after reloading and querying server state");
  // Plain «طلباتي» without an employment context still means commerce orders.
  const commerce = await conversation(candidateA);
  const orders = await turn(candidateA, commerce, "اعرض طلباتي");
  assert.equal(orders.payload.surface, "ORDERS_LIST");
});

await acceptance("C15", "closing a job keeps applications and blocks new ones", async () => {
  const conversationId = await conversation(employerA);
  const mine = await turn(employerA, conversationId, "اعرض وظائفي");
  const index = mine.payload.resourceIds.indexOf(job.accountant);
  assert.equal(index, 1);
  await turn(employerA, conversationId, "أغلق الوظيفة الثانية");
  await turn(employerA, conversationId, "نعم");
  const [closed] = await db.select().from(jobs).where(eq(jobs.id, job.accountant));
  assert.equal(closed!.status, "CLOSED");
  assert.ok(closed!.closedAt);
  assert.equal((await db.select().from(jobApplications).where(eq(jobApplications.jobId, job.accountant))).length, 1);
  const seeker = await conversation(candidateC);
  const search = await turn(candidateC, seeker, "أريد وظيفة محاسب");
  assert.ok(!search.payload.resourceIds.includes(job.accountant));
  const candidateHistory = await request(`/ai/conversations/${seeker}`, "GET", undefined, candidateC.cookie);
  assert.equal(candidateHistory.status, 200, candidateHistory.raw);
  const restoredSearch = candidateHistory.data.messages
    .flatMap((message: any) => message.blocks)
    .filter((block: any) => block.payload.surface === "JOB_SEARCH_RESULTS")
    .at(-1);
  assert.ok(restoredSearch, "candidate search history is restored after reload");
  assert.ok(
    !restoredSearch.payload.employment.jobs.some((item: any) => item.id === job.accountant),
    "closed job stays out of candidate discovery after reload",
  );
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  await updateOwnProfile(candidateB.id, market, { visibility: "PRIVATE" });
  await turn(candidateC, seeker, "أنشئ لي سيرة، أنا محاسب");
  assert.ok(await expectStatus(submitApplication({ actorId: candidateC.id, market, jobId: job.accountant }), 409));
  const history = await turn(employerA, conversationId, "اعرض المتقدمين على الوظيفة الثانية");
  assert.equal(history.payload.surface, "APPLICATION_LIST");
  assert.equal(history.payload.resourceIds.length, 1);
  assert.equal(history.employment.job.status, "CLOSED");
  const employerHistory = await request(`/ai/conversations/${conversationId}`, "GET", undefined, employerA.cookie);
  assert.equal(employerHistory.status, 200, employerHistory.raw);
  const restoredApplications = employerHistory.data.messages
    .flatMap((message: any) => message.blocks)
    .filter((block: any) => block.payload.surface === "APPLICATION_LIST")
    .at(-1)?.payload.employment.applications;
  assert.equal(restoredApplications?.length, 1, "employer can still review the retained application after reload");
  const [candidateBProfile] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateB.id));
  assert.ok(candidateBProfile?.contactPhone, "the fixture candidate has a selected contact number to protect");
  assert.equal(restoredApplications[0]!.candidate.contactPhone, null, "private candidate-selected contact stays hidden after reload");
  const serializedHistory = JSON.stringify(restoredApplications);
  assert.equal(serializedHistory.includes(candidateB.phone), false, "candidate login phone stays hidden after reload");
  assert.equal(
    serializedHistory.includes(candidateBProfile.contactPhone),
    false,
    "candidate-selected private contact stays out of reloaded employer history",
  );
});

await acceptance("C16", "transparent matching signals for a matching candidate; no decision", async () => {
  const conversationId = await conversation(candidateD);
  await turn(candidateD, conversationId, "أنشئ لي سيرة، أنا مطور React عندي خبرة 3 سنوات React");
  await turn(candidateD, conversationId, "أضف TypeScript");
  await turn(candidateD, conversationId, "أفضل العمل عن بعد ودوام كامل");
  const search = await conversation(candidateD);
  await turn(candidateD, search, "أريد وظيفة React عن بعد");
  await turn(candidateD, search, "قدم على الأولى");
  await turn(candidateD, search, "تأكيد التقديم");
  const employer = await conversation(employerA);
  await turn(employerA, employer, "اعرض وظائفي");
  const list = await turn(employerA, employer, "اعرض المتقدمين على الوظيفة الأولى");
  const application = list.employment.applications.find((item: any) => item.submitted.professionalTitle === "مطور React");
  assert.ok(application, JSON.stringify(list.employment));
  assert.deepEqual(
    application.signals.map((signal: any) => [signal.kind, signal.status]),
    [["SKILL", "MET"], ["SKILL", "MET"], ["EXPERIENCE", "MET"], ["WORKPLACE", "MET"], ["EMPLOYMENT_TYPE", "MET"]],
  );
  assert.equal(application.status, "VIEWED", "matching never shortlists or decides");
});

await acceptance("C17", "mismatches are explained neutrally and do not reject", async () => {
  const conversationId = await conversation(candidateC);
  await turn(candidateC, conversationId, "اعرض سيرتي");
  await turn(candidateC, conversationId, "غير المسمى إلى مطور React");
  await turn(candidateC, conversationId, "عندي خبرة سنة React");
  await turn(candidateC, conversationId, "أفضل العمل عن بعد فقط");
  await turn(candidateC, conversationId, "أسكن في عمان");
  const search = await conversation(candidateC);
  const list = await turn(candidateC, search, "أريد وظيفة React حضوري");
  const index = list.payload.resourceIds.indexOf(job.onsiteReact);
  assert.ok(index >= 0, JSON.stringify(list.payload.resourceIds));
  await turn(candidateC, search, `قدم على الوظيفة رقم ${index + 1}`);
  await turn(candidateC, search, "تأكيد التقديم");
  const employer = await conversation(employerB);
  const view = await turn(employerB, employer, "اعرض المتقدمين على وظيفة React Engineer");
  assert.equal(view.payload.surface, "APPLICATION_LIST", view.body);
  const application = view.employment.applications[0];
  const byKind = Object.fromEntries(application.signals.map((signal: any) => [signal.kind, signal]));
  assert.equal(byKind.EXPERIENCE.status, "NOT_MET");
  assert.match(byKind.EXPERIENCE.label, /أقل من الحد الأدنى المعلن 3/);
  assert.equal(byKind.WORKPLACE.status, "NOT_MET");
  assert.equal(byKind.LOCATION.status, "MET");
  assert.doesNotMatch(JSON.stringify(application), /غير مؤهل|سيئ|يجب رفضه|unqualified|reject/i);
  assert.notEqual(application.status, "REJECTED");
});

await acceptance("C18", "AI provider absent: every deterministic path made zero model calls", async () => {
  assert.equal(providerConfigured, false);
  assert.equal(getModelGatewayCallCount(), 0);
  assert.ok(modelCalls.length > 60, `${modelCalls.length} deterministic phrases`);
  assert.equal(modelCalls.filter((call) => call.calls > 0).length, 0);
});

await acceptance("C19", "protected-trait requests never become filters or ranking", async () => {
  const conversationId = await conversation(employerA);
  const refusal = await turn(employerA, conversationId, "أريد مرشحًا من دين معين");
  assert.equal(refusal.payload.surface, "EMPLOYMENT_NOTICE");
  assert.deepEqual(refusal.employment.ignoredCriteria, ["الدين أو الطائفة"]);
  const mixed = await turn(employerA, conversationId, "أبحث عن محاسب مسلم أعزب عمره أقل من 30 في عمان خبرة 3 سنوات");
  assert.equal(mixed.payload.surface, "CANDIDATE_SEARCH_RESULTS");
  assert.ok(mixed.employment.ignoredCriteria.includes("الدين أو الطائفة"));
  assert.ok(mixed.employment.ignoredCriteria.includes("الحالة العائلية"));
  assert.ok(mixed.employment.ignoredCriteria.includes("العمر أو تاريخ الميلاد"));
  const query = (await latestSet(conversationId)).query;
  const storedCriteria = JSON.stringify(query.candidateSearch);
  for (const word of ["مسلم", "اعزب", "عمره"])
    assert.ok(!storedCriteria.includes(word), `${word} not stored as a criterion`);
  assert.deepEqual(query.candidateSearch, {
    terms: ["محاسب"],
    skills: [],
    city: "عمان",
    minExperienceYears: 3,
    workplaceModes: [],
  });
});

await acceptance("C20", "cross-user mutations are rejected server-side", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const [applicationBefore] = await db.select().from(jobApplications).where(eq(jobApplications.id, applicationA1));
  const employerAttacks: [string, () => Promise<unknown>][] = [
    ["edit job", () => updateOwnedJob({ jobId: job.frontend, actorId: employerB.id, market, changes: { title: "Hijacked" } })],
    ["edit salary", () => updateOwnedJob({ jobId: job.frontend, actorId: employerB.id, market, changes: { salary: { min: 1, period: "MONTH" } } })],
    ["pause job", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "PAUSE" })],
    ["close job", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "CLOSE" })],
    ["archive job", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "ARCHIVE" })],
    ["view applicants", () => applicationsForOwnedJob(employerB.id, market, job.frontend)],
    ["change applicant status", () => changeApplicationStatus({ actorId: employerB.id, market, applicationId: applicationA1, status: "REJECTED" })],
  ];
  // Employer B tries to confirm employer A's pending action by id.
  const victim = await conversation(employerA);
  await turn(employerA, victim, "اعرض وظائفي");
  const pendingClose = await turn(employerA, victim, "أغلق الوظيفة الثالثة");
  const foreignConfirm = await request(`/ai/employment-actions/${pendingClose.employment.action.actionId}/action`, "POST", { action: "CONFIRM" }, employerB.cookie);
  crossEmployer.total = employerAttacks.length + 1;
  for (const [name, attack] of employerAttacks) {
    if (await expectStatus(attack, 404)) crossEmployer.passed += 1;
    else assert.fail(`employer attack succeeded: ${name}`);
  }
  if (foreignConfirm.status === 404) crossEmployer.passed += 1;
  await turn(employerA, victim, "إلغاء");
  const [frontend] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  assert.equal(frontend!.status, "PUBLISHED");
  assert.equal(frontend!.title, "Front-end Developer");

  const [aBefore] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateA.id));
  const own = await conversation(candidateA);
  await turn(candidateA, own, "اعرض طلباتي الوظيفية");
  const pendingWithdraw = await turn(candidateA, own, "اسحب الطلب الأول");
  const candidateAttacks: [string, () => Promise<unknown>][] = [
    ["withdraw application", () => withdrawOwnApplication({ actorId: candidateB.id, market, applicationId: applicationA1 })],
  ];
  crossCandidate.total = candidateAttacks.length + 3;
  for (const [name, attack] of candidateAttacks) {
    if (await expectStatus(attack, 404)) crossCandidate.passed += 1;
    else assert.fail(`candidate attack succeeded: ${name}`);
  }
  const foreignWithdraw = await request(`/ai/employment-actions/${pendingWithdraw.employment.action.actionId}/action`, "POST", { action: "CONFIRM" }, candidateB.cookie);
  if (foreignWithdraw.status === 404) crossCandidate.passed += 1;
  // Profile edits and visibility address only the session's own profile; there is no id to aim at.
  await updateOwnProfile(candidateB.id, market, { professionalTitle: "محاسب أول", visibility: "PRIVATE" });
  const [aAfter] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateA.id));
  if (aAfter!.professionalTitle === aBefore!.professionalTitle && aAfter!.updatedAt.getTime() === aBefore!.updatedAt.getTime()) crossCandidate.passed += 1;
  if (aAfter!.visibility === aBefore!.visibility) crossCandidate.passed += 1;
  await turn(candidateA, own, "إلغاء");
  assert.equal(crossEmployer.passed, crossEmployer.total);
  assert.equal(crossCandidate.passed, crossCandidate.total);
  const [application] = await db.select().from(jobApplications).where(eq(jobApplications.id, applicationA1));
  assert.equal(application!.status, applicationBefore!.status, "attacks left the application unchanged");
  assert.equal(application!.statusChangedBy, applicationBefore!.statusChangedBy);
});

await acceptance("C21", "public views leak no private, internal or protected fields", async () => {
  const forbiddenKeys = [
    "userId", "ownerUserId", "candidateUserId", "candidateProfileId", "statusChangedBy", "publishKey",
    "passwordHash", "phoneNumber", "normalizedPhone", "phoneCountryCode", "displayName", "marketId",
    "religion", "gender", "birthDate", "dateOfBirth", "nationality", "photo", "avatarObjectPath",
  ];
  const leaks: string[] = [];
  const actorPhones = [employerA, employerB, candidateA, candidateB, candidateC, candidateD].map((actor) => actor.phone);
  for (const logged of payloadLog) {
    // Since Wave 03 every block carries a card envelope whose `context.marketId` is the viewer's
    // own active market (routes/ai.ts: marketFor(req)), a designed contract field, not an
    // employment record field. It must be exactly the viewer's market; only that one field is
    // then left out of the key scan. Phones and account ids are still scanned in the full block.
    const block = JSON.parse(logged);
    if (block.payload?.card) {
      assert.equal(block.payload.card.context?.marketId, "JO", "the envelope names only the viewer's own market");
      delete block.payload.card.context.marketId;
    }
    const entry = JSON.stringify(block);
    for (const key of forbiddenKeys) if (entry.includes(`"${key}"`)) leaks.push(key);
    for (const phone of actorPhones) if (logged.includes(phone)) leaks.push(`auth phone ${phone}`);
    for (const id of [employerA.id, employerB.id, candidateA.id, candidateB.id, candidateC.id, candidateD.id])
      if (logged.includes(id)) leaks.push("account id");
  }
  assert.ok(payloadLog.length > 50, `${payloadLog.length} employment payloads scanned`);
  assert.deepEqual([...new Set(leaks)], []);
  assert.deepEqual(marketplaceRouted, [], "employment phrases never fall through to marketplace search");
  // A profile phone appears only because the candidate chose it, and is not the login phone.
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  await updateOwnProfile(candidateB.id, market, { visibility: "DISCOVERABLE" });
  const [profileB] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateB.id));
  assert.equal(profileB!.contactMode, "PROFILE_CONTACT");
  assert.notEqual(profileB!.contactPhone, candidateB.phone);
  // The employer sees B's chosen phone on the application list; once B removes it,
  // reloading that same history block no longer shows it.
  const employer = await conversation(employerA);
  await turn(employerA, employer, "اعرض وظائفي");
  const listed = await turn(employerA, employer, `اعرض المتقدمين على الوظيفة رقم ${[job.react, job.accountant, job.frontend].indexOf(job.accountant) + 1}`);
  const card = listed.employment.applications.find((item: any) => item.candidate.id === profileB!.id);
  assert.equal(card.candidate.contactPhone, profileB!.contactPhone);
  const own = await conversation(candidateB);
  await turn(candidateB, own, "اعرض سيرتي");
  const removed = await turn(candidateB, own, "احذف رقم التواصل");
  assert.equal(removed.employment.profile.contactPhone, null);
  const history = await request(`/ai/conversations/${employer}`, "GET", undefined, employerA.cookie);
  const reloaded = history.data.messages
    .flatMap((message: any) => message.blocks)
    .filter((block: any) => block.payload.surface === "APPLICATION_LIST")
    .flatMap((block: any) => block.payload.employment.applications);
  assert.ok(reloaded.length > 0);
  for (const item of reloaded) assert.equal(item.candidate.contactPhone, null, "removed profile phone no longer shown in history");
});

await acceptance("C22", "market isolation: another market sees no jobs or candidates from JO", async () => {
  const conversationId = await conversation(outsider);
  const jobsSeen = await turn(outsider, conversationId, "أريد وظيفة React عن بعد");
  assert.deepEqual(jobsSeen.payload.resourceIds, [], "remote mode does not bypass market isolation");
  const frontend = await turn(outsider, conversationId, "أريد وظيفة Front-end");
  assert.ok(!frontend.payload.resourceIds.includes(job.frontend));
  const candidates = await turn(outsider, conversationId, "أبحث عن مطور React خبرة سنتين");
  assert.equal(candidates.payload.surface, "CANDIDATE_SEARCH_RESULTS");
  assert.deepEqual(candidates.payload.resourceIds, []);
  const kw = await marketFor({ actor: { activeMarketId: "KW" } });
  assert.ok(await expectStatus(submitApplication({ actorId: outsider.id, market: kw, jobId: job.react }), 409) ||
    await expectStatus(submitApplication({ actorId: outsider.id, market: kw, jobId: job.react }), 400));
});

await acceptance("C24", "reload restores employment surfaces from server state", async () => {
  const conversationId = await conversation(employerA);
  await turn(employerA, conversationId, "اعرض وظائفي");
  const pendingPause = await turn(employerA, conversationId, "وقف الوظيفة الأولى");
  const actionId = pendingPause.employment.action.actionId;
  await turn(employerA, conversationId, "نعم");
  const history = await request(`/ai/conversations/${conversationId}`, "GET", undefined, employerA.cookie);
  assert.equal(history.status, 200);
  const blocks = history.data.messages.flatMap((message: any) => message.blocks);
  const action = blocks.find((block: any) => block.payload.employment?.action?.actionId === actionId);
  assert.equal(action.payload.employment.action.status, "CONFIRMED", "settled action shows its stored outcome");
  assert.ok(blocks.some((block: any) => block.payload.surface === "MY_JOBS"));
  // A job search block drops the job paused after it was rendered.
  const seeker = await conversation(candidateD);
  await turn(candidateD, seeker, "أريد وظيفة React عن بعد");
  const seekerHistory = await request(`/ai/conversations/${seeker}`, "GET", undefined, candidateD.cookie);
  const searchBlock = seekerHistory.data.messages.flatMap((message: any) => message.blocks).find((block: any) => block.payload.surface === "JOB_SEARCH_RESULTS");
  assert.ok(!searchBlock.payload.employment.jobs.some((item: any) => item.id === job.react), "paused job hidden after reload");
  await turn(employerA, conversationId, "اعرض وظائفي");
  await turn(employerA, conversationId, "أعد نشر الوظيفة الأولى");
  await turn(employerA, conversationId, "نعم");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, job.react)))[0]!.status, "PUBLISHED");
});

await acceptance("C25", "Wave 3 policy and account restrictions apply to jobs and profiles", async () => {
  const term = `حوالة مسبقة ${runId}`;
  const ruleId = randomUUID();
  await db.insert(marketplacePolicyRules).values({ id: ruleId, marketId: "JO", kind: "TERM", value: term, reasonCode: "FRAUD_SCAM" });
  createdRuleIds.push(ruleId);
  const before = (await jobsOf(employerB)).length;
  const conversationId = await conversation(employerB);
  for (const line of ["أريد موظف مندوب تحصيل في عمان", "مبيعات", "بدون خبرة", "دوام كامل حضوري", "بدون"])
    await turn(employerB, conversationId, line);
  await turn(employerB, conversationId, `الوصف: ادفع ${term} قبل المقابلة`);
  const blocked = await turn(employerB, conversationId, "نشر");
  assert.equal(blocked.payload.surface, "EMPLOYMENT_NOTICE");
  assert.match(blocked.body, /غير مسموح به وفق سياسة السوق/);
  assert.equal((await jobsOf(employerB)).length, before, "policy-blocked job not created");
  const profileConversation = await conversation(candidateC);
  await turn(candidateC, profileConversation, "اعرض سيرتي");
  await turn(candidateC, profileConversation, `نبذة: أطلب ${term} من أصحاب العمل`);
  const visible = await turn(candidateC, profileConversation, "اجعل ملفي ظاهر لأصحاب العمل");
  assert.equal(visible.payload.surface, "EMPLOYMENT_NOTICE");
  assert.equal((await db.select().from(candidateProfiles).where(eq(candidateProfiles.userId, candidateC.id)))[0]!.visibility, "PRIVATE");
  // A restricted employer cannot publish and their jobs leave discovery.
  await db.update(users).set({ status: "RESTRICTED", statusChangedAt: new Date() }).where(eq(users.id, employerB.id));
  try {
    const seeker = await conversation(candidateD);
    const search = await turn(candidateD, seeker, "أريد وظيفة مندوب مبيعات");
    assert.ok(!search.payload.resourceIds.includes(job.sales));
    const market = await marketFor({ actor: { activeMarketId: "JO" } });
    assert.ok(await expectStatus(changeOwnedJobStatus({ jobId: job.sales, actorId: employerB.id, market, action: "PAUSE" }).then(() => changeOwnedJobStatus({ jobId: job.sales, actorId: employerB.id, market, action: "RESUME" })), 403));
  } finally {
    await db.update(users).set({ status: "ACTIVE", statusChangedAt: new Date() }).where(eq(users.id, employerB.id));
  }
});

await acceptance("C26", "job edits after application keep the submitted context", async () => {
  const conversationId = await conversation(employerA);
  const mine = await turn(employerA, conversationId, "اعرض وظائفي");
  const index = mine.payload.resourceIds.indexOf(job.frontend);
  const ordinal = ["الأولى", "الثانية", "الثالثة"][index]!;
  await turn(employerA, conversationId, `غير راتب الوظيفة ${ordinal} إلى 1000`);
  await turn(employerA, conversationId, "نعم");
  await turn(employerA, conversationId, "اعرض وظائفي");
  await turn(employerA, conversationId, `افتح الوظيفة ${ordinal}`);
  await turn(employerA, conversationId, "خلي المسمى Senior Front-end Developer");
  await turn(employerA, conversationId, "نعم");
  const [current] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  assert.equal(current!.title, "Senior Front-end Developer");
  assert.equal(current!.salaryMinMinor, 1_000_000);
  const [application] = await db.select().from(jobApplications).where(eq(jobApplications.id, applicationA1));
  assert.equal(application!.jobId, job.frontend);
  assert.equal(application!.candidateUserId, candidateA.id);
  assert.equal(application!.jobSnapshot.title, "Front-end Developer");
  assert.equal(application!.jobSnapshot.salary, "700 – 900 JOD شهريًا");
  assert.ok(Number(application!.jobSnapshot.version) < current!.version);
  const candidateView = await conversation(candidateA);
  const mineApps = await turn(candidateA, candidateView, "اعرض طلبات التوظيف");
  const entry = mineApps.employment.applications.find((item: any) => item.id === applicationA1);
  assert.equal(entry.submittedJob.title, "Front-end Developer");
  assert.equal(entry.job.title, "Senior Front-end Developer");
});

await acceptance("C27", "profile edits after application keep the submitted snapshot", async () => {
  const conversationId = await conversation(candidateA);
  await turn(candidateA, conversationId, "اعرض سيرتي");
  await turn(candidateA, conversationId, "غير المسمى إلى Lead Front-end Engineer");
  await turn(candidateA, conversationId, "أضف Vue");
  const employer = await conversation(employerA);
  const list = await turn(employerA, employer, "اعرض المتقدمين على وظيفة Senior Front-end Developer");
  assert.equal(list.payload.surface, "APPLICATION_LIST", list.body);
  const application = list.employment.applications.find((item: any) => item.id === applicationA1);
  assert.equal(application.submitted.professionalTitle, "Front-end Engineer");
  assert.equal(application.candidate.professionalTitle, "Front-end Engineer");
  assert.deepEqual(application.candidate.skills, application.submitted.skills);
  assert.ok(!application.candidate.skills.includes("Vue"));
  assert.deepEqual(application.candidate.experiences, []);
  assert.deepEqual(application.candidate.education, []);
  assert.deepEqual(application.candidate.portfolioLinks, []);
  assert.ok(!JSON.stringify(application.signals).includes("Vue"));
});

await acceptance("C23", "connected browser journeys at 320/360/390/414", async () => {
  const web = await startDinarBrowserTestWeb();
  const resultPath = `/tmp/dinar-blockc-ui-${runId}.json`;
  let browserError: unknown;
  try {
    await execFileAsync(process.execPath, [`${process.cwd()}/../dinar/test/block-c-ui-acceptance.mjs`], {
      cwd: `${process.cwd()}/../dinar`,
      env: {
        ...process.env,
        BLOCKC_WEB_BASE: web.baseUrl,
        BLOCKC_API_ORIGIN: `http://127.0.0.1:${port}`,
        BLOCKC_EMPLOYER_COOKIE: employerA.cookie,
        BLOCKC_CANDIDATE_COOKIE: candidateD.cookie,
        BLOCKC_BROWSER_EMPLOYER_COOKIE: browserEmployer.cookie,
        BLOCKC_BROWSER_CANDIDATE_COOKIE: browserCandidate.cookie,
        BLOCKC_BROWSER_CANDIDATE_LOGIN_PHONE: browserCandidate.phone,
        BLOCKC_BROWSER_CANDIDATE_CONTACT: `9${browserCandidate.phone.slice(1, 8)}`,
        BLOCKC_RUN_ID: runId,
        BLOCKC_UI_RESULT_PATH: resultPath,
      },
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    browserError = error;
  } finally {
    await web.stop();
  }
  let browser: any;
  try {
    browser = JSON.parse(await readFile(resultPath, "utf8"));
    await unlink(resultPath);
  } catch {
    browser = undefined;
  }
  console.log("BLOCKC_BROWSER", JSON.stringify(browser));
  if (browserError && !browser) throw browserError;
  assert.ok(browser, "browser acceptance must report");
  assert.equal(browser.failure, undefined, browser.failure);
  assert.deepEqual(browser.pageErrors, []);
  assert.deepEqual(browser.consoleErrors, []);
  assert.equal(browser.horizontalOverflow, 0);
  assert.deepEqual(browser.externalRequests, []);
  assert.equal(getModelGatewayCallCount(), 0, "browser journeys must not reach the model");
  for (const requiredCheck of [
    "candidate profile starts private and is editable",
    "employer discovery excludes private candidate profiles",
    "employer discovery shows candidate-selected contact, never login phone",
    "candidate profile privacy immediately removes discovery access",
    "reloaded employer conversation removes hidden candidate data from old search cards and details",
    "candidate submits and withdraws an application through the browser",
    "APPLICATION_LIST renders employer applicants with job-related signals only",
    "employer edits, pauses, resumes, and closes its own job",
    "closed jobs leave candidate discovery while application history remains private",
  ])
    assert.ok(browser.checks.includes(requiredCheck), `missing browser acceptance check: ${requiredCheck}`);
});

await acceptance("C0.5-01", "moderated jobs leave discovery and can be restored by the shared admin authority", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const target = await publishFixtureJob(employerA, market, `C0.5 moderated job ${runId}`);
  assert.equal((await searchJobs(market, emptyJobSearch(), { allowedIds: [target.id] })).length, 1);

  const forbidden = await request(
    `/admin/jobs/${target.id}/moderation`,
    "POST",
    { action: "HIDE", reason: "C0.5 moderation test" },
    candidateC.cookie,
  );
  assert.equal(forbidden.status, 403);
  const hidden = await request(
    `/admin/jobs/${target.id}/moderation`,
    "POST",
    { action: "HIDE", reason: "C0.5 moderation test" },
    moderator.cookie,
  );
  assert.equal(hidden.status, 200, hidden.raw);
  assert.equal(hidden.data.status, "PAUSED");
  assert.deepEqual(await searchJobs(market, emptyJobSearch(), { allowedIds: [target.id] }), []);
  assert.ok(await expectStatus(submitApplication({ actorId: candidateD.id, market, jobId: target.id }), 409));

  const restored = await request(
    `/admin/jobs/${target.id}/moderation`,
    "POST",
    { action: "RESTORE", reason: "C0.5 restore test" },
    moderator.cookie,
  );
  assert.equal(restored.status, 200, restored.raw);
  assert.equal(restored.data.status, "PUBLISHED");
  assert.equal((await searchJobs(market, emptyJobSearch(), { allowedIds: [target.id] })).length, 1);
});

await acceptance("C2-08", "experience years remain distinct from the selected job ordinal", async () => {
  const conversationId = await conversation(employerB);
  const mine = await turn(employerB, conversationId, "اعرض وظائفي");
  const ids: string[] = mine.payload.resourceIds;
  const index = ids.indexOf(job.sales);
  assert.ok(index >= 0);
  const ordinal = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة"][index];
  assert.ok(ordinal);
  const before = await db.select().from(jobs).where(inArray(jobs.id, ids));
  const targetBefore = before.find((row) => row.id === job.sales)!;
  assert.equal(targetBefore.minExperienceYears, 0);

  const preview = await turn(employerB, conversationId, `خلي خبرة الوظيفة ${ordinal} 3 سنوات`);
  assert.equal(preview.payload.surface, "EMPLOYMENT_ACTION");
  assert.equal(preview.employment.job.id, job.sales, "the ordinal, not the experience value, selects the job");
  assert.equal(preview.employment.action.lines[0], "الخبرة ← 3");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, job.sales)))[0]!.minExperienceYears, 0);
  const confirmed = await turn(employerB, conversationId, "نعم");
  assert.equal(confirmed.payload.surface, "MY_JOBS");

  const after = await db.select().from(jobs).where(inArray(jobs.id, ids));
  assert.equal(after.find((row) => row.id === job.sales)!.minExperienceYears, 3);
  for (const id of ids.filter((id) => id !== job.sales))
    assert.equal(after.find((row) => row.id === id)!.minExperienceYears, before.find((row) => row.id === id)!.minExperienceYears);
});

await acceptance("C2-workplace", "deterministic workplace and employment types stay in the job draft", async () => {
  const beforeCalls = getModelGatewayCallCount();
  const publishedJobIds = (await jobsOf(employerA)).map(({ id }) => id).sort();
  const draftWith = async (terms: string) => {
    const conversationId = await conversation(employerA);
    await turn(employerA, conversationId, "أريد موظف محاسب في عمان");
    await turn(employerA, conversationId, "Excel");
    await turn(employerA, conversationId, "خبرة سنتين");
    return { conversationId, review: await turn(employerA, conversationId, terms) };
  };

  const contract = await draftWith("عقد وريموت");
  const contractReview = await turn(employerA, contract.conversationId, "بدون");
  assert.equal(contractReview.payload.surface, "JOB_REVIEW");
  assert.equal(contractReview.employment.draft.employmentType, "CONTRACT");
  assert.equal(contractReview.employment.draft.workplaceMode, "REMOTE");

  const internship = await draftWith("تدريب حضوري");
  const internshipReview = await turn(employerA, internship.conversationId, "بدون");
  assert.equal(internshipReview.payload.surface, "JOB_REVIEW");
  assert.equal(internshipReview.employment.draft.employmentType, "INTERNSHIP");
  assert.equal(internshipReview.employment.draft.workplaceMode, "ONSITE");
  assert.deepEqual(
    (await jobsOf(employerA)).map(({ id }) => id).sort(),
    publishedJobIds,
    "review drafts are not published",
  );
  assert.equal(getModelGatewayCallCount(), beforeCalls, "deterministic employment phrases use no model calls");
});

await acceptance("C2-10", "closing stops new applications and preserves application history", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  await updateOwnProfile(candidateD.id, market, {
    professionalTitle: "محاسب",
    experienceYears: 3,
    addSkills: ["محاسبة"],
    city: "عمان",
  });
  await updateOwnProfile(candidateC.id, market, {
    professionalTitle: "محاسب",
    experienceYears: 2,
    addSkills: ["محاسبة"],
    city: "عمان",
  });
  const openAccountant = await publishFixtureJob(employerB, market, `محاسب ${runId}`);
  const existing = await submitApplication({ actorId: candidateD.id, market, jobId: openAccountant.id });
  assert.equal(existing.created, true);

  const conversationId = await conversation(employerB);
  const mine = await turn(employerB, conversationId, "اعرض وظائفي");
  const index = (mine.payload.resourceIds as string[]).indexOf(openAccountant.id);
  assert.ok(index >= 0);
  const ordinal = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة"][index];
  assert.ok(ordinal);
  const pending = await turn(employerB, conversationId, `أغلق الوظيفة ${ordinal}`);
  assert.equal(pending.payload.surface, "EMPLOYMENT_ACTION");
  assert.equal(pending.employment.job.id, openAccountant.id);
  const closed = await turn(employerB, conversationId, "نعم");
  assert.equal(closed.payload.surface, "MY_JOBS");

  const [closedJob] = await db.select().from(jobs).where(eq(jobs.id, openAccountant.id));
  assert.equal(closedJob!.status, "CLOSED");
  assert.ok(closedJob!.closedAt);
  const [applicationAfterClose] = await db.select().from(jobApplications).where(eq(jobApplications.id, existing.application.id));
  assert.equal(applicationAfterClose!.status, existing.application.status);
  assert.deepEqual(applicationAfterClose!.jobSnapshot, existing.application.jobSnapshot);
  assert.deepEqual(applicationAfterClose!.candidateSnapshot, existing.application.candidateSnapshot);

  const seeker = await conversation(candidateD);
  const search = await turn(candidateD, seeker, "أريد وظيفة محاسب");
  assert.ok(!search.payload.resourceIds.includes(openAccountant.id));
  assert.ok(await expectStatus(submitApplication({ actorId: candidateC.id, market, jobId: openAccountant.id }), 409));
  const applicants = await turn(employerB, conversationId, `اعرض المتقدمين على الوظيفة ${ordinal}`);
  assert.equal(applicants.payload.surface, "APPLICATION_LIST");
  assert.ok(applicants.payload.resourceIds.includes(existing.application.id));
});

await acceptance("C2-11", "job mutations and pending actions require the authenticated owner", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  await changeOwnedJobStatus({ jobId: job.frontend, actorId: employerA.id, market, action: "PAUSE" });
  const [before] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  const attacks: [string, () => Promise<unknown>][] = [
    ["edit title", () => updateOwnedJob({ jobId: job.frontend, actorId: employerB.id, market, changes: { title: "Hijacked" } })],
    ["edit salary", () => updateOwnedJob({ jobId: job.frontend, actorId: employerB.id, market, changes: { salary: { min: 1, period: "MONTH" } } })],
    ["edit location", () => updateOwnedJob({ jobId: job.frontend, actorId: employerB.id, market, changes: { city: "إربد" } })],
    ["pause", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "PAUSE" })],
    ["reactivate", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "RESUME" })],
    ["close", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "CLOSE" })],
    ["archive", () => changeOwnedJobStatus({ jobId: job.frontend, actorId: employerB.id, market, action: "ARCHIVE" })],
  ];
  let passed = 0;
  for (const [name, attack] of attacks) {
    assert.equal(await expectStatus(attack, 404), true, `${name} is rejected for another employer`);
    passed += 1;
  }
  const [unchanged] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  assert.equal(unchanged!.status, before!.status);
  assert.equal(unchanged!.title, before!.title);
  assert.equal(unchanged!.city, before!.city);
  assert.equal(unchanged!.salaryMinMinor, before!.salaryMinMinor);
  assert.equal(unchanged!.version, before!.version);

  const conversationId = await conversation(employerA);
  const mine = await turn(employerA, conversationId, "اعرض وظائفي");
  assert.ok(mine.payload.resourceIds.length > 0);
  const pending = await turn(employerA, conversationId, "وقف الوظيفة الأولى");
  assert.equal(pending.payload.surface, "EMPLOYMENT_ACTION");
  const forged = await request(
    `/ai/employment-actions/${pending.employment.action.actionId}/action`,
    "POST",
    { action: "CONFIRM", actorId: employerA.id, ownerId: employerA.id, userId: employerA.id },
    employerB.cookie,
  );
  assert.ok([400, 404].includes(forged.status), forged.raw);
  passed += 1;
  await turn(employerA, conversationId, "إلغاء");
  assert.equal(passed, 8);
  await changeOwnedJobStatus({ jobId: job.frontend, actorId: employerA.id, market, action: "RESUME" });
  const [restored] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  assert.equal(restored!.status, "PUBLISHED");
});

await acceptance("C2-13", "a moderation hold blocks conversational edits and reactivation", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const [before] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  const hidden = await request(
    `/admin/jobs/${job.frontend}/moderation`,
    "POST",
    { action: "HIDE", reason: "C2 conversational moderation test" },
    moderator.cookie,
  );
  assert.equal(hidden.status, 200, hidden.raw);
  assert.equal(hidden.data.status, "PAUSED");
  assert.deepEqual(await searchJobs(market, emptyJobSearch(), { allowedIds: [job.frontend] }), []);

  const conversationId = await conversation(employerA);
  const mine = await turn(employerA, conversationId, "اعرض وظائفي");
  const index = (mine.payload.resourceIds as string[]).indexOf(job.frontend);
  assert.ok(index >= 0, "the owner can see the held job in MY_JOBS");
  const ordinal = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة"][index];
  assert.ok(ordinal);

  const edit = await turn(employerA, conversationId, `غير راتب الوظيفة ${ordinal} إلى 800`);
  assert.equal(edit.payload.surface, "EMPLOYMENT_ACTION");
  assert.equal(edit.employment.job.id, job.frontend);
  const blockedEdit = await turn(employerA, conversationId, "نعم");
  assert.equal(blockedEdit.payload.surface, "EMPLOYMENT_NOTICE");
  let [stillHeld] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  assert.equal(stillHeld!.status, "PAUSED");
  assert.equal(stillHeld!.salaryMinMinor, before!.salaryMinMinor);
  assert.equal(stillHeld!.version, before!.version);

  const current = await turn(employerA, conversationId, "اعرض وظائفي");
  const currentIndex = (current.payload.resourceIds as string[]).indexOf(job.frontend);
  assert.ok(currentIndex >= 0);
  const currentOrdinal = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة"][currentIndex];
  assert.ok(currentOrdinal);
  const resume = await turn(employerA, conversationId, `أعد نشر الوظيفة ${currentOrdinal}`);
  assert.equal(resume.payload.surface, "EMPLOYMENT_ACTION");
  assert.equal(resume.employment.job.id, job.frontend);
  const blockedResume = await turn(employerA, conversationId, "نعم");
  assert.equal(blockedResume.payload.surface, "EMPLOYMENT_NOTICE");
  [stillHeld] = await db.select().from(jobs).where(eq(jobs.id, job.frontend));
  assert.equal(stillHeld!.status, "PAUSED");
  assert.equal(stillHeld!.salaryMinMinor, before!.salaryMinMinor);
  assert.deepEqual(await searchJobs(market, emptyJobSearch(), { allowedIds: [job.frontend] }), []);

  const restored = await request(
    `/admin/jobs/${job.frontend}/moderation`,
    "POST",
    { action: "RESTORE", reason: "C2 conversational moderation restore" },
    moderator.cookie,
  );
  assert.equal(restored.status, 200, restored.raw);
  assert.equal(restored.data.status, "PUBLISHED");
});

await acceptance("C0.5-02", "moderated candidate profiles are hidden while their owner retains private access", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const profile = await updateOwnProfile(candidateB.id, market, {
    professionalTitle: "C0.5 QA Engineer",
    addSkills: ["React"],
    city: "عمان",
    contactPhone: null,
    visibility: "DISCOVERABLE",
  });
  const query = { terms: [], skills: [], workplaceModes: [] };
  assert.equal((await searchCandidates(market, moderator.id, query, { allowedIds: [profile.id] })).length, 1);

  const hidden = await request(
    `/admin/candidate-profiles/${profile.id}/moderation`,
    "POST",
    { action: "HIDE", reason: "C0.5 profile moderation test" },
    moderator.cookie,
  );
  assert.equal(hidden.status, 200, hidden.raw);
  assert.equal(hidden.data.visibility, "PRIVATE");
  assert.deepEqual(await searchCandidates(market, moderator.id, query, { allowedIds: [profile.id] }), []);
  assert.equal((await ownProfile(candidateB.id))?.id, profile.id, "the owner still has their profile");
  assert.equal((await ownProfile(candidateB.id))?.visibility, "PRIVATE");
  assert.ok(await expectStatus(
    updateOwnProfile(candidateB.id, market, { visibility: "DISCOVERABLE" }),
    409,
  ));

  const restored = await request(
    `/admin/candidate-profiles/${profile.id}/moderation`,
    "POST",
    { action: "RESTORE", reason: "C0.5 profile restore test" },
    moderator.cookie,
  );
  assert.equal(restored.status, 200, restored.raw);
  assert.equal(restored.data.visibility, "PRIVATE", "moderation restore does not opt a candidate into discovery");
  assert.deepEqual(await searchCandidates(market, moderator.id, query, { allowedIds: [profile.id] }), []);
  await updateOwnProfile(candidateB.id, market, { visibility: "DISCOVERABLE" });
  assert.equal((await searchCandidates(market, moderator.id, query, { allowedIds: [profile.id] })).length, 1);
});

await acceptance("C0.5-03", "reversible candidate restriction removes a profile from discovery", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const profile = await updateOwnProfile(candidateA.id, market, {
    professionalTitle: "C0.5 React Engineer",
    addSkills: ["React"],
    city: "عمان",
    contactPhone: "+965 51234567",
    visibility: "DISCOVERABLE",
  });
  const job = await publishFixtureJob(employerA, market, `C0.5 candidate application ${runId}`);
  c05CandidateJobId = job.id;
  const submitted = await submitApplication({ actorId: candidateA.id, market, jobId: job.id });
  c05CandidateApplicationId = submitted.application.id;
  assert.equal(submitted.created, true);
  const query = { terms: [], skills: [], workplaceModes: [] };
  assert.equal((await searchCandidates(market, moderator.id, query, { allowedIds: [profile.id] })).length, 1);

  await db.transaction((tx) =>
    setUserModerationStatus(tx, {
      actor: { id: moderator.id, role: "ADMIN" },
      userId: candidateA.id,
      status: "RESTRICTED",
      reason: "C0.5 reversible candidate restriction",
    }),
  );
  try {
    assert.deepEqual(await searchCandidates(market, moderator.id, query, { allowedIds: [profile.id] }), []);
    const employerView = await applicationsForOwnedJob(employerA.id, market, job.id);
    const row = employerView.applications.find((item) => item.application.id === submitted.application.id)!;
    assert.equal(employerApplicationView(row, employerView.job).candidate.contactPhone, null);
  } finally {
    await db.transaction((tx) =>
      setUserModerationStatus(tx, {
        actor: { id: moderator.id, role: "ADMIN" },
        userId: candidateA.id,
        status: "ACTIVE",
        reason: "C0.5 restore candidate restriction",
      }),
    );
  }
});

await acceptance("C0.5-04", "restricted candidates cannot submit or mutate their employment profile", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  await db.transaction((tx) =>
    setUserModerationStatus(tx, {
      actor: { id: moderator.id, role: "ADMIN" },
      userId: candidateA.id,
      status: "RESTRICTED",
      reason: "C0.5 candidate write restriction",
    }),
  );
  try {
    assert.ok(await expectStatus(
      submitApplication({ actorId: candidateA.id, market, jobId: c05CandidateJobId }),
      403,
    ));
    assert.ok(await expectStatus(
      updateOwnProfile(candidateA.id, market, { summary: "Must not be saved while restricted" }),
      403,
    ));
  } finally {
    await db.transaction((tx) =>
      setUserModerationStatus(tx, {
        actor: { id: moderator.id, role: "ADMIN" },
        userId: candidateA.id,
        status: "ACTIVE",
        reason: "C0.5 restore candidate write restriction",
      }),
    );
  }
});

await acceptance("C0.5-05", "restricted employers' jobs are hidden and cannot accept applications", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const job = await publishFixtureJob(employerB, market, `C0.5 employer restriction ${runId}`);
  c05EmployerJobId = job.id;
  await updateOwnProfile(candidateD.id, market, {
    professionalTitle: "C0.5 applicant",
    visibility: "DISCOVERABLE",
  });
  await updateOwnProfile(candidateC.id, market, {
    professionalTitle: "C0.5 blocked applicant",
    summary: "C0.5 test applicant",
    visibility: "DISCOVERABLE",
  });
  const submitted = await submitApplication({ actorId: candidateD.id, market, jobId: job.id });
  assert.equal(submitted.created, true);
  await db.transaction((tx) =>
    setUserModerationStatus(tx, {
      actor: { id: moderator.id, role: "ADMIN" },
      userId: employerB.id,
      status: "RESTRICTED",
      reason: "C0.5 reversible employer restriction",
    }),
  );
  try {
    assert.deepEqual(await searchJobs(market, emptyJobSearch(), { allowedIds: [job.id] }), []);
    assert.ok(await expectStatus(submitApplication({ actorId: candidateC.id, market, jobId: job.id }), 409));
    const history = await applicationsForOwnedJob(employerB.id, market, job.id);
    assert.equal(history.applications.length, 1, "restricted employer retains read access to application history");
    assert.equal(history.applications[0]!.application.status, "SUBMITTED", "read access does not mutate history");
    assert.ok(await expectStatus(
      changeOwnedJobStatus({ jobId: job.id, actorId: employerB.id, market, action: "PAUSE" }),
      403,
    ));
  } finally {
    await db.transaction((tx) =>
      setUserModerationStatus(tx, {
        actor: { id: moderator.id, role: "ADMIN" },
        userId: employerB.id,
        status: "ACTIVE",
        reason: "C0.5 restore employer restriction",
      }),
    );
  }
});

await acceptance("C0.5-06", "applications and snapshots survive reversible account restriction", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const before = await ownApplications(candidateA.id, market);
  assert.ok(before.some((item) => item.application.id === c05CandidateApplicationId));
  const snapshotBefore = before.find((item) => item.application.id === c05CandidateApplicationId)!.application.candidateSnapshot;

  await db.transaction((tx) =>
    setUserModerationStatus(tx, {
      actor: { id: moderator.id, role: "ADMIN" },
      userId: candidateA.id,
      status: "RESTRICTED",
      reason: "C0.5 history preservation check",
    }),
  );
  try {
    const after = await ownApplications(candidateA.id, market);
    const preserved = after.find((item) => item.application.id === c05CandidateApplicationId);
    assert.ok(preserved);
    assert.deepEqual(preserved!.application.candidateSnapshot, snapshotBefore);
    const employerView = await applicationsForOwnedJob(employerA.id, market, c05CandidateJobId);
    const history = employerView.applications.find((item) => item.application.id === c05CandidateApplicationId);
    assert.ok(history, "employer application history remains accessible");
    assert.equal(employerApplicationView(history!, employerView.job).candidate.contactPhone, null);
  } finally {
    await db.transaction((tx) =>
      setUserModerationStatus(tx, {
        actor: { id: moderator.id, role: "ADMIN" },
        userId: candidateA.id,
        status: "ACTIVE",
        reason: "C0.5 restore after history check",
      }),
    );
  }
});

await acceptance("C0.5-07", "profile market mismatch blocks application without exposing cross-market matching data", async () => {
  const kuwait = await marketFor({ actor: { activeMarketId: "KW" } });
  const switchedEmployer = await request("/account/market", "PATCH", { marketId: "KW" }, employerB.cookie);
  assert.equal(switchedEmployer.status, 200, switchedEmployer.raw);
  let target: typeof jobs.$inferSelect;
  try {
    target = await publishFixtureJob(employerB, kuwait, `C0.5 Kuwait React ${runId}`);
  } finally {
    const restoredEmployer = await request("/account/market", "PATCH", { marketId: "JO" }, employerB.cookie);
    assert.equal(restoredEmployer.status, 200, restoredEmployer.raw);
  }
  c05KuwaitJobId = target!.id;

  const switchedCandidate = await request("/account/market", "PATCH", { marketId: "KW" }, candidateA.cookie);
  assert.equal(switchedCandidate.status, 200, switchedCandidate.raw);
  try {
    const profile = await ownProfile(candidateA.id);
    assert.equal(profile?.marketId, "JO");
    assert.equal(await ownProfile(candidateA.id, kuwait), undefined);
    const readiness = await applicationReadiness(candidateA.id, kuwait, c05KuwaitJobId);
    assert.equal(readiness.ok, false);
    if (!readiness.ok) assert.equal(readiness.reason, "PROFILE_MARKET_MISMATCH");
    assert.ok(await expectStatus(ensureOwnProfile(candidateA.id, kuwait), 409));
    assert.ok(await expectStatus(
      submitApplication({ actorId: candidateA.id, market: kuwait, jobId: c05KuwaitJobId }),
      409,
    ));
    const conversationId = await conversation(candidateA);
    const results = await turn(candidateA, conversationId, "أريد وظيفة React عن بعد");
    assert.ok(results.payload.resourceIds.includes(c05KuwaitJobId));
    assert.equal(
      results.employment.jobs.find((item: any) => item.id === c05KuwaitJobId)?.signals,
      undefined,
      "matching signals do not use a profile from another market",
    );
  } finally {
    const restoredCandidate = await request("/account/market", "PATCH", { marketId: "JO" }, candidateA.cookie);
    assert.equal(restoredCandidate.status, 200, restoredCandidate.raw);
  }
});

await acceptance("C0.5-08", "application rejects a job whose market differs from the candidate profile", async () => {
  const jordan = await marketFor({ actor: { activeMarketId: "JO" } });
  const profile = await ownProfile(candidateA.id);
  assert.equal(profile?.marketId, "JO");
  const before = await db
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.jobId, c05KuwaitJobId), eq(jobApplications.candidateUserId, candidateA.id)));
  assert.equal(before.length, 0);
  assert.ok(await expectStatus(
    submitApplication({ actorId: candidateA.id, market: jordan, jobId: c05KuwaitJobId }),
    409,
  ));
  const after = await db
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.jobId, c05KuwaitJobId), eq(jobApplications.candidateUserId, candidateA.id)));
  assert.equal(after.length, 0);
});

await acceptance("C0.5-09", "candidate discovery never returns a profile from another active market", async () => {
  const kuwait = await marketFor({ actor: { activeMarketId: "KW" } });
  const profile = await ownProfile(candidateB.id);
  assert.equal(profile?.marketId, "JO");
  const found = await searchCandidates(
    kuwait,
    moderator.id,
    { terms: [], skills: [], workplaceModes: [] },
    { allowedIds: [profile!.id] },
  );
  assert.deepEqual(found, []);
});

await acceptance("C0.5-10", "removing candidate contact refreshes stale application cards", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  c05ContactPhone = "+96552345678";
  const profile = await updateOwnProfile(candidateB.id, market, {
    professionalTitle: "C0.5 Privacy Engineer",
    addSkills: ["React"],
    contactPhone: c05ContactPhone,
    visibility: "DISCOVERABLE",
  });
  const job = await publishFixtureJob(employerA, market, `C0.5 contact privacy ${runId}`);
  const submitted = await submitApplication({ actorId: candidateB.id, market, jobId: job.id });
  const owned = await applicationsForOwnedJob(employerA.id, market, job.id);
  const row = owned.applications.find((item) => item.application.id === submitted.application.id)!;
  c05ContactView = employerApplicationView(row, owned.job);
  assert.equal(c05ContactView.candidate.contactPhone, c05ContactPhone);
  assert.notEqual(c05ContactPhone, candidateB.phone);

  const cached = {
    resourceIds: [job.id],
    employment: { view: "APPLICATION_LIST", applications: [structuredClone(c05ContactView)] },
  };
  await updateOwnProfile(candidateB.id, market, { contactPhone: null });
  const refreshed = await refreshEmploymentPayload(cached, {
    actorId: employerA.id,
    market,
    query: undefined,
  });
  assert.equal(
    (refreshed.employment as any).applications[0].candidate.contactPhone,
    null,
    "refresh removes the prior public phone from cached history",
  );
  assert.ok(profile.id);
});

await acceptance("C0.5-11", "employment views contain no login phone or private account fields", async () => {
  assert.ok(c05ContactView, "C0.5-10 built a real employer application view");
  const serialized = JSON.stringify(c05ContactView);
  const forbiddenKeys = [
    "userId",
    "candidateUserId",
    "candidateProfileId",
    "phoneNumber",
    "normalizedPhone",
    "phoneCountryCode",
    "passwordHash",
  ];
  assert.equal(serialized.includes(candidateB.phone), false, "login phone never appears in an employment view");
  assert.deepEqual(forbiddenKeys.filter((key) => serialized.includes(`"${key}"`)), []);
});

await acceptance("C0.5-12", "deactivated candidate history uses its submitted CV and keeps contact private", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const applicant = await register("C0.5 Deactivated Candidate");
  const contactPhone = "+96552345678";
  const submittedTitle = "C0.5 Snapshot Engineer A";
  const profile = await updateOwnProfile(applicant.id, market, {
    professionalTitle: submittedTitle,
    addSkills: ["React"],
    experienceYears: 2,
    city: "عمان",
    workplacePreferences: ["REMOTE"],
    employmentTypePreferences: ["FULL_TIME"],
    addExperience: { role: "Engineer A", organization: "Organization A", startYear: 2020 },
    addEducation: { field: "Computer science", institution: "Institution A" },
    addPortfolioLink: "https://portfolio-a.example.com",
    contactPhone,
    visibility: "DISCOVERABLE",
  });
  const job = await publishFixtureJob(employerA, market, `C0.5 deactivated candidate ${runId}`);
  const application = await submitApplication({ actorId: applicant.id, market, jobId: job.id });
  assert.equal(application.created, true);
  const submittedSnapshot = structuredClone(application.application.candidateSnapshot);

  const before = await applicationsForOwnedJob(employerA.id, market, job.id);
  const applicationRow = before.applications.find((row) => row.application.id === application.application.id)!;
  const cachedCard = employerApplicationView(applicationRow, before.job);
  assert.equal(cachedCard.candidate.professionalTitle, submittedTitle);
  assert.equal(cachedCard.candidate.contactPhone, contactPhone);

  await updateOwnProfile(applicant.id, market, {
    professionalTitle: "C0.5 Snapshot Engineer B",
    removeSkills: ["React"],
    addSkills: ["Vue"],
    experienceYears: 12,
    city: "إربد",
    addExperience: { role: "Engineer B", organization: "Organization B", startYear: 2024 },
    addEducation: { field: "Current study", institution: "Institution B" },
    addPortfolioLink: "https://portfolio-b.example.com",
  });
  const edited = await applicationsForOwnedJob(employerA.id, market, job.id);
  const editedRow = edited.applications.find((row) => row.application.id === application.application.id)!;
  const editedView = employerApplicationView(editedRow, edited.job);
  assert.equal(editedView.candidate.professionalTitle, submittedTitle);
  assert.deepEqual(editedView.candidate.skills, ["React"]);
  assert.equal(editedView.candidate.experienceYears, 2);
  assert.equal(editedView.candidate.city, "عمان");
  assert.deepEqual(editedView.candidate.experiences, []);
  assert.deepEqual(editedView.candidate.education, []);
  assert.deepEqual(editedView.candidate.portfolioLinks, []);
  assert.equal(editedView.candidate.contactPhone, contactPhone, "contact follows current privacy while still public");

  const legacyCachedCard = structuredClone(editedView) as any;
  legacyCachedCard.candidate.professionalTitle = "C0.5 Snapshot Engineer B";
  legacyCachedCard.candidate.skills = ["Vue"];
  legacyCachedCard.candidate.experienceYears = 12;
  legacyCachedCard.candidate.city = "إربد";
  legacyCachedCard.candidate.experiences = [
    { role: "Engineer B", organization: "Organization B", startYear: 2024 },
  ];
  legacyCachedCard.candidate.education = [
    { field: "Current study", institution: "Institution B" },
  ];
  legacyCachedCard.candidate.portfolioLinks = ["https://portfolio-b.example.com"];
  legacyCachedCard.signals = [{ skill: "Vue" }];
  const legacyPayload = () => ({
    resourceIds: [job.id],
    employment: {
      view: "APPLICATION_LIST",
      applications: [structuredClone(legacyCachedCard)],
    },
  });
  const repairedHistory = await refreshEmploymentPayload(legacyPayload(), {
    actorId: employerA.id,
    market,
  });
  const repairedApplication = (repairedHistory.employment as any).applications[0];
  assert.equal(repairedApplication.candidate.professionalTitle, submittedTitle);
  assert.deepEqual(repairedApplication.candidate.skills, ["React"]);
  assert.equal(repairedApplication.candidate.experienceYears, 2);
  assert.equal(repairedApplication.candidate.city, "عمان");
  assert.deepEqual(repairedApplication.candidate.experiences, []);
  assert.deepEqual(repairedApplication.candidate.education, []);
  assert.deepEqual(repairedApplication.candidate.portfolioLinks, []);
  assert.ok(!JSON.stringify(repairedApplication.signals).includes("Vue"));
  assert.equal(repairedApplication.candidate.contactPhone, contactPhone);

  await db.transaction((tx) => deactivateOwnAccount(tx, applicant.id));

  const retainedProfile = await ownProfile(applicant.id);
  assert.equal(retainedProfile?.id, profile.id, "deactivation retains the profile row");
  const [retainedApplication] = await db
    .select()
    .from(jobApplications)
    .where(eq(jobApplications.id, application.application.id));
  assert.ok(retainedApplication, "deactivation retains the application row");
  assert.deepEqual(retainedApplication.candidateSnapshot, submittedSnapshot);

  assert.deepEqual(
    await searchCandidates(
      market,
      employerA.id,
      { terms: [], skills: [], workplaceModes: [] },
      { allowedIds: [profile.id] },
    ),
    [],
    "a deactivated candidate is no longer discoverable",
  );
  assert.equal(
    await expectStatus(submitApplication({ actorId: applicant.id, market, jobId: job.id }), 403),
    true,
    "a deactivated candidate cannot submit another application",
  );
  assert.equal(
    await expectStatus(updateOwnProfile(applicant.id, market, { professionalTitle: "Blocked edit" }), 403),
    true,
    "a deactivated candidate cannot mutate their profile",
  );

  const after = await applicationsForOwnedJob(employerA.id, market, job.id);
  const afterRow = after.applications.find((row) => row.application.id === application.application.id)!;
  const afterView = employerApplicationView(afterRow, after.job);
  assert.equal(afterView.candidate.professionalTitle, submittedTitle);
  assert.deepEqual(afterView.candidate.skills, ["React"]);
  assert.equal(afterView.candidate.experienceYears, 2);
  assert.equal(afterView.candidate.city, "عمان");
  assert.equal(afterView.candidate.contactPhone, null, "deactivation removes live contact exposure");
  assert.equal(JSON.stringify(afterView).includes(applicant.phone), false, "authentication phone is never exposed");

  const refreshed = await refreshEmploymentPayload(legacyPayload(), { actorId: employerA.id, market });
  const refreshedApplication = (refreshed.employment as any).applications[0];
  assert.equal(refreshedApplication.candidate.professionalTitle, submittedTitle);
  assert.deepEqual(refreshedApplication.candidate.skills, ["React"]);
  assert.equal(refreshedApplication.candidate.contactPhone, null, "history refresh does not resurrect contact");
});

await acceptance("C0.5-13", "deactivated employer jobs and application history remain correctly gated", async () => {
  const market = await marketFor({ actor: { activeMarketId: "JO" } });
  const owner = await register("C0.5 Deactivated Employer");
  const job = await publishFixtureJob(owner, market, `C0.5 deactivated employer ${runId}`);
  const existing = await submitApplication({ actorId: candidateA.id, market, jobId: job.id });
  assert.equal(existing.created, true);
  const snapshotBefore = structuredClone(existing.application.candidateSnapshot);

  await db.transaction((tx) => deactivateOwnAccount(tx, owner.id));

  assert.deepEqual(
    await searchJobs(market, emptyJobSearch(), { allowedIds: [job.id] }),
    [],
    "a deactivated employer's job is not discoverable",
  );
  const history = await applicationsForOwnedJob(owner.id, market, job.id);
  const retained = history.applications.find((row) => row.application.id === existing.application.id);
  assert.ok(retained, "the employer's historical application remains stored and readable");
  assert.deepEqual(retained.application.candidateSnapshot, snapshotBefore);
  assert.equal(
    await expectStatus(submitApplication({ actorId: candidateB.id, market, jobId: job.id }), 409),
    true,
    "a deactivated employer's job accepts no new applications",
  );
});

await test("summary: no external discovery calls", async () => {
  console.log(
    "BLOCKC_SUMMARY",
    JSON.stringify({
      results,
      passed: Object.values(results).filter((value) => value === "PASS").length,
      total: Object.keys(results).length,
      modelCalls: getModelGatewayCallCount(),
      deterministicPhrases: modelCalls.length,
      externalHosts: [...new Set(external)],
      crossEmployer,
      crossCandidate,
    }),
  );
  assert.deepEqual([...new Set(external)], [], "job and candidate discovery never leave DINAR");
});

after(async () => {
  if (createdRuleIds.length)
    await db.update(marketplacePolicyRules).set({ isActive: false }).where(inArray(marketplacePolicyRules.id, createdRuleIds));
  server.close();
  await pool.end();
});
