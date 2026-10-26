import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowDownRight, ArrowUpRight, BarChart3, Banknote, Briefcase, Check, Circle, Clock3, CreditCard, Gauge, Handshake,
  Info, MapPin, Megaphone, Minus, PencilLine, Receipt, Send, ShoppingBag, Sparkles, Tag, Truck, User, X, type LucideIcon,
} from "lucide-react";
import { Button, buttonClass, type ButtonVariant } from "@/ui/Button";
import { cn } from "@/lib/utils";
import type { SURFACE_ICONS, SurfaceAction, SurfaceSection, VALUE_EMPHASES } from "@workspace/api-zod/surface-composition";

/**
 * DINAR surface primitives: the one visual vocabulary every conversation card is built from.
 * They only display what they are given (text is rendered as text, never as markup) and take
 * their colours from the chat palette, so light and dark follow the app theme.
 */
type Tone = "NEUTRAL" | "INFO" | "SUCCESS" | "WARNING" | "DANGER" | "GOLD";
type IconName = (typeof SURFACE_ICONS)[number];
type Emphasis = (typeof VALUE_EMPHASES)[number];

/** One icon set, two sizes: 18px in actions, 20px beside a card title. */
const ICONS: Record<IconName, LucideIcon> = {
  CHART: BarChart3, CART: ShoppingBag, TAG: Tag, TRUCK: Truck, PIN: MapPin, HANDSHAKE: Handshake, RECEIPT: Receipt,
  SPARKLE: Sparkles, GAUGE: Gauge, MEGAPHONE: Megaphone, BRIEFCASE: Briefcase, USER: User, INFO: Info, CLOCK: Clock3,
  SEND: Send, EDIT: PencilLine, CHECK: Check, CLOSE: X, CARD: CreditCard, CASH: Banknote,
};
export function SurfaceIcon({ name, size = 18 }: { name?: IconName; size?: number }) {
  if (!name) return null;
  const Icon = ICONS[name];
  return <Icon size={size} strokeWidth={2} aria-hidden />;
}
type Section<T extends SurfaceSection["type"]> = Extract<SurfaceSection, { type: T }>;

const number = (value: number) => value.toLocaleString("en-US");

export function SurfaceCard({
  label,
  tone = "NEUTRAL",
  state,
  status,
  testId,
  children,
}: {
  label: string;
  tone?: Tone;
  state?: string;
  status?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section
      dir="rtl"
      aria-label={label}
      className="ai-surface ds-card mt-3"
      data-tone={tone}
      data-state={state}
      data-status={status}
      data-testid={testId}
    >
      {children}
    </section>
  );
}

export function SurfaceBadge({ label, tone = "NEUTRAL" }: { label: string; tone?: Tone }) {
  return (
    <span className="ds-badge" data-tone={tone}>
      {label}
    </span>
  );
}

export function SurfaceHeader({ title, subtitle, badge, source, icon }: Omit<Section<"header">, "type">) {
  return (
    <header className="ds-header">
      {icon && (
        <span className="ds-header-icon">
          <SurfaceIcon name={icon} size={20} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="ds-title">{title}</h3>
        {subtitle && <p className="ds-subtitle">{subtitle}</p>}
      </div>
      {(badge || source) && (
        <div className="ds-header-aside">
          {badge && <SurfaceBadge {...badge} />}
          {source && <span className="ds-source">{source}</span>}
        </div>
      )}
    </header>
  );
}

export function SurfaceText({ text, muted, testId }: { text: string; muted?: boolean; testId?: string }) {
  return <p className={cn("ds-text", muted && "ds-muted")} dir="auto" data-testid={testId}>{text}</p>;
}

type Fact = { label: string; value: ReactNode; ltr?: boolean; emphasis?: Emphasis; testId?: string };

/** Label/value pairs; values are bidi-isolated so numbers and codes keep their order. */
export function FactList({ rows, className }: { rows: Fact[]; className?: string }) {
  const visible = rows.filter((row) => row.value !== undefined && row.value !== null && row.value !== "");
  if (!visible.length) return null;
  return (
    <dl className={cn("ds-facts", className)}>
      {visible.map((row, index) => (
        <div className="ds-fact" key={index}>
          <dt>{row.label}</dt>
          <dd data-emphasis={row.emphasis} data-testid={row.testId}>{row.ltr ? <bdi dir="ltr">{row.value}</bdi> : <bdi>{row.value}</bdi>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Trend({ trend }: { trend?: "UP" | "DOWN" | "FLAT" }) {
  if (!trend) return null;
  const Icon = trend === "UP" ? ArrowUpRight : trend === "DOWN" ? ArrowDownRight : Minus;
  const label = trend === "UP" ? "ارتفاع عن الفترة السابقة" : trend === "DOWN" ? "انخفاض عن الفترة السابقة" : "دون تغيير";
  return (
    <span className="ds-trend" data-trend={trend} role="img" aria-label={label}>
      <Icon size={13} aria-hidden />
    </span>
  );
}

export function MetricGrid({ label, items }: Omit<Section<"metrics">, "type">) {
  return (
    <dl className="ds-metrics" aria-label={label} data-count={items.length}>
      {items.map((item) => (
        <div key={item.key} className="ds-metric" data-testid={item.testId}>
          <dt>{item.label}</dt>
          <dd className="ds-metric-value">
            <bdi dir="ltr">{item.value}</bdi>
            <Trend trend={item.trend} />
          </dd>
          {item.previous && (
            <dd className="ds-metric-previous">
              السابق: <bdi dir="ltr">{item.previous}</bdi>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** Allowance used against its limit; colour changes only at 80% and 100%. */
export function UsageMeter({ label, used, limit, testId }: Omit<Section<"meter">, "type">) {
  const percent = limit > 0 ? Math.round((used / limit) * 100) : null;
  const level = percent === null ? "NONE" : percent >= 100 ? "FULL" : percent >= 80 ? "HIGH" : "OK";
  return (
    <div className="ds-meter" data-testid={testId} data-level={level}>
      <div className="ds-meter-row">
        <span>{label}</span>
        <bdi dir="ltr" className="tabular-nums">
          {number(used)} / {number(limit)}
          {percent !== null ? ` · ${percent}%` : ""}
        </bdi>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        className="ds-meter-track"
      >
        <div className="ds-meter-fill" style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </div>
    </div>
  );
}

/** Server-priced lines and total; nothing is added up in the browser. */
export function MoneyBreakdown({ lines, total, disclosure }: Omit<Section<"money">, "type">) {
  return (
    <div className="ds-money">
      {lines.length > 0 && <FactList rows={lines.map((item) => ({ ...item, ltr: true }))} />}
      {total && (
        <p className="ds-total" data-verified={total.verified || undefined}>
          <span>{total.label}</span>
          <bdi dir="ltr" data-testid={total.testId}>{total.value}</bdi>
        </p>
      )}
      {disclosure && <p className="ds-text ds-muted">{disclosure}</p>}
    </div>
  );
}

const STEP_ICON = { DONE: Check, CURRENT: Circle, PENDING: Circle, CANCELLED: X } as const;
const STEP_STATE = { DONE: "مكتمل", CURRENT: "الحالي", PENDING: "لم يحدث بعد", CANCELLED: "ملغى" } as const;

/** Recorded events only, oldest first; future steps are marked as not yet happened. */
export function Timeline({ label, steps }: Omit<Section<"timeline">, "type">) {
  return (
    <ol className="ds-timeline" aria-label={label}>
      {steps.map((step, index) => {
        const Icon = STEP_ICON[step.state];
        return (
          <li key={index} className="ds-step" data-state={step.state} aria-current={step.state === "CURRENT" ? "step" : undefined}>
            <span className="ds-step-dot" aria-hidden>
              <Icon size={11} strokeWidth={3} />
            </span>
            <div className="min-w-0">
              <p className="ds-step-label">
                {step.label}
                <span className="sr-only"> — {STEP_STATE[step.state]}</span>
              </p>
              {(step.at || step.detail) && (
                <p className="ds-step-meta">
                  {step.at && <bdi>{step.at}</bdi>}
                  {step.at && step.detail ? " · " : ""}
                  {step.detail}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Horizontal bars scaled to the largest given value; the label carries the exact figure. */
export function BarList({ label, items }: Omit<Section<"bars">, "type">) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ul className="ds-bars" aria-label={label}>
      {items.map((item, index) => (
        <li key={index} className="ds-bar" data-testid={item.testId}>
          <p className="ds-bar-row">
            <span className="min-w-0 truncate" dir="auto" title={item.label}>{item.label}</span>
            <bdi className="shrink-0 tabular-nums">{item.display}</bdi>
          </p>
          <div className="ds-bar-track" aria-hidden>
            <div className="ds-bar-fill" style={{ width: `${Math.round((item.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SurfaceNotice({ tone, text, testId }: { tone: Tone | "PENDING"; text: string; testId?: string }) {
  return (
    <p
      className="ds-notice"
      data-tone={tone}
      data-testid={testId}
      role={tone === "DANGER" || tone === "WARNING" || tone === "PENDING" ? "status" : undefined}
    >
      {tone === "PENDING" && <Clock3 size={14} aria-hidden />}
      {text}
    </p>
  );
}

const EMPHASIS: Record<SurfaceAction["emphasis"], ButtonVariant> = { PRIMARY: "primary", SECONDARY: "secondary", QUIET: "ghost", DANGER: "danger-soft" };

/**
 * A button only exists when it can do something: SEND needs a live conversation turn, so on
 * an older card (or while DINAR is busy) the action is not offered at all.
 */
export function SurfaceActionButton({ action, onSend }: { action: SurfaceAction; onSend?: (text: string) => void }) {
  if (action.kind === "NAVIGATE")
    return (
      <Link href={action.path} className={buttonClass(EMPHASIS[action.emphasis], "sm")} data-testid={action.testId}>
        <SurfaceIcon name={action.icon} />
        {action.label}
      </Link>
    );
  if (!onSend) return null;
  return (
    <Button
      size="sm"
      // A selected option reads as chosen (gold), not as a second primary action.
      variant={action.pressed ? "gold" : EMPHASIS[action.emphasis]}
      icon={<SurfaceIcon name={action.icon} />}
      aria-pressed={action.pressed === undefined ? undefined : action.pressed}
      disabled={action.disabled}
      onClick={() => onSend(action.message)}
      data-testid={action.testId}
    >
      {action.label}
    </Button>
  );
}

export function ActionRow({ items, onSend }: { items: SurfaceAction[]; onSend?: (text: string) => void }) {
  const offered = items.filter((action) => action.kind === "NAVIGATE" || onSend);
  if (!offered.length) return null;
  return (
    <div className="ds-actions">
      {offered.map((action, index) => (
        <SurfaceActionButton key={index} action={action} onSend={onSend} />
      ))}
    </div>
  );
}

export function OptionList({ label, layout, items, onSend }: Omit<Section<"options">, "type"> & { onSend?: (text: string) => void }) {
  return (
    <ul className="ds-options" data-layout={layout} data-count={items.length} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="ds-option" data-highlighted={item.highlighted || undefined} data-status={item.status} data-testid={item.testId}>
          <div className="ds-option-head">
            <h4 className="ds-option-title">{item.title}</h4>
            {item.badge && <SurfaceBadge {...item.badge} />}
          </div>
          {item.subtitle && <p className="ds-option-subtitle" data-muted={item.subtitleMuted || undefined}><bdi>{item.subtitle}</bdi></p>}
          {item.facts?.length ? <FactList className="ds-facts-compact" rows={item.facts} /> : null}
          {item.actions?.some((action) => action.kind === "NAVIGATE" || onSend) ? (
            <div className="ds-option-action">
              {item.actions.map((action, index) => (
                <SurfaceActionButton key={index} action={action} onSend={onSend} />
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * For specialized renderers that keep their own forms (delivery address entry, promotion
 * budgets, commerce reviews): the same panel, fact rows and action row as composed cards.
 */
export function SurfacePanel({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="ds-panel" data-testid={testId}>
      {children}
    </div>
  );
}

export function SurfaceActions({ children }: { children: ReactNode }) {
  return <div className="ds-actions">{children}</div>;
}

/** Label/value tuples as fact rows; a missing value reads "—" (DASH) or leaves its row out (HIDE). */
export function factRows(rows: [string, ReactNode][], missing: "DASH" | "HIDE" = "DASH"): Fact[] {
  return rows.map(([label, value]) => ({ label, value: missing === "DASH" ? (value ?? "—") : value }));
}
