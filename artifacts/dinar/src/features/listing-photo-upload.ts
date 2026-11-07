import { api } from "@/account/Account";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function uploadListingPhoto(file: File): Promise<string> {
  return uploadPhoto(file, "listing-photos");
}

/** A buyer's photo for product search: private to the buyer, never a listing photo. */
export function uploadVisualSearchPhoto(file: File): Promise<string> {
  return uploadPhoto(file, "visual-search");
}

async function uploadPhoto(file: File, kind: "listing-photos" | "visual-search"): Promise<string> {
  if (!SUPPORTED_TYPES.has(file.type) || file.size < 1 || file.size > MAX_PHOTO_BYTES)
    throw new Error("اختر صورة JPEG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت.");

  const ticket = await api(`/account/${kind}/upload-url`, "POST", {
    size: file.size,
    contentType: file.type,
  });
  if (
    typeof ticket?.uploadURL !== "string" ||
    typeof ticket?.objectPath !== "string"
  )
    throw new Error("تعذر تجهيز رفع الصورة.");

  let response: Response;
  try {
    response = await fetch(ticket.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
      credentials: "omit",
    });
  } catch {
    throw new Error("تعذر رفع الصورة. تحقق من الاتصال وحاول مرة أخرى.");
  }
  if (!response.ok)
    throw new Error("تعذر رفع الصورة. حاول مرة أخرى.");

  const completed = await api(`/account/${kind}/complete`, "POST", {
    objectPath: ticket.objectPath,
  });
  if (
    typeof completed?.objectPath !== "string" ||
    !completed.objectPath.startsWith(`/objects/${kind}/`)
  )
    throw new Error("تعذر التحقق من الصورة المرفوعة.");
  return completed.objectPath;
}