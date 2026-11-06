# Fresh functional inventory — audit in progress

Baseline `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`; isolated audit branch. Source discovery found 332 API declarations and 48 web route declarations. These are declarations, not verified features. Exact paths and locations: [source inventory](evidence/functional-audit/source-inventory.json).

App.tsx deliberately enables CHAT_ONLY_MODE: standalone seller/cart/checkout pages can redirect into conversation. Preserve this owner rule; test their canonical in-conversation equivalents and classify inaccessible graphical routes truthfully.

| Feature | Entry Point | Backend Service | Database State | User Role | Current Tests | Missing Tests | Actual Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Responsive conversation/card surfaces | Actual conversation UI | Existing runtime | Actual turns/cards | Buyer/seller | command-e-ui | Fresh evidence at 360/1920 and dark at every width; role journeys still required | PARTIAL |
| Full route inventory | App.tsx + API router mounts | Existing canonical services | Must trace per feature | All roles | Historical tests excluded as new evidence | Source-to-DB trace and each exposed control | PARTIAL |
