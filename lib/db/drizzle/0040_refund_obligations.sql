CREATE TABLE "payment_refund_obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"order_id" text NOT NULL,
	"source_payment_event_id" text NOT NULL,
	"reason" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolved_refund_event_id" text,
	"resolved_at" timestamp with time zone,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refund_obligations_reason_valid" CHECK ("payment_refund_obligations"."reason" IN ('RESERVATION_EXPIRED', 'CAPTURE_AFTER_CANCELLATION')),
	CONSTRAINT "payment_refund_obligations_amount_positive" CHECK ("payment_refund_obligations"."amount_minor" > 0),
	CONSTRAINT "payment_refund_obligations_status_valid" CHECK ("payment_refund_obligations"."status" IN ('OPEN', 'RESOLVED')),
	CONSTRAINT "payment_refund_obligations_resolution_evidence" CHECK (("payment_refund_obligations"."status" = 'OPEN' AND "payment_refund_obligations"."resolved_refund_event_id" IS NULL AND "payment_refund_obligations"."resolved_at" IS NULL) OR ("payment_refund_obligations"."status" = 'RESOLVED' AND "payment_refund_obligations"."resolved_refund_event_id" IS NOT NULL AND "payment_refund_obligations"."resolved_at" IS NOT NULL)),
	CONSTRAINT "payment_refund_obligations_simulation_only" CHECK ("payment_refund_obligations"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
ALTER TABLE "payment_events" DROP CONSTRAINT "payment_events_type_valid";--> statement-breakpoint
ALTER TABLE "payment_refund_obligations" ADD CONSTRAINT "payment_refund_obligations_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refund_obligations" ADD CONSTRAINT "payment_refund_obligations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refund_obligations" ADD CONSTRAINT "payment_refund_obligations_source_payment_event_id_payment_events_id_fk" FOREIGN KEY ("source_payment_event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refund_obligations" ADD CONSTRAINT "payment_refund_obligations_resolved_refund_event_id_payment_events_id_fk" FOREIGN KEY ("resolved_refund_event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refund_obligations_intent_unique" ON "payment_refund_obligations" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refund_obligations_source_event_unique" ON "payment_refund_obligations" USING btree ("source_payment_event_id");--> statement-breakpoint
CREATE INDEX "payment_refund_obligations_status_created_idx" ON "payment_refund_obligations" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_type_valid" CHECK ("payment_events"."event_type" IN ('CAPTURE_SUCCEEDED', 'REFUND_SUCCEEDED', 'REFUND_FAILED'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_refund_obligations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'payment_refund_obligations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (
    OLD.status = 'OPEN' AND NEW.status = 'RESOLVED'
    AND NEW.id = OLD.id AND NEW.payment_intent_id = OLD.payment_intent_id
    AND NEW.order_id = OLD.order_id AND NEW.source_payment_event_id = OLD.source_payment_event_id
    AND NEW.reason = OLD.reason AND NEW.amount_minor = OLD.amount_minor
    AND NEW.currency_code = OLD.currency_code AND NEW.mode = OLD.mode
    AND NEW.created_at = OLD.created_at
  ) THEN
    RAISE EXCEPTION 'payment_refund_obligations only move OPEN to RESOLVED' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM payment_events e JOIN payment_intents i ON i.id = e.payment_intent_id
    WHERE e.id = NEW.source_payment_event_id AND e.payment_intent_id = NEW.payment_intent_id
      AND e.event_type = 'CAPTURE_SUCCEEDED' AND i.order_id = NEW.order_id
      AND e.currency_code = NEW.currency_code AND NEW.amount_minor <= i.captured_amount_minor
  ) THEN
    RAISE EXCEPTION 'payment_refund_obligations requires this intent''s verified capture' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT EXISTS (
    SELECT 1 FROM payment_events e
    WHERE e.id = NEW.resolved_refund_event_id AND e.payment_intent_id = NEW.payment_intent_id
      AND e.event_type = 'REFUND_SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'payment_refund_obligations resolves only with this intent''s confirmed refund' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_refund_obligations_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "payment_refund_obligations"
FOR EACH ROW EXECUTE FUNCTION payment_refund_obligations_guard();
--> statement-breakpoint
CREATE TRIGGER payment_refund_obligations_guard_truncate
BEFORE TRUNCATE ON "payment_refund_obligations"
FOR EACH STATEMENT EXECUTE FUNCTION payment_refund_obligations_guard();
