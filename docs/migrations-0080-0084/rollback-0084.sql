-- Rollback 0084_ad_placement_campaigns. Refuses unless 0084 is the last applied migration and no
-- campaign, store placement or new placement product exists (rolling back would lose purchases).
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = 1795880000000) <> 1 THEN RAISE EXCEPTION 'migration not applied here'; END IF;
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1795880000000) THEN RAISE EXCEPTION 'roll back later migrations first'; END IF;
  IF EXISTS (SELECT 1 FROM promotion_campaigns) OR EXISTS (SELECT 1 FROM promotion_products WHERE placement IN ('HERO', 'SIDEBAR') OR pricing_unit = 'DAY' OR subject_kinds <> '["LISTING"]'::jsonb OR capacity IS NOT NULL)
    THEN RAISE EXCEPTION 'campaign data exists: export and review before rolling back'; END IF;
END $$;
DROP TABLE "store_promotion_events";
DROP TABLE "store_promotions";
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_placement_valid";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_placement_valid" CHECK ("listing_promotions"."placement_snapshot" IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND'));
DROP INDEX "listing_promotions_campaign_idx";
ALTER TABLE "listing_promotions" DROP COLUMN "campaign_id";
DROP TABLE "promotion_campaigns";
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_description_length";
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_capacity_valid";
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_subject_kinds_valid";
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_day_terms";
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_pricing_unit_valid";
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_category_scope";
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_category_scope" CHECK (("promotion_products"."placement" = 'NONE') = ("promotion_products"."category_id" IS NULL));
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_type_placement";
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_type_placement" CHECK (("promotion_products"."product_type", "promotion_products"."placement") IN (('STANDARD_PROMOTION', 'SEARCH_AND_CHAT'), ('FEATURED_LISTING', 'FEATURED'), ('VIP_LISTING', 'VIP'), ('REFRESH_LISTING', 'REFRESH'), ('SPONSORED_SEARCH', 'SPONSORED_SEARCH'), ('SPONSORED_RECOMMENDATION', 'SPONSORED_RECOMMENDATION'), ('DEMAND_CAPTURE', 'DEMAND'), ('PROMOTION_BUNDLE', 'NONE'), ('EXTRA_LISTING_QUOTA', 'NONE'), ('DINAR_BUSINESS', 'NONE'), ('SPONSORED_SURFACE', 'NONE')));
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_type_valid";
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_type_valid" CHECK ("promotion_products"."product_type" IN ('STANDARD_PROMOTION', 'FEATURED_LISTING', 'VIP_LISTING', 'REFRESH_LISTING', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND_CAPTURE', 'PROMOTION_BUNDLE', 'EXTRA_LISTING_QUOTA', 'DINAR_BUSINESS', 'SPONSORED_SURFACE'));
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_placement_valid";
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_placement_valid" CHECK ("promotion_products"."placement" IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND', 'NONE'));
ALTER TABLE "promotion_products" DROP COLUMN "description";
ALTER TABLE "promotion_products" DROP COLUMN "capacity";
ALTER TABLE "promotion_products" DROP COLUMN "subject_kinds";
ALTER TABLE "promotion_products" DROP COLUMN "max_days";
ALTER TABLE "promotion_products" DROP COLUMN "min_days";
ALTER TABLE "promotion_products" DROP COLUMN "pricing_unit";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795880000000;
COMMIT;
