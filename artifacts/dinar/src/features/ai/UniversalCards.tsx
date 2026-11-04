import { UniversalCardsPayloadSchema, type UniversalCard } from "@workspace/api-zod/connect";
import type { ComposedSurfaceInput, SurfaceSection } from "@workspace/api-zod/surface-composition";
import { ComposedSurfaceView } from "./surface/ComposedSurface";

function money(value: UniversalCard["price"]): string {
  return value ? `${(value.amountMinor / 10 ** value.minorUnitScale).toFixed(value.minorUnitScale)} ${value.currency}` : "غير معروف";
}
function surface(card: UniversalCard, resultSetId: string): ComposedSurfaceInput {
  const domain = card.domain;
  const status = card.availability === "AVAILABLE" ? "متاح وقت الفحص" : card.availability === "UNAVAILABLE" ? "غير متاح وقت الفحص" : "لم يُتحقق من التوفر";
  const rows = [
    ...card.facts.map(fact => ({ label: fact.label, value: fact.value ?? "غير معروف" })),
    { label: "التوفر", value: status },
    ...(domain ? [{ label: "السنة الأولى", value: money(domain.registrationPrice) }, { label: "التجديد السنوي", value: money(domain.renewalPrice) }, { label: "نطاق مميز (Premium)", value: domain.premium === null ? "غير معروف" : domain.premium ? "نعم؛ تحقق من شروط المزوّد" : "لا حسب فحص المزوّد" }] : [{ label: "السعر", value: money(card.price) }]),
    { label: "آخر فحص", value: card.checkedAt ? new Date(card.checkedAt).toLocaleString("ar") : "لم يحدث فحص مباشر" },
  ];
  const sections: SurfaceSection[] = [
    { type: "header", title: card.title.slice(0,120), subtitle: card.description, source: card.sourceLabel.slice(0,80), badge: { label: "خارج DINAR", tone: "INFO" }, icon: "INFO" },
    { type: "facts", rows },
    ...(domain && domain.providerMode === "SANDBOX" ? [{ type: "notice" as const, tone: "WARNING" as const, text: "بيانات بيئة اختبار للمزوّد (Sandbox)، وليست عرض تسجيل حيًا." }] : []),
    ...(domain && ["RATE_LIMITED", "TIMEOUT", "UNAVAILABLE", "UNAUTHORIZED", "INVALID_RESPONSE"].includes(domain.status) ? [{ type: "notice" as const, tone: "WARNING" as const, text: domain.status === "RATE_LIMITED" ? "وصل المزوّد إلى حد الطلبات؛ لم نخمّن التوفر أو السعر." : "لم يكتمل التحقق من المزوّد؛ البيانات غير المتحققة تبقى غير معروفة." }] : []),
    { type: "notice", tone: "INFO", text: card.disclosure ?? "الشراء لدى المزوّد خارج DINAR." },
    { type: "actions", items: card.externalActions.map((action,index) => ({ kind: "EXTERNAL_LINK", label: action.label, providerId: action.providerId, resultSetId, cardId: card.id, actionId: "EXTERNAL_LINK", emphasis: "SECONDARY", testId: `connect-external-${card.providerId}-${index}` })) },
  ];
  return { version: 1, label: "عرض مزوّد خارجي", size: "MEDIUM", state: "READY", testId: `connect-card-${card.providerId}`, sections };
}
export function UniversalCards({ payload, resultSetId }: { payload: unknown; resultSetId: string }) {
  const parsed = UniversalCardsPayloadSchema.safeParse(payload);
  if (!parsed.success) return <p role="status">تعذر التحقق من بيانات البطاقات؛ أعد البحث.</p>;
  return <section aria-label="نتائج المزوّدين الخارجيين" className="mt-3 min-w-0 max-w-full" data-testid="connect-results">
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{parsed.data.cards.map(card => <ComposedSurfaceView key={card.id} surface={surface(card,resultSetId)} active />)}</div>
    <p className="mt-3 text-sm text-muted-foreground">{parsed.data.note}</p>
    {parsed.data.comparisonNote && <p className="mt-2 text-sm text-muted-foreground">{parsed.data.comparisonNote}</p>}
  </section>;
}
