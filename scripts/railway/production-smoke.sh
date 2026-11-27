#!/usr/bin/env bash
# JassimAI Production rehearsal checks — runs as a job INSIDE Railway's `production` environment and
# talks to the app over the private network (no gate, no secrets printed). Read-only against the
# database except nothing; the storage check writes, reads and deletes ONE probe object under
# smoke-probe/ in the Production bucket. Every line is PASS/FAIL/INFO; exits 1 if any FAIL.
set -uo pipefail
set +x
[ "${RAILWAY_ENVIRONMENT_NAME:-}" = production ] || { echo "SMOKE_REFUSED environment"; exit 1; }
for v in APP_URL DATABASE_URL S3_BUCKET S3_ENDPOINT S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY EXPECTED_BUCKET; do
  [ -n "${!v:-}" ] || { echo "SMOKE_REFUSED missing $v"; exit 1; }
done
case "$DATABASE_URL" in *jassimai-production-postgres.railway.internal*/jassimai_production*) ;; *) echo "SMOKE_REFUSED database"; exit 1;; esac
[ "$S3_BUCKET" = "$EXPECTED_BUCKET" ] || { echo "SMOKE_REFUSED bucket"; exit 1; }
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl jq rclone ca-certificates >/dev/null 2>&1
ORIGIN=https://jassimai.com
fails=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; fails=$((fails+1)); }
code() { curl -s -o /tmp/body -w '%{http_code}' --max-time 20 "$@"; }
q() { PGOPTIONS="-c default_transaction_read_only=on" psql "$DATABASE_URL" -X -qAt -c "$1"; }

# --- 1. Health and readiness ---
[ "$(code "$APP_URL/api/healthz")" = 200 ] && pass "healthz 200" || fail "healthz"
c=$(code "$APP_URL/api/readyz"); r=$(cat /tmp/body)
echo "INFO readyz http=$c body=$(echo "$r" | jq -c . 2>/dev/null | cut -c1-400)"
echo "$r" | jq -e '.checks.database=="ready" and .checks.migrations=="current"' >/dev/null 2>&1 && pass "database ready, migrations current" || fail "readyz database/migrations"

# --- 2. Migrated data (read-only) ---
[ "$(q "select count(*) from drizzle.__drizzle_migrations")" = 79 ] && pass "79 migrations recorded (0000-0078)" || fail "migration ledger count $(q 'select count(*) from drizzle.__drizzle_migrations')"
nz=""; for t in $(q "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"); do n=$(q "select count(*) from public.\"$t\""); [ "$n" != 0 ] && nz="$nz $t=$n"; done
echo "INFO non-empty tables:$nz"
for t in users orders; do echo "INFO exact $t=$(q "select count(*) from public.$t")"; done
for t in connect_workflows smart_store_cards; do
  q "select 1 from information_schema.tables where table_name like '${t}%' limit 1" | grep -q 1 && pass "new feature tables present ($t*)" || echo "INFO no table matching $t*"
done

# --- 3. Public pages and API ---
[ "$(code "$APP_URL/")" = 200 ] && grep -qi "<html" /tmp/body && pass "web app index served" || fail "index"
asset=$(grep -oE '/assets/[^"]+\.js' /tmp/body | head -1)
[ -n "$asset" ] && [ "$(code "$APP_URL$asset")" = 200 ] && pass "static asset served" || fail "static asset"
[ "$(code "$APP_URL/api/categories")" = 200 ] && pass "categories ($(jq 'length' /tmp/body 2>/dev/null))" || fail "categories"
c=$(code "$APP_URL/api/listings"); [ "$c" = 409 ] && grep -q COUNTRY_INTAKE_NOT_ACTIVE /tmp/body && echo "INFO listings blocked: market not activated (same as live site)"
[ "$c" = 200 ] && pass "listings search ($(jq 'if type=="array" then length else (.items|length) end' /tmp/body 2>/dev/null) results)" || fail "listings $c"
id=$(jq -r 'if type=="array" then .[0].id else .items[0].id end // empty' /tmp/body 2>/dev/null)
if [ -n "$id" ]; then [ "$(code "$APP_URL/api/listings/$id")" = 200 ] && pass "listing detail" || fail "listing detail"; else echo "INFO no public listing to open"; fi
[ "$(code "$APP_URL/api/policies")" = 200 ] && pass "policies" || fail "policies"

# --- 4. Security ---
c=$(code "$APP_URL/api/auth/me"); [ "$c" = 200 ] && [ "$(jq -r '.user' /tmp/body)" = null ] && pass "anonymous /api/auth/me has no user" || fail "/api/auth/me anonymous"
for p in /api/orders /api/cart /api/admin/users /api/dashboard; do
  c=$(code "$APP_URL$p"); case "$c" in 401|403) pass "unauthenticated $p -> $c";; *) fail "unauthenticated $p -> $c";; esac
done
c=$(code -X POST -H "Origin: https://evil.example" -H 'Content-Type: application/json' -d '{}' "$APP_URL/api/auth/login"); [ "$c" = 403 ] && pass "foreign Origin POST refused" || fail "foreign Origin POST -> $c"
c=$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d 'x' "$APP_URL/api/auth/login"); [ "$c" = 403 ] && pass "non-JSON POST refused" || fail "non-JSON POST -> $c"
c=$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"phoneCountryCode":"+962","phoneNumber":"790000000","password":"wrong-password-123"}' "$APP_URL/api/auth/login"); case "$c" in 400|401|403|429) pass "wrong login refused ($c)";; *) fail "wrong login -> $c";; esac
c=$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"displayName":"Smoke","phoneCountryCode":"+962","phoneNumber":"790000001","accountCountry":"JO","password":"Smoke-password-1234","confirmPassword":"Smoke-password-1234","acceptTerms":true}' "$APP_URL/api/auth/register"); case "$c" in 400|403|422) pass "signup without phone verification refused ($c)";; *) fail "signup without verification -> $c";; esac
h=$(curl -s -D - -o /dev/null --max-time 20 "$APP_URL/")
echo "$h" | grep -qi '^content-security-policy:' && pass "CSP header" || fail "CSP header"
echo "$h" | grep -qi '^x-content-type-options: nosniff' && pass "nosniff header" || fail "nosniff"
echo "$h" | grep -qi '^x-powered-by' && fail "x-powered-by exposed" || pass "x-powered-by hidden"
{ printf '{"x":"'; head -c 200000 /dev/zero | tr '\0' a; printf '"}'; } > /tmp/big.json; c=$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' --data-binary @/tmp/big.json "$APP_URL/api/auth/login"); [ "$c" = 413 ] && pass "oversized body refused (413)" || fail "oversized body -> $c"

# --- 5. Live switches stay off ---
for v in WHOP_ENABLED DINAR_WHOP_BILLING_ENABLED DINAR_LIVE_PROVIDERS_ENABLED DINAR_CONNECT_LIVE_CALLS; do echo "INFO (app variable $v is checked in Railway config, not here)"; done

# --- 6. Storage: write, read back, compare, delete one probe object ---
export RCLONE_CONFIG_P_TYPE=s3 RCLONE_CONFIG_P_PROVIDER=Other RCLONE_CONFIG_P_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_P_REGION="$S3_REGION" \
  RCLONE_CONFIG_P_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" RCLONE_CONFIG_P_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" RCLONE_CONFIG_P_FORCE_PATH_STYLE=false
key="smoke-probe/probe-$(date -u +%s).bin"; head -c 65536 /dev/urandom > /tmp/probe
if rclone -q copyto /tmp/probe "p:$S3_BUCKET/$key" 2>/dev/null && rclone -q copyto "p:$S3_BUCKET/$key" /tmp/back 2>/dev/null && cmp -s /tmp/probe /tmp/back; then pass "storage write/read sha match"; else fail "storage write/read"; fi
pub=$(code "${S3_ENDPOINT/https:\/\//https://$S3_BUCKET.}/$key"); case "$pub" in 401|403) pass "bucket not publicly readable ($pub)";; *) fail "bucket anonymous read -> $pub";; esac
rclone -q deletefile "p:$S3_BUCKET/$key" 2>/dev/null && [ -z "$(rclone lsf "p:$S3_BUCKET/smoke-probe/" 2>/dev/null)" ] && pass "storage delete" || fail "storage delete"

# --- 7. Release checks: brand, sign-in mode, maps policy ---
sha() { curl -s --max-time 20 "$APP_URL$1" | sha256sum | cut -d' ' -f1; }
[ "$(sha /favicon.ico)" = "${EXPECTED_FAVICON_SHA:-x}" ] && pass "favicon is the approved logo" || fail "favicon differs from the approved logo"
[ "$(sha /brand/jassimai-mark.png)" = "${EXPECTED_MARK_SHA:-x}" ] && pass "brand mark is the approved logo" || fail "brand mark differs"
csp=$(curl -s -D - -o /dev/null --max-time 20 "$APP_URL/" | grep -i '^content-security-policy:')
echo "$csp" | grep -q "api.maptiler.com" && pass "CSP allows the map provider" || fail "CSP lacks api.maptiler.com"
echo "$csp" | grep -q "accounts.google.com" && pass "CSP allows Google sign-in" || fail "CSP lacks Google sign-in"
c=$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"idToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbb.cccc"}' "$APP_URL/api/auth/google"); case "$c" in 400|401|403) pass "Google sign-in enabled and rejects a forged token ($c)";; *) fail "Google sign-in -> $c $(head -c 120 /tmp/body)";; esac
c=$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"phoneCountryCode":"+962","phoneNumber":"790000002","accountCountry":"JO","acceptTerms":true,"phoneNumberConfirm":"790000002"}' "$APP_URL/api/auth/google/complete"); [ "$c" = 401 ] && pass "Google completion without a Google session refused (401)" || fail "google/complete without ticket -> $c"
bundle=$(curl -s --max-time 20 "$APP_URL/" | grep -oE '/assets/[^"]+\.js' | head -20)
found=0; for a in $bundle; do curl -s --max-time 20 "$APP_URL$a" | grep -qE 'نصيحة دينار|محادثة دينار|يتطلب دينار' && found=1; done
[ "$found" = 0 ] && pass "no old «دينار» strings in the entry bundle (lazy chunks not scanned)" || fail "old «دينار» strings still in the bundle"

echo "SMOKE_DONE fails=$fails"
[ "$fails" = 0 ]
