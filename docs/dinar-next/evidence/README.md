# Final qualified local evidence

`final-local-acceptance.json` records exact source cuts, supported profiles, raw failures/retries and qualified counts. Five `closure-*.png` captures are fresh C2A PG18 images, with provenance in `closure-provenance.json`; final source retains that frontend tree, with a separately qualified server CSP change. `closure-command-e-summary.json` records 96 width/theme runs. All providers/people/money are synthetic; no live availability/payment/affiliate claim is evidenced.

The following earlier captures and their original source attribution are historical, not final reruns.

# Synthetic browser and source-cut evidence

`connect-acceptance-e0d1de0.json` records PostgreSQL 18/16 outcomes, current browser evidence, source cuts, skips and blockers. Application source is `e0d1de0`; this publication commit adds CI/reporting and a viewport-settling test-harness correction. It is not a claim that every project gate has passed.

- `domain-cards-320.png`: current domain fallback card; unknown values and external search remain explicit.
- `staff-catalog-320.png`: current read-only staff portal at width 320; management controls are absent.
- `oauth-provider-consent.png`: isolated HTTPS provider consent. The page explicitly identifies a synthetic provider and no payment scope.

Current domain API/browser cases pass 2/2 in `publication-domain-fixed.log`; the full partner/OAuth browser journey passes in `publication-browser-final.log`. The first combined invocation retained a premature post-resize measurement failure in the domain portal at 320px; waiting for fonts and two rendering frames fixes the harness timing without changing or relaxing the zero-overflow assertion. The partner journey in that invocation already passed and was not rerun unnecessarily.

All people, provider hosts, identities and credentials are synthetic. Images demonstrate rendering/navigation, not real provider availability, prices, purchases or settlement. Full logs remain at `/workspace/dinar-connect-evidence`; committed suites are reproducible on disposable databases.

`website-acceptance.json` records the subsequent server-observed WEBSITE milestone and actual source digest. `website-card-{320,390,1280}.png` show the same integrated card after the empty-description and narrow-header fixes. Facts and prices are synthetic fixture observations. Readability/overflow assertions run at 900px height; complete-card captures use 1300px height to avoid sticky viewport clipping. Keyboard/DOM accessibility passes; actual screen-reader output remains untested. See `../CONNECT_WEBSITE_CHECKPOINT.md` for precise source cuts, red failures and external blockers.
