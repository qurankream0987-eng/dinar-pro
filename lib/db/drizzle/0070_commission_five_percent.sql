-- Owner decision 2026-11-25: Jassim's commission is 5% of the sale value (gross item subtotal)
-- for every category, replacing the 10% baseline published by 0041.
-- commission_policies is append-only and allows one PUBLISHED global row, so the change is
-- published per market: a market-scoped policy always wins over the global one in
-- resolveCommissionPolicy. One row per existing market; versions continue after v1. Orders keep
-- their immutable snapshot; only orders placed from the effective date use 5%.
-- content_hash is computed exactly as commissionPolicyContentHash (sha256 of the same JSON).
INSERT INTO "commission_policies" ("id", "policy_key", "version", "rate_basis_points", "basis", "rounding_mode", "market_id", "status", "effective_from", "effective_to", "content_hash", "approved_by", "published_at", "created_by")
SELECT
  'cmp_platform_commission_5pct_' || lower(m."id"),
  'PLATFORM_COMMISSION',
  1 + ranked.n,
  500,
  'GROSS_ITEM_SUBTOTAL',
  'HALF_UP',
  m."id",
  'PUBLISHED',
  '2026-11-25T00:00:00.000Z',
  NULL,
  encode(sha256(convert_to(
    '{"policyKey":"PLATFORM_COMMISSION","version":' || (1 + ranked.n) ||
    ',"rateBasisPoints":500,"basis":"GROSS_ITEM_SUBTOTAL","roundingMode":"HALF_UP","marketId":"' || m."id" ||
    '","effectiveFrom":"2026-11-25T00:00:00.000Z"}', 'UTF8')), 'hex'),
  'owner-policy-2026-11-25',
  '2026-11-25T00:00:00.000Z',
  'system'
FROM "markets" m
JOIN (SELECT "id", row_number() OVER (ORDER BY "id") AS n FROM "markets") ranked ON ranked."id" = m."id"
WHERE NOT EXISTS (
  SELECT 1 FROM "commission_policies" p
  WHERE p."policy_key" = 'PLATFORM_COMMISSION' AND p."status" = 'PUBLISHED' AND p."market_id" = m."id"
);
