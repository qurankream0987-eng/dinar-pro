import { PLATFORM_FEE_BASIS_POINTS } from "./market-pricing";

/**
 * Versioned marketplace policy registry.
 *
 * Content is product wording, not legal advice. Every document carries
 * legalReviewStatus=PENDING_LEGAL_APPROVAL until launch-country counsel signs
 * off; publishing a new version means adding a new entry with a later
 * effectiveDate (old versions stay so recorded acceptances remain meaningful).
 */
export type PolicySection = { heading: string; body: string };
export type PolicyDocument = {
  key: string;
  version: string;
  effectiveDate: string;
  titleAr: string;
  titleEn: string;
  summaryAr: string;
  legalReviewStatus: "PENDING_LEGAL_APPROVAL" | "APPROVED";
  requiresAcceptance: boolean;
  sections: PolicySection[];
};

const feePercent = () =>
  (PLATFORM_FEE_BASIS_POINTS / 100).toLocaleString("en", {
    maximumFractionDigits: 2,
  });

/**
 * Retention decisions for account deletion. Periods are deliberately not
 * asserted: each requires launch-country legal review before public launch.
 */
export const DATA_RETENTION_POLICY = [
  {
    record: "orders, order items, order messages",
    handling: "RETAINED",
    reason: "Counterparty and dispute history must stay consistent.",
    period: "REQUIRES_LAUNCH_COUNTRY_REVIEW",
  },
  {
    record: "commission snapshots and seller dues",
    handling: "RETAINED",
    reason: "Accounting records for completed commerce.",
    period: "REQUIRES_LAUNCH_COUNTRY_REVIEW",
  },
  {
    record: "disputes, reports, moderation audit",
    handling: "RETAINED",
    reason: "Security, fraud-prevention and accountability records.",
    period: "REQUIRES_LAUNCH_COUNTRY_REVIEW",
  },
  {
    record: "profile name, phone, private location, avatar, password",
    handling: "ANONYMIZED_ON_DELETION",
    reason: "Not required once the account is closed.",
    period: "IMMEDIATE",
  },
  {
    record: "AI conversations, carts, sessions",
    handling: "DELETED_ON_DELETION",
    reason: "Not transaction records.",
    period: "IMMEDIATE",
  },
  {
    record: "active listings",
    handling: "ARCHIVED_ON_DELETION",
    reason: "Removed from discovery; rows kept because orders may reference them.",
    period: "REQUIRES_LAUNCH_COUNTRY_REVIEW",
  },
] as const;

function documents(): PolicyDocument[] {
  const pending = "PENDING_LEGAL_APPROVAL" as const;
  const effectiveDate = "2026-10-02";
  return [
    {
      key: "terms",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "شروط الاستخدام",
      titleEn: "Terms of Use",
      summaryAr: "القواعد العامة لاستخدام جاسم كسوق مفتوح بين البائعين والمشترين.",
      legalReviewStatus: pending,
      requiresAcceptance: true,
      sections: [
        {
          heading: "دور جاسم",
          body: "جاسم منصة تجمع البائعين والمشترين في كل سوق. البائع مسؤول عن عرضه ودقته وتسليمه، والمشتري مسؤول عن مراجعة العرض قبل الطلب.",
        },
        {
          heading: "الحساب",
          body: "أنت مسؤول عن سرية كلمة المرور وعن النشاط الذي يتم من حسابك. يجوز لإدارة السوق تقييد الحساب أو إيقافه عند مخالفة القواعد.",
        },
        {
          heading: "الطلبات والدفع",
          body: "يُنشأ طلب منفصل لكل بائع. في النسخة الحالية يتم الدفع مباشرة بين المشتري والبائع، ولا يجمع جاسم المبلغ أو يحوله، ولا يُعد إنشاء الطلب إثبات دفع.",
        },
        {
          heading: "المحتوى والسلوك",
          body: "يجب أن تلتزم العروض والرسائل بقواعد السوق وقائمة المنتجات المحظورة. يمكن لأي مستخدم الإبلاغ عن مخالفة.",
        },
        {
          heading: "بانتظار المراجعة القانونية",
          body: "هذه الصياغة نسخة منتج قبل المراجعة القانونية لدولة الإطلاق، وقد تتغير قبل الإطلاق العام.",
        },
      ],
    },
    {
      key: "privacy",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "سياسة الخصوصية",
      titleEn: "Privacy Policy",
      summaryAr: "ما البيانات التي نحفظها، ومن يراها، وكيف تحذف حسابك.",
      legalReviewStatus: pending,
      requiresAcceptance: true,
      sections: [
        {
          heading: "بيانات الحساب الخاصة",
          body: "رقم هاتف الحساب ومدينتك ومنطقتك في الملف الشخصي خاصة بك ولا تظهر في العروض العامة. لا نجمع البريد الإلكتروني حاليًا.",
        },
        {
          heading: "بيانات العرض العامة",
          body: "يظهر في العرض: اسم العرض ووصفه وصوره وسعره والمدينة والمنطقة العامة واسم البائع وصورته. رقم التواصل يظهر فقط إذا أضفته بنفسك للعرض.",
        },
        {
          heading: "موقع التسليم",
          body: "تعليمات التسليم في الطلب يراها طرفا الطلب فقط، وتراها إدارة السوق عند معالجة نزاع.",
        },
        {
          heading: "الاحتفاظ والحذف",
          body: "عند حذف الحساب نزيل بيانات الملف الشخصي ونغلق الجلسات ونؤرشف العروض. نحتفظ بسجلات الطلبات والعمولات والنزاعات والبلاغات لأنها سجلات معاملات وأمان؛ مدة الاحتفاظ بانتظار المراجعة القانونية لدولة الإطلاق.",
        },
      ],
    },
    {
      key: "marketplace-rules",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "قواعد السوق",
      titleEn: "Marketplace Rules",
      summaryAr: "ما يُتوقع من البائعين والمشترين، وكيف تعمل البلاغات والإشراف.",
      legalReviewStatus: pending,
      requiresAcceptance: false,
      sections: [
        {
          heading: "عروض صادقة",
          body: "صف ما تبيعه بدقة، واستخدم صورك الخاصة، وحدد الكمية والسعر الحقيقيين. لا تنشر عروضًا مكررة أو مضللة.",
        },
        {
          heading: "الموقع العام فقط",
          body: "اكتب المدينة والمنطقة العامة فقط في العرض. لا تكتب رقم المنزل أو الشارع أو رابط خريطة.",
        },
        {
          heading: "البلاغات",
          body: "يمكنك الإبلاغ عن عرض أو بائع أو طلب. البلاغ وحده لا يعني عقوبة؛ تراجع الإدارة كل بلاغ وتسجل قرارها.",
        },
        {
          heading: "إجراءات الإشراف",
          body: "قد تخفي الإدارة عرضًا أو تزيله، أو تقيد حسابًا (لا بيع ولا شراء جديد) أو توقفه. تبقى سجلات الطلبات السابقة محفوظة.",
        },
      ],
    },
    {
      key: "prohibited-items",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "المنتجات والخدمات المحظورة",
      titleEn: "Prohibited Items",
      summaryAr: "ما لا يُسمح بعرضه في بدينار، وكيف نطبق ذلك.",
      legalReviewStatus: pending,
      requiresAcceptance: false,
      sections: [
        {
          heading: "محظور في كل الأسواق",
          body: "الأسلحة والذخائر، المخدرات والمواد الخاضعة للرقابة، المنتجات المقلدة أو المسروقة، المحتوى الجنسي، بيع البيانات الشخصية أو الحسابات، الوثائق الرسمية، والخدمات غير القانونية.",
        },
        {
          heading: "مقيد حسب السوق",
          body: "قد تقيد بعض الأسواق فئات أو طرق تنفيذ إضافية وفق أنظمة الدولة. تظهر القيود عند النشر ويرفض الخادم العروض المخالفة.",
        },
        {
          heading: "حدود التطبيق الآلي",
          body: "يطبق جاسم قيودًا محددة على الفئات وأنواع العروض وطرق التنفيذ وبعض الكلمات المعروفة. هذا لا يضمن اكتشاف كل مخالفة، لذلك نعتمد أيضًا على البلاغات ومراجعة الإدارة.",
        },
      ],
    },
    {
      key: "fees",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "الرسوم والعمولة",
      titleEn: "Commission & Fees",
      summaryAr: `عمولة جاسم ${feePercent()}% على البائع من قيمة كل طلب مكتمل جديد.`,
      legalReviewStatus: pending,
      requiresAcceptance: false,
      sections: [
        {
          heading: "من يدفع",
          body: `يتحمل البائع عمولة جاسم بنسبة ${feePercent()}% من قيمة الطلب. لا يضيف جاسم أي رسوم على المشتري.`,
        },
        {
          heading: "متى تُحتسب",
          body: "تُثبَّت نسبة العمولة في الطلب لحظة إنشائه ولا تتغير بعد ذلك. تُسجل المستحقات عند اكتمال الطلب فقط (بما في ذلك نزاع يُحسم لصالح البائع)، ولا تُسجل للطلبات الملغاة أو التي يُحسم نزاعها لصالح المشتري.",
        },
        {
          heading: "الطلبات السابقة",
          body: "الطلبات التي أُنشئت قبل تحديث النسبة تحتفظ بنسبتها المسجلة وقت إنشائها.",
        },
        {
          heading: "السداد",
          body: "لا يتوفر سداد إلكتروني للمستحقات في النسخة الحالية.",
        },
      ],
    },
    {
      key: "sponsored-listings",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "العروض الممولة",
      titleEn: "Sponsored Listings",
      summaryAr: "كيف نميز العروض الممولة عن النتائج العادية.",
      legalReviewStatus: pending,
      requiresAcceptance: false,
      sections: [
        {
          heading: "تمييز واضح",
          body: "كل عرض يظهر بترتيب ممول يحمل شارة «إعلان ممول». لا نعرض الترويج المدفوع كنتيجة عادية.",
        },
        {
          heading: "الأهلية",
          body: "يظهر العرض الممول فقط إذا كان منشورًا ومطابقًا لبحثك وسوقك وفئته.",
        },
        {
          heading: "الحالة الحالية",
          body: "الترويج في هذه النسخة تجريبي ولا يتضمن أي دفع حقيقي.",
        },
      ],
    },
    {
      key: "disputes-refunds",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "النزاعات والاسترداد",
      titleEn: "Disputes & Refunds",
      summaryAr: "ماذا يحدث إذا لم يصل الطلب أو كان مختلفًا.",
      legalReviewStatus: pending,
      requiresAcceptance: false,
      sections: [
        {
          heading: "فتح نزاع",
          body: "بعد أن يرفع البائع إثبات التسليم، يمكن للمشتري تأكيد الاستلام أو فتح نزاع مع وصف المشكلة والأدلة.",
        },
        {
          heading: "قرار الإدارة",
          body: "تراجع إدارة السوق النزاع وتقرر إكمال الطلب أو إلغاءه. يُسجل القرار والسبب في سجل الطلب.",
        },
        {
          heading: "الاسترداد",
          body: "لأن الدفع يتم حاليًا مباشرة بين الطرفين، لا يجري جاسم استردادًا ماليًا. سياسة الاسترداد عبر مزود دفع ستُعلن قبل تفعيل الدفع داخل التطبيق.",
        },
      ],
    },
    {
      key: "account-deletion",
      version: "2026-10-02",
      effectiveDate,
      titleAr: "حذف الحساب والبيانات",
      titleEn: "Account & Data Deletion",
      summaryAr: "كيف تحذف حسابك وما الذي نحتفظ به.",
      legalReviewStatus: pending,
      requiresAcceptance: false,
      sections: [
        {
          heading: "كيف تحذف حسابك",
          body: "من الإعدادات اختر «حذف الحساب» وأدخل كلمة المرور. يجب إنهاء الطلبات والنزاعات المفتوحة أولًا.",
        },
        {
          heading: "ما يحدث فورًا",
          body: "تُغلق كل الجلسات، وتُؤرشف عروضك، ويُزال اسمك ورقمك وموقعك الخاص وصورتك، وتُحذف محادثاتك مع المساعد وسلتك.",
        },
        {
          heading: "ما نحتفظ به",
          body: "سجلات الطلبات والعمولات والنزاعات والبلاغات تبقى لأنها سجلات معاملات وأمان، وتظهر فيها بيانات الطلب كما كانت وقت إنشائه. مدة الاحتفاظ بانتظار المراجعة القانونية.",
        },
        {
          heading: "لا يمكن التراجع",
          body: "الحذف نهائي. يمكنك لاحقًا إنشاء حساب جديد.",
        },
      ],
    },
    {
      // JassimAI privacy notice. Every statement below is grounded in the current code (Google
      // identity storage, AI conversation processing, opt-in memory, SMS verification); items
      // marked «بانتظار» need the owner's or counsel's confirmation before the legal sign-off.
      key: "privacy",
      version: "2026-11-13",
      effectiveDate: "2026-11-13",
      titleAr: "سياسة الخصوصية — JassimAI",
      titleEn: "JassimAI Privacy Policy",
      summaryAr: "ما البيانات التي يحفظها JassimAI (جاسم، سابقًا جاسم)، ولماذا، ومع من تُشارك، وكيف تطلب حذفها.",
      legalReviewStatus: pending,
      requiresAcceptance: true,
      sections: [
        {
          heading: "من نحن",
          body: "JassimAI (جاسم) مساعد ذكي بالعربية يساعدك في المحادثة العامة وفي البيع والشراء داخل سوق JassimAI. تنطبق هذه السياسة على الموقع jassimai.com وتطبيقه.",
        },
        {
          heading: "بيانات الحساب",
          body: "نحفظ رقم هاتفك بعد التحقق منه برسالة نصية، واسم العرض الذي تختاره، ومدينتك ومنطقتك إن أضفتها، وكلمة المرور بصيغة مشفّرة غير قابلة للاسترجاع. رقم الهاتف والمدينة والمنطقة في ملفك الشخصي خاصة ولا تظهر في العروض العامة.",
        },
        {
          heading: "تسجيل الدخول بحساب Google",
          body: "إذا اخترت الدخول بحساب Google نطلب فقط الهوية الأساسية (openid والبريد الإلكتروني والملف العام). نتحقق من الرمز الذي يرسله Google، ثم نحفظ معرّف حسابك في Google وبريدك الإلكتروني المؤكد لربطهما بحسابك، بعد التحقق من رقم هاتفك. لا نطلب الوصول إلى بريدك أو ملفاتك أو أي خدمة أخرى في Google، ولا نستخدم بيانات Google للإعلانات، ولا نرسل بريدك أو معرّفك في Google إلى مزودي نماذج الذكاء الاصطناعي.",
        },
        {
          heading: "محادثات الذكاء الاصطناعي",
          body: "نحفظ رسائلك وردود جاسم في سجل المحادثة لتتابعها وليفهم جاسم السياق داخل المحادثة نفسها. لتوليد الرد يُرسَل نص رسالتك وجزء محدود من سياق المحادثة إلى مزوّد نموذج ذكاء اصطناعي يعمل لصالحنا. التذكّر بين المحادثات المختلفة مطفأ افتراضيًا ولا يعمل إلا إذا فعّلته بنفسك، ويمكنك إيقافه في أي وقت. لا تكتب في المحادثة بيانات حساسة لا تريد معالجتها.",
        },
        {
          heading: "بيانات العروض والطلبات",
          body: "يظهر في العرض المنشور: اسمه ووصفه وصوره وسعره والمدينة والمنطقة العامة واسم البائع وصورته. رقم التواصل لا يظهر إلا إذا أضفته بنفسك للعرض. تعليمات التسليم في الطلب يراها طرفا الطلب فقط، وتراها إدارة السوق عند معالجة نزاع. في النسخة الحالية لا يجمع JassimAI المدفوعات ولا يحفظ بيانات بطاقات الدفع.",
        },
        {
          heading: "ملفات تعريف الارتباط",
          body: "نستخدم ملفات ارتباط ضرورية لتشغيل الخدمة: ملف الجلسة لإبقائك مسجّلًا، وملف قصير العمر (عشر دقائق) لإكمال الدخول بحساب Google.",
        },
        {
          heading: "مع من تُشارك البيانات",
          body: "لا نبيع بياناتك. نشارك ما يلزم فقط مع مزودين يعملون لصالحنا: مزوّد الرسائل النصية لإرسال رمز التحقق إلى رقمك، ومزوّد نموذج الذكاء الاصطناعي لمعالجة نص المحادثة، وGoogle عند اختيارك الدخول بحسابه، ومزوّد الاستضافة وتخزين الصور الذي يشغّل الخدمة.",
        },
        {
          heading: "طلباتك والحذف",
          body: "يمكنك من حسابك طلب الاطلاع على بياناتك أو تصديرها أو تصحيحها أو حذف حسابك. عند حذف الحساب نزيل بيانات الملف الشخصي ونغلق الجلسات ونؤرشف العروض، ونحتفظ بسجلات الطلبات والعمولات والنزاعات والبلاغات لأنها سجلات معاملات وأمان؛ مدة الاحتفاظ بانتظار المراجعة القانونية لدولة الإطلاق.",
        },
        {
          heading: "الحماية",
          body: "تُنقل البيانات عبر اتصال مشفّر (HTTPS)، وتتحقق الخدمة من صلاحيتك على الخادم قبل عرض أي بيانات خاصة بحساب أو نشاط تجاري.",
        },
        {
          heading: "بانتظار المراجعة القانونية",
          body: "هذه الصياغة نسخة منتج قبل المراجعة القانونية لدولة الإطلاق. بيانات الجهة المالكة القانونية وبريد التواصل للخصوصية ستُضاف بعد اعتمادها.",
        },
      ],
    },
  ];
}

export function currentPolicies(): PolicyDocument[] {
  const byKey = new Map<string, PolicyDocument>();
  const today = new Date().toISOString().slice(0, 10);
  for (const document of documents()) {
    if (document.effectiveDate > today) continue;
    const current = byKey.get(document.key);
    if (!current || current.effectiveDate < document.effectiveDate)
      byKey.set(document.key, document);
  }
  return [...byKey.values()];
}

export function currentPolicy(key: string): PolicyDocument | undefined {
  return currentPolicies().find((document) => document.key === key);
}

export function registrationAcceptancePolicies() {
  return currentPolicies().filter((document) => document.requiresAcceptance);
}
