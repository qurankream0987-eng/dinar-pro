# DINAR 07 — الأمن والأداء والجاهزية

## هدف التشغيل وحدود العزل

- التطبيق الاختباري يعمل داخل `artifacts/api-server/test/isolation/sandbox.sh`.
- PostgreSQL 18.6، loopback فقط على `127.0.0.1:55432`، قاعدة منفصلة لكل suite باسم `dinar_acceptance_c07_*`.
- المشغل والتطبيق يأخذان `DINAR_DEV_DATABASE_URL` واحداً محلياً؛ `preflight` يثبت sentinel العزل ويرفض القيم الخارجية، وغياب المسارات الخارجية موثق بـ`ISOLATION_NET: PASS (0 outbound attempts)`.
- `NODE_ENV=development` في الاختبارات فقط؛ `env -i` يمنع تسرب مفاتيح ومحددات Railway/المضيف. مزود النموذج scripted في Command A/F.
- جرى تطبيق migrations على قواعد مؤقتة. لا فحص أو تعديل لقاعدة Replit الدائمة في هذه الجولة.
- تحقق تشغيل `C07-20261026-isolated-readiness-01` من `dinar_acceptance_c07_identity` على `127.0.0.1:55432`، readiness 15/15 و0 محاولات خروج. بصمة SHA-256 الآمنة لهوية DB: `bbd4bbfb70ee6cb08153e5eb69c452f22ac24ac9923a45ac71c14b6e3abc01f0`. استخدم مشغل الترحيل واختبار API متغير `DINAR_DEV_DATABASE_URL` المحلي نفسه.
- لم يسجل browser harness منفذ التطبيق المؤقت أو `baseURL`؛ هذا نقص في توثيق الـrun ولا يبرر استنتاج هوية أي قاعدة خارجية.

## مخطط الجاهزية والترحيلات

- `lib/db/drizzle/meta/_journal.json`: 40 إدخالاً، من `0000_faulty_firestar` إلى `0039_ai_cache_write_costs`.
- مسار `/api/readyz` ينتظر DB query ناجحاً، وسجل `drizzle.__drizzle_migrations` متطابقاً بادئةً كاملة مع الـjournal، وإعداداً ومزود هاتف صالحين؛ لا يخفي خطأ المخطط.
- `readiness.test`: 15/15. يثبت fail-closed عند DB غير متاح، ترحيل ناقص، metadata غائب/متعارض، ونجاحاً عند اكتمال journal.
- `pnpm run migrate` نجح على أربع قواعد اختبار حديثة داخل الجلسة المعزولة؛ لا تعميم على Replit.
- آخر استجابة معروفة لـReplit Preview قبل هذا الأمر: 503 مع `database=ready,migrations=pending`. لم تُستدعَ Preview في Command 07 حتى لا تعيد وصل الاختبار إلى خدمة قد تستخدم قاعدة خارجية.
- لا نعرف أي migration IDs مطبقة/ناقصة في قاعدة Replit الحالية أو بصمتها. دفتر 24 أكتوبر يذكر 28/40 و`0028`–`0039` معلقة عندها؛ دليل تاريخي فقط وليس حالة 26 أكتوبر.
- **خطة آمنة لاحقة:** يثبت المالك/DBA هوية الهدف ونسخة احتياطية قابلة للاستعادة؛ استعلام read-only عن migration ledger والجداول المطلوبة؛ مراجعة تتابع الـ12 migration المقترحة حينها/العدد الفعلي، القفل والتوافق وخطر البيانات؛ rehearsal على clone؛ موافقة منفصلة؛ لا تشغيل migration على canonical هنا.

## GHSA-mrhx-c7xc-m3w5 — Zod

- التثبيت في workspace: `zod@3.25.76` مباشر في API و`api-zod` و`db` وواجهة DINAR؛ توجد أيضاً نسخة Zod 4 منفصلة لأدوات Orval، فلا يعني وجودها أن التطبيق انتقل إلى 4.
- Dependency audit بعد تحديث `body-parser@2.4.0`, `undici@7.30.1`, `fast-uri@3.1.9`: 1 high، صفر critical/moderate/low؛ finding Zod فقط، الإصلاح الذي أظهره الماسح `4.6.6` ويتطلب major upgrade.
- Body parser محدود إلى `128kb`. فحص موضعي أظهر حدود `.max()` لبعض arrays والـrecords، لكن لم تُراجع جميع مخططات الطلبات بمطابقة advisory الدقيقة؛ لذلك لا يثبت هذا انعدام الوصول إلى المسار المتأثر.
- لم يُجرَ Zod 4 migration أو workaround غير مستند إلى سبب الثغرة. الحالة **BLOCKED**، وليس RESOLVED أو MITIGATED. SAST وHoundDog السابقان صفر finding، ولا يلغي ذلك هذا التنبيه.
- خطوتا الإغلاق: تحديد الكود vulnerable وفق advisory الرسمي؛ تتبع كل request schema reachability؛ ثم إما ترقية Zod متوافقة مع `drizzle-zod` والمولّدات والـcontracts مع full suite، أو وضع limits دقيقة على المسار المثبت وإعادة scan. لا ترقية monorepo عمياء.

## الأداء

- Command E سجل 96 حالة واجهة، وJS transfer 237 kB، CSS 37 kB، `DOMContentLoaded=246ms` وظهور أول إجابة=1092ms ضمن harness محلي.
- هذه ليست قياسات p50/p95: لا توجد load workload موثقة أو عدد طلبات متزامنة مناسب أو CPU/RSS/DB plans.
- لا تُنشر أرقام SLO أو مقارنة إنتاجية منها. الحكم: `PERFORMANCE_BASELINE: NOT_MEASURED`.
- الخطوة التالية الآمنة: harness loopback قابل للتكرار على DB seed مصطنعة ذات حجم معلوم؛ قياس p50/p95/error/timeouts لكل API/search/SSE/checkout، concurrent buyers، history كبيرة، CPU/RSS، وخطط استعلام؛ لا اتصال بقاعدة موجودة.

## المسح والنتائج المتبقية

| الفحص | النتيجة |
|---|---|
| Dependency audit قبل تحديث الاعتماديات | 3 high، 4 moderate، 2 low |
| Dependency audit بعد التحديث | 1 high (Zod)، 0 critical/moderate/low |
| SAST | 0 findings |
| HoundDog | 0 findings |
| تاريخ Git/اعتماد GitHub | الاعتماد التاريخي لم يؤكد المالك إبطاله؛ يمنع التصدير/النشر |
| Replit DB readiness | 503 تاريخي/مبلغ عنه؛ لم تُقرأ قاعدة الهدف هذه الجولة |

لا push، لا Railway، لا مزود مدفوع، ولا أموال حقيقية.
