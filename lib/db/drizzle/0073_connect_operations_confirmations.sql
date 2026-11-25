ALTER TABLE "connect_tools" ADD COLUMN "operation" jsonb;--> statement-breakpoint
CREATE TABLE "connect_action_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"arguments_digest" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"result_status" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_action_confirmations_valid" CHECK ("connect_action_confirmations"."status" IN ('PENDING','EXECUTING','SUCCEEDED','FAILED','CANCELLED','EXPIRED') AND "connect_action_confirmations"."arguments_digest" ~ '^[0-9a-f]{64}$' AND ("connect_action_confirmations"."status" IN ('PENDING','CANCELLED','EXPIRED') OR "connect_action_confirmations"."consumed_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "connect_action_confirmations" ADD CONSTRAINT "connect_action_confirmations_integration_id_connect_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."connect_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_action_confirmations" ADD CONSTRAINT "connect_action_confirmations_tool_id_connect_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."connect_tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_action_confirmations" ADD CONSTRAINT "connect_action_confirmations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_action_confirmations_actor_idx" ON "connect_action_confirmations" USING btree ("actor_id","created_at");
