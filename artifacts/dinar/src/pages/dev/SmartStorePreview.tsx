/** Development-only preview of the nine fixture cards and one live card from a listing id. */
import { useState } from "react";
import { SmartStoreCard } from "@workspace/api-zod/smart-store-card";
import { SMART_STORE_FIXTURES } from "@workspace/api-zod/smart-store-card-fixtures";
import { SmartStoreCardView } from "../../features/ai/smart-store/SmartStoreCardView";
import { LiveDeliveryTrackerCard } from "../../features/ai/LiveDeliveryTrackerCard";
import { ConnectUrlQuickCard } from "../../features/ConnectUrlQuickCard";
import { useLiveSmartStoreCard } from "../../features/ai/smart-store/useLiveSmartStoreCard";

function LiveCard({ initial }: { initial: SmartStoreCard }) {
  const live = useLiveSmartStoreCard(initial);
  return (
    <>
      <SmartStoreCardView card={live.card} onEvent={live.send} busy={live.busy} />
      {live.error && <p role="alert" className="text-xs">{live.error}</p>}
    </>
  );
}

export default function SmartStorePreview() {
  const [listingId, setListingId] = useState("");
  const [live, setLive] = useState<SmartStoreCard>();
  const [error, setError] = useState("");
  const issue = async () => {
    setError("");
    const response = await fetch("/api/smart-store/cards", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingIds: [listingId.trim()] }) });
    const parsed = SmartStoreCard.safeParse(await response.json().catch(() => null));
    if (parsed.success) setLive(parsed.data);
    else setError("تعذر إنشاء البطاقة (سجّل الدخول واستخدم معرّف منتج منشور).");
  };
  return (
    <main dir="rtl" className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-lg font-bold">معاينة البطاقات المتجرية (تطوير فقط)</h1>
      <section className="space-y-2">
        <h2 className="font-semibold">بطاقة حية من منتج منشور</h2>
        <div className="flex gap-2">
          <input aria-label="معرّف المنتج" className="flex-1 rounded border px-2 py-1" value={listingId} onChange={(event) => setListingId(event.target.value)} />
          <button type="button" className="rounded border px-3" onClick={issue}>إنشاء</button>
        </div>
        {error && <p role="alert" className="text-xs">{error}</p>}
        {live && <LiveCard key={live.cardId} initial={live} />}
      </section>
      {Object.values(SMART_STORE_FIXTURES).map((card) => (
        <section key={card.cardId} aria-label={card.vertical}>
          <h2 className="text-xs text-muted-foreground">{card.vertical} — بيانات تجريبية للقراءة فقط</h2>
          <SmartStoreCardView card={card} />
        </section>
      ))}

      <section className="space-y-4 border-t border-border pt-6" aria-label="التتبع المباشر والربط بالرابط داخل المحادثة">
        <h2 className="text-base font-bold">التتبع المباشر والربط بالرابط داخل محادثة واحدة</h2>
        <div className="grid gap-5 md:grid-cols-2">
          <LiveDeliveryTrackerCard
            orderRef="ORD-2026-904"
            merchantName="برغر هاوس التفاعلي"
            status="OUT_FOR_DELIVERY"
            etaLabel="12–16 دقيقة"
            remainingKmLabel="2.1 كم"
            progressPercent={62}
            courierName="كابتن أحمد"
            courierRating={4.9}
            courierPhone="+962790000000"
            pickupCoords={{ lat: 31.9539, lng: 35.9106 }}
            courierCoords={{ lat: 31.9620, lng: 35.8900 }}
            dropoffCoords={{ lat: 31.9700, lng: 35.8700 }}
            onQuickMessage={() => {}}
          />
          <ConnectUrlQuickCard />
        </div>
      </section>
    </main>
  );
}
