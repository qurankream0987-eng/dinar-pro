# JassimAI — Google OAuth Branding Readiness

## A. Git state

| | |
|---|---|
| Starting SHA | `57de635` (Phase 3 + the comparison/sale misread fix, published) |
| Branch (local only, **not pushed**) | `claude/jassimai-google-oauth-readiness` |
| Final local SHA | the commit adding this document |

**Changed files:**
- `artifacts/api-server/src/lib/web-frontend.ts`: server-rendered `/`, `/privacy`, `/terms`.
- `artifacts/api-server/src/lib/policies.ts`: new privacy version `2026-11-13`.
- `artifacts/dinar/src/App.tsx`: `/privacy` and `/terms` routes.
- `artifacts/dinar/src/pages/Policies.tsx`: `FixedPolicyPage`.
- `artifacts/dinar/src/features/ai/ConversationHistory.tsx`: legal links on the home page.
- `artifacts/dinar/src/pages/AiChat.css`.
- Tests: `test/google-oauth-public-pages-browser.test.ts` (new), `test/wave09-policy-consent-compliance.test.ts` (uses the current privacy version).

## B. The three Google errors: root cause (verified 2026-11-13 from this environment)

| Error | Evidence | Root cause | Fixed in code? | Owner action |
|---|---|---|---|---|
| 1. `https://jassimai.com` unresponsive | DNS: `jassimai.com A 192.64.119.152`; HTTPS: connection reset; no certificate | The apex still points to a **Namecheap** parking/redirect address, not to the app | Not a code issue | Point the apex at the chosen Railway service (§G) |
| 2. Website not registered to you | `NS = dns1/dns2.registrar-servers.com` (Namecheap). The only TXT is `v=spf1 include:spf.efwd.registrar-servers.com ~all` | **The domain's DNS is served by Namecheap, not Cloudflare.** Records added in Cloudflare are not seen by the internet, so Google never saw a verification TXT | Not a code issue | Add Google's TXT where DNS is authoritative (§G) |
| 3. `https://jassimai.com/privacy` unresponsive | Same as 1. Also, the app had **no `/privacy` route** (it rendered "not found" client-side) | Domain, plus a missing route | **Yes**: `/privacy` and `/terms` are now real pages, readable without JavaScript | Same as 1 |

`www.jassimai.com` has **no DNS record**. `staging.jassimai.com` is a CNAME to `wpvwakcd.up.railway.app` and works (200 for `/`, `/privacy` and `/terms`), but it runs an older build that still says «DINAR AI» and has no `/privacy` route.

## C. Website readiness (code)

**Home `/`:**
- The server sends real text inside `#root`: what JassimAI does, the sale and purchase safeguards, "payments are direct between buyer and seller", login/register links, and privacy/terms links.
- The chat welcome screen also shows «سياسة الخصوصية · شروط الاستخدام · كل السياسات».
- It does not mention Shopify, subscriptions or active payments.

**`/privacy`:**
- Serves the **new privacy version `2026-11-13`**, written from the code:
  - What is stored for an account, and that the password is hashed (scrypt).
  - Google sign-in: only the openid, email and profile scopes. The Google account identifier and verified email are stored. Nothing is sent to AI providers, and nothing is used for ads.
  - AI conversations: stored for continuity; text is sent to the model provider; cross-conversation memory is off by default.
  - Listings and orders, and that no payments are collected.
  - Essential cookies only: the session, and a 10-minute Google sign-in ticket.
  - Who data is shared with: the SMS provider, the AI provider, Google, and hosting/storage.
  - Access, export, correction and deletion requests, which exist from the account and the chat.
  - HTTPS.
- The old version `2026-10-02` is kept, so existing acceptances stay valid. New acceptances use the new version.

**`/terms`:** the current published terms (unchanged), now at its own URL. `/policies` remains the index.

**Public access:** no login is required and there are no redirects. HTML only, with no secrets (tested).

## D. Domain readiness (read-only checks)

| Component | Verified now | Required |
|---|---|---|
| Authoritative DNS | **Namecheap** (`registrar-servers.com`) | Pick one place (§G). Today it is Namecheap |
| Apex `jassimai.com` | A `192.64.119.152` (Namecheap), HTTPS reset | ALIAS/CNAME to the Railway service for jassimai.com |
| `www` | none | Optional: CNAME to the same service, or a redirect |
| Staging | CNAME `wpvwakcd.up.railway.app`, HTTPS OK | Keep as is |
| Email | MX `eforward1..5.registrar-servers.com` + SPF (Namecheap email forwarding) | **Keep**. Moving DNS to Cloudflare would break it unless these records are copied |
| Search Console TXT | not present | Google's exact `google-site-verification=…` value |
| Railway custom domain for the apex | not verifiable from here | Add `jassimai.com` to the intended service; Railway shows the target and any TXT |

## E. OAuth (from the code)

| Item | Value |
|---|---|
| Architecture | Google Identity Services ID token (`/api/auth/google` → server verification of RS256 signature, issuer, audience, expiry and `email_verified`). Account linking requires SMS phone verification (`/api/auth/google/complete`). The DINAR session cookie is issued by our server |
| Scopes | `openid email profile` (non-sensitive) |
| **Authorized JavaScript origins** | `https://jassimai.com` (plus `https://staging.jassimai.com` if staging uses the same client) |
| **Authorized redirect URIs** | **none required**: this flow has no redirect callback |
| Client secret | **not used** (ID-token verification uses Google's public keys) |
| Server env | `GOOGLE_OAUTH_CLIENT_ID=<…>.apps.googleusercontent.com` |
| Web build env | `VITE_GOOGLE_CLIENT_ID` (same value, set before the web build) |
| App origin | `APP_ORIGIN=https://jassimai.com` on the service that serves jassimai.com |
| Branding fields | App name **JassimAI**; Home page `https://jassimai.com`; Privacy `https://jassimai.com/privacy`; Terms `https://jassimai.com/terms`; Authorized domain `jassimai.com` |
| Missing from the owner | **User support email and developer contact email** (Google requires them; not invented here); the legal entity name for the policies |

**Security review:** no auth code was changed. State, nonce and redirect concerns do not apply to the ID-token flow (there is no redirect). The audience is pinned to our client id, and the pending ticket is HMAC-signed with a 10-minute lifetime. `google-signin`, `same-origin-web`, `security-acceptance` and the isolation suites are green.

## F. Tests (exact HEAD)

The command, from `artifacts/api-server` with a loopback disposable DB: `test/isolation/local-suite.sh <suite>.test`. The web app must be built first.

| Suite | Result |
|---|---|
| `google-oauth-public-pages-browser` (new: G1–G12, G15; 320, 390 and 1440 px) | **3/3 PASS** |
| `google-signin` | 6/6 PASS |
| `same-origin-web` | 16/16 PASS |
| `app-additional-origins` | 3/3 PASS |
| `security-acceptance` | 12/12 PASS |
| `d4-d5-isolation-security` | 8/8 PASS |
| `closure-privacy` | 12/12 PASS |
| `integration-policy-consent` | 4/4 PASS |
| `policy-consent-cards` | 3/3 PASS |
| `wave09-policy-consent-compliance` | 19/19 PASS |
| `d16-readiness` | 4/4 PASS (with Chromium supplied) |
| `w02u3-card-sessions-browser-journey` | 1/1 PASS |
| `conversation` | 29/29 PASS |
| `phase3-interactive-experience` | 11/11 PASS |

**BLOCKED** (needs the owner's accounts or infrastructure):
- Live `https://jassimai.com` responses.
- Search Console verification.
- The Google OAuth consent-screen review.

## G. Owner checklist (nothing below has been executed)

1. **Publish** this branch after review (GitHub), and deploy the reviewed build to the Railway service meant for jassimai.com. Do not reuse staging for production unless you decide so explicitly.
2. **Railway:** on that service, add the custom domain `jassimai.com` (and `www.jassimai.com` if wanted). Copy the target hostname Railway shows, and any `_railway` TXT. Set:
   - `APP_ORIGIN=https://jassimai.com`
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `VITE_GOOGLE_CLIENT_ID`
3. **DNS: choose one path.**
   - **(Simplest) Stay on Namecheap:**
     1. In Domain List → `jassimai.com` → Advanced DNS, remove the parking/URL-redirect record for `@`.
     2. Add an **ALIAS** record `@` → the Railway target, and a CNAME `www` → the same target.
     3. Add Railway's TXT if shown.
     4. Keep the MX and SPF records untouched.
   - **Or move to Cloudflare:**
     1. In Cloudflare, first recreate every record, including the MX `eforward1–5`, the SPF TXT and the staging CNAME.
     2. Then in Namecheap → Nameservers → Custom DNS, enter the two nameservers Cloudflare assigned.
     3. Use a CNAME `@` (flattened) to the Railway target, with **DNS only** (grey cloud) until Railway issues the certificate.
4. **Check:** `https://jassimai.com`, `/privacy` and `/terms` open with a valid lock icon on a phone and on a computer.
5. **Search Console:**
   1. Add the **Domain** property `jassimai.com` and copy the exact TXT `google-site-verification=…`.
   2. Add it as a TXT on `@` **in the DNS that is authoritative** (Namecheap today). Keep the SPF record; this is a second TXT.
   3. Verify, using **the same Google account** that owns the OAuth project.
6. **Google Auth Platform:**
   1. Branding: app name JassimAI, logo, home/privacy/terms URLs, authorized domain `jassimai.com`, support and developer emails.
   2. Clients: Authorized JavaScript origins `https://jassimai.com`.
   3. Data access: openid, email, profile.
7. **Request branding verification again.**

## Remaining notes for the owner

- **Terms:** the terms text still says «بدينار» and has no clause on AI output limits. A JassimAI terms version needs your legal wording; it was not invented here.
- **Policies:** the policies are marked «بانتظار المراجعة القانونية». Google reviews the published text; legal sign-off is separate.
