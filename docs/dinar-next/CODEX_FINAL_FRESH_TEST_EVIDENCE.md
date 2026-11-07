# Fresh immutable-source acceptance evidence

Tested application and canonical acceptance source: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`. Local branch `codex/dinar-next-functional-audit`; preserved published foundation `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`. A later documentation/evidence-only delivery SHA must be identified separately; these results are not retroactively assigned to it.

Fresh immutable-source qualification: **350/350 groups PASS** (175 on PostgreSQL16,175 on18), **3548 passing case executions**,0failed cases,2 explicitly skipped development-TLS remote checks,0outbound attempts. All17 program phases and10 additional UI groups passed. These are local deterministic contracts and actual Chromium/API/disposable-database journeys, not live-provider or production approval.

| Phase | Result | Seconds |
| --- | --- | ---: |
| codegen | PASS | 2.48 |
| generated-drift | PASS | 0.0 |
| typecheck | PASS | 4.91 |
| api-build | PASS | 1.02 |
| web-build | PASS | 5.1 |
| g33-guards | PASS | 0.21 |
| regular-350 | PASS | 4154.47 |
| g33-image-build | PASS | 39.18 |
| g33-pg16 | PASS | 208.43 |
| g33-pg18 | PASS | 269.37 |
| supported-specials | PASS | 2.98 |
| personal-pg16 | PASS | 4.6 |
| personal-pg18 | PASS | 4.34 |
| backup-pg16 | PASS | 12.56 |
| backup-pg18 | PASS | 11.72 |
| search-100k-pg16 | PASS | 90.41 |
| search-100k-pg18 | PASS | 91.25 |

## Additional real UI groups

These10groups are additional acceptance, never added to the350 denominator. All reuse the current application/API and disposable PostgreSQL.

| PG | Group | Cases passed | Additional geometry profiles |
| --- | --- | ---: | --- |
| 16 | account-ui / canonical scenario | 2 | see browser report |
| 18 | account-ui / canonical scenario | 2 | see browser report |
| 16 | expanded-connect / connect-cards | 2 | 36 |
| 18 | expanded-connect / connect-cards | 2 | 36 |
| 16 | expanded-connect / connect-finance | 1 | 126 |
| 18 | expanded-connect / connect-finance | 1 | 126 |
| 16 | expanded-driver / canonical scenario | 48 | see browser report |
| 18 | expanded-driver / canonical scenario | 48 | see browser report |
| 16 | inline-report / canonical scenario | 1 | 16 |
| 18 | inline-report / canonical scenario | 1 | 16 |

## Preserved unsuccessful attempts

Historical eae0eb6:348PASS/2FAIL. faaa386:43finished41PASS/2fixturefail.5889841:47finished47PASS then safely interrupted, not350.2d1c1d5:350PASS/0FAIL and3546passing cases, valid only for that older source. Initial0c direct-Unix transport:130finished129PASS/1environment failure, not350. Later0c TCP attempt stopped at216actualfinished215PASS/1G3counterfailure after in-flight cleanup. The G3 retry red and two initially passing diagnostic attempts remain separate; none is relabelled350. The pre-recovery4c attempt additionally has121finished120PASS/1DB-connection failure plus2unfinishedlogs; original directories and shared XP screenshots remain archived with explicit path mapping. Recovery restarted original clusters and retained abandonedDBs; new qualification uses distinct disposable names. The next recovered4c attempt stopped at319actualfinished318PASS/1fixture-CDNfailure; its exact original results and unrecorded terminal group remain retained. A new test/fixture-only commit removes unknown remote demo images while strengthening genuine owned-photo decode checks. These are never combined with the new clean350. Old archive row.log values resolve via the explicit archive map, not a later directory with the same original name.

Current regular runner: python3 run-functional-audit-final-current.py inside qualified-exec-veth-tcp.py; complete sequence run-current-closure-all.py. Reproduction sources and hashes are supplied under evidence/functional-audit/final. Use only disposable loopback DBs, canonical local-suite net guard, fixture credentials and no live model/provider keys. G33 source/image/dirty-tree/branch guards remain; Docker uses configured proxy/CA and non-root runtime.

PG16 is reviewed migration/Drizzle compatibility. Canonical release-migration runner requiresPG18+. Both engines run the full60migration chain;57 original ReplitSQL bytes are unchanged. Custom dumps restore into separate targets; all133table digests and P0001/snapshot,55000/items,23514/journal failures match, and failed mutations leave all digests unchanged. Dumps and test DBs are deleted.

No native Android/iOS/Flutter/Capacitor targets exist in this repository. Chromium is supported here; manual assistive-technology and real-device acceptance remain separate. The two development-TLS remote checks are explicitly skipped, not evidence of production TLS or provider access.

Dependency integrity: official esbuild0.28.2 tarball and native binary verified against lockfile SHA512 and declared binary hash; all original CAS files match. pnpm store status nonzero remains recorded as install-time launcher optimization, not hidden. GitHub Actions status/billing reason is not independently verified through the blocked API; local Docker evidence is separate.
