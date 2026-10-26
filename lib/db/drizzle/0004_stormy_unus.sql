ALTER TABLE "disputes" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "area" text DEFAULT '' NOT NULL;