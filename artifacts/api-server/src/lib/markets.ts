import { db, markets, marketPriceVersions, sellerMarketEligibility } from '@workspace/db';
import { countryByCode, DEFAULT_MARKET } from '@workspace/global';
import { and, eq, lte, gt, isNull, or, desc } from 'drizzle-orm';
import { marketAllowsFulfilment } from './market-capability-registry';
export const marketError = (status: number, message: string) => Object.assign(new Error(message), { status });
export const GUEST_MARKET_COOKIE = 'bdinar_guest_market';
export async function resolveMarket(row: typeof markets.$inferSelect, tx: any = db) {
  const now = new Date();
  const [price] = await tx.select().from(marketPriceVersions).where(and(eq(marketPriceVersions.marketId, row.id), lte(marketPriceVersions.effectiveFrom, now), or(isNull(marketPriceVersions.effectiveTo), gt(marketPriceVersions.effectiveTo, now)))).orderBy(desc(marketPriceVersions.effectiveFrom)).limit(1);
  return marketView(row, price);
}
function marketView(row: typeof markets.$inferSelect, price?: typeof marketPriceVersions.$inferSelect) {
  const country = countryByCode.get(row.countryCode);
  return { ...row, countryNameAr: country?.countryNameAr ?? row.countryNameAr, countryNameEn: country?.countryNameEn ?? row.countryNameEn,
    callingCode: country?.callingCode, currencyCode: price?.currencyCode ?? row.currencyCode,
    unitPriceMinor: price?.unitPriceMinor ?? row.unitPriceMinor ?? 0, minorUnitScale: price?.minorUnitScale ?? row.minorUnitScale,
    priceConfigured: !!price || row.unitPriceMinor !== null, priceVersionId: price?.id ?? null,
    effectiveFrom: price?.effectiveFrom ?? null, effectiveTo: price?.effectiveTo ?? null };
}
export async function allMarkets() {
  const now = new Date();
  const [rows, prices] = await Promise.all([db.select().from(markets), db.select().from(marketPriceVersions).where(and(lte(marketPriceVersions.effectiveFrom, now), or(isNull(marketPriceVersions.effectiveTo), gt(marketPriceVersions.effectiveTo, now))))]);
  const byId = new Map(prices.map(price => [price.marketId, price]));
  return rows.map(row => marketView(row, byId.get(row.id)));
}
export async function marketFor(req: any, tx: any = db, lock = false) {
  const cookieMarketId = req.cookies?.[GUEST_MARKET_COOKIE];
  const requestedMarketId = req.actor?.activeMarketId ??
    (typeof cookieMarketId === 'string' && cookieMarketId.length <= 32
      ? cookieMarketId
      : DEFAULT_MARKET);
  const findMarket = async (id: string) => {
    let query = tx.select().from(markets).where(eq(markets.id, id));
    if (lock) query = query.for('share');
    const [row] = await query;
    return row;
  };
  let row = await findMarket(requestedMarketId);
  // An invalid or stale guest cookie is not a valid selection. Keep the existing
  // configured default behavior; a valid but closed market remains selected.
  if (!row && !req.actor && requestedMarketId !== DEFAULT_MARKET)
    row = await findMarket(DEFAULT_MARKET);
  if (!row) throw marketError(400, 'السوق غير موجود');
  return resolveMarket(row, tx);
}
export function isMarketAvailable(market: Awaited<ReturnType<typeof marketFor>>) {
  return market.isActive && ['ACTIVE', 'LIMITED'].includes(market.status) &&
    market.priceConfigured && market.unitPriceMinor >= 1;
}
export function assertMarketActive(market: Awaited<ReturnType<typeof marketFor>>) {
  if (!isMarketAvailable(market))
    throw marketError(409, 'بدينار لم يبدأ استقبال العروض والطلبات في هذا السوق بعد.');
}
export async function assertMarketPolicy(market: Awaited<ReturnType<typeof marketFor>>, sellerId: string, category: string, fulfilment: string, tx: any = db, categoryId?: string) {
  assertMarketActive(market);
  if (market.restrictedCategories.includes(category) || (categoryId && market.restrictedCategories.includes(categoryId))) throw marketError(409, 'هذا التصنيف غير متاح في السوق الحالي');
  if (!marketAllowsFulfilment(market, fulfilment)) throw marketError(409, 'طريقة التنفيذ غير متاحة في هذا السوق');
  if (market.sellerEligibilityMode === 'APPROVAL_REQUIRED') {
    const [eligibility] = await tx.select().from(sellerMarketEligibility).where(and(eq(sellerMarketEligibility.userId, sellerId), eq(sellerMarketEligibility.marketId, market.id), eq(sellerMarketEligibility.approved, true)));
    if (!eligibility) throw marketError(403, 'النشر واستقبال الطلبات في هذا السوق يتطلب موافقة على أهلية البائع');
  }
}
