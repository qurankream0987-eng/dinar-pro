import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  CompleteListingPhotoUploadBody,
  CompleteListingPhotoUploadResponse,
  RequestListingPhotoUploadBody,
  RequestListingPhotoUploadResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import {
  completeListingPhotoUpload,
  MAX_LISTING_PHOTO_BYTES,
} from "../lib/listing-photos";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const storage = new ObjectStorageService();
const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

router.post("/account/listing-photos/upload-url", requireAuth, async (req, res) => {
  const body = RequestListingPhotoUploadBody.parse(req.body);
  if (
    !extensions[body.contentType] ||
    body.size < 1 ||
    body.size > MAX_LISTING_PHOTO_BYTES
  )
    throw Object.assign(
      new Error("اختر صورة JPEG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت."),
      { status: 400 },
    );

  const acceptanceRunId = process.env.BDINAR_A09_STORAGE_RUN_ID;
  const acceptanceNamespace =
    process.env.BDINAR_OBJECT_STORAGE_ACCEPTANCE === "authorized" &&
    process.env.BDINAR_DISPOSABLE_TEST_DATABASE === "1" &&
    process.env.DINAR_DISPOSABLE_ACCEPTANCE_DB === "1" &&
    process.env.NODE_ENV === "development" &&
    acceptanceRunId &&
    /^[a-f0-9]{10}$/.test(acceptanceRunId)
      ? `acceptance-A09-${acceptanceRunId}-seller-${req.actor!.id}-`
      : "";
  const objectName = `listing-photos/${req.actor!.id}/${acceptanceNamespace}${randomUUID()}.${extensions[body.contentType]}`;
  const uploadURL = await storage.getObjectEntityUploadURL(objectName);
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  if (!objectPath.startsWith(`/objects/listing-photos/${req.actor!.id}/`))
    throw new Error("تعذر إنشاء مسار آمن للصورة");
  if (acceptanceNamespace) {
    try {
      await storage.getObjectEntityFile(objectPath);
      throw Object.assign(new Error("تعارض مسار رفع A09؛ أعد المحاولة."), {
        status: 409,
      });
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }

  res.json(RequestListingPhotoUploadResponse.parse({ uploadURL, objectPath }));
});

router.post("/account/listing-photos/complete", requireAuth, async (req, res) => {
  const body = CompleteListingPhotoUploadBody.parse(req.body);
  const objectPath = await completeListingPhotoUpload(
    body.objectPath,
    req.actor!.id,
  );
  res.json(CompleteListingPhotoUploadResponse.parse({ objectPath }));
});

export default router;