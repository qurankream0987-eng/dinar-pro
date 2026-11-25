CREATE TABLE "connect_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"market_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"steps" jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_workflows_status_valid" CHECK ("connect_workflows"."status" IN ('PENDING','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED') AND ("connect_workflows"."status" IN ('PENDING','CANCELLED','EXPIRED') OR "connect_workflows"."started_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "connect_workflows" ADD CONSTRAINT "connect_workflows_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_workflows" ADD CONSTRAINT "connect_workflows_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_workflows_actor_idx" ON "connect_workflows" USING btree ("actor_id","created_at");
