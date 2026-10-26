import { iconButtonClass } from "@/ui/Button";
import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { currencySymbol, formatAmount } from "@/lib/format";

/** Price with the amount emphasized and the currency symbol quieter. Always LTR digits. */
export function PriceDisplay({
  amount,
  currency,
  size = "md",
  className,
  testId,
  suffix,
}: {
  amount: string | number | undefined;
  currency: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  testId?: string;
  suffix?: string;
}) {
  const sizes = {
    sm: "text-base",
    md: "text-lg",
    lg: "text-2xl",
    xl: "text-3xl",
  } as const;
  return (
    <span data-testid={testId} className={cn("inline-flex items-baseline gap-1 font-bold text-foreground", className)}>
      <span className={cn("num leading-none tracking-tight", sizes[size])}>{formatAmount(amount, currency)}</span>
      <span className={cn("font-semibold text-muted-foreground", size === "xl" || size === "lg" ? "text-md" : "text-xs")}>
        {currencySymbol(currency)}
      </span>
      {suffix && <span className="text-xs font-medium text-muted-foreground">{suffix}</span>}
    </span>
  );
}

/**
 * Stepper for integer quantities. `max` null = unlimited.
 * RTL: "+" sits at the start (right), "−" at the end.
 */
export function QuantitySelector({
  value,
  onChange,
  max,
  disabled,
  size = "md",
  label,
  ids,
}: {
  value: number;
  onChange: (next: number) => void;
  max: number | null;
  disabled?: boolean;
  size?: "sm" | "md";
  label: string;
  ids?: { input?: string; dec?: string; inc?: string; group?: string };
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const ceiling = max ?? Number.MAX_SAFE_INTEGER;
  const clamp = (n: number) => Math.min(ceiling, Math.max(1, n));
  const btn = iconButtonClass("ghost");
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={ids?.group}
      className={cn(
        "inline-flex items-center rounded-full border border-border-strong bg-card p-0.5",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        aria-label="زيادة الكمية"
        disabled={disabled || value >= ceiling}
        onClick={() => onChange(clamp(value + 1))}
        data-testid={ids?.inc}
        className={btn}
      >
        <Plus size={size === "md" ? 18 : 15} aria-hidden />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        value={draft}
        disabled={disabled}
        data-testid={ids?.input}
        onChange={(e) => {
          const raw = e.target.value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
          if (raw !== "" && !/^\d+$/.test(raw)) return;
          setDraft(raw);
          const n = Number(raw);
          if (raw !== "" && Number.isSafeInteger(n) && n >= 1) onChange(clamp(n));
        }}
        onBlur={() => setDraft(String(value))}
        className={cn(
          "num min-w-0 bg-transparent text-center font-bold text-foreground outline-none",
          size === "md" ? "h-10 w-12 text-md" : "h-8 w-9 text-base",
        )}
      />
      <button
        type="button"
        aria-label="تقليل الكمية"
        disabled={disabled || value <= 1}
        onClick={() => onChange(clamp(value - 1))}
        data-testid={ids?.dec}
        className={btn}
      >
        <Minus size={size === "md" ? 18 : 15} aria-hidden />
      </button>
    </div>
  );
}
