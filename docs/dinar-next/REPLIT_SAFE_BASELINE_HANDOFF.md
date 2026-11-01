# تسليم الأساس الآمن لـReplit

## 1. الأساس

| البند | القيمة |
|---|---|
| المستودع | `qurankream0987-eng/dinar-pro` |
| الفرع | `claude/13-integration-preflight` |
| SHA الشيفرة المختبَرة | `7cd334d9389652c1ebba710c55d806461fe34505`. الالتزامات بعده وثائق فقط |
| البطارية | `CLAUDE_13_COMBINED_ACCEPTANCE_MATRIX.md` §2 |
| CI | §3 من المصفوفة نفسها |

**طريقة العمل:**
- أنشئ فرعك من هذا الـSHA أو من رأس الفرع.
- لا تعمل على `main`، ولا على أي فرع `qoder/*` أو `codex/*` أو `claude/*` قائم.

**وضع هذا الأساس:** ليس دمجًا إلى `main`، ولا نشرًا، ولا ترحيلًا إنتاجيًا. قبل أول تطبيق دائم، قرار المالك في `CLAUDE_13_MIGRATION_AND_API_AUDIT.md` §2.4 ملزم.

## 2. ما يعمل ومُثبت

**الدليل:** البطارية الكاملة، على قواعد مؤقتة، بلا شبكة، وبلا نموذج.

| المجال | الوصف |
|---|---|
| السوق الأساسي | النشر، والبحث (C1 SQL مع rollback `LEGACY`)، والسلة، والطلب، والحجز، والإلغاء، والانتهاء |
| الدفع | محاكاة بأحداث موقّعة ومكررة الحماية، والتزام الاسترداد D3، والعمولة الثابتة |
| التفاوض والتوصيل | التفاوض، والتوصيل والسائقون، والنزاعات |
| W07 | السجل المالي append-only، والعمولة بإصدارات |
| W08 | النقد المباشر والاسترداد النقدي، بترتيب قفل مثبت |
| W09 | السياسات والموافقة الصريحة، بسلطة واحدة، وبوابات الامتثال لكل سوق |
| W10 | البلاغات، والإشراف البشري، والاستئناف، وإشارات الاحتيال، وقضايا الدعم |
| بطاقات المحادثة | Card Envelope v1، وموثوقية W02U-3: العزل بين الجلسات والحسابات، والمزامنة، والانتهاء، والاستعادة، والتزامن، والوصولية، والأداء. التأكيد المتكرر يُجاب بلا نموذج |
| D1 | الخطط الثلاث، والأهلية، والمزايا، وحماية الترتيب العضوي |
| D2 | هوية النشاط، والتسجيل من المحادثة، والمستندات الخاصة، والمراجعة، والإيقاف، وبطاقة النشاط |
| `0047` | ربط الإعلان بالنشاط صريحًا |
| المحادثة | وقت تشغيل واحد، وتوجيه LEGACY/HYBRID/MODEL_FIRST/SHADOW، وLIGHT/HEAVY، وضوابط الإنفاق، وحدود الأجسام، وفحوص الحقن |

## 3. منفّذ لكنه غير موصول (لا يُفعَّل دون قرار المالك)

| القدرة | الحالة |
|---|---|
| فوترة الاشتراكات | `BILLING_PROVIDER_NOT_CONNECTED` |
| فحص المستندات | `SCANNER_NOT_CONNECTED`، فلا توثيق حقيقي لأي نشاط |
| واتساب | قوالب ونوايا وموافقات بلا إرسال |
| أنظمة الأنشطة الخارجية | `ADAPTER_UNAVAILABLE` |
| مزوّد الذكاء | البوابة جاهزة، ولا مزود إنتاج مختار |
| SMS | تجاوز تطوير فقط |
| النقد المباشر | المحرك موجود، والتفعيل لكل سوق قرار مالك |

التفاصيل في `DINAR_EXTERNAL_INTEGRATIONS_AND_LAUNCH_GATES.md`.

## 4. غير المكتمل

| الحزمة | الحالة |
|---|---|
| D3-A | على `qoder/15-d3a-native-business` @ `939930d`. **غير مدمج.** خطة الدمج D3-1 في `DINAR_REMAINING_WORK_FOR_REPLIT.md` |
| D4–D9 ومجالات السوق | نفس الوثيقة |
| OpenAPI | أجسام W07–W10 عامة، و71 مسارًا قديمًا بلا مواصفة (`CLAUDE_13_MIGRATION_AND_API_AUDIT.md` §4) |
| تسلسل الترحيلات | قرار المالك بين هذا الفرع و`qoder/17` |

### ما يمكن لـReplit البدء به فورًا

| الحزمة | الشرط |
|---|---|
| D8-2 (أنواع OpenAPI) | لا قرار مطلوب |
| D7 (صفحات الإدارة والحساب) | خارج ملفات Codex |
| D3-1 | خطوات الدمج التقنية: المنفذ والترقيم والبطاقة الواحدة. اختيار آلية الربط يحتاج قرار المالك، والموصى به `0047` |
| D8-5 | ثبات `w02u3-card-expiry` |

## 5. ملكية Codex

**`ACTIVE_CODEX_WORK`:** DINAR Complete Conversation Experience V2 / Playful Commerce، ويشمل:
- واجهة المحادثة الموحدة، والمساحة السياقية، وبطاقات المنتج والخدمة؛
- الصور والمعارض، والمقارنة؛
- السلة الدائمة وحركة كرة السلة؛
- الوصولية، والحركة المخففة، وأدلة المتصفح والأداء.

**ممنوع على Replit:** تكرار أو إعادة بناء أي من ذلك.

## 6. مسارات حساسة لتعارض الفروع

| المسار | من يلمسه |
|---|---|
| `artifacts/dinar/src/features/ai/**`، `artifacts/dinar/src/pages/Ai.tsx` | Codex، وD3-A، وW02U-3 |
| `lib/api-zod/src/surface-composition.ts`، `lib/api-zod/src/conversation-runtime.ts` | الكل. رمز `BUSINESS_PROFILE` مكرر بين D2 وD3-A |
| `artifacts/api-server/src/ai/card-envelope.ts`، `ai/action-foundation.ts`، `ai/buyer-turn.ts`، `ai/commerce-turn.ts`، `routes/ai.ts` | البطاقات والمحادثة |
| `artifacts/api-server/src/lib/marketplace-cart.ts`، `marketplace-listings.ts`، `routes/marketplace.ts` | Codex (السلة)، وD3-A (`inactiveBusinessListingIds`، `createListingForActor`) |
| `lib/db/drizzle/**`، `meta/_journal.json`، `release-manifest.json`، `lib/db/src/clone-migration-guard.ts`، `lib/db/src/schema/index.ts` | كل ترحيل. الرقم التالي `0048` |
| `lib/payments/**`، `routes/cash.ts`، `lib/policy-gate.ts`، `lib/policy-lifecycle.ts` | مسارات المال والموافقة. مراجعة Claude إلزامية |
| `lib/api-spec/openapi.yaml` وكل `generated/` | codegen فقط، لا تحرير يدوي |

## 7. الاختبارات التي يجب على Replit تشغيلها

**البيئة:**
- PostgreSQL على loopback فقط، وقواعد باسم `dinar_test_*`.
- لا اتصال بـRailway أو Replit DB أو الإنتاج.

**بعد كل تغيير:**

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/dinar run build
pnpm --filter @workspace/dinar run test:surfaces
cd artifacts/api-server
DINAR_LOCAL_PG=postgres://<user>@127.0.0.1:<port> test/isolation/local-suite.sh <suite>.test <flags>
```

**الحد الأدنى بعد كل حزمة:**
- `readiness` (`DINAR_SUITE_SEED=none`)؛
- `development-tls`؛
- `fresh-environment` (`DINAR_SUITE_SEED=none`، وقاعدة `dinar_test_fresh_*`)؛
- `integration-cash-lock-order`، و`integration-policy-consent`، و`integration-business-listings`، و`integration-openapi-coverage`؛
- `commerce-journey`، و`conversation`، و`w02u3-card-reliability`، و`wave03-card-envelope`، و`d1-d2-business-foundation`، و`experience-upgrade-acceptance`؛
- مجموعات الحزمة نفسها.

**الأعلام:** في `artifacts/api-server/package.json`. البطارية الكاملة تشغّل كل `test/*.test.ts` بهذه الأعلام مجتمعة:

```
BDINAR_{SC02,SC06,STOCK_SPEC,T3,WAVE02,WAVE03,PHASE1,PHASE2,SECURITY,WAVE3,WAVE4,BLOCKA,BLOCKC,BLOCKD,BLOCKE,BLOCKF,
G1,G2,G3,GFINAL,XP,UCC,CLOSURE,DEEPSEEK_CHAT,D1D2,W07,W08,W09,W10,W12C,INTEGRATION}_ACCEPTANCE=development
BDINAR_SEED=development BDINAR_TEST_DATABASE=development BDINAR_W02U3_BROWSER=development
BDINAR_W02U3_TEST_DATABASE=development BDINAR_PROMOTIONS_ENABLED=true
```

**استثناءات المجموعات:**

| المجموعة | المتطلب |
|---|---|
| `admin-bootstrap`، `readiness`، `ai-authority-boundary` | بلا seed |
| `phase2-commission-acceptance`، `pre-switch` | seed تطوير |
| `listing-pricing-invariants` | `dinar_test_blockb_*` |
| `listing-image-publication-acceptance` | `dinar_test_image_review*` و`BDINAR_IMAGE_PUBLICATION_ACCEPTANCE=disposable` |
| `personal-intelligence` | خادم 55479 |
| مجموعات المتصفح | `DINAR_CHROMIUM` وstub الخطوط (`test/isolation/third-party-stub.mjs`) |

**قبل طلب أي دمج:** البطارية الكاملة على SHA واحد مجمّد، بالمحاولة الأولى، وبلا تعديل أثناء التشغيل. أي فشل يُوثَّق ويُصلَح ثم تُعاد البطارية.

**CI:** `.github/workflows/claude-integration.yml` نموذج لمصفوفة PG16/PG18. `test:release-migration` يتطلب PG18.

## 8. ما يراجعه Claude بعد كل حزمة

| الحزمة | المراجعة |
|---|---|
| أي ترحيل | الرقم، و`when` التصاعدي، والهاش في المانيفست والحارس، و`development-tls` و`readiness`، وعدم تعديل بيانات تاريخية، وبروفة ترقية |
| D3 | منفذ الهوية بلا fixtures في الإنتاج، وآلية ربط واحدة، وبطاقة واحدة، وترتيب المحوّلات، والإيقاف، وخصوصية الواجهة العامة، والوحدات الصغرى |
| D4 / D5 / D6 | لا أداة كتابة للنموذج، ولا نص نجاح بلا إيصال، وحدود التفويض في الخادم، واختبارات الحقن، والتكلفة LIGHT/HEAVY |
| D8-2 | تطابق مخططات zod في الموجّه مع المواصفة، وأن codegen وحده هو مصدر الملفات المولدة |
| أي مسار مال أو موافقة | ثوابت `CLAUDE.md`، وترتيب الأقفال، وidempotency، و404 للغريب |
| أي واجهة | 360/390/1280، وRTL، وصفر أخطاء console، وعدم لمس ملفات Codex دون تنسيق |
