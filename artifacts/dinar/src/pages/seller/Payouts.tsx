import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, RefreshCw, ShieldCheck } from "lucide-react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button, ButtonLink } from "@/ui/Button";
import { Field, Input } from "@/ui/Field";
import { EmptyState, ErrorState, InlineAlert, Skeleton, StatusBadge } from "@/ui/Feedback";
import type { Tone } from "@/lib/marketplace";
import { Card, CardTitle, PageHeader } from "@/ui/Layout";

type SellerStatus = "PENDING" | "ONBOARDING" | "VERIFIED" | "RESTRICTED";

type SellerAccount = {
  sellerUserId: string;
  whopAccountId: string;
  status: SellerStatus;
  identityStatus: string;
  verificationStatus: string;
  contactEmail: string;
  countryCode: string;
  verified: boolean;
  lastSyncedAt: string | null;
};

type AccountResponse = {
  enabled: boolean;
  environment?: "sandbox" | "production";
  account: SellerAccount | null;
};

const STATUS: Record<SellerStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "لم يبدأ التحقق", tone: "neutral" },
  ONBOARDING: { label: "التحقق جارٍ", tone: "warning" },
  VERIFIED: { label: "موثّق وجاهز للتحصيل", tone: "success" },
  RESTRICTED: { label: "مقيّد — راجع Whop", tone: "danger" },
};

const accountQueryKey = ["whop-seller-account"] as const;

function useSellerAccount() {
  return useQuery<AccountResponse>({
    queryKey: accountQueryKey,
    queryFn: async () => (await api("/whop/seller/account")) as AccountResponse,
    staleTime: 10_000,
  });
}

/** Compact readiness card for the dues page; renders nothing while card payments are off. */
export function WhopPayoutsCard() {
  const account = useSellerAccount();
  if (account.isLoading || account.isError || !account.data?.enabled) return null;
  const state = account.data.account;
  const status = state ? STATUS[state.status] ?? STATUS.PENDING : null;
  return (
    <Card testId="card-whop-payouts">
      <CardTitle icon={<Banknote size={18} aria-hidden />}>التحصيل عبر Whop</CardTitle>
      {state ? (
        <>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            حساب التحصيل <span dir="ltr" className="num">{state.whopAccountId}</span> — تحقق
            الهوية: {state.identityStatus}، السجل التجاري: {state.verificationStatus}.
          </p>
          {status && (
            <span className="mt-2 block">
              <StatusBadge label={status.label} tone={status.tone} />
            </span>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          لم تربط حساب تحصيل بعد. ابدأ التحقق لتستلم مبيعات البطاقة مباشرة.
        </p>
      )}
      <ButtonLink className="mt-3" href="/seller/payouts" variant="secondary" block>
        {state?.verified ? "إدارة التحصيل والسحب" : "إعداد التحصيل"}
      </ButtonLink>
    </Card>
  );
}

export default function PayoutsPage() {
  const { user, market } = useAccount();
  const queryClient = useQueryClient();
  const account = useSellerAccount();
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState(user?.displayName ?? "");
  const [countryCode, setCountryCode] = useState(user?.accountCountry ?? "");
  const [actionError, setActionError] = useState<string | null>(null);

  const openUrl = (url?: string) => {
    if (url) window.location.assign(url);
  };

  const onboarding = useMutation<{ url?: string }>({
    mutationFn: async () =>
      (await api("/whop/seller/onboarding", "POST", {
        email,
        title,
        countryCode,
      })) as { url?: string },
    onSuccess: async (result) => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: accountQueryKey });
      openUrl(result.url);
    },
    onError: (error) => setActionError(friendlyError(error)),
  });

  const payoutsLink = useMutation<{ url?: string }>({
    mutationFn: async () =>
      (await api("/whop/seller/payouts-link", "POST", {})) as { url?: string },
    onSuccess: (result) => {
      setActionError(null);
      openUrl(result.url);
    },
    onError: (error) => setActionError(friendlyError(error)),
  });

  const refresh = useMutation<{ account: SellerAccount }>({
    mutationFn: async () =>
      (await api("/whop/seller/refresh", "POST", {})) as { account: SellerAccount },
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: accountQueryKey });
    },
    onError: (error) => setActionError(friendlyError(error)),
  });

  const state = account.data?.account ?? null;
  const status = state ? STATUS[state.status] ?? STATUS.PENDING : null;

  return (
    <div className="container-app max-w-3xl">
      <PageHeader
        back="/seller"
        title="التحصيل والسحب"
        subtitle="حساب Whop المرتبط لاستلام مبيعات البطاقة وسحبها"
      />
      {account.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : account.isError ? (
        <ErrorState onRetry={() => account.refetch()} />
      ) : !account.data?.enabled ? (
        <EmptyState
          icon={Banknote}
          title="الدفع بالبطاقة غير مهيأ"
          body="لم تُفعّل بوابة Whop على هذا الخادم بعد. ستظهر هذه الصفحة عند تهيئة بيئة Whop."
          action={<ButtonLink href="/seller/dues" variant="secondary">المستحقات</ButtonLink>}
          testId="state-whop-disabled"
        />
      ) : (
        <div className="space-y-4">
          {account.data.environment === "sandbox" && (
            <InlineAlert tone="info" title="بيئة اختبار">
              هذه بيئة Whop الاختبارية. التحقق والسحب تجريبيان ولا تُحرَّك أموال حقيقية.
            </InlineAlert>
          )}
          {actionError && <InlineAlert tone="danger">{actionError}</InlineAlert>}

          <Card testId="card-whop-account">
            <CardTitle icon={<ShieldCheck size={18} aria-hidden />}>حساب التحصيل</CardTitle>
            {state ? (
              <>
                <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">المعرّف</dt>
                    <dd className="num" dir="ltr">{state.whopAccountId}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">الحالة</dt>
                    <dd><StatusBadge label={status!.label} tone={status!.tone} /></dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">الهوية</dt>
                    <dd className="num" dir="ltr">{state.identityStatus}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">السجل التجاري</dt>
                    <dd className="num" dir="ltr">{state.verificationStatus}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">دولة الحساب</dt>
                    <dd className="num" dir="ltr">{state.countryCode}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">آخر مزامنة</dt>
                    <dd className="num" dir="ltr">{state.lastSyncedAt ?? "—"}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => onboarding.mutate()}
                    loading={onboarding.isPending}
                  >
                    {state.verified ? "تحديث التحقق في Whop" : "متابعة التحقق في Whop"}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<RefreshCw size={16} />}
                    loading={refresh.isPending}
                    onClick={() => refresh.mutate()}
                  >
                    مزامنة الحالة
                  </Button>
                  {state.verified && (
                    <Button
                      variant="success"
                      icon={<Banknote size={18} />}
                      loading={payoutsLink.isPending}
                      onClick={() => payoutsLink.mutate()}
                      data-testid="button-whop-payouts-portal"
                    >
                      فتح بوابة السحب
                    </Button>
                  )}
                </div>
                {!state.verified && (
                  <p className="mt-2 text-2xs text-muted-foreground">
                    يُفتح السحب بعد اعتماد Whop لهوية الحساب. حتى ذلك الحين يُحجب الدفع
                    بالبطاقة على عروضك.
                  </p>
                )}
              </>
            ) : (
              <form
                className="mt-2 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  onboarding.mutate();
                }}
              >
                <p className="text-sm leading-6 text-muted-foreground">
                  يُنشأ حساب تحصيل واحد لكل بائع ويُربط بهويتك في Whop. البريد والاسم
                  التجاري يُستخدمان في التحقق فقط.
                </p>
                <Field label="بريد التحقق">
                  <Input
                    type="email"
                    dir="ltr"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                    data-testid="input-whop-email"
                  />
                </Field>
                <Field label="الاسم التجاري">
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={120}
                    required
                    data-testid="input-whop-title"
                  />
                </Field>
                <Field label="دولة الحساب" hint="رمز من حرفين، مثل JO">
                  <Input
                    dir="ltr"
                    value={countryCode}
                    onChange={(event) => setCountryCode(event.target.value.toUpperCase().slice(0, 2))}
                    maxLength={2}
                    required
                    data-testid="input-whop-country"
                  />
                </Field>
                <Button
                  type="submit"
                  block
                  loading={onboarding.isPending}
                  disabled={!email.trim() || title.trim().length < 2 || countryCode.length !== 2}
                  data-testid="button-whop-onboarding"
                >
                  بدء التحقق
                </Button>
                <p className="text-2xs text-muted-foreground">
                  الدول المحظورة تشمل العراق وإيران وكوريا الشمالية وسوريا وكوبا. لا
                  يمكن التحصيل منها.
                </p>
                {market && (
                  <p className="text-2xs text-muted-foreground">
                    سوقك الحالي: {market.countryNameAr} · العملة {market.currencyCode}
                  </p>
                )}
              </form>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
