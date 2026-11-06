# Generative UI: action authority

**This mission added no action type and no new button capability.** A model proposal cannot carry an action.

Actions on generated layouts are those of the reused typed cards. Each is server-issued and re-authorized at use.

| Class (mission term) | DINAR implementation | Authority at use |
|---|---|---|
| CONVERSATION_SEND | `SurfaceAction.SEND` (utterance) | re-enters the runtime; ownership, market, confirmation, expiry, idempotency |
| INTERNAL_NAVIGATION | `SurfaceAction.NAVIGATE` (path regex, no `//`) | client route; data fetched with the session |
| OPEN_VERIFIED_RESOURCE | «عرض التفاصيل» on a result card → `getResource` against the owned result set | `aiResultSets` owner + market |
| OPEN_VERIFIED_EXTERNAL_MERCHANT | `SurfaceAction.EXTERNAL_LINK` → `POST /connect/outbound` → `GET /connect/outbound/:id` | see `GENERATIVE_UI_CONNECT_EXTERNAL_BUY.md` |
| PREPARE_CANONICAL_ACTION | «أضف للسلة» → `/ai/conversations/:id/actions/add-to-cart` (server price/stock); purchase / negotiation reviews | pending action, explicit confirmation |
| CONFIRM / CANCEL_PENDING_ACTION | `confirmPendingAction` | single-use, expiry, idempotent |
| CHANGE_LOCAL_PRESENTATION | GRID / LIST / CAROUSEL layout | presentation only; no request |

## Properties preserved

All of the following are covered by existing suites:
- **Pending reviews:**
  - `allowedActions` is filtered by `applyCardEnvelope`;
  - terminal states carry no SEND action;
  - expired or confirmed reviews are non-executable after reload (`w02u3-card-*`, `wave03-card-envelope-*`);
  - double confirmation is idempotent (`d12-execution-recovery`, `w02u3-card-concurrency`).
- **Cart:** a cart line is created only by the canonical cart service after confirmation, and a model tool cannot add (`ai-authority-boundary`: `addToCart` is not a model tool).
- **Payments:** payments, refunds, agreements and publication are absent from every model tool (`ai-authority-boundary`, test 4–6).
