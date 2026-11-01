# CLAUDE 13 — تدقيق الترحيلات وعقود API

**النطاق:** الفرع `claude/13-integration-preflight`، والسلسلة `0000`–`0047` مع تركيز على `0041`–`0047`.

**قيود التنفيذ:**
- لم يُشغَّل أي ترحيل على قاعدة إنتاج أو قاعدة دائمة؛ كل التشغيل على قواعد loopback مؤقتة.
- لم يُستخدم `drizzle-kit push` إطلاقًا.

## 1. سلامة السلسلة

**الفحص:** آلي، على ملفات الفرع نفسه.

| الفحص | النتيجة |
|---|---|
| عدد مدخلات السجل | 48 (`idx` من 0 إلى 47 متتالية) |
| تفرّد الوسوم | نعم |
| تصاعد `when` تصاعدًا صارمًا | نعم. لولاه لتخطى migrator drizzle المدخلات الأقدم بصمت |
| sha256 كل ملف = `release-manifest.json` | نعم، لكل الـ48 |
| `REVIEWED_PENDING_MIGRATIONS` في `clone-migration-guard.ts` | يحمل هاش 0028–0047. خط الأساس القانوني 0000–0027 |
| لقطة drizzle للرأس | `0047_snapshot.json`. `drizzle-kit generate` يقول «No schema changes» |
| `development-tls` | يتحقق من عدد المدخلات ووسم الرأس `0047` |
| `readiness` | يتحقق من عدد المدخلات ووسم الرأس `0047` |

| idx | الوسم | `when` | sha256 (12) | المصدر |
|---|---|---|---|---|
| 40 | `0040_refund_obligations` | 1793051943188 | `211c7db10403` | Claude (قبل التكامل) |
| 41 | `0041_wave07_financial_journal` | 1793260000000 | `4403b20eefd3` | Qoder W07، الهوية الأصلية |
| 42 | `0042_wave08_cash_engines` | 1793340000000 | `44e4a812ae36` | Qoder W08 |
| 43 | `0043_wave09_policy_consent_compliance` | 1793420000000 | `29127432970d` | Qoder W09 |
| 44 | `0044_wave10_trust_support_whatsapp` | 1793500000000 | `edb8ca570221` | Qoder W10 |
| 45 | `0045_c1_sql_search` | 1793510000000 | `945ccc562239` | Claude C1. SQL مطابق بايتًا لـ`0041_c1_sql_search` الأصلي |
| 46 | `0046_d1_d2_business_foundation` | 1793520000000 | `5d2c6fc28d2f` | Claude D1/D2. مطابق بايتًا لـ`0042_…` الأصلي |
| 47 | `0047_business_listing_association` | 1793530000000 | `f524e2c36c13` | Claude 13 |

## 2. التثبيت والترقية

### 2.1 البروفة على PostgreSQL 16.15

**الحالة:** على قواعد `dinar_migration_*` مؤقتة.

| حالة البداية | `drizzle-kit migrate` | سلطة الإصدار (`pendingMigrations`) |
|---|---|---|
| قاعدة جديدة | 48 مدخلًا | لا شيء معلّق |
| مطبّقة بسلسلة Qoder حتى `0044` | 48 | `0045` و`0046` معلّقان، ثم `0047` |
| خط أساس `0040` | 48 | لا شيء |
| بالهوية القديمة لـC1/D1D2 (`0041`/`0042`) | يتوقف بصمت | **`LEDGER_DIVERGENT`**، وفحص الجاهزية `inconsistent` |
| تشغيل ثانٍ | بلا تغيير | — |

**مقارنة المخطط:** `pg_dump --schema-only` للحالات الصالحة متطابق، والفرق رموز `\restrict` العشوائية فقط.

**قاعدة ملزمة:** أي قاعدة طُبّقت عليها الهوية القديمة لـC1/D1D2 تُعاد إنشاؤها؛ لا تُرقّع. كل القواعد المعروفة بهذه الحالة مؤقتة.

### 2.2 PostgreSQL 18

**محليًا:** غير متاح في الحاوية، و`test:release-migration` يشترط `serverVersionNum >= 180000`.

**في CI:** (التشغيل `41275493692` على `7cd334d`: success على PG16 وPG18، و`test:release-migration` على PG18 success.) أُضيف `.github/workflows/claude-integration.yml`، بمصفوفة PG16 وPG18، ومُشغّل `push` محصور بهذا الفرع. يشغّل:
- typecheck والبناءين و`test:surfaces`؛
- `test:release-migration` على PG18؛
- readiness وdevelopment-tls ومجموعات التكامل وW07–W12.1 وC1 وD1/D2 والبطاقات والسلة والمحادثة.

النتيجة في `CLAUDE_13_COMBINED_ACCEPTANCE_MATRIX.md` §3.

### 2.3 حماية البيانات التاريخية

**الفحص:** آلي على `0041`–`0047`.
- لا `DROP TABLE` ولا `DROP COLUMN` ولا `TRUNCATE` ولا `DELETE`.
- **`0041`:** يستبدل قيد `markets_price_valid` بآخر يقبل `minor_unit_scale` من 0 إلى 4، فيوسّع ولا يضيّق.
- **`0044`:** يوسّع `marketplace_reports_target_type_valid`، ويحدّث خمسة صفوف مرجعية في `moderation_reason_codes`. بيانات مرجعية، لا بيانات مستخدم.
- **`0045`:** `UPDATE` موجودة داخل جسمي دالتي المشغّلات فقط.

**الجداول المالية والأدلة الجديدة محمية بمشغّلات append-only**، على الصف وعلى `TRUNCATE`:

| الترحيل | الجداول |
|---|---|
| `0041` | `order_financial_events`، `commission_policies` |
| `0042` | `cash_payment_claims`، `cash_refund_cases` |
| `0043` | `policy_registry_versions`، `policy_consent_events`، `legal_entities`، `market_compliance_settings`، `seller_verification_profiles`، `minor_protection_declarations` |
| `0044` | `fraud_signals`، `fraud_signal_reviews`، `support_cases`/`messages`/`events`، `whatsapp_consent_events`/`templates`/`intents` |
| `0046` | `business_verification_events` |

**القيود المحفوظة:** `payment_refund_obligations` (`0040`) ولقطات السعر والعمولة في الطلبات لم تُمس.

**أثر على الاختبارات:** أدلة الموافقة append-only تمنع حذف الحسابات في تنظيف الاختبارات. الحل `test/disposable-user-cleanup.ts`، الذي يُبقي الحساب الحامل للأدلة، لا تعطيل المشغّل.

### 2.4 متطلبات قبل أي تطبيق دائم (لم يُنفّذ شيء منها)

1. **اعتماد المالك لتسلسل واحد:** هذا الفرع، أو تسلسل `qoder/17` (`CLAUDE_13_CONTRIBUTION_PRESERVATION.md` §4). SQL الطرفين مطابق.
2. **نسخة احتياطية** كاملة (`pg_dump -Fc`) واختبار استعادتها على قاعدة مؤقتة.
3. **تشغيل `runReleaseMigration`** بالهدف الصحيح (`DINAR_MIGRATION_TARGET` و`DINAR_MIGRATION_EXPECTED_DATABASE`). يرفض المضيفين المحظورين والسجل المتباعد.
4. **فحص `readiness`** بعد الترحيل، مع `assessMigrationLedger` = `consistent`.
5. **الرجوع:** كل ترحيلات `0041`–`0047` إضافية، والرجوع بالاستعادة من النسخة. لا ترحيلات عكسية مكتوبة.
   - **حدود الحذف المباشر:** الجداول append-only لا تُحذف بلا تعطيل مشغّلاتها، وهذا قرار مالك.
   - **`0047` وحده:** يُعكس بـ`DROP TRIGGER` و`DROP COLUMN offers.business_profile_id` إن لم يُستخدم.

## 3. تعارضات السلسلة مع الفروع غير المدمجة

| الفرع | ترحيله | التعارض | الحل المقترح |
|---|---|---|---|
| `qoder/15` D3-A | `0042_d3a_native_business` (3 جداول) | الرقم `0042` مستخدم. `business_listing_links` يكرر `0047` تصميمًا | يُعاد ترقيمه إلى `0048` بالSQL نفسه. يُحسم الربط قبل الدمج (§3.4 في وثيقة الحفظ) |
| `qoder/17` | `0041`–`0046` بترقيم معاكس | تسمية فقط | قرار المالك (§2.4-1) |
| `codex/11` | `0041_search_foundation`، `0045_c1_numeric_compat` | تنفيذ C1 آخر | لا يُدمج. C1 المدمج هو Claude C1 |

## 4. عقود API و OpenAPI

### 4.1 التغطية

**المسح:** موجّهات Express المسجلة، 216 زوجًا (طريقة + مسار)، مقابل `lib/api-spec/openapi.yaml` (169 عملية).

| المجموعة | المسارات | في المواصفة | الحارس |
|---|---|---|---|
| W07–W10 الجديدة (`cash.ts`، `compliance.ts`، `trust-ops.ts`) | 50 | 50 | `integration-openapi-coverage` OA-01 يتحقق من الوصول المعلن (`PUBLIC` / `AUTHENTICATED` / `ADMIN`) |
| D1/D2 (`business-profiles.ts`، الخطط) | 20 | 20 | `d1-d2-business-foundation` D2-19 |
| ربط النشاط (`0047`) | 2 | 2 | OA-02 |
| مسارات قائمة قبل التكامل بلا عملية | 71 | 0 | لا حارس |

**المسارات الـ71 بلا عملية:** كلها سابقة للتكامل.

| المجموعة | العدد | أمثلة |
|---|---|---|
| `admin/*` | 29 | الأسواق، والمستخدمون، والبلاغات، والاستئنافات، والسياسات، وأسعار النماذج |
| `account/*` | 13 | الخصوصية، وقبول السياسات، والحذف، وربط السائق |
| `provider/*` و`provider-connections/*` | 12 | |
| أخرى | 17 | `appeals`، `reports`، `cart` (GET/PUT)، `policies`، `payments/intents`، `payments/webhooks/test`، `orders/{id}/dispute/evidence`، `storage/objects/*` |

**مسارات غيّر W09/W10 سلوكها:** موجودة في `trust-safety.ts`، وما زالت بلا مواصفة:
- `/reports` مع الأنواع الجديدة `MESSAGE` و`AI_ANSWER`؛
- `/policies`.

### 4.2 نوعية الأنواع

**تنبيه:** وجود عملية في المواصفة لا يعني أن العقد مكتوب بالأنواع.

| المقياس | العدد من 169 |
|---|---|
| طلبات بجسم مخطط حقيقي | 48 |
| طلبات بجسم عام (`ServerValidatedObject` أو كائن بلا خصائص) | 50، كلها W07–W10 |
| ردود 2xx بمخطط عام فقط (`CommercialJsonObject` / `ServerValidatedObject` / كائن فارغ) | 83 |
| ردود 2xx بلا مخطط | 3 |

**التبعات:**
- **التحقق:** يجري في الخادم بمخططات zod صارمة داخل كل مسار.
- **ما يولّده OpenAPI:** عملاء `api-zod` وReact لهذه المسارات يتحققون من الشكل العام فقط، لا من الحقول.
- **مصادر الحقيقة:** مخططات W07–W10 الحقيقية في `routes/cash.ts` و`routes/compliance.ts` و`routes/trust-ops.ts`، ولم تُنقل إلى المواصفة.

**العمل المتبقي:** مدرج في `DINAR_REMAINING_WORK_FOR_REPLIT.md` (D8-2).
1. نقل مخططات W07–W10 إلى `openapi.yaml`، ثم codegen.
2. اختبار يقارن مخطط zod في الموجّه بمخطط المواصفة.
3. مواصفة للمسارات الـ71.
4. مخططات ردود حقيقية للمسارات التجارية.

### 4.3 المصادقة في المواصفة

- **W07–W10 وD1/D2:** الوصول معلن في كل عملية، ومختبَر مقابل الموجّه.
  - العام بـ`security: []`.
  - المسؤول عبر مقطع «Access: ADMIN».
  - لا مخطط أمان منفصل للمسؤول، فـOpenAPI لا يميز cookie المسؤول عن cookie المستخدم.
- **المسارات الـ71:** لا شيء معلن.
