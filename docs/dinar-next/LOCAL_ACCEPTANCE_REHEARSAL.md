# Reuse G33 locally without impersonating CI

The existing G33 runner supports an explicit local-disposable entry in addition to its unchanged real GitHub Actions entry. The application and TypeScript acceptance assertions are shared. This is a local rehearsal, not a GitHub Actions run, deployment or production readiness approval.

Local requirements: clean committed `codex/dinar-next-unified-development`, managed Docker Unix socket, official allowlisted PostgreSQL 16/18 images and an app image built from the exact checkout SHA. Refusals occur before Docker calls for dirty/wrong branches and mismatched image tags. The runtime uses an internal-only network, shared container namespace and resource limits; publishes no host ports; creates synthetic secrets only; removes only its own containers, anonymous PostgreSQL volume, network and temporary files. The driver never injects fake `GITHUB_*` run identity. CI retains its own ref/run checks.

From the repository root, in the managed Cloud environment with its configured proxy/CA:

```sh
node scripts/ci/g33-local-guards.test.mjs
task_sha=$(git rev-parse HEAD)
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
  -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock build \
  --build-arg PNPM_VERSION=10.30.3 \
  --secret id=proxy_ca,src="$CODEX_PROXY_CERT" \
  --tag "dinar-next-g33:$task_sha" .
DINAR_LOCAL_G33_ACCEPTANCE=disposable \
  G33_APP_IMAGE="dinar-next-g33:$task_sha" G33_POSTGRES_IMAGE=postgres:16 \
  bash scripts/ci/g33-docker-acceptance.sh
# Repeat the same invocation with G33_POSTGRES_IMAGE=postgres:18.
```

Keep configured proxy/registry credentials and `DOCKER_CONFIG` unchanged. Dockerfile CA mounts are optional, per dependency-network step; ordinary CI without that secret uses system trust. Node extends trust and honors the inherited proxy only for that step. Never copy a session CA into an image or disable TLS. Download failures require normal network/registry diagnosis, not host networking or a proxy bypass.

The G33 checks retain production-readiness refusal (503 for unapproved live configuration), unchanged migration fingerprints across startup/restart, disposable market-legal and Connect chains, the real simulated cash/commission journey and its app restart handshake. PostgreSQL 18 additionally runs release migration/concurrency checks. `artifacts/api-server/test/g33-docker-acceptance.test.ts` is unchanged. A generic single-suite database wrapper cannot stand in for this mounted app/container orchestration.

For other acceptance suites use `artifacts/api-server/test/isolation/local-suite.sh` and the exact suite's approval flag. Do not globally enable Wave4 payments when testing the negative unconfigured payment gate in `w06-d16-adversarial.test`. Market-legal acceptance starts with `DINAR_SUITE_SEED=none` (all markets initially inactive) and requires `DINAR_MARKET_LEGAL_TEST_FIXTURE=1`, `BDINAR_MARKET_LEGAL_ACCEPTANCE=development` and a fresh `dinar_test_legal_*` database. The four stock/spec acceptance flags are now named explicitly in the existing helper; all original loopback/disposable/development checks remain.

For recovery fixtures, assistant completion must contain `metadata.replyToMessageId` for the original recorded user turn. Persisted unanswered turns lock the composer and permit verification, not replay. An absent turn may retry with its original identity. Long-stream UI checks should bound the wait and verify the owned persisted user/assistant correlation; a browser transport handle alone is not proof of execution completion.

See `CODEX_COMPLETE_LOCAL_ACCEPTANCE.md` for actual runs, initial red evidence, retries, source revisions, skips and external blockers. A command documented here is not itself a passing run.
