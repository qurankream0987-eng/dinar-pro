import {
  getGetSubscriptionPlansQueryKey,
  useGetSubscriptionPlans,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { UsageMeter } from "./surface/primitives";

function count(value: number) {
  return value.toLocaleString("en-US");
}

function renewalLabel(value: string, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "غير متاح";
  try {
    return date.toLocaleString("ar-SA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  } catch {
    return "غير متاح";
  }
}

export function UsageSidebarCard({
  disabled = false,
  onOpenInChat,
  premiumTrialSelected = false,
  onUsePremiumTrial,
}: {
  disabled?: boolean;
  onOpenInChat?: () => void;
  premiumTrialSelected?: boolean;
  onUsePremiumTrial?: () => void;
}) {
  const { user, market } = useAccount();
  const query = useGetSubscriptionPlans({
    query: {
      queryKey: [
        ...getGetSubscriptionPlansQueryKey(),
        user?.id ?? null,
        market?.id ?? null,
      ],
      enabled: Boolean(user?.id && market?.id),
      staleTime: 15_000,
      refetchOnMount: "always",
      refetchInterval: user?.id ? 60_000 : false,
    },
  });

  if (!user) {
    return (
      <section
        className="mx-3 my-2 rounded-xl border border-border bg-card px-3 py-2 text-xs leading-5 text-muted-foreground"
        data-testid="sidebar-account-usage"
      >
        سجّل الدخول لعرض باقتك واستخدامك.
      </section>
    );
  }

  if (!market) {
    return (
      <div
        className="mx-3 my-2 rounded-xl border border-border bg-card px-3 py-2 text-xs leading-5 text-muted-foreground"
        data-testid="sidebar-account-usage-no-market"
      >
        اختر سوقًا لعرض استخدامك.
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div
        className="mx-3 my-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
        aria-busy="true"
        data-testid="sidebar-account-usage-loading"
      >
        جارٍ تحميل استخدامك…
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <button
        type="button"
        className="mx-3 my-2 rounded-xl border border-border bg-card px-3 py-2 text-start text-xs leading-5 text-muted-foreground hover:bg-muted"
        onClick={() => void query.refetch()}
        data-testid="sidebar-account-usage-error"
      >
        تعذر تحميل استخدامك. اضغط للمحاولة مجددًا.
      </button>
    );
  }

  const overview = query.data;
  const resources = overview.usage.resources.filter((item) => item.included);
  const premiumTrial = overview.usage.premiumTrial;

  return (
    <details
      className="mx-3 my-2 rounded-xl border border-border bg-card text-sm"
      data-testid="sidebar-account-usage"
    >
      <summary className="cursor-pointer list-inside px-3 py-2.5 font-semibold">
        <span>{overview.currentPlanLabel}</span>
        <span className="ms-1 text-xs font-normal text-muted-foreground">
          · استخدامك
        </span>
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">
        <p className="text-xs leading-5 text-muted-foreground">
          تتجدد الحصة{" "}
          {renewalLabel(overview.usage.renewsAt, overview.usage.timeZone)}
        </p>
        {resources.map((item) => (
          <div key={item.resource} className="space-y-1">
            <UsageMeter
              label={item.label}
              used={item.used}
              limit={item.limit}
              testId={`sidebar-usage-${item.resource.toLowerCase()}`}
            />
            <p className="text-xs text-muted-foreground">
              المتبقي: {count(item.remaining)} من {count(item.limit)}
            </p>
          </div>
        ))}
        {premiumTrial?.eligible && (
          <div className="space-y-1" data-testid="sidebar-premium-trial">
            <UsageMeter
              label="رسائل التجربة المميزة"
              used={premiumTrial.used}
              limit={premiumTrial.limit}
              testId="sidebar-usage-premium-trial"
            />
            <p className="text-xs text-muted-foreground">
              المتبقي: {count(premiumTrial.remaining)} من{" "}
              {count(premiumTrial.limit)}
              {premiumTrial.inProgress
                ? ` · ${count(premiumTrial.inProgress)} قيد المعالجة`
                : ""}
              {premiumTrial.status === "DISABLED"
                ? " · غير مفعّلة حاليًا"
                : ""}
            </p>
            {premiumTrial.status === "AVAILABLE" &&
              premiumTrial.enabled &&
              onUsePremiumTrial && (
              <button
                type="button"
                className="w-full rounded-lg border border-primary/30 px-2 py-1.5 text-start text-xs font-semibold text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={disabled || premiumTrialSelected}
                onClick={onUsePremiumTrial}
                data-testid="sidebar-use-premium-trial"
              >
                {premiumTrialSelected
                  ? "سيُستخدم رصيد التجربة في رسالتك التالية"
                  : "استخدم رسالة تجريبية مميزة"}
              </button>
            )}
          </div>
        )}
        <div className="space-y-1">
          <UsageMeter
            label="معالجة الذكاء (الرموز)"
            used={overview.usage.tokens.used}
            limit={overview.usage.tokens.limit}
            testId="sidebar-usage-tokens"
          />
          <p className="text-xs text-muted-foreground">
            المتبقي: {count(overview.usage.tokens.remaining)} من{" "}
            {count(overview.usage.tokens.limit)}
          </p>
        </div>
        {overview.approvals.note && (
          <p className="text-xs leading-5 text-muted-foreground">
            {overview.approvals.note}
          </p>
        )}
        <p
          className="text-xs leading-5 text-muted-foreground"
          data-testid="sidebar-billing-status"
        >
          {overview.billing.note}
        </p>
        {overview.billing.status === "NOT_CONNECTED" && (
          <p className="text-xs leading-5 text-muted-foreground">
            الفوترة الحقيقية غير متصلة، ولا يتوفر سجل فواتير الاشتراك هنا.
          </p>
        )}
        {onOpenInChat && (
          <button
            type="button"
            className="w-full rounded-lg px-2 py-1.5 text-start text-xs font-semibold text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            onClick={onOpenInChat}
            data-testid="sidebar-usage-open-chat"
          >
            اعرض التفاصيل في المحادثة
          </button>
        )}
      </div>
    </details>
  );
}
