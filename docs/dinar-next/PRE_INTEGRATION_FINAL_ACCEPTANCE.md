# DINAR NEXT — القبول النهائي لما قبل التكامل

**التاريخ:** 2026-10-22 · **الأساس:** `79e9ca9` على `main` + تعديلات غير مُلتزمة في شجرة العمل (3 ملفات، انظر §3) · **المرجع:** `INDEPENDENT_PRE_INTEGRATION_VERIFICATION.md` (الحكم السابق: `NOT COMPLETED`)، `PRE_INTEGRATION_ENGINEERING_CLOSURE.md`، `DINAR_PRELAUNCH_RISK_AND_COMPLIANCE_MASTER_AUDIT_AR.md`.

**ما لم يحدث:** لا نشر، لا push، لا دفع حقيقي، لا نداء مزود AI مدفوع، لا هجرة على Railway أو أي قاعدة مُدارة، لا لمس لقاعدة Replit التطويرية (`helium`)، لا إعادة كتابة لتاريخ Git، لا تعديل أسرار.

## 1. الحكم النهائي

# PARTIALLY VERIFIED

- **مُتحقق هندسيًا:** كل مجموعات قاعدة البيانات المتعلقة بالمراحل 1–8 شُغّلت على PostgreSQL مؤقت معزول ونجحت، بما فيها `experience-upgrade` 14/14 بعد الجولة الثانية (§10)؛ قبول المتصفح الطرفي نجح على 11 عرضًا بعد إصلاح عيوب واجهة حقيقية.
- **غير مغلق:** (1) إبطال اعتماد GitHub التاريخي **OWNER ACTION REQUIRED** — بوابة الأمن تبقى مفتوحة؛ (2) لا تكامل حي لأي مزود (AI، فوترة، دفع، SMS، خرائط…) — كلها محاكاة أو غير موصولة عمدًا؛ (3) قرارات المالك المالية والقانونية (الأسعار، السقوف، الاحتفاظ، SLA). هذه عوائق خارجية، لا عيوب شيفرة محلية.
- لذلك لا يصح `VERIFIED-CLOSED`، ولا `BLOCKED` لأن كل العمل الهندسي القابل للتنفيذ محليًا اكتمل وتحقق.

## 2. بيئة الاختبار المعزولة

| البند | القيمة |
|---|---|
| الخادم | PostgreSQL 16.10 محلي، `initdb` جديد في مجلد مؤقت للجلسة، `127.0.0.1:55432` (و`55479` لاختبار الذاكرة الشخصية الذي يفرض هذا المنفذ) |
| القوالب | `dinar_test_closure`: هجرات `0000`–`0037` (38/38) عبر مُرحِّل drizzle + بذرة التطوير (`test/seed.ts`، أسواق JO/SA/KW نشطة) |
| العزل | قاعدة جديدة `dinar_test_<suite>` من القالب لكل مجموعة؛ متغيرات `PGHOST/PGUSER/PGPASSWORD/PGDATABASE/DATABASE_URL/REPL_ID` محذوفة من البيئة؛ `DINAR_DEV_DATABASE_URL` يشير للقاعدة المؤقتة فقط |
| الحراس | `acceptance-database-guard.mjs` (loopback + اسم `dinar_test_*`) و`safe-development-database.ts` (`BDINAR_DISPOSABLE_TEST_DATABASE=1`) — كلاهما قَبِل الهدف ورفض غيره (`test:db-guard` 8/8) |
| المزودون | مفاتيح `OPENAI/OPENROUTER/GROQ/AI_INTEGRATIONS_*/ANTHROPIC` محذوفة؛ `BDINAR_BLOCK_MODEL_CALLS=1` من `test/run.mjs` |

**ملاحظة إجرائية صادقة:** أول تشغيلين لـ`closure-ai-cost` فشلا (15 ثم 14 فشلًا) لأنني شغّلتهما على قاعدة غير مبذورة ثم على قالب لوّثه التشغيل الأول (`commercial_policies` بنسخ ثابتة 9001+). أُعيد بناء القالب نظيفًا وأُعيد التشغيل: 17/17. لم يُعدَّل الاختبار.

## 3. التغييرات المنفذة في هذه الجولة

| الملف | التغيير | السبب المُثبت |
|---|---|---|
| `artifacts/dinar/src/features/ai/ChatComposer.tsx:177-193` | إعادة قياس مربع الكتابة في `requestAnimationFrame` بدل داخل نداء `ResizeObserver`، مع إلغاء الإطار عند التفكيك | حلقة `ResizeObserver loop completed with undelivered notifications` عند ≤360px (ارتفاع `.ai-composer-box` يقفز 44→67 و67→144 في الإطار نفسه). في التطوير يحجب Replit runtime-error overlay كل النقرات؛ أفشل `frontend-closure` و`phase1`. كان مذكورًا كتحذير غير معالج في `FAIR_COMMERCE_REMEDIATION_ACCEPTANCE.md`. بعد الإصلاح: 0 أخطاء عند 390/360/320 |
| `artifacts/dinar/src/pages/AiChat.css` | أهداف لمس 40px: `.dinar-composer-mic` (38)، `.ai-message-action` (32)، `.ai-history-item-more` (34)، `.ai-context-toggle` (34)، `.ai-mobile-context-button` (38) | قاعدة القبول (≥39px) فشلت: «بدء التسجيل الصوتي 38×44»، «نسخ الرد 32×44»، «خيارات المحادثة 34×44» |
| `artifacts/dinar/test/frontend-closure-ui-acceptance.mjs` | **إضافة** تغطية متصفح لبطاقتي `CONTROL_NOTICE` (مركز الخصوصية) و`PRIVACY_EXPORT`؛ ثلاث مواءمات عقدية موثقة أدناه | المرحلة 8 كانت تفتقد تحقق المتصفح لبطاقات الخصوصية |

**مواءمات الاختبار مع العقد الحالي (ليست تليينًا):**
1. فحص «helper clipping» يُطبق الآن على المساعد المرئي فقط — `7791745` (2026-10-21) أخفى المساعد عمدًا داخل المحادثة على الجوال؛ العنصر المخفي لا يمكن أن يُقص، وكان `boundingBox()` يعيد `null`.
2. `ORDER_STATUS` بطلب واحد يفتح تفاصيل الطلب مباشرة منذ `564228b` (2026-10-15)؛ الاختبار (آخر تحديث 2026-10-14) كان ينتظر صفًا. صار يتحقق من التفاصيل **ومن غياب** الصف، ويبقي فحص الصفوف لـ`ORDERS_LIST`/`ORDER_SELECTOR`.
3. أُضيف الحقل المطلوب `earningsHistory: []` إلى تجهيزة `CourierCommissionAccount` (مطلوب في `lib/api-spec/openapi.yaml` منذ `564228b`)؛ غيابه كان يُسقط البطاقة.
4. خطأ وحدة التحكم 401 من `/api/account/privacy/exports` يُصنّف متوقعًا (مسار الفشل الذي يستدعيه الاختبار عمدًا)، محصورًا بهذا المسار فقط.

لم يُعدَّل أي اختبار API أو قاعدة بيانات، ولا أي قاعدة مالية أو عمولة (10%).

## 4. نتائج المراحل التسع

العدد = اختبارات `node:test` الفعلية (pass/fail/skip). كل مجموعات DB على قاعدة مؤقتة جديدة.

| # | المرحلة | الأدلة المنفذة الآن | النتيجة الهندسية | ما يبقى (خارجي) |
|---|---|---|---|---|
| 1 | الأمن | `security-acceptance` 12/0/0 · `api` 63/0/0 · `test:secrets` 1/0/0 · `test:db-guard` 8/0/0 · فحص التاريخ (§6) | **PASS هندسيًا — البوابة مفتوحة** | إبطال اعتماد GitHub (**OWNER ACTION REQUIRED**)، اختبار اختراق خارجي، CSP، تدوير `SESSION_SECRET` |
| 2 | الخصوصية | `closure-privacy` 11/0/0 · `wave3-acceptance` 11/0/0 · متصفح: بطاقتا الخصوصية (RTL، 1440/390/320، كلمة المرور لا تدخل أي دور محادثة ولا تُعرض، تنزيل، فشل آمن) | **PASS** | مدد الاحتفاظ والأسس القانونية، مهلة الرد، اتفاقيات المعالجين، تحقق هوية لمن فقد الوصول |
| 3 | تكلفة AI | `closure-ai-cost` 17/0/0 (حجز/تسوية، سقف عالمي متزامن بلا تجاوز، سقوف حساب/خطة، `SPEND_BUDGET_UNCONFIGURED`، `UNPRICED` لا يساوي صفرًا، مطابقة، حجوزات مهجورة، الصوت، الذاكرة الخلفية) · `next-g1-usage` 21/0/0 · `g1-provider` 39/0/0 (مع LOG_SCAN) | **PASS** | أسعار رسمية مؤرخة، السقوف ومبالغ الحجز، مصدر فواتير المزود الحقيقي (المطابقة مُختبرة بمصدر اختبار فقط) |
| 4 | Free/Go/Pro | `closure-integrations` 9/0/0 (503 دون مزود فوترة، webhook موقّع، 401 للتوقيع الخاطئ، تكرار، `AMOUNT_MISMATCH`، `PAST_DUE` بلا استحقاق) · `next-g1-usage` · `wave4-payment-acceptance` 1/0/0 | **PASS (محول محاكاة)** | لا مزود فوترة حي؛ الأسعار والضرائب والتجديد والاسترداد وMoR |
| 5 | AI عام | `ai-provider` 10/0/0 · `closure-ai-cost` C5-01 · `conversation` 28/0/0 · `conversation-router` 7/0/0 · `g2-smart-conversation` 91/0/0 | **PASS (نماذج محجوبة/محاكاة)** | لا نداء نموذج حي؛ اختيار المزود واتفاقية المعالجة واختبار حي بميزانية |
| 6 | محولات التكامل | `readiness` 11/0/0 · `market-capability-registry` 6/0 · `closure-integrations` · `listing-photo-vision-provider` 5/0/0 · `listing-image-policy-review` 11/0/0 | **PASS (لا شيء يُعلن موصولًا دون محول)** | اختيار كل مزود، العقود، sandbox، اختبار حي لكل عائلة |
| 7 | سوق عادل | `closure-integrations` (طعون، أدلة نزاع ثنائية، append-only) · `g2-smart-conversation` 91 · `next-g2-inquiry` 17/0/0 · `block-f1-seller` 14 · `block-f2-buyer` 14 · `block-f3-commerce` 17 · `phase2-commission-acceptance` 1 · `marketplace-intelligence` 20 · `commerce` 23 | **PASS** | SLA ومناوبة الدعم، أدلة الصور، سياسة الحسابات الموقوفة، حياد نص النموذج الحي بالعربية |
| 8 | التحكم من المحادثة | `universal-control-acceptance` 10/0/0 · `next-g3-acceptance` 14/0/0 · `g-final` 22/0/0 (مع LOG_SCAN) · `frontend-closure-ui-acceptance` PASS (196 فحصًا) · `experience-upgrade-acceptance` 14/0/0 (7 رحلات، 22 حالة تخطيط؛ §10) | **PASS** | — |
| 9 | القبول الشامل | هذا المستند؛ typecheck + build + كل ما سبق · `phase1-acceptance` 1/0/0 (رحلات سوق مستمرة + متصفح؛ فشل قبل إصلاح ResizeObserver ونجح بعده) · `personal-intelligence` 1/0/0 (قاعدة على `55479`) | **PARTIALLY VERIFIED** | البنود الخارجية أعلاه |

## 5. الأوامر والنتائج الدقيقة

**قاعدة البيانات المؤقتة (بيئة مشتركة لكل أوامر DB):**

```sh
env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE -u DATABASE_URL -u REPL_ID \
  DINAR_DEV_DATABASE_URL=postgres://dinar_test@127.0.0.1:55432/dinar_test_<suite> \
  DATABASE_URL=<نفس القيمة> BDINAR_DISPOSABLE_ACCEPTANCE_DB=1 BDINAR_DISPOSABLE_TEST_DATABASE=1 \
  env -u AI_INTEGRATIONS_OPENAI_API_KEY -u AI_INTEGRATIONS_OPENAI_BASE_URL -u OPENAI_API_KEY -u OPENROUTER_API_KEY -u GROQ_API_KEY \
  NODE_ENV=development <أعلام الاعتماد الخاصة بالمجموعة كما في package.json> node test/run.mjs <suite>
```

| الأمر / المجموعة (`artifacts/api-server`) | الأعلام | pass | fail | skip |
|---|---|---:|---:|---:|
| `closure-ai-cost.test` | `BDINAR_CLOSURE_ACCEPTANCE` + `PROMOTIONS` + `WAVE4` | 17 | 0 | 0 |
| `closure-privacy.test` | نفسها | 11 | 0 | 0 |
| `closure-integrations.test` | نفسها | 9 | 0 | 0 |
| `security-acceptance.test` (بعد `pnpm run build`) | `BDINAR_SECURITY_ACCEPTANCE` | 12 | 0 | 0 |
| `api.test` | `BDINAR_TEST_DATABASE` | 63 | 0 | 0 |
| `phase1-acceptance.test` | `BDINAR_PHASE1_ACCEPTANCE` | 1 | 0 | 0 |
| `phase2-commission-acceptance.test` | `BDINAR_PHASE2_ACCEPTANCE` | 1 | 0 | 0 |
| `wave3-acceptance.test` | `BDINAR_WAVE3_ACCEPTANCE` | 11 | 0 | 0 |
| `wave4-payment-acceptance.test` | `BDINAR_WAVE4_ACCEPTANCE` | 1 | 0 | 0 |
| `g1-provider.test` | `BDINAR_G1_ACCEPTANCE` + `BDINAR_LOG_SCAN=1` | 39 | 0 | 0 |
| `next-g1-usage.test` | `BDINAR_G1_ACCEPTANCE` | 21 | 0 | 0 |
| `next-g2-inquiry.test` | `BDINAR_G2_ACCEPTANCE` | 17 | 0 | 0 |
| `next-g3-acceptance.test` | `BDINAR_G3_ACCEPTANCE` | 14 | 0 | 0 |
| `g2-smart-conversation.test` | `BDINAR_G2_ACCEPTANCE` | 91 | 0 | 0 |
| `universal-control-acceptance.test` | `BDINAR_UCC_ACCEPTANCE` | 10 | 0 | 0 |
| `block-f1-seller.test` | `BDINAR_BLOCKF_ACCEPTANCE` | 14 | 0 | 0 |
| `block-f2-buyer.test` | `BDINAR_BLOCKF_ACCEPTANCE` | 14 | 0 | 0 |
| `block-f3-commerce.test` | `BDINAR_BLOCKF_ACCEPTANCE` + `WAVE4` | 17 | 0 | 0 |
| `experience-upgrade-acceptance.test` | `BDINAR_XP_ACCEPTANCE` | 14 | 0 | 0 |
| `g-final.test` | `BDINAR_GFINAL_ACCEPTANCE` + `BDINAR_LOG_SCAN=1` | 22 | 0 | 0 |
| `personal-intelligence.test` | `DINAR_PERSONAL_TEST_DATABASE_URL=…127.0.0.1:55479/dinar_test_personal` | 1 | 0 | 0 |

**مجموعات بلا قاعدة بيانات** (`node test/run.mjs <suite>`، نفس الحارس): `commerce` 23 · `conversation` 28 · `promotions` 6 · `location-policy` 1 · `marketplace-intelligence` 20 · `employment` 12 · `r5-delivery-economics` 3 · `conversation-router` 7 · `promotion-intent` 5 · `ai-provider` 10 · `market-capability-registry` 6 · `readiness` 11 · `listing-image-policy-review` 11 · `listing-photo-vision-provider` 5 · `database-url-selection` 5 — **كلها 0 فشل**. `node --test test/secret-scan.test.mjs` 1/0 · `node --test test/acceptance-database-guard.test.mjs` 8/0.

**المتصفح** (`artifacts/dinar`، Chromium `/repl/tools/bin/chromium`، Vite dev على `127.0.0.1:4173`):
- `node test/frontend-closure-ui-acceptance.mjs` → **PASS**، 196 فحصًا، العروض 320/360/390/414/650/800/1024/1100/1280/1440/1600 كلها PASS، العدادات (تجاوز أفقي، قص CTA، تداخل الكاتب، RTL مكسور، تسرب سر، تسرب ذاكرة بين حسابين، تسرب GPS) = 0. **الوضع `CONTRACT_FIXTURES`:** استجابات API تجهيزات محلية؛ لا يثبت سلطة الخادم.
- **نتيجة تاريخية فقط:** `node test/premium-ui-acceptance.mjs` فشل سابقًا لأنه يبحث عن `.dinar-chat-starters button` بعد انتقال الواجهة إلى `.ai-starters`. حُذف هذا الاختبار المتقادم لاحقًا؛ لا يوجد الملف في HEAD الحالي ولا ينبغي تشغيله. البدائل الحالية هي `frontend-closure-ui-acceptance.mjs` و`experience-upgrade-acceptance`.

**الكتابة النوعية والبناء** (جذر المستودع): `pnpm run typecheck` → exit 0 · `pnpm run build` → exit 0 (تحذير حجم الحزمة وتحذيرا sourcemap معروفان وغير مانعين) · `git diff --check` → نظيف.

## 6. الاعتماد التاريخي (GitHub)

فحص للقراءة فقط بنمطي `gh[pousr]_…` و`github_pat_…` عبر `git rev-list --all` (789 إيداعًا)، **دون طباعة القيمة** (عُدّت بصمات SHA-256 مقطوعة فقط):

- **قيمة واحدة مميزة** في الملف `.replit`، في **24 إيداعًا** من `f60e30d` (2026-10-16) إلى `3a89636` (2026-10-20). الإيداعات قابلة للوصول من `main` و`replit-agent` و`agent/pre-remediation-3a89636`.
- غير موجودة في `HEAD` ولا في `.replit` الحالي. لا وجود لها في `3c9e4b4` — وثيقة الإغلاق السابقة ذكرته خطأً وصُحّحت.
- **الإبطال غير مثبت.** الفحص «الرسمي» الوحيد المتاح محليًا هو استخدام الرمز نفسه ضد GitHub API، وهذا استعمال لاعتماد مسرّب؛ لم أفعله. **OWNER ACTION REQUIRED:** إبطال الرمز من GitHub → Settings → Developer settings (أو عبر GitHub credential revocation API)، وتأكيد ذلك كتابيًا، ثم قرار مستقل بشأن تنظيف التاريخ **قبل أي push** (الفروع الحالية تحمله). `origin` الحالي placeholder (`USERNAME/REPOSITORY`)؛ لم يُتحقق هل دُفع التاريخ سابقًا إلى GitHub.

## 7. التبعيات الخارجية والعوائق المتبقية

| العائق | النوع | المالك |
|---|---|---|
| إبطال اعتماد GitHub + قرار تنظيف التاريخ | أمن | المالك |
| مزود AI ونموذجه، اتفاقية المعالجة، الأسعار والسقوف النقدية، مصدر الفواتير | تجاري/قانوني | المالك |
| مزود فوترة مرخص/MoR، أسعار Free/Go/Pro، الضرائب، التجديد والاسترداد | تجاري/قانوني | المالك |
| SMS، البريد، الإشعارات، الخرائط، التوصيل، المراقبة | تكامل | المالك + مزود |
| مدد الاحتفاظ، مهلة الرد، مسؤول الخصوصية، SLA الدعم والطعون | قانوني/تشغيلي | المالك + مستشار |
| اختبار اختراق خارجي، مراجعة CSP | أمن | طرف ثالث |
| النسخ والاستعادة في Railway | تشغيلي | المالك |
| `premium-ui-acceptance.mjs` المتقادمة | **مغلق محليًا**؛ حُذفت، والنتيجة السابقة أعلاه تاريخية | — |

## 8. مراجع الشيفرة

- محاسبة الإنفاق: `artifacts/api-server/src/lib/ai-spend.ts`، `src/lib/ai-usage.ts`، `src/lib/ai-usage-policy.ts`
- الخصوصية: `src/lib/privacy-rights.ts`، `src/routes/privacy.ts`، `src/ai/privacy-turn.ts`
- الاشتراكات: `src/lib/subscription-billing.ts`، `src/routes/integrations.ts`
- البوابة: `src/ai/model-gateway.ts`، `src/ai/model-turn.ts`
- الطعون: `src/lib/trust-appeals.ts`، `src/routes/appeals.ts`
- الواجهة: `artifacts/dinar/src/features/ai/ControlSurface.tsx`، `ChatComposer.tsx`، `src/pages/AiChat.css`
- المخطط والهجرة: `lib/db/src/schema/index.ts`، `lib/db/drizzle/0037_pre_integration_closure.sql` (16 فهرسًا، triggers append-only على `privacy_consent_events` و`privacy_request_events` و`trust_appeal_events` — مُختبرة بالرفض في `closure-privacy`/`closure-integrations`)

## 9. مراجعة Git

- الجولة الأولى: `0290ff7` — `Close pre-integration acceptance on a disposable database` (محلي، لا push).
- الجولة الثانية: انظر §10. لم يُنفذ push ولا نشر.

## 10. الجولة الثانية — `experience-upgrade` وخطة ترحيل النسخة

### `experience-upgrade` (التصميم المعتمد هو المرجع)

التصميم الحالي المعتمد ثُبّت بإيداعات مقصودة مع صور مرجعية في `attached_assets/` (`4ed2b01`، `a1968b6`، `7de0abf`): لا شريط علوي على الجوال؛ زر عائم واحد للشريط الجانبي عند بداية السطر (يمين في RTL)؛ «محادثة جديدة» والسجل داخل الدرج؛ مؤشر التفكير هو شعار DINAR المتحرك (`f9888c0`) بدل النقاط.

**تراجعات حقيقية أُصلحت (`artifacts/dinar/src/pages/AiChat.css`):**
1. **سياق البحث غير قابل للوصول على الجوال والأجهزة اللوحية:** زر فتحه كان في الشريط العلوي المحذوف (`4ed2b01`)، والبديل `.ai-context-launch` كان `display:none` تحت 1024px. صار ظاهرًا تحت 1350px في صف مستقل، بهدف لمس 40px. أُضيف اختبار متصفح في `frontend-closure-ui-acceptance.mjs` (390/320: يظهر، ≥40px، يفتح `#ai-context-drawer`، Escape يغلقه).
2. **بداية «خطط معي» لا تصل إلى الشاشة عند 360/375:** `scroll-snap` بمحاذاة `start` في RTL كان يعيد الصف بعد `scrollIntoView` (ومنه تركيز لوحة المفاتيح) فيبقى الزر مقصوصًا (left=-52). أُزيل الالتقاط؛ الصف يبقى قابلًا للسحب. قياس بعد الإصلاح: كل البدايات الست تصل عند 320/360/375.

**عرض الشيفرة والمحادثة:** لا تراجع. فشل «كتلة الشيفرة» في الجولة الأولى كان متتاليًا من فشل سابق في الرحلة نفسها؛ بعد المواءمة نجحت: الشيفرة LTR داخل محادثة RTL، الجدول العريض يتمرر داخل حاويته، لا markup قابل للتنفيذ، الرد يُعاد بناؤه بعد إعادة التحميل، والمسودة تُستأنف في المحادثة العامة الواحدة.

**مواءمات الاختبار (`artifacts/dinar/test/experience-upgrade-browser.mjs`) — فقط حيث ثبت أن السلوك مقصود:**
- الشريط العلوي → لا شريط علوي؛ زر الشريط الجانبي العائم ظاهر، ≥44px، مسمّى، عند حافة البداية، لا يغطي البدايات، ومخفي على سطح المكتب.
- «محادثة جديدة» في الترويسة → لا «محادثة جديدة» على الشاشة الفارغة؛ زر الدرج يبقى متاحًا أثناء المحادثة؛ وجود «محادثة جديدة» داخل الدرج مُختبر في `drawer-390` دون تغيير.
- نقاط الكتابة → شعار التفكير؛ يبقى شرط احترام `prefers-reduced-motion` كما هو.
- فحص أهداف 40px يشمل الآن زر الشريط الجانبي وأزرار الكاتب.

لم يُخفف فحص السحب الذي كشف التراجع الثاني.

**النتيجة:** `experience-upgrade-acceptance` **14/0/0** — الرحلات السبع PASS، 22 حالة تخطيط (11 عرضًا × فاتح/داكن)، 0 أخطاء وحدة تحكم.

### `0037` و`migrate-clone.mjs`

- **مراجعة `0037`:** جداول وفهارس وtriggers append-only جديدة؛ استبدال قيدي `CHECK` (`ai_usage_*_resource_valid`) بنسختين أوسع تضيفان `AUDIO_TRANSCRIPTION`. لا حذف لجدول أو عمود ولا إعادة كتابة صفوف. `0028`–`0036` لم تتغير منذ خط الأساس السابق `3632b8f`.
- **الحارس:** `lib/db/src/clone-migration-guard.ts` يثبت `REVIEWED_PENDING_MIGRATIONS` (العشر `0028`–`0037` بالاسم وSHA-256)، و`assertCloneMigrationJournal` يرفض أي طول غير 38 أو أي ترحيل مُضاف/معدّل/معاد تسميته. `lib/db/scripts/migrate-clone.mjs` يتحقق من ذلك **قبل** فتح أي اتصال، ويبقي فحص الدفتر الدقيق (28) والهوية وTLS كما هي.
- **اختبارات:** `development-tls.test` 7/0/1 (التخطي الوحيد هو فحص TLS الحي لـRailway، مقصود). الاختبار الجديد يقرأ الملفات الحقيقية ويثبت رفض 37 و39 إدخالًا، وتعديل `0037`، وإعادة تسمية `0030`.
- **بروفة محلية (ليست Railway):** قاعدة loopback مؤقتة رُحّلت إلى `0036` وبُذرت (6 مستخدمين، 249 سوقًا، عدادات استخدام)، ثم طُبّقت `0037`: لا فقد بيانات، التشغيل الثاني بلا أثر (38)، `AUDIO_TRANSCRIPTION` مقبول وقيمة مجهولة مرفوضة.
- **لم يُنفذ أي ترحيل على Railway.** التوثيق: `docs/dinar-next/CLONE_TLS_SAFE_REHEARSAL.md`.

### إعادة الاختبارات بعد الجولة الثانية

| المجموعة | pass/fail/skip |
|---|---|
| `experience-upgrade-acceptance` | 14/0/0 |
| `frontend-closure-ui-acceptance` (متصفح) | PASS |
| `phase1-acceptance` | 1/0/0 |
| `universal-control-acceptance` | 10/0/0 |
| `next-g3-acceptance` | 14/0/0 |
| `g-final` (LOG_SCAN) | 22/0/0 |
| `security-acceptance` | 12/0/0 |
| `closure-ai-cost` / `closure-privacy` / `closure-integrations` | 17/0/0 · 11/0/0 · 9/0/0 |
| `development-tls` | 7/0/1 |
| `pnpm run typecheck` / `pnpm run build` | exit 0 / exit 0 |

### الحكم بعد الجولة الثانية

# PARTIALLY VERIFIED

العمل الهندسي المحلي مكتمل ومُتحقق، بما فيه المرحلة 8. ما يمنع `VERIFIED-CLOSED` خارجي فقط: إبطال اعتماد GitHub التاريخي (**OWNER ACTION REQUIRED** — لم يُستخدم الرمز ولا يُدّعى إبطاله)، وغياب أي تكامل حي، وقرارات المالك المالية والقانونية.
