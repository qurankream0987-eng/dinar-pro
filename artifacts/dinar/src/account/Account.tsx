import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Button } from "@/ui/Button";
import { DEFAULT_MARKET, formatMoney, minorToDecimal } from "@workspace/global";
import { clearGuestHandoff } from "@/features/ai/conversation-storage";

export type Market = {
  id: string;
  status: "ACTIVE" | "LIMITED" | "COMING_SOON" | "DISABLED";
  isActive: boolean;
  priceConfigured: boolean;
  countryNameEn: string;
  callingCode?: string;
  fulfilmentMethods: string[];
  paymentMethods: string[];
  restrictedCategories: string[];
  sellerEligibilityMode: string;
  countryCode: string;
  countryNameAr: string;
  currencyCode: string;
  currencySymbolAr: string;
  unitPriceMinor: number;
  minorUnitScale: number;
  /** Server decision: open fully, or on technical readiness before legal approval. */
  marketOpen?: boolean;
  operationMode?: "FULL" | "PRE_LEGAL" | "LEGAL_GATED" | "CLOSED";
  technicalStatus?: "READY" | "NOT_READY" | "NOT_VERIFIED";
  legalApprovalStatus?: "APPROVED" | "PENDING" | "SUSPENDED";
};
export function isMarketAvailable(market?: Market) {
  if (market?.operationMode === "PRE_LEGAL") return true;
  return Boolean(
    market?.isActive &&
      (market.status === "ACTIVE" || market.status === "LIMITED") &&
      market.priceConfigured &&
      market.unitPriceMinor >= 1,
  );
}
export type User = {
  role: "USER" | "ADMIN";
  administrativeArea: string;
  locale: string;
  timeZone: string;
  id: string;
  displayName: string;
  city: string;
  area: string;
  avatarObjectPath: string | null;
  accountCountry: string;
  activeMarketId: string;
  phoneVerified: boolean;
  normalizedPhone: string;
  status: "ACTIVE" | "RESTRICTED" | "SUSPENDED" | "DEACTIVATED";
  createdAt: string;
};

/** JSON fetch against our API. Errors always carry a human Arabic message. */
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("تعذر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.");
  }
  const result = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof result?.error === "string" && /[؀-ۿ]/.test(result.error)
        ? result.error
        : "تعذر إتمام العملية. حاول مرة أخرى.";
    throw Object.assign(new Error(message), { status: res.status });
  }
  return result;
}

type AccountContext = {
  user: User | null;
  markets: Market[];
  market?: Market;
  loading: boolean;
  /**
   * True from the moment this tab becomes visible again until the server says who is signed in:
   * another tab may have signed out or switched accounts meanwhile, so private views wait.
   */
  verifying: boolean;
  registerPrivateScreen: () => () => void;
  refresh: () => Promise<void>;
  refreshMarkets: () => Promise<void>;
  logout: () => Promise<void>;
};
const Context = createContext<AccountContext>(null!);
export const useAccount = () => useContext(Context);
/** Presentation-only suspension; standalone UI tests have no account provider. */
export const useSessionChecking = () => useContext(Context)?.verifying ?? false;

export const marketUnitAmount = (market?: Market) => market?.priceConfigured ? minorToDecimal(market.unitPriceMinor, market.currencyCode) : "0";
export const marketPrice = (market?: Market) => market?.priceConfigured ? formatMoney(market.unitPriceMinor, market.currencyCode) : "السعر لم يُعتمد بعد";

/** Everything tied to the signed-in session: not the identity itself, not the public market list. */
const sessionScoped = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "markets" && query.queryKey[0] !== "identity" };

export function AccountProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery<{ user: User | null; marketId?: string }>({
    queryKey: ["identity"],
    queryFn: async () => {
      const next: { user: User | null; marketId?: string } = await api("/auth/me");
      const previous = qc.getQueryState<{ user: User | null }>(["identity"])?.data;
      // Another tab signed out or in as someone else: drop every session-scoped cache before the
      // new identity renders, so this tab never pairs one account's identity with another's data.
      if (previous && (previous.user?.id ?? null) !== (next.user?.id ?? null)) {
        await qc.cancelQueries(sessionScoped);
        // Reset without refetching: mounted views drop the old data now; they refetch below, once
        // they have rendered for the new identity (a signed-out view must not ask at all).
        for (const query of qc.getQueryCache().findAll(sessionScoped)) query.reset();
      }
      return next;
    },
    retry: false,
    staleTime: 30000,
    // Re-checked explicitly whenever the tab becomes visible (below), however recent the last read.
    refetchOnWindowFocus: false,
  });
  const userId = me.data === undefined ? undefined : (me.data.user?.id ?? null);
  const [shownFor, setShownFor] = useState(userId);
  useEffect(() => {
    if (userId === shownFor) return;
    setShownFor(userId);
    if (shownFor !== undefined && userId !== undefined) void qc.refetchQueries({ ...sessionScoped, type: "active" });
  }, [userId, shownFor, qc]);
  const [verifying, setVerifying] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [privateScreens, setPrivateScreens] = useState(0);
  const registerPrivateScreen = useCallback(() => {
    setPrivateScreens(count => count + 1);
    return () => setPrivateScreens(count => Math.max(0, count - 1));
  }, []);
  const verificationRevision = useRef(0);
  const privateMaskActive = useRef(false);
  const privateFocus = useRef<{ element: HTMLElement; owner: string | null | undefined; x: number; y: number } | undefined>(undefined);
  const refetchIdentity = me.refetch;
  const revalidateIdentity = useCallback(async () => {
    const revision = ++verificationRevision.current;
    setVerifying(true);
    setVerificationFailed(false);
    try {
      const result = await refetchIdentity();
      if (revision !== verificationRevision.current) return;
      // A failed read cannot establish who is signed in. Keep all private UI blocked until
      // an explicit retry or a later visibility check succeeds.
      if (result.isError) setVerificationFailed(true);
      else setVerifying(false);
    } catch {
      if (revision === verificationRevision.current) setVerificationFailed(true);
    }
  }, [refetchIdentity]);
  useLayoutEffect(() => {
    const body = document.body;
    if (verifying && (privateScreens > 0 || document.querySelector("[data-private-screen]") || verificationFailed || privateMaskActive.current)) {
      if (!privateMaskActive.current && document.activeElement instanceof HTMLElement) {
        privateFocus.current = { element: document.activeElement, owner: userId, x: window.scrollX, y: window.scrollY };
      }
      privateMaskActive.current = true;
      // Hide every body root, including portalled dialogs, without destroying same-owner
      // form state. Protected keys its subtree by the verified owner when that owner changes.
      body.setAttribute("data-private-session-check", "true");
      return () => body.removeAttribute("data-private-session-check");
    }
    body.removeAttribute("data-private-session-check");
    if (!verifying) {
      privateMaskActive.current = false;
      const previous = privateFocus.current;
      privateFocus.current = undefined;
      if (previous && previous.owner === userId && previous.element.isConnected) {
        previous.element.focus({ preventScroll: true });
        window.scrollTo({ left: previous.x, top: previous.y, behavior: "instant" });
      }
    }
    return undefined;
  }, [verifying, verificationFailed, userId, privateScreens]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void revalidateIdentity();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      verificationRevision.current += 1;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [revalidateIdentity]);
  const markets = useQuery<Market[]>({
    queryKey: ["markets"],
    queryFn: () => api("/markets"),
    staleTime: 5 * 60000,
  });
  const user = me.data?.user ?? null;
  const currentMarketId = user?.activeMarketId ?? me.data?.marketId ?? DEFAULT_MARKET;
  /** Re-read the session, then reset every session/market-scoped query so views refetch. */
  const refresh = useCallback(async () => {
    await qc.cancelQueries();
    await me.refetch();
    await qc.resetQueries({
      predicate: (q) =>
        q.queryKey[0] !== "markets" && q.queryKey[0] !== "identity",
    });
  }, [qc, me]);
  const refreshMarkets = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["markets"] });
  }, [qc]);
  const logout = useCallback(async () => {
    const leavingEmail = (me.data?.user as { email?: string | null } | null | undefined)?.email;
    await api("/auth/logout", "POST", {});
    // Make the Google button forget the account that is leaving, so the next sign-in shows the
    // account chooser instead of "Continue as <previous account>".
    try {
      const gid = (window as unknown as { google?: { accounts?: { id?: { disableAutoSelect?: () => void; revoke?: (hint: string, done: () => void) => void } } } }).google?.accounts?.id;
      gid?.disableAutoSelect?.();
      if (leavingEmail && gid?.revoke) await new Promise<void>((done) => { gid.revoke!(leavingEmail, () => done()); setTimeout(done, 1500); });
    } catch { /* Google script absent: nothing to forget */ }
    // A handoff waiting in this tab belongs to the account that is leaving; never to the next one.
    clearGuestHandoff();
    await qc.cancelQueries();
    qc.clear();
    window.location.replace(import.meta.env.BASE_URL);
  }, [qc, me]);
  return (
    <Context.Provider
      value={{
        user,
        markets: markets.data ?? [],
        market: markets.data?.find((m) => m.id === currentMarketId),
        loading: me.isLoading,
        verifying,
        registerPrivateScreen,
        refresh,
        refreshMarkets,
        logout,
      }}
    >
      {children}
      {createPortal(
        <div id="dinar-private-session-check" role="status" aria-live="polite" aria-busy={verifying} className="fixed inset-0 z-[10000] pointer-events-auto items-center justify-center bg-background p-6 text-center text-foreground">
          <div className="max-w-sm space-y-4">
            <p role={verificationFailed ? "alert" : undefined}>{verificationFailed ? "تعذر التحقق من الجلسة. أعد المحاولة للمتابعة." : "جارٍ التحقق من الجلسة…"}</p>
            {verificationFailed && <Button variant="secondary" onClick={() => void revalidateIdentity()} data-testid="button-retry-private-identity">إعادة المحاولة</Button>}
          </div>
        </div>, document.body,
      )}
    </Context.Provider>
  );
}
