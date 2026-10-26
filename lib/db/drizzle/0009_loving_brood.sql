CREATE TABLE "marketplace_category_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketplace_category_audit" ADD CONSTRAINT "marketplace_category_audit_category_id_marketplace_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_category_audit" ADD CONSTRAINT "marketplace_category_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_category_audit_category_created_idx" ON "marketplace_category_audit" USING btree ("category_id","created_at");