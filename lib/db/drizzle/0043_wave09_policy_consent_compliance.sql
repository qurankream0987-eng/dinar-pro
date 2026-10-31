CREATE TABLE "policy_registry_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"lifecycle" text DEFAULT 'DRAFT' NOT NULL,
	"content_sha256" text NOT NULL,
	"effective_date" text NOT NULL,
	"market_scope" text DEFAULT 'GLOBAL' NOT NULL,
	"requires_acceptance" boolean DEFAULT false NOT NULL,
	"material_change" boolean DEFAULT false NOT NULL,
	"legal_reference" text,
	"registered_by" text,
	"approved_by" text,
	"published_by" text,
	"superseded_by" text,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_registry_versions_lifecycle_valid" CHECK ("policy_registry_versions"."lifecycle" IN ('DRAFT', 'LEGAL_REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED')),
	CONSTRAINT "policy_registry_versions_hash_valid" CHECK ("policy_registry_versions"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "policy_registry_versions_effective_valid" CHECK ("policy_registry_versions"."effective_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "policy_registry_versions_scope_valid" CHECK ("policy_registry_versions"."market_scope" = 'GLOBAL' OR char_length("policy_registry_versions"."market_scope") BETWEEN 2 AND 32),
	CONSTRAINT "policy_registry_versions_state_valid" CHECK (("policy_registry_versions"."lifecycle" IN ('DRAFT', 'LEGAL_REVIEW') AND "policy_registry_versions"."approved_at" IS NULL AND "policy_registry_versions"."published_at" IS NULL AND "policy_registry_versions"."superseded_at" IS NULL AND "policy_registry_versions"."legal_reference" IS NULL)
		OR ("policy_registry_versions"."lifecycle" = 'APPROVED' AND "policy_registry_versions"."approved_at" IS NOT NULL AND "policy_registry_versions"."approved_by" IS NOT NULL AND "policy_registry_versions"."legal_reference" IS NOT NULL AND "policy_registry_versions"."published_at" IS NULL AND "policy_registry_versions"."superseded_at" IS NULL)
		OR ("policy_registry_versions"."lifecycle" = 'PUBLISHED' AND "policy_registry_versions"."approved_at" IS NOT NULL AND "policy_registry_versions"."published_at" IS NOT NULL AND "policy_registry_versions"."published_by" IS NOT NULL AND "policy_registry_versions"."legal_reference" IS NOT NULL AND "policy_registry_versions"."superseded_at" IS NULL)
		OR ("policy_registry_versions"."lifecycle" = 'SUPERSEDED' AND "policy_registry_versions"."approved_at" IS NOT NULL AND "policy_registry_versions"."published_at" IS NOT NULL AND "policy_registry_versions"."superseded_at" IS NOT NULL AND "policy_registry_versions"."superseded_by" IS NOT NULL AND "policy_registry_versions"."legal_reference" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "policy_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"content_sha256" text NOT NULL,
	"decision" text NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_consent_events_decision_valid" CHECK ("policy_consent_events"."decision" IN ('ACCEPTED', 'DECLINED')),
	CONSTRAINT "policy_consent_events_source_valid" CHECK ("policy_consent_events"."source" IN ('SIGNUP', 'POLICY_REVIEW', 'API')),
	CONSTRAINT "policy_consent_events_hash_valid" CHECK ("policy_consent_events"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"registration_country" text NOT NULL,
	"status" text DEFAULT 'DISABLED' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_entities_name_valid" CHECK (char_length(btrim("legal_entities"."legal_name")) BETWEEN 2 AND 200),
	CONSTRAINT "legal_entities_type_valid" CHECK ("legal_entities"."entity_type" IN ('COMPANY', 'INDIVIDUAL', 'PARTNERSHIP')),
	CONSTRAINT "legal_entities_country_valid" CHECK ("legal_entities"."registration_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "legal_entities_status_valid" CHECK ("legal_entities"."status" IN ('DISABLED', 'ACTIVE')),
	CONSTRAINT "legal_entities_capabilities_valid" CHECK (jsonb_typeof("legal_entities"."capabilities") = 'array'),
	CONSTRAINT "legal_entities_active_valid" CHECK (("legal_entities"."status" = 'DISABLED') OR ("legal_entities"."activated_at" IS NOT NULL AND "legal_entities"."activated_by" IS NOT NULL AND jsonb_array_length("legal_entities"."capabilities") > 0))
);
--> statement-breakpoint
CREATE TABLE "market_compliance_settings" (
	"market_id" text PRIMARY KEY NOT NULL,
	"seller_verification_required" boolean DEFAULT false NOT NULL,
	"minor_protection_enabled" boolean DEFAULT false NOT NULL,
	"minimum_age" integer DEFAULT 18 NOT NULL,
	"guardian_consent_required" boolean DEFAULT false NOT NULL,
	"legal_entity_required" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_compliance_settings_age_valid" CHECK ("market_compliance_settings"."minimum_age" BETWEEN 13 AND 21),
	CONSTRAINT "market_compliance_settings_guardian_valid" CHECK (NOT "market_compliance_settings"."guardian_consent_required" OR "market_compliance_settings"."minor_protection_enabled")
);
--> statement-breakpoint
CREATE TABLE "seller_verification_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"requested_level" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"risk_basis" text DEFAULT 'UNASSESSED' NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_verification_profiles_level_valid" CHECK ("seller_verification_profiles"."requested_level" IN ('BASIC', 'ENHANCED')),
	CONSTRAINT "seller_verification_profiles_status_valid" CHECK ("seller_verification_profiles"."status" IN ('PENDING', 'VERIFIED', 'REJECTED')),
	CONSTRAINT "seller_verification_profiles_risk_valid" CHECK ("seller_verification_profiles"."risk_basis" IN ('UNASSESSED', 'LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "seller_verification_profiles_evidence_valid" CHECK (jsonb_typeof("seller_verification_profiles"."evidence_refs") = 'array'),
	CONSTRAINT "seller_verification_profiles_decision_valid" CHECK (("seller_verification_profiles"."status" = 'PENDING' AND "seller_verification_profiles"."decided_at" IS NULL AND "seller_verification_profiles"."decided_by" IS NULL AND "seller_verification_profiles"."decision_reason" IS NULL)
		OR ("seller_verification_profiles"."status" IN ('VERIFIED', 'REJECTED') AND "seller_verification_profiles"."decided_at" IS NOT NULL AND "seller_verification_profiles"."decided_by" IS NOT NULL AND "seller_verification_profiles"."decided_by" <> "seller_verification_profiles"."user_id")),
	CONSTRAINT "seller_verification_profiles_rejection_reason" CHECK ("seller_verification_profiles"."status" <> 'REJECTED' OR ("seller_verification_profiles"."decision_reason" IS NOT NULL AND btrim("seller_verification_profiles"."decision_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "minor_protection_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"declared_status" text NOT NULL,
	"guardian_status" text NOT NULL,
	"guardian_reference_sha256" text,
	"guardian_decided_at" timestamp with time zone,
	"source" text DEFAULT 'SELF_DECLARATION' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "minor_protection_declarations_status_valid" CHECK ("minor_protection_declarations"."declared_status" IN ('ADULT', 'MINOR')),
	CONSTRAINT "minor_protection_declarations_guardian_status_valid" CHECK ("minor_protection_declarations"."guardian_status" IN ('NOT_REQUIRED', 'PENDING', 'GRANTED', 'DENIED')),
	CONSTRAINT "minor_protection_declarations_source_valid" CHECK ("minor_protection_declarations"."source" IN ('SELF_DECLARATION', 'GUARDIAN_VERIFICATION')),
	CONSTRAINT "minor_protection_declarations_guardian_hash_valid" CHECK ("minor_protection_declarations"."guardian_reference_sha256" IS NULL OR "minor_protection_declarations"."guardian_reference_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "minor_protection_declarations_state_valid" CHECK (("minor_protection_declarations"."declared_status" = 'ADULT' AND "minor_protection_declarations"."guardian_status" = 'NOT_REQUIRED' AND "minor_protection_declarations"."guardian_reference_sha256" IS NULL AND "minor_protection_declarations"."guardian_decided_at" IS NULL AND "minor_protection_declarations"."source" = 'SELF_DECLARATION')
		OR ("minor_protection_declarations"."declared_status" = 'MINOR' AND "minor_protection_declarations"."guardian_status" IN ('NOT_REQUIRED', 'PENDING') AND "minor_protection_declarations"."guardian_reference_sha256" IS NULL AND "minor_protection_declarations"."guardian_decided_at" IS NULL AND "minor_protection_declarations"."source" = 'SELF_DECLARATION')
		OR ("minor_protection_declarations"."declared_status" = 'MINOR' AND "minor_protection_declarations"."guardian_status" IN ('GRANTED', 'DENIED') AND "minor_protection_declarations"."guardian_reference_sha256" IS NOT NULL AND "minor_protection_declarations"."guardian_decided_at" IS NOT NULL AND "minor_protection_declarations"."source" = 'GUARDIAN_VERIFICATION'))
);
--> statement-breakpoint
ALTER TABLE "policy_registry_versions" ADD CONSTRAINT "policy_registry_versions_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_registry_versions" ADD CONSTRAINT "policy_registry_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_registry_versions" ADD CONSTRAINT "policy_registry_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_registry_versions" ADD CONSTRAINT "policy_registry_versions_superseded_by_users_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_consent_events" ADD CONSTRAINT "policy_consent_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_compliance_settings" ADD CONSTRAINT "market_compliance_settings_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_compliance_settings" ADD CONSTRAINT "market_compliance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verification_profiles" ADD CONSTRAINT "seller_verification_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verification_profiles" ADD CONSTRAINT "seller_verification_profiles_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verification_profiles" ADD CONSTRAINT "seller_verification_profiles_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minor_protection_declarations" ADD CONSTRAINT "minor_protection_declarations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minor_protection_declarations" ADD CONSTRAINT "minor_protection_declarations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_registry_versions_unique" ON "policy_registry_versions" USING btree ("policy_key","version","market_scope");--> statement-breakpoint
CREATE INDEX "policy_registry_versions_key_idx" ON "policy_registry_versions" USING btree ("policy_key","lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_consent_events_idempotency_unique" ON "policy_consent_events" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "policy_consent_events_user_idx" ON "policy_consent_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_market_unique" ON "legal_entities" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "legal_entities_status_idx" ON "legal_entities" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_verification_profiles_idempotency_unique" ON "seller_verification_profiles" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "seller_verification_profiles_user_idx" ON "seller_verification_profiles" USING btree ("user_id","market_id","created_at");--> statement-breakpoint
CREATE INDEX "seller_verification_profiles_queue_idx" ON "seller_verification_profiles" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "minor_protection_declarations_idempotency_unique" ON "minor_protection_declarations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "minor_protection_declarations_user_idx" ON "minor_protection_declarations" USING btree ("user_id","market_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION policy_registry_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'policy registry versions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'DRAFT' THEN
      RAISE EXCEPTION 'a registered policy version starts as DRAFT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
    OR NEW.market_scope IS DISTINCT FROM OLD.market_scope
    OR NEW.requires_acceptance IS DISTINCT FROM OLD.requires_acceptance
    OR NEW.material_change IS DISTINCT FROM OLD.material_change
    OR NEW.registered_by IS DISTINCT FROM OLD.registered_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'policy version facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.lifecycle IN ('APPROVED', 'PUBLISHED', 'SUPERSEDED') AND NEW.legal_reference IS DISTINCT FROM OLD.legal_reference THEN
    RAISE EXCEPTION 'an approved legal reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'an approval time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'a publication time is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.lifecycle = 'DRAFT' AND NEW.lifecycle = 'LEGAL_REVIEW')
    OR (OLD.lifecycle = 'LEGAL_REVIEW' AND NEW.lifecycle = 'APPROVED')
    OR (OLD.lifecycle = 'APPROVED' AND NEW.lifecycle = 'PUBLISHED')
    OR (OLD.lifecycle = 'PUBLISHED' AND NEW.lifecycle = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'invalid policy lifecycle transition from % to %', OLD.lifecycle, NEW.lifecycle USING ERRCODE = '23514';
  END IF;
  IF NEW.lifecycle = 'APPROVED' AND (NEW.legal_reference IS NULL OR btrim(NEW.legal_reference) = '') THEN
    RAISE EXCEPTION 'an approved policy needs an external legal reference' USING ERRCODE = '23514';
  END IF;
  IF NEW.lifecycle = 'PUBLISHED' AND (NEW.published_at IS NULL OR NEW.published_by IS NULL) THEN
    RAISE EXCEPTION 'a published policy needs its publisher and time' USING ERRCODE = '23514';
  END IF;
  IF NEW.lifecycle = 'SUPERSEDED' AND (NEW.superseded_at IS NULL OR NEW.superseded_by IS NULL) THEN
    RAISE EXCEPTION 'a superseded policy needs its successor reference and time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER policy_registry_versions_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "policy_registry_versions"
FOR EACH ROW EXECUTE FUNCTION policy_registry_versions_guard();
--> statement-breakpoint
CREATE TRIGGER policy_registry_versions_guard_truncate
BEFORE TRUNCATE ON "policy_registry_versions"
FOR EACH STATEMENT EXECUTE FUNCTION policy_registry_versions_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION policy_consent_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'policy consent events are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'policy consent events cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER policy_consent_events_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "policy_consent_events"
FOR EACH ROW EXECUTE FUNCTION policy_consent_events_guard();
--> statement-breakpoint
CREATE TRIGGER policy_consent_events_guard_truncate
BEFORE TRUNCATE ON "policy_consent_events"
FOR EACH STATEMENT EXECUTE FUNCTION policy_consent_events_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION legal_entities_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'legal entities cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DISABLED' THEN
      RAISE EXCEPTION 'a legal entity is created disabled' USING ERRCODE = '23514';
    END IF;
    IF jsonb_array_length(NEW.capabilities) <> 0 THEN
      RAISE EXCEPTION 'capabilities are activated explicitly after creation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.market_id IS DISTINCT FROM OLD.market_id
    OR NEW.legal_name IS DISTINCT FROM OLD.legal_name
    OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
    OR NEW.registration_country IS DISTINCT FROM OLD.registration_country
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'legal entity identity is immutable; register a new entity instead' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'DISABLED' AND NEW.status = 'ACTIVE')
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'DISABLED')
  ) THEN
    RAISE EXCEPTION 'invalid legal entity transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'ACTIVE' THEN
    IF jsonb_array_length(NEW.capabilities) = 0 THEN
      RAISE EXCEPTION 'activation needs at least one capability' USING ERRCODE = '23514';
    END IF;
    IF NEW.activated_at IS NULL OR NEW.activated_by IS NULL THEN
      RAISE EXCEPTION 'activation needs its actor and time' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'DISABLED' AND (NEW.deactivated_at IS NULL OR NEW.deactivated_by IS NULL) THEN
    RAISE EXCEPTION 'deactivation needs its actor and time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'DISABLED' AND NEW.capabilities IS DISTINCT FROM OLD.capabilities THEN
    RAISE EXCEPTION 'deactivation cannot change capabilities' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER legal_entities_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "legal_entities"
FOR EACH ROW EXECUTE FUNCTION legal_entities_guard();
--> statement-breakpoint
CREATE TRIGGER legal_entities_guard_truncate
BEFORE TRUNCATE ON "legal_entities"
FOR EACH STATEMENT EXECUTE FUNCTION legal_entities_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION market_compliance_settings_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'market compliance settings cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.market_id IS DISTINCT FROM OLD.market_id THEN
    RAISE EXCEPTION 'a compliance settings row belongs to one market' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER market_compliance_settings_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "market_compliance_settings"
FOR EACH ROW EXECUTE FUNCTION market_compliance_settings_guard();
--> statement-breakpoint
CREATE TRIGGER market_compliance_settings_guard_truncate
BEFORE TRUNCATE ON "market_compliance_settings"
FOR EACH STATEMENT EXECUTE FUNCTION market_compliance_settings_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION seller_verification_profiles_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'seller verification profiles cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a submitted verification starts as PENDING' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.market_id IS DISTINCT FROM OLD.market_id
    OR NEW.requested_level IS DISTINCT FROM OLD.requested_level
    OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'seller verification facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (OLD.status = 'PENDING' AND NEW.status IN ('VERIFIED', 'REJECTED')) THEN
    RAISE EXCEPTION 'invalid seller verification transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_at IS NULL OR NEW.decided_by IS NULL OR NEW.decided_by = NEW.user_id THEN
    RAISE EXCEPTION 'verification is decided by someone other than the seller' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER seller_verification_profiles_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "seller_verification_profiles"
FOR EACH ROW EXECUTE FUNCTION seller_verification_profiles_guard();
--> statement-breakpoint
CREATE TRIGGER seller_verification_profiles_guard_truncate
BEFORE TRUNCATE ON "seller_verification_profiles"
FOR EACH STATEMENT EXECUTE FUNCTION seller_verification_profiles_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION minor_protection_declarations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'minor protection declarations are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'minor protection declarations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER minor_protection_declarations_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "minor_protection_declarations"
FOR EACH ROW EXECUTE FUNCTION minor_protection_declarations_guard();
--> statement-breakpoint
CREATE TRIGGER minor_protection_declarations_guard_truncate
BEFORE TRUNCATE ON "minor_protection_declarations"
FOR EACH STATEMENT EXECUTE FUNCTION minor_protection_declarations_guard();
