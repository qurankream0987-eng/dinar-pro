CREATE TABLE "email_verification_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"code_digest" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_challenges_email_length" CHECK (char_length("email_verification_challenges"."email") BETWEEN 3 AND 320),
	CONSTRAINT "email_verification_challenges_digest_shape" CHECK ("email_verification_challenges"."code_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_verification_challenges_attempts_valid" CHECK ("email_verification_challenges"."failed_attempts" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "notification_email_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"template_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_email_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "notification_email_jobs_template_valid" CHECK ("notification_email_jobs"."template_key" IN ('BUYER_INTEREST', 'OFFER_PUBLISHED')),
	CONSTRAINT "notification_email_jobs_status_valid" CHECK ("notification_email_jobs"."status" IN ('PENDING', 'PROCESSING', 'SENT', 'CANCELLED', 'FAILED')),
	CONSTRAINT "notification_email_jobs_attempts_valid" CHECK ("notification_email_jobs"."attempt_count" BETWEEN 0 AND 5)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_verification_challenges" ADD CONSTRAINT "email_verification_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_email_jobs" ADD CONSTRAINT "notification_email_jobs_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_challenges_one_open_user" ON "email_verification_challenges" USING btree ("user_id") WHERE "email_verification_challenges"."consumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_challenges_one_open_email" ON "email_verification_challenges" USING btree ("email") WHERE "email_verification_challenges"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_verification_challenges_email_created_idx" ON "email_verification_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "notification_email_jobs_pending_idx" ON "notification_email_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "notification_email_jobs_recipient_idx" ON "notification_email_jobs" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email") WHERE "users"."email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_length" CHECK ("users"."email" IS NULL OR char_length("users"."email") BETWEEN 3 AND 320);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_verification_consistent" CHECK (("users"."email" IS NULL) = ("users"."email_verified_at" IS NULL));--> statement-breakpoint