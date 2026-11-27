/**
 * Connect-06 — Live Merchant Card Sandbox Preview inside Connect Partner Portal.
 * Lets merchants test one-click platform presets (Salla, Zid, Shopify, WooCommerce) and
 * preview how their store card will appear inside a JassimAI conversation before going live.
 */
import { useState } from "react";
import { CheckCircle2, Eye, Sparkles, Store } from "lucide-react";

type PresetKey = "SALLA" | "ZID" | "SHOPIFY" | "WOOCOMMERCE";

const PRESETS: Record<PresetKey, { label: string; itemsPointer: string; titlePointer: string; pricePointer: string; sampleTitle: string; sampleSubtitle: string }> = {
  SALLA: { label: "سلة (Salla)", itemsPointer: "/data", titlePointer: "/name", pricePointer: "/price/amount", sampleTitle: "قهوة عربية مختصة — 500 جم", sampleSubtitle: "مربوط تلقائيًا بقالب سلة الجاهز" },
  ZID: { label: "زد (Zid)", itemsPointer: "/results", titlePointer: "/name/ar", pricePointer: "/price", sampleTitle: "عطر عود ملكي فاخر", sampleSubtitle: "مربوط تلقائيًا بقالب زد الجاهز" },
  SHOPIFY: { label: "Shopify", itemsPointer: "/products", titlePointer: "/title", pricePointer: "/variants/0/price", sampleTitle: "ساعة ذكية رياضية تيتانيوم", sampleSubtitle: "مربوط تلقائيًا بقالب شوبيفاي" },
  WOOCOMMERCE: { label: "WooCommerce", itemsPointer: "/", titlePointer: "/name", pricePointer: "/price", sampleTitle: "حذاء رياضي خفيف للجري", sampleSubtitle: "مربوط تلقائيًا بقالب ووكومرس" },
};

export function ConnectCardSandbox({ merchantName = "متجرك التجريبي" }: { merchantName?: string }) {
  const [preset, setPreset] = useState<PresetKey>("SALLA");
  const active = PRESETS[preset];

  return (
    <section dir="rtl" aria-label="معاينة متجرك داخل محادثة تجريبية" data-testid="connect-card-sandbox" className="space-y-3 rounded-2xl border border-amber-500/25 bg-card/95 p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-xl bg-amber-500/15 text-amber-500">
            <Eye size={16} aria-hidden />
          </span>
          <div>
            <h2 className="text-sm font-bold text-foreground">معاينة متجرك داخل محادثة تجريبية (Sandbox)</h2>
            <p className="text-xs text-muted-foreground">اختر منصة متجرك لمعاينة الربط التلقائي وشكل بطاقتك قبل النشر.</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
          <Sparkles size={11} aria-hidden />
          ربط بضغطة زر
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="اختر منصة المتجر">
        {(Object.keys(PRESETS) as PresetKey[]).map((key) => {
          const selected = preset === key;
          return (
            <button key={key} type="button" role="radio" aria-checked={selected} onClick={() => setPreset(key)} data-testid={`sandbox-preset-${key}`} className={`pressable min-h-10 rounded-xl border px-3 text-xs font-semibold transition ${selected ? "border-amber-500/60 bg-amber-500/12 text-foreground ring-1 ring-amber-500/25" : "border-border/80 bg-background/70 text-muted-foreground hover:bg-muted/60"}`}>
              {PRESETS[key].label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border/70 bg-muted/30 p-3 text-xs">
          <p className="font-semibold text-foreground">خريطة الحقول التلقائية (RFC 6901)</p>
          <dl className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground" dir="ltr">
            <div className="flex justify-between"><span>items:</span><span className="text-foreground">{active.itemsPointer}</span></div>
            <div className="flex justify-between"><span>title:</span><span className="text-foreground">{active.titlePointer}</span></div>
            <div className="flex justify-between"><span>price:</span><span className="text-foreground">{active.pricePointer}</span></div>
          </dl>
        </div>

        <div className="overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-b from-[#0a2347] to-[#08172e] p-3 text-white shadow-sm">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
            <span className="flex items-center gap-1.5 text-xs font-bold">
              <Store size={14} className="text-amber-400" aria-hidden />
              {merchantName}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
              <CheckCircle2 size={10} aria-hidden />
              متجر موثّق
            </span>
          </div>
          <p className="mt-2 text-sm font-bold">{active.sampleTitle}</p>
          <p className="mt-0.5 text-[11px] text-blue-100/75">{active.sampleSubtitle}</p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-amber-300">السعر من نظام التاجر</span>
            <span className="rounded-lg bg-amber-400 px-3 py-1 text-[11px] font-bold text-slate-950">معاينة البطاقة</span>
          </div>
        </div>
      </div>
    </section>
  );
}
