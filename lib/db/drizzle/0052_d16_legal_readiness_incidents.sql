CREATE TABLE "market_legal_capability_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"capability" text NOT NULL,
	"status" text DEFAULT 'DISABLED' NOT NULL,
	"counsel_reference" text,
	"counsel_reviewed_by" text,
	"counsel_reviewed_at" timestamp with time zone,
	"owner_approval_reference" text,
	"owner_approved_by" text,
	"owner_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_legal_capability_name_valid" CHECK ("market_legal_capability_approvals"."capability" IN ('INFORMATION_ONLY', 'BROWSING', 'LISTING_PUBLICATION', 'TRANSACTIONS', 'CASH_PAYMENT', 'ELECTRONIC_PAYMENT', 'BUSINESS_ONBOARDING', 'DELIVERY_OPERATIONS', 'RESTRICTED_CATEGORIES')),
	CONSTRAINT "market_legal_capability_status_valid" CHECK ("market_legal_capability_approvals"."status" IN ('DISABLED', 'COUNSEL_REVIEW_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'ENABLED', 'BLOCKED')),
	CONSTRAINT "market_legal_capability_review_valid" CHECK ("market_legal_capability_approvals"."status" NOT IN ('OWNER_APPROVAL_REQUIRED', 'ENABLED') OR ("market_legal_capability_approvals"."counsel_reference" IS NOT NULL AND "market_legal_capability_approvals"."counsel_reviewed_by" IS NOT NULL AND "market_legal_capability_approvals"."counsel_reviewed_at" IS NOT NULL)),
	CONSTRAINT "market_legal_capability_owner_valid" CHECK ("market_legal_capability_approvals"."status" <> 'ENABLED' OR ("market_legal_capability_approvals"."owner_approval_reference" IS NOT NULL AND "market_legal_capability_approvals"."owner_approved_by" IS NOT NULL AND "market_legal_capability_approvals"."owner_approved_at" IS NOT NULL AND "market_legal_capability_approvals"."owner_approved_by" <> "market_legal_capability_approvals"."counsel_reviewed_by"))
);
--> statement-breakpoint
CREATE TABLE "market_legal_capability_events" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"capability" text NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_legal_capability_events_type_valid" CHECK ("market_legal_capability_events"."event_type" IN ('REVIEW_REQUESTED', 'COUNSEL_REVIEWED', 'COUNSEL_BLOCKED', 'OWNER_ENABLED', 'OWNER_DISABLED')),
	CONSTRAINT "market_legal_capability_events_status_valid" CHECK ("market_legal_capability_events"."to_status" IN ('DISABLED', 'COUNSEL_REVIEW_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'ENABLED', 'BLOCKED') AND ("market_legal_capability_events"."from_status" IS NULL OR "market_legal_capability_events"."from_status" IN ('DISABLED', 'COUNSEL_REVIEW_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'ENABLED', 'BLOCKED')))
);
--> statement-breakpoint
CREATE TABLE "security_incident_events" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incident_events_type_valid" CHECK ("security_incident_events"."event_type" IN ('OPENED', 'CONTAINMENT_RECORDED', 'RECOVERY_RECORDED', 'POST_INCIDENT_RECORDED', 'COUNSEL_REVIEW_REQUESTED', 'COUNSEL_REVIEW_RECORDED', 'SEVERITY_CHANGED', 'EVIDENCE_REFERENCE_ADDED')),
	CONSTRAINT "security_incident_events_status_valid" CHECK ("security_incident_events"."to_status" IN ('OPEN', 'CONTAINED', 'RECOVERED', 'CLOSED') AND ("security_incident_events"."from_status" IS NULL OR "security_incident_events"."from_status" IN ('OPEN', 'CONTAINED', 'RECOVERED', 'CLOSED')))
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"summary" text NOT NULL,
	"affected_systems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"opened_by" text NOT NULL,
	"evidence_reference" text,
	"containment_summary" text,
	"recovery_summary" text,
	"post_incident_summary" text,
	"counsel_assessment" text DEFAULT 'NOT_ASSESSED' NOT NULL,
	"counsel_reference" text,
	"counsel_reviewed_by" text,
	"counsel_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incidents_category_valid" CHECK ("security_incidents"."category" IN ('SECURITY', 'PRIVACY', 'AVAILABILITY', 'DATA_INTEGRITY', 'THIRD_PARTY', 'OTHER')),
	CONSTRAINT "security_incidents_severity_valid" CHECK ("security_incidents"."severity" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
	CONSTRAINT "security_incidents_status_valid" CHECK ("security_incidents"."status" IN ('OPEN', 'CONTAINED', 'RECOVERED', 'CLOSED')),
	CONSTRAINT "security_incidents_assessment_valid" CHECK ("security_incidents"."counsel_assessment" IN ('NOT_ASSESSED', 'REVIEW_REQUIRED', 'REVIEWED')),
	CONSTRAINT "security_incidents_summary_valid" CHECK (char_length(btrim("security_incidents"."summary")) BETWEEN 3 AND 1200 AND jsonb_typeof("security_incidents"."affected_systems") = 'array'),
	CONSTRAINT "security_incidents_closure_valid" CHECK ("security_incidents"."status" <> 'CLOSED' OR ("security_incidents"."post_incident_summary" IS NOT NULL AND char_length(btrim("security_incidents"."post_incident_summary")) >= 3))
);
--> statement-breakpoint
ALTER TABLE "market_legal_capability_approvals" ADD CONSTRAINT "market_legal_capability_approvals_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_capability_approvals" ADD CONSTRAINT "market_legal_capability_approvals_counsel_reviewed_by_users_id_fk" FOREIGN KEY ("counsel_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_capability_approvals" ADD CONSTRAINT "market_legal_capability_approvals_owner_approved_by_users_id_fk" FOREIGN KEY ("owner_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_capability_events" ADD CONSTRAINT "market_legal_capability_events_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_legal_capability_events" ADD CONSTRAINT "market_legal_capability_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incident_events" ADD CONSTRAINT "security_incident_events_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incident_events" ADD CONSTRAINT "security_incident_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_counsel_reviewed_by_users_id_fk" FOREIGN KEY ("counsel_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_legal_capability_market_capability_unique" ON "market_legal_capability_approvals" USING btree ("market_id","capability");--> statement-breakpoint
CREATE INDEX "market_legal_capability_status_idx" ON "market_legal_capability_approvals" USING btree ("status","market_id");--> statement-breakpoint
CREATE INDEX "market_legal_capability_events_market_idx" ON "market_legal_capability_events" USING btree ("market_id","capability","created_at");--> statement-breakpoint
CREATE INDEX "security_incident_events_incident_idx" ON "security_incident_events" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "security_incidents_status_severity_idx" ON "security_incidents" USING btree ("status","severity","created_at");
--> statement-breakpoint
CREATE FUNCTION d16_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'D16 audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_legal_capability_events_no_update_delete
BEFORE UPDATE OR DELETE ON market_legal_capability_events
FOR EACH ROW EXECUTE FUNCTION d16_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER market_legal_capability_events_no_truncate
BEFORE TRUNCATE ON market_legal_capability_events
FOR EACH STATEMENT EXECUTE FUNCTION d16_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER security_incident_events_no_update_delete
BEFORE UPDATE OR DELETE ON security_incident_events
FOR EACH ROW EXECUTE FUNCTION d16_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER security_incident_events_no_truncate
BEFORE TRUNCATE ON security_incident_events
FOR EACH STATEMENT EXECUTE FUNCTION d16_reject_audit_mutation();