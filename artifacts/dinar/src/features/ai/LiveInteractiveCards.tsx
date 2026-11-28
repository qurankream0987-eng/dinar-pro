import { memo } from "react";
import { COMPOSE_EVENT } from "./AnswerCards";
import { UniversalCardEngine } from "./infinite-cards/UniversalCardEngine";
import { isValidUniversalCardSpec } from "./infinite-cards/schema";
import { LiveDeliveryTrackerCard, type DeliveryStepState } from "./LiveDeliveryTrackerCard";
import { JassimGoSellCard, type GoSellOpportunityView } from "./JassimGoSellCard";
import { ConnectUrlQuickCard } from "../ConnectUrlQuickCard";

export const LIVE_INTERACTIVE_CARD_LANGUAGES = [
  "jassim-card",
  "jassim-delivery-tracker",
  "jassim-go-sell",
  "jassim-connect-url",
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
