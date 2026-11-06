# Delivery scanner triage

The full-history Gitleaks 8.30.1 sweep after documentation commit ae6c722 returned two detections (exit 1, 556 commits). The raw redacted report/log remain at `/workspace/dinar-connect-evidence/final-delivery-gitleaks-redacted.json` and `final-delivery-gitleaks.log`. They are retained, not described as an initially clean sweep.

- `docs/dinar-next/CODEX_EXTERNAL_LAUNCH_BLOCKERS.md`, line 13: the detected value is ordinary policy prose, `legal/country`, in a legal prerequisite. It is not a credential.
- `docs/dinar-next/evidence/final-self-audit.json`, line 43: the detected value is the actual Git tree object identifier for the authored schema package at qualified code 9101672. Exact equality to `git rev-parse 9101672:lib/api-zod` and object type `tree` were verified locally, without a service request.

The existing pinned CI runs Gitleaks. Root `.gitleaksignore` therefore contains exactly these two historical fingerprints, binding the original documentation commit, exact path, detector and line. It does not suppress a rule, path, value, later commit or service credential. Original history is preserved; no reset, rebase, amendment or force push was used.

A separate disposable Git repository copies those two fingerprint exclusions but places the same harmless prose under a different commit/path. The actual scanner must still detect it. Full-history final scanning and that scope test are recorded in `delivery-scanner-triage.json`. The qualified application remains unchanged; this delivery adds narrowly reviewed scanner configuration and documentation only. Raw findings, reviewed exclusions and unreviewed findings are separate counts. No actual credential material was identified or tested against a provider.
