/**
 * Smart cards from a connected store's own system (Jassim Connect → smart store cards).
 *
 * The business owner maps one AUTHORIZED READ tool's answer to card products with JSON pointers
 * (which field is the title, the price, the image…) and may open that tool to customers
 * (`publicRead`). A customer's card is then read live through the Stage 2/3 law (binding VERIFIED,
 * capability granted, schema pinned) with the sealed key, never exposing it.
 *
 *   Provider data is untrusted: only mapped scalar fields are copied, bounded and validated;
 *   images must be https; prices are parsed exactly in the owner-declared currency; anything that
 *   does not parse is dropped (never guessed). The card is marked MERCHANT_SYSTEM with the time it
 *   was checked, and its total is an estimate the store confirms (`quote.final = false`).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { SmartStoreCard, SMART_STORE_VERTICALS, type SmartSection } from "@workspace/api-zod/smart-store-card";
import { businessProfiles, conversations, connectIntegrations, connectPartners, connectTools, db, smartStoreCards } from "@workspace/db";
import { ConnectNetwork } from "./network";
import { connectError } from "./provider-registry";
import { connectAccess, connectAudit, lockOwnedConnectIntegration, type ConnectMarket } from "./partners";
import { decideToolUse } from "./binding";
import { executeConnectOperation, validateArguments } from "./api-connector";
import { computeQuote, money } from "../lib/smart-store-cards";

const pointer = z.string().max(200).regex(/^(?:\/[^/~]*(?:~[01][^/~]*)*)*$/, "JSON pointer");
export const CardMapping = z
  .object({
    itemsPointer: pointer,
    id: pointer,
    title: pointer,
    price: pointer,
    currency: z.string().regex(/^[A-Z]{3}$/),
    image: pointer.optional(),
    available: pointer.optional(),
    vertical: z.enum(SMART_STORE_VERTICALS).default("GENERAL"),
  })
  .strict();
export type CardMapping = z.infer<typeof CardMapping>;

/** RFC 6901 pointer, bounded; returns undefined on any miss. */
export function readPointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current = value;
  for (const raw of path.slice(1).split("/").slice(0, 16)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^\d{1,4}$/.test(key)) current = current[Number(key)];
    else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, key)) current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

/** An exact decimal (string or finite number in major units) → minor units at `scale`; else undefined. */
export function exactMinor(raw: unknown, scale: number): number | undefined {
  const text = typeof raw === "number" && Number.isFinite(raw) ? raw.toFixed(scale) : typeof raw === "string" ? raw.trim() : undefined;
  if (!text || !/^\d{1,9}(?:\.\d{1,6})?$/.test(text)) return undefined;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return undefined; // more precision than the currency has
  return Number(whole) * 10 ** scale + Number((fraction + "0".repeat(scale)).slice(0, scale) || "0");
}

const cleanText = (raw: unknown, max: number) => (typeof raw === "string" || typeof raw === "number" ? String(raw).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/** Pure: provider answer + mapping → products (invalid items are dropped, never repaired). */
export function mapProducts(data: unknown, mapping: CardMapping, market: { currencyCode: string; minorUnitScale: number }) {
  const items = readPointer(data, mapping.itemsPointer);
  if (!Array.isArray(items)) return [];
  const products: Extract<SmartSection, { kind: "PRODUCT_GRID" }>["products"] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, 24)) {
    const id = cleanText(readPointer(item, mapping.id), 80);
    const title = cleanText(readPointer(item, mapping.title), 120);
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id) || !title || seen.has(id)) continue;
    const price = money(0, mapping.currency, market);
    const minor = exactMinor(readPointer(item, mapping.price), price.scale);
    if (minor === undefined) continue;
    const imageRaw = mapping.image ? readPointer(item, mapping.image) : undefined;
    const image = typeof imageRaw === "string" && /^https:\/\/[^\s"'<>]{1,990}$/.test(imageRaw) ? imageRaw : undefined;
    const availableRaw = mapping.available ? readPointer(item, mapping.available) : true;
    seen.add(id);
    products.push({
      id,
      title,
      price: money(minor, mapping.currency, market),
      media: image ? { url: image, alt: title, kind: "IMAGE" } : { url: "/smart-store/fixtures/generic.svg", alt: title, kind: "IMAGE", illustrative: true },
      available: availableRaw === true || (typeof availableRaw === "number" && availableRaw > 0),
    });
  }
  return products;
}

/** Owner: map a READ tool to cards and choose whether customers may read through it. */
export async function setConnectToolCard(actorId: string, market: ConnectMarket, integrationId: string, toolId: string, raw: unknown) {
  const body = z.object({ mapping: CardMapping, publicRead: z.boolean() }).strict().parse(raw);
  return db.transaction(async (tx) => {
    const { partnerId } = await lockOwnedConnectIntegration(tx, actorId, market, integrationId);
    const [tool] = await tx.select().from(connectTools).where(and(eq(connectTools.id, toolId), eq(connectTools.integrationId, integrationId))).for("update");
    if (!tool || tool.status !== "AUTHORIZED") throw connectError(409, "TOOL_NOT_AUTHORIZED", "اعتمد الأداة أولًا");
    if (tool.access !== "READ") throw connectError(409, "CARD_TOOL_MUST_READ", "البطاقات تُبنى من أداة قراءة فقط");
    await tx.update(connectTools).set({ cardMapping: body.mapping, publicRead: body.publicRead }).where(eq(connectTools.id, toolId));
    await connectAudit(tx, partnerId, actorId, "OWNER", "CONNECT_TOOL_CARD_SET", { integrationId, toolId, publicRead: body.publicRead, currency: body.mapping.currency });
    return { toolId, publicRead: body.publicRead };
  });
}

/**
 * A customer's (or the owner's) card from the store's system. Customers reach only tools the owner
 * opened (`publicRead`); every read is decided by the binding law at this moment.
 */
export async function issueCardFromConnector(input: { actorId: string; market: ConnectMarket; integrationId: string; toolId: string; arguments?: Record<string, unknown>; conversationId?: string; network?: ConnectNetwork }) {
  if (input.conversationId) {
    const [owned] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.ownerUserId, input.actorId), eq(conversations.marketId, input.market.id)));
    if (!owned) throw connectError(404, "NOT_FOUND", "المحادثة غير موجودة");
  }
  const [row] = await db
    .select({ integration: connectIntegrations, partner: connectPartners, business: businessProfiles })
    .from(connectIntegrations)
    .innerJoin(connectPartners, eq(connectPartners.id, connectIntegrations.partnerId))
    .innerJoin(businessProfiles, eq(businessProfiles.id, connectPartners.businessId))
    .where(eq(connectIntegrations.id, input.integrationId));
  if (!row || row.partner.marketId !== input.market.id) throw connectError(404, "NOT_FOUND", "المتجر غير موجود");
  const [tool] = await db.select().from(connectTools).where(and(eq(connectTools.id, input.toolId), eq(connectTools.integrationId, input.integrationId)));
  if (!tool?.cardMapping || !tool.operation) throw connectError(404, "NOT_FOUND", "المتجر غير موجود");
  const owner = row.business.ownerUserId === input.actorId;
  if (!owner && !tool.publicRead) throw connectError(404, "NOT_FOUND", "المتجر غير موجود");
  if (owner) await connectAccess(input.actorId, input.market.id, row.partner.id, "OWNER");
  const decision = decideToolUse({ binding: row.integration, tool, presentedSchemaSha256: tool.inputSchemaSha256, confirmed: false, live: false });
  if (!decision.allowed || decision.access !== "READ") throw connectError(409, "STORE_SYSTEM_UNAVAILABLE", "نظام المتجر غير متاح للقراءة الآن");
  const args = input.arguments ?? {};
  validateArguments((tool.operation as { inputSchema: Parameters<typeof validateArguments>[0] }).inputSchema, args);
  const executed = await executeConnectOperation(input.network ?? new ConnectNetwork(), row.integration, tool, args);
  const mapping = CardMapping.parse(tool.cardMapping);
  const products = mapProducts(executed.data, mapping, input.market);
  const card: SmartStoreCard = {
    cardId: randomUUID(),
    revision: 1,
    vertical: mapping.vertical,
    store: { name: row.business.displayName.slice(0, 120), kind: "BUSINESS", sponsored: false, verified: row.business.verificationStatus === "VERIFIED", mode: "MERCHANT_SYSTEM" },
    source: { kind: "MERCHANT_SYSTEM", checkedAt: new Date().toISOString() },
    sections: products.length ? [{ kind: "PRODUCT_GRID", products }] : [],
    primaryAction: { kind: "REQUEST_QUOTE", label: "اطلب من المتجر" },
    status: products.length ? "READY" : "UNAVAILABLE",
    ...(products.length ? {} : { notice: "لم يُرجع نظام المتجر منتجات قابلة للعرض الآن." }),
  };
  card.quote = computeQuote(card);
  const parsed = SmartStoreCard.parse(card);
  await db.insert(smartStoreCards).values({ id: parsed.cardId, ownerUserId: input.actorId, marketId: input.market.id, conversationId: input.conversationId ?? null, revision: 1, card: parsed });
  return parsed;
}
