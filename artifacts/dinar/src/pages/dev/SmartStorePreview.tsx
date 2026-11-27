/** Development-only preview of the nine fixture cards and one live card from a listing id. */
import { useState } from "react";
import { SmartStoreCard } from "@workspace/api-zod/smart-store-card";
import { SMART_STORE_FIXTURES } from "@workspace/api-zod/smart-store-card-fixtures";
import { SmartStoreCardView } from "../../features/ai/smart-store/SmartStoreCardView";
import { UniversalCardEngine } from "../../features/ai/infinite-cards/UniversalCardEngine";
import { INFINITE_CARD_DEMO_SPECS } from "../../features/ai/infinite-cards/fixtures";
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

      <section className="space-y-4 border-t border-border pt-6" aria-label="محرك البطاقات اللانهائية التفاعلية">
        <div>
          <h2 className="text-base font-bold">محرك البطاقات اللانهائية التفاعلية (برغر + مانيكان + استوديو)</h2>
          <p className="text-xs text-muted-foreground">نماذج تفاعلية حية مبنية على بروتوكول JassimCardSpec v1 (بيانات معاينة تجريبية).</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {INFINITE_CARD_DEMO_SPECS.map((spec) => (
            <UniversalCardEngine key={spec.cardId} spec={spec} />
          ))}
        </div>
      </section>
    </main>
  );
}
