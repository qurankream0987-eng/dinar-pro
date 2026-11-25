/**
 * Business AI: one connected-store tool use in the conversation. A write is shown as the person's
 * own confirmation (what is sent, to which store); nothing is done until they press «تأكيد».
 * Provider data is shown as the store's data, never as Jassim's fact.
 */
import { useState } from "react";

type Result =
  | { status: "CONFIRMATION_REQUIRED"; confirmationId: string; expiresAt: string; summary: { tool: string; capability: string; arguments: Record<string, unknown>; store?: string; sharedWithStore?: string } }
  | { status: "EXECUTED"; access: "READ" | "WRITE"; providerStatus: number; connector?: string; result: { data: unknown } }
  | { status: "REFUSED"; refusal: string };

const CAPABILITY: Record<string, string> = { CREATE: "طلب جديد", BOOK: "حجز", SCHEDULE: "موعد", UPDATE: "تعديل", CANCEL: "إلغاء", DELETE: "حذف", MESSAGE: "رسالة", PAY: "دفع", REFUND: "استرجاع" };
const REFUSAL: Record<string, string> = { RATE_LIMITED: "تجاوزت عدد الطلبات المسموح خلال ساعة؛ حاول لاحقًا.", TOOL_NOT_AVAILABLE: "هذه الخدمة لم تعد متاحة من المتجر.", LIVE_MODE_REQUIRED: "المتجر لم يفعّل الطلبات الحقيقية بعد.", BINDING_NOT_VERIFIED: "نظام المتجر غير متاح الآن." };

function flatten(value: unknown, prefix = ""): [string, string][] {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key)).slice(0, 20);
  return [[prefix, Array.isArray(value) ? value.map(String).join("، ") : String(value)]];
}

export function ConnectActionCard({ result, active }: { result: Result; active: boolean }) {
  const [state, setState] = useState<"IDLE" | "BUSY" | "DONE" | "CANCELLED" | "FAILED">("IDLE");
  const [message, setMessage] = useState("");
  if (result.status === "REFUSED") return <p role="status" className="mt-2 text-sm">{REFUSAL[result.refusal] ?? "تعذر تنفيذ الطلب عبر نظام المتجر."}</p>;
  if (result.status === "EXECUTED")
    return (
      <section dir="rtl" className="mt-3 max-w-xl rounded-xl border bg-card p-4 text-sm" data-testid="connect-read-result">
        <p className="text-xs text-muted-foreground">بيانات من نظام {result.connector ?? "المتجر"} — كما أرسلها المتجر، وليست تأكيدًا من جاسم.</p>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{JSON.stringify(result.result.data, null, 2).slice(0, 4000)}</pre>
      </section>
    );
  const act = async (decision: "confirm" | "cancel") => {
    setState("BUSY");
    try {
      const response = await fetch(`/api/connect/action-confirmations/${encodeURIComponent(result.confirmationId)}/${decision}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await response.json().catch(() => ({}))) as { status?: string; refusal?: string; error?: string };
      if (decision === "cancel") { setState(response.ok ? "CANCELLED" : "FAILED"); setMessage(response.ok ? "أُلغي الطلب؛ لم يُرسل شيء إلى المتجر." : body.error ?? "تعذر الإلغاء."); return; }
      if (response.ok && body.status === "EXECUTED") { setState("DONE"); setMessage("أكّد نظام المتجر استلام طلبك. المتابعة والدفع وفق شروط المتجر."); return; }
      setState("FAILED");
      setMessage(body.refusal ? REFUSAL[body.refusal] ?? "لم يُنفذ الطلب." : body.error ?? "لم يؤكد المتجر الطلب؛ لا تعتبره تم.");
    } catch {
      setState("FAILED");
      setMessage("تعذر الاتصال الآن؛ لم يُعتبر الطلب منفذًا.");
    }
  };
  const rows = flatten(result.summary.arguments);
  return (
    <section dir="rtl" aria-label="تأكيد طلب من متجر" className="mt-3 max-w-xl space-y-3 rounded-xl border bg-card p-4 text-sm" data-testid="connect-confirmation">
      <h3 className="font-semibold">{CAPABILITY[result.summary.capability] ?? "طلب"} من {result.summary.store || "المتجر"}</h3>
      {rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {rows.map(([key, value]) => (
            <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      )}
      {result.summary.sharedWithStore && <p className="text-xs text-muted-foreground">{result.summary.sharedWithStore}</p>}
      {message && <p role="status" className="text-xs">{message}</p>}
      {state === "IDLE" || state === "BUSY" ? (
        <div className="flex gap-2">
          <button type="button" disabled={!active || state === "BUSY"} className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50" onClick={() => act("confirm")}>تأكيد وإرسال للمتجر</button>
          <button type="button" disabled={!active || state === "BUSY"} className="rounded-full border px-4 py-2 text-xs disabled:opacity-50" onClick={() => act("cancel")}>إلغاء</button>
        </div>
      ) : null}
    </section>
  );
}
