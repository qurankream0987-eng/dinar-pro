-- DINAR NEXT: model prices are entered by an admin through the API; record who entered each version.
-- Additive and nullable: existing rows (test placeholders) keep a null author.
ALTER TABLE "ai_model_prices" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
