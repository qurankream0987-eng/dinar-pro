# DINAR NEXT — تقرير الموجة 02: موثوقية البطاقات ودورة الحياة ومنع التكرار

**التاريخ:** 2026-10-28
**الفرع:** `qoder/12-wave02-card-reliability`
**نقطة البداية:** `772cda7` على خط Wave 01، دون تعديل `main`
**SHA الشيفرة المختبَرة نهائيًا:** `a997d133fd44712fa236ac61b106ceacfe3ab05c`
**النتيجة:** الموجة 02 مكتملة ضمن نطاقها بدليل RED/GREEN وAPI وقاعدة بيانات ومتصفح وانحدار؛ وهذا ليس إعلان جاهزية إطلاق أو دمجًا في `main`.

## 1. الهدف والنطاق

استهدفت الموجة ثلاثة متطلبات مترابطة:

- **W02.1:** مفردات موحدة لدورة حياة البطاقات: `READY` و`PENDING_REVIEW` و`CONFIRMED` و`CANCELLED` و`EXPIRED` و`UNAVAILABLE` و`DENIED` و`FAILED`، مع الفصل بين حالة المورد وحالة الإجراء المعلق.
- **W02.2:** عدم تنفيذ سلطة منتهية أو مورد تغيّر بعد عرض البطاقة؛ يجوز عرض التحديث أو إعادة البدء، لا تنفيذ القرار القديم.
- **W02.3:** منع الأثر المكرر في النقر المزدوج وإعادة المحاولة وإعادة التحميل والتزامن والجلسة الثانية، مع بقاء كل تغيير تحت سلطة الخادم والمعاملات الحالية.

شمل التتبع بطاقات الشراء والتفاوض وإضافة العرض إلى السلة والنشر والدفع/إنشاء الطلب، ومسارات الإجراءات الحوارية وREST المباشرة.

## 2. الالتزام بمسار التنفيذ والقيود

اتبعت الموجة التسلسل: **TRACE → REUSE → DESIGN → RED TEST → IMPLEMENT → GREEN TEST → REGRESSION → SECURITY REVIEW → COMMIT → PUSH → EVIDENCE REPORT**.

- جميع commits على فرع معزول، ولم يُعدّل `main` ولم يُدمج إليه.
- لم يُستخدم Railway أو أي قاعدة إنتاج، ولم يُنشر أو يُفعّل دفع حقيقي أو مزود AI مدفوع.
- لم تتغير أسعار الاشتراكات أو رسوم الإعلانات أو سياسات الاحتفاظ والقانون.
- لم يُعَد كتابة تاريخ Git، ولم تُطبع أسرار أو رموز وصول.
- نُفذت builds والاختبارات في GitHub Actions على قواعد loopback مؤقتة؛ لم تُحمّل مضيفة Windows باختبارات DINAR.
- تشغيل SC01 استخدم `SIMULATION_ONLY`، ولم تُحوّل أموال حقيقية.

## 3. TRACE — السلطات القائمة قبل التغيير

ثبت أن سلطة التنفيذ ليست في React أو النموذج:

- `confirmPendingAction` في `artifacts/api-server/src/ai/action-foundation.ts` يقفل صف الإجراء، ويتحقق من المالك والسوق والانتهاء والحالة الطرفية و`sameState` قبل التنفيذ.
- `buyer-turn.ts` و`negotiation-turn.ts` يحدّثان عرض المراجعة من سجل الإجراء، ولا يعتمدان على نص قديم في المحادثة.
- `Ai.tsx` و`ConversationContent.tsx` يجعلان بطاقة سير العمل الأحدث فقط قابلة للتفاعل؛ البطاقات الأقدم للعرض.
- مسارا النشر و`/checkout` في `routes/marketplace.ts` يملكان مسبقًا مفاتيح idempotency وسجلّي بصمة/استجابة.
- `addToCart` غير معروض للنموذج (`exposedToModel: false`)، وبقي كذلك.

الفجوات التي استدعت التنفيذ كانت: غياب `PENDING_REVIEW` من مفردات السطح، إمكان ظهور SEND على بطاقة طرفية، عدم وجود إيصال مشترك لإضافة البطاقة نفسها، ومفتاح checkout محلي كان يضيع عند reload ولا يتشارك بين tabs.

## 4. REUSE — ما أُعيد استخدامه بدل إنشاء سلطة موازية

- أُبقي `confirmPendingAction` سلطة موحدة للتأكيدات الحوارية؛ لم تُنشأ قناة تنفيذ جديدة للنموذج.
- أُعيد استخدام معاملة السلة وقفل المستخدم وقواعد التحقق من النشر والبائع والسعر والاتفاق والمخزون.
- أُعيد استخدام `checkoutRequests` وبصمة الطلب واستجابته المخزنة، بما فيها رفض الحمولة المختلفة بالمفتاح نفسه بـ409.
- أُعيد استخدام idempotency النشر القائم على `Idempotency-Key` وبصمة الإعلان.
- لم تتغير دلالات المعاملات، ولم تُحوّل إعادة الإيصال إلى تجاوز لفحوص الملكية أو الصلاحية أو المورد.

## 5. DESIGN — فصل حالة الإجراء عن حالة المورد

أضيفت المفردات والتحويل المشترك في `lib/api-zod/src/surface-composition.ts:30` و`:49` و`:68`:

| حالة سجل الإجراء | حالة السطح |
|---|---|
| `PENDING` أو `EXECUTING` | `PENDING_REVIEW` |
| `CONFIRMED` | `CONFIRMED` |
| `CANCELLED` أو `REJECTED` أو `SUPERSEDED` | `CANCELLED` |
| `EXPIRED` | `EXPIRED` |
| غير ذلك | `READY` |

- يبقى `status` لحالة المورد، بينما تعبّر `state` عن دورة عرض الإجراء.
- الحالات الطرفية التي لا تقبل SEND هي `CONFIRMED` و`CANCELLED` و`EXPIRED` و`DENIED`.
- ترفض Zod أي SEND على بطاقة طرفية في `surface-composition.ts:236`، ويمنع العارض handler في `ComposedSurface.tsx:88`؛ أي أن المنع ليس مجرد إخفاء بصري.
- يبقى NAVIGATE متاحًا لعرض السجل، لأنه لا ينفذ سلطة قديمة.
- تستخدم بطاقتا الشراء والتفاوض التحويل نفسه في `commerce-adapters.ts:291` و`:366`، وتوضح حالة `EXECUTING` دون تقديم قرار ثانٍ.

## 6. DESIGN — الإيصال ومنع التكرار والانتهاء

### إضافة البطاقة إلى السلة

- مفتاح الإيصال في `marketplace-cart.ts:315` هو SHA-256 لنطاق ثابت مع `conversationId + resultSetId + listingId`.
- `addMarketplaceCartItemOnce` في `marketplace-cart.ts:346` يعمل داخل المعاملة وقفل المستخدم، ويعيد الإيصال الموجود بدل تكرار السطر أو الرسالة أو CART block.
- لا يعيد الإيصال قبل التحقق من صلاحية result set؛ الطلب بمجموعة منتهية يُرفض ولا يغيّر السلة.
- عند غياب إيصال، يعاد التحقق من ملكية المجموعة والسوق والموارد والنشر والبائع والتصنيف والسعر والاتفاق والمخزون.
- تُكتب السلة والرسالة والبطاقة وتحديث المحادثة معًا؛ لذلك تتقارب الطلبات المتزامنة على إيصال واحد.
- `routes/ai.ts:1770` يطلب مسار الإيصال، و`:1794` يعيد الرسالة المخزنة نفسها. بقي المسار القديم additive للمستدعين غير المعنيين بإيصال البطاقة.

### Checkout من المتصفح

- `checkout-request.ts:38` يبني بصمة مرتبة من `listingId:quantity:fulfilmentType` مع التعليمات.
- `checkout-request.ts:49` يحفظ مفتاحًا واحدًا للنية في `localStorage` ليصمد أمام reload ويشترك بين tabs؛ تغيّر السلة أو التعليمات ينشئ نية ومفتاحًا جديدين.
- `Checkout.tsx:115` يرسل المفتاح نفسه، و`:132` يمسحه بعد النجاح فقط كي لا يعيد الطلب الجديد إيصال طلب سابق.

## 7. RED TEST — الدليل قبل الإصلاح

أُنشئت الاختبارات أولًا في `3e637dd`. لإظهار فشل الطبقتين بدل توقف CI عند الواجهة، استخدم فرع الدليل `qoder/12-wave02-red-evidence` تغييرًا توثيقيًا/تشغيليًا وحيدًا هو `continue-on-error` لخطوة الويب؛ لم يتغير كود المنتج أو الاختبار في خطوة الدليل.

**Run الأحمر:** [40696681631](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40696681631)، SHA `92aeb0c2858a2778a2cb496665c3f6b2b29ee5b5`:

- Web surface: **15 ناجحًا / 17**؛ منها غياب `PENDING_REVIEW`.
- API Wave 02: **4 ناجحة / 9**.
- الأعطال المقصودة: لا إيصال مشترك للتكرار، ولا تقارب على إيصال واحد للتزامن، ولا إعادة الإيصال لجلسة ثانية.
- عطل خامس كان في تأليف اختبار النشر: لم يرسل `Idempotency-Key` المطلوب أصلًا. صُحح الاختبار بإرسال UUID حقيقي؛ لم يُضعَّف assertion ولم يُغيَّر المنتج ليقبل نشرًا بلا مفتاح.

هذا يفصل بوضوح بين RED حقيقي وعطل اختبار، ولا يحوّل تشغيلًا أحمر إلى دليل نجاح.

## 8. IMPLEMENT — الملفات والنتيجة

| الملف | التغيير |
|---|---|
| `lib/api-zod/src/surface-composition.ts` | المفردات، التحويل، الحالات الطرفية، ورفض SEND |
| `artifacts/dinar/src/features/ai/surface/ComposedSurface.tsx` | منع handler عن البطاقات غير النشطة/الطرفية وعدم تكرار التنبيه |
| `artifacts/dinar/src/features/ai/surface/commerce-adapters.ts` | ربط مراجعة الشراء والتفاوض بدورة السجل |
| `artifacts/api-server/src/lib/marketplace-cart.ts` | إيصال إضافة البطاقة والتحقق والمعاملة الذرية |
| `artifacts/api-server/src/ai/tool-registry.ts` | خيار داخلي `cardReceipt` دون منح النموذج أداة أو سلطة جديدة |
| `artifacts/api-server/src/routes/ai.ts` | إعادة الإيصال نفسه من REST |
| `artifacts/dinar/src/features/checkout-request.ts` و`pages/Checkout.tsx` | مفتاح واحد لكل نية checkout عبر reload/tabs |
| `artifacts/api-server/test/wave02-card-reliability.test.ts` | تسعة اختبارات HTTP/DB للسلامة ومنع التكرار |
| `artifacts/dinar/test/wave02-card-lifecycle.test.tsx` و`checkout-request.test.ts` | اختبارات renderer والمفتاح والخصوصية |
| `.github/workflows/qoder-api-suite.yml` وملفات تشغيل الاختبارات | تشغيل surface tests تلقائيًا وعلم القبول التطويري |

## 9. GREEN TEST — النتيجة النهائية على SHA الشيفرة

**Run النهائي:** [40758023669](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40758023669)
**SHA:** `a997d133fd44712fa236ac61b106ceacfe3ab05c`

- Typecheck: ناجح.
- Build لـapi-server: ناجح.
- Build للويب: ناجح.
- Web surface protocol: **18/18، fail 0**، ويشمل اختبار عدم تخزين تعليمات التوصيل الخام.
- API Wave 02: **9/9، fail 0**.
- السجل الختامي: `LOCAL_SUITE suite=wave02-card-reliability.test db=dinar_test_local_9cb171b14c6a exit=0 outbound=0`.

محطات GREEN السابقة، للتتبع لا للاستعاضة عن النهائي:

| Run | SHA | النتيجة |
|---|---|---|
| [40693124349](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40693124349) | `e9e2f5e` | Web 17/17، API 9/9 |
| [40694060981](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40694060981) | `6173c7d` | Web 18/18، API 9/9 |
| [40697062686](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40697062686) | `d110300` | Web 18/18، API 9/9 |

## 10. مصفوفة قبول التكرار والصلاحية

| السيناريو | الدليل والنتيجة |
|---|---|
| Double click | طلبان متتاليان أعادا `assistantMessage.id` نفسه، والكمية 1 |
| Retry after timeout | إعادة الطلب/المفتاح نفسه تعيد الإيصال؛ لا يُنشأ أثر ثانٍ. الاختبار يعيد الطلب الحتمي ولا يدّعي محاكاة عطل شبكة فعلي |
| Browser reload | مفتاح checkout محفوظ للنية نفسها؛ إعادة `/checkout` بالمفتاح والحمولة نفسيهما تعيد IDs الطلبات نفسها |
| Concurrent submission | `Promise.all` لطلبَي إضافة أعاد إيصالًا واحدًا وكمية 1 |
| Same request from two sessions | login ثانٍ أعاد الإيصال المخزن ولم تزد السلة |
| Resource changed before confirmation | إيقاف الإعلان بعد ظهور النتيجة أدى إلى 409 ولم تتغير السلة |
| Expired result set | تعديل `expiresAt` إلى الماضي أدى إلى 409 ولم تتغير السلة؛ الإيصال لا يحيي سلطة منتهية |
| Publication replay/conflict | المفتاح والحمولة نفسهما: `201` ثم `200` للإعلان نفسه وصف DB واحد؛ حمولة مختلفة: 409 |
| Checkout replay/conflict | إعادة المفتاح والحمولة: IDs نفسها؛ تغيير الكمية مع المفتاح نفسه: 409 |
| Terminal review | بطاقات CONFIRMED/CANCELLED/EXPIRED لا تعرض أي `<button>`؛ SEND الطرفي payload غير صالح |

## 11. دليل API التفصيلي

الاختبارات التسعة في `wave02-card-reliability.test.ts` تستخدم HTTP حقيقيًا على `127.0.0.1` وExpress وDrizzle/PostgreSQL، لا mock لقاعدة البيانات:

1. حضور مفردات الحالات والتحويل ورفض SEND الطرفي مع السماح بـNAVIGATE.
2. تجهيز بائع ومشترين وإعلانات ومجموعات نتائج عبر المسارات الحقيقية.
3. تكرار إضافة البطاقة: إيصال واحد ووحدة واحدة.
4. التزامن: إيصال واحد ووحدة واحدة.
5. جلسة ثانية: الإيصال نفسه ولا نمو في السلة.
6. مجموعة نتائج منتهية: 409 ولا تغيير.
7. إعلان متوقف بعد العرض: 409 ولا تغيير.
8. النشر: replay للإعلان نفسه وصف واحد، و409 لتعارض البصمة.
9. Checkout: replay للطلبات نفسها، و409 لتعارض الحمولة.

بوابة النموذج في الاختبار scripted وتفشل إذا طُلبت في هذه المسارات الحتمية؛ لم تُستخدم نتائج مخترعة ولم يُمنح النموذج قرار تنفيذ.

## 12. دليل قاعدة البيانات والعزل

- قاعدة Wave 02 النهائية: `dinar_test_local_9cb171b14c6a`، مؤقتة ومعزولة على loopback.
- قرأ الاختبار `offers` مباشرة وأثبت صفًا واحدًا للنشر المكرر.
- قرأ `/cart` بعد كل سيناريو وأثبت بقاء الكمية 1 أو عدم تغيرها بعد الرفض.
- قارن IDs رسائل الإيصال والطلبات بين الطلبات المتكررة والمتزامنة والجلسات.
- عدّل `aiResultSets.expiresAt` داخل قاعدة الاختبار لإثبات رفض السلطة المنتهية.
- قاعدة SC01: `dinar_test_local_6aabe4fb48dd`، وأثبت المسار وجود إعلان واحد وطلب واحد واكتماله بعد إعادة الفتح.
- كلتا المهمتين النهائيتين سجلتا `outbound=0`؛ لا اتصال بقاعدة إنتاج أو خدمة خارجية.

## 13. دليل المتصفح SC01

بعد فشل أول بسبب غياب علم محاكاة الدفع، أُعيد التشغيل بالعلمين المطلوبين.

**Run النهائي:** [40758523049](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40758523049)
**SHA:** `a997d133fd44712fa236ac61b106ceacfe3ab05c`
**النتيجة:** `SC01_SUMMARY result=PASS scope=REAL_E2E checks=37 steps=29`، وNode test **1/1**.

شملت 37 تحققًا:

- مسودة ومراجعة ونشر وتكرار «انشره» دون إعلان ثانٍ.
- بحث مستخدم آخر وإجابة المخزون دون حجز أو كشف هاتف البائع.
- مراجعة عرض 280 وإرساله وقبوله بعد مراجعة.
- مراجعة سعر الخادم وإنشاء طلب واحد، ثم اختيار كاش دون ادعاء تحصيل أموال.
- قبول البائع وتسجيل hand-off وتأكيد الاستلام حتى `COMPLETED`، ورؤية الطرفين للسجل نفسه بعد reopen.
- RTL وعدم الفيض وظهور المحتوى والأزرار داخل viewport بعروض **320 و390 و1280px** لكل المراحل المشمولة.

مؤشرات التشغيل: `pageErrors=[]` و`consoleErrors=[]` و`externalRequests=[]` و`modelFallbacks=[]` و`horizontalOverflow=0`، والسجل الختامي `exit=0 outbound=0`.

## 14. REGRESSION — البطارية وSHA كل تشغيل

| الحزمة | Run | SHA | النتيجة |
|---|---|---|---|
| Wave 02 card reliability | [40758023669](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40758023669) | `a997d13` | 9/9 |
| SC01 real browser journey | [40758523049](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40758523049) | `a997d13` | 1/1، 37 checks |
| block-f3 commerce | [40697336244](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40697336244) | `d110300` | 17/17 |
| block-f2 buyer | [40694646397](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40694646397) | `6173c7d` | 14/14 |
| universal negotiation | [40695030501](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40695030501) | `6173c7d` | 38/38 |
| Wave 4 payment simulation | [40695392899](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40695392899) | `6173c7d` | 1/1 |
| AI authority boundary | [40695865937](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40695865937) | `6173c7d` | 4/4 |
| Commerce | [40696165448](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/40696165448) | `6173c7d` | 23/23 |

التمييز مقصود: لا تُنسب حزم `6173c7d` إلى SHA النهائي. التغييران بعده كانا مشاركة مفتاح checkout بين tabs ثم تخزين digest بدل التعليمات؛ أُعيدت حزمة Wave 02 وsurface tests وSC01 على `a997d13`، وأُعيد block-f3 على `d110300`. كل الأجنحة المسجلة نجحت، والتشغيلات المعزولة الناجحة أبلغت صفر محاولات شبكة خارجية.

## 15. SECURITY REVIEW — المراجعة والتقوية الأخيرة

- **سلطة الخادم:** كل إضافة/نشر/checkout/تأكيد يعيد التحقق في الخادم؛ منع الزر في الواجهة دفاع عرض إضافي وليس بديلًا عن التحقق.
- **سلطة النموذج:** لم تُضف أداة model-facing ولم يتغير `exposedToModel: false`؛ المسارات الحتمية لم تستدعِ مزودًا.
- **الملكية والسوق:** بقيت فحوص المحادثة وresult set والمستخدم والسوق داخل التنفيذ.
- **التزامن والمعاملات:** قفل المستخدم والكتابة الذرية يمنعان ازدواج الأثر؛ لم تُزَل قيود أو تُخفَّف معاملات موجودة.
- **الانتهاء والتغير:** مجموعة منتهية أو إعلان متوقف يؤديان إلى 409 ولا يغيران السلة، حتى مع وجود إيصال سابق.
- **الخصوصية:** كشفت المراجعة أن نسخة المفتاح الأولى خزنت fingerprint الخام الذي قد يتضمن تعليمات توصيل أو هاتفًا/عنوانًا. أصلح commit `a997d13` ذلك بتخزين `{hash,key}` فقط في `checkout-request.ts:16`، وأضاف assertion في `checkout-request.test.ts:57` يثبت غياب النص الخام من storage.
- تصادم digest لا يمنح نجاحًا زائفًا لطلب مختلف؛ الخادم يقارن بصمة الحمولة ويرفض الاختلاف بـ409.
- لم تُضف أسرار أو اعتماديات أو تغييرات صلاحيات أو نشر. لم يُثبت هذا العمل إبطال PAT قديم؛ ذلك إجراء مستقل يؤكده المالك.

## 16. الأعطال وإعادات التشغيل وتصنيفها

1. **RED الأول توقف عند الويب:** لم يصل إلى API. أُنشئ دليل RED مستقل باستمرار خطوة الويب فقط؛ النتيجة الحمراء اللاحقة موثقة أعلاه.
2. **اختبار النشر الأحمر:** كان خطأ تأليف لغياب `Idempotency-Key`، لا عطل منتج. أُصلح الاختبار دون إضعافه.
3. **block-f3 run `40694385269`:** فشل 13/17 لأن الحزمة توقف علم Wave 4 مؤقتًا ثم تعيده؛ التشغيل بدأ بلا العلم فبقيت محاكاة الدفع معطلة. أُعيد بعلمي `BDINAR_BLOCKF_ACCEPTANCE=development` و`BDINAR_WAVE4_ACCEPTANCE=development`، فنجح run `40697336244` بنتيجة 17/17.
4. **SC01 run `40756444447`:** أكمل النشر والبحث والتفاوض والطلب ثم رد «الدفع غير متاح في هذه البيئة» وانتهت مهلة انتظار `purchase-review`. كان العلم الناقص سببًا تشغيليًا، لا عطل بطاقة؛ أُعيد على `a997d13` مع `BDINAR_TEST_DATABASE=development BDINAR_WAVE4_ACCEPTANCE=development` فنجح 37/37.
5. **الاستعلام الفوري بعد dispatch النهائي:** التقط run سابقًا `40756444447` قبل ظهور الجديد في قائمة GitHub. لم يُسجل كاختبار جديد؛ توبع المعرّف الفعلي `40758023669` وتحقق SHA `a997d13`.

الأوامر النهائية المستخدمة، دون أسرار:

```bash
GH="C:\Program Files\GitHub CLI\gh.exe"
"$GH" workflow run qoder-api-suite.yml \
  --ref qoder/12-wave02-card-reliability \
  -f suite=wave02-card-reliability.test \
  -f flags=BDINAR_WAVE02_ACCEPTANCE=development

"$GH" workflow run qoder-api-suite.yml \
  --ref qoder/12-wave02-card-reliability \
  -f suite=sc01-browser-journey.test \
  -f flags="BDINAR_TEST_DATABASE=development BDINAR_WAVE4_ACCEPTANCE=development"
```

نُفّذ dispatch بشكل تسلسلي على الفرع، وتوبع كل run بمعرّفه وSHA.

## 17. COMMIT / PUSH / الحكم وما لم يُفعل

commits الشيفرة والاختبارات المدفوعة على الفرع:

1. `3e637dd` — RED suite لدورة الحياة والانتهاء والتكرار.
2. `e9e2f5e` — توحيد دورة البطاقة وأثر واحد لإجرائها.
3. `6173c7d` — إثبات مفتاح checkout لكل نية عبر reload.
4. `d110300` — مشاركة المفتاح بين tabs.
5. `a997d13` — منع بقاء تعليمات التوصيل الخام في browser storage.

دُفع الفرع إلى `origin/qoder/12-wave02-card-reliability`، وكان working tree نظيفًا قبل إضافة وثيقة التقرير. تُضاف هذه الوثيقة بcommit توثيقي مستقل لا يغير شيفرة `a997d13` المختبَرة.

**الحكم:** متطلبات Wave 02 مغطاة بالتنفيذ والأدلة المذكورة، والبطاقات الطرفية لا تقدم SEND، والصلاحيات المنتهية/الموارد المتغيرة مرفوضة، والآثار المشمولة idempotent وخاضعة للخادم. لا يعني ذلك قبول إطلاق DINAR أو رفع بقية launch gates.

**ما لم يُفعل:** لم يُدمج إلى `main`، ولم يُنشر، ولم تُستخدم قواعد إنتاج، ولم يُفعّل دفع حقيقي أو AI مدفوع، ولم تُختبر أعطال شبكة مادية أو كل أحجام المتصفحات، ولم تُنسب اختبارات SHA قديم إلى SHA النهائي. إبطال PAT القديم باقٍ كإجراء مستقل يتطلب تأكيد المالك.
