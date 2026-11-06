# Functional audit defect register — in progress

Initial audit source eae0eb68695684b0aad6623563c3d36c3131d03c. Fresh raw regular battery: 350 executions, 348 passing groups, two failures; historical 3585 count excluded.

| ID | Scope | Evidence and root cause | Correction | Status |
| --- | --- | --- | --- | --- |
| FA-01 | SC03 acceptance P2 | PG16 DB remained SELLER_MARKED_DELIVERED while browser reported completion. Unchanged diagnostic retry passed, not closure. Real Chromium async-false predicate resolved false in 38ms: async waitForFunction is not a completion guard here. | Await actual authenticated API state using expect.poll, retain final DB/order/price/single-order assertions | IMPLEMENTED_UNVERIFIED |
| FA-02 | Connect finance fixture | PG18 native datetime fill rejected .890; standalone Chromium also rejects zero-second .000 forms. No financial operation ran at failing step. | Normalize through a separate native datetime input, assert exact UTC instant unchanged, fill through actual UI and retain exact posted terms | IMPLEMENTED_UNVERIFIED |
| FA-03 | Viewport coverage gap | First fresh E report has 128 runs; frontend default expansion was overridden by server wrapper. 360/1920 not yet proven. | Expand actual wrapper fallback, preserve previous widths and dark/light assertions | IMPLEMENTED_UNVERIFIED |

These are demonstrated acceptance-fixture defects; no current product execution or financial guard was weakened. Product-wide route/role/control and advertising lifecycle audit remains incomplete. Narrow datetime handling already exists on Claude; this isolated correction also handles zero seconds and keeps all current diagnostics assertions. No Claude branch imported or changed.
