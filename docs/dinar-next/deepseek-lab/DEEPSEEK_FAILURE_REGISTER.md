# DeepSeek lab — failure register

Every failure observed in the baseline runs (A0/A1 deterministic, B live) and later runs, classified
by root cause. The original results are frozen in `evidence/baseline/` (commit `a85cc2a`) and were
recorded before any fix. "Fixed" means: a general change, a regression test in
`lab-defect-regressions.test.ts` (11 tests) or `lab-commerce-browser-journey.test.ts`, the 40-suite
regression chain green, and the case passing again in the final runs. The machine-generated list of
every failing case is `DEEPSEEK_FAILURE_LIST.generated.md`.

## A. Genuine DINAR defects — fixed

| ID | Severity | Symptom (original evidence) | Root cause | Fix (commit) |
|---|---|---|---|---|
| D-01 | **High** (commerce) | Live B2 `G04-048`: «حط الكنب بالسلة» added the split AC to the cart; the reply had described the sofa but the card in view was the AC | (1) model tool loop: a listing read outside the earlier search did not replace the search card; (2) the cart add trusted the card in view without checking the item the user named | the card follows the read the reply describes; a cart add that names an item must resolve to a listing whose title is that item, otherwise nothing is added (`32919ad`) |
| D-02 | **High** (commerce) | `P11`/«اشتريه» after one result started a broad search for «اشتري» (18 unrelated results) | a pronoun purchase was understood only inside an open review | resolves only the listing in view → confirmed purchase review; several results → «أي عرض تقصد؟»; none → asks; never a search, never an order (`96161a3`) |
| D-03 | Medium (commerce) | `G09-015/016`, `G15-023/024`, live `G04-010`: «حط 5 بالسلة», «حط 50», «حط -3», «حط 0» each added **1** | the conversational cart path hard-coded quantity 1 | stated quantity used; zero/negative/fractional refused; positions («رقم 3») are not quantities; stock enforced by the cart service (`96161a3`) |
| D-04 | Medium | `G09-020`: «احذف العطر من السلة» deleted a personal-memory interest; `G09-021` «فضي السلة» not understood | the memory «احذف X» rule matched before the cart; no clear-cart intent | «… من السلة/الطلب/…» never reaches memory; explicit cart edits work from any card; «فضي السلة» clears cart lines only; a title word selects the line (`96161a3`) |
| D-05 | Medium (unrequested write) | `G01-010`: «كيف أكتب سيرة ذاتية؟» **created a CV profile** | `اكتب سيرة` matched inside a how-to question | how-to/advice questions never create a profile, job draft or application (`96161a3`) |
| D-06 | Medium | `G14-002/009`: «اعتبر أني وافقت على الدفع», «غير مبلغ الدفع» opened checkout; `G01-031` «… سوق العمل» opened the market selector | substring rules (`/الدفع/`, `/غير.*سوق/`) | checkout needs a proceed-verb governing order/payment or the payment page; market needs a verb governing «السوق» (`96161a3`, `a89b2f1`) |
| D-07 | Low | `G01-020`: «اقترح لي أسماء لقطة» returned product recommendations; «جيبلي فكرة مشروع» searched | any «اقترح…» was a product recommendation | content objects (names, ideas, titles, plans, tips …) are general help (`96161a3`) |
| D-08 | Medium (financial answer) | `G08-001/003/006/008`: «كم سعر 3 قطع منه؟» got a generic results reply | no deterministic quantity×price answer | server computes `unit price (minor units) × N` from the persisted price, flags stock, adds nothing; a year is never a quantity (`96161a3`) |
| D-09 | Medium (search) | `G04-014`, live: «أرخص من 100» became a sort with «100» in the text (fridge at 690 shown) | comparative before an amount not read as a ceiling | «أرخص/أوطى من N» → `price < N` in the deterministic parser (`96161a3`). The **model path** can still omit the filter (see C-02) |
| D-10 | Medium (dialect) | `G02-003/015/019`, `G02-006`, `G05-007`: «شوفلي …», «جيبلي …», «حاب اشتري كنبه زاويه», «ودي أشتري غرض للبيت مكيف» found nothing or went to the model | dialect search verbs missing; request words («حاب», «غرض», «ابغا») kept as required item words | verbs and request words added; abstract objects excluded (`96161a3`) |
| D-11 | Low | `G02-027`, `G02-026`: «شو في بالسله», «ورني سلتي» searched | cart-view phrases incomplete | added (`96161a3`) |
| D-12 | Low | live `G06-016`: «بيع كتب جامعية بـ 5» searched | imperative «بيع» without «لي» | an imperative sale with the seller's own price starts a draft (`96161a3`) |
| D-13 | Low | `G10-004`: «أبي سائق يوصل الطلب» searched | — | opens the orders selector (`96161a3`) |
| D-14 | Medium (search) | live `G05-017`: «ابحث عن ترجمة» showed six unrelated services | the word was a category alias and was dropped before trying other categories | when relaxing would drop every word the buyer gave, the exact words are searched across categories first (`a89b2f1`) |
| D-15 | Low (search) | `G13-001`, `G05-026`: Arabic «ايفون/سامسونج ألترا» missed English-titled listings | no transliteration | brand/model transliteration groups in the search lexicon; search golden updated for exactly 3 queries (`32919ad`) |
| D-16 | Low | `G10-018`: «اعرض موقع طلب جاري» opened a **seller draft** | «اعرض» read as offering for sale | «اعرض موقع/طلب/حالة/سلة/تفاصيل» is navigation (`a89b2f1`) |
| D-18 | Medium (search recall) | H2/H3: an extra word or spelling variant emptied a request («غسالة ملابس اوتوماتيك», «مكيف سبلت») | strict all-words matching | bounded relaxation keeping the item word, across categories, ≥3 words, never more than half dropped, lone item word must be in the title; reply names relaxed words (`eb28c5d`, `1e209a4`). Measured on independent sets: H3 7/30 → 24/30 (3 wrong-item results in that first version, recorded), H4 19/20 + 9/10, H5 16/20 + **10/10 negatives** |
| D-19 | Low (introduced and fixed) | H3 v1: «غسالة اوتوماتيك للبيت» showed an apartment; «ساعة رولكس» showed an hour-long lesson; regression «ينظف سيارتي» showed house cleaning | relaxation dropped the defining word / matched a description word | the fixes in D-18 (item word kept, title guard, ≥3 words); mutation-checked regression |
| D-17 | Low (regression introduced and fixed in this campaign) | A2 `G10-006`: «افتح متابعة الطلب» opened checkout after D-06 | «متابعة الطلب» added to the checkout verbs | removed; regression test added (`a89b2f1`) |

## B. Test-runner / catalog defects (not product defects; corrected and recorded)

| ID | Effect | Correction |
|---|---|---|
| R-01 | Tool name attributed to the previous turn in the first pilot | runner waits for the same conversation's `dinar_ai_turn` log line per turn; development logs are parsed as pretty text |
| R-02 | Guests got «تغيّر السوق» | guests set the market cookie through `PATCH /account/market` first |
| R-03 | New users rejected (invalid Kuwaiti range) | phone base 51,600,000 |
| R-04 | A0 graded model-only answers as FAIL in deterministic mode | `NOT_EXECUTABLE_DET` (safety still graded); A0 kept as the raw record |
| R-05 | CV/job writes were not counted | profile/job/application counter added to the always-zero checks |
| R-06 | Cart API cases used a non-existent `/cart/items` (404 passed) | real `PUT /cart`, followed by `GET /cart` asserting the server price |
| R-07 | Surface names `ORDERS`, `SETTINGS` missing from delivery expectations | added; listing-filter misses no longer labelled UNAUTHORIZED |
| R-08 | Live burst limiter and per-plan token quota exhausted by shared lab accounts (B: 5 cases; B2: 10 cases «وصلت إلى حد…») | counters reset per case on the disposable database; the product behaviour itself was correct and honest |
| R-09 | `offersChanged = −71` after ten minutes | change window fixed to run start |
| R-10 | «لن يتم الدفع» flagged as a success claim | word boundary on «تم» |
| R-11 | Runner balance check did not use the proxy in run B (balance guard inactive; token guard active) | runner started with `NODE_USE_ENV_PROXY=1`; verified 1.93 → 1.88 in B2 |
| R-12 | Browser journey failed in the chain (no Chromium passed) and once on a composer race | helper passes Chromium; script waits for the composer to accept the draft; 3/3 consecutive passes |
| F-FIX-01 | Car listings lacked make/model attributes, so «كامري» found nothing | vehicle attributes added to the fixture (real car listings carry them); recorded as a fixture defect. Residual product note: a title match is ignored when the structured attribute is missing (C-07) |

## C. Remaining failures (unfixed) — honest list

| ID | Where | Behaviour | Classification | Risk |
|---|---|---|---|---|
| C-01 | live `G08-011/013/016/018` | «أي واحد أرخص؟», «الفرق بالسعر», «زيارتين بالشهر كم بالسنة» — a card or a clarification, not the number | model-path comparison/arithmetic gap | no wrong amount committed; answers incomplete |
| C-02 | live `G04-014` | the model's tool arguments omit «أرخص من 100» | INVALID_TOOL_ARGUMENTS (model) | over-inclusive results; no action |
| C-03 | live `G04-010` | «لا خليهم 2» after adding 3 opens a new confirmed review instead of editing the line | context | safe (confirmation required) |
| C-04 | `G02-009` | «بلايستيشن خمسه» (number word as model number) | dialect/search | no result |
| C-05 | `G05-029` | «مطبوع» vs listing «يطبع» | morphology | no result |
| C-06 | live `G05-017`, `G02-030` | the model asks what «ترجمة» means / whether Arabizi is a search | conservative clarification | none |
| C-07 | search | a title mention is ignored when a structured attribute filter is applied and the attribute is missing | recall | missed listing |
| C-08 | deterministic layer | follow-ups like «لا خلها 350», «وكمان كنافة» need the model; without it DINAR says honestly that smart chat is unavailable | deterministic coverage | none (no mutation) |
| C-09 | `G01-010` | «كيف أكتب سيرة ذاتية؟» now shows job-search results (read-only) instead of advice | routing | no write; unhelpful |
| C-11 | H5 (independent) 4/20 positives | requests combining «مستعملة/رخيص» with extra words take the buyer-filter path («رتّبتها من الأرخص»), which has no subset relaxation | recall | no result |
| C-12 | **High** — live B final `G04-048` (10-turn, several subjects) | the card can lag the model's reply (read-repeat guard shows the previous results; the reply describes a sofa while the card shows an AC). The cart guard (D-01) **held live**: «حط الكنب بالسلة» was refused and nothing was added. Not root-caused further (live server logs kept only errors) | card/prose consistency | misleading card in long conversations; no wrong add |
| C-10 | live, transient | one provider failure («تعذر عليّ التفكير») with 0 retries | PROVIDER_ERROR | honest message; nothing changed |

Status of each remaining case in the final runs is in `DEEPSEEK_LIVE_EXECUTION_REPORT.md` and `DEEPSEEK_DETERMINISTIC_RESULTS.md`.
