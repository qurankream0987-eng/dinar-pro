#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${GITHUB_ACTIONS:-}" == "true" ]] || {
  echo "G33: this runner is restricted to GitHub Actions" >&2
  exit 96
}
[[ "${GITHUB_REF:-}" == "refs/heads/replit/dinar-next-six-wave-unification" ]] || {
  echo "G33: refusing any ref other than the isolated candidate branch" >&2
  exit 96
}
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || {
  echo "G33: invalid GitHub run identity" >&2
  exit 96
}

: "${G33_APP_IMAGE:?set G33_APP_IMAGE to the image built from this commit}"
: "${G33_POSTGRES_IMAGE:?set G33_POSTGRES_IMAGE to postgres:16 or postgres:18}"
case "$G33_POSTGRES_IMAGE" in
  postgres:16|postgres:18) ;;
  *) echo "G33: PostgreSQL image must be allowlisted as postgres:16 or postgres:18" >&2; exit 96 ;;
esac
[[ "$G33_APP_IMAGE" == "dinar-next-g33:${GITHUB_SHA}" ]] || {
  echo "G33: app image tag must match the checked-out commit" >&2
  exit 96
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$ROOT/artifacts/api-server/test"
[[ -d "$TEST_DIR/isolation" && -f "$ROOT/Dockerfile" ]] || {
  echo "G33: candidate sources are incomplete" >&2
  exit 96
}

SUFFIX="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
NETWORK="dinar-g33-${SUFFIX}"
POSTGRES="dinar-g33-pg-${SUFFIX}"
APP="dinar-g33-app-${SUFFIX}"
RUNNER="dinar-g33-runner-${SUFFIX}"
DB="dinar_test_legal_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"
PG_URL="postgres://dinar_isolation@127.0.0.1:5432"
HANDSHAKE="${RUNNER_TEMP:?}/dinar-g33-handshake-${SUFFIX}"
TEST_SNAPSHOT="$HANDSHAKE/test"
PROD_ENV="${RUNNER_TEMP}/dinar-g33-prod-${SUFFIX}.env"
DEV_ENV="${RUNNER_TEMP}/dinar-g33-dev-${SUFFIX}.env"
SESSION_SECRET="$(openssl rand -hex 32)"
CREATED_NETWORK=0
CREATED_POSTGRES=0
CREATED_APP=0
CREATED_RUNNER=0

cleanup() {
  local status=$?
  set +e
  if [[ "$CREATED_RUNNER" == 1 ]]; then
    docker rm -f "$RUNNER" >/dev/null 2>&1
  fi
  if [[ "$CREATED_APP" == 1 ]]; then
    docker rm -f "$APP" >/dev/null 2>&1
  fi
  if [[ "$CREATED_POSTGRES" == 1 ]]; then
    docker rm -f "$POSTGRES" >/dev/null 2>&1
  fi
  if [[ "$CREATED_NETWORK" == 1 ]]; then
    docker network rm "$NETWORK" >/dev/null 2>&1
  fi
  rm -f "$PROD_ENV" "$DEV_ENV"
  rm -rf "$HANDSHAKE"
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
cat >"$PROD_ENV" <<EOF
NODE_ENV=production
PORT=3000
SESSION_SECRET=$SESSION_SECRET
DATABASE_URL=$PG_URL/$DB
EOF
cat >"$DEV_ENV" <<EOF
NODE_ENV=development
PORT=3000
SESSION_SECRET=$SESSION_SECRET
DATABASE_URL=$PG_URL/$DB
DINAR_DEV_DATABASE_URL=$PG_URL/$DB
BDINAR_W08_ACCEPTANCE=development
BDINAR_WAVE4_ACCEPTANCE=development
EOF
chmod 600 "$PROD_ENV" "$DEV_ENV"

echo "G33_BUILD_EGRESS=dependency downloads were allowed before runtime isolation"
docker pull "$G33_POSTGRES_IMAGE"
docker network create --internal "$NETWORK" >/dev/null
CREATED_NETWORK=1
[[ "$(docker network inspect --format '{{.Internal}}' "$NETWORK")" == "true" ]] || {
  echo "G33: Docker did not create an internal-only network" >&2
  exit 96
}
echo "G33_RUNTIME_NETWORK=internal; app, test runner and PostgreSQL will share its namespace"
echo "G33_APP_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$G33_APP_IMAGE")"
echo "G33_POSTGRES_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$G33_POSTGRES_IMAGE")"
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$G33_POSTGRES_IMAGE" | sed 's/^/G33_POSTGRES_REPO_DIGEST=/'

docker run --detach \
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
  health="$(docker inspect --format '{{.State.Health.Status}}' "$POSTGRES")"
  [[ "$health" == "healthy" ]] && break
  [[ "$health" != "unhealthy" ]] || { docker logs "$POSTGRES" >&2; exit 1; }
  sleep 2
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$POSTGRES")" == "healthy" ]] || {
  docker logs "$POSTGRES" >&2
  echo "G33: disposable PostgreSQL did not become healthy" >&2
  exit 1
}

run_local_suite() {
  local release_migrations="$1"
  shift
  docker run --rm \
    --network "container:$POSTGRES" \
    --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
    --memory 1g \
    --cpus 2 \
    --pids-limit 256 \
    --env DINAR_LOCAL_PG="$PG_URL" \
    --env DINAR_SUITE_DB="$DB" \
    --env DINAR_SUITE_SEED=none \
    --env DINAR_SUITE_KEEP_DB=1 \
    --env DINAR_SUITE_RELEASE_MIGRATIONS="$release_migrations" \
    --entrypoint /bin/sh \
    "$G33_APP_IMAGE" \
    -lc "cd /app/artifacts/api-server && sh test/isolation/local-suite.sh $*"
}

if [[ "$G33_POSTGRES_IMAGE" == "postgres:18" ]]; then
  docker run --rm \
    --network "container:$POSTGRES" \
    --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
    --memory 1g \
    --cpus 2 \
    --pids-limit 256 \
    --env DINAR_RELEASE_MIGRATION_TEST_PG="$PG_URL" \
    --entrypoint /bin/sh \
    "$G33_APP_IMAGE" \
    -lc "cd /app/lib/db && pnpm run test:release-migration"
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

MIGRATION_FINGERPRINT() {
  docker exec "$POSTGRES" psql -v ON_ERROR_STOP=1 -U dinar_isolation -d "$DB" -Atqc \
    "SELECT count(*)::text || ':' || md5(COALESCE(string_agg(hash || ':' || created_at::text, E'\\n' ORDER BY id), '')) FROM drizzle.__drizzle_migrations" \
    | tr -d '\r'
}
MIGRATIONS_BEFORE="$(MIGRATION_FINGERPRINT)"
[[ "${MIGRATIONS_BEFORE%%:*}" == "57" ]] || {
  echo "G33: expected the selected 57-migration manifest, got ${MIGRATIONS_BEFORE%%:*}" >&2
  exit 1
}
echo "G33_MIGRATION_MANIFEST count=${MIGRATIONS_BEFORE%%:*} fingerprint=${MIGRATIONS_BEFORE#*:}"

docker run --detach \
  --name "$APP" \
  --network "container:$POSTGRES" \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env-file "$PROD_ENV" \
  "$G33_APP_IMAGE" >/dev/null
CREATED_APP=1

probe_health() {
  docker run --rm \
    --network "container:$POSTGRES" \
    --entrypoint node \
    "$G33_APP_IMAGE" \
    --input-type=module \
    -e 'const deadline=Date.now()+120000; while(Date.now()<deadline){try{const r=await fetch("http://127.0.0.1:3000/healthz");if(r.status===200){console.log("G33_HEALTHZ status=200");process.exit(0)}}catch{} await new Promise(r=>setTimeout(r,1000))} console.error("G33_HEALTHZ timeout");process.exit(1)'
}
probe_readiness() {
  docker run --rm \
    --network "container:$POSTGRES" \
    --entrypoint node \
    "$G33_APP_IMAGE" \
    --input-type=module \
    -e 'const r=await fetch("http://127.0.0.1:3000/readyz");const text=await r.text();let body;try{body=JSON.parse(text)}catch{body={text:text.slice(0,1000)}};console.log("G33_PRODUCTION_READINESS status="+r.status+" body="+JSON.stringify(body));if(r.status!==503)process.exit(1)'
}

probe_health
probe_readiness
[[ "$(MIGRATION_FINGERPRINT)" == "$MIGRATIONS_BEFORE" ]] || {
  echo "G33: production startup changed the migration ledger" >&2
  exit 1
}
echo "G33_PRODUCTION_STARTUP_MIGRATIONS=unchanged"

docker stop --time 30 "$APP" >/dev/null
shutdown_code="$(docker inspect --format '{{.State.ExitCode}}' "$APP")"
echo "G33_PRODUCTION_CONTAINER_SHUTDOWN_EXIT=$shutdown_code"
[[ "$shutdown_code" == "0" ]] || {
  echo "G33: production container did not shut down cleanly" >&2
  exit 1
}
docker start "$APP" >/dev/null
probe_health
probe_readiness
[[ "$(MIGRATION_FINGERPRINT)" == "$MIGRATIONS_BEFORE" ]] || {
  echo "G33: production restart changed the migration ledger" >&2
  exit 1
}
echo "G33_PRODUCTION_RESTART_MIGRATIONS=unchanged"

docker rm "$APP" >/dev/null
CREATED_APP=0
docker run --detach \
  --name "$APP" \
  --network "container:$POSTGRES" \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env-file "$DEV_ENV" \
  "$G33_APP_IMAGE" >/dev/null
CREATED_APP=1
probe_health

docker run --detach \
  --name "$RUNNER" \
  --network "container:$POSTGRES" \
  --volume "$TEST_SNAPSHOT:/app/artifacts/api-server/test" \
  --volume "$HANDSHAKE:/g33" \
  --memory 1g \
  --cpus 2 \
  --pids-limit 256 \
  --env DINAR_LOCAL_PG="$PG_URL" \
  --env DINAR_SUITE_DB="$DB" \
  --env DINAR_SUITE_SEED=none \
  --env DINAR_SUITE_KEEP_DB=1 \
  --env DINAR_SUITE_REUSE_DB=1 \
  --entrypoint /bin/sh \
  "$G33_APP_IMAGE" \
  -lc 'cd /app/artifacts/api-server && sh test/isolation/local-suite.sh g33-docker-acceptance.test BDINAR_W08_ACCEPTANCE=development BDINAR_TEST_API_BASE=http://127.0.0.1:3000 BDINAR_G33_HANDSHAKE_DIR=/g33' >/dev/null
CREATED_RUNNER=1

ready=0
for _ in $(seq 1 600); do
  if [[ -f "$HANDSHAKE/transaction-ready" ]]; then
    ready=1
    break
  fi
  runner_state="$(docker inspect --format '{{.State.Status}}' "$RUNNER" 2>/dev/null || true)"
  if [[ "$runner_state" == "exited" ]]; then
    docker logs "$RUNNER" >&2
    echo "G33: transaction test exited before requesting the restart" >&2
    exit 1
  fi
  sleep 1
done
[[ "$ready" == "1" ]] || {
  docker logs "$RUNNER" >&2
  echo "G33: timed out waiting for the transaction/restart handshake" >&2
  exit 1
}
echo "G33_TRANSACTION=complete; restarting the isolated app container"

docker stop --time 30 "$APP" >/dev/null
shutdown_code="$(docker inspect --format '{{.State.ExitCode}}' "$APP")"
echo "G33_TEST_CONTAINER_SHUTDOWN_EXIT=$shutdown_code"
[[ "$shutdown_code" == "0" ]] || {
  docker logs "$APP" >&2
  echo "G33: test-mode app container did not shut down cleanly" >&2
  exit 1
}
docker start "$APP" >/dev/null
probe_health
[[ "$(MIGRATION_FINGERPRINT)" == "$MIGRATIONS_BEFORE" ]] || {
  echo "G33: test-mode app restart changed the migration ledger" >&2
  exit 1
}
printf 'restarted\n' >"$HANDSHAKE/restart-complete"

runner_exit="$(docker wait "$RUNNER")"
docker logs "$RUNNER"
[[ "$runner_exit" == "0" ]] || {
  echo "G33: Docker API cash journey failed with exit $runner_exit" >&2
  exit 1
}
echo "G33_CONTAINER_ACCEPTANCE=passed postgres=$G33_POSTGRES_IMAGE image=$G33_APP_IMAGE"
