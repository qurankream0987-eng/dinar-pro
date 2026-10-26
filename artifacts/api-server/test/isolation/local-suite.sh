#!/bin/sh
# Runs one test/run.mjs suite against a fresh database on an existing LOOPBACK PostgreSQL server,
# for hosts where sandbox.sh cannot run (root containers, no user namespaces, no PostgreSQL 18).
# Weaker than sandbox.sh: there is no network namespace; isolation is a clean environment
# (env -i) plus the net-guard preload, which refuses and records every non-loopback attempt.
#
#   DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh <suite> [VAR=value ...]
#
# Optional: DINAR_SUITE_DB (default dinar_test_local_<random>), DINAR_SUITE_SEED
# (fixtures|development|none, default fixtures), DINAR_SUITE_KEEP_DB=1, DINAR_CHROMIUM.
# Extra VAR=value arguments must be BDINAR_*/DINAR_* switches; credentials are refused.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
API=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$API/../.." && pwd)
SUITE=${1:?usage: local-suite.sh <suite> [VAR=value ...]}
shift

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

EXTRA=""
for pair in "$@"; do
  case "$pair" in
    BDINAR_*=*|DINAR_*=*) ;;
    *) echo "LOCAL_SUITE: only BDINAR_*/DINAR_* switches may be passed ($pair)" >&2; exit 96 ;;
  esac
  case "${pair%%=*}" in *KEY*|*SECRET*|*TOKEN*|*PASSWORD*|*DATABASE_URL*)
    echo "LOCAL_SUITE: refusing credential-like variable ${pair%%=*}" >&2; exit 96 ;; esac
  EXTRA="$EXTRA $pair"
done

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
# shellcheck disable=SC2086
run() {
  env -i PATH="$PATH" HOME="$WORK" LANG=C.UTF-8 TZ=UTC NODE_ENV=development \
    DATABASE_URL="$URL" DINAR_DEV_DATABASE_URL="$URL" \
    BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 BDINAR_DISPOSABLE_TEST_DATABASE=1 \
    SESSION_SECRET="$SECRET" BDINAR_SEED_PASSWORD="$SEEDPW" \
    ${CHROMIUM:+REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM" CHROMIUM_PATH="$CHROMIUM"} \
    DINAR_ISOLATION_NET_LOG="$NETLOG" NODE_OPTIONS="--import=file://$HERE/net-guard.mjs" \
    $EXTRA "$@"
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

(cd "$REPO/lib/db" && run node_modules/.bin/drizzle-kit migrate --config ./drizzle.config.ts >/dev/null)
cd "$API"
case "${DINAR_SUITE_SEED:-fixtures}" in
  fixtures) run BDINAR_ACCEPTANCE_FIXTURES=development \
    BDINAR_ACCEPTANCE_FIXTURE_MODULES=MARKET_FIXTURES,USER_FIXTURES,PRODUCT_LISTINGS,PHASE1_LISTINGS \
    node test/run.mjs acceptance-fixtures.seed >/dev/null ;;
  development) run BDINAR_SEED=development node test/run.mjs seed >/dev/null ;;
  none) ;;
  *) echo "LOCAL_SUITE: DINAR_SUITE_SEED must be fixtures, development or none" >&2; exit 96 ;;
esac

status=0
run node test/run.mjs "$SUITE" || status=$?
attempts=$(wc -l < "$NETLOG" | tr -d ' ')
if [ "$attempts" != 0 ]; then
  echo "LOCAL_SUITE_NET: FAIL — $attempts outbound attempts:" >&2
  cat "$NETLOG" >&2
  [ "$status" -eq 0 ] && status=98
fi
echo "LOCAL_SUITE suite=$SUITE db=$DB exit=$status outbound=$attempts"
exit "$status"
