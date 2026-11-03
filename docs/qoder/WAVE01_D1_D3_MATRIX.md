# WAVE 01 — D1 + D2 + D3 — مصفوفة الأدلة والتحقق المستقل

- المستودع: `qurankream0987-eng/dinar-pro`
- الفرع القانوني (canonical): `replit/dinar-next-complete-development`
- آخر SHA مُلاحظ قبل البدء: `ae8399b4436c9905a63e9e92ec9b1e1368690d98`
- فرع التنفيذ المعزول: `qoder/wave01-d1-d3-closure` (worktree منفصل، لا يلمس فرع Replit)
- SHA الكود المُختبر: `28f7a3b` — إضافة `3051c78` (توسيع allowlist في CI فقط) لا تغيّر أي كود تشغيل
- تاريخ التنفيذ: 2026-11-02

## 0. رموز الحالة

| الرمز | المعنى |
| --- | --- |
| `VERIFIED_COMPLETE` | تحقق مستقل بكود + اختبار تنفيذي (API وقاعدة بيانات) ونجاح CI |
| `IMPLEMENTED_NOT_VERIFIED` | موجود في الكود، لكن لا يوجد له دليل تنفيذ في هذه الموجة |
| `PARTIAL` | مغطى جزئيًا مع فجوة موثقة |
| `MISSING` | غير موجود |
| `BLOCKED` | موجود لكنه متوقف على مورد/موافقة خارجية |
| `NOT_APPLICABLE` | خارج نطاق الموجة |

## 1. Gate 0 — خط الأساس والملكية

| البند | الدليل |
| --- | --- |
| `fetch` لكل الفروع قبل البدء | canonical انتقل من `5d9bca1` إلى `ae8399b` |
| مراجعة تعارض الملكية مع Replit | `ae8399b` يمسّ `ai/model-gateway.ts` (fallback) و`ai/tool-registry.ts` (`compareListings`)؛ لا يمسّ وحدات D1/D2/D3 |
| فرع معزول | `qoder/wave01-d1-d3-closure` في `dinar-wt-wave01`، مبني على `ae8399b` |
| migrations | 0046 (D1/D2)، 0047 (ربط الإعلان بالنشاط)، 0048 (D3 operating profile)، 0049 (D4)، 0050 |
| CI | `.github/workflows/qoder-api-suite.yml` — PostgreSQL 16/18 على loopback فقط، `outbound=0`، نماذج محظورة في D3-A |

## 2. D1 — الأساس

| المتطلب | الحالة | الدليل التنفيذي / الكود |
| --- | --- | --- |
| المصادقة والجلسات | `VERIFIED_COMPLETE` | `lib/auth.ts`: scrypt N=32768، رمز جلسة SHA-256، كوكي hex 64، انتهاء + حالة الحساب + تحقق الهاتف، CSRF origin. `api.test` (جلسات منتهية ومرفوضة) + `security-acceptance` (رفض المجهول) |
| إنشاء السوق ونطاقه | `VERIFIED_COMPLETE` | `marketFor`/`assertMarketActive`؛ `security-acceptance`: «ownership, draft privacy, and market boundaries» |
| ملكية المستخدم | `VERIFIED_COMPLETE` | هوية البائع من الجلسة لا من الجسم؛ D3A-35؛ `security-acceptance` |
| هوية المحادثة القانونية | `VERIFIED_COMPLETE` | `conversations` بقيود الشكل وفرادة `(id, ownerUserId, marketId)`؛ محادثة الطلب تُنشأ بمعرّف الطلب؛ D2-15 وD3A-40 (إعادة التحميل من الخادم) |
| دورة حياة الإعلان | `VERIFIED_COMPLETE` | `lib/listing-management.ts` (قفل صف + `updatedAt` تفاؤلي)؛ D3A-25/26/27/39 |
| أسس البحث | `VERIFIED_COMPLETE` | `search-sql-foundation` (نجاح)؛ D3A-28 (الاكتشاف فقط عبر `searchMarketplaceListings`) |
| الطلبات وحدود المعاملة | `VERIFIED_COMPLETE` بعد إصلاح | معاملة واحدة تشمل الطلب والبنود والحدث المالي والمحادثة والحجز وتفريغ السلة؛ **إصلاح R2**؛ D3A-43، `block-f3-commerce`، `financial-state-machine`، `payment-order-state`، `wave4-payment-acceptance` |
| الإجراءات المعلّقة | `VERIFIED_COMPLETE` | `ai_result_sets` بحالات D12 + `FOR UPDATE` + lease؛ D3A-17/19/24؛ `d12-execution-recovery` |
| التكرار الآمن | `VERIFIED_COMPLETE` | `checkoutRequests` (مفتاح + بصمة طلب، 409 عند اختلاف البيانات)؛ D3A-43 إعادة الإرسال تعيد نفس الطلبين؛ D2-11 |
| عقود API | `VERIFIED_COMPLETE` | D2-19: كل مسارات D1/D2/D3 لها عقد OpenAPI |
| سلامة قاعدة البيانات | `VERIFIED_COMPLETE` | قيود `order_money_valid`، `offers_business_owner_guard_row`، append-only للأحداث؛ D3A-37/38 |

## 3. D2 — التحقق من النشاط

| المتطلب | الحالة | الدليل |
| --- | --- | --- |
| تسجيل النشاط | `VERIFIED_COMPLETE` | D2-02..04 (DRAFT، المالك من الجلسة، بدون اشتراك) |
| تمييز الفردي/الاعتباري | `VERIFIED_COMPLETE` | `BUSINESS_DOCUMENT_POLICY`: KW `SOLE_PROPRIETORSHIP` أي من (رخصة/سجل)، `COMPANY`/`PARTNERSHIP` سجل تجاري، غير ذلك رخصة+سجل؛ D2-06 |
| مستندات التحقق والتخزين الخاص | `VERIFIED_COMPLETE` (للخصوصية) / `BLOCKED` (للإنتاج) | D2-07/08: خاصة، مقصورة على المالك، فحص النوع، لا تظهر في أي استجابة عامة؛ الفحص الفعلي `SCANNER_NOT_CONNECTED` |
| حالة المراجعة | `VERIFIED_COMPLETE` | D2-06 وD2-20 (PENDING→REJECTED/VERIFIED، سبب إلزامي، أحداث append-only) |
| إلغاء/سحب التحقق | `VERIFIED_COMPLETE` | `decideBusinessVerification` هو الكاتب الوحيد؛ SUSPEND/REINSTATE في D2-12..14 |
| التعليق | `VERIFIED_COMPLETE` | D2-12..14 + D3A-33 (اختفاء النشاط من المتجر والبحث والسلة والدفع) |
| سلطة الموافقة الإدارية | `VERIFIED_COMPLETE` | مراجع ADMIN ≠ المالك (SELF_REVIEW_FORBIDDEN، D2-06) |
| سجلات التدقيق | `VERIFIED_COMPLETE` | `business_verification_events` append-only (UPDATE/DELETE/TRUNCATE مرفوضة، D2-06) |
| قيود إعلانات النشاط | `VERIFIED_COMPLETE` | D2-05/D2-10 (لا تعليق VERIFIED بالنص)، D3A-10 (غير موثق لا ينشر) |

### 3.1 موانع إنتاج D2 (لا تُعتبر مكتملة قانونيًا)

1. لا فاحص برمجيات خبيثة موصول (`SCANNER_NOT_CONNECTED`).
2. تشفير التخزين غير مُتحقق منه في الإنتاج.
3. مهمة حذف المستندات بعد `retainUntil` (365 يومًا) غير منفذة.
4. لا يوجد مراجع امتثال منفصل عن ADMIN.
5. لا مزود فواتير/اشتراك حقيقي.
6. `legallyReviewed: false` — لا ادعاء امتثال قانوني.

## 4. D3-A / D3-B / D3-C

التقسيم أدناه هو تقسيم تدقيق هذه الموجة (المهمة لم تُسمِّ B/C مسبقًا في الوثائق):

### D3-A — النشاط الأصلي داخل DINAR

| المتطلب | الحالة | الدليل |
| --- | --- | --- |
| ملفات تشغيل النشاط | `VERIFIED_COMPLETE` | `business_operating_profiles` (INTERNAL_DINAR فقط، مفتاح مركّب لهوية D2، لا عمود هوية)؛ D3A-01/38 |
| مراجعة الدشبورد/التشغيل | `VERIFIED_COMPLETE` | D3A-03/05/06 (سؤال واحد في كل مرة، مراجعة قبل التفعيل، «أكد» مرة واحدة) |
| إنشاء الكتالوج وتحريره | `VERIFIED_COMPLETE` | D3A-15/16 (مسودات مصنّفة، وحدات صغرى دقيقة)، D3A-39 (تحرير يحفظ الملكية) |
| مراجعة المسودة والنشر | `VERIFIED_COMPLETE` | D3A-17/18/19/20/22/23/24 (مراجعة → تأكيد → نشر عبر `createListingForActor` فقط) |
| صلاحيات النشاط | `VERIFIED_COMPLETE` | D3A-09/13/14/36 (لا سلطة من الجسم أو النموذج؛ D2 مصدر التحقق) |

### D3-B — الربط بالسوق

| المتطلب | الحالة | الدليل |
| --- | --- | --- |
| روابط إعلانات النشاط | `VERIFIED_COMPLETE` | `offers.business_profile_id` + trigger يمنع ربط نشاط آخر/سوق آخر؛ D3A-18/34 |
| صحة المخزون | `VERIFIED_COMPLETE` | D3A-27 (نفاد عبر PAUSE القانوني)، حجز بحدود، `applyInventoryModeUpdate` يمنع أقل من المحجوز |
| واجهة المتجر | `VERIFIED_COMPLETE` | D3A-32/33 (حقول بيضاء فقط، تعليق يخفي المتجر والبحث والسلة والدفع) |
| طلبات النشاط | `VERIFIED_COMPLETE` بعد إصلاح | **إصلاح R1**: `businessOrders` يقصر المال على بنود النشاط؛ D3A-42 (طلبان لنشاطين لدى بائع واحد، كل بطاقة تعرض بندها فقط ومجموع التوزيع = إجمالي الطلب ±1) |
| حدود معاملة الدفع | `VERIFIED_COMPLETE` بعد إصلاح | **إصلاح R2**: تقسيم بنود البائع المختلفة السعر إلى طلبات لكل سعر تحقق `order_money_valid`؛ D3A-43 |

### D3-C — التدقيق والاسترداد والمطابقة

| المتطلب | الحالة | الدليل |
| --- | --- | --- |
| تدقيق النشاط | `VERIFIED_COMPLETE` | `business_audit_events` append-only (D3A-37)، وأحداث متجر/نشر/تحديث/تعليق |
| مطابقة الإعلانات بالكتالوج | `VERIFIED_COMPLETE` | بطاقة الكتالوج من صفوف الخادم (D3A-21)، الإحصاءات من نفس الصفوف (D3A-31)، والتحرير لا يفقد اللقطة (D3A-39) |
| الاسترداد بعد إعادة التحميل | `VERIFIED_COMPLETE` | D3A-40: كل الأسطح الثمانية تعيد بناء البطاقة من الخادم بمعرّف ثابت بعد إعادة تحميل المحادثة |
| الاسترداد بعد إعادة التشغيل | `VERIFIED_COMPLETE` | الحالة كلها في PostgreSQL؛ الإجراءات المعلّقة تسترد عبر lease في D12 (`d12-execution-recovery`) |
| الاختيار بين أنشطة متعددة | `VERIFIED_COMPLETE` | D3A-41 (لا اختيار صامت) |
| عدم وجود محرك ثانٍ | `VERIFIED_COMPLETE` | كل كتابة إعلان تمر عبر `createListingForActor`/`updateOwnedListing`/`changeOwnedListingStatus`/`archiveOwnedListing`؛ الطلبات عبر `checkout` واحد فقط |

## 5. الإصلاحات المؤكدة في هذه الموجة

| # | الملف | الإصلاح | الاختبار |
| --- | --- | --- | --- |
| R1 | `artifacts/api-server/src/lib/business-catalog.ts` | `businessOrders` يجمع كميات/مبالغ بنود النشاط فقط (انضمام `offers.business_profile_id`) ويوزّع العمولة النسبية للعرض؛ صف الطلب واللقطة المالية لا يتغيران | D3A-42 |
| R2 | `artifacts/api-server/src/routes/marketplace.ts` | عند دفع بائع واحد بأسعار مختلفة: تقسيم إلى طلب لكل سعر (الطلب يحمل سعرًا واحدًا) بدل 500 من `order_money_valid`؛ الأسعار المتساوية تبقى طلبًا واحدًا | D3A-43 + D3A-42 |
| T1 | `artifacts/api-server/test/d1-d2-business-foundation.test.ts` | D2-20: رفض التحقق لا ينشر ولا يمنح VERIFIED_OWNER ويحفظ السبب ويسمح بإعادة التقديم؛ توسيع D2-19 لمسارات المتجر والتفويض | D2-20، D2-19 |
| C1 | `.github/workflows/qoder-api-suite.yml` | allowlist: `BDINAR_D3A_D2_FIXTURES` وإضافة `api.test` (مع بقاء قيود القيم) | تشغيل CI |

## 6. أدلة CI (كل التشغيلات على `127.0.0.1` فقط، `outbound=0`)

| المجموعة | PostgreSQL | Run | النتيجة |
| --- | --- | --- | --- |
| `d1-d2-business-foundation.test` | 16 | 41534229740 | نجاح — 26 تأكيدًا |
| `d1-d2-business-foundation.test` | 18 | 41534240880 | نجاح |
| `d3a-native-business.test` | 16 | 41534215112 | نجاح — `D3A_SUMMARY passed=43 total=43` |
| `d3a-native-business.test` | 18 | 41534221867 | نجاح — 43/43 |
| `d1-d2-business-browser.test` | 16 | 41534317059 | نجاح (Chromium حقيقي) |
| `d3a-browser-journey.test` | 16 | 41534307374 | نجاح (Chromium حقيقي) |
| `block-f3-commerce.test` | 16 | 41534289208 | نجاح |
| `commerce-journey.test` | 16 | 41534296110 | نجاح |
| `universal-negotiation-acceptance.test` | 16 | 41534708981 | نجاح |
| `wave4-payment-acceptance.test` | 16 | 41534722376 | نجاح |
| `payment-order-state.test` | 16 | 41534728472 | نجاح |
| `security-acceptance.test` | 16 | 41533297708 | نجاح |
| `financial-state-machine.test` | 16 | 41533313230 | نجاح |
| `search-sql-foundation.test` | 16 | 41531593261 | نجاح |
| `d4-d5-authorization` (3 مجموعات) | 16 | 41531584469 | نجاح |
| `d12-execution-recovery.test` | 16 | 41535342810 | نجاح |
| `api.test` | 16 | 41535205798 | نجاح |

كل تشغيل يسبقه `pnpm typecheck` + بناء api-server + بناء web + `test:surfaces`، لذا فالنجاح يشمل سلامة الأنواع والبناء والعقود.

## 7. أدلة قاعدة البيانات

- قاعدة بيانات عابرة `dinar_test_local_<random>` تُنشأ وتهاجر وتُزرع لكل مجموعة ثم تُحذف.
- تأكيدات مباشرة على الصفوف: `business_profiles`، `business_memberships`، `business_verification_events`، `business_operating_profiles`، `offers.business_profile_id`، `business_audit_events`، `orders`/`order_items` — موضحة داخل الاختبارات (مثلاً D2-20، D2-06، D3A-18، D3A-42، D3A-43).
- قيود أثبتت سلوكها في التنفيذ: `order_money_valid`، `offers_business_owner_guard_row`، append-only triggers، رفض أعمدة الهوية في D3A-38.

## 8. الموانع المتبقية

1. موانع D2 الإنتاجية الستة في §3.1 — تحتاج مزودين وموافقة مالك/مراجعة قانونية.
2. `legallyReviewed: false` متعمّد؛ لا ادعاء امتثال.
3. لا تفعيل دفع حقيقي (SIMULATION_ONLY يبقى).
4. الدمج في الفرع القانوني أو main يحتاج تفويضًا منفصلًا من المالك/Replit (غير ممنوح في هذه المهمة).

## 9. تعليمات الدمج

1. لا دمج إلى `main` ولا إلى `replit/dinar-next-complete-development` بدون تفويض مالك منفصل.
2. الفرع المنشور: `qoder/wave01-d1-d3-closure` — الكوميتات: `9fca927` (R1 + D3A-42)، `9f275b8` (T1 + C1)، `66f186d` (تصحيح حصة D2-20 + تشخيص مؤقت)، `28f7a3b` (R2 + D3A-42/43 النهائيان)، `3051c78` (api.test في CI)، ثم هذا الملف.
3. `66f186d` يحتوي تشخيصًا مؤقتًا أُزيل في `28f7a3b`؛ الدمج المستحسن squash أو إعادة ترتيب بحيث لا يبقى التشخيص.
4. الملفات المتغيرة: `business-catalog.ts`، `routes/marketplace.ts`، اختبارا D1/D2 وD3-A، سير عمل CI، ووثيقة الأدلة هذه. لا تغيير في schema/migrations.
5. إعادة التحقق عند الدمج: تشغيل نفس المجموعات على PG16/18 مع الأعلام المذكورة في §6.
