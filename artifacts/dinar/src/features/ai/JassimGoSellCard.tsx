import { memo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { BarChart3, CheckCircle2, Eye, Megaphone, ShieldCheck, Sparkles, Target, TrendingUp } from "lucide-react";

type GoSellTab = "MANDATE" | "OPPORTUNITIES" | "PREVIEW" | "ANALYTICS";
export interface GoSellOpportunityView { listingId: string; title: string; placementLabel: string; rationaleAr: string; demandBadge?: string | null; }
export interface JassimGoSellCardProps { merchantName: string; budgetLabel: string; durationLabel: string; opportunities: GoSellOpportunityView[]; adHeadline: string; adBody: string; analytics?: { impressions: number; clicks: number; ctrLabel: string; attributedOrders: number }; onApproveMandate?: () => void; }

const SPRING = { type: "spring" as const, stiffness: 360, damping: 30, mass: 0.8 };
const TABS: { id: GoSellTab; label: string; icon: typeof Sparkles }[] = [
  { id: "MANDATE", label: "حدود التفويض", icon: ShieldCheck },
  { id: "OPPORTUNITIES", label: "الفرص", icon: Target },
  { id: "PREVIEW", label: "معاينة الإعلان", icon: Eye },
  { id: "ANALYTICS", label: "النتائج", icon: BarChart3 },
];

export const JassimGoSellCard = memo(function JassimGoSellCard({ merchantName, budgetLabel, durationLabel, opportunities, adHeadline, adBody, analytics = { impressions: 0, clicks: 0, ctrLabel: "0%", attributedOrders: 0 }, onApproveMandate }: JassimGoSellCardProps) {
  const [tab, setTab] = useState<GoSellTab>("MANDATE");
  const [enabledPlacements, setEnabledPlacements] = useState<string[]>(["FEATURED", "SPONSORED_SEARCH", "DEMAND_MATCH"]);
  const reduced = useReducedMotion();
  const togglePlacement = (key: string) => setEnabledPlacements((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <motion.section dir="rtl" initial={reduced ? false : { opacity: 0, y: 10, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING} aria-label="جاسم روح بيع لي — مدير التسويق الذكي" data-testid="jassim-go-sell-card" className="w-full max-w-[500px] overflow-hidden rounded-2xl border border-amber-500/35 bg-card/95 shadow-lg [contain:layout_paint]">
      <header className="flex items-center justify-between gap-2 border-b border-amber-400/25 bg-gradient-to-l from-[#071830] via-[#0f3063] to-[#081d3b] px-4 py-3 text-white">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-amber-400/35 bg-amber-500/20 text-amber-300"><Megaphone size={17} aria-hidden /></span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold">جاسم روح بيع لي · Jassim Ads</h3>
            <p className="truncate text-[11px] text-blue-100/80">{merchantName}</p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300"><Sparkles size={11} aria-hidden /> تفويض ذكي</span>
      </header>
      <div className="border-b border-border/60 bg-muted/30 px-3 py-2">
        <div className="grid grid-cols-4 gap-1" role="tablist" aria-label="أقسام حملة جاسم روح بيع لي">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button key={id} type="button" role="tab" aria-selected={active} onClick={() => setTab(id)} data-testid={`gosell-tab-${id}`} className={`relative flex min-h-10 items-center justify-center gap-1 rounded-xl px-2 text-[11.5px] font-semibold transition-colors ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {active && <motion.span layoutId="gosell-active-pill" transition={reduced ? { duration: 0 } : SPRING} className="absolute inset-0 rounded-xl border border-amber-500/45 bg-card shadow-xs" />}
                <Icon size={13} className={`relative z-10 shrink-0 ${active ? "text-amber-500" : ""}`} aria-hidden />
                <span className="relative z-10 truncate">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="p-4">
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="space-y-3">
            {tab === "MANDATE" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-border/70 bg-muted/30 p-3"><p className="text-[11px] text-muted-foreground">الحد الأقصى للميزانية</p><p className="mt-0.5 text-sm font-bold tabular-nums text-foreground"><bdi dir="ltr">{budgetLabel}</bdi></p></div>
                  <div className="rounded-xl border border-border/70 bg-muted/30 p-3"><p className="text-[11px] text-muted-foreground">مدة التفويض</p><p className="mt-0.5 text-sm font-bold text-foreground">{durationLabel}</p></div>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">القنوات المسموح لجاسم باستخدامها:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[{ id: "FEATURED", label: "إعلان مميز" }, { id: "SPONSORED_SEARCH", label: "نتائج البحث الممولة" }, { id: "DEMAND_MATCH", label: "مطابقة الطلبات (روح بيع لي)" }, { id: "VIP_BANNER", label: "بانر VIP" }].map((p) => {
                      const on = enabledPlacements.includes(p.id);
                      return <button key={p.id} type="button" aria-pressed={on} onClick={() => togglePlacement(p.id)} className={`pressable inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${on ? "border-amber-500/60 bg-amber-500/12 font-semibold text-foreground" : "border-border/80 bg-background/70 text-muted-foreground"}`}>{on && <CheckCircle2 size={13} className="text-amber-500" aria-hidden />}<span>{p.label}</span></button>;
                    })}
                  </div>
                </div>
                <p className="flex items-start gap-1.5 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-[11.5px] leading-relaxed text-foreground"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden /><span>لن ينفق جاسم أي مبلغ أو يطلق حملة خارج هذا التفويض، ولا تُكشف هوية أي مشترٍ أبدًا (عتبة الخصوصية ≥ 10).</span></p>
              </>
            )}
            {tab === "OPPORTUNITIES" && (
              <div className="space-y-2">
                {opportunities.map((opp) => (
                  <div key={opp.listingId} className="rounded-xl border border-border/70 bg-muted/25 p-3">
                    <div className="flex items-center justify-between gap-2"><p className="text-xs font-bold text-foreground">{opp.title}</p><span className="rounded-full border border-amber-500/35 bg-amber-500/12 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">{opp.placementLabel}</span></div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{opp.rationaleAr}</p>
                    {opp.demandBadge && <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300"><TrendingUp size={11} aria-hidden /> {opp.demandBadge}</p>}
                  </div>
                ))}
              </div>
            )}
            {tab === "PREVIEW" && (
              <div className="space-y-3">
                <div className="rounded-xl border border-amber-500/40 bg-gradient-to-b from-[#0a2347] to-[#08172e] p-3.5 text-white shadow-sm">
                  <div className="flex items-center justify-between gap-2"><span className="rounded-full bg-amber-400 px-2.5 py-0.5 text-[10.5px] font-bold text-slate-950">إعلان ممول</span><span className="text-[11px] text-blue-100/75">{merchantName}</span></div>
                  <p className="mt-2 text-sm font-bold">{adHeadline}</p>
                  <p className="mt-1 text-xs leading-relaxed text-blue-100/85">{adBody}</p>
                </div>
                <button type="button" onClick={onApproveMandate} data-testid="button-approve-gosell-mandate" className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-l from-amber-500 to-amber-400 px-4 text-xs font-bold text-slate-950 shadow-xs transition hover:brightness-105 hover:shadow-[0_6px_22px_rgba(245,158,11,0.28)]"><CheckCircle2 size={15} aria-hidden /><span>اعتماد المسودة والمتابعة لتأكيد الدفع</span></button>
              </div>
            )}
            {tab === "ANALYTICS" && (
              <div className="space-y-2.5">
                <dl className="grid grid-cols-2 gap-2">
                  {[{ label: "مرات الظهور", value: analytics.impressions.toLocaleString("en") }, { label: "النقرات المؤهلة", value: analytics.clicks.toLocaleString("en") }, { label: "معدل النقر (CTR)", value: analytics.ctrLabel }, { label: "الطلبات المنسوبة", value: analytics.attributedOrders.toLocaleString("en") }].map((m) => (
                    <div key={m.label} className="rounded-xl border border-border/70 bg-muted/30 p-2.5"><dt className="text-[11px] text-muted-foreground">{m.label}</dt><dd className="mt-0.5 text-base font-bold tabular-nums text-foreground" dir="ltr">{m.value}</dd></div>
                  ))}
                </dl>
                <p className="text-[11px] text-muted-foreground">الأرقام تعرض النتائج الفعلية الموثقة فقط؛ النقرة لا تُحتسب عملية بيع أبدًا.</p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.section>
  );
});
