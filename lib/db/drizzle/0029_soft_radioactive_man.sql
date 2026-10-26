CREATE TABLE "negotiation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"negotiation_id" text NOT NULL,
	"version" integer NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"event_type" text NOT NULL,
	"amount_minor" integer,
	"currency_code" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "negotiation_events_role_valid" CHECK ("negotiation_events"."actor_role" IN ('BUYER', 'SELLER')),
	CONSTRAINT "negotiation_events_type_valid" CHECK ("negotiation_events"."event_type" IN ('BUYER_PRICE_OFFER', 'BEST_PRICE_REQUEST', 'SELLER_COUNTER_OFFER', 'BUYER_COUNTER_OFFER', 'ACCEPT', 'REJECT', 'WITHDRAW', 'EXPIRE')),
	CONSTRAINT "negotiation_events_amount_valid" CHECK ("negotiation_events"."amount_minor" IS NULL OR "negotiation_events"."amount_minor" >= 1)
);
--> statement-breakpoint
ALTER TABLE "negotiations" DROP CONSTRAINT "negotiations_amounts_positive";--> statement-breakpoint
ALTER TABLE "offers" DROP CONSTRAINT "offers_pricing_valid";--> statement-breakpoint
ALTER TABLE "negotiations" ALTER COLUMN "listed_price_minor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "negotiations" ALTER COLUMN "offer_amount_minor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "negotiation_events" ADD CONSTRAINT "negotiation_events_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiation_events" ADD CONSTRAINT "negotiation_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "negotiation_events_thread_version_uq" ON "negotiation_events" USING btree ("negotiation_id","version");--> statement-breakpoint
CREATE INDEX "negotiation_events_thread_idx" ON "negotiation_events" USING btree ("negotiation_id","created_at");--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_amounts_positive" CHECK (("negotiations"."listed_price_minor" IS NULL OR "negotiations"."listed_price_minor" >= 1) AND ("negotiations"."offer_amount_minor" IS NULL OR "negotiations"."offer_amount_minor" >= 1) AND ("negotiations"."counter_amount_minor" IS NULL OR "negotiations"."counter_amount_minor" >= 1) AND "negotiations"."quantity" >= 1);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_pricing_valid" CHECK ((pricing_mode IN ('QUOTE_REQUIRED', 'OPEN_TO_OFFERS') AND unit_price_minor IS NULL) OR (pricing_mode IN ('FIXED', 'STARTING_FROM', 'NEGOTIABLE') AND unit_price_minor IS NOT NULL AND unit_price_minor >= 1));--> statement-breakpoint
UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  jsonb_set(
    "rules",
    '{pricing,allowedModes}',
    (
      SELECT jsonb_agg("mode" ORDER BY "mode")
      FROM (
        SELECT DISTINCT "value" AS "mode"
        FROM jsonb_array_elements_text(
          COALESCE("marketplace_categories"."rules" #> '{pricing,allowedModes}', '[]'::jsonb)
        ) AS "existing"("value")
        UNION
        SELECT 'NEGOTIABLE'
        UNION
        SELECT 'OPEN_TO_OFFERS'
      ) AS "modes"
    ),
    true
  ),
  '{pricing,defaultMode}',
  CASE
    WHEN "rules" #>> '{pricing,defaultMode}' = 'QUOTE_REQUIRED' THEN '"OPEN_TO_OFFERS"'::jsonb
    ELSE COALESCE("rules" #> '{pricing,defaultMode}', '"OPEN_TO_OFFERS"'::jsonb)
  END,
  true
)
WHERE jsonb_typeof("rules"->'pricing') = 'object';--> statement-breakpoint