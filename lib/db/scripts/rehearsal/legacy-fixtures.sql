-- Synthetic, representative legacy data for a database at migration 0027. No real records.
BEGIN;
UPDATE markets SET is_active = true, status = 'ACTIVE', unit_price_minor = 1000 WHERE country_code = 'JO';
INSERT INTO market_price_versions (id, market_id, currency_code, unit_price_minor, minor_unit_scale, effective_from)
SELECT 'rh-mpv-1', id, currency_code, 1000, minor_unit_scale, now() - interval '30 days' FROM markets WHERE country_code = 'JO';
INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash)
SELECT v.id, v.name, '+962', v.phone, '+962' || v.phone, 'JO', m.id, 'synthetic-not-a-hash'
FROM markets m, (VALUES ('rh-seller', 'بائع تجريبي', '790000001'), ('rh-buyer-1', 'مشتري ١', '790000002'), ('rh-buyer-2', 'مشتري ٢', '790000003')) v(id, name, phone)
WHERE m.country_code = 'JO';
-- Every legacy pricing shape the canonical modes must absorb.
INSERT INTO offers (id, seller_id, market_id, status, inventory_mode, available_quantity, data, unit_price_minor, pricing_mode)
SELECT v.id, 'rh-seller', m.id, v.status, v.inv, v.qty, v.data::jsonb, v.price, v.mode
FROM markets m, (VALUES
  ('rh-o-fixed',        'PUBLISHED', 'LIMITED',   5,    '{"title":"كرسي","category":"home","pricingMode":"FIXED"}',                         5000, 'FIXED'),
  ('rh-o-fixed-neg',    'PUBLISHED', 'LIMITED',   3,    '{"title":"هاتف","category":"electronics","negotiable":true}',                      7000, 'FIXED'),
  ('rh-o-fixed-negstr', 'PUBLISHED', 'LIMITED',   2,    '{"title":"مكتب","category":"home","negotiable":"true"}',                           6500, 'FIXED'),
  ('rh-o-start',        'PUBLISHED', 'UNLIMITED', NULL, '{"title":"تصميم شعار","category":"services","pricingMode":"STARTING_FROM"}',      3000, 'STARTING_FROM'),
  ('rh-o-start-neg',    'PUBLISHED', 'UNLIMITED', NULL, '{"title":"ترجمة","category":"services","negotiable":true}',                        3500, 'STARTING_FROM'),
  ('rh-o-quote',        'PUBLISHED', 'UNLIMITED', NULL, '{"title":"صيانة","category":"services","pricingMode":"QUOTE_REQUIRED"}',         NULL, 'QUOTE_REQUIRED'),
  ('rh-o-archived',     'ARCHIVED',  'LIMITED',   0,    '{"title":"معطف","category":"fashion"}',                                            9000, 'FIXED')
) v(id, status, inv, qty, data, price, mode)
WHERE m.country_code = 'JO';
-- Orders and money snapshots.
-- This synthetic legacy-row import is test-only and requires a disposable rehearsal database.
-- It models rows that predate migration 0056; ordinary application writers cannot use version 0.
ALTER TABLE orders DISABLE TRIGGER orders_require_line_integrity_version_on_insert;
INSERT INTO orders (id, buyer_id, seller_id, market_id, currency_code, minor_unit_scale, unit_price_minor, quantity, subtotal_minor, platform_fee_minor, seller_amount_minor, status, data, country_code, price_version_id, order_line_integrity_version)
SELECT v.id, v.buyer, 'rh-seller', m.id, m.currency_code, m.minor_unit_scale, v.price, v.qty, v.price * v.qty, v.fee, v.price * v.qty - v.fee, v.status, '{}'::jsonb, 'JO', 'rh-mpv-1', 0
FROM markets m, (VALUES
  ('rh-ord-1', 'rh-buyer-1', 5000, 2, 1000, 'COMPLETED'),
  ('rh-ord-2', 'rh-buyer-2', 6000, 1, 600,  'CREATED'),
  ('rh-ord-3', 'rh-buyer-1', 3000, 1, 300,  'CREATED')
) v(id, buyer, price, qty, fee, status) WHERE m.country_code = 'JO';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE orders ENABLE TRIGGER orders_require_line_integrity_version_on_insert;
INSERT INTO order_items (id, order_id, offer_id, quantity, unit_price_minor, subtotal_minor, data) VALUES
  ('rh-oi-1', 'rh-ord-1', 'rh-o-fixed', 2, 5000, 10000, '{}'),
  ('rh-oi-2', 'rh-ord-2', 'rh-o-fixed-neg', 1, 6000, 6000, '{}'),
  ('rh-oi-3', 'rh-ord-3', 'rh-o-start', 1, 3000, 3000, '{}');
INSERT INTO seller_dues (id, order_id, seller_id, amount_minor, currency_code)
SELECT 'rh-due-' || o.id, o.id, o.seller_id, o.platform_fee_minor, o.currency_code FROM orders o WHERE o.id LIKE 'rh-ord-%';
INSERT INTO payment_intents (id, order_id, buyer_id, provider_key, provider_intent_id, idempotency_key, amount_minor, captured_amount_minor, currency_code, status)
SELECT 'rh-pi-1', id, buyer_id, 'SIMULATION', 'sim-1', 'rh-idem-1', subtotal_minor, subtotal_minor, currency_code, 'SIMULATION_CAPTURED' FROM orders WHERE id = 'rh-ord-1';
INSERT INTO payment_events (id, payment_intent_id, provider_key, provider_event_id, event_type, amount_minor, currency_code, payload_sha256)
SELECT 'rh-pe-1', 'rh-pi-1', 'SIMULATION', 'sim-evt-1', 'CAPTURE_SUCCEEDED', amount_minor, currency_code, repeat('0', 64) FROM payment_intents WHERE id = 'rh-pi-1';
-- Legacy negotiations: open, countered and accepted-with-order.
INSERT INTO negotiations (id, listing_id, market_id, seller_id, buyer_id, status, currency_code, minor_unit_scale, listed_price_minor, offer_amount_minor, counter_amount_minor, agreed_amount_minor, last_actor, expires_at, order_id, quantity)
SELECT v.id, v.listing, m.id, 'rh-seller', v.buyer, v.status, m.currency_code, m.minor_unit_scale, v.listed, v.offer, v.counter, v.agreed, v.actor, now() + interval '2 days', v.ord, 1
FROM markets m, (VALUES
  ('rh-neg-open',     'rh-o-fixed-neg', 7000, 'rh-buyer-1', 'OPEN',      5500, NULL::int, NULL::int, 'BUYER',  NULL),
  ('rh-neg-counter',  'rh-o-fixed-negstr', 6500, 'rh-buyer-1', 'COUNTERED', 5000, 6500,      NULL,      'SELLER', NULL),
  ('rh-neg-accepted', 'rh-o-fixed-neg', 7000, 'rh-buyer-2', 'ACCEPTED',  6000, NULL,      6000,      'SELLER', 'rh-ord-2')
) v(id, listing, listed, buyer, status, offer, counter, agreed, actor, ord) WHERE m.country_code = 'JO';
-- Conversations of both legacy kinds.
INSERT INTO conversations (id, order_id, kind) VALUES ('rh-conv-order', 'rh-ord-1', 'ORDER');
INSERT INTO conversations (id, owner_user_id, market_id, kind, title)
SELECT 'rh-conv-ai', 'rh-buyer-1', id, 'AI', 'بحث' FROM markets WHERE country_code = 'JO';
INSERT INTO messages (id, conversation_id, sender_id, body) VALUES
  ('rh-msg-1', 'rh-conv-order', 'rh-buyer-1', 'متى التسليم؟'),
  ('rh-msg-2', 'rh-conv-ai', 'rh-buyer-1', 'أريد هاتفاً');
-- Category pricing defaults covering every mapping branch.
UPDATE marketplace_categories SET rules = jsonb_set(rules, '{pricing,defaultMode}', '"QUOTE_REQUIRED"') WHERE id = 'services';
UPDATE marketplace_categories SET rules = jsonb_set(rules, '{pricing,defaultMode}', '"STARTING_FROM"') WHERE id = 'digital-services';
UPDATE marketplace_categories SET rules = rules #- '{pricing,defaultMode}' WHERE id = 'other';
COMMIT;
