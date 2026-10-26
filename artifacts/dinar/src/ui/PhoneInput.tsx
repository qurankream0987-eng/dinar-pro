import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { countries } from '@workspace/global';
import { CountrySelector } from './CountrySelector';
export const PhoneInput=forwardRef<HTMLInputElement,InputHTMLAttributes<HTMLInputElement>&{dialCode:string;onDialCodeChange:(code:string)=>void;countryCode?:string;onCountryChange?:(code:string)=>void}>(function PhoneInput({dialCode,onDialCodeChange,countryCode,onCountryChange,className,...rest},ref){
 const [selected,setSelected]=useState(countries.find(c=>c.callingCode===dialCode)?.countryCode??'KW');
 return <div dir="ltr" className={`flex min-w-0 gap-2 ${className??''}`}>
  <div className="w-28 shrink-0"><CountrySelector dialOnly label="رمز الاتصال" value={countryCode??selected} onChange={c=>{setSelected(c.countryCode);onCountryChange?.(c.countryCode);onDialCodeChange(c.callingCode!);}}/></div>
  <input ref={ref} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="رقم الهاتف" className="num h-12 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-start outline-none focus:border-primary" {...rest}/>
 </div>;
});
