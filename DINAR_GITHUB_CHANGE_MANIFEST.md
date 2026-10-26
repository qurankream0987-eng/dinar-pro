# DINAR GitHub handoff — source and change manifest

## Current candidate source

- Development branch: `feature/dinar-next-google`
- Accepted application branch preserved: `google-development` at
  `7666ddfae3ad17b207f08bdc832d49dd7d5c71d0`
- Candidate accepted baseline for handoff: `8aff1df` (P0/P1 integration work);
  it is an ancestor of the current candidate.
- Recent candidate commits after that baseline:
  - `335684d` — integration phase execution records
  - `c79abad` — Gemini guidance and safe read-only launcher
  - `7666ddf` — AI chat interface and styling
- No GitHub repository remote is configured. Replit internal workspace/backup
  remotes are not publication destinations.
- Security updates in this working branch pin `proxy-addr` 2.0.8,
  `source-map-js` 1.2.2, and `postcss-selector-parser` 7.1.6 through scoped
  workspace overrides. `pnpm-lock.yaml` was regenerated.

## Source architecture to preserve

- `artifacts/dinar/` — Arabic RTL React/Vite client and marketplace experience.
- `artifacts/api-server/` — Express API, conversation runtime, and canonical
  service layer.
- `lib/api-spec/`, `lib/api-zod/`, `lib/api-client-react/` — API contracts and
  generated client/schema packages.
- `lib/db/` — PostgreSQL schema and migrations.
- `lib/global/` — shared packages.
- `docs/`, `scripts/`, and the test trees — product guidance, verification
  helpers, and automated acceptance coverage.

## Candidate delta from `8aff1df`

| Path | Purpose |
| --- | --- |
| `GEMINI.md` | Development constraints and architecture context for a separate, read-only Gemini CLI workflow. |
| `scripts/gemini-safe.sh` | Removes runtime credential/database variables before starting Gemini CLI in plan mode. |
| `artifacts/dinar/src/pages/Ai.tsx` | Chat/history and viewport interaction updates. |
| `artifacts/dinar/src/pages/AiChat.css` | Arabic RTL chat, history, surface, and responsive styling. |
| `attached_assets/*EXECUTION_REC*.txt` | Project execution/acceptance records already tracked in the candidate history. |

This handoff adds `DINAR_GOOGLE_AI_STUDIO_GUIDE.md`,
`DINAR_GITHUB_CHANGE_MANIFEST.md`, and local database/environment ignore rules.
Security remediation also updates `pnpm-workspace.yaml` and `pnpm-lock.yaml`.
The attached owner directives remain unmodified, untracked user files.

## Publication blockers

- The GitHub App connector successfully listed private repositories without a
  `gh` login. A private repository was visible, but the owner has not selected
  it as DINAR's destination. No repository was created and no remote was added.
- `.opencode/opencode.db` and its SQLite journal files appear in one historical
  commit. A local, read-only inspection found 16 nonempty stored message parts.
  No common API-key, bearer-token, private-key, email, or credential-URL pattern
  was found in the SQLite content. Treat the stored conversations as sensitive;
  a sanitized export must remove all three database/journal paths from export
  history. The source repository and its history remain untouched.
- Local history scanning found no common private-key, API-token, or bearer-token
  shapes. Fourteen credential-bearing URL patterns occur only in database/TLS
  test files; these remain under review as test fixtures. No tracked or local
  `.env*` files were found. OCR number matches in tracked UI screenshots were
  not confirmed as personal phone numbers.
- Dependency audit after the version pins: zero findings. SAST: zero findings.
  HoundDog still fails with `HOUNDDOG_SCHEMA_MISMATCH`; local non-disclosing
  scanning is documented as a fallback, not as a HoundDog pass.
- Typecheck, Dinar frontend build, API build, and the 8-test database-safety
  guard suite pass. Focused dependency probes pass (three proxy-address
  assertions and one selector-parser assertion).

See `DINAR_GITHUB_EXPORT_PLAN.md` for the isolated export method, commit mapping,
and restoration instructions. No sanitized export or push has been created.
Do not create a public repository or push until the owner selects the private
destination and confirms the export plan.
