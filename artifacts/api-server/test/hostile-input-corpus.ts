/** Inputs shared by hostile-input-performance.test.ts and its golden-output capture. */
const zw = "​‌‍‏";
export const HOSTILE_INPUTS: Record<string, string> = {
  digitsSpaced: "رقمي " + "1 ".repeat(995),
  digitRun: "رقمي " + "7".repeat(1990),
  arabicIndicDigits: "أريد سيارة بسعر " + "٧ ".repeat(990),
  rangeRepeated: "من 1 الى 2 ".repeat(180),
  lessRepeated: "اقل من ".repeat(285),
  separators: "أريد هاتف" + "،,.؛-_/|".repeat(248),
  tabs: "أريد أبيع" + "\t ".repeat(990) + "x",
  zeroWidth: "أريد سيارة " + `س${zw}ي${zw}`.repeat(200),
  diacritics: "أُرِيدُ سَيَّارَةً " + "ـــَُِّْ".repeat(280),
  mixedIdentifiers: "أبيع " + "iPhone15ProMax-256GB_x2 ".repeat(80),
  categoryWords: "سيارة هاتف كنب شقة ".repeat(110),
  distinctWords: Array.from({ length: 400 }, (_, i) => `كلمة${String.fromCharCode(0x0627 + (i % 28))}${i}`).join(" "),
  emoji: "أريد هاتف " + "📱🚗🏠 ".repeat(400),
  latinSpam: "sell car phone sofa ".repeat(100),
};

/** Ordinary requests whose results must not change. */
export const LEGITIMATE_INPUTS: string[] = [
  "أبي سيارة مستعملة أقل من 8000 دينار",
  "ابحث عن كنب احمر في عمان",
  "أريد آيفون 15 برو ماكس 256GB",
  "عندكم جوال سامسونج A12؟",
  "أبيع سيارة كيا سيراتو 2015 بـ 7000",
  "أبيع هاتفي الآيفون 13 بسعر ٤٥٠",
  "أنا أصلح مكيفات، اعرض خدمتي بـ15",
  "أريد شقة مفروشة للإيجار في خلدا",
  "ابغى بروستد رخيص",
  "سيارة m3868fec",
  "تي شيرت أسود مقاس L",
  "أريد سيارة بيضاء ممشى أقل من 50 ألف",
  "من 100 الى 200 دينار",
  "أبيع كنبة زرقاء مستعملة بحالة ممتازة بسعر 120 دينار، الاستلام من الجبيهة",
  "أبيع لابتوب ديل XPS 13 رام 16 جيجا",
  "ابيع سيارتي هونداي النترا 2018",
  "بدي غسالة اوتوماتيك",
  "عندي تيشيرت مقاس XL للبيع",
  "أريد خدمة تنظيف منازل",
  "شو في سيارات تويوتا؟",
];
