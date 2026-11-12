import { randomUUID } from "node:crypto";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";

/**
 * Videos a signed-in user attaches to their own conversation. Same model as visual-search photos:
 * a private per-owner namespace, an exact content type and size, the container signature checked
 * against the declared type, a private ACL on completion and expiry. A chat video is never
 * published, never a listing photo, and is not sent to any model provider (video understanding is
 * not enabled); the conversation stores only the path.
 */
export const CHAT_VIDEO_PREFIX = "chat-video";
export const MAX_CHAT_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_VIDEOS = 1;
export const CHAT_VIDEO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CHAT_VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
const fileName = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:mp4|webm|mov)$/i;
const ownerIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export const isChatVideoPath = (objectPath: string) => objectPath.startsWith(`/objects/${CHAT_VIDEO_PREFIX}/`);

export function isOwnedChatVideoPath(objectPath: string, ownerId: string) {
  if (!ownerIdPattern.test(ownerId)) return false;
  const prefix = `/objects/${CHAT_VIDEO_PREFIX}/${ownerId}/`;
  return objectPath.startsWith(prefix) && fileName.test(objectPath.slice(prefix.length));
}

export function chatVideoObjectName(ownerId: string, contentType: string, size: number) {
  const extension = CHAT_VIDEO_EXTENSIONS[contentType];
  if (!extension || !Number.isSafeInteger(size) || size < 1 || size > MAX_CHAT_VIDEO_BYTES)
    throw fail(400, "اختر فيديو MP4 أو WebM أو MOV بحجم لا يتجاوز 25 ميغابايت.");
  return `${CHAT_VIDEO_PREFIX}/${ownerId}/${randomUUID()}.${extension}`;
}

/** ISO-BMFF (mp4/mov: «ftyp» at byte 4, with a brand) or Matroska/WebM (EBML header + «webm» doctype). */
export function videoSignatureMatches(head: Buffer, contentType: string) {
  if (contentType === "video/mp4" || contentType === "video/quicktime") {
    if (head.length < 12 || head.toString("ascii", 4, 8) !== "ftyp") return false;
    const brand = head.toString("ascii", 8, 12);
    return contentType === "video/quicktime" ? brand === "qt  " : /^(?:isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |mmp4|MSNV)$/.test(brand);
  }
  if (contentType === "video/webm")
    return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 && head.subarray(0, 64).includes(Buffer.from("webm"));
  return false;
}

/** Checks owner, prefix, declared size and type, the stored size and the container signature. */
export async function verifyChatVideo(
  objectPath: string,
  ownerId: string,
  options: { requireOwnerAccess: boolean } = { requireOwnerAccess: true },
  storage = new ObjectStorageService(),
) {
  if (!isOwnedChatVideoPath(objectPath, ownerId)) throw fail(403, "لا يمكن استخدام فيديو يخص حسابًا آخر.");
  let file;
  try {
    file = await storage.getObjectEntityFile(objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw fail(400, "لم يكتمل رفع الفيديو. حاول مرة أخرى.");
    throw error;
  }
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  const contentType = metadata.contentType ?? "";
  if (
    !Number.isSafeInteger(size) || size < 1 || size > MAX_CHAT_VIDEO_BYTES ||
    !CHAT_VIDEO_EXTENSIONS[contentType] || !objectPath.endsWith(`.${CHAT_VIDEO_EXTENSIONS[contentType]}`)
  )
    throw fail(400, "الفيديو غير صالح أو يتجاوز حجمه 25 ميغابايت.");
  if (
    options.requireOwnerAccess &&
    !(await storage.canAccessObjectEntity({ userId: ownerId, objectFile: file, requestedPermission: ObjectPermission.READ }))
  )
    throw fail(403, "يجب إكمال رفع الفيديو قبل استخدامه.");
  const [bytes] = await file.download();
  if (bytes.length !== size || !videoSignatureMatches(bytes.subarray(0, 64), contentType)) {
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    throw fail(400, "محتوى الملف لا يطابق نوع الفيديو.");
  }
  return { objectPath, contentType, size };
}

/** Completion pins the object private to its uploader. It is never made public. */
export async function completeChatVideoUpload(objectPath: string, ownerId: string, storage = new ObjectStorageService()) {
  await verifyChatVideo(objectPath, ownerId, { requireOwnerAccess: false }, storage);
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: ownerId, visibility: "private" });
  return objectPath;
}

/** Removes one account's chat videos (account closure). */
export async function deleteChatVideosForOwner(ownerId: string, storage = new ObjectStorageService()) {
  if (!ownerIdPattern.test(ownerId)) throw new Error("Chat-video cleanup requires a valid account ID.");
  const files = await storage.listObjectEntityFiles(`${CHAT_VIDEO_PREFIX}/${ownerId}/`);
  for (const file of files) await file.delete({ ignoreNotFound: true });
  return files.length;
}

/** Deletes chat videos older than the retention period. */
export async function expireChatVideos(now = new Date(), storage = new ObjectStorageService()) {
  const files = await storage.listObjectEntityFiles(`${CHAT_VIDEO_PREFIX}/`);
  let deleted = 0;
  for (const file of files) {
    const [metadata] = await file.getMetadata();
    const created = Date.parse(String(metadata.timeCreated ?? ""));
    if (Number.isFinite(created) && now.getTime() - created > CHAT_VIDEO_RETENTION_MS) {
      await file.delete({ ignoreNotFound: true });
      deleted++;
    }
  }
  return deleted;
}
