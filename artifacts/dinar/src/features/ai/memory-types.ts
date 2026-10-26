import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";

/** Personal-memory surfaces; private-looking text never renders. */
export const MEMORY_SURFACES = CONVERSATION_SURFACE_FAMILIES.memory;
export type MemoryPayload = { view: typeof MEMORY_SURFACES[number]; groups: { label: string; items: { topic: string; label: string; reason: string }[] }[] };
const privateText = /\b(?:otp|password|api.?key|token|cookie|cvv|iban|diagnosis|diabetes|religion|political|depression)\b|sk-[\w-]+|dnr_[\w-]+|[\w-]{40,}|\d{7,}|[-+]?\d{1,3}\.\d{4,}|تشخيص|سكري|سرطان|اكتئاب|ديانة|انتماء سياسي|كلمة المرور|رمز التحقق|رقم البطاقة/iu;
const safe = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !privateText.test(v) && !/[{}\[\]]/.test(v);
export function normalizeMemory(value: unknown): MemoryPayload | null {
  if (!value || typeof value !== "object") return null;
  const m = value as MemoryPayload;
  if (!MEMORY_SURFACES.includes(m.view) || !Array.isArray(m.groups) || m.groups.length > 6) return null;
  if (m.groups.some(g => !g || !safe(g.label,80) || !Array.isArray(g.items) || g.items.length > 12 || g.items.some(i => !i || !safe(i.topic,80) || !safe(i.label,120) || !safe(i.reason,160)))) return null;
  return m;
}
