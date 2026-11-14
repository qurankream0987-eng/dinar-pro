import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = process.env.G33_GUARD_SCRIPT ?? fileURLToPath(new URL('./g33-docker-acceptance.sh', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'dinar-g33-guards-'));
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  mkdirSync(path.join(temp, 'scripts/ci'), { recursive: true });
  mkdirSync(path.join(temp, 'artifacts/api-server/test/isolation'), { recursive: true });
  mkdirSync(path.join(temp, 'bin'));
  const script = path.join(temp, 'scripts/ci/g33-docker-acceptance.sh');
  copyFileSync(source, script);
  writeFileSync(path.join(temp, 'Dockerfile'), 'FROM scratch\n');
  git('init', '-b', 'codex/dinar-next-unified-development');
  git('add', 'scripts', 'Dockerfile');
  git('-c', 'user.name=DINAR guard fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Disposable guard fixture');
  const sha = git('rev-parse', 'HEAD');
  const marker = path.join(temp, 'docker-called');
  writeFileSync(path.join(temp, 'bin/docker'), '#!/bin/sh\n[ -z "${DOCKER_HOST+x}${DOCKER_CONTEXT+x}${DOCKER_TLS+x}${DOCKER_TLS_VERIFY+x}${DOCKER_CERT_PATH+x}" ] || exit 97\n[ -z "${GITHUB_RUN_ID+x}${GITHUB_SHA+x}" ] || exit 98\nprintf "%s\\n" "$@" > "$G33_GUARD_MARKER"\nexit 99\n', { mode: 0o755 });
  // Ignore only disposable test instruments; the copied source must be committed and clean.
  writeFileSync(path.join(temp, '.git/info/exclude'), 'bin/\ndocker-called\n');
  const base = { PATH: `${temp}/bin:${process.env.PATH}`, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), G33_APP_IMAGE: `dinar-next-g33:${sha}`, G33_POSTGRES_IMAGE: 'postgres:16', G33_GUARD_MARKER: marker };
  const run = (extra = {}) => spawnSync('bash', [script], { cwd: temp, env: { ...base, ...extra }, encoding: 'utf8', timeout: 10000 });
  const denied = (extra, pattern) => {
    const result = run(extra);
    assert.equal(result.status, 96, result.stderr);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(marker), false, 'rejection must occur before any Docker command');
  };
  await test('G33 refuses implicit local execution', () => denied({}, /explicit DINAR_LOCAL_G33_ACCEPTANCE/));
  await test('G33 preserves CI branch and run identity checks', () => {
    denied({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }, /outside.*allowlist/);
    denied({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/codex/dinar-next-unified-development', GITHUB_RUN_ID: 'not-a-run', GITHUB_RUN_ATTEMPT: '1' }, /invalid GitHub run identity/);
  });
  await test('G33 refuses a local contributor branch', () => {
    git('switch', '-c', 'claude/fixture');
    denied({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable' }, /authorized development branch/);
    git('switch', 'codex/dinar-next-unified-development');
  });
  await test('G33 refuses uncommitted local sources', () => {
    writeFileSync(path.join(temp, 'dirty'), 'uncommitted');
    denied({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable' }, /clean committed checkout/);
    rmSync(path.join(temp, 'dirty'));
  });
  await test('G33 binds image identity and limits PostgreSQL versions', () => {
    denied({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable', G33_APP_IMAGE: 'dinar-next-g33:wrong' }, /tag must match/);
    denied({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable', G33_POSTGRES_IMAGE: 'postgres:latest' }, /must be allowlisted/);
  });
  await test('G33 permits only the explicitly owner-authorized local audit branch with the same identity guards', () => {
    git('switch', '-c', 'codex/dinar-next-functional-audit');
    const result = run({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable' });
    assert.equal(result.status, 99, result.stderr);
    assert.match(result.stdout, /G33_EXECUTION_MODE=LOCAL_DISPOSABLE/);
    assert.match(result.stdout, new RegExp(`source=${sha}`));
    assert.equal(readFileSync(marker, 'utf8'), '--host=unix:///var/run/docker.sock\npull\npostgres:16\n');
    rmSync(marker);
    git('switch', 'codex/dinar-next-unified-development');
  });
  await test('G33 permits the owner-authorized release candidate locally (2026-11-14) with the same identity guards', () => {
    git('switch', '-c', 'claude/jassimai-release-candidate-2');
    const result = run({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable' });
    assert.equal(result.status, 99, result.stderr);
    assert.match(result.stdout, /G33_EXECUTION_MODE=LOCAL_DISPOSABLE/);
    assert.match(result.stdout, new RegExp(`source=${sha}`));
    rmSync(marker);
    git('switch', 'codex/dinar-next-unified-development');
  });
  await test('G33 still refuses a similarly named branch and the release candidate in CI', () => {
    git('switch', '-c', 'claude/jassimai-release-candidate-3');
    denied({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable' }, /authorized development branch/);
    git('switch', 'codex/dinar-next-unified-development');
    denied({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/claude/jassimai-release-candidate-2', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' }, /outside the isolated candidate/);
  });
  await test('G33 explicit local mode clears inherited Docker selectors and creates no CI identity', () => {
    const result = run({ DINAR_LOCAL_G33_ACCEPTANCE: 'disposable', DOCKER_HOST: 'tcp://invalid.example:2376', DOCKER_CONTEXT: 'foreign', DOCKER_TLS: '1', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/not-used' });
    assert.equal(result.status, 99, result.stderr);
    assert.match(result.stdout, /G33_EXECUTION_MODE=LOCAL_DISPOSABLE/);
    assert.equal(readFileSync(marker, 'utf8'), '--host=unix:///var/run/docker.sock\npull\npostgres:16\n');
    const beforeDocker = result.stdout.match(/source=([0-9a-f]{40})/);
    assert.equal(beforeDocker?.[1], sha);
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
