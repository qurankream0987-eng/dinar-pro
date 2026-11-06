# Generative UI: DINAR Connect external buy

The path already exists and is reused unchanged. No parallel affiliate system was added.

1. A Connect search returns partner offer cards. The card's `externalActions[0]` is `EXTERNAL_LINK` with `resultSetId`, `cardId` and `providerId`. **No URL ever reaches the client from a card or the model.**
2. The click calls `POST /connect/outbound` with `{resultSetId, cardId, trackingConsent, expected agreement/digest/privacy version}`. The server:
   - checks that the actor is active and the market is available;
   - checks the owned result set (`ownedResult`; a stranger or a forged set gets 404);
   - checks that the card belongs to that set;
   - rejects any extra field such as `url` (400).

   It then issues an owner-scoped outbound record that **expires in 5 minutes**, and returns only `openPath=/api/connect/outbound/<uuid>`. The client accepts only that exact path pattern.
3. `GET /connect/outbound/:id`:
   - rejects any query string (no open redirect);
   - re-checks owner, market and legal capability;
   - **re-validates the partner offer at click time** (`approvedConnectOffer`, same partner);
   - builds the destination from the verified site hostname and offer `targetPath`;
   - checks that the host resolves only to public addresses (`publicConnectAddresses`, which blocks private networks and SSRF);
   - attaches the referral id only after explicit consent to the current agreement digest;
   - answers `303` with `Referrer-Policy: no-referrer` and `no-store`.
4. A click is not a sale. Commission accrues only from authenticated provider conversion evidence under an accepted agreement.

## Evidence (existing suites)

| Case | Suite |
|---|---|
| Exact 303 target `https://catalog.partner.example/products/sku-1` (G-UI-07) | `connect-partners` |
| Forged `url` → 400; stranger / forged result set → 404 (G-UI-08) | `connect-cards-browser-journey` |
| Click does not add to the DINAR cart (G-UI-09) | `connect-partners` |
| «a consented referral click is not a sale or an earned commission» (G-UI-10) | `connect-partners` |

Both pass in this session's battery: `connect-partners` 22/22.

**Fixed here (Codex finding R03):** `readConnectPartnerStatus` now maps the canonical `ConnectAgreementView` exactly:
- `terms.commission`;
- `accepted`;
- `acceptance.acceptedAt`;
- mode, currency and events.

A new positive test inside `connect-partners` covers an accepted percentage agreement (750 bp) and checks that a stranger sees no partnership.

**Still to add (not run):**
- an explicit expired-outbound-link test (the 5-minute expiry is enforced by `ownedResult`, but no test advances the clock);
- revoked-agreement and staff-permission cases for the AI read.
