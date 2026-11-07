import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Bell,
  Bot,
  PlusCircle,
  ReceiptText,
  Search,
  ShoppingCart,
  UserRound,
  Compass,
  PanelRightOpen,
  SquarePen,
  Settings,
} from "lucide-react";
import { useGetOrders } from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { useCart } from "@/cart/CartContext";
import { cn } from "@/lib/utils";
import { nextAction } from "@/lib/marketplace";
import { BrandMark, Avatar } from "@/ui/Media";
import { DinarMark } from "@/ui/DinarMark";
import { ButtonLink, iconButtonClass } from "@/ui/Button";
import { MarketChip } from "./MarketSelector";
import { roleIn, type OrderView } from "./OrderCard";

/** Screens that own the bottom of the viewport (purchase bars, composer, wizards). */
const FOCUS_ROUTES = [
  /^\/listings\/[^/]+$/,
  /^\/cart$/,
  /^\/checkout$/,
  /^\/orders\/[^/]+$/,
  /^\/seller\/new$/,
  /^\/seller\/offers\/[^/]+\/edit$/,
];
const BARE_ROUTES = [/^\/login$/, /^\/register$/];

const NAV = [
  {
    href: "/",
    label: "DINAR AI",
    icon: Bot,
    match: (p: string) => p === "/" || p === "/ai",
  },
  {
    href: "/discover",
    label: "استكشف",
    icon: Compass,
    match: (p: string) => p.startsWith("/search") || p === "/discover",
  },
  {
    href: "/seller",
    label: "بيع",
    icon: PlusCircle,
    match: (p: string) => p.startsWith("/seller"),
  },
  {
    href: "/orders",
    label: "طلباتي",
    icon: ReceiptText,
    match: (p: string) => p.startsWith("/orders"),
  },
  {
    href: "/profile",
    label: "حسابي",
    icon: UserRound,
    match: (p: string) => ["/profile", "/settings"].includes(p),
  },
];

/** Orders waiting on the signed-in user — drives the bell dot. Real data only. */
export function useActionableOrders() {
  const { user } = useAccount();
  const orders = useGetOrders(undefined, {
    query: {
      enabled: !!user,
      staleTime: 30000,
      refetchInterval: 60000,
    } as never,
  });
  const list = ((orders.data ?? []) as OrderView[]).filter((o) =>
    nextAction(o.status, roleIn(o, user?.id)),
  );
  return { list, query: orders };
}

export function AppShell({
  children,
  chatOnly = false,
}: {
  children: ReactNode;
  chatOnly?: boolean;
}) {
  const [location] = useLocation();
  const chat = chatOnly || location === "/" || location === "/ai";
  const focus = FOCUS_ROUTES.some((r) => r.test(location));
  const bare = BARE_ROUTES.some((r) => r.test(location));
  return (
    <div className="min-h-[100dvh] bg-background">
      <a
        href="#main"
        className="sr-only z-[90] rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        تخطَّ إلى المحتوى
      </a>
      {!bare && !chat && <SiteSidebar location={location} />}
      <div
        className="app-shell-main"
        data-sidebar={bare ? "none" : chat ? "chat" : "site"}
      >
        {!chat && <TopBar location={location} minimal={bare} />}
        <main
          id="main"
          className="app-main"
          data-bar={chat ? "chat" : focus ? "action" : bare ? "none" : "nav"}
        >
          <div key={location} className="animate-fade">
            {children}
          </div>
        </main>
        {!focus && !bare && !chat && <BottomNav location={location} />}
        {!bare && !chat && <Footer />}
      </div>
    </div>
  );
}

function SiteSidebar({ location }: { location: string }) {
  const { user } = useAccount();
  return (
    <aside
      aria-label="التنقل في DINAR AI"
      data-testid="site-sidebar"
      className="site-nav-dark site-sidebar fixed inset-y-0 start-0 z-[var(--z-sidebar)] hidden w-[var(--site-sidebar-width)] flex-col items-center border-e border-accent/30 px-3 py-4 lg:flex"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        className="site-sidebar-art absolute inset-0 h-full w-full"
        viewBox="0 0 112 960"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="site-sidebar-gold" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#82521c" />
            <stop offset="0.34" stopColor="#f6d789" />
            <stop offset="0.66" stopColor="#bd832f" />
            <stop offset="1" stopColor="#fff0bd" />
          </linearGradient>
          <pattern
            id="site-sidebar-crackle"
            width="48"
            height="56"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M-4 12 10 3 20 9 33 2 51 12M10 3 9 21 20 28 20 9M20 28 34 21 33 2M-3 40 9 21 22 39 34 21 51 42M22 39 20 56M34 21 43 31 51 42"
              fill="none"
              stroke="#d7b26e"
              strokeOpacity=".2"
              strokeWidth=".7"
            />
          </pattern>
        </defs>
        <path
          d="M-12 468c21 38 82 38 112 77v159C77 742 33 768-12 816V651c34-33 43-68 23-101-7-12-15-19-23-25Z"
          fill="url(#site-sidebar-crackle)"
          opacity=".66"
        />
        <path
          d="M-10 469c25 40 91 37 111 78 28 58-7 105-46 145-23 24-47 42-66 69"
          fill="none"
          stroke="url(#site-sidebar-gold)"
          strokeOpacity=".72"
          strokeWidth="1.5"
        />
        <path
          d="M-12 782c28-43 54-62 78-59 18 2 29 13 50 1v29c-19 14-35 8-52 6-25-3-43 20-76 65Z"
          fill="url(#site-sidebar-gold)"
          opacity=".92"
        />
        <path
          d="M-10 836c33-48 59-72 82-72 18 0 29 11 45-1"
          fill="none"
          stroke="url(#site-sidebar-gold)"
          strokeOpacity=".55"
          strokeWidth="1.3"
        />
      </svg>
      <Link
        href="/"
        data-testid="link-brand-sidebar"
        aria-label="DINAR AI — الرئيسية"
        className="site-sidebar-brand flex h-24 w-full items-center justify-center rounded-xl"
      >
        <DinarMark size={84} className="site-sidebar-logo" />
      </Link>

      <div className="mt-3">
        <MarketChip
          testId="button-market-sidebar"
          compact
          className="site-sidebar-market border-accent/25 bg-white/[0.035] text-accent hover:border-accent/50 hover:bg-white/[0.07]"
        />
      </div>

      <div className="my-4 h-px w-14 bg-accent/20" aria-hidden />
      <nav
        aria-label="التنقل الرئيسي"
        className="flex min-h-0 flex-1 flex-col items-center gap-2.5 overflow-y-auto py-1"
      >
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active =
            href === "/profile" ? location === "/profile" : match(location);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              data-testid={`sidebar-nav-${href.slice(1) || "home"}`}
              className="site-nav-link site-rail-action pressable group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
            >
              <Icon size={21} strokeWidth={1.8} aria-hidden />
              <span className="sr-only">{label}</span>
              <span className="site-sidebar-tooltip" aria-hidden>
                {label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="site-sidebar-footer mt-auto flex w-full flex-col items-center gap-2 border-t border-accent/20 pt-3">
        <Link
          href="/settings"
          data-testid="link-sidebar-settings"
          aria-label="الإعدادات"
          aria-current={location === "/settings" ? "page" : undefined}
          className="site-nav-link site-rail-action pressable group relative flex h-10 w-10 items-center justify-center rounded-xl"
        >
          <Settings size={21} strokeWidth={1.8} aria-hidden />
          <span className="sr-only">الإعدادات</span>
          <span className="site-sidebar-tooltip" aria-hidden>
            الإعدادات
          </span>
        </Link>
        {user ? (
          <Link
            href="/profile"
            data-testid="link-sidebar-profile"
            aria-label={`حسابي، ${user.displayName}`}
            className="site-sidebar-account pressable group relative flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] p-1 hover:border-white/30 hover:bg-white/[0.09]"
          >
            <Avatar
              name={user.displayName}
              src={
                user.avatarObjectPath
                  ? `/api/storage${user.avatarObjectPath}`
                  : undefined
              }
              size={40}
            />
            <span className="site-sidebar-tooltip" aria-hidden>
              {user.displayName}
            </span>
          </Link>
        ) : (
          <Link
            href="/login"
            data-testid="link-sidebar-login"
            aria-label="تسجيل الدخول"
            className="site-nav-link site-rail-action pressable group relative flex h-10 w-10 items-center justify-center rounded-xl"
          >
            <UserRound size={21} strokeWidth={1.8} aria-hidden />
            <span className="site-sidebar-tooltip" aria-hidden>
              تسجيل الدخول
            </span>
          </Link>
        )}
      </div>
    </aside>
  );
}

function CartButton({
  className,
  testId = "link-cart",
  active = false,
}: {
  className?: string;
  testId?: string;
  active?: boolean;
}) {
  const { unitCount } = useCart();
  return (
    <Link
      href="/cart"
      data-testid={testId}
      aria-current={active ? "page" : undefined}
      aria-label={unitCount ? `السلة، ${unitCount} وحدة` : "السلة"}
      className={cn(iconButtonClass("ghost"), className)}
    >
      <ShoppingCart size={22} aria-hidden />
      {testId === "sidebar-cart" && (
        <span className="site-sidebar-tooltip" aria-hidden>
          السلة
        </span>
      )}
      {unitCount > 0 && (
        <span
          key={unitCount}
          data-testid="badge-cart-units"
          className="num absolute end-0.5 top-0.5 flex h-[18px] min-w-[18px] animate-pop items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground ring-2 ring-background"
        >
          {unitCount > 99 ? "99+" : unitCount}
        </span>
      )}
    </Link>
  );
}

function BellButton({
  className,
  testId = "link-notifications",
  active = false,
}: {
  className?: string;
  testId?: string;
  active?: boolean;
}) {
  const { user } = useAccount();
  const { list } = useActionableOrders();
  return (
    <Link
      href="/notifications"
      data-testid={testId}
      aria-current={active ? "page" : undefined}
      aria-label={
        list.length ? `التنبيهات، ${list.length} بانتظار إجراء` : "التنبيهات"
      }
      className={cn(iconButtonClass("ghost"), className)}
    >
      <Bell size={21} aria-hidden />
      {testId === "sidebar-notifications" && (
        <span className="site-sidebar-tooltip" aria-hidden>
          التنبيهات
        </span>
      )}
      {user && list.length > 0 && (
        <span
          aria-hidden
          className="absolute end-[9px] top-[8px] h-2 w-2 rounded-full bg-destructive ring-2 ring-background"
        />
      )}
    </Link>
  );
}

function DesktopSearch() {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(
          q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : "/search",
        );
      }}
      className="relative hidden w-full max-w-[380px] lg:block"
    >
      <Search
        size={18}
        className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="ماذا تبحث عنه؟"
        aria-label="البحث في العروض"
        className="h-11 w-full rounded-full border border-border bg-muted/70 ps-11 pe-4 text-base outline-none transition focus:border-primary focus:bg-card focus:ring-4 focus:ring-primary/10"
      />
    </form>
  );
}

function TopBar({ location, minimal }: { location: string; minimal: boolean }) {
  const chat = location === "/" || location === "/ai";
  const { user } = useAccount();
  return (
    <header
      className={cn(
        "sticky top-0 z-[var(--z-header)] border-b border-border/70 bg-background/88 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80",
        chat && "chat-topbar",
      )}
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="container-app flex h-[var(--topbar-h)] items-center gap-2 md:gap-4">
        {chat && <button type="button" aria-label="عرض المحادثات" aria-controls="ai-conversation-history" data-testid="button-toggle-conversation-history" className={iconButtonClass("ghost")} onClick={() => window.dispatchEvent(new Event("dinar:history"))}><PanelRightOpen size={20} aria-hidden /></button>}
        <Link
          href="/"
          data-testid="link-brand"
          aria-label="DINAR AI — الرئيسية"
          className="shrink-0 rounded-md lg:hidden"
        >
          <BrandMark
            size={34}
            className={cn("[&_.text-lg]:text-md md:[&_.text-lg]:text-lg max-[390px]:[&>span]:hidden", chat && "max-[480px]:[&>span]:hidden")}
          />
        </Link>
        {!minimal && (
          <MarketChip
            className="ms-1 max-[359px]:[&_.market-name]:hidden lg:hidden"
          />
        )}
        {!minimal && !chat && (
          <nav
            aria-label="التنقل الرئيسي"
            className="ms-4 hidden items-center gap-1 min-[960px]:flex lg:hidden"
          >
            {NAV.slice(0, 4).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.match(location) ? "page" : undefined}
                className={cn(
                  "rounded-full px-3.5 py-2 text-base font-semibold transition-colors",
                  n.match(location)
                    ? "bg-primary-soft text-primary-soft-foreground"
                    : "text-text-secondary hover:bg-muted hover:text-foreground",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        )}
        <div className="ms-auto flex items-center gap-0.5 md:gap-1">
          {chat && <button type="button" aria-label="محادثة جديدة" data-testid="button-new-conversation-header" className={`${iconButtonClass("ghost")} md:hidden`} onClick={() => window.dispatchEvent(new Event("dinar:new-conversation"))}><SquarePen size={20} aria-hidden /></button>}
          {chat && <button type="button" aria-label="افتح حسابي" className={iconButtonClass("ghost")} onClick={() => window.dispatchEvent(new Event("dinar:account"))}><UserRound size={20} /></button>}
          {!minimal && location !== "/" && location !== "/ai" && (
            <Link
              href="/"
              aria-current={location === "/ai" ? "page" : undefined}
              aria-label="DINAR AI"
              className={cn(
                "pressable me-1 inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-sm font-bold lg:hidden",
                location === "/ai"
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-card text-text-secondary hover:border-primary/40 hover:text-primary",
              )}
            >
              <Bot size={17} aria-hidden />
              <span className="hidden sm:inline">DINAR AI</span>
            </Link>
          )}
          {!minimal && location !== "/" && location !== "/ai" && (
            <DesktopSearch />
          )}
          {!minimal && !chat && (
            <div className="flex items-center gap-0.5">
              <BellButton />
              <CartButton />
            </div>
          )}
      <div className={cn("hidden md:ms-2 lg:hidden", !minimal && !chat && "md:block")}>
            {user ? (
              <Link
                href="/profile"
                data-testid="button-profile"
                className="pressable flex items-center gap-2 rounded-full border border-border bg-card py-1 pe-3 ps-1 text-sm font-semibold hover:border-border-strong"
              >
                <Avatar
                  name={user.displayName}
                  src={
                    user.avatarObjectPath
                      ? `/api/storage${user.avatarObjectPath}`
                      : undefined
                  }
                  size={32}
                />
                <span className="max-w-[120px] truncate">
                  {user.displayName}
                </span>
              </Link>
            ) : (
              <ButtonLink href="/login" size="sm" data-testid="button-profile">
                تسجيل الدخول
              </ButtonLink>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function BottomNav({ location }: { location: string }) {
  return (
    <nav
      aria-label="التنقل السفلي"
      data-testid="bottom-navigation"
      className="site-nav-dark site-bottomnav fixed inset-x-0 bottom-0 z-[var(--z-nav)] border-t border-white/10 backdrop-blur-xl lg:hidden"
      style={{ paddingBottom: "var(--safe-bottom)" }}
    >
      <div className="mx-auto grid h-[var(--bottomnav-h)] max-w-lg grid-cols-5">
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match(location);
          const sell = href === "/seller";
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              data-testid={`nav-${href.slice(1) || "home"}`}
              className={cn(
                "pressable flex flex-col items-center justify-center gap-1 text-2xs font-semibold",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {sell ? (
                <span
                  className={cn(
                    "flex h-8 w-12 items-center justify-center rounded-full transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "bg-accent/15 text-accent",
                  )}
                >
                  <Icon size={20} strokeWidth={2.2} aria-hidden />
                </span>
              ) : (
                <span
                  className={cn(
                    "flex h-8 w-14 items-center justify-center rounded-full transition-colors",
                    active && "bg-accent/15",
                  )}
                >
                  <Icon
                    size={21}
                    strokeWidth={active ? 2.3 : 1.9}
                    aria-hidden
                  />
                </span>
              )}
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="hidden border-t border-border bg-card md:block">
      <div className="container-app flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted-foreground">
        <div className="flex items-center gap-4">
          <BrandMark size={32} />
          <p className="max-w-xs">
            سوق محلي بأسعار يحددها البائعون — اشترِ وبِع من حساب واحد.
          </p>
        </div>
        <nav aria-label="روابط" className="flex gap-5">
          <Link href="/policies" className="hover:text-foreground">
            الشروط والسياسات
          </Link>
          <Link href="/settings" className="hover:text-foreground">
            الإعدادات
          </Link>
          <span>© {new Date().getFullYear()} DINAR AI</span>
        </nav>
      </div>
    </footer>
  );
}
