# JassimAI Production — تقرير التحضير (النسخ الاحتياطي، التخزين، الإعدادات، أمان الهجرة)

> بيئة `production` هي البيئة الدائمة والرئيسية لجاسم وموقعه الرسمي. هذا التقرير تحضير فقط: لم يُربط التطبيق بقاعدة البيانات الجديدة، لم تُطبّق هجرات، لم تُنسخ بيانات أو ملفات، لم يُنشأ أو يُفعّل أي job نسخ احتياطي، ولم تُلمس acceptance أو بيئة staging العامة.

معرّفات: المشروع `dinar-development-canonical`؛ بيئة production `7269f58f-…`؛ قاعدة البيانات `jassimai-production-postgres` (`jassimai_production`، PostgreSQL 18.7، حجم 5 GB، europe-west4)؛ job الهجرة `jassimai-production-migration-dry-run`.

---

## 1. استراتيجية النسخ الاحتياطي

### 1.1 نسخ Railway للحجم (Volume Backups) — متاحة
من توثيق Railway: نسخ يدوية أو مجدولة يومي/أسبوعي/شهري من تبويب **Backups** في إعدادات الخدمة؛ اليومية تُحفظ 6 أيام، الأسبوعية 27 يومًا، الشهرية 89 يومًا؛ الاستعادة تنشئ حجمًا جديدًا وتترك القديم غير مركّب. **تنبيه موثّق:** مسح الحجم (Wipe) يحذف كل نسخه — لذلك لا تكفي وحدها.
Railway يوفّر أيضًا **Point-in-Time Recovery** لـ Postgres (أرشفة WAL عبر pgBackRest إلى bucket، نافذة ≈ 4 أسابيع) — موصى به بعد النقل.

**التوصية:** تفعيل الثلاثة (يومي + أسبوعي + شهري) على `jassimai-production-postgres`، وتفعيل PITR عند بدء استقبال بيانات حقيقية.

### 1.2 نسخ منطقي مستقل (pg_dump) — مقترح للمراجعة، غير مفعّل
الملفات في المستودع: `scripts/railway/production-backup.sh` و`Dockerfile.backup`.

| البند | الإعداد المقترح |
|---|---|
| الخدمة | `jassimai-production-backup-job` في `production` فقط، من `Dockerfile.backup` (postgres:18 + curl) مثبّتة على commit مُراجع |
| الجدولة | يوميًا `17 3 * * *` (03:17 UTC)، `restartPolicy: NEVER` |
| المصدر | `DATABASE_URL=${{jassimai-production-postgres.DATABASE_URL}}` |
| الوجهة | bucket **منفصل** `jassimai-production-backups` (ليس bucket ملفات التطبيق) عبر مراجع `${{jassimai-production-backups.*}}` |
| الحراسة | `BACKUP_EXPECTED_HOST=jassimai-production-postgres.railway.internal`، `BACKUP_EXPECTED_DATABASE=jassimai_production`، `BACKUP_EXPECTED_BUCKET_PREFIX=jassimai-production-backups` |
| الصيغة | `pg_dump --format=custom --no-owner --no-privileges` + ملف sha256 + عدد الجداول وسجل الهجرات |
| التحقق | إعادة تنزيل ومطابقة sha256؛ التأكد أن الوصول المجهول مرفوض (403/401) |
| الاحتفاظ | اليومي 35 يومًا؛ أول نسخة من كل شهر 12 شهرًا |

**ما يرفضه السكربت قبل أي اتصال** (اختُبر محليًا دون اتصال): قاعدة staging العامة (`dinar-staging-postgres-ams`) ✗، قاعدة acceptance (`postgres-j--d`) ✗، أي عنوان عام غير `.railway.internal` ✗، bucket ملفات التطبيق ✗. وبعد الاتصال: اسم قاعدة غير `jassimai_production` ✗، PostgreSQL أقل من 18 ✗.
**عزل الشبكة (موثّق Railway):** لكل بيئة شبكة خاصة معزولة؛ الخدمات في بيئات مختلفة لا تصل لبعضها عبر الشبكة الخاصة — فلا يستطيع job في production الوصول لقاعدة acceptance أو staging أصلًا.

### 1.3 اختبار الاستعادة
- **أسبوعيًا** (`BACKUP_MODE=restore-test`): ينزّل أحدث نسخة، يطابق sha256، يستعيدها في قاعدة مؤقتة `jassimai_restore_verify_<ts>` على **خادم منفصل** `jassimai-production-restore-test` (Postgres صغير في production)، يقارن عدد الجداول وسجل الهجرات بما سُجّل وقت النسخ، ثم يحذف القاعدة المؤقتة.
- السكربت يرفض أن يكون هدف الاستعادة هو خادم الإنتاج نفسه.
- **قبل التفعيل:** تشغيل تجريبي واحد يدوي لكل وضع على القاعدة الفارغة الحالية، ومراجعة السجل (`BACKUP_OK` و`RESTORE_TEST_OK`).
- **استعادة كوارث فعلية:** موافقة المالك، استعادة إلى قاعدة جديدة، التحقق، ثم تحويل التطبيق إليها — لا كتابة فوق القاعدة الأصلية.

---

## 2. تخزين الملفات للإنتاج

| البند | التفاصيل |
|---|---|
| المزوّد | S3-متوافق؛ الكود يتطلب `OBJECT_STORAGE_PROVIDER=s3` خارج Replit |
| المتغيرات المطلوبة | `OBJECT_STORAGE_S3_BUCKET`، `OBJECT_STORAGE_S3_ENDPOINT`، `OBJECT_STORAGE_S3_REGION`، `OBJECT_STORAGE_S3_ACCESS_KEY_ID`، `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY` |
| اختيارية | `OBJECT_STORAGE_S3_URL_STYLE` (`path` افتراضيًا؛ Railway يستخدم `virtual`)، `OBJECT_STORAGE_S3_PRIVATE_PREFIX` (افتراضي `private`)، `OBJECT_STORAGE_S3_PUBLIC_PREFIXES` |
| إنشاء الـ bucket | bucket باسم `jassimai-production-files` في `production` (Railway يعطي كل بيئة نسخة bucket منفصلة ببيانات اعتماد معزولة — موثّق) |
| الربط | كل المتغيرات الخمسة **مراجع Railway** للـ bucket (`${{jassimai-production-files.*}}`) لا قيم مكتوبة؛ هكذا لا يمكن أن تشير لـ bucket بيئة أخرى |
| الصلاحيات | خاص (Railway buckets خاصة افتراضيًا)؛ الملفات العامة تُقدَّم عبر الخادم أو روابط موقّعة فقط؛ لا وصول مجهول |
| الملكية والعزل | التطبيق يكتب تحت `private/` و`public/`؛ لا خدمة أخرى تملك بيانات اعتماد هذا الـ bucket إلا job النسخ الاحتياطي للملفات (لاحقًا، قراءة فقط) |
| النسخ الاحتياطي | نسخ دوري لمحتوى الـ bucket إلى `jassimai-production-backups/files/` (يُصمَّم ويُراجع قبل الإطلاق) |
| ملاحظة | الـ bucket الذي أنشأته نسخة البيئة (`jassimai-acceptance-ams` في production) يُترك كما هو ولا يُستخدم للإنتاج — اسمه مضلل |

### ترحيل صور المنتجات الحالية (لاحقًا، بموافقة منفصلة)
1. جرد مفاتيح الكائنات المشار إليها في قاعدة الموقع الحي (من جداول صور المنتجات) — أسماء فقط.
2. نسخ من bucket الموقع الحي (`dinar-staging-ams`) إلى `jassimai-production-files` بنفس المفاتيح، عبر job في production يملك قراءة فقط على المصدر.
3. التحقق: عدد الكائنات ومجموع الأحجام وsha256 لكل كائن متطابق؛ كل صورة مشار إليها في القاعدة موجودة.
4. يتم في نفس نافذة نسخ قاعدة البيانات حتى لا تظهر منتجات بلا صور.

---

## 3. قائمة متغيرات الإنتاج (أسماء فقط)

**مطلوب لتشغيل التطبيق:** `DATABASE_URL` (مرجع لـ `jassimai-production-postgres`)، `NODE_ENV=production`، `DINAR_DEPLOYMENT_ENV=production`، `PORT`، `RAILWAY_DOCKERFILE_PATH`، `DINAR_MIGRATION_TARGET=production`، `DINAR_MIGRATION_ACK=APPLY_PRODUCTION_MIGRATIONS`، `DINAR_MIGRATION_EXPECTED_DATABASE=jassimai_production`، `APP_ORIGIN`، `JASSIMAI_PUBLIC_URL`.

**المصادقة وأمن الجلسات:** `SESSION_SECRET` (جديد، `${{secret(64)}}`)، `APP_ADDITIONAL_ORIGINS`، `TRUST_PROXY_ORIGIN`، `PUBLIC_CANONICAL_HOST`، `HSTS_INCLUDE_SUBDOMAINS`، `CSP_CONNECT_EXTRA_ORIGINS`، `BDINAR_REQUIRE_PHONE_VERIFICATION`. البوابة: `GATE_USER`، `GATE_CADDYFILE` (جديدة لـ production).

**Google OAuth:** `GOOGLE_OAUTH_CLIENT_ID`، `VITE_GOOGLE_CLIENT_ID` (+ إضافة عنوان production المؤقت ثم `jassimai.com` في إعدادات Google).

**البريد:** `RESEND_API_KEY`، `RESEND_FROM_EMAIL`، `DINAR_NOTIFICATION_CHANNEL`؛ `DINAR_EMAIL_STAGING_ALLOWLIST` يبقى حتى الإطلاق.

**مزودو الذكاء:** `DINAR_AI_PROVIDER`، `DINAR_AI_MODEL`، `DINAR_DEEPSEEK_API_KEY`، `DINAR_AI_VISION_*`، `DINAR_AI_MAX_RETRIES`، `DINAR_AI_ROUTING_MODE`، `DINAR_AI_MODEL_FALLBACK` — **معطّل:** `BDINAR_BLOCK_MODEL_CALLS=1`، و`DINAR_AI_PRODUCTION_APPROVED` غير مضبوط.

**تخزين الملفات:** `OBJECT_STORAGE_PROVIDER=s3` + المتغيرات الخمسة المطلوبة (مراجع) + الاختيارية.

**مفاتيح الميزات (معطّلة):** `DINAR_SMART_STORE_CARDS=false`، `DINAR_CONNECT_LIVE_CALLS=false`، `WHOP_ENABLED=false`، `DINAR_WHOP_BILLING_ENABLED=false`، `DINAR_LIVE_PROVIDERS_ENABLED=false`، `DINAR_PREMIUM_TRIAL_ENABLED` غير مضبوط.

**تكاملات خارجية (غير مضبوطة حتى إذن منفصل):** Whop (`WHOP_API_KEY`، `WHOP_WEBHOOK_SECRET`، `WHOP_BILLING_WEBHOOK_SECRET`، `WHOP_COMPANY_ID`، `DINAR_WHOP_PLAN_MAP`…)، Connect (`DINAR_CONNECT_VAULT_KEY`، `DINAR_CONNECT_CLOUDFLARE_*`)، Twilio (`TWILIO_*`)، `DINAR_WHATSAPP_PROVIDER`، `DINAR_MONITORING_PROVIDER`.

**تأكيد التعطيل:** الدفع، الاشتراكات، الاتصالات الحية، الذكاء الحي، Twilio، Whop — كلها معطّلة. `DINAR_LIVE_PROVIDERS_ENABLED` **منسوخ من acceptance بقيمة لا أستطيع قراءتها** — يجب على المالك ضبطه صراحة إلى `false` (أو إضافته إلى التغييرات المرحلية).

---

## 4. أمان job الهجرة — الأدلة

| التحقق | الدليل |
|---|---|
| مثبّت على commit مقصود | النشر `e2c0dec1`: `commitHash 690d890416a3…` (رأس الفرع وقت الإنشاء) — مثبّت، لا يتبع الفرع |
| يقرأ `jassimai_production` فقط | متغيره `DATABASE_URL=${{jassimai-production-postgres.DATABASE_URL}}`؛ السجل: `"database":"jassimai_production"` |
| يفرض التشغيل الجاف | أمر البدء: `test "$DINAR_MIGRATION_DRY_RUN" = 1` قبل أي شيء؛ السجل: `"dryRun":true,"applied":0,"status":"PENDING_DRY_RUN"` |
| لا يطبّق صدفة | لو أُزيل `DINAR_MIGRATION_DRY_RUN` يفشل أمر البدء قبل التشغيل؛ `restartPolicy: NEVER`؛ لا يُعاد تشغيله تلقائيًا |
| لا يصل لبيئات أخرى | أمر البدء يرفض أي مضيف غير `*.railway.internal`؛ والشبكة الخاصة معزولة لكل بيئة (موثّق)؛ والسكربت يرفض قاعدة اسمها غير `jassimai_production` |
| لا نطاقات | لا نطاق عام ولا TCP proxy |

---

## 5. الحدود المحترمة
لم يتغير: اتصال التطبيق بقاعدة البيانات، الهجرات، البيانات، الملفات، النطاقات، التكاملات، acceptance، staging العامة. التغييرات المرحلية (11) ما زالت غير مطبّقة.

## إجراءات المالك المطلوبة
1. تفعيل Volume Backups اليومية/الأسبوعية/الشهرية على `jassimai-production-postgres`.
2. مراجعة `scripts/railway/production-backup.sh` و`Dockerfile.backup` والموافقة (أو التعديل) قبل الإنشاء.
3. الموافقة على إنشاء: `jassimai-production-files`، `jassimai-production-backups`، `jassimai-production-restore-test`.
4. ضبط `SESSION_SECRET` وبيانات البوابة الجديدة، `APP_ORIGIN`، Google OAuth، البريد، و`DINAR_LIVE_PROVIDERS_ENABLED=false`.
