import { useState } from "react";
import { Check, CheckCircle2, Copy, Globe2, Link2, Mail, ShieldCheck, Sparkles, Zap } from "lucide-react";

type VerifyTab = "OAUTH" | "META" | "EMAIL";
type DetectedSite = { hostname: string; origin: string; platform: string; supportsOAuth: boolean; metaTag: string; domainEmail: string; catalogHint: string };

function detectAnySiteClient(raw: string): { ok: true; site: DetectedSite } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "ضع رابط موقعك أو متجرك أولًا." };
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(normalized);
    if (u.protocol !== "https:") return { ok: false, error: "يجب أن يبدأ الرابط بـ https://" };
    const host = u.hostname.toLowerCase();
    if (!host.includes(".") || host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return { ok: false, error: "أدخل رابط موقع عام صحيح (مثل mystore.com)." };
    const bare = host.replace(/^www\./, "");
    let platform = "موقع مخصص (قراءة تلقائية ذكية لـ JSON-LD / OpenGraph)";
    let supportsOAuth = false;
    let catalogHint = `${u.origin}/sitemap.xml`;
    if (host.endsWith(".salla.sa")) { platform = "سلة (Salla)"; supportsOAuth = true; catalogHint = `${u.origin}/api/v1/products`; }
    else if (host.endsWith(".zid.store")) { platform = "زد (Zid)"; supportsOAuth = true; catalogHint = `${u.origin}/api/v1/products`; }
    else if (host.endsWith(".myshopify.com")) { platform = "شوبيفاي (Shopify)"; supportsOAuth = true; catalogHint = `${u.origin}/products.json`; }
    const token = `jassim-verify-${bare.replace(/[^a-z0-9]/g, "").slice(0, 14)}`;
    return { ok: true, site: { hostname: host, origin: u.origin, platform, supportsOAuth, metaTag: `<meta name="jassim-connect-verification" content="${token}" />`, domainEmail: `info@${bare}`, catalogHint } };
  } catch { return { ok: false, error: "صيغة الرابط غير صالحة." }; }
}

export function ConnectUniversalWizard({ onConnect }: { onConnect?: (hostname: string, method: VerifyTab) => void }) {
  const [rawUrl, setRawUrl] = useState("");
  const [site, setSite] = useState<DetectedSite | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<VerifyTab>("META");
  const [copied, setCopied] = useState(false);

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault();
    const res = detectAnySiteClient(rawUrl);
    if (!res.ok) { setError(res.error); setSite(null); return; }
    setError("");
    setSite(res.site);
    setTab(res.site.supportsOAuth ? "OAUTH" : "META");
  };

  const copyTag = async () => {
    if (!site) return;
    try { await navigator.clipboard.writeText(site.metaTag); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };

  return (
    <section dir="rtl" aria-label="الربط السريع لأي موقع إلكتروني" data-testid="connect-universal-wizard" className="animate-fade space-y-4 rounded-2xl border border-amber-500/35 bg-card/95 p-4 shadow-sm backdrop-blur-sm sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-600/20 to-amber-500/25 text-amber-500"><Zap size={19} aria-hidden /></span>
          <div>
            <h2 className="text-base font-bold text-foreground">اربط أي موقع أو متجر خلال ثوانٍ</h2>
            <p className="text-xs text-muted-foreground">ضع رابط موقعك فقط — يدعم سلة، زد، شوبيفاي، ووكومرس، وأي موقع خاص تلقائيًا.</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/35 bg-amber-500/12 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300"><Sparkles size={12} aria-hidden /> بدون إعدادات تقنية</span>
      </header>
      <form onSubmit={handleAnalyze} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Link2 size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input type="text" dir="ltr" value={rawUrl} onChange={(e) => setRawUrl(e.target.value)} placeholder="https://your-store.com" aria-label="رابط موقعك أو متجرك" data-testid="input-universal-site-url" className="min-h-11 w-full rounded-xl border border-border bg-background pe-3 ps-9 text-sm text-foreground focus:border-amber-500 focus:outline-none" />
        </div>
        <button type="submit" data-testid="button-analyze-any-site" className="pressable inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-l from-amber-500 to-amber-400 px-5 text-xs font-bold text-slate-950 shadow-xs transition hover:brightness-105"><Globe2 size={15} aria-hidden /><span>ربط سريع الآن</span></button>
      </form>
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
      {site && (
        <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-3.5" data-testid="universal-site-ready">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-bold text-foreground"><CheckCircle2 size={16} className="text-emerald-500" aria-hidden /> جاهز للربط: <bdi dir="ltr">{site.hostname}</bdi></span>
            <span className="rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{site.platform}</span>
          </div>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="اختر أسهل طريقة لتأكيد الملكية">
            {site.supportsOAuth && <button type="button" role="tab" aria-selected={tab === "OAUTH"} onClick={() => setTab("OAUTH")} className={`pressable min-h-9 rounded-lg border px-3 text-xs font-semibold ${tab === "OAUTH" ? "border-amber-500 bg-amber-500/15 text-foreground" : "border-border bg-background/70 text-muted-foreground"}`}>1. موافقة بضغطة زر (5 ثوانٍ)</button>}
            <button type="button" role="tab" aria-selected={tab === "META"} onClick={() => setTab("META")} className={`pressable min-h-9 rounded-lg border px-3 text-xs font-semibold ${tab === "META" ? "border-amber-500 bg-amber-500/15 text-foreground" : "border-border bg-background/70 text-muted-foreground"}`}>سطر تحقق واحد</button>
            <button type="button" role="tab" aria-selected={tab === "EMAIL"} onClick={() => setTab("EMAIL")} className={`pressable min-h-9 rounded-lg border px-3 text-xs font-semibold ${tab === "EMAIL" ? "border-amber-500 bg-amber-500/15 text-foreground" : "border-border bg-background/70 text-muted-foreground"}`}>بريد النطاق الرسمي</button>
          </div>
          {tab === "OAUTH" && (
            <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-3 text-xs">
              <p className="text-foreground">اضغط الزر بالأسفل لتسجيل الدخول في <strong>{site.platform}</strong> والموافقة على ربط منتجاتك تلقائيًا بدون نسخ أي أكواد.</p>
              <button type="button" onClick={() => onConnect?.(site.hostname, "OAUTH")} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground"><Zap size={14} aria-hidden /><span>منح الصلاحية الآن بضغطة زر</span></button>
            </div>
          )}
          {tab === "META" && (
            <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-3 text-xs">
              <p className="text-muted-foreground">انسخ هذا السطر وضعه في ترويسة موقعك (<code dir="ltr">&lt;head&gt;</code>) ثم اضغط «تحقق الآن»:</p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-2">
                <code className="flex-1 overflow-x-auto font-mono text-[11px] text-foreground" dir="ltr">{site.metaTag}</code>
                <button type="button" onClick={() => void copyTag()} aria-label="نسخ وسم التحقق" className="pressable inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold">{copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}<span>{copied ? "نُسخ" : "نسخ"}</span></button>
              </div>
              <button type="button" onClick={() => onConnect?.(site.hostname, "META")} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground"><CheckCircle2 size={14} aria-hidden /><span>تحقق الآن وافتح المتجر</span></button>
            </div>
          )}
          {tab === "EMAIL" && (
            <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-3 text-xs">
              <p className="text-muted-foreground">سنرسل رابط تفعيل سريع إلى بريد نطاق موقعك الرسمي <strong dir="ltr">{site.domainEmail}</strong> لتأكيد الملكية فورًا:</p>
              <button type="button" onClick={() => onConnect?.(site.hostname, "EMAIL")} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground"><Mail size={14} aria-hidden /><span>إرسال رابط التفعيل السريع</span></button>
            </div>
          )}
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck size={13} className="text-emerald-500" aria-hidden /> مسار القراءة المقترح: <bdi dir="ltr" className="font-mono">{site.catalogHint}</bdi></p>
        </div>
      )}
    </section>
  );
}
