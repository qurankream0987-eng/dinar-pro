#!/bin/sh
# Bootstrap one authorized synthetic market, then run any requested acceptance suites against the
# same fresh database. The underlying local-suite runner drops the complete database on exit.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DB=${DINAR_SUITE_DB:-dinar_test_legal_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')}
case "$DB" in dinar_test_legal_*) SUFFIX=${DB#dinar_test_legal_} ;; *)
  echo "LEGAL_MARKET_SUITE: refusing non-test database name $DB" >&2; exit 96 ;; esac
case "$SUFFIX" in ""|*[!a-zA-Z0-9_]*)
  echo "LEGAL_MARKET_SUITE: invalid database name $DB" >&2; exit 96 ;;
esac
export DINAR_SUITE_DB="$DB"
export DINAR_SUITE_SEED=none
export DINAR_SUITE_KEEP_DB=0
exec "$HERE/local-suite.sh" \
  market-legal-acceptance.test "$@" \
  BDINAR_MARKET_LEGAL_ACCEPTANCE=development \
  DINAR_MARKET_LEGAL_TEST_FIXTURE=1
