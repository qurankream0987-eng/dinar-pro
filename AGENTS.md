# Instructions for AI coding agents (Qoder, Codex, Cursor, any other)

Before any change, read in this order, completely:

1. `CLAUDE.md` — project rules, invariants, environment rules, how to run tests. Binding.
2. `docs/qoder/00_START_HERE.md` — the agent pack: where DINAR is going, what is done, the
   commands to execute in order, and the evidence required.
3. `docs/qoder/GUARDRAILS.md` — what must never be broken. Violations are reverted at review.

Base branch: `replit/dinar-next-complete-development`, frozen at the exact SHA each mission records
(not `main`, and not a historical `claude/*` or `qoder/*` branch). One branch per task:
`qoder/<NN>-<topic>`.
Never push to `main`, never merge, never force-push, never deploy, never call a paid model or a
real payment provider, never connect to a non-loopback database.
