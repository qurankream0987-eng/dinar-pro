/**
 * ARABIC-UNDERSTANDING: deterministic understanding across dialects (Gulf, Levantine, Egyptian),
 * negation and how-to questions. Pure functions, no model, no database. The held-out set was
 * written after the fixes and was never tuned against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceIntent, addToCartIntent, searchTerms } from "../src/ai/intent";
import { isAiUsageQuestion } from "../src/ai/usage-intent";
import { isVagueRequest } from "../src/ai/marketplace-intent";

type C = [string, string, (m: string) => unknown, unknown];
const s = surfaceIntent, a = addToCartIntent, t = searchTerms, u = isAiUsageQuestion, v = isVagueRequest;
const tuned: C[] = [
  // surface
  ["وين وصل طلبي؟", "S", s, "ORDERS"],
  ["شو صار بطلبي", "S", s, "ORDERS"],
  ["ابغى اشوف طلباتي", "S", s, "ORDERS"],
  ["طلبي اتأخر", "S", s, "ORDERS"],
  ["فين الأوردر بتاعي", "S", s, "ORDERS"],
  ["ودي اشوف السلة", "S", s, "CART"],
  ["شو في بسلتي", "S", s, "CART"],
  ["ابي ادفع", "S", s, "CHECKOUT"],
  ["كيف اكمل الشراء", "S", s, "CHECKOUT"],
  ["لا تدفع الحين", "S", s, undefined],
  ["ما ابي ادفع، بس اشوف السعر", "S", s, undefined],
  ["كم عمولة جاسم على البائع؟", "S", s, "POLICIES"],
  ["وين وصل استرجاع فلوسي", "S", s, undefined],
  ["عندي ايفون 13 ابي ابيعه", "S", s, "SELL"],
  ["بدي انزل اعلان لسيارتي", "S", s, "SELL"],
  ["ابحث عن ناس يبيعون قهوة", "S", s, undefined],
  ["مين بيبيع لابتوب مستعمل", "S", s, undefined],
  ["كم مستحقاتي عند دينار", "S", s, "DUES"],
  ["اطلعني من حسابي", "S", s, "LOGOUT"],
  // cart add
  ["ضيفه للسلة", "A", a, true],
  ["حط الثاني بالسلة", "A", a, true],
  ["لا تحطه بالسلة", "A", a, false],
  ["ما بدي ضيفه للسلة", "A", a, false],
  ["مو لازم تضيفه للسلة", "A", a, false],
  ["اضف الاول", "A", a, true],
  ["حطلي واحد بالسلة", "A", a, true],
  ["كيف اضيف منتج للسلة؟", "A", a, false],
  ["شلون اضيف للسلة", "A", a, false],
  // search terms
  ["دورلي على كنبة زرقا", "T", t, "كنبة زرقا"],
  ["ابغى جوال سامسونج", "T", t, "جوال سامسونج"],
  ["بدي لابتوب للبرمجة", "T", t, "لابتوب للبرمجة"],
  ["عايز تلاجة", "T", t, "تلاجة"],
  ["شو عندكم ساعات", "T", t, "ساعات"],
  ["في عندكم دراجة هوائية؟", "T", t, "دراجة هوائية"],
  // usage
  ["كم باقي لي من رصيد الذكاء", "U", u, true],
  ["كم رسالة باقية لي اليوم", "U", u, true],
  ["كم باقي على الطلب", "U", u, false],
  // vague
  ["ابي شي حلو", "V", v, true],
  ["ابي هدية لامي", "V", v, false],
];
const heldOut: C[] = [
  ["وش صار على طلبي", "S", s, "ORDERS"],
  ["ليش طلبي متأخر", "S", s, "ORDERS"],
  ["بدي ادفع هلأ", "S", s, "CHECKOUT"],
  ["ما بدي ادفع هلأ", "S", s, undefined],
  ["مش عايز ادفع", "S", s, undefined],
  ["كم رسوم دينار", "S", s, "POLICIES"],
  ["شو سياسة الارجاع", "S", s, undefined],
  ["نزلي اعلان لشقتي", "S", s, "SELL"],
  ["طلعني من حسابي", "S", s, "LOGOUT"],
  ["بدي اشوف السله", "S", s, "CART"],
  ["حطه بالسلة لو سمحت", "A", a, true],
  ["لا لا ما تضيفه", "A", a, false],
  ["بلاش تحطه بالسلة", "A", a, false],
  ["ازاي اضيف للسلة", "A", a, false],
  ["ضيف التالت للسلة", "A", a, true],
  ["عاوز موبايل اوبو", "T", t, "موبايل اوبو"],
  ["هل يوجد مكيف سبليت", "T", t, "مكيف سبليت"],
  ["عندكم سماعات بلوتوث؟", "T", t, "سماعات بلوتوث"],
  ["كم سؤال ضايل لي اليوم", "U", u, true],
  ["كم باقي من رصيد المساعد", "U", u, true],
  ["كم باقي من المخزون", "U", u, false],
];

function check(cases: C[]) {
  for (const [message, kind, fn, want] of cases) {
    const got = kind === "T" ? String(fn(message)).replace(/\s+/g, " ").trim() : fn(message);
    assert.equal(got, want, `${kind} «${message}»`);
  }
}
test("AU-01 dialect, negation and how-to understanding (tuned set)", () => check(tuned));
test("AU-02 held-out phrasings", () => check(heldOut));
test("AU-03 a refused cart action is never an add", () => {
  for (const m of ["لا تحطه بالسلة", "ما بدي ضيفه للسلة", "مو لازم تضيفه للسلة", "بلاش تحطه بالسلة", "لا لا ما تضيفه"])
    assert.equal(addToCartIntent(m), false, m);
});
