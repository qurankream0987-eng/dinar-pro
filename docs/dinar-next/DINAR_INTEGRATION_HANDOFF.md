# DINAR — دليل تسليم التكاملات الخارجية

**التاريخ:** 2026-10-22 · **المرجع البرمجي:** `main` حتى commit `0c4f017` · **الجمهور:** المالك، Replit Agent (QA والبنية)، مهندس التكامل.

هذا الدليل يحدد لكل مزود خارجي: الاعتمادات، أسماء متغيرات البيئة، المحول (adapter) الدقيق في الشيفرة، خطوات الإعداد، اختبارات sandbox، شروط قبول الإنتاج، وإجراء الفشل والتراجع. **لا يوجد اليوم أي مزود خارجي موصول في staging أو الإنتاج.** كل دليل اختبار مذكور هنا محاكاة (MOCKED) ما لم يُكتب «حي».

## قواعد مشتركة لكل مزود

1. **لا اختيار مزود دون قرار المالك.** لا تُضاف أسماء اعتمادات لمزود لم يُختر؛ الأسماء أدناه موجودة في الشيفرة فعلًا، وما هو «يُحدَّد عند الاختيار» لم يُخترع بعد عمدًا.
2. **التسجيل شيفرة لا إعداد.** المحول يُسجّل في الخادم (`ProviderRegistration` أو `register…Provider`)؛ وجود الاعتماد وحده لا يجعل المزود «موصولًا» (`GET /admin/integrations/readiness` يعكس ذلك).
3. **سياسة السوق.** العائلات المرتبطة بالسوق تُحل عبر `resolveMarketProvider` (`artifacts/api-server/src/lib/market-capability-registry.ts`) وتتطلب إدخالًا صريحًا في `MARKET_PROVIDER_POLICY_BY_COUNTRY[countryCode][family] = providerKey` (فارغ اليوم).
4. **البيئة.** `DINAR_DEPLOYMENT_ENV` = `development` | `staging` | `production`؛ غير الموسوم يفشل مغلقًا. وضع التسجيل: development→`DEVELOPMENT`، staging→`SANDBOX`، production→`LIVE`.
5. **الإنتاج.** أي مزود `LIVE` يتطلب أيضًا `DINAR_LIVE_PROVIDERS_ENABLED=true`. هذا المفتاح هو مفتاح الإيقاف العام: إزالته تعطل كل المزودين الحيين دون تغيير شيفرة.
6. **الخصوصية.** لا يُرسل لأي مزود: كلمات مرور، أرقام هاتف (إلا لمزود SMS نفسه)، إحداثيات دقيقة (إلا لمزود موقع/خرائط ضمن طلب مصرح)، أو نصوص حرة في الإشعارات والمراقبة.
7. **التراجع العام.** (أ) أزل إدخال سياسة السوق أو `DINAR_LIVE_PROVIDERS_ENABLED`؛ (ب) أعد النشر السابق؛ (ج) دوّر الاعتماد لدى المزود إذا اشتُبه بتسربه. كل الوظائف المعتمدة على مزود مصممة لتعود إلى «غير متاح» صريح لا إلى نجاح وهمي.

---

## 1. نموذج AI النصي (AI_TEXT)

| البند | التفاصيل |
|---|---|
| المحول | `src/ai/model-gateway.ts` (`createConversationModelGateway`)، تسجيله في `src/ai/model-turn.ts` (`modelGatewayRegistration` — **development فقط اليوم**) |
| المزودون المدعومون | `GROQ`، `OPENROUTER`، `OPENAI`، `REPLIT_OPENAI`، `OPENAI_COMPATIBLE` (محايد) |
| متغيرات البيئة | `DINAR_AI_PROVIDER`، `DINAR_AI_MODEL`، `DINAR_AI_BASE_URL` (لـ OPENAI_COMPATIBLE، HTTPS فقط)، `DINAR_AI_API_KEY` أو اعتماد المزود (`GROQ_API_KEY`، `OPENROUTER_API_KEY`، `OPENAI_API_KEY`، `AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL`)؛ احتياطي اختياري `DINAR_AI_FALLBACK_PROVIDER/MODEL/BASE_URL/API_KEY`؛ `DINAR_AI_MAX_RETRIES` (0–2)، `DINAR_MODEL_TIMEOUT_MS`؛ تشغيل النموذج `DINAR_AI_MODEL_FALLBACK=true`؛ في الإنتاج `DINAR_AI_CHAT=true` و`DINAR_AI_PRODUCTION_APPROVED=true` |
| ضوابط التكلفة (موجودة ومختبرة) | `src/lib/ai-spend.ts`: حجز نقدي قبل كل نداء، تسجيل كل نداء (أساسي/إعادة/احتياطي)، سقف عالمي/حساب/خطة، فشل مغلق `SPEND_BUDGET_UNCONFIGURED` في staging/production. الأسعار تُدخل الآن عبر `POST /admin/ai/model-prices` (مصدر ومرجع إلزاميان، بلا أثر رجعي، مُنسبة للمدير). السقوف عبر `POST /admin/commercial-policies` (`aiUsage.spend`) |
| الإعداد | 1) قرار المالك: مزود + نموذج + اتفاقية معالجة بيانات + ميزانية. 2) إدخال سعر رسمي مؤرخ للنموذج (والاحتياطي). 3) ضبط `aiUsage.spend.global.limitMicros` وسقوف الخطط. 4) **شيفرة مطلوبة:** تسجيل `ProviderRegistration<"AI_TEXT">` بوضع `SANDBOX` لـ staging و`LIVE` لـ production، وإدخال سياسة السوق. |
| اختبار sandbox | `pnpm --filter @workspace/api-server run test:ai-provider` (محاكاة)؛ ثم في staging: 8 أسئلة عامة + 4 تجارية بميزانية محدودة؛ مطابقة `ai_cost_events` مع لوحة المزود (`reconcileProviderBilling`). |
| قبول الإنتاج | سعر رسمي مُدخل؛ سقف عالمي مضبوط؛ نداء مرفوض عند تجاوز السقف (مُختبر: `closure-ai-cost` C3-05..C3-07)؛ لا رموز تُبث؛ مطابقة فاتورة أسبوع أول ضمن فرق مقبول يقرره المالك. |
| الفشل والتراجع | عند فشل المزود: المحادثة تعود للمسار الحتمي دون نموذج. إيقاف فوري: `DINAR_AI_MODEL_FALLBACK=false` أو خفض السقف إلى 0. |

## 2. الرؤية (VISION) — صور البائع ومراجعة الصور

| البند | التفاصيل |
|---|---|
| المحول | `src/ai/groq-listing-photo-provider.ts`، `src/ai/listing-image-policy-review.ts` (development فقط) |
| متغيرات البيئة | `DINAR_VISION_PROVIDER` (افتراضي GROQ)، `DINAR_VISION_MODEL`، `GROQ_API_KEY`، `DINAR_PUBLICATION_IMAGE_REVIEW` |
| الإعداد | قرار المالك؛ سعر الصورة `imageUnitMicros` في سعر النموذج (بدونه يُحمّل كامل الحجز ويُعد «غير مسعّر»). |
| اختبار | `listing-photo-vision-provider.test` (5) و`listing-image-policy-review.test` (11) — محاكاة. |
| قبول الإنتاج | الاقتراحات ليست حقيقة الإعلان؛ تأكيد البائع إلزامي؛ نداء محسوب ومحدود. |
| التراجع | تعطيل المتغير؛ نشر الإعلان يبقى ممكنًا دون الرؤية. |

## 3. الدفع (PAYMENT) — مدفوعات الطلبات

| البند | التفاصيل |
|---|---|
| المحول الحالي | `src/lib/payments/test-adapter.ts` (`TEST_ONLY`، `SIMULATION_ONLY`)؛ الخدمة عامة: `src/lib/payments/service.ts` |
| متغيرات البيئة | يُحدَّد عند اختيار المزود (لا أسماء مخترعة). |
| **فجوة شيفرة معروفة** | العقد `PaymentProviderAdapter` (`src/lib/payments/contracts.ts`) فيه `verifyWebhook` و`getSnapshot` فقط؛ إنشاء النية وبدء الاسترداد موجودان في محول الاختبار وحده، و`routes/payments.ts` مربوط به مباشرة. يلزم بعد قرار المالك: توسيع العقد بـ `createIntent` و`requestRefund`، مسار webhook بمفتاح المزود يقرأ الجسم الخام وترويسة التوقيع، واختيار المحول عبر التسجيل. **لم يُنفذ عمدًا** لأن شكله يعتمد على نموذج التاجر المسجل (MoR) والحفظ/التسوية غير المحسومين. |
| الإعداد | قرار قانوني: بلد، كيان، MoR، حفظ الأموال، الاسترداد، رسوم المعالج. ثم حساب sandbox لدى مزود مرخص. |
| اختبار sandbox | دفع ناجح، فشل، تكرار webhook، توقيع خاطئ، استرداد كامل/جزئي، مطابقة يومية (`reconcilePayments`). |
| قبول الإنتاج | لا نجاح دون webhook موقّع ومطابق للمبلغ والعملة؛ مطابقة يومية بلا فروقات غير مفسرة؛ رأي قانوني مكتوب. |
| التراجع | إزالة التسجيل → الدفع الإلكتروني «غير متاح»، ويبقى الدفع النقدي المباشر حيث تسمح سياسة السوق. |

## 4. فوترة الاشتراكات (SUBSCRIPTION_BILLING) — Free / Go / Pro

| البند | التفاصيل |
|---|---|
| المحول | العقد `SubscriptionBillingProvider` في `src/lib/subscription-billing.ts` (`createCheckout`، `scheduleCancellation`، `verifyWebhook`)؛ التسجيل `registerSubscriptionBillingProvider` (ممنوع في الإنتاج دون `DINAR_LIVE_PROVIDERS_ENABLED=true`) |
| المسارات | `GET /business/plan-change-preview`، `POST /business/subscription-checkout` (503 `BILLING_PROVIDER_NOT_CONNECTED` دون مزود)، `POST /billing/webhooks/:providerKey` |
| متغيرات البيئة | يُحدَّد عند اختيار المزود. |
| **فجوة شيفرة معروفة** | مسار webhook يستقبل الشكل القانوني لـ DINAR (`{ event, signature }`)؛ المزودون الحقيقيون يوقعون الجسم الخام بصيغتهم. يلزم في المحول خطوة تحويل الجسم الخام إلى `BillingWebhookEvent` مع التحقق من التوقيع، قبل آلة الحالات الموجودة. |
| الإعداد | اعتماد الأسعار والعملة والضريبة والحصص والتجديد والاسترداد؛ إدخال الخطط عبر `POST /admin/markets/:id/commercial-products`؛ الحصص عبر سياسة `aiUsage`. |
| اختبار sandbox | آلة الحالات مختبرة بمحاكاة HMAC (`closure-integrations` 9/9): تفعيل، تجديد، فشل دفع→`PAST_DUE` بلا استحقاق، إلغاء نهاية الفترة، استرداد، `AMOUNT_MISMATCH`، تكرار. يُعاد كاملًا مع المزود الحقيقي. |
| قبول الإنتاج | لا استحقاق قبل webhook موقّع؛ عرض المبلغ الكامل والموعد قبل الموافقة؛ إلغاء يعمل؛ لا تجديد تلقائي دون موافقة صريحة. |
| التراجع | إلغاء التسجيل → الدفع 503 صادق؛ الاستحقاقات القائمة تبقى حتى نهاية فترتها. |

## 5. SMS — التحقق من الهاتف

| البند | التفاصيل |
|---|---|
| المحول | العقد `PhoneVerificationProvider.sendCode` في `src/lib/phone-verification.ts`؛ المحول الحالي تطويري يعيد الرمز في الاستجابة (development/test فقط). `getPhoneVerificationProvider()` يعيد لا شيء خارج التطوير. |
| متغيرات البيئة | `BDINAR_REQUIRE_PHONE_VERIFICATION`؛ اعتمادات المزود تُحدَّد عند الاختيار. |
| الإعداد | اختيار مزود يغطي بلد الإطلاق، تسجيل اسم المرسل، تنفيذ `sendCode` بإيصال تسليم، وتوصيله في `getPhoneVerificationProvider` حسب البيئة. |
| اختبار sandbox | إرسال لرقم اختبار؛ حد المعدل (`auth-rate-limiter`) يمنع الإغراق؛ الرمز لا يظهر في السجلات. |
| قبول الإنتاج | معدل تسليم مقبول؛ لا رمز في أي استجابة إنتاجية؛ تكلفة الرسالة معتمدة. |
| التراجع | دون المزود لا يمكن التسجيل في الإنتاج إذا كان التحقق إلزاميًا — قرار سياسة تسجيل للمالك. |

## 6. الإشعارات الصادرة (NOTIFICATIONS) — بريد / SMS / Push

| البند | التفاصيل |
|---|---|
| المحول | العقد `NotificationProvider.send` في `src/lib/provider-boundaries.ts`؛ المُرسِل `src/lib/notifications.ts` (`NOTIFICATION_REGISTRATIONS` فارغة اليوم). **مُستدعى فعلًا** بعد قرارات طلبات الخصوصية والطعون والبلاغات. |
| القوالب | `PRIVACY_REQUEST_UPDATED`، `TRUST_APPEAL_UPDATED`، `REPORT_RESOLVED` — حقول: معرف UUID + رمز حالة فقط؛ المحول يحل المستلم من معرف DINAR. |
| متغيرات البيئة | `DINAR_NOTIFICATION_CHANNEL` = `EMAIL` \| `SMS` \| `PUSH`؛ اعتمادات المزود تُحدَّد عند الاختيار. |
| الإعداد | اختيار المزود؛ تنفيذ `send` (ترجمة القالب إلى نص عربي لدى المزود أو في المحول)؛ إضافة `ProviderRegistration<"NOTIFICATIONS">` إلى `NOTIFICATION_REGISTRATIONS`؛ إدخال سياسة السوق؛ ضبط القناة. لا يوجد عمود بريد إلكتروني للمستخدم اليوم — قناة EMAIL تتطلب جمع البريد بموافقة. |
| اختبار | `closure-notifications` (7/7، محاكاة): رفض النص الحر والهاتف والإحداثيات، `NOT_CONFIGURED`/`NOT_CONNECTED`، فشل المزود يُسجّل كرمز فقط، الاستدعاء بعد الالتزام ولا يؤخر القرار. |
| قبول الإنتاج | تسليم فعلي لكل قالب؛ لا بيانات شخصية في الحمولة؛ احترام تفضيلات التسويق (هذه رسائل معاملات لا تسويق). |
| التراجع | إزالة التسجيل أو القناة → `NOT_CONNECTED`؛ السجل داخل التطبيق يبقى مصدر الحقيقة. |

## 7. التخزين (OBJECT_STORAGE)

| البند | التفاصيل |
|---|---|
| المحول | `ObjectStorageService` يحتفظ بـReplit sidecar كافتراضي؛ محول S3-compatible اختياري في `s3ObjectStorage.ts`. |
| العقد | `ObjectStorageService`: `getPublicObjectSearchPaths`، `getPrivateObjectDir`، `searchPublicObject`، `downloadObject`، `getObjectEntityUploadURL`، `getObjectEntityFile`، `saveObjectEntityFromBuffer`، `normalizeObjectEntityPath`، `trySetObjectEntityAclPolicy`، `canAccessObjectEntity`. وعقد الملف `ObjectFileLike`: `exists`، `getMetadata`، `setMetadata`، `download` (بمدى اختياري)، `createReadStream`، `delete`. |
| متغيرات البيئة | Replit: يلزم `PRIVATE_OBJECT_DIR` و`PUBLIC_OBJECT_SEARCH_PATHS` عند بدء التشغيل؛ `DEFAULT_OBJECT_STORAGE_BUCKET_ID` إعداد Replit المنصّي. `OBJECT_STORAGE_PROVIDER` اختياري وافتراضيه `replit`. S3: `OBJECT_STORAGE_PROVIDER=s3`، ويلزم `OBJECT_STORAGE_S3_ENDPOINT` و`OBJECT_STORAGE_S3_REGION` و`OBJECT_STORAGE_S3_BUCKET` و`OBJECT_STORAGE_S3_ACCESS_KEY_ID` و`OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`؛ اختياريًا `OBJECT_STORAGE_S3_PRIVATE_PREFIX` (الافتراضي `private`) و`OBJECT_STORAGE_S3_PUBLIC_PREFIXES` (قائمة مفصولة بفواصل، افتراضيًا فارغة). |
| الإعداد | يبقى Replit بلا مفتاح Google منفصل. S3 يتطلب وجهة وبيانات اعتماد يختارها المالك؛ لا تُسجّل أسرار في المستودع. |
| اختبار | `test:storage-portability` يستخدم نقلًا ذاكراتيًا محليًا: **2/2** للحفظ/القراءة/الحذف وACL ورابط رفع موقّع مدته 900 ثانية والتحقق من الإعداد؛ لم يُستخدم bucket أو endpoint خارجي. اختبار Replit المحمي بـ`BDINAR_OBJECT_STORAGE_ACCEPTANCE=authorized` لم يُشغّل حيًا. |
| قبول الإنتاج | اختيار وجهة S3 ومراجعة سياسة ACL/الاحتفاظ، ثم رفع/قراءة/حذف في staging. لم يُنشأ bucket ولم تُنقل ملفات أو بيانات في هذه الجولة. |
| التراجع | الإعلانات بلا صور تبقى ممكنة؛ الرفع يعيد خطأ صادقًا. |

## 8. الخرائط / الترميز الجغرافي / المسارات (MAPS, GEOCODING, ROUTES)

| البند | التفاصيل |
|---|---|
| المحول | عقود فقط في `provider-boundaries.ts` (`MapsProvider`، `GeocodingProvider`، `RoutesProvider`) — **لا مستهلك في التطبيق**. |
| الحالة | الموقع اليوم مشاركة لمرة واحدة ضمن طلب مصرح، والعنوان نصي. لا ميزة تستخدم الخرائط. |
| الإعداد | **قرار منتج أولًا:** أي ميزة تحتاج خريطة/بحث عنوان/مسار. ثم مزود، ثم مستهلك يمر عبر `resolveMarketProvider`. |
| قبول الإنتاج | لا إحداثيات في سجلات أو مطالبات AI؛ تكلفة الطلبات معتمدة. |
| التراجع | الإدخال اليدوي للعنوان يبقى. |

## 9. التوصيل وتتبع الشحنات (EXTERNAL_DELIVERY, SHIPMENT_TRACKING, DRIVER_LOCATION)

| البند | التفاصيل |
|---|---|
| المحول | `ExternalDeliveryProvider` و`ShipmentTrackingProvider` عقود بلا مستهلك؛ `DRIVER_LOCATION` = `OrderTrackingProvider` في `src/lib/order-tracking.ts` (مستهلك في `routes/marketplace.ts`، لا مزود حي → `UNAVAILABLE / NO_PROVIDER`). |
| الحالة | توصيل ساعي داخلي مع اتفاق أجرة وتسوية **محاكاة** (`SIMULATION_ONLY`). لا GPS مستمر ولا ناقل. |
| الإعداد | قرار المالك: توصيل يدوي للتجربة أم ناقل؛ ثم عقد ومزود ومستهلك. |
| قبول الإنتاج | لا ETA مخترع؛ الموقع الدقيق يُخفى عند انتهاء الطلب (مُختبر في block-d). |
| التراجع | التتبع يعرض «غير متاح» صراحة. |

## 10. المراقبة وتقارير الأخطاء (MONITORING)

| البند | التفاصيل |
|---|---|
| المحول | `src/lib/monitoring.ts` (`registerMonitoringProvider`)؛ **مُستدعى فعلًا** من حد الأخطاء `apiErrorHandler` في `src/app.ts` لكل 5xx غير مقصود. |
| الحمولة | `event`، `code` محدود، `requestId`، `release` فقط — لا رسالة ولا stack ولا URL ولا معرف مستخدم. |
| متغيرات البيئة | `DINAR_MONITORING_PROVIDER` (مفتاح المحول المسجل)، `DINAR_RELEASE`؛ اعتمادات المزود تُحدَّد عند الاختيار. |
| الإعداد | اختيار المزود؛ تنفيذ `captureError`؛ استدعاء `registerMonitoringProvider` عند الإقلاع بوضع البيئة الصحيح. |
| اختبار | `monitoring.test` (5/5، محاكاة): لا إرسال دون اختيار، حمولة محدودة، الرفض المقصود و4xx ليست حوادث، فشل المراقب لا يفشل الطلب، الإنتاج يتطلب `DINAR_LIVE_PROVIDERS_ENABLED`. حد 20 تقريرًا متزامنًا. |
| قبول الإنتاج | خطأ اصطناعي في staging يظهر لدى المزود بلا بيانات شخصية؛ تنبيه للمناوب. |
| التراجع | إزالة `DINAR_MONITORING_PROVIDER` → سجلات pino المنقحة فقط. |

## 11. تسجيل الدخول عبر Google (GOOGLE_OAUTH)

عقد `GoogleOAuthProvider` فقط، بلا مستهلك. المصادقة الحالية كلمة مرور + جلسة DINAR + تحقق الهاتف. **قرار منتج قبل أي عمل.**

---

## إعدادات المالك غير المرتبطة بمزود (موجودة في الشيفرة)

| المتغير | الأثر | غيابه |
|---|---|---|
| `DINAR_PRIVACY_RESPONSE_DAYS` | موعد رد طلبات الخصوصية | لا موعد مخترع (`dueAt=null`) |
| `DINAR_REPORT_RESPONSE_HOURS` | موعد/تأخر البلاغات في طابور الإدارة | لا موعد |
| `DINAR_APPEAL_RESPONSE_HOURS` | موعد/تأخر الطعون | لا موعد |
| `DINAR_RETENTION_PERIODS_JSON`، `DINAR_RETENTION_APPROVED` | مدد الاحتفاظ المعروضة | «غير معتمد» |
| `DINAR_APPEALS_REQUIRE_DIFFERENT_REVIEWER` | مراجع مستقل للطعن | مفعّل افتراضيًا |
| `DINAR_AI_SPEND_REQUIRED` | فرض السقف النقدي خارج الإنتاج | مفروض في staging/production دائمًا |
| `SESSION_SECRET` (32 حرفًا على الأقل) | توقيع رموز التحقق من الهاتف وحد المعدل والسياسة التجارية | تفشل هذه المسارات بخطأ صريح (لا توقيع ضعيف) |
| `APP_ORIGIN`، `TRUST_PROXY_ORIGIN` | الأصل المتوقع لحماية الطلبات الكاتبة | يُستخدم أصل الطلب المباشر، أو ترويسات الوكيل إن كان `TRUST_PROXY_ORIGIN=true`؛ اضبط `APP_ORIGIN` صراحةً في الإنتاج |

## ترتيب التنفيذ المقترح بعد قرارات المالك

1. AI (أقل مخاطرة قانونية؛ الضوابط النقدية جاهزة) → 2. المراقبة → 3. SMS إن لزم التسجيل → 4. الإشعارات → 5. فوترة الاشتراكات → 6. الدفع (بعد الرأي القانوني) → 7. الخرائط/التوصيل حسب نطاق التجربة.
