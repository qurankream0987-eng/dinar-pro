# DINAR — Claude 00: الأساس المستقل

**التاريخ:** 2026-10-26
**المستودع:** `qurankream0987-eng/dinar-pro`. الفرع `main` = `b1b20e513ed25952bc086778fb71af88adcc54ba`، وهو commit واحد نظيف بلا تاريخ Replit.
**فرع العمل:** `claude/00-baseline` (محلي، **غير مرفوع**). الـcommits: `25d2852` و`3748046` وهذا التقرير.
**البيئة:** حاوية Claude Code سحابية، Node 22.22.0 (المشروع يعلن 24)، pnpm 10.28.0، PostgreSQL **16.15** على loopback (`127.0.0.1:55432`، وعنقودان إضافيان على 55479 و55438 لاختبارين يفرضان منفذاً خاصاً)، Chromium 1194، tesseract 5.3.4 (ara+eng).
**العزل:** قاعدة جديدة لكل suite، و`env -i`، وpreload `test/isolation/net-guard.mjs` الذي يسجل كل محاولة اتصال خارجية، وstub محلي لـGoogle Fonts. **مجموع محاولات الخروج في كل التشغيلات: 0.** لا Railway، ولا Replit DB، ولا مزود AI، ولا دفع.

> الفرق عن `sandbox.sh` الخاص بـReplit: هنا لا يوجد network namespace لأن الحاوية تعمل كـroot وفيها PG16، والحماية على مستوى Node عبر net-guard. Chromium لا يمر عبر net-guard؛ وُجّهت نطاقات الخطوط إلى 127.0.0.1.

## 1. البناء

| الأمر | النتيجة |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 (533 حزمة) |
| `pnpm run typecheck` | exit 0 (51 ثانية) |
| `pnpm --filter @workspace/api-server run build` | exit 0 (قبل التعديلات وبعدها) |
| `pnpm --filter @workspace/dinar run build` | exit 0؛ chunk رئيسي 828.67 kB (243.95 kB gzip) |
| `drizzle-kit migrate` على قاعدة فارغة | 40/40، 80 جدولاً، على PG16 |
| `pnpm audit` | 1 high: Zod 3.25.76 (GHSA-mrhx-c7xc-m3w5) |

## 2. الاختبارات: أول محاولة مسجّلة كما هي

**الجولة 1 (بدون seed، أُوقفت بعد 13 suite):** 3 نجحت و10 فشلت، وكلها لسبب واحد: `JO must be an active market`. بدون seed، السوق غير نشط.

**الجولة 2 (seed لكل suite، 75 suite):** **54 نجحت و21 فشلت، و0 محاولات خروج.** تحليل الـ21:

| السبب | العدد | الإجراء |
|---|---:|---|
| خطأ في أداة التشغيل عندي: تسرب `LOG_SCAN` إلى خطوة seed، أو اسم قاعدة فيه "development"، أو seed لـsuite يتوقع قاعدة فارغة، أو اسم قاعدة إلزامي | 9 | أُعيدت بعد التصحيح، و**كلها نجحت** |
| stub الخطوط لم يكن مشغلاً بعد (ERR_CONNECTION_REFUSED) | 3 | block-a 1/1، block-c 50/50، block-e 46/46 |
| tesseract غير مثبت | 1 | ثُبت من Ubuntu: 11/11 |
| مسار Chromium مثبت على Replit (`/repl/tools/bin/chromium`) | 2 | symlink: security نجح فيه XSS؛ phase1 ما زال يحتاج تخزين ملفات |
| اختبار قديم لا يطابق المصدر (`nl-commerce-followup-probes`) | 1 | يفشل بنفس الشكل على `b1b20e5`؛ صُحّح الاختبار |
| **عيب حقيقي:** `/api` غير المعروف يعيد HTML عند تفعيل المحاكاة (`same-origin-web` 7/8) | 1 | **أُصلح** (`3748046`): 8/8 |
| تذبذب توقيت DS-12 | 1 | انظر §4 |
| تخزين الملفات / بنية اختبار | 3 | BLOCKED، انظر §3 |

### الحالة النهائية على HEAD بعد الإصلاحات (أُعيد تشغيلها على الكود النهائي)

| Suite | النتيجة |
|---|---|
| `api.test` | 63/63 |
| `commerce-journey` | 8/8 |
| `wave4-payment-acceptance` | 1/1 (مجمّع) |
| `block-f3-commerce` | 17/17 |
| `command-f-journeys` (متصفح) | 3/3، 9 رحلات، 0 أخطاء console |
| `same-origin-web` (مع المحاكاة) | 8/8 |
| `security-acceptance` | 11/12؛ الفاشل (12) BLOCKED بسبب التخزين |
| `nl-commerce-followup-probes` | 1/1 |
| **جديد** `payment-order-state` | 3/3 (فشل 3/3 قبل الإصلاح) |
| **جديد** `request-collection-bounds` | 3/3 (فشل 2/3 قبل الإصلاح) |
| **جديد** `listing-edit-snapshot` | 2/2 (سيناريو H) |

### بقية الـsuites (الجولة 2 أو إعادة التشغيل؛ كلها على كود يتضمن إصلاحات المال)

ناجحة: admin-bootstrap 5/5 (بلا seed)، ai-provider، ai-transport، block-a 1/1، block-c 50/50، block-d 28/28 (LOG_SCAN)، block-e 46/46، block-f0/f1/f2/f4/f5، closure-ai-cost/integrations/notifications/privacy، command-a 22/22، command-a-probe، command-b/c/d، command-e (96 قياساً)، commerce، contact-browser-microclosure، conversation، conversation-marketplace-isolation، conversation-router، database-url-selection، development-tls 7/7، employment، experience-upgrade، fresh-environment 9/9، g-final 22/22، g1-provider 39/39، g2-smart-conversation، g3-ui، gemini-gateway، listing-image-policy-review 11/11، listing-photo-vision-provider، listing-pricing-invariants 5/5، live-model-benchmark، location-policy، market-capability-registry، marketplace-category-compatibility، marketplace-intelligence، monitoring، next-g1/g2/g3، nl-commerce-microclosure، personal-intelligence 1/1، phase2-commission 1/1 (مع seed التطوير)، phone-verification-development-bypass، promotion-intent، promotions، r5-delivery-economics، readiness، storage-s3-wire، universal-control، universal-negotiation، wave3، xp-probe.

خارج قاعدة البيانات: الواجهة `test:surfaces` 14/14، `test:deepseek-stream` 11/11، `test:handoff` 9/9. وفي الـAPI: `test:db-guard` 8/8، `test:secrets` 1/1، `test:storage-portability` 2/2، `test:storage-s3-wire` 6/6، `test:benchmark-guards` 27/27.

## 3. غير مكتمل أو BLOCKED

| Suite | السبب |
|---|---|
| `lib/db test:release-migration` | 3/11. البقية تتطلب **PostgreSQL 18+**. `apt.postgresql.org` محجوب (403)، وتشغيل ثنائيات PG18 من npm لم يُسمح به |
| `security-acceptance` #12 | يشغّل نسختين من `dist` تتطلبان `PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` (Replit Object Storage). القيم الوهمية أفسدت التسجيل، فلم تُستخدم |
| `phase1-acceptance` | رفع الصور يحتاج تخزين ملفات حقيقياً ("expected 2 completed photo uploads; got 0") |
| `listing-image-publication-acceptance` | **تعارض في بنية الاختبار:** يفرض اسم القاعدة `dinar_image_review_test`، وحارس `run.mjs` يرفض أي اسم خارج `dinar_(test|acceptance|…)_*`. لا يمكن تشغيله عبر المشغّل القياسي |
| `deepseek-chat-compatibility` DS-12 | 7/9 على HEAD و8/8 على `b1b20e5`. الفشلان وقعا تحت حمل متزامن، و5/5 بالتناوب الهادئ. تذبذب توقيت في تسوية حجز تكلفة AI بعد انقطاع العميل، من عائلة DS-15. P2 |

## 4. التحقق من ادعاءات Replit

| الادعاء | النتيجة |
|---|---|
| البناء وtypecheck ينجحان | **مؤكد** |
| 40 ترحيلاً تعمل على قاعدة نظيفة | **مؤكد** (على PG16 أيضاً) |
| `api.test` 63/63، Command A 22/22، E 2/2 (96 قياساً)، F 3/3 | **مؤكد** |
| Readiness 15/15 (fail-closed) | **مؤكد** |
| Zod 3.25.76 high | **مؤكد**؛ المسار الآن مقيد (S1) والترقية معلقة |
| A–J غير مكتملة في المتصفح | **مؤكد**. أُضيف دليل API للسيناريو H |
| "التجارة والدفع المحاكى PASS" | **جزئي**: عيبان ماليان (D1/D2) لم تغطهما suites السابقة، وأُصلحا |
| "حد المحاولات لكل عملية" (`threat_model.md`) | **قديم**: الحد الآن في PostgreSQL عبر النسخ المتعددة |

## 5. التغييرات المصدرية

| الملف | التغيير |
|---|---|
| `artifacts/api-server/src/lib/payments/service.ts` | رفض الالتقاط لطلب ملغى أو منتهي الحجز (D1) |
| `artifacts/api-server/src/routes/marketplace.ts` | منع إلغاء طلب محصَّل غير مسترد (D2) |
| `artifacts/api-server/src/app.ts` | حد 2,000 عنصر مصفوفة لجسم JSON ‏(S1)؛ و404 بصيغة JSON لكل `/api` غير معروف (S2) |
| `artifacts/api-server/test/payment-order-state.test.ts` | جديد |
| `artifacts/api-server/test/request-collection-bounds.test.ts` | جديد |
| `artifacts/api-server/test/listing-edit-snapshot.test.ts` | جديد (سيناريو H) |
| `artifacts/api-server/test/nl-commerce-followup-probes.test.ts` | تصحيح توقع قديم |
| `artifacts/api-server/package.json` | 3 سكربتات اختبار جديدة |
| `CLAUDE.md` + 4 تقارير `docs/dinar-next/CLAUDE_*` | جديدة |

## 6. ملاحظات قابلية النقل (Railway)

- خادم `dist` يرفض البدء دون تخزين ملفات مضبوط: Replit (`PRIVATE_OBJECT_DIR`...) أو S3 (`OBJECT_STORAGE_S3_*`). على Railway يلزم S3.
- المسار `/repl/tools/bin/chromium` يظهر في 29 ملف اختبار (غالباً كقيمة افتراضية). `phase1-acceptance` و`security-acceptance` فشلا عليه رغم ضبط `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE`، فلا يمرران المتغير إلى سكربت المتصفح الفرعي. يُصلح في موجة بنية الاختبار.
- `tesseract` يأتي من nix الخاص بـReplit (`.replit`)، ويلزم في صورة Railway لفحص صور الإعلانات.
- `release-migration` يتطلب PG18، فيجب أن يكون Postgres على Railway 18+.

## 7. إعادة الإنتاج

السكربتات المستخدمة (خارج المستودع) هي `run-suite.sh` (قاعدة جديدة + migrate + `env -i` + net-guard) و`run-all.sh` و`rerun.sh`. منطقها موثق في `CLAUDE.md` § Running tests، والمقترح تحويلها إلى مهارة `dinar-test-env` (انظر `CLAUDE_SKILLS_PLAN.md`).
