# DINAR NEXT — تقرير الموجة 03: بروتوكول البطاقات الذكية v1

**التاريخ:** 2026-10-29
**الفرع:** `qoder/13-wave03-card-envelope`
**نقطة البداية:** `2da7f97` على خط Wave 02، دون تعديل `main`
**SHA الشيفرة المختبَرة نهائيًا:** `d12aaaf7ef646c3f385a365fb7b90a63e73db368`
**النتيجة:** الموجة 03 مكتملة ضمن نطاقها بدليل RED/GREEN وAPI وقاعدة بيانات ومتصفح حقيقي وانحدار؛ وهذا ليس إعلان جاهزية إطلاق أو دمجًا في `main`.

## 1. الهدف والنطاق

استهدفت الموجة عقدًا موحدًا ومُصدَّرًا لبطاقات المحادثة:

- **W03.1:** غلاف بطاقة مُرقَّم الإصدار (`schemaVersion: 1`) ومُقيَّد البنية يحدد نوع السطح وهويته والمورد والمحادثة والسياق وحالة دورة الحياة والإجراءات المسموحة والمراجعة المعلقة والانتهاء واستراتيجية التحديث ووقت المصدر وبيانات الوصول.
- **W03.2:** الخادم هو من يقرر وجود البطاقة وإجراءاتها وصلاحية التأكيد والانتهاء؛ النموذج يستطيع اقتراح سطح لكنه لا يخترع سلطة، والعرض في React يحترم الغلاف أو يفشل بأمان، ويعيد التحديث عبر SSE/refetch/restore القائم دون WebSocket جديد.
- **W03.3:** لا يحمل الغلاف معرّفًا شخصيًا لا تحتاجه البطاقة.

شمل التتبع بطاقة نتائج البحث، ومراجعة الشراء، ومراجعة عرض السعر، ومسطرة النتائج، وكل أسطح `SURFACE` الأخرى التي يبنيها الخادم.

## 2. الالتزام بمسار التنفيذ والقيود

اتبعت الموجة التسلسل: **TRACE → REUSE → DESIGN → RED TEST → IMPLEMENT → GREEN TEST → REGRESSION → SECURITY REVIEW → COMMIT → PUSH → EVIDENCE REPORT**.

- جميع commits على فرع معزول، ولم يُعدّل `main` ولم يُدمج إليه.
- لم يُستخدم Railway أو أي قاعدة إنتاج، ولم يُنشر أو يُفعّل دفع حقيقي أو مزود AI مدفوع.
- لم تتغير أسعار الاشتراكات أو رسوم الإعلانات أو سياسات الاحتفاظ والقانون.
- لم يُعَد كتابة تاريخ Git، ولم تُطبع أسرار أو رموز وصول.
- نُفذت builds والاختبارات في GitHub Actions على قواعد loopback مؤقتة؛ لم تُحمّل مضيفة Windows باختبارات DINAR.
- المزود في كل الاختبارات الحتمية scripted ومُعطَّل عمدًا؛ لم يُخترع أي رد نموذج.

## 3. TRACE — السلطات القائمة قبل التغيير

ثبت أن الأصل هو سطح مُركَّب يقرر الخادم محتواه، وأن توليده موزَّع:

- `ComposedSurfaceSchema` في `lib/api-zod/src/surface-composition.ts` كان يقيّد البنية لكنه لا يحمل إصدارًا ولا هوية مستقرة ولا موردًا ولا استراتيجية تحديث.
- `routes/ai.ts` كان يبني حمولات الأسطح (`purchaseReview` و`negotiation` و`managementPreview` وغيرها) مباشرة داخل كل أداة، بلا كائن مشترك يصف البطاقة نفسها.
- `ComposedSurface.tsx` كان يعرض التركيب كما هو، وكانت `commerce-adapters.ts` تبني بطاقات الشراء والتفاوض محليًا دون تسمية القدرات بأسماء الخادم.
- `confirmPendingAction` في `action-foundation.ts` كان ولا يزال سلطة التنفيذ الوحيدة؛ و`freshBlocksForConversation` في `routes/ai.ts:396` كان يعيد قراءة الكتل المخزنة كما هي.

الفجوات التي استدعت التنفيذ: لا غلاف مُصدَّر ولا نسخة صريحة، لا هوية بطاقة تصمد أمام reload، لا قائمة إجراءات يقررها الخادم في البيانات المرسلة، لا إشارة انتهاء داخل البطاقة، وحالة المراجعة مكررة بين حمولة الأداة وتركيب الواجهة.

## 4. REUSE — ما أُعيد استخدامه بدل إنشاء قناة موازية

- أُعيد استخدام `actionLifecycleState` ومفردات دورة الحياة التي أُضيفت في Wave 02 لتحويل حالة سجل الإجراء إلى حالة سطح.
- أُعيد استخدام `ComposedSurfaceSchema` كما هو؛ الغلاف لا يستبدله بل يحيط به ويصحح حالة الإجراء والإجراءات المسموحة، ويبقى التركيب القديم صالحًا عند غياب الغلاف.
- أُعيد استخدام `conversationSemanticSurfacesForToken` لإسناد النوع الدلالي للسطح من سجل الخادم نفسه بدل قائمة جديدة.
- أُعيد استخدام SSE الخاص بالمحادثة و`GET /ai/conversations/:id` وrestore من السجل؛ لم يُضف WebSocket ولا قناة بث جديدة.
- أُعيد استخدام `appendChatBlock`/تخزين الكتل، مع حذف الغلاف من التخزين لأنه بيانات مشتقة تُعاد قراءتها من المصدر.
- لم تتغير سلطة `confirmPendingAction` ولم يُمنح النموذج أي أداة أو قرار جديد.

## 5. DESIGN — عقد الغلاف

أُضيف إلى `lib/api-zod/src/surface-composition.ts:259` وما بعدها:

| الحقل | المعنى |
|---|---|
| `schemaVersion` | `1` فقط؛ أي إصدار آخر يفشل في `parseCardEnvelope` |
| `surfaceType` | نوع دلالي من سجل الخادم مثل `CHECKOUT_CONFIRMATION` أو `NEGOTIATION_SURFACE` |
| `surfaceId` | هوية مستقرة مشتقة من سجلات الخادم (`resultSetId:surfaceType`، أو `actionId:surfaceType` للمراجعة) |
| `resource` | `kind` من `NONE/LISTING/ORDER/NEGOTIATION/INQUIRY/CART/DELIVERY/...` مع `id` عند وجوده |
| `conversationId` | UUID المحادثة المالكة |
| `taskId` | محفوظ للمهام متعددة الخطوات دون استخدامه الآن |
| `context` | `role` عند اختلاف البطاقة بحسب الدور، و`marketId` إجباريًا، و`currency` عند وجودها |
| `status.lifecycle` | `READY/PENDING_REVIEW/CONFIRMED/CANCELLED/EXPIRED/UNAVAILABLE/DENIED/FAILED`، و`status.resource` للحالة الخام في السجل |
| `allowedActions` | معرّفات قدرات يقررها الخادم، بحد أقصى 12 |
| `pendingReviewId` | سجل الإجراء المعلق فقط عندما تكون الحالة `PENDING_REVIEW` |
| `expiresAt` | انتهاء المراجعة المعلقة |
| `refresh.strategy` | `SSE` أو `REFETCH` أو `RESTORE` أو `NONE` |
| `sourceTimestamp` | وقت بناء الغلاف من حالة الخادم |
| `accessibility` | `label` عربي دلالي و`description` عند انتظار قرار |
| `surface` | تركيب مُركَّب اختياري يملكه الخادم بدل تركيب الواجهة |

العقد `strict()`: أي مفتاح غير معلن يُرفض، وأي حالة طرفية تحمل قائمة إجراءات غير فارغة تُرفض في `surface-composition.ts:309`. القاعدة المهمة: `pendingReviewId` هوية السجل الذي وُلدت منه البطاقة وليس سلطة؛ لذلك لا يُشترط أن يختفي من بطاقة طرفية، لكن وجوده وحده لا يفتح إجراءً.

## 6. DESIGN — البناء من حالة الخادم وحدها

`buildCardEnvelope` في `artifacts/api-server/src/ai/card-envelope.ts:203` يقرأ فقط سجلات الخادم:

- **دورة الحياة** من `purchaseReview.status` أو `negotiation.status`/`view` أو `managementPreview.status` عبر `actionLifecycleState` (`:140`).
- **الانتهاء**: إن كانت مراجعة معلقة وقد تجاوز `expiresAt` وقت المصدر، تصبح `EXPIRED` قبل الإرسال (`:211`–`:216`).
- **مراجعة معلقة**: `actionId` الشراء أو التفاوض أو `previewId` فقط عندما تكون الحالة `PENDING_REVIEW` (`:218`–`:224`).
- **الإجراءات**: `purchaseCapabilities` و`negotiationCapabilities` (`:73`–`:116`) تعيد القدرات حسب المرحلة والعرض والدور؛ تغيير الحالة إلى طرفية يجعلها فارغة (`:227`–`:229`).
- **المورد**: `resourceOf` (`:163`) يفضّل `orderId` لمراجعة الشراء بعد إنشاء الطلب، ثم `negotiationId`، ثم `listingId`/`resourceId`.
- **التحديث**: `SSE` للمراجعة المعلقة، وإلا `REFETCH` عند وجود مورد أو عرض، وإلا `RESTORE` (`:241`–`:246`).
- **الفشل الآمن**: أي غلاف لا يجتاز `CardEnvelopeSchema` لا يُرسل، ويُسجَّل `card_envelope_invalid` مع الأسباب ليظهر النقص بدل إخفائه، ويُرسم التركيب القديم (`:270`–`:276`).

يُرفَق الغلاف بكتل `SURFACE` و`LISTING_RESULTS` عبر `buildCardEnvelope` في `routes/ai.ts:609` و`:684` و`:1860` و`:2107` و`:2327`. ويُعاد حساب الغلاف على كل قراءة تاريخ في `freshBlocksForConversation`، أي أن مصدر الحقيقة هو السجل لا نسخة الرسالة (`routes/ai.ts:2149`–`:2150` تحذف الغلاف عند التخزين).

## 7. DESIGN — العقد في الواجهة والفشل الآمن

- **التحقق في طبقة البيانات**: `normalizeBlock` في `artifacts/dinar/src/features/ai/ai-api.ts:255` يمرر `payload.card` عبر `parseCardEnvelope`، ويقارن `surfaceType` بنوع الكتلة وتوكنها عبر `cardMatchesBlock` (`:234`). غلاف بإصدار غير معروف أو سطح لا يطابق الكتلة يُسقط الكتلة كاملة، لا يُطبَّق جزئيًا.
- **التطبيق عند العرض**: `applyCardEnvelope` في `surface-composition.ts:328` يحذف كل إجراء `SEND` غير مسموح، ويحذف كل `SEND` على حالة طرفية، ويستبدل حالة التركيب بحالة الخادم إلا في `READY`، ويُبطل نص «بانتظار قرارك» القديم عند الطرفية.
- **الفشل البصري**: `ComposedSurfaceView` في `ComposedSurface.tsx:96` يرسم `InvalidCard` عند تركيب غير صالح أو غلاف غير معروف (`:111`، `:113`)، ولا يترك بطاقة نصف مرسومة.
- **حالة الصف على DOM**: `SurfaceCard` يحمل `data-card-schema-version` و`data-card-surface-id` و`data-card-lifecycle` (`:126`–`:134`)، وهي التي يقرأها اختبار المتصفح ليؤكد هوية البطاقة ودورتها بدل الاعتماد على النص وحده.
- **التبادل مع المكوّنات القديمة**: `ConversationContent.tsx:1349` يوفّر الغلاف عبر `CardEnvelopeProvider`، فتقّرأه البطاقات المتخصصة (مثل التفاوض) من السياق. غياب الغلاف لا يعني فشل البطاقة: التركيب القديم يبقى صالحًا بعقده السابق.

## 8. RED TEST — الدليل قبل الإصلاح

كُتبت الاختبارات أولًا في `5b8488a` (10 اختبارات واجهة، 9 اختبارات API/DB، ورحلة متصفح).

**Run الأحمر:** [40769919526](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40769919526)، SHA `5b8488a146338fc877fc65488defdf275766d3ed`:

- Typecheck ناجح وbuild للـAPI والويب ناجح — أي أن الفشل برمجي وليس بنيويًا.
- Web surface: **18 ناجحًا من 28، فشل 10** — كل اختبارات Wave 03 الجديدة العشرة فشلت لأن `CardEnvelopeSchema` و`parseCardEnvelope` لم يكونا موجودين بعد.
- خطوة API تخطّت تلقائيًا لأن خطوة الويب سبقتها وفشلت.

لذلك لم يُدَّعِ هذا التقرير فشل طبقة API في هذا التشغيل. الدليل الأحمر لطبقة API ظهر لاحقًا وبشكل صريح في run `40790090397` (SHA `d8c2d05`): الويب **28/28** أخضر، وAPI **4 ناجحة من 9، فشل 5** — بما فيها «بطاقة نتيجة البحث تحمل غلافها» و«إعادة التحميل تعيد البطاقة المعلقة نفسها».

هذا يفصل RED البروتوكول عن RED الطبقة الخادمية، ولا يحوّل تشغيلًا أحمر إلى دليل نجاح.

## 9. IMPLEMENT — الملفات والنتيجة

| الملف | التغيير |
|---|---|
| `lib/api-zod/src/surface-composition.ts` | `CardEnvelopeSchema` و`parseCardEnvelope` و`applyCardEnvelope` ومفردات الموراد والأدوار والاستراتيجيات |
| `artifacts/api-server/src/ai/card-envelope.ts` | بناء الغلاف من سجلات الخادم، حساب الانتهاء، القدرات، المورد، وإسقاط الغلاف غير الصالح مع تسجيله |
| `artifacts/api-server/src/routes/ai.ts` | إرفاق الغلاف بكتل النتائج والأسطح، وإعادة حسابه على كل قراءة، وحذفه من التخزين |
| `lib/api-spec/openapi.yaml` | إضافة `payload.card` إلى `AiUiBlock` حتى لا يحذفه تحقق رد الخادم |
| `lib/api-zod/src/generated/**` و`lib/api-client-react/src/generated/**` | إعادة توليد العملاء من العقد عبر CI |
| `artifacts/dinar/src/features/ai/ai-api.ts` | التحقق من الغلاف ومطابقته للكتلة وإسقاط الكتلة غير المتسقة |
| `artifacts/dinar/src/features/ai/surface/ComposedSurface.tsx` | مزوّد الغلاف، `InvalidCard`، تطبيق الغلاف، وبيانات الهوية على DOM |
| `artifacts/dinar/src/features/ai/ConversationContent.tsx` | توفير غلاف الكتلة للبطاقات النازلة |
| `artifacts/dinar/test/wave03-card-envelope.test.tsx` | 10 اختبارات عقد/عرض |
| `artifacts/api-server/test/wave03-card-envelope.test.ts` | 9 اختبارات HTTP/DB |
| `artifacts/api-server/test/wave03-card-envelope-browser-journey.test.ts` و`artifacts/dinar/test/wave03-card-envelope-ui.mjs` | رحلة متصفح حقيقية بثلاثة عروض |
| `artifacts/dinar/test/tsconfig.surfaces.json` | إدراج اختبار JSX الجديد ليأخذ تحويل `react-jsx` |

## 10. GREEN TEST — النتيجة النهائية على SHA الشيفرة

**Run النهائي:** [40831457692](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40831457692)
**SHA:** `d12aaaf7ef646c3f385a365fb7b90a63e73db368`

- Typecheck: ناجح.
- Build لـapi-server: ناجح.
- Build للويب: ناجح.
- Web surface protocol: **28/28، fail 0** (يشمل 10 اختبارات Wave 03 مع 18 اختبارًا من الموجتين السابقتين).
- API Wave 03: **9/9، fail 0**.
- السجل الختامي: `LOCAL_SUITE suite=wave03-card-envelope.test db=dinar_test_local_56278b4c245b exit=0 outbound=0`.

محطات GREEN السابقة، للتتبع لا للاستعاضة عن النهائي:

| Run | SHA | النتيجة |
|---|---|---|
| [40792002864](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40792002864) | `0a46636` | Web 28/28، API 9/9 بعد إصلاح حذف `card` من الرد |
| [40829605478](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40829605478) | `d723a44` | Web 28/28، API 9/9 |
| [40829214880](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40829214880) | `d723a44` | رحلة المتصفح 1/1، 19 فحصًا |

## 11. رحلة القبول في المتصفح — 19 فحصًا

**Run:** [40831704753](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40831704753)
**SHA:** `d12aaaf…`
**النتيجة:** Node test **1/1**، والسجل `W03_BROWSER` يحمل 19 فحصًا ناجحًا و`pageErrors=[]` و`consoleErrors=[]` و`externalRequests=[]` و`horizontalOverflow=0`، و`LOCAL_SUITE … db=dinar_test_local_5a3c1d200f42 exit=0 outbound=0`.

الرحلة: بحث المشتري → بطاقة نتيجة → اختيار معلَّق → إعادة تحميل → رفض → إعادة تحميل. وتُكرَّر بمساري شراء وتفاوض:

1. نتيجة البحث تظهر كبطاقة للمشتري (سطح المنتج).
2. مراجعة الشراء: الغلاف `PENDING_REVIEW` و`surfaceId` من الخادم، والأزرار **confirm/continue/cancel** فقط كما في الغلاف.
3. بعد reload: `surfaceId` نفسه ودورة `PENDING_REVIEW` نفسها.
4. بعد الرفض ثم reload: `CANCELLED` ولا أزرار إطلاقًا، ثم reload ثالث يؤكد أن النتيجة لا ترتد.
5. مراجعة التفاوض: `SEND/EDIT/CANCEL` من الغلاف، ثم reload بنفس المراجعة، ثم رفض و`CANCELLED` بلا أزرار.
6. كل مرحلة قيست على **320 و390 و1280px**: اتجاه RTL، لا فيض أفقي، المحتوى والأزرار داخل viewport، وكل زر ارتفاعه ≥32px وله اسم وصول.

قيم الهوية في هذا التشغيل: مراجعة الشراء `7fac45d4-…:CHECKOUT_CONFIRMATION` بحالة `PENDING_REVIEW`، ومراجعة التفاوض `4d62319e-…:NEGOTIATION_SURFACE` بحالة `PENDING_REVIEW`. لم تُستخدم لقطات ثابتة بدل الرحلة.

## 12. دليل API التفصيلي

الاختبارات التسعة في `wave03-card-envelope.test.ts` تعمل على HTTP حقيقي عبر `127.0.0.1` مع Express وDrizzle/PostgreSQL، لا mock لقاعدة البيانات:

1. **العقد**: رفض الإصدار 0/2/"1"/غائب، ورفض المفاتيح الزائدة و`WEBSOCKET` و`surfaceType` غير الرمزي و`surfaceId` الفارغ، ورفض قائمة إجراءات على حالة طرفية مع قبول قائمة فارغة.
2. **التهيئة**: بائع ينشر إعلانين (قابل للتفاوض وثابت السعر) ومشتري يبحث عبر المسارات الحقيقية.
3. **بطاقة النتيجة**: `schemaVersion=1`، `surfaceType` من النتائج، `conversationId` و`marketId=JO` و`currency=JOD`، `resource.kind=LISTING` و`resource.id` هو الإعلان المفتوح، `READY`، `refresh=REFETCH`، وقت مصدر صالح، وlabel غير فارغ، ولا `pendingReviewId`.
4. **مراجعة الشراء**: `CHECKOUT_CONFIRMATION` و`PENDING_REVIEW` و`status.resource=PENDING`، `pendingReviewId` هو `actionId` الحقيقي، `allowedActions=["CONFIRM","CONTINUE","CANCEL"]`، `refresh=SSE`، `role=BUYER`، `resource.id` هو الإعلان ثابت السعر، `expiresAt` في المستقبل، و`surfaceId = ${actionId}:CHECKOUT_CONFIRMATION`.
5. **إعادة التحميل**: نفس `surfaceId` ونفس `actionId` ونفس القدرات، و`purchaseReview.status` في الحمولة يوافق الغلاف.
6. **التأكيد**: بعد «نعم» تظهر `CART`، وبعد reload تبقى البطاقة التاريخية بنفس الهوية لكن بحالة `CONFIRMED` وقائمة إجراءات فارغة وبلا `pendingReviewId` و`refresh=REFETCH` — أي أن السجل لا نص البطاقة القديمة هو الحاكم.
7. **التفاوض**: `NEGOTIATION_SURFACE` و`PENDING_REVIEW` و`pendingReviewId` من الحمولة و`["SEND","EDIT","CANCEL"]` و`role=BUYER` و`SSE` و`expiresAt` مستقبلي.
8. **الإلغاء**: بعد «إلغاء» وreload تصبح `CANCELLED` بقائمة فارغة وبلا مراجعة معلقة، و`surfaceId` نفسه.
9. **الخصوصية**: تسلسل كل الأغلفة لا يحتوي معرّف المشتري ولا رقم هاتفه ولا رقم البائع ولا صيغته الدولية.

بوابة النموذج scripted وترمي `AIProviderError` إن طُلبت؛ لم يُمنح النموذج قرار تنفيذ ولم تُستخدم نتيجة مخترعة.

## 13. دليل قاعدة البيانات والعزل

- قاعدة الاختبار النهائية: `dinar_test_local_56278b4c245b`، وقاعدة رحلة المتصفح: `dinar_test_local_5a3c1d200f42`، وكلتاهما مؤقتة على loopback.
- حارس `requireSafeReplitDevelopmentDatabase("BDINAR_WAVE03_ACCEPTANCE")` يمنع الاتصال بأي قاعدة غير تطويرية.
- الاختبارات قرأت المحادثة المخزنة عبر `GET /ai/conversations/:id` وأثبتت أن الغلاف يُعاد حسابه من سجل الإجراء لا من نسخة الرسالة.
- تغيير الحالة من `PENDING_REVIEW` إلى `CONFIRMED`/`CANCELLED` ظهر بعد reload لأن القراءة تعيد حساب الغلاف من السجل، لا لأن الواجهة عدّلت شيئًا.
- بطاقة النتيجة المفتوحة عادت بـ`resource.id` مطابق للإعلان المنشور فعليًا (`cups`)، ما يثبت أن الغلاف لا يخترع موردًا.
- كلتا المهمتين النهائيتين سجلتا `outbound=0`؛ لا اتصال بقاعدة إنتاج أو خدمة خارجية.

## 14. REGRESSION — البطارية وSHA كل تشغيل

| الحزمة | Run | SHA | النتيجة |
|---|---|---|---|
| Wave 03 card envelope (web+API) | [40831457692](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40831457692) | `d12aaaf` | Web 28/28، API 9/9 |
| Wave 03 browser journey | [40831704753](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40831704753) | `d12aaaf` | 1/1، 19 فحصًا |
| Wave 02 card reliability | [40832064880](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40832064880) | `d12aaaf` | 9/9 |
| block-f3 commerce | [40832269437](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40832269437) | `d12aaaf` | 17/17 |
| g2 smart conversation | [40832478813](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40832478813) | `d12aaaf` | 91/91 |
| qoder-security (audit/build/codegen) | [40831452794](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40831452794) | `d12aaaf` | ناجح، `BLOCKING_VULNERABILITIES 0`، `CODEGEN_DRIFT=0` |

كل الأجنحة في هذه الجدول نُفذت على SHA النهائي نفسه، ولا تُنسب أي نتيجة من تشغيل قديم إليه. التشغيلات المعزولة الناجحة أبلغت `outbound=0`.

## 15. SECURITY REVIEW — المراجعة والتقوية

- **سلطة الخادم:** كل قيمة في الغلاف مشتقة من سجل خادم (result set، سجل إجراء، تفاوض، حالة حمولة)؛ لا حقل يُملأ من نص النموذج إلا ما بنته أداة مقيّدة أصلًا.
- **سلطة النموذج:** لم تُضف أداة model-facing ولم يتغير أي `exposedToModel`؛ الغلاف لا يُنشئ تنفيذًا، بل يصف ما يسمح به `confirmPendingAction`.
- **المنع مزدوج:** الغلاف الطرفي لا يحمل إجراءات في الـschema، و`applyCardEnvelope` يحذف أي `SEND` غير مسموح حتى لو بناه محوّل قديم، و`ComposedSurfaceView` يمرّر `onSend` فقط لبطاقة نشطة وحالة غير طرفية.
- **الفشل الآمن:** إصدار غير معروف أو سطح لا يطابق الكتلة أو تركيب غير صالح ⇒ لا بطاقة، لا تطبيق جزئي ولا زر وراثي.
- **الخصوصية:** الجدول لا يحمل `userId` ولا هاتفًا ولا بريدًا؛ اختبار W03.3 يثبت غياب معرّف المشتري وهاتف الطرفين من كل الأغلفة المسلسلة، و`sourceTimestamp` ليس وقت الاستخدام بل وقت بناء الغلاف.
- **الانتهاء:** يُقاس مقابل `expiresAt` ووقت المصدر في الخادم، فلا تعتمد صلاحية المراجعة على ساعة المتصفح.
- **بيانات مشتقة:** الغلاف يُحذف من الكتل المخزنة ويُعاد بناؤه عند القراءة، فلا توجد نسخة قديمة تصف سلطة سابقة.
- **الاعتماديات والعقد:** `AUDIT_VULNERABILITIES` كله أصفار و`BLOCKING_VULNERABILITIES 0`، وإعادة التوليد مطابقة (`CODEGEN_DRIFT=0`).
- لم تُضف أسرار أو اعتماديات أو تغييرات صلاحيات أو نشر. لم يُثبت هذا العمل إبطال PAT قديم؛ ذلك إجراء مستقل يؤكده المالك.

## 16. الأعطال وإعادات التشغيل وتصنيفها

| التشغيل | SHA | العطل | التصنيف والإصلاح |
|---|---|---|---|
| [40769919526](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40769919526) | `5b8488a` | Web 18/28، فشل 10 | **RED مقصود** — العقود غير موجودة بعد |
| [40777523728](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40777523728) | `cba12c9` | Web 21/28، فشل 7 | تنفيذ غير مكتمل: قاعدة `pendingReviewId` في الـschema كانت ترفض بطاقة طرفية تحتفظ بهوية سجلها. أُزيلت القاعدة في `2f8f934` لأن الهوية ليست سلطة؛ وبقيت قاعدة منع الإجراءات الطرفية |
| [40780099632](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40780099632) | `2f8f934` | إلغاء بعد 60 دقيقة | `node --test` لم يخرج لأن خادم الاختبار بقي يستمع. أُضيف `test.after` يغلق الخادم في `d8c2d05` وفي رحلة المتصفح في `a776597` |
| [40790090397](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40790090397) | `d8c2d05` | Web 28/28، API 4/9 | **دليل RED لطبقة API**؛ التشخيص أظهر `keys` الحمولة بلا `card`. أُضيف تسجيل `card_envelope_invalid` والتشخيص المفصّل في `5c9bd6d` |
| [40790988270](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40790988270) | `5c9bd6d` | Web 28/28، API 5/9 | السبب الجذري: `card` كان يُحذف من كل رد لأن `AiUiBlock.payload` في OpenAPI لا يعلنه، فيزيله `GetAiConversationResponse.parse`. أُصلح العقد في `d14aad7` وأُعيد التوليد في `0a46636` |
| [40791710217](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40791710217) | `d14aad7` | `CODEGEN_DRIFT=1` | توليد ناقص؛ سُحب أثر CI وطُبّق |
| [40792423628](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40792423628) | `0a46636` | إلغاء بعد 60 دقيقة | رحلة المتصفح أبقت الخادم مفتوحًا؛ أُغلقت في `a776597` |
| [40828364156](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40828364156) | `a776597` | رحلة المتصفح 0/1 | قاعدة المنتج: الإعلان القابل للتفاوض لا يفتح مراجعة شراء، فتوقعت الرحلة بطاقة لم تُنشأ. أُضيف إعلان ثابت السعر لمسار الشراء في `d723a44` |
| [40829991919](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40829991919) | `d723a44` | block-f3 13/17 | علم محاكاة الدفع مفقود في التشغيل؛ أُعيد بالعلمين `BDINAR_BLOCKF_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development` |
| [40831008785](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40831008785) | `d723a44` | `CODEGEN_DRIFT=1` | ملفات أنواع الحمولة الثلاثة كانت ناقصة؛ سُحبت من أثر CI وأُضيفت في `d12aaaf` |

الأوامر النهائية المستخدمة، دون أسرار:

```bash
GH="C:\Program Files\GitHub CLI\gh.exe"
"$GH" workflow run qoder-api-suite.yml \
  --ref qoder/13-wave03-card-envelope \
  -f suite=wave03-card-envelope.test \
  -f flags=BDINAR_WAVE03_ACCEPTANCE=development

"$GH" workflow run qoder-api-suite.yml \
  --ref qoder/13-wave03-card-envelope \
  -f suite=wave03-card-envelope-browser-journey.test \
  -f flags=BDINAR_WAVE03_ACCEPTANCE=development
```

كل تشغيل جرى تسلسليًا على الفرع وتوبع بمعرّفه وSHA.

## 17. COMMIT / PUSH / الحكم وما لم يُفعل

commits المدفوعة على الفرع:

1. `5b8488a` — اختبارات RED للغلاف المُرقَّم.
2. `cba12c9` — الغلاف وحده من قرار الخادم.
3. `2f8f934` — بطاقة طرفية تُحلَّل، وتحويل JSX للاختبار الأحمر، ومورد الطلب.
4. `d8c2d05` — إغلاق خادم الاختبار وتسمية الأسطح عند فقد التحميل.
5. `5c9bd6d` — تهيئة شراء بسعر ثابت وتشخيصات الغلاف وتسجيله عند الإسقاط.
6. `d14aad7` — العقد: حمولة الكتلة تحمل الغلاف.
7. `0a46636` — إعادة توليد العملاء المولّدين من العقد.
8. `a776597` — إغلاق خادم رحلة المتصفح ليخرج المشغّل.
9. `d723a44` — رحلة الشراء تستخدم إعلانًا ثابت السعر.
10. `d12aaaf` — إكمال أنواع الحمولة المولّدة للغلاف.

دُفع الفرع إلى `origin/qoder/13-wave03-card-envelope`، وكان working tree نظيفًا قبل إضافة وثيقة التقرير. تُضاف هذه الوثيقة بـcommit توثيقي مستقل لا يغير شيفرة `d12aaaf` المختبَرة.

**الحكم:** متطلبات Wave 03 مغطاة بالتنفيذ والأدلة المذكورة؛ كل بطاقة يبنيها الخادم تحمل غلافًا v1 يحدد هويتها وموردها ودورتها وإجراءاتها وانتهاءها، والواجهة لا تعرض إجراءً لم يسمح به الخادم وتفشل بأمان على إصدار غير معروف، والتحديث يستخدم SSE/refetch/restore القائمة، ورحلة المتصفح أثبتت ثبات الهوية والحالة بعد reload على 320/390/1280px. لا يعني ذلك قبول إطلاق DINAR أو رفع بقية launch gates.

**ما لم يُفعل:** لم يُدمج إلى `main`، ولم يُنشر، ولم تُستخدم قواعد إنتاج، ولم يُفعّل دفع حقيقي أو AI مدفوع، ولم يُختبر الغلاف على أسطح لم يغطها التتبع (مثل بطاقات السائق والوظائف) في متصفح حقيقي، ولم تُختبر أعطال شبكة مادية أو كل أحجام الشاشات، ولم تُنسب اختبارات SHA قديم إلى SHA النهائي. إبطال PAT القديم باقٍ كإجراء مستقل يتطلب تأكيد المالك.
