# DINAR NEXT — أوامر Claude Code داخل Replit Shell

سنغيّر طريقة التنفيذ بالكامل: Claude Code سيعمل مباشرة على مشروع DINAR الأصلي داخل Replit Shell. لن نحتاج إلى Gemini One Shot أو تنزيل ZIP أو نقل الأكواد يدويًا.

سيتولى Claude قراءة المشروع، وتطوير المحركات والواجهات، وربطها، وتشغيلها، وإصلاح الأخطاء، وإجراء الاختبارات.

لكن هناك قاعدة مهمة: لا نعيد بناء DINAR من الصفر. نستفيد من كل ما بُني سابقًا، ونطوّر الأجزاء الناقصة أو الضعيفة.

## ترتيب التنفيذ

| الأمر | المهمة                             | نتيجة الإغلاق المطلوبة           |
| ----- | ---------------------------------- | -------------------------------- |
| 0     | فحص المشروع وحمايته                | خط أساس حقيقي وآمن               |
| A     | الذكاء العام والمتعدد المهام       | محادثة عامة تعمل عبر مزوّد حقيقي |
| B     | البيع والشراء والتفاوض والتوصيل    | تحسين وربط المسارات التجارية     |
| C     | التسويق والإعلانات ومساعدة الأعمال | قدرات صادقة متصلة بالبيانات      |
| D     | البطاقات التفاعلية                 | أسطح موحدة داخل المحادثة         |
| E     | التصميم والموبايل والأداء          | واجهة احترافية ومختبرة           |
| F     | الاختبارات الشاملة والإصلاحات      | أدلة قبول وتشغيل                 |
| FINAL | مراجعة نهائية وتسليم               | تقرير الحالة وCommits واضحة      |

أرسل كل أمر بمفرده إلى Claude Code، وانتظر نتيجة تنفيذه قبل إرسال التالي. لا تطلب منه تنفيذ الجميع بصورة متوازية على الملفات نفسها.

## الأمر 0 — فحص DINAR وحماية المشروع قبل التطوير

هذا الأمر إلزامي، لأنه يمنع Claude من إتلاف العمل السابق أو التعامل مع اختبارات قديمة وكأنها دليل نجاح حالي.

# DINAR NEXT — COMMAND 00

## SOURCE AUDIT, BASELINE, SAFETY AND EXECUTION PREPARATION

You are Claude Code running inside the EXISTING DINAR Replit Shell.

MISSION:\
Prepare the original DINAR application for direct, incremental, production-quality development through phases A–F.

This is a real engineering task, not a documentation-only exercise.

### 1. Identify the actual project

Inspect:

- Current directory and repository root.
- Git branch and HEAD.
- Working tree, including untracked files.
- Workspace/package manager configuration.
- Frontend application entrypoints.
- API server.
- Conversation runtime.
- Model/provider gateway.
- Shared contracts and OpenAPI.
- Database modules and migrations.
- Tests and test infrastructure.
- Relevant historical implementation reports.

Inspect current paths before assuming historic paths remain accurate.

Expected historical areas may include:\
`artifacts/dinar/`, `artifacts/api-server/`, `lib/db/`.

Treat Git and actual current files as the source of truth.

### 2. Preserve user work

Do not run destructive Git clean/reset/checkout operations.

Do not delete untracked user files.

Do not rewrite existing Git history.

Do not push to GitHub.

Preserve changes already present in the workspace.

Create a recoverable checkpoint using a safe method appropriate to the existing working tree.

If you cannot preserve all current modifications safely, STOP before changing code and explain exactly what is at risk.

### 3. Establish real capabilities

Trace actual implementation paths for:

- General-purpose conversation.
- AI model selection and tool use.
- Seller draft creation.
- Marketplace search.
- Listing publication.
- Negotiation and best-price requests.
- Buyer review and orders.
- Delivery and courier workflows.
- Advertising and promotion services.
- Business analytics and Market Pulse.
- Authentication, guest and actor scope.
- Market and currency handling.
- Typed conversation surfaces.
- Sidebar and conversation frontend.

Create a concise capability matrix:

EXISTING AND WORKING\
EXISTING BUT DEFECTIVE\
PARTIALLY IMPLEMENTED\
MISSING\
UNVERIFIABLE

Every finding must cite concrete repository files/functions/tests.

Do not infer missing functionality from missing documentation.

### 4. Map the current architecture

Document:

- Main frontend entrypoints.
- Conversation endpoints.
- Runtime orchestration flow.
- Provider boundaries.
- Canonical commercial services.
- Typed surface registries.
- Authorization boundaries.
- Integration test infrastructure.

Use a single authoritative file:

`docs/dinar-next/00-baseline.md`

### 5. Run safe baseline checks

Run the existing relevant commands for:

- Typecheck.
- Build.
- Existing conversation tests.
- Marketplace tests.
- API/schema generation consistency.
- Dependency audit.

Inspect scripts before running them.

Do not run database migrations, destructive fixtures, integration resets or financial tests against a shared/managed/production database.

Database-mutating acceptance is permitted only against a new, explicitly disposable loopback PostgreSQL test instance.

Classify skipped/unavailable tests honestly.

### 6. Freeze product decisions

These decisions are mandatory:

- One Arabic-first general AI conversation.
- Real DINAR marketplace capabilities inside that conversation.
- No separate mandatory commercial dashboard.
- No bubble architecture.
- No new cryptocurrency or wallet.
- No new subscription gating.
- Business Go/Pro postponed.
- No commission changes.
- No real payment activation.
- No invented GPS or delivery ETAs.
- No advanced courier tips.
- No independent duplicate commerce engines.
- No production deployment.

### 7. Prepare phased execution

Create:

`docs/dinar-next/IMPLEMENTATION_LEDGER.md`

For phases A–F, include:

- Existing functionality to reuse.
- Specific missing improvements.
- Planned source modifications.
- Verification commands.
- Relevant regression suites.
- Acceptance status.

Do not create new code solely to satisfy a milestone label.

### 8. Completion

When this command finishes:

- Preserve all prior work.
- Save baseline reports.
- Record executed test counts.
- Record current revision.
- Identify blockers requiring owner input.

Do not proceed automatically to Phase A.

FINAL OUTPUT:

BASELINE HEAD:\
ACTIVE BRANCH:\
WORKTREE PRESERVED:\
CAPABILITY MATRIX:\
TEST RESULTS:\
SECURITY FINDINGS:\
SAFE DEVELOPMENT CHECKPOINT:\
PHASE A ENTRY POINTS:\
BLOCKERS:\
READY FOR PHASE A: YES / NO

STOP.

## الأمر A — تطوير ذكاء DINAR العام

هذه أهم مرحلة. نريد أن يتمكن DINAR من الإجابة عن الأسئلة العامة مثل ChatGPT، مع قدرته على فهم الطلبات المتعددة والانتقال الطبيعي إلى التجارة عند الحاجة.

# DINAR NEXT — COMMAND A

## GENERAL-PURPOSE INTELLIGENCE AND UNIFIED MULTI-TASK CONVERSATION

You are Claude Code inside the existing DINAR Replit workspace.

Read:\
`docs/dinar-next/00-baseline.md`\
`docs/dinar-next/IMPLEMENTATION_LEDGER.md`

MISSION:\
Implement and verify a genuinely useful general-purpose Arabic-first AI assistant using the existing DINAR conversation runtime.

Do not build another chatbot or replace the marketplace.

### A1 — Trace the real request lifecycle

Follow a live message through:

Frontend composer\
→ API request\
→ Auth/session/market context\
→ Conversation runtime\
→ Model gateway\
→ Tool selection\
→ Model response\
→ Surface serialization\
→ UI rendering\
→ Conversation persistence/reload.

Identify exactly why general questions succeed, fail, or get incorrectly routed into marketplace tools.

Repair proven defects.

### A2 — General conversation

DINAR must answer questions about:

- Programming.
- Education.
- Renewable energy.
- Writing.
- Planning.
- General knowledge.
- Reasoning and comparisons.
- Everyday questions.

Examples:

"دينار اشرح لي الطاقة الشمسية."

"دينار اكتب لي خطابًا رسميًا."

"دينار عندي مشكلة في كود React."

"دينار علمني الإنجليزية."

Use the actual configured AI provider.

Never use hardcoded responses as a substitute for functioning general AI.

If provider access is unavailable, implement/test correct gateway wiring and clearly report the live-provider blocker.

### A3 — Conversation understanding

Support:

- Arabic formal and dialect expressions.
- Multi-turn context.
- Topic changes.
- Corrections.
- Interrupted tasks.
- References to prior selected entities.
- Multiple related user intents.
- Relevant clarification questions.

Examples:

"دينار أبي أبيع طاولة، وبعدها ابحث لي عن كرسي."

"لا قصدي الطاولة الثانية."

"جاوبني على سؤال برمجة وبعدين كمل إعلاني."

Maintain actual authorization for any resumed business action.

### A4 — Multi-task orchestration

Reuse the existing runtime.

Implement safe bounded sequencing for compound requests where supported.

Each task step must have explicit:

- Intent.
- Target resource.
- Actor/market context.
- Preconditions.
- Required confirmation.
- Execution state.
- Actual result.
- Failure/retry path.

Do not run irreversible business mutations implicitly.

Do not guarantee a fixed number of simultaneous tasks unless the actual runtime supports it.

Avoid introducing a new universal task database if current state models suffice.

### A5 — Provider reliability

Inspect actual provider registry and model availability.

Support:

- Timeout handling.
- Unavailable provider.
- Rate limiting.
- Error normalization.
- Request cancellation where applicable.
- Safe retries for read-only operations.
- No duplicate business mutation retries.
- Structured tool-result validation.

Do not hardcode speculative model IDs or unapproved external models.

### A6 — Context continuity

Fix proven problems with:

- Missing selected listing references.
- Seller draft continuation.
- Message history loading.
- Surface reload.
- Actor switch.
- Session changes.

Do not create unbounded personal memory or store private customer information in a new vector database.

### A7 — General AI versus commercial routing

Test that general questions are not forced into marketplace search.

Test that commercial requests use authorized tools.

Test that mixed requests remain coherent.

Do not insert irrelevant sponsored advertisements into general answers.

### A8 — Required acceptance

Execute actual tests for:

1. General informational question.
2. Coding help.
3. Arabic dialect.
4. Multi-turn follow-up.
5. Corrected instruction.
6. Topic switch.
7. Resume pending draft.
8. Compound general + commercial request.
9. Ambiguous reference.
10. Provider error.
11. Long conversation reload.
12. Unauthorized tool execution.
13. Market/actor switch.
14. Repeated action idempotency.
15. Unknown real-time information.

Add meaningful regression tests instead of only snapshot tests.

Use actual provider-backed verification if a valid configured provider is available.

### A9 — Close phase

Update the implementation ledger.

Run typecheck/build and affected suites.

Commit verified changes on the working branch only if the checkpoint and working tree allow safe staging of your own changes.

Never auto-commit unrelated user work.

No push or deployment.

FINAL REPORT:

ROOT CAUSES FIXED:\
FILES MODIFIED:\
GENERAL AI LIVE STATUS:\
COMPOUND INTENT STATUS:\
CONTEXT CONTINUITY:\
PROVIDER STATUS:\
TEST COUNTS:\
REGRESSIONS:\
COMMIT:\
UNRESOLVED BLOCKERS:\
READY FOR B: YES / NO

STOP.

## الأمر B — تطوير التجارة الذكية بالكامل

# DINAR NEXT — COMMAND B

## UNIVERSAL SELLING, BUYING, NEGOTIATION AND DELIVERY

You are Claude Code inside the real DINAR repository.

Read Phase 00 and Phase A outputs first.

MISSION:\
Improve and verify DINAR's existing end-to-end marketplace experience using one unified conversation.

Do not create a second commercial runtime.

### B1 — Canonical authority inspection

Trace existing services for:

- Seller draft.
- Generic listing.
- Price modes.
- Search.
- Buyer review.
- Negotiation.
- Orders.
- Payment-method availability.
- Delivery options.
- Courier state.
- Contact consent.
- Financial snapshots.

Create an implementation map showing actual source functions and APIs.

### B2 — Universal seller experience

Support natural-language selling for arbitrary permitted products and services.

Examples:

"دينار بيع لي هاتفي المستعمل."

"دينار أريد أعرض طاولة بـ20."

"دينار عندي خدمة تنظيف."

"دينار أبي أبيع ماكينة صناعية."

Required:

- Extract details already supplied.
- Ask only missing questions.
- Reuse the same canonical draft.
- Allow corrections.
- Support optional photo-first suggestions.
- Preserve general category fallback.
- Support permitted listing location and contact privacy.
- Support approved price modes.
- Show review before publication.
- Maintain continuation after interruption.

Do not infer absent asking price means free.

No silent publication.

### B3 — Buyer discovery

Improve intent-based discovery using actual listings.

Support:

- Natural-language filters.
- Product/service result cards.
- Meaningful comparison.
- Reference resolution such as "الثاني".
- Empty/no-match state.
- Market isolation.
- Listing availability.
- Real seller and product identities.

No fabricated search results.

### B4 — Negotiated commerce

Preserve immutable, append-only offers/counteroffers.

User examples:

"دينار اطلب آخر سعر."

"اعرض عليه 20."

"هو طلب 25، قل له 22."

"موافق."

Actions must be actor-authorized, scoped to the correct listing and negotiation, and protected against stale or duplicate execution.

The agreed amount must flow into the canonical buyer review and order snapshot.

Do not rewrite offer values or accept on behalf of a party without authorized confirmation.

### B5 — Order experience

Verify:

- Correct listing.
- Correct quantity.
- Correct final agreed price.
- Correct buyer/seller.
- Permitted payment method.
- Real order review.
- Explicit order confirmation.
- Idempotent order mutation.
- Honest failure and retry behavior.

Do not activate real payment providers.

### B6 — Delivery

Reuse existing:

- Buyer pickup.
- Seller delivery.
- Independent courier.
- Fare agreement.
- Delivery status progression.
- Buyer receipt confirmation.
- Existing commission policies.

Improve the conversational experience without inventing a new fleet router.

No fake tracking.

No fictional ETAs.

No unapproved courier commissions or advanced tips.

### B7 — Privacy

Public listings must not leak private contact information.

Order-bound release must follow approved consent and actor scope.

Do not expose sensitive location coordinates publicly.

### B8 — Acceptance scenarios

Test at least:

- Physical listing.
- Service listing.
- Photo-first listing.
- Existing draft correction.
- Interrupted/resumed listing.
- No-price listing.
- Negotiable listing.
- Buyer search.
- Comparison and selection.
- Best-price inquiry.
- Counteroffer sequence.
- Accepted-price order review.
- Duplicate confirmation attempt.
- Wrong actor.
- Wrong market.
- Missing delivery provider.
- Pickup.
- Seller delivery.
- Independent courier.
- Buyer receipt.

Test actual services, not only mocked frontend appearances.

### B9 — Engineering completion

Implement missing adapters and fix defects.

Add tests.

Run affected commerce, API, typecheck and build suites.

Use only disposable loopback PostgreSQL for database-mutating acceptance.

Record all actual results.

Update ledger and save recoverable checkpoint.

FINAL REPORT:

SELLER:\
BUYER:\
NEGOTIATION:\
ORDER:\
DELIVERY:\
PRIVACY:\
FILES MODIFIED:\
TEST COUNTS:\
REGRESSIONS:\
COMMIT:\
BLOCKERS:\
READY FOR C: YES / NO

STOP.

## الأمر C — التسويق الذكي والإعلانات الصادقة ومساعدة الأعمال

# DINAR NEXT — COMMAND C

## ETHICAL ADVERTISING, SALES ASSISTANCE AND BUSINESS INTELLIGENCE

You are Claude Code working directly in DINAR.

Read accepted phases 00, A and B.

MISSION:\
Make DINAR useful to sellers as an honest business and marketing assistant inside the same conversation.

No new subscriptions or paywalls.

### C1 — Review existing authorities

Trace:

- Seller inventory.
- Seller listings.
- Orders and sales summaries.
- Advertising/promotions.
- Market Pulse.
- Business membership.
- Product information and verified fields.
- Existing AI context/tools.

Do not create a parallel advertising or analytics database.

### C2 — Truthful marketing assistance

Support:

"دينار اكتب إعلانًا مقنعًا."

"دينار حسن وصف المنتج."

"دينار اكتب ثلاث صيغ مختلفة."

"دينار كيف أرد على زبون يقول غالي؟"

"دينار كيف أعرض مميزات المنتج؟"

Generate high-quality Arabic marketing content using available product facts.

Distinguish:

- Verified platform facts.
- Seller-provided claims.
- Unverified claims.
- Suggestions.

Never fabricate certification, stock, warranty, condition, ratings or discount.

### C3 — Ethical persuasion

Explain product advantages relevant to customer needs.

Never:

- Invent urgency.
- Fabricate scarcity.
- Hide known material defects.
- Invent social proof.
- Force recommendations.
- Claim guaranteed sales.
- Exploit customer vulnerability.
- Send unsolicited messages.

Offer safe truthful alternatives when asked to produce misleading advertising.

### C4 — Sponsored content

Reuse existing advertising and promotion services.

Display sponsored status clearly.

Keep organic relevance separate from commercial placement.

Allow explanation of why an ad is shown where actual targeting information permits.

Do not pretend advertising inventory exists when missing.

Do not activate external campaign spending without approval.

### C5 — Seller business assistance

Support:

"دينار أرني بضاعتي."

"كم بقي من هذا المنتج؟"

"كم طلبًا عندي؟"

"كيف أداء عروضى؟"

"اقترح كيف أحسن الإعلان."

Access only authorized seller data.

Use real aggregations and available analytics.

If data is insufficient, report that accurately.

Respect Market Pulse privacy thresholds.

### C6 — Marketing review actions

Present suggested:

- Titles.
- Descriptions.
- Reply drafts.
- FAQ content.
- Campaign ideas.
- Listing improvements.

Require seller review and canonical mutation confirmation before modifying actual published content.

No autonomous customer outreach.

### C7 — Subscriptions deferred

Do not create or activate:

- Business Go billing.
- Business Pro billing.
- Plan-specific paywalls.
- Subscription quotas.
- Upgrade pressure.
- Recurring payments.

Preserve existing approved membership rules.

### C8 — Acceptance

Test:

- Truthful ad drafting.
- Seller asks for fake stock scarcity.
- Seller requests misleading warranty.
- Product facts unavailable.
- Seller claims versus platform verification.
- Sponsored labeling.
- Organic alternative display.
- Authorized inventory query.
- Unauthorized seller query.
- Market isolation.
- Empty analytics.
- Unavailable advertising service.
- Conversation continuity.
- Editing with seller approval.

Run security and impacted regression tests.

Update the ledger and create a recoverable checkpoint.

FINAL REPORT:

MARKETING:\
ETHICAL GUARDS:\
SPONSORED CONTENT:\
BUSINESS ASSISTANCE:\
CANONICAL AUTHORITIES REUSED:\
FILES MODIFIED:\
TEST RESULTS:\
BLOCKERS:\
COMMIT:\
READY FOR D: YES / NO

STOP.

## الأمر D — البطاقات التفاعلية داخل المحادثة

# DINAR NEXT — COMMAND D

## TYPED INTERACTIVE CHAT SURFACES AND REAL ACTION BINDINGS

You are Claude Code inside the existing DINAR application.

Read phases 00–C.

MISSION:\
Make the conversation capable of displaying useful interactive content using the existing typed surface architecture.

No bubble system.

No separate business dashboard.

### D1 — Audit existing surfaces

Inspect all current typed surface definitions, registry, serializers, frontend renderers, OpenAPI declarations and persistence handlers.

Do not duplicate working surfaces.

### D2 — Required conversation experiences

Ensure appropriate coverage for:

- General answers.
- Product search results.
- Service listings.
- Product comparisons.
- Seller drafts.
- Negotiation history.
- Best-price inquiries.
- Buyer review.
- Order status.
- Delivery options.
- Courier status.
- Inventory summaries.
- Business analytics.
- Advertising draft review.
- Tutorials and guided assistance.

Reuse/extend existing types.

### D3 — Server/client consistency

For every new surface:

1. Define a canonical typed payload.
2. Validate on the server.
3. Include it in API/OpenAPI schemas.
4. Regenerate clients where appropriate.
5. Register frontend renderer.
6. Persist reconstructible state.
7. Verify response serialization.
8. Verify page reload and conversation-history hydration.

Do not repeat historical HTTP 400 schema errors caused by missing surface variants.

### D4 — Real interactions

Every button must have a real purpose.

A button that changes commercial state must:

- Have authorized actor context.
- Identify exact resource.
- Respect market.
- Show confirmation when required.
- Perform canonical action.
- Report actual success or failure.
- Avoid duplicate mutations.

No fake functional UI.

### D5 — Contextual presentation

Do not show oversized cards unnecessarily.

Use compact layout for simple information.

Use expandable detail when appropriate.

Products and services may require different fields but should use common structural primitives.

Make results readable on mobile.

### D6 — Loading/error/empty states

Cover:

- Loading.
- No results.
- Invalid/expired reference.
- Unauthorized action.
- Provider unavailable.
- Stale negotiation.
- Network failure.
- Partial success.
- Retryable read operation.

Never transform error into fake success.

### D7 — Acceptance

Test every added/modified surface for:

- Valid data.
- Invalid data rejection.
- Actor isolation.
- Server/client schema agreement.
- Original message rendering.
- Conversation reload.
- Button functionality.
- State updates.
- RTL.
- Mobile width.
- Accessibility.

Run code generation/typecheck/build and relevant API tests.

Update ledger and checkpoint.

FINAL REPORT:

SURFACES REUSED:\
SURFACES CREATED:\
SCHEMA CHANGES:\
ACTIONS CONNECTED:\
RELOAD TESTS:\
TYPECHECK:\
BUILD:\
TESTS:\
COMMIT:\
BLOCKERS:\
READY FOR E: YES / NO

STOP.

## الأمر E — التطوير البصري الشامل والموبايل والأداء

# DINAR NEXT — COMMAND E

## PREMIUM ARABIC UI, SIDEBAR, MOBILE RESPONSIVENESS AND PERFORMANCE

You are Claude Code inside the current DINAR application.

Read completed phases 00–D.

MISSION:\
Deliver a substantial, cohesive and production-quality improvement to the actual DINAR user experience.

Do not replace the app or break existing business functions.

### E1 — UI inspection

Audit real frontend code for:

- Design tokens.
- Typography.
- Light/dark themes.
- Page containers.
- Main AI screen.
- Conversation history sidebar.
- Message layout.
- Composer.
- Typed surfaces.
- Product cards.
- Mobile navigation.
- Loading/error states.

Collect objective deficiencies before editing.

### E2 — Visual direction

DINAR should look modern, premium and calm.

Requirements:

- Arabic-first RTL.
- Strong legibility.
- Balanced spacing.
- Consistent component dimensions.
- Appropriate icon sizes.
- Clear hierarchy.
- Refined borders and shadows.
- Professional light theme.
- Professional dark theme.
- Meaningful restrained animations.
- Cohesive DINAR brand identity.

Use existing design assets where appropriate.

Do not add decorative features that slow the application.

### E3 — Main conversation

Improve:

- Empty conversation state.
- Text messages.
- Long answers.
- Tables and code rendering.
- Streaming indicators.
- Reply spacing.
- Inline interactive surfaces.
- Input composer.
- Attachment preview.
- Pending actions.
- Scroll to latest.
- Scroll preservation when viewing history.

### E4 — Sidebar

Improve:

- Collapse/expand behavior.
- Search where already supported.
- Conversation selection.
- Active item state.
- Long Arabic titles.
- New conversation action.
- Mobile drawer.
- Keyboard navigation.
- Empty history state.

Do not create a second history authority.

### E5 — Mobile-first

Test exact widths:

320, 375, 390, 430, 768, 1024, 1440, 1600.

Verify:

- No horizontal overflow.
- Proper text wrapping.
- Correct mixed-direction strings.
- No overflowing cards.
- Safe-area handling.
- Keyboard does not cover composer.
- Correct scroll behavior.
- Responsive sidebar.
- Good tap targets.
- No fixed-width desktop controls on mobile.

### E6 — Performance

Investigate actual bundle and interaction costs.

Improve where measured:

- Large chunks.
- Heavy components.
- Unnecessary renders.
- Media decoding.
- Lazy loading.
- Unused dependencies.
- Long lists.
- Expensive animations.
- Layout shifts.

Use safe incremental optimizations.

Report baseline and final build outputs.

### E7 — Accessibility

Support:

- Screen reader labels.
- Focus visibility.
- Logical keyboard traversal.
- Suitable contrast.
- Reduced-motion preferences.
- Accessible error messages.

### E8 — Visual verification

Run actual browser verification where supported.

Capture evidence of:

- New empty chat.
- General AI answer.
- Search cards.
- Seller draft.
- Negotiation.
- Delivery.
- Business assistance.
- Long conversation.
- Mobile sidebar.
- Light/dark themes.

If browser tooling is unavailable, report that limitation rather than claiming visual testing.

### E9 — Completion

Run typecheck/build and affected interaction tests.

Fix regressions.

Update ledger and checkpoint.

FINAL REPORT:

VISUAL CHANGES:\
MOBILE RESULTS:\
SIDEBAR RESULTS:\
COMPOSER RESULTS:\
PERFORMANCE BEFORE/AFTER:\
ACCESSIBILITY:\
BROWSER EVIDENCE:\
FILES MODIFIED:\
TEST RESULTS:\
COMMIT:\
BLOCKERS:\
READY FOR F: YES / NO

STOP.

## الأمر F — الاختبارات الشاملة والتشغيل وإصلاح الأخطاء

# DINAR NEXT — COMMAND F

## END-TO-END ACCEPTANCE, REGRESSIONS, BUG FIXING AND DEVELOPMENT RUNTIME

You are Claude Code inside the original DINAR Replit workspace.

Read completed phases 00–E and their checkpoints.

MISSION:\
Verify the complete DINAR NEXT experience and fix actual integration defects.

Do not stop at reporting failed tests if the defects can be repaired safely.

### F1 — Source consistency

Inspect:

- Final Git status.
- Source files changed by phases A–E.
- Package manifests.
- Backend/frontend type contracts.
- OpenAPI-generated clients.
- Database/migration compatibility.
- Environment configuration.
- Runtime start scripts.
- Existing tests.

Ensure that no duplicate commercial authority was introduced.

### F2 — Full verification

Execute relevant actual commands for:

- Frozen-lockfile dependency installation where appropriate.
- Typecheck.
- Frontend build.
- API build.
- OpenAPI generation/check.
- Conversation tests.
- Model gateway tests.
- Seller draft tests.
- Search tests.
- Negotiation tests.
- Order tests.
- Delivery tests.
- Contact privacy tests.
- Market/actor isolation tests.
- Business/advertising tests.
- Typed surface tests.
- Dependency/security audits.

Use actual repo-supported commands.

Do not invent pass counts.

### F3 — Database safety

Never execute destructive tests against shared Replit, Railway, external managed or production PostgreSQL.

Database-mutating tests must use an isolated disposable loopback PostgreSQL instance with verified connection identity.

If such an environment is unavailable, mark the corresponding tests BLOCKED, not PASS.

### F4 — Browser journeys

Verify authenticated, real-browser workflows where supported:

1. General-purpose question.
2. General follow-up.
3. Seller listing draft.
4. Draft correction.
5. Draft resume after interruption.
6. Marketplace search.
7. Listing comparison.
8. Negotiation offer.
9. Counteroffer.
10. Accepted-price buyer review.
11. Delivery selection.
12. Buyer receipt workflow.
13. Business inventory.
14. Honest marketing content.
15. Sponsored-ad disclosure.
16. Unauthorized action rejection.
17. Conversation reload.
18. Mobile layout.

Do not manufacture successful test evidence through mocks.

### F5 — Reliability

Test:

- Provider unavailable.
- Network failure.
- Rate limit.
- Duplicate message submission.
- Stale offer.
- Unauthorized actor.
- Market switch.
- Invalid surface payload.
- Expired reference.
- No search results.
- Invalid order state.
- Missing tracking provider.

### F6 — Fix discovered defects

For each reproducible defect:

TRACE → ROOT CAUSE → MINIMAL SAFE FIX → TARGETED TEST → REGRESSION.

Preserve canonical business policies.

Do not mask errors with fake success.

### F7 — Run development application

Start DINAR using the actual Replit-supported development commands.

Verify:

- Frontend accessible.
- API running.
- Conversation route accessible.
- Actual model response when a provider is configured.
- Frontend/backend integration.
- No persistent fatal runtime errors.

Development execution does not authorize production deployment.

### F8 — Security

Check:

- Authentication.
- Authorization.
- Sensitive data.
- Source credentials.
- Dependency risks.
- Unexpected outbound calls.
- Client-side business-authority bypasses.
- Unsafe logging.

If HoundDog remains unavailable due to schema mismatch, report it as unavailable and use supported independent checks; do not claim HoundDog passed.

### F9 — Final acceptance report

Create:

`docs/dinar-next/FINAL_ACCEPTANCE.md`

Report:

- Commands executed.
- Real test results.
- Failed/skipped/blocked counts.
- Browser evidence.
- Source revisions.
- Known limitations.
- Unfinished integrations.
- Runtime status.

Update the implementation ledger.

Commit own verified changes safely.

No GitHub push.

No deployment.

FINAL RESULT:

A STATUS:\
B STATUS:\
C STATUS:\
D STATUS:\
E STATUS:\
F STATUS:

GENERAL AI LIVE:\
MARKETPLACE LIVE:\
NEGOTIATION LIVE:\
DELIVERY LIVE:\
BUSINESS AI LIVE:\
INLINE SURFACES:\
MOBILE RTL:\
BROWSER:\
TYPECHECK:\
BUILD:\
SECURITY:\
UNRESOLVED BLOCKERS:\
FINAL HEAD:\
READY FOR OWNER REVIEW: YES / NO

STOP.

## الأمر FINAL — المراجعة النهائية وإغلاق العمل

يُرسل هذا الأمر فقط بعد أن ينتهي Claude من A–F ويشغّل المشروع. هدفه التأكد من عدم وجود أجزاء مفقودة أو نجاحات شكلية.

# DINAR NEXT — FINAL ENGINEERING CLOSURE

## VERIFY THE COMPLETE A–F IMPLEMENTATION

Review the entire DINAR NEXT development work completed in commands 00 and A–F.

Do not restart implementation or rewrite working systems.

### 1. Verify actual delivery

Check that:

- The original DINAR application remains intact.
- General AI uses the configured model gateway.
- Existing marketplace engines are reused.
- Selling and buying work through conversation.
- Negotiation remains canonically authorized.
- Delivery uses real supported services.
- Business/marketing AI is truthful.
- Interactive cards are genuinely connected.
- Arabic RTL and mobile layout are polished.
- Existing financial and privacy rules are preserved.
- No subscription paywall was introduced.
- No production payment was activated.

### 2. Check all reports against source

Compare `IMPLEMENTATION_LEDGER.md` and `FINAL_ACCEPTANCE.md` with the actual code, current revision and executed tests.

Find any unsupported claims of completion.

Correct them.

Do not mark a phase verified unless its acceptance criteria have actually been executed and passed.

### 3. Resolve remaining safe defects

If remaining defects can be fixed without:

- New external credentials.
- Product-policy changes.
- Destructive data changes.
- Production deployment.
- Real-money activation.

Then implement and test those fixes.

### 4. Commit hygiene

Ensure commits contain only intended source changes.

Preserve unrelated work.

Do not push to GitHub.

Do not deploy.

### 5. Final answer to the owner

Explain in clear Arabic:

1. What DINAR can now do.
2. What actually changed.
3. What was already working before this work.
4. What remains incomplete.
5. What requires external integrations.
6. What tests were executed and passed.
7. Whether the real application runs successfully in Replit development.
8. The final Git revision.
9. The remaining risks.
10. The next recommended engineering task, if any.

Use evidence rather than optimistic conclusions.

FINAL VERDICT:

VERIFIED-CLOSED\
PARTIALLY VERIFIED\
BLOCKED

STOP.

## طريقة تشغيل Claude داخل Replit Shell

إذا كان Claude Code مثبتًا ومهيأً للمصادقة في Shell، يمكنك الدخول إلى مجلد مشروع DINAR ثم تشغيله:

```
pwd
git status --short --branch
claude
```

تأكد أن `pwd` يشير إلى مشروع DINAR الصحيح. بعدها أرسل الأمر 0 إلى Claude، وانتظر تقريره قبل إرسال A.

إذا لم يكن الأمر `claude` متاحًا، فلا تثبّت نسخة عشوائية أو تضع مفتاح API في سطر الأوامر؛ نتحقق أولًا من طريقة تشغيل Claude Code المناسبة لبيئة Replit.

ترتيبنا النهائي:

`00 → A → B → C → D → E → F → FINAL`

بعد كل مرحلة، أرسل لي تقرير Claude إن أردت مراجعته قبل الانتقال إلى المرحلة التالية. بهذه الطريقة نمنع التكرار، ونكشف أي تعارض بين التطوير الجديد ومحركات DINAR الأصلية قبل أن يتراكم.