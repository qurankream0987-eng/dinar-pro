import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useSearch } from "wouter";
import {
  Bell,
  Camera,
  ChevronLeft,
  Coins,
  FileText,
  Globe2,
  HelpCircle,
  Info,
  LifeBuoy,
  LogOut,
  Mail,
  MapPin,
  Moon,
  ReceiptText,
  ShieldCheck,
  Store,
  Sun,
  SunMoon,
  Tag,
  Shield,
  UserRound,
} from "lucide-react";
import {
  getGetAccountEmailQueryKey,
  getGetAccountPrivacyPreferencesQueryKey,
  useConfirmAccountEmailVerification,
  useGetAccountEmail,
  useGetAccountPrivacyPreferences,
  useGetDashboard,
  useRemoveAccountEmail,
  useRequestAccountEmailVerification,
  useUpdateAccountPrivacyPreferences,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, useAccount } from "@/account/Account";
import { usePolicyIndex } from "@/pages/Policies";
import {ConnectAttributionPrivacy} from "@/features/ConnectAttributionPrivacy";
import { AdPersonalizationSettings } from "@/features/AdPersonalizationSettings";
import { friendlyError } from "@/lib/errors";
import { longDate } from "@/lib/format";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { Button, iconButtonClass } from "@/ui/Button";
import { Segmented, Field, Input } from "@/ui/Field";
import { Badge, InlineAlert, ErrorState, Skeleton } from "@/ui/Feedback";
import { ListGroup, ListRow, PageHeader } from "@/ui/Layout";
import { Avatar, BrandMark, Flag } from "@/ui/Media";
import { ConfirmDialog } from "@/ui/Sheet";
import { useMarketSheet } from "@/features/MarketSelector";
import { useActionableOrders } from "@/features/AppShell";
import { OrderCard } from "@/features/OrderCard";
import { EmptyState } from "@/ui/Feedback";
import { ButtonLink } from "@/ui/Button";

function countryName(
  code: string,
  markets: { countryCode: string; countryNameAr: string }[],
) {
  return markets.find((m) => m.countryCode === code)?.countryNameAr ?? code;
}

/* ---------------------------------------------------------------- Profile */

export function ProfilePage() {
  const { user, market, markets, logout, refresh } = useAccount();
  const dashboard = useGetDashboard();
  const { open } = useMarketSheet();
  const [error, setError] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    },
    [avatarPreview],
  );
  if (!user) return null;
  const d = dashboard.data;

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setAvatarError("اختر صورة JPEG أو PNG أو WebP.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError("يجب ألا يتجاوز حجم الصورة 5 ميغابايت.");
      return;
    }

    setAvatarError("");
    setAvatarBusy(true);
    setAvatarPreview(URL.createObjectURL(file));
    try {
      const upload = await api("/account/profile-avatar/upload-url", "POST", {
        size: file.size,
        contentType: file.type,
      });
      const uploaded = await fetch(upload.uploadURL, {
        method: "PUT",
        credentials: "omit",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploaded.ok) throw new Error("تعذر رفع الصورة. حاول مرة أخرى.");
      await api("/account/profile-avatar", "PUT", {
        objectPath: upload.objectPath,
      });
      await refresh();
      setAvatarPreview(null);
    } catch (cause) {
      setAvatarPreview(null);
      setAvatarError(friendlyError(cause));
    } finally {
      setAvatarBusy(false);
    }
  };

  const shortcuts = [
    {
      href: "/orders",
      label: "طلباتي",
      icon: ReceiptText,
      testId: "link-profile-orders",
    },
    {
      href: "/seller/offers",
      label: "عروضي",
      icon: Tag,
      value: d?.activeListings,
      testId: "link-profile-offers",
    },
    {
      href: "/ai?openSurface=sales",
      label: "المبيعات",
      icon: Store,
      value: d?.completedOrders,
      testId: "link-profile-sales",
    },
    {
      href: "/seller/dues",
      label: "المستحقات",
      icon: Coins,
      testId: "link-profile-dues",
    },
  ];

  return (
    <div className="container-app max-w-2xl">
      <header className="flex items-center gap-4 pb-5 pt-6 md:pt-10">
        <div className="relative shrink-0">
          <Avatar
            name={user.displayName}
            src={
              avatarPreview ??
              (user.avatarObjectPath
                ? `/api/storage${user.avatarObjectPath}`
                : undefined)
            }
            size={76}
            className="text-2xl"
          />
          <input
            ref={avatarInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={uploadAvatar}
            disabled={avatarBusy}
            className="sr-only"
            data-testid="input-profile-avatar"
          />
          <button
            type="button"
            aria-label={
              avatarBusy ? "جارٍ رفع الصورة" : "تغيير صورة الملف الشخصي"
            }
            title="تغيير الصورة"
            data-testid="button-profile-avatar"
            disabled={avatarBusy}
            onClick={() => avatarInput.current?.click()}
            className={`${iconButtonClass("solid")} !absolute bottom-0 start-0`}
          >
            {avatarBusy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-e-transparent" />
            ) : (
              <Camera size={15} aria-hidden />
            )}
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold">{user.displayName}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            عضو منذ {longDate(user.createdAt)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {avatarBusy
              ? "جارٍ رفع الصورة…"
              : user.avatarObjectPath
                ? "صورتك ظاهرة لمستخدمي جاسم · اضغط على الكاميرا لتغييرها"
                : "اضغط على أيقونة الكاميرا لإضافة صورة يراها مستخدمو جاسم"}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge
              tone="neutral"
              icon={<Flag code={user.accountCountry} size={14} />}
            >
              حساب {countryName(user.accountCountry, markets)}
            </Badge>
            {d && d.completedOrders > 0 && (
              <Badge tone="success">{d.completedOrders} بيع مكتمل</Badge>
            )}
          </div>
        </div>
      </header>
      {avatarError && (
        <InlineAlert tone="danger" className="mb-4">
          {avatarError}
        </InlineAlert>
      )}

      <div className="mb-5 grid grid-cols-4 gap-2">
        {shortcuts.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            data-testid={s.testId}
            className="pressable flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-1 py-3.5 text-center hover:border-border-strong"
          >
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
              <s.icon size={19} aria-hidden />
            </span>
            <span className="text-xs font-semibold">{s.label}</span>
          </Link>
        ))}
      </div>

      <ListGroup title="السوق">
        <ListRow
          onClick={open}
          icon={<Flag code={market?.countryCode} size={22} />}
          title={`سوق ${market?.countryNameAr ?? ""}`}
          description={`العملة ${market?.currencyCode ?? ""} · يحدد البائع سعر كل عرض`}
          trailing={
            <span className="text-sm font-semibold text-primary">تغيير</span>
          }
          testId="button-profile-market"
        />
      </ListGroup>

      <ListGroup title="الحساب">
        <ListRow
          href="/settings"
          icon={<UserRound size={19} />}
          title="الإعدادات"
          description="السوق، المظهر، الخصوصية"
          testId="link-settings"
        />
        <ListRow
          href="/notifications"
          icon={<Bell size={19} />}
          title="التنبيهات"
        />
        <ListRow
          href="/policies"
          icon={<FileText size={19} />}
          title="الشروط والسياسات"
        />
      </ListGroup>

      {error && (
        <InlineAlert tone="danger" className="mb-4">
          {error}
        </InlineAlert>
      )}
      <Button
        variant="danger-soft"
        block
        size="lg"
        icon={<LogOut size={18} />}
        onClick={() => logout().catch((e) => setError(friendlyError(e)))}
      >
        تسجيل الخروج
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- Settings */

export function SettingsPage() {
  const { user, market, markets, logout } = useAccount();
  const { open } = useMarketSheet();
  const [theme, setTheme] = useTheme();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [error, setError] = useState("");
  if (!user) return null;
  return (
    <div className="container-app max-w-2xl">
      <PageHeader back="/profile" title="الإعدادات" />
      {user.status === "RESTRICTED" && (
        <InlineAlert tone="warning" className="mb-4" testId="alert-account-restricted">
          حسابك مقيّد بقرار من إدارة السوق. يمكنك متابعة طلباتك القائمة، ولا
          يمكن نشر عروض أو بدء مشتريات جديدة.
        </InlineAlert>
      )}

      <ListGroup title="الحساب">
        <ListRow
          icon={<UserRound size={19} />}
          title={user.displayName}
          description="الاسم الظاهر للبائعين والمشترين"
        />
        <ListRow
          icon={<ShieldCheck size={19} />}
          title={
            <span dir="ltr" className="num">
              {user.normalizedPhone}
            </span>
          }
          description={
            user.phoneVerified
              ? "رقم متحقق منه"
              : "غير متحقق — خدمة رسائل التحقق غير متاحة حاليًا"
          }
          trailing={
            user.phoneVerified ? (
              <Badge tone="success">متحقق</Badge>
            ) : (
              <Badge>غير متحقق</Badge>
            )
          }
        />
      </ListGroup>

      <EmailNotificationsSettings />

      <AdPersonalizationSettings />

      <ListGroup title="السوق والدولة">
        <ListRow
          onClick={open}
          icon={<Flag code={market?.countryCode} size={22} />}
          title="سوق التصفح"
          description={`${market?.countryNameAr ?? ""} · العملة ${market?.currencyCode ?? ""}`}
          trailing={
            <span className="text-sm font-semibold text-primary">تغيير</span>
          }
          testId="button-settings-market"
        />
        <ListRow
          icon={<Globe2 size={19} />}
          title="دولة الحساب"
          description={`${countryName(user.accountCountry, markets)} — لا تتغير بتغيير السوق`}
        />
      </ListGroup>

      {user.role === "ADMIN" && (
        <ListGroup title="الإدارة">
          <ListRow
            onClick={() => window.location.assign("/admin/markets")}
            icon={<Shield size={19} />}
            title="إدارة الأسواق"
            description="جهّز الحالة والسياسات وسعر الوحدة لكل سوق دولة"
            trailing={<span className="text-sm font-semibold text-primary">فتح</span>}
            testId="link-settings-admin-markets"
          />
          <ListRow
            onClick={() => window.location.assign("/admin/legal-readiness")}
            icon={<Shield size={19} />}
            title="الجاهزية القانونية والأمنية"
            description="بوابات صلاحيات الأسواق وسجل حوادث الأمن والخصوصية"
            trailing={<span className="text-sm font-semibold text-primary">فتح</span>}
            testId="link-settings-admin-legal-readiness"
          />
          <ListRow
            onClick={() => window.location.assign("/admin/categories")}
            icon={<Shield size={19} />}
            title="إدارة التصنيفات"
            description="أضف منتجات وخدمات وحقول البحث الخاصة بها"
            trailing={<span className="text-sm font-semibold text-primary">فتح</span>}
            testId="link-settings-admin-categories"
          />
          <ListRow
            onClick={() => window.location.assign("/admin/trust-safety")}
            icon={<Shield size={19} />}
            title="البلاغات والإشراف"
            description="البلاغات، إخفاء العروض، تقييد الحسابات، وقواعد المنتجات المحظورة"
            trailing={<span className="text-sm font-semibold text-primary">فتح</span>}
            testId="link-settings-admin-trust-safety"
          />
          <ListRow
            onClick={() => window.location.assign("/admin/disputes")}
            icon={<Shield size={19} />}
            title="إدارة النزاعات"
            description="راجع الطلبات المتنازع عليها واعتمد نتيجة الحسم"
            trailing={<span className="text-sm font-semibold text-primary">فتح</span>}
            testId="link-settings-admin-disputes"
          />
          <ListRow
            onClick={() => window.location.assign("/admin/refunds")}
            icon={<Shield size={19} />}
            title="استرداد مدفوعات Whop"
            description="استرداد كامل أو جزئي لدفعة محصّلة، ومتابعة حالة كل استرداد"
            trailing={<span className="text-sm font-semibold text-primary">فتح</span>}
            testId="link-settings-admin-refunds"
          />
        </ListGroup>
      )}

      <AccountEditor key={user.id} />

      <ListGroup title="الموقع">
        <ListRow
          icon={<MapPin size={19} />}
          title="لا نستخدم موقعك الدقيق"
          description="عروضك تُظهر المدينة والمنطقة العامة فقط. العنوان يُشارك داخل الطلب عند الحاجة."
        />
      </ListGroup>

      <ListGroup title="الإشعارات">
        <ListRow
          href="/notifications"
          icon={<Bell size={19} />}
          title="تنبيهات الطلبات"
          description="داخل التطبيق فقط — لا نرسل رسائل نصية أو إشعارات هاتف حاليًا."
        />
      </ListGroup>

      <section className="mb-5">
        <h2 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">
          المظهر
        </h2>
        <div className="rounded-xl border border-border bg-card p-3">
          <Segmented<ThemePreference>
            label="المظهر"
            value={theme}
            onChange={setTheme}
            options={[
              {
                value: "light",
                label: (
                  <>
                    <Sun size={15} aria-hidden /> فاتح
                  </>
                ),
                testId: "button-theme-light",
              },
              {
                value: "dark",
                label: (
                  <>
                    <Moon size={15} aria-hidden /> داكن
                  </>
                ),
                testId: "button-theme-dark",
              },
              {
                value: "system",
                label: (
                  <>
                    <SunMoon size={15} aria-hidden /> تلقائي
                  </>
                ),
                testId: "button-theme-system",
              },
            ]}
          />
        </div>
      </section>

      <ListGroup title="الخصوصية والأمان">
        <ConnectAttributionPrivacy />
        <ListRow
          icon={<ShieldCheck size={19} />}
          title="كلمة المرور مشفّرة"
          description="لا نخزّن كلمة مرورك كنص، ولا نعرضها لأحد."
        />
        <ListRow
          icon={<Info size={19} />}
          title="محادثات الطلب"
          description="مرتبطة بكل طلب ويراها طرفا الطلب فقط."
        />
      </ListGroup>

      <ListGroup title="الدعم">
        <ListRow
          icon={<LifeBuoy size={19} />}
          title="مشكلة في طلب؟"
          description="افتح الطلب واستخدم المحادثة، أو «الإبلاغ عن مشكلة» بعد التسليم."
          href="/orders"
        />
        <ListRow
          icon={<HelpCircle size={19} />}
          title="كيف يعمل جاسم؟"
          description="لكل عرض سعر يحدده البائع. تختار الكمية، ويُنشأ طلب لكل بائع."
        />
      </ListGroup>

      <LegalSettings />
      <ListGroup title="الشركاء">
        <ListRow href="/connect" icon={<FileText size={19} />} title="جاسم Connect — الشركاء" description="تسجيل مجاني وربط كتالوج خارجي بصلاحيات مراجعة" testId="link-settings-connect" />
      </ListGroup>

      <div className="mb-5 flex flex-col items-center gap-2 py-4 text-center">
        <BrandMark size={48} />
        <p className="text-xs text-muted-foreground">
          سوق عربي بسعر وحدة واحد · نسخة تجريبية
        </p>
      </div>

      {error && (
        <InlineAlert tone="danger" className="mb-4">
          {error}
        </InlineAlert>
      )}
      <Button
        variant="danger-soft"
        block
        size="lg"
        icon={<LogOut size={18} />}
        onClick={() => setConfirmLogout(true)}
        data-testid="button-settings-logout"
      >
        تسجيل الخروج
      </Button>
      <DeleteAccountSection />
      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="تسجيل الخروج؟"
        body="ستبقى سلتك وطلباتك محفوظة في حسابك."
        confirmLabel="تسجيل الخروج"
        tone="danger"
        icon={<LogOut size={19} />}
        onConfirm={() => logout().catch((e) => setError(friendlyError(e)))}
      />
    </div>
  );
}

function EmailNotificationsSettings() {
  const queryClient = useQueryClient();
  const emailQuery = useGetAccountEmail();
  const preferencesQuery = useGetAccountPrivacyPreferences();
  const requestCode = useRequestAccountEmailVerification();
  const confirmCode = useConfirmAccountEmailVerification();
  const removeEmail = useRemoveAccountEmail();
  const updatePreferences = useUpdateAccountPrivacyPreferences();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busy = requestCode.isPending || confirmCode.isPending || removeEmail.isPending || updatePreferences.isPending;
  const verifiedEmail = emailQuery.data?.email ?? null;
  const isEmailVerified = Boolean(verifiedEmail && emailQuery.data?.verifiedAt);
  const marketingEmail = preferencesQuery.data?.communications.marketing.email ?? false;

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetAccountEmailQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAccountPrivacyPreferencesQueryKey() }),
    ]);
  }

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const result = await requestCode.mutateAsync({ data: { email: email.trim() } });
      setChallengeId(result.challengeId);
      setCode("");
      setMessage("أرسلنا رمزًا من ستة أرقام. أدخله خلال عشر دقائق لإثبات ملكية البريد.");
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      await confirmCode.mutateAsync({ data: { challengeId, code } });
      setChallengeId("");
      setCode("");
      setEditing(false);
      setMessage("تم توثيق البريد الإلكتروني.");
      await invalidate();
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function setMarketingConsent(checked: boolean) {
    setError("");
    setMessage("");
    try {
      await updatePreferences.mutateAsync({
        data: {
          expectedVersion: preferencesQuery.data?.version ?? 0,
          marketing: { email: checked },
        },
      });
      await preferencesQuery.refetch();
      setMessage(checked ? "تم حفظ موافقتك على رسائل العروض." : "تم إيقاف رسائل العروض.");
    } catch (cause) {
      setError(friendlyError(cause));
      await preferencesQuery.refetch();
    }
  }

  async function deleteEmail() {
    setError("");
    try {
      await removeEmail.mutateAsync();
      setConfirmRemove(false);
      setEditing(false);
      setChallengeId("");
      setEmail("");
      setMessage("أُزيل البريد وأُوقفت موافقة رسائل العروض.");
      await invalidate();
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  return (
    <section className="mb-5 rounded-xl border border-border bg-card p-4" data-testid="section-email-notifications">
      <div className="mb-2 flex items-center gap-2">
        <Mail size={18} aria-hidden />
        <h2 className="font-bold">البريد والتنبيهات</h2>
      </div>
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        نرسل للبائع تنبيهًا عند وصول استفسار شراء بعد توثيق بريده. رسائل العروض التسويقية اختيارية ومنفصلة.
      </p>

      {emailQuery.isError || preferencesQuery.isError ? (
        <InlineAlert tone="danger">تعذر تحميل البريد وتفضيلات الرسائل. حدّث الصفحة وحاول مرة أخرى.</InlineAlert>
      ) : emailQuery.isLoading || preferencesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">جارٍ تحميل بيانات البريد…</p>
      ) : isEmailVerified && !editing ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span dir="ltr" className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="text-account-email">
            {verifiedEmail}
          </span>
          <Badge tone="success">موثّق</Badge>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEmail(verifiedEmail ?? "");
              setEditing(true);
              setChallengeId("");
              setError("");
              setMessage("");
            }}
            data-testid="button-change-account-email"
          >
            تغيير البريد
          </Button>
          <Button
            variant="danger-soft"
            size="sm"
            onClick={() => setConfirmRemove(true)}
            data-testid="button-remove-account-email"
          >
            إزالة البريد
          </Button>
        </div>
      ) : (
        <div className="mb-4 grid gap-3">
          <form onSubmit={(event) => void sendCode(event)} className="flex flex-wrap items-end gap-2">
            <Field label={isEmailVerified ? "البريد الجديد" : "البريد الإلكتروني"}>
              <Input
                type="email"
                dir="ltr"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={320}
                required
                data-testid="input-account-email"
              />
            </Field>
            <Button type="submit" loading={requestCode.isPending} disabled={busy} data-testid="button-send-email-code">
              إرسال رمز التحقق
            </Button>
            {isEmailVerified && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setChallengeId("");
                  setError("");
                  setMessage("");
                }}
                data-testid="button-cancel-email-change"
              >
                إلغاء
              </Button>
            )}
          </form>

          {challengeId && (
            <form onSubmit={(event) => void verifyCode(event)} className="flex flex-wrap items-end gap-2">
              <Field label="رمز التحقق" hint="ستة أرقام، صالح لعشر دقائق">
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  dir="ltr"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                  pattern="[0-9]{6}"
                  required
                  data-testid="input-email-verification-code"
                />
              </Field>
              <Button type="submit" loading={confirmCode.isPending} disabled={busy || code.length !== 6} data-testid="button-confirm-email-code">
                توثيق البريد
              </Button>
            </form>
          )}
        </div>
      )}

      <label className="flex items-start gap-3 border-t border-border pt-3 text-sm leading-6">
        <input
          type="checkbox"
          checked={marketingEmail}
          disabled={!isEmailVerified || busy || preferencesQuery.isLoading || preferencesQuery.isError}
          onChange={(event) => void setMarketingConsent(event.currentTarget.checked)}
          className="mt-1 h-4 w-4 accent-primary"
          data-testid="checkbox-marketing-email"
        />
        <span>
          أوافق على تلقي رسالة عن كل إعلان جديد يُنشر في سوقي. لا نرسلها إلا بعد توثيق البريد، ويمكن إلغاء الاشتراك من أي رسالة.
          {!isEmailVerified && marketingEmail && (
            <span className="block text-xs text-muted-foreground">موافقتك السابقة محفوظة، لكنها غير فعّالة حتى توثيق البريد.</span>
          )}
        </span>
      </label>
      {preferencesQuery.data && !preferencesQuery.data.deliveryChannelsConnected.email && (
        <p className="mt-2 text-xs text-muted-foreground">إرسال البريد غير مفعّل في بيئة القبول حاليًا؛ تُحفظ الموافقة ولا تُرسل رسالة حتى تهيئة المزود.</p>
      )}

      {error && <InlineAlert tone="danger" className="mt-3">{error}</InlineAlert>}
      {message && <InlineAlert tone="success" className="mt-3" testId="status-email-notifications">{message}</InlineAlert>}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="إزالة البريد الإلكتروني؟"
        body="سيُحذف البريد الموثّق من حسابك، وتتوقف موافقة رسائل العروض."
        confirmLabel="إزالة البريد"
        tone="danger"
        loading={removeEmail.isPending}
        onConfirm={() => void deleteEmail()}
      />
    </section>
  );
}

/* ---------------------------------------------------------------- Account deletion */

function DeleteAccountSection() {
  const { user, refresh } = useAccount();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!user || user.role === "ADMIN") return null;
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/account/deletion", "POST", {
        currentPassword: password,
        confirm: true,
      });
      setOpen(false);
      await refresh();
      window.location.assign("/");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-6" data-testid="section-delete-account">
      <h2 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">
        حذف الحساب
      </h2>
      <div className="rounded-xl border border-border bg-card p-4 text-sm leading-6 text-text-secondary">
        <p>
          يُغلق الحساب نهائيًا، وتُلغى كل الجلسات، وتُؤرشف عروضك، ويُزال اسمك
          ورقمك وموقعك الخاص وصورتك. تبقى سجلات الطلبات والعمولات والنزاعات لأنها
          سجلات معاملات.{" "}
          <Link href="/policies/account-deletion" className="font-semibold text-primary">
            التفاصيل
          </Link>
        </p>
        <Button
          variant="danger-soft"
          className="mt-3"
          onClick={() => {
            setError("");
            setPassword("");
            setOpen(true);
          }}
          data-testid="button-delete-account"
        >
          حذف الحساب
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="حذف الحساب نهائيًا؟"
        body="لا يمكن التراجع. يجب إنهاء الطلبات والنزاعات المفتوحة أولًا."
        confirmLabel="حذف الحساب"
        tone="danger"
        loading={busy}
        onConfirm={() => void submit()}
      >
        <div className="grid gap-3">
          <Field label="كلمة المرور الحالية">
            <Input
              type="password"
              value={password}
              autoComplete="current-password"
              maxLength={128}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="input-delete-account-password"
            />
          </Field>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        </div>
      </ConfirmDialog>
    </section>
  );
}

/* ---------------------------------------------------------------- Notifications */

// Reuse the same authoritative detail renderer used by conversation order cards.
const NotificationOrderDetail = lazy(() => import("./OrderDetails").then((module) => ({ default: module.OrderInlineSurface })));

export function NotificationsPage() {
  const { user } = useAccount();
  const { list, query } = useActionableOrders();
  const requestedOrderId = new URLSearchParams(useSearch()).get("order");
  if (requestedOrderId) {
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestedOrderId);
    return (
      <div className="container-app max-w-2xl">
        <PageHeader title="تفاصيل تنبيه الطلب" back="/notifications" />
        {validId ? (
          <Suspense fallback={<div aria-busy="true" aria-label="جارٍ تحميل الطلب"><Skeleton className="h-40" /></div>}>
            <NotificationOrderDetail orderId={requestedOrderId} />
          </Suspense>
        ) : <InlineAlert tone="danger">رابط الطلب غير صحيح.</InlineAlert>}
      </div>
    );
  }
  return (
    <div className="container-app max-w-2xl">
      <PageHeader title="التنبيهات" subtitle="طلبات تنتظر منك إجراءً" />
      {query.isLoading ? (
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="لا توجد تنبيهات"
          body="ستظهر هنا الطلبات التي تحتاج قبولك أو تسليمك أو تأكيد استلامك."
          action={
            <ButtonLink href="/orders" variant="secondary">
              كل الطلبات
            </ButtonLink>
          }
          testId="state-notifications-empty"
        />
      ) : (
        <div className="space-y-3">
          {list.map((o) => (
            <OrderCard key={o.id} order={o} userId={user?.id} href={`/notifications?order=${encodeURIComponent(o.id)}`} />
          ))}
          <Link
            href="/orders"
            className="flex items-center justify-center gap-1 py-3 text-sm font-semibold text-primary"
          >
            كل الطلبات <ChevronLeft size={16} aria-hidden />
          </Link>
        </div>
      )}
    </div>
  );
}

function AccountEditor() {
  const { user, refresh, logout } = useAccount();
  const [name, setName] = useState(user?.displayName ?? "");
  const [city, setCity] = useState(user?.city ?? "");
  const [area, setArea] = useState(user?.area ?? "");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function save(security: boolean) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (security) {
        await api("/account/password", "POST", {
          currentPassword: current,
          password,
          confirmPassword: confirmation,
        });
        await logout();
      } else {
        await api("/account/profile", "PATCH", {
          displayName: name,
          city,
          area,
        });
        await refresh();
        setSuccess("حُفظت بيانات الحساب والموقع العام");
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-5 space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">تعديل الحساب والموقع</h2>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <Field label="الاسم الظاهر">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={80}
            required
          />
        </Field>
        <Field label="المدينة" optional>
          <Input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            maxLength={100}
          />
        </Field>
        <Field
          label="المنطقة"
          optional
          hint="اختيار يدوي، دون إذن GPS. عنوان التسليم الدقيق يبقى داخل الطلب."
        >
          <Input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            maxLength={100}
          />
        </Field>
        <Button type="submit" loading={busy}>
          حفظ البيانات
        </Button>
      </form>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer py-2 font-semibold">
          تغيير كلمة المرور
        </summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <Field label="كلمة المرور الحالية">
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              maxLength={128}
            />
          </Field>
          <Field label="كلمة المرور الجديدة">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              maxLength={128}
            />
          </Field>
          <Field label="تأكيد كلمة المرور الجديدة">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              required
              minLength={12}
              maxLength={128}
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            يؤدي الحفظ إلى تسجيل الخروج من جميع الجلسات.
          </p>
          <Button type="submit" loading={busy}>
            تغيير كلمة المرور وتسجيل الخروج
          </Button>
        </form>
      </details>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {success && <InlineAlert tone="success">{success}</InlineAlert>}
    </section>
  );
}


/**
 * Legal and data settings: the current documents with the version and effective date the server
 * publishes (the same registry used for signup acceptance), the marketplace rules, account deletion
 * and support. The public URLs /privacy and /terms stay reachable without signing in.
 */
function LegalSettings() {
  const index = usePolicyIndex();
  const find = (key: string) => index.data?.policies.find((policy) => policy.key === key);
  const versionLine = (key: string, fallback: string) => {
    const policy = find(key);
    // The version stays the exact registry string; the date is shown in words so it never breaks mid-line in RTL.
    return policy ? `النسخة ${policy.version} · سارية من ${longDate(policy.effectiveDate)}` : fallback;
  };
  return (
    <ListGroup title="القانونية والبيانات">
      <ListRow href="/terms" icon={<FileText size={19} />} title="شروط الاستخدام" description={versionLine("terms", "شروط استخدام جاسم")} testId="link-settings-terms" />
      <ListRow href="/privacy" icon={<ShieldCheck size={19} />} title="سياسة الخصوصية" description={versionLine("privacy", "كيف نجمع بياناتك ونستخدمها")} testId="link-settings-privacy" />
      <ListRow
        href="/policies"
        icon={<FileText size={19} />}
        title="كل السياسات"
        description="قواعد السوق والبائعين، الرسوم، النزاعات، وحذف الحساب"
        testId="link-settings-policies"
      />
      <ListRow href="/policies/account-deletion" icon={<Info size={19} />} title="بياناتك وحذف الحساب" description="ما نحفظه، وكيف تطلب نسخة منه أو حذفه. الذاكرة بين المحادثات معطّلة ما لم تفعّلها." testId="link-settings-data" />
      <ListRow href="/orders" icon={<LifeBuoy size={19} />} title="الدعم والشكاوى" description="للطلبات: افتح الطلب واستخدم «الإبلاغ عن مشكلة». بريد التواصل الرسمي للخصوصية يُضاف بعد اعتماد الجهة القانونية." testId="link-settings-support" />
    </ListGroup>
  );
}
