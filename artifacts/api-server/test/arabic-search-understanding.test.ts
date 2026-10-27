/**
 * Claude 02 (SC02/SC05/SC06/SC08): everyday Arabic requests must find the listings that exist.
 * Search previously required every word of the request literally, so «أحد ينظف بيتي»,
 * «ماكينة … لتغليف المنتجات» and «يصمم لي شعارًا لمقهى» found nothing although matching listings
 * were published, and «بحد أقصى 5 آلاف» became a 5-unit price ceiling. The fixes are general
 * (attached particles, tanween, possessives, plurals, verb ↔ verbal noun, a small everyday lexicon,
 * filler words, an honestly reported relaxed purpose word) — never per-product rules — and
 * unrelated requests must keep returning nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, markets, pool } from "@workspace/db";
import app from "../src/app";
import { resolveMarket } from "../src/lib/markets";
import { executeRegisteredTool } from "../src/ai/tool-registry";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const run = randomUUID().slice(0, 6);

async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { status: response.status, data, text, cookie: response.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
let phone = 0;
async function register(name: string) {
  const number = `79${(Date.now() % 1_000_000).toString().padStart(6, "0")}${phone++ % 10}`;
  const password = "arabic-search-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return created.cookie;
}
const seller = await register("بائع البحث العربي");
const buyer = await register("مشتري البحث العربي");
const ids: Record<string, string> = {};
async function publish(key: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 3,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: {}, ...body,
  }, seller);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
}
await publish("machine", { title: `ماكينة تغليف صناعية مستعملة ${run}`, description: "ماكينة تغليف 220 فولت مستعملة بحالة جيدة", category: "أخرى", categoryId: "other", attributes: { condition: "مستعمل" }, unitPrice: "2500" });
await publish("cleaning", { title: `تنظيف منازل عميق ${run}`, description: "تنظيف منازل وشقق عادي وعميق", category: "خدمات", categoryId: "services", unitPrice: "40", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE" });
await publish("logo", { title: `تصميم شعار احترافي ${run}`, description: "تصميم شعار مع تعديلات", category: "خدمات رقمية", categoryId: "digital-services", unitPrice: "50", inventoryMode: "UNLIMITED", availableQuantity: null, fulfilmentType: "SERVICE" });
await publish("prado", { title: `تويوتا برادو 2021 ${run}`, description: "سيارة برادو مستعملة", category: "سيارات", categoryId: "cars", attributes: { make: "تويوتا", model: "برادو", year: 2021, condition: "مستعمل" }, unitPrice: "4500", pricingMode: "NEGOTIABLE", availableQuantity: 1 });

const JO = await resolveMarket((await db.select().from(markets).where(eq(markets.id, "JO")))[0]!);
async function search(query: string) {
  const { result } = await executeRegisteredTool("searchListings", JSON.stringify({ query }), { conversationId: randomUUID(), market: JO });
  return { ids: result.listings.map((listing) => listing.id), broadenedFrom: (result.query as any)?.broadenedFrom as string[] | undefined };
}

await test("everyday phrasings find the published listing", async () => {
  for (const [query, expected] of [
    ["ماكينة صناعية مستعمل لتغليف المنتجات", "machine"], // attached لـ + generic «products»
    ["الماكينات الصناعية", "machine"],                    // plural and article
    ["احد ينظف بيتي الخميس", "cleaning"],                // filler, verb → verbal noun, possessive, house ≈ homes, weekday
    ["يصمم شعارا", "logo"],                               // verb → verbal noun, tanween
  ] as const) {
    const found = await search(query);
    assert.ok(found.ids.includes(ids[expected]!), `${query} → ${expected}: ${JSON.stringify(found)}`);
  }
});

await test("a purpose word that no listing mentions is relaxed and reported, never silently dropped", async () => {
  const found = await search("احد يصمم لي شعارا لمقهي");
  assert.ok(found.ids.includes(ids.logo!), JSON.stringify(found));
  assert.deepEqual(found.broadenedFrom, ["لمقهي"], "the reply must say the café was not matched");
});

await test("unrelated requests still find nothing (precision is kept)", async () => {
  for (const query of ["شاحن لابتوب", "فستان سهرة", "طاولة طعام", "ينظف سيارتي"]) {
    const found = await search(query);
    const ours = found.ids.filter((id) => Object.values(ids).includes(id));
    assert.deepEqual(ours, [], `${query}: ${JSON.stringify(found)}`);
  }
});

await test("«بحد أقصى 5 آلاف» is a ceiling of 5,000, not 5 (conversation)", async () => {
  const conversation = (await request("/ai/conversations", "POST", {}, buyer)).data.id;
  const turn = async (message: string) => {
    const response = await fetch(`${origin}/api/ai/conversations/${conversation}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: buyer, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
    const raw = await response.text();
    const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
    return { listings: (complete?.assistantMessage?.blocks?.[0]?.payload?.listings ?? []) as Array<{ id: string }>, body: String(complete?.assistantMessage?.body ?? "") };
  };
  assert.ok((await turn("دينار أبي برادو مستعملة")).listings.some((listing) => listing.id === ids.prado));
  const capped = await turn("خلها بحد أقصى 5 آلاف");
  assert.ok(capped.listings.some((listing) => listing.id === ids.prado), `4,500 is under 5,000: ${capped.body}`);
  assert.doesNotMatch(capped.body, /حتى 5 JOD/u);
  const lower = await turn("لا، خلها تحت 4 آلاف");
  assert.ok(!lower.listings.some((listing) => listing.id === ids.prado), `4,500 is over 4,000: ${lower.body}`);
});

await test("SC05/SC08 through the conversation: the same requests reach the listings", async () => {
  for (const [message, expected] of [["دينار أريد أحد ينظف بيتي الخميس", "cleaning"], ["دينار أبي أحد يصمم لي شعارًا لمقهى", "logo"]] as const) {
    const conversation = (await request("/ai/conversations", "POST", {}, buyer)).data.id;
    const response = await fetch(`${origin}/api/ai/conversations/${conversation}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: buyer, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
    const raw = await response.text();
    const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === "complete");
    const listings = (complete?.assistantMessage?.blocks?.[0]?.payload?.listings ?? []) as Array<{ id: string }>;
    assert.ok(listings.some((listing) => listing.id === ids[expected]), `${message}: ${complete?.assistantMessage?.body}`);
  }
});

after(async () => {
  server.close();
  await pool.end();
});
