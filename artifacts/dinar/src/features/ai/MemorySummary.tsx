import React, { useState } from "react";
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/Button";
import { Field, Input } from "@/ui/Field";
import { Sheet } from "@/ui/Sheet";
export { MEMORY_SURFACES, normalizeMemory, type MemoryPayload } from "./memory-types";
import type { MemoryPayload } from "./memory-types";
const TITLES: Record<MemoryPayload["view"], string> = { MY_INTERESTS: "اهتماماتي", MEMORY_SUMMARY: "ما يتذكره جاسم", MEMORY_CONFIRMATION: "تأكيد الذاكرة", MEMORY_UPDATED: "تحديث الذاكرة", MEMORY_REMOVED: "حذف من الذاكرة" };
type MemorySummaryProps = { memory: MemoryPayload; active?: boolean; onSend?: (text: string) => void };
export function MemorySummary(props: MemorySummaryProps) {
  return <MemoryExperience {...props} dir="rtl" />;
}
function MemoryExperience({ memory, active = false, onSend, dir }: MemorySummaryProps & { dir: "rtl" }) {
  const [editor, setEditor] = useState<{ oldLabel?: string } | null>(null);
  const [value, setValue] = useState("");
  const canAct = active && Boolean(onSend);
  const send = (text: string) => { if (canAct) onSend?.(text); };
  const openEditor = (oldLabel?: string) => { setValue(""); setEditor({oldLabel}); };
  const hasItems = memory.groups.some(g => g.items.length);
  return <section dir={dir} aria-label={TITLES[memory.view]} data-testid="personal-memory" data-view={memory.view} className="ai-surface mt-3 min-w-0 max-w-xl space-y-3 rounded-xl border border-border bg-card p-4 text-sm [overflow-wrap:anywhere]">
    <h3 className="flex items-center gap-2 font-semibold text-foreground"><Brain size={18} aria-hidden className="shrink-0 text-primary" />{TITLES[memory.view]}</h3>
    <p className="text-muted-foreground">تفضيلاتك تساعد جاسم عندما ترتبط بطلبك. طلبك الحالي هو الأساس، ويمكنك تصحيح أي معلومة.</p>
    {hasItems ? memory.groups.filter(g => g.items.length).map((g,index) => <div key={`${g.label}-${index}`}>
      <h4 className="font-semibold text-primary">{g.label}</h4>
      <ul className="mt-2 space-y-2">{g.items.map((i,itemIndex) => <li key={`${i.topic}-${itemIndex}`} className="min-w-0 rounded-lg bg-muted/40 p-3">
        <p className="font-medium"><bdi>{i.label}</bdi></p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{i.reason}</p>
        {canAct && <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Pencil size={14} aria-hidden />} aria-label={`عدّل اهتمام ${i.label}`} onClick={() => openEditor(i.label)}>عدّل</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`احذف اهتمام ${i.label}`} onClick={() => send(`احذف اهتمام ${i.label}`)}>احذف</Button>
          <Button size="sm" variant="secondary" aria-label={`لا تستخدم ${i.label} في الاقتراحات`} onClick={() => send(`لا تقترح لي ${i.label}`)}>لا تستخدمه في الاقتراحات</Button>
        </div>}
      </li>)}</ul>
    </div>) : <p role="status" className="rounded-lg bg-muted/40 p-3">{memory.view === "MY_INTERESTS" || memory.view === "MEMORY_SUMMARY" ? "لا توجد اهتمامات مؤكدة لعرضها بعد. يمكنك أن تطلب من جاسم تذكر تفضيلك." : "تفاصيل هذا التغيير موضحة في رد جاسم أعلاه."}</p>}
    {canAct ? <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" icon={<Plus size={15} aria-hidden />} onClick={() => openEditor()} data-testid="memory-add">تذكر تفضيلًا</Button>
      <Button size="sm" variant="ghost" onClick={() => send("جاسم، ماذا تعرف عن اهتماماتي؟")} data-testid="memory-view">اعرض اهتماماتي</Button>
    </div> : <p className="text-xs text-muted-foreground">يمكنك كتابة «تذكر أني أحب التخييم» أو «احذف اهتمام السيارات» في المحادثة.</p>}
    <Sheet open={Boolean(editor)} onOpenChange={open => { if (!open) setEditor(null); }} title={editor?.oldLabel ? "عدّل تفضيلك" : "تذكر تفضيلًا"} description="سيُرسل طلبك في المحادثة. يؤكد دينار النتيجة بعد معالجة الطلب." testId="memory-editor">
      <form className="min-w-0 space-y-4 pb-4" onSubmit={event => { event.preventDefault(); if (!value.trim() || !canAct) return; send(editor?.oldLabel ? `عدّل تفضيلي ${editor.oldLabel} إلى ${value.trim()}` : `تذكر أني أحب ${value.trim()}`); setEditor(null); }}>
        {editor?.oldLabel && <p className="break-words text-sm text-muted-foreground">التفضيل الحالي: {editor.oldLabel}</p>}
        <Field label={editor?.oldLabel ? "التفضيل الجديد" : "ما الذي تفضله؟"} hint="اكتب اهتمامًا أو تفضيلًا؛ لا تضف معلومات حساسة أو بيانات دخول."><Input value={value} maxLength={80} autoFocus onChange={e => setValue(e.target.value)} placeholder="مثل: التخييم" data-testid="memory-editor-input" /></Field>
        <Button type="submit" disabled={!value.trim() || !canAct} data-testid="memory-editor-submit">إرسال الطلب إلى جاسم</Button>
      </form>
    </Sheet>
  </section>;
}
