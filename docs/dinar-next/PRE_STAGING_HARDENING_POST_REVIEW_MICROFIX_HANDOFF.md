# DINAR pre-staging hardening post-review microfix handoff

Date: 2026-11-08
Base: `ff09f6bb5482b75fb2db19a5a28bccb72464a315`
Branch: `replit/dinar-pre-staging-hardening-post-review-microfix`

This is a separate, local-only branch and worktree. It contains only the confirmed
post-review hardening changes and this verification report. No push, merge, deployment,
production database, Railway service, live AI provider, or real SMS provider was used.

## Changes

- Set `CI=true` for the frozen, offline production dependency install so Docker pruning
  cannot wait for interactive confirmation. Added a final runtime stage that copies only
  the pruned application filesystem, rather than retaining the full-install builder layers.
- Excluded documentation, CI/development scripts, release-migration tests, and rehearsal
  files from the Docker build context.
- Normalize OpenRouter endpoint hostnames using the URL hostname, case-folding, and
  trailing-dot removal before applying production privacy and routing checks. Regression
  cases cover uppercase hostnames, terminal DNS dots, ports, and lookalike suffixes.
- Documented invoking the release migration entry point directly with Node in the
  production container, without Corepack or pnpm.
- Expanded the Docker regression test to build the image non-interactively, verify the
  excluded files are absent, run the direct migration CLI far enough to confirm module
  resolution before its expected acknowledgement refusal, and start/stop the runtime
  container with networking disabled.

## Verification

- `pnpm run typecheck` — passed.
- `pnpm run build` — passed. Vite emitted a non-failing large-chunk warning.
- `node --test scripts/ci/docker-runtime.test.mjs` — 3/3 passed, including the real image
  build and isolated container lifecycle. The new image measured **694.9 MiB**, versus the
  prior candidate's **1,191,619,412 bytes** (about **38.9% smaller**). The test removed its
  temporary image and container.
- Release-migration and concurrency tests — **12/12 passed** on a newly initialized,
  disposable PostgreSQL **18.6** loopback cluster. The cluster and temporary data directory
  were removed afterward.
- `gemma-gateway-readiness.test` — **11/11 passed**, including the new hostname cases.
- `visual-search.test` — **11/11 passed**.
- `closure-privacy.test` — **12/12 passed** with the disposable acceptance fixtures.
- All three API suites ran with **zero outbound network attempts**. An initial
  closure/privacy run without fixtures stopped at the expected inactive-market guard;
  rerunning with the required local fixtures passed.

PostgreSQL 16 qualification was not run, to avoid interfering with the separate
qualification work. No existing worktree was modified.

## Handoff

Review the branch and report, then cherry-pick only if accepted. This branch has not been
pushed.
