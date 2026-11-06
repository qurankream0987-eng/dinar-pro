import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ExternalLink, PackageX } from "lucide-react";
import {
  getGetListingQueryKey,
  getGetListingsQueryKey,
  useGetListing,
  useGetMarketplaceCategories,
  useUpdateListing,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { offerRepresentation, type Fulfilment, type Offer } from "@/lib/marketplace";
import { Button, ButtonLink } from "@/ui/Button";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 md:p-6">
      <h2 className="mb-4 text-md font-bold">{title}</h2>
      {children}
    </section>
  );
}

export default function EditOffer() {
  const { id = "" } = useParams<{ id: string }>();
  const { user } = useAccount();
  const listing = useGetListing(id, {
    query: { queryKey: getGetListingQueryKey(id), enabled: !!id },
  });
  const categories = useGetMarketplaceCategories();
  const update = useUpdateListing();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [form, setForm] = useState<OfferFormState>(EMPTY_OFFER);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [editSnapshot, setEditSnapshot] = useState<{ id: string; owner: string; version: string } | null>(null);
  const selectedCategory = categories.data?.find(
    (category) =>
      category.id === form.categoryId || category.label === form.category,
  );
  const requiresInventory =
    selectedCategory?.rules.sellerDraft.requiredFields.includes("INVENTORY") ??
    true;

  useEffect(() => {
    const d = listing.data as Offer | undefined;
    if (!user || !d?.updatedAt || d.id !== id || d.sellerId !== user.id) return;
    // Background reads must not silently replace a draft or advance its edit precondition.
    if (editSnapshot?.id === id && editSnapshot.owner === user.id) return;
    setEditSnapshot({ id, owner: user.id, version: d.updatedAt });
    setForm({
      title: d.title,
      category: d.category,
      categoryId:
        d.categoryId ??
        categories.data?.find((category) => category.label === d.category)?.id ??
        "",
      description: d.description,
      unitPrice: d.unitPrice ?? "",
      pricingMode: d.pricingMode ?? "FIXED",
      priceRepresentation: offerRepresentation(d) ?? d.pricingMode ?? "FIXED",
      imageUrl: d.imageUrl ?? "",
      imageUrls: (
        (d as typeof d & { imageUrls?: string[] }).imageUrls ?? []
      ).join("\n"),
      inventoryMode: d.inventoryMode,
      availableQuantity: String(d.availableQuantity ?? 1),
      fulfilmentType: d.fulfilmentType as Fulfilment,
      city: d.city ?? "",
      area: d.area,
      contactPreference: d.contactPhone ? "LISTING_PHONE" : "CHAT_ONLY",
      contactPhone: d.contactPhone ?? "",
      attributes: Object.fromEntries(
        Object.entries(d.attributes ?? {}).filter(
          ([, value]) => typeof value === "string" || typeof value === "number",
        ),
      ) as Record<string, string | number>,
    });
  }, [listing.data, id, user?.id, editSnapshot]);

  const set = <K extends keyof OfferFormState>(k: K, v: OfferFormState[K]) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (k === "category" && v !== f.category) {
        next.attributes = {};
        const category = categories.data?.find((item) => item.label === v);
        if (category) {
          next.categoryId = category.id;
          next.pricingMode = category.rules.pricing.defaultMode;
          next.priceRepresentation = category.rules.pricing.defaultMode;
          next.unitPrice = next.pricingMode === "OPEN_TO_OFFERS" ? "" : next.unitPrice;
          next.inventoryMode = category.rules.inventory.defaultMode;
          next.availableQuantity =
            next.inventoryMode === "LIMITED"
              ? String(category.rules.inventory.defaultQuantity ?? 1)
              : "";
        }
      }
      return next;
    });
  };

  if (listing.isLoading)
    return (
      <div className="container-app max-w-2xl space-y-4 pt-8" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  if (listing.isError || !listing.data)
    return (
      <div className="container-app">
        <ErrorState
          title="تعذّر تحميل العرض"
          onRetry={() => listing.refetch()}
        />
      </div>
    );
  const data = listing.data as Offer;
  if (data.sellerId !== user?.id)
    return (
      <div className="container-app">
        <EmptyState
          icon={PackageX}
          title="لا يمكنك تعديل هذا العرض"
          body="يمكن تعديل العروض من حساب صاحبها فقط."
          action={<ButtonLink href="/seller/offers">عروضي</ButtonLink>}
        />
      </div>
    );

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    if (!editSnapshot || editSnapshot.id !== id || editSnapshot.owner !== user?.id) {
      setError("تعذر التحقق من نسخة العرض. أعد تحميله قبل الحفظ.");
      return;
    }
    const errs = validateOffer(
      form,
      "all",
      data.currency,
      categories.data ?? [],
    );
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError("راجع الحقول المظللة.");
      return;
    }
    setError("");
    setConflict(false);
    update.mutate(
      { id, data: { ...offerPayload(form, categories.data ?? []), expectedUpdatedAt: editSnapshot.version } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getGetListingQueryKey(id) });
          void qc.invalidateQueries({ queryKey: getGetListingsQueryKey() });
          toast.success("تم حفظ التعديلات");
          navigate("/seller/offers");
        },
        onError: (err) => {
          setError(friendlyError(err, "تعذر حفظ التعديلات."));
          setConflict(err.status === 409);
        },
      },
    );
  };

  return (
    <div className="container-app max-w-2xl">
      <PageHeader
        back="/seller/offers"
        title="تعديل العرض"
        subtitle={data.title}
        actions={
          <ButtonLink
            href={`/listings/${id}`}
            variant="ghost"
            size="sm"
            icon={<ExternalLink size={16} />}
          >
            <span className="hidden sm:inline">عرض الصفحة</span>
          </ButtonLink>
        }
      />
      <form noValidate onSubmit={save} className="space-y-4">
        <Section title="الأساسيات">
          <BasicsFields form={form} set={set} errors={errors} />
        </Section>
        <Section title="الصورة">
          <ImageField form={form} set={set} errors={errors} />
        </Section>
        {requiresInventory && (
          <Section title="الكمية">
            <InventoryFields
              form={form}
              set={set}
              errors={errors}
              reserved={data.reservedQuantity}
              category={selectedCategory}
            />
          </Section>
        )}
        <Section title="التنفيذ والموقع">
          <FulfilmentFields form={form} set={set} errors={errors} />
        </Section>
        {error && (
          <InlineAlert tone="danger" testId="status-edit-listing-error">
            {error}
          </InlineAlert>
        )}
        {conflict && (
          <Button type="button" variant="secondary" data-testid="button-reload-edit-listing" onClick={async () => {
            const latest = await listing.refetch();
            if (latest.isSuccess) {
              setEditSnapshot(null);
              setConflict(false);
              setError("");
            }
          }}>
            تحميل النسخة الحالية وإهمال تعديلاتي
          </Button>
        )}
        <div
          className="fixed inset-x-0 bottom-0 z-[var(--z-action-bar)] flex gap-2 border-t border-border bg-card/95 px-[var(--gutter)] pt-3 backdrop-blur-xl md:static md:justify-end md:border-0 md:bg-transparent md:p-0"
          style={{ paddingBottom: "max(12px, var(--safe-bottom))" }}
        >
          <ButtonLink
            href="/seller/offers"
            variant="secondary"
            size="lg"
            className="hidden md:inline-flex"
          >
            إلغاء
          </ButtonLink>
          <Button
            type="submit"
            size="lg"
            block
            className="md:w-auto"
            loading={update.isPending}
            icon={<Check size={18} />}
            data-testid="button-save-listing"
          >
            حفظ التعديلات
          </Button>
        </div>
      </form>
    </div>
  );
}
