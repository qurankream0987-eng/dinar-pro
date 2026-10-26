import "./_group.css";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Bell, Bot, Compass, Heart, Package, PanelRightOpen, PlusCircle, ReceiptText, Search, ShoppingCart, UserRound } from "lucide-react";

type Icon = typeof Bot;
const NAV: { href: string; label: string; icon: Icon; active?: boolean }[] = [
  { href: "/", label: "DINAR AI", icon: Bot },
  { href: "/discover", label: "استكشف", icon: Compass, active: true },
  { href: "/seller", label: "بيع", icon: PlusCircle },
  { href: "/orders", label: "طلباتي", icon: ReceiptText },
  { href: "/profile", label: "حسابي", icon: UserRound },
];

// Static equivalents of the production hooks and Wouter state for this reference.
const useAccount = () => ({ user: { displayName: "سارة أحمد", avatarObjectPath: null, id: "demo-user" } });
const useCart = () => ({ unitCount: 2 });
const useGetOrders = () => ({ data: [{ status: "awaiting_payment" }] });
const useLocation = () => ["/discover", () => undefined] as const;

function Link({ href, children, className = "", ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a href={href} className={className} {...props}>{children}</a>;
}
function IconButton({ children, label }: { children: ReactNode; label: string }) {
  return <button type="button" aria-label={label} className="pressable relative flex h-10 w-10 items-center justify-center rounded-full hover:bg-muted">{children}</button>;
}
function Logo() {
  return <img src="/__mockup/images/dinar-brand-mark.webp" alt="بدينار" className="h-[34px] w-[34px] object-contain" />;
}
function TopBar() {
  const [location] = useLocation();
  const { user } = useAccount();
  const { unitCount } = useCart();
  useGetOrders();
  return <header className="sticky top-0 z-[var(--z-header)] border-b border-border/70 bg-background/90 backdrop-blur-xl">
    <div className="container-app flex h-[var(--topbar-h)] items-center gap-2 md:gap-4">
      <IconButton label="عرض المحادثات"><PanelRightOpen size={20} /></IconButton>
      <Link href="/" aria-label="بدينار — الرئيسية" className="shrink-0 rounded-md"><Logo /></Link>
      <span className="ms-1 hidden items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-sm font-bold text-accent-ink sm:inline-flex"><span className="h-2 w-2 rounded-full bg-accent" />سوق الأردن</span>
      <nav aria-label="التنقل الرئيسي" className="ms-4 hidden items-center gap-1 md:flex">
        {NAV.slice(0, 4).map(n => <Link key={n.href} href={n.href} aria-current={n.active ? "page" : undefined} className={`rounded-full px-3.5 py-2 text-base font-semibold transition-colors ${n.active ? "bg-primary-soft text-primary-soft-foreground" : "text-text-secondary hover:bg-muted"}`}>{n.label}</Link>)}
      </nav>
      <div className="ms-auto flex items-center gap-0.5 md:gap-1">
        <Link href="/" aria-label="DINAR AI" className="pressable me-1 hidden h-10 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm font-bold text-text-secondary hover:border-primary/40 hover:text-primary sm:inline-flex"><Bot size={17} />DINAR AI</Link>
        <form role="search" className="relative hidden w-full max-w-[300px] lg:block"><Search size={18} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><input type="search" placeholder="ماذا تبحث عنه؟" aria-label="البحث في العروض" className="h-11 w-full rounded-full border border-border bg-muted/70 ps-11 pe-4 text-base outline-none focus:border-primary focus:bg-card" /></form>
        <IconButton label="التنبيهات"><Bell size={21} /><span className="absolute end-[9px] top-[8px] h-2 w-2 rounded-full bg-destructive ring-2 ring-background" /></IconButton>
        <Link href="/cart" aria-label={`السلة، ${unitCount} وحدة`} className="pressable relative flex h-10 w-10 items-center justify-center rounded-full hover:bg-muted"><ShoppingCart size={22} /><span className="num absolute end-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground ring-2 ring-background">{unitCount}</span></Link>
        <Link href="/profile" className="pressable ms-2 hidden items-center gap-2 rounded-full border border-border bg-card py-1 pe-3 ps-1 text-sm font-semibold hover:border-border-strong md:flex"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-primary">س</span><span>{user.displayName}</span></Link>
      </div>
    </div>
  </header>;
}
function BottomNav() {
  return <nav aria-label="التنقل السفلي" className="fixed inset-x-0 bottom-0 z-[var(--z-nav)] border-t border-border bg-card/95 backdrop-blur-xl md:hidden"><div className="mx-auto grid h-[var(--bottomnav-h)] max-w-lg grid-cols-5">{NAV.map(({ href, label, icon: I, active }) => <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`pressable flex flex-col items-center justify-center gap-1 text-[11px] font-semibold ${active ? "text-primary" : "text-muted-foreground"}`}><span className={`flex h-8 w-14 items-center justify-center rounded-full ${active ? "bg-primary-soft" : ""}`}><I size={21} strokeWidth={active ? 2.3 : 1.9} /></span>{label}</Link>)}</div></nav>;
}
function Footer() {
  return <footer className="hidden border-t border-border bg-card md:block"><div className="container-app flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted-foreground"><div className="flex items-center gap-4"><Logo /><p className="max-w-xs">سوق محلي بسعر وحدة واحد يحدده السوق — اشترِ وبِع من حساب واحد.</p></div><nav aria-label="روابط" className="flex gap-5"><Link href="/terms">الشروط والخصوصية</Link><Link href="/settings">الإعدادات</Link><span>© 2025 BDINAR</span></nav></div></footer>;
}
function DiscoverPreview() {
  const cards = [{ title: "طاولة قهوة خشبية", seller: "متجر البيت", price: "45", color: "bg-[#d9c2a4]" }, { title: "سماعات لاسلكية", seller: "تقنية وأكثر", price: "18", color: "bg-[#b7c9d9]" }, { title: "حقيبة جلد طبيعية", seller: "لمسة", price: "32", color: "bg-[#c6b0a2]" }];
  return <section className="container-app py-8 md:py-12"><div className="mb-7 flex items-end justify-between"><div><p className="mb-2 text-sm font-semibold text-primary">اكتشف ما يناسبك</p><h1 className="text-2xl font-bold md:text-3xl">عروض مميزة من السوق</h1></div><button className="rounded-full border border-border px-4 py-2 text-sm font-semibold text-primary">عرض الكل</button></div><div className="mb-7 flex gap-2 overflow-hidden"><button className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">الكل</button>{["المنزل", "إلكترونيات", "أزياء", "خدمات"].map(x => <button key={x} className="whitespace-nowrap rounded-full border border-border bg-card px-4 py-2 text-sm text-text-secondary">{x}</button>)}</div><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(card => <article key={card.title} className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]"><div className={`relative flex h-36 items-center justify-center ${card.color}`}><Package size={52} className="text-white/80" /><button aria-label="إضافة للمفضلة" className="absolute start-3 top-3 rounded-full bg-white/85 p-2 text-slate-700"><Heart size={17} /></button></div><div className="p-4"><p className="mb-1 text-lg font-bold">{card.title}</p><p className="mb-4 text-sm text-muted-foreground">{card.seller}</p><div className="flex items-center justify-between"><span className="num text-xl font-bold text-primary">{card.price} <small className="text-sm font-medium">وحدة</small></span><button className="rounded-full bg-primary-soft px-3 py-1.5 text-sm font-semibold text-primary">أضف للسلة</button></div></div></article>)}</div></section>;
}
export function Current() {
  return <div className="dinar-shell-current min-h-screen bg-background"><a href="#main" className="sr-only">تخطَّ إلى المحتوى</a><TopBar /><main id="main" className="min-h-[calc(100dvh-var(--topbar-h))] pb-[calc(var(--bottomnav-h)+24px)] md:pb-16"><div className="animate-fade"><DiscoverPreview /></div></main><BottomNav /><Footer /></div>;
}