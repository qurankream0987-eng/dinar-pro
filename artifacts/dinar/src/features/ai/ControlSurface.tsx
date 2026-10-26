import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Download, Globe2, Moon, Monitor, Sun, UserRound } from "lucide-react";
import { acknowledgeAiControlAction } from "@workspace/api-client-react";
import { ProductControlPayload } from "@workspace/api-zod/conversation-runtime";
import { Button } from "@/ui/Button";
import { api, useAccount } from "@/account/Account";
import { Input } from "@/ui/Field";
import { friendlyError } from "@/lib/errors";
import { setThemePreference, type ThemePreference } from "@/lib/theme";

/**
 * Universal product control in the conversation: theme, browsing market, profile name and
 * honest notices. Compact by design — a status line or a small review, never a settings page.
 * The theme is applied by this device and only then reported as done; market and profile
 * changes are server pending actions confirmed by the user in the conversation.
 */
export type ControlPayload = ProductControlPayload;
export function normalizeControl(value: unknown): ControlPayload | undefined {
  const parsed = ProductControlPayload.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The conversation whose messages are on screen (for device acknowledgements). */
export const ActiveConversationContext = createContext<string | undefined>(undefined);

const THEME_VALUE: Record<"LIGHT" | "DARK" | "SYSTEM", ThemePreference> = { LIGHT: "light", DARK: "dark", SYSTEM: "system" };
const THEME_ICON = { LIGHT: Sun, DARK: Moon, SYSTEM: Monitor } as const;

const REVIEW_STATUS: Record<string, string> = {
  AWAITING_CONFIRMATION: "بانتظار تأكيدك — لم يتغير شيء بعد",
  SUCCEEDED: "تم بعد تأكيدك",
  FAILED: "لم يُنفّذ؛ لم يتغير شيء",
  CANCELLED: "أُلغي؛ لم يتغير شيء",
  EXPIRED: "انتهت صلاحية التأكيد؛ لم يتغير شيء",
};

function ThemeStatus({ control, resultSetId, active }: { control: Extract<ControlPayload, { view: "APP_THEME" }>; resultSetId: string; active: boolean }) {
  const conversationId = useContext(ActiveConversationContext);
  const [status, setStatus] = useState(control.status);
  const started = useRef(false);
  useEffect(() => {
    // Only the newest request is applied, once; reloaded history shows its recorded outcome.
    if (!active || control.status !== "REQUESTED" || started.current) return;
    started.current = true;
    let applied = false;
    try {
      applied = setThemePreference(THEME_VALUE[control.clientAction.theme]);
    } catch {
      applied = false;
    }
    const outcome = applied ? "APPLIED" : "FAILED";
    setStatus(outcome);
    if (conversationId) void acknowledgeAiControlAction(conversationId, resultSetId, { status: outcome }).catch(() => undefined);
  }, [active, control, conversationId, resultSetId]);
  const Icon = THEME_ICON[control.clientAction.theme];
  const text = status === "APPLIED" ? `تم تفعيل ${control.label}.` : status === "FAILED" ? `تعذر تفعيل ${control.label} على هذا الجهاز. يمكنك تغييره من الإعدادات.` : `جارٍ تفعيل ${control.label}…`;
  return (
    <p role="status" data-testid="control-theme" data-status={status} className="ai-surface ai-control-chip">
      <Icon size={16} aria-hidden />
      <span>{text}</span>
      {status === "APPLIED" && <Check size={16} aria-hidden className="text-success" />}
    </p>
  );
}

function MarketSurface({ control, active, onSend }: { control: Extract<ControlPayload, { view: "MARKET_SWITCH_REVIEW" | "MARKET_SWITCH_STATUS" }>; active: boolean; onSend?: (text: string) => void }) {
  const { refresh, user } = useAccount();
  const conversationId = useContext(ActiveConversationContext);
  const queryClient = useQueryClient();
  const refreshed = useRef(false);
  useEffect(() => {
    // The server already switched and moved this conversation to the new market: keep it open
    // there, then refresh the header, listings and prices.
    if (control.view !== "MARKET_SWITCH_STATUS" || control.status !== "SUCCEEDED" || !active || refreshed.current) return;
    refreshed.current = true;
    try {
      if (user && conversationId) localStorage.setItem(`dinar-conversation:${user.id}:${control.to.marketId}`, conversationId);
    } catch {
      /* The conversation stays reachable from history. */
    }
    void refresh().finally(() => void queryClient.invalidateQueries());
  }, [active, control, conversationId, queryClient, refresh, user]);
  const review = control.view === "MARKET_SWITCH_REVIEW";
  return (
    <section dir="rtl" aria-label="سوق التصفح" data-testid="control-market" data-status={control.status} className="ai-surface space-y-3 text-sm">
      <h3 className="flex items-center gap-2 font-semibold"><Globe2 size={16} aria-hidden />{review ? "تغيير سوق التصفح" : "سوق التصفح"}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">من</dt>
        <dd><bdi>{control.from.countryNameAr}</bdi> · <bdi dir="ltr">{control.from.currencyCode}</bdi></dd>
        <dt className="text-muted-foreground">إلى</dt>
        <dd className="font-semibold"><bdi>{control.to.countryNameAr}</bdi> · <bdi dir="ltr">{control.to.currencyCode}</bdi></dd>
      </dl>
      {control.unchanged.length > 0 && (
        <ul className="list-inside list-disc text-xs text-muted-foreground">{control.unchanged.map((line) => <li key={line}>{line}</li>)}</ul>
      )}
      <p role="status" className="text-xs" data-testid="control-status">{control.notice ?? REVIEW_STATUS[control.status]}</p>
      {review && control.status === "AWAITING_CONFIRMATION" && active && onSend && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onSend("نعم، حوّل السوق")} data-testid="control-confirm">تأكيد</Button>
          <Button size="sm" variant="ghost" onClick={() => onSend("إلغاء")} data-testid="control-cancel">إلغاء</Button>
        </div>
      )}
    </section>
  );
}

function ProfileSurface({ control, active, onSend }: { control: Extract<ControlPayload, { view: "PROFILE_REVIEW" | "PROFILE_STATUS" }>; active: boolean; onSend?: (text: string) => void }) {
  const { refresh } = useAccount();
  const refreshed = useRef(false);
  useEffect(() => {
    if (control.view !== "PROFILE_STATUS" || control.status !== "SUCCEEDED" || !active || refreshed.current) return;
    refreshed.current = true;
    void refresh();
  }, [active, control, refresh]);
  const review = control.view === "PROFILE_REVIEW";
  return (
    <section dir="rtl" aria-label="بيانات الحساب" data-testid="control-profile" data-status={control.status} className="ai-surface space-y-3 text-sm">
      <h3 className="flex items-center gap-2 font-semibold"><UserRound size={16} aria-hidden />{review ? `تغيير ${control.fieldLabel}` : control.fieldLabel}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
        <dt className="text-muted-foreground">الحالي</dt>
        <dd dir="auto">{control.before}</dd>
        <dt className="text-muted-foreground">الجديد</dt>
        <dd dir="auto" className="font-semibold">{control.after}</dd>
      </dl>
      <p role="status" className="text-xs" data-testid="control-status">{control.notice ?? REVIEW_STATUS[control.status]}</p>
      {review && control.status === "AWAITING_CONFIRMATION" && active && onSend && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onSend("نعم، أكّد الاسم")} data-testid="control-confirm">تأكيد</Button>
          <Button size="sm" variant="ghost" onClick={() => onSend("إلغاء")} data-testid="control-cancel">إلغاء</Button>
        </div>
      )}
    </section>
  );
}

/**
 * Export of the user's own data. The password is typed into this form, sent straight to the
 * API for re-authentication and never becomes a chat message; the file is saved on the device.
 */
function PrivacyExport({ control }: { control: Extract<ControlPayload, { view: "PRIVACY_EXPORT" }> }) {
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"IDLE" | "BUSY" | "DONE" | "FAILED">("IDLE");
  const [error, setError] = useState("");
  const submit = async () => {
    setState("BUSY");
    setError("");
    try {
      const result = (await api("/account/privacy/exports", "POST", {
        currentPassword: password,
        idempotencyKey: `export-${crypto.randomUUID()}`,
      })) as { requestId: string; export: unknown };
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `dinar-data-${result.requestId.slice(0, 8)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setPassword("");
      setState("DONE");
    } catch (failure) {
      setError(friendlyError(failure));
      setState("FAILED");
    }
  };
  return (
    <section dir="rtl" aria-label="تصدير بياناتي" data-testid="control-privacy-export" data-status={state} className="ai-surface space-y-2 text-sm">
      <h3 className="flex items-center gap-2 font-semibold"><Download size={16} aria-hidden />تصدير بياناتي</h3>
      <p className="text-xs leading-5 text-muted-foreground">{control.includes.join(" · ")}</p>
      <p className="text-xs leading-5 text-muted-foreground">{control.notice}</p>
      {state === "DONE" ? (
        <p role="status" className="flex items-center gap-2 text-xs"><Check size={14} aria-hidden className="text-success" />حُفظ الملف على جهازك وسُجّل الطلب في «طلبات الخصوصية».</p>
      ) : (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (password) void submit(); }}>
          <Input type="password" value={password} autoComplete="current-password" maxLength={128} placeholder="كلمة المرور الحالية" aria-label="كلمة المرور الحالية" onChange={(event) => setPassword(event.target.value)} className="min-w-0 flex-1" data-testid="input-privacy-export-password" />
          <Button size="sm" type="submit" disabled={!password || state === "BUSY"} data-testid="button-privacy-export">{state === "BUSY" ? "جارٍ التصدير…" : "تصدير"}</Button>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </section>
  );
}

function Notice({ control, active, onSend }: { control: Extract<ControlPayload, { view: "CONTROL_NOTICE" }>; active: boolean; onSend?: (text: string) => void }) {
  return (
    <section dir="rtl" aria-label={control.title} data-testid="control-notice" data-tone={control.tone} className="ai-surface space-y-2 text-sm">
      <h3 className="flex items-center gap-2 font-semibold">
        {control.tone !== "INFO" && <CircleAlert size={16} aria-hidden className="shrink-0 text-muted-foreground" />}
        <span>{control.title}</span>
      </h3>
      {control.lines.map((line) => <p key={line} className="leading-6 text-muted-foreground">{line}</p>)}
      {control.options && active && onSend && (
        <div className="flex flex-wrap gap-2 pt-1">
          {control.options.map((option) => (
            <Button key={option.message} size="sm" variant="secondary" onClick={() => onSend(option.message)} data-testid="control-option">{option.label}</Button>
          ))}
        </div>
      )}
    </section>
  );
}

export function ControlSurface({ control, resultSetId, active, onSend }: { control: ControlPayload; resultSetId: string; active: boolean; onSend?: (text: string) => void }) {
  switch (control.view) {
    case "APP_THEME":
      return <ThemeStatus control={control} resultSetId={resultSetId} active={active} />;
    case "MARKET_SWITCH_REVIEW":
    case "MARKET_SWITCH_STATUS":
      return <MarketSurface control={control} active={active} onSend={onSend} />;
    case "PROFILE_REVIEW":
    case "PROFILE_STATUS":
      return <ProfileSurface control={control} active={active} onSend={onSend} />;
    case "PRIVACY_EXPORT":
      return <PrivacyExport control={control} />;
    default:
      return <Notice control={control} active={active} onSend={onSend} />;
  }
}
