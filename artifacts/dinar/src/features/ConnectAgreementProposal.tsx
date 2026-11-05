import { useEffect, useState } from "react";
import { ConnectAgreementViewSchema, type ConnectAgreement } from "@workspace/api-zod/connect-platform";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
import { ConnectAgreementDetails } from "./ConnectAgreementDetails";
import { connectAgreementFromDraft, emptyConnectAgreementDraft, type ConnectAgreementDraft } from "./connect-agreement-draft";
type DraftTextKey = { [K in keyof ConnectAgreementDraft]: ConnectAgreementDraft[K] extends string ? K : never }[keyof ConnectAgreementDraft];
const field="min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 focus-visible:outline-2 focus-visible:outline-offset-2";
const events=[["PURCHASE_COMPLETED","شراء مكتمل"],["BOOKING_CONFIRMED","حجز مؤكد"],["SERVICE_COMPLETED","خدمة مكتملة"]] as const;
export function ConnectAgreementProposal({partnerId}:{partnerId:string}) {
 const [draft,setDraft]=useState(emptyConnectAgreementDraft),[categories,setCategories]=useState<{id:string;label:string}[]>([]),[preview,setPreview]=useState<ConnectAgreement|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 useEffect(()=>{let active=true;void api("/categories").then(result=>{if(active)setCategories(result);}).catch(()=>{if(active)setError("تعذر تحميل التصنيفات؛ أعد فتح الحساب للمراجعة.");});return()=>{active=false;};},[]);
 const update=<K extends keyof ConnectAgreementDraft,>(key:K,value:ConnectAgreementDraft[K])=>{setDraft(old=>({...old,[key]:value}));setConfirmed(false);};
 const propose=async()=>{
  if(!preview||!confirmed||busy)return;setBusy(true);setError("");setMessage("");
  try {const row=ConnectAgreementViewSchema.parse(await api(`/admin/connect/partners/${partnerId}/agreements`,"POST",preview));if(row.partnerId!==partnerId||JSON.stringify(row.terms)!==JSON.stringify(preview))throw new Error("رد الاتفاقية لا يطابق الشروط المراجعة؛ تحقق من سجل الخادم قبل إعادة المحاولة");setMessage(`حفظ الخادم مقترح النسخة ${row.version}؛ ${row.accepted ? "النسخة مقبولة سابقًا وفق سجل الخادم" : "لم يقبله المالك بعد"}. بصمة الشروط: ${row.termsDigest}`);setPreview(null);setConfirmed(false);}
  catch(e){setError(e instanceof Error?e.message:"تعذر حفظ المقترح؛ تحقق من سجل الخادم");}finally{setBusy(false);}
 };
 const textField=(key:DraftTextKey,label:string,type="text",extra:Record<string,unknown>={})=><label className="block" key={key}>{label}<input className={field} type={type} required value={String(draft[key])} onChange={e=>update(key,e.target.value)} {...extra}/></label>;
 const selectField=(key:"commissionKind"|"refundPolicy"|"rounding",label:string,options:readonly (readonly [string,string])[])=><label className="block">{label}<select className={field} aria-label={label} required value={draft[key]} onChange={e=>update(key,e.target.value)}><option value="">اختر صراحةً</option>{options.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>;
 return <section aria-label="مقترح اتفاقية Connect" className="min-w-0 space-y-3 rounded-xl border p-4">
  <h2 className="font-bold">اقتراح اتفاقية عمولة بالمحاكاة</h2><p>المقترح مستقل عن التسجيل المجاني ولا يفعّل عمولة حية. يختار المالك قبول النسخة لاحقًا. سياسة الإسناد المتاحة تثبّت نسخة الشروط عند الإحالة؛ لا يوجد تحويل عملات تلقائي.</p>
  {error&&<p role="alert" className="break-words">{error}</p>}{message&&<p role="status" className="break-all">{message}</p>}
  {preview?<div className="space-y-3" aria-label="مراجعة الشروط قبل الاقتراح"><ConnectAgreementDetails terms={preview}/><label className="flex min-h-11 items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>راجعت جميع الشروط والاستثناءات وأؤكد إنشاء مقترح بالمحاكاة؛ هذا ليس قبولًا نيابةً عن المالك.</label><div className="flex flex-wrap gap-2"><Button disabled={busy||!confirmed} onClick={()=>void propose()}>تأكيد إنشاء مقترح الاتفاقية</Button><Button variant="secondary" disabled={busy} onClick={()=>{setPreview(null);setConfirmed(false);}}>العودة لتعديل الشروط</Button></div></div>:
  <form className="space-y-4" onSubmit={e=>{e.preventDefault();setError("");setMessage("");try{setPreview(connectAgreementFromDraft(draft));setConfirmed(false);}catch{setError("راجع الحقول المطلوبة، العملة والدقة، الفترات والتواريخ، واختيارات السياسة؛ لم يرسل أي مقترح.");}}}>
   <fieldset className="space-y-3"><legend className="font-bold">العمولة والاستثناءات</legend>
    {textField("currency","عملة الاتفاقية","text",{minLength:3,maxLength:3,pattern:"[A-Za-z]{3}",dir:"ltr"})}
    {selectField("commissionKind","نوع العمولة",[["PERCENTAGE","نسبة مئوية"],["FIXED","مبلغ ثابت بعملة الاتفاقية"]])}
    {textField("commissionValue",draft.commissionKind==="FIXED"?"مبلغ العمولة الثابتة":"نسبة العمولة (%)","text",{inputMode:"decimal",maxLength:30,dir:"ltr"})}
    <p>النسب الخاصة اختيارية وتتطلب نوع النسبة المئوية. عدم إضافة نسب أو استثناءات يظهر صراحةً في المراجعة.</p>
    {draft.categoryRates.map((rate,index)=><div className="space-y-2 rounded-lg border p-2" key={index}><label className="block">تصنيف النسبة الخاصة {index+1}<select className={field} required value={rate.categoryId} onChange={e=>update("categoryRates",draft.categoryRates.map((row,i)=>i===index?{...row,categoryId:e.target.value}:row))}><option value="">اختر تصنيفًا</option>{categories.map(category=><option key={category.id} value={category.id}>{category.label}</option>)}</select></label><label className="block">النسبة الخاصة (%) {index+1}<input className={field} required inputMode="decimal" value={rate.percentage} onChange={e=>update("categoryRates",draft.categoryRates.map((row,i)=>i===index?{...row,percentage:e.target.value}:row))}/></label><Button type="button" variant="secondary" onClick={()=>update("categoryRates",draft.categoryRates.filter((_,i)=>i!==index))}>إزالة النسبة الخاصة {index+1}</Button></div>)}
    <Button type="button" variant="secondary" disabled={draft.commissionKind!=="PERCENTAGE"||draft.categoryRates.length>=30} onClick={()=>update("categoryRates",[...draft.categoryRates,{categoryId:"",percentage:""}])}>إضافة نسبة تصنيف خاصة</Button>
    <label className="block">رموز المنتجات المستثناة لدى الشريك — كل رمز في سطر<textarea className={field} dir="ltr" maxLength={10100} value={draft.excludedProductIds} onChange={e=>update("excludedProductIds",e.target.value)}/></label>
    <fieldset className="space-y-2"><legend>التصنيفات المستثناة — اختيارية</legend>{categories.map(category=><label key={category.id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.excludedCategoryIds.includes(category.id)} onChange={e=>update("excludedCategoryIds",e.target.checked?[...draft.excludedCategoryIds,category.id]:draft.excludedCategoryIds.filter(id=>id!==category.id))}/>{category.label}</label>)}</fieldset>
   </fieldset>
   <fieldset className="space-y-3"><legend className="font-bold">الفترات والسياسات</legend>
    {textField("attributionMinutes","مدة الإسناد بالدقائق","number",{min:1,max:525600,step:1})}{textField("graceMinutes","مهلة تأكيد التحويل بالدقائق","number",{min:0,max:525600,step:1})}
    <p className="text-sm">التواريخ حسب منطقة متصفحك: <span dir="ltr">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>؛ تُراجع بعد تحويلها إلى وقت محدد.</p>
    {textField("effectiveFrom","بداية سريان الاتفاقية","datetime-local",{step:"0.001"})}
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.noEnd} onChange={e=>update("noEnd",e.target.checked)}/>أختار صراحةً عدم تحديد تاريخ انتهاء</label>
    {!draft.noEnd&&textField("effectiveUntil","نهاية سريان الاتفاقية","datetime-local",{step:"0.001"})}
    {selectField("refundPolicy","سياسة أثر الاسترداد",[["PRO_RATA_ELIGIBLE_BASE","تخفيض العمولة بحسب الأساس المؤهل المسترد"],["FULL_REVERSAL_ON_ANY_REFUND","عكس العمولة كاملة عند أي استرداد"]])}
    {selectField("rounding","سياسة التقريب",[["HALF_UP","أقرب وحدة صغرى والنصف إلى الأعلى"],["FLOOR","وحدة العملة الصغرى الأدنى"]])}
    <fieldset><legend>الأحداث المؤهلة — اختر واحدًا على الأقل</legend>{events.map(([value,label])=><label key={value} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.eligibleEvents.includes(value)} onChange={e=>update("eligibleEvents",e.target.checked?[...draft.eligibleEvents,value]:draft.eligibleEvents.filter(event=>event!==value))}/>{label}</label>)}</fieldset>
    {textField("settlementDays","موعد الاستحقاق بالأيام","number",{min:0,max:3650,step:1})}
   </fieldset>
   <fieldset className="space-y-3"><legend className="font-bold">النصوص التجارية والخصوصية</legend>
    {([["paymentTerms","شروط الدفع",3,1000],["cancellationPolicy","شروط الإلغاء والاسترداد",3,1000],["termsText","نص الاتفاقية الكامل",10,12000],["attributionNotice","إشعار مشاركة معرّف الإحالة",10,700]] as const).map(([key,label,min,max])=><label className="block" key={key}>{label}<textarea className={field+" min-h-24"} required minLength={min} maxLength={max} value={draft[key]} onChange={e=>update(key,e.target.value)}/></label>)}
    {textField("privacyPolicyVersion","نسخة إشعار الخصوصية","text",{maxLength:80})}
   </fieldset>
   <Button type="submit">مراجعة الشروط قبل إنشاء المقترح</Button>
  </form>}
 </section>;
}
