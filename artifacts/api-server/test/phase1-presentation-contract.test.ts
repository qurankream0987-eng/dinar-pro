/**
 * JassimAI Phase 1 — the presentation contract for tables and charts (`table`, `series` sections
 * of the composed surface). Pure contract tests: no database, no network, no model.
 *
 * What is proven: values pass through exactly; a missing value stays missing (never zero);
 * malformed, oversized, executable or polluted payloads are refused whole; charts and tables
 * never carry an action; a terminal envelope leaves them readable and actionless.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCardEnvelope,
  parseComposedSurface,
  SurfaceSectionSchema,
  type CardEnvelope,
} from "@workspace/api-zod/surface-composition";

const section = (value: unknown) => SurfaceSectionSchema.safeParse(value);
const table = (overrides: Record<string, unknown> = {}) => ({
  type: "table",
  label: "مقارنة",
  columns: [
    { key: "name", label: "المنتج", kind: "TEXT" },
    { key: "price", label: "السعر", kind: "MONEY", sortable: true },
    { key: "ram", label: "الذاكرة", kind: "TEXT" },
  ],
  rows: [
    { key: "a", cells: [{ display: "Galaxy S23" }, { display: "520.000 JOD", sort: 520_000 }, { display: "8GB" }] },
    { key: "b", cells: [{ display: "آيفون 13" }, { display: "420.000 JOD", sort: 420_000 }, { display: null }] },
  ],
  ...overrides,
});
const series = (kind: "LINE" | "DONUT", points: unknown[], extra: Record<string, unknown> = {}) => ({ type: "series", kind, label: "الإيراد", points, ...extra });
const point = (label: string, value: number) => ({ label, value, display: String(value) });

test("B9/B10/B12 a comparison table keeps prices and mixed-language text exactly, and a missing value stays null", () => {
  const parsed = section(table());
  assert.equal(parsed.success, true);
  const data = parsed.data as any;
  assert.equal(data.rows[0].cells[1].display, "520.000 JOD");
  assert.equal(data.rows[0].cells[0].display, "Galaxy S23");
  assert.equal(data.rows[1].cells[2].display, null, "missing is null, never 0 or empty");
  assert.equal(data.columns[0].kind, "TEXT");
});

test("B table shape: one cell per column, unique keys, bounded rows and columns", () => {
  assert.equal(section(table({ rows: [{ key: "a", cells: [{ display: "x" }] }] })).success, false, "short row refused");
  assert.equal(section(table({ rows: [{ key: "a", cells: [{ display: "x" }, { display: "y" }, { display: "z" }] }, { key: "a", cells: [{ display: "x" }, { display: "y" }, { display: "z" }] }] })).success, false, "duplicate row key refused");
  const many = Array.from({ length: 31 }, (_, index) => ({ key: `r${index}`, cells: [{ display: "x" }, { display: "y" }, { display: "z" }] }));
  assert.equal(section(table({ rows: many })).success, false, "31 rows refused");
  const columns = Array.from({ length: 9 }, (_, index) => ({ key: `c${index}`, label: `c${index}` }));
  assert.equal(section(table({ columns, rows: [] })).success, false, "9 columns refused");
  assert.equal(section(table({ rows: [] })).success, true, "an empty table is a valid empty state");
});

test("A1/A2/A6/A7/A8 a line keeps every given point exactly, including zero, negative and very large values", () => {
  const points = [point("يناير", 0), point("فبراير", -1250.5), point("مارس", 9_007_199_254_740), point("أبريل", 12)];
  const parsed = section(series("LINE", points, { unit: "JOD", period: "2026" }));
  assert.equal(parsed.success, true);
  assert.deepEqual((parsed.data as any).points, points, "the drawn data is the source payload exactly");
});

test("A3/A4 invalid values are refused whole and no point is invented", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "12" as unknown as number])
    assert.equal(section(series("LINE", [point("a", 1), { label: "b", value: bad, display: "?" }])).success, false);
  assert.equal(section(series("LINE", [point("a", 1)])).success, false, "one point is not a trend");
  assert.equal(section(series("LINE", Array.from({ length: 25 }, (_, index) => point(`m${index}`, index)))).success, false, "25 points refused");
  // A gap stays a gap: the contract has no interpolation field, and two points stay two.
  const parsed = section(series("LINE", [point("يناير", 5), point("مارس", 7)]));
  assert.equal((parsed.data as any).points.length, 2);
});

test("P3 a donut is a real part-to-whole: 2-6 non-negative parts of a non-empty whole", () => {
  assert.equal(section(series("DONUT", [point("إلكترونيات", 60), point("أثاث", 40)])).success, true);
  assert.equal(section(series("DONUT", [point("a", 60), point("b", -1)])).success, false, "negative part refused");
  assert.equal(section(series("DONUT", [point("a", 0), point("b", 0)])).success, false, "empty whole refused");
  assert.equal(section(series("DONUT", Array.from({ length: 7 }, (_, index) => point(`p${index}`, 1)))).success, false, "seven parts refused");
});

test("D19/D20 unknown types, executable fields and markup-bearing keys fail safely", () => {
  assert.equal(section({ type: "html", html: "<script>alert(1)</script>" }).success, false);
  assert.equal(section({ ...table(), onClick: "alert(1)" }).success, false, "unknown key refused (strict)");
  assert.equal(section({ ...table(), columns: [{ key: "x", label: "x", render: "() => 1" }], rows: [] }).success, false, "cell renderer refused");
  assert.equal(section(table({ rows: [{ key: "a", cells: [{ display: { __html: "<b>x</b>" } }, { display: "y" }, { display: "z" }] }] })).success, false, "object cell refused");
  assert.equal(section(series("LINE", [point("a", 1), point("b", 2)], { kind: "SCATTER" })).success, false, "unknown chart kind refused");
  // Text that looks like markup is kept as inert text; React renders it as text, never as HTML.
  const inert = section(table({ rows: [{ key: "a", cells: [{ display: "<img src=x onerror=alert(1)>" }, { display: "y" }, { display: "z" }] }] }));
  assert.equal(inert.success, true);
});

test("D21 links and actions have no place in a table or chart", () => {
  assert.equal(section({ ...table(), actions: [{ kind: "SEND", label: "اشتر", message: "اشتر" }] }).success, false);
  assert.equal(section(table({ rows: [{ key: "a", cells: [{ display: "x", href: "javascript:alert(1)" }, { display: "y" }, { display: "z" }] }] })).success, false);
  assert.equal(section({ ...series("LINE", [point("a", 1), point("b", 2)]), url: "https://evil.example" }).success, false);
});

test("D prototype pollution: a __proto__ key is refused and never reaches Object.prototype", () => {
  const polluted = JSON.parse('{"type":"table","label":"x","columns":[{"key":"a","label":"a"}],"rows":[],"__proto__":{"polluted":true}}');
  assert.equal(section(polluted).success, false);
  const pointPolluted = JSON.parse('{"type":"series","kind":"LINE","label":"x","points":[{"label":"a","value":1,"display":"1","__proto__":{"polluted":true}},{"label":"b","value":2,"display":"2"}]}');
  assert.equal(section(pointPolluted).success, false);
  assert.equal(({} as any).polluted, undefined);
});

test("D oversized payloads are refused whole by the composed surface byte limit", () => {
  const long = "ب".repeat(120);
  const rows = Array.from({ length: 30 }, (_, index) => ({ key: `r${index}`, cells: Array.from({ length: 8 }, () => ({ display: long })) }));
  const columns = Array.from({ length: 8 }, (_, index) => ({ key: `c${index}`, label: `c${index}` }));
  const surface = { version: 1, label: "كبير", size: "LARGE", sections: [{ type: "table", label: "كبير", columns, rows }] };
  assert.equal(parseComposedSurface(surface), null);
});

test("C16/D a terminal envelope leaves tables and charts readable and they never carry actions", () => {
  const surface = parseComposedSurface({
    version: 1, label: "تحليل", size: "MEDIUM",
    sections: [table(), series("LINE", [point("a", 1), point("b", 2)]), { type: "actions", items: [{ kind: "SEND", label: "أكد", message: "أكد", actionId: "CONFIRM" }] }],
  });
  assert.ok(surface);
  const envelope = {
    schemaVersion: 1, surfaceType: "BUSINESS_INSIGHTS", surfaceId: "biz:1", resource: { kind: "BUSINESS", id: "1" },
    conversationId: "00000000-0000-4000-8000-000000000000", context: { marketId: "JO" },
    status: { lifecycle: "EXPIRED" }, refresh: { strategy: "RESTORE" }, sourceTimestamp: new Date().toISOString(),
    accessibility: { label: "تحليل" },
  } as CardEnvelope;
  const applied = applyCardEnvelope(surface!, envelope)!;
  assert.deepEqual(applied.sections.map((s) => s.type), ["table", "series"], "data stays, the stale action is removed");
  assert.equal(applyCardEnvelope(surface!, { ...envelope, schemaVersion: 2 } as any), null, "E30 unknown envelope version refused");
});
