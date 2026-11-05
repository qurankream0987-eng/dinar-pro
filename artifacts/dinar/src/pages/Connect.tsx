import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { ConnectAgreements } from "@/features/ConnectAgreements";
import { ConnectTeam, ConnectReadOnlyCatalog } from "@/features/ConnectTeam";
import { ConnectDashboard } from "@/features/ConnectDashboard";
type Site = { id: string; hostname: string; status: string };
type Integration = {
  id: string;
  name: string;
  status: string;
  kind: string;
  capabilities: string[];
  endpointUrl: string | null;
  revision: number;
};
type Partner = {
  role: "OWNER" | "STAFF";
  allowedScopes: string[];
  id: string;
  businessId: string;
  displayName: string;
  status: string;
  revision: number;
  businessVerificationStatus: string;
  sites: Site[];
  integrations: Integration[];
};
const field =
  "min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2";
export default function ConnectPage() {
  const [partners, setPartners] = useState<Partner[]>([]),
    [businesses, setBusinesses] = useState<
      { id: string; displayName: string }[]
    >([]),
    [selected, setSelected] = useState("");
  const [integrationKind, setIntegrationKind] = useState<"API" | "FEED">("API"), [endpoint, setEndpoint] = useState("");
  const [syncReview, setSyncReview] = useState<string | null>(null);
  const [siteCommand, setSiteCommand] = useState<{ id: string; action: "challenge" | "revoke" } | null>(null);
  const [hostname, setHostname] = useState(""),
    [challenge, setChallenge] = useState<{
      recordName: string;
      value: string;
    } | null>(null),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [issued, setIssued] = useState("");
  const [siteId, setSiteId] = useState(""),
    [name, setName] = useState(""),
    [prefix, setPrefix] = useState("/products/");
  const reload = useCallback(async () => {
    const [p, b] = await Promise.all([
      api("/connect/partners"),
      api("/business/profiles"),
    ]);
    setPartners(p);
    setBusinesses(b);
    setSelected((old) => old || p[0]?.id || "");
  }, []);
  useEffect(() => {
    let active = true;
    reload()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const run = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await reload();
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر إتمام الطلب");
    } finally {
      setBusy(false);
    }
  };
  const partner = partners.find((p) => p.id === selected);
  return (
    <main
      dir="rtl"
      className="container-app max-w-3xl space-y-5 py-6"
      data-testid="connect-portal"
    >
      <h1 className="text-2xl font-bold">DINAR Connect — بوابة الشركاء</h1>
      <p>
        التسجيل والعرض العضوي والإحالة الأساسية مجانية؛ لا يلزم اشتراك DINAR
        Business. أي عمولة تتطلب اتفاقًا منفصلًا مقبولًا وتحويلًا موثّقًا. الربط
        لا يمنح إذنًا للشراء أو التسوية.
      </p>
      <Link href="/" className="underline">
        العودة إلى المحادثة
      </Link>
      {loading && <p role="status">جارٍ تحميل حسابات الشركاء…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-bold">تسجيل نشاط قائم</h2>
        {businesses.length === 0 ? (
          <p>
            أنشئ ملف نشاطك من المحادثة وأكمل التوثيق عبر المسار الموجود. لا ينشئ
            Connect هوية تجارية ثانية.
          </p>
        ) : (
          businesses.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-3">
              <span>{b.displayName}</span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const p = await api("/connect/partners", "POST", {
                      businessId: b.id,
                    });
                    setSelected(p.id);
                  }, "تم حفظ التسجيل المجاني؛ النشر يتطلب التوثيق والمراجعة.")
                }
                data-testid="connect-register"
              >
                تسجيل مجاني في Connect
              </Button>
            </div>
          ))
        )}
      </section>
      {partners.length > 0 && (
        <label className="block">
          النشاط المسجّل
          <select
            className={field}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setChallenge(null);
              setSiteCommand(null);
              setIssued("");
            }}
          >
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      {partner?.role === "STAFF" && <>
        <p role="status">وصول موظف للقراءة فقط؛ إدارة الربط والمفاتيح للمالك.</p>
        {partner.allowedScopes.includes("CATALOG_READ") && <ConnectReadOnlyCatalog key={`catalog-${partner.id}`} partnerId={partner.id} />}
        {partner.allowedScopes.includes("REPORTS_READ") && <ConnectDashboard key={`staff-report-${partner.id}`} partnerId={partner.id} />}
      </>}
      {partner?.role === "OWNER" && (
        <>
          <ConnectTeam key={`team-${partner.id}`} partnerId={partner.id} />
          <ConnectAgreements key={partner.id} partnerId={partner.id} />
          <ConnectDashboard
            key={`report-${partner.id}`}
            partnerId={partner.id}
          />
          <section className="space-y-3 rounded-xl border p-4">
            <h2 className="font-bold">حالة الحساب</h2>
            <p data-testid="connect-partner-status">
              {partner.status} — توثيق النشاط:{" "}
              {partner.businessVerificationStatus}
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api(`/connect/partners/${partner.id}/submit`, "POST", {}),
                  "أُرسل الحساب للمراجعة المستقلة.",
                )
              }
            >
              إرسال الحساب للمراجعة
            </Button>
          </section>
          <section className="space-y-3 rounded-xl border p-4">
            <h2 className="font-bold">إثبات ملكية موقعك</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const s = await api(
                    `/connect/partners/${partner.id}/sites`,
                    "POST",
                    { hostname },
                  );
                  setChallenge(s.challenge);
                  setHostname("");
                }, "أضف سجل TXT الظاهر أدناه ثم تحقق من الموقع.");
              }}
              className="space-y-3"
            >
              <label className="block">
                اسم المضيف
                <input
                  className={field}
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="shop.example.com"
                  dir="ltr"
                  required
                  maxLength={253}
                />
              </label>
              <Button type="submit" disabled={busy}>
                إنشاء تحدي الملكية
              </Button>
            </form>
            {challenge && (
              <div role="status" className="space-y-2 break-all">
                <p>أضف سجل DNS من نوع TXT خلال 15 دقيقة:</p>
                <code dir="ltr" className="block">
                  {challenge.recordName}
                </code>
                <code dir="ltr" className="block">
                  {challenge.value}
                </code>
              </div>
            )}
            {partner.sites.map((s) => (
              <div key={s.id} role="group" aria-label={`موقع ${s.hostname}`} className="flex flex-wrap items-center gap-3">
                <span dir="ltr" className="break-all">
                  {s.hostname} — {s.status}
                </span>
                <Button
                  variant="secondary"
                  disabled={busy || s.status === "REVOKED"}
                  onClick={() =>
                    void run(
                      () => api(`/connect/sites/${s.id}/verify`, "POST", {}),
                      "تحقق الخادم من سجل ملكية الموقع.",
                    )
                  }
                >
                  التحقق من TXT
                </Button>
                {s.status !== "REVOKED" && <>
                  <Button variant="secondary" disabled={busy} onClick={() => setSiteCommand({ id: s.id, action: "challenge" })}>تجديد تحدي TXT</Button>
                  <Button variant="danger-soft" disabled={busy} onClick={() => setSiteCommand({ id: s.id, action: "revoke" })}>إلغاء الموقع وروابطه</Button>
                  {siteCommand?.id === s.id && <div className="w-full space-y-2 rounded-lg border p-3">
                    <p>{siteCommand.action === "challenge" ? "سيصدر تحدي جديد ويلغى التحدي السابق. لا تمتد صلاحية إثبات الملكية حتى يتحقق الخادم من سجل TXT الجديد." : "سيُلغى الموقع وكل موصلاته ومفاتيحه. لا يمكن استئنافها؛ تُحفظ أدلة العقود والمحاسبة القائمة."}</p>
                    <Button variant={siteCommand.action === "revoke" ? "danger" : "primary"} disabled={busy} onClick={() => {
                      const action = siteCommand.action;
                      void run(async () => {
                        const result = await api(`/connect/sites/${s.id}/${action}`, "POST", { confirm: true });
                        setChallenge(action === "challenge" ? result.challenge : null); setSiteCommand(null);
                      }, action === "challenge" ? "صدر تحدي جديد؛ أضف TXT ثم تحقق منه." : "أُلغي الموقع وموصلاته ومفاتيحه مع حفظ الأدلة.");
                    }}>{siteCommand.action === "challenge" ? "تأكيد تجديد التحدي" : "تأكيد إلغاء الموقع وكل مفاتيحه"}</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setSiteCommand(null)}>تراجع</Button>
                  </div>}
                </>}
              </div>
            ))}
          </section>
          <section className="space-y-3 rounded-xl border p-4">
            <h2 className="font-bold">ربط كتالوج خارجي</h2>
            <p>
              هذا المسار يتيح إرسال كتالوج عبر API بعد مراجعة الهوية والموقع
              والصلاحيات. النمط محاكاة فقط. لا يشغّل شراءً أو خدمة مدفوعة.
            </p>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () =>
                    api(
                      `/connect/partners/${partner.id}/integrations`,
                      "POST",
                      {
                        siteId,
                        kind: integrationKind,
                        ...(endpoint.trim() ? { endpointUrl: endpoint.trim() } : {}),
                        name,
                        capabilities: [
                          "CATALOG_READ",
                          "CATALOG_IMPORT",
                          "EXTERNAL_REFERRAL",
                        ],
                        mode: "SIMULATION_ONLY",
                        allowedPathPrefixes: [prefix],
                      },
                    ),
                  "حُفظ الربط للمراجعة؛ لم يُفعّل تلقائيًا.",
                );
              }}
            >
              <label className="block">
                الموقع
                <select
                  required
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className={field}
                >
                  <option value="">اختر موقعًا موثّقًا</option>
                  {partner.sites
                    .filter((s) => s.status === "VERIFIED")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.hostname}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block">نوع المصدر<select className={field} value={integrationKind} onChange={e => setIntegrationKind(e.target.value as "API" | "FEED")}><option value="API">API — إرسال أو قراءة JSON</option><option value="FEED">تغذية JSON للقراءة</option></select></label>
              <label className="block">عنوان JSON للقراءة (اختياري عند إرسال API)<input className={field} type="url" dir="ltr" value={endpoint} required={integrationKind === "FEED"} maxLength={500} placeholder="https://shop.example.com/catalog.json" onChange={e => setEndpoint(e.target.value)} /></label>
              <label className="block">
                اسم الربط
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  className={field}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block">
                بادئة مسارات عروض الموقع
                <input
                  required
                  dir="ltr"
                  className={field}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                />
              </label>
              <Button disabled={busy} type="submit">
                مراجعة الربط وحفظه
              </Button>
            </form>
            {partner.integrations.map((i) => (
              <div key={i.id} className="space-y-2 rounded-lg border p-3">
                <h3>
                  {i.name} — {i.status}
                </h3>
                <p className="break-words">{i.capabilities.join("، ")}</p>
                <div className="flex flex-wrap gap-2">
                  {i.status === "APPROVED" && (
                    <>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const r = await api(
                              `/connect/integrations/${i.id}/credentials`,
                              "POST",
                              {},
                            );
                            setIssued(r.key);
                          }, "أُصدر مفتاح جديد وأُلغي السابق. احفظه الآن؛ لن يُعرض مجددًا.")
                        }
                      >
                        إصدار / تدوير المفتاح
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              api(
                                `/connect/integrations/${i.id}/suspend`,
                                "POST",
                                {},
                              ),
                            "عُلّق الربط وتوقفت عروضه وروابطه.",
                          )
                        }
                      >
                        تعليق الربط
                      </Button>
                    </>
                  )}
                  {i.status === "APPROVED" && ["FEED", "API"].includes(i.kind) && i.endpointUrl && <>
                    <Button variant="secondary" disabled={busy} aria-label={`مزامنة كتالوج ${i.name}`} onClick={() => setSyncReview(i.id)}>مراجعة مزامنة JSON</Button>
                    {syncReview === i.id && <div className="w-full space-y-2 rounded-lg border p-3"><p>سيقرأ DINAR دفعة JSON واحدة من المصدر المعتمد ويحدّث الكتالوج بعد فحص الصلاحيات والبيانات. لا ينفذ شراءً ولا يتبع روابط أخرى.</p><Button disabled={busy} onClick={() => void run(async () => {
                      await api(`/connect/integrations/${i.id}/sync`, "POST", { confirm: true, expectedRevision: i.revision }); setSyncReview(null);
                    }, "اكتملت مزامنة الدفعة من المصدر المعتمد.")}>تأكيد قراءة الكتالوج ومزامنته</Button><Button variant="secondary" disabled={busy} onClick={() => setSyncReview(null)}>تراجع عن المزامنة</Button></div>}
                  </>}
                  {i.status === "SUSPENDED" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api(
                              `/connect/integrations/${i.id}/resume`,
                              "POST",
                              {},
                            ),
                          "استؤنف الربط بعد فحص الاعتماد الحالي.",
                        )
                      }
                    >
                      استئناف
                    </Button>
                  )}
                  {i.status !== "REVOKED" && (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api(
                              `/connect/integrations/${i.id}/revoke`,
                              "POST",
                              {},
                            ),
                          "أُلغي الربط ومفاتيحه.",
                        )
                      }
                    >
                      إلغاء الربط ومفاتيحه
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {issued && (
              <div className="break-all rounded-lg border p-3">
                <p>مفتاح سري يظهر مرة واحدة. لا تشاركه في المحادثة.</p>
                <code dir="ltr">{issued}</code>
                <Button variant="secondary" onClick={() => setIssued("")}>
                  إخفاء المفتاح
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
