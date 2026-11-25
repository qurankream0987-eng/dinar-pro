/**
 * Multi-company plan: every store and every value is shown before the person's single confirmation.
 * After it runs, each step's outcome is shown as it happened (a partial result is said plainly).
 */
import { useState } from "react";

type Step = { index: number; store: string; tool: string; capability: string; access: string; arguments: unknown };
type Plan = { workflowId: string; expiresAt: string; steps: Step[]; note: string } | { refused: string };
type Outcome = { status: "COMPLETED" | "PARTIAL" | "FAILED"; steps: { index: number; store: string; tool: string; status: "SUCCEEDED" | "FAILED" | "SKIPPED" }[] };

const STEP_STATUS = { SUCCEEDED: "تم", FAILED: "لم يتم", SKIPPED: "لم يُنفّذ (توقفت الخطة)" } as const;
const OUTCOME = { COMPLETED: "تمت كل الخطوات.", PARTIAL: "تمت بعض الخطوات وتوقفت الخطة عند خطوة فشلت. الخطوات التي تمت قائمة لدى المتاجر؛ راجعها معهم إن لزم.", FAILED: "لم تتم أي خطوة؛ لم يُرسل أي طلب ناجح." } as const;

function describe(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const from = (value as { $from?: { step: number } }).$from;
    if (from) return `من نتيجة الخطوة ${from.step + 1}`;
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${describe(item)}`).join("، ");
  }
  return String(value);
}

export function WorkflowCard({ plan, active }: { plan: Plan; active: boolean }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [message, setMessage] = useState("");
  if ("refused" in plan) return <p role="status" className="mt-2 text-sm">تعذر إعداد هذه الخطة عبر المتاجر الموصولة.</p>;
  const act = async (decision: "confirm" | "cancel") => {
    setBusy(true);
    try {
      const response = await fetch(`/api/connect/workflows/${encodeURIComponent(plan.workflowId)}/${decision}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => ({}));
      if (decision === "cancel") setMessage(response.ok ? "أُلغيت الخطة؛ لم يُرسل شيء." : body.error ?? "تعذر الإلغاء.");
      else if (response.ok) setOutcome(body as Outcome);
      else setMessage(body.error ?? "لم تُنفّذ الخطة.");
    } catch {
      setMessage("تعذر الاتصال؛ لا تعتبر أي خطوة منفذة قبل التحقق.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section dir="rtl" aria-label="خطة عبر عدة متاجر" className="mt-3 max-w-xl space-y-3 rounded-xl border bg-card p-4 text-sm" data-testid="connect-workflow">
      <h3 className="font-semibold">خطة من {plan.steps.length} خطوات</h3>
      <ol className="space-y-2">
        {plan.steps.map((step) => {
          const done = outcome?.steps.find((item) => item.index === step.index);
          return (
            <li key={step.index} className="rounded-lg border p-2">
              <p className="font-medium">{step.index + 1}. {step.store} — {step.tool}</p>
              <p className="text-xs text-muted-foreground">{describe(step.arguments)}</p>
              {done && <p className="text-xs" role="status">{STEP_STATUS[done.status]}</p>}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{plan.note}</p>
      {outcome && <p role="status" className="text-xs font-medium">{OUTCOME[outcome.status]}</p>}
      {message && <p role="status" className="text-xs">{message}</p>}
      {!outcome && !message && (
        <div className="flex gap-2">
          <button type="button" disabled={!active || busy} className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50" onClick={() => act("confirm")}>تأكيد الخطة كاملة</button>
          <button type="button" disabled={!active || busy} className="rounded-full border px-4 py-2 text-xs disabled:opacity-50" onClick={() => act("cancel")}>إلغاء</button>
        </div>
      )}
    </section>
  );
}
