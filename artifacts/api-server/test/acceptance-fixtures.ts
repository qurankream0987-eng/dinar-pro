import { and, eq } from "drizzle-orm";
import {
  db,
  marketPriceVersions,
  markets,
  offers,
  users, policyAcceptances } from "@workspace/db";
import { listings as productListings } from "../src/lib/dinar-data";
import { hashPassword } from "../src/lib/auth";
import { registrationAcceptancePolicies } from "../src/lib/policies";
import { phase1DevelopmentListings } from "./phase1-dev-fixtures";

export type AcceptanceFixtureModule =
  | "MARKET_FIXTURES"
  | "USER_FIXTURES"
  | "PRODUCT_LISTINGS"
  | "PHASE1_LISTINGS";

const configuredMarkets = [
  {
    id: "KW",
    countryCode: "KW",
    countryNameAr: "الكويت",
    countryNameEn: "Kuwait",
    currencyCode: "KWD",
    currencySymbolAr: "د.ك",
    unitPriceMinor: 1000,
    minorUnitScale: 3,
  },
  {
    id: "JO",
    countryCode: "JO",
    countryNameAr: "الأردن",
    countryNameEn: "Jordan",
    currencyCode: "JOD",
    currencySymbolAr: "د.أ",
    unitPriceMinor: 1000,
    minorUnitScale: 3,
  },
  {
    id: "SA",
    countryCode: "SA",
    countryNameAr: "السعودية",
    countryNameEn: "Saudi Arabia",
    currencyCode: "SAR",
    currencySymbolAr: "ر.س",
    unitPriceMinor: 100,
    minorUnitScale: 2,
  },
] as const;

const sellerIds = ["dev_buyer", ...Array.from({ length: 5 }, (_, n) => `usr_seller_${n + 1}`)];

/**
 * Seed only the requested acceptance modules into a guarded disposable DB.
 * Deliberately excludes orders, payment intents, dues, campaigns, and ledgers:
 * those must be created by each test through its canonical flow.
 */
export async function seedAcceptanceFixtures(requested: AcceptanceFixtureModule[]) {
  const modules = new Set(requested);
  if ([...modules].some((module) => !["MARKET_FIXTURES", "USER_FIXTURES", "PRODUCT_LISTINGS", "PHASE1_LISTINGS"].includes(module)))
    throw new Error("Unsupported acceptance fixture module.");

  const needsMarkets = modules.size > 0;
  const needsUsers = modules.has("USER_FIXTURES") || modules.has("PRODUCT_LISTINGS") || modules.has("PHASE1_LISTINGS");
  const needsProducts = modules.has("PRODUCT_LISTINGS");
  const needsPhase1 = modules.has("PHASE1_LISTINGS");

  if (needsMarkets) {
    for (const market of configuredMarkets) {
      await db.insert(markets).values({
        ...market,
        isActive: true,
        status: "ACTIVE",
      }).onConflictDoUpdate({
        target: markets.id,
        set: {
          unitPriceMinor: market.unitPriceMinor,
          minorUnitScale: market.minorUnitScale,
          isActive: true,
          status: "ACTIVE",
        },
      });
      await db.insert(marketPriceVersions).values({
        id: `baseline-${market.id}`,
        marketId: market.id,
        currencyCode: market.currencyCode,
        unitPriceMinor: market.unitPriceMinor,
        minorUnitScale: market.minorUnitScale,
        effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      }).onConflictDoNothing();
    }
  }

  if (needsUsers) {
    const password = process.env.BDINAR_SEED_PASSWORD;
    if (!password || password.length < 12)
      throw new Error("Acceptance USER_FIXTURES requires a one-run BDINAR_SEED_PASSWORD.");
    const passwordHash = await hashPassword(password);
    for (let n = 0; n < sellerIds.length; n++) {
      const id = sellerIds[n]!;
      await db.insert(users).values({
        id,
        displayName: n === 0 ? "مستخدم اختبار القبول" : productListings[n - 1]?.sellerName ?? "بائع اختبار القبول",
        phoneCountryCode: "+965",
        phoneNumber: `5000000${n}`,
        normalizedPhone: `+9655000000${n}`,
        accountCountry: "KW",
        activeMarketId: "KW",
        passwordHash,
        phoneVerified: true,
      }).onConflictDoNothing();
      // A fixture account accepted the current policies at creation, as registration records it.
      await db.insert(policyAcceptances)
        .values(registrationAcceptancePolicies().map((policy) => ({ userId: id, policyKey: policy.key, policyVersion: policy.version })))
        .onConflictDoNothing();
    }
  }

  if (needsProducts) {
    for (const market of configuredMarkets) {
      for (const listing of productListings) {
        await db.insert(offers).values({
          id: `${market.id}_${listing.id}`,
          sellerId: listing.sellerId,
          marketId: market.id,
          status: "PUBLISHED",
          unitPriceMinor: market.unitPriceMinor,
          inventoryMode: listing.inventoryMode,
          availableQuantity: listing.availableQuantity,
          reservedQuantity: 0,
          data: {
            ...listing,
            // Sample fixture media must remain local/unknown; never depend on an external CDN.
            imageUrl: listing.imageUrl?.startsWith("/") && !listing.imageUrl.startsWith("//") ? listing.imageUrl : "",
            area: listing.fulfilmentType === "DIGITAL" ? "عن بُعد" : market.countryNameAr,
            rating: 0,
            reviewCount: 0,
            testFixture: "wave5-acceptance",
          },
        }).onConflictDoNothing();
      }
    }
  }

  if (needsPhase1) {
    for (const { marketId, listing } of phase1DevelopmentListings) {
      const market = configuredMarkets.find((item) => item.id === marketId);
      if (!market) throw new Error(`Unknown acceptance market ${marketId}.`);
      await db.insert(offers).values({
        id: `${marketId}_${listing.id}`,
        sellerId: listing.sellerId,
        marketId,
        status: "PUBLISHED",
        unitPriceMinor: Math.round(Number(listing.unitPrice) * 10 ** market.minorUnitScale),
        inventoryMode: listing.inventoryMode,
        availableQuantity: listing.availableQuantity,
        reservedQuantity: 0,
        data: { ...listing, testFixture: "phase1-acceptance", testOwned: true },
      }).onConflictDoNothing();
    }
  }

  // Assert only the requested fixture families; do not use broad global row counts.
  if (needsMarkets) {
    for (const market of configuredMarkets) {
      const [row] = await db.select({ id: markets.id }).from(markets)
        .where(and(eq(markets.id, market.id), eq(markets.status, "ACTIVE"), eq(markets.isActive, true)));
      if (!row) throw new Error(`Acceptance market fixture missing: ${market.id}`);
    }
  }
  if (needsUsers) {
    for (const id of sellerIds) {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
      if (!row) throw new Error(`Acceptance user fixture missing: ${id}`);
    }
  }
  if (needsProducts && !productListings.length)
    throw new Error("PRODUCT_LISTINGS module unexpectedly has no canonical listing data.");
  if (needsPhase1 && !phase1DevelopmentListings.length)
    throw new Error("PHASE1_LISTINGS module unexpectedly has no canonical listing data.");
}
