CREATE TABLE "cash_payment_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"status" text DEFAULT 'CLAIMED' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_reason" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"mode" text DEFAULT 'CASH_DIRECT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_payment_claims_amount_positive" CHECK ("cash_payment_claims"."amount_minor" > 0),
	CONSTRAINT "cash_payment_claims_currency_valid" CHECK (char_length("cash_payment_claims"."currency_code") = 3),
	CONSTRAINT "cash_payment_claims_status_valid" CHECK ("cash_payment_claims"."status" IN ('CLAIMED', 'CONFIRMED', 'DENIED', 'DISPUTED')),
	CONSTRAINT "cash_payment_claims_mode_valid" CHECK ("cash_payment_claims"."mode" = 'CASH_DIRECT'),
	CONSTRAINT "cash_payment_claims_decision_valid" CHECK (("cash_payment_claims"."status" = 'CLAIMED' AND "cash_payment_claims"."decided_at" IS NULL AND "cash_payment_claims"."decided_by" IS NULL AND "cash_payment_claims"."decision_reason" IS NULL) OR ("cash_payment_claims"."status" IN ('CONFIRMED', 'DENIED', 'DISPUTED') AND "cash_payment_claims"."decided_at" IS NOT NULL AND "cash_payment_claims"."decided_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cash_refund_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"payment_claim_id" text NOT NULL,
	"opened_by" text NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"repayment_claimed_at" timestamp with time zone,
	"repayment_note" text,
	"repayment_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"buyer_confirmed_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"dispute_reason" text,
	"withdrawn_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"mode" text DEFAULT 'CASH_DIRECT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_refund_cases_amount_positive" CHECK ("cash_refund_cases"."amount_minor" > 0),
	CONSTRAINT "cash_refund_cases_currency_valid" CHECK (char_length("cash_refund_cases"."currency_code") = 3),
	CONSTRAINT "cash_refund_cases_status_valid" CHECK ("cash_refund_cases"."status" IN ('OPEN', 'REPAYMENT_CLAIMED', 'CONFIRMED', 'DISPUTED', 'WITHDRAWN')),
	CONSTRAINT "cash_refund_cases_mode_valid" CHECK ("cash_refund_cases"."mode" = 'CASH_DIRECT'),
	CONSTRAINT "cash_refund_cases_evidence_valid" CHECK (("cash_refund_cases"."status" <> 'REPAYMENT_CLAIMED' OR "cash_refund_cases"."repayment_claimed_at" IS NOT NULL) AND ("cash_refund_cases"."status" <> 'CONFIRMED' OR "cash_refund_cases"."buyer_confirmed_at" IS NOT NULL) AND ("cash_refund_cases"."status" <> 'DISPUTED' OR ("cash_refund_cases"."disputed_at" IS NOT NULL AND "cash_refund_cases"."dispute_reason" IS NOT NULL)) AND ("cash_refund_cases"."status" <> 'WITHDRAWN' OR "cash_refund_cases"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "cash_payment_claims" ADD CONSTRAINT "cash_payment_claims_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_payment_claims" ADD CONSTRAINT "cash_payment_claims_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_payment_claims" ADD CONSTRAINT "cash_payment_claims_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_payment_claims" ADD CONSTRAINT "cash_payment_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_refund_cases" ADD CONSTRAINT "cash_refund_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_refund_cases" ADD CONSTRAINT "cash_refund_cases_payment_claim_id_cash_payment_claims_id_fk" FOREIGN KEY ("payment_claim_id") REFERENCES "public"."cash_payment_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_refund_cases" ADD CONSTRAINT "cash_refund_cases_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_refund_cases" ADD CONSTRAINT "cash_refund_cases_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_refund_cases" ADD CONSTRAINT "cash_refund_cases_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_payment_claims_order_unique" ON "cash_payment_claims" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_payment_claims_buyer_key_unique" ON "cash_payment_claims" USING btree ("buyer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "cash_payment_claims_status_idx" ON "cash_payment_claims" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_refund_cases_opener_key_unique" ON "cash_refund_cases" USING btree ("opened_by","idempotency_key");--> statement-breakpoint
CREATE INDEX "cash_refund_cases_order_idx" ON "cash_refund_cases" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_refund_cases_status_idx" ON "cash_refund_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION cash_payment_claims_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'cash_payment_claims cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = NEW.order_id
        AND o.buyer_id = NEW.buyer_id
        AND o.seller_id = NEW.seller_id
        AND o.currency_code = NEW.currency_code
        AND NEW.amount_minor = o.subtotal_minor
    ) THEN
      RAISE EXCEPTION 'a cash claim must match its order parties, currency and subtotal' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'CLAIMED' THEN
      RAISE EXCEPTION 'a cash claim starts as CLAIMED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cash claim facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'CLAIMED' AND NEW.status IN ('CONFIRMED', 'DENIED', 'DISPUTED'))
    OR (OLD.status = 'DENIED' AND NEW.status IN ('CONFIRMED', 'DISPUTED'))
  ) THEN
    RAISE EXCEPTION 'invalid cash claim transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('CONFIRMED', 'DENIED') AND NEW.decided_by IS DISTINCT FROM NEW.seller_id THEN
    RAISE EXCEPTION 'only the seller decides a cash payment claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'DISPUTED' AND NEW.decided_by IS DISTINCT FROM NEW.buyer_id THEN
    RAISE EXCEPTION 'only the buyer disputes a cash payment claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('DENIED', 'DISPUTED') AND (NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = '') THEN
    RAISE EXCEPTION 'a denial or dispute needs a reason' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cash_payment_claims_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "cash_payment_claims"
FOR EACH ROW EXECUTE FUNCTION cash_payment_claims_guard();
--> statement-breakpoint
CREATE TRIGGER cash_payment_claims_guard_truncate
BEFORE TRUNCATE ON "cash_payment_claims"
FOR EACH STATEMENT EXECUTE FUNCTION cash_payment_claims_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cash_refund_cases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'cash_refund_cases cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'a cash refund case starts as OPEN' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM cash_payment_claims c
      WHERE c.id = NEW.payment_claim_id
        AND c.order_id = NEW.order_id
        AND c.buyer_id = NEW.buyer_id
        AND c.seller_id = NEW.seller_id
        AND c.currency_code = NEW.currency_code
        AND c.status = 'CONFIRMED'
        AND NEW.amount_minor <= c.amount_minor
    ) THEN
      RAISE EXCEPTION 'a cash refund needs a confirmed cash payment for the same order' USING ERRCODE = '23514';
    END IF;
    IF NEW.amount_minor + COALESCE((
      SELECT sum(r.amount_minor) FROM cash_refund_cases r
      WHERE r.order_id = NEW.order_id
        AND r.status IN ('OPEN', 'REPAYMENT_CLAIMED', 'CONFIRMED', 'DISPUTED')
    ), 0) > (
      SELECT c.amount_minor FROM cash_payment_claims c WHERE c.id = NEW.payment_claim_id
    ) THEN
      RAISE EXCEPTION 'cash refunds cannot exceed the confirmed cash payment' USING ERRCODE = '23514';
    END IF;
    IF NEW.opened_by IS DISTINCT FROM NEW.buyer_id AND NEW.opened_by IS DISTINCT FROM NEW.seller_id THEN
      RAISE EXCEPTION 'only an order party can open a cash refund' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.payment_claim_id IS DISTINCT FROM OLD.payment_claim_id
    OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
    OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cash refund facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status IN ('REPAYMENT_CLAIMED', 'WITHDRAWN'))
    OR (OLD.status = 'REPAYMENT_CLAIMED' AND NEW.status IN ('CONFIRMED', 'DISPUTED'))
  ) THEN
    RAISE EXCEPTION 'invalid cash refund transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'REPAYMENT_CLAIMED' AND NEW.repayment_claimed_at IS NULL THEN
    RAISE EXCEPTION 'a repayment claim needs its time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CONFIRMED' AND NEW.buyer_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'a confirmed repayment needs the buyer confirmation time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'DISPUTED' AND (NEW.disputed_at IS NULL OR NEW.dispute_reason IS NULL OR btrim(NEW.dispute_reason) = '') THEN
    RAISE EXCEPTION 'a disputed repayment needs a time and reason' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'WITHDRAWN' AND NEW.withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'a withdrawn refund case needs its time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'REPAYMENT_CLAIMED' AND NEW.repayment_claimed_at IS DISTINCT FROM OLD.repayment_claimed_at THEN
    RAISE EXCEPTION 'a repayment claim time is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'CONFIRMED' AND NEW.buyer_confirmed_at IS DISTINCT FROM OLD.buyer_confirmed_at THEN
    RAISE EXCEPTION 'a buyer confirmation time is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'DISPUTED' AND NEW.disputed_at IS DISTINCT FROM OLD.disputed_at THEN
    RAISE EXCEPTION 'a dispute time is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'WITHDRAWN' AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'a withdrawal time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'OPEN' AND (NEW.repayment_note IS DISTINCT FROM OLD.repayment_note OR NEW.repayment_evidence IS DISTINCT FROM OLD.repayment_evidence) THEN
    RAISE EXCEPTION 'a repayment claim cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cash_refund_cases_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "cash_refund_cases"
FOR EACH ROW EXECUTE FUNCTION cash_refund_cases_guard();
--> statement-breakpoint
CREATE TRIGGER cash_refund_cases_guard_truncate
BEFORE TRUNCATE ON "cash_refund_cases"
FOR EACH STATEMENT EXECUTE FUNCTION cash_refund_cases_guard();
