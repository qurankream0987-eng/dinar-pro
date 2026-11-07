# Reproduce the local audit evidence

Tested source `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`, canonical branch codex/dinar-next-functional-audit. This package contains selected screenshots, raw structured outcomes, log hashes and original local driver sources. The complete local logs remain under /workspace/dinar-connect-evidence; hashes refer to those original bytes, not regenerated files.

Use only a dedicated disposable checkout and fresh loopback PostgreSQL16/18 with role dinar_cloud on55416/55433, supported Chromium, Node24 and pnpm10.30.3. No production URL, Railway, paid model/provider credentials or real payments. Check AGENTS.md/CLAUDE.md and the latest OWNER_FINAL_ENGINEERING_CLOSURE before any action.

The drivers preserve original workspace paths for forensic reproducibility. On another machine adapt only root/tool/loopback-port selectors consistently and document the change; do not claim byte-identical execution on an unmodified environment. The local private relay directory is0700 and sockets0600; it contains no traffic logs. Start qualified-pg-tcp-relay.py on the host, then run:

```sh
unshare --user --map-root-user --net python3 qualified-exec-veth-tcp.py python3 run-current-closure-all.py
```

The isolated executor uses loopback and address-only veth, no default/public route, unchanged canonical DB/network guards and a private Unix relay to actual host loopbackTCP. Genuine PostgreSQL client/server identity remains127.0.0.1. Do not report it as the original unsupported sit0sandbox.

Full programme requires a clean exact source/HEAD, frozen SHA file, suite-profile manifest and known tool paths in this environment. The legacy profile input full-dc1636d/results.jsonl is only a configuration selector: populate its JSONL from the provided regular-results.json rows, preserving pg/suite/flags exactly. This is a format conversion of actual recorded configuration, not fabricated test results or recreated Git history. Use the supplied prepared supplemental entry/browser sources; do not regenerate over them without reviewing the preserved fixture additions. Supplemental runners compile their TypeScript entries themselves. Browser and seed work are serialized as recorded; never run duplicate suites or modify source during qualification. G33 uses only the configured managed Docker socket/proxy/CA, dedicated disposable containers and the exact source-labelled image. It never deploys.

All provider, phone, upload, website/DNS, model and payment fixtures are labelled local/synthetic. Expanded provider browser navigation follows the actual server303 and uses the original localTLS fixture via exact CA/SNI verification. No live registrars, partner sale, affiliate income, real SMS or model quality are inferred. Driver buyer-receipt API scope is distinct from SC03receiptbutton proof.

The original failed/interrupted runs, including aggregate-only G3failure and retry red, remain preserved under their own source cuts. A new candidate bundle does not recover the original V2history.
