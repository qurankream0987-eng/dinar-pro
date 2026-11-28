import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { ConnectAgreements } from "@/features/ConnectAgreements";
import { CONNECT_MCP_CATALOG_TOOL, CONNECT_MCP_CATALOG_INPUT_SHA256, ConnectCatalogReceiptSchema, CONNECT_PARTICIPATION_MODES, CONNECT_PARTICIPATION_MODE_LABELS, type ConnectParticipationMode } from "@workspace/api-zod/connect-platform";
import { ConnectOAuthControls } from "@/features/ConnectOAuthControls";
import { ConnectTeam, ConnectReadOnlyCatalog } from "@/features/ConnectTeam";
import { ConnectDiagnosticsPanel } from "@/features/ConnectDiagnostics";
import { ConnectDashboard } from "@/features/ConnectDashboard";
import { ConnectCardSandbox } from "@/features/ConnectCardSandbox";
import { ConnectUniversalWizard } from "@/features/ConnectUniversalWizard";
type Site = { id: string; hostname: string; status: string };
type Integration = {
  id: string;
  name: string;
  status: string;
  kind: string;
  capabilities: string[];
  endpointUrl: string | null;
  config?: { oauth?: unknown };
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
  participationMode?: ConnectParticipationMode;
  participationModeChangedAt?: string | null;
  participation?: {
    externalPurchase: Capability;
    internalSale: Capability;
    nativeCatalogCheckout: Capability;
  };
};
type Capability = { included?: boolean; enabled: boolean; requirements: string[] };
/** What each mode means, in the merchant's words; the server decides what is actually enabled. */
const MODE_EXPLANATIONS: Record<ConnectParticipationMode, string> = {
  SELL_INSIDE_DINAR:
    "تعرض منتجاتك كإعلانات جاسم، ويتم الطلب والدفع داخل جاسم (الدفع حاليًا محاكاة). يتطلب توثيق النشاط واعتماد الحساب.",
  BUY_ON_MERCHANT_WEBSITE:
    "تظهر منتجات موقعك في جاسم، ويُكمل المشتري الشراء في موقعك. يتطلب إثبات ملكية الموقع وموصل كتالوج معتمد. النقرة ليست بيعًا ولا تُحتسب عمولة إلا باتفاق مقبول وتحويل موثّق.",
  HYBRID:
    "تجمع الطريقتين: إعلانات داخل جاسم وعروض تُشترى من موقعك. لكل طريقة متطلباتها، وتُفعّل كل واحدة وحدها عند استيفائها.",
};
function ModeChoice({ value, onChange, name }: { value: ConnectParticipationMode; onChange: (mode: ConnectParticipationMode) => void; name: string }) {
  return (
    <fieldset className="space-y-2" data-testid={`connect-mode-choice-${name}`}>
      <legend className="font-semibold">طريقة المشاركة في جاسم Connect</legend>
      {CONNECT_PARTICIPATION_MODES.map((mode) => (
        <label key={mode} className="pressable flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-border/85 bg-card/90 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition has-[:checked]:border-amber-400/80 has-[:checked]:bg-amber-500/10 has-[:checked]:ring-1 has-[:checked]:ring-amber-400/30">
          <input
            type="radio"
            name={name}
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
            className="mt-1 size-4 shrink-0"
            data-testid={`connect-mode-${mode}`}
          />
          <span className="min-w-0">
            <span className="block font-medium">{CONNECT_PARTICIPATION_MODE_LABELS[mode]}</span>
            <span className="block text-sm text-muted-foreground">{MODE_EXPLANATIONS[mode]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
function CapabilityLine({ label, capability, testId }: { label: string; capability: Capability; testId: string }) {
  return (
    <li data-testid={testId} data-enabled={capability.enabled ? "true" : "false"} className="space-y-1">
      <span className="font-medium">{label}: </span>
      <span>{capability.enabled ? "مفعّل" : capability.included === false ? "غير مشمول في وضعك" : "غير مفعّل بعد"}</span>
      {!capability.enabled && capability.requirements.length > 0 && (
        <ul className="list-disc ps-5 text-sm text-muted-foreground">
          {capability.requirements.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </li>
  );
}
const field =
  "min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2";
export default function ConnectPage() {
  const [partners, setPartners] = useState<Partner[]>([]),
    [businesses, setBusinesses] = useState<
      { id: string; displayName: string }[]
    >([]),
    [selected, setSelected] = useState("");
  const [registrationMode, setRegistrationMode] = useState<ConnectParticipationMode>("BUY_ON_MERCHANT_WEBSITE");
  const [modeDraft, setModeDraft] = useState<ConnectParticipationMode | null>(null);
  const [integrationKind, setIntegrationKind] = useState<"API" | "FEED" | "OAUTH" | "MCP" | "WEBSITE">("API"), [endpoint, setEndpoint] = useState("");
  const [websiteCategoryId, setWebsiteCategoryId] = useState(""), [categories, setCategories] = useState<{ id: string; label: string }[]>([]);
  const [mcpOAuth, setMcpOAuth] = useState(false);
  const [oauthClientId, setOAuthClientId] = useState(""), [oauthAuthorize, setOAuthAuthorize] = useState(""), [oauthToken, setOAuthToken] = useState("");
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
    const [p, b, c] = await Promise.all([
      api("/connect/partners"),
      api("/business/profiles"),
      api("/categories"),
    ]);
    setPartners(p);
    setBusinesses(b);
    setCategories(c);
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
  const run = async <T,>(work: () => Promise<T>, success: string | ((value: T) => string)) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await work();
      await reload();
      setMessage(typeof success === "function" ? success(result) : success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر إتمام الطلب");
    } finally {
      setBusy(false);
    }
  };
  const partner = partners.find((p) => p.id === selected);
  const useOAuth = integrationKind === "OAUTH" || (integrationKind === "MCP" && mcpOAuth);
  return (
    <main
      dir="rtl"
      className="container-app max-w-3xl space-y-5 py-6"
      data-testid="connect-portal"
    >
      <h1 className="text-2xl font-bold">جاسم Connect — بوابة الشركاء</h1>
      <p>
        التسجيل والعرض العضوي والإحالة الأساسية مجانية؛ لا يلزم اشتراك جاسم
        Business. أي عمولة تتطلب اتفاقًا منفصلًا مقبولًا وتحويلًا موثّقًا. الربط
        لا يمنح إذنًا للشراء أو التسوية.
      </p>
      <ol aria-label="خطوات الربط في جاسم كونيكت" data-testid="connect-onboarding-stepper" className="grid grid-cols-2 gap-2.5 rounded-2xl border border-amber-400/30 bg-card/95 p-3.5 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_12px_28px_-14px_rgba(0,0,0,0.22)] sm:grid-cols-4">
        {[
          { step: "1", title: "الربط السريع", desc: "أضف رابط متجرك أو اختر منصتك" },
          { step: "2", title: "التحقق من الملكية", desc: "تلقائي OAuth أو وسم أو DNS" },
          { step: "3", title: "معاينة البطاقة", desc: "اختبر بطاقة متجرك داخل المحادثة" },
          { step: "4", title: "التفعيل المباشر", desc: "مزامنة الكتالوج والبيع الفوري" },
        ].map((item) => (
          <li key={item.step} className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/30 p-2.5">
            <span className="num grid size-6 shrink-0 place-items-center rounded-full border border-amber-400/45 bg-amber-500/15 text-[11px] font-extrabold text-amber-600 dark:text-amber-300">
              {item.step}
            </span>
            <div className="min-w-0">
              <p className="font-bold text-foreground">{item.title}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{item.desc}</p>
            </div>
          </li>
        ))}
      </ol>
      <ConnectUniversalWizard />
      <ConnectCardSandbox />
      <Link href="/" className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline">
        العودة إلى المحادثة
      </Link>
      {loading && <p role="status">جارٍ تحميل حسابات الشركاء…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="space-y-3 rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_12px_28px_-14px_rgba(0,0,0,0.18)] md:p-5">
        <h2 className="font-bold">تسجيل نشاط قائم</h2>
        {businesses.length === 0 ? (
          <p>
            أنشئ ملف نشاطك من المحادثة وأكمل التوثيق عبر المسار الموجود. لا ينشئ
            Connect هوية تجارية ثانية.
          </p>
        ) : (
          <>
          <ModeChoice name="register" value={registrationMode} onChange={setRegistrationMode} />
          {businesses.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-3">
              <span>{b.displayName}</span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const p = await api("/connect/partners", "POST", {
                      businessId: b.id,
                      participationMode: registrationMode,
                    });
                    setSelected(p.id);
                  }, "تم حفظ التسجيل المجاني؛ النشر يتطلب التوثيق والمراجعة.")
                }
                data-testid="connect-register"
              >
                تسجيل مجاني في Connect
              </Button>
            </div>
          ))}
          </>
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
          <ConnectReadOnlyCatalog key={`owner-catalog-${partner.id}-${message}`} partnerId={partner.id} />
          <ConnectTeam key={`team-${partner.id}`} partnerId={partner.id} />
          <ConnectDiagnosticsPanel key={`diagnostics-${partner.id}`} partnerId={partner.id} />
          <ConnectAgreements key={partner.id} partnerId={partner.id} />
          <ConnectDashboard
            key={`report-${partner.id}`}
            partnerId={partner.id}
          />
          <section className="space-y-3 rounded-xl border p-4" data-testid="connect-mode-panel">
            <h2 className="font-bold">وضع المشاركة</h2>
            <p data-testid="connect-mode-current" data-mode={partner.participationMode}>
              الوضع الحالي: {partner.participationMode ? CONNECT_PARTICIPATION_MODE_LABELS[partner.participationMode] : "غير معروف"}
            </p>
            {partner.participation && (
              <ul className="space-y-2" aria-label="ما يتيحه وضعك الآن">
                <CapabilityLine label="الشراء من موقعك" capability={partner.participation.externalPurchase} testId="connect-cap-external" />
                <CapabilityLine label="البيع داخل جاسم" capability={partner.participation.internalSale} testId="connect-cap-internal" />
                <CapabilityLine label="الدفع داخل جاسم لمنتجات موقعك" capability={partner.participation.nativeCatalogCheckout} testId="connect-cap-native" />
              </ul>
            )}
            {["SUSPENDED", "REVOKED", "REJECTED"].includes(partner.status) ? (
              <p role="status">لا يمكن تغيير وضع المشاركة لحساب موقوف أو ملغى أو مرفوض.</p>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const mode = modeDraft ?? partner.participationMode;
                  if (!mode) return;
                  void run(
                    () => api(`/connect/partners/${partner.id}/participation-mode`, "POST", { mode, expectedRevision: partner.revision }),
                    "حُفظ وضع المشاركة. لم يُحذف أي طلب أو اتفاق أو التزام مالي.",
                  ).then(() => setModeDraft(null));
                }}
              >
                <ModeChoice name={`change-${partner.id}`} value={modeDraft ?? partner.participationMode ?? "BUY_ON_MERCHANT_WEBSITE"} onChange={setModeDraft} />
                <Button type="submit" disabled={busy || !modeDraft || modeDraft === partner.participationMode} data-testid="connect-mode-save">
                  حفظ وضع المشاركة
                </Button>
              </form>
            )}
          </section>
          <section className="space-y-3 rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_12px_28px_-14px_rgba(0,0,0,0.18)] md:p-5">
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
          <section className="space-y-3 rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_12px_28px_-14px_rgba(0,0,0,0.18)] md:p-5">
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
          <section className="space-y-3 rounded-2xl border border-border/85 bg-card/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_12px_28px_-14px_rgba(0,0,0,0.18)] md:p-5">
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
                        ...(integrationKind === "WEBSITE" ? { websiteCategoryId } : {}),
                        ...(integrationKind === "MCP" ? { reviewedTools: [{ name: CONNECT_MCP_CATALOG_TOOL, inputSchemaSha256: CONNECT_MCP_CATALOG_INPUT_SHA256, readOnly: true, capability: "CATALOG_READ" }] } : {}),
                        ...(useOAuth ? { oauth: { clientId: oauthClientId, authorizationEndpoint: oauthAuthorize, tokenEndpoint: oauthToken, scopes: ["catalog.read"] } } : {}),
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
              <label className="block">نوع المصدر<select className={field} value={integrationKind} onChange={e => setIntegrationKind(e.target.value as "API" | "FEED" | "OAUTH" | "MCP" | "WEBSITE")}><option value="API">API — إرسال أو قراءة JSON</option><option value="FEED">تغذية JSON للقراءة</option><option value="OAUTH">حساب OAuth عام للقراءة — PKCE</option><option value="MCP">MCP — لقطة كتالوج مراجعة للقراءة</option><option value="WEBSITE">صفحة موقع — بيانات منتجات وخدمات منظمة</option></select></label>
              <label className="block">{integrationKind === "WEBSITE" ? "عنوان صفحة HTML للفحص" : integrationKind === "MCP" ? "عنوان خادم MCP للقراءة" : "عنوان JSON للقراءة (اختياري عند إرسال API)"}<input className={field} type="url" dir="ltr" value={endpoint} required={integrationKind !== "API"} maxLength={500} placeholder="https://shop.example.com/catalog.json" onChange={e => setEndpoint(e.target.value)} /></label>
              {integrationKind === "WEBSITE" && <fieldset className="space-y-3 rounded-lg border p-3"><legend>فهرسة صفحة مصرح بها</legend><p>يقرأ جاسم صفحة واحدة من موقعك وبيانات Product/Service المنظمة فقط؛ لا ينفذ JavaScript ولا يتبع الروابط. اختر التصنيف صراحةً. تخفى عناصر هذا المصدر التي لا يعود الفحص يثبتها، مع حفظ تاريخها.</p><label className="block">تصنيف عناصر الصفحة<select className={field} required value={websiteCategoryId} onChange={e => setWebsiteCategoryId(e.target.value)}><option value="">اختر تصنيفًا للمراجعة</option>{categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label></fieldset>}
              {integrationKind === "MCP" && <fieldset className="space-y-2 rounded-lg border p-3"><legend>كتالوج MCP للقراءة فقط</legend><p>يلزم دعم العملية catalog.read_snapshot دون مدخلات، مع بيانات كتالوج منظمة ومراجعة مستقلة. لا يستورد جاسم تعليمات المزوّد أو أدوات الشراء والدفع.</p><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={mcpOAuth} onChange={e => setMcpOAuth(e.target.checked)} />هذا المصدر يتطلب تفويض حساب قراءة عبر OAuth</label></fieldset>}
              {useOAuth && <fieldset className="space-y-3 rounded-lg border p-3"><legend>إعدادات عميل عام للقراءة فقط</legend><p>يلزم أن تدعم الشركة نطاق catalog.read وPKCE. هذه المرحلة لا تدعم أسرار العملاء أو صلاحيات الدفع. يجب تسجيل رابط عودة جاسم المعتمد لدى المزوّد.</p><label className="block">معرّف العميل العام<input className={field} required maxLength={200} dir="ltr" value={oauthClientId} onChange={e => setOAuthClientId(e.target.value)} /></label><label className="block">عنوان التفويض HTTPS<input className={field} type="url" required dir="ltr" value={oauthAuthorize} onChange={e => setOAuthAuthorize(e.target.value)} /></label><label className="block">عنوان تبادل رمز القراءة HTTPS<input className={field} type="url" required dir="ltr" value={oauthToken} onChange={e => setOAuthToken(e.target.value)} /></label></fieldset>}
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
                {(i.kind === "OAUTH" || Boolean(i.config?.oauth)) && i.status === "APPROVED" && i.endpointUrl && <ConnectOAuthControls integrationId={i.id} revision={i.revision} endpoint={i.endpointUrl} />}
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
                  {i.status === "APPROVED" && ["FEED", "API", "OAUTH", "MCP", "WEBSITE"].includes(i.kind) && i.endpointUrl && <>
                    <Button variant="secondary" disabled={busy} aria-label={`مزامنة كتالوج ${i.name}`} onClick={() => setSyncReview(i.id)}>مراجعة مزامنة الكتالوج</Button>
                    {syncReview === i.id && <div className="w-full space-y-2 rounded-lg border p-3"><p>سيقرأ جاسم المصدر المعتمد ويحدّث الكتالوج بعد فحص الصلاحيات والبيانات. فهرسة الموقع تفحص صفحة واحدة وتخفي عناصر المصدر الغائبة دون محو تاريخها. لا ينفذ شراءً ولا يتبع روابط أخرى.</p><Button disabled={busy} onClick={() => void run(async () => {
                      const receipt = ConnectCatalogReceiptSchema.parse(await api(`/connect/integrations/${i.id}/sync`, "POST", { confirm: true, expectedRevision: i.revision })); setSyncReview(null); return receipt;
                    }, receipt => receipt.websiteStatus === "NO_VERIFIABLE_DATA" ? "لم يعثر هذا الفحص على بيانات قابلة للتحقق؛ أُخفي العرض السابق لهذا المصدر مع حفظ تاريخه." : "اكتملت مزامنة الدفعة من المصدر المعتمد.")}>تأكيد قراءة الكتالوج ومزامنته</Button><Button variant="secondary" disabled={busy} onClick={() => setSyncReview(null)}>تراجع عن المزامنة</Button></div>}
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
