import { useEffect, useState } from "react";
import { PendingNotice } from "./SmartSurfaces";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetListingsQueryKey,
  useApplyAiListingManagementPreview,
} from "@workspace/api-client-react";
import { OWN_LISTINGS } from "@/lib/marketplace";
import { Button } from "@/ui/Button";
import type { AiListingManagementPreview } from "./ai-api";

const ACTION_LABEL: Record<AiListingManagementPreview["action"], string> = {
  UPDATE: "تأكيد التغيير",
  PAUSE: "تأكيد الإيقاف",
  RESUME: "تأكيد الاستئناف",
  ARCHIVE: "تأكيد الأرشفة",
};

const STATUS_LABEL: Record<AiListingManagementPreview["status"], string> = {
  PENDING: "",
  CONFIRMED: "تم تنفيذ الإجراء.",
  CANCELLED: "أُلغيت المعاينة دون تغيير الإعلان.",
  EXPIRED: "انتهت صلاحية المعاينة. لم يتغير الإعلان.",
};

export function ListingManagementPreviewCard({
  preview,
}: {
  preview: AiListingManagementPreview;
}) {
  const queryClient = useQueryClient();
  const action = useApplyAiListingManagementPreview();
  const [status, setStatus] = useState(preview.status);
  const [error, setError] = useState("");

  useEffect(() => setStatus(preview.status), [preview.status]);

  const apply = async (nextAction: "CONFIRM" | "CANCEL") => {
    setError("");
    try {
      const result = await action.mutateAsync({
        id: preview.previewId,
        data: { action: nextAction },
      });
      setStatus(result.status);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetListingsQueryKey(OWN_LISTINGS),
        }),
        queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey.some(
              (part) =>
                typeof part === "string" && part.includes("/api/listings"),
            ),
        }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "تعذر تنفيذ الإجراء. حدّث المحادثة وحاول مرة أخرى.",
      );
    }
  };

  return (
    <section
      className="ai-surface my-3 max-w-xl rounded-xl border border-primary/30 bg-primary-soft/20 p-4"
      aria-label={`معاينة ${preview.listingTitle}`}
      data-testid={`listing-management-preview-${preview.previewId}`}
    >
      <h3 className="font-semibold">{preview.listingTitle}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{preview.fieldLabel}</p>
      <div
        className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg bg-background p-3"
        data-testid={`listing-management-values-${preview.previewId}`}
      >
        <p className="min-w-0 break-words text-sm" data-testid="text-before-value">
          {preview.beforeValue || "—"}
        </p>
        <span aria-hidden className="text-muted-foreground">
          ←
        </span>
        <p className="min-w-0 break-words text-sm font-semibold" data-testid="text-after-value">
          {preview.afterValue || "—"}
        </p>
      </div>
      {preview.action === "ARCHIVE" && (
        <p className="mt-3 text-xs text-muted-foreground">
          سيختفي الإعلان من الاكتشاف. تبقى الطلبات والمراجع المالية التاريخية محفوظة.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {status === "PENDING" && <PendingNotice>معاينة فقط — لم يتغير الإعلان بعد.</PendingNotice>}
      {status === "PENDING" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={preview.action === "ARCHIVE" ? "danger" : "primary"}
            loading={action.isPending}
            disabled={action.isPending}
            onClick={() => void apply("CONFIRM")}
            data-testid={`button-confirm-listing-preview-${preview.previewId}`}
          >
            {ACTION_LABEL[preview.action]}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => void apply("CANCEL")}
            data-testid={`button-cancel-listing-preview-${preview.previewId}`}
          >
            إلغاء
          </Button>
        </div>
      ) : (
        <p
          role="status"
          className="mt-3 text-sm font-medium"
          data-testid={`status-listing-preview-${preview.previewId}`}
        >
          {STATUS_LABEL[status]}
        </p>
      )}
    </section>
  );
}