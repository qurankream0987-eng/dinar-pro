ALTER TABLE "offers" DROP CONSTRAINT "offers_pricing_valid";--> statement-breakpoint
-- Legacy STARTING_FROM and QUOTE_REQUIRED listings are not binding purchase prices: both become
-- OPEN_TO_OFFERS (bought only at an agreed price) and keep their meaning in data.priceRepresentation.
-- A starting amount stays as the stored price; a quotation listing stays unpriced. Both SET
-- expressions read the row's pre-update pricing_mode.
UPDATE "offers"
SET
  "pricing_mode" = CASE
    WHEN "pricing_mode" IN ('STARTING_FROM', 'QUOTE_REQUIRED') THEN 'OPEN_TO_OFFERS'
    WHEN "pricing_mode" = 'FIXED' AND "data"->>'negotiable' = 'true' THEN 'NEGOTIABLE'
    ELSE "pricing_mode"
  END,
  "data" = CASE
    WHEN "pricing_mode" IN ('STARTING_FROM', 'QUOTE_REQUIRED')
      THEN jsonb_set("data", '{priceRepresentation}', to_jsonb("pricing_mode"), true)
    ELSE "data"
  END;--> statement-breakpoint
UPDATE "offers"
SET "data" = jsonb_set("data", '{pricingMode}', to_jsonb("pricing_mode"), true);--> statement-breakpoint
UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  jsonb_set("rules", '{pricing,allowedModes}', '["FIXED", "NEGOTIABLE", "OPEN_TO_OFFERS"]'::jsonb, true),
  '{pricing,defaultMode}',
  CASE "rules" #>> '{pricing,defaultMode}'
    WHEN 'STARTING_FROM' THEN '"OPEN_TO_OFFERS"'::jsonb
    WHEN 'QUOTE_REQUIRED' THEN '"OPEN_TO_OFFERS"'::jsonb
    WHEN 'NEGOTIABLE' THEN '"NEGOTIABLE"'::jsonb
    WHEN 'OPEN_TO_OFFERS' THEN '"OPEN_TO_OFFERS"'::jsonb
    ELSE '"FIXED"'::jsonb
  END,
  true
)
WHERE jsonb_typeof("rules"->'pricing') = 'object';--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_pricing_valid" CHECK ((pricing_mode IN ('FIXED', 'NEGOTIABLE') AND unit_price_minor IS NOT NULL AND unit_price_minor >= 1) OR (pricing_mode = 'OPEN_TO_OFFERS' AND (unit_price_minor IS NULL OR unit_price_minor >= 1)));
