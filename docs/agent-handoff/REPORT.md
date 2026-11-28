# تقرير إنجاز وتسليم الفرع `agent/commerce-build`

## 1. ملخص تنفيذي
تم تنفيذ المتطلبات الهندسية المحددة في `docs/agent-handoff/GOOGLE-AGENT-BRIEF.md` ووثيقة فصل المدفوعات `docs/payments/PAYMENT-SEPARATION-AR.md` فوق الفرع الأساسي `claude/merchant-policies-m1`، مع الالتزام الكامل بعدم إعادة كتابة أي نظام قائم (`M1`, `deal-payments`, `subscription-billing`, `seller-classification`)، وعدم لمس بيئة الإنتاج أو Staging أو قاعدة البيانات الحية.

---

## 2. ما تم إنجازه بالتفصيل

### أولًا: التدقيق المسبق (`docs/agent-handoff/AUDIT.md`)
- تم إيداع ملف التدقيق المسبق في الالتزام `96c8e80` قبل أي تعديل برمجي، موثقًا نقاط الربط الدقيقة مع `M1` و`deal-payments` و`0080`.

### ثانيًا: البند `§4E` — حيادية مزود الدفع لإعلانات جاسم (Provider-Neutral Jassim Ads)
1. **إعادة تعريف الترحيل `0080_promotion_whop_direct.sql` في مكانه** (كونه غير منشور):
   - استبدال `WHOP_LIVE` بـ `PROVIDER_LIVE`، و`WHOP_DIRECT` بـ `PROVIDER_DIRECT`.
   - إلزامية العمود `payment_provider_key` عندما يكون `payment_source = 'PROVIDER_DIRECT'` عبر القيد `listing_promotions_provider_key_required`.
   - تحديث `lib/db/src/schema/index.ts`، و`docs/jassim-ads-phase2/rollback-0080.sql`، و`lib/db/drizzle/release-manifest.json`، و`lib/db/src/clone-migration-guard.ts`.
2. **واجهة وسجل موحد لمزود دفع الإعلانات (`artifacts/api-server/src/lib/promotion-billing.ts`):**
   - تعريف `PromotionBillingProvider` مع سجل (`registerPromotionBillingProvider`, `getPromotionBillingProvider`) على غرار `SubscriptionBillingProvider`.
   - تسجيل Whop كمزود واحد (`providerKey: "whop"`) داخل `lib/billing/whop.ts`، وجعل `lib/promotion-whop.ts` طبقة توافق رقيقة تعيد التصدير من `promotion-billing.ts`.
   - تحديث السياسة التجارية (`advertisingBillingActivation: "DISABLED" | "PROVIDER_DIRECT"` مع `advertisingBillingProvider`)، وتحديث حقل المحادثة إلى `payload.providerPayment = { providerKey, displayName, note }` في `openapi.yaml` وتوليد الأنواع عبر `orval`.
   - إضافة اختبار المزود الوهمي الثاني `artifacts/api-server/test/promotion-provider-neutral.test.ts` لإثبات استبدال Whop دون تعديل كود الإعلانات.

### ثالثًا: البند `§4C` — إغلاق فجوتي Jassim Ads
1. تحديث `DEFAULT_BLOCKED_COUNTRIES` في `artifacts/api-server/src/lib/whop/config.ts` ليشمل الدول العربية المحظورة (`IQ, SY, LY, YE, SD, SO, KM, PS`).
2. إيقاف ظهور الحملات المدفوعة (`PROVIDER_LIVE`) فورًا في `promotions.ts` و`welcome-ads.ts` عند سحب الموافقة القانونية `ELECTRONIC_PAYMENT` للسوق.

### رابعًا: البند `§4A` (M2) — إنفاذ سياسات المتجر على الطلبات والمحادثة والبطاقات
1. **وسم مصدر المعلومة (`artifacts/api-server/src/ai/fact-provenance.ts`):**
   - `STORE_SYSTEM` («من نظام المتجر»)
   - `MERCHANT_POLICY` («من سياسة التاجر — الإصدار N»)
   - `UNCONFIRMED` («غير مؤكد من المتجر»)
   - `NEEDS_MERCHANT_APPROVAL` («يحتاج موافقة التاجر»)
2. **محرك إنفاذ السياسات (`artifacts/api-server/src/lib/merchant-policies/enforcement.ts`):**
   - تطبيق `ORDERING_PAUSED`، `GEO_RESTRICTION`، `MIN_ORDER`، `SHIPPING` (مع حفظ لقطة الشحن `shippingPolicy` داخل الطلب دون المساس بـ `subtotalMinor` أو عمولة المنصة)، و`OUT_OF_STOCK` + `ALTERNATIVES`، و`COD_AREAS`.
   - ربط الإنفاذ في `routes/marketplace.ts` (`checkout()`)، و`lib/deal-payments/service.ts` (`acceptedFor`, `codAvailability`)، و`ai/action-foundation.ts` (`readServerSnapshot`, `PLACE_ORDER`).
3. **مؤلف بطاقة خيارات الدفع الموحدة (`artifacts/api-server/src/lib/merchant-policies/payment-options.ts`):**
   - يجمع في بطاقة `PAYMENT_OPTIONS` واحدة لكل طلب: سياسة `PAYMENT_METHODS`، وسائل البائع المباشرة (`seller_payment_methods`)، التحقق من `COD_AREAS`، وبوابة المتجر فقط عند تفعيل `PAYMENT_GATEWAY` ووجود محول فعّال يدعم الدولة والعملة والمبلغ.
4. **واجهة بطاقة مراجعة السياسات (`artifacts/dinar/src/features/ai/MerchantPolicyReviewPanel.tsx`):**
   - واجهة عربية RTL متجاوبة تدعم التأكيد عبر `POST /api/merchant-policies/:id/confirm` مع `expectedVersion`، وإلغاء المسودة، وعرض التعارضات، وتنبيه إعادة تسجيل الدخول للسياسات عالية الحساسية (`HIGH_RISK`).

### خامسًا: البند `§4B` (M3) — محول بوابة دفع المتجر بالمحاكاة فقط + الترحيل `0084`
1. **الترحيل الإضافي `lib/db/drizzle/0084_store_checkout_sessions.sql` والمخطط `lib/db/src/schema/store-checkout.ts`:**
   - جداول `store_checkout_adapters`، `store_checkout_sessions`، و`store_checkout_webhook_events`.
2. **محولات الدفع (`artifacts/api-server/src/lib/store-checkout/`):**
   - `types.ts`: واجهة `StoreCheckoutAdapter` وفحص توافق الدولة والعملة وحدود المبلغ.
   - `simulated-adapter.ts`: `SimulatedStoreGatewayAdapter` محمي خلف العلم الاختباري `DINAR_SIMULATED_STORE_GATEWAY=true` حصريًا في غير بيئة الإنتاج.
   - `custom-openapi-adapter.ts`: `CustomOpenApiStoreAdapter` مبني فوق `connect/api-connector.ts` مع استخراج الحقول عبر JSON Pointers.
   - `service.ts` و`routes/store-checkout.ts`: إنشاء جلسات الدفع، التحقق الصارم من إشعارات الـWebhook الموقّعة (`HMAC-SHA256` + منع التكرار + إعادة قراءة حالة الجلسة من المزود + مطابقة الطلب والمبلغ والعملة قبل تحويل الحالة إلى `PAID`)، وواجهات البطاقات في `artifacts/dinar/src/features/ai/StorePaymentPanels.tsx` المربوطة بـ `ConversationContent.tsx`.
