/**
 * Claude 00, GHSA-mrhx-c7xc-m3w5 exposure (Zod 3.25.76 accumulates one issue per failing array
 * element). A 128 KB JSON body can carry ~65k elements (~24 MB of issues per request), so every
 * JSON body is bounded by its total array elements before any route schema runs.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import app, { MAX_JSON_ARRAY_ELEMENTS } from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function post(path: string, body: string, cookie?: string) {
  const response = await fetch(`${origin}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body,
  });
  return { status: response.status, text: await response.text() };
}

const number = `79${(Date.now() % 10_000_000).toString().padStart(7, "0")}`.slice(0, 9);
const password = "bounds-password-000001";
const registered = await fetch(`${origin}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ displayName: "حدود الطلبات", phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true }),
});
assert.equal(registered.status, 201, await registered.clone().text());
const cookie = registered.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!;

await test("an oversized array inside the 128 KB limit is refused before schema validation", async () => {
  const flood = `{"items":[${Array(65_000).fill("1").join(",")}]}`;
  assert.ok(flood.length < 128 * 1024, "the attack fits under the byte limit");
  const response = await post("/checkout", flood, cookie);
  assert.equal(response.status, 413, response.text);
});

await test("nested arrays count toward the same body-wide bound", async () => {
  const row = `[${Array(100).fill("0").join(",")}]`;
  const nested = `{"items":[${Array(40).fill(row).join(",")}]}`;
  assert.equal((await post("/checkout", nested, cookie)).status, 413);
});

await test("ordinary bodies at the bound still reach their route", async () => {
  const atBound = `{"items":[${Array(MAX_JSON_ARRAY_ELEMENTS).fill("1").join(",")}]}`;
  assert.equal((await post("/checkout", atBound, cookie)).status, 400, "route schema rejects it, not the guard");
  assert.equal((await post("/checkout", `{"items":[]}`, cookie)).status === 413, false);
});

const healthy = async () => (await fetch(`${origin}/api/healthz`)).status === 200;

await test("deep nesting is bounded or validated, never a crash", async () => {
  const depth = 40_000; // 80 KB of brackets, inside the byte limit
  const deepArrays = `{"items":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  assert.equal((await post("/checkout", deepArrays, cookie)).status, 413, "each nested array counts as an element");
  const deepObjects = `{"items":${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}}`;
  assert.ok(deepObjects.length < 128 * 1024);
  const objects = await post("/checkout", deepObjects, cookie);
  assert.ok(objects.status === 400 || objects.status === 413, `${objects.status} ${objects.text.slice(0, 120)}`);
  assert.ok(await healthy(), "the process survives both");
});

await test("bodies over 128 KB are refused by the parser", async () => {
  const oversized = `{"note":"${"x".repeat(140 * 1024)}"}`;
  assert.equal((await post("/checkout", oversized, cookie)).status, 413);
  assert.ok(await healthy());
});

await test("a legitimate multi-item checkout is not mistaken for a flood", async () => {
  const items = Array.from({ length: 5 }, () => ({ listingId: `missing-${Math.random().toString(36).slice(2)}`, quantity: 1 }));
  const legit = await post("/checkout", JSON.stringify({ items, idempotencyKey: `bounds-legit-${Date.now()}-0000` }), cookie);
  assert.notEqual(legit.status, 413, legit.text);
  assert.notEqual(legit.status, 500, legit.text);
});

after(async () => {
  server.close();
  await pool.end();
});
