-- Welcome-screen sponsored exposures, buyer-authorised demand requests and their match notices.
-- Additive only: three new tables, no change to existing rows or constraints.
CREATE TABLE "welcome_ad_exposures" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id"),
	"welcome_key" text NOT NULL,
	"conversation_id" text REFERENCES "conversations"("id"),
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"promotion_id" text NOT NULL REFERENCES "listing_promotions"("id"),
	"listing_id" text NOT NULL REFERENCES "offers"("id"),
	"slot" integer NOT NULL,
	"shown_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "welcome_ad_exposures_slot_valid" CHECK ("slot" IN (1, 2)),
	CONSTRAINT "welcome_ad_exposures_key_valid" CHECK ("welcome_key" ~ '^[0-9a-f-]{36}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "welcome_ad_exposures_key_slot_unique" ON "welcome_ad_exposures" USING btree ("user_id","welcome_key","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "welcome_ad_exposures_key_promotion_unique" ON "welcome_ad_exposures" USING btree ("user_id","welcome_key","promotion_id");--> statement-breakpoint
CREATE INDEX "welcome_ad_exposures_user_shown_idx" ON "welcome_ad_exposures" USING btree ("user_id","shown_at");--> statement-breakpoint
CREATE TABLE "buyer_demand_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL REFERENCES "users"("id"),
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"need_text" text NOT NULL,
	"category_id" text,
	"city" text,
	"price_max_minor" integer,
	"currency_code" text NOT NULL,
	"consent_version" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_demand_requests_status_valid" CHECK ("status" IN ('ACTIVE', 'OPTED_OUT', 'DELETED', 'EXPIRED')),
	CONSTRAINT "buyer_demand_requests_need_valid" CHECK (char_length("need_text") BETWEEN 2 AND 200),
	CONSTRAINT "buyer_demand_requests_price_valid" CHECK ("price_max_minor" IS NULL OR "price_max_minor" >= 0)
);--> statement-breakpoint
CREATE INDEX "buyer_demand_requests_market_status_idx" ON "buyer_demand_requests" USING btree ("market_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "buyer_demand_requests_buyer_idx" ON "buyer_demand_requests" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE TABLE "demand_match_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL REFERENCES "buyer_demand_requests"("id"),
	"buyer_id" text NOT NULL REFERENCES "users"("id"),
	"promotion_id" text NOT NULL REFERENCES "listing_promotions"("id"),
	"listing_id" text NOT NULL REFERENCES "offers"("id"),
	"status" text DEFAULT 'UNREAD' NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_match_notices_status_valid" CHECK ("status" IN ('UNREAD', 'SEEN', 'DISMISSED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "demand_match_notices_request_listing_unique" ON "demand_match_notices" USING btree ("request_id","listing_id");--> statement-breakpoint
CREATE INDEX "demand_match_notices_buyer_idx" ON "demand_match_notices" USING btree ("buyer_id","matched_at");--> statement-breakpoint
CREATE INDEX "demand_match_notices_promotion_idx" ON "demand_match_notices" USING btree ("promotion_id");
