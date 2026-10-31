# DINAR NEXT — الموجة 09: السياسات، الرضا، التحقق من البائع، وحماية القُصّر

**الفرع:** `qoder/parallel-w07-w12-ultra`
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873` + W07 (`09e8941`) + W08 (`20ed66e`)
**بيئة العمل:** `D:\DINAR\dinar-w0712`
**الحالة:** التنفيذ مكتوب ومراجَع ستاتيكيًا. **التشغيل الفعلي BLOCKED** لغياب `node_modules` و PostgreSQL محليًا، ولأن دفع الفرع إلى CI يحتاج إذن المالك بالنشر. لا اختبار أخضر مُختلق. لا نص قانوني معتمد مُختلق.

> **قاعدة الصدق:** لا توجد في هذه الموجة موافقة قانونية واحدة، ولا كيان قانوني مفعّل، ولا بائع موثّق، ولا قاصر مفعّل افتراضيًا. كل ما تفعله W09 هو تسجيل دورة حياة وقرارات صريحة، وترك بوابات الحماية **مغلقة افتراضيًا** حتى يُفعّلها المالك لكل سوق على حدة.

---

## 1. ما لا تدّعيه هذه الموجة

| الادعاء الممنوع | الموقف الفعلي |
|---|---|
| «السياسات معتمدة قانونيًا» | الصياغة تبقى في `lib/policies.ts` بحالة `PENDING_LEGAL_APPROVAL`. سجل النسخ لا يقبل `APPROVED` إلا بمرجع خارجي من المراجعة القانونية، ولا يوجد أي مرجع مزروع. |
| «الكيان القانوني قائم» | جدول `legal_entities` يبدأ فارغًا. لا تزرع أي migration اسم شركة أو بلد تسجيل. أي كيان يُنشأ يكون `DISABLED` وبلا صلاحيات. |
| «السوق مفعّل تجاريًا» | `commercialActivation: "REQUIRES_OWNER_AUTHORIZATION"` في كل قراءة إدارية. بوابة الكيان القانوني لا تعمل إلا إذا فعّلها المالك عبر `legalEntityRequired`. |
| «التحقق من البائع مانع للاحتيال» | التوثيق قرار بشري بأساس مخاطر (`LOW/MEDIUM/HIGH`)، ويبدأ `UNASSESSED`. لا يوجد «توثيق تلقائي» ولا «بائع موثّق افتراضيًا». |
| «القاصر محمي بالكامل» | الإقرار العمري تصريح ذاتي، لا تحقق هوية. موافقة ولي الأمر تُسجّل عبر حساب آخر مع مرجع مُجزّأ (SHA-256)، وليست تحققًا من صلة القرابة. |
| «رسالة النموذج موافقة» | لا يوجد أي مسار يقبل مصدرًا من نص محادثة. حقل `source` مقيد بالمخطط إلى `POLICY_REVIEW` أو `API`، وقيم `SIGNUP` تُكتب فقط من مسار التسجيل في الخادم. |

---

## 2. REUSE — ما لم يُعد بناؤه

| القدرة | المالك القائم | الاستخدام في W09 |
|---|---|---|
| نصوص السياسات وإصداراتها | `artifacts/api-server/src/lib/policies.ts` | لم يُعدّل أي نص. أضيف فقط هاش المحتوى وحالة دورة الحياة. |
| موافقات التسجيل | `lib/auth.ts` + `policy_acceptances` | بقي الجدول كما هو، وأصبح كل تسجيل يكتب أيضًا حدث رضا بحجيته. |
| حقوق البيانات | `lib/privacy-rights.ts` | أضيف سجل الرضا إلى التصدير والملخص؛ لا تغيير في الاحتفاظ. |
| أهلية السوق والتصنيفات | `lib/markets.ts` + `routes/marketplace.ts` | أضيفت ثلاث بوابات داخل `assertMarketPolicy` وبوابة مشترٍ في checkout. |
| مصادقة الإدارة | `users.role` + فحص `ADMIN` | أضيف `assertAdminActor` كسلطة مشتركة للمسارات والدوال. |
| آلة حالات الطلب والدفع | W07/W08 | لم تُلمس. |

---

## 3. الفجوات التي عالجتها W09

| # | الفجوة | العلاج |
|---|---|---|
| G9.1 | لا سجل دورة حياة للسياسة: الإصدار ثابت ولا يُعرف من راجعه أو نشره | `policy_registry_versions` بانتقالات `DRAFT → LEGAL_REVIEW → APPROVED → PUBLISHED → SUPERSEDED`، وحارس قاعدة بيانات يرفض القفز والتعديل العكسي والحذف. |
| G9.2 | الموافقة كانت صفًا واحدًا بلا هوية سياسة/إصدار/هاش وبلا سجل تراجعي | `policy_consent_events` **إلحاقي فقط**: `ACCEPTED/DECLINED`، المصدر، مفتاح تكرار، وهاش المحتوى. |
| G9.3 | لا بوابات تحقق بائع أو حماية قاصر قابلة للتفعيل لكل سوق | `market_compliance_settings` بكل المفاتيح **معطّلة افتراضيًا**، وبوابة في مسار النشر ومسار الشراء. |
| G9.4 | لا سجل كيان قانوني لكل سوق، ولا فصل للصلاحيات | `legal_entities` بحالة `DISABLED` افتراضيًا وصلاحيات صريحة (`MARKETPLACE/PAYMENTS/COMMISSION/SUPPORT/DATA_CONTROLLER`). |
| G9.5 | التحقق من البائع غير موجود | `seller_verification_profiles`: تقديم، ثم قرار بشري بمرجّح مخاطر، مع منع البائع من البت في طلبه. |
| G9.6 | لا إقرار عمري ولا مسار ولي أمر | `minor_protection_declarations` إلحاقي: التصريح الذاتي يبقى، وقرار ولي الأمر يُضاف كصف لاحق ولا يُعيد كتابة التصريح. |
| G9.7 | تصدير البيانات لم يكن يشمل قرارات السياسات | أضيف `policyConsentEvents` إلى التصدير و`policyConsents` إلى الملخص. |

---

## 4. التنفيذ

### 4.1 البيانات والقيود

- `lib/db/src/schema/index.ts:2615` — `policyRegistryVersions`: هاش `content_sha256` بصيغة `64 hex`، تاريخ سريان `YYYY-MM-DD`، نطاق `GLOBAL` أو سوق محدد، وقيد `state_valid` يربط الحالة بأزمنة الفاعلين.
- `lib/db/src/schema/index.ts:2671` — `policyConsentEvents`: فريد `(user, idempotencyKey)`، وقيد قرار/مصدر/هاش.
- `lib/db/src/schema/index.ts:2710` — `legalEntities`: فريد لكل سوق، `status IN (DISABLED, ACTIVE)`، وقيد `active_valid` يشترط صلاحية واحدة على الأقل وفاعلًا ووقتًا عند التفعيل.
- `lib/db/src/schema/index.ts:2760` — `marketComplianceSettings`: `sellerVerificationRequired`, `minorProtectionEnabled`, `minimumAge` (13–21), `guardianConsentRequired`, `legalEntityRequired` — كلها `false` افتراضيًا، وقيد يمنع موافقة ولي الأمر بلا حماية قاصر.
- `lib/db/src/schema/index.ts:2794` — `sellerVerificationProfiles`: `decision_valid` يشترط `decided_by <> user_id`، وسببًا إلزاميًا عند الرفض.
- `lib/db/src/schema/index.ts:2861` — `minorProtectionDeclarations`: قيد `state_valid` يفرّق بين التصريح الذاتي وقرار ولي الأمر (هاش + وقت إلزاميان في الثاني).

### 4.2 الترحيل 0043

- `lib/db/drizzle/0043_wave09_policy_consent_compliance.sql:1,31,46,69,83,107` — الجداول الستة والقيود.
- `:154` — `policy_registry_versions_guard`: يرفض DELETE/TRUNCATE، ويشترط بدء الإدراج كـ`DRAFT`، ويثبّت وقائع النسخة (المفتاح، الإصدار، الهاش، تاريخ السريان، النطاق)، ويمنع تعديل مرجع قانوني مُعتمد، ويسمح فقط بالانتقالات الأمامية، ويشترط مرجعًا عند `APPROVED`، وناشرًا ووقتًا عند `PUBLISHED`.
- `:214` — `policy_consent_events_guard`: إلحاقي تمامًا (UPDATE/DELETE/TRUNCATE مرفوضة).
- `:234` — `legal_entities_guard`: إنشاء `DISABLED` فقط وبصلاحيات فارغة، هوية غير قابلة للتعديل، انتقال `DISABLED↔ACTIVE` فقط، وتفعيل يشترط صلاحية وفاعلًا ووقتًا، وتعطيل لا يغيّر الصلاحيات.
- `:288` — `market_compliance_settings_guard`: لا حذف، والسوق غير قابل للتغيير.
- `:308` — `seller_verification_profiles_guard`: وقائع ثابتة، `PENDING → VERIFIED/REJECTED` فقط، ومُقرّر ≠ البائع.
- `:346` — `minor_protection_declarations_guard`: إلحاقي تمامًا.
- `lib/db/drizzle/meta/_journal.json` — `idx 43`، و`release-manifest.json` و`clone-migration-guard.ts` يحملان هاش الملف `29127432…12316`؛ عدد المدخلات المتوقع صار **44**.
- فحص التدمير عبر محاكاة `release-migration.ts` بـPerl: **182 مقتطفًا، 0 تطابق تدميري** (لا `DROP`/`TRUNCATE`/`DELETE FROM` في بداية مقتطف).

### 4.3 محرك السياسات

`artifacts/api-server/src/lib/policy-lifecycle.ts`:

| الدالة | السطر | السلوك |
|---|---|---|
| `policyContentSha256` | 43 | هاش قانوني ثابت للصياغة (المفتاح، الإصدار، العنوان، الملخص، الأقسام) — أي تغيير نصي يغيّر الهاش. |
| `registerPolicyVersion` | 152 | إداري فقط؛ يرفض إصدارًا لا وجود لصياغته في الكود؛ يعيد الصف القائم بدل تكراره. |
| `transitionPolicyVersion` | 226 | انتقالات صريحة فقط؛ `APPROVE` يشترط مرجعًا خارجيًا؛ `PUBLISH` يرفض النشر قبل تاريخ السريان ويستبدل الإصدار المنشور السابق. |
| `recordPolicyDecision` | 324 | قرار صريح واحد لكل مفتاح؛ المصدر يحدده الخادم؛ رفض سياسة إلزامية مرفوض؛ تكرار المفتاح بقرار مختلف مرفوض. |
| `policyConsentStatus` | 425 | يجمع المطلوب/الاختياري، وملخص التغييرات الجوهرية غير المقبولة، و`consentEvidence: "EXPLICIT_USER_ACTION_ONLY"`. |
| `signupConsentRows` | 512 | صفوف رضا التسجيل بنفس هاش وإصدار ما يقبله الـAPI. |

قاعدة الانتقال: حتى يوجد إصدار منشور في السجل، الإصدار المقبول هو الإصدار المدمج الحالي (اليوم `2026-10-02`، `PENDING_LEGAL_APPROVAL`). بعد النشر، لا يُقبل غيره، ولا تُعاد كتابة قبول قديم.

### 4.4 محرك الامتثال

`artifacts/api-server/src/lib/compliance.ts`:

| الدالة | السطر | السلوك |
|---|---|---|
| `complianceSettings` | 76 | غياب الصف = كل الحمايات معطلة، و`configured: false` (ليس «معتمدًا»). |
| `updateComplianceSettings` | 92 | إداري فقط؛ العمر 13–21؛ ولي الأمر بلا حماية قاصر مرفوض. |
| `createLegalEntity` | 185 | إداري؛ ينشئ `DISABLED` بلا صلاحيات؛ اسم/نوع/بلد مُتحقّق منها؛ لا تكرار لسوق. |
| `activateLegalEntity` | 234 | صلاحيات من قائمة بيضاء فقط، وواحدة على الأقل. |
| `deactivateLegalEntity` | 266 | لا يغيّر الصلاحيات، ويسجل الفاعل والوقت. |
| `requireCommercialCapability` | 296 | لا تعمل إلا حيث `legalEntityRequired`؛ تعيد `enforced: false` وإلا. |
| `submitSellerVerification` | 368 | يبدأ `PENDING` و`UNASSESSED`؛ مراجع ≤5. |
| `decideSellerVerification` | 422 | إداري، ليس البائع؛ `VERIFIED` يشترط أساس مخاطر؛ `REJECTED` يشترط سببًا. |
| `assertSellerVerification` | 482 | تفرض التوثيق فقط عند تفعيله للسوق. |
| `declareAgeStatus` | 548 | تصريح ذاتي إلحاقي؛ لا تغيير من قاصر مسجل إلى بالغ؛ قرار ولي الأمر لا يُستبدل بتصريح. |
| `recordGuardianConsent` | 624 | ولي الأمر حساب آخر؛ مرجع 3–200 حرف يُخزّن مُجزّأً فقط؛ يشترط تصريح قاصر سابقًا. |
| `assertMinorProtection` | 700 | بالغ يمر؛ قاصر بلا مسار ولي يُمنع؛ قاصر بدون `GRANTED` يُمنع. |
| `marketComplianceOverview` | 758 | يعرض ما هو مسجل فقط، مع `REQUIRES_OWNER_AUTHORIZATION`. |

### 4.5 واجهات البرمجة

`artifacts/api-server/src/routes/compliance.ts` — المستخدم: `/account/policy-consents`، `/account/policy-decisions`، `/account/compliance`، `/account/age-declaration`، `/account/guardian-consent`، `/account/seller-verification`، وقراءة عامة محدودة `/markets/:marketId/compliance`. الإدارة (خلف `requireAdmin` على `/admin/compliance`): السجل (`GET/POST` + `/:id/transition`)، طوابير التوثيق وقرارها، إعدادات السوق (`GET/PUT`)، وسجل الكيانات (`GET/POST` + `activate/deactivate`).

`artifacts/api-server/src/routes/trust-safety.ts:56` — `/policies` و`/policies/:key` صارا يعيدان `contentSha256` و`lifecycle`؛ و`:88` `/account/policy-acceptances` يقرأ من محرك الرضا؛ و`:93` الكتابة تمر عبر `recordPolicyDecision` بمصدر `POLICY_REVIEW` (لم يبقَ إدراج مباشر في جدول الموافقات).

### 4.6 الربط التشغيلي

- `lib/markets.ts:68` — `assertSellerVerification` ثم `assertMinorProtection` ثم `requireCommercialCapability(MARKETPLACE)` لكل نشر/عرض.
- `routes/marketplace.ts:647` — بوابة المشتري `assertMinorProtection` وبوابة `PAYMENTS` قبل أي طلب.
- `lib/auth.ts:510` — كل تسجيل يكتب أحداث الرضا الإلحاقية إلى جانب جدول الموافقات.
- `lib/privacy-rights.ts:468` — التصدير يضم `policyConsentEvents`، والملخص يعرض عدّاد `policyConsents`.

---

## 5. عقد الرضا لبطاقات Claude (LOGIN / SIGNUP / POLICY_REVIEW)

هذه هي الواجهة التي تستهلكها بطاقات المحادثة، ولا تحتاج Claude إلى أي منطق تجاري:

1. **قراءة الحالة:** `GET /api/account/policy-consents` يعيد `required[]` و`optional[]` و`pendingRequired[]` و`materialUpdates[]`. كل بند يحمل `contentSha256` و`lifecycle` (قد تكون `NOT_REGISTERED` — وهذا صادق).
2. **قرار صريح:** `POST /api/account/policy-decisions` بحقول `key`, `version`, `decision`, `idempotencyKey`، و`source` اختياري مقيد بـ`POLICY_REVIEW` أو `API`. **لا يوجد حقل لإرسال نص النموذج أو «فهمت».** زر واحد لكل سياسة، ولا خيار اختياري محدد مسبقًا: الغياب يعني `granted: null`.
3. **لا تغيير رجعي:** قرار يُسجَّل بهاش الإصدار؛ نشر إصدار جديد لا يعدّل صفوفًا قديمة، وقبول الإصدار المنشور مطلوب لاحقًا عبر `materialUpdates`.
4. **الرفض:** سياسة إلزامية لا يمكن رفضها والاستمرار (`409`). السياسة الاختيارية يمكن رفضها، ويُسجَّل الرفض بلا صف قبول.
5. **التكرار:** إعادة إرسال المفتاح نفسه تعيد الحدث ذاته (`200`)؛ استخدامه لقرار مختلف يعيد `409`.

> أي بطاقة تعرض «تمت الموافقة» بلا استدعاء هذا المسار تعرض ادعاءً غير مسجل. وأي بطاقة تجعل خيارًا اختياريًا محددًا افتراضيًا تخالف العقد.

---

## 6. اختبارات القبول المكتوبة

`artifacts/api-server/test/wave09-policy-consent-compliance.test.ts` — **17 اختبارًا**، سكربت `test:w09`، وبوابة موافقة `BDINAR_W09_ACCEPTANCE=development`:

| # | السطر | ما يثبته |
|---|---|---|
| 1 | 142 | `/policies` يحمل هاشًا وحالة `NOT_REGISTERED` قبل التسجيل. |
| 2 | 157 | التسجيل يكتب حدث رضا واحدًا لكل سياسة إلزامية بهاشها الصحيح. |
| 3 | 176 | القرار صريح وتكراري الآثار، والمصدر لا يأتي من النموذج (`MODEL`/`SIGNUP` عبر الـAPI → 400). |
| 4 | 223 | رفض سياسة إلزامية مرفوض؛ رفض اختيارية يُسجَّل بلا قبول. |
| 5 | 261 | مسار القبول القديم يكتب الآن حدثًا مُدقّقًا. |
| 6 | 296 | التسجيل إداري فقط ولا يقبل إصدارًا بلا صياغة في الكود. |
| 7 | 338 | القفز إلى `APPROVED` مرفوض، والموافقة تحتاج مرجعًا، والمرجع غير قابل للتعديل، والعودة للخلف محجوبة بالقاعدة. |
| 8 | 389 | النشر يُسجَّل والفئة العامة ترى `PUBLISHED`، والحذف وإدراج نسخة معتمدة مرفوضان. |
| 9 | 434 | الكيان يبدأ `DISABLED` بلا صلاحيات، ولا يمكن إدراجه مفعّلًا بـSQL خام. |
| 10 | 489 | بوابة الكيان لا تعمل قبل التفعيل، وتُغلق النشر عند التعطيل، وتفتحه عند منح `MARKETPLACE` فقط. |
| 11 | 521 | التوثيق يبدأ `PENDING/UNASSESSED`، والقرار إداري بلا `riskBasis` مرفوض، والبائع لا يوثّق نفسه، والرفض يحتاج سببًا، وقيد القاعدة يمنع `decided_by = user_id`. |
| 12 | 615 | الحماية معطلة افتراضيًا؛ وبدون إقرار مرفوض؛ وبعد إقرار بالغ يمر. |
| 13 | 633 | القاصر يُمنع حتى `GRANTED` من حساب آخر؛ المرجع يُخزّن هاشًا؛ لا قرار ثانٍ؛ ولا تحويل إلى بالغ. |
| 14 | 707 | `DENIED` يمنع، وموافقة ولي الأمر بلا تصريح قاصر مرفوضة. |
| 15 | 759 | بوابة المشتري تعمل في checkout بنفس الإقرار. |
| 16 | 795 | بدون مسار ولي أمر يُمنع القاصر قطعًا، ولا إقرار قاصر قبل تفعيل الحماية. |
| 17 | 821,844,876 | التصدير يضم سجل الرضا؛ الإعدادات لا تدّعي اعتمادًا؛ أحداث الرضا غير قابلة للتعديل أو الحذف. |

---

## 7. ما لم يُبنَ (حتى لا يُفهم كتفعيل)

- لا تحقق هوية للقاصر ولا لقاء ولي الأمر: الإقرار تصريح، والمرجع هاش لما قدّمه الحساب الآخر.
- لا تحقق رسمي من وثائق البائع: `evidenceRefs` مراجع نصية، والقرار بشري.
- لا تفعيل لأي سوق: كل مفاتيح `market_compliance_settings` تبدأ `false`، وبوابة الكيان `enforced: false` حتى يفعّلها المالك.
- لا نص قانوني جديد ولا تاريخ سريان معتمد: تاريخ السريان يبقى `2026-10-02` من `lib/policies.ts`.
- لا تغيير في مدد الاحتفاظ أو سياسات الخصوصية القائمة.
- لا نشر ولا دفع حقيقي ولا تفعيل إنتاجي.

---

## 8. حالة الأدلة

| البند | الحالة |
|---|---|
| تنفيذ الشيفرة والقيود والترحيل | ✅ مكتوب ومراجَع ستاتيكيًا |
| فحص SQL التدميري | ✅ 182 مقتطفًا، 0 تدميري (محاكاة Perl) |
| تطابق هاش 0043 بين الملف والمانيفست وحارس الاستنساخ | ✅ `29127432…12316` |
| تحديث توقعات `readiness.test` و`development-tls.test` إلى 44 مدخلًا | ✅ |
| تشغيل `pnpm test:w09` فعليًا | ❌ **BLOCKED** — لا `node_modules` ولا PostgreSQL محليًا، ولا دفع إلى CI بلا إذن المالك |
| اختبار المتصفح | ❌ لم يُنفَّذ؛ لا تغيير واجهة في هذه الموجة |
| انحدار W07/W08 و`commerce`/`marketplace` | ❌ مؤجّل إلى W11 (يتطلب نفس البيئة) |

---

## 9. ملفات W09

**جديدة**
- `lib/db/drizzle/0043_wave09_policy_consent_compliance.sql`
- `artifacts/api-server/src/lib/admin-authority.ts`
- `artifacts/api-server/src/lib/policy-lifecycle.ts`
- `artifacts/api-server/src/lib/compliance.ts`
- `artifacts/api-server/src/routes/compliance.ts`
- `artifacts/api-server/test/wave09-policy-consent-compliance.test.ts`
- `docs/dinar-next/QODER_W09_ULTRA_REPORT.md`

**معدّلة**
- `lib/db/src/schema/index.ts`
- `lib/db/drizzle/meta/_journal.json`
- `lib/db/drizzle/release-manifest.json`
- `lib/db/src/clone-migration-guard.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/api-server/src/lib/auth.ts`
- `artifacts/api-server/src/lib/markets.ts`
- `artifacts/api-server/src/lib/privacy-rights.ts`
- `artifacts/api-server/src/routes/marketplace.ts`
- `artifacts/api-server/src/routes/trust-safety.ts`
- `artifacts/api-server/test/safe-development-database.ts`
- `artifacts/api-server/test/readiness.test.ts`
- `artifacts/api-server/test/development-tls.test.ts`
- `artifacts/api-server/package.json`

---

## 10. أثر على عمل Claude

- لم يُلمس أي ملف مملوك لـClaude (`artifacts/api-server/src/ai/`، `artifacts/dinar/src/pages/Ai.tsx`، عقد Card Envelope).
- **تغيير مشترك يجب إعلانه:** `/api/policies` و`/api/policies/:key` صارا يحملان `contentSha256` و`lifecycle` (حقول مضافة فقط). بطاقة `POLICY_REVIEW` يجب أن تقرأ الحالة من `/api/account/policy-consents` وتُرسل القرار إلى `/api/account/policy-decisions`، لا أن تُظهر «تم القبول» من نص النموذج.
- بطاقات الشراء: أي عرض لطريقة دفع أو لأهلية بائع يجب أن يتعامل مع أخطاء `SELLER_VERIFICATION_REQUIRED` و`AGE_DECLARATION_REQUIRED` و`GUARDIAN_CONSENT_REQUIRED` و`COMMERCIAL_CAPABILITY_NOT_ACTIVATED` كحالات حقيقية قابلة للعرض، لا كأعطال.
