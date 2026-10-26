ALTER TABLE "offers" DROP CONSTRAINT "offers_pricing_valid";--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_pricing_valid" CHECK ((pricing_mode = 'QUOTE_REQUIRED' AND unit_price_minor IS NULL) OR (pricing_mode IN ('FIXED', 'STARTING_FROM') AND unit_price_minor IS NOT NULL AND unit_price_minor >= 1));
--> statement-breakpoint
UPDATE "marketplace_categories"
SET "aliases" = "aliases" || '["آيفون","ايفون","سماعة","سماعات","بلوتوث"]'::jsonb
WHERE "id" = 'electronics';
--> statement-breakpoint
UPDATE "marketplace_categories"
SET "aliases" = "aliases" || '["خدمتي","كهربائي","كهرباء","شعارات","مكيفات","سباك","ترجمة","مترجم","مترجمة"]'::jsonb
WHERE "id" = 'services';
