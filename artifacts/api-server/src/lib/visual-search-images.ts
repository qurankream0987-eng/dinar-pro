import { createHash, randomUUID } from "node:crypto";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";

/**
 * Buyers' visual-search photos. They live in their own namespace, are always private to the
 * uploader, are never published, and can never be used as a listing photo (and vice versa):
 * the path prefix is the type, and each validator accepts only its own prefix.
 */
export const VISUAL_SEARCH_PREFIX = "visual-search";
export const MAX_VISUAL_SEARCH_BYTES = 5 * 1024 * 1024;
export const MAX_VISUAL_SEARCH_IMAGES = 1;

export const VISUAL_SEARCH_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const fileName = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:jpg|png|webp)$/i;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export function isVisualSearchPath(objectPath: string) {
  return objectPath.startsWith(`/objects/${VISUAL_SEARCH_PREFIX}/`);
}

export function isOwnedVisualSearchPath(objectPath: string, ownerId: string) {
  const prefix = `/objects/${VISUAL_SEARCH_PREFIX}/${ownerId}/`;
  return objectPath.startsWith(prefix) && fileName.test(objectPath.slice(prefix.length));
}

function signatureMatches(bytes: Buffer, contentType: string) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/webp")
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export function visualSearchObjectName(ownerId: string, contentType: string, size: number) {
  const extension = VISUAL_SEARCH_EXTENSIONS[contentType];
  if (!extension || !Number.isSafeInteger(size) || size < 1 || size > MAX_VISUAL_SEARCH_BYTES)
    throw fail(400, "اختر صورة JPEG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت.");
  return `${VISUAL_SEARCH_PREFIX}/${ownerId}/${randomUUID()}.${extension}`;
}

export type VisualSearchImage = { objectPath: string; contentType: string; sha256: string; bytes: Buffer };

/**
 * Reads one buyer search photo after checking owner, prefix, size, type, magic bytes and,
 * once completed, the private owner ACL. A stranger's path is refused before storage is touched.
 */
export async function loadVisualSearchImage(
  objectPath: string,
  ownerId: string,
  options: { requireOwnerAccess: boolean } = { requireOwnerAccess: true },
  storage = new ObjectStorageService(),
): Promise<VisualSearchImage> {
  if (!isOwnedVisualSearchPath(objectPath, ownerId)) throw fail(403, "لا يمكن استخدام صورة تخص حسابًا آخر.");
  let file;
  try {
    file = await storage.getObjectEntityFile(objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw fail(400, "لم يكتمل رفع الصورة. حاول مرة أخرى.");
    throw error;
  }
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  const contentType = metadata.contentType ?? "";
  if (
    !Number.isSafeInteger(size) || size < 1 || size > MAX_VISUAL_SEARCH_BYTES ||
    !VISUAL_SEARCH_EXTENSIONS[contentType] || !objectPath.endsWith(`.${VISUAL_SEARCH_EXTENSIONS[contentType]}`)
  )
    throw fail(400, "الصورة غير صالحة أو يتجاوز حجمها 5 ميغابايت.");
  if (
    options.requireOwnerAccess &&
    !(await storage.canAccessObjectEntity({ userId: ownerId, objectFile: file, requestedPermission: ObjectPermission.READ }))
  )
    throw fail(403, "يجب إكمال رفع الصورة قبل استخدامها.");
  const [bytes] = await file.download();
  if (bytes.length !== size || !signatureMatches(bytes, contentType)) throw fail(400, "محتوى الملف لا يطابق نوع الصورة.");
  return { objectPath, contentType, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

/** Completion pins the object private to its uploader. It is never made public. */
export async function completeVisualSearchUpload(objectPath: string, ownerId: string, storage = new ObjectStorageService()) {
  await loadVisualSearchImage(objectPath, ownerId, { requireOwnerAccess: false }, storage);
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: ownerId, visibility: "private" });
  return objectPath;
}
