import { UniversalCards } from "./UniversalCards";
import { PolicyReviewPanel, isPolicyReview } from "./PolicyReviewPanel";
import { normalizeMemory } from "./memory-types";
import { normalizeInquiry } from "./inquiry-types";
import { ControlSurface, normalizeControl } from "./ControlSurface";
import { conversationSurfaceSize } from "@workspace/api-zod/conversation-runtime";
import { TutorialVideoCard } from "./TutorialVideoCard";
import { conversationActionMessage } from "@workspace/api-zod/conversation-runtime";
import { privateTranscript } from "./transcript-privacy";
import { Router, Route, Switch, Redirect } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthPage } from "@/pages/Auth";
import {
  Component,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUpDown, CalendarDays, Check, ChevronLeft, ChevronRight, Copy, Image as ImageIcon, LayoutGrid, MapPin, Pencil, Search, ShoppingCart, SlidersHorizontal, Tag } from "lucide-react";
import {
  useGetMarketplaceCategories,
  useGetOrderContact,
  getGetOrderContactQueryKey,
  type Listing,
} from "@workspace/api-client-react";
import { isMarketAvailable, useAccount } from "@/account/Account";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { Button, buttonClass } from "@/ui/Button";
import { Skeleton } from "@/ui/Feedback";
import { OfferCard } from "@/features/OfferCard";
import { DinarMark } from "@/ui/DinarMark";
import { Flag, SmartImage } from "@/ui/Media";
import type { AiMessage, AiUiBlock } from "./ai-api";
import { animateListingToBasket } from "./cart-basket-animation";
import { ListingManagementPreviewCard } from "./ListingManagementPreviewCard";
import { ListingTable } from "./surface/ListingTable";
import { ComposedSurfaceView } from "./surface/ComposedSurface";
import { DraftReviewPanel, draftPhotos, isDraftReview, isSellerInsight, SellerInsightPanel } from "./SellerDraftInsight";
import { BusinessSummaryPanel, isBusinessInsight } from "./BusinessSummaryPanel";
import { RichText } from "./RichText";
import { textDirection } from "./rich-text";
import { SellerDraftHelper } from "./SellerDraftHelper";
import { ComparisonPanel, isComparison, isPurchaseReview, PurchaseReviewPanel } from "./BuyerPanels";
import { isDriverPayload } from "./driver-types";
import { isProviderPayload } from "./provider-types";
import { AdvicePanel, ClarificationOptions, NegotiationPanel, adviceChipLabel, isAdvice, isNegotiation } from "./SmartSurfaces";
import { CardEnvelopeProvider } from "./surface/ComposedSurface";
import type { LocationSubmission } from "./delivery-types";

class BlockBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("DINAR conversation surface unavailable");
  }
  render() {
    return this.state.failed ? (
      <p role="alert" className="my-3 rounded-xl bg-muted p-4 text-sm">
        تعذر عرض هذه البطاقة. يمكنك متابعة المحادثة أو إعادة تحميلها.
      </p>
    ) : (
      this.props.children
    );
  }
}
// DINAR NEXT E6: surfaces that only some conversations reach load on first use.
const EmploymentSurface = lazy(() => import("./EmploymentSurface").then((m) => ({ default: m.EmploymentSurface })));
const DeliverySurface = lazy(() => import("./DeliverySurface").then((m) => ({ default: m.DeliverySurface })));
const OrderTrackingSurface = lazy(() => import("./OrderTrackingSurface"));
const PromotionSurface = lazy(() => import("./PromotionSurface").then((m) => ({ default: m.PromotionSurface })));
// Business and account cards render only when their payload arrives, so they load on demand.
const CommercialSurface = lazy(() => import("./CommercialSurface").then((m) => ({ default: m.CommercialSurface })));
const InquirySurface = lazy(() => import("./InquirySurface").then((m) => ({ default: m.InquirySurface })));
const MemorySummary = lazy(() => import("./MemorySummary").then((m) => ({ default: m.MemorySummary })));
const DriverPanel = lazy(() => import("./DriverPanel").then((m) => ({ default: m.DriverPanel })));
const ProviderPanel = lazy(() => import("./ProviderPanel").then((m) => ({ default: m.ProviderPanel })));
const BusinessSurface = lazy(() => import("./BusinessSurface").then((m) => ({ default: m.BusinessSurface })));
function SurfaceLoading() {
  return (
    <div className="mt-3 max-w-xl" aria-busy="true" aria-label="جارٍ التحميل">
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}
const ListingSurface = lazy(() => import("@/pages/OfferDetails"));
const CartSurface = lazy(() => import("@/pages/Cart"));
const OrdersSurface = lazy(() => import("@/pages/Orders"));
const SellerListingsSurface = lazy(
  () => import("@/features/ai/SellerListingsSurface"),
);
const EditOfferSurface = lazy(() => import("@/pages/seller/EditOffer"));
const DuesSurface = lazy(() => import("@/pages/seller/Dues"));
const AccountSurface = lazy(() =>
  import("@/pages/Account").then((m) => ({ default: m.ProfilePage })),
);
import { useCart } from "@/cart/CartContext";
import { offerDirectPurchase, offerRepresentation, placeOf, stockOf } from "@/lib/marketplace";
import { MarketChip } from "@/features/MarketSelector";
import { ActionReceiptList } from "./ActionReceipts";

const CheckoutSurface = lazy(() => import("@/pages/Checkout"));
const PoliciesSurface = lazy(() =>
  import("@/pages/Policies").then((m) => ({ default: m.PoliciesIndexPage })),
);
const PolicySurface = lazy(() =>
  import("@/pages/Policies").then((m) => ({ default: m.PolicyPage })),
);
const OrderSurface = lazy(() => import("@/pages/OrderDetails"));
const OrderInlineSurface = lazy(() =>
  import("@/pages/OrderDetails").then((module) => ({
    default: module.OrderInlineSurface,
  })),
);
const OrderHistorySurface = lazy(() => import("@/pages/Orders"));
const SettingsSurface = lazy(() =>
  import("@/pages/Account").then((m) => ({ default: m.SettingsPage })),
);
const SURFACES: Record<string, string> = {
  LISTING: "/listings",
  CART: "/cart",
  CHECKOUT: "/checkout",
  ORDERS: "/orders",
  ORDER: "/orders",
  ORDERS_LIST: "/orders",
  ORDER_SELECTOR: "/orders",
  ORDER_STATUS: "/orders",
  ORDER_TRACKING: "/orders",
  SELL: "/ai?sell=1",
  MY_LISTINGS: "/seller/listings",
  DUES: "/seller/dues",
  ACCOUNT: "/profile",
  AUTH: "/login",
  SETTINGS: "/settings",
  POLICIES: "/policies",
};
const EMPTY_PHOTO_SUGGESTIONS: NonNullable<
  AiUiBlock["payload"]["photoSuggestions"]
> = [];

function SellerContactReleaseCard({ orderId }: { orderId: string }) {
  const order = useGetOrderContact(orderId, {
    query: {
      queryKey: getGetOrderContactQueryKey(orderId),
      enabled: Boolean(orderId),
      staleTime: 0,
      refetchOnMount: "always",
    },
  });
  if (order.isLoading || order.isFetching)
    return <p className="mt-3 text-sm text-muted-foreground" role="status">جارٍ التحقق من صلاحية بيانات التواصل…</p>;
  const contacts = order.data?.contacts ?? [];
  if (order.isError || !contacts.length)
    return <p className="mt-3 text-sm text-muted-foreground" role="status">لم تعد بيانات التواصل متاحة لهذا الطلب.</p>;
  return (
    <section className="mt-3 rounded-xl border border-border bg-card p-4" aria-label="بيانات تواصل البائع">
      <h3 className="font-semibold">بيانات التواصل المعتمدة لهذا الطلب</h3>
      {contacts.map((contact, index) => (
        <p key={`${contact.phone}-${index}`} className="mt-2 text-sm">
          {contact.listingTitle && <span>{contact.listingTitle}: </span>}
          <a className="font-semibold underline" href={`tel:${contact.phone}`}>{contact.phone}</a>
        </p>
      ))}
    </section>
  );
}

/** Existing workflows share domain providers, but navigation stays in this conversation card. */
function Workflow({
  surface,
  resourceIds,
  resourceId,
  selectedListingId,
  draftStep,
  onSend,
  onBack,
}: {
  surface: string;
  resourceIds?: string[];
  resourceId?: string;
  selectedListingId?: string;
  draftStep?: string;
  onSend?: (message: string) => void;
  onBack?: () => void;
}) {
  const { user } = useAccount();
  const { refreshFromServer } = useCart();
  const selectedOrderId =
    resourceId ??
    (surface === "ORDER_STATUS" && resourceIds?.length === 1
      ? resourceIds[0]
      : undefined);
  const [router] = useState(() =>
    memoryLocation({
      path:
        selectedOrderId &&
        (surface === "ORDER" ||
          surface === "ORDER_STATUS" ||
          surface === "LISTING")
          ? `${SURFACES[surface]}/${encodeURIComponent(selectedOrderId)}`
          : (SURFACES[surface] ?? "/"),
    }),
  );
  useEffect(() => {
    if (surface === "CART" && user) void refreshFromServer();
  }, [surface, user?.id, refreshFromServer]);
  if (surface === "ORDER_TRACKING" && resourceId)
    return (
      <Suspense fallback={<SurfaceLoading />}>
        <OrderTrackingSurface
          orderId={resourceId}
        />
      </Suspense>
    );
  if (surface === "ORDER_STATUS" && selectedOrderId)
    return (
      <div className="ai-workflow mt-3 rounded-xl border border-border bg-background">
        <OrderInlineSurface orderId={selectedOrderId} />
      </div>
    );
  if (
    surface === "ORDERS_LIST" ||
    surface === "ORDER_SELECTOR" ||
    surface === "ORDER_STATUS"
  )
    return (
      <div className="ai-workflow mt-3 rounded-xl border border-border bg-background">
        <Router hook={router.hook} searchHook={router.searchHook}>
          <Route path="/orders">
            <OrderHistorySurface
              resourceIds={resourceIds ?? (resourceId ? [resourceId] : [])}
              conversational
            />
          </Route>
          <Route path="/orders/:id" component={OrderSurface} />
        </Router>
      </div>
    );
  if (surface === "CLARIFY") return null;
  if (surface === "MARKET")
    return (
      <div className="p-4">
        <MarketChip />
      </div>
    );
  if (surface === "LOGOUT") return <LogoutAction />;
  if (surface === "SELL" && !user)
    return (
      <p className="p-4">
        سجّل الدخول لمتابعة مسودة الإعلان.
      </p>
    );
  if (surface === "SELL")
    return (
      <SellerDraftHelper
        draftStep={draftStep}
        active
        onSend={onSend}
      />
    );
  if (!SURFACES[surface])
    return (
      <p className="p-4">
        هذه الخدمة غير متاحة حاليًا. يمكنك متابعة البحث هنا.
      </p>
    );
  return (
    <div className="ai-workflow mt-3 rounded-xl border border-border bg-background">
      <Router hook={router.hook} searchHook={router.searchHook}>
        <Suspense fallback={
          <div className="space-y-3 p-4" aria-busy="true" aria-label="جارٍ التحميل">
            <Skeleton className="h-7 w-1/3" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-11 w-2/3" />
          </div>
        }>
          <Switch>
            <Route path="/listings/:id">
              <ListingSurface onBack={onBack} onSend={onSend} />
            </Route>
            <Route path="/terms" component={PoliciesSurface} />
            <Route path="/policies" component={PoliciesSurface} />
            <Route path="/policies/:key" component={PolicySurface} />
            <Route>
              {!user ? (
                <>
                  <p className="p-4">
                    سجّل الدخول للوصول إلى بياناتك ومتابعة هذا الإجراء.
                  </p>
                  <Switch>
                    <Route path="/register">
                      <AuthPage register embedded />
                    </Route>
                    <Route>
                      <AuthPage embedded />
                    </Route>
                  </Switch>
                </>
              ) : (
                <Switch>
                  <Route path="/cart" component={CartSurface} />
                  <Route path="/checkout" component={CheckoutSurface} />
                  <Route path="/orders/:id" component={OrderSurface} />
                  <Route path="/orders">
                    <OrdersSurface resourceIds={resourceIds} conversational />
                  </Route>
                  <Route
                    path="/seller/listings"
                  >
                    <SellerListingsSurface
                      selectedListingId={selectedListingId}
                      onSend={onSend}
                    />
                  </Route>
                  <Route path="/seller/offers"><Redirect to="/seller/listings" /></Route>
                  <Route
                    path="/seller/offers/:id/edit"
                    component={EditOfferSurface}
                  />
                  <Route path="/seller/dues" component={DuesSurface} />
                  <Route path="/listings/:id">
                    <ListingSurface onBack={onBack} onSend={onSend} />
                  </Route>
                  <Route path="/settings" component={SettingsSurface} />
                  <Route path="/profile" component={AccountSurface} />
                  <Route>
                    <p className="p-4">يمكنك متابعة طلبك في المحادثة.</p>
                  </Route>
                </Switch>
              )}
            </Route>
          </Switch>
        </Suspense>
      </Router>
    </div>
  );
}

function LogoutAction() {
  const { user, logout } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!user)
    return (
      <p className="mt-3 rounded-xl border border-border p-4 text-sm">
        أنت غير مسجل الدخول حاليًا.
      </p>
    );
  return (
    <div className="mt-3 rounded-xl border border-border bg-background p-4">
      <p className="text-sm">هل تريد تسجيل الخروج من حساب DINAR؟</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await logout();
          } catch (cause) {
            setError(friendlyError(cause));
            setBusy(false);
          }
        }}
      >
        {busy ? "جارٍ تسجيل الخروج…" : "تسجيل الخروج"}
      </Button>
    </div>
  );
}

/** The structured card shows the rows; the text keeps its lead and notes, not the rows. */
/** A product-control card carries the whole answer; repeating it as text would duplicate it. */
function controlOnly(blocks: AiUiBlock[] | undefined): boolean {
  return Boolean(blocks?.length && blocks.every((block) => block.type === "SURFACE" && normalizeControl(block.payload.control)));
}

function hasDetailCard(blocks: AiUiBlock[] | undefined): boolean {
  return Boolean(
    blocks?.some((block) => {
      const insight = block.payload?.sellerInsight as { kind?: unknown } | undefined;
      return isBusinessInsight(insight) || insight?.kind === "LISTING_FACTORS";
    }),
  );
}

const CARD_ROW = /^\s*(?:•|\d{1,2}\.\s+«)/u;
function AssistantBody({ body, withoutRows }: { body: string; withoutRows: boolean }) {
  const text = privateTranscript(body);
  return <RichText body={withoutRows ? text.split("\n").filter((line) => !CARD_ROW.test(line)).join("\n") : text} />;
}

function MessageBody({ body }: { body: string }) {
  const text = privateTranscript(body);
  const lines = text.split("\n");
  return (
    <div dir={textDirection(text) ?? "rtl"} className="ai-message-text">
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>
          {line}
          {index < lines.length - 1 && <br />}
        </span>
      ))}
    </div>
  );
}

const SEARCH_FIELD_LABELS: Record<string, string> = {
  title: "اسم العرض",
  name: "اسم العرض",
  description: "الوصف",
  category: "التصنيف",
  categoryid: "التصنيف",
  price: "السعر",
  unitprice: "السعر",
  city: "المدينة",
  area: "المنطقة",
  location: "الموقع",
  brand: "العلامة التجارية",
  condition: "الحالة",
  fulfilmenttype: "طريقة الاستلام",
  fulfillmenttype: "طريقة الاستلام",
  stock: "التوفر",
  quantity: "الكمية",
};

function readableFieldLabel(field: string) {
  const normalized = field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return SEARCH_FIELD_LABELS[normalized.replace(/\s/g, "")] ?? "مواصفة العرض";
}

/** The swipeable result row; arrows appear only when the row really overflows (RTL-aware). */
/**
 * Generative UI layouts for a verified result set. GRID and LIST rearrange the same typed cards;
 * the carousel stays the default. Nothing here changes what the cards say or what they can do.
 */
function ResultLayout({ resultSetId, layout, children }: { resultSetId: string; layout?: "GRID" | "CAROUSEL" | "LIST"; children: ReactNode }) {
  if (layout === "GRID" || layout === "LIST")
    return (
      <div
        dir="rtl"
        role="list"
        aria-label="نتائج العروض"
        data-testid={`ai-results-${layout.toLowerCase()}-${resultSetId}`}
        data-layout={layout}
        className={layout === "GRID" ? "ai-result-grid grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3" : "ai-result-list flex flex-col gap-3"}
      >
        {children}
      </div>
    );
  return <ResultCarousel resultSetId={resultSetId}>{children}</ResultCarousel>;
}

function ResultCarousel({ resultSetId, children }: { resultSetId: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ back: false, forward: false });
  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    // In RTL the row starts at scrollLeft 0 and moves into negative values.
    const travelled = Math.abs(row.scrollLeft);
    const room = row.scrollWidth - row.clientWidth;
    setEdges({ back: travelled > 4, forward: room - travelled > 4 });
  }, []);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [measure]);
  const step = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    const card = row.querySelector<HTMLElement>(".ai-result-item");
    const distance = (card?.offsetWidth ?? 260) + 12;
    row.scrollBy({ left: -direction * distance, behavior: "smooth" });
  };
  return (
    <div className="ai-result-carousel">
      <div
        ref={rowRef}
        dir="rtl"
        className="ai-result-row flex w-full snap-x snap-mandatory gap-3 overflow-x-auto pb-3 scrollbar-none"
        tabIndex={0}
        role="region"
        data-testid={`ai-results-carousel-${resultSetId}`}
        aria-label="اسحب لعرض النتائج"
        onScroll={measure}
      >
        {children}
      </div>
      {edges.back && (
        <button type="button" className="ai-carousel-arrow is-back" aria-label="النتائج السابقة" onClick={() => step(-1)}>
          <ChevronRight size={20} aria-hidden />
        </button>
      )}
      {edges.forward && (
        <button type="button" className="ai-carousel-arrow is-forward" aria-label="النتائج التالية" onClick={() => step(1)}>
          <ChevronLeft size={20} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function SearchRefinements({
  state,
  variant = "inline",
}: {
  state: NonNullable<AiUiBlock["payload"]["searchState"]>;
  /** "panel": one row per applied criterion, as in the context panel. */
  variant?: "inline" | "panel";
}) {
  const categories = useGetMarketplaceCategories();
  const category = categories.data?.find(
    (item) => item.id === state.categoryId,
  );
  const sortLabel =
    state.sort === "RELEVANCE"
      ? "الأقرب لطلبك"
      : category?.rules.sorting.options.find(
          (option) => option.id === state.sort,
        )?.label ??
        categories.data
          ?.flatMap((item) => item.rules.sorting.options)
          .find(
            (option) =>
              option.id === state.sort && option.field !== "ATTRIBUTE",
          )?.label ??
        "ترتيب مخصص";
  const operatorLabels = {
    eq: "يساوي",
    ne: "باستثناء",
    contains: "يتضمن",
    gt: "أكثر من",
    gte: "على الأقل",
    lt: "أقل من",
    lte: "بحد أقصى",
  } as const;
  const refinements = [
    ...(state.categoryId
      ? [`التصنيف: ${category?.label ?? "تصنيف محدد"}`]
      : []),
    ...state.filters.map(
      (filter) =>
        `${category?.attributes[filter.field]?.label ?? readableFieldLabel(filter.field)} ${operatorLabels[filter.operator]} ${filter.value}`,
    ),
    ...(state.sort ? [sortLabel] : []),
  ];
  if (!state.search.trim() && refinements.length === 0) return null;
  if (variant === "panel") {
    // Value first, as the buyer said it; the field name stays as a quiet hint and range
    // operators stay in the value so «بحد أقصى 500» is never read as «500».
    // The panel's title already carries the free-text query, so rows hold the criteria.
    const rows: { text: string; hint: string; icon: typeof Search }[] = [
      ...(state.categoryId ? [{ text: category?.label ?? "تصنيف محدد", hint: "التصنيف", icon: LayoutGrid }] : []),
      ...state.filters.map((filter) => ({
        text: filter.operator === "eq" || filter.operator === "contains" ? String(filter.value) : `${operatorLabels[filter.operator]} ${filter.value}`,
        hint: category?.attributes[filter.field]?.label ?? readableFieldLabel(filter.field),
        icon: /city|area|location/i.test(filter.field) ? MapPin : /year/i.test(filter.field) ? CalendarDays : /price/i.test(filter.field) ? Tag : SlidersHorizontal,
      })),
      ...(state.sort ? [{ text: sortLabel, hint: "الترتيب", icon: ArrowUpDown }] : []),
    ];
    return (
      <ul className="ai-context-criteria" aria-label="تفاصيل البحث المطبقة">
        {rows.map(({ text, hint, icon: Icon }, index) => (
          <li key={`${text}-${index}`}>
            <Icon size={17} aria-hidden />
            <span className="ai-context-criterion">{text}</span>
            <small>{hint}</small>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="ai-search-refinements" aria-label="تفاصيل البحث المطبقة">
      <div className="ai-search-refinements-heading">
        <SlidersHorizontal size={15} aria-hidden />
        <span>معايير البحث</span>
      </div>
      <div className="ai-search-chips">
        {state.search.trim() && (
          <span className="ai-search-chip">بحث: {state.search}</span>
        )}
        {refinements.map((refinement, index) => (
          <span className="ai-search-chip" key={`${refinement}-${index}`}>
            {refinement}
          </span>
        ))}
      </div>
    </div>
  );
}

function PhotoSuggestionPanel({
  block,
  active,
  onSend,
}: {
  block: AiUiBlock;
  active: boolean;
  onSend?: (message: string) => void;
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState("");
  const status = block.payload.photoSuggestionStatus;
  const suggestions =
    block.payload.photoSuggestions ?? EMPTY_PHOTO_SUGGESTIONS;
  const review = isDraftReview(block.payload.draftReview)
    ? block.payload.draftReview
    : undefined;
  useEffect(() => {
    setEditedValues(
      Object.fromEntries(
        suggestions.map((suggestion) => [
          suggestion.field,
          String(suggestion.value),
        ]),
      ),
    );
  }, [suggestions]);
  if (!status && suggestions.length === 0) return null;

  const fieldLabel = (field: string) => {
    if (field === "title") return "العنوان المقترح";
    if (field === "description") return "الوصف المقترح";
    if (field === "category") return "التصنيف المقترح";
    const reviewed = review?.fields.find(
      (item) =>
        item.field === field ||
        item.field === `attributes.${field}`,
    );
    return `خاصية «${reviewed?.label ?? readableFieldLabel(field)}»`;
  };
  const statusText = {
    UNAVAILABLE: "تحليل الصور غير متاح الآن. اكتب اسم المنتج وسأكمل إعداد الإعلان يدويًا.",
    FAILED: "تعذر تحليل الصور. يمكنك متابعة إعداد الإعلان يدويًا.",
    NO_SUGGESTIONS: "لم نعثر على تفاصيل مقترحة من الصور.",
    SUGGESTIONS: suggestions.length
      ? "راجع التفاصيل المستخرجة من الصور قبل استخدامها."
      : "لا توجد تفاصيل مقترحة من الصور في هذه المرة.",
  } as const;
  const statusTone =
    status === "FAILED"
      ? "is-warning"
      : status === "SUGGESTIONS" && suggestions.length
        ? "is-ready"
        : "is-muted";
  const uncertaintyLabels: Record<string, string> = {
    CATEGORY_UNCERTAIN: "التصنيف المقترح غير مؤكد.",
    MODEL_UNCERTAIN: "طراز المنتج غير واضح من الصور.",
    VISIBILITY_LIMITED: "الصور لا تُظهر كل التفاصيل.",
    CONDITION_NOT_VERIFIABLE: "لا يمكن تأكيد الحالة من الصور.",
    SERVICE_CREDENTIALS_NOT_VERIFIABLE: "الصور لا تثبت المؤهلات أو التراخيص المهنية.",
    PARTIAL_IMAGE_COVERAGE: "تعذر تحليل بعض الصور.",
    OTHER_DETAILS_NEED_SELLER: "أكمل التفاصيل التي لا تظهر بوضوح بنفسك.",
  };
  const uncertainties = block.payload.photoSuggestionUncertainties ?? [];

  return (
    <section className="ai-photo-suggestions" aria-label="مراجعة اقتراحات الصور">
      <div className="ai-photo-suggestions-title">
        <span className="ai-photo-icon"><ImageIcon size={17} aria-hidden /></span>
        <div>
          <h3>من صور الإعلان</h3>
          <p className={cn("ai-photo-status", statusTone)} role="status">
            {status ? statusText[status] : "اقتراحات اختيارية مستخرجة من الصور."}
          </p>
        </div>
      </div>
      {uncertainties.length > 0 && (
        <div
          className="ai-photo-uncertainties"
          role="status"
          aria-label="تنبيهات حول اقتراحات الصور"
        >
          {uncertainties.map((uncertainty) => (
            <p key={uncertainty}>
              {uncertaintyLabels[uncertainty] ?? "بعض التفاصيل غير مؤكدة."}
            </p>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <ul className="ai-photo-suggestion-list">
          {suggestions.map((suggestion, index) => {
            const value = String(suggestion.value);
            return (
              <li className="ai-photo-suggestion" key={`${suggestion.field}-${index}`}>
                <div className="ai-photo-thumbnail">
                  <SmartImage
                    src={suggestion.imageObjectPath}
                    alt={`الصورة المستخدمة لاقتراح ${readableFieldLabel(suggestion.field)}`}
                  />
                </div>
                <div className="ai-photo-suggestion-copy">
                  <span className="ai-photo-field">{readableFieldLabel(suggestion.field)}</span>
                  <strong dir="auto">{value}</strong>
                  <span className="ai-photo-confidence">
                    مستوى الثقة {Math.round(suggestion.confidence * 100)}٪
                  </span>
                  <span className="ai-photo-provenance">المصدر: صورة مرفقة بالإعلان</span>
                </div>
                <button
                  type="button"
                  className={buttonClass("secondary", "sm", false, "ai-photo-copy")}
                  aria-label={`نسخ ${readableFieldLabel(suggestion.field)}: ${value}`}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(value);
                      setCopiedIndex(index);
                      setCopyFailed(false);
                    } catch {
                      setCopiedIndex(null);
                      setCopyFailed(true);
                    }
                  }}
                >
                  {copiedIndex === index ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
                  <span>{copiedIndex === index ? "تم النسخ" : "نسخ القيمة"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {copyFailed && (
        <p role="status" className="ai-photo-copy-error">
          تعذر النسخ. يمكنك تحديد القيمة ونسخها يدويًا.
        </p>
      )}
      {suggestions.length > 0 && (
        <p className="ai-photo-safety-note">
          الصور قد تكشف ما يظهر فيها فقط. لا تثبت الحالة أو الأصالة أو الملكية أو السعر أو الترخيص. لن نضيف اقتراحًا إلى المسودة أو ننشره دون اختيارك.
        </p>
      )}
      {editing && suggestions.length > 0 && (
        <div className="ai-photo-edit-fields" dir="rtl">
          {suggestions.map((suggestion) => (
            <label
              className="ai-photo-edit-field"
              key={`edit-${suggestion.field}`}
            >
              <span>{fieldLabel(suggestion.field)}</span>
              {suggestion.field === "description" ? (
                <textarea
                  rows={3}
                  maxLength={500}
                  value={editedValues[suggestion.field] ?? ""}
                  onChange={(event) =>
                    {
                      setEditError("");
                      setEditedValues((values) => ({
                        ...values,
                        [suggestion.field]: event.target.value,
                      }));
                    }
                  }
                />
              ) : (
                <input
                  maxLength={suggestion.field === "title" ? 120 : 160}
                  value={editedValues[suggestion.field] ?? ""}
                  onChange={(event) =>
                    {
                      setEditError("");
                      setEditedValues((values) => ({
                        ...values,
                        [suggestion.field]: event.target.value,
                      }));
                    }
                  }
                />
              )}
            </label>
          ))}
        </div>
      )}
      {active && onSend && suggestions.length > 0 && (
        <div className="ai-photo-actions" dir="rtl">
          {editing ? (
            <>
              <button
                type="button"
                className={buttonClass("primary", "sm", false, "ai-photo-action")}
                onClick={() => {
                  const changed = suggestions.filter(
                    (suggestion) =>
                      String(suggestion.value) !==
                      (editedValues[suggestion.field] ?? ""),
                  );
                  if (!changed.length) {
                    setEditError("غيّر قيمة واحدة على الأقل قبل الحفظ.");
                    return;
                  }
                  const message = [
                    "تعديل اقتراحات الصور:",
                    ...changed.map(
                      (suggestion) =>
                        `${fieldLabel(suggestion.field)}: ${(editedValues[suggestion.field] ?? "").replace(/\r?\n/gu, " ").trim()}`,
                    ),
                  ].join("\n");
                  if (message.length > 1800) {
                    setEditError("اختصر التعديلات حتى يمكن حفظها.");
                    return;
                  }
                  onSend(message);
                  setEditing(false);
                  setEditError("");
                }}
              >
                <Check size={15} aria-hidden />
                حفظ التعديلات
              </button>
              <button
                type="button"
                className={buttonClass("secondary", "sm", false, "ai-photo-action")}
                onClick={() => setEditing(false)}
              >
                إلغاء
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={buttonClass("primary", "sm", false, "ai-photo-action")}
                onClick={() => onSend("أكد اقتراحات الصور")}
              >
                <Check size={15} aria-hidden />
                تأكيد الاقتراحات
              </button>
              <button
                type="button"
                className={buttonClass("secondary", "sm", false, "ai-photo-action")}
                onClick={() => setEditing(true)}
              >
                <Pencil size={15} aria-hidden />
                تعديل
              </button>
              <button
                type="button"
                className={buttonClass("secondary", "sm", false, "ai-photo-action")}
                onClick={() => onSend("تجاهل اقتراحات الصور")}
              >
                تجاهل
              </button>
            </>
          )}
        </div>
      )}
      {editError && (
        <p className="ai-photo-copy-error" role="alert">
          {editError}
        </p>
      )}
    </section>
  );
}

function ResultBlock({
  block,
  onSend,
  onSelectMarket,
  onAdd,
  addingListingId,
  activeWorkflow,
  activeResults,
}: {
  activeWorkflow?: boolean;
  activeResults?: boolean;
  addingListingId?: string;
  block: AiUiBlock;
  onAdd?: (listing: Listing, resultSetId: string) => Promise<boolean> | boolean;
  onSend?: (text: string, location?: LocationSubmission) => void;
  onSelectMarket?: (marketId: string, resumeMessageId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | undefined>(() =>
    block.type === "LISTING_RESULTS" && block.payload.presentation === "DETAILS"
      ? (block.payload.listings?.[0] as Listing | undefined)?.id
      : undefined,
  );
  const [marketSelectionBusy, setMarketSelectionBusy] = useState(false);
  const [marketSelectionError, setMarketSelectionError] = useState("");
  const { market, markets } = useAccount();
  const selectMarket = async (marketId: string, resumeMessageId: string) => {
    if (!onSelectMarket || marketSelectionBusy) return;
    setMarketSelectionBusy(true);
    setMarketSelectionError("");
    try {
      await onSelectMarket(marketId, resumeMessageId);
    } catch (error) {
      setMarketSelectionError(friendlyError(error));
    } finally {
      setMarketSelectionBusy(false);
    }
  };
  if (
    block.type === "SURFACE" &&
    block.payload.surface === "MARKET_SELECTOR"
  )
    return (
      <section
        aria-label="اختيار سوق متاح"
        className="mt-3 space-y-3 rounded-2xl border border-border bg-card p-4"
        data-testid="card-market-selector"
      >
        <p className="font-semibold text-foreground">
          سوق {market?.countryNameAr ?? "السوق الحالي"} غير متاح حاليًا.
        </p>
        <p className="text-sm text-muted-foreground">
          اختر سوقًا متاحًا للمتابعة. لا تحتاج إلى تسجيل الدخول لاختيار السوق أو تصفح العروض العامة.
        </p>
        <div className="space-y-2">
          {markets.filter(isMarketAvailable).map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={
                marketSelectionBusy ||
                !onSelectMarket ||
                !block.payload.resumeMessageId
              }
              onClick={() => {
                const resumeMessageId = block.payload.resumeMessageId;
                if (resumeMessageId)
                  void selectMarket(option.id, resumeMessageId);
              }}
              className="pressable flex w-full items-center gap-3 rounded-xl border border-border bg-background p-3 text-start hover:border-primary disabled:opacity-60"
              data-testid={`button-inline-market-${option.id}`}
            >
              <Flag code={option.countryCode} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-foreground">
                  {option.countryNameAr}
                </span>
                <span className="block text-xs text-muted-foreground">
                  متاح الآن · {option.currencyCode}
                </span>
              </span>
              <span className="text-sm font-semibold text-primary">متابعة</span>
            </button>
          ))}
          {markets.filter(isMarketAvailable).length === 0 && (
            <p role="status" className="rounded-lg bg-muted p-3 text-sm">
              لا يوجد سوق متاح للاختيار حاليًا.
            </p>
          )}
        </div>
        {marketSelectionError && (
          <p role="alert" className="text-sm text-destructive">
            {marketSelectionError}
          </p>
        )}
      </section>
    );
  if (
    block.type === "SURFACE" &&
    block.payload.surface === "SELL" &&
    block.payload.draftStep === "cancelled"
  )
    return (
      <p className="mt-3 rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        لا توجد مسودة نشطة لهذا الإعلان.
      </p>
    );
  if (
    block.type === "SURFACE" &&
    block.payload.surface === "SELL" &&
    !activeWorkflow
  )
    return (
      <>
        <PhotoSuggestionPanel block={block} active={false} />
        <p className="mt-3 text-xs text-muted-foreground">
          مسودة سابقة — تابع من أحدث بطاقة.
        </p>
      </>
    );
  if (block.type === "SURFACE" && block.payload.universalCards)
    return <UniversalCards payload={block.payload.universalCards} resultSetId={block.payload.resultSetId} />;
  if (block.type === "SURFACE" && block.payload.delivery)
    return (
      <Suspense fallback={<SurfaceLoading />}>
        <DeliverySurface
          delivery={block.payload.delivery}
          active={Boolean(activeWorkflow)}
          onSend={onSend}
        />
      </Suspense>
    );
  if (block.type === "SURFACE" && block.payload.promotion)
    return (
      <Suspense fallback={<SurfaceLoading />}>
        <PromotionSurface
          promotion={block.payload.promotion}
          active={Boolean(activeWorkflow)}
          onSend={onSend}
        />
      </Suspense>
    );
  if (block.type === "SURFACE" && isDriverPayload(block.payload.driver))
    return <Suspense fallback={<SurfaceLoading />}><DriverPanel driver={block.payload.driver} active={Boolean(activeWorkflow)} activeMarketId={market?.id} onSend={onSend} /></Suspense>;
  if (block.type === "SURFACE" && isProviderPayload(block.payload.provider))
    return <Suspense fallback={<SurfaceLoading />}><ProviderPanel provider={block.payload.provider} active={Boolean(activeWorkflow)} onSend={onSend} /></Suspense>;
  if (block.type === "SURFACE" && block.payload.control) {
    const control = normalizeControl(block.payload.control);
    return control ? <ControlSurface control={control} resultSetId={String(block.payload.resultSetId ?? "")} active={Boolean(activeWorkflow)} onSend={onSend} /> : null;
  }
  if (block.type === "SURFACE" && block.payload.inquiry) {
    const inquiry = normalizeInquiry(block.payload.inquiry);
    return inquiry ? <Suspense fallback={<SurfaceLoading />}><InquirySurface inquiry={inquiry} active={Boolean(activeWorkflow)} onSend={onSend} /></Suspense> : null;
  }
  if (block.type === "SURFACE" && isNegotiation(block.payload.negotiation))
    return <NegotiationPanel negotiation={block.payload.negotiation} active={Boolean(activeWorkflow)} onSend={onSend} />;
  if (
    block.type === "SURFACE" &&
    block.payload.surface === "TUTORIAL_VIDEO_CARD" &&
    block.payload.tutorial
  )
    return (
      <TutorialVideoCard
        tutorial={block.payload.tutorial}
        active={Boolean(activeWorkflow)}
        onSend={onSend}
      />
    );
  if (block.type === "SURFACE" && block.payload.commerce)
    return <Suspense fallback={<SurfaceLoading />}><CommercialSurface commerce={block.payload.commerce} active={Boolean(activeWorkflow)} onSend={onSend} /></Suspense>;
  if (block.type === "SURFACE" && block.payload.memory) {
    const memory = normalizeMemory(block.payload.memory);
    return memory ? <Suspense fallback={<SurfaceLoading />}><MemorySummary memory={memory} active={Boolean(activeWorkflow)} onSend={onSend} /></Suspense> : null;
  }
  if (block.type === "SURFACE" && isPolicyReview(block.payload.policyReview))
    return <PolicyReviewPanel review={block.payload.policyReview} active={Boolean(activeWorkflow)} onSend={onSend} />;
  if (block.type === "SURFACE" && block.payload.surface === "ADVICE")
    return isAdvice(block.payload.advice) ? <AdvicePanel advice={block.payload.advice} active={Boolean(activeWorkflow)} onSend={onSend} /> : null;
  if (block.type === "SURFACE" && block.payload.surface === "COMPARISON")
    return isComparison(block.payload.comparison) ? <ComparisonPanel comparison={block.payload.comparison} /> : null;
  if (block.type === "SURFACE" && (block.payload.surface === "PURCHASE_REVIEW" || block.payload.surface === "PAYMENT_REVIEW"))
    return isPurchaseReview(block.payload.purchaseReview) ? (
      <PurchaseReviewPanel review={block.payload.purchaseReview} active={Boolean(activeWorkflow)} onSend={onSend} />
    ) : null;
  if (block.type === "SURFACE" && block.payload.employment)
    return (
      <Suspense fallback={<SurfaceLoading />}>
        <EmploymentSurface
          employment={block.payload.employment}
          active={Boolean(activeWorkflow)}
          onSend={onSend}
        />
      </Suspense>
    );
  if (block.type === "SURFACE" && block.payload.business)
    return (
      <Suspense fallback={<SurfaceLoading />}>
        <BusinessSurface
          business={block.payload.business}
          active={Boolean(activeWorkflow)}
          onSend={onSend}
        />
      </Suspense>
    );
  if (block.type === "SURFACE")
    return (
      <>
        {block.payload.sellerContactRequested === true && typeof block.payload.resourceId === "string" && (
          <SellerContactReleaseCard orderId={block.payload.resourceId} />
        )}
        {block.payload.managementPreview && (
          <ListingManagementPreviewCard
            preview={block.payload.managementPreview}
          />
        )}
        {block.payload.surface === "SELL" && (
          <PhotoSuggestionPanel
            block={block}
            active={Boolean(activeWorkflow)}
            onSend={onSend}
          />
        )}
        {block.payload.surface === "SELL" && isDraftReview(block.payload.draftReview) && (
          <DraftReviewPanel review={block.payload.draftReview} step={block.payload.draftStep} active={Boolean(activeWorkflow)} onSend={onSend} photos={draftPhotos(block.payload.draft)} />
        )}
        {isAdvice(block.payload.advice) && block.payload.advice.options && (
          <ClarificationOptions options={block.payload.advice.options} active={Boolean(activeWorkflow)} onSend={onSend} />
        )}
        {block.payload.displaySurface && (
          // Phase 2: the server's own figures in the form the model chose (validated again here).
          <ComposedSurfaceView surface={block.payload.displaySurface} active={Boolean(activeWorkflow)} onSend={onSend} />
        )}
        {isBusinessInsight(block.payload.sellerInsight) && (
          <BusinessSummaryPanel insight={block.payload.sellerInsight} active={Boolean(activeWorkflow)} onSend={onSend} />
        )}
        {isSellerInsight(block.payload.sellerInsight) && (
          <SellerInsightPanel insight={block.payload.sellerInsight} />
        )}
        {/* A business answer is complete in its card; the full listings workflow would repeat it. */}
        {!isBusinessInsight(block.payload.sellerInsight) && (
          <Workflow
            surface={block.payload.surface ?? "UNSUPPORTED"}
            resourceIds={block.payload.resourceIds}
            resourceId={block.payload.resourceId}
            selectedListingId={block.payload.resourceId}
            draftStep={block.payload.draftStep}
            onSend={onSend}
          />
        )}
      </>
    );
  const listings = (block.payload?.listings ?? []) as Listing[];
  if (block.type !== "LISTING_RESULTS" || block.version !== 1)
    return null;
  const resourceIds = block.payload.resourceIds ?? listings.map((listing) => listing.id);
  return (
    <section
      className="mt-4 max-w-[960px]"
      aria-label="نتائج العروض"
      data-testid={`ai-results-${block.payload.presentation === "DETAILS" ? "details" : "list"}`}
      data-result-set-id={block.payload.resultSetId}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">
          {listings.length === 0
            ? "لا توجد نتائج مطابقة"
            : block.payload.presentation === "DETAILS"
              ? "العرض الذي اخترته"
              : listings.some((listing) => listing.recommendationReasons?.length)
                ? "اقتراحات من عروض DINAR"
                : "وجدت لك هذه الخيارات"}
        </p>
        <span className="num text-xs text-muted-foreground">
          {listings.length} {listings.length === 1 ? "نتيجة" : "نتائج"}
          {listings.length > 1 && block.payload.presentation !== "DETAILS" && <span data-testid="ai-results-more"> · اسحب للمزيد</span>}
        </span>
      </div>
      {block.payload.searchState && (
        <div className="ai-inline-refinements">
          <SearchRefinements state={block.payload.searchState} />
        </div>
      )}
      {listings.length === 0 ? (
        <div className="ai-results-empty" role="status" data-testid="ai-results-empty">
          <p>لا توجد عروض مطابقة لهذه المعايير حاليًا.</p>
          <span>يمكنك تعديل طلبك أو تجربة بحث أوسع.</span>
        </div>
      ) : (
      <>
      {block.payload.composition?.layout === "TABLE" && <ListingTable listings={listings} />}
      <ResultLayout resultSetId={block.payload.resultSetId} layout={block.payload.composition?.layout === "TABLE" ? undefined : block.payload.composition?.layout}>
        {listings.map((listing, index) => {
          const storedIndex = resourceIds.indexOf(listing.id);
          const resultIndex = storedIndex >= 0 ? storedIndex : index;
          const stock = stockOf(listing);
          const place = placeOf(listing);
          const detailLabel =
            listing.fulfilmentType === "SERVICE"
              ? "تفاصيل الخدمة"
              : "عرض التفاصيل";
          const addLabel =
            listing.fulfilmentType === "SERVICE"
              ? "أضف الخدمة إلى السلة"
              : "أضف للسلة";
          return (
            <div
              key={listing.id}
              data-testid={`card-ai-result-${listing.id}`}
              data-result-index={resultIndex}
              data-resource-id={listing.id}
              aria-roledescription="بطاقة نتيجة"
              aria-label={`النتيجة ${resultIndex + 1}: ${listing.title}${listing.id === block.payload.composition?.highlightId ? " — اقتراح دينار" : ""}`}
              role={block.payload.composition?.layout === "GRID" || block.payload.composition?.layout === "LIST" ? "listitem" : "group"}
              data-highlighted={listing.id === block.payload.composition?.highlightId ? "true" : undefined}
              className={
                block.payload.composition?.layout === "GRID" || block.payload.composition?.layout === "LIST"
                  ? `ai-result-item relative min-w-0${listing.id === block.payload.composition?.highlightId ? " ring-2 ring-primary rounded-2xl" : ""}`
                  : `ai-result-item relative w-[76vw] min-w-[220px] max-w-[290px] shrink-0 snap-start sm:w-[252px]${listing.id === block.payload.composition?.highlightId ? " ring-2 ring-primary rounded-2xl" : ""}`
              }
            >
              {listing.id === block.payload.composition?.highlightId && (
                // A model suggestion over DINAR's own verified facts, labelled as such; never sponsored.
                <span className="absolute end-2.5 top-2.5 z-10 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground" data-testid={`result-highlight-${listing.id}`}>
                  اقتراح دينار
                </span>
              )}
              <span
                className="ai-result-position num pointer-events-none absolute start-2.5 top-2.5 z-10"
                data-testid={`result-position-${resultIndex + 1}`}
                aria-hidden
              >
                {resultIndex + 1}
              </span>
              <OfferCard
                conversational
                offer={listing}
                eager={activeResults && index < 2}
                onOpen={() => setSelected(listing.id)}
              />
              <div className="ai-result-actions">
                <Button
                  className="min-w-0"
                  variant="secondary"
                  onClick={() =>
                    setSelected(selected === listing.id ? undefined : listing.id)
                  }
                  data-testid={`button-open-result-${listing.id}`}
                >
                  {detailLabel}
                </Button>
                {/* Universal negotiation: a definite price goes to the cart; any other price
                    representation offers the agreement path instead of a buy action. */}
                {activeResults && !offerDirectPurchase(listing) && (
                  <Button
                    className="min-w-0"
                    variant="gold"
                    disabled={stock.tone === "out" || !onSend}
                    onClick={() =>
                      onSend?.(
                        offerRepresentation(listing) === "QUOTE_REQUIRED" || offerRepresentation(listing) === "STARTING_FROM"
                          ? conversationActionMessage("REQUEST_BEST_PRICE", { position: resultIndex + 1 })
                          : `قدّم عرض سعر على الإعلان رقم ${resultIndex + 1}`,
                      )
                    }
                    data-testid={`button-negotiate-result-${listing.id}`}
                  >
                    {offerRepresentation(listing) === "QUOTE_REQUIRED" || offerRepresentation(listing) === "STARTING_FROM"
                      ? "اطلب تسعيرة"
                      : "قدّم عرض سعر"}
                  </Button>
                )}
                {activeResults && offerDirectPurchase(listing) && (
                  <Button
                    className="ai-result-cart"
                    variant="gold"
                    loading={addingListingId === listing.id}
                    disabled={stock.tone === "out" || !onAdd || Boolean(addingListingId)}
                    aria-busy={addingListingId === listing.id || undefined}
                    onClick={(event) => {
                      const card = event.currentTarget.closest(
                        '[data-testid^="card-ai-result-"]',
                      );
                      const image = card?.querySelector("img") ?? null;
                      void Promise.resolve(
                        onAdd?.(listing, block.payload.resultSetId),
                      ).then((added) => {
                        // The flight is drawn only for a confirmed server mutation.
                        if (!added) return;
                        try {
                          animateListingToBasket(image);
                        } catch {
                          // The cart is already confirmed; a visual acknowledgement must never
                          // surface as an error or change the result.
                        }
                      });
                    }}
                    data-testid={`button-add-to-cart-${listing.id}`}
                    aria-label={
                      stock.tone === "out"
                        ? "غير متوفر"
                        : addingListingId === listing.id
                          ? "جارٍ الإضافة إلى السلة"
                          : addLabel
                    }
                    title={stock.tone === "out" ? "غير متوفر" : addLabel}
                  >
                    {addingListingId === listing.id ? null : (
                      <ShoppingCart size={18} aria-hidden />
                    )}
                  </Button>
                )}
              </div>
              {place && listing.fulfilmentType !== "DIGITAL" && (
                <a
                  className="ai-result-map-link"
                  href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(`${market?.countryNameAr ?? ""} ${place}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  المنطقة على الخريطة: {place}
                </a>
              )}
            </div>
          );
        })}
      </ResultLayout>
      </>
      )}
      {selected && (
        <div>
          <button
            type="button"
            className={buttonClass("ghost", "sm", false, "mt-2")}
            onClick={() => setSelected(undefined)}
          >
            إغلاق التفاصيل
          </button>
          <Workflow
            key={selected}
            surface="LISTING"
            resourceId={selected}
            onBack={() => setSelected(undefined)}
            // Conversation commands only for the listing the server put in focus («العرض الذي اخترته»);
            // a card opened locally is not the conversation's focus.
            onSend={
              activeResults &&
              block.payload.presentation === "DETAILS" &&
              selected === (block.payload.listings?.[0] as Listing | undefined)?.id
                ? onSend
                : undefined
            }
          />
        </div>
      )}
    </section>
  );
}

function MessageTurn({
  message,
  onSend,
  onSelectMarket,
  onEdit,
  onAdd,
  addingListingId,
  activeWorkflow,
  activeResults,
  busy,
}: {
  busy?: boolean;
  activeWorkflow?: boolean;
  activeResults?: boolean;
  addingListingId?: string;
  message: AiMessage;
  onEdit?: (messageId: string, body: string) => Promise<void>;
  onAdd?: (listing: Listing, resultSetId: string) => Promise<boolean> | boolean;
  onSend?: (text: string, location?: LocationSubmission) => void;
  onSelectMarket?: (marketId: string, resumeMessageId: string) => Promise<void>;
}) {
  const assistant = message.role === "ASSISTANT";
  // A provenance-only advice block («معلومة عامة…») is shown beside the copy action, not as a card.
  const chipIndex = assistant ? (message.blocks ?? []).findIndex((block) => block.type === "SURFACE" && block.payload?.surface === "ADVICE" && adviceChipLabel(block.payload.advice)) : -1;
  const chipAdvice = chipIndex >= 0 ? (message.blocks[chipIndex]!.payload.advice as { scope?: string; kind?: string }) : undefined;
  const chip = chipAdvice ? adviceChipLabel(chipAdvice) : undefined;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.body);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState("");
  const saveEdit = async () => {
    const next = editText.trim();
    if (!next || !onEdit || editPending) return;
    setEditPending(true);
    setEditError("");
    try {
      await onEdit(message.id, next);
      setEditing(false);
    } catch {
      setEditError("تعذر إنشاء نسخة معدّلة. حاول مجددًا.");
    } finally {
      setEditPending(false);
    }
  };
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <article
      dir="rtl"
      data-testid={`message-${message.role.toLowerCase()}-${message.id}`}
      data-role={assistant ? "assistant" : "user"}
      className="ai-turn ai-message-in group/turn w-full"
    >
      {assistant && (
        <span className="ai-assistant-avatar" aria-hidden>
          <DinarMark size={22} />
        </span>
      )}
      <div
        className={cn(
          "min-w-0",
          assistant ? "ai-assistant-content w-full text-foreground" : "ai-user-content",
        )}
      >
        {assistant && <span className="sr-only">DINAR AI</span>}
        {message.body &&
          !(assistant && controlOnly(message.blocks)) &&
          (assistant ? (
            <div className="ai-assistant-text">
              <AssistantBody body={message.body} withoutRows={hasDetailCard(message.blocks)} />
            </div>
          ) : (
            <div className="ai-user-bubble">
              {editing ? (
                <textarea
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  disabled={editPending}
                  maxLength={4000}
                  aria-label="تعديل رسالتك"
                  data-testid={`textarea-edit-message-${message.id}`}
                  className="w-full min-h-24 resize-y rounded-xl border border-border bg-background p-3 text-foreground"
                />
              ) : (
                <MessageBody body={message.body} />
              )}
            </div>
          ))}
        {assistant &&
          message.blocks?.map((block, index) => index === chipIndex ? null : (
            <fieldset disabled={busy} aria-busy={busy || undefined} className="dinar-action-group" data-surface-size={block.type === "SURFACE" && block.payload.surface ? conversationSurfaceSize(block.payload.surface) : "WIDE"} key={`${block.type}-${block.payload?.resultSetId}`}>
              <BlockBoundary>
                <CardEnvelopeProvider value={block.payload.card}>
                  <ResultBlock
                    block={block}
                    activeWorkflow={activeWorkflow}
                    activeResults={activeResults}
                    onAdd={onAdd}
                    addingListingId={addingListingId}
                    onSend={onSend}
                    onSelectMarket={onSelectMarket}
                    key={`${block.type}-${block.payload?.resultSetId}`}
                  />
                </CardEnvelopeProvider>
              </BlockBoundary>
            </fieldset>
          ))}
        {assistant && message.receipts?.length ? <ActionReceiptList receipts={message.receipts} /> : null}
        {assistant &&
          (message.body || chip) &&
          !message.id.startsWith("local-assistant") && (
            <div className="ai-message-actions">
              {message.body && <button
                type="button"
                aria-label={copied ? "تم نسخ الرد" : "نسخ الرد"}
                title="نسخ الرد"
                data-testid="button-copy-message"
                className="ai-message-action"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(privateTranscript(message.body));
                    setCopied(true);
                    setCopyError(false);
                  } catch {
                    setCopyError(true);
                  }
                }}
              >
                {copied ? (
                  <Check size={16} aria-hidden />
                ) : (
                  <Copy size={16} aria-hidden />
                )}
              </button>}
              {chip && (
                <span className="ai-scope-chip" data-testid="advice" data-scope={chipAdvice?.scope} data-kind={chipAdvice?.kind}>
                  {chip}
                </span>
              )}
              <span role="status" className="ai-message-action-status">
                {copied
                  ? "تم النسخ"
                  : copyError
                    ? "تعذر النسخ. يمكنك تحديد النص ونسخه."
                    : ""}
              </span>
            </div>
          )}
        {!assistant && onEdit && message.body && !editing && (
          <div className="ai-message-actions">
            <button
              type="button"
              aria-label="تعديل رسالتك"
              title="تعديل رسالتك"
              data-testid={`button-edit-message-${message.id}`}
              className="ai-message-action ai-message-action--text"
              onClick={() => {
                setEditText(message.body);
                setEditError("");
                setEditing(true);
              }}
              disabled={busy}
            >
              <Pencil size={16} aria-hidden />
            </button>
          </div>
        )}
        {!assistant && editing && (
          <div className="ai-message-actions">
            <button
              type="button"
              className="ai-message-action ai-message-action--text"
              data-testid={`button-save-message-edit-${message.id}`}
              onClick={() => void saveEdit()}
              disabled={editPending || !editText.trim()}
            >
              {editPending ? "جارٍ إنشاء النسخة…" : "تعديل وإعادة الرد"}
            </button>
            <button
              type="button"
              className="ai-message-action"
              onClick={() => {
                setEditing(false);
                setEditText(message.body);
                setEditError("");
              }}
              disabled={editPending}
            >
              إلغاء
            </button>
            {editError && <span role="alert" className="ai-message-action-status">{editError}</span>}
          </div>
        )}
      </div>
    </article>
  );
}

export const MessageBubble = memo(MessageTurn);
