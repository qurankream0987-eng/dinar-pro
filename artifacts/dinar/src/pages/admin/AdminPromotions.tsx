import { useEffect, useState, type FormEvent } from "react";
import { Megaphone } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAdminPromotionProductsQueryKey,
  getGetPromotionProductsQueryKey,
  useCreateAdminPromotionProduct,
  useGetAdminMarketplaceCategories,
  useGetAdminPromotionProducts,
  useUpdateAdminPromotionProduct,
  type PromotionProduct,
} from "@workspace/api-client-react";
import { formatMoney, minorToDecimal } from "@workspace/global";
import { useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "@/ui/Feedback";
import { Field, Input } from "@/ui/Field";
import { PageHeader } from "@/ui/Layout";

type PromotionForm = {
  categoryId: string;
  name: string;
  price: string;
  durationDays: string;
  enabled: boolean;
};

const blankForm = (): PromotionForm => ({
  categoryId: "",
  name: "",
  price: "",
  durationDays: "7",
  enabled: true,
});

function fromProduct(product: PromotionProduct): PromotionForm {
  return {
    categoryId: product.categoryId ?? "",
    name: product.name,
    price: minorToDecimal(product.priceMinor, product.currencyCode),
    durationDays: String(product.durationDays),
    enabled: product.enabled,
  };
}

function priceToMinor(value: string, scale: number) {
  const amount = Number(value);
  const factor = 10 ** scale;
  const minor = Math.round(amount * factor);
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(minor) ||
    Math.abs(amount * factor - minor) > 0.000001
  ) {
    throw new Error("أدخل سعرًا موجبًا بدقة العملة المحددة للسوق.");
  }
  return minor;
}

function AdminNavigation() {
  return (
    <nav aria-label="أدوات الإدارة" className="mb-5 flex flex-wrap gap-2">
      <a
        href="/admin/markets"
        className="rounded-lg border border-border bg-card px-3 py-2 text-sm hover:border-primary/50"
      >
        الأسواق
      </a>
      <a
        href="/admin/categories"
        className="rounded-lg border border-border bg-card px-3 py-2 text-sm hover:border-primary/50"
      >
        التصنيفات
      </a>
      <span className="rounded-lg border border-primary/40 bg-primary-soft px-3 py-2 text-sm font-semibold text-primary">
        الترويج
      </span>
    </nav>
  );
}

export default function AdminPromotionsPage() {
  const { user, market, markets } = useAccount();
  const queryClient = useQueryClient();
  const categories = useGetAdminMarketplaceCategories();
  const create = useCreateAdminPromotionProduct();
  const update = useUpdateAdminPromotionProduct();
  const [marketId, setMarketId] = useState(market?.id ?? "");
  const [form, setForm] = useState<PromotionForm>(blankForm);
  const [editing, setEditing] = useState<PromotionProduct | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = create.isPending || update.isPending;
  const products = useGetAdminPromotionProducts(marketId, {
    query: {
      enabled: Boolean(marketId),
      queryKey: getGetAdminPromotionProductsQueryKey(marketId),
    },
  });
  // This editor manages Block E plans; the rest of the commercial catalog has its own admin API.
  const standardPlans = (products.data ?? []).filter((product) => !product.productType || product.productType === "STANDARD_PROMOTION");
  const selectedMarket = markets.find((item) => item.id === marketId);
  const activeCategories = (categories.data ?? []).filter(
    (category) => category.isActive,
  );

  useEffect(() => {
    if (!marketId && market?.id) setMarketId(market.id);
  }, [market?.id, marketId]);

  const reset = () => {
    setEditing(null);
    setForm(blankForm());
    setError("");
    setNotice("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!selectedMarket) {
      setError("اختر سوقًا صالحًا أولًا.");
      return;
    }
    try {
      const name = form.name.trim();
      const durationDays = Number(form.durationDays);
      if (!name) throw new Error("أدخل اسمًا لخطة الترويج.");
      if (!form.categoryId) throw new Error("اختر تصنيفًا.");
      if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365)
        throw new Error("مدة الترويج يجب أن تكون من يوم إلى 365 يومًا.");
      const common = {
        categoryId: form.categoryId,
        name,
        placement: "SEARCH_AND_CHAT" as const,
        priceMinor: priceToMinor(form.price, selectedMarket.minorUnitScale),
        durationDays,
        enabled: form.enabled,
      };
      if (editing) {
        await update.mutateAsync({
          marketId,
          id: editing.id,
          data: common,
        });
      } else {
        await create.mutateAsync({ marketId, data: common });
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetAdminPromotionProductsQueryKey(marketId),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetPromotionProductsQueryKey(),
        }),
      ]);
      setNotice(
        editing
          ? "تم تحديث الخطة. الحملات الحالية تحتفظ بسعرها ومدتها الأصليين."
          : "تمت إضافة الخطة إلى السوق.",
      );
      setEditing(null);
      setForm(blankForm());
    } catch (saveError) {
      setError(friendlyError(saveError));
    }
  };

  if (!user) return null;
  if (user.role !== "ADMIN") {
    return (
      <div className="container-app max-w-2xl">
        <PageHeader back="/" title="إدارة الترويج" />
        <InlineAlert tone="danger" title="الوصول مقيّد">
          هذه الصفحة متاحة لإدارة السوق فقط.
        </InlineAlert>
      </div>
    );
  }

  return (
    <div className="container-app max-w-6xl space-y-5 py-6">
      <PageHeader
        back="/"
        title="إدارة الترويج"
        subtitle="اضبط خطط الترويج وأسعارها حسب السوق والتصنيف."
      />
      <AdminNavigation />
      <InlineAlert tone="warning" title="لا توجد مدفوعات فعلية">
        الترويج التجريبي لا يخصم أو يحصّل أموالًا، ولا ينشئ فواتير أو محافظ أو
        مستحقات. تشغيل الظهور الممول يخضع لإعدادات البيئة ولا يفعّل ترتيبًا
        إنتاجيًا.
      </InlineAlert>

      <section className="rounded-xl border border-border bg-card p-4 md:p-5">
        <Field label="السوق">
          <select
            className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
            value={marketId}
            onChange={(event) => {
              setMarketId(event.target.value);
              reset();
            }}
          >
            {markets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.countryNameAr} · {item.currencyCode}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">الخطط الحالية</h2>
          {products.isLoading || categories.isLoading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
            </div>
          ) : products.isError || categories.isError ? (
            <ErrorState
              title="تعذّر تحميل خطط الترويج"
              onRetry={() => {
                void products.refetch();
                void categories.refetch();
              }}
            />
          ) : standardPlans.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="لا توجد خطط لهذا السوق"
              body="أضف خطة من النموذج. ستبقى غير متاحة للبائعين إذا أوقفتها."
            />
          ) : (
            <ul className="space-y-2">
              {standardPlans.map((product) => (
                <li
                  key={product.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{product.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {categories.data?.find(
                        (category) => category.id === product.categoryId,
                      )?.label ?? product.categoryId}
                      {" · "}
                      {formatMoney(product.priceMinor, product.currencyCode)}
                      {" · "}
                      {product.durationDays} يومًا
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {product.enabled ? "متاحة للبائعين" : "متوقفة"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setEditing(product);
                      setForm(fromProduct(product));
                      setError("");
                      setNotice("");
                    }}
                  >
                    تعديل
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form
          onSubmit={save}
          className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {editing ? `تعديل: ${editing.name}` : "إضافة خطة"}
            </h2>
            {editing && (
              <Button type="button" variant="ghost" onClick={reset}>
                خطة جديدة
              </Button>
            )}
          </div>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
          <Field label="التصنيف">
            <select
              required
              className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
              value={form.categoryId}
              onChange={(event) =>
                setForm({ ...form, categoryId: event.target.value })
              }
            >
              <option value="">اختر تصنيفًا</option>
              {activeCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="اسم الخطة">
            <Input
              required
              maxLength={100}
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={`السعر (${selectedMarket?.currencyCode ?? "—"})`}
              hint="يُحفظ بعملة السوق. لا يحدث أي خصم فعلي."
            >
              <Input
                required
                type="number"
                min="0"
                step={
                  selectedMarket
                    ? 1 / 10 ** selectedMarket.minorUnitScale
                    : "any"
                }
                inputMode="decimal"
                value={form.price}
                onChange={(event) =>
                  setForm({ ...form, price: event.target.value })
                }
              />
            </Field>
            <Field label="المدة بالأيام">
              <Input
                required
                type="number"
                min="1"
                max="365"
                step="1"
                value={form.durationDays}
                onChange={(event) =>
                  setForm({ ...form, durationDays: event.target.value })
                }
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
            />
            الخطة متاحة للبائعين
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            الموضع الحالي ثابت: نتائج البحث ومحادثة جاسم. تعديل الخطة لا يغيّر
            سعر أو مدة حملة سابقة.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !marketId}>
              {busy ? "جارٍ الحفظ…" : editing ? "حفظ التعديل" : "إضافة الخطة"}
            </Button>
            {(form.name || form.categoryId || form.price) && !busy && (
              <Button type="button" variant="ghost" onClick={reset}>
                إلغاء
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}