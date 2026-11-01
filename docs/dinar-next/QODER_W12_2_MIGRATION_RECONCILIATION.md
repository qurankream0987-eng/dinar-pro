# DINAR NEXT — W12.2: تسوية هجرة Drizzle (Migration Reconciliation)

**المرشّح:** `qoder/17-unified-integration-candidate` — الـ SHA المُختبَر `d593b0d` (التسوية نفسها مُقرة في `3856029`)؛ رأس الفرع الآن `5c41ec2` وهو هذه الوثائق فقط
**المسار:** `lib/db/drizzle/` + `lib/db/drizzle/meta/_journal.json` + `lib/db/drizzle/release-manifest.json` + `lib/db/src/clone-migration-guard.ts`
**التاريخ:** 2026-11-01
**النتيجة:** تاريخ مُسوّى بالكامل من 47 مدخلًا، الرأس `0046_wave10_trust_support_whatsapp`، مُختبَر على PostgreSQL 16 و18، بلا تعديل أي هجرة طُبِّقت على قاعدة حقيقية، وبلا تنفيذ إنتاجي.

---

## 1 — الحالة عند الوصول: ثلاث سلاسل متصادمة

| السلسلة | الملفات في المصدر | idx في journal |
|---|---|---|
| Claude C1 (`claude/11` → `claude/12`) | `0041_c1_sql_search.sql` | 41 |
| Claude D1/D2 (`claude/12`) | `0042_d1_d2_business_foundation.sql` | 42 |
| Qoder W07–W10 (`qoder/parallel-w07-w12-ultra`) | `0041_wave07_financial_journal.sql`، `0042_wave08_cash_engines.sql`، `0043_wave09_policy_consent_compliance.sql`، `0044_wave10_trust_support_whatsapp.sql` | 41–44 |
| `codex/11` (خط C1 موازٍ — غير مستورد) | `0041_search_foundation.sql`، `0045_c1_numeric_compat.sql` | 41 و45 |
| `qoder/15` (D3A — غير مستورد) | `0042_d3a_native_business.sql` | 42 |

التصادم الحقيقي: `0041` (C1 مقابل wave07) و`0042` (D1/D2 مقابل wave08)؛ و`qoder/parallel` نفسه لم يكن يطبق `0043/0044` فوق أساس `claude/12` لأن journal كل فرع ينتهي عند idx 44 الخاص به.

## 2 — هل طُبِّقت أي هجرة متصادمة في بيئة حقيقية؟

- لم نُوصَل بأي قاعدة إنتاجية ولا استخدمنا أي بيان اتصال إنتاجي (حظر التكليف محترم).
- كل فحص تم على قواعد Disposable على `127.0.0.1` داخل GitHub Actions (`local-suite.sh` ينشئ `dinar_test_local_<random>` ويحذفه).
- `release-manifest.json` في `claude/12` (الأساس) يسجّل `0041` و`0042` كـ canonical؛ `qoder/parallel` لم يسجّل أي وسم `wave07..wave10` في manifest الأساس، أي أن سلاسل الموجات **غير مطبَّقة في تاريخ النشر المرجعي**.
- الاستنتاج المُعلَن: التسوية الأمامية (إعادة الترقيم canonical داخل الفرع المعزول) آمنة لهذا المرشّح؛ **اليقين الوحيد غير المتاح** هو تاريخ `database` خاص ببيئة مملوكة للمالك غير `claude/12` — طُبِّقت فيه هجرة بوسم `0041_wave07..`. لذلك §7 يطلب من المالك تأكيدًا واحدًا قبل الدمج.

## 3 — الترتيب canonical المعتمد

`0041 C1 → 0042 D1/D2 → 0043 W07 → 0044 W08 → 0045 W09 → 0046 W10`

التحقق من الاعتمادات قبل الاختيار:

- `0043_wave07` يبني `order_financial_events` و`commission_policies` ويضيف `orders` snapshot columns — لا يعتمد على `0044+` ولا على جداول W08/W09/W10.
- `0044_wave08` (`cash_payment_claims`, `cash_refund_cases`) يشير إلى `orders` و`cash_payment_claims` من `0044` نفسها فقط، ويضيف FK `cash_refund_cases.payment_claim_id → cash_payment_claims.id` (داخل نفس الملف) — لا يعتمد على W09/W10.
- `0045_wave09` (policy registry/consent/legal entities/compliance/seller verification) يشير إلى `users`, `markets` فقط — مستقل عن W08.
- `0046_wave10` (fraud signals, support cases, whatsapp) يشير إلى `users`, `markets`, `fraud_signals`, `support_cases`, `whatsapp_templates` — لا يعتمد على `0043–0045` لكن ترتيبه بعد `0044` يحافظ على دلالة زمنية سليمة.
- C1 وD1/D2 يسبقان الموجات لأن `0042` (D1/D2) يضيف `promotion_products` FKs و`business_*` التي تستخدمها مسارات الأعمال، و`0041` (C1) يضيف `offer_search_documents` الذي يعتمد عليه `marketplace.ts` المدمَج.

النتيجة: ترتيب التكليف صالح ومُتحقَّق منه بالاعتمادات، ولا حاجة لترتيب بديل.

## 4 — هوية SQL: نسخ canonical بلا تغيير بايت

أُعيد تسمية ملفات الموجات الأربعة من أوسمتها الأصلية إلى `0043..0046`. **محتوى SQL لم يُعدَّل حرفًا واحدًا** — بُرهان بمقارنة blob عبر git (تجنّبًا لتحويل CRLF في worktree ويندوز):

```
git cat-file blob qoder/parallel-w07-w12-ultra:lib/db/drizzle/0041_wave07_financial_journal.sql | sha256sum
git cat-file blob HEAD:lib/db/drizzle/0043_wave07_financial_journal.sql | sha256sum
```

| الوسم canonical | SHA-256 للـ blob (= hash الـ manifest) | مطابق لمصدر |
|---|---|---|
| `0041_c1_sql_search` | `945ccc5622390b1a6a2e9af94aaa2d9010ac8b0e164de3b90571742dc1b05a5c` | `claude/12` |
| `0042_d1_d2_business_foundation` | `5d2c6fc28d2f910528d43a3e4efb7676bf7839a1fd90a30c1c39a78d887765db` | `claude/12` |
| `0043_wave07_financial_journal` | `4403b20eefd37d18cfe29086722946975a4765192ad5b3cc86b089ac54347cf0` | `qoder/parallel` `0041_wave07_*` |
| `0044_wave08_cash_engines` | `44e4a812ae36f25ef2210627741e76898e02ddf58c1e5ec78abb3379798a326d` | `qoder/parallel` `0042_wave08_*` |
| `0045_wave09_policy_consent_compliance` | `29127432970d98e5a98e138ed78b9cfe781fa35a6f0366762b6ab36786b12316` | `qoder/parallel` `0043_wave09_*` |
| `0046_wave10_trust_support_whatsapp` | `edb8ca5702215790271b405cc086152fb1fb8ea3090d599008a7a828b3bb50e0` | `qoder/parallel` `0044_wave10_*` |

كل hash أعلاه يُطابق القيمة في `release-manifest.json` الخاصة بالمرشّح، ويُعاد حسابه بحرفيته في اختبار `development-tls.test` وفي فحص `readiness.test`.

> **تحذير تشغيلي لبيئة ويندوز:** `sha256sum` على ملف العمل لا يطابق الـ manifest لأن `core.autocrlf=true` يحوّل LF→CRLF عند الكتابة. الحساب canonical يجب أن يكون من blob في git. هذه ليست انحرافًا في البيانات، لكنها مصدر خطأ محتمل لأي مراجعة لاحقة، ومُوثَّقة هنا.

## 5 — إعادة الطوابع الزمنية (`when`) — لماذا كانت ضرورية

مجلة `qoder/parallel` الأصلية: `0041_wave07` = 1793260000000، `0042_wave08` = 1793340000000، `0043_wave09` = 1793420000000، `0044_wave10` = 1793500000000 — كلها **أقدم** من `0042_d1_d2` (1793476433494) و`0041_c1` (1793458207541).

المشكلة ليست تجميلية: `loadReleasePlan` يرفض journal غير متزايد، والمهاجر يطبّق الهجرة فقط إذا كان `lastDbMigration.created_at < migration.when`؛ بطوابع المصدر كانت `0043..0045` ستُتخطَّى صامتًا فوق قاعدة طُبِّق فيها `0042` (أو تُرفض الخطة). لذلك رُفعت الطوابع إلى قيم متزايدة بصرامة **بعد اعتماد المالك الصريح** (سؤال/جواب في نفس الجلسة):

| الوسم | `when` قبل | `when` بعد |
|---|---|---|
| `0043_wave07_financial_journal` | 1793260000000 | 1793510000000 |
| `0044_wave08_cash_engines` | 1793340000000 | 1793520000000 |
| `0045_wave09_policy_consent_compliance` | 1793420000000 | 1793530000000 |
| `0046_wave10_trust_support_whatsapp` | 1793500000000 | 1793540000000 |

الإعدادات `idx/tag/breakpoints` لم تتغير، ولم يُمسّ `0041`/`0042` (طوابع كلود الأصلية محفوظة)، ولا وُسِم أي هجرة بأنها مطبَّقة.

## 6 — التحديث الذري للبيانات الوصفية والحراسات

عُدِّلت في الالتزام نفسه (`3856029` وما تلاه) بحيث لا توجد حالة وسيطة:

| الملف | القيمة المعتمدة | التحقق |
|---|---|---|
| `lib/db/drizzle/meta/_journal.json` | 47 مدخلًا (idx 0–46)، الرأس `0046` | خطوة CI تعيد قراءة journal وتقارن بالـ manifest وترفض غير المتزايد |
| `lib/db/drizzle/release-manifest.json` | 47 وسمًا + 47 hash بترتيب journal | نفس الخطوة + `readiness.test` |
| `lib/db/src/clone-migration-guard.ts` | `EXPECTED_BASELINE_MIGRATIONS = 28`، `REVIEWED_PENDING_MIGRATIONS = 16`، `EXPECTED_JOURNAL_ENTRIES = 47` | `development-tls.test` (47 مدخلًا) + guard runtime |
| `artifacts/api-server/test/readiness.test.ts` | ledger يجب أن يكون **بادئة دقيقة** لخطة النشر | `readiness.test` PG16/18 |
| `artifacts/api-server/test/development-tls.test.ts:160-171` | عدد Journal = 47 | يُشغَّل في كل ركض |
| `.github/workflows/qoder-api-suite.yml` | مثبّتات الهجرة خلف `run_release_migration` (bool) فقط عند الطلب الصريح | `4edb744` |

لم تُخفَّف أي حراسة: `clone-migration-guard` ما زال يفرض البادئة 28، و`resolveDatabaseUrl`/`safe-development-database.ts` ما زالت ترفض أي قاعدة غير loopback disposable، و`paymentSimulationEnabled()` ما زال يُرجع 404 خارج التطوير، و`isPromotionFeatureEnabled()` ما زال خلف `BDINAR_PROMOTIONS_ENABLED=true`.

**ملاحظة انحراف سُنابات (R12/N3):** `lib/db/drizzle/meta/` لا يحوي `0043..0046_snapshot.json` — وهذا مطابق لمصدر `qoder/parallel` (كان ينتهي عند `0040_snapshot.json`). النتيجة: `drizzle-kit generate` لاحقًا سيحتاج أول snapshot canonical؛ لم نخترع سنابات مطبَّقة. مُعلَن كعمل متبقٍّ لكلود مع البرهان أن لا اختبار حالي يعتمد على السنابات فوق `0042`.

## 7 — البرهان المطلوب: PG16 وPG18 ومسار البيانات القائمة

شغّلنا، على `d593b0d` (`run_release_migration=true`، التشغيل 41274370586)، ما يلي — والنتائج من سجلات التشغيل نفسها:

1. **فحص journal/manifest** (الخطوة أعلاه) — PASS على الرُكنين.
2. **مثبّتات الترقية عند 0 / 28 / 42** بآلة هجرة Drizzle على **كلا إصداري PG16 وPG18** — PASS (`pnpm --filter @workspace/db run test:migrate-upgrade`).
3. **مشغّل الهجرة النشرية** (`MINIMUM_SERVER_VERSION_NUM = 180000`) على PG18، بما فيه ترقية من بيانات موجودة `0042 → 0043 → 0044 → 0045 → 0046` — **12/12** PASS.
4. **جداول الموجات الوظيفية** على PG16 وPG18 عبر `wave07/08/09/10` (مفاتيح `BDINAR_W0x_ACCEPTANCE=development`) — تفحص: الجداول المتوقعة، المفاتيح الأجنبية، الفهارس، المحفِّزات (`offers_search_revision_guard`, `marketplace_categories_search_invalidate`)، القيود `CHECK` المتمدِّدة (`marketplace_reports_target_type_valid` بخمسة أنواع)، جداول الأحداث append-only (`support_case_events`, `moderation_audit`, `business_verification_events`, `order_financial_events`), وحماية idempotency (`whatsapp_intents_never_sent`، مفاتيح idempotency في `cash` و`consent`).
5. **C1 search indexes** — `search-sql-foundation.test` + `search-sql-performance.test` على PG16 وPG18 (خطة الفهرس، `pg_trgm`، حجم نتائج محدود).

أرقام التشغيل مرتبطة في `QODER_W12_2_COMBINED_ACCEPTANCE.md`.

## 8 — بقيّة غير مُغلَقة (بصدق)

| البند | الحالة | ما يحتاجه |
|---|---|---|
| تأكيد المالك لتاريخ `0041_wave07..0044_wave10` في أي قاعدة خاصة خارج `claude/12` | **BLOCKED** (لا صلاحية فحص قاعدة إنتاجية) | استعلام `_journal`/`__drizzle_migrations` من قاعدة preview/production أو بيان رسمي بأنها لا تحتوي وسوم الموجات |
| سنابات `0043..0046` | **PARTIAL** (غير مطلوبة لأي اختبار حالي؛ مطابقة للمصدر) | `drizzle-kit generate` محسوب على المرشّح المدمج، مع إعادة hash الـ manifest ذرّيًا |
| D3A `qoder/15` (تصادم `0042`) | **BLOCKED** خارج نطاق W12.2 | إعادة ترقيم أمامي `0047+` بعد الدمج canonical، بتنفيذ مالك D3 |
| `codex/11` `0045_c1_numeric_compat` | **NOT INTEGRATED** بقرار | قرار تصميمي: هل تحتاج C1 canonical مطابقة `Number` الحرفية؟ إن نعم → `0047` أمامية فقط |

لم تُنفَّذ أي هجرة على قاعدة إنتاجية؛ لم تُحذف بيانات؛ لم تُعَد كتابة أي تاريخ؛ لم تُتخطَّ أي فحص.
