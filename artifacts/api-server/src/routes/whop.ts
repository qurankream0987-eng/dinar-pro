import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { whopConfig } from "../lib/whop/config";
import {
  createOnboardingLink,
  createPayoutsPortalLink,
  ensureSellerAccount,
  sellerAccountFor,
  syncSellerAccount,
} from "../lib/whop/accounts";
import {
  checkoutIsEnabled,
  createWhopCheckout,
  whopCheckoutForOrder,
} from "../lib/whop/checkout";
import { listWhopRefunds, refundWhopPayment } from "../lib/whop/refunds";

const router = Router();

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "هذه الصفحة متاحة لإدارة السوق فقط" });
    return;
  }
  next();
};

const OnboardingBody = z
  .object({
    email: z.string().trim().min(3).max(320),
    title: z.string().trim().min(2).max(120),
    countryCode: z.string().trim().length(2).optional(),
  })
  .strict();

const CheckoutBody = z.object({ orderId: z.string().min(1).max(180) }).strict();

const RefundBody = z
  .object({
    orderId: z.string().min(1).max(180),
    amountUsdMinor: z.number().int().positive().max(100_000_000).optional(),
    reason: z.string().trim().max(500).default(""),
  })
  .strict();

function baseOrigin(req: Parameters<RequestHandler>[0]) {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured && /^https?:\/\//.test(configured)) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

function readIdempotencyKey(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
) {
  const value = req.get("Idempotency-Key");
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    res.status(400).json({ error: "Idempotency-Key مطلوب" });
    return undefined;
  }
  return value;
}

router.get("/whop/status", requireAuth, (req, res) => {
  const config = whopConfig();
  res.json({
    enabled: config.enabled,
    configured: config.configured,
    environment: config.enabled ? config.environment : null,
    ...(req.actor?.role === "ADMIN" ? { problems: config.problems } : {}),
  });
});

router.get("/whop/seller/account", requireAuth, async (req, res) => {
  if (!checkoutIsEnabled())
    return void res.json({ enabled: false, account: null });
  res.json({
    enabled: true,
    environment: whopConfig().environment,
    account: await sellerAccountFor(req.actor!.id),
  });
});

router.post("/whop/seller/onboarding", requireAuth, async (req, res) => {
  const body = OnboardingBody.parse(req.body);
  const account = await ensureSellerAccount({
    sellerUserId: req.actor!.id,
    email: body.email,
    title: body.title,
    countryCode: body.countryCode ?? req.actor!.accountCountry,
  });
  const origin = baseOrigin(req);
  const link = await createOnboardingLink({
    sellerUserId: req.actor!.id,
    returnUrl: `${origin}/seller/payouts?whop=return`,
    refreshUrl: `${origin}/seller/payouts?whop=refresh`,
  });
  res.status(201).json({ account: link.account ?? account, url: link.url });
});

router.post("/whop/seller/refresh", requireAuth, async (req, res) => {
  res.json({ account: await syncSellerAccount(req.actor!.id) });
});

router.post("/whop/seller/payouts-link", requireAuth, async (req, res) => {
  const origin = baseOrigin(req);
  const link = await createPayoutsPortalLink({
    sellerUserId: req.actor!.id,
    returnUrl: `${origin}/seller/payouts?whop=return`,
    refreshUrl: `${origin}/seller/payouts?whop=refresh`,
  });
  res.json({ url: link.url, account: link.account });
});

router.post("/whop/checkout", requireAuth, async (req, res) => {
  const body = CheckoutBody.parse(req.body);
  const checkout = await createWhopCheckout({
    orderId: body.orderId,
    buyerUserId: req.actor!.id,
    redirectUrl: `${baseOrigin(req)}/orders/${encodeURIComponent(body.orderId)}?whop=return`,
  });
  res.status(201).json(checkout);
});

router.get("/whop/orders/:id/payment", requireAuth, async (req, res) => {
  if (!checkoutIsEnabled())
    return void res.json({ enabled: false, payment: null });
  const payment = await whopCheckoutForOrder(String(req.params.id), req.actor!.id);
  if (!payment) return void res.status(404).json({ error: "الطلب غير موجود" });
  res.json({
    enabled: true,
    environment: whopConfig().environment,
    payment,
  });
});

router.post("/whop/admin/refunds", requireAuth, requireAdmin, async (req, res) => {
  const idempotencyKey = readIdempotencyKey(req, res);
  if (!idempotencyKey) return;
  const body = RefundBody.parse(req.body);
  const result = await refundWhopPayment({
    orderId: body.orderId,
    adminId: req.actor!.id,
    idempotencyKey,
    amountUsdMinor: body.amountUsdMinor,
    reason: body.reason,
  });
  res.status(result.duplicate ? 200 : 201).json(result);
});

router.get("/whop/admin/refunds", requireAuth, requireAdmin, async (req, res) => {
  const orderId =
    typeof req.query.orderId === "string"
      ? req.query.orderId.slice(0, 180)
      : undefined;
  res.json({ refunds: await listWhopRefunds(orderId) });
});

export default router;
