import assert from "node:assert/strict";
import { test } from "node:test";
import { findPreciseLocationLeak } from "../src/lib/location-policy";

await test("location privacy checks recognize street terms without matching substrings", () => {
  assert.equal(findPreciseLocationLeak("Wave2"), undefined);
  assert.equal(
    findPreciseLocationLeak(
      '<img data-xssprobe="safe" src=x onerror="window.__dinarWave2Xss=true">',
    ),
    undefined,
  );
  assert.equal(findPreciseLocationLeak("Main Ave 2"), "PRECISE_ADDRESS");
  assert.equal(findPreciseLocationLeak("شقة رقم ٢"), "PRECISE_ADDRESS");
});