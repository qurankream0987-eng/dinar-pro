import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, orders, users, whopCheckouts } from "@workspace/db";
import { commissionRateForOrder } from "../commission-policy";
import { whopConfig } from "./config";
import { whopClient } from "./client";
import { jodMinorToUsdMinor, selectFeePercent, usdMinorToAmount } from "./commission";
import { assertCountryAllowed } from "./countries";
import { whopRefusal } from "./errors";
import { sellerAccountFor } from "./accounts";

export type WhopCheckoutView = {
  orderId: string;
  checkoutId: string | null;
  purchaseUrl: string | null;
  status: "NONE" | "CREATED" | "SUCCEEDED" | "FAILED" | "CANCELED" | "REFUND_DUE";
  amountUsd: number | null;
  feeUsd: number | null;
  feePercent: number | null;
  currency: "USD";
  paidAt: string | null;
  environment: "sandbox" | "production";
};

function usd(minor: number) {
  return Number((minor / 100).toFixed(2));
}

function orderTotalMinor(order: typeof orders.$inferSelect) {
  if (order.currencyCode !== "JOD" || order.minorUnitScale !== 3)
    throw whopRefusal(
      409,
      "الدفع عبر Whop متاح للأسعار بالدينار فقط",
      "WHOP_CURRENCY_UNSUPPORTED",
    );
  if (!Number.isSafeInteger(order.subtotalMinor) || order.subtotalMinor <= 0)
    throw whopRefusal(409, "قيمة الطلب غير صالحة", "WHOP_AMOUNT_INVALID");
  return order.subtotalMinor;
}

/**
 * Whop applies a per-account payment markup rather than a per-order application fee.
 * The checkout is allowed only when the markup actually configured for this seller (or
 * the platform default it inherits) charges exactly the rate this order owes. Refusing on
 * a mismatch is the only way not to silently under- or over-collect the owner's commission.
 */
async function assertMarkupMatches(
  accountId: string,
  rateBasisPoints: number,
): Promise<void> {
  const config = whopConfig();
  const client = whopClient(config);
  const list = async (id: string) => {
    const response = await client.feeMarkups.list({ account_id: id, first: 50 });
    return response?.data ?? [];
  };
  const sellerMarkups = await list(accountId);
  const platformMarkups =
    config.companyId && config.companyId !== accountId
      ? await list(config.companyId)
      : [];
  const effective =
    sellerMarkups.find((markup) => markup.fee_type === "payment_markup") ??
    platformMarkups.find((markup) => markup.fee_type === "payment_markup");
  const expectedPercent = rateBasisPoints / 100;
  const percent = effective?.percentage_fee ?? 0;
  const fixed = effective?.fixed_fee_usd ?? 0;
  if (!effective || Math.abs(percent - expectedPercent) > 1e-9 || fixed !== 0)
    throw whopRefusal(
      409,
      `عمولة هذه الطلبية ${expectedPercent}%، لكن نسبة Whop المهيأة للحساب ${
        effective ? `${percent}%${fixed ? ` + $${fixed}` : ""}` : "غير مهيأة"
      }. عدّل نسبة الـ markup في Whop ثم أعد المحاولة.`,
      "WHOP_COMMISSION_NOT_CONFIGURED",
    );
}

export async function createWhopCheckout(input: {
  orderId: string;
  buyerUserId: string;
  redirectUrl: string;
}): Promise<WhopCheckoutView> {
  const config = whopConfig();
  if (!config.configured)
    throw whopRefusal(503, "لم تُهيأ بوابة الدفع بعد", "WHOP_NOT_CONFIGURED");

  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId));
  // A stranger sees the same 404 a missing order returns.
  if (!order || order.buyerId !== input.buyerUserId)
    throw whopRefusal(404, "الطلب غير موجود", "ORDER_NOT_FOUND");

  const [buyer] = await db.select().from(users).where(eq(users.id, order.buyerId));

  const [existing] = await db
    .select()
    .from(whopCheckouts)
    .where(eq(whopCheckouts.orderId, order.id));
  if (existing) {
    const [row] = await db
      .select()
      .from(whopCheckouts)
      .where(eq(whopCheckouts.id, existing.id));
    return {
      orderId: order.id,
      checkoutId: row.whopCheckoutId,
      purchaseUrl: row.purchaseUrl,
      status: row.status as WhopCheckoutView["status"],
      amountUsd: usd(row.amountUsdMinor),
      feeUsd: usd(row.feeUsdMinor),
      feePercent: row.feeBasisPoints / 100,
      currency: "USD",
      paidAt: typeof row.data?.paidAt === "string" ? row.data.paidAt : null,
      environment: config.environment,
    };
  }

  if (order.status !== "CREATED")
    throw whopRefusal(409, "لا يمكن الدفع بعد بدء تنفيذ الطلب", "ORDER_NOT_PAYABLE");
  if (order.reservationExpiresAt && order.reservationExpiresAt <= new Date())
    throw whopRefusal(409, "انتهت مهلة حجز الطلب", "ORDER_RESERVATION_EXPIRED");

  const totalJodMinor = orderTotalMinor(order);
  const totalUsdMinor = jodMinorToUsdMinor(totalJodMinor, config.usdPerJod);
  const expectedPercent = selectFeePercent(totalUsdMinor, config);
  const orderBasisPoints = commissionRateForOrder(order);
  if (orderBasisPoints !== Math.round(expectedPercent * 100))
    throw whopRefusal(
      409,
      `هذا الطلب محفوظ بعمولة ${orderBasisPoints / 100}% بينما شريحة Whop تتطلب ${expectedPercent}%. الدفع المباشر لا يستطيع تغيير العمولة حسب قيمة الطلب، فلم يُنشأ دفع.`,
      "WHOP_COMMISSION_TIER_UNAVAILABLE",
    );

  const feeUsdMinor = jodMinorToUsdMinor(order.platformFeeMinor, config.usdPerJod);
  if (feeUsdMinor <= 0 || feeUsdMinor >= totalUsdMinor)
    throw whopRefusal(409, "عمولة الطلب خارج الحدود المسموحة", "WHOP_FEE_OUT_OF_BOUNDS");

  if (buyer) assertCountryAllowed(buyer.accountCountry, config.blockedCountries);
  assertCountryAllowed(order.countryCode, config.blockedCountries);

  const seller = await sellerAccountFor(order.sellerId);
  if (!seller)
    throw whopRefusal(409, "البائع لم يسجّل حساب تحصيل بعد", "WHOP_SELLER_NOT_ONBOARDED");
  if (!seller.verified)
    throw whopRefusal(409, "لم تكتمل هوية البائع بعد", "WHOP_SELLER_NOT_VERIFIED");
  assertCountryAllowed(seller.countryCode, config.blockedCountries);

  await assertMarkupMatches(seller.whopAccountId, orderBasisPoints);

  const title =
    typeof order.data?.listingTitle === "string" && order.data.listingTitle.trim()
      ? order.data.listingTitle.trim().slice(0, 120)
      : `طلب ${order.id}`;
  const metadata = {
    dinar_order_id: order.id,
    dinar_seller_user_id: order.sellerId,
    dinar_fee_basis_points: orderBasisPoints,
  };

  const client = whopClient(config);
  const created = await client.checkoutConfigurations.create({
    account_id: seller.whopAccountId,
    mode: "payment",
    metadata,
    redirect_url: input.redirectUrl,
    variant: {
      initial_price: usdMinorToAmount(totalUsdMinor),
      billing_type: "one_time",
      currency: "usd",
      title,
      metadata,
    },
  });
  if (typeof created?.id !== "string" || !created.purchase_url)
    throw whopRefusal(502, "لم يعد مزود الدفع رابط دفع صالح", "WHOP_CHECKOUT_INVALID");

  const [row] = await db
    .insert(whopCheckouts)
    .values({
      id: randomUUID(),
      orderId: order.id,
      sellerUserId: order.sellerId,
      whopCheckoutId: created.id,
      purchaseUrl: created.purchase_url,
      redirectUrl: input.redirectUrl,
      amountUsdMinor: totalUsdMinor,
      feeUsdMinor,
      sellerUsdMinor: totalUsdMinor - feeUsdMinor,
      feeBasisPoints: orderBasisPoints,
      status: "CREATED",
      data: { environment: config.environment, title },
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    // A concurrent request won the unique order row; drop this duplicate provider checkout.
    await client.checkoutConfigurations
      .delete({ id: created.id })
      .catch(() => undefined);
    const [winner] = await db
      .select()
      .from(whopCheckouts)
      .where(eq(whopCheckouts.orderId, order.id));
    if (!winner) throw new Error("Whop checkout row disappeared after a conflicting insert");
    return {
      orderId: order.id,
      checkoutId: winner.whopCheckoutId,
      purchaseUrl: winner.purchaseUrl,
      status: winner.status as WhopCheckoutView["status"],
      amountUsd: usd(winner.amountUsdMinor),
      feeUsd: usd(winner.feeUsdMinor),
      feePercent: winner.feeBasisPoints / 100,
      currency: "USD",
      paidAt: null,
      environment: config.environment,
    };
  }

  return {
    orderId: order.id,
    checkoutId: row.whopCheckoutId,
    purchaseUrl: row.purchaseUrl,
    status: "CREATED",
    amountUsd: usd(row.amountUsdMinor),
    feeUsd: usd(row.feeUsdMinor),
    feePercent: row.feeBasisPoints / 100,
    currency: "USD",
    paidAt: null,
    environment: config.environment,
  };
}

export function checkoutIsEnabled() {
  return whopConfig().configured;
}

/** The buyer or the seller may read payment state; everyone else gets 404. */
export async function whopCheckoutForOrder(
  orderId: string,
  actorId: string,
): Promise<WhopCheckoutView | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || (order.buyerId !== actorId && order.sellerId !== actorId)) return null;
  const [row] = await db
    .select()
    .from(whopCheckouts)
    .where(eq(whopCheckouts.orderId, orderId));
  const config = whopConfig();
  if (!row)
    return {
      orderId,
      checkoutId: null,
      purchaseUrl: null,
      status: "NONE",
      amountUsd: null,
      feeUsd: null,
      feePercent: null,
      currency: "USD",
      paidAt: null,
      environment: config.environment,
    };
  return {
    orderId,
    checkoutId: row.whopCheckoutId,
    purchaseUrl: row.purchaseUrl,
    status: row.status as WhopCheckoutView["status"],
    amountUsd: usd(row.amountUsdMinor),
    feeUsd: usd(row.feeUsdMinor),
    feePercent: row.feeBasisPoints / 100,
    currency: "USD",
    paidAt: typeof row.data?.paidAt === "string" ? row.data.paidAt : null,
    environment: config.environment,
  };
}
