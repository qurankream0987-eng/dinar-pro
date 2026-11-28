-- M3 Store Checkout Adapter (simulated & custom-openapi), additive-only.
CREATE TABLE IF NOT EXISTS "store_checkout_adapters" (
  "id" text PRIMARY KEY NOT NULL,
  "business_id" text NOT NULL REFERENCES "business_profiles"("id"),
  "market_id" text NOT NULL REFERENCES "markets"("id"),
  "adapter_kind" text NOT NULL,
  "display_name" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "supported_countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "supported_currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "min_amount_minor" integer DEFAULT 1 NOT NULL,
  "max_amount_minor" integer,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_checkout_adapters_kind_valid" CHECK ("adapter_kind" IN ('SIMULATED_GATEWAY', 'CUSTOM_OPENAPI')),
  CONSTRAINT "store_checkout_adapters_amount_bounds" CHECK ("min_amount_minor" >= 1 AND ("max_amount_minor" IS NULL OR "max_amount_minor" >= "min_amount_minor"))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_checkout_adapters_business_idx" ON "store_checkout_adapters" ("business_id", "enabled");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "store_checkout_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL REFERENCES "orders"("id"),
  "business_id" text NOT NULL REFERENCES "business_profiles"("id"),
  "market_id" text NOT NULL REFERENCES "markets"("id"),
  "buyer_id" text NOT NULL REFERENCES "users"("id"),
  "adapter_id" text NOT NULL REFERENCES "store_checkout_adapters"("id"),
  "adapter_kind" text NOT NULL,
  "provider_session_id" text NOT NULL,
  "checkout_url" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "currency_code" text NOT NULL,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "paid_event_id" text,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_checkout_sessions_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "store_checkout_sessions_currency_valid" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "store_checkout_sessions_status_valid" CHECK ("status" IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'MISMATCH_REVIEW'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "store_checkout_sessions_order_idem_unique" ON "store_checkout_sessions" ("order_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "store_checkout_sessions_provider_session_unique" ON "store_checkout_sessions" ("adapter_id", "provider_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_checkout_sessions_order_idx" ON "store_checkout_sessions" ("order_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "store_checkout_webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "adapter_id" text NOT NULL REFERENCES "store_checkout_adapters"("id"),
  "event_id" text NOT NULL,
  "session_id" text REFERENCES "store_checkout_sessions"("id"),
  "event_type" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_checkout_webhook_events_outcome_valid" CHECK ("outcome" IN ('APPLIED', 'DUPLICATE', 'REJECTED', 'IGNORED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "store_checkout_webhook_events_dedupe" ON "store_checkout_webhook_events" ("adapter_id", "event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_checkout_webhook_events_session_idx" ON "store_checkout_webhook_events" ("session_id", "received_at");
