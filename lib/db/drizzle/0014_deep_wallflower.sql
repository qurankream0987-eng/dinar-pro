CREATE TABLE "phone_verification_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_hash" text NOT NULL,
	"code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"registration_token_hash" text,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verification_attempts_valid" CHECK ("phone_verification_challenges"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "phone_verification_state_consistent" CHECK (("phone_verification_challenges"."verified_at" IS NULL) = ("phone_verification_challenges"."registration_token_hash" IS NULL)),
	CONSTRAINT "phone_verification_consumption_requires_proof" CHECK ("phone_verification_challenges"."consumed_at" IS NULL OR "phone_verification_challenges"."verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_registration_token_unique" ON "phone_verification_challenges" USING btree ("registration_token_hash");--> statement-breakpoint
CREATE INDEX "phone_verification_phone_created_idx" ON "phone_verification_challenges" USING btree ("phone_hash","created_at");--> statement-breakpoint
CREATE INDEX "phone_verification_expiry_idx" ON "phone_verification_challenges" USING btree ("expires_at");