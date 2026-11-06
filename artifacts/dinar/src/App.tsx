import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { AccountProvider } from "./account/Account";
import { CartProvider } from "./cart/CartContext";
import { AppShell } from "./features/AppShell";
import { MarketSheetProvider } from "./features/MarketSelector";
import { Toaster } from "./ui/Toaster";
import { Skeleton } from "./ui/Feedback";
import AiPage from "./pages/Ai";
import { AuthPage, Protected } from "./pages/Auth";
import { NotFoundPage } from "./pages/Static";

// Conversation is the first paint; secondary workflows are loaded on demand.
const SearchPage = lazy(() => import("./pages/Search"));
const Home = lazy(() => import("./pages/Home"));
const OfferDetails = lazy(() => import("./pages/OfferDetails"));
const CartPage = lazy(() => import("./pages/Cart"));
const CheckoutPage = lazy(() => import("./pages/Checkout"));
const OrderDetailsPage = lazy(() => import("./pages/OrderDetails"));
const SellerDashboard = lazy(() => import("./pages/seller/SellerDashboard"));
const SellerOffers = lazy(() => import("./pages/seller/SellerOffers"));
const CreateOffer = lazy(() => import("./pages/seller/CreateOffer"));
const EditOffer = lazy(() => import("./pages/seller/EditOffer"));
const DuesPage = lazy(() => import("./pages/seller/Dues"));
const AdminMarketsPage = lazy(() => import("./pages/admin/AdminMarkets"));
const AdminCategoriesPage = lazy(() => import("./pages/admin/AdminCategories"));
const AdminPromotionsPage = lazy(() => import("./pages/admin/AdminPromotions"));
const AdminDisputesPage = lazy(() => import("./pages/admin/AdminDisputes"));
const AdminTrustSafetyPage = lazy(() => import("./pages/admin/AdminTrustSafety"));
const AdminLegalReadinessPage = lazy(
  () => import("./pages/admin/AdminLegalReadiness"),
);
const PoliciesIndexPage = lazy(() =>
  import("./pages/Policies").then((m) => ({ default: m.PoliciesIndexPage })),
);
const PolicyPage = lazy(() =>
  import("./pages/Policies").then((m) => ({ default: m.PolicyPage })),
);
const ProfilePage = lazy(() =>
  import("./pages/Account").then((m) => ({ default: m.ProfilePage })),
);
const SettingsPage = lazy(() =>
  import("./pages/Account").then((m) => ({ default: m.SettingsPage })),
);
const NotificationsPage = lazy(() =>
  import("./pages/Account").then((m) => ({ default: m.NotificationsPage })),
);
const PublicBusinessPage = lazy(() => import("./pages/PublicBusiness"));
const ConnectPage = lazy(() => import("./pages/Connect"));
const AdminConnectPage = lazy(() => import("./pages/admin/AdminConnect"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15000,
      retry: (count, error) => {
        const status = (error as { status?: number })?.status;
        return status !== undefined && status < 500 ? false : count < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

// Keep standalone marketplace pages available in source while the public
// experience is intentionally limited to the DINAR conversation.
const CHAT_ONLY_MODE = true;

const CHAT_ONLY_ADMIN_ROUTES = new Set([
  "/admin/connect",
  "/admin/markets",
  "/admin/categories",
  "/admin/promotions",
  "/admin/disputes",
  "/admin/trust-safety",
  "/admin/legal-readiness",
]);
const CHAT_ONLY_ACCOUNT_ROUTES = new Set([
  "/notifications",
  "/connect",
  "/login",
  "/register",
  "/profile",
  "/settings",
]);
// Policy surfaces stay reachable in chat-only mode (also linked from the chat).
const isPolicyRoute = (location: string) =>
  location === "/terms" || location === "/policies" || location.startsWith("/policies/");
// D3-A: a business's public storefront is a DINAR-hosted page, reachable from the conversation.
const isBusinessRoute = (location: string) => /^\/business\/[A-Za-z0-9_-]{1,64}$/u.test(location);
function PageFallback() {
  return (
    <div
      className="container-app space-y-3 pt-6"
      aria-busy="true"
      aria-label="جارٍ التحميل"
    >
      <Skeleton className="h-8 w-44" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

const guard = (node: ReactNode) => <Protected>{node}</Protected>;

function Routes() {
  const [location, setLocation] = useLocation();
  useEffect(() => {
    if (
      CHAT_ONLY_MODE &&
      location !== "/" &&
      location !== "/ai" &&
      location !== "/orders" &&
      !CHAT_ONLY_ADMIN_ROUTES.has(location) &&
      !CHAT_ONLY_ACCOUNT_ROUTES.has(location) &&
      !isPolicyRoute(location) &&
      !isBusinessRoute(location)
    ) {
      setLocation("/", { replace: true });
    }
  }, [location, setLocation]);

  const routeTree = CHAT_ONLY_MODE ? (
    <Switch>
      <Route path="/" component={AiPage} />
      <Route path="/ai" component={AiPage} />
      <Route path="/orders">
        <Redirect to="/ai?openOrders=1" />
      </Route>
      <Route path="/login"><AuthPage /></Route>
      <Route path="/register"><AuthPage register /></Route>
      <Route path="/notifications">{guard(<NotificationsPage />)}</Route>
      <Route path="/profile">{guard(<ProfilePage />)}</Route>
      <Route path="/settings">{guard(<SettingsPage />)}</Route>
      <Route path="/connect">{guard(<ConnectPage />)}</Route>
      <Route path="/admin/markets">{guard(<AdminMarketsPage />)}</Route>
      <Route path="/admin/connect">{guard(<AdminConnectPage />)}</Route>
      <Route path="/admin/categories">{guard(<AdminCategoriesPage />)}</Route>
      <Route path="/admin/promotions">{guard(<AdminPromotionsPage />)}</Route>
      <Route path="/admin/disputes">{guard(<AdminDisputesPage />)}</Route>
      <Route path="/admin/trust-safety">{guard(<AdminTrustSafetyPage />)}</Route>
      <Route path="/admin/legal-readiness">{guard(<AdminLegalReadinessPage />)}</Route>
      <Route path="/terms" component={PoliciesIndexPage} />
      <Route path="/policies" component={PoliciesIndexPage} />
      <Route path="/policies/:key" component={PolicyPage} />
      <Route path="/business/:id" component={PublicBusinessPage} />
      <Route component={AiPage} />
    </Switch>
  ) : (
    <Switch>
      <Route path="/" component={AiPage} />
      <Route path="/discover" component={Home} />
      <Route path="/search" component={SearchPage} />
      <Route path="/ai" component={AiPage} />
      <Route path="/login">
        <AuthPage />
      </Route>
      <Route path="/register">
        <AuthPage register />
      </Route>
      <Route path="/terms" component={PoliciesIndexPage} />
      <Route path="/policies" component={PoliciesIndexPage} />
      <Route path="/policies/:key" component={PolicyPage} />
      <Route path="/listings/:id">
        <OfferDetails />
      </Route>
      <Route path="/business/:id" component={PublicBusinessPage} />
      <Route path="/cart">{guard(<CartPage />)}</Route>
      <Route path="/checkout">{guard(<CheckoutPage />)}</Route>
      <Route path="/orders">
        <Redirect to="/ai?openOrders=1" />
      </Route>
      <Route path="/orders/:id">{guard(<OrderDetailsPage />)}</Route>
      <Route path="/notifications">{guard(<NotificationsPage />)}</Route>
      <Route path="/profile">{guard(<ProfilePage />)}</Route>
      <Route path="/settings">{guard(<SettingsPage />)}</Route>
      <Route path="/seller">{guard(<SellerDashboard />)}</Route>
      <Route path="/seller/new">{guard(<CreateOffer />)}</Route>
      <Route path="/seller/offers">{guard(<SellerOffers />)}</Route>
      <Route path="/seller/offers/:id/edit">{guard(<EditOffer />)}</Route>
      <Route path="/seller/dues">{guard(<DuesPage />)}</Route>
      <Route path="/admin/markets">{guard(<AdminMarketsPage />)}</Route>
      <Route path="/admin/categories">{guard(<AdminCategoriesPage />)}</Route>
      <Route path="/admin/promotions">{guard(<AdminPromotionsPage />)}</Route>
      <Route path="/admin/disputes">{guard(<AdminDisputesPage />)}</Route>
      <Route path="/admin/trust-safety">{guard(<AdminTrustSafetyPage />)}</Route>
      <Route path="/admin/legal-readiness">{guard(<AdminLegalReadinessPage />)}</Route>
      <Route component={NotFoundPage} />
    </Switch>
  );

  return (
    <ErrorBoundary resetKey={location}>
      <Suspense fallback={<PageFallback />}>
        {routeTree}
      </Suspense>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider>
        <CartProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <MarketSheetProvider>
              <AppShell>
                <Routes />
              </AppShell>
            </MarketSheetProvider>
          </WouterRouter>
          <Toaster />
        </CartProvider>
      </AccountProvider>
    </QueryClientProvider>
  );
}
