CREATE TABLE "negotiations" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"market_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"status" text NOT NULL,
	"currency_code" text NOT NULL,
	"minor_unit_scale" integer NOT NULL,
	"listed_price_minor" integer NOT NULL,
	"offer_amount_minor" integer NOT NULL,
	"counter_amount_minor" integer,
	"agreed_amount_minor" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"last_actor" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"order_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "negotiations_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "negotiations_status_valid" CHECK ("negotiations"."status" IN ('OPEN', 'COUNTERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')),
	CONSTRAINT "negotiations_last_actor_valid" CHECK ("negotiations"."last_actor" IN ('BUYER', 'SELLER')),
	CONSTRAINT "negotiations_parties_distinct" CHECK ("negotiations"."buyer_id" <> "negotiations"."seller_id"),
	CONSTRAINT "negotiations_amounts_positive" CHECK ("negotiations"."listed_price_minor" >= 1 AND "negotiations"."offer_amount_minor" >= 1 AND ("negotiations"."counter_amount_minor" IS NULL OR "negotiations"."counter_amount_minor" >= 1) AND "negotiations"."quantity" >= 1),
	CONSTRAINT "negotiations_countered_has_counter" CHECK ("negotiations"."status" <> 'COUNTERED' OR "negotiations"."counter_amount_minor" IS NOT NULL),
	CONSTRAINT "negotiations_agreed_consistent" CHECK (("negotiations"."status" = 'ACCEPTED') = ("negotiations"."agreed_amount_minor" IS NOT NULL AND "negotiations"."agreed_amount_minor" >= 1)),
	CONSTRAINT "negotiations_order_requires_accepted" CHECK ("negotiations"."order_id" IS NULL OR "negotiations"."status" = 'ACCEPTED')
);
--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_listing_id_offers_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "negotiations_buyer_idx" ON "negotiations" USING btree ("buyer_id","updated_at");--> statement-breakpoint
CREATE INDEX "negotiations_seller_status_idx" ON "negotiations" USING btree ("seller_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "negotiations_one_active_per_buyer_listing" ON "negotiations" USING btree ("listing_id","buyer_id") WHERE "negotiations"."status" IN ('OPEN', 'COUNTERED');