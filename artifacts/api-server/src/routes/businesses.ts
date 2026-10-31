/**
 * D3-A: the DINAR-hosted public business profile. Read-only and public — the same market
 * resolution as the listing pages, the active-policy search for its listings, and nothing
 * from the owner's private records (contact numbers, verification documents, analytics,
 * audit, internal notes) is exposed. A suspended, closed or unpublished business is a 404.
 */
import { Router } from "express";
import { searchMarketplaceListings } from "../lib/marketplace-listings";
import { assertMarketActive, marketFor } from "../lib/markets";
import { businessPublicListingIds, publicBusiness } from "../lib/business-catalog";
import { d2BusinessIdentity } from "../lib/d2-business-identity";

const router = Router();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const TYPE_LABELS: Record<string, string> = {
  RESTAURANT: "مطعم",
  SHOP: "متجر",
  SERVICE_PROVIDER: "مزود خدمة",
  OTHER: "نشاط",
};

/** Only fields the business chose to publish; the rest of `profile` stays server-side. */
function publicProfile(profile: Record<string, unknown>) {
  return {
    area: typeof profile.area === "string" ? profile.area : undefined,
    fulfilment: typeof profile.fulfilment === "string" ? profile.fulfilment : undefined,
    hours: typeof profile.hours === "string" ? profile.hours : undefined,
    serviceAreas: Array.isArray(profile.serviceAreas)
      ? profile.serviceAreas.filter((value): value is string => typeof value === "string").slice(0, 12)
      : undefined,
  };
}

router.get("/businesses/:id", async (req, res) => {
  const market = await marketFor(req);
  assertMarketActive(market);
  const business = await publicBusiness(req.params.id, market.id);
  if (!business) throw fail(404, "النشاط غير موجود");
  // Only this business's linked, published listings; the search applies the same live
  // eligibility rules (policy, seller status, stock, suspension) the marketplace enforces.
  const linked = await businessPublicListingIds(business, market.id);
  const listings = linked.length
    ? await searchMarketplaceListings(market, {
        search: "",
        allowedIds: linked,
        limit: 48,
        sponsoredPlacement: false,
      })
    : [];
  const identity = business.d2BusinessId
    ? await d2BusinessIdentity.forBusiness(business.d2BusinessId, market.id)
    : null;
  const verified = identity?.verificationStatus === "VERIFIED";
  res.json({
    id: business.id,
    name: business.displayName,
    description: business.description,
    businessType: business.businessType,
    businessTypeLabel: TYPE_LABELS[business.businessType] ?? "نشاط",
    operatingMode: business.operatingMode,
    marketId: market.id,
    currency: market.currencyCode,
    verified,
    verificationStatus: verified ? "VERIFIED" : "PENDING_D2",
    profile: publicProfile(business.profile ?? {}),
    // Only published listings of an ACTIVE business; publicBusiness already enforced ACTIVE.
    listings,
    listingCount: listings.length,
  });
});

export default router;
