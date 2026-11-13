import type { UniversalCard } from "@workspace/api-zod/connect";
import type { ComposedSurfaceInput, SurfaceSection } from "@workspace/api-zod/surface-composition";

function money(value: UniversalCard["price"]): string {
  if (!value) return "غير معروف";
  const minor = BigInt(value.amountMinor), base = 10n ** BigInt(value.minorUnitScale);
  return `${minor / base}${value.minorUnitScale ? "." + (minor % base).toString().padStart(value.minorUnitScale, "0") : ""} ${value.currency}`;
}
export function universalCardSurface(card: UniversalCard, resultSetId: string): ComposedSurfaceInput {
  const domain = card.domain;
  const description = (card.description ?? "").trim();
  const facts = card.facts.filter(fact => fact.label.trim());
  const longFacts = facts.filter(fact => (fact.value?.trim().length ?? 0) > 120);
  const status = card.availability === "AVAILABLE" ? "متاح وقت الفحص" : card.availability === "UNAVAILABLE" ? "غير متاح وقت الفحص" : "لم يُتحقق من التوفر";
  const rows = [
    ...facts.filter(fact => (fact.value?.trim().length ?? 0) <= 120).map(fact => ({ label: fact.label, value: fact.value?.trim() || "غير معروف" })),
    { label: "التوفر", value: status },
    ...(domain ? [{ label: "السنة الأولى", value: money(domain.registrationPrice) }, { label: "التجديد السنوي", value: money(domain.renewalPrice) }, { label: "نطاق مميز (Premium)", value: domain.premium === null ? "غير معروف" : domain.premium ? "نعم؛ تحقق من شروط المزوّد" : "لا حسب فحص المزوّد" }] : [{ label: "السعر", value: money(card.price) }]),
    { label: "آخر فحص", value: card.checkedAt ? new Date(card.checkedAt).toLocaleString("ar") : "لم يحدث فحص مباشر" },
  ];
  const sections: SurfaceSection[] = [
    { type: "header", title: card.title.slice(0,120), ...(description && description.length <= 240 ? { subtitle: description } : {}), source: card.sourceLabel.slice(0,80), badge: { label: "خارج جاسم", tone: "INFO" }, icon: "INFO" },
    ...(description.length > 240 ? [{ type: "text" as const, text: description }] : []),
    { type: "facts", rows },
    ...longFacts.map(fact => ({ type: "text" as const, text: `${fact.label}: ${fact.value}` })),
    ...(domain && domain.providerMode === "SANDBOX" ? [{ type: "notice" as const, tone: "WARNING" as const, text: "بيانات بيئة اختبار للمزوّد (Sandbox)، وليست عرض تسجيل حيًا." }] : []),
    ...(domain && ["RATE_LIMITED", "TIMEOUT", "UNAVAILABLE", "UNAUTHORIZED", "INVALID_RESPONSE"].includes(domain.status) ? [{ type: "notice" as const, tone: "WARNING" as const, text: domain.status === "RATE_LIMITED" ? "وصل المزوّد إلى حد الطلبات؛ لم نخمّن التوفر أو السعر." : "لم يكتمل التحقق من المزوّد؛ البيانات غير المتحققة تبقى غير معروفة." }] : []),
    { type: "notice", tone: "INFO", text: card.disclosure ?? "الشراء لدى المزوّد خارج جاسم." },
    { type: "actions", items: card.externalActions.map((action,index) => ({ kind: "EXTERNAL_LINK", label: action.label.slice(0,80), providerId: action.providerId, resultSetId, cardId: card.id, actionId: "EXTERNAL_LINK", emphasis: "SECONDARY", testId: `connect-external-${card.providerId}-${index}` })) },
  ];
  return { version: 1, label: "عرض مزوّد خارجي", size: "MEDIUM", state: "READY", testId: `connect-card-${card.providerId}`, sections };
}
