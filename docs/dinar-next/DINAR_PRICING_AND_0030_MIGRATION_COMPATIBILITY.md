# DINAR — التسعير وتوافق الترحيل 0030

**التاريخ:** 2026-10-24
**الحالة:** تم تصحيح `0030_swift_living_mummy.sql` في المستودع بعد تحليل سلامة الترحيلات. **لم يُنفّذ أي ترحيل على أي قاعدة دائمة.**

## 1. المشكلة في 0030 الأصلي

```sql
UPDATE offers SET pricing_mode = CASE
  WHEN pricing_mode = 'STARTING_FROM' THEN 'FIXED'            -- يفقد معنى «يبدأ من»
  WHEN pricing_mode = 'QUOTE_REQUIRED' THEN 'OPEN_TO_OFFERS'  -- يفقد معنى «حسب التسعيرة»
  WHEN pricing_mode = 'FIXED' AND data->>'negotiable' = 'true' THEN 'NEGOTIABLE'
  ELSE pricing_mode END;
UPDATE offers SET data = jsonb_set(data, '{pricingMode}', to_jsonb(pricing_mode), true);  -- يكتب فوق الأصل
```

| ما يُفقد | الأثر |
| --- | --- |
| معنى `STARTING_FROM` | يصبح مبلغ البداية **سعر شراء مباشر ملزمًا** (`FIXED`) — يخالف القاعدة 3 للمالك |
| معنى `QUOTE_REQUIRED` | يصبح «يستقبل العروض» عامًا؛ يضيع أن البائع يرسل تسعيرة |
| الأصل في `data.pricingMode` | يُكتب فوقه بالقيمة الجديدة؛ **لا يمكن لأي ترحيل لاحق استعادة الأصل** |
| علامة التفاوض | لم تعد تحدد إمكانية التفاوض (التفاوض شامل الآن)؛ تبقى `data.negotiable` كما هي، فلا فقد فعلي |
| الفئات | `defaultMode = STARTING_FROM` ← `FIXED` |

## 2. تحليل سلامة الترحيلات (لماذا تصحيح على مستوى المستودع)

| البيئة | حالة 0030 | الدليل |
| --- | --- | --- |
| Railway development (Preview) | **غير مطبّق** — الدفتر 28/40، آخره `0027` | فحص قراءة فقط 2026-10-24 (`preview-migration-check.mjs --phase=pre`) |
| Replit managed `DATABASE_URL` (heliumdb) | **غير مطبّق** — الدفتر 9 إدخالات، المخطط قديم (لا عمود `pricing_mode`) | فحص قراءة فقط 2026-10-24 داخل `BEGIN READ ONLY` |
| Production | **غير موجودة** — لا نشر ولا قاعدة إنتاج | `docs/DINAR-R3-ENVIRONMENT-READINESS.md` |
| قواعد Replit المؤقتة | طُبّق | قواعد loopback مؤقتة ومحذوفة؛ ليست بيئات |

- البديل الإضافي (ترحيل `0040` لاحق) **لا يستطيع** الإصلاح: 0030 الأصلي يمحو المعلومة قبل أن يعمل أي ترحيل لاحق، وكل الترحيلات المعلقة تعمل في معاملة واحدة بالترتيب.
- لا يتحقق `drizzle-orm` من hash الترحيلات المطبّقة (يقارن `created_at` فقط)، ولا `/api/readyz` (يقارن الطوابع الزمنية فقط). تغيير محتوى 0030 لا يكسر أي قاعدة. الطابع `when` في الدفتر **لم يتغير**.
- الجهة الوحيدة التي تثبّت hash 0030 هي حارس `migrate:clone`؛ حُدّث التثبيت إلى `581225f6…09d8` مع تعليق مراجعة، واختبار `development-tls.test` يتحقق منه مقابل الملف على القرص.
- **شرط باقٍ:** إن ظهرت لاحقًا أي قاعدة دائمة طبّقت 0030 الأصلي (hash `1dfa53c0…0d3e`) فلن يعيد drizzle تطبيقه؛ يجب حينها فحص صفوفها يدويًا قبل الاعتماد. الفحص المسبق يكشف ذلك لأن hash الدفتر لن يطابق الملف.

## 3. 0030 المصحّح

```sql
UPDATE offers SET
  pricing_mode = CASE
    WHEN pricing_mode IN ('STARTING_FROM', 'QUOTE_REQUIRED') THEN 'OPEN_TO_OFFERS'
    WHEN pricing_mode = 'FIXED' AND data->>'negotiable' = 'true' THEN 'NEGOTIABLE'
    ELSE pricing_mode END,
  data = CASE WHEN pricing_mode IN ('STARTING_FROM', 'QUOTE_REQUIRED')
    THEN jsonb_set(data, '{priceRepresentation}', to_jsonb(pricing_mode), true) ELSE data END;
-- defaultMode: STARTING_FROM / QUOTE_REQUIRED → OPEN_TO_OFFERS
```

- القيد `offers_pricing_valid` **نفسه بلا تغيير** (`FIXED`/`NEGOTIABLE` مسعّران؛ `OPEN_TO_OFFERS` سعر اختياري). مبلغ البداية يبقى في `unit_price_minor`، والتسعيرة تبقى بلا سعر — كلاهما صالح تحت القيد.
- لا جدول ولا عمود جديد. لا يمس `orders`/`order_items`/`seller_dues`/`payment_*`.
- `marketplace-categories.ts` (المحوّل في الذاكرة للصفوف قبل 0030) يطابق التصحيح: `STARTING_FROM` الافتراضي ← `OPEN_TO_OFFERS`.

## 4. التمثيل في وقت التشغيل (بلا اعتماد على مخطط جديد)

`priceRepresentationOf()` (`lib/api-zod/src/listing-pricing.ts`) يقرأ:

| الصف المخزّن | التمثيل |
| --- | --- |
| `OPEN_TO_OFFERS` + `priceRepresentation=STARTING_FROM` + سعر | `STARTING_FROM` |
| `OPEN_TO_OFFERS` + `priceRepresentation=QUOTE_REQUIRED` + بلا سعر | `QUOTE_REQUIRED` |
| `STARTING_FROM` / `QUOTE_REQUIRED` خام (قبل 0030) | نفس المعنى |
| علامة غير متسقة مع السعر | يعود للوضع المخزّن |

لا يوجد كود تشغيل معطّل بانتظار مخطط: كل التغييرات تعمل على مخطط 0039 القائم وتحافظ على معنى صفوف ما قبل 0030.

## 5. أدلة التجربة (PostgreSQL 17.6 مؤقت، loopback)

قاعدة عند `0027` + البيانات الاصطناعية القديمة (`lib/db/scripts/rehearsal/legacy-fixtures.sql`) ← الأمر الرسمي `pnpm --filter @workspace/db run migrate` بـ 0030 المصحّح:

| العرض | قبل | بعد |
| --- | --- | --- |
| `rh-o-start` | `STARTING_FROM` 3.000 | `OPEN_TO_OFFERS` 3.000 + `STARTING_FROM` |
| `rh-o-start-neg` | `STARTING_FROM` 3.500 + negotiable | `OPEN_TO_OFFERS` 3.500 + `STARTING_FROM` |
| `rh-o-quote` | `QUOTE_REQUIRED` بلا سعر | `OPEN_TO_OFFERS` بلا سعر + `QUOTE_REQUIRED` |
| `rh-o-fixed-neg` / `-negstr` | `FIXED` + negotiable | `NEGOTIABLE` |
| `rh-o-fixed` / `rh-o-archived` | `FIXED` | `FIXED` |

`--phase=post`: **PASS** — 58 جدولًا محميًا متطابقة البصمة (الطلبات، البنود، المستحقات، المدفوعات، المفاوضات، المحادثات…)، التحويل = المتوقع، `data.pricingMode` متسق، 0 قيود غير مُتحقَّقة. الفئات: `services`/`digital-services`/`other` ← `OPEN_TO_OFFERS`، والباقي `FIXED`.

## 6. أثر على Preview

بيانات Preview الحالية: عرض واحد `FIXED` بلا علامة تفاوض، وفئتان تسمحان بـ `STARTING_FROM`/`QUOTE_REQUIRED` بقيمة افتراضية `FIXED`. **0030 المصحّح والأصلي يعطيان نتيجة متطابقة على Preview** (لا صف `STARTING_FROM`/`QUOTE_REQUIRED`). لكن hash الملف تغيّر، لذا يجب إعادة الفحص المسبق عند الـ commit المعتمد قبل أي ترحيل (انظر `DINAR_PREVIEW_DATABASE_MIGRATION_APPROVAL.md`).
