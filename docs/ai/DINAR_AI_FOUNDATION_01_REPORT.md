# DINAR — تقرير AI-FOUNDATION-01

## 0. الحالة

**PARTIAL — البنية والأدوات والاختبارات والبوابات مكتملة وخضراء على PG16 وPG18 عند `c36e6f1`؛ يبقى التحقق من مزوّد حي خارج النطاق.**

- لا استدعاء مزوّد حي في هذه المهمة: `LIVE_PROVIDER_NOT_VERIFIED`.
- لا دمج إلى `main`، ولا نشر، ولا دفع حقيقي، ولا نماذج مدفوعة.
- لا يُعدّ D5 أو D6 مقبولًا نهائيًا بسبب نجاح اختبارات هذه المهمة. ما هنا يثبت أن مسار الذكاء الموحّد يحترم حدود D5/D6 القائمة، لا أنه يعتمدها.

## 1. القاعدة المعمارية

**النموذج الخارجي يفهم ويقترح. محرّكات DINAR القائمة تحسم وتنفّذ.**

لم يُنشأ chatbot مستقل، ولا agent runtime ثانٍ، ولا سوق موازٍ، ولا محرّك مالي موازٍ. التوسعة كلها داخل المسار الإنتاجي القائم:

| الطبقة | الملف | الدور |
|---|---|---|
| تفسير الدور | `artifacts/api-server/src/ai/model-turn.ts` | `dinarConversationTurn` مخطط strict؛ النموذج لا ينفّذ |
| البوابة | `artifacts/api-server/src/ai/model-gateway.ts` | واجهة محايدة للمزوّد، مع `fallback`/`heavy`/`AbortSignal` |
| الحلقة المحدودة | `artifacts/api-server/src/ai/smart-turn.ts` (`executeModelFallback`) | 3 استدعاءات أدوات كحد أقصى، ميزانيات زمن واستخدام، continuation دائم |
| حد الأدوات | `artifacts/api-server/src/ai/tool-registry.ts` | allowlist للقراءة فقط + `compareListings` الجديدة |
| سجل القدرات | `artifacts/api-server/src/ai/capability-registry.ts` | عقد واحد لخمس عشرة قدرة ولكل الأدوار |
| العرض | `artifacts/api-server/src/routes/ai.ts` | سطح `COMPARISON` من صفوف الخادم، لا من نص النموذج |

## 2. SHA والالتزامات

| البند | القيمة |
|---|---|
| الفرع | `replit/dinar-next-complete-development` |
| أساس الدمج | `5d9bca1` (آخر head بعيد قبل المهمة) |
| commit البنية | `ae8399b` — feat(ai): one capability registry and a bounded comparison read |
| commit الإصلاح | `4124607` — fix(ai): resume the read loop and withhold prose when every read is refused |
| commit الاختبار | `2a67135` — test(ai): inject through a model-routed turn, not the deterministic search |
| commit الاختبار | `c36e6f1` — test(ai): generate JO mobiles in a valid 79 range |
| SHA المختبَر | `c36e6f1` (كل بوابات القسم 12) |
| تعديلات غير مدفوعة سابقة | لا شيء؛ شجرة العمل كانت نظيفة عند البدء |

حُفظ تاريخ Replit كما هو (rebase فوق `5d9bca1`، بلا force push).

## 3. سجل القدرات الخمس عشرة

كل قدرة تعلن: اسم أداة ثابتًا، غرضًا، مخططي إدخال/إخراج Zod، الأدوار، الصلاحيات، نوع الأثر، التأكيد، idempotency، المهلة، السجل، والخدمة القانونية. لا توجد قدرة إدارية مخفية، ولا أداة يخترعها النموذج.

| # | القدرة | الأداة | النوع | الأثر | التأكيد | idempotency | الخدمة القانونية |
|---|---|---|---|---|---|---|---|
| 1 | `searchListings` | `searchListings` | MODEL_TOOL | READ_ONLY | NONE | READ_ONLY | `searchMarketplaceListings` |
| 2 | `listingFacts` | `getResource` | MODEL_TOOL | READ_ONLY | NONE | READ_ONLY | `searchMarketplaceListings` بتحقق حي |
| 3 | `compareListings` | `compareListings` | MODEL_TOOL | READ_ONLY | NONE | READ_ONLY | `compareRows` + `searchMarketplaceListings` |
| 4 | `readInventory` | `READ_INVENTORY` | SERVER_ONLY | READ_ONLY | NONE | READ_ONLY | `delegatedSellerModelContext` |
| 5 | `readBusinessInquiries` | `INQUIRY_VIEW` | SERVER_ONLY | READ_ONLY | NONE | READ_ONLY | `listInquiries`/`inquiryForParty` |
| 6 | `prepareInquiryReply` | `DRAFT_INQUIRY_REPLY` | SERVER_ONLY | PREPARE_ONLY | USER_CONFIRMATION | IDEMPOTENCY_KEY | `executeInquiryTurn` |
| 7 | `prepareListingDraft` | `DRAFT_LISTING` | SERVER_ONLY | PREPARE_ONLY | USER_CONFIRMATION | IDEMPOTENCY_KEY | `listingDraft` |
| 8 | `requestPublicationReview` | `REQUEST_PUBLICATION_REVIEW` | SERVER_ONLY | PREPARE_ONLY | USER_CONFIRMATION | IDEMPOTENCY_KEY | `executeDraftActionTurn` |
| 9 | `readNegotiationStatus` | `NEGOTIATION_VIEW` | SERVER_ONLY | READ_ONLY | NONE | READ_ONLY | `executeNegotiationTurn` |
| 10 | `prepareNegotiationProposal` | `SEND_NEGOTIATION_OFFER` | SERVER_ONLY | PREPARE_ONLY | USER_CONFIRMATION | IDEMPOTENCY_KEY | `priceProposal` + `executeNegotiationTurn` |
| 11 | `readBuyerCart` | `CART_VIEW` | SERVER_ONLY | READ_ONLY | NONE | READ_ONLY | `getMarketplaceCart` |
| 12 | `prepareCartMutation` | `addToCart` | SERVER_ONLY | MUTATING | USER_CONFIRMATION | IDEMPOTENCY_KEY | `addMarketplaceCartItemOnce` |
| 13 | `reviewCheckout` | `CHECKOUT_REVIEW` | SERVER_ONLY | PREPARE_ONLY | USER_CONFIRMATION | IDEMPOTENCY_KEY | `executeCommerceTurn` |
| 14 | `readAuthorizedOrders` | `READ_ORDERS` | SERVER_ONLY | READ_ONLY | NONE | READ_ONLY | `orderContext` |
| 15 | `readFulfillmentStatus` | `DELIVERY_STATUS` | SERVER_ONLY | READ_ONLY | NONE | READ_ONLY | `executeDeliveryTurn` |

الأدوات الثلاث المعروضة للنموذج فقط هي `searchListings` و`getResource` و`compareListings`، وهي نفسها `MODEL_LOOP_TOOL_ALLOWLIST`. الباقي يُصل إليه عبر تدفقاته الحتمية أو مراجعاته وتأكيداته القائمة.

## 4. مصفوفة التصريح

| القدرة | BUYER | SELLER | SELLER_EMPLOYEE | الصلاحية |
|---|:---:|:---:|:---:|---|
| `searchListings` | ✅ | ✅ | — | `marketplace.read` |
| `listingFacts` | ✅ | ✅ | — | `marketplace.read` + ملكية نتيجة المحادثة |
| `compareListings` | ✅ | ✅ | — | `marketplace.read` + ملكية نتيجة المحادثة |
| `readInventory` | — | ✅ | ✅ | `business.inventory.read` |
| `readBusinessInquiries` | ✅ | ✅ | ✅ | `inquiry.party` |
| `prepareInquiryReply` | — | ✅ | ✅ | `business.inquiries.reply` + `business.messages.send` |
| `prepareListingDraft` | — | ✅ | ✅ | `business.catalog.draft` (+ `.price` عند ذكر سعر) |
| `requestPublicationReview` | — | ✅ | ✅ | `business.catalog.draft` |
| `readNegotiationStatus` | ✅ | ✅ | ✅ | `negotiation.party` |
| `prepareNegotiationProposal` | ✅ | ✅ | — | `negotiation.party` |
| `readBuyerCart` | ✅ | — | — | `cart.owner` |
| `prepareCartMutation` | ✅ | — | — | `marketplace.cart.write` + ملكية النتيجة |
| `reviewCheckout` | ✅ | — | — | `cart.owner` |
| `readAuthorizedOrders` | ✅ | ✅ | ✅ | `order.party` / `business.orders.read` |
| `readFulfillmentStatus` | ✅ | ✅ | ✅ | `fulfilment.party` / `business.orders.read` |

`ADMIN` غير موجود في أي قدرة أو دور. جلسة الموظف ليست سلطة دائمة: كل استدعاء يعيد التحقق من الجلسة والتفويض والكتالوج قبل الاستخدام (منطق D5 القائم).

## 5. آلة حالة الحلقة

```
دور المستخدم
  │
  ├─ اختيار المسار (LEGACY / MODEL_FIRST) — قابل للعكس عبر الإعداد
  │
  ▼
دور النموذج #0 (حجز استخدام)
  │  toolRequest؟
  ├─ لا ─────────────► جواب نهائي أو رفض آمن
  │
  └─ نعم
      ├─ toolCallCount ≥ 3؟ ───────────► CALL_LIMIT + أفضل نتيجة متحققة جزئية
      ├─ الانتهاء ≥ 25s؟ ──────────────► TIME_LIMIT + أفضل نتيجة متحققة جزئية
      ├─ التوقيع مكرر؟ ────────────────► DUPLICATE + أفضل نتيجة متحققة جزئية
      ├─ الأداة غير معروضة/غير مصرح؟ ──► REJECTED + تغذية راجعة ثم دور نموذج تالٍ
      └─ تنفيذ الأداة (حد 3.5s داخل المهلة الكلية)
            ├─ SEARCH: حفظ resultSet + إرجاعه للنموذج
            ├─ RESOURCE: إعادة تحقق حية؛ غياب السجل = TARGET_UNAVAILABLE
            └─ COMPARISON: ملكية/سوق/انتهاء + إعادة تحقق حية لكل المواضع
                  └─ أي موضع غير حي = TARGET_UNAVAILABLE (لا مقارنة من لقطة قديمة)
      │
      └─► دور نموذج تالٍ (حجز جديد) حتى الحل أو حد آمن

الاستمرارية: بعد كل أداة تُحفظ التوقيعات والتغذية الراجعة في
messages.metadata.modelToolContinuation؛ الاستئناف يتطلب عمر ≥ 60s،
resumeCount < 5، وتطابق actor/conversation/market/message. دور مستأنَف
يعود إلى الحلقة نفسها مباشرة (لا يعاد تفسيره حتميًا)، فيُرفض التوقيع
المحفوظ قبل تنفيذ أي أداة أخرى.

الانقطاع: مزوّد فشل/تجاوز وقت بعد قراءة متحققة ⇒ تُعاد القراءة المتحققة
مع ملاحظة صادقة، ولا يُعرض نص النموذج غير المكتمل ولا يُعاد أي تغيير.
وإذا حاول النموذج قراءات ورُفضت كلها دون أي قراءة متحققة ⇒ يُحجب نص
النموذج ويُعاد رفض خادم صريح؛ لا تُعرض أي معلومة غير متحققة بدلًا منها.
```

## 6. البروتوكول

- **أداة النموذج**: JSON strict (`additionalProperties: false`)، أسماء من قائمة ثابتة، والوسائط تمر بـZod `.strict()`.
- **المراجع**: النموذج يذكر `resultSetId` (UUID من نتيجة محادثته) وموضعًا/معرّفًا ظاهرًا، لا معرّفات داخلية جديدة ولا صلاحيات.
- **النتيجة للنموذج**: شكل مضغوط محدود (5 عروض، 12 صفًا، 8 إبرازات، نصوص مقصوصة) داخل `<dinar_tool_results>` موسوم كبيانات غير موثوقة.
- **النتيجة للمستخدم**: سطح `COMPARISON` يُبنى من صفوف DINAR (`RECORD`/`SELLER`/`DERIVED`)، ونصه من `prompt` الخادم لا من نص النموذج.
- **الفشل**: `{ tool, status, code }` مع `code` من `ToolRejectionCode` أو `READ_FAILED`/`READ_TIMEOUT`/`REPEATED_READ_BLOCKED`/`INVALID_ARGUMENTS`.

## 7. الاستمرارية ومصدر الحقيقة

| الحالة | المكان | ملاحظة |
|---|---|---|
| نتيجة بحث/مقارنة | `aiResultSets` (`conversationId`, `marketId`, `messageId`, `query`, `resourceIds`, `expiresAt`) | تُقرأ بتحقق الملكية والسوق والانتهاء |
| تقدّم الحلقة | `messages.metadata.modelToolContinuation` | ليس ذاكرة عملية فقط؛ ينجو من إعادة تحميل الصفحة وإعادة تشغيل العملية |
| المراجعات والإجراءات | جداول pending action القائمة + action receipts | النموذج لا يملك سجلًا؛ السجل للخادم |
| الرد | `messages` + `aiUiBlocks` | الرحلة تعمل من قاعدة البيانات بعد reload/restart |

## 8. معالجة الأخطاء والسلامة

- **هدف قديم**: عرض واحد غير حي ⇒ `TARGET_UNAVAILABLE`، دون إرجاع لقطة قديمة. إن كانت هناك قراءة سابقة متحققة تُعاد مع ملاحظة أن المقارنة لم تتم.
- **انقطاع المزوّد أو تجاوز الوقت**: تُعاد أفضل قراءة متحققة مع ملاحظة عربية صادقة؛ لا يُنسب نص غير مكتمل للمستخدم.
- **حدود التكلفة**: حجز لكل دور، سقف استدعاءات، سقف زمن، حد استخدام يوقف الحلقة بأمان.
- **الاطلاع**: التغذية الراجعة مقصوصة ومحدودة؛ لا أسرار، لا هواتف، لا إحداثيات، لا مفاتيح.
- **التصريح**: `executeModelTool` يرفض غياب الفاعل/رسالة المصدر/السوق غير المتاح، وتُعاد كل فحوص الملكية عند التنفيذ لا عند الاقتراح.
- **الحقن**: نصوص الإعلانات والاستفسارات تُسلَّم كبيانات غير موثوقة؛ `addToCart` غير معروض للنموذج أصلًا، والنشر يحتاج مراجعة المالك.

## 9. إثبات retry وidempotency

- كل أدوات النموذج `READ_ONLY`؛ لا تغيير حالة من الحلقة.
- التوقيع `sha256(stableJson(args))` يمنع إعادة القراءة نفسها داخل الدور وبعد الاستئناف.
- كل القراءات تعيد بناء النتيجة من السجلات الحية لا من الاقتراح.
- اختبارات الانقطاع والتكرار تتحقق من أن السلة والطلبات تبقى صفرًا وأن عدد مجموعات النتائج لا يتضاعف.
- التغييرات الفعلية (سلة، نشر، دفع) تبقى خارج النموذج: مراجعة + تأكيد + مفتاح idempotency في الخدمة القائمة.

## 10. الأمان

- لا سلطة إدارية، ولا أدوات مخفية، ولا معرّفات يخترعها النموذج.
- حدود المالك/المحادثة/السوق/الانتهاء تُفحص عند كل تنفيذ.
- جلسة الموظف تُعاد التحقق منها ومن التفويض والكتالوج قبل أي نتيجة.
- أسرار المزوّد لا تدخل السياق؛ البوابة تتعامل مع الرموز لا المفاتيح، والبصمة sanitized.
- اختبارات الحقن تغطي وصف الإعلان وتغذية الأدوات ونص النموذج، وتثبت أن «تم النشر/أضفت للسلة» لا يظهر كإنجاز.

## 11. الاختبارات

### 11.1 حزمة القبول الجديدة (`ai-foundation-acceptance.test.ts`)

| المعرّف | ما يثبته |
|---|---|
| AI-F01 | 15 قدرة، أسماء فريدة، حقول مطلوبة، لا ADMIN، تأكيد للمتحوّلة، 3 أدوات نموذج فقط، والسجل يطابق allowlist |
| AI-F02 | بحث ثم مقارنة: 3 نداءات، سطح خادم، صفوف سعر/علامة، تسميات المصدر، لا نص نموذج، مجموعة نتائج واحدة |
| AI-F03 | عرض متوقف بعد البحث: `TARGET_UNAVAILABLE`، لا مقارنة، ملاحظة خادم، بقاء البحث المتحقق، لا سلة/طلب |
| AI-F04 | مجموعة نتائج محادثة أخرى وسوق أجنبي: رفض عند التنفيذ، لا تسريب، لا حفظ للضحية |
| AI-F05 | مجموعة نتائج منتهية: رفض `getResource` و`compareListings` |
| AI-F06 | تكرار المقارنة: توقّف، سطح واحد، مجموعة واحدة |
| AI-F07 | حد الاستدعاءات: لا استدعاء رابع، مقارنة متحققة واحدة |
| AI-F08 | مهلة النموذج بعد قراءة: نتيجة جزئية متحققة، لا نص غير مكتمل |
| AI-F09 | انقطاع المزوّد بعد قراءة: نتيجة جزئية آمنة |
| AI-F10 | حقن في وصف الإعلان: لا `addToCart`، لا نشر، لا ادعاء إنجاز |
| AI-F11 | نتائج كبيرة: النموذج ≤ 5 عروض و< 12,000 حرف، المخزون الكامل محفوظ |
| AI-F12 | استئناف دور قديم: التوقيع المحفوظ يمنع إعادة الأداة |
| AI-F13 | خارج النطاق: لا فاعل، سوق غير نشط، وأداة متحوّلة تُرفض |

### 11.2 الاختبارات القائمة المحدّثة

- `ai-authority-boundary.test.ts`: أربع أدوات معروضة في السجل العام (بما فيها `openSurface` خارج الحلقة)، والحلقة ثلاث قراءات، و`addToCart` غير معروض.
- `model-native-routing.test.ts` D6-AI-01: أربع أدوات معروضة للنموذج، والسلوك نفسه (3 نداءات).

### 11.3 البوابات

| البوابة | الأمر/الـworkflow | النتيجة |
|---|---|---|
| Typecheck + build API + build web | `qoder-api-suite.yml` (خطوة سابقة للحزمة) | ✅ نجحت في كل تشغيلات القسم 12 |
| سلسلة AI | `chain=ai-foundation` على PG16 وPG18 | ✅ 13/13 + 4/4 + 3/3 على الإصدارين |
| تراجع D4/D5 | `chain=d4-d5-authorization` | ✅ 3/3 حزم على PG16 وPG18 |
| تراجع D6/G2/التفاوض | `chain=d6-g2-negotiation` | ✅ 8/8 حزم على PG16 وPG18 |

## 12. الأدلة

**SHA المختبَر:** `c36e6f18c80a6f2aed452230bb03c7c42d44fb13` — `c36e6f1` على `replit/dinar-next-complete-development`.

### 12.1 سلسلة AI-FOUNDATION (POSIX، قاعدة معزولة مُهاجَرة لكل حزمة)

| البوابة | PostgreSQL | Run ID | النتيجة |
|---|---|---|---|
| `chain=ai-foundation` | 16 | `41532774226` | prelude 32/32، `ai-foundation-acceptance.test` **13/13** exit=0، `ai-authority-boundary.test` **4/4** exit=0، `bounded-multistep.test` **3/3** exit=0، `LOCAL_SUITE_CHAIN suites=3 exit=0 first_failed=none` |
| `chain=ai-foundation` | 18 | `41533191198` | نفس النتائج: 32/32، 13/13، 4/4، 3/3، chain exit=0 |

كل سطر `LOCAL_SUITE` في التشغيلين انتهى بـ`outbound=0`: لا اتصال شبكي خارجي ولا استدعاء مزوّد حقيقي.

### 12.2 أدلة قاعدة البيانات داخل الحزمة

- AI-F02/F11: مجموعة نتائج بحث واحدة محفوظة في `ai_result_sets` لكل دور؛ AI-F11 يثبت أن المسجَّل يحتفظ بكل المطابقات (≥7) بينما النموذج يرى ≤5 عروض و<12,000 حرف.
- AI-F01/F13: السجل والأدوات تُختبر مباشرة؛ لا أداة متحوّلة في مسار النموذج.
- AI-F04/F05/F12: `executeModelTool` يرفض نتيجة محادثة أخرى، مجموعة منتهية، وإعادة توقيع، دون أي صف `ai_result_sets` إضافي للضحية.
- AI-F02/F03/F06/F07/F08/F09/F10/F13: `cart_items` و`orders` تبقى بصفر صفوف لكل مستخدم اختبار بعد كل مسار.

### 12.3 بوابات التراجع (G16)

| البوابة | PostgreSQL | Run ID | الحزم |
|---|---|---|---|
| `chain=d4-d5-authorization` | 16 | `41533608341` | `business-delegations`، `d5-seller-employee-acceptance`، `d4-d5-isolation-security` — كلها exit=0، chain exit=0 |
| `chain=d6-g2-negotiation` | 16 | `41533655874` | 8 حزم (G2، التفاوض، التوجيه، متعدد الخطوات، الترويج، F2/F3) — كلها exit=0، chain exit=0 |
| `chain=d4-d5-authorization` | 18 | `41534094530` | 3/3 exit=0، chain exit=0 |
| `chain=d6-g2-negotiation` | 18 | `41534101977` | 8/8 exit=0، chain exit=0 |

### 12.4 أثر التكرار (اختبارات حمراء قبل الأخضر)

| SHA | Run ID | النتيجة |
|---|---|---|
| `ae8399b` | `41529020814` | 8/13 — كشفت أن F04 يعيد نص النموذج، وF05 ينتهك FK الرسالة، وF07/F11/F12 لا تصل إلى الحلقة |
| `4124607` | `41531273989` | 12/13 — بعد إصلاح الاستئناف وحجب النص؛ بقي F10 يكشف اعتمادًا على حالة قديمة |
| `c36e6f1` | `41532774226` + `41533191198` | 13/13 أخضر على PG16 وPG18 |

### 12.5 ما لا يُثبته هذا الدليل

- لا استدعاء مزوّد حي: `LIVE_PROVIDER_NOT_VERIFIED`. البوابة في الحزمة نصية محقونة، فهي تثبت التنسيق والحدود والاستمرارية، لا جودة الفهم العربي لنموذج حي.
- لا دليل متصفح لهذه المهمة: التغيير في مسار API/التنسيق ولا يغيّر واجهة؛ لم يُشغَّل متصفح.
- لا قبول نهائي لـD5/D6 من هذه الحزمة؛ بوابات التراجع تثبت عدم الانحدار فقط.

## 13. القيود والمخاطر

1. **لا مزوّد حي**: كل الأدلة من بوابة نصية محقونة؛ جودة الفهم العربي الحية غير مقاسة. `LIVE_PROVIDER_NOT_VERIFIED`.
2. **`compareListings` قراءة جديدة**: تعيد استخدام `compareRows` القائم؛ إن تغيّر عقد صفوف المقارنة يجب تحديث `outputSchema` في السجل معه.
3. **المهل الزمنية**: سقف الأداة 3.5s والسقف الكلي 25s؛ بحث بطيء جدًا قد يعيد نتيجة جزئية بدل اكتمال — سلوك مقصود وآمن لكنه ليس اكتمالًا.
4. **التزامن**: الحلقة لكل رسالة مستخدم؛ لا قفل عام، وتعتمد على مفاتيح idempotency القائمة للكتابة.
5. **الحدود التشغيلية**: لا ادعاء قابلية مليون مستخدم؛ القياسات الحالية هي حدود الحلقة فقط.
6. **D5/D6**: نجاح هذه الحزمة لا يعني قبولهما؛ يحتاجان قبولهما المستقل ومراجعاتهما.

## 14. متطلبات المزوّد الحي (خارج نطاق هذه المهمة)

- مفتاح مزوّد ونموذج مسعّران في `market-capability-registry` مع سياسة تكلفة تقبل النموذج.
- اختبار حي منفصل وبوابة موافقة صريحة، مع تسجيل الاستخدام والزمن والفشل.
- إثبات أن `fallback` لا يعيد تشغيل تغيير مُثبَّت، وأن حد الاستخدام يعمل تحت الحمل.
- مقارنة عربية حقيقية (فصحى/لهجات/إنجليزي مختلط) — لا تُستنتج من بوابة محقونة.

## 15. الخطوة التالية

اكتملت البوابات على PG16 وPG18 عند `c36e6f1`، وسُجّلت المعرّفات في القسم 12، والتقرير العربي جاهز. التوقف هنا:
لا دمج إلى `main`، لا نشر، لا دفع حقيقي، لا نماذج مدفوعة، ولا بدء أعمال D7/D9.
