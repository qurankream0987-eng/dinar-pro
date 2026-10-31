# مصفوفة مخاطر الدمج بين Qoder وClaude

**الفرع Qoder:** `qoder/parallel-w07-w12-ultra` عند `6b702ae`
**الأساس المشترك:** `b80c27b`
**الاستخدام:** قبل `cherry-pick`، وبعد كل التزام، وفي المراجعة النهائية.
**قاعدة عامة:** كل تعارض في Drizzle يُحل **بالجمع الإضافي** (احتفظ بالكتلتين)، ثم تُعاد بوابات الترحيل والهاش. لا يُحذف جانب موجة لحل تعارض.

**تحديث W12.1 (2026-10-31) — مراجع مقروءة فعليًا من `origin`:**

| الفرع | SHA | نقطة التفرع | الترحيل الأخير |
|---|---|---|---|
| `qoder/parallel-w07-w12-ultra` | `6b702ae` | `b80c27b` | `0044_wave10_trust_support_whatsapp` |
| `claude/11-c1-sql-search` | `d94477b` | `b80c27b` | `0041_c1_sql_search` |
| `qoder/14-w02u3-canonical-reliability` | `5a192d8` (تحقق 2026-11-01؛ `e869a1e` سلف) | `b80c27b` | `0040_refund_obligations` (بلا ترحيل جديد) |
| `main` | `b1b20e5` | — | لم يُلمس |

---

## 0. تعارض تسلسل الترحيل 0041 — مؤكد، لا يُحل بإعادة الترقيم

| البند | القيمة |
|---|---|
| ملف Qoder | `lib/db/drizzle/0041_wave07_financial_journal.sql` (W07) |
| ملف Claude C1 | `lib/db/drizzle/0041_c1_sql_search.sql` (`CREATE EXTENSION pg_trgm`، `offer_search_documents`، عمودان على `offers`، فهارس، trigger إصدار) |
| مدخلات `_journal.json` | Qoder 45، Claude C1 42، الأساس 41 |
| الحالة | **تعارض رقم/موضع** إن جُمع الفرعان كما هما؛ لا يمكن أن يحملا الرقم 0041 معًا |

**القاعدة الملزمة:** لا يُعاد ترقيم ترحيل Qoder، ولا يُعاد كتابة ترحيل Claude، ولا يُعدّل SQL بعد تطبيقه. عند الدمج:

1. يُقرر Claude أي السلسلتين تُطبَّق أولًا على قاعدة الإنتاج.
2. إن سبق تطبيق سلسلة في بيئة ما، يُنشأ ترحيل **جديد** بالرقم التالي المتاح يحمل الموجة المتأخرة، ويبقى الملفان الأصليان في تاريخهما.
3. إن لم يكن أي منهما مطبّقًا بعد، فالأفضل: `0041` لـClaude و`0042…0045` لموجات Qoder الأربع، مع تحديث `release-manifest.json` و`clone-migration-guard.ts` و`EXPECTED_JOURNAL_ENTRIES` (45) و`readiness.test` و`development-tls.test` في التزام واحد.
4. في كل الحالات: `sha256sum` لكل ملف، مقارنة بالمانيفست والحارس، مسح تدميري، `drizzle-kit migrate` على قاعدة disposable، ثم `readiness` و`development-tls`.

**علاقة `qoder/14`:** لا ترحيل جديد فيها (تنتهي عند `0040`؛ 49 التزامًا بعد الأساس عند `5a192d8`)، فلا تعارض رقم مع موجات Qoder. تعارضها الملفي فقط، مقيسًا بـ`comm` على قائمتي تغييرات الفرعين: `marketplace.ts`، `safe-development-database.ts`، `.github/workflows/qoder-api-suite.yml`، `artifacts/api-server/package.json`، `artifacts/api-server/test/commerce-journey.test.ts`.

---

## 1. مصفوفة الملفات

| # | الملف | احتمال التعارض | الأثر | الإشارة | العلاج |
|---|---|---|---|---|---|
| R1 | `lib/db/src/schema/index.ts` | **مرتفع جدًا** | مرتفع | +719 سطرًا؛ Claude قد يعدّل نفس الملف لبطاقات/سياسات | جمع الكتل؛ لا حذف؛ `pnpm run typecheck`؛ إعادة توليد إن لزم |
| R2 | `artifacts/api-server/src/routes/index.ts` | مرتفع | متوسط | تركيب `cash`/`compliance`/`trustOps` | أبقِ كل `router.use`؛ رتّب حسب الاعتماد لا حسب الأصل |
| R3 | `artifacts/api-server/src/routes/trust-safety.ts` | مرتفع | مرتفع | W09/W10 وسّعا البلاغات والسياسات | ادمج الحقول والأنواع الخمسة؛ أعد اختبار `reports` و`policies` |
| R4 | `artifacts/api-server/src/routes/marketplace.ts` | متوسط | مرتفع | لقطة العمولة + بوابتا الشراء | لا تحذف استدعاءات `assertMinorProtection`/`requireCommercialCapability` |
| R5 | `artifacts/api-server/src/lib/markets.ts` | متوسط | مرتفع | فك اقتراب التفعيل بالسعر + بوابات | أبقِ `isMarketAvailable` بلا شرط سعر |
| R6 | `artifacts/api-server/src/lib/auth.ts` | متوسط | متوسط | كتابة أحداث الرضا عند التسجيل | أبقِ الكتابة بعد نجاح التسجيل؛ لا تكتب قبل المعاملة |
| R7 | `artifacts/api-server/src/lib/privacy-rights.ts` | متوسط | متوسط | إضافة `policyConsentEvents` للتصدير | أضف إلى التصدير والملخص معًا |
| R8 | `artifacts/api-server/src/lib/notifications.ts` | متوسط | منخفض | قالب `SUPPORT_CASE_UPDATED` | لا تحذف المفتاح؛ أي قائمة بيضاء تحتاجه |
| R9 | `artifacts/api-server/src/lib/response-targets.ts` | منخفض | منخفض | `DINAR_SUPPORT_RESPONSE_HOURS` | أبقِ الحد 1–720 |
| R10 | `artifacts/api-server/package.json` | متوسط | منخفض | أربعة سكربتات `test:w07…w10` | حافظ على الأسماء والبصمات |
| R11 | `artifacts/api-server/test/safe-development-database.ts` | متوسط | **مرتفع** | فجوة نوع أُصلحت | أي حل يجب أن يبقي W09/W10 في `operationMessages` |
| R12 | `artifacts/api-server/test/readiness.test.ts` | متوسط | متوسط | توقّع 45 مدخلًا | حدّث العدد بعد أي ترحيل جديد |
| R13 | `artifacts/api-server/test/development-tls.test.ts` | متوسط | متوسط | توقّع 45 + tag 0044 | نفس القاعدة |
| R14 | `lib/db/drizzle/meta/_journal.json` | منخفض | **مرتفع** | إضافة 4 مدخلات | لا تُعدّل `when`/`idx` بعد الدمج؛ أضف بعد آخر tag فقط |
| R15 | `lib/db/drizzle/release-manifest.json` | منخفض | **مرتفع** | 4 هاشات | أي تعديل SQL يعيد حساب الهاش |
| R16 | `lib/db/src/clone-migration-guard.ts` | منخفض | **مرتفع** | 4 سجلات + تعليقات | طابق الترتيب والهاش تمامًا |
| R17 | `artifacts/api-server/src/lib/moderation.ts` | منخفض | منخفض | اتحاد `MESSAGE/AI_ANSWER` | لا تُعِد للاتحاد القديم |

---

## 2. مخاطر دلالية (لا تظهر كتعارض Git)

| # | الخطر | لماذا | الكشف | العلاج |
|---|---|---|---|---|
| S1 | تغيير Claude لنصوص `lib/policies.ts` بعد W09 | هاش المحتوى واختبارات التسجيل تعتمد الصياغة | `test:w09` «هاش وحالة قبل التسجيل» | أعد تسجيل النسخة في السجل إن تغيّرت الصياغة؛ لا تُعدّل الهاش يدويًا |
| S2 | ترحيل من Claude برقم/ترتيب يسبق 0041 | ترتيب الترحيلات إلزامي | `_journal.json` والـtags | أعد ترقيم ترحيلات Claude أو Qoder قبل الدمج؛ لا تعيد ترتيب SQL بعد تطبيقه |
| S3 | تغيير Claude لقالب إشعار أو قائمة قوالب | إشعار الدعم قد يُسقط بصمت | `closure-notifications` | أضف المفتاح في القائمة البيضاء وأعد الاختبار |
| S4 | تعديل Claude لـ`AiChat.css` مع عيب 320px | إصلاح UI قد يغيّر سلوك التمرير | `phase1-acceptance` | لا علاقة لـQoder؛ أعد الاختبار بعد إصلاح Claude |
| S5 | إضافة Claude حقولًا لـ`orders.data` | لقطات W07/W08 تعتمد شكل `data` | `test:w07`/`test:w08` | أضف الحقول بلا إعادة كتابة القديمة؛ اللقطة تبقى سلطة |
| S6 | تغيير Claude لـOpenAPI/`lib/api-zod` | عملاء مولّدون قد لا يعرفون المسارات الجديدة | `codegen` في CI | قرّر: أضف المسارات للمواصفة أو أبقها يدوية؛ لا تكسر التوليد |
| S7 | ترقية Node/pnpm في Claude | سكربتات الاختبار تفترض Node 24 | `typecheck` | ثبّت الإصدارات في CI |
| S8 | تشغيل مجموعات Qoder على قاعدة مشتركة | تلوث بين المجموعات | `LOCAL_SUITE` يطلب قاعدة عشوائية | لا تشغّل يدويًا على قاعدة مشتركة |
| S9 | ازدواج بوابة الرضا: Claude C1 وqoder/14 يضيفان `lib/policy-gate.ts` (`assertPoliciesAccepted`) داخل `marketplace.ts`، وW09 يملك سجل `policy_consent_events` في `lib/compliance.ts` | بوابتان تقرآن مصدرين مختلفين؛ قد يمرّ طلب أحدهما ويرفضه الآخر | وجود `policy-gate.ts` بعد الدمج + `test:w09` «قرار صريح» | اجعل `assertPoliciesAccepted` تقرأ سجل W09 إن وُجد؛ لا تستبدل `lib/compliance.ts` ولا تحذف زرع التسجيل |
| S10 | Claude C1 يغيّر `offerRows` إلى `offerRowsByIds` في `marketplace-listings.ts` ويعدّل `GET /listings/:id` | تعارض مباشر في كتلة الـimports والمسار داخل `marketplace.ts` | تعارض Git + `marketplace-intelligence.test` | اجمع الاستيرادين؛ أبقِ `offerRowsByIds` وأضف استيراد W07 (`recordOrderFinancialEvent`) كاملًا |
| S11 | عكس ترتيب الأقفال بين `openCashRefundCase` (قفل الطلب ثم صفوف الاسترداد) و`confirmCashRefundReceipt` (قفل صف الاسترداد ثم الطلب) | deadlock محتمل عند فتح/تأكيد استرداد متزامنين لنفس الطلب؛ النتيجة 500 لطرف واحد وإعادة محاولة، لا فساد بيانات | مراجعة كود؛ لا اختبار يعيد إنتاجه | عند الدمج: اقفل الطلب أولًا في مسار التأكيد (قراءة غير قافلة للمعرّف، ثم `lockOrder`، ثم إعادة القراءة `FOR UPDATE`)، وأعد `test:w08` و`test:w12c` |
| S12 | W12.1 يضيف مجموعة `wave07-w12-contract-hardening.test` ومفتاح `BDINAR_W12C_ACCEPTANCE` | تعارض سهل في `package.json` و`safe-development-database.ts` وسطر اختيار الـworkflow | تعارض Git صغير | اجمع الإضافات؛ لا تحذف أي مفتاح سابق من `approvalMessages`/`operationMessages` |
| S13 | `qoder/14` عند `5a192d8` يعدّل أيضًا `package.json` و`commerce-journey.test.ts` (توسيع اختبارات المتصفح) | تعارض نصي بسيط مع سكربت `test:w12c` ومفاتيح W12.1 | `comm` بين قائمتي تغييرات الفرعين | اجمع السكربتين والاختبارين؛ لا تُسقط سكربت `test:w02u3` ولا `test:w12c` |

---

## 3. ترتيب الكشف بعد كل `cherry-pick`

1. `pnpm install --frozen-lockfile`
2. `pnpm run typecheck` ← يوقف كل شيء إن فشل
3. `pnpm --filter @workspace/api-server run build`
4. `pnpm --filter @workspace/dinar run build`
5. `drizzle-kit migrate` على قاعدة disposable
6. `sha256sum` للترحيلات 0041–0044 ومقارنتها بالمانيفست والحارس
7. مسح تدميري (Perl/سكربت الإصدار)
8. `test:w0N` للموجة الملتقطة
9. مصفوفة الانحدار (W11 §6.3)
10. فحص أسرار (`qoder-security.yml`) عند توفر الفرع البعيد

---

## 4. خطة تراجع

- كل موجة التزام مستقل؛ `git revert <sha>` يلغي موجة بلا لمس غيرها.
- لا يُعاد استخدام tag ترحيل بعد تطبيقه على قاعدة؛ إن لزم تصحيح، أضف ترحيلًا جديدًا.
- إن فشل `typecheck` بعد الدمج، **لا** تُصلح بتعطيل النوع أو حذف الاختبار؛ أصلح النوع أو أعد الملف.
- إن فشل اختبار بسبب تغيير Claude المشروع، أصلح الاختبار فقط إذا كان الادعاء القديم لم يعد صحيحًا، وسجّل السبب في التقرير.

---

## 5. تقدير المخاطر الكلي

| البُعد | التقدير | السبب |
|---|---|---|
| تعارض نصي في Git | متوسط–مرتفع | `schema/index.ts` و`trust-safety.ts` |
| كسر نوع (typecheck) | متوسط | فجوة W09 أُصلحت لكن أي دمج خاطئ يعيدها |
| كسر ترحيل | منخفض مع البوابات | هاشات مثبتة وثلاث طبقات تحقق |
| كسر سلوك مالي | منخفض | آلة الطلب والدفع لم تُعدّل |
| كسر واجهة Claude | متوسط | عقود جديدة تحتاج عرضًا صادقًا |
| خطر إصدار | **مرتفع** | لا تشغيل ولا متصفح ولا قانوني |

**الخلاصة:** الدمج الهندسي قابل للإدارة ببوابات صارمة؛ **الاستعداد للإصدار غير مثبت**.
