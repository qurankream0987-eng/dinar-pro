// Run with the guard preloaded: node --import ./test/isolation/net-guard.mjs --test test/isolation/net-guard.test.mjs
// The guard must refuse every non-loopback destination, and allow a hostname only when the
// in-process resolver maps it to loopback (as the S3 virtual-host tests do).
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";

const server = http.createServer((_req, res) => res.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const get = (host, extra = {}) => new Promise((resolve) => {
  const req = http.request({ host, port, path: "/", ...extra }, (res) => { res.resume(); res.on("end", () => resolve({ ok: true, status: res.statusCode })); });
  req.on("error", (error) => resolve({ ok: false, code: error.code, message: error.message }));
  req.end();
});
function hook(suffix, answer) {
  const original = dns.lookup;
  dns.lookup = (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (hostname.endsWith(suffix)) {
      return options?.all ? process.nextTick(() => callback(null, [{ address: answer, family: 4 }])) : process.nextTick(() => callback(null, answer, 4));
    }
    return original.call(dns, hostname, options, callback);
  };
  return () => { dns.lookup = original; };
}

test("guard is preloaded", () => assert.notEqual(net.Socket.prototype.connect.name, "", "connect is wrapped"));

test("an outside hostname is refused before any connection", async () => {
  const result = await get("outside.example.com");
  assert.equal(result.ok, false);
  assert.equal(result.code, "EISOLATION");
});

test("a hostname resolving to a non-loopback address is refused", async () => {
  const restore = hook(".rogue.example.test", "93.184.216.34");
  try {
    const result = await get("bucket.rogue.example.test");
    assert.equal(result.ok, false);
    assert.equal(result.code, "EISOLATION", result.message);
  } finally { restore(); }
});

test("a hostname the in-process resolver maps to loopback is allowed", async () => {
  const restore = hook(".objects.example.test", "127.0.0.1");
  try {
    const result = await get("bucket.objects.example.test");
    assert.deepEqual(result, { ok: true, status: 200 });
  } finally { restore(); }
});

test("a direct non-loopback IP is refused", async () => {
  const result = await get("93.184.216.34");
  assert.equal(result.ok, false);
  assert.equal(result.code, "EISOLATION");
});

test("a caller-supplied resolver cannot widen access", async () => {
  const result = await get("custom.example.com", { lookup: (_h, _o, cb) => cb(null, "127.0.0.1", 4) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "EISOLATION");
});

test.after(() => server.close());
