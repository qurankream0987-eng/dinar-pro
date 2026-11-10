import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ReasoningEffort } from "./ChatComposer";

const LEVELS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: "low", label: "خفيف", hint: "رد سريع ومختصر" },
  { value: "medium", label: "متوسط", hint: "توازن بين السرعة والعمق" },
  { value: "high", label: "أعمق", hint: "تفكير أطول وإجابة مفصّلة" },
];

/** Three rising bars; the lit count shows the level. */
function LevelBars({ level }: { level: number }) {
  return (
    <svg className="effort-bars" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 5} y={10 - i * 4} width="3" height={4 + i * 4} rx="1.2"
          className={i < level ? "is-lit" : undefined} style={{ transitionDelay: `${i * 60}ms` }} />
      ))}
    </svg>
  );
}

export function EffortPicker({ value, disabled, onChange }: { value: ReasoningEffort; disabled?: boolean; onChange: (value: ReasoningEffort) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const index = Math.max(0, LEVELS.findIndex((level) => level.value === value));
  const current = LEVELS[index]!;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { if (open) root.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus(); }, [open]);

  const choose = (next: ReasoningEffort) => {
    onChange(next);
    setOpen(false);
    root.current?.querySelector<HTMLButtonElement>(".effort-trigger")?.focus();
  };
  const onListKey = (event: KeyboardEvent) => {
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); root.current?.querySelector<HTMLButtonElement>(".effort-trigger")?.focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };

  return (
    <div className="effort-picker" ref={root} data-level={current.value}>
      <button
        type="button"
        className="effort-trigger"
        aria-label={`مستوى التفكير: ${current.label}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        data-testid="button-effort"
        onClick={() => setOpen((was) => !was)}
      >
        <LevelBars level={index + 1} />
        <span className="effort-label">{current.label}</span>
      </button>
      {open && (
        <div id={listId} className="effort-menu" role="radiogroup" aria-label="مستوى التفكير" onKeyDown={onListKey}>
          {LEVELS.map((level, i) => (
            <button key={level.value} type="button" role="radio" aria-checked={level.value === value}
              className="effort-option" data-testid={`effort-${level.value}`} onClick={() => choose(level.value)}>
              <LevelBars level={i + 1} />
              <span className="effort-text"><strong>{level.label}</strong><small>{level.hint}</small></span>
              <svg className="effort-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
