/**
 * Store payment link inside the conversation (Jassim Connect Universal).
 *
 * Owner decision 2026-11-27: a connected store takes the payment in its OWN system. Jassim only shows
 * the store's checkout link, after the person confirmed the store write (e.g. create order) and the
 * store's system answered. Jassim never holds, records or confirms the money.
 *
 *   - The business owner maps where their AUTHORIZED WRITE tool returns the checkout URL (JSON pointers),
 *     optionally the store's order reference, amount, currency and expiry.
 *   - The URL is accepted only if it is https, has no credentials, and its host is the store's own:
 *     the connector endpoint host, a VERIFIED Connect site of the same partner (or its subdomain), or a
 *     payment host the owner declared explicitly. Anything else is refused, never "repaired".
 *   - The amount is shown only when the store's currency is the market currency and parses exactly;
 *     it is the store's figure (`source: "STORE"`), not a Jassim total.
 *   - The extracted link is stored with the confirmation so the person sees it again after a reload.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectActionConfirmations, connectIntegrations, connectSites, connectTools, db } from "@workspace/db";
import { connectError } from "./provider-registry";
import { connectAudit, lockOwnedConnectIntegration, type ConnectMarket } from "./partners";
import { exactMinor, readPointer } from "./tool-cards";

const pointer = z.string().max(200).regex(/^(?:\/[^/~]*(?:~[01][^/~]*)*)*$/, "JSON pointer");
const hostname = z
  .string()
  .min(3)
  .max(253)
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(value), "hostname");

export const PaymentLinkMapping = z
  .object({
    url: pointer.min(1),
    orderReference: pointer.min(1).optional(),
    amount: pointer.min(1).optional(),
    currency: pointer.min(1).optional(),
    expiresAt: pointer.min(1).optional(),
    paymentHosts: z.array(hostname).max(5).default([]),
  })
  .strict();
export type PaymentLinkMapping = z.infer<typeof PaymentLinkMapping>;

const PAYMENT_CAPABILITIES = new Set(["CREATE", "BOOK", "PAY", "SCHEDULE"]);

export type StorePaymentLink =
  | {
      status: "AVAILABLE";
      source: "STORE";
      url: string;
      host: string;
      orderReference?: string;
      amountMinor?: number;
      currencyCode?: string;
      expiresAt?: string;
      issuedAt: string;
    }
  | { status: "UNAVAILABLE"; source: "STORE"; reason: "MISSING_URL" | "INVALID_URL" | "HOST_NOT_ALLOWED" | "EXPIRED"; issuedAt: string };

const clean = (raw: unknown, max: number) =>
  typeof raw === "string" || typeof raw === "number" ? String(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

/** True when `host` equals an allowed host or is a subdomain of an allowed site host. */
export function hostAllowed(host: string, exact: readonly string[], sites: readonly string[]) {
  const h = host.toLowerCase();
  if (exact.includes(h)) return true;
  return sites.some((site) => h === site || h.endsWith(`.${site}`));
}

/** Pure: the store's answer + mapping → a payment link, or an honest reason why there is none. */
export function extractStorePaymentLink(
  data: unknown,
  mapping: PaymentLinkMapping,
  allowed: { endpointHost: string; verifiedSites: readonly string[] },
  market: { currencyCode: string; minorUnitScale: number },
  now = new Date(),
): StorePaymentLink {
  const issuedAt = now.toISOString();
  const raw = clean(readPointer(data, mapping.url), 2048);
  if (!raw) return { status: "UNAVAILABLE", source: "STORE", reason: "MISSING_URL", issuedAt };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: "UNAVAILABLE", source: "STORE", reason: "INVALID_URL", issuedAt };
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.port && url.port !== "443")
    return { status: "UNAVAILABLE", source: "STORE", reason: "INVALID_URL", issuedAt };
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host, [allowed.endpointHost.toLowerCase(), ...mapping.paymentHosts], allowed.verifiedSites.map((s) => s.toLowerCase())))
    return { status: "UNAVAILABLE", source: "STORE", reason: "HOST_NOT_ALLOWED", issuedAt };
  let expiresAt: string | undefined;
  if (mapping.expiresAt) {
    const parsed = new Date(clean(readPointer(data, mapping.expiresAt), 40));
    if (!Number.isNaN(parsed.getTime())) {
      if (parsed.getTime() <= now.getTime()) return { status: "UNAVAILABLE", source: "STORE", reason: "EXPIRED", issuedAt };
      expiresAt = parsed.toISOString();
    }
  }
  const orderReference = mapping.orderReference ? clean(readPointer(data, mapping.orderReference), 120) || undefined : undefined;
  const currency = mapping.currency ? clean(readPointer(data, mapping.currency), 3).toUpperCase() : "";
  const amountMinor =
    mapping.amount && currency === market.currencyCode ? exactMinor(readPointer(data, mapping.amount), market.minorUnitScale) : undefined;
  return {
    status: "AVAILABLE",
    source: "STORE",
    url: url.href,
    host,
    ...(orderReference ? { orderReference } : {}),
    ...(amountMinor !== undefined ? { amountMinor, currencyCode: market.currencyCode } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    issuedAt,
  };
}

/** OWNER only: map an authorized WRITE tool's answer to the store's checkout link. `null` removes it. */
export async function setConnectToolPaymentLink(actorId: string, market: ConnectMarket, integrationId: string, toolId: string, raw: unknown) {
  const body = z.object({ mapping: PaymentLinkMapping.nullable() }).strict().parse(raw);
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [tool] = await tx
      .select()
      .from(connectTools)
      .where(and(eq(connectTools.id, toolId), eq(connectTools.integrationId, integrationId)))
      .for("update");
    if (!tool || tool.status !== "AUTHORIZED") throw connectError(409, "TOOL_NOT_AUTHORIZED", "اعتمد الأداة أولًا");
    if (tool.access !== "WRITE") throw connectError(409, "PAYMENT_LINK_TOOL_MUST_WRITE", "رابط الدفع يأتي من أداة كتابة (إنشاء طلب أو حجز أو دفع)");
    if (!PAYMENT_CAPABILITIES.has(tool.capability))
      throw connectError(409, "PAYMENT_LINK_CAPABILITY", "رابط الدفع متاح لأدوات إنشاء الطلب أو الحجز أو الموعد أو الدفع فقط");
    await tx.update(connectTools).set({ paymentLinkMapping: body.mapping }).where(eq(connectTools.id, toolId));
    await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_TOOL_PAYMENT_LINK_SET", {
      integrationId,
      toolId,
      enabled: body.mapping !== null,
      paymentHosts: body.mapping?.paymentHosts ?? [],
    });
    return { toolId, paymentLink: body.mapping ? "MAPPED" : "REMOVED" };
  });
}

/** After a confirmed write executed: extract and keep the store's payment link (if the tool maps one). */
export async function paymentLinkAfterWrite(input: {
  confirmationId: string;
  integration: typeof connectIntegrations.$inferSelect;
  tool: typeof connectTools.$inferSelect;
  data: unknown;
  market: ConnectMarket;
}): Promise<StorePaymentLink | undefined> {
  if (!input.tool.paymentLinkMapping || !input.integration.endpointUrl) return undefined;
  const mapping = PaymentLinkMapping.safeParse(input.tool.paymentLinkMapping);
  if (!mapping.success) return undefined;
  const sites = await db
    .select({ hostname: connectSites.hostname })
    .from(connectSites)
    .where(and(eq(connectSites.partnerId, input.integration.partnerId), eq(connectSites.status, "VERIFIED")));
  const link = extractStorePaymentLink(
    input.data,
    mapping.data,
    { endpointHost: new URL(input.integration.endpointUrl).hostname, verifiedSites: sites.map((s) => s.hostname) },
    input.market,
  );
  await db.update(connectActionConfirmations).set({ paymentLink: link }).where(eq(connectActionConfirmations.id, input.confirmationId));
  return link;
}

/** The person's own confirmation, to show its outcome and payment link again (strangers: 404). */
export async function readOwnConfirmation(actorId: string, confirmationId: string) {
  const [row] = await db
    .select({
      id: connectActionConfirmations.id,
      actorId: connectActionConfirmations.actorId,
      status: connectActionConfirmations.status,
      resultStatus: connectActionConfirmations.resultStatus,
      paymentLink: connectActionConfirmations.paymentLink,
      expiresAt: connectActionConfirmations.expiresAt,
    })
    .from(connectActionConfirmations)
    .where(eq(connectActionConfirmations.id, confirmationId));
  if (!row || row.actorId !== actorId) throw connectError(404, "NOT_FOUND", "التأكيد غير موجود");
  const { actorId: _owner, ...rest } = row;
  return rest;
}
