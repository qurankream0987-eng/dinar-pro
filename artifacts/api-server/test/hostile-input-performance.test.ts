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

// 3–8× below the pre-fix medians (450–790 ms); HIP-02 separately forbids quadratic growth.
const BUDGET_MS = 250;
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

import * as before from "./fixtures/pre-fix/arabic-normalization";
import * as beforeContext from "./fixtures/pre-fix/search-context";
import { normalizeNumberWords } from "../src/ai/arabic-normalization";
import { hasCategoryAlias } from "../src/ai/search-context";
import { INITIAL_PRICE_AMOUNT } from "../src/ai/listing-draft";
import { TEST_MARKETPLACE_CATEGORY_SCHEMAS } from "./fixtures/marketplace-categories";

await test("HIP-04 differential fuzz: the optimized normalizers equal the pre-fix ones exactly", () => {
  let seed = 20261031;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pieces = ["1", "7", "25", "1990", "٧", "٢٥", ",", "٬", ".", " ", "  ", "\t", "k", "K", "دينار", "دنانير", "بـ", "بسعر", "بمبلغ", "سعرها",
    "اقل من", "اكثر من", "من", "الى", "بين", "و", "ب", "خمسة", "وعشرين", "عشرة", "بعشرة", "الف", "مية", "غرفتين", "حمامين", "غرف", "كم", "بالمية",
    "سيارة", "سيارتي", "السيارة", "هاتفي", "الهاتف", "للهاتف", "كنب", "تي شيرت", "اسود", "الاسود", "سوداء", "شقة", "خدمة", "أخرى", "منتج آخر",
    "iPhone15", "x2", "-", "​", "َ", "ـ", "📱", "سيارات", "جوال", "الجوالات"];
  const sample = () => Array.from({ length: 1 + Math.floor(random() * 14) }, () => pieces[Math.floor(random() * pieces.length)]).join(random() < 0.7 ? " " : "");
  const aliases = [...new Set(TEST_MARKETPLACE_CATEGORY_SCHEMAS.flatMap((category: any) => [category.label, category.labelEn, ...(category.aliases ?? [])]).filter(Boolean))] as string[];
  const OLD_PRICE = new RegExp(`(?:بمبلغ\\s*|بسعر\\s*|سعر(?:ها|ه)?\\s*|بـ?\\s*)?(\\d[\\d٬,]*(?:\\.\\d+)?)\\s*(?:دينار(?:اً|ا)?|دنانير|ريال(?:اً|ا)?|ريالات|درهم|دراهم|دولار(?:اً|ا)?|دولارات|جنيه|جنيهات|فلس)`);
  const shape = (match: RegExpExecArray | null) => (match ? [match.index, match[0], match[1]] : null);
  let compared = 0;
  for (let index = 0; index < 4000; index++) {
    const text = sample();
    assert.equal(normalizeNumberWords(text), before.normalizeNumberWords(text), `normalizeNumberWords(${JSON.stringify(text)})`);
    assert.deepEqual(shape(INITIAL_PRICE_AMOUNT.exec(text)), shape(OLD_PRICE.exec(text)), `price(${JSON.stringify(text)})`);
    const alias = aliases[index % aliases.length]!;
    for (const possessive of [false, true]) {
      assert.equal(hasCategoryAlias(text, alias, { possessive }), beforeContext.hasCategoryAlias(text, alias, { possessive }), `hasCategoryAlias(${JSON.stringify(text)}, ${alias}, ${possessive})`);
      compared++;
    }
  }
  // The same message against every alias, as searchCategory and the sale draft call it.
  for (let index = 0; index < 60; index++) {
    const text = sample();
    for (const alias of aliases) for (const possessive of [false, true]) {
      assert.equal(hasCategoryAlias(text, alias, { possessive }), beforeContext.hasCategoryAlias(text, alias, { possessive }), `hasCategoryAlias(${JSON.stringify(text)}, ${alias}, ${possessive})`);
      compared++;
    }
  }
  console.log("HIP04_COMPARED", JSON.stringify({ samples: 4060, aliasComparisons: compared, aliases: aliases.length }));
});

import { pool } from "@workspace/db";
import { categorySchema, listMarketplaceCategories } from "../src/lib/marketplace-categories";
import { interpretMarketplaceTurn } from "../src/ai/marketplace-intent";
import { createInitialSaleDraft } from "../src/ai/listing-draft";

await test("HIP-05 with the migration-seeded production categories: within budget and alias-equivalent", async () => {
  const rows = await listMarketplaceCategories();
  const seeded = rows.map((row) => categorySchema(row));
  const aliases = [...new Set(rows.flatMap((row) => [row.label, ...((row.aliases as string[] | null) ?? [])]).filter(Boolean))];
  assert.ok(aliases.length > 20, `seeded categories present (${aliases.length} aliases)`);
  const report: Record<string, number> = {};
  for (const [name, raw] of Object.entries(HOSTILE_INPUTS)) {
    const message = raw.slice(0, 2000);
    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      interpretMarketplaceTurn(message, { categories: seeded as any, knownCities: ["عمان"] });
      createInitialSaleDraft(message, seeded as any);
      samples.push(performance.now() - started);
    }
    report[name] = Math.round(median(samples));
  }
  console.log("HOSTILE_PERF_SEEDED", JSON.stringify({ categories: rows.length, aliases: aliases.length, medianMs: report }));
  const slow = Object.entries(report).filter(([, value]) => value > BUDGET_MS);
  assert.deepEqual(slow, [], `median above ${BUDGET_MS} ms with seeded categories`);
  for (const message of [...LEGITIMATE_INPUTS, ...Object.values(HOSTILE_INPUTS).map((raw) => raw.slice(0, 300))])
    for (const alias of aliases) for (const possessive of [false, true])
      assert.equal(hasCategoryAlias(message, alias, { possessive }), beforeContext.hasCategoryAlias(message, alias, { possessive }), `hasCategoryAlias(${JSON.stringify(message.slice(0, 40))}, ${alias}, ${possessive})`);
  await pool.end();
});
