# DINAR NEXT — الموجة 08: الدفع، الاسترداد، والتسليم

**الفرع:** `qoder/parallel-w07-w12-ultra`
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873` + W07 (`09e8941`)
**بيئة العمل:** `D:\DINAR\dinar-w0712`
**الحالة:** التنفيذ مكتوب ومراجَع ستاتيكيًا. **التشغيل الفعلي BLOCKED** لغياب `node_modules` وPostgreSQL محليًا، ورفض النشر إلى CI دون إذن المالك. لا اختبار أخضر مُختلق.

> **قاعدة الصدق:** كل ادعاء هنا يقابل ملفًا وسطرًا. كل حالة اختبار لم تُشغَّل معلَّنة صراحةً كـ **BLOCKED**. النقد هنا لا يتحرك عبر DINAR، ولا يوجد محفظة أو ضمان أو تفعيل إنتاجي.

---

## 1. مقارنة معمار الدفع A / B / C

| الخيار | الوصف | المتطلبات | الموقف |
|---|---|---|---|
| **A — المنصة تحتفظ بالمال** | المشتري يدفع للمنصة، ثم تُسوّي للبائع | حجز أموال، تراخيص مالية، التزامات AML/KYC، تسوية وبنوك | **غير منفّذ وغير مصرّح به.** لا محفظة ولا escrow. |
| **B — المشتري يدفع للبائع مباشرة + عمولة منفصلة** | النقد ينتقل مباشرة، والمنصة تتابع العمولة كالتزام | إثبات استلام من الطرف المقابل، استرداد منفصل، تسوية عمولة | **هذا ما تنفّذه W08 كسجل إثبات فقط.** تفضيل المالك الحالي، وليس معمارًا نهائيًا معتمدًا. |
| **C — مزود دفع يستضيف التجزئة** | Stripe Connect / Adyen for Platforms وغيرها | عقد مزود، تراخيص، KYC، webhooks، تسوية | **غير متصل.** سجل القدرات يعلن `providerConnected: false` و`electronic.available: false`. |

اختيار B هنا **لا يعني** أن المنصة أصبحت طرفًا في نقل النقد. كل ما تفعله W08 هو تسجيل ادعاءات وإقرارات أطراف، مع منع أي قفزة من «ضغط زر» إلى «دفعة مؤكدة».

---

## 2. REUSE — ما لم يُعد بناؤه

| القدرة | المالك القائم | الاستخدام في W08 |
|---|---|---|
| عقد مزود الدفع والتوقيع | `artifacts/api-server/src/lib/payments/contracts.ts` | لم يُلمس. النقد لا يمر عبره. |
| محول الاختبار `SIMULATION_ONLY` | `lib/payments/test-adapter.ts` | يبقى للدفع الإلكتروني التجريبي فقط. |
| نواة الدفع والتكرار والاسترداد | `lib/payments/service.ts` | لم تُعدّل في W08. |
| التزامات الاسترداد | `lib/payments/obligations.ts` + `0040_refund_obligations` | تبقى سلطة الدفع الإلكتروني. |
| الدفتر المالي | `lib/order-journal.ts` + `0041_wave07_financial_journal` | يُستخدم ككاتب وحيد للقيود، مع قيد `PAYMENT_CAPTURED` عند إقرار البائع فقط. |
| آلة حالة الطلب والتسليم | `routes/marketplace.ts` + `lib/delivery.ts` | لم تُعدّل. النقد لا يغيّر انتقالات الطلب. |
| سجل قدرات السوق | `lib/market-capability-registry.ts` | صار يعلن حقيقة محرك النقد بدل الادعاء بأن السياسة وحدها = إتاحة. |

---

## 3. الفجوات التي عالجتها W08

| # | الفجوة | العلاج |
|---|---|---|
| G8.1 | لا يوجد أي مسار نقدي؛ وادعاء المشتري غير مفصول عن إثبات البائع | جدول `cash_payment_claims` + محرك `lib/payments/cash.ts` بآلة حالة `CLAIMED → CONFIRMED / DENIED / DISPUTED`، وإقرار البائع وحده هو ما يُسجَّل `PAYMENT_CAPTURED`. |
| G8.2 | الاسترداد النقدي غير موجود، والاسترداد الإلكتروني لا يصلح للنقد | محرك استرداد نقدي **منفصل** بجدول `cash_refund_cases`؛ الحالة توجد `OPEN` قبل أي سداد، وادعاء البائع بالسداد يبقى غير مؤكد حتى يؤكد المشتري الاستلام. |
| G8.3 | سجل القدرات كان يعلن `cashDirect.available` بمجرد سياسة السوق | أضيف `engineImplemented` و`environment`، وصار `available` في `development` فقط؛ الإنتاج يعيد `UNAVAILABLE`. |
| G8.4 | استرداد نقدي مؤكد قبل الإتمام لا يخفّض العمولة عند الإتمام | `order-terminal-accounting.ts` يجمع الاستردادات النقدية المؤكدة ويقيّد `COMMISSION_REVERSED` عند الاكتمال، مع منع تداخل المسار الإلكتروني والنقدي. |

---

## 4. التنفيذ

### 4.1 البيانات والقيود

- `lib/db/src/schema/index.ts:1447` — `cashPaymentClaims`: طلب فريد لكل طلب، مفتاح تكرار لكل مشتري، مبالغ صحيحة بالوحدة الصغرى، عملة ISO، حالة مقيدة، و`decision_valid` يمنع قرارًا بلا فاعل أو وقت.
- `lib/db/src/schema/index.ts:1501` — `cashRefundCases`: حالة استرداد مستقلة مرتبطة بـ`payment_claim_id`، مع أزمنة السداد وتأكيد المشتري والنزاع والسحب.
- `lib/db/drizzle/0042_wave08_cash_engines.sql:1` و`:25` — الجدولان والقيود.
- `lib/db/drizzle/0042_wave08_cash_engines.sql:69` — `cash_payment_claims_guard`: يرفض DELETE/TRUNCATE، يثبّت وقائع الادعاء (الطلب، الطرفان، المبلغ، العملة، المفتاح)، ويسمح فقط بـ`CLAIMED → CONFIRMED/DENIED/DISPUTED` و`DENIED → CONFIRMED/DISPUTED`، ويشترط أن يكون القرار من البائع أو الاعتراض من المشتري.
- `lib/db/drizzle/0042_wave08_cash_engines.sql:128` — `cash_refund_cases_guard`: يرفض DELETE/TRUNCATE، يثبّت وقائع الحالة، ويسمح فقط بـ`OPEN → REPAYMENT_CLAIMED/WITHDRAWN` و`REPAYMENT_CLAIMED → CONFIRMED/DISPUTED`، ويمنع إعادة كتابة ادعاء السداد، ويشترط فتح الحالة من أحد طرفي الطلب، ويرفض عند الإدراج أي حالة تجعل **المجموع التراكمي** (OPEN + REPAYMENT_CLAIMED + CONFIRMED + DISPUTED) يتجاوز الدفعة النقدية المؤكدة.

### 4.2 محرك النقد

`artifacts/api-server/src/lib/payments/cash.ts`:

| الدالة | السطر | السلوك |
|---|---|---|
| `cashEngineEnabled` | 27 | `NODE_ENV=development` وبلا `REPLIT_DEPLOYMENT`. |
| `claimCashPayment` | 149 | المشتري فقط، بعد قبول البائع، في سوق يسمح بـ`CASH_DIRECT`، وبلا مسار إلكتروني معلّق/محصّل. يُنشئ `CLAIMED` فقط، **ولا يكتب أي قيد دفع**. |
| `confirmCashPayment` | 225 | البائع فقط. يحوّل إلى `CONFIRMED`، يثبّت `paymentMode/selectedPaymentMethod/cashPayment` على الطلب، ويكتب `PAYMENT_CAPTURED` بمصدر `CASH_DIRECT_SELLER_CONFIRMATION`. |
| `denyCashPayment` | 309 | البائع فقط، بسبب إلزامي. لا قيد مالي. |
| `disputeCashPayment` | 340 | المشتري فقط، بسبب إلزامي. لا قيد مالي. |
| `cashForOrder` | 371 | قراءة للأطراف فقط؛ الغريب يحصل على 404. |

### 4.3 محرك الاسترداد النقدي

| الدالة | السطر | السلوك |
|---|---|---|
| `openCashRefundCase` | 400 | يفتح `OPEN` قبل أي سداد، بعد دفع نقدي مؤكد، ويحجز المبالغ المفتوحة لمنع التجاوز. |
| `claimCashRefundRepayment` | 499 | البائع يدّعي السداد فقط؛ يبقى `REPAYMENT_CLAIMED` بلا قيد استرداد. |
| `confirmCashRefundReceipt` | 537 | المشتري وحده يؤكد الاستلام؛ عندها فقط يُقيَّد `PAYMENT_REFUNDED`، ويُعدَّل وسم العمولة إذا كان الطلب مكتملًا. |
| `disputeCashRefundRepayment` | 610 | اعتراض المشتري على ادعاء السداد؛ لا ينتج استردادًا. |
| `withdrawCashRefundCase` | 642 | سحب الحالة `OPEN` بواسطة من فتحها فقط. |
| `confirmedCashRefundTotalMinor` | 669 | مجموع الاستردادات المؤكدة، لتسوية الإتمام. |

### 4.4 المسارات

`artifacts/api-server/src/routes/cash.ts` — كلها محمية بـ`requireAuth` وبوابة تطوير 404:

| المسار | السطر |
|---|---|
| `POST /orders/:id/cash-payment/claim` | 78 |
| `POST /orders/:id/cash-payment/confirm` | 96 |
| `POST /orders/:id/cash-payment/deny` | 112 |
| `POST /orders/:id/cash-payment/dispute` | 127 |
| `GET /orders/:id/cash` | 142 |
| `POST /orders/:id/cash-refunds` | 150 |
| `POST /cash-refunds/:id/repayment-claim` | 169 |
| `POST /cash-refunds/:id/confirm` | 185 |
| `POST /cash-refunds/:id/dispute` | 198 |
| `POST /cash-refunds/:id/withdraw` | 213 |

### 4.5 حقيقة القدرات

`artifacts/api-server/src/lib/market-capability-registry.ts:338` — `cashDirect` صار:

```
marketPolicyEnabled: سياسة السوق فقط
engineImplemented: true
environment: DEVELOPMENT_ONLY | UNAVAILABLE
available: السياسة && البيئة development
```

النتيجة: في الإنتاج لا يظهر النقد كمتاح حتى لو بقيت السياسة التاريخية في السوق. `electronic.available` بقي `false` و`providerConnected: false`.

### 4.6 محاسبة الإتمام

`artifacts/api-server/src/lib/order-terminal-accounting.ts:109` — بعد ترحيل الاكتمال، إذا وُجدت استردادات نقدية مؤكدة قبل الإتمام، يُكتب `COMMISSION_REVERSED` مربوط بالاستحقاق. المسار الإلكتروني القائم يبقى كما هو، والنقد والدفع الإلكتروني لا يجتمعان لأن الادعاء النقدي يُرفض عند وجود intent غير فاشل.

---

## 5. آلة حالة النقد

| الحالة | المعنى | من ينقلها | القيد المالي |
|---|---|---|---|
| `CLAIMED` | المشتري يقول إنه دفع؛ **ليس إثباتًا** | المشتري | لا شيء |
| `CONFIRMED` | البائع يقر باستلام النقد | البائع | `PAYMENT_CAPTURED` |
| `DENIED` | البائع ينكر الاستلام | البائع | لا شيء |
| `DISPUTED` | المشتري يعترض على النتيجة | المشتري | لا شيء |

`verification` في الواجهة يعلن `UNVERIFIED_BUYER_CLAIM` / `SELLER_ATTESTED` / `SELLER_DENIED` / `BUYER_DISPUTED` صراحةً.

## 6. آلة حالة الاسترداد النقدي

| الحالة | المعنى | من ينقلها | القيد المالي |
|---|---|---|---|
| `OPEN` | حالة استرداد قائمة قبل أي سداد | المشتري أو البائع | لا شيء |
| `REPAYMENT_CLAIMED` | البائع يدّعي أنه سدّد نقدًا | البائع | لا شيء |
| `CONFIRMED` | المشتري يؤكد استلام السداد | المشتري | `PAYMENT_REFUNDED` + تعديل عمولة إن كان الطلب مكتملًا |
| `DISPUTED` | المشتري ينكر استلام السداد | المشتري | لا شيء |
| `WITHDRAWN` | سحب الحالة قبل السداد | من فتحها | لا شيء |

الحجز يمنع مجموع `OPEN + REPAYMENT_CLAIMED + CONFIRMED + DISPUTED` من تجاوز المبلغ النقدي المؤكد. الحالة `DISPUTED` تبقى محجوزة لأن المال قد يكون تحرك فعلًا ولم يُحسم النزاع بعد، ولا يحررها إلا سحب الحالة `OPEN` أو حسم بشري لاحق عبر مسار النزاعات. الاسترداد الجزئي المتكرر مسموح ضمن هذا السقف، وطبقة قاعدة البيانات تفرض السقف التراكمي نفسه حتى لو كُتب الإدراج خارج المحرك.

---

## 7. اختبارات القبول

`artifacts/api-server/test/wave08-cash-and-refunds.test.ts` — **13 اختبارًا**:

1. النقد منفّذ لكن متاح في بيئة التطوير فقط، وسياسة السوق وحدها لا تكفي.
2. ادعاء المشتري ادعاء غير مؤكد ولا ينتج قيد دفع.
3. البائع وحده يقرر، والمشتري وحده يعترض، والغريب لا يرى الطلب.
4. إقرار البائع هو الإثبات الوحيد، وهو idempotent ولا يكرر القيد.
5. الادعاء idempotent ومقيّد بالطلب، ويُرفض عند وجود intent إلكتروني.
6. وقائع الادعاء غير قابلة للتعديل، والحذف والـTRUNCATE مرفوضان.
7. حالة الاسترداد توجد قبل أي سداد.
8. الاسترداد idempotent ولا يتجاوز النقد المؤكد؛ السحب يحرر الحجز.
9. ادعاء سداد البائع يبقى غير مؤكد حتى يؤكد المشتري.
10. النزاع على السداد لا يسجل استردادًا، ويبقى محتجزًا ضد أي استرداد جديد.
11. السحب يحرر المبلغ المحجوز.
12. الإتمام يعكس العمولة للاستردادات المؤكدة قبله وبعده.
13. انتقالات الاسترداد ووقائعه لا يمكن تزويرها بقاعدة البيانات، بما في ذلك تجاوز السقف التراكمي بإدراج خام.

الأوامر (لم تُشغَّل هنا):

```
pnpm --filter @workspace/api-server test:w08
pnpm --filter @workspace/api-server test:w07
pnpm --filter @workspace/api-server test:financial-state-machine
pnpm --filter @workspace/api-server test:readiness
pnpm --filter @workspace/api-server test:development-tls
```

### حالة التشغيل

**BLOCKED.** لا يوجد `node_modules` في `D:\DINAR\dinar-w0712`، ولا PostgreSQL/Docker/WSL على المضيف. تشغيل CI يتطلب دفع الفرع، وهذا ممنوع دون إذن صريح من المالك. لذلك لم يُشغَّل أي اختبار، ولم يُدَّعَ أي نجاح.

---

## 8. ما لم يُبنَ (حتى لا يُفهم كتفعيل)

- لا محفظة ولا رصيد مشترٍ ولا escrow؛ المال لا يتحرك داخل DINAR.
- لا دفع بطاقة حقيقي، ولا مزود متصل، ولا أرقام PAN/CVV.
- لا chargeback نقدي آلي؛ النزاعات النقدية تبقى `DISPUTED` للمراجعة البشرية.
- لا تفعيل تجاري في أي سوق إنتاجي؛ بوابة النقد تعيد 404 خارج بيئة التطوير.
- لا تغيير على `main`، ولا دفع إلى remote، ولا نشر.

---

## 9. اختبارات قائمة يُعاد استخدامها في W11

| المجموعة | ما تغطيه |
|---|---|
| `financial-state-machine.test.ts` | توقيع مزيف، تكرار webhook، عملة/مبلغ/refund مختلف، over-refund، تزامن، ازدواج التسليم. |
| `payment-order-state.test.ts` | حالة الطلب وربط الدفع. |
| `wave4-payment-acceptance.test.ts` | قبول الدفع التجريبي. |
| `r5-delivery-economics.test.ts` | اقتصاد التسليم. |
| `wave07-financial-journal.test.ts` | الدفتر والعمولة. |

هذه لم تُشغَّل في W08، وتُدرَج في W11 كمجموعة انحدار لازمة.

---

## 10. ملفات W08

**جديدة**
- `artifacts/api-server/src/lib/payments/cash.ts`
- `artifacts/api-server/src/routes/cash.ts`
- `artifacts/api-server/test/wave08-cash-and-refunds.test.ts`
- `lib/db/drizzle/0042_wave08_cash_engines.sql`
- `docs/dinar-next/QODER_W08_ULTRA_REPORT.md`

**معدّلة**
- `lib/db/src/schema/index.ts`
- `lib/db/drizzle/meta/_journal.json`
- `lib/db/drizzle/release-manifest.json`
- `lib/db/src/clone-migration-guard.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/api-server/src/lib/market-capability-registry.ts`
- `artifacts/api-server/src/lib/order-terminal-accounting.ts`
- `artifacts/api-server/test/safe-development-database.ts`
- `artifacts/api-server/test/readiness.test.ts`
- `artifacts/api-server/test/development-tls.test.ts`
- `artifacts/api-server/package.json`

---

## 11. أثر على عمل Claude

- لم يُلمس أي ملف من ملفات Claude المملوكة (`artifacts/api-server/src/ai/` أو `artifacts/dinar/src/pages/Ai.tsx`).
- الطلب قد يحمل الآن `data.paymentMode = "CASH_DIRECT"` و`data.selectedPaymentMethod = "CASH_DIRECT"` و`data.cashPayment` بعد إقرار البائع. أي بطاقة محادثة تقرأ طريقة الدفع يجب أن تعرض هذا كـ«إقرار بائع» لا كـ«دفعة مؤكدة من المنصة».
- محرك الدفع الإلكتروني القائم لم يتغير، وبقيت كل افتراضات `SIMULATION_ONLY` كما هي.
