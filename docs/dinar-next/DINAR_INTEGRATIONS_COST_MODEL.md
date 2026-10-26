# DINAR — نموذج تقدير تكلفة التكاملات

**تاريخ الأسعار:** 2026-10-23.  
**ملاحظة:** تقديرات تخطيطية، ليست عرضًا/فاتورة أو ميزانية معتمدة. كل الرسوم بالدولار الاسمي قبل الضرائب/تحويل العملة ما لم يذكر غير ذلك. أسعار المزودين تتغير.

## 1. AI: سيناريوهات 100–100,000 مستخدم نشط

استخدمنا فقط سعر نموذج منشور على صفحة OpenAI الرسمية في تاريخ التحقق: `gpt-6-luna` القياسي **$0.10 لكل مليون token إدخال**، **$0.50 لكل مليون token إخراج**، والمدخل المخبأ **$0.01 لكل مليون**. افتراضات المتوسط:

| السيناريو | طلبات/مستخدم/شهر | input/طلب | output/طلب | input cache hit | retries/fallback overhead |
|---|---:|---:|---:|---:|---:|
| منخفض | 10 | 1,200 | 300 | 20% | 5% |
| متوقع | 40 | 1,800 | 500 | 20% | 10% |
| مرتفع | 100 | 3,000 | 800 | 20% | 20% |

المعادلة لكل طلب: `((input × (1−hit) × $0.10) + (input × hit × $0.01) + (output × $0.50)) / 1,000,000 × الطلبات × (1+overhead)`.  
التقدير لا يشمل صور/صوت/أدوات غير token/بحث مؤسس/كلفة مزود وسيط/ضرائب/حدود التخزين. overhead تمثيل احتياطي مبسط لا وعد بأن retries ستكلف بهذه النسبة. أرقام tokenizer الفعلية تختلف.

| المستخدمون النشطون شهريًا | منخفض | متوقع | مرتفع |
|---:|---:|---:|---:|
| 100 | $0.26 | $1.75 | $7.75 |
| 1,000 | $2.61 | $17.49 | $77.52 |
| 10,000 | $26.08 | $174.94 | $775.20 |
| 100,000 | $260.82 | $1,749.44 | $7,752.00 |

للمقارنة فقط: Anthropic Gemini/OpenAI أسعارها مختلفة؛ مثال Gemini 4 Argon يعلن $2/$10 لكل مليون input/output حتى 2026-11-30 ثم $4/$20 حسب الصفحة وقت التحقق، أي 20× كلفة نموذج الحساب قبل caching. اختيار السعر الأرخص لا يعني أنه الأفضل، ولا ننقل هذا النموذج إلى Groq أو مزود آخر دون سعر رسمي للموديل المحدد. في التشغيل يجب أخذ token usage من الاستجابة، مراجعة فاتورة المورد، ومطابقة `ai_cost_events` وسقف نقدي رافض للفشل.

## 2. تكلفة تشغيل Railway — معادلة لا فاتورة مقدرة

أسعار الوثائق الحالية: Hobby $5/mo، Pro $20/mo. التعرفة الأساسية المعلنة: RAM $10/GB-month، CPU $20/vCPU-month، egress خدمة $0.05/GB، volume $0.15/GB-month، Railway Buckets $0.015/GB-month. الاشتراك يذهب إلى الاستهلاك وفق الوثائق. الحساب الفعلي يعتمد خطة الموارد والـreplicas ووقت التشغيل وDB وbackup/volume/network. Buckets مجانية العمليات/egress الخاصة بالدلو؛ egress الذي يقدمه التطبيق يظل رسوم خدمة.

المعادلة المبسطة: `platform usage ≈ RAM_GB×10 + CPU_vCPU×20 + service_egress_GB×0.05 + volume_GB×0.15 + Railway_bucket_GB×0.015 + backup_incremental_GB×0.15`، ثم تُطبق خطة الحساب والائتمان/الحدود والموارد الفعلية. ليست كل البنود متاحة أو مفعلة في كل خطة/منطقة. لا نحسب قاعدة DINAR لأن قياس RAM/CPU/volume الفعلي غير متوفر هنا. صف R2 أدناه بديل عن كلفة Railway bucket وليس إضافة إليها.

أمثلة تخطيطية لتوضيح حساسية السعر فقط:

| ملف استخدام افتراضي | RAM مجمعة متوسطًا | CPU مجمع متوسط | egress خدمة | volume | bucket | مجموع استهلاك تقريبي قبل احتساب plan credits/نسخ |
|---|---:|---:|---:|---:|---:|---:|
| Pilot صغير | 1.5 GB | 0.75 vCPU | 20 GB | 10 GB | 10 GB | $32.65/mo |
| نمو مبكر | 4 GB | 2 vCPU | 100 GB | 40 GB | 100 GB | $92.50/mo |
| واسع | 16 GB | 8 vCPU | 1,000 GB | 200 GB | 1,000 GB | $415.00/mo |

هذه **أحمال اصطناعية** وليست forecast DINAR أو توصية sizing: مثلًا، الإجمالي التجميعي قد يغطي web/API/DB/worker ولا يضمن تحملًا أو توافرًا. أما plan credit فيؤثر على billed amount ويجب حسابه وفق workspace الفعلي؛ لا تجمع الاشتراك والـusage مرتين. النموذج لا يشمل build (المذكور مجاني في Railway)، النسخ المتزايدة، PITR/backup، replica HA، CDN، domain، support، أو taxes. تحقق من لوحة الفاتورة قبل اعتماد ميزانية.

## 3. وحدات متغيرة وبنود غير محسومة

| البند | قياس يمكن إدخاله بعد الموافقة | مثال أو حد منشور | لا يشمل |
|---|---|---|---|
| R2 Standard | GB-month + Class A + Class B | $0.015/GB-month؛ 1M A و10M B و10 GB-month ضمن free tier؛ بعدها $4.50/M A و$0.36/M B؛ egress بلا رسوم | معالجة/معالج صور، CDN، region residency، taxes |
| Railway Buckets | GB-month | $0.015/GB-month، عمليات S3 وegress bucket مجانية | egress عبر API service |
| Backblaze B2 | GB-month + reads/writes + egress | ابتداءً $6.95/TB-month حسب الصفحة؛ free egress حتى 3× average storage ثم $0.01/GB | اختلاف منطقة الحساب أو خطط حجمية |
| Email SES | عدد البريد + مرفقات GB | $0.10/1,000 outbound + $0.12/GB attachments وفق à-la-carte | DNS، بounces/complaints أو مميزات إضافية |
| Resend | عدد البريد | Free 3,000/mo، حد 100/day؛ Pro $20/50k، overage معلن $0.90/1k | عدم وجود بريد مُسجل/موافقة المستخدم |
| Postmark | حجم حزمة/overage | مجاني 100/mo؛ بداية مدفوعة معلنة $15/mo؛ السعر الإضافي حسب الحزمة (تظهر صفحة الأسعار $1.80/1k على الشريحة الابتدائية) | تكاليف نطاق الإرسال أو اتفاق Enterprise |
| Twilio SMS | destination × segments × attempts + Verify | SMS عادي: JO $0.4429، KW $0.3164، SA $0.1949 للرسالة كما ظهر 2026-10-23؛ Verify يضيف $0.05/verification ناجح + channel tariff | قد تضاف carrier fees؛ أسعار البلد والمرسل قد تتغير؛ لا تستخدمها كتكلفة Verify إجمالية |
| Infobip/Vonage SMS | رسالة/بلد/مسار/مرسل | **QUOTE REQUIRED** لحساب/تغطية مهيأة | Sender ID، onboarding، minimum commitments المحتملة |
| Google Maps | SKU calls (maps, routes, places, geocoding) | free caps وتسعير tiers في جدول SKU يتغير؛ البلدان الثلاثة تظهر في coverage | lookups per feature, taxes, provider restrictions |
| Mapbox | map loads/requests/MAU/trips | تسعير pay-as-you-go وحدود مجانية متغيرة | استخدام backend/frontend وتقسيم الترافيك |
| Payments | كل عملية + fixed fee + refund/chargeback + payout/FX + reserve | **QUOTE REQUIRED** لكل كيان/بلد ونموذج marketplace | لا تحسب GMV كدخل أو مصروف صافٍ؛ لا اشتقاق رسوم من صفحة تسويق |
| Subscription | مبلغ خطة digital، store fees، tax، refund | **QUOTE/APP STORE RULES REQUIRED** | لا توجد أسعار Go/Pro معتمدة ولا حجم مشتركين |
| Observability | Events/attachments/retention | Sentry free/team/business tiers متغيرة | لا يلزم مزود ثانوي لإثبات availability؛ لا تحمّل prompts/PII |
| Backup/PITR | volume snapshots/archived WAL/base backups | Railway توثق أسعار volume/بنية PITR؛ الحالة الفعلية للحساب غير مثبتة | لا يوجد restore test في هذه الجولة |
| Hosted apps/DB | CPU/RAM/replicas/uptime/volume | احسب من Railway usage metrics الحالية بعد sizing واختبار حمل مصرح | لا تتوفر قياسات صالحة لتوقع عائد/حمل DINAR |

## 4. تجميع pilot/نمو/نطاق كبير

الجمع التالي يوضح **المعروف القابل للحساب**، ولا يضع تكلفة وهمية للبنود التي لا تملك أسعارًا أو استخدامًا. اضبط عدد رسائل/خرائط/إيميلات/عمليات من سجلات pilot بعد consent:

| البند الشهري | Pilot | Early growth | Large scale |
|---|---:|---:|---:|
| Hosting + DB + شبكة + volume + bucket (أمثلة موارد §2) | $32.65 | $92.50 | $415.00 |
| AI — إذا كل المستخدمين في السيناريو المتوقع | $1.75 لكل 100 مستخدم | $174.94 لكل 10,000 مستخدم | $7,752 لكل 100,000 مستخدم |
| Email SES لو أُرسل 1,000/50,000/1,000,000 بريد | $0.10 | $5.00 | $100.00 |
| R2 بدل Railway bucket (10/100/1,000 GB) | $0 تقريبًا ضمن 10GB allowance (أقل $0.15 من Railway) | $1.35 فوق free 10GB (أقل $0.15 من Railway) | $14.85 فوق free 10GB (أقل $0.15 من Railway)، قبل Class A/B |
| SMS / maps / processor / courier / app stores | غير محسوب: usage mix/العقد غير متوفر | غير محسوب | غير محسوب |
| **المجموع الجزئي المعلوم** | **$34.50 تقريبًا** | **$272.44 تقريبًا** | **$8,267.00 تقريبًا** |

المجاميع تجمع أمثلة غير مرتبطة ببعضها (Resource profile افتراضي + AI expected + SES volume)، وتُقرأ كحساسية لا خطة مالية. تخزين R2 بديل عن Railway bucket ولا يجمع مرتين. في pilot افترضنا 100 user/1,000 email/10GB storage؛ النمو المبكر 10,000 user/50k email/100GB؛ الكبير 100,000/1M/1TB. لا تُعتبر الرسوم «تكلفة لكل مستخدم» دقيقة؛ المجاميع قبل رصيد الخطة/الضرائب وتعرفة SES الانتقائية.

### ما يلزم لتحويله إلى forecast صالح
1. عدد MAU/DAU المتفق عليه وفعاليات الطلب/المحادثة لكل مستخدم.
2. عينة token usage مجهولة الهوية وrequest mix (simple/tool/complex/vision/audio) وموديل فعلي.
3. مجموعات رسائل OTP الناجحة/المرفوضة/المحاولات لكل بلد والـSMS segment count.
4. عدد صور ومتوسط حجمها ومعدل التحميل/المشاهدة/الحذف وعمر الاحتفاظ.
5. Geo requests حسب SKU، email recipients/bounces، push recipients/device count.
6. طريقة الدفع، GMV منفصلًا عن إيراد DINAR، متوسط ticket/refunds/disputes/payout، وعرض PSP مكتوب.
7. موارد Railway المتوسطة والذروة، عدد replicas، جغرافيا الخدمات، تخزين PostgreSQL ونسخ البيانات/restore.

## 5. ضوابط تقليل الكلفة

- لا تفعّل AI لكل استفسار؛ المسار الحتمي يسبق النموذج حيث مناسب، حد أحرف/سياق، نموذج منخفض الكلفة لمهمة بسيطة بعد قياس، caching إذا لا يضعف الخصوصية، وحدود per-user/global وأداة تنبيه.
- fallback مزود واحد فقط بعد حساب أسوأ حالة اختبارية؛ no automatic fallback يضيف فاتورة غير متوقعة. لا تعتمد على free-tier إنتاجيًا.
- اضبط OTP resend/cooldown/number allowlist أولًا وراقب fraud/pumping؛ قس الرسالة كسعر الوجهة لا سعر US marketing page.
- صور مصغرة/formats وحد أقصى upload ودورات retention معتمدة؛ egress مجاني للدلو لا يعني مجانيًا من خدمة التطبيق.
- SES اقتصادي على السعر لكنه يتطلب مجالًا موثقًا ومراقبة السمعة؛ Resend ثمن راحة تشغيل لا دليل وصول أفضل.
- خرائط: طلب geocode عند الحاجة، تجنب إعادة طلب route دون تغير، احترم شروط cache/tiles، لا تجمع موقعًا دقيقًا بلا إذن.
- لا تدفع تكلفة Sentry/queue/ES ولا carrier API قبل وجود workload تثبت الحاجة.
- حدود مزود الدفع تشمل chargeback/reserve/refund/payout وFX؛ أقل percentage منشور لا يضمن أفضل net cost أو تقليل المخاطر.

## Sources

- AI pricing: https://developers.openai.com/api/docs/pricing ؛ https://platform.claude.com/docs/en/about-claude/pricing ؛ https://ai.google.dev/gemini-api/docs/pricing ؛ https://groq.com/pricing/ ؛ https://openrouter.ai/pricing
- Hosting/storage: https://docs.railway.com/pricing/plans ؛ https://docs.railway.com/storage-buckets/billing ؛ https://developers.cloudflare.com/r2/pricing/ ؛ https://www.backblaze.com/cloud-storage/pricing
- Messaging/email: https://www.twilio.com/verify/pricing ؛ https://www.twilio.com/en-us/sms/pricing/jo ؛ `/kw` ؛ `/sa` ؛ https://aws.amazon.com/ses/pricing/ ؛ https://resend.com/pricing ؛ https://postmarkapp.com/pricing
- Maps/payments/push: https://developers.google.com/maps/billing-and-pricing/pricing ؛ https://www.mapbox.com/pricing ؛ https://www.myfatoorah.com/en/faqs/ ؛ https://developers.tap.company/docs/marketplace-overview ؛ https://firebase.google.com/products/cloud-messaging ؛ https://docs.expo.dev/push-notifications/faq/
