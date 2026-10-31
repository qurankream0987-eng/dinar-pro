/**
 * Labeled LIGHT/HEAVY routing cases (model-tier.ts). Labels encode DINAR's routing policy:
 *  - LIGHT answers what one structured turn handles: explanations of a single thing, product help,
 *    short copy for one listing, follow-ups whose references DINAR's runtime resolves, and any step
 *    of a plan (plans are split and confirmed deterministically, never by the model).
 *  - HEAVY is for reasoning load: multi-figure calculations, plans/strategies, comparisons of
 *    options against criteria, long-form or multi-variant writing, and long instructions.
 *  - Quoted or pasted text is material, not instruction: its length alone earns nothing.
 * These measure policy conformance of a model-free selector, not any model's answer quality.
 */
export type RoutingCase = { id: string; group: string; message: string; expected: "LIGHT" | "HEAVY" };

const pasted = "«" + "كنبة زاوية بحالة ممتازة استعمال خفيف لمدة سنة واحدة فقط، اللون رمادي فاتح، القماش قابل للتنظيف، المقاسات ثلاثة أمتار في مترين، الاستلام من الجبيهة أو التوصيل بأجرة رمزية داخل عمان، السعر قابل للتفاوض البسيط للجادين فقط. ".repeat(2) + "»";

export const ROUTING_CASES: RoutingCase[] = [
  // Simple explanations and product help: LIGHT.
  { id: "S1", group: "simple-explanation", message: "اشرح لي كيف أضيف صورة لإعلاني", expected: "LIGHT" },
  { id: "S2", group: "simple-explanation", message: "اشرح لي معنى السعر القابل للتفاوض", expected: "LIGHT" },
  { id: "S3", group: "simple-explanation", message: "وضح لي كيف أغير مدينتي", expected: "LIGHT" },
  { id: "S4", group: "simple-explanation", message: "ليش إعلاني ما ظهر بالبحث؟", expected: "LIGHT" },
  { id: "S5", group: "simple-explanation", message: "شو الفرق بين مستعمل وجديد بالإعلان؟", expected: "LIGHT" },
  { id: "S6", group: "simple-explanation", message: "انصحني بعنوان قصير لإعلان جوالي", expected: "LIGHT" },
  // Short but genuinely hard: HEAVY.
  { id: "H1", group: "short-hard", message: "لو بعت 3 قطع بسعر 45 وخصم 10% والعمولة 5% والتوصيل 2، كم صافي ربحي؟", expected: "HEAVY" },
  { id: "H2", group: "short-hard", message: "احسب لي نقطة التعادل إذا التكلفة 1200 والسعر 80 والمصاريف الشهرية 300", expected: "HEAVY" },
  { id: "H3", group: "short-hard", message: "قارن بين البيع بالتقسيط والبيع النقدي لمحلي من حيث المخاطرة والسيولة والربح", expected: "HEAVY" },
  { id: "H4", group: "short-hard", message: "ضع لي خطة تسعير لثلاث فئات منتجات بهامش مختلف لكل فئة", expected: "HEAVY" },
  { id: "H5", group: "short-hard", message: "حلل لي ليش مبيعاتي نزلت هالشهر مع إنه الزيارات زادت", expected: "HEAVY" },
  { id: "H6", group: "short-hard", message: "اشرح لي بالتفصيل خطوة بخطوة كيف أبني استراتيجية تسويق لمتجري", expected: "HEAVY" },
  // Long pasted quotation with a simple ask: LIGHT.
  { id: "Q1", group: "pasted-quotation", message: `${pasted} هل هذا الوصف واضح؟`, expected: "LIGHT" },
  { id: "Q2", group: "pasted-quotation", message: `صحح الأخطاء الإملائية في هذا النص: ${pasted}`, expected: "LIGHT" },
  { id: "Q3", group: "pasted-quotation", message: `"${"هاتف بحالة جيدة جدا والبطارية أصلية والشاشة سليمة بدون خدوش ".repeat(8)}" اختصره بسطر`, expected: "LIGHT" },
  // A long instruction of the user's own: HEAVY.
  { id: "L1", group: "long-instruction", message: "أريد منك أن تساعدني في تجهيز متجري الجديد على DINAR، عندي ملابس أطفال ونسائية وإكسسوارات، وأريد أن أعرف كيف أرتب الفئات وأسعر كل فئة بحيث أنافس المحلات القريبة في عمان، وكيف أكتب أوصافًا تجذب المشترين، وما هي أفضل أوقات النشر، وكيف أتعامل مع طلبات التفاوض دون أن أخسر هامشي، مع العلم أن رأس مالي محدود وأريد أن أبدأ بثلاثين قطعة فقط ثم أتوسع تدريجيًا خلال ستة أشهر، وأريد أيضًا أن أعرف كيف أقيس نجاح كل خطوة.", expected: "HEAVY" },
  // Ordinary marketing copy: LIGHT; long-form or multi-variant: HEAVY.
  { id: "W1", group: "marketing-copy", message: "اكتبلي وصف لإعلان كنبة زرقاء", expected: "LIGHT" },
  { id: "W2", group: "marketing-copy", message: "صغلي عنوان أحلى لإعلان سيارتي", expected: "LIGHT" },
  { id: "W3", group: "marketing-copy", message: "اكتبلي منشور قصير عن عرض اليوم", expected: "LIGHT" },
  { id: "W4", group: "marketing-copy", message: "اكتبلي خمس نسخ مختلفة لوصف متجري بأساليب متنوعة", expected: "HEAVY" },
  { id: "W5", group: "marketing-copy", message: "اكتب لي حملة تسويقية كاملة لأسبوع الافتتاح", expected: "HEAVY" },
  // Apparently simple asks that need several tool steps: DINAR's runtime does the steps.
  { id: "T1", group: "multi-tool", message: "شوفلي أرخص جوال وكم سعره", expected: "LIGHT" },
  { id: "T2", group: "multi-tool", message: "في شي أرخص من هذا بنفس المدينة؟", expected: "LIGHT" },
  // Ambiguous short follow-ups: references are resolved by DINAR; a clarification is the safe answer.
  { id: "F1", group: "follow-up", message: "طيب والثاني؟", expected: "LIGHT" },
  { id: "F2", group: "follow-up", message: "وهذا يناسب ابني؟", expected: "LIGHT" },
  { id: "F3", group: "follow-up", message: "نفس الشي بس أرخص", expected: "LIGHT" },
  // Multi-step tasks: each step is deterministic and confirmed; never a reason for HEAVY.
  { id: "P1", group: "multi-step-gated", message: "ابحث عن هاتف أقل من 100، قارن الأول والثاني، واسأل صاحب الأرخص عن البطارية", expected: "LIGHT" },
  { id: "P2", group: "multi-step-gated", message: "أكد الطلب وادفع", expected: "LIGHT" },
  // Several questions at once: HEAVY.
  { id: "M1", group: "multi-question", message: "كم العمولة؟ ومتى يوصلني المبلغ؟ وهل في رسوم على الإلغاء؟", expected: "HEAVY" },
  // Plain chat: LIGHT.
  { id: "C1", group: "chat", message: "مرحبا كيفك", expected: "LIGHT" },
  { id: "C2", group: "chat", message: "شكرا كثير", expected: "LIGHT" },
  { id: "C3", group: "chat", message: "احكيلي نكتة قصيرة عن القهوة", expected: "LIGHT" },
];

/**
 * Held-out phrasings written before the selector change and never used to tune it; their score is
 * reported as measured (docs/ai/DINAR_ULTRA_CLOSURE_REPORT.md), not asserted to be perfect.
 */
export const HELD_OUT_CASES: RoutingCase[] = [
  { id: "X1", group: "simple-explanation", message: "اشرحلي شو يعني توصيل مجاني", expected: "LIGHT" },
  { id: "X2", group: "simple-explanation", message: "ليه ما بقدر أعدل السعر بعد ما انطلب؟", expected: "LIGHT" },
  { id: "X3", group: "simple-explanation", message: "وضحلي الفرق بين الاستلام والتوصيل", expected: "LIGHT" },
  { id: "X4", group: "short-hard", message: "إذا اشتريت بالجملة 50 حبة بـ 3 دينار وبعت الحبة بـ 5 مع عمولة 7%، كم يطلع ربحي؟", expected: "HEAVY" },
  { id: "X5", group: "short-hard", message: "قارن لي بين فتح فرع ثاني أو التوسع أونلاين من حيث التكلفة والمخاطر", expected: "HEAVY" },
  { id: "X6", group: "short-hard", message: "حلل أسعار منافسيني وقلي وين أقدر أرفع سعري", expected: "HEAVY" },
  { id: "X7", group: "pasted-quotation", message: `“${"شقة طابق ثاني ثلاث غرف وصالة ومطبخ راكب وتدفئة مركزية قريبة من الخدمات ".repeat(7)}” هل السعر 250 معقول؟`, expected: "LIGHT" },
  { id: "X8", group: "marketing-copy", message: "اكتب وصف مختصر لساعة يد رجالية", expected: "LIGHT" },
  { id: "X9", group: "marketing-copy", message: "اكتبلي سلسلة منشورات لأسبوع كامل عن متجري", expected: "HEAVY" },
  { id: "X10", group: "follow-up", message: "وكم بدو توصيل؟", expected: "LIGHT" },
  { id: "X11", group: "multi-step-gated", message: "دورلي على غسالة وبعدين اسأل البائع عن الضمان", expected: "LIGHT" },
  { id: "X12", group: "multi-question", message: "وين أشوف طلباتي؟ وكيف ألغي واحد؟ وهل يرجعلي المبلغ؟", expected: "HEAVY" },
  { id: "X13", group: "chat", message: "صباح الخير", expected: "LIGHT" },
  { id: "X14", group: "short-hard", message: "اعمل لي خطة لزيادة مبيعاتي 20% خلال شهرين", expected: "HEAVY" },
];
