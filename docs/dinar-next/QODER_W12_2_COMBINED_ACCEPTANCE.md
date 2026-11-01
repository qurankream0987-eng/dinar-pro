# DINAR NEXT — W12.2: القبول المُجمَّع (Combined Acceptance)

**الفرع:** `qoder/17-unified-integration-candidate`
**الـ SHA المُختبَر للبطارية (§2 أ–و):** `d593b0d95f6fde641d5d288bcd070d226541f109` — كل تشغيل في تلك الجداول HEADُه هذا الـ SHA (تحقّق بـ `head_sha` في API).
**الـ SHA المُختبَر للسلاسل المجمَّعة (§2 ز):** `d572484` — ما فوق `d593b0d` هنا ليس وثائق فقط: مشغّل العزل `test/isolation/local-suite.sh` وملف الـ workflow `qoder-api-suite.yml` تغيّرا (سلاسل متعددة المجموعات + إعادة تعيين عدّاد الإبطاء)، لذلك أُعيد تشغيل كل سلسلة على النهائي؛ لا تدّعي أي خلية في §2 ز أنها عُملت على `d593b0d`.
**المنفِّذ:** GitHub Actions على `qurankream0987-eng/dinar-pro` — لا بناء ولا اختبار ثقيل على جهاز المالك
**التاريخ:** 2026-11-01
**الإصداران:** PostgreSQL 16.15 و18.6 + Chromium حقيقي (Playwright) داخل CI

> **قاعدة الصدق:** كل سطر أدناه رقم تشغيل فعلي (run id) يمكن فتحه على `github.com/qurankream0987-eng/dinar-pro/actions/runs/<id>`. أرقام الاختبارات منسدلة من سجلات التشغيل نفسها (`LOCAL_SUITE suite=… exit=0` و`ℹ pass / ℹ fail`). لم يُشغَّل شيء على قاعدة إنتاجية، ولم تُستخدَم مفاتيح مزوّد حقيقية، ولم يُفعَّل سوق أو إرسال واتساب أو دفع حي. **هذه وثيقة قبول مرشّح تكامل، ليست شهادة جاهزية إطلاق.**

---

## 1 — الحصيلة

| المقياس | القيمة |
|---|---|
| تشغيلات على `d593b0d` | **43** (42 × `qoder-api-suite` + 1 × `qoder-security`) |
| ناجحة | **43 / 43** |
| فاشلة | 0 |
| مجموعات على PG18 | 6 (`wave10`، `d1-d2-business-foundation`، `w02u3-card-reliability`، `phase1-acceptance`، `search-sql-foundation`، `search-sql-performance`) + مشغّل الهجرة النشرى legs PG18 |
| رحلات Chromium على الـ SHA النهائي | **9** (7 × `w02u3-*-browser-journey` + `wave03-card-envelope` + leg المتصفح داخل `phase1-acceptance`) + `d1-d2-business-browser` |
| صافي اتصال خارجي في كل تشغيل | `outbound=0` |
| إعادة تشغيل بعد فشل على الـ SHA النهائي | **0** (كل التشغيلات خضراء من المحاولة الأولى على `d593b0d`) |
| سلاسل مجمَّعة (job واحد وقاعدة واحدة) | **11 تشغيلًا** عبر `8a7eef1` ← `8456dc9` ← `d572484`: **8 خضراء + 2 حمراوان مُعلنتان** (السلسلة التساعية على PG16 وPG18 معًا، قبل إصلاح العزل في §2 ز) + تشغيل **مجموعة واحدة** على `d572484` (41323302207) أُعيد لإثبات أن 429 لم يُلغَ بعد تغيّر المشغّل |
| أكبر سلسلة خضراء | **9 مجموعات = 118 اختبارًا** على disposable واحدة، على PG16.15 **و** PG18.6، بلا أي skip وبلا أي فشل (`LOCAL_SUITE_CHAIN suites=9 … exit=0 first_failed=none`) |

الفشلان الوحيدان في هذا التكامل حدثا على SHA وسيطة `a626509` وعولِجا بإعادة التشغيل بأعلام صحيحة، لا بتليين حكم: `wave3-acceptance` (41264271699 ← كان ينقص `BDINAR_WAVE3_ACCEPTANCE=development`؛ أعيد 41265006455 نجاح) و`w02u3-card-accessibility` (41264318631 ← تعثّر توقيت؛ أعيد 41265008891 نجاح، ثم أخضر على النهائي 41274528668). التفاصيل في N4 وN6 بمصفوفة الأخطار.

**الفشلان الخاصان بالسلاسل ليسا من هذا النوع:** السلسلة التساعية سقطت على `8456dc9` بثلاث مجموعات متتالية عند التسجيل (`429` بدل `201`)، وهو تداخل حقيقي كشفته السلسلة ولم تكشفه أي تشغيل منفرد؛ سببه والمعالجة المُعلَنة بهما في §2 ز. لم يُلطَّف أي حكم اختباري لإخفاء هذا الفشل: لا رفع لحدّ الإبطاء، ولا تغيير نافذته، ولا تعطيل للحارس.

---

## 2 — مصفوفة المجموعات على الـ SHA النهائي

### 2 أ — أساس النشر والهجرة والبنية

| المجموعة | التشغيل | PG | النتيجة |
|---|---|---|---|
| `readiness.test` + legs النشر (مثبّتات الترقية + مشغّل النشر) | 41274370586 | 16 **و** 18 | `JOURNAL_OK entries=47 head=0046_wave10_trust_support_whatsapp` على الركنين؛ readiness **15 pass / 0 fail**؛ surface protocol **31 pass / 0 fail**؛ `test:migrate-upgrade` **4 tests** على PG16 وعلى PG18؛ مشغّل الهجرة النشرى على PG18 **12 tests**؛ كل الأركان `fail 0` |
| `development-tls.test` | 41274373145 | 16 | **7 pass / 0 fail** (47 مدخلًا + إعادة حساب hash كل ملف من blob) |
| `search-sql-foundation.test` | 41274480298 / 41274482684 | 16 / 18 | **6 pass / 0 fail** على الركنين |
| `search-sql-performance.test` | 41274484870 / 41274487365 | 16 / 18 | **3 pass / 0 fail** على الركنين |
| `financial-state-machine.test` | 41274489831 | 16 | **23 pass / 0 fail** |
| `payment-order-state.test` | 41274492007 | 16 | **3 pass / 0 fail** |
| `r5-delivery-economics.test` | 41274542725 | 16 | **3 pass / 0 fail** |

### 2 ب — الموجات المُدمَجة (W07–W10 + W12.1)

| المجموعة | التشغيل | PG | النتيجة | المفتاح البيئي |
|---|---|---|---|---|
| `wave07-financial-journal.test` | 41274375395 | 16 | **10 pass / 0 fail** | `BDINAR_W07_ACCEPTANCE=development` + `BDINAR_WAVE4_ACCEPTANCE=development` (محاكاة الدفع) |
| `wave08-cash-and-refunds.test` (يشمل حلقة S11) | 41274378117 | 16 | **13 pass / 0 fail** | `BDINAR_W08_ACCEPTANCE=development` + `BDINAR_WAVE4_ACCEPTANCE=development` |
| `wave09-policy-consent-compliance.test` | 41274381068 | 16 | **19 pass / 0 fail** | `BDINAR_W09_ACCEPTANCE=development` |
| `wave10-trust-support-whatsapp.test` | 41274383611 / 41274385878 | 16 / 18 | **24 pass / 0 fail** على الركنين | `BDINAR_W10_ACCEPTANCE=development` |
| `wave07-w12-contract-hardening.test` (W12.1) | 41274388567 | 16 | **6 pass / 0 fail** | `BDINAR_W12C_ACCEPTANCE=development` |

### 2 ج — D1/D2 بما فيها عمل كلود الأحدث (`29c2af9`+`2e985fe`)

| المجموعة | التشغيل | PG | النتيجة |
|---|---|---|---|
| `d1-d2-business-foundation.test` (يشمل `D2-19` لعقود OpenAPI و`:751-757` لفصل الدفع عن التحقق و`businessListingAssociation`) | 41274390635 / 41274393066 | 16 / 18 | **24 pass / 0 fail** على الركنين |
| `d1-d2-business-browser.test` (Chromium) | 41274395438 | 16 | **3 pass / 0 fail** |
| `policy-consent-cards.test` (S9: بطاقات الموافقة) | 41274398656 | 16 | **3 pass / 0 fail** |

### 2 د — W02U-3 وCard Envelope

| المجموعة | التشغيل | PG | النتيجة |
|---|---|---|---|
| `w02u3-card-reliability.test` | 41274431775 / 41274434474 | 16 / 18 | **8 pass / 0 fail** على الركنين |
| `wave02-card-reliability.test` | 41274540190 | 16 | **9 pass / 0 fail** (`BDINAR_WAVE02_ACCEPTANCE=development`) |
| `wave03-card-envelope-browser-journey.test` | 41274533140 | 16 | **1 pass / 0 fail** (Chromium) |

### 2 هـ — المسارات المجمَّعة الطويلة (combined journeys)

| المسار | التشغيل | PG | النتيجة | ما يغطيه في تشغيل واحد على قاعدة disposable واحدة |
|---|---|---|---|---|
| `phase1-acceptance.test` | 41274436798 / 41274439448 | 16 / 18 | **1 test / 0 fail، skipped 0** (ملف 2 111 سطرًا) | تسجيل → موافقة → نشر قائمة → بحث C1 → سلة/طلب → تفاوض أجرة المندوب → رسالة/بلاغ → leg متصفح Chromium حقيقي (سطح `data-surface-size`، photo-condition، سعر-هدف) |
| `security-acceptance.test` | 41274441735 | 16 | **12 pass / 0 fail** | عزل الحساب/السوق، رفض stale، تسرب بين البائعين، صلاحيات الأدمن |
| `wave4-payment-acceptance.test` | 41274499371 | 16 | **1 test / 0 fail** (991 سطرًا) | سلسلة الدفع/الاسترداد الكاملة تحت `BDINAR_WAVE4_ACCEPTANCE=development` (محاكاة حصرية) |
| `wave3-acceptance.test` | 41274535919 | 16 | **11 pass / 0 fail** | الخصوصية والاعتدال عبر المسارات |
| `commerce-journey.test` | 41274454453 | 16 | **8 pass / 0 fail** | دورة تجارة كاملة مع حرس القُصّر وسقف الكمية |
| `sc01` / `sc02` / `sc03` / `sc06` / `sc07` / `sc10` (رحلات سيناريوهات) | 41274444195 / 41274494197 / 41274447094 / 41274496668 / 41274449435 / 41274451820 | 16 | **1 pass / 0 fail** لكل منها | سيناريوهات المحادثة→الإجراء→القائمة→السؤال عن المواصفات/المخزون |

**صدق حول «المسار المجمَّع»:** التكليف طلب مسارات مركَّبة. المسارات أعلاه مركَّبة فعلًا (كلها سلسلة خطوات واحدة داخل عملية واحدة على قاعدة واحدة) — لكنّها لا تربط **مجموعات منفصلة** في job واحد؛ هذا النقص بالذات كان مُعلَنًا كعمل متبقٍ N6، وصار مُنفَّذًا في §2 ز (سلسلة من تسع مجموعات على قاعدة واحدة، PG16 وPG18). لذلك توصيف المسار المجمَّع الآن: **PASS للتسلسلات المُغطَّاه أعلاه + PASS لسلسلة-التسع-مجموعات-في-job-واحد (§2 ز)**.

### 2 و — رحلات Chromium على الـ SHA النهائي (W02U-3 × 7)

| الرحلة | التشغيل | النتيجة | الشرط المُثبَت |
|---|---|---|---|
| `w02u3-card-reliability-browser-journey` | 41274517338 | **1 pass / 0 fail** | البطاقة تُعرض مرة واحدة بلا تكرار/التقاط |
| `w02u3-card-concurrency-browser-journey` | 41274519443 | **1 pass / 0 fail** | دورتان متزامنتان لا تدمّر إحداهما الأخرى |
| `w02u3-card-sessions-browser-journey` | 41274521724 | **1 pass / 0 fail** | عزل الجلسات/المحادثات |
| `w02u3-card-recovery-browser-journey` | 41274524281 | **1 pass / 0 fail** | rehydration بعد إعادة التحميل |
| `w02u3-card-expiry-browser-journey` | 41274526458 | **1 pass / 0 fail** | انتهاء صلاحية البطاقة + رفض stale |
| `w02u3-card-accessibility-browser-journey` | 41274528668 | **1 pass / 0 fail** | RTL على 320px + `aria-busy`/`disabled` أثناء الدورة |
| `w02u3-card-performance-browser-journey` | 41274530872 | **1 pass / 0 fail** | ميزانيات العرض (انظر §4) |

كلها على PostgreSQL 16.15 + Chromium، وكلها `outbound=0`.

### 2 ز — السلاسل المجمَّعة: مجموعات منفصلة عدة في job واحد على قاعدة واحدة (إغلاق N6)

**ما بُني:** `artifacts/api-server/test/isolation/local-suite.sh` صار يقبل قائمة أسماء مجموعات مرتّبة — يهاجر مرة واحدة، ويزرع مرة واحدة، ثم يشغّل كل مجموعة على **نفس القاعدة** التي تركها أخواتها، ويُعلن لكل مجموعة `exit` و`outbound` خاصّين بها، ويواصل بعد الفشل لأن «أي المجموعات اللاحقة ما زالت تنجح على قاعدة مُعدَّلة» هو الدليل المطلوب. أسماء السلاسل وأبواب الموافقة المطلوبة لكل منها معرَّفة في allowlist الـ workflow (`.github/workflows/qoder-api-suite.yml:57` و`:228-244`)، فلا شيء من محتوى السلسلة يأتي من payload الإرسال.

| السلسلة | التشغيل | PG | التسلسل والنتيجة |
|---|---|---|---|
| `integrated-nine-interleaved` | **41320840909** | 16.15 | W07 (10) ← D1/D2 (24) ← W08 (13) ← W02U-3 (8) ← W09 (19) ← C1 search (6) ← W10 (24) ← commerce (8) ← W12.1 (6) = **118 pass / 0 fail / 0 skipped**؛ `LOCAL_SUITE_CHAIN suites=9 db=dinar_test_local_821d1cae58e7 exit=0 first_failed=none`؛ `outbound=0` في التسع |
| `integrated-nine-interleaved` | **41320844383** | **18.6** | نفس التسلسل، نفس الأعداد **118 / 0 / 0**، `first_failed=none`، `outbound=0` |
| `financial-waves-w07-w12c` | **41320848053** | 16.15 | W07 ← W08 ← W09 ← W10 ← W12.1 = **72 pass / 0 fail** على `dinar_test_local_4b5a1a32cc8b` |
| `business-cards-search-commerce` | **41320851743** | 16.15 | D1/D2 ← W02U-3 ← C1 search ← commerce = **46 pass / 0 fail** على `dinar_test_local_80ad8bdb5fe7` |

الأعداد مطابقة تمامًا لأعداد كل مجموعة حين شُغِّلت منفردة (§2 أ–د) — أي أن التجميع لم يُفقّد أي اختبار، ولم يُلغِ أي منه بـ skip.

**أول تشغيلين أخضرين للعائلتين** كانا على `8a7eef1`: 41319273130 (السلسلة المالية — 72 اختبارًا) و41319484936 (سلسلة الأعمال والبطاقات والبحث — 46 اختبارًا). أُعيد تشغيل السلسلتين على `d572484` لأن المشغّل نفسه تغيّر بعدهما (تنظيف حصّة الإبطاء بين المجموعات)، فلا تُنسَب أي خلية في الجدول أعلاه إلى SHA أقدم من الشيفرة التي أنتجتها.

**الفشل الذي كشفته السلسلة (مُعلَن كما هو):** على `8456dc9` سقطت السلسلة التساعية على الركنين معًا — **41319966038** (PG16) و**41319969519** (PG18) — بستّ مجموعات خضراء ثم `wave10-trust-support-whatsapp.test` عند `register()` بـ `AssertionError … actual: 429, expected: 201`، وتلاه `commerce-journey.test` و`wave07-w12-contract-hardening.test` بنفس السبب (`first_failed=wave10-trust-support-whatsapp.test`). لم يظهر هذا في أي تشغيل منفرد عبر 43 تشغيلًا.

- **السبب الجذري:** عدّاد الإبطاء موجود في القاعدة نفسها — جدول `auth_rate_limit_buckets` (`lib/db/src/schema/index.ts:219`) — وحصّة الـ IP تُستهلك في **كل** مسار مصادقة دون استثناء (`artifacts/api-server/src/lib/auth-rate-limiter.ts:93`) بحدّ **20 محاولة / 900 ثانية** (`:8-9`)، بينما حصّة الهوية ثانوية وغير مضمونة (`src/lib/auth.ts:140-175`)، فأرقام الهواتف المختلفة لم تحمِ نفسها من استنفاد حصّة العنوان. وكل مجموعات الاختبار تتصل من `127.0.0.1`. التشغيل المنفرد كان يورث دائمًا حصّة فارغة (قاعدة جديدة)، أما السلسلة فتراكم فيها عدّاد الأخوات: بعد `d1-d2` وحدها أعلَن المشغّل `rows=48` — ثمانٍ وأربعون سلّة متراكمة في قاعدة السلسلة الواحدة، من بينها سلّة `ipv4:127.0.0.1` التي بلغ عدّها حدّها العشرين فسقط التسجيل بـ `429`.
- **المعالجة (في نطاق المشغّل وحده):** `clear_auth_throttle_state()` في `artifacts/api-server/test/isolation/local-suite.sh:83` تنظّف الجدول **بين** مجموعات السلسلة فقط، وتُعلن ذلك في السجل (`:118` `LOCAL_SUITE_THROTTLE_RESET after=… before=… rows=N`)؛ تشغيل مجموعة واحدة لا ينفّذ أي استعلام إضافي. الحارس نفسه لم يُمَسّ: لا رفع للحدّ، ولا تضييق/توسيع للنافذة، ولا تعطيل، ولا تعديل لمسار الإنتاج — والدليل أن 429 ما زال يعمل أن `security-acceptance.test.ts:2335` يخصّ سلّة الـ IP بحكمها الخاص (`afterIpBudget → 429`) مع خمس محاكيات أخرى في `:2107,2237,2375,2429,2465`. أُعيد تشغيل المجموعة الواحدة على `d572484` بعد تغيّر المشغّل — **41323302207**: `pass 12 / fail 0` و`LOCAL_SUITE … exit=0 outbound=0`، وسجلّ الـ run يُظهر `statusCode: 429` فعليًا على `/api/auth/phone-verification/challenges` ثم `/api/auth/login` بعد استنفاد السلّة، أي أن التنظيف بين المجموعات لم يُلغِ الحكم.
- **ما لا تدّعيه هذه السلسلة:** (1) إعادة تعيين حصّة الإبطاء بين المجموعات تعني أن السلسلة **لا** تختبر تراكم الإبطاء عبر الأنظمة — هذا سلوك مُعلَن لبيئة العزل، ولو أُرِيد اختبارُه فله تشغيل مستقل بحصّة واحدة متصلة؛ (2) المجموعات التسع كلها على مستوى API/قاعدة — لا واحدة منها تقود متصفحًا (`commerce-journey.test` لا يشير إلى Playwright في شيفرته)، رغم أن السلسلة تُثبّت Chromium لأن commerce على قائمة المتصفح في الـ workflow (`chromium=1` في `INPUTS_OK` من سجل 41320840909)؛ رحلات Chromium (§2 و) ما زالت تُشغَّل منفردة ولا تُجمَّع؛ (3) زرع واحد لكل السلسلة، فـ«التعايش» المُثبَت هو التعايش على بيانات `fixtures` المُزروعة + كتابات الأخوات، لا على قاعدة إنتاجية مستنسخة.

---

## 3 — الأدلة البنيوية (ليست أرقام تشغيل فقط)

| المطلوب في §02/§03 | كيف أُثبِت | المصدر |
|---|---|---|
| جداول + FK + فهارس + محفِّزات + قيود unique | `wave07/08/09/10` تُنشئ وتفحص فعليًا على قاعدة نظيفة (`pg_indexes`, `pg_trigger`, `pg_constraint`) | 41274375395 / 41274378117 / 41274381068 / 41274383611+41274385878 |
| جداول أحداث append-only | `support_case_events`، `moderation_audit`، `business_verification_events`، `order_financial_events` — لا UPDATE/DELETE في المسارات المُدمَجة (كاتب واحد لكل دفتر) | مصفوفة الإغلاق §هـ؛ `src/lib/order-journal.ts:89`، `src/lib/commercial-ledger.ts:126`، `src/lib/order-terminal-accounting.ts:82` |
| idempotency | مفاتيح idempotency في `cash` و`consent` + `whatsapp_intents_never_sent` | `wave08`/`wave09`/`wave10` أعلاه |
| search indexes + C1 غير منقوض | `search-sql-foundation` (خطة الفهرس، `pg_trgm`، استرجاع محدود) على الركنين | 41274480298 / 41274482684 |
| سلامة مالية | `financial-state-machine` (23) + `payment-order-state` (3) + `wave07` (10) + حلقة S11 في `wave08` (13) | أعلاه |
| ترقية بيانات قائمة (لا قواعد نظيفة فقط) | مثبّتات عند 0 / 28 / 42 بآلة Drizzle على PG16 **و** PG18 + مشغّل النشر PG18 (12 اختبارًا) بما فيه `0042 → 0046` على بيانات موجودة | legs داخل 41274370586 |

---

## 4 — القبول الأداءي (C1 لم يُنقَض)

`search-sql-performance.test` يقيس في نفس القاعدة ونفس التشغيل المسار canonical (SQL) مقابل المسار القديم (legacy) — أي «قبل/بعد» حقيقي لا مقارنة بين تشغيلين:

| المقياس | PG16 (41274484870) | PG18 (41274487365) |
|---|---|---|
| `narrowText` على 1 000 — SQL | p50 **2.8 ms** / p95 4.8 (صفوف مقروءة **0**) | p50 **3.3 ms** / p95 5.8 (0 صفوف) |
| `narrowText` على 1 000 — legacy | p50 23.1 ms / p95 27.1 (1 006 صفوف) | p50 ≈ 13.1–15.6 ms (1 006 صفوف) |
| `narrowText` على 10 000 — SQL | p50 **7.5 ms** / p95 8.0 (2 صفوف) | p50 **10.1 ms** / p95 12.7 (2 صفوف) |
| `narrowText` على 10 000 — legacy | p50 145.7 ms / p95 171.2 (**10 006 صفوف**) | p50 ≈ 148.7–159.0 ms (10 006 صفوف) |
| `broadText` — SQL | p50 9.8 ms (1 000) و21.5 ms (10 000)، 139–150 صفًا | p50 12.9 ms و24.4 ms، 139–150 صفًا |
| تحديث الفهرس | 3 631–9 396 مستند/ث (281–958 ms) | 8 881–8 940 مستند/ث |

الخلاصة: عند 10 000 العناصر يقرأ المسار المُدمَج 0–150 صفًا مقابل 10 006 في المسار القديم، بزمن أقل بـ **5×–19×**، والـ suite يفرض ذلك بميزانيات (3 tests / 0 fail) على الركنين — فالتصريح «C1 محفوظ» مُثبت بقيود لا بانطباع.

بطاقات المحادثة (`w02u3-card-performance-browser-journey`، 41274530872): الميزانيات المعلنة في الاختبار `loadMedianMs 2500` / `loadP95Ms 4000` / `bubbleCap 40` / `domCap 8000` (عامل نمو 1.6) على عرضين 320 و1280. القياسات الفعلية على الـ SHA النهائي: **median 249–495 ms**، p95 260–526 ms، وعُقد DOM **~521–522** في كل عرض — أي ضمن الميزانية بهامش كبير، و«لا انحراف أفقي عند 320px في المحادثة الطويلة».

---

## 5 — الأمان والاعتماديات والأسرار

`qoder-security` على `d593b0d` — التشغيل **41274402364**، النتيجة success، بأركان: `codegen` (إعادة توليد العملاء ومقارنتها بالمُودَع ⇒ لا انحراف تعاقد)، `audit` (فحص الاعتماديات)، `build`.

- لم تُعطَّل أي حراسة للحصول على أخضر: `clone-migration-guard` يفرض البادئة 28 والمراجَعة 16 (47 مدخلًا)، `resolveDatabaseUrl` يرفض أي قاعدة غير loopback disposable، `paymentSimulationEnabled()` يُرجع 404 خارج التطوير، `isPromotionFeatureEnabled()` خلف `BDINAR_PROMOTIONS_ENABLED=true`.
- كل تشغيل يمر عبر `test/isolation/local-suite.sh` الذي ينشئ `dinar_test_local_<random>` على `127.0.0.1` ويحذفها، ويُعلن `LOCAL_SUITE … exit=0 outbound=0`.
- **التدخّل الوحيد المُعلَن في حالة السلاسل:** حصّة الإبطاء المُخزَّنة في القاعدة (`auth_rate_limit_buckets`) تُنظَّف **بين** مجموعات السلسلة، والخطوة معلَنة في السجل بـ `LOCAL_SUITE_THROTTLE_RESET … rows=N`. لا يحدث هذا في تشغيل المجموعة الواحدة إطلاقًا، ولا يمسّ حدّ 20/900 ثانية ولا مفتاح الـ IP ولا سلوك 429 (التفصيل والسبب في §2 ز).
- **لم يُنفَّذ** أي اتصال بقاعدة إنتاجية ولا استخدام أي سرّ إنتاجي؛ **لم تُفعَّل** فوترة حقيقية ولا إرسال واتساب حقيقي.

---

## 6 — ما ليس أخضر (بلا تجميل)

| البند | الحالة | التفصيل / ما يلزم |
|---|---|---|
| تاريخ هجرة الموجات في قاعدة المالك/preview | **BLOCKED** | لا صلاحية فحص قاعدة إنتاجية (حظر التكليف). يلزم تأكيد المالك أن لا قاعدة خاصة تحمل وسوم `0041_wave07..` قبل الدمج |
| سنابات `0043..0046` | **PARTIAL** | مطابقة للمصدر؛ لا اختبار حالي يعتمد عليها؛ `drizzle-kit generate` على المرشّح المدمج عمل مستقل |
| OpenAPI لمسارات الموجات W07–W10 | **PARTIAL عندنا — مُنجَز في فرع موازٍ** | D1/D2 مُغطَّى بالكامل (`D2-19`)؛ مسارات cash/trust/privacy/compliance/appeals/provider خارج `openapi.yaml` عندنا (102 مسارًا)، بينما `claude/13`@`fe1c233` يغطيها (146 مسارًا، superset صارم + حارس `integration-openapi-coverage.test.ts`) — انظر N8 و§5 ب |
| **المرجع canonical للتكامل (`qoder/17` أم `claude/13`)** | **OPEN — قرار المالك (N8)** | فرعان ينفّذان الدفعات نفسها بتسلسل هجرات مختلف (الـ SQL متطابق البنية) وبتنفيذين مختلفين لـ S9/S11؛ لم يُدَّعَ أن مرشّحنا هو العمل التكاملية الوحيد، ولا دُمِج الفرع الآخر أعمى |
| TLS حي | **PARTIAL** | فحص journal/hashes الكامل يعمل في CI؛ اختبار TLS الحي خلف `DINAR_TLS_ACCEPTANCE` (لا شبكات خارجية في CI المعزول) |
| ~~سلسلة «ثماني مجموعات في job واحد»~~ | **مُغلَقة — لم تعد عملًا متبقيًا** | كانت هذه الخلية PARTIAL/لم تُنفَّذ؛ أُنجزت في §2 ز: تسع مجموعات متداورة في job واحد على قاعدة واحدة، 118 اختبارًا على PG16.15 وPG18.6، مع فشلها الأول (429) مُعلَنًا كما وقع |
| رحلة a11y (حدّ 15 ثانية) | **مُراقَب** | خضراء على النهائي (41274528668)؛ التعثّر السابق موثَّق في N4 مع الإصلاح المقترح غير المطبَّق |
| `qoder/15` D3A و`codex/11` | **BLOCKED / NOT INTEGRATED** | خارج نطاق W12.2 بمبررات مُعلنة (تصادم `0042`؛ دالة PL/pgSQL لا تستدعيها شيفرة canonical) |
| D9 | **غير موجود** | لا فرع ولا مصدر؛ لا شيء وُهم أنه مُدمج |
| دمج في `main` / نشر / تفعيل أسواق / اعتماد قانوني | **لم يُنفَّذ — ومحظور** | هذه الوثيقة لا تدّعي جاهزية إطلاق |

---

## 7 — إعادة الإنتاج

كل تشغيل أعلاه هو `workflow_dispatch` على `qoder-api-suite.yml` (أو `qoder-security.yml`) بـ `ref=qoder/17-unified-integration-candidate`:

```
gh workflow run qoder-api-suite.yml -R qurankream0987-eng/dinar-pro \
  -f ref=qoder/17-unified-integration-candidate \
  -f suite=<اسم المجموعة> \
  -f pg_version=16|18 \
  -f run_release_migration=true            # لـ readiness فقط (legs النشر)
  -f flags="BDINAR_W0x_ACCEPTANCE=development BDINAR_TEST_DATABASE=development ..."
```

قواعد الأعلام التي تحققت empirically في هذا العمل:
- `wave3-acceptance` يحتاج `BDINAR_WAVE3_ACCEPTANCE=development` وإلا يفشل بحراسة قاعدة التطوير الآمنة (لا بخطأ شيفرة).
- `wave07`/`wave08`/`wave4` تحتاج `BDINAR_WAVE4_ACCEPTANCE=development` (محاكاة الدفع)؛ بدونها تُرجع المسارات 404.
- `phase1` والمجموعات التجارية تحتاج `BDINAR_PROMOTIONS_ENABLED=true`؛ بدونها 503.
- مجموعات الأساس العادية تكفيها `BDINAR_TEST_DATABASE=development`.
- المجموعات الثقيلة تُصرَّف serially (تفويضات متتابعة) لأن الإرسال المتوازي عبر `gh` يُحدث انقطاعات شبكة. السلاسل الأربع في §2 ز أُرسلت متوازية داخل مجموعات `concurrency` مختلفة (قيمة `suite` مختلفة لكل سلسلة، وهي مُتجاهَلة في السلسلة) فنجحت كلها؛ الضابط أن لا يتزامن تشغيلان على نفس المجموعة.

**إعادة إنتاج سلسلة (§2 ز):** أسماء السلاسل في allowlist الـ workflow، والأعلام يجب أن تستوفي ما تتطلبه السلسلة وإلا يسقط الـ job في خطوة Validate inputs بـ exit 96 قبل إهدار دقائق:

```
gh workflow run qoder-api-suite.yml -R qurankream0987-eng/dinar-pro \
  --ref qoder/17-unified-integration-candidate \
  -f chain=integrated-nine-interleaved -f suite=wave07-financial-journal.test -f pg_version=16 \
  -f flags="BDINAR_TEST_DATABASE=development BDINAR_W07_ACCEPTANCE=development BDINAR_W08_ACCEPTANCE=development BDINAR_W09_ACCEPTANCE=development BDINAR_W10_ACCEPTANCE=development BDINAR_W12C_ACCEPTANCE=development BDINAR_D1D2_ACCEPTANCE=development BDINAR_W02U3_TEST_DATABASE=development BDINAR_WAVE4_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true"
```

وبديلان أضيق: `financial-waves-w07-w12c` (أعلام الموجات الخمسة + `BDINAR_WAVE4_ACCEPTANCE`) و`business-cards-search-commerce` (أعلام D1/D2 وW02U-3 و`BDINAR_TEST_DATABASE` و`BDINAR_WAVE4_ACCEPTANCE` و`BDINAR_PROMOTIONS_ENABLED=true`). محليًا حيث تعمل user namespaces، المشغّل نفسه يقبل القائمة ذاتها مباشرة: `sh test/isolation/local-suite.sh a.test b.test … BDINAR_…=development`.

**الحكم النهائي:** المرشّح `d593b0d` أخضر في 43/43 تشغيلًا على PG16 وPG18 مع Chromium حقيقي، بما فيه المسارات المجمَّعة والأداء والأمان. وما فوقة غيّر CI ومشغّل العزل فقط (لا شيفرة المنتج)، وهو أخضر في **8 من 10** سلاسل؛ السلسلتان الحمراوان موثّقتان باكتشافهما الحقيقي لا بإخفائه (§2 ز). البنود غير المكتملة مُعلنة كأعمال متبقية بمُلكياتها، ولم يُدَّعى إنجازها. **ولا يُدَّعى أن هذا المرشّح هو التكامل الوحيد:** إعادة تفقد المراجع في نهاية العمل وجدت `claude/13-integration-preflight` (`fe1c233`) — تكاملًا موازيًا للدفعات نفسها بترقيم هجرات مختلف يشاركنا نفس الـ SQL بايت-ببايت، ويغطي 44 مسار OpenAPI أعلنّاه نحن PARTIAL، وأعاد تنفيذ S9/S11 بطريقته؛ وهو أخضر في CI خاص به (41275493692 على `7cd334d`). أي حكم على «المرجع canonical» معلَّق على قرار المالك في N8/C-7، لا على هذه الوثيقة.
