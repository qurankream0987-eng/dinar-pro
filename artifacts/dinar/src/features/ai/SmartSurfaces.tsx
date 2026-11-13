import { Clock3, ShoppingBag } from "lucide-react";
import { Button } from "@/ui/Button";
import { ComposedSurfaceView } from "./surface/ComposedSurface";
import { negotiationSurface, type Negotiation } from "./surface/commerce-adapters";

/**
 * G2/G3 typed surfaces. Server-built, allowlisted views only: grounded advice (with the
 * scope of data it rests on), clarification choices and price negotiation (review, status,
 * list). Every button sends the same words a user could type; nothing here changes state
 * on its own, and every value is rendered as text.
 */

/** One shared statement for every review: nothing has happened yet. */
export function PendingNotice({ children = "لم يُنفذ بعد — بانتظار تأكيدك." }: { children?: string }) {
  return (
    <p role="status" className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-foreground" data-testid="pending-notice">
      <Clock3 size={13} aria-hidden />
      {children}
    </p>
  );
}

type Option = { label: string; message: string };
type Advice = {
  kind?: string;
  scope?: string;
  label?: string;
  topic?: string;
  recommendation?: { position: number; title: string };
  reasons?: string[];
  unknowns?: string[];
  stats?: { count: number; minMinor?: number | null; maxMinor?: number | null; medianMinor?: number | null; minorUnitScale?: number };
  options?: Option[];
};

export function isAdvice(value: unknown): value is Advice {
  return Boolean(value && typeof value === "object" && typeof (value as Advice).kind === "string");
}

const SCOPE_LABEL: Record<string, string> = {
  DINAR_INTERNAL: "من عروض جاسم الحالية",
  GENERAL_KNOWLEDGE: "معلومة عامة وليست من بيانات جاسم",
  DINAR_CAPABILITY: "عن خدمات جاسم",
  // R3E: model narration in a commercial turn, and the server's restatement of its ledger.
  ASSISTANT_TEXT: "ردّ المساعد — ليس تأكيدًا لأي إجراء؛ الحالة المؤكدة في «سجل جاسم» فقط",
  DINAR_LEDGER: "من سجل جاسم",
};

function Grounding({ stats }: { stats: NonNullable<Advice["stats"]> }) {
  // Minor units and the market scale come from the server; trailing zeros are trimmed.
  const scale = stats.minorUnitScale ?? 3;
  const amount = (minor: number) => String(Number((minor / 10 ** scale).toFixed(scale)));
  if (!stats.count) return <p className="mt-1 text-xs text-muted-foreground">لا توجد عروض مشابهة كافية داخل جاسم للمقارنة.</p>;
  return (
    <p className="mt-1 text-xs text-muted-foreground" data-testid="advice-grounding">
      اعتمدت على <span className="num">{stats.count}</span> {stats.count === 1 ? "عرض مشابه" : "عروض مشابهة"} داخل جاسم
      {stats.minMinor != null && stats.maxMinor != null && (
        <>
          {" · "}النطاق <span className="num" dir="ltr">{amount(stats.minMinor)}–{amount(stats.maxMinor)}</span>
        </>
      )}
      {stats.medianMinor != null && (
        <>
          {" · "}الوسيط <span className="num">{amount(stats.medianMinor)}</span>
        </>
      )}
    </p>
  );
}

/** 2–4 server-provided choices; each sends the same words a user would type. */
export function ClarificationOptions({ options, active, onSend }: { options: Option[]; active: boolean; onSend?: (text: string) => void }) {
  if (!options.length || !active || !onSend) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="اختر أحد الخيارات" data-testid="clarification-options">
      {options.slice(0, 4).map((option) => (
        <Button key={option.message} size="sm" variant="secondary" className="max-w-full" onClick={() => onSend(option.message)}>
          <span className="min-w-0 truncate">{option.label}</span>
        </Button>
      ))}
    </div>
  );
}

const adviceScope = (advice: Advice) =>
  advice.topic === "MARKETING_COPY" ? "مبني على بيانات إعلانك في جاسم" : advice.scope ? SCOPE_LABEL[advice.scope] : undefined;

/** The provenance label when that is all the advice says; the message shows it with its actions. */
export function adviceChipLabel(value: unknown): string | undefined {
  if (!isAdvice(value)) return undefined;
  const scope = adviceScope(value);
  return scope && !value.recommendation && !value.reasons?.length && !value.unknowns?.length && !value.stats && !value.options?.length
    ? scope
    : undefined;
}

export function AdvicePanel({ advice, active = false, onSend }: { advice: Advice; active?: boolean; onSend?: (text: string) => void }) {
  const scope = adviceScope(advice);
  const hasBody = Boolean(scope || advice.recommendation || advice.reasons?.length || advice.unknowns?.length || advice.stats || advice.options?.length);
  if (!hasBody) return null;
  // A provenance label alone is a compact chip, not an empty card.
  if (scope && !advice.recommendation && !advice.reasons?.length && !advice.unknowns?.length && !advice.stats && !advice.options?.length)
    return (
      <p className="ai-scope-chip" data-testid="advice" data-scope={advice.scope} data-kind={advice.kind}>
        {scope}
      </p>
    );
  return (
    <section className="ai-surface mt-3 max-w-xl rounded-xl border border-border bg-card p-3 text-sm" aria-label="نصيحة" data-testid="advice" data-scope={advice.scope} data-kind={advice.kind}>
      {scope && <p className="text-xs font-semibold text-muted-foreground">{scope}</p>}
      {advice.stats && <Grounding stats={advice.stats} />}
      {advice.recommendation && (
        <p className="mt-1 break-words font-semibold" data-testid="advice-recommendation">
          <span className="num rounded-md bg-muted px-1.5 py-0.5 text-xs">#{advice.recommendation.position}</span> {advice.recommendation.title}
        </p>
      )}
      {!!advice.reasons?.length && (
        <ul className="mt-2 list-disc ps-5 text-muted-foreground">
          {advice.reasons.map((reason) => (
            <li key={reason} className="break-words">{reason}</li>
          ))}
        </ul>
      )}
      {!!advice.unknowns?.length && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="advice-unknowns">غير مذكور في الإعلان: {advice.unknowns.join("، ")}</p>
      )}
      {advice.recommendation && active && onSend && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<ShoppingBag size={14} aria-hidden />} onClick={() => onSend(`خذ رقم ${advice.recommendation!.position}`)} data-testid="advice-take">
            مراجعة شراء #{advice.recommendation.position}
          </Button>
        </div>
      )}
      <ClarificationOptions options={advice.options ?? []} active={active} onSend={onSend} />
    </section>
  );
}

export function isNegotiation(value: unknown): value is Negotiation {
  return Boolean(value && typeof value === "object" && ["REVIEW", "STATUS", "LIST", "UNAVAILABLE", "HYPOTHETICAL"].includes(String((value as Negotiation).view)));
}

/** Price negotiation (review, status, list) composed from the shared surface primitives. */
export function NegotiationPanel({ negotiation, active, onSend }: { negotiation: Negotiation; active: boolean; onSend?: (text: string) => void }) {
  return <ComposedSurfaceView surface={negotiationSurface(negotiation)} active={active} onSend={onSend} />;
}
