import { createContext, useContext, type ReactNode } from "react";
import {
  applyCardEnvelope,
  parseCardEnvelope,
  parseComposedSurface,
  surfaceAllowsActions,
  type CardEnvelope,
  type ComposedSurface,
  type SurfaceSection,
} from "@workspace/api-zod/surface-composition";
import {
  ActionRow,
  BarList,
  FactList,
  MetricGrid,
  MoneyBreakdown,
  OptionList,
  SurfaceCard,
  SurfaceHeader,
  SurfaceNotice,
  SurfaceText,
  Timeline,
  UsageMeter,
} from "./primitives";

/** States that are told plainly; the card never offers actions it can no longer honour. */
const STATE_NOTICE: Partial<Record<ComposedSurface["state"], { tone: "INFO" | "SUCCESS" | "WARNING" | "DANGER" }>> = {
  EMPTY: { tone: "INFO" },
  CONFIRMED: { tone: "SUCCESS" },
  CANCELLED: { tone: "WARNING" },
  EXPIRED: { tone: "WARNING" },
  UNAVAILABLE: { tone: "INFO" },
  DENIED: { tone: "DANGER" },
  FAILED: { tone: "DANGER" },
};
const STATE_TEXT: Partial<Record<ComposedSurface["state"], string>> = {
  EMPTY: "لا توجد بيانات لعرضها في هذه البطاقة.",
  CONFIRMED: "تم تنفيذ هذا الإجراء بعد تأكيدك.",
  CANCELLED: "أُلغي هذا الإجراء دون أي تغيير.",
  EXPIRED: "انتهت صلاحية هذه البطاقة؛ اطلبها من جديد في المحادثة لعرض الحالة الحالية.",
  UNAVAILABLE: "هذه الخدمة غير متاحة الآن.",
  DENIED: "لا تملك صلاحية عرض هذه البيانات.",
  FAILED: "تعذر تحميل هذه البطاقة الآن.",
};

/** The envelope travels with the message block; a panel nested inside it reads it here. */
const CardEnvelopeContext = createContext<CardEnvelope | undefined>(undefined);

export function CardEnvelopeProvider({ value, children }: { value?: unknown; children: ReactNode }) {
  const parsed = value === undefined ? undefined : parseCardEnvelope(value) ?? undefined;
  return <CardEnvelopeContext.Provider value={parsed}>{children}</CardEnvelopeContext.Provider>;
}

function InvalidCard() {
  return (
    <SurfaceCard label="بطاقة غير متاحة" tone="WARNING" state="INVALID" testId="composed-surface-invalid">
      <SurfaceNotice tone="WARNING" text="تعذر عرض هذه البطاقة. يمكنك إعادة الطلب في المحادثة." />
    </SurfaceCard>
  );
}

function Section({ section, onSend }: { section: SurfaceSection; onSend?: (text: string) => void }) {
  switch (section.type) {
    case "header":
      return <SurfaceHeader {...section} />;
    case "text":
      return <SurfaceText text={section.text} muted={section.muted} testId={section.testId} />;
    case "facts":
      return <FactList rows={section.rows} />;
    case "metrics":
      return <MetricGrid label={section.label} items={section.items} />;
    case "meter":
      return <UsageMeter label={section.label} used={section.used} limit={section.limit} testId={section.testId} />;
    case "money":
      return <MoneyBreakdown lines={section.lines} total={section.total} disclosure={section.disclosure} />;
    case "timeline":
      return <Timeline label={section.label} steps={section.steps} />;
    case "bars":
      return <BarList label={section.label} items={section.items} />;
    case "options":
      return <OptionList label={section.label} layout={section.layout} items={section.items} onSend={onSend} />;
    case "notice":
      return <SurfaceNotice tone={section.tone} text={section.text} testId={section.testId} />;
    case "actions":
      return <ActionRow items={section.items} onSend={onSend} />;
  }
}

/**
 * Renders a validated composition with the shared primitives. An invalid composition is not
 * rendered in part: a small notice replaces it and the conversation carries on.
 * `envelope` is the server's versioned decision for this card; without one, an older stored
 * card keeps its legacy contract. A terminal or unsupported envelope never renders an action.
 * `active` is false on older cards, which then show their data without live actions.
 */
export function ComposedSurfaceView({
  surface,
  envelope,
  active,
  onSend,
}: {
  surface: unknown;
  envelope?: unknown;
  active: boolean;
  onSend?: (text: string) => void;
}) {
  const contextEnvelope = useContext(CardEnvelopeContext);
  const supplied = envelope !== undefined ? envelope : contextEnvelope;
  const parsedEnvelope = supplied === undefined ? undefined : parseCardEnvelope(supplied);
  const parsed = parseComposedSurface(surface);
  if (!parsed || (supplied !== undefined && !parsedEnvelope)) return <InvalidCard />;
  const view = parsedEnvelope ? applyCardEnvelope(parsed, parsedEnvelope) : parsed;
  if (!view) return <InvalidCard />;
  const notice = STATE_NOTICE[view.state];
  // A composition that already explains its state (e.g. an outcome notice) is not repeated.
  const explainsState = view.sections.some((section) => section.type === "notice");
  const send = active && surfaceAllowsActions(view.state) ? onSend : undefined;
  return (
    <div className="ds-size" data-size={view.size}>
      <SurfaceCard
        label={view.label}
        tone={view.tone}
        state={view.state}
        status={view.status}
        testId={view.testId ?? "composed-surface"}
        card={
          parsedEnvelope
            ? {
                schemaVersion: parsedEnvelope.schemaVersion,
                surfaceId: parsedEnvelope.surfaceId,
                lifecycle: parsedEnvelope.status.lifecycle,
              }
            : undefined
        }
      >
        {view.sections.map((section, index) => (
          <Section key={index} section={section} onSend={send} />
        ))}
        {!explainsState && notice && STATE_TEXT[view.state] && <SurfaceNotice tone={notice.tone} text={STATE_TEXT[view.state]!} />}
      </SurfaceCard>
    </div>
  );
}
