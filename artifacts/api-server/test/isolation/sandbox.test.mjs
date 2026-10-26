// Run on the host (not inside a session): proves the sandbox wrapper itself refuses unsafe
// roots, cannot reach services running in the caller's network, fails a session that tried
// to go outbound, and never deletes anything it did not create.
//   DINAR_PG18_BIN=... node --test test/isolation/sandbox.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const sandbox = new URL("./sandbox.sh", import.meta.url).pathname;
const scratch = mkdtempSync(path.join(process.env.DINAR_ISOLATION_TEST_TMP ?? tmpdir(), "dinar-sandbox-test-"));
const pg18 = process.env.DINAR_PG18_BIN;
assert.ok(pg18, "DINAR_PG18_BIN is required");

function session(root, args, extra = {}) {
  return spawnSync("sh", [sandbox, ...args], {
    env: { PATH: process.env.PATH, DINAR_ISOLATION_ROOT: root, DINAR_PG18_BIN: pg18, ...extra },
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("a root that already holds files is refused and left untouched", () => {
  const root = path.join(scratch, "occupied");
  mkdirSync(path.join(root, "pgdata"), { recursive: true });
  writeFileSync(path.join(root, "pgdata", "PRE_EXISTING"), "keep me");
  const result = session(root, ["true"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an empty directory/);
  assert.equal(readFileSync(path.join(root, "pgdata", "PRE_EXISTING"), "utf8"), "keep me");
});

test("services listening in the caller's network are unreachable from a session", async () => {
  // Stand-in for the Replit development API/web servers (8080/8081/24108 in .replit).
  const host = net.createServer((socket) => socket.end("HOST_SERVICE")).listen(0, "127.0.0.1");
  await new Promise((resolve) => host.once("listening", resolve));
  const { port } = host.address();
  try {
    const root = path.join(scratch, "host-service");
    const probe = `const s=require("net").connect({host:"127.0.0.1",port:${port}});s.on("data",d=>{console.log("REACHED:"+d);process.exit(0)});s.on("error",e=>{console.log("REFUSED:"+e.code);process.exit(0)})`;
    const result = await new Promise((resolve) => {
      // Async spawn: the host listener must keep accepting while the session runs.
      import("node:child_process").then(({ spawn }) => {
        const child = spawn("sh", [sandbox, "node", "-e", probe], {
          env: { PATH: process.env.PATH, DINAR_ISOLATION_ROOT: root, DINAR_PG18_BIN: pg18 },
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.on("close", (status) => resolve({ status, stdout }));
      });
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /REFUSED:ECONNREFUSED/);
    assert.doesNotMatch(result.stdout, /REACHED/);
  } finally {
    host.close();
  }
});

test("a session that attempts an outbound connection fails even if its command succeeds", () => {
  const root = path.join(scratch, "outbound");
  const result = session(root, ["node", "-e", 'require("net").connect({host:"93.184.215.14",port:443}).on("error",()=>process.exit(0))']);
  assert.equal(result.status, 98, result.stdout + result.stderr);
  assert.match(result.stderr, /ISOLATION_NET: FAIL/);
  assert.match(readFileSync(path.join(root, "net-attempts.retained.log"), "utf8"), /93\.184\.215\.14:443/);
});

test("host credentials never enter the session environment", () => {
  const root = path.join(scratch, "env");
  const result = spawnSync("sh", [sandbox, "node", "-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"], {
    env: {
      PATH: process.env.PATH,
      DINAR_ISOLATION_ROOT: root,
      DINAR_PG18_BIN: pg18,
      RAILWAY_API_TOKEN: "x",
      DATABASE_URL: "postgresql://u@abc.proxy.rlwy.net/railway",
      DINAR_DEEPSEEK_API_KEY: "x",
      SESSION_SECRET: "host-secret",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const keys = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("[")));
  for (const name of ["RAILWAY_API_TOKEN", "DATABASE_URL", "DINAR_DEEPSEEK_API_KEY"]) assert.ok(!keys.includes(name), name);
  assert.doesNotMatch(result.stdout, /host-secret/);
});

test("teardown removes only the session's own cluster", () => {
  const root = path.join(scratch, "teardown");
  const result = session(root, ["true"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(root, "pgdata")), false);
  assert.equal(existsSync(path.join(root, "postgres.log")), true, "logs are retained as evidence");
});

test("processes a session leaves behind end with it", () => {
  const root = path.join(scratch, "orphans");
  const marker = `dinar-orphan-${process.pid}-${Date.now()}`;
  const result = session(root, ["sh", "-c", `node -e 'setTimeout(() => {}, 300000)' ${marker} & echo STARTED`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STARTED/);
  const survivors = spawnSync("sh", ["-c", `ps -eo args | grep -v grep | grep -c -- '${marker}'`], { encoding: "utf8" });
  assert.equal(survivors.stdout.trim(), "0", "the orphaned child was terminated with the session");
});

after(() => rmSync(scratch, { recursive: true, force: true }));
