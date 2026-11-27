# Jassim Ads Phase 2 — Production release evidence (for owner review)

Prepared 2026-11-27. **Nothing below was applied to Production.** I did not migrate, deploy, merge, change any variable, configure Whop credentials or start a transaction. Every Production check was read-only:
- Railway service configuration (variable *names* only, never values);
- deployment and backup history and logs;
- two anonymous HTTP requests to jassimai.com.

---

## 1. Final commit and complete diff

| | |
|---|---|
| Branch | `claude/jassim-ads-phase2` (pushed; not merged) |
| **Final commit** | **`07d9e09cfee94ffb96dcf74611e90e002fb5c2c7`** |
| Base (current Production) | `ca942a87fc736a92855109c7ec8170b528a5fdbb` |
| Size | 29 files, +1114 / −60 |
| Complete diff | `01-phase2-full.diff` (`git diff ca942a8 07d9e09`) |
| Commit list | `01-commits.txt` |

**Changes since my previous report (`d4f1b35`), all found during this review:**

1. **Migration 0080 now has a seventh constraint, `listing_promotions_whop_mode_consistent`.** It closes a gap: under the first version, the database alone would have accepted a row with mode `WHOP_LIVE`, source `SIMULATED_PROVIDER` and status `PROVIDER_PAID`. My code never wrote such a row, but the database should refuse it too, and now does.
2. **Disputes and refunds that arrive before the payment confirmation.** If Whop re-sends a delayed `payment.succeeded` after a dispute or refund, the campaign could previously start. Now the dispute or refund cancels the pending campaign, and the late payment is only recorded for review.
3. **A dispute on a payment Whop can no longer find** is recorded for review, instead of being retried by Whop for three days.
4. **New test AP-08:** missing or malformed configuration keeps every gate shut.
5. **New file `rollback-0080.sql`.**

---

## 2. Migration 0080: complete SQL and impact

The full text is in `02-migration-0080.sql` (sha256 `13331260e1ac1c76e4ba2d94ebfe5d6a5536cdf7f1a63753d9e1797b1899f69a`, recorded in `release-manifest.json` and the clone guard).

**Scope**
- One table: `listing_promotions`.
- Six CHECK constraints are dropped and re-added with wider value lists.
- One CHECK constraint is added.
- No new tables or columns. No `UPDATE`, `DELETE` or `INSERT` of data. No index changes. No change to any other table.

| Constraint | Before (migration it came from) | After |
|---|---|---|
| `simulation_only_check` | `payment_mode = 'DEVELOPMENT_SIMULATED'` (0010) | `IN ('DEVELOPMENT_SIMULATED','WHOP_LIVE')` |
| `payment_status_valid` | 6 simulated, balance and bundle statuses (0025) | the same 6 + `PROVIDER_PENDING/PAID/FAILED/REFUNDED/DISPUTED` |
| `live_requires_payment` | ACTIVE/PAUSED need one of 4 statuses (0025) | the same 4 + `PROVIDER_PAID`, `PROVIDER_DISPUTED` |
| `failed_consistent` | `PAYMENT_FAILED ⇔ SIMULATION_FAILED` (0021) | `PAYMENT_FAILED ⇔ SIMULATION_FAILED or PROVIDER_FAILED` |
| `payment_source_valid` | 3 sources (0025) | the same + `WHOP_DIRECT` |
| `payment_source_status` | the 3 original clauses (0025) | the 3 original clauses **verbatim** + one clause for `WHOP_DIRECT` with `WHOP_LIVE` and a `PROVIDER_*` status |
| `whop_mode_consistent` (new) | — | `WHOP_LIVE` ⇔ `WHOP_DIRECT` ⇔ a `PROVIDER_*` status |

**Locking and duration**
- `ADD CONSTRAINT … CHECK` validates every existing row while holding an ACCESS EXCLUSIVE lock on `listing_promotions` only.
- The release migrator applies everything in **one transaction** under an advisory lock, after confirming the recorded migrations are an exact prefix of the release's list. Any failure rolls back completely.
- On the rehearsal database, applying 0080 took **34 ms**. Production has very few promotion rows, because simulation is off there.

**Effect on existing records: none.**
- **Proof by enumeration** (`03-truth-table.txt`, SQL in `03-truth-table.sql`): of 1,848 combinations of mode, status, payment status, source and entitlement, the pre-0080 rules accept 76. **All 76 are still accepted (0 newly rejected).** The only newly accepted combination is `WHOP_LIVE` with `WHOP_DIRECT` and a `PROVIDER_*` status, and the database rejects any `WHOP_LIVE` row with another source or status.
- **Rehearsal on real data** (`03-rehearsal-on-production-version.txt`). I built a database at the exact Production version `ca942a8` (migrations 0000–0079) and filled it from the existing promotion, advertising, Whop billing and commerce suites. I then inserted one real row for each of the 76 valid combinations (81 rows in total). Results:
  - 0080 applied cleanly;
  - the data checksum was identical before and after (`md5 fc8a204b…`);
  - the database rejected every invalid combination I tried (`whop_mode_consistent`, `payment_source_status`, and the existing immutability trigger).

---

## 3. Compatibility of existing promotion records and payment flows

| Area | Why it is unaffected | Evidence |
|---|---|---|
| Existing promotion rows | Every one stays valid (section 2). The row-integrity trigger is untouched; payment mode is immutable after insert, so no existing row can become `WHOP_LIVE`. | truth table, rehearsal |
| Serving (search, recommendations, welcome, hero/sidebar, «جاسم روح بيع لي») | `servingPaymentModes()` returns exactly `DEVELOPMENT_SIMULATED` when simulation is on and nothing when it is off, which matches the previous rule. `WHOP_LIVE` is added only when gate 1 is on. On Production simulation is off, so nothing serves, as before. | promotions 6/6, advertising-acceptance 5/5, welcome-ads-browser 3/3, jassim-ads-phase1 5/5 |
| Test-balance purchases and bundle units | `purchaseCommercialProduct` is unchanged. The new path is taken only when `whopDirectApplies()` is true, and its first check is gate 1, so when the gate is off no extra database query runs. | promotion-intent, block-e, commerce-journey |
| Whop subscriptions (Go/Pro/Business) | A webhook is routed to promotions only when the payment metadata has `kind = "JASSIM_PROMOTION"` and a UUID. Subscription checkouts never set `kind`. The subscription branches are otherwise unchanged; the only addition is a payment lookup on `dispute.*`, which falls through to the previous "recorded for review" result. | whop-billing 19/19, whop-rules 13/13, whop-platform 15/15 |
| Marketplace order payments | A separate domain (`lib/payments`). Not touched. | commerce-journey 8/8 |
| API contract | OpenAPI enums were only widened (`paymentMode`, `paymentStatus`, `paymentSource`). Clients regenerated; nothing removed. | typecheck, web build |

---

## 4. Rollback plan

**Fact to plan around:** after 0080 is applied, redeploying the old version `ca942a8` unchanged is **refused** by its own release check (`LEDGER_AHEAD`: the database records a migration the code doesn't know). The new deployment fails, and the running one keeps serving. This is a safety feature, so the rollback has to be one of the following.

| Level | When | How | Consequences |
|---|---|---|---|
| **0 — switches** | Any problem with real payments after a future activation | Set `DINAR_JASSIM_ADS_PAYMENTS` to anything but `true` (takes effect on restart) | All real-payment serving and new checkouts stop at once. Nothing is deleted. Paid campaigns stop showing, and the owner decides on refunds in Whop. |
| **1 — code only (recommended)** | The application misbehaves after deploy | Deploy the prepared "forward revert" branch `claude/jassim-ads-phase2-rollback-l1` (`0ddc28d`): the `ca942a8` code plus the 0080 migration files only (8 files, `04-rollback-level1-branch-diffstat.txt`). It typechecks, builds, and passes development-tls 7/7, readiness 15/15 and promotions 6/6. Pushed; not merged or deployed. | No database change. The old code writes only `DEVELOPMENT_SIMULATED` rows, which satisfy the 0080 constraints, and 0080 itself remains harmless. |
| **2 — database too** | Only if the schema itself must return to 0079 | Fresh verified backup, then `rollback-0080.sql` (one transaction, 5 s lock timeout), then deploy `ca942a8` | Restores the exact pre-0080 definitions (verified identical) and removes the 0080 entry from the migration record. **It refuses** if any real-payment row exists or a later migration is applied; in that case keep 0080. Rehearsed: data checksum unchanged, refusal confirmed. |
| **3 — restore** | Corruption only | Restore the backup taken immediately before 0080 (section 7) | Every write after the backup (users, chats, orders) is lost. Last resort. |

**Separate deployment risk, found today:** the app service's source settings still pin commit `29e6702`, an older pre-Phase-1 commit, even though the running deployment is `ca942a8`. Any redeploy triggered from those settings would try to build `29e6702`. Today that would fail safely (`LEDGER_AHEAD`), but the release procedure must set the source explicitly to `07d9e09`, and I will verify the pin afterwards.

---

## 5. The five gates are closed in Production (read-only evidence)

| Gate | Production evidence (2026-11-27) | Behavior when the variable is missing |
|---|---|---|
| 1. `DINAR_JASSIM_ADS_PAYMENTS=true` (and `BDINAR_PROMOTIONS_ENABLED=true`) | **Neither variable exists** on the app service (Railway variable names). The code is not deployed either: `GET /api/commercial/whop-promotions/availability` returns **404**. | Off. Only exact values open it; `""`, `1`, `yes`, `on`, `false`, `ture` stay off (AP-08). |
| 2. Whop connected | Read-only request `POST https://jassimai.com/api/billing/whop/webhook` → **503 `BILLING_PROVIDER_NOT_CONNECTED`**, so the adapter is not installed. **`WHOP_API_KEY` and `WHOP_BILLING_WEBHOOK_SECRET` do not exist** on the service, so even if the enable flags flipped, the configuration would be incomplete. | Not connected unless all of these hold (AP-08): enable flag, `DINAR_LIVE_PROVIDERS_ENABLED=true` for production, API key, a `ws_…` secret, a `biz_…` company id and a valid plan map. An unset environment falls back to sandbox, never production. |
| 3. Policy `advertisingBillingActivation = WHOP_DIRECT` | The Production code validates this field as the literal `"DISABLED"`, so no stored policy can hold any other value today. | The default is `DISABLED`. Changing it needs an admin policy append, which is versioned and audited. |
| 4. Legal `ELECTRONIC_PAYMENT` | `DINAR_DEPLOYMENT_ENV` is set on the service, so the legal gate is enforced. `ELECTRONIC_PAYMENT` is excluded from pre-legal operation by code. My earlier readiness report today showed 0 of 22 markets legally approved. *I have not re-read the Production database for this review.* | Enforced when neither the deployment marker nor `NODE_ENV` is set (fails closed; AP-08). |
| 5. Whop-supported currency | Fixed list in code. The 10 unsupported currencies are refused (AP-02). | — |

---

## 6. Webhook handling

Rules applied to every event:
- The signature is verified (Standard Webhooks HMAC; ±5-minute timestamp window). A forged event gets 401 and nothing is read.
- The JassimAI Whop account must match.
- The server re-reads the payment from Whop; the body is only a hint.
- The event is recorded in `billing_webhook_events` in **the same transaction** as the change, deduplicated by `webhook-id`.
- If Whop can't be reached, nothing is recorded and the server returns 503, so Whop re-sends the event.

| Case | Result | Test |
|---|---|---|
| Same event delivered twice, or concurrently | The second delivery is `duplicate`. The campaign row is locked `FOR UPDATE` and the record insert conflicts, so it is applied once. | AP-04 |
| Second, different payment on a paid campaign | `ALREADY_PAID_SECOND_PAYMENT_REVIEW`: not applied twice, logged for refund review | AP-04 |
| Wrong amount (pre-tax subtotal ≠ server snapshot) or wrong currency | `AMOUNT_MISMATCH_REVIEW`: stays pending, never served | AP-04 |
| Wrong seller in the metadata | `OWNER_MISMATCH` | AP-04 |
| Payment not "paid" yet / declined attempt | `PROVIDER_STATE_NOT_PAID` / `ATTEMPT_FAILED_RETRY_ALLOWED` (the Whop page stays open for a retry) | AP-04 |
| Late payment after the seller or the system cancelled the checkout (60-min pending window) | `PAID_AFTER_CANCEL_REFUND_REVIEW`: never served; refund it in Whop | AP-06 |
| Dispute on a live campaign | `PAUSED` / `PROVIDER_DISPUTED`; never serves on disputed money | AP-05 |
| **Dispute or refund before the payment event** (out of order) | The pending campaign is cancelled; a later `payment.succeeded` gives `ALREADY_SETTLED_PAYMENT_REVIEW` and never starts it | AP-06 |
| Partial refund | `PARTIAL_REFUND_FOR_REVIEW`: no change | AP-05 |
| Full refund (refunded amount = total charged) | `CANCELLED` / `PROVIDER_REFUNDED`. Nothing in the system ever *issues* a refund. | AP-05 |
| Dispute on a payment Whop no longer finds | Recorded for review, not retried for days | AP-06 |
| A payment not tagged as a promotion | Never reaches campaigns (subscription path → `NOT_A_JASSIM_SUBSCRIPTION`) | AP-06 |
| A lost dispute | Whop creates no refund record, so the campaign stays paused for your decision | — |

---

## 7. Backup verification and recovery procedure

**Latest Production backup** (job `jassimai-production-backup-job`):
- `BACKUP_OK`, 2026-11-27 15:27:45 UTC;
- key `daily/2026/11/27/jassimai_production-20261127T152743Z.dump`;
- sha256 `dd2b42ea…a8afcb`;
- counts: 151 tables, 79 migrations.

The job also verifies, every time:
- the bucket copy is re-downloaded and its sha256 matched;
- anonymous access to the bucket must be refused;
- refusal to run unless the database host, database name, PostgreSQL ≥ 18 and the dedicated backup bucket are all exact.

**Two honest limitations:**
1. **That backup predates migration 0079** (79 = 0000–0078; 0079 was deployed at 15:44 UTC). A new backup immediately before 0080 is therefore mandatory, and it is step 1 of the release procedure.
2. **A restore has never been tested in Production.** The script's `restore-test` mode needs a separate restore server (`jassimai-production-restore-test`), which has not been created. It would be a new small PostgreSQL service, which is a cost and needs your approval. I recommend approving it and running one restore test before 0080. I do **not** recommend restoring Production data into qa-lab or anywhere outside Production.

**Recovery procedure (restore, level 3):**
1. Stop writes: scale the app to 0 replicas, or put up a maintenance gate.
2. Download the chosen dump and verify its `.sha256` and `.counts` files.
3. `pg_restore --clean --if-exists --no-owner` into a **new** database on the Production Postgres. Never overwrite the live database in place.
4. Compare the table and migration counts with the `.counts` file, then run `production-smoke.sh` against the new database.
5. Point the app's `DATABASE_URL` reference at the restored database and deploy the version that matches its migration record (0079 → `ca942a8`; 0080 → `07d9e09`).
6. Keep the old database untouched until you confirm the recovery.

---

## 8. Other systems

| System | Files changed? | Evidence on `07d9e09` |
|---|---|---|
| Authentication | No auth files changed. Every suite registers and logs in through the real auth routes. | all suites |
| Subscriptions (Whop) | `billing/whop.ts`: promotion routing added only behind `kind = JASSIM_PROMOTION` | whop-billing, whop-rules, whop-platform |
| Wallet / commercial balance | Ledger unchanged. Commerce chat skips the balance only for a Whop-paid product with all gates open. | promotions, promotion-intent, block-e, commerce-journey |
| Chat | `commerce-turn.ts` only, gated | AP-07, block-f5, promotion-intent |
| Orders | Not changed | commerce-journey, block-e |
| Promotions | Unified serving rule, equivalent when Whop is off | promotions, advertising-acceptance, wave03-d9, welcome-ads-browser |

**Final regression on `07d9e09`** (`05-final-regression.txt`; disposable local database, 0 outbound connections in every suite):

| Suite | Result |
|---|---|
| jassim-ads-phase2 (new, AP-01…AP-08) | 8/8 |
| jassim-ads-phase1 | 5/5 |
| promotions | 6/6 |
| promotion-intent | 6/6 |
| advertising-acceptance | 5/5 (run alone; when run in parallel, account setup clashed on a shared phone range) |
| wave03-d9-campaign-audit | 1/1 |
| welcome-ads-browser (browser) | 3/3 |
| whop-billing | 19/19 |
| whop-rules | 13/13 |
| whop-platform | 15/15 |
| commerce-journey | 8/8 |
| conversation | 29/29 |
| arab-markets-pre-legal | 29/29 |
| readiness | 15/15 |
| development-tls | 7/7 |
| block-e-acceptance | 44/46: the same 2 tests fail on `ca942a8` |
| block-f5-unified | 25/29: the 4 failures are among the 5 that fail on `ca942a8` |
| typecheck, API build, web build | pass |

Not run: `pre-switch`, which needs a live development server. Its conversation commerce path is covered by AP-07 and promotion-intent.

**Pre-existing failures, compared with the exact Production version.** Railway confirms the running deployment is commit `ca942a8` (its `commitHash` field). I ran `block-e-acceptance` and `block-f5-unified` on that exact commit, on the same machine, with the same flags. The same tests fail there as on this branch:
- block-e: E01 and E02, which expect a 1000 bps commission; the commission rule changed earlier (Stage 1, 5%).
- block-f5: F5-07, F5-10, F5-21, F5-24 and F5-25.

The block-e failures are identical (`500 !== 1000`). block-f5 on the final commit fails a subset of the baseline's failures (F5-25 passed this time). Neither is caused by this change.
