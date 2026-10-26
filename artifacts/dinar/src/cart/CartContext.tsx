import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  addCartEntry,
  getCartTotalMinor,
  getCartUnitCount,
  setCartEntryQuantity,
  updateCartAvailability,
  type CartEntry,
  type CartResult,
} from "./cart-domain";
import { api, useAccount } from "../account/Account";

type CartContextValue = {
  items: CartEntry[];
  loading: boolean;
  error: string;
  retry: () => void;
  refreshFromServer: () => Promise<void>;
  totalMinor: number;
  unitCount: number;
  add: (entry: CartEntry, quantity: number) => CartResult;
  addPersisted: (entry: CartEntry, quantity: number) => Promise<CartResult>;
  setQuantity: (listingId: string, quantity: number) => CartResult;
  remove: (listingId: string) => void;
  clear: () => void;
  updateAvailability: (
    listingId: string,
    availableQuantity: number | null,
  ) => void;
};

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAccount();
  return (
    <ScopedCart key={`${user?.id ?? "guest"}:${user?.activeMarketId ?? "KW"}`}>
      {children}
    </ScopedCart>
  );
}
function ScopedCart({ children }: { children: ReactNode }) {
  const { user } = useAccount();
  const [items, setItems] = useState<CartEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const saved = useRef("[]");
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    let live = true;
    if (!user) return;
    api("/cart")
      .then((data) => {
        if (live) {
          saved.current = JSON.stringify(data);
          itemsRef.current = data;
          setItems(data);
          setReady(true);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  const itemsRef = useRef(items);

  useEffect(() => {
    itemsRef.current = items;
    if (!ready || !user || saved.current === JSON.stringify(items)) return;
    const snapshot = JSON.stringify(items);
    saved.current = snapshot;
    queue.current = queue.current
      .then(() =>
        api("/cart", "PUT", {
          marketId: user.activeMarketId,
          items: JSON.parse(snapshot),
        }),
      )
      .then(() => {
        setError("");
      })
      .catch((e) => {
        setError(
          "لم نتمكن من حفظ تغييرات السلة. تحقق من اتصالك ثم أعد تحميل الصفحة.",
        );
      });
  }, [items, ready, user]);

  const add = useCallback(
    (entry: CartEntry, quantity: number) => {
      if (!user || !ready)
        return {
          ok: false as const,
          message: "سجّل الدخول وانتظر تحميل سلتك أولًا.",
        };
      const result = addCartEntry(itemsRef.current, entry, quantity);
      if (result.ok) {
        itemsRef.current = result.items;
        setItems(result.items);
      }
      return result;
    },
    [user, ready],
  );

  // Conversation actions acknowledge only a server-confirmed write, using the shared cart API.
  const addPersisted = useCallback(
    async (entry: CartEntry, quantity: number): Promise<CartResult> => {
      if (!user || !ready)
        return { ok: false, message: "سجّل الدخول وانتظر تحميل السلة أولًا." };
      let result: CartResult = { ok: false, message: "تعذر حفظ السلة." };
      queue.current = queue.current.then(async () => {
        result = addCartEntry(itemsRef.current, entry, quantity);
        if (!result.ok) return;
        try {
          const fresh = await api("/cart", "PUT", {
            marketId: user.activeMarketId,
            items: result.items,
          });
          const items = Array.isArray(fresh) ? fresh : await api("/cart");
          saved.current = JSON.stringify(items);
          itemsRef.current = items;
          setItems(items);
          setError("");
          result = { ok: true, items };
        } catch (cause) {
          result = {
            ok: false,
            message: cause instanceof Error ? cause.message : "تعذر حفظ السلة.",
          };
        }
      });
      await queue.current;
      return result;
    },
    [user, ready],
  );

  const refreshFromServer = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api("/cart");
      const next = Array.isArray(data) ? data : [];
      saved.current = JSON.stringify(next);
      itemsRef.current = next;
      setItems(next);
      setReady(true);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "تعذر تحديث السلة من الخادم.",
      );
    }
  }, [user]);

  const setQuantity = useCallback((listingId: string, quantity: number) => {
    const result = setCartEntryQuantity(itemsRef.current, listingId, quantity);
    if (result.ok) {
      itemsRef.current = result.items;
      setItems(result.items);
    }
    return result;
  }, []);

  const remove = useCallback((listingId: string) => {
    const next = itemsRef.current.filter(
      (item) => item.listingId !== listingId,
    );
    itemsRef.current = next;
    setItems(next);
  }, []);

  const clear = useCallback(() => {
    itemsRef.current = [];
    setItems([]);
  }, []);

  const refreshAvailability = useCallback(
    (listingId: string, availableQuantity: number | null) => {
      const next = updateCartAvailability(
        itemsRef.current,
        listingId,
        availableQuantity,
      );
      itemsRef.current = next;
      setItems(next);
    },
    [],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      loading: !!user && !ready && !error,
      error,
      retry: () => {
        setError("");
        if (!ready) {
          api("/cart")
            .then((data) => {
              saved.current = JSON.stringify(data);
              itemsRef.current = data;
              setItems(data);
              setReady(true);
            })
            .catch((e) => setError(e.message));
        } else {
          queue.current = queue.current
            .then(() =>
              api("/cart", "PUT", {
                marketId: user!.activeMarketId,
                items: itemsRef.current,
              }),
            )
            .then(() => {
              setError("");
            })
            .catch(() => setError("تعذر حفظ السلة. حاول مرة أخرى."));
        }
      },
      totalMinor: getCartTotalMinor(items),
      unitCount: getCartUnitCount(items),
      add,
      addPersisted,
      refreshFromServer,
      setQuantity,
      remove,
      clear,
      updateAvailability: refreshAvailability,
    }),
    [
      items,
      add,
      addPersisted,
      setQuantity,
      remove,
      clear,
      refreshAvailability,
      ready,
      error,
      user,
    ],
  );

  return (
    <CartContext.Provider value={value}>
      {error && (
        <div
          role="alert"
          className="fixed inset-x-3 top-[calc(var(--topbar-h)+8px)] z-[var(--z-toast)] mx-auto max-w-md rounded-lg bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground shadow-lg"
        >
          {error}
        </div>
      )}
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart must be used within CartProvider");
  return cart;
}
