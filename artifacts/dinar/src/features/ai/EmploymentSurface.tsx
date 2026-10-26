import { useEffect, useState, type ReactNode } from "react";
import { useApplyAiEmploymentAction } from "@workspace/api-client-react";
import { Briefcase, Check, MapPin, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/Button";
import type {
  EmploymentAction,
  EmploymentApplication,
  EmploymentCandidate,
  EmploymentJob,
  EmploymentPayload,
  MatchSignal,
} from "./employment-types";
import { FactList, SurfaceActions, SurfacePanel, factRows } from "./surface/primitives";

const WORKPLACE: Record<string, string> = { ONSITE: "حضوري", REMOTE: "عن بعد", HYBRID: "هجين" };
const EMPLOYMENT: Record<string, string> = {
  FULL_TIME: "دوام كامل",
  PART_TIME: "دوام جزئي",
  CONTRACT: "عقد",
  INTERNSHIP: "تدريب",
};
const JOB_STATUS: Record<string, string> = {
  PUBLISHED: "منشورة",
  PAUSED: "موقوفة",
  CLOSED: "مغلقة",
  ARCHIVED: "مؤرشفة",
};
const APPLICATION_STATUS: Record<string, string> = {
  SUBMITTED: "مُرسل",
  VIEWED: "تمت مشاهدته",
  SHORTLISTED: "في القائمة المختصرة",
  REJECTED: "لن يُتابع",
  WITHDRAWN: "مسحوب",
};
const ACTION_STATUS: Record<EmploymentAction["status"], string> = {
  PENDING: "",
  CONFIRMED: "تم التنفيذ بعد تأكيدك.",
  CANCELLED: "أُلغي الإجراء دون أي تغيير.",
  EXPIRED: "انتهت صلاحية الإجراء دون أي تغيير.",
};

const ordinalText = (index: number) => `رقم ${index + 1}`;

function Chips({ items, testId }: { items: string[]; testId?: string }) {
  if (!items.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" data-testid={testId}>
      {items.map((item) => (
        <li
          key={item}
          className="max-w-full break-words rounded-full bg-muted px-2.5 py-0.5 text-xs text-foreground"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function Signals({ signals }: { signals?: MatchSignal[] }) {
  if (!signals?.length) return null;
  return (
    <div className="mt-3 rounded-lg bg-muted/50 p-2.5" data-testid="employment-match-signals">
      <p className="text-xs font-semibold text-muted-foreground">
        مؤشرات المطابقة مع المتطلبات المعلنة — للاطلاع فقط، والقرار لصاحب العمل
      </p>
      <ul className="mt-1.5 space-y-1">
        {signals.map((signal) => (
          <li key={`${signal.kind}-${signal.label}`} className="flex items-start gap-1.5 text-xs">
            <span
              aria-hidden
              className={cn(
                "mt-0.5 shrink-0",
                signal.status === "MET" ? "text-success" : "text-muted-foreground",
              )}
            >
              {signal.status === "MET" ? "✓" : "△"}
            </span>
            <span className="min-w-0 break-words" data-signal-status={signal.status}>
              {signal.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function jobFacts(job: EmploymentJob): [string, ReactNode][] {
  return [
    ["الدوام", `${EMPLOYMENT[job.employmentType] ?? job.employmentType} · ${WORKPLACE[job.workplaceMode] ?? job.workplaceMode}`],
    ["المكان", job.city || "عن بعد"],
    [
      "الخبرة",
      job.minExperienceYears == null
        ? "غير محددة"
        : job.minExperienceYears === 0
          ? "بدون خبرة"
          : `${job.minExperienceYears} سنوات على الأقل`,
    ],
    ["الراتب", job.salary ?? "غير معلن"],
  ];
}

function JobCard({
  job,
  index,
  owner,
  onSend,
}: {
  job: EmploymentJob;
  index: number;
  owner: boolean;
  onSend?: (text: string) => void;
}) {
  return (
    <SurfacePanel testId={`employment-job-${job.id}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold">
          <span className="num me-1 text-muted-foreground">{index + 1}.</span>
          {job.title}
        </h3>
        {owner && job.status && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="employment-job-status">
            {JOB_STATUS[job.status] ?? job.status}
          </span>
        )}
      </div>
      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin size={12} aria-hidden />
        {job.city || "عن بعد"} · {WORKPLACE[job.workplaceMode]} · {EMPLOYMENT[job.employmentType]}
      </p>
      <Chips items={job.skills} testId="employment-job-skills" />
      <p className="mt-2 text-sm">{job.salary ?? "الراتب غير معلن"}</p>
      {owner && typeof job.applicationCount === "number" && (
        <p className="mt-1 text-xs text-muted-foreground">المتقدمون: <span className="num">{job.applicationCount}</span></p>
      )}
      {!owner && <Signals signals={job.signals} />}
      {onSend && (
        <SurfaceActions>
          <Button size="sm" variant="secondary" onClick={() => onSend(`افتح الوظيفة ${ordinalText(index)}`)}>
            التفاصيل
          </Button>
          {owner ? (
            <Button size="sm" variant="soft" onClick={() => onSend(`اعرض المتقدمين على الوظيفة ${ordinalText(index)}`)}>
              المتقدمون
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => onSend(`قدم على الوظيفة ${ordinalText(index)}`)}>
              تقديم
            </Button>
          )}
        </SurfaceActions>
      )}
    </SurfacePanel>
  );
}

function CandidateBody({ candidate }: { candidate: EmploymentCandidate }) {
  return (
    <>
      <h3 className="break-words font-semibold">{candidate.professionalTitle || "بدون مسمى"}</h3>
      <FactList
        rows={factRows([
          ["الخبرة", candidate.experienceYears == null ? "غير مذكورة" : `${candidate.experienceYears} سنوات`],
          ["المدينة", candidate.city || "—"],
          [
            "يفضّل",
            [...candidate.workplacePreferences.map((value) => WORKPLACE[value] ?? value), ...candidate.employmentTypePreferences.map((value) => EMPLOYMENT[value] ?? value)].join("، ") || "—",
          ],
        ])}
      />
      <Chips items={candidate.skills} testId="employment-candidate-skills" />
      {candidate.experiences.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {candidate.experiences.map((entry, index) => (
            <li key={index} className="break-words">
              {entry.role}
              {entry.organization ? ` — ${entry.organization}` : ""}
              {entry.startYear ? ` (${entry.startYear}${entry.endYear ? `–${entry.endYear}` : ""})` : ""}
            </li>
          ))}
        </ul>
      )}
      {candidate.education.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {candidate.education.map((entry, index) => (
            <li key={index} className="break-words">
              {[entry.qualification, entry.field, entry.institution].filter(Boolean).join(" · ")}
            </li>
          ))}
        </ul>
      )}
      {candidate.portfolioLinks.length > 0 && (
        <ul className="mt-1 text-xs">
          {candidate.portfolioLinks.map((link) => (
            <li key={link} className="break-all text-primary">{link}</li>
          ))}
        </ul>
      )}
      {candidate.contactPhone && (
        <p className="mt-2 text-xs" data-testid="employment-candidate-contact">
          رقم التواصل الذي اختاره: <span dir="ltr" className="num">{candidate.contactPhone}</span>
        </p>
      )}
    </>
  );
}

function ApplicationCard({
  application,
  index,
  employer,
  onSend,
}: {
  application: EmploymentApplication;
  index: number;
  employer: boolean;
  onSend?: (text: string) => void;
}) {
  return (
    <SurfacePanel testId={`employment-application-${application.id}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold">
          <span className="num me-1 text-muted-foreground">{index + 1}.</span>
          {employer ? application.submitted?.professionalTitle : application.submittedJob?.title ?? application.job?.title}
        </h3>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="employment-application-status">
          {APPLICATION_STATUS[application.status] ?? application.status}
        </span>
      </div>
      {employer && application.submitted && (
        <>
          <FactList
            rows={factRows([
              ["الخبرة", application.submitted.experienceYears == null ? "غير مذكورة" : `${application.submitted.experienceYears} سنوات`],
              ["المدينة", application.submitted.city || "—"],
            ])}
          />
          <Chips items={application.submitted.skills} />
          <Signals signals={application.signals} />
          {application.candidate?.contactPhone && (
            <p className="mt-2 text-xs">
              رقم التواصل الذي اختاره: <span dir="ltr" className="num">{application.candidate.contactPhone}</span>
            </p>
          )}
        </>
      )}
      {!employer && application.job && (
        <p className="mt-1 text-xs text-muted-foreground">
          {application.job.city || "عن بعد"} · {WORKPLACE[application.job.workplaceMode]} · الوظيفة {JOB_STATUS[application.job.status] ?? application.job.status}
          {application.submittedJob && application.submittedJob.title !== application.job.title
            ? ` · قدّمت على «${application.submittedJob.title}»`
            : ""}
        </p>
      )}
      {onSend && application.status !== "WITHDRAWN" && (
        <SurfaceActions>
          {employer ? (
            <>
              <Button size="sm" variant="soft" onClick={() => onSend(`ضع المتقدم ${ordinalText(index)} في القائمة المختصرة`)}>
                القائمة المختصرة
              </Button>
              <Button size="sm" variant="danger-soft" onClick={() => onSend(`ارفض المتقدم ${ordinalText(index)}`)}>
                عدم المتابعة
              </Button>
            </>
          ) : (
            <Button size="sm" variant="danger-soft" onClick={() => onSend(`اسحب الطلب ${ordinalText(index)}`)}>
              سحب الطلب
            </Button>
          )}
        </SurfaceActions>
      )}
    </SurfacePanel>
  );
}

function ActionCard({ action }: { action: EmploymentAction }) {
  const apply = useApplyAiEmploymentAction();
  const [status, setStatus] = useState(action.status);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setStatus(action.status), [action.status]);
  const decide = async (decision: "CONFIRM" | "CANCEL") => {
    setError("");
    try {
      const result = await apply.mutateAsync({ id: action.actionId, data: { action: decision } });
      setStatus(result.status);
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تنفيذ الإجراء. حدّث المحادثة وحاول مرة أخرى.");
    }
  };
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary-soft/20 p-3.5" data-testid={`employment-action-${action.actionId}`}>
      {action.lines.length > 0 && (
        <ul className="space-y-1 text-sm">
          {action.lines.map((line) => (
            <li key={line} className="break-words">{line}</li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      {status === "PENDING" ? (
        <SurfaceActions>
          <Button size="sm" loading={apply.isPending} icon={<Check size={14} aria-hidden />} onClick={() => void decide("CONFIRM")} data-testid="employment-action-confirm">
            {action.confirmLabel}
          </Button>
          <Button size="sm" variant="ghost" disabled={apply.isPending} icon={<X size={14} aria-hidden />} onClick={() => void decide("CANCEL")} data-testid="employment-action-cancel">
            إلغاء
          </Button>
        </SurfaceActions>
      ) : (
        <p role="status" className="mt-2 text-sm text-muted-foreground" data-testid="employment-action-status" data-status={status}>
          {message || ACTION_STATUS[status]}
        </p>
      )}
    </div>
  );
}

/** Renders a server-built employment view. Buttons send the same conversational commands. */
export function EmploymentSurface({
  employment,
  active,
  onSend,
}: {
  employment: EmploymentPayload;
  active: boolean;
  onSend?: (text: string) => void;
}) {
  const send = active ? onSend : undefined;
  const view = employment.view;
  return (
    <section
      className="ai-surface mt-3 max-w-2xl space-y-2.5"
      aria-label="التوظيف"
      data-testid={`employment-${view.toLowerCase()}`}
    >
      {(view === "JOB_DRAFT" || view === "JOB_REVIEW") && employment.draft && (
        <SurfacePanel testId="employment-draft">
          <h3 className="flex items-center gap-1.5 font-semibold">
            <Briefcase size={16} aria-hidden />
            {employment.draft.title ?? "وظيفة بدون مسمى بعد"}
          </h3>
          {employment.draft.description && (
            <p className="mt-1 break-words text-sm text-muted-foreground">{employment.draft.description}</p>
          )}
          <FactList
            rows={factRows([
              ["المهارات", employment.draft.skills.join("، ") || "—"],
              ["الخبرة", employment.draft.minExperienceYears == null ? "—" : employment.draft.minExperienceYears === 0 ? "بدون خبرة" : `${employment.draft.minExperienceYears} سنوات`],
              ["الدوام", [employment.draft.employmentType && EMPLOYMENT[employment.draft.employmentType], employment.draft.workplaceMode && WORKPLACE[employment.draft.workplaceMode]].filter(Boolean).join(" · ") || "—"],
              ["المدينة", employment.draft.city ?? (employment.draft.workplaceMode === "REMOTE" ? "عن بعد" : "—")],
              ["الراتب", employment.draft.salary ?? "—"],
            ])}
          />
        </SurfacePanel>
      )}
      {view === "JOB_SEARCH_RESULTS" && (
        <>
          {employment.filters && employment.filters.length > 0 && <Chips items={employment.filters} testId="employment-job-filters" />}
          {(employment.jobs ?? []).length === 0 ? (
            <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm" role="status" data-testid="employment-empty">
              لا توجد وظائف منشورة مطابقة حاليًا.
            </p>
          ) : (
            employment.jobs!.map((job, index) => (
              <JobCard key={job.id} job={job} index={index} owner={false} onSend={send} />
            ))
          )}
        </>
      )}
      {view === "MY_JOBS" &&
        (employment.jobs ?? []).map((job, index) => (
          <JobCard key={job.id} job={job} index={index} owner onSend={send} />
        ))}
      {view === "JOB_DETAILS" && employment.job && (
        <SurfacePanel testId="employment-job-details">
          <h3 className="break-words font-semibold">{employment.job.title}</h3>
          {employment.audience === "OWNER" && employment.job.status && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="employment-job-status">
              الحالة: {JOB_STATUS[employment.job.status] ?? employment.job.status} · المتقدمون: <span className="num">{employment.job.applicationCount ?? 0}</span>
            </p>
          )}
          {employment.job.description && <p className="mt-2 break-words text-sm">{employment.job.description}</p>}
          <FactList rows={factRows(jobFacts(employment.job))} />
          <Chips items={employment.job.skills} />
          {employment.applicationStatus && (
            <p className="mt-2 text-sm" data-testid="employment-own-application-status">
              طلبك: {APPLICATION_STATUS[employment.applicationStatus] ?? employment.applicationStatus}
            </p>
          )}
          <Signals signals={employment.signals} />
          {send && employment.audience === "PUBLIC" && !employment.applicationStatus && (
            <SurfaceActions>
              <Button size="sm" onClick={() => send("قدم")}>تقديم</Button>
              <Button size="sm" variant="secondary" onClick={() => send("رجعني")}>رجوع للنتائج</Button>
            </SurfaceActions>
          )}
        </SurfacePanel>
      )}
      {view === "CV_PROFILE" && employment.profile && (
        <SurfacePanel testId="employment-cv-profile">
          <div className="flex items-start justify-between gap-2">
            <CandidateBodyTitle candidate={employment.profile} />
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="employment-cv-visibility" data-visibility={employment.profile.visibility}>
              {employment.profile.visibility === "DISCOVERABLE" ? "ظاهر لأصحاب العمل" : "خاص"}
            </span>
          </div>
          {employment.profile.summary && <p className="mt-1 break-words text-sm text-muted-foreground">{employment.profile.summary}</p>}
          <CandidateBody candidate={{ ...employment.profile, professionalTitle: "" }} />
          <p className="mt-3 text-xs text-muted-foreground">
            عدّل بالكتابة: «أضف TypeScript»، «احذف PHP»، «غيّر المسمى إلى …»، «اجعل ملفي ظاهرًا» أو «اخفِ ملفي».
          </p>
        </SurfacePanel>
      )}
      {view === "CANDIDATE_SEARCH_RESULTS" && (
        <>
          {employment.ignoredCriteria && employment.ignoredCriteria.length > 0 && (
            <p className="rounded-xl border border-border bg-muted/40 p-3 text-xs" data-testid="employment-ignored-criteria">
              لا يُبحث ولا يُرتَّب حسب: {employment.ignoredCriteria.join("، ")}.
            </p>
          )}
          {(employment.candidates ?? []).length === 0 ? (
            <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm" role="status" data-testid="employment-empty">
              لا توجد ملفات ظاهرة مطابقة حاليًا.
            </p>
          ) : (
            employment.candidates!.map((candidate, index) => (
              <SurfacePanel key={candidate.id} testId={`employment-candidate-${candidate.id}`}>
                <span className="num text-xs text-muted-foreground">{index + 1}.</span>
                <CandidateBody candidate={candidate} />
                {send && (
                  <SurfaceActions>
                    <Button size="sm" variant="secondary" onClick={() => send(`افتح المرشح ${ordinalText(index)}`)}>
                      الملف
                    </Button>
                  </SurfaceActions>
                )}
              </SurfacePanel>
            ))
          )}
        </>
      )}
      {view === "CANDIDATE_DETAILS" && (
        employment.candidate ? (
          <SurfacePanel testId="employment-candidate-details">
            <CandidateBody candidate={employment.candidate} />
          </SurfacePanel>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="employment-empty">لم يعد هذا الملف ظاهرًا.</p>
        )
      )}
      {view === "APPLICATION_REVIEW" && employment.job && (
        <SurfacePanel testId="employment-application-review">
          <h3 className="break-words font-semibold">{employment.job.title}</h3>
          <FactList rows={factRows(jobFacts(employment.job))} />
          {employment.profile && (
            <p className="mt-2 text-sm">
              الملف المرسل: <span className="font-semibold">{employment.profile.professionalTitle}</span>
            </p>
          )}
          <Signals signals={employment.signals} />
        </SurfacePanel>
      )}
      {(view === "MY_APPLICATIONS" || view === "APPLICATION_LIST") &&
        ((employment.applications ?? []).length === 0 ? (
          <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm" role="status" data-testid="employment-empty">
            لا توجد طلبات بعد.
          </p>
        ) : (
          employment.applications!.map((application, index) => (
            <ApplicationCard
              key={application.id}
              application={application}
              index={index}
              employer={view === "APPLICATION_LIST"}
              onSend={send}
            />
          ))
        ))}
      {view === "EMPLOYMENT_ACTION" && (
        <>
          {employment.job && (
            <SurfacePanel>
              <h3 className="break-words font-semibold">{employment.job.title}</h3>
              <FactList rows={factRows(jobFacts(employment.job))} />
            </SurfacePanel>
          )}
          {employment.application && (
            <ApplicationCard application={employment.application} index={0} employer={Boolean(employment.application.submitted)} />
          )}
        </>
      )}
      {employment.action && <ActionCard action={employment.action} />}
    </section>
  );
}

function CandidateBodyTitle({ candidate }: { candidate: EmploymentCandidate }) {
  return <h3 className="min-w-0 break-words font-semibold">{candidate.professionalTitle || "أضف مسمّاك المهني"}</h3>;
}
