/**
 * Payment Preferences & Agreement deal card. Server-built for one party of the order and rebuilt on
 * every read; the client only renders it. Buttons send the party's own words back to Jassim, so
 * every change goes through the same server-side consent checks as typed messages.
 */
import { useState } from "react";

type DealMethod = { code: string; label: string; kind: "DIRECT" | "COD"; available?: boolean; reason?: string; standing?: string; standingLabel?: string; requiresMerchantCheckout?: boolean };
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
  instructions: null;
  instructionsAvailable?: boolean;
  instructionsState: "SHARED" | "NOT_SHARED_YET" | "SELLER_TO_PROVIDE" | "NOT_APPLICABLE";
  instructionFields?: string[];
  checkout?: { integrated: false; note: string | null };
  cod: { amountDue: string; currency: string; collected: boolean } | null;
  payment: { verification: "NONE" | "UNVERIFIED_BUYER_CLAIM" | "SELLER_ATTESTED"; platformVerified: false };
  actions: string[];
  commission: { amount: string; state: "NONE" | "DUE_ON_COMPLETION" | "RECORDED_AS_DUE"; collected: false; note: string; sellerNetBeforeOtherCosts: string } | null;
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
  walletProvider: "مزود المحفظة",
  walletNumber: "رقم المحفظة",
  paymentLink: "رابط صفحة الدفع الخاصة بالبائع",
  note: "ملاحظة",
};
const DELIVERY_LABELS: Record<string, string> = { PICKUP: "استلام شخصي", SELLER_DELIVERY: "توصيل من البائع", COURIER: "مندوب توصيل", EXTERNAL_PROVIDER: "شركة توصيل" };

function tone(status: string) {
  if (["SELLER_CONFIRMED_RECEIPT", "COD_COLLECTED", "COMPLETED"].includes(status)) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (["CANCELLED", "DISPUTED"].includes(status)) return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
  if (["AWAITING_PAYMENT", "COD_PENDING_DELIVERY", "BUYER_REPORTED_PAID"].includes(status)) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

type Protected = { instructions: Record<string, string>; merchantCheckoutLink: string | null; notice: string };

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? "تعذر إكمال الطلب الآن.");
  return data;
}

/** Payment details are fetched on demand from the protected endpoint and kept only in memory. */
function ProtectedInstructions({ orderId }: { orderId: string }) {
  const [state, setState] = useState<{ open: boolean; data?: Protected; error?: string }>({ open: false });
  if (!state.open)
    return (
      <button type="button" className="mt-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
        onClick={() => call(`/api/orders/${encodeURIComponent(orderId)}/deal-card/instructions`).then((data) => setState({ open: true, data }), (e: Error) => setState({ open: true, error: e.message }))}>
        عرض تعليمات الدفع المحمية
      </button>
    );
  if (state.error) return <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>;
  const data = state.data!;
  return (
    <div className="mt-2 rounded-xl border border-sky-500/40 p-3" aria-live="polite">
      <dl className="space-y-1">
        {Object.entries(data.instructions).filter(([field]) => field !== "paymentLink").map(([field, value]) => (
          <div key={field} className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{FIELD_LABELS[field] ?? field}:</dt><dd dir="auto" className="select-all font-medium">{value}</dd></div>
        ))}
      </dl>
      {data.merchantCheckoutLink && (
        <a href={data.merchantCheckoutLink} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-block rounded-lg border px-3 py-2 text-sm font-medium">
          فتح صفحة الدفع الخاصة بالبائع
        </a>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{data.notice}</p>
      <button type="button" className="mt-2 text-xs underline" onClick={() => setState({ open: false })}>إخفاء</button>
    </div>
  );
}

/** The seller enters only the fields this method needs; sent straight to the server, never into chat. */
function InstructionsForm({ orderId, fields, onDone }: { orderId: string; fields: string[]; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ busy?: boolean; error?: string; done?: boolean }>({});
  if (status.done) return <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">حُفظت بيانات الدفع وشُوركت مع المشتري في هذا الطلب فقط.</p>;
  return (
    <form className="mt-2 space-y-2" onSubmit={(event) => {
      event.preventDefault();
      setStatus({ busy: true });
      call(`/api/orders/${encodeURIComponent(orderId)}/deal-card/actions`, { method: "POST", body: JSON.stringify({ action: { type: "PROVIDE_INSTRUCTIONS", instructions: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) } }) })
        .then(() => { setStatus({ done: true }); onDone(); }, (e: Error) => setStatus({ error: e.message }));
    }}>
      <p className="text-xs text-muted-foreground">أدخل فقط ما يحتاجه المشتري للتحويل. لا تُدخل كلمة مرور أو رمز تحقق أو رقم بطاقة.</p>
      {fields.map((field) => (
        <label key={field} className="block text-sm">
          <span className="text-muted-foreground">{FIELD_LABELS[field] ?? field}</span>
          <input dir="auto" autoComplete="off" maxLength={field === "paymentLink" ? 300 : 120} className="mt-1 w-full rounded-lg border bg-background px-3 py-2"
            value={values[field] ?? ""} onChange={(event) => setValues({ ...values, [field]: event.target.value })} />
        </label>
      ))}
      {status.error && <p role="alert" className="text-sm text-red-600">{status.error}</p>}
      <button type="submit" disabled={status.busy} className="rounded-lg border px-3 py-2 text-sm font-medium">حفظ ومشاركة مع المشتري</button>
    </form>
  );
}

export function DealCardPanel({ card: initial, active, onSend }: { card: DealCard; active: boolean; onSend?: (text: string) => void }) {
  const [card, setCard] = useState(initial);
  const refresh = () => { call(`/api/orders/${encodeURIComponent(card.orderId)}/deal-card`).then((next) => isDealCard(next) && setCard(next), () => undefined); };
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
                    <span className="block text-xs font-normal text-muted-foreground">{method.kind === "COD" ? (method.available === false ? "غير متاح لهذا الطلب" : "عند الاستلام") : method.standing === "USER_DECLARED_METHOD" ? "وسيلة يحددها البائع" : "دفع مباشر للبائع"}</span>
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
          {card.agreedMethod.standingLabel && <p className="text-xs text-muted-foreground">{card.agreedMethod.standingLabel}</p>}
          {card.checkout?.note && <p className="text-xs text-muted-foreground">{card.checkout.note}</p>}
          {card.instructionsAvailable && <ProtectedInstructions orderId={card.orderId} />}
          {!card.instructionsAvailable && card.instructionsState !== "NOT_APPLICABLE" && card.viewerRole === "BUYER" && <p className="mt-1 text-xs text-muted-foreground">ستظهر تعليمات الدفع هنا بعد أن يشاركها البائع.</p>}
          {card.viewerRole === "SELLER" && active && card.actions.includes("PROVIDE_INSTRUCTIONS") && card.instructionsState === "SELLER_TO_PROVIDE" && (card.instructionFields?.length ?? 0) > 0 && (
            <InstructionsForm orderId={card.orderId} fields={card.instructionFields!} onDone={refresh} />
          )}
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

      {card.commission && (
        <div className="mt-3 text-sm">
          <p>عمولة JassimAI: <strong dir="ltr">{card.commission.amount} {card.currency}</strong> · مستحق البائع قبل التكاليف الأخرى: <span dir="ltr">{card.commission.sellerNetBeforeOtherCosts}</span></p>
          <p className="text-xs text-muted-foreground">{card.commission.note}</p>
        </div>
      )}

      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{card.notice}</p>
    </section>
  );
}
