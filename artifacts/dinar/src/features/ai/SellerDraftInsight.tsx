import { useState } from "react";
import { Check, Eye, EyeOff, ImageOff, Pencil, X } from "lucide-react";
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

export type DraftPresentation = { image?: "LARGE" | "MEDIUM" | "SMALL" | "HIDDEN"; price?: "TOP" | "INLINE"; density?: "FULL" | "COMPACT"; details?: "BESIDE" | "BELOW" };
const HERO_FIELDS = new Set(["title", "unitPrice", "images"]);

/**
 * The seller's draft as a listing card: a hero photo (only the seller's own — never a stand-in), the
 * title and price, the attributes with where each came from, and a clear «unpublished» status.
 * `presentation` rearranges these server fields only (image size, price position, density, where
 * details sit); «معاينة» shows the buyer's view locally and changes nothing.
 */
export function DraftReviewPanel({ review, step, active = false, onSend, photos = [], presentation }: { review: DraftReview; step?: string; active?: boolean; onSend?: (text: string) => void; photos?: string[]; presentation?: DraftPresentation }) {
  const [preview, setPreview] = useState(false);
  const publishReview = step === "publish_review";
  const known = review.fields.filter((field) => field.value !== null && field.value !== "");
  const byField = (name: string) => known.find((field) => field.field === name);
  const title = byField("title");
  const price = byField("unitPrice");
  const image = presentation?.image ?? "MEDIUM";
  const compact = presentation?.density === "COMPACT";
  const details = known.filter((field) => !HERO_FIELDS.has(field.field));
  const shown = compact ? details.slice(0, 4) : details;
  const showImage = image !== "HIDDEN";
  const priceLine = price && (
    <p className="draft-card-price" data-testid="draft-field-unitPrice" data-source={price.source}>
      <span className="num">{String(price.value)}</span>
      {!preview && !compact && <span className="draft-card-source">{SOURCE_LABELS[price.source] ?? price.source}</span>}
    </p>
  );
  return (
    <section
      className="ai-surface draft-card mt-3 text-sm"
      aria-label={preview ? "معاينة الإعلان كما يراه المشتري" : "مراجعة المسودة"}
      data-testid="draft-review"
      data-image={image}
      data-density={compact ? "COMPACT" : "FULL"}
      data-details={presentation?.details ?? "BESIDE"}
      data-preview={preview ? "true" : undefined}
    >
      {showImage && (
        <div className="draft-card-media" data-testid="draft-review-photos">
          {photos.length > 0 ? (
            <>
              <SmartImage src={photos[0]!} alt="الصورة الرئيسية للإعلان" />
              {photos.length > 1 && image !== "SMALL" && (
                <div className="draft-card-thumbs">
                  {photos.slice(1).map((path, index) => (
                    <div key={path} className="draft-card-thumb">
                      <SmartImage src={path} alt={`صورة الإعلان ${index + 2}`} />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            // An honest empty state: a generic product photo is never shown as the seller's item.
            <div className="draft-card-noimage" data-testid="draft-no-photo">
              <ImageOff size={22} aria-hidden />
              <span>لا توجد صورة بعد</span>
            </div>
          )}
        </div>
      )}
      <div className="draft-card-body">
        <div className="draft-card-status">
          <span className="draft-card-badge" data-testid="draft-status-badge">{preview ? "معاينة" : "مسودة · غير منشورة"}</span>
        </div>
        {presentation?.price === "TOP" && priceLine}
        <h3 className="draft-card-title" data-testid="draft-field-title" data-source={title?.source}>
          {title ? String(title.value) : "مسودة إعلان بدون عنوان"}
        </h3>
        {presentation?.price !== "TOP" && priceLine}
        {shown.length > 0 && (
          <dl className="draft-card-facts">
            {shown.map((field) => (
              <div key={field.field} className="draft-card-fact" data-testid={`draft-field-${field.field}`} data-source={field.source}>
                <dt>{field.label}</dt>
                <dd>
                  {String(field.value)}
                  {!preview && !compact && <span className="draft-card-source">{SOURCE_LABELS[field.source] ?? field.source}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {compact && details.length > shown.length && <p className="draft-card-more">و{details.length - shown.length} تفاصيل أخرى — اطلب «كل التفاصيل» لعرضها.</p>}
        {!preview && review.missingFields.length > 0 && (
          <p className="draft-card-missing" data-testid="draft-missing">
            ناقص: {review.missingFields.map((field) => field.label).join("، ")}
          </p>
        )}
        <p className="draft-card-note">{preview ? "هكذا سيظهر الإعلان للمشترين بعد نشره. لم يُنشر بعد." : "لن يُنشر العرض إلا بعد مراجعتك وتأكيد النشر."}</p>
        {publishReview && active && <PendingNotice>لم يُنشر بعد — بانتظار تأكيدك.</PendingNotice>}
        <div className="draft-card-actions">
          {active && onSend && !preview && (
            publishReview ? (
              <>
                <Button size="sm" variant="gold" icon={<Check size={14} aria-hidden />} onClick={() => onSend("نعم")} data-testid="draft-publish-confirm">
                  تأكيد النشر
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onSend("لا")} data-testid="draft-publish-back">
                  رجوع للمسودة
                </Button>
              </>
            ) : (
              <>
                {review.missingFields.length === 0 && (
                  <Button size="sm" onClick={() => onSend(conversationActionMessage("PUBLISH_LISTING"))} data-testid="draft-publish">
                    نشر العرض
                  </Button>
                )}
                <Button size="sm" variant="secondary" icon={<Pencil size={14} aria-hidden />} onClick={() => onSend("أبي أعدل المسودة")} data-testid="draft-edit">
                  تعديل المسودة
                </Button>
              </>
            )
          )}
          <Button size="sm" variant="ghost" icon={preview ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />} onClick={() => setPreview((value) => !value)} aria-pressed={preview} data-testid="draft-preview-toggle">
            {preview ? "رجوع للمراجعة" : "معاينة"}
          </Button>
          {active && onSend && !preview && !publishReview && (
            <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => onSend("إلغاء المسودة")} data-testid="draft-cancel">
              إلغاء المسودة
            </Button>
          )}
        </div>
      </div>
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
