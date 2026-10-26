import { test } from "node:test";
import assert from "node:assert/strict";
import {
  automaticDecisionRequested,
  employmentOrdinal,
  parseCity,
  parseEmploymentTypes,
  parseExperienceYears,
  parseKnownSkills,
  parseRole,
  parseSalary,
  parseSkillList,
  parseWorkplaceModes,
  protectedTraitsRequested,
  sameSkill,
} from "../src/ai/employment-parser";
import {
  answerDraftField,
  correctDraft,
  jobEditChanges,
  parseCandidateSearch,
  parseDraftFacts,
  parseJobSearch,
  parseProfileFacts,
  statedJobTitle,
  withoutProtectedWords,
} from "../src/ai/employment-turn";
import {
  matchSignals,
  nextJobDraftField,
  relevanceOrder,
  type CandidateMatchInput,
} from "../src/lib/employment";

test("workplace modes and employment types normalize deterministically, clitics included", () => {
  assert.deepEqual(parseWorkplaceModes("دوام كامل وهجين"), ["HYBRID"]);
  assert.deepEqual(parseEmploymentTypes("دوام كامل وهجين"), ["FULL_TIME"]);
  assert.deepEqual(parseWorkplaceModes("أريد وظيفة React عن بعد"), ["REMOTE"]);
  assert.deepEqual(parseWorkplaceModes("ريموت"), ["REMOTE"]);
  assert.deepEqual(parseWorkplaceModes("هايبرد"), ["HYBRID"]);
  assert.deepEqual(parseWorkplaceModes("حضوري"), ["ONSITE"]);
  assert.deepEqual(parseEmploymentTypes("وظيفة دوام جزئي"), ["PART_TIME"]);
  assert.deepEqual(parseEmploymentTypes("أبحث عن تدريب"), ["INTERNSHIP"]);
  assert.deepEqual(parseEmploymentTypes("عقد"), ["CONTRACT"]);
});

test("experience years: dual, digits, Arabic-Indic digits and no-experience", () => {
  assert.equal(parseExperienceYears("خبرة سنتين"), 2);
  assert.equal(parseExperienceYears("3 سنوات React"), 3);
  assert.equal(parseExperienceYears("خبرة ٣ سنوات"), 3);
  assert.equal(parseExperienceYears("عندي خبرة ثلاث سنوات"), 3);
  assert.equal(parseExperienceYears("لا يشترط خبرة"), 0);
  assert.equal(parseExperienceYears("بدون خبرة"), 0);
  assert.equal(parseExperienceYears("مطور React"), undefined);
});

test("salary: single, range, period; never a product price", () => {
  assert.deepEqual(parseSalary("راتب 700"), { min: 700, period: "MONTH" });
  assert.deepEqual(parseSalary("من 600 إلى 800"), { min: 600, max: 800, period: "MONTH" });
  assert.deepEqual(parseSalary("10 دينار بالساعة"), { min: 10, period: "HOUR" });
  assert.equal(parseSalary("خبرة 3 سنوات"), undefined);
});

test("ordinal and salary/experience numbers in one command stay distinct", () => {
  assert.equal(employmentOrdinal("غير راتب الوظيفة الثانية إلى 800", "JOB"), 1);
  assert.equal(employmentOrdinal("وقف الوظيفة الثالثة", "JOB"), 2);
  assert.equal(employmentOrdinal("ضع المتقدم الثاني في القائمة المختصرة", "APPLICANT"), 1);
  assert.equal(employmentOrdinal("اسحب الطلب الثاني", "APPLICATION"), 1);
  assert.equal(employmentOrdinal("أريد محاسب خبرة 3 سنوات", "ANY"), undefined);
  assert.equal(employmentOrdinal("اعرض المتقدمين على وظيفة Front-end", "JOB"), undefined);
  assert.equal(parseExperienceYears("أريد محاسب خبرة 3 سنوات"), 3);
});

test("roles, skills and cities come only from the user's words", () => {
  assert.equal(parseRole("أريد وظيفة Front-end"), "مطور Front-end");
  assert.equal(parseRole("أبحث عن محاسب في عمان خبرة 3 سنوات"), "محاسب");
  assert.equal(parseRole("أحتاج كهربائي في عمان"), undefined);
  assert.deepEqual(parseKnownSkills("React و TypeScript"), ["React", "TypeScript"]);
  assert.deepEqual(parseSkillList("React, Node.js و GraphQL"), ["React", "Node.js", "GraphQL"]);
  assert.deepEqual(parseKnownSkills("أحتاج شخص يساعدني بالمبيعات والمخزن"), ["مبيعات", "إدارة مخزون"]);
  assert.equal(parseCity("شقة في عمان 3 غرف"), "عمان");
  assert.equal(parseCity("أسكن بإربد"), "إربد");
  assert.ok(sameSkill("react.js", "React"));
});

test("protected traits are recognized so they can be refused, never filtered", () => {
  assert.deepEqual(protectedTraitsRequested("أريد مرشحًا من دين معين"), ["الدين أو الطائفة"]);
  assert.ok(protectedTraitsRequested("محاسبة أنثى عمرها أقل من 30").includes("الجنس"));
  assert.ok(protectedTraitsRequested("مطور متزوج").includes("الحالة العائلية"));
  assert.ok(protectedTraitsRequested("مبرمج أردني").includes("الجنسية أو الأصل"));
  assert.deepEqual(protectedTraitsRequested("أبحث عن محاسب في عمان خبرة 3 سنوات"), []);
});

test("automatic hiring or rejection requests are detected for refusal", () => {
  assert.ok(automaticDecisionRequested("اختر الأفضل وارفض الباقين تلقائيًا"));
  assert.ok(automaticDecisionRequested("ارفض الباقين"));
  assert.ok(!automaticDecisionRequested("ضع المتقدم الثاني في القائمة المختصرة"));
});

const job = {
  skills: ["React", "TypeScript"],
  minExperienceYears: 2,
  workplaceMode: "REMOTE",
  employmentType: "FULL_TIME",
  city: "",
};

test("C16: matching explains met declared criteria and makes no decision", () => {
  const candidate: CandidateMatchInput = {
    skills: ["React", "TypeScript", "CSS"],
    experienceYears: 3,
    workplacePreferences: ["REMOTE"],
    employmentTypePreferences: ["FULL_TIME"],
    city: "عمان",
  };
  const signals = matchSignals(job, candidate);
  assert.deepEqual(signals.map((signal) => [signal.kind, signal.status]), [
    ["SKILL", "MET"],
    ["SKILL", "MET"],
    ["EXPERIENCE", "MET"],
    ["WORKPLACE", "MET"],
    ["EMPLOYMENT_TYPE", "MET"],
  ]);
  assert.match(signals[2]!.label, /3 سنوات خبرة تحقق الحد الأدنى 2/);
  assert.equal(relevanceOrder(signals), 5);
  for (const signal of signals) assert.doesNotMatch(signal.label, /وظّف|ارفض|غير مؤهل|سيئ|يجب رفضه|hire|reject/i);
});

test("C17: mismatches are transparent and neutral", () => {
  const onsite = { ...job, skills: ["React"], minExperienceYears: 3, workplaceMode: "ONSITE", city: "عمان" };
  const candidate: CandidateMatchInput = {
    skills: ["React"],
    experienceYears: 1,
    workplacePreferences: ["REMOTE"],
    employmentTypePreferences: [],
    city: "عمان",
  };
  const signals = matchSignals(onsite, candidate);
  const byKind = Object.fromEntries(signals.map((signal) => [signal.kind, signal]));
  assert.equal(byKind.EXPERIENCE!.status, "NOT_MET");
  assert.match(byKind.EXPERIENCE!.label, /أقل من الحد الأدنى المعلن 3/);
  assert.equal(byKind.WORKPLACE!.status, "NOT_MET");
  assert.equal(byKind.LOCATION!.status, "MET");
  for (const signal of signals) assert.doesNotMatch(signal.label, /غير مؤهل|سيئ|يجب رفضه|ارفض/);
});

test("matching inputs carry no personal characteristics", () => {
  // The candidate input type is closed: extra personal fields are not read.
  const withExtras = {
    skills: ["React"],
    experienceYears: 3,
    workplacePreferences: [],
    employmentTypePreferences: [],
    city: "",
    religion: "x",
    gender: "y",
    birthYear: 1990,
    photo: "z",
  } as CandidateMatchInput;
  const plain: CandidateMatchInput = { skills: ["React"], experienceYears: 3, workplacePreferences: [], employmentTypePreferences: [], city: "" };
  assert.deepEqual(matchSignals(job, withExtras), matchSignals(job, plain));
});

test("job drafts ask only for the next missing field", () => {
  const base = { draftId: "00000000-0000-4000-8000-000000000001", skills: [] as string[] };
  assert.equal(nextJobDraftField({ ...base }), "title");
  assert.equal(nextJobDraftField({ ...base, title: "Front-end Developer", city: "عمان" }), "skills");
  assert.equal(nextJobDraftField({ ...base, title: "x y", skills: ["React"] }), "experience");
  assert.equal(nextJobDraftField({ ...base, title: "x y", skills: ["React"], minExperienceYears: 2 }), "employment");
  assert.equal(nextJobDraftField({ ...base, title: "x y", skills: ["React"], minExperienceYears: 2, employmentType: "FULL_TIME", workplaceMode: "REMOTE" }), "salary");
  assert.equal(nextJobDraftField({ ...base, title: "x y", skills: ["React"], minExperienceYears: 2, employmentType: "FULL_TIME", workplaceMode: "HYBRID" }), "city");
  assert.equal(nextJobDraftField({ ...base, title: "x y", skills: ["React"], minExperienceYears: 2, employmentType: "FULL_TIME", workplaceMode: "REMOTE", salary: null }), undefined);
});

test("2000-character adversarial employment turns stay fast", () => {
  const n = 2000;
  const inputs = [
    "أنا " + "مطور ".repeat(n / 5),
    "اشتغلت " + "مطور في ".repeat(n / 8),
    "درست " + "هندسة في ".repeat(n / 9),
    "أريد موظف " + "Front-end ".repeat(n / 10),
    "غير المسمى إلى " + "a".repeat(n),
    "من " + "1 إلى ".repeat(n / 6),
    "خبرة " + "3 سنوات ".repeat(n / 8),
    " ".repeat(n),
    "و".repeat(n),
    "أضف " + "React، ".repeat(n / 7),
  ].map((text) => text.slice(0, n));
  const draft = { draftId: "00000000-0000-4000-8000-000000000002", skills: [] as string[] };
  let worst = 0;
  for (const text of inputs) {
    const started = performance.now();
    statedJobTitle(text);
    parseJobSearch(text);
    parseCandidateSearch(withoutProtectedWords(text));
    parseDraftFacts(text);
    parseProfileFacts(text);
    jobEditChanges(text);
    correctDraft(draft, text);
    answerDraftField(draft, text);
    protectedTraitsRequested(text);
    parseSalary(text);
    worst = Math.max(worst, performance.now() - started);
  }
  console.log("EMPLOYMENT_REDOS_WORST_MS", worst.toFixed(1));
  assert.ok(worst < 100, `worst adversarial parse took ${worst.toFixed(1)}ms`);
});
