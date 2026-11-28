/**
 * Country configuration and payment-method catalog for deal payment agreements.
 *
 * JassimAI only arranges how buyer and seller settle; it never receives, holds or settles money.
 * The catalog therefore says which ways of paying a seller JassimAI may OFFER as a choice in a
 * country, never that a provider is licensed or approved. The seed below is deliberately
 * conservative:
 *   - Cash (in person or on delivery) and the seller's own bank transfer are generic practices,
 *     offered everywhere except where banking is disrupted or sanctioned (UNDER_REVIEW there).
 *   - Named local instant schemes and wallets stay UNDER_REVIEW until an admin records a source
 *     and switches them to ACTIVE (DB constraint: ACTIVE requires a source reference). CliQ in
 *     Jordan is the one exception: it was already offered by the existing settlement code.
 * Admin changes live in deal_payment_catalog_changes (append-only, latest row wins), so a country
 * or method changes without a deploy. One unavailable country or method never disables the others.
 */
import { desc } from "drizzle-orm";
import { db, dealPaymentCatalogChanges } from "@workspace/db";

export const CATALOG_STATUSES = ["ACTIVE", "LIMITED", "UNAVAILABLE", "UNDER_REVIEW"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];
export type MethodKind = "DIRECT" | "COD";

export type MethodDefinition = {
  code: string;
  labelAr: string;
  kind: MethodKind;
  /** Instruction fields a seller may give for this method (all optional; none invented). */
  instructionFields: readonly InstructionField[];
  /** Arabic words a person may use for this method in chat (normalised, no diacritics). */
  aliases: readonly string[];
  /**
   * Card schemes such as KNET are paid through a merchant checkout, never a personal card number:
   * the seller must provide their own merchant payment link, shown as the seller's link — not as a
   * JassimAI-integrated checkout.
   */
  requiresMerchantCheckout?: boolean;
};
export type InstructionField = "beneficiaryName" | "alias" | "phone" | "iban" | "accountNumber" | "bankName" | "walletProvider" | "walletNumber" | "paymentLink" | "note";

export type CountryMethod = { code: string; status: CatalogStatus; source: string | null; note?: string };
export type CountryConfig = {
  countryCode: string;
  nameAr: string;
  currencyCode: string;
  currencySymbolAr: string;
  languages: readonly string[];
  status: CatalogStatus;
  note?: string;
  methods: readonly CountryMethod[];
};

const TRANSFER_FIELDS = ["beneficiaryName", "bankName", "iban", "accountNumber", "note"] as const;
const ALIAS_FIELDS = ["beneficiaryName", "alias", "phone", "note"] as const;
const WALLET_FIELDS = ["beneficiaryName", "walletProvider", "walletNumber", "phone", "note"] as const;

export const METHODS: Record<string, MethodDefinition> = {
  CASH_IN_PERSON: { code: "CASH_IN_PERSON", labelAr: "كاش عند التسليم يدًا بيد", kind: "DIRECT", instructionFields: ["note"], aliases: ["كاش يد بيد", "كاش يدا بيد", "نقدا يدا بيد", "يدا بيد", "يد بيد", "كاش عند الاستلام الشخصي"] },
  COD: { code: "COD", labelAr: "الدفع نقدًا عند الاستلام", kind: "COD", instructionFields: ["note"], aliases: ["كاش", "الكاش", "نقدا", "نقد", "نقدي", "عند الاستلام", "الدفع عند الاستلام", "كاش عند الاستلام", "cod", "cash"] },
  BANK_TRANSFER: { code: "BANK_TRANSFER", labelAr: "تحويل بنكي", kind: "DIRECT", instructionFields: TRANSFER_FIELDS, aliases: ["تحويل بنكي", "حواله بنكيه", "التحويل البنكي", "تحويل للحساب", "بنك"] },
  CLIQ: { code: "CLIQ", labelAr: "كليك (CliQ)", kind: "DIRECT", instructionFields: ALIAS_FIELDS, aliases: ["كليك", "كلك", "cliq", "click"] },
  INSTAPAY: { code: "INSTAPAY", labelAr: "إنستاباي (InstaPay)", kind: "DIRECT", instructionFields: ALIAS_FIELDS, aliases: ["انستاباي", "انستا باي", "instapay"] },
  SARIE_INSTANT: { code: "SARIE_INSTANT", labelAr: "التحويل الفوري (سريع)", kind: "DIRECT", instructionFields: TRANSFER_FIELDS, aliases: ["سريع", "تحويل فوري"] },
  AANI: { code: "AANI", labelAr: "آني (Aani)", kind: "DIRECT", instructionFields: ALIAS_FIELDS, aliases: ["اني", "aani"] },
  WAMD: { code: "WAMD", labelAr: "ومض (WAMD)", kind: "DIRECT", instructionFields: ALIAS_FIELDS, aliases: ["ومض", "wamd"] },
  FAWRAN: { code: "FAWRAN", labelAr: "فوران (Fawran)", kind: "DIRECT", instructionFields: ALIAS_FIELDS, aliases: ["فوران", "fawran"] },
  FAWRI_PLUS: { code: "FAWRI_PLUS", labelAr: "فوري+ (Fawri+)", kind: "DIRECT", instructionFields: TRANSFER_FIELDS, aliases: ["فوري بلس", "فوري+"] },
  BENEFIT_PAY: { code: "BENEFIT_PAY", labelAr: "بنفت باي (BenefitPay)", kind: "DIRECT", instructionFields: WALLET_FIELDS, aliases: ["بنفت", "بنفت باي", "benefitpay"] },
  STC_PAY: { code: "STC_PAY", labelAr: "STC Pay", kind: "DIRECT", instructionFields: WALLET_FIELDS, aliases: ["stc pay", "اس تي سي باي"] },
  KNET: { code: "KNET", labelAr: "كي نت (KNET)", kind: "DIRECT", instructionFields: ["beneficiaryName", "paymentLink", "note"], aliases: ["كي نت", "كي-نت", "knet"], requiresMerchantCheckout: true },
  LOCAL_WALLET: { code: "LOCAL_WALLET", labelAr: "محفظة إلكترونية محلية", kind: "DIRECT", instructionFields: WALLET_FIELDS, aliases: ["محفظه", "محفظه الكترونيه", "المحفظه"] },
  OTHER_AGREED: { code: "OTHER_AGREED", labelAr: "وسيلة أخرى يتفق عليها الطرفان", kind: "DIRECT", instructionFields: ["note"], aliases: [] },
};

const GENERIC = (bank: CatalogStatus = "ACTIVE", bankNote?: string): CountryMethod[] => [
  { code: "CASH_IN_PERSON", status: "ACTIVE", source: "GENERIC_PRACTICE" },
  { code: "COD", status: "ACTIVE", source: "GENERIC_PRACTICE" },
  { code: "BANK_TRANSFER", status: bank, source: bank === "ACTIVE" ? "GENERIC_PRACTICE" : null, ...(bankNote ? { note: bankNote } : {}) },
  { code: "LOCAL_WALLET", status: "UNDER_REVIEW", source: null, note: "لم يُتحقق من محافظ بعينها في هذا البلد." },
  { code: "OTHER_AGREED", status: "LIMITED", source: "GENERIC_PRACTICE", note: "تُعتمد فقط بعد موافقة البائع على الوسيلة المقترحة." },
];
const unverified = (code: string, note = "اسم معروف للنظام المحلي؛ لم يُسجَّل مصدر تحقق بعد."): CountryMethod => ({ code, status: "UNDER_REVIEW", source: null, note });
const DISRUPTED = "القطاع المصرفي أو التحويلات الدولية متأثرة بعقوبات أو اضطراب؛ يحتاج مراجعة قبل العرض.";

const country = (countryCode: string, nameAr: string, currencyCode: string, currencySymbolAr: string, status: CatalogStatus, methods: CountryMethod[], note?: string, languages: string[] = ["ar"]): CountryConfig =>
  ({ countryCode, nameAr, currencyCode, currencySymbolAr, languages, status, methods, ...(note ? { note } : {}) });

/** Seed configuration for the 22 Arab League countries. */
export const COUNTRY_SEED: readonly CountryConfig[] = [
  country("JO", "الأردن", "JOD", "د.أ", "ACTIVE", [...GENERIC(), { code: "CLIQ", status: "ACTIVE", source: "EXISTING_DINAR_SETTLEMENT_CATALOG (CliQ, Central Bank of Jordan / JoPACC)" }]),
  country("SA", "السعودية", "SAR", "ر.س", "LIMITED", [...GENERIC(), unverified("SARIE_INSTANT"), unverified("STC_PAY")]),
  country("AE", "الإمارات", "AED", "د.إ", "LIMITED", [...GENERIC(), unverified("AANI")], undefined, ["ar", "en"]),
  country("KW", "الكويت", "KWD", "د.ك", "LIMITED", [...GENERIC(), unverified("WAMD"), unverified("KNET", "شبكة بطاقات: تحتاج صفحة دفع تجارية للبائع، لا بطاقة شخصية.")]),
  country("QA", "قطر", "QAR", "ر.ق", "LIMITED", [...GENERIC(), unverified("FAWRAN")]),
  country("BH", "البحرين", "BHD", "د.ب", "LIMITED", [...GENERIC(), unverified("FAWRI_PLUS"), unverified("BENEFIT_PAY")]),
  country("OM", "عُمان", "OMR", "ر.ع", "LIMITED", GENERIC()),
  country("IQ", "العراق", "IQD", "د.ع", "LIMITED", GENERIC("UNDER_REVIEW", DISRUPTED), undefined, ["ar", "ku"]),
  country("PS", "فلسطين", "ILS", "₪", "LIMITED", GENERIC("UNDER_REVIEW", "تعدد العملات (شيكل/دينار/دولار) وقيود مصرفية؛ يحتاج مراجعة."), "العملة الافتراضية الشيكل؛ تُستخدم عملات أخرى فعليًا."),
  country("LB", "لبنان", "LBP", "ل.ل", "LIMITED", GENERIC("UNDER_REVIEW", "أزمة مصرفية؛ يحتاج مراجعة."), "التسعير بالدولار شائع فعليًا."),
  country("SY", "سوريا", "SYP", "ل.س", "LIMITED", GENERIC("UNDER_REVIEW", DISRUPTED)),
  country("EG", "مصر", "EGP", "ج.م", "LIMITED", [...GENERIC(), unverified("INSTAPAY")]),
  country("SD", "السودان", "SDG", "ج.س", "LIMITED", GENERIC("UNDER_REVIEW", DISRUPTED)),
  country("LY", "ليبيا", "LYD", "د.ل", "LIMITED", GENERIC("UNDER_REVIEW", DISRUPTED)),
  country("TN", "تونس", "TND", "د.ت", "LIMITED", GENERIC(), undefined, ["ar", "fr"]),
  country("DZ", "الجزائر", "DZD", "د.ج", "LIMITED", GENERIC(), undefined, ["ar", "fr"]),
  country("MA", "المغرب", "MAD", "د.م", "LIMITED", GENERIC(), undefined, ["ar", "fr"]),
  country("MR", "موريتانيا", "MRU", "أ.م", "LIMITED", GENERIC(), undefined, ["ar", "fr"]),
  country("YE", "اليمن", "YER", "ر.ي", "LIMITED", GENERIC("UNDER_REVIEW", DISRUPTED)),
  country("SO", "الصومال", "SOS", "ش.ص", "LIMITED", GENERIC("UNDER_REVIEW", DISRUPTED), undefined, ["ar", "so"]),
  country("DJ", "جيبوتي", "DJF", "ف.ج", "LIMITED", GENERIC(), undefined, ["ar", "fr"]),
  country("KM", "جزر القمر", "KMF", "ف.ق", "LIMITED", GENERIC(), undefined, ["ar", "fr"]),
];

const SEED_BY_COUNTRY = new Map(COUNTRY_SEED.map((entry) => [entry.countryCode, entry]));

export type ResolvedMethod = {
  code: string;
  labelAr: string;
  kind: MethodKind;
  status: CatalogStatus;
  source: string | null;
  note: string | null;
  currencies: string[];
  instructionFields: readonly InstructionField[];
};
export type ResolvedCountry = Omit<CountryConfig, "methods"> & { methods: ResolvedMethod[] };

type Change = typeof dealPaymentCatalogChanges.$inferSelect;

/** The seed with every admin change applied; latest change per (country, method) wins. */
export async function resolveCountry(countryCode: string, tx: any = db): Promise<ResolvedCountry | null> {
  const seed = SEED_BY_COUNTRY.get(countryCode);
  const changes: Change[] = await tx
    .select()
    .from(dealPaymentCatalogChanges)
    .orderBy(desc(dealPaymentCatalogChanges.createdAt), desc(dealPaymentCatalogChanges.id));
  const mine = changes.filter((row) => row.countryCode === countryCode);
  if (!seed && !mine.length) return null;
  const latest = new Map<string, Change>();
  for (const row of mine) {
    const key = row.methodCode ?? "";
    if (!latest.has(key)) latest.set(key, row);
  }
  const countryChange = latest.get("");
  const base: CountryConfig = seed ?? { countryCode, nameAr: countryCode, currencyCode: "", currencySymbolAr: "", languages: ["ar"], status: "UNDER_REVIEW", methods: [] };
  const codes = new Set([...base.methods.map((m) => m.code), ...[...latest.keys()].filter(Boolean)]);
  const methods: ResolvedMethod[] = [];
  for (const code of codes) {
    const seeded = base.methods.find((m) => m.code === code);
    const change = latest.get(code);
    const definition = METHODS[code];
    const labelAr = change?.labelAr ?? definition?.labelAr;
    const kind = (change?.kind as MethodKind | null) ?? definition?.kind;
    if (!labelAr || !kind) continue;
    methods.push({
      code,
      labelAr,
      kind,
      status: (change?.status as CatalogStatus | undefined) ?? seeded?.status ?? "UNDER_REVIEW",
      source: change ? change.sourceReference : seeded?.source ?? null,
      note: change ? change.reason : seeded?.note ?? null,
      currencies: change?.currencies ?? [base.currencyCode],
      instructionFields: definition?.instructionFields ?? ["note"],
    });
  }
  return { ...base, status: (countryChange?.status as CatalogStatus | undefined) ?? base.status, methods };
}

/**
 * Methods JassimAI may offer in a country for a currency: the country must not be UNAVAILABLE or
 * UNDER_REVIEW, and the method must be ACTIVE or LIMITED there.
 */
export function offerableMethods(country: ResolvedCountry | null, currencyCode: string): ResolvedMethod[] {
  if (!country || country.status === "UNAVAILABLE" || country.status === "UNDER_REVIEW") return [];
  return country.methods.filter((m) => (m.status === "ACTIVE" || m.status === "LIMITED") && m.currencies.includes(currencyCode));
}

export function methodLabel(code: string, custom?: string | null) {
  if ((code === "OTHER_AGREED" || code.startsWith("DECLARED:")) && custom) return custom;
  if (code.startsWith("DECLARED:")) return code.slice("DECLARED:".length).replace(/_/g, " ");
  return METHODS[code]?.labelAr ?? code;
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Method codes named in a message, limited to the given candidates. «كاش» alone maps to COD when the
 * candidates contain COD and not CASH_IN_PERSON, and to CASH_IN_PERSON in the opposite case; when
 * both are candidates it is returned as AMBIGUOUS_CASH so Jassim asks instead of guessing.
 */
export function methodsInText(message: string, candidates: readonly string[]): { codes: string[]; ambiguousCash: boolean } {
  const text = ` ${normalize(message)} `;
  const found = new Set<string>();
  const has = (alias: string) => new RegExp(`(?:^|[\\s،,.؟?!])(?:و|ب|بال|ال)?${normalize(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s،,.؟?!]|$)`, "u").test(text);
  let bareCash = false;
  for (const code of Object.keys(METHODS)) {
    const definition = METHODS[code]!;
    for (const alias of [definition.labelAr, ...definition.aliases]) {
      if (!has(alias)) continue;
      if (code === "COD" && ["كاش", "الكاش", "نقدا", "نقد", "نقدي", "cash"].includes(alias) && !has("عند الاستلام")) bareCash = true;
      else found.add(code);
      break;
    }
  }
  if (bareCash && !found.has("COD") && !found.has("CASH_IN_PERSON")) {
    const cod = candidates.includes("COD");
    const inPerson = candidates.includes("CASH_IN_PERSON");
    if (cod && inPerson) return { codes: [...found].filter((c) => candidates.includes(c)), ambiguousCash: true };
    if (cod) found.add("COD");
    else if (inPerson) found.add("CASH_IN_PERSON");
    else found.add("COD");
  }
  return { codes: [...found], ambiguousCash: false };
}


// ── Open payment choice ────────────────────────────────────────────────────────────────────────
//
// The catalog guides; it does not forbid. Parties may agree on any direct method they name. What
// Jassim must never do is present a method as verified or integrated when it is not.

/**
 *  VERIFIED_METHOD                  offered in the country catalog with a recorded source
 *  UNDER_REVIEW                     known to the catalog for this country, not yet verified
 *  USER_DECLARED_METHOD             named by a party; not in this country's catalog
 *  UNSUPPORTED_FOR_THIS_TRANSACTION the country is closed, or the catalog marks it UNAVAILABLE here
 *  INTEGRATED_PROVIDER              a real, authorized technical integration — none exists today,
 *                                   so this value is never produced by the catalog
 */
export type MethodStanding = "VERIFIED_METHOD" | "USER_DECLARED_METHOD" | "UNDER_REVIEW" | "UNSUPPORTED_FOR_THIS_TRANSACTION" | "INTEGRATED_PROVIDER";
export const STANDING_LABELS_AR: Record<MethodStanding, string> = {
  VERIFIED_METHOD: "وسيلة معروفة في هذا البلد",
  UNDER_REVIEW: "قيد التحقق من توفرها",
  USER_DECLARED_METHOD: "وسيلة اتفق عليها الطرفان؛ لم يتحقق منها جاسم",
  UNSUPPORTED_FOR_THIS_TRANSACTION: "غير متاحة لهذه الصفقة",
  INTEGRATED_PROVIDER: "بوابة دفع متكاملة",
};

export const DECLARED_PREFIX = "DECLARED:";
export const isDeclared = (code: string) => code.startsWith(DECLARED_PREFIX);
/** A stable code for a method a party named that the catalog does not know (e.g. «زين كاش»). */
export function declaredCode(label: string) {
  const slug = normalize(label).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return slug ? `${DECLARED_PREFIX}${slug}` : null;
}
const DECLARED_FIELDS: readonly InstructionField[] = ["beneficiaryName", "walletProvider", "walletNumber", "phone", "accountNumber", "note"];

export function definitionFor(code: string, label?: string | null): MethodDefinition | null {
  if (METHODS[code]) return METHODS[code]!;
  if (!isDeclared(code)) return null;
  const name = label?.trim() || code.slice(DECLARED_PREFIX.length).replace(/_/g, " ");
  return { code, labelAr: name, kind: "DIRECT", instructionFields: DECLARED_FIELDS, aliases: [] };
}

export function methodStanding(country: ResolvedCountry | null, code: string, currencyCode: string): MethodStanding {
  if (!country || country.status === "UNAVAILABLE") return "UNSUPPORTED_FOR_THIS_TRANSACTION";
  if (isDeclared(code) || code === "OTHER_AGREED") return "USER_DECLARED_METHOD";
  const entry = country.methods.find((m) => m.code === code);
  if (!entry) return "USER_DECLARED_METHOD";
  if (entry.status === "UNAVAILABLE") return "UNSUPPORTED_FOR_THIS_TRANSACTION";
  if (entry.status === "UNDER_REVIEW") return "UNDER_REVIEW";
  if (!entry.currencies.includes(currencyCode)) return "USER_DECLARED_METHOD";
  return entry.source ? "VERIFIED_METHOD" : "UNDER_REVIEW";
}
export const negotiable = (standing: MethodStanding) => standing !== "UNSUPPORTED_FOR_THIS_TRANSACTION";
