import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  CircleDollarSign,
  Clock3,
  FileCog,
  History,
  LockKeyhole,
  MapPinned,
  Plus,
  Search,
  ShieldCheck,
  Tags,
} from "lucide-react";
import { currencies, currencyName, decimalToMinor, formatMoney, minorToDecimal } from "@workspace/global";
import { FULFILMENT_OPTIONS } from "@/marketplace-options";
import {
  getGetAdminMarketCategoryPolicyAuditQueryKey,
  useGetAdminMarketCategoryPolicyAudit,
  useGetAdminMarketplaceCategories,
} from "@workspace/api-client-react";
import { api, useAccount, type Market } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/Button";
import { Badge, EmptyState, ErrorState, InlineAlert, Skeleton, StatusBadge } from "@/ui/Feedback";
import { Card, CardTitle, PageHeader, Summary } from "@/ui/Layout";
import { Field, Input, Select } from "@/ui/Field";
import { Form } from "@/components/ui/form";

type MarketStatus = Market["status"];
type FulfilmentMethod = "PICKUP" | "DELIVERY" | "DIGITAL" | "SERVICE";
type SellerEligibilityMode = "OPEN" | "APPROVAL_REQUIRED";

type MarketConfiguration = {
  status: MarketStatus;
  fulfilmentMethods: FulfilmentMethod[];
  paymentMethods: "CASH_DIRECT"[];
  restrictedCategories: string[];
  sellerEligibilityMode: SellerEligibilityMode;
};

type PriceVersion = {
  id: string;
  marketId: string;
  currencyCode: string;
  unitPriceMinor: number;
  minorUnitScale: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt?: string;
};

const STATUS_META: Record<MarketStatus, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  ACTIVE: { label: "نشط", tone: "success" },
  LIMITED: { label: "محدود", tone: "warning" },
  COMING_SOON: { label: "قريبًا", tone: "info" },
  DISABLED: { label: "معطّل", tone: "danger" },
};

const STATUS_OPTIONS: { value: MarketStatus; label: string; detail: string }[] = [
  { value: "ACTIVE", label: "نشط", detail: "يستقبل العروض والطلبات" },
  { value: "LIMITED", label: "محدود", detail: "متاح بسياسات أو نطاق محدود" },
  { value: "COMING_SOON", label: "قريبًا", detail: "مهيأ ولم يبدأ بعد" },
  { value: "DISABLED", label: "معطّل", detail: "لا يظهر كسوق متاح" },
];

const nonOperationalCurrencyCodes = new Set(["XXX", "USN", "UYI", "CHE", "CHW"]);
const currencyOptions = Object.values(currencies)
  .filter((currency) => !nonOperationalCurrencyCodes.has(currency.code))
  .sort((a, b) => a.code.localeCompare(b.code));

function statusMeta(status: MarketStatus) {
  return STATUS_META[status] ?? STATUS_META.COMING_SOON;
}

function hasUsablePrice(market: Market) {
  return market.priceConfigured && market.unitPriceMinor >= 1;
}

function dateTimeLabel(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar", {
    dateStyle: "medium",
    timeStyle: "short",
    numberingSystem: "latn",
  }).format(new Date(value));
}

function toOffsetIso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("اختر وقتًا صحيحًا للسعر المجدول.");
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(hours)}:${pad(minutes)}`;
}

function defaultConfiguration(market: Market): MarketConfiguration {
  return {
    status: market.status,
    fulfilmentMethods: (market.fulfilmentMethods.filter((method): method is FulfilmentMethod =>
      ["PICKUP", "DELIVERY", "DIGITAL", "SERVICE"].includes(method),
    ) || []) as FulfilmentMethod[],
    paymentMethods: market.paymentMethods.includes("CASH_DIRECT") ? ["CASH_DIRECT"] : [],
    restrictedCategories: [...market.restrictedCategories],
    sellerEligibilityMode: market.sellerEligibilityMode === "APPROVAL_REQUIRED" ? "APPROVAL_REQUIRED" : "OPEN",
  };
}

function MarketStatusBadge({ market, compact = false }: { market: Market; compact?: boolean }) {
  const meta = statusMeta(market.status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge label={meta.label} tone={meta.tone} testId={`status-market-${market.id}`} />
      {!hasUsablePrice(market) && (
        <Badge tone="warning" testId={`status-price-missing-${market.id}`}>
          {compact ? "بلا سعر" : "السعر غير معتمد"}
        </Badge>
      )}
    </span>
  );
}

function MarketList({
  markets,
  selectedId,
  onSelect,
}: {
  markets: Market[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | "NEEDS_PRICE" | MarketStatus>("ALL");

  const visibleMarkets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return markets
      .filter((market) => {
        const matchesQuery =
          !needle ||
          `${market.id} ${market.countryNameAr} ${market.countryNameEn} ${market.countryCode} ${market.currencyCode}`
            .toLocaleLowerCase()
            .includes(needle);
        const matchesFilter =
          filter === "ALL" ||
          (filter === "NEEDS_PRICE" ? !hasUsablePrice(market) : market.status === filter);
        return matchesQuery && matchesFilter;
      })
      .sort((a, b) => {
        const priority = (market: Market) =>
          !hasUsablePrice(market) ? 0 : market.status === "COMING_SOON" ? 1 : market.status === "ACTIVE" ? 2 : market.status === "LIMITED" ? 3 : 4;
        return priority(a) - priority(b) || a.countryNameAr.localeCompare(b.countryNameAr, "ar");
      });
  }, [filter, markets, query]);

  return (
    <Card className="overflow-hidden p-0" testId="card-admin-market-list">
      <div className="border-b border-border bg-primary-soft/40 p-4 md:p-5">
        <CardTitle icon={<MapPinned size={19} />}>كل الأسواق</CardTitle>
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ابحث باسم الدولة أو الرمز…"
            aria-label="ابحث في الأسواق"
            data-testid="input-search-markets"
            className="h-11 ps-10"
          />
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="تصفية الأسواق">
          {[
            ["ALL", "الكل"],
            ["NEEDS_PRICE", "بلا سعر"],
            ["ACTIVE", "نشطة"],
            ["COMING_SOON", "قريبًا"],
            ["LIMITED", "محدودة"],
            ["DISABLED", "معطّلة"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value as typeof filter)}
              data-testid={`button-filter-markets-${value.toLowerCase()}`}
              className={cn(
                "pressable shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold",
                filter === value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-text-secondary hover:border-border-strong",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[calc(100dvh-310px)] min-h-[360px] overflow-y-auto p-2">
        {visibleMarkets.map((market) => (
          <button
            key={market.id}
            type="button"
            onClick={() => onSelect(market.id)}
            data-testid={`button-select-market-${market.id}`}
            aria-current={selectedId === market.id ? "true" : undefined}
            className={cn(
              "pressable mb-1 flex w-full items-center gap-3 rounded-lg border p-3 text-start",
              selectedId === market.id ? "border-primary bg-primary-soft/70 ring-1 ring-primary" : "border-transparent hover:border-border hover:bg-muted/60",
            )}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink text-xs font-bold tracking-wide text-ink-foreground" dir="ltr">
              {market.countryCode}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-bold text-foreground" data-testid={`text-market-name-${market.id}`}>{market.countryNameAr}</span>
                <span className="num shrink-0 text-2xs text-muted-foreground" dir="ltr">{market.id}</span>
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {market.currencyCode} · {hasUsablePrice(market) ? formatMoney(market.unitPriceMinor, market.currencyCode) : "لا يوجد سعر حالي"}
              </span>
            </span>
            <MarketStatusBadge market={market} compact />
            <ChevronLeft size={17} className="shrink-0 text-muted-foreground" aria-hidden />
          </button>
        ))}
        {visibleMarkets.length === 0 && (
          <EmptyState
            compact
            icon={Search}
            title="لا توجد أسواق مطابقة"
            body="جرّب اسم دولة أو رمزًا مختلفًا."
            testId="empty-admin-markets"
          />
        )}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground" data-testid="text-markets-result-count">
        يعرض {visibleMarkets.length} من {markets.length} سوقًا
      </p>
    </Card>
  );
}

function MarketConfigurationForm({
  market,
  onUpdated,
}: {
  market: Market;
  onUpdated: () => void;
}) {
  const categoryQuery = useGetAdminMarketplaceCategories();
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const form = useForm<MarketConfiguration>({ defaultValues: defaultConfiguration(market) });
  const status = form.watch("status");
  const fulfilmentMethods = form.watch("fulfilmentMethods");
  const restrictedCategories = form.watch("restrictedCategories");
  const paymentMethods = form.watch("paymentMethods");
  const categoryOptions = categoryQuery.data?.map((category) => ({
    id: category.id,
    label: category.label,
  })) ?? [];

  useEffect(() => {
    form.reset(defaultConfiguration(market));
    setFormError("");
  }, [form, market]);

  const toggleListValue = <T extends string>(field: "fulfilmentMethods" | "restrictedCategories", value: T, checked: boolean) => {
    const current = form.getValues(field) as string[];
    const next = checked ? [...new Set([...current, value])] : current.filter((item) => item !== value);
    form.setValue(field, next as never, { shouldDirty: true });
  };
  const toggleRestrictedCategory = (
    category: { id: string; label: string },
    checked: boolean,
  ) => {
    const current = form.getValues("restrictedCategories");
    const withoutAliases = current.filter(
      (value) => value !== category.id && value !== category.label,
    );
    const next = checked
      ? [...new Set([...withoutAliases, category.id])]
      : withoutAliases;
    form.setValue("restrictedCategories", next, { shouldDirty: true });
  };

  const onSubmit = async (values: MarketConfiguration) => {
    setFormError("");
    if (!values.fulfilmentMethods.length) {
      setFormError("اختر طريقة تنفيذ واحدة على الأقل.");
      return;
    }
    if (["ACTIVE", "LIMITED"].includes(values.status) && !hasUsablePrice(market)) {
      setFormError("لا يمكن تفعيل السوق قبل اعتماد سعر وحدة موجب.");
      return;
    }
    setSaving(true);
    try {
      await api(`/admin/markets/${market.id}`, "PATCH", values);
      onUpdated();
    } catch (error) {
      setFormError(friendlyError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" data-testid={`form-market-configuration-${market.id}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-foreground">الحالة والسياسات</h3>
            <p className="mt-1 text-sm text-muted-foreground">هذه الإعدادات تخص {market.countryNameAr} فقط.</p>
          </div>
          <FileCog size={22} className="text-primary" aria-hidden />
        </div>
        {formError && <InlineAlert tone="danger" testId="alert-market-configuration">{formError}</InlineAlert>}
        <Field label="حالة السوق" hint="لا يمكن اختيار حالة متاحة دون سعر وحدة موجب.">
          <Select {...form.register("status")} data-testid="select-market-status">
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label} — {option.detail}</option>
            ))}
          </Select>
        </Field>
        {["ACTIVE", "LIMITED"].includes(status) && !hasUsablePrice(market) && (
          <InlineAlert tone="warning" testId="alert-activation-price">
            اعتمد سعرًا موجبًا أولًا من قسم «سعر الوحدة» حتى يصبح هذا السوق متاحًا.
          </InlineAlert>
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-foreground">طرق التنفيذ</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {FULFILMENT_OPTIONS.map((option) => {
              const checked = fulfilmentMethods.includes(option.value);
              return (
                <label key={option.value} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm", checked ? "border-primary bg-primary-soft/50" : "border-border bg-card hover:border-border-strong")}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggleListValue("fulfilmentMethods", option.value, event.target.checked)}
                    data-testid={`checkbox-fulfilment-${option.value.toLowerCase()}`}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                  <span className="font-medium">{option.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid gap-5 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-foreground">الدفع</legend>
            <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm", paymentMethods.includes("CASH_DIRECT") ? "border-primary bg-primary-soft/50" : "border-border bg-card hover:border-border-strong")}>
              <input
                type="checkbox"
                checked={paymentMethods.includes("CASH_DIRECT")}
                onChange={(event) => form.setValue("paymentMethods", event.target.checked ? ["CASH_DIRECT"] : [], { shouldDirty: true })}
                data-testid="checkbox-payment-cash-direct"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              <span>
                <span className="block font-medium">نقدًا مباشرة</span>
                <span className="block text-xs text-muted-foreground">الدفع بين الطرفين عند التنفيذ</span>
              </span>
            </label>
          </fieldset>
          <Field label="أهلية البائعين">
            <Select {...form.register("sellerEligibilityMode")} data-testid="select-seller-eligibility">
              <option value="OPEN">مفتوحة</option>
              <option value="APPROVAL_REQUIRED">تتطلب موافقة</option>
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Tags size={16} aria-hidden /> التصنيفات المحظورة
          </legend>
          <p className="mb-2 text-xs text-muted-foreground">حدد التصنيفات التي لا يسمح بها هذا السوق.</p>
          {categoryQuery.isError && (
            <InlineAlert tone="warning">
              تعذّر تحميل التصنيفات الإضافية؛ تظهر التصنيفات الأساسية فقط.
            </InlineAlert>
          )}
          <div className="flex flex-wrap gap-2">
            {categoryOptions.map((category) => {
              const checked =
                restrictedCategories.includes(category.id) ||
                restrictedCategories.includes(category.label);
              return (
                <label key={category.id} className={cn("cursor-pointer rounded-full border px-3 py-2 text-sm font-medium", checked ? "border-destructive bg-destructive-soft text-destructive" : "border-border bg-card text-text-secondary hover:border-border-strong")}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggleRestrictedCategory(category, event.target.checked)}
                    data-testid={`checkbox-restricted-category-${category.id}`}
                    className="sr-only"
                  />
                  {category.label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <Button type="submit" loading={saving} block icon={<Check size={17} />} data-testid="button-save-market-configuration">
          حفظ إعدادات السوق
        </Button>
      </form>
    </Form>
  );
}

function MarketPricePanel({
  market,
  onPriceCreated,
}: {
  market: Market;
  onPriceCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const pricesQuery = useQuery<PriceVersion[]>({
    queryKey: ["admin-market-prices", market.id],
    queryFn: () => api(`/admin/markets/${market.id}/prices`) as Promise<PriceVersion[]>,
    staleTime: 0,
    refetchOnMount: true,
  });
  const configuredCurrency = currencyOptions.some((currency) => currency.code === market.currencyCode)
    ? market.currencyCode
    : "";
  const [currencyCode, setCurrencyCode] = useState(configuredCurrency);
  const [priceValue, setPriceValue] = useState(market.priceConfigured && configuredCurrency ? minorToDecimal(market.unitPriceMinor, configuredCurrency) : "");
  const [timing, setTiming] = useState<"NOW" | "SCHEDULED">("NOW");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const nextCurrency = currencyOptions.some((currency) => currency.code === market.currencyCode)
      ? market.currencyCode
      : "";
    setCurrencyCode(nextCurrency);
    setPriceValue(market.priceConfigured && nextCurrency ? minorToDecimal(market.unitPriceMinor, nextCurrency) : "");
    setTiming("NOW");
    setEffectiveFrom("");
    setError("");
    setSuccess("");
  }, [market]);

  const submitPrice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!currencyOptions.some((currency) => currency.code === currencyCode)) {
      setError("اختر عملة تشغيلية قبل حفظ السعر.");
      return;
    }
    let unitPriceMinor = 0;
    try {
      unitPriceMinor = decimalToMinor(priceValue, currencyCode);
      if (unitPriceMinor < 1) throw new Error("سعر الوحدة يجب أن يكون أكبر من صفر.");
    } catch (priceError) {
      setError(priceError instanceof Error ? priceError.message : "أدخل سعرًا صالحًا.");
      return;
    }
    if (timing === "SCHEDULED" && !effectiveFrom) {
      setError("اختر وقت بدء السعر المجدول.");
      return;
    }
    setSaving(true);
    try {
      await api(`/admin/markets/${market.id}/prices`, "POST", {
        currencyCode,
        unitPriceMinor,
        ...(timing === "SCHEDULED" ? { effectiveFrom: toOffsetIso(effectiveFrom) } : {}),
      });
      setSuccess(timing === "NOW" ? "اعتمد السعر الحالي بنجاح." : "تمت جدولة نسخة السعر.");
      await queryClient.invalidateQueries({ queryKey: ["admin-market-prices", market.id] });
      onPriceCreated();
    } catch (priceError) {
      setError(friendlyError(priceError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-foreground">سعر الوحدة</h3>
          <p className="mt-1 text-sm text-muted-foreground">هذا سعر مرجعي للسوق؛ تحدد العروض أسعارها بشكل مستقل، ولا يُستنتج السعر من دولة أخرى.</p>
        </div>
        <CircleDollarSign size={22} className="text-accent-ink" aria-hidden />
      </div>
      {error && <InlineAlert tone="danger" testId="alert-market-price">{error}</InlineAlert>}
      {success && <InlineAlert tone="success" testId="alert-market-price-success">{success}</InlineAlert>}
      <div className="rounded-lg border border-accent/35 bg-accent-soft p-4" data-testid={`summary-current-price-${market.id}`}>
        <p className="text-xs font-semibold text-accent-ink">السعر الحالي</p>
        <p className="num mt-1 text-2xl font-bold text-foreground" dir="ltr">
          {hasUsablePrice(market) ? formatMoney(market.unitPriceMinor, market.currencyCode) : "غير معتمد"}
        </p>
        <p className="mt-1 text-xs text-accent-ink">{hasUsablePrice(market) ? "نسخة فعالة الآن" : "لا يمكن تفعيل السوق بعد"}</p>
      </div>
      <form onSubmit={submitPrice} className="space-y-4" data-testid={`form-market-price-${market.id}`}>
        <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
          <Field label="قيمة الوحدة" hint={`أدخل قيمة عشرية بحد أقصى ${currencies[currencyCode]?.minorUnitScale ?? 2} منازل.`}>
            <Input
              type="text"
              inputMode="decimal"
              dir="ltr"
              value={priceValue}
              onChange={(event) => setPriceValue(event.target.value)}
              placeholder="مثال: 1.250"
              data-testid="input-market-unit-price"
            />
          </Field>
          <Field label="العملة">
            <Select value={currencyCode} onChange={(event) => {
              const nextCurrency = event.target.value;
              setCurrencyCode(nextCurrency);
              if (nextCurrency !== currencyCode) setPriceValue("");
            }} data-testid="select-market-currency">
              <option value="">اختر العملة</option>
              {currencyOptions.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currencyName(currency.code)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-foreground">وقت بدء السعر</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3", timing === "NOW" ? "border-primary bg-primary-soft/50" : "border-border bg-card")}>
              <input type="radio" name="price-timing" value="NOW" checked={timing === "NOW"} onChange={() => setTiming("NOW")} data-testid="radio-price-immediate" />
              <span><span className="block text-sm font-semibold">فورًا</span><span className="block text-xs text-muted-foreground">يبدأ بعد اعتماد العملية</span></span>
            </label>
            <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3", timing === "SCHEDULED" ? "border-primary bg-primary-soft/50" : "border-border bg-card")}>
              <input type="radio" name="price-timing" value="SCHEDULED" checked={timing === "SCHEDULED"} onChange={() => setTiming("SCHEDULED")} data-testid="radio-price-scheduled" />
              <span><span className="block text-sm font-semibold">مجدول</span><span className="block text-xs text-muted-foreground">يبدأ في وقت محلي تختاره</span></span>
            </label>
          </div>
        </fieldset>
        {timing === "SCHEDULED" && (
          <Field label="يبدأ في" hint="سيُحفظ الوقت مع المنطقة الزمنية المحلية لهذا المتصفح.">
            <Input type="datetime-local" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} data-testid="input-price-effective-from" />
          </Field>
        )}
        <Button type="submit" variant="gold" loading={saving} block icon={<Plus size={17} />} data-testid="button-create-market-price">
          إنشاء نسخة سعر
        </Button>
      </form>
      <div className="border-t border-border pt-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="flex items-center gap-2 text-sm font-bold"><Clock3 size={16} aria-hidden /> سجل الأسعار</h4>
          <span className="text-xs text-muted-foreground" data-testid={`text-price-history-count-${market.id}`}>{pricesQuery.data?.length ?? 0} نسخ</span>
        </div>
        {pricesQuery.isLoading ? (
          <div className="space-y-2" aria-busy="true" data-testid="loading-price-history">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : pricesQuery.isError ? (
          <InlineAlert tone="danger" testId="alert-price-history">تعذر تحميل سجل الأسعار.</InlineAlert>
        ) : pricesQuery.data?.length ? (
          <ol className="space-y-2" data-testid={`list-price-history-${market.id}`}>
            {[...pricesQuery.data].reverse().map((price) => (
              <li key={price.id} className="flex items-center gap-3 rounded-lg border border-border bg-muted/45 p-3" data-testid={`row-price-version-${price.id}`}>
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", price.effectiveTo ? "bg-muted text-muted-foreground" : "bg-success-soft text-success")}>
                  {price.effectiveTo ? <Clock3 size={16} aria-hidden /> : <Check size={16} aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="num block font-semibold text-foreground" dir="ltr">{formatMoney(price.unitPriceMinor, price.currencyCode)}</span>
                  <span className="block text-xs text-muted-foreground">
                    يبدأ {dateTimeLabel(price.effectiveFrom)}{price.effectiveTo ? ` · ينتهي ${dateTimeLabel(price.effectiveTo)}` : " · فعال"}
                  </span>
                </span>
                {!price.effectiveTo && <Badge tone="success">فعال</Badge>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-lg border border-dashed border-border-strong p-4 text-center text-sm text-muted-foreground" data-testid="empty-price-history">
            لم يُنشأ سعر لهذا السوق بعد.
          </p>
        )}
      </div>
    </div>
  );
}

function MarketPolicyHistory({ market }: { market: Market }) {
  const history = useGetAdminMarketCategoryPolicyAudit(market.id);
  const categoryQuery = useGetAdminMarketplaceCategories();
  const categoryNames = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map(
            (id) =>
              categoryQuery.data?.find(
                (category) => category.id === id || category.label === id,
              )?.label ?? id,
          )
      : [];
  const renderCategories = (value: unknown) => {
    const names = categoryNames(value);
    return names.length ? names.join("، ") : "لا توجد تصنيفات محظورة";
  };

  return (
    <Card testId={`card-market-policy-history-${market.id}`}>
      <div className="mb-3 flex items-start gap-2">
        <History size={19} className="mt-0.5 text-primary" aria-hidden />
        <div>
          <h3 className="font-bold text-foreground">سجل تغييرات التصنيفات المحظورة</h3>
          <p className="mt-1 text-xs text-muted-foreground">يعرض من غيّر سياسة السوق والقيم قبل التغيير وبعده.</p>
        </div>
      </div>
      {history.isLoading ? (
        <div className="space-y-2" aria-busy="true"><Skeleton className="h-16 w-full" /></div>
      ) : history.isError ? (
        <InlineAlert tone="danger">تعذّر تحميل سجل تغييرات سياسة السوق.</InlineAlert>
      ) : history.data?.length ? (
        <ol className="space-y-3">
          {history.data.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-border bg-muted/35 p-3" data-testid={`row-market-policy-audit-${entry.id}`}>
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="font-semibold">{entry.data.reason === "CATEGORY_RENAMED" ? "تحديث تلقائي بعد تغيير اسم التصنيف" : "تحديث التصنيفات المحظورة"}</span>
                <time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>{dateTimeLabel(entry.createdAt)}</time>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">بواسطة {entry.actorName}</p>
              <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
                <div className="rounded-md bg-background p-3">
                  <p className="text-xs font-semibold text-muted-foreground">قبل التغيير</p>
                  <p className="mt-1">{renderCategories(entry.data.before?.restrictedCategories)}</p>
                </div>
                <div className="rounded-md bg-background p-3">
                  <p className="text-xs font-semibold text-muted-foreground">بعد التغيير</p>
                  <p className="mt-1">{renderCategories(entry.data.after?.restrictedCategories)}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-border-strong p-4 text-center text-sm text-muted-foreground">
          لا توجد تغييرات مسجلة في سياسة هذا السوق.
        </p>
      )}
    </Card>
  );
}
function MarketInspector({ market, onUpdated }: { market: Market; onUpdated: () => void }) {
  return (
    <div className="space-y-4">
      <Card className="border-s-4 border-s-accent bg-card" testId={`card-market-inspector-${market.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-ink text-sm font-bold tracking-wide text-ink-foreground" dir="ltr" data-testid={`text-market-country-code-${market.id}`}>
              {market.countryCode}
            </span>
            <div>
              <h2 className="text-xl font-bold text-foreground" data-testid={`text-selected-market-name-${market.id}`}>{market.countryNameAr}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{market.countryNameEn} · <span className="num" dir="ltr">{market.id}</span></p>
            </div>
          </div>
          <MarketStatusBadge market={market} />
        </div>
        <div className="mt-5 grid gap-x-5 gap-y-3 border-t border-border pt-4 sm:grid-cols-2">
          <Summary rows={[
            { label: "العملة", value: <span className="num" dir="ltr">{market.currencyCode}</span> },
            { label: "السعر الحالي", value: hasUsablePrice(market) ? <span className="num" dir="ltr">{formatMoney(market.unitPriceMinor, market.currencyCode)}</span> : "غير معتمد" },
          ]} />
          <Summary rows={[
            { label: "التنفيذ", value: `${market.fulfilmentMethods.length} طرق` },
            { label: "أهلية البائع", value: market.sellerEligibilityMode === "OPEN" ? "مفتوحة" : "بموافقة" },
          ]} />
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card testId={`card-market-configuration-${market.id}`}><MarketConfigurationForm market={market} onUpdated={onUpdated} /></Card>
        <Card testId={`card-market-prices-${market.id}`}><MarketPricePanel market={market} onPriceCreated={onUpdated} /></Card>
      </div>
      <MarketPolicyHistory market={market} />
    </div>
  );
}

export default function AdminMarketsPage() {
  const { user } = useAccount();
  const queryClient = useQueryClient();
  const marketsQuery = useQuery<Market[]>({
    queryKey: ["admin-markets"],
    queryFn: () => api("/admin/markets") as Promise<Market[]>,
    enabled: user?.role === "ADMIN",
    staleTime: 0,
    refetchOnMount: true,
  });
  const [selectedId, setSelectedId] = useState<string>();
  const markets = marketsQuery.data ?? [];
  const selectedMarket = markets.find((market) => market.id === selectedId) ?? markets[0];

  useEffect(() => {
    if (!selectedId && markets[0]) setSelectedId(markets[0].id);
    if (selectedId && markets.length && !markets.some((market) => market.id === selectedId)) setSelectedId(markets[0].id);
  }, [markets, selectedId]);

  const refreshMarkets = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-markets"] });
    if (selectedMarket) {
      void queryClient.invalidateQueries({
        queryKey: getGetAdminMarketCategoryPolicyAuditQueryKey(
          selectedMarket.id,
        ),
      });
    }
  };

  if (!user) return null;
  if (user.role !== "ADMIN") {
    return (
      <div className="container-app max-w-2xl">
        <PageHeader back="/" title="إدارة الأسواق" />
        <InlineAlert tone="danger" title="الوصول مقيّد" testId="alert-admin-access">
          هذه الصفحة متاحة لإدارة الأسواق فقط.
        </InlineAlert>
      </div>
    );
  }

  return (
    <div className="container-app max-w-[1440px] pb-8">
      <PageHeader
        back="/"
        title="إدارة الأسواق"
        subtitle="جهّز أسواق الدول الحالية دون اختراع أسعار أو تغيير بيانات الدولة."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/admin/promotions"
              className="inline-flex min-h-10 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium hover:border-primary/50"
            >
              إدارة الترويج
            </a>
            <Badge tone="primary" icon={<ShieldCheck size={13} />}>صلاحية إدارة</Badge>
          </div>
        }
      />
      <div className="mb-5 grid gap-3 rounded-xl border border-border bg-primary-soft/35 p-4 md:grid-cols-[1fr_auto] md:items-center md:p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><LockKeyhole size={19} aria-hidden /></span>
          <div>
            <p className="font-semibold text-foreground">السعر جزء من جاهزية السوق</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">لا يصبح السوق نشطًا أو محدودًا حتى يكون له سعر وحدة موجب ونسخة سعر فعالة.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs" data-testid="summary-market-readiness">
          <Badge tone="success">{markets.filter((market) => market.isActive && hasUsablePrice(market)).length} جاهزة</Badge>
          <Badge tone="warning">{markets.filter((market) => !hasUsablePrice(market)).length} بلا سعر</Badge>
          <Badge tone="neutral">{markets.length} سوقًا</Badge>
        </div>
      </div>
      {marketsQuery.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,390px)_1fr]" aria-busy="true" data-testid="loading-admin-markets">
          <Card><Skeleton className="mb-4 h-10 w-40" /><Skeleton className="mb-3 h-11 w-full" /><Skeleton className="h-[440px] w-full" /></Card>
          <Card><Skeleton className="mb-4 h-20 w-full" /><Skeleton className="h-[520px] w-full" /></Card>
        </div>
      ) : marketsQuery.isError ? (
        <Card><ErrorState onRetry={() => void marketsQuery.refetch()} /></Card>
      ) : markets.length === 0 ? (
        <Card><EmptyState icon={MapPinned} title="لا توجد أسواق" body="لم يعرض الخادم أي سوق لإدارته." testId="empty-admin-markets-page" /></Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,390px)_minmax(0,1fr)]">
          <MarketList markets={markets} selectedId={selectedMarket?.id} onSelect={setSelectedId} />
          {selectedMarket ? <MarketInspector market={selectedMarket} onUpdated={refreshMarkets} /> : null}
        </div>
      )}
    </div>
  );
}
