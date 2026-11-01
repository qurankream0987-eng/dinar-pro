#!/bin/sh
# Runs test/run.mjs suites against a fresh database on an existing LOOPBACK PostgreSQL server,
# for hosts where sandbox.sh cannot run (root containers, no user namespaces, no PostgreSQL 18).
# Weaker than sandbox.sh: there is no network namespace; isolation is a clean environment
# (env -i) plus the net-guard preload, which refuses and records every non-loopback attempt.
#
#   DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh <suite.test> [more.test ...] [VAR=value ...]
#
# Several suites may be named: they then share ONE migrated and seeded database and run in the
# order given. That is what makes a combined chain prove subsystem coexistence, which isolated
# per-suite runs never do. The exit code is the first failing suite's (98 for any outbound attempt).
#
# Optional: DINAR_SUITE_DB (default dinar_test_local_<random>), DINAR_SUITE_SEED
# (fixtures|development|none, default fixtures), DINAR_SUITE_KEEP_DB=1, DINAR_CHROMIUM.
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
URL="$DINAR_LOCAL_PG/$DB"

SUITES=""
EXTRA=""
for arg in "$@"; do
  case "$arg" in
    BDINAR_*=*|DINAR_*=*)
      case "${arg%%=*}" in *KEY*|*SECRET*|*TOKEN*|*PASSWORD*|*DATABASE_URL*)
        echo "LOCAL_SUITE: refusing credential-like variable ${arg%%=*}" >&2; exit 96 ;; esac
      EXTRA="$EXTRA $arg" ;;
    **=**)
      echo "LOCAL_SUITE: switch must be a BDINAR_*/DINAR_* allowlisted variable ($arg)" >&2; exit 96 ;;
    *)
      # A suite name is a bare *.test token; anything else is refused rather than interpolated.
      case "$arg" in *[!a-zA-Z0-9._-]*)
        echo "LOCAL_SUITE: invalid suite name ($arg)" >&2; exit 96 ;; esac
      case "$arg" in *.test) SUITES="$SUITES $arg" ;;
        *) echo "LOCAL_SUITE: suite arguments must end in .test ($arg)" >&2; exit 96 ;; esac ;;
  esac
done
[ -n "$SUITES" ] || { echo "usage: local-suite.sh <suite.test> [more.test ...] [VAR=value ...]" >&2; exit 96; }

node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
const c = new pg.Client({ connectionString: process.argv[1] + '/postgres' });
c.connect().then(() => c.query('DROP DATABASE IF EXISTS \"' + process.argv[2] + '\"')).then(() => c.query('CREATE DATABASE \"' + process.argv[2] + '\"')).then(() => c.end()).catch((e) => { console.error(e.message); process.exit(90); });
" "$DINAR_LOCAL_PG" "$DB"

WORK=$(mktemp -d)
NETLOG="$WORK/net-attempts.log"
: > "$NETLOG"
SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
SEEDPW=seed-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
CHROMIUM=${DINAR_CHROMIUM:-}
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
# The auth throttle is an IP-keyed fixed-window counter that lives in the database. A standalone
# run always started it empty (fresh database); a chained suite would otherwise inherit its
# siblings' counts and fail on 429 for reasons that have nothing to do with the subsystems under
# test. Only the throwaway chain database is cleared, and only between suites — the product gate,
# its window and its limit are untouched.
clear_auth_throttle_state() {
  node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
const c = new pg.Client({ connectionString: process.argv[1] });
c.connect().then(() => c.query('DELETE FROM auth_rate_limit_buckets RETURNING key_hash')).then((r) => c.end().then(() => console.log('rows=' + r.rowCount))).catch((e) => { console.error(e.message); process.exit(91); });
" "$URL"
}
cleanup() {
  [ "${DINAR_SUITE_KEEP_DB:-0}" = 1 ] || node -e "
const pg = require('$REPO/lib/db/node_modules/pg');
const c = new pg.Client({ connectionString: process.argv[1] + '/postgres' });
c.connect().then(() => c.query('DROP DATABASE IF EXISTS \"' + process.argv[2] + '\" WITH (FORCE)')).then(() => c.end()).catch(() => {});
" "$DINAR_LOCAL_PG" "$DB"
  rm -rf "$WORK"
}
trap cleanup EXIT

(cd "$REPO/lib/db" && base node_modules/.bin/drizzle-kit migrate --config ./drizzle.config.ts >/dev/null)
cd "$API"
case "${DINAR_SUITE_SEED:-fixtures}" in
  fixtures) base BDINAR_ACCEPTANCE_FIXTURES=development \
    BDINAR_ACCEPTANCE_FIXTURE_MODULES=MARKET_FIXTURES,USER_FIXTURES,PRODUCT_LISTINGS,PHASE1_LISTINGS \
    node test/run.mjs acceptance-fixtures.seed >/dev/null ;;
  development) base BDINAR_SEED=development node test/run.mjs seed >/dev/null ;;
  none) ;;
  *) echo "LOCAL_SUITE: DINAR_SUITE_SEED must be fixtures, development or none" >&2; exit 96 ;;
esac

status=0
first_failed=""
prev_suite=""
# shellcheck disable=SC2086  # $SUITES is word-split on purpose; every name passed the charset check.
for SUITE in $SUITES; do
  if [ -n "$prev_suite" ]; then
    cleared=$(clear_auth_throttle_state) || { echo "LOCAL_SUITE: the auth throttle could not be cleared ($cleared)" >&2; exit 91; }
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
  # The chain continues after a failure: which later suites still pass on the same mutated database
  # is the coexistence evidence, and a rerun per suite would cost a full migrate+seed each time.
  if [ "$suite_status" != 0 ] && [ -z "$first_failed" ]; then
    status=$suite_status
    first_failed=$SUITE
  fi
done
echo "LOCAL_SUITE_CHAIN suites=$(printf '%s' "$SUITES" | wc -w) db=$DB exit=$status first_failed=${first_failed:-none}"
exit "$status"
