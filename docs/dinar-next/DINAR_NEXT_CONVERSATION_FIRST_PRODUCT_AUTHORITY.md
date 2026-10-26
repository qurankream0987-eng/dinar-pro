# DINAR NEXT — CONVERSATION-FIRST PRODUCT AUTHORITY
## Mandatory addition to G0, G1, G2 and G3

You are Claude Code inside the original DINAR Replit repository.

This directive adds a mandatory product and integration requirement to the G0–G3 implementation program.

## CORE PRODUCT RULE

THE CONVERSATION IS THE PRIMARY INTERFACE FOR EVERY DINAR CAPABILITY.

Users should be able to discover, inspect, manage and execute authorized DINAR services by speaking naturally to DINAR, without needing to navigate a conventional application dashboard.

Retain supporting pages where technically or legally necessary, but never make them the only way to perform a capability intended for conversational access.

Do not create a second conversational runtime.

Do not introduce domain-specific agents or branches merely to support each example.

Reuse the existing canonical services, actor scope, typed surfaces and tool gateway.

## REQUIRED CONVERSATIONAL CAPABILITIES

### A — Subscription discovery and management

Examples:

"دينار أريد أن أشترك."
"دينار اعرض الباقات."
"دينار ما الفرق بين المجاني وGo وPro؟"
"دينار كم سعر برو؟"
"دينار أريد ترقية حسابي."
"دينار متى ينتهي اشتراكي؟"
"دينار أريد إلغاء التجديد."

Required:

- Retrieve current approved plans and prices from authoritative configuration.
- Display typed interactive plan comparison surfaces.
- Show the user's genuine current entitlement.
- Present actual plan allowances.
- Explain restrictions and renewal terms.
- Present a confirmation review before any subscription mutation.
- Connect approved mutations to the canonical subscription authority.
- Require verified provider billing confirmation for paid activation.
- If billing is not connected, show a genuine unavailable/pending state; do not fake successful payment or subscription activation.
- Support cancellation only if an authorized canonical path exists.

No hardcoded invented prices.

No unapproved billing activation.

### B — Usage information

Examples:

"دينار كم نسبة استهلاكي؟"
"دينار كم باقي لي من المحادثات؟"
"دينار متى تتجدد حصتي؟"
"دينار لماذا توقف الذكاء عندي؟"

Required:

- Retrieve actual server-side usage accounting.
- Report current plan, consumed allowance, remaining allowance and renewal boundary.
- Show a compact progress card.
- Distinguish request allowance, token usage and monetary cost.
- Do not expose private provider costs or other users' data to unauthorized users.
- Do not invent percentages when authoritative data is absent.
- Permit the user to read their remaining allowance even after AI usage exhaustion.

### C — Seller statistics and commercial analytics

Examples:

"دينار أعطني إحصائيات مبيعاتي."
"دينار كم بعت هذا الشهر؟"
"دينار كم طلب مكتمل عندي؟"
"دينار ما أكثر منتجاتي طلبًا؟"
"دينار قارن مبيعات الشهر الحالي بالشهر السابق."
"دينار اقترح كيف أزيد مبيعاتي."

Required:

- Query existing authoritative seller/order/listing/analytics services.
- Enforce seller identity and market scope.
- Make time periods explicit.
- Distinguish orders, completed sales, gross transaction value, paid amounts, refunds and actual recognized revenue.
- Never label unpaid orders as received money.
- Render typed statistic cards, small charts and comparisons inside the conversation.
- Use AI only for interpretations or recommendations where needed.
- Never fabricate analytics from absent records.

### D — Business operations

Examples:

"دينار أرني مخزوني."
"دينار عدل وصف هذا المنتج."
"دينار أوقف إعلاني."
"دينار روّج للمنتج."
"دينار أظهر لي طلباتي."
"دينار ماذا رد المشتري؟"

Required:

- Resolve the correct authorized resource.
- Use canonical real services.
- Show appropriate inline controls.
- Ask confirmation for changes where necessary.
- Keep financial actions and promotion spending behind explicit approval.
- Provide truthful success/failure.

### E — General account operations

Examples:

"دينار أرني معلومات حسابي."
"دينار غيّر إعداداتي."
"دينار سجلني خروج."
"دينار كيف أحمي حسابي؟"

Required:

- Present authorized account information.
- Support existing trusted account actions.
- Reuse current security and authentication flows.
- Never send passwords, secrets or sensitive tokens to the model.
- Never claim an action succeeded until the server confirms it.

### F — Buyer–seller communication

Examples:

"دينار اسأل البائع هل عنده 50 قطعة."
"دينار أرسل له هذا السؤال."
"دينار ماذا رد البائع؟"
"دينار اسأل المشتري متى يناسبه التسليم."

Required:

- Use genuine marketplace communication.
- Preserve buyer/seller attribution.
- Work asynchronously.
- Protect privacy and actor scope.
- Show draft, confirmation, submitted, replied and failed states inline.
- Distinguish ordinary inquiries from price negotiation.
- Keep basic authorized communication functional when AI allowance is exhausted.

## UNIVERSAL CONVERSATION CONTRACT

For each capability:

1. Understand the intent and relevant conversation context.
2. Resolve actor, market and resource.
3. Verify authorization.
4. Read real canonical state.
5. Produce an appropriate typed conversational response.
6. For mutations, require proper approval and execute the existing trusted action.
7. Persist the result and restore it correctly after conversation reload.
8. Record actual errors rather than creating simulated success.

Do not create hardcoded answer branches for the provided example phrases.

The examples are acceptance tests of the general architecture, not a closed list of recognized commands.

## EFFICIENCY AND COST

- Do not call paid AI models for deterministic, already-resolved account/status/usage queries unnecessarily.
- Use the existing conversation runtime to decide when model reasoning is required.
- Preserve multi-turn context and natural language understanding.
- Do not degrade AI quality merely to reduce token consumption.
- Apply global budgets, per-account usage quotas and request idempotency.
- Core marketplace actions must not require a paid AI allowance.

## REQUIRED ACCEPTANCE

Test using real typed interactions inside the DINAR conversation:

1. View plans.
2. View approved prices or explain that pricing is unconfigured.
3. View current entitlement.
4. View genuine usage percentage.
5. View renewal date.
6. Reach AI quota and still query usage.
7. Seller asks for this month's order statistics.
8. Seller compares two periods.
9. Unauthorized user attempts to read seller analytics.
10. Seller views inventory.
11. Seller modifies an advertisement with confirmation.
12. Buyer asks seller a question and receives a real attributed reply.
13. Conversation reload restores the interactive content.
14. Mobile layout and RTL.
15. Provider unavailable.
16. Billing not configured — no fake activation.
17. Failed commercial action — no fake success.
18. Regular marketplace operations remain accessible after AI quota exhaustion.

## DELIVERY

Treat this as a mandatory cross-cutting requirement for G0–G3.

Implement against the actual existing DINAR source.

Update the integration map and acceptance tests.

Preserve the original G0–G3 functional requirements.

Do not deploy or enable real-money billing.

Do not stop after documentation alone; complete the authorized safe engineering work and verify it.

Report functionality that is live, development-only, unavailable or externally blocked with evidence.