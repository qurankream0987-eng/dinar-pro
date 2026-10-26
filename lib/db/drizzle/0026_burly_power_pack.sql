CREATE TABLE "courier_commission_receivables" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"order_id" text NOT NULL,
	"courier_id" text NOT NULL,
	"market_id" text NOT NULL,
	"fare_minor" integer NOT NULL,
	"commission_rate_bps" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"minor_unit_scale" integer NOT NULL,
	"status" text DEFAULT 'OUTSTANDING' NOT NULL,
	"settlement_id" text,
	"accrued_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_commission_receivables_fare_positive" CHECK ("courier_commission_receivables"."fare_minor" > 0),
	CONSTRAINT "courier_commission_receivables_rate_fixed" CHECK ("courier_commission_receivables"."commission_rate_bps" = 1000),
	CONSTRAINT "courier_commission_receivables_amount_nonnegative" CHECK ("courier_commission_receivables"."amount_minor" >= 0),
	CONSTRAINT "courier_commission_receivables_currency_valid" CHECK ("courier_commission_receivables"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "courier_commission_receivables_scale_valid" CHECK ("courier_commission_receivables"."minor_unit_scale" BETWEEN 0 AND 3),
	CONSTRAINT "courier_commission_receivables_status_valid" CHECK ("courier_commission_receivables"."status" IN ('OUTSTANDING', 'SIMULATION_CLEARED')),
	CONSTRAINT "courier_commission_receivables_settlement_consistent" CHECK (("courier_commission_receivables"."status" = 'SIMULATION_CLEARED') = ("courier_commission_receivables"."settlement_id" IS NOT NULL AND "courier_commission_receivables"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "courier_commission_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"courier_id" text NOT NULL,
	"market_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"minor_unit_scale" integer NOT NULL,
	"receivable_count" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"mode" text DEFAULT 'SIMULATION_ONLY' NOT NULL,
	"simulated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_commission_settlements_mode_simulation_only" CHECK ("courier_commission_settlements"."mode" = 'SIMULATION_ONLY'),
	CONSTRAINT "courier_commission_settlements_amount_positive" CHECK ("courier_commission_settlements"."amount_minor" > 0),
	CONSTRAINT "courier_commission_settlements_count_positive" CHECK ("courier_commission_settlements"."receivable_count" > 0),
	CONSTRAINT "courier_commission_settlements_currency_valid" CHECK ("courier_commission_settlements"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "courier_commission_settlements_scale_valid" CHECK ("courier_commission_settlements"."minor_unit_scale" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "courier_fare_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"order_id" text NOT NULL,
	"market_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"courier_id" text NOT NULL,
	"fare_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"minor_unit_scale" integer NOT NULL,
	"commission_rate_bps" integer DEFAULT 1000 NOT NULL,
	"commission_estimate_minor" integer NOT NULL,
	"agreed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_fare_agreements_fare_positive" CHECK ("courier_fare_agreements"."fare_minor" > 0),
	CONSTRAINT "courier_fare_agreements_currency_valid" CHECK ("courier_fare_agreements"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "courier_fare_agreements_scale_valid" CHECK ("courier_fare_agreements"."minor_unit_scale" BETWEEN 0 AND 3),
	CONSTRAINT "courier_fare_agreements_rate_fixed" CHECK ("courier_fare_agreements"."commission_rate_bps" = 1000),
	CONSTRAINT "courier_fare_agreements_commission_nonnegative" CHECK ("courier_fare_agreements"."commission_estimate_minor" >= 0),
	CONSTRAINT "courier_fare_agreements_parties_distinct" CHECK ("courier_fare_agreements"."buyer_id" <> "courier_fare_agreements"."courier_id")
);
--> statement-breakpoint
CREATE TABLE "courier_fare_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"market_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"courier_id" text NOT NULL,
	"proposed_by_user_id" text NOT NULL,
	"fare_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"minor_unit_scale" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"buyer_confirmed_at" timestamp with time zone,
	"courier_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_fare_proposals_status_valid" CHECK ("courier_fare_proposals"."status" IN ('PENDING', 'SUPERSEDED', 'AGREED', 'CANCELLED')),
	CONSTRAINT "courier_fare_proposals_fare_positive" CHECK ("courier_fare_proposals"."fare_minor" > 0),
	CONSTRAINT "courier_fare_proposals_currency_valid" CHECK ("courier_fare_proposals"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "courier_fare_proposals_scale_valid" CHECK ("courier_fare_proposals"."minor_unit_scale" BETWEEN 0 AND 3),
	CONSTRAINT "courier_fare_proposals_parties_distinct" CHECK ("courier_fare_proposals"."buyer_id" <> "courier_fare_proposals"."courier_id"),
	CONSTRAINT "courier_fare_proposals_confirmation_consistent" CHECK (("courier_fare_proposals"."status" = 'AGREED') = ("courier_fare_proposals"."buyer_confirmed_at" IS NOT NULL AND "courier_fare_proposals"."courier_confirmed_at" IS NOT NULL)),
	CONSTRAINT "courier_fare_proposals_confirmed_actor_valid" CHECK ("courier_fare_proposals"."proposed_by_user_id" IN ("courier_fare_proposals"."buyer_id", "courier_fare_proposals"."courier_id"))
);
--> statement-breakpoint
ALTER TABLE "courier_commission_receivables" ADD CONSTRAINT "courier_commission_receivables_agreement_id_courier_fare_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."courier_fare_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_receivables" ADD CONSTRAINT "courier_commission_receivables_assignment_id_delivery_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."delivery_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_receivables" ADD CONSTRAINT "courier_commission_receivables_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_receivables" ADD CONSTRAINT "courier_commission_receivables_courier_id_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_receivables" ADD CONSTRAINT "courier_commission_receivables_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_receivables" ADD CONSTRAINT "courier_commission_receivables_settlement_id_courier_commission_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."courier_commission_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_settlements" ADD CONSTRAINT "courier_commission_settlements_courier_id_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_commission_settlements" ADD CONSTRAINT "courier_commission_settlements_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_proposal_id_courier_fare_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."courier_fare_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_assignment_id_delivery_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."delivery_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_agreements" ADD CONSTRAINT "courier_fare_agreements_courier_id_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_proposals" ADD CONSTRAINT "courier_fare_proposals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_proposals" ADD CONSTRAINT "courier_fare_proposals_assignment_id_delivery_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."delivery_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_proposals" ADD CONSTRAINT "courier_fare_proposals_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_proposals" ADD CONSTRAINT "courier_fare_proposals_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_proposals" ADD CONSTRAINT "courier_fare_proposals_courier_id_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_fare_proposals" ADD CONSTRAINT "courier_fare_proposals_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_commission_receivables_agreement_unique" ON "courier_commission_receivables" USING btree ("agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_commission_receivables_assignment_unique" ON "courier_commission_receivables" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_commission_receivables_order_unique" ON "courier_commission_receivables" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "courier_commission_receivables_driver_status_idx" ON "courier_commission_receivables" USING btree ("courier_id","status");--> statement-breakpoint
CREATE INDEX "courier_commission_receivables_driver_market_status_idx" ON "courier_commission_receivables" USING btree ("courier_id","market_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_commission_settlements_idempotency_unique" ON "courier_commission_settlements" USING btree ("courier_id","market_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "courier_commission_settlements_driver_market_idx" ON "courier_commission_settlements" USING btree ("courier_id","market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_fare_agreements_proposal_unique" ON "courier_fare_agreements" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_fare_agreements_assignment_unique" ON "courier_fare_agreements" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_fare_agreements_order_unique" ON "courier_fare_agreements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "courier_fare_agreements_driver_market_idx" ON "courier_fare_agreements" USING btree ("courier_id","market_id");--> statement-breakpoint
CREATE INDEX "courier_fare_proposals_assignment_status_idx" ON "courier_fare_proposals" USING btree ("assignment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_fare_proposals_pending_assignment_unique" ON "courier_fare_proposals" USING btree ("assignment_id") WHERE "courier_fare_proposals"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "courier_fare_proposals_actor_idempotency_unique" ON "courier_fare_proposals" USING btree ("proposed_by_user_id","idempotency_key");