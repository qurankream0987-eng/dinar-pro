import "./_group.css";
import { useState } from "react";
import { ArrowUp, Clock3, MessageCircle, PanelRightClose, Plus, Search, Sparkles, Trash2 } from "lucide-react";

const starters = ["ابحث عن عروض", "أريد البيع", "كيف يعمل دينار؟"];
const initialHistory = [
  { id: "c1", title: "سماعات لاسلكية للرحلات", updatedAt: "2025-05-28T09:30:00Z" },
  { id: "c2", title: "أفكار لهدية مميزة", updatedAt: "2025-05-27T16:10:00Z" },
  { id: "c3", title: "كيف أضيف عرضاً؟", updatedAt: "2025-05-20T11:00:00Z" },
];

function dateLabel(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString("ar", { day: "numeric", month: "short" });
}

function Welcome({ onStarter }: { onStarter: (value: string) => void }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-6 md:px-8">
    <div className="w-full max-w-xl text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-ink text-accent shadow-sm"><Sparkles size={22} /></div>
      <p className="mt-4 text-[11px] font-bold uppercase tracking-[.18em] text-primary">DINAR</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground md:text-4xl">ماذا تريد اليوم؟</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground md:text-base">من فكرة إلى خطوة. اسأل، ابحث، وأنجز مع دينار.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">{starters.map((starter) => <button key={starter} onClick={() => onStarter(starter)} className="pressable min-h-11 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-text-secondary hover:border-primary/40 hover:bg-primary-soft hover:text-primary">{starter}</button>)}</div>
    </div>
  </div>;
}

export function Current() {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [mobileHistory, setMobileHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<{ role: "USER" | "ASSISTANT"; body: string }[]>([]);
  const history = initialHistory.filter((item) => item.title.includes(query));
  const submit = (text = draft) => {
    const value = text.trim();
    if (!value) return;
    setMessages((current) => [...current, { role: "USER", body: value }, { role: "ASSISTANT", body: "أهلاً بك! سأساعدك في العثور على أفضل الخيارات من سوق دينار." }]);
    setDraft("");
  };
  const sidebar = <aside className="ai-history flex min-h-0 flex-col border-l border-border/50 p-3">
    <div className="mb-3 flex items-center justify-between px-2 md:hidden"><p className="text-sm font-bold">محادثاتك</p><button className="pressable inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-muted" onClick={() => setMobileHistory(false)} aria-label="إغلاق المحادثات"><PanelRightClose size={18} /></button></div>
    <button className="mb-2 hidden h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted md:flex" onClick={() => setHistoryOpen(false)} aria-label="إخفاء المحادثات"><PanelRightClose size={18} /></button>
    <button className="flex h-10 w-full items-center justify-start gap-2 rounded-xl bg-secondary px-3 text-sm font-semibold text-secondary-foreground" onClick={() => setMessages([])}><Plus size={16} /> محادثة جديدة</button>
    <label className="relative mt-1 block"><Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث في محادثاتك" aria-label="البحث في المحادثات" className="h-10 w-full rounded-xl border border-transparent bg-background/80 ps-9 pe-3 text-sm outline-none focus:border-primary/50" /></label>
    <div className="mb-2 mt-5 flex items-center justify-between px-2"><p className="text-xs font-bold uppercase tracking-[.12em] text-muted-foreground">الأحدث</p><Clock3 size={14} className="text-muted-foreground" /></div>
    <div className="min-h-0 flex-1 overflow-y-auto space-y-1">{history.map((item, index) => <div key={item.id} className="group flex w-full items-start gap-1 rounded-xl hover:bg-muted"><button className="pressable flex min-w-0 flex-1 items-start gap-3 rounded-xl px-3 py-3 text-start text-text-secondary" onClick={() => setMessages([{ role: "USER", body: item.title }, { role: "ASSISTANT", body: "يسعدني مساعدتك في هذا الموضوع." }])}><span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><MessageCircle size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{dateLabel(item.updatedAt)}</span></span></button><button className="mt-1.5 inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive-soft hover:text-destructive" aria-label={`حذف المحادثة: ${item.title}`} onClick={() => { initialHistory.splice(index, 1); setQuery(query + " "); setQuery(query); }}><Trash2 size={16} /></button></div>)}</div>
    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/60 pt-3"><button className="pressable min-h-10 rounded-xl px-2 text-xs font-semibold text-text-secondary hover:bg-muted">حسابي</button><button className="pressable min-h-10 rounded-xl px-2 text-xs font-semibold text-text-secondary hover:bg-muted">الإعدادات</button></div>
  </aside>;
  return <div className="ai-shell ai-home" dir="rtl"><div className="flex h-full min-h-0 flex-col"><div className={`relative grid min-h-0 min-w-0 flex-1 overflow-hidden ${historyOpen ? "md:grid-cols-[264px_minmax(0,1fr)]" : ""}`}>{historyOpen && <div className="hidden md:block">{sidebar}</div>}<section className="ai-conversation relative flex min-h-0 min-w-0 flex-col bg-background" aria-label="محادثة DINAR"><div className="flex items-center justify-between border-b border-border/50 px-4 py-3 md:hidden"><span className="font-bold">DINAR AI</span><button onClick={() => setMobileHistory(true)} className="rounded-lg p-2 hover:bg-muted" aria-label="فتح المحادثات"><PanelRightClose size={18} /></button></div>{messages.length === 0 ? <Welcome onStarter={submit} /> : <div className="ai-thread flex-1 overflow-y-auto px-4 py-6 md:px-10"><div className="mx-auto flex max-w-3xl flex-col gap-5">{messages.map((message, index) => <div key={index} className={`ai-message-in flex ${message.role === "USER" ? "justify-start" : "justify-end"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === "USER" ? "bg-primary text-primary-foreground" : "border border-border bg-card text-foreground"}`}>{message.body}</div></div>)}</div></div>}<form className="ai-composer shrink-0 bg-background px-3 pt-3 md:px-6 md:pt-4" onSubmit={(e) => { e.preventDefault(); submit(); }}><div className="ai-composer-box mx-auto max-w-3xl rounded-[26px] border border-border bg-card p-2 shadow-sm focus-within:border-primary/40"><textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} placeholder="اسأل دينار..." aria-label="رسالتك إلى DINAR AI" className="block min-h-[52px] w-full resize-none bg-transparent px-3 py-3 text-base leading-7 outline-none placeholder:text-muted-foreground" /><div className="flex justify-end px-1 pb-1"><button type="submit" className="pressable flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50" disabled={!draft.trim()} aria-label="إرسال"><ArrowUp size={19} /></button></div></div></form></section>{mobileHistory && <div className="absolute inset-0 z-[var(--z-overlay)] bg-ink/40 md:hidden" onClick={() => setMobileHistory(false)}><div className="absolute inset-y-0 start-0 z-[var(--z-modal)] flex w-[min(86vw,320px)] flex-col rounded-e-2xl bg-card p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>{sidebar}</div></div>}</div></div></div>;
}