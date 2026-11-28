/**
 * Payment Preferences & Agreement. Buyer and seller agree how they settle; JassimAI never receives
 * or holds the money. Every read and write is scoped to the order's two parties (404 otherwise);
 * catalog changes and status corrections are admin-only and always carry a reason.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import { COUNTRY_SEED, resolveCountry } from "../lib/deal-payments/catalog";
import { recordCatalogChange } from "../lib/deal-payments/admin";
import { dealPaymentsEnabled } from "../lib/deal-payments/flag";
import { adminSetDealStatus, applyDealAction, dealCard, sellerMethodsView, setSellerMethods } from "../lib/deal-payments/service";

const router = Router();
const id = (value: unknown) => String(value).slice(0, 80);

const enabled: RequestHandler = (_req, res, next) => {
  if (!dealPaymentsEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};
const noStore: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "private, no-store, no-cache, max-age=0");
  res.set("Pragma", "no-cache");
  next();
};
const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "للإدارة فقط" });
    return;
  }
  next();
};

const instructionText = z.string().max(120);
const SellerMethod = z
  .object({
    code: z.string().min(2).max(40),
    customLabel: z.string().max(60).nullish(),
    instructions: z
      .object({ beneficiaryName: instructionText, alias: instructionText, phone: instructionText, iban: instructionText, accountNumber: instructionText, bankName: instructionText, walletNumber: instructionText, note: instructionText })
      .partial()
      .strict()
      .optional(),
    sharePolicy: z.enum(["ON_REQUEST", "CONFIRMED_BUYERS"]).optional(),
    codAreas: z.array(z.string().max(60)).max(50).optional(),
    paused: z.boolean().optional(),
  })
  .strict();

router.get("/deal-payments/countries", enabled, async (_req, res) => {
  const countries = await Promise.all(COUNTRY_SEED.map((c) => resolveCountry(c.countryCode)));
  res.json({
    countries: countries.filter(Boolean).map((c) => ({
      countryCode: c!.countryCode,
      nameAr: c!.nameAr,
      currencyCode: c!.currencyCode,
      languages: c!.languages,
      status: c!.status,
      methods: c!.methods.map((m) => ({ code: m.code, label: m.labelAr, kind: m.kind, status: m.status, source: m.source, note: m.note, currencies: m.currencies })),
    })),
  });
});

router.get("/deal-payments/seller-methods", enabled, requireAuth, noStore, async (req, res) => {
  res.json(await sellerMethodsView(req.actor!.id, await marketFor(req)));
});
router.put("/deal-payments/seller-methods", enabled, requireAuth, noStore, async (req, res) => {
  const body = z.object({ methods: z.array(SellerMethod).max(20), replace: z.boolean().optional() }).strict().parse(req.body);
  res.json(await setSellerMethods({ sellerId: req.actor!.id, market: await marketFor(req), methods: body.methods, replace: body.replace }));
});

router.get("/orders/:id/deal-card", enabled, requireAuth, noStore, async (req, res) => {
  res.json(await dealCard({ actorId: req.actor!.id, orderId: id(req.params.id), market: await marketFor(req) }));
});

const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CHOOSE"), method: z.string().min(2).max(40), customLabel: z.string().max(60).optional() }).strict(),
  z.object({ type: z.literal("RESPOND"), accept: z.boolean() }).strict(),
  z.object({ type: z.literal("SHARE_INSTRUCTIONS") }).strict(),
  z.object({ type: z.literal("REPORT_PAID"), note: z.string().max(300).optional() }).strict(),
  z.object({ type: z.literal("CONFIRM_RECEIPT") }).strict(),
  z.object({ type: z.literal("REPORT_NOT_RECEIVED"), note: z.string().max(300).optional() }).strict(),
  z.object({ type: z.literal("COD_COLLECTED") }).strict(),
  z.object({ type: z.literal("CANCEL"), reason: z.string().max(300).optional() }).strict(),
]);
router.post("/orders/:id/deal-card/actions", enabled, requireAuth, noStore, async (req, res) => {
  const body = z.object({ action: Action, expectedVersion: z.number().int().positive().optional() }).strict().parse(req.body);
  res.json(await applyDealAction({ actorId: req.actor!.id, orderId: id(req.params.id), market: await marketFor(req), action: body.action, expectedVersion: body.expectedVersion }));
});

router.post("/admin/deal-payments/catalog-changes", enabled, requireAuth, requireAdmin, async (req, res) => {
  const body = z
    .object({
      countryCode: z.string().regex(/^[A-Z]{2}$/),
      methodCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).nullable(),
      status: z.enum(["ACTIVE", "LIMITED", "UNAVAILABLE", "UNDER_REVIEW"]),
      labelAr: z.string().max(60).optional(),
      kind: z.enum(["DIRECT", "COD"]).optional(),
      currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(5).optional(),
      sourceReference: z.string().max(300).optional(),
      reason: z.string().min(3).max(500),
    })
    .strict()
    .parse(req.body);
  res.status(201).json(await recordCatalogChange({ ...body, actorId: req.actor!.id }));
});
router.post("/admin/deal-payments/orders/:id/status", enabled, requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({ status: z.enum(["CANCELLED", "DISPUTED", "COMPLETED"]), reason: z.string().min(3).max(500) }).strict().parse(req.body);
  res.json(await adminSetDealStatus({ adminId: req.actor!.id, orderId: id(req.params.id), status: body.status, reason: body.reason }));
});

export default router;
