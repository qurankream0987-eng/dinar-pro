# DINAR — Testing guide (how to get real, repeatable evidence)

Everything here was used to produce the current results (86 suites, 84 green; the two others
are environment-bound). Follow it exactly; a result from another setup is not comparable.

## 1. One-time setup in a Linux container

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/dinar run build
```

### 1.1 PostgreSQL 16 on loopback (two clusters)

Main cluster on 55432, a second one on 55479 for `personal-intelligence`:

```sh
for spec in dinar-pg:55432 dinar-pg2:55479; do
  dir=/var/tmp/${spec%%:*}; port=${spec##*:}
  mkdir -p $dir && chown postgres $dir
  su postgres -s /bin/sh -c "/usr/lib/postgresql/16/bin/initdb -D $dir/data -A trust" # once
  su postgres -s /bin/sh -c "/usr/lib/postgresql/16/bin/pg_ctl -D $dir/data \
      -o '-c listen_addresses=127.0.0.1 -p $port -k $dir' -l $dir/log start"
  psql -h 127.0.0.1 -p $port -U postgres -c "CREATE ROLE dinar_isolation LOGIN CREATEDB" || true
done
pg_isready -h 127.0.0.1 -p 55432 && pg_isready -h 127.0.0.1 -p 55479
```

After **any container restart** both clusters are stopped: run the `pg_ctl ... start` lines again.

### 1.2 Browser: Chromium wrapper and the fonts stub

The web app loads Google Fonts; the sandbox has no internet; browser suites fail on console errors.
So Chromium resolves the font hosts to loopback and a local stub answers.

```sh
S=/tmp/dinar-test && mkdir -p $S
# a self-signed certificate for the stub (once)
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=sandbox-third-party" \
  -addext "subjectAltName=DNS:fonts.googleapis.com,DNS:fonts.gstatic.com" \
  -keyout $S/stub.key -out $S/stub.crt
# trust only this certificate (not every certificate): its public-key pin
SPKI=$(openssl x509 -in $S/stub.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
# the wrapper (use the Chromium that Playwright installed in the image) — same as sandbox.sh
cat > $S/chromium <<EOF
#!/bin/sh
exec /opt/pw-browsers/chromium-1194/chrome-linux/chrome --no-sandbox \\
  --host-resolver-rules="MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1" \\
  --ignore-certificate-errors-spki-list="$SPKI" "\$@"
EOF
chmod +x $S/chromium
# the stub (keep it running for the whole test session; restart after a container restart)
node artifacts/api-server/test/isolation/third-party-stub.mjs $S/stub.crt $S/stub.key 443 $S/stub.log &
```

Adjust the Chromium path to your image (`ls /opt/pw-browsers`). If a browser suite fails with
`Failed to load resource: net::ERR_CONNECTION_REFUSED`, the stub is not running — environment,
not code.

## 2. Running one suite

From `artifacts/api-server`:

```sh
DINAR_LOCAL_PG=postgres://dinar_isolation@127.0.0.1:55432 DINAR_CHROMIUM=/tmp/dinar-test/chromium \
  test/isolation/local-suite.sh <suite>.test BDINAR_TEST_DATABASE=development \
  BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true
```

- Creates a fresh database, applies the 41 migrations, seeds fixtures, runs the suite in `env -i`
  with net-guard (any non-loopback connection fails the run, exit 98), then drops the database.
- Only `BDINAR_*` / `DINAR_*` arguments pass through; anything that looks like a key is refused.
- Options: `DINAR_SUITE_SEED=fixtures|development|none`, `DINAR_SUITE_DB=<name>`,
  `DINAR_SUITE_KEEP_DB=1`.
- Each suite's own approval flag is in `artifacts/api-server/package.json` scripts
  (`BDINAR_G2_ACCEPTANCE`, `BDINAR_BLOCKF_ACCEPTANCE`, …). Passing all of them as `=development`
  is safe in this harness.

Special suites:

| Suite | How |
|---|---|
| `pre-switch` | `DINAR_SUITE_SEED=development` |
| `admin-bootstrap`, `readiness`, `ai-authority-boundary` | `DINAR_SUITE_SEED=none` |
| `fresh-environment` | seed none, `DINAR_SUITE_DB=dinar_test_fresh_<x>` |
| `phase2-commission-acceptance` | seed development |
| `listing-pricing-invariants` | `DINAR_SUITE_DB=dinar_test_blockb_<x>` |
| `listing-image-publication-acceptance` | `DINAR_SUITE_DB=dinar_test_image_review_<x>`, `BDINAR_IMAGE_PUBLICATION_ACCEPTANCE=disposable` |
| `personal-intelligence` | app DB on 55432 + `DINAR_PERSONAL_TEST_DATABASE_URL=postgres://dinar_isolation@127.0.0.1:55479/<db>` (create `<db>` first) |
| `storage-portability`, `storage-s3-wire` | `pnpm run test:<name>` (no DB) |
| `phase1-acceptance` | BLOCKED here: external Unsplash images in sample data |
| `lib/db` `test:release-migration` | BLOCKED here: needs PostgreSQL 18 |

## 3. The full battery

Run every `artifacts/api-server/test/*.test.ts` once, in sequence, with the special cases above,
and record one line per suite: `SUITE=<name> EXIT=<code> SECS=<n> OUTBOUND=<n> pass=<n> fail=<n>`.
It takes 60–80 minutes. **Do not edit `src` while it runs.** Report the first attempt as it is;
re-runs are reported separately with their cause.

Current reference (head `9679e48`): 86 suites, 84 pass, 1,092 cases, 0 outbound; `phase1`
environment-blocked; `pre-switch` passes with the development seed.

## 4. Acceptance journeys (REAL_E2E)

`test/sc01|sc03|sc07|sc10-browser-journey.test.ts` drive `artifacts/dinar/test/sc*-ui-journey.mjs`
through `sc-ui-session.mjs`:

- a real Vite web server (`test/browser-test-web-server.ts`) proxying to the test API;
- independent signed-in users in separate browser contexts;
- the scenario's own Arabic phrases typed into the composer;
- widths 320 / 390 / 1280, RTL, touch targets ≥ 32 px, named buttons, no horizontal overflow;
- recorded `consoleErrors`, `pageErrors`, `externalRequests`, `modelFallbacks` (must be empty
  unless a step is explicitly `allowFallback` with a reason);
- after the browser: database assertions (ownership, amounts, snapshots, stock, one order).

A new journey copies this structure. Run it three times in a row before calling it stable.

## 5. Unit-style and API suites to know

| Suite | Protects |
|---|---|
| `financial-state-machine` | D1–D3, last unit, agreed price, refunds, idempotency (23 cases) |
| `payment-order-state`, `wave4-payment-acceptance` | payment states, signed events |
| `ai-authority-boundary` | no AI authority (must not change) |
| `request-collection-bounds`, `same-origin-web`, `security-acceptance` | body bounds, CSRF/origin, security |
| `arabic-search-understanding`, `sc-conversation-routing`, `arabic-generality` | Arabic understanding, routing, generality floor |
| `pro-subscription-honesty` | no fake subscription, checkout refuses without billing |
| `universal-negotiation-acceptance` | negotiation rules |
| `g2-smart-conversation`, `command-*`, `block-*`, `nl-commerce-*` | the conversation runtime |

## 6. Evidence format (copy into every report)

```
BASE_SHA: <sha>   HEAD_SHA: <sha>   BRANCH: qoder/<NN>-<topic>
RED: <suite> before the fix → <failing case and message>
GREEN: <suite> after → pass=<n> fail=0 (runs: 1/1, 2/2, 3/3 for journeys)
BATTERY: suites=<n> pass=<n> fail=<n> cases=<n> outbound=<n>
FAILURES: <suite> — <code|test|environment> — <log line>
RETRIES: <suite> — <cause>
BROWSER: <suite> widths=320,390,1280 consoleErrors=[] externalRequests=[] modelFallbacks=[]
NOT DONE: <what and why>
```
