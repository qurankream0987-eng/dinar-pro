# JassimAI Production — التقرير النهائي للجاهزية

`production` هي البيئة الدائمة. الموقع الحي (`jassimai.com` على بيئة staging القديمة) يبقى يعمل حتى التحويل.

## 1. ما اكتمل
- **الكود:** كل عمل staging (`bbfe8f3`) وacceptance (`0510b41`) وهذه المحادثة في الفرع؛ 241 حزمة اختبار ناجحة؛ الإصلاحات منشورة.
- **قاعدة البيانات:** `jassimai-production-postgres` / `jassimai_production` (PG 18.7، 5 GB) فارغة؛ التشغيل الجاف أكد 78 هجرة معلّقة وصحة سجل الإصدار.
- **التغييرات المرحلية (14، غير مطبّقة):** التطبيق مثبّت على commit `29e6702`؛ `DATABASE_URL` → القاعدة الجديدة؛ `DINAR_MIGRATION_EXPECTED_DATABASE=jassimai_production`؛ هدف وإقرار هجرة production؛ كل الميزات المدفوعة والحية معطّلة (`DINAR_LIVE_PROVIDERS_ENABLED=false`، Whop، الاشتراكات، الاتصالات الحية، البطاقات الذكية؛ الذكاء محجوب).
- **التخزين:** يُعاد استخدام bucket بيئة production الموجود (Railway يعطي كل بيئة نسخة معزولة) — لا خدمات جديدة.
- **النسخ الاحتياطي:** Railway Volume Backups + PITR (مدمجة) — لا job إضافي. السكربت `scripts/railway/production-backup.sh` يبقى اختياريًا.

## 2. إجراءات المالك الإلزامية (في Railway → production → `jassimai-acceptance-app` → Variables، كمتغيرات مرحلية أيضًا)
1. `SESSION_SECRET` = `${{secret(64)}}`.
2. متغيرات التخزين الخمسة كمراجع لـ bucket بيئة production: `OBJECT_STORAGE_S3_BUCKET/ENDPOINT/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY` = `${{<bucket>.BUCKET}}` … (من تبويب Credentials للـ bucket)، و`OBJECT_STORAGE_S3_URL_STYLE=virtual`.
3. `APP_ORIGIN=https://jassimai.com`، `JASSIMAI_PUBLIC_URL=https://jassimai.com`، `GOOGLE_OAUTH_CLIENT_ID`، `VITE_GOOGLE_CLIENT_ID` (نفس قيم الموقع الحي).
4. Google Cloud Console: إضافة عنوان production المؤقت إلى Authorized origins/redirects (للاختبار قبل التحويل).
5. `RESEND_API_KEY`/`RESEND_FROM_EMAIL` لـ production (أو حذفهما لتعطيل البريد).
6. `GATE_USER`/`GATE_CADDYFILE` جديدة في `jassimai-acceptance-gate`.
7. تفعيل Backups (يومي/أسبوعي/شهري) على حجم `jassimai-production-postgres`.

## 3. العوائق التقنية الحقيقية
1. **المتغيرات السرية أعلاه** — بدونها لا يعمل تسجيل الدخول ولا رفع الصور.
2. **الشبكات المعزولة بين البيئات:** القاعدة والـ bucket في staging لا تُرى من production. الحل الأبسط: job نسخ مؤقت **في بيئة staging** يكتب إلى production عبر TCP proxy مؤقت على قاعدة production (يُحذف فورًا بعد النسخ)، ونسخ الملفات بـ `rclone` ببيانات اعتماد bucket production يضعها المالك في الـ job.
3. **DNS:** نقل `jassimai.com` يتطلب تعديل سجل DNS لدى مسجّل النطاق إلى هدف Railway الجديد (وصول المالك).
4. **توافق سجل الهجرات:** يُتحقق منه في البروفة (الخطوة 4.3) — إن كانت هجرات قاعدة الموقع الحي ليست بادئة مطابقة لخطتنا يتوقف كل شيء آليًا قبل أي تغيير.

## 4. خطوات نقل البيانات والملفات (بموافقتك فقط)
**البروفة (الموقع الحي يعمل كالمعتاد):**
1. نسخة احتياطية للموقع الحي عبر `dinar-staging-backup-job` الموجود (يتحقق ويستعيد تلقائيًا).
2. فتح TCP proxy مؤقت على `jassimai-production-postgres`؛ job في staging (`postgres:18`): `pg_dump -Fc` من `dinar_staging` → `pg_restore --no-owner` إلى `jassimai_production`؛ ثم مقارنة عدد الصفوف لكل جدول على الجانبين؛ إغلاق الـ proxy.
3. تشغيل job الهجرة الجاف في production: يجب أن يُظهر المطبَّق = عدد هجرات الموقع الحي والمعلّق = الباقي حتى 0077، دون رفض.
4. job ملفات في staging (`rclone/rclone`): `rclone copy` من `dinar-staging-ams` إلى bucket production ثم `rclone check` (العدد + المجموع الاختباري).
5. تطبيق التغييرات المرحلية ← يُنشر التطبيق خلف البوابة ويطبّق الهجرات المتبقية على النسخة.
6. فحوص على العنوان المؤقت: الصحة، الدخول، البحث، صفحة منتج بصورها، طلب تجريبي، لوحة الإدارة.

**النسخ النهائي (نافذة صيانة ≈ 15–30 دقيقة):**
1. إيقاف كتابة الموقع الحي: إزالة النشر النشط لـ `dinar-staging-app` (Railway: Remove deployment؛ قابل للاستعادة فورًا).
2. نسخة احتياطية نهائية للموقع الحي.
3. إعادة إنشاء `jassimai_production` فارغة ثم تكرار الخطوات 2–4 (بيانات + دلتا الملفات)، ثم إعادة نشر تطبيق production (يطبّق الهجرات).
4. التحقق من تطابق الأعداد.

## 5. التحويل والرجوع
**التحويل:**
1. إزالة `jassimai.com` و`staging.jassimai.com` من `dinar-staging-app`.
2. إضافة `jassimai.com` إلى `jassimai-acceptance-app` في production؛ تحديث سجل DNS حسب ما يعرضه Railway؛ انتظار الشهادة.
3. إزالة البوابة من المسار العام (النطاق يشير للتطبيق مباشرة).
4. فحوص ما بعد التحويل؛ تفعيل الميزات لاحقًا واحدة واحدة بموافقتك.

**الرجوع (إن فشل أي فحص):**
1. إعادة `jassimai.com` إلى `dinar-staging-app` وإعادة DNS.
2. Redeploy لآخر نشر ناجح لـ `dinar-staging-app` (`6da638e2`، `canRollback: true`).
3. قاعدة الموقع الحي لم تُلمس (النسخ قراءة فقط منها) — لا فقدان بيانات، إلا ما كُتب في production بعد التحويل (يُستخرج يدويًا إن لزم).
