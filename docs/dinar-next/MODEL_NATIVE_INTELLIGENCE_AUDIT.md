# Command 02: model-native intelligence audit

**Executed by Claude on its own branch**, per the owner's choice. The command was addressed to Codex.
- Branch: `claude/dinar-next-intelligence`.
- Base: `4ee7427`.
- Final SHA: the commit that adds this file.
- Prerequisite verified: Command 01 handoff, `claude/connect-01-modes` at `7d42dd0` (pushed).
- Nothing was merged into Codex or `main`, nothing was deployed, and no paid AI was used.

## G0: what exists, verified from current source (not from memory)

| Item | Current source |
|---|---|
| Model capability registry | `ai/capability-registry.ts` `CAPABILITY_NAMES`: **25** entries (counted from source) |
| Model tool loop allowlist | `ai/tool-registry.ts` `MODEL_LOOP_TOOL_ALLOWLIST`: 12 read-only tools; prepare tools are role-filtered in `model-capability-tools.ts` |
| Product capabilities (settings etc.) | `api-zod/conversation-runtime.ts` `PRODUCT_CAPABILITY_CATALOG`: `SET_THEME`, `SWITCH_MARKET`, `UPDATE_DISPLAY_NAME`, `VIEW_ACCOUNT`, `NOTIFICATION_PREFERENCES`, `PRIVACY_CENTER`, `EXPORT_MY_DATA`, `AI_PLANS`, `AI_USAGE`, … (model-discoverable flags) |
| One runtime | `conversation-runtime.ts` → `smart-turn.ts` (bounded tool loop) → `routes/ai.ts` (SSE) |
| Routing / economics | `routing-mode.ts` (LEGACY default, HYBRID, MODEL_FIRST, SHADOW), `model-tier.ts` (LIGHT/HEAVY), usage reservations |
| Context | multi-turn focus / superlatives / corrections (`resolveConversationReference`), task plans (`task-plan.ts`) |
| Generative UI | `PresentationProposalSchema` / `resolvePresentationProposal` + Card Envelope + `ComposedSurface` |
| Subscriptions | `lib/subscription-plans.ts`, `subscription-overview.ts`, `subscription-billing.ts` (simulation, TEST_NO_TRANSFER); `commerce-turn.ts` plan / review turns |

**Nothing was rebuilt.** Command 02 reused all of the above.

## Probe on the real runtime (stub model)

Before the changes, 15 turns:

| Request | Before | After |
|---|---|---|
| دينار، افتح إعداداتي / أبي أغير إعداداتي | SETTINGS | same |
| غير المظهر إلى الداكن | APP_THEME (`SET_THEME` DARK) | same |
| كم باقي لي من استهلاك الذكاء؟ | AI_USAGE | same |
| **ورني كم باقي لي من الاستخدام** | **MY_LISTINGS (wrong)** | AI_USAGE |
| **افتح خيارات الحساب** | model fallback | ACCOUNT |
| **غير اشتراكي للخطة الأعلى** | model fallback | real plans: honest refusal without prices; review card (Business Go 5.000 JOD) with prices |
| **لا، خل الاشتراك مثل ما هو** | model fallback | deterministic «يبقى اشتراكك كما هو. لم يتغير شيء» |
| نعم (after that) | — | nothing activated (DB unchanged) |
| الثاني، بس لا تشتريه | opens listing 2, no action | same |
| **أبي أفتح مشروع، ساعدني من البداية** | **empty product search** | model |
| **اعرض لي منتجات متجري وحسّن وصفها** | **empty product search** | model |
| **أبي سائق ينقل الغسالة** | **empty product search** | model |
| خل التطبيق يريح عيوني | model | model (an implicit goal: model territory) |

## Changes (general rules, no phrase lists)

- **`conversation-runtime.ts` `executeWithRoutingMode`:** in the default mode, a **zero-result** deterministic search whose extracted query has ≥ 3 words is interpreted once by the model.
  - Short product phrases keep the honest empty result with no model call.
  - Without a model, the empty result is returned unchanged.
- **`commerce-turn.ts`:**
  - relative tier changes («للخطة الأعلى / الأكبر / التالية») are resolved against the real plans card;
  - change verbs (غيّر / حوّل / بدّل + اشتراكي / باقتي / خطتي) are claimed by the plans turn;
  - «لا، خلّه مثل ما هو» after a plans card or review is answered deterministically, and nothing can revive it.
- **`usage-intent.ts`:** «من الاستخدام» is a usage question.
- **`intent.ts`:** «افتح / اعرض خيارات / إعدادات الحساب» opens the account.

## G1 dialect / implicit-goal understanding with a real model

Not measured: no approved live model. See `MODEL_INTELLIGENCE_BENCHMARK.md`.
