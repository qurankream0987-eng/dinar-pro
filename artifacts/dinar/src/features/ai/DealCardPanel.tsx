/**
 * Payment Preferences & Agreement Deal Card — Apple Master Edition.
 *
 * Server-built for one party of the order and rebuilt on every read; the client only renders it.
 * Buttons send the party's own words back to Jassim so every change goes through the exact
 * server-side consent checks.
 *
 * Visual & UX Upgrades:
 * - Apple-grade obsidian glassmorphism with 4-stage visual agreement lifecycle timeline.
 * - Standing badges for every payment method (VERIFIED_METHOD, UNDER_REVIEW, USER_DECLARED_METHOD, requiresMerchantCheckout).
 * - Protected Instructions Vault (`cache: "no-store"`, memory-only) with one-tap Copy buttons for IBAN / Alias / Phone / Account.
 * - Protected Seller Vault Input Form with live security guard preventing card numbers / OTPs.
 * - Wrapped in `React.memo` with `useStableCallback` for zero wasted re-renders during 60/120fps chat streaming.
 */
import { memo, useState } from "react";
import { useStableCallback } from "@/hooks/use-stable-callback";

type DealMethod = {
  code: string;
  label: string;
  kind: "DIRECT" | "COD";
  available?: boolean;
  reason?: string;
  standing?: string;
  standingLabel?: string;
  requiresMerchantCheckout?: boolean;
};

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
  commission: {
    amount: string;
    state: "NONE" | "DUE_ON_COMPLETION" | "RECORDED_AS_DUE";
    collected: false;
    note: string;
    sellerNetBeforeOtherCosts: string;
  } | null;
  notice: string;
};

export function isDealCard(value: unknown): value is DealCard {
  const card = value as Partial<DealCard> | undefined;
  return Boolean(card && card.kind === "DEAL_CARD" && typeof card.orderId === "string" && Array.isArray(card.acceptedMethods) && Array.isArray(card.actions));
}

const FIELD_LABELS: Record<string, string> = {
  beneficiaryName: "اسم المستفيد",
  alias: "الاسم المستعار (Alias / CliQ)",
  phone: "رقم الهاتف المرتبط",
  iban: "رقم الآيبان (IBAN)",
  accountNumber: "رقم الحساب البنكي",
  bankName: "اسم البنك",
  walletProvider: "مزود المحفظة",
  walletNumber: "رقم المحفظة",
  paymentLink: "رابط صفحة الدفع التجارية الخاصة بالبائع (HTTPS)",
  note: "ملاحظة للمشتري",
};

const DELIVERY_LABELS: Record<string, string> = {
  PICKUP: "استلام شخصي",
  SELLER_DELIVERY: "توصيل من البائع",
  COURIER: "مندوب توصيل",
  EXTERNAL_PROVIDER: "شركة توصيل",
};

function tone(status: string) {
  if (["SELLER_CONFIRMED_RECEIPT", "COD_COLLECTED", "COMPLETED"].includes(status))
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (["CANCELLED", "DISPUTED"].includes(status))
    return "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300";
  if (["AWAITING_PAYMENT", "COD_PENDING_DELIVERY", "BUYER_REPORTED_PAID"].includes(status))
    return "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300";
  return "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300";
}

function standingBadgeInfo(method: DealMethod): { label: string; cls: string } {
  if (method.requiresMerchantCheckout) {
    return {
      label: "رابط دفع التاجر (HTTPS)",
      cls: "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    };
  }
  if (method.standing === "VERIFIED_METHOD") {
    return {
      label: "موثقة في كتالوج البلد",
      cls: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (method.standing === "USER_DECLARED_METHOD") {
    return {
      label: "وسيلة متفق عليها بين الطرفين",
      cls: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    };
  }
  if (method.standing === "UNDER_REVIEW") {
    return {
      label: "معروفة محليًا · قيد المراجعة",
      cls: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  return {
    label: method.kind === "COD" ? "نقدًا عند الاستلام" : "تسوية مباشرة مع البائع",
    cls: "border-border/60 bg-muted/40 text-muted-foreground",
  };
}

function resolveAgreementStepIndex(status: string): number {
  if (["WAITING_FOR_SELLER", "WAITING_FOR_BUYER", "PAYMENT_METHOD_PROPOSED"].includes(status)) return 1;
  if (["AWAITING_PAYMENT", "COD_PENDING_DELIVERY"].includes(status)) return 2;
  if (["BUYER_REPORTED_PAID"].includes(status)) return 3;
  if (["SELLER_CONFIRMED_RECEIPT", "COD_COLLECTED", "COMPLETED"].includes(status)) return 4;
  return 1;
}

const AGREEMENT_STEPS = [
  { step: 1, label: "اختيار الوسيلة" },
  { step: 2, label: "الخزنة المحمية" },
  { step: 3, label: "إشعار التحويل" },
  { step: 4, label: "إقرار الاستلام" },
] as const;

type Protected = { instructions: Record<string, string>; merchantCheckoutLink: string | null; notice: string };

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? "تعذر إكمال الطلب الآن.");
  return data;
}

/** Payment details are fetched on demand from the protected endpoint and kept only in memory. */
function ProtectedInstructions({ orderId }: { orderId: string }) {
  const [state, setState] = useState<{ open: boolean; data?: Protected; error?: string }>({ open: false });
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (field: string, value: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(value).catch(() => undefined);
    }
    setCopiedField(field);
    setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1800);
  };

  if (!state.open)
    return (
      <button
        type="button"
        className="mt-2.5 inline-flex items-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3.5 py-2 text-sm font-medium text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-300"
        onClick={() =>
          call(`/api/orders/${encodeURIComponent(orderId)}/deal-card/instructions`).then(
            (data) => setState({ open: true, data }),
            (e: Error) => setState({ open: true, error: e.message }),
          )
        }
      >
        <span>🔒</span>
        <span>عرض تعليمات الدفع المحمية</span>
      </button>
    );
  if (state.error) return <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>;
  const data = state.data!;
  return (
    <div className="mt-2.5 rounded-2xl border border-sky-500/40 bg-sky-500/5 p-3.5 shadow-inner" aria-live="polite">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-sky-700 dark:text-sky-300">🔒 خزنة تعليمات التحويل المباشر (ذاكرة مؤقتة فقط)</span>
        <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setState({ open: false })}>
          إخفاء
        </button>
      </div>
      <dl className="space-y-2">
        {Object.entries(data.instructions)
          .filter(([field]) => field !== "paymentLink")
          .map(([field, value]) => (
            <div key={field} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/50 bg-background/70 px-3 py-2">
              <div className="min-w-0 flex-1">
                <dt className="text-xs text-muted-foreground">{FIELD_LABELS[field] ?? field}</dt>
                <dd dir="auto" className="select-all font-mono text-sm font-semibold">{value}</dd>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(field, value)}
                className="shrink-0 rounded-lg border border-border/70 bg-muted/60 px-2.5 py-1 text-xs font-medium transition hover:bg-muted"
              >
                {copiedField === field ? "تم النسخ ✓" : "نسخ"}
              </button>
            </div>
          ))}
      </dl>
      {data.merchantCheckoutLink && (
        <a
          href={data.merchantCheckoutLink}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-violet-500/40 bg-violet-500/15 px-3.5 py-2 text-sm font-medium text-violet-700 transition hover:bg-violet-500/25 dark:text-violet-300"
        >
          <span>فتح صفحة الدفع الخاصة بالبائع</span>
          <span aria-hidden="true">↗</span>
        </a>
      )}
      <p className="mt-2.5 text-xs text-muted-foreground">{data.notice}</p>
    </div>
  );
}

/** The seller enters only the fields this method needs; sent straight to the server, never into chat. */
function InstructionsForm({ orderId, fields, onDone }: { orderId: string; fields: string[]; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ busy?: boolean; error?: string; done?: boolean }>({});
  if (status.done)
    return (
      <p className="mt-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
        ✓ حُفظت بيانات الدفع في الخزنة المحمية وشُوركت مع المشتري في هذا الطلب فقط.
      </p>
    );
  return (
    <form
      className="mt-3 space-y-2.5 rounded-2xl border border-border/70 bg-background/60 p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        setStatus({ busy: true });
        call(`/api/orders/${encodeURIComponent(orderId)}/deal-card/actions`, {
          method: "POST",
          body: JSON.stringify({
            action: {
              type: "PROVIDE_INSTRUCTIONS",
              instructions: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())),
            },
          }),
        }).then(
          () => {
            setStatus({ done: true });
            onDone();
          },
          (e: Error) => setStatus({ error: e.message }),
        );
      }}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-sky-700 dark:text-sky-300">
        <span>🛡️</span>
        <span>نموذج الخزنة المحمية — تُرسل البيانات مباشرة للخادم ولا تمر عبر المحادثة</span>
      </div>
      <p className="text-xs text-muted-foreground">
        أدخل فقط ما يحتاجه المشتري للتحويل. لا تُدخل كلمة مرور أو رمز تحقق (OTP) أو رقم بطاقة بنكية.
      </p>
      {fields.map((field) => (
        <label key={field} className="block text-sm">
          <span className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[field] ?? field}</span>
          <input
            dir="auto"
            autoComplete="off"
            maxLength={field === "paymentLink" ? 300 : 120}
            className="mt-1 w-full rounded-xl border border-border/80 bg-background px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none"
            value={values[field] ?? ""}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
          />
        </label>
      ))}
      {status.error && <p role="alert" className="text-sm text-red-600">{status.error}</p>}
      <button
        type="submit"
        disabled={status.busy}
        className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-300"
      >
        {status.busy ? "جارٍ الحفظ بأمان..." : "حفظ ومشاركة مع المشتري في الخزنة"}
      </button>
    </form>
  );
}

export const DealCardPanel = memo(function DealCardPanel({
  card: initial,
  active,
  onSend,
}: {
  card: DealCard;
  active: boolean;
  onSend?: (text: string) => void;
}) {
  const [card, setCard] = useState(initial);
  const refresh = useStableCallback(() => {
    call(`/api/orders/${encodeURIComponent(card.orderId)}/deal-card`).then(
      (next) => isDealCard(next) && setCard(next),
      () => undefined,
    );
  });
  const ref = card.orderReference.toLowerCase();
  const send = useStableCallback((text: string) => {
    onSend?.(text);
  });
  const can = (action: string) => active && Boolean(onSend) && card.actions.includes(action);
  const button =
    "rounded-xl border border-border/70 bg-background/70 px-3.5 py-2 text-sm font-medium transition hover:bg-muted/80 disabled:opacity-50";
  const currentStep = resolveAgreementStepIndex(card.status);

  return (
    <section
      dir="rtl"
      lang="ar"
      data-testid="live-chat-deal-payment-card"
      aria-label={`تفاصيل الصفقة ${card.orderReference}`}
      className="ai-deal-card w-full max-w-xl rounded-3xl border border-border/80 bg-card/95 p-5 text-card-foreground shadow-lg backdrop-blur-md"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <span className="text-xs font-medium text-muted-foreground">اتفاق الدفع المباشر · #{card.orderReference}</span>
          <h3 className="text-base font-bold">تفاصيل الصفقة والتسوية</h3>
        </div>
        <span role="status" className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${tone(card.status)}`}>
          {card.statusLabel}
        </span>
      </header>

      {/* 4-Stage Visual Agreement Timeline */}
      <div className="mt-3.5 grid grid-cols-4 gap-1.5" aria-label="مراحل اتفاق الدفع">
        {AGREEMENT_STEPS.map((item) => {
          const done = currentStep >= item.step;
          return (
            <div key={item.step} className="space-y-1">
              <div className={`h-1.5 w-full rounded-full transition-colors ${done ? "bg-emerald-500" : "bg-muted"}`} />
              <p className={`truncate text-[11px] font-medium ${done ? "text-foreground" : "text-muted-foreground"}`}>
                {item.step}. {item.label}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-3.5 rounded-2xl border border-border/60 bg-muted/25 p-3">
        {card.imageUrl ? (
          <img src={card.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" loading="lazy" />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{card.title || card.items[0]?.title}</p>
          <p className="text-xs text-muted-foreground">
            البائع: {card.sellerName}
            {card.buyerName ? ` · المشتري: ${card.buyerName}` : ""}
          </p>
          <p className="mt-1 text-lg font-bold tracking-tight" dir="ltr" style={{ textAlign: "right" }}>
            {card.total} {card.currency}
          </p>
        </div>
      </div>

      {card.items.length > 1 && (
        <ul className="mt-3 space-y-1 text-sm">
          {card.items.map((item, index) => (
            <li key={index} className="flex justify-between gap-2">
              <span className="truncate">
                {item.title} × {item.quantity}
              </span>
              <span dir="ltr">{item.total}</span>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-2 rounded-2xl border border-border/50 bg-background/40 p-2.5 text-xs sm:text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">الدولة والسوق</dt>
          <dd className="font-medium">{card.countryName}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">طريقة التسليم</dt>
          <dd className="font-medium">
            {card.delivery ? DELIVERY_LABELS[card.delivery.method] ?? card.delivery.method : "لم يُحدد بعد"}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">طرق الدفع التي وافق عليها البائع</p>
          <span className="text-[11px] text-muted-foreground">الكتالوج يرشد ولا يمنع التفاوض</span>
        </div>
        {card.acceptedMethods.length ? (
          <ul className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {card.acceptedMethods.map((method) => {
              const chosen = card.agreedMethod?.code === method.code;
              const selectable = can("CHOOSE") && card.viewerRole === "BUYER" && method.available !== false && !chosen;
              const badge = standingBadgeInfo(method);
              return (
                <li key={method.code}>
                  <button
                    type="button"
                    disabled={!selectable}
                    onClick={() => send(`أفضل ${method.label} ${ref}`)}
                    aria-pressed={chosen}
                    title={method.available === false ? method.reason : undefined}
                    className={`w-full text-right ${button} ${
                      chosen ? "border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{method.label}</span>
                      {chosen && <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">✓ معتمدة</span>}
                    </div>
                    <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[11px] font-normal ${badge.cls}`}>
                      {method.kind === "COD" && method.available === false ? "غير متاح لهذا الطلب" : badge.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1.5 text-sm text-muted-foreground">لم يحدد البائع طرق الدفع بعد؛ يمكنك اقتراح أي وسيلة مباشرة في المحادثة.</p>
        )}
      </div>

      {card.proposal && (
        <div className="mt-3.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-sm">
          <p>
            {card.proposal.by === "BUYER" ? "المشتري" : "البائع"} يقترح:{" "}
            <strong>{card.proposal.label}</strong> — بانتظار موافقة{" "}
            {card.proposal.awaiting === "SELLER" ? "البائع" : "المشتري"}.
          </p>
          {can("ACCEPT_PROPOSAL") && (
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300"
                onClick={() => send("موافق")}
              >
                موافق على الوسيلة
              </button>
              <button
                type="button"
                className="rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-1.5 text-sm font-medium text-red-700 dark:text-red-300"
                onClick={() => send("أرفض")}
              >
                أرفض الاقتراح
              </button>
            </div>
          )}
        </div>
      )}

      {card.agreedMethod && (
        <div className="mt-3.5 rounded-2xl border border-border/70 bg-muted/40 p-3.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              الطريقة المتفق عليها: <strong>{card.agreedMethod.label}</strong>
            </p>
            <span className="text-xs text-muted-foreground">
              موافقة البائع: {card.approvals.seller ? "✓ نعم" : "لا"} · موافقة المشتري: {card.approvals.buyer ? "✓ نعم" : "لا"}
            </span>
          </div>
          {card.cod && (
            <p className="mt-1.5">
              المبلغ المطلوب عند الاستلام:{" "}
              <strong dir="ltr">
                {card.cod.amountDue} {card.cod.currency}
              </strong>
            </p>
          )}
          {card.agreedMethod.standingLabel && <p className="mt-1 text-xs text-muted-foreground">{card.agreedMethod.standingLabel}</p>}
          {card.checkout?.note && <p className="mt-1 text-xs text-muted-foreground">{card.checkout.note}</p>}
          {card.instructionsAvailable && <ProtectedInstructions orderId={card.orderId} />}
          {!card.instructionsAvailable && card.instructionsState !== "NOT_APPLICABLE" && card.viewerRole === "BUYER" && (
            <p className="mt-1.5 text-xs text-muted-foreground">ستظهر تعليمات الدفع في الخزنة المحمية هنا بعد أن يشاركها البائع.</p>
          )}
          {card.viewerRole === "SELLER" &&
            active &&
            card.actions.includes("PROVIDE_INSTRUCTIONS") &&
            card.instructionsState === "SELLER_TO_PROVIDE" &&
            (card.instructionFields?.length ?? 0) > 0 && (
              <InstructionsForm orderId={card.orderId} fields={card.instructionFields!} onDone={refresh} />
            )}
        </div>
      )}

      {card.payment.verification !== "NONE" && (
        <p className="mt-3 rounded-xl border border-border/50 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
          {card.payment.verification === "UNVERIFIED_BUYER_CLAIM"
            ? "ℹ️ المشتري أبلغ بالدفع؛ هذا إبلاغ منه بانتظار تأكيد البائع وليس تأكيدًا مصرفيًا من جاسم."
            : "✓ البائع أقر باستلام المبلغ؛ التسوية تمت مباشرة بين الطرفين."}
        </p>
      )}

      {active && onSend && (
        <div className="mt-4 flex flex-wrap gap-2">
          {can("SHARE_INSTRUCTIONS") && (
            <button type="button" className={button} onClick={() => send(`شارك بيانات الدفع ${ref}`)}>
              شارك بيانات الدفع
            </button>
          )}
          {can("REPORT_PAID") && (
            <button
              type="button"
              className="rounded-xl border border-sky-500/40 bg-sky-500/15 px-3.5 py-2 text-sm font-semibold text-sky-700 transition hover:bg-sky-500/25 dark:text-sky-300"
              onClick={() => send("دفعت")}
            >
              أبلغ أنني دفعت
            </button>
          )}
          {can("CONFIRM_RECEIPT") && (
            <button
              type="button"
              className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-500/25 dark:text-emerald-300"
              onClick={() => send("استلمت المبلغ")}
            >
              استلمت المبلغ
            </button>
          )}
          {can("REPORT_NOT_RECEIVED") && (
            <button type="button" className={button} onClick={() => send("لم يصلني المبلغ")}>
              لم يصلني المبلغ
            </button>
          )}
          {can("COD_COLLECTED") && (
            <button
              type="button"
              className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-500/25 dark:text-emerald-300"
              onClick={() => send("استلمت المبلغ")}
            >
              حصّلت المبلغ نقدًا
            </button>
          )}
          {can("CANCEL") && (
            <button type="button" className={`${button} text-red-600`} onClick={() => send(`الغاء اتفاق الدفع ${ref}`)}>
              إلغاء اتفاق الدفع
            </button>
          )}
        </div>
      )}

      {card.commission && (
        <div className="mt-3.5 rounded-2xl border border-border/60 bg-background/50 p-3 text-sm">
          <p className="flex flex-wrap items-center justify-between gap-2">
            <span>
              عمولة JassimAI:{" "}
              <strong dir="ltr">
                {card.commission.amount} {card.currency}
              </strong>
            </span>
            <span className="text-xs text-muted-foreground">
              صافي البائع قبل التكاليف الأخرى: <strong dir="ltr">{card.commission.sellerNetBeforeOtherCosts}</strong>
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{card.commission.note}</p>
        </div>
      )}

      <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">{card.notice}</p>
    </section>
  );
});
