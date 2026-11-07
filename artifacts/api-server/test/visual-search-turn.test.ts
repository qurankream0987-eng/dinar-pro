/**
 * VST — a photo sent in the ONE conversation: private upload, the existing runtime searches the
 * real catalogue, labels come from persisted listings, strangers cannot use the photo, seller
 * listing photos and search photos never mix, and with no image model the turn says so honestly.
 * The analyzer is a local stand-in (no network, no spend); this is not evidence about Gemma.
 */
import { localObjectStorage } from "./local-object-storage";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import app from "../src/app";
import type { VisualAnalyzer } from "../src/ai/visual-search";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");

let analyzerCalls = 0;
let mode: "phone" | "blocked" = "phone";
app.locals.visualAnalyzer = {
  async analyze() {
    analyzerCalls++;
    return mode === "blocked"
      ? { status: "BLOCKED_PROVIDER", reason: "NO_IMAGE_MODEL" }
      : { status: "ANALYZED", analysis: { isProduct: true, brand: "iPhone", model: "14 Pro", category: "هواتف", keywords: ["ايفون"], confidence: 0.9 } };
  },
} satisfies VisualAnalyzer;

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

type Actor = { id: string; cookie: string };
async function call(path: string, actor?: Actor, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(actor ? { cookie: actor.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data, text };
}
async function register(label: string): Promise<Actor> {
  const r = await call("/auth/register", undefined, {
    displayName: label, phoneCountryCode: "+962", phoneNumber: `79${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`,
    accountCountry: "JO", password: "visual-search-local-1", confirmPassword: "visual-search-local-1", acceptTerms: true,
  });
  assert.equal(r.response.status, 201, r.text);
  return { id: r.data.user.id, cookie: r.response.headers.getSetCookie().find((x) => x.startsWith("bdinar_session="))!.split(";")[0]! };
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
async function upload(actor: Actor, kind: "visual-search" | "listing-photos") {
  const ticket = await call(`/account/${kind}/upload-url`, actor, { contentType: "image/jpeg", size: JPEG.length });
  assert.equal(ticket.response.status, 200, ticket.text);
  const put = await fetch(ticket.data.uploadURL, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG });
  assert.ok(put.ok);
  const done = await call(`/account/${kind}/complete`, actor, { objectPath: ticket.data.objectPath });
  assert.equal(done.response.status, 200, done.text);
  return done.data.objectPath as string;
}
async function conversation(actor: Actor) {
  const r = await call("/ai/conversations", actor, {});
  assert.ok(r.response.status < 300, r.text);
  return r.data.id as string;
}

const buyer = await register("مشتري صورة");
const stranger = await register("غريب");

await test("VST-01 a photo search runs through the one runtime and labels real listings", async () => {
  const path = await upload(buyer, "visual-search");
  assert.match(path, new RegExp(`^/objects/visual-search/${buyer.id}/`));
  const id = await conversation(buyer);
  const turn = await call(`/ai/conversations/${id}/turns`, buyer, { message: "دينار، أريد هذا المنتج", imageObjectPaths: [path] });
  assert.equal(turn.response.status, 200, turn.text);
  assert.match(turn.text, /من الصورة فهمت: iPhone 14 Pro/);
  assert.ok(turn.text.includes('"visualMatch":"EXACT"'), turn.text.slice(0, 3000));
  assert.ok(turn.text.includes("iPhone 14 Pro بحالة ممتازة"), "the result is a real persisted listing");
});

await test("VST-02 a stranger cannot use, read or complete the buyer's photo", async () => {
  const path = await upload(buyer, "visual-search");
  const id = await conversation(stranger);
  const turn = await call(`/ai/conversations/${id}/turns`, stranger, { message: "ابحث", imageObjectPaths: [path] });
  assert.equal(turn.response.status, 403, turn.text);
  assert.equal((await call("/account/visual-search/complete", stranger, { objectPath: path })).response.status, 403);
  const read = await fetch(base + `/storage${path}`, { headers: { cookie: stranger.cookie } });
  assert.equal(read.status, 404, "a private search photo is never served to another account");
  const own = await fetch(base + `/storage${path}`, { headers: { cookie: buyer.cookie } });
  assert.equal(own.status, 200, "the owner sees their own photo in the conversation");
  assert.equal((await fetch(base + `/storage${path}`)).status, 404, "guests never see it");
});

await test("VST-03 search photos and listing photos never mix or swap", async () => {
  const search = await upload(buyer, "visual-search");
  const listing = await upload(buyer, "listing-photos");
  const id = await conversation(buyer);
  const mixed = await call(`/ai/conversations/${id}/turns`, buyer, { message: "ابحث", imageObjectPaths: [search, listing] });
  assert.equal(mixed.response.status, 400, mixed.text);
  const two = await call(`/ai/conversations/${id}/turns`, buyer, { message: "ابحث", imageObjectPaths: [search, await upload(buyer, "visual-search")] });
  assert.equal(two.response.status, 400, two.text);
  // A search photo cannot be completed as a listing photo, nor the reverse.
  assert.equal((await call("/account/listing-photos/complete", buyer, { objectPath: search })).response.status, 403);
  assert.equal((await call("/account/visual-search/complete", buyer, { objectPath: listing })).response.status, 403);
});

await test("VST-04 no image model: honest text, nothing inferred from the photo", async () => {
  mode = "blocked";
  const before = analyzerCalls;
  const path = await upload(buyer, "visual-search");
  const id = await conversation(buyer);
  const turn = await call(`/ai/conversations/${id}/turns`, buyer, { message: "دينار، أريد هذا المنتج", imageObjectPaths: [path] });
  assert.equal(turn.response.status, 200, turn.text);
  assert.equal(analyzerCalls, before + 1);
  assert.match(turn.text, /تعذر تحليل الصورة الآن، فلم أستنتج منها شيئًا/);
  assert.doesNotMatch(turn.text, /"visualMatch"/);
  mode = "phone";
});

await test("VST-05 guests cannot upload search photos", async () => {
  const r = await call("/account/visual-search/upload-url", undefined, { contentType: "image/jpeg", size: 10 });
  assert.equal(r.response.status, 401);
});

await test("VST-06 a photo search among partners uses the canonical Connect search and invents nothing", async () => {
  const path = await upload(buyer, "visual-search");
  const id = await conversation(buyer);
  const turn = await call(`/ai/conversations/${id}/turns`, buyer, { message: "ابحث عن هذا عند الشركاء", imageObjectPaths: [path] });
  assert.equal(turn.response.status, 200, turn.text);
  // The seed has no approved partner catalogue: the canonical Connect path says so honestly.
  assert.match(turn.text, /لا توجد عروض شركاء معتمدة مطابقة حاليًا؛ لم أختلق عروضًا أو أسعارًا/);
  assert.doesNotMatch(turn.text, /"visualMatch"/);
});

server.close();
await localObjectStorage?.close?.();
await pool.end();
