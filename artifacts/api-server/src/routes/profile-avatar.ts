import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Router } from "express";
import {
  RequestProfileAvatarUploadBody,
  RequestProfileAvatarUploadResponse,
  SetProfileAvatarBody,
  SetProfileAvatarResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { db, users } from "@workspace/db";
import { ObjectPermission } from "../lib/objectAcl";
import { requireAuth } from "../lib/auth";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { isPublishedListingPhoto } from "../lib/listing-photos";

const router = Router();
const storage = new ObjectStorageService();
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const generatedAvatarFileName =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

function isOwnedAvatarPath(objectPath: string, ownerPrefix: string) {
  return (
    objectPath.startsWith(ownerPrefix) &&
    generatedAvatarFileName.test(objectPath.slice(ownerPrefix.length))
  );
}

function imageSignatureMatches(bytes: Buffer, contentType: string) {
  if (contentType === "image/jpeg")
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png")
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/webp")
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

router.post("/account/profile-avatar/upload-url", requireAuth, async (req, res) => {
  const body = RequestProfileAvatarUploadBody.parse(req.body);
  if (!extensions[body.contentType] || body.size > MAX_AVATAR_BYTES)
    throw Object.assign(new Error("اختر صورة JPEG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت."), {
      status: 400,
    });

  const objectName = `profile-avatars/${req.actor!.id}/${randomUUID()}.${extensions[body.contentType]}`;
  const uploadURL = await storage.getObjectEntityUploadURL(objectName);
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  if (!objectPath.startsWith(`/objects/profile-avatars/${req.actor!.id}/`))
    throw new Error("تعذر إنشاء مسار آمن للصورة");

  res.json(RequestProfileAvatarUploadResponse.parse({ uploadURL, objectPath }));
});

router.put("/account/profile-avatar", requireAuth, async (req, res) => {
  const body = SetProfileAvatarBody.parse(req.body);
  const ownerPrefix = `/objects/profile-avatars/${req.actor!.id}/`;
  if (!isOwnedAvatarPath(body.objectPath, ownerPrefix))
    throw Object.assign(new Error("لا يمكن استخدام صورة تخص حسابًا آخر."), {
      status: 403,
    });

  let objectFile;
  try {
    objectFile = await storage.getObjectEntityFile(body.objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError)
      throw Object.assign(new Error("لم يكتمل رفع الصورة. حاول مرة أخرى."), {
        status: 400,
      });
    throw error;
  }

  const [metadata] = await objectFile.getMetadata();
  const actualSize = Number(metadata.size);
  const contentType = metadata.contentType ?? "";
  if (
    !Number.isSafeInteger(actualSize) ||
    actualSize < 1 ||
    actualSize > MAX_AVATAR_BYTES ||
    !extensions[contentType]
  )
    throw Object.assign(new Error("الصورة غير صالحة أو يتجاوز حجمها 5 ميغابايت."), {
      status: 400,
    });

  const [header] = await objectFile.download({ start: 0, end: 11 });
  if (!imageSignatureMatches(header, contentType))
    throw Object.assign(new Error("محتوى الملف لا يطابق نوع الصورة."), {
      status: 400,
    });

  await storage.trySetObjectEntityAclPolicy(body.objectPath, {
    owner: req.actor!.id,
    visibility: "public",
  });
  const [updated] = await db
    .update(users)
    .set({ avatarObjectPath: body.objectPath, updatedAt: new Date() })
    .where(eq(users.id, req.actor!.id))
    .returning({ avatarObjectPath: users.avatarObjectPath });
  if (!updated?.avatarObjectPath)
    throw new Error("تعذر حفظ صورة الملف الشخصي");

  const previousPath = req.actor!.avatarObjectPath;
  if (
    previousPath &&
    previousPath !== body.objectPath &&
    isOwnedAvatarPath(previousPath, ownerPrefix)
  ) {
    try {
      const previousFile = await storage.getObjectEntityFile(previousPath);
      await previousFile.delete({ ignoreNotFound: true });
    } catch (error) {
      logger.warn({ err: error }, "Could not remove the previous profile avatar");
    }
  }

  res.json(
    SetProfileAvatarResponse.parse({
      avatarObjectPath: updated.avatarObjectPath,
    }),
  );
});

router.get("/storage/objects/*objectKey", async (req, res) => {
  const raw = req.params.objectKey;
  const objectKey = Array.isArray(raw) ? raw.join("/") : raw;
  const isAvatar = objectKey.startsWith("profile-avatars/");
  const isListingPhoto = objectKey.startsWith("listing-photos/");
  // A buyer's search photo is shown to its owner only; it is never public.
  const isVisualSearch = objectKey.startsWith("visual-search/");
  if (!isAvatar && !isListingPhoto && !isVisualSearch) {
    res.status(404).json({ error: "الصورة غير موجودة" });
    return;
  }

  try {
    const objectFile = await storage.getObjectEntityFile(`/objects/${objectKey}`);
    const canRead = await storage.canAccessObjectEntity({
      userId: req.actor?.id,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    const ownerPath =
      isListingPhoto &&
      Boolean(req.actor?.id) &&
      objectKey.startsWith(`listing-photos/${req.actor!.id}/`);
    const publishedListingPhoto =
      isListingPhoto && (await isPublishedListingPhoto(`/objects/${objectKey}`));
    const authorized = isVisualSearch
      ? Boolean(req.actor?.id) && objectKey.startsWith(`visual-search/${req.actor!.id}/`) && canRead
      : isListingPhoto
      ? ownerPath
        ? canRead
        : publishedListingPhoto
      : canRead;
    if (!authorized) {
      res.status(404).json({ error: "الصورة غير موجودة" });
      return;
    }

    const response = await storage.downloadObject(objectFile, 86400);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "الصورة غير موجودة" });
      return;
    }
    logger.error({ err: error }, "Could not serve a profile avatar");
    res.status(500).json({ error: "تعذر عرض الصورة" });
  }
});

export default router;