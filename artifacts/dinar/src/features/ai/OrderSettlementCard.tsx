/**
 * «التواصل والدفع»: after the seller accepts, the other party's name and phone; and the buyer's
 * stated payment preference outside DINAR (cash, bank transfer or the local instant method).
 * Information only: choosing a method never marks the order paid.
 */
import { Phone, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetOrderCounterpartContactQueryKey,
  useGetOrderCounterpartContact,
  useSetOrderSettlementPreference,
  type SettlementPreferenceInputMethod,
} from "@workspace/api-client-react";
import { friendlyError } from "@/lib/errors";
import { toast } from "sonner";

export function OrderSettlementCard({ orderId, role }: { orderId: string; role: "buyer" | "seller" | null }) {
  const client = useQueryClient();
  const contact = useGetOrderCounterpartContact(orderId, { query: { queryKey: getGetOrderCounterpartContactQueryKey(orderId), staleTime: 0, enabled: Boolean(role) } });
  const setPreference = useSetOrderSettlementPreference();
  const data = contact.data;
  if (!role || !data) return null;
  const choose = async (method: SettlementPreferenceInputMethod) => {
    try {
      await setPreference.mutateAsync({ id: orderId, data: { method } });
      await client.invalidateQueries({ queryKey: getGetOrderCounterpartContactQueryKey(orderId) });
      toast.success("تم إبلاغ البائع بطريقة الدفع المفضلة");
    } catch (err) {
      toast.error(friendlyError(err));
    }
  };
  return (
    <section className="rounded-2xl border border-border bg-background p-4" aria-label="التواصل والدفع" data-testid={`order-settlement-${orderId}`}>
      <h3 className="font-semibold text-foreground">التواصل والدفع</h3>
      {data.available && data.counterpart ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="order-counterpart">
          <Phone size={15} aria-hidden />
          <span>{data.counterpart.role === "SELLER" ? "البائع" : "المشتري"}: {data.counterpart.name}</span>
          <a className="font-semibold text-primary underline-offset-2 hover:underline" href={`tel:${data.counterpart.phone}`} dir="ltr">
            {data.counterpart.phone}
          </a>
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="order-counterpart-pending">
          {data.reason === "AWAITING_SELLER_ACCEPTANCE" ? "يظهر رقم التواصل بعد قبول البائع للطلب." : "انتهى الطلب؛ لم تعد بيانات التواصل متاحة."}
        </p>
      )}
      <div className="mt-3">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Wallet size={15} aria-hidden /> طريقة الدفع المفضلة{role === "seller" ? " لدى المشتري" : ""}
        </p>
        {role === "buyer" && data.reason !== "ORDER_CLOSED" ? (
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="اختر طريقة الدفع المفضلة">
            {data.settlementMethods.map((option) => {
              const selected = data.settlementPreference?.method === option.method;
              return (
                <button
                  key={option.method}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={setPreference.isPending}
                  onClick={() => void choose(option.method)}
                  className={`min-h-11 rounded-full border px-3 text-sm ${selected ? "border-primary bg-primary-soft font-semibold text-primary-soft-foreground" : "border-border hover:bg-muted"}`}
                  data-testid={`settlement-${option.method}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="settlement-preference">
            {data.settlementPreference?.label ?? "لم يحدد المشتري طريقة بعد."}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{data.notice}</p>
      </div>
    </section>
  );
}
