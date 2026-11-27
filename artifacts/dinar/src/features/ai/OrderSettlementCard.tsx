/**
 * «التواصل والدفع»: after the seller accepts, the other party's name and phone; and the buyer's
 * stated payment preference outside DINAR (cash, bank transfer or the local instant method).
 * Information only: choosing a method never marks the order paid.
 */
import { Check, Info, Phone, ShieldCheck, Wallet } from "lucide-react";
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

  const statusBadge =
    data.available && data.counterpart
      ? { label: "متاح للتنسيق", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" }
      : data.reason === "AWAITING_SELLER_ACCEPTANCE"
        ? { label: "بانتظار قبول البائع", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" }
        : { label: "الطلب مغلق", tone: "border-border bg-muted/60 text-muted-foreground" };

  return (
    <section
      dir="rtl"
      className="animate-fade w-full max-w-[500px] rounded-2xl border border-border/80 bg-card/95 p-4 shadow-sm backdrop-blur-sm transition-all duration-200"
      aria-label="التواصل والدفع"
      data-testid={`order-settlement-${orderId}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Wallet size={16} aria-hidden />
          </span>
          <h3 className="text-sm font-bold text-foreground">التواصل والدفع</h3>
        </div>
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusBadge.tone}`}>
          {statusBadge.label}
        </span>
      </header>

      <div className="mt-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
        {data.available && data.counterpart ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="order-counterpart">
            <span className="flex items-center gap-2 text-foreground">
              <Phone size={15} className="shrink-0 text-primary" aria-hidden />
              <span className="text-muted-foreground">{data.counterpart.role === "SELLER" ? "البائع:" : "المشتري:"}</span>
              <span className="font-semibold">{data.counterpart.name}</span>
            </span>
            <a
              className="inline-flex min-h-9 items-center rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-xs font-semibold tabular-nums text-primary transition hover:bg-primary/15"
              href={`tel:${data.counterpart.phone}`}
              dir="ltr"
            >
              <bdi dir="ltr">{data.counterpart.phone}</bdi>
            </a>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid="order-counterpart-pending">
            {data.reason === "AWAITING_SELLER_ACCEPTANCE" ? "يظهر رقم التواصل بعد قبول البائع للطلب." : "انتهى الطلب؛ لم تعد بيانات التواصل متاحة."}
          </p>
        )}
      </div>

      <div className="mt-3.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ShieldCheck size={14} className="text-amber-500" aria-hidden />
          طريقة الدفع المفضلة{role === "seller" ? " لدى المشتري" : ""}
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
                  className={`pressable inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3.5 text-xs font-medium ${
                    selected
                      ? "border-amber-500/60 bg-amber-500/12 font-semibold text-foreground shadow-xs ring-1 ring-amber-500/30"
                      : "border-border/80 bg-background/70 text-foreground hover:border-border hover:bg-muted/60"
                  }`}
                  data-testid={`settlement-${option.method}`}
                >
                  {selected && <Check size={14} className="shrink-0 text-amber-500" aria-hidden />}
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="mt-1.5 text-sm font-medium text-muted-foreground" data-testid="settlement-preference">
            {data.settlementPreference?.label ?? "لم يحدد المشتري طريقة بعد."}
          </p>
        )}
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-muted/40 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          <Info size={13} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>{data.notice}</span>
        </p>
      </div>
    </section>
  );
}