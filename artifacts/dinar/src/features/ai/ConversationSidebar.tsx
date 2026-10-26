import { useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/** Desktop navigation and the mobile drawer share content, never two competing focus regions. */
export function ConversationSidebar({
  open,
  onOpenChange,
  collapsed = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsed?: boolean;
  children: ReactNode;
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setMobile(query.matches);
      if (!query.matches) onOpenChange(false);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [onOpenChange]);
  if (!mobile)
    return (
      <aside
        id="ai-conversation-history"
        aria-label="التنقل في DINAR والمحادثات"
        data-collapsed={collapsed}
        className="dinar-chat-sidebar ai-history flex min-h-0 flex-col"
      >
        {children}
      </aside>
    );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ai-history-overlay fixed inset-0 z-[var(--z-overlay)]" />
        <Dialog.Content
          id="ai-conversation-history"
          dir="rtl"
          className="dinar-chat-sidebar ai-history-drawer ai-history fixed inset-y-0 start-0 z-[var(--z-modal)] flex flex-col rounded-e-2xl outline-none"
          style={{
            paddingTop: "max(12px, env(safe-area-inset-top, 0px))",
            paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))",
            paddingInlineStart: "max(10px, env(safe-area-inset-right, 0px))",
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>(
              '[data-testid="button-toggle-conversation-history"]',
            )).find((button) => button.getClientRects().length > 0);
            trigger?.focus();
          }}
        >
          <Dialog.Title className="sr-only">سجل المحادثات</Dialog.Title>
          <Dialog.Description className="sr-only">
            انتقل بين أقسام DINAR، وابحث في محادثاتك، أو ابدأ محادثة جديدة.
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
