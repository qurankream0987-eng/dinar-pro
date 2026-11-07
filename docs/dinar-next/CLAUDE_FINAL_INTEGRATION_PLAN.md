# Claude ↔ Codex final integration plan (draft, not executed)

**Status:** plan only.
- Codex is still developing `codex/dinar-next-unified-development`.
- No merge into `main` or into the Codex branch is authorized.
- No merge is performed until the owner approves the joint integration.

## 1. Branches and preservation

| Branch | Role | Rule |
|---|---|---|
| `codex/dinar-next-unified-development` | Platform development (Codex). Last inspected: `4143314` | Never rewritten by Claude |
| `claude/dinar-next-intelligence` | Intelligence work (Claude). Merge base `34bb754`. Draft PR #6 | Pushed milestones only, no force-push |
| `replit/dinar-next-six-wave-unification`, historical `qoder/*`, `claude/*`, `codex/*` | History | Kept; no deletion, no wholesale import |

The joint candidate is built on a **new** branch from Codex's final published head. Claude's commits are then brought in with `git merge --no-ff` of `claude/dinar-next-intelligence`, not rebase or squash, so both histories and every original SHA stay reachable.

## 2. Migrations

**Claude has added no migration.** The chain stays exactly Codex's: `0000`…`0059` as of `34bb754`, plus any Codex adds later.

**Integration checks:**
- tag uniqueness;
- monotonic `when`;
- sha256 in `release-manifest.json` and `clone-migration-guard.ts`;
- the head tag in `development-tls` and `readiness`;
- fresh install plus upgrade on disposable PostgreSQL 16 and 18;
- `lib/db test:release-migration` on PostgreSQL 18.

No migration file is renumbered or edited.

## 3. Known overlap and how it resolves

| File | Claude | Codex | Resolution |
|---|---|---|---|
| `lib/api-spec/openapi.yaml` | `CAPABILITIES` surface token | Connect diagnostics paths/schema | Keep both in the authored spec, then run codegen **once** |
| `lib/api-zod/src/generated/*`, `lib/api-client-react/src/generated/*` | generated | generated | Regenerate; never copy one side's generated tree |
| `artifacts/dinar/test/connect-finance-ui.mjs` | canonical `datetime-local` value | diagnostics assertions | Different lines. `git merge-tree` reports no conflict |

`git merge-tree` of the two heads at the time of writing reports no textual conflict. Re-run it at integration time.

**Semantic watch list:**
- Model tool registry, capability registry (22 entries) and their counts in the AI tests: Codex must not add a second registry. New platform reads become capabilities through `tool-registry.ts` / `capability-registry.ts`.
- `ai/business-turn.ts`: Claude added the advisory/compound guard and the model-prepared action entry. Any Codex D3-A change must keep `executeBusinessTurn` the single authority.
- `pages/Ai.tsx`: Claude bounded the verification block to `VERIFICATION_BLOCK_MS`. Codex owns the V2 stream/recovery design; the bound must survive.
- `test/isolation/local-suite.sh`: Claude added `images.unsplash.com` to the browser stub map. Keep it alongside any Codex host maps.

## 4. Acceptance on the joint SHA (required before the owner's merge decision)

1. Typecheck, API and web builds, `test:surfaces`, codegen reproducibility (`git diff --exit-code` after codegen).
2. Full battery: every `test/*.test.ts`, each with its own required flags/runner, first attempt recorded. A clean environment means:
   - no hand-started stub on port 443;
   - `DINAR_CHROMIUM` set;
   - the API built to `dist/` for multi-process suites;
   - the dedicated runners for `market-legal` and the D16 chain.
3. Intelligence: `intelligence-capabilities`, `capability-init-order`, and `intelligence-routing-eval` in LEGACY, HYBRID and MODEL_FIRST.
4. Browser journeys in isolation, one at a time: all `w02u3-*`, `conversation-*`, `connect-*`, `phase1`, `d1-d2-business-browser`, `d3a-browser-journey`.
5. Migration checks above on PostgreSQL 16 and 18.
6. GitHub Actions on the joint SHA once billing is restored, including **G33 Docker**, which can only run inside Actions.

## 5. Open gates (not closed by engineering)

| Gate | State |
|---|---|
| **G33 Docker CI** | BLOCKED: the G33 script runs only inside GitHub Actions, and Actions is blocked by account billing. Local substitute evidence: the production image built from the repository Dockerfile (plus sandbox CA only) serves `/api/healthz` 200, `/` 200 and `/api/markets` 200 on a migrated disposable DB with loopback S3 |
| **Live phone verification** | NOT CONFIGURED. `/api/readyz` stays 503 with `phoneVerification: not_configured` until an SMS provider and its credentials are approved and set. This is correct fail-closed behaviour, not a defect |
| Live model provider | Not selected. The routing evaluation is scripted (orchestration only). Live comprehension needs an approved provider and budget |
| Payments, settlements, partner commissions | Simulation only. No live provider |
| Railway staging | Not created, needs the owner's approval. Under `DINAR_DEPLOYMENT_ENV` set to `staging` or `production`, the CSP lets only `'self'` frame DINAR |
