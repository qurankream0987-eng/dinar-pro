/**
 * Deterministic CPU bounds for hostile ~2,000-character messages (no model, no network, no DB).
 *
 * Before the fix, hasCategoryAlias re-normalized the whole message for every category alias, and
 * every message word and alias word again inside its nested loop, so one hostile turn cost
 * ≈0.9 s of CPU (marketplace-intelligence's 1,000 ms limit failed intermittently).
 *
 *  - HIP-01: every hostile input finishes the full deterministic reading within a budget.
 *  - HIP-02: work grows near-linearly with length (doubling the message does not quadruple cost).
 *  - HIP-03: the reading of every hostile and ordinary input is identical to the one captured
 *    before the fix (fixtures/hostile-input-golden.json), so preserving behaviour is proven.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOSTILE_INPUTS, LEGITIMATE_INPUTS } from "./hostile-input-corpus";
import { deterministicReading, goldenEntry, goldenKey } from "./hostile-input-shared";

const BUDGET_MS = 150;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;
function timed(message: string, runs: number): number[] {
  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    deterministicReading(message);
    samples.push(performance.now() - started);
  }
  return samples;
}

await test("HIP-01 every hostile 2,000-character input is read within the CPU budget", () => {
  deterministicReading("تسخين"); // compile regular expressions once
  const report: Record<string, { median: number; p90: number; max: number }> = {};
  for (const [name, raw] of Object.entries(HOSTILE_INPUTS)) {
    const samples = timed(raw.slice(0, 2000), 7);
    report[name] = { median: Math.round(median(samples)), p90: Math.round(quantile(samples, 0.9)), max: Math.round(Math.max(...samples)) };
  }
  console.log("HOSTILE_PERF", JSON.stringify(report));
  const slow = Object.entries(report).filter(([, value]) => value.median > BUDGET_MS);
  assert.deepEqual(slow, [], `median above ${BUDGET_MS} ms: ${JSON.stringify(slow)}`);
});

await test("HIP-02 cost grows near-linearly with message length", () => {
  const unit = "رقمي 1 2 سيارة هاتف ";
  const at = (chars: number) => median(timed(unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars), 5));
  const small = Math.max(at(500), 1);
  const large = at(2000);
  console.log("HOSTILE_SCALING", JSON.stringify({ ms500: Math.round(small), ms2000: Math.round(large), ratio: +(large / small).toFixed(2) }));
  // Quadratic work would make ×4 length cost ×16; linear about ×4. Allow noise, forbid quadratic.
  assert.ok(large / small < 9, `2,000 chars cost ${(large / small).toFixed(1)}× 500 chars`);
});

await test("HIP-03 readings are unchanged for hostile and ordinary inputs (golden from before the fix)", () => {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/hostile-input-golden.json", import.meta.url.replace("/.test-build/", "/test/")), "utf8")) as Record<string, any>;
  for (const raw of Object.values(HOSTILE_INPUTS)) {
    const message = raw.slice(0, 2000);
    assert.deepEqual(goldenEntry(message, false), golden[goldenKey(message)], `hostile reading changed: ${JSON.stringify(message.slice(0, 30))}`);
  }
  for (const message of LEGITIMATE_INPUTS) {
    const { message: stored, ...expected } = golden[goldenKey(message)];
    assert.equal(stored, message);
    assert.deepEqual(goldenEntry(message, true), expected, `reading changed: ${message}`);
  }
});
