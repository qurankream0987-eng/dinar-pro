import { useState } from "react";
import { Layers3 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAdminMarketplaceCategoriesQueryKey,
  useCreateMarketplaceCategory,
  useGetAdminMarketplaceCategoryAudit,
  useGetAdminMarketplaceCategories,
  useUpdateMarketplaceCategory,
  type MarketplaceCategory,
} from "@workspace/api-client-react";
import { defaultMarketplaceCategoryRules } from "@workspace/api-zod/marketplace-schemas";
import { friendlyError } from "@/lib/errors";
import { useAccount } from "@/account/Account";
import { Button } from "@/ui/Button";
import { EmptyState, ErrorState, InlineAlert } from "@/ui/Feedback";
import { Field, Input, Textarea } from "@/ui/Field";
import { PageHeader } from "@/ui/Layout";

type CategoryForm = {
  id: string;
  label: string;
  labelEn: string;
  aliases: string;
  resourceType: "PRODUCT" | "SERVICE" | "MIXED";
  attributes: string;
  searchFilters: string;
  rules: string;
  allowAdditionalAttributes: boolean;
  isActive: boolean;
};

const blankForm = (): CategoryForm => ({
  id: "",
  label: "",
  labelEn: "",
  aliases: "",
  resourceType: "PRODUCT",
  attributes: "{}",
  searchFilters: "{}",
  rules: JSON.stringify(defaultMarketplaceCategoryRules(), null, 2),
  allowAdditionalAttributes: false,
  isActive: true,
});

function fromCategory(category: MarketplaceCategory): CategoryForm {
  return {
    id: category.id,
    label: category.label,
    labelEn: category.labelEn,
    aliases: category.aliases.join(", "),
    resourceType: category.resourceType,
    attributes: JSON.stringify(category.attributes, null, 2),
    searchFilters: JSON.stringify(category.searchFilters, null, 2),
    rules: JSON.stringify(category.rules, null, 2),
    allowAdditionalAttributes: category.allowAdditionalAttributes,
    isActive: category.isActive,
  };
}

function parseObject<T>(
  value: string,
  label: string,
): T {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label} يجب أن يكون كائن JSON.`);
  return parsed as T;
}

function CategoryAuditHistory({ categoryId }: { categoryId: string }) {
  const history = useGetAdminMarketplaceCategoryAudit(categoryId);

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4 md:p-6" aria-labelledby="category-audit-title">
      <h2 id="category-audit-title" className="text-md font-bold">سجل تغييرات التصنيف</h2>
      {history.isLoading ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">جارٍ تحميل السجل…</p>
      ) : history.isError ? (
        <InlineAlert tone="danger">تعذّر تحميل سجل التغييرات.</InlineAlert>
      ) : history.data?.length ? (
        <ol className="space-y-3">
          {history.data.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-border bg-muted/35 p-3">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="font-semibold">{entry.action === "CREATE" ? "إنشاء التصنيف" : "تحديث التصنيف"}</span>
                <time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>
                  {new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}
                </time>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">بواسطة {entry.actorName}</p>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-primary">عرض القيم السابقة والجديدة</summary>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-muted-foreground">قبل التغيير</h3>
                    <pre className="max-h-64 overflow-auto rounded-md bg-background p-3 text-xs" dir="ltr">{entry.before ? JSON.stringify(entry.before, null, 2) : "لا توجد قيمة سابقة"}</pre>
                  </div>
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-muted-foreground">بعد التغيير</h3>
                    <pre className="max-h-64 overflow-auto rounded-md bg-background p-3 text-xs" dir="ltr">{JSON.stringify(entry.after, null, 2)}</pre>
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-border-strong p-4 text-center text-sm text-muted-foreground">
          لا توجد تغييرات مسجلة لهذا التصنيف.
        </p>
      )}
    </section>
  );
}

export default function AdminCategoriesPage() {
  const { user } = useAccount();
  const queryClient = useQueryClient();
  const categories = useGetAdminMarketplaceCategories();
  const create = useCreateMarketplaceCategory();
  const update = useUpdateMarketplaceCategory();
  const [form, setForm] = useState<CategoryForm>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = create.isPending || update.isPending;

  if (!user) return null;
  if (user.role !== "ADMIN") {
    return (
      <div className="container-app max-w-2xl">
        <PageHeader back="/" title="إدارة التصنيفات" />
        <InlineAlert tone="danger" title="الوصول مقيّد">
          هذه الصفحة متاحة لإدارة التصنيفات فقط.
        </InlineAlert>
      </div>
    );
  }

  const reset = () => {
    setForm(blankForm());
    setEditingId(null);
    setError("");
    setNotice("");
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      const attributes = parseObject<MarketplaceCategory["attributes"]>(
        form.attributes,
        "الخصائص",
      );
      const searchFilters = parseObject<MarketplaceCategory["searchFilters"]>(
        form.searchFilters,
        "مرشحات البحث",
      );
      const rules = parseObject<MarketplaceCategory["rules"]>(
        form.rules,
        "قواعد سلوك الفئة",
      );
      const aliases = form.aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      if (editingId) {
        await update.mutateAsync({
          id: editingId,
          data: {
            label: form.label.trim(),
            labelEn: form.labelEn.trim(),
            aliases,
            resourceType: form.resourceType,
            attributes,
            searchFilters,
            rules,
            allowAdditionalAttributes: form.allowAdditionalAttributes,
            isActive: form.isActive,
          },
        });
        setNotice("تم حفظ التصنيف.");
      } else {
        await create.mutateAsync({
          data: {
            id: form.id.trim(),
            label: form.label.trim(),
            labelEn: form.labelEn.trim(),
            parentId: null,
            aliases,
            resourceType: form.resourceType,
            renderer: "GENERIC",
            attributes,
            searchFilters,
            rules,
            allowAdditionalAttributes: form.allowAdditionalAttributes,
            isActive: form.isActive,
          },
        });
        setNotice("تمت إضافة التصنيف.");
        setForm(blankForm());
      }
      await queryClient.invalidateQueries({
        queryKey: getGetAdminMarketplaceCategoriesQueryKey(),
      });
      await queryClient.invalidateQueries();
      setEditingId(null);
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "تحقق من صيغة JSON في الخصائص ومرشحات البحث."
          : friendlyError(cause, "تعذر حفظ التصنيف."),
      );
    }
  };

  if (categories.isLoading)
    return <div className="container-app py-8" aria-busy="true">جارٍ تحميل التصنيفات…</div>;
  if (categories.isError || !categories.data)
    return (
      <div className="container-app py-8">
        <ErrorState title="تعذّر تحميل التصنيفات" onRetry={() => categories.refetch()} />
      </div>
    );

  return (
    <div className="container-app max-w-5xl py-6">
      <PageHeader
        back="/"
        title="إدارة التصنيفات"
        subtitle="أضف فئات المنتجات والخدمات وحقولها من البيانات، من دون تعديل محرك السوق."
        actions={
          <a
            href="/admin/promotions"
            className="inline-flex min-h-10 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium hover:border-primary/50"
          >
            إدارة الترويج
          </a>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="space-y-3">
          <h2 className="text-md font-bold">التصنيفات الحالية</h2>
          {categories.data.length === 0 ? (
            <EmptyState
              icon={Layers3}
              title="لا توجد تصنيفات"
              body="أضف أول تصنيف من النموذج."
            />
          ) : (
            <ul className="space-y-2">
              {categories.data.map((category) => (
                <li key={category.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setForm(fromCategory(category));
                      setEditingId(category.id);
                      setError("");
                      setNotice("");
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-start hover:border-primary/50"
                    aria-label={`تعديل ${category.label}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{category.label}</span>
                      <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                        {category.id} · {category.resourceType}
                      </span>
                    </span>
                    <span className={category.isActive ? "text-xs text-success" : "text-xs text-muted-foreground"}>
                      {category.isActive ? "نشط" : "متوقف"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-4">
        <form onSubmit={save} className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-md font-bold">
              {editingId ? `تعديل: ${form.label}` : "إضافة تصنيف"}
            </h2>
            {editingId && (
              <Button type="button" variant="ghost" onClick={reset}>
                تصنيف جديد
              </Button>
            )}
          </div>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
          {!editingId && (
            <Field label="معرّف ثابت بالإنجليزية" hint="مثال: agricultural-equipment">
              <Input
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={80}
                dir="ltr"
                value={form.id}
                onChange={(event) => setForm({ ...form, id: event.target.value })}
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="اسم التصنيف بالعربية">
              <Input required maxLength={100} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
            </Field>
            <Field label="Name in English">
              <Input required maxLength={100} dir="ltr" value={form.labelEn} onChange={(event) => setForm({ ...form, labelEn: event.target.value })} />
            </Field>
          </div>
          <Field label="كلمات بديلة" hint="افصل بين الكلمات بفواصل، ليستطيع البحث والتصنيف فهمها.">
            <Input value={form.aliases} onChange={(event) => setForm({ ...form, aliases: event.target.value })} />
          </Field>
          <Field label="نوع المعروض">
            <select
              className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
              value={form.resourceType}
              onChange={(event) => {
                const resourceType = event.target.value as CategoryForm["resourceType"];
                const previousDefault = JSON.stringify(
                  defaultMarketplaceCategoryRules(form.resourceType),
                  null,
                  2,
                );
                setForm({
                  ...form,
                  resourceType,
                  ...(form.rules === previousDefault
                    ? {
                        rules: JSON.stringify(
                          defaultMarketplaceCategoryRules(resourceType),
                          null,
                          2,
                        ),
                      }
                    : {}),
                });
              }}
            >
              <option value="PRODUCT">منتج</option>
              <option value="SERVICE">خدمة</option>
              <option value="MIXED">منتج أو خدمة</option>
            </select>
          </Field>
          <Field label="حقول الفئة (JSON)" hint='مثال: {"brand":{"label":"العلامة","type":"string","operators":["eq","contains"],"requiredForPublish":true}}'>
            <Textarea dir="ltr" rows={6} value={form.attributes} onChange={(event) => setForm({ ...form, attributes: event.target.value })} />
          </Field>
          <Field label="حقول البحث المفلترة (JSON)" hint="عرّف الحقول القابلة للبحث ومشغلاتها بنفس بنية الحقول أعلاه.">
            <Textarea dir="ltr" rows={4} value={form.searchFilters} onChange={(event) => setForm({ ...form, searchFilters: event.target.value })} />
          </Field>
          <Field
            label="قواعد سلوك الفئة (JSON)"
            hint="تحدد الحقول الظاهرة، الترتيب، طرق التسعير، المخزون، وحقول مسودة البائع. يجب أن تشير حقول العرض والترتيب إلى تعريفات صحيحة أعلاه."
          >
            <Textarea
              dir="ltr"
              rows={14}
              value={form.rules}
              onChange={(event) => setForm({ ...form, rules: event.target.value })}
              data-testid="textarea-category-rules"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.allowAdditionalAttributes}
              onChange={(event) => setForm({ ...form, allowAdditionalAttributes: event.target.checked })}
            />
            السماح بخصائص إضافية غير معرفة أعلاه
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
            />
            التصنيف نشط ويظهر للبائعين
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "جارٍ الحفظ…" : editingId ? "حفظ التغييرات" : "إضافة التصنيف"}
            </Button>
            {!editingId && (
              <Button type="button" variant="secondary" onClick={reset}>
                مسح
              </Button>
            )}
          </div>
        </form>
        {editingId && <CategoryAuditHistory categoryId={editingId} />}
        </div>
      </div>
    </div>
  );
}