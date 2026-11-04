-- Preserve legacy order headers while making every new checkout prove its line-item snapshot.
ALTER TABLE orders
  ADD COLUMN order_line_integrity_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE orders
  ALTER COLUMN order_line_integrity_version SET DEFAULT 1;
--> statement-breakpoint
COMMENT ON COLUMN orders.order_line_integrity_version IS
  'Version 0 is reserved for rows present before migration 0056; all new inserts require version 1.';
--> statement-breakpoint
ALTER TABLE orders
  ADD CONSTRAINT orders_line_integrity_version_valid
  CHECK (order_line_integrity_version IN (0, 1));
--> statement-breakpoint
CREATE FUNCTION dinar_require_line_integrity_for_new_order() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_line_integrity_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'New orders require line integrity version 1'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_require_line_integrity_version_on_insert
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION dinar_require_line_integrity_for_new_order();
--> statement-breakpoint
CREATE FUNCTION dinar_validate_order_line_integrity(target_order_id text) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  order_row orders%ROWTYPE;
  line_count bigint;
  line_quantity bigint;
  line_subtotal bigint;
  invalid_price_count bigint;
BEGIN
  SELECT * INTO order_row
  FROM orders
  WHERE id = target_order_id;

  IF NOT FOUND OR order_row.order_line_integrity_version = 0 THEN
    RETURN;
  END IF;

  SELECT
    count(*),
    coalesce(sum(quantity), 0),
    coalesce(sum(subtotal_minor), 0),
    count(*) FILTER (WHERE unit_price_minor <> order_row.unit_price_minor)
  INTO line_count, line_quantity, line_subtotal, invalid_price_count
  FROM order_items
  WHERE order_id = target_order_id;

  IF line_count = 0
     OR line_quantity <> order_row.quantity
     OR line_subtotal <> order_row.subtotal_minor
     OR invalid_price_count <> 0 THEN
    RAISE EXCEPTION 'Order header does not reconcile with its immutable items'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM order_items AS item
    JOIN offers AS offer ON offer.id = item.offer_id
    WHERE item.order_id = target_order_id
      AND (
        offer.seller_id <> order_row.seller_id
        OR offer.market_id <> order_row.market_id
      )
  ) THEN
    RAISE EXCEPTION 'Order item seller or market does not match its order'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM markets AS market
    WHERE market.id = order_row.market_id
      AND (
        market.country_code <> order_row.country_code
        OR market.currency_code <> order_row.currency_code
        OR market.minor_unit_scale <> order_row.minor_unit_scale
      )
  ) THEN
    RAISE EXCEPTION 'Order country or currency does not match its market'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION dinar_order_line_integrity_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    PERFORM dinar_validate_order_line_integrity(NEW.id);
  ELSE
    PERFORM dinar_validate_order_line_integrity(NEW.order_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_line_integrity_check
AFTER INSERT ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dinar_order_line_integrity_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_items_line_integrity_check
AFTER INSERT ON order_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dinar_order_line_integrity_check();
--> statement-breakpoint
CREATE FUNCTION dinar_reject_order_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_line_integrity_version IS DISTINCT FROM OLD.order_line_integrity_version THEN
    RAISE EXCEPTION 'Order line integrity version is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.order_line_integrity_version = 1 AND (
    NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.market_id IS DISTINCT FROM OLD.market_id
    OR NEW.country_code IS DISTINCT FROM OLD.country_code
    OR NEW.price_version_id IS DISTINCT FROM OLD.price_version_id
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.minor_unit_scale IS DISTINCT FROM OLD.minor_unit_scale
    OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.platform_fee_minor IS DISTINCT FROM OLD.platform_fee_minor
    OR NEW.seller_amount_minor IS DISTINCT FROM OLD.seller_amount_minor
    OR NEW.data -> 'items' IS DISTINCT FROM OLD.data -> 'items'
  ) THEN
    RAISE EXCEPTION 'Order financial snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_snapshot_immutable
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION dinar_reject_order_snapshot_mutation();
--> statement-breakpoint
CREATE FUNCTION dinar_reject_order_item_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  protected_order boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM orders
      WHERE id IN (OLD.order_id, NEW.order_id)
        AND order_line_integrity_version = 1
    ) INTO protected_order;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM orders
      WHERE id = OLD.order_id
        AND order_line_integrity_version = 1
    ) INTO protected_order;
  END IF;

  IF protected_order THEN
    RAISE EXCEPTION 'Order items are immutable after checkout'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_items_snapshot_immutable
BEFORE UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION dinar_reject_order_item_mutation();
