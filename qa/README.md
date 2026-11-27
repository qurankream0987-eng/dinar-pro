# QA campaign — state at rescue (2026-11-27)

- `results.json`: **campaign: 0 scenarios designed/executed.** `regressionReruns` holds only reruns of existing repository suites from Antigravity run 1 (fcm-isolated, in-sandbox server on disposable DBs — not the deployed app), each classified. `claudeVerification` holds Claude's independent reruns.
- `evidence/run1-fcm-isolated/antigravity-condensed-logs.txt`: Antigravity's raw result lines, rescued from fcm-isolated `/var/log/qa-*.log` before the environment expires (2026-11-28 16:35 UTC). Full logs (~330 KB) remain in fcm-isolated until expiry.
- `evidence/claude-verification/`: TAP summaries of Claude's reruns.

Findings so far:
1. security-acceptance: Antigravity's failures were setup errors (no fixtures; shared DB). Correct rerun found one real regression in the XSS test, caused by the new sign-up country auto-detection versus a test that assumed Kuwait. Fixed in the test only (branch `claude/fix-xss-test-locale`): 12/12.
2. commerce-journey: Antigravity crash = missing fixtures; correct rerun 8/8.
3. Antigravity process `qa-local-3` started after the pause and was not attributable to a suite.
