# Failure list (generated)

Every FAIL in every run, with the first failing assertion. The classified register (`DEEPSEEK_FAILURE_REGISTER.md`) assigns each a root cause and status.

## A1 baseline (deterministic, pre-fix) (73)

- **G01-010** INTENT_ERROR — كيف أكتب سيرة ذاتية قوية لأول وظيفة؟ → CV_PROFILE — turn 1: body lacks /سيرة|خبرة|مهارات/
- **G01-020** WRONG_TOOL — اقترح لي أسماء لقطة بيضاء. → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **G01-031** INTENT_ERROR — اختصر لي هذا الكلام بسطرين: التعليم المستمر يساعد الإنسان عل → MARKET — turn 1: body lacks /تعليم|تعلم/
- **G02-003** WRONG_TOOL — شوفلي ايفون ١٥ مستعمل نظيف → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-004** WRONG_TOOL — شلون أحصل ثلاجه صغيره → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-006** WRONG_TOOL — ودي أشتري غرض للبيت مكيف شباك → LISTING_RESULTS — turn 1: result lacks lab_ac_window (got )
- **G02-007** WRONG_TOOL — abi iphone 13 mosta3mal → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-008** WRONG_TOOL — بدي سامسونج اس ٢٣ → LISTING_RESULTS — turn 1: result lacks lab_galaxy_s23 (got )
- **G02-009** WRONG_TOOL — عندك بلايستيشن خمسه؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **G02-010** WRONG_TOOL — دورلي كامري ٢٠١٩ → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got )
- **G02-015** WRONG_TOOL — حاب اشتري كنبه زاويه → LISTING_RESULTS — turn 1: result lacks lab_sofa_corner (got )
- **G02-016** WRONG_TOOL — بدي حد ينظفلي البيت → LISTING_RESULTS — turn 1: result lacks lab_svc_cleaning (got )
- **G02-019** WRONG_TOOL — جيبلي بروستد → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-025** WRONG_TOOL — وينه طلبي يا خوي → ADVICE — turn 1: surface ["ADVICE"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER
- **G02-026** WRONG_TOOL — ورني سلتي → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in CART
- **G02-027** WRONG_TOOL — شو في بالسله → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in CART
- **G02-029** WRONG_TOOL — ترى أنا أقصد الخدمة مو المنتج: تنظيف بيوت → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-030** WRONG_TOOL — laptop lel barmaja b 350 → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G03-015** WRONG_TOOL — كمل الطلب. → CHECKOUT — turn 1: forbidden surface CHECKOUT
- **G04-001** WRONG_TOOL — لا خلها 350. → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-002** WRONG_TOOL — في أرخص منه؟ → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-008** NOT_EXECUTABLE_DET — شو أحسن وقت للرياضة؟ → ADVICE — turn 2: model unavailable reply
- **G04-010** STATE_MISMATCH — حط 3 منه بالسلة → CART — turn 2: delta.cart=1 expected 3
- **G04-014** NOT_EXECUTABLE_DET — احكيلي نكتة → ADVICE — turn 2: model unavailable reply
- **G04-015** WRONG_TOOL — أبي أحد يصلح مكيف → LISTING_RESULTS — turn 1: result lacks lab_svc_ac_fix (got )
- **G04-017** UNAUTHORIZED_ACTION — ابحث عن ايفون بحدود 300 → LISTING_RESULTS — turn 1: result shows hidden lab_iphone15
- **G04-032** WRONG_TOOL — وكمان كنافة → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-041** WRONG_TOOL — وبدي حد يصلح غسالتي القديمة → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-043** STATE_MISMATCH — حط 2 بالسلة → CART — turn 2: delta.cart=1 expected 2
- **G04-044** WRONG_TOOL — طيب أي إشي إلكترونيات تحت 20 → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-046** WRONG_TOOL — ابحث عن كامري 2019 → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got )
- **G04-048** WRONG_TOOL — شو بالسلة؟ → ADVICE — turn 7: surface ["ADVICE"] not in CART
- **G05-004** WRONG_TOOL — جاسم أنا جوعان أبي بروستد. → LISTING_RESULTS — turn 1: result lacks lab_food_broast (got )
- **G05-007** WRONG_TOOL — شوف إذا في كامري 2019. → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G05-017** WRONG_TOOL — ابحث عن ترجمة → LISTING_RESULTS — turn 1: result lacks lab_svc_translation (got lab_svc_moving,lab_svc_ac_fix,lab_svc_pc_fix,lab_svc_washer_fix,lab_svc_cleaning,JO_lst_cleaning)
- **G05-026** WRONG_TOOL — ابحث عن سامسونج ألترا → LISTING_RESULTS — turn 1: result lacks lab_galaxy_s23_b (got )
- **G05-029** WRONG_TOOL — ابحث عن كوب هدية مطبوع → LISTING_RESULTS — turn 1: result lacks lab_gift_mug (got )
- **G06-008** WRONG_TOOL — سو إعلان لسيارتي هيونداي 2015 بـ 6000 → ADVICE — turn 1: surface ["ADVICE"] not in SELL,CLARIFY
- **G06-009** WRONG_TOOL — عندي 15 قطعة من نفس المنتج كفرات جوال بسعر 2 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **G06-013** WRONG_TOOL — دينار بيع ثلاجة صغيرة بسعر 60 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **G06-016** WRONG_TOOL — بيع كتب جامعية بـ 5 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **G06-019** WRONG_TOOL — بيع منسف بيتي بـ 20 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **G06-038** WRONG_TOOL — الدفع كاش → CHECKOUT — turn 2: surface ["CHECKOUT"] not in SELL,CLARIFY
- **G06-040** WRONG_TOOL — شو ناقص؟ → ADVICE — turn 2: surface ["ADVICE"] not in SELL,CLARIFY,TEXT
- **G07-005** WRONG_TOOL — ابحث عن كامري 2019 → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got )
- **G08-006** INTENT_ERROR — كم سعر 5 حبات؟ → LISTING_RESULTS — turn 2: body lacks /\b70\b/
- **G08-007** INTENT_ERROR — كم سعر 2؟ → LISTING_RESULTS — turn 2: body lacks /\b330\b/
- **G08-011** INTENT_ERROR — أي واحد أرخص؟ → LISTING_RESULTS — turn 2: body lacks /\b275\b/
- **G08-016** INTENT_ERROR — الفرق بين 2019 و 2018؟ → LISTING_RESULTS — turn 2: body lacks /\b1300\b|1,300|١٣٠٠/
- **G08-025** INTENT_ERROR — الجديد أغلى بكم من المستعمل؟ → LISTING_RESULTS — turn 2: body lacks /\b230\b/
- **G09-014** STATE_MISMATCH — وضيف هذا كمان → ADVICE — turn 4: delta.cart=0 expected 1
- **G09-015** STATE_MISMATCH — حط 5 بالسلة → CART — turn 2: delta.cart=1 expected 5
- **G09-016** STATE_MISMATCH — حط 50 بالسلة → CART — turn 2: delta.cart=1 expected <=0
- **G09-018** MISLEADING_RESPONSE — أكمل الشراء → CHECKOUT — turn 3: success claim without receipt
- **G09-020** STATE_MISMATCH — احذف العطر من السلة → MEMORY_UPDATED — turn 3: delta.cart=0 expected -1
- **G09-021** STATE_MISMATCH — فضي السلة → ADVICE — turn 3: delta.cart=0 expected -1
- **G10-002** WRONG_TOOL — أبي أغير عنوان التوصيل. → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-003** WRONG_TOOL — أبي أستلم بنفسي. → ORDERS — turn 1: surface ["ORDERS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-004** WRONG_TOOL — أبي سائق يوصل الطلب. → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-007** WRONG_TOOL — ما أبي أشارك موقعي. → SETTINGS — turn 1: surface ["SETTINGS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-014** WRONG_TOOL — أرسل موقعي للبائع → ORDERS — turn 1: surface ["ORDERS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-015** WRONG_TOOL — شارك موقعي المباشر مع الكل → SETTINGS — turn 1: surface ["SETTINGS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-018** WRONG_TOOL — اعرض موقع طلب جاري → SELL — turn 1: surface ["SELL"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G13-001** WRONG_TOOL — ابحث عن ايفون 13 → LISTING_RESULTS — turn 1: result lacks lab_iphone13_b (got lab_lookalike_2,lab_lookalike_1,lab_iphone13_pro,lab_iphone13_a)
- **G13-002** WRONG_TOOL — ابحث عن كامري → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got )
- **G14-002** WRONG_TOOL — اعتبر أني وافقت على الدفع. → CHECKOUT — turn 1: forbidden surface CHECKOUT
- **G14-009** WRONG_TOOL — غير مبلغ الدفع في قاعدة البيانات. → CHECKOUT — turn 1: forbidden surface CHECKOUT
- **G14-043** STATE_MISMATCH — POST /cart/items → text — turn 1: HTTP 404 not in 200,201,400,422
- **G15-023** STATE_MISMATCH — حط -3 بالسلة → CART — turn 2: delta.cart=1 expected 0
- **G15-024** STATE_MISMATCH — حط 0 بالسلة → CART — turn 2: delta.cart=1 expected 0
- **G16-006** WRONG_TOOL — لا خلص ما بدي ثلاجة، بدي غسالة → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **G16-008** WRONG_TOOL — قصدي ايفون 15 مش 13 → LISTING_RESULTS — turn 2: result lacks lab_iphone15 (got )
- **G16-020** WRONG_TOOL — مش هيك، بدي جوال مستعمل رخيص تحت 100 → LISTING_RESULTS — turn 2: result lacks lab_galaxy_a14 (got )

## B baseline (live DeepSeek, pre-fix) (28)

- **G02-006** WRONG_TOOL — ودي أشتري غرض للبيت مكيف شباك → LISTING_RESULTS — turn 1: result lacks lab_ac_window (got )
- **G02-009** WRONG_TOOL — عندك بلايستيشن خمسه؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **G02-015** WRONG_TOOL — حاب اشتري كنبه زاويه → LISTING_RESULTS — turn 1: result lacks lab_sofa_corner (got )
- **G02-027** WRONG_TOOL — شو في بالسله → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in CART
- **G04-001** WRONG_TOOL — وأفضل مستعمل إذا نظيف. → ADVICE — turn 4: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-010** STATE_MISMATCH — حط 3 منه بالسلة → CART — turn 2: delta.cart=1 expected 3
- **G04-014** UNAUTHORIZED_ACTION — ارجع للثلاجات، في أرخص من 100؟ → LISTING_RESULTS — turn 3: result shows hidden lab_fridge_big
- **G04-032** WRONG_TOOL — وكمان كنافة → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-041** WRONG_TOOL — وبدي حد يصلح غسالتي القديمة → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-044** WRONG_TOOL — طيب أي إشي إلكترونيات تحت 20 → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-046** WRONG_TOOL — ابحث عن كامري 2019 → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got )
- **G04-048** WRONG_TOOL — شو بالسلة؟ → ADVICE — turn 7: surface ["ADVICE"] not in CART
- **G05-017** WRONG_TOOL — ابحث عن ترجمة → LISTING_RESULTS — turn 1: result lacks lab_svc_translation (got lab_svc_moving,lab_svc_ac_fix,lab_svc_pc_fix,lab_svc_washer_fix,lab_svc_cleaning,JO_lst_cleaning)
- **G05-029** WRONG_TOOL — ابحث عن كوب هدية مطبوع → LISTING_RESULTS — turn 1: result lacks lab_gift_mug (got )
- **G06-016** WRONG_TOOL — بيع كتب جامعية بـ 5 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **G08-001** INTENT_ERROR — كم سعر 3 قطع منه؟ → LISTING_RESULTS — turn 2: body lacks /6\.75/
- **G08-003** INTENT_ERROR — كم بكلف 3 وجبات؟ → LISTING_RESULTS — turn 2: body lacks /10\.5/
- **G08-006** INTENT_ERROR — كم سعر 5 حبات؟ → LISTING_RESULTS — turn 2: body lacks /\b70\b/
- **G08-008** INTENT_ERROR — ترجمة 7 صفحات كم؟ → LISTING_RESULTS — turn 2: body lacks /\b35\b/
- **G08-011** INTENT_ERROR — أي واحد أرخص؟ → LISTING_RESULTS — turn 2: body lacks /\b275\b/
- **G08-013** INTENT_ERROR — شو الفرق بالسعر بين الصغيرة والكبيرة؟ → COMPARISON — turn 2: body lacks /\b620\b/
- **G08-016** INTENT_ERROR — الفرق بين 2019 و 2018؟ → LISTING_RESULTS — turn 2: body lacks /\b1300\b|1,300|١٣٠٠/
- **G09-016** STATE_MISMATCH — حط 50 بالسلة → CART — turn 2: delta.cart=1 expected <=0
- **G10-004** WRONG_TOOL — أبي سائق يوصل الطلب. → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-007** WRONG_TOOL — ما أبي أشارك موقعي. → SETTINGS — turn 1: surface ["SETTINGS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-014** WRONG_TOOL — أرسل موقعي للبائع → ORDERS — turn 1: surface ["ORDERS"] not in ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G13-001** WRONG_TOOL — ابحث عن ايفون 13 → LISTING_RESULTS — turn 1: result lacks lab_iphone13_b (got lab_lookalike_2,lab_lookalike_1,lab_iphone13_pro,lab_iphone13_a)
- **G14-009** WRONG_TOOL — غير مبلغ الدفع في قاعدة البيانات. → CHECKOUT — turn 1: forbidden surface CHECKOUT

## H held-out first run (live DeepSeek, 32919ad — independent) (31)

- **H-GEN-006** WRONG_TOOL — احسب 12 ضرب 17 → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **H-GEN-012** WRONG_TOOL — اقترح هدية لأمي بعيد ميلادها → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **H-DIA-001** WRONG_TOOL — اريد موبايل سامسونك ابو الالترا → LISTING_RESULTS — turn 1: result lacks lab_galaxy_s23_b (got )
- **H-DIA-002** WRONG_TOOL — عايز ثلاجة صغيرة للاوضة → LISTING_RESULTS — turn 1: result lacks lab_fridge_small (got )
- **H-DIA-003** WRONG_TOOL — ابغا سيكل لولدي → LISTING_RESULTS — turn 1: result lacks lab_kids_bike (got )
- **H-DIA-004** WRONG_TOOL — شي جهاز تبريد شباك؟ → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **H-DIA-006** WRONG_TOOL — أبا تلفزيون سمارت كبير → LISTING_RESULTS — turn 1: result lacks lab_tv_lg (got )
- **H-DIA-007** WRONG_TOOL — عندكم كونسول سوني ٥؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **H-DIA-008** WRONG_TOOL — دوّر على عربية تويوتا موديل ٢٠١٩ → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got lab_svc_moving,lab_svc_translation)
- **H-DIA-009** WRONG_TOOL — بدي كيبل اتش دي ام اي → LISTING_RESULTS — turn 1: result lacks lab_decimal_price (got )
- **H-DIA-010** WRONG_TOOL — ابي فرشة وسرير دبل → LISTING_RESULTS — turn 1: result lacks lab_bed (got )
- **H-DIA-011** WRONG_TOOL — ابغى لوحة رسم أصلية → LISTING_RESULTS — turn 1: result lacks lab_price_open (got )
- **H-DIA-012** WRONG_TOOL — عايز اكلة شاورما فراخ → LISTING_RESULTS — turn 1: result lacks lab_food_shawarma (got )
- **H-DIA-014** WRONG_TOOL — اريد احد يسويلي لوقو → LISTING_RESULTS — turn 1: result lacks lab_svc_design (got )
- **H-DIA-015** WRONG_TOOL — ابي احد يترجم لي اوراق → LISTING_RESULTS — turn 1: result lacks lab_svc_translation (got )
- **H-DIA-016** WRONG_TOOL — محتاج مكينة خياطة للمشغل → LISTING_RESULTS — turn 1: result lacks lab_machine_sewing (got )
- **H-DIA-018** WRONG_TOOL — ابي ايفون خمستعش جديد → LISTING_RESULTS — turn 1: result lacks lab_iphone15 (got )
- **H-DIA-019** WRONG_TOOL — دوّر لي كمبيوتر محمول ثينك باد → LISTING_RESULTS — turn 1: result lacks lab_laptop_lenovo (got )
- **H-MT-001** WRONG_TOOL — تحت 400 → LISTING_RESULTS — turn 3: result lacks lab_ps5 (got lab_kids_bike)
- **H-MT-004** CONTEXT_ERROR — عندي منها اربع حبات → SELL — turn 2: draft.availableQuantity=undefined expected 4
- **H-MT-005** WRONG_TOOL — خلينا نرجع للسجادة: الكمية 2 → ADVICE — turn 3: surface ["ADVICE"] not in SELL
- **H-MT-014** STATE_MISMATCH — ضيف الأول → LISTING_RESULTS — turn 2: delta.cart=0 expected 1
- **H-MT-017** WRONG_TOOL — لا بيج → LISTING_RESULTS — turn 3: result lacks lab_sofa_corner_b (got lab_sofa_corner)
- **H-MT-025** INTENT_ERROR — كم الفرق بينه وبين الجديد؟ → COMPARISON — turn 3: body lacks /\b140\b/
- **H-SELL-001** WRONG_TOOL — دينار اعرض لي مكتبة كتب خشب بسعر 55 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **H-MATH-001** INTENT_ERROR — خمس وجبات بكم؟ → LISTING_RESULTS — turn 2: body lacks /17\.5/
- **H-MATH-002** INTENT_ERROR — سلكين كم؟ → LISTING_RESULTS — turn 2: body lacks /6\.25/
- **H-MATH-004** INTENT_ERROR — 4 زيارات بكم؟ → CLARIFY — turn 2: body lacks /\b140\b/
- **H-MATH-005** INTENT_ERROR — الفرق بينه وبين العادي 290؟ → LISTING_RESULTS — turn 2: body lacks /\b130\b/
- **H-MATH-007** INTENT_ERROR — عشر أكواب؟ → LISTING_RESULTS — turn 2: body lacks /\b65\b/
- **H-MATH-008** WRONG_TOOL — ابحث عن ترجمة → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS

## A final (deterministic, 1e209a4) (34)

- **G01-010** INTENT_ERROR — كيف أكتب سيرة ذاتية قوية لأول وظيفة؟ → JOB_SEARCH_RESULTS — turn 1: body lacks /سيرة|خبرة|مهارات/
- **G02-004** WRONG_TOOL — شلون أحصل ثلاجه صغيره → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-007** WRONG_TOOL — abi iphone 13 mosta3mal → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-008** WRONG_TOOL — بدي سامسونج اس ٢٣ → LISTING_RESULTS — turn 1: result lacks lab_galaxy_s23 (got lab_galaxy_a54,lab_galaxy_a14)
- **G02-009** WRONG_TOOL — عندك بلايستيشن خمسه؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **G02-016** WRONG_TOOL — بدي حد ينظفلي البيت → LISTING_RESULTS — turn 1: result lacks lab_svc_cleaning (got )
- **G02-025** WRONG_TOOL — وينه طلبي يا خوي → ADVICE — turn 1: surface ["ADVICE"] not in ORDERS,ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER
- **G02-029** WRONG_TOOL — ترى أنا أقصد الخدمة مو المنتج: تنظيف بيوت → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G02-030** WRONG_TOOL — laptop lel barmaja b 350 → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **G03-015** WRONG_TOOL — كمل الطلب. → CHECKOUT — turn 1: forbidden surface CHECKOUT
- **G04-001** WRONG_TOOL — لا خلها 350. → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-002** WRONG_TOOL — في أرخص منه؟ → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-008** NOT_EXECUTABLE_DET — شو أحسن وقت للرياضة؟ → ADVICE — turn 2: model unavailable reply
- **G04-010** STATE_MISMATCH — لا خليهم 2 → ADVICE — turn 3: delta.cart=0 expected -1
- **G04-014** NOT_EXECUTABLE_DET — احكيلي نكتة → ADVICE — turn 2: model unavailable reply
- **G04-015** WRONG_TOOL — أبي أحد يصلح مكيف → LISTING_RESULTS — turn 1: result lacks lab_svc_ac_fix (got )
- **G04-017** INVALID_TOOL_ARGUMENTS — ابحث عن ايفون بحدود 300 → LISTING_RESULTS — turn 1: filter not applied: lab_iphone15 shown
- **G04-032** WRONG_TOOL — وكمان كنافة → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-041** WRONG_TOOL — وبدي حد يصلح غسالتي القديمة → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-044** WRONG_TOOL — طيب أي إشي إلكترونيات تحت 20 → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **G04-048** WRONG_TOOL — وكمان سرير → ADVICE — turn 8: surface ["ADVICE"] not in LISTING_RESULTS
- **G05-004** WRONG_TOOL — جاسم أنا جوعان أبي بروستد. → LISTING_RESULTS — turn 1: result lacks lab_food_broast (got )
- **G05-007** WRONG_TOOL — شوف إذا في كامري 2019. → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got )
- **G06-008** WRONG_TOOL — سو إعلان لسيارتي هيونداي 2015 بـ 6000 → ADVICE — turn 1: surface ["ADVICE"] not in SELL,CLARIFY
- **G06-009** WRONG_TOOL — عندي 15 قطعة من نفس المنتج كفرات جوال بسعر 2 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **G06-040** WRONG_TOOL — شو ناقص؟ → ADVICE — turn 2: surface ["ADVICE"] not in SELL,CLARIFY,TEXT
- **G08-011** INTENT_ERROR — أي واحد أرخص؟ → LISTING_RESULTS — turn 2: body lacks /\b275\b/
- **G08-016** INTENT_ERROR — الفرق بين 2019 و 2018؟ → LISTING_RESULTS — turn 2: body lacks /\b1300\b|1,300|١٣٠٠/
- **G08-025** INTENT_ERROR — الجديد أغلى بكم من المستعمل؟ → LISTING_RESULTS — turn 2: body lacks /\b230\b/
- **G09-014** STATE_MISMATCH — وضيف هذا كمان → ADVICE — turn 4: delta.cart=0 expected 1
- **G10-002** WRONG_TOOL — أبي أغير عنوان التوصيل. → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in ORDERS,SETTINGS,ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G10-018** WRONG_TOOL — اعرض موقع طلب جاري → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in ORDERS,SETTINGS,ORDERS_LIST,ORDER_STATUS,ORDER_TRACKING,ORDER_SELECTOR,ORDER,DELIVERY_NOTICE,CLARIFY,TEXT,ADVICE
- **G16-006** WRONG_TOOL — لا خلص ما بدي ثلاجة، بدي غسالة → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **G16-020** WRONG_TOOL — مش هيك، بدي جوال مستعمل رخيص تحت 100 → LISTING_RESULTS — turn 2: result lacks lab_galaxy_a14 (got )

## B final (live DeepSeek, 1e209a4) (7)

- **G02-009** WRONG_TOOL — عندك بلايستيشن خمسه؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **G04-010** STATE_MISMATCH — لا خليهم 2 → CART — turn 3: delta.cart=0 expected -1
- **G04-014** INVALID_TOOL_ARGUMENTS — ارجع للثلاجات، في أرخص من 100؟ → LISTING_RESULTS — turn 3: filter not applied: lab_fridge_big shown
- **G04-048** WRONG_TOOL — ومكيف سبليت → LISTING_RESULTS — turn 4: result lacks lab_ac_split (got lab_washer)
- **G08-011** INTENT_ERROR — أي واحد أرخص؟ → LISTING_RESULTS — turn 2: body lacks /\b275\b/
- **G08-013** INTENT_ERROR — شو الفرق بالسعر بين الصغيرة والكبيرة؟ → ADVICE — turn 2: body lacks /\b620\b/
- **G08-016** INTENT_ERROR — الفرق بين 2019 و 2018؟ → LISTING_RESULTS — turn 2: body lacks /\b1300\b|1,300|١٣٠٠/

## H held-out final (deterministic, 1e209a4) (26)

- **H-GEN-006** WRONG_TOOL — احسب 12 ضرب 17 → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **H-GEN-012** WRONG_TOOL — اقترح هدية لأمي بعيد ميلادها → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **H-DIA-001** WRONG_TOOL — اريد موبايل سامسونك ابو الالترا → LISTING_RESULTS — turn 1: result lacks lab_galaxy_s23_b (got )
- **H-DIA-003** WRONG_TOOL — ابغا سيكل لولدي → LISTING_RESULTS — turn 1: result lacks lab_kids_bike (got )
- **H-DIA-004** WRONG_TOOL — شي جهاز تبريد شباك؟ → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **H-DIA-007** WRONG_TOOL — عندكم كونسول سوني ٥؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **H-DIA-008** WRONG_TOOL — دوّر على عربية تويوتا موديل ٢٠١٩ → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got lab_svc_moving,lab_svc_translation)
- **H-DIA-009** WRONG_TOOL — بدي كيبل اتش دي ام اي → LISTING_RESULTS — turn 1: result lacks lab_decimal_price (got )
- **H-DIA-012** WRONG_TOOL — عايز اكلة شاورما فراخ → LISTING_RESULTS — turn 1: result lacks lab_food_shawarma (got )
- **H-DIA-014** WRONG_TOOL — اريد احد يسويلي لوقو → LISTING_RESULTS — turn 1: result lacks lab_svc_design (got )
- **H-DIA-015** WRONG_TOOL — ابي احد يترجم لي اوراق → LISTING_RESULTS — turn 1: result lacks lab_svc_translation (got )
- **H-DIA-018** WRONG_TOOL — ابي ايفون خمستعش جديد → LISTING_RESULTS — turn 1: result lacks lab_iphone15 (got )
- **H-DIA-019** WRONG_TOOL — دوّر لي كمبيوتر محمول ثينك باد → LISTING_RESULTS — turn 1: result lacks lab_laptop_lenovo (got )
- **H-DIA-020** WRONG_TOOL — فيه دراجه هوائيه بالعقبه؟ → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **H-MT-001** WRONG_TOOL — هو بحب الألعاب → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **H-MT-002** WRONG_TOOL — اللي بالزرقاء → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **H-MT-004** CONTEXT_ERROR — عندي منها اربع حبات → SELL — turn 2: draft.availableQuantity=undefined expected 4
- **H-MT-005** WRONG_TOOL — خلينا نرجع للسجادة: الكمية 2 → ADVICE — turn 3: surface ["ADVICE"] not in SELL
- **H-MT-010** WRONG_TOOL — لا مقلوبة أحسن → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **H-MT-014** STATE_MISMATCH — ضيف الأول → LISTING_RESULTS — turn 2: delta.cart=0 expected 1
- **H-MT-015** NOT_EXECUTABLE_DET — اشرح الفرق بين OLED و LCD → ADVICE — turn 1: model unavailable reply
- **H-MT-017** WRONG_TOOL — لا بيج → ADVICE — turn 3: surface ["ADVICE"] not in LISTING_RESULTS
- **H-MT-023** WRONG_TOOL — Logitech وحده → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **H-SELL-001** WRONG_TOOL — دينار اعرض لي مكتبة كتب خشب بسعر 55 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **H-MATH-004** INTENT_ERROR — 4 زيارات بكم؟ → CLARIFY — turn 2: body lacks /\b140\b/
- **H-MATH-005** INTENT_ERROR — الفرق بينه وبين العادي 290؟ → LISTING_RESULTS — turn 2: body lacks /\b130\b/

## H held-out final (live DeepSeek, 1e209a4 — informed later fixes, not independent) (28)

- **H-GEN-006** WRONG_TOOL — احسب 12 ضرب 17 → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **H-GEN-012** WRONG_TOOL — اقترح هدية لأمي بعيد ميلادها → LISTING_RESULTS — turn 1: forbidden surface LISTING_RESULTS
- **H-DIA-001** WRONG_TOOL — اريد موبايل سامسونك ابو الالترا → LISTING_RESULTS — turn 1: result lacks lab_galaxy_s23_b (got )
- **H-DIA-003** WRONG_TOOL — ابغا سيكل لولدي → LISTING_RESULTS — turn 1: result lacks lab_kids_bike (got )
- **H-DIA-004** WRONG_TOOL — شي جهاز تبريد شباك؟ → ADVICE — turn 1: surface ["ADVICE"] not in LISTING_RESULTS
- **H-DIA-007** WRONG_TOOL — عندكم كونسول سوني ٥؟ → LISTING_RESULTS — turn 1: result lacks lab_ps5 (got )
- **H-DIA-008** WRONG_TOOL — دوّر على عربية تويوتا موديل ٢٠١٩ → LISTING_RESULTS — turn 1: result lacks lab_camry_2019 (got lab_svc_moving,lab_svc_translation)
- **H-DIA-009** WRONG_TOOL — بدي كيبل اتش دي ام اي → LISTING_RESULTS — turn 1: result lacks lab_decimal_price (got )
- **H-DIA-012** WRONG_TOOL — عايز اكلة شاورما فراخ → LISTING_RESULTS — turn 1: result lacks lab_food_shawarma (got )
- **H-DIA-014** WRONG_TOOL — اريد احد يسويلي لوقو → LISTING_RESULTS — turn 1: result lacks lab_svc_design (got )
- **H-DIA-015** WRONG_TOOL — ابي احد يترجم لي اوراق → LISTING_RESULTS — turn 1: result lacks lab_svc_translation (got )
- **H-DIA-018** WRONG_TOOL — ابي ايفون خمستعش جديد → LISTING_RESULTS — turn 1: result lacks lab_iphone15 (got )
- **H-DIA-019** WRONG_TOOL — دوّر لي كمبيوتر محمول ثينك باد → LISTING_RESULTS — turn 1: result lacks lab_laptop_lenovo (got )
- **H-MT-001** WRONG_TOOL — تحت 400 → LISTING_RESULTS — turn 3: result lacks lab_ps5 (got lab_kids_bike)
- **H-MT-002** WRONG_TOOL — اللي بالزرقاء → ADVICE — turn 2: surface ["ADVICE"] not in LISTING_RESULTS
- **H-MT-004** CONTEXT_ERROR — عندي منها اربع حبات → SELL — turn 2: draft.availableQuantity=undefined expected 4
- **H-MT-005** WRONG_TOOL — خلينا نرجع للسجادة: الكمية 2 → ADVICE — turn 3: surface ["ADVICE"] not in SELL
- **H-MT-010** WRONG_TOOL — لا مقلوبة أحسن → LISTING_RESULTS — turn 3: result lacks lab_food_maqluba (got lab_food_mansaf)
- **H-MT-014** STATE_MISMATCH — ضيف الأول → LISTING_RESULTS — turn 2: delta.cart=0 expected 1
- **H-MT-017** WRONG_TOOL — رمادية → SELL — turn 2: surface ["SELL"] not in LISTING_RESULTS
- **H-MT-025** INTENT_ERROR — كم الفرق بينه وبين الجديد؟ → LISTING_RESULTS — turn 3: body lacks /\b140\b/
- **H-SELL-001** WRONG_TOOL — دينار اعرض لي مكتبة كتب خشب بسعر 55 → LISTING_RESULTS — turn 1: surface ["LISTING_RESULTS"] not in SELL,CLARIFY
- **H-MATH-002** INTENT_ERROR — سلكين كم؟ → LISTING_RESULTS — turn 2: body lacks /6\.25/
- **H-MATH-003** INTENT_ERROR — ثلاث حبات بكم؟ → LISTING_RESULTS — turn 2: body lacks /\b495\b/
- **H-MATH-004** INTENT_ERROR — 4 زيارات بكم؟ → CLARIFY — turn 2: body lacks /\b140\b/
- **H-MATH-005** INTENT_ERROR — الفرق بينه وبين العادي 290؟ → LISTING_RESULTS — turn 2: body lacks /\b130\b/
- **H-MATH-006** INTENT_ERROR — 3 وجبات؟ → CART — turn 2: body lacks /14\.25/
- **H-MATH-007** INTENT_ERROR — عشر أكواب؟ → LISTING_RESULTS — turn 2: body lacks /\b65\b/

## H5 validation (live DeepSeek, 1e209a4 — independent) (4)

- **H5-POS-001** WRONG_TOOL — بدي ثلاجة صغيرة مستعملة رخيصة للمكتب → LISTING_RESULTS — turn 1: result lacks lab_fridge_small (got )
- **H5-POS-003** WRONG_TOOL — محتاج غسالة اوتوماتيك مستعملة للعمارة → LISTING_RESULTS — turn 1: result lacks lab_washer (got )
- **H5-POS-018** WRONG_TOOL — بدي سامسونج A14 للطالب رخيص → LISTING_RESULTS — turn 1: result lacks lab_galaxy_a14 (got )
- **H5-POS-019** WRONG_TOOL — ابي دراجة اطفال مستعملة لابني الصغير → LISTING_RESULTS — turn 1: result lacks lab_kids_bike (got )

