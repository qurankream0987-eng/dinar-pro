-- Owner-approved 2026-11-16: JassimAI Go / Pro / Business are sold monthly (30 days) and annually
-- (365 days). One enabled catalog product per plan, period and market (was: per plan and market).
-- The new index is strictly weaker than the old one, so it builds on any existing data; the old
-- index is dropped after it. No row changes.
CREATE UNIQUE INDEX "promotion_products_enabled_plan_period_unique" ON "promotion_products" USING btree ("market_id","plan_code","duration_days") WHERE "promotion_products"."plan_code" IS NOT NULL AND "promotion_products"."enabled";--> statement-breakpoint
DROP INDEX "promotion_products_enabled_plan_unique";
