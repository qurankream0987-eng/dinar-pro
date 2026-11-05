/**
 * DINAR's self-knowledge for the model: what the platform can and cannot do, authored by the
 * server. The model answers "can DINAR do X?" from this list instead of guessing, and never
 * promises an action that is not listed as available. Read only; nothing here authorizes an action.
 */
import { CAPABILITY_REGISTRY } from "./capability-registry";

export type DinarCapabilityCatalog = {
  version: 1;
  market: { id: string; currency: string };
  available: { name: string; summary: string; requiresConfirmation: boolean }[];
  external: { name: string; summary: string }[];
  notAvailable: { topic: string; reason: string }[];
  rules: string[];
};

/** External (DINAR Connect) capabilities are the registered ones served by connect/ services. */
const isExternal = (canonicalService: string) => canonicalService.startsWith("connect/");

const NOT_AVAILABLE = [
  { topic: "تحويل الأموال أو الدفع الفوري", reason: "الدفع داخل DINAR محاكاة حاليًا؛ لا يحوّل DINAR أموالًا ولا يؤكد دفعًا دون إيصال من الخادم." },
  { topic: "حجز المواعيد مباشرة", reason: "لا توجد قدرة حجز داخلية؛ يمكن البحث عن شريك يقدم الحجز، والحجز يتم لديه." },
  { topic: "تسجيل نطاق أو شراء خدمة خارجية نيابة عن المستخدم", reason: "DINAR يعرض العروض ويفتح رابط المزوّد فقط." },
  { topic: "قبول اتفاقيات أو تفعيل أسواق أو دول", reason: "قرارات إدارية وقانونية لا ينفذها المساعد." },
];

const RULES = [
  "أي إضافة للسلة أو طلب أو تفاوض أو نشر إعلان تُجهَّز كمراجعة، وتحتاج تأكيد المستخدم الصريح والتحقق في الخادم.",
  "الأسعار والمخزون والعمولات من سجلات DINAR فقط؛ القيم غير المعروفة تبقى غير معروفة.",
  "نتائج الشركاء والنطاقات معلومات طرف ثالث وقت الفحص، وليست عروض DINAR الداخلية.",
];

export function dinarCapabilityCatalog(market: { id: string; currency?: string | null }): DinarCapabilityCatalog {
  // Derived from the authorized registry on every call: no capability can be described that
  // the server does not register, and every registered model capability is described.
  const modelCapabilities = Object.values(CAPABILITY_REGISTRY).filter((capability) => capability.availability === "MODEL_TOOL");
  const available = modelCapabilities
    .filter((capability) => !isExternal(capability.canonicalService))
    .map((capability) => ({
      name: capability.toolName,
      summary: capability.purpose,
      requiresConfirmation: capability.confirmation === "USER_CONFIRMATION" || capability.mutation !== "READ_ONLY",
    }));
  const external = modelCapabilities
    .filter((capability) => isExternal(capability.canonicalService))
    .map((capability) => ({ name: capability.toolName, summary: capability.purpose }));
  return {
    version: 1,
    market: { id: market.id, currency: (market as { currencyCode?: string }).currencyCode ?? market.currency ?? "" },
    available,
    external,
    notAvailable: NOT_AVAILABLE,
    rules: RULES,
  };
}
