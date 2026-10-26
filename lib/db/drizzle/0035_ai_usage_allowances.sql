-- DINAR NEXT G1: AI usage allowances. Reservation rows are the idempotent ledger;
-- counters are their materialised totals. No prompt or reply text is stored.
CREATE TABLE "ai_usage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_key" text NOT NULL,
	"user_id" text REFERENCES "users"("id"),
	"market_id" text REFERENCES "markets"("id"),
	"resource" text NOT NULL,
	"plan_tier" text NOT NULL,
	"entitlement_source" text NOT NULL,
	"policy_version" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"global_period_start" timestamp with time zone NOT NULL,
	"global_guarded" boolean NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"outcome" text,
	"reserved_requests" integer NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"charged_requests" integer DEFAULT 0 NOT NULL,
	"charged_tokens" integer DEFAULT 0 NOT NULL,
	"provider_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"token_source" text,
	"provider" text,
	"model" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_reservations_status_valid" CHECK ("ai_usage_reservations"."status" IN ('RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED')),
	CONSTRAINT "ai_usage_reservations_outcome_valid" CHECK ("ai_usage_reservations"."outcome" IS NULL OR "ai_usage_reservations"."outcome" IN ('SUCCESS', 'PROVIDER_FAILED', 'TIMEOUT', 'INVALID_OUTPUT', 'ABANDONED', 'CANCELLED')),
	CONSTRAINT "ai_usage_reservations_tier_valid" CHECK ("ai_usage_reservations"."plan_tier" IN ('GUEST', 'FREE', 'BUSINESS_GO', 'BUSINESS_PRO')),
	CONSTRAINT "ai_usage_reservations_resource_valid" CHECK ("ai_usage_reservations"."resource" IN ('TEXT_REQUEST', 'MARKETING_GENERATION', 'BUSINESS_ANALYTICS', 'IMAGE_UNDERSTANDING', 'AGENT_MULTI_STEP')),
	CONSTRAINT "ai_usage_reservations_amounts_valid" CHECK ("ai_usage_reservations"."reserved_requests" >= 0 AND "ai_usage_reservations"."reserved_tokens" >= 0 AND "ai_usage_reservations"."charged_requests" >= 0 AND "ai_usage_reservations"."charged_tokens" >= 0 AND "ai_usage_reservations"."provider_calls" >= 0),
	CONSTRAINT "ai_usage_reservations_settled_consistent" CHECK (("ai_usage_reservations"."status" = 'RESERVED') = ("ai_usage_reservations"."settled_at" IS NULL)),
	CONSTRAINT "ai_usage_reservations_token_source_valid" CHECK ("ai_usage_reservations"."token_source" IS NULL OR "ai_usage_reservations"."token_source" IN ('PROVIDER_REPORTED', 'ESTIMATED', 'NONE')),
	CONSTRAINT "ai_usage_reservations_period_valid" CHECK ("ai_usage_reservations"."period_end" > "ai_usage_reservations"."period_start")
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_reservations_owner_key_unique" ON "ai_usage_reservations" ("owner_key", "idempotency_key");--> statement-breakpoint
CREATE INDEX "ai_usage_reservations_owner_status_idx" ON "ai_usage_reservations" ("owner_key", "status", "expires_at");--> statement-breakpoint
CREATE INDEX "ai_usage_reservations_status_expiry_idx" ON "ai_usage_reservations" ("status", "expires_at");--> statement-breakpoint
CREATE TABLE "ai_usage_counters" (
	"owner_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"resource" text NOT NULL,
	"reserved_requests" integer DEFAULT 0 NOT NULL,
	"consumed_requests" integer DEFAULT 0 NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"consumed_tokens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_counters_owner_key_period_start_resource_pk" PRIMARY KEY("owner_key","period_start","resource"),
	CONSTRAINT "ai_usage_counters_non_negative" CHECK ("ai_usage_counters"."reserved_requests" >= 0 AND "ai_usage_counters"."consumed_requests" >= 0 AND "ai_usage_counters"."reserved_tokens" >= 0 AND "ai_usage_counters"."consumed_tokens" >= 0),
	CONSTRAINT "ai_usage_counters_resource_valid" CHECK ("ai_usage_counters"."resource" IN ('TEXT_REQUEST', 'MARKETING_GENERATION', 'BUSINESS_ANALYTICS', 'IMAGE_UNDERSTANDING', 'AGENT_MULTI_STEP', 'ALL'))
);
