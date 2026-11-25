ALTER TABLE "connect_integrations" ADD COLUMN "lifecycle" text DEFAULT 'SETUP_PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD COLUMN "granted_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD COLUMN "authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD COLUMN "verification_failure" text;--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD CONSTRAINT "connect_integrations_lifecycle_valid" CHECK ("connect_integrations"."lifecycle" IN ('SETUP_PENDING','AUTHORIZED','AUTHENTICATED','VERIFIED','SUSPENDED','REVOKED') AND ("connect_integrations"."lifecycle" <> 'VERIFIED' OR "connect_integrations"."verified_at" IS NOT NULL));--> statement-breakpoint
CREATE TABLE "connect_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"name" text NOT NULL,
	"input_schema_sha256" text NOT NULL,
	"capability" text NOT NULL,
	"access" text NOT NULL,
	"status" text DEFAULT 'DISCOVERED' NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authorized_by" text,
	"authorized_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "connect_tools_valid" CHECK ("connect_tools"."status" IN ('DISCOVERED','AUTHORIZED','REVOKED') AND "connect_tools"."access" IN ('READ','WRITE')
        AND "connect_tools"."capability" IN ('READ','SEARCH','DISCOVER','OBSERVE','TRACK','CREATE','UPDATE','DELETE','BOOK','SCHEDULE','MESSAGE','PAY','REFUND','CANCEL')
        AND ("connect_tools"."access" = 'WRITE') = ("connect_tools"."capability" IN ('CREATE','UPDATE','DELETE','BOOK','SCHEDULE','MESSAGE','PAY','REFUND','CANCEL'))
        AND ("connect_tools"."status" <> 'AUTHORIZED' OR ("connect_tools"."authorized_by" IS NOT NULL AND "connect_tools"."authorized_at" IS NOT NULL))
        AND "connect_tools"."input_schema_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "connect_tools" ADD CONSTRAINT "connect_tools_integration_id_connect_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."connect_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_tools" ADD CONSTRAINT "connect_tools_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connect_tools_identity_unique" ON "connect_tools" USING btree ("integration_id","name","input_schema_sha256");--> statement-breakpoint
CREATE INDEX "connect_tools_integration_status_idx" ON "connect_tools" USING btree ("integration_id","status");
