# Command 04 — D5 Security and Approvals

## Authorization implemented

- Grant resolution is keyed by the authenticated actor and selected market, never by model-supplied business or grant identifiers.
- Only an `INTELLIGENT` grant with `ACTIVE` status and a future expiry is considered.
- More than one matching grant fails closed.
- The established D4 catalog service rechecks the principal, grant lifecycle, `business.catalog.read`, business ownership/status, market, and resource scope.
- The grant is resolved again for each qualifying request; the model receives no cached grant token.
- D4 records the delegated catalog read through its existing audit path.

## Approval and tool boundaries

The D5 change adds no permission, approval endpoint, writer tool, message sender, payment authority, settlement authority, or order-state authority. Existing model authority tests continue to confirm that the model sees only the registered read-only tools and cannot execute model-proposed financial/order tools. Existing chat actions still require their established user confirmation.

Owner approval capabilities that appear in D4 records are not granted to the intelligent employee by this change. The only accepted D4 intelligent capability remains `business.catalog.read`.

## Security scans and secret check

- SAST: completed, zero findings.
- HoundDog: completed, zero findings.
- Dependency audit: one high and one moderate finding. It reported `zod@3.25.76` (high) and `qs@6.16.0` (moderate); both versions are present in the workspace-root lockfile. The target checkout lockfile instead contains `zod@4.6.7` and `qs@6.16.1`. The scan therefore does not establish the target checkout's dependency status.
- Repository secret scan: 1 test passed, 0 failed.
- No dependency was changed during D5.

## Residual security validation

Run a target-checkout-specific dependency audit and reconcile the workspace-root findings before release. D5 has no live-model prompt-injection acceptance and no browser-session isolation acceptance. No production database or production deployment was tested.
