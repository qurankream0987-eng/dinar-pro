/**
 * Connect-04 — Real-Time Signed Merchant Inventory & Price Webhook Verifier.
 * Uses constant-time HMAC-SHA256 verification and ±5-minute replay-attack protection.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

export const InventoryWebhookEventSchema = z.object({
  eventId: z.string().min(4).max(80),
  partnerId: z.string().min(2).max(80),
  type: z.enum(["INVENTORY_UPDATED", "PRICE_UPDATED", "ITEM_UNAVAILABLE"]),
  listingExternalId: z.string().min(1).max(120),
  availableQuantity: z.number().int().min(0).max(1_000_000).optional(),
  unitPriceMinor: z.number().int().min(0).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  occurredAt: z.string().min(10).max(40),
});
export type InventoryWebhookEvent = z.infer<typeof InventoryWebhookEventSchema>;

export function signInventoryWebhook(rawBody: string, timestampMs: number, secret: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`, "utf8").digest("hex");
}

export function verifyInventoryWebhook(input: {
  rawBody: string;
  signatureHex: string;
  timestampMs: number;
  secret: string;
  nowMs?: number;
}): { ok: true; event: InventoryWebhookEvent } | { ok: false; reason: "EXPIRED_TIMESTAMP" | "INVALID_SIGNATURE" | "INVALID_PAYLOAD" } {
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.timestampMs) || Math.abs(now - input.timestampMs) > WEBHOOK_MAX_SKEW_MS) {
    return { ok: false, reason: "EXPIRED_TIMESTAMP" };
  }
  const expected = signInventoryWebhook(input.rawBody, input.timestampMs, input.secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signatureHex.trim(), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  try {
    const parsed = InventoryWebhookEventSchema.parse(JSON.parse(input.rawBody));
    return { ok: true, event: parsed };
  } catch {
    return { ok: false, reason: "INVALID_PAYLOAD" };
  }
}
