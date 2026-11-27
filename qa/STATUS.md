# Antigravity QA Campaign Status

- **Target Environment:** `qa-lab` (`https://jassimai-acceptance-app-qa-lab.up.railway.app`)
- **Current Phase:** Gate 0 (Provider Selection & Prerequisites)

## Gate 0 Decisions
1. **Free AI Provider:** **Groq** (`GROQ_API_KEY`, model `openai/gpt-oss-120b`)
   - Free tier limits: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD (highest free-without-payment quota vs OpenRouter 50 RPD and Gemini Flash 250–500 RPD).
2. **Open-Source Map Provider:** **OpenFreeMap** (`https://tiles.openfreemap.org/styles/liberty`)
   - Verified live `200 OK`, `application/json`, `access-control-allow-origin: *`, no API key required.

## Blockers / Needed Before Live Campaign Writes
1. Owner: Add `https://jassimai-acceptance-app-qa-lab.up.railway.app` as an authorized JavaScript origin in Google Cloud Console (or provide dedicated test Google accounts).
2. Owner + Claude: Add `GROQ_API_KEY` to `qa-lab` on Railway, then set `DINAR_AI_PROVIDER=groq`, `DINAR_AI_MODEL=openai/gpt-oss-120b`, `BDINAR_BLOCK_MODEL_CALLS=0` in `qa-lab`.
3. Claude: Set `VITE_DINAR_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty` and `CSP_CONNECT_EXTRA_ORIGINS=https://tiles.openfreemap.org` in `qa-lab`.
4. Storage probe: Pending confirmation of `qa-lab` bucket probe after Gate 0 prerequisites are cleared.
