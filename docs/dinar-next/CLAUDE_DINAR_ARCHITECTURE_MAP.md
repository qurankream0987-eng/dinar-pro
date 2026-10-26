# DINAR — خريطة المعمارية (Claude 00)

**المصدر:** `qurankream0987-eng/dinar-pro` عند `b1b20e513ed25952bc086778fb71af88adcc54ba` (commit واحد نظيف).
**الطريقة:** قراءة مباشرة للمصدر. كل مسار مذكور موجود فعلاً، ولا يُنقل أي ادعاء من التقارير السابقة دون تحقق.

## الحجم

| الحزمة | ملفات TS/JS/SQL | أسطر |
|---|---:|---:|
| `artifacts/api-server` (API + الاختبارات) | 245 | ~99,400 |
| `artifacts/dinar` (الواجهة) | 186 | ~40,800 |
| `artifacts/mockup-sandbox` | 67 | ~7,200 |
| `lib/api-zod` (مولَّد) | 309 | ~13,300 |
| `lib/api-client-react` (مولَّد) | 4 | ~12,900 |
| `lib/db` | 60 | ~4,100 (+40 migration) |

## الطبقات

```
المتصفح (React/Vite, RTL)  ──HTTP/SSE──▶  Express 5  (artifacts/api-server/src/app.ts)
                                            │  ① CSRF/Origin  ② json 128KB  ③ حدّ عناصر المصفوفات (جديد)
                                            │  ④ /api/healthz,/api/readyz  ⑤ sessionMiddleware → routes/*
                                            ▼
                     routes/  ──▶  lib/ (خدمات المجال)  ──▶  Drizzle  ──▶  PostgreSQL (80 جدولاً)
                       │
                       └── routes/ai.ts ──▶ ai/conversation-runtime ──▶ ai/model-gateway (7 مزودين)
                                                   │
                                                   └── ai/tool-registry (أدوات قراءة + addToCart فقط)
```

## مصادر الحقيقة

| المجال | المصدر | ملاحظات |
|---|---|---|
| مخطط قاعدة البيانات | `lib/db/src/schema/index.ts`, `r5-delivery.ts` | 80 جدولاً؛ `drizzle-kit push` ممنوع عمداً |
| الترحيلات | `lib/db/drizzle/0000…0039` | 40؛ طُبقت كلها على PG16 نظيفة في هذه الجولة |
| عقود API | `lib/api-spec/openapi.yaml` → `lib/api-zod`, `lib/api-client-react` | مولَّدة؛ لا تُعدّل يدوياً |
| حل رابط قاعدة البيانات | `lib/db/src/database-url-resolver.mjs` | في التطوير يُفضَّل `DINAR_DEV_DATABASE_URL` |
| حارس قواعد الاختبار | `artifacts/api-server/test/acceptance-database-guard.mjs`, `safe-development-database.ts` | loopback + اسم `dinar_(test|acceptance|…)_*` |
| نموذج التهديد | `threat_model.md` | بند "حد المحاولات لكل عملية" قديم: الحد الآن في قاعدة البيانات |

## المسارات (عدد نقاط النهاية)

`commercial` 25 · `trust-safety` 23 · `marketplace` 20 · `ai` 18 · `provider` 14 · `privacy` 11 · `promotions` 10 · `admin-markets` 6 · `appeals` 6 · `integrations` 6 · `categories` 5 · `courier` 5 · `payments` 4 · `profile-avatar` 3 · بقية الإدارة 4 · `health` 2. والمصادقة في `lib/auth.ts`.

## التدفقات التجارية الأساسية

### بائع ← مسودة ← نشر ← اكتشاف
- `POST /api/listings` (`routes/marketplace.ts`) ← `lib/listing-management.ts`, `lib/publication-policy.ts`, ومراجعة الصور `lib/listing-image-publication-review.ts`.
- البحث: `GET /api/listings` ← `lib/marketplace-listings.ts#searchMarketplaceListings` (السوق النشط فقط).
- عبر المحادثة: `ai/listing-draft.ts` و`ai/draft-actions.ts` (مسودة بتأكيد صريح)، و`ai/seller-management.ts`.

### مشترٍ ← بحث ← عرض ← عرض مضاد ← اتفاق ← طلب
- التفاوض: `lib/negotiations.ts` (`openNegotiation` و`decideNegotiation` مع `expectedVersion` لرفض القرارات القديمة).
- الطلب: `POST /api/orders` و`/api/checkout` ← `lib/commerce.ts#planCheckout`. السعر من الاتفاق أو العرض المخزّن، والعمولة snapshot (حالياً 10%)، وحجز المخزون 30 دقيقة.
- التنافس على آخر قطعة: قفل الصف + `reservedQuantity`.

### طلب ← دفع محاكى ← عمولة ← تسليم ← نزاع
- `routes/payments.ts` يعمل فقط عند `NODE_ENV=development` + `BDINAR_WAVE4_ACCEPTANCE=development`، وبدونهما يعيد 404.
- `lib/payments/service.ts`: intent واحد لكل طلب، idempotency لكل مشترٍ، وwebhook موقّع بـHMAC، وإزالة تكرار بـ`providerEventId` وبصمة SHA-256.
- الدفع يُلتقط والطلب **ما زال `CREATED`**، أي قبل قبول البائع.
- الحالات الطرفية: `lib/order-terminal-accounting.ts` (تحرير الحجز، و`sellerDues` من snapshot العمولة عند الاكتمال).
- النزاعات: `routes/marketplace.ts` (confirm → DISPUTED)، و`lib/payments/disputes.ts`، و`routes/admin-disputes.ts`.
- التسليم: `lib/delivery.ts` (`orderHandoff`, `settleOrderFulfillment`) ومنظومة المندوبين `lib/courier-*`, `lib/driver.ts`.

### رسالة ← سياق ← اقتراح أداة ← تفويض ← تنفيذ موثوق ← إيصال
- `routes/ai.ts` (SSE عند السطر ~1987) ← `ai/conversation-router.ts` ← أدوار حتمية (`buyer-turn`, `negotiation-turn`, `commerce-turn`, `smart-turn`…) قبل النموذج.
- النموذج: `ai/model-gateway.ts`، والمزودون GROQ (الافتراضي) وOPENROUTER وOPENAI وREPLIT_OPENAI وOPENAI_COMPATIBLE وGEMINI وDEEPSEEK.
- أدوات النموذج (`ai/tool-registry.ts`): `openSurface` و`searchListings` و`getResource` و`recommendListings` و`restoreResults` للقراءة فقط، و`addToCart` مقيدة بنتائج المحادثة الحالية وبمستخدم مسجل.
- **لا أداة للنموذج تنشئ طلباً أو دفعاً أو موافقة.** الإجراءات المؤثرة تمر عبر `ai/action-foundation.ts` و`ai/action-receipts.ts` بتأكيد وإيصال من الخادم.
- المتابعات العربية حتمية: `ai/arabic-normalization.ts:302` («وفوق»)، و`ai/intent.ts:70` («رجعني للنتائج»)، و`ai/buyer-turn.ts` (الترتيب «الأرخص»).

## حدود الأمان

- المصادقة: كلمات مرور scrypt، وجلسات مخزنة كـdigest، وكوكي HttpOnly/SameSite=Lax.
- الحد من المحاولات: `lib/auth-rate-limiter.ts` في جدول `auth_rate_limit_buckets` بمفاتيح HMAC، فيعمل عبر النسخ المتعددة.
- CSRF: فحص Origin و`sec-fetch-site` وإلزام JSON لكل طلب غير GET (`app.ts`).
- `trust proxy = 1`: صحيح خلف وكيل واحد؛ يجب التحقق منه على Railway.

## اعتماديات Replit (قابلية النقل)

| الاعتمادية | الموقع | الأثر خارج Replit |
|---|---|---|
| `@replit/connectors-sdk` | `package.json` الجذر | لا يستورده أي ملف مصدر؛ اعتمادية زائدة يمكن إزالتها |
| `REPLIT_OPENAI` (وكيل AI Integrations) | `.replit`، `ai/model-gateway.ts` | مزود التطوير؛ يُستبدل بمزود مباشر |
| Replit Object Storage (`@google-cloud/storage`) | `lib/objectStorage.ts` | يوجد بديل S3 (`lib/s3ObjectStorage.ts`) ويحتاج bucket |
| `REPLIT_DEV_DOMAIN`, `REPLIT_DOMAINS` | `app.ts` (المصادر المسموحة) | يُستبدل بـ`APP_ORIGIN` |
| `REPL_ID`, `REPLIT_DEPLOYMENT` | حراس الاختبار والدفع | آمنة؛ تعمل بديلاً عنها `BDINAR_DISPOSABLE_*` |
| تجاوز esbuild/rollup لمنصات غير linux-x64 | `pnpm-workspace.yaml` | البناء على macOS/ARM يفشل؛ مناسب لـRailway (linux-x64) |
