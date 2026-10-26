import { useState } from 'react';
import { countries, countryByCode, searchCountries, type Country } from '@workspace/global';
import { Sheet } from './Sheet';
import { Input } from './Field';
import { Flag } from './Media';
export function CountrySelector({ value, onChange, dialOnly = false, label = 'دولة الحساب' }: { value: string; onChange: (country: Country) => void; dialOnly?: boolean; label?: string }) {
 const [open,setOpen]=useState(false), [query,setQuery]=useState('');
 const selected=countryByCode.get(value);
 const list=searchCountries(query,countries.filter(c=>c.isSelectable&&(!dialOnly||c.callingCode)));
 return <>
  <button type="button" aria-label={label} data-testid={dialOnly?'select-dial-code':'select-country'} onClick={()=>{setQuery('');setOpen(true);}} className="dinar-chip flex min-h-12 w-full min-w-0 items-center gap-2 rounded-xl border border-input bg-card px-3 text-start">
   <Flag code={value}/><span className="min-w-0 flex-1 truncate">{dialOnly?selected?.callingCode:selected?.countryNameAr}</span><span aria-hidden>⌄</span>
  </button>
  <Sheet open={open} onOpenChange={setOpen} title={label} testId="sheet-country" width={480}>
   <Input type="search" aria-label="ابحث عن دولة" placeholder="ابحث عن دولة، رمز ISO أو رمز اتصال…" value={query} onChange={e=>setQuery(e.target.value)} className="mb-3" />
   <div className="max-h-[55vh] space-y-1 overflow-y-auto">
    {list.map(c=><button type="button" key={c.countryCode} data-testid={`button-country-${c.countryCode}`} onClick={()=>{onChange(c);setOpen(false);}} className="dinar-chip flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-muted" aria-pressed={value===c.countryCode}>
     <Flag code={c.countryCode} size={28}/><span className="min-w-0 flex-1"><span className="block font-semibold">{c.countryNameAr}</span><span className="block text-xs text-muted-foreground">{c.countryNameEn} · {c.countryCode}</span></span><bdi className="num text-sm">{c.callingCode??'—'}</bdi>
    </button>)}
    {!list.length&&<p className="p-5 text-center text-muted-foreground">لا توجد دولة مطابقة</p>}
   </div>
  </Sheet>
 </>;
}
