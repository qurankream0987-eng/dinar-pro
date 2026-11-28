import { memo } from "react";
import { COMPOSE_EVENT } from "./AnswerCards";
import { UniversalCardEngine } from "./infinite-cards/UniversalCardEngine";
import { isValidUniversalCardSpec } from "./infinite-cards/schema";
import { LiveDeliveryTrackerCard, type DeliveryStepState } from "./LiveDeliveryTrackerCard";
import { JassimGoSellCard, type GoSellOpportunityView } from "./JassimGoSellCard";
import { ConnectUrlQuickCard } from "../ConnectUrlQuickCard";
import { DealCardPanel, isDealCard } from "./DealCardPanel";

export const LIVE_INTERACTIVE_CARD_LANGUAGES = [
  "jassim-card",
  "jassim-delivery-tracker",
  "jassim-go-sell",
  "jassim-connect-url",
  "jassim-deal-payment",
  "jassim-seller-classification",
  "jassim-merchant-policy",
] as const;

export type LiveInteractiveCardLanguage = (typeof LIVE_INTERACTIVE_CARD_LANGUAGES)[number];

export function isLiveInteractiveCardLanguage(lang: string): lang is LiveInteractiveCardLanguage {
  return (LIVE_INTERACTIVE_CARD_LANGUAGES as readonly string[]).includes(lang.trim().toLowerCase());
}

function dispatchChatCompose(text: string): void {
  if (typeof window === "undefined" || !text.trim()) return;
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: text.trim() }));
}

const VALID_DELIVERY_STATES = new Set<DeliveryStepState>([
  "ACCEPTED",
  "PREPARING",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "ARRIVED",
  "DELIVERED",
]);

const PROVENANCE_BADGES: Record<string, { label: string; cls: string }> = {
  STORE_SYSTEM: {
    label: "STORE_SYSTEM · من نظام المتجر مباشرة",
    cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  MERCHANT_POLICY: {
    label: "MERCHANT_POLICY · سياسة التاجر",
    cls: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  UNCONFIRMED: {
    label: "UNCONFIRMED · معلومة غير مؤكدة",
    cls: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  NEEDS_MERCHANT_APPROVAL: {
    label: "NEEDS_MERCHANT_APPROVAL · تحتاج موافقة التاجر",
    cls: "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
};

/**
 * Validated in-conversation interactive card renderer mounted directly inside
 * RichText -> AssistantBody -> MessageTurn in ConversationContent.tsx.
 * Never executes direct writes or payments; user actions dispatch through COMPOSE_EVENT.
 */
export const LiveInteractiveCard = memo(function LiveInteractiveCard({
  language,
  code,
}: {
  language: LiveInteractiveCardLanguage;
  code: string;
}) {
  if (!code || code.length > 16_000) return null;

  if (language === "jassim-connect-url") {
    return (
      <div className="my-3" data-testid="live-chat-connect-url-card">
        <ConnectUrlQuickCard onSubmitUrl={(host) => dispatchChatCompose(`اربط متجري ${host}`)} />
      </div>
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  if (language === "jassim-card") {
    if (!isValidUniversalCardSpec(parsed)) return null;
    return (
      <div className="my-3" data-testid="live-chat-universal-card">
        <UniversalCardEngine
          spec={parsed}
          onEvent={(ev) => {
            if (ev.action === "PRIMARY_CTA") {
              dispatchChatCompose(`اعتماد اختيار البطاقة ${parsed.title} (الكمية: ${ev.selection.quantity})`);
            }
          }}
        />
      </div>
    );
  }

  if (language === "jassim-deal-payment") {
    if (!isDealCard(parsed)) return null;
    return (
      <div className="my-3" data-testid="live-chat-deal-payment-wrapper">
        <DealCardPanel card={parsed} active={true} onSend={(msg) => dispatchChatCompose(msg)} />
      </div>
    );
  }

  if (language === "jassim-seller-classification") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.classificationLabelAr !== "string" || typeof obj.commissionLabelAr !== "string") return null;
    const signals = Array.isArray(obj.signals) ? (obj.signals as Array<{ key?: string; detail?: string }>) : [];
    const profit =
      obj.profitSharePreview && typeof obj.profitSharePreview === "object"
        ? (obj.profitSharePreview as Record<string, unknown>)
        : null;
    return (
      <section
        dir="rtl"
        lang="ar"
        data-testid="live-chat-seller-classification-card"
        className="my-3 w-full max-w-xl rounded-3xl border border-border/80 bg-card/95 p-5 text-card-foreground shadow-lg backdrop-blur-md"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <span className="text-xs font-medium text-muted-foreground">ذكاء تصنيف البائعين والعمولات</span>
            <h3 className="text-base font-bold">{obj.classificationLabelAr}</h3>
          </div>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            {obj.commissionLabelAr}
          </span>
        </header>
        {typeof obj.reasonAr === "string" && (
          <p className="mt-2.5 text-sm text-muted-foreground">السبب: {obj.reasonAr}</p>
        )}
        {signals.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {signals.map((sig, i) => (
              <li
                key={i}
                className="rounded-xl border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
              >
                {sig.detail ?? sig.key}
              </li>
            ))}
          </ul>
        )}
        {profit && (
          <div className="mt-3.5 rounded-2xl border border-sky-500/35 bg-sky-500/10 p-3 text-xs">
            <p className="font-semibold text-sky-700 dark:text-sky-300">
              معادلة Jassim Connect (10% من الربح المباشر بعد التكاليف المعتمدة والموثقة):
            </p>
            <p className="mt-1 text-muted-foreground">
              الربح المباشر الصافي: <strong>{String(profit.directProfitMinor ?? 0)}</strong> · حصة جاسم:{" "}
              <strong>{String(profit.jassimShareMinor ?? 0)}</strong> {String(profit.currencyCode ?? "")}
            </p>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => dispatchChatCompose("هذه مقتنياتي الشخصية ولست تاجرًا")}
            className="rounded-xl border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
          >
            تصريح: مقتنيات شخصية (0%)
          </button>
          <button
            type="button"
            onClick={() => dispatchChatCompose("أنا تاجر وأبيع كنشاط تجاري")}
            className="rounded-xl border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
          >
            تصريح: نشاط تجاري
          </button>
          <button
            type="button"
            onClick={() => dispatchChatCompose("أعترض على التصنيف")}
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-500/20 dark:text-amber-300"
          >
            أعترض على التصنيف
          </button>
        </div>
      </section>
    );
  }

  if (language === "jassim-merchant-policy") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.labelAr !== "string" || typeof obj.summaryAr !== "string") return null;
    const provKey = typeof obj.provenance === "string" ? obj.provenance : "MERCHANT_POLICY";
    const prov = PROVENANCE_BADGES[provKey] ?? PROVENANCE_BADGES.MERCHANT_POLICY!;
    const isProposed = obj.status !== "ACTIVE";
    return (
      <section
        dir="rtl"
        lang="ar"
        data-testid="live-chat-merchant-policy-card"
        className="my-3 w-full max-w-xl rounded-3xl border border-border/80 bg-card/95 p-5 text-card-foreground shadow-lg backdrop-blur-md"
      >
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <span className="text-xs font-medium text-muted-foreground">
              محرك سياسات المتجر الذكي {typeof obj.operatingModeLabelAr === "string" ? `· ${obj.operatingModeLabelAr}` : ""}
            </span>
            <h3 className="text-base font-bold">{obj.labelAr}</h3>
          </div>
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${prov.cls}`}>
            {prov.label}
          </span>
        </header>
        <p className="mt-3 rounded-2xl border border-border/60 bg-muted/30 p-3 text-sm font-medium">{obj.summaryAr}</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {isProposed ? "⚠️ مسودة مقترحة — لا تسري إلا بعد تأكيد التاجر الصريح" : "✓ سياسة فعّالة ومعتمدة من التاجر"}
          </span>
          {isProposed && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => dispatchChatCompose(`أؤكد تفعيل ${obj.labelAr}: ${obj.summaryAr}`)}
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/25 dark:text-emerald-300"
              >
                تأكيد وتفعيل السياسة
              </button>
              <button
                type="button"
                onClick={() => dispatchChatCompose(`تعديل ${obj.labelAr}`)}
                className="rounded-xl border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
              >
                تعديل
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  if (language === "jassim-delivery-tracker") {
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.orderRef !== "string" ||
      typeof obj.merchantName !== "string" ||
      typeof obj.status !== "string" ||
      !VALID_DELIVERY_STATES.has(obj.status as DeliveryStepState) ||
      typeof obj.etaLabel !== "string" ||
      typeof obj.remainingKmLabel !== "string" ||
      typeof obj.progressPercent !== "number"
    ) {
      return null;
    }
    return (
      <div className="my-3" data-testid="live-chat-delivery-tracker-card">
        <LiveDeliveryTrackerCard
          orderRef={obj.orderRef}
          merchantName={obj.merchantName}
          status={obj.status as DeliveryStepState}
          etaLabel={obj.etaLabel}
          remainingKmLabel={obj.remainingKmLabel}
          progressPercent={obj.progressPercent}
          courierName={typeof obj.courierName === "string" ? obj.courierName : undefined}
          courierRating={typeof obj.courierRating === "number" ? obj.courierRating : undefined}
          courierPhone={typeof obj.courierPhone === "string" ? obj.courierPhone : undefined}
          onQuickMessage={(msg) => dispatchChatCompose(msg)}
        />
      </div>
    );
  }

  if (language === "jassim-go-sell") {
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.merchantName !== "string" ||
      typeof obj.budgetLabel !== "string" ||
      typeof obj.durationLabel !== "string" ||
      typeof obj.adHeadline !== "string" ||
      typeof obj.adBody !== "string" ||
      !Array.isArray(obj.opportunities)
    ) {
      return null;
    }
    const opportunities: GoSellOpportunityView[] = obj.opportunities
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item, idx) => ({
        listingId: typeof item.listingId === "string" ? item.listingId : `opp-${idx}`,
        title: typeof item.title === "string" ? item.title : "عرض مقترح",
        placementLabel: typeof item.placementLabel === "string" ? item.placementLabel : "إعلان مميز",
        rationaleAr: typeof item.rationaleAr === "string" ? item.rationaleAr : "",
        demandBadge: typeof item.demandBadge === "string" ? item.demandBadge : null,
      }));
    return (
      <div className="my-3" data-testid="live-chat-go-sell-card">
        <JassimGoSellCard
          merchantName={obj.merchantName}
          budgetLabel={obj.budgetLabel}
          durationLabel={obj.durationLabel}
          adHeadline={obj.adHeadline}
          adBody={obj.adBody}
          opportunities={opportunities}
          onApproveMandate={() => dispatchChatCompose(`أوافق على مسودة حملة جاسم روح بيع لي لـ ${obj.merchantName}`)}
        />
      </div>
    );
  }

  return null;
});
