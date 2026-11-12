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

await test("service recall may qualify an old target but cannot substitute a different target", async () => {
  const found = await search("حد ينظف منزلي القديم");
  assert.ok(found.ids.includes(ids.cleaning!), JSON.stringify(found));
  assert.deepEqual(found.broadenedFrom, ["القديم"]);
  const wrong = await search("حد ينظف سيارتي القديمة");
  assert.ok(!wrong.ids.includes(ids.cleaning!), JSON.stringify(wrong));
});
after(async()=>{server.close();await pool.end();});
