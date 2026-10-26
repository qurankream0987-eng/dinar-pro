import type { ReactNode } from "react";
import { PendingNotice } from "./SmartSurfaces";
import { Check, Megaphone, Pause, Play, X } from "lucide-react";
import { Button } from "@/ui/Button";
import type { PromotionCampaign, PromotionPayload, PromotionPlan } from "./promotion-types";
import { conversationActionMessage } from "@workspace/api-zod/conversation-runtime";
import { FactList, SurfacePanel, factRows } from "./surface/primitives";

type Send = (text: string) => void;

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "بانتظار الدفع التجريبي",
  SCHEDULED: "مجدول",
  ACTIVE: "نشط",
  PAUSED: "موقوف مؤقتًا",
  EXPIRED: "منتهي",
  CANCELLED: "ملغى",
  PAYMENT_FAILED: "فشل الدفع التجريبي",
};

const day = (value: string) => new Date(value).toLocaleDateString("ar", { year: "numeric", month: "short", day: "numeric" });
const days = (count: number) => `${count} ${count === 1 ? "يوم" : count === 2 ? "يومان" : count <= 10 ? "أيام" : "يومًا"}`;

function SimulationNote() {
  return (
    <p className="mt-2 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground" data-testid="promotion-simulation-note">
      دفع تجريبي فقط (TEST_NO_TRANSFER): لا تُحوّل أموال حقيقية. لا تجديد تلقائي، ولا يتغير معدل العمولة على الطلبات.
    </p>
  );
}

function PlanRow({ plan, index, onChoose }: { plan: PromotionPlan; index: number; onChoose?: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 p-2.5" data-testid={`promotion-plan-${index + 1}`}>
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold">{plan.name}</p>
        <p className="text-xs text-muted-foreground">
          {days(plan.durationDays)} · <span className="num">{plan.priceLabel}</span>
        </p>
      </div>
      {onChoose && (
        <Button size="sm" variant="secondary" onClick={onChoose} aria-label={`اختيار خطة ${plan.name} لمدة ${days(plan.durationDays)}`}>
          اختيار
        </Button>
      )}
    </li>
  );
}

function CampaignFacts({ campaign }: { campaign: PromotionCampaign }) {
  return (
    <FactList
      rows={factRows([
        ["الإعلان", campaign.listingTitle],
        ["الحالة", <span key="s" data-testid="promotion-status" data-status={campaign.effectiveStatus}>{STATUS_LABELS[campaign.effectiveStatus] ?? campaign.effectiveStatus}</span>],
        ["الظهور", campaign.servingNote],
        ["المكان", campaign.placementLabel],
        ["المدة", days(campaign.durationDays)],
        ["السعر", <span key="p" className="num">{campaign.priceLabel}</span>],
        ["من", day(campaign.startsAt)],
        ["إلى", day(campaign.expiresAt)],
        ["التجديد", "لا تجديد تلقائي"],
      ])}
    />
  );
}

function CampaignActions({ campaign, send, ordinal }: { campaign: PromotionCampaign; send?: Send; ordinal?: number }) {
  if (!send) return null;
  const target = ordinal ? ` رقم ${ordinal}` : "";
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {campaign.canPause && (
        <Button size="sm" variant="secondary" icon={<Pause size={14} aria-hidden />} onClick={() => send(`أوقف الترويج${target}`)} data-testid={`promotion-pause${ordinal ? `-${ordinal}` : ""}`}>
          إيقاف مؤقت
        </Button>
      )}
      {campaign.canResume && (
        <Button size="sm" variant="primary" icon={<Play size={14} aria-hidden />} onClick={() => send(`استأنف الترويج${target}`)} data-testid={`promotion-resume${ordinal ? `-${ordinal}` : ""}`}>
          استئناف
        </Button>
      )}
      {campaign.canCancel && (
        <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => send(`ألغ الترويج${target}`)} data-testid={`promotion-cancel${ordinal ? `-${ordinal}` : ""}`}>
          إلغاء الحملة
        </Button>
      )}
      {ordinal && (
        <Button size="sm" variant="ghost" onClick={() => send(`تفاصيل الحملة رقم ${ordinal}`)} data-testid={`promotion-details-${ordinal}`}>
          التفاصيل
        </Button>
      )}
    </div>
  );
}

/**
 * Promotion cards (Block E). Every action sends the same conversational command a seller
 * could type, so one server authority decides; nothing here sets a price or a status.
 */
export function PromotionSurface({
  promotion,
  active,
  onSend,
}: {
  promotion: PromotionPayload;
  active: boolean;
  onSend?: Send;
}) {
  const send = active ? onSend : undefined;
  const { view } = promotion;
  const pending = promotion.action?.status === "PENDING";
  return (
    <section className="ai-surface mt-3 max-w-xl" aria-label="ترويج الإعلانات" data-testid={`promotion-surface-${view.toLowerCase()}`} data-view={view}>
      <SurfacePanel>
        <p className="flex items-center gap-1.5 text-sm font-bold">
          <Megaphone size={16} aria-hidden />
          {view === "PROMOTION_REVIEW"
            ? "مراجعة الترويج"
            : view === "MY_PROMOTIONS"
              ? "حملاتي"
              : view === "PROMOTION_DETAILS"
                ? "تفاصيل الحملة"
                : view === "PROMOTION_STATUS"
                  ? "حالة الترويج"
                  : "ترويج إعلان"}
        </p>
        {promotion.notice && (
          <p role="status" className="mt-2 break-words text-sm" data-testid="promotion-notice">
            {promotion.notice}
          </p>
        )}

        {view === "PROMOTION_OPTIONS" && promotion.step === "LISTING" && (
          <ol className="mt-2 space-y-2" data-testid="promotion-listings">
            {(promotion.listings ?? []).map((listing, index) => (
              <li key={listing.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 p-2.5" data-testid={`promotion-listing-${index + 1}`}>
                <p className="min-w-0 break-words text-sm font-semibold">
                  <span className="num text-muted-foreground">{index + 1}. </span>
                  {listing.title}
                </p>
                {listing.hasLivePromotion ? (
                  <span className="text-xs text-muted-foreground">لديه ترويج قائم</span>
                ) : (
                  send && (
                    <Button size="sm" variant="primary" onClick={() => send(conversationActionMessage("PROMOTE_LISTING", { position: index + 1 }))} aria-label={`ترويج ${listing.title}`}>
                      ترويج
                    </Button>
                  )
                )}
              </li>
            ))}
          </ol>
        )}

        {view === "PROMOTION_OPTIONS" && promotion.step === "PLAN" && (
          <>
            {promotion.listing && <p className="mt-2 break-words text-sm">الإعلان: {promotion.listing.title}</p>}
            <ul className="mt-2 space-y-2" data-testid="promotion-plans">
              {(promotion.plans ?? []).map((plan, index) => (
                <PlanRow key={plan.id} plan={plan} index={index} onChoose={send ? () => send(`الخيار ${index + 1}`) : undefined} />
              ))}
            </ul>
            <SimulationNote />
          </>
        )}

        {view === "PROMOTION_OPTIONS" && promotion.step === "INFO" && (
          <div className="mt-2 space-y-3" data-testid="promotion-plan-groups">
            {(promotion.planGroups ?? []).map((group) => (
              <div key={group.categoryId}>
                <p className="text-sm font-semibold">{group.categoryLabel}</p>
                <ul className="mt-1 space-y-2">
                  {group.plans.map((plan, index) => (
                    <PlanRow key={plan.id} plan={plan} index={index} />
                  ))}
                </ul>
              </div>
            ))}
            {!promotion.planGroups?.length && <p className="text-sm text-muted-foreground">لا توجد خطط ترويج مفعّلة في سوقك حاليًا.</p>}
            <SimulationNote />
          </div>
        )}

        {view === "PROMOTION_REVIEW" && promotion.review && (
          <div data-testid="promotion-review">
            <FactList
              rows={factRows([
                ["الإعلان", promotion.review.listingTitle],
                ["الخطة", promotion.review.plan.name],
                ["المكان", promotion.review.placementLabel],
                ["المدة", days(promotion.review.plan.durationDays)],
                ["السعر", <span key="price" className="num" data-testid="promotion-review-price">{promotion.review.plan.priceLabel}</span>],
                ["العملة", promotion.review.plan.currencyCode],
                ["البدء", promotion.review.startNote],
                ["الانتهاء", promotion.review.endNote],
                ["الشارة", `يظهر للمشترين مع شارة «${promotion.review.sponsoredLabel}»`],
              ])}
            />
            <SimulationNote />
            {pending && <PendingNotice>لم يُفعّل الترويج ولم يُدفع شيء — بانتظار تأكيدك.</PendingNotice>}
          </div>
        )}

        {promotion.promotion && (view === "PROMOTION_STATUS" || view === "PROMOTION_DETAILS" || view === "PROMOTION_REVIEW") && (
          <div data-testid="promotion-campaign">
            <CampaignFacts campaign={promotion.promotion} />
            {!pending && <CampaignActions campaign={promotion.promotion} send={send} />}
          </div>
        )}

        {view === "MY_PROMOTIONS" && (
          <ol className="mt-2 space-y-3" data-testid="my-promotions">
            {(promotion.promotions ?? []).map((campaign, index) => (
              <li key={campaign.id} className="rounded-lg bg-muted/40 p-2.5" data-testid={`my-promotion-${index + 1}`} data-status={campaign.effectiveStatus}>
                <p className="break-words text-sm font-semibold">
                  <span className="num text-muted-foreground">{index + 1}. </span>
                  {campaign.listingTitle}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {STATUS_LABELS[campaign.effectiveStatus] ?? campaign.effectiveStatus} · {days(campaign.durationDays)} ·{" "}
                  <span className="num">{campaign.priceLabel}</span> · حتى {day(campaign.expiresAt)}
                </p>
                <p className="mt-0.5 break-words text-xs">{campaign.servingNote}</p>
                <CampaignActions campaign={campaign} send={send} ordinal={index + 1} />
              </li>
            ))}
            {!promotion.promotions?.length && <li className="text-sm text-muted-foreground">لا توجد حملات.</li>}
          </ol>
        )}

        {promotion.action &&
          (pending && send ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="gold" icon={<Check size={14} aria-hidden />} onClick={() => send("تأكيد")} data-testid="promotion-confirm">
                {promotion.action.type === "PURCHASE" ? "تأكيد والدفع التجريبي" : "تأكيد إلغاء الحملة"}
              </Button>
              <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => send("إلغاء")} data-testid="promotion-cancel-review">
                {promotion.action.type === "PURCHASE" ? "إلغاء" : "تراجع"}
              </Button>
            </div>
          ) : (
            <p role="status" className="mt-2 text-sm text-muted-foreground" data-testid="promotion-action-status" data-status={promotion.action.status}>
              {promotion.action.statusLabel}
            </p>
          ))}
      </SurfacePanel>
    </section>
  );
}
