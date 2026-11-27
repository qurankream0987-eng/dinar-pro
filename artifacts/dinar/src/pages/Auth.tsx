import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { detectCountry } from "@/lib/detect-country";
import { TermsAcknowledgementText } from "@/features/legal/TermsAcknowledgement";
import { Link, useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { Eye, EyeOff, MessageCircle, ShieldCheck, Store, ShoppingBag } from "lucide-react";
import {
  useLoginAccount,
  useRegisterAccount,
  useRequestPhoneVerificationChallenge,
  useVerifyPhoneVerificationChallenge,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Button, iconButtonClass } from "@/ui/Button";
import { Checkbox, Field, Input } from "@/ui/Field";
import { InlineAlert, Skeleton } from "@/ui/Feedback";
import { BrandMark, Flag } from "@/ui/Media";
import { PhoneInput } from "@/ui/PhoneInput";

import { CountrySelector } from "@/ui/CountrySelector";
import { GoogleSignIn, googleSignInConfigured } from "./GoogleSignIn";
/** Only allow same-app relative redirects. */
const safeNext = (value: string | null) => {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const target = new URL(value, window.location.origin);
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : "/";
  } catch {
    return "/";
  }
};
const phoneVerificationEnabled = !import.meta.env.DEV;

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" dir="ltr">
      <Input {...props} type={show ? "text" : "password"} dir="ltr" className="pe-11 text-start" />
      <button
        type="button"
        aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
        aria-pressed={show}
        onClick={() => setShow(!show)}
        className={`${iconButtonClass("ghost")} !absolute end-1 top-1/2 -translate-y-1/2`}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

function AuthFrame({ children, embedded = false }: { children: ReactNode; embedded?: boolean }) {
  if (embedded) {
    return (
      <div className="mx-auto w-full max-w-[400px] px-3 py-3 sm:px-4 sm:py-4">
        {children}
      </div>
    );
  }
  return (
    <div className="container-app flex min-h-[calc(100dvh-5rem)] items-center justify-center py-4 md:py-6">
      <div className="mx-auto grid w-full max-w-[740px] rounded-2xl border border-border/80 bg-card/95 shadow-sm backdrop-blur-sm lg:grid-cols-[1fr_290px]">
        <div className="p-4 sm:p-5 md:p-6">{children}</div>
        <aside className="relative hidden overflow-hidden rounded-e-2xl bg-ink p-6 text-ink-foreground lg:flex lg:flex-col lg:justify-between">
          <span aria-hidden className="pointer-events-none absolute -end-20 -top-20 h-56 w-56 rounded-full border-[28px] border-accent/15" />
          <span aria-hidden className="pointer-events-none absolute -bottom-16 -start-14 h-44 w-44 rounded-full border-[22px] border-white/5" />
          <BrandMark size={44} wordmark={false} className="relative z-10" />
          <div className="relative my-4">
            <p className="text-xl font-bold leading-[1.5]">
              لكل عرض سعر يحدده البائع، وتظهر التكلفة بوضوح قبل الطلب.
              <br />
              <span className="text-accent">اشترِ وبِع بوضوح.</span>
            </p>
            <ul className="mt-5 space-y-3 text-sm text-ink-foreground/80">
              <li className="flex items-start gap-2.5">
                <ShoppingBag size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>اختر الكمية — والإجمالي واضح دائمًا.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Store size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>اعرض ما تبيعه من الحساب نفسه.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <MessageCircle size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>تواصل داخل كل طلب فقط.</span>
              </li>
            </ul>
          </div>
          <p className="relative flex items-center gap-2 text-xs text-ink-foreground/65">
            <ShieldCheck size={15} className="shrink-0" aria-hidden /> لا نطلب موقعك الدقيق عند التسجيل.
          </p>
        </aside>
      </div>
    </div>
  );
}

export function AuthPage({ register = false, next, embedded = false }: { register?: boolean; next?: string; embedded?: boolean }) {
  const { refresh, user } = useAccount();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const target = safeNext(next ?? params.get("next"));
  // Pre-selected from the device's time zone / language (Jordan if unknown); always editable.
  const [detected] = useState(() => detectCountry());
  const [country, setCountry] = useState(detected.countryCode);
  const [dialCode, setDialCode] = useState(detected.callingCode!);
  const [phoneCountry, setPhoneCountry] = useState(detected.countryCode);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [error, setError] = useState("");
  // Deferred mode (no SMS): new accounts are created with Google only.
  const [phoneSignup, setPhoneSignup] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { phoneSignup?: boolean } | null) => alive && setPhoneSignup(data?.phoneSignup))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [challengeId, setChallengeId] = useState("");
  const [challengePhoneKey, setChallengePhoneKey] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [developmentCode, setDevelopmentCode] = useState("");
  const requestPhoneVerification = useRequestPhoneVerificationChallenge();
  const verifyPhoneVerification = useVerifyPhoneVerificationChallenge();
  const createAccount = useRegisterAccount();
  const signIn = useLoginAccount();

  useEffect(() => {
    if (!embedded && user && (location === "/login" || location === "/register")) navigate(target, { replace: true });
  }, [user, location, target, navigate, embedded]);

  const currentPhoneKey = (data: Record<string, string>) =>
    `${dialCode}|${(data.phoneNumber ?? "").trim()}`;
  const phoneMatchesChallenge =
    challengePhoneKey === `${dialCode}|${phoneNumber.trim()}`;

  const requestCode = async (form: HTMLFormElement) => {
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (!/^[+\d\s٠-٩۰-۹()-]{6,40}$/.test((data.phoneNumber ?? "").trim())) {
      setFieldErrors((previous) => ({
        ...previous,
        phoneNumber: "أدخل رقم هاتف صحيحًا",
      }));
      return;
    }
    setError("");
    setBusy(true);
    try {
      const result = await requestPhoneVerification.mutateAsync({
        data: {
          phoneCountryCode: dialCode,
          phoneNumber: data.phoneNumber.trim(),
        },
      });
      setChallengeId(result.challengeId);
      setChallengePhoneKey(currentPhoneKey(data));
      setVerificationCode("");
      setVerificationToken("");
      setDevelopmentCode(result.developmentCode ?? "");
      toast.success("إذا كان الرقم صالحًا، فسيصلك رمز التحقق");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (form: HTMLFormElement) => {
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (!challengeId || challengePhoneKey !== currentPhoneKey(data)) {
      setError("أرسل رمز تحقق جديدًا لرقم الهاتف الحالي");
      setVerificationToken("");
      return;
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      setError("أدخل رمز التحقق المكوّن من 6 أرقام");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const result = await verifyPhoneVerification.mutateAsync({
        data: { challengeId, code: verificationCode },
      });
      setVerificationToken(result.verificationToken);
      setVerificationCode("");
      toast.success("تم التحقق من ملكية الرقم");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const errs: Record<string, string> = {};
    if (!/^[+\d\s٠-٩۰-۹()-]{6,40}$/.test((data.phoneNumber ?? "").trim())) errs.phoneNumber = "أدخل رقم هاتف صحيحًا";
    if (register) {
      if ((data.displayName ?? "").trim().length < 2) errs.displayName = "أدخل اسمك (حرفان على الأقل)";
      if ((data.password ?? "").length < 12) errs.password = "12 حرفًا على الأقل";
      if (data.password !== data.confirmPassword) errs.confirmPassword = "كلمتا المرور غير متطابقتين";
      if (data.acceptTerms !== "on") errs.acceptTerms = "يلزم الموافقة على الشروط";
    } else if (!data.password) errs.password = "أدخل كلمة المرور";
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (register && phoneVerificationEnabled) {
        const phoneKey = currentPhoneKey(data);
        if (!challengeId || challengePhoneKey !== phoneKey) {
          await requestPhoneVerification.mutateAsync({
            data: {
              phoneCountryCode: dialCode,
              phoneNumber: data.phoneNumber.trim(),
            },
          }).then((result) => {
            setChallengeId(result.challengeId);
            setChallengePhoneKey(phoneKey);
            setVerificationCode("");
            setVerificationToken("");
            setDevelopmentCode(result.developmentCode ?? "");
          });
          toast.success("إذا كان الرقم صالحًا، فسيصلك رمز التحقق");
          return;
        }
        if (!verificationToken) {
          if (!/^\d{6}$/.test(verificationCode)) {
            setError("أدخل رمز التحقق المكوّن من 6 أرقام");
            return;
          }
          const result = await verifyPhoneVerification.mutateAsync({
            data: { challengeId, code: verificationCode },
          });
          setVerificationToken(result.verificationToken);
          setVerificationCode("");
          toast.success("تم التحقق من ملكية الرقم");
          return;
        }
        await createAccount.mutateAsync({
          data: {
            displayName: data.displayName.trim(),
            phoneCountryCode: dialCode,
            phoneNumber: data.phoneNumber.trim(),
            accountCountry: country,
            password: data.password,
            confirmPassword: data.confirmPassword,
            acceptTerms: true,
            verificationToken,
          },
        });
      } else if (register) {
        await createAccount.mutateAsync({
          data: {
            displayName: data.displayName.trim(),
            phoneCountryCode: dialCode,
            phoneNumber: data.phoneNumber.trim(),
            accountCountry: country,
            password: data.password,
            confirmPassword: data.confirmPassword,
            acceptTerms: true,
          },
        });
      } else {
        await signIn.mutateAsync({
          data: {
            phoneCountryCode: dialCode,
            phoneNumber: data.phoneNumber.trim(),
            password: data.password,
            ...(verificationToken ? { verificationToken } : {}),
          },
        });
      }
      await refresh();
      if (!embedded) navigate(target, { replace: true });
      toast.success(register ? "أهلًا بك في JassimAI" : "أهلًا بعودتك");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame embedded={embedded}>
      <div className="mx-auto w-full max-w-[360px]">
        <div className={embedded ? "mb-4 text-center" : "mb-5 text-center lg:text-start"}>
          {!embedded && (
            <div className="mb-3 flex justify-center lg:hidden">
              <BrandMark size={44} wordmark={false} />
            </div>
          )}
          <h1 className="text-xl font-bold sm:text-2xl">{register ? "أنشئ حسابك" : "مرحبًا بعودتك"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {register ? "حساب واحد للشراء والبيع في JassimAI." : "سجّل دخولك لمتابعة طلباتك وسلتك وعروضك."}
          </p>
        </div>

        {googleSignInConfigured && (
          <div className="mb-4 grid gap-2.5">
            <GoogleSignIn
              onSignedIn={async () => {
                await refresh();
                if (!embedded) navigate(target, { replace: true });
                toast.success("أهلًا بك في JassimAI");
              }}
            />
            <div className="flex items-center gap-3 text-xs text-muted-foreground" role="separator" aria-label="أو تابع برقم الهاتف">
              <span className="h-px flex-1 bg-border" aria-hidden />
              <span>أو تابع برقم الهاتف</span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>
          </div>
        )}
        {register && phoneSignup === false ? (
          <InlineAlert tone="info" title="أنشئ حسابك عبر Google">
            التسجيل برقم الهاتف غير متاح حاليًا. اضغط زر «المتابعة بحساب Google» أعلاه، ثم اكتب رقم هاتفك مرتين.
          </InlineAlert>
        ) : (
        <form noValidate onSubmit={submit} className="grid gap-3">
          {register && (
            <>
              <Field label="الاسم" error={fieldErrors.displayName}>
                <Input name="displayName" autoComplete="name" maxLength={80} placeholder="كما سيظهر للبائعين والمشترين" />
              </Field>
              <Field label="دولة الحساب"><CountrySelector value={country} onChange={c => { setCountry(c.countryCode); if(c.callingCode){setDialCode(c.callingCode);setPhoneCountry(c.countryCode);} }} /></Field>
              <p className="text-xs text-muted-foreground">يمكنك إنشاء حساب حتى لو لم تبدأ التجارة في دولتك بعد.</p>
            </>
          )}

          <Field label="رقم الهاتف" error={fieldErrors.phoneNumber}>
            <PhoneInput
              name="phoneNumber"
              dialCode={dialCode}
              onDialCodeChange={setDialCode}
              countryCode={phoneCountry}
              onCountryChange={setPhoneCountry}
              value={phoneNumber}
              onChange={(event) => {
                setPhoneNumber(event.target.value);
                setFieldErrors((previous) => ({
                  ...previous,
                  phoneNumber: "",
                }));
              }}
            />
          </Field>

          {register && (
            <p className="text-xs text-muted-foreground">
              {phoneVerificationEnabled
                ? "نتحقق من ملكية رقم الهاتف قبل إنشاء الحساب."
                : "رمز التحقق متوقف في بيئة التطوير فقط؛ ستبقى بعض الصلاحيات التي تتطلب رقمًا موثقًا محدودة."}
            </p>
          )}

          <Field
            label="كلمة المرور"
            error={fieldErrors.password}
            hint={register ? "12 حرفًا على الأقل. استخدم كلمة مرور لا تستعملها في مكان آخر." : undefined}
          >
            <PasswordInput
              name="password"
              maxLength={128}
              autoComplete={register ? "new-password" : "current-password"}
            />
          </Field>

          {register && (
            <>
              <Field label="تأكيد كلمة المرور" error={fieldErrors.confirmPassword}>
                <PasswordInput name="confirmPassword" maxLength={128} autoComplete="new-password" />
              </Field>
              <div>
                <Checkbox name="acceptTerms">
                  <TermsAcknowledgementText />
                </Checkbox>
                {fieldErrors.acceptTerms && <p className="mt-1 text-xs font-medium text-destructive">{fieldErrors.acceptTerms}</p>}
              </div>
            </>
          )}

          {register && phoneVerificationEnabled && challengeId && !verificationToken && (
            // A step inside the one auth card, separated by a hairline — not a second bordered card.
            <div className="grid gap-3 border-t border-border pt-4">
              <p className="text-sm text-muted-foreground" data-testid="status-phone-verification">
                أدخل الرمز المرسل إلى رقم الهاتف نفسه.
              </p>
              {developmentCode && (
                <p className="text-sm font-semibold" data-testid="text-development-verification-code">
                  رمز التطوير للاختبار: <span dir="ltr" className="num">{developmentCode}</span>
                </p>
              )}
              <Field label="رمز التحقق">
                <Input
                  name="verificationCode"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  dir="ltr"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  data-testid="input-phone-verification-code"
                />
              </Field>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  if (form) void requestCode(form);
                }}
                data-testid="button-resend-phone-verification"
              >
                إرسال رمز جديد
              </Button>
            </div>
          )}

          {!register && phoneVerificationEnabled && (
            // Secondary path for numbers never verified: a quiet row, not a nested card competing with sign-in.
            <div className="grid gap-2 border-t border-border pt-4">
              <p className="text-sm text-muted-foreground">
                إذا لم يسبق لك التحقق من رقمك، يمكنك إثبات ملكيته هنا ثم تسجيل الدخول.
              </p>
              {!challengeId && (
                <Button
                  type="button"
                  variant="ghost"
                  className="!text-primary"
                  disabled={busy}
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (form) void requestCode(form);
                  }}
                  data-testid="button-send-login-verification"
                >
                  إرسال رمز تحقق
                </Button>
              )}
              {challengeId && !verificationToken && (
                <>
                  {developmentCode && (
                    <p className="text-sm font-semibold" data-testid="text-development-verification-code">
                      رمز التطوير للاختبار: <span dir="ltr" className="num">{developmentCode}</span>
                    </p>
                  )}
                  <Field label="رمز التحقق">
                    <Input
                      name="verificationCode"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      dir="ltr"
                      maxLength={6}
                      value={verificationCode}
                      onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      data-testid="input-login-verification-code"
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={busy}
                    onClick={(event) => {
                      const form = event.currentTarget.form;
                      if (form) void verifyCode(form);
                    }}
                    data-testid="button-verify-login-phone"
                  >
                    تحقق من الرقم
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={(event) => {
                      const form = event.currentTarget.form;
                      if (form) void requestCode(form);
                    }}
                    data-testid="button-resend-login-verification"
                  >
                    إرسال رمز جديد
                  </Button>
                </>
              )}
              {verificationToken && (
                <p className="text-sm font-semibold text-primary" data-testid="status-login-phone-verified">
                  تم التحقق من ملكية الرقم. أكمل تسجيل الدخول.
                </p>
              )}
            </div>
          )}

          {error && <InlineAlert tone="danger">{error}</InlineAlert>}

          <Button type="submit" size="lg" block loading={busy} className="mt-1" data-testid="button-auth-submit">
            {register
              ? !phoneVerificationEnabled
                ? "إنشاء الحساب"
                : !challengeId || !phoneMatchesChallenge
                  ? "إرسال رمز التحقق"
                  : verificationToken
                    ? "إنشاء الحساب"
                    : "تحقق من الرمز"
              : "تسجيل الدخول"}
          </Button>
        </form>
        )}

        <p className="mt-6 text-center text-base text-muted-foreground">
          {register ? "لديك حساب؟" : "جديد على JassimAI؟"}{" "}
          <Link
            href={`${register ? "/login" : "/register"}${target !== "/" ? `?next=${encodeURIComponent(target)}` : ""}`}
            className="font-bold text-primary hover:underline"
          >
            {register ? "سجّل الدخول" : "أنشئ حسابًا"}
          </Link>
        </p>
      </div>
    </AuthFrame>
  );
}

/** Gate for signed-in screens: shows sign-in in place and returns here afterwards. */
export function Protected({ children }: { children: ReactNode }) {
  const { user, loading, registerPrivateScreen } = useAccount();
  // A private route may mount while a visibility-triggered identity read is already pending.
  // Register its scope with the existing central presentation guard before the browser paints.
  useLayoutEffect(() => registerPrivateScreen(), [registerPrivateScreen]);
  const [location] = useLocation();
  const search = useSearch();
  if (loading)
    return (
      <div className="container-app space-y-3 pt-8" aria-busy="true" aria-label="جارٍ التحقق من الجلسة">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  if (!user) return <AuthPage next={`${location}${search ? `?${search}` : ""}`} />;
  // Revalidation hides this subtree and its portals centrally; change its key only when the
  // verified owner changes, so another account cannot inherit local drafts or dialogs.
  return <div key={user.id} data-private-screen className="contents">{children}</div>;
}
