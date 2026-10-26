import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, IconButton, type ButtonVariant } from "./Button";

/**
 * One overlay primitive for the whole app:
 * bottom sheet on phones (thumb reach), centered dialog from 768px.
 * Built on Radix Dialog → focus trap, Esc, aria-modal, scroll lock.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width,
  hideClose,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  hideClose?: boolean;
  testId?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay" />
        <DialogPrimitive.Content
          dir="rtl"
          data-testid={testId}
          className="sheet-content focus:outline-none"
          style={width ? ({ "--sheet-w": `${width}px` } as React.CSSProperties) : undefined}
        >
          <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-border-strong md:hidden" />
          <div className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-3 md:pt-5">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-lg font-bold text-foreground">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-base text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : ""}</DialogPrimitive.Description>
              )}
            </div>
            {!hideClose && (
              <DialogPrimitive.Close asChild>
                <IconButton label="إغلاق" size="sm" variant="soft" className="-me-1">
                  <X size={18} />
                </IconButton>
              </DialogPrimitive.Close>
            )}
          </div>
          {children && <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-2">{children}</div>}
          {footer && <div className="shrink-0 border-t border-border px-5 py-4">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Confirmation for important / irreversible actions only. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = "تراجع",
  tone = "primary",
  onConfirm,
  loading,
  icon,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const variant: ButtonVariant = tone === "danger" ? "danger" : "primary";
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-3">
          {icon && (
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                tone === "danger" ? "bg-destructive-soft text-destructive" : "bg-primary-soft text-primary-soft-foreground",
              )}
            >
              {icon}
            </span>
          )}
          {title}
        </span>
      }
      description={body}
      width={420}
      hideClose
      testId="dialog-confirm"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" block onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={variant} block onClick={onConfirm} loading={loading} data-testid="button-confirm-action">
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Sheet>
  );
}
