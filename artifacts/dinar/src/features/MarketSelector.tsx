import { createContext, useContext, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { ArrowRightLeft, Check, ChevronDown, LogIn, ShoppingCart } from "lucide-react";
import {
  api,
  isMarketAvailable,
  useAccount,
  type Market,
} from "@/account/Account";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { Sheet } from "@/ui/Sheet";
import { Button, ButtonLink } from "@/ui/Button";
import { Flag } from "@/ui/Media";
import { InlineAlert } from "@/ui/Feedback";

import { countryByCode, currencyName, DEFAULT_MARKET, searchCountries } from "@workspace/global";
import { Input } from "@/ui/Field";

const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const useMarketSheet = () => useContext(Ctx);

function marketAvailabilityLabel(market: Market) {
  if (market.status === "DISABLED") return "غير متاح";
  if (!market.priceConfigured || market.unitPriceMinor < 1) return "السعر غير معتمد";
  if (!isMarketAvailable(market)) return "قريبًا";
  return market.status === "LIMITED" ? "متاح بنطاق محدود" : "متاح الآن";
}

export function MarketSheetProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Ctx.Provider value={{ open: () => setOpen(true) }}>
      {children}
      <MarketSheet open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  );
}

/** Compact market indicator for the top bar. */
export function MarketChip({
  className,
  testId = "button-market",
  compact = false,
}: {
  className?: string;
  testId?: string;
  compact?: boolean;
}) {
  const { market } = useAccount();
  const { open } = useMarketSheet();
  const marketName = market?.countryNameAr ?? countryByCode.get(DEFAULT_MARKET)?.countryNameAr ?? DEFAULT_MARKET;
  return (
    <button
      type="button"
      onClick={open}
      data-testid={testId}
      aria-label={`السوق الحالي: ${marketName}. تغيير السوق`}
      title={compact ? `السوق الحالي: ${marketName}` : undefined}
      className={cn(
        "pressable inline-flex items-center border border-border bg-card text-sm font-semibold text-foreground hover:border-border-strong",
        compact
          ? "h-11 w-11 justify-center gap-0 rounded-2xl p-0"
          : "h-9 gap-1.5 rounded-full ps-2.5 pe-2",
        className,
      )}
    >
      <Flag code={market?.countryCode ?? DEFAULT_MARKET} size={18} />
      {!compact && (
        <>
          <span className="market-name max-w-28 truncate">{marketName}</span>
          <ChevronDown size={15} className="text-muted-foreground" aria-hidden />
        </>
      )}
    </button>
  );
}

function MarketSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { markets, market, user, refresh } = useAccount();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const matchingCodes = new Set(searchCountries(query).map(c=>c.countryCode));
  const visibleMarkets = markets.filter(m=>matchingCodes.has(m.countryCode)).sort((a,b)=>Number(b.id===(market?.id??DEFAULT_MARKET))-Number(a.id===(market?.id??DEFAULT_MARKET))||Number(isMarketAvailable(b))-Number(isMarketAvailable(a))||a.countryNameAr.localeCompare(b.countryNameAr,"ar"));
  const [selected, setSelected] = useState<Market>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setSelected(undefined);
      setError("");
    }
  };

  const confirm = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api("/account/market", "PATCH", { marketId: selected.id });
      await refresh();
      close(false);
      navigate("/");
      toast.success(`أنت الآن في سوق ${selected.countryNameAr}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={close}
      testId="sheet-market"
      title={selected ? `الانتقال إلى سوق ${selected.countryNameAr}` : "اختر السوق"}
      description={
        selected
          ? undefined
          : "لكل سوق عروضه وعملته وسعر وحدته. دولة حسابك لا تتغير."
      }
      width={460}
      footer={
        selected ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="secondary" block onClick={() => setSelected(undefined)} disabled={busy}>
              رجوع
            </Button>
            <Button block onClick={confirm} loading={busy} icon={<ArrowRightLeft size={17} />} data-testid="button-confirm-market">
              الانتقال للسوق
            </Button>
          </div>
        ) : undefined
      }
    >
      {selected ? (
        <div className="space-y-4 pb-2">
          <div className="flex items-center gap-3 rounded-lg bg-muted p-4">
            <Flag code={selected.countryCode} size={36} />
            <div>
              <p className="text-md font-bold">{selected.countryNameAr}</p>
              <p className="text-sm text-muted-foreground">
                العملة = <span className="num font-semibold text-foreground">{selected.currencyCode}</span>
              </p>
            </div>
          </div>
          {!isMarketAvailable(selected) && <InlineAlert>{marketAvailabilityLabel(selected)} — لم يبدأ جاسم استقبال العروض والطلبات في هذا السوق. اختر سوقًا متاحًا.</InlineAlert>}
          <ul className="space-y-3 text-base text-text-secondary">
            <li className="flex gap-3">
              <Check size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
              ستتصفح عروض {selected.countryNameAr} بعملة {currencyName(selected.currencyCode)}.
            </li>
            <li className="flex gap-3">
              <ShoppingCart size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
              سلة {market?.countryNameAr ?? "السوق الحالي"} تبقى محفوظة وتعود إليها عند الرجوع.
            </li>
            <li className="flex gap-3">
              <Check size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
              طلباتك السابقة تبقى متاحة لك من «طلباتي».
            </li>
          </ul>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        </div>
      ) : (
        <div className="space-y-2 pb-2" role="radiogroup" aria-label="الأسواق">
          <Input type="search" aria-label="ابحث عن سوق" placeholder="ابحث عن سوق، دولة أو رمز اتصال…" value={query} onChange={e=>setQuery(e.target.value)} className="mb-3" />
          {visibleMarkets.map((m) => {
            const current = m.id === (market?.id ?? DEFAULT_MARKET);
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={current}
                disabled={!current && !isMarketAvailable(m)}
                onClick={() => (current ? close(false) : setSelected(m))}
                data-testid={`button-market-${m.id}`}
                className={cn(
                  "pressable flex w-full items-center gap-3 rounded-lg border p-3.5 text-start disabled:opacity-60",
                  current ? "border-primary bg-primary-soft/60 ring-1 ring-primary" : "border-border bg-card hover:border-border-strong",
                )}
              >
                <Flag code={m.countryCode} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-md font-bold text-foreground">
                    {m.countryNameAr}
                    {current && (
                      <span className="rounded-full bg-primary px-2 py-0.5 text-2xs font-semibold text-primary-foreground">
                        الحالي
                      </span>
                    )}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {currencyName(m.currencyCode)} · <span dir="ltr">{m.currencyCode}</span>
                  </span>
                </span>
                <span className="text-end">
                  <span className="block text-2xs text-muted-foreground">{marketAvailabilityLabel(m)}</span>
                  <span className="num block max-w-28 text-sm font-bold text-foreground">{m.currencyCode}</span>
                </span>
              </button>
            );
          })}
          {visibleMarkets.length === 0 && <p className="py-5 text-center">لا توجد أسواق مطابقة</p>}
          {!user && (
            <div className="mt-3 rounded-lg bg-muted p-4 text-center">
              <p className="text-base text-text-secondary">يمكنك تغيير السوق وتصفح العروض العامة دون تسجيل الدخول. يلزم الحساب للميزات الخاصة وإتمام الطلب.</p>
              <ButtonLink href="/login" variant="primary" className="mt-3" icon={<LogIn size={17} />} onClick={() => close(false)}>
                تسجيل الدخول
              </ButtonLink>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
