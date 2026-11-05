import { useCallback, useEffect, useState } from "react";
import {
  ConnectPartnerReportSchema,
  ConnectFinancialReceiptSchema,
  type ConnectPartnerReport,
  type ConnectExternalTransaction,
} from "@workspace/api-zod/connect-platform";
import { currencyScale } from "@workspace/global";
import { api } from "@/account/Account";
import { Button } from "@/ui/Button";
const states: Record<ConnectExternalTransaction["state"], string> = {
  PENDING_VERIFICATION: "بانتظار التحقق",
  VERIFIED: "تحويل موثّق بالمحاكاة",
  APPROVED: "عمولة معتمدة بالمحاكاة",
  PAYABLE: "مستحقة بالمحاكاة",
  SETTLED: "تسوية اصطناعية مراجعة",
  REVERSED: "عمولة معكوسة",
  DISPUTED: "قيد النزاع",
  REJECTED: "مرفوضة",
};
function totalMoney(minor: string, scale: number, currency: string) {
  const amount = BigInt(minor),
    base = 10n ** BigInt(scale);
  return `${new Intl.NumberFormat("ar", { numberingSystem: "latn" }).format(amount / base)}${scale ? "." + (amount % base).toString().padStart(scale, "0") : ""} ${currency}`;
}
export function ConnectDashboard({
  partnerId,
  admin = false,
}: {
  partnerId: string;
  admin?: boolean;
}) {
  const [report, setReport] = useState<ConnectPartnerReport | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [evidenceReference, setEvidenceReference] = useState(""),
    [providerEventId, setProviderEventId] = useState("");
  const endpoint = `${admin ? "/admin" : ""}/connect/partners/${partnerId}/report`;
  const load = useCallback(
    async (cursor?: string) =>
      setReport(
        ConnectPartnerReportSchema.parse(
          await api(
            endpoint + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
          ),
        ),
      ),
    [endpoint],
  );
  useEffect(() => {
    setReport(null);
    setError("");
    void load().catch((e) => setError(e.message));
  }, [load]);
  const finance = async (
    transaction: ConnectExternalTransaction,
    action: string,
    resolution?: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const receipt = ConnectFinancialReceiptSchema.parse(
        await api(
          `/admin/connect/transactions/${transaction.id}/finance`,
          "POST",
          {
            action,
            idempotencyKey: crypto.randomUUID(),
            evidenceReference,
            ...(action === "RECONCILE_SIMULATED_SETTLEMENT"
              ? { providerEventId }
              : {}),
            ...(resolution ? { resolution } : {}),
          },
        ),
      );
      await load();
      setMessage(
        `حفظ الخادم القرار: ${states[receipt.transaction.state]}. لم يُسجّل استلام مال حقيقي.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر القرار");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border p-4"
      data-testid="connect-dashboard"
    >
      <h2 className="font-bold">تقرير التجارة الخارجية</h2>
      <p className="text-sm">
        تقديرات العمولة غير الموثقة غير متاحة. الإحالة لا تعني شراءً، والتسوية
        الاصطناعية لا تثبت استلام أموال حقيقية.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => void load().catch((e) => setError(e.message))}
      >
        تحديث التقرير
      </Button>
      {report && (
        <>
          <p className="text-sm">
            العروض: {report.counts.offers}؛ إحالات أُعدّت بموافقة:{" "}
            {report.counts.preparedConsentedReferrals}
          </p>
          {report.totals.length === 0 && (
            <p>لا توجد عمولات موثّقة أو تسويات لهذا الحساب.</p>
          )}
          {report.totals.map((total) => (
            <dl
              key={total.currency + total.mode}
              className="space-y-2 rounded-lg border p-3 text-sm"
            >
              <dt className="font-bold">
                {total.currency} —{" "}
                {total.mode === "SIMULATION_ONLY" ? "محاكاة" : "غير متحقق حيًا"}
              </dt>
              {(
                [
                  ["earnedMinor", "عمولة موثّقة"],
                  ["approvedMinor", "عمولة معتمدة"],
                  ["payableMinor", "مستحقة بعد المراجعة"],
                  ["simulatedSettledMinor", "تسويات اصطناعية تاريخية"],
                  ["recoveryDueMinor", "التزام استرداد مستقل"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex flex-wrap justify-between gap-2">
                  <dt>{label}</dt>
                  <dd dir="ltr">
                    {totalMoney(
                      total[key],
                      total.minorUnitScale,
                      total.currency,
                    )}
                  </dd>
                </div>
              ))}
              <div>
                <dt>أموال حقيقية مستلمة</dt>
                <dd>
                  {total.actuallyReceivedMinor === null
                    ? "غير متحقق"
                    : totalMoney(
                        total.actuallyReceivedMinor,
                        total.minorUnitScale,
                        total.currency,
                      )}
                </dd>
              </div>
            </dl>
          ))}
          {admin && (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm">
                كل قرار أدناه مستقل وبالمحاكاة فقط، ويعاد التحقق منه في الخادم.
                أدخل مرجع الدليل أولًا؛ لا تُدخل رمز وصول أو بيانات عميل.
              </p>
              <label className="block">
                مرجع الدليل
                <input
                  className="min-h-11 w-full rounded-lg border bg-background p-2"
                  dir="ltr"
                  value={evidenceReference}
                  onChange={(e) => setEvidenceReference(e.target.value)}
                  pattern="[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}"
                  maxLength={200}
                />
              </label>
              <label className="block">
                معرّف حدث ادعاء التسوية لدى المزوّد
                <input
                  className="min-h-11 w-full rounded-lg border bg-background p-2"
                  dir="ltr"
                  value={providerEventId}
                  onChange={(e) => setProviderEventId(e.target.value)}
                  maxLength={100}
                />
              </label>
            </div>
          )}
          {report.transactions.map((transaction) => (
            <article
              key={transaction.id}
              className="space-y-2 rounded-lg border p-3"
            >
              <h3 className="break-all font-bold">{transaction.externalId}</h3>
              <p>{states[transaction.state]}</p>
              <p className="text-sm">
                مبلغ المعاملة:{" "}
                {totalMoney(
                  String(transaction.grossMinor),
                  currencyScale(transaction.currency),
                  transaction.currency,
                )}
                ؛ استرداد المشتري المثبت:{" "}
                {totalMoney(
                  String(transaction.refundedMinor),
                  currencyScale(transaction.currency),
                  transaction.currency,
                )}
                ؛ عمولة حالية:{" "}
                {totalMoney(
                  String(transaction.balances.earnedMinor),
                  currencyScale(transaction.currency),
                  transaction.currency,
                )}
              </p>
              {admin && (
                <div className="flex flex-wrap gap-2">
                  {transaction.state === "APPROVED" && (
                    <Button
                      disabled={
                        busy ||
                        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/.test(
                          evidenceReference,
                        )
                      }
                      onClick={() => void finance(transaction, "MARK_PAYABLE")}
                    >
                      مراجعة وإثبات الاستحقاق بالمحاكاة
                    </Button>
                  )}
                  {transaction.state === "PAYABLE" && (
                    <Button
                      disabled={
                        busy ||
                        !providerEventId ||
                        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/.test(
                          evidenceReference,
                        )
                      }
                      onClick={() =>
                        void finance(
                          transaction,
                          "RECONCILE_SIMULATED_SETTLEMENT",
                        )
                      }
                    >
                      مراجعة ادعاء المزوّد وتسويته اصطناعيًا
                    </Button>
                  )}
                  {!["REVERSED", "DISPUTED", "REJECTED"].includes(
                    transaction.state,
                  ) && (
                    <Button
                      variant="secondary"
                      disabled={
                        busy ||
                        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/.test(
                          evidenceReference,
                        )
                      }
                      onClick={() => void finance(transaction, "OPEN_DISPUTE")}
                    >
                      فتح نزاع وتجميد المستحق
                    </Button>
                  )}
                  {transaction.state === "DISPUTED" && (
                    <>
                      {(["RESTORE_SUPPORTED_STATE", "REVERSE"] as const).map(
                        (resolution) => (
                          <Button
                            key={resolution}
                            variant="secondary"
                            disabled={
                              busy ||
                              !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/.test(
                                evidenceReference,
                              )
                            }
                            onClick={() =>
                              void finance(
                                transaction,
                                "RESOLVE_DISPUTE",
                                resolution,
                              )
                            }
                          >
                            {resolution === "REVERSE"
                              ? "تسوية النزاع بعكس العمولة"
                              : "تسوية النزاع باستعادة الحالة المدعومة"}
                          </Button>
                        ),
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
          {report.nextCursor && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void load(report.nextCursor!).catch((e) => setError(e.message))
              }
            >
              الصفحة التالية
            </Button>
          )}
          <p className="text-sm">{report.disclosure}</p>
        </>
      )}
    </section>
  );
}
