import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Megaphone, Tag } from "lucide-react";
import {
  getGetListingsQueryKey,
  getGetPromotionProductsQueryKey,
  useArchiveListing,
  useChangeListingStatus,
  useConfirmListingPromotion,
  useGetListings,
  useGetPromotionProducts,
  usePreviewListingPromotion,
  type PromotionPreview,
} from "@workspace/api-client-react";
import { formatMoney } from "@workspace/global";
import { useAccount } from "@/account/Account";
import { OWN_LISTINGS, type Offer } from "@/lib/marketplace";
import { Button, buttonClass } from "@/ui/Button";
import { conversationActionMessage } from "@workspace/api-zod/conversation-runtime";
import {
  Badge,
  EmptyState,
  ErrorState,
  InlineAlert,
  Skeleton,
} from "@/ui/Feedback";
import { ConfirmDialog } from "@/ui/Sheet";

type ListingAction = "PAUSE" | "RESUME" | "ARCHIVE";
type PendingAction = { offer: Offer; action: ListingAction } | null;

const STATUS_LABEL: Record<string, string> = {
  PUBLISHED: "منشور",
  PAUSED: "متوقف",
  DRAFT: "مسودة",
  ARCHIVED: "مؤرشف",
  MODERATION_HIDDEN: "مخفي بقرار إداري",
  MODERATION_REMOVED: "محذوف بقرار إداري",
};
const MODERATED = new Set(["MODERATION_HIDDEN", "MODERATION_REMOVED"]);

export default function SellerListingsSurface({
  selectedListingId,
  onSend,
}: {
  selectedListingId?: string;
  onSend?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { market } = useAccount();
  const listings = useGetListings(OWN_LISTINGS);
  const changeStatus = useChangeListingStatus();
  const archive = useArchiveListing();
  const promotionProducts = useGetPromotionProducts();
  const previewPromotion = usePreviewListingPromotion();
  const confirmPromotion = useConfirmListingPromotion();
  const [pending, setPending] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState("");
  const [promotionTarget, setPromotionTarget] = useState<Offer | null>(null);
  const [promotionProductId, setPromotionProductId] = useState("");
  const [promotionPreview, setPromotionPreview] =
    useState<PromotionPreview | null>(null);
  const [promotionError, setPromotionError] = useState("");
  // One key per reviewed preview: retries and double taps settle one campaign.
  const [promotionKey, setPromotionKey] = useState("");
  const [promotionNotice, setPromotionNotice] = useState("");
  const loading = changeStatus.isPending || archive.isPending;
  const promotionLoading =
    previewPromotion.isPending || confirmPromotion.isPending;
  const offers = (listings.data ?? []) as Offer[];
  const promotionOptions = (promotionProducts.data ?? []).filter(
    (product) =>
      product.enabled &&
      Boolean(promotionTarget?.categoryId) &&
      product.categoryId === promotionTarget?.categoryId,
  );

  const closePromotion = () => {
    setPromotionTarget(null);
    setPromotionProductId("");
    setPromotionPreview(null);
    setPromotionError("");
  };

  const requestPromotionPreview = async () => {
    if (!promotionTarget || !promotionProductId) return;
    setPromotionError("");
    setPromotionPreview(null);
    try {
      const preview = await previewPromotion.mutateAsync({
        id: promotionTarget.id,
        data: { promotionProductId },
      });
      setPromotionPreview(preview);
      setPromotionKey(`promotion-ui:${crypto.randomUUID()}`);
    } catch {
      setPromotionError("تعذرت معاينة الخطة. حدّث الخطط وحاول مرة أخرى.");
    }
  };

  const confirmSimulatedPromotion = async () => {
    if (!promotionTarget || !promotionPreview?.simulationEnabled) return;
    setPromotionError("");
    try {
      const campaign = await confirmPromotion.mutateAsync({
        id: promotionTarget.id,
        data: {
          promotionProductId: promotionPreview.productId,
          confirmed: true,
          idempotencyKey: promotionKey,
        },
      });
      setPromotionNotice(
        campaign.status === "ACTIVE"
          ? "تم الدفع التجريبي وتفعيل الترويج. لم تُحوّل أي أموال حقيقية، ولا تجديد تلقائي."
          : "لم يُفعّل الترويج لأن الدفع التجريبي لم ينجح. لم يتم خصم أي مبلغ.",
      );
      closePromotion();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetListingsQueryKey(OWN_LISTINGS),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetPromotionProductsQueryKey(),
        }),
        queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey.some(
              (part) =>
                typeof part === "string" && part.includes("/api/listings"),
            ),
        }),
      ]);
    } catch {
      setPromotionError("تعذر تسجيل المحاكاة. حدّث العرض وحاول مرة أخرى.");
    }
  };

  const confirm = () => {
    if (!pending) return;
    setActionError("");
    const onSuccess = async () => {
      await queryClient.invalidateQueries({
        queryKey: getGetListingsQueryKey(OWN_LISTINGS),
      });
      setPending(null);
    };
    const onError = () =>
      setActionError("تعذر حفظ التغيير. حدّث القائمة وحاول مرة أخرى.");

    if (pending.action === "ARCHIVE") {
      archive.mutate({ id: pending.offer.id }, { onSuccess, onError });
    } else {
      changeStatus.mutate(
        {
          id: pending.offer.id,
          data: { action: pending.action },
        },
        { onSuccess, onError },
      );
    }
  };

  if (listings.isLoading)
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-40" />
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  if (listings.isError)
    return <ErrorState onRetry={() => listings.refetch()} />;

  return (
    <section className="space-y-3 p-4" aria-label="إدارة عروضي">
      <header>
        <h2 className="text-lg font-semibold">عروضي</h2>
        <p className="text-sm text-muted-foreground">
          أوقف العرض أو استأنفه أو أرشفه. تبقى الطلبات السابقة محفوظة.
        </p>
      </header>
      {promotionNotice && (
        <InlineAlert tone="success" title="تم تسجيل المحاكاة">
          {promotionNotice}
        </InlineAlert>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {offers.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="لا توجد عروض في هذا السوق"
          body="ابدأ بإضافة عرض جديد من مسار البيع."
        />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {offers.map((offer, index) => (
            <article
              key={offer.id}
              className={`ai-seller-row flex flex-wrap items-center gap-3 p-3 ${
                offer.id === selectedListingId
                  ? "bg-primary-soft/20 ring-1 ring-inset ring-primary/40"
                  : ""
              }`}
              data-testid={`chat-seller-listing-${offer.id}`}
            >
              <div className="ai-seller-row-copy min-w-0 flex-1">
                <p className="truncate font-semibold">{offer.title}</p>
                <p className="text-xs text-muted-foreground">
                  {offer.category} · {offer.unitPrice}
                </p>
                <Badge className="mt-1">
                  {STATUS_LABEL[offer.status] ?? offer.status}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {offer.status !== "ARCHIVED" && !MODERATED.has(offer.status) && (
                  <Link
                    href={`/seller/offers/${offer.id}/edit`}
                    className={buttonClass("secondary", "sm")}
                    data-testid={`chat-edit-listing-${offer.id}`}
                  >
                    تعديل
                  </Link>
                )}
                {offer.status === "PUBLISHED" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      onSend
                        ? onSend(
                            conversationActionMessage("PAUSE_LISTING", {
                              position: index + 1,
                            }),
                          )
                        : setPending({ offer, action: "PAUSE" })
                    }
                    data-testid={`chat-pause-listing-${offer.id}`}
                  >
                    إيقاف
                  </Button>
                )}
                {offer.status === "PAUSED" && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      onSend
                        ? onSend(
                            conversationActionMessage("RESUME_LISTING", {
                              position: index + 1,
                            }),
                          )
                        : setPending({ offer, action: "RESUME" })
                    }
                    data-testid={`chat-resume-listing-${offer.id}`}
                  >
                    استئناف
                  </Button>
                )}
                {offer.status === "PUBLISHED" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      onSend
                        ? onSend(
                            conversationActionMessage("PROMOTE_LISTING", {
                              position: index + 1,
                            }),
                          )
                        : (() => {
                            setPromotionTarget(offer);
                            setPromotionProductId("");
                            setPromotionPreview(null);
                            setPromotionError("");
                            setPromotionNotice("");
                          })()
                    }
                    data-testid={`chat-promote-listing-${offer.id}`}
                  >
                    <Megaphone size={15} aria-hidden />
                    ترويج
                  </Button>
                )}
                {offer.status !== "ARCHIVED" && !MODERATED.has(offer.status) && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      onSend
                        ? onSend(
                            conversationActionMessage("ARCHIVE_LISTING", {
                              position: index + 1,
                            }),
                          )
                        : setPending({ offer, action: "ARCHIVE" })
                    }
                    data-testid={`chat-archive-listing-${offer.id}`}
                  >
                    أرشفة
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {promotionTarget && (
        <section
          className="space-y-3 rounded-xl border border-primary/30 bg-primary-soft/30 p-4"
          aria-label={`محاكاة ترويج ${promotionTarget.title}`}
          data-testid={`chat-promotion-panel-${promotionTarget.id}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">
                ترويج: {promotionTarget.title}
              </h3>
              <p className="text-xs text-muted-foreground">
                اختر الخطة ثم راجع السعر والمدة قبل التأكيد.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={closePromotion}
              disabled={promotionLoading}
              aria-label="إلغاء الترويج"
            >
              إلغاء
            </Button>
          </div>

          {promotionProducts.isLoading ? (
            <Skeleton className="h-11 w-full" />
          ) : promotionProducts.isError ? (
            <InlineAlert tone="warning" title="الخطط غير متاحة">
              الترويج غير مفعّل في هذه البيئة، أو تعذّر تحميل الخطط.
            </InlineAlert>
          ) : promotionOptions.length === 0 ? (
            <InlineAlert tone="warning" title="لا توجد خطة لهذا التصنيف">
              لا توجد خطة ترويج نشطة متوافقة مع تصنيف هذا العرض والسوق الحالي.
            </InlineAlert>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span className="font-medium">خطة الترويج</span>
                <select
                  className="h-11 w-full rounded-md border border-border bg-background px-3"
                  value={promotionProductId}
                  onChange={(event) => {
                    setPromotionProductId(event.target.value);
                    setPromotionPreview(null);
                    setPromotionError("");
                  }}
                >
                  <option value="">اختر خطة</option>
                  {promotionOptions.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ·{" "}
                      {formatMoney(product.priceMinor, product.currencyCode)} ·{" "}
                      {product.durationDays} يومًا
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="secondary"
                disabled={!promotionProductId || promotionLoading}
                onClick={() => void requestPromotionPreview()}
              >
                {previewPromotion.isPending
                  ? "جارٍ إعداد المعاينة…"
                  : "معاينة الخطة"}
              </Button>
            </>
          )}

          {promotionPreview && (
            <div className="space-y-2 rounded-lg border border-border bg-card p-3">
              <p className="font-medium">{promotionPreview.productName}</p>
              <p className="text-sm text-muted-foreground">
                السعر المسجل للخطة:{" "}
                <strong className="text-foreground">
                  {formatMoney(
                    promotionPreview.priceMinor,
                    promotionPreview.currencyCode,
                  )}
                </strong>
                {" · "}
                {promotionPreview.durationDays} يومًا
              </p>
              <InlineAlert tone="warning" title="محاكاة تطوير فقط">
                {promotionPreview.warning}
              </InlineAlert>
              {!promotionPreview.simulationEnabled && (
                <p role="alert" className="text-sm text-destructive">
                  لا يمكن تأكيد المحاكاة خارج بيئة التطوير والاختبار.
                </p>
              )}
              <Button
                type="button"
                disabled={!promotionPreview.simulationEnabled || promotionLoading}
                onClick={() => void confirmSimulatedPromotion()}
                data-testid="confirm-simulated-promotion"
              >
                {confirmPromotion.isPending
                  ? "جارٍ تسجيل المحاكاة…"
                  : "تأكيد المحاكاة فقط"}
              </Button>
            </div>
          )}
          {promotionError && (
            <p role="alert" className="text-sm text-destructive">
              {promotionError}
            </p>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            لن يتم خصم أو تحصيل أي مبلغ. لا تُنشأ فاتورة أو محفظة أو مستحقات.
          </p>
          {market && (
            <p className="sr-only">السوق الحالي: {market.countryNameAr}</p>
          )}
        </section>
      )}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && !loading && setPending(null)}
        title={
          pending?.action === "ARCHIVE"
            ? "أرشفة هذا العرض؟"
            : pending?.action === "PAUSE"
              ? "إيقاف هذا العرض؟"
              : "استئناف هذا العرض؟"
        }
        body={
          pending?.action === "ARCHIVE"
            ? "سيختفي العرض من السوق، مع الاحتفاظ بسجل الطلبات والبيانات المرتبطة به."
            : pending?.action === "PAUSE"
              ? "لن يتمكن المشترون من إنشاء طلبات جديدة لهذا العرض."
              : "سيصبح العرض متاحًا للشراء مجددًا."
        }
        confirmLabel={
          pending?.action === "ARCHIVE"
            ? "أرشفة"
            : pending?.action === "PAUSE"
              ? "إيقاف العرض"
              : "استئناف العرض"
        }
        tone={pending?.action === "ARCHIVE" ? "danger" : "primary"}
        onConfirm={confirm}
        loading={loading}
      />
    </section>
  );
}