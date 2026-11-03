CREATE TABLE "market_legal_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"intake_id" text NOT NULL,
	"topic_key" text NOT NULL,
	"evidence_type" text NOT NULL,
	"document_version" text NOT NULL,
	"reference_code" text NOT NULL,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'SUBMITTED_UNVERIFIED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_legal_evidence_topic_valid" CHECK ("market_legal_evidence"."topic_key" IN ('OPERATING_ENTITY', 'MARKETPLACE_RULES', 'SELLER_ELIGIBILITY', 'BUSINESS_KYC', 'CONSUMER_PROTECTION', 'FEES_AND_TAX', 'PAYMENTS', 'DELIVERY_LOGISTICS', 'PERSONAL_DATA', 'EXTERNAL_AI', 'MINORS_RESTRICTED_GOODS_ADVERTISING', 'IP_COMPLAINTS_DISPUTES', 'INCIDENT_NOTIFICATION', 'POLICY_VERSIONS', 'OFFICIAL_REFERENCES', 'COUNSEL_FINDINGS')),
	CONSTRAINT "market_legal_evidence_type_valid" CHECK ("market_legal_evidence"."evidence_type" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "market_legal_evidence_version_valid" CHECK (char_length(btrim("market_legal_evidence"."document_version")) BETWEEN 1 AND 80),
	CONSTRAINT "market_legal_evidence_reference_valid" CHECK ("market_legal_evidence"."reference_code" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$'),
	CONSTRAINT "market_legal_evidence_status_valid" CHECK ("market_legal_evidence"."status" IN ('SUBMITTED_UNVERIFIED', 'COUNSEL_REVIEWED', 'REJECTED', 'SUPERSEDED')),
	CONSTRAINT "market_legal_evidence_review_guard" CHECK ("market_legal_evidence"."status" NOT IN ('COUNSEL_REVIEWED', 'REJECTED', 'SUPERSEDED') OR ("market_legal_evidence"."reviewed_by" IS NOT NULL AND "market_legal_evidence"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "market_legal_evidence_expiry_valid" CHECK ("market_legal_evidence"."expires_at" IS NULL OR "market_legal_evidence"."issued_at" IS NULL OR "market_legal_evidence"."expires_at" >= "market_legal_evidence"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "market_legal_intake_events" (
	"id" text PRIMARY KEY NOT NULL,
	"intake_id" text NOT NULL,
	"event_type" text NOT NULL,
	"topic_key" text,
	"evidence_id" text,
	"actor_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reference_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_legal_intake_events_type_valid" CHECK ("market_legal_intake_events"."event_type" IN ('PACKAGE_INITIALIZED', 'EVIDENCE_SUBMITTED', 'EVIDENCE_REVIEWED', 'EVIDENCE_REJECTED', 'COUNSEL_REVIEW_REQUESTED', 'TOPIC_REVIEWED', 'COUNSEL_REVIEW_RECORDED', 'COUNSEL_APPROVAL_BLOCKED', 'OWNER_APPROVAL_BLOCKED', 'TECHNICAL_VERIFICATION_BLOCKED', 'ACTIVATION_BLOCKED', 'MARKET_ACTIVATED', 'MARKET_SUSPENDED')),
	CONSTRAINT "market_legal_intake_events_reference_valid" CHECK ("market_legal_intake_events"."reference_code" IS NULL OR "market_legal_intake_events"."reference_code" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$')
);
--> statement-breakpoint
CREATE TABLE "market_legal_intake_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"intake_id" text NOT NULL,
	"topic_key" text NOT NULL,
	"disposition" text DEFAULT 'UNRESOLVED' NOT NULL,
	"review_status" text DEFAULT 'NOT_REVIEWED' NOT NULL,
	"evidence_requirement_status" text DEFAULT 'NOT_REVIEWED' NOT NULL,
	"policy_requirement_status" text DEFAULT 'NOT_REVIEWED' NOT NULL,
	"counsel_finding" text,
	"qualifications" text,
	"required_amendments" text,
	"official_reference" text,
	"effective_from" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"required_evidence_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_policy_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_legal_intake_topics_key_valid" CHECK ("market_legal_intake_topics"."topic_key" IN ('OPERATING_ENTITY', 'MARKETPLACE_RULES', 'SELLER_ELIGIBILITY', 'BUSINESS_KYC', 'CONSUMER_PROTECTION', 'FEES_AND_TAX', 'PAYMENTS', 'DELIVERY_LOGISTICS', 'PERSONAL_DATA', 'EXTERNAL_AI', 'MINORS_RESTRICTED_GOODS_ADVERTISING', 'IP_COMPLAINTS_DISPUTES', 'INCIDENT_NOTIFICATION', 'POLICY_VERSIONS', 'OFFICIAL_REFERENCES', 'COUNSEL_FINDINGS')),
	CONSTRAINT "market_legal_intake_topics_disposition_valid" CHECK ("market_legal_intake_topics"."disposition" IN ('UNRESOLVED', 'REQUIRED', 'NOT_REQUIRED', 'NOT_APPLICABLE', 'BLOCKED')),
	CONSTRAINT "market_legal_intake_topics_review_status_valid" CHECK ("market_legal_intake_topics"."review_status" IN ('NOT_REVIEWED', 'COUNSEL_REVIEWED', 'BLOCKED')),
	CONSTRAINT "market_legal_intake_topics_evidence_status_valid" CHECK ("market_legal_intake_topics"."evidence_requirement_status" IN ('NOT_REVIEWED', 'REQUIREMENTS_SET', 'NO_REQUIREMENTS')),
	CONSTRAINT "market_legal_intake_topics_policy_status_valid" CHECK ("market_legal_intake_topics"."policy_requirement_status" IN ('NOT_REVIEWED', 'VERSIONS_SET', 'NO_POLICY_REQUIREMENT')),
	CONSTRAINT "market_legal_intake_topics_review_guard" CHECK ("market_legal_intake_topics"."review_status" <> 'COUNSEL_REVIEWED' OR ("market_legal_intake_topics"."disposition" <> 'UNRESOLVED' AND "market_legal_intake_topics"."counsel_finding" IS NOT NULL AND char_length(btrim("market_legal_intake_topics"."counsel_finding")) >= 3 AND "market_legal_intake_topics"."official_reference" IS NOT NULL AND "market_legal_intake_topics"."reviewed_by" IS NOT NULL AND "market_legal_intake_topics"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "market_legal_intake_topics_evidence_requirement_guard" CHECK (("market_legal_intake_topics"."evidence_requirement_status" = 'NOT_REVIEWED') OR ("market_legal_intake_topics"."evidence_requirement_status" = 'NO_REQUIREMENTS' AND jsonb_array_length("market_legal_intake_topics"."required_evidence_types") = 0) OR ("market_legal_intake_topics"."evidence_requirement_status" = 'REQUIREMENTS_SET' AND jsonb_array_length("market_legal_intake_topics"."required_evidence_types") > 0)),
	CONSTRAINT "market_legal_intake_topics_policy_requirement_guard" CHECK (("market_legal_intake_topics"."policy_requirement_status" = 'NOT_REVIEWED') OR ("market_legal_intake_topics"."policy_requirement_status" = 'NO_POLICY_REQUIREMENT' AND jsonb_array_length("market_legal_intake_topics"."required_policy_versions") = 0) OR ("market_legal_intake_topics"."policy_requirement_status" = 'VERSIONS_SET' AND jsonb_array_length("market_legal_intake_topics"."required_policy_versions") > 0)),
	CONSTRAINT "market_legal_intake_topics_effective_range_valid" CHECK ("market_legal_intake_topics"."effective_from" IS NULL OR "market_legal_intake_topics"."effective_until" IS NULL OR "market_legal_intake_topics"."effective_until" >= "market_legal_intake_topics"."effective_from"),
	CONSTRAINT "market_legal_intake_topics_reference_valid" CHECK ("market_legal_intake_topics"."official_reference" IS NULL OR "market_legal_intake_topics"."official_reference" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$')
);
--> statement-breakpoint
CREATE TABLE "market_legal_intakes" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"review_status" text DEFAULT 'NOT_REVIEWED' NOT NULL,
	"counsel_approval_status" text DEFAULT 'BLOCKED' NOT NULL,
	"counsel_approval_blocker" text DEFAULT 'COUNSEL_SIGNATURE_VERIFICATION_UNAVAILABLE' NOT NULL,
	"owner_approval_status" text DEFAULT 'BLOCKED' NOT NULL,
	"technical_verification_status" text DEFAULT 'NOT_RUN' NOT NULL,
	"activation_status" text DEFAULT 'DISABLED' NOT NULL,
	"review_requested_by" text,
	"review_requested_at" timestamp with time zone,
	"counsel_reviewed_by" text,
	"counsel_reviewed_at" timestamp with time zone,
	"counsel_review_reference" text,
	"counsel_approved_by" text,
	"counsel_approved_at" timestamp with time zone,
	"counsel_approval_reference" text,
	"owner_approved_by" text,
	"owner_approved_at" timestamp with time zone,
	"owner_approval_reference" text,
	"technical_verified_by" text,
	"technical_verified_at" timestamp with time zone,
	"technical_verification_reference" text,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"suspended_by" text,
	"suspended_at" timestamp with time zone,
	"suspension_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_legal_intakes_review_status_valid" CHECK ("market_legal_intakes"."review_status" IN ('NOT_REVIEWED', 'COUNSEL_REVIEW_REQUIRED', 'COUNSEL_REVIEWED', 'BLOCKED')),
	CONSTRAINT "market_legal_intakes_counsel_approval_status_valid" CHECK ("market_legal_intakes"."counsel_approval_status" IN ('BLOCKED', 'APPROVED')),
	CONSTRAINT "market_legal_intakes_owner_status_valid" CHECK ("market_legal_intakes"."owner_approval_status" IN ('BLOCKED', 'APPROVED')),
	CONSTRAINT "market_legal_intakes_technical_status_valid" CHECK ("market_legal_intakes"."technical_verification_status" IN ('NOT_RUN', 'PASSED', 'FAILED')),
	CONSTRAINT "market_legal_intakes_activation_status_valid" CHECK ("market_legal_intakes"."activation_status" IN ('DISABLED', 'ACTIVE', 'SUSPENDED')),
	CONSTRAINT "market_legal_intakes_counsel_approval_guard" CHECK ("market_legal_intakes"."counsel_approval_status" <> 'APPROVED' OR ("market_legal_intakes"."counsel_reviewed_by" IS NOT NULL AND "market_legal_intakes"."counsel_reviewed_at" IS NOT NULL AND "market_legal_intakes"."counsel_approval_reference" IS NOT NULL AND "market_legal_intakes"."counsel_approved_by" IS NOT NULL AND "market_legal_intakes"."counsel_approved_at" IS NOT NULL)),
	CONSTRAINT "market_legal_intakes_owner_approval_guard" CHECK ("market_legal_intakes"."owner_approval_status" <> 'APPROVED' OR ("market_legal_intakes"."counsel_approval_status" = 'APPROVED' AND "market_legal_intakes"."technical_verification_status" = 'PASSED' AND "market_legal_intakes"."owner_approval_reference" IS NOT NULL AND "market_legal_intakes"."owner_approved_by" IS NOT NULL AND "market_legal_intakes"."owner_approved_at" IS NOT NULL)),
	CONSTRAINT "market_legal_intakes_activation_guard" CHECK ("market_legal_intakes"."activation_status" <> 'ACTIVE' OR ("market_legal_intakes"."counsel_approval_status" = 'APPROVED' AND "market_legal_intakes"."owner_approval_status" = 'APPROVED' AND "market_legal_intakes"."technical_verification_status" = 'PASSED' AND "market_legal_intakes"."activated_by" IS NOT NULL AND "market_legal_intakes"."activated_at" IS NOT NULL)),
	CONSTRAINT "market_legal_intakes_suspension_guard" CHECK ("market_legal_intakes"."activation_status" <> 'SUSPENDED' OR ("market_legal_intakes"."suspended_by" IS NOT NULL AND "market_legal_intakes"."suspended_at" IS NOT NULL AND "market_legal_intakes"."suspension_reference" IS NOT NULL)),
	CONSTRAINT "market_legal_intakes_references_valid" CHECK (("market_legal_intakes"."counsel_review_reference" IS NULL OR "market_legal_intakes"."counsel_review_reference" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$') AND ("market_legal_intakes"."counsel_approval_reference" IS NULL OR "market_legal_intakes"."counsel_approval_reference" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$') AND ("market_legal_intakes"."owner_approval_reference" IS NULL OR "market_legal_intakes"."owner_approval_reference" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$') AND ("market_legal_intakes"."technical_verification_reference" IS NULL OR "market_legal_intakes"."technical_verification_reference" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$') AND ("market_legal_intakes"."suspension_reference" IS NULL OR "market_legal_intakes"."suspension_reference" ~ '^[A-Za-z][A-Za-z0-9._:/-]{2,199}$'))
);
--> statement-breakpoint
ALTER TABLE "market_legal_evidence" ADD CONSTRAINT "market_legal_evidence_intake_id_market_legal_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."market_legal_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_evidence" ADD CONSTRAINT "market_legal_evidence_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_evidence" ADD CONSTRAINT "market_legal_evidence_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intake_events" ADD CONSTRAINT "market_legal_intake_events_intake_id_market_legal_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."market_legal_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intake_events" ADD CONSTRAINT "market_legal_intake_events_evidence_id_market_legal_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."market_legal_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intake_events" ADD CONSTRAINT "market_legal_intake_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intake_topics" ADD CONSTRAINT "market_legal_intake_topics_intake_id_market_legal_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."market_legal_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intake_topics" ADD CONSTRAINT "market_legal_intake_topics_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_review_requested_by_users_id_fk" FOREIGN KEY ("review_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_counsel_reviewed_by_users_id_fk" FOREIGN KEY ("counsel_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_counsel_approved_by_users_id_fk" FOREIGN KEY ("counsel_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_owner_approved_by_users_id_fk" FOREIGN KEY ("owner_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_technical_verified_by_users_id_fk" FOREIGN KEY ("technical_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_intakes" ADD CONSTRAINT "market_legal_intakes_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_legal_evidence_idempotency_unique" ON "market_legal_evidence" USING btree ("intake_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "market_legal_evidence_topic_idx" ON "market_legal_evidence" USING btree ("intake_id","topic_key","evidence_type","created_at");--> statement-breakpoint
CREATE INDEX "market_legal_intake_events_intake_idx" ON "market_legal_intake_events" USING btree ("intake_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_legal_intake_topics_unique" ON "market_legal_intake_topics" USING btree ("intake_id","topic_key");--> statement-breakpoint
CREATE INDEX "market_legal_intake_topics_status_idx" ON "market_legal_intake_topics" USING btree ("intake_id","review_status","topic_key");--> statement-breakpoint
CREATE UNIQUE INDEX "market_legal_intakes_market_unique" ON "market_legal_intakes" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "market_legal_intakes_activation_idx" ON "market_legal_intakes" USING btree ("activation_status","market_id");
--> statement-breakpoint
-- Seed empty intake packages only. No law, license, document, or policy requirement is inferred.
INSERT INTO "market_legal_intakes" ("id", "market_id")
SELECT 'd16-intake-' || m."id", m."id"
FROM "markets" m
WHERE m."id" IN ('JO', 'KW', 'SA')
ON CONFLICT ("market_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "market_legal_intake_topics" ("id", "intake_id", "topic_key")
SELECT 'd16-topic-' || i."market_id" || '-' || topic."topic_key",
       i."id",
       topic."topic_key"
FROM "market_legal_intakes" i
CROSS JOIN (VALUES
  ('OPERATING_ENTITY'),
  ('MARKETPLACE_RULES'),
  ('SELLER_ELIGIBILITY'),
  ('BUSINESS_KYC'),
  ('CONSUMER_PROTECTION'),
  ('FEES_AND_TAX'),
  ('PAYMENTS'),
  ('DELIVERY_LOGISTICS'),
  ('PERSONAL_DATA'),
  ('EXTERNAL_AI'),
  ('MINORS_RESTRICTED_GOODS_ADVERTISING'),
  ('IP_COMPLAINTS_DISPUTES'),
  ('INCIDENT_NOTIFICATION'),
  ('POLICY_VERSIONS'),
  ('OFFICIAL_REFERENCES'),
  ('COUNSEL_FINDINGS')
) AS topic("topic_key")
WHERE i."market_id" IN ('JO', 'KW', 'SA')
ON CONFLICT ("intake_id", "topic_key") DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER market_legal_intake_events_no_update_delete
BEFORE UPDATE OR DELETE ON market_legal_intake_events
FOR EACH ROW EXECUTE FUNCTION d16_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER market_legal_intake_events_no_truncate
BEFORE TRUNCATE ON market_legal_intake_events
FOR EACH STATEMENT EXECUTE FUNCTION d16_reject_audit_mutation();