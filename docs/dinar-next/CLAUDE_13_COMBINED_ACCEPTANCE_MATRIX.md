# CLAUDE 13 — مصفوفة القبول المشتركة

**بيئة التشغيل:**
- PostgreSQL 16.15 على loopback، وقاعدة مؤقتة لكل مجموعة (`test/isolation/local-suite.sh`).
- `env -i` مع net-guard يسجّل كل اتصال صادر.
- `BDINAR_BLOCK_MODEL_CALLS=1`، فلا استدعاء نموذج.
- Chromium حقيقي لرحلات المتصفح، مع خادم stub محلي للخطوط.
- S3 محلي لمجموعات الرفع.

**سكربت البطارية:** يشغّل كل `artifacts/api-server/test/*.test.ts` مرة واحدة، ويسجل **المحاولة الأولى** فقط، ثم `personal-intelligence` على خادم 55479، ثم مجموعتي التخزين.
- لا إعادة محاولة؛
- لا تخطٍّ انتقائي؛
- لا تعديل للمصدر أثناء التشغيل.

**تعريف النتائج:**

| النتيجة | المعنى |
|---|---|
| PASS | خروج 0 |
| FAIL | خروج غير صفري |
| TIMEOUT | تجاوز 1200 ثانية |
| SKIP | اختبار تخطّاه الإطار بالتصميم، ولا يُحسب نجاحًا |

## 1. البطارية الكاملة على `6a335ac9f670e41dc01fd73535945cf63492f513`

هذا الرأس الذي كان قيد التشغيل عند بدء COMMAND 13، وقد **اكتمل**.

| المقياس | النتيجة |
|---|---|
| مجموعات | 130 |
| PASS | **130** |
| FAIL / TIMEOUT / BLOCKED | 0 / 0 / 0 |
| اختبارات PASS | 1366 |
| اختبارات FAIL | 0 |
| اختبارات SKIP | 8 (أدناه) |
| اتصالات خارجية | 0 في 128 مجموعة تحت net-guard. مجموعتا التخزين خارجه بالتصميم (n/a) |
| مجموعات بلا ملخص TAP | `market-capability-registry` (6 `ok`)، و`pre-switch`، و`xp-probe`: سكربتات تُقاس بالخروج 0 |

**الاختبارات المتخطاة الثمانية**، كلها تتطلب شبكة حية وتُتخطى بالتصميم:

| المجموعة | العدد | السبب |
|---|---|---|
| `deepseek-chat-compatibility` | 6 | DeepSeek الحي |
| `development-tls` | 1 | TLS حي |
| `live-model-benchmark` | 1 | قياس نموذج حي |

**بطاريات جزئية سابقة:** ليست دليلًا نهائيًا، ومحفوظة كسجل للإخفاقات الأصلية.
- **`d3a0d40`:** 49 مجموعة، وفشلان.
  - `experience-upgrade`: أخطاء 401 بعد الخروج.
  - `fresh-environment`: حارس النقد يحجب API.
  - أُصلحا في `ee04f9e`.
- **`ee04f9e`:** 68 مجموعة، وTIMEOUT واحد.
  - `listing-image-publication-acceptance`: التنظيف يصطدم بأدلة W09 append-only.
  - أُصلح في `6a335ac`.

## 2. البطارية الكاملة على الرأس النهائي المختبَر `7cd334d`

**التغييرات عن `6a335ac`:**
- دمج `qoder/14` حتى `6687df2`، وفيه CR-15: رحلتا الوصولية والأداء.
- التقاط `6b7a30a` من `qoder/17`: التأكيد المتكرر بلا نموذج.
- دمج وثائق `91b09ee`.
- سير CI جديد.
- وثائق.

<!-- BATTERY-7CD334D -->

**تحقق مستهدف قبل البطارية على `7cd334d`:**

| المجموعة | النتيجة |
|---|---|
| `w02u3-card-reliability` | 8/8 |
| `w02u3-card-accessibility-browser-journey` | 1/1 |
| `w02u3-card-performance-browser-journey` | 1/1 |
| `integration-openapi-coverage` | 2/2 |
| `experience-upgrade-acceptance` | 22/22 |
| typecheck، والبناءان | نظيفة |
| `test:surfaces` | 31/31 |

## 3. PostgreSQL 16 و18 في GitHub Actions

**التشغيل:** `claude-integration`، رقم `41275493692`، على `7cd334d9389652c1ebba710c55d806461fe34505`. النتيجة **success**.

| المهمة | النتيجة |
|---|---|
| `suite (16)` (job `124756728976`) | success |
| `suite (18)` (job `124756728658`) | success |

**الخطوات:** متطابقة في المهمتين.
1. `pnpm install --frozen-lockfile`؛
2. typecheck؛
3. بناء الخادم والواجهة؛
4. `test:surfaces`؛
5. readiness وdevelopment-tls؛
6. مجموعات `integration-*` الأربع؛
7. W07–W12.1: `wave07`، `wave08`، `wave09`، `wave10`، `wave07-w12-contract-hardening`، `financial-state-machine`، `payment-order-state`؛
8. C1 وD1/D2 والبطاقات والسلة والمحادثة: `search-sql-foundation`، `d1-d2-business-foundation`، `d1-d2-business-browser`، `policy-consent-cards`، `w02u3-card-reliability`، `wave03-card-envelope`، `commerce-journey`، `conversation`، `closure-integrations`.

**على PG18 وحده:** `lib/db` `test:release-migration` = success. وهو مُتخطى على PG16 بالتصميم، لأنه يشترط `serverVersionNum >= 180000`.

**طريقة التشغيل:**
- مُشغّل `push` محصور بهذا الفرع؛
- لا `workflow_dispatch` لأن الملف ليس على الفرع الافتراضي؛
- لا رمز شخصي مستخدم أو مكشوف.

## 4. الأدلة المطلوبة في COMMAND 13 ومكانها

كل المجموعات أدناه ضمن البطارية الكاملة. الأعداد من `6a335ac`.

| المطلوب | المجموعات | النتيجة |
|---|---|---|
| typecheck، وبناء API والواجهة | `pnpm run typecheck`، `build` | نظيفة |
| تركيب الأسطح | `test:surfaces` | 31/31 |
| الترحيل والجاهزية | `readiness` (15)، `development-tls` (7، وتخطٍّ حي واحد)، `fresh-environment` (9)، `database-url-selection` (5)، `pre-switch` | PASS. PG18 في §3 |
| W07–W12.1 | `wave07-financial-journal` (10)، `wave08-cash-and-refunds` (12)، `wave09-policy-consent-compliance` (19)، `wave10-trust-support-whatsapp` (24)، `wave07-w12-contract-hardening` (6)، `financial-state-machine` (23)، `payment-order-state` (3)، `wave4-payment-acceptance` | PASS |
| W02U-3 موثوقية البطاقات | `w02u3-card-reliability` (8)، والرحلات: `w02u3-card-concurrency`، `-expiry`، `-recovery`، `-reliability`، `-sessions`. وعلى `7cd334d` أيضًا: `-accessibility`، `-performance` | PASS |
| C1 بحث SQL | `search-sql-foundation` (6)، `search-sql-performance` (3)، `arabic-search-understanding` (5) | PASS |
| D1/D2 وتفويض النشاط | `d1-d2-business-foundation` (24)، `d1-d2-business-browser` (3 / 8 رحلات)، `integration-business-listings` (4)، `pro-subscription-honesty` (2)، `next-g1-usage` (21) | PASS |
| توافق D3-A | لا مجموعة D3-A في هذا الفرع، لأن D3-A غير مدمج | **NOT_VERIFIED** على الفرع المدمج. دليله على فرعه فقط (`qoder/15`: CI `41252858333` و`41252571040`) |
| تدقيق موافقة W09 | `integration-policy-consent` (4)، `policy-consent-cards` (3)، `wave09-*` (19) | PASS |
| تزامن الاسترداد والطلب W08 | `integration-cash-lock-order` (3: حتمي، وإثبات `40P01` بالترتيب القديم، و25 جولة) | PASS |
| السلة والدفع | `commerce-journey` (8)، `commerce` (23)، `block-f3-commerce` (17)، `wave4-payment-acceptance`، `listing-pricing-invariants` (5) | PASS |
| الذكاء والمحادثة | `conversation` (29)، `conversation-router` (13)، `g2-smart-conversation` (91)، `model-tiers` (24)، `model-native-routing` (6)، `ai-provider` (47)، `bounded-multistep` (3)، `closure-ai-cost` (19)، `universal-negotiation-acceptance` (38)، `context-*`، `sc-*` | PASS |
| الأمن | `security-acceptance` (12)، `ai-authority-boundary` (4)، `request-collection-bounds` (6)، `hostile-input-performance` (5)، `same-origin-web` (8)، `conversation-marketplace-isolation` (5)، `api` (63) | PASS |
| متصفح حقيقي | `phase1-acceptance`، `experience-upgrade-acceptance` (22)، `g3-ui` (6)، `sc01`/`02`/`03`/`06`/`07`/`10-browser-journey`، `w02-ultra-browser`، `wave03-card-envelope-browser-journey`، `contact-browser-microclosure`، `d1-d2-business-browser`، رحلات `w02u3-*` | PASS |

## 5. الإصلاحات الثمانية: الوجود والفعالية

| الإصلاح | الموضع | الاختبار الذي يفشل بدونه |
|---|---|---|
| حارس محرك النقد لا يحجب API | `routes/cash.ts`، `router.use([... 4 مسارات], requireCashEngine)` | `fresh-environment`. فشل على `d3a0d40` |
| إعادة التحقق بعد الخروج أو تبديل الحساب | `pages/Ai.tsx`: إعادة القراءة فقط بعد تأكيد الهوية نفسها | `experience-upgrade-acceptance`: أخطاء 401 في console على `d3a0d40` |
| تنظيف الاختبار مع أدلة W09 append-only | `test/disposable-user-cleanup.ts` في 4 مجموعات | `listing-image-publication-acceptance`: TIMEOUT على `ee04f9e` |
| سلطة الموافقة الواحدة | `policy-lifecycle.ts` `requiredAcceptanceVersions`، `policy-gate.ts` عبر `recordPolicyDecision` | `integration-policy-consent` PC-01..04 |
| ترتيب قفل الاسترداد والطلب | `lib/payments/cash.ts` `confirmCashRefundReceipt`: الطلب ثم الاسترداد | `integration-cash-lock-order` LO-02 يثبت `40P01` بالترتيب القديم |
| فجوات OpenAPI لـD1/D2 | 20 عملية بمخططات صارمة | `d1-d2-business-foundation` D2-19 |
| تغطية W07–W10 | 50 عملية بالوصول المفروض | `integration-openapi-coverage` OA-01. **الأجسام عامة** (`CLAUDE_13_MIGRATION_AND_API_AUDIT.md` §4.2) |
| ربط النشاط بالإعلان `0047` | الترحيل، والمشغّل، والعقد v2، ومساران | `integration-business-listings` BL-01..04 |
| (إضافي) تأكيد البطاقة المتكرر بلا نموذج | `ai/action-foundation.ts` `executed`، `ai/buyer-turn.ts` | `w02u3-card-reliability` CR-03 |

## 6. المعروف وغير المخفي

- **`w02u3-card-expiry-browser-journey`:** فشل مرة واحدة في تشغيل تحقق سابق للإصلاحات بمهلة `waitForResponse` لتسجيل الدخول، ونجح عند الإعادة ونجح في البطارية الكاملة. يُعامل كاختبار غير ثابت (D8-5)، ولا يُحسب إصلاحًا.
- **D3-A:** غير مدمج، فلا دليل عليه على هذا الفرع.
- **PG18 محليًا:** غير متاح؛ الدليل من CI فقط (§3).
