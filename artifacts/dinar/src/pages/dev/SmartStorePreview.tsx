/** Development-only preview of the nine fixture cards and one live card from a listing id. */
import { useState } from "react";
import { SmartStoreCard } from "@workspace/api-zod/smart-store-card";
import { SMART_STORE_FIXTURES } from "@workspace/api-zod/smart-store-card-fixtures";
import { SmartStoreCardView } from "../../features/ai/smart-store/SmartStoreCardView";
import { JassimGoSellCard } from "../../features/ai/JassimGoSellCard";
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

      <section className="space-y-4 border-t border-border pt-6" aria-label="معاينة بطاقة جاسم روح بيع لي">
        <h2 className="text-base font-bold">بطاقة «جاسم روح بيع لي» التفاعلية (Apple Magic Motion)</h2>
        <JassimGoSellCard
          merchantName="متجر النخبة للعطور والأزياء"
          budgetLabel="سقف يحدده التاجر"
          durationLabel="10 أيام"
          opportunities={[
            { listingId: "l1", title: "عطر عود ملكي فاخر", placementLabel: "مطابقة الطلبات", rationaleAr: "يتطابق مع طلب حقيقي مُجمّع في السوق مع مخزون متوفر.", demandBadge: "طلب مرتفع (+10 مهتم)" },
            { listingId: "l2", title: "جاكيت كحلي كلاسيك", placementLabel: "نتائج البحث الممولة", rationaleAr: "زيارات مرتفعة ويحتاج إبرازًا واضحًا في نتائج البحث." },
          ]}
          adHeadline="عطر عود ملكي فاخر — متوفر الآن بالتوصيل السريع"
          adBody="عرض حقيقي من متجر النخبة بمخزون مؤكد وسعر واضح قبل الطلب."
        />
      </section>
    </main>
  );
}
