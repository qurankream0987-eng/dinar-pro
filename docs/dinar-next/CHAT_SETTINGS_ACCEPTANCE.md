# Chat settings acceptance (G5)

**Suite:** `artifacts/api-server/test/chat-settings-acceptance.test.ts`. It runs the real HTTP runtime on a disposable PostgreSQL with a stub model that cannot understand anything, so every pass is **deterministic** evidence.

| Scenario | Result |
|---|---|
| 1. «دينار، افتح إعداداتي.» | SETTINGS surface, no model call |
| 2. «غير المظهر إلى الداكن.» | APP_THEME with `SET_THEME` DARK. Applied and persisted in the real browser by `universal-control-acceptance` (dark class + reload), which passed in this session's battery |
| 3. «كم باقي لي من استهلاك الذكاء؟» | AI_USAGE; the reply states exactly the ledger's `used` / `limit` |
| 3b. «ورني كم باقي لي من الاستخدام.» | AI_USAGE (was «my listings») |
| 4a. «غير اشتراكي للخطة الأعلى.» (no approved prices) | AI_PLANS: «لم يُعتمد سعر Business Go بعد… لم يتغير شيء ولم يُخصم أي مبلغ»; no plan or price invented |
| 4b. Same, with Go 5.000 / Pro 15.000 configured through the canonical admin API | BUSINESS_PLAN_REVIEW for the next tier above the user's own (Business Go, 5.000 JOD / 30 days); balance insufficient → stated; DB unchanged |
| 5. «لا، خل الاشتراك مثل ما هو.» | deterministic «تمام، يبقى اشتراكك كما هو. لم يتغير شيء ولم يُخصم أي مبلغ.» |
| 5b. «نعم» afterwards | nothing activated: subscriptions and ledger unchanged |
| G1 goal sentences | «أبي أفتح مشروع…», «اعرض لي منتجات متجري وحسّن وصفها», «أبي سائق ينقل الغسالة» reach the model instead of an empty search; a short unmatched product phrase keeps the honest empty result with **no** model call |

**Result:** 4/4 tests pass (6 s), outbound 0.

**Not covered:** a billable plan **activation** with sufficient simulated balance. The existing `BUSINESS_PLAN_REVIEW` confirm path is covered by the D1/D2 business suites and was not re-run here.
