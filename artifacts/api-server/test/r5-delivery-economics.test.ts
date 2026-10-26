import test from "node:test";
import assert from "node:assert/strict";
import { courierCommissionMinor, parseFareAmount } from "../src/lib/courier-money";
import { currencies } from "@workspace/global";
import {
  resolveExternalDeliveryRevenue,
} from "../src/lib/delivery-provider-revenue";

test("R5 fare parsing and commission arithmetic use market minor units", () => {
  assert.equal(parseFareAmount("12.5", 2), 1250);
  assert.equal(parseFareAmount("١٢٫٥٠", 2), 1250);
  assert.equal(courierCommissionMinor(10_000), 1_000);
  assert.equal(courierCommissionMinor(5), 1);
  assert.equal(courierCommissionMinor(4), 0);
  assert.throws(() => parseFareAmount("12.345", 2), /منازل/);
  assert.throws(() => parseFareAmount("1,000", 2), /أجرة/);
  assert.throws(() => parseFareAmount("0", 2), /أكبر من صفر/);
});

test("R5 negotiated fares follow canonical SAR, JOD, and KWD minor-unit scales", () => {
  assert.equal(currencies.SAR.minorUnitScale, 2);
  assert.equal(parseFareAmount("1.23", currencies.SAR.minorUnitScale), 123);
  assert.throws(() => parseFareAmount("1.234", currencies.SAR.minorUnitScale), /منازل/);

  for (const code of ["JOD", "KWD"] as const) {
    assert.equal(currencies[code].minorUnitScale, 3);
    assert.equal(parseFareAmount("1.234", currencies[code].minorUnitScale), 1234);
  }
});

test("external provider revenue requires explicit agreement and never assumes a rate", () => {
  assert.deepEqual(
    resolveExternalDeliveryRevenue({
      policy: null,
      completed: true,
      fareMinor: 10_000,
      currencyCode: "JOD",
    }),
    { status: "AGREEMENT_REQUIRED" },
  );
  assert.deepEqual(
    resolveExternalDeliveryRevenue({
      policy: null,
      completed: false,
      fareMinor: 10_000,
      currencyCode: "JOD",
    }),
    { status: "NOT_COMPLETED", amountMinor: 0 },
  );
  assert.deepEqual(
    resolveExternalDeliveryRevenue({
      policy: { model: "PERCENTAGE", basisPoints: 1250 },
      completed: true,
      fareMinor: 10_000,
      currencyCode: "JOD",
    }),
    { status: "CALCULATED", amountMinor: 1250, currencyCode: "JOD" },
  );
  assert.deepEqual(
    resolveExternalDeliveryRevenue({
      policy: {
        model: "FIXED_PER_COMPLETED_DELIVERY",
        amountMinor: 250,
        currencyCode: "JOD",
      },
      completed: true,
      fareMinor: 10_000,
      currencyCode: "JOD",
    }),
    { status: "CALCULATED", amountMinor: 250, currencyCode: "JOD" },
  );
  assert.deepEqual(
    resolveExternalDeliveryRevenue({
      policy: { model: "CONTRACTUAL", agreementReference: "contract-1" },
      completed: true,
      fareMinor: 10_000,
      currencyCode: "JOD",
    }),
    { status: "CONTRACTUAL_REVIEW", agreementReference: "contract-1" },
  );
  assert.throws(
    () =>
      resolveExternalDeliveryRevenue({
        policy: {
          model: "FIXED_PER_COMPLETED_DELIVERY",
          amountMinor: 250,
          currencyCode: "KWD",
        },
        completed: true,
        fareMinor: 10_000,
        currencyCode: "JOD",
      }),
    /match the delivery market/,
  );
});
