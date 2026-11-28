-- Rollback 0082_seller_classification: drops only the table it created.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = 1795840000000) <> 1 THEN RAISE EXCEPTION 'migration not applied here'; END IF;
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1795840000000) THEN RAISE EXCEPTION 'roll back later migrations first'; END IF;
END $$;
DROP TABLE IF EXISTS "seller_classifications";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795840000000;
COMMIT;
