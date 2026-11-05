import { useEffect, useState } from "react";
import {
  ConnectAgreementViewSchema,
  type ConnectAgreement,
} from "@workspace/api-zod/connect-platform";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { ConnectAgreementDetails } from "./ConnectAgreementDetails";
type Agreement = {
  id: string;
  version: number;
  termsDigest: string;
  terms: ConnectAgreement;
  accepted: boolean;
  acceptance: { acceptedAt: string } | null;
};
export function ConnectAgreements({ partnerId }: { partnerId: string }) {
  const [agreements, setAgreements] = useState<Agreement[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const load = async () => {
    const rows = await api(`/connect/partners/${partnerId}/agreements`);
    if (!Array.isArray(rows)) throw new Error("تعذر قراءة الاتفاقيات");
    setAgreements(rows.map(row => ConnectAgreementViewSchema.parse(row)));
  };
  useEffect(() => {
    setSelected(null);
    setAgreements([]);
    setError("");
    setMessage("");
    void load().catch((e) => setError(e.message));
  }, [partnerId]);
  const accept = async (row: Agreement) => {
    if (busy || selected !== row.id) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const receipt = await api(
        `/connect/agreements/${row.id}/accept`,
        "POST",
        {
          expectedDigest: row.termsDigest,
          accept: true,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (receipt.accepted !== true)
        throw new Error("تعذر التحقق من دليل القبول");
      await load();
      setSelected(null);
      setMessage(
        "سجل الخادم قبولك الصريح لهذه النسخة؛ لا يثبت ذلك تحويلًا أو تسوية مال حقيقي.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر قبول الاتفاقية");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-bold">اتفاقيات العمولة المنفصلة</h2>
      <p className="text-sm">
        التسجيل المجاني لا يتطلب قبول عمولة. لا تُحتسب عمولة خارجية دون نسخة
        شروط مقبولة وتحويل مؤهل موثّق. الاتفاقيات المتاحة هنا بالمحاكاة فقط.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {agreements.length === 0 && <p>لا توجد اتفاقية مقترحة لهذا الحساب.</p>}
      {agreements.map((row) => (
        <article key={row.id} className="space-y-3 rounded-lg border p-3">
          <h3 className="font-bold">
            النسخة {row.version} —{" "}
            {row.accepted ? "مقبولة" : "بانتظار اختيار المالك"}
          </h3>
          <ConnectAgreementDetails terms={row.terms} />
          {row.accepted ? (
            <p role="status">
              حُفظ دليل القبول في{" "}
              {row.acceptance?.acceptedAt
                ? new Date(row.acceptance.acceptedAt).toLocaleString("ar")
                : "سجل الخادم"}
              .
            </p>
          ) : (
            <>
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  disabled={busy}
                  checked={selected === row.id}
                  onChange={(e) =>
                    setSelected(e.target.checked ? row.id : null)
                  }
                />
                <span>
                  قرأت الشروط المعروضة وأختار قبول هذه النسخة بالمحاكاة صراحةً
                  بصفتي مالك النشاط.
                </span>
              </label>
              <Button
                disabled={busy || selected !== row.id}
                onClick={() => void accept(row)}
              >
                تسجيل قبول النسخة {row.version}
              </Button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
