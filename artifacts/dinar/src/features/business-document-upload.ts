import { api } from "@/account/Account";

/** D2: one private verification document of the user's own business (server checks everything again). */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

export async function uploadBusinessDocument(businessId: string, kind: string, file: File): Promise<void> {
  if (!SUPPORTED_TYPES.has(file.type) || file.size < 1 || file.size > MAX_DOCUMENT_BYTES)
    throw new Error("اختر ملف PDF أو صورة JPEG أو PNG بحجم لا يتجاوز 10 ميغابايت.");
  const ticket = await api(`/business/profiles/${encodeURIComponent(businessId)}/documents/upload-url`, "POST", {
    kind,
    contentType: file.type,
    size: file.size,
    idempotencyKey: `doc-${crypto.randomUUID()}`,
  });
  if (typeof ticket?.uploadURL !== "string" || typeof ticket?.documentId !== "string") throw new Error("تعذر تجهيز رفع المستند.");
  let response: Response;
  try {
    response = await fetch(ticket.uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file, credentials: "omit" });
  } catch {
    throw new Error("تعذر رفع المستند. تحقق من الاتصال وحاول مرة أخرى.");
  }
  if (!response.ok) throw new Error("تعذر رفع المستند. حاول مرة أخرى.");
  await api(`/business/profiles/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(ticket.documentId)}/complete`, "POST", {});
}

export async function updateBusinessInfo(businessId: string, revision: number, info: { legalName?: string; registrationNumber?: string; city?: string }) {
  await api(`/business/profiles/${encodeURIComponent(businessId)}`, "PATCH", {
    expectedRevision: revision,
    ...(info.legalName ? { legalName: info.legalName } : {}),
    ...(info.registrationNumber ? { registrationNumber: info.registrationNumber } : {}),
    ...(info.city ? { address: { city: info.city } } : {}),
  });
}

export async function setBusinessPublication(businessId: string, publish: boolean) {
  await api(`/business/profiles/${encodeURIComponent(businessId)}/publication`, "POST", { publish });
}
