with mode(m) as (values ('DEVELOPMENT_SIMULATED'),('WHOP_LIVE'),('OTHER')),
st(s) as (values ('PENDING_PAYMENT'),('ACTIVE'),('PAUSED'),('EXPIRED'),('CANCELLED'),('PAYMENT_FAILED'),('BUDGET_EXHAUSTED')),
ps(p) as (values ('SIMULATION_PENDING'),('SIMULATION_CAPTURED'),('SIMULATION_FAILED'),('LEGACY_UNVERIFIED'),('BALANCE_CHARGED'),('ENTITLEMENT_CONSUMED'),('PROVIDER_PENDING'),('PROVIDER_PAID'),('PROVIDER_FAILED'),('PROVIDER_REFUNDED'),('PROVIDER_DISPUTED')),
src(c) as (values ('SIMULATED_PROVIDER'),('COMMERCIAL_BALANCE'),('BUNDLE_ENTITLEMENT'),('WHOP_DIRECT')),
ent(e) as (values (null::text),('x')),
grid as (select * from mode, st, ps, src, ent),
eval as (select *,
 -- constraints BEFORE 0080 (0010, 0021, 0025)
 ( m = 'DEVELOPMENT_SIMULATED'
 and p in ('SIMULATION_PENDING','SIMULATION_CAPTURED','SIMULATION_FAILED','LEGACY_UNVERIFIED','BALANCE_CHARGED','ENTITLEMENT_CONSUMED')
 and (s not in ('ACTIVE','PAUSED') or p in ('SIMULATION_CAPTURED','LEGACY_UNVERIFIED','BALANCE_CHARGED','ENTITLEMENT_CONSUMED'))
 and ((s='PAYMENT_FAILED') = (p='SIMULATION_FAILED'))
 and c in ('SIMULATED_PROVIDER','COMMERCIAL_BALANCE','BUNDLE_ENTITLEMENT')
 and ((c='SIMULATED_PROVIDER') or (c='COMMERCIAL_BALANCE' and p='BALANCE_CHARGED') or (c='BUNDLE_ENTITLEMENT' and p='ENTITLEMENT_CONSUMED' and e is not null)) ) as old_ok,
 -- constraints AFTER 0080
 ( m in ('DEVELOPMENT_SIMULATED','WHOP_LIVE')
 and p in ('SIMULATION_PENDING','SIMULATION_CAPTURED','SIMULATION_FAILED','LEGACY_UNVERIFIED','BALANCE_CHARGED','ENTITLEMENT_CONSUMED','PROVIDER_PENDING','PROVIDER_PAID','PROVIDER_FAILED','PROVIDER_REFUNDED','PROVIDER_DISPUTED')
 and (s not in ('ACTIVE','PAUSED') or p in ('SIMULATION_CAPTURED','LEGACY_UNVERIFIED','BALANCE_CHARGED','ENTITLEMENT_CONSUMED','PROVIDER_PAID','PROVIDER_DISPUTED'))
 and ((s='PAYMENT_FAILED') = (p in ('SIMULATION_FAILED','PROVIDER_FAILED')))
 and c in ('SIMULATED_PROVIDER','COMMERCIAL_BALANCE','BUNDLE_ENTITLEMENT','WHOP_DIRECT')
 and ((c='SIMULATED_PROVIDER') or (c='COMMERCIAL_BALANCE' and p='BALANCE_CHARGED') or (c='BUNDLE_ENTITLEMENT' and p='ENTITLEMENT_CONSUMED' and e is not null) or (c='WHOP_DIRECT' and m='WHOP_LIVE' and p in ('PROVIDER_PENDING','PROVIDER_PAID','PROVIDER_FAILED','PROVIDER_REFUNDED','PROVIDER_DISPUTED')))
 and ((m='WHOP_LIVE') = (c='WHOP_DIRECT') and (m='WHOP_LIVE') = (p in ('PROVIDER_PENDING','PROVIDER_PAID','PROVIDER_FAILED','PROVIDER_REFUNDED','PROVIDER_DISPUTED'))) ) as new_ok
 from grid)
select 'combinations' k, count(*)::text v from eval
union all select 'old_accepted', count(*) filter (where old_ok)::text from eval
union all select 'old_accepted_but_new_rejects (must be 0)', count(*) filter (where old_ok and not new_ok)::text from eval
union all select 'new_accepted_not_old (only WHOP_LIVE allowed)', string_agg(distinct m||'/'||c, ',') filter (where new_ok and not old_ok) from eval
union all select 'new_accepted_WHOP_with_nonWhop_source_or_status (must be 0)', count(*) filter (where new_ok and m='WHOP_LIVE' and (c<>'WHOP_DIRECT' or p not like 'PROVIDER_%'))::text from eval
union all select 'whop_active_paused_allowed_statuses', string_agg(distinct p, ',') filter (where new_ok and m='WHOP_LIVE' and s in ('ACTIVE','PAUSED')) from eval;
