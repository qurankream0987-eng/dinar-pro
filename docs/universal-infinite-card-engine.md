# JassimAI Universal Infinite Card Engine & Context Compression Architecture

> **Status:** Front-end engine built & verified (`google/ui-15-universal-infinite-cards`). Protocol & backend context-compression blueprint prepared for Claude review and server wiring.

---

## 1. Industry & GitHub Research Foundation (2025–2026)

1. **Generative UI Protocols (`a2ui-project/a2ui`, `CopilotKit/generative-ui`, Anthropic MCP Apps):**
   - External AI models never emit raw HTML/JS (unsafe and brittle).
   - Instead, models emit a **compact, declarative JSON spec** referencing a **Trusted Local Component Catalog**.
   - The host React engine validates the payload and renders tactile, interactive, sandbox-safe experiences (such as layered food/burger builders, live fashion mannequin try-on studios, and hardware/furniture finish studios).
2. **Hierarchical Context Compression (`yashdoke7/llm-hiermem`, `joshuaswarren/remnic`, `YerbaPage/Awesome-Agent-Context-Compression`):**
   - Long-horizon chats fail under naive truncation (forgetting budget, market, or earlier preferences) and blow up token costs if sent verbatim.
   - Production systems use a **3-tier memory hierarchy (L1 Hot Window → L2 Warm Rolling Digest → L3 Cold Lossless Archive)** with on-demand recall tools.

---

## 2. Universal Infinite Card Protocol (`JassimCardSpec v1`)

Implemented in `artifacts/dinar/src/features/ai/infinite-cards/`:
- `schema.ts`: Strict TypeScript contract & runtime validator (`isValidUniversalCardSpec`).
- `LayeredStage.tsx`: Interactive visual stage supporting:
  - `LAYERED_STACK`: Animated layered stack (Burger / Meal / Cake / Bouquet builder).
  - `MANNEQUIN`: Interactive fashion mannequin silhouette dressing live across `top`, `outerwear`, `bottom`, and `shoes`.
  - `PRODUCT_STUDIO`: Interactive hardware/color/band finish studio.
- `UniversalCardEngine.tsx`: Composable renderer supporting `LAYER_BUILDER`, `OUTFIT_SLOTS`, `STUDIO_FINISHES`, `OPTION_CHIPS`, `STEPPER`, `TRUST_STRIP`, authoritative server `quote` bar, and the reserved `data-slot="in-chat-payment-slot"`.
- `fixtures.ts` + `SmartStorePreview.tsx`: 3 live, playable interactive demos (Burger Builder, Mannequin Outfit Studio, Smart Watch Studio).

### How ANY External AI Model Integrates (Groq, DeepSeek, Gemini, Claude, OpenRouter, Connect MCP)
1. **Model Emits Structured Tool Call / JSON Spec:**
   - The LLM does **not** calculate final prices. It selects `stageMode` and composable `blocks` using product/modifier IDs from the merchant catalog.
2. **Server Hydrates Authoritative Prices:**
   - Before streaming the card to the browser, the JassimAI backend attaches `quote.totalLabel` and any `priceDeltaLabel` directly from the database / Connect merchant API.
3. **Interactive Event Loop (`UniversalCardEvent`):**
   - When the user adds extra cheese or switches a jacket on the mannequin, `UniversalCardEngine` updates the visual stage in `<16ms` locally and emits a tiny JSON event (`SELECTION_CHANGED` with only IDs) to the server to re-quote authoritatively.

---

## 3. Three-Tier Rolling Context Compression Architecture (For Claude Backend Wiring)

To keep conversations fast, cheap, and accurate across **50–200+ turns** (even on free/rate-limited models like Groq `gpt-oss-120b` or DeepSeek):

### L1 — Hot Context Window (Always in Prompt, ~1,500–2,500 tokens)
- System prompt + active market rules (`countryCode`, `currencyCode`, `operationMode`).
- Last **6–8 verbatim turns** (user + assistant).
- **Compact Active Card State** (IDs + selected options only — ~80–150 tokens instead of re-sending full card JSON!).

### L2 — Warm Rolling Digest (Triggered when conversation > 10 turns or > 3,500 tokens)
- Background summarization pass compresses turns `1 .. (N - 8)` into a **structured JSON/Arabic digest** stored on the conversation row:
  ```json
  {
    "digestVersion": 3,
    "coveredThroughTurn": 24,
    "userIntent": "شراء إطلالة رسمية وبرغر للعشاء في عمّان",
    "constraints": { "budget": "معتدل", "size": "L", "deliveryArea": "عبدون" },
    "activeEntities": { "orderIds": ["ord_123"], "cardIds": ["card_456"] },
    "settledDecisions": ["تم رفض اللون الأسود للجاكيت", "يفضل الدفع عند الاستلام"]
  }
  ```
- Replaces raw older turns in the LLM prompt so prompt size stays **O(1) flat** regardless of conversation length.

### L3 — Cold Lossless Archive (PostgreSQL + On-Demand Recall Tool)
- Full verbatim messages remain untouched in PostgreSQL (never deleted).
- Expose one read-only tool to the AI agent: `recall_conversation_history({ query, turnStart, turnEnd })`.
- If the user asks at turn 90 *"ارجع للعرض الأول اللي ورجيتني إياه بأول المحادثة"*, the model calls `recall_conversation_history` to expand only those exact turns without bloating every turn's context window.
