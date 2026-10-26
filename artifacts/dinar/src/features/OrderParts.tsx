import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  FileWarning,
  Info,
  MessageCircle,
  PackageX,
  Scale,
  SendHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  getGetOrderMessagesQueryKey,
  useGetOrderMessages,
  useSendOrderMessage,
  type Message,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { clock, longDate } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { TIMELINE, timelineIndex } from "@/lib/marketplace";
import { Button, iconButtonClass } from "@/ui/Button";
import { ChoiceCard, Field, Input, Textarea } from "@/ui/Field";
import { InlineAlert, Skeleton, ErrorState } from "@/ui/Feedback";
import { Sheet } from "@/ui/Sheet";

/* ------------------------------------------------------------------ Timeline */

export function OrderTimeline({
  status,
  createdAt,
  updatedAt,
}: {
  status: string;
  createdAt: string;
  updatedAt: string;
}) {
  if (status === "CANCELLED")
    return (
      <div className="flex items-center gap-3 rounded-lg bg-muted p-3.5 text-base">
        <Ban size={20} className="shrink-0 text-muted-foreground" aria-hidden />
        <span>
          أُلغي الطلب في {longDate(updatedAt)}. أُعيدت أي كمية محجوزة للبائع.
        </span>
      </div>
    );
  const current = timelineIndex(status);
  const disputed = status === "DISPUTED";
  const done = ["COMPLETED", "BUYER_CONFIRMED"].includes(status);
  return (
    <ol aria-label="مراحل الطلب" className="relative">
      {TIMELINE.map((step, i) => {
        const complete = i < current || (done && i === current);
        const active = i === current && !done;
        const label =
          i === 3
            ? disputed
              ? "نزاع مفتوح — لم يكتمل الطلب"
              : done
                ? step.label
                : "بانتظار تأكيد الاستلام"
            : step.label;
        return (
          <li
            key={step.key}
            className="relative flex gap-3 pb-5 last:pb-0"
            aria-current={active ? "step" : undefined}
          >
            {i < TIMELINE.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute start-[13px] top-7 h-[calc(100%-24px)] w-0.5 rounded-full",
                  complete ? "bg-success" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold",
                complete && "border-success bg-success text-white",
                active &&
                  !disputed &&
                  "border-primary bg-primary-soft text-primary ring-4 ring-primary/10",
                !complete &&
                  !active &&
                  "border-border bg-card text-muted-foreground",
                disputed &&
                  i === 3 &&
                  "border-destructive bg-destructive-soft text-destructive",
              )}
            >
              {complete ? (
                <Check size={15} strokeWidth={3} aria-hidden />
              ) : disputed && i === 3 ? (
                <Scale size={14} aria-hidden />
              ) : (
                <span className="num">{i + 1}</span>
              )}
            </span>
            <div className="min-w-0 pt-0.5">
              <p
                className={cn(
                  "text-base",
                  complete || active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {label}
              </p>
              {i === 0 && (
                <p className="text-xs text-muted-foreground">
                  {longDate(createdAt)}
                </p>
              )}
              {active && (
                <p className="text-xs font-semibold text-primary">
                  المرحلة الحالية
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ Chat */

const SYSTEM_ICONS: [RegExp, LucideIcon][] = [
  [/نزاع/, Scale],
  [/إلغاء|ألغ|انتهت/, Ban],
  [/./, Info],
];

function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

export function OrderChat({
  orderId,
  title,
  subtitle,
}: {
  orderId: string;
  title: string;
  subtitle?: string;
}) {
  const qc = useQueryClient();
  const messages = useGetOrderMessages(orderId, {
    query: {
      queryKey: getGetOrderMessagesQueryKey(orderId),
      enabled: !!orderId,
      refetchInterval: 8000,
    },
  });
  const send = useSendOrderMessage();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const data = (messages.data ?? []) as Message[];

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [data.length]);

  const submit = () => {
    const text = body.trim();
    if (!text || send.isPending) return;
    setError("");
    send.mutate(
      { id: orderId, data: { body: text } },
      {
        onSuccess: () => {
          setBody("");
          void qc.invalidateQueries({
            queryKey: getGetOrderMessagesQueryKey(orderId),
          });
        },
        onError: (e) =>
          setError(friendlyError(e, "لم تُرسل الرسالة. حاول مرة أخرى.")),
      },
    );
  };

  return (
    <section
      id="chat"
      aria-label="محادثة الطلب"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
          <MessageCircle size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold">{title}</h2>
          {subtitle && (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </header>

      <div
        ref={list}
        className="max-h-[440px] min-h-[200px] space-y-2 overflow-y-auto bg-background/60 px-3 py-4"
        aria-live="polite"
      >
        {messages.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="ms-auto h-10 w-2/3 rounded-2xl" />
            <Skeleton className="h-10 w-1/2 rounded-2xl" />
          </div>
        ) : messages.isError ? (
          <ErrorState compact onRetry={() => messages.refetch()} />
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <MessageCircle
              size={28}
              className="text-muted-foreground"
              aria-hidden
            />
            <p className="mt-2 text-base font-semibold">لا توجد رسائل بعد</p>
            <p className="text-sm text-muted-foreground">
              ابدأ بتحديث واضح عن الطلب — الرسائل تبقى داخل هذا الطلب.
            </p>
          </div>
        ) : (
          data.map((m, i) => {
            const newDay =
              i === 0 || dayKey(data[i - 1].createdAt) !== dayKey(m.createdAt);
            const system = m.senderRole === "SYSTEM";
            const Icon =
              SYSTEM_ICONS.find(([re]) => re.test(m.body))?.[1] ?? Info;
            return (
              <div key={m.id}>
                {newDay && (
                  <p className="my-3 text-center text-2xs font-semibold text-muted-foreground">
                    {longDate(m.createdAt)}
                  </p>
                )}
                {system ? (
                  <div
                    data-testid={`message-${m.id}`}
                    className="my-2 flex justify-center"
                  >
                    <span className="inline-flex max-w-[88%] items-start gap-1.5 rounded-2xl border border-border bg-card px-3 py-1.5 text-xs font-medium leading-5 text-text-secondary">
                      <Icon
                        size={13}
                        className="mt-[3px] shrink-0 text-primary"
                        aria-hidden
                      />
                      <span>
                        {m.body}
                        <span className="num whitespace-nowrap text-muted-foreground">
                          {" "}
                          · {clock(m.createdAt)}
                        </span>
                      </span>
                    </span>
                  </div>
                ) : (
                  <div
                    data-testid={`message-${m.id}`}
                    className={cn(
                      "flex",
                      m.isMine ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[80%] rounded-2xl px-3.5 py-2 text-base leading-6 [overflow-wrap:anywhere]",
                        m.isMine
                          ? "rounded-ee-md bg-primary text-primary-foreground"
                          : "rounded-es-md border border-border bg-card text-foreground",
                      )}
                    >
                      {!m.isMine && (
                        <p className="mb-0.5 text-2xs font-bold text-primary">
                          {m.senderName}
                        </p>
                      )}
                      <p className="whitespace-pre-line">{m.body}</p>
                      <p
                        className={cn(
                          "num mt-0.5 text-[10px]",
                          m.isMine
                            ? "text-primary-foreground/70"
                            : "text-muted-foreground",
                        )}
                      >
                        {clock(m.createdAt)}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`msg-${orderId}`} className="sr-only">
          اكتب رسالة
        </label>
        <textarea
          id={`msg-${orderId}`}
          rows={1}
          value={body}
          maxLength={1000}
          onChange={(e) => {
            setBody(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              window.matchMedia("(min-width: 768px)").matches
            ) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="اكتب رسالة عن هذا الطلب…"
          data-testid="input-order-message"
          className="max-h-[120px] min-h-11 flex-1 resize-none rounded-[22px] border border-input bg-background px-4 py-2.5 text-base leading-6 outline-none focus:border-primary focus:ring-4 focus:ring-primary/10"
        />
        <button
          type="submit"
          aria-label="إرسال"
          disabled={!body.trim() || send.isPending}
          data-testid="button-send-message"
          aria-busy={send.isPending || undefined}
          className={`${iconButtonClass("solid")} dinar-composer-send`}
        >
          {/* RTL: send points left */}
          <SendHorizontal size={19} className="icon-dir" aria-hidden />
        </button>
      </form>
      {error && (
        <p
          role="alert"
          className="px-4 pb-3 text-xs font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Dispute */

export const DISPUTE_REASONS = [
  {
    value: "لم أستلم الطلب",
    icon: PackageX,
    hint: "البائع أفاد بالتسليم لكن الطلب لم يصلك",
  },
  {
    value: "العرض لا يطابق الوصف",
    icon: FileWarning,
    hint: "ما استلمته يختلف عما وُصف في العرض",
  },
  {
    value: "مشكلة في الكمية",
    icon: TriangleAlert,
    hint: "عدد الوحدات المستلمة غير صحيح",
  },
  { value: "سبب آخر", icon: Info, hint: "مشكلة أخرى تحتاج مراجعة" },
];

/** Parse the stored issue text ("reason: details — الدليل: ref") back into parts. */
export function parseIssue(issue?: string | null) {
  if (!issue) return { reason: "", details: "", evidence: "" };
  const [main, evidence = ""] = issue.split(" — الدليل: ");
  const idx = main.indexOf(": ");
  return idx > 0
    ? { reason: main.slice(0, idx), details: main.slice(idx + 2), evidence }
    : { reason: "", details: main, evidence };
}

export function DisputeSheet({
  open,
  onOpenChange,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (dispute: {
    reason: string;
    description: string;
    evidence: string[];
  }) => void;
  pending: boolean;
  error?: string;
}) {
  const [step, setStep] = useState(0);
  const [reason, setReason] = useState(DISPUTE_REASONS[0].value);
  const [details, setDetails] = useState("");
  const [evidence, setEvidence] = useState("");
  const steps = ["السبب", "التفاصيل", "المراجعة"];
  const canNext = step === 0 || (step === 1 && details.trim().length >= 10);
  useEffect(() => {
    if (!open) setStep(0);
  }, [open]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      testId="sheet-dispute"
      title="الإبلاغ عن مشكلة"
      description={
        <span className="flex items-center gap-2">
          {steps.map((s, i) => (
            <span
              key={s}
              className={cn(
                "flex items-center gap-1 text-xs font-semibold",
                i <= step ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "num flex h-5 w-5 items-center justify-center rounded-full text-[10px]",
                  i <= step ? "bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {i + 1}
              </span>
              {s}
              {i < steps.length - 1 && (
                <span aria-hidden className="mx-1 h-px w-4 bg-border" />
              )}
            </span>
          ))}
        </span>
      }
      footer={
        <div className="flex gap-2">
          {step > 0 && (
            <Button
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              onClick={() => setStep(step - 1)}
              disabled={pending}
            >
              السابق
            </Button>
          )}
          {step < 2 ? (
            <Button
              block
              disabled={!canNext}
              onClick={() => setStep(step + 1)}
              data-testid="button-dispute-next"
            >
              التالي
            </Button>
          ) : (
            <Button
              block
              variant="danger"
              loading={pending}
              data-testid="button-submit-dispute"
              onClick={() =>
                onSubmit({
                  reason,
                  description: details.trim(),
                  evidence: evidence.trim() ? [evidence.trim()] : [],
                })
              }
            >
              إرسال البلاغ
            </Button>
          )}
        </div>
      }
    >
      {step === 0 && (
        <div
          className="space-y-2 pb-2"
          role="radiogroup"
          aria-label="سبب المشكلة"
        >
          {DISPUTE_REASONS.map((r) => (
            <ChoiceCard
              key={r.value}
              name="dispute-reason"
              value={r.value}
              selected={reason === r.value}
              onSelect={() => setReason(r.value)}
              title={r.value}
              description={r.hint}
              icon={<r.icon size={19} aria-hidden />}
            />
          ))}
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4 pb-2">
          <Field
            label="اشرح ما حدث"
            hint={`10 أحرف على الأقل · ${details.length}/600`}
          >
            <Textarea
              value={details}
              maxLength={600}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="مثال: وصلني صندوق فيه وحدتان بدل ثلاث."
              data-testid="input-dispute"
            />
          </Field>
          <Field
            label="مرجع الدليل"
            optional
            hint="رقم شحنة أو وصف دليل تحتفظ به. المحادثة نصية ورفع ملفات الأدلة غير متاح حاليًا."
          >
            <Input
              value={evidence}
              maxLength={300}
              onChange={(e) => setEvidence(e.target.value)}
              data-testid="input-dispute-evidence"
            />
          </Field>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4 pb-2">
          <dl className="space-y-3 rounded-lg bg-muted p-4 text-base">
            <div>
              <dt className="text-xs text-muted-foreground">السبب</dt>
              <dd className="font-semibold">{reason}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">التفاصيل</dt>
              <dd className="whitespace-pre-line">{details}</dd>
            </div>
            {evidence.trim() && (
              <div>
                <dt className="text-xs text-muted-foreground">مرجع الدليل</dt>
                <dd>{evidence}</dd>
              </div>
            )}
          </dl>
          <p className="text-sm text-muted-foreground">
            بعد الإرسال يتحول الطلب إلى «نزاع» ولن يُعتبر مكتملًا. تبقى المحادثة
            مفتوحة مع البائع.
          </p>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        </div>
      )}
    </Sheet>
  );
}
