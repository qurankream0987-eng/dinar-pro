/**
 * Answer quality with C-12 safety: the model's own explanation is kept when it is bound to the
 * card it ships with, and replaced by DINAR's facts line otherwise. Pure function, no provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardBoundModelProse } from "../src/ai/smart-turn";

const pixel = { id: "p", title: "جوال بكسل 7 مستعمل", unitPrice: "180.000" };
const redmi = { id: "r", title: "جوال ريدمي نوت 12", unitPrice: "120.000" };
const sofa = { id: "s", title: "كنبة زاوية رمادية", unitPrice: "250.000" };
const ac = { id: "a", title: "مكيف سبليت 18 ألف", unitPrice: "300.000" };
const read = (...listings: object[]) => [{ tool: "searchListings", status: "SUCCEEDED", result: { listings } }];

test("a helpful answer about the card keeps the model's voice", () => {
  const prose = "بكسل 7 خيار ممتاز للاستخدام اليومي: كاميرا قوية وتحديثات طويلة، وسعره 180 دينار. إذا كانت البطارية أولويتك فاسأل البائع عن حالتها.";
  assert.equal(cardBoundModelProse(prose, read(pixel), [pixel]), prose);
  // A comparison across the two listings in the card, with both real prices.
  const compare = "الفرق بين بكسل 7 بسعر 180 وريدمي نوت بسعر 120 هو 60؛ بكسل أقوى بالكاميرا وريدمي أوفر.";
  assert.equal(cardBoundModelProse(compare, read(pixel, redmi), [pixel, redmi]), undefined, "60 is a derived amount, not a card price: DINAR's calculator owns it");
  assert.ok(cardBoundModelProse("بكسل 7 أقوى بالكاميرا وريدمي نوت أوفر للبطارية.", read(pixel, redmi), [pixel, redmi]));
});

test("C-12: prose about a listing that is not in the card is replaced", () => {
  // The original live defect: the reply described the sofa while the card showed the AC.
  assert.equal(cardBoundModelProse("الكنبة الزاوية الرمادية مناسبة لصالتك", read(sofa, ac), [ac]), undefined);
  // Paraphrased product words still count, with or without the article.
  assert.equal(cardBoundModelProse("الكنبه هي الأنسب لك", read(sofa, ac), [ac]), undefined);
});

test("amounts, actions and empty references are refused", () => {
  assert.equal(cardBoundModelProse("بكسل 7 بسعر 150 فقط", read(pixel), [pixel]), undefined, "a price not in the card");
  assert.equal(cardBoundModelProse("تمت إضافة بكسل 7 إلى السلة", read(pixel), [pixel]), undefined, "a completed action");
  assert.equal(cardBoundModelProse("كلام عن منتج غير موثق", read(pixel), [pixel]), undefined, "names nothing in the card");
  assert.equal(cardBoundModelProse(undefined, read(pixel), [pixel]), undefined);
});
