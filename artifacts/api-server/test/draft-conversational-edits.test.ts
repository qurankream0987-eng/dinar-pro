/** A seller corrects the listing draft in their own words, at any point, without a model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, markets, pool } from "@workspace/db";
import { draftFieldEdit, statedQuantity } from "../src/ai/draft-field-edit";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const { default: app } = await import("../src/app");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function req(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.46.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
let offset = 0;
async function seller() {
  const phoneNumber = String(51_600_000 + ((Date.now() + process.pid + 3 * offset++) % 150_000));
  const s = await req("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await req("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const pw = `Draft-${randomUUID().slice(0, 10)}!`;
  const u = await req("/auth/register", "POST", { displayName: "بائع المسودة", phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password: pw, confirmPassword: pw, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(u.status, 201, u.raw);
  await req("/account/market", "PATCH", { marketId: "JO" }, u.cookie);
  return { cookie: u.cookie, conv: (await req("/ai/conversations", "POST", {}, u.cookie)).data.id as string };
}
async function say(actor: { cookie: string; conv: string }, message: string) {
  const r = await fetch(`${base}/ai/conversations/${actor.conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await r.text();
  const c = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  assert.ok(c, `${message}: ${raw.slice(0, 200)}`);
  const p = c.assistantMessage.blocks?.[0]?.payload ?? {};
  return { surface: p.surface as string, draft: (p.draft ?? {}) as Record<string, any>, step: p.draftStep as string, body: String(c.assistantMessage.body) };
}

await test("parser: explicit field edits only", () => {
  assert.deepEqual(draftFieldEdit("الكمية 2"), { field: "quantity", quantity: 2 });
  assert.deepEqual(draftFieldEdit("الكميه: حبتين"), { field: "quantity", quantity: 2 });
  assert.deepEqual(draftFieldEdit("العدد ٣"), { field: "quantity", quantity: 3 });
  assert.deepEqual(draftFieldEdit("الكمية غير محدودة"), { field: "unlimited" });
  assert.deepEqual(draftFieldEdit("غيّر العنوان إلى ايفون 13 برو"), { field: "title", value: "ايفون 13 برو" });
  assert.deepEqual(draftFieldEdit("المدينة إربد"), { field: "city", value: "إربد" });
  assert.deepEqual(draftFieldEdit("المنطقة: الحصن"), { field: "area", value: "الحصن" });
  assert.deepEqual(draftFieldEdit("أضف للوصف أن البطارية 89٪"), { field: "descriptionAppend", value: "البطارية 89٪" });
  assert.deepEqual(draftFieldEdit("احذف كلمة نظيف من الوصف"), { field: "descriptionRemove", value: "نظيف" });
  assert.deepEqual(draftFieldEdit("الوصف: جهاز بحالة ممتازة مع الكرتونة"), { field: "descriptionReplace", value: "جهاز بحالة ممتازة مع الكرتونة" });
  for (const other of ["ابحث عن ايفون", "كم سعر الايفون؟", "احذف اهتمام الساعات", "300", "مرحبا"]) assert.equal(draftFieldEdit(other), undefined, other);
  assert.equal(statedQuantity("عندي حبتين"), 2);
});

await test("edit the draft at any point; the current question is not lost", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  const s = await seller();
  const start = await say(s, "دينار بيع لي ايفون 13 مستعمل نظيف بسعر 300");
  assert.equal(start.surface, "SELL", start.body);
  assert.equal(start.draft.unitPrice, "300");

  const price = await say(s, "عدّل السعر إلى 280");
  assert.equal(price.surface, "SELL", price.body);
  assert.equal(price.draft.unitPrice, "280");

  const quantity = await say(s, "الكمية 2");
  assert.equal(quantity.surface, "SELL", quantity.body);
  assert.equal(quantity.draft.availableQuantity, "2");
  assert.equal(quantity.draft.unitPrice, "280", "«الكمية 2» is never read as a price");
  assert.match(quantity.body, /حدّثت الكمية إلى 2/);

  const add = await say(s, "أضف للوصف أن البطارية 89٪");
  assert.equal(add.surface, "SELL", add.body);
  assert.match(add.draft.description ?? "", /البطارية 89/);

  const remove = await say(s, "احذف كلمة البطارية 89٪ من الوصف");
  assert.equal(remove.surface, "SELL", `a description edit, never memory: ${remove.body}`);
  assert.doesNotMatch(remove.draft.description ?? "", /البطارية 89/);
  const missing = await say(s, "احذف كلمة كرتونة من الوصف");
  assert.equal(missing.surface, "SELL");
  assert.match(missing.body, /لم أجد/);

  const title = await say(s, "غيّر العنوان إلى ايفون 13 برو");
  assert.equal(title.surface, "SELL", title.body);
  assert.equal(title.draft.title, "ايفون 13 برو");

  const city = await say(s, "المدينة إربد");
  assert.equal(city.surface, "SELL", city.body);
  assert.equal(city.draft.city, "إربد");
  assert.equal(city.draft.unitPrice, "280");
  assert.equal(city.draft.availableQuantity, "2");
});

await test("an explicit edit resumes the draft after another reply came in between", async () => {
  const s = await seller();
  await say(s, "دينار بيع لي ساعة كاسيو مستعملة بسعر 40");
  const other = await say(s, "ابحث عن سماعات");
  assert.notEqual(other.surface, "SELL");
  const resumed = await say(s, "الكمية 3");
  assert.equal(resumed.surface, "SELL", resumed.body);
  assert.equal(resumed.draft.availableQuantity, "3");
  assert.equal(resumed.draft.unitPrice, "40", "the same draft, not a new one");
});

await test("without a draft, edits create nothing and memory commands still work", async () => {
  const s = await seller();
  const lone = await say(s, "الكمية 2");
  assert.notEqual(lone.surface, "SELL");
  const memory = await say(s, "احذف اهتمام الساعات");
  assert.equal(memory.surface, "MEMORY_UPDATED", memory.body);
});

await test("teardown", async () => { server.close(); await pool.end(); });
