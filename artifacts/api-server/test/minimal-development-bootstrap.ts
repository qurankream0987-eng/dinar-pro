import {
  and,
  eq,
  gt,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import {
  db,
  marketPriceVersions,
  markets,
  pool,
} from "@workspace/db";
import { resolveDatabaseUrl } from "@workspace/db/database-url";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

const marketId = "JO";
const currencyCode = "JOD";
const unitPriceMinor = 1_000;
const priceVersionId = "dev-acceptance-jo-minimal-v1";

function verifyTargetAndConsent(): void {
  requireSafeReplitDevelopmentDatabase("BDINAR_SEED");

  const databaseUrl = resolveDatabaseUrl();
  const target = new URL(databaseUrl);
  const selectedOverride = process.env.DINAR_DEV_DATABASE_URL;
  if (
    process.env.NODE_ENV !== "development" ||
    !selectedOverride ||
    databaseUrl !== selectedOverride ||
    target.hostname !== "iriguchi.proxy.rlwy.net" ||
    target.port !== "18992" ||
    process.env.BDINAR_MINIMAL_ACCEPTANCE_BOOTSTRAP !== marketId
  ) {
    throw new Error(
      "Refusing bootstrap: explicit JO authorization and the verified Railway development database are required.",
    );
  }
}

verifyTargetAndConsent();

try {
  await db.transaction(async (tx) => {
    const existingMarkets = await tx
      .select({
        id: markets.id,
        isActive: markets.isActive,
        status: markets.status,
        unitPriceMinor: markets.unitPriceMinor,
        fulfilmentMethods: markets.fulfilmentMethods,
      })
      .from(markets);
    const selected = existingMarkets.filter((row) => row.id === marketId);
    if (existingMarkets.length !== 249 || selected.length !== 1) {
      throw new Error(
        "Refusing bootstrap: the canonical market catalog is not the verified 249-market shape.",
      );
    }

    const [market] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, marketId))
      .for("update");
    if (
      !market ||
      market.countryCode !== marketId ||
      market.currencyCode !== currencyCode ||
      market.minorUnitScale !== 3 ||
      !market.fulfilmentMethods.includes("PICKUP") ||
      !market.fulfilmentMethods.includes("DELIVERY")
    ) {
      throw new Error(
        "Refusing bootstrap: JO canonical identity or currency does not match.",
      );
    }

    const now = new Date();
    const [existingVersion] = await tx
      .select()
      .from(marketPriceVersions)
      .where(eq(marketPriceVersions.id, priceVersionId));
    if (existingVersion) {
      const alreadyConfigured =
        market.isActive &&
        market.status === "ACTIVE" &&
        market.unitPriceMinor === unitPriceMinor &&
        existingVersion.marketId === marketId &&
        existingVersion.currencyCode === currencyCode &&
        existingVersion.unitPriceMinor === unitPriceMinor &&
        existingVersion.minorUnitScale === market.minorUnitScale;
      if (!alreadyConfigured) {
        throw new Error(
          "Refusing bootstrap: the reserved development price version conflicts with existing configuration.",
        );
      }
      const fulfilmentMethods = market.fulfilmentMethods.includes("COURIER")
        ? market.fulfilmentMethods
        : [...market.fulfilmentMethods, "COURIER"];
      if (fulfilmentMethods.length !== market.fulfilmentMethods.length) {
        await tx
          .update(markets)
          .set({ fulfilmentMethods, updatedAt: now })
          .where(eq(markets.id, marketId));
      }
      console.log(
        "MINIMAL_DEV_BOOTSTRAP",
        JSON.stringify({
          market: marketId,
          currency: currencyCode,
          status: "CONFIGURED",
          independentCourierEnabled:
            fulfilmentMethods.includes("COURIER"),
          otherMarketsChanged: 0,
          livePayments: false,
        }),
      );
      // A previous idempotent application already verified other markets when it
      // created the reserved price version; this pass only added JO's courier capability.
      return;
    }

    if (
      market.isActive ||
      market.status !== "COMING_SOON" ||
      market.unitPriceMinor !== null
    ) {
      throw new Error(
        "Refusing bootstrap: JO is neither the expected empty baseline nor this bootstrap's already-configured state.",
      );
    }
    const [effectivePrice] = await tx
      .select({ id: marketPriceVersions.id })
      .from(marketPriceVersions)
      .where(
        and(
          eq(marketPriceVersions.marketId, marketId),
          lte(marketPriceVersions.effectiveFrom, now),
          or(
            isNull(marketPriceVersions.effectiveTo),
            gt(marketPriceVersions.effectiveTo, now),
          ),
        ),
      )
      .limit(1);
    if (effectivePrice) {
      throw new Error(
        "Refusing bootstrap: JO already has an effective market price version.",
      );
    }

    await tx
      .insert(marketPriceVersions)
      .values({
        id: priceVersionId,
        marketId,
        currencyCode,
        unitPriceMinor,
        minorUnitScale: market.minorUnitScale,
        effectiveFrom: now,
        createdBy: null,
      });
    await tx
      .update(markets)
      .set({
        isActive: true,
        status: "ACTIVE",
        unitPriceMinor,
        fulfilmentMethods: market.fulfilmentMethods.includes("COURIER")
          ? market.fulfilmentMethods
          : [...market.fulfilmentMethods, "COURIER"],
        updatedAt: now,
      })
      .where(eq(markets.id, marketId));

    const updatedMarkets = await tx
      .select({
        id: markets.id,
        isActive: markets.isActive,
        status: markets.status,
        unitPriceMinor: markets.unitPriceMinor,
        fulfilmentMethods: markets.fulfilmentMethods,
      })
      .from(markets);
    const changedOthers = updatedMarkets.filter((after) => {
      if (after.id === marketId) return false;
      const before = existingMarkets.find((row) => row.id === after.id);
      return (
        !before ||
        before.isActive !== after.isActive ||
        before.status !== after.status ||
        before.unitPriceMinor !== after.unitPriceMinor ||
        JSON.stringify(before.fulfilmentMethods) !==
          JSON.stringify(after.fulfilmentMethods)
      );
    });
    if (
      updatedMarkets.length !== existingMarkets.length ||
      changedOthers.length !== 0
    ) {
      throw new Error(
        "Bootstrap invariant failed: a market other than JO changed.",
      );
    }

    console.log(
      "MINIMAL_DEV_BOOTSTRAP",
      JSON.stringify({
        market: marketId,
        currency: currencyCode,
        developmentUnitPrice: "1.000 JOD",
        status: "ACTIVE",
        paymentMethodsUnchanged: true,
        independentCourierEnabled: true,
        otherMarketsChanged: changedOthers.length,
        livePayments: false,
      }),
    );
  });
} finally {
  await pool.end();
}
