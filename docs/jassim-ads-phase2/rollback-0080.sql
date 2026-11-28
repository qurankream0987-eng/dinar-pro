-- Rollback of migration 0080_promotion_whop_direct (NOT a migration; run manually, only with the
-- owner's approval, in ONE transaction, after a fresh verified backup).
-- Refuses if any real-payment (PROVIDER_LIVE / PROVIDER_DIRECT / PROVIDER_*) promotion row exists: those rows
-- record real money and cannot exist under the old rules. Keep 0080 in that case (it is additive).
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM listing_promotions WHERE payment_mode = 'PROVIDER_LIVE' OR payment_source = 'PROVIDER_DIRECT' OR payment_status LIKE 'PROVIDER_%') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: real-payment promotion rows exist; keep migration 0080';
  END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = 1795820000000) <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: 0080 is not the recorded ledger entry';
  END IF;
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1795820000000) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a later migration is applied';
  END IF;
END $$;
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_provider_mode_consistent";
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_simulation_only_check";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_simulation_only_check" CHECK ("listing_promotions"."payment_mode" = 'DEVELOPMENT_SIMULATED');
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_payment_status_valid";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_status_valid" CHECK ("listing_promotions"."payment_status" IN ('SIMULATION_PENDING', 'SIMULATION_CAPTURED', 'SIMULATION_FAILED', 'LEGACY_UNVERIFIED', 'BALANCE_CHARGED', 'ENTITLEMENT_CONSUMED'));
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_live_requires_payment";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_live_requires_payment" CHECK ("listing_promotions"."status" NOT IN ('ACTIVE', 'PAUSED') OR "listing_promotions"."payment_status" IN ('SIMULATION_CAPTURED', 'LEGACY_UNVERIFIED', 'BALANCE_CHARGED', 'ENTITLEMENT_CONSUMED'));
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_failed_consistent";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_failed_consistent" CHECK (("listing_promotions"."status" = 'PAYMENT_FAILED') = ("listing_promotions"."payment_status" = 'SIMULATION_FAILED'));
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_payment_source_valid";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_source_valid" CHECK ("listing_promotions"."payment_source" IN ('SIMULATED_PROVIDER', 'COMMERCIAL_BALANCE', 'BUNDLE_ENTITLEMENT'));
ALTER TABLE "listing_promotions" DROP CONSTRAINT "listing_promotions_payment_source_status";
ALTER TABLE "listing_promotions" ADD CONSTRAINT "listing_promotions_payment_source_status" CHECK (("listing_promotions"."payment_source" = 'SIMULATED_PROVIDER') OR ("listing_promotions"."payment_source" = 'COMMERCIAL_BALANCE' AND "listing_promotions"."payment_status" = 'BALANCE_CHARGED') OR ("listing_promotions"."payment_source" = 'BUNDLE_ENTITLEMENT' AND "listing_promotions"."payment_status" = 'ENTITLEMENT_CONSUMED' AND "listing_promotions"."entitlement_id" IS NOT NULL));
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795820000000;
COMMIT;
