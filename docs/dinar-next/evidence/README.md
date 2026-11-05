# Synthetic browser and source-cut evidence

`connect-acceptance-e0d1de0.json` records PostgreSQL 18/16 outcomes, current browser evidence, source cuts, skips and blockers. Application source is `e0d1de0`; this publication commit adds CI/reporting and a viewport-settling test-harness correction. It is not a claim that every project gate has passed.

- `domain-cards-320.png`: current domain fallback card; unknown values and external search remain explicit.
- `staff-catalog-320.png`: current read-only staff portal at width 320; management controls are absent.
- `oauth-provider-consent.png`: isolated HTTPS provider consent. The page explicitly identifies a synthetic provider and no payment scope.

Current domain API/browser cases pass 2/2 in `publication-domain-fixed.log`; the full partner/OAuth browser journey passes in `publication-browser-final.log`. The first combined invocation retained a premature post-resize measurement failure in the domain portal at 320px; waiting for fonts and two rendering frames fixes the harness timing without changing or relaxing the zero-overflow assertion. The partner journey in that invocation already passed and was not rerun unnecessarily.

All people, provider hosts, identities and credentials are synthetic. Images demonstrate rendering/navigation, not real provider availability, prices, purchases or settlement. Full logs remain at `/workspace/dinar-connect-evidence`; committed suites are reproducible on disposable databases.
