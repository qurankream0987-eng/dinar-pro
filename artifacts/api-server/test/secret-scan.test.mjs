// Pre-integration closure (Phase 1): no credential-shaped value may be committed.
// Scans every Git-tracked file (and the working-tree copy) for well-known credential formats.
// Prints file paths and pattern names only — never the matched value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const PATTERNS = [
  ["GitHub token", /\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})\b/],
  ["OpenAI-style key", /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9]{32,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{30,}\b/],
  ["Groq key", /\bgsk_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ["Credentialed database URL", /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{8,}@(?!localhost|127\.0\.0\.1)[^\s/]+/],
];

// Synthetic, letters-only passwords in URL-guard fixtures (they test that such URLs are refused).
const ALLOWED = new Set([
  "artifacts/api-server/test/acceptance-database-guard.test.mjs: Credentialed database URL",
  "artifacts/api-server/test/development-tls.test.ts: Credentialed database URL",
]);

test("no committed file contains a credential-shaped value", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  for (const file of files) {
    const full = path.join(root, file);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // deleted in the working tree
    }
    if (!stats.isFile() || stats.size > 5_000_000) continue;
    const text = readFileSync(full, "latin1");
    for (const [name, pattern] of PATTERNS) if (pattern.test(text) && !ALLOWED.has(`${file}: ${name}`)) findings.push(`${file}: ${name}`);
  }
  assert.deepEqual(findings, [], `credential-shaped values found (values not printed):\n${findings.join("\n")}`);
});
