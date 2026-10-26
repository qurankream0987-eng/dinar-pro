import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { InlineAlert } from "@/ui/Feedback";
import { Field, Select, Textarea } from "@/ui/Field";
import { Sheet } from "@/ui/Sheet";

type ReportTarget = "LISTING" | "USER" | "ORDER";
type Reason = { code: string; labelAr: string };

const targetLabel: Record<ReportTarget, string> = {
  LISTING: "الإبلاغ عن العرض",
  USER: "الإبلاغ عن المستخدم",
  ORDER: "الإبلاغ عن مشكلة في الطلب",
};

/**
 * One reporting entry point for every target type. The server derives the
 * reporter from the session and decides whether the target is reportable.
 */
export function ReportButton({
  targetType,
  targetId,
  label,
  variant = "ghost",
}: {
  targetType: ReportTarget;
  targetId: string;
  label?: string;
  variant?: "ghost" | "secondary";
}) {
  const { user } = useAccount();
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<"created" | "duplicate" | null>(null);

  const reasons = useQuery<Reason[]>({
    queryKey: ["report-reasons", targetType],
    queryFn: async () =>
      (await api(`/reports/reasons?targetType=${targetType}`)) as Reason[],
    enabled: open,
    staleTime: 300_000,
  });
  const submit = useMutation({
    mutationFn: async () =>
      (await api("/reports", "POST", {
        targetType,
        targetId,
        reasonCode,
        ...(note.trim() ? { note: note.trim() } : {}),
      })) as { duplicate: boolean },
    onSuccess: (result) => setDone(result.duplicate ? "duplicate" : "created"),
  });

  if (!user) return null;
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        icon={<Flag size={15} aria-hidden />}
        onClick={() => {
          setDone(null);
          submit.reset();
          setOpen(true);
        }}
        data-testid={`button-report-${targetType.toLowerCase()}`}
      >
        {label ?? "إبلاغ"}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={targetLabel[targetType]}
        description="تراجع إدارة السوق كل بلاغ. البلاغ وحده لا يعني عقوبة تلقائية."
        width={460}
        testId="dialog-report"
        footer={
          done ? (
            <Button block onClick={() => setOpen(false)}>
              تم
            </Button>
          ) : (
            <Button
              block
              disabled={!reasonCode}
              loading={submit.isPending}
              onClick={() => submit.mutate()}
              data-testid="button-submit-report"
            >
              إرسال البلاغ
            </Button>
          )
        }
      >
        {done ? (
          <InlineAlert tone={done === "created" ? "success" : "info"}>
            {done === "created"
              ? "وصل بلاغك وسيراجعه فريق السوق."
              : "سبق أن أرسلت بلاغًا عن هذا العنصر وهو قيد المراجعة."}
          </InlineAlert>
        ) : (
          <div className="grid gap-4">
            <Field label="سبب البلاغ">
              <Select
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
                data-testid="select-report-reason"
              >
                <option value="">اختر السبب</option>
                {(reasons.data ?? []).map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {reason.labelAr}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="تفاصيل" optional hint="لا تكتب أرقام هواتف أو بيانات شخصية.">
              <Textarea
                value={note}
                maxLength={1000}
                rows={3}
                onChange={(event) => setNote(event.target.value)}
                data-testid="input-report-note"
              />
            </Field>
            {submit.error && (
              <InlineAlert tone="danger">{friendlyError(submit.error)}</InlineAlert>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
