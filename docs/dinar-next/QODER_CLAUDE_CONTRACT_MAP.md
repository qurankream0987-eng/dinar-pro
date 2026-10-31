# خريطة العقود المشتركة بين Qoder وClaude

**الغرض:** كل سطح يستهلكه أو يتأثر به عمل Claude، بدقة الطلب والاستجابة وخطأ العرض. لا يحتاج Claude إلى أي منطق تجاري جديد؛ يحتاج فقط إلى **عرض صادق** لما يسجله الخادم.

**SHA المرجعي:** `939c64f` — الفرع `qoder/parallel-w07-w12-ultra`.
**القاعدة الحاكمة:** ما لم يُذكر هنا صراحةً، لم يتغير.

---

## 0. ما لم يُمَس (ملكية Claude)

| الملف/المجال | الحالة |
|---|---|
| `artifacts/api-server/src/ai/**` | صفر تغيير |
| `artifacts/dinar/src/pages/Ai.tsx` | صفر تغيير |
| `artifacts/dinar/src/pages/AiChat.css` | صفر تغيير |
| عقد Card Envelope ومحددات البطاقات | صفر تغيير |
| محرك المحادثة الموحد ومحددات السياق | صفر تغيير |
| `lib/api-zod` (OpenAPI المولّد) | صفر تغيير |

---

## 1. السياسات

### `GET /api/policies` و`GET /api/policies/:key`

| الحقل | النوع | المعنى |
|---|---|---|
| `contentSha256` | string (64 hex) | هاش الصياغة الحالية من `lib/policies.ts` |
| `lifecycle` | `NOT_REGISTERED \| DRAFT \| LEGAL_REVIEW \| APPROVED \| PUBLISHED \| SUPERSEDED` | نسخة السجل إن وجدت؛ وإلا `NOT_REGISTERED` |

**قاعدة العرض:** `NOT_REGISTERED` ليست خطأ. لا تعرض «معتمدة» عندما تكون `DRAFT` أو `NOT_REGISTERED`.

### `GET /api/account/policy-consents`

يعيد `required[]`, `optional[]`, `pendingRequired[]`, `materialUpdates[]`, وكل بند يحمل `key`, `version`, `contentSha256`, `lifecycle`, `granted` (`true|false|null`).

- `granted: null` = **لا قرار**، وليس رفضًا.
- `consentEvidence: "EXPLICIT_USER_ACTION_ONLY"` تصريح صريح بأن المصدر فعل مستخدم.

### `POST /api/account/policy-decisions`

```json
{ "key": "terms", "version": "2026-10-02", "decision": "ACCEPTED|DECLINED", "idempotencyKey": "…", "source": "POLICY_REVIEW|API" }
```

| الخطأ | الرمز | العرض |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | إعادة المحاولة لا تُقبل بلا مفتاح |
| 400 | `CONSENT_DECISION_REQUIRED` | القرار غير صريح |
| 404 | `POLICY_NOT_FOUND` | سياسة غير معروفة |
| 409 | `POLICY_VERSION_NOT_CURRENT` / `POLICY_SUPERSEDED` | حدّث الشاشة وأعد القراءة |
| 409 | `IDEMPOTENCY_KEY_REUSED` | المفتاح استُخدم لقرار مختلف |
| 409 | `CONSENT_CONFLICT` | تعارض غير متوقع |

**محظور في الواجهة:**
- إرسال `source` غير القيمتين أعلاه.
- استنتاج الموافقة من نص أو من «فهمت».
- جعل خيار اختياري محددًا افتراضيًا.
- عرض «تم» قبل استجابة الخادم.

---

## 2. البلاغات

### `POST /api/reports`

| الحقل | القيد |
|---|---|
| `targetType` | `LISTING \| USER \| ORDER \| MESSAGE \| AI_ANSWER` |
| `targetId` | معرّف الكيان |
| `reasonCode` | من جدول الأسباب (يشمل الآن `IMPERSONATION`, `COUNTERFEIT`, `INTELLECTUAL_PROPERTY`, `AI_HARMFUL_ANSWER`, `AI_INACCURATE_ANSWER`) |
| `note` | ≤500 حرف لإجابة AI، وحدود أقل لغيره |

استجابة `AI_ANSWER` تحمل:

```json
{ "retention": "IDS_AND_USER_NOTE_ONLY" }
```

**قاعدة العرض:**
- زر «بلّغ عن هذه الإجابة» يرسل `targetType: "AI_ANSWER"` و`targetId` معرّف الرسالة، **بلا نص الإجابة**.
- البلاغ **لا يوقف** الإجابة ولا الحساب؛ لا تقل «تمت المعالجة».
- إن أردت عرض «بلاغك قيد المراجعة البشرية» فهذا صحيح.

البلاغ عن رسالة يعمل فقط لرسالة الطرف الآخر في محادثة طلب يملكها المبلّغ. محاولة غير ذلك تُعيد 404 (لا 403) لتجنّب كشف الوجود.

---

## 3. الدعم

| المسار | الاستجابة الأساسية |
|---|---|
| `POST /api/account/support/cases` | `{ case: { id, status: "OPEN", … } }`؛ `429 SUPPORT_LIMIT` عند 20/يوم |
| `GET /api/account/support/cases` | حالات المستخدم فقط |
| `GET /api/account/support/cases/:id` | المالك أو الفريق؛ غير ذلك 404 |
| `POST /api/account/support/cases/:id/messages` | `{ status: "AWAITING_STAFF" }`؛ `409 CASE_CLOSED` على المغلقة |

**قواعد العرض:**
- `CLOSED` نهائية: لا زر إرسال، ولا إعادة فتح.
- `AWAITING_USER` تعني «بانتظار ردك».
- الملاحظات الداخلية لا تصل للمستخدم أصلًا؛ لا حاجة لإخفائها في العميل (لكن لا تعتمد على ذلك وحدك).
- `GET /admin/*` ليست للواجهة العامة؛ 403 متوقّع.

**حالة الطلب في الدعم:** `OPEN → AWAITING_STAFF ↔ AWAITING_USER → RESOLVED → CLOSED`، مع أولوية `LOW/NORMAL/HIGH/URGENT` وفئة من سبع.

---

## 4. واتساب (جاهزية فقط)

### `GET /api/account/whatsapp/consent`

```json
{ "status": "NO_DECISION|GRANTED|REVOKED", "liveSends": false }
```

### `POST /api/account/whatsapp/consent`

```json
{ "decision": "GRANTED|REVOKED", "source": "IN_APP|SUPPORT", "phone": "…" }
```

- المصدر من الخادم/واجهة المستخدم داخل التطبيق فقط.
- لا `source: "CARD"` ولا `"MODEL"`؛ 400.
- لا يوجد إرسال؛ لا تعرض «أرسلنا لك واتساب».

### `POST /api/admin/whatsapp/intents`

يعيد `decision` من:
`READY_TO_SEND | BLOCKED_NO_CONSENT | BLOCKED_TEMPLATE_NOT_APPROVED | BLOCKED_TEMPLATE_DISABLED | BLOCKED_PROVIDER_UNAVAILABLE | BLOCKED_PAYLOAD_INVALID`
و`sent: false` دائمًا.

---

## 5. النقد في الطلب

بعد إقرار البائع:

```
orders.data.paymentMode = "CASH_DIRECT"
orders.data.selectedPaymentMethod = "CASH_DIRECT"
orders.data.cashPayment = {
  claimId, amountMinor, currencyCode, confirmedAt,
  verification: "SELLER_ATTESTED"
}
```

| قيمة `verification` | معناها |
|---|---|
| `UNVERIFIED_BUYER_CLAIM` | المشتري يقول إنه دفع |
| `SELLER_ATTESTED` | البائع أقر بالاستلام |
| `SELLER_DENIED` | البائع أنكر |
| `BUYER_DISPUTED` | المشتري اعترض |

**قاعدة العرض:** لا تقل «دفعة مؤكدة» أو «تم الدفع» عند `UNVERIFIED_BUYER_CLAIM`. الصياغة الصحيحة: «ادعاء دفع بانتظار إقرار البائع». وبعد `SELLER_ATTESTED`: «أقرّ البائع باستلام النقد» — لا «المنصة استلمت».

مسارات النقد كلها 404 خارج `NODE_ENV=development`؛ تعامل مع 404 كـ«غير متاح في هذه البيئة».

---

## 6. العمولة والمستحقات

- `orders.data.commissionPolicy` يحمل لقطة السياسة (المفتاح، الإصدار، `rateBasisPoints`، الأساس).
- `sellerDues` لم تُعدّل؛ الصافي = `sellerDues` − `COMMISSION_REVERSED`.
- لا تعرض «عمولة 10%» كقيمة ثابتة في الواجهة؛ اقرأ اللقطة من الطلب. الطلب القديم قد يحمل نسبة أقدم.

---

## 7. بوابات الشراء والنشر (أخطاء يجب عرضها كحالات، لا كأعطال)

| الرمز | متى | الصياغة المقترحة |
|---|---|---|
| `SELLER_VERIFICATION_REQUIRED` | توثيق البائع مفعّل والسوق يطلبه | «هذا البائع لم يكمل التوثيق بعد» |
| `AGE_DECLARATION_REQUIRED` | الحماية الأصغرية مفعّلة وبلا إقرار | «يلزم إقرار العمر للمتابعة» |
| `MINOR_COMMERCE_BLOCKED` | قاصر بلا مسار مسموح | «الشراء غير متاح لهذا الحساب» |
| `GUARDIAN_CONSENT_REQUIRED` / `GUARDIAN_CONSENT_DENIED` | بلا موافقة ولي أو برفضها | «يلزم قرار ولي الأمر» |
| `COMMERCIAL_CAPABILITY_NOT_ACTIVATED` | السوق فعّل بوابة الكيان ولم تُمنح القدرة | «هذا السوق غير مفعّل تجاريًا بعد» |
| 404 على `/cash*` | بيئة غير تطوير | «الدفع النقدي غير متاح هنا» |
| `ADMIN_ONLY` (403) | مستخدم عادي على `/admin/*` | لا تعرض الواجهة أصلًا |

---

## 8. الإشعارات

قالب جديد: `SUPPORT_CASE_UPDATED { caseId, status }`.

- إن كان عارض الإشعارات يستخدم قائمة بيضاء، أضف المفتاح.
- لا تعرض تفاصيل داخلية من إشعار؛ الحقول المذكورة فقط.

---

## 9. حدود العقد

1. **لا تنفّذ منطقًا تجاريًا في العميل**: لا حساب عمولة، لا أهلية، لا عقوبة.
2. **لا تخترع حالات**: إن لم يعد الخادم الحقل، لا تعرضه.
3. **لا تعدّل مسارات Qoder** أثناء تكامل Claude؛ بل أعلن الفجوة وسجّلها.
4. **لا تقرأ قاعدة البيانات مباشرة** من الواجهة لتجاوز بوابة.
5. **لا تفعّل إرسالًا خارجيًا** (واتساب/بريد/دفع) استنادًا إلى نيّة مسجّلة؛ النيّة ليست إرسالًا.

---

## 10. مصفوفة «ماذا أرسل / ماذا أتوقع» السريعة

| البطاقة | الطلب | الاستجابة الحاسمة | الخطأ الشائع |
|---|---|---|---|
| `POLICY_REVIEW` | `POST /account/policy-decisions` | `201` + الحدث | عرض الموافقة قبل الاستجابة |
| `REPORT_AI_ANSWER` | `POST /reports` `AI_ANSWER` | `retention` | إرسال نص الإجابة |
| `SUPPORT_CASE` | `POST /account/support/cases` | `status: OPEN` | فتح أكثر من 20/يوم |
| `WHATSAPP_OPT_IN` | `POST /account/whatsapp/consent` | `GRANTED` | استنتاج الموافقة من الرسالة |
| `CASH_ORDER` | `POST /orders/:id/cash-payment/claim` | `verification: UNVERIFIED_BUYER_CLAIM` | تسميته «مدفوع» |
| `ORDER_SUMMARY` | `GET /orders/:id` | `data.cashPayment` إن وجد | تجاهل `verification` |
| `SELLER_PAYOUT` | `sellerDues` + الدفتر | الصافي بعد العكس | عرض الإجمالي كصافي |
