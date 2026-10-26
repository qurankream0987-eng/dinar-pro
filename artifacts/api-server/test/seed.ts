import {
  orders,
  orderItems,
  conversations,
  messages,
  sellerDues,
  disputes,
} from "@workspace/db";
import { db, pool, markets, users, offers, marketPriceVersions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/lib/auth";
import { listings } from "../src/lib/dinar-data";
import { phase1DevelopmentListings } from "./phase1-dev-fixtures";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_SEED");
const configured = [
  {
    id: "KW",
    countryCode: "KW",
    countryNameAr: "الكويت",
    countryNameEn: "Kuwait",
    currencyCode: "KWD",
    currencySymbolAr: "د.ك",
    unitPriceMinor: 1000,
    minorUnitScale: 3,
    isActive: true,
    status: "ACTIVE",
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
    isActive: true,
    status: "ACTIVE",
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
    isActive: true,
    status: "ACTIVE",
  },
];
for (const market of configured) {
  await db
    .insert(markets)
    .values(market)
    .onConflictDoUpdate({
      target: markets.id,
      set: {
        unitPriceMinor: market.unitPriceMinor,
        minorUnitScale: market.minorUnitScale,
        isActive: market.isActive,
        status: market.status,
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
const password = process.env.BDINAR_SEED_PASSWORD;
if (!password || password.length < 12)
  throw new Error("Set BDINAR_SEED_PASSWORD (12+ characters)");
const passwordHash = await hashPassword(password);
for (let n = 0; n < 6; n++) {
  const id = n === 0 ? "dev_buyer" : `usr_seller_${n}`;
  await db
    .insert(users)
    .values({
      id,
      displayName: n === 0 ? "مستخدم التطوير" : listings[n - 1].sellerName,
      phoneCountryCode: "+965",
      phoneNumber: `5000000${n}`,
      normalizedPhone: `+9655000000${n}`,
      accountCountry: "KW",
      activeMarketId: "KW",
      passwordHash,
      phoneVerified: true,
    })
    .onConflictDoNothing();
}
for (const market of configured)
  for (const l of listings)
    await db
      .insert(offers)
      .values({
        id: `${market.id}_${l.id}`,
        sellerId: l.sellerId,
        marketId: market.id,
        status: "PUBLISHED",
        unitPriceMinor: market.unitPriceMinor ?? 1000,
        inventoryMode: l.inventoryMode,
        availableQuantity: l.availableQuantity,
        reservedQuantity: 0,
        data: {
          ...l,
          area:
            l.fulfilmentType === "DIGITAL" ? "عن بُعد" : market.countryNameAr,
          rating: 0,
          reviewCount: 0,
        },
      })
      .onConflictDoNothing();

for (const { marketId, listing } of phase1DevelopmentListings) {
  const market = configured.find((item) => item.id === marketId);
  if (!market) throw new Error(`Unknown development fixture market: ${marketId}`);
  await db
    .insert(offers)
    .values({
      id: `${marketId}_${listing.id}`,
      sellerId: listing.sellerId,
      marketId,
      status: "PUBLISHED",
      unitPriceMinor: Math.round(
        Number(listing.unitPrice) * 10 ** market.minorUnitScale,
      ),
      inventoryMode: listing.inventoryMode,
      availableQuantity: listing.availableQuantity,
      reservedQuantity: 0,
      data: {
        ...listing,
        testFixture: "phase1-acceptance",
        testOwned: true,
        rating: 0,
        reviewCount: 0,
      },
    })
    .onConflictDoNothing();
}

for (const [suffix, offerId, status] of [
  ["progress", "KW_lst_shirts", "IN_PROGRESS"],
  ["complete", "KW_lst_lamp", "COMPLETED"],
  ["dispute", "KW_lst_design", "DISPUTED"],
]) {
  await db.transaction(async (tx) => {
    const id = `dev_order_${suffix}`;
    if ((await tx.select().from(orders).where(eq(orders.id, id))).length)
      return;
    const [offer] = await tx
      .select()
      .from(offers)
      .where(eq(offers.id, offerId))
      .for("update");
    const item = {
      listingId: offer.id,
      listingTitle: offer.data.title,
      listingImageUrl: offer.data.imageUrl,
      quantity: 1,
      unitPrice: "1.000",
      total: "1.000",
      currency: "KWD",
      fulfilmentType: offer.data.fulfilmentType,
      inventoryMode: offer.inventoryMode,
    };
    await tx
      .insert(orders)
      .values({
        id,
        buyerId: "dev_buyer",
        sellerId: offer.sellerId,
        marketId: "KW",
        countryCode: "KW",
        currencyCode: "KWD",
        minorUnitScale: 3,
        unitPriceMinor: 1000,
        quantity: 1,
        subtotalMinor: 1000,
        platformFeeMinor: 100,
        sellerAmountMinor: 900,
        status,
        data: {
          items: [item],
          listingId: offer.id,
          listingTitle: offer.data.title,
          listingImageUrl: offer.data.imageUrl,
          buyerName: "مستخدم التطوير",
          sellerName: offer.data.sellerName,
          fulfilmentType: offer.data.fulfilmentType,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          deliveryProof: status === "IN_PROGRESS" ? null : "إثبات تطوير تجريبي",
          issue: status === "DISPUTED" ? "مثال نزاع للتطوير" : null,
          paymentMode: "TEST_NO_TRANSFER",
        },
      });
    await tx
      .insert(orderItems)
      .values({
        id: `${id}_item`,
        orderId: id,
        offerId: offer.id,
        quantity: 1,
        unitPriceMinor: 1000,
        subtotalMinor: 1000,
        data: item,
      });
    await tx.insert(conversations).values({ id, orderId: id });
    await tx
      .insert(messages)
      .values({
        id: `${id}_message`,
        conversationId: id,
        body: "طلب تطوير فقط؛ لا توجد حركة مالية حقيقية.",
      });
    if (status === "COMPLETED")
      await tx
        .insert(sellerDues)
        .values({
          id: `${id}_due`,
          orderId: id,
          sellerId: offer.sellerId,
          amountMinor: 100,
          currencyCode: "KWD",
        });
    if (status === "DISPUTED")
      await tx
        .insert(disputes)
        .values({
          id: `${id}_dispute`,
          orderId: id,
          openedBy: "dev_buyer",
          reason: "مثال نزاع للتطوير",
        });
    if (offer.inventoryMode === "LIMITED")
      await tx
        .update(offers)
        .set(
          status === "COMPLETED"
            ? { availableQuantity: offer.availableQuantity! - 1 }
            : { reservedQuantity: offer.reservedQuantity + 1 },
        )
        .where(eq(offers.id, offer.id));
  });
}
console.log(
  "Development markets and offers seeded. SA/JO prices are test configuration, not commercial approval.",
);
await pool.end();
