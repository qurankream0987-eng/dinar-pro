import { useEffect, useState } from "react";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
type Grant = { delegationId: string; employeeUserId: string; version: number; status: string; expiresAt: string; scopes: string[]; needsConfirmation: boolean; canRequest: boolean };
export function ConnectTeam({ partnerId }: { partnerId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(""), [catalog, setCatalog] = useState(false), [reports, setReports] = useState(false), [confirmed, setConfirmed] = useState(false);
  const load = async () => { const response = await api(`/connect/partners/${partnerId}/team`); setGrants(response.items); };
  useEffect(() => { void load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [partnerId]);
  const save = async (remove = false) => {
    const grant = grants.find(g => g.delegationId === selected);
    if (!grant || !confirmed || busy || (!remove && !catalog && !reports)) return;
    setBusy(true); setError("");
    try {
      await api(`/connect/partners/${partnerId}/team${remove ? `/${grant.delegationId}` : ""}`, remove ? "DELETE" : "POST",
        remove ? { confirm: true } : { delegationId: grant.delegationId, expectedDelegationVersion: grant.version, scopes: [...(catalog ? ["CATALOG_READ"] : []), ...(reports ? ["REPORTS_READ"] : [])], confirm: true });
      setConfirmed(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ الصلاحيات"); }
    finally { setBusy(false); }
  };
  const grant = grants.find(g => g.delegationId === selected);
  return <section className="space-y-3 rounded-xl border p-4" aria-label="صلاحيات فريق Connect">
    <h2 className="font-bold">صلاحيات فريق Connect</h2>
    <p>اختر تفويض قراءة بشريًا قائمًا في إدارة النشاط. الربط والمفاتيح والاتفاقيات للمالك فقط. تغيير نسخة تفويض D4 يستلزم تأكيد الصلاحيات مجددًا.</p>
    {loading && <p role="status">جارٍ تحميل التفويضات…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && grants.length === 0 && <p>لا توجد تفويضات بشرية. أنشئ تفويض القراءة وفعّله عبر إدارة النشاط الحالية أولًا.</p>}
    {grants.length > 0 && <>
      <label className="block">تفويض الموظف<select className="min-h-11 w-full rounded-lg border bg-background p-2 focus-visible:outline-2" value={selected} disabled={busy} onChange={e => {
        const next = grants.find(g => g.delegationId === e.target.value); setSelected(e.target.value); setCatalog(next?.scopes.includes("CATALOG_READ") ?? false); setReports(next?.scopes.includes("REPORTS_READ") ?? false); setConfirmed(false);
      }}><option value="">اختر تفويضًا</option>{grants.map(g => <option key={g.delegationId} value={g.delegationId}>{g.employeeUserId} — {g.status} — النسخة {g.version}</option>)}</select></label>
      {grant && <>
        <p>انتهاء التفويض: <time dateTime={grant.expiresAt}>{new Date(grant.expiresAt).toLocaleString("ar")}</time>{grant.needsConfirmation ? " — تحتاج الصلاحيات إلى تأكيد" : " — تمت مراجعة النسخة الحالية"}</p>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={catalog} disabled={busy} onChange={e => { setCatalog(e.target.checked); setConfirmed(false); }} />قراءة الكتالوج</label>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={reports} disabled={busy} onChange={e => { setReports(e.target.checked); setConfirmed(false); }} />قراءة التقارير</label>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />أؤكد الصلاحيات المعروضة لهذه النسخة من التفويض</label>
        <div className="flex flex-wrap gap-3"><Button disabled={busy || !confirmed || !grant.canRequest || (!catalog && !reports)} onClick={() => void save()}>حفظ صلاحيات القراءة</Button>
        <Button variant="secondary" disabled={busy || !confirmed || grant.scopes.length === 0} onClick={() => void save(true)}>إزالة وصول Connect فقط</Button></div>
      </>}
    </>}
  </section>;
}
export function ConnectReadOnlyCatalog({ partnerId }: { partnerId: string }) {
  const [items, setItems] = useState<{ id: string; title: string; status: string; availability: string }[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; void api(`/connect/partners/${partnerId}/catalog`).then(result => { if (active) setItems(result.items); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [partnerId]);
  return <section className="space-y-3 rounded-xl border p-4" aria-label="كتالوج الشريك للقراءة"><h2 className="font-bold">كتالوج الشريك — قراءة فقط</h2>{loading && <p role="status">جارٍ تحميل الكتالوج…</p>}{error && <p role="alert">{error}</p>}{!loading && !error && items.length === 0 && <p>لا توجد عناصر في الكتالوج.</p>}<ul>{items.map(item => <li className="border-b py-3" key={item.id}><strong>{item.title}</strong> — {item.status} — {item.availability}</li>)}</ul><p>لا يمنح هذا العرض صلاحية تعديل المنتجات أو إضافتها للسلة الداخلية.</p></section>;
}
