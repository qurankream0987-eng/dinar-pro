import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/marketplace";
import { Button } from "./Button";

const toneClass: Record<Tone, string> = {
  neutral: "bg-muted text-text-secondary",
  info: "bg-info-soft text-info",
  primary: "bg-primary-soft text-primary-soft-foreground",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  danger: "bg-destructive-soft text-destructive",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  icon,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-2xs font-semibold",
        toneClass[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Order status chip with a leading dot. */
export function StatusBadge({ label, tone, testId }: { label: string; tone: Tone; testId?: string }) {
  return (
    <Badge tone={tone} testId={testId}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-md", className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  compact,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("dinar-empty-state flex flex-col items-center text-center animate-fade", compact ? "px-4 py-8" : "px-6 py-14 sm:py-20")}
    >
      <div className="relative mb-5">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-soft text-primary-soft-foreground">
          <Icon size={28} strokeWidth={1.75} aria-hidden />
        </div>
        <span aria-hidden className="absolute -end-1 -top-1 h-4 w-4 rounded-full border-[3px] border-background bg-accent" />
      </div>
      <h2 className="text-lg font-bold text-foreground">{title}</h2>
      {body && <p className="mt-1.5 max-w-xs text-base text-muted-foreground">{body}</p>}
      {action && <div className="mt-6 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "تعذّر تحميل المحتوى",
  body = "تحقق من اتصالك ثم حاول مرة أخرى.",
  onRetry,
  compact,
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div role="alert" className={cn("dinar-error-state flex flex-col items-center text-center", compact ? "px-4 py-8" : "px-6 py-16")}>
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive-soft text-destructive">
        <CircleAlert size={26} aria-hidden />
      </div>
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-1 max-w-xs text-base text-muted-foreground">{body}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-5" onClick={onRetry} icon={<RotateCw size={16} />} data-testid="button-retry">
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
}

const alertIcons = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert };

export function InlineAlert({
  tone = "info",
  title,
  children,
  className,
  testId,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const Icon = alertIcons[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-testid={testId}
      className={cn("flex items-start gap-2.5 rounded-md p-3 text-sm leading-6", toneClass[tone], className)}
    >
      <Icon size={17} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && "opacity-90")}>{children}</div>}
      </div>
    </div>
  );
}
