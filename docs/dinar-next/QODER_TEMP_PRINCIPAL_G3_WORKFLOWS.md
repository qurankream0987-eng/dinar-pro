# QODER TEMPORARY PRINCIPAL — G3: جرد سير الأعمال الثلاث عشرة وتتبّعها

**الفرع:** `qoder/temp-principal-sixwave-closure`. **مرجع الكود المقروء:** `ebdd2d7` (رأس المرشّح الموحّد) وما فوقَه من التزامات هذا الفرع.
**طريقة القياس:** قراءة مصدر مباشرة (`Grep`/`Read`) لملفات `artifacts/api-server/src/routes/` و`src/lib/` و`src/ai/`، ومطابقة كل مسار على الحزم الاختبارية التي تستدعيه فعليًا.

---

## 0. إعلان الاشتقاق (لا يُقرأ هذا الجدول كنقل)

نص المهمة يطلب تدقيق «الـ13 سير أعمال التجارية». **لا يوجد في المستودع artifact يعدّد ثلاثة عشر بالضبط.** الموجود هو:

| ما هو موجود فعلًا | العدد | الموضع |
|---|---|---|
| عقود عملية في runtime المحادثة | **16** | `lib/api-zod/src/conversation-runtime.ts:1331-1431` |
| سيناريوهات SC الموثّقة | **10** | `artifacts/api-server/test/sc0{1,2,3,6,7,10}-*.test.ts` |
| مجالات D المرقّمة | **D1–D17** | مجلد `docs/dinar-next/` |
| حزم CI المُراجَعة | **81 خيار `suite` + 9 سلاسل** | `.github/workflows/qoder-api-suite.yml:21-102` |

لذلك القائمة التالية **مشتقّة** من سطح الـHTTP الحقيقي (`src/routes/index.ts:28-55` — 25 موجّهًا mount) ومن طبقات الخدمة المستوردة في كل موجّه، لا منقولة من وثيقة. أي اتفاق بالعدد مع رقم «13» عرضي، والبنود قابلة للتحقق كلٌّ بمساره وموجّهه.

**الأرجُل الثمانية المطلوبة** في كل صف: طلب المستخدم ← UI ← API ← تخويل ← قاعدة بيانات ← إيصال ← إعادة تحميل ← إعادة محاولة. العمود الأخير يعطي **حزمة خضراء واحدة على الأقل** شغّلت هذا المسار على هذا الفرع، أو declares الفراغ صراحة.

---

## 1. الجرد المشتقّ (13)

| # | سير العمل | API (الموجّه) | الـUI | طبقة الخدمة / التخويل | قاعدة البيانات | حزمة خضراء على هذا الفرع |
|---|---|---|---|---|---|---|
| 1 | نشر معروضة بالصور مع حارس نصوص التواصل | `POST /listings`، `GET/PATCH /listings/:id`، `POST /account/listing-photos/{upload-url,complete}` | `features/ai/ConversationContent.tsx`، لوحة المعروضة | `routes/marketplace.ts` ← `lib/listing-contact.ts` (`findListingContactText`)، `lib/publication-policy.ts`، `lib/listing-photos.ts`، `requireAuth` ×6 | `listings`، `listingPhotos`، `markets` | `listing-image-publication-acceptance` / `commerce-journey` داخل التساعية (`41861217793`) |
| 2 | البحث والاكتشاف | `GET /categories`، `GET /listings?q=` | `pages/Ai.tsx` + بطاقات النتائج | `routes/categories.ts` ← `lib/marketplace-categories.ts`؛ SQL البحث في `src/ai/search-*` | `listings` + فهرس trigram على `messages` (D17) | `search-sql-foundation` و`w06-d17-retrieval-quality` (`41859324605`، 296 ب/رسالة بعد REINDEX) |
| 3 | الاستفسار والتفاوض المحادثي | `POST /ai/conversations/:id/turns` | `features/ai/surface/*` | `routes/ai.ts` ← `ai/inquiry-turn.ts`، `ai/negotiation-turn.ts`، `ai/buyer-turn.ts`؛ `requireAuth` ×17 | `conversations`، `messages`، `offers`، `aiResultSets`، `aiUiBlocks` | `next-g2-inquiry` + `universal-negotiation-acceptance` (سلسلة `d6-g2-negotiation`) |
| 4 | السلة الدائمة | `GET/POST/DELETE /cart`، `POST /checkout` | `Ai.tsx` + `cart-basket-animation.ts` | `routes/marketplace.ts` ← `lib/marketplace-cart.ts` | `carts`/`cartItems` ([`lib/db/src/schema/index.ts:891,905`](file:///D:/DINAR/dinar-sw1/lib/db/src/schema/index.ts#L891)) — **لا `localStorage`** | `wave03-d7-cart-browser-journey` (`41863266956`، متصفح حقيقي Chromium) |
| 5 | إنشاء الطلب ولقطة البنود المالية | `POST /orders`، `GET /orders/:id` | `features/OrderParts.tsx` | `routes/marketplace.ts:837-874` (إدراج الطلب، `paymentMethods` من المعروضة سطر 834) | `orders` + **`0056_order_line_integrity.sql`**: `dinar_reject_order_snapshot_mutation()` يحمي `data->'items'` والإجماليات | `commerce-journey` + `wave07-w12-contract-hardening` (التساعية PG16+PG18) |
| 6 | اختيار وسيلة الدفع ونية الدفع | `POST /payments/intents`، و`PAY` داخل الأدوار المحادثية | بطاقة `PAYMENT_REVIEW` | `routes/payments.ts` ← `lib/payments/{contracts,service,test-adapter}.ts` (`requireSimulation`)؛ `ai/buyer-turn.ts:1192-1258` | `paymentIntents`، `paymentRefunds`؛ الاختيار يُخزَّن في `orders.data.selectedPaymentMethod` فقط | `block-f3-commerce`، `wave07-financial-journal` — **و`g2-smart-conversation` معلّق على العيب الخامس (§3)** |
| 7 | التسليم كاش والإبراء | `POST /orders/:id/cash-payment/{claim,confirm,deny,dispute}`، `GET /orders/:id/cash` | `ActionReceipts.tsx` | `routes/cash.ts:80-142` — كل مسار `requireAuth` + قسر الطرف الصحيح (`buyerId` للادّعاء و`sellerId` للتأكيد) + `cashEngineEnabled` | `cash_payment` في طبقة `lib/payments/cash.ts`، وكل انتقال مُقيَّد بمفتاح عدم التكرار (`readIdempotencyKey`، cash.ts:68) | `wave08-cash-and-refunds` (`41861210735` 12/12، وداخل التساعية PG16/PG18) |
| 8 | الاسترداد الكاش | `POST /orders/:id/cash-refunds`، `/cash-refunds/:id/{repayment-claim,confirm,dispute,withdraw}` | نفس البطاقة | `routes/cash.ts:152-215` ← `openCashRefundCase`/`confirmCashRefundReceipt`/`withdrawCashRefundCase` | سجل الاسترداد + قيود `order-journal` | `wave08-cash-and-refunds` + `integration-cash-lock-order` (الأخيرة خارج Allowlist — انظر §2) |
| 9 | النزاع والاستئناف | `GET /appeals`، `POST /appeals/:id/withdraw`، `/orders/:id/dispute/evidence`، `/admin/appeals/:id/decision`، `/admin/disputes/:orderId/resolve` | `Sheet.tsx` + لوح الإدارة | `routes/appeals.ts` ← `lib/trust-appeals.ts`؛ `requireAuth` ×7 + `admin` ×3؛ و`lib/payments/disputes.ts` في مسار الطلب | `security_incidents` (+ trigger إغلاق `0055`)، جداول النزاع | `wave10-trust-support-whatsapp` (التساعية)؛ `admin/disputes` في `security-acceptance` (12/12) |
| 10 | أجرة المتعاقد وتكليفه | `/orders/:id/courier-fare{/proposals,/confirm}`، `/courier/commission-account{/settlements}`، `/admin/drivers/:id/review` | لوح التوصيل `DeliverySurface.tsx` | `routes/courier.ts` + `routes/admin-drivers.ts` ← `lib/courier-economics.ts`؛ `driverProfiles` | `driverProfiles`، `orders` | **فراغ إثبات** — انظر §2 |
| 11 | التفويض التجاري (موظفون وصلاحيات) | `/business/profiles/:id/delegations{,/activate,/suspend,/resume,/revoke}` | إعدادات العمل | `routes/business-delegations.ts` ← `lib/business-delegations.ts` (مفتاح عدم التكرار **هنا لا في الموجّه**: السطر 344 + فهرس فريد) | `businesses`، `business_memberships`، `business_delegations` | `d4-d5-authorization` (`41864491280` — ثلاث حزم `exit=0 outbound=0` على قاعدة مشتركة) |
| 12 | المتجر الاشتراكي: باقات، اعتمادات، حملات | `/commercial/{balance,topups,purchases,entitlements}`، `/business/subscription*`، `/promotions*` | لوح الأعمال | `routes/commercial.ts` (`requireAuth` ×26) + `routes/promotions.ts` (×11) ← `lib/commercial-ledger.ts`، `lib/subscription-plans.ts`، `lib/promotion-policy.ts` | `commercial_ledger`، `subscriptions`، `promotion_*` | جزئي: `promotion-intent` خضراء ضمن `d6-g2-negotiation`؛ **`commercial/` خارج Allowlist** — انظر §2 |
| 13 | الخصوصية والامتثال وبوابة السوق القانونية | `/privacy/requests*`، `/account/seller-verification`، `/account/policy-consents`، `/admin/compliance/*`، `/admin/security/incidents*`، `/account/market` (في `lib/auth.ts:653`) | حوارات الموافقة + لوح الإدارة | `routes/privacy.ts` ← `lib/privacy-rights.ts`؛ `routes/compliance.ts` ← `lib/{country-legal-readiness,d16-readiness,policy-lifecycle}.ts`؛ `requireAuth` ×11/×9 | `privacy_requests`، `policy_versions`، `security_incidents` (trigger `0055` يمنع تعديل المغلق) | `wave09-policy-consent-compliance` (التساعية) + `wave06-d16-d17` (`41855763788`) + `d16-readiness` (15/15) + `w06-d16-adversarial` |

---

## 2. الفراغات المقاسة (لا تُغطّى بالأخضر المجاور)

**(أ) سيرتا 10 و12 غير قابلتين للإثبات على CI بهذا الفرع.** الحزم التي تغطي `/courier-fare` و`/admin/drivers` و`/commercial/*` موجودة في المستودع — `block-f4-driver.test.ts`، `block-f5-unified.test.ts`، `g1-provider.test.ts`، `g-final.test.ts`، `pre-switch.test.ts` — لكن **لا واحدة منها في قائمة `suite` المغلقة** في `.github/workflows/qoder-api-suite.yml:21-102`، ولا داخل أيٍّ من السلاسل التسع. نتيجة عملية: `input` من نوع `choice` في GitHub يقبل قيم `options` فقط، وقد اختبرت هذه الآلية حرفيًا في هذا السياق حين رُفض إرسالي بـ`HTTP 422: Provided value 'none' for input 'suite' not in the list of allowed values` لأن `none` ليس من خياراتها. لم أُرسّل `block-f4-driver.test` بنفسي لأصادف رفضه — الاستنتاج آليةٌ لا قياس مباشر. لم أُوسّع الـallowlist بنفسي: ذلك يغيّر posture بوابة الإرسال التي وُضعت لتقييد ما يمكن تشغيله، وهو قرار مالك لا قرار وكيل. **المطلوب:** إما إضافة هذه الحزم إلى Allowlist بأعلامها المراجَعة، أو تشغيلها محليًا على قاعدة loopback وإرفاق الطّلب. حتى يحدث ذلك، البندين 10 و12 يُسجَّلان **غير مُثبَتين** لا ناجحين.

**(ب) أرجل «إعادة المحاولة» ليست موحّدة.** مفتاح عدم التكرار موجود في الموجّه لـcash/payments/commercial/courier/promotions، وفي طبقة الخدمة للتفويضات، و**غائب** في `routes/appeals.ts` (صفر موضع). هناك الالتزام مكتفٍ بـ«نزاع واحد لكل طلب»؛ لم أثبِت أن ذلك يمنع مضاعفة الأثر عند إعادة إرسال نفس الطلب — وهو أول ما يجب فحصه إذا طُلب توسيع G3.

**(ج) ملاحظة أمنية مكرَّرة من G5:** لا `PATCH /account/market` (`lib/auth.ts:653`) ولا `SWITCH_MARKET` المحادثي يستدعيان `assertCountryActivationReady`. التصفّح محكوم بـ`isMarketAvailable` فقط ([`lib/markets.ts:53-55`](file:///D:/DINAR/dinar-sw1/artifacts/api-server/src/lib/markets.ts#L53))، أي أن البند 13 يخفّض سياج البند 5 عند تبديل السوق. قرار تصميم (§9 من تقرير G0)، لا إصلاح صامت.

---

## 3. العيب الخامس المكتَشَف بهذاالتدقيق: `G2-36B`

سير العمل 6 كشفه. الحزمة `g2-smart-conversation.test.ts` كانت **تعيد كتابة بنود الطلب المؤكَّد** لتزوير طلب «كاش فقط»:

```ts
await db.update(orders).set({
  data: { ...paymentOrderFixture!.data,
          items: originalItems.map((item) => ({ ...item, paymentMethods: ["CASH_DIRECT"] })) },
}).where(eq(orders.id, paymentOrderId));
```

وهذا حرفيًا ما يمنعته `0056_order_line_integrity.sql:141` (`OR NEW.data -> 'items' IS DISTINCT FROM OLD.data -> 'items'`) على أي طلب إصداره 1 — وكل طلب يُنشأ بعد ذلك الترحيل إصداره 1 (`:6` و`:15-29`). التشغيل `41864496845` (PG16، سلسلة `d6-g2-negotiation`) سقط بـ`_DrizzleQueryError … Order financial snapshot is immutable` (55000).

**التأصيل أنه عيب قائم في المرشّح لا تراجع مني:** `git log` يُظهر أن عبارة `items` أدخلها `f2f19f5`، وإجبار الإصدار 1 أدخله `0b81a57`، وكلاهما **سلف** لـ`ebdd2d7`، ولم يُمَاس اختبار `G2-36B` في أيٍّ منهما. أي أن السلسلة كانت حمراء على المرشّح قبل أي التزام لي.

**المنتج سليم والحارس يجب أن يبقى:** `persistPaymentMethod` ([`ai/buyer-turn.ts:1109-1116`](file:///D:/DINAR/dinar-sw1/artifacts/api-server/src/ai/buyer-turn.ts#L1109)) ينشر `order.data` ويضبط `selectedPaymentMethod` وحده — وهو ما يسمح به الحارس. لذلك الإصلاح **في طبقة البذر وحدها**: وُلِّد طلب كاش-فقط من مسار الشراء الحقيقي (`publish` بـ`paymentMethods:["CASH_DIRECT"]` ← `routes/marketplace.ts:834` ينسخها إلى `data.items`)، مع التدرّج الصحيح `اشتريه` (ADD_TO_CART) ثم `اطلبه` (CONTINUE ⇒ PLACE_ORDER، `buyer-turn.ts:1296`) ثم `نعم` ⇒ `placedOrderTurn` ⇒ كتلة `surface:"ORDER"` التي وحدها يقرأها `orderInContext` (`:929-942`) عند `ادفع`. التأكيدات الأحد عشر لم تُضعَف ولم تُحذف؛ حُذف ادّعاءان كاذبان على الطلب المفاوض عليه واستُبدلا بمسار حقيقي، ثم اختيرت البطاقة على المعلّق المفتوح مباشرة بدلًا من إعادة فتح المراجعة.

الالتزام: `ff06650` — **الإثبات معلّق** على `41877578228` (الحزمة منفردة PG16) و`41877681772` (السلسلة كاملة PG16). لا يُدرج هذا البند كـ«مُصلَح» قبل ظهور `✔ G2-36B` و`LOCAL_SUITE_CHAIN … first_failed=none`.

---

## 4. ما لم يتغيّر في المنتج أثناء هذاالتدقيق

لا ملف `src/` ولا `lib/db/drizzle/` عُدِّل في هذا الفرع: كل التزاماتي كانت في طبقة الاختبار والقياس والوثائق (`86fa92a`، `a297557`، `8ebb6ed`+`7f14f3f`، `e91e665`+`9a57d62`، `31f52c7`، `ff06650`). لم يُعاد ترقيم أي ترحيل، ولم يُضعَف أي assertion، ولم يُلمس `ai-authority-boundary.test.ts`.
