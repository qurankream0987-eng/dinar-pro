CREATE UNIQUE INDEX "business_operating_profiles_owner_market_unique" ON "business_operating_profiles" USING btree ("id","owner_user_id","market_id");--> statement-breakpoint
CREATE TABLE "business_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"market_id" text NOT NULL,
	"grantor_actor_id" text NOT NULL,
	"employee_type" text NOT NULL,
	"employee_user_id" text,
	"agent_configuration_id" text,
	"capabilities" jsonb NOT NULL,
	"resource_scope" jsonb NOT NULL,
	"approval_required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"policy_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_delegations_employee_type_valid" CHECK ("business_delegations"."employee_type" IN ('HUMAN', 'INTELLIGENT')),
	CONSTRAINT "business_delegations_employee_identity_valid" CHECK (("business_delegations"."employee_type" = 'HUMAN' AND "business_delegations"."employee_user_id" IS NOT NULL AND "business_delegations"."agent_configuration_id" IS NULL AND "business_delegations"."employee_user_id" <> "business_delegations"."grantor_actor_id") OR ("business_delegations"."employee_type" = 'INTELLIGENT' AND "business_delegations"."employee_user_id" IS NULL AND "business_delegations"."agent_configuration_id" IS NOT NULL)),
	CONSTRAINT "business_delegations_capabilities_valid" CHECK (jsonb_typeof("business_delegations"."capabilities") = 'array' AND jsonb_array_length("business_delegations"."capabilities") = 1 AND "business_delegations"."capabilities"->>0 = 'business.catalog.read'),
	CONSTRAINT "business_delegations_resource_scope_valid" CHECK (jsonb_typeof("business_delegations"."resource_scope") = 'object' AND ("business_delegations"."resource_scope" = jsonb_build_object('kind', 'BUSINESS') OR ("business_delegations"."resource_scope"->>'kind' = 'LISTING_ALLOWLIST' AND "business_delegations"."resource_scope" = jsonb_build_object('kind', 'LISTING_ALLOWLIST', 'listingIds', "business_delegations"."resource_scope"->'listingIds') AND jsonb_typeof("business_delegations"."resource_scope"->'listingIds') = 'array' AND jsonb_array_length("business_delegations"."resource_scope"->'listingIds') BETWEEN 1 AND 100))),
	CONSTRAINT "business_delegations_approval_capabilities_valid" CHECK (jsonb_typeof("business_delegations"."approval_required_capabilities") = 'array'),
	CONSTRAINT "business_delegations_status_valid" CHECK ("business_delegations"."status" IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
	CONSTRAINT "business_delegations_policy_version_valid" CHECK (char_length(btrim("business_delegations"."policy_version")) BETWEEN 1 AND 80),
	CONSTRAINT "business_delegations_version_valid" CHECK ("business_delegations"."version" >= 1),
	CONSTRAINT "business_delegations_expiry_valid" CHECK ("business_delegations"."expires_at" > "business_delegations"."created_at"),
	CONSTRAINT "business_delegations_revoked_timestamp_valid" CHECK (("business_delegations"."status" = 'REVOKED') = ("business_delegations"."revoked_at" IS NOT NULL)),
	CONSTRAINT "business_delegations_expired_timestamp_valid" CHECK (("business_delegations"."status" = 'EXPIRED') = ("business_delegations"."expired_at" IS NOT NULL)),
	CONSTRAINT "business_delegations_activated_timestamp_valid" CHECK ("business_delegations"."status" NOT IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED') OR "business_delegations"."activated_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "business_delegations" ADD CONSTRAINT "business_delegations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_delegations" ADD CONSTRAINT "business_delegations_grantor_actor_id_users_id_fk" FOREIGN KEY ("grantor_actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_delegations" ADD CONSTRAINT "business_delegations_employee_user_id_users_id_fk" FOREIGN KEY ("employee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_delegations" ADD CONSTRAINT "business_delegations_owner_market_fk" FOREIGN KEY ("business_id","grantor_actor_id","market_id") REFERENCES "public"."business_operating_profiles"("id","owner_user_id","market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_delegations_idempotency_unique" ON "business_delegations" USING btree ("business_id","grantor_actor_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "business_delegations_agent_configuration_unique" ON "business_delegations" USING btree ("agent_configuration_id") WHERE "business_delegations"."agent_configuration_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "business_delegations_business_status_idx" ON "business_delegations" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "business_delegations_human_employee_idx" ON "business_delegations" USING btree ("employee_user_id","status");
