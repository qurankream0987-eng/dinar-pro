# DINAR NEXT — التحقق المستقل الكامل من التنفيذ

تاريخ الفحص: 2026-10-20. هذا تدقيق للحالة الموجودة، وليس تنفيذًا أو اعتمادًا للتغييرات. لم أنشر التطبيق، ولم أرسل طلبات إلى مزوّد AI، ولم أجرِ أي تعديل على قاعدة بيانات.

## ملخص البيئة الحالية

- جذر المستودع: `/home/runner/workspace`؛ المشروع هو تطبيق DINAR (`artifacts/dinar`, `@workspace/dinar`).
- الفرع: `main`؛ HEAD عند بدء التدقيق وبعده: `80fb76329be46d8a73e5097e6b325753f1d09d84`. HEAD المتوقع `fc4060d` موجود في التاريخ، وتليه إضافة مستند التحقق المرفق فقط.
- حالة العمل الأولية: نظيفة عدا ملف التحقق المرفق غير المتعقب. بعد التدقيق أُضيف هذا التقرير فقط؛ لم أعدّل ملفات التطبيق.
- الإعدادات/الأسرار: فُحص وجود المتغيرات فقط، ولم تُقرأ قيمها. `DATABASE_URL`, `DINAR_DEV_DATABASE_URL` ومفاتيح مزوّدي AI موجودة في بيئة Replit.
- اختبارات قاعدة البيانات: لا توجد PostgreSQL محلية متاحة على 5432 أو 5433 أو 55432 أو 55438 أو 55479. حارس الاختبارات رفض التشغيل لأن `BDINAR_DISPOSABLE_ACCEPTANCE_DB=1` غير متاح. لم أحاول تجاوز الحارس ولم ألمس قاعدة مُدارة.

## مصفوفة التحقق

الحالات المستخدمة: `PASS`, `PARTIAL`, `FAIL`, `BLOCKED`, `NOT TESTED` فقط. تقارير القبول القديمة أدلة تاريخية وليست إعادة تحقق للحالة الحالية.

| REQUIREMENT ID | ORIGINAL REQUIREMENT | IMPLEMENTATION FILE/FUNCTION | TEST EVIDENCE | RUNTIME EVIDENCE | STATUS | DEFECT OR BLOCKER | RECOMMENDED ACTION |
|---|---|---|---|---|---|---|---|
| BASE-01 | التحقق من المستودع والفرع وHEAD وحفظ عمل المستخدم | Git repository؛ `main` | HEAD الفعلي `80fb763…`; لا تغيير في ملفات التطبيق أثناء التدقيق | التطبيق يعمل عبر سير العمل الحالي | PASS | لا يوجد | الحفاظ على التغييرات الحالية وعدم استخدام أوامر Git مدمرة |
| A-01 | مسار السؤال العام من الواجهة إلى النموذج والرد والحفظ والاستعادة | `ai.ts`, `conversation-runtime.ts`, `smart-turn.ts`, `model-turn.ts`, `model-gateway.ts`, `Ai.tsx` | تقارير FINAL/G3 تسجل اختبارات A وF، لكنها لم تُعد هنا | لقطة 390px تعرض شاشة محادثة ضيف؛ لا جلسة دخول أو سؤال مستخدم موثق | PARTIAL | اختبارات API تتطلب DB اختبارية غير متاحة؛ readiness غير جاهز | توفير قاعدة مؤقتة loopback وإعادة اختبارات A وF مع مستخدم موثق |
| A-02 | المعرفة العامة والبرمجة والعربية والسياق والتصحيح وتغيير الموضوع والطلبات المختلطة | `smart-turn.ts`, `intent.ts`, `task-plan.ts`, `conversation-runtime.ts` | تقارير قديمة تسجل command-a وconversation regressions | لم تُختبر محادثة موثقة حالياً | PARTIAL | لا دليل تفاعلي حالي | إعادة محادثات عربية متنوعة مع حفظ السياق وإعادة التحميل |
| A-03 | تنفيذ متعدد الخطوات آمن وتفويض الأدوات التجارية | `action-foundation.ts`, `smart-turn.ts`, `conversation-runtime.ts` | اختبارات تاريخية فقط؛ حارس DB منع إعادة التشغيل | غير مختبر | PARTIAL | تفويض وتنفيذ الأفعال لم يُتحقق منه في جلسة حالية | تشغيل اختبارات action/auth على DB مؤقتة وتوثيق رفض actor غير المصرح |
| A-04 | أخطاء المزوّد وعدم اختلاق النتائج والتحقق من المزوّد الافتراضي | `model-gateway.ts`, `model-turn.ts` | FINAL_ACCEPTANCE يسجل تاريخياً GROQ = 0/8 (401)، وREPLIT_OPENAI = 8/8 | لم يُرسل طلب live؛ المفتاح موجود لكن لا يمكن استنتاج صلاحيته من وجوده | PARTIAL | آخر تقرير يقول إن الافتراضي GROQ يرفض المفتاح؛ لم يُعد الاختبار | تدوير/إصلاح مفتاح GROQ أو اعتماد مزود موثق، ثم اختبار live مصرح به |
| B-01 | إنشاء الإعلان ومسودة البائع واستكمالها وتصحيحها والصور والمراجعة والنشر | `listing-draft.ts`, `routes/marketplace.ts`, `OfferForm.tsx` | تقارير phase1 وG3 وcommand-f تاريخية؛ لم تُشغّل اليوم | لم يُختبر حساب بائع موثق | PARTIAL | لا اختبار قبول حالي؛ لا DB مؤقتة | إعادة رحلات المسودة/الصورة/النشر على قاعدة مؤقتة وحساب اختبار |
| B-02 | البحث والمقارنة وحل مرجع الإعلان والسوق | `marketplace-intent.ts`, `commerce-turn.ts`, marketplace services | command-b / G3 تقارير تاريخية | غير مختبر حالياً | PARTIAL | بيانات النتائج الحقيقية وصلاحية السوق غير مثبتة في الجلسة الحالية | إعادة اختبارات search/reference/market isolation |
| B-03 | التفاوض والعروض والسعر المتفق عليه ومنع الدفع المباشر الخاطئ | `negotiation-turn.ts`, `lib/negotiations.ts`, checkout/order routes | FINAL_ACCEPTANCE يذكر قاعدة أن NEGOTIABLE يحتاج اتفاقاً؛ اختبارات تاريخية | لم يُنفذ تفاوض أو checkout | PARTIAL | التزام التطبيق الحالي بالقاعدة لم يُعد تشغيله | إعادة قبول fixed/negotiable مع رفض checkout قبل الاتفاق |
| B-04 | الطلب والمراجعة والشراء والاستلام والإيصال وحالة التسليم | `routes/marketplace.ts`, order services, `ConversationContent.tsx` | تقارير command-f/blockf4 تاريخية | API readiness الحالي غير جاهز | BLOCKED | لا قبول DB أو رحلة موثقة حالياً | بعد تجهيز DB مؤقتة، اختبر checkout والreceipt والتاريخ بعد reload |
| B-05 | خيارات التوصيل وسير عمل الساعي وخصوصية بيانات الاتصال | courier delivery services, `contact-release.ts`, order surfaces | تقارير سابقة تسجل اختبارات delivery/contact | لم يُختبر ساعي أو مزود tracking حي | PARTIAL | لا مزود tracking/GPS/ETA حي؛ تقارير الاختبار قديمة | أبقِ حالات المزود غير المتاح صريحة، وأعد اختبارات الصلاحيات على DB مؤقتة |
| C-01 | كتابة إعلان وتسويق صادق، رفض ادعاء غير مسند، ووسم المحتوى الممول | `seller-management.ts`, claim guard, `command-c` tests | تقارير command-c/command-f تاريخية | لم تُجرَ محادثة تسويق حية | PARTIAL | حارس الادعاءات نمطي وليس ضماناً كاملاً؛ موثق في FINAL_ACCEPTANCE | أضف حالات قبول للحيل اللغوية والادعاءات الطبية/الضمان دون اختلاق |
| C-02 | مخزون وإحصاءات البائع الفعلية وعدم كشف بيانات مستخدم آخر | `business.ts`, `seller-management.ts`, `seller-sales.ts` | next-g3/G3 report يذكر إحصاءات ومقارنة وعزل حسابات؛ لم يُعد الاختبار | لم تُستخدم بيانات بائع موثقة الآن | PARTIAL | الوصول إلى DB غير متاح للاختبار الآمن | تحقق من نطاق actor والسوق ومجاميع gross/paid/refunded/net في اختبار مؤقت |
| D-01 | مخططات typed متوافقة بين runtime وOpenAPI وOrval والواجهة | `lib/api-spec/openapi.yaml`, generated `api-zod`, `conversation-runtime.ts` | build/typecheck ناجح؛ codegen/drift لم يُشغّل حالياً لتجنب كتابة ملفات مولدة | لا أخطاء عرض قاتلة في لقطة 390px | PARTIAL | توافق العقد المولد تاريخي فقط | شغّل codegen في نسخة مؤقتة وقارن عدم وجود drift |
| D-02 | البطاقات والأزرار تنفذ أفعالاً حقيقية مع تأكيد وحالات تحميل/خطأ/استعادة | `action-foundation.ts`, `CommercialSurface.tsx`, `InquirySurface.tsx`, `ConversationContent.tsx` | تقارير اختبارات D/G3 تاريخية | لم تُنقر الأزرار في قبول موثق | PARTIAL | لا تحقق حالي من كل فعل أو إعادة تحميله | إعادة اختبارات action/reload والتأكد أن لا زر زخرفي ينفذ عملية مزيفة |
| E-01 | RTL وموضوع فاتح/داكن وقابلية وصول ولوحة مفاتيح/لمس | `AiChat.css`, theme, `Ai.tsx`, surfaces | تقرير E يسجل 96 صفحة تاريخية | لقطة الضيف عند 390px تبدو RTL ومن دون overflow ظاهر؛ لا اختبار تفاعل | PARTIAL | لم تُختبر المقاسات الثمانية أو لوحة المفاتيح حالياً | إعادة فحص 320/375/390/430/768/1024/1440/1600 في Light/Dark |
| E-02 | الأداء وحجم الحزمة الحالي ومقارنته بالتقرير | Vite production build | `pnpm run build` نجح | حجم index الحالي 791,508 bytes؛ gzip فعلي 228,657 bytes | PARTIAL | تقرير FINAL يسجل 776,560 / 225,520 bytes؛ الحالي أكبر بـ14,948 / 3,137 bytes | قياس سبب زيادة chunk ومراجعة التحميل الفعلي على شاشة المحادثة |
| F-01 | التكامل العام وtypecheck/build | workspace scripts, all packages | `pnpm run build` الحالي نجح، ويتضمن typecheck | API/web workflows يعملان | PASS | نجاح البناء لا يثبت القبول الوظيفي | إبقاء البناء شرطاً قبل القبول النهائي |
| F-02 | readiness والهجرات الجارية | `/api/readyz`, migration runner | لا تغيير قاعدة بيانات؛ لا اختبار هجرة | `/api/readyz` الحالي: `not_ready`, database=`ready`, migrations=`pending` | FAIL | خدمة API الحالية ليست جاهزة وفق readiness؛ لم تُحدد الهجرة الناقصة دون قراءة/تعديل DB | تحديد النواقص على قاعدة مؤقتة أولاً؛ لا تطبق migrations على قاعدة مُدارة أثناء هذا التدقيق |
| F-03 | رجوع اختبار phase1 القديم واجتياز regressions | `phase1-acceptance.test.ts`, `test/run.mjs` | FINAL_ACCEPTANCE الأقدم يسجل 713/1/1 وphase1 stale؛ G3_FINAL الأحدث يسجل 768/0/1 وphase1 محدثة. لا إعادة تشغيل حالية | لم تُنفذ رحلة phase1 | BLOCKED | تقارير تاريخية متعارضة، وحارس الاختبارات يتطلب DB مؤقتة | أعد phase1 والتراجع الشامل على DB disposable، وسجل نسخة التقرير والنتيجة |
| G0-01 | تدقيق الموجود قبل G: الخطط والصلاحيات والاتصال وإشعارات الاستخدام | `business.ts`, `inquiries.ts`, `G0_EXISTING_CAPABILITY_AUDIT.md` | مستند G0 يصف baseline سابقاً؛ ليس دليلاً على حالة runtime الآن | غير مختبر | PARTIAL | المستند تاريخي، وبعض فجوات baseline تغيرت في G1/G2 | مطابقة baseline الحالي بالخدمات والمخططات والاختبارات |
| G1-01 | FREE/BUSINESS_GO/BUSINESS_PRO مع فصل القدرات عن حصص الاستخدام | `ai-usage-policy.ts`, `commercial-policy.ts`, `business.ts` | G1/G3 reports تزعم قبولاً تاريخياً؛ لا تنفيذ حالي | لا استعلام حساب موثق | PARTIAL | الأسعار والحدود placeholders غير معتمدة (`approved:false` وفق G3 report) | لا تفعّل الأسعار؛ احصل على اعتماد المالك ثم أعد اختبارات السياسة |
| G1-02 | حد شهري للطلبات والرموز، guest allowance، تجديد/انتهاء/ترقية | `lib/ai-usage.ts`, `usage-turn.ts`, migration `0035_ai_usage_allowances.sql` | اختبار next-g1 تاريخي (21/21 حسب التقارير)؛ منع الحارس إعادة الاختبار | لا اختبار حالي | PARTIAL | لا تثبت هذه الجلسة atomicity أو expiry/reconciliation | شغّل concurrency/idempotency/expiry/isolation على DB loopback جديدة |
| G1-03 | حجز ذري، تسوية/إرجاع، retries، فشل مزود، حماية global budget | `reserveAiUsage`, `settleAiUsage`, `smart-turn.ts`, `model-turn.ts` | source symbols موجودة؛ الاختبارات التاريخية غير معادة | غير مختبر | PARTIAL | حد tokens/requests ليس سقف تكلفة نقدية مثبتاً؛ تقرير G3 يذكر أن استخراج ذاكرة الخلفية غير مفوتر لكل مستخدم | وضّح صراحة حد التكلفة الحقيقية، وغطِّ كل نداء مدفوع واستخراج الخلفية |
| G1-04 | الاستخدام والخطط تُعرضان عبر المحادثة مع بيانات حقيقية بعد نفاد الحصة | `usage-turn.ts`, `commerce-turn.ts`, `CommercialSurface.tsx` | تقارير G3 تاريخية | غير مختبر بحساب موثق | PARTIAL | لا تحقق حالي من نسبة الاستهلاك/الحدود/التجديد | قبول محادثة موثقة يقارن البطاقة بالledger بعد reload |
| G2-01 | استفسار مشتري للبائع: resolve، draft، موافقة، حفظ، تسليم ورد منسوب | `inquiry-turn.ts`, `lib/inquiries.ts`, `marketplace_inquiries`, migration `0036_marketplace_inquiries.sql` | next-g2 17/17 تاريخي وفق التقرير | لا رسالتان موثقتان/طرفان حيّان في هذا التدقيق | PARTIAL | لا اختبار حالي بسبب غياب DB مؤقتة وحسابات موثقة | إعادة الرحلة ثنائية الطرف مع reload وتأكيد persistence/attribution |
| G2-02 | صلاحيات الطرف والسوق، تكرار/معدل/حظر، منع هاتف/بريد/روابط والتلاعب بالموديل | `lib/inquiries.ts`, `inquiry-turn.ts`, `safe-development-database` tests | الأدلة التاريخية فقط | غير مختبر | PARTIAL | الخصوصية مهمة لكن لا اختبار اختراق/actor isolation حالياً | أعد سيناريوهات الطرف الآخر والسوق والحدود وإدخال prompt injection |
| G2-03 | رسائل غير متزامنة وحالات submitted/delivered/read/replied | `lib/inquiries.ts`, `InquirySurface.tsx` | تقارير G2/G3 تاريخية | لا اتصال SMS/email/push؛ delivery الموصوف داخلي فقط | PARTIAL | النقل الخارجي للإشعارات غير موجود | أبقِ NOT_CONFIGURED للمستخدم؛ لا تدّعِ إرسالاً خارج التطبيق |
| G3-01 | الدمج النهائي وإعادة بناء السطوح من التخزين بعد reload | `conversation-runtime.ts`, `freshBlocksForConversation`, typed surfaces | تقرير G3 يذكر 14/14 و49 suite تاريخياً | لم تُختبر جلسة موثقة أو reload في هذه الجلسة | PARTIAL | evidence تاريخي فقط | أعد قبول G3 end-to-end على البيئة المؤقتة |
| CF-01 | View plans / prices أو قول إنها غير معتمدة / entitlement / allowance / renewal | `usage-turn.ts`, `business.ts`, `CommercialSurface.tsx` | لا اختبار حالي؛ G3 يذكر الأسعار «غير معتمدة بعد» | غير مختبر | BLOCKED | لا أسعار معتمدة أو مزود billing | حافظ على حالة pending ولا تنشئ اشتراكاً أو سعراً وهمياً |
| CF-02 | Usage percentage، نفاد AI مع بقاء الاستعلام والتجارة الأساسية | `ai-usage.ts`, `usage-turn.ts`, `commerce-turn.ts` | تقرير G3 تاريخي | غير مختبر | BLOCKED | الحصة الحالية لا يمكن ربطها بمستخدم فعلي بأمان الآن | اختبار نفاد الحصة ثم استعلام usage وشراء/تواصل لا يعتمد على AI |
| CF-03 | إحصاءات هذا الشهر، مقارنة الفترات، الأكثر طلباً وعزل غير المالك | `seller-sales.ts`, `seller-management.ts`, `BusinessSummaryPanel.tsx` | تقارير G3 تاريخية | لا بيانات حالية تم فحصها | BLOCKED | يحتاج DB ومستخدمين اختبار | تحقق من الفترات UTC والحقائق المالية والنطاق دون بيانات غير مصرح بها |
| CF-04 | inventory، تعديل إعلان مع تأكيد، وإجابة سؤال المشتري | `seller-management.ts`, `action-foundation.ts`, inquiry services | G3 report يدعي تغطية تاريخية | لم تُنفذ أفعال أو تأكيدات حية | BLOCKED | لا قبول موثق | أعد الاختبار مع مستخدمين موثقين وسجلات fixture فقط |
| CF-05 | إعادة تحميل، mobile/RTL، provider unavailable، billing unavailable، فشل بلا نجاح وهمي | `ConversationContent.tsx`, model and billing adapters | تقارير سابقة | 390px static guest screenshot فقط؛ API readiness غير جاهز | PARTIAL | فشل المزوّد والbilling لم يُختبرا الآن | أعد قبول الحالات بعد استعادة readiness؛ أبقِ الفشل صريحاً |
| SAFE-01 | لا نشر/دفع/بيانات إنتاج/تغيير أسعار أو عمولات أثناء التدقيق | workflows/API | لم أشغّل أي migration أو deployment | لا تغييرات إنتاجية أجريتها | PASS | لا يوجد | الاستمرار على هذا الحد الآمن |
| SAFE-02 | لا credentials مضمّنة أو مكشوفة في إعدادات committed/history | `.replit`, Git history | SAST وجد `secrets.services.github_pat.github_pat`; التاريخ يتضمن النمط في `f60e30d` | القيمة لم تُقرأ أو تُطبع أو تُستخدم | FAIL | GitHub PAT-shaped credential مكشوفة؛ الصلاحية الحالية غير مؤكدة | ألغِ الرمز، استبدله بـ Replit Secret محدود الصلاحيات، وقيّم معالجة التاريخ |

## نتائج التحقق المباشر

- **Typecheck/build:** `pnpm run build` نجح، متضمناً `pnpm run typecheck` وبناء API وواجهة DINAR وبقية الحزم.
- **اختبارات الوحدة والقبول:** محاولة `ai-provider.test` توقفت قبل تنفيذ الاختبار عند `acceptance-database-guard.mjs`: يلزم `BDINAR_DISPOSABLE_ACCEPTANCE_DB=1`. لم تُنفذ suites ولا تُحسب فاشلة أو ناجحة. لا يوجد loopback PostgreSQL على المنافذ المعروفة.
- **العقود:** ملفات OpenAPI والأنواع المولدة موجودة؛ لم أشغّل codegen لأنه يكتب ملفات مولدة، ولم أغيرها في مهمة التدقيق.
- **Runtime:** الواجهة استجابت HTTP 200، وصورة الضيف بعرض 390px أظهرت محادثة عربية RTL دون overflow ظاهر أو خطأ قاتل في console. هذا لا يثبت رحلة الدخول أو الأفعال أو المقاسات الأخرى. API health غير جاهز بسبب `migrations=pending`.
- **Bundle:** `index-B1tfV7Hg.js` = 791,508 bytes raw، 228,657 bytes gzip. ذلك أكبر من القياس المسجل في FINAL_ACCEPTANCE.

## الأمن والخصوصية والتكاملات

- **Dependency audit:** `PASS` — صفر findings (critical/high/moderate/low/info).
- **SAST:** `FAIL` — finding واحد `CRITICAL`: قيمة على هيئة GitHub PAT في `.replit`. مسار مطابق موجود في تاريخ Git عند `f60e30d`; لم أطبع القيمة ولم أستخدمها. اعتبرها مكشوفة، ألغِ الرمز فوراً، ولا تكتفِ بحذفها من working tree؛ يلزم معالجة أثر التاريخ وفق مالك المستودع.
- **HoundDog:** `BLOCKED/UNAVAILABLE` بسبب `HOUNDDOG_SCHEMA_MISMATCH`؛ لم أسجلها نجاحاً.
- **Live AI:** غير متحقق في هذه الجلسة. آخر دليل تاريخي يسجل أن GROQ الافتراضي أعاد 401، بينما `REPLIT_OPENAI` نجح في smoke سابق. مفاتيح البيئة الموجودة لا تثبت صلاحيتها.
- **Payments/subscriptions:** لا مزود billing حيّ؛ التفعيل محاكاة تطويرية فقط، ولا أسعار/حصص معتمدة بحسب G3 evidence. لم أفعل دفعاً حقيقياً.
- **Notifications/courier:** لا transport SMS/e-mail/push ولا GPS/ETA/tracking حيّ موثق؛ التقارير تصف تسليم inquiry داخل التطبيق فقط.
- **Database:** readiness تقول database ready ولكن migrations pending. لم أقرأ سجلات بيانات أو أطبق migrations.

## القدرات الفعلية مقابل غير المحققة

توجد بنية مصدرية واضحة للمحادثة العامة، متجر DINAR، التفاوض، الإجراءات typed، قياس الاستخدام، inquiries، وإحصاءات البائع. البناء الحالي ولقطة الضيف يثبتان قابلية التجميع والعرض الأساسي فقط. لا أصف هذه القدرات بأنها مكتملة وظيفياً الآن لأن acceptance DB/browser journeys لم تُعد، وخدمة API تعلن `not_ready`.

القبول المحادثي المطلوب — عرض/إدارة الخطط، الأسعار غير المعتمدة، entitlement والاستخدام والتجديد، البائع وإحصاءاته ومقارنته، inventory وتعديل الإعلان بتأكيد، inquiry مع رد حقيقي منسوب، reload، mobile/RTL، provider unavailable، billing غير مهيأ، وفشل الفعل دون نجاح وهمي — **غير مختبر في جلسة مستقلة**. تقارير G3 تسجل تاريخياً 18 سيناريو، لكن لا تحل محل إعادة التحقق.

## ادعاءات غير مؤكدة أو متعارضة

- تقارير القبول ليست متسقة: `FINAL_ACCEPTANCE.md` يسجل 713 نجاحاً، فشل phase1 واحداً، وتخطي واحد؛ `G3_FINAL_ACCEPTANCE.md` الأحدث يسجل 768/0/1 ويقول إن phase1 أصلح. لم يمكن إعادة التشغيل حالياً.
- أرقام أداء bundle التاريخية أقل من القياس الحالي بنحو 14,948 raw / 3,137 gzip bytes.
- تقرير readiness السابق يصف migrations current، أما endpoint الحالي فيقول `pending`.
- نتائج browser السابقة (96 تشغيل عرض/RTL، رحلات موقعة الدخول) لم تُعاد؛ لقطة الحالية ضيف فقط.

## العيوب والحواجز وأولويات الإصلاح

1. **حرج — GitHub PAT داخل `.replit` والتاريخ:** ألغِ الرمز فوراً، أنشئ بديلاً محدود الصلاحيات في Replit Secrets، ثم راجع خيارات إزالة/احتواء السر في التاريخ دون force-push أو إتلاف عمل المستخدم.
2. **إطلاق محجوب — API `not_ready` بسبب migrations pending:** افحص سبب drift على نسخة PostgreSQL مؤقتة loopback فقط؛ لا تطبق شيئاً على DB مُدارة ضمن هذا التدقيق.
3. **قبول G0–G3 محجوب:** أنشئ disposable loopback database معزولة، أعد كل suites بالتسلسل، ثم نفذ رحلات متصفح موقعة الدخول ومصفوفة المقاسات.
4. **تكلفة AI غير مثبتة كسقف نقدي:** افصل عدّادات الطلب/الرموز عن الحد النقدي الحقيقي، وأدرج كل نداء مدفوع بما فيه مهام الخلفية في تغطية guard.
5. **تكاملات غير جاهزة:** لا تفعّل billing ولا تدّعِ إشعارات أو courier حيّاً حتى اختيار/تهيئة المزودين واعتماد الأسعار والسياسات.
6. **تعارض الأدلة وحجم الحزمة:** حدّث تقرير قبول واحداً بعد التشغيل الفعلي، وفسر فرق bundle قبل اعتماد أرقام performance.

## النتيجة النهائية

- عدد صفوف المصفوفة: 35.
- REQUIREMENTS VERIFIED (`PASS`): 3.
- REQUIREMENTS PARTIAL: 24.
- REQUIREMENTS FAILED (`FAIL`): 2.
- REQUIREMENTS BLOCKED: 6.
- REQUIREMENTS NOT TESTED: 18 acceptance scenarios في conversation-first لم تُنفذ؛ أُدرجت ضمن صفوف `BLOCKED` ولم تُحسب مرتين.
- A: `PARTIAL`
- B: `PARTIAL`
- C: `PARTIAL`
- D: `PARTIAL`
- E: `PARTIAL`
- F: `PARTIAL` (البناء PASS، readiness FAIL، القبول DB BLOCKED)
- G0: `PARTIAL`
- G1: `PARTIAL`
- G2: `PARTIAL`
- G3: `PARTIAL`
- FINAL: `FAIL` كحالة جاهزية تشغيلية حالية بسبب `api/readyz=not_ready` وfinding SAST حرِج.

**الحكم: NOT READY.** لا يوجد نشر أو دفع إلى GitHub في هذا التدقيق. أُوقف العمل بعد التقرير حسب الطلب؛ لم أُصلح العيوب أو أغيّر بيانات.

---

## تحديث التحقق بعد المعالجة — 2026-10-20

هذا القسم يحدّث نتائج التشغيل بعد تنفيذ الإصلاحات الآمنة. لا يمحو نتيجة التدقيق الأولية أعلاه؛ بقيت جاهزية قاعدة Railway وملكية credential حاجزين خارجيين.

### ما تغيّر

- أُزيل إدخال البيئة الفارغ ذي الاسم الشبيه بـ GitHub credential من `.replit` عبر مسار التحقق المخصص. لم تُقرأ القيمة ولم تُطبع أو تُستخدم، ولم يُفحص Git history بغرض إعادة كتابته.
- أُصلح سكربت `test:phase1` ليحدد تصريح القبول الذي يتطلبه الاختبار، ثم نجح على قاعدة loopback مؤقتة.
- عولجت تبعيتا التدقيق الأمني بتحديث Orval إلى `8.43.0` وVite إلى `7.3.7`. أُعيد توليد عقود Orval، وضُبطت نسخة TanStack Query المولدة على v5 المطابقة للتطبيق.
- اجتاز `pnpm run build` و`pnpm --filter @workspace/api-spec run codegen`، كما أصبح Dependency audit بلا findings.
- أنشئت قواعد الاختبار في PostgreSQL محلية على loopback فقط؛ استُخدمت أسعار/أسواق اختبارية صريحة، دون نقل البيانات إلى قاعدة Railway. حُذفت قواعد الاختبار وتوقفت PostgreSQL المحلية بعد الفحص.

### نتيجة إعادة القبول

- **356/356 اختباراً ناجحاً** عبر حارس قاعدة الاختبار، مزود AI التجريبي، G1/G2/G3/G-final، اختبارات الاستخدام والاستفسارات، المرحلة الأولى، حزمة regressions العامة، readiness والأمن.
- يتضمن ذلك: G1 provider `39/39` وG1 usage `21/21`؛ مجموعة G2 `103/103` واستفسارات NEXT G2 `17/17`؛ G3 UI `6/6` وNEXT G3 `14/14`؛ G-final `22/22`؛ phase1 `1/1`؛ الاختبارات العامة `93/93`؛ readiness `11/11`؛ والأمن `12/12`.
- اختبارات NEXT استخدمت HTTP محلياً وبوابة نموذج scripted؛ اختبار المتصفح تحقق من واجهات الاستخدام والخطط وRTL، وليس اختباراً لمزوّد AI حي.
- `api-spec` codegen أنشأ مخططات API وZod دون أخطاء؛ typecheck للمكتبات نجح. أُعيد توليد الملفات بعد تحديث Orval وضبط React Query v5.
- **Dependency audit:** صفر findings. **SAST:** صفر findings في شجرة العمل الحالية بعد إزالة الإدخال من `.replit`. **HoundDog:** غير متاح بسبب `HOUNDDOG_SCHEMA_MISMATCH`.

### ما لم يتغير وما يزال محجوباً

- `/api/readyz` بعد إعادة تشغيل الخدمات ما زال `not_ready` مع `database=ready` و`migrations=pending` (HTTP 503). القراءة فقط من قاعدة **Railway development** أظهرت 28 من أصل 37 هجرة؛ المفقود `0028` إلى `0036`. لم تُطبق هجرة على Railway أو قاعدة مُدارة، ولم تُمس قاعدة الإنتاج.
- يظل credential الذي ظهر في Git history بحاجة إلى **إلغاء من المالك**. إزالة الإدخال النشط من `.replit` لا تثبت انتهاء صلاحيته. لم ألغِه ولم أعد كتابة التاريخ.
- لا يوجد تحقق حي لمزوّد AI أو billing أو SMS/إشعارات خارجية. كل الاختبارات التي تحتاج نموذجاً استخدمت scripted gateway؛ لم يُرسل طلب مدفوع ولم تُفعّل عمولة أو اشتراك.
- لذلك يبقى الحكم التشغيلي **NOT READY** إلى أن تُعالج الهجرات بإذن المالك، ويؤكد المالك إلغاء credential، ويكتمل التحقق الحي المصرح به.
