-- Rollback 0081_deal_payment_agreement: drops only the four tables it created (their triggers,
-- indexes and foreign keys go with them). No existing table or row is touched.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = 1795830000000) <> 1 THEN RAISE EXCEPTION 'migration not applied here'; END IF;
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1795830000000) THEN RAISE EXCEPTION 'roll back later migrations first'; END IF;
END $$;
DROP TABLE IF EXISTS "deal_payment_events";
DROP TABLE IF EXISTS "deal_payment_agreements";
DROP TABLE IF EXISTS "seller_payment_methods";
DROP TABLE IF EXISTS "deal_payment_catalog_changes";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795830000000;
COMMIT;
