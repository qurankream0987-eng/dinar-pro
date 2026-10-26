-- DINAR NEXT pre-integration closure.
--  1. Monetary AI cost accounting: versioned model prices, one cost event per provider call,
--     concurrency-safe spend holds and per-scope spend counters (integer micro-units).
--  2. Privacy rights: tracked requests with an append-only history, communication and
--     location-sharing preferences, and an append-only consent ledger.
--  3. Subscription billing webhooks: an idempotent inbound event store (no provider is live).
--  5. Trust appeals: one open appeal per decision, decided by a human with a recorded reason.
--  4. AI usage resources gain AUDIO_TRANSCRIPTION so voice input is metered like every other call.
-- No prompt, reply, audio or coordinate is stored by any of these tables.

ALTER TABLE "ai_usage_reservations" DROP CONSTRAINT "ai_usage_reservations_resource_valid";--> statement-breakpoint
ALTER TABLE "ai_usage_reservations" ADD CONSTRAINT "ai_usage_reservations_resource_valid" CHECK ("ai_usage_reservations"."resource" IN ('TEXT_REQUEST', 'MARKETING_GENERATION', 'BUSINESS_ANALYTICS', 'IMAGE_UNDERSTANDING', 'AGENT_MULTI_STEP', 'AUDIO_TRANSCRIPTION'));--> statement-breakpoint
ALTER TABLE "ai_usage_counters" DROP CONSTRAINT "ai_usage_counters_resource_valid";--> statement-breakpoint
ALTER TABLE "ai_usage_counters" ADD CONSTRAINT "ai_usage_counters_resource_valid" CHECK ("ai_usage_counters"."resource" IN ('TEXT_REQUEST', 'MARKETING_GENERATION', 'BUSINESS_ANALYTICS', 'IMAGE_UNDERSTANDING', 'AGENT_MULTI_STEP', 'AUDIO_TRANSCRIPTION', 'ALL'));--> statement-breakpoint

CREATE TABLE "ai_model_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"version" integer NOT NULL,
	"currency_code" text NOT NULL,
	"input_per_million_micros" bigint NOT NULL,
	"output_per_million_micros" bigint NOT NULL,
	"cached_input_per_million_micros" bigint,
	"image_unit_micros" bigint,
	"audio_second_micros" bigint,
	"request_micros" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"source_reference" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_prices_source_valid" CHECK ("ai_model_prices"."source" IN ('PROVIDER_PUBLISHED', 'CONTRACT', 'TEST_PLACEHOLDER')),
	CONSTRAINT "ai_model_prices_currency_valid" CHECK ("ai_model_prices"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ai_model_prices_amounts_valid" CHECK ("ai_model_prices"."input_per_million_micros" >= 0 AND "ai_model_prices"."output_per_million_micros" >= 0 AND coalesce("ai_model_prices"."cached_input_per_million_micros", 0) >= 0 AND coalesce("ai_model_prices"."image_unit_micros", 0) >= 0 AND coalesce("ai_model_prices"."audio_second_micros", 0) >= 0 AND "ai_model_prices"."request_micros" >= 0),
	CONSTRAINT "ai_model_prices_window_valid" CHECK ("ai_model_prices"."effective_to" IS NULL OR "ai_model_prices"."effective_to" > "ai_model_prices"."effective_from")
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_model_prices_version_unique" ON "ai_model_prices" ("provider", "model", "version");--> statement-breakpoint
CREATE INDEX "ai_model_prices_lookup_idx" ON "ai_model_prices" ("provider", "model", "effective_from");--> statement-breakpoint

CREATE TABLE "ai_spend_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"usage_reservation_id" text REFERENCES "ai_usage_reservations"("id"),
	"owner_key" text NOT NULL,
	"purpose" text NOT NULL,
	"currency_code" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"charged_micros" bigint DEFAULT 0 NOT NULL,
	"scopes" jsonb NOT NULL,
	"status" text DEFAULT 'HELD' NOT NULL,
	"enforced" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_spend_holds_status_valid" CHECK ("ai_spend_holds"."status" IN ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED')),
	CONSTRAINT "ai_spend_holds_amounts_valid" CHECK ("ai_spend_holds"."reserved_micros" >= 0 AND "ai_spend_holds"."charged_micros" >= 0),
	CONSTRAINT "ai_spend_holds_settled_consistent" CHECK (("ai_spend_holds"."status" = 'HELD') = ("ai_spend_holds"."settled_at" IS NULL))
);--> statement-breakpoint
CREATE INDEX "ai_spend_holds_usage_idx" ON "ai_spend_holds" ("usage_reservation_id", "status");--> statement-breakpoint
CREATE INDEX "ai_spend_holds_status_expiry_idx" ON "ai_spend_holds" ("status", "expires_at");--> statement-breakpoint

CREATE TABLE "ai_spend_counters" (
	"scope_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"currency_code" text NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	"unpriced_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_spend_counters_pk" PRIMARY KEY("scope_key","period_start","currency_code"),
	CONSTRAINT "ai_spend_counters_non_negative" CHECK ("ai_spend_counters"."reserved_micros" >= 0 AND "ai_spend_counters"."spent_micros" >= 0 AND "ai_spend_counters"."unpriced_calls" >= 0)
);--> statement-breakpoint

CREATE TABLE "ai_cost_events" (
	"id" text PRIMARY KEY NOT NULL,
	"hold_id" text NOT NULL REFERENCES "ai_spend_holds"("id"),
	"usage_reservation_id" text REFERENCES "ai_usage_reservations"("id"),
	"owner_key" text NOT NULL,
	"purpose" text NOT NULL,
	"call_index" integer NOT NULL,
	"call_kind" text NOT NULL,
	"call_outcome" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"price_id" text REFERENCES "ai_model_prices"("id"),
	"usage_source" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"image_units" integer DEFAULT 0 NOT NULL,
	"audio_seconds" integer DEFAULT 0 NOT NULL,
	"currency_code" text NOT NULL,
	"estimated_cost_micros" bigint,
	"final_cost_micros" bigint,
	"budget_charged_micros" bigint NOT NULL,
	"cost_status" text NOT NULL,
	"provider_request_id" text,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cost_events_kind_valid" CHECK ("ai_cost_events"."call_kind" IN ('PRIMARY', 'RETRY', 'FALLBACK', 'CORRECTION')),
	CONSTRAINT "ai_cost_events_outcome_valid" CHECK ("ai_cost_events"."call_outcome" IN ('SUCCESS', 'FAILED', 'TIMEOUT', 'ABANDONED')),
	CONSTRAINT "ai_cost_events_usage_source_valid" CHECK ("ai_cost_events"."usage_source" IN ('PROVIDER_REPORTED', 'ESTIMATED', 'MISSING')),
	CONSTRAINT "ai_cost_events_status_valid" CHECK ("ai_cost_events"."cost_status" IN ('ESTIMATED', 'UNPRICED', 'FINAL', 'DISPUTED')),
	CONSTRAINT "ai_cost_events_unpriced_consistent" CHECK (("ai_cost_events"."cost_status" = 'UNPRICED') = ("ai_cost_events"."estimated_cost_micros" IS NULL AND "ai_cost_events"."final_cost_micros" IS NULL)),
	CONSTRAINT "ai_cost_events_final_consistent" CHECK (("ai_cost_events"."cost_status" = 'FINAL') = ("ai_cost_events"."final_cost_micros" IS NOT NULL)),
	CONSTRAINT "ai_cost_events_amounts_valid" CHECK ("ai_cost_events"."input_tokens" >= 0 AND "ai_cost_events"."cached_input_tokens" >= 0 AND "ai_cost_events"."output_tokens" >= 0 AND "ai_cost_events"."image_units" >= 0 AND "ai_cost_events"."audio_seconds" >= 0 AND coalesce("ai_cost_events"."estimated_cost_micros", 0) >= 0 AND coalesce("ai_cost_events"."final_cost_micros", 0) >= 0 AND "ai_cost_events"."budget_charged_micros" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_cost_events_call_unique" ON "ai_cost_events" ("hold_id", "call_index");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_cost_events_provider_request_unique" ON "ai_cost_events" ("provider", "provider_request_id") WHERE "provider_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_cost_events_created_idx" ON "ai_cost_events" ("provider", "created_at");--> statement-breakpoint

CREATE TABLE "ai_billing_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency_code" text NOT NULL,
	"source" text NOT NULL,
	"matched_events" integer NOT NULL,
	"unmatched_provider_items" integer NOT NULL,
	"unreported_local_events" integer NOT NULL,
	"local_estimated_micros" bigint NOT NULL,
	"provider_billed_micros" bigint NOT NULL,
	"provider_total_micros" bigint,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_billing_reconciliations_status_valid" CHECK ("ai_billing_reconciliations"."status" IN ('MATCHED', 'DISCREPANCY', 'INCOMPLETE')),
	CONSTRAINT "ai_billing_reconciliations_period_valid" CHECK ("ai_billing_reconciliations"."period_end" > "ai_billing_reconciliations"."period_start")
);--> statement-breakpoint

CREATE TABLE "privacy_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id"),
	"kind" text NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"details" text,
	"outcome_code" text,
	"outcome_note" text,
	"due_at" timestamp with time zone,
	"resolved_by" text REFERENCES "users"("id"),
	"resolved_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_requests_kind_valid" CHECK ("privacy_requests"."kind" IN ('ACCESS', 'EXPORT', 'CORRECTION', 'DELETION', 'CONSENT_WITHDRAWAL', 'OBJECTION', 'RESTRICTION', 'INQUIRY')),
	CONSTRAINT "privacy_requests_status_valid" CHECK ("privacy_requests"."status" IN ('RECEIVED', 'IN_REVIEW', 'COMPLETED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "privacy_requests_channel_valid" CHECK ("privacy_requests"."channel" IN ('API', 'CONVERSATION')),
	CONSTRAINT "privacy_requests_details_bounded" CHECK (char_length(coalesce("privacy_requests"."details", '')) <= 2000 AND char_length(coalesce("privacy_requests"."outcome_note", '')) <= 2000),
	CONSTRAINT "privacy_requests_resolution_consistent" CHECK (("privacy_requests"."status" IN ('COMPLETED', 'REJECTED', 'WITHDRAWN')) = ("privacy_requests"."resolved_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_requests_idempotency_unique" ON "privacy_requests" ("user_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "privacy_requests_queue_idx" ON "privacy_requests" ("status", "created_at");--> statement-breakpoint

CREATE TABLE "privacy_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL REFERENCES "privacy_requests"("id"),
	"actor_kind" text NOT NULL,
	"actor_id" text REFERENCES "users"("id"),
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_request_events_actor_valid" CHECK ("privacy_request_events"."actor_kind" IN ('USER', 'ADMIN', 'SYSTEM')),
	CONSTRAINT "privacy_request_events_note_bounded" CHECK (char_length(coalesce("privacy_request_events"."note", '')) <= 2000)
);--> statement-breakpoint
CREATE INDEX "privacy_request_events_request_idx" ON "privacy_request_events" ("request_id", "created_at");--> statement-breakpoint

CREATE TABLE "user_privacy_preferences" (
	"user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id"),
	"marketing_in_app" boolean DEFAULT false NOT NULL,
	"marketing_email" boolean DEFAULT false NOT NULL,
	"marketing_sms" boolean DEFAULT false NOT NULL,
	"marketing_push" boolean DEFAULT false NOT NULL,
	"device_location_sharing" text DEFAULT 'ASK_EACH_TIME' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_privacy_preferences_location_valid" CHECK ("user_privacy_preferences"."device_location_sharing" IN ('ASK_EACH_TIME', 'DISABLED'))
);--> statement-breakpoint

CREATE TABLE "privacy_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id"),
	"consent_key" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"policy_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_consent_events_source_valid" CHECK ("privacy_consent_events"."source" IN ('API', 'CONVERSATION', 'SYSTEM'))
);--> statement-breakpoint
CREATE INDEX "privacy_consent_events_user_idx" ON "privacy_consent_events" ("user_id", "consent_key", "created_at");--> statement-breakpoint

CREATE TABLE "billing_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_digest" text NOT NULL,
	"status" text NOT NULL,
	"subscription_id" text REFERENCES "business_subscriptions"("id"),
	"failure_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_webhook_events_status_valid" CHECK ("billing_webhook_events"."status" IN ('APPLIED', 'IGNORED', 'REJECTED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_unique" ON "billing_webhook_events" ("provider_key", "provider_event_id");--> statement-breakpoint

CREATE TABLE "trust_appeals" (
	"id" text PRIMARY KEY NOT NULL,
	"appellant_id" text NOT NULL REFERENCES "users"("id"),
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"market_id" text REFERENCES "markets"("id"),
	"original_decider_id" text REFERENCES "users"("id"),
	"statement" text NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"decision_note" text,
	"decided_by" text REFERENCES "users"("id"),
	"decided_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_appeals_subject_valid" CHECK ("trust_appeals"."subject_type" IN ('LISTING_MODERATION', 'ACCOUNT_STATUS', 'REPORT_DECISION', 'DISPUTE_RESOLUTION')),
	CONSTRAINT "trust_appeals_status_valid" CHECK ("trust_appeals"."status" IN ('SUBMITTED', 'UNDER_REVIEW', 'UPHELD', 'OVERTURNED', 'WITHDRAWN')),
	CONSTRAINT "trust_appeals_statement_bounded" CHECK (char_length("trust_appeals"."statement") BETWEEN 10 AND 2000 AND char_length(coalesce("trust_appeals"."decision_note", '')) <= 2000),
	CONSTRAINT "trust_appeals_decision_consistent" CHECK (("trust_appeals"."status" IN ('UPHELD', 'OVERTURNED')) = ("trust_appeals"."decided_by" IS NOT NULL AND "trust_appeals"."decision_note" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "trust_appeals_idempotency_unique" ON "trust_appeals" ("appellant_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_appeals_one_open_per_subject" ON "trust_appeals" ("appellant_id", "subject_type", "subject_id") WHERE "status" IN ('SUBMITTED', 'UNDER_REVIEW');--> statement-breakpoint
CREATE INDEX "trust_appeals_queue_idx" ON "trust_appeals" ("status", "created_at");--> statement-breakpoint

CREATE TABLE "trust_appeal_events" (
	"id" text PRIMARY KEY NOT NULL,
	"appeal_id" text NOT NULL REFERENCES "trust_appeals"("id"),
	"actor_kind" text NOT NULL,
	"actor_id" text REFERENCES "users"("id"),
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_appeal_events_actor_valid" CHECK ("trust_appeal_events"."actor_kind" IN ('USER', 'ADMIN'))
);--> statement-breakpoint
CREATE INDEX "trust_appeal_events_appeal_idx" ON "trust_appeal_events" ("appeal_id", "created_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION dinar_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER privacy_request_events_append_only_row BEFORE UPDATE OR DELETE ON "privacy_request_events" FOR EACH ROW EXECUTE FUNCTION dinar_append_only();--> statement-breakpoint
CREATE TRIGGER privacy_request_events_append_only_truncate BEFORE TRUNCATE ON "privacy_request_events" FOR EACH STATEMENT EXECUTE FUNCTION dinar_append_only();--> statement-breakpoint
CREATE TRIGGER privacy_consent_events_append_only_row BEFORE UPDATE OR DELETE ON "privacy_consent_events" FOR EACH ROW EXECUTE FUNCTION dinar_append_only();--> statement-breakpoint
CREATE TRIGGER privacy_consent_events_append_only_truncate BEFORE TRUNCATE ON "privacy_consent_events" FOR EACH STATEMENT EXECUTE FUNCTION dinar_append_only();--> statement-breakpoint
CREATE TRIGGER trust_appeal_events_append_only_row BEFORE UPDATE OR DELETE ON "trust_appeal_events" FOR EACH ROW EXECUTE FUNCTION dinar_append_only();--> statement-breakpoint
CREATE TRIGGER trust_appeal_events_append_only_truncate BEFORE TRUNCATE ON "trust_appeal_events" FOR EACH STATEMENT EXECUTE FUNCTION dinar_append_only();
