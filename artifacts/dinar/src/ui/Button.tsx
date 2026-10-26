import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "gold"
  | "secondary"
  | "soft"
  | "ghost"
  | "danger"
  | "danger-soft"
  | "success"
  | "nav";
export type ButtonSize = "sm" | "md" | "lg";

const base = "dinar-button inline-flex max-w-full select-none items-center justify-center gap-2 text-center font-semibold";

const variants: Record<ButtonVariant, string> = {
  primary: "dinar-button--primary",
  gold: "dinar-button--primary",
  secondary: "dinar-button--secondary",
  soft: "dinar-button--secondary",
  ghost: "dinar-button--ghost",
  danger: "dinar-button--danger",
  "danger-soft": "dinar-button--danger-soft",
  success: "dinar-button--success",
  nav: "dinar-button--nav",
};
const sizes: Record<ButtonSize, string> = {
  sm: "dinar-button--sm",
  md: "dinar-button--md",
  lg: "dinar-button--lg",
};

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  block = false,
  className?: string,
) {
  return cn(base, variants[variant], sizes[size], block && "w-full", className);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, block, loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, block, className)}
      {...rest}
    >
      {loading ? <Loader2 size={18} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant,
  size,
  block,
  icon,
  className,
  children,
  ...rest
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  "data-testid"?: string;
  "aria-label"?: string;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size, block, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "ghost" | "outline" | "soft" | "solid";
  size?: "sm" | "md";
};

export const iconButtonClass = (variant: IconButtonProps["variant"] = "ghost", size: IconButtonProps["size"] = "md") =>
  cn("dinar-button dinar-icon-button relative inline-flex shrink-0 items-center justify-center",
    size === "md" ? "dinar-icon-button--md" : "dinar-icon-button--sm",
    variant === "ghost" && "dinar-button--ghost",
    variant === "outline" && "dinar-button--secondary",
    variant === "soft" && "dinar-button--secondary",
    variant === "solid" && "dinar-button--primary");

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant, size, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(iconButtonClass(variant, size), className)}
      {...rest}
    >
      {children}
    </button>
  );
});
