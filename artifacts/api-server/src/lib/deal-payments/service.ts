/**
 * Payment Preferences & Agreement. Jassim asks both parties how they will settle, checks that the
 * buyer's choice is one the seller accepts (or asks the seller), and records each party's own
 * statements. It never receives, holds, verifies or settles money:
 *   - BUYER_REPORTED_PAID is the buyer's claim, never proof of payment;
 *   - SELLER_CONFIRMED_RECEIPT and COD_COLLECTED are the seller's attestation, never a bank check;
 *   - a delivery marked delivered never marks cash collected.
 * Separate from the Jassim Ads wallet, JassimAI subscriptions and the simulated order payments.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  dealPaymentAgreements,
  dealPaymentEvents,
  conversations,
  messages,
  offers,
  orderFulfillments,
  orders,
  sellerPaymentMethods,
  transactionLocations,
  users,
} from "@workspace/db";
import { definitionFor, isDeclared, METHODS, methodLabel, methodStanding, negotiable, offerableMethods, resolveCountry, STANDING_LABELS_AR, type InstructionField, type ResolvedCountry, type ResolvedMethod } from "./catalog";
import { codAreaPolicyCheck } from "../merchant-policies/enforcement";
import { effectivePolicy } from "../merchant-policies/engine";
import { merchantPoliciesM2Enabled } from "../merchant-policies/flag";

type Agreement = typeof dealPaymentAgreements.$inferSelect;
type Order = typeof orders.$inferSelect;
type Role = "BUYER" | "SELLER";
type MarketRef = { id: string; countryCode: string; currencyCode: string; minorUnitScale: number };

export class DealPaymentError extends Error {
  readonly expose = true;
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "DealPaymentError";
  }
}
const reject = (status: number, code: string, message: string): never => {
  throw new DealPaymentError(status, code, message);
};
const notFound = () => reject(404, "ORDER_NOT_FOUND", "الطلب غير موجود");

const OPEN_ORDER = new Set(["CREATED", "PAYMENT_PENDING", "ACCEPTED", "IN_PROGRESS", "SELLER_MARKED_DELIVERED", "BUYER_CONFIRMED", "COMPLETED"]);
const NEGOTIATING = new Set(["DRAFT", "WAITING_FOR_SELLER", "WAITING_FOR_BUYER", "PAYMENT_METHOD_PROPOSED"]);
const AGREED = new Set(["AWAITING_PAYMENT", "COD_PENDING_DELIVERY", "PAYMENT_METHOD_CONFIRMED"]);
const SETTLED = new Set(["SELLER_CONFIRMED_RECEIPT", "COD_COLLECTED", "COMPLETED"]);
const DELIVERY_METHODS = new Set(["SELLER_DELIVERY", "COURIER", "EXTERNAL_PROVIDER"]);

export const STATUS_LABELS_AR: Record<string, string> = {
  DRAFT: "مسودة",
  WAITING_FOR_SELLER: "بانتظار البائع",
  WAITING_FOR_BUYER: "بانتظار اختيار المشتري",
  PAYMENT_METHOD_PROPOSED: "بانتظار الاتفاق",
  PAYMENT_METHOD_CONFIRMED: "تم الاتفاق على طريقة الدفع",
  AWAITING_PAYMENT: "بانتظار الدفع",
  BUYER_REPORTED_PAID: "المشتري أبلغ بالدفع (غير مؤكد)",
  SELLER_CONFIRMED_RECEIPT: "البائع أكد الاستلام",
  COD_PENDING_DELIVERY: "الدفع عند الاستلام",
  COD_COLLECTED: "البائع أكد تحصيل المبلغ",
  COMPLETED: "مكتملة",
  CANCELLED: "ملغاة",
  DISPUTED: "خلاف على الدفع",
};

// ── Seller preferences ─────────────────────────────────────────────────────────────────────────

const FIELD_LIMIT = 120;
/** Card numbers, passwords and one-time codes are never stored, whatever field they come in. */
function assertSafeInstructionValue(field: string, value: string) {
  const digits = value.replace(/[\s-]/g, "");
  const luhn = (s: string) => {
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      let d = Number(s[s.length - 1 - i]);
      if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  };
  if (/^\d{13,19}$/.test(digits) && luhn(digits) && field !== "iban" && field !== "accountNumber")
    reject(400, "CARD_NUMBER_REFUSED", "لا نحفظ أرقام البطاقات. أدخل اسم المستفيد أو الحساب أو رقم الهاتف المرتبط بالتحويل فقط.");
  if (/(?:كلمه|كلمة)\s*(?:السر|المرور)|password|passcode|\botp\b|رمز\s*(?:التحقق|التاكيد|التأكيد)|cvv|cvc|\bpin\b/iu.test(value))
    reject(400, "SECRET_REFUSED", "لا نطلب ولا نحفظ كلمات المرور أو رموز التحقق أو بيانات الدخول إلى المحافظ.");
}

export type SellerMethodInput = {
  code: string;
  customLabel?: string | null;
  instructions?: Partial<Record<InstructionField, string>>;
  sharePolicy?: "ON_REQUEST" | "CONFIRMED_BUYERS";
  codAreas?: string[];
  paused?: boolean;
};

export async function sellerMethodsView(sellerId: string, market: MarketRef) {
  const country = await resolveCountry(market.countryCode);
  const available = offerableMethods(country, market.currencyCode);
  const rows = await db
    .select()
    .from(sellerPaymentMethods)
    .where(and(eq(sellerPaymentMethods.sellerId, sellerId), eq(sellerPaymentMethods.marketId, market.id)))
    .orderBy(asc(sellerPaymentMethods.createdAt));
  return {
    countryCode: market.countryCode,
    currencyCode: market.currencyCode,
    countryStatus: country?.status ?? "UNAVAILABLE",
    available: available.map(catalogView),
    accepted: rows.map((row) => ({
      code: row.methodCode,
      label: methodLabel(row.methodCode, row.customLabel),
      kind: METHODS[row.methodCode]?.kind ?? "DIRECT",
      offerable: available.some((m) => m.code === row.methodCode),
      paused: row.paused,
      sharePolicy: row.sharePolicy,
      codAreas: row.codAreas,
      instructions: row.instructions,
      version: row.version,
    })),
  };
}

const catalogView = (m: ResolvedMethod) => ({ code: m.code, label: m.labelAr, kind: m.kind, status: m.status, instructionFields: m.instructionFields });

/**
 * Upserts the seller's accepted methods in their market. `replace` removes nothing from history:
 * methods left out are paused, never deleted, so open agreements keep their snapshot.
 */
export async function setSellerMethods(input: { sellerId: string; market: MarketRef; methods: SellerMethodInput[]; replace?: boolean }) {
  if (!input.methods.length && !input.replace) reject(400, "NO_METHODS", "اختر طريقة دفع واحدة على الأقل.");
  const country = await resolveCountry(input.market.countryCode);
  const seen = new Set<string>();
  for (const method of input.methods) {
    if (seen.has(method.code)) reject(400, "DUPLICATE_METHOD", "طريقة الدفع مكررة.");
    seen.add(method.code);
    // Open choice: any known or named method may be accepted, except where the country catalog
    // explicitly marks it unavailable. Accepting it does not make it «verified».
    const definition = definitionFor(method.code, method.customLabel);
    if (!definition) reject(400, "UNKNOWN_METHOD", "اكتب اسم الوسيلة.");
    if ((method.code === "OTHER_AGREED" || isDeclared(method.code)) && !method.customLabel?.trim()) reject(400, "CUSTOM_LABEL_REQUIRED", "اكتب اسم الوسيلة الأخرى.");
    if (!negotiable(methodStanding(country, method.code, input.market.currencyCode)))
      reject(409, "METHOD_UNSUPPORTED_FOR_THIS_TRANSACTION", `«${methodLabel(method.code, method.customLabel)}» غير متاحة في ${country?.nameAr ?? "هذا البلد"} حاليًا.`);
    validateInstructions(definition!.instructionFields, method.instructions);
    if (method.codAreas && (method.codAreas.length > 50 || method.codAreas.some((a) => typeof a !== "string" || a.length > 60)))
      reject(400, "COD_AREAS_INVALID", "مناطق التوصيل غير صالحة.");
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    if (input.replace) {
      await tx
        .update(sellerPaymentMethods)
        .set({ paused: true, updatedAt: now })
        .where(and(eq(sellerPaymentMethods.sellerId, input.sellerId), eq(sellerPaymentMethods.marketId, input.market.id)));
    }
    for (const method of input.methods) {
      const [existing] = await tx
        .select()
        .from(sellerPaymentMethods)
        .where(and(eq(sellerPaymentMethods.sellerId, input.sellerId), eq(sellerPaymentMethods.marketId, input.market.id), eq(sellerPaymentMethods.methodCode, method.code)))
        .for("update");
      const values = {
        customLabel: method.customLabel?.trim() || existing?.customLabel || null,
        instructions: clean(method.instructions) ?? existing?.instructions ?? {},
        sharePolicy: method.sharePolicy ?? existing?.sharePolicy ?? "ON_REQUEST",
        codAreas: method.codAreas?.map((a) => a.trim()).filter(Boolean) ?? existing?.codAreas ?? [],
        paused: method.paused ?? false,
        updatedAt: now,
      };
      if (existing)
        await tx
          .update(sellerPaymentMethods)
          .set({ ...values, version: existing.version + 1 })
          .where(and(eq(sellerPaymentMethods.sellerId, input.sellerId), eq(sellerPaymentMethods.marketId, input.market.id), eq(sellerPaymentMethods.methodCode, method.code)));
      else await tx.insert(sellerPaymentMethods).values({ sellerId: input.sellerId, marketId: input.market.id, methodCode: method.code, ...values, createdAt: now });
    }
    return null;
  }).then(() => sellerMethodsView(input.sellerId, input.market));
}

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
function validateInstructions(allowed: readonly InstructionField[], instructions?: Partial<Record<string, string>>) {
  for (const [field, value] of Object.entries(instructions ?? {})) {
    if (!allowed.includes(field as InstructionField)) reject(400, "INSTRUCTION_FIELD_NOT_ALLOWED", `الحقل «${field}» غير مطلوب لهذه الوسيلة.`);
    if (typeof value !== "string" || value.length > FIELD_LIMIT) reject(400, "INSTRUCTION_TOO_LONG", "بيانات الدفع طويلة أكثر من اللازم.");
    assertSafeInstructionValue(field, value!);
    const v = value!.trim();
    if (field === "iban" && v && !IBAN.test(v.replace(/\s+/g, "").toUpperCase())) reject(400, "IBAN_INVALID", "رقم IBAN غير صالح الصيغة.");
    if (field === "phone" && v && !/^\+?[\d\s-]{7,20}$/.test(v)) reject(400, "PHONE_INVALID", "رقم الهاتف غير صالح الصيغة.");
    if (field === "paymentLink" && v) {
      let url: URL | null = null;
      try { url = new URL(v); } catch { url = null; }
      if (!url || url.protocol !== "https:" || url.username || url.password) reject(400, "PAYMENT_LINK_INVALID", "رابط الدفع يجب أن يكون https ومن صفحة دفع البائع نفسه.");
    }
  }
}

function clean(instructions?: Partial<Record<string, string>>) {
  if (!instructions) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(instructions)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

// ── Agreement ─────────────────────────────────────────────────────────────────────────────────

/**
 * What the seller accepts for this order: their active methods in the market that are offerable
 * now, narrowed by any listing-level restriction on every item (multi-item orders take the
 * intersection). A listing published before this system with legacy CASH_DIRECT counts as cash.
 */
async function acceptedFor(tx: any, order: Order): Promise<string[]> {
  const country = await resolveCountry(order.countryCode, tx);
  const allowed = (code: string) => negotiable(methodStanding(country, code, order.currencyCode));
  const rows = await tx
    .select({ code: sellerPaymentMethods.methodCode })
    .from(sellerPaymentMethods)
    .where(and(eq(sellerPaymentMethods.sellerId, order.sellerId), eq(sellerPaymentMethods.marketId, order.marketId), eq(sellerPaymentMethods.paused, false)));
  let accepted: string[] = rows.map((r: { code: string }) => r.code);
  const items = (Array.isArray(order.data?.items) ? order.data.items : []) as { listingId?: string; paymentMethods?: string[] }[];
  if (!accepted.length && items.length && items.every((item) => item.paymentMethods?.includes("CASH_DIRECT"))) accepted = ["CASH_IN_PERSON", "COD"];
  const listingIds = [...new Set(items.map((i) => i.listingId).filter((id): id is string => typeof id === "string"))];
  if (listingIds.length) {
    const listingRows = await tx.select({ data: offers.data, businessProfileId: offers.businessProfileId }).from(offers).where(inArray(offers.id, listingIds));
    for (const row of listingRows) {
      const restriction = (row.data as any)?.dealPaymentMethods;
      if (Array.isArray(restriction) && restriction.length) accepted = accepted.filter((code) => restriction.includes(code));
      if (merchantPoliciesM2Enabled() && row.businessProfileId) {
        const policy = await effectivePolicy(row.businessProfileId, "PAYMENT_METHODS", {}, tx);
        const rawMethods = (policy?.rule as { methods?: Array<string | { code: string; enabled?: boolean }> } | undefined)?.methods;
        if (Array.isArray(rawMethods) && rawMethods.length) {
          const policyCodes = rawMethods
            .filter((m) => (typeof m === "string" ? true : m.enabled !== false))
            .map((m) => (typeof m === "string" ? m : m.code));
          accepted = accepted.filter((code) => policyCodes.includes(code));
        }
      }
    }
  }
  return accepted.filter(allowed);
}

async function lockOrder(tx: any, orderId: string, actorId: string, marketId: string): Promise<{ order: Order; role: Role }> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  if (!order || order.marketId !== marketId || (order.buyerId !== actorId && order.sellerId !== actorId)) notFound();
  return { order, role: order.buyerId === actorId ? "BUYER" : "SELLER" };
}

async function lockAgreement(tx: any, order: Order): Promise<Agreement> {
  const [existing] = await tx.select().from(dealPaymentAgreements).where(eq(dealPaymentAgreements.orderId, order.id)).for("update");
  if (existing) {
    // Until a method is agreed, the seller's current preferences are what the buyer sees.
    if (existing.status === "WAITING_FOR_BUYER" || existing.status === "WAITING_FOR_SELLER") {
      const accepted = await acceptedFor(tx, order);
      const status = accepted.length ? "WAITING_FOR_BUYER" : "WAITING_FOR_SELLER";
      if (JSON.stringify(accepted) !== JSON.stringify(existing.acceptedMethods) || status !== existing.status) {
        const [updated] = await tx
          .update(dealPaymentAgreements)
          .set({ acceptedMethods: accepted, status, updatedAt: new Date() })
          .where(eq(dealPaymentAgreements.id, existing.id))
          .returning();
        return updated;
      }
    }
    return existing;
  }
  const accepted = await acceptedFor(tx, order);
  const id = randomUUID();
  const status = accepted.length ? "WAITING_FOR_BUYER" : "WAITING_FOR_SELLER";
  const [created] = await tx
    .insert(dealPaymentAgreements)
    .values({
      id,
      orderId: order.id,
      marketId: order.marketId,
      countryCode: order.countryCode,
      currencyCode: order.currencyCode,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      acceptedMethods: accepted,
      status,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [raced] = await tx.select().from(dealPaymentAgreements).where(eq(dealPaymentAgreements.orderId, order.id)).for("update");
    return raced;
  }
  await tx.insert(dealPaymentEvents).values({ id: randomUUID(), agreementId: id, orderId: order.id, actorRole: "SYSTEM", event: "CREATED", toStatus: status, detail: { acceptedMethods: accepted } });
  return created;
}

type CodCheck = { available: boolean; reason?: string };
async function codAvailability(tx: any, order: Order): Promise<CodCheck> {
  const [fulfilment] = await tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, order.id));
  if (!fulfilment || ["CANCELLED", "FAILED"].includes(fulfilment.status)) return { available: false, reason: "اختر طريقة توصيل أولًا؛ الدفع عند الاستلام يحتاج توصيلًا." };
  if (!DELIVERY_METHODS.has(fulfilment.method)) return { available: false, reason: "الدفع عند الاستلام متاح مع التوصيل فقط، لا مع الاستلام الشخصي." };
  const [profile] = await tx
    .select({ codAreas: sellerPaymentMethods.codAreas })
    .from(sellerPaymentMethods)
    .where(and(eq(sellerPaymentMethods.sellerId, order.sellerId), eq(sellerPaymentMethods.marketId, order.marketId), eq(sellerPaymentMethods.methodCode, "COD")));
  const areas: string[] = profile?.codAreas ?? [];
  const [destination] = await tx
    .select({ city: transactionLocations.city, area: transactionLocations.area })
    .from(transactionLocations)
    .where(and(eq(transactionLocations.orderId, order.id), eq(transactionLocations.purpose, "DELIVERY_DESTINATION")));
  if (merchantPoliciesM2Enabled()) {
    const items = (Array.isArray(order.data?.items) ? order.data.items : []) as { listingId?: string }[];
    const firstId = items.find((i) => typeof i.listingId === "string")?.listingId;
    if (firstId) {
      const [offerRow] = await tx.select({ businessProfileId: offers.businessProfileId }).from(offers).where(eq(offers.id, firstId)).limit(1);
      if (offerRow?.businessProfileId) {
        const policyCod = await codAreaPolicyCheck({
          businessId: offerRow.businessProfileId,
          city: destination?.city,
          area: destination?.area,
          tx,
        });
        if (!policyCod.allowed) return { available: false, reason: policyCod.reason };
      }
    }
  }
  if (!areas.length) return { available: true };
  if (!destination) return { available: false, reason: "شارك موقع التسليم أولًا ليتحقق جاسم من أن البائع يغطي منطقتك بالدفع عند الاستلام." };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const covered = areas.some((a) => [destination.city, destination.area].map(norm).includes(norm(a)));
  return covered ? { available: true } : { available: false, reason: "البائع لا يقبل الدفع عند الاستلام في منطقة التسليم هذه." };
}

/**
 * Jassim tells the other party in the order's own thread (the conversation both parties already
 * see). Never payment details: only what happened and what is awaited.
 */
const THREAD_NOTES: Record<string, (d: Record<string, unknown>, role: string) => string | null> = {
  METHOD_PROPOSED: (d, role) => `${role === "BUYER" ? "المشتري" : "البائع"} يقترح الدفع عبر «${String(d.labelText)}» لهذه الصفقة. هل تقبلها؟ الرد من بطاقة الصفقة.`,
  CHANGE_PROPOSED: (d, role) => `${role === "BUYER" ? "المشتري" : "البائع"} يطلب تغيير طريقة الدفع إلى «${String(d.labelText)}». الاتفاق السابق يبقى حتى توافق.`,
  PROPOSAL_ACCEPTED: (d) => `تمت الموافقة على الدفع عبر «${String(d.labelText)}».`,
  PROPOSAL_REJECTED: (d) => `رُفض اقتراح الدفع عبر «${String(d.labelText)}»؛ لم يتغير الاتفاق.`,
  INSTRUCTIONS_SHARED: () => "شارك البائع تعليمات الدفع؛ تظهر للمشتري في المساحة المحمية داخل بطاقة الصفقة.",
  INSTRUCTIONS_PROVIDED_AND_SHARED: () => "شارك البائع تعليمات الدفع؛ تظهر للمشتري في المساحة المحمية داخل بطاقة الصفقة.",
  BUYER_REPORTED_PAID: () => "المشتري أبلغ أنه دفع. هذا إبلاغ وليس تأكيدًا؛ بانتظار تأكيد البائع للاستلام.",
  SELLER_CONFIRMED_RECEIPT: () => "البائع أكد استلام المبلغ (إفادة البائع؛ لم يتحقق جاسم من أي تحويل).",
  SELLER_REPORTED_NOT_RECEIVED: () => "البائع أفاد بأن المبلغ لم يصله؛ الحالة الآن خلاف على الدفع.",
};

async function record(tx: any, agreement: Agreement, actor: { id: string | null; role: Role | "ADMIN" | "SYSTEM" }, event: string, toStatus: string, detail: Record<string, unknown> = {}) {
  const note = THREAD_NOTES[event];
  if (note) {
    const labelText = methodLabel(String(detail.method ?? agreement.proposedMethod ?? agreement.agreedMethod ?? ""), (detail.label as string | null) ?? agreement.proposedLabel ?? agreement.agreedLabel);
    const body = note({ ...detail, labelText }, actor.role);
    const [thread] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.orderId, agreement.orderId)).limit(1);
    if (body && thread) await tx.insert(messages).values({ id: randomUUID(), conversationId: thread.id, body });
  }
  await tx.insert(dealPaymentEvents).values({
    id: randomUUID(),
    agreementId: agreement.id,
    orderId: agreement.orderId,
    actorId: actor.id,
    actorRole: actor.role,
    event,
    fromStatus: agreement.status,
    toStatus,
    detail,
  });
}

async function update(tx: any, agreement: Agreement, values: Partial<Agreement>) {
  const [row] = await tx
    .update(dealPaymentAgreements)
    .set({ ...values, version: agreement.version + 1, updatedAt: new Date() })
    .where(and(eq(dealPaymentAgreements.id, agreement.id), eq(dealPaymentAgreements.version, agreement.version)))
    .returning();
  if (!row) reject(409, "AGREEMENT_CHANGED", "تغيّر الاتفاق للتو؛ أعد المحاولة.");
  return row as Agreement;
}

const agreedStatusFor = (code: string) => (METHODS[code]?.kind === "COD" ? "COD_PENDING_DELIVERY" : "AWAITING_PAYMENT");

export type DealAction =
  | { type: "CHOOSE"; method: string; customLabel?: string }
  | { type: "RESPOND"; accept: boolean }
  | { type: "SHARE_INSTRUCTIONS" }
  | { type: "PROVIDE_INSTRUCTIONS"; instructions: Partial<Record<InstructionField, string>> }
  | { type: "REPORT_PAID"; note?: string }
  | { type: "CONFIRM_RECEIPT" }
  | { type: "REPORT_NOT_RECEIVED"; note?: string }
  | { type: "COD_COLLECTED" }
  | { type: "CANCEL"; reason?: string };

/**
 * Applies one party's action under row locks on the order and its agreement. `expectedVersion`,
 * when given, refuses an action taken on a card that is no longer current.
 */
export async function applyDealAction(input: { actorId: string; orderId: string; market: MarketRef; action: DealAction; expectedVersion?: number }) {
  const result = await db.transaction(async (tx) => {
    const { order, role } = await lockOrder(tx, input.orderId, input.actorId, input.market.id);
    let agreement = await lockAgreement(tx, order);
    if (input.expectedVersion !== undefined && input.expectedVersion !== agreement.version)
      reject(409, "AGREEMENT_CHANGED", "تغيّرت بطاقة الصفقة منذ عرضها؛ راجع الحالة الحالية.");
    if (!OPEN_ORDER.has(order.status) && input.action.type !== "CANCEL") reject(409, "ORDER_CLOSED", "الطلب مغلق؛ لا يمكن تعديل اتفاق الدفع.");
    if (agreement.status === "CANCELLED") reject(409, "AGREEMENT_CANCELLED", "اتفاق الدفع ملغى.");
    const actor = { id: input.actorId, role };
    const action = input.action;
    let message = "";

    switch (action.type) {
      case "CHOOSE": {
        if (SETTLED.has(agreement.status) || agreement.status === "BUYER_REPORTED_PAID" || agreement.status === "DISPUTED")
          reject(409, "PAYMENT_ALREADY_REPORTED", "لا يمكن تغيير طريقة الدفع بعد الإبلاغ عن الدفع أو تأكيده.");
        const definition = definitionFor(action.method, action.customLabel);
        if (!definition) reject(400, "UNKNOWN_METHOD", "طريقة الدفع غير معروفة.");
        if ((action.method === "OTHER_AGREED" || isDeclared(action.method)) && !action.customLabel?.trim() && !agreement.acceptedMethods.includes(action.method))
          reject(400, "CUSTOM_LABEL_REQUIRED", "اكتب اسم الوسيلة التي تقترحها.");
        const country = await resolveCountry(order.countryCode, tx);
        // Open choice: a method missing from the catalog is still negotiable between the parties.
        if (!negotiable(methodStanding(country, action.method, order.currencyCode)))
          reject(409, "METHOD_UNSUPPORTED_FOR_THIS_TRANSACTION", `«${definition!.labelAr}» غير متاحة في ${country?.nameAr ?? "هذا البلد"} حاليًا؛ اختر وسيلة أخرى.`);
        if (definition!.kind === "COD") {
          const cod = await codAvailability(tx, order);
          if (!cod.available) reject(409, "COD_UNAVAILABLE", cod.reason!);
        }
        const label = action.method === "OTHER_AGREED" || isDeclared(action.method) ? (action.customLabel?.trim() || definition!.labelAr).slice(0, 60) : null;
        const accepted = agreement.acceptedMethods.includes(action.method) && action.method !== "OTHER_AGREED";
        const wasAgreed = AGREED.has(agreement.status);
        if (accepted && role === "BUYER" && !wasAgreed) {
          // The seller accepted this method in advance; the buyer's choice completes the agreement.
          const to = agreedStatusFor(action.method);
          await record(tx, agreement, actor, "METHOD_CONFIRMED", to, { method: action.method, basis: "SELLER_PRE_ACCEPTED" });
          agreement = await update(tx, agreement, { agreedMethod: action.method, agreedLabel: label, proposedMethod: null, proposedBy: null, proposedLabel: null, status: to, instructionsShared: null, instructionsSharedAt: null });
          message = `تم الاتفاق على ${methodLabel(action.method, label)}.`;
        } else {
          // Anything else — a method the seller did not pre-accept, a seller proposal, or any change
          // after agreement — waits for the other party.
          if (agreement.agreedMethod === action.method && wasAgreed) reject(409, "ALREADY_AGREED", "هذه هي الطريقة المتفق عليها بالفعل.");
          await record(tx, agreement, actor, wasAgreed ? "CHANGE_PROPOSED" : "METHOD_PROPOSED", "PAYMENT_METHOD_PROPOSED", { method: action.method, label, previous: wasAgreed ? agreement.agreedMethod : null, previousLabel: wasAgreed ? agreement.agreedLabel : null });
          agreement = await update(tx, agreement, { proposedMethod: action.method, proposedLabel: label, proposedBy: role, status: "PAYMENT_METHOD_PROPOSED", agreedMethod: null, agreedLabel: null, instructionsShared: null, instructionsSharedAt: null });
          message = `اقترحت ${methodLabel(action.method, label)}. بانتظار موافقة ${role === "BUYER" ? "البائع" : "المشتري"}؛ لم تُعتمد بعد.`;
        }
        break;
      }
      case "RESPOND": {
        if (agreement.status !== "PAYMENT_METHOD_PROPOSED") reject(409, "NOTHING_TO_RESPOND", "لا يوجد اقتراح بانتظار ردك.");
        if (agreement.proposedBy === role) reject(409, "OWN_PROPOSAL", "لا يمكنك الموافقة على اقتراحك؛ الموافقة للطرف الآخر.");
        if (action.accept) {
          const method = agreement.proposedMethod!;
          if (METHODS[method]?.kind === "COD") {
            const cod = await codAvailability(tx, order);
            if (!cod.available) reject(409, "COD_UNAVAILABLE", cod.reason!);
          }
          const to = agreedStatusFor(method);
          await record(tx, agreement, actor, "PROPOSAL_ACCEPTED", to, { method, label: agreement.proposedLabel });
          agreement = await update(tx, agreement, { agreedMethod: method, agreedLabel: agreement.proposedLabel, proposedMethod: null, proposedBy: null, proposedLabel: null, status: to });
          message = `وافقت؛ تم الاتفاق على ${methodLabel(method, agreement.agreedLabel)}.`;
        } else {
          // A rejected change keeps the earlier agreement; a rejected first proposal reopens the choice.
          const [change] = await tx
            .select({ event: dealPaymentEvents.event, detail: dealPaymentEvents.detail })
            .from(dealPaymentEvents)
            .where(eq(dealPaymentEvents.agreementId, agreement.id))
            .orderBy(desc(dealPaymentEvents.createdAt), desc(dealPaymentEvents.id))
            .limit(1);
          const previous = change?.event === "CHANGE_PROPOSED" ? (change.detail as { previous?: string; previousLabel?: string | null }) : null;
          const restore = previous?.previous ?? null;
          const to = restore ? agreedStatusFor(restore) : agreement.acceptedMethods.length ? "WAITING_FOR_BUYER" : "WAITING_FOR_SELLER";
          await record(tx, agreement, actor, "PROPOSAL_REJECTED", to, { method: agreement.proposedMethod, restored: restore });
          agreement = await update(tx, agreement, { proposedMethod: null, proposedBy: null, proposedLabel: null, status: to, ...(restore ? { agreedMethod: restore, agreedLabel: previous?.previousLabel ?? null } : {}) });
          message = restore
            ? `رفضت التغيير؛ يبقى الاتفاق السابق على ${methodLabel(restore, agreement.agreedLabel)}.`
            : "رفضت الاقتراح؛ لم يُعتمد. يمكن اختيار طريقة أخرى من الطرق المقبولة.";
        }
        break;
      }
      case "SHARE_INSTRUCTIONS": {
        if (role !== "SELLER") reject(403, "SELLER_ONLY", "مشاركة بيانات الدفع قرار البائع.");
        if (!AGREED.has(agreement.status) && agreement.status !== "BUYER_REPORTED_PAID") reject(409, "NOT_AGREED", "شارك بيانات الدفع بعد الاتفاق على الطريقة.");
        const instructions = await sellerInstructions(tx, agreement);
        if (!instructions || !Object.keys(instructions).length) reject(409, "NO_INSTRUCTIONS", "لم تحفظ بيانات دفع لهذه الطريقة بعد.");
        await record(tx, agreement, actor, "INSTRUCTIONS_SHARED", agreement.status, { method: agreement.agreedMethod, fields: Object.keys(instructions!) });
        agreement = await update(tx, agreement, { instructionsShared: instructions, instructionsSharedAt: new Date() });
        message = "شاركت بيانات الدفع مع المشتري في هذا الطلب فقط.";
        break;
      }
      case "PROVIDE_INSTRUCTIONS": {
        // The seller gives the details for the agreed method from the protected form and, by this
        // action, approves sharing them with this order's buyer only.
        if (role !== "SELLER") reject(403, "SELLER_ONLY", "بيانات الدفع يقدمها البائع.");
        if (!agreement.agreedMethod || (!AGREED.has(agreement.status) && agreement.status !== "BUYER_REPORTED_PAID"))
          reject(409, "NOT_AGREED", "تُقدَّم بيانات الدفع بعد الاتفاق على الطريقة.");
        const definition = definitionFor(agreement.agreedMethod!, agreement.agreedLabel);
        if (!definition || definition.kind === "COD" || agreement.agreedMethod === "CASH_IN_PERSON") reject(409, "NO_INSTRUCTIONS_NEEDED", "هذه الطريقة لا تحتاج بيانات دفع.");
        validateInstructions(definition!.instructionFields, action.instructions);
        const instructions = clean(action.instructions) ?? {};
        if (!Object.keys(instructions).length) reject(400, "NO_INSTRUCTIONS", "أدخل بيانات الدفع المطلوبة.");
        if (definition!.requiresMerchantCheckout && !instructions.paymentLink)
          reject(400, "MERCHANT_CHECKOUT_REQUIRED", `${definition!.labelAr} تحتاج رابط صفحة الدفع التجارية الخاصة بك؛ لا نستخدم بطاقة شخصية.`);
        const now = new Date();
        await tx
          .insert(sellerPaymentMethods)
          .values({ sellerId: order.sellerId, marketId: order.marketId, methodCode: agreement.agreedMethod!, customLabel: agreement.agreedLabel, instructions, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [sellerPaymentMethods.sellerId, sellerPaymentMethods.marketId, sellerPaymentMethods.methodCode],
            set: { instructions, paused: false, updatedAt: now, version: sql`${sellerPaymentMethods.version} + 1` },
          });
        await record(tx, agreement, actor, "INSTRUCTIONS_PROVIDED_AND_SHARED", agreement.status, { method: agreement.agreedMethod, fields: Object.keys(instructions) });
        agreement = await update(tx, agreement, { instructionsShared: instructions, instructionsSharedAt: now });
        message = "حفظت بيانات الدفع وشاركتها مع المشتري في هذا الطلب فقط، داخل مساحة محمية.";
        break;
      }
      case "REPORT_PAID": {
        if (role !== "BUYER") reject(403, "BUYER_ONLY", "الإبلاغ عن الدفع للمشتري.");
        if (agreement.status !== "AWAITING_PAYMENT") reject(409, agreement.status === "COD_PENDING_DELIVERY" ? "COD_PAYS_ON_DELIVERY" : "NOT_AWAITING_PAYMENT", agreement.status === "COD_PENDING_DELIVERY" ? "الدفع هنا عند الاستلام؛ لا يوجد دفع مسبق للإبلاغ عنه." : "لا يوجد دفع متفق عليه بانتظار الإبلاغ.");
        const note = action.note?.trim().slice(0, 300) || null;
        await record(tx, agreement, actor, "BUYER_REPORTED_PAID", "BUYER_REPORTED_PAID", { note, verification: "UNVERIFIED_BUYER_CLAIM" });
        agreement = await update(tx, agreement, { status: "BUYER_REPORTED_PAID" });
        message = "سجّلت أنك دفعت. هذا إبلاغ منك فقط وليس تأكيدًا؛ ينتظر تأكيد البائع للاستلام.";
        break;
      }
      case "CONFIRM_RECEIPT": {
        if (role !== "SELLER") reject(403, "SELLER_ONLY", "تأكيد استلام المبلغ للبائع.");
        if (agreement.status !== "AWAITING_PAYMENT" && agreement.status !== "BUYER_REPORTED_PAID" && agreement.status !== "DISPUTED")
          reject(409, "NOT_AWAITING_PAYMENT", agreement.status === "COD_PENDING_DELIVERY" ? "هذا دفع عند الاستلام؛ استخدم «استلمت المبلغ نقدًا»." : "لا يوجد دفع بانتظار تأكيدك.");
        await record(tx, agreement, actor, "SELLER_CONFIRMED_RECEIPT", "SELLER_CONFIRMED_RECEIPT", { verification: "SELLER_ATTESTED" });
        agreement = await update(tx, agreement, { status: "SELLER_CONFIRMED_RECEIPT" });
        message = "سجّلت أنك استلمت المبلغ. هذا تأكيد منك، لم يتحقق منه جاسم مع أي بنك.";
        break;
      }
      case "REPORT_NOT_RECEIVED": {
        if (role !== "SELLER") reject(403, "SELLER_ONLY", "الإبلاغ عن عدم وصول المبلغ للبائع.");
        if (agreement.status !== "BUYER_REPORTED_PAID") reject(409, "NOTHING_REPORTED", "المشتري لم يبلغ عن دفع بعد.");
        await record(tx, agreement, actor, "SELLER_REPORTED_NOT_RECEIVED", "DISPUTED", { note: action.note?.trim().slice(0, 300) || null });
        agreement = await update(tx, agreement, { status: "DISPUTED" });
        message = "سجّلت أن المبلغ لم يصلك. أصبحت الحالة «خلاف على الدفع»؛ تواصلا لحلها، وجاسم لا يحكم في التحويل.";
        break;
      }
      case "COD_COLLECTED": {
        if (role !== "SELLER") reject(403, "SELLER_ONLY", "تأكيد تحصيل المبلغ عند الاستلام للبائع وحده.");
        if (agreement.status !== "COD_PENDING_DELIVERY") reject(409, "NOT_COD", "لا يوجد دفع عند الاستلام بانتظار التحصيل.");
        await record(tx, agreement, actor, "COD_COLLECTED", "COD_COLLECTED", { verification: "SELLER_ATTESTED", confirmedBy: "SELLER" });
        agreement = await update(tx, agreement, { status: "COD_COLLECTED" });
        message = "سجّلت أنك حصّلت المبلغ نقدًا عند التسليم.";
        break;
      }
      case "CANCEL": {
        if (SETTLED.has(agreement.status)) reject(409, "ALREADY_SETTLED", "أكد البائع استلام المبلغ؛ لا يُلغى الاتفاق من هنا.");
        await record(tx, agreement, actor, "CANCELLED", "CANCELLED", { reason: action.reason?.trim().slice(0, 300) || null });
        agreement = await update(tx, agreement, { status: "CANCELLED", proposedMethod: null, proposedBy: null, proposedLabel: null });
        message = "أُلغي اتفاق الدفع. لم تتحرك أي أموال عبر جاسم.";
        break;
      }
    }
    return { agreement, message };
  });
  return { message: result.message, card: await dealCard({ actorId: input.actorId, orderId: input.orderId, market: input.market }) };
}

async function sellerInstructions(tx: any, agreement: Agreement) {
  if (!agreement.agreedMethod) return null;
  const [row] = await tx
    .select({ instructions: sellerPaymentMethods.instructions })
    .from(sellerPaymentMethods)
    .where(and(eq(sellerPaymentMethods.sellerId, agreement.sellerId), eq(sellerPaymentMethods.marketId, agreement.marketId), eq(sellerPaymentMethods.methodCode, agreement.agreedMethod)));
  return (row?.instructions ?? null) as Record<string, string> | null;
}

/** Admin correction: always with a reason, recorded with the admin as actor. */
export async function adminSetDealStatus(input: { adminId: string; orderId: string; status: string; reason: string }) {
  if (!input.reason?.trim()) reject(400, "REASON_REQUIRED", "سبب التعديل مطلوب.");
  if (!["CANCELLED", "DISPUTED", "COMPLETED"].includes(input.status)) reject(400, "STATUS_NOT_ALLOWED", "الإدارة تستطيع فقط الإلغاء أو فتح خلاف أو الإغلاق كمكتمل.");
  return db.transaction(async (tx) => {
    const [agreement] = await tx.select().from(dealPaymentAgreements).where(eq(dealPaymentAgreements.orderId, input.orderId)).for("update");
    if (!agreement) notFound();
    if (input.status === "COMPLETED" && !agreement!.agreedMethod) reject(409, "NOT_AGREED", "لا يوجد اتفاق دفع ليُغلق.");
    await record(tx, agreement!, { id: input.adminId, role: "ADMIN" }, "ADMIN_STATUS_SET", input.status, { reason: input.reason.trim() });
    const row = await update(tx, agreement!, { status: input.status, proposedMethod: null, proposedBy: null, proposedLabel: null });
    return { orderId: row.orderId, status: row.status, version: row.version };
  });
}

// ── The deal card ─────────────────────────────────────────────────────────────────────────────

/**
 * The deal card, built for one party from server state only. Payment instructions appear only
 * to the buyer and seller of this order, only after a method is agreed and the seller shared them
 * (explicitly, or by a CONFIRMED_BUYERS policy), and never on a cancelled or closed order.
 */
export async function dealCard(input: { actorId: string; orderId: string; market: MarketRef }) {
  return db.transaction(async (tx) => {
    const { order, role } = await lockOrder(tx, input.orderId, input.actorId, input.market.id);
    let agreement = await lockAgreement(tx, order);
    const scale = order.minorUnitScale;
    const money = (minor: number) => (minor / 10 ** scale).toFixed(scale);
    const country = await resolveCountry(order.countryCode, tx);
    const offerable = offerableMethods(country, order.currencyCode);
    const cod = await codAvailability(tx, order);
    const [fulfilment] = await tx.select().from(orderFulfillments).where(eq(orderFulfillments.orderId, order.id));
    const [buyer] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, order.buyerId));
    const orderClosed = !OPEN_ORDER.has(order.status);

    // Policy share: the seller chose in advance to show instructions to buyers once agreed.
    let instructions = agreement.instructionsShared;
    if (!instructions && agreement.agreedMethod && (AGREED.has(agreement.status) || agreement.status === "BUYER_REPORTED_PAID")) {
      const [profile] = await tx
        .select()
        .from(sellerPaymentMethods)
        .where(and(eq(sellerPaymentMethods.sellerId, order.sellerId), eq(sellerPaymentMethods.marketId, order.marketId), eq(sellerPaymentMethods.methodCode, agreement.agreedMethod)));
      if (profile?.sharePolicy === "CONFIRMED_BUYERS" && Object.keys(profile.instructions ?? {}).length) {
        await record(tx, agreement, { id: null, role: "SYSTEM" }, "INSTRUCTIONS_SHARED", agreement.status, { method: agreement.agreedMethod, basis: "SELLER_POLICY_CONFIRMED_BUYERS", fields: Object.keys(profile.instructions) });
        agreement = await update(tx, agreement, { instructionsShared: profile.instructions, instructionsSharedAt: new Date() });
        instructions = agreement.instructionsShared;
      }
    }
    const showInstructions = !orderClosed && agreement.status !== "CANCELLED" && Boolean(instructions) && agreement.agreedMethod !== null;
    const status = orderClosed && !SETTLED.has(agreement.status) ? "CANCELLED" : agreement.status === "SELLER_CONFIRMED_RECEIPT" || agreement.status === "COD_COLLECTED" ? (order.status === "COMPLETED" ? "COMPLETED" : agreement.status) : agreement.status;
    const items = (Array.isArray(order.data?.items) ? order.data.items : []) as { listingTitle?: string; quantity?: number; unitPrice?: string; total?: string; imageUrl?: string }[];
    const events = await tx
      .select({ event: dealPaymentEvents.event, actorRole: dealPaymentEvents.actorRole, toStatus: dealPaymentEvents.toStatus, createdAt: dealPaymentEvents.createdAt })
      .from(dealPaymentEvents)
      .where(eq(dealPaymentEvents.agreementId, agreement.id))
      .orderBy(asc(dealPaymentEvents.createdAt));
    const profiles = await tx
      .select({ code: sellerPaymentMethods.methodCode, label: sellerPaymentMethods.customLabel, instructions: sellerPaymentMethods.instructions })
      .from(sellerPaymentMethods)
      .where(and(eq(sellerPaymentMethods.sellerId, order.sellerId), eq(sellerPaymentMethods.marketId, order.marketId)));
    const profileOf = (code: string) => profiles.find((p: { code: string }) => p.code === code) as { label: string | null; instructions: Record<string, string> } | undefined;
    const acceptedView = agreement.acceptedMethods.map((code) => ({
      code,
      label: methodLabel(code, profileOf(code)?.label),
      kind: METHODS[code]?.kind ?? "DIRECT",
      ...standingView(country, code, order.currencyCode),
      available: METHODS[code]?.kind === "COD" ? cod.available : negotiable(methodStanding(country, code, order.currencyCode)),
      ...(METHODS[code]?.kind === "COD" && !cod.available ? { reason: cod.reason } : {}),
    }));
    const agreedDefinition = agreement.agreedMethod ? definitionFor(agreement.agreedMethod, agreement.agreedLabel) : null;
    const agreed = agreement.agreedMethod
      ? { code: agreement.agreedMethod, label: methodLabel(agreement.agreedMethod, agreement.agreedLabel), kind: agreedDefinition?.kind ?? "DIRECT", ...standingView(country, agreement.agreedMethod, order.currencyCode), requiresMerchantCheckout: Boolean(agreedDefinition?.requiresMerchantCheckout) }
      : null;
    const needsInstructions = Boolean(agreed && agreed.kind === "DIRECT" && agreement.agreedMethod !== "CASH_IN_PERSON");
    const storedForAgreed = agreement.agreedMethod ? Object.keys(profileOf(agreement.agreedMethod)?.instructions ?? {}).length > 0 : false;
    const instructionsState = !needsInstructions || orderClosed || agreement.status === "CANCELLED"
      ? "NOT_APPLICABLE"
      : showInstructions
        ? "SHARED"
        : storedForAgreed
          ? "NOT_SHARED_YET"
          : "SELLER_TO_PROVIDE";
    const sellerApproved = agreed !== null || agreement.proposedBy === "SELLER";
    const buyerApproved = agreed !== null || agreement.proposedBy === "BUYER";
    return {
      kind: "DEAL_CARD" as const,
      orderId: order.id,
      orderReference: order.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
      viewerRole: role,
      version: agreement.version,
      status,
      statusLabel: STATUS_LABELS_AR[status] ?? status,
      countryCode: order.countryCode,
      countryName: country?.nameAr ?? order.countryCode,
      currency: order.currencyCode,
      title: String(order.data?.listingTitle ?? items[0]?.listingTitle ?? ""),
      imageUrl: typeof order.data?.imageUrl === "string" ? order.data.imageUrl : null,
      sellerName: String(order.data?.sellerName ?? ""),
      // The buyer's display name is shown to the seller of this order only.
      buyerName: role === "SELLER" ? buyer?.name ?? null : null,
      items: items.map((item) => ({ title: item.listingTitle ?? "", quantity: item.quantity ?? 0, unitPrice: item.unitPrice ?? null, total: item.total ?? null })),
      quantity: order.quantity,
      subtotal: money(order.subtotalMinor),
      delivery: fulfilment ? { method: fulfilment.method, status: fulfilment.status } : null,
      deliveryFee: null as string | null,
      total: money(order.subtotalMinor),
      orderStatus: order.status,
      acceptedMethods: acceptedView,
      proposal: agreement.proposedMethod ? { code: agreement.proposedMethod, label: methodLabel(agreement.proposedMethod, agreement.proposedLabel), by: agreement.proposedBy, awaiting: agreement.proposedBy === "BUYER" ? "SELLER" : "BUYER" } : null,
      agreedMethod: agreed,
      approvals: { seller: sellerApproved, buyer: buyerApproved },
      // Payment details never travel in the card (or the chat history): the buyer and seller of this
      // order open them from the protected endpoint, which re-checks every rule on each read.
      instructions: null,
      instructionsAvailable: showInstructions,
      instructionsState,
      instructionFields: role === "SELLER" && needsInstructions ? agreedDefinition?.instructionFields ?? [] : [],
      checkout: { integrated: false, note: agreed?.requiresMerchantCheckout ? "رابط دفع من نظام البائع نفسه، ليس بوابة متكاملة مع جاسم." : null },
      cod: agreed?.kind === "COD" ? { amountDue: money(order.subtotalMinor), currency: order.currencyCode, collected: agreement.status === "COD_COLLECTED" } : null,
      payment: {
        state: status,
        verification:
          agreement.status === "BUYER_REPORTED_PAID" ? "UNVERIFIED_BUYER_CLAIM" : agreement.status === "SELLER_CONFIRMED_RECEIPT" || agreement.status === "COD_COLLECTED" ? "SELLER_ATTESTED" : "NONE",
        platformVerified: false,
      },
      // Commission is shown to the seller only, from the order's immutable snapshot. «Due» is never «collected».
      commission: role === "SELLER" ? commissionView(order) : null,
      sellerClassification: classificationOf(order),
      actions: actionsFor(role, status, agreement, orderClosed),
      history: events.map((e: any) => ({ event: e.event, by: e.actorRole, status: e.toStatus, at: e.createdAt.toISOString() })),
      notice: "جاسم ينظم الاتفاق فقط. يتم الدفع مباشرة للبائع أو نقدًا عند الاستلام، ولا يستلم جاسم الأموال ولا يتحقق من التحويلات.",
    };
  });
}

const RULE_NOTES: Record<string, string> = {
  PERSONAL_SALE_NO_COMMISSION: "بيع مقتنيات شخصية: لا عمولة.",
  CONNECT_AGREEMENT_APPLIES: "شريك Jassim Connect: لا عمولة سوق؛ تطبق اتفاقية Connect (حصة من الربح المباشر).",
  UNDER_REVIEW_NO_AUTOMATIC_COMMISSION: "التصنيف قيد المراجعة: لا عمولة تلقائية على هذا الطلب.",
  MARKETPLACE_POLICY_RATE: "نشاط تجاري: عمولة السوق مستحقة عند اكتمال البيع وفق السياسة، وليست محصّلة.",
};
function classificationOf(order: Order) {
  const c = (order.data?.sellerClassification ?? null) as { classification?: string } | null;
  return c?.classification ? { classification: c.classification } : null;
}
function commissionView(order: Order) {
  const scale = order.minorUnitScale;
  const snapshot = (order.data?.commissionPolicy ?? {}) as { rateBasisPoints?: number; sellerClassification?: { rule?: string } };
  const rule = snapshot.sellerClassification?.rule ?? "MARKETPLACE_POLICY_RATE";
  return {
    rateBasisPoints: snapshot.rateBasisPoints ?? null,
    amount: (order.platformFeeMinor / 10 ** scale).toFixed(scale),
    sellerNetBeforeOtherCosts: (order.sellerAmountMinor / 10 ** scale).toFixed(scale),
    state: order.platformFeeMinor === 0 ? "NONE" : order.status === "COMPLETED" ? "RECORDED_AS_DUE" : "DUE_ON_COMPLETION",
    collected: false,
    rule,
    note: RULE_NOTES[rule] ?? "",
  };
}

function standingView(country: ResolvedCountry | null, code: string, currency: string) {
  const standing = methodStanding(country, code, currency);
  return { standing, standingLabel: STANDING_LABELS_AR[standing] };
}

/**
 * The protected payment details for this order: only its buyer or seller, only after a method is
 * agreed and the seller shared them, never on a cancelled or closed order. Every buyer view is
 * recorded; the values themselves never enter the event log or the chat history.
 */
export async function dealInstructions(input: { actorId: string; orderId: string; market: MarketRef }) {
  return db.transaction(async (tx) => {
    const { order, role } = await lockOrder(tx, input.orderId, input.actorId, input.market.id);
    const [agreement] = await tx.select().from(dealPaymentAgreements).where(eq(dealPaymentAgreements.orderId, order.id)).for("update");
    if (!agreement || !agreement.instructionsShared || !agreement.agreedMethod || !OPEN_ORDER.has(order.status) || agreement.status === "CANCELLED" || !(AGREED.has(agreement.status) || agreement.status === "BUYER_REPORTED_PAID" || agreement.status === "DISPUTED"))
      reject(404, "INSTRUCTIONS_NOT_AVAILABLE", "لا توجد تعليمات دفع متاحة لك في هذا الطلب.");
    if (role === "BUYER") await record(tx, agreement!, { id: input.actorId, role }, "INSTRUCTIONS_VIEWED", agreement!.status, { method: agreement!.agreedMethod });
    const definition = definitionFor(agreement!.agreedMethod!, agreement!.agreedLabel);
    return {
      orderId: order.id,
      method: { code: agreement!.agreedMethod, label: methodLabel(agreement!.agreedMethod!, agreement!.agreedLabel) },
      instructions: agreement!.instructionsShared,
      merchantCheckoutLink: definition?.requiresMerchantCheckout ? agreement!.instructionsShared!.paymentLink ?? null : null,
      notice: "حوّل المبلغ بنفسك من تطبيق بنكك أو محفظتك. جاسم لا ينفذ التحويل ولا يتحقق من وصوله، ولا يطلب منك رمز تحقق أو كلمة مرور.",
    };
  });
}

function actionsFor(role: Role, status: string, agreement: Agreement, orderClosed: boolean): string[] {
  if (orderClosed || status === "CANCELLED" || status === "COMPLETED") return [];
  const out: string[] = [];
  if (NEGOTIATING.has(status) || AGREED.has(status)) out.push("CHOOSE");
  if (status === "PAYMENT_METHOD_PROPOSED" && agreement.proposedBy !== role) out.push("ACCEPT_PROPOSAL", "REJECT_PROPOSAL");
  if (role === "SELLER" && (AGREED.has(status) || status === "BUYER_REPORTED_PAID") && agreement.agreedMethod && agreement.agreedMethod !== "CASH_IN_PERSON" && (definitionFor(agreement.agreedMethod, agreement.agreedLabel)?.kind ?? "DIRECT") === "DIRECT") {
    if (!agreement.instructionsShared) out.push("SHARE_INSTRUCTIONS");
    out.push("PROVIDE_INSTRUCTIONS");
  }
  if (role === "BUYER" && status === "AWAITING_PAYMENT") out.push("REPORT_PAID");
  if (role === "SELLER" && (status === "AWAITING_PAYMENT" || status === "BUYER_REPORTED_PAID" || status === "DISPUTED")) out.push("CONFIRM_RECEIPT");
  if (role === "SELLER" && status === "BUYER_REPORTED_PAID") out.push("REPORT_NOT_RECEIVED");
  if (role === "SELLER" && status === "COD_PENDING_DELIVERY") out.push("COD_COLLECTED");
  if (!SETTLED.has(status)) out.push("CANCEL");
  return out;
}
