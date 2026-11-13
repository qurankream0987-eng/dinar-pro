import { Check, X } from "lucide-react";
import { Button } from "@/ui/Button";
import { SmartImage } from "@/ui/Media";
import { PendingNotice } from "./SmartSurfaces";
import { conversationActionMessage } from "@workspace/api-zod/conversation-runtime";
/** Block F1: server-built draft review (provenance, missing fields) and seller insight. The client only renders them. */
type ReviewField = { field: string; label: string; value: string | number | null; source: string; needsConfirmation: boolean };
export type DraftReview = { fields: ReviewField[]; missingFields: { field: string; label: string }[]; actions: string[] };
export type SellerInsight = {
  kind: "PRICE_SUGGESTION" | "LISTING_FACTORS";
  count?: number;
  factors?: { key: string; kind: "FACT" | "POSSIBLE_FACTOR"; text: string }[];
};

const SOURCE_LABELS: Record<string, string> = {
  USER_DECLARED: "منك",
  IMAGE_INFERRED: "من الصورة — يحتاج تأكيدك",
  DINAR_DERIVED: "اقتراح جاسم",
  SERVER_FACT: "من بيانات السوق",
  UNKNOWN: "غير معروف",
};

export function isDraftReview(value: unknown): value is DraftReview {
  const review = value as Partial<DraftReview> | undefined;
  return Boolean(review && Array.isArray(review.fields) && Array.isArray(review.missingFields) && Array.isArray(review.actions));
}

export function isSellerInsight(value: unknown): value is SellerInsight {
  const insight = value as Partial<SellerInsight> | undefined;
  return insight?.kind === "PRICE_SUGGESTION" || insight?.kind === "LISTING_FACTORS";
}

/** The draft's own photos (primary first), as stored on the draft; at most three. */
export function draftPhotos(draft: unknown): string[] {
  const value = draft as { imageUrl?: unknown; imageUrls?: unknown } | undefined;
  const all = [value?.imageUrl, ...(Array.isArray(value?.imageUrls) ? value.imageUrls : [])];
  return [...new Set(all.filter((path): path is string => typeof path === "string" && path.length > 0))].slice(0, 3);
}

export function DraftReviewPanel({ review, step, active = false, onSend, photos = [] }: { review: DraftReview; step?: string; active?: boolean; onSend?: (text: string) => void; photos?: string[] }) {
  const publishReview = step === "publish_review";
  const known = review.fields.filter((field) => field.value !== null && field.value !== "");
  return (
    <section className="ai-surface mt-3 rounded-xl border border-border bg-card p-3 text-sm" aria-label="مراجعة المسودة" data-testid="draft-review">
      {photos.length > 0 && (
        <div className="mb-3 flex gap-2" data-testid="draft-review-photos">
          {photos.map((path, index) => (
            <div key={path} className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border">
              <SmartImage src={path} alt={index === 0 ? "الصورة الرئيسية للإعلان" : `صورة الإعلان ${index + 1}`} />
            </div>
          ))}
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {known.map((field) => (
          <div key={field.field} className="contents" data-testid={`draft-field-${field.field}`} data-source={field.source}>
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 break-words">
              {String(field.value)} <span className="text-xs text-muted-foreground">({SOURCE_LABELS[field.source] ?? field.source})</span>
            </dd>
          </div>
        ))}
      </dl>
      {review.missingFields.length > 0 && (
        <p className="mt-2 text-xs" data-testid="draft-missing">
          ناقص: {review.missingFields.map((field) => field.label).join("، ")}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">لن يُنشر العرض إلا بعد مراجعتك وتأكيد النشر.</p>
      {publishReview && active && <PendingNotice>لم يُنشر بعد — بانتظار تأكيدك.</PendingNotice>}
      {active && onSend && (
        <div className="mt-3 flex flex-wrap gap-2">
          {publishReview ? (
            <>
              <Button size="sm" variant="gold" icon={<Check size={14} aria-hidden />} onClick={() => onSend("نعم")} data-testid="draft-publish-confirm">
                تأكيد النشر
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onSend("لا")} data-testid="draft-publish-back">
                رجوع للمسودة
              </Button>
            </>
          ) : (
            review.missingFields.length === 0 && (
              <Button size="sm" onClick={() => onSend(conversationActionMessage("PUBLISH_LISTING"))} data-testid="draft-publish">
                نشر العرض
              </Button>
            )
          )}
          {!publishReview && (
            <Button size="sm" variant="secondary" icon={<X size={14} aria-hidden />} onClick={() => onSend("إلغاء المسودة")} data-testid="draft-cancel">
              إلغاء المسودة
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function SellerInsightPanel({ insight }: { insight: SellerInsight }) {
  if (insight.kind !== "LISTING_FACTORS" || !insight.factors?.length) return null;
  return (
    <ul className="ai-surface mt-3 space-y-1 rounded-xl border border-border bg-card p-3 text-sm" aria-label="عوامل قد تؤثر" data-testid="seller-insight">
      {insight.factors.map((factor) => (
        <li key={factor.key} className="break-words" data-kind={factor.kind}>
          {factor.text}
        </li>
      ))}
    </ul>
  );
}
