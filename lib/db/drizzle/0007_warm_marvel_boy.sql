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
      'Migration 0007 cannot preserve % offer price(s) from data.unitPrice; repair those legacy records before migrating',
      invalid_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "unit_price_minor" integer;
--> statement-breakpoint
UPDATE "offers" AS offer
SET "unit_price_minor" =
  ((offer.data->>'unitPrice')::numeric * power(10::numeric, market.minor_unit_scale))::integer
FROM "markets" AS market
WHERE market."id" = offer."market_id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "offers"
    WHERE "unit_price_minor" IS NULL OR "unit_price_minor" < 1
  ) THEN
    RAISE EXCEPTION 'Unable to backfill a positive unit price for every offer';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "offers" ALTER COLUMN "unit_price_minor" SET NOT NULL;