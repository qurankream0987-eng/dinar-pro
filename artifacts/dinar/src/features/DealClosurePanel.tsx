/**
 * Deal closure for direct payments (owner-approved design 2026-11-07, answers 2026-11-15).
 * Buyer: sees the 4-digit handover code, can tap «استلمت», or report «لم يتم / أُلغي».
 * Seller: enters the buyer's code, can show a QR that opens the buyer's own orders (fallback when
 * the buyer cannot read the code), can record «تم البيع بدون رمز», or report «لم يتم / أُلغي».
 * Every state and permission comes from GET /orders/:id/closure; the server enforces all of it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, QrCode, CircleCheckBig, CircleX } from "lucide-react";
import {
  getGetOrderClosureQueryKey,
  getGetOrderMessagesQueryKey,
  getGetOrderQueryKey,
  getGetOrdersQueryKey,
  useConfirmOrder,
  useEnterOrderHandoverCode,
  useGetOrderClosure,
  useReportOrderNotCompleted,
  useSellOrderWithoutCode,
} from "@workspace/api-client-react";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Field, Input } from "@/ui/Field";
import { ConfirmDialog } from "@/ui/Sheet";

const CLOSABLE = ["ACCEPTED", "IN_PROGRESS", "SELLER_MARKED_DELIVERED", "DISPUTED"];

export function DealClosurePanel({ orderId, status }: { orderId: string; status: string }) {
  const qc = useQueryClient();
  const enabled = CLOSABLE.includes(status);
  const closure = useGetOrderClosure(orderId, { query: { queryKey: getGetOrderClosureQueryKey(orderId), enabled } }).data;
  const enter = useEnterOrderHandoverCode();
  const sold = useSellOrderWithoutCode();
  const confirm = useConfirmOrder();
  const notDone = useReportOrderNotCompleted();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "sold" | "received" | "NOT_COMPLETED" | "CANCELLED">(null);

  useEffect(() => {
    if (!qr) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setQr(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [qr]);

  if (!enabled || !closure) return null;
  const refresh = () => {
    for (const key of [getGetOrderQueryKey(orderId), getGetOrderClosureQueryKey(orderId), getGetOrderMessagesQueryKey(orderId), getGetOrdersQueryKey()])
      void qc.invalidateQueries({ queryKey: key });
  };
  const done = (message: string) => () => { setDialog(null); setError(""); setCode(""); refresh(); toast.success(message); };
  const failed = (e: unknown) => {
    setDialog(null);
    const status = (e as { status?: number })?.status;
    const remaining = (e as { data?: { attemptsRemaining?: number } })?.data?.attemptsRemaining;
    setError(status === 422 && typeof remaining === "number" ? `الرمز غير صحيح. المحاولات المتبقية: ${remaining}` : friendlyError(e));
    refresh();
  };
  const showQr = async () => {
    try { setQr(await QRCode.toDataURL(`${window.location.origin}/ai?openOrders=1`, { margin: 1, width: 240 })); }
    catch { setError("تعذر إنشاء رمز QR. اطلب من المشتري قراءة الرمز أو تأكيد الاستلام من حسابه."); }
  };
  const isBuyer = closure.role === "BUYER";
  const pending = enter.isPending || sold.isPending || confirm.isPending || notDone.isPending;

  return (
    <section className="rounded-xl border border-border bg-card p-4 md:p-5" aria-labelledby="deal-closure-title" data-testid="panel-deal-closure">
      <h2 id="deal-closure-title" className="mb-2 flex items-center gap-2 text-md font-bold text-foreground">
        <KeyRound size={18} aria-hidden /> إتمام الصفقة
      </h2>

      {isBuyer && closure.handoverCode && (
        <div className="mb-3">
          <p className="text-sm text-text-secondary">رمز التسليم الخاص بك. أعطه للبائع فقط بعد فحص المنتج ودفع المبلغ.</p>
          <p className="num mt-2 text-center text-4xl font-bold tracking-[0.4em]" dir="ltr" data-testid="text-handover-code" aria-label={`رمز التسليم ${closure.handoverCode.split("").join(" ")}`}>
            {closure.handoverCode}
          </p>
        </div>
      )}
      {isBuyer && closure.codeLocked && <p className="mb-3 text-sm" role="status">قُفل رمز التسليم بعد محاولات خاطئة. أكّد الاستلام بنفسك إن استلمت المنتج.</p>}
      {isBuyer && closure.soldWithoutCode && closure.buyerWindowEndsAt && (
        <p className="mb-3 text-sm" role="status" data-testid="text-buyer-window">
          يقول البائع إن البيع تم دون رمز. أكّد الاستلام أو أبلغ عن مشكلة قبل {new Date(closure.buyerWindowEndsAt).toLocaleString("ar")}؛ بعدها تُغلق الصفقة تلقائيًا.
        </p>
      )}

      {!isBuyer && closure.courierHandoff && (
        <p className="text-sm text-text-secondary" role="status" data-testid="text-courier-handoff">
          يسلّم مندوب التوصيل المسند هذا الطلب ويسجّل التسليم. يُغلق الطلب عند تأكيد المشتري الاستلام.
        </p>
      )}
      {!isBuyer && closure.canEnterCode && (
        <>
          <p className="text-sm text-text-secondary">لا تسلّم المنتج قبل استلام المبلغ ورمز التسليم معًا. أدخل الرمز الذي يعطيك إياه المشتري.</p>
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => { event.preventDefault(); setError(""); enter.mutate({ id: orderId, data: { code } }, { onSuccess: done("أُغلقت الصفقة برمز التسليم"), onError: failed }); }}
          >
            <Field label="رمز التسليم" className="flex-1" hint={closure.attemptsRemaining !== null ? `المحاولات المتبقية: ${closure.attemptsRemaining}` : undefined}>
              <Input id="handover-code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={4} dir="ltr"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="0000" data-testid="input-handover-code" />
            </Field>
            <Button type="submit" disabled={code.length !== 4 || pending} loading={enter.isPending} data-testid="button-submit-handover-code">تأكيد الرمز</Button>
          </form>
          <Button variant="secondary" size="sm" className="mt-2" icon={<QrCode size={16} />} onClick={() => void showQr()} data-testid="button-show-confirm-qr">
            المشتري لا يستطيع قراءة الرمز؟ اعرض له QR
          </Button>
        </>
      )}
      {!isBuyer && closure.codeLocked && <p className="mt-2 text-sm" role="status">قُفل الرمز بعد خمس محاولات خاطئة. استخدم «تم البيع بدون رمز».</p>}
      {!isBuyer && closure.soldWithoutCode && closure.buyerWindowEndsAt && (
        <p className="mt-2 text-sm" role="status">بانتظار تأكيد المشتري حتى {new Date(closure.buyerWindowEndsAt).toLocaleString("ar")}؛ بعدها تُغلق الصفقة دون رمز.</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {closure.canConfirmReceipt && status !== "SELLER_MARKED_DELIVERED" && (
          <Button icon={<CircleCheckBig size={16} />} disabled={pending} onClick={() => setDialog("received")} data-testid="button-closure-received">استلمت</Button>
        )}
        {closure.canSellWithoutCode && (
          <Button variant="secondary" disabled={pending} onClick={() => setDialog("sold")} data-testid="button-sold-without-code">تم البيع بدون رمز</Button>
        )}
        {closure.canReportNotCompleted && (
          <>
            <Button variant="secondary" icon={<CircleX size={16} />} disabled={pending} onClick={() => setDialog("NOT_COMPLETED")} data-testid="button-not-completed">لم يتم</Button>
            <Button variant="secondary" disabled={pending} onClick={() => setDialog("CANCELLED")} data-testid="button-closure-cancelled">أُلغي</Button>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-destructive" role="alert" data-testid="text-closure-error">{error}</p>}

      {qr && createPortal(
        <div role="dialog" aria-modal="true" aria-label="رمز QR لتأكيد الاستلام" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setQr(null)}>
          <div className="rounded-xl bg-card p-5 text-center" onClick={(e) => e.stopPropagation()}>
            <img src={qr} alt="رمز QR يفتح طلبات المشتري في حسابه ليؤكد الاستلام" width={240} height={240} className="mx-auto" data-testid="img-confirm-qr" />
            <p className="mt-3 max-w-[240px] text-sm text-text-secondary">يمسحه المشتري بهاتفه فتُفتح طلباته في حسابه، ثم يختار هذا الطلب ويضغط «استلمت».</p>
            <Button className="mt-3" variant="secondary" onClick={() => setQr(null)}>إغلاق</Button>
          </div>
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog === "received" ? "تأكيد الاستلام" : dialog === "sold" ? "تم البيع بدون رمز" : dialog === "CANCELLED" ? "الصفقة أُلغيت" : "الصفقة لم تتم"}
        loading={pending}
        body={
          dialog === "received" ? "تؤكد أنك استلمت المنتج. تُغلق الصفقة وتُسجَّل رسوم جاسم على البائع."
            : dialog === "sold" ? "سيُسأل المشتري. إن لم يرد خلال 48 ساعة تُغلق الصفقة دون رمز، وإن اعترض تُراجع الحالة."
            : "إن وافق الطرف الآخر يُلغى الطلب ويُعاد المخزون دون رسوم؛ وإن لم يوافق تراجع الإدارة الحالة."
        }
        confirmLabel="تأكيد"
        onConfirm={() => {
          if (dialog === "received") confirm.mutate({ id: orderId, data: { received: true } }, { onSuccess: done("أُغلقت الصفقة"), onError: failed });
          else if (dialog === "sold") sold.mutate({ id: orderId }, { onSuccess: done("سُئل المشتري للتأكيد"), onError: failed });
          else if (dialog) notDone.mutate({ id: orderId, data: { outcome: dialog } }, { onSuccess: done("سُجّل ردك"), onError: failed });
        }}
      />
    </section>
  );
}
