CREATE TABLE "auth_rate_limit_buckets" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_rate_limit_attempts_valid" CHECK ("auth_rate_limit_buckets"."attempts" BETWEEN 1 AND 21)
);
--> statement-breakpoint
CREATE INDEX "auth_rate_limit_reset_idx" ON "auth_rate_limit_buckets" USING btree ("reset_at");