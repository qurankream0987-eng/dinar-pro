# DINAR — عقود الأدوات الموثوقة

## 1. عقد التفسير `dinarConversationTurn` (v1، مع توسعة إضافية)

| البند | القيمة |
|---|---|
| الإصدار | v1. الحقل الجديد اختياري، فالعملاء والمحوّلات القديمة متوافقة |
| مخطط الدخول والخروج | `ModelTurnOutput` (Zod، `.strict()`) ومطابِقه `MODEL_TOOL.parameters` (JSON، `additionalProperties: false`). مطابقة آلية في `ai-provider` R3 (47/47) |
| الحقل الجديد | `canonicalRequest?: string` (2–160) |
| الصلاحية | النموذج لا ينفّذ. كل اقتراح يمر بالـruntime |
| الأثر الجانبي | لا شيء من العقد نفسه |
| الأخطاء | `MALFORMED`، `TIMEOUT`، `UNAVAILABLE`، `QUOTA_LIMITED`، `NOT_CONFIGURED` (موجودة) |
| السجل | `dinar_ai_model_call` (مسارات ورموز فقط، لا قيم) و`dinar_ai_canonical_request` (الوضع، والقبول، والسبب، والطول، **دون النص**) |
| حساسية البيانات | سياق منقّح (`redactForModel`) ومحدود (`MAX_MODEL_INPUT_CHARS`) |

## 2. عقد الدخول من جديد (`canonicalRequest` ← runtime)

| البند | القيمة |
|---|---|
| المدخل | نص المستخدم الأصلي، والطلب القانوني، والسوق |
| التحقق (`canonicalRequestProblem`) | `EMPTY` و`TOO_LONG` و`DECISION` (نعم/أرسل/ادفع/أوافق/انشر/اعتمد…)، و`CONTACT` (هاتف للسوق، أو 8+ أرقام، أو بريد، أو رابط)، و`SAME_AS_MESSAGE` |
| التنفيذ | `executeAiConversationTurn({...context, message: canonical}, {planStep: true, noModel: true})`، أي callback الـcapability القائم |
| النتيجة | دور DINAR بكامل فحوصه، ومعه `modelRouted.canonicalRequest` للتشخيص |
| رفض نتيجة | CLARIFY من الدخول من جديد يُرجع null، فيبقى جواب النموذج |
| idempotency | كالدور العادي (مراجعات F0، ومفاتيح الطلب) |

## 3. أدوات `tool-registry` (بلا تغيير)

| الأداة | الإصدار | الأثر | التأكيد | مكشوفة للنموذج |
|---|---|---|---|---|
| `openSurface` | 1 | قراءة | — | نعم (قائمة مقيّدة) |
| `searchListings` | 1 | قراءة | — | يقترحها، والخادم ينفذ |
| `getResource` | 1 | قراءة | — | نعم (معرّف من نتائج سابقة فقط) |
| `recommendListings` | 1 | قراءة | — | خادم |
| `restoreResults` | 1 | قراءة | — | خادم |
| `addToCart` | 1 | **كتابة** | مراجعة + «نعم» | **لا** |

## 4. القدرات التي يصل إليها النموذج بالدخول من جديد (أمثلة مختبرة)

| الطلب القانوني | المعالج | الاختبار |
|---|---|---|
| «ابحث عن جوال بكسل …» | البحث | MN-02 وMN-03 |
| «ابي الأول» | `purchaseReview` (مراجعة فقط) | MN-04 |
| «الأول كم سعره؟» | `listingPriceAnswer` | MN-06 |
| «نعم أكد الشراء» | **مرفوض** (`DECISION`) | MN-04 |
| «أوافق على الشروط المحدثة» | **مرفوض** (`DECISION`) | MN-04 |
| «اسأل البائع اتصل بي على 07…» | **مرفوض** (`CONTACT`) | MN-04 |

## 5. تكامل Qoder

لا يلزم الآن عقد backend جديد من Qoder. يلزم مستقبلًا (W07–W10) أن تبقى عمليات المال والاسترداد والدعم خلف مراجعة وتأكيد حتميين، حتى يستمر رفض `DECISION`.
