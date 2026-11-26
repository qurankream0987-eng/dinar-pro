#!/usr/bin/env bash
# JassimAI transfer — LIVE side (runs only in Railway's `staging` environment).
#
# TRANSFER_MODE=grant
#   1. creates the temporary login role `jassimai_copy_ro`: SELECT on the tables and sequences of the
#      `public` and `drizzle` schemas of `dinar_staging` only; no superuser, no create, no replication,
#      at most 2 connections, read-only by default, and the login expires on its own after 3 hours;
#   2. creates a separate temporary database `jassimai_transfer` (never the live database) holding one
#      table `manifest`: for every application file (backups/** excluded) its key, size, sha256 and a
#      presigned read-only URL for that one object, expiring after 2 hours. The live bucket keys never
#      leave this job; nothing is written to the live database or the live bucket.
# TRANSFER_MODE=revoke
#   removes every grant, drops `jassimai_transfer`, drops the role. Safe to run more than once.
#
# The role password comes from COPY_RO_PASSWORD (a Railway-generated variable); it is never printed.
# Presigned URLs are written only into the manifest table, never to the log.
set -euo pipefail
set +x
fail() { echo "GRANT_REFUSED $*" >&2; exit 1; }

ROLE=jassimai_copy_ro
XDB=jassimai_transfer
SRC_DB=dinar_staging
SRC_HOST=dinar-staging-postgres-ams.railway.internal

for v in TRANSFER_MODE ADMIN_DATABASE_URL; do [ -n "${!v:-}" ] || fail "missing $v"; done
[ "${RAILWAY_ENVIRONMENT_NAME:-}" = staging ] || fail "environment is not staging"
urlhost() { echo "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'; }
urldb() { echo "$1" | sed -E 's#^[a-z]+://[^/]+/([^?]+).*#\1#'; }
withdb() { echo "$ADMIN_DATABASE_URL" | sed -E "s#^([a-z]+://[^/]+)/[^?]*#\1/$1#"; }
# Refuse on the address alone, before any connection is opened.
[ "$(urlhost "$ADMIN_DATABASE_URL")" = "$SRC_HOST" ] || fail "host"
[ "$(urldb "$ADMIN_DATABASE_URL")" = "$SRC_DB" ] || fail "database"
SRC_URL=$(withdb "$SRC_DB"); XDB_URL=$(withdb "$XDB"); PG_URL=$(withdb postgres)
q() { psql "$1" -X -v ON_ERROR_STOP=1 -qAt "${@:2}"; }
[ "$(q "$SRC_URL" -c 'select current_database()')" = "$SRC_DB" ] || fail "connected database"

if [ "$TRANSFER_MODE" = revoke ]; then
  q "$PG_URL" -c "drop database if exists $XDB with (force)"
  if [ "$(q "$PG_URL" -c "select count(*) from pg_roles where rolname='$ROLE'")" = 1 ]; then
    q "$SRC_URL" <<SQL
revoke select on all tables in schema public, drizzle from $ROLE;
revoke select on all sequences in schema public, drizzle from $ROLE;
revoke usage on schema public, drizzle from $ROLE;
revoke connect on database $SRC_DB from $ROLE;
SQL
    q "$PG_URL" -c "drop role $ROLE"
  fi
  [ "$(q "$PG_URL" -c "select count(*) from pg_roles where rolname='$ROLE'")" = 0 ] || fail "role still exists"
  [ "$(q "$PG_URL" -c "select count(*) from pg_database where datname='$XDB'")" = 0 ] || fail "transfer database still exists"
  echo "REVOKE_OK role and $XDB removed"
  exit 0
fi

[ "$TRANSFER_MODE" = grant ] || fail "unknown TRANSFER_MODE"
for v in COPY_RO_PASSWORD SRC_BUCKET SRC_ENDPOINT SRC_REGION SRC_ACCESS_KEY_ID SRC_SECRET_ACCESS_KEY; do [ -n "${!v:-}" ] || fail "missing $v"; done
[[ "$COPY_RO_PASSWORD" =~ ^[A-Za-z0-9]{32,}$ ]] || fail "COPY_RO_PASSWORD must be 32+ letters/digits"
[ "$(q "$PG_URL" -c "select count(*) from pg_roles where rolname='$ROLE'")" = 0 ] || fail "role already exists (run revoke first)"
[ "$(q "$PG_URL" -c "select count(*) from pg_database where datname='$XDB'")" = 0 ] || fail "$XDB already exists (run revoke first)"

# Files: list, hash and presign BEFORE touching the database, so a storage failure leaves nothing behind.
{ command -v rclone && command -v jq; } >/dev/null || { apt-get update -qq >/dev/null && apt-get install -y -qq rclone jq ca-certificates >/dev/null; }
export RCLONE_CONFIG_SRC_TYPE=s3 RCLONE_CONFIG_SRC_PROVIDER=Other RCLONE_CONFIG_SRC_ENDPOINT="$SRC_ENDPOINT" RCLONE_CONFIG_SRC_REGION="$SRC_REGION" \
  RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$SRC_ACCESS_KEY_ID" RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$SRC_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_SRC_FORCE_PATH_STYLE="${SRC_FORCE_PATH_STYLE:-false}"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
rclone hashsum sha256 --download "src:$SRC_BUCKET" --exclude "backups/**" > "$work/sha"
rclone lsjson -R --files-only "src:$SRC_BUCKET" --exclude "backups/**" | jq -r '.[] | [.Path, (.Size|tostring)] | @tsv' > "$work/size"
: > "$work/manifest.tsv"
while IFS=$'\t' read -r key size; do
  case "$key" in *$'\n'*|*'\'*) fail "unsupported key";; esac
  sum=$(awk -v k="$key" '{h=$1; sub(/^[^ ]+  /,""); if ($0==k) print h}' "$work/sha")
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || fail "no sha256 for a file"
  url=$(rclone link --expire 2h "src:$SRC_BUCKET/$key" 2>/dev/null) || fail "presign"
  printf '%s\t%s\t%s\t%s\n' "$key" "$size" "$sum" "$url" >> "$work/manifest.tsv"
done < "$work/size"
files=$(wc -l < "$work/manifest.tsv")

# Database: the temporary role. Statements are sent on stdin, so the password is not on a command line.
until_ts=$(date -u -d '+3 hours' '+%Y-%m-%d %H:%M:%S+00')
q "$PG_URL" -v pw="$COPY_RO_PASSWORD" <<SQL
create role $ROLE login password :'pw' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
  connection limit 2 valid until '$until_ts';
alter role $ROLE set default_transaction_read_only = on;
create database $XDB;
revoke all on database $XDB from public;
grant connect on database $XDB to $ROLE;
SQL
q "$SRC_URL" <<SQL
grant connect on database $SRC_DB to $ROLE;
grant usage on schema public, drizzle to $ROLE;
grant select on all tables in schema public, drizzle to $ROLE;
grant select on all sequences in schema public, drizzle to $ROLE;
SQL
q "$XDB_URL" <<SQL
create table manifest (key text primary key, bytes bigint not null, sha256 text not null, url text not null);
\copy manifest from '$work/manifest.tsv'
revoke all on schema public from public;
grant usage on schema public to $ROLE;
grant select on manifest to $ROLE;
SQL
# Prove the role cannot change anything in the live database.
bad=$(q "$SRC_URL" -c "select count(*) from information_schema.role_table_grants where grantee='$ROLE' and privilege_type<>'SELECT'")
[ "$bad" = 0 ] || fail "role has non-SELECT grants"
[ "$(q "$XDB_URL" -c 'select count(*) from manifest')" = "$files" ] || fail "manifest count"
echo "GRANT_OK role=$ROLE select_only=yes expires='$until_ts' files=$files bytes=$(awk -F'\t' '{s+=$2} END {print s+0}' "$work/manifest.tsv") links_expire=2h"
