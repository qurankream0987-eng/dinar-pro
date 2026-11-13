import { useState } from "react";
import { Pencil, Send } from "lucide-react";
import { Button } from "@/ui/Button";

/**
 * A deliberately small, optional helper inside the seller conversation.
 * Every answer is sent through the same conversation turn as typed language,
 * so the server remains the sole owner of the canonical draft.
 */
export function SellerDraftHelper({
  draftStep,
  active,
  onSend,
}: {
  draftStep?: string;
  active: boolean;
  onSend?: (message: string) => void;
}) {
  const [value, setValue] = useState("");
  if (
    !active ||
    !onSend ||
    ["publish_review", "choose_draft", "published", "cancelled"].includes(
      draftStep ?? "",
    )
  )
    return null;

  const choices =
    draftStep === "price"
      ? [
          { label: "بدون سعر", message: "بدون سعر" },
          { label: "قابل للتفاوض", message: "قابل للتفاوض" },
          { label: "السعر نهائي", message: "السعر نهائي" },
        ]
      : draftStep?.startsWith("attribute:") &&
          /condition|حالة/i.test(draftStep)
        ? [
            { label: "جديد", message: "جديد" },
            { label: "شبه جديد", message: "شبه جديد" },
            { label: "مستعمل", message: "مستعمل" },
            { label: "يحتاج إصلاح", message: "يحتاج إصلاح" },
          ]
        : draftStep === "contact"
          ? [
              { label: "رقم حسابي المسجل", message: "استخدم رقم حسابي المسجل" },
              { label: "محادثة جاسم فقط", message: "محادثة فقط" },
            ]
          : draftStep === "contact_account_confirmation"
            ? [
                { label: "نعم، استخدمه", message: "نعم" },
                { label: "لا، رقم آخر", message: "لا، سأرسل رقمًا آخر" },
              ]
            : draftStep === "payment_methods"
              ? [
                  { label: "كاش", message: "كاش" },
                  { label: "فيزا", message: "فيزا" },
                  { label: "الاثنين", message: "الاثنين" },
                ]
        : [];

  const send = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <details
      className="mt-3 rounded-xl border border-border bg-card text-sm"
      data-testid="seller-manual-helper"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 font-semibold text-primary [&::-webkit-details-marker]:hidden">
        <Pencil size={15} aria-hidden />
        أدخل التفاصيل يدويًا
        <span className="ms-auto text-xs font-normal text-muted-foreground">
          اختياري
        </span>
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">
        <p className="text-xs leading-5 text-muted-foreground">
          اختر إجابة سريعة أو اكتبها بطريقتك؛ ستُضاف إلى مسودة الإعلان الحالية.
        </p>
        {choices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <Button
                key={choice.message}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => send(choice.message)}
                data-testid={`seller-helper-${choice.message}`}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(value);
          }}
        >
          <label className="sr-only" htmlFor="seller-manual-answer">
            إجابة يدوية للمسودة
          </label>
          <input
            id="seller-manual-answer"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={1000}
            placeholder="اكتب الإجابة أو المعلومة التي تريد تعديلها"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="input-seller-manual-answer"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!value.trim()}
            aria-label="إرسال التفاصيل إلى المسودة"
            data-testid="button-seller-manual-answer"
          >
            <Send size={15} aria-hidden />
          </Button>
        </form>
      </div>
    </details>
  );
}
