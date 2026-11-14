#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
G33_DOCKER=(docker)
G33_LOCAL_TEMP_CREATED=0
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  [[ "${GITHUB_REF:-}" == "refs/heads/replit/dinar-next-six-wave-unification" ||
     "${GITHUB_REF:-}" == "refs/heads/codex/dinar-next-unified-development" ]] || {
    echo "G33: refusing refs outside the isolated candidate/development allowlist" >&2
    exit 96
  }
  [[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || {
    echo "G33: invalid GitHub run identity" >&2
    exit 96
  }
  G33_EXECUTION_MODE=GITHUB_ACTIONS
  G33_SOURCE_SHA="${GITHUB_SHA:-}"
  G33_RUN_ID="$GITHUB_RUN_ID"
  G33_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"
  G33_TEMP_ROOT="${RUNNER_TEMP:?}"
elif [[ "${DINAR_LOCAL_G33_ACCEPTANCE:-}" == "disposable" ]]; then
  G33_BRANCH="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD)" || {
    echo "G33: local rehearsal requires the authorized development branch" >&2; exit 96;
  }
  [[ "$G33_BRANCH" == "codex/dinar-next-unified-development" ||
     "$G33_BRANCH" == "codex/dinar-next-functional-audit" ||
     "$G33_BRANCH" == "claude/jassimai-release-candidate-2" ]] || {
    echo "G33: local rehearsal requires the authorized development branch" >&2; exit 96;
  }
  [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || {
    echo "G33: local rehearsal requires a clean committed checkout" >&2; exit 96;
  }
  G33_SOURCE_SHA="$(git -C "$ROOT" rev-parse --verify HEAD)" || {
    echo "G33: local rehearsal requires a committed source revision" >&2; exit 96;
  }
  G33_EXECUTION_MODE=LOCAL_DISPOSABLE
  G33_RUN_ID="$(date +%s)${BASHPID}${RANDOM}"
  G33_RUN_ATTEMPT=1
  G33_DOCKER=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
else
  echo "G33: this runner requires GitHub Actions or explicit DINAR_LOCAL_G33_ACCEPTANCE=disposable" >&2
  exit 96
fi
[[ "$G33_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "G33: invalid source revision" >&2; exit 96; }
: "${G33_APP_IMAGE:?set G33_APP_IMAGE to the image built from this commit}"
: "${G33_POSTGRES_IMAGE:?set G33_POSTGRES_IMAGE to postgres:16 or postgres:18}"
case "$G33_POSTGRES_IMAGE" in
  postgres:16|postgres:18) ;;
  *) echo "G33: PostgreSQL image must be allowlisted as postgres:16 or postgres:18" >&2; exit 96 ;;
esac
[[ "$G33_APP_IMAGE" == "dinar-next-g33:${G33_SOURCE_SHA}" ]] || {
  echo "G33: app image tag must match the checked-out commit" >&2
  exit 96
}
: "${G33_TEST_IMAGE:?set G33_TEST_IMAGE to the Dockerfile.g33 test-runner image built from this commit}"
[[ "$G33_TEST_IMAGE" == "dinar-next-g33-test:${G33_SOURCE_SHA}" ]] || {
  echo "G33: test image tag must match the checked-out commit" >&2
  exit 96
}
TEST_DIR="$ROOT/artifacts/api-server/test"
[[ -d "$TEST_DIR/isolation" && -f "$ROOT/Dockerfile" ]] || {
  echo "G33: candidate sources are incomplete" >&2
  exit 96
}
# The test-runner image must be the production builder section, unchanged, plus its own tail.
G33_BUILDER_MARKER="# Keep compilers, test runners and frontend tooling out of the runtime dependency tree."
G33_BUILDER_PREFIX="$(awk -v m="$G33_BUILDER_MARKER" '$0 == m { exit } { print }' "$ROOT/Dockerfile")"
G33_TEST_PREFIX="$(head -n "$(printf '%s\n' "$G33_BUILDER_PREFIX" | wc -l)" "$ROOT/Dockerfile.g33" 2>/dev/null)"
[[ -n "$G33_BUILDER_PREFIX" && "$G33_BUILDER_PREFIX" == "$G33_TEST_PREFIX" ]] || {
  echo "G33: Dockerfile.g33 must start with the production builder section unchanged" >&2
  exit 96
}
if [[ "$G33_EXECUTION_MODE" == LOCAL_DISPOSABLE ]]; then
  G33_TEMP_ROOT="$(mktemp -d /tmp/dinar-g33-local.XXXXXX)"
  G33_LOCAL_TEMP_CREATED=1
fi
echo "G33_EXECUTION_MODE=$G33_EXECUTION_MODE source=$G33_SOURCE_SHA"

SUFFIX="${G33_RUN_ID}-${G33_RUN_ATTEMPT}"
NETWORK="dinar-g33-${SUFFIX}"
POSTGRES="dinar-g33-pg-${SUFFIX}"
APP="dinar-g33-app-${SUFFIX}"
RUNNER="dinar-g33-runner-${SUFFIX}"
DB="dinar_test_legal_${G33_RUN_ID}_${G33_RUN_ATTEMPT}"
PG_URL="postgres://dinar_isolation@127.0.0.1:5432"
HANDSHAKE="${G33_TEMP_ROOT:?}/dinar-g33-handshake-${SUFFIX}"
TEST_SNAPSHOT="$HANDSHAKE/test"
PROD_ENV="${G33_TEMP_ROOT}/dinar-g33-prod-${SUFFIX}.env"
DEV_ENV="${G33_TEMP_ROOT}/dinar-g33-dev-${SUFFIX}.env"
SESSION_SECRET="$(openssl rand -hex 32)"
CREATED_NETWORK=0
CREATED_POSTGRES=0
CREATED_APP=0
CREATED_RUNNER=0

cleanup() {
  local status=$?
  set +e
  if [[ "$CREATED_RUNNER" == 1 ]]; then
    "${G33_DOCKER[@]}" rm -f "$RUNNER" >/dev/null 2>&1
  fi
  if [[ "$CREATED_APP" == 1 ]]; then
    "${G33_DOCKER[@]}" rm -f "$APP" >/dev/null 2>&1
  fi
  if [[ "$CREATED_POSTGRES" == 1 ]]; then
    "${G33_DOCKER[@]}" rm -f --volumes "$POSTGRES" >/dev/null 2>&1
  fi
  if [[ "$CREATED_NETWORK" == 1 ]]; then
    "${G33_DOCKER[@]}" network rm "$NETWORK" >/dev/null 2>&1
  fi
  rm -f "$PROD_ENV" "$DEV_ENV"
  rm -rf "$HANDSHAKE"
  if [[ "$G33_LOCAL_TEMP_CREATED" == 1 && "$G33_TEMP_ROOT" == /tmp/dinar-g33-local.* ]]; then
    rm -rf "$G33_TEMP_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT

umask 077
mkdir -p "$HANDSHAKE"
chmod 0777 "$HANDSHAKE"
mkdir -p "$TEST_SNAPSHOT"
cp -a "$TEST_DIR/." "$TEST_SNAPSHOT/"
rm -rf "$TEST_SNAPSHOT/.test-build"
chmod -R a+rwX "$TEST_SNAPSHOT"
# The runtime image excludes lib/db test files (.dockerignore); mount a read-only snapshot.
DB_SCRIPTS_SNAPSHOT="$HANDSHAKE/db-scripts"
mkdir -p "$DB_SCRIPTS_SNAPSHOT"
cp -a "$ROOT/lib/db/scripts/release-migration.test.mjs" "$ROOT/lib/db/scripts/release-migration-concurrency.test.mjs" "$ROOT/lib/db/scripts/rehearsal" "$DB_SCRIPTS_SNAPSHOT/"
chmod -R a+rX "$DB_SCRIPTS_SNAPSHOT"
# Startup-only storage configuration for the external Docker host: synthetic values and an
# unserved loopback endpoint. The runtime network is internal; this is not provider/I/O coverage.
cat >"$PROD_ENV" <<EOF
NODE_ENV=production
PORT=3000
SESSION_SECRET=$SESSION_SECRET
DATABASE_URL=$PG_URL/$DB
DINAR_DEPLOYMENT_ENV=production
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_S3_ENDPOINT=http://127.0.0.1:9
OBJECT_STORAGE_S3_REGION=us-east-1
OBJECT_STORAGE_S3_BUCKET=g33-offline
OBJECT_STORAGE_S3_ACCESS_KEY_ID=G33_OFFLINE_ONLY
OBJECT_STORAGE_S3_SECRET_ACCESS_KEY=G33_OFFLINE_ONLY_NOT_A_CREDENTIAL
EOF
cat >"$DEV_ENV" <<EOF
NODE_ENV=development
PORT=3000
SESSION_SECRET=$SESSION_SECRET
DATABASE_URL=$PG_URL/$DB
DINAR_DEV_DATABASE_URL=$PG_URL/$DB
BDINAR_W08_ACCEPTANCE=development
BDINAR_WAVE4_ACCEPTANCE=development
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_S3_ENDPOINT=http://127.0.0.1:9
OBJECT_STORAGE_S3_REGION=us-east-1
OBJECT_STORAGE_S3_BUCKET=g33-offline
OBJECT_STORAGE_S3_ACCESS_KEY_ID=G33_OFFLINE_ONLY
OBJECT_STORAGE_S3_SECRET_ACCESS_KEY=G33_OFFLINE_ONLY_NOT_A_CREDENTIAL
EOF
chmod 600 "$PROD_ENV" "$DEV_ENV"

echo "G33_BUILD_EGRESS=dependency downloads were allowed before runtime isolation"
"${G33_DOCKER[@]}" pull "$G33_POSTGRES_IMAGE"
"${G33_DOCKER[@]}" network create --internal "$NETWORK" >/dev/null
CREATED_NETWORK=1
[[ "$("${G33_DOCKER[@]}" network inspect --format '{{.Internal}}' "$NETWORK")" == "true" ]] || {
  echo "G33: Docker did not create an internal-only network" >&2
  exit 96
}
echo "G33_RUNTIME_NETWORK=internal; app, test runner and PostgreSQL will share its namespace"
echo "G33_APP_IMAGE_ID=$("${G33_DOCKER[@]}" image inspect --format '{{.Id}}' "$G33_APP_IMAGE")"
echo "G33_TEST_IMAGE_ID=$("${G33_DOCKER[@]}" image inspect --format '{{.Id}}' "$G33_TEST_IMAGE")"
echo "G33_POSTGRES_IMAGE_ID=$("${G33_DOCKER[@]}" image inspect --format '{{.Id}}' "$G33_POSTGRES_IMAGE")"
"${G33_DOCKER[@]}" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$G33_POSTGRES_IMAGE" | sed 's/^/G33_POSTGRES_REPO_DIGEST=/'

"${G33_DOCKER[@]}" run --detach \
  --name "$POSTGRES" \
  --network "$NETWORK" \
  --network-alias g33-postgres \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env POSTGRES_USER=dinar_isolation \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=postgres \
  --health-cmd "pg_isready -U dinar_isolation" \
  --health-interval 2s \
  --health-timeout 5s \
  --health-retries 30 \
  "$G33_POSTGRES_IMAGE" >/dev/null
CREATED_POSTGRES=1

for _ in $(seq 1 60); do
  health="$("${G33_DOCKER[@]}" inspect --format '{{.State.Health.Status}}' "$POSTGRES")"
  [[ "$health" == "healthy" ]] && break
  [[ "$health" != "unhealthy" ]] || { "${G33_DOCKER[@]}" logs "$POSTGRES" >&2; exit 1; }
  sleep 2
done
[[ "$("${G33_DOCKER[@]}" inspect --format '{{.State.Health.Status}}' "$POSTGRES")" == "healthy" ]] || {
  "${G33_DOCKER[@]}" logs "$POSTGRES" >&2
  echo "G33: disposable PostgreSQL did not become healthy" >&2
  exit 1
}

run_local_suite() {
  local release_migrations="$1"
  shift
  "${G33_DOCKER[@]}" run --rm \
    --network "container:$POSTGRES" \
    --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
    --tmpfs /app/artifacts/api-server/.test-build:rw,uid=1000,gid=1000,mode=0777,size=128m \
    --memory 1g \
    --cpus 2 \
    --pids-limit 256 \
    --env DINAR_LOCAL_PG="$PG_URL" \
    --env DINAR_SUITE_DB="$DB" \
    --env DINAR_SUITE_SEED=none \
    --env DINAR_SUITE_KEEP_DB=1 \
    --env DINAR_SUITE_RELEASE_MIGRATIONS="$release_migrations" \
    --entrypoint /bin/sh \
    "$G33_TEST_IMAGE" \
    -lc "cd /app/artifacts/api-server && sh test/isolation/local-suite.sh $*"
}

if [[ "$G33_POSTGRES_IMAGE" == "postgres:18" ]]; then
  "${G33_DOCKER[@]}" run --rm \
    --network "container:$POSTGRES" \
    --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
    --memory 1g \
    --cpus 2 \
    --pids-limit 256 \
    --env DINAR_RELEASE_MIGRATION_TEST_PG="$PG_URL" \
    --volume "$DB_SCRIPTS_SNAPSHOT/release-migration.test.mjs:/app/lib/db/scripts/release-migration.test.mjs:ro" \
    --volume "$DB_SCRIPTS_SNAPSHOT/release-migration-concurrency.test.mjs:/app/lib/db/scripts/release-migration-concurrency.test.mjs:ro" \
    --volume "$DB_SCRIPTS_SNAPSHOT/rehearsal:/app/lib/db/scripts/rehearsal:ro" \
    --entrypoint /bin/sh \
    "$G33_TEST_IMAGE" \
    -lc "cd /app/lib/db && node --experimental-strip-types --test ./scripts/release-migration.test.mjs ./scripts/release-migration-concurrency.test.mjs"
  run_local_suite 1 \
    market-legal-acceptance.test \
    BDINAR_MARKET_LEGAL_ACCEPTANCE=development \
    DINAR_MARKET_LEGAL_TEST_FIXTURE=1
else
  run_local_suite 0 \
    market-legal-acceptance.test \
    BDINAR_MARKET_LEGAL_ACCEPTANCE=development \
    DINAR_MARKET_LEGAL_TEST_FIXTURE=1
fi

# Connect uses a separate fresh fixture database; the legal/restart database below
# is never reset. Runtime remains in the same internal-only network namespace.
CONNECT_RELEASE=0
[[ "$G33_POSTGRES_IMAGE" != "postgres:18" ]] || CONNECT_RELEASE=1
"${G33_DOCKER[@]}" run --rm \
  --network "container:$POSTGRES" \
  --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
  --tmpfs /app/artifacts/api-server/.test-build:rw,uid=1000,gid=1000,mode=0777,size=128m \
  --memory 1g --cpus 2 --pids-limit 256 \
  --env DINAR_LOCAL_PG="$PG_URL" \
  --env DINAR_SUITE_DB="dinar_test_connect_${G33_RUN_ID}_${G33_RUN_ATTEMPT}" \
  --env DINAR_SUITE_SEED=fixtures \
  --env DINAR_SUITE_RELEASE_MIGRATIONS="$CONNECT_RELEASE" \
  --entrypoint /bin/sh "$G33_TEST_IMAGE" \
  -lc 'cd /app/artifacts/api-server && sh test/isolation/local-suite.sh connect-performance.test connect-commission-math.test connect-sync-observations.test connect-agreement-draft.test connect-card-presentation.test connect-website-catalog.test connect-partners.test connect-mcp-catalog.test connect-catalog-pull.test connect-network.test connect-card-contract.test ai-authority-boundary.test BDINAR_TEST_DATABASE=development'

MIGRATION_FINGERPRINT() {
  "${G33_DOCKER[@]}" exec "$POSTGRES" psql -v ON_ERROR_STOP=1 -U dinar_isolation -d "$DB" -Atqc \
    "SELECT count(*)::text || ':' || md5(COALESCE(string_agg(hash || ':' || created_at::text, E'\\n' ORDER BY id), '')) FROM drizzle.__drizzle_migrations" \
    | tr -d '\r'
}
EXPECTED_MIGRATION_COUNT="$(node -p 'require(process.argv[1]).length' "$ROOT/lib/db/drizzle/release-manifest.json")"
[[ "$EXPECTED_MIGRATION_COUNT" =~ ^[1-9][0-9]*$ ]] || { echo "G33: invalid release manifest count" >&2; exit 96; }
MIGRATIONS_BEFORE="$(MIGRATION_FINGERPRINT)"
[[ "${MIGRATIONS_BEFORE%%:*}" == "$EXPECTED_MIGRATION_COUNT" ]] || {
  echo "G33: expected the checked-in $EXPECTED_MIGRATION_COUNT-migration manifest, got ${MIGRATIONS_BEFORE%%:*}" >&2
  exit 1
}
echo "G33_MIGRATION_MANIFEST count=${MIGRATIONS_BEFORE%%:*} fingerprint=${MIGRATIONS_BEFORE#*:}"

"${G33_DOCKER[@]}" run --detach \
  --name "$APP" \
  --network "container:$POSTGRES" \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env-file "$PROD_ENV" \
  "$G33_APP_IMAGE" >/dev/null
CREATED_APP=1

probe_health() {
  if "${G33_DOCKER[@]}" run --rm \
    --network "container:$POSTGRES" \
    --entrypoint node \
    "$G33_APP_IMAGE" \
    --input-type=module \
    -e 'const deadline=Date.now()+120000; while(Date.now()<deadline){try{const r=await fetch("http://127.0.0.1:3000/healthz");if(r.status===200){console.log("G33_HEALTHZ status=200");process.exit(0)}}catch{} await new Promise(r=>setTimeout(r,1000))} console.error("G33_HEALTHZ timeout");process.exit(1)'; then
    return 0
  fi
  "${G33_DOCKER[@]}" inspect --format 'G33_APP_STATE={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' "$APP" >&2 || true
  "${G33_DOCKER[@]}" logs "$APP" >&2 || true
  return 1
}
probe_readiness() {
  "${G33_DOCKER[@]}" run --rm \
    --network "container:$POSTGRES" \
    --entrypoint node \
    "$G33_APP_IMAGE" \
    --input-type=module \
    -e 'const r=await fetch("http://127.0.0.1:3000/api/readyz");const text=await r.text();let body;try{body=JSON.parse(text)}catch{body={text:text.slice(0,1000)}};console.log("G33_PRODUCTION_READINESS status="+r.status+" body="+JSON.stringify(body));if(r.status!==503)process.exit(1)'
}

probe_health
probe_readiness
[[ "$(MIGRATION_FINGERPRINT)" == "$MIGRATIONS_BEFORE" ]] || {
  echo "G33: production startup changed the migration ledger" >&2
  exit 1
}
echo "G33_PRODUCTION_STARTUP_MIGRATIONS=unchanged"

"${G33_DOCKER[@]}" stop --time 30 "$APP" >/dev/null
shutdown_code="$("${G33_DOCKER[@]}" inspect --format '{{.State.ExitCode}}' "$APP")"
echo "G33_PRODUCTION_CONTAINER_SHUTDOWN_EXIT=$shutdown_code"
[[ "$shutdown_code" == "0" ]] || {
  echo "G33: production container did not shut down cleanly" >&2
  exit 1
}
"${G33_DOCKER[@]}" start "$APP" >/dev/null
probe_health
probe_readiness
[[ "$(MIGRATION_FINGERPRINT)" == "$MIGRATIONS_BEFORE" ]] || {
  echo "G33: production restart changed the migration ledger" >&2
  exit 1
}
echo "G33_PRODUCTION_RESTART_MIGRATIONS=unchanged"

"${G33_DOCKER[@]}" stop --time 30 "$APP" >/dev/null
shutdown_code="$("${G33_DOCKER[@]}" inspect --format '{{.State.ExitCode}}' "$APP")"
echo "G33_PRODUCTION_RESTART_CONTAINER_SHUTDOWN_EXIT=$shutdown_code"
[[ "$shutdown_code" == "0" ]] || {
  "${G33_DOCKER[@]}" logs "$APP" >&2
  echo "G33: restarted production container did not shut down cleanly" >&2
  exit 1
}
"${G33_DOCKER[@]}" rm "$APP" >/dev/null
CREATED_APP=0
"${G33_DOCKER[@]}" run --detach \
  --name "$APP" \
  --network "container:$POSTGRES" \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env-file "$DEV_ENV" \
  "$G33_APP_IMAGE" >/dev/null
CREATED_APP=1
probe_health

"${G33_DOCKER[@]}" run --detach \
  --name "$RUNNER" \
  --network "container:$POSTGRES" \
  --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
  --volume "$HANDSHAKE:/g33" \
  --tmpfs /app/artifacts/api-server/.test-build:rw,uid=1000,gid=1000,mode=0777,size=128m \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env DINAR_LOCAL_PG="$PG_URL" \
  --env DINAR_SUITE_DB="$DB" \
  --env DINAR_SUITE_SEED=none \
  --env DINAR_SUITE_KEEP_DB=1 \
  --env DINAR_SUITE_REUSE_DB=1 \
  --entrypoint /bin/sh \
  "$G33_TEST_IMAGE" \
  -lc 'cd /app/artifacts/api-server && sh test/isolation/local-suite.sh g33-docker-acceptance.test BDINAR_W08_ACCEPTANCE=development BDINAR_TEST_API_BASE=http://127.0.0.1:3000 BDINAR_G33_HANDSHAKE_DIR=/g33' >/dev/null
CREATED_RUNNER=1

ready=0
for _ in $(seq 1 600); do
  if [[ -f "$HANDSHAKE/transaction-ready" ]]; then
    ready=1
    break
  fi
  runner_state="$("${G33_DOCKER[@]}" inspect --format '{{.State.Status}}' "$RUNNER" 2>/dev/null || true)"
  if [[ "$runner_state" == "exited" ]]; then
    "${G33_DOCKER[@]}" logs "$RUNNER" >&2
    echo "G33: transaction test exited before requesting the restart" >&2
    exit 1
  fi
  sleep 1
done
[[ "$ready" == "1" ]] || {
  "${G33_DOCKER[@]}" logs "$RUNNER" >&2
  echo "G33: timed out waiting for the transaction/restart handshake" >&2
  exit 1
}
echo "G33_TRANSACTION=complete; restarting the isolated app container"

"${G33_DOCKER[@]}" stop --time 30 "$APP" >/dev/null
shutdown_code="$("${G33_DOCKER[@]}" inspect --format '{{.State.ExitCode}}' "$APP")"
echo "G33_TEST_CONTAINER_SHUTDOWN_EXIT=$shutdown_code"
[[ "$shutdown_code" == "0" ]] || {
  "${G33_DOCKER[@]}" logs "$APP" >&2
  echo "G33: test-mode app container did not shut down cleanly" >&2
  exit 1
}
"${G33_DOCKER[@]}" start "$APP" >/dev/null
probe_health
[[ "$(MIGRATION_FINGERPRINT)" == "$MIGRATIONS_BEFORE" ]] || {
  echo "G33: test-mode app restart changed the migration ledger" >&2
  exit 1
}
printf 'restarted\n' >"$HANDSHAKE/restart-complete"

runner_exit="$("${G33_DOCKER[@]}" wait "$RUNNER")"
"${G33_DOCKER[@]}" logs "$RUNNER"
[[ "$runner_exit" == "0" ]] || {
  echo "G33: Docker API cash journey failed with exit $runner_exit" >&2
  exit 1
}
echo "G33_CONTAINER_ACCEPTANCE=passed postgres=$G33_POSTGRES_IMAGE image=$G33_APP_IMAGE test_image=$G33_TEST_IMAGE"
