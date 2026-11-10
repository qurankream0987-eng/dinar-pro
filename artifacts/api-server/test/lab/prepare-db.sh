#!/bin/sh
# Create, migrate and seed one disposable loopback database for the DeepSeek lab.
#   DINAR_LOCAL_PG=postgres://dinar_isolation@127.0.0.1:55432 test/lab/prepare-db.sh dinar_test_lab_<suffix>
# Prints the seed password file path; the database is dropped by: dropdb (manual) or a new name.
set -eu
DB=${1:?database name}
case "$DB" in dinar_test_lab_*) ;; *) echo "lab databases must be named dinar_test_lab_*" >&2; exit 2 ;; esac
case "${DINAR_LOCAL_PG:?}" in postgres://*@127.0.0.1:*|postgresql://*@127.0.0.1:*) ;; *) echo "loopback only" >&2; exit 2 ;; esac
HERE=$(cd "$(dirname "$0")/.." && pwd); API=$(cd "$HERE/.." && pwd); REPO=$(cd "$API/../.." && pwd)
URL="$DINAR_LOCAL_PG/$DB"
node -e "const pg=require('$REPO/lib/db/node_modules/pg');const c=new pg.Client({connectionString:process.argv[1]+'/postgres'});c.connect().then(()=>c.query('CREATE DATABASE '+process.argv[2])).then(()=>c.end())" "$DINAR_LOCAL_PG" "$DB"
SEEDPW=${LAB_SEED_PASSWORD:-lab-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')}
base() {
  env -i PATH="$PATH" HOME="${TMPDIR:-/tmp}" LANG=C.UTF-8 TZ=UTC NODE_ENV=development \
    DATABASE_URL="$URL" DINAR_DEV_DATABASE_URL="$URL" BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 BDINAR_DISPOSABLE_TEST_DATABASE=1 \
    SESSION_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n') BDINAR_SEED_PASSWORD="$SEEDPW" "$@"
}
(cd "$REPO/lib/db" && base node_modules/.bin/drizzle-kit migrate --config ./drizzle.config.ts >/dev/null)
cd "$API"
base BDINAR_SEED=development node test/run.mjs seed >/dev/null
base BDINAR_SEED=development node test/run.mjs lab-fixtures.seed
echo "LAB_DB=$DB"
echo "LAB_SEED_PASSWORD=$SEEDPW"
