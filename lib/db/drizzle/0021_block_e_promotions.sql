ALTER TABLE "listing_promotions" ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';--> statement-breakpoint
-- Pre-Block-E campaigns were activated without any payment authority: they are kept as
-- history but marked LEGACY_UNVERIFIED, which never serves. New rows default to pending.
ALTER TABLE "listing_promotions" ADD COLUMN "payment_status" text DEFAULT 'LEGACY_UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_promotions" ALTER COLUMN "payment_status" SET DEFAULT 'SIMULATION_PENDING';--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "payment_provider_key" text;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
-- Time-expired ACTIVE rows become EXPIRED so at most one live row per listing/placement remains.
UPDATE "listing_promotions" SET "status" = 'EXPIRED', "ended_at" = "expires_at", "updated_at" = now() WHERE "status" = 'ACTIVE' AND "expires_at" <= now();--> statement-breakpoint
UPDATE "listing_promotions" AS older SET "status" = 'CANCELLED', "ended_at" = now(), "updated_at" = now()
WHERE older."status" = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM "listing_promotions" AS newer
  WHERE newer."listing_id" = older."listing_id" AND newer."placement_snapshot" = older."placement_snapshot"
    AND newer."status" = 'ACTIVE' AND (newer."created_at", newer."id") > (older."created_at", older."id")
);--> statement-breakpoint
CREATE INDEX "listing_promotions_seller_created_idx" ON "listing_promotions" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_promotions_seller_idempotency_unique" ON "listing_promotions" USING btree ("seller_id","idempotency_key") WHERE "listing_promotions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_promotions_payment_reference_unique" ON "listing_promotions" USING btree ("payment_provider_key","payment_reference") WHERE "listing_promotions"."payment_reference" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_promotions_one_live_per_placement" ON "listing_promotions" USING btree ("listing_id","placement_snapshot") WHERE "listing_promotions"."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED');--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_status_valid" CHECK ("listing_promotions"."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_status_valid" CHECK ("listing_promotions"."payment_status" IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_FAILED', 'LEGACY_UNVERIFIED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_live_requires_payment" CHECK ("listing_promotions"."status" NOT IN ('ACTIVE', 'PAUSED') OR "listing_promotions"."payment_status" IN ('SIMULATION_CAPTURED', 'LEGACY_UNVERIFIED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_failed_consistent" CHECK (("listing_promotions"."status" = 'PAYMENT_FAILED') = ("listing_promotions"."payment_status" = 'SIMULATION_FAILED'));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_reference_consistent" CHECK (("listing_promotions"."payment_reference" IS NULL) = ("listing_promotions"."payment_provider_key" IS NULL));--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_window_valid" CHECK ("listing_promotions"."expires_at" > "listing_promotions"."starts_at");--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_currency_valid" CHECK ("listing_promotions"."currency_code_snapshot" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_placement_valid" CHECK ("listing_promotions"."placement_snapshot" IN ('SEARCH_AND_CHAT'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_placement_valid" CHECK ("promotion_products"."placement" IN ('SEARCH_AND_CHAT'));--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_currency_valid" CHECK ("promotion_products"."currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- A campaign belongs to the listing's own seller and market, and its accepted contract
-- (listing, seller, market, plan, price, currency, placement, duration, window) is immutable.
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
    OR (OLD."payment_reference" IS NOT NULL AND NEW."payment_reference" IS DISTINCT FROM OLD."payment_reference")
  THEN
    RAISE EXCEPTION 'listing_promotions contract snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  -- The window is fixed once the campaign has started; pausing never extends it.
  IF OLD."status" <> 'PENDING_PAYMENT' AND (NEW."starts_at" IS DISTINCT FROM OLD."starts_at" OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at") THEN
    RAISE EXCEPTION 'listing_promotions window is immutable after activation' USING ERRCODE = '23514';
  END IF;
  -- Terminal campaigns never come back; a new purchase is a new campaign.
  IF OLD."status" IN ('EXPIRED', 'CANCELLED', 'PAYMENT_FAILED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'listing_promotions terminal status is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER listing_promotions_integrity_trigger
BEFORE INSERT OR UPDATE ON "listing_promotions"
FOR EACH ROW EXECUTE FUNCTION listing_promotions_integrity();
