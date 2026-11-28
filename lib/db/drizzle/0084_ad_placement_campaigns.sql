-- Jassim Ads closure (owner decision 2026-11-28): the seller chooses WHERE an ad appears, one or
-- several placements in one campaign, each with its own server price and duration; one payment for
-- the whole campaign; every placement keeps its own delivery status. Additive only.
-- * promotion_products (the placement catalog, already per market/currency, versioned and audited)
--   gains: explicit HERO and SIDEBAR placements (HERO_BANNER, SIDEBAR_AD), per-day pricing
--   (pricing_unit DAY with min_days..max_days; PERIOD keeps the fixed duration), accepted subjects
--   (LISTING and, for HERO/SIDEBAR only, STORE), a capacity (concurrent campaigns per placement and
--   market) and a description. HERO/SIDEBAR products may be market-wide (no category).
-- * promotion_campaigns: one purchase (one listing or one store), its server total and ONE provider
--   payment. Payment status is the campaign's; delivery status is each placement's.
-- * listing_promotions.campaign_id: a listing campaign's placements are ordinary listing_promotions
--   rows (same serving, attribution, expiry and analytics); HERO/SIDEBAR added to their placements.
-- * store_promotions: a store campaign's placements (HERO/SIDEBAR), same lifecycle fields.
-- * store_promotion_events: impressions/engagements of store placements (append-only, viewer is an
--   HMAC key, never an identity).
-- Existing rows satisfy every replaced constraint unchanged (new values only widen them).
ALTER TABLE "promotion_products" ADD COLUMN "pricing_unit" text DEFAULT 'PERIOD' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "min_days" integer;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "max_days" integer;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "subject_kinds" jsonb DEFAULT '["LISTING"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_placement_valid";--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_placement_valid" CHECK ("promotion_products"."placement" IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND', 'HERO', 'SIDEBAR', 'NONE'));--> statement-breakpoint
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_type_valid";--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_type_valid" CHECK ("promotion_products"."product_type" IN ('STANDARD_PROMOTION', 'FEATURED_LISTING', 'VIP_LISTING', 'REFRESH_LISTING', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND_CAPTURE', 'PROMOTION_BUNDLE', 'EXTRA_LISTING_QUOTA', 'DINAR_BUSINESS', 'SPONSORED_SURFACE', 'HERO_BANNER', 'SIDEBAR_AD'));--> statement-breakpoint
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_type_placement";--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_type_placement" CHECK (("promotion_products"."product_type", "promotion_products"."placement") IN (('STANDARD_PROMOTION', 'SEARCH_AND_CHAT'), ('FEATURED_LISTING', 'FEATURED'), ('VIP_LISTING', 'VIP'), ('REFRESH_LISTING', 'REFRESH'), ('SPONSORED_SEARCH', 'SPONSORED_SEARCH'), ('SPONSORED_RECOMMENDATION', 'SPONSORED_RECOMMENDATION'), ('DEMAND_CAPTURE', 'DEMAND'), ('PROMOTION_BUNDLE', 'NONE'), ('EXTRA_LISTING_QUOTA', 'NONE'), ('DINAR_BUSINESS', 'NONE'), ('SPONSORED_SURFACE', 'NONE'), ('HERO_BANNER', 'HERO'), ('SIDEBAR_AD', 'SIDEBAR')));--> statement-breakpoint
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_category_scope";--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_category_scope" CHECK (("promotion_products"."placement" = 'NONE' AND "promotion_products"."category_id" IS NULL) OR "promotion_products"."placement" IN ('HERO', 'SIDEBAR') OR ("promotion_products"."placement" NOT IN ('NONE', 'HERO', 'SIDEBAR') AND "promotion_products"."category_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_pricing_unit_valid" CHECK ("promotion_products"."pricing_unit" IN ('PERIOD', 'DAY'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_day_terms" CHECK (("promotion_products"."pricing_unit" = 'DAY' AND "promotion_products"."charging_mode" = 'FIXED' AND "promotion_products"."min_days" IS NOT NULL AND "promotion_products"."max_days" IS NOT NULL AND "promotion_products"."min_days" >= 1 AND "promotion_products"."min_days" <= "promotion_products"."duration_days" AND "promotion_products"."duration_days" <= "promotion_products"."max_days" AND "promotion_products"."max_days" <= 365) OR ("promotion_products"."pricing_unit" = 'PERIOD' AND "promotion_products"."min_days" IS NULL AND "promotion_products"."max_days" IS NULL));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_subject_kinds_valid" CHECK (jsonb_typeof("promotion_products"."subject_kinds") = 'array' AND jsonb_array_length("promotion_products"."subject_kinds") >= 1 AND "promotion_products"."subject_kinds" <@ '["LISTING", "STORE"]'::jsonb AND (NOT ("promotion_products"."subject_kinds" ? 'STORE') OR "promotion_products"."placement" IN ('HERO', 'SIDEBAR')));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_capacity_valid" CHECK ("promotion_products"."capacity" IS NULL OR ("promotion_products"."capacity" >= 1 AND "promotion_products"."capacity" <= 1000));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_description_length" CHECK (char_length("promotion_products"."description") <= 300);--> statement-breakpoint
CREATE TABLE "promotion_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"listing_id" text,
	"business_id" text,
	"ad_copy" text DEFAULT '' NOT NULL,
	"currency_code" text NOT NULL,
	"total_minor" integer NOT NULL,
	"items_count" integer NOT NULL,
	"payment_provider_key" text,
	"payment_reference" text,
	"payment_status" text DEFAULT 'PROVIDER_PENDING' NOT NULL,
	"status" text DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"refund_review_minor" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_campaigns_subject_valid" CHECK (("subject_kind" = 'LISTING' AND "listing_id" IS NOT NULL AND "business_id" IS NULL) OR ("subject_kind" = 'STORE' AND "business_id" IS NOT NULL AND "listing_id" IS NULL)),
	CONSTRAINT "promotion_campaigns_status_valid" CHECK ("status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PARTIAL', 'ENDED', 'CANCELLED', 'PAYMENT_FAILED')),
	CONSTRAINT "promotion_campaigns_payment_status_valid" CHECK ("payment_status" IN ('PROVIDER_PENDING', 'PROVIDER_PAID', 'PROVIDER_FAILED', 'PROVIDER_REFUNDED', 'PROVIDER_DISPUTED')),
	CONSTRAINT "promotion_campaigns_live_requires_payment" CHECK ("status" NOT IN ('ACTIVE', 'PARTIAL', 'ENDED') OR "payment_status" IN ('PROVIDER_PAID', 'PROVIDER_DISPUTED', 'PROVIDER_REFUNDED')),
	CONSTRAINT "promotion_campaigns_reference_consistent" CHECK (("payment_reference" IS NULL) = ("payment_provider_key" IS NULL)),
	CONSTRAINT "promotion_campaigns_amounts_valid" CHECK ("total_minor" > 0 AND "items_count" >= 1 AND "items_count" <= 10 AND "refund_review_minor" >= 0 AND "refund_review_minor" <= "total_minor"),
	CONSTRAINT "promotion_campaigns_currency_valid" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "promotion_campaigns_ad_copy_length" CHECK (char_length("ad_copy") <= 280)
);--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_listing_id_offers_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_campaigns_seller_idempotency_unique" ON "promotion_campaigns" USING btree ("seller_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_campaigns_payment_reference_unique" ON "promotion_campaigns" USING btree ("payment_provider_key","payment_reference") WHERE "promotion_campaigns"."payment_reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "promotion_campaigns_seller_idx" ON "promotion_campaigns" USING btree ("seller_id","created_at");--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_campaign_id_promotion_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."promotion_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_promotions_campaign_idx" ON "listing_promotions" USING btree ("campaign_id") WHERE "listing_promotions"."campaign_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_placement_valid";--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_placement_valid" CHECK ("listing_promotions"."placement_snapshot" IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND', 'HERO', 'SIDEBAR'));--> statement-breakpoint
CREATE TABLE "store_promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"business_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"placement_snapshot" text NOT NULL,
	"price_minor_snapshot" integer NOT NULL,
	"currency_code_snapshot" text NOT NULL,
	"duration_days_snapshot" integer NOT NULL,
	"pricing_version_snapshot" integer NOT NULL,
	"priority_weight_snapshot" integer DEFAULT 100 NOT NULL,
	"status" text DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"payment_status" text DEFAULT 'PROVIDER_PENDING' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_promotions_placement_valid" CHECK ("placement_snapshot" IN ('HERO', 'SIDEBAR')),
	CONSTRAINT "store_promotions_status_valid" CHECK ("status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED')),
	CONSTRAINT "store_promotions_payment_status_valid" CHECK ("payment_status" IN ('PROVIDER_PENDING', 'PROVIDER_PAID', 'PROVIDER_FAILED', 'PROVIDER_REFUNDED', 'PROVIDER_DISPUTED')),
	CONSTRAINT "store_promotions_live_requires_payment" CHECK ("status" NOT IN ('ACTIVE', 'PAUSED') OR "payment_status" IN ('PROVIDER_PAID', 'PROVIDER_DISPUTED')),
	CONSTRAINT "store_promotions_price_positive" CHECK ("price_minor_snapshot" > 0),
	CONSTRAINT "store_promotions_duration_valid" CHECK ("duration_days_snapshot" >= 1 AND "duration_days_snapshot" <= 365),
	CONSTRAINT "store_promotions_window_valid" CHECK ("expires_at" > "starts_at"),
	CONSTRAINT "store_promotions_currency_valid" CHECK ("currency_code_snapshot" ~ '^[A-Z]{3}$')
);--> statement-breakpoint
ALTER TABLE "store_promotions" ADD CONSTRAINT "store_promotions_campaign_id_promotion_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."promotion_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_promotions" ADD CONSTRAINT "store_promotions_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_promotions" ADD CONSTRAINT "store_promotions_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_promotions" ADD CONSTRAINT "store_promotions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_promotions" ADD CONSTRAINT "store_promotions_product_id_promotion_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."promotion_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_promotions_one_live_per_placement" ON "store_promotions" USING btree ("business_id","placement_snapshot") WHERE "store_promotions"."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED');--> statement-breakpoint
CREATE INDEX "store_promotions_campaign_idx" ON "store_promotions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "store_promotions_serving_idx" ON "store_promotions" USING btree ("market_id","placement_snapshot","status","expires_at");--> statement-breakpoint
CREATE TABLE "store_promotion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"store_promotion_id" text NOT NULL,
	"placement" text NOT NULL,
	"viewer_key" text NOT NULL,
	"event_type" text NOT NULL,
	"dedup_key" text NOT NULL,
	"traffic_class" text DEFAULT 'TEST' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_promotion_events_event_valid" CHECK ("event_type" IN ('IMPRESSION', 'ENGAGEMENT')),
	CONSTRAINT "store_promotion_events_traffic_valid" CHECK ("traffic_class" IN ('LIVE', 'TEST'))
);--> statement-breakpoint
ALTER TABLE "store_promotion_events" ADD CONSTRAINT "store_promotion_events_store_promotion_id_store_promotions_id_fk" FOREIGN KEY ("store_promotion_id") REFERENCES "public"."store_promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_promotion_events_dedup_unique" ON "store_promotion_events" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "store_promotion_events_promotion_idx" ON "store_promotion_events" USING btree ("store_promotion_id","event_type");--> statement-breakpoint
CREATE TRIGGER store_promotion_events_reject_update_delete
BEFORE UPDATE OR DELETE ON store_promotion_events
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER store_promotion_events_reject_truncate
BEFORE TRUNCATE ON store_promotion_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();
