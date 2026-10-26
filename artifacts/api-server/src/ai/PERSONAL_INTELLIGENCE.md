# DINAR personal intelligence

`PersonalContextService` is the single private memory authority. The authenticated conversation runtime verifies both conversation ownership and the user message before calling it. All table reads and writes scope to that owner. Memory has no marketplace or financial execution authority.

The canonical model separates eight kinds: session context, explicit preferences, inferred interests, negative preferences, behavioral signals, long-term facts, conversation style, and recent context. Topics have normalized identities and parent links; an unknown topic can use a normalized generic identity without schema changes. The alias catalog is data, not user-specific branching.

User interaction → deterministic candidates → optional structured candidates from the existing enabled OpenAI gateway → schema, evidence and privacy validation → confidence policy → transactional persistence. AI can propose inferred topic candidates only; it cannot set explicit preferences, facts, style, corrections or confidence. Candidate evidence is checked then discarded. No conversation bodies are copied into the memory tables.

Inferred confidence starts at 0.18, increases with distinct events, and is capped at 0.9. Explicit preferences have confidence 0.98. Retrieval excludes one-shot inferences. Confidence decays with half-lives of 90 days for inferred interests, 730 days for explicit preferences, 14 days for recent context and one day for session context. Session memory requires the matching conversation ID. Repeated signals include derived REPEATED_TOPIC provenance.

All owner mutations use a transaction-scoped advisory lock. Unique owner/event/topic/kind receipts prevent duplicate counting. Forgetting removes the topic branch and its provenance, preserving only minimal retired-event receipts and a suppression tombstone to prevent old processing from restoring it. A new explicit statement can restore a preference. Explicit rejections suppress descendant inferences. A correction that the search was for a friend removes inferred memory while preserving previously explicit preferences.

Retrieval returns at most six relevant records, deduplicates topic identities and excludes unrelated siblings when the current request names a specific brand or topic. Current user intent always wins. The existing model context receives only this relevant subset. Conversation continuation and review/add/update/forget commands use the same runtime and Arabic RTL surfaces. General knowledge, marketplace constraints, organic ranking, paid labels and all action authorization remain under their existing deterministic authorities.

Privacy validation rejects recognized sensitive traits and secret/location/identity/payment material before deterministic or AI extraction and again on candidates. The general health and fitness topics describe content interests only. This defense is conservative and can reject mixed messages containing sensitive material; the acceptance counters measure the tested fixtures, not a universal guarantee for every possible wording. Behavioral source adapters must call this service with server-derived identity and source, never treat listing/provider text as explicit user preferences.

Migration `0027_personal_intelligence` is forward-only and adds three private tables. It was tested through the canonical migrator on disposable loopback PostgreSQL, including an idempotent rerun. It has not been applied to Railway or a managed environment. Before deployment, the environment owner must confirm the live catalog and migration ledger, then apply it through the existing canonical migration runner. No database URL or infrastructure setting needs changing.

Acceptance command, with a disposable PostgreSQL cluster listening on loopback port 55479:

```sh
DINAR_PERSONAL_TEST_DATABASE_URL=postgresql://runner@127.0.0.1:55479/postgres pnpm --filter @workspace/api-server exec node test/run.mjs personal-intelligence.test
pnpm run build
```

The test injects its own pool and never overrides DATABASE_URL or DINAR_DEV_DATABASE_URL. It covers the separated topic domains, durable explicit memory, confidence accumulation/decay, concurrent deduplication, negative and current-intent overrides, relevance, forgetting/replay, correction, purchase-history control, privacy, user isolation, generated API validation, RTL rendering and the existing conversation runtime.
