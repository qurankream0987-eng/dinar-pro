# DINAR NEXT — W12.2: التكامل الموحَّد متعدد الفروع (Canonical Multi-Branch Integration)

**الفرع المعزول:** `qoder/17-unified-integration-candidate`
**مسار العمل:** `D:\DINAR\dinar-w17` (worktree مستقل؛ لا لمس لفروع المهندسين الآخرين)
**SHA النهائي المُختبَر والمرشَّح للتسليم:** `d593b0d` (شيفرة + CI + إزالة تكرار مفاتيح الموافقة الذي أحدثه دمج عمل كلود الأحدث)
**SHAs وسيطة مُختبَرة:** `80dc7a0` (شيفرة) و`a626509` (سماح CI لمجموعتَي C1) — كلتا المجموعتين أُعيدتشغّلت خضراءً على `d593b0d`
**HEAD البعيد المؤكَّد:** `git ls-remote origin qoder/17-unified-integration-candidate` → `d593b0d95f6fde641d5d288bcd070d226541f109`
**التاريخ:** 2026-11-01
**الحالة:** مرشّح تكامل مُختبَر على PostgreSQL 16/18 وChromium حقيقي في GitHub Actions. **ليس** دمجًا في `main`، ولا نشرًا، ولا تفعيل أسواق، ولا ترقية اعتماد قانوني، ولا ادعاء جاهزية إطلاق.

> **قاعدة الصدق:** كل رقم تشغيل أدناه من GitHub Actions على `qurankream0987-eng/dinar-pro`، وكل «مُغطَّى» يقابل ملفًا وسطرًا فعليًا في المرشّح. ما لم يُشغَّل مُعلَن **BLOCKED** أو **PARTIAL**. لم تُنفَّذ أي هجرة على قاعدة إنتاجية، ولم تُستخدم أي مفاتيح مزوّد حقيقية.

---

## 1 — التحقق من المراجع (تم جلبه حديثًا في 2026-11-01)

| المرجع | HEAD البعيد | علاقة النسب بالمرشّح | القرار |
|---|---|---|---|
| `main` | `b1b20e5` | سلف (`git merge-base --is-ancestor` = YES) | الأساس العام غير معدَّل |
| `claude/11-c1-sql-search` | `d94477b` | سلف | C1 مُدمَج بالنسب (ليس استيرادًا مكرَّرًا) |
| `claude/12-d1-d2-business-foundation` | `91b09ee` (بدأ عند `4613d50` ثم تقدّم بـ `8f46dfd`+`91b09ee`) | الأساس + أحدث عمل D1/D2 مستورد بـ cherry-pick يحفظ المؤلف (`29c2af9`/`2e985fe`) | معتمد — ملفات `business-catalog-contract.ts` و`openapi.yaml` و`d1-d2-business-foundation.test.ts` مطابقة بايت-ببايت لرأس كلود |
| `qoder/parallel-w07-w12-ultra` | `af89cb3` | ليس سلفًا — المحتوى مُستورد بترتيب SDK/هجرة مُوحَّد | مُدمَج (تدقيق محتوى بالأسفل) |
| `qoder/14-w02u3-canonical-reliability` | `6687df2` (شيفرة مُختبَرة `b5a3772`) | ليس سلفًا — المحتوى مُدمَج | مُدمَج بالكامل (آخر اختبار C1/W02U-3) |
| `codex/11-c1-sql-search` | `f351f5d` | ليس سلفًا؛ خط C1 موازٍ من `claude/10` | **مدقَّق ومرفوض للاستيراد** (انظر §5) |
| `qoder/15-d3a-native-business` | `939930d` | ليس سلفًا | **غير مستورد** — تصادم `0042` (انظر §6) |
| `qoder/17-unified-integration-candidate` | `d593b0d` | هذا الفرع | — |

نقاط المرجع التي ذكرها التكليف تم التحقق منها كلها (وأُعيد الجلب في نهاية العمل): `d94477b` (C1 كلود) سلف حقيقي؛ `75139b7` (شيفرة D1/D2) سلف داخل `91b09ee`؛ `6b702ae` (شيفرة W12.1) و`af89cb3` (رأس وثائق W12.1) و`5a192d8` (أقدم رأس مُبلَّغ لـ W02U-3) ليست سلفًا — استُورد محتواها أو تجاوزها رأس `qoder/14` الحالي (`6687df2`). رأس `claude/12` **تقدّم أثناء العمل** من `4613d50` إلى `91b09ee`؛ استُورد الالتزامان الجديدان بـ cherry-pick (المؤلف محفوظ: Claude) بدل تجاهلهما.

---

## 2 — الجرد الآلي للقابل للتحقق (Integration Inventory)

| Feature | Source Branch | Source Commit | Canonical Authority | Integration Status | Tests |
|---|---|---|---|---|---|
| C1 SQL search | `claude/11-c1-sql-search` | `d94477b` | `0041_c1_sql_search.sql` + `lib/db/drizzle/meta/0041_snapshot.json` | INTEGRATED (بالنسب من `claude/12`) | `search-sql-foundation.test` (PG16+18)، `search-sql-performance.test`، `arabic-search-understanding.test` |
| `offerRowsByIds` استرجاع محدود | `claude/11` → `claude/12` | `d94477b` / `4613d50` | `src/lib/marketplace-cart.ts:6,30,133,204` | PRESERVED — لم تُستَعَد عملية مسح Node غير المحدودة | `search-sql-foundation.test` + `commerce-journey.test` |
| D1/D2 كيان الأعمال | `claude/12-d1-d2-business-foundation` | `4613d50` (الشيفرة `75139b7`) | `0042_d1_d2_business_foundation.sql`، `authorizeBusinessAction` | INTEGRATED (الأساس) | `d1-d2-business-foundation.test` (PG16+18)، `d1-d2-business-browser.test`، `policy-consent-cards.test` |
| عقد الكتالوج المكتوب الأنواعي v1 | `claude/12` الأحدث (`8f46dfd` → `29c2af9`) | رأس كلود `91b09ee` | `src/lib/business-catalog-contract.ts` (165 سطرًا: هوية/عضوية/صلاحيات/أهلية نشر/رابطة قائمة ضمنية/خطة مدفوعة منفصلة) | INTEGRATED — ملف مطابق بايت-ببايت لرأس كلود | `d1-d2-business-foundation.test:751-757` (فصل الدفع عن التحقق + الرابطة) |
| عقود OpenAPI لمسارات D1/D2 + عملاء مولَّدون | `claude/12` الأحدث (`8f46dfd` → `29c2af9`) | رأس كلود `91b09ee` | `lib/api-spec/openapi.yaml` (102 مسارًا) + `lib/api-zod/src/generated/*` + `lib/api-client-react/src/generated/*` | INTEGRATED | `D2-19` (كل مسار D1/D2 له عملية) + `codegen` leg في `qoder-security` |
| بوابة نيّة الأعمال (pre-gate) | `claude/12` الأحدث | رأس كلود `91b09ee` | `src/ai/business-intent.ts` (`isPossibleBusinessMessage`) + `src/ai/commerce-turn.ts` | INTEGRATED — «وين وصل طلبي رقم …» يبقى طلبًا | `d1-d2-business-foundation.test` (رحلة الدردشة، 24 اختبارًا) |
| W07 دفتر النظام المالي | `qoder/parallel-w07-w12-ultra` | `af89cb3` | `0043_wave07_financial_journal.sql` (نسخة canonical من `0041_wave07_*`) | INTEGRATED | `wave07-financial-journal.test` (PG16+18)، `financial-state-machine.test` |
| W08 النقد/Stردات | `qoder/parallel-w07-w12-ultra` | `af89cb3` | `0044_wave08_cash_engines.sql` (من `0042_wave08_*`) | INTEGRATED + تعزيز S11 (توحيد ترتيب الأقفال) | `wave08-cash-and-refunds.test` (+ حلقة S11 جديدة 10 جولات على PostgreSQL حقيقي) |
| W09 سياسة/موافقة/امتثال | `qoder/parallel-w07-w12-ultra` | `af89cb3` | `0045_wave09_policy_consent_compliance.sql` (من `0043_wave09_*`) | INTEGRATED + توحيد سلطة الموافقة (S9) | `wave09-policy-consent-compliance.test`، `policy-consent-cards.test` |
| W10 ثقة/دعم/واتساب | `qoder/parallel-w07-w12-ultra` | `af89cb3` | `0046_wave10_trust_support_whatsapp.sql` (من `0044_wave10_*`) | INTEGRATED | `wave10-trust-support-whatsapp.test` (PG16+18) |
| W11 قبول فرع مستقل | `qoder/parallel-w07-w12-ultra` | `af89cb3` | `docs/dinar-next/QODER_W11_BRANCH_ACCEPTANCE.md` +CI | INTEGRATED (docs + workflow) | `qoder-api-suite.yml` / `qoder-security.yml` |
| W12 تسليم التكامل | `qoder/parallel-w07-w12-ultra` | `af89cb3` | `docs/dinar-next/QODER_W12_INTEGRATION_HANDOFF.md` | INTEGRATED | — (وثائق) |
| W12.1 تقوية العقود | `qoder/parallel-w07-w12-ultra` | `6b702ae` (شيفرة) | `test/wave07-w12-contract-hardening.test.ts` + `test:w12c` + سماح `BDINAR_W12C_ACCEPTANCE` | INTEGRATED (ملف مُطابق بايت-ببايت للمصدر) | `wave07-w12-contract-hardening.test` (PG16+18) |
| W02U-3 موثوقية البطاقات | `qoder/14-w02u3-canonical-reliability` | `6687df2` (docs) / `b5a3772` (شيفرة مُختبَرة) | Card Envelope v1 + `src/ai/*` + 7 رحلات Chromium | INTEGRATED بالكامل + إصلاح تسابق CR-03 | `w02u3-card-reliability.test` (PG16+18) و7 مجموعات `w02u3-*-browser-journey.test` |
| D9 أي حملة | — | — | — | **NOT INTEGRATED — المصدر غير موجود** | لا شيء؛ تحقق من `git ls-remote` لا يُظهر أي فرع D9 |
| D3A أعمال أصلية | `qoder/15-d3a-native-business` | `939930d` | `0042_d3a_native_business.sql` | **BLOCKED** — يصادم `0042` canonical | مذكور في §6 |

### تدقيق تكافؤ المحتوى (لا استيراد مزدوج)

مقارنة `git rev-parse <branch>:<path>` بين المرشّح والمصدر (blob SHA متطابق = ملف مُطابق بايت-ببايت):

`routes/cash.ts`، `routes/compliance.ts`، `routes/trust-ops.ts`، `lib/support-cases.ts`، `test/wave07-financial-journal.test.ts`، `test/wave09-*.test.ts`، `test/wave10-*.test.ts`، `test/wave07-w12-contract-hardening.test.ts` — كلها **IDENTICAL**.
ملفان يختلفان عمدًا: `test/wave08-cash-and-refunds.test.ts` (+53 سطرًا: حلقة S11) و`test/w02u3-card-reliability.test.ts` (إضافة CR-03 التسلسلية بعد الاستقرار).

---

## 3 — سلسلة الالتزامات في المرشّح (من الأساس `4613d50`)

```
4613d50  (claude/12)  الأساس وقت البدء — يتضمن C1 و D1/D2 (75139b7)
 ...    تكامل W07–W12.1 (harness معزول، هجرة canonical، إصلاحات typecheck/mount)
6b91cc7  feat(w02u3): دمج موثوقية البطاقات canonical في المرشّح الموحَّد
820e8bc  fix(commerce): أخذ قفل الطلب قبل صطف الاسترداد (S11)
18f1c1b  fix(policy): عكس الموافقات من المحادثة إلى دفتر W09 (S9)
3856029  fix(db): جعل طوابع الموجات الزمنية متزايدة بصرامة
4d51762  ci: تشغيل مجموعات D1/D2 وبطاقات الموافقة على الركض المعزول
4edb744  ci: ربط مثبّتات الهجرة بمدخل صريح
c2c548e  fix(db): إزالة أثرَي دمج أفسدا typecheck
6b7a30a  fix(ai): حسم التأكيدات المتكررة على البطاقة دون الوصول للنموذج
80dc7a0  fix(db): توسيع أنواع أهداف البلاغات في المخطط لمطابقة الهجرة 0046
a626509  ci(search): إتاحة مجموعتَي C1 Foundation/Performance للتحفيذ المعزول
29c2af9  feat(d1-d2): (cherry-pick من كلود `8f46dfd`) بوابة نيّة الأعمال + عقد الكتالوج + OpenAPI
2e985fe  docs(d1-d2): (cherry-pick من كلود `91b09ee`) دليل الدفعة النهائية وكلود هاندوف
d593b0d  fix(test): إزالة تكرار مفتاح `BDINAR_D1D2_ACCEPTANCE` الذي أحدثه الدمج  ← HEAD
```

الانتباه المطلوب: `claude/12` كان عند `4613d50` ثم تقدّم؛ لذا لم تُستخدَم SHA تاريخية كرأس حالي — أُعيد `git ls-remote` قبل الاستيراد، وقورن المحتوى بالـ blob بعد الاستيراد.

---

## 4 — الوثائق التسع: ما تأكد منه وما صُحّح

قُورنت الوثائق المطلوبة بالمصدر الفعلي، ولم تُعامَل كدليل على وجود الشيفرة:

| الوثيقة | الادعاء الرئيسي | التحقق مقابل الشيفرة |
|---|---|---|
| `QODER_CLAUDE_MERGE_RISK_MATRIX.md` | R1–R17 | استُخدمت كقائمة تحقق؛ أُعيد فحص كل بند في المرشّح (انظر مصفوفة الإغلاق) |
| `QODER_W12_1_PRE_INTEGRATION_HARDENING.md` | `6b702ae` يضيف اختبارًا وسماحًا فقط | مؤكد: الملف موجود ومطابق للمصدر؛ لا تغيير شيفرة إنتاجية |
| `QODER_W12_INTEGRATION_HANDOFF.md` | W07–W10 جاهزة للتكامل | جزئيًا صحيح: الشيفرة موجودة؛ الهجرات كانت متصادمة (0041–0044) وصحيحناها في §المهاجات |
| `QODER_FINAL_REVIEW_CHECKLIST.md` | قائمة مراجعة | استُخدمت كمرجع؛ لا أدلة فيها على الترتيب النهائي للهجرة |
| `D1_D2_IMPLEMENTATION_MAP.md` | جداول/صلاحيات D1/D2 | مؤكدة عبر `0042` و`authorizeBusinessAction` في المرشّح |
| `D1_D2_CLAUDE_HANDOFF.md` | عدم خلط الاشتراك بالتحقق | مؤكد: مساران منفصلان في `0042` و`business_profiles_publication_requires_verified` |
| `D1_D2_BUSINESS_VERIFICATION_SECURITY.md` | عزل الوثائق | مؤكد: مسار خاص + أحداث append-only + `business_verification_documents_*` checks |
| `D1_D2_QODER_BUSINESS_CATALOG_HANDOFF.md` | ربط الأعمال بالقوائم | **ادعاء غير مكتمل المصدر**: لا توجد رابطة صريحة `listing ↔ business` في الأساس؛ قرار التوثيق في §7 |
| `D1_D2_PHASE_NAMING_RECONCILIATION.md` | تسمية المراحل | مستخدم للتسمية فقط؛ لا يعالجي تسلسل الهجرة |

---

## 5 — تدقيق `codex/11-c1-sql-search` (نتيجة: عدم الاستيراد)

`codex/11` (`f351f5d`) خط C1 مستقل من `claude/10` وليس حفيد `claude/11` (`git merge-base --is-ancestor` = NO). يحوي:

- `0041_search_foundation.sql` بدل `0041_c1_sql_search.sql`؛
- `0045_c1_numeric_compat.sql` (استبدال `dinar_search_number` بمطابقة دلالات JS `Number`: تفريغ فضاءات يونيكود، `0x/0b/0o`، underflow إلى صفر، رفض `Infinity/NaN`).

القرار: **غير مستورد** في هذا المرشّح، لأن سلطة C1 canonical هي `0041_c1_sql_search.sql` (لا تُعرِّف `dinar_search_number` إطلاقًا؛ التحويل يتم في SQL/TypeScript المسنود بـ `search-sql-foundation.test` و`search-golden.json`). استيراد وظيفته PL/pgSQL سيُدخل دالة لا تستدعيها أي شيفرة في المرشّح ويصادم التسلسل canonical (رقم 0045 محجوز لـ W09). مُعلَن كمهمة منفصلة لكلود/المالك: إن أردنا مطابقة `Number` الحرفية، تُصاغ كالهجرة `0047` القادمة بعد قرار تصميمي، لا كجزء من تكامل W12.2.

---

## 6 — `qoder/15-d3a-native-business` وم Collision

`939930d` يُعرِّف `0042_d3a_native_business.sql` مقابل `0042_d1_d2_business_foundation.sql` canonical — تصادم رقمي مباشر. غير مستورد (نطاق D3A خارج تكامل W12.2، ومالك D3 معيَّن). مُوثَّق كخطر مفتوح **N2** في مصفوفة الإغلاق مع مسار التسوية: إعادة ترقيم D3A إلى `0047+` بعد الدمج canonical، لا إعادة تسمية `0042`.

---

## 7 — قرارات نطاق مقصودة (ليست إخفاقات)

1. **D9 غير موجود:** لا فرع ولا مصدر مُتحقَّق منه باسم D9 في المستودع. لم يُستورد شيء وهمي.
2. **رابطة العمل ↔ القائمة:** §05 كان يسمح بإحدى ثلاث. الواقع بعد دمج عمل كلود الأحدث: **حدّ مكتوب الأنواعي مُعرَّف ومُختبَر** — `business-catalog-contract.ts:134-151` يعرّف الرابطة كضمنية في v1 (قوائم المالك في سوق العمل عبر خدمات القوائم canonical، بلا `business_id` على العروض)، مع توثيق التبعية صراحةً وأن إضافة عمود ملكية قرارُ مهندس D3. لا طلبات تاريخية حُرِّكت.
3. **OpenAPI/العملاء المولَّد (S6):** كان مُعلَّنًا PARTIAL؛ بعد استيراد `29c2af9` صار **PASS لنطاق D1/D2**: `lib/api-spec/openapi.yaml` فيه 102 مسارًا، 20 عملية D1/D2 بطلبات صارمة، والعملاء المولَّدون في `lib/api-zod` و`lib/api-client-react`، وحارس `D2-19` يفشل على أي مسار D1/D2 بلا عملية. يبقى **PARTIAL لبقية المسارات**: مسارات الموجات W07–W10 (cash-refunds، trust، privacy، compliance، appeals، provider) غير مغطاة في المخطط المفتوح، وتوسيعها مهمة مستقلة مُعلنة.
4. **TLS حي:** اختبار `development-tls.test` الحي مقفور خلف `DINAR_TLS_ACCEPTANCE` (لا شبكات خارجية في CI المعزول)؛ يُشغَّل فحص journal/ hashes الكامل (47 مدخلًا) في كل تشغيل.

---

## 8 — ما يلي هذه الوثيقة

- `QODER_W12_2_MIGRATION_RECONCILIATION.md` — تسلسل 47، hashes، إثبات الترقية على PG16/18.
- `QODER_W12_2_RISK_CLOSURE_MATRIX.md` — R1–R17، S1–S13، وأخطار جديدة N1–N4.
- `QODER_W12_2_COMBINED_ACCEPTANCE.md` — أرقام تشغيل GitHub Actions، مسارات مركَّبة، Chromium، الأداء.
- `QODER_W12_2_CLAUDE_HANDOFF.md` — ما على كلود مراجعته وقرار الدمج.
