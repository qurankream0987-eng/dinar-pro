import { test } from "node:test";
import assert from "node:assert/strict";
import { promotionIntent } from "../src/ai/intent";

test("promotion intents generalize across common Arabic phrasing", () => {
  const cases = [
    ["أرغب في إبراز إعلاني ضمن نتائج البحث", { kind: "ACTION", productType: "SPONSORED_SEARCH" }],
    ["خل إعلاني يطلع بالبحث أكثر", { kind: "ACTION", productType: "SPONSORED_SEARCH" }],
    ["خلّ الإعلان الثاني VIP", { kind: "ACTION", productType: "VIP_LISTING" }],
    ["حدث ظهور إعلاني", { kind: "ACTION", productType: "REFRESH_LISTING" }],
    ["دينار روح بيع لي هذا", { kind: "ACTION", productType: "DEMAND_CAPTURE" }],
    ["بدي دينار يساعدني أبيع العرض", { kind: "ACTION", productType: "DEMAND_CAPTURE" }],
    ["أبي دينار يقترح إعلاني للناس المناسبين", { kind: "ACTION", productType: "SPONSORED_RECOMMENDATION" }],
    ["أريد أن يوصي دينار بإعلاني للباحثين عن منتج مماثل", { kind: "ACTION", productType: "SPONSORED_RECOMMENDATION" }],
    ["أرني خيارات الترويج لإعلاني", { kind: "ACTION", productType: "PROMOTION_ENTRY" }],
  ] as const;

  for (const [phrase, expected] of cases)
    assert.deepEqual(promotionIntent(phrase), expected, phrase);
});

test("educational promotion questions do not become campaign actions", () => {
  assert.deepEqual(promotionIntent("وش يعني VIP؟"), { kind: "EXPLAIN", productType: "VIP_LISTING" });
  assert.deepEqual(promotionIntent("وش يعني روح بيع لي؟"), { kind: "EXPLAIN", productType: "DEMAND_CAPTURE" });
  assert.deepEqual(promotionIntent("كيف أسوق منتجي؟"), { kind: "ADVICE" });
  assert.deepEqual(promotionIntent("تنصحني أروج الإعلان؟"), { kind: "ADVICE" });
});

test("Arabic «حدثني» conversation requests are not listing-refresh commands", () => {
  assert.equal(promotionIntent("حدثني عن الثقوب السوداء"), undefined);
  assert.equal(promotionIntent("حدثني عن القمر"), undefined);
  assert.deepEqual(promotionIntent("حدث الإعلان"), {
    kind: "ACTION",
    productType: "REFRESH_LISTING",
  });
});

test("a buyer's quality preference does not become a featured-listing action", () => {
  assert.equal(promotionIntent("أريد تيشرت نايكي مميز بسعر 5"), undefined);
  assert.deepEqual(promotionIntent("أريد إعلانًا مميزًا"), {
    kind: "ACTION",
    productType: "FEATURED_LISTING",
  });
});

test("a buyer's own search request is never a sponsored-search purchase", () => {
  assert.equal(promotionIntent("أبي أبحث عن كرسي"), undefined);
  assert.equal(promotionIntent("ابحث لي عن كرسي"), undefined);
  assert.equal(promotionIntent("أبي أبيع طاولة، وبعدها ابحث لي عن كرسي"), undefined);
  assert.deepEqual(promotionIntent("أبي إعلاني ممول في البحث"), { kind: "ACTION", productType: "SPONSORED_SEARCH" });
});
