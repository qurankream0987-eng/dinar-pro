# خطة تكاملات DINAR الرئيسية

**تاريخ البحث:** 2026-10-23  
**أساس مراجعة الشيفرة:** HEAD محلي `7f17213` مع مراجعة التغييرات غير المودعة في شجرة العمل؛ لم تُدرج تلك التغييرات في الإيداع التوثيقي.  
**النطاق:** بحث رسمي، تحقق معماري، تقدير تكلفة مشروط، وخارطة تنفيذ. لا تفعيل أو شراء أو دفع أو إنشاء حساب/دلو أو ترحيل أو نشر.

## الخلاصة التنفيذية

DINAR ليس بحاجة إلى شراء كل تكامل وارد في قائمة عامة. التجارة الأساسية تملك مسارات داخلية للكتالوج والبحث والمحادثة والطلبات والتفاوض وتسليم يدوي/داخلي. ما ينقص هو إثبات التشغيل في البيئة المستهدفة، وليس استبدال هذه السلطات بخدمات خارجية.

**النتيجة العملية:** لا يوجد مزود تجاري خارجي مثبت LIVE أو SANDBOX في هذا الفحص. الموجود هو محاكاة مختبرة، حدود/عقود، adapters تطويرية، أو موصلات غير مهيأة. لا تُعد المفاتيح المتاحة أو قبول الشيفرة اتصالًا فعليًا. ما يلي توصيات مشروطة لا اختيارًا نيابة عن المالك.

الحد الأدنى قبل تجربة محدودة يتوقف على قرارات البلد ونموذج التسجيل والتشغيل. إذا بقي إثبات الهاتف شرطًا للإنتاج، فـSMS هو أول تكامل خارجي مطلوب. خلاف ذلك يمكن أن تكون أول خطوة تقنية بعد اختيار الوجهة اختبار تخزين staging معزولًا؛ لا يلزم مزود خرائط أو ناقل أو دفع إلكتروني لتجربة يدوية مقيدة إذا وافق المالك والسياسة المحلية. الدفع الإلكتروني/تحصيل أموال البائعين مؤجل إلى أن يُحسم الكيان المسؤول وMerchant of Record والترخيص والتسوية.

### إجابات المالك الستة

1. **ما يلزم؟** قرار موثق للسوق/الإطلاق، استعادة قاعدة بيانات قابلة للإثبات، بريد/هاتف حسب سياسة الحسابات، تخزين صور موثوق عند استخدامها، ومراقبة تشغيلية. AI اختياري إذا لم يكن وعدًا أساسيًا. الدفع، Push، الخرائط، الناقل وGPS ليست متطلبات تقنية افتراضية.
2. **مزودون موصى بهم؟** لا تعاقد اليوم. لقائمة التقييم: Groq يظل مسار التطوير القائم وفق قرار المشروع؛ اختبر مباشرةً OpenAI API أو Google Gemini paid عبر adapter صريح إذا أريد AI حي. للتخزين: Cloudflare R2 مرشح محمول قبل Railway، وRailway Buckets بديل ملائم بعد الانتقال. للبريد: Amazon SES أقل سعرًا معلنًا، وResend أبسط بدءًا. SMS: اطلب عرضًا إقليميًا من Infobip وقارنه بـTwilio بعد اعتماد Sender ID. للدفع فقط: MyFatoorah وTap Marketplace يستحقان العناية الواجبة؛ لا توجد أهلية DINAR مؤكدة.
3. **ما يقدمه المالك؟** دولة/كيان ونموذج تشغيل، موافقات قانونية/خصوصية/احتفاظ، حسابات أعمال واعتماد KYC/KYB عند طلبها، نطاق مرسل/نطاق بريد، ميزانيات وحدود إنفاق، اختيار وجهة/منطقة تخزين، وجهة قواعد وقرار اختبار الاستعادة. تدخل الأسرار عبر Secrets لكل بيئة، لا في المحادثة أو المستودع.
4. **التكلفة؟** تتباين حسب المستخدمين والاستخدام والسوق. مثال AI بأسعار OpenAI الرسمية الحالية لـ`gpt-6-luna` في §7: نحو **$2.61 / $17.49 / $77.52 لكل 1,000 مستخدم نشط شهريًا** في سيناريوهات منخفض/متوقع/مرتفع، على افتراضات واضحة؛ عند 100 ألف مستخدم تصبح نحو **$260.82 / $1,749.44 / $7,752**. لا تشمل بنية التطبيق أو الصور/الصوت أو القنوات/المعاملات؛ جدول المصروف الكامل في ملف نموذج التكلفة.
5. **الأول؟** بعد قرار هل الهاتف إلزامي، نفّذ SMS فقط إذا كان إلزاميًا؛ وإلا جهّز اختبار تخزين S3-compatible على staging بعد اختيار الوجهة. لا يُرسل أي طلب حي قبل إذن منفصل. لا تخلط خطوة التخزين مع نقل ملفات الإنتاج.
6. **ما المحجوب؟** مزودو AI/SMS والبريد/الإشعارات والدفع، الأسواق والسياسة القانونية، قيود وتوزيع أموال السوق، وجهة بيانات التخزين، اعتماد Railway واستعادة النسخ الاحتياطية كلها تتطلب قرارًا أو دليل مالك. لا تنفذ الخطة تلقائيًا.

## 1. الحالة الفعلية في الشيفرة

الأوصاف أدناه تصنف ما شوهد في المصدر/السجلات المتاحة، لا تمثل اختبارًا حيًا جديدًا. «محاكاة ناجحة» لا تعني Sandbox مزود.

| التكامل | التنفيذ ومصدر السلطة | الحالة | الناقص والخطوة التالية |
|---|---|---|---|
| API، PostgreSQL، حسابات/جلسات | Express + PostgreSQL؛ دخول DINAR بكلمة مرور وجلسات وقيود سوق؛ `auth.ts` | IMPLEMENTED LOCAL | تحقق جاهزية DB والمهاجرات والنسخ/الاستعادة في الهدف؛ لا تستبدل المصادقة بلا سبب. لا يوجد OAuth مستهلك. |
| AI نصي وأدوات | `ai/model-gateway.ts`, `ai/model-turn.ts`, `lib/ai-spend.ts`, `market-capability-registry.ts`; Groq/OpenAI/OpenRouter/Replit AI/compatible endpoint؛ تفعيل النماذج منضبط بإعدادات الخادم | PARTIALLY IMPLEMENTED؛ لا جودة عربية LIVE مثبتة هنا | تسجيل البيئة/السوق ليس إعدادًا فقط؛ قرار مزود/نموذج وDPA وأسعار وسقف نقدي واختبار أدوات عربي مصرح. Replit AI Integrations لا تنتقل كاعتماد إلى Railway. |
| رؤية البائع ومراجعة صور الإعلان | `ai/groq-listing-photo-provider.ts`, `ai/listing-image-policy-review.ts`; تطوير فقط، مخرجات اقتراحية | IMPLEMENTED LOCAL / DEVELOPMENT ONLY | إبقاؤها معطلة في الإنتاج حتى اعتماد مستقل، معالجة صور واحتفاظ وميزانية ومراجعة قانونية. لا تستبدل قرار DINAR. |
| تخزين الصور والملفات | `lib/objectStorage.ts`, `lib/s3ObjectStorage.ts`, `objectAcl.ts`, `routes/storage.ts`, `routes/listing-photos.ts`; Replit sidecar افتراضي، S3-compatible اختياري | MOCK VERIFIED لاختبار النقل 2/2؛ لا S3 حي | لا وجهة مختارة ولا I/O حي. يلزم اختبار staging لـPUT/GET/ACL/range/delete/CORS/TTL ثم ترحيل تجريبي منفصل بعد موافقة. |
| SMS / إثبات الهاتف | `lib/phone-verification.ts`, `lib/auth.ts`; رمز تطوير/اختبار فقط، لا مزود إنتاج | PARTIALLY IMPLEMENTED | اختيار بلد/سياسة إثبات ثم مزود وتسجيل مرسل وlimits/receipt/fraud. Twilio/Infobip/Vonage لم يُختبروا مع DINAR. |
| بريد | قناة إشعارات عامة فقط؛ لا بريد مستخدم محفوظ/متحقق ولا adapter بريد | NOT IMPLEMENTED | قرار هل جمع البريد ضروري، موافقة، نطاق DNS، قناة استرداد، adapter وقوالب. لا ترسل بريدًا دون مستلم مشروع وموافقة. |
| Push / Web Push | لا تسجيل أجهزة/رموز أو إرسال من DINAR | NOT IMPLEMENTED | يتطلب تصميم تفضيلات/إلغاء/تنظيف token وربط APNs/FCM؛ غير لازم للويب إن كانت إشعارات داخل التطبيق كافية. |
| الإشعارات الخارجية | `lib/notifications.ts`, `provider-boundaries.ts`; ثلاثة قوالب IDs/status فقط؛ سجل المزودين فارغ | IMPLEMENTED LOCAL؛ غير متصل | موافقة قناة/بلد وتسجيل adapter واختبار التسليم وإعادة المحاولة. سجل التطبيق هو مصدر الحقيقة. |
| خرائط/Geocoding/Routes | عقود في `provider-boundaries.ts` بلا مستهلك | NOT IMPLEMENTED | لا تضاف إلا لميزة معتمدة؛ عناوين نصية ومشاركة مكان مصرح بها تبقى مسارًا يدويًا. |
| تتبع سائق/ناقل | `lib/order-tracking.ts` يعيد NO_PROVIDER؛ عقود external delivery/shipment بلا مستهلك؛ ساعي داخلي بمحاكاة | PARTIALLY IMPLEMENTED؛ المحاكاة فقط | لا GPS/ETA حي. قرر يدوي أم ناقل ثم تنفيذ adapter وحماية موقع مؤقتة ومراجعة تشغيل. |
| دفع مشتريات واسترداد | `lib/payments/test-adapter.ts`, `payments/service.ts`; اختبار فقط ومحاكاة | MOCK VERIFIED؛ الدفع الحقيقي NOT IMPLEMENTED | العقد لا يغطي كامل دورة إنشاء النية/الاسترداد، المسارات مربوطة بمحاكي الاختبار. يلزم قرار MoR/حيازة الأموال والسوق، adapter، webhook موقّع خام/idempotency ومطابقة. |
| فوترة الاشتراك | `lib/subscription-billing.ts`; آلة حالات ومحاكاة HMAC؛ endpoint بلا مزود | MOCK VERIFIED | موائم webhook حقيقي/توقيع خام، سعر/ضريبة/موافقة وتجديد؛ منفصلة عن أموال السلع. تطبيقات الجوال لها قواعد متجر. |
| المراقبة | `lib/monitoring.ts`; سجل مزود فارغ، payload منقح | IMPLEMENTED LOCAL / NOT CONNECTED | لا تعاقد ضروري الآن؛ يمكن اختيار Sentry بعد تحديد بيانات telemetry وسياسة الاحتفاظ، أو الاكتفاء بسجلات Pino مع تشغيل مناوبة. |
| البحث/ترتيب/الكتالوج | PostgreSQL وقواعد DINAR الداخلية | IMPLEMENTED LOCAL | لا محرك بحث خارجي مطلوب قبل قياس عنق زجاجة حقيقي. |
| Shopify/ERP | لا مستهلك أو موصل متجر عام مفحوص | NOT IMPLEMENTED | لا تفترض تكامل كتالوج أو مخزون خارجي ضمن إطلاق الأسواق. |
| استضافة Railway | وثائق وإعدادات نقل موجودة؛ لا تحقق حي جديد في هذا البحث | REQUIRES OWNER DECISION / BLOCKED | مصفوفة §10؛ مراجعة حساب Railway/استعادة/PITR والإعدادات تتم من المالك وبموافقة مستقلة. |

**حدود الفحص:** لم تُقرأ قيم أسرار. وجود أسماء أسرار داخل مساحة العمل لا يثبت أنها صالحة أو مأذون بها. لم نرسل طلبًا لأي API لمزود، ولم نلمس قاعدة مُدارة. تقارير القبول السابقة تظل دليلها كما هو ولا نعيد تعريفه.

## 2. توصية طبقية وتوافق الدول

### البنية الأقل تعقيدًا

- **الأصل:** DINAR يحتفظ بسلطة الحساب، السوق، الإعلان، السعر، الطلب، الدفع، التسليم، الترقيات وسجل المحادثة. المزود ينفذ capability ضيقة فقط. اختيار السوق/البيئة وتفعيل live gate تبقى من الخادم؛ لا مفاتيح في المتصفح.
- **AI:** مزود مباشر واحد مُختبر لنمط الأدوات/JSON قبل أي fallback. أبقِ Groq لمسار التطوير الحالي كما تقرر ذاكرة المشروع. لا يُستنتج تفوق العربية دون اختبار المستخدمين. اجعل مزود AI حيا أو رؤية الصور اختياريًا وفشلها لا يوقف التجارة. إما OpenAI adapter الحالي، أو adapter صريح لمزود آخر بعد قياس فائدة التكلفة/اللغة؛ لا تضف OpenRouter لمجرد إتاحة قائمة نماذج.
- **التخزين:** استخدم عقد S3 الحالي. R2 هو المرشح المحمول للتجربة قبل Railway بسبب S3 API ورسوم egress المعلنة صفرًا؛ Railway Buckets بديل بعد الانتقال ويقلل فصل الموردين. الموقع/الإقامة القانونية للبيانات غير محسومين، لذا لا توصية إقليمية نهائية. اختبر multipart وCORS وACL وstreaming وrange وسلوك حذف metadata؛ توافق S3 لا يضمن تطابق جميع السلوكيات.
- **الهاتف والبريد:** قناة معاملات واحدة فقط حسب السياسة. إذا بقي الهاتف شرطًا: قارن Infobip (تغطية إقليمية وعرض سعر حسب الحساب) مع Twilio (تعرفة منشورة لكن مرتفعة في أسواق محددة ومتطلبات مرسل). البريد: SES أقل تكلفة معلنة، Resend أسهل مطوريًا لكنه اشتراك مدفوع عند تجاوز المستوى المجاني. لا يوجد حقل بريد اليوم؛ لا تعتمد SES/Resend حتى يقرر المنتج جمعه والتحقق منه.
- **Push:** عند وجود تطبيق native استخدم خدمة إرسال مركزية مع FCM لـAndroid/Web وAPNs لأجهزة Apple، أو Expo Push كطبقة نقل لفريق Expo. لا تجعل كل عميل مصدرًا مستقلًا للإشعار؛ لا تدّع receipt تسليمًا إلى المستخدم. للويب الحالي ابدأ بإشعار داخل التطبيق؛ Web Push يحتاج service worker وVAPID وموافقة وإلغاء.
- **خرائط:** لا مزود في الطور الأول. إذا كانت الخريطة مطلبًا بصريًا، Google Maps يغطي عرض الخريطة/geocoding/القيادة للدول الثلاث بحسب مصفوفة Google؛ Mapbox مرشح إذا كانت رسوم/تجربة map SDK تلائم القياس. تحقق من التغطية الفعلية للعناوين قبل التزام. احصل على موافقة إذن موقع لكل استخدام؛ لا تحفظ GPS المستمر.
- **التوصيل:** الخيار الأول يدوي/ساعي DINAR مع نقطة تسليم ومراحل موثوقة. Aramex وSMSA وShipa لديهم قدرات API منشورة (شحن/تتبع/تسعير بحسب المنتج)، لكن لا يثبت ذلك التغطية أو الحساب/السعر أو دعم COD في كل دولة. اطلب عقد خدمة لكل دولة. لا توحّد نقلًا دوليًا عابرًا للحدود دون موافقة السوق.
- **الدفع:** لا مزود الآن. MyFatoorah تعلن الدول الثماني ومنها JO/KW/SA وخيار multi-vendor مع موافقة ووثائق مورد؛ Tap لديها Marketplace split لكن وثائقها تقول إن مسؤولية السوق والاعتراضات تقع على حساب السوق، وتذكر صفحة دعمها أنها لا تقبل تجارًا جددًا من الأردن (تحقق كتابي مباشر قبل أي اعتماد). Checkout.com يقدم منتجات المنصات لكن الأهلية/الأسعار بعرض وموافقة. لا تتخذ أهلية دولة أو MoR كحقيقة من صفحة تسويقية.
- **اشتراك DINAR الرقمي:** افصله عن شراء البضائع. Web checkout يمكن بحثه بعد بوابة قانونية. Native digital features/subscriptions تخضع لقواعد Apple/Google للفوترة داخل التطبيق وما ينطبق من استثناءات/برامج حسب البلد؛ راجع النصوص الرسمية وسياسة المتجر قبل تنفيذ checkout موحد.
- **المراقبة:** سجلات منقحة وHealth checks ومقاييس AI/مصروف وwebhook failure alert وDB/backup restore drill أولوية قبل تعاقد Sentry. إن اختير Sentry أو بديله، افحص DPA وموقع البيانات وإخفاء prompts/PII وحدود الحصة.

### مقارنة قدرات AI وحدود الأدلة

| المزود/الواجهة | قدرات API الموثقة | ما يجب إثباته في DINAR | الخصوصية والاعتمادية |
|---|---|---|---|
| OpenAI API | أدوات وstructured outputs وstreaming/caching في نماذج/واجهات محددة | النموذج المتاح من gateway، schema الفعلي، دورة tool-call، العربية/اللهجة، timeout/rate tier | راجع data controls/retention وDPA للحساب؛ لا ترسل بيانات حساسة بلا موافقة وأساس. |
| Anthropic API | tool use وstreaming وprompt caching بحسب النموذج | يحتاج توافقًا/adapter صريحًا؛ لا تفترض أن أدوات DINAR أو مخطط JSON تنتقل من واجهة أخرى | راجع شروط الاحتفاظ وDPA والمنطقة للحساب؛ caching ليس سياسة retention. |
| Gemini API | Function calling/JSON/streaming/caching وbatch تختلف بالنموذج والطبقة | لا تكامل DINAR مثبت في مراجعة المصدر؛ يلزم adapter/اختبار أدوات وschema واللغة | صفحة Paid تقول إن المحتوى لا يستخدم لتحسين منتجات Google؛ أعد مراجعة الشروط الفعلية للحساب وقت الاختيار. |
| Groq API | function calling/JSON/streaming متاحة لبعض موديلات API وليس عقدًا موحدًا لكل موديل | لا تجعل موديل Vision الحالي بديلًا لمسار النص؛ تحقق من كل model ID والسعر/rate limit | تختلف الأسعار وشروط Developer/Production؛ لا fallback تلقائيًا بين مزودين. |
| OpenRouter | وسيط متعدد المزودين والنماذج وتوجيه وفق الخطة | سجل route/model/provider واختبر التكرار واستجابة الأدوات | تضيف وسيطًا؛ الخطة القياسية تعلن 5.5% platform fee، وخيارات budgets/data routing تختلف بالخطة. |

ما سبق قدرات منشورة وليس benchmark. لم نجرب مزودًا أو موديلًا هنا. لا يوجد قياس موثوق للعربية أو latency. نافذة السياق، rate limits، الصور، structured JSON، streaming، caching وسعر كل وحدة يجب أخذها من صفحة النموذج المختار وقت التنفيذ. **توزيع المهام المقترح:** محادثة عامة بعد مسار حتمي بموديل سريع محدود؛ business tool calls بمزود واحد مختبر وسلطة/تأكيد DINAR؛ تخطيط البطاقات عبر schema معروف وتحقق خادمي؛ التفكير المعقد يمر انتقائيًا بعد قياس فائدة؛ التصنيف والمهام البسيطة تبقى قواعد محلية ما لم يثبت نموذج منخفض الكلفة فائدته. كل أفعال الأعمال تبقى في خدمات DINAR.

**تحديث AI في 2026-10-24:** تحققت الأسعار الرسمية مجددًا بما فيها كتابتا cache (30 دقيقة و12 ساعة)، وثُبت أن cache-write tokens جزء من تقسيم الإدخال في دفتر التكلفة؛ لا يُسمح بالاستدعاء المدفوع لنموذج OpenAI عند إلزام الإنفاق إذا كانت أي من طبقتي الكتابة غير مسعّرة. اجتاز التشغيل المحلي لخطة المقارنة حد $5 (أسوأ حالة $4.517088)، والمحاكاة المحلية لا تثبت جودة النموذج. لا اعتماد مزود حي ولا قياس عربي حقيقي ولا موافقة تشغيل حتى الآن. راجع `DINAR_FIRST_LIVE_AI_BENCHMARK_READINESS.md` و`DINAR_OWNER_AI_ACTIVATION_CHECKLIST.md`.

### مقارنة مختصرة — الأسعار الرسمية التي أمكن التحقق منها

الأسعار مؤرخة في مصادرها وتاريخ البحث؛ قد تتغير حسب بلد الحساب والضرائب/العقد. «عرض سعر» يعني أن التسعير العام لا يكفي لتقدير موثوق.

| المجال | المرشح/البديل | السعر/التوافق المعلن | خلاصة DINAR |
|---|---|---|---|
| AI | OpenAI API | `gpt-6-luna`: $0.10/M input، $0.50/M output قياسيًا، input cached $0.01/M (السعر كما ظهر 2026-10-23) | أرقام النموذج في §7 للمقارنة فقط؛ لا تثبت جودة العربية أو أدواتنا. |
| AI | Anthropic Claude API | Haiku 5.5: $0.10/M input إلى 100k context و$0.50/M output؛ أسعار أعلى للسياق الطويل (الصفحة الرسمية يوم التحقق) | قدرة وأدوات تحتاج اختبارًا حيًا؛ ليس adapter مثبتًا حسب قائمة DINAR الحالية إلا عبر توافق متحقق. |
| AI | Gemini Developer API | Gemini 4 Argon: $2/M input و$10/M output حتى 30 نوفمبر 2026 ثم $4/$20، وفق الصفحة؛ batch/flex أسعارها مختلفة | السعر المؤرخ مؤقت. يلزم adapter/اختبار schema-tools؛ لا نعتمد جودة أو سياسة حفظ قبل تقييمها. |
| AI | OpenRouter | رسوم المنصة معلنة 5.5% للخطة القياسية pay-as-you-go، بالإضافة لتكلفة النموذج | يزيد طرفًا وسيطًا ويجب تدقيق logging/routing والخصوصية؛ لا أوصي به كمسار أول إذا لم يقدم قياسًا يبرر الوسيط. |
| AI | Groq | صفحة الأسعار الرسمية الديناميكية لم تعرض جدولًا نصيًا قابلًا للتثبت في هذا البحث | **لا أختلق سعرًا**؛ اطلب/تحقق من لوحة الأسعار عند اختيار موديل. التطوير الحالي لا يعني الإنتاج. |
| تخزين | Railway Buckets | $0.015/GB-month؛ عمليات S3 وegress من الدلو مجانية حسب Railway. لا تخلط egress الخدمة بالدلو | خيار جيد بعد الانتقال إن وافق المالك على region؛ حدود الخطط تختلف. |
| تخزين | Cloudflare R2 Standard | $0.015/GB-month؛ 1M Class A و10M Class B و10 GB-month مجانًا، ثم $4.50/M و$0.36/M؛ egress مجاني | مرشح أساسي قابل للنقل؛ يظل موقع البيانات/المعالجة والـCORS بحاجة تحقق. |
| تخزين | AWS S3 Standard | صفحة AWS توضح عناصر التخزين والطلبات والنقل لكن السعر النهائي حسب region/tier | QUOTE/CALCULATOR REQUIRED بحسب المنطقة والاستعمال؛ عادةً تزيد تكاليف egress والطلبات عن R2/Railway. |
| تخزين | Backblaze B2 | الصفحة المعلنة تبدأ $6.95/TB-month؛ egress المجاني حتى 3× متوسط التخزين ثم $0.01/GB؛ أسعار المعاملات حسب الجدول | بديل محتمل، لكن تحقّق من region ومطابقة semantics/ACL وlatency من Railway. |
| SMS | Twilio SMS عادي | أسعار destination المنشورة في 2026-10-23: الأردن $0.4429/رسالة، الكويت $0.3164، السعودية $0.1949؛ قد تضاف رسوم ناقل/failed | أرقام SMS العادي ليست سعر Verify الكامل ولا تساوي ضمان تسليم. Kuwait وSaudi لهما متطلبات Sender ID. |
| SMS | Twilio Verify | $0.05 لكل تحقق ناجح + رسوم قناة/بلد؛ المحاولة قد تكلف SMS حتى لو لم ينجح التحقق | يلزم إضافة سعر قناة البلد، عدد المحاولات/segments، ورسوم الرسائل؛ لا تقدير نهائي دون tariff/account. |
| SMS | Infobip / Vonage | صفحة Infobip تحيل للسعر حسب الدولة والحساب؛ Vonage ينشر country restrictions لكنها تتطلب تحققًا حسب الاستخدام | QUOTE REQUIRED مع اختبار أرقام carriers وSender ID في JO/KW/SA. |
| بريد | Amazon SES à-la-carte | $0.10 / 1,000 بريد outbound و$0.12/GB attachment حسب المصدر الحالي؛ لا حد أدنى في تسعير pay-as-you-go | أقل سعر معلن، لكن إعداد SPF/DKIM/DMARC وإدارة الارتداد/الشكوى مطلوب. |
| بريد | Resend | Free: 3,000/mo وبحد 100/day؛ Pro $20/50k ثم $0.90 لكل 1k إضافي وفق السعر المعلن | تجربة مطور بسيطة؛ لا تنشئ حسابًا قبل تأكيد جمع البريد. |
| بريد | Postmark | Free 100/mo؛ يبدأ $15/mo للطبقة المدفوعة المعروضة، إضافي $1.80/1k حسب الحزمة | بديل معاملاتي متخصص؛ السعر التفصيلي يعتمد الحزمة/الحجم. |
| Push | FCM / Expo Push | FCM بلا رسوم استخدام معلنة؛ Expo Push بلا رسوم خدمة، حد 600 رسالة/ثانية للمشروع وفق الوثائق | تكلفة البنية والـAPNs/تطوير التطبيق لا تختفي؛ Expo receipts تثبت التسليم للخدمة الناقلة فقط. |
| خرائط | Google Maps Platform | رسوم حسب SKU؛ صفحة الأسعار تعرض free caps/tiers متغيرة، وتتطلب تفعيل حساب billing | تغطية JO/KW/SA منشورة للخرائط/geocoding/قيادة؛ لا يمكن تقدير بدون request mix. |
| خرائط | Mapbox | pay-as-you-go ووحدات خريطة/مستخدم/route/geocoding وصفحة أسعار متغيرة | اطلب حساب usage calculator؛ لا تعِد رسم خريطة مجانية قبل قراءة التراخيص. |
| دفع | MyFatoorah | السعر **QUOTE REQUIRED** حسب البلد/النشاط/الحجم؛ إتاحة multi-vendor تحتاج موافقة وأوراق مورد | مرشح إقليمي مشروط، لكن التعاقد لا يثبت أن DINAR مؤهل كمنصة أو من يحتفظ بالمال. |
| دفع | HyperPay | تذكر صفحة المزود خدمة إقليمية تشمل JO/KW/SA؛ تختلف الأهلية والرسوم بحسب بلد تسجيل الشركة، والسعر يحدده مدير الحساب | QUOTE REQUIRED. اطلب تأكيدًا كتابيًا أن HyperSplit/Marketplace يدعم كيان DINAR، submerchant KYB، split والتسوية والاعتراضات في السوق المحدد. |
| دفع | Tap / Checkout.com | Tap تنشر Marketplace split؛ Checkout منتجات منصات/payout؛ السعر والأهلية بموافقة وعقد | QUOTE REQUIRED. اعتمد الرسوم وrefund/chargeback/reserve/payout/FX/onboarding كتابةً. Tap لا تقبل تجارًا جددًا من الأردن بحسب صفحة الدعم وقت التحقق. |
| تشغيل | Railway | Hobby $5/mo، Pro $20/mo؛ الاشتراك يحتسب مقابل الاستخدام. الاستخدام: RAM $10/GB-month، CPU $20/vCPU-month، volume $0.15/GB-month، service egress $0.05/GB؛ buckets $0.015/GB-month | التكلفة تتبع متوسط موارد الخدمات/قاعدة البيانات، خطة الحساب، نسخ واستعادة، egress وحدود الحساب؛ لا يوجد قياس موارد صالح لتوقع DINAR بعينه. |
| أخطاء | Sentry | خطة Free وTeam/Business وتسعير الحجم متغير؛ لا يلزم لتشغيل التطبيق | خيار لاحق بعد اختيار سياسة محتوى telemetry والاحتفاظ؛ لا تضف SDK قبل منع تسرب PII. |

### قيود الدول التي تغيّر القرار

- **Jordan/Kuwait/Saudi:** صفحة تغطية Google تسرد البلدان الثلاثة لدعم map tiles وgeocoding وdriving directions. هذا لا يعني اكتمال أرقام المنازل أو ملاءمة routing التجاري.
- **Twilio SMS:** العينة المنشورة للتسعير تُظهر فروقًا كبيرة. في الكويت يلزم Sender ID مسجل لشبكتي Zain/Ooredoo؛ وتذكر Twilio منع الرسائل ذات المرسل غير المسجل بدءًا من 2026-09-15. السعودية تتطلب Sender ID مسجلًا وتضع قيودًا على الروابط/المحتوى/المرسل المحلي. الأردن أيضًا يظهر التسجيل مطلوبًا في مصفوفة Twilio. يجب مراجعة أحدث البلد والسياسات قبل استخدامه.
- **الدفع:** MyFatoorah تقول إنها تعمل في JO/KW/SA لكن رسومها وعقد multi-vendor وأهلية حساب DINAR ما زالت بموافقة. Tap تدعم مسارات Marketplace/تجزئة لكن صفحة البلدان تمنع حاليًا تسجيل تجار جدد من الأردن. لا تقدم هذا كإعلان أهلية نهائي دون رد مكتوب من فريق المبيعات/الامتثال.
- **التوصيل:** أرقام الدول في قائمة التسويق ليست إثبات نطاق الخدمة الفعلي/الـCOD/التغطية للرمز البريدي. احصل على عقد/سعر محلي لكل بلد وتأكد من أن الناقل يقبل DINAR/الكيان، وأنه لا يجعل المنصة ناقلًا أو Merchant of Record.
- لا يوجد ضمان دولة عابر للحدود: تعامل DINAR الحالي يبقى محصورًا داخل السوق/الدولة.

## 3. الأسعار والأدلة الرسمية

تم التحقق من الصفحات بتاريخ **2026-10-23**، باستثناء التاريخ الظاهر على الصفحة عند اختلافه. صفحات التسعير ديناميكية: سجّل نسخة مؤرخة وعملة/منطقة الحساب قبل التعاقد، وأعد التحقق عند التنفيذ. مصادر التسعير والتوثيق الأساسية:

### AI
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing — أسعار input/output/cached/modes والنموذج، المصدر الذي استُخدم للحساب.
- Anthropic API pricing: https://platform.claude.com/docs/en/about-claude/pricing — السياق الطويل والتخزين المؤقت يغيّران السعر.
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing — أسعار متغيرة بمواعيد نفاذ منشورة؛ لا تفترض أن السعر الترويجي دائم.
- Groq pricing: https://groq.com/pricing/ — لا جدول قابل للاستخراج في هذه الجولة؛ لا تُدرج رقمًا حتى يُتحقق يدويًا.
- OpenRouter pricing: https://openrouter.ai/pricing — رسوم وسيط ومزايا/حدود الخطة.
### تخزين وRailway
- Railway Buckets: https://docs.railway.com/storage-buckets ، الفوترة: https://docs.railway.com/storage-buckets/billing ، رفع/تقديم الملفات: https://docs.railway.com/storage-buckets/uploading-serving
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- AWS S3 pricing: https://aws.amazon.com/s3/pricing/
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing وواجهات S3: https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
- Railway plans/resources: https://docs.railway.com/pricing/plans ؛ الاستعادة/PITR: https://docs.railway.com/guides/postgres-backups-restores
### الرسائل والبريد والتنبيهات
- Twilio Verify: https://www.twilio.com/verify/pricing ؛ أسعار الرسائل: https://www.twilio.com/en-us/sms/pricing/jo ، `/kw` ، `/sa`
- توجيه مرسل Twilio: https://www.twilio.com/en-us/guidelines/jo/sms ، `/kw/sms` ، `/sa/sms`
- Infobip SMS coverage: https://www.infobip.com/docs/sms/sms-coverage-and-connectivity ؛ السعر: https://www.infobip.com/content-subtype/pricing
- Vonage country restrictions: https://api.support.vonage.com/hc/en-us/sections/9182319113372-Middle-East
- SES: https://aws.amazon.com/ses/pricing/ ؛ Resend: https://resend.com/pricing ؛ Postmark: https://postmarkapp.com/pricing
- FCM: https://firebase.google.com/products/cloud-messaging ؛ Expo Push FAQ/limits: https://docs.expo.dev/push-notifications/faq/
### خرائط/دفع/توصيل ومتاجر الجوال
- Google country coverage: https://developers.google.com/maps/coverage ؛ pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- Mapbox pricing: https://www.mapbox.com/pricing ؛ geocoding: https://www.mapbox.com/geocoding (temporary: 100,000 طلب شهريًا ضمن المجاني، ثم tier منشور $0.75/1,000؛ permanent geocoding لا يملك نفس المجاني، والوثائق تقيد استخدام الاستجابة بخريطة Mapbox).
- MyFatoorah countries/fees FAQ: https://www.myfatoorah.com/en/faqs/ ؛ multi-vendor approval/docs: https://docs.myfatoorah.com/docs/multiple-suppliers
- Tap countries (منها تقييد الأردن): https://support.tap.company/en/support/solutions/articles/153000140298-what-countries-are-supported-by-tap-payments- ؛ Marketplace liability/flows: https://developers.tap.company/docs/marketplace-overview
- Checkout.com marketplaces: https://www.checkout.com/solutions/marketplaces ؛ HyperPay: https://www.hyperpay.com/ ، https://www.hyperpay.com/frequently-asked-questions/
- Aramex APIs: https://www.aramex.com/developers-solution-center/aramex.com-platform ؛ Shipa developer: https://shipa.com/developer-center ؛ SMSA: https://track.smsaexpress.com/SECOM/SMSAwebService.asmx
- Apple App Review: https://developer.apple.com/app-store/review/guidelines ؛ Google Play payments policy: https://support.google.com/googleplay/android-developer/answer/9858738

## 4. الخطة حسب نوع الإطلاق

| الطبقة | القرار |
|---|---|
| مطلوب لتجربة محدودة | تحقق تشغيل API/DB ومهاجراتها في نسخة معزولة، خطة استعادة مثبتة، صلاحيات حسابات/السوق، تنبيهات داخل التطبيق ومتابعة تشغيلية. SMS فقط إن قرر المالك أن إثبات الهاتف مطلوب. تخزين الصور فقط إن كانت الصور في نطاق التجربة. |
| مطلوب قبل إطلاق عام/تشغيلي | قناة معاملات خارجية عند الحاجة الزمنية، رصد أعطال/ميزانيات، احتفاظ/خصوصية واتصال دعم، اكتمل اختبار restore، خطط abuse/rate limits وتوثيق incident. |
| مطلوب قبل أي دفع إلكتروني | البلد/الكيان/MoR والاحتفاظ/التقسيم/payout والضرائب والـKYC/KYB/chargeback والاسترداد معتمدة؛ موافقة provider Marketplace؛ adapter ويبهوك موقّع، خام، idempotent ومطابقة؛ sandbox قبول شامل. |
| اختياري لاحقًا | AI عام/رؤية، البريد، Push، الخرائط/geocoding/routing، ناقل آلي، مراقبة Sentry، تكامل ERP/Shopify. لا تفعّل خيارًا دون حاجة مقاسة. |
| مستقبل الجوال | Apple/Google store billing للاشتراكات الرقمية عند انطباق السياسة؛ APNs/FCM أو Expo Push؛ مراجعة deep links/auth، token lifecycle، consent؛ لا تخلط شراء السلعة المادية مع ميزة AI الرقمية. |

### خارطة تنفيذ مع بوابات ومخاطر

1. **تثبيت قرارات النطاق قبل الخدمة:** المالك يحدد البلد، تجربة نقدية أم غيرها، إثبات الهاتف، نوع الإشعارات، دور AI، معالجة البيانات ومَن يدير الشكاوى. نفّذ QA المحلي الحالي فقط حتى تتضح. شرط أمان: لا معاملات ولا دخول حي. تراجع: لا تغيير.
2. **جاهزية استضافة/DB:** استخدم قاعدة اختبار/نسخة معزولة لا قاعدة مُدارة؛ أكد migrations/restore/RPO/RTO من أدلة Railway المصرح بها. لا تهاجر أو تفعّل PITR ضمن هذه الخطة. فشل الاستعادة = توقف إطلاق بيانات حقيقية.
3. **التخزين المحمول (إن كانت الصور ضمن الإصدار):** اختيار مالك R2 أو وجهة S3 أخرى؛ إعداد staging منفصل من Secrets؛ PUT/GET range/content-type/ACL/public-private/CORS/delete/TTL/حد الحجم، اختبار orphan cleanup، أداء/رسوم؛ ثم dry-run inventory/hash ومقارنة دون حذف الأصل. قبول: كل سجل/ملف مطابق ونقطة رجوع. لا ترحيل production في أول اختبار.
4. **SMS (إن ظل إثبات الهاتف مطلوبًا):** حساب عمل/اعتماد مرسل محلي، اختيار بعد عرض سعر لبلد واحد. reuse `PhoneVerificationProvider`; لا تسجل الرمز أو رقم كامل. اختبر success/timeout/wrong/expired/resend/rate abuse/carrier receipt/idempotency/stop controls مع أرقام مسموحة. كلفة تحسب لكل محاولة ورسالة segment؛ حد يومي وkill switch. افشل مغلقًا عند غياب المزود بدل قبول غير موثق.
5. **البريد (بعد قرار جمع البريد):** تحقق ملكية الدومين وSPF/DKIM/DMARC وموافقة الحقول؛ reuse قالب محدود في Notification boundary. اختبر bounce/complaint/retry/suppression/عدم تسريب نص حساس. راجع SPF/DKIM من نطاق إرسال منفصل. لا تستخدم البريد كدليل هوية دون رابط/رمز مناسب.
6. **AI نص/رؤية (ميزة أساسية فقط):** سجل مزود واحد صراحةً لكل بيئة/سوق، حدد نموذج/سعر رسمي من تاريخ، DPA/احتفاظ/منطقة، سقف نقدي atomic، وعطل fallback غير المقاس. استعمل adapter/gateway القائم؛ اختبر structured tool calls وArabic/colloquial adversarial cases وتأكيد الإنسان والرفض والخادم كسلطة؛ مطابقة usage مع invoice. kill: remove registration/market entry أو spend=0. لا تخلط رؤية الصور بالتفعيل النصي.
7. **Push (بعد native app/طلب فعلي):** تصميم جهاز/تفضيل/إلغاء/token rotate وAPNs/FCM أو Expo. لا تحتوي الحمولة بيانات شخصية/موقع حساس. اختبر invalid tokens، expirations، duplicate notifications، receipt semantics. لا تنشئ قناتين متنافستين لكل platform.
8. **خرائط/ناقل (بعد requirement):** اثبت feature (map/geocode/route/tracking) لكل سوق؛ راجع شروط حفظ cache/tiles، البلد والـSLA والسعر؛ adapter واحد وراء policy. اختبر permission denied/no GPS/outage/stale/terminal order/إيقاف tracking. لا تستخدم موقعًا وهميًا؛ التراجع manual address/UNAVAILABLE.
9. **اشتراك رقمي (بعد اعتماد Free/Go/Pro):** لا تسعير الآن. اختبر الاشتراك في Web sandbox بwebhook حقيقي موقّع من sandbox، أحداث مكررة/متأخرة/فشل تجديد/إلغاء/استرداد ومطابقة entitlement. افصل SKU digital عن physical commerce. إذا native، تطبيق StoreKit/Play billing وفق السياسات السارية. rollback يوقف checkout ولا يسحب استحقاقًا قائمًا قبل نهاية مدته.
10. **دفع السلع/Marketplace (آخر تكامل):** بعد رأي قانوني مكتوب وتعاقد حساب منصة/موافقة البائعين؛ لا تكفي صفحة merchant checkout. نفذ intents/refunds والتوقيع للـraw body/idempotency/تطابق عملة-مبلغ/إشعار تسوية/chargeback ودفتر تدقيق. Sandbox: نجاح/فشل/duplicate/tamper/refund partial/dispute/settlement mismatch/payout hold. ابدأ سوقًا واحدًا ومبالغ اختبارية فقط؛ live يحتاج موافقة منفصلة وخطة reconciliation/rollback.

لكل خطوة: أرسل متغيرات الأسرار عبر Replit Secrets/إعداد Railway المناسب بعد قرار المنصة؛ قسّم development/staging/production، أقل صلاحية، تدوير وإلغاء، لا Vite prefix، لا نسخ في README أو logs.

## 5. مصفوفة قابلية نقل Railway

| المكوّن | الوضع الحالي | ما يلزم قبل النقل/بعده |
|---|---|---|
| Web/API | يعتمدان `PORT`؛ الويب يدعم `BASE_PATH` وproxy هدفه `API_PROXY_TARGET` | نفس build/run في staging؛ اختبار `trust proxy`, أصل التطبيق، health check، CORS وcookie `Secure/SameSite/Domain`, streaming والـtimeouts؛ لا افتراض دومين. |
| PostgreSQL | PostgreSQL عبر resolver ومهاجرات SQL | اختيار خدمة/منطقة/هدف صريح، TLS CA/identity، اختبار نسخة كاملة واستعادة وmigrations على clone، التحقق من pool/SSL؛ لا تغيير managed db الآن. |
| التخزين | Replit sidecar افتراضي، S3 adapter اختياري | إعداد S3 Railway/R2 أو غيرهما عبر env؛ Railway Buckets S3 API وله region ثابت عند الإنشاء. اختبار CORS, presigned PUT, metadata ACL, ranges وpublic/private؛ تخطيط transfer/cutover/rollback؛ إعداد Replit sidecar لا ينتقل تلقائيًا. |
| الأسرار | أسماء provider/env موثقة في handoff؛ القيم لم تراجع | كل secret داخل service/environment الصحيح، scopes منفصلة، تدوير، callback origins/webhook URLs منفصلة؛ لا نسخ لقيم dev إلى prod. |
| Worker/cron | لا دليل على وجود worker منفصل في هذا الفحص | إذا أضيفت jobs: idempotent queue/lease, retry/dead letter, schedule timezone and shutdown; لا تضف worker لمجرد وجود مستقبل محتمل. |
| WebSocket/stream | يلزم إثبات بروكسي وسلوك streaming الفعلي لكل ميزة | اختبر idle timeout, reconnect, proxy buffering, session affinity فقط إن تطلب التطبيق؛ لا يعتبر بدء API إثباتًا. |
| OAuth/webhooks | OAuth provider غير مستهلك؛ لا callbacks حية | تسجيل production redirect/webhook URLs لدى المزود بعد موافقة؛ verify signature raw body, replay windows/idempotency وTLS. |
| backups/PITR | لا دليل فعلي في هذا العمل | Railway توثق volume snapshots/PITR وlogical dumps؛ تحقق صفحة Backups واستعد على sibling، سجل RPO/RTO. لم يُفعل/يُختبر هذا هنا. |
| مراقبة | Pino محلي؛ vendor monitoring غير مسجل | سجل release/health/alerts وDB alerts وprovider spend/webhook failures؛ لا ترسل prompt/contact/location. |

**مصدر حقيقة النشر:** شيفرة/config + لوحة مزود/اختبار مصرح به. لا تستنتج الجاهزية من workflow محلي أو `readiness` وحده. لا يوجد تنفيذ نقل في هذا العمل.

## 6. قائمة الأسرار (أسماء فقط)

المتغيرات المؤكدة في الشيفرة/الوثائق الحالية لا تعني أنها مطلوبة الآن؛ بعضها يتحدد بعد اختيار المزود. لا تدخل بيانات حساسة إلى frontend/build.

| التصنيف | الأسماء الحالية/المشروطة | الملاحظة |
|---|---|---|
| إعداد عام/غير سري | `PORT`, `BASE_PATH`, `API_PROXY_TARGET`, `DINAR_DEPLOYMENT_ENV`, `DINAR_RELEASE`, `DINAR_NOTIFICATION_CHANNEL`, `OBJECT_STORAGE_PROVIDER` | تحقق كل تطبيق/بوابة؛ لا توضع قيمة credentials فيها. |
| Replit storage | `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | معرف المنصة بحسب إعداد Replit؛ لا حاجة لمفتاح GCP مستقل للمسار sidecar. |
| S3 storage backend only | `OBJECT_STORAGE_S3_ENDPOINT`, `OBJECT_STORAGE_S3_REGION`, `OBJECT_STORAGE_S3_BUCKET`, `OBJECT_STORAGE_S3_ACCESS_KEY_ID`, `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`; اختياري: `OBJECT_STORAGE_S3_PRIVATE_PREFIX`, `OBJECT_STORAGE_S3_PUBLIC_PREFIXES` | ضع access/secret في backend فقط. حد صلاحيات bucket/prefix، امسح/دوّر عند تسرب؛ لا ترفع السري إلى المتصفح. |
| جلسات/أمان backend | `SESSION_SECRET`, `APP_ORIGIN`, `TRUST_PROXY_ORIGIN` | session secret لا يقل عن 32 حرفًا حسب handoff؛ اسماء origins إعدادات deployment. لا تدوير مفاجئ دون خطة إبطال جلسات. |
| AI backend/staging/prod | `DINAR_AI_PROVIDER`, `DINAR_AI_MODEL`, `DINAR_AI_BASE_URL`, `DINAR_AI_API_KEY`; الاعتمادات provider-named (`GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL`); اختياري `DINAR_AI_FALLBACK_*`, `DINAR_AI_MAX_RETRIES`, `DINAR_MODEL_TIMEOUT_MS`, `DINAR_AI_MODEL_FALLBACK`, `DINAR_AI_SPEND_REQUIRED` | fallback off إلا بقرار واختبار كلفة. Production gates: `DINAR_AI_CHAT`, `DINAR_AI_PRODUCTION_APPROVED`, `DINAR_LIVE_PROVIDERS_ENABLED`؛ تغييرها قرار إطلاق منفصل. `AI_INTEGRATIONS_*` Replit-specific ليس خطة Railway قابلة للنقل. |
| Vision backend | `DINAR_VISION_PROVIDER`, `DINAR_VISION_MODEL`, `DINAR_PUBLICATION_IMAGE_REVIEW` مع `GROQ_API_KEY` | development-only حسب الحواجز الحالية، لا تنقل إلى live. |
| SMS backend | `BDINAR_REQUIRE_PHONE_VERIFICATION`; بقية بيانات الاعتماد وأسماء webhook provider تُحدد بعد الاختيار | لا قيمة سرية موثقة لبوابة معينة حتى اختيار المورد. احتفظ بالـOTP في server/session scope ولا تسجل. |
| Notifications | `DINAR_NOTIFICATION_CHANNEL`, `DINAR_MONITORING_PROVIDER`, `DINAR_RELEASE` | الاعتماد غير محدد؛ اسم secret يتبع مزودًا وافق عليه المالك. |
| معاملات | لا أسماء credentials مثبتة لمزود دفع/اشتراك | لا تخترع متغيرات. سجلها بعد عقد المزود مع secrets للفصل بين sandbox/live. |
| Webhook signatures | أسماء provider-specific غير معتمدة | secret منفصل لكل provider/environment/endpoint، raw-body validation، rotate procedures. لا reuse `SESSION_SECRET`. |
| Staging vs Production | نفس أسماء الخدمة مع قيم واعتمادات مختلفة | لا تستنسخ live key إلى staging. مفاتيح sandbox وأرقام اختبار، نطاق callback منفصل، scopes قليلة، rotate/expiry metadata. |

## 7. التكلفة: الافتراضات ومعادلة التنبؤ

الموديل التفصيلي في `DINAR_INTEGRATIONS_COST_MODEL.md`. أهم قيود القراءة:
- «المستخدم النشط» لا يساوي عدد الطلبات المدفوعة أو GMV. لا نملك usage حقيقيًا يجعل أي سيناريو ميزانية نهائية.
- التقدير أعلاه لـAI يستخدم تعرفة OpenAI الرسمية لـ`gpt-6-luna` المنشورة يوم البحث فقط، دون أن يوصي بنموذج أو يثبت دعمه لعمل DINAR أو جودة لغته.
- تكلفة الموقع/قاعدة Railway تُحسب من CPU/RAM/volume/egress المستهلكة وخطة الحساب؛ المثال لا يحل محل الفاتورة أو sizing.
- الدفع يحسب كنسبة ورسوم ثابتة ورسوم payout/FX/refund/chargeback تختلف بالعقد. لا تُحسب من GMV كإيراد DINAR.
- SMS يعتمد البلد وعدد المحاولات والشرائح والـSender ID؛ البريد والخرائط والصور تعتمد الاستخدام. البنود غير المنشورة = **QUOTE REQUIRED**.

## 8. قائمة موافقات المالك

### قبل حسابات المزود
- [ ] اعتماد بلد/مدن pilot، كيان DINAR التجاري، نوع البائعين، سياسة التسجيل/إثبات الهاتف، وطريقة التشغيل اليدوي.
- [ ] تحديد ما إذا كانت الأموال تمر عبر المنصة، توقيت الحيازة والتسوية، Merchant of Record، استرداد/نزاع/سحب، رسوم البائع، التزامات KYC/KYB. الحصول على استشارة قانونية محلية؛ لا تعتمد على هذا المستند كفتوى.
- [ ] تأكيد متطلبات بيانات الإقامة/النقل العابر للحدود، الاحتفاظ والحذف، معالجة الصور/الصوت/AI، الموافقة، الدعم والحوادث.
- [ ] اختيار نطاقات staging والمنتج والدومين ومرسل الرسائل؛ تأكيد SPF/DKIM/DMARC إذا البريد مطلوب.
- [ ] مراجعة وضع Railway/النسخ/استعادة لدى المالك. لا نفترض أن التكامل المثبت في Replit موجود هنا.

### إعداد الحساب/الأوراق بعد القرار
- [ ] **AI:** حساب API مباشر للشركة/مالكها؛ غالبًا وسيلة دفع وحدود استخدام/فاتورة حسب المزود؛ راجع DPA والاحتفاظ/منطقة الخدمة؛ لا تعطي صلاحيات إدارة غير لازمة. لا يوجد سبب لإرسال مفتاح في chat.
- [ ] **Object storage:** حساب لدى المزود المختار، region ثابت، bucket/prefix منعزل، IAM key بأقل صلاحية. قد يلزم بطاقة/حساب مدفوع حسب المزود؛ لا ينشأ bucket قبل اعتماد المنطقة والـACL والاحتفاظ والتكلفة.
- [ ] **SMS:** حساب عمل، مستند كيان/هوية/عنوان قد يطلبه المزود أو شركات الاتصال؛ تسجيل Sender ID محلي واسم العلامة. وافق الرسوم المحملة والحد اليومي/المحاولة قبل اختبار أرقام حقيقية.
- [ ] **Email:** domain owner access لتسجيل DNS؛ حساب transactional mail؛ DKIM/SPF/DMARC وbounce domain؛ لا تخلط بيانات اعتماد DNS مع التطبيق. SES يتطلب إعداد الحساب/verified identities بحسب قيود AWS.
- [ ] **Push:** حسابات Apple Developer/Google/Firebase/Expo المطلوبة فقط عند native build؛ Apple Developer Program قد يتطلب اشتراكًا سنويًا/تحقق كيان؛ تحقق من السعر الحالي قبل التسجيل. لا حاجة لها لواجهة الويب وحدها.
- [ ] **Maps:** Google Cloud/Mapbox account وربط billing عند الحاجة؛ قيد مفتاح frontend على domains/APIs، سر backend منفصل، quotas/alerts، ومراجعة شروط حفظ بيانات الخرائط.
- [ ] **Courier:** عقد أعمال/حساب shipper مع مقدم خدمة البلد، بيانات مخازن/إرجاع/أوزان/ضريبة/عنوان؛ قد يتطلب KYB/تسعير تعاقدي؛ اطلب جدول رسوم COD والمرتجعات والتغطية ومستوى الخدمة.
- [ ] **Payments/subscriptions:** كيان تجاري مسجل وحساب بنكي باسم الكيان، وثائق KYC/KYB والمستفيد الحقيقي وسياسة refunds/terms/privacy، مراجعة مزود منصة للسوق وstore policies. البطاقة/الرسوم/الاحتياطي غير مؤكدة حتى عرض العقد.
- [ ] أدخل keys في Secrets داخل خدمة/بيئة backend المناسبة؛ فرّق sandbox/live. امنح permissions اللازمة للـAPI فقط، أدخل secrets الخاصة بالتوقيع منفصلة، وثّق جهة الاتصال وإجراء rotation/revoke. لا ترسل credentials في chat أو ملف.

## 9. blockers والمخاطر

1. **قرار سوق/قانون/مالية:** blocker قبل تحصيل الأموال/تسويتها أو إطلاق تجاري في بلد لم يعتمد.
2. **موافقة marketplace:** واجهة الدفع العادية لا تمنح صلاحية استقبال أموال لبائعين أو توزيعها. المسؤولية القانونية والـchargeback/reserve والتسوية يجب أن تكون مكتوبة.
3. **إثبات الهاتف:** إذا كان شرطًا، لا توجد وسيلة إرسال إنتاجية. سياسات Sender ID والتسعير قد تجعل Twilio غير اقتصادي/غير صالح في سوق بعينه.
4. **قاعدة/التعافي:** تقارير سابقة تسجل عدم توفر دليل حي لـbackup/PITR/restore؛ هذا blocker قبل بيانات مستخدم حقيقية. راجع التقرير المؤرخ واطلب قراءة مالك مصرحًا، ولا تنفذ هنا.
5. **التخزين:** اختبار S3 محلي mock فقط؛ لا يثبت endpoint، CORS، ACL لدى مزود، موقع بيانات أو تكافؤ المدة. ليس هناك bucket أو بيانات منقولة.
6. **الخصوصية:** لا توجد قناة بريد/Push جاهزة ولا قيمة مبررة لجمع البريد؛ لا ترسل أي AI prompt/audio/image لمزود دون خيار صريح وسياسة معتمدة.
7. **التكلفة/الجودة:** الأسعار لا تعطي SLA أو جودة عربية/tool-call أو deliverability. اختبار صغير مخول + حد مالي قبل أي ترافيك مستخدمين.
8. **الاعتماد التاريخي:** سجل التنفيذ يحوي إجراء مالك متعلقًا بتدوير/إبطال اعتماد GitHub تاريخي. لا نستخدمه ولا نعيد طباعته؛ تأكيد الإلغاء يبقى للمالك.
9. **نقل Railway:** إنشاء bucket/خدمة/secret/migration أو تعديل DNS/بيانات يحتاج موافقة منفصلة. وجود مكون Railway في مساحة العمل لا يثبت جاهزية أو صحة حساب.

## 10. تحديد أول خطوة

**أول قرار مطلوب من المالك:** هل رقم الهاتف شرط للإطلاق؟  
- إن كانت الإجابة نعم: أول تكامل تنفيذي هو adapter SMS واحد لسوق pilot واحد، بعد أن يؤكد المالك الأهلية وSender ID والسعر ويأذن بحساب/اختبار sandbox. استخدم العقد الحالي؛ لا تحول SMS إلى قناة إشعارات عامة بدون قرار منفصل.
- إن كانت لا: لا تُنشئ SMS؛ ابدأ بعد اختيار وجهة تخزين بإجراء قبول S3 staging غير منتج لأن الصور تتطلب قابلية نقل من Replit إلى Railway. هذه الخطوة تحتاج حساب/secret/bucket واختبار endpoint، ولذلك تظل محجوبة إلى تفويض واضح.

**ما نفعله الآن دون تفويض:** لا شيء خارجي. تم إعداد خطة تنفيذ واحتساب تكاليف المثال فقط؛ لا activation أو calls أو تغييرات بيئة.
