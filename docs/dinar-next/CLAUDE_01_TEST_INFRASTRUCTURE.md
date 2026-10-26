# DINAR — Claude 01: بنية الاختبار

## الأداة الجديدة: `artifacts/api-server/test/isolation/local-suite.sh`

تشغّل suite واحدة على قاعدة جديدة فوق خادم PostgreSQL **محلي (loopback)** موجود مسبقاً. صُممت للبيئات التي لا يعمل فيها `sandbox.sh`: حاويات root، أو غياب user namespaces، أو غياب PostgreSQL 18.

```sh
cd artifacts/api-server
DINAR_LOCAL_PG=postgres://user@127.0.0.1:55432 test/isolation/local-suite.sh <suite>.test BDINAR_<FLAG>=development
# DINAR_SUITE_SEED=fixtures|development|none   DINAR_SUITE_DB=<name>   DINAR_CHROMIUM=<browser>
```

| الضمان | كيف |
|---|---|
| هوية قاعدة معزولة | يرفض أي رابط غير loopback، وأي رابط يحدد قاعدة، وأي اسم يحتوي development/production/staging/canonical/legacy. ثم يعيد حارس `run.mjs` الفحص |
| قاعدة جديدة لكل تشغيل | `DROP/CREATE` ثم `drizzle-kit migrate` (41 ترحيلاً) ثم حذفها بعد الانتهاء (`DINAR_SUITE_KEEP_DB=1` لإبقائها) |
| بيئة نظيفة | `env -i`، و`SESSION_SECRET` و`BDINAR_SEED_PASSWORD` عشوائيان لكل تشغيل، ورفض أي متغير يشبه مفتاحاً (KEY/SECRET/TOKEN/PASSWORD/DATABASE_URL) أو لا يبدأ بـ`BDINAR_`/`DINAR_` |
| لا اتصال خارجي | preload `net-guard.mjs` يرفض ويسجّل كل اتصال غير loopback؛ أي محاولة تجعل الخروج 98 |
| فصل الزرع عن الـsuite | الترحيل والزرع يعملان دون مفاتيح الـsuite (مثل `BDINAR_LOG_SCAN`) |

**الفرق عن `sandbox.sh`:** لا يوجد network namespace؛ العزل على مستوى Node فقط. Chromium لا يمر عبر net-guard، ولذلك يُشغَّل مع `--host-resolver-rules` وstub الخطوط. حيث تتوفر user namespaces وPostgreSQL 18 يبقى `sandbox.sh` الخيار الأقوى.

## المشكلات السابقة وحالتها

| المشكلة (Claude 00) | السبب الجذري | الإصلاح | الحالة |
|---|---|---|---|
| مسار Chromium ثابت | 3 suites تفرض `CHROMIUM_PATH: "/repl/tools/bin/chromium"` على البيئة الفرعية، وملفان بلا أي بديل، و24 ملفاً تستخدمه كقيمة افتراضية | كل المواضع (29 ملفاً) تقرأ `CHROMIUM_PATH` ثم `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE` ثم متصفح Playwright. على Replit المتغير الثاني يحمل نفس المسار | **مغلق** (0 مرجع متبقٍ) |
| security #12 | عمليتا `dist` تتطلبان تخزيناً؛ خارج Replit لا يوجد sidecar | خادم S3 المحلي الموجود في المستودع يُمرَّر للعمليتين؛ وأُصلح سباق تشغيل خادمين معاً كان يُبقي العملية معلقة | **مغلق**: 12/12 |
| phase1 (رفع الصور) | ‏(1) التخزين يُبنى عند الاستيراد قبل ضبط البيئة؛ (2) **عيب إنتاجي**: محول S3 لا يعيد `generation`، فكل إكمال صورة يفشل بـ503 على S3 | ‏(1) `test/local-object-storage.ts` يُستورد قبل التطبيق؛ (2) `generation = VersionId ?? ETag` + اختبار wire | رفع الصور **يعمل**؛ الـsuite ما زالت تفشل بخطأي console لصور `images.unsplash.com` في بيانات `src/lib/dinar-data.ts` (لا إنترنت في العزل) — **BLOCKED (بيئة/بيانات)** |
| image-publication | يفرض `55438/dinar_image_review_test` الذي يرفضه حارس `run.mjs` | يقبل `dinar_test_image_review*` على loopback، ويستخدم التخزين المحلي | **مغلق**: 1/1 |
| أسماء القواعد | suites تفرض بادئات خاصة (`dinar_test_fresh_*`, `dinar_test_blockb_*`) | `DINAR_SUITE_DB` في الأداة؛ موثق في `CLAUDE.md` | **مغلق** |
| تهيئة البيانات | تسرب `LOG_SCAN` إلى الزرع، وغياب `BDINAR_SEED_PASSWORD` | الأداة تفصل الزرع وتولّد كلمة مرور الزرع | **مغلق** |
| DS-12 المتذبذب | سباق في **الاختبار**: الحجز يُسوّى داخل الدور (`smart-turn.ts:1014`) والرسالة تُعلَّم completed بعده؛ الاختبار انتظر الأول فقط | الانتظار للحالتين معاً بنفس المهلة (5 ثوانٍ)، وكل التأكيدات باقية | **مغلق**: 6/6 تحت حمل متزامن (كان 7/9) |
| PostgreSQL 18 | `release-migration` يرفض أقل من 18 | — | **BLOCKED**: `apt.postgresql.org` غير متاح (رمز 000/403). 3/11، و8 تتوقف عند `SERVER_VERSION`. **لا يُستنتج قبول PG18 من PG16** |

## ما لم يتغير عمداً

- لم تُخفَّف أي تأكيدات. التغييرات في الاختبارات: إعداد البيئة، وتوسيع اسم القاعدة المقبول، وانتظار حالة إضافية في DS-12، وتحديث توقعين لسياسة D3 الجديدة في `payment-order-state` (ما كان 409 صار 200 مع التزام استرداد).
- `sandbox.sh` لم يُعدَّل.

## قيود باقية

1. **PostgreSQL 18:** يحتاج إضافة `apt.postgresql.org` إلى نطاقات الشبكة المسموحة في إعدادات البيئة، أو صورة حاوية فيها PG18.
2. **phase1:** يحتاج إما إنترنت لـUnsplash، أو استبدال صور العينة الخارجية في `dinar-data.ts` بأصول محلية (P3).
3. `run.mjs` يبني إلى `.test-build/<suite>.mjs` ثابت، فلا تُشغَّل نسختان من نفس الـsuite بالتوازي.
4. symlink مؤقت `/repl/tools/bin/chromium` أنشأته في Claude 00 ما زال في **الحاوية** (ليس في المستودع)؛ حذفه احتاج موافقة لم تُمنح. لا يعتمد عليه أي اختبار بعد الإصلاح.
5. Node المحلي 22.22.0 والمشروع يعلن 24.
