import { iconButtonClass } from "@/ui/Button";
import { useState } from "react";
import {
  Infinity as InfinityIcon,
  Hash,
  ShieldCheck,
  X,
} from "lucide-react";
import { decimalToMinor } from "@workspace/global";
import {
  useGetMarketplaceCategories,
  type MarketplaceCategory,
} from "@workspace/api-client-react";
import {
  validateCategoryAttributesAgainstSchema,
  type ListingPricingMode,
} from "@workspace/api-zod/marketplace-schemas";
import {
  PRICE_REPRESENTATIONS,
  PRICE_REPRESENTATION_LABELS,
  storedPricingFor,
  type PriceRepresentation,
} from "@workspace/api-zod/listing-pricing";
import { useAccount } from "@/account/Account";
import {
  FULFILMENT,
  categoryIcon,
  type Fulfilment,
} from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { ChoiceCard, Field, Input, Textarea } from "@/ui/Field";
import { SmartImage } from "@/ui/Media";
import { uploadListingPhoto } from "@/features/listing-photo-upload";

export type OfferFormState = {
  draftId?: string;
  title: string;
  category: string;
  categoryId: string;
  description: string;
  unitPrice: string;
  pricingMode: ListingPricingMode;
  /** What the price means; pricingMode is the stored mode it maps to. */
  priceRepresentation: PriceRepresentation;
  imageUrl: string;
  imageUrls: string;
  inventoryMode: "LIMITED" | "UNLIMITED";
  availableQuantity: string;
  fulfilmentType: Fulfilment;
  city: string;
  area: string;
  contactPreference: "UNSET" | "CHAT_ONLY" | "LISTING_PHONE";
  contactPhone: string;
  attributes: Record<string, string | number>;
};

export const EMPTY_OFFER: OfferFormState = {
  title: "",
  category: "",
  categoryId: "",
  description: "",
  unitPrice: "",
  pricingMode: "FIXED",
  priceRepresentation: "FIXED",
  imageUrl: "",
  imageUrls: "",
  inventoryMode: "LIMITED",
  availableQuantity: "1",
  fulfilmentType: "PICKUP",
  city: "",
  area: "",
  contactPreference: "UNSET",
  contactPhone: "",
  attributes: {},
};

export type Errors = Partial<Record<keyof OfferFormState, string>>;
type Props = {
  form: OfferFormState;
  set: <K extends keyof OfferFormState>(k: K, v: OfferFormState[K]) => void;
  errors: Errors;
};

export function validateOffer(
  form: OfferFormState,
  section: "basics" | "image" | "inventory" | "fulfilment" | "all",
  currencyCode = "KWD",
  categories: readonly MarketplaceCategory[] = [],
): Errors {
  const e: Errors = {};
  const all = section === "all";
  const configured =
    categories.find(
      (category) =>
        category.id === form.categoryId || category.label === form.category,
    );
  if (
    !configured &&
    (all || section === "basics" || section === "inventory")
  )
    e.categoryId = "اختر تصنيفًا نشطًا من السجل.";
  if (all || section === "basics") {
    if (form.title.trim().length < 3)
      e.title = "اكتب عنوانًا من 3 أحرف على الأقل";
    if (form.description.trim().length < 10)
      e.description = "صف ما تشمله الوحدة في 10 أحرف على الأقل";
    if (
      configured &&
      !configured.rules.pricing.allowedModes.includes(form.pricingMode)
    )
      e.pricingMode = "طريقة التسعير غير مسموحة لهذا التصنيف.";
    if (form.priceRepresentation === "QUOTE_REQUIRED" && form.unitPrice.trim()) {
      e.unitPrice = "أزل السعر عند اختيار «حسب التسعيرة»؛ ترسل تسعيرتك لكل مشترٍ.";
    } else if (form.priceRepresentation === "QUOTE_REQUIRED") {
      // No amount: the seller quotes each buyer.
    } else if (form.pricingMode !== "OPEN_TO_OFFERS" || form.priceRepresentation === "STARTING_FROM" || form.unitPrice.trim()) {
      let unitPriceMinor = 0;
      try {
        unitPriceMinor = decimalToMinor(form.unitPrice.trim(), currencyCode);
      } catch {
        // The field-specific message below covers malformed or over-precise prices.
      }
      const pricing = configured?.rules.pricing;
      if (
        !Number.isSafeInteger(unitPriceMinor) ||
        unitPriceMinor < (pricing?.minAmountMinor ?? 1) ||
        unitPriceMinor > (pricing?.maxAmountMinor ?? 2_000_000_000)
      )
        e.unitPrice = "أدخل سعرًا صالحًا ضمن النطاق المعتمد لهذا التصنيف.";
    } else if (form.unitPrice.trim()) {
      e.unitPrice = "أزل السعر الثابت عند اختيار السعر بالاتفاق.";
    }
  }
  if (
    (all || section === "image") &&
    form.imageUrl.trim() &&
    !/^(https:\/\/|\/[^/])/.test(form.imageUrl.trim())
  )
    e.imageUrl = "استخدم رابطًا يبدأ بـ https://";
  if (
    (all || section === "image") &&
    (form.imageUrls.split("\n").filter(Boolean).length > 6 ||
      form.imageUrls
        .split("\n")
        .filter(Boolean)
        .some((url) => !/^(https:\/\/|\/[^/])/.test(url.trim())))
  )
    e.imageUrls = "حتى 6 روابط صور آمنة، كل رابط في سطر";
  if (
    all || section === "inventory"
  ) {
    const inventory = configured?.rules.inventory;
    if (!inventory?.allowedModes.includes(form.inventoryMode))
      e.inventoryMode = "طريقة إدارة المخزون غير مسموحة لهذا التصنيف.";
    if (inventory?.semantics === "NON_STOCK") {
      if (form.inventoryMode !== "UNLIMITED" || form.availableQuantity.trim())
        e.inventoryMode = "هذا التصنيف لا يستخدم كمية مخزون.";
    } else if (form.inventoryMode === "LIMITED") {
      const n = Number(form.availableQuantity);
      if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000)
        e.availableQuantity = "أدخل عددًا صحيحًا بين 1 و1,000,000";
      if (inventory?.semantics === "SINGLE" && n !== 1)
        e.availableQuantity = "هذا التصنيف مخصص لوحدة واحدة.";
    } else if (form.availableQuantity.trim()) {
      e.availableQuantity = "أزل الكمية عند اختيار مخزون غير محدود.";
    }
  }
  if ((all || section === "fulfilment") && form.area.trim().length < 2)
    e.area = "حدد المنطقة العامة (مثال: السالمية، أو عن بُعد)";
  if (all || section === "fulfilment") {
    if (form.contactPreference === "UNSET")
      e.contactPreference = "اختر طريقة التواصل التي ستظهر للمشترين";
    if (
      form.contactPreference === "LISTING_PHONE" &&
      !form.contactPhone.trim()
    )
      e.contactPhone = "أدخل رقمًا مخصصًا لهذا الإعلان";
    const phone = form.contactPhone
      .trim()
      .replace(/[٠-٩۰-۹]/g, (digit) => {
        const code = digit.charCodeAt(0);
        return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
      })
      .replace(/[^\d+]/g, "");
    if (phone && !/^\+?\d{7,15}$/.test(phone))
      e.contactPhone = "أدخل رقمًا صالحًا من 7 إلى 15 رقمًا";
  }
  if (all) {
    if (configured) {
      const attributes = validateCategoryAttributesAgainstSchema(
        form.category,
        form.attributes,
        configured,
        true,
      );
      if (!attributes.ok) e.attributes = attributes.reason;
      else if (attributes.missing.length)
        e.attributes = `أكمل خصائص الفئة المطلوبة: ${attributes.missing.join("، ")}`;
    } else {
      e.attributes = "تعذّر تحميل تعريف خصائص الفئة.";
    }
  }
  return e;
}

export function UnitPriceField({ form, set, errors }: Props) {
  const { market } = useAccount();
  const categoryQuery = useGetMarketplaceCategories();
  const category = categoryQuery.data?.find(
    (item) => item.id === form.categoryId || item.label === form.category,
  );
  const modes = category?.rules.pricing.allowedModes ?? [];
  // Every representation whose stored mode the category allows; STARTING_FROM and QUOTE_REQUIRED
  // are stored as OPEN_TO_OFFERS.
  const representations = PRICE_REPRESENTATIONS.filter((representation) =>
    modes.includes(representation === "STARTING_FROM" || representation === "QUOTE_REQUIRED" ? "OPEN_TO_OFFERS" : representation),
  );
  const representationHints: Record<PriceRepresentation, string> = {
    FIXED: "يشتري المشتري بهذا السعر مباشرة، ويستطيع أيضًا أن يقدّم لك عرضًا تقبله أو ترفضه.",
    NEGOTIABLE: "تعرض سعرك المطلوب ويُشترى العرض بالسعر الذي تتفقان عليه.",
    OPEN_TO_OFFERS: "يمكنك ترك السعر فارغًا لاستقبال العروض، أو إضافة سعر استرشادي. لا يتم الشراء المباشر قبل الاتفاق.",
    STARTING_FROM: "يظهر «يبدأ من» قبل المبلغ. ليس سعرًا نهائيًا: يتفق معك المشتري على السعر قبل الشراء.",
    QUOTE_REQUIRED: "لا يظهر سعر. يطلب المشتري تسعيرة، فترسل له سعرك، ثم يقبله أو يفاوض عليه.",
  };
  const openToOffers = form.priceRepresentation === "OPEN_TO_OFFERS";
  const quote = form.priceRepresentation === "QUOTE_REQUIRED";
  const priceLabel =
    form.priceRepresentation === "STARTING_FROM"
      ? "السعر الذي يبدأ منه العرض"
      : openToOffers
        ? "سعر استرشادي اختياري"
        : "سعر الوحدة";
  return (
    <div className="space-y-3">
      {representations.length > 1 && (
        <Field label="طريقة التسعير" error={errors.pricingMode}>
          <select
            className="min-h-12 w-full rounded-md border border-border bg-card px-3 text-base"
            value={form.priceRepresentation}
            onChange={(event) => {
              const representation = event.target.value as PriceRepresentation;
              set("priceRepresentation", representation);
              const stored = storedPricingFor(representation, representation === "QUOTE_REQUIRED" ? null : 1);
              if (!("problem" in stored)) set("pricingMode", stored.pricingMode);
              if (representation === "QUOTE_REQUIRED") set("unitPrice", "");
            }}
            data-testid="select-listing-pricing-mode"
          >
            {representations.map((representation) => (
              <option key={representation} value={representation}>{PRICE_REPRESENTATION_LABELS[representation]}</option>
            ))}
          </select>
        </Field>
      )}
      <p className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground" data-testid="hint-listing-pricing">
        {representationHints[form.priceRepresentation]} يستطيع المشترون تقديم عروض أسعار على كل الإعلانات، والقرار لك.
      </p>
      {!quote && (
        <Field
          label={`${priceLabel} (${market?.currencyCode ?? ""})`}
          error={errors.unitPrice}
          hint={`${openToOffers ? "يمكنك تركه فارغًا لاستقبال العروض فقط. " : ""}دقة العملة: ${market?.minorUnitScale ?? 3} منازل عشرية كحد أقصى.`}
        >
          <Input
            type="text"
            inputMode="decimal"
            dir="ltr"
            maxLength={32}
            className="num max-w-[240px] text-start"
            value={form.unitPrice}
            onChange={(e) =>
              set("unitPrice", e.target.value.replace(/[^\d.]/g, ""))
            }
            placeholder={market?.minorUnitScale === 0 ? "100" : "12.50"}
            data-testid="input-listing-price"
          />
        </Field>
      )}
    </div>
  );
}

export function BasicsFields({ form, set, errors }: Props) {
  const categoryQuery = useGetMarketplaceCategories();
  const categories = categoryQuery.data;
  const categoryLabels = categories?.map((category) => ({
    id: category.id,
    label: category.label,
  })) ?? [];
  const selectedCategory =
    categories?.find(
      (category) =>
        category.id === form.categoryId || category.label === form.category,
    );
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">التصنيف</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {categoryLabels.map((category) => {
            const Icon = categoryIcon(category.label);
            const active = form.category === category.label;
            return (
              <button
                key={category.id || category.label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  set("category", category.label);
                  set("categoryId", category.id);
                }}
                data-testid={`button-category-option-${category.label}`}
                className={cn(
                  "pressable flex h-14 items-center gap-2.5 rounded-md border px-3 text-start text-base font-semibold",
                  active
                    ? "border-primary bg-primary-soft text-primary-soft-foreground ring-1 ring-primary"
                    : "border-border bg-card hover:border-border-strong",
                )}
              >
                <Icon
                  size={19}
                  aria-hidden
                  className={active ? "" : "text-muted-foreground"}
                />
                {category.label}
              </button>
            );
          })}
        </div>
        {categoryQuery.isLoading && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            جارٍ تحميل التصنيفات…
          </p>
        )}
        {categoryQuery.isError && (
          <p role="status" className="mt-2 text-xs text-warning">
            تعذّر تحميل التصنيفات. أعد المحاولة قبل نشر العرض.
          </p>
        )}
        {errors.categoryId && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {errors.categoryId}
          </p>
        )}
      </fieldset>
      <Field
        label="عنوان العرض"
        error={errors.title}
        hint="اسم واضح يبحث عنه الناس. مثال: كيكة شوكولاتة منزلية"
      >
        <Input
          value={form.title}
          maxLength={120}
          onChange={(e) => set("title", e.target.value)}
          data-testid="input-listing-title"
        />
      </Field>
      <Field
        label="ماذا تشمل الوحدة؟"
        error={errors.description}
        hint="وضّح ما يحصل عليه المشتري مقابل وحدة واحدة."
      >
        <Textarea
          value={form.description}
          maxLength={4000}
          onChange={(e) => set("description", e.target.value)}
          placeholder="مثال: الوحدة = قطعة واحدة وزن 250 غرام، تُسلَّم في علبة."
          data-testid="input-listing-description"
        />
      </Field>
      <UnitPriceField form={form} set={set} errors={errors} />
      {selectedCategory &&
        Object.entries(selectedCategory.attributes).map(
          ([key, definition]) => (
            <Field key={key} label={definition.label} optional={!definition.requiredForPublish}>
              <Input
                type={definition.type === "number" ? "text" : "text"}
                inputMode={definition.type === "number" ? "numeric" : undefined}
                dir={definition.type === "number" ? "ltr" : undefined}
                value={String(form.attributes[key] ?? "")}
                onChange={(event) =>
                  set("attributes", {
                    ...form.attributes,
                    [key]: event.target.value,
                  })
                }
                placeholder={definition.options?.join("، ")}
                data-testid={`input-listing-attribute-${key}`}
              />
            </Field>
          ),
        )}
      {errors.attributes && (
        <p role="alert" className="text-sm text-destructive">
          {errors.attributes}
        </p>
      )}
    </div>
  );
}

export function ImageField({ form, set, errors }: Props) {
  const url = form.imageUrl.trim();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const images = [
    form.imageUrl.trim(),
    ...form.imageUrls.split("\n").map((item) => item.trim()),
  ].filter(Boolean);
  const setImages = (next: string[]) => {
    set("imageUrl", next[0] ?? "");
    set("imageUrls", next.slice(1).join("\n"));
  };
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError("");
    const selected = Array.from(files);
    if (images.length + selected.length > 4) {
      setUploadError("يمكن إضافة أربع صور كحد أقصى.");
      return;
    }
    setUploading(true);
    const uploaded: string[] = [];
    try {
      for (const file of selected) uploaded.push(await uploadListingPhoto(file));
      setImages([...images, ...uploaded]);
    } catch (error) {
      if (uploaded.length) setImages([...images, ...uploaded]);
      setUploadError(
        error instanceof Error ? error.message : "تعذر رفع الصورة.",
      );
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="grid gap-5 sm:grid-cols-[200px_1fr] sm:items-start">
      <div className="mx-auto aspect-square w-full max-w-[240px] overflow-hidden rounded-xl border border-border">
        <SmartImage
          key={url}
          src={url && !errors.imageUrl ? url : ""}
          alt="معاينة صورة العرض"
          fallbackIcon={categoryIcon(form.category)}
        />
      </div>
      <div className="space-y-3">
        <Field
          label="رفع صور من الجهاز"
          optional
          hint="حتى 4 صور، JPEG أو PNG أو WebP، بحد أقصى 5 ميغابايت للصورة."
        >
          <Input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={uploading}
            onChange={(event) => {
              void uploadFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            data-testid="input-listing-photo-upload"
          />
        </Field>
        {uploading && (
          <p role="status" className="text-sm text-muted-foreground">
            جارٍ رفع الصور والتحقق منها…
          </p>
        )}
        {uploadError && (
          <p role="alert" className="text-sm text-destructive">
            {uploadError}
          </p>
        )}
        {images.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {images.map((src, index) => (
              <div
                key={`${src}-${index}`}
                className="relative aspect-square overflow-hidden rounded-lg border border-border"
              >
                <SmartImage src={src} alt={`صورة العرض ${index + 1}`} />
                <button
                  type="button"
                  aria-label={`حذف الصورة ${index + 1}`}
                  onClick={() => setImages(images.filter((_, i) => i !== index))}
                  className={`${iconButtonClass("outline")} !absolute end-1 top-1`}
                >
                  <X size={15} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
        <Field
          label="رابط الصورة"
          optional
          error={errors.imageUrl}
          hint="صورة مربعة وواضحة تعمل أفضل. استخدم صورة تملك حق استخدامها."
        >
          <Input
            type="url"
            dir="ltr"
            inputMode="url"
            value={form.imageUrl}
            onChange={(e) => set("imageUrl", e.target.value)}
            placeholder="https://"
            className="text-start"
            data-testid="input-listing-image"
          />
        </Field>
        <Field
          label="صور إضافية"
          optional
          error={errors.imageUrls}
          hint="حتى 6 روابط، كل رابط في سطر"
        >
          <Textarea
            value={form.imageUrls}
            onChange={(e) => set("imageUrls", e.target.value)}
            maxLength={12000}
            dir="ltr"
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          تبقى صور المسودة خاصة، ولا تظهر للآخرين إلا بعد نشر العرض.
        </p>
      </div>
    </div>
  );
}

export function InventoryFields({
  form,
  set,
  errors,
  reserved,
  category,
}: Props & { reserved?: number; category?: MarketplaceCategory }) {
  const inventory = category?.rules.inventory;
  if (!inventory)
    return (
      <p className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        تعذّر تحميل قواعد المخزون لهذا التصنيف.
      </p>
    );
  if (inventory.semantics === "NON_STOCK")
    return (
      <p className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        لا يتطلب هذا التصنيف كمية مخزون.
      </p>
    );
  if (inventory.semantics === "SINGLE")
    return (
      <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        هذا التصنيف مخصص لوحدة واحدة فقط.
      </div>
    );
  const showModeChoice = inventory.allowedModes.length > 1;
  return (
    <div className="space-y-4">
      {showModeChoice && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">
            هل تريد تتبع الكمية؟
          </legend>
          {inventory.allowedModes.includes("LIMITED") && (
            <ChoiceCard
              name="inventoryMode"
              value="LIMITED"
              selected={form.inventoryMode === "LIMITED"}
              onSelect={() => set("inventoryMode", "LIMITED")}
              icon={<Hash size={19} aria-hidden />}
              title="كمية محدودة"
              description="يتوقف البيع تلقائيًا عند نفاد الوحدات."
              testId="button-inventory-limited"
            />
          )}
          {inventory.allowedModes.includes("UNLIMITED") && (
            <ChoiceCard
              name="inventoryMode"
              value="UNLIMITED"
              selected={form.inventoryMode === "UNLIMITED"}
              onSelect={() => set("inventoryMode", "UNLIMITED")}
              icon={<InfinityIcon size={19} aria-hidden />}
              title="غير محدودة"
              description="لا حاجة لإدخال كمية."
              testId="button-inventory-unlimited"
            />
          )}
        </fieldset>
      )}
      {form.inventoryMode === "LIMITED" && (
        <Field
          label="الكمية المتوفرة"
          error={errors.availableQuantity}
          hint={
            reserved
              ? `تشمل ${reserved} محجوزة لطلبات قائمة — لا يمكن النزول تحتها.`
              : "عدد الوحدات التي يمكنك بيعها الآن."
          }
        >
          <Input
            type="text"
            inputMode="numeric"
            dir="ltr"
            className="num max-w-[200px] text-start"
            value={form.availableQuantity}
            onChange={(e) =>
              set("availableQuantity", e.target.value.replace(/[^\d]/g, ""))
            }
            data-testid="input-listing-quantity"
          />
        </Field>
      )}
    </div>
  );
}

export function FulfilmentFields({ form, set, errors }: Props) {
  const digital = form.fulfilmentType === "DIGITAL";
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">
          كيف يحصل المشتري على الوحدة؟
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(FULFILMENT) as Fulfilment[]).map((k) => {
            const f = FULFILMENT[k];
            return (
              <ChoiceCard
                key={k}
                name="fulfilmentType"
                value={k}
                selected={form.fulfilmentType === k}
                onSelect={() => {
                  set("fulfilmentType", k);
                  if (k === "DIGITAL" && !form.area.trim())
                    set("area", "عن بُعد");
                }}
                icon={<f.icon size={19} aria-hidden />}
                title={f.label}
                description={f.seller}
                testId={`button-fulfilment-${k}`}
              />
            );
          })}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="المدينة" optional={digital}>
          <Input
            value={form.city}
            maxLength={100}
            onChange={(e) => set("city", e.target.value)}
            placeholder={digital ? "اختياري" : "مثال: مدينة الكويت"}
            data-testid="input-listing-city"
          />
        </Field>
        <Field label="المنطقة العامة" error={errors.area}>
          <Input
            value={form.area}
            maxLength={100}
            onChange={(e) => set("area", e.target.value)}
            placeholder={digital ? "عن بُعد" : "مثال: السالمية"}
            data-testid="input-listing-area"
          />
        </Field>
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="mb-1 text-sm font-semibold">
          كيف يتواصل المشترون معك؟
        </legend>
        <ChoiceCard
          name="contactPreference"
          value="CHAT_ONLY"
          selected={form.contactPreference === "CHAT_ONLY"}
          onSelect={() => {
            set("contactPreference", "CHAT_ONLY");
            set("contactPhone", "");
          }}
          icon={<ShieldCheck size={19} aria-hidden />}
          title="محادثة DINAR فقط"
          description="لن يظهر رقم هاتف على الإعلان."
          testId="button-contact-chat-only"
        />
        <ChoiceCard
          name="contactPreference"
          value="LISTING_PHONE"
          selected={form.contactPreference === "LISTING_PHONE"}
          onSelect={() => set("contactPreference", "LISTING_PHONE")}
          icon={<ShieldCheck size={19} aria-hidden />}
          title="رقم مخصص لهذا الإعلان"
          description="سيظهر الرقم الذي تدخله أدناه فقط، وليس رقم تسجيل الدخول."
          testId="button-contact-listing-phone"
        />
        {errors.contactPreference && (
          <p role="alert" className="text-sm text-danger">
            {errors.contactPreference}
          </p>
        )}
        {form.contactPreference === "LISTING_PHONE" && (
          <Field
            label="رقم هذا الإعلان"
            error={errors.contactPhone}
            hint="أدخل الرقم الذي تسمح بعرضه علنًا. لن نستخدم رقم حسابك تلقائيًا."
          >
            <Input
              type="tel"
              dir="ltr"
              inputMode="tel"
              maxLength={30}
              value={form.contactPhone}
              onChange={(event) => set("contactPhone", event.target.value)}
              placeholder="+962 7…"
              data-testid="input-listing-contact-phone"
              className="text-start"
            />
          </Field>
        )}
      </fieldset>
      </div>
      <p className="flex gap-2 text-xs text-muted-foreground">
        <ShieldCheck size={15} className="shrink-0 text-success" aria-hidden />
        تظهر المنطقة العامة فقط للمشترين. لا تكتب عنوان منزلك — العنوان الدقيق
        يُشارك داخل الطلب عند الحاجة.
      </p>
    </div>
  );
}

export const offerPayload = (
  form: OfferFormState,
  categories: readonly MarketplaceCategory[] = [],
) => {
  const category =
    categories.find(
      (item) => item.id === form.categoryId || item.label === form.category,
    );
  const inventory = category?.rules.inventory;
  const inventoryMode =
    inventory?.semantics === "NON_STOCK" ? "UNLIMITED" : form.inventoryMode;
  return {
  title: form.title.trim(),
  category: form.category,
  ...(form.categoryId ? { categoryId: form.categoryId } : {}),
  description: form.description.trim(),
    unitPrice: form.priceRepresentation === "QUOTE_REQUIRED" ? null : form.unitPrice.trim() || null,
  pricingMode: form.pricingMode,
  priceRepresentation: form.priceRepresentation,
  imageUrl: form.imageUrl.trim(),
  imageUrls: form.imageUrls
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
  inventoryMode,
  availableQuantity:
    inventoryMode === "LIMITED"
      ? Number(form.availableQuantity)
      : null,
  fulfilmentType: form.fulfilmentType,
  city: form.city.trim(),
  area: form.area.trim(),
  contactPhone:
    form.contactPreference === "LISTING_PHONE"
      ? form.contactPhone.trim() || null
      : null,
  attributes: form.attributes,
  };
};
