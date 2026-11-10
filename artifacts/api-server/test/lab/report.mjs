// Builds the DeepSeek lab reports from result files only (no hand-entered numbers).
//   node test/lab/report.mjs <evidence-dir> <docs-dir>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const [EV, DOCS] = process.argv.slice(2);
const load = (file) => existsSync(path.join(EV, file)) ? readFileSync(path.join(EV, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const json = (file) => existsSync(path.join(EV, file)) ? JSON.parse(readFileSync(path.join(EV, file), "utf8")) : null;
const runs = {
  "A1 baseline (deterministic, pre-fix)": load("baseline/A1-det-results.jsonl"),
  "B baseline (live DeepSeek, pre-fix)": load("baseline/B-live-results.jsonl"),
  "A3 final (deterministic, post-fix)": load("final/A3-det-results.jsonl"),
  "B2 final (live DeepSeek, post-fix)": load("final/B2-live-results.jsonl"),
  "H held-out (deterministic, post-fix)": load("final/H-det-results.jsonl"),
  "H held-out (live DeepSeek, post-fix)": load("final/H-live-results.jsonl"),
};
const VERDICTS = ["PASS", "FAIL", "BLOCKED", "NOT_EXECUTABLE_DET", "NOT_EXECUTED"];
const count = (rows, key = (r) => r.group) => {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, Object.fromEntries(VERDICTS.map((v) => [v, 0])));
    out.get(k)[r.verdict] = (out.get(k)[r.verdict] ?? 0) + 1;
  }
  return out;
};
const rate = (c) => { const graded = c.PASS + c.FAIL; return graded ? `${((100 * c.PASS) / graded).toFixed(1)}% (${c.PASS}/${graded})` : "—"; };
const table = (rows) => {
  const by = count(rows);
  const total = Object.fromEntries(VERDICTS.map((v) => [v, rows.filter((r) => r.verdict === v).length]));
  const lines = ["| Group | PASS | FAIL | BLOCKED | NOT_EXECUTABLE_DET | NOT_EXECUTED | Pass rate (graded) |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [g, c] of [...by.entries()].sort()) lines.push(`| ${g} | ${c.PASS} | ${c.FAIL} | ${c.BLOCKED} | ${c.NOT_EXECUTABLE_DET} | ${c.NOT_EXECUTED} | ${rate(c)} |`);
  lines.push(`| **Total** | **${total.PASS}** | **${total.FAIL}** | **${total.BLOCKED}** | **${total.NOT_EXECUTABLE_DET}** | **${total.NOT_EXECUTED}** | **${rate(total)}** |`);
  return lines.join("\n");
};
const zeroTolerance = (rows) => rows.flatMap((r) => (r.failures ?? []).filter(([cat]) => cat === "UNAUTHORIZED_ACTION").map(([, why]) => `${r.id}: ${why}`));
const cost = (rows) => rows.reduce((a, r) => ({ calls: a.calls + (r.cost?.calls ?? 0), input: a.input + (r.cost?.inputTokens ?? 0), output: a.output + (r.cost?.outputTokens ?? 0), usd: a.usd + (r.cost?.usd ?? 0) }), { calls: 0, input: 0, output: 0, usd: 0 });
const latency = (rows) => {
  const ms = rows.flatMap((r) => (r.turns ?? []).filter((t) => t.say && !t.say.startsWith("GET ") && !t.say.startsWith("POST ") && !t.say.startsWith("PUT ")).map((t) => t.ms)).sort((a, b) => a - b);
  const q = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0;
  return ms.length ? `n=${ms.length} turns · p50 ${q(0.5)} ms · p90 ${q(0.9)} ms · p99 ${q(0.99)} ms · max ${ms.at(-1)} ms` : "—";
};

let live = "# DeepSeek live execution report\n\nGenerated from the result files in `evidence/`. Model: `deepseek-flash` (served as DeepSeek-V4.1-Flash), through DINAR's own gateway (`DINAR_AI_PROVIDER=DEEPSEEK`, HYBRID routing, max output 2,000 tokens, 0 retries). Costs below are DINAR's own `ai_cost_events` tokens priced at the last verified official peak rates (input $0.30/M cache-miss, $0.006/M cache-hit, output $1.20/M) — an upper bound; the provider balance is the authority (see the final readiness report).\n\n";
for (const [name, rows] of Object.entries(runs)) {
  if (!rows.length || !/live/.test(name)) continue;
  const c = cost(rows);
  live += `## ${name}\n\n${table(rows)}\n\n- Model calls: ${c.calls}; input tokens ${c.input}; output tokens ${c.output}; estimated $${c.usd.toFixed(4)}\n- Latency: ${latency(rows)}\n- Zero-tolerance hits: ${zeroTolerance(rows).length ? zeroTolerance(rows).join("; ") : "none"}\n\n`;
}
writeFileSync(path.join(DOCS, "DEEPSEEK_LIVE_EXECUTION_REPORT.md"), live);

let det = "# Deterministic (Layer A) results\n\n`NOT_EXECUTABLE_DET` = the case needs the language model; with model calls blocked DINAR answered honestly that smart chat is unavailable and nothing changed (safety assertions still graded).\n\n";
for (const [name, rows] of Object.entries(runs)) if (rows.length && !/live/.test(name)) det += `## ${name}\n\n${table(rows)}\n\n- Latency: ${latency(rows)}\n- Zero-tolerance hits: ${zeroTolerance(rows).length ? zeroTolerance(rows).join("; ") : "none"}\n\n`;
writeFileSync(path.join(DOCS, "DEEPSEEK_DETERMINISTIC_RESULTS.md"), det);

// Multi-turn: every case with ≥3 turns, turn by turn, final runs.
let mt = "# Multi-turn report\n\nEvery executed case with three or more turns, from the final live run (B2) and the held-out live run, turn by turn: what the user said, which runtime tool ran, which card appeared, the persisted delta, and the failures.\n\n";
for (const name of ["B2 final (live DeepSeek, post-fix)", "H held-out (live DeepSeek, post-fix)"]) {
  for (const r of runs[name].filter((x) => (x.turns ?? []).length >= 3)) {
    mt += `### ${r.id} — ${r.verdict}\n\n| # | User | Tool | Card | Δ cart | Δ orders | Failure |\n|---|---|---|---|---:|---:|---|\n`;
    r.turns.forEach((t, i) => { mt += `| ${i + 1} | ${String(t.say).replace(/\|/g, "/").slice(0, 60)} | ${t.tool ?? "—"} | ${(t.surfaces ?? []).join(",") || "text"} | ${t.delta?.cart ?? 0} | ${t.delta?.ordersAll ?? 0} | ${(t.failures ?? []).map((f) => f[1]).join("; ").replace(/\|/g, "/").slice(0, 120)} |\n`; });
    mt += "\n";
  }
}
writeFileSync(path.join(DOCS, "DEEPSEEK_MULTITURN_REPORT.md"), mt);

// Security: G14 + SEC + every zero-tolerance assertion across all runs.
let sec = "# Security report\n\nAll prompt-injection, privilege, cross-user and malformed-input cases (development G14, held-out SEC), graded on persisted state (no payment intent, no order, no publication, no listing/order mutation, no promotion, no profile write) and on the reply (no secret, no other user's data, no success claim without a receipt).\n\n";
for (const [name, rows] of Object.entries(runs)) {
  const s = rows.filter((r) => r.group === "G14" || r.group === "SEC");
  if (!s.length) continue;
  sec += `## ${name}\n\n${table(s)}\n\nZero-tolerance hits across the whole run (${rows.length} cases): ${zeroTolerance(rows).length ? zeroTolerance(rows).map((x) => `\n- ${x}`).join("") : "**none**"}\n\n`;
  const fails = s.filter((r) => r.verdict === "FAIL");
  if (fails.length) sec += fails.map((r) => `- ${r.id}: ${(r.failures ?? []).map((f) => f.join(" ")).join("; ")}`).join("\n") + "\n\n";
}
writeFileSync(path.join(DOCS, "DEEPSEEK_SECURITY_REPORT.md"), sec);

// Raw failure list (the classified register is written by hand from these).
let fr = "# Failure list (generated)\n\nEvery FAIL in every run, with the first failing assertion. The classified register (`DEEPSEEK_FAILURE_REGISTER.md`) assigns each a root cause and status.\n\n";
for (const [name, rows] of Object.entries(runs)) {
  const fails = rows.filter((r) => r.verdict === "FAIL" || r.verdict === "BLOCKED");
  if (!fails.length) continue;
  fr += `## ${name} (${fails.length})\n\n`;
  for (const r of fails) {
    const t = (r.turns ?? []).find((x) => (x.failures ?? []).length) ?? (r.turns ?? [])[0] ?? {};
    fr += `- **${r.id}** ${r.failureCategory ?? ""} — ${String(t.say ?? "").slice(0, 60)} → ${(t.surfaces ?? []).join(",") || "text"} — ${((r.failures ?? [])[0] ?? [, ""])[1]}\n`;
  }
  fr += "\n";
}
writeFileSync(path.join(DOCS, "DEEPSEEK_FAILURE_LIST.generated.md"), fr);
const browser = json("final/browser-report.json");
console.log(JSON.stringify({ runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, Object.fromEntries(VERDICTS.map((x) => [x, v.filter((r) => r.verdict === x).length]))])), browserChecks: browser?.checks?.length ?? null }));
