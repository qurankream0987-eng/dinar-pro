DO $$
DECLARE
  invalid_count bigint;
BEGIN
  WITH legacy_prices AS (
    SELECT
      offer.id,
      market.id AS market_id,
      market.minor_unit_scale,
      CASE
        WHEN jsonb_typeof(offer.data->'unitPrice') IN ('number', 'string')
          AND (offer.data->>'unitPrice') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (offer.data->>'unitPrice')::numeric
        ELSE NULL
      END AS legacy_price
    FROM offers AS offer
    LEFT JOIN markets AS market ON market.id = offer.market_id
  ),
  scaled_prices AS (
    SELECT
      id,
      market_id,
      minor_unit_scale,
      legacy_price,
      CASE
        WHEN legacy_price IS NOT NULL AND minor_unit_scale BETWEEN 0 AND 4
        THEN legacy_price * power(10::numeric, minor_unit_scale)
        ELSE NULL
      END AS price_minor
    FROM legacy_prices
  )
  SELECT count(*) INTO invalid_count
  FROM scaled_prices
  WHERE market_id IS NULL
     OR legacy_price IS NULL
     OR minor_unit_scale NOT BETWEEN 0 AND 4
     OR price_minor IS NULL
     OR price_minor <> trunc(price_minor)
     OR price_minor < 1
     OR price_minor > 2147483647;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0011 cannot preserve % offer price(s) from data.unitPrice; repair those legacy records before migrating',
      invalid_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM markets
    WHERE minor_unit_scale NOT BETWEEN 0 AND 4
       OR (unit_price_minor IS NULL AND is_active)
       OR (unit_price_minor IS NOT NULL AND unit_price_minor < 1)
  ) THEN
    RAISE EXCEPTION
      'Migration 0011 found market rows that violate the active market price invariant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM offers
    WHERE reserved_quantity < 0
       OR inventory_mode NOT IN ('LIMITED', 'UNLIMITED')
       OR (inventory_mode = 'LIMITED' AND
           (available_quantity IS NULL OR available_quantity < reserved_quantity))
       OR (inventory_mode = 'UNLIMITED' AND available_quantity IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'Migration 0011 found offer rows that violate the inventory invariant';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "offers" AS offer
SET "unit_price_minor" =
  ((offer.data->>'unitPrice')::numeric * power(10::numeric, market.minor_unit_scale))::integer
FROM "markets" AS market
WHERE market."id" = offer."market_id"
  AND offer."unit_price_minor" IS DISTINCT FROM
    ((offer.data->>'unitPrice')::numeric * power(10::numeric, market.minor_unit_scale))::integer;
--> statement-breakpoint
ALTER TABLE "markets" DROP CONSTRAINT IF EXISTS "markets_price_valid";
--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_price_valid" CHECK (minor_unit_scale BETWEEN 0 AND 4 AND ((unit_price_minor IS NULL AND NOT is_active) OR (unit_price_minor IS NOT NULL AND unit_price_minor > 0)));
--> statement-breakpoint
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_inventory_valid";
--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_inventory_valid" CHECK (reserved_quantity >= 0 AND ((inventory_mode = 'LIMITED' AND available_quantity IS NOT NULL AND available_quantity >= reserved_quantity) OR (inventory_mode = 'UNLIMITED' AND available_quantity IS NULL)));