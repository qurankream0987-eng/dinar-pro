import { useState } from "react";
import { CheckCircle2, Globe2, Link2, ShieldCheck, Sparkles } from "lucide-react";

type QuickDetect = { hostname: string; platform: string; catalogEndpoint: string; verifyTag: string };

function quickDetectClientUrl(raw: string): { ok: true; data: QuickDetect } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "أدخل رابط متجرك أولًا." };
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(normalized);
    if (u.protocol !== "https:") return { ok: false, error: "يلزم رابط آمن يبدأ بـ https://" };
    const host = u.hostname.toLowerCase();
    if (!host.includes(".") || host === "localhost" || /^(127\.|10\.|192\.168\.)/.test(host)) {
      return { ok: false, error: "أدخل نطاق متجر عام صحيح (مثل mystore.com)." };
    }
    let platform = "متجر ويب مخصص (Auto-Detect)";
    let catalogEndpoint = `${u.origin}/api/products`;
    if (host.endsWith(".salla.sa")) { platform = "سلة (Salla)"; catalogEndpoint = `${u.origin}/api/v1/products`; }
    else if (host.endsWith(".zid.store")) { platform = "زد (Zid)"; catalogEndpoint = `${u.origin}/api/v1/products`; }
    else if (host.endsWith(".myshopify.com")) { platform = "شوبيفاي (Shopify)"; catalogEndpoint = `${u.origin}/products.json`; }
    return { ok: true, data: { hostname: host, platform, catalogEndpoint, verifyTag: `<meta name="jassim-connect-verification" content="jassim-verify-${host.replace(/[^a-z0-9]/g, "").slice(0, 12)}" />` } };
  } catch {
    return { ok: false, error: "صيغة الرابط غير صالحة." };
  }
}

export function ConnectUrlQuickCard({ onSubmitUrl }: { onSubmitUrl?: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const [detected, setDetected] = useState<QuickDetect | null>(null);
  const [error, setError] = useState("");

  const inspect = (e: React.FormEvent) => {
    e.preventDefault();
    const res = quickDetectClientUrl(url);
    if (!res.ok) { setError(res.error); setDetected(null); return; }
    setError("");
    setDetected(res.data);
  };

  return (
    <section dir="rtl" aria-label="ربط متجرك بالرابط مباشرة" data-testid="connect-url-quick-card" className="animate-fade w-full max-w-[500px] space-y-3 rounded-2xl border border-amber-500/30 bg-card/95 p-4 shadow-sm backdrop-blur-sm">
      <header className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-600/20 to-amber-500/20 text-amber-500"><Link2 size={18} aria-hidden /></span>
        <div>
          <h3 className="text-sm font-bold text-foreground">اربط متجرك بوضع الرابط فقط</h3>
          <p className="text-xs text-muted-foreground">ضع رابط متجرك (سلة، زد، شوبيفاي، أو موقعك الخاص) وسيتعرف عليه جاسم تلقائيًا.</p>
        </div>
      </header>
      <form onSubmit={inspect} className="flex flex-col gap-2 sm:flex-row">
        <input type="text" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mystore.salla.sa" aria-label="رابط متجرك الإلكتروني" data-testid="input-connect-store-url" className="min-h-11 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:border-amber-500 focus:outline-none" />
        <button type="submit" data-testid="button-detect-store-url" className="pressable inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-l from-amber-500 to-amber-400 px-4 text-xs font-bold text-slate-950 shadow-xs">
          <Sparkles size={14} aria-hidden /><span>فحص وتعرّف تلقائي</span>
        </button>
      </form>
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
      {detected && (
        <div className="space-y-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-3 text-xs" data-testid="connect-url-detected">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-bold text-foreground"><CheckCircle2 size={15} className="text-emerald-500" aria-hidden /> تم التعرّف على المتجر</span>
            <span className="rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{detected.platform}</span>
          </div>
          <dl className="space-y-1 text-[11.5px]">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">النطاق:</dt><dd className="font-mono font-semibold" dir="ltr">{detected.hostname}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">مسار الكتالوج المقترح:</dt><dd className="truncate font-mono" dir="ltr">{detected.catalogEndpoint}</dd></div>
          </dl>
          <div className="rounded-lg border border-border/70 bg-background/80 p-2 font-mono text-[10.5px] text-muted-foreground" dir="ltr">{detected.verifyTag}</div>
          <button type="button" onClick={() => onSubmitUrl?.(detected.hostname)} data-testid="button-confirm-connect-url" className="pressable flex min-h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground">
            <Globe2 size={14} aria-hidden /><span>اعتماد ومتابعة التحقق من الملكية</span>
          </button>
          <p className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground"><ShieldCheck size={12} className="text-emerald-500" aria-hidden /> لا يُسحب أي منتج ولا تُفعّل أي عمولة قبل موافقتك الصريحة.</p>
        </div>
      )}
    </section>
  );
}
