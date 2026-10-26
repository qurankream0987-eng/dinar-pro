ALTER TABLE markets ADD CONSTRAINT markets_price_valid CHECK (unit_price_minor > 0 AND minor_unit_scale BETWEEN 0 AND 3);
ALTER TABLE offers ADD CONSTRAINT offers_inventory_valid CHECK (reserved_quantity >= 0 AND ((inventory_mode = 'LIMITED' AND available_quantity >= reserved_quantity) OR (inventory_mode = 'UNLIMITED' AND available_quantity IS NULL)));
ALTER TABLE cart_items ADD CONSTRAINT cart_quantity_valid CHECK (quantity BETWEEN 1 AND 1000000);
ALTER TABLE order_items ADD CONSTRAINT order_item_money_valid CHECK (quantity > 0 AND unit_price_minor > 0 AND subtotal_minor = quantity::bigint * unit_price_minor);
ALTER TABLE orders ADD CONSTRAINT order_money_valid CHECK (quantity > 0 AND unit_price_minor > 0 AND subtotal_minor = quantity::bigint * unit_price_minor AND platform_fee_minor >= 0 AND seller_amount_minor = subtotal_minor - platform_fee_minor);
ALTER TABLE seller_dues ADD CONSTRAINT dues_amount_valid CHECK (amount_minor >= 0);
--> statement-breakpoint
CREATE FUNCTION bdinar_offer_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.market_id IS DISTINCT FROM OLD.market_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id THEN RAISE EXCEPTION 'Offer market and seller are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offer_identity_immutable BEFORE UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION bdinar_offer_identity_immutable();
--> statement-breakpoint
CREATE FUNCTION bdinar_order_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.market_id, NEW.buyer_id, NEW.seller_id, NEW.currency_code, NEW.minor_unit_scale, NEW.unit_price_minor, NEW.quantity, NEW.subtotal_minor, NEW.platform_fee_minor, NEW.seller_amount_minor)
 IS DISTINCT FROM (OLD.market_id, OLD.buyer_id, OLD.seller_id, OLD.currency_code, OLD.minor_unit_scale, OLD.unit_price_minor, OLD.quantity, OLD.subtotal_minor, OLD.platform_fee_minor, OLD.seller_amount_minor)
 THEN RAISE EXCEPTION 'Order price and identity snapshot is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_snapshot_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION bdinar_order_snapshot_immutable();
--> statement-breakpoint
CREATE FUNCTION bdinar_cart_market_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT market_id FROM carts WHERE id=NEW.cart_id) IS DISTINCT FROM (SELECT market_id FROM offers WHERE id=NEW.offer_id) THEN RAISE EXCEPTION 'Cross-market cart item'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cart_market_valid BEFORE INSERT OR UPDATE ON cart_items FOR EACH ROW EXECUTE FUNCTION bdinar_cart_market_valid();
