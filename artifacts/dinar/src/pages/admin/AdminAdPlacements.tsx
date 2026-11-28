import { useEffect, useState, type FormEvent } from "react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { PageHeader } from "@/ui/Layout";

/**
 * Jassim Ads placement catalog (admin). Every price, duration, accepted subject and capacity is a
 * market product on the server (versioned by pricingVersion, audited in market_audit); nothing here
 * is hard-coded. A price change is a new product version: disable the old one, add the new one.
 */
type Product = {
  id: string; name: string; productType: string; productTypeLabel: string; placement: string; categoryId: string | null; priceLabel: string; durationDays: number;
  pricingUnit: string; minDays: number | null; maxDays: number | null; subjectKinds: string[]; capacity: number | null; description: string; pricingVersion: number; enabled?: boolean;
};
const TYPES: [string, string][] = [
  ["HERO_BANNER", "الشريط الإعلاني الرئيسي (Hero)"],
  ["SIDEBAR_AD", "الشريط الجانبي (Sidebar)"],
  ["FEATURED_LISTING", "بطاقات المنتجات المميزة"],
  ["SPONSORED_SEARCH", "إبراز ضمن نتائج البحث"],
  ["SPONSORED_RECOMMENDATION", "اقتراح ممول داخل المحادثة"],
  ["DEMAND_CAPTURE", "جاسم روح بيع لي (تنبيه الطلبات)"],
  ["VIP_LISTING", "VIP"],
];
const AD_TYPES = new Set(TYPES.map(([type]) => type));

export default function AdminAdPlacementsPage() {
  const { markets, market } = useAccount();
  const [marketId, setMarketId] = useState(market?.id ?? "");
  const selected = markets.find((item) => item.id === marketId);
  const [rows, setRows] = useState<Product[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ productType: "SIDEBAR_AD", name: "", description: "", categoryId: "", price: "", pricingUnit: "DAY", durationDays: "7", minDays: "1", maxDays: "30", store: true, capacity: "", pricingVersion: "1" });
  const load = async () => {
    if (!marketId) return;
    try {
      setRows(((await api(`/admin/markets/${encodeURIComponent(marketId)}/commercial-products`)) as Product[]).filter((row) => AD_TYPES.has(row.productType)));
      setError("");
    } catch (e) {
      setError(friendlyError(e, "تعذر تحميل المواضع."));
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [marketId]);
  const display = form.productType === "HERO_BANNER" || form.productType === "SIDEBAR_AD";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setNotice("");
    try {
      if (!selected) throw new Error("اختر السوق.");
      const price = Number(form.price);
      if (!(price > 0)) throw new Error("أدخل سعرًا صحيحًا.");
      const priceMinor = Math.round(price * 10 ** selected.minorUnitScale);
      await api(`/admin/markets/${encodeURIComponent(selected.id)}/commercial-products`, "POST", {
        name: form.name.trim(), productType: form.productType, description: form.description.trim(),
        ...(form.categoryId.trim() ? { categoryId: form.categoryId.trim() } : {}),
        priceMinor, durationDays: Number(form.durationDays), pricingUnit: form.pricingUnit,
        ...(form.pricingUnit === "DAY" ? { minDays: Number(form.minDays), maxDays: Number(form.maxDays) } : {}),
        subjectKinds: display && form.store ? ["LISTING", "STORE"] : ["LISTING"],
        ...(form.capacity ? { capacity: Number(form.capacity) } : {}),
        pricingVersion: Number(form.pricingVersion) || 1,
      });
      setNotice("أُضيف الموضع وسُجّل في سجل التدقيق.");
      await load();
    } catch (e) {
      setError(friendlyError(e, "تعذر إضافة الموضع."));
    }
  };
  const toggle = async (row: Product) => {
    try {
      await api(`/admin/commercial-products/${encodeURIComponent(row.id)}`, "PATCH", { enabled: !row.enabled });
      await load();
    } catch (e) {
      setError(friendlyError(e, "تعذر تغيير الحالة."));
    }
  };
  const input = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4" dir="rtl" data-testid="admin-ad-placements">
      <PageHeader title="مواضع الإعلانات وأسعارها" subtitle="كل موضع منتج سوق له سعر ومدة وإصدار تسعير؛ التغيير يُسجّل في سجل التدقيق. تغيير السعر = إيقاف القديم وإضافة إصدار جديد." />
      <label className="block max-w-xs text-sm">السوق
        <select className={input} value={marketId} onChange={(e) => setMarketId(e.target.value)}>
          <option value="">اختر</option>
          {markets.map((item) => <option key={item.id} value={item.id}>{item.countryNameEn} ({item.currencyCode})</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-right text-muted-foreground"><th className="p-2">الموضع</th><th className="p-2">الاسم</th><th className="p-2">السعر</th><th className="p-2">المدة</th><th className="p-2">يقبل</th><th className="p-2">السعة</th><th className="p-2">الإصدار</th><th className="p-2">الحالة</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border" data-testid="admin-placement-row">
                <td className="p-2">{row.productTypeLabel}</td>
                <td className="p-2">{row.name}</td>
                <td className="p-2"><bdi>{row.priceLabel}</bdi>{row.pricingUnit === "DAY" ? " / يوم" : ""}</td>
                <td className="p-2">{row.pricingUnit === "DAY" ? `${row.minDays}–${row.maxDays} يومًا` : `${row.durationDays} يومًا`}</td>
                <td className="p-2">{row.subjectKinds.includes("STORE") ? "منتجات ومتاجر" : "منتجات"}</td>
                <td className="p-2">{row.capacity ?? "—"}</td>
                <td className="p-2">{row.pricingVersion}</td>
                <td className="p-2"><Button size="sm" variant="secondary" onClick={() => toggle(row)}>{row.enabled === false ? "تفعيل" : "إيقاف"}</Button></td>
              </tr>
            ))}
            {!rows.length && <tr><td className="p-2 text-muted-foreground" colSpan={8}>لا توجد مواضع في هذا السوق.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2" onSubmit={submit}>
        <h2 className="font-semibold sm:col-span-2">إضافة موضع أو إصدار سعر جديد</h2>
        <label className="text-sm">الموضع<select className={input} value={form.productType} onChange={(e) => setForm({ ...form, productType: e.target.value })}>{TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-sm">الاسم<input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={120} /></label>
        <label className="text-sm sm:col-span-2">الوصف<input className={input} value={form.description} maxLength={300} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="text-sm">التصنيف {display ? "(اختياري)" : "(مطلوب)"}<input className={input} dir="ltr" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} /></label>
        <label className="text-sm">طريقة التسعير<select className={input} value={form.pricingUnit} onChange={(e) => setForm({ ...form, pricingUnit: e.target.value })}><option value="DAY">سعر لكل يوم</option><option value="PERIOD">سعر ثابت لمدة محددة</option></select></label>
        <label className="text-sm">السعر ({selected?.currencyCode ?? ""}){form.pricingUnit === "DAY" ? " لليوم" : ""}<input className={input} dir="ltr" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required /></label>
        <label className="text-sm">المدة الافتراضية (أيام)<input className={input} dir="ltr" type="number" min={1} max={365} value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} /></label>
        {form.pricingUnit === "DAY" && <>
          <label className="text-sm">أقل مدة<input className={input} dir="ltr" type="number" min={1} max={365} value={form.minDays} onChange={(e) => setForm({ ...form, minDays: e.target.value })} /></label>
          <label className="text-sm">أقصى مدة<input className={input} dir="ltr" type="number" min={1} max={365} value={form.maxDays} onChange={(e) => setForm({ ...form, maxDays: e.target.value })} /></label>
        </>}
        <label className="text-sm">السعة (حملات متزامنة، اختياري)<input className={input} dir="ltr" type="number" min={1} max={1000} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></label>
        <label className="text-sm">إصدار التسعير<input className={input} dir="ltr" type="number" min={1} value={form.pricingVersion} onChange={(e) => setForm({ ...form, pricingVersion: e.target.value })} /></label>
        {display && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.store} onChange={(e) => setForm({ ...form, store: e.target.checked })} />يقبل ترويج المتاجر أيضًا</label>}
        <div className="sm:col-span-2"><Button type="submit">إضافة</Button></div>
      </form>
    </div>
  );
}
