# Q-A01 — تدقيق الأساس والفروع والهجرات والاعتماديات

**المهمة:** Q-A01 (أول مهمة مستقلة، نطاق محدود: الأساس، الفروع، سجل الهجرات، الاعتماديات، صحة أهداف CI — لا دمج ولا نشر).
**المستودع:** `qurankream0987-eng/dinar-pro` (الريموت المحلي ما زال بالاسم القديم `dinar.git` ويُحوَّل تلقائيًا).
**فرع الأساس:** `replit/dinar-next-complete-development` **مجمَّد** على `1a194fee08c4b113085f97c222fc50bf17fc8e87`.
**فرع Qoder:** `qoder/a01-baseline-audit`.
**SHA الإصلاح/الاختبار:** `1b4adf3d2b87a1a82ccff30804ecd419bf119fb2`.
**تاريخ التنفيذ:** 2026-11-02.

---

## 1 — المهمة
Q-A01: تدقيق الأساس والهجرات والاعتماديات وأهداف الاختبار، وإصلاح ما يثبت عطله فقط، دون بدء Q-A02 ودون مساس بأي فرع لـ Replit أو Claude أو Codex.

## 2 — SHA أساس Replit
`1a194fee08c4b113085f97c222fc50bf17fc8e87` — «DINAR NEXT 04E: complete D5 publication and marketing gates». أُعيد فحص الريموت قبل البدء وبعده وبقي نفسه.

## 3 — فرع Qoder
`qoder/a01-baseline-audit`، منشأ من الـSHA أعلاه في worktree معزول `D:\DINAR\dinar-a01`.

## 4 — SHA الإصلاح
`1b4adf3d2b87a1a82ccff30804ecd419bf119fb2` — ثلاثة commits فوق الأساس:

| # | Commit | المحتوى |
|---|---|---|
| 1 | `eb3f235267f63a86fd8ace2828e4196e0685e829` | `ci(a01)`: إدراج مجموعتي D4/D5 وبوابتيهما في مُرسِل CI |
| 2 | `8e6f9412687b2d9f857e15d55b436931d290318a` | `docs(a01)`: تصحيح أساس الوكلاء وعدد الهجرات |
| 3 | `1b4adf3d2b87a1a82ccff30804ecd419bf119fb2` | `fix(d4)`: حذف `sellerListing` عند غياب الوقائع المصرَّح بها |

## 5 — الملفات المفحوصة
- `AGENTS.md`، `CLAUDE.md`، `docs/qoder/00_START_HERE.md`، `docs/qoder/GUARDRAILS.md`.
- `lib/db/drizzle/meta/_journal.json` (51)، `release-manifest.json` (51)، `lib/db/drizzle/*.sql` (51)، `lib/db/drizzle/meta/*_snapshot.json` (37).
- `lib/db/src/clone-migration-guard.ts`، `lib/db/src/release-migration.ts`، `lib/db/scripts/release-migration.test.mjs`، `release-migration-concurrency.test.mjs`، `migrate-release.mjs`، `preview-migration-check.mjs`.
- `artifacts/api-server/test/readiness.test.ts`، `development-tls.test.ts`، `test/isolation/local-suite.sh`، `business-delegations.test.ts`، `d5-seller-employee-acceptance.test.ts`، `d3a-native-business.test.ts`.
- `artifacts/api-server/src/ai/smart-turn.ts`، `model-turn.ts`، `seller-management.ts`.
- `.github/workflows/qoder-api-suite.yml`، `qoder-security.yml`، `claude-d1d2.yml`، `claude-integration.yml`.
- `pnpm-workspace.yaml`، `pnpm-lock.yaml` (v9.0)، `.npmrc`، `package.json`، `lib/db/package.json`.

## 6 — العيوب المؤكدة

| المعرف | الخطورة | الوصف | الحالة | الدليل |
|---|---|---|---|---|
| A01-01 | **HIGH** | `business-delegations.test` **أحمر على رأس Replit نفسه**: 3/4. `smart-turn.ts` في 04E وسّع فرع التسويق إلى جلسة الموظف، و`sellerListingFacts` يعيد `null` لكتالوج مفوَّض فارغ، فحمل عقد النموذج `sellerListing: null` بينما الاختبار يفرض غياب المفتاح | **مُصلَح ومُتحقَّق** | أحمر: 41476282104 (3/4)؛ أخضر: 41477787830 (4/4 PG16)، 41478249183 (4/4 PG18) |
| A01-02 | MEDIUM | مُرسِل `qoder-api-suite` لا يقبل `business-delegations.test` ولا `d5-seller-employee-acceptance.test` ولا بوابتيهما، فلا يمكن إنتاج دليل D4/D5 عبر المشغّل المعزول | **مُصلَح ومُتحقَّق** | رفض HTTP 422 قبل الإصلاح؛ وبعد الإصلاح قُبل الإرسال ونُفِّذ |
| A01-03 | MEDIUM | `AGENTS.md` و`00_START_HERE.md` و`GUARDRAILS.md` توجّه الوكلاء إلى `claude/02-sc-acceptance` كأساس — فرع تاريخي متأخر، ويخالف سياسة الأساس الجديدة | **مُصلَح (وثائق فقط)** | `git diff 1a194fe..HEAD -- AGENTS.md docs/qoder` |
| A01-04 | LOW | `CLAUDE.md` يقول «49 هجرة» والسجل والملفات والـmanifest تحمل 51 | **مُصلَح** | العدّ 51/51/51 و0 اختلاف بصمات |
| A01-05 | LOW | `qoder-security.yml` يُشغَّل بالدفع على `qoder/10..12` فقط؛ الفروع الأحدث تعتمد على الإرسال اليدوي | مبلَّغ — لم يُصلَح | `.github/workflows/qoder-security.yml:8-12` |
| A01-06 | LOW | مفتاح `DINAR_TLS_ACCEPTANCE` مسموح بالقيمة `development` بينما الاختبار الحي يتجاوز إلا عند `1` → مفتاح خامل | مبلَّغ — لم يُصلَح | `qoder-api-suite.yml:138` مقابل `development-tls.test.ts:182` |
| A01-07 | LOW/MEDIUM | سيرتا Claude تستخدمان وسومًا عائمة (`@v4`) بينما سيرتا Qoder مثبَّتتان بـSHA | مبلَّغ — لم يُصلَح (ملفات مملوكة لـClaude) | `claude-d1d2.yml:51-55`, `claude-integration.yml:51-55` |
| A01-08 | LOW | الفرع الافتراضي على GitHub هو `main` وهو متأخر 211 commitًا وبلا أي workflow؛ GitHub يعرض 8 workflows مسجَّلة من فروع أخرى | مبلَّغ — قرار مالك | `gh api repos/.../actions/workflows` |
| A01-09 | LOW | لقطات drizzle 37/51 فقط، و`drizzle-kit check` غير مشغَّل في CI؛ التوليد يعتمد على لقطة الرأس `0050` (امتداد C-5) | مبلَّغ — لم يُصلَح | قائمة الوسوم الناقصة أدناه |
| A01-10 | LOW | مجلد العمل الخارجي `C:\Users\dell\Documents\Qoder\2026-10-26\b1ec2f1d` ليس مستودع git ويحوي `dinar/` فارغًا؛ أي اختبار يجب أن يستهدف worktree | مبلَّغ | فحص مباشر |
| A01-11 | LOW | مضيف Windows هذا بلا `node`/`python`/`jq`؛ كل التنفيذ جرى في GitHub Actions | مبلَّغ | `command -v` |
| A01-12 | LOW (تذبذب) | `wave09` فشل مرة واحدة على PG18 داخل مهمة التكامل (`LISTING_CONTACT_TEXT`/`MINOR_PROTECTION_NOT_ENABLED`)، ثم نجح معزولًا 19/19 ونجحت المهمة كاملة في إعادة التشغيل | مبلَّغ — تحت المراقبة | أحمر: 41480720329 (محاولة 1)؛ أخضر: 41481775353 و41480720329 (إعادة) |

الوسوم بلا لقطة: `0028, 0031, 0032, 0034–0038, 0041–0045, 0048`.

## 7 — الأسباب الجذرية
- **A01-01:** توسيع شرط `sellerListing` في 04E لم يُرافقه تحديث توقّع اختبار D4 الذي أُضيف قبل التوسيع؛ نوع العقد يسمح بـ`null` (`model-turn.ts:339`) فمرّ typecheck.
- **A01-02:** قائمة السماح في الـworkflow تُنسخ يدويًا، ولم تُحدَّث عند وصول مجموعتي D4/D5 في 04B/04E.
- **A01-03/A01-04:** توثيق يدوي لم يُحدَّث مع تغيّر الأساس وتتابع الهجرات.
- **A01-12:** لم يُثبت سبب جذري؛ الفشل غير قابل لإعادة الإنتاج (تشغيلان لاحقان أخضران، وسلسلة PG18.6 السابقة في W12.2 خضراء).

## 8 — الإصلاحات البرمجية
1. `qoder-api-suite.yml`: إضافة المجموعتين إلى `options`، وإضافة `BDINAR_D4_ACCEPTANCE` و`BDINAR_D5_ACCEPTANCE` إلى مفاتيح القيمة `development` فقط.
2. `smart-turn.ts`: رفع حساب وقائع التسويق إلى `marketingFacts` وإدراج `sellerListing` فقط عند وجود وقائع؛ لا تغيير في أي مسار تفويض أو سعر أو دفع.
3. `AGENTS.md` / `00_START_HERE.md` / `GUARDRAILS.md`: الأساس = فرع Replit مجمَّدًا على SHA؛ الفروع التاريخية ليست أساسًا.
4. `CLAUDE.md`: 49 → 51.

## 9 — أوامر الاختبار
```bash
# إرسال D4/D5 على PG16 وPG18
gh workflow run qoder-api-suite --ref qoder/a01-baseline-audit \
  -f suite=business-delegations.test -f chain=none \
  -f flags="BDINAR_D4_ACCEPTANCE=development" -f pg_version=16
gh workflow run qoder-api-suite --ref qoder/a01-baseline-audit \
  -f suite=business-delegations.test -f chain=none \
  -f flags="BDINAR_D4_ACCEPTANCE=development" -f pg_version=18
gh workflow run qoder-api-suite --ref qoder/a01-baseline-audit \
  -f suite=d5-seller-employee-acceptance.test -f chain=none \
  -f flags="BDINAR_D5_ACCEPTANCE=development" -f pg_version=16
# رحلات ومصفوفة التكامل + هجرة الإصدار (PG18)
gh workflow run claude-integration --ref qoder/a01-baseline-audit
# فحص الاعتماديات والأسرار والبناء وتوليد العملاء
gh workflow run qoder-security --ref qoder/a01-baseline-audit
```
وللتحقق المحلي من البصمات (Blobs لا ملفات CRLF):
```bash
git show HEAD:lib/db/drizzle/<tag>.sql | sha256sum   # مقابل release-manifest.json و clone-migration-guard.ts
```

## 10 — النتائج: ناجح/فاشل/متجاوز

| التشغيل | Run | النتيجة |
|---|---|---|
| D5 مرجعي PG16 (قبل أي إصلاح) | 41475266175 | 1/1، 0 فشل، 0 متجاوز، `outbound=0` |
| D5 مرجعي PG18 | 41475807476 | 1/1 |
| **D4 قبل الإصلاح PG16** | 41476282104 | **4 اختبارات: 3 ناجح، 1 فاشل** |
| D4 بعد الإصلاح PG16 | 41477787830 | 4/4، 0 فشل |
| D4 بعد الإصلاح PG18 | 41478249183 | 4/4، 0 فشل |
| D5 تراجعي بعد الإصلاح PG16 | 41478775028 | 1/1 |
| Phase1 بعد الإصلاح PG16 | 41479463527 | 1/1، 0 فشل |
| Surface protocols (كل تشغيل) | — | 32/32 |
| مصفوفة claude-integration (PG16) | 41480720329 | **263 ناجح، 0 فشل، 1 متجاوز** (السطر الحي لـTLS) |
| مصفوفة claude-integration (PG18، بعد إعادة) | 41480720329 | **274 ناجح، 0 فشل، 1 متجاوز** منها هجرة الإصدار 11/11 |
| wave09 معزولًا PG18 | 41481775353 | 19/19 |
| qoder-security (audit/build/codegen) | 41479903909 | 3/3 مهام؛ 0 ثغرات، `CODEGEN_DRIFT=0`، فحص 304 commits بلا أسرار |

هجرة الإصدار على PG18: «a fresh PostgreSQL database receives exactly the 51 reviewed migrations, then is current» — 11/11، و8 منافسين متزامنين انتهوا كلهم `LOCKED+MIGRATED`.

## 11 — الأثر الأمني
- لا ضعف في أي حارس مصادقة أو سعر أو دفع. إصلاح `smart-turn` يزيل حقلًا قيمته `null` من سياق نموذج الموظف؛ لا تسريب ولا تغيير في صلاحيات D4/D5.
- `pnpm audit`: `{info:0, low:0, moderate:0, high:0, critical:0}`، `BLOCKING_VULNERABILITIES=0`.
- gitleaks + فحص أنماط الاعتماد: `HEAD_MATCH_FILES` فارغ، `HISTORY_SCAN_COMMITS=304 MATCHES=0`، لا ملفات `.env` متتبَّعة.
- ملاحظة مفتوحة من W12.2 (N7): حصّة المصادقة مفتاحها IP — قرار مالك لم يُمَس.

## 12 — الأثر على قاعدة البيانات
لا تغيير في المخطط أو الهجرات أو الـmanifest أو الـguard. كل الاختبارات على قواعد disposable داخل `127.0.0.1` بأسماء `dinar_test_local_*`.

## 13 — الأثر على الأداء
لا أثر قابل للقياس؛ إعادة ترتيب حساب واحد (`marketingFacts`) لا تضيف استعلامًا ولا تلغيه.

## 14 — المخاطر المتبقية
- `qoder/17` (+41 commitًا) و`qoder/15` (+13) و`codex/11` (+7) غير مدمجة؛ `claude/12` و`claude/13` مدمجتان بالكامل (behind=0).
- لقطات drizzle الناقصة تعيق `drizzle-kit generate` النظيف على التاريخ القديم؛ التوليد يجب أن يبدأ من رأس `0050` على الفرع المدمج.
- A01-06/A01-07/A01-08 أعلاه قرارات مالك/Replit، لا إصلاحات صامتة.
- A01-12 تذبذب واحد غير مُعاد إنتاجه: يحتاج حارس تذبذب أو ثلاث تشغيلات متتالية عند أول ظهور آخر.

## 15 — توافق Replit
- التصحيحات مبنية على `1a194fe` وتطبَّق بلا تعارض ما دام Replit لم يعدّل `smart-turn.ts` أو قائمة السماح في الـworkflow.
- لا تغيير هجرة ⇒ لا تصادم أرقام.
- إن عدّل Replit منطقة `modelContext`، فالمنقول اليدوي هو نقل حساب `marketingFacts` قبل `return` واستبدال الفرع القديم.

## 16 — تعليمات الدمج الدقيقة
1. راجع `fix(d4)` أولًا (تغيير سلوكي واحد) ثم CI ثم الوثائق:
   `git cherry-pick 1b4adf3 eb3f235 8e6f941` على فرع Replit الحالي.
2. أعِد تشغيل `business-delegations.test` على PG16 وPG18 و`d5-seller-employee-acceptance.test` على SHA المدمج.
3. إن ظهر تعارض في `smart-turn.ts`، أعِد التطبيق يدويًا بنفس الدلالة ولا تُبقِ `sellerListing: null`.
4. لا تدمج إلى `main` ولا تنشر.

## 17 — روابط GitHub
- الفرع: https://github.com/qurankream0987-eng/dinar-pro/tree/qoder/a01-baseline-audit
- المقارنة مع الأساس: https://github.com/qurankream0987-eng/dinar-pro/compare/1a194fe...qoder/a01-baseline-audit
- commits: `/commit/eb3f235`, `/commit/8e6f941`, `/commit/1b4adf3`
- التشغيلات: `/actions/runs/41476282104`, `/actions/runs/41477787830`, `/actions/runs/41478249183`, `/actions/runs/41478775028`, `/actions/runs/41479463527`, `/actions/runs/41479903909`, `/actions/runs/41480720329`, `/actions/runs/41481775353`

---

## تصنيف الأدلة
| البند | التصنيف |
|---|---|
| اتساق السجل/الـmanifest/الحارس (51/51/51، 0 بصمة خاطئة، 23/23 حارسًا) | **VERIFIED** |
| فشل D4 على الرأس وإصلاحه على PG16/PG18 | **VERIFIED** |
| قفل الاعتماديات + `pnpm audit` + codegen + gitleaks | **VERIFIED** |
| مصفوفة PG16/PG18 وهجرة الإصدار 51 | **VERIFIED** |
| تذبذب wave09 على PG18 | **PARTIAL** (فشل واحد غير مُعاد إنتاجه) |
| لقطات drizzle الناقصة | **PARTIAL** (عدّ مؤكد، أثر التوليد غير مشغَّل) |
| اختبار TLS الحي | **NOT_RUN** (يتجاوز في CI، لا هدف TLS على loopback) |
| قاعدة المالك/preview | **BLOCKED** (خارج التكليف، لا صلاحية) |

**لا تدّعي هذه الوثيقة اكتمال قبول المشروع ولا جاهزية الإطلاق. لم تُنفَّذ أي عملية دمج أو نشر.**
