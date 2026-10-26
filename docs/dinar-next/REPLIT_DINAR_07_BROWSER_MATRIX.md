# DINAR 07 — مصفوفة قبول المتصفح A–J

**HEAD:** `84bd5b56af82bde5c0ff0d2ff14ba2ac1e218805`
**القاعدة:** اختبارات browser/API المنفذة استخدمت التطبيق الحقيقي على DB PostgreSQL 18.6 مؤقتة، لا قاعدة Replit المستمرة. المصفوفة تميز الاختبارات الجزئية عن قبول الرحلة الكاملة.

Command A/E/F browser results and API 63/63 are carried from Command 06 on unchanged application code; they were not rerun in Command 07. Readiness and Command B/C/D were rerun during this command.

| ID | رحلة المستخدم | الاختبار | أول محاولة | النتيجة النهائية | دليل قاعدة البيانات | دليل المتصفح | تغييرات المصدر | القيود |
|---|---|---|---|---|---|---|---|---|
| A | حساب اصطناعي، محادثة عربية، متابعة، reload، صلاحية الجلسة | `command-a-acceptance.test` 22/22؛ Command F يحوي 9 رحلات | 22/22 فشل بعد setup لأن fixtures لم تُفعّل | 22/22 بعد إضافة modules؛ F 3/3 | جلسة معزولة، actors جديدة، server state من F مطابق | F يكتب فعلياً في composer ويعيد تحميل الحالة | لا | ليس اختبار login UI مستقلاً، ولا إثبات كل سجل المحادثة/انتهاء الجلسة عبر browser |
| B | بائع ينشر، مشتري يبحث ويتفاوض ويشتري ويؤكد التسليم | `commerce-journey.test` 8/8 من Wave 1؛ Command F 3/3 | F 2/3 بعد missing promotion flag | F 3/3 مع `BDINAR_PROMOTIONS_ENABLED=true` | الطلب/التسليم/receipt تتحقق في server state؛ التجارة API تثبت المخزون والعمولة | 9 رحلات F تشمل شراءً وتسليماً وإيصالاً | لا | لا جلسة بائع ومشترٍ منفصلة تكمل كل خطوة عبر واجهتين |
| C | تنظيف خدمة، توفر وشروط، طلب عرض وتفاوض | `commerce-journey.test` يشمل نشر/بحث خدمة؛ لا test كامل للعرض | لا suite مخصصة لهذه الرحلة | BLOCKED | لا اتفاق خدمة كامل موثق في هذه الجولة | لا | لا | يلزم اختبار quote-service canonical قبل PASS |
| D | مشتريان يتنافسان على آخر وحدة | اختبار concurrency في رحلة التجارة 8/8، من Wave 1 | لم يُعد في Command 07 | API PASS فقط | عملية واحدة تقبل والبقية 409، بلا oversell بحسب suite السابقة | لا تزامن browser | لا | معيار browser D غير مكتمل |
| E | محاولات BOLA/تعديل خصائص بين حسابات | `security-acceptance.test` 12/12 من Wave 1؛ Command F stranger | لا إعادة مستقلة لكل مورد | API/browser جزئي | رفض actor الغريب مثبت للحالة المختبرة | F يتضمن actor غير مخول | لا | لا دليل لكل offer/order/payment intent/delivery/dispute/contact |
| F | انقطاع بعد إرسال إجراء، reconnect، idempotency وترتيب SSE | Command F journeys وAPI idempotency | لا اختبار قطع شبكة فعلي؛ F أول مرة 1/3 بسبب 503 تهيئة ترويج | F 3/3 بعد علم الترويج | server state يطابق العرض؛ لا تنفيذ مكرر مثبت فقط للحالات المغطاة | reload و9 رحلات، لا fault injection لشبكة المتصفح | لا | ترتيب terminal events وout-of-order لم يُثبت |
| G | الدفع المزيف عبر chat/browser/request/intents | `commerce-journey.test` 8/8 من Wave 1 | لم يُعد هنا | API tests سابقة PASS | التوقيع/المبلغ المزيف يُرفضان في اختبار محاكاة | لا | لا | لا اختبار جميع متجهات العبث في المتصفح؛ لا دفع حقيقي |
| H | تغيير السعر/الكمية مع حفظ snapshot اتفاق سابق | لم يوجد اختبار مخصص في هذه الجولة | غير منفذ | BLOCKED | لا دليل جديد | لا | لا | يجب اختبار الاتفاق المؤكد ضد listing edit مع بائع آخر |
| I | سوق خامل، بلا نتائج، التخزين/AI غير متاح، جلسة/عرض منتهٍ | `readiness.test` 15/15؛ Command D 6/6 لحالات empty/unavailable | كلتا suite نجحت من أول تشغيل | API PASS جزئي | الجاهزية fail-closed وempty/unavailable مثبتة في الحالات المحددة | لا رحلة شاملة لحالات الفشل | لا | storage/AI timeout/payment failure ليست رحلة واحدة متحققة |
| J | عربية عامة/بائع/مشتري، تصحيح إحالات، بحث ومتابعة | Command A 22/22، Block A/E سابقاً، F تسع رحلات | Command A فشل 22/22 بسبب fixtures لا بسبب المنتج | suites نجحت بعد إعدادها؛ DeepSeek الحي غير مصرح | سياق اختبارات API حقيقي محلي | F يثبت إدخال composer لبعض الحوارات | لا | عبارات التصحيح/الضمائر والبحث كاملة لم تُختبر عبر browser؛ لا جودة حية |

## تحقق المقاسات والموثوقية

- Command E: `320,375,390,430,768,1024,1440,1600`، الوضعان الفاتح والداكن، 96 قياساً؛ `overflow=[]`, `unnamedControls=[]`, `smallTapTargets=[]`, `composerHidden=[]`, `consoleErrors=[]`.
- تفاعلات موثقة: فتح/إغلاق drawer بـEscape عند 390، وصول composer للتركيز، زر العودة لآخر رسالة والرسالة الأخيرة مرئيان في 390 و1440.
- Command F في أول محاولة: 2/3؛ console `GET /api/promotion-products` 503. إعادة التشغيل مع علم الترويج: 3/3، 9 journeys، `consoleErrors=[]`. سجّل المحاولتين منفصلتين.
- Command A إعداد أول: 22/22 فشل بسبب `ACCEPTANCE_FIXTURES none`; بعد ضبط modules: 22/22.
- DS-15 لم يُعد ضمن Command 07؛ شرط 10 نجاحات مستقلة من أول محاولة غير مستوفى.
- لقطات Command E وF وملفات browser profile أُنشئت داخل مجلد أدلة مؤقت أزيل عند teardown؛ المقاييس أعلاه من سجل التشغيل، لا ملفات صور دائمة.
- لكل اختبار متصفح كان منفذ التطبيق محلياً ومؤقتاً؛ لم يحتفظ harness بقيمة المنفذ أو `baseURL` أو screenshots بعد teardown. لا تُستخدم هذه الجولات كإثبات signed-in على Preview.

## ما يلزم لإعلان PASS

إنشاء journeys مستقلة A–J على test accounts متزامنة من الواجهة الفعلية، خصوصاً C/D/E/F/G/H/I؛ حفظ traces وأدلة server-state مع معرفات run غير سرية. لا ترفع status من API PASS إلى browser PASS.
