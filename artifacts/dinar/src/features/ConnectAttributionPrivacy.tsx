import { useState } from "react";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
export function ConnectAttributionPrivacy() {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const withdraw = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const receipt = await api("/connect/privacy/attribution", "POST", {
        granted: false,
      });
      if (receipt.granted !== false)
        throw new Error("تعذر التحقق من سحب الموافقة.");
      setMessage(
        "سُحبت موافقات إسناد الإحالات السابقة. يمكنك فتح عروض الشركاء دون تتبّع؛ تبقى أدلة المحاسبة المسجلة محفوظة.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر سحب الموافقة");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      aria-label="خصوصية إحالات الشركاء"
    >
      <h3 className="font-bold">إحالات الشركاء</h3>
      <p className="text-sm">
        لا تُفعّل الإحالة القابلة للإسناد تلقائيًا. يلزم اختيارك الصريح لإشعار
        الرابط. سحب الموافقة يمنع إسناد تحويلات جديدة للإحالات السابقة دون حذف
        أدلة محاسبية قائمة.
      </p>
      <Button
        variant="secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void withdraw()}
        data-testid="connect-withdraw-consent"
      >
        سحب موافقات إسناد الإحالات السابقة
      </Button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
