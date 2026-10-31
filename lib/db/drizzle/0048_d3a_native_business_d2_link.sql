-- D3-A adds operating metadata to the existing D2 business identity.
-- D2 remains the only identity and verification authority; every operating profile
-- must reference exactly one D2 business owned by the same account in the same market.
CREATE UNIQUE INDEX "business_profiles_identity_owner_market_uq"
  ON "business_profiles" ("id", "owner_user_id", "market_id");
--> statement-breakpoint
CREATE TABLE "business_operating_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "d2_business_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "market_id" text NOT NULL,
  "operating_mode" text DEFAULT 'INTERNAL_DINAR' NOT NULL,
  "business_type" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_operating_profiles_d2_business_unique"
  ON "business_operating_profiles" ("d2_business_id");
--> statement-breakpoint
CREATE INDEX "business_operating_profiles_owner_idx"
  ON "business_operating_profiles" ("owner_user_id", "market_id");
--> statement-breakpoint
CREATE INDEX "business_operating_profiles_market_status_idx"
  ON "business_operating_profiles" ("market_id", "status");
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_d2_identity_fk"
  FOREIGN KEY ("d2_business_id", "owner_user_id", "market_id")
  REFERENCES "public"."business_profiles"("id", "owner_user_id", "market_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_owner_user_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_market_fk"
  FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_mode_valid"
  CHECK ("operating_mode" IN ('INTERNAL_DINAR'));
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_type_valid"
  CHECK ("business_type" IN ('RESTAURANT', 'SHOP', 'SERVICE_PROVIDER', 'OTHER'));
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_status_valid"
  CHECK ("status" IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED'));
--> statement-breakpoint
ALTER TABLE "business_operating_profiles"
  ADD CONSTRAINT "business_operating_profiles_version_valid"
  CHECK ("version" >= 1);
--> statement-breakpoint
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
CREATE INDEX "business_audit_events_business_idx"
  ON "business_audit_events" ("business_id", "created_at");
--> statement-breakpoint
ALTER TABLE "business_audit_events"
  ADD CONSTRAINT "business_audit_events_business_fk"
  FOREIGN KEY ("business_id") REFERENCES "public"."business_operating_profiles"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "business_audit_events"
  ADD CONSTRAINT "business_audit_events_actor_fk"
  FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION business_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'business_audit_events is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER business_audit_events_append_only_row
  BEFORE UPDATE OR DELETE ON "business_audit_events"
  FOR EACH ROW EXECUTE FUNCTION business_audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER business_audit_events_append_only_truncate
  BEFORE TRUNCATE ON "business_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION business_audit_events_append_only();
