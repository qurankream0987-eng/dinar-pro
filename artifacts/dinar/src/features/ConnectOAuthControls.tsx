import { useEffect, useState } from "react";
import { ConnectOAuthStatusSchema, type ConnectOAuthStatus } from "@workspace/api-zod/connect-platform";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
type Status = ConnectOAuthStatus;
export function ConnectOAuthControls({ integrationId, revision, endpoint }: { integrationId: string; revision: number; endpoint: string }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [review, setReview] = useState<"start" | "refresh" | "disconnect" | null>(null), [authorizationUrl, setAuthorizationUrl] = useState("");
  const path = `/connect/integrations/${integrationId}/oauth`;
  const load = async () => { const result = await api(`${path}/status`); setStatus(ConnectOAuthStatusSchema.parse(result)); };
  useEffect(() => { setAuthorizationUrl(""); setStatus(null); void load().catch(e => setError(e.message)); }, [integrationId, revision]);
  const confirm = async () => {
    if (!review || busy) return;
    const action = review; setBusy(true); setError(""); setMessage(""); setAuthorizationUrl("");
    try {
      const result = await api(`${path}/${action}`, "POST", { confirm: true, expectedRevision: revision });
      if (action === "start") {
        const url = new URL(result.authorizationUrl);
        if (url.protocol !== "https:" || url.hostname !== new URL(endpoint).hostname) throw new Error("تعذر التحقق من وجهة تفويض المزوّد");
        setAuthorizationUrl(url.href); setMessage("تابع لدى المزوّد للموافقة على القراءة فقط؛ لم يُفوّض الحساب بعد.");
      } else setMessage(action === "refresh" ? "جدد الخادم تفويض القراءة وفق رد المزوّد." : "أوقف جاسم استخدام التفويض محليًا. لإلغائه لدى المزوّد، استخدم إعدادات حسابك هناك.");
      setReview(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إتمام ربط الحساب"); }
    finally { setBusy(false); }
  };
  return <section className="w-full space-y-3 rounded-lg border p-3" aria-label="تفويض حساب الكتالوج للقراءة">
    <h4 className="font-bold">تفويض حساب الكتالوج — قراءة فقط</h4>
    <p>لا يمنح هذا الربط صلاحية شراء أو دفع أو إدارة حسابك. لا تُرسل رموز الوصول في المحادثة.</p>
    {status && <p role="status">{status.connected ? "أكد الخادم وجود تفويض قراءة صالح." : "لا يوجد تفويض قراءة صالح الآن."}{status.expiresAt && <> ينتهي: <time dateTime={status.expiresAt}>{new Date(status.expiresAt).toLocaleString("ar")}</time></>}</p>}
    {!status && !error && <p role="status">جارٍ التحقق من التفويض…</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setReview("start")}>مراجعة تفويض القراءة لدى المزوّد</Button><Button variant="secondary" disabled={busy || !status?.canRefresh} onClick={() => setReview("refresh")}>مراجعة تجديد التفويض</Button><Button variant="danger-soft" disabled={busy} onClick={() => setReview("disconnect")}>مراجعة إيقاف التفويض محليًا</Button></div>
    {review && <div className="space-y-2 rounded-lg border p-3"><p>{review === "start" ? "سيبدأ طلب تفويض جديد للقراءة فقط، ويتوقف التفويض المحلي السابق. الموافقة النهائية تكون لدى المزوّد." : review === "refresh" ? "سيطلب جاسم تجديد تفويض القراءة. قد يلزم إعادة الربط إذا رفض المزوّد التجديد." : "سيتوقف استخدام الرموز داخل جاسم. لا يعني ذلك إلغاء إذن الحساب لدى المزوّد، ولا يمحو سجلات العقود أو المحاسبة."}</p><Button disabled={busy} onClick={() => void confirm()}>تأكيد {review === "start" ? "بدء تفويض القراءة" : review === "refresh" ? "تجديد تفويض القراءة" : "إيقاف التفويض محليًا"}</Button><Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>تراجع عن التفويض</Button></div>}
    {authorizationUrl && <a className="inline-flex min-h-11 items-center rounded-lg border p-2 underline focus-visible:outline-2" href={authorizationUrl} target="_blank" rel="noopener noreferrer">المتابعة لدى المزوّد — {new URL(authorizationUrl).hostname}</a>}
    <Button variant="secondary" disabled={busy} onClick={() => { setError(""); void load().catch(e => setError(e.message)); }}>التحقق من حالة تفويض الحساب</Button>
  </section>;
}
