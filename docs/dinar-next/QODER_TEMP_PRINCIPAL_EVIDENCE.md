# QODER TEMPORARY PRINCIPAL — تقرير الأدلة (G4 + G5 + G6)

**الفرع:** `qoder/temp-principal-sixwave-closure` فوق `ebdd2d7` (رأس المرشّح الموحّد).
**القاعدة:** لا يُسجَّل أي بند كـ«ناجح» إلا بسطر دليل من تشغيل GitHub Actions على قاعدة loopback قابلة للتلف.
**ما يغطيه هذا التقرير:** العيوب الخمسة التي وُجدت في المرشّح الموحّد (أربعة مُثبَتة بالتشغيل، والخامس مُصلَح بالقراءة ومُثبَت التشغيل محجوب)، وسجلّ كل تشغيل على هذا الفرع (§4)، والأساس المقاس لأداء تصيير التاريخ (G4)، وحاجز الفوترة الذي أوقف الإثبات الأخير (§7). جرد الـ13 سير عمل في `QODER_TEMP_PRINCIPAL_G3_WORKFLOWS.md`.

---

## 1. العيوب 1–3 في المرشّح الموحّد — وكلها في طبقة السلامة، لا في المنتج

### العيب 1 — رأس السجل المراجَع مثبّت على ترحيل قديم

| | |
|---|---|
| الموضع | `artifacts/api-server/test/development-tls.test.ts:169` |
| الحالة | `assert.equal(REVIEWED_PENDING_MIGRATIONS.at(-1)?.tag, "0054_conversation_memory")` |
| الواقع | آخر ترحيل على المرشّح هو `0056_order_line_integrity` (57 ترحيلًا) |
| الأثر | اختبار سلامة الإصدار يفشل على الرأس الصحيح، أي أن الحارس كان يرفض السلسلة التي وُضع ليحميها |
| الإصلاح | `86fa92a` — تثبيت الرأس على `0056_order_line_integrity` |

### العيب 2 — بصمة `0056` في حارس الاستنساخ لا تطابق الملف الملتزم

| | |
|---|---|
| الموضع | `lib/db/src/clone-migration-guard.ts:64` |
| الحالة | `sha256: "3ea1007b7b8252967cee44d6d698df6909a148573d136c7cf5fa07571472d29e"` |
| القيمة الصحيحة | `cf43a95bfe0d9418aa9f0d9b3fe862b8e131116299dca92be3ac5815028c234c` |
| المرجع | بصمة git للفقاعة (`git show HEAD:lib/db/drizzle/0056_order_line_integrity.sql \| sha256sum`) **و** `lib/db/drizzle/release-manifest.json:227-228` — متطابقان |
| الأثر | `Error: Migration 0056_order_line_integrity differs from its reviewed version.` عند أي تحقق من السجل |
| الإصلاح | `a297557` |

**تحقّق شامل بعد الإصلاح:** قورنت كل التثبيتات التسعة والعشرين في `REVIEWED_PENDING_MIGRATIONS` مع `release-manifest.json` بندًا بندًا — **صفر اختلاف**. المانيفست وفقاعة git هما المرجع، والتثبيت الشاذّ كان واحدًا فقط.

> ملاحظة منهجية: الشجرة على Windows تُخرَج بـCRLF، لذا `sha256sum` على القرص يعطي قيمة مختلفة عن الفقاعة الملتزمة. كل مقارنات البصمات في هذا التقرير أُجريت على محتوى git، لا على ملف القرص.

**الدليل:**

| التشغيل | PG | النتيجة |
|---|---|---|
| `41853156218` | 16 | `development-tls.test` ‏`pass 7 fail 0`، `LOCAL_SUITE … exit=0 outbound=0` |
| `41853164133` | 18 | `development-tls.test` ‏`pass 7 fail 0`، `LOCAL_SUITE … exit=0 outbound=0` |

وفي كلٍّ منهما `test:surfaces` على الويب `pass 35 fail 0`.

### العيب 3 — ‏CR-12 أُعيدت كتابته ليفترض رفضًا لم ينتجه المنتج قطّ

| | |
|---|---|
| الموضع | `artifacts/api-server/test/w02u3-card-reliability.test.ts` (CR-12) |
| الحالة على المرشّح | `PATCH /account/market {marketId:"SA"}` يُتوقّع أن يعيد **409**، بتعليق يقول «SA remains legally unapproved in this disposable single-market harness» |
| الواقع المقاس | **200** — في كل تشغيل، على قاعدة منفردة (`41849634329`) وعلى السلسلة المشتركة (`41848243829`) |

**سبب الجذر، مُثبَتًا بالقراءة لا بالتخمين:**

1. بذرتا الاختبار تُنشّطان SA بسعر وحدة: `test/acceptance-fixtures.ts:40-49,69-92` (‏`MARKET_FIXTURES`، البثّ الافتراضي في `local-suite.sh:239`) و`test/seed.ts:41-51`. فلا يوجد «حarness أحادي السوق».
2. `isMarketAvailable` (`src/lib/markets.ts:53-55`) هي البوابة الوحيدة في هذا المسار، وقد أزال عنها الالتزام `908b531` (W07 التسعير المرن) شرط سعر الوحدة عن قصد — وهذا صحيح منتجّيًا لأن الأسعار صارت لكلّ معروضة.
3. البوابة القانونية D16 (`assertCountryActivationReady`) **لا تُستدعى** في هذا المسار، وهي أصلًا معطّلة في بيئة الاختبار لأن `marketLegalGateEnforced` (`src/lib/d16-readiness.ts:54-63`) يعيد `false` عندما `NODE_ENV=development` بلا علامة نشر.
4. المرجع الأخضر الموثّق (`b5a3772`، التشغيل `41245095592`، ‏8/8) كان يؤكد **200** ثم يثبت الحدود الحقيقية. أي أن إعادة الكتابة في `92c8948` هي التي أدخلت الافتراض الخاطئ، لا أن المنتج تراجَع.

**الإصلاح (`8ebb6ed` + `7f14f3f`):** أُعيدت الحدود التي كُتب السيناريو ليثبتها، وهي المطابقة للنية الموثّقة في `QODER_14_W02U3_CANONICAL_ACCEPTANCE_MATRIX.md:47` («SA cannot see the JO listing; confirm in SA refused, both carts untouched»):

- التبديل إلى SA ينجح (200)؛
- المعروضة الأردنية **غير مرئية** في SA (‏404)؛
- سلة SA **لا تحمل شيئًا** من المراجعة الأردنية؛
- التأكيد «نعم» من SA **مرفوض** برسالة `ليس في سوقك الحالي`؛
- بعد الرجوع إلى JO: السلة ما زالت 1، والهوية `surfaceId` لم تتغيّر.

ثم جيء بالادّعاء الأدقّ بدل الادّعاء الخاطئ: المراجعة المرفوضة تُستقرّ `REJECTED` في السجل، و`actionLifecycleState` (`lib/api-zod/src/surface-composition.ts:56-59`) يعرضها `CANCELLED`، و`allowedActions` تصير فارغة. فأكّدنا `lifecycle === "CANCELLED"` و`allowedActions` فارغة — وهذا **أشدّ** من المرجع الأخضر الذي اكتفى بـ`notEqual(…, "CONFIRMED")`.

> أمانة: لم يُضعَف أي assertion. حُذف ادّعاءان كاذبان (‏409، وبقاء البطاقة `PENDING_REVIEW`) واستُبدلا بخمسة تأكيدات حقيقية. الكود المنتجّي لم يُلمس في هذا العيب.

**الدليل:**

| التشغيل | SHA | PG | النتيجة |
|---|---|---|---|
| `41849634329` | `86fa92a` | 16 | قبل الإصلاح: `actual: 200, expected: 409` — منفرد |
| `41848243829` | `86fa92a` | 16 | قبل الإصلاح: العطل نفسه داخل السلسلة التساعية، وبقيت السبع حزم الأخرى `exit=0 outbound=0` |
| `41853171346` | `8ebb6ed` | 16 | وسيط: `actual: 'CANCELLED', expected: 'PENDING_REVIEW'` — أي أن فرضية 409 سقطت وبقي الادّعاء الثاني |
| `41853515124` | `8ebb6ed` | 16 | العطل الوسيط نفسه داخل السلسلة (تأكيد مستقل للتشخيص في بيئة قاعدة مشتركة) |
| `41854336974` | `7f14f3f` | 16 | **بعد الإصلاح:** `✔ CR-12 another account and another market cannot read or drive the cards (175.5ms)`، `LOCAL_SUITE suite=w02u3-card-reliability.test db=dinar_test_local_39e2b908ec6f exit=0 outbound=0` |

---

## 2. العيب 4 — قياس فهرس الـtrigram في D17: مقام ناقص ثم انتفاخ GIN (إصلاح على مرحلتين)

| | |
|---|---|
| الموضع | `artifacts/api-server/test/w06-d17-retrieval-quality.test.ts` (D17.8-R6) |
| القياس الأصلي | `pg_relation_size('messages_body_trgm_idx')` مقسوم على `storedMessages` (رسائل هذه الحزمة وحدها = 395) |
| النتيجة على السلسلة | `trigramBytesPerMessage: 18541` مقابل ميزانية `8192` — فشل |

**المرحلة الأولى (`e91e665`) — مقام حقيقي، لكنها لم تكفِ.**
ظننت أولًا أن الخطأ في المقام وحده: على السلسلة المشتركة تترك الحزم الأخرى صفوفًا حيّة في `messages`، فالقسمة على 395 تُحاسب هذه الحزمة على صفوف غيرها. أضفت `(SELECT count(*) FROM messages)` مقامًا (`indexedMessages`) مع تأكيد `indexedMessages >= storedMessages`. لكن التشغيل `41857664201` (PG16) أعاد `storedMessages:395, indexedMessages:471, trigramIndexBytes:7233536, trigramBytesPerMessage:15358` — ما زال فشلًا. تغيير المقام من 395 إلى 471 خفّف الرقم (‏18541→15358) لكنه لم يعالج السبب، لأن العطب في **البسط** لا في المقام.

**المرحلة الثانية (`9a57d62`) — السبب الحقيقي: انتفاخ GIN لا ينكمش بالحذف.**
قراءة `wave06-conversation-memory-performance.test.ts` تثبت الآلية حرفيًا:

- السطور 63-77: ‏`growTo` تنمّي جدول `messages` **الحقيقي** إلى 10٬000 صف، وفهرس GIN يُصان مع كل إدراج.
- السطور 205-210: ‏+100 صف في اختبار التزامن.
- السطر 233 (`after`): ‏`DELETE FROM messages WHERE conversation_id = …` يحذفها كلها.

وحذف الصفوف **لا يُصغّر فهرس GIN** — تبقى الصفحات مخصّصة حتى صيانة (`REINDEX`/`VACUUM FULL`). فـ`pg_relation_size` في نهاية السلسلة يعكس الذروة (‏~10٬100 صف = ‏7.2 م.ب) لا الصفوف الحيّة (‏471). ولا يعالج أيُّ مقام ذلك؛ الحلّ في البسط.

**الإصلاح:** ‏`REINDEX INDEX messages_body_trgm_idx` قبل القياس مباشرةً، فيُعاد بناؤه فوق الصفوف الحيّة فقط، ويصير «بايت/صف» مقياسًا للفهرس نفسه لا لبيانات قياسٍ محذوفة لحزمة أخرى. الميزانية 8192 لم تُضعَف، واسم الاختبار («measured against the rows it indexes») صار مطابقًا للقياس فعلًا. (‏`REINDEX` يعمل خارج المعاملة، والحزمة المجاورة تشغّل `ANALYZE` مجرّدًا بالآلية نفسها في السطر 79، فالحالة autocommit مؤكّدة.)

**الدليل — الإصلاح مُثبَت بالقياس لا بالحجة (`41859324605`، PG16، سلسلة `wave06-d17-memory`):**

| | قبل `REINDEX` (`41857664201`) | بعد `REINDEX` (`41859324605`) |
|---|---|---|
| `trigramIndexBytes` | 7 233 536 | **139 264** |
| `indexedMessages` (حيّة) | 471 | 471 |
| `trigramBytesPerMessage` | 15 358 (فشل) | **296** (نجاح، ‏`< 8192`) |
| الحكم | `first_failed=w06-d17-retrieval-quality.test` | `✔ D17.8-R6`، ‏`LOCAL_SUITE_CHAIN suites=5 … exit=0 first_failed=none` |

انكمش الفهرس 52× (‏7.2 م.ب → 139 ك.ب) على العدد الحيّ نفسه من الصفوف — وهذا إثبات قاطع بأن الـ7.2 م.ب كانت انتفاخ GIN من صفوف القياس المحذوفة، لا كلفة حقيقية لكل رسالة. الكلفة المضغوطة الحقيقية 296 بايت/صف.

> أمانة: تشخيصي في المرحلة الأولى كان ناقصًا (عزا العطب إلى المقام وحده)، وسجّلته هنا كما وقع. ادّعاء أن إصلاحًا واحدًا حسم العيب وهو لم يفعل كان سيكون إخفاءً. الفهرس نفسه سليم ومستخدَم طوال الوقت — خطط `EXPLAIN` في حزمة الأداء تُظهر `Bitmap Index Scan on messages_body_trgm_idx` عند كل مقياس ≥ 1000.

---

## 3. G4 — أساس مقاس بدل ادّعاء «13.10%»

لم يُعثر في المستودع على أي أثر للرقم `13.10%` (لا تقرير، لا تشغيل، لا تعليق). لذا لم يُفترض أن المرشّح يحمل ذلك التراجع، وبُنِيَ أساس جديد على المسار الحقيقي: `renderToStaticMarkup` فوق `RichText body={privateTranscript(body)}`، بأربع تشكيلات رسائل عربية (قوائم، جدول markdown، كتلة شيفرة، فقرة طويلة)، وسبع تكرارات لكل حجم.

**المقاييس (ثلاث عينات مستقلة من CI، ‏`HISTORY_RENDER_PERF_SUMMARY`):**

| العينة | 20 رسالة ns/msg | 100 رسالة ns/msg | 400 رسالة ns/msg | p50 عند 400 (ms) | بايت الترميز عند 400 |
|---|---|---|---|---|---|
| `41848243829` | 799 524 | 281 903 | 180 525 | 72.21 | 493 805 |
| `41849634329` | 502 560 | 293 556 | 174 810 | 69.92 | 493 805 |
| `41854336974` | 565 933 | 192 271 | 112 131 | 44.85 | 493 805 |

**الاستنتاج الأول:** الكلفة لكل رسالة **تتناقص** مع الطول (‏7.1× انخفاض من 20 إلى 400 في أسوأ عينة)، أي أن التصيير دون خطّي — والحارس `largest <= smallest * 3` يمرّ. لا يوجد تراجع نسبي في تصيير التاريخ نفسه على هذا المرشّح.

**الاستنتاج الثاني، وهو الخطر الحقيقي المقاس:** إعادة تصيير القائمة كاملة أثناء البث.

| العينة | قائمة كاملة عبر 40 delta (ms) | الجواب وحده (ms) | التضخيم |
|---|---|---|---|
| `41848243829` | 873.18 | 116.63 | 7.5× |
| `41849634329` | 877.97 | 136.17 | 6.4× |
| `41854336974` | 606.95 | 78.45 | 7.7× |

أي أن أي مسار يعيد تصيير المحادثة كلها لكل حدث بثّ يدفع نحو **ثانية كاملة** على محادثة من 100 رسالة، مقابل ~0.1 ثانية لو اقتصر التصيير على الجواب الجاري. هذه هي الأولوية الأدائية الموثّقة، وهي مقاسة لا مُقدَّرة.

لم تُنفَّذ أي تحسينات بعد؛ الأساس مُثبَّت أولًا حتى يُقاس أي تغيير لاحق على SHA مجمّد بالمقارنة، لا بالانطباع.

---

## 4. سجلّ التشغيلات على هذا الفرع

| التشغيل | SHA | PG | الهدف | الحكم |
|---|---|---|---|---|
| `41846501269` وغيرها | `cf084ac` | 16 | أساس أداء التاريخ + surfaces | نجاح (أُخذت منه أول عينة) |
| `41848243829` | `86fa92a` | 16 | السلسلة التساعية | فشل في CR-12 فقط (العيب 3)؛ الحزم الثماني الأخرى `exit=0 outbound=0` |
| `41849634329` | `86fa92a` | 16 | ‏w02u3 منفردًا — مقارنة حاسمة | فشل: أثبت أن العطل ليس تلوّثًا بين السلاسل |
| `41853156218` | `8ebb6ed` | 16 | ‏development-tls | **نجاح** ‏`pass 7 fail 0` |
| `41853164133` | `8ebb6ed` | 18 | ‏development-tls | **نجاح** ‏`pass 7 fail 0` |
| `41853171346` | `8ebb6ed` | 16 | ‏w02u3 منفردًا | فشل وسيط (الادّعاء الثاني) |
| `41853515124` | `8ebb6ed` | 16 | السلسلة التساعية | فشل وسيط في CR-12 — تأكيد مستقل للتشخيص على قاعدة مشتركة |
| `41854336974` | `7f14f3f` | 16 | ‏w02u3 منفردًا | **نجاح** ‏`✔ CR-12`، ‏`exit=0 outbound=0` |
| `41854630660` | `7f14f3f` | 18 | السلسلة التساعية كاملة | **نجاح** — التسع حزم `exit=0 outbound=0`، ‏`LOCAL_SUITE_CHAIN suites=9 … first_failed=none` |
| `41854637544` | `7f14f3f` | 16 | ‏security-acceptance | **نجاح** ‏`pass 12 fail 0`، ‏`exit=0 outbound=0` |
| `41854644732` | `7f14f3f` | 16 | ‏readiness | **نجاح** ‏`pass 15 fail 0`، ‏`exit=0 outbound=0` |
| `41854345555` | `7f14f3f` | 16 | السلسلة التساعية | فشل في `wave08-cash-and-refunds` — انظر §5 |
| `41854651396` | `7f14f3f` | 16 | ‏wave06-d16-d17 | **خطأ إرسال لا فشل شيفرة**: ‏`chain wave06-d16-d17 requires BDINAR_D16_ACCEPTANCE=development` (‏`exit 96` في خطوة التحقق من المدخلات) |
| `41855763788` | `7f14f3f` | 16 | ‏wave06-d16-d17 بالأعلام الصحيحة | **نجاح** |
| `41855774099` | `7f14f3f` | 16 | ‏wave06-d17-memory | أربع حزم خضر (‏50 + 42 + 5 + 5) وفشل `w06-d17-retrieval-quality` — العيب 4 (§2) |
| `41855782739`، `41855797983` | `7f14f3f` | 16 | ‏wave08 منفردة | ‏`pass 11 fail 1` بـ`404 {"error":"Not found"}` — **خطأ إرسال منّي**: نقص `BDINAR_WAVE4_ACCEPTANCE` (§5) |
| `41857664201` | `e91e665` | 16 | ‏wave06-d17-memory | فشل `w06-d17-retrieval-quality` (‏`trigramBytesPerMessage:15358`) — المرحلة الأولى من العيب 4 لم تكفِ (§2) |
| `41857672886` | `e91e665` | 16 | السلسلة التساعية كاملة | **نجاح** — التسع حزم `exit=0 outbound=0`، ‏`LOCAL_SUITE_CHAIN suites=9 … first_failed=none`. أوّل تساعية خضراء على **PG16** |
| `41857680889` | `e91e665` | 16 | ‏wave08 منفردة بالأعلام الصحيحة | **نجاح** ‏`exit=0 outbound=0` — يؤكد أن §5-أ كان خطأ إرسال منّي، لا عيبًا |
| `41859324605` | `9a57d62` | 16 | ‏wave06-d17-memory | **نجاح** — ‏`✔ D17.8-R6`، ‏`trigramBytesPerMessage:296`، ‏`LOCAL_SUITE_CHAIN suites=5 … first_failed=none`. إصلاح العيب 4 مُثبَت بالقياس (§2) |
| `41861210735` | `31f52c7` | 16 | ‏wave08 منفردة (بذرة مُصلَحة) | **نجاح** ‏`pass 12 fail 0`، ‏`exit=0 outbound=0` — لا أثر لـ`LISTING_CONTACT_TEXT` (§5-ب) |
| `41861217793` | `31f52c7` | 16 | السلسلة التساعية عند SHA مجمّد | **نجاح** — ‏`LOCAL_SUITE_CHAIN suites=9 … first_failed=none`، و`wave08 exit=0 outbound=0` داخلها |
| `41861224422` | `31f52c7` | 18 | السلسلة التساعية عند SHA مجمّد | **نجاح** — ‏`LOCAL_SUITE_CHAIN suites=9 … first_failed=none`، و`wave08 exit=0 outbound=0` داخلها |
| `41863223557` | `e76e6b0` | 16 | ‏`w02u3-card-reliability-browser-journey` | **نجاح** — `ℹ pass 1`، `LOCAL_SUITE … db=dinar_test_local_85751bda6ce2 exit=0 outbound=0`، متصفح حقيقي (`chromium=1`) |
| `41863232089` | `e76e6b0` | 16 | ‏`w02u3-card-accessibility-browser-journey` | **نجاح** — `exit=0 outbound=0`؛ يقي مسار لوحة المفاتيح عند 390 و**البطاقة عند 320 بكسل** (`:136`) |
| `41863241242` | `e76e6b0` | 16 | ‏`w02u3-card-concurrency-browser-journey` | **نجاح** — `exit=0 outbound=0` (تبويبان متزامنان على قاعدة واحدة) |
| `41863248169` | `e76e6b0` | 16 | ‏`w02u3-card-recovery-browser-journey` | **نجاح** — `exit=0 outbound=0` (تسليم بلا جواب ثم استرجاع) |
| `41863257380` | `e76e6b0` | 16 | ‏`wave03-card-envelope-browser-journey` | **نجاح** — `exit=0 outbound=0`؛ هوية البطاقة ودورتها وأفعالها عند **320/390/سطح المكتب** (`:50`) |
| `41863266956` | `e76e6b0` | 16 | ‏`wave03-d7-cart-browser-journey` | **نجاح** — `exit=0 outbound=0` (السلة الدائمة في متصفح حقيقي) |
| `41864491280` | `e76e6b0` | 16 | سلسلة `d4-d5-authorization` | **نجاح** — ثلاث حزم `exit=0 outbound=0` على `db=dinar_test_local_5aaf195226cc`، `suites=3 first_failed=none` |
| `41864502852` | `e76e6b0` | 16 | سلسلة `ai-foundation` | **نجاح** — أربع حزم `exit=0 outbound=0` على `…b5695ca60233`، `suites=4 first_failed=none` |
| `41864509547` | `e76e6b0` | 16 | سلسلة `wave04-d10-d12` | **نجاح** — ست حزم `exit=0 outbound=0` على `…2754e6c33915`، `suites=6 first_failed=none` |
| `41864496845` | `e76e6b0` | 16 | سلسلة `d6-g2-negotiation` | **فشل** في `G2-36B` وحده — عيب خامس قائم في المرشّح، انظر §6 |
| `41877578228` | `5446ccb` | 16 | ‏`g2-smart-conversation.test` منفردة (إثبات الإصلاح) | **لم تُشغَّل**: حجب فوترة GitHub Actions (§8) |
| `41877681772` | `5446ccb` | 16 | سلسلة `d6-g2-negotiation` (إعادة تشغيل) | **لم تُشغَّل**: الحجب نفسه، بعد 20 ثانية من الأول |

وفي كل تشغيل ناجح أعلاه مرّ `test:surfaces` على الويب بـ`pass 35 fail 0`.

**الرأس المجمّد النهائي `31f52c7`:** السلسلة التساعية خضراء على **PG16 وPG18** معًا، و`wave08` خضراء منفردة (‏12/12) وداخل كلتا السلسلتين، و`wave06-d17-memory` خضراء (‏5/5)، و`security-acceptance` (‏12/12) و`readiness` (‏15/15) و`development-tls` على PG16+PG18 (‏7/7) و`wave06-d16-d17` خضراء. هذا أقوى دليل G5/G6 متاح على هذا الفرع.

**ما أُضيف فوق المجمّد (`e76e6b0` — التزام وثائقي فقط فوق نفس الكود المجمّد):** ست رحلات متصفح حقيقية خضراء بثلاثة مقاسات مختلفة (320/390/سطح المكتب)، وثلاث سلاسل API إضافية خضراء (`d4-d5-authorization` 3/3، `ai-foundation` 4/4، `wave04-d10-d12` 6/6)، وسلسلة واحدة حمراء بعيبٍ خامس (§7). بما أن `e76e6b0` لا يغيّر أي ملف تشغيل أو اختبار، فأخضره ينسب إلى الكود المجمّد `31f52c7` نفسه.

**السلسلة التساعية على PG18 عند `7f14f3f` — الأدلة الحرفية:**

```
LOCAL_SUITE suite=wave07-financial-journal.test        exit=0 outbound=0
LOCAL_SUITE suite=d1-d2-business-foundation.test       exit=0 outbound=0
LOCAL_SUITE suite=wave08-cash-and-refunds.test         exit=0 outbound=0
LOCAL_SUITE suite=w02u3-card-reliability.test          exit=0 outbound=0
LOCAL_SUITE suite=wave09-policy-consent-compliance.test exit=0 outbound=0
LOCAL_SUITE suite=search-sql-foundation.test           exit=0 outbound=0
LOCAL_SUITE suite=wave10-trust-support-whatsapp.test   exit=0 outbound=0
LOCAL_SUITE suite=commerce-journey.test                exit=0 outbound=0
LOCAL_SUITE suite=wave07-w12-contract-hardening.test   exit=0 outbound=0
LOCAL_SUITE_CHAIN suites=9 db=dinar_test_local_1233127d5074 exit=0 first_failed=none
```

**السلسلة التساعية على PG16 عند `e91e665` — الأدلة الحرفية (`41857672886`):**

```
LOCAL_SUITE suite=wave07-financial-journal.test        exit=0 outbound=0
LOCAL_SUITE suite=d1-d2-business-foundation.test       exit=0 outbound=0
LOCAL_SUITE suite=wave08-cash-and-refunds.test         exit=0 outbound=0
LOCAL_SUITE suite=w02u3-card-reliability.test          exit=0 outbound=0
LOCAL_SUITE suite=wave09-policy-consent-compliance.test exit=0 outbound=0
LOCAL_SUITE suite=search-sql-foundation.test           exit=0 outbound=0
LOCAL_SUITE suite=wave10-trust-support-whatsapp.test   exit=0 outbound=0
LOCAL_SUITE suite=commerce-journey.test                exit=0 outbound=0
LOCAL_SUITE suite=wave07-w12-contract-hardening.test   exit=0 outbound=0
LOCAL_SUITE_CHAIN suites=9 db=dinar_test_local_a5493f31f777 exit=0 first_failed=none
```

> السلسلة التساعية خضراء الآن على **PG16 وPG18** معًا. الفرق بين `e91e665` و`9a57d62` هو ملف اختبار D17 وحده (`w06-d17-retrieval-quality.test.ts`)، وهو ليس ضمن السلسلة التساعية؛ فأخضر التساعية عند `e91e665` قائم على الرأس النهائي أيضًا.

## 5. `wave08-cash-and-refunds` — عطلان منفصلان، أحدهما خطأ إرسال منّي

**(أ) `404 {"error":"Not found"}` في التشغيلين المنفردين `41855782739` و`41855797983` — خطأ إرسال، لا عيب.**
السبب مقروء من الشيفرة: ‏`src/routes/payments.ts:39-45` (`requireSimulation`) يعيد `404 {"error":"Not found"}` عندما لا يتحقّق `paymentSimulationEnabled()`، وهي تشترط `BDINAR_WAVE4_ACCEPTANCE === "development"` (السطور 33-38). إرسالي المنفرد مرّر `BDINAR_W08_ACCEPTANCE` و`BDINAR_TEST_DATABASE` فقط. والدليل أن الحزمة تنجح كاملة عندما يُمرَّر العلم ضمن السلسلة. لا يُحسب هذا على الشيفرة، ولا على المرشّح.

**(ب) `LISTING_CONTACT_TEXT` في سلسلة PG16 (`41854345555`) — متقطّع، وأُصلحت البذرته وثبت الإصلاح.**
فشلت الاختبارات الأحد عشر كلها دفعة واحدة عند الإعداد:

```
AssertionError: {"error":"لا تكتب رقم الهاتف أو البريد أو الروابط في عنوان الإعلان أو وصفه…","code":"LISTING_CONTACT_TEXT"}
400 !== 201   at publish (…)  at acceptedOrder (…)
```

تصنيفه «متقطّع» لا «تراجع» للأسباب المقاسة التالية:

- الحزمة نفسها نجحت على PG16 عند `86fa92a` (‏`41848243829`)، ونجحت على PG18 عند `7f14f3f` (‏`41854630660`)، وعادت فنجحت على PG16 عند `e91e665` في السلسلة التساعية (`41857672886`) وفي تشغيل منفرد بالأعلام الصحيحة (`41857680889`). أي **أربع عينات خضراء** حول الحمراء الواحدة (`41854345555`) بلا تغيير في شيفرة `wave08` بينها — وهذا هو تعريف التقطّع.
- التزامات هذا الفرع تمسّ `w02u3-card-reliability.test.ts` وبصمة في `clone-migration-guard.ts` وقياسًا في `w06-d17-retrieval-quality.test.ts` فقط؛ لا تستورد `wave08` أيًّا منها.
- السقوط في `publish` نفسها، أي في إعداد كل اختبار، لا في أي ادّعاء مالي — ولهذا سقطت الأحد عشر معًا.

**الآلية (مقروءة من الشيفرة، ومؤكَّدة بنمط التقطّع):** ‏`test/wave08-cash-and-refunds.test.ts:31` كان يولّد `runId = randomUUID().slice(0, 8)` (ثمانية رموز hex قد تكون أرقامًا كلها، باحتمال ≈ ‏2% لكل تشغيل)، ثم يُدخله في عنوان المعروضة ووصفها (السطران 98-99). والحارس `findListingContactText` (`src/lib/listing-contact.ts:57-66`) يمرّر النص إلى `findPhoneNumbersInText` مع `defaultCountry` السوق ويرفض أي رقم صالح، فيسقط `publish` بـ400 وتسقط معه الاختبارات الأحد عشر. نمط «أربع خضر حول حمراء واحدة» يطابق تمامًا توليدًا عشوائيًا يصيب أحيانًا، لا تراجعًا في الشيفرة.

**الإصلاح المطبَّق (بذرة اختبار، لا شيفرة منتجّية):** صار الرمز بلا أرقام — `randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 8)` — على السنّة المتّبعة في الحزم التي تضع رمز تشغيل في نصّ يفحصه حارس التواصل (`ai-foundation-acceptance.test.ts:30`، `ai-foundation-02:36`، `bounded-multistep.test.ts:24`). الإصلاح **حتمي**: رمز بلا أرقام يستحيل أن يُقرأ رقم هاتف، فيُغلق صنف العطل كاملًا. أُبقي الرمز ASCII (حروف hex فقط، بلا بادئة عربية) لأنه يغذّي أيضًا مفاتيح عدم التكرار (السطر 32) و`proofToken` تسليم (السطر 598). الحارس المنتجّي لم يُمَسّ — سلوكه صحيح، والبذرة كانت مجرد رمز سيّئ الحظ. **وثبت الإصلاح:** عند `31f52c7` نجحت `wave08` منفردة (‏`pass 12 fail 0`، ‏`41861210735`) وداخل السلسلة التساعية على PG16 (`41861217793`) وPG18 (`41861224422`) بلا أي `LISTING_CONTACT_TEXT`. ومع أربع عينات خضر سابقة صار المجموع **سبع عينات خضر** حول الحمراء الواحدة، والإغلاق **حتمي** (رمز بلا أرقام يستحيل أن يُقرأ رقم هاتف) لا إحصائي فحسب.

## 6. العيب 5 — `G2-36B`: اختبار يعيد كتابة لقطة بنود الطلب التي يمنعها الترحيل 0056

| | |
|---|---|
| الموضع | `artifacts/api-server/test/g2-smart-conversation.test.ts:1702-1725` (قبل الإصلاح) |
| العطل | `_DrizzleQueryError … Order financial snapshot is immutable` (ERRCODE `55000`) |
| التشغيل | `41864496845` — PG16، سلسلة `d6-g2-negotiation`، عند `e76e6b0`؛ الفشل الوحيد في السلسلة |

**الحارس سليم والاختبار هو الخاطئ.** `0056_order_line_integrity.sql:141` يرفض أي `UPDATE` على `orders` يغيّر `NEW.data -> 'items'` (إضافة إلى الإجماليات والمشترِيات)، والسطران `:6` و`:15-29` يجعلان كل طلب جديد `order_line_integrity_version = 1` — أي أن كل طلب مُنشأ بعد الترحيل محميّ. الحزمة كانت تزوّر طلبًا «كاش فقط» بإعادة كتابة `items[].paymentMethods` **مرتين** على طلب مفاوض عليه مؤكَّد، وهذا بالضبط ما يمنعه الحارس.

**المنتج لا يخالف الحارس:** `persistPaymentMethod` ([`ai/buyer-turn.ts:1109-1116`](file:///D:/DINAR/dinar-sw1/artifacts/api-server/src/ai/buyer-turn.ts#L1109)) ينشر `order.data` ويضبط `selectedPaymentMethod` وحده؛ و`marketplace.ts:834` ينسخ `listing.paymentMethods` إلى `data.items` عند الإدراج فلا تعدّل بعده. السطور `:814` و`:831` في نفس الحزمة تُحدّث `orders.data` لكن بـ`selectedPaymentMethod` فقط، فتمرّ من الحارس.

**التأصيل أنه عيب مرشّح لا تراجع منّي:** عبارة `items` داخل الحارس أدخلها `f2f19f5`، وإجبار الإصدار 1 أدخله `0b81a57`، وكلاهما سلف لـ`ebdd2d7`، ولم يُحدَّث `G2-36B` في أيٍّ منهما. فالسلسلة حمراء على المرشّح قبل أي التزام لي.

**الإصلاح (`ff06650`، طبقة البذر وحدها):** وُلِّد طلب كاش-فقط من مسار الشراء الحقيقي بدل تزييفه: `publish(... paymentMethods:["CASH_DIRECT"] )` ⇒ `اشتريه` (مراجعة `ADD_TO_CART`) ⇒ `اطلبه` (عبور CONTINUE الذي يعيد تكوين المعلّق إلى `PLACE_ORDER`، `buyer-turn.ts:1296`) ⇒ `نعم` ⇒ `placedOrderTurn` ⇒ كتلة `surface:"ORDER"` التي وحدها يقرأها `orderInContext` (`:929-942`) عند `ادفع`. التأكيدات الأحد عشر بقيت كما هي، وحُذف ادّعاءان زائدان (إعادة `ادفع` على معلّق حيّ) واستُبدلا باختيار البطاقة مباشرة على المعلّق المفتوح للطلب المفاوض عليه، مع `assert.equal(cardChoice.surface,"PAYMENT_REVIEW")` بدل الاعتماد على إعادة تصيير.

**الإثبات لم يتحقق بعد:** تشغيلاه معلّقان (§8) — لا يُدرج هذا البند «مُصلَحًا» قبل ظهور `✔ G2-36B` و`LOCAL_SUITE_CHAIN … first_failed=none`.

---

## 7. حاجز خارجي جديد: فوترة GitHub Actions تُعطّل كل تشغيل جديد

الإرسالان المطلوبان لإثبات §6 (`41877578228` الحزمة منفردة، `41877681772` السلسلة) **لم يبدأ تشغيلهما**: الأول كان job واحدًا بلا خطوات، بدأ 17:26:32 وانتهى 17:26:34 (ثانيتان)، والثاني بقي job الـ`suite` فيه في `queued` بلا أوقات حتى وُسم الـrun بـ`failure`. النص الحرفي من annotations الـcheck-run:

```
The job was not started because recent account payments have failed or your
spending limit needs to be increased. Please check the 'Billing & plans'
section in your settings
```

ونقطة الوصول `user/settings/billing/actions` تُرجع 404 لهذا الـtoken (نطاق فوترة غير مُسنَد)، فلا يمكنني قراءة الرصيد أو تأكيد التجديد بنفسي.

**ما يعنيه هذا للمهمة:** لا يمكن تحريك أي دليل قبول جديد — لا G2-36B، ولا مقاسات محمولة إضافية، ولا إعادة تشغيل السلسلة الحمراء — قبل حلّ الفوترة أو انتظار دورة التجديد. كل ما في §1–§5 و§4 من أخضر قِيست قبل الحجب وتظل صالحة؛ و§6 يبقى «مُصلَح بالقراءة، غير مُثبَت بالتشغيل». لم أُخفِ هذا بتكرار الإرسال: الحجب حالَ دون بدء المهام مرتين متتاليتين بفارق دقيقة، وهو ما يكفي لتصنيفه حاجزًا مستقرًا لا عارضًا.


## 8. ما لم يُثبت بعد (آخر حالة)

- ~~السلسلة التساعية على **PG16** عند الرأس النهائي المجمّد~~ — **أُثبتت**: `41857672886` عند `e91e665` خضراء (‏`suites=9 … first_failed=none`)، والفرق إلى `9a57d62` هو ملف D17 وحده خارج التساعية (§4). التساعية خضراء الآن على PG16 وPG18.
- ~~`wave06-d17-memory` بعد إصلاح العيب 4~~ — **أُثبت**: `41859324605` عند `9a57d62` أخضر، ‏`✔ D17.8-R6`، ‏`trigramBytesPerMessage:296` (§2).
- ~~إثبات بذرة `wave08` المُصلَحة (§5-ب)~~ — **أُثبتت** عند `31f52c7`: منفردة `pass 12 fail 0` (`41861210735`) وداخل التساعية على PG16+PG18، بلا `LISTING_CONTACT_TEXT`. الإغلاق حتمي.
- الحواجز المحمولة من Wave-06 ما زالت مفتوحة: BL-07 (التعليق مقابل سلّم الموافقة) وBL-08 (‏`INFORMATION_ONLY` و`ELECTRONIC_PAYMENT` بلا أي موضع استدعاء)، وBL-01 يحتاج قرار تصميم عند فشل الإقلاع.
- ملاحظة G5 جديدة: لا `PATCH /account/market` ولا `SWITCH_MARKET` المحادثي يستشير بوابة التنشيط القانونية D16 (التصفّح محكوم بتوافر التجارة فقط). قرار للمالك، لا يُحسم في الكود بحسب `GUARDRAILS §E`.
- G2 بند إلغاء البث: لا `AbortController` في المسار (‏`Ai.tsx:1210` يمرّر `undefined`)، والخادم يرسل delta واحدة كاملة فلا يوجد ما يُلغى تدريجياً. القرار للمالك (§9.1 في تقرير G0)، ولا يُحسم في الكود بحسب `GUARDRAILS §E`.
- G3: **أُنجزت كجرد مشتقّ** في `docs/dinar-next/QODER_TEMP_PRINCIPAL_G3_WORKFLOWS.md` — لا يوجد في المستودع artifact يعدّد ثلاثة عشر بالضبط (الموجود 16 عقد عملية في `lib/api-zod/src/conversation-runtime.ts:1331-1431`، و10 سيناريوهات SC، وD1–D17، و25 موجّهًا في `src/routes/index.ts:28-55`)، فالقائمة مُشتقّة من سطح HTTP ومن طبقات الخدمة المستوردة، ومُعلَّنة على أنها مشتقّة لا منقولة. فراغان مقاسان فيها: سيرة المتعاقد (10) والمتجر الاشتراكي (12) غير قابلتين للإثبات على CI لأن حزمهما خارج Allowlist، وغياب مفتاح عدم التكرار في `routes/appeals.ts`.
- ~~G6: لم تُشغَّل رحلات المتصفح الحقيقية ولا مقاسات 390/320~~ — **أُثبتت ست رحلات متصفح حقيقية** عند `e76e6b0` (§4): reliability/accessibility/concurrency/recovery + envelope + d7-cart، كلٌّ بـ`exit=0 outbound=0` و`chromium=1`، وتغطي **320 و390 وسطح المكتب** (المواضع `w02u3-card-accessibility-browser-journey.test.ts:136` و`wave03-card-envelope-browser-journey.test.ts:50`). هذا `REAL_E2E` بحسب قاموس `GUARDRAILS` لا `API_ONLY`. المتبقي من G6: سلاسل `financial-waves-w07-w12c` و`integrated-nine-interleaved` و`business-cards-search-commerce` لم تُشغَّل عند `e76e6b0` (أخضرها موثّق عند `31f52c7`)، وحزم `block-f4-driver`/`pre-switch` خارج Allowlist أصلًا (تقرير G3 §2-أ).
- **إثبات العيب الخامس (§6) محجوب** بحاجز الفوترة (§7) ولا يمكن تحريره حتى تُفتح دقائق Actions.
