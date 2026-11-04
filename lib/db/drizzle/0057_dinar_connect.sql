-- DINAR Connect: additive external discovery, consented attribution and separate commission accounting.
-- No historical marketplace prices, orders, fees, seller dues or migration identities are rewritten.
ALTER TABLE provider_connections ADD COLUMN namespace text NOT NULL DEFAULT 'MARKETPLACE';
--> statement-breakpoint
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_namespace_valid CHECK (namespace IN ('MARKETPLACE','CONNECT'));
--> statement-breakpoint
CREATE INDEX provider_connections_owner_namespace_idx ON provider_connections(owner_user_id, namespace, status);
--> statement-breakpoint
CREATE TABLE "connect_agreement_acceptances" (
	"agreement_id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"accepted_by" text NOT NULL,
	"terms_digest" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"version" integer NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_digest" text NOT NULL,
	"proposed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_agreements_version_digest_valid" CHECK ("connect_agreements"."version">0 AND "connect_agreements"."terms_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "connect_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"actor_id" text,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb NOT NULL,
	"idempotency_key" text,
	"request_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_commission_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"source_event_id" text,
	"source_audit_id" text,
	"source_key" text NOT NULL,
	"bucket" text NOT NULL,
	"delta_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_ledger_bucket_valid" CHECK ("connect_commission_ledger"."bucket" IN ('EARNED','APPROVED','PAYABLE','SIMULATED_SETTLED','RECOVERY_DUE') AND "connect_commission_ledger"."mode" IN ('SIMULATION_ONLY','LIVE') AND "connect_commission_ledger"."delta_minor" BETWEEN -9007199254740991 AND 9007199254740991),
	CONSTRAINT "connect_ledger_source_valid" CHECK (("connect_commission_ledger"."source_event_id" IS NULL) <> ("connect_commission_ledger"."source_audit_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "connect_external_events" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"external_event_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"credential_prefix" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_ingestion_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"external_batch_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'PENDING_REVIEW' NOT NULL,
	"mode" text NOT NULL,
	"endpoint_url" text,
	"capabilities" jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_revision" integer,
	"provider_connection_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_integrations_status_valid" CHECK ("connect_integrations"."status" IN ('PENDING_REVIEW','APPROVED','REJECTED','SUSPENDED','REVOKED') AND "connect_integrations"."revision">0 AND "connect_integrations"."mode" IN ('SIMULATION_ONLY','LIVE')),
	CONSTRAINT "connect_integrations_kind_valid" CHECK ("connect_integrations"."kind" IN ('WEBSITE','FEED','API','OAUTH','MCP'))
);
--> statement-breakpoint
CREATE TABLE "connect_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"user_id" text NOT NULL,
	"state_digest" text NOT NULL,
	"verifier_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category_id" text NOT NULL,
	"price_minor" bigint,
	"currency_code" text,
	"minor_unit_scale" integer,
	"availability" text NOT NULL,
	"target_path" text NOT NULL,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_version" integer NOT NULL,
	"source_checked_at" timestamp with time zone NOT NULL,
	"payload_digest" text NOT NULL,
	"status" text DEFAULT 'PUBLISHED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_offers_kind_status_valid" CHECK ("connect_offers"."kind" IN ('PRODUCT','SERVICE') AND "connect_offers"."availability" IN ('AVAILABLE','UNAVAILABLE','UNKNOWN') AND "connect_offers"."status" IN ('PUBLISHED','HIDDEN') AND "connect_offers"."source_version">0),
	CONSTRAINT "connect_offers_money_valid" CHECK (("connect_offers"."price_minor" IS NULL AND "connect_offers"."currency_code" IS NULL AND "connect_offers"."minor_unit_scale" IS NULL) OR ("connect_offers"."price_minor" BETWEEN 0 AND 9007199254740991 AND "connect_offers"."currency_code" ~ '^[A-Z]{3}$' AND "connect_offers"."minor_unit_scale" BETWEEN 0 AND 4))
);
--> statement-breakpoint
CREATE TABLE "connect_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"market_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_partners_status_valid" CHECK ("connect_partners"."status" IN ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED','SUSPENDED','REVOKED') AND "connect_partners"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "connect_referrals" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"consent_event_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"source_card_id" text NOT NULL,
	"source_result_set_id" text NOT NULL,
	"offer_snapshot" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_referrals_window_valid" CHECK ("connect_referrals"."expires_at">"connect_referrals"."created_at")
);
--> statement-breakpoint
CREATE TABLE "connect_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"revision" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_sites" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"challenge_digest" text NOT NULL,
	"challenge_expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_sites_status_valid" CHECK ("connect_sites"."status" IN ('PENDING','VERIFIED','REVOKED')),
	CONSTRAINT "connect_sites_verification_valid" CHECK ("connect_sites"."status"<>'VERIFIED' OR ("connect_sites"."verified_at" IS NOT NULL AND "connect_sites"."valid_until">"connect_sites"."verified_at"))
);
--> statement-breakpoint
CREATE TABLE "connect_team_permissions" (
	"delegation_id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"granted_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"external_id" text NOT NULL,
	"referral_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"gross_minor" bigint NOT NULL,
	"eligible_minor" bigint NOT NULL,
	"commission_ceiling_minor" bigint NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"items_snapshot" jsonb NOT NULL,
	"state" text NOT NULL,
	"dispute_from_state" text,
	"last_sequence" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_transactions_money_valid" CHECK ("connect_transactions"."gross_minor" BETWEEN 0 AND 9007199254740991 AND "connect_transactions"."eligible_minor" BETWEEN 0 AND "connect_transactions"."gross_minor" AND "connect_transactions"."commission_ceiling_minor" BETWEEN 0 AND 9007199254740991 AND "connect_transactions"."refunded_minor" BETWEEN 0 AND "connect_transactions"."gross_minor" AND "connect_transactions"."currency_code" ~ '^[A-Z]{3}$' AND "connect_transactions"."last_sequence">0),
	CONSTRAINT "connect_transactions_state_mode_valid" CHECK ("connect_transactions"."state" IN ('PENDING_VERIFICATION','VERIFIED','APPROVED','PAYABLE','SETTLED','REVERSED','DISPUTED','REJECTED') AND "connect_transactions"."mode" IN ('SIMULATION_ONLY','LIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_agreements_partner_version_unique" ON "connect_agreements" USING btree ("partner_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_agreements_id_partner_unique" ON "connect_agreements" USING btree ("id","partner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_audit_idempotency_unique" ON "connect_audit_events" USING btree ("partner_id","actor_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "connect_audit_partner_time_idx" ON "connect_audit_events" USING btree ("partner_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_ledger_source_bucket_unique" ON "connect_commission_ledger" USING btree ("transaction_id","source_key","bucket");
--> statement-breakpoint
CREATE INDEX "connect_ledger_transaction_idx" ON "connect_commission_ledger" USING btree ("transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_events_external_unique" ON "connect_external_events" USING btree ("integration_id","external_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_events_sequence_unique" ON "connect_external_events" USING btree ("transaction_id","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_ingestion_batch_unique" ON "connect_ingestion_batches" USING btree ("integration_id","external_batch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_integrations_id_partner_unique" ON "connect_integrations" USING btree ("id","partner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_integrations_provider_unique" ON "connect_integrations" USING btree ("provider_connection_id");
--> statement-breakpoint
CREATE INDEX "connect_integrations_partner_status_idx" ON "connect_integrations" USING btree ("partner_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_oauth_state_unique" ON "connect_oauth_states" USING btree ("state_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_offers_integration_ref_unique" ON "connect_offers" USING btree ("integration_id","external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_offers_identity_unique" ON "connect_offers" USING btree ("id","partner_id","integration_id");
--> statement-breakpoint
CREATE INDEX "connect_offers_partner_status_idx" ON "connect_offers" USING btree ("partner_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_partners_business_unique" ON "connect_partners" USING btree ("business_id");
--> statement-breakpoint
CREATE INDEX "connect_partners_market_status_idx" ON "connect_partners" USING btree ("market_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_referrals_id_partner_integration_unique" ON "connect_referrals" USING btree ("id","partner_id","integration_id");
--> statement-breakpoint
CREATE INDEX "connect_referrals_partner_time_idx" ON "connect_referrals" USING btree ("partner_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_sites_id_partner_unique" ON "connect_sites" USING btree ("id","partner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_sites_verified_host_unique" ON "connect_sites" USING btree ("hostname") WHERE "connect_sites"."status"='VERIFIED';
--> statement-breakpoint
CREATE INDEX "connect_sites_partner_idx" ON "connect_sites" USING btree ("partner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_transactions_external_unique" ON "connect_transactions" USING btree ("integration_id","external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connect_transactions_scope_unique" ON "connect_transactions" USING btree ("id","partner_id","integration_id");
--> statement-breakpoint
CREATE INDEX "connect_transactions_partner_state_idx" ON "connect_transactions" USING btree ("partner_id","state");
--> statement-breakpoint
ALTER TABLE "connect_agreement_acceptances" ADD CONSTRAINT "connect_agreement_acceptances_agreement_id_connect_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."connect_agreements"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_agreement_acceptances" ADD CONSTRAINT "connect_agreement_acceptances_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_agreement_acceptances" ADD CONSTRAINT "connect_agreement_acceptances_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_agreement_acceptances" ADD CONSTRAINT "connect_acceptance_agreement_partner_fk" FOREIGN KEY ("agreement_id","partner_id") REFERENCES "public"."connect_agreements"("id","partner_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_agreements" ADD CONSTRAINT "connect_agreements_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_agreements" ADD CONSTRAINT "connect_agreements_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_audit_events" ADD CONSTRAINT "connect_audit_events_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_audit_events" ADD CONSTRAINT "connect_audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_commission_ledger" ADD CONSTRAINT "connect_commission_ledger_transaction_id_connect_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."connect_transactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_commission_ledger" ADD CONSTRAINT "connect_commission_ledger_source_event_id_connect_external_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."connect_external_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_commission_ledger" ADD CONSTRAINT "connect_commission_ledger_source_audit_id_connect_audit_events_id_fk" FOREIGN KEY ("source_audit_id") REFERENCES "public"."connect_audit_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_external_events" ADD CONSTRAINT "connect_external_events_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_external_events" ADD CONSTRAINT "connect_external_events_integration_id_connect_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."connect_integrations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_external_events" ADD CONSTRAINT "connect_external_events_transaction_id_connect_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."connect_transactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_external_events" ADD CONSTRAINT "connect_events_transaction_scope_fk" FOREIGN KEY ("transaction_id","partner_id","integration_id") REFERENCES "public"."connect_transactions"("id","partner_id","integration_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_ingestion_batches" ADD CONSTRAINT "connect_ingestion_batches_integration_id_connect_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."connect_integrations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD CONSTRAINT "connect_integrations_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD CONSTRAINT "connect_integrations_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_integrations" ADD CONSTRAINT "connect_integrations_site_partner_fk" FOREIGN KEY ("site_id","partner_id") REFERENCES "public"."connect_sites"("id","partner_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_oauth_states" ADD CONSTRAINT "connect_oauth_states_integration_id_connect_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."connect_integrations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_oauth_states" ADD CONSTRAINT "connect_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_offers" ADD CONSTRAINT "connect_offers_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_offers" ADD CONSTRAINT "connect_offers_integration_partner_fk" FOREIGN KEY ("integration_id","partner_id") REFERENCES "public"."connect_integrations"("id","partner_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_partners" ADD CONSTRAINT "connect_partners_business_id_business_profiles_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_partners" ADD CONSTRAINT "connect_partners_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_referrals" ADD CONSTRAINT "connect_referrals_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_referrals" ADD CONSTRAINT "connect_referrals_consent_event_id_privacy_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."privacy_consent_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_referrals" ADD CONSTRAINT "connect_referrals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_referrals" ADD CONSTRAINT "connect_referrals_offer_scope_fk" FOREIGN KEY ("offer_id","partner_id","integration_id") REFERENCES "public"."connect_offers"("id","partner_id","integration_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_referrals" ADD CONSTRAINT "connect_referrals_agreement_scope_fk" FOREIGN KEY ("agreement_id","partner_id") REFERENCES "public"."connect_agreements"("id","partner_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_secrets" ADD CONSTRAINT "connect_secrets_integration_id_connect_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."connect_integrations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_sites" ADD CONSTRAINT "connect_sites_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_team_permissions" ADD CONSTRAINT "connect_team_permissions_delegation_id_business_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."business_delegations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_team_permissions" ADD CONSTRAINT "connect_team_permissions_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_team_permissions" ADD CONSTRAINT "connect_team_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_transactions" ADD CONSTRAINT "connect_transactions_partner_id_connect_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."connect_partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_transactions" ADD CONSTRAINT "connect_transactions_referral_scope_fk" FOREIGN KEY ("referral_id","partner_id","integration_id") REFERENCES "public"."connect_referrals"("id","partner_id","integration_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connect_transactions" ADD CONSTRAINT "connect_transactions_agreement_scope_fk" FOREIGN KEY ("agreement_id","partner_id") REFERENCES "public"."connect_agreements"("id","partner_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION connect_reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'DINAR Connect evidence and accounting are append-only' USING ERRCODE='55000'; END;
$$;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['connect_agreements','connect_agreement_acceptances','connect_referrals','connect_external_events','connect_audit_events','connect_commission_ledger','connect_ingestion_batches'] LOOP
    EXECUTE format('CREATE TRIGGER connect_append_only_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION connect_reject_immutable_change()',table_name);
    EXECUTE format('CREATE TRIGGER connect_append_only_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION connect_reject_immutable_change()',table_name);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION connect_guard_transaction_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.partner_id,NEW.integration_id,NEW.external_id,NEW.referral_id,NEW.agreement_id,NEW.currency_code,NEW.gross_minor,NEW.eligible_minor,NEW.commission_ceiling_minor,NEW.items_snapshot,NEW.occurred_at,NEW.mode)
 IS DISTINCT FROM ROW(OLD.partner_id,OLD.integration_id,OLD.external_id,OLD.referral_id,OLD.agreement_id,OLD.currency_code,OLD.gross_minor,OLD.eligible_minor,OLD.commission_ceiling_minor,OLD.items_snapshot,OLD.occurred_at,OLD.mode)
 OR NEW.last_sequence<OLD.last_sequence THEN RAISE EXCEPTION 'External transaction source and economic snapshot are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connect_transaction_header_immutable BEFORE UPDATE ON connect_transactions FOR EACH ROW EXECUTE FUNCTION connect_guard_transaction_header();
--> statement-breakpoint
CREATE FUNCTION connect_guard_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM connect_agreements a JOIN connect_partners p ON p.id=a.partner_id JOIN business_profiles b ON b.id=p.business_id
 WHERE a.id=NEW.agreement_id AND a.partner_id=NEW.partner_id AND b.owner_user_id=NEW.accepted_by AND b.verification_status='VERIFIED' AND a.terms_digest=NEW.terms_digest AND a.proposed_by<>NEW.accepted_by)
 THEN RAISE EXCEPTION 'External commission terms require the verified partner owner and the exact independently proposed version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connect_acceptance_authority BEFORE INSERT ON connect_agreement_acceptances FOR EACH ROW EXECUTE FUNCTION connect_guard_acceptance();
--> statement-breakpoint
CREATE FUNCTION connect_guard_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE header connect_transactions%ROWTYPE; BEGIN
 SELECT * INTO header FROM connect_transactions WHERE id=NEW.transaction_id FOR UPDATE;
 IF NOT FOUND OR header.currency_code<>NEW.currency_code OR header.mode<>NEW.mode THEN RAISE EXCEPTION 'External commission currency or mode mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.source_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM connect_external_events e WHERE e.id=NEW.source_event_id AND e.transaction_id=header.id)
 THEN RAISE EXCEPTION 'Foreign transaction evidence cannot fund a commission' USING ERRCODE='23514'; END IF;
 IF NEW.source_audit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM connect_audit_events a WHERE a.id=NEW.source_audit_id AND a.partner_id=header.partner_id AND a.actor_kind='ADMIN')
 THEN RAISE EXCEPTION 'Commission finance command requires independent admin evidence' USING ERRCODE='23514'; END IF;
 IF NEW.bucket='SIMULATED_SETTLED' AND NEW.mode<>'SIMULATION_ONLY' THEN RAISE EXCEPTION 'Simulation is not a receipt of real money' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connect_ledger_evidence_guard BEFORE INSERT ON connect_commission_ledger FOR EACH ROW EXECUTE FUNCTION connect_guard_ledger_source();
--> statement-breakpoint
CREATE FUNCTION connect_check_ledger_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE earned bigint; approved bigint; payable bigint; settled bigint; recovery bigint; ceiling bigint;
BEGIN
 SELECT commission_ceiling_minor INTO ceiling FROM connect_transactions WHERE id=NEW.transaction_id;
 SELECT coalesce(sum(delta_minor) FILTER(WHERE bucket='EARNED'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='APPROVED'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='PAYABLE'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='SIMULATED_SETTLED'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='RECOVERY_DUE'),0)
 INTO earned,approved,payable,settled,recovery FROM connect_commission_ledger WHERE transaction_id=NEW.transaction_id;
 IF earned<0 OR earned>ceiling OR approved<0 OR approved>earned OR payable<0 OR settled<0 OR recovery<0 OR recovery>settled OR payable+settled-recovery>approved
 THEN RAISE EXCEPTION 'External commission ledger does not reconcile' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER connect_ledger_reconciles AFTER INSERT ON connect_commission_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION connect_check_ledger_projection();
--> statement-breakpoint
CREATE FUNCTION connect_check_transaction_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE earned bigint; BEGIN
 SELECT coalesce(sum(delta_minor) FILTER(WHERE bucket='EARNED'),0) INTO earned FROM connect_commission_ledger WHERE transaction_id=NEW.id;
 IF NEW.state='VERIFIED' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='EARNED')
 THEN RAISE EXCEPTION 'Verified external transaction requires source-backed accrual evidence' USING ERRCODE='23514'; END IF;
 IF NEW.state='APPROVED' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='APPROVED')
 THEN RAISE EXCEPTION 'Commission approval requires source-backed evidence' USING ERRCODE='23514'; END IF;
 IF NEW.state='PAYABLE' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='PAYABLE' AND source_audit_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Payable commission requires a reviewed finance command' USING ERRCODE='23514'; END IF;
 IF NEW.state='SETTLED' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='SIMULATED_SETTLED' AND source_audit_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Settlement state requires reconciled simulation evidence; no real money is implied' USING ERRCODE='23514'; END IF;
 IF NEW.state='REVERSED' AND earned<>0 THEN RAISE EXCEPTION 'Reversed commission must reconcile to zero earned' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER connect_transaction_requires_evidence AFTER INSERT OR UPDATE ON connect_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION connect_check_transaction_evidence();

--> statement-breakpoint
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_namespace_scopes CHECK (
 (namespace = 'CONNECT' AND jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) > 0 AND scopes <@ '["connect:catalog:write","connect:events:write"]'::jsonb)
 OR (namespace = 'MARKETPLACE' AND NOT (scopes ?| ARRAY['connect:catalog:write','connect:events:write']))
);
