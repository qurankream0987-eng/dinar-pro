/**
 * Phase 1 browser harness: the real card components and the app's built stylesheet, rendered
 * with fixed synthetic payloads (labelled as such). No server, no model, no network. The
 * insights card goes through the same adapter and composed-surface validation as the app.
 */
import { createRoot } from "react-dom/client";
import { ComposedSurfaceView } from "@/features/ai/surface/ComposedSurface";
import { businessSurface } from "@/features/ai/surface/business-adapters";
import { AnswerCard } from "@/features/ai/AnswerCards";

// Synthetic fixture: a business's last six months as the server would send them.
const insightsPayload: any = {
  view: "INSIGHTS",
  businessId: "biz-fixture",
  name: "متجر الاختبار — Test Store",
  allowedActions: [],
  insights: {
    listings: 12, published: 9, paused: 3, completedOrders: 41, completedRevenueMinor: 1_234_500,
    completedRevenue: "1234.500 JOD", currencyCode: "JOD", minorUnitScale: 3,
    monthly: [
      { month: "2026-06", completedOrders: 3, revenueMinor: 95_000, revenue: "95.000 JOD" },
      { month: "2026-07", completedOrders: 0, revenueMinor: 0, revenue: "0.000 JOD" },
      { month: "2026-08", completedOrders: 7, revenueMinor: 210_250, revenue: "210.250 JOD" },
      { month: "2026-09", completedOrders: 5, revenueMinor: 180_000, revenue: "180.000 JOD" },
      { month: "2026-10", completedOrders: 12, revenueMinor: 402_750, revenue: "402.750 JOD" },
      { month: "2026-11", completedOrders: 14, revenueMinor: 346_500, revenue: "346.500 JOD" },
    ],
  },
};

const comparison = JSON.stringify({
  title: "مقارنة الهواتف (Phones comparison)",
  columns: ["الهاتف", "السعر", "الذاكرة", "الشاشة", "البطارية", "الكاميرا", "المدينة", "الحالة"],
  rows: [
    ["Samsung Galaxy S23 Ultra — نسخة الشرق الأوسط مع ضمان", 520.5, "12GB", "6.8 inch", "5000 mAh", "200MP", "عمّان", "مستعمل"],
    ["آيفون 13", 420, "4GB", null, "3240 mAh", "12MP", "الزرقاء", "مستعمل"],
    ["Redmi Note 12", 149.99, "8GB", "6.67 inch", null, "50MP", "إربد", "جديد"],
  ],
});
const line = JSON.stringify({ title: "سعر الذهب التقريبي", unit: "USD", period: "2026", items: [{ label: "يناير", value: 2310 }, { label: "فبراير", value: -15 }, { label: "مارس", value: 0 }, { label: "أبريل", value: 2405.75 }] });
const donut = JSON.stringify({ title: "المبيعات حسب القسم", unit: "%", items: [{ label: "إلكترونيات", value: 55 }, { label: "أثاث Furniture", value: 30 }, { label: "طعام", value: 15 }] });

function App() {
  return (
    <div className="dinar-chatgpt" dir="rtl" style={{ height: "auto", padding: 16, display: "grid", gap: 16 }}>
      <section data-testid="h-insights"><ComposedSurfaceView surface={businessSurface(insightsPayload)} active onSend={() => {}} /></section>
      <section data-testid="h-table"><AnswerCard language="dinar-table" code={comparison} /></section>
      <section data-testid="h-line"><AnswerCard language="dinar-line" code={line} /></section>
      <section data-testid="h-donut"><AnswerCard language="dinar-donut" code={donut} /></section>
      <section data-testid="h-invalid"><AnswerCard language="dinar-line" code={'{"items":[{"label":"a","value":"x"}]}'} /></section>
      <section data-testid="h-invalid-surface"><ComposedSurfaceView surface={{ version: 1, label: "x", size: "MEDIUM", sections: [{ type: "html", html: "<script>window.__pwned=1</script>" }] }} active /></section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
