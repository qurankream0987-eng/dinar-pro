# Full user journey matrix

Tested application and canonical acceptance source: `5121c9198ca80fb0cb02be4ef168b396d8aa12c0`. Local branch `codex/dinar-next-functional-audit`; preserved published foundation `ab196c55964ed42947d07a88dcd7f2e5f66ccfa0`. A later documentation/evidence-only delivery SHA must be identified separately; these results are not retroactively assigned to it.

Fresh immutable-source qualification: **350/350 groups PASS** (175 on PostgreSQL16,175 on18), **3548 passing case executions**,0failed cases,2 explicitly skipped development-TLS remote checks,0outbound attempts. All17 program phases and10 additional UI groups passed. These are local deterministic contracts and actual Chromium/API/disposable-database journeys, not live-provider or production approval.

The complete14-field behavior/authority/receipt/failure matrix is maintained once in [feature inventory](CODEX_COMPLETE_FEATURE_INVENTORY.md). Machine-readable rows: [feature traces](evidence/functional-audit/final/feature-traces.json). A grouped scenario is not proof of every static button or live variant.

**AUTH — Registration, verified login/logout and sessions (PASS_E2E)**

Register/phone challenge/terms submit; actual profile avatar and password controls. Terms and registration submit; explicit password change. Expected: 201 registered;200 identity/profile/password;202 local phone challenge. Rejection/recovery: Invalid browser form sends0writes; wrong password400; expired protected session401. API/DB evidence: experience-upgrade-acceptance.test, phase1-acceptance.test on each PostgreSQL version. Browser: experience-upgrade-acceptance.test; supplemental account-ui: actual production-built signup/profile/avatar/password on bothPGs. Boundary: Production-built local signup/profile/avatar/password transport repeated on final source; live SMS/storage provider separately blocked.

**IDENTITY — Same-owner drafts, cross-account reset and failure retry (PASS_E2E)**

Settings form, private dialog and explicit session retry. Read-only identity revalidation; no action replay. Expected: Only verified owner visible; failed reads keep mask. Rejection/recovery: 503 holds private fields; retry revalidates; B gets new private subtree. API/DB evidence: experience-upgrade-acceptance.test on each PostgreSQL version. Browser: experience-upgrade-acceptance.test. Boundary: Additional protected feature forms need coverage beyond the verified settings form.

**SEARCH — Authoritative Arabic discovery and filters (PASS_E2E)**

Header search and conversation send; refinements. Explicit send; refinements only read. Expected: Server-owned result IDs and grounded attributes. Rejection/recovery: Unknown/empty results truthful; no invented matching or broadened criteria. API/DB evidence: search-sql-foundation.test, arabic-generality.test, experience-upgrade-acceptance.test on each PostgreSQL version. Browser: experience-upgrade-acceptance.test. Boundary: Fresh100k benchmark measured separately; historical fixed-cursor heap/transaction-snapshot equivalence unproved, no owner SLO established.

**SELL — Draft, review, publish and listing management (PASS_E2E)**

Existing conversation publication review and seller listing editor. Explicit publish/save; no write on open/edit/cancel. Expected: Backend published/updated receipt; independently persisted listing. Rejection/recovery: Stale same-version saves409; replay409; invalid400; stranger404; draft retained until explicit reload. API/DB evidence: sc01-browser-journey.test, g3-ui.test, command-f-journeys.test, listing-edit-snapshot.test, experience-upgrade-acceptance.test on each PostgreSQL version. Browser: sc01-browser-journey.test; g3-ui.test; experience-upgrade-acceptance.test. Boundary: Concurrent editor regression fixed: one same-version save200, stale/repeated saves409; explicit reload discards draft only after user chooses; no audit migration.

**CART — Persistent canonical basket and actor-bound queued writes (PASS_E2E)**

Card add button; basket icon; canonical quantity/remove controls. User add/change/remove; checkout separate. Expected: Acknowledged persisted canonical cart; animation only after success. Rejection/recovery: Actor precondition409; failed write shows retry; no B cart mutation from queued A. API/DB evidence: experience-upgrade-acceptance.test, wave03-d7-cart-browser-journey.test on each PostgreSQL version. Browser: experience-upgrade-acceptance.test; wave03-d7-cart-browser-journey.test. Boundary: Current complete source regression passed; legacy authenticated callers without actor hints retain their existing contract; live payment checkout remains separately gated.

**COMPARE — Server-backed listing comparisons (PASS_E2E)**

Conversation compare request and existing comparison cards. Read-only compare; no purchase. Expected: Result-set-bound IDs and supported attributes. Rejection/recovery: Missing facts unknown; stale/foreign references rejected. API/DB evidence: g3-ui.test, experience-upgrade-acceptance.test on each PostgreSQL version. Browser: g3-ui.test; experience-upgrade-acceptance.test. Boundary: No external-item purchase authority.

**CHECKOUT — Reviewed orders and stock reservation (PASS_E2E)**

Canonical cart review, consent and order confirmation. Required checkout/contact consent before explicit confirm. Expected: 201 order; one immutable order_items snapshot; cart cleared. Rejection/recovery: Before consent0requests; stock/price/conflicting replay guarded. API/DB evidence: sc01-browser-journey.test, sc03-browser-journey.test, sc07-browser-journey.test on each PostgreSQL version. Browser: sc01-browser-journey.test; sc03-browser-journey.test; sc07-browser-journey.test. Boundary: Real payment provider blocked.

**NEGOTIATE — Owned proposals/counteroffers and expiry (PASS_E2E)**

Price proposal/review/accept/counter cards. Each proposal/acceptance reviewed and confirmed. Expected: Persisted agreement; checkout uses agreed server amount. Rejection/recovery: Wrong actor/stale proposal rejected; no policy invention for non-price terms. API/DB evidence: sc03-browser-journey.test, commerce-journey.test on each PostgreSQL version. Browser: sc03-browser-journey.test; commerce-journey.test. Boundary: Non-price terms remain owner-policy dependent.

**ORDERS — Status, seller hand-off and buyer receipt (PASS_E2E)**

Existing order card accept/handoff/receipt buttons. Explicit authorized handoff and buyer receipt. Expected: Actual COMPLETED from server then PostgreSQL. Rejection/recovery: Stranger404; opening notification read-only; duplicate/replay state guarded. API/DB evidence: sc01-browser-journey.test, sc03-browser-journey.test, experience-upgrade-acceptance.test on each PostgreSQL version. Browser: sc01-browser-journey.test; sc03-browser-journey.test; experience-upgrade-acceptance.test. Boundary: Live courier tracking is not fabricated.

**DISPUTE — Party-owned complaint and reviewed admin outcome (PASS_E2E)**

Order dispute and admin dispute-resolution controls. Participant request and authorized reviewer decision. Expected: Persisted case/state; participant reads preserved. Rejection/recovery: Admin cannot impersonate buyer private read; decision is not provider refund. API/DB evidence: sc10-browser-journey.test on each PostgreSQL version. Browser: sc10-browser-journey.test. Boundary: No refund-success claim from an administrative decision.

**PAYMENT — Signed, deduplicated simulation payment events (PASS_API_ONLY)**

No real payment executed; API simulation fixtures. Simulation-only authorized intent; signed event authority. Expected: Matched deduplicated payment_events and order effect. Rejection/recovery: Forged signatures/amount/currency fail; cancelled capture becomes refund due. API/DB evidence: wave4-payment-acceptance.test, payment-order-state.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Live provider/billing activation forbidden.

**FINANCE — Immutable snapshots, journal and seller dues (PASS_API_ONLY)**

Seller dues reads; API/SQL immutability and reconciliation fixtures. No client financial authority; terminal server transition. Expected: Integer snapshot+journal+dues; restore trigger checks. Rejection/recovery: Direct snapshot/item/journal mutation rejected; no repricing. API/DB evidence: financial-state-machine.test, wave07-financial-journal.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Production financial operations not exercised.

**REFUND — Refund obligations and signed completion (PASS_API_ONLY)**

API reconciliation and signed-event fixtures. Provider-signed REFUND_SUCCEEDED for electronic completion. Expected: Exactly one append-only obligation; authenticated completion. Rejection/recovery: Unsigned/replayed mismatched events rejected; no false money transfer. API/DB evidence: wave08-cash-and-refunds.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Only provider-signed completion closes monetary refund.

**CASH — Cash claims and reviewed refund cases (PASS_API_ONLY)**

API cash handover/claim and case fixtures. Required parties attest actual handover/refund; reviewer policy. Expected: Persisted claim/case and ledger locks. Rejection/recovery: Seller assertion alone cannot prove cash repayment; no card-capture claim. API/DB evidence: wave08-cash-and-refunds.test, integration-cash-lock-order.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Cash handover is external and must not claim card capture.

**BLOCKE — Standard ad plan and sponsored listing lifecycle (PASS_E2E)**

Seller promotion review/activate/pause/resume; disclosed buyer sponsored card. SIMULATION_ONLY activation review; separate purchase consent. Expected: Promotion lifecycle persisted; same disclosed item yields exactly one JOD45000 cash order. Rejection/recovery: No request before consent; no payment intent for cash order; expiry/cancel invariants. API/DB evidence: block-e-acceptance.test, promotions.test, g3-ui.test on each PostgreSQL version. Browser: block-e-acceptance.test; g3-ui.test. Boundary: Simulation evidence does not activate a live ad-payment provider.

**V3 — Commercial balance, entitlements and demand capture (PASS_API_ONLY)**

API commercial balance/entitlement fixtures; existing cards independently scoped. Existing approved policy and deduplication; no live billing. Expected: Persisted commercial ledger/entitlements. Rejection/recovery: Unapproved product/price/renewal refused; not a separate coupon lifecycle. API/DB evidence: block-e-acceptance.test, next-g3-acceptance.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Separate commercial mechanisms tested as API contracts; not all visible lifecycle variants browser accepted; no separate approved coupon money engine.

**POLICY — Effective scoped commercial and privacy cohort policy (PASS_API_ONLY)**

Server effective-policy reads and API regression fixture. Read-only server-selected market. Expected: Scoped version wins before LIMIT; fallback and effective date tested. Rejection/recovery: 25 newer globals cannot evict market override; historical orders unchanged. API/DB evidence: next-g1-usage.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Confirmed >20-global-history precedence bug fixed and verified on both PostgreSQL versions.

**SUBSCRIPTION — Plan truth, entitlements and cancellation (PASS_API_ONLY)**

Existing plan/usage contracts; API policy/entitlement fixtures. Approved policy only; explicit subscription changes. Expected: Authoritative approved/provisional terms and usage. Rejection/recovery: Unapproved prices/renewals blocked; conversational settings additions remain Claude-owned. API/DB evidence: next-g1-usage.test, next-g3-acceptance.test, pro-subscription-honesty.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Unapproved prices/renewal and live billing stay blocked.

**BUSINESS — Business identity, verification and storefront (PASS_E2E)**

Canonical business onboarding/storefront/reviewer controls. Owner submission and independent reviewer decision. Expected: Persisted profile/catalog and truthful verification state. Rejection/recovery: Foreign/suspended mutations denied; synthetic documents are not real verification. API/DB evidence: d1-d2-business-browser.test, d3a-native-business.test on each PostgreSQL version. Browser: d1-d2-business-browser.test. Boundary: Test reviewer fixtures are not real-world verification/legal approval.

**STAFF — Scoped catalog/reports and revocation (PASS_API_ONLY)**

Read-only business/Connect employee reports and catalog scope. Owner grants/revokes; human staff read-only. Expected: Scoped authoritative reads; expiry/revocation persisted. Rejection/recovery: Employee cannot manage keys/agreements/partner mutations. API/DB evidence: business-delegations.test, connect-finance-browser-journey.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Human employees remain read-only; owner controls keys and Connect management.

**CONNECT — Partner onboarding, site proof and integration keys (PASS_E2E)**

Existing Connect enrollment/site proof/key controls. Owner key/management; independent site verification. Expected: Fixture TXT proof and key-lifecycle receipts. Rejection/recovery: Unverified domain/foreign actor/revoked key fail; no live merchant claim. API/DB evidence: connect-partners.test, connect-cards-browser-journey.test on each PostgreSQL version. Browser: connect-cards-browser-journey.test; supplemental expanded-connect cards36profiles perPG; local pinned TLS navigation fixture. Boundary: External provider credentials/sandbox acceptance separate.

**CONNECT-CATALOG — Feed/MCP ingestion, freshness and discovery (PASS_API_ONLY)**

API feed/MCP/website-ingestion and diagnostic fixtures. Authorized source/integration; read-only imported offers. Expected: Source/timestamps/freshness; validated persisted offers. Rejection/recovery: SSRF, unsupported transaction tools, stale/malformed source rejected. API/DB evidence: connect-catalog-pull.test, connect-mcp-catalog.test, connect-sync-observations.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: No invented availability, prices or external transactions.

**CONNECT-FINANCE — Agreement terms, acceptance and verified-event ledger (PASS_E2E)**

Owner terms accept; admin agreement and finance/report controls. Independent proposal; owner-only explicit acceptance; verified conversion. Expected: Immutable nested terms; integer commission ledger; synthetic reversal. Rejection/recovery: No self-approval/employee acceptance/forged conversion; Claude mapper tested separately after integration. API/DB evidence: connect-finance-browser-journey.test, connect-commission-math.test on each PostgreSQL version. Browser: connect-finance-browser-journey.test; supplemental expanded-connect finance126profiles perPG. Boundary: Latest Claude canonical nested agreement mapper is corrected on independent branch; joint source still unqualified.

**EXTERNAL — Trusted HTTPS referral and consent revocation (PASS_E2E)**

Server-issued EXTERNAL_LINK card activated by keyboard. Explicit navigate; optional attribution consent. Expected: Trusted HTTPS destination; opener=null; conversation intact. Rejection/recovery: Untrusted redirect blocked; no internal order/cart/payment success or unearned affiliate claim. API/DB evidence: connect-cards-browser-journey.test, connect-finance-browser-journey.test, connect-network.test on each PostgreSQL version. Browser: connect-cards-browser-journey.test; connect-finance-browser-journey.test; supplemental expanded-connect cards36profiles perPG; local pinned TLS navigation fixture. Boundary: External checkout never becomes an internal order/payment success.

**DOMAIN — Normalized domain query and verified/unknown provider offers (PASS_E2E)**

Existing domain intent/card and Search on provider link. Read-only provider query; no automatic registration. Expected: Verified fixture values or explicit unknown; source/check time. Rejection/recovery: Invalid IDN/domain rejected; timeout/rate limit unknown; unconfigured provider search-only. API/DB evidence: connect-domain.test, connect-cards-browser-journey.test on each PostgreSQL version. Browser: connect-cards-browser-journey.test; supplemental expanded-connect cards36profiles perPG; local pinned TLS navigation fixture. Boundary: Real Spaceship/Cloudflare provider acceptance requires authorized configured access.

**MEMORY — Retention, context isolation and personal controls (PASS_API_ONLY)**

API memory controls and adversarial retention/retrieval fixtures. Actor consent/retention/market boundaries. Expected: Persisted permitted context; deletion/revocation respected. Rejection/recovery: Foreign/adversarial context isolated; original V2 provenance remains blocked. API/DB evidence: wave06-conversation-memory.test, wave06-conversation-memory-adversarial.test, w06-d17-retrieval-quality.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Original V2 history provenance remains BLOCKED.

**RUNTIME — Server-owned turns, Stop reception and recovery (PASS_E2E)**

Send/Stop reception/new conversation/history/reload. Stop receiving; verify server-owned outcome; never auto-cancel. Expected: Persisted turn/result/receipt reconciled after reconnect. Rejection/recovery: No duplicate transactional replay; cross-tab/actor recovery isolated. API/DB evidence: conversation-v2-browser-journey.test, conversation-stream-recovery-browser-journey.test, d12-execution-recovery.test on each PostgreSQL version. Browser: conversation-v2-browser-journey.test; conversation-stream-recovery-browser-journey.test. Boundary: No paid/live model-quality PASS; Claude bindings not silently imported.

**CARDS — Envelope, action receipts and state restoration (PASS_E2E)**

Canonical Envelope renderer, review and action buttons. Explicit pending action review/confirm. Expected: Backend action receipts and restored UI blocks. Rejection/recovery: Forged/foreign/stale/duplicate actions rejected; keyboard/focus/reduced motion tested. API/DB evidence: w02u3-card-accessibility-browser-journey.test, w02u3-card-performance-browser-journey.test on each PostgreSQL version. Browser: w02u3-card-accessibility-browser-journey.test; w02u3-card-performance-browser-journey.test. Boundary: No second renderer/action engine.

**LEGAL — Country readiness, consent and capability gates (PASS_API_ONLY)**

API market-readiness/age/consent approval fixtures. Independent staged approvals; actor consent. Expected: Persisted policy consent and capability approvals. Rejection/recovery: Minor/unapproved market/capability fail; fixture approval is not counsel signoff. API/DB evidence: market-legal-acceptance.test, d16-readiness.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Legal approval is an owner/counsel requirement, never inferred from test fixtures.

**PRIVACY — Preferences, export/deletion requests and decisions (PASS_API_ONLY)**

API preference/export/deletion requests. Required identity/proof; authorized decision. Expected: privacy_requests/events with retention boundaries. Rejection/recovery: Foreign request rejected; financial/legal records not falsely erased. API/DB evidence: closure-privacy.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Actual external notification dispatch remains unconfigured.

**TRUST — Reports, moderation and appeals (PASS_E2E)**

Actual in-chat listing details report dialog; admin trust controls separately. Explicit reason/note submit; independent admin decision. Expected: 201 report and independent reporter/listing/status DB row. Rejection/recovery: Unauthorized/invalid/duplicate reports guarded; inactive standalone reporter fixture not substituted. API/DB evidence: wave3-acceptance.test, security-acceptance.test on each PostgreSQL version. Browser: supplemental inline-report: shipped chat-only listing report16profiles perPG, actual POST201, independent DB row; admin controls from canonical wave3 fixture explicitly separate. Boundary: Permission outcomes need their own positive/negative evidence.

**NOTIFY — Actionable order notifications and private order opening (PASS_E2E)**

Profile notifications link; exact order row; browser back/reload. Opening is read-only; receipt still explicit. Expected: Correct participant order restored; DB has no automatic status mutation. Rejection/recovery: Malformed path0detailrequests; anonymous401/stranger404. API/DB evidence: experience-upgrade-acceptance.test, closure-notifications.test on each PostgreSQL version. Browser: experience-upgrade-acceptance.test. Boundary: In-app records work independently; email/SMS/push vendor registry is empty.

**JOBS — Expiry, abandoned execution and search maintenance (PASS_API_ONLY)**

API startup/interval expiry and execution-recovery fixtures. Only server eligibility rules. Expected: Idempotent stored expiry/recovery and bounded indexing. Rejection/recovery: Repeated maintenance no double accounting; vendor notification delivery not inferred. API/DB evidence: d12-execution-recovery.test, search-sql-foundation.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Each housekeeping effect must be mapped separately from live notification delivery.

**ADMIN — Markets, category audit and promotion plan management (PASS_E2E)**

Actual category/market/promotion create/edit/disable controls. Admin-only explicit review/save. Expected: Canonical rows/audit and immutable original order amounts. Rejection/recovery: Stranger/admin boundary enforced; unapproved economics not activated. API/DB evidence: experience-upgrade-acceptance.test on each PostgreSQL version. Browser: experience-upgrade-acceptance.test. Boundary: New actual editor + DB snapshot acceptance currently qualifying.

**DRIVER — Driver onboarding, eligibility and availability (PASS_E2E)**

Chat driver onboarding vehicle/city/confirm; availability/work card. Explicit onboarding confirm; independent verification before work. Expected: DRAFT→PENDING_VERIFICATION; CAR/city persisted; pending remains UNAVAILABLE. Rejection/recovery: Pending driver cannot become available/accept; revocation and foreign account fail. API/DB evidence: block-f4-driver.test on each PostgreSQL version. Browser: block-f4-driver.test; supplemental expanded-driver48cases,40recovery+140onboarding/delivery profiles perPG; buyer receipt UI separately SC03. Boundary: Fixture verified-driver work; no real-world vetting or live GPS provider.

**DELIVERY — Delivery custody, timeline, fare and completion (PASS_E2E)**

Existing driver accept/pickup/depart/arrival/handoff and earnings timeline. Explicit driver actions; buyer receipt separately required; both fare parties confirm. Expected: Persisted assignments/progress/fulfillment; immutable fare and simulated commission. Rejection/recovery: Revoked/replaced custody isolated; no live GPS/map/provider claim; receipt UI proven separately by SC03. API/DB evidence: block-f4-driver.test, r5-delivery-economics.test, sc03-browser-journey.test on each PostgreSQL version. Browser: block-f4-driver.test; sc03-browser-journey.test; supplemental expanded-driver48cases,40recovery+140onboarding/delivery profiles perPG; buyer receipt UI separately SC03. Boundary: GPS adapter unconfigured; no implemented map routing or recurring opportunity subscription; fare API exists, chat negotiation not independently accepted.

**EMPLOYMENT — Jobs, candidate CV, applications and reviewed recruitment actions (PASS_E2E)**

EmploymentSurface job/candidate/application controls and employment-action-confirm/cancel. Explicit reviewed CONFIRM; sharing/contact permission distinct. Expected: Real action receipt and stored job/profile/application. Rejection/recovery: Cancelled/expired/replayed/foreign application actions refused; CV visibility enforced. API/DB evidence: employment.test, block-c-acceptance.test, command-c-acceptance.test on each PostgreSQL version. Browser: Canonical block-c-acceptance actual employer/candidate browser workflow plus independent API/DB outcome on bothPGs. Boundary: No live recruiter/background verification claim.

**PROVIDER — Existing provider connection and resource synchronization (PASS_API_ONLY)**

provider-confirm/cancel and provider-issue-key. Owner review/confirmation and credential issuance. Expected: Mapped provider resource and authorized key lifecycle receipt. Rejection/recovery: Revoked/foreign keys and provider-controlled field edits denied; secret not in diagnostics. API/DB evidence: g1-provider.test, provider-controls.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: API-only integration contracts; genuine external system credentials/provider acceptance absent.

**INQUIRY — Buyer/seller inquiries and grounded unanswered questions (PASS_API_ONLY)**

inquiry-send and party thread/card controls. Draft review then explicit send; author identity from session. Expected: Persisted message/thread status and truthful sender/provenance. Rejection/recovery: Unknown fact remains unknown; foreign thread/unsupported claim refused. API/DB evidence: next-g2-inquiry.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: API-only scenario; independent in-app notification delivery distinct from vendor dispatch.

**TUTORIAL — Authenticated tutorial playback/animation and draft continuation (PASS_E2E)**

TutorialVideoCard play/continue controls. Explicit tutorial open/continue; no automatic listing publication. Expected: Real TUTORIAL_OPENED event and original draft continuation. Rejection/recovery: Local animation fallback clearly identified; no fake external video/provider delivery. API/DB evidence: g3-ui.test, g2-smart-conversation.test on each PostgreSQL version. Browser: Canonical g3-ui production-built real API Chromium tutorial; independent learning event/owner/draft DB assertions on bothPGs. Boundary: Browser proved local fallback animation and stored continuation; no new media assets or hosting claim.

**MEDIA — Owned image upload, validation and publication review (PASS_API_ONLY)**

Actual upload/review controls; avatar real filechooser tested in account supplement. Explicit upload/attach and applicable publication review. Expected: Verified type/header/owner/generation; persisted authoritative object path. Rejection/recovery: Invalid MIME/foreign/unreviewed image rejected; no fabricated listing photos. API/DB evidence: listing-image-publication-acceptance.test, listing-image-policy-review.test, listing-photo-vision-provider.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Listing image API contracts; account avatar browser transport separately E2E; storage adapter is local, no live provider claim.

**USAGE — Model usage reservation, spend limits and reconciliation (PASS_API_ONLY)**

Canonical usage reads; explicit approved plan actions separate. Server budget reservation before model call; no client invented cost. Expected: Integer recorded actual usage and bounded reservation/finalization. Rejection/recovery: Rejected/failed calls released/reconciled idempotently; unapproved price remains unknown. API/DB evidence: next-g1-usage.test, closure-ai-cost.test, wave05-d15-money-model.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Offline deterministic accounting, not actual live-token bills or live model quality.

**LOCATION — Transaction location consent and assigned-driver privacy (PASS_API_ONLY)**

Explicit location share/change and delivery selection. Explicit sharing; private exact address only authorized fulfillment actor. Expected: Stored scoped location and provider freshness/unknown status. Rejection/recovery: Revoked/replaced courier loses access; stale/unconfigured provider never fake live GPS/ETA. API/DB evidence: location-policy.test, block-f4-driver.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: API location/privacy fixtures; delivery UI separately exercised; no live maps or GPS provider acceptance.

**CONTACT — Order-bound contact release and listing contact protection (PASS_API_ONLY)**

Canonical contact-consent and order contact actions. Required explicit contact consent and eligible order state. Expected: Only eligible party sees permitted contact channel. Rejection/recovery: Phone/contact in listing free text refused; foreign/ineligible order contact denied. API/DB evidence: security-acceptance.test, sc07-browser-journey.test, commerce-journey.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Scoped contact permissions; no real external message/SMS dispatch inferred.

**MODEL — Model gateway, strict tools, discovery and authority boundaries (PASS_API_ONLY)**

Canonical composer; server tool/schema routing, no second runtime. Read/prepare tools only; confirmed business actions retain backend authority. Expected: Validated grounded tool result and permitted receipt. Rejection/recovery: Prompt injection/unstructured actions cannot mint success, payment/order authority or duplicate execution. API/DB evidence: ai-provider.test, ai-authority-boundary.test, model-native-routing.test, ai-transport.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Deterministic providers only; current15bindings; Claude25registry not integrated; no GPT-level/live-quality claim.

**SUPPORT — Party-owned support cases, messages and reviewed operations (PASS_API_ONLY)**

No independently accepted browser form for this exact row. Explicit party message; authorized reviewer assignment/status. Expected: Persisted case/messages/events with correct private audience. Rejection/recovery: Foreign case/read/write denied; case decision cannot fabricate money refund. API/DB evidence: wave10-trust-support-whatsapp.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: PASS_API_ONLY; no claim that every support UI/control or external ticket integration exists.

**WHATSAPP — WhatsApp consent, template and queued intent readiness (PASS_API_ONLY)**

No live messaging control activated. Explicit consent; approved template/readiness before permissible intent. Expected: Persisted consent/template/intent state, not delivery receipt. Rejection/recovery: Missing consent/legal/provider state blocks send; no live dispatch or fabricated delivery. API/DB evidence: wave10-trust-support-whatsapp.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Provider messaging not configured/activated; real send and receipt BLOCKED_PROVIDER.

**FRAUD — Fraud signal recording and independent review (PASS_API_ONLY)**

API review; not a separately proven browser workflow. Authorized explicit review; immutable audit/decision boundaries. Expected: Persisted signal and scoped reviewer outcome. Rejection/recovery: Anonymous/nonadmin/foreign access denied; no automatic financial action inferred. API/DB evidence: wave10-trust-support-whatsapp.test, security-acceptance.test on each PostgreSQL version. Browser: API/SQL cases only for this row; no browser claim. Boundary: Scoped local API security; real-world fraud scoring/evidence acceptance not claimed.
