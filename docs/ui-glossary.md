# JassimAI Arabic UI Copy Glossary (UI-14)

## 1. Brand Naming Rules
- **Always use:** «جاسم» or «JassimAI» (and «جاسم كونيكت» / «Jassim Connect» for the merchant partner platform).
- **Never use:** «دينار» or «DINAR» as the platform brand name. «دينار» may appear **only** when referring to a country's actual currency (e.g., دينار كويتي، دينار أردني، دينار بحريني، دينار عراقي).

## 2. Canonical Commerce & Platform Terms
| Concept | Canonical Arabic Term | Avoid |
|---|---|---|
| Marketplace listing / offer | **عرض** (جمع: **عروض**) | إعلان (إلا للإعلان الممول) |
| Paid / promoted listing | **إعلان ممول** | إعلان مدفوع / Sponsored |
| Order | **طلب** (جمع: **طلبات**) | طلبية (تُوحَّد إلى «طلب») |
| Buyer | **مشتري** | عميل / زبون (في سياق الطلب) |
| Individual seller | **بائع** / **بائع فرد** | — |
| Business merchant | **تاجر** / **متجر موثّق** | — |
| Storefront | **متجر** | — |
| Country market | **سوق** (مثل: سوق الكويت) | — |
| Technical-only market (`PRE_LEGAL`) | **تشغيل تقني — الدفع نقدًا فقط** | قريبًا (إذا كان مفتوحًا تقنيًا) |
| Refund obligation | **التزام استرداد** | obligation |

## 3. Error & Status Message Rules
1. **Short & actionable:** State what happened and what the user should do next (1–2 sentences max).
2. **Never fabricate success:** Pending payment or submission states must say «بانتظار تأكيد...» until the server confirms.
3. **Zero English leaks:** Technical terms (`obligation`, `sandbox`, raw status enums) must never appear raw in user-facing Arabic copy.
4. **Numbers & currencies:** Always wrap numeric amounts, phone numbers, and reference codes in `<bdi dir="ltr">` with `tabular-nums`, and always read prices/currencies from the server.

## 4. Fixes Applied in This Pass
- Fixed leaked English word `obligation` → `التزام استرداد كامل` in `artifacts/dinar/src/features/WhopPayment.tsx`.
- Verified zero remaining «دينار» brand leaks across `artifacts/dinar/src/pages/` and `artifacts/dinar/src/features/`.