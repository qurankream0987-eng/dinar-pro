-- Merchant policies (M1, owner approval 2026-11-28): a store's own commercial rules, managed in
-- natural language through Jassim but stored and enforced as validated, versioned settings.
-- Additive only: three new tables; nothing existing is changed.
-- * merchant_policies: one row per version. PROPOSED -> ACTIVE (after the required confirmation)
--   -> REPLACED/REVOKED; CANCELLED for an unconfirmed proposal. At most one ACTIVE per
--   (business, kind, scope). Rules are JSON validated per kind by the server.
-- * merchant_policy_grants: what the owner delegated to whom, as explicit permission scopes (no
--   fixed roles). Financial scopes are never implied by any other scope.
-- * merchant_policy_events: append-only audit of every proposal, confirmation, replacement,
--   revocation and grant change, with actor, time, and before/after values (secrets masked).
CREATE TABLE "merchant_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"market_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ref" text,
	"rule" jsonb NOT NULL,
	"sensitivity" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"source_text" text,
	"version" integer NOT NULL,
	"supersedes_id" text,
	"proposed_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_policies_kind_valid" CHECK ("merchant_policies"."kind" IN ('PAYMENT_METHODS', 'PAYMENT_GATEWAY', 'PAYOUT_DETAILS', 'SHIPPING', 'COD_AREAS', 'OUT_OF_STOCK', 'PRE_ORDER', 'ALTERNATIVES', 'MIN_ORDER', 'ORDERING_PAUSED', 'GEO_RESTRICTION', 'PRICE_NEGOTIATION', 'DISCOUNT', 'BULK_INQUIRY', 'B2B_QUESTIONS')),
	CONSTRAINT "merchant_policies_scope_valid" CHECK ("merchant_policies"."scope_kind" IN ('STORE', 'PRODUCT', 'CATEGORY', 'REGION') AND (("merchant_policies"."scope_kind" = 'STORE') = ("merchant_policies"."scope_ref" IS NULL))),
	CONSTRAINT "merchant_policies_sensitivity_valid" CHECK ("merchant_policies"."sensitivity" IN ('NORMAL', 'SENSITIVE', 'HIGH_RISK')),
	CONSTRAINT "merchant_policies_status_valid" CHECK ("merchant_policies"."status" IN ('PROPOSED', 'ACTIVE', 'REPLACED', 'REVOKED', 'CANCELLED')),
	CONSTRAINT "merchant_policies_source_valid" CHECK ("merchant_policies"."source" IN ('CHAT', 'API')),
	CONSTRAINT "merchant_policies_rule_object" CHECK (jsonb_typeof("merchant_policies"."rule") = 'object'),
	CONSTRAINT "merchant_policies_version_positive" CHECK ("merchant_policies"."version" >= 1),
	CONSTRAINT "merchant_policies_confirmed_consistent" CHECK (("merchant_policies"."status" NOT IN ('ACTIVE', 'REPLACED') OR ("merchant_policies"."confirmed_by" IS NOT NULL AND "merchant_policies"."confirmed_at" IS NOT NULL)) AND ("merchant_policies"."status" NOT IN ('PROPOSED', 'CANCELLED') OR "merchant_policies"."confirmed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_supersedes_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."merchant_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_policies_one_active" ON "merchant_policies" USING btree ("business_id","kind","scope_kind",coalesce("scope_ref", '')) WHERE "merchant_policies"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "merchant_policies_business_idx" ON "merchant_policies" USING btree ("business_id","status","kind");--> statement-breakpoint
CREATE TABLE "merchant_policy_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"grantee_user_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"status" text NOT NULL,
	"granted_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_policy_grants_status_valid" CHECK ("merchant_policy_grants"."status" IN ('ACTIVE', 'REVOKED')),
	CONSTRAINT "merchant_policy_grants_scopes_valid" CHECK (jsonb_typeof("merchant_policy_grants"."scopes") = 'array' AND "merchant_policy_grants"."scopes" <@ '["policy.products","policy.inventory","policy.shipping","policy.orders","policy.discounts","policy.negotiation","policy.payment_methods","policy.payment_gateway","policy.payout_details","policy.financial_data","policy.store_pause"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "merchant_policy_grants" ADD CONSTRAINT "merchant_policy_grants_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policy_grants" ADD CONSTRAINT "merchant_policy_grants_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policy_grants" ADD CONSTRAINT "merchant_policy_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_policy_grants_one_active" ON "merchant_policy_grants" USING btree ("business_id","grantee_user_id") WHERE "merchant_policy_grants"."status" = 'ACTIVE';--> statement-breakpoint
CREATE TABLE "merchant_policy_events" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"policy_id" text,
	"grant_id" text,
	"actor_id" text NOT NULL,
	"event" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_policy_events_target" CHECK ("merchant_policy_events"."policy_id" IS NOT NULL OR "merchant_policy_events"."grant_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "merchant_policy_events" ADD CONSTRAINT "merchant_policy_events_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policy_events" ADD CONSTRAINT "merchant_policy_events_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."merchant_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policy_events" ADD CONSTRAINT "merchant_policy_events_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."merchant_policy_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policy_events" ADD CONSTRAINT "merchant_policy_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_policy_events_business_idx" ON "merchant_policy_events" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE TRIGGER merchant_policy_events_reject_update_delete
BEFORE UPDATE OR DELETE ON merchant_policy_events
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER merchant_policy_events_reject_truncate
BEFORE TRUNCATE ON merchant_policy_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();
