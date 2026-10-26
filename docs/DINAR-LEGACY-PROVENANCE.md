# DINAR legacy provenance classification

Read-only, repeatable-read inventory of the legacy development database. No records imported or modified. No personal payloads exported.

Classification is complete at the table level, not a certification of user-created provenance. UNKNOWN is deliberately retained where evidence is insufficient. No table is approved for migration. Financial/test history is excluded, not repaired by fabricated values. Dependencies reflect legacy foreign keys; canonical validation is additionally required before any future data-only import.

Category totals (tables): {"MIGRATE_DIRECT":0,"TRANSFORM_REQUIRED":0,"RESEED":4,"SKIP_TEST_STATE":13,"UNKNOWN":5}

| Table | Rows | Category | Reason | Dependencies | Required transformation | Safe to migrate |
|---|---:|---|---|---|---|---|
| ai_result_sets | 27 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | conversations, markets, messages | No import; recreate only with approved fixtures if needed. | NO |
| ai_ui_blocks | 237 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | conversations, messages | No import; recreate only with approved fixtures if needed. | NO |
| cart_items | 1 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | carts, offers | No import; recreate only with approved fixtures if needed. | NO |
| carts | 61 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | markets, users | No import; recreate only with approved fixtures if needed. | NO |
| checkout_requests | 199 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | users | No import; recreate only with approved fixtures if needed. | NO |
| conversations | 307 | UNKNOWN | Row-level ownership/provenance is not proven by counts or identifiers. | markets, orders, users | Review provenance and canonical field compatibility before any import. | NO |
| disputes | 57 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | orders, users | No import; recreate only with approved fixtures if needed. | NO |
| listing_promotions | 0 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | markets, offers, promotion_products, users | No import; recreate only with approved fixtures if needed. | NO |
| market_audit | 6 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | markets, users | No import; recreate only with approved fixtures if needed. | NO |
| market_price_versions | 3 | RESEED | Configuration must come from canonical migrations or separately approved development settings. | markets | Recreate approved configuration; do not copy historical pricing. | NO |
| marketplace_categories | 9 | RESEED | Configuration must come from canonical migrations or separately approved development settings. | — | Recreate approved configuration; do not copy historical pricing. | NO |
| marketplace_category_audit | 1 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | marketplace_categories, users | No import; recreate only with approved fixtures if needed. | NO |
| markets | 249 | RESEED | Configuration must come from canonical migrations or separately approved development settings. | — | Recreate approved configuration; do not copy historical pricing. | NO |
| messages | 1228 | UNKNOWN | Row-level ownership/provenance is not proven by counts or identifiers. | conversations, users | Review provenance and canonical field compatibility before any import. | NO |
| offers | 237 | UNKNOWN | Row-level ownership/provenance is not proven by counts or identifiers. | markets, users | Review provenance and canonical field compatibility before any import. | NO |
| order_items | 225 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | offers, orders | No import; recreate only with approved fixtures if needed. | NO |
| orders | 225 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | market_price_versions, markets, users | No import; recreate only with approved fixtures if needed. | NO |
| promotion_products | 0 | RESEED | Configuration must come from canonical migrations or separately approved development settings. | marketplace_categories, markets, users | Recreate approved configuration; do not copy historical pricing. | NO |
| seller_dues | 58 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | orders, users | No import; recreate only with approved fixtures if needed. | NO |
| seller_market_eligibility | 0 | UNKNOWN | Empty table; no legacy records to recover. | markets, users | Review provenance and canonical field compatibility before any import. | NO |
| sessions | 243 | SKIP_TEST_STATE | Ephemeral, historical transactional, financial, or derived development state; compatibility and provenance are not proven. | users | No import; recreate only with approved fixtures if needed. | NO |
| users | 258 | UNKNOWN | Row-level ownership/provenance is not proven by counts or identifiers. | markets | Review provenance and canonical field compatibility before any import. | NO |
