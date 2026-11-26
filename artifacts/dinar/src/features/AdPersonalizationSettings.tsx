import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { api } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Badge, InlineAlert } from "@/ui/Feedback";

/**
 * Interest-based ads («الإعلانات الذكية»): the buyer's own switch. Off until they turn it on.
 * Shows exactly what is stored (categories and keywords only) and erases it on request.
 */
type Interest = { kind: "CATEGORY" | "TERM"; key: string; strength: number };
type Settings = { status: "ON" | "OFF"; decided: boolean; retentionDays: number; interests: Interest[] };

export function AdPersonalizationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api("/account/ad-personalization")
      .then((data) => setSettings(data as Settings))
      .catch((cause) => setError(friendlyError(cause)));
  useEffect(() => {
    void load();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const on = settings?.status === "ON";
  return (
    <section className="mb-5 rounded-xl border border-border bg-card p-4" data-testid="section-ad-personalization">
      <div className="mb-2 flex items-center gap-2">
        <Megaphone size={18} aria-hidden />
        <h2 className="font-bold">الإعلانات الذكية</h2>
        {settings ? <Badge tone={on ? "success" : "neutral"}>{on ? "مفعّلة" : "متوقفة"}</Badge> : null}
      </div>
      <p className="mb-3 text-sm leading-6 text-muted-foreground">
        عند التفعيل يرتّب جاسم الإعلانات حسب اهتماماتك من بحثك وسلتك، مثل السيارات وإكسسواراتها. نحفظ التصنيفات والكلمات
        المفتاحية فقط، لا نص رسائلك، ولا نستخدم المواضيع الحساسة كالصحة والدين والسياسة. تُحذف الاهتمامات تلقائيًا بعد{" "}
        {settings?.retentionDays ?? 90} يومًا، ويمكنك مسحها أو إيقاف الميزة في أي وقت.
      </p>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {!settings && !error ? <p className="text-sm text-muted-foreground" aria-busy="true">جارٍ التحميل…</p> : null}
      {settings ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={on ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => run(() => api("/account/ad-personalization", "PUT", { status: on ? "OFF" : "ON" }))}
              data-testid="button-ad-personalization-toggle"
            >
              {on ? "إيقاف الإعلانات الذكية ومسح اهتماماتي" : "أوافق على تفعيل الإعلانات الذكية"}
            </Button>
            {on && settings.interests.length ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api("/account/ad-interests/clear", "POST", {}))} data-testid="button-ad-interests-clear">
                امسح اهتماماتي
              </Button>
            ) : null}
          </div>
          {on ? (
            settings.interests.length ? (
              <div data-testid="list-ad-interests">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">ما يعرفه جاسم عن اهتماماتك الآن:</p>
                <div className="flex flex-wrap gap-1.5">
                  {settings.interests.map((item) => (
                    <span key={`${item.kind}:${item.key}`} className="rounded-full border border-border px-2.5 py-1 text-xs">
                      {item.key}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">لا توجد اهتمامات محفوظة بعد. ستظهر هنا بعد أن تبحث أو تضيف للسلة.</p>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}
