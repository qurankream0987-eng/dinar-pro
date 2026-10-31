CREATE TABLE "business_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_memberships_role_valid" CHECK ("business_memberships"."role" IN ('APPLICANT', 'VERIFIED_OWNER', 'ADMIN', 'STAFF')),
	CONSTRAINT "business_memberships_status_valid" CHECK ("business_memberships"."status" IN ('ACTIVE', 'REVOKED'))
);
--> statement-breakpoint
CREATE TABLE "business_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"display_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"legal_name" text,
	"legal_form" text,
	"category_key" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opening_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"integration_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registration_number_sha256" text,
	"registration_number_last4" text,
	"verification_status" text DEFAULT 'DRAFT' NOT NULL,
	"publication_status" text DEFAULT 'UNPUBLISHED' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"suspended_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_profiles_display_name_valid" CHECK (char_length(btrim("business_profiles"."display_name")) BETWEEN 2 AND 120),
	CONSTRAINT "business_profiles_normalized_name_valid" CHECK (char_length("business_profiles"."normalized_name") BETWEEN 1 AND 120),
	CONSTRAINT "business_profiles_legal_name_valid" CHECK ("business_profiles"."legal_name" IS NULL OR char_length(btrim("business_profiles"."legal_name")) BETWEEN 2 AND 200),
	CONSTRAINT "business_profiles_legal_form_valid" CHECK ("business_profiles"."legal_form" IS NULL OR "business_profiles"."legal_form" IN ('SOLE_PROPRIETORSHIP', 'COMPANY', 'PARTNERSHIP', 'OTHER')),
	CONSTRAINT "business_profiles_category_valid" CHECK ("business_profiles"."category_key" ~ '^[A-Z][A-Z_]{1,39}$'),
	CONSTRAINT "business_profiles_description_valid" CHECK (char_length("business_profiles"."description") <= 1000),
	CONSTRAINT "business_profiles_json_valid" CHECK (jsonb_typeof("business_profiles"."contact") = 'object' AND jsonb_typeof("business_profiles"."address") = 'object' AND jsonb_typeof("business_profiles"."opening_hours") = 'array' AND jsonb_typeof("business_profiles"."service_preferences") = 'object' AND jsonb_typeof("business_profiles"."integration_preferences") = 'object'),
	CONSTRAINT "business_profiles_registration_valid" CHECK (("business_profiles"."registration_number_sha256" IS NULL AND "business_profiles"."registration_number_last4" IS NULL) OR ("business_profiles"."registration_number_sha256" ~ '^[0-9a-f]{64}$' AND "business_profiles"."registration_number_last4" ~ '^[0-9A-Za-z]{1,4}$')),
	CONSTRAINT "business_profiles_status_valid" CHECK ("business_profiles"."verification_status" IN ('DRAFT', 'DOCUMENTS_REQUIRED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED')),
	CONSTRAINT "business_profiles_publication_valid" CHECK ("business_profiles"."publication_status" IN ('UNPUBLISHED', 'PUBLISHED')),
	CONSTRAINT "business_profiles_publication_requires_verified" CHECK ("business_profiles"."publication_status" = 'UNPUBLISHED' OR "business_profiles"."verification_status" = 'VERIFIED'),
	CONSTRAINT "business_profiles_verified_by_reviewer" CHECK ("business_profiles"."verification_status" NOT IN ('VERIFIED', 'SUSPENDED') OR ("business_profiles"."verified_at" IS NOT NULL AND "business_profiles"."verified_by" IS NOT NULL AND "business_profiles"."verified_by" <> "business_profiles"."owner_user_id")),
	CONSTRAINT "business_profiles_suspended_at" CHECK (("business_profiles"."verification_status" = 'SUSPENDED') = ("business_profiles"."suspended_at" IS NOT NULL)),
	CONSTRAINT "business_profiles_revision_valid" CHECK ("business_profiles"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "business_verification_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"object_path" text NOT NULL,
	"object_generation" text,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text DEFAULT 'UPLOAD_PENDING' NOT NULL,
	"scan_status" text DEFAULT 'NOT_SCANNED' NOT NULL,
	"purpose" text DEFAULT 'BUSINESS_VERIFICATION' NOT NULL,
	"retain_until" timestamp with time zone,
	"review_note" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_verification_documents_kind_valid" CHECK ("business_verification_documents"."kind" IN ('COMMERCIAL_REGISTRATION', 'COMMERCIAL_LICENSE', 'MUNICIPALITY_LICENSE', 'AUTHORIZATION_LETTER', 'OWNER_IDENTITY')),
	CONSTRAINT "business_verification_documents_path_valid" CHECK ("business_verification_documents"."object_path" ~ '^/objects/business-documents/[A-Za-z0-9-]+/[A-Za-z0-9.-]+$' AND position("business_verification_documents"."owner_user_id" in "business_verification_documents"."object_path") = 29),
	CONSTRAINT "business_verification_documents_type_valid" CHECK ("business_verification_documents"."content_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "business_verification_documents_size_valid" CHECK ("business_verification_documents"."size_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "business_verification_documents_status_valid" CHECK ("business_verification_documents"."status" IN ('UPLOAD_PENDING', 'UPLOADED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
	CONSTRAINT "business_verification_documents_scan_valid" CHECK ("business_verification_documents"."scan_status" IN ('NOT_SCANNED', 'CLEAN', 'INFECTED')),
	CONSTRAINT "business_verification_documents_accept_requires_clean" CHECK ("business_verification_documents"."status" <> 'ACCEPTED' OR "business_verification_documents"."scan_status" = 'CLEAN'),
	CONSTRAINT "business_verification_documents_purpose_valid" CHECK ("business_verification_documents"."purpose" = 'BUSINESS_VERIFICATION')
);
--> statement-breakpoint
CREATE TABLE "business_verification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_verification_events_actor_valid" CHECK ("business_verification_events"."actor_kind" IN ('OWNER', 'REVIEWER', 'SYSTEM')),
	CONSTRAINT "business_verification_events_action_valid" CHECK ("business_verification_events"."action" IN ('CREATED', 'UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_SCANNED', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'DOCUMENTS_REQUESTED', 'SUSPENDED', 'REINSTATED', 'PUBLISHED', 'UNPUBLISHED', 'DOCUMENT_ACCESSED')),
	CONSTRAINT "business_verification_events_reviewer_reason" CHECK ("business_verification_events"."actor_kind" <> 'REVIEWER' OR "business_verification_events"."action" IN ('VERIFIED', 'DOCUMENT_ACCESSED') OR ("business_verification_events"."reason" IS NOT NULL AND btrim("business_verification_events"."reason") <> '')),
	CONSTRAINT "business_verification_events_documents_valid" CHECK (jsonb_typeof("business_verification_events"."document_ids") = 'array')
);
--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD COLUMN "plan_code_snapshot" text;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD COLUMN "business_profile_id" text;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "plan_code" text;--> statement-breakpoint
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_verification_documents" ADD CONSTRAINT "business_verification_documents_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_verification_documents" ADD CONSTRAINT "business_verification_documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_verification_events" ADD CONSTRAINT "business_verification_events_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_verification_events" ADD CONSTRAINT "business_verification_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_memberships_business_user_unique" ON "business_memberships" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE INDEX "business_memberships_user_idx" ON "business_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "business_profiles_owner_idempotency_unique" ON "business_profiles" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "business_profiles_owner_name_open_unique" ON "business_profiles" USING btree ("owner_user_id","market_id","normalized_name") WHERE "business_profiles"."verification_status" <> 'REJECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "business_profiles_registration_unique" ON "business_profiles" USING btree ("market_id","registration_number_sha256") WHERE "business_profiles"."registration_number_sha256" IS NOT NULL AND "business_profiles"."verification_status" IN ('PENDING_REVIEW', 'VERIFIED', 'SUSPENDED');--> statement-breakpoint
CREATE INDEX "business_profiles_owner_idx" ON "business_profiles" USING btree ("owner_user_id","market_id","created_at");--> statement-breakpoint
CREATE INDEX "business_profiles_queue_idx" ON "business_profiles" USING btree ("verification_status","updated_at");--> statement-breakpoint
CREATE INDEX "business_profiles_market_name_idx" ON "business_profiles" USING btree ("market_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "business_verification_documents_path_unique" ON "business_verification_documents" USING btree ("object_path");--> statement-breakpoint
CREATE UNIQUE INDEX "business_verification_documents_idempotency_unique" ON "business_verification_documents" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "business_verification_documents_business_idx" ON "business_verification_documents" USING btree ("business_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "business_verification_events_business_idx" ON "business_verification_events" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_business_profile_id_business_profiles_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_products_enabled_plan_unique" ON "promotion_products" USING btree ("market_id","plan_code") WHERE "promotion_products"."plan_code" IS NOT NULL AND "promotion_products"."enabled";--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_plan_code_valid" CHECK ("business_subscriptions"."plan_code_snapshot" IS NULL OR "business_subscriptions"."plan_code_snapshot" IN ('DINAR_GO', 'DINAR_PRO', 'DINAR_BUSINESS'));--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_business_link" CHECK (("business_subscriptions"."plan_code_snapshot" = 'DINAR_BUSINESS') = ("business_subscriptions"."business_profile_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_plan_code_valid" CHECK ("promotion_products"."plan_code" IS NULL OR ("promotion_products"."product_type" = 'DINAR_BUSINESS' AND "promotion_products"."plan_code" IN ('DINAR_GO', 'DINAR_PRO', 'DINAR_BUSINESS')));--> statement-breakpoint
CREATE OR REPLACE FUNCTION business_verification_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'business_verification_events is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER business_verification_events_append_only_row
BEFORE UPDATE OR DELETE ON "business_verification_events"
FOR EACH ROW EXECUTE FUNCTION business_verification_events_append_only();
--> statement-breakpoint
CREATE TRIGGER business_verification_events_append_only_truncate
BEFORE TRUNCATE ON "business_verification_events"
FOR EACH STATEMENT EXECUTE FUNCTION business_verification_events_append_only();
