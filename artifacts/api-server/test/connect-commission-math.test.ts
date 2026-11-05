import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commissionSnapshot,
  remainingCommission,
} from "../src/connect/commission-math";
import type { ConnectAgreement } from "@workspace/api-zod/connect-platform";
export const terms: ConnectAgreement = {
  mode: "SIMULATION_ONLY",
  currency: "USD",
  commission: { kind: "PERCENTAGE", basisPoints: 750 },
  categoryRates: [],
  excludedProductIds: [],
  excludedCategoryIds: [],
  attributionPolicy: "CLICK_SNAPSHOT",
  attributionWindowSeconds: 3600,
  reportingGraceSeconds: 3600,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveUntil: null,
  refundPolicy: "PRO_RATA_ELIGIBLE_BASE",
  rounding: "HALF_UP",
  eligibleEvents: ["PURCHASE_COMPLETED"],
  settlementDueDays: 0,
  paymentTerms: "Synthetic settlement only",
  cancellationPolicy: "Synthetic cancellation evidence required",
  termsText: "Synthetic agreement, not a live commercial agreement",
  attributionNotice:
    "Only an opaque referral identifier leaves DINAR after explicit consent.",
  privacyPolicyVersion: "connect-synthetic-1",
};
await test("percentage/category/exclusion calculations use exact integer minor units and accepted rounding", () => {
  const snapshot = commissionSnapshot(terms, [
    { externalId: "a", categoryId: "other", grossMinor: 10007 },
  ]);
  assert.equal(snapshot.commissionMinor, 751);
  assert.equal(snapshot.eligibleMinor, 10007);
  assert.equal(
    commissionSnapshot({ ...terms, rounding: "FLOOR" }, [
      { externalId: "a", categoryId: "other", grossMinor: 10007 },
    ]).commissionMinor,
    750,
  );
  const multi = commissionSnapshot(
    {
      ...terms,
      categoryRates: [{ categoryId: "special", basisPoints: 1500 }],
      excludedProductIds: ["excluded"],
    },
    [
      { externalId: "a", categoryId: "special", grossMinor: 10000 },
      { externalId: "b", categoryId: "other", grossMinor: 10000 },
      { externalId: "excluded", categoryId: "special", grossMinor: 50000 },
    ],
  );
  assert.equal(multi.commissionMinor, 2250);
  assert.equal(multi.eligibleMinor, 20000);
  assert.equal(multi.grossMinor, 70000);
});
await test("fixed agreements accrue once and prorate only under the explicit accepted refund policy", () => {
  const fixed = {
    ...terms,
    commission: { kind: "FIXED" as const, amountMinor: 5000 },
  };
  const snapshot = commissionSnapshot(fixed, [
    { externalId: "a", categoryId: "other", grossMinor: 10000 },
  ]);
  assert.equal(snapshot.commissionMinor, 5000);
  assert.equal(
    remainingCommission(fixed, snapshot.items, [
      { externalId: "a", amountMinor: 6667 },
    ]).commissionMinor,
    1667,
  );
  assert.equal(
    remainingCommission({ ...fixed, rounding: "FLOOR" }, snapshot.items, [
      { externalId: "a", amountMinor: 6667 },
    ]).commissionMinor,
    1666,
  );
  assert.equal(
    remainingCommission(
      { ...fixed, refundPolicy: "FULL_REVERSAL_ON_ANY_REFUND" },
      snapshot.items,
      [{ externalId: "a", amountMinor: 1 }],
    ).commissionMinor,
    0,
  );
  assert.equal(
    remainingCommission(fixed, snapshot.items, [
      { externalId: "a", amountMinor: 10000 },
    ]).commissionMinor,
    0,
  );
});
await test("refunds cannot invent products, exceed the original amounts, or duplicate lines", () => {
  const snapshot = commissionSnapshot(terms, [
    { externalId: "a", categoryId: "other", grossMinor: 10000 },
  ]);
  for (const refunds of [
    [{ externalId: "unknown", amountMinor: 10 }],
    [{ externalId: "a", amountMinor: 10001 }],
    [{ externalId: "a", amountMinor: -1 }],
    [
      { externalId: "a", amountMinor: 1 },
      { externalId: "a", amountMinor: 1 },
    ],
  ])
    assert.throws(() => remainingCommission(terms, snapshot.items, refunds));
  assert.throws(() =>
    commissionSnapshot(terms, [
      {
        externalId: "a",
        categoryId: "other",
        grossMinor: Number.MAX_SAFE_INTEGER,
      },
      { externalId: "b", categoryId: "other", grossMinor: 1 },
    ]),
  );
  assert.throws(() =>
    commissionSnapshot(terms, [
      { externalId: "a", categoryId: "other", grossMinor: 1.5 },
    ]),
  );
});
await test("cumulative partial refunds never increase earnings or erase the immutable earning ceiling", () => {
  for (const commission of [
    { kind: "PERCENTAGE" as const, basisPoints: 1750 },
    { kind: "FIXED" as const, amountMinor: 3333 },
  ]) {
    const agreement = { ...terms, commission };
    const snapshot = commissionSnapshot(agreement, [
      { externalId: "a", categoryId: "other", grossMinor: 10000 },
    ]);
    let previous = snapshot.commissionMinor;
    for (let refunded = 0; refunded <= 10000; refunded += 100) {
      const current = remainingCommission(agreement, snapshot.items, [
        { externalId: "a", amountMinor: refunded },
      ]);
      assert.ok(current.commissionMinor <= previous);
      assert.ok(current.commissionMinor >= 0);
      assert.equal(snapshot.items[0]!.grossMinor, 10000);
      previous = current.commissionMinor;
    }
    assert.equal(previous, 0);
  }
});
