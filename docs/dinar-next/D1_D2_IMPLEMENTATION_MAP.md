# D1 + D2 — خريطة التنفيذ

**الفرع:** `claude/12-d1-d2-business-foundation` · **الأساس:** `claude/11-c1-sql-search` عند `d94477bad836bf4fe7b3330884170625d1698270` · **SHA الكود النهائي:** انظر `D1_D2_CLAUDE_HANDOFF.md`.

## 0. المرجع الأصلي ومقارنته بالأمر

قُرئ التقرير الأصلي (`https://claude.ai/artifact/8jPaVmw1aQknpr51R7WsNF`، المراجعة 11) وقسماه D1 وD2. الفروق المقصودة:

| النقطة | التقرير الأصلي | ما نُفّذ | السبب |
|---|---|---|---|
| مستوى ذكاء ثالث | إضافة `BUSINESS` إلى `AiPlanTier` | **لم يُضف**. المستويات `FREE/BUSINESS_GO/BUSINESS_PRO` كما هي. سعة بزنس تُضبط من مزايا منتجه | الأمر: لا عدّاد استخدام ثانٍ. صفوف `aiUsage` المخزنة صارمة البنية، وإضافة مستوى تكسرها، ومعها عدّادات الاستخدام والإنفاق التاريخية |
| حالات النشاط | `DRAFT/SUBMITTED/IN_REVIEW/VERIFIED/REJECTED/EXPIRED` | `DRAFT → DOCUMENTS_REQUIRED → PENDING_REVIEW → VERIFIED / REJECTED`، و`VERIFIED ⇄ SUSPENDED` | دورة الحياة في الأمر. انتهاء السجل (`EXPIRED`) مؤجل، ومذكور في المخاطر |
| فحص المستندات | لم يُذكر | حجر إلزامي، وفاحص عبر واجهة محوّل | الأمر D2.3 |
| بطاقة دينار بزنس | بطاقة جديدة بـCard Envelope | نوع سطح `BUSINESS_PROFILE` تحت البطاقة الدلالية القائمة `DINAR_BUSINESS_CARD` | الأمر: إعادة استخدام Card Envelope v1 دون محرك بطاقات ثانٍ |
| أسعار 10/20/49 | بالسنت في `commercialProducts` | سعر مرجعي بالدولار في سياسة الخطط، والسعر الفعلي منتج كتالوج بعملة كل سوق | الأمر D1.4: لا افتراض أن الدولار يُحصَّل في كل سوق أو يُحوَّل تلقائيًا |

## 1. الفصل بين الطبقات الخمس (D1.3)

| الطبقة | المصدر الوحيد | الملف |
|---|---|---|
| الخطة العامة `DINAR_GO/DINAR_PRO/DINAR_BUSINESS` | `commercial_policies.policy.subscriptionPlans` (صفوف بإصدارات ومؤلفها) | `lib/subscription-plans.ts` |
| مستوى سعة الذكاء | `AI_TIER_ENTITLEMENTS` و`aiUsage`، بلا تغيير | `lib/ai-usage-policy.ts` |
| المزايا التجارية | `promotion_products.business_entitlements` تُلتقط في الاشتراك | `lib/business.ts` |
| توثيق النشاط | `business_profiles` وأحداثه | `lib/business-profiles.ts` |
| حالة الفوترة | `business_subscriptions` و`billing_webhook_events` | `lib/subscription-billing.ts`، بلا تغيير في الآلة |

الأسماء القديمة (`BUSINESS_GO`، `BUSINESS_PRO`، `AI_USAGE_BUSINESS_*`) باقية. الاشتراك المشترى قبل D1 (`plan_code_snapshot = NULL`) يحتفظ بلقطته، وتُستنتج خطته العامة للعرض فقط (`planCodeOfSubscription`).

## 2. ما أُعيد استخدامه

- **الفوترة:**
  - `subscriptionTransition` و`receiveBillingWebhook` (توقيع، منع تكرار بمعرّف الحدث، مطابقة المبلغ والعملة)؛
  - `registerSubscriptionBillingProvider` و`/business/subscription-checkout` و`planChangePreview`.
- **الاشتراك والكتالوج:**
  - `subscribeBusiness` (محاكاة `TEST_NO_TRANSFER` في التطوير فقط) و`cancelBusinessSubscription`؛
  - `businessEntitlements` و`aiPlanFor`، والكتالوج `commercialProducts` ومنتجات `DINAR_BUSINESS`.
- **السياسات والتدقيق:**
  - `getCommercialPolicy`، وإصدارات `commercial_policies` (سجل التاريخ والمؤلف)؛
  - `market_audit` لتدقيق تغييرات منتجات الكتالوج.
- **الذكاء:** `aiUsageSummary` و`usageCardView` و`plansCardView`، وأسعار النماذج `ai_model_prices` مع `callCostMicros`.
- **المحادثة:**
  - `executeCommerceTurn` و`turnFor` و`composePayload` و`refreshCommercePayload` (إعادة البناء من الخادم عند كل قراءة)؛
  - `buildCardEnvelope` و`DINAR_BUSINESS_CARD`.
- **الواجهة:** `CommercialSurface` و`ComposedSurfaceView` و`plansSurface` و`api()`.
- **التخزين:** التخزين الخاص للكائنات `ObjectStorageService`، وخادم S3 المحلي للاختبار، ونمط رفع صور الإعلانات بعنوان موقّّع ثم تأكيد مع `generation`.
- **المحادثة والقوائم:** ربط المزود `provider-connections.ts`، بلا تغيير (مفاتيح واردة فقط)، وإعلانات البائع القائمة لقائمة النشاط (لا مخزون مكرر).
- **عمل Qoder (W09/W10):** على فرع Qoder فقط، فلا اعتماد عليه في الكود. التفاصيل في `D1_D2_BUSINESS_VERIFICATION_SECURITY.md` §6.

## 3. الملفات المتغيرة

جديد:
- `artifacts/api-server/src/lib/subscription-plans.ts`: رموز الخطط، ومخطط السياسة، والإعدادات المقترحة، والتحقق من مزايا المنتج، وترتيب الترقية.
- `artifacts/api-server/src/lib/subscription-overview.ts`: مقارنة الخطط للحساب والسوق.
- `artifacts/api-server/src/lib/subscription-economics.ts`: تقدير تكلفة الذكاء لكل خطة.
- `artifacts/api-server/src/lib/business-profiles.ts`: سلطة النشاط والمستندات والمراجعة، وعقد التكامل الخارجي.
- `artifacts/api-server/src/routes/business-profiles.ts`.
- `artifacts/api-server/src/ai/business-intent.ts`: قراءة نية التسجيل بالعربية واللهجات.
- `lib/db/drizzle/0042_d1_d2_business_foundation.sql` ولقطتها.
- الاختبارات: `artifacts/api-server/test/d1-d2-business-foundation.test.ts` و`d1-d2-business-browser.test.ts` و`artifacts/dinar/test/d1-d2-business-browser.mjs`.
- الواجهة: `artifacts/dinar/src/features/ai/BusinessCardSurface.tsx` و`artifacts/dinar/src/features/business-document-upload.ts`.

معدّل:
- **الخادم (lib):**
  - `lib/business.ts`: `grantingSubscription` و`accessPlanFor` و`assertPlanEligibility`، ولقطة رمز الخطة والنشاط؛
  - `lib/commercial-policy.ts`: إضافة `subscriptionPlans`.
- **المسارات:**
  - `routes/commercial.ts`: `planCode` في المنتجات، والتحقق من المزايا، والتدقيق، و`PRICE_VERSION_REQUIRED`، و`GET /subscriptions/plans`؛
  - `routes/integrations.ts`: الأهلية في الدفع، و`planChange` في المعاينة، و`/admin/subscription-plans/economics`؛
  - `routes/index.ts`.
- **المحادثة (ai):**
  - `ai/commerce-turn.ts`: `executeBusinessOnboardingTurn` و`publicPlansTurn` وسطح `BUSINESS_PROFILE`؛
  - `ai/conversation-runtime.ts`: استدعاء التسجيل قبل التحكم بالمنتج والطلبات؛
  - `ai/product-control-turn.ts`: نص «لا يوجد ملف نشاط» أصبح يشير إلى البطاقة؛
  - `ai/usage-turn.ts`: الخطط العامة في بطاقة الباقات؛
  - `ai/usage-intent.ts`: «كم بقي من استخدامي».
- **الحزم المشتركة:**
  - `lib/api-zod/src/conversation-runtime.ts`: `BUSINESS_PROFILE` تحت `DINAR_BUSINESS_CARD`، وخارج `PROMOTION_CARD`؛
  - `lib/api-spec/openapi.yaml`، ثم إعادة توليد `lib/api-zod` و`lib/api-client-react`؛
  - `lib/db/src/schema/index.ts`.
- **تسجيل الترحيل:** `release-manifest.json` و`clone-migration-guard.ts` و`development-tls.test.ts` و`readiness.test.ts`.
- **الواجهة:** `features/ai/CommercialSurface.tsx` و`commercial-types.ts` و`surface/adapters.ts`.
- **الحزمة:** `artifacts/api-server/package.json` (`test:d1d2`).
- **الوثائق:** `docs/dinar-next/OWNER_DECISIONS_2026-10-30.md` (قسم 5 جديد مؤرخ).

## 4. الترحيل 0042 وتعارضاته

`0042_d1_d2_business_foundation` (sha256 في `release-manifest.json`) **إضافي فقط**:
- عمود `promotion_products.plan_code` مع CHECK وفهرس فريد جزئي «منتج مفعّل واحد لكل خطة وسوق»؛
- عمودا `business_subscriptions.plan_code_snapshot` و`business_profile_id` مع CHECK «بزنس ⇔ نشاط مرتبط»؛
- أربعة جداول: `business_profiles` و`business_memberships` و`business_verification_documents` و`business_verification_events`، والأخير append-only بمشغّل.

| السلسلة | 0041 | 0042 وما بعده |
|---|---|---|
| هذا الفرع (Claude C1 + D1/D2) | `0041_c1_sql_search` | `0042_d1_d2_business_foundation` |
| `qoder/parallel-w07-w12-ultra` (`e3122e8`) | `0041_wave07_financial_journal` | `0042_wave08_cash_engines`، `0043_wave09…`، `0044_wave10…` |
| `codex/11-c1-sql-search` (`f351f5d`) | `0041_search_foundation` | `0045_c1_numeric_compat` |

**الترحيل غير جاهز للدمج** حتى يُوحَّد التسلسل القانوني للترحيلات. محتواه لا يتعارض دلاليًا مع W07–W10: أسماء الجداول والأعمدة مختلفة، ولا يعدّل جدولًا أنشأه Qoder. لكن الرقم 0042 مستخدم في فرع Qoder. عند التوحيد يُعاد ترقيمه ويُعاد حساب sha256 وتحديث النقاط الأربع، ولم يُطبَّق على أي قاعدة دائمة. لم يُلمس أي فرع آخر.

## 5. نقاط النهاية

مالك النشاط (جلسة، سوق نشط؛ غيره ← 404):

| الطريقة | المسار |
|---|---|
| GET/POST | `/api/business/profiles` |
| GET/PATCH | `/api/business/profiles/:id` |
| POST | `/api/business/profiles/:id/start-verification` |
| POST | `/api/business/profiles/:id/documents/upload-url` |
| POST | `/api/business/profiles/:id/documents/:documentId/complete` |
| POST | `/api/business/profiles/:id/submit` |
| POST | `/api/business/profiles/:id/publication` |
| POST | `/api/business/profiles/:id/integration-requests` |

عام: `GET /api/businesses/:id`، للنشاط المنشور الموثّق فقط.

المراجع (ADMIN، وليس صاحب الطلب):

| الطريقة | المسار |
|---|---|
| GET | `/api/admin/business-verification?status=` |
| GET | `/api/admin/business-verification/:id` |
| POST | `/api/admin/business-verification/:id/decision`: `VERIFY` أو `REJECT` أو `REQUEST_DOCUMENTS` أو `SUSPEND` أو `REINSTATE` |
| GET | `/api/admin/business-verification/documents/:documentId/content` (`no-store`، المستند السليم فقط) |

الاشتراكات:
- `GET /api/subscriptions/plans`: جديد.
- `POST /api/business/subscription-review` و`/api/business/subscriptions` و`/api/business/subscription-checkout`: يقبل كل منها `businessId` اختياريًا (إلزامي لبزنس).
- `GET /api/business/plan-change-preview`: يحتوي الآن `planChange`.
- `GET /api/admin/subscription-plans/economics`: جديد.
- `POST /api/admin/markets/:marketId/commercial-products`: يقبل الآن `planCode`.

## 6. أمثلة المحادثة (من الاختبارات)

| المستخدم | دينار (ملخّص من النص الفعلي) | البطاقة |
|---|---|---|
| «دينار، أنا صاحب مطعم اسمه سمراء للمشاوي في الكويت، وأريد أضيفه إلى دينار.» | «جهّزت مسودة «سمراء للمشاوي» (مطعم ومشاوي) في سوق الكويت. المسودة غير موثّقة… ولا تحتاج اشتراكًا مدفوعًا. للتحقق أحتاج: الاسم القانوني… ورقم السجل التجاري…» | `BUSINESS_PROFILE`، DRAFT |
| «الاسم القانوني مؤسسة سمراء للمشاوي ورقم السجل 445566» | «حدّثت بيانات… كما كتبتها (غير موثّقة بعد).» | رقم السجل `••••5566` |
| «أبي أرفع السجل التجاري» | «ارفع السجل التجاري من زر «ارفع المستند»… يُحفظ بشكل خاص لمراجع دينار فقط… ولا يُرسل إلى نموذج الذكاء.» | DOCUMENTS_REQUIRED، زر رفع |
| «وين وصل طلبي؟» (بعد البطاقة) | «طلب توثيق «…» بانتظار مراجع دينار. لم يُوثَّق بعد. تنبيه: فحص المستندات غير موصول بعد…» | PENDING_REVIEW |
| «أبي أشترك في بزنس» | «دينار بزنس: 49 دولار شهريًا (سعر مرجعي مقترح)… تفعيل الاشتراك المدفوع غير متاح الآن لأن الفوترة غير موصولة؛ لم يُنشأ اشتراك ولم يُخصم شيء.» | `AI_PLANS` |
| «دينار، ما الفرق بين جو وبرو؟» | سطران لدينار جو ودينار برو بالسعر والوصف و«يكفي حساب دينار؛ لا يحتاج سجلًا تجاريًا.» | `AI_PLANS` |
| «كم بقي من استخدامي؟» | بطاقة الاستهلاك | `AI_USAGE` |

## 7. الرجوع (Rollback)

- **الكود:** إرجاع الفرع إلى `d94477b`، فلا شيء مدموج في main.
- **قاعدة البيانات:** الترحيل إضافي. للتراجع على قاعدة اختبار:
  1. `DROP TABLE business_verification_events, business_verification_documents, business_memberships CASCADE`؛
  2. `ALTER TABLE business_subscriptions DROP COLUMN business_profile_id, DROP COLUMN plan_code_snapshot`؛
  3. `DROP TABLE business_profiles`؛
  4. `ALTER TABLE promotion_products DROP COLUMN plan_code`؛
  5. حذف صف `0042` من `drizzle.__drizzle_migrations`.

  لم يُطبَّق على قاعدة دائمة.
- **تشغيليًا دون تراجع:**
  - بلا محوّل فوترة، لا تفعيل مدفوع أصلًا؛
  - بلا فاحص، لا توثيق؛
  - تعطيل منتج كتالوج (`PATCH enabled:false`) يوقف البيع الجديد دون مساس باللقطات.
