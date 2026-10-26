import { Toaster as Sonner } from "sonner";

/** App-wide toast host. Use `toast.success(...)` from "sonner" for meaningful feedback only. */
export function Toaster() {
  return (
    <Sonner
      dir="rtl"
      position="top-center"
      offset={16}
      mobileOffset={{ top: 12 }}
      duration={2800}
      visibleToasts={2}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "pointer-events-auto flex w-[min(92vw,380px)] items-center gap-3 rounded-xl border border-border bg-elevated px-4 py-3 text-sm font-semibold text-foreground shadow-lg dark:bg-elevated dark:text-foreground dark:ring-1 dark:ring-border-strong",
          title: "leading-6",
          description: "text-xs font-normal opacity-80",
          icon: "text-accent",
          actionButton: "ms-auto rounded-sm bg-accent px-2.5 py-1 text-xs font-bold text-accent-foreground",
        },
      }}
    />
  );
}
