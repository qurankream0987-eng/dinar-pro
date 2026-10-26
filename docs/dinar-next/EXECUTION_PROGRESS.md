# DINAR NEXT — Execution Progress

Resume rule: reconcile this file with `git log` / `git status` before acting; trust the code over this file.

| Phase | Status | Checkpoint |
|---|---|---|
| 00 | DONE (baseline `f60e30d`, see `00-baseline.md`) | tag `dinar-next-baseline-20261019` |
| A | VERIFIED (development) | commit "DINAR NEXT A: …" on `main` |
| B | VERIFIED (development) | commit "DINAR NEXT B: …" |
| C | VERIFIED (development) | commit "DINAR NEXT C: …" |
| D | VERIFIED (browser part in E) | commit "DINAR NEXT D: …" |
| E | VERIFIED (development, browser) | commit "DINAR NEXT E: …" |
| F | VERIFIED (development; phase1 UI script stale) | commit "DINAR NEXT F: …" |
| FINAL | PARTIALLY VERIFIED (see FINAL_ACCEPTANCE.md §7–8) | commit "DINAR NEXT FINAL: …" |
| G0 | DONE — `G0_EXISTING_CAPABILITY_AUDIT.md` | commit "DINAR NEXT G0+G1: …" |
| G1 | VERIFIED (development): usage ledger, tiers, guard, conversation usage/plans; next-g1-usage 21/21 | commit "DINAR NEXT G0+G1: …" |
| G2 | VERIFIED (development): inquiry authority, adapter, in-app delivery, surfaces; next-g2-inquiry 17/17 | commit "DINAR NEXT G2: …" |
| G3 | VERIFIED (development, browser) — `G3_FINAL_ACCEPTANCE.md`; 49 suites 768/0/1 | commit "DINAR NEXT G3: …" |

## Current

- G0–G3 program (`DINAR_NEXT_G0_G3_COMMANDS.md` + `DINAR_NEXT_CONVERSATION_FIRST_PRODUCT_AUTHORITY.md`).
- G1 done: migration `0035_ai_usage_allowances`, `lib/ai-usage.ts`, `lib/ai-usage-policy.ts`, `ai/usage-turn.ts`,
  `ai/usage-intent.ts`; metering in `smart-turn.ts` (signed-in), `routes/ai.ts` (guest), `listing-draft.ts` (images).
- G2 done: migration `0036_marketplace_inquiries`, `lib/inquiries.ts`, `ai/inquiry-turn.ts`, action
  `SEND_INQUIRY_MESSAGE` in `action-foundation.ts`, client `InquirySurface.tsx`.
- G3 done: `ai/seller-sales.ts` (SALES insight), `next-g3-acceptance` (+ browser `dinar/test/next-g3-browser.mjs`),
  full regression. Remaining items are owner decisions or external integrations (`G3_FINAL_ACCEPTANCE.md` §6).
- Session harness (scratchpad, not committed): `pg.sh` (loopback PG16 :55432, templates migrated to head) and
  `suite.sh <name>` (one suite per fresh clone with its npm-script flags).

## Outstanding

- Provider: Repl default `GROQ` key → 401; working path `DINAR_AI_PROVIDER=REPLIT_OPENAI` (owner switch).
- S-1 (baseline): leaked token in `.replit` / HEAD history — owner must revoke; not touched here.
- Stale test: phase1 UI script (pre-conversation publish path).

## Environment notes

Disposable PostgreSQL lives in the session scratchpad and disappears with the session; recreate with the
procedure in `00-baseline.md` §6 / `EXECUTION_CONTEXT.md`.
