# DINAR NEXT Command 02 — LIGHT/HEAVY and Cost Controls

**Status:** PASS for the covered deterministic/runtime controls; PARTIAL for live-model efficiency and quality
**Tested implementation SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`

## Preserved and verified

The existing model-tier selection and usage/cost enforcement remain in place. The Command 02 change adds no separate model call to classify compound messages: `plannedSteps` is optional output from the existing model turn. After a plan is persisted, continuation uses the existing task-plan runtime without a new model call.

The cost and provider-failure suite uses scripted gateways and test placeholder prices on disposable PostgreSQL. It verifies held/spent accounting, unpriced calls, retries/fallback rows, global and account/plan caps, abandoned reservations, voice metering, and refusal when budget configuration is required but absent.

## Capability record

- **Requirements:** Command 02 §§05 and 15, including bounded escalation, usage attribution, retry limits, and no silent paid fallback.
- **Modified source files:** The orchestration changes in `conversation-runtime.ts`, `model-turn.ts`, and `smart-turn.ts`. No model-tier or pricing policy was changed.
- **Tests:** `model-tiers.test.ts` 24/24; `ai-provider.test.ts` 47/47; `closure-ai-cost.test.ts` 19/19; model-plan continuation assertion MN-07.
- **Environment:** Local isolated PostgreSQL. The closure suite ran by itself on a fresh development-seeded disposable DB with `BDINAR_CLOSURE_ACCEPTANCE=development`, `BDINAR_PROMOTIONS_ENABLED=true`, and `BDINAR_WAVE4_ACCEPTANCE=development`. No provider request was sent; outbound attempts were zero.
- **Tested code SHA:** `15808607810983dd1bbc277f74c45d6687b56e3f`.
- **Status:** PASS for these regression checks.
- **Provider dependency:** Live prices, provider billing reconciliation, and actual live-model latency/cost remain external acceptance items.
- **Limitations:** No measured comparison of real LIGHT versus HEAVY model quality or cost was performed. Test placeholder prices are not commercial prices.

## Security scan note

The recorded SAST and HoundDog scans had no findings. The dependency audit reported one high-severity Zod 3.25.76 finding and one moderate qs 6.16.0 finding. Neither dependency was changed in this orchestration task; the Zod remediation requires a major-version decision, and dependency remediation was outside this scoped change.

## Command 02B revalidation

**Implementation/test commit:** `792d0f4da3500d00915e178d73f713d2a822a8be`

No LIGHT/HEAVY routing, pricing policy, or retry count was changed. The new plan uses the already-resolved model turn and existing bounded task runtime; it does not add a classifier call. Verification on disposable PostgreSQL: `model-tiers` 24/24, `ai-provider` 47/47, `closure-ai-cost` 19/19, `command-a-acceptance` 22/22, and `model-native-routing` 9/9. Every successful local-suite summary reported zero outbound attempts.

The branch-local production dependency audit was clean. The workspace-root audit findings cited in the prior section refer to another lock/tree and are not branch findings; SAST/HoundDog were likewise run against the general workspace, not the isolated checkout. Real provider latency, billing reconciliation, and LIGHT-versus-HEAVY quality remain unverified.
