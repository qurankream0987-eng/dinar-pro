import "./_group.css";
import { useState, type FormEvent } from "react";
import {
  Bell,
  Bot,
  Check,
  ChevronDown,
  Compass,
  Heart,
  MapPin,
  Package,
  PlusCircle,
  ReceiptText,
  Search,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  UserRound,
} from "lucide-react";

const NAV = [
  { href: "/", label: "DINAR AI", icon: Bot },
  { href: "/discover", label: "استكشف", icon: Compass },
  { href: "/seller", label: "بيع", icon: PlusCircle },
  { href: "/orders", label: "طلباتي", icon: ReceiptText },
  { href: "/profile", label: "حسابي", icon: UserRound },
];

const CATEGORIES = ["الكل", "المنزل", "إلكترونيات", "أزياء", "خدمات"];
const ITEMS = [
  {
    title: "طاولة قهوة خشبية",
    seller: "متجر البيت · عمّان",
    price: "45",
    category: "المنزل",
    image: "/__mockup/images/dinar-table.jpg",
    alt: "طاولة قهوة من خشب الجوز في غرفة مضاءة",
    tag: "اختيار اليوم",
  },
  {
    title: "سماعات لاسلكية",
    seller: "تقنية وأكثر · إربد",
    price: "18",
    category: "إلكترونيات",
    image: "/__mockup/images/dinar-headphones.jpg",
    alt: "سماعات لاسلكية بلون فحمي",
    tag: "وصل حديثًا",
  },
  {
    title: "حقيبة جلد طبيعية",
    seller: "لمسة · عمّان",
    price: "32",
    category: "أزياء",
    image: "/__mockup/images/dinar-bag.jpg",
    alt: "حقيبة كتف جلدية بلون كونياك",
    tag: "حالة ممتازة",
  },
];

function Brand() {
  return (
    <a href="/" aria-label="بدينار — الرئيسية" className="group flex flex-col items-center gap-1 rounded-xl px-1 py-1">
      <img
        src="/__mockup/images/dinar-brand-mark.webp"
        alt="شعار بدينار"
        className="h-[76px] w-[76px] object-contain drop-shadow-[0_5px_12px_rgba(2,10,22,.3)]"
      />
      <span className="text-[11px] font-bold tracking-wide text-[#f2eee3]">بدينار</span>
    </a>
  );
}

function SidebarNavigation({
  mobile = false,
}: {
  mobile?: boolean;
}) {
  const browserPath = typeof window === "undefined" ? "/discover" : window.location.pathname;
  const currentPath = browserPath.startsWith("/__mockup") ? "/discover" : browserPath;
  return (
    <nav aria-label={mobile ? "التنقل السفلي" : "التنقل الرئيسي"} className={mobile ? "grid h-[68px] grid-cols-5" : "flex min-h-0 flex-1 flex-col gap-1"}>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active =
          href === "/discover"
            ? currentPath === "/discover" || currentPath.startsWith("/search")
            : href === "/"
              ? currentPath === "/" || currentPath === "/ai"
              : currentPath === href || currentPath.startsWith(`${href}/`);
        return (
          <a
            key={href}
            href={href}
            aria-label={label}
            title={label}
            aria-current={active ? "page" : undefined}
            style={mobile ? { color: active ? "#f0c66b" : "#9eacc0" } : undefined}
            className={
              mobile
                ? `flex flex-col items-center justify-center gap-1 text-[10px] font-semibold transition-colors ${active ? "text-[#f0c66b]" : "text-[#9eacc0]"}`
                : `group relative mx-auto flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-[15px] border transition-colors ${
                    active
                      ? "border-[#d8b453] bg-[#d8b453]/[.12] text-[#f2cb68] shadow-[inset_0_0_0_1px_rgba(216,180,83,.12)]"
                      : "border-transparent text-[#dfbd70] hover:border-[#d8b453]/40 hover:bg-[#d8b453]/[.07] hover:text-[#f7d780]"
                  }`
            }
          >
            {mobile ? (
              <span className={`flex h-8 w-12 items-center justify-center rounded-full ${active ? "bg-[#2b4160]" : ""}`}>
                <Icon size={20} strokeWidth={active ? 2.3 : 1.8} className={active ? "text-[#f0c66b]" : "text-[#9eacc0]"} />
              </span>
            ) : (
              <>
                <span className="pointer-events-none absolute end-full top-1/2 me-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-md border border-white/10 bg-[#263751] px-2.5 py-1.5 text-[11px] font-semibold text-[#f8f4e9] opacity-0 shadow-lg transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
                  {label}
                </span>
                <Icon
                  size={22}
                  strokeWidth={active ? 2.2 : 1.85}
                  className={active ? "text-[#f2cb68]" : "text-[#dfbd70] group-hover:text-[#f7d780]"}
                />
              </>
            )}
            {mobile && <span>{label}</span>}
          </a>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const [category, setCategory] = useState("الكل");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [cartCount, setCartCount] = useState(2);
  const [marketOpen, setMarketOpen] = useState(false);
  const [market, setMarket] = useState("سوق الأردن");
  const [search, setSearch] = useState("");
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const visibleItems = ITEMS.filter((item) => category === "الكل" || item.category === category);
  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.location.href = search.trim()
      ? `/search?q=${encodeURIComponent(search.trim())}`
      : "/search";
  };
  const toggleFavorite = (title: string) => {
    setFavorites((previous) =>
      previous.includes(title) ? previous.filter((item) => item !== title) : [...previous, title],
    );
  };

  return (
    <div className="dinar-shell-current dinar-shell-sidebar min-h-[100dvh] bg-[#f4f6f8] text-[#17263b]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2">
        تخطَّ إلى المحتوى
      </a>

      <aside
        aria-label="التنقل في بدينار"
        className="fixed inset-y-0 start-0 z-[50] hidden w-[112px] flex-col items-center border-e border-white/[.07] bg-[#101e34] px-2 pb-3 pt-3 shadow-[0_12px_42px_rgba(12,28,51,.16)] lg:flex"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 112 900"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <defs>
            <pattern id="dinar-rail-crackle" width="34" height="38" patternUnits="userSpaceOnUse">
              <path
                d="M2 1 9 8 6 15 15 20 13 29 22 36M9 8l11-4 5 9-10 7M15 20l10 4 8-5M6 15l-5 9 8 7"
                fill="none"
                stroke="#91a4bd"
                strokeOpacity=".2"
                strokeWidth=".65"
              />
            </pattern>
            <linearGradient id="dinar-rail-gold" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#8f6a2c" />
              <stop offset=".48" stopColor="#e2bf69" />
              <stop offset="1" stopColor="#9e7836" />
            </linearGradient>
          </defs>
          <rect width="112" height="900" fill="url(#dinar-rail-crackle)" opacity=".42" />
          <path
            d="M104-24C83 32 110 65 96 118S79 202 101 245s13 91-6 130-20 83 3 127 18 88-1 132-17 92 5 137 13 87-7 153"
            fill="none"
            stroke="#c29b4d"
            strokeOpacity=".16"
            strokeWidth="8"
          />
          <path
            d="M104-24C83 32 110 65 96 118S79 202 101 245s13 91-6 130-20 83 3 127 18 88-1 132-17 92 5 137 13 87-7 153"
            fill="none"
            stroke="url(#dinar-rail-gold)"
            strokeOpacity=".7"
            strokeWidth="1.5"
          />
          <path
            d="M99-12C86 31 105 70 91 119s-13 83 4 119"
            fill="none"
            stroke="#f1d88f"
            strokeOpacity=".42"
            strokeWidth=".65"
          />
        </svg>
        <div className="relative z-10 flex h-full w-full flex-col items-center">
          <Brand />

          <div className="relative mt-4">
            <button
              type="button"
              aria-label={`السوق الحالي: ${market}. تغيير السوق`}
              title={`السوق الحالي: ${market}`}
              aria-expanded={marketOpen}
              onClick={() => setMarketOpen((open) => !open)}
              className="group relative flex h-[44px] w-[52px] items-center justify-center rounded-xl border border-[#d6b458]/45 bg-[#d6b458]/[.08] transition-colors hover:border-[#e9c76c] hover:bg-[#d6b458]/[.14]"
            >
            <span aria-hidden className={`relative flex h-[19px] w-7 overflow-hidden rounded-[3px] border border-white/15 ${market === "سوق الإمارات" ? "flex-row" : "flex-col"}`}>
              {market === "سوق الإمارات" ? (
                <>
                  <span className="h-full w-1/3 bg-[#d94343]" />
                  <span className="flex flex-1 flex-col"><span className="h-1/3 bg-[#338b59]" /><span className="h-1/3 bg-[#f4f1e9]" /><span className="h-1/3 bg-[#222b38]" /></span>
                </>
              ) : (
                <>
                  <span className="h-1/3 bg-[#202a39]" />
                  <span className="h-1/3 bg-[#f4f1e9]" />
                  <span className="h-1/3 bg-[#26845a]" />
                  <span className="absolute inset-y-0 start-0 w-0 border-y-[9px] border-y-transparent border-s-[11px] border-s-[#b74345]" />
                </>
              )}
            </span>
            <ChevronDown size={12} className={`absolute bottom-1 end-1 text-[#e4c16e] transition-transform ${marketOpen ? "rotate-180" : ""}`} />
            </button>
            {marketOpen && (
              <div className="absolute end-[calc(100%+10px)] top-0 z-20 w-[172px] rounded-xl border border-[#344660] bg-[#192943] p-1.5 shadow-xl">
                {["سوق الأردن", "سوق فلسطين", "سوق الإمارات"].map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setMarket(name);
                      setMarketOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-[12px] text-[#d9e0e9] hover:bg-white/[.07]"
                  >
                    {name}
                    {market === name && <Check size={15} className="text-[#e6b64d]" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="my-4 h-px w-10 bg-white/10" />
          <SidebarNavigation />

          <div className="mt-auto flex w-full flex-col items-center gap-1.5 border-t border-white/[.09] pt-3">
            <a
              href="/settings"
              aria-label="الإعدادات"
              title="الإعدادات"
              className="group relative flex h-[44px] w-[50px] items-center justify-center rounded-[14px] border border-transparent text-[#dfbd70] transition-colors hover:border-[#d8b453]/40 hover:bg-[#d8b453]/[.07] hover:text-[#f7d780]"
            >
              <span className="pointer-events-none absolute end-full top-1/2 me-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-md border border-white/10 bg-[#263751] px-2.5 py-1.5 text-[11px] font-semibold text-[#f8f4e9] opacity-0 shadow-lg transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
                الإعدادات
              </span>
              <Settings size={20} strokeWidth={1.85} className="text-[#dfbd70] group-hover:text-[#f7d780]" />
            </a>
            <a
              href="/profile"
              aria-label="حساب سارة أحمد"
              title="حساب سارة أحمد"
              className="group relative mt-1 flex h-[48px] w-[50px] items-center justify-center rounded-[15px] border border-[#d6b458]/45 bg-[#d6b458]/[.08] text-[14px] font-bold text-[#f2ce7e] transition-colors hover:border-[#e9c76c] hover:bg-[#d6b458]/[.14]"
            >
              <span className="pointer-events-none absolute end-full top-1/2 me-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-md border border-white/10 bg-[#263751] px-2.5 py-1.5 text-[11px] font-semibold text-[#f8f4e9] opacity-0 shadow-lg transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
                سارة أحمد · حسابي
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[#e9cc81] bg-[#243858]">س</span>
            </a>
          </div>
        </div>
      </aside>

      <div className="min-h-[100dvh] lg:ms-[112px]">
        <header className="sticky top-0 z-40 border-b border-[#e5e9ee] bg-[#f8f9fa]/95 backdrop-blur-xl">
          <div className="mx-auto flex h-[68px] max-w-[1440px] items-center gap-3 px-4 sm:px-6 xl:px-9">
            <a href="/" aria-label="بدينار — الرئيسية" className="flex shrink-0 items-center gap-2 lg:hidden">
              <img src="/__mockup/images/dinar-brand-mark.webp" alt="" className="h-8 w-8 object-contain" />
              <span className="text-[15px] font-bold text-[#14243a]">بدينار</span>
            </a>
            <span className="hidden items-center gap-1.5 text-[12px] font-medium text-[#778397] sm:inline-flex">
              <MapPin size={14} className="text-[#b68c39]" />
              عمّان، الأردن
            </span>
            <form role="search" onSubmit={onSearch} className={`${mobileSearchOpen ? "flex" : "hidden"} relative min-w-0 flex-1 lg:flex lg:max-w-[410px]`}>
              <Search size={17} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-[#7e8a99]" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="ماذا تبحث عنه؟"
                aria-label="البحث في العروض"
                className="h-10 w-full rounded-full border border-[#e0e5eb] bg-[#eef1f4] ps-10 pe-4 text-[13px] text-[#23354b] outline-none transition focus:border-[#6b8ba9] focus:bg-white focus:ring-4 focus:ring-[#275985]/[.07]"
              />
            </form>
            <div className="ms-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={mobileSearchOpen ? "إغلاق البحث" : "فتح البحث"}
                onClick={() => setMobileSearchOpen((open) => !open)}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[#55657a] transition-colors hover:bg-[#e9edf1] lg:hidden"
              >
                <Search size={19} />
              </button>
              <div className="relative">
                <button
                  type="button"
                  aria-label="التنبيهات"
                  aria-expanded={noticeOpen}
                  onClick={() => setNoticeOpen((open) => !open)}
                  className="relative flex h-10 w-10 items-center justify-center rounded-full text-[#55657a] transition-colors hover:bg-[#e9edf1]"
                >
                  <Bell size={19} />
                  <span className="absolute end-[9px] top-[8px] h-[7px] w-[7px] rounded-full bg-[#d45e56] ring-2 ring-[#f8f9fa]" />
                </button>
                {noticeOpen && (
                  <div className="absolute end-0 top-12 z-30 w-[260px] rounded-2xl border border-[#e5e9ee] bg-white p-4 shadow-xl">
                    <p className="text-[13px] font-bold text-[#1a2b40]">التنبيهات</p>
                    <p className="mt-2 text-[12px] leading-6 text-[#6c7888]">لديك تحديث جديد حول طلبك الأخير.</p>
                    <a href="/notifications" className="mt-3 block text-[12px] font-bold text-[#174d7a]">عرض كل التنبيهات</a>
                  </div>
                )}
              </div>
              <a href="/cart" aria-label={`السلة، ${cartCount} وحدات`} className="relative flex h-10 w-10 items-center justify-center rounded-full text-[#55657a] transition-colors hover:bg-[#e9edf1]">
                <ShoppingCart size={20} />
                {cartCount > 0 && <span className="absolute end-0.5 top-0.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[#e5b54c] px-1 text-[10px] font-bold text-[#24344a]">{cartCount}</span>}
              </a>
              <a href="/profile" className="ms-1 hidden h-9 items-center gap-2 rounded-full border border-[#e1e6eb] bg-white py-1 pe-3 ps-1.5 text-[12px] font-semibold text-[#34465b] sm:flex lg:hidden">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#eaf0f5] text-[11px] text-[#174d7a]">س</span>
                سارة
              </a>
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-[1440px] px-4 pb-28 pt-7 sm:px-6 sm:pt-9 lg:px-9 lg:pb-12">
          <section className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[#98722d]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#d9ac4b]" />
                اكتشف ما يناسبك
              </div>
              <h1 className="text-[25px] font-bold tracking-[-.035em] text-[#15253a] sm:text-[30px]">عروض مميزة من السوق</h1>
              <p className="mt-1.5 text-[13px] text-[#758193]">أشياء تستحق فرصة ثانية — من بائعين قريبين منك.</p>
            </div>
            <a href="/search" className="hidden items-center gap-2 rounded-full border border-[#dfe5eb] bg-white px-4 py-2.5 text-[12px] font-semibold text-[#315675] transition hover:border-[#b6c8d7] sm:inline-flex">
              تصفح جميع العروض <span aria-hidden>←</span>
            </a>
          </section>

          <section className="relative mb-8 overflow-hidden rounded-[22px] bg-[#193657] px-5 py-5 text-white sm:px-7 sm:py-6">
            <div className="pointer-events-none absolute -end-10 -top-20 h-64 w-64 rounded-full border border-white/[.08]" />
            <div className="pointer-events-none absolute -end-2 -top-12 h-48 w-48 rounded-full border border-white/[.08]" />
            <div className="relative z-10 flex min-h-[126px] flex-col justify-center sm:max-w-[70%]">
              <span className="mb-3 flex w-fit items-center gap-1.5 rounded-full bg-white/[.11] px-2.5 py-1 text-[10px] font-semibold text-[#f0cf83]">
                <Sparkles size={12} /> السوق يتحرك
              </span>
              <h2 className="text-[20px] font-bold leading-snug tracking-[-.02em] sm:text-[24px]">كل قطعة لها حكاية جديدة.</h2>
              <p className="mt-1.5 max-w-[420px] text-[12px] leading-6 text-[#c2d0de] sm:text-[13px]">اكتشف اختيارات الناس في الأردن، واشترِ بسعر وحدة واحد واضح.</p>
              <a href="/search" className="mt-3 w-fit text-[12px] font-bold text-[#f0cb76] underline decoration-[#f0cb76]/50 underline-offset-4">ابدأ الاستكشاف</a>
            </div>
            <div className="absolute bottom-0 end-4 hidden h-[136px] w-[31%] items-end justify-center sm:flex">
              <div className="relative flex h-[112px] w-[112px] items-center justify-center rounded-t-full bg-[#e6bc66]/15">
                <div className="absolute bottom-0 h-[85px] w-[68px] rounded-t-[30px] border border-[#edcc83]/60 bg-gradient-to-b from-[#d7b765] to-[#947441] shadow-[0_12px_30px_rgba(5,17,31,.2)]" />
                <div className="absolute bottom-[78px] h-3 w-[74px] rounded-full bg-[#e6c777]" />
                <span className="absolute bottom-[31px] text-[20px] font-bold text-[#f7e8be]">د</span>
              </div>
            </div>
          </section>

          <section aria-label="عروض السوق">
            <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {CATEGORIES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={category === item}
                    onClick={() => setCategory(item)}
                    className={`shrink-0 rounded-full px-4 py-2 text-[12px] font-semibold transition-colors ${
                      category === item
                        ? "bg-[#183d61] text-white"
                        : "border border-[#e1e6eb] bg-white text-[#637185] hover:border-[#b9c8d5] hover:text-[#244c6d]"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setCategory("الكل")} className="hidden items-center gap-2 text-[12px] font-semibold text-[#6e7c8e] md:flex">
                <SlidersHorizontal size={15} /> ترتيب وتصفية
              </button>
            </div>

            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[15px] font-bold text-[#24364b]">مختارة لك</h2>
              <span className="text-[11px] text-[#8490a0]">{visibleItems.length} عروض</span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visibleItems.map((item) => {
                const liked = favorites.includes(item.title);
                return (
                  <article key={item.title} className="group overflow-hidden rounded-[17px] border border-[#e4e8ed] bg-white transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(26,48,74,.09)]">
                    <div className="relative h-[196px] overflow-hidden bg-[#e8e8e4] sm:h-[182px]">
                      <img src={item.image} alt={item.alt} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.035]" />
                      <span className="absolute start-3 top-3 rounded-full border border-white/55 bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-[#33475e] backdrop-blur">{item.tag}</span>
                      <button
                        type="button"
                        aria-label={liked ? "إزالة من المفضلة" : "إضافة للمفضلة"}
                        aria-pressed={liked}
                        onClick={() => toggleFavorite(item.title)}
                        className={`absolute end-3 top-3 flex h-8 w-8 items-center justify-center rounded-full shadow-sm backdrop-blur transition-colors ${liked ? "bg-[#fff0ee] text-[#c65750]" : "bg-white/90 text-[#526274] hover:text-[#c65750]"}`}
                      >
                        <Heart size={16} fill={liked ? "currentColor" : "none"} />
                      </button>
                    </div>
                    <div className="p-4">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <h3 className="text-[14px] font-bold text-[#1e3045]">{item.title}</h3>
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-[#8490a0]"><MapPin size={11} /> قريب منك</span>
                      </div>
                      <p className="text-[11px] text-[#8290a0]">{item.seller}</p>
                      <div className="mt-4 flex items-center justify-between border-t border-[#edf0f3] pt-3">
                        <span className="text-[16px] font-bold text-[#183e61]"><span className="num">{item.price}</span> <small className="text-[10px] font-semibold text-[#798697]">وحدة</small></span>
                        <button
                          type="button"
                          onClick={() => setCartCount((count) => count + 1)}
                          className="rounded-full bg-[#edf3f7] px-3.5 py-2 text-[11px] font-bold text-[#285475] transition-colors hover:bg-[#dbe8f0]"
                        >
                          أضف للسلة
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
              {visibleItems.length === 0 && (
                <div className="col-span-full rounded-2xl border border-dashed border-[#d9e0e7] bg-white/70 px-6 py-12 text-center">
                  <Package size={26} className="mx-auto text-[#93a0ae]" />
                  <p className="mt-3 text-[13px] font-semibold text-[#536277]">لا توجد عروض في هذا القسم بعد</p>
                  <button type="button" onClick={() => setCategory("الكل")} className="mt-3 text-[12px] font-bold text-[#285475]">استكشف كل العروض</button>
                </div>
              )}
            </div>
          </section>

          <footer className="mt-10 hidden items-center justify-between border-t border-[#e4e8ed] py-5 text-[11px] text-[#8994a2] md:flex">
            <span>سوق محلي بسعر وحدة واحد يحدده السوق — اشترِ وبِع من حساب واحد.</span>
            <div className="flex items-center gap-5">
              <a href="/terms" className="hover:text-[#345976]">الشروط والخصوصية</a>
              <a href="/settings" className="hover:text-[#345976]">الإعدادات</a>
              <span>© 2025 BDINAR</span>
            </div>
          </footer>
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-[60] border-t border-white/[.09] bg-[#101e34]/[.98] shadow-[0_-8px_24px_rgba(15,30,50,.12)] backdrop-blur-xl lg:hidden">
        <SidebarNavigation mobile />
      </div>
    </div>
  );
}