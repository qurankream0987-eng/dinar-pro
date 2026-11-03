# 10 — Cost and capacity

**Status:** A complete monthly total is `UNVERIFIED`; no billable Railway resource was created.

## Measured baseline

The inspected environment currently has only one PostgreSQL service and a 500 MB volume. The latest
168-hour hourly aggregation returned 169 samples; average PostgreSQL RAM use was approximately
0.06165 GB and the disk metric approximately 0.12255 GB. CPU and network units, disk-metric scope,
app usage, account plan, credits, spending limit, and exact billing period were not established.
These readings cannot be converted into a defensible application capacity or total cost.

Railway storage-bucket documentation checked 2026-11-03 lists **$0.015 per GB-month**; bucket API
operations and bucket egress are documented as free, while uploads from a Railway service count as
service egress. PITR has no separate fee but consumes bucket storage and service egress for WAL and
backup uploads. This rate is not applied to the existing PostgreSQL volume.

Sources: [Storage bucket billing](https://docs.railway.com/storage-buckets/billing) and
[PostgreSQL PITR](https://docs.railway.com/volumes/point-in-time-recovery).

## Operating scenarios

| Scenario | Prepared shape | Cost status |
|---|---|---|
| Low | One app replica, one separate staging PostgreSQL service, private storage; no optional live providers | `UNVERIFIED`; app traffic and account plan are unknown |
| Expected | Same single-replica shape, sized from a representative staging load test, observed database use, storage retention, and egress | `UNVERIFIED`; no staging workload or app telemetry exists |
| High | Peak workload measured in a controlled load test; do not add replicas until scheduled-job safety is proven | `UNVERIFIED`; no peak app workload exists |

No usage volume is invented for any scenario. Before estimating, obtain the account plan/credits and
approved monthly ceiling, then measure app CPU/RAM, PostgreSQL CPU/RAM/connections, actual volume
usage, storage GB-month, service egress, and any provider fees.

## Cost model

```text
monthly total =
  app compute (measured CPU/RAM × current rates × active hours)
  + PostgreSQL plan/compute/storage
  + object storage (measured GB-month × $0.015)
  + service egress (including uploads to object storage/PITR)
  + approved provider/domain/monitoring fees
  − applicable verified credits
```

Do not include a total until each input is verified against the owner’s Railway account and current
usage rates. Keep one replica, no public domain, no optional provider, and no PITR bucket until the
owner approves the scope and monthly limit.
