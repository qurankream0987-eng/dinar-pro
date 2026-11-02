/**
 * AI-FOUNDATION-02 — the canonical capabilities exposed to the bounded model loop.
 *
 * Every tool here delegates to the same service the typed flow uses. Reads are party-scoped by
 * that service; prepares create an ordinary pending action (aiResultSets kind ACTION) and return
 * the server-built review surface. The model never confirms, never mutates, and never supplies
 * the actor id, price snapshot or authorization: those are read again on the server.
 */
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db, offers, orders } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import { d2BusinessIdentity } from "../lib/d2-business-identity";
import { getDeliveryView } from "../lib/delivery";
import { listInquiries } from "../lib/inquiries";
import { parseListingPriceMinor } from "../lib/listing-management";
import { categorySchema, listMarketplaceCategories } from "../lib/marketplace-categories";
import { getMarketplaceCart } from "../lib/marketplace-cart";
import { checkoutIssueMessage, planCheckout } from "../lib/commerce";
import { negotiationForParty } from "../lib/negotiations";
import {
  createPendingAction,
  proposeAction,
  readListingForBuyer,
} from "./action-foundation";
import { purchaseReviewTurn } from "./buyer-turn";
import { readDraftSnapshot } from "./draft-actions";
import { reviewTurn as inquiryReviewTurn } from "./inquiry-turn";
import { ConversationDraft, buildDraftReview, listingDraft } from "./listing-draft";
import type { ModelToolDefinition } from "./model-gateway";
import { reviewTurn as negotiationReviewTurn } from "./negotiation-turn";
import type { ToolContext, ToolResult } from "./tool-registry";

type Market = Awaited<ReturnType<typeof marketFor>>;

export type ModelCapabilityRole = "BUYER" | "SELLER";

export class ModelCapabilityRejected extends Error {
  constructor(
    message: string,
    readonly code: "TOOL_NOT_ALLOWED" | "TARGET_UNAVAILABLE" | "ACTION_UNAVAILABLE" | "INVALID_ARGUMENTS" = "ACTION_UNAVAILABLE",
  ) {
    super(message);
    this.name = "ModelCapabilityRejected";
  }
}

const SELLER_TOOLS = new Set([
  "readInventory",
  "prepareInquiryMessage",
  "prepareListingDraft",
  "requestPublicationReview",
  "readNegotiationStatus",
  "prepareNegotiationProposal",
]);

const BUYER_TOOLS = new Set([
  "readBusinessInquiries",
  "readCart",
  "prepareCartChange",
  "reviewCheckout",
  "readOrders",
  "readFulfillment",
  "prepareInquiryMessage",
  "readNegotiationStatus",
  "prepareNegotiationProposal",
]);

/** The twelve capabilities added in F02, next to the three F01 reads. */
export const MODEL_CAPABILITY_TOOL_NAMES = [
  "readInventory",
  "readBusinessInquiries",
  "prepareInquiryMessage",
  "prepareListingDraft",
  "requestPublicationReview",
  "readNegotiationStatus",
  "prepareNegotiationProposal",
  "readCart",
  "prepareCartChange",
  "reviewCheckout",
  "readOrders",
  "readFulfillment",
] as const;

export type ModelCapabilityToolName = (typeof MODEL_CAPABILITY_TOOL_NAMES)[number];

export function isModelCapabilityTool(name: string): name is ModelCapabilityToolName {
  return (MODEL_CAPABILITY_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * A seller is an actor who owns at least one offer in the active market, or who owns a D2
 * business there. Both are server rows; nothing is taken from the conversation message.
 */
export async function modelRolesForActor(actorId: string, marketId: string): Promise<ModelCapabilityRole[]> {
  const [owned] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.sellerId, actorId), eq(offers.marketId, marketId)))
    .limit(1);
  let seller = Boolean(owned);
  if (!seller) {
    const identity = await d2BusinessIdentity.forActor(actorId, marketId);
    seller = Boolean(identity && identity.role === "OWNER");
  }
  return seller ? ["BUYER", "SELLER"] : ["BUYER"];
}

export function modelCapabilityToolNamesForRoles(roles: readonly ModelCapabilityRole[]): string[] {
  return MODEL_CAPABILITY_TOOL_NAMES.filter((name) =>
    (SELLER_TOOLS.has(name) ? roles.includes("SELLER") : true) &&
    (BUYER_TOOLS.has(name) ? roles.includes("BUYER") : true),
  );
}

const definition = (name: string, description: string, parameters: ModelToolDefinition["parameters"]): ModelToolDefinition => ({
  name,
  description,
  parameters,
});

const noArguments = (): ModelToolDefinition["parameters"] => ({ type: "object", properties: {}, required: [], additionalProperties: false });

export function modelCapabilityToolDefinitions(roles: readonly ModelCapabilityRole[] = ["BUYER", "SELLER"]): ModelToolDefinition[] {
  const allowed = new Set(modelCapabilityToolNamesForRoles(roles));
  return [
    definition(
      "readInventory",
      "Read the signed-in seller's own offers in the active market (title, status, price, available quantity). Never returns another seller's inventory.",
      noArguments(),
    ),
    definition(
      "readBusinessInquiries",
      "Read the inquiry threads this actor is a party to in the active market, newest and awaiting-reply first. Never returns another party's threads.",
      {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
        required: [],
        additionalProperties: false,
      },
    ),
    definition(
      "prepareInquiryMessage",
      "Prepare one inquiry message for review. A buyer asks about a listing; a seller replies inside an existing inquiry. Nothing is sent until the actor confirms the review.",
      {
        type: "object",
        properties: {
          target: { type: "string", pattern: "^(listing|inquiry):.+$" },
          body: { type: "string", minLength: 1, maxLength: 1000 },
        },
        required: ["target", "body"],
        additionalProperties: false,
      },
    ),
    definition(
      "prepareListingDraft",
      "Start or refine the seller's own listing draft in this conversation. Nothing is published; the draft stays a draft until the seller requests a publication review.",
      {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", maxLength: 2000 },
          category: { type: "string", maxLength: 80 },
          price: { type: "number", minimum: 0 },
          quantity: { type: "integer", minimum: 1, maximum: 999999 },
        },
        required: ["title"],
        additionalProperties: false,
      },
    ),
    definition(
      "requestPublicationReview",
      "Open a publication review for a complete draft owned by this seller. Nothing is published until the seller confirms; an incomplete draft is refused.",
      {
        type: "object",
        properties: { draftId: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["draftId"],
        additionalProperties: false,
      },
    ),
    definition(
      "readNegotiationStatus",
      "Read one negotiation the actor is a party to: role, status, amounts on the table and quantity. Never returns a negotiation of another party.",
      {
        type: "object",
        properties: { negotiationId: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["negotiationId"],
        additionalProperties: false,
      },
    ),
    definition(
      "prepareNegotiationProposal",
      "Prepare a price proposal for review. With negotiationId this is a counter on that negotiation; with listingId it is a buyer offer. Nothing is sent until the actor confirms.",
      {
        type: "object",
        properties: {
          negotiationId: { type: "string", minLength: 1, maxLength: 200 },
          listingId: { type: "string", minLength: 1, maxLength: 200 },
          amount: { type: "number", exclusiveMinimum: 0 },
          quantity: { type: "integer", minimum: 1, maximum: 999 },
        },
        required: ["amount"],
        additionalProperties: false,
      },
    ),
    definition(
      "readCart",
      "Read the signed-in buyer's current cart in the active market, with live prices and availability. Never returns another buyer's cart.",
      noArguments(),
    ),
    definition(
      "prepareCartChange",
      "Prepare adding one listing to the buyer's cart for review. Nothing is added until the buyer confirms the purchase review; price and stock are re-validated then.",
      {
        type: "object",
        properties: {
          listingId: { type: "string", minLength: 1, maxLength: 200 },
          quantity: { type: "integer", minimum: 1, maximum: 999 },
        },
        required: ["listingId"],
        additionalProperties: false,
      },
    ),
    definition(
      "reviewCheckout",
      "Review the buyer's cart exactly as checkout sees it: live lines, quantities, prices and total. Read-only; placing an order stays a separate confirmed flow.",
      noArguments(),
    ),
    definition(
      "readOrders",
      "Read orders in the active market where the actor is the buyer or the seller, newest first. Never returns orders of another party.",
      {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
        required: [],
        additionalProperties: false,
      },
    ),
    definition(
      "readFulfillment",
      "Read the delivery/fulfilment status of one order the actor is a party to. Never returns another party's order.",
      {
        type: "object",
        properties: { orderId: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["orderId"],
        additionalProperties: false,
      },
    ),
  ].filter((tool) => allowed.has(tool.name));
}

const ReadLimit = z.object({ limit: z.number().int().min(1).max(20).optional() }).strict();
const InquiryArgs = z.object({ target: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(1000) }).strict();
const DraftArgs = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    category: z.string().trim().max(80).optional(),
    price: z.number().nonnegative().optional(),
    quantity: z.number().int().min(1).max(999999).optional(),
  })
  .strict();
const PublishArgs = z.object({ draftId: z.string().trim().min(1).max(200) }).strict();
const NegotiationReadArgs = z.object({ negotiationId: z.string().trim().min(1).max(200) }).strict();
const ProposalArgs = z
  .object({
    negotiationId: z.string().trim().min(1).max(200).optional(),
    listingId: z.string().trim().min(1).max(200).optional(),
    amount: z.number().positive(),
    quantity: z.number().int().min(1).max(999).optional(),
  })
  .strict();
const CartChangeArgs = z
  .object({
    listingId: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(1).max(999).optional(),
  })
  .strict();
const OrderArgs = z.object({ orderId: z.string().trim().min(1).max(200) }).strict();

const money = (minor: number, market: Market) =>
  (minor / 10 ** market.minorUnitScale).toFixed(market.minorUnitScale);

const surface = (name: string, prompt: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  kind: "SURFACE",
  surface: name,
  query: {},
  listings: [],
  prompt,
  ...extra,
});

async function offerTitle(listingId: string, marketId: string) {
  const [row] = await db
    .select({ data: offers.data, unitPriceMinor: offers.unitPriceMinor })
    .from(offers)
    .where(and(eq(offers.id, listingId), eq(offers.marketId, marketId)));
  return row ? String((row.data as { title?: unknown })?.title ?? "") : "";
}

async function readInventory(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن قراءة المخزون دون حساب.", "TOOL_NOT_ALLOWED");
  const rows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.sellerId, context.actorId), eq(offers.marketId, context.market.id)))
    .orderBy(desc(offers.createdAt))
    .limit(12);
  const inventory = rows.map((row) => ({
    listingId: row.id,
    title: String((row.data as { title?: unknown })?.title ?? ""),
    status: row.status,
    pricingMode: row.pricingMode,
    unitPrice: row.unitPriceMinor === null ? null : money(row.unitPriceMinor, context.market),
    currency: context.market.currencyCode,
    inventoryMode: row.inventoryMode,
    availableQuantity:
      row.inventoryMode === "UNLIMITED" ? null : Math.max(0, (row.availableQuantity ?? 0) - row.reservedQuantity),
  }));
  return surface(
    "SELLER_INVENTORY",
    inventory.length
      ? `هذا مخزونك الحالي في سوقك: ${inventory.length} عرضًا. الأرقام من سجل DINAR.`
      : "لا توجد عروض لك في هذا السوق بعد.",
    { inventory },
  );
}

async function readBusinessInquiries(input: { limit?: number }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن قراءة الاستفسارات دون حساب.", "TOOL_NOT_ALLOWED");
  const rows = await listInquiries(context.actorId, context.market, input.limit ?? 10);
  const inquiries = rows.map((row) => ({
    inquiryId: row.id,
    listingId: row.listingId,
    role: row.sellerId === context.actorId ? "SELLER" : "BUYER",
    status: row.status,
    lastMessageAt: row.lastMessageAt.toISOString(),
    counterpartLabel: row.sellerId === context.actorId ? "المشتري" : "البائع",
  }));
  return surface(
    "INQUIRY_LIST",
    inquiries.length
      ? `هذه ${inquiries.length} محادثة استفسار أنت طرف فيها في سوقك الحالي.`
      : "لا توجد محادثات استفسار أنت طرف فيها في هذا السوق.",
    { inquiries },
  );
}

async function readOrders(input: { limit?: number }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن قراءة الطلبات دون حساب.", "TOOL_NOT_ALLOWED");
  const rows = await db
    .select()
    .from(orders)
    .where(and(
      eq(orders.marketId, context.market.id),
      or(eq(orders.buyerId, context.actorId), eq(orders.sellerId, context.actorId)),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(input.limit ?? 10);
  const scale = rows[0]?.minorUnitScale ?? context.market.minorUnitScale;
  const view = rows.map((row) => ({
    orderId: row.id,
    role: row.buyerId === context.actorId ? "BUYER" : "SELLER",
    status: row.status,
    quantity: row.quantity,
    subtotal: (row.subtotalMinor / 10 ** scale).toFixed(scale),
    currency: row.currencyCode,
    createdAt: row.createdAt.toISOString(),
  }));
  return surface(
    "ORDERS_LIST",
    view.length ? `هذه ${view.length} من طلباتك في سوقك الحالي.` : "لا توجد طلبات لك في هذا السوق.",
    { orders: view },
  );
}

async function readFulfillment(input: { orderId: string }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن قراءة حالة التسليم دون حساب.", "TOOL_NOT_ALLOWED");
  let view: Awaited<ReturnType<typeof getDeliveryView>>;
  try {
    view = await getDeliveryView({ actorId: context.actorId, orderId: input.orderId, market: context.market });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500)
      throw new ModelCapabilityRejected("هذا الطلب ليس لك أو لم يعد موجودًا.", "TARGET_UNAVAILABLE");
    throw error;
  }
  return surface("ORDER_TRACKING", "هذه حالة التسليم الحالية لهذا الطلب من سجل DINAR.", {
    fulfillment: view as unknown as Record<string, unknown>,
  });
}

async function readCart(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن قراءة السلة دون حساب.", "TOOL_NOT_ALLOWED");
  const lines = await getMarketplaceCart(context.actorId, context.market);
  const cart = lines.map((line) => ({
    listingId: line.listingId,
    title: line.title,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    currency: context.market.currencyCode,
    availableQuantity: line.availableQuantity,
    ...("agreedPrice" in line && line.agreedPrice ? { agreedPrice: true } : {}),
  }));
  return surface("CART", cart.length ? `سلتك تحتوي ${cart.length} سطرًا من سجل DINAR.` : "سلتك فارغة.", { cart });
}

async function reviewCheckout(context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن مراجعة الدفع دون حساب.", "TOOL_NOT_ALLOWED");
  const lines = await getMarketplaceCart(context.actorId, context.market);
  if (!lines.length) throw new ModelCapabilityRejected("سلتك فارغة؛ لا يوجد ما يُراجع للدفع.", "ACTION_UNAVAILABLE");
  const cart = lines.map((line) => ({
    listingId: line.listingId,
    title: line.title,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    currency: context.market.currencyCode,
    availableQuantity: line.availableQuantity,
  }));
  // The same planner checkout uses; an agreed price is applied for this buyer only.
  const plan = planCheckout(
    lines.map((line) => ({ listingId: line.listingId, quantity: line.quantity, fulfilmentType: line.fulfilmentType })),
    lines.map((line) =>
      "agreedPrice" in line && line.agreedPrice
        ? { ...line, pricingMode: "FIXED" as const }
        : line,
    ),
  );
  if (!plan.ok)
    throw new ModelCapabilityRejected(
      `${checkoutIssueMessage(plan.issues)} لم يُنشأ طلب ولم يُدفع شيء.`,
      "ACTION_UNAVAILABLE",
    );
  const checkout = {
    lines: cart.length,
    total: money(plan.plan.totalMinor, context.market),
    currency: plan.plan.currencyCode,
    readOnly: true,
    note: "هذه مراجعة قراءة فقط لما سيدفعه الطلب؛ إنشاء الطلب يبقى خيارًا منفصلًا يؤكده المشتري.",
  };
  return surface(
    "CHECKOUT",
    `راجع سلتك: ${checkout.lines} سطرًا بإجمالي ${checkout.total} ${checkout.currency}. لم يُنشأ طلب ولم يُدفع شيء.`,
    { cart, checkout },
  );
}

async function prepareCartChange(input: { listingId: string; quantity?: number }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن إضافة عرض دون حساب.", "TOOL_NOT_ALLOWED");
  const quantity = input.quantity ?? 1;
  const snapshot = await readListingForBuyer(context.actorId, input.listingId);
  if (!snapshot) throw new ModelCapabilityRejected("العرض لم يعد موجودًا في سوقك الحالي.", "TARGET_UNAVAILABLE");
  if (snapshot.unitPriceMinor === null && snapshot.agreedQuantity === undefined)
    throw new ModelCapabilityRejected("هذا العرض يقبل العروض وليس له سعر معلن؛ اتفق على السعر أولًا.", "ACTION_UNAVAILABLE");
  if (!snapshot.directPurchase && snapshot.agreedQuantity === undefined)
    throw new ModelCapabilityRejected("هذا العرض يحتاج اتفاقًا على السعر قبل إضافته للسلة.", "ACTION_UNAVAILABLE");
  if (snapshot.available !== null && quantity > snapshot.available)
    throw new ModelCapabilityRejected(`المتوفر الآن ${snapshot.available} فقط.`, "ACTION_UNAVAILABLE");
  const review = await createPendingAction({
    conversationId: context.conversationId,
    actorId: context.actorId,
    market: context.market,
    proposal: proposeAction({
      action: "ADD_TO_CART",
      targetResource: input.listingId,
      facts: {
        quantity: [{ value: quantity, source: input.quantity ? "USER_DECLARED" : "DINAR_DERIVED" }],
      },
    }),
  });
  const turn = await purchaseReviewTurn(context.market, context.actorId, input.listingId, quantity, review);
  return {
    ...turn.result,
    preparedAction: { actionId: review.actionId, action: "ADD_TO_CART", targetResource: input.listingId },
  };
}

async function prepareInquiryMessage(input: { target: string; body: string }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن إعداد رسالة دون حساب.", "TOOL_NOT_ALLOWED");
  if (!/^(?:listing|inquiry):.+/u.test(input.target))
    throw new ModelCapabilityRejected("وجهة الاستفسار غير صالحة.", "INVALID_ARGUMENTS");
  const review = await createPendingAction({
    conversationId: context.conversationId,
    actorId: context.actorId,
    market: context.market,
    proposal: proposeAction({
      action: "SEND_INQUIRY_MESSAGE",
      targetResource: input.target,
      facts: {
        body: [{ value: input.body, source: "DINAR_DERIVED" }],
        provenance: [{ value: "DINAR_DRAFT_APPROVED", source: "SERVER_FACT" }],
      },
    }),
  });
  const turn = inquiryReviewTurn(
    review,
    input.body,
    "DINAR_DRAFT_APPROVED",
    `راجع الرسالة قبل إرسالها: «${input.body}». لن تُرسل إلا بعد تأكيدك؛ اكتب «نعم» أو «إلغاء».`,
  );
  return {
    ...turn.result,
    preparedAction: { actionId: review.actionId, action: "SEND_INQUIRY_MESSAGE", targetResource: input.target },
  };
}

async function prepareListingDraft(input: z.infer<typeof DraftArgs>, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن إعداد مسودة دون حساب.", "TOOL_NOT_ALLOWED");
  const parts = [`أريد بيع ${input.title}`];
  if (input.price !== undefined) parts.push(`بسعر ${input.price}`);
  if (input.category) parts.push(`تصنيف ${input.category}`);
  if (input.quantity !== undefined) parts.push(`الكمية ${input.quantity}`);
  if (input.description) parts.push(input.description);
  const result = await listingDraft(context.conversationId, parts.join(" "), "SELL", [], undefined, context.actorId);
  if (!result) throw new ModelCapabilityRejected("لم أستطع بدء مسودة إعلان من هذه التفاصيل.", "ACTION_UNAVAILABLE");
  const draft = result.draft as { draftId?: unknown } | undefined;
  return {
    ...result,
    preparedDraft: { draftId: typeof draft?.draftId === "string" ? draft.draftId : undefined },
  };
}

async function requestPublicationReview(input: { draftId: string }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن طلب النشر دون حساب.", "TOOL_NOT_ALLOWED");
  const read = await readDraftSnapshot(context.actorId, input.draftId);
  if (!read?.draft) throw new ModelCapabilityRejected("هذه المسودة ليست لك أو لم تعد موجودة.", "TARGET_UNAVAILABLE");
  if (read.snapshot.resourceStatus !== "COMPLETE")
    throw new ModelCapabilityRejected("المسودة غير مكتملة؛ أكمل الحقول الناقصة قبل طلب النشر.", "ACTION_UNAVAILABLE");
  const review = await createPendingAction({
    conversationId: context.conversationId,
    actorId: context.actorId,
    market: context.market,
    proposal: proposeAction({ action: "PUBLISH_LISTING", targetResource: input.draftId }),
  });
  const categories = (await listMarketplaceCategories()).map(categorySchema);
  const draftReview = buildDraftReview(ConversationDraft.parse(read.draft), categories);
  const price = read.draft.unitPrice ? `${read.draft.unitPrice} ${context.market.currencyCode}` : "بالاتفاق";
  return surface(
    "SELL",
    `راجع الإعلان «${read.draft.title ?? ""}» بسعر ${price}. ${review.lines.join(" ")} لن يُنشر شيء قبل تأكيدك: اكتب «نعم» أو «إلغاء».`,
    {
      draft: read.draft as unknown as Record<string, unknown>,
      draftStep: "publish_review",
      draftReview: draftReview as unknown as Record<string, unknown>,
      resultSetId: review.actionId,
      resourceIds: [input.draftId],
      preparedAction: { actionId: review.actionId, action: "PUBLISH_LISTING", targetResource: input.draftId },
    },
  );
}

async function readNegotiationStatus(input: { negotiationId: string }, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن قراءة التفاوض دون حساب.", "TOOL_NOT_ALLOWED");
  const row = await negotiationForParty(context.actorId, input.negotiationId);
  if (!row) throw new ModelCapabilityRejected("هذا التفاوض ليس لك أو لم يعد موجودًا.", "TARGET_UNAVAILABLE");
  const negotiation = {
    negotiationId: row.id,
    listingId: row.listingId,
    title: await offerTitle(row.listingId, context.market.id),
    role: row.buyerId === context.actorId ? "BUYER" : "SELLER",
    status: row.status,
    quantity: row.quantity,
    offerAmount: row.offerAmountMinor === null ? null : money(row.offerAmountMinor, context.market),
    counterAmount: row.counterAmountMinor === null ? null : money(row.counterAmountMinor, context.market),
    currency: row.currencyCode,
  };
  return surface("NEGOTIATION_STATUS", "هذه حالة التفاوض الحالية من سجل DINAR.", { negotiation });
}

async function prepareNegotiationProposal(input: z.infer<typeof ProposalArgs>, context: ToolContext): Promise<ToolResult> {
  if (!context.actorId) throw new ModelCapabilityRejected("لا يمكن إعداد عرض سعر دون حساب.", "TOOL_NOT_ALLOWED");
  let amountMinor: number;
  try {
    amountMinor = parseListingPriceMinor(String(input.amount), context.market.currencyCode);
  } catch {
    throw new ModelCapabilityRejected("المبلغ غير صالح.", "INVALID_ARGUMENTS");
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1)
    throw new ModelCapabilityRejected("المبلغ غير صالح.", "INVALID_ARGUMENTS");

  if (input.negotiationId) {
    const row = await negotiationForParty(context.actorId, input.negotiationId);
    if (!row) throw new ModelCapabilityRejected("هذا التفاوض ليس لك أو لم يعد موجودًا.", "TARGET_UNAVAILABLE");
    const review = await createPendingAction({
      conversationId: context.conversationId,
      actorId: context.actorId,
      market: context.market,
      proposal: proposeAction({
        action: "COUNTER_NEGOTIATION",
        targetResource: input.negotiationId,
        facts: { amountMinor: [{ value: amountMinor, source: "DINAR_DERIVED" }] },
      }),
    });
    const turn = negotiationReviewTurn(
      review,
      {
        negotiationId: row.id,
        listingId: row.listingId,
        title: await offerTitle(row.listingId, context.market.id),
        role: row.buyerId === context.actorId ? "BUYER" : "SELLER",
        quantity: row.quantity,
        currency: context.market.currencyCode,
        counterAmount: money(amountMinor, context.market),
      },
      `راجع عرضك المضاد ${money(amountMinor, context.market)}. لن يُرسل شيء قبل تأكيدك؛ اكتب «نعم» أو «إلغاء».`,
      "COUNTER_NEGOTIATION",
    );
    return {
      ...turn.result,
      preparedAction: { actionId: review.actionId, action: "COUNTER_NEGOTIATION", targetResource: input.negotiationId },
    };
  }

  if (!input.listingId)
    throw new ModelCapabilityRejected("حدد الإعلان أو التفاوض الذي تريد عرضًا عليه.", "INVALID_ARGUMENTS");
  const quantity = input.quantity ?? 1;
  const review = await createPendingAction({
    conversationId: context.conversationId,
    actorId: context.actorId,
    market: context.market,
    proposal: proposeAction({
      action: "SEND_NEGOTIATION_OFFER",
      targetResource: input.listingId,
      facts: {
        amountMinor: [{ value: amountMinor, source: "DINAR_DERIVED" }],
        quantity: [{ value: quantity, source: input.quantity ? "USER_DECLARED" : "DINAR_DERIVED" }],
      },
    }),
  });
  const turn = negotiationReviewTurn(
    review,
    {
      listingId: input.listingId,
      title: await offerTitle(input.listingId, context.market.id),
      role: "BUYER",
      quantity,
      offerAmount: money(amountMinor, context.market),
      currency: context.market.currencyCode,
    },
    `راجع عرضك ${money(amountMinor, context.market)}. لن يُرسل شيء قبل تأكيدك؛ اكتب «إرسال العرض» أو «إلغاء».`,
    "SEND_NEGOTIATION_OFFER",
  );
  return {
    ...turn.result,
    preparedAction: { actionId: review.actionId, action: "SEND_NEGOTIATION_OFFER", targetResource: input.listingId },
  };
}

/**
 * Executes one F02 capability tool. The name must already be allowed for the caller's
 * server-derived roles; role filtering is applied again here so a forged request is refused.
 */
export async function executeModelCapabilityTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.actorId || !isModelCapabilityTool(name))
    throw new ModelCapabilityRejected("هذه الأداة غير متاحة لهذه المحادثة.", "TOOL_NOT_ALLOWED");
  const roles = await modelRolesForActor(context.actorId, context.market.id);
  if (!modelCapabilityToolNamesForRoles(roles).includes(name))
    throw new ModelCapabilityRejected("هذه الأداة غير متاحة لدورك في هذا السوق.", "TOOL_NOT_ALLOWED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new ModelCapabilityRejected("وسيطات الأداة غير صالحة.", "INVALID_ARGUMENTS");
  }
  try {
    switch (name) {
      case "readInventory":
        return await readInventory(context);
      case "readBusinessInquiries":
        return await readBusinessInquiries(ReadLimit.parse(parsed), context);
      case "readOrders":
        return await readOrders(ReadLimit.parse(parsed), context);
      case "readFulfillment":
        return await readFulfillment(OrderArgs.parse(parsed), context);
      case "readCart":
        return await readCart(context);
      case "reviewCheckout":
        return await reviewCheckout(context);
      case "prepareCartChange":
        return await prepareCartChange(CartChangeArgs.parse(parsed), context);
      case "prepareInquiryMessage":
        return await prepareInquiryMessage(InquiryArgs.parse(parsed), context);
      case "prepareListingDraft":
        return await prepareListingDraft(DraftArgs.parse(parsed), context);
      case "requestPublicationReview":
        return await requestPublicationReview(PublishArgs.parse(parsed), context);
      case "readNegotiationStatus":
        return await readNegotiationStatus(NegotiationReadArgs.parse(parsed), context);
      case "prepareNegotiationProposal":
        return await prepareNegotiationProposal(ProposalArgs.parse(parsed), context);
    }
  } catch (error) {
    if (error instanceof ModelCapabilityRejected || error instanceof z.ZodError) throw error;
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status < 500 && error instanceof Error)
      throw new ModelCapabilityRejected(error.message, "ACTION_UNAVAILABLE");
    throw error;
  }
  throw new ModelCapabilityRejected("هذه الأداة غير معروفة.", "TOOL_NOT_ALLOWED");
}
