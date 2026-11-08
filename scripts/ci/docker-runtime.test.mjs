import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = readFileSync(path.join(repositoryRoot, "Dockerfile"), "utf8");
const dockerignore = readFileSync(path.join(repositoryRoot, ".dockerignore"), "utf8");
const dockerProbe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  timeout: 5_000,
});
const dockerAvailable = !dockerProbe.error && dockerProbe.status === 0;
const imageTag = `dinar-runtime-regression:${process.pid}`;
const containerName = `dinar-runtime-smoke-${process.pid}`;

function runDocker(args, timeout = 30_000) {
  return spawnSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: "",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
}

function output(result) {
  return `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-12_000);
}

test("runtime dependencies are pruned only after both production artifacts are built", () => {
  const webBuild = dockerfile.indexOf("pnpm --filter @workspace/dinar run build");
  const apiBuild = dockerfile.indexOf("pnpm --filter @workspace/api-server run build");
  const productionInstall = dockerfile.indexOf("pnpm install --prod --frozen-lockfile");
  assert.ok(webBuild >= 0 && apiBuild > webBuild, "frontend and API build before dependency pruning");
  assert.ok(productionInstall > apiBuild, "runtime install follows both builds");
  assert.match(dockerfile, /RUN CI=true pnpm install --prod --frozen-lockfile --offline/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS builder/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS runtime/);
  assert.match(dockerfile, /COPY --from=builder --chown=node:node \/app\/ \/app\//);
  assert.equal(dockerfile.includes("--no-frozen-lockfile"), false);
});

test("runtime stays non-root and serves the same built frontend/API paths", () => {
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /ENV DINAR_WEB_DIST=\/app\/artifacts\/dinar\/dist\/public/);
  assert.match(dockerfile, /WORKDIR \/app\/artifacts\/api-server/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /dist\/index\.mjs/);
  for (const path of ["/docs", "/.github", "/scripts/ci", "/lib/db/scripts/*.test.mjs"])
    assert.ok(dockerignore.includes(path), `Docker context excludes ${path}`);
});

test(
  "a real non-interactive image build, direct migration CLI, and container lifecycle work when Docker is available",
  { skip: dockerAvailable ? false : "Docker daemon is unavailable" },
  async (t) => {
    try {
      const build = runDocker(
        ["build", "--progress=plain", "--secret", "id=proxy_ca,src=/dev/null", "--tag", imageTag, "."],
        20 * 60 * 1000,
      );
      assert.equal(build.status, 0, `Docker build failed:\n${output(build)}`);

      const imageSize = runDocker(["image", "inspect", imageTag, "--format", "{{.Size}}"]);
      assert.equal(imageSize.status, 0, `Could not inspect built image:\n${output(imageSize)}`);
      const sizeBytes = Number(imageSize.stdout.trim());
      assert.ok(Number.isFinite(sizeBytes) && sizeBytes > 0);
      t.diagnostic(`Built runtime image size: ${(sizeBytes / 1024 / 1024).toFixed(1)} MiB`);

      const excludedFiles = runDocker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        imageTag,
        "-c",
        "test ! -e /app/docs && test ! -e /app/.github && test ! -e /app/scripts/ci && test ! -e /app/scripts/post-merge.sh && test ! -e /app/lib/db/scripts/release-migration.test.mjs && test ! -e /app/lib/db/scripts/rehearsal",
      ]);
      assert.equal(excludedFiles.status, 0, `Development/documentation files remained in runtime image:\n${output(excludedFiles)}`);

      const migrationCli = runDocker([
        "run",
        "--rm",
        "--network",
        "none",
        "--env",
        "NODE_ENV=production",
        "--env",
        "DINAR_DEPLOYMENT_ENV=staging",
        "--env",
        "DINAR_MIGRATION_TARGET=staging",
        "--env",
        "DINAR_MIGRATION_EXPECTED_DATABASE=dinar_migration_container_smoke",
        "--env",
        "DATABASE_URL=postgresql://smoke:smoke@127.0.0.1:5432/dinar_migration_container_smoke",
        "--entrypoint",
        "node",
        imageTag,
        "--experimental-strip-types",
        "/app/lib/db/scripts/migrate-release.mjs",
      ]);
      assert.equal(migrationCli.status, 1, `Migration CLI should refuse before connecting without an acknowledgement:\n${output(migrationCli)}`);
      assert.match(migrationCli.stderr, /"code":"ACK"/);
      assert.doesNotMatch(migrationCli.stderr, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);

      const start = runDocker([
        "run",
        "--detach",
        "--network",
        "none",
        "--name",
        containerName,
        "--env",
        "PORT=3000",
        "--env",
        "DINAR_DEPLOYMENT_ENV=staging",
        "--env",
        "SESSION_SECRET=local-docker-smoke-session-not-a-secret",
        "--env",
        "REPLIT_DEPLOYMENT=local-docker-smoke",
        "--env",
        "PRIVATE_OBJECT_DIR=/dinar-smoke/private",
        "--env",
        "PUBLIC_OBJECT_SEARCH_PATHS=/dinar-smoke/public",
        "--env",
        "DATABASE_URL=postgresql://smoke:smoke@127.0.0.1:5432/dinar_container_smoke",
        imageTag,
      ]);
      assert.equal(start.status, 0, `Could not start runtime container:\n${output(start)}`);

      let logs = "";
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const currentLogs = runDocker(["logs", containerName], 5_000);
        logs = `${currentLogs.stdout ?? ""}\n${currentLogs.stderr ?? ""}`;
        if (logs.includes("Server listening")) break;
        const state = runDocker(["inspect", "--format", "{{.State.Status}}", containerName], 5_000);
        if (state.status === 0 && state.stdout.trim() !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.match(logs, /Server listening/, `Runtime container did not become live:\n${logs.slice(-8_000)}`);

      const stop = runDocker(["stop", "--time", "10", containerName], 20_000);
      assert.equal(stop.status, 0, `Could not stop runtime container:\n${output(stop)}`);
      const state = runDocker(["inspect", "--format", "{{.State.Status}}:{{.State.ExitCode}}", containerName]);
      assert.equal(state.stdout.trim(), "exited:0", `Runtime container did not shut down cleanly:\n${output(state)}`);
    } finally {
      runDocker(["rm", "--force", containerName], 10_000);
      runDocker(["image", "rm", "--force", imageTag], 30_000);
    }
  },
);
