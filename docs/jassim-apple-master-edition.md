# وثيقة الإصدار الملكي الموحّد — JassimAI Apple-Grade Master Edition
**الفرع الموحّد:** `google/jassim-apple-master-edition`
**مبني فوق أحدث التزام لـ Claude:** `claude/jassim-ads-phase2` (`07d9e09cfee94ffb96dcf74611e90e002fb5c2c7`)
**التعارضات مع عمل Claude:** `0` (Zero Merge Conflicts)

---

## 1. الهدف من هذا الفرع الموحّد

يجمع هذا الفرع **جميع الفروع الـ26** التي طُوّرت في مسارات الواجهة (`UI-01..UI-15`)، وعقل جاسم الذكي (`AI Brain v2`)، ومنظومة «جاسم كونيكت الشامل والمحادثة الواحدة» (`Connect v2 + Any-Site + Universal OS`)، ومحرك «جاسم روح بيع لي» (`Jassim Ads Go-Sell Engine`)، مع **حزمة الارتقاء البصري الفائق بمستوى Apple (Apple Specular & 3D Studio Pass)** في شجرة كود واحدة نظيفة ومفحوصة بالكامل.

---

## 2. ما الجديد في حزمة الارتقاء البصري الفائق (Apple-Grade Master Pass)

1. **شاشة المحادثة الملكية وكبسولة الموجة الصوتية (`Ai.tsx` + `ChatComposer.tsx` + `PremiumMaterials.css` + `WelcomeSponsored.tsx`):**
   - دمج الخلفية العصبية التفاعلية `InteractiveCircuitBg.tsx` بسلاسة مع مكوّن `DisplaySponsored` الذي أضافه Claude في `Ai.tsx`.
   - تزويد شريط الإدخال `ChatComposer.tsx` بطيف موجات صوتية متوهج (`VoiceWaveformBadge` باللونين السيان `#38bdf8` والذهبي `#f3cc73`) يتفاعل حياً أثناء التسجيل الصوتي ويحترم `prefers-reduced-motion`.
   - ترقية بطاقات الانطلاق الثلاث في `Welcome` إلى ثلاث هويات زجاجية متوهجة:
     - `أريد أن أشتري` (`data-action="buy"`): زجاج ياقوتي أزرق ملكي مع خط انعكاس ضوئي داخلي `inset 0 1px 0`.
     - `أريد أن أبيع` (`data-action="sell"`): زجاج ذهبي سيادي مشعّ مع هالة ضوئية محيطية.
     - `قارن الأسعار` (`data-action="compare"`): زجاج زمردي-تيل متوهج (`Emerald-Cyan Teal Glass`).
   - ترقية بطاقات `WelcomeSponsored.tsx` بإطار ذهبي زجاجي وشارة تاج `VIP` للبطاقة الأولى وزر سلة ذهبي دائري مع الحفاظ على حد البطاقات الثلاث (`slice(0, 3)`).

2. **بطاقة المتجر الذكي ذات التاج الملكي (`SmartStoreCardView.tsx`):**
   - بناء كامل غير مقطوع لجميع أقسام `SmartSection` الـ13 مع رأس البطاقة الملكي المنحوت (`Notched Royal Blue & Gold Header`)، ولمعة الحافة العلوية الذهبية، ومعرض الصور التفاعلي، وحجز موضع الدفع داخل المحادثة `data-slot="in-chat-payment-slot"`.

3. **استوديو البطاقات اللانهائية ثلاثي الأبعاد (`LayeredStage.tsx` + `UniversalCardEngine.tsx`):**
   - ترقية رسوم طبقات البرغر (`BurgerLayerSvg`) ومانيكان الأزياء (`MannequinStage`) واستوديو الساعة الذكية (`ProductStudioStage`) إلى رسوم متعددة الطبقات بتدرجات إضاءة استوديو (`linearGradient` + `radialGradient`) ولمعان الكريستال الياقوتي والتيتانيوم.
   - تحريك كل طبقة وقطعة ولون بفيزياء نابض حقيقية (`Framer Motion layout` + `AnimatePresence` + `layoutId` للأزرار النشطة).

4. **تعميم المواد الزجاجية والحواف الضوئية (`Apple Specular Materials`) على الصفحات التجارية والإدارية:**
   - ترقية `Search.tsx`، و`OfferDetails.tsx`، و`Checkout.tsx`، و`OrderDetails.tsx`، و`Account.tsx`، و`AdminPromotions.tsx`، و`AdminConnect.tsx`، و`Connect.tsx`، و`SmartStorePreview.tsx` بحواف ضوئية داخلية دقيقة `inset 0 1px 0 rgba(255,255,255,0.14)` وظلال محيطية متعددة المراحل دون المساس بأي `data-testid` أو `aria-label`.

---

## 3. خريطة الوحدات الخلفية الجاهزة للربط (17 وحدة مختبرة بـ 20/20 اختبار وحدة)

- **AI Brain v2 (`artifacts/api-server/src/ai/`):**
  - `dual-channel-stream.ts` · `model-first-router.ts` · `context-compressor.ts` · `read-only-agent-loop.ts` · `hybrid-search-fusion.ts` · `infinite-card-adapter.ts` · `prompt-cache-evals.ts` · `delivery-tracker-engine.ts` · `jassim-generative-os.ts` · `jassim-go-sell-engine.ts` · `external-ads-contract.ts`
- **Jassim Connect v2 & Any-Site (`artifacts/api-server/src/connect/`):**
  - `platform-presets.ts` · `in-chat-checkout-contract.ts` · `interactive-card-mapping.ts` · `inventory-webhook.ts` · `workflow-recovery.ts` · `universal-site-ingestor.ts` · `url-auto-connect.ts`
