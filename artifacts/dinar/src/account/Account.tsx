import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
};
export function isMarketAvailable(market?: Market) {
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
  refresh: () => Promise<void>;
  refreshMarkets: () => Promise<void>;
  logout: () => Promise<void>;
};
const Context = createContext<AccountContext>(null!);
export const useAccount = () => useContext(Context);

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
  const refetchIdentity = me.refetch;
  useEffect(() => {
    let current = 0;
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      const check = ++current;
      setVerifying(true);
      void refetchIdentity().finally(() => {
        if (check === current) setVerifying(false);
      });
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refetchIdentity]);
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
    await api("/auth/logout", "POST", {});
    // A handoff waiting in this tab belongs to the account that is leaving; never to the next one.
    clearGuestHandoff();
    await qc.cancelQueries();
    qc.clear();
    window.location.replace(import.meta.env.BASE_URL);
  }, [qc]);
  return (
    <Context.Provider
      value={{
        user,
        markets: markets.data ?? [],
        market: markets.data?.find((m) => m.id === currentMarketId),
        loading: me.isLoading,
        verifying,
        refresh,
        refreshMarkets,
        logout,
      }}
    >
      {children}
    </Context.Provider>
  );
}
