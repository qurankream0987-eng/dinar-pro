# DINAR NEXT — الموجة 07: محرك التجارة والمال — التتبع والتنفيذ

**الفرع المعزول:** `qoder/parallel-w07-w12-ultra`
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873` (`claude/05-w04-context`)
**بيئة العمل:** `D:\DINAR\dinar-w0712` — worktree مستقل، لا يلمس شجرة Claude.
**الحالة:** التتبع مكتمل، وتنفيذ W07.2–W07.6 مكتوب ومُراجع ثابتًا. **التشغيل الديناميكي BLOCKED** لعدم توفر `node_modules` ولا PostgreSQL/Docker/WSL على المضيف، ولأن دفع الفرع إلى CI ممنوع قبل إذن المالك.

> **تحديث W12.1 (2026-10-31):** هذه الحالة صحيحة **كما كانت وقت الكتابة**: لم يكن هناك مضيف قادر ولا إذن نشر. وهي الآن متجاوَزة تشغيليًا بعد إذن المالك ونشر الفرع: شُغِّل `wave07-financial-journal.test` على SHA الشيفرة `7b115dc` في التشغيل `41226468589` (PG16، 10/10، `outbound=0`)، وأُعيد على SHA المرشّح `6b702ae` في التشغيل `41239477707`. النص التاريخي أدناه يبقى كما هو؛ لا يُعاد كتابته لتبدو الموجة «خضراء وقتها».

> **قاعدة الصدق:** كل ما ورد هنا مقابل ملف وسطر فعليين. وكل حالة اختبار لم تُشغَّل مذكورة صراحةً على أنها غير مشغّلة، مع سبب بيئي محدد. لا اختبار أخضر مُختلق.

---

## 1. TRACE — من يملك كل حالة مالية اليوم

### 1.1 السوق والعملة والتفعيل

| الحالة | المالك الفعلي | الملاحظة |
|---|---|---|
| صف السوق والعملة ودقة الوحدة الصغرى | `markets` (`lib/db/src/schema/index.ts:64`) و`marketView` (`lib/markets.ts:12`) | كل سوق له عملته ودقته الخاصة. لا اشتقاق من KWD. |
| إصدارات سعر السوق القديم | `marketPriceVersions` (`schema/index.ts:86`) و`resolveMarket` (`lib/markets.ts:9`) | سعر وحدة تاريخي على مستوى السوق. |
| **بوابة توفر السوق** | `isMarketAvailable` (`lib/markets.ts:46`) | **الفجوة المرصودة في وثيقة المالك:** تشترط `priceConfigured && unitPriceMinor >= 1`، أي أن التفعيل التجاري مرهون بسعر وحدة تاريخي. |
| قيد قاعدة البيانات المقابل | `markets_price_valid` (`schema/index.ts:81`) | يمنع سوقًا نشطًا بلا سعر وحدة. يكرّس الاقتران القديم على مستوى القاعدة. |
| قدرات السوق للمزودين | `market-capability-registry.ts:305` `getMarketCapabilityProfile` | ناضج: يفصل الدفع النقدي، الإلكتروني، التوصيل، المصادقة، الإشعارات، ويعلن `providerConnected: false`. |
| أهلية البائع للسوق | `seller_market_eligibility` (`schema/index.ts:188`) و`assertMarketPolicy` (`lib/markets.ts:54`) | `APPROVAL_REQUIRED` مطبق على الخادم. |

### 1.2 العرض والسعر

| الحالة | المالك الفعلي | الملاحظة |
|---|---|---|
| معنى السعر وأشكاله الخمسة | `lib/api-zod/src/listing-pricing.ts:70` `priceRepresentationOf` | `FIXED`, `NEGOTIABLE`, `OPEN_TO_OFFERS`, `STARTING_FROM`, `QUOTE_REQUIRED`. |
| سلطة تأكيد الشراء المباشر | `directPurchaseAllowed` (`listing-pricing.ts:157`) | الشراء المباشر للسعر المحدد فقط؛ الباقي عبر اتفاق. |
| سقف عرض السعر | `proposalCeilingMinor` (`listing-pricing.ts:173`) | لا سقف لعرض «يبدأ من» أو التسعيرة. |
| قواعد النشر والتسعير | `resolveListingBehavior` (`lib/listing-management.ts:71`)، `storedPricingFor` (`listing-pricing.ts:119`) | السعر موجب بالوحدة الصغرى، لا سعر إجباري موحّد. |
| لقطة سعر الطلب | `orders.unitPriceMinor/subtotalMinor` و`orderItems.unitPriceMinor` (`routes/marketplace.ts:750-807`) | تُكتب عند الإنشاء ولا تُعاد قراءتها من العرض لاحقًا. |
| سعر الاتفاق الخاص | `acceptedNegotiationForCheckout` + `resolveCommercialUnitPrice` (`lib/negotiations.ts:397`, `:115`) مع قفل `FOR UPDATE` واستهلاك واحد | السعر يُقرأ من صف التفاوض لا من الطلب. |

**نتيجة W07.2:** تسعير البائع مرن فعلاً، ومتعدد العملات، واللقطات محفوظة. المتبقي الحقيقي هو **فك اقتران التفعيل بسعر الوحدة القديم** فقط.

### 1.3 السلة والطلب ودورة الحياة

| الحالة | المالك الفعلي |
|---|---|
| سلطة السلة | `getMarketplaceCart`/`replaceMarketplaceCart`/`addMarketplaceCartItemOnce` (`lib/marketplace-cart.ts:121`, `:180`, `:346`) |
| تخطيط الشراء والتحقق | `planCheckout` (`lib/commerce.ts:53`) |
| إنشاء الطلب + لقطة العمولة + الحجز + منع التكرار | `checkout` (`routes/marketplace.ts:572`)، مفتاح `checkout_requests`، قفل عروض `FOR UPDATE` (`:643`) |
| انتقالات الطلب | `POST /orders/:id/:action` (`routes/marketplace.ts:1022`): `CREATED → ACCEPTED → SELLER_MARKED_DELIVERED → COMPLETED/DISPUTED`، والإلغاء من `CREATED` فقط (`:1107`) |
| صلاحيات الأدوار | البائع: accept/delivery، المشتري: confirm (`:1040-1044`)؛ أي طرف: cancel في `CREATED` |
| انتهاء الحجز | `expireOrderReservation` (`lib/order-expiry.ts:12`) — يحرر المخزون وينشئ التزام استرداد إن كان مدفوعًا |
| التسليم | `orderHandoff`/`settleOrderFulfillment` (`lib/delivery.ts:843`, `:864`) |
| النزاع | `disputes` + `recordOrderDisputeOpened` (`lib/payments/disputes.ts`) + قرار الإدارة (`routes/admin-disputes.ts:139`) |
| **محاسبة الإغلاق** | `applyTerminalOrderAccounting` (`lib/order-terminal-accounting.ts:15`): يحرر/يثبّت المخزون، يغلق التسليم، وينشئ `sellerDues` عند الاكتمال فقط |

**نتيجة W07.5:** الآلة موجودة ومؤمّنة (قفل صف الطلب، مفاتيح تكرار، تحقق ملكية)، والعمولة لا تُحتسب على الملغى.

### 1.4 العمولة والمستحقات

| الحالة | المالك الفعلي | الفجوة |
|---|---|---|
| نسبة الأساس | `PLATFORM_FEE_BASIS_POINTS = 1_000` (`lib/market-pricing.ts:16`) | ثابت في الكود، بلا سجل سياسات ولا إصدارات. |
| الحساب | `calculatePlatformFeeMinor` (`market-pricing.ts:28`) | صحيح: أعداد صحيحة، تقريب نصف لأعلى، رفض غير الآمن. |
| لقطة النسبة في الطلب | `orders.data.commissionRateBps` (`routes/marketplace.ts:785`) | لقطة موجودة، لكن لا أساس (إجمالي/صافي) ولا إصدار سياسة. |
| الاستحقاق | `sellerDues` عند `COMPLETED` (`order-terminal-accounting.ts:52`) | لا يوجد قيد دفتر مالي قابل للتدقيق. |
| الاسترداد | `paymentRefunds` + `paymentRefundObligations` (`lib/payments/service.ts:446`, `lib/payments/obligations.ts:21`) | لا يوجد تعديل عمولة مرتبط بالاسترداد. |

**نتيجة W07.4:** الفجوة ليست في الحساب بل في **حوكمة السياسة** (إصدارات، أساس، اعتماد) و**أثر الاسترداد على العمولة** و**الدليل المحاسبي**.

### 1.5 الدفع والتسوية

| الحالة | المالك الفعلي |
|---|---|
| عقد المزود | `lib/payments/contracts.ts` (`PaymentProviderAdapter`, `PaymentWebhookEvent`, `paymentWebhookDigest`) |
| محول الاختبار | `lib/payments/test-adapter.ts` (`SIMULATION_ONLY`) |
| نواة الدفع | `receivePaymentWebhook` (`lib/payments/service.ts:161`): تحقق توقيع، ربط intent، منع تكرار حدث المزود ببصمة SHA-256، رفض عدم التطابق |
| الاسترداد الإلكتروني | `createRefundRequest` (`service.ts:446`) + `REFUND_SUCCEEDED`/`REFUND_FAILED` |
| التزامات الاسترداد | `recordRefundObligation`/`resolveRefundObligation` (`obligations.ts:21`, `:87`) مع trigger يمنع الحذف والتعديل |
| التسوية | `reconcilePayments` (`service.ts:580`) — مقارنة الحالة المحلية بلقطة المزود والقائمة والالتزامات |
| دفع نزاع | `recordPaymentCapturedOnDisputedOrder` (`lib/payments/disputes.ts`) |

**نتيجة W08.3:** محول الدفع والتوقيع والتكرار والتسوية موجودة وناضجة. الفجوة الحقيقية: **الدفع النقدي** و**الاسترداد النقدي** (غير موجودين إطلاقًا).

---

## 2. REUSE — ما لن يُعاد بناؤه

- `computePlatformFee` الحالي يبقى أساس الحساب؛ سياسة العمولة تُغذّيه ولا تستبدله.
- `sellerDues` تبقى سجل الالتزام القابل للتحصيل؛ الدفتر الجديد لا يستبدلها.
- `paymentIntents`/`paymentRefunds`/`paymentRefundObligations` تبقى سلطة الحالة الإلكترونية.
- `applyTerminalOrderAccounting` تبقى نقطة الإغلاق الوحيدة.
- `market-capability-registry` تبقى سلطة عرض القدرات؛ التفعيل الجديد يغذّيها ولا يكرّرها.
- لا جدول `wallet` ولا رصيد مشترٍ ولا ضمان (escrow). المال لا يتحرك داخل DINAR.

---

## 3. الفجوات الحقيقية التي تنفّذها هذه الموجة

| # | الفجوة | العلاج |
|---|---|---|
| G1 | التفعيل التجاري مرهون بسعر وحدة تاريخي (`markets.ts:46` + `markets_price_valid`) | إزالة شرط السعر من `isMarketAvailable`، واستبدال قيد القاعدة بقيد دقة العملة فقط، وإضافة سلطة تفعيل صريحة بدرجات قدرات. |
| G2 | لا سجل سياسات عمولة مُصدَّرة | جدول `commission_policies` (إصدارات، نسبة bps، أساس GROSS/NET، حالة، اعتماد، سريان) + `lib/commission-policy.ts`. السياسة الافتراضية 1,000 bps **مؤقتة غير معتمدة** وتُعلن كذلك. |
| G3 | لا دفتر مالي قابل للتدقيق على مستوى الطلب | جدول `order_financial_events` بالإضافة فقط + trigger يمنع UPDATE/DELETE/TRUNCATE + `lib/order-journal.ts` + قيود عند الإنشاء/الاكتمال/الإلغاء/الاسترداد. |
| G4 | الاسترداد لا يعدّل العمولة | قيد `COMMISSION_REVERSED` تراكمي مرتبط بقيد `COMMISSION_ACCRUED`، والاستحقاق الصافي = المرحّل − المعكوس. لا يُعدَّل صف `sellerDues` ولا يُحذف؛ الدفتر هو سلطة التعديل، والواجهات تعرض الصافي. |
| G5 | لا دفع نقدي حقيقي ولا استرداد نقدي | آلة حالة نقدية صادقة (ادعاء المشتري ≠ إثبات) + ملف استرداد نقدي منفصل. |
| G6 | لا سجل كيانات قانونية ولا درجات تفعيل ولا حماية قاصرين | وحدات صريحة، كل شيء معطّل افتراضيًا، بلا اختراع كيان أو ترخيص. |
| G7 | لا بلاغات إجابات AI، ولا دعم بشري، ولا جاهزية واتساب، ولا إشارات احتيال | جداول ووحدات بدورة حياة وRBAC، مع منع العقوبة الآلية غير المراجَعة. |

---

## 4. التنفيذ (W07.2–W07.6)

### 4.1 فك اقتران التفعيل بسعر الوحدة (G1 / W07.2)

- `artifacts/api-server/src/lib/markets.ts`: `isMarketAvailable` أصبحت تعتمد حصرًا على `isActive` وحالة السوق `ACTIVE/LIMITED`. لا شرط `priceConfigured` ولا `unitPriceMinor >= 1`.
- `lib/db/drizzle/0041_wave07_financial_journal.sql`: استبدال `markets_price_valid` بقيد يسمح بسوق نشط بلا سعر وحدة تاريخي: `minor_unit_scale BETWEEN 0 AND 4 AND (unit_price_minor IS NULL OR unit_price_minor > 0)`.
- `market.priceVersionId` و`unitPriceMinor` بقيا في استجابة `marketView` للتوافق مع أسطح العرض القديمة، لكنهما لم يعودا بوابة تجارة. سعر الطلب يأتي من `offers.unitPriceMinor` أو سعر التفاوض المتفق (`routes/marketplace.ts` سطر لقطة الطلب).

### 4.2 سياسة العمولة المُصدَّرة (G2 / W07.4)

- جدول `commission_policies` في `lib/db/src/schema/index.ts` + الترحيل `0041`: `policy_key`, `version`, `rate_basis_points` (0..10000), `basis` = `GROSS_ITEM_SUBTOTAL`, `rounding_mode` = `HALF_UP`, `market_id` (اختياري), `status` (`DRAFT/PUBLISHED/SUPERSEDED`), نافذة سريان، `content_hash`, `approved_by`, `published_at`.
- فريد `(policy_key, version)`، وفريد جزئي لسياسة `PUBLISHED` واحدة لكل نطاق (سوق/عام).
- البذرة `cmp_platform_commission_v1`: 1,000 bps، عامة، `PUBLISHED`، سارية من 1970 — تعكس قرار المالك 10% صراحة، وليست قيمة مخفية.
- `artifacts/api-server/src/lib/commission-policy.ts`: `resolveCommissionPolicy` (سوق ثم عام ثم أساس موثّق)، `calculateCommissionMinor` (يمر عبر `calculatePlatformFeeMinor` الصحيح)، `commissionSnapshot`، `commissionRateForOrder` (لقطة الطلب أولًا ثم `commissionRateBps` القديم ثم نسبة الالتزام الفعلي)، و`commissionReversalForRefund` (تراكمي، أعداد صحيحة فقط).
- `routes/marketplace.ts` (checkout): تُحل السياسة مرة واحدة داخل المعاملة، وتُحفظ في `orders.data.commissionPolicy` إلى جانب `commissionRateBps`؛ لا إعادة تسعير لأي طلب لاحق عند تغيّر السياسة.

### 4.3 الدفتر المالي بالإضافة فقط (G3 / W07.3)

- جدول `order_financial_events` + الترحيل `0041`: `event_type`, `account_obligation`, `business_ref`, `actor_type/actor_id`, `currency_code`, `amount_minor`, `idempotency_key`, `reverses_event_id`, `authorization_context`, `data`, `recorded_at`.
- قيود: مفتاح تكرار فريد `(order_id, idempotency_key)`، فهرس عكسي، تحقق نوع الحدث/الالتزام/الفاعل، مبلغ ≥ 0، عملة بطول 3.
- Triggers: منع `UPDATE`/`DELETE`/`TRUNCATE`، والتحقق من أن عملة القيد تساوي عملة الطلب، وأن أي قيد عكسي يشير إلى قيد في الطلب نفسه.
- `artifacts/api-server/src/lib/order-journal.ts`: `recordOrderFinancialEvent` هو الكاتب الوحيد (تحقق كامل، إرجاع القيد الأصلي عند تكرار المفتاح بنفس الحقائق، ورفض إعادة استخدام المفتاح بحقائق مختلفة)، `postCompletedOrderJournal`، `recordCommissionReversal`، `commissionReversalsByOrder`، `netCommissionDueMinor`.
- نقاط القيد: `checkout` (ORDER_CREATED), `receivePaymentWebhook` (PAYMENT_CAPTURED / PAYMENT_REFUNDED), `applyTerminalOrderAccounting` (ORDER_COMPLETED/ORDER_CANCELLED + COMMISSION_ACCRUED + SELLER_PAYABLE_DUE), `expireOrderReservation` (ORDER_CANCELLED), `recordRefundObligation`/`resolveRefundObligation` (REFUND_OBLIGATION_OPENED/RESOLVED).

### 4.4 أثر الاسترداد على العمولة (G4 / W07.4)

- `recordCommissionReversal` يحسب الفرق التراكمي `commission(المرتجع بعد) − commission(المرتجع قبل)` بنفس دالة التقريب، فلا انحراف ولا عمولة على مال أُعيد.
- عند الاسترداد بعد الاكتمال: `payments/service.ts` يقيد `COMMISSION_REVERSED` مرتبطًا بقيد `COMMISSION_ACCRUED`. عند استرداد سابق للاكتمال: `order-terminal-accounting.ts` يعكس حصة المبالغ المرتجعة فور الاستحقاق.
- `sellerDues` تبقى سجل الالتزام الأصلي غير القابل للتعديل؛ `/seller-dues` و`/dashboard` يعرضان الصافي بعد الحسومات.
- لا تُحتسب عمولة على طلب ملغى: مسار الإلغاء لا يمر بمنطق الاستحقاق إطلاقًا.

### 4.5 حوافز سلامة المال (W07.6)

- كل المبالغ أعداد صحيحة بالوحدة الصغرى؛ لا عائم ثنائي في أي مسار جديد.
- تكرار القيد آمن بالمفتاح، وكل تعديل قيد جديد وليس تحريرًا لسجل.
- فهارس/قيود صادقة في القاعدة نفسها (وليس في الشيفرة فقط) لكل الثوابت أعلاه.
- ترحيل `0041` مضاف إلى `meta/_journal.json` و`release-manifest.json` (SHA-256: `4403b20e…`)، ومثبّت في `lib/db/src/clone-migration-guard.ts`، ومحدّث في `test/readiness.test.ts` و`test/development-tls.test.ts` (42 مدخلًا).

### 4.6 ما لم يُنفَّذ في W07 ويخص موجات لاحقة

- الدفع النقدي والاسترداد النقدي (W08).
- سجل الكيانات القانونية ودرجات التفعيل وحماية القاصرين (W09).
- بلاغات إجابات AI، الدعم البشري، جاهزية واتساب، إشارات الاحتيال (W10).
- لم يُمسّ أي ملف من ملفات Claude المملوكة (`artifacts/api-server/src/ai/`, `artifacts/dinar/src/pages/Ai.tsx`, عقد Card Envelope، محددات البطاقات).

---

## 5. الاختبارات والحالة

### 5.1 الملف

`artifacts/api-server/test/wave07-financial-journal.test.ts` — 10 اختبارات:

1. حساب العمولة أعداد صحيحة فقط + الاسترداد التراكمي + السقف.
2. لقطة النسبة تحمي الطلب القديم.
3. أساس 10% هو السياسة المنشورة لا ثابتًا خفيًا.
4. سياسة السوق تتغلب على العامة داخل نطاقها فقط.
5. التفعيل لا يعتمد على سعر وحدة تاريخي (سوق نشط بلا سعر + قيد القاعدة).
6. checkout يقيد ORDER_CREATED بلقطة السياسة.
7. إعادة المحاولة بنفس المفتاح لا تكتب قيدًا ثانيًا.
8. الدفتر بالإضافة فقط، ورفض إعادة استخدام المفتاح بحقائق مختلفة، واستحالة UPDATE/DELETE/TRUNCATE حتى مباشرة في القاعدة.
9. الاكتمال يستحق العمولة والمستحق للبائع، ولا مستحق قبل تأكيد المشتري؛ الإلغاء لا يستحق شيئًا.
10. الاسترداد بعد الاكتمال يعكس العمولة ويربط العكس بقيد الاستحقاق.

### 5.2 حالة التشغيل

| المجموعة | الحالة | السبب |
|---|---|---|
| `wave07-financial-journal.test` | **BLOCKED — لم تُشغَّل** | لا `node_modules` في الشجرة، ولا PostgreSQL ولا Docker، ولا توزيعة WSL مثبتة؛ `test/run.mjs` يرفض العمل بلا قاعدة disposable. |
| typecheck / build | **BLOCKED — لم يُشغَّل** | لا مدير حزم/اعتماديات مثبتة محليًا. |
| اختبارات المتصفح | **BLOCKED** | تحتاج خادمًا وقاعدة واعتماديات. |

لا يُدَّعى أي نجاح ديناميكي. ما أُنجز: مراجعة ثابتة للشيفرة، وفحص اتساق أسماء القيود والفهارس بين مخطط Drizzle والترحيل، وإعادة حساب SHA-256 للترحيل بعد كل تعديل، وتحديث كل مثبّتات رأس الترحيل.

### 5.3 أوامر التشغيل المطلوبة عند توفر البيئة (لا تُشغَّل الآن)

```
pnpm install
pnpm --filter @workspace/db run migrate        # على قاعدة loopback disposable
NODE_ENV=development BDINAR_W07_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development \
  BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 BDINAR_DISPOSABLE_TEST_DATABASE=1 \
  node artifacts/api-server/test/run.mjs wave07-financial-journal.test
```

الدفع إلى CI يحتاج إذن المالك الصريح؛ حتى ذلك الحين الفرع محلي فقط ولم يُدفع.
