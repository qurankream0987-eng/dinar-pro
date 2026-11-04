# QODER TEMPORARY PRINCIPAL — تقرير الأساس G0 + الحفظ G1

**المهمة:** «DINAR NEXT — QODER TEMPORARY PRINCIPAL ENGINEERING MISSION» (Codex معطّل مؤقتًا بسبب حدود الاستخدام).
**التسلسل الملزم:** VERIFY → PRESERVE → REUSE → IMPLEMENT → TEST → PROVE → DOCUMENT → REQUEST PUSH APPROVAL → STOP.
**هذا التقرير:** يغطي VERIFY (G0) و PRESERVE (G1) فقط. لا ادّعاء قبول في أي بند لم يُشغَّل بعد.

---

## 1. ما فُحص فعليًا (وليس ما يُفترض)

| البند | القيمة المقاسة | طريقة القياس |
|---|---|---|
| المستودع | `qurankream0987-eng/dinar-pro` | `git remote -v` |
| فرع التوحيد المعلن | `replit/dinar-next-six-wave-unification` | `git ls-remote --heads origin` |
| رأس ذلك الفرع | `ebdd2d7a68f5a52af7ad973f21ef3b0cae914b4a` («docs: record final PR evidence update») | fetch + `git log -1` |
| فرع العمل المعزول | `qoder/temp-principal-sixwave-closure` | `git worktree add -b … ebdd2d7` |
| مجلد العمل | `D:\DINAR\dinar-sw1` (شجرة نظيفة، لا دفع) | `git status --porcelain` |
| رأس `main` القانوني | لم يُلمس، لا فرع عمل عليه | — |

**تصحيح الافتراض الوارد في نص المهمة:** الرقمان `442008a5…` (Codex V2 المُختبَر) و`719d4715…` (Codex V2 local HEAD) **غير موجودين في أي مستودع محلي ولا على origin**: `git cat-file -e` يُرجع «Not a valid object name» لهما في `D:/DINAR/dinar` و`D:/DINAR/dinar-w06` وهذه الشجرة، و`git branch -a --contains` لا يُرجع أي فرع. لا يُبنى على أي منهما أي استنتاج.

الفروع المحلية (`git worktree list`، 14 عملًا) كلُّها على رؤوسها التاريخية، لم يُحرَّك منها شيء: `qoder/wave06-d16-d17-closure` @ `891c37d`، `qoder/wave06b-d16-d17-closure` @ `d341917`، `qoder/a02-d4-d5-security` @ `8f9f6ad`، `qoder/w17` @ `4e60a56`… إلخ.

## 2. القواعد المقروءة قبل أي تعديل

بالترتيب الملزم: `AGENTS.md`، `CLAUDE.md`، `docs/qoder/GUARDRAILS.md`، `docs/qoder/00_START_HERE.md`، `docs/dinar-next/replit-unification/13_CAPABILITY_COMPLETENESS_MATRIX.md`، `DINAR_REMAINING_WORK_FOR_REPLIT.md`، `REPLIT_SAFE_BASELINE_HANDOFF.md`، `CLAUDE_13_CONTRIBUTION_PRESERVATION.md`، `DINAR_CODEX_FINAL_AUDIT_HANDOFF.md`.

قيدان من هذه الملفات **صادمان للواقع** وسُجّلا دون تصحيح في الكود:

- `CLAUDE.md` يقول «the 49 checked-in migrations». العدد الفعلي على `ebdd2d7` هو **57** (§4). جملة وثائقية قديمة، لا قرار هندسي.
- `AGENTS.md`/`00_START_HERE.md` يجعلان الأساس `claude/02-sc-acceptance`. هذا تاريخي؛ أساس هذه المهمة هو رأس المرشّح الموحّد `ebdd2d7` بحسب نص المهمة نفسه («Use the latest validated Replit unified candidate as the architecture authority»).

القرارات الملزمة التي تحكم كل عمل لاحق: loopback فقط، `BDINAR_BLOCK_MODEL_CALLS=1` وحذف مفاتيح المزوّدين في `test/run.mjs`، لا `drizzle-kit push`، لا إضعاف assertion، «API passes» ليست `REAL_E2E`، و`ai-authority-boundary.test.ts` يمر كما هو.

## 3. حالة Draft PR #5 (قراءة، لا كتابة)

`gh pr view 5`: **OPEN / DRAFT**، الأساس لم يتغيّر، mergeable. الفحوص: preflight ناجح، docker-acceptance 16/18. قرار المصفوفة الخاصة بالمرشّح نصًّا: **«Internal candidate only; not approved for merge, deployment, or launch»**. هذا هو السقف الذي نعمل تحته، ولا يُرفع إلا بقرار مالك.

## 4. سلسلة الترحيلات ومانيفست الإصدار (تحقّق رقمي)

| الفحص | النتيجة على `ebdd2d7` |
|---|---|
| ملفات SQL في `lib/db/drizzle/` | **57** |
| مداخل `meta/_journal.json` | **57** |
| مداخل `release-manifest.json` (tag+sha256) | **57** |
| `EXPECTED_BASELINE_MIGRATIONS` | **28** ([clone-migration-guard.ts:6](file:///D:/DINAR/dinar-sw1/lib/db/src/clone-migration-guard.ts#L6)) |
| `EXPECTED_JOURNAL_ENTRIES` = 28 + عدد `REVIEWED_PENDING_MIGRATIONS` | **57** ([clone-migration-guard.ts:66](file:///D:/DINAR/dinar-sw1/lib/db/src/clone-migration-guard.ts#L66)) |
| وسم الرأس في `readiness.test.ts` | `0056_order_line_integrity` ([readiness.test.ts:262](file:///D:/DINAR/dinar-sw1/artifacts/api-server/test/readiness.test.ts#L262)) |

الثلاثة متساوية والحارس مغلق على نفس الرقم: لا انقسام تسلسل داخل المرشّح. رؤوس المصفوفة (`replit-unification/13`) ذكرت السلسلة حتى `0056`، وهو مطابق للمقاس.

ترحيلان يهمّان هذه المهمة مباشرة:

- `0054_conversation_memory.sql` — **هو ترحيل D17 الخاص بـQoder**، مُعاد ترقيمه من `0055` إلى `0054` مع **نفس sha256** `7112f4a23aba466fabb9dcf43ac4da6207b649c597f53cf70c168c0976e1d700`. لم يُكتب مخطط بديل ولم تُستبدل الجداول.
- `0055_d16_incident_integrity.sql` — `d16_reject_closed_incident_mutation()` على `security_incidents` يمنع UPDATE/DELETE عندما `OLD.status = 'CLOSED'` (خطأ `55000`). هذا يُغلق D16-BL-05 آليًا (§5).
- `0056_order_line_integrity.sql` — `orders.order_line_integrity_version` (CHECK `IN (0,1)` + trigger يرفض أي طلب جديد ليس الإصدار 1، خطأ `23514`). هذا أساس فحص G5 لسلامة بنود الطلب.

**ممنوع لاحقًا بحسب نص المهمة:** إعادة ترقيم أو إعادة كتابة أي ترحيل قائم. أي ترحيل جديد يأخذ الرقم `0057`.

## 5. إعادة تدقيق حواجز D16 على المرشّح (مقارنة بما قسته في Wave 06)

الأصل: `docs/dinar-next/QODER_WAVE06_D16_AUDIT.md` (مقاس على `4423354`). الحالة اليوم مقروءة من مصدر `ebdd2d7`:

| الحاجز | حالته على `ebdd2d7` | الدليل في المصدر |
|---|---|---|
| **BL-04** (ENABLE يُلغي Disable طارئ متزامن) | **مغلق** | `readCapability(…, lock = true)` يستدعي `query.for("update")` ([d16-readiness.ts:90-109](file:///D:/DINAR/dinar-sw1/artifacts/api-server/src/lib/d16-readiness.ts#L90))، و`enableMarketCapability` و`disableMarketCapability` كلاهما يقفل ويحدّث بشرط `id AND status` مع `409 CAPABILITY_STATE_CHANGED` |
| **BL-05** (تحرير الخطورة/الأدلة بعد CLOSED) | **مغلق** | trigger من `0055_d16_incident_integrity.sql` — ليس اعتمادًا على الحارس في التطبيق فقط |
| **BL-06** (حقل المرجع يقبل رابط مستند) | **مغلق** | `requireReference` بنمط `^[A-Za-z][A-Za-z0-9._/-]{2,199}$` ([d16-readiness.ts:74-79](file:///D:/DINAR/dinar-sw1/artifacts/api-server/src/lib/d16-readiness.ts#L74)) |
| **BL-01** (تجاوز البوابة بالمزيج البيئي) | **مخفَّف، غير مغلق** | `marketLegalGateEnforced` صارت: `REPLIT_DEPLOYMENT` موجود ⇒ مفروضة؛ `DINAR_DEPLOYMENT_ENV` غير `development/test` ⇒ مفروضة؛ وإلا fallback إلى `NODE_ENV`. يبقى مسار الاحتياط يعمل بلا أي علامة نشر صريحة — وهو ما يجب أن يفشل الإقلاع لا أن يستنتجه |
| **BL-07** (الإيقاف يترك سلّم الموافقات سليمًا) | **مفتوح / غير مثبت** | لا وجود لسلسلة `SUSPEND` داخل `d16-readiness.ts` على المرشّح؛ لا يوجد اختبار يعيد قياس ذلك |
| **BL-08** (قدَرَتان بلا أي call site) | **مفتوح** | التأكيدات الفعلية 7 من 9؛ `INFORMATION_ONLY` و`ELECTRONIC_PAYMENT` بلا مستهلك |

**أمانة القياس:** BL-04/05/06 أُغلقت بتغييرات Replit/Codex اللاحقة على فرع التوحيد، وليست عملي. لم أعُد بها ولا أنسبها لنفسي؛ سُجّلت كما هي.

## 6. G1 — حفظ إسهامات الآخرين

### 6.1 Codex V2 («Conversation Experience V2 / Playful Commerce»)

**حاجز حفظ صريح (كما تتطلب المهمة):** لا وجود لأي كائن Git لـCodex V2.

- `git branch -r --list "*codex*"` يُرجع فرعًا واحدًا فقط: `origin/codex/11-c1-sql-search` (`f351f5d…`)، وهو موسّم `SUPERSEDED` في `CLAUDE_13_CONTRIBUTION_PRESERVATION.md` §2 ولا علاقة له بـV2.
- لا ملف `.bundle` تحت `D:/DINAR` ولا `D:/DiskOffload/codex-runtimes` (بحث `find -maxdepth 3`).
- `442008a5…` و`719d4715…` غير قابلين للحل (§1).
- الوثائق تجعله `ACTIVE_CODEX_WORK` مع نص «لا فرع منشور عند الفحص» — ثلاث مرات مستقلة (`CLAUDE_13_CONTRIBUTION_PRESERVATION.md:33` و`:58` و`:166`، و`REPLIT_SAFE_BASELINE_HANDOFF.md` §5، و`DINAR_REMAINING_WORK_FOR_REPLIT.md` §2).

**القرار:** متطلبات Codex V2 الموثّقة تُعتمد **مواصفة وظيفية** فقط، وحرفيًا كما وردت في `REPLIT_SAFE_BASELINE_HANDOFF.md` §5 و`CLAUDE_13_CONTRIBUTION_PRESERVATION.md` §5:

1. واجهة المحادثة الموحّدة، والمساحة السياقية، وبطاقات المنتج والخدمة الموثوقة؛
2. الصور والمعارض، والمقارنة؛
3. السلة الدائمة مع حركة «كرة السلة»؛
4. الوصولية، والحركة المخفّفة؛
5. أدلة المتصفح والأداء.

**ولا يجوز** لأي تقرير لاحق أن يدّعي أن ما سيُبنى هنا «هو تنفيذ Codex الأصلي»: الأصل مفقود، والعمل إعادة تحقيق لمواصفة.

### 6.2 إسهامات Replit/Claude/بقية Qoder

- فرع Replit الأصلي `replit/dinar-next-six-wave-unification` غير معدّل؛ كل العمل على فرع Qoder الخاص (§1).
- كل رؤوس `qoder/*` و`claude/*` و`codex/*` القائمة محفوظة كما هي، لا حذف ولا إعادة كتابة تاريخ.
- **فجوة حفظ أُغلقت في هذا التقرير:** الوثائق الأربع لتسليم Wave 06 موجودة على `qoder/wave06-d16-d17-closure` لكنها **غير موجودة** في المرشّح (`ls docs/dinar-next | grep -c WAVE06` = 0)، بينما مجموعاته الاختبارية السبع موجودة فعلًا في `artifacts/api-server/test/` (`w06-d16-adversarial`, `w06-d17-context-baseline`, `w06-d17-retrieval-quality`, `wave06-conversation-memory`, `wave06-conversation-memory-adversarial`, `wave06-conversation-memory-performance`, `wave06-d16-compliance-acceptance`). أي أن المرشّح حمل الكود وترك الدليل. نُقلت الوثائق الأربع هنا نصًّا مع «preserve note» أعلى كل واحدة يوضّح الـSHA الذي قِيست عليه وما تغيّر بعده — لا إعادة كتابة للمحتوى.

### 6.3 حالة D17 على المرشّح

المرشّح ليس ناقصًا في D17، بل **أحدث** مما قسته:

- `conversation-memory.ts` + `0054` + المجموعات السبع كلها حاضرة.
- `modelMessagesFor` مُصدَّرة كـseam قياس (`3c93c22` ancestor)، و`526f79a` («Keep retrieved memory out of the current user turn») ancestor أيضًا — وهذا **يُبطل موضعة** أرقام D17.1 التي ساقتها وثيقة Wave 06: على `4423354` كانت الذاكرة تُحقن داخل رسالة المستخدم، وعلى `ebdd2d7` تصبح كتلة `system` مستقلة ([model-turn.ts:578-587](file:///D:/DINAR/dinar-sw1/artifacts/api-server/src/ai/model-turn.ts#L578)). أرقام حدود الرموز (1200/6000/9000/2400…) لا تتغيّر، لكن توزيعها على الرسائل يجب أن يُعاد قياسه قبل أي اقتباس.

## 7. G2 — جرد تجربة المحادثة مقابل المواصفة (مقيس من المصدر)

| # | البند | حالة `ebdd2d7` | الدليل |
|---|---|---|---|
| 1 | طيران صورة المنتج إلى السلة بعد تأكيد الخادم | **موجود** | `cart-basket-animation.ts` (121 سطرًا) + الاستدعاء مشروط بنتيجة الخادم: `if (!added) return` ([ConversationContent.tsx:1220-1231](file:///D:/DINAR/dinar-sw1/artifacts/dinar/src/features/ai/ConversationContent.tsx#L1220)) |
| 2 | بطاقات سياقية قابلة لإعادة الاستخدام | **موجود** | `features/ai/surface/` (`ComposedSurface.tsx`, `adapters.ts`, `commerce-adapters.ts`, `business-adapters.ts`, `primitives.tsx`) |
| 3 | مقارنة منتجات وخدمات | **موجود للمنتجات/القوائم** | `ai/buyer-turn.ts:445 comparison()` ⇒ `surface: "COMPARISON"`؛ العقد `lib/api-zod/src/conversation-runtime.ts:288`؛ العرض `ConversationContent.tsx:1032`؛ `BuyerPanels.tsx:51` (`.ai-comparison-cards`) |
| 4 | ألواح تفاصيل متجاوبة | **موجود عبر البطاقات** | لا مكوّن «DetailPanel» مستقل (grep فارغ)؛ التجاوب في `AiChat.css` (نقاط توقف 479/560/767/1023/1350 وبوابات `hover:none`) |
| 5 | استقرار الكتابة العربية/IME | **موجود جزئيًا** | حرّاس `!event.nativeEvent.isComposing` في موضعين فقط: `ChatComposer.tsx:296`، `OrderParts.tsx:332`. لا تغطية لبقية الحقول متعددة الأسطر |
| 6 | **إلغاء البث واستئنافه** | **فجوة حقيقية** | `sendAiConversationTurn` يقبل `signal` ([ai-api.ts:631-654](file:///D:/DINAR/dinar-sw1/artifacts/dinar/src/features/ai/ai-api.ts#L631)) لكن المستدعي يمرر `undefined` حرفيًا ([Ai.tsx:1210](file:///D:/DINAR/dinar-sw1/artifacts/dinar/src/pages/Ai.tsx#L1210))، و`grep AbortController` في `artifacts/dinar/src` و`lib/` = **صفر**. الاسترجاع موجود (إعادة المحاولة، `deliveryUnknown`، حرس `requestEpoch`) لكن الإلغاء الفعلي غير موجود ولا زر «أوقف» |
| 7 | سلة دائمة | **موجود** | جداول `carts`/`cartItems` ([schema/index.ts:891 و:905](file:///D:/DINAR/dinar-sw1/lib/db/src/schema/index.ts#L891)) + `lib/marketplace-cart.ts`؛ لا حالة سلة في `localStorage` |
| 8 | الوصولية بالحركة المخفّفة والميل | **موجود** | `Sheet.tsx:10` (Radix Dialog: focus trap + Esc + `aria-modal`)؛ 6 كتل `prefers-reduced-motion` في `AiChat.css` + `index.css:654` +بوابة JS في `cart-basket-animation.ts:38` و`Ai.tsx:1462` |
| 9 | موثوقية الإجراء المعلّق عبر التبويبات | **موجود** | `card-sync.ts:69-88` (`BroadcastChannel` باسم `userId+marketId`) + إعادة القراءة عند العودة لتبويب مخفي ([Ai.tsx:663](file:///D:/DINAR/dinar-sw1/artifacts/dinar/src/pages/Ai.tsx#L663)) |
| 10 | أسطح الطلب والمستندات المدمجة | **موجود** | `OrderTrackingSurface.tsx`, `DeliverySurface.tsx`, `ActionReceipts.tsx`, `features/OrderParts.tsx`, `business-document-upload.ts`, `listing-photo-upload.ts` |

**ما لا يجوز مسّه أثناء الإكمال:** لا وقت تشغيل محادثة ثانٍ (`ai/conversation-runtime.ts` + `routes/ai.ts` ملك واحد)، ولا نسخة ثانية من محرّك حركة السلة (`cart-basket-animation.ts`)، ولا أدوات كتابة للنموذج (`tool-registry.ts`)، ولا تكرار لمحرّك المقارنة (`buyer-turn.ts:comparison`).

## 8. ما لم يُثبت بعد في هذا التقرير (حدود الصراحة)

- لا تشغيل اختبار ولا بناء ولا قياس أداء بعد على هذا الفرع — §7 قراءة مصدر، لا دليل قبول. A/ «browser verified» لم يُدَّعى لأي بند.
- رقم «13.10% انحدار في عرض التاريخ» **لا أثر له في المستودع**: بحث `13.1` و`history-render` و`rendering regression` عبر `docs/`, `artifacts/`, `lib/`, `test/` لم يُرجع سوى تعليق اختبار واحد (`g2-smart-conversation.test.ts:2316` «provider history renders»). لا تقرير، لا JSON قياس، لا رقم. لذلك G4 يجب أن يبدأ من **أساس جديد تمامًا** على `ebdd2d7`، لا من مقارنة برقم مؤرشف.
- BL-07 وBL-08 مفتوحتان، وBL-01 يحتاج قرار تصميم (فشل الإقلاع) وليس إصلاحًا صامتًا.
- مصفوفة G3 (الـ13 سير عمل) وG5 (المال/الأمن) وG6 (القبول على PG16/18) وG7 (التسليم) لم تبدأ.

## 9. القرارات المطلوبة من المالك (لا تُحسم في الكود)

1. هل يُعتمد إلغاء البث (`AbortController` + زر إيقاف) سلوكًا **يترك الطلب يُكمل على الخادم** أم **يقطعه فعليًا**؟ هذا قرار سياسة مال/موارد، ليس تفصيل UI.
2. حارس الإيقاف في `business_memberships` مقابل سلّم موافقات D16 (BL-07): أيهما يُلغي الآخر أولًا.
3. قدَرَتا `INFORMATION_ONLY` و`ELECTRONIC_PAYMENT` (BL-08): تُفعّلان في مسار حقيقي أم تُحذفان من القائمة.
4. `DINAR_DEPLOYMENT_ENV` (BL-01): يفشل الإقلاع عند غيابه في الإنتاج أم يبقى الاستنتاج بـ`NODE_ENV`.

كل قرار من `docs/qoder/GUARDRAILS.md` §E (أسعار الاشتراك، سياسة الإرجاع، السوق الأول…) يظل مفتوحًا ولا يُلمس.
