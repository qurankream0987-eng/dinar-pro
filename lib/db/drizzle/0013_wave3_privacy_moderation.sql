DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE status NOT IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DEACTIVATED') OR role NOT IN ('USER', 'ADMIN')) THEN
    RAISE EXCEPTION 'Migration 0013 found users with an unknown status or role; repair them before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM offers WHERE status NOT IN ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED', 'SOLD_OUT', 'MODERATION_HIDDEN', 'MODERATION_REMOVED')) THEN
    RAISE EXCEPTION 'Migration 0013 found offers with an unknown status; repair them before migrating';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "marketplace_policy_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_policy_rules_kind_valid" CHECK ("marketplace_policy_rules"."kind" IN ('CATEGORY', 'RESOURCE_TYPE', 'FULFILMENT', 'TERM')),
	CONSTRAINT "marketplace_policy_rules_value_valid" CHECK (char_length(btrim("marketplace_policy_rules"."value")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "marketplace_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"market_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_reports_target_type_valid" CHECK ("marketplace_reports"."target_type" IN ('LISTING', 'USER', 'ORDER')),
	CONSTRAINT "marketplace_reports_status_valid" CHECK ("marketplace_reports"."status" IN ('OPEN', 'DISMISSED', 'ACTIONED')),
	CONSTRAINT "marketplace_reports_resolution_consistent" CHECK (("marketplace_reports"."status" = 'OPEN') = ("marketplace_reports"."resolved_at" IS NULL AND "marketplace_reports"."resolved_by" IS NULL)),
	CONSTRAINT "marketplace_reports_note_length" CHECK (char_length("marketplace_reports"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "moderation_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"report_id" text,
	"reason" text DEFAULT '' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reason_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"label_ar" text NOT NULL,
	"label_en" text NOT NULL,
	"target_types" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_reason_code_format" CHECK ("moderation_reason_codes"."code" ~ '^[A-Z][A-Z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "policy_acceptances" (
	"user_id" text NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_acceptances_pkey" PRIMARY KEY("user_id","policy_key","policy_version")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "status_changed_at" = COALESCE("updated_at", "created_at") WHERE "status" <> 'ACTIVE' AND "status_changed_at" IS NULL;--> statement-breakpoint
UPDATE "users" SET "deactivated_at" = COALESCE("updated_at", "created_at") WHERE "status" = 'DEACTIVATED' AND "deactivated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "marketplace_policy_rules" ADD CONSTRAINT "marketplace_policy_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_policy_rules" ADD CONSTRAINT "marketplace_policy_rules_reason_code_moderation_reason_codes_code_fk" FOREIGN KEY ("reason_code") REFERENCES "public"."moderation_reason_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_policy_rules" ADD CONSTRAINT "marketplace_policy_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_policy_rules" ADD CONSTRAINT "marketplace_policy_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_reason_code_moderation_reason_codes_code_fk" FOREIGN KEY ("reason_code") REFERENCES "public"."moderation_reason_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit" ADD CONSTRAINT "moderation_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_audit" ADD CONSTRAINT "moderation_audit_report_id_marketplace_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."marketplace_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_policy_rules_active_idx" ON "marketplace_policy_rules" USING btree ("is_active","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_reports_open_unique" ON "marketplace_reports" USING btree ("reporter_id","target_type","target_id") WHERE "marketplace_reports"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "marketplace_reports_status_created_idx" ON "marketplace_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "marketplace_reports_target_idx" ON "marketplace_reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "marketplace_reports_reporter_created_idx" ON "marketplace_reports" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_audit_target_idx" ON "moderation_audit" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_audit_actor_idx" ON "moderation_audit" USING btree ("actor_id","created_at");--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_status_valid" CHECK ("offers"."status" IN ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED', 'SOLD_OUT', 'MODERATION_HIDDEN', 'MODERATION_REMOVED'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_valid" CHECK ("users"."status" IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DEACTIVATED'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" IN ('USER', 'ADMIN'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deactivation_consistent" CHECK (("users"."status" = 'DEACTIVATED') = ("users"."deactivated_at" IS NOT NULL));
--> statement-breakpoint
INSERT INTO "moderation_reason_codes" ("code", "label_ar", "label_en", "target_types", "sort_order") VALUES
  ('FRAUD_SCAM', 'احتيال أو نصب', 'Fraud or scam', '["LISTING","USER","ORDER"]', 10),
  ('PROHIBITED_ITEM', 'منتج أو خدمة محظورة', 'Prohibited item or service', '["LISTING"]', 20),
  ('MISLEADING_LISTING', 'عرض مضلل', 'Misleading listing', '["LISTING"]', 30),
  ('SPAM', 'رسائل أو عروض مزعجة', 'Spam', '["LISTING","USER"]', 40),
  ('HARASSMENT', 'إساءة أو تحرش', 'Harassment or abuse', '["USER","ORDER"]', 50),
  ('DUPLICATE', 'عرض مكرر', 'Duplicate listing', '["LISTING"]', 60),
  ('PRIVATE_INFORMATION', 'نشر معلومات شخصية', 'Exposes private information', '["LISTING","USER"]', 70),
  ('ORDER_MISCONDUCT', 'سوء تعامل في الطلب', 'Order misconduct', '["ORDER"]', 80),
  ('OTHER', 'سبب آخر', 'Other', '["LISTING","USER","ORDER"]', 90),
  ('POLICY_RESTRICTED', 'مقيد بسياسة السوق', 'Restricted by marketplace policy', '[]', 100)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "moderation_audit_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation_audit is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER "moderation_audit_no_update_delete"
BEFORE UPDATE OR DELETE ON "moderation_audit"
FOR EACH ROW EXECUTE FUNCTION "moderation_audit_append_only"();
