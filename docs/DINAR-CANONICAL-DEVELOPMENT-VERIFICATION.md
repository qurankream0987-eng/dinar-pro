# Canonical development database verification

## Latest pre-switch closure

The historical Block E failure below is resolved. See
[DINAR-PRE-SWITCH-FINAL-READINESS.md](DINAR-PRE-SWITCH-FINAL-READINESS.md)
for the current 42/42 Block E result, read-only legacy classification,
disposable expiry/ledger/startup proof and focused readiness results.
The managed API remains unswitched; no legacy data was imported.

## Scope and safety

The isolated Railway development database is the only migration target.
The legacy Replit development database and its archive must remain unchanged.
Production and Codex frontend work are outside this work's edit scope.

## Verified TLS

The development PostgreSQL service presents a certificate signed by its own
volume-specific CA. The public TCP proxy DNS name is not in its certificate.
The CA and server certificate fingerprints were independently retrieved through
authenticated Railway service access and matched against the public endpoint.

The verified connection configuration in `lib/db/src/development-tls.ts`:

- Connects to the approved public proxy.
- Trusts only the authenticated development CA for this connection.
- Keeps `rejectUnauthorized: true` and requires TLS 1.2 or newer.
- Validates the certificate's service DNS identity, not the forwarding proxy's name.
- Rejects production use, unexpected endpoints and TLS downgrade options.
- Contains only a public CA certificate, never private keys or credentials.

The live acceptance test verifies encrypted connectivity and confirms rejection
of both a wrong service identity and an untrusted CA. The CA must be authenticated
again after certificate rotation or replacement of the database volume.

## Migration path

`lib/db/drizzle.config.ts` uses this verified connection for the canonical Railway
development override. The canonical SQL files and journal are unchanged.

Remote migrations contain hundreds of sequential statements. Use a sufficiently
long-running tracked process; a command's exit status alone does not prove that
the transaction committed. Check the actual migration ledger count, hashes and
timestamps against all 27 canonical journal entries through `0026`.

## Results from this verification pass

- Live verified-TLS acceptance: passed, including wrong-identity and wrong-CA rejection.
- Development database URL selection tests: passed.
- Canonical migrations applied via Drizzle's official PostgreSQL migrator.
- Ledger: 27 entries; every SQL SHA-256 hash and journal timestamp matches;
  latest entry is `0026_burly_power_pack`.
- Normal `pnpm --filter @workspace/db run migrate` rerun: successful no-op.
- `drizzle-kit check`: passed. This checks migration metadata, **not live schema drift**.
- Shared library typecheck, API typecheck, API build and `git diff --check`: passed.
- No legacy data import, runtime switch or API restart was performed.

## Remaining switch gate

### Subsequent comparison and regression pass

A fresh disposable loopback PostgreSQL reference was migrated through the same
27 canonical migrations. Read-only catalog comparison matched columns (720),
non-NOT-NULL constraints (395), indexes (170), triggers (12), functions (9),
sequences (1), enums and views (both empty).

Railway runs PostgreSQL 18; the local reference runs PostgreSQL 16. PostgreSQL 18
adds 600 NOT NULL constraint catalog entries. Nullability is compared separately
for every column, so these additional catalog records are not schema drift.

F4 passed all 23 scenarios. Block E passed 41 of 42 acceptance scenarios (44 of
45 total tests); E04 failed for “أريد إعلان مميز” with AI_PROVIDER_ERROR in the
isolated runner, which intentionally removes external model credentials.
This failure is unresolved; it must not be treated as a passing readiness gate.
Web typecheck and build passed without source changes to the frontend.

The new schema audit command requires NODE_ENV=development and an explicit
DINAR_SCHEMA_REFERENCE_URL pointing to an already-migrated disposable loopback
database. It accesses both schemas read-only and prints catalog counts only.

This TLS work does **not** switch or restart the API. The application's pool still
uses its existing connection configuration. Before switching development:

1. Verify the committed migration ledger and schema drift against a fresh reference.
2. Classify legacy data and salvage only proven-compatible user-created content.
3. Run the requested disposable housekeeping fixture and regression suites.
4. Wire the verified connection configuration into the development runtime without
   changing production or loopback disposable-test behavior.
5. Complete application readiness and smoke checks before and after the switch.

Do not claim that database replacement is complete merely because TLS or
migrations pass.
