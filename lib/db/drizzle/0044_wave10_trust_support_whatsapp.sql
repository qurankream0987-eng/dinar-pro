-- Wave 10: wider reporting targets, fraud signals (signals, never proof), human support cases
-- with RBAC and a WhatsApp readiness ledger that cannot send. Additive: the only change to an
-- existing table is widening marketplace_reports_target_type_valid to accept MESSAGE and
-- AI_ANSWER. No row in an existing table is rewritten and no provider is contacted.

ALTER TABLE "marketplace_reports" DROP CONSTRAINT "marketplace_reports_target_type_valid";--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_target_type_valid" CHECK ("marketplace_reports"."target_type" IN ('LISTING', 'USER', 'ORDER', 'MESSAGE', 'AI_ANSWER'));--> statement-breakpoint

UPDATE "moderation_reason_codes" SET "target_types" = '["LISTING","USER","ORDER","MESSAGE"]' WHERE "code" = 'FRAUD_SCAM';--> statement-breakpoint
UPDATE "moderation_reason_codes" SET "target_types" = '["LISTING","USER","MESSAGE"]' WHERE "code" = 'SPAM';--> statement-breakpoint
UPDATE "moderation_reason_codes" SET "target_types" = '["USER","ORDER","MESSAGE"]' WHERE "code" = 'HARASSMENT';--> statement-breakpoint
UPDATE "moderation_reason_codes" SET "target_types" = '["LISTING","MESSAGE"]' WHERE "code" = 'PROHIBITED_ITEM';--> statement-breakpoint
UPDATE "moderation_reason_codes" SET "target_types" = '["LISTING","USER","ORDER","MESSAGE","AI_ANSWER"]' WHERE "code" = 'OTHER';--> statement-breakpoint
INSERT INTO "moderation_reason_codes" ("code", "label_ar", "label_en", "target_types", "sort_order") VALUES
  ('IMPERSONATION', 'انتحال شخصية', 'Impersonation', '["USER","LISTING","MESSAGE"]', 15),
  ('COUNTERFEIT', 'منتج مقلّد', 'Counterfeit goods', '["LISTING","MESSAGE"]', 25),
  ('INTELLECTUAL_PROPERTY', 'انتهاك حقوق الملكية الفكرية', 'Intellectual property violation', '["LISTING","MESSAGE","AI_ANSWER"]', 27),
  ('AI_HARMFUL_ANSWER', 'إجابة ذكاء اصطناعي ضارة', 'Harmful AI answer', '["AI_ANSWER"]', 110),
  ('AI_INACCURATE_ANSWER', 'إجابة ذكاء اصطناعي غير دقيقة', 'Inaccurate AI answer', '["AI_ANSWER"]', 120)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

CREATE TABLE "fraud_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"severity" text DEFAULT 'LOW' NOT NULL,
	"source" text NOT NULL,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"dedupe_key" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fraud_signals_subject_valid" CHECK ("fraud_signals"."subject_type" IN ('USER', 'LISTING', 'ORDER', 'MESSAGE', 'PAYMENT')),
	CONSTRAINT "fraud_signals_severity_valid" CHECK ("fraud_signals"."severity" IN ('LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "fraud_signals_source_valid" CHECK ("fraud_signals"."source" IN ('RULE', 'REPORT', 'ADMIN', 'SYSTEM')),
	CONSTRAINT "fraud_signals_type_format" CHECK ("fraud_signals"."signal_type" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
	CONSTRAINT "fraud_signals_dedupe_length" CHECK (char_length("fraud_signals"."dedupe_key") BETWEEN 3 AND 120)
);--> statement-breakpoint
CREATE TABLE "fraud_signal_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"signal_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"decision" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fraud_signal_reviews_decision_valid" CHECK ("fraud_signal_reviews"."decision" IN ('CONFIRMED', 'DISMISSED', 'ESCALATED')),
	CONSTRAINT "fraud_signal_reviews_note_length" CHECK (char_length("fraud_signal_reviews"."note") BETWEEN 5 AND 2000)
);--> statement-breakpoint
CREATE TABLE "support_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"assigned_to" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_cases_category_valid" CHECK ("support_cases"."category" IN ('ORDER', 'PAYMENT', 'ACCOUNT', 'SAFETY', 'TECHNICAL', 'DATA', 'OTHER')),
	CONSTRAINT "support_cases_status_valid" CHECK ("support_cases"."status" IN ('OPEN', 'AWAITING_USER', 'AWAITING_STAFF', 'RESOLVED', 'CLOSED')),
	CONSTRAINT "support_cases_priority_valid" CHECK ("support_cases"."priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
	CONSTRAINT "support_cases_subject_length" CHECK (char_length("support_cases"."subject") BETWEEN 3 AND 160),
	CONSTRAINT "support_cases_closed_consistent" CHECK (("support_cases"."status" IN ('RESOLVED', 'CLOSED')) = ("support_cases"."closed_at" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE "support_case_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_messages_author_valid" CHECK ("support_case_messages"."author_kind" IN ('USER', 'STAFF', 'SYSTEM')),
	CONSTRAINT "support_case_messages_body_length" CHECK (char_length("support_case_messages"."body") BETWEEN 1 AND 4000),
	CONSTRAINT "support_case_messages_internal_staff_only" CHECK ("support_case_messages"."internal" = false OR "support_case_messages"."author_kind" = 'STAFF'),
	CONSTRAINT "support_case_messages_system_author_free" CHECK (("support_case_messages"."author_kind" = 'SYSTEM') = ("support_case_messages"."author_id" IS NULL))
);--> statement-breakpoint
CREATE TABLE "support_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_events_actor_valid" CHECK ("support_case_events"."actor_kind" IN ('USER', 'STAFF', 'SYSTEM')),
	CONSTRAINT "support_case_events_status_valid" CHECK ("support_case_events"."to_status" IN ('OPEN', 'AWAITING_USER', 'AWAITING_STAFF', 'RESOLVED', 'CLOSED')),
	CONSTRAINT "support_case_events_note_length" CHECK ("support_case_events"."note" IS NULL OR char_length("support_case_events"."note") <= 2000)
);--> statement-breakpoint
CREATE TABLE "whatsapp_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"decision" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_consent_events_decision_valid" CHECK ("whatsapp_consent_events"."decision" IN ('GRANTED', 'REVOKED')),
	CONSTRAINT "whatsapp_consent_events_source_valid" CHECK ("whatsapp_consent_events"."source" IN ('IN_APP', 'SUPPORT')),
	CONSTRAINT "whatsapp_consent_events_phone_hash_format" CHECK ("whatsapp_consent_events"."phone_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"language" text DEFAULT 'ar' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"body" text NOT NULL,
	"variable_count" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_templates_key_format" CHECK ("whatsapp_templates"."key" ~ '^[A-Z][A-Z0-9_]{1,60}$'),
	CONSTRAINT "whatsapp_templates_category_valid" CHECK ("whatsapp_templates"."category" IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
	CONSTRAINT "whatsapp_templates_status_valid" CHECK ("whatsapp_templates"."status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'DISABLED')),
	CONSTRAINT "whatsapp_templates_variable_count_valid" CHECK ("whatsapp_templates"."variable_count" BETWEEN 0 AND 10),
	CONSTRAINT "whatsapp_templates_approval_timing" CHECK ("whatsapp_templates"."status" IN ('APPROVED', 'DISABLED') OR "whatsapp_templates"."approved_at" IS NULL)
);--> statement-breakpoint
CREATE TABLE "whatsapp_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"template_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"decision" text NOT NULL,
	"detail" text NOT NULL,
	"delivery_state" text DEFAULT 'NOT_SENT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_intents_decision_valid" CHECK ("whatsapp_intents"."decision" IN ('READY_TO_SEND', 'BLOCKED_NO_CONSENT', 'BLOCKED_TEMPLATE_NOT_APPROVED', 'BLOCKED_TEMPLATE_DISABLED', 'BLOCKED_PROVIDER_UNAVAILABLE', 'BLOCKED_PAYLOAD_INVALID')),
	CONSTRAINT "whatsapp_intents_never_sent" CHECK ("whatsapp_intents"."delivery_state" = 'NOT_SENT')
);--> statement-breakpoint

ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signal_reviews" ADD CONSTRAINT "fraud_signal_reviews_signal_id_fraud_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."fraud_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signal_reviews" ADD CONSTRAINT "fraud_signal_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_events" ADD CONSTRAINT "support_case_events_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_events" ADD CONSTRAINT "support_case_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_consent_events" ADD CONSTRAINT "whatsapp_consent_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_consent_events" ADD CONSTRAINT "whatsapp_consent_events_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_intents" ADD CONSTRAINT "whatsapp_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_intents" ADD CONSTRAINT "whatsapp_intents_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_intents" ADD CONSTRAINT "whatsapp_intents_template_key_whatsapp_templates_key_fk" FOREIGN KEY ("template_key") REFERENCES "public"."whatsapp_templates"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "fraud_signals_dedupe_unique" ON "fraud_signals" USING btree ("subject_type","subject_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "fraud_signals_subject_idx" ON "fraud_signals" USING btree ("subject_type","subject_id","observed_at");--> statement-breakpoint
CREATE INDEX "fraud_signals_created_idx" ON "fraud_signals" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_signal_reviews_signal_unique" ON "fraud_signal_reviews" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "fraud_signal_reviews_reviewer_idx" ON "fraud_signal_reviews" USING btree ("reviewer_id","created_at");--> statement-breakpoint
CREATE INDEX "support_cases_user_idx" ON "support_cases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "support_cases_status_idx" ON "support_cases" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX "support_cases_assigned_idx" ON "support_cases" USING btree ("assigned_to","status");--> statement-breakpoint
CREATE INDEX "support_case_messages_case_idx" ON "support_case_messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "support_case_events_case_idx" ON "support_case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_consent_events_user_idx" ON "whatsapp_consent_events" USING btree ("user_id","market_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_status_idx" ON "whatsapp_templates" USING btree ("status","category");--> statement-breakpoint
CREATE INDEX "whatsapp_intents_user_idx" ON "whatsapp_intents" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_intents_decision_idx" ON "whatsapp_intents" USING btree ("decision","created_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION fraud_signals_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fraud signals are immutable observations' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER fraud_signals_guard_row
BEFORE UPDATE OR DELETE ON "fraud_signals"
FOR EACH ROW EXECUTE FUNCTION fraud_signals_guard();--> statement-breakpoint
CREATE TRIGGER fraud_signals_guard_truncate
BEFORE TRUNCATE ON "fraud_signals"
FOR EACH STATEMENT EXECUTE FUNCTION fraud_signals_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION fraud_signal_reviews_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'fraud signal reviews are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'fraud signal reviews cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (SELECT role FROM users WHERE id = NEW.reviewer_id) IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'only an admin reviews a fraud signal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER fraud_signal_reviews_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "fraud_signal_reviews"
FOR EACH ROW EXECUTE FUNCTION fraud_signal_reviews_guard();--> statement-breakpoint
CREATE TRIGGER fraud_signal_reviews_guard_truncate
BEFORE TRUNCATE ON "fraud_signal_reviews"
FOR EACH STATEMENT EXECUTE FUNCTION fraud_signal_reviews_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION support_cases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'support cases cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'a support case starts OPEN' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.market_id IS DISTINCT FROM OLD.market_id
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'support case identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'a closed support case cannot reopen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER support_cases_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "support_cases"
FOR EACH ROW EXECUTE FUNCTION support_cases_guard();--> statement-breakpoint
CREATE TRIGGER support_cases_guard_truncate
BEFORE TRUNCATE ON "support_cases"
FOR EACH STATEMENT EXECUTE FUNCTION support_cases_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION support_records_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support messages and events are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER support_case_messages_no_update_delete
BEFORE UPDATE OR DELETE ON "support_case_messages"
FOR EACH ROW EXECUTE FUNCTION support_records_append_only();--> statement-breakpoint
CREATE TRIGGER support_case_messages_no_truncate
BEFORE TRUNCATE ON "support_case_messages"
FOR EACH STATEMENT EXECUTE FUNCTION support_records_append_only();--> statement-breakpoint
CREATE TRIGGER support_case_events_no_update_delete
BEFORE UPDATE OR DELETE ON "support_case_events"
FOR EACH ROW EXECUTE FUNCTION support_records_append_only();--> statement-breakpoint
CREATE TRIGGER support_case_events_no_truncate
BEFORE TRUNCATE ON "support_case_events"
FOR EACH STATEMENT EXECUTE FUNCTION support_records_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION whatsapp_consent_events_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'WhatsApp consent events are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER whatsapp_consent_events_no_update_delete
BEFORE UPDATE OR DELETE ON "whatsapp_consent_events"
FOR EACH ROW EXECUTE FUNCTION whatsapp_consent_events_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_consent_events_no_truncate
BEFORE TRUNCATE ON "whatsapp_consent_events"
FOR EACH STATEMENT EXECUTE FUNCTION whatsapp_consent_events_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION whatsapp_templates_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'WhatsApp templates cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'a WhatsApp template starts DRAFT and unapproved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.key IS DISTINCT FROM OLD.key
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.language IS DISTINCT FROM OLD.language
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.variable_count IS DISTINCT FROM OLD.variable_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'WhatsApp template content is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED')
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'DISABLED')
  ) THEN
    RAISE EXCEPTION 'invalid WhatsApp template transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'APPROVED' AND NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'approval needs a timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER whatsapp_templates_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "whatsapp_templates"
FOR EACH ROW EXECUTE FUNCTION whatsapp_templates_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_templates_guard_truncate
BEFORE TRUNCATE ON "whatsapp_templates"
FOR EACH STATEMENT EXECUTE FUNCTION whatsapp_templates_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION whatsapp_intents_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'WhatsApp intents are append-only readiness records; nothing is sent' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER whatsapp_intents_no_update_delete
BEFORE UPDATE OR DELETE ON "whatsapp_intents"
FOR EACH ROW EXECUTE FUNCTION whatsapp_intents_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_intents_no_truncate
BEFORE TRUNCATE ON "whatsapp_intents"
FOR EACH STATEMENT EXECUTE FUNCTION whatsapp_intents_guard();
