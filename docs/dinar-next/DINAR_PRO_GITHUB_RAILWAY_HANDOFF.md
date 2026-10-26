# DINAR Pro — تسليم النشر إلى GitHub وتجهيز Railway Staging

التاريخ: 2026-10-25
المنفّذ: Claude Code (فحص للقراءة فقط؛ لم يُجرَ أي تعديل على Git أو GitHub أو Railway)

> **الخلاصة: النشر متوقف (STOP).** عُثر على رمز وصول GitHub شخصي (fine-grained PAT) حقيقي الشكل داخل تاريخ فرع `main` القابل للوصول. وبحسب شروط المهمة، لا يجوز النشر قبل أن يعالج المالك هذا الأمر ويوافق عليه صراحةً.

---

## 1. رابط مستودع GitHub
لا يوجد. لم يُنشأ المستودع `dinar-pro`.
- `gh` غير مسجّل الدخول على أي مضيف، ولا يوجد رمز GitHub في البيئة.
- الـ remote المسمّى `origin` قيمة نموذجية غير صالحة: `https://github.com/USERNAME/REPOSITORY.git`. لم يُعدَّل.

## 2. الخصوصية
غير منطبقة (لم يُنشأ المستودع). المطلوب عند الإنشاء: **PRIVATE**.

## 3. HEAD المحلي
- الفرع: `main`
- SHA: `a42ffd1da4040b196904e82f126c1835e90174e8`
- الرسالة: `R3 live acceptance: 6/6 DeepSeek requests, evidence, offline fixes`
- شجرة العمل نظيفة. عدد الـ commits في `main`: 513.

## 4. HEAD البعيد
لا يوجد (لم يُدفع شيء).
الـ remote المسمّى `gitsafe-backup/main` (نسخة Replit الاحتياطية الداخلية) يحتوي بالفعل على الـ commits المصابة.

## 5. الفرع المدفوع
لا شيء.

## 6. حالة الحفاظ على التاريخ
محفوظ بالكامل محلياً. لم يُنفَّذ أي reset أو rebase أو حذف أو force-push، ولم يُعدَّل أي remote أو فرع.

## 7. نتيجة فحص الأسرار — **BLOCKED**

فُحصت شجرة HEAD وكل الفروع (891 commit) بأنماط: OpenAI/DeepSeek `sk-`، GitHub `ghp_`/`github_pat_`، AWS، Google `AIza`، Groq `gsk_`، Slack، Stripe، المفاتيح الخاصة، وروابط PostgreSQL التي تحمل كلمات مرور. **لم تُطبع أي قيمة سرية.**

### نتيجة حرجة (سبب التوقف)
| البند | التفاصيل |
|---|---|
| النوع | GitHub fine-grained PAT (`github_pat_…`، طوله 93 حرفاً، وهو طول الرمز الحقيقي) |
| الملف | `.replit` السطر 35. لُصق الرمز كاسم متغير بيئة بقيمة فارغة |
| أُضيف في | `f60e30d` (2026-10-16) "Update Replit configuration settings" |
| أُزيل في | `3c9e4b4` (2026-10-20) |
| الوصول | ضمن تاريخ `main` و`replit-agent` و`agent/pre-remediation-3a89636` و`gitsafe-backup/main` |
| في HEAD الحالي | لا |

حذفه من HEAD لا يكفي، فالرمز ما زال قابلاً للاستخراج من التاريخ. كما أن GitHub Push Protection سيرفض الدفع غالباً، ولا يجوز تجاوزه.

### نتائج غير حرجة (بيانات اختبار وهمية)
- روابط PostgreSQL في الاختبارات (`acceptance-database-guard`، `development-tls`، `readiness`، `closure-ai-cost`) كلمات مرورها قيم وهمية (`fixture`، `clone-password`، `p`، قيمة تبدأ بـ `PRI…`، و`sk-closure-…`). لا يظهر أنها اعتمادات حقيقية.
- الملفات الثنائية المتتبَّعة (`.opencode/opencode.db*` وملف zip في `attached_assets`) لم تُظهر أنماط أسرار.

### ملاحظات نظافة (ليست مانعة، ويُنصح بقرار المالك قبل النشر)
- `.opencode/opencode.db`، `-shm`، `-wal`: قاعدة جلسات أداة وكيل متتبَّعة في Git.
- `attached_assets/`: 250 ملفاً من لقطات شاشة ونصوص أوامر ملصوقة وملف zip، بعضها نحو 2.8MB. قد تحتوي على بيانات أو لقطات خاصة.
- `artifacts/api-server/.agent-g2.BnnvMG/`: ملفات مؤقتة لوكيل (نحو 916KB).
- ملف باسم `-` في جذر المستودع (28KB، ثنائي).
- لا توجد ملفات `.env` أو مفاتيح خاصة أو تفريغات قواعد بيانات (ملفات `.sql` المتتبَّعة هي migrations لـ Drizzle فقط) أو مجلدات `dist/build` متتبَّعة.

## 8. اكتمال حزم المصدر (في HEAD)
- `artifacts/api-server` (`@workspace/api-server`)
- `artifacts/dinar` (`@workspace/dinar`)، واجهة Vite
- `artifacts/mockup-sandbox`: أداة تطوير، وليست خدمة إنتاجية
- `lib/`: `api-client-react`، `api-spec`، `api-zod`، `db`، `global`، `integrations-openai-ai-server`
- Migrations: `lib/db/drizzle/0000` حتى `0039` (40 ملفاً، مطابقة لـ `meta/_journal.json`؛ صُحّح من تقرير سابق ذكر 39 بسبب قطع في الإخراج)
- الملفات الجذرية: `package.json`، `pnpm-workspace.yaml`، `pnpm-lock.yaml`، `tsconfig*.json`

المصدر مكتمل محلياً، لكنه **غير منشور**.

## 9. ربط خدمات Railway (مأخوذ من المصدر وليس تخميناً)
| الخدمة | الحزمة | البناء | التشغيل |
|---|---|---|---|
| API | `@workspace/api-server` | `pnpm --filter @workspace/api-server build` (`node ./build.mjs`) | `pnpm --filter @workspace/api-server start` (`node --enable-source-maps ./dist/index.mjs`) |
| Web | `@workspace/dinar` | `pnpm --filter @workspace/dinar build` (Vite؛ يعتمد على `PORT` و`BASE_PATH`) | لا يوجد سكربت `start` إنتاجي. يوجد `serve` = `vite preview`، وهو غير مخصص للإنتاج. **يحتاج قراراً:** خادم ملفات ثابتة، أو أن يخدم الـ API ملفات `dist` |
| PostgreSQL | قاعدة **جديدة** مخصّصة لـ Staging | — | — |
| Worker/Scheduler | **غير مطلوب** | — | التنظيف `sweepExpiredReservations` يعمل داخل عملية الـ API (`setInterval` في `artifacts/api-server/src/index.ts:43`) |

ملاحظات:
- لم أجد وثيقة باسم "launch audit / deployment blueprint" نهائية في `docs/`. لذلك الجدول أعلاه مأخوذ مباشرة من `package.json` لكل حزمة.
- المستودع لا يحتوي على `railway.json` أو `railway.toml` أو `nixpacks.toml` أو `Dockerfile`. إعداد `.replit` يستهدف Replit Autoscale فقط.
- لا يُربط Staging بـ `DATABASE_URL` الخاص بقاعدة Railway التطويرية الحالية.

## 10. حالة اتصال Railway
لم يُلمس Railway إطلاقاً. يوجد `RAILWAY_API_TOKEN` في البيئة ولم يُستخدم.
لا يمكن ربط المصدر لأن المستودع غير موجود على GitHub.
للعلم: ربط مستودع بخدمة Railway يبدأ عادةً نشراً فورياً للفرع المحدد. لذلك يجب ضبط الربط بحيث لا ينشر تلقائياً، أو أن يتم الربط ضمن موافقة النشر الأولى نفسها.

## 11. حالة النشر التلقائي
غير مُعدّ ولا مُفعّل.

## 12. العوائق المتبقية
1. **(حرج)** الـ PAT الموجود في التاريخ:
   - **إبطال الرمز فوراً** من GitHub → Settings → Developer settings → Fine-grained tokens. يُعتبر الرمز مكشوفاً لأنه موجود في نسخة `gitsafe-backup` ومحفوظ في كل نسخ Replit.
   - بعد الإبطال يختار المالك أحد مسارين:
     - **(أ) إعادة كتابة التاريخ** (`git filter-repo` لإزالة السطر من `.replit` في كل الـ commits): يغيّر كل الـ SHA بعد `f60e30d`، ويتطلب موافقة صريحة منفصلة.
     - **(ب) دفع التاريخ كما هو بعد الإبطال**: يرفضه GitHub Push Protection غالباً، ولا يجوز تجاوزه دون قرار المالك عبر واجهة GitHub الرسمية ("allow secret" لرمز مُبطَل).
2. تسجيل دخول GitHub غير متوفر. يجب تشغيل `gh auth login` بحساب المالك، أو ربط تكامل GitHub في Replit.
3. قرار بشأن `attached_assets/` و`.opencode/` والملفات المؤقتة: إبقاؤها في المستودع الخاص، أو إزالتها بـ commit عادي وإضافتها إلى `.gitignore`.
4. قرار طريقة تشغيل الواجهة الأمامية في الإنتاج (البند 9).
5. إضافة إعدادات بناء Railway (railway.json أو إعدادات الخدمة) بعد الموافقة.

## 13. موافقة المالك المطلوبة للنشر الأول على Staging
تُطلب بعد إغلاق البندين 1 و2 ونجاح الدفع والتحقق من SHA. نص الموافقة المقترح:

> "أوافق على إنشاء مشروع Railway منفصل باسم `dinar-pro-staging` يحتوي على: خدمة API وخدمة Web مرتبطتين بمستودع `dinar-pro` على الفرع `staging`، وقاعدة PostgreSQL جديدة فارغة خاصة بـ Staging. أوافق على تطبيق migrations من 0000 إلى 0039 عليها فقط، وعلى نشر أول يدوي واحد، مع إبقاء النشر التلقائي معطلاً. لا موافقة على أي بيانات حقيقية، أو مفاتيح DeepSeek أو دفع إنتاجية، أو DNS، أو أي مساس بقاعدة Railway التطويرية الحالية."

## استراتيجية الفروع المقترحة
- العمل التطويري في فروع `feature/*`.
- الفرع `staging` هو فرع التكامل الذي يُختار صراحةً للنشر على Staging، ولا يُحدَّث إلا عبر PR مراجَع.
- الفرع `main`، أو tags بصيغة `release/*`، للإنتاج فقط. يُحمى بقاعدة Branch Protection: مراجعة إلزامية، ومنع force-push والحذف.
- لا يُفعَّل أي نشر تلقائي للإنتاج.

---

## الحالات النهائية

```
GITHUB_REPOSITORY:      BLOCKED
SOURCE_PUBLISHED:       NO
SOURCE_SHA_VERIFIED:    NO
SECRET_SAFETY:          BLOCKED
RAILWAY_STAGING_SOURCE: BLOCKED
RAILWAY_DEPLOYMENT:     NOT_PERFORMED
RAILWAY_DATABASE:       UNTOUCHED
PRODUCTION:             UNTOUCHED
```

الموقع **غير مُطلق**، والمصدر **غير منشور** على GitHub.
