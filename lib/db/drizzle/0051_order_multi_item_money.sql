-- One order per seller may carry several offers at different unit prices (data.items and
-- order_items keep each line). The order row stores the first line's unit price, the summed
-- quantity and the summed subtotal, so subtotal = quantity * unit_price only holds for a
-- single-line order and every multi-item cart was refused by the database. Each line keeps its
-- own order_item_money_valid invariant; the order row keeps money sanity and the payable split.
ALTER TABLE "orders" DROP CONSTRAINT "order_money_valid";
ALTER TABLE "orders" ADD CONSTRAINT "order_money_valid" CHECK (quantity > 0 AND unit_price_minor > 0 AND subtotal_minor > 0 AND platform_fee_minor >= 0 AND seller_amount_minor = subtotal_minor - platform_fee_minor);
