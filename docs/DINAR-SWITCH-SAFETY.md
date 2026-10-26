# Development switch safety record

Before runtime edits:
- Branch: main
- HEAD: 9fae76687e2fbd257016cda73ba55f4613a57f25
- Git status: only the newly attached switch authorization was untracked.
- DINAR_DEV_DATABASE_URL: PRESENT.
- Target verified using authenticated TLS: RAILWAY_CANONICAL_DEV.
- Migration ledger: 27 entries, latest timestamp 1791414714693,
  corresponding to 0026_burly_power_pack.
- Managed DATABASE_URL unchanged. No legacy or production write authorized.
- No UNKNOWN data import authorized. No seed containing financial fixtures authorized.

The runtime retains its existing development-only URL selection and now applies
the independently verified TLS configuration for the Railway development override.
Connection failures propagate; there is no retry against the legacy database.
Production and disposable loopback configuration remain unchanged.

## Minimal development acceptance update (2026-10-08)

Following explicit owner authorization, only the Jordan market was activated in
the canonical development database. Its development reference price is 1.000
JOD and its courier capability is enabled alongside its existing methods; its
payment-method configuration was preserved. A catalog comparison verified that
all other market records remained unchanged. No production or legacy database
was accessed for this change.

The existing development seed was still not run. The API acceptance created
three synthetic accounts, one listing, and one uncompleted TEST_NO_TRANSFER
order through the normal development API flows. Temporary browser acceptance
created three additional synthetic accounts through the public verification and
registration routes: one remained associated with inactive KW, one JO account
was used for signed-in screenshots, and a second JO account submitted driver
profile `3216303b-4d91-4513-b929-ab7e7185eefe` for review. That profile remains
`PENDING_VERIFICATION`; no administrator approval was performed.

The browser follow-ups created no listings or orders. The courier account has
zero orders and no assignment, fare proposal/agreement, payment, or other
financial record. The original API acceptance order was not completed and its
seller-dues response was empty.

Authenticated API acceptance passed. The signed-in conversation home rendered
at 1440, 390, and 320 px with no horizontal overflow or observed browser errors.
Courier onboarding and submission rendered in the authenticated UI. The live
fare agreement remains unverified while the profile awaits a market
administrator; no admin session or auth bypass was used.
