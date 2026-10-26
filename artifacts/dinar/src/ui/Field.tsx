import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export const controlClass =
  "w-full min-w-0 rounded-md border border-input bg-card px-3.5 text-md text-foreground placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-200 hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/12 disabled:bg-muted disabled:text-muted-foreground aria-[invalid=true]:border-destructive aria-[invalid=true]:focus:ring-destructive/12";

/**
 * Label + control + hint/error, with ids wired for screen readers.
 * The single child control receives id / aria-describedby / aria-invalid.
 */
export function Field({
  label,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: (children.props.id as string) ?? id,
        "aria-describedby": [errorId, hintId].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={(children.props.id as string) ?? id} className="text-sm font-semibold text-foreground">
        {label}
        {optional && <span className="ms-1 font-normal text-muted-foreground">(اختياري)</span>}
      </label>
      {control}
      {error ? (
        <p id={errorId} className="flex items-center gap-1.5 text-xs font-medium text-destructive">
          <CircleAlert size={14} aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(controlClass, "h-12", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(controlClass, "min-h-28 resize-y py-3 leading-7", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select ref={ref} className={cn(controlClass, "h-12 appearance-none pe-10", className)} {...rest}>
          {children}
        </select>
        <ChevronDown
          size={18}
          aria-hidden
          className="pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    );
  },
);

export function Checkbox({
  checked,
  onChange,
  children,
  name,
  required,
  testId,
}: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  children: ReactNode;
  name?: string;
  required?: boolean;
  testId?: string;
}) {
  return (
    <label className="group flex cursor-pointer items-start gap-3 text-sm leading-6 text-text-secondary">
      <span className="relative mt-0.5 inline-flex h-5 w-5 shrink-0">
        <input
          type="checkbox"
          name={name}
          required={required}
          checked={checked}
          onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
          data-testid={testId}
          className="peer h-5 w-5 cursor-pointer appearance-none rounded-[6px] border-2 border-border-strong bg-card transition checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <Check
          size={14}
          strokeWidth={3}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto text-primary-foreground opacity-0 peer-checked:opacity-100"
        />
      </span>
      <span>{children}</span>
    </label>
  );
}

/** Large radio-style option card used in wizards and filters. */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  name,
  value,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  name: string;
  value: string;
  testId?: string;
}) {
  return (
    <label
      data-testid={testId}
      className={cn(
        "pressable flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        selected ? "border-primary bg-primary-soft/60 ring-1 ring-primary" : "border-border hover:border-border-strong",
      )}
    >
      <input type="radio" name={name} value={value} checked={selected} onChange={onSelect} className="sr-only" />
      {icon && (
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
            selected ? "bg-primary text-primary-foreground" : "bg-muted text-text-secondary",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-md font-semibold text-foreground">{title}</span>
        {description && <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
          selected ? "border-primary" : "border-border-strong",
        )}
      >
        {selected && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
      </span>
    </label>
  );
}

/** Segmented control (tabs that switch a view in place). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; testId?: string }[];
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex rounded-md bg-muted p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
          className={cn(
            "dinar-chip flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold",
            value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Horizontal filter chip. */
export function Chip({
  active,
  onClick,
  children,
  icon,
  testId,
  className,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  icon?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "dinar-chip inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-sm font-semibold",
        active
          ? "border-primary/40 bg-primary-soft text-primary-soft-foreground"
          : "border-border bg-card text-text-secondary hover:border-border-strong hover:text-foreground",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}
