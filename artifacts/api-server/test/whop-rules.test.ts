import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlockedCountries, parseWhopConfig } from "../src/lib/whop/config";
import {
  WhopRuleError,
  computeCommission,
  jodMinorToUsdMinor,
  selectFeePercent,
  usdMinorToAmount,
} from "../src/lib/whop/commission";
import { assertCountryAllowed, isCountryBlocked } from "../src/lib/whop/countries";
import { deriveAccountStatus, moneyToMinor } from "../src/lib/whop/account-state";

const rule = { feePercent: 5 };

await test("an unset environment resolves to sandbox and stays disabled", () => {
  const config = parseWhopConfig({});
  assert.equal(config.environment, "sandbox");
  assert.equal(config.enabled, false);
  assert.equal(config.configured, false);
  assert.ok(config.problems.includes("WHOP_USD_PER_JOD must be positive"));
});

await test("an unknown environment never resolves to production", () => {
  assert.equal(parseWhopConfig({ WHOP_ENVIRONMENT: "prod" }).environment, "sandbox");
  assert.equal(parseWhopConfig({ WHOP_ENVIRONMENT: "PRODUCTION" }).environment, "production");
});

await test("production without its own credentials is reported, never defaulted", () => {
  const config = parseWhopConfig({
    WHOP_ENABLED: "true",
    WHOP_ENVIRONMENT: "production",
    WHOP_USD_PER_JOD: "0.141",
  });
  assert.equal(config.environment, "production");
  assert.equal(config.configured, false);
  assert.deepEqual(
    config.problems.filter((problem) => problem.includes("required")).sort(),
    ["WHOP_API_KEY is required", "WHOP_COMPANY_ID is required", "WHOP_WEBHOOK_SECRET is required"],
  );
});

await test("a complete sandbox configuration is usable and never echoes secrets", () => {
  const config = parseWhopConfig({
    WHOP_ENABLED: "true",
    WHOP_API_KEY: "sk_sandbox_value",
    WHOP_WEBHOOK_SECRET: "ws_sandbox_value",
    WHOP_COMPANY_ID: "biz_platform",
    WHOP_USD_PER_JOD: "0.141",
  });
  assert.equal(config.configured, true);
  assert.equal(config.environment, "sandbox");
  assert.equal(config.problems.length, 0);
});

await test("JOD minor units convert to USD cents once, half up", () => {
  assert.equal(jodMinorToUsdMinor(1_000, 0.14), 14);
  assert.equal(jodMinorToUsdMinor(1_000, 0.141), 14);
  assert.equal(jodMinorToUsdMinor(500, 0.141), 7);
  assert.throws(() => jodMinorToUsdMinor(0, 0.14), WhopRuleError);
  assert.throws(() => jodMinorToUsdMinor(1_000, 0), WhopRuleError);
});

await test("one flat rate at every order value (owner decision 2026-11-25: 5%)", () => {
  for (const total of [1_000, 49_999, 50_000, 5_000_000]) assert.equal(selectFeePercent(total, rule), 5);
});

await test("commission is positive, below the total, and integer", () => {
  assert.deepEqual(computeCommission(1_000, rule), {
    feePercent: 5,
    feeMinor: 50,
    sellerMinor: 950,
  });
  assert.deepEqual(computeCommission(50_000, rule), {
    feePercent: 5,
    feeMinor: 2_500,
    sellerMinor: 47_500,
  });
  for (const total of [20, 39, 99, 2_500]) {
    const { feeMinor, sellerMinor } = computeCommission(total, rule);
    assert.ok(Number.isInteger(feeMinor) && feeMinor > 0);
    assert.ok(feeMinor < total);
    assert.equal(feeMinor + sellerMinor, total);
  }
});

await test("a fee that rounds to zero is refused instead of silently collected", () => {
  for (const total of [1, 3, 9, 19]) {
    assert.throws(() => computeCommission(total, rule), WhopRuleError);
  }
  assert.throws(() => computeCommission(5, { ...rule, feePercent: 5 }), WhopRuleError);
  assert.throws(() => computeCommission(0, rule), WhopRuleError);
  assert.throws(
    () => computeCommission(100, { feePercent: 100 }),
    WhopRuleError,
  );
});

await test("Whop receives decimal major units, not minor units", () => {
  assert.equal(usdMinorToAmount(2_500), 25);
  assert.equal(usdMinorToAmount(99), 0.99);
  assert.throws(() => usdMinorToAmount(-1), WhopRuleError);
});

await test("the country gate blocks Iraq by default and refuses unknown codes", () => {
  const blocked = parseBlockedCountries(undefined);
  assert.equal(isCountryBlocked("IQ", blocked), true);
  assert.equal(isCountryBlocked("ir", blocked), true);
  assert.equal(isCountryBlocked("JO", blocked), false);
  assert.equal(isCountryBlocked("", blocked), false);
  assert.throws(() => assertCountryAllowed("IQ", blocked), /not available/);
  assert.throws(() => assertCountryAllowed("XX1", blocked), /not available/);
  assert.equal(assertCountryAllowed("kw", blocked), "KW");
});

await test("the environment can add countries but cannot remove the defaults", () => {
  const blocked = parseBlockedCountries("iq, ru,ZZ,x1");
  assert.ok(blocked.includes("IQ"));
  assert.ok(blocked.includes("RU"));
  assert.ok(blocked.includes("ZZ"));
  assert.ok(!blocked.includes("X1"));
  assert.deepEqual(blocked, [...new Set(blocked)]);
});

await test("provider money strings parse exactly, never through floats", () => {
  assert.equal(moneyToMinor("14.10", "usd"), 1_410);
  assert.equal(moneyToMinor("14.1", "usd"), 1_410);
  assert.equal(moneyToMinor("0.07", "usd"), 7);
  assert.equal(moneyToMinor({ amount: "500.00", currency: "usd" }, "usd"), 50_000);
  assert.equal(moneyToMinor({ amount: "500.00", currency: "jod" }, "usd"), null);
  assert.equal(moneyToMinor("1.234", "usd"), null);
  assert.equal(moneyToMinor("0", "usd"), null);
  assert.equal(moneyToMinor("-1.00", "usd"), null);
  assert.equal(moneyToMinor(undefined, "usd"), null);
});

await test("a seller is payable only when both identity profiles are approved", () => {
  const base = {
    status: "active",
    verification: {},
  } as any;
  assert.equal(deriveAccountStatus(base).status, "PENDING");
  assert.equal(
    deriveAccountStatus({
      ...base,
      verification: { individual: { status: "pending" } },
    }).status,
    "ONBOARDING",
  );
  assert.equal(
    deriveAccountStatus({
      ...base,
      verification: {
        individual: { status: "approved" },
        business: { status: "approved" },
      },
    }).status,
    "VERIFIED",
  );
  assert.equal(
    deriveAccountStatus({
      ...base,
      verification: { individual: { status: "approved" } },
    }).status,
    "VERIFIED",
  );
  assert.equal(
    deriveAccountStatus({
      ...base,
      verification: {
        individual: { status: "approved" },
        business: { status: "rejected" },
      },
    }).status,
    "RESTRICTED",
  );
  assert.equal(deriveAccountStatus({ ...base, status: "suspended" }).status, "RESTRICTED");
});
