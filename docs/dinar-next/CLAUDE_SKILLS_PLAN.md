# DINAR — خطة Claude Skills (Claude 00)

## ما هو متاح فعلاً في هذه الجلسة

جلسة Claude Code سحابية. **لم تُثبَّت أي إضافة (plugin) ولم يُنزَّل أي سكربت خارجي.**

| المهارة المدمجة | الاستخدام في DINAR | التوصية |
|---|---|---|
| `code-review` | مراجعة كل فرع `claude/*` قبل طلب الدمج | **تُستخدم** في كل موجة |
| `security-review` | مراجعة أمنية للتغييرات في الفرع الحالي | **تُستخدم** لتعديلات المصادقة والدفع والطلبات |
| `simplify` | تنظيف الكود بعد الإصلاح، بلا تغيير سلوك | بعد الموجة 1 فقط |
| `run` | تشغيل التطبيق ورؤية التغيير | للرحلات اليدوية في الموجة 5 |
| `session-start-hook` | تجهيز الجلسات السحابية: تثبيت الحزم وPostgreSQL وبيانات الاختبار | **أولوية عالية**: تختصر ~15 دقيقة إعداد في كل جلسة |
| `skill-creator` | إنشاء مهارات DINAR أدناه وقياسها | لإنشاء المهارات الخاصة |
| `init` | — | **لا حاجة**؛ `CLAUDE.md` كُتب يدوياً من المصدر |

أدوات مذكورة في الخطة لم أجدها في هذه الجلسة: Claude Security، Security Guidance، PR Review Toolkit، Feature Dev، Frontend Design، TypeScript LSP، `/verify`. **لا أؤكد وجودها ولا أوصي بتثبيتها قبل التحقق منها عبر `/plugin`** في جلسة محلية ومراجعة سكربتاتها وأذوناتها. التحقق من الأنواع يغطيه حالياً `pnpm run typecheck` (51 ثانية).

## المهارات الخاصة المقترحة

القاعدة: `CLAUDE.md` يحمل الثوابت القصيرة الدائمة، والمهارة تحمل **إجراءً** قابلاً للتشغيل له مدخلات وأوامر ومعيار نجاح. لا تكرار بينهما.

| المهارة | القرار | السبب |
|---|---|---|
| `dinar-architecture` | **دُمجت في `CLAUDE.md`** | معرفة يحتاجها Claude في كل جلسة، لا إجراء |
| `dinar-test-env` | **جديدة، الأولوية 1** | كل المهارات التالية تحتاج قاعدة معزولة وبيانات وأوامر ثابتة |
| `dinar-financial-integrity` | الأولوية 2 | العيبان D1 وD2 من هذه الجولة من هذا النوع |
| `dinar-commerce` | الأولوية 3 | رحلة بائع ← مشترٍ ← طلب ← تسليم |
| `dinar-ai-quality` | الأولوية 4 | تقييم offline حتمي، والتقييم الحي فقط بموافقة |
| `dinar-security` | **تُبنى فوق `security-review`** | قائمة فحص BOLA وحدود المدخلات والجلسات خاصة بـDINAR |
| `dinar-database` | الأولوية 5 | ترحيل جديد، وقيود CHECK، وrehearsal على PG18 |
| `dinar-browser-e2e` | بعد الموجة 4 | تحتاج stub الخطوط وChromium؛ A–J |
| `dinar-release-gate` | آخر شيء | تجمع مخرجات المهارات السابقة في تقرير واحد |

### 1) `dinar-test-env`
- **PURPOSE:** إنشاء قاعدة PostgreSQL على loopback وتطبيق 40 ترحيلاً وزرع البيانات وتشغيل suite بعزل الشبكة.
- **TRIGGER:** أي طلب لتشغيل اختبارات تعتمد على قاعدة البيانات.
- **SOURCE OF TRUTH:** `test/run.mjs`, `test/acceptance-database-guard.mjs`, `test/isolation/net-guard.mjs`, سكربتات `package.json`.
- **AUTHORIZED TOOLS:** Bash (`createdb`/`dropdb` على `127.0.0.1:55432` فقط)، pnpm، node.
- **FORBIDDEN:** أي URL غير loopback، أي اسم قاعدة خارج `dinar_(test|acceptance|migration)_*`، مفاتيح AI، `drizzle-kit push`.
- **STEPS:** قاعدة جديدة ← `migrate` ← seed (`BDINAR_SEED_PASSWORD` عشوائي) ← suite مع `env -i` وnet-guard ← تسجيل exit وعدد محاولات الخروج.
- **EVIDENCE / OUTPUT:** سطر واحد لكل suite: `SUITE EXIT SECS OUTBOUND_ATTEMPTS DB`.
- **PASS:** exit 0 وصفر محاولات خروج. **FAIL:** أي شيء غير ذلك، ويُسجَّل أول فشل ولا يُخفى.

### 2) `dinar-financial-integrity`
- **PURPOSE:** إثبات أن المال لا يُسجَّل إلا لطلب قابل للدفع، وأنه لا يتكرر، وأن العمولة snapshot ثابت.
- **SOURCE OF TRUTH:** `lib/payments/service.ts`, `lib/order-terminal-accounting.ts`, `routes/marketplace.ts` (orders), `lib/negotiations.ts`.
- **STEPS:** لكل انتقال حالة (CREATED/ACCEPTED/CANCELLED/انتهاء الحجز/DISPUTED) × كل حدث دفع (capture/refund/replay/توقيع مزوّر/مبلغ مختلف) ← اختبار واحد يتوقع رفضاً أو قبولاً محدداً.
- **TESTS:** `payment-order-state.test`, `wave4-payment-acceptance.test`, `commerce-journey.test`, `phase2-commission-acceptance.test`.
- **PASS/FAIL:** مصفوفة الحالات كاملة وخضراء؛ أي خلية بلا اختبار = FAIL.
- **FORBIDDEN:** تخفيف الحراس، وتفعيل مزود حقيقي، وابتكار سياسة استرداد دون موافقة المالك.

### 3) `dinar-commerce`
- **PURPOSE:** رحلة بائع ← نشر ← بحث ← تفاوض ← طلب ← تسليم ← تأكيد، مع رفض كل فاعل غير مخوَّل في كل خطوة.
- **TESTS:** `commerce-journey`, `block-f1/f2/f3`, `universal-negotiation-acceptance`, `listing-pricing-invariants`.
- **OUTPUT:** جدول خطوة × فاعل (مالك/مشترٍ/غريب/إدارة) × النتيجة المتوقعة والفعلية.

### 4) `dinar-ai-quality`
- **PURPOSE:** قياس فهم المحادثة العربية متعددة الأدوار دون نموذج حي، ثم مقارنة حية محدودة بموافقة.
- **STEPS:** (أ) offline: `block-a`, `g2-smart-conversation`, `nl-commerce-followup-probes`, `conversation-router`؛ (ب) حي: مجموعة 30–50 محادثة ثابتة قبل التعديل وبعده، **فقط** بموافقة وميزانية من المالك.
- **PASS:** لا عرض مختلق (كل معرّف في الرد موجود في result set)، ولا ادعاء نجاح دون receipt، وحفظ المرشحات عبر الأدوار.
- **FORBIDDEN:** أي استدعاء مدفوع دون `DINAR_BENCHMARK_APPROVAL_ID`.

### 5) `dinar-security` (فوق `security-review`)
- قائمة: BOLA لكل مورد (listing/order/payment/dispute/contact/conversation)، وحد الجسم والمصفوفات، وCSRF/Origin، وانتهاء الجلسات، وعدم تسريب الهاتف في السجلات (`BDINAR_LOG_SCAN=1`)، و`pnpm audit`.

## المرحلة التالية لإنشاء المهارات

1. `session-start-hook` + `dinar-test-env` (معاً).
2. إنشاء `dinar-financial-integrity` بـ`skill-creator` واختبارها على D1/D2: يجب أن تكتشفهما على كود `b1b20e5`.
3. لا تُضاف مهارة جديدة قبل أن تثبت التي قبلها فائدتها على عيب حقيقي.
