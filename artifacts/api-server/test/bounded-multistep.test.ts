/**
 * The mandate's bounded multi-step example (§09) over real HTTP and PostgreSQL, model blocked:
 * «أبي هاتف مستعمل أقل من 100 دينار، قارن الأول والثاني، واسأل صاحب الأرخص عن البطارية، لكن لا
 * ترسل السؤال حتى أوافق.»
 *
 * One step per turn (task-plan.ts, «التالي»): a real search inside the budget, a comparison of
 * the actual results, and an unsent inquiry review to the seller whose listing the server's own
 * prices show is cheapest. Nothing is sent before «أرسل»; then exactly one message is.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, marketplaceInquiries, pool } from "@workspace/db";
import app from "../src/app";
import { splitCompoundRequest } from "../src/ai/task-plan";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const run = `م${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${((Date.now() + 6827 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "multistep-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const seller = await register("بائع الخطوات");
const buyer = await register("مشتري الخطوات");
const ids: Record<string, string> = {};
async function publish(key: string, title: string, price: string, condition: string) {
  const created = await request("/listings", "POST", {
    title: `${title} ${run}`, description: `${title} للبيع بحالة جيدة`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 1, fulfilmentType: "PICKUP",
    pricingMode: "FIXED", imageUrl: "", imageUrls: [], clientRequestId: randomUUID(),
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish("cheap", "هاتف سامسونج A12", "80", "مستعمل");
await publish("mid", "هاتف نوكيا G20", "95", "مستعمل");
await publish("over", "هاتف آيفون 11", "150", "مستعمل");
await publish("new", "هاتف ريدمي 9", "70", "جديد");

async function say(conv: string, message: string) {
  const response = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: buyer.cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  const payload = blocks.find((block: any) => block.payload?.surface)?.payload ?? blocks[0]?.payload ?? {};
  return { body: String(complete?.assistantMessage?.body ?? ""), payload, listingIds: ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id) };
}
const sent = async () => (await db.select().from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, buyer.id))).length;

await test("§09 search → compare → unsent question to the cheapest seller → explicit send", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;
  const first = await say(conv, `أبي هاتف مستعمل ${run} أقل من 100 دينار، قارن الأول والثاني، واسأل صاحب الأرخص عن البطارية، لكن لا ترسل السؤال حتى أوافق.`);
  const found = new Set(first.listingIds.filter((id) => Object.values(ids).includes(id)));
  assert.deepEqual([...found].sort(), [ids.cheap, ids.mid].sort(), `step 1 is a real search inside the budget, used only: ${first.body}`);
  assert.match(first.body, /الخطوة التالية/u, "the remaining steps are announced, not run");

  const compared = await say(conv, "التالي");
  assert.equal(compared.payload.surface, "COMPARISON", `step 2 compares the actual results: ${compared.body}`);
  assert.deepEqual(compared.payload.comparison.listings.map((listing: any) => listing.id).sort(), [ids.cheap, ids.mid].sort());

  const drafted = await say(conv, "التالي");
  assert.equal(drafted.payload.surface, "INQUIRY_DRAFT", `step 3 is an unsent review: ${drafted.body}`);
  assert.equal(drafted.payload.resourceId, ids.cheap, "the cheapest by the server's recorded prices");
  const body = String(drafted.payload.inquiry?.body ?? "");
  assert.match(body, /البطاري/u, `the question is about the battery: ${body}`);
  assert.doesNotMatch(body, /ترسل|اوافق|أوافق/u, "the hold instruction is not sent to the seller");
  assert.equal(await sent(), 0, "nothing sent before «أرسل»");

  const confirmed = await say(conv, "أرسل");
  assert.match(confirmed.body, /أُرسلت رسالتك/u, confirmed.body);
  assert.equal(await sent(), 1, "exactly one message, after the user's own confirmation");
});

await test("a comma before a seller's own «اعرض خدمتي/منتجي» is one sell request, not a plan (block-f5 F5-16)", () => {
  assert.equal(splitCompoundRequest("أنا أصلح مكيفات، اعرض خدمتي بـ15"), undefined);
  assert.equal(splitCompoundRequest("عندي جوال مستعمل، اعرضه بـ100"), undefined);
  assert.deepEqual(splitCompoundRequest("أبي هاتف أقل من 100، قارن الأول والثاني")?.steps, ["أبي هاتف أقل من 100", "قارن الأول والثاني"]);
});

await test("«صاحب الأرخص» with a tie asks which, never guesses", async () => {
  await publish("twin", "هاتف أوبو A16", "80", "مستعمل");
  const conv = (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;
  await say(conv, `أبي هاتف مستعمل ${run} أقل من 90 دينار`);
  const asked = await say(conv, "اسأل صاحب الأرخص عن البطارية");
  assert.notEqual(asked.payload.surface, "INQUIRY_DRAFT", `two listings share the lowest price: ${asked.body}`);
  assert.match(asked.body, /أي|اختر/u, asked.body);
});

after(async () => {
  server.close();
  await pool.end();
});
