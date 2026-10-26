CREATE TABLE "payment_dispute_events" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"dispute_id" text NOT NULL,
	"source_payment_event_id" text,
	"event_type" text NOT NULL,
	"financial_outcome" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"commission_rate_bps" integer NOT NULL,
	"platform_fee_minor" integer NOT NULL,
	"seller_amount_minor" integer NOT NULL,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispute_events_type_valid" CHECK ("payment_dispute_events"."event_type" IN ('DISPUTE_OPENED', 'PAYMENT_CAPTURED', 'DISPUTE_RESOLVED')),
	CONSTRAINT "payment_dispute_events_outcome_valid" CHECK ("payment_dispute_events"."financial_outcome" IN ('HOLD_PENDING', 'HOLD_CAPTURED', 'BUYER_REFUND_DUE', 'SELLER_RELEASE_DUE')),
	CONSTRAINT "payment_dispute_events_amount_nonnegative" CHECK ("payment_dispute_events"."amount_minor" >= 0),
	CONSTRAINT "payment_dispute_events_commission_bps_valid" CHECK ("payment_dispute_events"."commission_rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "payment_dispute_events_order_snapshot_nonnegative" CHECK ("payment_dispute_events"."platform_fee_minor" >= 0 AND "payment_dispute_events"."seller_amount_minor" >= 0),
	CONSTRAINT "payment_dispute_events_simulation_only" CHECK ("payment_dispute_events"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_status_valid";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "dispute_id" text;--> statement-breakpoint
ALTER TABLE "payment_dispute_events" ADD CONSTRAINT "payment_dispute_events_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_events" ADD CONSTRAINT "payment_dispute_events_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_events" ADD CONSTRAINT "payment_dispute_events_source_payment_event_id_payment_events_id_fk" FOREIGN KEY ("source_payment_event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_dispute_events_intent_dispute_type_unique" ON "payment_dispute_events" USING btree ("payment_intent_id","dispute_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_dispute_events_source_event_unique" ON "payment_dispute_events" USING btree ("source_payment_event_id");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_dispute_id_unique" ON "payment_intents" USING btree ("dispute_id");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_status_valid" CHECK ("payment_intents"."status" IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_PARTIALLY_REFUNDED', 'SIMULATION_REFUNDED', 'SIMULATION_FAILED', 'SIMULATION_DISPUTED', 'SIMULATION_BUYER_REFUND_DUE', 'SIMULATION_SELLER_RELEASE_DUE'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_payment_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_events_reject_update_delete
BEFORE UPDATE OR DELETE ON payment_events
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_events_reject_truncate
BEFORE TRUNCATE ON payment_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_dispute_events_reject_update_delete
BEFORE UPDATE OR DELETE ON payment_dispute_events
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_dispute_events_reject_truncate
BEFORE TRUNCATE ON payment_dispute_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();