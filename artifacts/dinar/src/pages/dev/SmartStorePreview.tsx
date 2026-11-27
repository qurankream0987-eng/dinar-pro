/**
 * Unified Apple-Grade Preview Hub (UI-05 + UI-06 + UI-15 + Universal OS + Jassim Ads Go-Sell).
 * Zero-conflict integration of all interactive chat cards and studio fixtures.
 */
import { useState } from "react";
import { SmartStoreCard } from "@workspace/api-zod/smart-store-card";
import { SMART_STORE_FIXTURES } from "@workspace/api-zod/smart-store-card-fixtures";
import { SmartStoreCardView } from "../../features/ai/smart-store/SmartStoreCardView";
import { useLiveSmartStoreCard } from "../../features/ai/smart-store/useLiveSmartStoreCard";
import {
  InChatPaymentCard,
  type InChatPaymentState,
} from "../../features/ai/smart-store/InChatPaymentCard";
import { UniversalCardEngine } from "../../features/ai/infinite-cards/UniversalCardEngine";
import { INFINITE_CARD_DEMO_SPECS } from "../../features/ai/infinite-cards/fixtures";
import { LiveDeliveryTrackerCard } from "../../features/ai/LiveDeliveryTrackerCard";
import { ConnectUrlQuickCard } from "../../features/ConnectUrlQuickCard";
import { JassimGoSellCard } from "../../features/ai/JassimGoSellCard";

const PAYMENT_PREVIEW_STATES: { status: InChatPaymentState; label: string }[] = [
  { status: "AVAILABLE", label: "متاح للدفع" },
  { status: "UNAVAILABLE_IN_COUNTRY", label: "غير متاح في الدولة" },
  { status: "PENDING", label: "قيد المعالجة" },
  { status: "PAID", label: "مدفوع" },
  { status: "FAILED", label: "فشل الدفع" },
  { status: "REFUNDED", label: "مسترد" },
];

function LiveCard({ initial }: { initial: SmartStoreCard }) {
  const live = useLiveSmartStoreCard(initial);
  return (
    <>
      <SmartStoreCardView card={live.card} onEvent={live.send} busy={live.busy} />
      {live.error && <p role="alert" className="text-xs text-destructive">{live.error}</p>}
    </>
  );
}

export default function SmartStorePreview() {
  const [listingId, setListingId] = useState("");
  const [live, setLive] = useState<SmartStoreCard>();
  const [error, setError] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<InChatPaymentState>("AVAILABLE");

  const issue = async () => {
    setError("");
    const response = await fetch("/api/smart-store/cards", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listingIds: [listingId.trim()] }),
    });
    const parsed = SmartStoreCard.safeParse(await response.json().catch(() => null));
    if (parsed.success) setLive(parsed.data);
    else setError("تعذر إنشاء البطاقة (سجّل الدخول واستخدم معرّف منتج منشور).");
  };

  return (
    <main dir="rtl" className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      <header className="rounded-2xl border border-amber-400/35 bg-gradient-to-l from-[#071830] via-[#0f3063] to-[#081d3b] p-5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_42px_-14px_rgba(0,0,0,0.55)]">
        <h1 className="text-xl font-extrabold tracking-tight">
          مركز معاينة بطاقات جاسم التفاعلية (إصدار Apple المصقول)
        </h1>
        <p className="mt-1 text-xs text-sky-100/85">
          يجمع كل البطاقات التفاعلية داخل المحادثة: المتجر المصغّر، الاستوديو اللانهائي ثلاثي الطبقات، الدفع، التتبع المباشر، الربط الفوري، و«جاسم روح بيع لي».
        </p>
      </header>

      {/* 1. Universal Infinite Card Studio (Burger, Mannequin, Watch) */}
      <section className="space-y-4" aria-label="محرك البطاقات اللانهائي">
        <div>
          <h2 className="text-base font-extrabold text-foreground">
            1. استوديو البطاقات التفاعلية اللانهائي (Burger · Mannequin · Watch Studio)
          </h2>
          <p className="text-xs text-muted-foreground">
            تدرجات ثلاثية الأبعاد وفيزياء نابض حقيقية (Framer Motion layout) لكل طبقة وقطعة ولون.
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {INFINITE_CARD_DEMO_SPECS.map((spec) => (
            <UniversalCardEngine key={spec.cardId} spec={spec} />
          ))}
        </div>
      </section>

      {/* 2. Jassim Go-Sell Smart Marketing Manager Card */}
      <section className="space-y-3" aria-label="جاسم روح بيع لي">
        <h2 className="text-base font-extrabold text-foreground">
          2. بطاقة «جاسم روح بيع لي» (Jassim Ads Smart Mandate)
        </h2>
        <JassimGoSellCard
          merchantName="متجر النخبة للإلكترونيات"
          budgetLabel="45.000 KWD"
          durationLabel="7 أيام"
          adHeadline="عروض حصرية في الكويت — توصيل فوري وضمان رسمي"
          adBody="اكتشف أحدث الأجهزة الذكية بأسعار معتمدة مباشرة من المتجر داخل محادثة جاسم."
          opportunities={[
            {
              listingId: "demo-1",
              title: "سماعة لاسلكية احترافية عازلة للضوضاء",
              placementLabel: "إعلان مميز + مطابقة الطلبات",
              rationaleAr: "المخزون متوفر (14 قطعة) والطلب نشط في فئة السماعات هذا الأسبوع.",
              demandBadge: "+24 طلب بحث نشط في السوق",
            },
          ]}
          analytics={{ impressions: 1420, clicks: 118, ctrLabel: "8.3%", attributedOrders: 9 }}
        />
      </section>

      {/* 3. Single-Conversation Live Delivery Tracker & Instant URL Connect */}
      <section className="space-y-4" aria-label="التتبع المباشر والربط الفوري">
        <h2 className="text-base font-extrabold text-foreground">
          3. التتبع الحي للمندوب والربط الفوري بالرابط داخل المحادثة
        </h2>
        <div className="grid gap-5 md:grid-cols-2">
          <LiveDeliveryTrackerCard
            orderRef="ORD-8492"
            merchantName="برغر فاكتوري · فرع السالمية"
            status="OUT_FOR_DELIVERY"
            etaLabel="11 دقيقة"
            remainingKmLabel="2.4 كم"
            progressPercent={68}
            courierName="كابتن فهد العتيبي"
            courierRating={4.9}
            courierPhone="+96550000000"
            pickupCoords={{ lat: 29.3375, lng: 48.0758 }}
            courierCoords={{ lat: 29.3482, lng: 48.0612 }}
            dropoffCoords={{ lat: 29.3591, lng: 48.0495 }}
          />
          <ConnectUrlQuickCard />
        </div>
      </section>

      {/* 4. In-Chat Payment 6-State Interactive Preview */}
      <section className="space-y-3" aria-label="بطاقة الدفع داخل المحادثة">
        <h2 className="text-base font-extrabold text-foreground">
          4. بطاقة الدفع داخل المحادثة (الحالات الست الكاملة)
        </h2>
        <div className="flex flex-wrap gap-2">
          {PAYMENT_PREVIEW_STATES.map((item) => (
            <button
              key={item.status}
              type="button"
              onClick={() => setPaymentStatus(item.status)}
              data-testid={`preview-payment-state-${item.status}`}
              className={`pressable min-h-9 rounded-full border px-3 text-xs font-semibold transition ${
                paymentStatus === item.status
                  ? "border-amber-400 bg-amber-500/15 text-foreground"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <InChatPaymentCard
          state={paymentStatus}
          merchantName="متجر جاسم كونيكت الموثّق"
          amountLabel="29.500 د.ك (معاينة تجريبية)"
          referenceId="PAY-DEMO-2049"
          timestampLabel="اليوم · 10:42 م"
          methods={["بطاقة بنكية", "Apple Pay"]}
        />
      </section>

      {/* 5. Live Smart Store Card from Listing ID */}
      <section className="space-y-2 rounded-2xl border border-border bg-card/90 p-4 shadow-xs">
        <h2 className="font-bold">5. بطاقة متجر حية من منتج منشور</h2>
        <div className="flex gap-2">
          <input
            aria-label="معرّف المنتج"
            className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm"
            value={listingId}
            onChange={(event) => setListingId(event.target.value)}
          />
          <button
            type="button"
            className="pressable rounded-xl border border-amber-400/50 bg-amber-500/15 px-4 text-xs font-bold text-foreground"
            onClick={issue}
          >
            إنشاء
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {live && <LiveCard key={live.cardId} initial={live} />}
      </section>

      {/* 6. All 9 Canonical Smart Store Verticals */}
      <div className="space-y-6">
        {Object.values(SMART_STORE_FIXTURES).map((card) => (
          <section key={card.cardId} aria-label={card.vertical} className="space-y-1.5">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {card.vertical} — بيانات تجريبية للقراءة فقط
            </h2>
            <SmartStoreCardView card={card} />
          </section>
        ))}
      </div>
    </main>
  );
}
