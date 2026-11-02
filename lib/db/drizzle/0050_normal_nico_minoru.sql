CREATE TABLE "business_employee_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"business_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"delegation_id" text NOT NULL,
	"market_id" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_employee_sessions_status_valid" CHECK ("business_employee_sessions"."status" IN ('ACTIVE', 'ENDED', 'INVALIDATED', 'EXPIRED')),
	CONSTRAINT "business_employee_sessions_end_state_valid" CHECK (("business_employee_sessions"."status" = 'ACTIVE' AND "business_employee_sessions"."ended_at" IS NULL AND "business_employee_sessions"."end_reason" IS NULL) OR ("business_employee_sessions"."status" <> 'ACTIVE' AND "business_employee_sessions"."ended_at" IS NOT NULL AND "business_employee_sessions"."end_reason" IS NOT NULL)),
	CONSTRAINT "business_employee_sessions_end_reason_valid" CHECK ("business_employee_sessions"."end_reason" IS NULL OR "business_employee_sessions"."end_reason" IN ('OWNER_STOP', 'LOGOUT', 'ACCOUNT_SWITCH', 'MARKET_CHANGE', 'GRANT_SUSPENDED', 'GRANT_REVOKED', 'GRANT_EXPIRED', 'BUSINESS_BLOCKED', 'SESSION_EXPIRED', 'SESSION_RESTARTED')),
	CONSTRAINT "business_employee_sessions_expiry_valid" CHECK ("business_employee_sessions"."expires_at" > "business_employee_sessions"."started_at")
);
--> statement-breakpoint
ALTER TABLE "business_delegations" DROP CONSTRAINT "business_delegations_capabilities_valid";--> statement-breakpoint
ALTER TABLE "business_delegations" DROP CONSTRAINT "business_delegations_resource_scope_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "business_delegations_session_authority_unique" ON "business_delegations" USING btree ("id","business_id","grantor_actor_id","market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_owner_market_unique" ON "conversations" USING btree ("id","owner_user_id","market_id");--> statement-breakpoint
ALTER TABLE "business_employee_sessions" ADD CONSTRAINT "business_employee_sessions_conversation_owner_market_fk" FOREIGN KEY ("conversation_id","owner_user_id","market_id") REFERENCES "public"."conversations"("id","owner_user_id","market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_employee_sessions" ADD CONSTRAINT "business_employee_sessions_delegation_authority_fk" FOREIGN KEY ("delegation_id","business_id","owner_user_id","market_id") REFERENCES "public"."business_delegations"("id","business_id","grantor_actor_id","market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_employee_sessions_one_active_conversation_unique" ON "business_employee_sessions" USING btree ("conversation_id") WHERE "business_employee_sessions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "business_employee_sessions_owner_status_idx" ON "business_employee_sessions" USING btree ("owner_user_id","status","last_activity_at");--> statement-breakpoint
CREATE INDEX "business_employee_sessions_delegation_status_idx" ON "business_employee_sessions" USING btree ("delegation_id","status");--> statement-breakpoint
ALTER TABLE "business_delegations" ADD CONSTRAINT "business_delegations_capabilities_valid" CHECK (jsonb_typeof("business_delegations"."capabilities") = 'array' AND jsonb_array_length("business_delegations"."capabilities") BETWEEN 1 AND 8 AND "business_delegations"."capabilities" <@ '["business.catalog.read","business.catalog.draft","business.catalog.draft.price","business.inventory.read","business.orders.read","business.inquiries.reply","business.messages.send","business.negotiations.escalate"]'::jsonb);--> statement-breakpoint
ALTER TABLE "business_delegations" ADD CONSTRAINT "business_delegations_resource_scope_valid" CHECK (jsonb_typeof("business_delegations"."resource_scope") = 'object' AND ("business_delegations"."resource_scope" = jsonb_build_object('kind', 'BUSINESS') OR ("business_delegations"."resource_scope"->>'kind' = 'LISTING_ALLOWLIST' AND "business_delegations"."resource_scope" = jsonb_build_object('kind', 'LISTING_ALLOWLIST', 'listingIds', "business_delegations"."resource_scope"->'listingIds') AND jsonb_typeof("business_delegations"."resource_scope"->'listingIds') = 'array' AND jsonb_array_length("business_delegations"."resource_scope"->'listingIds') BETWEEN 1 AND 100)));