CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"refund_id" text,
	"provider_key" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_type_valid" CHECK ("payment_events"."event_type" IN ('CAPTURE_SUCCEEDED', 'REFUND_SUCCEEDED')),
	CONSTRAINT "payment_events_amount_positive" CHECK ("payment_events"."amount_minor" > 0),
	CONSTRAINT "payment_events_payload_sha256_valid" CHECK ("payment_events"."payload_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payment_events_simulation_only" CHECK ("payment_events"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"provider_intent_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"captured_amount_minor" integer DEFAULT 0 NOT NULL,
	"refunded_amount_minor" integer DEFAULT 0 NOT NULL,
	"currency_code" text NOT NULL,
	"status" text DEFAULT 'SIMULATION_PENDING' NOT NULL,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "payment_intents_amount_positive" CHECK ("payment_intents"."amount_minor" > 0),
	CONSTRAINT "payment_intents_capture_refund_bounds" CHECK ("payment_intents"."captured_amount_minor" >= 0 AND "payment_intents"."captured_amount_minor" <= "payment_intents"."amount_minor" AND "payment_intents"."refunded_amount_minor" >= 0 AND "payment_intents"."refunded_amount_minor" <= "payment_intents"."captured_amount_minor"),
	CONSTRAINT "payment_intents_status_valid" CHECK ("payment_intents"."status" IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_PARTIALLY_REFUNDED', 'SIMULATION_REFUNDED', 'SIMULATION_FAILED')),
	CONSTRAINT "payment_intents_simulation_only" CHECK ("payment_intents"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"result" text NOT NULL,
	"local_status" text NOT NULL,
	"provider_status" text,
	"local_captured_amount_minor" integer NOT NULL,
	"provider_captured_amount_minor" integer,
	"local_refunded_amount_minor" integer NOT NULL,
	"provider_refunded_amount_minor" integer,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reconciliation_items_result_valid" CHECK ("payment_reconciliation_items"."result" IN ('MATCH', 'MISMATCH')),
	CONSTRAINT "payment_reconciliation_items_simulation_only" CHECK ("payment_reconciliation_items"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"status" text NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"mismatch_count" integer DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reconciliation_runs_status_valid" CHECK ("payment_reconciliation_runs"."status" IN ('MATCHED', 'MISMATCHED')),
	CONSTRAINT "payment_reconciliation_runs_counts_valid" CHECK ("payment_reconciliation_runs"."matched_count" >= 0 AND "payment_reconciliation_runs"."mismatch_count" >= 0),
	CONSTRAINT "payment_reconciliation_runs_simulation_only" CHECK ("payment_reconciliation_runs"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"provider_refund_id" text,
	"idempotency_key" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("payment_refunds"."amount_minor" > 0),
	CONSTRAINT "payment_refunds_status_valid" CHECK ("payment_refunds"."status" IN ('REQUESTED', 'SIMULATED_COMPLETED', 'FAILED')),
	CONSTRAINT "payment_refunds_simulation_only" CHECK ("payment_refunds"."mode" = 'SIMULATION_ONLY')
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_refund_id_payment_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."payment_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_items" ADD CONSTRAINT "payment_reconciliation_items_run_id_payment_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payment_reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_items" ADD CONSTRAINT "payment_reconciliation_items_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" USING btree ("provider_key","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_events_intent_created_idx" ON "payment_events" USING btree ("payment_intent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_buyer_idempotency_unique" ON "payment_intents" USING btree ("buyer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_provider_id_unique" ON "payment_intents" USING btree ("provider_key","provider_intent_id");--> statement-breakpoint
CREATE INDEX "payment_intents_status_created_idx" ON "payment_intents" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_items_run_intent_unique" ON "payment_reconciliation_items" USING btree ("run_id","payment_intent_id");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_runs_created_idx" ON "payment_reconciliation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_intent_idempotency_unique" ON "payment_refunds" USING btree ("payment_intent_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_provider_id_unique" ON "payment_refunds" USING btree ("provider_refund_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_intent_status_idx" ON "payment_refunds" USING btree ("payment_intent_id","status");