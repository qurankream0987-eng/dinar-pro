CREATE TABLE "business_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_name_snapshot" text NOT NULL,
	"price_minor_snapshot" integer NOT NULL,
	"currency_code_snapshot" text NOT NULL,
	"period_days_snapshot" integer NOT NULL,
	"pricing_version_snapshot" integer NOT NULL,
	"entitlements_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_subscriptions_status_valid" CHECK ("business_subscriptions"."status" IN ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END', 'CANCELLED', 'EXPIRED', 'PAYMENT_FAILED')),
	CONSTRAINT "business_subscriptions_no_auto_renew" CHECK (NOT "business_subscriptions"."auto_renew"),
	CONSTRAINT "business_subscriptions_period_valid" CHECK ("business_subscriptions"."status" IN ('PENDING', 'PAYMENT_FAILED') OR ("business_subscriptions"."current_period_start" IS NOT NULL AND "business_subscriptions"."current_period_end" > "business_subscriptions"."current_period_start"))
);
--> statement-breakpoint
CREATE TABLE "commercial_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"paid_available_minor" integer DEFAULT 0 NOT NULL,
	"promo_available_minor" integer DEFAULT 0 NOT NULL,
	"reserved_minor" integer DEFAULT 0 NOT NULL,
	"spent_minor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_accounts_non_negative" CHECK ("commercial_accounts"."paid_available_minor" >= 0 AND "commercial_accounts"."promo_available_minor" >= 0 AND "commercial_accounts"."reserved_minor" >= 0 AND "commercial_accounts"."spent_minor" >= 0),
	CONSTRAINT "commercial_accounts_currency_valid" CHECK ("commercial_accounts"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "commercial_entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"bundle_product_id" text NOT NULL,
	"source_entry_id" text NOT NULL,
	"product_type" text NOT NULL,
	"units_total" integer NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL,
	"unit_duration_days" integer NOT NULL,
	"unit_priority_weight" integer DEFAULT 100 NOT NULL,
	"pricing_version" integer NOT NULL,
	"refund_policy" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_entitlements_units_valid" CHECK ("commercial_entitlements"."units_total" > 0 AND "commercial_entitlements"."units_used" >= 0 AND "commercial_entitlements"."units_used" <= "commercial_entitlements"."units_total"),
	CONSTRAINT "commercial_entitlements_type_valid" CHECK ("commercial_entitlements"."product_type" IN ('FEATURED_LISTING', 'VIP_LISTING', 'REFRESH_LISTING')),
	CONSTRAINT "commercial_entitlements_duration_valid" CHECK ("commercial_entitlements"."unit_duration_days" >= 1 AND "commercial_entitlements"."unit_duration_days" <= 365)
);
--> statement-breakpoint
CREATE TABLE "commercial_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"entry_type" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"paid_delta_minor" integer DEFAULT 0 NOT NULL,
	"promo_delta_minor" integer DEFAULT 0 NOT NULL,
	"reserved_delta_minor" integer DEFAULT 0 NOT NULL,
	"spent_delta_minor" integer DEFAULT 0 NOT NULL,
	"product_id" text,
	"product_type" text,
	"pricing_version" integer,
	"promotion_id" text,
	"subscription_id" text,
	"entitlement_id" text,
	"topup_id" text,
	"reverses_entry_id" text,
	"policy_version" integer DEFAULT 0 NOT NULL,
	"provider_key" text,
	"provider_ref" text,
	"idempotency_key" text NOT NULL,
	"traffic_class" text DEFAULT 'TEST' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_ledger_entry_type_valid" CHECK ("commercial_ledger"."entry_type" IN ('CREDIT_TOPUP', 'CREDIT_GRANTED', 'CAMPAIGN_RESERVE', 'CAMPAIGN_RELEASE', 'CAMPAIGN_CHARGE', 'FEATURED_PURCHASE', 'VIP_PURCHASE', 'REFRESH_PURCHASE', 'BUNDLE_PURCHASE', 'SUBSCRIPTION_CHARGE', 'PROMOTION_PURCHASE', 'QUALIFIED_CLICK_CHARGE', 'QUALIFIED_ENGAGEMENT_CHARGE', 'QUALIFIED_LEAD_CHARGE', 'ENTITLEMENT_CONSUMED', 'REFUND', 'CREDIT', 'ADJUSTMENT', 'EXPIRE', 'REVERSAL')),
	CONSTRAINT "commercial_ledger_amount_valid" CHECK ("commercial_ledger"."amount_minor" >= 0),
	CONSTRAINT "commercial_ledger_currency_valid" CHECK ("commercial_ledger"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "commercial_ledger_traffic_valid" CHECK ("commercial_ledger"."traffic_class" IN ('LIVE', 'TEST'))
);
--> statement-breakpoint
CREATE TABLE "commercial_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"policy" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_policies_version_valid" CHECK ("commercial_policies"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "commercial_topups" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"payment_mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"provider_key" text NOT NULL,
	"provider_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"credited_entry_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_topups_status_valid" CHECK ("commercial_topups"."status" IN ('PENDING', 'CREDITED', 'FAILED')),
	CONSTRAINT "commercial_topups_amount_valid" CHECK ("commercial_topups"."amount_minor" > 0),
	CONSTRAINT "commercial_topups_simulation_only" CHECK ("commercial_topups"."payment_mode" = 'SIMULATION_ONLY'),
	CONSTRAINT "commercial_topups_credit_consistent" CHECK (("commercial_topups"."status" = 'CREDITED') = ("commercial_topups"."credited_entry_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "demand_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"actor_key" text NOT NULL,
	"category_id" text,
	"need_key" text NOT NULL,
	"normalized_need" text NOT NULL,
	"city" text,
	"price_min_minor" integer,
	"price_max_minor" integer,
	"currency_code" text NOT NULL,
	"condition" text,
	"result_count" integer NOT NULL,
	"state" text NOT NULL,
	"traffic_class" text DEFAULT 'TEST' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_signals_state_valid" CHECK ("demand_signals"."state" IN ('SEARCHED', 'ZERO_RESULTS', 'LOW_SUPPLY', 'USER_UNSATISFIED', 'SATISFIED', 'CONVERTED', 'EXPIRED')),
	CONSTRAINT "demand_signals_traffic_valid" CHECK ("demand_signals"."traffic_class" IN ('LIVE', 'TEST')),
	CONSTRAINT "demand_signals_result_count_valid" CHECK ("demand_signals"."result_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotion_attributions" (
	"id" text PRIMARY KEY NOT NULL,
	"promotion_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"placement" text NOT NULL,
	"result_set_id" text,
	"viewer_key" text NOT NULL,
	"event_type" text NOT NULL,
	"engagement_kind" text,
	"order_id" text,
	"charge_minor" integer DEFAULT 0 NOT NULL,
	"charge_status" text NOT NULL,
	"ledger_entry_id" text,
	"dedup_key" text NOT NULL,
	"policy_version" integer DEFAULT 0 NOT NULL,
	"traffic_class" text DEFAULT 'TEST' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_attributions_event_valid" CHECK ("promotion_attributions"."event_type" IN ('IMPRESSION', 'ENGAGEMENT', 'CONVERSION')),
	CONSTRAINT "promotion_attributions_kind_valid" CHECK ("promotion_attributions"."engagement_kind" IS NULL OR "promotion_attributions"."engagement_kind" IN ('DETAIL_OPENED', 'COMPARISON_STARTED', 'NEGOTIATION_STARTED', 'PURCHASE_REVIEW_STARTED')),
	CONSTRAINT "promotion_attributions_charge_valid" CHECK ("promotion_attributions"."charge_status" IN ('NOT_BILLABLE', 'CHARGED', 'SKIPPED_SELF', 'SKIPPED_BUDGET', 'SKIPPED_INACTIVE') AND "promotion_attributions"."charge_minor" >= 0 AND ("promotion_attributions"."charge_status" = 'CHARGED') = ("promotion_attributions"."charge_minor" > 0)),
	CONSTRAINT "promotion_attributions_traffic_valid" CHECK ("promotion_attributions"."traffic_class" IN ('LIVE', 'TEST'))
);
--> statement-breakpoint
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_status_valid";--> statement-breakpoint
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_payment_status_valid";--> statement-breakpoint
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_live_requires_payment";--> statement-breakpoint
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_placement_valid";--> statement-breakpoint
ALTER TABLE "promotion_products" DROP CONSTRAINT "promotion_products_placement_valid";--> statement-breakpoint
ALTER TABLE "promotion_products" ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "product_type_snapshot" text DEFAULT 'STANDARD_PROMOTION' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "charging_mode_snapshot" text DEFAULT 'FIXED' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "pricing_version_snapshot" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "refund_policy_snapshot" text DEFAULT 'NON_REFUNDABLE_ON_ACTIVATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "priority_weight_snapshot" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "unit_charge_minor_snapshot" integer;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "budget_minor" integer;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "budget_promo_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "spent_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "released_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "payment_source" text DEFAULT 'SIMULATED_PROVIDER' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "entitlement_id" text;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "tax_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "tax_policy_version" text;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "product_type" text DEFAULT 'STANDARD_PROMOTION' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "charging_mode" text DEFAULT 'FIXED' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "pricing_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "effective_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "max_budget_minor" integer;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "unit_charge_minor" integer;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "priority_weight" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "refund_policy" text DEFAULT 'NON_REFUNDABLE_ON_ACTIVATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "bundle_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "entitlement_expiry_days" integer;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "business_entitlements" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD COLUMN "tax_policy_version" text;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_plan_id_promotion_products_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."promotion_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_accounts" ADD CONSTRAINT "commercial_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_accounts" ADD CONSTRAINT "commercial_accounts_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_entitlements" ADD CONSTRAINT "commercial_entitlements_account_id_commercial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."commercial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_entitlements" ADD CONSTRAINT "commercial_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_entitlements" ADD CONSTRAINT "commercial_entitlements_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_entitlements" ADD CONSTRAINT "commercial_entitlements_bundle_product_id_promotion_products_id_fk" FOREIGN KEY ("bundle_product_id") REFERENCES "public"."promotion_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_account_id_commercial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."commercial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_product_id_promotion_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."promotion_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_promotion_id_listing_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."listing_promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_subscription_id_business_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."business_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_entitlement_id_commercial_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."commercial_entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_ledger" ADD CONSTRAINT "commercial_ledger_topup_id_commercial_topups_id_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."commercial_topups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_policies" ADD CONSTRAINT "commercial_policies_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_policies" ADD CONSTRAINT "commercial_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_topups" ADD CONSTRAINT "commercial_topups_account_id_commercial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."commercial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_topups" ADD CONSTRAINT "commercial_topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_topups" ADD CONSTRAINT "commercial_topups_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_signals" ADD CONSTRAINT "demand_signals_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_attributions" ADD CONSTRAINT "promotion_attributions_promotion_id_listing_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."listing_promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_attributions" ADD CONSTRAINT "promotion_attributions_listing_id_offers_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_attributions" ADD CONSTRAINT "promotion_attributions_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_attributions" ADD CONSTRAINT "promotion_attributions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_subscriptions_user_idempotency_unique" ON "business_subscriptions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "business_subscriptions_one_live" ON "business_subscriptions" USING btree ("user_id","market_id") WHERE "business_subscriptions"."status" IN ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END');--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_accounts_user_market_unique" ON "commercial_accounts" USING btree ("user_id","market_id");--> statement-breakpoint
CREATE INDEX "commercial_entitlements_user_market_idx" ON "commercial_entitlements" USING btree ("user_id","market_id","product_type");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_ledger_account_idempotency_unique" ON "commercial_ledger" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "commercial_ledger_account_created_idx" ON "commercial_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "commercial_ledger_market_type_idx" ON "commercial_ledger" USING btree ("market_id","entry_type");--> statement-breakpoint
CREATE INDEX "commercial_ledger_promotion_idx" ON "commercial_ledger" USING btree ("promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_policies_market_version_unique" ON "commercial_policies" USING btree ("market_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_topups_provider_ref_unique" ON "commercial_topups" USING btree ("provider_key","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_topups_user_idempotency_unique" ON "commercial_topups" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "demand_signals_market_created_idx" ON "demand_signals" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "demand_signals_market_need_idx" ON "demand_signals" USING btree ("market_id","need_key");--> statement-breakpoint
CREATE INDEX "demand_signals_actor_idx" ON "demand_signals" USING btree ("actor_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_attributions_dedup_unique" ON "promotion_attributions" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "promotion_attributions_promotion_idx" ON "promotion_attributions" USING btree ("promotion_id","event_type");--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_entitlement_id_commercial_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."commercial_entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_source_valid" CHECK ("listing_promotions"."payment_source" IN ('SIMULATED_PROVIDER', 'COMMERCIAL_BALANCE', 'BUNDLE_ENTITLEMENT'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_source_status" CHECK (("listing_promotions"."payment_source" = 'SIMULATED_PROVIDER') OR ("listing_promotions"."payment_source" = 'COMMERCIAL_BALANCE' AND "listing_promotions"."payment_status" = 'BALANCE_CHARGED') OR ("listing_promotions"."payment_source" = 'BUNDLE_ENTITLEMENT' AND "listing_promotions"."payment_status" = 'ENTITLEMENT_CONSUMED' AND "listing_promotions"."entitlement_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_budget_valid" CHECK ("listing_promotions"."spent_minor" >= 0 AND "listing_promotions"."released_minor" >= 0 AND "listing_promotions"."budget_promo_minor" >= 0 AND "listing_promotions"."tax_minor" >= 0 AND ("listing_promotions"."budget_minor" IS NULL AND "listing_promotions"."spent_minor" = 0 AND "listing_promotions"."released_minor" = 0 AND "listing_promotions"."budget_promo_minor" = 0 OR "listing_promotions"."budget_minor" > 0 AND "listing_promotions"."budget_promo_minor" <= "listing_promotions"."budget_minor" AND "listing_promotions"."spent_minor" + "listing_promotions"."released_minor" <= "listing_promotions"."budget_minor"));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_budget_terms" CHECK (("listing_promotions"."charging_mode_snapshot" = 'PREPAID_BUDGET') = ("listing_promotions"."budget_minor" IS NOT NULL AND "listing_promotions"."unit_charge_minor_snapshot" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_status_valid" CHECK ("listing_promotions"."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED', 'BUDGET_EXHAUSTED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_status_valid" CHECK ("listing_promotions"."payment_status" IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_FAILED', 'LEGACY_UNVERIFIED', 'BALANCE_CHARGED', 'ENTITLEMENT_CONSUMED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_live_requires_payment" CHECK ("listing_promotions"."status" NOT IN ('ACTIVE', 'PAUSED') OR "listing_promotions"."payment_status" IN ('SIMULATION_CAPTURED', 'LEGACY_UNVERIFIED', 'BALANCE_CHARGED', 'ENTITLEMENT_CONSUMED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_placement_valid" CHECK ("listing_promotions"."placement_snapshot" IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_type_valid" CHECK ("promotion_products"."product_type" IN ('STANDARD_PROMOTION', 'FEATURED_LISTING', 'VIP_LISTING', 'REFRESH_LISTING', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND_CAPTURE', 'PROMOTION_BUNDLE', 'EXTRA_LISTING_QUOTA', 'DINAR_BUSINESS', 'SPONSORED_SURFACE'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_type_placement" CHECK (("promotion_products"."product_type", "promotion_products"."placement") IN (('STANDARD_PROMOTION', 'SEARCH_AND_CHAT'), ('FEATURED_LISTING', 'FEATURED'), ('VIP_LISTING', 'VIP'), ('REFRESH_LISTING', 'REFRESH'), ('SPONSORED_SEARCH', 'SPONSORED_SEARCH'), ('SPONSORED_RECOMMENDATION', 'SPONSORED_RECOMMENDATION'), ('DEMAND_CAPTURE', 'DEMAND'), ('PROMOTION_BUNDLE', 'NONE'), ('EXTRA_LISTING_QUOTA', 'NONE'), ('DINAR_BUSINESS', 'NONE'), ('SPONSORED_SURFACE', 'NONE')));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_category_scope" CHECK (("promotion_products"."placement" = 'NONE') = ("promotion_products"."category_id" IS NULL));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_charging_mode_valid" CHECK ("promotion_products"."charging_mode" IN ('FIXED', 'PREPAID_BUDGET', 'QUALIFIED_IMPRESSION', 'QUALIFIED_CLICK', 'QUALIFIED_ENGAGEMENT', 'QUALIFIED_LEAD', 'SUBSCRIPTION'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_charging_mode_enabled" CHECK ("promotion_products"."charging_mode" IN ('FIXED', 'PREPAID_BUDGET', 'SUBSCRIPTION') OR NOT "promotion_products"."enabled");--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_budget_terms" CHECK (("promotion_products"."charging_mode" = 'PREPAID_BUDGET') = ("promotion_products"."unit_charge_minor" IS NOT NULL AND "promotion_products"."unit_charge_minor" > 0 AND "promotion_products"."unit_charge_minor" <= "promotion_products"."price_minor" AND ("promotion_products"."max_budget_minor" IS NULL OR "promotion_products"."max_budget_minor" >= "promotion_products"."price_minor")));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_refund_policy_valid" CHECK ("promotion_products"."refund_policy" IN ('NON_REFUNDABLE_ON_ACTIVATION', 'RELEASE_UNUSED_BUDGET', 'UNUSED_UNITS_TO_CREDIT', 'NO_REFUND'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_priority_valid" CHECK ("promotion_products"."priority_weight" >= 1 AND "promotion_products"."priority_weight" <= 1000);--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_version_valid" CHECK ("promotion_products"."pricing_version" >= 1);--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_prepared_types_disabled" CHECK ("promotion_products"."product_type" NOT IN ('EXTRA_LISTING_QUOTA', 'SPONSORED_SURFACE') OR NOT "promotion_products"."enabled");--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_placement_valid" CHECK ("promotion_products"."placement" IN ('SEARCH_AND_CHAT', 'FEATURED', 'VIP', 'REFRESH', 'SPONSORED_SEARCH', 'SPONSORED_RECOMMENDATION', 'DEMAND', 'NONE'));--> statement-breakpoint
-- Monetization V3: the accepted commercial contract of a campaign is immutable, its
-- spend and release only grow, and BUDGET_EXHAUSTED is final like other terminal states.
CREATE OR REPLACE FUNCTION listing_promotions_integrity() RETURNS trigger AS $$
DECLARE
  listing_owner text;
  listing_market text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "seller_id", "market_id" INTO listing_owner, listing_market FROM "offers" WHERE "id" = NEW."listing_id";
    IF listing_owner IS DISTINCT FROM NEW."seller_id" OR listing_market IS DISTINCT FROM NEW."market_id" THEN
      RAISE EXCEPTION 'listing_promotions seller and market must match the listing' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."listing_id" IS DISTINCT FROM OLD."listing_id"
    OR NEW."seller_id" IS DISTINCT FROM OLD."seller_id"
    OR NEW."market_id" IS DISTINCT FROM OLD."market_id"
    OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."product_name_snapshot" IS DISTINCT FROM OLD."product_name_snapshot"
    OR NEW."category_id_snapshot" IS DISTINCT FROM OLD."category_id_snapshot"
    OR NEW."price_minor_snapshot" IS DISTINCT FROM OLD."price_minor_snapshot"
    OR NEW."currency_code_snapshot" IS DISTINCT FROM OLD."currency_code_snapshot"
    OR NEW."placement_snapshot" IS DISTINCT FROM OLD."placement_snapshot"
    OR NEW."duration_days_snapshot" IS DISTINCT FROM OLD."duration_days_snapshot"
    OR NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."product_type_snapshot" IS DISTINCT FROM OLD."product_type_snapshot"
    OR NEW."charging_mode_snapshot" IS DISTINCT FROM OLD."charging_mode_snapshot"
    OR NEW."pricing_version_snapshot" IS DISTINCT FROM OLD."pricing_version_snapshot"
    OR NEW."refund_policy_snapshot" IS DISTINCT FROM OLD."refund_policy_snapshot"
    OR NEW."priority_weight_snapshot" IS DISTINCT FROM OLD."priority_weight_snapshot"
    OR NEW."unit_charge_minor_snapshot" IS DISTINCT FROM OLD."unit_charge_minor_snapshot"
    OR NEW."budget_minor" IS DISTINCT FROM OLD."budget_minor"
    OR NEW."budget_promo_minor" IS DISTINCT FROM OLD."budget_promo_minor"
    OR NEW."payment_source" IS DISTINCT FROM OLD."payment_source"
    OR NEW."entitlement_id" IS DISTINCT FROM OLD."entitlement_id"
    OR NEW."tax_minor" IS DISTINCT FROM OLD."tax_minor"
    OR NEW."tax_policy_version" IS DISTINCT FROM OLD."tax_policy_version"
    OR (OLD."payment_reference" IS NOT NULL AND NEW."payment_reference" IS DISTINCT FROM OLD."payment_reference")
  THEN
    RAISE EXCEPTION 'listing_promotions contract snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."spent_minor" < OLD."spent_minor" OR NEW."released_minor" < OLD."released_minor" THEN
    RAISE EXCEPTION 'listing_promotions spend and release only grow' USING ERRCODE = '23514';
  END IF;
  -- The window is fixed once the campaign has started; pausing never extends it.
  IF OLD."status" <> 'PENDING_PAYMENT' AND (NEW."starts_at" IS DISTINCT FROM OLD."starts_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at") THEN
    RAISE EXCEPTION 'listing_promotions window is immutable after activation' USING ERRCODE = '23514';
  END IF;
  -- Terminal campaigns never come back; a new purchase is a new campaign. Releasing an
  -- unused budget is the only change a terminal campaign accepts.
  IF OLD."status" IN ('EXPIRED', 'CANCELLED', 'PAYMENT_FAILED', 'BUDGET_EXHAUSTED') AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."spent_minor" <> OLD."spent_minor") THEN
    RAISE EXCEPTION 'listing_promotions terminal status is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- The commercial ledger is append-only: corrections are new REVERSAL/ADJUSTMENT entries.
CREATE OR REPLACE FUNCTION commercial_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commercial_ledger is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER commercial_ledger_append_only_trigger BEFORE UPDATE OR DELETE ON "commercial_ledger" FOR EACH ROW EXECUTE FUNCTION commercial_ledger_append_only();--> statement-breakpoint
-- Bundle units: terms are snapshotted at purchase and used units never decrease.
CREATE OR REPLACE FUNCTION commercial_entitlements_integrity() RETURNS trigger AS $$
BEGIN
  IF NEW."units_total" IS DISTINCT FROM OLD."units_total"
    OR NEW."product_type" IS DISTINCT FROM OLD."product_type"
    OR NEW."unit_duration_days" IS DISTINCT FROM OLD."unit_duration_days"
    OR NEW."unit_priority_weight" IS DISTINCT FROM OLD."unit_priority_weight"
    OR NEW."pricing_version" IS DISTINCT FROM OLD."pricing_version"
    OR NEW."refund_policy" IS DISTINCT FROM OLD."refund_policy"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
    OR NEW."units_used" < OLD."units_used"
  THEN
    RAISE EXCEPTION 'commercial_entitlements terms are immutable and units only get used' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER commercial_entitlements_integrity_trigger BEFORE UPDATE ON "commercial_entitlements" FOR EACH ROW EXECUTE FUNCTION commercial_entitlements_integrity();--> statement-breakpoint
-- Subscriptions keep the plan economics accepted at purchase.
CREATE OR REPLACE FUNCTION business_subscriptions_integrity() RETURNS trigger AS $$
BEGIN
  IF NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
    OR NEW."price_minor_snapshot" IS DISTINCT FROM OLD."price_minor_snapshot"
    OR NEW."currency_code_snapshot" IS DISTINCT FROM OLD."currency_code_snapshot"
    OR NEW."period_days_snapshot" IS DISTINCT FROM OLD."period_days_snapshot"
    OR NEW."pricing_version_snapshot" IS DISTINCT FROM OLD."pricing_version_snapshot"
    OR NEW."entitlements_snapshot" IS DISTINCT FROM OLD."entitlements_snapshot"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."market_id" IS DISTINCT FROM OLD."market_id"
  THEN
    RAISE EXCEPTION 'business_subscriptions economics are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'EXPIRED', 'PAYMENT_FAILED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'business_subscriptions terminal status is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER business_subscriptions_integrity_trigger BEFORE UPDATE ON "business_subscriptions" FOR EACH ROW EXECUTE FUNCTION business_subscriptions_integrity();
