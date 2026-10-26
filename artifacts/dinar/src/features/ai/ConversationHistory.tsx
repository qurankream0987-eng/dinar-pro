import { useEffect, useRef, useState, type FormEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CalendarCheck,
  Code2,
  Copy,
  Lightbulb,
  MoreHorizontal,
  PenLine,
  Pencil,
  Search,
  Tag,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { DinarMark } from "@/ui/DinarMark";

/**
 * Conversation starters are only a first message or a composer prefill. None of them sets a
 * mode: the next message is read on its own, so the chat stays open to any topic.
 * `prompt` is sent as typed; `prefill` is placed in the composer for the user to finish.
 */
export type Starter = { label: string; icon: LucideIcon; prompt?: string; prefill?: string };
export const STARTERS: readonly Starter[] = [
  { label: "اشرح لي فكرة", icon: Lightbulb, prefill: "اشرح لي ببساطة: " },
  { label: "ساعدني في البرمجة", icon: Code2, prefill: "ساعدني في البرمجة: " },
  { label: "اكتب أو حسّن نصًا", icon: PenLine, prefill: "اكتب لي " },
  { label: "خطط معي", icon: CalendarCheck, prefill: "ساعدني أخطط لـ " },
  { label: "أريد أن أبيع شيئًا", icon: Tag, prompt: "أريد أن أبيع شيئًا" },
  { label: "أبحث عن منتج أو خدمة", icon: Search, prefill: "ابحث في دينار عن " },
];

export function ConversationItem({
  conversation,
  active,
  onClick,
  onDelete,
  onRename,
  onCopy,
  deleteDisabled,
  copyDisabled,
}: {
  conversation: { id: string; title: string; updatedAt: string };
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (title: string) => Promise<void>;
  onCopy: () => Promise<void>;
  deleteDisabled: boolean;
  copyDisabled: boolean;
}) {
  const title = conversation.title || "محادثة جديدة";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [copying, setCopying] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    // After the menu closes and returns focus, move it into the field.
    const frame = window.requestAnimationFrame(() => input.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    const next = value.replace(/\s+/gu, " ").trim();
    if (saving) return;
    if (!next || next === title) {
      setEditing(false);
      setValue(title);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onRename(next.slice(0, 80));
      setEditing(false);
    } catch {
      setError("تعذر حفظ الاسم. حاول مجددًا.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="ai-history-item" data-active={active || undefined} data-editing={editing || undefined}>
      {editing ? (
        <form className="ai-history-rename" onSubmit={(event) => void save(event)}>
          <input
            ref={input}
            value={value}
            maxLength={80}
            disabled={saving}
            aria-label="اسم المحادثة"
            data-testid={`input-rename-conversation-${conversation.id}`}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                setValue(title);
                setError("");
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-current={active ? "page" : undefined}
          data-testid={`conversation-${conversation.id}`}
          title={title}
          className="ai-history-item-open pressable"
        >
          <span dir="auto">{title}</span>
        </button>
      )}
      {!editing && (
        <DropdownMenu.Root modal={false} dir="rtl">
          <DropdownMenu.Trigger
            className="ai-history-item-more"
            aria-label={`خيارات المحادثة: ${title}`}
            data-testid={`button-conversation-menu-${conversation.id}`}
          >
            <MoreHorizontal size={17} aria-hidden />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={12} className="ai-menu">
              <DropdownMenu.Item
                className="ai-menu-item"
                disabled={copyDisabled || copying}
                data-testid={`menuitem-copy-conversation-${conversation.id}`}
                onSelect={() => {
                  setCopyError("");
                  setCopying(true);
                  void onCopy()
                    .catch(() => setCopyError("تعذر نسخ المحادثة. حاول مجددًا."))
                    .finally(() => setCopying(false));
                }}
              >
                <Copy size={15} aria-hidden />
                نسخ المحادثة
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="ai-menu-item"
                data-testid={`menuitem-rename-conversation-${conversation.id}`}
                onSelect={() => {
                  setValue(title);
                  setError("");
                  setEditing(true);
                }}
              >
                <Pencil size={15} aria-hidden />
                إعادة التسمية
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="ai-menu-item is-danger"
                disabled={deleteDisabled}
                data-testid={`button-delete-conversation-${conversation.id}`}
                aria-label={`حذف المحادثة: ${title}`}
                onSelect={onDelete}
              >
                <Trash2 size={15} aria-hidden />
                حذف
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      {(error || copyError) && (
        <p role="alert" className="ai-history-item-error">
          {error || copyError}
        </p>
      )}
    </div>
  );
}

export function Welcome({
  onStarter,
  onCompose,
}: {
  onStarter: (value: string) => void;
  onCompose: (prefill: string) => void;
}) {
  return (
    <div className="ai-welcome">
      <div className="ai-welcome-copy">
        <DinarMark size={36} alt="DINAR" className="ai-welcome-logo" />
        <h1>كيف أساعدك اليوم؟</h1>
        <p>
          اسأل عن أي شيء — معرفة، كتابة، برمجة، تخطيط — أو بِع واشترِ وأدِر أعمالك في دينار.
        </p>
      </div>
      <div className="ai-starters" role="group" aria-label="أمثلة للبدء">
        {STARTERS.map(({ label, icon: Icon, prompt, prefill }) => (
          <button
            type="button"
            key={label}
            onClick={() => (prompt ? onStarter(prompt) : onCompose(prefill ?? label))}
            data-testid={`button-prompt-${label}`}
            data-kind={prompt ? "send" : "compose"}
            className="ai-starter pressable"
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
