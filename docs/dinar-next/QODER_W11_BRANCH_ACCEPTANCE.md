# DINAR NEXT — W11: قبول الفرع المستقل (Branch Acceptance)

**النوع:** قبول فرع مستقل — **ليس** شهادة إصدار، وليس نشرًا، وليس تفعيلًا تجاريًا.
**الفرع:** `qoder/parallel-w07-w12-ultra`
**رأس الفرع عند القبول:** `9ae637c91944d716503b1ca992e4e016ea18692a`
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873`
**المستودع المحلي:** `D:\DINAR\dinar-w0712`
**التاريخ:** 2026-10-31

> **قاعدة الصدق:** في هذه الموجة لا اختبار تشغيل واحد نُفّذ: المضيف بلا `node`، وبلا `pnpm` فعال، وبلا PostgreSQL، وبلا `node_modules`، والفرع كان غير مدفوع. كل ما دون «مقبول» هنا هو فحص بنيوي (SHA، نطاق، هاشات، عدّاد اختبارات، مسح SQL).
>
> **تحديث 2026-10-31 (بعد إذن المالك):** دُفع الفرع ونُفِّذت كل بوابات التشغيل في CI المعزول. الحالة التشغيلية لم تعد BLOCKED؛ الأدلة الكاملة وروابط التشغيل في `QODER_W12_INTEGRATION_HANDOFF.md` §3. رأس الفرع النهائي المدقق عن بُعد: `7b115dc015b0a390fb8bdd3040d21ac8e7137abe`.
>
> **تحديث W12.1 (2026-10-31):** رأس الشيفرة المُختبَر صار `6b702ae` (مجموعة تقوية معزولة `wave07-w12-contract-hardening` ومدخلات سماح؛ لا تغيير إنتاجي). إعادة التحقق الكاملة على `6b702ae` في `QODER_W12_1_PRE_INTEGRATION_HARDENING.md` §9 و`QODER_W12_INTEGRATION_HANDOFF.md` §3.3. SHA أعلاه تاريخي وصحيح لحظة W11/W12.

---

## 1. الحكم

| البُعد | الحكم |
|---|---|
| قبول بنيوي للفرع (نطاق، عزل، هاشات، ترحيلات، جرد الاختبارات) | ✅ **PASS** |
| قبول التشغيل (typecheck، build، 65 اختبار موجة، انحدار) | ⛔ **BLOCKED** — لا بيئة ولا إذن نشر |
| جاهزية الإصدار | 🚫 **لم تُدَّعَ** — ليست من نطاق W11 ولا من صلاحية Qoder |
| دمج في `main` أو نشر | 🚫 لم يحدث ولن يحدث بلا أمر صريح |

---

## 2. هوية الفرع وحالة النشر

| البند | القيمة | كيف تُحقّق |
|---|---|---|
| `HEAD` | `9ae637c` | `git rev-parse HEAD` |
| سلسلة الموجات | `09e8941` W07 → `20ed66e` W08 → `9af5170` W09 → `9ae637c` W10 | `git log --oneline b80c27b..HEAD` |
| الأساس | `b80c27b` = `origin/claude/05-w04-context` | `git rev-parse origin/claude/05-w04-context` |
| `main` المحلي | `b1b20e5` — لم يُلمس | `git rev-parse main` |
| upstream للفرع | **لا يوجد** | `git rev-parse --abbrev-ref @{upstream}` → `fatal: no upstream` |
| فرع بعيد مطابق | **لا يوجد** (`remotes/origin/` لا يحوي `parallel-w07-w12-ultra`) | `git branch -a` |
| دفع/فرض/دمج | **لم يحدث** | لا ref بعيد، ولا merge commit في المدى |
| شجرة العمل | نظيفة | `git status --short` → فارغ |

**استنتاج النشر (لحظة القبول W11):** كان الفرع محليًا بالكامل. **بعد إذن المالك** دُفع إلى `origin/qoder/parallel-w07-w12-ultra` وتطابق SHA المحلي والبعيد عند `7b115dc`، وبقيت `main` (`b1b20e5`) و`claude/10-ultra-closure` (`9a0f86f`) دون تغيير.

---

## 3. عزل النطاق (لا تعدي على عمل Claude)

`git diff --name-only b80c27b..HEAD` = **54 ملفًا**، وكلها في ملكية Qoder (الرقم النهائي بعد النشر وإصلاحات CI: ملف اختبار commerce + workflow):

| المجموعة | العدد | أمثلة |
|---|---|---|
| قاعدة البيانات (ترحيلات + schema + حراس) | 8 | `0041…0044`، `schema/index.ts`، `clone-migration-guard.ts` |
| محركات الخادم | 20 | `order-journal.ts`، `commission-policy.ts`، `payments/*`، `compliance.ts`، `fraud-signals.ts` |
| المسارات | 6 | `cash.ts`، `compliance.ts`، `trust-ops.ts`، `trust-safety.ts` |
| الاختبارات وبنيتها | 7 | أربع مجموعات موجة + `readiness`/`development-tls`/`safe-development-database` |
| `package.json` (سكربتات الاختبار فقط) | 1 | لا تغيير في التبعيات |
| التقارير والوثائق | 10 | `QODER_W07…W12` + خرائط العقود والمخاطر وقائمة المراجعة والبحث القانوني |
| تقوية CI (بإذن المالك) | 1 | `.github/workflows/qoder-api-suite.yml` |

**نتيجة فحص ملكية Claude:**

```
git diff --name-only b80c27b..HEAD | grep -E "^(artifacts/api-server/src/ai/|artifacts/dinar/src/pages/Ai\.tsx|artifacts/dinar/src/components/.*[Cc]hat|artifacts/dinar/src/components/.*[Cc]ard)"
→ NONE
```

- `artifacts/api-server/src/ai/` — صفر تغييرات.
- `artifacts/dinar/src/pages/Ai.tsx` و`AiChat.css` — صفر تغييرات.
- عقد Card Envelope ومحرك المحادثة الموحد — صفر تغييرات.
- لا merge commits: `git log --merges b80c27b..HEAD` فارغ.
- لا تغيير في `package.json` الجذر أو `pnpm-lock.yaml` أو تبعيات.

**فجوة أعلنت في W10 فقط** (مشتركة، بلا تعديل ملف Claude): `POST /api/reports` يقبل `AI_ANSWER`، و`notifications` يعرف `SUPPORT_CASE_UPDATED`. التفاصيل في تقرير W10 §10 وستُجمع في W12.

---

## 4. قبول الترحيلات

| البند | المتوقع | الفعلي | الحكم |
|---|---|---|---|
| مدخلات `meta/_journal.json` | 45 | 45 | ✅ |
| مدخلات `release-manifest.json` | 45 | 45 | ✅ |
| `EXPECTED_JOURNAL_ENTRIES` | 28 + 17 = 45 | 45 | ✅ |
| آخر tag | `0044_wave10_trust_support_whatsapp` | مطابق | ✅ |
| تطابق هاش كل ترحيل بين الملف والمانيفست والحارس | 4/4 | 4/4 | ✅ |

**هاشات الموجات:**

| الترحيل | sha256 |
|---|---|
| `0041_wave07_financial_journal` | `4403b20e…4347cf0` |
| `0042_wave08_cash_engines` | `44e4a812…798a326d` |
| `0043_wave09_policy_consent_compliance` | `29127432…86b12316` |
| `0044_wave10_trust_support_whatsapp` | `edb8ca57…b3bb50e0` |

**الفحص التدميري** (محاكاة `release-migration.ts`، تقسيم على `--> statement-breakpoint|;` وتعبير `/^\s*(?:DROP\s+(?:TABLE|SCHEMA|TYPE|VIEW|MATERIALIZED\s+VIEW)\b|TRUNCATE\b|DELETE\s+FROM\b)|\bDROP\s+COLUMN\b/i`):

| الملف | مقتطفات | تدميري |
|---|---|---|
| 0041 | 61 | 0 |
| 0042 | 102 | 0 |
| 0043 | 182 | 0 |
| 0044 | 181 | 0 |
| **المجموع** | **526** | **0** |

> ملاحظة دقيقة: 0044 تُسقط قيد `marketplace_reports_target_type_valid` ثم تعيد إنشاءه أوسع. التعبير أعلاه لا يطابق `DROP CONSTRAINT`، وهذا سلوك مقصود في سكربت الإصدار (القيد ليس بيانات). كل الجداول الجديدة إضافية ولا صف قائم يُعاد كتابته.

---

## 5. جرد الاختبارات المكتوبة

| الموجة | الملف | اختبارات | سكربت | بوابة |
|---|---|---|---|---|
| W07 | `wave07-financial-journal.test.ts` | 10 | `test:w07` | `BDINAR_W07_ACCEPTANCE` |
| W08 | `wave08-cash-and-refunds.test.ts` | 12 | `test:w08` | `BDINAR_W08_ACCEPTANCE` |
| W09 | `wave09-policy-consent-compliance.test.ts` | 19 | `test:w09` | `BDINAR_W09_ACCEPTANCE` |
| W10 | `wave10-trust-support-whatsapp.test.ts` | 24 | `test:w10` | `BDINAR_W10_ACCEPTANCE` |
| **المجموع** | — | **65** | 4 | — |

كل السكربتات الأربعة تحمل أيضًا `BDINAR_WAVE4_ACCEPTANCE=development`.

**تصحيح دقة:** تقرير W09 كان يذكر 17 اختبارًا؛ الجرد الفعلي `grep -c '^await test('` = **19**. صُحّح الملف `QODER_W09_ULTRA_REPORT.md` (الصفوف 17–19) قبل هذا التقرير. لا تغيير في الشيفرة.

**فجوة typecheck أُصلحت (تخص W09):** `test/safe-development-database.ts` كان يحوي `BDINAR_W09_ACCEPTANCE` في `approvalMessages` دون `operationMessages` المكتوب بنوع `Record<...>`، ووُسّع الآن بـW09/W10 معًا. تُعد هذه الفجوة عيبًا في تسليم W09 كُشف في W10 وكُتب له إصلاح، ويجب أن يظهر في مخرجات `pnpm run typecheck` عند أول تشغيل.

---

## 6. خطة قبول التشغيل (بعد إذن المالك فقط)

### 6.1 البيئة

- `ubuntu-latest`، Node 24، pnpm 10، PostgreSQL 16 (خدمة workflow).
- `DINAR_LOCAL_PG=postgres://dinar_isolation@127.0.0.1:5432` (بلا اسم قاعدة).
- كل مجموعة على قاعدة عشوائية جديدة، تُنشأ ثم تُحذف، وبذرة `fixtures`.
- سقف الزمن: **60 دقيقة لكل مجموعة** (سقف `qoder-api-suite.yml`).
- **الخارج المتوقع: 0** — `net-guard.mjs` يسجّل أي محاولة خارج loopback، والـworkflow يفشل إن كان `attempts != 0`.
- المخرجات: `artifacts/api-server/*.log` كـartifact باسم `suite-log`، مع سطر `LOCAL_SUITE suite=… exit=… outbound=…`.

### 6.2 الأوامر الفعلية (تُنفَّذ بواسطة المالك أو بموافقته)

```bash
gh workflow run qoder-api-suite.yml --ref qoder/parallel-w07-w12-ultra \
  -f suite=wave07-financial-journal.test \
  -f flags="BDINAR_W07_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development"

gh workflow run qoder-api-suite.yml --ref qoder/parallel-w07-w12-ultra \
  -f suite=wave08-cash-and-refunds.test \
  -f flags="BDINAR_W08_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development"

gh workflow run qoder-api-suite.yml --ref qoder/parallel-w07-w12-ultra \
  -f suite=wave09-policy-consent-compliance.test \
  -f flags="BDINAR_W09_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development"

gh workflow run qoder-api-suite.yml --ref qoder/parallel-w07-w12-ultra \
  -f suite=wave10-trust-support-whatsapp.test \
  -f flags="BDINAR_W10_ACCEPTANCE=development BDINAR_WAVE4_ACCEPTANCE=development"
```

> يجب إرسالها **بالتسلسل** لا بالتوازي، لأن الـworkflow يستخدم concurrency group واحدًا لكل ref ويلغي السابق.

الـworkflow يشغّل قبل المجموعة: `pnpm run typecheck`، بناء `api-server`، بناء `dinar`، و`test:surfaces`. أي فشل فيها يوقف المجموعة — وهذا هو مقصود الفجوة المذكورة في §5.

### 6.3 مصفوفة الانحدار

الوحدات المعدّلة تمس: المصادقة، الأسواق، حقوق البيانات، الدفع، البلاغات، الإشعارات، والواجهات. لذلك الحد الأدنى للانحدار (كلها بنفس البيئة أعلاه):

| المجموعة | سبب الاختيار |
|---|---|
| `commerce.test` | مسارات التجارة الأساسية. |
| `marketplace-intelligence.test` | `lib/markets.ts` وبوابات الأهلية. |
| `commerce-journey.test` | رحلة شراء كاملة مع W07/W08. |
| `payment-order-state.test` | آلة حالات الدفع/الطلب. |
| `phase2-commission-acceptance.test` | العمولة 1,000 bps. |
| `block-f2-buyer.test` / `block-f3-commerce.test` | مسار المشتري والشراء. |
| `closure-privacy.test` | تصدير حقوق البيانات بعد إضافة سجلات الرضا. |
| `closure-notifications.test` | قالب `SUPPORT_CASE_UPDATED` الجديد. |
| `readiness.test` | توقع 45 مدخل ترحيل. |
| `security-acceptance.test` | حدود الوصول والأدوار. |
| `phase1-acceptance.test` | **سيُظهر عيب 320px القائم** (انظر §7). |

أوامرها كما هي في `artifacts/api-server/package.json` عبر `sh test/isolation/local-suite.sh <suite> <flags>`، مع نفس الضوابط.

---

## 7. عيب التمرير عند 320px — ملك Claude، لم يُلمس

**التصنيف:** عيب واجهة مفتوح، مسجّل سابقًا في `docs/dinar-next/CURRENT_ENGINEERING_BASELINE.md`، وأكّد Claude في `CLAUDE_05_W04_CONTEXT.md` أنه باقٍ لـW06.

**إعادة الإنتاج (كما هي مسجّلة):**
1. `phase1-acceptance` يطلب إظهار حالة التأكيد عبر `scrollIntoViewIfNeeded`.
2. يغيّر عرض الشاشة إلى 320px.
3. `ResizeObserver` في `artifacts/dinar/src/pages/Ai.tsx:590` يعيد المحادثة إلى الأسفل، لأن التمرير البرمجي لا يُعد تمرير مستخدم (السطر `:594`).
4. النتيجة: «RESUME confirmation status 320px: key control is outside the viewport» والعنصر عند `y=−2325`.

**الأثر:** مستخدم ينتقل إلى بطاقة قديمة (بحث داخل الصفحة أو رابط) ثم يتغير حجم النافذة (تدوير الهاتف/لوحة المفاتيح) يُعاد إلى الأسفل.

**الموقف في W11:** لم يُعدَّل `Ai.tsx` ولا `AiChat.css` ولا أي اختبار يغطيه. لا إصلاح ولا تعطيل للاختبار. ينتقل إلى W12 كبند ملكية Claude صريح، ويُعاد إنتاجه عند أول تشغيل لـ`phase1-acceptance` على الفرع.

> سياق إضافي: قاعدة ≤1023px في `AiChat.css:1019` تحوّل التخطيط إلى عمود واحد وتخفي الشريط المكتبي، فالعيب ليس عرضًا ثابتًا 264px؛ العيب في منطق المتابعة بعد تغيّر الحجم.

---

## 8. ما لم يُتحقق (BLOCKED صريح)

> **تحديث 2026-10-31:** كل الصفوف التالية نُفِّذت بعد إذن المالك على CI معزول (PG16) وعلى PG18 لمجموعة W09. لا يبقى BLOCKED تشغيلي في هذه القائمة؛ ما يبقى محجوبًا هو النشر الإنتاجي والدمج والتفعيل الحقيقي (انظر W12 §26).

| البند | الحالة بعد CI |
|---|---|
| `pnpm run typecheck` | ✅ PASS (بدون أخطاء TS) |
| `pnpm --filter @workspace/api-server run build` | ✅ PASS |
| بناء الويب `@workspace/dinar` | ✅ PASS |
| 65 اختبار موجة | ✅ 65/65 PASS على PG16 |
| مصفوفة الانحدار | ✅ PASS (22 مجموعة) |
| متصفح 320/390px | ✅ PASS على مسارات المستخدم؛ عيب تمرير 320px يخص Claude ولم يُعدَّل |
| تدقيق أمني آلي (`qoder-security.yml`) | ✅ audit=0 vulns، gitleaks: no leaks، codegen/build PASS |

---

## 9. مخرجات هذه الموجة

- هذا الملف: `docs/dinar-next/QODER_W11_BRANCH_ACCEPTANCE.md`.
- تصحيح عدّاد اختبارات W09 في `QODER_W09_ULTRA_REPORT.md` (17 → 19، وتفصيل الصفوف 17–19).
- لا تغيير شيفرة في W11.

---

## 10. الخلاصة

الفرع `qoder/parallel-w07-w12-ultra` عند `7b115dc` (بعد الدفع والتشغيل):

- **معزول** — لم يمس أي ملف مملوك لـClaude، ولا `main`، ولا التبعيات.
- **إضافي** — 4 ترحيلات، 45 مدخلًا، 0 عملية تدميرية، وهاشات مثبّتة في ثلاثة أماكن.
- **مغطى باختبارات مكتوبة ومُنفَّذة** — 65 اختبار موجة + 22 مجموعة انحدار + بوابات أمنية، كلها PASS على CI معزول.
- **غير مُصرَّح للنشر** — لا دمج إلى `main`، ولا نشر، ولا تفعيل دفع/سوق حي؛ هذه قرارات مالك منفصلة.

**التالي:** W12 — حزمة التسليم السبعة عشر بندًا، مع نقل هذا الحكم كما هو دون تلطيف.
