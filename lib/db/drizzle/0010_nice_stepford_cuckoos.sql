CREATE TABLE "listing_promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"category_id_snapshot" text NOT NULL,
	"price_minor_snapshot" integer NOT NULL,
	"currency_code_snapshot" text NOT NULL,
	"placement_snapshot" text NOT NULL,
	"duration_days_snapshot" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"payment_mode" text DEFAULT 'DEVELOPMENT_SIMULATED' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_promotions_price_positive_check" CHECK ("listing_promotions"."price_minor_snapshot" > 0),
	CONSTRAINT "listing_promotions_duration_check" CHECK ("listing_promotions"."duration_days_snapshot" >= 1 AND "listing_promotions"."duration_days_snapshot" <= 365),
	CONSTRAINT "listing_promotions_simulation_only_check" CHECK ("listing_promotions"."payment_mode" = 'DEVELOPMENT_SIMULATED')
);
--> statement-breakpoint
CREATE TABLE "promotion_products" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"placement" text DEFAULT 'SEARCH_AND_CHAT' NOT NULL,
	"price_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"duration_days" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_products_price_positive_check" CHECK ("promotion_products"."price_minor" > 0),
	CONSTRAINT "promotion_products_duration_check" CHECK ("promotion_products"."duration_days" >= 1 AND "promotion_products"."duration_days" <= 365)
);
--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_listing_id_offers_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_product_id_promotion_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."promotion_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_category_id_marketplace_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_promotions_market_status_expiry_idx" ON "listing_promotions" USING btree ("market_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "listing_promotions_listing_status_idx" ON "listing_promotions" USING btree ("listing_id","status");--> statement-breakpoint
CREATE INDEX "promotion_products_market_enabled_idx" ON "promotion_products" USING btree ("market_id","enabled");--> statement-breakpoint
CREATE INDEX "promotion_products_market_category_idx" ON "promotion_products" USING btree ("market_id","category_id");