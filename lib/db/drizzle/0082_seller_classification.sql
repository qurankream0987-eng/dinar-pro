-- Seller classification (owner decision 2026-11-28): selling one's own belongings is not trade.
-- PERSONAL_SELLER pays no marketplace commission; INDIVIDUAL_MERCHANT and REGISTERED_BUSINESS pay
-- the published marketplace rate on completed sales; CONNECT_PARTNER is governed by its own Connect
-- agreement (never the marketplace rate automatically); UNDER_REVIEW charges nothing automatically.
-- Append-only history: the latest row per (seller, market) is the current classification. Orders
-- snapshot the classification at checkout, so a later change never reprices an earlier order.
CREATE TABLE "seller_classifications" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"classification" text NOT NULL,
	"confidence" integer NOT NULL,
	"source" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_classifications_classification_valid" CHECK ("seller_classifications"."classification" IN ('PERSONAL_SELLER', 'INDIVIDUAL_MERCHANT', 'REGISTERED_BUSINESS', 'CONNECT_PARTNER', 'UNDER_REVIEW')),
	CONSTRAINT "seller_classifications_source_valid" CHECK ("seller_classifications"."source" IN ('USER_DECLARED', 'SIGNALS', 'BUSINESS_PROFILE', 'CONNECT_PARTNER', 'ADMIN', 'APPEAL')),
	CONSTRAINT "seller_classifications_confidence_range" CHECK ("seller_classifications"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "seller_classifications_reason_present" CHECK (length(trim("seller_classifications"."reason")) > 0),
	CONSTRAINT "seller_classifications_actor_present" CHECK ("seller_classifications"."source" NOT IN ('USER_DECLARED', 'ADMIN', 'APPEAL') OR "seller_classifications"."actor_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "seller_classifications" ADD CONSTRAINT "seller_classifications_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_classifications" ADD CONSTRAINT "seller_classifications_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_classifications" ADD CONSTRAINT "seller_classifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_classifications_current_idx" ON "seller_classifications" USING btree ("seller_id","market_id","created_at");--> statement-breakpoint
CREATE TRIGGER seller_classifications_reject_update_delete
BEFORE UPDATE OR DELETE ON seller_classifications
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER seller_classifications_reject_truncate
BEFORE TRUNCATE ON seller_classifications
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();
