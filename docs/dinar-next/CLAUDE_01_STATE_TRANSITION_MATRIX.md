# DINAR — Claude 01: مصفوفة انتقالات الحالة المالية

**الأساس:** `claude/00-baseline` بعد commits ‏`75c619e` و`51b24a0`. كل خلية فيها "اختبار" تشير إلى اختبار حتمي يقرأ الحالة من PostgreSQL، لا من رد HTTP.
**الأقفال:** كل انتقال يقفل صف الطلب أولاً (`FOR UPDATE`) ثم الـintent ثم صفوف المخزون. الترتيب واحد في الإلغاء، والانتهاء (`skip locked`)، والقبول، والالتقاط، والنزاع، فلا يحدث تبادل أقفال (deadlock)، وتتسلسل كل العمليات على الطلب الواحد.
**الاستمرارية:** منع التكرار مخزّن في PostgreSQL عبر فهارس فريدة:
- `payment_events (provider_key, provider_event_id)`
- `payment_intents (buyer_id, idempotency_key)`
- `payment_refunds (intent, idempotency_key)`
- `payment_refund_obligations (payment_intent_id)` و`(source_payment_event_id)`

لذلك يصمد منع التكرار بعد إعادة تشغيل العملية، ويثبت ذلك اختبار *durable idempotency*.

## الحالات القابلة للوصول (بلا نزاع)

| رمز | الطلب | الحجز | intent | الالتقاط | الالتزام |
|---|---|---|---|---|---|
| S1 | CREATED | محجوز، ساري | لا يوجد | — | — |
| S2 | CREATED | محجوز، ساري | SIMULATION_PENDING | 0 | — |
| S3 | CREATED | محجوز، ساري | SIMULATION_CAPTURED | كامل | — |
| S4 | CREATED | منتهٍ، لم يمر عليه sweep | PENDING أو CAPTURED | 0 أو كامل | — |
| S5 | CANCELLED | محرَّر | لا يوجد أو PENDING | 0 | — |
| S6 | CANCELLED | محرَّر | SIMULATION_BUYER_REFUND_DUE | كامل | OPEN |
| S7 | CANCELLED | محرَّر | SIMULATION_BUYER_REFUND_DUE (استرداد جزئي) | كامل | OPEN |
| S8 | CANCELLED | محرَّر | SIMULATION_REFUNDED | كامل | RESOLVED |
| S9 | ACCEPTED / IN_PROGRESS | محجوز | PENDING أو CAPTURED | | — |
| S10 | SELLER_MARKED_DELIVERED | محجوز | PENDING أو CAPTURED | | — |
| S11 | COMPLETED | مستهلَك | PENDING أو CAPTURED | | — (+ seller due واحد) |

مع نزاع (مسار Wave 4 القائم، لم يتغير):
- **D-OPEN:** الطلب DISPUTED والـintent ‏SIMULATION_DISPUTED.
- **D-BUYER:** الطلب CANCELLED والـintent ‏SIMULATION_BUYER_REFUND_DUE، **بلا** صف التزام؛ تدقيقه في `payment_dispute_events`.
- **D-SELLER:** الطلب COMPLETED والـintent ‏SIMULATION_SELLER_RELEASE_DUE.

## الأحداث

| الحدث | من | النتيجة | الاختبار |
|---|---|---|---|
| **انتهاء الحجز** (sweep) | S1, S2 | → S5. المخزون يُحرَّر مرة واحدة | `seller acceptance racing expiry` |
| | S3, S4(مدفوع) | → S6، التزام `RESERVATION_EXPIRED` مرتبط بحدث الالتقاط | `D3 / case 3–4` |
| | S5–S11 | لا شيء (الـsweep يختار CREATED فقط) | `case 5` |
| **انتهاء متكرر أو متزامن** | S6 | التزام واحد فقط (فهرس فريد + قفل) | `case 5` |
| **قبول البائع** | S1–S3 | → S9 | `case 12` |
| | S4 | يُعامل كانتهاء ويرجع خطأ؛ لا قبول | `seller acceptance racing expiry` |
| | S5–S8 | 409 | `case 7` |
| **قبول متكرر** | S9 | 409 | `seller acceptance racing expiry` |
| **إلغاء المشتري أو البائع** | S1, S2 | → S5 | `seller cancellation` |
| | S3 | **409** (D2) | `payment-order-state` D2، `seller cancellation` |
| | S5–S11 | 409 | `case 7` |
| | (غريب) | 404 | `seller cancellation` |
| **نجاح الدفع** (CAPTURE_SUCCEEDED) | S2 | → S3 | `case 12` |
| | S4 (PENDING) | يُلغى الطلب في نفس المعاملة ← S6 (`RESERVATION_EXPIRED`) | `case 1b` |
| | S5 (PENDING) | يُسجَّل كدليل ← S6 (`CAPTURE_AFTER_CANCELLATION`)؛ 200 للمزود؛ **لا** يُعامل كبيع | `case 1` |
| | S9, S10 | → CAPTURED | (Wave 4) |
| | D-OPEN | مسار النزاع القائم | `wave4-payment-acceptance` |
| | مبلغ أو عملة مختلفة | 409 | `commerce-journey` |
| **رد دفع متأخر** | S5, S4 | كما سبق | `case 1`, `case 1b` |
| **رد مكرر** (نفس الحدث) | أي حالة | `duplicate:true`، لا تغيير | `case 12`، `payment-order-state` |
| | معرف حدث مُعاد استخدامه بمحتوى آخر | 409 | (Wave 4) |
| **فشل الدفع** | S2 | لا يوجد حدث فشل موقّع في العقد؛ الرفض يظهر فقط في التسوية (MISMATCH)، والـintent يبقى PENDING والطلب ينتهي طبيعياً | `case 15` |
| **بدء الاسترداد** (إدارة) | S3, S9–S11 | مسموح كما كان (CAPTURED أو PARTIALLY_REFUNDED) | (Wave 4) |
| | S6, S7 | **مسموح الآن** للالتزام غير المرتبط بنزاع | `REFUND_DUE resolves…` |
| | D-OPEN, D-BUYER | 409، يتطلب مزوداً معتمداً | `a disputed payment cannot…` |
| | مبلغ أكبر من الرصيد | 409 | `REFUND_DUE resolves…` |
| | مستخدم عادي | 403 | `case 6 / 8` |
| **تأكيد الاسترداد** (REFUND_SUCCEEDED) | S6 بمبلغ كامل | → S8، الالتزام RESOLVED بمعرف الحدث | `REFUND_DUE resolves…` |
| | S6 بمبلغ جزئي | → S7 (يبقى OPEN) | (منطق `nextStatus`) |
| | استرداد غير مطلوب، أو لـintent آخر، أو بمبلغ أو عملة مختلفة، أو توقيع مزوّر | 409 أو 401، والالتزام يبقى OPEN | `case 6 / 8`, `case 8b` |
| **فشل الاسترداد** (REFUND_FAILED) | S6 | طلب الاسترداد FAILED، والـintent والالتزام بلا تغيير، وإعادة المحاولة متاحة | `REFUND_DUE resolves…` |
| **إعادة محاولة الاسترداد** | S6 | نفس المفتاح ← نفس الاسترداد؛ مفتاح جديد بعد FAILED ← طلب جديد | `REFUND_DUE resolves…` |
| **تأكيد الاسترداد ↔ تكراره** | S6 | تسوية واحدة، وصل `duplicate:false` مرة واحدة | `refund confirmation racing…` |
| **اكتمال الطلب** | S10 | → S11 مع seller due واحد | `case 12` |
| | S5–S8 | 409، بلا seller due | `case 7` |
| **تأكيد استلام متكرر** | S11 | 200، وseller due واحد | `case 12` |
| **نزاع التسليم** | S10 | → D-OPEN | `a disputed payment cannot…`, Wave 4 |
| **محو الالتزام** | S6–S8 | DELETE / TRUNCATE / تعديل المبلغ / RESOLVED بلا حدث كلها مرفوضة على مستوى DB؛ ولا يوجد مسار API | `case 14` |

## السباقات المطلوبة

| السباق | الآلية | الإثبات |
|---|---|---|
| الالتقاط ↔ إلغاء الطلب | كلاهما يقفل صف الطلب. الإلغاء يرى الالتقاط فيرفض بـ409، أو الالتقاط يرى الإلغاء فيُنشئ التزاماً | `case 2` (8 جولات متزامنة) |
| الالتقاط ↔ انتهاء الحجز | الـsweep يتخطى الصف المقفول؛ والالتقاط يُلغي في معاملته؛ والـsweep اللاحق لا يرى CREATED | `capture racing the expiry sweep` (5 جولات) |
| قبول البائع ↔ الانتهاء | قفل الطلب، ومسار القبول يُنهي المنتهي، والمخزون لا يصير سالباً | `seller acceptance racing expiry` |
| رد الاسترداد ↔ إعادة المحاولة | قفل الـintent وصف الاسترداد، وفهرس فريد على الحدث | `refund confirmation racing…` |
| إعادة نفس طلب الـintent بالتوازي | إعادة فحص المفتاح بعد قفل الطلب (**أُصلح**) | `case 11` |
| آخر قطعة لعدة مشترين | قفل العرض و`reservedQuantity` | `case 10` |
| فشل داخل المعاملة | كل الانتقال في معاملة واحدة، والتراجع كامل | `case 13` |

## حدود معروفة

- لا يوجد حدث `PAYMENT_FAILED` موقّع؛ الرفض يظهر في التسوية فقط.
- استرداد إداري لطلب **نشط** (S3/S9/S10) لا يغيّر دورة الطلب؛ يمكن أن يكتمل الطلب بعد استرداد كامل فينشأ seller due (عمولة) على بيع مُسترد. قرار سياسة للمالك.
- `D-BUYER` (نزاع لصالح المشتري) يبقى بلا صف التزام ولا مسار استرداد حتى ربط مزود حقيقي؛ هذا سلوك Wave 4 القائم ولم يُغيَّر.
