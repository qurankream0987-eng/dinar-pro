#!/usr/bin/env bash
# JassimAI transfer — PRODUCTION side (runs only in Railway's `production` environment).
# Reads the live database as the temporary SELECT-only role `jassimai_copy_ro` through a temporary
# TCP proxy, and the live files through the presigned read-only links in `jassimai_transfer.manifest`
# (made by transfer-grant.sh). Writes ONLY to the empty `jassimai_production` database (private
# network) and to the empty Production bucket. No live bucket key is ever present here.
# Verifies: exact row count of every table on both sides; sha256 of every file after download AND
# after a fresh re-download from the Production bucket. Secrets and links are never printed.
set -euo pipefail
set +x
fail() { echo "COPY_REFUSED $*" >&2; exit 1; }

ROLE=jassimai_copy_ro
for v in SRC_PROXY_HOST SRC_PROXY_PORT SRC_PASSWORD DST_DATABASE_URL DST_BUCKET DST_EXPECTED_BUCKET DST_ENDPOINT DST_REGION DST_ACCESS_KEY_ID DST_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || fail "missing $v"
done
[ "${RAILWAY_ENVIRONMENT_NAME:-}" = production ] || fail "environment is not production"
urlhost() { echo "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'; }
urldb() { echo "$1" | sed -E 's#^[a-z]+://[^/]+/([^?]+).*#\1#'; }

# --- Guards on addresses alone, before any connection is opened ---
[ "$(urlhost "$DST_DATABASE_URL")" = "${DST_EXPECTED_HOST:-jassimai-production-postgres.railway.internal}" ] || fail "destination host"
[ "$(urldb "$DST_DATABASE_URL")" = jassimai_production ] || fail "destination database"
case "$SRC_PROXY_HOST" in *.proxy.rlwy.net) ;; *) fail "source host is not a Railway TCP proxy" ;; esac
[[ "$SRC_PROXY_PORT" =~ ^[0-9]+$ ]] || fail "source port"
[[ "$SRC_PASSWORD" =~ ^[A-Za-z0-9]{32,}$ ]] || fail "source password format"
[ "$DST_BUCKET" = "$DST_EXPECTED_BUCKET" ] || fail "destination bucket is not the expected Production bucket"
case "$DST_BUCKET" in dinar-staging-*) fail "destination bucket is the live bucket" ;; esac

export PGSSLMODE="${SRC_SSLMODE:-require}"
SRC_URL="postgresql://$ROLE:$SRC_PASSWORD@$SRC_PROXY_HOST:$SRC_PROXY_PORT/dinar_staging"
MAN_URL="postgresql://$ROLE:$SRC_PASSWORD@$SRC_PROXY_HOST:$SRC_PROXY_PORT/jassimai_transfer"
RO="-c default_transaction_read_only=on"
sq() { PGOPTIONS="$RO" psql "$1" -X -v ON_ERROR_STOP=1 -qAt "${@:2}"; }
dq() { PGSSLMODE=prefer psql "$DST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAt "$@"; }

# --- Source: prove it is the live database, as the temporary role, and that it can change nothing ---
[ "$(sq "$SRC_URL" -c "select current_user || '/' || current_database()")" = "$ROLE/dinar_staging" ] || fail "source identity"
[ "$(sq "$SRC_URL" -c 'select rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls from pg_roles where rolname = current_user')" = f ] || fail "source role is privileged"
writable=$(sq "$SRC_URL" -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','drizzle') and has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')")
[ "$writable" = 0 ] || fail "source role can write $writable tables"
[ "$(sq "$SRC_URL" -c "select has_database_privilege(current_database(),'CREATE') or has_schema_privilege('public','CREATE') or has_schema_privilege('drizzle','CREATE')")" = f ] || fail "source role can create objects"
if PGOPTIONS="$RO" psql "$SRC_URL" -X -qAt -c 'create temp table jassimai_write_probe(x int)' >/dev/null 2>&1; then fail "source session accepted a write"; fi

# --- Destination: prove it is the empty Production database ---
[ "$(dq -c 'select current_database()')" = jassimai_production ] || fail "destination identity"
dst_tables=$(dq -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")
[ "$dst_tables" = 0 ] || fail "destination not empty ($dst_tables tables)"

command -v rclone >/dev/null || { apt-get update -qq >/dev/null && apt-get install -y -qq rclone ca-certificates curl >/dev/null; }
export RCLONE_CONFIG_DST_TYPE=s3 RCLONE_CONFIG_DST_PROVIDER=Other RCLONE_CONFIG_DST_ENDPOINT="$DST_ENDPOINT" RCLONE_CONFIG_DST_REGION="$DST_REGION" \
  RCLONE_CONFIG_DST_ACCESS_KEY_ID="$DST_ACCESS_KEY_ID" RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$DST_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_DST_FORCE_PATH_STYLE="${DST_FORCE_PATH_STYLE:-false}"
dst_objects=$(rclone lsf -R --files-only "dst:$DST_BUCKET" | wc -l)
[ "$dst_objects" = 0 ] || fail "destination bucket not empty ($dst_objects objects)"
[ "${TRANSFER_PREFLIGHT_ONLY:-0}" = 1 ] && { echo "PREFLIGHT_OK source=read-only destination=empty"; exit 0; }

# --- Database ---
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
PGOPTIONS="$RO" pg_dump --format=custom --no-owner --no-privileges --file "$work/db.dump" "$SRC_URL"
echo "DUMP bytes=$(stat -c %s "$work/db.dump") sha256=$(sha256sum "$work/db.dump" | cut -d' ' -f1)"
PGSSLMODE=prefer pg_restore --no-owner --no-privileges --exit-on-error --dbname "$DST_DATABASE_URL" "$work/db.dump"
counts() { # exact row count of every table, sorted: <runner> <url>
  "$1" "$2" -c "select format('select %L || ''='' || count(*) from %I.%I', table_schema||'.'||table_name, table_schema, table_name) from information_schema.tables where table_type='BASE TABLE' and table_schema in ('public','drizzle') order by 1" \
    | while read -r stmt; do "$1" "$2" -c "$stmt"; done
}
dqu() { PGSSLMODE=prefer psql "$1" -X -v ON_ERROR_STOP=1 -qAt "${@:2}"; }
counts sq "$SRC_URL" > "$work/src.counts"
counts dqu "$DST_DATABASE_URL" > "$work/dst.counts"
if ! diff -q "$work/src.counts" "$work/dst.counts" >/dev/null; then diff "$work/src.counts" "$work/dst.counts" | head -20; fail "row counts differ"; fi
echo "DB_COPY_OK tables=$(wc -l < "$work/src.counts") rows=$(awk -F= '{s+=$2} END {print s+0}' "$work/src.counts")"

# --- Files (presigned read-only links; each checked by sha256) ---
sq "$MAN_URL" -F $'\t' -c 'select key, bytes, sha256, url from manifest order by key' > "$work/manifest.tsv"
n=0
while IFS=$'\t' read -r key bytes sum url; do
  curl -fsS --retry 3 -o "$work/f" "$url" 2>/dev/null || fail "download failed for one file"
  [ "$(sha256sum "$work/f" | cut -d' ' -f1)" = "$sum" ] || fail "sha256 mismatch after download: $key"
  [ "$(stat -c %s "$work/f")" = "$bytes" ] || fail "size mismatch: $key"
  rclone copyto "$work/f" "dst:$DST_BUCKET/$key"
  n=$((n+1))
done < "$work/manifest.tsv"
# Independent check: re-download everything from the Production bucket and compare with the manifest.
cut -f1,3 "$work/manifest.tsv" | awk -F'\t' '{print $2"  "$1}' | sort > "$work/want"
rclone hashsum sha256 --download "dst:$DST_BUCKET" | sort > "$work/got"
diff -q "$work/want" "$work/got" >/dev/null || { diff "$work/want" "$work/got" | sed -E 's/^([<>] )[0-9a-f]{64}  /\1/' | head -20; fail "Production bucket differs from the manifest"; }
echo "FILES_COPY_OK files=$n sha256=verified-after-redownload"
echo "COPY_OK"
