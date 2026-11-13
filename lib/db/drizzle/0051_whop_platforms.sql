CREATE TABLE "whop_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_user_id" text NOT NULL,
	"whop_account_id" text NOT NULL,
	"contact_email" text NOT NULL,
	"country_code" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"identity_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"verification_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whop_accounts_status_valid" CHECK ("whop_accounts"."status" IN ('PENDING', 'ONBOARDING', 'VERIFIED', 'RESTRICTED')),
	CONSTRAINT "whop_accounts_country_valid" CHECK ("whop_accounts"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "whop_accounts_email_valid" CHECK ("whop_accounts"."contact_email" ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
--> statement-breakpoint
CREATE TABLE "whop_checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"seller_user_id" text NOT NULL,
	"whop_checkout_id" text NOT NULL,
	"whop_payment_id" text,
	"purchase_url" text NOT NULL,
	"redirect_url" text NOT NULL,
	"amount_usd_minor" integer NOT NULL,
	"fee_usd_minor" integer NOT NULL,
	"seller_usd_minor" integer NOT NULL,
	"fee_basis_points" integer NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"failure_code" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whop_checkouts_amount_positive" CHECK ("whop_checkouts"."amount_usd_minor" > 0),
	CONSTRAINT "whop_checkouts_fee_bounds" CHECK ("whop_checkouts"."fee_usd_minor" > 0 AND "whop_checkouts"."fee_usd_minor" < "whop_checkouts"."amount_usd_minor"),
	CONSTRAINT "whop_checkouts_split_valid" CHECK ("whop_checkouts"."fee_usd_minor" + "whop_checkouts"."seller_usd_minor" = "whop_checkouts"."amount_usd_minor"),
	CONSTRAINT "whop_checkouts_status_valid" CHECK ("whop_checkouts"."status" IN ('CREATED', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUND_DUE'))
);
--> statement-breakpoint
CREATE TABLE "whop_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"processing_status" text NOT NULL,
	"result" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whop_events_status_valid" CHECK ("whop_events"."processing_status" IN ('PROCESSED', 'IGNORED', 'FAILED')),
	CONSTRAINT "whop_events_payload_sha256_valid" CHECK ("whop_events"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "whop_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"whop_payment_id" text NOT NULL,
	"whop_refund_id" text,
	"idempotency_key" text NOT NULL,
	"amount_usd_minor" integer NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"requested_by" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whop_refunds_amount_positive" CHECK ("whop_refunds"."amount_usd_minor" > 0),
	CONSTRAINT "whop_refunds_status_valid" CHECK ("whop_refunds"."status" IN ('REFUND_DUE', 'REQUESTED', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "whop_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"whop_case_id" text NOT NULL,
	"whop_payment_id" text,
	"status" text NOT NULL,
	"amount_usd_minor" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whop_disputes_amount_valid" CHECK ("whop_disputes"."amount_usd_minor" IS NULL OR "whop_disputes"."amount_usd_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "whop_accounts" ADD CONSTRAINT "whop_accounts_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "whop_checkouts" ADD CONSTRAINT "whop_checkouts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "whop_checkouts" ADD CONSTRAINT "whop_checkouts_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "whop_refunds" ADD CONSTRAINT "whop_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "whop_refunds" ADD CONSTRAINT "whop_refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "whop_disputes" ADD CONSTRAINT "whop_disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_accounts_seller_unique" ON "whop_accounts" USING btree ("seller_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_accounts_provider_unique" ON "whop_accounts" USING btree ("whop_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_checkouts_provider_unique" ON "whop_checkouts" USING btree ("whop_checkout_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_checkouts_payment_unique" ON "whop_checkouts" USING btree ("whop_payment_id");
--> statement-breakpoint
CREATE INDEX "whop_checkouts_status_idx" ON "whop_checkouts" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_events_provider_unique" ON "whop_events" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "whop_events_type_idx" ON "whop_events" USING btree ("event_type","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_refunds_idempotency_unique" ON "whop_refunds" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_refunds_provider_unique" ON "whop_refunds" USING btree ("whop_refund_id");
--> statement-breakpoint
CREATE INDEX "whop_refunds_order_idx" ON "whop_refunds" USING btree ("order_id","created_at");
--> statement-breakpoint
CREATE INDEX "whop_refunds_payment_idx" ON "whop_refunds" USING btree ("whop_payment_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "whop_disputes_case_unique" ON "whop_disputes" USING btree ("whop_case_id");
--> statement-breakpoint
CREATE INDEX "whop_disputes_status_idx" ON "whop_disputes" USING btree ("status","created_at");
