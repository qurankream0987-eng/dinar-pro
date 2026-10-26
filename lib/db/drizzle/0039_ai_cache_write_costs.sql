-- Track and price provider-reported cache writes separately from ordinary and cached-read tokens.
-- Additive defaults preserve existing price and cost-event rows.
ALTER TABLE "ai_model_prices" ADD COLUMN "cache_write_input_per_million_micros" bigint;
--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD COLUMN "cache_write_12h_input_per_million_micros" bigint;
--> statement-breakpoint
ALTER TABLE "ai_cost_events" ADD COLUMN "cache_write_input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_cost_events" ADD COLUMN "cache_write_12h_input_tokens" integer DEFAULT 0 NOT NULL;
