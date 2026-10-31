# DINAR NEXT — الموجة 10: البلاغات، الفرز البشري، إشارات الاحتيال، الدعم، وجهوزية واتساب

**الفرع:** `qoder/parallel-w07-w12-ultra`
**الأساس:** `b80c27bf953fe99a370865e7793076eb2f3fe873` + W07 (`09e8941`) + W08 (`20ed66e`) + W09 (`9af5170`)
**بيئة العمل:** `D:\DINAR\dinar-w0712`
**الحالة:** التنفيذ مكتوب ومراجَع ستاتيكيًا. **التشغيل الفعلي BLOCKED** لغياب `node_modules` و PostgreSQL محليًا، ولأن دفع الفرع إلى CI يحتاج إذن المالك بالنشر. لا اختبار أخضر مُختلق. لا إرسال واتساب حقيقي ولا مزوّد متصل.

> **تحديث W12.1 (2026-10-31):** الحالة أعلاه تصف لحظة الكتابة فقط. بعد إذن المالك شُغِّل `wave10-trust-support-whatsapp.test` على SHA الشيفرة `7b115dc` في التشغيل `41225786917` (PG16، 24/24، `outbound=0`)، وأُعيد على SHA المرشّح `6b702ae` في التشغيل `41239785223`. لا مزوّد واتساب حقيقي ولا إرسال في أي من التشغيلين؛ الاختبار يثبت أن `sent` يبقى `false`.

> **قاعدة الصدق:** لا يوجد في W10 أي إجراء تلقائي ضد حساب. البلاغ ادعاء لا يغيّر حالة. إشارة الاحتيال ملاحظة غير قابلة للتعديل، ومراجعتها رأي بشري `appliedSanction: null`. الدعم لا يرى ملاحظات داخلية. مسار واتساب يستحيل أن يرسل: لا محوّل مزوّد، والقاعدة تفرض `delivery_state = 'NOT_SENT'`، و`liveSends: false` في كل قراءة.

---

## 1. ما لا تدّعيه هذه الموجة

| الادعاء الممنوع | الموقف الفعلي |
|---|---|
| «البلاغات تحمي المستخدمين تلقائيًا» | البلاغ ادعاء مسجّل؛ لا تغيير حالة تلقائي. حتى إجراء `FLAG_AI_ANSWER` يكتب تدقيقًا فقط ولا يلمس أي حالة. |
| «إشارات الاحتيال تثبت الاحتيال» | الإشارة ملاحظة (`RULE/REPORT/ADMIN/SYSTEM`) غير قابلة للتعديل، والمراجعة قرار بشري واحد (`CONFIRMED/DISMISSED/ESCALATED`) لا يطبّق عقوبة: `appliedSanction: null` و`automaticEnforcement: false`. |
| «الذكاء الاصطناعي يفرض العقوبات» | لا يوجد أي مسار يجعل النموذج يقرر أو ينفّذ. كل إجراء على حساب أو إعلان يمر بمسار إداري صريح. |
| «واتساب جاهز للإرسال» | لا يوجد مزوّد حقيقي ولا محوّل إرسال. أعلى قرار ممكن هو `READY_TO_SEND` تحت مزوّد محاكاة، ويبقى `sent: false` و`delivery_state='NOT_SENT'`. |
| «الموافقة على واتساب مأخوذة من المحادثة» | مصدر الموافقة مقيد بـ`IN_APP` أو `SUPPORT` فقط. لا يقبل الخادم `CARD`/`MODEL`/`SIGNUP` عبر الـAPI؛ و`SUPPORT` يكتبه الخادم من مسار الدعم لا من نص. |
| «قوالب واتساب معتمدة» | القالب يبدأ `DRAFT` بلا اعتماد، والانتقال إلى `APPROVED` يحتاج وقت اعتماد، ولا يصل إليه إلا عبر `SUBMITTED`. لا قالب مزروع معتمدًا. |
| «الدعم يرى ما يراه المستخدم» | الملاحظة الداخلية تظهر للفريق فقط، ولا تغيّر حالة الطلب. حالة `CLOSED` نهائية ولا تُعاد فتحها. |

---

## 2. REUSE — ما لم يُعد بناؤه

| القدرة | المالك القائم | الاستخدام في W10 |
|---|---|---|
| البلاغات وأسبابها | `routes/trust-safety.ts` + `marketplace_reports` | وُسّع `TARGET_TYPES` إلى 5، وأُضيفت أسباب MESSAGE/AI، ولم يُعد بناء التدفق. |
| تدقيق الإشراف | `lib/moderation.ts` | وُسّع اتحاد `targetType` إلى `MESSAGE` و`AI_ANSWER` فقط. |
| الاستئنافات | `trustAppealEvents` | لم تُلمس. |
| الإشعارات | `lib/notifications.ts` | أُضيف قالب `SUPPORT_CASE_UPDATED` واحد. |
| أهداف زمن الاستجابة | `lib/response-targets.ts` | أُضيف `DINAR_SUPPORT_RESPONSE_HOURS` (1–720). |
| سلطة الإدارة | W09 `assertAdminActor` | أُعيد استخدامها في مراجعة الاحتيال وكل مسارات `/admin/*`. |
| دورة الملف الشخصي والدور | `users.role` + `sessionMiddleware` | لم يتغير شيء. |
| آلة حالات الطلب والدفع | W07/W08 | لم تُلمس. |

---

## 3. الفجوات التي عالجتها W10

| # | الفجوة | العلاج |
|---|---|---|
| G10.1 | البلاغات لا تشمل الرسائل ولا إجابات الذكاء الاصطناعي، وأسباب الاحتيال/الانتحال/التقليد/الملكية الفكرية غائبة | توسيع `target_type` إلى `MESSAGE` و`AI_ANSWER`، وخمسة أكواد أسباب جديدة، ومواضع مقيدة. |
| G10.2 | لا مسار لبلاغ إجابة AI يحفظ الحد الأدنى فقط | تقرير `AI_ANSWER` بالمعرّفات وملاحظة المستخدم ≤500 فقط، بلا نص الإجابة، مع `retention: IDS_AND_USER_NOTE_ONLY` و`contentRetained: false`. |
| G10.3 | لا سجل احتيال قابل للتدقيق ولا يفصل الملاحظة عن القرار | `fraud_signals` غير قابل للتعديل + `fraud_signal_reviews` مراجعة واحدة على يد `ADMIN` فقط. |
| G10.4 | لا دعم داخل التطبيق بحالات وصلاحيات | `support_cases` + رسائل + أحداث، RBAC، ملاحظات داخلية، `CLOSED` نهائية. |
| G10.5 | لا سجل موافقة واتساب صريح ولا قوالب معتمدة بشريًا | سجل موافقة إلحاقي بمصدر `IN_APP/SUPPORT`، وقوالب بدورة اعتماد بشرية. |
| G10.6 | لا مسار «نيّة إرسال» يمكن تدقيقه بلا إرسال | `whatsapp_intents` بسلّم قرارات صريح، وكل صف `NOT_SENT` بقيد قاعدة. |
| G10.7 | لا تمييز بين حالة قديمة وحالة مغلقة في طابور الدعم | `supportQueue` يستثني `CLOSED` ويعلّم `stale` من عمر آخر رسالة، ولا يغلق تلقائيًا. |

---

## 4. التنفيذ

### 4.1 البيانات والقيود

- `lib/db/src/schema/index.ts:1602` — توسيع `marketplace_reports_target_type_valid` إلى خمسة أنواع.
- `lib/db/src/schema/index.ts:2614` — `fraudSignals`: `subject_type` (USER/LISTING/ORDER/MESSAGE/PAYMENT)، `severity`، `source`، `signal_type` بنمط، `dedupe_key`، وفريد `(subject_type, subject_id, dedupe_key)`.
- `lib/db/src/schema/index.ts:2642` — `fraudSignalReviews`: قرار واحد لكل إشارة (`CONFIRMED/DISMISSED/ESCALATED`)، ملاحظة 5–2000.
- `lib/db/src/schema/index.ts:2661` — `supportCases`: 7 فئات، 5 حالات، 4 أولويات، موضوع 3–160، وقيد اتساق الإغلاق.
- `lib/db/src/schema/index.ts:2689` — `supportCaseMessages`: مؤلف USER/STAFF/SYSTEM، نص 1–4000، `internal` للفريق فقط.
- `lib/db/src/schema/index.ts:2709` — `supportCaseEvents`.
- `lib/db/src/schema/index.ts:2731` — `whatsappConsentEvents`: `GRANTED/REVOKED`، مصدر `IN_APP/SUPPORT` فقط، `phone_hash` 64 hex.
- `lib/db/src/schema/index.ts:2751` — `whatsappTemplates`: مفتاح بنمط، فئة، حالة، `variable_count` 0–10، أزمنة الاعتماد.
- `lib/db/src/schema/index.ts:2774` — `whatsappIntents`: ستة قرارات، وقيد `delivery_state = 'NOT_SENT'`.

### 4.2 الترحيل 0044

`lib/db/drizzle/0044_wave10_trust_support_whatsapp.sql` — sha256 `edb8ca5702215790271b405cc086152fb1fb8ea3090d599008a7a828b3bb50e0`.

- `:6` — إسقاط قيد `marketplace_reports_target_type_valid` وإعادة إنشائه بقائمة أوسع (التغيير الوحيد على جدول قائم).
- `:11` — تحديث `marketplace_reports` لأكواد `FRAUD_SCAM`/`SPAM`/`HARASSMENT`/`PROHIBITED_ITEM`/`OTHER` لتشمل `MESSAGE` (و`AI_ANSWER` لـ`OTHER`).
- `:18` — إدراج أكواد أسباب جديدة بـ`ON CONFLICT DO NOTHING`: `IMPERSONATION`، `COUNTERFEIT`، `INTELLECTUAL_PROPERTY`، `AI_HARMFUL_ANSWER`، `AI_INACCURATE_ANSWER`.
- `:22,40,50,69,82,95,107,123` — الجداول الثمانية.
- `:168` — `fraud_signals_guard`: إشارة غير قابلة للتعديل (لا UPDATE/DELETE/TRUNCATE).
- `:180` — `fraud_signal_reviews_guard`: إلحاقي، والمراجع يجب أن يكون `ADMIN` (فحص `users.role`)، ومراجعة واحدة.
- `:201` — `support_cases_guard`: الإدراج يبدأ `OPEN`، الهوية غير قابلة للتغيير، و`CLOSED` نهائية.
- `:232` — `support_records_append_only`: رسائل وأحداث الدعم إلحاقية.
- `:250` — `whatsapp_consent_events_guard`: إلحاقي.
- `:262` — `whatsapp_templates_guard`: إدراج `DRAFT` غير معتمد، محتوى ثابت، `DRAFT→SUBMITTED`، `SUBMITTED→APPROVED/REJECTED`، `APPROVED→DISABLED`، و`APPROVED` يشترط وقت اعتماد.
- `:304` — `whatsapp_intents_guard`: إلحاقي.
- `meta/_journal.json` — `idx 44`، و`release-manifest.json` + `clone-migration-guard.ts` يحملان الهاش أعلاه؛ عدد المدخلات المتوقع صار **45**.
- فحص التدمير (محاكاة `release-migration.ts`): **181 مقتطفًا، 0 تطابق تدميري**.

### 4.3 محرك الاحتيال

`artifacts/api-server/src/lib/fraud-signals.ts` (194 سطرًا):

| الدالة | السطر | السلوك |
|---|---|---|
| `fraudSignalView` | 53 | يعرض الإشارة ويضيف `enforcement: "NONE"`. |
| `fraudReviewView` | 70 | يعرض القرار ويضيف `appliedSanction: null` و`nextStep` بشريًا. |
| `recordFraudSignal` | 90 | إداري فقط؛ تكرار `dedupe_key` يعيد الصف نفسه مع `duplicate: true` ولا يكرّر. |
| `reviewFraudSignal` | 134 | `assertAdminActor`؛ مراجعة واحدة؛ التكرار `409 SIGNAL_ALREADY_REVIEWED`؛ لا عقوبة. |
| `fraudSignalsFor` | 149 | قراءة إدارية مفلترة بالم Subject. |
| `fraudOverview` | 171 | إحصاءات مع `automaticEnforcement: false`. |

### 4.4 محرك الدعم

`artifacts/api-server/src/lib/support-cases.ts` (335 سطرًا):

| الدالة | السطر | السلوك |
|---|---|---|
| `supportCaseView` | 58 | تمثيل موحد للحالة. |
| `supportStaleHours` | 99 | `DINAR_SUPPORT_STALE_HOURS` (افتراضي 72) داخل 1–720. |
| `createSupportCase` | 104 | `OPEN` + أول رسالة + حدث؛ حد يومي 20 (`429 SUPPORT_LIMIT`). |
| `ownSupportCases` | 153 | حالات المستخدم فقط. |
| `getSupportCase` | 159 | غير المالك يحصل على 404 موحد؛ ملاحظات داخلية وأحداث تُحجب عن المستخدم. |
| `addUserSupportMessage` | 181 | `409 CASE_CLOSED` على مغلقة؛ ينقل إلى `AWAITING_STAFF`. |
| `staffReplyToSupportCase` | 220 | الملاحظة الداخلية لا تغيّر الحالة؛ الرد العلني ينقل إلى `AWAITING_USER` ويُشعر صاحب الحالة. |
| `assignSupportCase` | 254 | المسند يجب أن يكون `ADMIN`. |
| `transitionSupportCase` | 282 | انتقالات صريحة؛ `CLOSED` نهائية؛ إشعار عند التغيير. |
| `supportQueue` | 313 | يستثني `CLOSED`، ويحسب زمن الاستجابة، ويعلّم `stale`. |
| `queuedSupportStatus` | 329 | ملخص الطابور. |

### 4.5 جهوزية واتساب

`artifacts/api-server/src/lib/whatsapp-readiness.ts` (313 سطرًا):

| الدالة | السطر | السلوك |
|---|---|---|
| `whatsappProviderState` | 42 | لا يعرف إلا `DINAR_WHATSAPP_PROVIDER=simulation` → `SIMULATED`؛ وإلا `NOT_CONNECTED`. `liveSends: false` دائمًا. |
| `whatsappPhoneHash` | 52 | SHA-256؛ لا يُخزَّن الرقم. |
| `whatsappConsentStatus` | 56 | `NO_DECISION/GRANTED/REVOKED` من آخر حدث. |
| `recordWhatsAppConsent` | 80 | مصدر صريح فقط؛ طابع زمني رتيب لترتيب GRANT/REVOKE الحتمي. |
| `whatsappTemplateView` | 128 | عرض القالب وحالته. |
| `createWhatsappTemplate` | 143 | إداري؛ عدد المتغيرات يجب أن يساوي عدد المواضع. |
| `transitionWhatsappTemplate` | 167 | انتقالات الاعتماد فقط؛ لا قفز إلى `APPROVED`. |
| `listWhatsappTemplates` | 188 | قائمة إدارية. |
| `whatsappIntentView` | 215 | يعرض القرار دائماً `sent: false`. |
| `evaluateWhatsappIntent` | 234 | سلّم: `DISABLED` → غير `APPROVED` → حمولة غير صالحة → بلا موافقة → بلا مزوّد → `READY_TO_SEND`؛ يُسجّل `NOT_SENT` دائمًا. |
| `whatsappOverview` | 287 | `liveSendsEnabled: false`. |

قواعد الحمولة: ممنوع أن يحمل الحقل أي هاتف/بريد/رمز/OTP/كلمة مرور/سر.

### 4.6 واجهات البرمجة

`artifacts/api-server/src/routes/trust-ops.ts` (173 سطرًا)، مركّب في `routes/index.ts` بعد `trustSafety`:

- المستخدم: `GET/POST /account/support/cases` (`:66,70`)، `GET /account/support/cases/:id` (`:75`)، `POST .../messages` (`:79`)، `GET/POST /account/whatsapp/consent` (`:86,90`).
- الإدارة (خلف `requireAdmin`): `/admin/support` (`:97`) قائمة/تفاصيل/رد/إسناد/حالة؛ `/admin/fraud` (`:124`) إشارات/إنشاء/مراجعة/ملخص؛ `/admin/whatsapp` (`:148`) قوالب/حالة/نيّات/ملخص.

### 4.7 تعديلات البلاغات

`artifacts/api-server/src/routes/trust-safety.ts`:

- `:51` — `TARGET_TYPES` خمسة.
- `:180` — `MESSAGE`: بلاغ عن رسالة الطرف الآخر داخل محادثة طلب يملكها المبلّغ.
- `:190` — `AI_ANSWER`: محادثة AI مملوكة للمبلّغ، وليست رسالته، مع سوق إلزامي.
- `:241` — `retention: "IDS_AND_USER_NOTE_ONLY"` عند `AI_ANSWER`.
- `:249` — رفض ملاحظة >500 حرف لإجابة AI.
- `:427` — سياق `MESSAGE` (نص + مرسل) للمراجعة البشرية.
- `:446` — سياق `AI_ANSWER` بالمعرّفات فقط و`contentRetained: false`.
- `:525` — إجراء `FLAG_AI_ANSWER`.
- `:545` — `FLAG_AI_ANSWER` لإجابات AI فقط، يكتب تدقيق `AI_ANSWER_FLAGGED` بلا نص وبلا تغيير حالة.
- `:559` — رفض أي إجراء آخر على `AI_ANSWER`.
- `:581` — `RESTRICT_USER`/`SUSPEND_USER` على بلاغ رسالة يستهدف مرسل الرسالة فقط.

`lib/moderation.ts` — `targetType` يقبل `MESSAGE` و`AI_ANSWER`.

---

## 5. عقد العمليات (ما يمكن لبطاقات Claude/الواجهة توقّعه)

1. **البلاغ:** `POST /api/reports` يقبل `targetType` من الخمسة؛ `AI_ANSWER` يقبل ملاحظة ≤500 فقط، والرد يحمل `retention: "IDS_AND_USER_NOTE_ONLY"`. البلاغ لا يغيّر أي حالة.
2. **الدعم:** `POST /api/account/support/cases` يعيد حالة `OPEN`؛ `GET` لا يرى إلا ما يملكه المستخدم (404 موحد لغيره)؛ الرد ينقل إلى `AWAITING_STAFF`؛ `CLOSED` نهائية.
3. **الموافقة على واتساب:** `POST /api/account/whatsapp/consent` بقرار `GRANTED/REVOKED` ومصدر من `{IN_APP, SUPPORT}`؛ أي مصدر آخر → 400. الغياب يعني `NO_DECISION`.
4. **الإدارة:** كل `/api/admin/support|fraud|whatsapp/*` يعيد 403 لغير الإداري، وكل عمليات الاحتيال تُرجع `automaticEnforcement: false`.
5. **النيّات:** `POST /api/admin/whatsapp/intents` يعيد دائمًا `sent: false`؛ أعلى قرار `READY_TO_SEND`، والباقي `BLOCKED_*`.

> أي واجهة تقول «تم إرسال واتساب» أو «تم إيقاف الحساب تلقائيًا» تخالف العقد وتكون ادعاءً غير مسجّل.

---

## 6. اختبارات القبول المكتوبة

`artifacts/api-server/test/wave10-trust-support-whatsapp.test.ts` — **24 اختبارًا**، سكربت `test:w10`، بوابة موافقة `BDINAR_W10_ACCEPTANCE=development`:

| # | السطر | ما يثبته |
|---|---|---|
| 1 | 147 | أكواد الأسباب تغطي MESSAGE والانتحال والتقليد والملكية الفكرية وإجابات AI. |
| 2 | 161 | بلاغ رسالة الطرف الآخر يُسجَّل مرة واحدة ولا يفرض شيئًا. |
| 3 | 185 | رسالة المستخدم نفسه ومحادثات الآخرين غير قابلة للبلاغ. |
| 4 | 203 | بلاغ AI يحفظ المعرّفات فقط ويحدّ الملاحظة عند 500، والصف لا يحوي نص الإجابة. |
| 5 | 227 | إجابة AI لشخص آخر غير قابلة للبلاغ. |
| 6 | 239 | الإداري وحده يقرر البلاغ (403 لغيره). |
| 7 | 253 | إجابة AI تُعلَّم فقط: لا تغيير حالة، والتدقيق بلا نص. |
| 8 | 294 | بلاغ رسالة يقيّد المرسل فقط. |
| 9 | 322 | إشارة الاحتيال إدارية فقط، والتكرار يُخزَّن مرة واحدة. |
| 10 | 351 | الإشارات غير قابلة للتعديل على مستوى القاعدة. |
| 11 | 357 | المراجعة البشرية رأي بلا عقوبة (`appliedSanction: null`). |
| 12 | 379 | إيجابية كاذبة تُرفض بلا لمس الحساب. |
| 13 | 415 | المستخدم يفتح حالة دعم، ولا يقرأها إلا هو والفريق. |
| 14 | 443 | الإسناد والملاحظات الداخلية للفريق فقط. |
| 15 | 466 | رد الفريق ورد المستخدم ينقلان الحالة بين الطوابير. |
| 16 | 486 | الحالة المغلقة نهائية وترفض رسائل المستخدم. |
| 17 | 512 | الحالة القديمة تُعلَّم `stale` ولا تُغلق تلقائيًا. |
| 18 | 545 | الموافقة إجراء صريح داخل التطبيق فقط؛ مصدر مُلفّق → 400. |
| 19 | 559 | القوالب إدارية وتتبع مسار الاعتماد البشري (قفز إلى APPROVED → 409). |
| 20 | 583 | النيّة تُرفض بلا موافقة أو مزوّد ولا تُرسل (`sent:false`). |
| 21 | 607 | بمزوّد محاكاة تصبح `READY_TO_SEND` ومع ذلك لا تُرسل. |
| 22 | 641 | سحب الموافقة وتعطيل القالب يمنعان النيّة. |
| 23 | 665 | انقطاع مزوّد الإشعارات يُبلَّغ عنه ولا يُرمى. |
| 24 | 680 | واجهات `/admin/*` ترفض المستخدم العادي. |

---

## 7. ما لم يُبنَ (حتى لا يُفهم كتفعيل)

- لا إرسال واتساب حقيقي، ولا مزوّد، ولا قالب معتمد مزروع.
- لا كشف احتيال آلي ولا عقوبة آلية؛ الإشارات ملاحظات والمراجعة بشرية.
- لا تحقق من هوية المبلّغ أو صحة ادعائه؛ التقرير تصريح.
- لا دمج تلقائي للبلاغات ولا «حظر بعد N بلاغات».
- لا إغلاق دعم تلقائي؛ `stale` علامة فقط.
- لا نص إجابة AI محفوظ في البلاغات أو التدقيق.
- لا تفعيل تجاري ولا دفع حقيقي ولا نشر.

---

## 8. حالة الأدلة

| البند | الحالة |
|---|---|
| تنفيذ الشيفرة والقيود والترحيل | ✅ مكتوب ومراجَع ستاتيكيًا |
| فحص SQL التدميري | ✅ 181 مقتطفًا، 0 تدميري (محاكاة Perl) |
| تطابق هاش 0044 بين الملف والمانيفست وحارس الاستنساخ | ✅ `edb8ca57…b3bb50e0` |
| تحديث توقعات `readiness.test` و`development-tls.test` إلى 45 مدخلًا | ✅ |
| إصلاح فجوة typecheck موروثة في `safe-development-database.ts` (W09/W10) | ✅ |
| تشغيل `pnpm test:w10` فعليًا | ❌ **BLOCKED** — لا `node_modules` ولا PostgreSQL محليًا، ولا دفع إلى CI بلا إذن المالك |
| اختبار المتصفح | ❌ لم يُنفَّذ؛ لا تغيير واجهة في هذه الموجة |
| انحدار W07/W08/W09 و`trust-safety`/`notifications` | ❌ مؤجّل إلى W11 (يتطلب نفس البيئة) |

---

## 9. ملفات W10

**جديدة**
- `lib/db/drizzle/0044_wave10_trust_support_whatsapp.sql`
- `artifacts/api-server/src/lib/fraud-signals.ts`
- `artifacts/api-server/src/lib/support-cases.ts`
- `artifacts/api-server/src/lib/whatsapp-readiness.ts`
- `artifacts/api-server/src/routes/trust-ops.ts`
- `artifacts/api-server/test/wave10-trust-support-whatsapp.test.ts`
- `docs/dinar-next/QODER_W10_ULTRA_REPORT.md`

**معدّلة**
- `lib/db/src/schema/index.ts`
- `lib/db/drizzle/meta/_journal.json`
- `lib/db/drizzle/release-manifest.json`
- `lib/db/src/clone-migration-guard.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/api-server/src/routes/trust-safety.ts`
- `artifacts/api-server/src/lib/moderation.ts`
- `artifacts/api-server/src/lib/notifications.ts`
- `artifacts/api-server/src/lib/response-targets.ts`
- `artifacts/api-server/test/safe-development-database.ts`
- `artifacts/api-server/test/readiness.test.ts`
- `artifacts/api-server/test/development-tls.test.ts`
- `artifacts/api-server/package.json`

---

## 10. أثر على عمل Claude

- لم يُلمس أي ملف مملوك لـClaude (`artifacts/api-server/src/ai/`، `artifacts/dinar/src/pages/Ai.tsx`، عقد Card Envelope).
- **تغيير مشترك يجب إعلانه:** `POST /api/reports` يقبل الآن `MESSAGE` و`AI_ANSWER`؛ أي زر «بلّغ عن هذه الإجابة» في واجهة المحادثة يجب أن يرسل `targetType: "AI_ANSWER"` و`targetId` معرّف الرسالة، بلا نسخ نص الإجابة، وبملاحظة ≤500. الاستجابة تحمل `retention`.
- **تغيير مشترك ثانٍ:** `notifications` يعرف قالبًا جديدًا `SUPPORT_CASE_UPDATED` (`caseId`, `status`). أي عارض إشعارات يجب أن يتعامل معه بدل تجاهله.
- بطاقات الدعم: أي حالة `CLOSED` لا يجب أن تعرض زر «إرسال». وأي حالة `AWAITING_USER` تعني «بانتظار ردك».
- لا توجد أي صلاحية جديدة للذكاء الاصطناعي: النموذج لا يستدعي `/admin/*`، ولا يغيّر حالة.
