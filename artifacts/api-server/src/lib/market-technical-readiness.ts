import {
  db,
  marketAudit,
  marketLegalIntakes,
  marketLegalIntakeTopics,
  marketTechnicalReadiness,
  marketplaceCategories,
  markets,
} from "@workspace/db";
import { countryByCode, currencies } from "@workspace/global";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

/** The 22 Arab League markets. Technical preparation covers all of them in parallel. */
export const ARAB_MARKET_IDS = [
  "AE", "BH", "DZ", "EG", "IQ", "JO", "KM", "DJ", "KW", "LB", "LY",
  "MA", "MR", "OM", "PS", "QA", "SA", "SO", "SD", "SY", "TN", "YE",
] as const;

/** Circulating currency per Arab market, the value the readiness check compares against. */
export const ARAB_MARKET_CURRENCY: Record<string, string> = {
  AE: "AED", BH: "BHD", DZ: "DZD", EG: "EGP", IQ: "IQD", JO: "JOD", KM: "KMF", DJ: "DJF",
  KW: "KWD", LB: "LBP", LY: "LYD", MA: "MAD", MR: "MRU", OM: "OMR", PS: "ILS", QA: "QAR",
  SA: "SAR", SO: "SOS", SD: "SDG", SY: "SYP", TN: "TND", YE: "YER",
};

const KNOWN_FULFILMENT = new Set(["PICKUP", "DELIVERY", "DIGITAL", "SERVICE"]);
const LEGAL_TOPIC_COUNT = 16;

type Environment = Record<string, string | undefined>;

/**
 * Pre-legal operation: a technically READY market may run its non-regulated functions while its
 * legal file is still incomplete. Off unless the deployment sets DINAR_PRE_LEGAL_OPERATION=true,
 * so turning it on is an explicit, reversible owner decision per environment.
 */
export function preLegalOperationEnabled(env: Environment = process.env) {
  return env.DINAR_PRE_LEGAL_OPERATION?.trim().toLowerCase() === "true";
}

/**
 * Capabilities a technically READY market may use before legal approval. Platform-processed
 * (electronic) payments are deliberately absent: they always require the full legal activation.
 * CASH_PAYMENT here is the direct buyer-to-seller cash method only; the platform never holds money.
 * RESTRICTED_CATEGORIES only gates the category-policy check: the market's restricted list is
 * still enforced on every listing.
 */
export const PRE_LEGAL_CAPABILITIES = new Set([
  "INFORMATION_ONLY",
  "BROWSING",
  "LISTING_PUBLICATION",
  "TRANSACTIONS",
  "CASH_PAYMENT",
  "DELIVERY_OPERATIONS",
  "BUSINESS_ONBOARDING",
  "RESTRICTED_CATEGORIES",
]);

/** Capabilities that never run before legal approval, whatever the technical status. */
export const LEGAL_ONLY_CAPABILITIES = new Set(["ELECTRONIC_PAYMENT"]);

export async function technicalStatusFor(marketId: string, tx: any = db): Promise<string> {
  const [row] = await tx
    .select({ status: marketTechnicalReadiness.status })
    .from(marketTechnicalReadiness)
    .where(eq(marketTechnicalReadiness.marketId, marketId))
    .limit(1);
  return row?.status ?? "NOT_VERIFIED";
}

export async function preLegalCapabilityAllowed(
  marketId: string,
  capability: string,
  tx: any = db,
  env: Environment = process.env,
) {
  if (!preLegalOperationEnabled(env)) return false;
  if (!PRE_LEGAL_CAPABILITIES.has(capability) || LEGAL_ONLY_CAPABILITIES.has(capability)) return false;
  if ((await technicalStatusFor(marketId, tx)) !== "READY") return false;
  // A suspended market stays closed: suspension is a legal decision, not a missing document.
  const [intake] = await tx
    .select({ activationStatus: marketLegalIntakes.activationStatus })
    .from(marketLegalIntakes)
    .where(eq(marketLegalIntakes.marketId, marketId))
    .limit(1);
  return intake?.activationStatus !== "SUSPENDED";
}

export type ReadinessCheck = { key: string; passed: boolean; detail: string };

/** Runs the automated technical checks for one market. Pure read; writes nothing. */
export async function evaluateMarketTechnicalReadiness(marketId: string, tx: any = db) {
  const checks: ReadinessCheck[] = [];
  const add = (key: string, passed: boolean, detail: string) => checks.push({ key, passed, detail });
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).limit(1);
  if (!market) {
    add("MARKET_ROW", false, "السوق غير موجود في قاعدة البيانات");
    return { marketId, status: "NOT_READY" as const, checks };
  }
  const country = countryByCode.get(market.countryCode);
  add("COUNTRY_SELECTABLE", !!country?.isSelectable, country ? "الدولة متاحة للتسجيل" : "الدولة غير معروفة");
  add("CALLING_CODE", !!country?.callingCode, country?.callingCode ? `رمز الاتصال ${country.callingCode}` : "لا يوجد رمز اتصال");
  const expected = ARAB_MARKET_CURRENCY[marketId] ?? country?.defaultCurrencyCode ?? null;
  const meta = (currencies as Record<string, { minorUnitScale: number } | undefined>)[market.currencyCode];
  add("CURRENCY", !!meta && market.currencyCode === expected, `العملة ${market.currencyCode}${expected && market.currencyCode !== expected ? `، المتوقع ${expected}` : ""}`);
  add("MINOR_UNIT_SCALE", !!meta && meta.minorUnitScale === market.minorUnitScale, `خانات الكسور ${market.minorUnitScale}${meta ? ` (المعيار ${meta.minorUnitScale})` : ""}`);
  add("CURRENCY_SYMBOL", !!market.currencySymbolAr?.trim(), `الرمز ${market.currencySymbolAr || "—"}`);
  const fulfilment = Array.isArray(market.fulfilmentMethods) ? market.fulfilmentMethods : [];
  add("FULFILMENT", fulfilment.length > 0 && fulfilment.every((m: string) => KNOWN_FULFILMENT.has(m)), `طرق التنفيذ: ${fulfilment.join("، ") || "لا شيء"}`);
  const payment = Array.isArray(market.paymentMethods) ? market.paymentMethods : [];
  add("CASH_DIRECT", payment.includes("CASH_DIRECT"), payment.includes("CASH_DIRECT") ? "الدفع النقدي المباشر بين الطرفين متاح" : "لا توجد طريقة دفع مباشر");
  const [category] = await tx
    .select({ id: marketplaceCategories.id })
    .from(marketplaceCategories)
    .where(eq(marketplaceCategories.isActive, true))
    .limit(1);
  add("CATALOG", !!category, category ? "كتالوج التصنيفات متاح" : "لا توجد تصنيفات مفعّلة");
  const [intake] = await tx.select().from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, marketId)).limit(1);
  let topics = 0;
  if (intake) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(marketLegalIntakeTopics)
      .where(eq(marketLegalIntakeTopics.intakeId, intake.id));
    topics = Number(row?.n ?? 0);
  }
  add("LEGAL_FILE_PRESENT", !!intake && topics === LEGAL_TOPIC_COUNT, intake ? `ملف قانوني جاهز لاستقبال المستندات (${topics}/${LEGAL_TOPIC_COUNT} موضوعًا)` : "لا يوجد ملف قانوني");
  add("NOT_SUSPENDED", intake?.activationStatus !== "SUSPENDED", intake?.activationStatus === "SUSPENDED" ? "السوق موقوف بقرار قانوني" : "السوق غير موقوف");
  return { marketId, status: checks.every((c) => c.passed) ? ("READY" as const) : ("NOT_READY" as const), checks };
}

/** Records the result of the technical checks. Never touches legal intake, approvals or markets.status. */
export async function verifyMarketTechnicalReadiness(marketIds: readonly string[], actorId: string) {
  return db.transaction(async (tx) => {
    const results = [];
    for (const marketId of marketIds) {
      const result = await evaluateMarketTechnicalReadiness(marketId, tx);
      const [exists] = await tx.select({ id: markets.id }).from(markets).where(eq(markets.id, marketId)).limit(1);
      if (!exists) {
        results.push(result);
        continue;
      }
      const now = new Date();
      await tx
        .insert(marketTechnicalReadiness)
        .values({ marketId, status: result.status, checks: result.checks, verifiedBy: actorId, verifiedAt: now })
        .onConflictDoUpdate({
          target: marketTechnicalReadiness.marketId,
          set: { status: result.status, checks: result.checks, verifiedBy: actorId, verifiedAt: now, updatedAt: now },
        });
      await tx.insert(marketAudit).values({
        id: randomUUID(),
        marketId,
        actorId,
        action: "TECHNICAL_READINESS",
        data: { status: result.status, failed: result.checks.filter((c) => !c.passed).map((c) => c.key) },
      });
      results.push(result);
    }
    return results;
  });
}

/**
 * One row per Arab market: technical status and legal status side by side, never merged.
 * `legalStatus` is APPROVED only when the existing legal flow fully activated the country.
 */
export async function arabMarketsReadinessReport(env: Environment = process.env) {
  const ids = [...ARAB_MARKET_IDS];
  const [rows, tech, intakes] = await Promise.all([
    db.select().from(markets).where(inArray(markets.id, ids)),
    db.select().from(marketTechnicalReadiness).where(inArray(marketTechnicalReadiness.marketId, ids)),
    db.select().from(marketLegalIntakes).where(inArray(marketLegalIntakes.marketId, ids)),
  ]);
  const topicRows = intakes.length
    ? await db
        .select({ intakeId: marketLegalIntakeTopics.intakeId, reviewStatus: marketLegalIntakeTopics.reviewStatus })
        .from(marketLegalIntakeTopics)
        .where(inArray(marketLegalIntakeTopics.intakeId, intakes.map((i) => i.id)))
    : [];
  const preLegal = preLegalOperationEnabled(env);
  return ids.map((id) => {
    const market = rows.find((r) => r.id === id);
    const t = tech.find((r) => r.marketId === id);
    const intake = intakes.find((r) => r.marketId === id);
    const topics = intake ? topicRows.filter((r) => r.intakeId === intake.id) : [];
    const legalApproved =
      intake?.activationStatus === "ACTIVE" &&
      intake.counselApprovalStatus === "APPROVED" &&
      intake.ownerApprovalStatus === "APPROVED" &&
      intake.technicalVerificationStatus === "PASSED";
    const technicalStatus = t?.status ?? "NOT_VERIFIED";
    const remaining: string[] = [];
    if (technicalStatus !== "READY") remaining.push("تشغيل الفحص التقني وإصلاح ما يفشل");
    if (!legalApproved) {
      const reviewed = topics.filter((r) => r.reviewStatus === "COUNSEL_REVIEWED").length;
      remaining.push(`المستندات القانونية: ${reviewed}/${LEGAL_TOPIC_COUNT} موضوعًا مراجَعًا`);
      remaining.push("مراجعة المستشار وموافقته، موافقة المالك، التحقق الفني القانوني، ثم التفعيل");
      remaining.push("المدفوعات الإلكترونية تبقى مغلقة حتى الاعتماد القانوني");
    }
    return {
      marketId: id,
      countryNameAr: market?.countryNameAr ?? id,
      currencyCode: market?.currencyCode ?? null,
      technicalStatus,
      technicalChecks: t?.checks ?? [],
      technicalVerifiedAt: t?.verifiedAt ?? null,
      legalStatus: legalApproved ? "APPROVED" : intake?.activationStatus === "SUSPENDED" ? "SUSPENDED" : "PENDING",
      legalTopicsReviewed: topics.filter((r) => r.reviewStatus === "COUNSEL_REVIEWED").length,
      legalTopicsTotal: LEGAL_TOPIC_COUNT,
      operationMode: legalApproved
        ? "FULL"
        : preLegal && technicalStatus === "READY" && intake?.activationStatus !== "SUSPENDED"
          ? "PRE_LEGAL"
          : "CLOSED",
      remaining,
    };
  });
}

