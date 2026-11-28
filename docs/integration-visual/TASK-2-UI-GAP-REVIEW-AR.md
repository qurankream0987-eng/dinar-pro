# المهمة الثانية: مراجعة فجوات UI-01 إلى UI-15 (فرع `claude/integration-visual`)

**التاريخ:** 2026-11-28.

**الأساس:**
- `e495691` = الإغلاق `030c267` + دمج `google/jassim-apple-performance-remediated`.
- لا دمج إلى `main`، ولا نشر، ولا تشغيل اختبارات (المهمة الثالثة).

## 1. طريقة المراجعة

لكل فرع من `google/ui-01` إلى `google/ui-15`:
- استخرجت كل سطر أضافه الفرع (مقابل نقطة تفرعه) وبحثت عنه في الفرع الحالي.
- كل ملف فيه أسطر غائبة رُوجع يدويًا: هل الميزة **مفقودة** أم **أُعيدت كتابتها** بصيغة أحدث؟ تحققت من وجود العناصر الوظيفية نفسها (المعرّفات، والنصوص، والسلوك)، لا من تطابق الأسطر حرفيًا.

**النتيجة:** 11 ملفًا فيها أسطر غائبة. تسعة منها أُعيدت كتابتها بصيغة أحدث أو أوسع، وملفان فيهما **فقدان حقيقي**.

| الفرع | الملف | الحكم | الدليل |
|---|---|---|---|
| UI-09 | `features/WhopPayment.tsx` | **مفقود** | حالة `PRE_LEGAL` ونص «الدفع الإلكتروني غير متاح في دولتك حاليًا» غير موجودين |
| UI-05 | `pages/AiChat.css` | **مفقود جزئيًا** | تنسيق دورة حياة البطاقة (اقتراح أو إيصال) ودخول `.ds-card` غير موجودين؛ مقاسات البطاقات موجودة بقيم أحدث |
| UI-04 | `InteractiveCircuitBg.tsx` | أُعيدت كتابته | متابعة المؤشر موجودة عبر `translate3d` بدل `--mx/--my` (تحسين أداء مقصود)، واحترام تقليل الحركة موجود |
| UI-04 | `AiChat.css` (الإضاءة) | أُعيدت كتابته | `.jassim-circuit-spotlight` موجود بآلية `transform` |
| UI-04 | `WelcomeSponsored.tsx` | أُعيدت كتابته | أيقونة السلة موجودة (`size 13`) مع إضافات (`Crown`) |
| UI-06 | `SmartStoreCardView.tsx` | أُعيدت كتابته (من 255 إلى 585 سطرًا) | معرض الصور، والمصغرات، والأسهم 44px، والأسعار: كلها موجودة |
| UI-10 | `pages/Connect.tsx` | أُعيدت كتابته | مؤشر الخطوات موجود (`connect-onboarding-stepper`) مع معالج جديد |
| UI-15 | `UniversalCardEngine.tsx` | أُعيدت كتابته | كل المعرّفات موجودة: `universal-card-total`، و`layer-toggle-`، و`finish-`، وأزرار الكمية، و`pendingRequote`، و`PRIMARY_CTA` |
| UI-15 | `LayeredStage.tsx` | أُعيدت كتابته (من 164 إلى 551 سطرًا) | الأوضاع `LAYERED_STACK` و`MANNEQUIN` و`PRODUCT_STUDIO`، و`useReducedMotion`، و`infinite-card-stage` |
| UI-05 وUI-15 | `pages/dev/SmartStorePreview.tsx` | أُعيدت كتابته | صفحة تطوير فقط، وبطاقة الدفع بحالاتها الست ومحرك البطاقات موجودة |
| UI-01 إلى UI-15 | `docs/ui-progress.md` | توثيق | سجل تقدم لا يؤثر على التطبيق؛ لم يُعدَّل |

الفروع UI-02 وUI-07 وUI-08 وUI-11 وUI-12 وUI-13 وUI-14: ملفاتها موجودة بالكامل، ولا أسطر غائبة.

## 2. الإصلاحات

### 2.1 PRE_LEGAL: الدفع الإلكتروني في الأسواق غير المعتمدة
- **الواجهة** (`artifacts/dinar/src/features/WhopPayment.tsx`):
  - استُعيدت حالة UI-09: في سوق `operationMode = PRE_LEGAL` تظهر للبائع والمشتري بطاقة «الدفع الإلكتروني غير متاح في دولتك حاليًا» مع توضيح الدفع النقدي أو المباشر، ولا يظهر زر الدفع بالبطاقة.
  - التعديل الوحيد عن UI-09: لا تظهر البطاقة لطرف ثالث (`stranger`).
- **الخادم** (`artifacts/api-server/src/lib/whop/checkout.ts`): **فجوة وُجدت أثناء التحقق، وهي ليست من نسخ الفروع.**
  - `createWhopCheckout` (الدفع بالبطاقة لطلبات السوق) لم يكن يتحقق من الاعتماد القانوني للسوق؛ كان يتحقق من الدول المحظورة فقط.
  - أُضيف `assertMarketLegalCapability(order.marketId, "ELECTRONIC_PAYMENT")` قبل أي اتصال بالمزود.
  - `ELECTRONIC_PAYMENT` قدرة لا تعمل قبل الاعتماد القانوني أبدًا (`LEGAL_ONLY_CAPABILITIES`)، حتى في التشغيل التقني.
  - الرفض: 409 `MARKET_ELECTRONIC_PAYMENT_UNAVAILABLE` بالرسالة نفسها.
  - **مدفوعات الإعلانات** كانت تتحقق من ذلك مسبقًا (`promotion-payments.ts`)، ولم تتغير.
  - **الدفع النقدي والمباشر** لا يتأثر.

### 2.2 دورة حياة البطاقة وظهورها (UI-05، مستعادة ومصححة)
- `artifacts/dinar/src/pages/AiChat.css`:
  - دخول `.ds-card` مرة واحدة بحركة النظام الحالية (`dinar-card-enter`)، وتُلغى عند `prefers-reduced-motion`.
  - البطاقة بانتظار المراجعة (`PENDING_REVIEW`) بحد متقطع ذهبي، والمؤكدة (`CONFIRMED`) بحد كامل وظل خفيف.
- **تصحيح:** UI-05 كان يستهدف القيمتين `PROPOSAL` و`RECEIPT`، والخادم لا يرسلهما أبدًا. القيم الحقيقية هي `SURFACE_STATES` في `lib/api-zod/src/surface-composition.ts`، لذلك كان التنسيق الأصلي بلا أثر حتى في فرعه، فرُبط بالحالتين الحقيقيتين.

### 2.3 إزالة BOM من 8 ملفات

| الملف | الترميز | محتوى ما بعد BOM | الحروف العربية | محارف تالفة |
|---|---|---|---|---|
| `pages/Account.tsx` | UTF-8 | مطابق بايتيًا | 3435 | 0 |
| `pages/Checkout.tsx` | UTF-8 | مطابق | 755 | 0 |
| `pages/Connect.tsx` | UTF-8 | مطابق | 3061 | 0 |
| `pages/OfferDetails.tsx` | UTF-8 | مطابق | 1158 | 0 |
| `pages/OrderDetails.tsx` | UTF-8 | مطابق | 1931 | 0 |
| `pages/PremiumMaterials.css` | UTF-8 | مطابق | 30 | 0 |
| `pages/Search.tsx` | UTF-8 | مطابق | 326 | 0 |
| `pages/admin/AdminPromotions.tsx` | UTF-8 | مطابق | 816 | 0 |

- لم يكن في أي منها BOM قبل الدمج (في فرع الإغلاق)، ولا يوجد فيها CRLF.
- أُزيلت البايتات الثلاثة الأولى فقط، والمحتوى بعدها مطابق تمامًا لما قبل الإزالة.

## 3. ما بقي سليمًا ولم يُمس
- **الترحيلات 0080–0084** بالبصمات نفسها: `349adcec` و`6ef247e1` و`ea1f353b` و`55128b78` و`7cbe0edd`.
- **ملفات Jassim Ads** مطابقة لفرع الإغلاق: `promotion-campaigns.ts` و`welcome-ads.ts` و`DisplaySponsored.tsx` و`CampaignBuilder.tsx`.
- **لم يحدث:**
  - إعادة بناء أي محرك، أو إدخال نسخة مكررة.
  - أي تغيير في الدفع أو المحفظة أو الخدمات المدفوعة.
  - تفعيل أي Flag.
- typecheck بلا أخطاء، والبناءان (الخادم والواجهة) ناجحان. **الاختبارات لم تُشغَّل بعد** (المهمة الثالثة).

## 4. ما تعذّر أو لم يُعالج، ولماذا
- **اشتراكات JassimAI عبر Whop** (`subscription-checkout.ts`) لا تتحقق من `ELECTRONIC_PAYMENT`؛ تكتفي بالدول المحظورة. **لم أغيّرها:**
  - هي خارج نطاق UI-09 (دفع الطلبات).
  - تغيير شروط تحصيل الاشتراكات قرار تجاري، وهي مرحلة الاشتراكات القادمة.
  - مسجّلة للمراجعة في تلك المرحلة.
- **`docs/ui-progress.md`** في الفروع يختلف عن الحالي؛ هو سجل تقدم للوكيل لا يؤثر على التطبيق، فلم أدمجه.
- **الفروع خارج UI-01 إلى UI-15** (`ai-*` و`connect-*` و`intelligent-commerce` و`go-sell` و`universal-os` و`agent/commerce-build`) خارج نطاق هذه المهمة.

## 5. الملفات المتغيرة في هذه المهمة
1. `artifacts/api-server/src/lib/whop/checkout.ts`: حماية `ELECTRONIC_PAYMENT` في الخادم.
2. `artifacts/dinar/src/features/WhopPayment.tsx`: استعادة حالة PRE_LEGAL.
3. `artifacts/dinar/src/pages/AiChat.css`: دورة حياة البطاقة ودخولها.
4. ثمانية ملفات بلا BOM: `pages/Account.tsx`، و`Checkout.tsx`، و`Connect.tsx`، و`OfferDetails.tsx`، و`OrderDetails.tsx`، و`PremiumMaterials.css`، و`Search.tsx`، و`admin/AdminPromotions.tsx`.
5. هذا التقرير.
