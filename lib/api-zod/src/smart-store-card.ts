/**
 * Smart store cards — the shared contract between the server and the conversation UI.
 * See docs/design/SMART-STORE-CARDS-BRIEF.md (sections 2 and 5).
 *
 * The server builds every card from persisted store data. The browser renders sections in order,
 * never invents a value a section does not carry, and sends back only `CardEvent`s — no free text,
 * no prices. A card's final total is the server's `quote` with `final: true`.
 */
import { z } from "zod";

const text = (max: number) => z.string().min(1).max(max);
const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);

export const SmartMoney = z
  .object({ minor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/), scale: z.number().int().min(0).max(3), label: text(40) })
  .strict();
export const SmartMedia = z
  .object({
    url: z.string().max(1000).regex(/^(?:https:\/\/|\/)[^\s"'<>]+$/),
    alt: text(200),
    kind: z.enum(["IMAGE", "VIDEO", "MODEL_3D"]),
    illustrative: z.boolean().optional(),
  })
  .strict();

export const SMART_STORE_VERTICALS = ["FASHION", "FOOD", "FURNITURE", "OCCASION", "ACCESSORIES", "GIFTS", "ELECTRONICS", "VEHICLES", "GENERAL"] as const;

const option = z
  .object({ id, label: text(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), price: SmartMoney.optional(), delta: SmartMoney.optional(), available: z.boolean(), selected: z.boolean() })
  .strict();

export const SmartSection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("UNDERSTOOD_REQUEST"), chips: z.array(z.object({ id, label: text(60) }).strict()).max(8) }).strict(),
  z.object({ kind: z.literal("CATEGORY_TABS"), tabs: z.array(z.object({ id, label: text(40), selected: z.boolean() }).strict()).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("HERO_GALLERY"), media: z.array(SmartMedia).min(1).max(12) }).strict(),
  z
    .object({
      kind: z.literal("PRODUCT_GRID"),
      products: z
        .array(z.object({ id, title: text(120), price: SmartMoney, media: SmartMedia, available: z.boolean(), selected: z.boolean().optional(), swatches: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).optional() }).strict())
        .min(1)
        .max(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal("PRODUCT_DETAIL"),
      productId: id,
      title: text(160),
      subtitle: z.string().max(300).optional(),
      price: SmartMoney,
      // Present only when the store's own records hold reviews; never a placeholder.
      rating: z.object({ value: z.number().min(0).max(5), count: z.number().int().positive() }).strict().optional(),
      media: z.array(SmartMedia).max(12),
    })
    .strict(),
  z.object({ kind: z.literal("VARIANT_PICKER"), groupId: id, label: text(40), style: z.enum(["SWATCH", "CHIP", "SIZE", "STEPPER"]), options: z.array(option).min(1).max(24) }).strict(),
  z
    .object({
      kind: z.literal("CUSTOMIZER"),
      groupId: id,
      label: text(40),
      multi: z.boolean(),
      options: z.array(z.object({ id, label: text(60), media: SmartMedia.optional(), delta: SmartMoney.optional(), selected: z.boolean() }).strict()).min(1).max(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal("BUNDLE_BUILDER"),
      label: text(60),
      slots: z.array(z.object({ slotId: id, label: text(40), item: z.object({ id, title: text(120), price: SmartMoney, media: SmartMedia }).strict().optional() }).strict()).min(1).max(8),
      compatibility: z.object({ status: z.enum(["COMPATIBLE", "INCOMPATIBLE", "NOT_VERIFIED"]), note: z.string().max(200).optional() }).strict().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("SPECS"), rows: z.array(z.object({ label: text(40), value: text(80) }).strict()).min(1).max(16) }).strict(),
  z.object({ kind: z.literal("POLICIES"), items: z.array(z.object({ icon: z.enum(["DELIVERY", "WARRANTY", "RETURNS", "PAYMENT"]), label: text(80) }).strict()).min(1).max(6) }).strict(),
  z.object({ kind: z.literal("RECOMMENDATIONS"), label: text(60), items: z.array(z.object({ id, title: text(120), media: SmartMedia }).strict()).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("MEDIA_3D"), model: SmartMedia, arAvailable: z.boolean() }).strict(),
  z.object({ kind: z.literal("TRY_ON"), available: z.literal(false), reason: text(200) }).strict(),
]);

export const SmartStoreCard = z
  .object({
    cardId: id,
    revision: z.number().int().min(1),
    vertical: z.enum(SMART_STORE_VERTICALS),
    store: z
      .object({ name: text(120), logoUrl: SmartMedia.shape.url.optional(), sponsored: z.boolean(), verified: z.boolean(), mode: z.enum(["SELL_INSIDE_JASSIM", "BUY_ON_MERCHANT_WEBSITE", "MERCHANT_SYSTEM"]) })
      .strict(),
    source: z.object({ kind: z.literal("MERCHANT_SYSTEM"), checkedAt: z.string().datetime() }).strict().optional(),
    sections: z.array(SmartSection).max(16),
    primaryAction: z.object({ kind: z.enum(["ADD_TO_CART", "REVIEW_ORDER", "REQUEST_QUOTE", "BOOK_TEST_DRIVE", "OPEN_MERCHANT_SITE"]), label: text(40) }).strict(),
    quote: z
      .object({ total: SmartMoney, lines: z.array(z.object({ label: text(80), amount: SmartMoney }).strict()).max(24), final: z.boolean(), expiresAt: z.string().datetime().optional() })
      .strict()
      .optional(),
    status: z.enum(["READY", "LOADING", "STALE", "UNAVAILABLE", "ERROR"]),
    notice: z.string().max(300).optional(),
  })
  .strict();

const ref = { cardId: id, revision: z.number().int().min(1) };
export const CardEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SELECT_TAB"), ...ref, tabId: id }).strict(),
  z.object({ type: z.literal("SELECT_PRODUCT"), ...ref, productId: id }).strict(),
  z.object({ type: z.literal("SELECT_OPTION"), ...ref, groupId: id, optionId: id, selected: z.boolean() }).strict(),
  z.object({ type: z.literal("SET_QUANTITY"), ...ref, productId: id, quantity: z.number().int().min(0).max(99) }).strict(),
  z.object({ type: z.literal("FILL_SLOT"), ...ref, slotId: id, productId: id }).strict(),
  z.object({ type: z.literal("REFINE_REMOVE"), ...ref, chipId: id }).strict(),
  z.object({ type: z.literal("PRIMARY_ACTION"), ...ref }).strict(),
  z.object({ type: z.literal("FAVORITE"), cardId: id, productId: id, on: z.boolean() }).strict(),
  z.object({ type: z.literal("SHARE"), cardId: id, productId: id }).strict(),
]);

export type SmartMoney = z.infer<typeof SmartMoney>;
export type SmartMedia = z.infer<typeof SmartMedia>;
export type SmartSection = z.infer<typeof SmartSection>;
export type SmartStoreCard = z.infer<typeof SmartStoreCard>;
export type CardEvent = z.infer<typeof CardEvent>;
