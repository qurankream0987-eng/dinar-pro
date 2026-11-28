# Jassim AI — UI-01 Interface Audit Report

**Date:** 2026-11-27  
**Base Branch:** `claude/jassim-connect-universal-engine` (`c9477f5`)  
**Audit Branch:** `google/ui-01-interface-audit`  
**Live Reference:** `https://jassimai.com` (read-only)  
**Scope:** Static source audit of `artifacts/dinar/src/` + live asset & HTML audit of `https://jassimai.com`. *(No code modified in UI-01.)*

---

## 1. Executive Summary

Jassim AI has a solid functional foundation: Arabic `lang="ar" dir="rtl"` on `<html>`, `IBM Plex Sans Arabic` loaded via Google Fonts, `prefers-reduced-motion` implemented in 34 locations, `alt` attributes present on images, and route-level lazy loading for secondary pages in `App.tsx`.

However, to reach **Apple-grade visual polish, speed, RTL precision, and usability**, this audit identifies **8 prioritized findings** (2 Critical, 4 High, 2 Medium) mapped directly to `UI-02` through `UI-14`.

---

## 2. Prioritized Issues Table

| ID | Severity | Category | Page / Component | Finding & Evidence | Proposed Fix (Target Task) |
|---|---|---|---|---|---|
| **AUD-01** | **Critical** | Consistency / Visual | `features/ai/smart-store/SmartStoreCardView.tsx` | Currently a deliberately plain minimal reference renderer (no card elevation, no Embla carousel polish, no color swatch circles, no selection glow/checkmarks, tiny unpadded `×`/`−`/`+` buttons, no skeletons or in-chat payment slot). | Full visual redesign matching `SMART-STORE-CARDS-BRIEF.md` while keeping the exact Zod contract and server-only pricing (**UI-06**). |
| **AUD-02** | **Critical** | Performance | `https://jassimai.com/assets/index-DUCPk8gd.js` & `index-CcM0Z447.css` | Entry JS bundle is **1,073.5 KB** (~1.07 MB uncompressed) and entry CSS is **282.2 KB** across 4,259 CSS lines (`AiChat.css` 2,697 lines, `PremiumMaterials.css` 762, `index.css` 719, `Buttons.css` 81). Heavy chat/card code loads eagerly on first paint. | Code-split heavy chat surfaces, map/chart libraries, and consolidate CSS tokens (**UI-02**, **UI-13**). |
| **AUD-03** | **High** | RTL | `src/components/ui/dialog.tsx:59`, `sheet.tsx:82`, `drawer.tsx:60`, `select.tsx:120`, `dropdown-menu.tsx:30–177`, `context-menu.tsx:28–172`, `accordion.tsx:28`, `Auth.tsx:39`, `AdminLegalReadiness.tsx:681,779` | **50 occurrences** of non-logical directional classes (`sm:text-left`, `pl-8`, `pr-2`, `ml-auto`, `text-left`). Modal/sheet headers align left instead of right in Arabic RTL; menu checkmarks and chevrons are inverted. | Replace all 50 directional utilities with logical Tailwind classes (`sm:text-start`, `ps-8`, `pe-2`, `ms-auto`, `rtl:rotate-180`) (**UI-02**, **UI-12**). |
| **AUD-04** | **High** | Consistency / Contrast | `src/index.css`, `src/pages/AiChat.css`, `src/pages/PremiumMaterials.css`, `src/ui/Buttons.css` | **185 hardcoded hex colors** scattered across TSX/CSS and 4 separate CSS files with legacy `BDINAR` / `DINAR NEXT E` token comments. Makes light/dark contrast consistency and WCAG AA verification brittle. | Consolidate into a single semantic token layer (light + dark, AA verified) and refactor `src/ui/` primitives (**UI-02**). |
| **AUD-05** | **High** | Accessibility / Touch | `SmartStoreCardView.tsx` & interactive icon buttons across 108 `<button>` elements | Chip remove (`×`) and quantity stepper (`−`/`+`) buttons in `SmartStoreCardView.tsx` have no minimum touch area (rendering ~14×16px on mobile `360px`, far below the 44×44px minimum). | Enforce `min-h-11 min-w-11` (44×44px) on all interactive touch targets and verify `aria-label` on icon-only buttons (**UI-02**, **UI-06**, **UI-12**). |
| **AUD-06** | **High** | Responsiveness / Chat UX | `pages/Ai.tsx`, `AiChat.css`, `features/ai/ChatComposer.tsx` | `AiChat.css` (2,697 lines) manages chat layout, composer, and sidebar with complex overrides; requires streamlined mobile `360px` composer pinning, unified card anatomy across all 15+ chat card components, and distinct receipt vs proposal styling. | Unify chat shell & composer (**UI-04**) and standardize all chat card anatomy (**UI-05**). |
| **AUD-07** | **Medium** | Copy / Localization | `pages/admin/AdminLegalReadiness.tsx:838,938,969,1025,1048,1189,1550`, `pages/Connect.tsx:326,437`, `index.html:7` | English placeholder strings (`JO-LAW-REFERENCE-01`, `REGISTRATION, LICENSE`, `TERMS=2.1, PRIVACY=3.0`, `shop.example.com`) appear in Arabic forms; `<title>` leads with English `JassimAI`. | Localize admin/Connect placeholders where appropriate and align copy in `docs/ui-glossary.md` (**UI-11**, **UI-14**). |
| **AUD-08** | **Medium** | Market & Plan Surfaces | `pages/Home.tsx`, `features/WhopPayment.tsx`, `pages/admin/AdminArabMarkets.tsx` | Pre-legal markets (`operationMode=PRE_LEGAL`, `legalApprovalStatus=PENDING`) need a clear, honest compact badge («تشغيل تقني — الدفع نقدًا فقط») without implying legal approval, and clean separation of technical vs legal status in Admin. | Implement honest market badge & server-driven plan surfaces (**UI-09**) and admin filters (**UI-11**). |

---

## 3. Leftover «دينار» Brand & English Copy Inventory

- **User-facing «دينار» brand strings:** **0 found** in rendered JSX (all `DINAR` occurrences in `src/` are internal wire enums such as `DINAR_GO`, `DINAR_PRO`, `DINAR_BUSINESS`, `INTERNAL_DINAR`, or developer code comments; user-facing labels already render «جاسم»).
- **English strings visible to users:**
  - `artifacts/dinar/index.html:7`: `<title>JassimAI — جاسم، مساعدك الذكي</title>`
  - `artifacts/dinar/src/pages/admin/AdminLegalReadiness.tsx` (lines 838, 938, 969, 1025, 1048, 1189, 1550): English code/ID placeholders (`JO-LAW-REFERENCE-01`, `REGISTRATION, LICENSE`, `TERMS=2.1, PRIVACY=3.0`, `REGISTRATION`, `JO-REGISTRY-DOC-2026-01`, `JO-REVIEW-2026-01`, `INC-2026-001`).
  - `artifacts/dinar/src/pages/Connect.tsx` (lines 326, 437): `shop.example.com`, `https://shop.example.com/catalog.json`.

---

## 4. Note on Screenshots & Browser Capture
- Live desktop/mobile screenshots (`360px` & `1440px`, light & dark) could not be captured automatically in this turn because the IDE webview browser is in `USER_TAKEOVER` and the Railway sandbox lacks Chromium (`NO_CHROMIUM`). Screenshots will be attached once Chromium/browser control is available.
