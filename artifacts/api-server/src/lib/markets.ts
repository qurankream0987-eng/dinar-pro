import { db, markets, marketPriceVersions, sellerMarketEligibility } from '@workspace/db';
import { countryByCode, DEFAULT_MARKET } from '@workspace/global';
import { and, eq, lte, gt, isNull, or, desc } from 'drizzle-orm';
import { marketAllowsFulfilment } from './market-capability-registry';
import { assertMinorProtection, assertSellerVerification, requireCommercialCapability } from './compliance';
import { assertMarketLegalCapability } from './d16-readiness';
import { marketTechnicalReadiness, marketLegalIntakes } from '@workspace/db';
import { preLegalOperationEnabled } from './market-technical-readiness';
export const marketError = (status: number, message: string) => Object.assign(new Error(message), { status });
export const GUEST_MARKET_COOKIE = 'bdinar_guest_market';
export async function resolveMarket(row: typeof markets.$inferSelect, tx: any = db) {
  const now = new Date();
  const [price] = await tx.select().from(marketPriceVersions).where(and(eq(marketPriceVersions.marketId, row.id), lte(marketPriceVersions.effectiveFrom, now), or(isNull(marketPriceVersions.effectiveTo), gt(marketPriceVersions.effectiveTo, now)))).orderBy(desc(marketPriceVersions.effectiveFrom)).limit(1);
  const [tech] = await tx.select({ status: marketTechnicalReadiness.status }).from(marketTechnicalReadiness).where(eq(marketTechnicalReadiness.marketId, row.id)).limit(1);
  const [intake] = await tx.select(intakeColumns).from(marketLegalIntakes).where(eq(marketLegalIntakes.marketId, row.id)).limit(1);
  return marketView(row, price, tech?.status, intake);
}
const intakeColumns = {
  marketId: marketLegalIntakes.marketId,
  activationStatus: marketLegalIntakes.activationStatus,
  counselApprovalStatus: marketLegalIntakes.counselApprovalStatus,
  ownerApprovalStatus: marketLegalIntakes.ownerApprovalStatus,
  technicalVerificationStatus: marketLegalIntakes.technicalVerificationStatus,
};
type IntakeState = { activationStatus: string; counselApprovalStatus: string; ownerApprovalStatus: string; technicalVerificationStatus: string };
function marketView(row: typeof markets.$inferSelect, price?: typeof marketPriceVersions.$inferSelect, technicalStatus = 'NOT_VERIFIED', intake?: IntakeState) {
  const country = countryByCode.get(row.countryCode);
  // Legal approval comes only from the country's legal file, never from markets.status.
  const legalApproved = intake?.activationStatus === 'ACTIVE' && intake.counselApprovalStatus === 'APPROVED' && intake.ownerApprovalStatus === 'APPROVED' && intake.technicalVerificationStatus === 'PASSED';
  const suspended = intake?.activationStatus === 'SUSPENDED';
  const legacyOpen = row.isActive && ['ACTIVE', 'LIMITED'].includes(row.status);
  const preLegal = !suspended && preLegalOperationEnabled() && technicalStatus === 'READY';
  const operationMode = legacyOpen && legalApproved ? 'FULL' : preLegal ? 'PRE_LEGAL' : legacyOpen ? 'LEGAL_GATED' : 'CLOSED';
  const legalApprovalStatus = legalApproved ? 'APPROVED' : suspended ? 'SUSPENDED' : 'PENDING';
  return { ...row, technicalStatus, operationMode, legalApprovalStatus, marketOpen: legacyOpen || preLegal, countryNameAr: country?.countryNameAr ?? row.countryNameAr, countryNameEn: country?.countryNameEn ?? row.countryNameEn,
    callingCode: country?.callingCode, currencyCode: price?.currencyCode ?? row.currencyCode,
    unitPriceMinor: price?.unitPriceMinor ?? row.unitPriceMinor ?? 0, minorUnitScale: price?.minorUnitScale ?? row.minorUnitScale,
    priceConfigured: !!price || row.unitPriceMinor !== null, priceVersionId: price?.id ?? null,
    effectiveFrom: price?.effectiveFrom ?? null, effectiveTo: price?.effectiveTo ?? null };
}
export async function allMarkets() {
  const now = new Date();
  const [rows, prices, tech, intakes] = await Promise.all([db.select().from(markets), db.select().from(marketPriceVersions).where(and(lte(marketPriceVersions.effectiveFrom, now), or(isNull(marketPriceVersions.effectiveTo), gt(marketPriceVersions.effectiveTo, now)))), db.select({ marketId: marketTechnicalReadiness.marketId, status: marketTechnicalReadiness.status }).from(marketTechnicalReadiness), db.select(intakeColumns).from(marketLegalIntakes)]);
  const byId = new Map(prices.map(price => [price.marketId, price]));
  const techById = new Map(tech.map(t => [t.marketId, t.status]));
  const intakeById = new Map(intakes.map(i => [i.marketId, i]));
  return rows.map(row => marketView(row, byId.get(row.id), techById.get(row.id), intakeById.get(row.id)));
}
/**
 * Guest default market. Staging only: guests start in the owner-approved JO test market so the
 * assistant works without a manual market choice. Production and development keep DEFAULT_MARKET.
 */
export function guestDefaultMarket(env: NodeJS.ProcessEnv = process.env) {
  return env.DINAR_DEPLOYMENT_ENV === 'staging' ? 'JO' : DEFAULT_MARKET;
}
export async function marketFor(req: any, tx: any = db, lock = false) {
  const guestDefault = guestDefaultMarket();
  const cookieMarketId = req.cookies?.[GUEST_MARKET_COOKIE];
  const requestedMarketId = req.actor?.activeMarketId ??
    (typeof cookieMarketId === 'string' && cookieMarketId.length <= 32
      ? cookieMarketId
      : guestDefault);
  const findMarket = async (id: string) => {
    let query = tx.select().from(markets).where(eq(markets.id, id));
    if (lock) query = query.for('share');
    const [row] = await query;
    return row;
  };
  let row = await findMarket(requestedMarketId);
  // An invalid or stale guest cookie is not a valid selection. Keep the existing
  // configured default behavior; a valid but closed market remains selected.
  if (!row && !req.actor && requestedMarketId !== guestDefault)
    row = await findMarket(guestDefault);
  if (!row && !req.actor && guestDefault !== DEFAULT_MARKET)
    row = await findMarket(DEFAULT_MARKET);
  if (!row) throw marketError(400, 'السوق غير موجود');
  return resolveMarket(row, tx);
}
/**
 * Commerce availability is the market's own activation decision. A historical market unit
 * price (a pre-flexible-pricing artifact) is never the reason commerce is enabled or denied;
 * listing prices are per-listing and evaluated at checkout.
 */
export function isMarketAvailable(market: Awaited<ReturnType<typeof marketFor>>) {
  return (market.isActive && ['ACTIVE', 'LIMITED'].includes(market.status)) || market.operationMode === 'PRE_LEGAL';
}
export function assertMarketActive(market: Awaited<ReturnType<typeof marketFor>>) {
  if (!isMarketAvailable(market))
    throw marketError(409, 'جاسم لم يبدأ استقبال العروض والطلبات في هذا السوق بعد.');
}
export async function assertMarketPolicy(market: Awaited<ReturnType<typeof marketFor>>, sellerId: string, category: string, fulfilment: string, tx: any = db, categoryId?: string) {
  assertMarketActive(market);
  await assertMarketLegalCapability(market.id, "LISTING_PUBLICATION", tx);
  await assertMarketLegalCapability(market.id, "RESTRICTED_CATEGORIES", tx);
  if (market.restrictedCategories.includes(category) || (categoryId && market.restrictedCategories.includes(categoryId))) throw marketError(409, 'هذا التصنيف غير متاح في السوق الحالي');
  if (!marketAllowsFulfilment(market, fulfilment)) throw marketError(409, 'طريقة التنفيذ غير متاحة في هذا السوق');
  if (market.sellerEligibilityMode === 'APPROVAL_REQUIRED') {
    const [eligibility] = await tx.select().from(sellerMarketEligibility).where(and(eq(sellerMarketEligibility.userId, sellerId), eq(sellerMarketEligibility.marketId, market.id), eq(sellerMarketEligibility.approved, true)));
    if (!eligibility) throw marketError(403, 'النشر واستقبال الطلبات في هذا السوق يتطلب موافقة على أهلية البائع');
  }
  // Wave 09 gates: each is inert until the market opts in through market_compliance_settings.
  await assertSellerVerification(sellerId, market.id, tx);
  await assertMinorProtection(sellerId, market.id, tx);
  await requireCommercialCapability(market.id, 'MARKETPLACE', tx);
}
