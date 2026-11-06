# Functional audit defect register — in progress

Initial audit source eae0eb68695684b0aad6623563c3d36c3131d03c. Fresh raw regular battery: 350 executions, 348 passing groups, two failures; historical 3585 count excluded.

| ID | Scope | Evidence and root cause | Correction | Status |
| --- | --- | --- | --- | --- |
| FA-01 | SC03 acceptance P2 | PG16 DB remained SELLER_MARKED_DELIVERED while browser reported completion. Unchanged diagnostic retry passed, not closure. Real Chromium async-false predicate resolved false in 38ms: async waitForFunction is not a completion guard here. | Await actual authenticated API state using expect.poll, retain final DB/order/price/single-order assertions | COMPLETE_VERIFIED on PG16/18 at 6a22980 |
| FA-02 | Connect finance fixture | PG18 native datetime fill rejected .890; standalone Chromium also rejects zero-second .000 forms. No financial operation ran at failing step. | Normalize through a separate native datetime input, assert exact UTC instant unchanged, fill through actual UI and retain exact posted terms | COMPLETE_VERIFIED on PG16/18 at 6a22980 |
| FA-03 | Viewport coverage gap | First fresh E report has 128 runs; frontend default expansion was overridden by server wrapper. 360/1920 not yet proven. | Expand actual wrapper fallback, preserve previous widths and dark/light assertions | COMPLETE_VERIFIED on PG16/18 at 6a22980 |

These are demonstrated acceptance-fixture defects; no current product execution or financial guard was weakened. Product-wide route/role/control and advertising lifecycle audit remains incomplete. Narrow datetime handling already exists on Claude; this isolated correction also handles zero seconds and keeps all current diagnostics assertions. No Claude branch imported or changed.

| FA-04 | Adjacent acceptance P2 | Eight identical async-predicate waits in SC01/SC10/session logout; source trace also shows admin is not permitted participant-only order GET | Real awaited polls; verify resolved order as its buyer, independently retain admin private-order 404 | IMPLEMENTED_UNVERIFIED |
| FA-05 | Local G33 audit entry | Existing driver permits only the canonical branch, so owner-authorized isolated audit cannot rehearse G33 | Add only the exact audit branch to LOCAL_DISPOSABLE; preserve CI allowlists, image identity, dirty-source and contributor-branch rejection | GUARDS_VERIFIED 7/7; full actual G33 pending |
