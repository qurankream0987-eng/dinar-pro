# DINAR NEXT — تقرير QODER WAVE 03: D7 + D8 + D9 — تجربة المحادثة والأمان والحملات

**التاريخ:** 2026-11-03
**الفرع المعزول:** `qoder/wave03-d7-d9-closure`
**نقطة البداية (canonical HEAD عند Gate 0):** `11d7fbe3326897924468ee4c6d5467972a92b973`
**SHA الشيفرة النهائي المُختبَر:** `e4061749725be0fb86f715164315d7cc11c1eadf` (فرع `qoder/wave03-d7-d9-closure`؛ يليه إيداع توثيق هذا التقرير فقط)
**الحكم المختصر:** D7 وD8 مكتملان بدليل برمجة وAPI وقاعدة بيانات ومتصفح حقيقي. D9 مكتمل للنطاق الموجود فعلًا في المشروع (الحملات والاستهداف والميزانية والجدولة والانتهاء والإلغاء وسجل التدقيق)، أما الهدايا والكوبونات فمصنّفة **BLOCKED** لأن قرار المنتج لم يُحسم في بوابة الإطلاق. لا دمج في `main` أو canonical، ولا نشر، ولا دفع حقيقي.

## 0. ما الذي لم يُفعل عمدًا

- لم يُنشأ محادثة ثانية ولا واجهة دردشة موازية؛ التعديل داخل سطح المحادثة القائم `pages/Ai.tsx` و`features/ai/ConversationContent.tsx` فقط.
- لم يُنشأ محرك سلة جديد ولا سلطة سلة على العميل؛ كل كمية تُقرأ من `/api/cart` والاستيلاء الوحيد هو `POST /api/ai/conversations/:id/actions/add-to-cart`.
- لم تُضف أداة نموذج جديدة، ولم يُمنح النموذج قرار السلة أو الدفع.
- لم يُفعّل أي حملة حقيقية، ولم يُنشأ أي طلب/دفع/تحويل مالي، ولم يُستخدم مزود AI مدفوع أو رسائل SMS حقيقية.
- لم يُضف أي اعتماد (dependency) جديد.
- لم يُعدّل `main` ولا فرع Replit canonical ولم يُدمج فيهما.

## 1. Gate 0 — ما فُحص قبل التغيير

- تم جلب canonical HEAD `11d7fbe` وقراءة تعليمات المشروع وخرائط السلطات في `docs/dinar-next`.
- D7: بطاقة نتائج البحث كانت تعرض زر سلة يرسل أمر محادثة نصيًا `ADD_TO_CART`، بينما السلطة القائمة هي إجراء REST مع إيصال مخزَّن. لم يكن هناك `onAdd` موصول ولا حالة انتظار ولا تحديث لشارة السلة ولا مؤثر بصري.
- D8: طبقة الرؤوس الأمنية كانت تحمل `X-Content-Type-Options` و`Referrer-Policy` و`X-Request-Id` فقط، دون CSP ولا `X-Frame-Options` ولا `Permissions-Policy` ولا HSTS إنتاجي.
- D9: جداول الحملات والخطط والاستهداف والميزانية والانتهاء واللافتات موجودة، ومسار تغيير الحالة موجود، لكنه كان يغيّر الحالة دون أي أثر تدقيق دائم للمالك.
- الهدايا/الكوبونات: غير موجودة في الشيفرة، و`docs/dinar-next/DINAR_REMAINING_WORK_FOR_REPLIT.md` ينص «لا هدايا ولا كوبونات»، وبوابة الإطلاق `DINAR_EXTERNAL_INTEGRATIONS_AND_LAUNCH_GATES.md` بند 9 يترك قرارها للمالك.

## 2. D7 — المحادثة الموحدة وسلة المشتري

### 2.1 الفجوة المؤكدة

1. زر «أضف إلى السلة» في بطاقة النتائج كان ينشئ رسالة نصية بدل استدعاء السلطة.
2. لم تكن هناك حالة إضافة معلّقة (loading/disabled/aria-busy) على الزر.
3. شارة السلة في الهيكل لم تكن تُحدَّث بعد نجاح الإجراء.
4. لا يوجد أي تأكيد بصري صادق مرتبط بنجاح الخادم.
5. سطح المحادثة كان يخفي مدخل السلة كليًا: `AppShell` لا يعرض `TopBar` على `/` و`/ai`، و`CartButton` الوحيد كان داخله؛ فلا شارة سلة مرئية ولا وجهة لطيران التأكيد ولا طريق إلى `/cart`.

### 2.2 ما أُعيد استخدامه

- إجراء `POST /api/ai/conversations/:id/actions/add-to-cart` ومفتاح البطاقة `cardAddKey` والإيصال المخزَّن في نفس معاملة كتابة السلة.
- `CartContext.refreshFromServer` القائم بدل عدّاد محلي.
- `friendlyError` و`role="alert"` القائمين لعرض الفشل.
- نظام التصميم القائم (زر `gold`، `SmartImage`، شارة «إعلان ممول»).
- SSE/restore القائم؛ لا قناة بث جديدة.

### 2.3 التنفيذ

| الملف | التغيير |
|---|---|
| `artifacts/dinar/src/pages/Ai.tsx` | `addListing` يعيد `boolean`: `true` فقط بعد 2xx وإيصال مخزَّن، ثم `refreshFromServer` لشارة السلة، و`false` في كل فشل أو إلغاء سباق |
| `artifacts/dinar/src/features/ai/ConversationContent.tsx` | زر البطاقة يستدعي `onAdd(listing, resultSetId)` مباشرة، ويعرض `loading` و`aria-busy` و`aria-label` «جارٍ الإضافة إلى السلة»، ويشغّل الحركة فقط إذا أعاد الخادم نجاحًا |
| `artifacts/dinar/src/features/ai/cart-basket-animation.ts` (جديد) | Web Animations API: صورة مصغرة تطير إلى السلة 620ms؛ تُلغى كليًا عند `prefers-reduced-motion` أو غياب الصورة/هدف السلة؛ أحداث `dinar:cart-flight-start/skipped/end`؛ لا تغيير في أي حالة |
| `artifacts/dinar/src/pages/Ai.tsx` + `AiChat.css` | مدخل السلة داخل المحادثة نفسها: رابط `/cart` في تذييل الشريط الجانبي المرئي افتراضيًا (`footer-cart`)، وفي شريط الأدوات عند طيّ الشريط (`sidebar-cart`)، وعائم أعلى الهاتف (`link-cart`)؛ الثلاثة تحمل شارة `badge-cart-units` من الخادم. الحركة تختار أول وجهة مرئية فعلًا من الثلاث |

### 2.4 ضمان الصدق

- الحركة تُشغَّل فقط داخل `.then((added) => { if (!added) return; animateListingToBasket(image); })`، وملفّفة بـ`try/catch` حتى لا يتحول أي فشل بصري إلى خطأ أمام مستخدم نجح طلبه فعليًا؛ و`animate` غير المتاحة في متصفح قديم تُرجع `unsupported` بعد إزالة العقدة بدل أن ترمي.
- **الوجهة المرئية:** للسلة داخل المحادثة رابط ظاهر في كل حالة — تذييل الشريط الجانبي عند فتحه (`footer-cart`)، وشريط الأدوات عند طيّه (`sidebar-cart`)، وزر عائم على الهاتف (`link-cart`)؛ والحركة تختار أول وجهة مرئية فعلًا، فلا تطير إلى عنصر مخفي ولا تفشل بسبب عنصر غير معروض.
- عند 500 لا يحدث أي حدث طيران إطلاقًا (`flights == []`)، وتظهر رسالة الخطأ، وتبقى الكمية وشارة السلة كما هي.
- **النقر المزدوج:** `sending.current` يُقفل بشكل متزامن قبل أول `await`، والزر يصبح `disabled`/`aria-busy` فور إعادة العرض؛ لا يُرسل طلب ثانٍ. وعلى الخادم، قفل صف المستخدم `for update` يُسلسل الطلبين المتزامنين: أُثبت في CI أن طلبين متوازيين يعيدان الإيصال نفسه ويكتبان مفتاحًا واحدًا وكمية واحدة.
- **التأكيد المتكرر:** إعادة النقر بعد النجاح تعيد الإيصال المخزَّن نفسه (نفس `assistantMessage.id`)؛ التطبيق يتذكر الإيصالات المعروضة في `confirmedReceipts` ويمنع إضافتها مرتين ويمنع الحركة الثانية، فلا يوحي للمستخدم بإضافة جديدة لم تحدث.
- **إعادة التحميل:** بعد reload تُقرأ الرسالة المخزَّنة من المحادثة، فتكون معروفة مسبقًا ولا تُشغَّل حركة عند نقر البطاقة القديمة، بينما تبقى شارة السلة والكمية من الخادم.
- إعادة المحاولة على نفس البطاقة تعيد الإيصال المخزَّن نفسه ولا تضيف وحدة ثانية.
- مجموعة نتائج قديمة (stale result set) تُرفض بـ409 دون لمس السلة.

## 3. D8 — الأمان والموثوقية

### 3.1 مصفوفة الفحص

| المحور | الحالة قبل الموجة | الإجراء | الدليل |
|---|---|---|---|
| CSRF/Origin | حماية قائمة: رفض الكتابات عبر `Origin`/`Sec-Fetch-Site` واشتراط JSON | أُعيد التحقق ولم يُغيَّر | `same-origin-web.test` (cross-origin 403)، `security-acceptance` |
| Session | جلسة كوكي `HttpOnly`/`SameSite=Lax` عبر `sessionMiddleware` | لم يُغيَّر | `same-origin-web`، اختبارات D4/D5 |
| XSS | React escaping + CSP غائبة | أُضيفت CSP صارمة | رؤوس `/api/healthz` وSPA shell |
| Clickjacking | غائب | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | اختبار الرؤوس |
| ميزات المتصفح الحساسة | غير مقيّدة | `Permissions-Policy` (camera/mic/geolocation=self، payment/usb معطّلة) | اختبار الرؤوس |
| HSTS | غائب | إنتاجي فقط، و`includeSubDomains` اختياري صريح بعد جرد النطاقات | اختباران: تطوير بلا HSTS، إنتاج host-only، واشتراك النطاقات عند `HSTS_INCLUDE_SUBDOMAINS=true` |
| رفع الصور المباشر | presigned PUT إلى مخزن الكائنات | `connect-src` يضم أصل `OBJECT_STORAGE_S3_ENDPOINT` وقائمة `CSP_CONNECT_EXTRA_ORIGINS` المقيّدة | اختبارات الرؤوس |
| Webhooks | توقيع/مبلغ/عملة/حالة المزود تُتحقق | لم يُغيَّر | `routes/payments.ts`، `routes/commercial.ts`، `commercial-ledger` |
| Idempotency | مفاتيح قائمة للإجراءات والدفع والسلة | لم يُغيَّر، وأُثبت لإجراء السلة | D7 harness |
| صفائف JSON الضخمة | حد 2000 عنصر قبل Zod | لم يُغيَّر | `app.ts` |
| الصلاحيات الإدارية | أدوار ومراجعة قائمة | لم يُغيَّر | D3A/D4/D5 |
| أسرار CI | لا أسرار مستخدمة؛ Actions مثبتة بـSHA | لم يُغيَّر | `qoder-security` |
| الاعتماديات | فحص pnpm audit | 0 high/0 critical | `qoder-security` |

### 3.2 التغيير

في `artifacts/api-server/src/app.ts` أُضيفت على كل استجابة:

- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' …; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
- `X-Frame-Options: DENY`.
- `Permissions-Policy`: `camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), interest-cohort=()`.
- `Strict-Transport-Security` فقط عند `NODE_ENV === "production"`، وبالقيمة `max-age=31536000` (host-only) افتراضيًا.

`style-src` يسمح inline لأن أسلوب الحركة يُطبَّق مباشرة على العنصر، والخطوط الخارجية الوحيدة المسموحة هي Google Fonts المعلنة في `index.html`. خادم Vite في التطوير لا يمر بهذه الرؤوس، لذلك لا تنكسر اختبارات المتصفح.

### 3.3 `connect-src` والتكاملات المخطط لها

رفع صور الإعلانات والمستندات وصورة الحساب يحدث **من المتصفح مباشرة** إلى رابط presigned، وليس عبر الخادم. لهذا لا يمكن ترك `connect-src 'self'` فقط في الإنتاج. الحل المطبّق ضيّق وقابل للتحقق:

| المصدر | أين يعمل | ما تحتاجه CSP | الحالة |
|---|---|---|---|
| Railway (الواجهة + API) | نفس الأصل | `'self'` فقط | مغطى |
| S3 presigned PUT/GET | المتصفح | أصل `OBJECT_STORAGE_S3_ENDPOINT` | يُضاف تلقائيًا عند `OBJECT_STORAGE_PROVIDER=s3` |
| Replit signed URLs (الجلسات الحالية) | المتصفح | أصل التوقيع العام غير معروف مسبقًا | يُضبط عبر `CSP_CONNECT_EXTRA_ORIGINS` عند الحاجة، وإلا تبقى مغلقة |
| Mapbox (مخطط) | المتصفح لاحقًا | `img-src` لنطاقات tiles و`connect-src` لـ api/events و`worker-src blob:` | لم يُضف الآن؛ لا يوجد أي استخدام في الشيفرة |
| Sentry SDK (مخطط) | المتصفح لاحقًا | حزمة self-hosted تحت `script-src 'self'` و`connect-src` لنطاق ingest | لم يُضف الآن؛ لا يوجد أي استخدام |
| Resend (بريد) | الخادم فقط | لا شيء | لا تغيير |
| مزودو AI المعتمدون | الخادم فقط عبر model gateway | لا شيء | لا تغيير |

`CSP_CONNECT_EXTRA_ORIGINS` يقبل قائمة أصول `http(s)` فقط ويرفض أي قيمة غير صالحة أو مخطط خطير (مثل `javascript:`)؛ لا wildcards ولا مسارات. أُثبت ذلك باختبار مستقل.

### 3.4 قرار HSTS

لا يوجد في المستودع نطاق إنتاج معتمد ولا جرد نطاقات فرعية. لذلك رُفض `includeSubDomains` افتراضيًا: فرضه على نطاقات فرعية لا نعرف أنها HTTPS-only قد يعطّل خدمة فرعية. السياسة المنفذة:

- التطوير: لا HSTS إطلاقًا (حتى لا يُثبَّت على مضيف التطوير).
- الإنتاج: `max-age=31536000` على المضيف فقط.
- `includeSubDomains` يُفعَّل صراحةً بـ`HSTS_INCLUDE_SUBDOMAINS=true` بعد موافقة المالك وجرد النطاقات. لا preload.


### 3.5 الدليل

- `same-origin-web.test`: «the shell and API carry the browser security policy» و«HSTS is sent in production» — نجحا على PG16 في CI.
- D7 harness يعيد التحقق من CSP وXFO وPermissions-Policy على `/api/healthz`، ومن غياب HSTS في التطوير.
- `qoder-security`: `AUDIT_VULNERABILITIES {"info":0,"low":0,"moderate":0,"high":0,"critical":0}`، gitleaks وفحص الأنماط الحساسة نجحا.

## 4. D9 — الحملات والهدايا

### 4.1 الموجود وأُعيد استخدامه

- خطط الترويج من الإدارة (`promotionProducts`) مع السعر والعملة والمدة والموضع والحد الأقصى للميزانية وسعر الوحدة.
- لقطة ثابتة على الحملة (`*_snapshot`)؛ تعديل الخطة لاحقًا لا يعيد كتابة حملة مقبولة.
- التفعيل يحتاج دفعًا محاكيًا مُلتقَطًا موقّعًا (`SIMULATION_CAPTURED`)، والتقديم يُقيَّم عند القراءة (الحالة + الدفع + النافذة + الميزانية).
- الاستهداف حسب السوق والتصنيف ونص البحث، والترتيب التجاري المحدد، ولافتة «إعلان ممول».
- الجدولة عبر `startsAt` المستقبلي (تظهر `SCHEDULED`)، والانتهاء عبر `expiresAt` (تظهر `EXPIRED`)، والإيقاف/الاستئناف/الإلغاء، وسياسة استرداد الميزانية غير المستخدمة.
- الحملات لا تنشئ طلبًا ولا عمولة ولا تسليمًا.

### 4.2 الفجوة المؤكدة

تغيير الحالة (PAUSE/RESUME/CANCEL) كان يحدّث الصف أو يحرر الميزانية لكنه لا يترك أثرًا دائمًا يبيّن من غيّر الحملة ومتى ولماذا. لا يوجد سجل تدقيق حملات قابل للاستعلام.

### 4.3 التنفيذ

في `artifacts/api-server/src/lib/promotions.ts` داخل معاملة `changePromotion` نفسها:

- `PROMOTION_PAUSE` عند تغيير فعلي إلى PAUSED.
- `PROMOTION_RESUME` عند تغيير فعلي إلى ACTIVE بعد اجتياز الأهلية.
- `PROMOTION_CANCEL` بعد تحرير الميزانية، مع `releasedMinor` في البيانات.
- كل صف يحمل `promotionId` و`listingId` و`from` و`to`، والمنفّذ `actorId` والسوق `marketId`.
- لا يُكتب أي صف عند no-op (إيقاف موقوف، استئناف نشط، إلغاء ملغى) ولا عند محاولة مرفوضة (404 لبائع آخر).

### 4.4 ما لم يُنفذ ولماذا

| البند | الحالة | السبب |
|---|---|---|
| مسودات حملات ومراجعة | **BLOCKED** | لا قرار مالك على نموذج المراجعة، والمسارات الحالية تنشئ حملة مؤكدة الدفع فقط؛ إضافة حالة مسودة بلا نموذج مراجعة تفتح سلطة نشر غير محسومة |
| إنشاء هدايا/كوبونات واستردادها ومنع التكرار | **BLOCKED** | `DINAR_REMAINING_WORK_FOR_REPLIT.md` ينص صراحة على عدم وجود هدايا أو كوبونات، وبوابة الإطلاق بند 9 تترك القرار للمالك؛ تنفيذها بلا قرار يعني إنشاء دفتر مالي موازٍ |
| منع الاحتيال في الإسناد | **VERIFIED EXISTING** | الإسناد يرفض الحملات غير المقدَّمة، ويمنع الإسناد الذاتي (`SKIPPED_SELF`)، ولا يحتسب إلا المطابقة الصالحة؛ لم يُغيَّر |
| تفعيل حقيقي أو تحويل أموال | **OUT OF SCOPE** | محاكاة فقط بحسب المهمة |

## 5. القبول في المتصفح (D7)

سكربت `artifacts/dinar/test/wave03-d7-cart-ui.mjs` يعمل على Chromium حقيقي، عبر Vite للواجهة وAPI الفعلي، بجلسة مشترٍ حقيقية وثلاث صور مرفوعة فعليًا إلى تخزين S3 المحلي، وثلاثة إعلانات منشورة، وحملة محاكاة مُلتقَطة واحدة.

| المرور | العرض | ما يُثبت |
|---|---|---|
| normal | 390×844، حركة عادية | RTL عربي، لافتة «إعلان ممول»، صورة `/api/storage/objects/listing-photos/`، مدخل سلة مرئي على الهاتف، حالة busy/disabled وaria-label عربية، طيران بعد 2xx، إزالة عقدة الطيران، شارة السلة 1، كمية 1، إيصال CART واحد |
| reduced | 390×844، `prefers-reduced-motion: reduce` | حدث `skipped` بسبب `reduced-motion`، لا عقدة طيران، السلة تتغير مرة واحدة فعلًا، الشارة 2 |
| desktop | 1440×900 | فشل إجباري 500: تنبيه مرئي، صفر طيران، شارة 2، كمية 0؛ ثم Enter على الزر المركّز ينجح بطيران واحد وشارة 3؛ إعادة التحميل تعيد شارة 3 وكمية 1 من الخادم |

assertions إضافية في harness الخادم: لا أخطاء صفحة أو console أو طلبات خارجية، إعادة المحاولة مرتين تعيد نفس الإيصال دون زيادة الكمية، مجموعة النتائج القديمة 409 دون تغيير السلة، وعدد استدعاءات النموذج صفر.

## 6. الاختبارات والانحدار

| التشغيل | الفرع/SHA | النتيجة |
|---|---|---|
| `wave03-d7-cart-browser-journey.test` PG16 | `e406174` | **نجح** — [41555933026](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41555933026) |
| `wave03-d7-cart-browser-journey.test` PG18 | `e406174` | **نجح** — [41555939168](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41555939168) |
| `wave03-d9-campaign-audit.test` PG16 | `e406174` | **نجح** — [41556530441](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556530441) |
| `wave03-d9-campaign-audit.test` PG18 | `e406174` | **نجح** — [41556537930](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556537930) |
| `same-origin-web.test` PG16 | `e406174` | **نجح** — [41556543810](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556543810) |
| `w02u3-card-accessibility-browser-journey.test` PG16 | `e406174` | **نجح** — [41556561672](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556561672) |
| `security-acceptance.test` PG16 | `e406174` | **نجح** — [41556549278](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556549278) |
| `block-f3-commerce.test` PG16 | `e406174` | **نجح** — [41556566901](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556566901) |
| `d1-d2-business-foundation.test` PG16 | `829a859` | نجح (لم يتغير منطق الأعمال بعد هذا الـSHA؛ التغييرات اللاحقة: رؤوس CSP في `app.ts` وواجهة المحادثة واختبارات فقط) |
| `d3a-native-business.test` PG16 | `829a859` | نجح (كما أعلاه) |
| `wave02-card-reliability.test` PG16 | `829a859` | نجح (كما أعلاه) |
| `qoder-security` | `e406174` | **نجح** — [41556572350](https://github.com/qurankream0987-eng/dinar-pro/actions/runs/41556572350): 0 high / 0 critical، gitleaks «no leaks found» |

كل التشغيلات على قاعدة PostgreSQL مؤقتة loopback داخل GitHub Actions، بلا وصول إنتاجي.

## 7. الملفات وفرق الشيفرة

`git diff --stat 11d7fbe..e406174`

```
.github/workflows/qoder-api-suite.yml              |   5 +-
 artifacts/api-server/src/app.ts                    |  61 ++++
 artifacts/api-server/src/lib/promotions.ts         |  27 +-
 .../api-server/test/safe-development-database.ts   |   3 +
 artifacts/api-server/test/same-origin-web.test.ts  |  82 +++++
 .../test/wave03-d7-cart-browser-journey.test.ts    | 398 +++++++++++++++++++++
 .../test/wave03-d9-campaign-audit.test.ts          | 197 ++++++++++
 .../dinar/src/features/ai/ConversationContent.tsx  |  52 ++-
 .../dinar/src/features/ai/cart-basket-animation.ts | 121 +++++++
 artifacts/dinar/src/pages/Ai.tsx                   |  91 ++++-
 artifacts/dinar/src/pages/AiChat.css               |  51 +++
 artifacts/dinar/test/wave03-d7-cart-ui.mjs         | 396 ++++++++++++++++++++
 12 files changed, 1460 insertions(+), 24 deletions(-)
```

يُضاف إلى ذلك هذا التقرير `docs/dinar-next/QODER_WAVE03_D7_D8_D9_REPORT.md` في إيداع التوثيق الأخير. لا تغييرات في المخطط ولا ترحيلات.

## 8. Commit / Push

- `829a859` — feat(wave03): truthful cart acknowledgement, browser security policy and campaign audit.
- `d842e92` — test(wave03): carry the registered seller session into the campaign suite.
- `b3aa566` — test(wave03): read the cancellation end from the canonical campaign row.
- `0cab7b2` — fix(wave03): keep the browser on the same origin and acknowledge a receipt once.
- `0427844` — fix(wave03): scope browser connections to the configured upload origin and host-only HSTS.
- `74ccd77` — fix(wave03): keep the acknowledgement cosmetic when the animation API is unavailable.
- `7dbacdc` — test(wave03): close the loopback object store so the journey process can exit.
- `ac4316d` — test(wave03): keep the search fixtures out of the cart intent.
- `16296da` — test(wave03): read the result-set id from the container that owns it.
- `9ab3ec9` — feat(wave03): keep the canonical cart reachable inside the conversation (استُبدل في `f7edd5b` لأن `AppShell` لا يعرض `TopBar` على صفحات المحادثة).
- `f7edd5b` — fix(wave03): expose the canonical cart destination in the conversation (رابط الهاتف العائم + شريط الأدوات، وإرجاع تعديل `AppShell` غير الفعّال).
- `a9bbec1` — fix(wave03): put the conversation cart entry on the visible sidebar footer (الوجهة المرئية افتراضيًا على سطح المكتب).
- `2a39f21` — test(wave03): retire the forced failure before the keyboard retry.
- `e406174` — test(wave03): accept only the deliberately forced failure as console noise.
- إيداع التوثيق الأخير — هذا التقرير فقط.

لم يُدفع أي شيء إلى `main` أو `replit/dinar-next-complete-development`. الفرع الوحيد المدفوع: `qoder/wave03-d7-d9-closure`.

## 9. تعليمات الدمج

1. راجع فرق الملفات أعلاه. الفرع مبني على canonical `11d7fbe`. لا تعارض في ملفات المصدر مع Wave 01/02 (التي تعدّل `conversation-runtime.ts` و`smart-turn.ts` وملفات الأمان/الأعمال الخاصة بها).
2. **التداخل الوحيد المتوقع:** `.github/workflows/qoder-api-suite.yml` مع `ai-foundation-02` (`2ef9c07`) و`qoder/wave02-d4-d6-closure` و`qoder/wave01-d1-d3-closure`. الحل: دمج قوائم الخيارات والرايات (union) والاحتفاظ بالسويتات الثلاثة المضافة `wave03-d7-cart-browser-journey.test` و`wave03-d9-campaign-audit.test` و`same-origin-web.test` مع راية `BDINAR_WAVE03_ACCEPTANCE`. لا تُحذف أي ترقيم/رايات من الفروع الأخرى.
3. **AI-FOUNDATION-02:** يعدّل `artifacts/api-server/src/ai/*` فقط (لا يتقاطع مع `app.ts` ولا `promotions.ts` ولا واجهة المحادثة). إن دُمج قبله، أعد تشغيل `ai-foundation` chain بعد الدمج للتأكد من بقاء عزل النموذج عن السلة.
4. **Railway integrations:** فرع `replit/railway-integrations-readiness` (`6bade78`) لا يمس أي ملف من ملفات هذه الموجة. عند النشر على Railway:
   - الواجهة والـAPI على نفس الأصل، لذلك `connect-src 'self'` كافٍ افتراضيًا.
   - اضبط `OBJECT_STORAGE_PROVIDER=s3` و`OBJECT_STORAGE_S3_ENDPOINT` إن كان الرفع المباشر إلى S3، أو أضف أصل التوقيع في `CSP_CONNECT_EXTRA_ORIGINS` (قائمة أصول http(s) مفصولة بفواصل، بلا wildcards).
   - لا تُفعّل `HSTS_INCLUDE_SUBDOMAINS=true` إلا بعد جرد النطاقات الفرعية والتأكد أنها HTTPS-only؛ الافتراضي آمن للمضيف وحده.
   - تحقق أن وسيط Railway/Vite لا يحذف `Content-Security-Policy` و`X-Frame-Options` و`Permissions-Policy` ولا يعيد كتابة `Origin` بما يكسر فحص CSRF.
   - Mapbox وSentry غير مستخدمين في الشيفرة؛ عند إضافتهما لاحقًا أضف نطاقاتهما إلى `img-src`/`connect-src`/`worker-src` في سياسة مقيّدة، وResend ومزودو AI يبقون على الخادم فقط.
5. ادمج `qoder/wave03-d7-d9-closure` في canonical بعد مراجعة المالك، ثم شغّل من canonical:
   - `wave03-d7-cart-browser-journey.test` مع `BDINAR_WAVE03_ACCEPTANCE=development BDINAR_PROMOTIONS_ENABLED=true` على PG16 وPG18.
   - `wave03-d9-campaign-audit.test` بالرايات نفسها.
   - `same-origin-web.test` و`security-acceptance.test` و`w02u3-card-accessibility-browser-journey.test` و`block-f3-commerce.test`.
6. لا تحتاج أي ترحيل قاعدة بيانات: لم يتغير المخطط؛ سجل التدقيق يستخدم جدول `market_audit` القائم و`action` نصي.
7. الهدايا/الكوبونات تبقى خارج النطاق حتى قرار المالك وبوابة الإطلاق.

## 10. الحدود والمخاطر المتبقية

- لم يُثبت سلوك CSP على متصفحات قديمة أو على أي صفحة تتضمن style/script خارجيًا غير Google Fonts؛ أي إضافة CDN لاحقًا تتطلب تحديث السياسة عمدًا.
- الحركة البصرية تُثبت عبر Chromium فقط (Playwright)؛ لا يوجد دليل على WebKit/Firefox في هذه الموجة.
- مسودات الحملات والهدايا تحتاج قرار منتج قبل أي تنفيذ.
- لا إعلان جاهزية إطلاق أو امتثال قانوني؛ هذا تقرير هندسي فقط.
