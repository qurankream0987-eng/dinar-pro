import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { SmartImage } from "@/ui/Media";
import type { CampaignPlan, PlacementCampaignResult } from "./commercial-types";

type Quote = {
  subject: { kind: string; id: string; title: string };
  lines: { productId: string; where: string; name: string; days: number; unitPriceLabel: string; priceLabel: string; available: boolean; reason?: string }[];
  totalLabel: string;
  ok: boolean;
  quoteKey: string;
};
type Checkout = { campaignId: string; checkoutUrl: string; amountLabel: string; providerName: string; note: string };

/**
 * «أين تريد ظهور إعلانك؟» — choose one or several placements, the days of each (where the policy
 * allows), edit the ad text, see the server's price for every placement and the total, then confirm.
 * Every amount shown comes from the server's quote; nothing is priced here.
 */
export function CampaignBuilder({ plan, copy, active }: { plan: CampaignPlan; copy: string[]; active: boolean }) {
  const options = plan.options;
  const first = plan.suggestions[0]?.productIds ?? [];
  const initial = () => Object.fromEntries(options.filter((o) => first.includes(o.productId) && o.available).map((o) => [o.productId, o.defaultDays]));
  const [selected, setSelected] = useState<Record<string, number>>(initial);
  const [adCopy, setAdCopy] = useState(copy[0] ?? "");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState("");
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [confirming, setConfirming] = useState(false);
  const idempotency = useRef(`camp-${crypto.randomUUID()}`);
  const items = useMemo(() => Object.entries(selected).map(([productId, days]) => ({ productId, days })), [selected]);
  const subject = plan.subject!.kind === "STORE" ? { kind: "STORE", businessId: plan.subject!.id } : { kind: "LISTING", listingId: plan.subject!.id };

  // The server prices every change (adding, removing a placement or changing its days).
  useEffect(() => {
    if (checkout) return;
    if (!items.length) { setQuote(null); return; }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const result = (await api("/commercial/promotion-campaigns/quote", "POST", { subject, items })) as Quote;
        if (!cancelled) { setQuote(result); setError(""); }
      } catch (e) {
        if (!cancelled) { setQuote(null); setError(friendlyError(e, "تعذر حساب السعر الآن.")); }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items), checkout]);

  const toggle = (productId: string, days: number) => {
    setCheckout(null);
    idempotency.current = `camp-${crypto.randomUUID()}`;
    setSelected((current) => {
      const next = { ...current };
      if (productId in next) delete next[productId];
      else next[productId] = days;
      return next;
    });
  };
  const setDays = (productId: string, days: number) => {
    idempotency.current = `camp-${crypto.randomUUID()}`;
    setSelected((current) => ({ ...current, [productId]: days }));
  };
  const applySuggestion = (ids: string[]) => {
    idempotency.current = `camp-${crypto.randomUUID()}`;
    setSelected(Object.fromEntries(options.filter((o) => ids.includes(o.productId) && o.available).map((o) => [o.productId, o.defaultDays])));
  };
  const confirm = async () => {
    if (!quote) return;
    setConfirming(true);
    setError("");
    try {
      const result = (await api("/commercial/promotion-campaigns/checkouts", "POST", { subject, items, adCopy, quoteKey: quote.quoteKey, idempotencyKey: idempotency.current })) as Checkout;
      setCheckout(result);
    } catch (e) {
      const data = (e as { data?: { code?: string; quote?: Quote } }).data;
      if (data?.code === "PRICE_CHANGED" && data.quote) {
        setQuote(data.quote);
        setError("تغيّر السعر منذ مراجعتك. هذا هو الإجمالي الجديد من الخادم؛ راجعه ثم أكّد مرة أخرى.");
      } else setError(friendlyError(e, "تعذر فتح صفحة الدفع الآن."));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="campaign-builder">
      <div className="flex items-center gap-3 rounded-lg border border-border p-2" data-testid="campaign-subject">
        <span className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted" data-testid="campaign-subject-image" data-has-image={plan.subject?.imagePath ? "true" : "false"}>
          {plan.subject?.imagePath ? <SmartImage src={plan.subject.imagePath} alt={plan.subject.title} /> : <span className="grid h-full place-items-center p-1 text-center text-[10px] text-muted-foreground">لا صورة</span>}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{plan.subject?.title}</span>
          <span className="block text-xs text-muted-foreground">{plan.subject?.kind === "STORE" ? "ترويج المتجر" : "ترويج المنتج"}</span>
          {!plan.subject?.imagePath && <span className="block text-xs text-destructive">أضف صورة: الشريط الرئيسي والجانبي يعرضان صورة المنتج.</span>}
        </span>
      </div>
      <h4 className="font-semibold">أين تريد ظهور إعلانك؟</h4>
      {plan.suggestions.length > 0 && (
        <div className="space-y-2" data-testid="campaign-suggestions">
          <p className="text-xs text-muted-foreground">اقتراحات جاسم (القرار لك):</p>
          {plan.suggestions.map((suggestion, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-2 text-xs">
              <span className="min-w-0 flex-1">{suggestion.reason}</span>
              {active && !checkout && <Button size="sm" variant="secondary" onClick={() => applySuggestion(suggestion.productIds)} data-testid="campaign-suggestion">اختر هذا الاقتراح</Button>}
            </div>
          ))}
        </div>
      )}
      <ul className="space-y-2">
        {options.map((option) => {
          const checked = option.productId in selected;
          const days = selected[option.productId] ?? option.defaultDays;
          return (
            <li key={option.productId} className={`space-y-2 rounded-lg border p-3 ${checked ? "border-primary" : "border-border"} ${option.available ? "" : "opacity-60"}`} data-testid="campaign-option" data-placement={option.placement} data-selected={checked ? "true" : "false"}>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 size-4" checked={checked} disabled={!active || !option.available || !!checkout} onChange={() => toggle(option.productId, option.defaultDays)} aria-label={`اختيار ${option.where}`} data-testid="campaign-option-toggle" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{option.where}</span>
                  <span className="block text-xs text-muted-foreground">{option.name} — <bdi>{option.unitPriceLabel}</bdi></span>
                  {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
                  {!option.available && option.reason && <span className="block text-xs text-destructive">{option.reason}</span>}
                </span>
              </label>
              {checked && option.pricingUnit === "DAY" && (
                <label className="flex items-center gap-2 text-xs">
                  <span>عدد الأيام ({option.minDays}–{option.maxDays}):</span>
                  <input type="number" inputMode="numeric" dir="ltr" className="h-8 w-20 rounded-md border border-border bg-background px-2" min={option.minDays} max={option.maxDays} value={days} disabled={!active || !!checkout}
                    onChange={(event) => { const value = Math.round(Number(event.target.value)); if (Number.isFinite(value) && value >= option.minDays && value <= option.maxDays) setDays(option.productId, value); }}
                    aria-label={`عدد أيام ${option.where}`} data-testid="campaign-option-days" />
                </label>
              )}
              {checked && option.pricingUnit === "PERIOD" && <p className="text-xs text-muted-foreground">المدة ثابتة: {option.defaultDays} يومًا</p>}
            </li>
          );
        })}
      </ul>
      <label className="block space-y-1 text-xs">
        <span>النص الإعلاني (قابل للتعديل):</span>
        <textarea className="min-h-20 w-full rounded-md border border-border bg-background p-2 text-sm" maxLength={280} value={adCopy} disabled={!active || !!checkout} onChange={(event) => setAdCopy(event.target.value)} data-testid="campaign-copy" />
      </label>
      <div className="space-y-2 rounded-lg border border-border p-3" data-testid="campaign-review" aria-live="polite">
        <p className="font-medium">ملخص الحملة قبل التأكيد</p>
        {!items.length && <p className="text-xs text-muted-foreground">اختر موضعًا واحدًا على الأقل.</p>}
        {items.length > 0 && quoting && !quote && <p className="text-xs text-muted-foreground">يحسب الخادم السعر…</p>}
        {quote && (
          <>
            <ul className="space-y-1 text-xs">
              {quote.lines.map((line) => (
                <li key={line.productId} className="flex flex-wrap justify-between gap-2" data-testid="campaign-review-line">
                  <span className="min-w-0">{line.where} — {line.days} يومًا</span>
                  <bdi className="tabular-nums">{line.priceLabel}</bdi>
                  {!line.available && line.reason && <span className="w-full text-destructive">{line.reason}</span>}
                </li>
              ))}
            </ul>
            <p className="flex justify-between border-t border-border pt-2 font-semibold"><span>الإجمالي</span><bdi className="tabular-nums" data-testid="campaign-total">{quote.totalLabel}</bdi></p>
            <p className="text-xs text-muted-foreground">لا يُدفع شيء الآن. كل موضع يبدأ بعد التأكيد الموقّع للدفع فقط وينتهي تلقائيًا، دون تجديد تلقائي. الإعلان يظهر بشارة «ممول» ولا يضمن البيع.</p>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-destructive" data-testid="campaign-error">{error}</p>}
      {active && !checkout && (
        <Button size="sm" disabled={!quote || !quote.ok || quoting || confirming || !items.length} onClick={confirm} data-testid="campaign-confirm">
          {confirming ? "جارٍ فتح صفحة الدفع…" : `تأكيد والمتابعة إلى الدفع عبر ${plan.providerName ?? "مزود الدفع"}`}
        </Button>
      )}
      {checkout && (
        <div className="space-y-2 rounded-lg border border-primary/40 p-3" data-testid="campaign-checkout">
          <p className="font-medium">صفحة دفع الحملة جاهزة عبر {checkout.providerName}</p>
          <p className="flex justify-between"><span>المبلغ</span><bdi className="tabular-nums">{checkout.amountLabel}</bdi></p>
          <p className="text-xs leading-6 text-muted-foreground">{checkout.note}</p>
          <a className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" href={checkout.checkoutUrl} rel="noopener noreferrer" data-testid="campaign-checkout-link">الدفع عبر {checkout.providerName}</a>
        </div>
      )}
    </div>
  );
}

/** One campaign's results: every placement on its own, then the campaign totals (recorded counts only). */
export function PlacementCampaignResults({ campaigns }: { campaigns: PlacementCampaignResult[] }) {
  return (
    <div className="space-y-3" data-testid="placement-campaigns">
      {campaigns.map((campaign) => (
        <div key={campaign.campaignId} className="space-y-3 rounded-lg border border-border p-3" data-testid="placement-campaign" data-status={campaign.status}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-muted" data-testid="placement-campaign-image">{campaign.subjectImage ? <SmartImage src={campaign.subjectImage} alt={campaign.subjectTitle} /> : null}</span>
              <h4 className="min-w-0 truncate font-semibold">{campaign.subjectTitle}</h4>
            </span>
            <span className="text-xs">{campaign.statusLabel} · <bdi className="tabular-nums">{campaign.totalLabel}</bdi></span>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="placement-campaign-payment">{campaign.paymentNote}</p>
          <ul className="space-y-2">
            {campaign.placements.map((item, index) => (
              <li key={index} className="space-y-1 rounded-md bg-muted/40 p-2 text-xs" data-testid="placement-result" data-placement={item.placement} data-status={item.status}>
                <p className="flex flex-wrap justify-between gap-2 font-medium"><span>{item.where}</span><span>{item.statusLabel}</span></p>
                <p className="text-muted-foreground">{item.note}</p>
                <p className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                  <span>ظهور: {item.impressions}</span><span>نقرات: {item.clicks}</span><span>تفاعل: {item.engagements}</span><span data-testid="placement-orders" data-available={item.orders === null ? "false" : "true"} title={item.ordersNote}>طلبات منسوبة: {item.orders === null ? "غير متاح" : item.orders}</span>
                  {item.remainingDays !== null && <span>متبقٍ: {item.remainingDays} يومًا</span>}
                  {item.expiresAt && <span>ينتهي: {new Date(item.expiresAt).toLocaleDateString("ar")}</span>}
                </p>
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap gap-x-3 text-xs font-medium tabular-nums" data-testid="placement-campaign-totals">
            <span>الإجمالي — ظهور: {campaign.totals.impressions}</span><span>نقرات: {campaign.totals.clicks}</span><span>تفاعل: {campaign.totals.engagements}</span><span data-testid="placement-campaign-orders">طلبات: {campaign.placements.every((item) => item.orders === null) ? "غير متاح" : `${campaign.totals.orders}${campaign.totals.ordersPartial ? " (من المواضع القابلة للإسناد فقط)" : ""}`}</span>
          </p>
          {campaign.placements.some((item) => item.orders === null) && <p className="text-xs text-muted-foreground" data-testid="placement-orders-note">الطلبات المنسوبة لإعلانات المتجر غير متاحة حتى يُبنى ربط موثوق؛ لا يُنسب بيع دون دليل.</p>}
          {campaign.previous && <p className="text-xs text-muted-foreground">الحملة السابقة: ظهور {campaign.previous.impressions}، نقرات {campaign.previous.clicks}، طلبات {campaign.previous.orders}.</p>}
          {campaign.advice.length > 0 && <ul className="list-inside list-disc text-xs">{campaign.advice.map((line, index) => <li key={index}>{line}</li>)}</ul>}
        </div>
      ))}
    </div>
  );
}
