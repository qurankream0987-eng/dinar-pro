# JassimAI legal documents — product-behaviour review (2026-11-13)

Scope: the published registry in `artifacts/api-server/src/lib/policies.ts` (terms 2026-10-02,
privacy 2026-11-13, marketplace-rules, prohibited-items, fees, sponsored-listings, disputes-refunds,
account-deletion — all 2026-10-02) compared with what the product actually does on
`claude/jassimai-responsive-ui-consent`. **No published text was changed by this review.** Proposed
wording below is a draft for a qualified Jordanian lawyer; nothing here is legal advice, and no
corporate identity, registration number, address or jurisdiction is invented.

## 1. What the documents already state correctly

- Terms and privacy both say they await legal review for the launch country (honest status).
- Payment: "paid directly between buyer and seller; JassimAI does not collect or transfer money"
  — matches the product (payments are simulation-only; no card data stored).
- Privacy: AI conversations are stored, a limited context is sent to an AI provider acting for us,
  cross-conversation memory is **off by default** and user-controlled — matches the code.
- Google sign-in: only openid/email/profile; the Google identifier is not sent to AI providers —
  matches the implementation.
- Cookies: only necessary cookies (session, 10-minute Google ticket) — matches.
- Data rights: view/export/correct/delete from the account; transaction and safety records retained
  — matches the account-deletion flow.

## 2. Gaps between the documents and the product (action needed)

| # | Topic | Product reality | Gap | Proposed handling |
|---|---|---|---|---|
| G1 | **AI-generated answers** | Jassim answers general questions, drafts listings, summarises, may read a page the user links (flag-gated) | Terms have no clause on AI output accuracy or limits | Add «إجابات جاسم» clause (draft A) |
| G2 | **Age** | No age gate at signup | No minimum age stated | Lawyer to set the age; add clause and signup notice (draft B) |
| G3 | **User uploads** | Private chat photos and videos (videos kept 7 days, never sent to a model); visual-search photos; listing photos (public once published) | Privacy mentions photos only for listings | Add uploads paragraph (draft C) |
| G4 | **Controller identity & contact** | None published | Privacy says owner identity and privacy email "will be added" | **Blocker for public launch** under Jordan PDPL (Law No. 24 of 2023): the controller's identity and a contact channel must be stated; lawyer to confirm the DPO question |
| G5 | **Cross-border transfer** | AI, SMS, hosting and storage providers may process data outside Jordan | Not mentioned | Lawyer to assess PDPL transfer conditions; add a transfer paragraph naming provider categories and safeguards |
| G6 | **Retention periods** | Videos 7 days; other periods not fixed | "pending legal review" | Lawyer to fix periods per record type |
| G7 | **Liability & governing law** | — | No liability or governing-law clause | Must be drafted by counsel; must not claim zero responsibility |
| G8 | **Complaints** | Order problems via the order; no general complaint channel | Not stated | Add a complaints paragraph once G4's contact exists |
| G9 | **Consent model** | Signup: explicit, unchecked acknowledgement; append-only record with policy version, content SHA-256, channel and server time; memory is a separate opt-in | Privacy does not explain the legal basis per purpose | Lawyer to map each purpose to a PDPL basis; keep optional purposes (memory, any future marketing, any training) as separate opt-ins |
| G10 | **Model training** | JassimAI does not train models on user data | Not stated; AI providers' own retention/training terms differ per provider | Add draft D only after confirming each configured provider's no-training terms (e.g. via OpenRouter provider data policies) |

## 3. Draft wording (for counsel; not applied)

- **A — إجابات جاسم:** «جاسم مساعد يعتمد على نماذج ذكاء اصطناعي، وقد تكون إجاباته غير دقيقة أو غير مكتملة. لا تُعد إجاباته استشارة طبية أو قانونية أو مالية، وتحقق من المعلومات المهمة من مصادرها. لا ينفّذ جاسم أي شراء أو دفع أو نشر إلا بعد مراجعتك وتأكيدك، وتبقى قرارات البيع والشراء مسؤوليتك.»
- **B — العمر:** «يجب أن يكون عمرك [السن الذي يحدده المستشار القانوني] سنة على الأقل لإنشاء حساب.»
- **C — الملفات المرفوعة:** «الصور والفيديوهات التي ترفقها في المحادثة خاصة بحسابك ولا تُنشر. تُحذف فيديوهات المحادثة بعد سبعة أيام ولا تُرسل إلى نماذج الذكاء الاصطناعي. صور العروض تصبح عامة عند نشر العرض.»
- **D — التدريب:** «لا نستخدم محادثاتك أو ملفاتك لتدريب نماذج الذكاء الاصطناعي.»

## 4. Consent design implemented on this branch

- One acknowledgement for every signup method, unchecked: «أقر بأنني قرأت وأوافق على شروط الاستخدام،
  وأؤكد اطلاعي على سياسة الخصوصية» — terms accepted, privacy acknowledged as a notice.
- Server-side and canonical: `/auth/register` and `/auth/google/complete` both require
  `acceptTerms: true`; Google authentication alone creates nothing (tested).
- Record (`policy_consent_events`, append-only, unique per user + key): user id, policy key,
  version, content SHA-256, decision, source SIGNUP, channel in the key
  (`signup:phone|google:<policy>:<version>`), database timestamp. No password, token or Google
  identifier in the record. Retries are idempotent; linking Google to an existing account records no
  new consent (tested). Existing users are never backfilled.
- Material updates reuse the existing policy-review flow (`POLICY_REVIEW` source).
- Optional choices are not bundled: cross-conversation memory stays off; no marketing messages exist
  today; no training use.
- Follow-up (needs a reviewed migration): promote the channel and add a locale column; record
  per-purpose optional consents if marketing is ever introduced.
