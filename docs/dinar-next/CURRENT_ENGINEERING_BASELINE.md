# DINAR NEXT — خط الأساس الهندسي الحالي

**التاريخ:** 2026-10-30
**الفرع:** `claude/04-reconciliation` (فوق `qoder/13-wave03-card-envelope` `c6e4594`)
**القياس على:** `ea9d03b`، ثم إصلاحات Claude 04 الثلاثة في الـcommit التالي.

**البيئة:** حاوية معزولة، وNode 22.22.0، وPostgreSQL محلي على loopback (55432 و55479). كل suite تعمل على قاعدة جديدة تُنشأ وتُحذف (`test/isolation/local-suite.sh`)، مع `env -i` وnet-guard. **صفر محاولات اتصال خارجي في كل التشغيلات.** لا مفاتيح ذكاء ولا دفع حقيقي، و`BDINAR_BLOCK_MODEL_CALLS=1`.

## الخلاصة

| | العدد |
|---|---|
| suites في `artifacts/api-server/test` | 99 |
| شُغّلت في التشغيل الكامل (المحاولة الأولى مسجّلة) | 96 |
| شُغّلت منفصلة لأنها تحتاج إعدادًا خاصًا | 3: `personal-intelligence` و`storage-portability` و`storage-s3-wire` |
| نجحت من المحاولة الأولى | 90 من 96 |
| فشلت أولًا ثم أُصلحت أو أُعيد تشغيلها بإعدادها الصحيح | 5 |
| **ما زالت حمراء** | **1:** `phase1-acceptance`، وتصنيفها أدناه |
| اختبارات فردية في التشغيل الكامل | 1141 ناجحة / 5 فاشلة (قبل الإصلاحات) |

إضافة إلى ذلك:
- typecheck وبناء الخادم والواجهة: ناجحة.
- `pnpm audit`: «No known vulnerabilities».
- إعادة توليد `lib/api-zod` و`lib/api-client-react` لا تُحدث فرقًا.

## الإخفاقات الستة وما حدث لكل منها

| Suite | السبب | التصنيف | النتيجة |
|---|---|---|---|
| `ai-provider` R3 | الاختبار يقرأ بنية Zod 3 الداخلية (`_def.typeName`)، والمستودع على Zod 4.6.7 | عيب في الاختبار، أثر ترقية Zod | نُقل إلى `_zod.def` في Zod 4 بالقواعد نفسها. **47/47** |
| `block-c-acceptance` C21 | فحص الخصوصية رأى `marketId` داخل غلاف البطاقة v1 (Qoder Wave 03) | الحقل مصمَّم: سوق المشاهد نفسه، لا معرّف شخص | يُتحقق أن قيمته هي سوق المشاهد ثم يُستثنى وحده. الأرقام والمعرّفات ما زالت تُفحص في النص كاملًا. **50/50** |
| `sc02-browser-journey` | عنوان «تويوتا برادو 2020 610627» نُقل داخل سؤال الممشى، فاعتبره فحص بيانات التواصل رقم هاتف ورفض السؤال | **عيب حقيقي**: عنوان فيه سنة وممشى يكسر الاستفسار | الإصلاح أدناه. **1/1** في المتصفح |
| `experience-upgrade` XP-02 | «كم لوح شمسي يحتاج بيت استهلاكه 600 كيلوواط ساعة شهريًا؟» بجانب نتيجة واحدة تحوّل إلى سؤال للبائع بدل الإجابة العامة | **عيب حقيقي** في مسار «سؤال عن صفة الإعلان» | الإصلاح أدناه. **22/22** |
| `pre-switch` | يحتاج `DINAR_SUITE_SEED=development` | إعداد تشغيل | مع البذرة الصحيحة: كل حقول `PRESWITCH_SUMMARY` صحيحة، وصفر استدعاء للنموذج |
| `phase1-acceptance` | بعد نحو 70 فحصًا ناجحًا: «RESUME confirmation status 320px: key control is outside the viewport»، والعنصر عند y=−2325 | **عيب واجهة مفتوح** (التفصيل أدناه) | ⬜ يُعالج في W06 |

### الإصلاح 1: عنوان الإعلان ليس بيانات تواصل

- **الملفات:** `src/lib/inquiries.ts`، `src/ai/inquiry-turn.ts`، `src/ai/action-foundation.ts`.
- **ما تغيّر:** `inquiryBodyProblem(body, quoted?)` تحذف عنوان الإعلان الذي يقتبسه الخادم من النص **قبل فحص بيانات التواصل فقط**. فحص الطول يبقى على الرسالة كاملة.
- **مواضع التطبيق الثلاثة:** المسودة، والتأكيد، والإرسال.
- **الأمان:**
  - المحذوف هو عنوان كتبه البائع نفسه، وهو منشور أصلًا.
  - يُستبدل بمسافة، فلا يمكن تجميع رقم بتقسيمه حول العنوان.
  - رقم يكتبه المشتري ما زال يُرفض.
- **الاختبار:** `sc02-listing-facts` SC02-4 (أحمر قبل الإصلاح، ثم 4/4).

### الإصلاح 2: سؤال عام بجانب نتيجة واحدة ليس سؤالًا للبائع

- **الملف:** `src/ai/listing-fact-question.ts`.
- **ما تغيّر:** المسار الأخير، حيث لا حقل مسجّل يفسّر السؤال، صار يتطلب أن يشير السؤال إلى الإعلان نفسه:
  - ترتيب («الأول»)،
  - أو إشارة («هذا»)،
  - أو كلمة مثل «الإعلان» و«الخدمة»،
  - أو ضمير («عليها» و«معه»).
- **ما لم يتغير:** الأسئلة عن صفة مسجّلة في سجل الفئة، والصفات المنسّقة (الممشى وساعات التشغيل والفحص).
- **الاختبارات:**
  - XP-02 (أحمر، ثم أخضر).
  - حالة عامة جديدة GEN-8 في فئة الخدمات في `spec-question-generality` (8/8).

### `phase1-acceptance`: عيب واجهة مفتوح

**كيف يُعاد إنتاجه:**
1. بعد إعادة التحميل، يطلب الاختبار إظهار حالة التأكيد (`scrollIntoViewIfNeeded`).
2. ثم يغيّر عرض الشاشة إلى 320.
3. `ResizeObserver` في `artifacts/dinar/src/pages/Ai.tsx` يعيد المحادثة إلى الأسفل، لأن التمرير البرمجي لا يُعد تمرير مستخدم. الذي يُعد تمرير مستخدم: العجلة، واللمس، والمفاتيح، والتركيز.

**الأثر عند المستخدم:** من ينتقل إلى بطاقة قديمة عبر البحث في الصفحة أو رابط، ثم يتغير حجم النافذة (تدوير الهاتف أو ظهور لوحة المفاتيح)، يُعاد إلى الأسفل.

**القرار:** لا يُغيَّر الاختبار. الإصلاح في منطق المتابعة يحتاج اختبارات خاصة به، ويدخل في **W06** (تدقيق التجاوب).

**ملاحظة:** سجلات Claude 00/01 صنّفت هذه الـsuite «محجوبة بيئيًا» بسبب صور `images.unsplash.com` وتخزين الملفات. ذلك العائق زال بعد إصلاح S3. خطأا الكونسول `ERR_NAME_NOT_RESOLVED` المتبقيان هما تلك الصور الخارجية، ولا يفشلان الاختبار.

## التشغيلات المنفصلة

| Suite | الإعداد | النتيجة |
|---|---|---|
| `personal-intelligence` | قاعدة جديدة على 55479، و`DINAR_PERSONAL_TEST_DATABASE_URL`، و`env -i` وnet-guard | 1/1، خروج 0، صفر اتصال خارجي |
| `storage-portability` | سكربت الحزمة | 2/2 |
| `storage-s3-wire` | سكربت الحزمة | 7/7 |
| `pre-switch` | `DINAR_SUITE_SEED=development` | ناجحة |

**إعادة التشغيل بعد الإصلاحين:**

| Suite | النتيجة |
|---|---|
| `sc02-listing-facts` | 4/4 |
| `sc02-browser-journey` | 1/1 |
| `sc06-browser-journey` | 1/1 |
| `sc06-spec-questions` | 5/5 |
| `next-g2-inquiry` | 17/17 |
| `g2-smart-conversation` | 91/91 |
| `spec-question-generality` | 8/8 |
| `experience-upgrade-acceptance` (مع المتصفح) | 22/22 |
| `arabic-generality` | ناجحة |

## ما لم يُقس بعد

| البند | السبب | ما يلزم |
|---|---|---|
| ترحيلات PostgreSQL 18 (`test:release-migration`) | لا PG18 في البيئة | 👤 صورة أو شبكة |
| إبطال PAT القديم | لا دليل | 👤 لا تُغلق البوابة B4 دونه |
| الاستدعاءات الحقيقية للنموذج | ممنوعة دون تفويض المالك وسقف إنفاق | 👤 (W05) |

## الملحق: التشغيل الكامل (المحاولة الأولى، قبل الإصلاحات)

الأعمدة:
- **خروج:** 0 تعني نجاح.
- **ث:** المدة بالثواني.
- **خارجي:** محاولات الاتصال خارج loopback.
- **ناجح / فاشل:** عدد الاختبارات الفردية.

| Suite | خروج | ث | خارجي | ناجح / فاشل |
|---|---|---|---|---|
| `admin-bootstrap` | 0 | 9 | 0 | 5 / 0 |
| `ai-authority-boundary` | 0 | 3 | 0 | 4 / 0 |
| `ai-provider` | 1 | 6 | 0 | 46 / 1 |
| `ai-transport` | 0 | 7 | 0 | 8 / 0 |
| `api` | 0 | 13 | 0 | 63 / 0 |
| `arabic-generality` | 0 | 9 | 0 | 1 / 0 |
| `arabic-search-understanding` | 0 | 7 | 0 | 5 / 0 |
| `block-a-acceptance` | 0 | 56 | 0 | 1 / 0 |
| `block-c-acceptance` | 1 | 96 | 0 | 49 / 1 |
| `block-d-acceptance` | 0 | 53 | 0 | 28 / 0 |
| `block-e-acceptance` | 0 | 43 | 0 | 46 / 0 |
| `block-f0-foundation` | 0 | 8 | 0 | 12 / 0 |
| `block-f1-seller` | 0 | 11 | 0 | 14 / 0 |
| `block-f2-buyer` | 0 | 11 | 0 | 14 / 0 |
| `block-f3-commerce` | 0 | 20 | 0 | 17 / 0 |
| `block-f4-driver` | 0 | 87 | 0 | 48 / 0 |
| `block-f5-unified` | 0 | 87 | 0 | 29 / 0 |
| `closure-ai-cost` | 0 | 17 | 0 | 19 / 0 |
| `closure-integrations` | 0 | 17 | 0 | 9 / 0 |
| `closure-notifications` | 0 | 6 | 0 | 7 / 0 |
| `closure-privacy` | 0 | 19 | 0 | 11 / 0 |
| `command-a-acceptance` | 0 | 27 | 0 | 22 / 0 |
| `command-a-probe` | 0 | 17 | 0 | 1 / 0 |
| `command-b-acceptance` | 0 | 21 | 0 | 9 / 0 |
| `command-c-acceptance` | 0 | 20 | 0 | 11 / 0 |
| `command-d-acceptance` | 0 | 17 | 0 | 6 / 0 |
| `command-e-ui` | 0 | 158 | 0 | 2 / 0 |
| `command-f-journeys` | 0 | 44 | 0 | 3 / 0 |
| `commerce-journey` | 0 | 7 | 0 | 8 / 0 |
| `commerce` | 0 | 4 | 0 | 23 / 0 |
| `contact-browser-microclosure` | 0 | 21 | 0 | 1 / 0 |
| `conversation-marketplace-isolation` | 0 | 4 | 0 | 5 / 0 |
| `conversation-router` | 0 | 6 | 0 | 13 / 0 |
| `conversation` | 0 | 5 | 0 | 29 / 0 |
| `database-url-selection` | 0 | 5 | 0 | 5 / 0 |
| `deepseek-chat-compatibility` | 0 | 25 | 0 | 15 / 0 |
| `development-tls` | 0 | 4 | 0 | 7 / 0 |
| `employment` | 0 | 5 | 0 | 12 / 0 |
| `experience-upgrade-acceptance` | 1 | 145 | 0 | 21 / 1 |
| `financial-state-machine` | 0 | 9 | 0 | 23 / 0 |
| `fresh-environment` | 0 | 6 | 0 | 9 / 0 |
| `g-final` | 0 | 21 | 0 | 22 / 0 |
| `g1-provider` | 0 | 64 | 0 | 39 / 0 |
| `g2-smart-conversation` | 0 | 43 | 0 | 91 / 0 |
| `g3-ui` | 0 | 116 | 0 | 6 / 0 |
| `gemini-gateway` | 0 | 4 | 0 | 3 / 0 |
| `listing-edit-snapshot` | 0 | 7 | 0 | 2 / 0 |
| `listing-image-policy-review` | 0 | 7 | 0 | 11 / 0 |
| `listing-image-publication-acceptance` | 0 | 9 | 0 | 1 / 0 |
| `listing-photo-vision-provider` | 0 | 5 | 0 | 5 / 0 |
| `listing-pricing-invariants` | 0 | 5 | 0 | 5 / 0 |
| `live-model-benchmark` | 0 | 6 | 0 | 26 / 0 |
| `location-policy` | 0 | 5 | 0 | 1 / 0 |
| `market-capability-registry` | 0 | 4 | 0 |  |
| `marketplace-category-compatibility` | 0 | 5 | 0 | 3 / 0 |
| `marketplace-intelligence` | 0 | 8 | 0 | 22 / 0 |
| `monitoring` | 0 | 6 | 0 | 5 / 0 |
| `next-g1-usage` | 0 | 27 | 0 | 21 / 0 |
| `next-g2-inquiry` | 0 | 22 | 0 | 17 / 0 |
| `next-g3-acceptance` | 0 | 44 | 0 | 14 / 0 |
| `nl-commerce-followup-probes` | 0 | 7 | 0 | 1 / 0 |
| `nl-commerce-microclosure` | 0 | 7 | 0 | 1 / 0 |
| `payment-order-state` | 0 | 6 | 0 | 3 / 0 |
| `phase1-acceptance` | 1 | 116 | 0 | 0 / 1 |
| `phase2-commission-acceptance` | 0 | 21 | 0 | 1 / 0 |
| `phone-verification-development-bypass` | 0 | 7 | 0 | 1 / 0 |
| `pre-switch` | 1 | 7 | 0 |  |
| `pro-subscription-honesty` | 0 | 8 | 0 | 2 / 0 |
| `promotion-intent` | 0 | 4 | 0 | 5 / 0 |
| `promotions` | 0 | 4 | 0 | 6 / 0 |
| `r5-delivery-economics` | 0 | 4 | 0 | 3 / 0 |
| `readiness` | 0 | 4 | 0 | 15 / 0 |
| `request-collection-bounds` | 0 | 6 | 0 | 6 / 0 |
| `same-origin-web` | 0 | 6 | 0 | 8 / 0 |
| `sc-conversation-routing` | 0 | 9 | 0 | 5 / 0 |
| `sc-scenarios-probe` | 0 | 21 | 0 | 1 / 0 |
| `sc01-browser-journey` | 0 | 60 | 0 | 1 / 0 |
| `sc02-browser-journey` | 1 | 23 | 0 | 0 / 1 |
| `sc02-listing-facts` | 0 | 18 | 0 | 3 / 0 |
| `sc03-browser-journey` | 0 | 51 | 0 | 1 / 0 |
| `sc06-browser-journey` | 0 | 20 | 0 | 1 / 0 |
| `sc06-spec-questions` | 0 | 18 | 0 | 5 / 0 |
| `sc07-browser-journey` | 0 | 33 | 0 | 1 / 0 |
| `sc10-browser-journey` | 0 | 49 | 0 | 1 / 0 |
| `security-acceptance` | 0 | 42 | 0 | 12 / 0 |
| `spec-question-generality` | 0 | 20 | 0 | 7 / 0 |
| `stock-spec-conversation` | 0 | 19 | 0 | 6 / 0 |
| `t3-stock-questions` | 0 | 20 | 0 | 11 / 0 |
| `universal-control-acceptance` | 0 | 90 | 0 | 10 / 0 |
| `universal-negotiation-acceptance` | 0 | 43 | 0 | 38 / 0 |
| `wave02-card-reliability` | 0 | 19 | 0 | 9 / 0 |
| `wave03-card-envelope-browser-journey` | 0 | 44 | 0 | 1 / 0 |
| `wave03-card-envelope` | 0 | 18 | 0 | 9 / 0 |
| `wave3-acceptance` | 0 | 31 | 0 | 11 / 0 |
| `wave4-payment-acceptance` | 0 | 8 | 0 | 1 / 0 |
| `xp-probe` | 0 | 6 | 0 |  |
