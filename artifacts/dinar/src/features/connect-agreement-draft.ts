import { ConnectAgreementTerms, type ConnectAgreement } from "@workspace/api-zod/connect-platform";
import { currencyScale, decimalToMinor } from "@workspace/global";
export type ConnectAgreementDraft = {
 currency:string;commissionKind:string;commissionValue:string;categoryRates:{categoryId:string;percentage:string}[];
 excludedProductIds:string;excludedCategoryIds:string[];attributionMinutes:string;graceMinutes:string;effectiveFrom:string;effectiveUntil:string;noEnd:boolean;
 refundPolicy:string;rounding:string;eligibleEvents:string[];settlementDays:string;paymentTerms:string;cancellationPolicy:string;termsText:string;attributionNotice:string;privacyPolicyVersion:string;
};
export const emptyConnectAgreementDraft = ():ConnectAgreementDraft => ({currency:"",commissionKind:"",commissionValue:"",categoryRates:[],excludedProductIds:"",excludedCategoryIds:[],attributionMinutes:"",graceMinutes:"",effectiveFrom:"",effectiveUntil:"",noEnd:false,refundPolicy:"",rounding:"",eligibleEvents:[],settlementDays:"",paymentTerms:"",cancellationPolicy:"",termsText:"",attributionNotice:"",privacyPolicyVersion:""});
function integer(raw:string,label:string) {if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Error(`أدخل عددًا صحيحًا في ${label}`);return Number(raw);}
function percentage(raw:string) {
 const match=/^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
 if(!match)throw new Error("أدخل نسبة صريحة بدقة منزلتين عشريتين كحد أقصى");
 const value=Number(match[1])*100+Number((match[2]??"").padEnd(2,"0"));
 if(value>10000)throw new Error("النسبة لا تتجاوز 100%");return value;
}
function instant(raw:string) {
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(raw);
 if(!match)throw new Error("حدد تاريخًا ووقتًا كاملين");
 const date=new Date(raw),expected=match.slice(1,7).map(Number);
 const actual=[date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes(),date.getSeconds()];
 if(!Number.isFinite(date.getTime())||actual.some((value,index)=>value!==(expected[index]||0)))throw new Error("التاريخ أو الوقت المحلي غير صالح");
 return date.toISOString();
}
export function connectAgreementFromDraft(draft:ConnectAgreementDraft):ConnectAgreement {
 const currency=draft.currency.trim().toUpperCase();currencyScale(currency);
 if(!["PERCENTAGE","FIXED"].includes(draft.commissionKind))throw new Error("اختر نوع العمولة صراحةً");
 if(draft.commissionKind==="FIXED"&&draft.categoryRates.length)throw new Error("النسب الخاصة تتطلب اتفاقية بنسبة مئوية");
 const excludedProductIds=draft.excludedProductIds.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
 if(new Set(excludedProductIds).size!==excludedProductIds.length)throw new Error("رمز منتج مستثنى مكرر");
 return ConnectAgreementTerms.parse({mode:"SIMULATION_ONLY",currency,
 commission:draft.commissionKind==="PERCENTAGE"?{kind:"PERCENTAGE",basisPoints:percentage(draft.commissionValue)}:{kind:"FIXED",amountMinor:decimalToMinor(draft.commissionValue,currency)},
 categoryRates:draft.categoryRates.map(row=>({categoryId:row.categoryId,basisPoints:percentage(row.percentage)})),excludedProductIds,excludedCategoryIds:draft.excludedCategoryIds,
 attributionPolicy:"CLICK_SNAPSHOT",attributionWindowSeconds:integer(draft.attributionMinutes,"مدة الإسناد")*60,reportingGraceSeconds:integer(draft.graceMinutes,"مهلة التأكيد")*60,
 effectiveFrom:instant(draft.effectiveFrom),effectiveUntil:draft.noEnd?null:instant(draft.effectiveUntil),refundPolicy:draft.refundPolicy,rounding:draft.rounding,eligibleEvents:draft.eligibleEvents,
 settlementDueDays:integer(draft.settlementDays,"موعد الاستحقاق"),paymentTerms:draft.paymentTerms.trim(),cancellationPolicy:draft.cancellationPolicy.trim(),termsText:draft.termsText.trim(),attributionNotice:draft.attributionNotice.trim(),privacyPolicyVersion:draft.privacyPolicyVersion.trim()});
}
