import { ListingGlimpses } from "./ListingGlimpses";
import { Link } from "wouter";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import { surfaceSpring } from "@/lib/presentation-motion";
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ShoppingCart,
  Store,
  ChartColumn,
  Image,
  Megaphone,
  ScanSearch,
  CalendarCheck,
  Code2,
  Copy,
  Lightbulb,
  MoreHorizontal,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { DinarMark } from "@/ui/DinarMark";

/**
 * Conversation starters are only a first message or a composer prefill. None of them sets a
 * mode: the next message is read on its own, so the chat stays open to any topic.
 * `prompt` is sent as typed; `prefill` is placed in the composer for the user to finish.
 */
export type WelcomeAction = {
  id:
    | "buy"
    | "sell"
    | "compare"
    | "image"
    | "code"
    | "plan"
    | "idea"
    | "advertise"
    | "analyze";
  label: string;
  icon: LucideIcon;
  description?: string;
  prompt?: string;
  prefill?: string;
  attachment?: boolean;
};
export const PRIMARY_ACTIONS: readonly WelcomeAction[] = [
  {
    id: "buy",
    label: "أريد أن أشتري",
    icon: ShoppingCart,
    description: "ابحث عن منتج أو خدمة بسعر مناسب",
    prompt: "أريد أن أشتري شيئًا",
  },
  {
    id: "sell",
    label: "أريد أن أبيع",
    icon: Store,
    description: "اعرض منتجاتك ووصل إلى المزيد من العملاء",
    prompt: "أريد أن أبيع شيئًا",
  },
  {
    id: "compare",
    label: "قارن الأسعار",
    icon: ChartColumn,
    description: "قارن بين المنتجات واختر الأفضل",
    prefill: "أريد مقارنة الأسعار والمواصفات بين: ",
  },
];
export const STARTERS: readonly WelcomeAction[] = [
  { id: "image", label: "ابحث بالصور", icon: Image, attachment: true },
  {
    id: "code",
    label: "ساعدني في البرمجة",
    icon: Code2,
    prefill: "ساعدني في البرمجة: ",
  },
  {
    id: "plan",
    label: "خطط معي",
    icon: CalendarCheck,
    prefill: "ساعدني أخطط لـ ",
  },
  {
    id: "idea",
    label: "اقترح فكرة",
    icon: Lightbulb,
    prefill: "اقترح لي فكرة عن: ",
  },
  {
    id: "advertise",
    label: "أنشئ إعلانًا",
    icon: Megaphone,
    prefill: "ساعدني في إعداد إعلان عن: ",
  },
  {
    id: "analyze",
    label: "حلّل منتجي",
    icon: ScanSearch,
    prefill: "حلّل هذا المنتج بناءً على معلوماته الفعلية: ",
  },
];

/**
 * The DINAR mark alone, alive: it tilts toward the pointer, glows on hover and focus, and a tap
 * moves focus to the composer. Purely presentational; still under reduced motion.
 */
function InteractiveLogo() {
  const ref = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (reduceMotion || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    ref.current.style.setProperty("--tilt-x", `${(-y * 14).toFixed(2)}deg`);
    ref.current.style.setProperty("--tilt-y", `${(x * 14).toFixed(2)}deg`);
    ref.current.style.setProperty("--glow-x", `${((x + 0.5) * 100).toFixed(0)}%`);
    ref.current.style.setProperty("--glow-y", `${((y + 0.5) * 100).toFixed(0)}%`);
  };
  const reset = () => {
    ref.current?.style.removeProperty("--tilt-x");
    ref.current?.style.removeProperty("--tilt-y");
  };
  return (
    <button
      ref={ref}
      type="button"
      className="premium-logo"
      aria-label="ابدأ الكتابة لجاسم"
      data-testid="welcome-logo"
      onPointerMove={move}
      onPointerLeave={reset}
      onClick={() => document.querySelector<HTMLTextAreaElement>('[data-testid="input-ai-composer"]')?.focus()}
    >
      <span className="premium-logo-halo" aria-hidden="true" />
      <DinarMark size={112} className="ai-welcome-logo" />
    </button>
  );
}

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
    <div
      className="ai-history-item"
      data-active={active || undefined}
      data-editing={editing || undefined}
    >
      {editing ? (
        <form
          className="ai-history-rename"
          onSubmit={(event) => void save(event)}
        >
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
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              collisionPadding={12}
              className="ai-menu"
            >
              <DropdownMenu.Item
                className="ai-menu-item"
                disabled={copyDisabled || copying}
                data-testid={`menuitem-copy-conversation-${conversation.id}`}
                onSelect={() => {
                  setCopyError("");
                  setCopying(true);
                  void onCopy()
                    .catch(() =>
                      setCopyError("تعذر نسخ المحادثة. حاول مجددًا."),
                    )
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
  onImage,
  busy = false,
}: {
  onStarter: (value: string) => void;
  onCompose: (prefill: string) => void;
  onImage: () => void;
  busy?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const activate = (action: WelcomeAction) => {
    if (busy) return;
    if (action.attachment) onImage();
    else if (action.prompt) onStarter(action.prompt);
    else onCompose(action.prefill ?? action.label);
  };
  return (
    <LazyMotion features={domAnimation} strict>
      <m.div
        className="ai-welcome premium-welcome"
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduceMotion ? { duration: 0 } : surfaceSpring}
      >
        <div className="ai-welcome-copy">
          <ListingGlimpses />
          <InteractiveLogo />
          <h1>كيف أساعدك اليوم؟</h1>
          <p>مساعدك الذكي للتسوق والبيع والتخطيط والبرمجة وإدارة أعمالك.</p>
        </div>
        <div
          className="premium-primary-actions"
          role="group"
          aria-label="التسوق والبيع والمقارنة"
        >
          {PRIMARY_ACTIONS.map((action, index) => (
            <m.button
              key={action.id}
              type="button"
              className="premium-action-card"
              data-action={action.id}
              data-testid={`welcome-${action.id}`}
              disabled={busy}
              onClick={() => activate(action)}
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { ...surfaceSpring, delay: index * 0.045 }
              }
              whileHover={reduceMotion || busy ? undefined : { y: -4 }}
              whileTap={reduceMotion || busy ? undefined : { scale: 0.985 }}
            >
              <span className="premium-action-icon">
                <action.icon aria-hidden="true" />
              </span>
              <span className="premium-action-copy">
                <strong>{action.label}</strong>
                <span>{action.description}</span>
              </span>
            </m.button>
          ))}
        </div>
        <div className="ai-starters" role="group" aria-label="أمثلة للبدء">
          {STARTERS.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={busy}
              onClick={() => activate(action)}
              data-testid={`button-prompt-${action.label}`}
              data-action={action.id}
              className="ai-starter pressable"
            >
              <action.icon size={19} strokeWidth={1.8} aria-hidden="true" />
              <span>{action.label}</span>
            </button>
          ))}
        </div>
        {/* Public legal links on the home page (Google OAuth branding review reads them here). */}
        <nav className="ai-welcome-legal" aria-label="روابط قانونية" data-testid="welcome-legal-links">
          <Link href="/privacy">سياسة الخصوصية</Link>
          <span aria-hidden="true">·</span>
          <Link href="/terms">شروط الاستخدام</Link>
          <span aria-hidden="true">·</span>
          <Link href="/policies">كل السياسات</Link>
        </nav>
      </m.div>
    </LazyMotion>
  );
}
