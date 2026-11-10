# Multi-turn report

Every executed case with three or more turns, from the final live run (B2) and the held-out live run, turn by turn: what the user said, which runtime tool ran, which card appeared, the persisted delta, and the failures.

### G04-001 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | أبي لابتوب للبرمجة. | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | ميزانيتي 500 دينار. | buyerRefine | LISTING_RESULTS | 0 | 0 |  |
| 3 | لا خلها 350. | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 4 | وأفضل مستعمل إذا نظيف. | searchListings | LISTING_RESULTS | 0 | 0 |  |

### G04-003 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ايربودز برو | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | اشتريه وادفع بدون ما تسألني. | — | PURCHASE_REVIEW | 0 | 0 |  |
| 3 | تمام، بس حطه بالسلة. | — | CART | 1 | 0 |  |

### G04-007 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن لابتوب لينوفو | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | وابحث عن سامسونج A54 | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | كم سعر الأول مقارنة بالثاني؟ | — | CLARIFY | 0 | 0 |  |

### G04-010 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن كوابل شحن تايب سي | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | حط 3 منه بالسلة | — | CART | 3 | 0 |  |
| 3 | لا خليهم 2 | — | CART | 0 | 0 | turn 3: delta.cart=0 expected -1 |

### G04-012 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ايفون 13 | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | الأول | getResource | LISTING_RESULTS | 0 | 0 |  |
| 3 | لا قصدي الثالث | getResource | LISTING_RESULTS | 0 | 0 |  |

### G04-014 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ثلاجة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | احكيلي نكتة | — | ADVICE | 0 | 0 |  |
| 3 | ارجع للثلاجات، في أرخص من 100؟ | searchListings | LISTING_RESULTS | 0 | 0 | turn 3: filter not applied: lab_fridge_big shown |

### G04-021 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | دينار بيع لي ايفون 13 مستعمل نظيف بسعر 300 | — | SELL | 0 | 0 |  |
| 2 | غيّر العنوان إلى ايفون 13 برو | — | SELL | 0 | 0 |  |
| 3 | المدينة إربد | — | SELL | 0 | 0 |  |

### G04-023 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | دينار بيع لي طاولة سفرة بحالة جيدة بسعر 100 | — | SELL | 0 | 0 |  |
| 2 | رقم التواصل +962790000777 | — | SELL | 0 | 0 |  |
| 3 | خلي التواصل عبر المحادثة فقط | — | SELL | 0 | 0 |  |

### G04-028 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن كنافة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | ضيفها للسلة | — | CART | 1 | 0 |  |
| 3 | كمل الطلب | — | CHECKOUT | 0 | 0 |  |

### G04-032 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | جوعان | — | CLARIFY | 0 | 0 |  |
| 2 | بدي شاورما | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | وكمان كنافة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 4 | حط الشاورما بالسلة | — | CLARIFY | 0 | 0 |  |

### G04-039 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن لوحة فنية | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | افتحها | — | ADVICE | 0 | 0 |  |
| 3 | بدي أعرض عليه 150 | — | NEGOTIATION_REVIEW | 0 | 0 |  |

### G04-041 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | مرحبا | — | ADVICE | 0 | 0 |  |
| 2 | بدي غسالة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | وبدي حد يصلح غسالتي القديمة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 4 | رجعني للغسالات الجديدة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 5 | ما بدي شي هلأ | — | ADVICE | 0 | 0 |  |

### G04-048 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | بدي أجهز بيتي الجديد | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | ثلاجة كبيرة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | وغسالة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 4 | ومكيف سبليت | searchListings | LISTING_RESULTS | 0 | 0 | turn 4: result lacks lab_ac_split (got lab_washer) |
| 5 | وكنب زاوية جديد | searchListings | LISTING_RESULTS | 0 | 0 | turn 5: result lacks lab_sofa_corner_b (got lab_ac_split) |
| 6 | حط الكنب بالسلة | — | CLARIFY | 0 | 0 |  |
| 7 | شو بالسلة؟ | — | CART | 0 | 0 |  |
| 8 | وكمان سرير | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 9 | خلص هيك بكفي | — | ADVICE | 0 | 0 |  |
| 10 | شو اللي اخترته؟ | — | ADVICE | 0 | 0 |  |

### G06-036 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | دينار بيع لي جوال سامسونج مستعمل بسعر 100 | — | SELL | 0 | 0 |  |
| 2 | ابحث عن سماعات | buyerSearch | LISTING_RESULTS | 0 | 0 |  |
| 3 | الكمية 5 | — | SELL | 0 | 0 |  |

### G07-001 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن لوحة فنية | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | افتح الأول | getResource | LISTING_RESULTS | 0 | 0 |  |
| 3 | عرض عليه 150 بدل 200 | — | NEGOTIATION_REVIEW | 0 | 0 |  |

### G07-005 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن كامري 2019 | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | افتح الأول | getResource | LISTING_RESULTS | 0 | 0 |  |
| 3 | آخر سعر كم؟ | — | ADVICE | 0 | 0 |  |

### G07-009 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن كوابل شحن | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | افتح الأول | getResource | LISTING_RESULTS | 0 | 0 |  |
| 3 | لو أخذت 10 كم يصير؟ | — | ADVICE | 0 | 0 |  |

### G07-013 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ايفون 15 مستعمل | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | افتح الأول | getResource | LISTING_RESULTS | 0 | 0 |  |
| 3 | اعرض 50000 | — | CLARIFY | 0 | 0 |  |

### G15-007 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن عطر رجالي | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | أضف الأول للسلة | — | CART | 1 | 0 |  |
| 3 | أضف الأول للسلة | — | CART | 1 | 0 |  |

### G16-007 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن كوابل | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | أضف الأول للسلة | — | CART | 1 | 0 |  |
| 3 | غلطت، بدي 3 مش 1 | — | CART | 0 | 0 |  |

### H-MT-001 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | بدي هدية لأخوي | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | هو بحب الألعاب | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | تحت 400 | searchListings | LISTING_RESULTS | 0 | 0 | turn 3: result lacks lab_ps5 (got lab_kids_bike) |

### H-MT-002 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ثلاجات | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | اللي بالزرقاء | — | ADVICE | 0 | 0 | turn 2: surface ["ADVICE"] not in LISTING_RESULTS; turn 2: result lacks lab_zarqa_fridge (got ) |
| 3 | ضيفها | — | ADVICE | 0 | 0 |  |

### H-MT-003 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن كوابل تايب سي | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | بدي ست حبات | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | لا أربعة بكفي | searchListings | LISTING_RESULTS | 0 | 0 |  |

### H-MT-004 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | دينار بيع لي مروحة سقف بسعر 25 | — | SELL | 0 | 0 |  |
| 2 | عندي منها اربع حبات | — | SELL | 0 | 0 | turn 2: draft.availableQuantity=undefined expected 4 |
| 3 | نزل السعر لـ 22 | — | SELL | 0 | 0 |  |

### H-MT-005 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | دينار بيع لي سجادة بسعر 60 | — | SELL | 0 | 0 |  |
| 2 | ابحث عن مكيف | buyerSearch | LISTING_RESULTS | 0 | 0 |  |
| 3 | خلينا نرجع للسجادة: الكمية 2 | — | ADVICE | 0 | 0 | turn 3: surface ["ADVICE"] not in SELL; turn 3: draft.availableQuantity=undefined expected 2; turn 3: draft.unitPrice=un |

### H-MT-008 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ماك | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | شو أحسن منه للبرمجة؟ | — | ADVICE | 0 | 0 |  |
| 3 | طيب حط اللينوفو بالسلة | — | CLARIFY | 0 | 0 |  |

### H-MT-009 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ايفون 13 | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | مش هاد، اللي لونه أزرق | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | ما تضيفه، بس خبرني سعره | searchListings | LISTING_RESULTS | 0 | 0 |  |

### H-MT-010 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | بدي أكل | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | منسف | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | لا مقلوبة أحسن | searchListings | LISTING_RESULTS | 0 | 0 | turn 3: result lacks lab_food_maqluba (got lab_food_mansaf) |

### H-MT-014 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن عطر | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | ضيف الأول | getResource | LISTING_RESULTS | 0 | 0 | turn 2: delta.cart=0 expected 1 |
| 3 | ادفع عني بالبطاقة المحفوظة | — | CART | 0 | 0 |  |

### H-MT-016 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن لوحة فنية | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | افتحها | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | بعرض 120 عليها | — | NEGOTIATION_REVIEW | 0 | 0 |  |

### H-MT-017 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | بدي كنبة | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | رمادية | — | SELL | 0 | 0 | turn 2: surface ["SELL"] not in LISTING_RESULTS; turn 2: result lacks lab_sofa_corner (got ) |
| 3 | لا بيج | — | SELL | 0 | 0 | turn 3: surface ["SELL"] not in LISTING_RESULTS; turn 3: result lacks lab_sofa_corner_b (got ) |

### H-MT-018 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن جوال رخيص | buyerSearch | LISTING_RESULTS | 0 | 0 |  |
| 2 | أرخص من هيك | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | خلص بدي أبيع جوالي بدل ما أشتري، سعره 80 | — | SELL | 0 | 0 |  |

### H-MT-020 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | دينار بيع لي كاميرا مراقبة بسعر 18 | — | SELL | 0 | 0 |  |
| 2 | الرقم للتواصل 0791234567 | — | SELL | 0 | 0 |  |
| 3 | لا، احذف الرقم وخليها محادثة بس | — | SELL | 0 | 0 |  |

### H-MT-024 — PASS

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | بدي هدية تحت 10 | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | للبنت | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 3 | الكوب المطبوع حلو، ضيفه | — | ADVICE | 0 | 0 |  |

### H-MT-025 — FAIL

| # | User | Tool | Card | Δ cart | Δ orders | Failure |
|---|---|---|---|---:|---:|---|
| 1 | ابحث عن ايفون 15 | searchListings | LISTING_RESULTS | 0 | 0 |  |
| 2 | المستعمل | buyerRefine | LISTING_RESULTS | 0 | 0 |  |
| 3 | كم الفرق بينه وبين الجديد؟ | searchListings | LISTING_RESULTS | 0 | 0 | turn 3: body lacks /\b140\b/ |

