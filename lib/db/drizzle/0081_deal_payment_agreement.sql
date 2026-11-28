-- Deal payment agreement (owner decision 2026-11-28): Jassim arranges HOW buyer and seller settle
-- (direct transfer to the seller, or cash on delivery) and records what each party said. No money
-- passes through JassimAI: there is no balance, ledger, escrow, payout or settlement here. Additive
-- only: four new tables, no existing table or row is changed.
-- * deal_payment_catalog_changes: admin changes to the per-country method catalog (append-only).
--   ACTIVE requires a source reference. The latest row per (country, method) wins.
-- * seller_payment_methods: the methods a seller accepts in a market and the instructions they
--   chose to give buyers. Private to the seller; shown to a buyer only through an agreement.
-- * deal_payment_agreements: one per order; what was accepted, proposed and agreed.
-- * deal_payment_events: who did what and when (append-only).
CREATE TABLE "deal_payment_catalog_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"country_code" text NOT NULL,
	"method_code" text,
	"status" text NOT NULL,
	"label_ar" text,
	"kind" text,
	"currencies" jsonb,
	"source_reference" text,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_payment_catalog_changes_status_valid" CHECK ("deal_payment_catalog_changes"."status" IN ('ACTIVE', 'LIMITED', 'UNAVAILABLE', 'UNDER_REVIEW')),
	CONSTRAINT "deal_payment_catalog_changes_kind_valid" CHECK ("deal_payment_catalog_changes"."kind" IS NULL OR "deal_payment_catalog_changes"."kind" IN ('DIRECT', 'COD')),
	CONSTRAINT "deal_payment_catalog_changes_active_sourced" CHECK ("deal_payment_catalog_changes"."status" <> 'ACTIVE' OR length(trim(coalesce("deal_payment_catalog_changes"."source_reference", ''))) > 0),
	CONSTRAINT "deal_payment_catalog_changes_reason_present" CHECK (length(trim("deal_payment_catalog_changes"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "deal_payment_catalog_changes" ADD CONSTRAINT "deal_payment_catalog_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_payment_catalog_changes_lookup_idx" ON "deal_payment_catalog_changes" USING btree ("country_code","method_code","created_at");--> statement-breakpoint
CREATE TABLE "seller_payment_methods" (
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"method_code" text NOT NULL,
	"custom_label" text,
	"instructions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"share_policy" text DEFAULT 'ON_REQUEST' NOT NULL,
	"cod_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_payment_methods_pk" PRIMARY KEY("seller_id","market_id","method_code"),
	CONSTRAINT "seller_payment_methods_share_policy_valid" CHECK ("seller_payment_methods"."share_policy" IN ('ON_REQUEST', 'CONFIRMED_BUYERS'))
);
--> statement-breakpoint
ALTER TABLE "seller_payment_methods" ADD CONSTRAINT "seller_payment_methods_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payment_methods" ADD CONSTRAINT "seller_payment_methods_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "deal_payment_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"market_id" text NOT NULL,
	"country_code" text NOT NULL,
	"currency_code" text NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"accepted_methods" jsonb NOT NULL,
	"proposed_method" text,
	"proposed_label" text,
	"proposed_by" text,
	"agreed_method" text,
	"agreed_label" text,
	"status" text NOT NULL,
	"instructions_shared" jsonb,
	"instructions_shared_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_payment_agreements_order_unique" UNIQUE("order_id"),
	CONSTRAINT "deal_payment_agreements_status_valid" CHECK ("deal_payment_agreements"."status" IN ('DRAFT', 'WAITING_FOR_SELLER', 'WAITING_FOR_BUYER', 'PAYMENT_METHOD_PROPOSED', 'PAYMENT_METHOD_CONFIRMED', 'AWAITING_PAYMENT', 'BUYER_REPORTED_PAID', 'SELLER_CONFIRMED_RECEIPT', 'COD_PENDING_DELIVERY', 'COD_COLLECTED', 'COMPLETED', 'CANCELLED', 'DISPUTED')),
	CONSTRAINT "deal_payment_agreements_proposed_by_valid" CHECK ("deal_payment_agreements"."proposed_by" IS NULL OR "deal_payment_agreements"."proposed_by" IN ('BUYER', 'SELLER')),
	CONSTRAINT "deal_payment_agreements_proposal_consistent" CHECK (("deal_payment_agreements"."status" = 'PAYMENT_METHOD_PROPOSED') = ("deal_payment_agreements"."proposed_method" IS NOT NULL AND "deal_payment_agreements"."proposed_by" IS NOT NULL)),
	CONSTRAINT "deal_payment_agreements_agreed_consistent" CHECK ("deal_payment_agreements"."status" NOT IN ('PAYMENT_METHOD_CONFIRMED', 'AWAITING_PAYMENT', 'BUYER_REPORTED_PAID', 'SELLER_CONFIRMED_RECEIPT', 'COD_PENDING_DELIVERY', 'COD_COLLECTED', 'COMPLETED') OR "deal_payment_agreements"."agreed_method" IS NOT NULL),
	CONSTRAINT "deal_payment_agreements_parties_distinct" CHECK ("deal_payment_agreements"."buyer_id" <> "deal_payment_agreements"."seller_id")
);
--> statement-breakpoint
ALTER TABLE "deal_payment_agreements" ADD CONSTRAINT "deal_payment_agreements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_payment_agreements" ADD CONSTRAINT "deal_payment_agreements_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_payment_agreements" ADD CONSTRAINT "deal_payment_agreements_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_payment_agreements" ADD CONSTRAINT "deal_payment_agreements_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_payment_agreements_seller_idx" ON "deal_payment_agreements" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "deal_payment_agreements_buyer_idx" ON "deal_payment_agreements" USING btree ("buyer_id","status");--> statement-breakpoint
CREATE TABLE "deal_payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"order_id" text NOT NULL,
	"actor_id" text,
	"actor_role" text NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_payment_events_actor_role_valid" CHECK ("deal_payment_events"."actor_role" IN ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM')),
	CONSTRAINT "deal_payment_events_admin_reason" CHECK ("deal_payment_events"."actor_role" <> 'ADMIN' OR length(trim(coalesce("deal_payment_events"."detail"->>'reason', ''))) > 0),
	CONSTRAINT "deal_payment_events_actor_present" CHECK ("deal_payment_events"."actor_role" = 'SYSTEM' OR "deal_payment_events"."actor_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "deal_payment_events" ADD CONSTRAINT "deal_payment_events_agreement_id_deal_payment_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."deal_payment_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_payment_events" ADD CONSTRAINT "deal_payment_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_payment_events_agreement_idx" ON "deal_payment_events" USING btree ("agreement_id","created_at");--> statement-breakpoint
CREATE TRIGGER deal_payment_events_reject_update_delete
BEFORE UPDATE OR DELETE ON deal_payment_events
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER deal_payment_events_reject_truncate
BEFORE TRUNCATE ON deal_payment_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER deal_payment_catalog_changes_reject_update_delete
BEFORE UPDATE OR DELETE ON deal_payment_catalog_changes
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
--> statement-breakpoint
CREATE TRIGGER deal_payment_catalog_changes_reject_truncate
BEFORE TRUNCATE ON deal_payment_catalog_changes
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_event_mutation();
