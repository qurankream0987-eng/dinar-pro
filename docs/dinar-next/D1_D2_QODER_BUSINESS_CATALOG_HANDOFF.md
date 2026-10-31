# D2 → Qoder: عقد كتالوج الأنشطة التجارية الأصلي

**الوحدة:** `artifacts/api-server/src/lib/business-catalog-contract.ts`. الإصدار `BUSINESS_CATALOG_CONTRACT_VERSION = 1`، قراءة فقط ومكتوب الأنواع.

**المختبر:** الاختبار `D2-17` في `d1-d2-business-foundation.test.ts`.

**القاعدة:** عمل الكتالوج يقرأ حالة النشاط عبر هذه الوحدة فقط.
- لا يكتب `business_profiles` ولا `business_memberships` ولا `business_verification_*`؛ الكاتب الوحيد `lib/business-profiles.ts`.
- لا يستنتج التوثيق من الدفع أو من الاشتراك.

## 1. الحقائق الأربع المنفصلة (لا تُدمج)

| الحقيقة | القيم | من يكتبها | قراءتها في العقد |
|---|---|---|---|
| التوثيق | `DRAFT`، `DOCUMENTS_REQUIRED`، `PENDING_REVIEW`، `VERIFIED`، `REJECTED`، `SUSPENDED` | المتقدم حتى `PENDING_REVIEW`، والمراجع وحده بعدها | `BusinessIdentity.verification` و`verified` و`suspended` |
| النشر | `UNPUBLISHED`، `PUBLISHED`. النشر يتطلب `VERIFIED` (CHECK في القاعدة)، والإيقاف يلغيه | المالك الموثّق | `BusinessIdentity.published` و`publicationEligibility()` |
| العضوية | `APPLICANT`، `VERIFIED_OWNER`. أما `ADMIN` و`STAFF` فمعرّفان ولا يُمنحان بعد | الإنشاء والتوثيق | `businessMembershipOf()` |
| الخطة المدفوعة | اشتراك `DINAR_BUSINESS` حيّ مرتبط بالنشاط | سلطة الفوترة | `businessPlanStatus()`، مع `grantsOnlyWhileVerified: true` |

**النشر لا يتطلب خطة مدفوعة**، والخطة المدفوعة لا تكفي للنشر (`paidPlanRequired: false`).

## 2. الصلاحيات (`businessPermission`، دالة نقية)

| الإجراء | الشرط |
|---|---|
| `VIEW_PRIVATE`، `EDIT_PROFILE` | عضوية نشطة `APPLICANT` أو `VERIFIED_OWNER`، والنشاط ليس `REJECTED` |
| `PREPARE_CATALOG` | ما سبق، والنشاط غير موقوف. يجوز للمسودة، كإعلانات عادية لمالكها |
| `PUBLISH_CATALOG_AS_BUSINESS`، `PUBLISH_PROFILE`، `REQUEST_INTEGRATION`، `SUBSCRIBE_BUSINESS_PLAN` | `VERIFIED` غير موقوف، وعضوية `VERIFIED_OWNER` |
| كل إجراء لـ`ADMIN` أو `STAFF` | مرفوض (`ROLE_NOT_GRANTABLE`) حتى تعرّف مرحلة لاحقة طريقة المنح |

أسباب الرفض: `NOT_A_MEMBER`، `MEMBERSHIP_REVOKED`، `ROLE_NOT_GRANTABLE`، `NOT_VERIFIED`، `SUSPENDED`، `REJECTED`، `NOT_VERIFIED_OWNER`.

**استدعاء واحد للخادم:** `authorizeBusinessAction(userId, businessId, action)` يعيد `{ identity, decision }`. الغريب يتلقى `NOT_A_MEMBER`، وعلى المسار أن يرد 404.

## 3. ربط النشاط بالإعلانات (الإصدار 1: ضمني)

`businessListingAssociation(businessId)` يعيد `mode: "OWNER_MARKET_IMPLICIT"`: كتالوج النشاط هو إعلانات مالكه في سوق النشاط، بخدمات الإعلانات والمخزون القانونية نفسها، دون نسخ.

يعيد أيضًا:
- `listingIds`، و`publishedListingIds`؛
- `showAsBusiness`، وقيمته `true` فقط حين يحق للنشاط الظهور كنشاط.

**قرار لعمل الكتالوج وليس لـD2:**
- عمود `offers.business_id` صريح، وأي الإعلانات تتبع أي نشاط حين يملك المالك أكثر من نشاط.
- هذا ترحيل جديد يدخل تسلسل الترحيلات الموحّد، ولم يُضف هنا.

## 4. دورة الحياة

`BUSINESS_LIFECYCLE` جدول الانتقالات المسموحة ومن يجريها. لا انتقال آخر يكتبه أي مسار.

```
null → DRAFT → DOCUMENTS_REQUIRED → PENDING_REVIEW → VERIFIED ⇄ SUSPENDED
                      ↑                    │
                      └── REQUEST_DOCUMENTS ┘
              DOCUMENTS_REQUIRED/PENDING_REVIEW → REJECTED
```

## 5. ما لا يفعله العقد

- لا يوثّق نشاطًا، ولا يتجاوز غياب فاحص المستندات. VERIFY يرفض بـ`SCANNER_NOT_CONNECTED`.
- لا يكشف مستندات أو رقم السجل أو مسارات التخزين.
- لا ينشئ اشتراكًا ولا يقرأ أسعارًا.

## 6. اعتمادات التكامل مع W09

عند دمج W09، يجب ربط `VERIFIED` بسجل `seller_verification_profiles` (`ENHANCED`) عبر سلطة W09، وقراءة `market_compliance_settings` لمتطلبات المستندات. التفاصيل في `D1_D2_BUSINESS_VERIFICATION_SECURITY.md` §6.
