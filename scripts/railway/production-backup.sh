#!/usr/bin/env bash
# JassimAI Production — logical PostgreSQL backup with verified restore.
# PROPOSED FOR REVIEW. Not deployed. Runs only in Railway's `production` environment.
#
# Modes (BACKUP_MODE):
#   backup          pg_dump -> upload to the dedicated backup bucket -> re-download and compare sha256
#   restore-test    download the newest dump -> restore into a throwaway database on the separate
#                   restore-test server -> compare table and migration counts -> drop it
#
# Isolation guarantees (each one refuses before anything is read or written):
#   - the source host must be exactly BACKUP_EXPECTED_HOST (a *.railway.internal name; Railway's
#     private network is per environment, so Acceptance and the public staging database are unreachable);
#   - the source database must be exactly BACKUP_EXPECTED_DATABASE (jassimai_production) on PostgreSQL 18+;
#   - the bucket must be exactly BACKUP_EXPECTED_BUCKET_PREFIX* (the dedicated backup bucket, never the
#     application's file bucket);
#   - restore-test never writes to the production server: RESTORE_DATABASE_URL must point at a
#     different host and the throwaway name must start with jassimai_restore_verify_.
set -euo pipefail

fail() { echo "BACKUP_REFUSED $*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || fail "missing $1"; }
for v in BACKUP_MODE DATABASE_URL BACKUP_EXPECTED_HOST BACKUP_EXPECTED_DATABASE BUCKET ENDPOINT REGION ACCESS_KEY_ID SECRET_ACCESS_KEY BACKUP_EXPECTED_BUCKET_PREFIX; do need "$v"; done

urlhost() { echo "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'; }
host=$(urlhost "$DATABASE_URL")
# Refuse on the address alone, before any connection is opened.
[ "$host" = "$BACKUP_EXPECTED_HOST" ] || fail "host"
case "$host" in *.railway.internal) ;; *) fail "host not private" ;; esac
case "$BUCKET" in "$BACKUP_EXPECTED_BUCKET_PREFIX"*) ;; *) fail "bucket" ;; esac
db=$(psql "$DATABASE_URL" -Atc 'select current_database()')
ver=$(psql "$DATABASE_URL" -Atc 'show server_version_num')
[ "$db" = "$BACKUP_EXPECTED_DATABASE" ] || fail "database"
[ "$ver" -ge 180000 ] || fail "server version"

endpoint=${ENDPOINT%/}
s3() { # method key [file] — SigV4 via curl, virtual-hosted style (Railway buckets)
  local method=$1 key=$2 file=${3:-}
  local url="${endpoint/https:\/\//https://$BUCKET.}/$key"
  if [ "$method" = PUT ]; then
    curl -fsS --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" -X PUT -H 'Content-Type: application/octet-stream' --upload-file "$file" "$url" >/dev/null
  elif [ "$method" = GET ]; then
    curl -fsS --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" -o "$file" "$url"
  else
    curl -fsS --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" "$url"
  fi
}
list() { curl -fsS --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" "${endpoint/https:\/\//https://$BUCKET.}/?list-type=2&prefix=$1" | grep -oE '<Key>[^<]+</Key>' | sed -E 's#</?Key>##g' | sort; }

counts() { psql "$1" -Atc "select (select count(*) from information_schema.tables where table_schema='public'), (select count(*) from drizzle.__drizzle_migrations)"; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
ts=$(date -u +%Y%m%dT%H%M%SZ)

if [ "$BACKUP_MODE" = backup ]; then
  key="daily/$(date -u +%Y/%m/%d)/jassimai_production-$ts.dump"
  pg_dump --format=custom --no-owner --no-privileges --file "$work/db.dump" "$DATABASE_URL"
  sum=$(sha256sum "$work/db.dump" | cut -d' ' -f1)
  printf '%s  %s\n' "$sum" "$(basename "$key")" > "$work/db.sha256"
  echo "$(counts "$DATABASE_URL")" > "$work/db.counts"
  s3 PUT "$key" "$work/db.dump"; s3 PUT "$key.sha256" "$work/db.sha256"; s3 PUT "$key.counts" "$work/db.counts"
  s3 GET "$key" "$work/check.dump"
  [ "$(sha256sum "$work/check.dump" | cut -d' ' -f1)" = "$sum" ] || fail "re-download sha256 mismatch"
  # Anonymous access must be refused (Railway buckets are private).
  code=$(curl -s -o /dev/null -w '%{http_code}' "${endpoint/https:\/\//https://$BUCKET.}/$key")
  [ "$code" = 403 ] || [ "$code" = 401 ] || fail "bucket readable anonymously ($code)"
  echo "BACKUP_OK key=$key sha256=$sum counts=$(cat "$work/db.counts")"
  # Retention: daily dumps kept 35 days; the first dump of each month kept 12 months.
  cutoff=$(date -u -d '35 days ago' +%Y/%m/%d); keepmonths=$(date -u -d '365 days ago' +%Y/%m)
  for old in $(list daily/); do
    day=$(echo "$old" | cut -d/ -f2-4); [ "$day" \< "$cutoff" ] || continue
    month=$(echo "$old" | cut -d/ -f2-3); first=$(list "daily/$month/" | grep '\.dump$' | head -1)
    if [ "$old" = "$first" ] || [ "${old%.sha256}" = "$first" ] || [ "${old%.counts}" = "$first" ]; then [ "$month" \< "$keepmonths" ] || continue; fi
    curl -fsS --aws-sigv4 "aws:amz:$REGION:s3" --user "$ACCESS_KEY_ID:$SECRET_ACCESS_KEY" -X DELETE "${endpoint/https:\/\//https://$BUCKET.}/$old" >/dev/null
  done
elif [ "$BACKUP_MODE" = restore-test ]; then
  need RESTORE_DATABASE_URL
  rhost=$(urlhost "$RESTORE_DATABASE_URL")
  [ "$rhost" != "$host" ] || fail "restore target is the production server"
  case "$rhost" in *.railway.internal) ;; *) fail "restore host not private" ;; esac
  key=$(list daily/ | grep '\.dump$' | tail -1); [ -n "$key" ] || fail "no backup found"
  s3 GET "$key" "$work/db.dump"; s3 GET "$key.sha256" "$work/db.sha256"; s3 GET "$key.counts" "$work/db.counts"
  [ "$(sha256sum "$work/db.dump" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$work/db.sha256")" ] || fail "sha256 mismatch"
  name="jassimai_restore_verify_$(date -u +%Y%m%d%H%M%S)"
  psql "$RESTORE_DATABASE_URL" -c "create database $name"
  target=$(echo "$RESTORE_DATABASE_URL" | sed -E "s#^([a-z]+://[^/]+)/[^?]*#\1/$name#")
  pg_restore --no-owner --no-privileges --dbname "$target" "$work/db.dump"
  got=$(counts "$target"); want=$(cat "$work/db.counts")
  psql "$RESTORE_DATABASE_URL" -c "drop database $name"
  [ "$got" = "$want" ] || fail "restored counts $got differ from backup $want"
  echo "RESTORE_TEST_OK key=$key counts=$got"
else
  fail "unknown BACKUP_MODE"
fi
