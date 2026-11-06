#!/bin/sh
# Runs test/run.mjs suites against a fresh database on an existing LOOPBACK PostgreSQL server,
# for hosts where sandbox.sh cannot run (root containers, no user namespaces, no PostgreSQL 18).
# Weaker than sandbox.sh: there is no network namespace; isolation is a clean environment
# (env -i) plus the net-guard preload, which refuses and records every non-loopback attempt.
#
#   DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh <suite.test> [more.test ...] [VAR=value ...]
#
# Several suites may be named: they share ONE migrated and seeded database and run in order.
# This proves subsystem coexistence; the exit code is the first failed suite's (98 for outbound).
#
# Optional: DINAR_SUITE_DB (default dinar_test_local_<random>), DINAR_SUITE_SEED
# (fixtures|development|none, default fixtures), DINAR_SUITE_KEEP_DB=1, DINAR_SUITE_REUSE_DB=1,
# DINAR_SUITE_RELEASE_MIGRATIONS=1, DINAR_CHROMIUM.
# Extra VAR=value arguments must be BDINAR_*/DINAR_* switches; credentials are refused.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
API=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$API/../.." && pwd)
: "${DINAR_LOCAL_PG:?set DINAR_LOCAL_PG to a loopback PostgreSQL server URL without a database}"
case "$DINAR_LOCAL_PG" in
  postgres://*@127.0.0.1:*|postgres://*@localhost:*|postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
  *) echo "LOCAL_SUITE: DINAR_LOCAL_PG must be a loopback server URL" >&2; exit 96 ;;
esac
case "${DINAR_LOCAL_PG#*://*@*:}" in */*) echo "LOCAL_SUITE: DINAR_LOCAL_PG must not name a database" >&2; exit 96 ;; esac

DB=${DINAR_SUITE_DB:-dinar_test_local_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')}
case "$DB" in *development*|*production*|*staging*|*canonical*|*legacy*)
  echo "LOCAL_SUITE: database name $DB is reserved" >&2; exit 96 ;; esac
case "$DB" in ""|*[!a-zA-Z0-9_]*)
  echo "LOCAL_SUITE: database name must contain only letters, numbers and underscores" >&2; exit 96 ;; esac
[ "${#DB}" -le 63 ] || { echo "LOCAL_SUITE: database name exceeds PostgreSQL's limit" >&2; exit 96; }
REUSE_DB=${DINAR_SUITE_REUSE_DB:-0}
RELEASE_MIGRATIONS=${DINAR_SUITE_RELEASE_MIGRATIONS:-0}
case "$REUSE_DB" in 0|1) ;; *) echo "LOCAL_SUITE: DINAR_SUITE_REUSE_DB must be 0 or 1" >&2; exit 96 ;; esac
case "$RELEASE_MIGRATIONS" in 0|1) ;; *) echo "LOCAL_SUITE: DINAR_SUITE_RELEASE_MIGRATIONS must be 0 or 1" >&2; exit 96 ;; esac
URL="$DINAR_LOCAL_PG/$DB"

SUITES=""
EXTRA=""
for arg in "$@"; do
  case "$arg" in
    BDINAR_*=*|DINAR_*=*)
      case "${arg%%=*}" in *KEY*|*SECRET*|*TOKEN*|*PASSWORD*|*DATABASE_URL*)
        echo "LOCAL_SUITE: refusing credential-like variable ${arg%%=*}" >&2; exit 96 ;; esac
      EXTRA="$EXTRA $arg" ;;
    *=*)
      echo "LOCAL_SUITE: switch must use a BDINAR_*/DINAR_* prefix ($arg)" >&2; exit 96 ;;
    *)
      # Names are bare *.test tokens; reject shell metacharacters before intentional word splitting.
      case "$arg" in *[!a-zA-Z0-9._-]*)
        echo "LOCAL_SUITE: invalid suite name ($arg)" >&2; exit 96 ;; esac
      case "$arg" in *.test) SUITES="$SUITES $arg" ;;
        *) echo "LOCAL_SUITE: suite arguments must end in .test ($arg)" >&2; exit 96 ;; esac ;;
  esac
done
[ -n "$SUITES" ] || { echo "usage: local-suite.sh <suite.test> [more.test ...] [VAR=value ...]" >&2; exit 96; }

if [ "$REUSE_DB" = 1 ]; then
  [ "${DINAR_SUITE_KEEP_DB:-0}" = 1 ] || {
    echo "LOCAL_SUITE: reuse requires DINAR_SUITE_KEEP_DB=1" >&2; exit 96;
  }
  [ "${DINAR_SUITE_SEED:-none}" = none ] || {
    echo "LOCAL_SUITE: reuse requires DINAR_SUITE_SEED=none" >&2; exit 96;
  }
  [ "$RELEASE_MIGRATIONS" = 0 ] || {
    echo "LOCAL_SUITE: reuse cannot apply migrations" >&2; exit 96;
  }
  case "$DB" in dinar_test_legal_*) ;; *)
    echo "LOCAL_SUITE: reuse is restricted to dinar_test_legal_* databases" >&2; exit 96 ;; esac
  node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
(async () => {
  const root = new pg.Client({ connectionString: process.argv[1] + '/postgres' });
  await root.connect();
  const exists = await root.query('SELECT 1 FROM pg_database WHERE datname = \$1', [process.argv[2]]);
  await root.end();
  if (exists.rowCount !== 1) throw new Error('reusable database does not exist');
  const client = new pg.Client({ connectionString: process.argv[1] + '/' + process.argv[2] });
  await client.connect();
  const ledger = await client.query(\"SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present\");
  if (!ledger.rows[0]?.present) throw new Error('release migration ledger is absent');
  const count = await client.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  await client.end();
  if (count.rows[0].count < 1) throw new Error('release migration ledger is empty');
  console.log('LOCAL_SUITE_REUSE_DB database=' + process.argv[2] + ' migrations=' + count.rows[0].count);
})().catch((error) => { console.error(error.message); process.exit(90); });
" "$DINAR_LOCAL_PG" "$DB"
else
  node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
const c = new pg.Client({ connectionString: process.argv[1] + '/postgres' });
c.connect().then(() => c.query('DROP DATABASE IF EXISTS \"' + process.argv[2] + '\"')).then(() => c.query('CREATE DATABASE \"' + process.argv[2] + '\"')).then(() => c.end()).catch((e) => { console.error(e.message); process.exit(90); });
" "$DINAR_LOCAL_PG" "$DB"
fi

WORK=$(mktemp -d)
NETLOG="$WORK/net-attempts.log"
: > "$NETLOG"
SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
SEEDPW=seed-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
CHROMIUM=${DINAR_CHROMIUM:-}
STUB_PID=""
STUB_LAUNCH_PID=""
STUB_AS_ROOT=0
needs_chromium() {
  case "$1" in
    *browser-journey*|*browser.test|security-acceptance.test|wave3-acceptance.test|w02-ultra-browser.test|command-e-ui.test|command-f-journeys.test|d16-readiness.test|wave06-d16-compliance-acceptance.test|block-a-acceptance.test|block-c-acceptance.test|block-d-acceptance.test|block-e-acceptance.test|block-f4-driver.test|block-f5-unified.test|contact-browser-microclosure.test|deepseek-chat-compatibility.test|experience-upgrade-acceptance.test|g3-ui.test|next-g3-acceptance.test|phase2-commission-acceptance.test|universal-control-acceptance.test) return 0 ;;
    phase1-acceptance.test)
      case " $EXTRA " in *" BDINAR_PHASE1_SKIP_BROWSER=1 "*) return 1 ;; *) return 0 ;; esac ;;
    *) return 1 ;;
  esac
}
if [ -n "$CHROMIUM" ]; then
  PROVIDER_NAV_SAN=""
  PROVIDER_NAV_MAP=""
  case " $SUITES " in
    *" connect-cards-browser-journey.test "*)
      PROVIDER_NAV_SAN=",DNS:dash.cloudflare.com"
      PROVIDER_NAV_MAP=", MAP dash.cloudflare.com 127.0.0.1" ;;
  esac
  case " $SUITES " in
    *" connect-finance-browser-journey.test "*)
      PROVIDER_NAV_SAN="$PROVIDER_NAV_SAN,DNS:browser.catalog.partner.example"
      PROVIDER_NAV_MAP="$PROVIDER_NAV_MAP, MAP browser.catalog.partner.example 127.0.0.1" ;;
  esac
  browser_required=0
  # shellcheck disable=SC2086
  for suite in $SUITES; do
    if needs_chromium "$suite"; then browser_required=1; break; fi
  done
  [ "$browser_required" = 1 ] || CHROMIUM=""
fi
# base: migration and seeding (no suite switches, so e.g. BDINAR_LOG_SCAN never reaches the seed);
# run: the suite itself, with its switches.
base() {
  env -i PATH="$PATH" HOME="$WORK" LANG=C.UTF-8 TZ=UTC NODE_ENV=development \
    DATABASE_URL="$URL" DINAR_DEV_DATABASE_URL="$URL" \
    BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 BDINAR_DISPOSABLE_TEST_DATABASE=1 \
    SESSION_SECRET="$SECRET" BDINAR_SEED_PASSWORD="$SEEDPW" \
    ${CHROMIUM:+REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM" CHROMIUM_PATH="$CHROMIUM"} \
    DINAR_ISOLATION_NET_LOG="$NETLOG" NODE_OPTIONS="--import=file://$HERE/net-guard.mjs" \
    "$@"
}
# shellcheck disable=SC2086
run() { base $EXTRA "$@"; }
# The auth throttle is an IP-keyed counter in this database. A standalone suite starts with an
# empty table; reset only the disposable database between chained suites, never the production gate.
clear_auth_throttle_state() {
  node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
const c = new pg.Client({ connectionString: process.argv[1] });
c.connect().then(() => c.query('DELETE FROM auth_rate_limit_buckets RETURNING key_hash')).then((r) => c.end().then(() => console.log('rows=' + r.rowCount))).catch((e) => { console.error(e.message); process.exit(91); });
" "$URL"
}
cleanup() {
  if [ -n "${STUB_PID:-}" ]; then
    if [ "$STUB_AS_ROOT" = 1 ]; then
      sudo -n kill "$STUB_PID" 2>/dev/null || true
    else
      kill "$STUB_PID" 2>/dev/null || true
    fi
  fi
  if [ -n "${STUB_LAUNCH_PID:-}" ]; then
    wait "$STUB_LAUNCH_PID" 2>/dev/null || true
  elif [ -n "${STUB_PID:-}" ] && [ "$STUB_AS_ROOT" = 0 ]; then
    wait "$STUB_PID" 2>/dev/null || true
  fi
  if [ -n "${STUB_PID:-}" ]; then
    if [ -f "$WORK/third-party-stub.log" ]; then
      echo "LOCAL_SUITE_BROWSER_STUB requests=$(wc -l < "$WORK/third-party-stub.log" | tr -d ' ')"
    fi
  fi
  [ "${DINAR_SUITE_KEEP_DB:-0}" = 1 ] || node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
const c = new pg.Client({ connectionString: process.argv[1] + '/postgres' });
c.connect().then(() => c.query('DROP DATABASE IF EXISTS \"' + process.argv[2] + '\" WITH (FORCE)')).then(() => c.end()).catch(() => {});
" "$DINAR_LOCAL_PG" "$DB"
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -n "$CHROMIUM" ]; then
  # Keep browser traffic local too: the web app's Google Fonts origin is served by this
  # HTTPS stub, and the wrapper trusts only this one-day certificate's public key.
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=local-suite-third-party" \
    -addext "subjectAltName=DNS:fonts.googleapis.com,DNS:fonts.gstatic.com,DNS:images.unsplash.com$PROVIDER_NAV_SAN" \
    -keyout "$WORK/stub.key" -out "$WORK/stub.crt" >/dev/null 2>&1
  SPKI=$(openssl x509 -in "$WORK/stub.crt" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
  DINAR_ISOLATION_STUB_LOG="$WORK/third-party-stub.log"
  : > "$DINAR_ISOLATION_STUB_LOG"
  NODE_BIN=$(command -v node)
  ENV_BIN=$(command -v env)
  PORT_START=$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || printf '1024')
  case "$PORT_START" in ''|*[!0-9]*) PORT_START=1024 ;; esac
  if [ "$(id -u)" -eq 0 ] || [ "$PORT_START" -le 443 ]; then
    env -i PATH="$PATH" HOME="$WORK" LANG=C.UTF-8 TZ=UTC NODE_OPTIONS= \
      "$NODE_BIN" "$HERE/third-party-stub.mjs" "$WORK/stub.crt" "$WORK/stub.key" 443 "$DINAR_ISOLATION_STUB_LOG" \
      >"$WORK/third-party-stub.stdout.log" 2>&1 &
    STUB_PID=$!
  else
    if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
      echo "LOCAL_SUITE: browser stub needs loopback port 443 or passwordless sudo" >&2
      exit 97
    fi
    STUB_AS_ROOT=1
    STUB_PIDFILE="$WORK/third-party-stub.pid"
    sudo -n sh -c 'printf "%s\n" "$$" > "$1"; shift; exec "$1" -i PATH="$2" HOME="$3" LANG=C.UTF-8 TZ=UTC NODE_OPTIONS= "$4" "$5" "$6" "$7" "$8" "$9"' \
      sh "$STUB_PIDFILE" "$ENV_BIN" "$PATH" "$WORK" "$NODE_BIN" "$HERE/third-party-stub.mjs" \
      "$WORK/stub.crt" "$WORK/stub.key" 443 "$DINAR_ISOLATION_STUB_LOG" \
      >"$WORK/third-party-stub.stdout.log" 2>&1 &
    STUB_LAUNCH_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if [ -s "$STUB_PIDFILE" ]; then STUB_PID=$(cat "$STUB_PIDFILE"); break; fi
      sleep 0.25
    done
  fi
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if grep -q "THIRD_PARTY_STUB: listening" "$WORK/third-party-stub.stdout.log"; then ready=1; break; fi
    kill -0 "$STUB_PID" 2>/dev/null || break
    sleep 0.25
  done
  if [ "$ready" != 1 ]; then
    echo "LOCAL_SUITE: browser third-party stub failed to start" >&2
    cat "$WORK/third-party-stub.stdout.log" >&2
    exit 97
  fi
  REAL_CHROMIUM=$CHROMIUM
  cat > "$WORK/chromium" <<WRAPPER
#!/bin/sh
exec "$REAL_CHROMIUM" --host-resolver-rules="MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1, MAP images.unsplash.com 127.0.0.1$PROVIDER_NAV_MAP" --ignore-certificate-errors-spki-list="$SPKI" "\$@"
WRAPPER
  chmod +x "$WORK/chromium"
  CHROMIUM="$WORK/chromium"
  echo "LOCAL_SUITE_BROWSER_STUB hosts=fonts.googleapis.com,fonts.gstatic.com,images.unsplash.com target=127.0.0.1:443"
fi

if [ "$REUSE_DB" = 1 ]; then
  echo "LOCAL_SUITE_MIGRATIONS reused=1 database=$DB"
elif [ "$RELEASE_MIGRATIONS" = 1 ]; then
  env -i PATH="$PATH" HOME="$WORK" LANG=C.UTF-8 TZ=UTC NODE_ENV=development \
    DATABASE_URL="$URL" DINAR_MIGRATION_TARGET=disposable \
    DINAR_MIGRATION_EXPECTED_DATABASE="$DB" \
    DINAR_ISOLATION_NET_LOG="$NETLOG" NODE_OPTIONS="--import=file://$HERE/net-guard.mjs" \
    node --experimental-strip-types "$REPO/lib/db/scripts/migrate-release.mjs"
else
  (cd "$REPO/lib/db" && base node_modules/.bin/drizzle-kit migrate --config ./drizzle.config.ts >/dev/null)
fi
cd "$API"
case "${DINAR_SUITE_SEED:-fixtures}" in
  fixtures) base BDINAR_ACCEPTANCE_FIXTURES=development \
    BDINAR_ACCEPTANCE_FIXTURE_MODULES=MARKET_FIXTURES,USER_FIXTURES,PRODUCT_LISTINGS,PHASE1_LISTINGS \
    node test/run.mjs acceptance-fixtures.seed >/dev/null ;;
  development) base BDINAR_SEED=development node test/run.mjs seed >/dev/null ;;
  none) ;;
  *) echo "LOCAL_SUITE: DINAR_SUITE_SEED must be fixtures, development or none" >&2; exit 96 ;;
esac

# Migration and fixture loading are also behind net-guard; do not let attempts in the prelude
# disappear when per-suite counters start.
prelude_attempts=$(wc -l < "$NETLOG" | tr -d ' ')
if [ "$prelude_attempts" != 0 ]; then
  echo "LOCAL_SUITE_NET: FAIL — migration/seed made $prelude_attempts outbound attempt(s):" >&2
  cat "$NETLOG" >&2
  exit 98
fi
echo "LOCAL_SUITE_PRELUDE exit=0 outbound=0"

status=0
first_failed=""
prev_suite=""
# shellcheck disable=SC2086  # $SUITES is word-split intentionally; every name passed the charset check.
for SUITE in $SUITES; do
  if [ -n "$prev_suite" ]; then
    cleared=$(clear_auth_throttle_state) || { echo "LOCAL_SUITE: auth throttle reset failed ($cleared)" >&2; exit 91; }
    echo "LOCAL_SUITE_THROTTLE_RESET after=$prev_suite before=$SUITE $cleared"
  fi
  prev_suite=$SUITE
  before=$(wc -l < "$NETLOG" | tr -d ' ')
  suite_status=0
  run node test/run.mjs "$SUITE" || suite_status=$?
  total=$(wc -l < "$NETLOG" | tr -d ' ')
  outbound=$((total - before))
  if [ "$outbound" != 0 ]; then
    echo "LOCAL_SUITE_NET: FAIL — suite $SUITE made $outbound outbound attempt(s):" >&2
    tail -n "$outbound" "$NETLOG" >&2
    [ "$suite_status" -eq 0 ] && suite_status=98
  fi
  echo "LOCAL_SUITE suite=$SUITE db=$DB exit=$suite_status outbound=$outbound"
  # Continue to expose independent later outcomes on the mutated shared database.
  if [ "$suite_status" != 0 ] && [ -z "$first_failed" ]; then
    status=$suite_status
    first_failed=$SUITE
  fi
done
echo "LOCAL_SUITE_CHAIN suites=$(printf '%s' "$SUITES" | wc -w) db=$DB exit=$status first_failed=${first_failed:-none}"
exit "$status"
