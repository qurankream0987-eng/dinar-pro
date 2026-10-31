# DINAR NEXT — W12: حزمة التسليم للتكامل (Qoder Integration Candidate)

**الفرع:** `qoder/parallel-w07-w12-ultra`
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873`
**SHA النهائي للشيفرة:** `939c64f` (W11) — يليه W07 `09e8941`، W08 `20ed66e`، W09 `9af5170`، W10 `9ae637c`
**حالة النشر:** **محلي فقط. لم يُدفع. لم يُدمج. لم يُنشر.**
**التاريخ:** 2026-10-31

> **تعريف صريح:** هذه حزمة **مرشّح تكامل**، وليست مرشّح إصدار إنتاجي مدمج. Claude سيراجع ويدمج ويعيد القبول النهائي. لا ادعاء جاهزية إصدار، ولا موافقة قانونية، ولا تفعيل سوق أو دفع.

---

## 1. مصدر الفرع وتاريخ الالتزامات

| # | الالتزام | الرسالة | الملفات | +/− |
|---|---|---|---|---|
| 0 | `b80c27b` | أساس Claude W04 | — | — |
| 1 | `09e8941` | W07: دفتر مالي بالإضافة فقط وعمولة مُصدَّرة | 19 | +1655/−23 |
| 2 | `20ed66e` | W08: إقرارات نقد مباشرة ومحرك استرداد نقدي منفصل | 16 | +2238/−8 |
| 3 | `9af5170` | W09: دورة حياة السياسات والرضا الصريح وبوابات الامتثال | 21 | +3560/−43 |
| 4 | `9ae637c` | W10: البلاغات والفرز البشري وإشارات الاحتيال والدعم وجاهزية واتساب | 20 | +2595/−14 |
| 5 | `939c64f` | W11: قبول الفرع المستقل | 2 | +233/−2 |
| 6 | `46489fe` | W12: حزمة التكامل والعقود والمخاطر | 5 | — |
| 7 | `1a5ed7e` | تصحيح عدد الملفات في W12 | 1 | — |
| 8 | `3c80fc1` | تقوية CI: تثبيت Actions، رمز للقراءة فقط، قوائم سماح مغلقة | 1 | +107/−15 |

**المجموع منذ الأساس:** 53 ملفًا، **+11,455/−83** (الحالة النهائية قبل النشر).

**حالة Git:** لا upstream، ولا فرع بعيد، ولا merge commit، وشجرة العمل نظيفة عند القبول.

---

## 2. خريطة معمار المصدر

```
lib/db/
  drizzle/0041…0044            ← أربعة ترحيلات إضافية
  drizzle/meta/_journal.json   ← 45 مدخلًا
  drizzle/release-manifest.json
  src/clone-migration-guard.ts ← هاشات 17 ترحيلًا معلّقًا
  src/schema/index.ts          ← 18 جدولًا جديدًا + توسيع قيد بلاغات

artifacts/api-server/src/
  lib/order-journal.ts         ← الكاتب الوحيد للقيود المالية
  lib/commission-policy.ts     ← حل السياسة واللقطة
  lib/order-terminal-accounting.ts
  lib/payments/cash.ts         ← آلة النقد (تطوير فقط)
  lib/payments/obligations.ts  ← التزامات الاسترداد (قائم)
  lib/payments/service.ts      ← webhook/refund/reconcile (قائم)
  lib/policy-lifecycle.ts      ← سجل إصدارات السياسات
  lib/compliance.ts            ← الرضا، الكيان، التوثيق، القاصر
  lib/admin-authority.ts       ← assertAdminActor
  lib/fraud-signals.ts
  lib/support-cases.ts
  lib/whatsapp-readiness.ts
  routes/marketplace.ts        ← checkout + البوابات + لقطة العمولة
  routes/cash.ts
  routes/compliance.ts
  routes/trust-safety.ts       ← بلاغات + سياسات + استئنافات (موسّع)
  routes/trust-ops.ts
  routes/index.ts
```

**غير مملوك لـQoder ولم يُلمس:** `src/ai/**`، `artifacts/dinar/src/pages/Ai.tsx`، `AiChat.css`، محددات البطاقات، عقد Card Envelope.

---

## 3. التغييرات لكل موجة

| الموجة | ما أُضيف | ما عُدّل |
|---|---|---|
| W07 | `commission_policies`، `order_financial_events`، `order-journal.ts`، `commission-policy.ts` | `markets.ts` (فك اقتراب السعر)، `marketplace.ts` (لقطة + قيود)، `order-terminal-accounting.ts`، `order-expiry.ts`، `payments/service.ts` |
| W08 | `cash_payment_claims`، `cash_refund_cases`، `payments/cash.ts`، `routes/cash.ts` | `market-capability-registry.ts`، `order-terminal-accounting.ts`، `routes/index.ts` |
| W09 | 6 جداول امتثال، `policy-lifecycle.ts`، `compliance.ts`، `routes/compliance.ts` | `auth.ts`، `markets.ts`، `marketplace.ts`، `privacy-rights.ts`، `trust-safety.ts` |
| W10 | 8 جداول ثقة/دعم/واتساب، `fraud-signals.ts`، `support-cases.ts`، `whatsapp-readiness.ts`، `routes/trust-ops.ts` | `trust-safety.ts`، `moderation.ts`، `notifications.ts`، `response-targets.ts` |
| W11 | لا شيفرة | تقرير قبول + تصحيح عدّاد W09 |

---

## 4. عقود الدفتر المالي

**السلطة:** `order_financial_events` إلحاقية، والكاتب الوحيد `recordOrderFinancialEvent` (`lib/order-journal.ts`).

| العقد | القيمة |
|---|---|
| أنواع القيود | `ORDER_CREATED`, `PAYMENT_CAPTURED`, `PAYMENT_REFUNDED`, `ORDER_COMPLETED`, `ORDER_CANCELLED`, `COMMISSION_ACCRUED`, `COMMISSION_REVERSED`, `SELLER_PAYABLE_DUE`, `REFUND_OBLIGATION_OPENED`, `REFUND_OBLIGATION_RESOLVED` |
| الوحدات | أعداد صحيحة بالوحدة الصغرى فقط، بلا عائم |
| التكرار | فريد `(order_id, idempotency_key)`؛ نفس الحقائق تعيد القيد الأصلي، وحقائق مختلفة تُرفض |
| العكس | `reverses_event_id` يشير إلى قيد في الطلب نفسه |
| القاعدة | UPDATE/DELETE/TRUNCATE مرفوضة بـtrigger؛ عملة القيد = عملة الطلب |
| العمولة الصافية | `netCommissionDueMinor = المرحّل − المعكوس`؛ لا يُعدَّل صف `sellerDues` |

**العمولة:** `PLATFORM_FEE_BASIS_POINTS = 1_000` (10%) هي السياسة المنشورة `cmp_platform_commission_v1`، وليست ثابتًا خفيًا. أي تغيير يتطلب إصدار سياسة جديد؛ الطلبات القديمة تحتفظ بلقطتها.

---

## 5. عقود طرق الدفع

| الطريقة | الحالة | العقد |
|---|---|---|
| `CASH_DIRECT` | **تطوير فقط** | يبدأ بادعاء المشتري `CLAIMED`، ولا يصبح دفعًا إلا بإقرار البائع `CONFIRMED` (`CASH_DIRECT_SELLER_CONFIRMATION`). خارج `NODE_ENV=development` المسارات 404. |
| الإلكتروني | **غير متصل** | `PaymentProviderAdapter` قائم، ومحول `SIMULATION_ONLY` فقط. `electronic.available = false`, `providerConnected = false`. |
| المنصة تحتفظ بالمال / escrow | **غير موجود** | لا محفظة ولا رصيد مشترٍ ولا ضمان. |

**حقول الطلب المشتركة بعد إقرار النقد:** `orders.data.paymentMode = "CASH_DIRECT"`، `selectedPaymentMethod = "CASH_DIRECT"`، `cashPayment: { claimId, amountMinor, currencyCode, confirmedAt, verification: "SELLER_ATTESTED" }`. أي واجهة تعرض هذا يجب أن تقول «إقرار بائع»، لا «دفعة مؤكدة من المنصة».

---

## 6. عقود الاسترداد النقدي والبطاقة

| المسار | الحالة | الدليل |
|---|---|---|
| بطاقة/إلكتروني | قائم، `SIMULATION_ONLY` | `paymentRefunds` + `paymentRefundObligations`؛ `REFUND_SUCCEEDED/FAILED` |
| نقدي | قائم، تطوير فقط | `cash_refund_cases`: `OPEN → REPAYMENT_CLAIMED → CONFIRMED/DISPUTED` أو `WITHDRAWN` |
| إثبات الاسترداد النقدي | **المشتري وحده** | ادعاء البائع لا يُقيَّد؛ `PAYMENT_REFUNDED` يُكتب عند تأكيد المشتري فقط |
| السقف | تراكمي | `OPEN + REPAYMENT_CLAIMED + CONFIRMED + DISPUTED ≤` الدفعة النقدية المؤكدة، مفروض في القاعدة |
| أثر العمولة | تلقائي | `COMMISSION_REVERSED` تراكمي عند الاسترداد، ومربوط بقيد الاستحقاق |

---

## 7. عقود التسليم والنزاع

- آلة الطلب القائمة لم تُعدّل: `CREATED → ACCEPTED → SELLER_MARKED_DELIVERED → COMPLETED/DISPUTED`، والإلغاء من `CREATED` فقط.
- `applyTerminalOrderAccounting` تبقى نقطة الإغلاق الوحيدة (مخزون، تسليم، استحقاق).
- النزاعات تبقى `disputes` + قرار إداري؛ لا قرار آلي.
- النزاع النقدي (`DISPUTED`) يبقى محتجزًا ولا يحرر السقف إلا بسحب `OPEN` أو حسم بشري.

---

## 8. واجهات السياسات والرضا

| المسار | الجمهور | العقد |
|---|---|---|
| `GET /api/policies`، `GET /api/policies/:key` | عام | `contentSha256` + `lifecycle` (قد تكون `NOT_REGISTERED`) |
| `GET /api/account/policy-consents` | مستخدم | `required[]`, `optional[]`, `pendingRequired[]`, `materialUpdates[]`, `consentEvidence: "EXPLICIT_USER_ACTION_ONLY"` |
| `POST /api/account/policy-decisions` | مستخدم | `key`, `version`, `decision`, `idempotencyKey`، و`source` من `{POLICY_REVIEW, API}` فقط |
| `GET/POST /api/admin/compliance/policies…` | إداري | سجل الإصدارات وانتقالات `DRAFT→LEGAL_REVIEW→APPROVED→PUBLISHED→SUPERSEDED` |
| `GET /api/markets/:id/compliance` | عام | ما هو مسجل فقط، مع `commercialActivation: "REQUIRES_OWNER_AUTHORIZATION"` |

**محظور في العقد:** أي مسار يقبل مصدرًا من نص محادثة، أو يعرض «تمت الموافقة» بلا استدعاء القرار، أو يجعل خيارًا اختياريًا محددًا مسبقًا.

---

## 9. قواعد تفعيل الأسواق

1. **السوق نشط** فقط بـ`isActive` وحالة `ACTIVE/LIMITED`. لا شرط سعر وحدة تاريخي.
2. **الأسعار محلية**: كل سوق بعملته ودقته؛ لا اشتقاق من KWD.
3. **الكيان القانوني** يبدأ `DISABLED` بلا صلاحيات؛ التفعيل يحتاج فاعلًا ووقتًا وصلاحية واحدة على الأقل.
4. **بوابة القدرات** (`requireCommercialCapability`) لا تعمل إلا إذا فعّل المالك `legalEntityRequired` لذلك السوق؛ وإلا `enforced: false` (ليس «معتمدًا»).
5. **قدرات المزود** تُعلن الحقيقة: `cashDirect.available` في التطوير فقط، و`electronic.available = false`.
6. **لا تفعيل تجاري لأي سوق** في هذه الحزمة، وكل قراءة إدارية تحمل `REQUIRES_OWNER_AUTHORIZATION`.

---

## 10. واجهات التحقق من البائع

| المسار | السلوك |
|---|---|
| `POST /api/account/seller-verification` | يبدأ `PENDING` + `UNASSESSED`، مراجع ≤5 |
| `GET /api/account/seller-verification` | حالة الطلب فقط |
| `GET /api/admin/compliance/seller-verification` | طابور إداري |
| `POST /api/admin/compliance/seller-verification/:id/decision` | إداري فقط، وليس البائع؛ `VERIFIED` يشترط `riskBasis`، و`REJECTED` يشترط سببًا |
| بوابة النشر | `SELLER_VERIFICATION_REQUIRED` فقط عند تفعيلها للسوق |

لا تحقق رسمي من وثائق؛ `evidenceRefs` مراجع نصية، والقرار بشري.

---

## 11. واجهات الإشراف والبلاغات

- `POST /api/reports`: `targetType ∈ {LISTING, USER, ORDER, MESSAGE, AI_ANSWER}`.
- بلاغ `AI_ANSWER` يحفظ المعرّفات + ملاحظة ≤500 فقط، ويرجع `retention: "IDS_AND_USER_NOTE_ONLY"`؛ لا نص إجابة في البلاغ أو التدقيق.
- `GET /api/admin/reports`: طابور بشري.
- `POST /api/admin/reports/:id/resolve`: إداري؛ `FLAG_AI_ANSWER` لإجابات AI فقط ويكتب تدقيقًا بلا تغيير حالة.
- الاستئنافات القائمة كما هي؛ لا عقوبة آلية.

---

## 12. واجهات الدعم

| المسار | الجمهور | العقد |
|---|---|---|
| `GET/POST /api/account/support/cases` | مستخدم | حد 20/يوم؛ أول رسالة؛ حالة `OPEN` |
| `GET /api/account/support/cases/:id` | المالك أو الفريق | غير المالك 404 موحد؛ الملاحظات الداخلية والأحداث محجوبة عن المستخدم |
| `POST /api/account/support/cases/:id/messages` | المالك | `409 CASE_CLOSED` على المغلقة؛ ينقل إلى `AWAITING_STAFF` |
| `GET /api/admin/support/cases` | إداري | طابور يستثني `CLOSED`، ويعلّم `stale` |
| `POST .../messages` | إداري | `internal: true` لا يغيّر الحالة؛ الرد العلني → `AWAITING_USER` + إشعار |
| `POST .../assign` | إداري | المسند يجب أن يكون `ADMIN` |
| `POST .../status` | إداري | انتقالات صريحة؛ `CLOSED` نهائية |

---

## 13. جاهزية واتساب

| العنصر | الحالة |
|---|---|
| مزوّد حقيقي | **غير موجود**. `DINAR_WHATSAPP_PROVIDER` لا يعرف إلا `simulation` |
| إرسال | **مستحيل بالتصميم**: لا محوّل، و`delivery_state='NOT_SENT'` قيد قاعدة، و`sent:false` دائمًا |
| الموافقة | سجل إلحاقي بمصدر `IN_APP` أو `SUPPORT` فقط؛ الغياب = `NO_DECISION` |
| القوالب | تبدأ `DRAFT`؛ الاعتماد البشري عبر `SUBMITTED → APPROVED`، وبوقت اعتماد |
| النيّات | سلّم `BLOCKED_*` حتى `READY_TO_SEND`؛ الحمولة ترفض الهاتف/البريد/الرمز/OTP/كلمة المرور/السر |
| المخرجات | `liveSendsEnabled: false` في كل قراءة إدارية |

هذا «جاهزية عقد»، لا «تكامل واتساب».

---

## 14. جرد ترحيلات قاعدة البيانات

| # | الملف | الجداول | Triggers | sha256 |
|---|---|---|---|---|
| 41 | `0041_wave07_financial_journal.sql` | 2 | 4 | `4403b20e…4347cf0` |
| 42 | `0042_wave08_cash_engines.sql` | 2 | 4 | `44e4a812…798a326d` |
| 43 | `0043_wave09_policy_consent_compliance.sql` | 6 | 12 | `29127432…86b12316` |
| 44 | `0044_wave10_trust_support_whatsapp.sql` | 8 | 16 | `edb8ca57…b3bb50e0` |

- `_journal.json` و`release-manifest.json`: **45 مدخلًا**.
- `EXPECTED_JOURNAL_ENTRIES = 28 + 17 = 45`.
- الفحص التدميري: **526 مقتطفًا، 0 تدميري**.
- التغيير الوحيد على جدول قائم: توسيع `marketplace_reports_target_type_valid` + تحديث بيانات `report_reason_codes` (لا صف بلاغ يُعاد كتابته).

---

## 15. جرد تغييرات الواجهات والمخطط

**مسارات جديدة:** `routes/cash.ts`، `routes/compliance.ts`، `routes/trust-ops.ts`.
**مسارات موسّعة:** `routes/trust-safety.ts` (5 أنواع بلاغ، وحقول سياسات)، `routes/marketplace.ts` (بوابات + لقطة سياسة)، `routes/index.ts` (تركيب).
**حقول استجابة مضافة:** `contentSha256`، `lifecycle`، `retention`، `enforcement`، `appliedSanction`، `nextStep`، `liveSends`، `sent`، `commercialActivation`، `consentEvidence`، `verification`.
**بيانات طلب مضافة:** `data.commissionPolicy`، `data.paymentMode`، `data.selectedPaymentMethod`، `data.cashPayment`.
**إشعار جديد:** `SUPPORT_CASE_UPDATED { caseId, status }`.
**متغيرات بيئة جديدة:** `DINAR_SUPPORT_STALE_HOURS`، `DINAR_SUPPORT_RESPONSE_HOURS`، `DINAR_WHATSAPP_PROVIDER`.

**لا تغيير** في OpenAPI المولّد (`lib/api-zod`) ولا في تبعيات الجذر أو `pnpm-lock.yaml`. العملاء المولّدون لا يعرفون المسارات الجديدة بعد؛ Claude يقرر إن كانت تُضاف إلى المواصفة.

---

## 16. نتائج المراجعة الأمنية (ثابتة)

| # | الفحص | النتيجة |
|---|---|---|
| S1 | ملكية Claude | ✅ صفر ملفات مملوكة لـClaude عُدّلت |
| S2 | أسرار في الفرق | ✅ لا مفاتيح؛ كلمات مرور الاختبار فقط (`*-password-000000001`) |
| S3 | RBAC | ✅ `assertAdminActor` و`requireAdmin` على كل `/admin/*` الجديدة، ومُختبرة (403) |
| S4 | عزل المستخدم | ✅ 404 موحد لحالات/رسائل/إجابات الآخرين |
| S5 | الإلحاقية | ✅ قيود قاعدة للدفتر، الرضا، الإشارات، رسائل/أحداث الدعم، النيّات |
| S6 | منع العقوبة الآلية | ✅ `automaticEnforcement: false`، `appliedSanction: null` |
| S7 | منع إرسال واتساب | ✅ `NOT_SENT` قيد قاعدة + لا مزوّد |
| S8 | حد الحقن/المدخلات | ✅ zod + حدود طول + رفض الحمولات الحساسة |
| S9 | فحص أسرار CI | ⛔ لم يُشغَّل (لا فرع بعيد) |
| S10 | `pnpm audit` | ⛔ لم يُشغَّل (لا اعتماديات مثبّتة) |

**فجوة أُصلحت:** نوع `operationMessages` في `test/safe-development-database.ts` كان ناقص W09 (يُفشل typecheck). أُضيف W09/W10. هذه أعلى مخاطرة تشغيلية عند أول CI.

---

## 17. أوامر الاختبار والأدلة

| الأمر | ما يغطيه | الحالة |
|---|---|---|
| `pnpm run typecheck` | كل الحزم | ⛔ BLOCKED |
| `pnpm --filter @workspace/api-server run build` | بناء الخادم | ⛔ BLOCKED |
| `pnpm --filter @workspace/dinar run build` | بناء الويب | ⛔ BLOCKED |
| `pnpm --filter @workspace/api-server test:w07` | 10 اختبارات | ⛔ BLOCKED |
| `… test:w08` | 12 اختبارًا | ⛔ BLOCKED |
| `… test:w09` | 19 اختبارًا | ⛔ BLOCKED |
| `… test:w10` | 24 اختبارًا | ⛔ BLOCKED |
| مصفوفة الانحدار (11 مجموعة) | §6 في W11 | ⛔ BLOCKED |

**الأدلة الموجودة فعلًا:** جرد ثابت، هاشات، مسح SQL، فحص نطاق، عدّ اختبارات. **غير موجود:** مخرجات تشغيل، لقطات متصفح، سجلات CI.

---

## 18. أدلة المتصفح الحقيقية

**لا توجد.** لم يُشغَّل Chromium، ولا خادم ويب، ولا قاعدة. لا لقطة 320/390، ولا رحلة شراء، ولا اختبار وصول. أي جدول في تقارير سابقة يذكر «متصفح» يخص فروعًا أخرى، وليس هذا الفرع.

---

## 19. المزودون الخارجيون الغائبون

| المزود | الحالة | ما يلزم |
|---|---|---|
| مزود دفع إلكتروني | غير متصل، محول `SIMULATION_ONLY` | عقد، مفاتيح، webhooks، ترخيص |
| WhatsApp Business | غير متصل | حساب أعمال، قوالب معتمدة، webhook، موافقة |
| S3/تخزين | قائم كعقد، غير مُختبر هنا | بيانات اعتماد بيئة |
| بريد/SMS للإشعارات | محاكاة عند الانقطاع | مزود حقيقي |
| Google/Apple play billing | غير مستخدم | لاحقًا مع الاشتراكات |

---

## 20. قرارات المالك المطلوبة

1. اعتماد أو تعديل نسبة العمولة 10% (`1,000 bps`) وسجل السياسة `cmp_platform_commission_v1`.
2. تثبيت معمار الدفع: B (مباشر + عمولة منفصلة) كتفضيل مؤقت أم نهائي.
3. تفعيل أي سوق تجاريًا: من، ومتى، وبأي قدرات.
4. إنشاء الكيان القانوني وتحديد صلاحياته لكل سوق.
5. اعتماد نصوص السياسات قانونيًا (حاليًا `PENDING_LEGAL_APPROVAL`).
6. تفعيل التحقق من البائع أو الحماية الأصغرية لكل سوق (كلها `false`).
7. اعتماد مدد الاستجابة والاحتفاظ (`DINAR_*_RESPONSE_HOURS`، `DINAR_SUPPORT_STALE_HOURS`).
8. الموافقة على نشر الفرع لتشغيل CI.
9. إبطال GitHub PAT القديم (إجراء مستقل لا يُثبته فحص المستودع).

---

## 21. عوائق المراجعة القانونية

- لا نص سياسة معتمد، ولا مرجع مراجعة قانونية مزروع.
- لا كيان قانوني، ولا ترخيص، ولا بلد تسجيل.
- لا تقييم ضريبي/فاتورة، ولا سياسة حماية بيانات معتمدة، ولا نقل عبر الحدود.
- لا تقييم حماية أطفال من محامٍ، ولا إفصاح AI معتمد.
- التفاصيل في `docs/dinar-next/QODER_LEGAL_OPERATIONAL_REVIEW_PREP.md` (بحث تحضيري، ليس رأيًا قانونيًا).

---

## 22. المشكلات المعروفة

| # | المشكلة | الأثر | المالك |
|---|---|---|---|
| K1 | لا تشغيل لأي اختبار على هذا الفرع | لا إثبات ديناميكي | Qoder + المالك (إذن + بيئة) |
| K2 | عيب تمرير 320px في `phase1-acceptance` | عنصر تأكيد خارج الشاشة بعد تغيير الحجم | **Claude** |
| K3 | فجوة typecheck في W09 أُصلحت في W10 | يفشل أول CI قبل الإصلاح لو رُفض | Qoder (مُصلحة) |
| K4 | `development-tls.test.ts` بلا سكربت npm | لا يُشغَّل تلقائيًا | قائم، يُعالج في CI |
| K5 | المسارات الجديدة غير موجودة في OpenAPI | لا عملاء مولّدون لها | Claude يقرر |
| K6 | النقد 404 خارج التطوير | لا اختبار إنتاجي | مقصود |
| K7 | عدّادات W08/W09 في تقاريرهما صُحّحت (12 و19) | توثيقي فقط | Qoder (مُصلحة) |

---

## 23. مخاطر تعارض التكامل

أعلى خطر: `lib/db/src/schema/index.ts` (+719 سطرًا). التفاصيل والمصفوفة الكاملة في `QODER_CLAUDE_MERGE_RISK_MATRIX.md`. القاعدة: **كل تعارض في مخطط Drizzle يُحل بالجمع الإضافي، ثم إعادة التحقق من الهاشات والقيد التدميري، ثم إعادة توليد أي عميل.**

---

## 24. SHA المحلي النهائي

```
git -C D:\DINAR\dinar-w0712 rev-parse HEAD
939c64f91944d716503b1ca992e4e016ea18692a   ← قبل التزام وثائق W12
```

- شيفرة W07–W11: `939c64f`.
- وثائق W12 تُضاف في التزام توثيقي واحد أبوه `939c64f`؛ SHA الالتزام نفسه يُعلن في التقرير النهائي للمالك (لا يمكن لملف أن يحتوي هاش الالتزام الذي يحمله).
- الفرع لم يُدفع، فلا SHA بعيد.

---

## 25. تسلسل الدمج/الالتقاط الموصى به لـClaude

**الطريقة الموصى بها: cherry-pick بترتيب الموجات، لا merge واحد.**

```bash
# على فرع تكامل Claude، بعد التأكد أن b80c27b سلف حالي
git cherry-pick -x 09e8941   # W07 + 0041
# 1) pnpm install && pnpm run typecheck
# 2) migrate على قاعدة disposable، ثم test:w07

git cherry-pick -x 20ed66e   # W08 + 0042
# migrate + test:w08

git cherry-pick -x 9af5170   # W09 + 0043
# migrate + test:w09

git cherry-pick -x 9ae637c   # W10 + 0044
# migrate + test:w10

git cherry-pick -x 939c64f   # W11 docs
```

**قواعد إلزامية:**
1. لا تُعاد ترتيب الترحيلات 0041→0044. إن وُجد أي tag `0041+` مسبقًا على فرع Claude، **توقف** وطابق الهاشات قبل أي حل.
2. عند تعارض `schema/index.ts`، اجمع الجانبين؛ لا تحذف كتلة موجة لحل التعارض.
3. بعد الحل: `sha256sum` لكل ترحيل + مقارنة بالمانيفست والحارس + مسح تدميري.
4. أعد `pnpm run typecheck` قبل أي اختبار (فخ CI: الـworkflow يوقف المجموعة عند فشل typecheck).
5. لا تقبل أي «نجاح» بلا مخرجات؛ كل المجموعات الأربع و11 انحدارًا يجب أن تُشغَّل على SHA واحد.
6. لا تدمج إلى `main`، ولا تنشر، ولا تفعّل دفعًا حيًا في هذه الخطوة.

---

## 26. حكم GO/NO-GO

| البوابة | الحكم |
|---|---|
| **GO** لمراجعة التكامل على الفرع | ✅ — الكود معزول، إضافي، موثّق، وله 65 اختبارًا مكتوبًا |
| **GO** لالتقاط الالتزامات الخمسة بترتيبها | ✅ — بشرط تشغيل البوابات بعد كل التقاط |
| **NO-GO** للإصدار/الإنتاج | ⛔ — لا تشغيل، لا متصفح، لا مراجعة قانونية، لا مزود دفع |
| **NO-GO** لتفعيل أي سوق أو دفع حقيقي | ⛔ — يحتاج قرار مالك منفصل + بوابات قانونية |
| **NO-GO** لأي ادعاء «جاهز للإصدار» | ⛔ — W12 مرشّح تكامل فقط |

---

## الحالة النهائية (بالعربية)

- **W07:** مكتمل كتابةً — دفتر مالي إلحاقي، عمولة مُصدَّرة، فك اقتراب التفعيل بالسعر. التشغيل BLOCKED.
- **W08:** مكتمل كتابةً — نقد بإقرار بائع، استرداد نقدي منفصل، حقيقة قدرات. التشغيل BLOCKED.
- **W09:** مكتمل كتابةً — دورة حياة سياسات، رضا صريح، كيان قانوني، توثيق بائع، حماية قاصرين. التشغيل BLOCKED.
- **W10:** مكتمل كتابةً — بلاغات رسائل/AI، إشارات احتيال، دعم RBAC، جاهزية واتساب بلا إرسال. التشغيل BLOCKED.
- **W11:** قبول بنيوي PASS؛ قبول تشغيلي BLOCKED؛ عيب 320px ملك Claude مُوثَّق وغير ملموس.
- **W12:** حزمة تسليم مكتملة (هذا الملف + خرائط العقود والمخاطر وقائمة المراجعة + البحث القانوني التحضيري).
- **الفرع:** `qoder/parallel-w07-w12-ultra`
- **الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873`
- **SHA النهائي للشيفرة:** `939c64f91944d716503b1ca992e4e016ea18692a` (W07–W11) + `3c80fc1` (تقوية CI)
- **الملفات المتغيرة:** 53 ملفًا منذ الأساس، منها 18 جدولًا جديدًا و4 ترحيلات و4 تقارير موجات + وثائق W11/W12 الست + ملف تقوية CI.
- **النشر:** لم يحدث. **الدمج:** لم يحدث. **الدفع الحي:** غير مفعّل.
