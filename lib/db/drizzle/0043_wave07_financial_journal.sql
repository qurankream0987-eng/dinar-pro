CREATE TABLE "commission_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"basis" text DEFAULT 'GROSS_ITEM_SUBTOTAL' NOT NULL,
	"rounding_mode" text DEFAULT 'HALF_UP' NOT NULL,
	"market_id" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"content_hash" text NOT NULL,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_policies_rate_valid" CHECK ("commission_policies"."rate_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "commission_policies_basis_valid" CHECK ("commission_policies"."basis" IN ('GROSS_ITEM_SUBTOTAL')),
	CONSTRAINT "commission_policies_rounding_valid" CHECK ("commission_policies"."rounding_mode" IN ('HALF_UP')),
	CONSTRAINT "commission_policies_status_valid" CHECK ("commission_policies"."status" IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
	CONSTRAINT "commission_policies_publication_valid" CHECK ("commission_policies"."status" <> 'PUBLISHED' OR ("commission_policies"."published_at" IS NOT NULL)),
	CONSTRAINT "commission_policies_window_valid" CHECK ("commission_policies"."effective_to" IS NULL OR "commission_policies"."effective_to" > "commission_policies"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "order_financial_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"event_type" text NOT NULL,
	"account_obligation" text NOT NULL,
	"business_ref" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"currency_code" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"reverses_event_id" text,
	"authorization_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_financial_events_event_type_valid" CHECK ("order_financial_events"."event_type" IN ('ORDER_CREATED', 'PAYMENT_CAPTURED', 'PAYMENT_REFUNDED', 'ORDER_COMPLETED', 'ORDER_CANCELLED', 'COMMISSION_ACCRUED', 'COMMISSION_REVERSED', 'SELLER_PAYABLE_DUE', 'REFUND_OBLIGATION_OPENED', 'REFUND_OBLIGATION_RESOLVED')),
	CONSTRAINT "order_financial_events_obligation_valid" CHECK ("order_financial_events"."account_obligation" IN ('BUYER_RECEIVABLE', 'BUYER_PAYMENT', 'BUYER_REFUND', 'SELLER_PAYABLE', 'PLATFORM_COMMISSION', 'REFUND_OBLIGATION', 'NONE')),
	CONSTRAINT "order_financial_events_actor_valid" CHECK ("order_financial_events"."actor_type" IN ('BUYER', 'SELLER', 'SYSTEM', 'ADMIN', 'PROVIDER')),
	CONSTRAINT "order_financial_events_amount_valid" CHECK ("order_financial_events"."amount_minor" >= 0),
	CONSTRAINT "order_financial_events_currency_valid" CHECK (char_length("order_financial_events"."currency_code") = 3)
);
--> statement-breakpoint
ALTER TABLE "commission_policies" ADD CONSTRAINT "commission_policies_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financial_events" ADD CONSTRAINT "order_financial_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financial_events" ADD CONSTRAINT "order_financial_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financial_events" ADD CONSTRAINT "order_financial_events_reverses_event_id_order_financial_events_id_fk" FOREIGN KEY ("reverses_event_id") REFERENCES "public"."order_financial_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_policies_key_version_unique" ON "commission_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_policies_published_scope_unique" ON "commission_policies" USING btree ("policy_key",COALESCE("market_id", '*')) WHERE "commission_policies"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE INDEX "commission_policies_lookup_idx" ON "commission_policies" USING btree ("policy_key","status","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "order_financial_events_idempotency_unique" ON "order_financial_events" USING btree ("order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "order_financial_events_reversal_idx" ON "order_financial_events" USING btree ("reverses_event_id");--> statement-breakpoint
CREATE INDEX "order_financial_events_order_idx" ON "order_financial_events" USING btree ("order_id","recorded_at");--> statement-breakpoint
CREATE INDEX "order_financial_events_type_idx" ON "order_financial_events" USING btree ("event_type","recorded_at");--> statement-breakpoint
-- Commerce availability is a market activation decision, not a price fact. A historical
-- market unit price may stay null on an active market; listing prices are per listing.
ALTER TABLE "markets" DROP CONSTRAINT "markets_price_valid";--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_price_valid" CHECK ("markets"."minor_unit_scale" BETWEEN 0 AND 4 AND ("markets"."unit_price_minor" IS NULL OR "markets"."unit_price_minor" > 0));--> statement-breakpoint
INSERT INTO "commission_policies" ("id", "policy_key", "version", "rate_basis_points", "basis", "rounding_mode", "market_id", "status", "effective_from", "effective_to", "content_hash", "approved_by", "published_at", "created_by")
VALUES ('cmp_platform_commission_v1', 'PLATFORM_COMMISSION', 1, 1000, 'GROSS_ITEM_SUBTOTAL', 'HALF_UP', NULL, 'PUBLISHED', '1970-01-01T00:00:00.000Z', NULL, '17c50e6cf0b9ad00ba28e11784192d10671d5c98a5affa6020c555cc4825f2bd', 'owner-policy', '1970-01-01T00:00:00.000Z', 'system');--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_financial_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'order_financial_events cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_financial_events is append-only' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = NEW.order_id AND o.currency_code = NEW.currency_code
  ) THEN
    RAISE EXCEPTION 'order_financial_events must use its order''s currency' USING ERRCODE = '23514';
  END IF;
  IF NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM order_financial_events e
    WHERE e.id = NEW.reverses_event_id AND e.order_id = NEW.order_id
  ) THEN
    RAISE EXCEPTION 'a reversal must reverse an entry of the same order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER order_financial_events_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "order_financial_events"
FOR EACH ROW EXECUTE FUNCTION order_financial_events_guard();
--> statement-breakpoint
CREATE TRIGGER order_financial_events_guard_truncate
BEFORE TRUNCATE ON "order_financial_events"
FOR EACH STATEMENT EXECUTE FUNCTION order_financial_events_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commission_policies_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'commission_policies cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'commission_policies is append-only; publish a new version' USING ERRCODE = '23514';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER commission_policies_guard_row
BEFORE UPDATE OR DELETE ON "commission_policies"
FOR EACH ROW EXECUTE FUNCTION commission_policies_guard();
--> statement-breakpoint
CREATE TRIGGER commission_policies_guard_truncate
BEFORE TRUNCATE ON "commission_policies"
FOR EACH STATEMENT EXECUTE FUNCTION commission_policies_guard();
