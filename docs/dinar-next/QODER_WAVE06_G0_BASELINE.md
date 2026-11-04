# QODER WAVE 06 — تقرير الأساس G0 (فحص المصادر قبل أي تعديل)

> **preserve note:** Wave-06's own G0, describing the wave06b input tree at `11d7fbe`. Kept for traceability.
> It is **not** the baseline for the six-wave candidate; see `QODER_TEMP_PRINCIPAL_G0_BASELINE.md`.

**المهمة:** D16 الامتثال القانوني والخصوصي + D17 ذاكرة المحادثة طويلة المدى.
**الفرع المعزول:** `qoder/wave06-d16-d17-closure` (محليًا على `11d7fbe`؛ لا يوجد فرع remote بنفس الاسم بعد).
**شجرة العمل:** `D:\DINAR\dinar-w06` — نظيفة (`git status --porcelain` فارغ)، منشأة من `11d7fbe` حسب reflogها، ولا تشارك شجرة أي وكيل آخر.
**قاعدة القراءة فقط لفرع D16:** `D:\DINAR\dinar-w06-d16` (detached عند `c196a9b`، نظيفة، لا كتابة عليها).

لا دمج إلى `main` أو إلى الفرع القانوني، لا نشر، لا ترحيلات بعيدة، لا بيانات إنتاجية، لا استدعاءات مزود مدفوعة.

---

## 1. المراجع بالأرقام الكاملة

| المرجع | SHA | الحالة بالنسبة إلى القانوني |
|---|---|---|
| `replit/dinar-next-complete-development` (القانوني) | `11d7fbe3326897924468ee4c6d5467972a92b973` | الرأس. «docs(ai): record AI-FOUNDATION-01 gate evidence at c36e6f1» |
| `replit/d16-legal-privacy-compliance` | `c196a9bf892547322644540a5d03c338020581da` | أمامه commit واحد، وخلفه 5 commits (`merge-base` = `5d9bca1`) |
| `qoder/wave02-d4-d6-closure` | `845b0a48cfa7a726c97be75a00ed76fd8db5afca` | مصدر التصادم `0051_order_multi_item_money` |
| `qoder/wave04-d10-d12-closure` | `fd8215e8af4cf55e9f653c94cbc9105111e354eb` | **ليس** سلفًا للقانوني بعد |
| `qoder/wave05-d13-d15-closure` (وكيل متوازٍ) | `34437a9262f006ffbbe7953ab4b81b0873a599fe` | يعمل بالتوازي؛ تداخل ملفات (§6) |
| فرع Wave 06 | لا يوجد بعد | سيُنشأ عند أول دفع |

الـ5 التي تقدّم بها القانوني على أساس D16 كلها في طبقة الذكاء (`capability-registry.ts`، `conversation-runtime.ts`، `smart-turn.ts`، `tool-registry.ts`، `routes/ai.ts` ±سطر، `ai-foundation-acceptance.test.ts`، workflow، docs). **لا شيء منها يمس `lib/db` ولا `lib/api-spec` ولا المولّدات** — لذلك حمل كود D16 فوق القانوني لا يصطدم بتلك التغييرات (المستثنى ملف اختبار واحد للبيئة الآمنة، §5.3).

---

## 2. القواعد والتعليمات الملزمة (تمت قراءتها)

- `AGENTS.md` — ترتيب القراءة، فرع واحد لكل مهمة، لا `main`/دمج/force-push/نشر/نموذج مدفوع/قاعدة غير loopback.
- `CLAUDE.md` — الثوابت: الأسعار والسلطة من حالة الخادم؛ لا إنشاء طلبات أو مدفوعات من مخرجات النموذج؛ أجسام JSON محدودة؛ التغيير في المخطط = migration جديدة مسجّلة في `release-manifest.json` و`REVIEWED_PENDING_MIGRATIONS` و`development-tls.test.ts` ووسم الرأس في `readiness.test.ts`. قواعد البيئة: `BDINAR_DISPOSABLE_ACCEPTANCE_DB=1` + اسم قاعدة `dinar_(test|acceptance|wave<n>|migration)_*`، لا مفاتيح حقيقية، `test/run.mjs` يجرّد مفاتيح المزودات.
- `docs/qoder/GUARDRAILS.md` — §A.6 «النموذج بلا سلطة» و`ai-authority-boundary.test.ts` يجب أن يمر **دون تعديل**؛ §B قواعد العربية العامة بلا أسماء علامات؛ §C الأحمر أولًا ولا تُضعف أي assertion؛ دليل المتصفح = حزمة متصفح فعلية لا `API_ONLY`؛ §E قرارات المالك لا تُحسم في الكود.

ذا يعني لـD17 عمليًا: أي «ذاكرة» جديدة **سياق غير موثوق** لا سلطة له، وأي مسار استرجاع يجب أن يبقى محدودًا بفهارس وحده عليا، ولا يُضعف أي اختبار سلطة قائم ليخضر.

---

## 3. مصفوفة ملكية التنفيذ

| المجال | المالك الفعلي للمنفَّذ | ما سيضيفه Wave 06 | ما لن يفعله Wave 06 |
|---|---|---|---|
| بوابات صلاحيات السوق التسع | **Replit** (`c196a9b`: `d16-readiness.ts`) | توثيق التصنيف + اختبار القبول D16.6 فوق منفَّذ Replit | إعادة بناء أو تعديل دلالة البوابة |
| مقدمة القانون القطرية (JO/KW/SA)، الأدلة، فاصل الأدوار | **Replit** (`country-legal-readiness.ts` 976 سطرًا) | اختبار: لا تتجاوز أيًا من الحواجز | تغيير قواعد الموافقة |
| سجل حوادث الأمن والخصوصية (append-only) | **Replit** (`security-incidents.ts`) | اختبار منع التعديل/الحذف + تسلسل المراحل | إضافة إشعارات قانونية تلقائية |
| واجهة إدارة الجاهزية القانونية + متصفح | **Replit** (`AdminLegalReadiness.tsx` 1804، `d16-country-legal-browser.mjs`) | تشغيل الدليل في CI كإثبات | إعادة تصميم الواجهة |
| KYC: الرفع الموقعي، الحظر، الاحتفاظ 365 | **القانوني** (`business-profiles.ts`) | سدّ ثغرات موثّقة (§5.1) باختبارات حمراء أولًا | حذف أي وثيقة حقيقية؛ تغيير 365 بصمت |
| حقوق الخصوصية: الوصول/التصدير/الحذف/الموافقات | **القانوني** (`privacy-rights.ts`) | اختبار تسرّب البيانات الحساسة في التصدير والسجلات | تغيير مدة الاحتفاظ أو سياسة الحذف |
| ذاكرة الشخص `personal_memories` | **القانوني** (`PersonalContextService`) | توسيع داخل نفس السلطة (موجزات + استرجاع تاريخي محدود) | تشغيل ذاكرة مستقل أو قاعدة محادثة ثانية |
| سياق النموذج و`messages` | **القانوني** + Wave 04 | استرجاع تاريخي محدود بمالك + فهرس + EXPLAIN | تكرار مشغّل أدوات Wave 04 |
| أرقام الترحيلات الموحّدة | **Replit قرارًا** | اقتراح + تسلسل مُختبَر على PG16/18 + القيود | تطبيق على Railway؛ اعتبار القرار نهائيًا |
| Wave 05 (D13–D15) | **وكيل متوازٍ** | لا شيء | لا تعديل ملفات §6 المتداخلة دون ضرورة |

---

## 4. D16 — التصنيف الأولي (من قراءة `c196a9b`، لا من إعادة بناء)

| الميزة | التصنيف | الدليل من الشيفرة |
|---|---|---|
| تسع صلاحيات سوق: `INFORMATION_ONLY`/`BROWSING`/`LISTING_PUBLICATION`/`TRANSACTIONS`/`CASH_PAYMENT`/`ELECTRONIC_PAYMENT`/`BUSINESS_ONBOARDING`/`DELIVERY_OPERATIONS`/`RESTRICTED_CATEGORIES` | EXISTING_AND_VERIFIED | `MARKET_LEGAL_CAPABILITIES` + `assertMarketLegalCapability`؛ غياب السجل أو حالة ≠ `ENABLED` → 409 `MARKET_CAPABILITY_NOT_ENABLED` |
| الفشل المغلق حسب البيئة | EXISTING_AND_VERIFIED | `marketLegalGateEnforced`: `staging`/`production`/أي بيئة غير معروفة = مفروضة؛ الإعفاء صريح لـ`development`/`test` فقط |
| ربط الحواجز بالمسارات | EXISTING_AND_VERIFIED | `GET /listings` و`/listings/:id` و`searchMarketplaceListings` → BROWSING؛ `assertMarketPolicy` → LISTING_PUBLICATION + RESTRICTED_CATEGORIES؛ `checkout` → TRANSACTIONS + CASH_PAYMENT + DELIVERY_OPERATIONS عند وجود توصيل؛ `POST /business/profiles` والنشر → BUSINESS_ONBOARDING |
| فصل مراجعة المستشار عن موافقة المالك | EXISTING_AND_VERIFIED — **needs env config** | `enableMarketCapability` يشترط `DINAR_LEGAL_OWNER_IDS`، وحالة `OWNER_APPROVAL_REQUIRED` أولًا، ويرفض `counselReviewedBy === actorId` |
| سجل قرارات إلحاقي + منع التعديل | EXISTING_AND_VERIFIED (من الترحيل) | `market_legal_capability_events` + قيود 0052/`security_incident_events`append-only |
| الحوادث: فتح/احتواء/تعافٍ/إغلاق | EXISTING_AND_VERIFIED | `transitionSecurityIncident` + مراحله؛ لا إغلاق قبل الاحتواء والتعافي |
| جرد حالة السوق العام | EXISTING_AND_VERIFIED | `assertCountryActivationReady` + `activationStatus='ACTIVE'`؛ الإيقاف يبقي التاريخ مقروءًا |
| توثيق المراجعة القانونية لكل دولة | **BLOCKED_BY_LEGAL_DECISION** | لا محامٍ راجع؛ `legallyReviewed:false` صريح في سياسة وثائق الأنشطة؛ التقرير العربي لـReplit ينصّ ذلك |
| تحديد الكيان/التراخيص لكل دولة | BLOCKED_BY_LEGAL_DECISION | `docs/legal/COUNSEL_REVIEW_PACKAGE.md` ينتظر القرار |
| تعيين معرّفات المراجع والمالك تشغيليًا | MISSING (config، لا كود) | القوائم البيئية فارغة في الفرع؛ لا يجب وضعها في المستودع |
| إشعارات الجهات/العملاء القانونية | MISSING — مقصود | لا إرسال تلقائي؛ مهلة الإخطار غير معرّفة |
| مدة احتفاظ موحّدة + تنفيذ الحذف | EXISTING_INCOMPLETE | `retainUntil` يُكتب عند القرار **ولا يوجد أي منفّذ** يقرأه (grep: موضعان للكتابة فقط)؛ ولا worker |
| حجر KYC للملفات غير المفحوصة | EXISTING_INCOMPLETE — **ثغرة موثّقة** | لا ماسح مسجّل ⇒ كل الملفات `NOT_SCANNED`؛ و`requirementState` يعتبرها صالحة لأنها فقط `!== "INFECTED"` → المسار fail-open فعليًا (§5.1) |
| مصفوفة الصلاحيات القانونية مقابل مصفوفة مزوّدي السوق | EXISTING_AND_VERIFIED، بمنفذين منفصلين | `market-capability-registry.ts` (دفع نقدي/إلكتروني/توصيل/مزودات) و`d16-readiness.ts` (بوابة قانونية) — يجب توثيق أيهما يقرّر أي سطر للعامة |
| خصوصية: موافقات، إصدارات سياسات، طلبات وصول/تصدير/حذف، تراجع | EXISTING (قانوني) — يحتاج تدقيق تسرّب | `privacy-rights.ts` (سجل طلب، تصدير محدود بـ500 مع علامة بتر، سحب)، `policy-lifecycle.ts`، `integration-policy-consent.test` |

---

## 5. D17 — الموجود فعليًا والفجوات

### 5.1 موجود ويُعاد استخدامه (لا بناء ثانٍ)

- **السلطة:** `PersonalContextService` («The sole memory authority. Identity is supplied by the authenticated runtime, never AI») مع ثمانية أنواع، تطبيع موضوعات وأبواب/أبناء،`tombstone` للنسيان، أحداث إثبات، قفل استشاري لكل مالك (`pg_advisory_xact_lock(hashtextended(userId,771))`)، ومكافأة ثقة متناقصة (0.18 بداية، سقف 0.9، صريح 0.98).
- **الجدول:** `0027_personal_intelligence.sql` + `personal_memories` / `personal_memory_events` / `personal_memory_controls` بمفاتيح ومقيدات CHECK في `lib/db/src/schema/index.ts`.
- **السياق:** `getRelevantContext(userId, query, conversationId?)` → حتى 6 سجلات، سبب عربي (`تفضيل صرحت به` / `موضوع تكرر في تفاعلاتك` / `موضوع حديث، وليس تفضيلًا مؤكدًا`)، ويُمرّ إلى `smart-turn.ts:964` فقط (وبلا ذاكرة لموظف البائع).
- **النموذج غير الموثوق:** `extractAmbiguousTopics` عبر `proposeThroughGateway` بسباق 1500ms، سقف وسائط 3000 حرف، `AIEnvelope` صارم ≤6 مرشحين، مرشّحات `INFERRED_INTERESTS` فقط، ونص النظام يمنح الفئات الحساسة.
- **التاريخ الحديث:** `model-turn.ts` حدود ثابتة `HISTORY_TURNS=10`، `HISTORY_ENTRY_CHARS=1200`، `MAX_HISTORY_CHARS=9000`، `HISTORY_SCAN_ROWS=40`.
- **الاستعادة:** `GET` تاريخ المحادثة يعيد البناء من حالة الخادم الحية (`commerce-turn.ts:412`، `employment-turn.ts:1372`، `delivery-turn.ts:335`)؛ الحذف `DELETE /ai/conversations/:id` transaction مع `FOR UPDATE`.
- **سلطة Wave 04:** سجل صلاحيات 15 قدرة، حارس الادعاء وحارس السلطة في `action-receipts.ts`، `RECORDED_AMOUNT_KEY` — لا نكرّرها.

### 5.2 فجوات D17 (ما يجب بناؤه)

| البند | الحالة اليوم | المطلوب |
|---|---|---|
| استرجاع تاريخي عبر كل محادثات المالك | **MISSING** — لا يوجد بحث في `messages` إطلاقًا (`grep to_tsvector/websearch_to_tsquery` = صفر في `src` و`lib/db`) | استرجاع محدود بمالك أولًا، ترتيب ثابت، حدّ أعلى، مهلة، Arabic lexical |
| موجزات محادثة دائمة | **MISSING** — لا عمود/جدول موجز للمحادثات | جدول مشتَرط موسوم `DERIVED_SUMMARY` مع مراجع رسائل وبطلان عند التغيير |
| بطلان الذاكرة بعد الحذف/التعديل | **EXISTING_INCOMPLETE** — حذف المحادثة يمسح `messages` و`conversations` لكنه لا يمسّ `personal_memories.conversationId` ولا يترك حدث تقاعد | إبطال محصور بمحادثة واحدة دون المساس بالتفضيلات الصريحة |
| الحاضر مقابل التاريخي | جزئي (`RECENT_CONTEXT`/`LONG_TERM_FACTS` + أنصاف أعمار) | تمييز صريح في الاسترجاع مع منع ادعاء الحاضر من سجل قديم |
| حدود استرجاع وأمان | محدود في الذاكرة، غير محدود في `messages` (لا فهرس بحث) | فهارس + LIMIT + EXPLAIN كدليل + منع تحميل جدول كامل |
| العزل | `ownsInteraction` صحيح الاتجاه؛ لا بوابة بلد/خصوصية على الاسترجاع | اختبارات مستخدم/أعمال/موظف/بلد + تصدير آمن |
| القبول الوظيفي/الهجومي | حزمة واحدة `personal-intelligence.test` (اختبار واحد، 201 سطر) | ≥30 وظيفيًا و≥30 هجوميًا في CI على PG16/18 |
| المقاييس | غير مقاسة | 100 / 1,000 / 10,000 رسالة اصطناعية + زمن + خطط تنفيذ + قراءة/كتابة متزامنة |

### 5.3 ملاحظات بيئية

- `d16-readiness.test` و`personal-intelligence.test` **غير مسجّلتين** في allowlist الخاص بـ`workflow_dispatch` على القانوني؛ يجب إضافتهما (وفحزم Wave 06) في فرعنا المعزول.
- `test/safe-development-database.ts` لمسه القانوني (+3) وD16 (+2): أي حمل لـD16 يحتاج دمجه يدويًا في ذلك الملف فقط.

---

## 6. تصادم الترحيل 0051 (تحليل أولي)

| الفرع | idx | الوسم | `when` |
|---|---|---|---|
| القانوني | 50 | `0050_normal_nico_minoru` | 1793606821612 |
| wave02 | **51** | `0051_order_multi_item_money` | **1793610000000** |
| D16 | **51** | `0051_d16_legal_readiness_incidents` | 1793652284062 |
| D16 | 52 | `0052_d16_readiness_constraints` | 1793652499958 |
| D16 | 53 | `0053_d16_country_legal_intake` | 1793655028987 |

- **لا تصادم دلالي:** `0051_order_multi_item_money` يعدّل قيدًا واحدًا على `orders` (`order_money_valid`)؛ D16 ينشئ 8 جداول قانونية/حوادث جديدة بالكامل. لا جدول مشترك ولا قيد مشترك.
- **التصادم ترقيمي فقط** (كلاهما `idx 51`)، وحلّه الآمن هو إعادة ترقيم بإزاحة D16 واحدًا للأمام، مرتّبًا حسب زمن الإنشاء:
  `0051_order_multi_item_money` → `0052_d16_legal_readiness_incidents` → `0053_d16_readiness_constraints` → `0054_d16_country_legal_intake`.
- يعتمد ذلك على: إعادة تسمية ملفات `drizzle/*.sql` و`meta/00XX_snapshot.json` و`_journal.json` (السلاسل الداخلية `id/prevId` لا تحمل الرقم)، و`release-manifest.json` (sha256 جديد للوسوم)، و`REVIEWED_PENDING_MIGRATIONS`، وعدد `EXPECTED_JOURNAL_ENTRIES`، والوسوم المتوقعة في `development-tls.test.ts` و`readiness.test.ts`.
- **قرار التوحيد النهائي لـReplit.** ما نلتزم به هنا: تسلسل مُختبَر على PG16 وPG18 + تقرير، ولا تطبيق على أي قاعدة مُدارة.
- لن نُدّعي قبول ترحيل موحّد إلا إذا اختُبر التسلسل الموحّد نفسه فعليًا (§8 من تقرير final).

---

## 7. تداخل العمل المتوازي (مخاطر)

`qoder/wave05-d13-d15-closure` (`34437a9`) لمس: `routes/ai.ts`، `src/ai/action-receipts.ts`، `src/lib/marketplace-search-index.ts`، `test/safe-development-database.ts`، `.github/workflows/qoder-api-suite.yml`، `lib/db/src/index.ts`، وثلاثة اختبارات wave05.
تراكبنا المتوقع: `routes/ai.ts` (لاستدعاء الإبطال عند الحذف) وworkflow (سماح list الاختبارات). سنُبقي تلك التعديلات إضافية صغيرة، ونوثّق كل تداخل في التقرير النهائي. لا نلمس شجرة أي وكيل آخر ولا نفرض دمجًا.

---

## 8. خطة Wave 06 (TRACE → REUSE → IMPLEMENT → PROVE → REGRESSION → COMMIT → PUSH → REPORT → STOP)

1. حمل كود D16 كما هو من `c196a9b` إلى فرعنا المعزول (لا إعادة كتابة)، وحلّ تصادم الأرقام بالتسلسل الموحّد في §6، مع كل قيود السجل/الحماية.
2. اختبارات قبول D16.6 للنقاط غير المغطّاة، وأحمر-أولًا لثغرتين موثّقتين: حجر `NOT_SCANNED` و`retainUntil` بلا منفّذ (الحذف التدميري يبقى معطّلًا).
3. D17: توسيع `PersonalContextService` (موجزات دائمة + استرجاع تاريخي محدود بمالك + إبطال عند الحذف/التعديل) بترحيل واحد مقيد ومُعلَّم كما تتطلب `CLAUDE.md`، بلا مشغّل ذاكرة ثانٍ وبلا اعتماد على مزود تضمين مدفوع.
4. ≥30 وظيفيًا و≥30 هجوميًا + مقاييس 100/1k/10k مع EXPLAIN على PG16 وPG18.
5. سلاسل تراجع الموجات 01–03 و04 وAI-F02 وD4/D5 وD6 والسلة والدفع والبلدان والخصوصية + متصفح Chromium لاستعادة المحادثة.
6. `docs/dinar-next/QODER_WAVE06_D16_D17_REPORT.md` ثم دفع الفرع المعزول والتوقف.
