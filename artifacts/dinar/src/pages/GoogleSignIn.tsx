/**
 * «المتابعة بحساب Google». Rendered only when VITE_GOOGLE_CLIENT_ID is configured.
 *
 * Google proves the email identity only. A linked account signs in directly; otherwise the user
 * must still verify their phone by SMS here before DINAR links or creates the account.
 */
import { detectCountry } from "@/lib/detect-country";
import { TermsAcknowledgementText } from "@/features/legal/TermsAcknowledgement";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  useCompleteGoogleSignIn,
  useRequestPhoneVerificationChallenge,
  useSignInWithGoogle,
  useVerifyPhoneVerificationChallenge,
} from "@workspace/api-client-react";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Checkbox, Field, Input } from "@/ui/Field";
import { InlineAlert } from "@/ui/Feedback";
import { PhoneInput } from "@/ui/PhoneInput";
import { CountrySelector } from "@/ui/CountrySelector";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
export const googleSignInConfigured = Boolean(CLIENT_ID && /\.apps\.googleusercontent\.com$/.test(CLIENT_ID));

type GoogleCredentialResponse = { credential?: string };
type GoogleAccounts = {
  id: {
    initialize(options: { client_id: string; callback: (response: GoogleCredentialResponse) => void; ux_mode?: "popup"; context?: string }): void;
    renderButton(element: HTMLElement, options: Record<string, unknown>): void;
  };
};

let scriptPromise: Promise<GoogleAccounts> | null = null;
function loadGoogleIdentity(): Promise<GoogleAccounts> {
  const existing = (window as unknown as { google?: { accounts?: GoogleAccounts } }).google?.accounts;
  if (existing) return Promise.resolve(existing);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      const accounts = (window as unknown as { google?: { accounts?: GoogleAccounts } }).google?.accounts;
      if (accounts) resolve(accounts);
      else reject(new Error("Google Identity Services unavailable"));
    };
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Google Identity Services unavailable"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function GoogleSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> | void }) {
  const button = useRef<HTMLDivElement | null>(null);
  const signIn = useSignInWithGoogle();
  const complete = useCompleteGoogleSignIn();
  const requestCode = useRequestPhoneVerificationChallenge();
  const verifyCode = useVerifyPhoneVerificationChallenge();
  const [pending, setPending] = useState<{ email: string; name: string | null; confirmTwice: boolean } | null>(null);
  const [phoneConfirm, setPhoneConfirm] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Pre-selected from the device's time zone / language (Jordan if unknown); always editable.
  const [detected] = useState(() => detectCountry());
  const [country, setCountry] = useState(detected.countryCode);
  const [dialCode, setDialCode] = useState(detected.callingCode!);
  const [phoneCountry, setPhoneCountry] = useState(detected.countryCode);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [developmentCode, setDevelopmentCode] = useState("");

  useEffect(() => {
    if (!googleSignInConfigured || pending) return;
    let cancelled = false;
    loadGoogleIdentity().then((accounts) => {
      if (cancelled || !button.current) return;
      accounts.id.initialize({
        client_id: CLIENT_ID!,
        ux_mode: "popup",
        context: "signin",
        callback: async ({ credential }) => {
          if (!credential) return;
          setError("");
          setBusy(true);
          try {
            const result = await signIn.mutateAsync({ data: { idToken: credential } });
            if (result.status === "SIGNED_IN") await onSignedIn();
            else {
              setPending({ email: result.email ?? "", name: result.name ?? null, confirmTwice: result.phoneMode === "CONFIRM_TWICE" });
              setDisplayName(result.name ?? "");
            }
          } catch (err) {
            setError(friendlyError(err));
          } finally {
            setBusy(false);
          }
        },
      });
      // Google's own dark rendering sits on the app's dark surface; the width follows the form
      // (Google accepts 200-400 px) so the button lines up with the phone field on every screen.
      const width = Math.max(200, Math.min(400, Math.round(button.current.parentElement?.clientWidth ?? 320)));
      // Google's own button and logo (branding rules), themed to the app: on the light card the
      // outline style matches the form fields; in dark mode the black pill sits in a rounded,
      // clipped frame so no white iframe corners or halo show around it.
      const dark = document.documentElement.classList.contains("dark");
      accounts.id.renderButton(button.current, { type: "standard", theme: dark ? "filled_black" : "outline", size: "large", text: "continue_with", shape: "pill", logo_alignment: "left", locale: "ar", width });
    }, () => setUnavailable(true));
    return () => {
      cancelled = true;
    };
  }, [pending, signIn, onSignedIn]);

  if (!googleSignInConfigured) return null;

  if (!pending)
    return (
      <div className="google-sign-in grid w-full justify-items-center gap-2" data-testid="google-sign-in">
        <div ref={button} className="google-sign-in-button" aria-label="المتابعة بحساب Google" />
        {unavailable && <p className="text-xs text-muted-foreground">تعذر تحميل زر Google الآن. يمكنك المتابعة برقم الهاتف.</p>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      </div>
    );

  const sendCode = async () => {
    if (!/^[+\d\s٠-٩۰-۹()-]{6,40}$/.test(phoneNumber.trim())) return setError("أدخل رقم هاتف صحيحًا");
    setError("");
    setBusy(true);
    try {
      const result = await requestCode.mutateAsync({ data: { phoneCountryCode: dialCode, phoneNumber: phoneNumber.trim() } });
      setChallengeId(result.challengeId);
      setDevelopmentCode(result.developmentCode ?? "");
      toast.success("إذا كان الرقم صالحًا، فسيصلك رمز التحقق");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  // Deferred mode (no SMS): the phone is typed twice and kept as an unverified contact number.
  const finishWithoutSms = async () => {
    if (!accepted) return setError("يلزم الموافقة على الشروط");
    if (!/^[+\d\s٠-٩۰-۹()-]{6,40}$/.test(phoneNumber.trim())) return setError("أدخل رقم هاتف صحيحًا");
    if (phoneNumber.replace(/\D/g, "") !== phoneConfirm.replace(/\D/g, "")) return setError("رقما الهاتف غير متطابقين. اكتب رقمك مرتين بنفس الطريقة.");
    setError("");
    setBusy(true);
    try {
      await complete.mutateAsync({
        data: {
          phoneCountryCode: dialCode,
          phoneNumber: phoneNumber.trim(),
          phoneNumberConfirm: phoneConfirm.trim(),
          accountCountry: country,
          acceptTerms: true,
          ...(displayName.trim().length >= 2 ? { displayName: displayName.trim() } : {}),
        },
      });
      await onSignedIn();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!accepted) return setError("يلزم الموافقة على الشروط");
    if (!/^\d{6}$/.test(code)) return setError("أدخل رمز التحقق المكوّن من 6 أرقام");
    setError("");
    setBusy(true);
    try {
      const verified = await verifyCode.mutateAsync({ data: { challengeId, code } });
      await complete.mutateAsync({
        data: {
          phoneCountryCode: dialCode,
          phoneNumber: phoneNumber.trim(),
          accountCountry: country,
          acceptTerms: true,
          verificationToken: verified.verificationToken,
          ...(displayName.trim().length >= 2 ? { displayName: displayName.trim() } : {}),
        },
      });
      await onSignedIn();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 rounded-2xl border border-border bg-muted/30 p-4" data-testid="google-phone-step">
      <div>
        <p className="font-semibold text-foreground">خطوة أخيرة: {pending.confirmTwice ? "رقم هاتفك للتواصل" : "تأكيد رقم هاتفك"}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {pending.confirmTwice ? (
            <>
              تم التحقق من حساب Google <span dir="ltr">{pending.email}</span>. اكتب رقم هاتفك مرتين؛ يصل إليه البائع أو المشتري للتنسيق على طلباتك.
              تأكد أنه رقمك وصحيح، فالحسابات برقم غير موثّق تملك طلبين مفتوحين كحد أقصى.
            </>
          ) : (
            <>
              تم التحقق من حساب Google <span dir="ltr">{pending.email}</span>. يتطلب جاسم رقم هاتف موثقًا لكل حساب؛ إذا كان الرقم مسجلًا لديك سابقًا فسنربط حساب Google به.
            </>
          )}
        </p>
      </div>
      <Field label="الاسم">
        <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} autoComplete="name" />
      </Field>
      <Field label="دولة الحساب">
        <CountrySelector value={country} onChange={(c) => { setCountry(c.countryCode); if (c.callingCode) { setDialCode(c.callingCode); setPhoneCountry(c.countryCode); } }} />
      </Field>
      <Field label="رقم الهاتف">
        <PhoneInput name="googlePhoneNumber" dialCode={dialCode} onDialCodeChange={setDialCode} countryCode={phoneCountry} onCountryChange={setPhoneCountry} value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
      </Field>
      {pending.confirmTwice ? (
        <>
          <Field label="أعد كتابة رقم الهاتف">
            <PhoneInput name="googlePhoneNumberConfirm" dialCode={dialCode} onDialCodeChange={setDialCode} countryCode={phoneCountry} onCountryChange={setPhoneCountry} value={phoneConfirm} onChange={(event) => setPhoneConfirm(event.target.value)} />
          </Field>
          <Checkbox checked={accepted} onChange={(value: boolean) => setAccepted(value)}>
            <TermsAcknowledgementText />
          </Checkbox>
          <Button type="button" loading={busy} onClick={() => void finishWithoutSms()} data-testid="google-complete-confirm-twice">
            إنشاء الحساب والمتابعة
          </Button>
        </>
      ) : !challengeId ? (
        <Button type="button" loading={busy} onClick={() => void sendCode()} data-testid="google-send-code">
          أرسل رمز التحقق
        </Button>
      ) : (
        <>
          <Field label="رمز التحقق" hint={developmentCode ? `رمز التطوير: ${developmentCode}` : undefined}>
            <Input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" dir="ltr" />
          </Field>
          <Checkbox checked={accepted} onChange={(value: boolean) => setAccepted(value)}>
            <TermsAcknowledgementText />
          </Checkbox>
          <Button type="button" loading={busy} onClick={() => void finish()} data-testid="google-complete">
            تأكيد ومتابعة
          </Button>
        </>
      )}
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
    </div>
  );
}
