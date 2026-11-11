// Answer cards accept only their closed schemas; anything else renders as a quiet placeholder.
import assert from "node:assert/strict";
import test from "node:test";
import { isAnswerCardLanguage, parseAnswerCard } from "../src/features/ai/AnswerCards";

test("valid cards parse and are bounded", () => {
  const chart = parseAnswerCard("dinar-chart", JSON.stringify({ title: "الملفات", items: [{ label: "شيفرة", value: 8 }, { label: "اختبارات", value: 7 }, { label: "x", value: -1 }] })) as any;
  assert.equal(chart.items.length, 2, "negative values are dropped");
  const choice = parseAnswerCard("dinar-choice", JSON.stringify({ question: "توصيل؟", options: ["نعم", "لا", "نعم"] })) as any;
  assert.deepEqual(choice.options, ["نعم", "لا"]);
  const price = parseAnswerCard("dinar-price", JSON.stringify({ items: [{ label: "Community", amount: "$0.34/ساعة" }] })) as any;
  assert.equal(price.items[0].amount, "$0.34/ساعة");
  const options = parseAnswerCard("dinar-options", JSON.stringify({ items: Array.from({ length: 9 }, (_, i) => ({ name: `خيار ${i}`, pros: ["a", "b", "c", "d", "e"] })) })) as any;
  assert.equal(options.items.length, 6);
  assert.equal(options.items[0].pros.length, 4);
});

test("malformed, partial or unknown input is refused", () => {
  assert.equal(parseAnswerCard("dinar-chart", '{"items":[{"label":"a","value":1}'), undefined, "streaming JSON");
  assert.equal(parseAnswerCard("dinar-chart", JSON.stringify({ items: [{ label: "a", value: 1 }] })), undefined, "one bar is not a chart");
  assert.equal(parseAnswerCard("dinar-choice", JSON.stringify({ question: "؟", options: ["فقط"] })), undefined);
  assert.equal(parseAnswerCard("dinar-price", "[]"), undefined);
  assert.equal(parseAnswerCard("dinar-options", JSON.stringify({ items: [{ name: "<img src=x onerror=alert(1)>" }, { name: "b" }] })) !== undefined, true, "text is kept as text; React escapes it");
  assert.equal(isAnswerCardLanguage("dinar-checkout"), false);
  assert.equal(isAnswerCardLanguage("js"), false);
});
