# DINAR — اعتماد ترحيل قاعدة بيانات Preview

**التاريخ:** 2026-10-24
**المُعدّ:** Claude Code (فحص للقراءة فقط + تجارب على قواعد مؤقتة معزولة)
**الهدف:** قاعدة Preview الدائمة = Railway project `dinar-development-canonical` / بيئة `development` / خدمة `Postgres` (`iriguchi.proxy.rlwy.net:18992`, هوية TLS `postgres-57f7f853.railway.internal`, قاعدة `railway`, PostgreSQL 18.6).
**القرار:** **غير معتمد بعد.** الترحيل آمن تقنياً وفق الأدلة أدناه، لكن يبقى عائقان مطلوبان من المالك (§9).

> لم يُنفَّذ أي ترحيل أو DDL أو DML على Preview أو staging أو أي قاعدة مُدارة أو إنتاجية. كل استعلامات Preview جرت داخل `BEGIN READ ONLY` ثم `ROLLBACK`، عبر TLS مُتحقَّق (`verifiedDevelopmentCredentials`). لم يُنسخ أي صف من Preview، ولم تُطبع أي سلسلة اتصال أو سر. لم يُستدعَ أي مزوّد AI، ولم يُلمس فرض حجز استخدام AI.

---

## 0. تحديث 2026-10-24 — تصحيح 0030 والتفاوض الشامل

- **0030 صُحّح في المستودع** قبل أن تطبّقه أي قاعدة دائمة (Preview عند 0027، القاعدة المُدارة عند 0009، لا إنتاج). التفاصيل والأدلة: `DINAR_PRICING_AND_0030_MIGRATION_COMPATIBILITY.md`.
- على بيانات Preview الحالية **النتيجة مطابقة** للنسخة الأصلية (لا صفوف `STARTING_FROM`/`QUOTE_REQUIRED`، وكل `defaultMode` = `FIXED`).
- تغيّر hash ملف 0030، فأي فحص مسبق سابق لم يعد دليلًا كافيًا: **أعد `--phase=pre` عند الـ commit المعتمد**. تجربة 0030 المصحّح على البيانات الاصطناعية: PASS، 58 جدولًا محميًا متطابقة.
- `preview-migration-check.mjs` يتوقع الآن التحويل المصحّح ويستثني `data.priceRepresentation` من بصمة العروض.
- حارس `migrate:clone` يثبّت hash 0030 الجديد.
- لا ترحيل جديد (لا `0040`). العوائق في §9 كما هي: النسخة الاحتياطية غير مُتحقَّقة، واعتماد المالك.

## 1. حالة المستودع

| البند | القيمة |
| --- | --- |
| الفرع | `main` |
| HEAD عند البدء | `d9d57ab` (Update test assertions in api-server tests) |
| شجرة العمل عند البدء | نظيفة |
| دفتر الترحيلات (`lib/db/drizzle/meta/_journal.json`) | 40 إدخالاً (`0000`–`0039`) |

## 2. أدلة Replit من الاختبارات المعزولة

- `/tmp/dinar-migrate-c.log` … `-f.log` (2026-10-24 11:34–11:39 UTC): أربع تشغيلات لـ `pnpm --filter @workspace/db run migrate` انتهت جميعها بـ `migrations applied successfully` على قواعد مؤقتة.
- `/tmp/dinar-readyz.json` (10:50 UTC): Preview أعادت `{"status":"not_ready","checks":{"database":"ready","migrations":"pending"}}`.
- **تحقق مستقل:** دفتر Preview ما زال 28 إدخالاً (§3)، أي أن تجارب Replit لم تمسّ Preview. لكن تجارب Replit كانت على قواعد شبه فارغة (ترحيلات فقط)، فلا تثبت سلوك تحويل البيانات القديمة؛ لذلك أُعيدت التجارب هنا ببيانات اصطناعية تمثيلية (§6).

## 3. الفجوة الفعلية في Preview (فحص قراءة فقط)

| الفحص | النتيجة |
| --- | --- |
| إدخالات `drizzle.__drizzle_migrations` | **28 من 40**؛ آخر مُطبَّق `0027_personal_intelligence` |
| تطابق hash و`created_at` لكل الـ 28 مع ملفات المستودع | نعم، جميعها |
| مقارنة الكتالوج مع قاعدة مرجعية loopback عند `0027` (`compare-canonical-schema.mjs`) | **`schemaDrift: NONE`** — أعمدة 743/743، قيود 405/405، فهارس 175/175، triggers 12/12، دوال 9/9، sequences 1/1 |
| أي كائن من `0028`–`0039` موجود مسبقاً (جداول/فهارس/دوال/triggers/أعمدة) | **لا شيء** |
| الفهرس الذي سيحذفه `0033` (`courier_fare_agreements_order_unique`) | موجود كما هو متوقع |
| جلسات أخرى متصلة بالقاعدة أثناء الفحص | 0 |
| حجم القاعدة | 14 MB |

**الترحيلات المعلّقة (12) بالترتيب:** `0028_fashion_search_attributes`، `0029_soft_radioactive_man`، `0030_swift_living_mummy`، `0031_negotiation_events_append_only`، `0032_wave63_delivery_progress`، `0033_courier_fare_assignment_history`، `0034_tutorial_learning_history`، `0035_ai_usage_allowances`، `0036_marketplace_inquiries`، `0037_pre_integration_closure`، `0038_ai_model_price_entry`، `0039_ai_cache_write_costs`.

**الفجوة الكتالوجية الدقيقة (`0027` → `0039`، مقيسة على قاعدتين مؤقتتين):**

| | عند 0027 | عند 0039 | الفرق |
| --- | ---: | ---: | ---: |
| جداول public | 61 | 80 | +19 |
| أعمدة public | 740 | 981 | +241 |
| قيود (غير NOT NULL) | 404 | 523 | +119 |
| فهارس | 174 | 223 | +49 (+50 جديد، −1 محذوف) |
| triggers | 12 | 22 | +10 |
| دوال | 9 | 12 | +3 |

- **الجداول الـ 19 الجديدة:** `negotiation_events`، `delivery_progress_events`، `tutorial_learning_events`، `ai_usage_reservations`، `ai_usage_counters`، `marketplace_inquiries`، `marketplace_inquiry_events`، `ai_model_prices`، `ai_spend_holds`، `ai_spend_counters`، `ai_cost_events`، `ai_billing_reconciliations`، `privacy_requests`، `privacy_request_events`، `user_privacy_preferences`، `privacy_consent_events`، `billing_webhook_events`، `trust_appeals`، `trust_appeal_events`.
- **الدوال الجديدة:** `negotiation_events_append_only`، `delivery_progress_events_append_only`، `dinar_append_only`.
- **تغييرات على جداول قائمة (كاملة):**
  - `offers.offers_pricing_valid` يُستبدل (انظر 0029/0030).
  - `negotiations.negotiations_amounts_positive` يُستبدل بنسخة أوسع؛ `listed_price_minor` و`offer_amount_minor` يصبحان nullable.
  - `conversations.conversations_shape_check` يُستبدل بنسخة أوسع تضيف `kind='INQUIRY'`.
  - حذف الفهرس الفريد `courier_fare_agreements_order_unique`.
  - لا حذف لأي جدول أو عمود. لا فهارس جديدة على جداول قائمة.

**سبب عطل المحادثة في Preview:** الكود عند HEAD يعتمد على `ai_usage_reservations` (0035) وجداول 0037، و`/api/readyz` يرفض الجاهزية عند `migrations: pending`.

## 4. ما يغيّره كل ترحيل معلّق

| الترحيل | DDL | تعديل بيانات | المخاطر/التوافق |
| --- | --- | --- | --- |
| 0028 | — | `UPDATE marketplace_categories` لصف `fashion`: يضيف aliases `جاكيت`,`معطف` (إن لم توجد) وسمتي `season`,`audience` | إضافي. يفترض `aliases` مصفوفة و`attributes` كائناً — متحقق في Preview |
| 0029 | جدول `negotiation_events` + فهرسان + FK؛ استبدال `negotiations_amounts_positive` و`offers_pricing_valid`؛ DROP NOT NULL على عمودين | `UPDATE marketplace_categories`: يضيف `NEGOTIABLE`,`OPEN_TO_OFFERS` إلى `allowedModes`، و`defaultMode` المفقود أو `QUOTE_REQUIRED` ← `OPEN_TO_OFFERS` | القيد المؤقت يرفض أي عرض بوضع غير معروف أو سعر غير متسق — Preview: 0 مخالفات |
| 0030 (مصحّح 2026-10-24) | استبدال `offers_pricing_valid` بالقيد القانوني (بلا تغيير في القيد) | **`UPDATE offers` لكل الصفوف**: `STARTING_FROM`←`OPEN_TO_OFFERS` مع إبقاء مبلغ البداية و`data.priceRepresentation=STARTING_FROM`، `QUOTE_REQUIRED`←`OPEN_TO_OFFERS` مع `data.priceRepresentation=QUOTE_REQUIRED`، `FIXED`+`data.negotiable='true'`←`NEGOTIABLE`؛ ثم كتابة `data.pricingMode`. الفئات: `allowedModes` القانونية، و`defaultMode` `STARTING_FROM`/`QUOTE_REQUIRED`←`OPEN_TO_OFFERS` | لم يعد يفقد معنى «يبدأ من» أو «حسب التسعيرة» (انظر `DINAR_PRICING_AND_0030_MIGRATION_COMPATIBILITY.md`). الـ hash تغيّر إلى `581225f6…09d8` |
| 0031 | دالة + triggers append-only على `negotiation_events` | — | إضافي |
| 0032 | جدول `delivery_progress_events` + فهرسان + دالة + triggers append-only | — | إضافي. صفوفه لاحقاً تمنع حذف الطلبات الأم |
| 0033 | `DROP INDEX courier_fare_agreements_order_unique` | — | **إرخاء ثابت**: يسمح بأكثر من اتفاق أجرة لكل طلب (لحفظ تاريخ إعادة التعيين). Preview: 0 صفوف في الجدول |
| 0034 | جدول `tutorial_learning_events` + فهرسان | — | إضافي؛ `ON DELETE CASCADE` من `users` |
| 0035 | جدولا `ai_usage_reservations`، `ai_usage_counters` + 3 فهارس | — | إضافي. هو ما يحتاجه فرض حجز استخدام AI — لا تجاوز له |
| 0036 | استبدال `conversations_shape_check` (أوسع)؛ جدولا الاستفسارات + 5 فهارس | — | القيد الجديد يقبل كل صفوف `ORDER`/`AI` القائمة — Preview: 0 مخالفات (60 AI، 1 ORDER) |
| 0037 | 12 جدولاً، فهارس، دالة `dinar_append_only` و6 triggers؛ توسيع قيدي `resource_valid` بإضافة `AUDIO_TRANSCRIPTION` | — | إضافي؛ التوسيع يفحص جدولين جديدين فارغين |
| 0038 | عمود `ai_model_prices.created_by` nullable + FK | — | إضافي |
| 0039 | عمودان nullable على `ai_model_prices`، وعمودان `integer DEFAULT 0 NOT NULL` على `ai_cost_events` | — | إضافي؛ على جداول فارغة تُنشأ في نفس التشغيل |

**ذرية التنفيذ:** `drizzle-orm@0.45.2` (`pg-core/dialect.js`) ينفّذ **كل الترحيلات المعلّقة وإدخالات الدفتر داخل معاملة واحدة**. أي فشل يُرجع السلسلة كلها (مُثبت تجريبياً في §6-ب).

**الأقفال:** المعاملة تأخذ `ACCESS EXCLUSIVE` على `offers`، `negotiations`، `conversations`، `marketplace_categories`، `courier_fare_agreements`، `ai_usage_*`، وأقفال `SHARE ROW EXCLUSIVE` على الجداول المرجعية للمفاتيح الأجنبية (`users`، `markets`، `orders`، `messages`…) حتى الالتزام. بحجم Preview تستغرق العملية ثوانٍ، لكن يجب إيقاف API Preview خلال النافذة.

## 5. مخاطر فقد البيانات

| الخطر | التقييم في Preview |
| --- | --- |
| حذف جداول/أعمدة | **لا يوجد** في 0028–0039 |
| تحويل أوضاع تسعير العروض القديمة (0030) | **Preview: 0 صفوف تتغير فعلياً.** العرض الوحيد `FIXED` مسعّر بلا علامة `negotiable`، و`data.pricingMode` فيه أصلاً `FIXED`. الصف يُعاد كتابته بنفس القيم |
| `STARTING_FROM` كان يتحول إلى `FIXED` ملزم (0030 الأصلي) | **أُزيل بالتصحيح:** يصبح `OPEN_TO_OFFERS` مع علامة `STARTING_FROM`؛ والتفاوض شامل فلا تُفقد نية التفاوض. Preview: 0 صفوف من هذا النوع |
| توسيع سياسة الفئات (0029/0030) | **تغيير سياسة وليس فقد بيانات:** 6 فئات في Preview تسمح اليوم بـ `["FIXED"]` فقط (fashion، home، cars، property، electronics، other) ستسمح بـ `FIXED`,`NEGOTIABLE`,`OPEN_TO_OFFERS`؛ وفئتان (`services`، `digital-services`) تفقدان `STARTING_FROM`/`QUOTE_REQUIRED` لصالح الأوضاع القانونية. كل `defaultMode` في Preview = `FIXED` ويبقى `FIXED` |
| فئة بلا `defaultMode` تصبح `OPEN_TO_OFFERS` (وليس `FIXED`) | Preview: 0 |
| إزالة الفهرس الفريد لاتفاقات الأجرة (0033) | إرخاء ثابت مقصود؛ Preview: 0 صفوف |
| الطلبات والمبالغ المالية | لا ترحيل يعدّل `orders`، `order_items`، `seller_dues`، `payment_*`، `commercial_*`. trigger `order_snapshot_immutable` يبقى. مُثبت بالبصمات (§6-أ) |
| الحسابات، المحادثات، الرسائل، الذاكرة الشخصية | لا تعديل صفوف؛ فقط قيد `conversations` أوسع |

**الاستنتاج:** على بيانات Preview الحالية لا يوجد فقد بيانات؛ التغيير الدلالي الوحيد هو توسيع سياسة أوضاع التسعير في الفئات + بيانات بحث `fashion`.

## 6. أدلة التجارب (PostgreSQL 17.6 مؤقت، loopback `127.0.0.1:55432`، مجلد scratchpad)

الأداة: `lib/db/scripts/preview-migration-check.mjs` (جديدة) — تحسب داخل القاعدة بصمة MD5 لكل جدول (`row_to_json` مرتبة) ولا تُخرج أي محتوى صفوف. `offers` و`marketplace_categories` تُقارن بدون الحقول التي يعيد كتابتها الترحيل، ثم تُطابق قيمها الجديدة مع ناتج التحويل المتوقع المحسوب مسبقاً.

البيانات الاصطناعية (`lib/db/scripts/rehearsal/legacy-fixtures.sql`): سوق JO مفعّل + نسخة سعر، 3 مستخدمين، 7 عروض تغطي كل الأشكال القديمة (`FIXED`، `FIXED`+`negotiable` boolean و string، `STARTING_FROM`، `STARTING_FROM`+`negotiable`، `QUOTE_REQUIRED` بلا سعر، عرض مؤرشف)، 3 طلبات + بنود + مستحقات بائع + payment intent/event محاكاة، 3 مفاوضات (OPEN، COUNTERED، ACCEPTED مرتبطة بطلب)، محادثتا ORDER و AI مع رسائل، فئات بـ `defaultMode` = `QUOTE_REQUIRED` و`STARTING_FROM` ومفقود.

| التجربة | النتيجة |
| --- | --- |
| **أ. ترحيل كامل لبيانات قديمة** — `0027` + بيانات ← الأمر الرسمي `pnpm --filter @workspace/db run migrate` | نجح؛ الدفتر 40/40. **58 جدولاً محمياً متطابقة بالبصمة 100%** (users، orders، order_items، seller_dues، payment_intents، payment_events، negotiations، conversations، messages…). أوضاع العروض = التحويل المتوقع بالضبط (`STARTING_FROM`×2←`FIXED`، `QUOTE_REQUIRED`←`OPEN_TO_OFFERS`، `FIXED`+negotiable×2←`NEGOTIABLE`)؛ `data.pricingMode` = `pricing_mode` لكل الصفوف؛ كل الفئات `allowedModes` قانونية؛ `defaultMode` = المتوقع؛ بيانات `fashion` موجودة؛ 0 قيود غير مُتحقَّقة؛ المبالغ المالية للطلبات لم تتغير |
| **أ-2. إعادة التشغيل** | لا عملية (40 إدخالاً، exit 0) |
| **ب. انحراف/تصادم** — جدول `tutorial_learning_events` موجود مسبقاً | الـ preflight رفض (`STOP`). عند فرض التشغيل: exit 1، **الدفتر بقي 28، لا جداول جديدة، العروض والفئات بلا تغيير، كل البصمات = لقطة ما قبل الترحيل** |
| **ب-2. تصادم متأخر** في `0037` (بعد تنفيذ 0028–0036 داخل المعاملة) | تراجع كامل؛ `--phase=unchanged` = PASS على 60 جدولاً |
| **ج. استعادة من النسخة** — `pg_dump -Fc` قبل الترحيل ← `pg_restore` في قاعدة جديدة | بصمات الـ 60 جدولاً مطابقة للقطة؛ الدفتر 28 |
| **د. مهلة الأقفال** — قفل `ACCESS SHARE` مُمسك على `offers` + `PGOPTIONS='-c lock_timeout=5s …'` | فشل نظيف بعد المهلة، الدفتر 28؛ بدون قفل: نجح في ~1.5 ثانية |
| **هـ. الكتالوج** — loopback عند 0027 مقابل Preview | `schemaDrift: NONE` |
| **و. Preview قراءة فقط** — `--phase=pre` ثم `--phase=unchanged` | PASS؛ كل حواجز البيانات = 0 |
| اختبارات المستودع على قاعدة مؤقتة | `development-tls.test` 7 نجاح + 1 تخطٍّ (الاختبار الحي اختياري)؛ `readiness.test` 11 نجاح |

**حدود الأدلة:** التجارب على PostgreSQL 17.6 وليس 18.6 (لا يوجد عميل 18 هنا)؛ تكافؤ الكتالوج عند `0027` مُثبت عبر الإصدارين. التجارب على بيانات اصطناعية وليست نسخة كاملة من Preview (نسخة PITR شقيقة لم يُصرَّح بها).

## 7. النسخ الاحتياطي والتراجع

**ما تم التحقق منه فعلاً:**

- `RAILWAY_API_TOKEN` الموجود يعيد `Not Authorized` على استعلام بيئة/أحجام Railway (قراءة فقط) — **لا يمكن من هنا التحقق من النسخ الاحتياطية أو PITR أو الجداول الزمنية**. لم تُنشأ نسخة ولم يُفعّل PITR.
- `docs/dinar-next/RAILWAY_BACKUP_READINESS.md` (2026-10-21): حالة النسخ وPITR غير مُتحقَّقة؛ لا يوجد bucket ولا متغيرات `WAL_ARCHIVE_*` (يتسق مع PITR مُطفأ).
- لا يوجد عميل `pg_dump` بإصدار 18 في مساحة العمل (المتاح 16.10 و17.6، و`pg_dump` يرفض خادماً أحدث). نسخة منطقية محلية تتطلب أيضاً موافقة لأنها تنسخ بيانات شخصية (أرقام هواتف، hashes كلمات المرور، رسائل).

**المتطلبات قبل الاعتماد (إلزامية):**

1. المالك يفتح Railway ← المشروع/البيئة/خدمة `Postgres` أعلاه ← **Backups** ويُنشئ **نسخة volume يدوية** ويسجّل وقتها UTC وحالة نجاحها. (اختياري أقوى: تفعيل PITR وانتظار أول base backup — يعيد نشر Postgres ويحتاج موافقة مستقلة.)
2. تسجيل لقطة `--phase=pre` (بصمات فقط) قبل الترحيل مباشرة.

**مسارات التراجع:**

| الحالة | الإجراء |
| --- | --- |
| فشل الأمر (exit ≠ 0) | تراجع تلقائي بالمعاملة. شغّل `--phase=unchanged` ويجب أن يعطي PASS. لا تُعِد المحاولة قبل تحليل السبب (drizzle-kit لا يطبع نص الخطأ؛ استخدم `--phase=pre` لتحديد الكائن المتصادم) |
| نجح الترحيل وفشل `--phase=post` أو ظهر عطل تطبيقي | أوقف API Preview. **لا تكتب SQL عكسياً يدوياً ولا تعدّل الدفتر.** استعد نسخة volume (يستبدل الحجم بعد Deploy، ويحتفظ Railway بالحجم السابق) أو استعد PITR إلى خدمة شقيقة ثم بدّل الاتصال بموافقة منفصلة. شغّل `--phase=unchanged` على المستعاد |
| كتابات حدثت بعد الترحيل | الاستعادة تفقدها؛ لهذا يلزم تجميد الكتابة طوال النافذة |

## 8. الأدوات المضافة/المعدّلة

| الملف | الغرض |
| --- | --- |
| `lib/db/scripts/preview-migration-check.mjs` (+ `pnpm --filter @workspace/db run migration:check`) | `--phase=pre` (preflight + لقطة بصمات)، `--phase=post` (تحقق بعد الترحيل)، `--phase=unchanged` (تحقق بعد فشل أو استعادة). قراءة فقط دائماً؛ يرفض كتابة اللقطة داخل المستودع؛ `--target=loopback` يرفض أي مضيف غير loopback |
| `lib/db/scripts/rehearsal/baseline-migrate.mjs` | يبني قاعدة مؤقتة عند أي نقطة من الدفتر عبر migrator الأصلي (loopback فقط) |
| `lib/db/scripts/rehearsal/legacy-fixtures.sql` | البيانات الاصطناعية القديمة المستخدمة أعلاه |
| `lib/db/src/clone-migration-guard.ts` | **تثبيت `0039_ai_cache_write_costs` بعد مراجعته** (sha256 `724d6785…49cc`). قبل ذلك كان `migrate:clone` واختباره يرفضان دفتر الـ 40 إدخالاً (الاختبار كان يتوقع 39 وهو فاشل فعلياً عند HEAD) |
| `artifacts/api-server/test/development-tls.test.ts` | تحديث التوقع إلى 40 إدخالاً |

## 9. العوائق المتبقية

1. **النسخة الاحتياطية غير مُتحقَّقة** — لا يوجد دليل على نقطة استعادة لـ Preview. *عائق مانع.*
2. **موافقة المالك الصريحة** — ترحيلات `0028–0039` سبق رفضها (`DINAR_MASTER_EXECUTION_LEDGER.md`)، ويتطلب الأمر قبول تغييرات سياسة الفئات (§5). *عائق مانع.*
3. غير مانع: التجارب على PG 17.6 لا 18.6؛ لا تجربة على نسخة كاملة من البيانات (ممكنة لاحقاً عبر `migrate:clone` الذي أصبح يقبل الـ 40 إدخالاً، بعد استعادة PITR شقيقة بموافقة).

## 10. قائمة اعتماد المالك

- [ ] أؤكد أن الهدف هو Railway `dinar-development-canonical` / `development` / `Postgres` فقط، وليس الإنتاج.
- [ ] أنشأت نسخة volume يدوية من تبويب Backups ونجحت؛ الوقت UTC: ________.
- [ ] (اختياري) حالة PITR: ________؛ نافذة الاستعادة: ________.
- [ ] أقبل توسيع أوضاع التسعير للفئات الثماني إلى `FIXED`/`NEGOTIABLE`/`OPEN_TO_OFFERS` وتحويلات 0030 المصحّح: `STARTING_FROM`←`OPEN_TO_OFFERS`+علامة، `QUOTE_REQUIRED`←`OPEN_TO_OFFERS`+علامة، `FIXED`+negotiable←`NEGOTIABLE`.
- [ ] أقبل سياسة التفاوض الشامل (`DINAR_UNIVERSAL_NEGOTIATION_POLICY.md`): كل إعلان يقبل عرض سعر من المشتري، والقرار للبائع.
- [ ] أقبل حذف القيد الفريد `courier_fare_agreements_order_unique` (0033).
- [ ] أوافق على إيقاف Preview API (تجميد الكتابة) لمدة النافذة (دقائق).
- [ ] أوافق على تشغيل الأوامر في §11 بالضبط، عند الـ commit المعتمد، ضد Preview فقط.
- [ ] أوافق على مسار التراجع في §7 إذا فشل التحقق اللاحق.

## 11. الأوامر الدقيقة لترحيل Preview المستقبلي (بعد الاعتماد فقط)

```sh
# 0) أوقف workflow "API Server" في Replit (تجميد الكتابة). لا تغيّر أي سر.
cd /home/runner/workspace
git status --short            # يجب أن تكون فارغة
git rev-parse HEAD            # يجب أن يطابق الـ commit المعتمد
export NODE_ENV=development   # DINAR_DEV_DATABASE_URL موجود مسبقاً؛ لا تطبعه
SNAP=/tmp/dinar-preview-pre-$(date -u +%Y%m%dT%H%M%SZ).json

# 1) Preflight قراءة فقط — يجب: verdict PASS، appliedEntries 28، 12 معلّقة، otherSessions 0
pnpm --filter @workspace/db run migration:check --phase=pre --target=preview --snapshot="$SNAP"

# 2) تأكيد وجود نسخة Railway اليدوية (خطوة المالك في §10). لا تتابع بدونها.

# 3) الترحيل الرسمي الوحيد (TLS مُتحقَّق، معاملة واحدة، مهلة أقفال)
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' \
  pnpm --filter @workspace/db run migrate

# 4أ) إن نجح: تحقق لاحق — يجب PASS، الدفتر 40، changed = []
pnpm --filter @workspace/db run migration:check --phase=post --target=preview --snapshot="$SNAP"

# 4ب) إن فشل الأمر 3: تأكيد التراجع التلقائي — يجب PASS، ثم توقف وأبلغ
pnpm --filter @workspace/db run migration:check --phase=unchanged --target=preview --snapshot="$SNAP"

# 5) أعد تشغيل workflow "API Server" ثم:
curl -s "https://$REPLIT_DEV_DOMAIN/api/readyz"
# المتوقع: {"status":"ready","checks":{"database":"ready","migrations":"current"}}
```

ممنوع: `drizzle-kit push`، تعديل `drizzle.__drizzle_migrations` يدوياً، SQL بديل مكتوب يدوياً، توجيه `DINAR_DEV_DATABASE_URL` لقاعدة أخرى، أو تشغيل أي من ذلك على الإنتاج.
