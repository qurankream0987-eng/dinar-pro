# DINAR — جاهزية تقييم DeepSeek الحي

**الحالة:** `PARTIAL_LIVE_TEST` · `BALANCE_VERIFIED` · `ISOLATION_VERIFIED` · `4_CALLS_CONSUMED` · `PRODUCTION_PROVIDER_UNCHANGED`

## الخلاصة

أُضيف DeepSeek إلى benchmark الحالي فقط، باستخدام بوابة DINAR المشتركة و`interpretWithModel` وأداة `dinarConversationTurn` والتحقق القائم بـZod. لم يُنشأ runtime أو prompt مستقل. بعد موافقة صريحة على التنفيذ، أُجريت أربع مكالمات بالضبط؛ لم تُنتج أي منها turn صالحاً لعقد DINAR. لم يتغير مزوّد الإنتاج. التفاصيل في [تقرير النتيجة الحية](DINAR_FIRST_REAL_DEEPSEEK_INTELLIGENCE_RESULT.md).

## المستودع والتنفيذ

- HEAD قبل التعديل: `e29bb3accba85d8e1746e8de159134933129d0ac`.
- إضافة مقيدة إلى `DEEPSEEK` في benchmark: endpoint ثابت `https://api.deepseek.com`، المفتاح `DINAR_BENCH_DEEPSEEK_API_KEY`، والنموذج الوحيد `deepseek-flash`.
- لا يُسمح لـDeepSeek إلا في بيئة development مع علامة benchmark، خارج Replit deployment وRailway، وبلا fallback. عملية benchmark المعزولة وحدها تستلم المفتاح المخصص؛ اختبارات `plan` و`simulate` والاختبارات المحلية لا تستلمه.
- طلب Chat Completions يستخدم `max_tokens` (لا `max_completion_tokens`)، و`reasoning_effort: high`، و`tool_choice: auto`. لم نرسل `parallel_tool_calls` لأن مخطط API الرسمي لا يوثقه. يُقبل استدعاء DINAR واحد فقط، ولا ينفذ benchmark أدوات تجارية.
- التعامل مع الإلغاء والمهلة وعدد الإعادات واستخدام tokens وأخطاء المزوّد يمر عبر البوابة القائمة. يرفض النموذج أو الإعداد غير المدرج قبل التشغيل.

## اعتماد الحساب والرصيد

تأكد وجود `DINAR_BENCH_DEEPSEEK_API_KEY` من حالة السر المحمية، دون قراءة قيمته. أُرسل طلب واحد `GET /user/balance` إلى نقطة DeepSeek الرسمية؛ نجح التوثيق وكانت النتيجة:

| الحقل | النتيجة |
|---|---:|
| `is_available` | `true` |
| USD — الرصيد الكلي | `$2.00` |
| USD — رصيد المنحة | `$0.00` |
| USD — الرصيد المشحون | `$2.00` |

لم يحدث retry أو استدلال. تحقّق طلب مستقل واحد من `GET /models`؛ ظهر `deepseek-flash` باسم `DeepSeek-V4.1-Flash`، بنافذة 1,048,576 token وسقف إخراج 393,216 token.

## السعر وحدّ الإنفاق المقترح

صفحة DeepSeek الرسمية للأسعار، المراجعة في 2026-10-24، تعرض أسعار peak لكل مليون token: إدخال cache miss **$0.30**، وإخراج **$1.20**. استخدمت أعلى سعر معلن وتجاهلت خصم cache:

`4 × ((18,000 × $0.30 + 500 × $1.20) / 1,000,000) = $0.024`

الحد المقترح للموافقة هو **$0.03 إجمالاً**، مع سقف 4 طلبات، طلب واحد متزامن، صفر retries، نموذج واحد، و500 token إخراج كحد أقصى. حاجز الكلفة محلي ومحافظ؛ ليس سقف إنفاق من DeepSeek. وجود رصيد مشحون لا يُعد موافقة على صرفه.

## العزل والاختبارات

- قاعدة البيانات في عملية benchmark تُوجّه إلى loopback مغلق قبل تحميل runtime؛ لا وصول إلى Railway أو بيانات التطبيق.
- قائمة البيئة الصريحة تسمح بتمرير السر المخصص فقط إلى subprocess التشغيل الحي؛ لا تمرر أسرار الإنتاج أو الجلسات أو الدفع أو التخزين. أزيلت متغيرات fallback.
- أربع حالات اصطناعية فقط: إجابة عربية عامة، نية بيع باللهجة الشامية، اختيار أداة البحث، واستمرارية مقارنة عرضين مختلقين. لا توجد حسابات أو عروض أو محادثات حقيقية.
- شملت الفحوص: اعتماد النموذج والإعدادات، طلب OpenAI-compatible الملتقط محلياً، حراسة الميزانية والعداد والسقوف والمهلة والإلغاء، عزل السر، غياب قاعدة البيانات، والتحقق من عقد الأداة.
- `test:benchmark-guards`: **20/20 ناجحة**، بلا فشل.
- اختبارات `ai-provider.test.ts`: **16/16 ناجحة** بتشغيل bundle محلي مع قاعدة loopback مغلقة وحاجز يمنع استدعاء النماذج. لم أستخدم مشغّل القبول الاعتيادي لأنه يشترط قاعدة بيانات اختبارية disposable.
- `typecheck` و`build` لخادم API: نجحا.
- المحاكاة المعزولة شغّلت الحالات الأربع: **4/4 PASS** بالردود النصية الاصطناعية للـsimulator فقط، لا DeepSeek. لم يحدث اتصال inference؛ لا تُفسّر المحاكاة كنتيجة ذكاء أو نفقة فعلية.

## موافقة المالك المطلوبة

وافق المالك صراحةً عبر المحادثة على سقف إجمالي قدره **$0.03**، ثم صرّح صراحةً بتنفيذ ما لا يزيد عن أربع مكالمات حقيقية. استُخدم إعداد تشغيل مؤقت خارج المستودع لهذه الموافقة. إعداد المثال `artifacts/api-server/test/deepseek-benchmark.example.json` ما زال غير مخوّل عمداً: معرّف الموافقة واسم المالك placeholders، و`deepseekPaidInferenceAuthorized` يساوي `false`.

استهلك التشغيل حد المكالمات الأربع كاملاً؛ لا تُرسل مكالمات إضافية بموجب هذه الموافقة. لم يحدث نشر أو تبديل لمزوّد الإنتاج أو push إلى GitHub.

## المصادر الرسمية

- https://api-docs.deepseek.com/api/get-user-balance
- https://api-docs.deepseek.com/api/list-models
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/guides/tool_calls
