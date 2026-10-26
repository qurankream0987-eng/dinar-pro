import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Clock, SearchX, SlidersHorizontal, X, Search as SearchIcon } from "lucide-react";
import { useGetListings, useGetMarketplaceCategories } from "@workspace/api-client-react";
import type { SearchSort } from "@workspace/api-zod/marketplace-schemas";
import { FULFILMENT, categoryIcon, remainingOf, type Offer } from "@/lib/marketplace";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { Button, iconButtonClass, buttonClass } from "@/ui/Button";
import { Chip } from "@/ui/Field";
import { EmptyState, ErrorState } from "@/ui/Feedback";
import { BackButton } from "@/ui/Layout";
import { Sheet } from "@/ui/Sheet";
import { OfferCard, OfferGrid, OfferGridSkeleton } from "@/features/OfferCard";

const RECENT_KEY = "bdinar-recent-searches";
type Sort = SearchSort | "";
type Filters = { category: string; fulfilment: string; city: string; inStock: boolean; sort: Sort };
const EMPTY: Filters = { category: "", fulfilment: "", city: "", inStock: false, sort: "" };

function readRecent(): string[] {
  try {
    const v = JSON.parse(storage.get(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function SearchPage() {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [filters, setFilters] = useState<Filters>({ ...EMPTY, category: params.get("category") ?? "" });
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState<Filters>(filters);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [focused, setFocused] = useState(!params.get("q") && !params.get("category"));
  const input = useRef<HTMLInputElement>(null);
  const term = useDebounced(query.trim());
  const categoryQuery = useGetMarketplaceCategories();
  const categoryRows = categoryQuery.data ?? [];
  const categories = categoryRows.map((category) => category.label);
  const selectedCategory = categoryRows.find(
    (category) => category.label === filters.category,
  );
  const sharedSortIds = categoryRows.length
    ? categoryRows.slice(1).reduce(
        (ids, category) =>
          ids.filter((id) =>
            category.rules.sorting.options.some((option) => option.id === id),
          ),
        categoryRows[0].rules.sorting.options.map((option) => option.id),
      )
    : [];
  const sharedSortOptions =
    categoryRows[0]?.rules.sorting.options.filter((option) =>
      sharedSortIds.includes(option.id) && option.field !== "ATTRIBUTE",
    ) ?? [];
  const sortOptions =
    selectedCategory?.rules.sorting.options ?? sharedSortOptions;
  const globalDefaultSort = categoryRows[0]?.rules.sorting.defaultSort;
  const sharedDefaultSort =
    globalDefaultSort &&
    sharedSortOptions.some((option) => option.id === globalDefaultSort)
      ? globalDefaultSort
      : sharedSortOptions.find(
          (option) => option.field === "CREATED_AT" && option.direction === "DESC",
        )?.id ??
        sharedSortOptions[0]?.id ??
        "";
  const defaultSort =
    selectedCategory?.rules.sorting.defaultSort ??
    sharedDefaultSort;
  const activeSort =
    sortOptions.some((option) => option.id === filters.sort)
      ? filters.sort
      : defaultSort;
  const draftCategory = categoryRows.find(
    (category) => category.label === draft.category,
  );
  const draftSortOptions =
    draftCategory?.rules.sorting.options ?? sharedSortOptions;
  const draftDefaultSort =
    draftCategory?.rules.sorting.defaultSort ??
    sharedDefaultSort;
  const activeDraftSort =
    draftSortOptions.some((option) => option.id === draft.sort)
      ? draft.sort
      : draftDefaultSort;

  useEffect(() => {
    if (focused) input.current?.focus();
    // focus once on arrival only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL shareable without adding history entries per keystroke.
  useEffect(() => {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (filters.category) next.set("category", filters.category);
    const qs = next.toString();
    navigate(qs ? `/search?${qs}` : "/search", { replace: true });
  }, [term, filters.category, navigate]);

  const listings = useGetListings({
    status: "PUBLISHED",
    search: term || undefined,
    category: filters.category || undefined,
    sort: activeSort || undefined,
  });
  const all = (listings.data ?? []) as Offer[];

  const cities = useMemo(
    () => [...new Set(all.map((o) => (o.city || "").trim()).filter(Boolean))],
    [all],
  );

  const results = useMemo(() => {
    let r = all.filter(
      (o) =>
        (!filters.fulfilment || o.fulfilmentType === filters.fulfilment) &&
        (!filters.city || (o.city || "").trim() === filters.city) &&
        (!filters.inStock || remainingOf(o) !== 0),
    );
    return r;
  }, [all, filters]);

  const activeCount =
    (filters.category ? 1 : 0) +
    (filters.fulfilment ? 1 : 0) +
    (filters.city ? 1 : 0) +
    (filters.inStock ? 1 : 0) +
    (activeSort && activeSort !== defaultSort ? 1 : 0);

  const remember = (value: string) => {
    const v = value.trim();
    if (!v) return;
    const next = [v, ...recent.filter((r) => r !== v)].slice(0, 6);
    setRecent(next);
    storage.set(RECENT_KEY, JSON.stringify(next));
  };

  const showDiscovery = focused && !query.trim() && !filters.category;
  const suggestions =
    focused && query.trim().length >= 1
      ? [...new Set(all.map((o) => o.title))].filter((t) => t !== query.trim()).slice(0, 5)
      : [];

  return (
    <div className="container-app pt-3 md:pt-6">
      {/* Search field */}
      <div className="sticky top-[var(--topbar-h)] z-[var(--z-sticky)] -mx-[var(--gutter)] bg-background/95 px-[var(--gutter)] pb-3 pt-1 backdrop-blur">
        <form
          role="search"
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            remember(query);
            setFocused(false);
            input.current?.blur();
          }}
        >
          <span className="md:hidden">
            <BackButton to="/" />
          </span>
          <div className="relative flex-1">
            <SearchIcon size={19} className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              placeholder="ماذا تبحث عنه؟"
              aria-label="ابحث في العروض"
              data-testid="input-search-query"
              className="h-12 w-full rounded-full border border-border bg-card pe-11 ps-11 text-md shadow-xs outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/10"
            />
            {query && (
              <button
                type="button"
                aria-label="مسح البحث"
                onClick={() => {
                  setQuery("");
                  input.current?.focus();
                }}
                className={`${iconButtonClass("ghost")} absolute end-2 top-1/2 -translate-y-1/2`}
              >
                <X size={17} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft(filters);
              setSheet(true);
            }}
            aria-label={activeCount ? `الفلاتر والترتيب، ${activeCount} مفعّل` : "الفلاتر والترتيب"}
            data-testid="button-filters"
            className={cn(
              iconButtonClass("outline"),
              activeCount ? "border-primary bg-primary-soft text-primary-soft-foreground" : "border-border bg-card text-foreground hover:border-border-strong",
            )}
          >
            <SlidersHorizontal size={19} aria-hidden />
            {activeCount > 0 && (
              <span className="num absolute -end-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </button>
        </form>

        {/* Quick category chips */}
        <div className="-mx-[var(--gutter)] mt-3 overflow-x-auto scrollbar-none">
          <div className="flex gap-2 px-[var(--gutter)]">
            <Chip active={!filters.category} onClick={() => setFilters((f) => ({ ...f, category: "" }))}>
              الكل
            </Chip>
            {categories.map((c) => {
              const Icon = categoryIcon(c);
              return (
                <Chip
                  key={c}
                  active={filters.category === c}
                  icon={<Icon size={15} aria-hidden />}
                  onClick={() => setFilters((f) => ({ ...f, category: f.category === c ? "" : c }))}
                  testId={`chip-category-${c}`}
                >
                  {c}
                </Chip>
              );
            })}
          </div>
        </div>
      </div>

      {/* Suggestions while typing */}
      {suggestions.length > 0 && (
        <ul aria-label="اقتراحات" className="mb-4 overflow-hidden rounded-xl border border-border bg-card">
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery(s);
                  remember(s);
                  setFocused(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-start text-base hover:bg-muted"
              >
                <SearchIcon size={16} className="text-muted-foreground" aria-hidden />
                <span className="truncate">{s}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Recent searches */}
      {showDiscovery && recent.length > 0 && (
        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-md font-bold">عمليات بحث سابقة</h2>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setRecent([]);
                storage.remove(RECENT_KEY);
              }}
              className={buttonClass("ghost", "sm")}
            >
              مسح
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <Chip
                key={r}
                icon={<Clock size={14} aria-hidden />}
                onClick={() => {
                  setQuery(r);
                  setFocused(false);
                }}
              >
                {r}
              </Chip>
            ))}
          </div>
        </section>
      )}

      {/* Results */}
      <section aria-live="polite" aria-busy={listings.isFetching}>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm text-muted-foreground" data-testid="text-results-count">
            {listings.isLoading ? "جارٍ البحث…" : `${results.length} عرض`}
            {term && !listings.isLoading && <> لـ «{term}»</>}
          </p>
          {activeCount > 0 && (
            <button type="button" onClick={() => setFilters({ ...EMPTY })} className={buttonClass("ghost", "sm")}>
              مسح الفلاتر
            </button>
          )}
        </div>
        {listings.isLoading ? (
          <OfferGridSkeleton count={6} />
        ) : listings.isError ? (
          <ErrorState onRetry={() => listings.refetch()} />
        ) : results.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="لا توجد نتائج مطابقة"
            body={term ? "جرّب كلمة أقصر أو تصنيفًا آخر." : "لا توجد عروض بهذه الفلاتر حاليًا."}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setFilters({ ...EMPTY });
                }}
                data-testid="button-clear-filters"
              >
                عرض كل العروض
              </Button>
            }
            testId="state-search-empty"
          />
        ) : (
          <OfferGrid>
            {results.map((o, i) => (
              <OfferCard key={o.id} offer={o} eager={i < 4} />
            ))}
          </OfferGrid>
        )}
      </section>

      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="الفلاتر والترتيب"
        testId="sheet-filters"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setDraft({ ...EMPTY })}>
              إعادة ضبط
            </Button>
            <Button
              block
              onClick={() => {
                setFilters(draft);
                setSheet(false);
              }}
              data-testid="button-apply-filters"
            >
              عرض النتائج
            </Button>
          </div>
        }
      >
        <div className="space-y-6 pb-2">
          <FilterGroup title="الترتيب">
            {draftSortOptions.map((option) => (
              <Chip
                key={option.id}
                active={activeDraftSort === option.id}
                onClick={() => setDraft({ ...draft, sort: option.id })}
                testId={`chip-sort-${option.id}`}
              >
                {option.label}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup title="التصنيف">
            <Chip active={!draft.category} onClick={() => setDraft({ ...draft, category: "", sort: "" })}>
              الكل
            </Chip>
            {categories.map((c) => (
              <Chip key={c} active={draft.category === c} onClick={() => setDraft({ ...draft, category: c, sort: "" })}>
                {c}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup title="طريقة التنفيذ">
            <Chip active={!draft.fulfilment} onClick={() => setDraft({ ...draft, fulfilment: "" })}>
              الكل
            </Chip>
            {Object.entries(FULFILMENT).map(([k, v]) => {
              const Icon = v.icon;
              return (
                <Chip key={k} active={draft.fulfilment === k} icon={<Icon size={15} aria-hidden />} onClick={() => setDraft({ ...draft, fulfilment: k })}>
                  {v.label}
                </Chip>
              );
            })}
          </FilterGroup>
          {cities.length > 1 && (
            <FilterGroup title="المدينة">
              <Chip active={!draft.city} onClick={() => setDraft({ ...draft, city: "" })}>
                كل المدن
              </Chip>
              {cities.map((c) => (
                <Chip key={c} active={draft.city === c} onClick={() => setDraft({ ...draft, city: c })}>
                  {c}
                </Chip>
              ))}
            </FilterGroup>
          )}
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-4">
            <span>
              <span className="block text-md font-semibold">المتوفر فقط</span>
              <span className="block text-sm text-muted-foreground">إخفاء العروض التي نفدت كميتها</span>
            </span>
            <Switch checked={draft.inStock} onChange={(v) => setDraft({ ...draft, inStock: v })} label="المتوفر فقط" />
          </label>
        </div>
      </Sheet>
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2.5 text-md font-bold">{title}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "dinar-switch relative inline-flex h-11 w-12 shrink-0 items-center rounded-full",
        checked ? "text-primary" : "text-border-strong",
      )}
    >
      <span
        className={cn(
          "absolute top-3 h-5 w-5 rounded-full bg-white shadow-sm",
          checked ? "start-6" : "start-1",
        )}
      />
    </button>
  );
}
