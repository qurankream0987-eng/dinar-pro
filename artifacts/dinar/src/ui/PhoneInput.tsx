import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { countries } from '@workspace/global';
import { CountrySelector } from './CountrySelector';
// National number length (without the trunk 0) per country; a leading 0 is allowed one extra digit.
const NATIONAL_DIGITS:Record<string,number>={KW:8,QA:8,BH:8,OM:8,LB:8,TN:8,JO:9,SA:9,AE:9,SY:9,PS:9,YE:9,MA:9,DZ:9,LY:9,SD:9,FR:9,DJ:8,SO:8,KM:7,MR:8,IQ:10,EG:10,TR:10,GB:10,US:10,DE:11};
export function maxPhoneDigits(country:string|undefined,value:string){const n=NATIONAL_DIGITS[country??'']??15;return value.replace(/\D/g,'').startsWith('0')?n+1:n;}
const toLatin=(v:string)=>v.replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x6f0));
export const PhoneInput=forwardRef<HTMLInputElement,InputHTMLAttributes<HTMLInputElement>&{dialCode:string;onDialCodeChange:(code:string)=>void;countryCode?:string;onCountryChange?:(code:string)=>void}>(function PhoneInput({dialCode,onDialCodeChange,countryCode,onCountryChange,className,onChange,...rest},ref){
 const [selected,setSelected]=useState(countries.find(c=>c.callingCode===dialCode)?.countryCode??'JO');
 return <div dir="ltr" className={`flex min-w-0 gap-2 ${className??''}`}>
  <div className="w-28 shrink-0"><CountrySelector dialOnly label="رمز الاتصال" value={countryCode??selected} onChange={c=>{setSelected(c.countryCode);onCountryChange?.(c.countryCode);onDialCodeChange(c.callingCode!);}}/></div>
  <input ref={ref} type="tel" inputMode="tel" autoComplete="tel-national" className="num h-12 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-start outline-none focus:border-primary" {...rest} onChange={e=>{const country=countryCode??selected;const digits=toLatin(e.target.value).replace(/\D/g,'');const cut=digits.slice(0,maxPhoneDigits(country,digits));if(cut!==e.target.value)e.target.value=cut;onChange?.(e);}} placeholder={`${NATIONAL_DIGITS[countryCode??selected]??''}${NATIONAL_DIGITS[countryCode??selected]?' أرقام':'رقم الهاتف'}`}/>
 </div>;
});
