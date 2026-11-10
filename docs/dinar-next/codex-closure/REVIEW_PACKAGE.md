# Review package usage

The local branch is `codex/remaining-engineering-closure`. The Git bundle contains its commits above prerequisite `eda6d4205c2f0553b26a87c19255e3b06b598706`; it does not contain a merge or deployment.

After verifying the SHA256 file and having the prerequisite history locally, Claude can inspect without changing an existing branch:

```sh
git bundle verify /path/to/dinar-codex-engineering-closure.bundle
git bundle list-heads /path/to/dinar-codex-engineering-closure.bundle
git fetch /path/to/dinar-codex-engineering-closure.bundle \
  refs/heads/codex/remaining-engineering-closure:refs/heads/review/codex-engineering-closure
```

Then compare the isolated review ref against the prerequisite and any newer verified integration. Fetching the review ref is not authorization to merge, push or deploy. Read HANDOFF.md first, especially the partial verdicts and unresolved failures.

`dinar-codex-closure-evidence.tar.gz` contains all retained local `closure-*` test logs, run summaries, lab JSONL, orchestration scripts, and available browser screenshots under their original relative paths. It excludes `.setup`, synthetic seed password files, environment dumps, database contents and credentials. A protected-environment-value scan reported zero matches in the selected textual evidence. `closure-evidence-files.sha256` lists individual archived files. The delivery SHA and artifact digests are provided separately alongside the bundle.

The runtime source SHA is in HANDOFF.md; documentation/evidence-only delivery commits follow it. Laboratory source provenance is explicit in evidence/results.json. No all-green final battery or live-provider acceptance is asserted.
