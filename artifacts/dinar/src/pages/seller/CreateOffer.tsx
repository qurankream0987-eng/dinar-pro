import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Rocket } from "lucide-react";
import {
  useGetMarketplaceCategories,
  type MarketplaceCategory,
} from "@workspace/api-client-react";
import { api, useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { fulfilment, placeOf, type Fulfilment } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/Button";
import { InlineAlert } from "@/ui/Feedback";
import { BackButton, Summary } from "@/ui/Layout";
import { OfferCard } from "@/features/OfferCard";
import { commissionPercentLabel, usePolicyIndex } from "@/pages/Policies";
import {
  BasicsFields,
  EMPTY_OFFER,
  FulfilmentFields,
  ImageField,
  InventoryFields,
  offerPayload,
  validateOffer,
  type Errors,
  type OfferFormState,
} from "@/features/OfferForm";

const STEPS = [
  { key: "image", title: "الصور", sub: "ابدأ بصور واضحة لما ستعرضه" },
  {
    key: "basics",
    title: "ماذا تقدّم؟",
    sub: "التصنيف والعنوان وما تشمله الوحدة",
  },
  { key: "inventory", title: "الكمية", sub: "محدودة أم غير محدودة" },
  {
    key: "fulfilment",
    title: "التنفيذ والموقع",
    sub: "كيف يستلم المشتري، وأين",
  },
  { key: "review", title: "المراجعة", sub: "هكذا سيظهر عرضك" },
] as const;

function applyCategoryRules(
  form: OfferFormState,
  category: MarketplaceCategory,
): OfferFormState {
  const { pricing, inventory } = category.rules;
  const pricingMode = pricing.allowedModes.includes(form.pricingMode)
    ? form.pricingMode
    : pricing.defaultMode;
  const inventoryMode = inventory.allowedModes.includes(form.inventoryMode)
    ? form.inventoryMode
    : inventory.defaultMode;

  return {
    ...form,
    pricingMode,
    // A starting amount or quotation is stored as OPEN_TO_OFFERS; keep it when that is allowed.
    priceRepresentation: pricingMode === form.pricingMode ? form.priceRepresentation : pricingMode,
    unitPrice: form.unitPrice,
    inventoryMode,
    availableQuantity:
      inventoryMode === "LIMITED"
        ? String(
            inventory.semantics === "SINGLE"
              ? 1
              : form.availableQuantity || inventory.defaultQuantity || 1,
          )
        : "",
  };
}

export default function CreateOffer({
  initialDraft,
  review = false,
  draftStep,
}: {
  initialDraft?: Partial<OfferFormState>;
  review?: boolean;
  draftStep?: string;
} = {}) {
  const { market, user } = useAccount();
  const policies = usePolicyIndex();
  const categories = useGetMarketplaceCategories();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const publishKey = useRef(initialDraft?.draftId ?? crypto.randomUUID());
  const [step, setStep] = useState(review ? 4 : 0);
  const [form, setForm] = useState<OfferFormState>({
    ...EMPTY_OFFER,
    ...initialDraft,
    attributes: initialDraft?.attributes ?? {},
    imageUrls: Array.isArray(initialDraft?.imageUrls)
      ? initialDraft.imageUrls.join("\n")
      : initialDraft?.imageUrls ?? "",
    contactPreference:
      initialDraft?.contactPreference ??
      (initialDraft?.contactPhone ? "LISTING_PHONE" : "UNSET"),
    contactPhone: initialDraft?.contactPhone ?? "",
    unitPrice:
      initialDraft?.unitPrice == null ? "" : String(initialDraft.unitPrice),
  });
  const selectedCategory = categories.data?.find(
    (category) =>
      category.id === form.categoryId || category.label === form.category,
  );
  const requiresInventory =
    selectedCategory?.rules.sellerDraft.requiredFields.includes("INVENTORY") ??
    true;
  const steps = requiresInventory
    ? STEPS
    : STEPS.filter((item) => item.key !== "inventory");
  const stepIndex = Math.min(step, steps.length - 1);
  const current = steps[stepIndex];
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!selectedCategory) return;
    setForm((currentForm) =>
      applyCategoryRules(currentForm, selectedCategory),
    );
  }, [selectedCategory]);
  useEffect(() => {
    const targetKey =
      review || draftStep === "review"
        ? "review"
        : draftStep === "quantity"
          ? "inventory"
          : draftStep === "category"
            ? "basics"
            : ["area", "fulfilment", "contact"].includes(draftStep ?? "")
            ? "fulfilment"
            : draftStep === "description" ||
                draftStep === "price" ||
                draftStep === "title" ||
                draftStep?.startsWith("attribute:")
              ? "basics"
              : "image";
    const index = steps.findIndex((item) => item.key === targetKey);
    setStep(index < 0 ? 0 : index);
  }, [draftStep, review, steps.length]);
  if (!market) throw new Error("لا يوجد سوق نشط لإنشاء العرض.");

  const set = <K extends keyof OfferFormState>(k: K, v: OfferFormState[K]) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (k === "category") {
        const category = categories.data?.find((item) => item.label === v);
        if (category) {
          next.categoryId = category.id;
          return applyCategoryRules(next, category);
        }
      }
      return next;
    });
  };

  const next = async () => {
    if (current.key !== "review") {
      const errs = validateOffer(
        form,
        current.key,
        market.currencyCode,
        categories.data ?? [],
      );
      setErrors(errs);
      if (Object.keys(errs).length) return;
      setStep(stepIndex + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const finalErrors = validateOffer(
      form,
      "all",
      market.currencyCode,
      categories.data ?? [],
    );
    if (Object.keys(finalErrors).length) {
      setErrors(finalErrors);
      const section = finalErrors.imageUrl || finalErrors.imageUrls
        ? "image"
        : finalErrors.availableQuantity || finalErrors.inventoryMode
          ? "inventory"
          : finalErrors.area ||
              finalErrors.contactPhone ||
              finalErrors.contactPreference
            ? "fulfilment"
            : "basics";
      const nextIndex = steps.findIndex((item) => item.key === section);
      setStep(nextIndex < 0 ? 0 : nextIndex);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const item = await api(
        "/listings",
        "POST",
        offerPayload(form, categories.data ?? []),
        {
        "Idempotency-Key": publishKey.current,
        },
      );
      await qc.invalidateQueries();
      toast.success("تم نشر العرض", {
        description: `ظاهر الآن في سوق ${market?.countryNameAr ?? ""}`,
      });
      navigate(`/listings/${item.id}`, { replace: true });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = {
    id: "preview",
    title: form.title || "عنوان العرض",
    description: form.description,
    category: form.category,
    area: form.area,
    city: form.city,
    unitPrice:
      form.pricingMode === "OPEN_TO_OFFERS" && !form.unitPrice.trim()
        ? null
        : form.unitPrice.trim() || null,
    pricingMode: form.pricingMode,
    currency: market.currencyCode,
    availableQuantity:
      form.inventoryMode === "LIMITED"
        ? Number(form.availableQuantity)
        : null,
    reservedQuantity: 0,
    inventoryMode: form.inventoryMode,
    fulfilmentType: form.fulfilmentType,
    sellerName: user?.displayName ?? "",
    rating: 0,
    reviewCount: 0,
    imageUrl: form.imageUrl.trim(),
    imageUrls: form.imageUrls
      .split("\n")
      .map((url) => url.trim())
      .filter(Boolean),
    contactPhone:
      form.contactPreference === "LISTING_PHONE"
        ? form.contactPhone.trim() || null
        : null,
    status: "PUBLISHED",
  } as const;
  const attributeSummary = Object.entries(form.attributes)
    .map(
      ([key, value]) =>
        `${selectedCategory?.attributes[key]?.label ?? key}: ${value}`,
    )
    .join(" · ");

  return (
    <div className="container-app max-w-2xl">
      <header className="flex items-start gap-3 pt-5 md:pt-8">
        <BackButton
          onBack={stepIndex > 0 ? () => setStep(stepIndex - 1) : undefined}
          to={stepIndex === 0 ? "/seller" : undefined}
          label={stepIndex === 0 ? "إلغاء" : "رجوع"}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-muted-foreground">
            عرض جديد · الخطوة <span className="num">{stepIndex + 1}</span> من{" "}
            <span className="num">{steps.length}</span>
          </p>
          <h1 className="text-2xl font-bold">{current.title}</h1>
          <p className="text-base text-muted-foreground">{current.sub}</p>
        </div>
      </header>
      <div className="mt-4 flex gap-1.5" aria-hidden>
        {steps.map((s, i) => (
          <span
            key={s.key}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors",
              i <= stepIndex ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </div>

      <form
        noValidate
        className="mt-6 space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void next();
        }}
      >
        {current.key === "basics" && (
          <BasicsFields form={form} set={set} errors={errors} />
        )}
        {current.key === "image" && (
          <ImageField form={form} set={set} errors={errors} />
        )}
        {current.key === "inventory" && (
          <InventoryFields
            form={form}
            set={set}
            errors={errors}
            category={selectedCategory}
          />
        )}
        {current.key === "fulfilment" && (
          <FulfilmentFields form={form} set={set} errors={errors} />
        )}
        {current.key === "review" && (
          <div className="grid gap-5 sm:grid-cols-[220px_1fr]">
            <div
              className="pointer-events-none mx-auto w-full max-w-[240px]"
              aria-label="معاينة البطاقة"
            >
              <OfferCard offer={preview} onOpen={() => setStep(0)} />
            </div>
            <div className="space-y-4">
              <Summary
                className="rounded-xl border border-border bg-card p-4 text-base"
                rows={[
                  { label: "السوق", value: market?.countryNameAr },
                  { label: "التصنيف", value: form.category },
                  {
                    label: "سعر الوحدة",
                    value: form.pricingMode === "OPEN_TO_OFFERS" && !form.unitPrice.trim() ? (
                      "قدّم عرضك"
                    ) : (
                      <span className="num" dir="ltr">
                        {form.pricingMode === "OPEN_TO_OFFERS" ? "سعر استرشادي " : ""}
                        {form.unitPrice} {market.currencyCode}
                      </span>
                    ),
                  },
                  {
                    label: "الكمية",
                    value: selectedCategory?.rules.inventory.semantics === "NON_STOCK" ? (
                      "غير منطبق — لا يتطلب مخزون"
                    ) : selectedCategory?.rules.inventory.semantics === "SINGLE" ? (
                      "وحدة واحدة"
                    ) : form.inventoryMode === "UNLIMITED" ? (
                        "غير محدودة"
                      ) : (
                        <span className="num">{form.availableQuantity}</span>
                      ),
                  },
                  {
                    label: "التنفيذ",
                    value: fulfilment(form.fulfilmentType as Fulfilment).label,
                  },
                  { label: "المنطقة", value: placeOf(form) || "—" },
                  { label: "الخصائص", value: attributeSummary || "—" },
                  {
                    label: "الصور",
                    value: 1 + form.imageUrls.split("\n").filter(Boolean).length,
                  },
                  {
                    label: "التواصل",
                    value:
                      form.contactPreference === "CHAT_ONLY"
                        ? "محادثة جاسم فقط"
                        : form.contactPhone || "رقم مخصص لهذا الإعلان",
                  },
                ]}
              />
              <p className="text-xs leading-6 text-muted-foreground">
                يُنشر العرض في سوق {market?.countryNameAr} ولا يمكن نقله لسوق
                آخر. السعر الذي اخترته يطبق على الوحدة الواحدة.{" "}
                <span data-testid="text-commission-disclosure">
                  رسوم جاسم{" "}
                  {commissionPercentLabel(policies.data?.fees.commissionRateBps)}{" "}
                  من قيمة كل طلب مكتمل يتحملها البائع، ولا تُضاف على المشتري.
                </span>{" "}
                بالنشر توافق على{" "}
                <Link href="/policies/marketplace-rules" className="font-semibold text-primary">
                  قواعد السوق
                </Link>{" "}
                و
                <Link href="/policies/prohibited-items" className="font-semibold text-primary">
                  المنتجات المحظورة
                </Link>
                .
              </p>
            </div>
          </div>
        )}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}

        <div
          className="fixed inset-x-0 bottom-0 z-[var(--z-action-bar)] flex gap-2 border-t border-border bg-card/95 px-[var(--gutter)] pt-3 backdrop-blur-xl md:static md:border-0 md:bg-transparent md:p-0"
          style={{ paddingBottom: "max(12px, var(--safe-bottom))" }}
        >
          {stepIndex > 0 && (
            <Button
              variant="secondary"
              size="lg"
              className="shrink-0 whitespace-nowrap"
              onClick={() => setStep(stepIndex - 1)}
              disabled={busy}
            >
              السابق
            </Button>
          )}
          <Button
            type="submit"
            size="lg"
            block
            loading={busy}
            variant={current.key === "review" ? "gold" : "primary"}
            icon={current.key === "review" ? <Rocket size={18} /> : undefined}
          >
            {current.key === "review" ? "نشر العرض" : "التالي"}
            {current.key !== "review" && <ArrowLeft size={18} aria-hidden />}
          </Button>
        </div>
      </form>
    </div>
  );
}
