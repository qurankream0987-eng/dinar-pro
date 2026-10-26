CREATE TABLE "candidate_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"professional_title" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"experience_years" integer,
	"experiences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"education" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"workplace_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"employment_type_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"portfolio_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contact_mode" text DEFAULT 'NO_DIRECT_CONTACT' NOT NULL,
	"contact_phone" text,
	"visibility" text DEFAULT 'PRIVATE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "candidate_profiles_visibility_valid" CHECK ("candidate_profiles"."visibility" IN ('PRIVATE', 'DISCOVERABLE')),
	CONSTRAINT "candidate_profiles_contact_mode_valid" CHECK ("candidate_profiles"."contact_mode" IN ('NO_DIRECT_CONTACT', 'PROFILE_CONTACT')),
	CONSTRAINT "candidate_profiles_contact_consistent" CHECK (("candidate_profiles"."contact_mode" = 'PROFILE_CONTACT') = ("candidate_profiles"."contact_phone" IS NOT NULL)),
	CONSTRAINT "candidate_profiles_experience_valid" CHECK ("candidate_profiles"."experience_years" IS NULL OR "candidate_profiles"."experience_years" BETWEEN 0 AND 60),
	CONSTRAINT "candidate_profiles_title_length" CHECK (char_length("candidate_profiles"."professional_title") <= 120),
	CONSTRAINT "candidate_profiles_summary_length" CHECK (char_length("candidate_profiles"."summary") <= 2000),
	CONSTRAINT "candidate_profiles_arrays" CHECK (jsonb_typeof("candidate_profiles"."skills") = 'array' AND jsonb_array_length("candidate_profiles"."skills") <= 40 AND jsonb_typeof("candidate_profiles"."experiences") = 'array' AND jsonb_array_length("candidate_profiles"."experiences") <= 20 AND jsonb_typeof("candidate_profiles"."education") = 'array' AND jsonb_array_length("candidate_profiles"."education") <= 10 AND jsonb_typeof("candidate_profiles"."portfolio_links") = 'array' AND jsonb_array_length("candidate_profiles"."portfolio_links") <= 5)
);
--> statement-breakpoint
CREATE TABLE "job_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"candidate_user_id" text NOT NULL,
	"candidate_profile_id" text NOT NULL,
	"market_id" text NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"job_snapshot" jsonb NOT NULL,
	"candidate_snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"status_changed_by" text,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_applications_status_valid" CHECK ("job_applications"."status" IN ('SUBMITTED', 'VIEWED', 'SHORTLISTED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "job_applications_withdrawal_consistent" CHECK (("job_applications"."status" = 'WITHDRAWN') = ("job_applications"."withdrawn_at" IS NOT NULL)),
	CONSTRAINT "job_applications_status_actor_consistent" CHECK (("job_applications"."status_changed_by" IS NULL) = ("job_applications"."status_changed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_experience_years" integer,
	"city" text DEFAULT '' NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"workplace_mode" text NOT NULL,
	"employment_type" text NOT NULL,
	"salary_min_minor" integer,
	"salary_max_minor" integer,
	"salary_currency" text,
	"salary_period" text,
	"version" integer DEFAULT 1 NOT NULL,
	"publish_key" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" IN ('PUBLISHED', 'PAUSED', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "jobs_title_length" CHECK (char_length(btrim("jobs"."title")) BETWEEN 2 AND 120),
	CONSTRAINT "jobs_description_length" CHECK (char_length("jobs"."description") <= 4000),
	CONSTRAINT "jobs_skills_array" CHECK (jsonb_typeof("jobs"."skills") = 'array' AND jsonb_array_length("jobs"."skills") <= 30),
	CONSTRAINT "jobs_experience_valid" CHECK ("jobs"."min_experience_years" IS NULL OR "jobs"."min_experience_years" BETWEEN 0 AND 50),
	CONSTRAINT "jobs_workplace_mode_valid" CHECK ("jobs"."workplace_mode" IN ('ONSITE', 'REMOTE', 'HYBRID')),
	CONSTRAINT "jobs_employment_type_valid" CHECK ("jobs"."employment_type" IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP')),
	CONSTRAINT "jobs_location_valid" CHECK ("jobs"."workplace_mode" = 'REMOTE' OR char_length(btrim("jobs"."city")) > 0),
	CONSTRAINT "jobs_salary_valid" CHECK (("jobs"."salary_min_minor" IS NULL AND "jobs"."salary_max_minor" IS NULL AND "jobs"."salary_currency" IS NULL AND "jobs"."salary_period" IS NULL) OR ("jobs"."salary_min_minor" IS NOT NULL AND "jobs"."salary_min_minor" >= 1 AND ("jobs"."salary_max_minor" IS NULL OR "jobs"."salary_max_minor" >= "jobs"."salary_min_minor") AND "jobs"."salary_currency" IS NOT NULL AND "jobs"."salary_period" IN ('HOUR', 'DAY', 'MONTH', 'YEAR'))),
	CONSTRAINT "jobs_lifecycle_consistent" CHECK (("jobs"."status" IN ('PUBLISHED', 'PAUSED') AND "jobs"."closed_at" IS NULL AND "jobs"."archived_at" IS NULL) OR ("jobs"."status" = 'CLOSED' AND "jobs"."closed_at" IS NOT NULL AND "jobs"."archived_at" IS NULL) OR ("jobs"."status" = 'ARCHIVED' AND "jobs"."archived_at" IS NOT NULL)),
	CONSTRAINT "jobs_version_positive" CHECK ("jobs"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_candidate_user_id_users_id_fk" FOREIGN KEY ("candidate_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_candidate_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_profiles_market_visibility_idx" ON "candidate_profiles" USING btree ("market_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "job_applications_job_candidate_unique" ON "job_applications" USING btree ("job_id","candidate_user_id");--> statement-breakpoint
CREATE INDEX "job_applications_job_submitted_idx" ON "job_applications" USING btree ("job_id","submitted_at");--> statement-breakpoint
CREATE INDEX "job_applications_candidate_submitted_idx" ON "job_applications" USING btree ("candidate_user_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_owner_publish_key_unique" ON "jobs" USING btree ("owner_user_id","publish_key");--> statement-breakpoint
CREATE INDEX "jobs_market_status_published_idx" ON "jobs" USING btree ("market_id","status","published_at");--> statement-breakpoint
CREATE INDEX "jobs_owner_updated_idx" ON "jobs" USING btree ("owner_user_id","updated_at");