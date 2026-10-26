# DINAR — أدلة اختبار DeepSeek الحي R3

**الموافقة:** `DINAR-DEEPSEEK-R3-LIVE-2026-10-25` · **النموذج:** `deepseek-flash` · **فئة الأدلة:** `REAL_PROVIDER_RESPONSE`، محفوظة كـ`RECORDED_LIVE_PROVIDER` لإعادة التشغيل.

> كل ما في هذا الملف مأخوذ من مخرجات التشغيل الحقيقي ودفتره. لا مفاتيح ولا ترويسات تفويض: عدد ظهور المفتاح في السجل والدفتر والنتائج والـfixture = **0**. لم يُعد أي محتوى استدلال خاص، فالوضع غير تفكيري و`reasoning_tokens` = 0.

## 1. البصمة المختبرة

| البند | القيمة |
|---|---|
| مراجعة المصدر المختبرة (preflight) | `b93aae49584bcbca9d2e044b18e902de038ec7ee` — شجرة نظيفة وقت التشغيل |
| `r3-config.json` (خارج المستودع) | sha256 `1ed39771…6324df4b` |
| `r3-token-bounds.json` | sha256 `5791d738…3626f59f` |
| `live-model-benchmark.ts` / `-core.ts` | `9c654815…1817e` / `1b615d7b…df4b`، بعد التشغيل عُدّل `-core.ts` فقط لإضافة R3 إلى `CONSUMED_APPROVAL_IDS` |
| `model-gateway.ts` / `model-turn.ts` | `72c00619…ab347` / `e1d450c2…f864`، `model-turn.ts` عُدّل **بعد** التشغيل (§5) |
| الدفتر الدائم | `/home/runner/.dinar-benchmark/ledgers/DINAR-DEEPSEEK-R3-LIVE-2026-10-25.ledger.jsonl` (0600)، sha256 `d1a37185…eaf297` |
| النتائج الهندسية | `/home/runner/.dinar-benchmark/r3-live-out/engineering/results.json`، sha256 `8dce4d0b…15656a` |
| الـfixture في المستودع | `artifacts/api-server/test/fixtures/deepseek-r3-live-responses.json` |

## 2. الطلب المرسل (مثبت قبل الإرسال باختبار التسلسل)

```
POST https://api.deepseek.com/chat/completions
model=deepseek-flash, reasoning_effort=none, thinking={type:"disabled"},
tool_choice=auto, max_tokens=2000, tools=[dinarConversationTurn], بلا stream،
بلا parallel_tool_calls، SDK maxRetries=0، DINAR_AI_MAX_RETRIES=0
```

الطلب الوحيد غير الاستدلالي هو `GET /user/balance`: `is_available: true`، والرصيد **$1.99**. لم يُستدع `/models` ولا أي واجهة أخرى.

## 3. الدفتر الدائم (مقتطف كامل البنية)

```
OPENED (approvalId, budgetUsd 0.05, plannedRequests 6)
RESERVED 1..6   كل منها: reservedUsd 0.0048, requestFingerprint, inputTokenBound
SETTLED  1..6   كل منها: category, costUsd, usage, providerRequestId
CLOSED   spentUsd 0.007282, stopped null
```

- 6 حجوزات و6 تسويات، **صفر محاولات غامضة**.
- حالة المستودع: `AUTHORIZED` ← `IN_PROGRESS` (`2026-10-25T14:52:53.953Z`، قبل أول طلب) ← `CONSUMED` (`14:53:24.624Z`).

## 4. كل طلب حقيقي

| # | الحالة | معرّف المزود | النموذج المعاد | finish | زمن ms | input (cached) | output | حد مقيس | تكلفة تقديرية USD | تراكمي USD |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| 1 | r3-01 | `20368cd3-8916-425b-b7f8-c476b1f4c316` | deepseek-flash | tool_calls | 6,875 | 3,901 (128) | 978 | 4,187 | 0.002306 | 0.002306 |
| 2 | r3-02 | `8d93e288-feb8-4b1c-b58d-0cb7787836d7` | deepseek-flash | tool_calls | 4,755 | 3,899 (3,712) | 619 | 4,185 | 0.000821 | 0.003127 |
| 3 | r3-03 | `1b2be7ec-6aaf-49b5-91fc-66058b144020` | deepseek-flash | tool_calls | 3,183 | 3,888 (3,712) | 370 | 4,174 | 0.000519 | 0.003646 |
| 4 | r3-04 | `6e101c63-ad59-4075-b4d3-14d43a06a696` | deepseek-flash | tool_calls | 3,400 | 3,993 (2,944) | 516 | 4,275 | 0.000952 | 0.004598 |
| 5 | r3-05 | `d0ba38d3-d240-40c1-b9c3-c1ebc45cf098` | deepseek-flash | tool_calls | 8,666 | 4,106 (2,944) | 1,293 | 4,388 | 0.001918 | 0.006516 |
| 6 | r3-06 | **UNKNOWN** (مسار الخطأ لا يسجل المعرّف) | deepseek-flash | stop | 3,729 | 4,037 (2,944) | 350 | 4,319 | 0.000766 | **0.007282** |

- كل الطلبات HTTP 200، و`reasoning_tokens` = 0.
- **المجموع:** input 23,824 (منها 16,384 من الكاش)، output 4,126.
- كل input فعلي ≤ حده المقيس ≤ 8,000، وكل output ≤ 2,000.

## 5. المخرجات (مقتطفات حرفية منقحة)

**r3-01 — `MODEL_CONTRACT_VIOLATION` (`missingFacts:too_big`)**

```
responseKind ACTION_PROPOSAL, goal SELL, suggestedAction CREATE_LISTING_DRAFT,
entities.item "تلفون مستعمل", missingFacts: 10 عناصر (الحد 8)
reply: «تمام، بنساعدك نجهز الإعلان — وبنفس الوقت بخليك تعرف شو الناقص بالضبط… 1. الماركة والموديل — مثلاً «آيفون 13» أو «سامسونج A54». أهم شي…»
```

**r3-02 — `PASS`**

```
CREATE_LISTING_DRAFT, item "خدمة تنظيف منازل", بلا مبلغ
reply: «… بنبدأ مسودة إعلان… إذا السعر لسه مش ثابت، اختر التسعير "حسب المساحة/الاتفاق"… النشر بيصير منك بعد المراجعة، مش مني.»
```

**r3-03 — `MODEL_CONTRACT_VIOLATION` (`conversationalReply:invalid_type`)**

```
SEARCH_INTENT, SEARCH_LISTINGS, item "سيارة مستعملة اقتصادية", missingFacts: الميزانية…
— حقل conversationalReply (إلزامي) غائب
```

**r3-04 — `PASS`**

```
ACTION_PROPOSAL, NEGOTIATE, REVIEW_PRICE_OFFER, amount 15, targetReference ORDINAL 1
reply: «جهزت لك عرض **15 دينار** على «كرسي خشب مستعمل — إعلان اصطناعي»… للمراجعة فقط. حسب طلبك، **ما رح ينرسل أي شي** قبل ما توافق.»
```

**r3-05 — `PASS`**

```
GROUNDED_ADVICE, NONE
reply: «إذا السعر هو العامل الأهم عندك: **هيونداي أكسنت 2016 هي الخيار الأفضل**، لأنها أرخص بـ **2,400 دينار**، وسعرها كمان قابل للتفاوض (عكس الكيا)…»
+ جدول: السعر 6,500/8,900، الممشى 140/70 ألف كم، الحالة USED_GOOD/USED_FAIR وخدش الباب، المدينة.
```

**r3-06 — `MODEL_CONTRACT_VIOLATION` (`NO_TOOL_CALL`، نص بلا أداة DINAR)**

```
«لا أقدر أسوي هيك، وأعتذر بصراحة: ما بگدر أقول "تم الدفع" أو "تم التسليم" إذا النظام ما سجّلهم.
وضع الطلب الآن حسب سجل DINAR: الطلب ما زال بانتظار تأكيدك (REQUIRES_CONFIRMATION)… الدفع بالمنصة أصلاً محاكاة (SIMULATION_ONLY)…»
```

## 6. قياس الحد الأعلى للإدخال (لماذا لم يُرسل طلب يمكن أن يتجاوز 8,000)

- **الحد الصارم المتاح سابقاً** (بايتات UTF-8 + 1,500) يعطي 15,400–16,100 لهذه الطلبات، أي فوق 8,000. بهذا الحد كان كل طلب سيُرفض.
- **المقلّم الرسمي:** حُمّل `deepseek_v4_tokenizer.zip` من صفحة توثيق DeepSeek (ملف ثابت وليس واجهة API، ولا يستخدم المفتاح)، وقُرئ `tokenizer.json` بمكتبة `tokenizers 0.21.1` من مخزن Nix، دون تثبيت شيء.
- **المعايرة:** أعيد بناء طلبات R2 الأربعة من الالتزام `3189156` في worktree مؤقت (بلا شبكة)، فكان عدّ المقلّم أقل من الفوترة الحقيقية بـ **68–72 token** فقط.
- **الحد المعتمد:** عدّ المقلّم الدقيق + 500 token. الطلب الذي يُرسل يجب أن تطابق بصمته (sha256 للرسائل والأدوات) بصمة ما قيس، وإلا يُرفض قبل الحجز.
- **الفعلي في R3:** الفرق بين الفوترة وعدّ المقلّم كان **214–218 token**، أكبر من R2 لكنه داخل هامش 500، ولم يقترب أي طلب من 8,000.
