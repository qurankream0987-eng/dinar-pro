/**
 * Payment Preferences & Agreement deal card. Server-built for one party of the order and rebuilt on
 * every read; the client only renders it. Buttons send the party's own words back to Jassim, so
 * every change goes through the same server-side consent checks as typed messages.
 */
type DealMethod = { code: string; label: string; kind: "DIRECT" | "COD"; available?: boolean; reason?: string };
export type DealCard = {
  kind: "DEAL_CARD";
  orderId: string;
  orderReference: string;
  viewerRole: "BUYER" | "SELLER";
  status: string;
  statusLabel: string;
  countryName: string;
  currency: string;
  title: string;
  imageUrl: string | null;
  sellerName: string;
  buyerName: string | null;
  items: { title: string; quantity: number; unitPrice: string | null; total: string | null }[];
  quantity: number;
  subtotal: string;
  total: string;
  delivery: { method: string; status: string } | null;
  acceptedMethods: DealMethod[];
  proposal: { code: string; label: string; by: "BUYER" | "SELLER"; awaiting: "BUYER" | "SELLER" } | null;
  agreedMethod: DealMethod | null;
  approvals: { seller: boolean; buyer: boolean };
  instructions: Record<string, string> | null;
  instructionsState: "SHARED" | "NOT_SHARED_YET" | "NOT_APPLICABLE";
  cod: { amountDue: string; currency: string; collected: boolean } | null;
  payment: { verification: "NONE" | "UNVERIFIED_BUYER_CLAIM" | "SELLER_ATTESTED"; platformVerified: false };
  actions: string[];
  notice: string;
};

export function isDealCard(value: unknown): value is DealCard {
  const card = value as Partial<DealCard> | undefined;
  return Boolean(card && card.kind === "DEAL_CARD" && typeof card.orderId === "string" && Array.isArray(card.acceptedMethods) && Array.isArray(card.actions));
}

const FIELD_LABELS: Record<string, string> = {
  beneficiaryName: "اسم المستفيد",
  alias: "الاسم المستعار (Alias)",
  phone: "رقم الهاتف",
  iban: "IBAN",
  accountNumber: "رقم الحساب",
  bankName: "البنك",
  walletNumber: "رقم المحفظة",
  note: "ملاحظة",
};
const DELIVERY_LABELS: Record<string, string> = { PICKUP: "استلام شخصي", SELLER_DELIVERY: "توصيل من البائع", COURIER: "مندوب توصيل", EXTERNAL_PROVIDER: "شركة توصيل" };

function tone(status: string) {
  if (["SELLER_CONFIRMED_RECEIPT", "COD_COLLECTED", "COMPLETED"].includes(status)) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (["CANCELLED", "DISPUTED"].includes(status)) return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
  if (["AWAITING_PAYMENT", "COD_PENDING_DELIVERY", "BUYER_REPORTED_PAID"].includes(status)) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

export function DealCardPanel({ card, active, onSend }: { card: DealCard; active: boolean; onSend?: (text: string) => void }) {
  const ref = card.orderReference.toLowerCase();
  const send = (text: string) => onSend?.(text);
  const can = (action: string) => active && Boolean(onSend) && card.actions.includes(action);
  const button = "rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50";
  return (
    <section dir="rtl" lang="ar" aria-label={`تفاصيل الصفقة ${card.orderReference}`} className="ai-deal-card w-full max-w-xl rounded-2xl border bg-card p-4 text-card-foreground shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold">تفاصيل الصفقة</h3>
        <span role="status" className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone(card.status)}`}>{card.statusLabel}</span>
      </header>

      <div className="mt-3 flex gap-3">
        {card.imageUrl ? <img src={card.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" loading="lazy" /> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{card.title || card.items[0]?.title}</p>
          <p className="text-sm text-muted-foreground">البائع: {card.sellerName}{card.buyerName ? ` · المشتري: ${card.buyerName}` : ""}</p>
          <p className="mt-1 text-lg font-semibold" dir="ltr" style={{ textAlign: "right" }}>{card.total} {card.currency}</p>
        </div>
      </div>

      {card.items.length > 1 && (
        <ul className="mt-3 space-y-1 text-sm">
          {card.items.map((item, index) => (
            <li key={index} className="flex justify-between gap-2"><span className="truncate">{item.title} × {item.quantity}</span><span dir="ltr">{item.total}</span></li>
          ))}
        </ul>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">الدولة</dt><dd>{card.countryName}</dd></div>
        <div><dt className="text-muted-foreground">التسليم</dt><dd>{card.delivery ? DELIVERY_LABELS[card.delivery.method] ?? card.delivery.method : "لم يُحدد بعد"}</dd></div>
      </dl>

      <div className="mt-4">
        <p className="text-sm font-medium">طرق الدفع التي وافق عليها البائع</p>
        {card.acceptedMethods.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {card.acceptedMethods.map((method) => {
              const chosen = card.agreedMethod?.code === method.code;
              const selectable = can("CHOOSE") && card.viewerRole === "BUYER" && method.available !== false && !chosen;
              return (
                <li key={method.code}>
                  <button type="button" disabled={!selectable} onClick={() => send(`أفضل ${method.label} ${ref}`)} aria-pressed={chosen}
                    title={method.available === false ? method.reason : undefined}
                    className={`${button} ${chosen ? "border-primary bg-primary/10" : ""}`}>
                    {method.label}
                    <span className="block text-xs font-normal text-muted-foreground">{method.kind === "COD" ? (method.available === false ? "غير متاح لهذا الطلب" : "عند الاستلام") : "دفع مباشر للبائع"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">لم يحدد البائع طرق الدفع بعد.</p>
        )}
      </div>

      {card.proposal && (
        <div className="mt-3 rounded-xl border border-amber-500/40 p-3 text-sm">
          <p>{card.proposal.by === "BUYER" ? "المشتري" : "البائع"} يقترح: <strong>{card.proposal.label}</strong> — بانتظار موافقة {card.proposal.awaiting === "SELLER" ? "البائع" : "المشتري"}.</p>
          {can("ACCEPT_PROPOSAL") && (
            <div className="mt-2 flex gap-2">
              <button type="button" className={button} onClick={() => send("موافق")}>موافق</button>
              <button type="button" className={button} onClick={() => send("أرفض")}>أرفض</button>
            </div>
          )}
        </div>
      )}

      {card.agreedMethod && (
        <div className="mt-3 rounded-xl bg-muted/50 p-3 text-sm">
          <p>الطريقة المتفق عليها: <strong>{card.agreedMethod.label}</strong></p>
          <p className="text-xs text-muted-foreground">موافقة البائع: {card.approvals.seller ? "نعم" : "لا"} · موافقة المشتري: {card.approvals.buyer ? "نعم" : "لا"}</p>
          {card.cod && <p className="mt-1">المبلغ المطلوب عند الاستلام: <strong dir="ltr">{card.cod.amountDue} {card.cod.currency}</strong></p>}
          {card.instructions && (
            <dl className="mt-2 space-y-1">
              {Object.entries(card.instructions).map(([field, value]) => (
                <div key={field} className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{FIELD_LABELS[field] ?? field}:</dt><dd dir="auto" className="font-medium select-all">{value}</dd></div>
              ))}
            </dl>
          )}
          {card.instructionsState === "NOT_SHARED_YET" && <p className="mt-1 text-xs text-muted-foreground">لم يشارك البائع بيانات الدفع بعد.</p>}
        </div>
      )}

      {card.payment.verification !== "NONE" && (
        <p className="mt-3 text-xs text-muted-foreground">
          {card.payment.verification === "UNVERIFIED_BUYER_CLAIM" ? "المشتري أبلغ بالدفع؛ هذا إبلاغ وليس تأكيدًا." : "البائع أكد الاستلام؛ لم يتحقق جاسم من أي تحويل."}
        </p>
      )}

      {active && onSend && (
        <div className="mt-4 flex flex-wrap gap-2">
          {can("SHARE_INSTRUCTIONS") && <button type="button" className={button} onClick={() => send(`شارك بيانات الدفع ${ref}`)}>شارك بيانات الدفع</button>}
          {can("REPORT_PAID") && <button type="button" className={button} onClick={() => send("دفعت")}>أبلغ أنني دفعت</button>}
          {can("CONFIRM_RECEIPT") && <button type="button" className={button} onClick={() => send("استلمت المبلغ")}>استلمت المبلغ</button>}
          {can("REPORT_NOT_RECEIVED") && <button type="button" className={button} onClick={() => send("لم يصلني المبلغ")}>لم يصلني المبلغ</button>}
          {can("COD_COLLECTED") && <button type="button" className={button} onClick={() => send("استلمت المبلغ")}>حصّلت المبلغ نقدًا</button>}
          {can("CANCEL") && <button type="button" className={`${button} text-red-600`} onClick={() => send(`الغاء اتفاق الدفع ${ref}`)}>إلغاء اتفاق الدفع</button>}
        </div>
      )}

      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{card.notice}</p>
    </section>
  );
}
