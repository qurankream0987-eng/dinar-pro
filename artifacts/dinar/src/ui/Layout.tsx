import { iconButtonClass } from "@/ui/Button";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ChevronLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Page title block. On phones an optional back button sits at the start (right in RTL). */
export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: string | true;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start gap-3 pb-5 pt-5 md:pt-8", className)}>
      {back && <BackButton to={back === true ? undefined : back} />}
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-base text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function BackButton({ to, label = "رجوع", onBack }: { to?: string; label?: string; onBack?: () => void }) {
  const [, navigate] = useLocation();
  return (
    <button
      type="button"
      aria-label={label}
      data-testid="button-back"
      onClick={() => {
        if (onBack) { onBack(); return; }
        if (!to && window.history.length > 1) window.history.back();
        else navigate(to ?? "/");
      }}
      className={`${iconButtonClass("ghost")} -ms-2 mt-0.5`}
    >
      {/* RTL: "back" points to the right */}
      <ArrowRight size={22} aria-hidden />
    </button>
  );
}

export function SectionHeader({
  title,
  href,
  linkLabel = "عرض الكل",
  subtitle,
  className,
}: {
  title: ReactNode;
  href?: string;
  linkLabel?: string;
  subtitle?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-foreground md:text-xl">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {href && (
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-sm py-1 text-sm font-semibold text-primary hover:underline"
        >
          {linkLabel}
          <ChevronLeft size={16} aria-hidden />
        </Link>
      )}
    </div>
  );
}

export function Card({
  children,
  className,
  as: Tag = "section",
  padded = true,
  testId,
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
  padded?: boolean;
  testId?: string;
}) {
  return (
    <Tag data-testid={testId} className={cn("rounded-xl border border-border bg-card", padded && "p-4 md:p-5", className)}>
      {children}
    </Tag>
  );
}

export function CardTitle({ children, icon, action }: { children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-md font-bold text-foreground">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Settings/menu style row. Renders a link when `href` is given. */
export function ListRow({
  href,
  onClick,
  icon,
  title,
  description,
  trailing,
  danger,
  testId,
}: {
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  danger?: boolean;
  testId?: string;
}) {
  const inner = (
    <>
      {icon && (
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
            danger ? "bg-destructive-soft text-destructive" : "bg-muted text-text-secondary",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 text-start">
        <span className={cn("block text-md font-semibold", danger ? "text-destructive" : "text-foreground")}>{title}</span>
        {description && <span className="block text-sm text-muted-foreground">{description}</span>}
      </span>
      {trailing ?? ((href || onClick) && !danger ? <ChevronLeft size={18} className="shrink-0 text-muted-foreground" aria-hidden /> : null)}
    </>
  );
  const cls = "pressable flex min-h-16 w-full items-center gap-3 px-4 py-3 hover:bg-muted/60";
  if (href)
    return (
      <Link href={href} className={cls} data-testid={testId}>
        {inner}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls} data-testid={testId}>
        {inner}
      </button>
    );
  return (
    <div className={cls} data-testid={testId}>
      {inner}
    </div>
  );
}

export function ListGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5">
      {title && <h2 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">{title}</h2>}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

/** Label/value pair list used in summaries. */
export function Summary({ rows, className }: { rows: { label: ReactNode; value: ReactNode; strong?: boolean }[]; className?: string }) {
  return (
    <dl className={cn("space-y-2.5", className)}>
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center justify-between gap-4",
            r.strong && "border-t border-border pt-3 text-md font-bold text-foreground",
          )}
        >
          <dt className={cn(!r.strong && "text-muted-foreground")}>{r.label}</dt>
          <dd className={cn("text-end", !r.strong && "font-medium text-foreground")}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
