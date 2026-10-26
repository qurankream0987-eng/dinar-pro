import { and, eq, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db, offers } from "@workspace/db";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "./objectStorage";
import { ObjectPermission } from "./objectAcl";

export const MAX_LISTING_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_LISTING_PHOTOS = 4;

const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const generatedPhotoFileName =
  /^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|acceptance-A09-[a-f0-9]{10}-seller-[a-zA-Z0-9-]+-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.(?:jpg|png|webp)$/i;
const sealedPhotoFileName =
  /^sealed-(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|acceptance-A09-[a-f0-9]{10}-seller-[a-zA-Z0-9-]+-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.(?:jpg|png|webp)$/i;

const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

export function isOwnedListingPhotoPath(objectPath: string, ownerId: string) {
  const prefix = `/objects/listing-photos/${ownerId}/`;
  return (
    objectPath.startsWith(prefix) &&
    (generatedPhotoFileName.test(objectPath.slice(prefix.length)) ||
      sealedPhotoFileName.test(objectPath.slice(prefix.length)))
  );
}

export function isSealedListingPhotoPath(
  objectPath: string,
  ownerId: string,
) {
  const prefix = `/objects/listing-photos/${ownerId}/`;
  return (
    objectPath.startsWith(prefix) &&
    sealedPhotoFileName.test(objectPath.slice(prefix.length))
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

async function validateListingPhoto(
  storage: ObjectStorageService,
  objectPath: string,
  ownerId: string,
  requireOwnerAccess: boolean,
) {
  if (!isOwnedListingPhotoPath(objectPath, ownerId))
    throw fail(403, "لا يمكن استخدام صورة تخص حسابًا آخر.");

  let objectFile;
  try {
    objectFile = await storage.getObjectEntityFile(objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError)
      throw fail(400, "لم يكتمل رفع الصورة. حاول مرة أخرى.");
    throw error;
  }

  const [metadata] = await objectFile.getMetadata();
  const actualSize = Number(metadata.size);
  const contentType = metadata.contentType ?? "";
  if (
    !Number.isSafeInteger(actualSize) ||
    actualSize < 1 ||
    actualSize > MAX_LISTING_PHOTO_BYTES ||
    !extensions[contentType] ||
    !objectPath.endsWith(`.${extensions[contentType]}`)
  )
    throw fail(400, "الصورة غير صالحة أو يتجاوز حجمها 5 ميغابايت.");

  const [header] = await objectFile.download({ start: 0, end: 11 });
  if (!imageSignatureMatches(header, contentType))
    throw fail(400, "محتوى الملف لا يطابق نوع الصورة.");

  if (
    requireOwnerAccess &&
    !(await storage.canAccessObjectEntity({
      userId: ownerId,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    }))
  )
    throw fail(403, "يجب إكمال رفع الصورة قبل استخدامها.");

  return objectFile;
}

export type ReviewedListingPhoto = {
  objectPath: string;
  contentType: string;
  generation: string;
  sha256: string;
  bytes: Buffer;
};

async function readValidatedListingPhotoContent(
  storage: ObjectStorageService,
  objectPath: string,
  ownerId: string,
  requireOwnerAccess: boolean,
): Promise<ReviewedListingPhoto> {
  const objectFile = await validateListingPhoto(
    storage,
    objectPath,
    ownerId,
    requireOwnerAccess,
  );
  const [before] = await objectFile.getMetadata();
  const contentType = before.contentType ?? "";
  const size = Number(before.size);
  const generation = String(before.generation ?? "");
  if (!generation)
    throw fail(503, "تعذر التحقق من نسخة الصورة.");

  const [bytes] = await objectFile.download();
  const [after] = await objectFile.getMetadata();
  if (
    String(after.generation ?? "") !== generation ||
    bytes.length !== size ||
    !imageSignatureMatches(bytes, contentType)
  )
    throw fail(409, "تغيّرت الصورة أثناء التحقق؛ ارفعها مجددًا.");

  return {
    objectPath,
    contentType,
    generation,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

export async function loadListingPhotosForPolicyReview(
  objectPaths: readonly string[],
  ownerId: string,
): Promise<ReviewedListingPhoto[]> {
  if (objectPaths.length > MAX_LISTING_PHOTOS)
    throw fail(400, "يمكن إرفاق أربع صور كحد أقصى.");
  if (new Set(objectPaths).size !== objectPaths.length)
    throw fail(400, "تحتوي الصور على مسار مكرر.");

  const storage = new ObjectStorageService();
  const photos: ReviewedListingPhoto[] = [];
  for (const objectPath of objectPaths) {
    photos.push(
      await readValidatedListingPhotoContent(
        storage,
        objectPath,
        ownerId,
        true,
      ),
    );
  }
  return photos;
}

export async function createPrivateListingPhotoSnapshot(
  ownerId: string,
  contentType: string,
  bytes: Buffer,
  destinationPath?: string,
): Promise<string> {
  const extension = extensions[contentType];
  if (
    !extension ||
    bytes.length < 1 ||
    bytes.length > MAX_LISTING_PHOTO_BYTES ||
    !imageSignatureMatches(bytes, contentType)
  )
    throw fail(503, "تعذر حفظ نسخة آمنة من الصورة.");

  const objectPath =
    destinationPath ??
    `/objects/listing-photos/${ownerId}/sealed-${randomUUID()}.${extension}`;
  if (!isSealedListingPhotoPath(objectPath, ownerId))
    throw fail(503, "تعذر حفظ نسخة آمنة من الصورة.");
  const storage = new ObjectStorageService();
  const created = await storage.saveObjectEntityFromBuffer(
    objectPath,
    bytes,
    contentType,
  );
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  if (!created) {
    const existing = await readValidatedListingPhotoContent(
      storage,
      objectPath,
      ownerId,
      true,
    );
    if (existing.sha256 !== expectedHash)
      throw fail(409, "هذه الصورة رُفعت سابقًا بمحتوى مختلف؛ ارفعها مجددًا.");
    return objectPath;
  }
  await storage.trySetObjectEntityAclPolicy(objectPath, {
    owner: ownerId,
    visibility: "private",
  });

  const persisted = await readValidatedListingPhotoContent(
    storage,
    objectPath,
    ownerId,
    true,
  );
  if (persisted.sha256 !== expectedHash)
    throw fail(503, "تعذر حفظ نسخة آمنة من الصورة.");
  return objectPath;
}

export async function freezeReviewedListingPhotos(
  photos: readonly ReviewedListingPhoto[],
  ownerId: string,
): Promise<string[]> {
  const frozen: string[] = [];
  for (const photo of photos) {
    if (!isOwnedListingPhotoPath(photo.objectPath, ownerId))
      throw fail(403, "لا يمكن استخدام صورة تخص حسابًا آخر.");
    if (photo.sha256 !== createHash("sha256").update(photo.bytes).digest("hex"))
      throw fail(409, "تغيّرت الصورة بعد مراجعتها؛ أعد المحاولة.");
    frozen.push(
      isSealedListingPhotoPath(photo.objectPath, ownerId)
        ? photo.objectPath
        : await createPrivateListingPhotoSnapshot(
            ownerId,
            photo.contentType,
            photo.bytes,
          ),
    );
  }
  return frozen;
}

export function replaceListingPhotoReferences(
  data: Record<string, any>,
  objectPaths: readonly string[],
): Record<string, any> {
  const updated = { ...data };
  let index = 0;
  const nextPath = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return value;
    const path = objectPaths[index++];
    if (!path) throw fail(409, "تعذر تثبيت صور العرض؛ أعد المحاولة.");
    return path;
  };
  updated.imageUrl = nextPath(data.imageUrl);
  if (Array.isArray(data.imageUrls)) {
    updated.imageUrls = data.imageUrls.map(nextPath);
  }
  if (index !== objectPaths.length)
    throw fail(409, "تعذر تثبيت صور العرض؛ أعد المحاولة.");
  return updated;
}

export async function validateListingPhotoPathsForOwner(
  objectPaths: readonly string[],
  ownerId: string,
) {
  if (objectPaths.length > MAX_LISTING_PHOTOS)
    throw fail(400, "يمكن إرفاق أربع صور كحد أقصى.");
  if (new Set(objectPaths).size !== objectPaths.length)
    throw fail(400, "تحتوي الصور على مسار مكرر.");

  const storage = new ObjectStorageService();
  for (const objectPath of objectPaths)
    await validateListingPhoto(storage, objectPath, ownerId, true);
}

export async function makeListingPhotosPublic(
  objectPaths: readonly string[],
  ownerId: string,
) {
  const storage = new ObjectStorageService();
  for (const objectPath of objectPaths) {
    await validateListingPhoto(storage, objectPath, ownerId, true);
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: ownerId,
      visibility: "public",
    });
  }
}

export async function makeListingPhotosPrivate(
  objectPaths: readonly string[],
  ownerId: string,
) {
  const storage = new ObjectStorageService();
  for (const objectPath of objectPaths) {
    if (!isOwnedListingPhotoPath(objectPath, ownerId)) continue;
    try {
      await storage.getObjectEntityFile(objectPath);
      await storage.trySetObjectEntityAclPolicy(objectPath, {
        owner: ownerId,
        visibility: "private",
      });
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }
}

export async function isPublishedListingPhoto(objectPath: string) {
  const [reference] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.status, "PUBLISHED"),
        or(
          sql`${offers.data} ->> 'imageUrl' = ${objectPath}`,
          sql`${offers.data} -> 'imageUrls' @> ${JSON.stringify([objectPath])}::jsonb`,
        ),
      ),
    )
    .limit(1);
  return Boolean(reference);
}

export async function completeListingPhotoUpload(
  objectPath: string,
  ownerId: string,
) {
  if (!isOwnedListingPhotoPath(objectPath, ownerId))
    throw fail(403, "لا يمكن استخدام صورة تخص حسابًا آخر.");
  if (isSealedListingPhotoPath(objectPath, ownerId))
    throw fail(409, "هذه الصورة مثبتة ولا يمكن إعادة رفعها.");
  if (await isPublishedListingPhoto(objectPath))
    throw fail(409, "لا يمكن تغيير صورة مستخدمة في عرض منشور.");

  const storage = new ObjectStorageService();
  const source = await readValidatedListingPhotoContent(
    storage,
    objectPath,
    ownerId,
    false,
  );
  const prefix = `/objects/listing-photos/${ownerId}/`;
  const sourceFileName = objectPath.slice(prefix.length);
  await storage.trySetObjectEntityAclPolicy(objectPath, {
    owner: ownerId,
    visibility: "private",
  });
  const sealedPath = `${prefix}sealed-${sourceFileName}`;
  if (sourceFileName.startsWith("acceptance-A09-")) {
    try {
      await storage.getObjectEntityFile(sealedPath);
      throw fail(409, "تعارض مسار صورة A09؛ لم يُستبدل أي ملف.");
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }
  return createPrivateListingPhotoSnapshot(
    ownerId,
    source.contentType,
    source.bytes,
    sealedPath,
  );
}