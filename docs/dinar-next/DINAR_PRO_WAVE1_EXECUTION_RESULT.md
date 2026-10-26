# DINAR Pro — نتيجة تنفيذ الموجة الأولى (Wave 1)

**التاريخ:** 2026-10-26 · **الفرع:** `main` · **المنفّذ:** Claude Code (محلياً فقط)
**نطاق العمل:** إغلاق عوائق الإطلاق القابلة للحل محلياً، وإثباتها في بيئة معزولة. لم يحدث دفع إلى GitHub، ولا نشر، ولا أي اتصال بـ Railway أو بقاعدة التطوير أو بأي مزود خارجي.

---

## الصفحة الأولى — الخلاصة

| # | البند | النتيجة |
|---|---|---|
| 1 | HEAD عند البدء | `d2d19a893d3616d369d047cc03a3bb25200f8ec6` |
| 2 | HEAD النهائي | `79acbdf` (آخر التزام للكود والاختبارات؛ يليه التزام هذا التقرير وحده) |
| 3 | عوائق P0 الأصلية السبعة | P0-1 رمز GitHub مكشوف · P0-2 التسجيل خارج التطوير · P0-3 الواجهة والـ API من نفس الأصل · P0-4 runner ترحيل Staging/Production · P0-5 التخزين الدائم للملفات · P0-6 بوابة الأمن والقانون · P0-7 أول مدير وسوق مفعّل |
| 4 | عدد عوائق P0 المغلقة محلياً بالكامل | **3 من 7** (P0-3، P0-4، P0-7). وأُنجز الجانب الهندسي كاملاً لعائقين آخرين (P0-2، P0-5) وبقي كلٌّ منهما ينتظر مزوداً خارجياً يختاره المالك |
| 5 | عوائق P0 المتبقية | **P0-1** (إبطال الرمز وقرار التاريخ — المالك) · **P0-2** (اختيار مزود SMS وعقده — المالك، ثم كتابة المحوّل) · **P0-5** (إنشاء bucket واعتمادات S3 — المالك) · **P0-6** (مراجعة قانونية وخصوصية — جهة مختصة) |
| 6 | إخفاقات P1 المؤكدة | **T-G2-08:** Block A A02 («من 2020 وفوق» تفقد فئة السيارات) و Block E E25 («أرخص» بعد «رجعني للنتائج» تصل إلى «الذكاء غير متاح») — **أُصلحا**. **DS-15** — أُزيل ترابطان خفيان بين الاختبارات (FIXED)، لكن الفشل المتقطع التاريخي **لم يُعَد إنتاجه** في 26 تشغيلاً، فإصلاحه غير مُدّعى (INCONCLUSIVE). تبقى P1-1..P1-10 من خطة الإطلاق كما هي (لم تكن ضمن هذه الموجة) |
| 7 | تعديلات المصدر الفعلية | **11 ملفاً إنتاجياً** في `artifacts/api-server/src`: `app.ts`، `index.ts`، `lib/web-frontend.ts` (جديد)، `lib/deployment-configuration.ts` (جديد)، `lib/objectStorage.ts`، `lib/phone-verification.ts`، `lib/admin-bootstrap.ts` (إعادة القفل)، `lib/market-capability-registry.ts` (نص الحالة فقط)، `routes/health.ts`، `ai/marketplace-intent.ts`، `ai/conversation-runtime.ts` — إضافة إلى عقد OpenAPI لـ `/readyz` والعملاء المولّدين (19 ملفاً، +254/−59). **لا تعديل على أي migration أو مخطط قاعدة بيانات.** والباقي اختبارات وأدوات عزل وهذا التقرير |
| 8 | أعداد الاختبارات والإخفاقات | انظر §3. كل الحزم ذات الصلة خضراء داخل العزل؛ **0 إخفاقات متبقية** باستثناء ما يذكره §3 صراحةً |
| 9 | هل التسجيل يعمل محلياً؟ | **نعم، في وضع الإنتاج وبمحوّل SMS تجريبي غير متصل**: طلب رمز → تحقق → تسجيل → دخول، مع رفض الرمز الغائب والمزوّر والمرتبط برقم آخر والمعاد استخدامه. **لا يوجد مزود SMS حقيقي**؛ بدونه يرفض النظام التحدي (503) و`/readyz` يبقى `not_ready` |
| 10 | هل يمكن ترحيل قاعدة جديدة بأمان؟ | **نعم.** runner الإصدار طبّق 40/40 migration على PostgreSQL 18.6 فارغة؛ يكمل من بادئة صحيحة، ويرفض الحالات المتباعدة والمعدّلة، ويتراجع كلياً عند الفشل، ويمنع تشغيلين متزامنين (8 جولات: واحد MIGRATED والآخر LOCKED) |
| 11 | هل يمكن تهيئة أول مدير وسوق؟ | **نعم.** أمر المشغّل ينشئ أول مدير (لا مسار HTTP، لا بيانات افتراضية)، ودخوله الأول في الإنتاج يثبت ملكية الهاتف عبر SMS. المدير وحده يفعّل سوقاً واحداً بعد تسعيره، مع سجل تدقيق، وتبقى الأسواق الـ248 الأخرى غير نشطة. **اختيار سوق الإطلاق قرار المالك** |
| 12 | هل تصل الواجهة إلى الـ API؟ | **نعم محلياً:** الـ API يقدّم الواجهة المبنية من نفس الأصل (`DINAR_WEB_DIST`)، مع مسارات SPA والأصول و`/api` وSSE وفحص Origin والكوكي `Secure; HttpOnly; SameSite=Lax`. واختبارات Chromium (DS-07، DS-13..DS-17) تعمل الآن على مسار التقديم نفسه. **ليس قبولاً على بيئة منشورة** |
| 13 | هل تنجح التجارة من البائع إلى المشتري؟ | **نعم محلياً (8/8)** عبر وقت التشغيل التجاري القائم، والدفع **محاكاة فقط (`SIMULATION_ONLY`)** — ليس تكاملاً حقيقياً مع مزود دفع |
| 14 | هل كانت كل الاختبارات معزولة بأمان؟ | **نعم.** كل تشغيل داخل namespace شبكة خاص (loopback فقط)، وبيئة `env -i` بقائمة سماح صريحة، وعنقود PostgreSQL 18.6 يُنشأ ويُحذف لكل جلسة. **0 محاولات اتصال خارجي مسجّلة** في كل الجلسات الناجحة؛ وجلسة واحدة حاول فيها `npx` الوصول إلى `registry.npmjs.org` فرُفضت وأُفشلت الجلسة كما صُمّم. **حادثة واحدة:** تعديل وسيط على التفكيك ترك عنقودَي PostgreSQL مؤقتين (داخل مجلد العمل المؤقت، كلٌّ في namespace شبكة خاص) يعملان دقائق، فأُوقفا وحُذفا يدوياً وأُصلح التفكيك (ISO-5). لم تُمس أي عملية أو ملف سابق |
| 15 | الإجراءات المطلوبة من المالك | انظر §5 |
| 16 | الخطوة التالية نحو Railway Staging | انظر §6 |

---

## 1. العزل (شرط مسبق لأي اختبار تكامل)

`artifacts/api-server/test/isolation/sandbox.sh` يشغّل الأمر:

- ببيئة `env -i` وقائمة سماح صريحة (PATH، HOME مؤقت، LANG، TZ، nonce الجلسة). لا ينتقل أي متغير من بيئة المضيف إلا بالاسم عبر `DINAR_ISOLATION_PASS` — وفي هذه الموجة: مسار Chromium فقط.
- داخل user+network namespace جديد: `lo` فقط، بلا أي route IPv4. الأمر في مجموعة عمليات خاصة تُقتل كاملة عند التفكيك. `SESSION_SECRET` عشوائي لكل جلسة.
- مقابل عنقود PostgreSQL 18.6 يُنشأ في مجلد فارغ ويُحذف عند الخروج.
- `preflight.mjs` يُشغَّل قبل كل حزمة ويرفض: اعتمادات المزودين (AI، دفع، SMS، تخزين، GitHub)، أي مضيف غير loopback لأي متغير موقع، نطاقات Railway/Replit/Neon/Supabase، تجاوزات libpq (`host=` و`hostaddr` و`service`)، علامات النشر (`NODE_ENV=production`، `RAILWAY_ENVIRONMENT`، `REPLIT_DEPLOYMENT`)، وأي عنقود لا يحمل sentinel الجلسة.
- `net-guard.mjs` يسجّل كل محاولة خروج، وتفشل الجلسة (98) إن وُجدت أي محاولة.

**الاختبارات السلبية:** `preflight.test.mjs` 21/21 (19 رفضاً + حالتا قبول)، و`sandbox.test.mjs` 6/6: رفض جذر غير فارغ دون المساس بمحتواه، تعذّر الوصول إلى خدمة تعمل على loopback المضيف (بديل خوادم Replit 8080/8081/24108)، فشل الجلسة عند محاولة خروج حتى لو نجح الأمر، عدم انتقال `RAILWAY_API_TOKEN` و`DATABASE_URL` ومفاتيح AI، وحذف عنقود الجلسة فقط، وانتهاء العمليات التي يتركها الأمر خلفه مع الجلسة.

بيئة المضيف تحتوي فعلاً على `RAILWAY_API_TOKEN` ومفاتيح AI و`DATABASE_URL` غير محلي؛ لم يصل أيٌّ منها إلى أي عملية اختبار.

---

## 2. السجل لكل مشكلة

| ISSUE_ID | ROOT_CAUSE | FILES_CHANGED | RED_TEST | GREEN_TEST | INTEGRATION_EVIDENCE | STATUS |
|---|---|---|---|---|---|---|
| **ISO-1** | عند وجود `pgdata` مسبقاً في جذر العزل يفشل `initdb` ثم يحذف trap الخروج ذلك المجلد الموجود سلفاً | `test/isolation/sandbox.sh` | `sandbox.test.mjs` «root that already holds files»: الملف المسبق حُذف | 5/5؛ يُرفض الجذر غير الفارغ (96) ويبقى الملف | كل الجلسات اللاحقة بجذور جديدة | FIXED_AND_OFFLINE_VERIFIED |
| **ISO-2** | `net.connect()`/`tls.connect()` يمرّران مصفوفة `[options, cb]` مُطبَّعة إلى `Socket#connect`، فقرأها الحارس «بلا مضيف» = loopback ولم يسجّل أي محاولة | `test/isolation/net-guard.mjs` | «outbound connection fails the session»: خرج 0 بدل 98 | 5/5؛ المحاولة تُسجَّل وتفشل الجلسة | الجلسة التي حاول فيها `npx` الوصول إلى npm فشلت بـ 98 | FIXED_AND_OFFLINE_VERIFIED |
| **ISO-3** | واجهات Block A/E تطلق `CHROMIUM_PATH` لا `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE`، فتجاوزت بديل الخطوط المحلي وفشلت بأخطاء console | `test/isolation/sandbox.sh` | Block A: `consoleErrors` = 4× `ERR_NAME_NOT_RESOLVED` | `consoleErrors: []` | `test:blocka` 1/1، `test:blocke` 46/46 | FIXED_AND_OFFLINE_VERIFIED |
| **ISO-4** | نمط الاعتمادات في preflight يطابق أي اسم يحوي `DEEPSEEK`، فرفض مفاتيح تشغيل الحزمة غير السرية | `test/isolation/preflight.mjs`، `preflight.test.mjs` | الجلسة رُفضت (97) بسبب `BDINAR_DEEPSEEK_BROWSER` | 21/21؛ الاسمان الدقيقان مسموحان، و`DEEPSEEK_API_KEY` بجانبهما ما زال مرفوضاً | حزمة DeepSeek تعمل داخل العزل | FIXED_AND_OFFLINE_VERIFIED |
| **P0-4** | لم يكن هناك runner لغير التطوير (أُضيف في `582d70e`)؛ هذه الموجة أثبتته وأضافت اختبار التزامن | `lib/db/scripts/release-migration-concurrency.test.mjs`، `lib/db/package.json` | — (ميزة سابقة؛ لا عيب) | release-migration 8/8 + concurrency 3/3 | قاعدة fresh-environment رُحّلت بالـ runner نفسه: 40/40 `MIGRATED` | FIXED_AND_OFFLINE_VERIFIED |
| **P0-7a** | الالتزام `d2d19a8` تضمّن أثر mutation testing: استُبدل قفل `pg_advisory_xact_lock` في `bootstrapFirstAdmin` بالتعليق `// mutated`، فيمكن لعمليتين متزامنتين إنشاء مديرَين | `src/lib/admin-bootstrap.ts`، `test/admin-bootstrap.test.ts` | HEAD: 2/5 (التزامن، سجل التدقيق، CLI) | 5/5؛ والاختبار ينتظر حالة `pg_locks` بدل مهلة 300ms | fresh-environment: مدير أول CREATED بسجل تدقيق واحد | FIXED_AND_OFFLINE_VERIFIED |
| **P0-7b** | لم يكن هناك إثبات لمسار قاعدة فارغة → مدير → سوق واحد | `test/fresh-environment.test.ts` | — (تغطية) | 9/9 | 249 سوقاً غير نشط؛ التفعيل دون سعر يُرفض (409)؛ غير المدير 403؛ سوق JO فقط نشط؛ سجل `CONFIGURATION` | FIXED_AND_OFFLINE_VERIFIED (اختيار السوق: OWNER_DECISION_REQUIRED) |
| **P0-2** | في staging/production كانت `getPhoneVerificationProvider()` تعيد `undefined` دائماً، فلا يمكن توصيل أي مزود: التحدي 503، والتسجيل مستحيل، وحتى أول دخول لمدير غير موثّق الهاتف مستحيل | `src/lib/phone-verification.ts`، `market-capability-registry.ts` (نص) | fresh-environment على HEAD: 1/9 | readiness 15/15، fresh-environment 9/9 | محوّل تجريبي يلتقط الرمز داخل العملية؛ الرمز لا يظهر في الاستجابة؛ SANDBOX لا يخدم الإنتاج، وLIVE يتطلب `DINAR_LIVE_PROVIDERS_ENABLED=true` | العقد: FIXED_AND_OFFLINE_VERIFIED · المزود: OWNER_DECISION_REQUIRED + EXTERNAL_PROVIDER_REQUIRED |
| **P0-3** | الـ API لم يقدّم الواجهة، بينما الواجهة تستدعي `/api` نسبياً والكتابة محمية بـ Origin والكوكي `SameSite=Lax` | `src/app.ts`، `src/lib/web-frontend.ts` | same-origin-web على HEAD: 5/8 (لا SPA) | 8/8 | fresh-environment في وضع الإنتاج ببناء الواجهة الحقيقي: SPA و`/assets` (immutable) و`/api` JSON و403 للكتابة عبر أصل آخر وSSE؛ وChromium في حزمة DeepSeek | FIXED_AND_OFFLINE_VERIFIED |
| **P0-5** | الافتراضي `replit` يتصل بـ sidecar `127.0.0.1:1106` الموجود في Replit فقط؛ خدمة Railway بلا إعداد تبدأ ثم تفشل عند كل رفع | `src/lib/objectStorage.ts` | storage-s3-wire على HEAD: اختبار الاختيار يفشل | 6/6 + portability 2/2 | خادم S3 محلي يتحقق من توقيع AWS SigV4 فعلياً (ترويسة وpresigned) مع `S3Client` غير معدّل عبر HTTP | الكود: FIXED_AND_OFFLINE_VERIFIED · bucket: EXTERNAL_PROVIDER_REQUIRED |
| **G** | `/readyz` كان `ready` بقاعدة وسجل ترحيل فقط، ولو غاب `SESSION_SECRET` أو التخزين أو مزود SMS | `src/routes/health.ts`، `src/lib/deployment-configuration.ts`، `src/index.ts`، `openapi.yaml` + المولّد | الحالات الجديدة تفشل على HEAD (fresh-environment 1/9) | readiness 15/15 | `configuration` و`phoneVerification` مع `database` و`migrations`؛ أسماء لا قيم | FIXED_AND_OFFLINE_VERIFIED |
| **T-G2-08 / A02** | كل دور يُفسَّر أولاً دون الكتالوج. مع مجموعة نتائج مصنّفة (cars) لا يمكن قراءة قيد مجرد مثل «من 2020 وفوق» دون مخطط الفئة، فيصبح UNKNOWN ولا يُحمَّل الكتالوج، فيذهب الدور إلى مسار النموذج وتضيع الفئة | `src/ai/marketplace-intent.ts`، `src/ai/conversation-runtime.ts` | `test:blocka` 0/1 على HEAD («من 2020 وفوق») | 1/1 | Chromium 320–414px؛ و`consoleErrors: []` | FIXED_AND_OFFLINE_VERIFIED |
| **T-G2-08 / E25** | السبب نفسه: «أرخص» بعد «رجعني للنتائج» تُقرأ UNKNOWN فتصل إلى «الدردشة الذكية غير متاحة» | نفس الملفين | `test:blocke` 44/46 على HEAD (E25) | 46/46 | اختبار وحدة سلبي: بعد بحث سيارات، الأسئلة العامة لا تتحول إلى تحسين بحث (5/5) | FIXED_AND_OFFLINE_VERIFIED |
| **DS-15a** | ترابط خفي بين الاختبارات: (1) الواجهة المبنية كانت تُركَّب داخل جسم DS-07، فأي تشغيل لا يمر بـ DS-07 يفتح أصلاً لا يقدّم شيئاً (`GET /orders` → 404)؛ (2) شرط fixture «المحادثة القديمة» (سعر النموذج وحد الإنفاق من خطوات `setup`) لم يُتحقق منه، فيظهر غيابه كمهلة واجهة 8 ثوانٍ | `test/deepseek-chat-compatibility.test.ts` | DS-15 منفرداً: 5/5 فشل (مهلة 8s) | الواجهة تُركَّب مرة واحدة عند الإعداد عبر `createWebFrontend` (مسار الإنتاج نفسه)؛ والشرط يُتحقق منه فيفشل فوراً برسالة صريحة | DS-15 مع خطوات الإعداد: 5/5؛ الحزمة كاملة: 8 تشغيلات كاملة، 21/21 في كل مرة | FIXED_AND_OFFLINE_VERIFIED |
| **DS-15b** | الفشل المتقطع التاريخي (1 من 2 تشغيل كامل على مضيف Replit) **لم يُعَد إنتاجه** داخل العزل، فسببه غير مثبت. أُضيف تسجيل حالة الصفحة عند المهلة (`DS-15_FAILURE_STATE`: عدد رسائل المساعد والمستخدم، مؤشر الكتابة، سجل المحادثة النشطة) بدل مهلة صامتة؛ بلا إعادة محاولة وبلا انتظار ثابت | نفس الملف | لا فشل يمكن إعادة إنتاجه: 0 من 26 تشغيلاً | 13/13 تحت ثلاث عمليات CPU على 4 أنوية، و5/5 منفرداً، و8/8 ضمن الحزمة الكاملة | — | IMPLEMENTED_NOT_YET_VERIFIED |
| **ISO-5** | العمليات التي يتركها أمر الجلسة خلفه تبقى بعد انتهائها (ثلاث عمليات CPU بقيت حتى أُنهيت يدوياً). جُرّب PID namespace أولاً: يمنع أيضاً استهداف عمليات المضيف، **لكنه كسر Chromium** (لا يمكن إعادة تركيب `/proc` في هذه الحاوية فلا تُحمَّل أي صفحة) فأُلغي. كما كشف خطأ trap مؤقت ترك عنقودَي PostgreSQL مؤقتين يعملان، فأُوقفا وحُذفا | `test/isolation/sandbox.sh`، `sandbox.test.mjs` | «processes a session leaves behind end with it»: العملية تبقى | 6/6: الأمر يعمل في مجموعة عمليات خاصة (`setsid`) تُقتل كاملة عند التفكيك؛ والتفكيك يعمل بـ `set +e` فلا يتوقف قبل إيقاف العنقود | Chromium يحمّل الصفحات؛ 0 عمليات أو عناقيد متبقية. **خطر متبقٍ:** الجلسة تعمل بنفس uid فيمكنها نظرياً إرسال إشارة لعملية على المضيف؛ لا تستخدم أي حزمة `pkill` أو `killall` أو `kill(-1)` (فُحص) | FIXED_AND_OFFLINE_VERIFIED (مع خطر متبقٍ موثّق) |
| **COM-1** | لم يكن هناك اختبار رحلة واحدة كاملة من البائع إلى المشتري | `test/commerce-journey.test.ts` | — (تغطية؛ لم يظهر عيب) | 8/8 | انظر §4 | FIXED_AND_OFFLINE_VERIFIED (الدفع محاكاة فقط) |
| **SEC-ENV** | `test:security` 11/12 داخل العزل: العامل `dist/index.mjs` في التطوير يتطلب `PRIVATE_OBJECT_DIR` الخاص بـ Replit، وهو موجود في المضيف ويُزال بالعزل. السلوك نفسه في HEAD | لا تعديل | 11/12 | 12/12 بقيم تخزين اصطناعية غير مرتبطة بـ Replit | — | بيئي، لا عيب منتج |

---

## 3. أعداد الاختبارات (كلها داخل العزل، PostgreSQL 18.6، 0 محاولات خروج)

| الحزمة | النتيجة |
|---|---|
| isolation: `sandbox.test.mjs` / `preflight.test.mjs` | 6/6 · 21/21 |
| `test:release-migration` (rel + concurrency) | 8/8 + 3/3 |
| `test:admin-bootstrap` | 5/5 (HEAD 2/5) |
| `fresh-environment` (وضع الإنتاج) | 9/9 (HEAD 1/9) |
| `test:readiness` | 15/15 |
| `same-origin-web` | 8/8 (HEAD 5/8) |
| `storage-s3-wire` / `test:storage-portability` | 6/6 · 2/2 |
| `phone-verification-development-bypass` | 1/1 |
| `conversation-marketplace-isolation` | 5/5 (HEAD 3/4 للاختبارات السابقة + الجديدة) |
| `test:blocka` / `test:blocke` | 1/1 (HEAD 0/1) · 46/46 (HEAD 44/46) |
| `commerce-journey` | 8/8 |
| `test` (core: commerce, conversation, promotions, location, intelligence, employment, r5, monitoring) | 101/101 |
| `test:g2` / `test:ucc` / `test:blockf2` / `test:universal-negotiation` / `test:xp` / `test:gfinal` / nl-commerce | 109 · 10 · 14 · 38 · 22 · 22 · 1 |
| `test:api` / `test:security` / `test:closure` | 63/63 · 12/12 (بإعداد تخزين اصطناعي، انظر SEC-ENV) · 46/46 |
| `test:wave3` / `test:wave4` / `test:blockb` / `test:blockc` / `test:blockd` | 11 · 1 · 5 · 50 · 28 |
| `test:blockf0` / `f1` / `f3` / `f4` / `f5` / `test:g1` / `test:g3` / `test:contact` | 12 · 14 · 17 · 48 · 29 · 39 · 6 · 1 |
| DeepSeek (fixtures، Chromium) كاملة | 8 تشغيلات كاملة: 21/21 في كل مرة |
| DS-15 منفرداً مع خطوات الإعداد / تحت ضغط CPU | 5/5 · 13/13 |
| `typecheck` (api-server + libs) / build (api-server + dinar) | نظيف / ناجح |

ملاحظة: جولة التحقق النهائية للحزم غير المتصفحية (preflight، الترحيل، التخزين، admin-bootstrap، readiness، same-origin، fresh-environment، commerce-journey، core، api، security) جرت على نسخة وسيطة من العزل (PID namespace) قبل استبدالها بمجموعة العمليات؛ هذا التغيير يمس التفكيك فقط، وأُعيد بعده تشغيل حزم العزل والمتصفح كلها.

---

## 4. رحلة التجارة المحلية (`commerce-journey.test.ts`)

بائع ومشترٍ ومنافس وطرف ثالث اصطناعيون، في سوق JO المفعّل بالـ fixtures:

1. **النشر:** منتج (50 JOD، كميتان، قابل للتفاوض)، وخدمة (تركيب أثاث، `SERVICE`)، وقطعة أخيرة بسعر ثابت. كل نشر يمر بصف `DRAFT` داخلي ثم `PUBLISHED`. الأسعار `0` و`-5` و`abc` و`1e9999` تُرفض (400). المسودة المحادثية نفسها مغطاة في Block F1 (14/14).
2. **الاكتشاف والتحسين:** البحث يجد المنتج والخدمة؛ التصفية بـ `services` تعيد الخدمة فقط؛ الترتيب بالسعر تصاعدي.
3. **التفاوض:** عرض 40.000 ← عرض مضاد من البائع 45.000 ← قبول المشتري. يُرفض: مبلغ 0 (400)، مبلغ فوق السعر المعلن، تفاوض البائع على إعلانه، قرار من طرف ثالث (404)، قبول المشتري لعرضه هو، عرض مضاد أقل من عرض المشتري، وقبول بنسخة قديمة (409 «تغيّر»).
4. **الطلب:** المجموع 45.000 (المتفق عليه)، والعمولة 4.500 (10% المُسجّلة حالياً عند الدفع)، وحصة البائع 40.500. الحقول التي يرسلها العميل (`unitPrice`، `total`، `platformFeeMinor`، `sellerId`) تُتجاهل. المفتاح نفسه يعيد الطلب نفسه، والاتفاق يُستهلك بهذا الطلب وحده.
5. **الدفع (محاكاة):** intent بقيمة 45.000 `SIMULATION_ONLY`؛ البائع لا يدفع (404)؛ الالتقاط بتوقيع مزوّر أو بلا توقيع أو بمبلغ معدّل يُرفض (401) ولا تتغير الحالة؛ الالتقاط الصحيح `SIMULATION_CAPTURED`؛ إعادة الحدث تُعلَّم مكررة.
6. **التسليم:** قبول البائع، والمشتري لا يرفع إثبات التسليم (403)، وتأكيد الاستلام قبل التسليم مرفوض (409)، ثم `COMPLETED` بشكل idempotent.
7. **العمولة ومستحقات البائع:** مستحق واحد فقط بقيمة 4.500 JOD بحالة `PENDING` (لا سياسة تسوية مخترعة)، ويظهر للبائع ولا يظهر للمشتري.
8. **التزامن والتعارض:** ثلاثة مشترين يشترون القطعة الأخيرة معاً → طلب واحد (201) والباقي 409. عرض المنافس المقبول لاحقاً محدود بالمخزون المتبقي (كمية 2 مرفوضة، 1 مقبولة بسعره 42.000، ثم نفد المخزون).

لا دفتر مالي ثانٍ، ولا سياسة تسعير أو استرداد أو تسوية جديدة.

---

## 5. الإجراءات المطلوبة من المالك

1. **P0-1:** إبطال GitHub PAT المكشوف في `f60e30d`، ثم قرار مسار التاريخ (`DINAR_PRO_GITHUB_SECURITY_REMEDIATION_PLAN.md`). لا نشر للمصدر قبل ذلك.
2. **P0-2:** اختيار مزود SMS (أو مزود تحقق) والتعاقد معه، وتحديد الدول المدعومة. بعد ذلك تُكتب محوّلة واحدة خلف `PhoneVerificationProvider` وتُسجَّل عند بدء التشغيل؛ لا تغيير آخر مطلوب. **بدونه لا يمكن لأي مستخدم — ولا للمدير الأول — الدخول في Staging.**
3. **P0-5:** إنشاء bucket خاص متوافق مع S3 للـ Staging واعتمادات بأقل صلاحية، مع CORS يسمح بـ `PUT` من أصل التطبيق (الرفع عبر روابط presigned من المتصفح).
4. **P0-7:** تحديد سوق الإطلاق وسعر الوحدة فيه، ورقم هاتف المدير الأول.
5. **P0-6:** المراجعة القانونية والخصوصية ومدد الاحتفاظ (جهة مختصة).
6. **سياسة:** قرار تفعيل الدردشة في الإنتاج (`DINAR_AI_CHAT=true`)؛ معطّلة افتراضياً، ولم تُغيَّر.

---

## 6. الخطوة التالية نحو Railway Staging

بعد (1) و(2) و(3) أعلاه فقط: T-G2-03 (`railway.json`) بهذه القيم المثبتة محلياً:

- **build:** `pnpm install --frozen-lockfile && pnpm --filter @workspace/dinar run build && pnpm --filter @workspace/api-server run build`
- **pre-deploy:** `NODE_ENV=production DINAR_DEPLOYMENT_ENV=staging DINAR_MIGRATION_TARGET=staging DINAR_MIGRATION_ACK=APPLY_STAGING_MIGRATIONS DINAR_MIGRATION_EXPECTED_DATABASE=<اسم قاعدة Staging> pnpm --filter @workspace/db run migrate:release` (بلا `DINAR_DEV_DATABASE_URL`)
- **start:** `node --enable-source-maps artifacts/api-server/dist/index.mjs` مع `DINAR_WEB_DIST=artifacts/dinar/dist/public`
- **healthcheck:** `/api/readyz` — لن يصبح `ready` قبل تسجيل محوّل SMS وصحة `SESSION_SECRET` و`DINAR_DEPLOYMENT_ENV=staging` و`OBJECT_STORAGE_PROVIDER=s3` بكامل إعداده
- **بعد أول نشر:** `admin:bootstrap` بـ `DINAR_BOOTSTRAP_TARGET=staging DINAR_BOOTSTRAP_ACK=BOOTSTRAP_STAGING_ADMIN DINAR_BOOTSTRAP_EXPECTED_DATABASE=<الاسم>` وكلمة المرور عبر stdin، ثم الدخول الأول عبر SMS، ثم تسعير سوق الإطلاق وتفعيله من `/admin/markets`

**هذه الموجة لا تعني جاهزية إطلاق الموقع.** كل ما سبق مثبت محلياً في بيئة معزولة؛ لا قبول على بيئة منشورة، ولا مزود SMS أو دفع أو تخزين حقيقي.

---

## 7. الحكم النهائي

```
TEST_ISOLATION:              PASS
FRESH_DB_AND_MIGRATIONS:     PASS
ADMIN_BOOTSTRAP:             PASS
MARKET_ACTIVATION:           PASS
REGISTRATION_OFFLINE:        PASS
REAL_VERIFICATION_PROVIDER:  NOT_CONFIGURED
WEB_API_RUNTIME:             PASS
OBJECT_STORAGE_OFFLINE:      PASS
SEARCH_CONTEXT:              PASS
BROWSER_RELIABILITY:         INCONCLUSIVE
COMPLETE_COMMERCE_JOURNEY:   PASS
PAYMENT_PROVIDER:            NOT_CONNECTED
GITHUB_PUSH:                 NOT_PERFORMED
RAILWAY:                     UNTOUCHED
FINAL_LOCAL_COMMIT:          `79acbdf` (آخر التزام للكود والاختبارات؛ يليه التزام هذا التقرير وحده)
```

---

## ملحق — الالتزامات المحلية (بالترتيب)

- `c4f3d85` test: isolation sandbox for suites (loopback netns, env allowlist, PG18)
- `5966c79` admin bootstrap: restore the serialising advisory lock
- `46ec2da` test(isolation): route CHROMIUM_PATH browser suites through the sandbox wrapper
- `4584cd9` search: refine a categorized result set with its category schema
- `d842d9e` web: serve the built frontend from the API origin (P0-3)
- `ae556ef` storage: never fall back to the Replit sidecar outside Replit (P0-5)
- `97e840e` db: release migration concurrency and lock-scope tests (P0-4)
- `e9b3120` auth, readiness: SMS adapter seam; not READY without config or SMS (P0-2, G)
- `13faee3` test: fresh environment from empty database to first sale-ready market
- `cef9d14` test: complete seller-to-buyer commerce journey with denial cases
- `9820454` test(isolation): process-group teardown; exact non-secret DeepSeek switches
- `79acbdf` test(deepseek): remove hidden ordering dependencies around DS-15

**لم يُدفع شيء، ولم يُنشر شيء، ولم يُعدَّل تاريخ Git.**
