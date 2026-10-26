CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"scopes" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_status_valid" CHECK ("provider_connections"."status" IN ('ACTIVE', 'REVOKED')),
	CONSTRAINT "provider_connections_revoked_consistent" CHECK (("provider_connections"."status" = 'REVOKED') = ("provider_connections"."revoked_at" IS NOT NULL)),
	CONSTRAINT "provider_connections_name_length" CHECK (char_length("provider_connections"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credentials_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "provider_resource_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"external_ref" text NOT NULL,
	"resource_id" text NOT NULL,
	"payload_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_resource_mappings_type_valid" CHECK ("provider_resource_mappings"."resource_type" IN ('LISTING', 'DRIVER_PROFILE')),
	CONSTRAINT "provider_resource_mappings_ref_valid" CHECK ("provider_resource_mappings"."external_ref" ~ '^[A-Za-z0-9._:-]{1,100}$')
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_resource_mappings" ADD CONSTRAINT "provider_resource_mappings_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_connections_owner_idx" ON "provider_connections" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_one_active_per_connection" ON "provider_credentials" USING btree ("connection_id") WHERE "provider_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resource_mappings_external_unique" ON "provider_resource_mappings" USING btree ("connection_id","resource_type","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resource_mappings_resource_unique" ON "provider_resource_mappings" USING btree ("resource_type","resource_id");