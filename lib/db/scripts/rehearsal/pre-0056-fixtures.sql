-- Synthetic rows for a database at migration 0055. Keep every market's existing
-- active/legal state unchanged; the rows are historical records, not publication approval.
BEGIN;

INSERT INTO market_price_versions (id, market_id, currency_code, unit_price_minor, minor_unit_scale, effective_from)
SELECT 'g32-price-v1', id, currency_code, 1000, minor_unit_scale, now() - interval '30 days'
FROM markets WHERE country_code = 'JO';

INSERT INTO users (id, display_name, phone_country_code, phone_number, normalized_phone, account_country, active_market_id, password_hash)
SELECT v.id, v.display_name, '+962', v.phone, '+962' || v.phone, 'JO', m.id, 'synthetic-historical-not-a-hash'
FROM markets m
CROSS JOIN (VALUES
  ('g32-user-seller', 'بائع تاريخي', '790000001'),
  ('g32-user-buyer', 'مشتري تاريخي', '790000002'),
  ('g32-user-reviewer', 'مراجع تاريخي', '790000003')
) AS v(id, display_name, phone)
WHERE m.country_code = 'JO';

INSERT INTO business_profiles (id, owner_user_id, market_id, display_name, normalized_name, category_key, description, idempotency_key)
SELECT 'g32-business', 'g32-user-seller', id, 'منشأة تاريخية', 'g32-business-normalized', 'HOME_GOODS', 'Synthetic pre-upgrade business record', 'g32-business-create'
FROM markets WHERE country_code = 'JO';

INSERT INTO business_memberships (id, business_id, user_id, role, status)
VALUES ('g32-business-membership', 'g32-business', 'g32-user-seller', 'APPLICANT', 'ACTIVE');

INSERT INTO offers (id, seller_id, market_id, status, inventory_mode, available_quantity, data, unit_price_minor, pricing_mode)
SELECT 'g32-offer', 'g32-user-seller', id, 'PUBLISHED', 'LIMITED', 3,
       '{"title":"Historical chair","category":"home"}'::jsonb, 20000, 'FIXED'
FROM markets WHERE country_code = 'JO';

INSERT INTO orders (id, buyer_id, seller_id, market_id, currency_code, minor_unit_scale, unit_price_minor, quantity, subtotal_minor, platform_fee_minor, seller_amount_minor, status, data, country_code, price_version_id)
SELECT 'g32-order', 'g32-user-buyer', 'g32-user-seller', m.id, m.currency_code, m.minor_unit_scale,
       20000, 2, 40000, 4000, 36000, 'DISPUTED',
       '{"paymentMode":"TEST_NO_TRANSFER"}'::jsonb, 'JO', 'g32-price-v1'
FROM markets m WHERE m.country_code = 'JO';

INSERT INTO order_items (id, order_id, offer_id, quantity, unit_price_minor, subtotal_minor, data)
VALUES ('g32-order-item', 'g32-order', 'g32-offer', 2, 20000, 40000, '{"title":"Historical chair"}'::jsonb);

INSERT INTO seller_dues (id, order_id, seller_id, amount_minor, currency_code)
SELECT 'g32-seller-due', 'g32-order', 'g32-user-seller', 4000, currency_code
FROM markets WHERE country_code = 'JO';

INSERT INTO payment_intents (id, order_id, buyer_id, provider_key, provider_intent_id, idempotency_key, amount_minor, captured_amount_minor, refunded_amount_minor, currency_code, status, mode)
SELECT 'g32-payment', 'g32-order', 'g32-user-buyer', 'SIMULATION', 'g32-provider-intent', 'g32-payment-create',
       40000, 40000, 0, currency_code, 'SIMULATION_CAPTURED', 'SIMULATION_ONLY'
FROM markets WHERE country_code = 'JO';

INSERT INTO payment_events (id, payment_intent_id, provider_key, provider_event_id, event_type, amount_minor, currency_code, payload_sha256, mode)
SELECT 'g32-payment-event', 'g32-payment', 'SIMULATION', 'g32-provider-event', 'CAPTURE_SUCCEEDED',
       40000, currency_code, repeat('0', 64), 'SIMULATION_ONLY'
FROM markets WHERE country_code = 'JO';

INSERT INTO disputes (id, order_id, opened_by, reason, status, evidence)
VALUES ('g32-dispute', 'g32-order', 'g32-user-buyer', 'Synthetic historical delivery dispute', 'OPEN', '["synthetic evidence"]'::jsonb);

INSERT INTO order_financial_events (id, order_id, event_type, account_obligation, business_ref, actor_type, actor_id, currency_code, amount_minor, idempotency_key, data)
SELECT 'g32-ledger-order', 'g32-order', 'ORDER_CREATED', 'BUYER_RECEIVABLE', 'g32-order',
       'BUYER', 'g32-user-buyer', currency_code, 40000, 'g32-ledger-order-created', '{"legacy":true}'::jsonb
FROM markets WHERE country_code = 'JO';

INSERT INTO order_financial_events (id, order_id, event_type, account_obligation, business_ref, actor_type, actor_id, currency_code, amount_minor, idempotency_key, data)
SELECT 'g32-ledger-capture', 'g32-order', 'PAYMENT_CAPTURED', 'BUYER_PAYMENT', 'g32-order',
       'PROVIDER', NULL, currency_code, 40000, 'g32-ledger-payment-captured', '{"legacy":true}'::jsonb
FROM markets WHERE country_code = 'JO';

INSERT INTO market_audit (id, market_id, actor_id, action, data)
SELECT 'g32-market-audit', id, 'g32-user-reviewer', 'HISTORICAL_REVIEW', '{"synthetic":true}'::jsonb
FROM markets WHERE country_code = 'JO';

COMMIT;
