# DINAR — جرد الذكاء القائم

**الأساس:**
- الفرع `claude/08-model-native`.
- الأساس `e17fad2`: W04 وW02-ULTRA وB10.

**المصدر:** ترتيب المعالجات الفعلي في `artifacts/api-server/src/ai/conversation-runtime.ts`، مستخرجًا من الكود لا من التوثيق.

**التصنيف (§01.2):**

| الرمز | المعنى |
|---|---|
| A | تفسير لغوي عام |
| B | ذكاء سوق متخصص |
| C | حساب أو استرجاع حقائق موثوق |
| D | ثابت أمني أو صلاحية |
| E | سياق أو ذاكرة أو إجراء معلق |
| F | عرض أو بطاقة |
| G | مسار احتياطي حتمي أو تحسين أداء |
| H | بنية اختبار |
| I | قديم أو مكرر |

## 1. مسار الدور (بالترتيب الذي ينفّذه الكود)

| # | المكوّن | الملف | الفئات | ما يفعله |
|---|---|---|---|---|
| 1 | `withoutAcknowledgement` | conversation-runtime | A | يحذف «تمام/طيب» البادئة |
| 2 | `executeTaskPlanTurn` | task-plan | E،B | يقسم الطلب المركّب إلى ≤3 خطوات، تُنفّذ واحدة لكل «التالي». لا يصطف تأكيد |
| 3 | تصحيح R3E (`repair`) | conversation-runtime | A،E | «أقصد…»، «مو هذا، العرض» يُصلح القراءة في سياقها |
| 4 | قرار التوجيه (`AUTH_REQUIRED`، `MARKET_REQUIRED`) | conversation-runtime + api-zod registry | D | يفرض الدخول والسوق قبل أي إجراء |
| 5 | `executeProductControlTurn` | product-control-turn | B،F | السمة والسوق والخطط (قدرات المنتج) |
| 6 | `executeEmploymentTurn` | employment-turn | B،E | الوظائف |
| 7 | `executePersonalMemoryTurn` | personal-memory-turn | E | الذاكرة الشخصية بموافقة |
| 8 | `executeModelFallback` (التعريف) | smart-turn | A | النموذج: تفسير واقتراح فقط |
| 9 | `executePolicyTurn` | policy-turn (B10) | D،F | مراجعة الشروط وقبول النسخ الحالية فقط |
| 10 | `executeOrderContactRequest` | buyer-turn | D | رقم البائع لا يُكشف إلا بطلب مؤكد |
| 11 | `executeInquiryTurn` | inquiry-turn | B،E،D | مسودة استفسار، وتعديل وإضافة، ورفض أرقام التواصل، وإرسال بتأكيد |
| 12 | `executeNegotiationTurn` | negotiation-turn | B،E،C | التفاوض بمراجعة |
| 13 | `executeDriverTurn` | driver-turn | B | السائقون |
| 14 | `executeSellerAdviceTurn` | seller-management | B | نصائح البائع من بياناته |
| 15 | `executeCommerceTurn` | commerce-turn | B،C | الأرصدة والترويج التجاري |
| 16 | `executeCartConversationTurn` | conversation-runtime | E،C | السلة |
| 17 | `executeSmartTurn` | smart-turn | A،B | الاستشارة الذكية |
| 18 | `executeProviderTurn` | provider-turn | D | ربط المزودين |
| 19 | `executePurchaseTurn` | buyer-turn | E،C،D | مراجعة، ثم تأكيد، ثم checkout القانوني |
| 20 | `executeDraftActionTurn` | draft-actions | E،D | نشر المسودة بتأكيد عبر `createListingForActor` |
| 21 | `executeDeliveryTurn` / `executePromotionTurn` | delivery-turn / promotion-turn | B،E | التوصيل والترويج |
| 22 | `executeSellerListingManagementTurn` | seller-management | B،E،D | تعديل إعلان البائع بمعاينة |
| 23 | `executeRegisteredTool` | tool-registry | B،C | البحث والاسترجاع والتوصية (للقراءة) |
| 24 | `executeBuyerTurn` | buyer-turn | A،B،C،E | المراجع والترتيب والتعديلات والسقف والمقارنة و«أيهم» والكمية والاختيار |
| 25 | `executeStockQuestion` | stock-question | C | المخزون من السجل |
| 26 | `executeListingFactQuestion` | listing-fact-question | C،B | السعر والصفات من السجل، أو مسودة سؤال للبائع |
| 27 | تفسير السوق (`interpretMarketplaceTurn` و`parseStructuredSearch`) | marketplace-intent / search-query | A،B | فلاتر وترتيب وفئة من العربية |
| 28 | النموذج كاحتياط أخير | smart-turn | A | ما لم يأخذه أي معالج |

## 2. المكتبات المشتركة

| المكوّن | الملف | الفئات |
|---|---|---|
| طيّ عربي (حروف ولهجات بمعنى واحد) وأرقام ومقارنات ونفي | arabic-normalization | A،G |
| مطابقة الرموز والمرادفات والإرخاء المُبلَّغ عنه | lib/arabic-search-terms | B،G |
| بحث السوق بالفئة والفلاتر والسياسة | lib/marketplace-listings | B،C،D |
| غلاف البطاقة v1 والمكوّنات | card-envelope + api-zod/surface-composition | F،D |
| مراجعة ثم تأكيد ثم تنفيذ، ودفتر الإجراءات والإيصالات | action-foundation / action-receipts | D،E |
| بوابة النموذج المعدودة وتنقيح البيانات وحدود المخرجات | model-gateway / model-turn | A،G،D |
| حجوزات وتسوية الإنفاق | lib/ai-spend | D |
| نص الإعلان دون بيانات تواصل | lib/listing-contact | D |
| بوابة قبول الشروط | lib/policy-gate | D |

## 3. أدوات `tool-registry` (حدود النموذج)

| الأداة | مكشوفة للنموذج؟ | الأثر |
|---|---|---|
| `openSurface` | نعم، بقائمة مقيّدة (`MODEL_OPEN_SURFACE_TOKENS`) | قراءة أو عرض |
| `searchListings` | يقترحها النموذج، والخادم ينفذ | قراءة |
| `getResource` | نعم | قراءة |
| `recommendListings` | الخادم | قراءة |
| `restoreResults` | الخادم | قراءة |
| `addToCart` | **لا** | كتابة، تصل فقط عبر مراجعة وتأكيد |

## 4. بنية الاختبار (H)

- `test/isolation/*`: قاعدة جديدة لكل suite، وnet-guard، وstub.
- `sc-ui-session.mjs`: جلسات المتصفح.
- مجموعات القياس:
  - `context-understanding`: C وH وG، أول تماس 3/16 و9/14 و3/10.
  - `context-sealed`: أول تماس 6/18، ومخالفتا أمان.
  - `arabic-generality`.

## 5. قديم أو مكرر (I)

**لا شيء.** لم يُصنَّف أي مكوّن قديمًا. ولم يُحذف شيء في هذه الموجة.
