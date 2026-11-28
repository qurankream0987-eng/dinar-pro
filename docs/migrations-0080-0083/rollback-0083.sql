-- Rollback 0083_merchant_policies: drops only the three tables it created.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = 1795850000000) <> 1 THEN RAISE EXCEPTION 'migration not applied here'; END IF;
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1795850000000) THEN RAISE EXCEPTION 'roll back later migrations first'; END IF;
END $$;
DROP TABLE IF EXISTS "merchant_policy_events";
DROP TABLE IF EXISTS "merchant_policy_grants";
DROP TABLE IF EXISTS "merchant_policies";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795850000000;
COMMIT;
