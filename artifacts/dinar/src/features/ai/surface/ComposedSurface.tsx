import { parseComposedSurface, type ComposedSurface, type SurfaceSection } from "@workspace/api-zod/surface-composition";
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
const STATE_NOTICE: Partial<Record<ComposedSurface["state"], { tone: "INFO" | "WARNING" | "DANGER"; text: string; actions: boolean }>> = {
  EMPTY: { tone: "INFO", text: "لا توجد بيانات لعرضها في هذه البطاقة.", actions: true },
  EXPIRED: { tone: "WARNING", text: "انتهت صلاحية هذه البطاقة؛ اطلبها من جديد في المحادثة لعرض الحالة الحالية.", actions: false },
  UNAVAILABLE: { tone: "INFO", text: "هذه الخدمة غير متاحة الآن.", actions: true },
  DENIED: { tone: "DANGER", text: "لا تملك صلاحية عرض هذه البيانات.", actions: false },
  FAILED: { tone: "DANGER", text: "تعذر تحميل هذه البطاقة الآن.", actions: true },
};

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
 * `active` is false on older cards, which then show their data without live actions.
 */
export function ComposedSurfaceView({
  surface,
  active,
  onSend,
}: {
  surface: unknown;
  active: boolean;
  onSend?: (text: string) => void;
}) {
  const parsed = parseComposedSurface(surface);
  if (!parsed)
    return (
      <SurfaceCard label="بطاقة غير متاحة" tone="WARNING" state="INVALID" testId="composed-surface-invalid">
        <SurfaceNotice tone="WARNING" text="تعذر عرض هذه البطاقة. يمكنك إعادة الطلب في المحادثة." />
      </SurfaceCard>
    );
  const notice = STATE_NOTICE[parsed.state];
  const send = active && (notice?.actions ?? true) ? onSend : undefined;
  return (
    <div className="ds-size" data-size={parsed.size}>
      <SurfaceCard label={parsed.label} tone={parsed.tone} state={parsed.state} status={parsed.status} testId={parsed.testId ?? "composed-surface"}>
        {parsed.sections.map((section, index) => (
          <Section key={index} section={section} onSend={send} />
        ))}
        {notice && <SurfaceNotice tone={notice.tone} text={notice.text} />}
      </SurfaceCard>
    </div>
  );
}
