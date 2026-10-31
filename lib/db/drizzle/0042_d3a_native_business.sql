-- D3-A: native DINAR businesses without an external website.
-- Additive only. A business operating profile is D3-owned conversation/marketplace state keyed by
-- the owner's account and market; D2 business identity and verification stay external and are
-- never written here (identity_status can only be PENDING_D2 until D2 publishes a contract).
CREATE TABLE "business_operating_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"d2_business_id" text,
	"owner_user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"operating_mode" text DEFAULT 'INTERNAL_DINAR' NOT NULL,
	"business_type" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"identity_status" text DEFAULT 'PENDING_D2' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_profiles_d2_unique" ON "business_operating_profiles" ("d2_business_id","market_id") WHERE "d2_business_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "business_profiles_owner_idx" ON "business_operating_profiles" ("owner_user_id","market_id");--> statement-breakpoint
CREATE INDEX "business_profiles_market_status_idx" ON "business_operating_profiles" ("market_id","status");--> statement-breakpoint
ALTER TABLE "business_operating_profiles" ADD CONSTRAINT "business_operating_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_operating_profiles" ADD CONSTRAINT "business_operating_profiles_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_operating_profiles" ADD CONSTRAINT "business_profiles_mode_valid" CHECK ("operating_mode" IN ('INTERNAL_DINAR'));--> statement-breakpoint
ALTER TABLE "business_operating_profiles" ADD CONSTRAINT "business_profiles_type_valid" CHECK ("business_type" IN ('RESTAURANT', 'SHOP', 'SERVICE_PROVIDER', 'OTHER'));--> statement-breakpoint
ALTER TABLE "business_operating_profiles" ADD CONSTRAINT "business_profiles_status_valid" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED'));--> statement-breakpoint
ALTER TABLE "business_operating_profiles" ADD CONSTRAINT "business_profiles_identity_pending_only" CHECK ("identity_status" = 'PENDING_D2');--> statement-breakpoint
CREATE TABLE "business_listing_links" (
	"listing_id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"market_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_listing_links_business_idx" ON "business_listing_links" ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "business_listing_links_market_idx" ON "business_listing_links" ("market_id");--> statement-breakpoint
ALTER TABLE "business_listing_links" ADD CONSTRAINT "business_listing_links_listing_id_offers_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_listing_links" ADD CONSTRAINT "business_listing_links_business_id_business_operating_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_operating_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_listing_links" ADD CONSTRAINT "business_listing_links_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "business_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_audit_events_business_idx" ON "business_audit_events" ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "business_audit_events" ADD CONSTRAINT "business_audit_events_business_id_business_operating_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_operating_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_audit_events" ADD CONSTRAINT "business_audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Audit rows are evidence: never rewritten or deleted.
CREATE OR REPLACE FUNCTION business_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'business_audit_events is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER business_audit_events_append_only_row
BEFORE UPDATE OR DELETE ON "business_audit_events"
FOR EACH ROW EXECUTE FUNCTION business_audit_events_append_only();--> statement-breakpoint
CREATE TRIGGER business_audit_events_append_only_truncate
BEFORE TRUNCATE ON "business_audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION business_audit_events_append_only();
