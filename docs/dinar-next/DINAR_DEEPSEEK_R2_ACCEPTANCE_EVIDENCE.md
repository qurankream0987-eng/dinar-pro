# DINAR — أدلة قبول DeepSeek R2 وإغلاقه الهندسي

**التاريخ:** 2026-10-25 · **معرّف موافقة R2:** `DINAR-DEEPSEEK-R2-2026-10-24` · **النموذج:** `deepseek-flash`

هذا الملف يكمّل `DINAR_DEEPSEEK_R2_REAL_INTELLIGENCE_RESULT.md` ولا يستبدله. أدلة R1 وR2 الأصلية محفوظة دون تعديل.

## 0. القرار الحاكم: R2 نُفّذ سابقاً، فلم يُرسل أي طلب جديد

أمر الإغلاق يطلب التوقف قبل أي استدلال حي إذا وُجد دليل على أن R2 نُفّذ. الدليل موجود وقاطع:

- الالتزام `3189156` («Run DeepSeek R2 live benchmark (3/4 valid)…») أب مباشر لـHEAD.
- التقرير يسجل **4 طلبات من 4**، مع معرّفات طلبات المزود الأربعة.
- الردود الحقيقية محفوظة في `artifacts/api-server/test/fixtures/deepseek-r2-live-responses.json`، موسومة `RECORDED_LIVE_PROVIDER`.

لذلك **لم يُرسل في هذه الجلسة أي طلب استدلال**، ولا أي طلب `GET /models` أو `GET /user/balance`، ولم يُقرأ مفتاح `DINAR_BENCH_DEEPSEEK_API_KEY`. لم يُعد التحقق من الأسعار الرسمية اليوم لأنه لا إنفاق جديد. الأسعار المعتمدة هي المسجلة في تقرير R2 بتاريخ 2026-10-24.

## 1. Git

| البند | القيمة |
|---|---|
| HEAD الأولي | `3189156577e22e8618fc3a08873e2a91f640aec4` على `main` |
| حالة الشجرة الأولية | ملف مولّد واحد معدّل قبل الجلسة: `artifacts/mockup-sandbox/src/.generated/mockup-components.ts`. لا علاقة له بالمهمة، فتُرك دون التزام |
| أسلاف متحقق منها (`git merge-base --is-ancestor`) | `a507de9`، `d22bfc2`، `7aa8579`، `8400e89`، `3189156` |
| HEAD النهائي | الالتزام المحلي الذي يضيف هذا الملف، وأبوه `3189156`. لا push |

## 2. خريطة المصدر والسلوك (الأجزاء الحرجة)

| الدالة / الصنف | الملف | الغرض | الاختبار المثبت |
|---|---|---|---|
| `interpretWithModel`، `MODEL_TOOL` | `artifacts/api-server/src/ai/model-turn.ts` | الـturn القانوني وعقد أداة `dinarConversationTurn` (Zod + JSON schema) | `ai-provider.test` (تكافؤ المخطط مع Zod، وإعادة تشغيل ردود R2) |
| بوابة النموذج، `AIProviderError` | `artifacts/api-server/src/ai/model-gateway.ts` | النقل، والوضع غير التفكيري، و`finish_reason`، وتصنيف الأخطاء | `ai-provider.test` |
| `GuardedBenchmarkGateway`، `BenchmarkLedger` | `artifacts/api-server/test/live-model-benchmark-core.ts` | سقف الطلبات، وحجز أسوأ تكلفة قبل الإرسال، ومنع fallback | `live-model-benchmark.test` |
| **`CONSUMED_APPROVAL_IDS`، `assertApprovalUnused`** (جديد) | نفس الملف | رفض أي تشغيل حي بموافقة مستهلكة | `live-model-benchmark.test` + رفض فعلي عبر CLI (§4) |
| **`DurableRunJournal`** (جديد) | نفس الملف | دفتر دائم لكل موافقة خارج المستودع | `live-model-benchmark.test` |
| `run-benchmark.mjs` | `artifacts/api-server/test/` | تشغيل الابن ببيئة فارغة وقائمة متغيرات صريحة، وقاعدة بيانات ميتة | `live-model-benchmark.test` |
| مسار المحادثة + SSE + الواجهة | `deepseek-chat-compatibility.test.ts`، `deepseek-stream-render.test.tsx` | القبول الشامل بإعادة تشغيل ردود مسجلة | `test:deepseek-chat`، `test:deepseek-stream` |

## 3. العيب المكتشف في هذه الجلسة وإصلاحه

**العيب:** كان دفتر ميزانية benchmark (`BenchmarkLedger`) في الذاكرة فقط، وهذا يخالف القسم 5 من التفويض. لم يكن في الكود ما يمنع إعادة تشغيل R2 بالموافقة نفسها، فالحاجز الوحيد كان متغيري `DINAR_BENCHMARK_EXECUTE` و`DINAR_BENCHMARK_APPROVAL_ID`. وإذا انهارت العملية ضاعت حالة المحاولات، ولم يوجد قفل يمنع تشغيلين متزامنين.

**الإصلاح:** في كود benchmark فقط، دون مساس بالإنتاج أو بالسوق أو بالمخطط:

1. **`CONSUMED_APPROVAL_IDS`:** قائمة ملتزمة في git تضم `DINAR-DEEPSEEK-R2-2026-10-24`. وضع `run` يرفضها قبل فحص المفاتيح وقبل أي اتصال شبكي. معرّف موافقة R1 غير مسجل في المستندات، فلم يُضف ولم يُخترع.
2. **`DurableRunJournal`** (يتطلبه `DINAR_BENCHMARK_LEDGER_DIR` في وضع `run`، خارج المستودع):
   - يُنشأ ملف `<approvalId>.ledger.jsonl` حصرياً (`wx`، صلاحية 0600)، فيُرفض أي تشغيل ثانٍ بالموافقة نفسها، متزامناً كان أو بعد إعادة تشغيل.
   - كل محاولة تُكتب `RESERVED` مع `fsync` **قبل** الإرسال، ثم `SETTLED` بالاستخدام والتكلفة ومعرّف المزود.
   - المحاولة التي لها `RESERVED` دون `SETTLED` تُعد غامضة وتُحتسب مرسلة.
   - أرقام المحاولات تسلسلية على مستوى التشغيل كله.
   - لا يحتوي الملف أسراراً ولا ترويسات.

## 4. أدلة العزل والرفض (سلبية)

| الفحص | النتيجة |
|---|---|
| CLI: `run` بموافقة R2 مع `EXECUTE=1` وبلا مفتاح | **مرفوض**، exit 1: `Approval DINAR-DEEPSEEK-R2-2026-10-24 was already used by a live run` قبل أي شبكة |
| فتح دفتر داخل المستودع | مرفوض |
| معرّف موافقة يحوي `../` | مرفوض |
| فتح دفتر ثانٍ للموافقة نفسها | مرفوض (`already exists`) |
| المحاولة مكتوبة على القرص قبل الإرسال | مثبت داخل الـfake gateway نفسه |
| محاولة معلّقة بلا تسوية | تُحتسب: `attempts=2`، `ambiguous=[2]` |
| مفتاح DeepSeek في الـdiff | 0 ظهور |

## 5. الاختبارات الحتمية (لا استدلال حي)

جرى التشغيل على قاعدة PostgreSQL 16 مؤقتة جديدة (`dinar_test_deepseek_r2_closure`) على `127.0.0.1:55441` داخل scratchpad:

- migrations طُبقت عليها وحدها.
- بذور اصطناعية: `MARKET_FIXTURES`، `USER_FIXTURES`، `PRODUCT_LISTINGS`، `PHASE1_LISTINGS`.
- `env -i` بقائمة صريحة، و`SESSION_SECRET` وكلمة مرور البذور عشوائيتان مؤقتتان.
- حُذفت القاعدة وأُوقف الخادم بعد الانتهاء.

| الأمر | النتيجة |
|---|---:|
| `pnpm run typecheck` (api-server) | ناجح |
| `test:benchmark-guards` | **22/22** (21 سابقة + اختبار الدفتر الدائم) |
| `run-benchmark.mjs ai-provider.test` (بلا قاعدة بيانات) | **23/23** |
| `test:ai-provider` (قاعدة مؤقتة) | **23/23** |
| `gemini-gateway.test` | **3/3** |
| `test:secrets` | **1/1** |
| `test:deepseek-chat` مع Chromium (`BDINAR_DEEPSEEK_BROWSER=1`) | **11/11**، صفر تخطٍ، DS-00…DS-08 تتضمن DS-08 (إعادة تشغيل ردود R2 الحقيقية)، `blockedHosts=[]`، `pageErrors=0` |
| `test:deepseek-stream` (الواجهة) | **7/7** |
| بناء API / بناء الواجهة | ناجح / ناجح |

**تنبيه:** كل اختبارات المسار القانوني هنا **إعادة تشغيل لردود مسجلة** أو mocks، وليست استدلالاً حياً.

## 6. ما يبقى غير مثبت

- إصلاح حدود مخطط الأداة (`intent ≤ 60`) لم يُثبت مع المزود الحي.
- اختيار `CREATE_LISTING_DRAFT` لحالة البيع لم يُثبت حياً.
- هامش الإخراج: الحالة 4 استهلكت 1,181 من 1,200 token.
- دورة الأداة الكاملة (اقتراح ثم تنفيذ ثم رد ثانٍ) لم تُختبر حياً.
- Preview: migrations `0028–0039` غير مطبقة. لم يُلمس Railway.
- أربع حالات اختبار دخان هندسي، وليست تقييماً إحصائياً. **لا شهادة جاهزية للإنتاج.**

## 7. الموافقات المطلوبة لاحقاً

1. **R3** (اختياري): موافقة جديدة بمعرّف جديد لإثبات إصلاح المخطط وحالة البيع حياً. سيُطلب `DINAR_BENCHMARK_LEDGER_DIR` دائم.
2. تطبيق migrations المعلقة على Preview بواسطة مالك البيئة.
3. سر محادثة منفصل `DINAR_DEEPSEEK_API_KEY`، مع سعر وسياسة إنفاق في بيئة التطبيق.
