# Recovered environment and completed local qualification

Recovered branch: `codex/dinar-next-functional-audit`, same worktree `/workspace/dinar-next-functional-audit`.
Starting recovered SHA: `4c09d8a12f9a25d9b3bdbc93877c0fdbe0f037eb`.
Tested source after one test/fixture-only correction: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`.

The existing workspace, Git history/reflog, three worktrees, uncommitted-state inventory, evidence, PostgreSQL data directories and Docker images were recovered. No replacement clone, reset, clean, rebase, forced push, merge, deployment or production access occurred. The original tracked audit tree was clean. Main/work and the published Codex development checkout remain unchanged.

The executor initially failed its capability-configuration query. When it became ready, /workspace and /tmp were readable and retained storage was present. Old test, relay and PostgreSQL processes were absent; Docker and13images remained. Session expiry, quota, compute shutdown and storage deletion were not established as root causes. No evidence supports declaring data lost.

Original PostgreSQL16.15 and18.1 clusters were restarted from their existing data directories on loopback ports55416/55433. No initdb or volume deletion was used. Private0700relay directories/0600sockets preserve genuine127.0.0.1TCP client/server identity. Stronger sit0 isolation remains unsupported; the separately identified veth executor has no default/external route. A recovery proof serializer failed after successful SQL checks; its original helper was preserved and a corrected output writer succeeded.

## Preserved chronology

| Attempt | Actual result and disposition |
| --- | --- |
| Original interrupted4c |121finished:120PASS,1DB-transportFAIL; two other unfinished logs. The failed PG18XP log records ECONNREFUSED and API500/503 during disruption. Not350 |
| Recovery4c |319finished:318PASS,1external-demo-image DNS fixture failure. All original logs/rows retained |
| Focused correction | Legacy tagged demo media no longer depends on an external CDN; production media unchanged. Canonical Phase1 passed83browserchecks on eachPG, strict0consoleerrors, genuine uploaded photos decoded |
| New frozen5121 |350/350groups PASS,175perPG;3548passing cases,0failures,2explicit development-TLS skips,0outbound attempts |
| New programme and supplements |17/17phases PASS;10/10additional UI groups PASS. All processes completed before documentation changed |

Old evidence, progress logs and stale socket directory are preserved under the recovery interrupted-attempt directory. Its ARCHIVE_PATH_MAP.json disambiguates old absolute log paths from later files. Global temporary XP evidence was copied before fresh runs. Abandoned interrupted disposable databases remain retained; subsequent attempts used distinct database names. Only newly created completed-test databases/dumps were cleaned by their canonical test harnesses.

At initial recovery,12local audit commits were absent from all50advertised remote heads. The new fixture-only correction makes13source audit commits beyond the published foundation, before a separate documentation-only delivery commit. Both original4c and frozen5121complete-history bundles were created and verified. Original4cbundle SHA256:c5b392e07767c0114bccd45614ae6cabbf4d556860442cdf7fa3ffbf768df38c. These are current-audit backups, not recovery of the missing original V2artifact.

The preserved initial inventory/report is included under [environment-recovery evidence](evidence/functional-audit/final/environment-recovery/RECOVERY_REPORT.md); its running/pending statements describe that earlier checkpoint. The current authoritative outcomes are [fresh qualification](CODEX_FINAL_FRESH_TEST_EVIDENCE.md), [readiness](CODEX_FINAL_READINESS_MATRIX.md) and [Claude handoff](CODEX_UPDATED_CLAUDE_HANDOFF.md).

Original V2provenance remains BLOCKED pending the genuine original task/bundle; not declared lost or reconstructed. Current delivery is LOCAL_ONLY. No push, merge, deployment, production database, paid model or live payment is authorized or performed.
