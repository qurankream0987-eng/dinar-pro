import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, marketplaceCategories, pool } from "@workspace/db";
import { resolveDatabaseUrl } from "@workspace/db/database-url";
import { defaultMarketplaceCategoryRules } from "@workspace/api-zod/marketplace-schemas";
import { eq } from "drizzle-orm";
import { categorySchema } from "../src/lib/marketplace-categories";
import { resolveListingBehavior } from "../src/lib/listing-management";

const target = new URL(resolveDatabaseUrl());
assert.equal(process.env.BDINAR_DISPOSABLE_TEST_DATABASE, "1");
assert.equal(target.hostname, "127.0.0.1");
assert.match(target.pathname, /^\/dinar_test_blockb_[a-z0-9_]+$/);
const identity = await pool.query(
  "select current_database() as database, host(inet_server_addr()) as host, inet_server_port() as port",
);
assert.equal(identity.rows[0].database, target.pathname.slice(1));
assert.equal(identity.rows[0].host, target.hostname);
assert.equal(identity.rows[0].port, Number(target.port));
console.log("Isolated pricing invariant target:", identity.rows[0]);
after(() => pool.end());

for (const mode of ["FIXED", "NEGOTIABLE"]) {
  test(`${mode} rejects a null authoritative price at the database boundary`, async () => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const fixture = await connection.query("select id from offers limit 1");
      assert.ok(fixture.rows[0], "isolated seeded listing required");
      await assert.rejects(
        connection.query(
          "update offers set pricing_mode = $1, unit_price_minor = NULL where id = $2",
          [mode, fixture.rows[0].id],
        ),
        (error: any) => error.code === "23514" && error.constraint === "offers_pricing_valid",
      );
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });
}

test("open-to-offers listings allow no price or a positive guide price", async () => {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const fixture = await connection.query("select id from offers limit 1");
    assert.ok(fixture.rows[0]);
    const emptyPrice = await connection.query(
      "update offers set pricing_mode = 'OPEN_TO_OFFERS', unit_price_minor = NULL where id = $1 returning pricing_mode, unit_price_minor",
      [fixture.rows[0].id],
    );
    assert.equal(emptyPrice.rows[0].pricing_mode, "OPEN_TO_OFFERS");
    assert.equal(emptyPrice.rows[0].unit_price_minor, null);
    const guidePrice = await connection.query(
      "update offers set unit_price_minor = 123 where id = $1 returning unit_price_minor",
      [fixture.rows[0].id],
    );
    assert.equal(guidePrice.rows[0].unit_price_minor, 123);
    await assert.rejects(
      connection.query(
        "update offers set unit_price_minor = 0 where id = $1",
        [fixture.rows[0].id],
      ),
      (error: any) => error.code === "23514" && error.constraint === "offers_pricing_valid",
    );
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});

test("all generic category resource types expose the same canonical pricing modes", () => {
  const expected = ["FIXED", "NEGOTIABLE", "OPEN_TO_OFFERS"];
  for (const type of ["PRODUCT", "SERVICE", "MIXED"] as const) {
    assert.deepEqual(defaultMarketplaceCategoryRules(type).pricing.allowedModes, expected);
  }
});

test("publication accepts unpriced offers for every active generic resource type", async () => {
  for (const resourceType of ["PRODUCT", "SERVICE", "MIXED"] as const) {
    const [category] = await db
      .select()
      .from(marketplaceCategories)
      .where(eq(marketplaceCategories.resourceType, resourceType))
      .limit(1);
    assert.ok(category, `seeded ${resourceType} category required`);
    const inventory = categorySchema(category).rules.inventory;
    const base = {
      pricingMode: "OPEN_TO_OFFERS" as const,
      inventoryMode: inventory.defaultMode,
      availableQuantity:
        inventory.defaultMode === "LIMITED"
          ? inventory.defaultQuantity ?? 1
          : null,
    };
    assert.equal(
      resolveListingBehavior(category, { ...base, unitPrice: null }, "KWD")
        .unitPriceMinor,
      null,
    );
    assert.equal(
      resolveListingBehavior(category, { ...base, unitPrice: "20" }, "KWD")
        .unitPriceMinor,
      20_000,
    );
  }
});
