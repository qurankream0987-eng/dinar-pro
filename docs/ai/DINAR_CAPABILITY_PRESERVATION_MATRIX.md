# DINAR — مصفوفة الحفاظ على القدرات

**القاعدة:** لا حالة `DELETED`. كل قدرة تبقى تعمل في LEGACY كما كانت، وتُستخدم من النموذج بالدخول من جديد إلى الـruntime نفسه (`canonicalRequest`)، لا بنسخة جديدة منها.

**الحالات:**
- `PU` = PRESERVE_UNCHANGED
- `TOOL` = REUSE_AS_TRUSTED_TOOL
- `VAL` = REUSE_AS_VALIDATOR
- `CTX` = REUSE_AS_CONTEXT_PROVIDER
- `FB` = REUSE_AS_FALLBACK

| ID | القدرة | المصدر | الاختبارات الحالية | يحتاج نموذجًا؟ | الاستخدام الجديد | عند تعطل النموذج | الحالة |
|---|---|---|---|---|---|---|---|
| CAP-01 | المراجع («الثاني»، «هذا»، «الأخير») على نتائج مخزّنة | buyer-turn، arabic-normalization | context-understanding، g2 | لا | TOOL: يدخل إليها `canonicalRequest` مثل «الثاني كم سعره؟» | تعمل | PU + TOOL |
| CAP-02 | سعر وصفات الإعلان من السجل | listing-fact-question | sc02، sc06، spec-generality | لا | TOOL + VAL: النموذج لا يذكر سعرًا، والسجل يجيب | تعمل | PU + TOOL |
| CAP-03 | المقارنة الصادقة (المصدر، «لا ينطبق»، المحسوب) | buyer-turn `compareRows` | w02-ultra-cards | لا | TOOL | تعمل | PU + TOOL |
| CAP-04 | «أيهم …؟» من القيم المسجلة | buyer-turn `whichQuestion` | w02-ultra-cards | لا | TOOL | تعمل | PU + TOOL |
| CAP-05 | السقف والنفي («ما ابي اكثر من») | buyer-turn، arabic-normalization `NOT_MORE` | context-understanding، normalization integrity | لا | TOOL | تعمل | PU |
| CAP-06 | البحث بالفئة والفلاتر والإرخاء المُبلَّغ عنه | search-query، marketplace-listings، tool-registry | block-a، marketplace-intelligence | لا | TOOL: «ابحث عن …» القانونية | تعمل | PU + TOOL |
| CAP-07 | الطيّ العربي واللهجات | arabic-normalization | normalization integrity، arabic-generality | لا | CTX + FB | تعمل | PU |
| CAP-08 | الخطة المركّبة (≤3 خطوات، و«التالي») | task-plan | context-understanding C10/H07، MN-06 | لا | PU: لا تُورَّث مرحلة النموذج للخطوات | تعمل | PU |
| CAP-09 | مراجعة الشراء، ثم التأكيد، ثم checkout | buyer-turn، action-foundation، routes/marketplace | financial-state-machine، W02U-04 | لا | TOOL: «ابي الأول» تفتح مراجعة فقط | تعمل | PU (السلطة لا تنتقل) |
| CAP-10 | الاستفسار للبائع (مسودة، وإضافة، ورفض أرقام، وإرسال بتأكيد) | inquiry-turn، lib/inquiries | next-g2-inquiry، sc02 | لا | TOOL: «اسأل البائع عن …» | تعمل | PU + TOOL |
| CAP-11 | التفاوض | negotiation-turn | g2-smart-conversation | لا | TOOL (مراجعة فقط) | تعمل | PU |
| CAP-12 | مسودة إعلان البائع | listing-draft، draft-actions | block-f، seller suites | لا | TOOL: `CREATE_LISTING_DRAFT` القائم | تعمل | PU |
| CAP-13 | مراجعة الشروط وقبولها | policy-turn، policy-gate | policy-consent-cards | لا | **غير مكشوفة:** «أوافق» من النموذج تُرفض (`DECISION`) | تعمل | PU (D) |
| CAP-14 | كشف التواصل بعد طلب مؤكد فقط | contact-release، listing-contact | listing-contact-text، contact suites | لا | **غير مكشوفة:** رقم في `canonicalRequest` يُرفض | تعمل | PU (D) |
| CAP-15 | غلاف البطاقة والإجراءات المسموحة | card-envelope | wave03-card-envelope، W02U | لا | PU: النموذج لا يمنح إجراء | تعمل | PU (F،D) |
| CAP-16 | حدود سلطة النموذج | model-turn، tool-registry | ai-authority-boundary (لم يتغير، 4/4) | — | PU | — | PU (D) |
| CAP-17 | إنفاق الذكاء (حجز وتسوية ومطابقة) | lib/ai-spend | ai-provider، g1 | — | PU: كل استدعاء جديد يمر بالحجز نفسه | — | PU (D) |
| CAP-18 | حد الأدوار لكل مستخدم (20 في النافذة) | smart-turn `modelTurnLimit` | — | — | PU: **يقيّد MODEL_FIRST عمليًا** (انظر المقارنة) | — | PU |
| CAP-19 | عزل سوق المحادثة | routes/ai `ownedConversation` | context-sealed S11 | لا | PU: الملاحظة الصادقة عند اختلاف السوق | تعمل | PU (D) |
| CAP-20 | النموذج كاحتياط أخير للأسئلة العامة | smart-turn | experience-upgrade، context G | نعم | FB كما هو | رسالة صادقة «غير متاحة» | PU |
