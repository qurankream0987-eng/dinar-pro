# DINAR NEXT — W12: حزمة التسليم للتكامل (Qoder Integration Candidate)

**المستودع:** `qurankream0987-eng/dinar-pro`
**الفرع:** `qoder/parallel-w07-w12-ultra` — منشور
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873`
**رأس الفرع النهائي المدقق (محلي = بعيد):** `7b115dc015b0a390fb8bdd3040d21ac8e7137abe`
**حالة النشر:** دُفع الفرع فقط. **لا دمج، لا نشر، لا ترحيل إنتاجي، لا تفعيل مالي حي.**
**التاريخ:** 2026-10-31

> **تعريف صريح:** هذه حزمة **مرشّح تكامل**، لا مرشّح إصدار إنتاجي. Claude يراجع ويدمج ويعيد القبول النهائي. لا ادعاء جاهزية إصدار، ولا موافقة قانونية، ولا تفعيل سوق أو دفع.

---

## 1. سجل النشر

| البند | القيمة | التحقق |
|---|---|---|
| الفرع البعيد | `origin/qoder/parallel-w07-w12-ultra` | `git rev-parse` |
| SHA المحلي | `7b115dc015b0a390fb8bdd3040d21ac8e7137abe` | `git rev-parse HEAD` |
| SHA البعيد | `7b115dc015b0a390fb8bdd3040d21ac8e7137abe` | `git rev-parse origin/qoder/parallel-w07-w12-ultra` |
| `main` | `b1b20e513ed25952bc086778fb71af88adcc54ba` — **لم تتغير** | `git rev-parse main` = `origin/main` |
| `claude/10-ultra-closure` | `9a0f86f0b3c727f48be58aee7db11a3045a94613` — **لم تتغير** | لا دفع إليها |
| force push | **لم يحدث** | دفع عادي `57c9653..0bfdfd0` ثم `0bfdfd0..7b115dc` |
| فرع Claude/Codex/Gemini | **لم يُمس** | لا مراجع جديدة |
| شجرة العمل | نظيفة | `git status --porcelain` فارغ |

**قيود نُفِّذت:** لم يُطلب PAT في المحادثة أو الشيفرة، ولم يُكتب أي سر في الملفات. لا فرع آخر دُفع، ولا merge، ولا تغيير في `main`.

> **ملاحظة على SHA التوثيق:** التزام تحديث هذه الوثيقة (W12 + W11) يلي `7b115dc` ويلمس ملفي التوثيق فقط؛ **SHA الشيفرة المُختبرة يبقى `7b115dc`**، ويمكن التحقق بـ`git diff --name-only 7b115dc..HEAD` (وثائق فقط).

---

## 2. تاريخ الالتزامات (15 التزامًا بعد الأساس)

| # | الالتزام | الوصف |
|---|---|---|
| 1 | `09e8941` | W07: دفتر مالي بالإضافة فقط وعمولة مُصدَّرة |
| 2 | `20ed66e` | W08: إقرارات نقد مباشرة ومحرك استرداد نقدي منفصل |
| 3 | `9af5170` | W09: دورة حياة السياسات والرضا الصريح وبوابات الامتثال |
| 4 | `9ae637c` | W10: البلاغات والفرز البشري وإشارات الاحتيال والدعم وجاهزية واتساب |
| 5 | `939c64f` | W11: قبول الفرع المستقل |
| 6 | `46489fe` | W12: حزمة التكامل والعقود والمخاطر |
| 7 | `1a5ed7e` | تصحيح عدد الملفات في W12 |
| 8 | `3c80fc1` | تقوية CI: تثبيت Actions، رمز للقراءة فقط، قوائم سماح مغلقة |
| 9 | `396a3f2` | مزامنة أعداد الملفات مع التزام CI |
| 10 | `bda317f` | إصلاح خطأي typecheck (TS2783 في compliance، TS7006 في order-journal) |
| 11 | `74ca294` | اختبارات W07–W10: بادئة هاتف أردنية صالحة (`79`) |
| 12 | `2dff3b9` | إصلاح توجيه: تركيب مسارات النقد قبل wildcard السوق + إصلاحات W09 |
| 13 | `57c9653` | قائمة سماح مفاتيح قاعدة الاختبار والعروض |
| 14 | `0bfdfd0` | اختبار commerce: بادئة هاتف صالحة |
| 15 | `7b115dc` | CI: تثبيت Chromium لمسار المتصفح في wave3 |

**المجموع منذ الأساس:** **54 ملفًا، +11,471/−84** (لا تغيير في `pnpm-lock.yaml` أو التبعيات، ولا merge commit).

---

## 3. سجل الأدلة — كل التشغيلات على SHA النهائي `7b115dc` (PG16 ما لم يُذكر)

الروابط: `https://github.com/qurankream0987-eng/dinar-pro/actions/runs/<id>`. كل تشغيل مجموعة يطبع `LOCAL_SUITE … outbound=0`، ويسبقه typecheck + بناء api-server + بناء الويب + `test:surfaces` (28/28).

| المجموعة | Run ID | PG | النتيجة | العدّ |
|---|---|---|---|---|
| wave07-financial-journal | 41226468589 | 16 | ✅ PASS | 10/10 |
| wave08-cash-and-refunds | 41226473110 | 16 | ✅ PASS | 12/12 |
| wave09-policy-consent-compliance | 41225782880 | 16 | ✅ PASS | 19/19 |
| wave09-policy-consent-compliance | 41225917027 | **18** | ✅ PASS | 19/19 |
| wave10-trust-support-whatsapp | 41225786917 | 16 | ✅ PASS | 24/24 |
| financial-state-machine | 41226861851 | 16 | ✅ PASS | 23/23 |
| payment-order-state | 41226866186 | 16 | ✅ PASS | 3/3 |
| wave4-payment-acceptance | 41226870071 | 16 | ✅ PASS | 1/1 |
| security-acceptance | 41226873793 | 16 | ✅ PASS | 12/12 |
| r5-delivery-economics | 41226878254 | 16 | ✅ PASS | 3/3 |
| readiness | 41227188675 | 16 | ✅ PASS | 15/15 |
| development-tls | 41227191908 | 16 | ✅ PASS مع **1 SKIP** | 7 ناجح / 1 متجاوز |
| phase1-acceptance | 41227920663 | 16 | ✅ PASS | 1 رحلة (164s) |
| wave3-acceptance | 41225297184 | 16 | ✅ PASS | 11/11 |
| wave02-card-reliability | 41225530712 | 16 | ✅ PASS | 9/9 |
| commerce-journey | 41228316641 | 16 | ✅ PASS | 1/1 |
| sc01-browser-journey | 41228320808 | 16 | ✅ PASS | 1/1 |
| sc02-browser-journey | 41228325072 | 16 | ✅ PASS | 1/1 |
| sc03-browser-journey | 41228330450 | 16 | ✅ PASS | 1/1 |
| sc06-browser-journey | 41228335640 | 16 | ✅ PASS | 1/1 |
| sc07-browser-journey | 41228339869 | 16 | ✅ PASS | 1/1 |
| sc10-browser-journey | 41228344528 | 16 | ✅ PASS | 1/1 |
| wave03-card-envelope-browser | 41228348657 | 16 | ✅ PASS | 1/1 |
| **البوابة الأمنية** (qoder-security) | 41225913028 | — | ✅ PASS | audit/build/codegen |

**إجمالي اختبارات الموجات المنفَّذة:** 65/65 (W07 10، W08 12، W09 19، W10 24) على PG16، و19/19 لـW09 على PG18.

### 3.1 حالات FAIL أثناء البطارية — السبب والإصلاح (كلها أُعيد تشغيلها خضراء)

| Run ID | المجموعة | سبب الفشل | الإصلاح / إعادة التشغيل |
|---|---|---|---|
| 396a3f2 (تشغيلات 41211646881/72578/81956/90830/99587) | typecheck | TS2783 `marketId` مكرر، TS7006 `row` بلا نوع | `bda317f` → PASS |
| 41212097260 | W07 | تسجيل 400: بادئة هاتف `77` يرفضها libphonenumber | `74ca294` (بادئة `79`) → PASS |
| 41213234260 | W08 | 404: wildcard السوق يبتلع `/orders/:id/cash-refunds` | `2dff3b9` (ترتيب التركيب) → PASS |
| 41213245300 | W09 | `assert.rejects` بنص مجرد + مسار تصدير متداخل | `2dff3b9` → PASS |
| 41217267655/83571/04903/29027 | بوابات متصفح | مفاتيح بيئة ناقصة (`TEST_DATABASE`, `WAVE4`, `PROMOTIONS`) | `57c9653` (قائمة سماح) → PASS |
| 41220800930 | sc01 | انتظار `purchase-review` بلا تفعيل محاكاة الدفع | أُعيد التشغيل مع `BDINAR_WAVE4_ACCEPTANCE=development` → 41222380323/41228320808 PASS |
| 41220790529 | commerce | 400 بادئة هاتف `78` | `0bfdfd0` → 41222154450/41228316641 PASS |
| 41222650587 | sc03 | ضجيج console من `/api/promotion-products` 503 | أُعيد التشغيل مع `BDINAR_PROMOTIONS_ENABLED=true` → 41223013779/41228330450 PASS |
| 41224573404 | wave3 | Chromium غير مثبت لهذه المجموعة | `7b115dc` → 41225297184 PASS |
| 41225774654 | W07 | 404 `/api/payments/intents` (مفتاح WAVE4 ناقص) | أُعيد التشغيل → 41226468589 PASS |
| 41225778745 | W08 | 404 في سيناريو تعارض الدفع الإلكتروني (نفس السبب) | أُعيد التشغيل → 41226473110 PASS |
| 41227196099 | phase1 | 164 فحصًا ناجحًا، لكن استثناءان console 500 عابران | أُعيد التشغيل بنفس مفاتيح التشغيل الخضراء → 41227920663 PASS |

**لا FAIL مفتوح، ولا TIMEOUT، ولا BLOCKED على SHA النهائي.** لم يُدَّعَ PASS لأي اختبار لم يُنفَّذ.

### 3.2 الاستثناء الوحيد المتجاوز (SKIP) — يُبلَّغ كـSKIP لا PASS

- `development-tls.test.ts` → «live TLS validates chain and service identity…» يتجاوز عندما `DINAR_TLS_ACCEPTANCE !== "1"`. خدمة PostgreSQL المعزولة في CI بلا TLS، فالسطر متجاوز عن قصد. بقية المجموعة (7/7) نُفِّذت، ومنها التحقق من سلاسة سجل الترحيلات (45 مدخلًا، آخرها `0044`) ورفض أي تعديل/إعادة تسمية/إضافة مدخل غير مراجع.
- لا استثناءات أخرى: كل المجموعات الأخرى أبلغت `skipped 0`.

---

## 4. البوابة الأمنية (Run 41225913028)

| البند | النتيجة |
|---|---|
| المهام الثلاث (audit / build / codegen) | ✅ success |
| `pnpm audit` | `{"info":0,"low":0,"moderate":0,"high":0,"critical":0}` — `BLOCKING_VULNERABILITIES 0` |
| gitleaks (8.24.3، 153 commit، ~20.65MB) | **no leaks found** — لا طباعة لأي قيمة سرية |
| typecheck (libs + api-server + dinar + mockup + scripts) | ✅ PASS |
| بناء api-server + بناء الويب (vite 7.3.7) | ✅ PASS |
| توليد الشيفرة (codegen) | ✅ حتمي/PASS |
| Actions مثبتة بـSHA | `checkout@11d5960a…`، `pnpm/action-setup@b906affc…`، `setup-node@49933ea5…`، `upload-artifact@ea165f8d…`، `gitleaks/gitleaks-action@ff98106e…` |
| صلاحيات token | `permissions: contents: read` في الاثنين؛ checkout بـ`persist-credentials: false` |
| أسرار إنتاج/دفع/Railway/AI مدفوعة | **صفر مراجع**؛ لا `secrets.*` في أي من الـworkflowين |
| قاعدة البيانات | حاوية خدمة loopback فقط + قاعدة عشوائية تُنشأ وتُحذف؛ حارس يرفض أي `DINAR_LOCAL_PG` غير loopback أو أي `DATABASE_URL` خارجي |
| مدخلات الـworkflow | `suite` قائمة اختيار مغلقة (22 مجموعة)؛ `flags` تُفحص مفتاح/قيمة ضد قائمة سماح ولا تُدرج أبدًا في نص shell؛ `pg_version ∈ {16,18}` |
| الشبكة الخارجية | `outbound=0` في كل تشغيل (net-guard) |

---

## 5. دليل الترحيلات

- كل تشغيل ينفّذ `drizzle-kit migrate` على قاعدة **عشوائية جديدة** قبل المجموعة؛ أي فشل ترحيل يُوقف السكربت (`set -eu`) ولا تصل الاختبارات إلى تنفيذها. تحقق عملي على **PostgreSQL 16** (22 تشغيلًا) و**PostgreSQL 18** (Run 41225917027).
- `meta/_journal.json` = **45** مدخلًا، `release-manifest.json` = **45**، `EXPECTED_JOURNAL_ENTRIES = 28 + 17 = 45`، آخر tag = `0044_wave10_trust_support_whatsapp`.
- هاشات 0041–0044 مثبتة في `clone-migration-guard.ts` و`development-tls` وتُقارن في التشغيل؛ أي تعديل على مدخل مراجع يُفشل المجموعة (اختُبر بحقن 44 أو 46 مدخلًا وبتحريف هاش).
- الفحص التدميري: 526 مقتطفًا، **0** تدميري. الإسقاط الوحيد قيد `DROP CONSTRAINT` لإعادة إنشاء `marketplace_reports_target_type_valid` أوسع — ليس بيانات.
- لم يُشغَّل أي ترحيل على قاعدة إنتاج أو على قاعدة مشتركة؛ كل قاعدة كانت loopback عشوائية وحُذفت بعد التشغيل.

| الترحيل | sha256 |
|---|---|
| `0041_wave07_financial_journal` | `4403b20e…4347cf0` |
| `0042_wave08_cash_engines` | `44e4a812…798a326d` |
| `0043_wave09_policy_consent_compliance` | `29127432…86b12316` |
| `0044_wave10_trust_support_whatsapp` | `edb8ca57…b3bb50e0` |

---

## 6. التحققات الحرجة التي طلبها المالك — مع دليل الاختبار

| التحقق | النتيجة | الدليل |
|---|---|---|
| إقرار النقد لا يُنشئ «تسليمًا مكتملًا» كذبًا | ✅ | W08: «seller confirmation is the only cash payment attestation and is idempotent» → `cash receipt alone does not accrue a completed-sale due` ([wave08-cash-and-refunds.test.ts:356](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave08-cash-and-refunds.test.ts#L356))؛ والإكمال يمرّ بمسار `/orders/:id/delivery` منفصل ([…:596](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave08-cash-and-refunds.test.ts#L596)) |
| إبقاء تأكيد التسليم مستقلًا للبائع والمشتري | ✅ | W08: البائع وحده يقرر الادعاء، والمشتري وحده يعترض ([…:253](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave08-cash-and-refunds.test.ts#L253))؛ SC01 browser: البائع يسجّل التسليم ثم المشتري يؤكد الاستلام → `COMPLETED` (Run 41228320808) |
| ترحيل العمولة idempotent | ✅ | W07: «retrying checkout with the same key writes no second journal entry»، «append-only and idempotent by business key»، «completion accrues commission… cancellation never accrues» ([wave07-financial-journal.test.ts:333](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave07-financial-journal.test.ts#L333)، [:342](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave07-financial-journal.test.ts#L342)، [:382](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave07-financial-journal.test.ts#L382)) |
| سلطة الاسترداد وتأكيد المشتري | ✅ | W08: «a seller repayment claim stays unverified until the buyer confirms receipt» ([…:499](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave08-cash-and-refunds.test.ts#L499))؛ السقف التراكمي والرفض عند التجاوز؛ عكس العمولة قبل/بعد الإكمال |
| الكيان القانوني غير مفعّل | ✅ | W09: «legal entities start disabled, hold no capabilities and cannot be invented by raw SQL» ([wave09-policy-consent-compliance.test.ts:434](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave09-policy-consent-compliance.test.ts#L434)) |
| تفعيل حماية القاصرين غير مفعّل | ✅ | W09: البوابات مطفأة حتى التفعيل، والقاصر المُعلن يُحجب حتى موافقة وليّ منفصل ([…:615](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave09-policy-consent-compliance.test.ts#L615)، [:633](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave09-policy-consent-compliance.test.ts#L633)) |
| إرسال واتساب حقيقي معطّل | ✅ | W10: «an intent is refused without consent or a provider and is never sent»، «with a simulated provider the intent is ready yet still not sent» ([wave10-trust-support-whatsapp.test.ts:583](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave10-trust-support-whatsapp.test.ts#L583)، [:607](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave10-trust-support-whatsapp.test.ts#L607))؛ `liveSendsEnabled:false` وقيود قاعدة `NOT_SENT` |
| تنفيذ الدفع الحقيقي معطّل | ✅ | W08: المسارات 404 خارج بيئة التطوير ([…:202](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave08-cash-and-refunds.test.ts#L202))؛ `paymentSimulationEnabled()` يشترط `NODE_ENV=development` و`BDINAR_WAVE4_ACCEPTANCE=development` وغياب `REPLIT_DEPLOYMENT` ([payments.ts:32](file:///D:/DINAR/dinar-w0712/artifacts/api-server/src/routes/payments.ts#L32))؛ المحول `SIMULATION_ONLY` فقط |
| البحث القانوني التحضيري ليس موافقة نهائية | ✅ | W09: «the registry refuses to skip review steps or invent a legal approval» ([…:338](file:///D:/DINAR/dinar-w0712/artifacts/api-server/test/wave09-policy-consent-compliance.test.ts#L338))؛ السياسات `PENDING_LEGAL_APPROVAL` |

---

## 7. معمار المصدر (مختصر)

```
lib/db/
  drizzle/0041…0044            ← أربعة ترحيلات إضافية (18 جدولًا جديدًا)
  drizzle/meta/_journal.json   ← 45 مدخلًا
  drizzle/release-manifest.json
  src/clone-migration-guard.ts ← هاشات 17 ترحيلًا معلّقًا
  src/schema/index.ts          ← +719 سطرًا (أعلى نقطة تعارض محتملة)

artifacts/api-server/src/
  lib/order-journal.ts         ← الكاتب الوحيد للقيود المالية
  lib/commission-policy.ts     ← حل السياسة واللقطة
  lib/payments/cash.ts         ← آلة النقد (تطوير فقط)
  lib/policy-lifecycle.ts      ← سجل إصدارات السياسات
  lib/compliance.ts            ← الرضا، الكيان، التوثيق، القاصر
  lib/fraud-signals.ts | support-cases.ts | whatsapp-readiness.ts
  routes/marketplace.ts        ← checkout + البوابات + لقطة العمولة
  routes/cash.ts | compliance.ts | trust-safety.ts | trust-ops.ts
  routes/index.ts              ← تركيب: cash قبل marketplace (إصلاح 2dff3b9)
```

**غير مملوك لـQoder ولم يُلمس:** `src/ai/**`، `artifacts/dinar/src/pages/Ai.tsx`، `AiChat.css`، محددات البطاقات، عقد Card Envelope. (استثناء إصلاح typecheck في `lib/compliance.ts` و`lib/order-journal.ts` — ملفات Qoder الجديدة.)

---

## 8. عقود مختصرة

- **الدفتر:** `order_financial_events` إلحاقية، كاتب وحيد `recordOrderFinancialEvent`، فرادة `(order_id, idempotency_key)`، `reverses_event_id` داخل الطلب، UPDATE/DELETE/TRUNCATE مرفوضة بـtrigger، أعداد صحيحة بالوحدة الصغرى.
- **العمولة:** `1,000 bps` سياسة منشورة `cmp_platform_commission_v1` مع لقطة لكل طلب؛ لا ثابت خفي.
- **النقد:** `CLAIMED` ليس دفعًا؛ `CONFIRMED` بإقرار البائع فقط؛ خارج التطوير 404.
- **الاسترداد النقدي:** `OPEN → REPAYMENT_CLAIMED → CONFIRMED/DISPUTED | WITHDRAWN`؛ القيد عند تأكيد المشتري فقط؛ سقف تراكمي في القاعدة؛ عكس عمولة تلقائي.
- **التسليم:** آلة الطلب القائمة دون تعديل (`CREATED → ACCEPTED → SELLER_MARKED_DELIVERED → COMPLETED/DISPUTED`)، ونقطة الإغلاق الوحيدة `applyTerminalOrderAccounting`.
- **السياسات/الرضا:** قرار صريح فقط (`POLICY_REVIEW`/`API`)، لا مصدر محادثة، وسجل إلحاقي.
- **الكيان/التحقق:** يبدأ `DISABLED`؛ التفعيل بفاعل وصلاحية؛ التحقق البشري لا يُمنح ذاتيًا.
- **واتساب:** مزود حقيقي غير موجود؛ النيّة `READY_TO_SEND` لا تُرسل؛ حمولة ترفض الهاتف/OTP/كلمة المرور.
- **الدعم/البلاغات:** RBAC على كل `/admin/*`، 404 موحد للغير، إشارات احتيال إلحاقية، لا عقوبة آلية (`automaticEnforcement:false`).

---

## 9. مصفوفة المخاطر (الحالة الفعلية بعد CI)

| # | الخطر | الاحتمال | الأثر | الحالة / التخفيف |
|---|---|---|---|---|
| R1 | تعارض `lib/db/src/schema/index.ts` عند دمج Claude (+719 سطرًا) | مرتفع | مرتفع | حل بالجمع الإضافي، ثم إعادة فحص الهاشات والمسح التدميري قبل أي اختبار (انظر §13) |
| R2 | عيب تمرير 320px في `Ai.tsx` (ملك Claude) | مؤكد | متوسط | لم يُلمس؛ phase1 يغطي مسارات أخرى؛ يحتاج إصلاح Claude |
| R3 | المسارات الجديدة غير موجودة في OpenAPI/العملاء المولّدين | مرتفع | متوسط | قرار Claude؛ الواجهة الحالية تستعمل fetch مباشرًا |
| R4 | أي تفعيل نقدي/دفع في بيئة غير تطوير | منخفض | مرتفع | بوابة env ثلاثية + 404 + اختبارات W08 |
| R5 | ترحيلات على قاعدة مشتركة دون مراجعة | منخفض | مرتفع | لم يحدث؛ القاعدة العشوائية + حارس loopback |
| R6 | إبطال GitHub PAT القديم غير مُثبت | مؤكد | مرتفع | إجراء مالك مستقل؛ نظافة المستودع لا تُثبته |
| R7 | اعتماد قانوني غير مكتمل للسياسات/الكيانات | مؤكد | مرتفع | `PENDING_LEGAL_APPROVAL`؛ البحث التحضيري ليس رأيًا قانونيًا |
| R8 | مزودو الدفع/واتساب غير متصلين | مؤكد | متوسط | خارج النطاق؛ لا ادعاء تكامل |
| R9 | تعارض ترتيب مسارات Express 5 | منخفض | متوسط | أُصلح في `2dff3b9` ومغطى باختبار W08 |
| R10 | هشاشة اختبارات تعتمد مفاتيح بيئة متعددة | متوسط | منخفض | قائمة سماح صريحة موثقة في §14 |

---

## 10. العوائق (Blockers) بعد الاختبار

1. **لا نشر ولا دمج:** بلا أمر مالك جديد. `main` وفرع Claude لم يُمسّا.
2. **لا ترحيل إنتاجي:** 0041–0044 لم تُطبَّق إلا على قواعد disposable.
3. **لا تفعيل مالي حي:** النقد/الدفع محاكاة تطوير فقط؛ واتساب بلا مزود.
4. **الموافقة القانونية:** نصوص السياسات والكيان القانوني وحماية القاصرين تنتظر قرارًا بشريًا/قانونيًا.
5. **إبطال PAT:** يُثبت فقط بإجراء في GitHub، لا بفحص المستودع.
6. **عيب 320px:** ملك Claude، غير ملموس هنا.
7. **OpenAPI:** قرار Claude قبل أي عميل مولّد.

---

## 11. ما لم يُنفَّذ (صراحةً)

- لا `git push --force`، ولا حذف أي ref، ولا دفع لأي فرع آخر.
- لا دمج إلى `main`، ولا merge commit في الفرع.
- لا نشر إلى Railway أو أي بيئة، ولا تشغيل ترحيل إنتاجي.
- لا نداء AI مدفوع (SC01 يثبت عدّاد بوابة النموذج = 0 و`BDINAR_BLOCK_MODEL_CALLS=1`).
- لا دفع حقيقي، ولا رسالة واتساب حقيقية، ولا اعتماد سياسة قانونية.
- لا تغيير في تبعيات الجذر أو `pnpm-lock.yaml` أو اشتراكات/أسعار إعلانات.

---

## 12. إعادة إنتاج القبول (أوامر)

```bash
cd D:\DINAR\dinar-w0712
git rev-parse HEAD origin/qoder/parallel-w07-w12-ultra   # كلاهما 7b115dc

gh workflow run qoder-api-suite.yml --ref qoder/parallel-w07-w12-ultra \
  -f suite=wave07-financial-journal.test \
  -f flags="BDINAR_W07_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development"
# ... نفس النمط لكل مجموعة، بالمفاتيح الموضحة في §14

gh workflow run qoder-security.yml --ref qoder/parallel-w07-w12-ultra
```

> الإرسال المتوازي آمن لأن مجموعة الـconcurrency تتضمن اسم المجموعة ونسخة PG؛ ومع ذلك يُفضَّل التسلسل لتسجيل أدلة مرتبة. التحقق من هوية التشغيل من سطر `SUITE:` في السجل لا من ترتيب القائمة.

---

## 13. تسلسل التكامل الموصى به لـClaude

**cherry-pick بترتيب الموجات، لا merge واحد.** الأساس `b80c27b` سلف لفرع Claude الحالي.

```bash
# على فرع تكامل Claude
git cherry-pick -x 09e8941 20ed66e 9af5170 9ae637c   # W07→W10 + 0041…0044
# بعد كل موجة: typecheck ثم migrate على قاعدة disposable ثم test:w0N

git cherry-pick -x 939c64f   # W11 docs
git cherry-pick -x 46489fe 1a5ed7e 3c80fc1 396a3f2  # W12 + تقوية CI + مزامنة
git cherry-pick -x bda317f 74ca294 2dff3b9 57c9653 0bfdfd0 7b115dc  # إصلاحات CI
```

**قواعد إلزامية:**
1. لا تُعاد ترتيب الترحيلات 0041→0044؛ إن وُجد tag `0041+` مسبقًا على فرع Claude **توقف** وطابق الهاشات.
2. تعارض `schema/index.ts`: اجمع الجانبين، لا تحذف كتلة موجة.
3. بعد الحل: `sha256sum` لكل ترحيل + مقارنة بالمانيفست والحارس + مسح تدميري.
4. `pnpm run typecheck` قبل أي اختبار (فخ CI: فشل typecheck يوقف المجموعة).
5. أعد تشغيل المجموعات الأربع + الانحدار على **SHA واحد**؛ لا تقبل «نجاحًا» بلا مخرجات.
6. لا دمج إلى `main` ولا نشر ولا تفعيل حي داخل هذه الخطوة.
7. احتفظ بملفات CI المثبتة بـSHA؛ لا تستبدلها بإصدارات عائمة.

---

## 14. مفاتيح تشغيل المجموعات (قائمة السماح في الـworkflow)

| المجموعة | المفاتيح |
|---|---|
| W07 / W08 / W09 / W10 | `BDINAR_W0N_ACCEPTANCE=development` (+ `BDINAR_WAVE4_ACCEPTANCE=development` لـW07/W08) |
| financial-state-machine / payment-order-state / wave4-payment-acceptance | `BDINAR_WAVE4_ACCEPTANCE=development` |
| security-acceptance | `BDINAR_SECURITY_ACCEPTANCE=development` |
| phase1-acceptance | `BDINAR_PHASE1_ACCEPTANCE=development BDINAR_TEST_DATABASE=development BDINAR_PROMOTIONS_ENABLED=true` |
| wave3-acceptance | `BDINAR_WAVE3_ACCEPTANCE=development` |
| wave02-card-reliability | `BDINAR_WAVE02_ACCEPTANCE=development` |
| commerce / sc01 | `BDINAR_TEST_DATABASE=development BDINAR_WAVE4_ACCEPTANCE=development` |
| sc02 / sc07 / wave03-card-envelope | `BDINAR_TEST_DATABASE=development BDINAR_PROMOTIONS_ENABLED=true` |
| sc03 / sc10 | `BDINAR_TEST_DATABASE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` |
| sc06 | `BDINAR_TEST_DATABASE=development` |
| development-tls | `DINAR_TLS_ACCEPTANCE=development` (السطر الحي يتجاوز في CI بلا TLS) |
| readiness / r5-delivery-economics | بلا مفاتيح |

الـworkflow يرفض أي مفتاح خارج القائمة (exit 96) وأي قيمة غير مسموحة، ولا يُدرج المدخلات في نص shell.

---

## 15. التراجع (Rollback)

**قبل الدمج (الحالة الآن):** لا يلزم تراجع؛ الفرع منفصل و`main`/فرع Claude سليمان. لتعطيل النشر فقط (بأمر مالك): `git push origin --delete qoder/parallel-w07-w12-ultra` — إجراء مشترك/غير قابل للتراجع، لم يُنفَّذ.

**بعد الدمج، إن حدث لاحقًا:**
1. `git revert -m 1 <merge-sha>` أو revert عكسي للالتزامات الخمسة عشر؛ لا `reset --hard` ولا force push.
2. لا تُسقط الترحيلات 0041–0044 تلقائيًا: هي إضافية والجداول غير مستخدمة قبل التفعيل. أي إسقاط يحتاج قرار مالك + نسخة احتياطية + مراجعة.
3. أعد `typecheck` + المجموعات + فحص الهاشات بعد أي revert.
4. لا تُعِد تفعيل أي ميزة مالية أثناء التراجع.

---

## 16. حكم GO/NO-GO

| البوابة | الحكم |
|---|---|
| مراجعة التكامل على الفرع | ✅ **GO** — منشور، 54 ملفًا، 65 اختبار موجة + 22 مجموعة، كلها PASS على `7b115dc` |
| التقاط الالتزامات بترتيبها | ✅ **GO** — بشرط إعادة البوابات بعد كل التقاط |
| النشر/الإنتاج | ⛔ **NO-GO** — لا طلب، ولا مزود دفع، ولا اعتماد قانوني |
| الدمج إلى `main` | ⛔ **NO-GO** — غير مصرح |
| ترحيل إنتاجي | ⛔ **NO-GO** |
| تفعيل سوق/دفع حي | ⛔ **NO-GO** — قرار مالك منفصل + بوابات قانونية |
| ادعاء «جاهز للإصدار» | ⛔ **ممنوع** — مرشّح تكامل فقط |

---

## 17. الحالة النهائية

- **W07:** مكتمل ومُنفَّذ — دفتر إلحاقي، عمولة مُصدَّرة، 10/10 PASS.
- **W08:** مكتمل ومُنفَّذ — نقد بإقرار بائع، استرداد نقدي، 12/12 PASS.
- **W09:** مكتمل ومُنفَّذ — سياسات/رضا/كيانات/قاصرون، 19/19 PASS على PG16 وPG18.
- **W10:** مكتمل ومُنفَّذ — بلاغات/احتيال/دعم/جاهزية واتساب، 24/24 PASS.
- **W11:** قبول بنيوي PASS + تشغيلي PASS بعد CI (تحديث في الملف).
- **W12:** هذه الحزمة + خرائط العقود والمخاطر وقائمة المراجعة والبحث القانوني التحضيري.
- **الفرع:** `qoder/parallel-w07-w12-ultra` @ `7b115dc` (بعيد = محلي).
- **النشر:** الفرع فقط. **الدمج:** لم يحدث. **الدفع الحي:** غير مفعّل. **AI مدفوع:** لم يُستخدم.
