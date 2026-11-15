-- Owner-approved deal closure for direct (phase-one) payments, design of 2026-11-07 with the owner's
-- answers of 2026-11-15: a buyer-only 4-digit handover code (5 wrong entries lock it, valid until the
-- order closes), «تم البيع بدون رمز» with a 48-hour buyer window, a reminder 24 hours after
-- acceptance, and «لم يتم / أُلغي» (one side: review; both sides: cancel without commission).
-- The code itself is never stored: it is derived on demand from a random nonce and the server key.
CREATE TABLE "order_handover_codes" (
	"order_id" text PRIMARY KEY NOT NULL REFERENCES "orders"("id"),
	"nonce" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_handover_codes_nonce_shape" CHECK (length("nonce") BETWEEN 32 AND 128),
	CONSTRAINT "order_handover_codes_attempts_valid" CHECK ("failed_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "order_handover_codes_lock_after_limit" CHECK ("locked_at" IS NULL OR "failed_attempts" = 5)
);
--> statement-breakpoint
CREATE TABLE "order_closure_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL REFERENCES "orders"("id"),
	"actor_id" text REFERENCES "users"("id"),
	"actor_role" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_closure_events_role_valid" CHECK ("actor_role" IN ('BUYER', 'SELLER', 'SYSTEM')),
	CONSTRAINT "order_closure_events_type_valid" CHECK ("type" IN (
		'CODE_ISSUED', 'CODE_REJECTED', 'CODE_LOCKED', 'CODE_ACCEPTED',
		'BUYER_CONFIRMED', 'SOLD_WITHOUT_CODE', 'BUYER_WINDOW_CLOSED',
		'REMINDER_SENT', 'NOT_COMPLETED_CLAIMED', 'MUTUAL_CANCELLED'
	)),
	CONSTRAINT "order_closure_events_system_has_no_actor" CHECK (("actor_role" = 'SYSTEM') = ("actor_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "order_closure_events_order_idx" ON "order_closure_events" ("order_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION reject_order_closure_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_closure_events_reject_update_delete
BEFORE UPDATE OR DELETE ON order_closure_events
FOR EACH ROW EXECUTE FUNCTION reject_order_closure_event_mutation();
--> statement-breakpoint
CREATE TRIGGER order_closure_events_reject_truncate
BEFORE TRUNCATE ON order_closure_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_closure_event_mutation();
