# تجهيز إشعارات Firebase (FCM) — مسودة تنسيق للمالك وClaude

- **الفرع:** `google/ui-foundation` (مستند تصميم وتجهيز فقط — لا تعديل على كود التطبيق أو الخادم، ولا لمس لـ Railway).
- **الحالة:** جاهز لمراجعة Claude وتعبئة المفاتيح من قِبل المالك.

---

## 1. ما يضعه المالك في Firebase Console وRailway

1. في **Firebase Console**:
   - **إعدادات تطبيق الويب:** `Project Settings` ← `General` ← `Your apps` (تطبيق ويب).
   - **مفتاح إشعارات الويب (VAPID):** `Project Settings` ← `Cloud Messaging` ← `Web configuration` ← `Generate key pair`.
   - **حساب الخدمة للخادم:** `Project Settings` ← `Service accounts` ← `Generate new private key` (ملف JSON).

2. **أسماء المتغيرات في Railway** *(لا تُوضع القيم في الكود أبدًا)*:
   - **متغيرات الواجهة (`artifacts/dinar` — عامة لمتصفح العميل):**
     - `VITE_FIREBASE_API_KEY`
     - `VITE_FIREBASE_AUTH_DOMAIN`
     - `VITE_FIREBASE_PROJECT_ID`
     - `VITE_FIREBASE_MESSAGING_SENDER_ID`
     - `VITE_FIREBASE_APP_ID`
     - `VITE_FIREBASE_VAPID_KEY`
   - **متغيرات الخادم (`artifacts/api-server` — سرية في الخادم فقط):**
     - `FIREBASE_PROJECT_ID`
     - `FIREBASE_CLIENT_EMAIL`
     - `FIREBASE_PRIVATE_KEY` *(مع الانتباه لاستبدال `\n` بأسطر حقيقية عند القراءة في الخادم)*

---

## 2. ما يُقترح أن يراجعه وينفّذه Claude في الخادم (`artifacts/api-server` + `lib/db`)

1. **تخزين رموز الأجهزة (`lib/db`):**
   - جدول `push_tokens` (أو ما يراه Claude مناسبًا): `id`، `userId` (مرتبط بـ `users.id`)، `token` (فريد)، `platform` (`WEB`)، `createdAt`، `updatedAt`.
2. **نقاط النهاية (`artifacts/api-server`):**
   - `POST /api/notifications/fcm-token`: يتحقق من الجلسة (`actorId`)، ويحفظ/يحدّث `token` للمستخدم (مع حد أقصى لعدد الأجهزة لكل مستخدم وRate Limit).
   - `DELETE /api/notifications/fcm-token`: يحذف الرمز عند تسجيل الخروج.
3. **إرسال الإشعار (`artifacts/api-server/src/lib/notifications.ts`):**
   - تهيئة `firebase-admin` بشكل كسول وآمن (لا يتعطل الخادم إذا غابت المتغيرات).
   - عند إنشاء إشعار جديد (طلب، تفاوض، استفسار، رسالة)، يُرسل دفع FCM لأجهزة المستخدم المستهدف مع حذف أي رمز يعيد `messaging/registration-token-not-registered`.
   - **الخصوصية:** نص الإشعار مختصر ولا يحتوي بيانات مالية أو أرقام هاتف أو تفاصيل حساسة؛ الرابط يفتح المسار الداخلي فقط بعد التحقق من الجلسة.

---

## 3. ما سأنفّذه أنا في الواجهة (`artifacts/dinar/`) بعد إعلان «اكتمل الإطلاق»

*(على فرع مستقل `google/ui-fcm` في بيئة `development` فقط، بعد جاهزية مسار الخادم):*

1. **`artifacts/dinar/public/firebase-messaging-sw.js`:**
   - Service Worker خفيف لاستقبال إشعارات الخلفية وعرضها بالعربية (`dir: "rtl"`) مع فتح المحادثة أو الطلب عند النقر.
2. **`artifacts/dinar/src/lib/firebase-messaging.ts`:**
   - تحميل وتفعيل FCM **فقط** عند توفر `VITE_FIREBASE_API_KEY` و`VITE_FIREBASE_VAPID_KEY` (فشل صامت وآمن إن لم يُفعّل).
   - إرسال الرمز إلى `POST /api/notifications/fcm-token` وإزالته عند تسجيل الخروج.
3. **تجربة المستخدم لطلب الإذن:**
   - طلب إذن الإشعارات بأسلوب لطيف بعد تسجيل الدخول (من شريط/بطاقة اختيارية أو من الإعدادات) وليس كنافذة مفاجئة فور فتح الموقع، مع رسالة واضحة إذا كان الإذن مرفوضًا من المتصفح.
