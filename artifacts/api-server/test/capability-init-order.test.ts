/**
 * The capability registry must be complete no matter which module the process loads first.
 * A module cycle once left a model capability without its input schema when tool-registry was
 * imported before capability-registry. Each entry point runs in a fresh process. No database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname ?? ".", "..");
const tsx = path.resolve(root, "../../scripts/node_modules/.bin/tsx");
const entries = [
  "src/ai/tool-registry.ts",
  "src/ai/capability-registry.ts",
  "src/ai/dinar-capabilities.ts",
  "src/ai/model-read-capabilities.ts",
  "src/connect/conversation.ts",
  "src/ai/smart-turn.ts",
];

for (const entry of entries) {
  test(`registry is complete when ${entry} loads first`, () => {
    const script = `
      await import(${JSON.stringify(path.join(root, entry))});
      const { CAPABILITY_REGISTRY } = await import(${JSON.stringify(path.join(root, "src/ai/capability-registry.ts"))});
      const { modelToolDefinitions } = await import(${JSON.stringify(path.join(root, "src/ai/tool-registry.ts"))});
      const broken = Object.values(CAPABILITY_REGISTRY).filter((d) => !d.inputSchema || !d.outputSchema).map((d) => d.name);
      console.log(JSON.stringify({ count: Object.keys(CAPABILITY_REGISTRY).length, broken, tools: modelToolDefinitions().length }));
    `;
    const file = path.join(mkdtempSync(path.join(tmpdir(), "dinar-init-")), "probe.mts");
    writeFileSync(file, script);
    const output = execFileSync(tsx, [file], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "test", DATABASE_URL: "postgres://unused@127.0.0.1:1/dinar_test_unused" },
      encoding: "utf8",
      timeout: 120_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    assert.deepEqual(result.broken, []);
    assert.equal(result.count, 22);
    assert.ok(result.tools >= 20, `${result.tools} model tools advertised`);
  });
}
