ALTER TABLE "welcome_ad_exposures" ADD COLUMN "personalization_reason" text;--> statement-breakpoint
CREATE TABLE "ad_personalization_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_personalization_settings_status_valid" CHECK (status IN ('ON','OFF'))
);--> statement-breakpoint
CREATE TABLE "ad_interest_signals" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"score" double precision NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ad_interest_signals_user_id_kind_key_pk" PRIMARY KEY("user_id","kind","key"),
	CONSTRAINT "ad_interest_signals_kind_valid" CHECK ("ad_interest_signals"."kind" IN ('CATEGORY','TERM')),
	CONSTRAINT "ad_interest_signals_key_valid" CHECK (char_length("ad_interest_signals"."key") BETWEEN 1 AND 60),
	CONSTRAINT "ad_interest_signals_score_valid" CHECK ("ad_interest_signals"."score" > 0)
);--> statement-breakpoint
ALTER TABLE "ad_personalization_settings" ADD CONSTRAINT "ad_personalization_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_interest_signals" ADD CONSTRAINT "ad_interest_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_interest_signals_user_idx" ON "ad_interest_signals" USING btree ("user_id","last_seen_at");
