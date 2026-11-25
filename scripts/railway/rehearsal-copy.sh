#!/usr/bin/env bash
# JassimAI — one-time copy of the live site's database and files into Production.
# Runs in the `staging` environment (the only place that can reach the live database and bucket
# privately). The live database is read under a read-only session; the live bucket is only listed
# and read. The destination must be the EMPTY production database `jassimai_production`.
set -euo pipefail
fail() { echo "COPY_REFUSED $*" >&2; exit 1; }
for v in SRC_DATABASE_URL DST_DATABASE_URL SRC_BUCKET SRC_ENDPOINT SRC_REGION SRC_ACCESS_KEY_ID SRC_SECRET_ACCESS_KEY DST_BUCKET DST_ENDPOINT DST_REGION DST_ACCESS_KEY_ID DST_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || fail "missing $v"
done
urlhost() { echo "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'; }
urldb() { echo "$1" | sed -E 's#^[a-z]+://[^/]+/([^?]+).*#\1#'; }
[ "$(urlhost "$SRC_DATABASE_URL")" = "dinar-staging-postgres-ams.railway.internal" ] || fail "source host"
[ "$(urldb "$SRC_DATABASE_URL")" = "dinar_staging" ] || fail "source database"
[ "$(urldb "$DST_DATABASE_URL")" = "jassimai_production" ] || fail "destination database"
case "$(urlhost "$DST_DATABASE_URL")" in *.proxy.rlwy.net) ;; *) fail "destination host" ;; esac
[ "$SRC_BUCKET" != "$DST_BUCKET" ] || fail "same bucket"

RO="-c default_transaction_read_only=on"
dst_tables=$(psql "$DST_DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema in ('public','drizzle')")
[ "$dst_tables" = 0 ] || fail "destination not empty ($dst_tables tables)"

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
PGOPTIONS="$RO" pg_dump --format=custom --no-owner --no-privileges --file "$work/db.dump" "$SRC_DATABASE_URL"
echo "DUMP bytes=$(stat -c %s "$work/db.dump") sha256=$(sha256sum "$work/db.dump" | cut -d' ' -f1)"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$DST_DATABASE_URL" "$work/db.dump"

counts() { # exact row count of every table, sorted
  local url=$1 opts=$2
  PGOPTIONS="$opts" psql "$url" -Atc "select format('select %L || ''='' || count(*) from %I.%I', table_schema||'.'||table_name, table_schema, table_name) from information_schema.tables where table_type='BASE TABLE' and table_schema in ('public','drizzle') order by 1" \
    | while read -r q; do PGOPTIONS="$opts" psql "$url" -Atc "$q"; done
}
counts "$SRC_DATABASE_URL" "$RO" > "$work/src.counts"
counts "$DST_DATABASE_URL" "" > "$work/dst.counts"
if ! diff -q "$work/src.counts" "$work/dst.counts" >/dev/null; then diff "$work/src.counts" "$work/dst.counts" | head -20; fail "row counts differ"; fi
echo "DB_COPY_OK tables=$(wc -l < "$work/src.counts") rows=$(awk -F= '{s+=$2} END {print s}' "$work/src.counts")"

apt-get update -qq >/dev/null && apt-get install -y -qq rclone ca-certificates >/dev/null
export RCLONE_CONFIG_SRC_TYPE=s3 RCLONE_CONFIG_SRC_PROVIDER=Other RCLONE_CONFIG_SRC_ENDPOINT="$SRC_ENDPOINT" RCLONE_CONFIG_SRC_REGION="$SRC_REGION" \
  RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$SRC_ACCESS_KEY_ID" RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$SRC_SECRET_ACCESS_KEY" RCLONE_CONFIG_SRC_FORCE_PATH_STYLE=false \
  RCLONE_CONFIG_DST_TYPE=s3 RCLONE_CONFIG_DST_PROVIDER=Other RCLONE_CONFIG_DST_ENDPOINT="$DST_ENDPOINT" RCLONE_CONFIG_DST_REGION="$DST_REGION" \
  RCLONE_CONFIG_DST_ACCESS_KEY_ID="$DST_ACCESS_KEY_ID" RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$DST_SECRET_ACCESS_KEY" RCLONE_CONFIG_DST_FORCE_PATH_STYLE=false
# Only application files; the live site's own backups stay where they are.
rclone copy "src:$SRC_BUCKET" "dst:$DST_BUCKET" --exclude "backups/**" --checksum --transfers 8 --stats-one-line --stats 0
rclone check "src:$SRC_BUCKET" "dst:$DST_BUCKET" --exclude "backups/**" --one-way --download
echo "FILES_COPY_OK objects=$(rclone size "dst:$DST_BUCKET" --exclude 'backups/**' --json | sed -E 's/.*"count":([0-9]+).*/\1/')"
echo "COPY_OK"
