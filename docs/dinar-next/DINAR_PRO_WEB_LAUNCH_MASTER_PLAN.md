# DINAR Pro — خطة الإطلاق الرئيسية للموقع (تدقيق جاهزية مبني على الأدلة)

- **التاريخ:** 2026-10-25
- **المنفّذ:** Claude Code (مهندس إصدار)
- **المصدر المدقَّق:** `main` @ `a42ffd1da4040b196904e82f126c1835e90174e8`
- **النطاق:** قراءة المصدر، اختبارات واختبارات أنواع وبناء محلية، وقاعدة PostgreSQL 18 مؤقتة على loopback.
- **ما لم يُنفَّذ:** لا Railway، ولا GitHub push، ولا استدعاء AI مدفوع، ولا أموال حقيقية.

---

## الصفحة الأولى — القرار

| # | السؤال | الجواب |
|---|---|---|
| 1 | الحكم العام | **غير جاهز للإطلاق العام — BLOCKED.** الكود متقدّم ويعمل معزولاً، لكن **لا يستطيع أي مستخدم جديد إنشاء حساب خارج بيئة التطوير**، ولا يوجد مسار نشر/ترحيل لـ Staging، والنشر إلى GitHub محجوب بسرّ في التاريخ |
| 2 | الـ commit المدقَّق | `a42ffd1da4040b196904e82f126c1835e90174e8` (شجرة نظيفة؛ كل العمل المحلي committed) |
| 3 | هل اكتمل R3 الحي؟ | **نُفِّذ: 6/6 طلبات حقيقية** (2026-10-25 14:52–14:53 UTC، تكلفة تقديرية $0.007282). **النتيجة PARTIAL:** 3/6 PASS و3/6 FAIL لمخالفة عقد النموذج. الخادم رفض الردود المخالفة بأمان |
| 4 | عدد عوائق P0 | **7** |
| 5 | عدد عوائق P1 | **10** |
| 6 | السبب الرئيسي لتعذّر الإطلاق | التسجيل يتطلب التحقق من الهاتف خارج التطوير (`auth.ts:58-60`)، ولا يوجد مزود SMS (`phone-verification.ts:22-41`). أُثبت ذلك عملياً: `503 خدمة التحقق من الهاتف غير مهيأة` |
| 7 | هل تتجاوز قاعدة Railway جديدة عائق قاعدة التطوير؟ | **نعم تقنياً.** أُثبت أن الـ migrations الـ40 تبني قاعدة PG 18.6 فارغة بنجاح وبتطابق تام للـ hashes، وأن `/api/readyz` يعود `ready`. **لكن** لا يوجد اليوم runner معتمد لغير التطوير (P0-4)، ولا آلية لإنشاء أول مدير ولا سوق مفعّل (P0-7) |
| 8 | جاهزية DeepSeek للإنتاج | **NO.** Staging: **BLOCKED** (لا مستخدمين، لا مدير لإدخال سعر النموذج، لا مفتاح إنتاج، 3/6 مخالفات عقد) |
| 9 | جاهزية الدفع للإنتاج | **BLOCKED.** لا يوجد أي مزود دفع حقيقي. كل مسارات الدفع خلف بوابة محاكاة تطوير فقط (`routes/payments.ts:31-37,83`) |
| 10 | الإجراءات الثلاثة التالية بالترتيب | **(1)** المالك يُبطل GitHub PAT المكشوف في `.replit` (commit `f60e30d`) ويقرّر مسار التاريخ. **(2)** المالك يقرّر سياسة التحقق عند التسجيل (مزود SMS، أو بديل معتمد لـ Staging مغلق)، ثم يُنفّذ Claude Code المهمة T-G2-01. **(3)** Claude Code ينفّذ T-G1-01: runner ترحيل لـ Staging/Production مع حماية الهدف، وT-G2-02: خدمة web+API من نفس الأصل |

### عوائق P0 (تمنع أي Staging قابل للاستخدام)
| ID | العائق | الدليل |
|---|---|---|
| P0-1 | GitHub fine-grained PAT (93 حرفاً) موجود في تاريخ `main` القابل للوصول | `.replit` السطر 35 في `f60e30d` (2026-10-16)، أُزيل في `3c9e4b4`. لم تُطبع القيمة |
| P0-2 | استحالة إنشاء حساب خارج التطوير | `auth.ts:58-60` + `phone-verification.ts:34-41`. اختبار حي محلي بـ `NODE_ENV=production`: challenge → 503، register → 400 |
| P0-3 | لا يوجد نشر web+API من نفس الأصل | الواجهة تستدعي `/api` نسبياً (`Account.tsx:59`، `custom-fetch.ts`). الـ API يحمي الكتابة بفحص Origin (`app.ts:116-134`)، وكوكي الجلسة `SameSite=Lax` (`auth.ts:177-179`). الـ API لا يقدّم ملفات الواجهة، و`vite preview` غير مخصص للإنتاج |
| P0-4 | لا يوجد runner ترحيل لـ Staging/Production | `pnpm --filter @workspace/db run migrate` يرفض غير `NODE_ENV=development` ولا يقرأ إلا `DINAR_DEV_DATABASE_URL` (`database-url.ts:10-31`). `migrate-clone.mjs` يتطلب خط أساس 28 migration ولا يقبل قاعدة فارغة |
| P0-5 | التخزين الدائم للملفات غير مُعدّ لـ Railway | الافتراضي هو Replit sidecar `127.0.0.1:1106` (`objectStorage.ts:29`)، وهو غير موجود على Railway. البديل `OBJECT_STORAGE_PROVIDER=s3` مُنفَّذ (`s3ObjectStorage.ts`) لكنه يتطلب bucket واعتمادات |
| P0-6 | بوابة الأمن والقانون للبيانات الحقيقية | P0-1 مفتوح، ولا مراجعة قانونية أو خصوصية معتمدة (`DINAR_RETENTION_APPROVED` غير مفعّل؛ `DINAR_LAUNCH_GATES_AND_OWNER_ACTIONS.md` بوابات 1–3 BLOCKED) |
| P0-7 | قاعدة جديدة غير صالحة للاستخدام بلا مدير وسوق مفعّل | بعد الترحيل كل الأسواق الـ249 `is_active=false, COMING_SOON`، و`GET /listings` يعيد `[]` لسوق غير نشط (`routes/marketplace.ts`). تفعيل السوق ومدخل سعر AI يتطلبان ADMIN، والدور افتراضياً `USER` (`schema/index.ts:112`) ولا يوجد أي مسار كود يمنح ADMIN. يلزم أيضاً قرار المالك ببلد/سوق الإطلاق |

### عوائق P1 (تمنع Beta العامة أو المرحلة المعنية)
| ID | العائق |
|---|---|
| P1-1 | DeepSeek R3: 3/6 مخالفات عقد غير مُعاد التحقق منها حياً |
| P1-2 | dependencies: high ×2 (`zod`، `body-parser`) |
| P1-3 | لا سعر نموذج AI ولا مفتاح `DINAR_DEEPSEEK_API_KEY` منفصل للـ Staging |
| P1-4 | لا محوّل مراقبة أخطاء ولا قناة إشعارات مسجّلة |
| P1-5 | لا استعادة كلمة مرور |
| P1-6 | النسخ الاحتياطي والاستعادة غير مثبتين للقاعدة الجديدة |
| P1-7 | لا اعتماد قانوني/خصوصية/مدد احتفاظ |
| P1-8 | لا مزود دفع (للمرحلة C فقط) |
| P1-9 | قرارات تجارية معلّقة: `CASH_DIRECT` وتحصيل مستحقات البائع والنزاعات |
| P1-10 | لا قناة دعم/شكاوى تشغيلية بـ SLA (`DINAR_LAUNCH_GATES_AND_OWNER_ACTIONS.md` بوابة 9) |

---

## A. البنية الحالية

```
                 ┌────────────────────── Replit (التطوير الحالي) ──────────────────────┐
 Browser ──HTTPS─▶ Replit artifact router (توجيه بالمسار، نفس الأصل)                     │
                 │   /        → artifacts/dinar (Vite dev)                             │
                 │   /api/*   → artifacts/api-server (Express 5، dist/index.mjs)        │
                 │                  │                                                  │
                 │                  ├─▶ PostgreSQL (DINAR_DEV_DATABASE_URL → Railway dev، 28/40) │
                 │                  ├─▶ Object storage (Replit sidecar 127.0.0.1:1106)  │
                 │                  └─▶ AI gateway (Groq/OpenRouter/DeepSeek… بالإعداد)  │
                 └─────────────────────────────────────────────────────────────────────┘
```

- **monorepo:** pnpm 10.26.1، Node 24.22.1، `pnpm-workspace.yaml` (`artifacts/*`, `lib/*`, `lib/integrations/*`).
- **وظائف الخلفية:** لا يوجد worker. تعمل `setInterval` كل 60 ثانية داخل عملية الـ API (`index.ts:24-44`) وتنفّذ ثلاث مهام: تحرير الحجوزات المنتهية، وانتهاء العروض الترويجية، ومسح معاينات المواقع.
- **التخزين:** `ObjectStorageService` يختار بين `replit` و`s3` (`objectStorage.ts:283-296`). الرفع عبر signed upload URL بحد 5MB للصورة (`listing-photos.ts:10`، `profile-avatar.ts:23`).
- **الترحيل:** Drizzle SQL migrations (`lib/db/drizzle`، 40 ملفاً، journal مطابق). `drizzle-kit push` ممنوع بالكود (`deny-schema-push.mjs`، `drizzle.config.ts:9-13`).

## B. جرد Git والمصدر

| البند | القيمة |
|---|---|
| الجذر | `/home/runner/workspace` |
| الفرع / HEAD | `main` / `a42ffd1da4040b196904e82f126c1835e90174e8` |
| الحالة | نظيفة. الملفات غير المتتبَّعة هي فقط هذا التقرير و`DINAR_PRO_GITHUB_RAILWAY_HANDOFF.md` |
| عدد الـ commits | 513 على `main` و891 عبر كل الفروع |
| Remotes | `origin` = قيمة نموذجية `https://github.com/USERNAME/REPOSITORY.git` (غير صالحة)؛ `gitsafe-backup` (نسخ Replit الداخلي)؛ 7× `subrepl-*` |
| commits غير مدفوعة | كل `main` غير موجود على أي GitHub (لا remote صالح) |
| Merges معلّقة | لا |
| Tags | `dinar-next-baseline-20261019` |
| فروع أخرى | `claude/monetization-v3`، `codex/*` (3)، `google-development`، `integration/google-ai-studio-pro-waves`، `replit-agent`، `agent/pre-remediation-3a89636`، 7× `subrepl-*` |
| GitHub workflows | لا يوجد `.github/` |
| Submodules / LFS | لا |
| مخرجات بناء متتبَّعة | لا `dist/` ولا `build/`. لكن `.opencode/opencode.db*` (قاعدة جلسات وكيل) و`artifacts/api-server/.agent-g2.BnnvMG/` (~916KB) وملف باسم `-` في الجذر متتبَّعة |
| أصول | `attached_assets/` (250 ملفاً، حتى 2.8MB) يتضمن لقطات ونصوص أوامر ملصوقة وzip |

**الحزم الفعلية:**

| المسار | الاسم | الدور |
|---|---|---|
| `artifacts/api-server` | `@workspace/api-server` | Express API، يُبنى بـ esbuild إلى `dist/index.mjs` |
| `artifacts/dinar` | `@workspace/dinar` | واجهة React/Vite، تُبنى إلى `artifacts/dinar/dist/public` |
| `artifacts/mockup-sandbox` | `@workspace/mockup-sandbox` | أداة تطوير، **لا تُنشر** |
| `lib/db` | `@workspace/db` | Drizzle schema + migrations + أدوات الترحيل |
| `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` | — | عقد OpenAPI وZod المولّد والعميل |
| `lib/global`, `lib/integrations-openai-ai-server` | — | مشتركات |
| `scripts` | — | سكربتات مساعدة |

**هل الكود مكتمل وقابل للتصدير؟** نعم، كل شيء committed. لكن النشر محجوب بـ P0-1.

## C. جاهزية الميزات

التصنيف: `ISOLATED_TESTED` = مغطى باختبارات نجحت في هذا التدقيق على PG18 مؤقتة. `IMPLEMENTED_UNVERIFIED` = موجود ولم يُتحقق منه هنا. لا يوجد أي بند `PRODUCTION_VERIFIED` أو `DEPLOYED_STAGING_VERIFIED`، لأنه لا يوجد نشر.

> تُقرأ هذه الجدول مع جدول نتائج الاختبارات في §Q-1. أي suite فشلت تُنزل البند المقابل.

| # | النظام | المصدر / المسار | الاعتماديات الخارجية | التصنيف | المتطلب الناقص بدقة |
|---|---|---|---|---|---|
| A | دخول الزائر | `GET /api/listings`، `/api/markets`، `POST /api/ai/preview` (`routes/ai.ts`) | لا (الدردشة تحتاج AI) | ISOLATED_TESTED | — |
| B | التسجيل | `POST /api/auth/register`، `/auth/phone-verification/challenges` (`lib/auth.ts`) | **مزود SMS** | **BLOCKED** | مزود SMS بمحوّل `PhoneVerificationProvider` للإنتاج، أو قرار سياسة بديل (P0-2) |
| C | الدخول/الخروج | `/auth/login`، `/auth/logout`، كوكي `bdinar_session` 7 أيام | لا | ISOLATED_TESTED | — |
| D | استعادة كلمة المرور | **غير موجود** (لا مسار reset/forgot في `auth.ts`) | SMS | **INCOMPLETE** | مسار reset عبر OTP الهاتف مع rate-limit وإبطال الجلسات |
| E | الجلسات والأجهزة | `sessionMiddleware`؛ rate-limit موقَّع بـ `SESSION_SECRET` (`auth-rate-limiter.ts:63`) | لا | ISOLATED_TESTED | لا توجد قائمة أجهزة أو إلغاء جلسات أخرى (P3) |
| F | تعديل الملف الشخصي | `PATCH /account/profile`، الصورة الرمزية | تخزين كائنات | IMPLEMENTED_UNVERIFIED على Railway | P0-5 |
| G | حذف الحساب | `POST /account/deletion` (`trust-safety.ts`) + طلبات الخصوصية | لا | ISOLATED_TESTED | مدد احتفاظ معتمدة قانونياً (`DINAR_RETENTION_APPROVED`) |
| H | الدردشة العربية العامة | `POST /ai/conversations/:id/turns` (`routes/ai.ts`)، `model-turn.ts` | مزود AI | ISOLATED_TESTED (offline) | لم تُشغَّل بمستخدم مسجّل في بيئة منشورة |
| I | بوابة DeepSeek | `model-gateway.ts:178-200` | DeepSeek | VERIFIED_LIVE_PROVIDER (benchmark معزول، PARTIAL) | §F |
| J | البث SSE | `routes/ai.ts:1987-1990` | — | ISOLATED_TESTED (`test:deepseek-stream`) | لم يُتحقق خلف Railway proxy |
| K | محاسبة استخدام AI | `ai-usage.ts`، `ai-spend.ts` (hold/settle)، جداول `ai_usage_*`, `ai_spend_*` | — | ISOLATED_TESTED | **سعر نموذج حقيقي في `ai_model_prices`** (القاعدة الجديدة فيها 0 صفوف؛ الأسعار الوهمية ممنوعة في staging/production، `ai-spend.ts:81-93`) |
| L | البحث | `GET /listings`، `search-query.ts` | لا | ISOLATED_TESTED | — |
| M | الاكتشاف | `recommendations.ts`، `marketplace-categories.ts` | لا | ISOLATED_TESTED | — |
| N | المقارنة | مسار `SEARCH_LISTINGS` في المحادثة | AI | ISOLATED_TESTED | R3-03 فشل حياً بمخالفة عقد |
| O | مسودة البائع | `draft-actions.ts`، `listing-draft.ts` | AI اختياري | ISOLATED_TESTED | R3-01 فشل حياً (`missingFacts` 10>8، أُصلح offline في `a42ffd1`) |
| P | نشر الإعلان | `POST /listings`، `publication-policy.ts` | تخزين صور | ISOLATED_TESTED | P0-5 للصور |
| Q | تعديل الإعلان | `PATCH /listings/:id` | — | ISOLATED_TESTED | — |
| R | التفاوض الشامل | `negotiations.ts`، `negotiation-turn.ts` | — | ISOLATED_TESTED (`test:universal-negotiation`) | — |
| S | صلاحيات المشتري والبائع | `requireAuth`، فحوص actor/resource | — | ISOLATED_TESTED (`test:security`) | — |
| T | إنشاء الطلب | `POST /orders`، `/checkout` | — | ISOLATED_TESTED | — |
| U | دورة حياة الطلب | `POST /orders/:id/:action` | — | ISOLATED_TESTED | — |
| V | Payment intent | `routes/payments.ts` خلف بوابة محاكاة | مزود دفع | **BLOCKED** | مزود حقيقي (§G) |
| W | العمولة ومستحقات البائع | `commerce.ts:233,314` (1000 bps snapshot)، `GET /seller-dues` | — | ISOLATED_TESTED | قرار تحصيل المستحقات (§G) |
| X | تأكيد التسليم | `order-tracking.ts`، `delivery.ts` | — | ISOLATED_TESTED | — |
| Y | إذن التواصل | `contact-release.ts`، `GET /orders/:id/contact` | — | ISOLATED_TESTED (`test:contact`) | — |
| Z | الإشعارات | `notifications.ts` | **قناة إشعار** | INCOMPLETE | لا يوجد محوّل مسجّل (لا استدعاء `register*Provider` في `src`)؛ تبقى السجلات داخل التطبيق فقط |
| AA | الإدارة والإشراف | `/admin/*` (trust-safety, markets, disputes, drivers) | — | ISOLATED_TESTED | **لا آلية لإنشاء أول ADMIN** (الدور افتراضياً `USER`، `schema/index.ts:112`) |
| AB | البلاغات والنزاعات | `/reports`، `/appeals`، `/admin/disputes` | — | ISOLATED_TESTED | استرداد مالي حقيقي يتطلب مزوداً |
| AC | رفع الملفات | `/account/listing-photos/upload-url`، `/complete` | تخزين S3 | IMPLEMENTED_UNVERIFIED على Railway | P0-5 + اختبار `test:storage-portability` |
| AD | سجل المعاملات | `GET /orders`، `/commercial/balance`، `/ai/learning-history` | — | ISOLATED_TESTED | — |
| AE | الموافقات والشاشات القانونية | `/policies`، `/account/policy-acceptances`، `acceptTerms` | — | IMPLEMENTED_UNVERIFIED قانونياً | نصوص معتمدة من محامٍ لبلد الإطلاق |
| AF | التجاوب وRTL | `docs/visual-qa/*-390.png`، فرع `codex/frontend-personal-experience` | — | ISOLATED_TESTED (Chromium: `g3`/`xp`/`ucc`، وDS-15/DS-17 عند 320/390px) | DS-15 متقطّع |

## D. إثبات الترحيل — PostgreSQL 18 جديدة

**بيئة الإثبات:** PostgreSQL **18.6** من `/nix/store/kxjjxz8…-postgresql-18.6`. cluster مؤقت في scratchpad، يستمع على `127.0.0.1:55432` فقط، بلا Unix sockets، مع `env -u` لكل متغيرات `PG*` و`DATABASE_URL`.

| # | المتطلب | النتيجة | الدليل |
|---|---|---|---|
| 1 | الـ runner الرسمي يبني قاعدة فارغة | **PASS** | `pnpm --filter @workspace/db run migrate` → exit 0 خلال 4.3 ثوانٍ (`drizzle-kit migrate`) |
| 2 | اتساق الـ ledger | **PASS** | `drizzle.__drizzle_migrations` = 40 صفاً. كل `hash` = SHA-256 لملف SQL، وكل `created_at` = `when` في الـ journal: **40/40 MATCH** |
| 3 | العدد المتوقع = الفعلي | **PASS** | 40 ملفاً = 40 في journal (آخرها `0039_ai_cache_write_costs`) |
| 4 | الجداول والقيود | **PASS** | 80 جدولاً؛ قيود: check 244، FK 188، PK 80، unique 11، not-null 797؛ 22 trigger |
| 5 | جداول AI | **PASS** | `ai_usage_reservations`, `ai_usage_counters`, `ai_spend_holds`, `ai_spend_counters`, `ai_cost_events`, `ai_model_prices`, `ai_billing_reconciliations` … |
| 6 | readiness | **PASS** | build الإنتاج على القاعدة الجديدة: `GET /api/readyz` → `200 {"status":"ready","checks":{"database":"ready","migrations":"current"}}` |
| 7 | بذور/إعداد لازم | معروف | الـ migrations تزرع: `markets` 249، `market_price_versions`، `marketplace_categories` 8، `moderation_reason_codes` 10. **غير مزروع:** `users` = 0، `ai_model_prices` = 0. يلزم أول ADMIN وأول سعر نموذج |
| 8 | لا fixtures تطوير | **PASS** | `users`=0. البذر التطويري (`seed:development`) منفصل ومحمي بـ `BDINAR_SEED=development` |
| 9 | لا حاجة لـ push | **PASS** | `drizzle-kit generate` على نسخة scratch من المجلد: «No schema changes»، و`drizzle-kit check`: «Everything's fine». المستودع لم يتغير |
| 10 | سلوك الفشل | جزئي | الـ migrations تنفّذها drizzle داخل transaction. لم تُختبر حالة فشل migration في المنتصف |
| 11 | الإقلاع على مخطط جديد | **PASS** | أول `/healthz` خلال ~0.55 ثانية، RSS ≈ 164MB |
| 12 | متطلبات النسخة | موثّق | أُثبت على PG 18.6. التطوير الحالي PG16 محلياً |
| 13 | ترحيلات إضافية لاحقة | **FAIL (P0-4)** | لا يوجد runner لغير التطوير |
| 14 | متطلبات الاستعادة | غير مثبت | لا نسخ احتياطي/PITR مُعدّ لـ Staging (§L) |
| 15 | إعادة التشغيل (idempotent) | **PASS** | تشغيل ثانٍ → exit 0، والـ ledger يبقى 40 |

**hashes الـ ledger** (أول 16 حرفاً؛ القائمة الكاملة تُستخرج بـ `sha256sum lib/db/drizzle/*.sql`): `0000 521752ce93003b0e` · `0001 f5a2cc9a633d3334` · `0002 88e81b9a42ca6391` · … · `0038 544c0349205974e6` · `0039 724d67853374cafc`

```
FRESH_DATABASE_INITIALIZATION: PASS
OLD_DEVELOPMENT_DATABASE_REQUIRED_FOR_LAUNCH: NO
```

لا يوجد في الكود ما يعتمد على بيانات قاعدة التطوير. البيانات المرجعية تأتي من الـ migrations نفسها. **الشرط الوحيد:** إذا قرر المالك الاحتفاظ بمستخدمين أو إعلانات تطويرية، يصبح التصدير قراراً منفصلاً بموافقة صريحة.

> **ملاحظة شفافية:** عند أول محاولة إقلاع، كان المنفذ 18080 مشغولاً بخادم التطوير القائم (PID 488، متصل بقاعدة Railway التطويرية). وصلته عن غير قصد أربعة طلبات:
> - `GET /api/readyz` و`GET /api/markets`: قراءة فقط.
> - طلبا POST رُفضا قبل أي معالجة: 403 من فحص الأصل، و404 من بوابة المحاكاة.
>
> لم يُكتب شيء. ردّ `readyz` كان `migrations: pending`، وهذا يتوافق مع حالة 28/40 المعروفة. أُعيد التشغيل على منفذ حر.

## E. مخطط Railway — Staging وProduction

### التوصية: خدمة تطبيق واحدة من نفس الأصل + PostgreSQL + S3

السبب:
- الواجهة تستدعي `/api` نسبياً.
- فحص Origin والكوكي `SameSite=Lax` مصممان لأصل واحد.
- `app.set("trust proxy", 1)` (`app.ts:19`) يفترض **قفزة proxy واحدة**. وضع Caddy أو Nginx أمام الـ API يضيف قفزة ثانية، فيصبح IP كل المستخدمين IP الـ proxy، ويختل rate-limit المصادقة.

لذلك: **خدمة `dinar-app` واحدة تقدّم `/api/*` والملفات الثابتة معاً.** هذا يحتاج تعديلاً صغيراً محكوماً في `app.ts`، وهو المهمة T-G2-02. البديل (خدمتا web وapi مع proxy) ممكن، لكنه يتطلب تعديل `trust proxy`، فهو أكثر خطراً. هذا يحدّث توصية الخدمتين في `DINAR_PRO_GITHUB_RAILWAY_HANDOFF.md` §9.

```
 Browser ─HTTPS─▶ Railway edge ─▶ dinar-app (Node 24)
                                   ├─ /api/*  Express (artifacts/api-server/dist/index.mjs)
                                   ├─ /*      artifacts/dinar/dist/public (SPA fallback)
                                   ├─▶ Postgres (Railway، شبكة خاصة، جديد لكل بيئة)
                                   ├─▶ S3-compatible bucket (خاص لكل بيئة)
                                   └─▶ DeepSeek (Staging فقط بعد G3، مفتاح منفصل)
```

| الحقل | `dinar-app` |
|---|---|
| SERVICE_NAME | `dinar-app` (Staging: `dinar-pro-staging`؛ Production: `dinar-pro-production`، مشروعان أو بيئتان منفصلتان) |
| SOURCE_PATH | جذر المستودع (monorepo مشترك؛ **لا** يُعزل مجلد واحد، لأن `lib/*` حزم workspace) |
| BUILD_CONTEXT | `/` |
| BUILD_COMMAND | `pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/dinar run build`. سكربت الواجهة يضبط `PORT=${PORT:-5173} BASE_PATH=${BASE_PATH:-/}` وقت البناء (`vite.config.ts` يرفض غيابهما). Vite لا يقرأ متغيرات `VITE_*`؛ يقرأ فقط `BASE_URL` و`DEV`، فلا أسرار تدخل الحزمة |
| START_COMMAND | `pnpm --filter @workspace/api-server run start` (= `node --enable-source-maps ./dist/index.mjs`، و**cwd هو مجلد الحزمة**). شرط: `readyz` يقرأ `../../lib/db/drizzle/meta/_journal.json` نسبةً إلى `process.cwd()` (`migration-readiness.ts:10-13`)، فأي start من الجذر يكسر readiness |
| PORT_BINDING | `PORT` من Railway (`index.ts:10-21` يرفض غيابه) |
| HEALTHCHECK_PATH | `/api/readyz` (يرجع 503 إن كانت migrations ناقصة، فلا تُرقّى نسخة لا تطابق المخطط). `/api/healthz` للـ liveness فقط |
| PRE-DEPLOY | runner ترحيل الإنتاج (T-G1-01) قبل التشغيل |
| READINESS_DEPENDENCIES | Postgres reachable + ledger = journal |
| REQUIRED_VARIABLE_NAMES | `NODE_ENV=production`، `DINAR_DEPLOYMENT_ENV=staging\|production`، `DATABASE_URL` (reference لـ Postgres البيئة نفسها)، `SESSION_SECRET` (≥32 بايت عشوائي، مختلف لكل بيئة)، `APP_ORIGIN`، `OBJECT_STORAGE_PROVIDER=s3`، `OBJECT_STORAGE_S3_BUCKET`، `OBJECT_STORAGE_S3_ENDPOINT`، `OBJECT_STORAGE_S3_REGION`، `OBJECT_STORAGE_S3_ACCESS_KEY_ID`، `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`، `OBJECT_STORAGE_S3_PRIVATE_PREFIX`، `OBJECT_STORAGE_S3_PUBLIC_PREFIXES`، `LOG_LEVEL`، `DINAR_RELEASE` |
| متغيرات AI (G3 فقط) | `DINAR_AI_CHAT=true`، `DINAR_AI_PROVIDER=DEEPSEEK`، `DINAR_AI_MODEL=deepseek-flash`، `DINAR_DEEPSEEK_API_KEY` (**ليس** `DINAR_BENCH_DEEPSEEK_API_KEY`)، `DINAR_AI_MODEL_FALLBACK=true` (اسم مضلِّل: هو مفتاح تفعيل استدعاءات النموذج، `model-gateway.ts:319`)، بلا `DINAR_AI_FALLBACK_PROVIDER` |
| **متغيرات محظورة** | `NODE_ENV=development`، و`BDINAR_*_ACCEPTANCE`، و`BDINAR_PROMOTIONS_ENABLED` قبل قرار، و`DEEPSEEK_BENCHMARK_CONTEXT`، و`DINAR_DEV_DATABASE_URL`. السبب: `NODE_ENV=development` يفعّل محاكيات الدفع والترويج ويوجّه الاتصال إلى `DINAR_DEV_DATABASE_URL` |
| PERSISTENT_DEPENDENCIES | Postgres + bucket فقط. نظام ملفات الخدمة مؤقت ولا يُخزّن فيه شيء |
| WATCH_PATHS | `artifacts/api-server/**`، `artifacts/dinar/**`، `lib/**`، `pnpm-lock.yaml`، `package.json`، `pnpm-workspace.yaml` (يُستثنى `docs/**`، `attached_assets/**`، `artifacts/mockup-sandbox/**`) |
| MIN_RUNTIME | Node 24، ذاكرة ≥ 512MB (قيس RSS ≈ 164MB عند الخمول)، **replica واحدة** حتى إثبات أمان الـ sweep على عدة نسخ |

**مراجعة تشغيلية:**

| البند | الحالة |
|---|---|
| CORS | لا CORS (نفس الأصل)، والكتابة cross-origin مرفوضة (أُثبت: 403) |
| CSRF | فحص Origin + `sec-fetch-site` + فرض `application/json` |
| الكوكيز | `httpOnly`، `SameSite=Lax`، `Secure` عند `NODE_ENV=production` |
| HTTPS | من Railway edge |
| SSE | `text/event-stream` + `flushHeaders` (`ai.ts:1987-1990`). لم يُتحقق خلف Railway (مهلة الطلب وbuffering): يُقاس في G2 |
| WebSocket | غير مستخدم |
| حد الرفع | JSON 128kb (`app.ts:137`)، والصور 5MB عبر signed URL |
| SIGTERM | **لا معالجة** (لا `SIGTERM`/`server.close`/`pool.end` في `src`). كل إعادة نشر تقطع الطلبات الجارية وبث SSE (P2-1) |
| تكرار الـ worker | الـ sweep داخل كل replica. `releaseExpiredReservations` يستخدم `FOR UPDATE SKIP LOCKED` فهو آمن، والمهمتان الأخريان لم تُراجعا، لذلك replica واحدة مبدئياً |
| المراقبة | healthcheck Railway يعمل وقت النشر فقط. لا مراقب خارجي ولا محوّل أخطاء (`monitoring.ts` بلا مزود مسجّل) (P1-4) |
| النسخ والاستعادة | Railway Postgres backups يُفعّلها المالك، ويلزم اختبار استعادة إلى خدمة شقيقة (§L) |
| Rollback | Railway redeploy لنسخة سابقة. الـ migrations إضافية فقط ولا down migrations، فالرجوع للخلف لا يُرجِع المخطط. يُعتمد المبدأ: كل migration يجب أن تكون متوافقة مع الإصدار السابق |

## F. جاهزية DeepSeek

| البند | الحالة | الدليل |
|---|---|---|
| النموذج والعقد | `deepseek-flash` فقط، و`https://api.deepseek.com`، وchat completions، والوضع غير التفكيري | `model-gateway.ts:75-76,178-200` |
| فصل المفاتيح | benchmark = `DINAR_BENCH_DEEPSEEK_API_KEY` (تطوير معزول فقط، ويُرفض مع `RAILWAY_ENVIRONMENT`)، والمحادثة = `DINAR_DEEPSEEK_API_KEY` | `model-gateway.ts:184-196` |
| مفتاح الإنتاج | **غير مُعدّ** (الاسم غير موجود في البيئة) | — |
| منع fallback غير مصرح | DeepSeek primary-only للمعرّف المعتمد حصراً، والـ benchmark يُرفض مع fallback | `model-gateway.ts:180-191` |
| JSON/Zod | العقد مفروض. 3/6 ردود حيّة رُفضت بأمان | R3 |
| محاسبة الاستخدام | hold → settle، والأسعار الوهمية ممنوعة في staging/production | `ai-spend.ts:81-93,309-430` |
| السعر | **0 صفوف** في قاعدة جديدة، وإدخاله عبر `POST` إداري (`integrations.ts:81`) يتطلب ADMIN، ولا آلية لإنشاء ADMIN | P0-7 / P1-3 |
| `DINAR_AI_PRODUCTION_APPROVED` | **يُقرأ ويُعرض فقط ولا يُفرض** (`model-gateway.ts:326`) | P2-3 |
| Timeout/Retry | `DINAR_MODEL_TIMEOUT_MS`، `DINAR_AI_MAX_RETRIES` | قيم الإنتاج لم تُحدد |
| البث | `test:deepseek-stream` (replay مسجّل) | §Q-1 |
| آخر تقييم حي | R3، 2026-10-25: 6/6 طلبات، 3 PASS (R3-02/04/05) و3 FAIL (R3-01 `missingFacts`، R3-03 رد غائب، R3-06 بلا أداة تحت `auto`). أُصلحت R3-01/03 offline في `a42ffd1`، ولم يُعَد التحقق حياً | `DINAR_DEEPSEEK_R3_LIVE_ACCEPTANCE_RESULT.md` |
| الدفتر الخارجي | `/home/runner/.dinar-benchmark/ledgers/…R3….jsonl` **غير موجود في هذه البيئة**. الدليل المتاح: `test/fixtures/deepseek-r3-live-responses.json` (6 ردود) و`deepseek-approval-state.json` (`CONSUMED`) | REPORTED_NOT_REVERIFIED للدفتر |

**تسلسل التفعيل المرحلي، مع rollback لكل خطوة:**
1. **G2:** Staging يعمل بلا AI (`DINAR_AI_CHAT` غير مضبوط → الدردشة معطّلة في الإنتاج، `routes/ai.ts:229-230`).
   - Rollback: لا شيء.
2. **G3-a:** إنشاء ADMIN في Staging (T-G1-03)، ثم إدخال سعر `DEEPSEEK/deepseek-flash` من صفحة التسعير الرسمية بتاريخ نافذ.
   - Rollback: إغلاق السعر بإصدار لاحق.
3. **G3-b:** إضافة `DINAR_DEEPSEEK_API_KEY` منفصل للـ Staging بسقف إنفاق لدى DeepSeek، ثم `DINAR_AI_PROVIDER=DEEPSEEK` و`DINAR_AI_MODEL=deepseek-flash` و`DINAR_AI_MODEL_FALLBACK=true` و`DINAR_AI_CHAT=true`.
   - Rollback: حذف `DINAR_AI_CHAT` أو `DINAR_AI_MODEL_FALLBACK` ثم redeploy.
4. **G3-c:** قبول حي محدود بعدد طلبات وميزانية معتمدين، بمستخدمين اصطناعيين، يغطي R3-01..06 + SSE + مطابقة `ai_cost_events` مع فاتورة المزود.
5. **Production:** فقط بعد G3-c PASS ≥ 6/6 أو قبول المالك صراحةً لمعدل الفشل، ومع إنذار إنفاق (P1-4).

```
DEEPSEEK_STAGING_READY: NO
DEEPSEEK_PRODUCTION_READY: NO
```

## G. التدقيق التجاري والمالي

| القاعدة | CONFIRMED_OWNER_POLICY | IMPLEMENTED_CODE_BEHAVIOR | ملاحظة |
|---|---|---|---|
| سعر البائع | سعر متغير يحدده البائع (`DINAR_UNIVERSAL_NEGOTIATION_POLICY.md`، `717400a`) | `FIXED`/`NEGOTIABLE`/`STARTING_FROM`/`QUOTE_REQUIRED` | قاعدة «دينار واحد فقط» تاريخية (HISTORICAL_POLICY) ولا تُستعاد |
| التفاوض | شامل، والقبول يجب أن يطابق المبلغ المعروض فعلاً | `negotiations.ts`، أحداث append-only (`0031`) | — |
| السعر النهائي | المتفق عليه من الطرفين | snapshot في الطلب | — |
| العمولة | 10% | `commissionRateBps: 1_000` snapshot لكل طلب (`commerce.ts:233,314`) | لا يُغيَّر |
| طرق الدفع | — | الافتراضي `CASH_DIRECT` (`schema/index.ts:76`)، و`EXTERNAL_PROVIDER` معرَّف | **UNRESOLVED_OWNER_DECISION:** هل الإطلاق نقدي/مباشر فقط؟ |
| الدفع خارج التطبيق + مستحقات البائع | — | `GET /seller-dues`، `BDINAR_DUES_LIMITS_MINOR` | **UNRESOLVED:** كيف ومتى يُحصَّل الـ10% من البائع (فاتورة؟ تحويل؟ حد ائتماني؟) وما الأثر القانوني والضريبي |
| الاسترداد | — | `REFUND_SUCCEEDED` webhook، ومسار نزاع إداري | الاسترداد المرتبط بالنزاع «يتطلب مزوداً معتمداً» (`payments/service.ts:267`) |
| النزاعات | — | `/admin/disputes/:orderId/resolve`، أدلة | **UNRESOLVED:** المسؤولية والـ SLA |
| الحفظ والتسوية (custody) | — | لا يوجد | **UNRESOLVED:** يتطلب مزوداً ومحامياً |

**البنية المالية:**
- المنفَّذ تقنياً (TECHNICALLY_IMPLEMENTED):
  - المبالغ بالوحدات الصغرى كأعداد صحيحة (`amountMinor` int، وحد 2e9).
  - webhook موقّع.
  - idempotency بـ `Idempotency-Key`.
  - منع ربط intent بمزود خاطئ (`service.ts:162-163,211-212`).
  - منع تكرار الحدث (`providerEventId`).
  - reconciliation (`service.ts:505`).
  - snapshot العمولة.
- SANDBOX_VERIFIED: **لا.** الموجود فقط `TestOnlyPaymentAdapter`، وهو محاكي داخل العملية بلا شبكة.
- PROVIDER_APPROVAL_REQUIRED + LEGAL_OR_COMMERCIAL_DECISION_REQUIRED، قبل اختيار أي مزود:
  - البلد القانوني للتاجر والتسجيل التجاري.
  - البنك وإمكانية التسوية.
  - نموذج marketplace payout (split أو MoR).
  - العملات (السوق يزرع 249 سوقاً بعملات متعددة).
  - مسؤولية الاسترداد والنزاع وchargeback.
  - PCI: صفحة دفع مستضافة لدى المزود، ولا تمر بيانات البطاقة عبر DINAR.
- PRODUCTION_PAYMENT_UNVERIFIED: كل شيء.

```
PAYMENT_SANDBOX: NOT_TESTED   (no provider sandbox exists; in-process simulation only)
PAYMENTS_PRODUCTION: BLOCKED
COMMERCIAL_POLICY: DECISIONS_PENDING
```

## H. الأمن والامتثال

| ISSUE_ID | SEVERITY | المكوّن | الدليل | الأثر | الإصلاح الآمن | اختبار القبول | يمنع الإصدار |
|---|---|---|---|---|---|---|---|
| P0-1 | P0 | Git history | PAT في `.replit` (`f60e30d`) | الوصول لحساب GitHub إن كان الرمز صالحاً | إبطال فوري، ثم قرار filter-repo أو قبول عبر push protection | GitHub يُظهر الرمز «revoked»، وفحص التاريخ نظيف أو مقبول موثّقاً | نعم |
| P0-2 | P0 | التسجيل | §الصفحة الأولى | لا مستخدمين جدد | محوّل SMS للإنتاج | challenge→verify→register على Staging | نعم |
| P1-2 | P1 | dependencies | `pnpm audit --prod`: **high ×2**: `zod <4.6.6` (استنزاف ذاكرة)، و`body-parser 2.0–2.3` (DoS)، عبر express 5.2.1 | DoS على API عام | ترقية `zod` و`express`/`body-parser` ثم إعادة الاختبارات | `pnpm audit --prod` بلا high/critical، وكل suites خضراء | نعم للعام |
| P1-4 | P1 | المراقبة والإشعارات | لا `register*Provider` في `src` | لا إنذار أعطال، ولا إشعار مستخدم | مزود أخطاء (مثل Sentry) ومزود SMS/بريد | خطأ تجريبي يصل للوحة؛ إشعار تجريبي يصل | نعم للعام |
| P1-5 | P1 | استعادة الحساب | لا مسار reset | قفل دائم للمستخدم | reset عبر OTP مع rate-limit | اختبار reset + إبطال الجلسات القديمة | نعم للعام |
| P2-1 | P2 | تشغيل | لا معالجة SIGTERM | قطع طلبات وSSE عند كل نشر | `server.close()` + `pool.end()` بمهلة | إرسال SIGTERM أثناء SSE يُنهي البث بنظافة | لا |
| P2-2 | P2 | بوابات المحاكاة | `isPromotionSimulationEnabled` و`paymentSimulationEnabled` تعتمد على `NODE_ENV` (والأخيرة على `REPLIT_DEPLOYMENT`)، ولا تفحص `RAILWAY_ENVIRONMENT` | خطأ إعداد `NODE_ENV=development` على Railway يفعّل شحن رصيد وهمي | إضافة رفض عند `RAILWAY_ENVIRONMENT`، كما في `model-gateway.ts:188` | اختبار وحدة بالبيئة المحاكية | لا (مع ضبط صحيح) |
| P2-3 | P2 | AI | `DINAR_AI_PRODUCTION_APPROVED` غير مفروض | علم موافقة شكلي | فرضه شرطاً لاستدعاء النموذج في production | اختبار gateway | لا |
| P2-4 | P2 | نظافة المستودع | `.opencode/opencode.db*`، `.agent-g2.*`، ملف `-`، `attached_assets/` | تسرب محادثات أو بيانات خاصة عند المشاركة | مراجعة المالك ثم commit إزالة + `.gitignore` | `git ls-files` نظيف | لا |
| P3-1 | P3 | أداء | حزمة `index-*.js` 828.67kB (gzip 242.56kB) | تحميل أول بطيء على الجوال | تقسيم الكود | Lighthouse على 390px | لا |

**نقاط قوة مثبتة:**
- كلمات المرور بـ scrypt `N=32768` (`auth.ts:63-71`).
- rate-limit المصادقة موقّع ويفشل مغلقاً بدون `SESSION_SECRET` (أُثبت: 503).
- رفض cross-origin (أُثبت: 403).
- ترويسات `nosniff` و`Referrer-Policy`.
- رسائل خطأ 5xx عامة لا تكشف تفاصيل (`app.ts:153-180`).
- مسح سجلات من الإحداثيات والعناوين (`BDINAR_LOG_SCAN`).
- منع `drizzle push`.
- فحص أسرار بـ `test:secrets`.

لم أتهم أي مكوّن بثغرة غير مثبتة. IDOR وXSS مغطّاة باختبارات `test:security` و`test:wave3` (§Q-1)، ولم أُجرِ اختبار اختراق يدوياً.

```
SECURITY_RELEASE_GATE: BLOCKED (P0-1, P0-2, P1-2, P1-4)
```

## I. خط أساس الأداء

| القياس | القيمة | النوع |
|---|---|---|
| بناء API (esbuild) | 2.3 ثانية، و`dist/index.mjs` 5.9MB | MEASURED |
| بناء الواجهة | ~10 ثوانٍ؛ الحزمة الرئيسية 828.67kB / 242.56kB gzip | MEASURED |
| typecheck كامل | 9 ثوانٍ، exit 0 | MEASURED |
| ترحيل 40 migration على PG18 فارغة | 4.3 ثوانٍ | MEASURED |
| إقلاع API حتى أول healthz | ~0.55 ثانية (المحاولة الثانية) | MEASURED |
| RSS بعد الإقلاع | ~164MB | MEASURED |
| `GET /api/markets` (249 سوقاً، قاعدة محلية) | ~9ms | MEASURED (طلب واحد، ليس حِملاً) |
| زمن الدردشة الحية | من R3: يُرجَع إلى `DINAR_DEEPSEEK_R3_LIVE_EVIDENCE.md` | REPORTED |
| تزامن وحِمل | لم يُقَس | NOT_RUN |
| 320px/390px | DS-15/DS-17 PASS (DS-15 متقطّع 1/2) | MEASURED (وظيفي، لا أداء) |

**أهداف مقترحة (ليست إنجازاً):**
- p95 للـ API بدون AI < 300ms على Staging.
- أول حدث SSE < 3 ثوانٍ.
- LCP على 390px/4G < 3 ثوانٍ.
- 0 أخطاء 5xx في smoke بعد النشر.

لا ادعاء لأي SLA أو uptime.

## J. الحد الأدنى للإطلاق

| المرحلة | ميزات مطلوبة | مؤجلة | موافقات خارجية | بوابات | أدلة | rollback |
|---|---|---|---|---|---|---|
| **A. Staging مغلق** | دخول/تسجيل لمستخدمين مختبرين، وتصفح، وإعلانات، وتفاوض، وطلبات `CASH_DIRECT`، وإدارة | AI الحي، والدفع، والترويج المدفوع، والإشعارات | Railway staging + DB جديدة + bucket | P0-1..P0-5 مغلقة | smoke + suites على Staging + readyz | redeploy سابق، وإسقاط القاعدة الاصطناعية |
| **B. Beta عامة بلا دفع** | A + استعادة حساب + مراقبة + إشعارات + نصوص قانونية + دعم/نزاعات + (اختياري) DeepSeek بعد G3 | الدفع داخل التطبيق | محامٍ، ومزود SMS، وDeepSeek prod، ونطاق/DNS | P0-6، P1 كلها | قبول طرفي كامل، واستعادة نسخة مثبتة، وإنذار إنفاق | خفض إلى وضع قراءة فقط أو إيقاف التسجيل |
| **C. سوق بمعاملات حقيقية** | B + مزود دفع + تسوية + استرداد + chargeback + reconciliation | — | مزود دفع، وبنك، ومحاسب، ومحامٍ | G4 + G5 | sandbox ثم مبالغ حقيقية صغيرة مع مطابقة | تعطيل طريقة الدفع والعودة لـ `CASH_DIRECT` |
| **D. تطبيقات أصلية** | نفس الـ API (`lib/api-spec` OpenAPI موجود)؛ مصادقة بالرمز (`setAuthTokenGetter` موجود في العميل) | — | App Store / Play | G7 | — | — |

## K. متطلبات النشر إلى GitHub

1. **المالك:** إبطال الـ PAT (Settings → Developer settings → Fine-grained tokens).
2. **المالك:** قرار التاريخ:
   - إمّا (أ) `git filter-repo` لحذف السطر من `.replit` من كل التاريخ، وهذا يغيّر كل SHA بعد `f60e30d` ويتطلب موافقة منفصلة.
   - أو (ب) الدفع كما هو، وتجاوز push protection رسمياً لرمز مُبطَل.
3. قرار نظافة الملفات (P2-4).
4. `gh auth login` بحساب المالك، أو تكامل GitHub في Replit.
5. ما يُنفَّذ بعد ذلك:
   - `gh repo create dinar-pro --private`.
   - إضافة remote جديد باسم `github`، دون تعديل `origin` إلا بموافقة.
   - `git push github main`.
   - التحقق من `git ls-remote` = SHA المحلي.
6. الفروع:
   - `feature/*` للعمل.
   - `staging` للتكامل، ويُحدَّث بـ PR مراجَع، ويُختار صراحةً في Railway.
   - `main` محمي (مراجعة إلزامية، ومنع force-push والحذف).
   - إصدارات الإنتاج tags غير قابلة للتعديل `vX.Y.Z`.
   - **لا نشر تلقائي للإنتاج.**
7. إنشاء المستودع ليس موافقة على إصدار إنتاج.

```
REPOSITORY_COMPLETE_FOR_GITHUB: YES
GITHUB_PUBLICATION_READY: BLOCKED
```

## L. النسخ الاحتياطي والاستعادة

- قاعدة التطوير القديمة: `DINAR_RAILWAY_POSTGRES_BACKUP_PLAN.md` = `TOOLCHAIN_PREPARED — REAL EXPORT BLOCKED`. لم تُلمس.
- Staging/Production الجديدة: يلزم تفعيل backups في Railway، ثم **اختبار استعادة فعلي إلى خدمة شقيقة**، وتحقق من `readyz` + عدّ الجداول + فحص القيود، وتوثيق RPO/RTO.
- الملفات: versioning/lifecycle على الـ bucket.
- الـ rollback يكون للتطبيق فقط. المخطط للأمام فقط (expand/contract).

```
BACKUP_RECOVERY_GATE: UNVERIFIED
```

## M. قائمة المهام ومسار الحرج

**المسار الحرج:** T-G0-01 → T-G0-03 → T-G1-01 → T-G2-01 ∥ T-G2-02 → T-G2-03 → T-G2-05 → T-G1-03 → T-G3-* → T-G5-* → T-G6-01

| TASK_ID | العنوان | P | OWNER_ROLE | يعتمد على | الملفات | الإجراء | معيار القبول | الأدلة | Rollback | موافقة | الجهد |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T-G0-01 | إبطال PAT المكشوف | P0 | OWNER | — | GitHub settings | revoke | GitHub يُظهره مُبطَلاً | لقطة/تأكيد مكتوب | — | — | 10 دقائق |
| T-G0-02 | قرار التاريخ + النظافة | P0 | OWNER | T-G0-01 | `.replit`، `.opencode/`، `attached_assets/` | اختيار (أ) أو (ب) + قائمة الإزالة | قرار مكتوب | — | — | نعم | 30 دقيقة |
| T-G0-03 | إنشاء `dinar-pro` الخاص والدفع | P0 | REPLIT_AGENT/CLAUDE_CODE | T-G0-02 | remotes | create private + push بلا force | `ls-remote` = SHA المحلي، والمستودع Private | مخرجات الأوامر | حذف المستودع | نعم | 1 ساعة |
| T-G1-01 | runner ترحيل Staging/Production | P0 | CLAUDE_CODE | — | `lib/db/scripts/`، `database-url.ts` | runner جديد بـ `DINAR_MIGRATION_TARGET=staging\|production`: يقرأ `DATABASE_URL`، يتحقق من الـ journal والـ hashes قبل الاتصال، ويرفض `.proxy.rlwy.net` التطويري و`DINAR_DEV_DATABASE_URL` | اختبارات: قاعدة فارغة → 40/40؛ قاعدة جزئية → يكمل؛ hash مختلف → يرفض؛ هدف تطويري → يرفض | سجل الاختبارات على PG18 | لا تغيير للـ migrations | لا (offline) | 0.5–1 يوم |
| T-G1-02 | تثبيت إثبات PG18 كاختبار آلي | P1 | CLAUDE_CODE | T-G1-01 | `lib/db/scripts/rehearsal` | سكربت يكرر §D | exit 0 وledger 40/40 | log | — | لا | 2–4 ساعات |
| T-G1-03 | آلية أول ADMIN + تفعيل سوق الإطلاق | P0 | CLAUDE_CODE | T-G1-01 | سكربت إداري | أمر CLI لمرة واحدة يرقّي مستخدماً موجوداً برقم هاتفه، مع audit log ورفض الإنتاج بدون علم صريح؛ ثم يفعّل المدير سوق الإطلاق المعتمد من الواجهة الإدارية `/admin/markets` | اختبار: ترقية واحدة، والتكرار يُرفض أو يكون idempotent، ويُسجل في audit | اختبار | تخفيض الدور | نعم عند التنفيذ | 2–4 ساعات |
| T-G2-01 | التحقق من الهاتف في غير التطوير | P0 | OWNER → CLAUDE_CODE | قرار مزود SMS | `phone-verification.ts` | محوّل لمزود معتمد خلف `PhoneVerificationProvider` | challenge/verify/register على Staging برقم اختبار | log بلا أرقام كاملة | تعطيل التسجيل | نعم (المزود) | 1–2 يوم + موافقة المزود |
| T-G2-02 | خدمة الواجهة من الـ API (نفس الأصل) | P0 | CLAUDE_CODE | — | `app.ts` | `express.static(artifacts/dinar/dist/public)` + SPA fallback لغير `/api`، مفعّل بمتغير صريح، بلا تغيير لـ `trust proxy` | اختبار: `/` → index.html، `/api/healthz` → JSON، مسار عميق → index.html، وcache headers للأصول | اختبار + Chromium | إزالة المتغير | لا | 2–4 ساعات |
| T-G2-03 | إعداد Railway as code | P0 | CLAUDE_CODE | T-G2-02, T-G1-01 | `railway.json` | build/start/pre-deploy/healthcheck/watch كما في §E | مراجعة + بناء محلي بنفس الأوامر | diff | حذف الملف | لا | 1–2 ساعة |
| T-G2-04 | Bucket S3 لـ Staging | P0 | OWNER/RAILWAY_CONFIGURATION | — | — | إنشاء bucket خاص واعتمادات بأقل صلاحية | `test:storage-portability` + رفع/تنزيل على Staging | log | حذف bucket | نعم | 1 ساعة |
| T-G2-05 | توفير ونشر Staging | P0 | RAILWAY_CONFIGURATION | T-G0-03, T-G2-01..04 | Railway | مشروع منفصل + Postgres جديد + متغيرات §E، و**بلا** autodeploy | `readyz` 200، وsmoke كامل، وcurl من خارج Railway | سجلات Railway | redeploy أو حذف المشروع | نعم ×3 (§O) | 0.5 يوم |
| T-G2-08 | إصلاح انحدار البحث المحادثي (blocka A02، blocke E25) + تثبيت DS-15 | P1 | CLAUDE_CODE | — | `search-context.ts`، `buyer-turn.ts`، `smart-turn.ts` | تتبّع فقدان `categoryId` في التحسين متعدد الأدوار، ومعالجة «أرخص» بعد «رجعني» حتمياً، وانتظار حالة صريحة بدل مهلة في DS-15 | `test:blocka` و`test:blocke` PASS؛ DS-15 ينجح 5/5 تشغيلات متتالية | سجلات الحاضنة | revert | لا | 0.5–1.5 يوم |
| T-G2-06 | معالجة SIGTERM | P2 | CLAUDE_CODE | — | `index.ts` | graceful shutdown | SIGTERM أثناء SSE يُغلق بنظافة خلال المهلة | اختبار | revert | لا | 2 ساعة |
| T-G2-07 | تقوية بوابات المحاكاة | P2 | CLAUDE_CODE | — | `promotion-policy.ts`، `payments.ts` | رفض عند `RAILWAY_ENVIRONMENT` | اختبار وحدة | — | revert | لا | 1 ساعة |
| T-G3-01 | سعر DeepSeek الرسمي + مفتاح Staging | P1 | OWNER | T-G1-03, T-G2-05 | — | إدخال السعر عبر الواجهة الإدارية + مفتاح منفصل بسقف | `listModelPrices` يُظهر السعر؛ المفتاح ليس مفتاح benchmark | — | إغلاق السعر | نعم | 1 ساعة |
| T-G3-02 | قبول DeepSeek منشور | P1 | CLAUDE_CODE | T-G3-01 | — | R3-01..06 + SSE على Staging بمستخدم اصطناعي | ≥ المعيار المعتمد، ومطابقة `ai_cost_events` مع فاتورة المزود ±5% | تقرير + دفتر | إيقاف `DINAR_AI_CHAT` | نعم (ميزانية) | 0.5 يوم |
| T-G3-03 | معالجة 3 مخالفات عقد R3 | P1 | CLAUDE_CODE | — | `model-turn.ts`، `model-gateway.ts` | تحليل R3-06 (`auto` بلا أداة) | replay offline أخضر + إعادة حية ضمن T-G3-02 | اختبار | revert | لا | 0.5–1 يوم |
| T-G4-01 | قرارات الدفع والتسوية | P1 | OWNER/LEGAL | — | — | البلد، والكيان، والمزود، وpayout، والعملات | وثيقة قرار موقعة | — | — | نعم | خارجي |
| T-G4-02 | محوّل مزود الدفع + sandbox | P1 | CLAUDE_CODE/PAYMENT_PROVIDER | T-G4-01 | `lib/payments/` | `PaymentProviderAdapter` حقيقي | سيناريوهات: نجاح، رفض، تكرار webhook، توقيع خاطئ، intent/مستخدم/مزود خاطئ، استرداد، reconciliation | سجل sandbox | تعطيل المزود | نعم | 3–7 أيام |
| T-G5-01 | ترقية dependencies عالية الخطورة | P1 | CLAUDE_CODE | — | `package.json`/lock | ترقية zod وexpress/body-parser | `pnpm audit --prod` بلا high، وكل suites خضراء | log | revert lock | لا | 2–4 ساعات |
| T-G5-02 | مراقبة الأخطاء والإنذار | P1 | CLAUDE_CODE/OWNER | T-G2-05 | `monitoring.ts` | تسجيل محوّل مزود | خطأ اصطناعي يصل؛ إنذار إنفاق AI يعمل | لقطة | تعطيل | نعم (المزود) | 0.5 يوم |
| T-G5-03 | استعادة الحساب | P1 | CLAUDE_CODE | T-G2-01 | `auth.ts` | reset عبر OTP | اختبارات + rate-limit + إبطال الجلسات | اختبار | تعطيل | لا | 1 يوم |
| T-G5-04 | نسخ واستعادة مثبتة | P1 | OWNER/RAILWAY_CONFIGURATION | T-G2-05 | — | تفعيل backups + استعادة لخدمة شقيقة | readyz + عدّ + قيود على المستعادة؛ RPO/RTO موثقان | تقرير | — | نعم | 0.5 يوم |
| T-G5-05 | مراجعة قانونية وخصوصية | P0 للعام | LEGAL_OR_COMPLIANCE_REVIEW | — | السياسات | رأي مكتوب + `DINAR_RETENTION_APPROVED` | رأي موقع | — | — | نعم | خارجي |
| T-G6-01 | إطلاق Beta محكوم | — | OWNER | G2..G5 | DNS | — | مصفوفة §N كلها PASS | — | — | نعم | — |
| T-G7-01 | تجهيز الأصلي | P3 | CLAUDE_CODE | G6 | `lib/api-spec` | مصادقة بالرمز ومراجعة العقد | — | — | — | — | لاحقاً |

## N. مصفوفة قبول الإصدار

| البوابة | المعيار | الحالة الآن |
|---|---|---|
| G0 | مستودع خاص، وSHA مطابق، ولا أسرار فعالة | BLOCKED |
| G1 | runner إنتاج + 40/40 على قاعدة فارغة PG18 | جزئي: الترحيل PASS، والـ runner مفقود |
| G2 | Staging: readyz 200، تسجيل/دخول، إعلان، تفاوض، طلب، رفع صورة، 390px | NOT_STARTED |
| G3 | DeepSeek على Staging: قبول حي + مطابقة تكلفة | BLOCKED |
| G4 | Sandbox دفع كامل | BLOCKED (قرار) |
| G5 | أمن (لا high)، مراقبة، استعادة مثبتة، قانوني | BLOCKED |
| G6 | Beta عامة | BLOCKED |

## O. موافقات المالك المطلوبة (كل واحدة منفصلة)

| الإجراء | جملة الموافقة المقترحة |
|---|---|
| إنشاء ودفع GitHub الخاص | «أوافق على إنشاء مستودع GitHub **خاص** باسم `dinar-pro` تحت حسابي ودفع `main` إليه دون force-push، بعد أن أبطلتُ الرمز المكشوف واخترتُ مسار التاريخ (أ/ب).» |
| إعادة كتابة التاريخ (إن اختير أ) | «أوافق على تشغيل `git filter-repo` لإزالة السطر 35 من `.replit` من كل التاريخ، مع علمي بتغيّر كل SHA بعد `f60e30d`، وعلى أخذ نسخة bundle كاملة قبلها.» |
| توفير Railway Staging | «أوافق على إنشاء مشروع Railway منفصل `dinar-pro-staging` بخدمة `dinar-app` واحدة، دون نشر.» |
| PostgreSQL جديدة لـ Staging | «أوافق على إنشاء قاعدة PostgreSQL جديدة فارغة لـ Staging وتطبيق migrations 0000–0039 عليها فقط عبر runner الإنتاج، دون أي اتصال بقاعدة التطوير القديمة.» |
| ضبط اعتمادات Staging | «أوافق على ضبط `SESSION_SECRET` جديد واعتمادات bucket الـ Staging ومزود SMS الاختباري في متغيرات Staging فقط.» |
| نشر Staging | «أوافق على نشر يدوي واحد للفرع `staging` على `dinar-pro-staging` مع بقاء النشر التلقائي معطلاً.» |
| قبول DeepSeek على Staging | «أوافق على قبول حي على Staging بمفتاح `DINAR_DEEPSEEK_API_KEY` منفصل، بحد أقصى N طلبات وميزانية $X، بمستخدمين اصطناعيين.» |
| sandbox الدفع | «أوافق على فتح حساب sandbox لدى [المزود] واستخدامه في Staging فقط.» |
| تفعيل الدفع الإنتاجي | «أوافق على تفعيل [المزود] في الإنتاج بعد اكتمال G4 والمراجعة القانونية، بسقف مبالغ أولي قدره X.» |
| قاعدة الإنتاج | «أوافق على إنشاء قاعدة PostgreSQL للإنتاج مع backups مفعلة واختبار استعادة قبل أي مستخدم.» |
| DNS | «أوافق على ربط النطاق [domain] بخدمة الإنتاج.» |
| إصدار الإنتاج | «أوافق على إصدار tag `vX.Y.Z` إلى الإنتاج بعد PASS مصفوفة §N.» |
| أي تصدير من قاعدة التطوير القديمة | «أوافق على تصدير [جداول محددة] من قاعدة التطوير القديمة، مشفرة، إلى [وجهة]، لغرض [محدد].» (غير مطلوب للإطلاق) |

## P. تقديرات الوقت (هندسياً، دون الانتظار الخارجي)

| المجموعة | الجهد |
|---|---|
| G0 | ساعة إلى ساعتان + قرار المالك |
| G1 | 1–1.5 يوم |
| G2 | 1.5–3 أيام + مزود SMS |
| G3 | 1–2 يوم + موافقة الميزانية |
| G4 | 3–7 أيام بعد اختيار المزود (القرار القانوني خارجي وقد يستغرق أسابيع) |
| G5 | 2–4 أيام + المراجعة القانونية |
| **حتى Staging مغلق صالح** | **~3–5 أيام عمل** بعد قرارات المالك |
| **حتى Beta بلا دفع** | **~2–3 أسابيع** تقويمياً، ويحكمها القانوني ومزود SMS |

لا أعطي «نسبة إنجاز» واحدة، لعدم وجود منهجية قابلة للدفاع.

## Q. عدم اليقين المتبقي

1. سلوك SSE ومهلة الطلبات خلف Railway edge (يُقاس في G2).
2. ~~أمان الـ sweep على عدة replicas~~: `releaseExpiredReservations` يستخدم `FOR UPDATE SKIP LOCKED` (`routes/marketplace.ts:258-275`)، فهو آمن لحجوزات الطلبات. لم تُراجع المهمتان الأخريان (`expireStalePromotions`، `scrubStaleLocationPreviews`). تبقى replica واحدة حتى المراجعة.
3. صحة `trust proxy = 1` خلف Railway edge (يُتحقق بأن `req.ip` = IP العميل في G2).
4. دفتر R3 الخارجي غير موجود في هذه البيئة.
5. مسار فشل migration في المنتصف لم يُختبر.
6. 320px: مغطى بـ DS-15/DS-17 في Chromium (PASS في التشغيل الثاني)، وDS-15 متقطّع.

### Q-1. نتائج الاختبارات في هذا التدقيق

**أُجريت على PostgreSQL 18.6 مؤقتة على loopback، بالحاضنة الرسمية `test/isolated-regression.mjs`.** كل suite تأخذ قاعدة جديدة مرحّلة ومزروعة بـ fixtures، وتعمل في `env -i` بلا مفاتيح مزودين، ومع `BDINAR_BLOCK_MODEL_CALLS=1`.

| الفئة | النتيجة |
|---|---|
| typecheck كامل | exit 0 |
| بناء API / الواجهة | exit 0 / exit 0 |
| `test` (8 ملفات) | 23+29+6+1+22+12+3+5 PASS، exit 0 |
| `test:api` 63/63، `test:closure` 46/46، `test:wave3` 11/11، `test:wave4` 1/1 | PASS |
| `test:blockb` 5/5، `blockc` 50/50، `blockd` 28/28 (LOG_SCAN 0)، `blockf0`–`blockf5` 12+14+14+17+48+29 | PASS |
| `test:g1` 39/39، `g2` 91+5+13، `universal-negotiation` 38/38، `g3` 6/6 (Chromium)، `contact` 1/1، `gfinal` 22/22، `ucc` 10/10، `xp` 22/22 | PASS |
| `test:db-guard`، `test:secrets`، `test:storage-portability`، `test:readiness` | PASS |
| `test:ai-provider` 47/47، `test:benchmark-guards` 27/27 | PASS |
| الواجهة: `test:surfaces` 14/14، `test:deepseek-stream` 11/11، `test:handoff` 9/9 | PASS |
| **`test:blocka` 0/1** | **FAIL، عيب سابق:** في محادثة متعددة الأدوار، بعد «أريد مرسيدس» تفقد «من 2020 وفوق» الفئة `cars` (`category=undefined`). **ليس من `a42ffd1`:** يفشل بالشكل نفسه بعد إرجاع `search-query.ts` و`model-turn.ts` إلى `a42ffd1~1`. لا يوجد سجل نجاح موثّق حديث. المهمة T-G2-08 |
| **`test:blocke` 45/46** | **FAIL E25، عيب سابق:** «أرخص» بعد «رجعني» لا تُعالج حتمياً فتسقط إلى مسار النموذج، فيظهر للمستخدم «الدردشة الذكية غير متاحة في هذه البيئة» بدل `LISTING_RESULTS`. بلا AI في Staging يرى المستخدم هذا الرد لطلب «أرخص». **ليس من `a42ffd1`** (نفس اختبار الإرجاع). المهمة T-G2-08 |
| `test:security` | **12/12 PASS** بعد إعادة التشغيل بمسارات تخزين محلية وهمية (الفشل الأول كان بيئياً) |
| `test:deepseek-chat` (عبر `file:` + fixtures + Chromium `BDINAR_DEEPSEEK_BROWSER=1`) | تشغيل 1: 20/21 (**DS-15** timeout 8s بانتظار رسالة المساعد). تشغيل 2: **21/21 PASS**. ← **DS-15 متقطّع (flaky)**. يغطي DS-15/DS-17 عرض RTL عند **320px و390px** |
| `test:phase1`، `test:phase2`، `test:preswitch` | NOT_RUN: لا تعيين fixtures لها في الحاضنة |
| أول تشغيل بدائي بلا fixtures | مُستبعد: أخطاء إعداد حاضنة، لا عيوب منتج |


---

## الحكم النهائي

```
CURRENT_GIT_HEAD: a42ffd1da4040b196904e82f126c1835e90174e8
REPOSITORY_COMPLETE_FOR_GITHUB: YES
GITHUB_PUBLICATION_READY: BLOCKED
WEB_FRONTEND: ISOLATED_TESTED
CANONICAL_CHAT: ISOLATED_TESTED
DEEPSEEK_LIVE_R3: PARTIAL
DEEPSEEK_STAGING: BLOCKED
FRESH_POSTGRES18_SCHEMA: PASS
RAILWAY_STAGING_PLAN: BLOCKED
PAYMENT_SANDBOX: NOT_TESTED
PAYMENTS_PRODUCTION: BLOCKED
COMMERCIAL_POLICY: DECISIONS_PENDING
SECURITY_RELEASE_GATE: BLOCKED
BACKUP_RECOVERY_GATE: UNVERIFIED
PUBLIC_BETA_READINESS: BLOCKED
TRANSACTIONAL_LAUNCH_READINESS: BLOCKED
PRODUCTION_DEPLOYMENT: NOT_PERFORMED
RAILWAY_MODIFICATIONS: NONE
PAID_AI_REQUESTS: 0
REAL_PAYMENT_TRANSACTIONS: 0
GITHUB_PUSH: NOT_PERFORMED
NEXT_TASK_1: المالك يُبطل GitHub PAT المكشوف (.replit، commit f60e30d) ويختار مسار التاريخ (أ/ب)
NEXT_TASK_2: المالك يقرّر مزود/سياسة التحقق من الهاتف، ثم Claude Code ينفّذ T-G2-01
NEXT_TASK_3: Claude Code ينفّذ T-G1-01 (runner ترحيل Staging/Production) وT-G2-02 (الواجهة من نفس الأصل)
REPORT_PATH: docs/dinar-next/DINAR_PRO_WEB_LAUNCH_MASTER_PLAN.md
FINAL_LOCAL_COMMIT: انظر رسالة الـ commit المحلي الذي يضيف هذا الملف (لا push)
```

> لم يُطلَق DINAR Pro. وجود الكود ونجاح الاختبارات المعزولة لا يعني الجاهزية للإنتاج.
