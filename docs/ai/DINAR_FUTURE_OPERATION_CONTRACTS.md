# DINAR — عقود العمليات القادمة (لـQoder W07–W12)

**الملف:** `src/ai/operation-contracts.ts`.

**الاختبار:** `test/operation-contracts.test.ts` (5/5) مع بديل اختبار في الذاكرة.

**لا backend مالي ولا استرداد ولا سياسات ولا دعم بُني هنا.** لا شيء سُجّل في `ACTION_REGISTRY`، فلا قدرة جديدة في المحادثة.

## العمليات

| العملية | الهدف المسموح |
|---|---|
| `REFUND_REQUEST` | ORDER |
| `PAYOUT_STATUS` | ACCOUNT |
| `POLICY_REACCEPTANCE` | POLICY |
| `SUPPORT_CASE` | ORDER، LISTING، ACCOUNT |
| `DISPUTE_OPEN` | ORDER |

## العقد

```ts
interface OperationAuthority {
  operation: FutureOperation;
  review(request): Promise<OperationReview | OperationRefusal>;   // قراءة فقط
  submit(review, confirmation: UserConfirmation): Promise<OperationReceipt | OperationRefusal>; // الكتابة الوحيدة، متكررة الأثر بالمفتاح
}
```

## القواعد التي لا يتجاوزها أي تطبيق

1. **`parseOperationRequest`:** الطلب مراجع وهوية فقط. أي مبلغ، أو عملة، أو رسوم، أو حالة، أو موافقة يُرفض، أيًا كان مصدره: العميل، أو النموذج، أو خدمة أخرى (OC-02).
2. **`UserConfirmation` مختوم بنوع خاص:** لا يصنعه إلا `confirmationFromUser`. يشترط:
   - ردًا إيجابيًا قصيرًا من المستخدم نفسه،
   - على المراجعة نفسها،
   - قبل انتهائها.

   «لا»، أو «نعم لكن غيّر المبلغ»، أو مستخدم آخر، أو مراجعة أخرى أو منتهية: لا تأكيد (OC-03). النموذج لا يستطيع إنتاجه: `canonicalRequest` لا يكون قرارًا أبدًا.
3. **`submitConfirmedOperation`** يرفض قبل الوصول إلى الجهة المختصة:
   - دون تأكيد مطابق: `UNCONFIRMED`.
   - بعد انتهاء المراجعة: `EXPIRED`.

   والتكرار يعيد الإيصال الأول (OC-04).
4. **`operationOutcomeText`:** نص النجاح من إيصال فقط. طلب الاسترداد «سُجّل»، **وليس استردادًا تمّ**: لا شيء يعلّم المال مستردًا إلا `REFUND_SUCCEEDED` الموقّع من المزود (`lib/payments/obligations.ts`).
5. **الافتراضي `NOT_AVAILABLE`** لكل عملية حتى يسجل المالك جهة مختصة (OC-01، OC-05). الغريب يأخذ `NOT_FOUND` من الجهة المختصة.

## التكامل المقترح عند جاهزية Qoder

- Qoder ينفّذ `OperationAuthority` لكل عملية فوق خدماته، ويسجلها في الإقلاع.
- ربطها بالمحادثة خطوة منفصلة ومراجَعة. تضيف تعريفًا في `ACTION_REGISTRY` يستدعي:
  - `review` لسطور المراجعة،
  - و`submitConfirmedOperation` عند «نعم».

  بهذا تبقى بطاقة المراجعة وإيصال الإجراء (`action-receipts.ts`) كما هما في كل الإجراءات.
- بوابة قبول الشروط القائمة (`lib/policy-gate.ts`) تبقى المسار الحالي للموافقات. `POLICY_REACCEPTANCE` مخصص لإعادة الموافقة التي يملكها backend السياسات.

## فحوص المطابقة لـQoder (`claude/10-ultra-closure`)

**الملف:** `test/operation-authority-conformance.ts`.

**الدالة:** `assertOperationAuthorityConformance(authority, { owned, stranger, writes })`. تُشغَّل كما هي على أي تطبيق حقيقي قبل تسجيله.

**ما تفحصه:**

| # | المتطلب |
|---|---|
| 1 | `review()` قراءة فقط: لا كتابة |
| 2 | الغريب `NOT_FOUND`، لا `NOT_ALLOWED` الذي يكشف وجود الهدف |
| 3 | كل حقيقة `SERVER_RECORD`، والمراجعة تتطلب تأكيدًا وتنتهي |
| 4 | لا كتابة دون تأكيد المستخدم |
| 5 | كتابة واحدة متكررة الأثر بالمفتاح |
| 6 | الإيصال `SUBMITTED` أو `ANSWERED`، ولا يدّعي حركة مال أبدًا |

**الدليل:**
- OC-06: ناجحة على البديل.
- OC-07: **ترفض** ثلاثة تطبيقات معطوبة، فهي ليست فارغة:
  - يكشف الغريب،
  - يكتب أثناء المراجعة،
  - يدّعي `REFUNDED`.
- لا يبقى شيء مسجلًا بعدها.

**ما يلزم Qoder** لكل عملية:
1. `OperationAuthority` فوق خدماته.
2. معرّف المراجعة وانتهاؤها من خادمه.
3. مفتاح عدم التكرار مخزّن في قاعدته.
4. تمرير الفحوص الستة.

ثم يسجلها المالك في الإقلاع. وربطها بالمحادثة خطوة منفصلة ومراجَعة.

**لم يُدمج أي عمل لـQoder، ولم تُفعَّل أي عملية.**
