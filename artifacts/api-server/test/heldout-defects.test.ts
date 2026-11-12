import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, markets, offers, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const server = app.listen(0, "127.0.0.1"); await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { server.close(); await pool.end(); });
let ip = 0;
async function req(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(`${origin}/api${path}`, { method, headers: { ...(method !== "GET" ? { "content-type": "application/json", origin } : {}), ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.51.9.${ip++ % 250 + 1}` }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, cookie: r.headers.getSetCookie().find((v) => v.startsWith("bdinar_session="))?.split(";")[0] ?? "" };
}
async function turnsOf(cookie: string, conv: string, msgs: string[]) {
  const out: { surfaces: string[]; body: string }[] = [];
  for (const m of msgs) {
    const r = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ message: m, clientMessageId: randomUUID() }) });
    const raw = await r.text(); const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return {}; } }).find((e: any) => e.type === "complete");
    out.push({ surfaces: (done?.assistantMessage?.blocks ?? []).map((x: any) => x.payload?.surface ?? x.type), body: String(done?.assistantMessage?.body ?? "") });
  }
  return out;
}
test("H-MT-014 «ضيف الأول» adds the first result; H-MATH-005 a stated amount is compared, not used as a ceiling", async () => {
  await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
  const mk = async () => { const n = `79${String((Date.now() + 7919 * ip++) % 1_000_000).padStart(6, "0")}${ip % 10}`; const u = await req("/auth/register", "POST", { displayName: "مختبر الإضافة", phoneCountryCode: "+962", phoneNumber: n, accountCountry: "JO", password: "probe-password-1", confirmPassword: "probe-password-1", acceptTerms: true }); assert.equal(u.status, 201, u.text); return u; };
  const seller = await mk(); const sellerId = (await req("/auth/me", "GET", undefined, seller.cookie)).data.user.id;
  const tag = randomUUID().slice(0, 5);
  await db.insert(offers).values({ id: `pr_${tag}`, sellerId, marketId: "JO", status: "PUBLISHED", unitPriceMinor: 14000, inventoryMode: "LIMITED", availableQuantity: 5, reservedQuantity: 0,
    data: { id: `pr_${tag}`, title: `عطر قرنفلي ${tag}`, description: "عطر", category: "أخرى", area: "عمّان", city: "عمّان", attributes: {}, unitPrice: "14", pricingMode: "FIXED", currency: "JOD", fulfilmentType: "PICKUP", imageUrl: "" } as any } as any);
  await db.insert(offers).values({ id: `ip_${tag}`, sellerId, marketId: "JO", status: "PUBLISHED", unitPriceMinor: 420000, inventoryMode: "LIMITED", availableQuantity: 1, reservedQuantity: 0,
    data: { id: `ip_${tag}`, title: `ايفون 13 برو ${tag}`, description: "جوال", category: "أخرى", area: "عمّان", city: "عمّان", attributes: {}, unitPrice: "420", pricingMode: "FIXED", currency: "JOD", fulfilmentType: "PICKUP", imageUrl: "" } as any } as any);
  const b = await mk(); await req("/account/market", "PATCH", { marketId: "JO" }, b.cookie);
  const conv = (await req("/ai/conversations", "POST", {}, b.cookie)).data.id;
  const [, add] = await turnsOf(b.cookie, conv, [`ابحث عن عطر قرنفلي ${tag}`, "ضيف الأول"]);
  assert.ok(add!.surfaces.includes("CART"), `«ضيف الأول» → ${add!.surfaces} ${add!.body.slice(0, 60)}`);
  const conv2 = (await req("/ai/conversations", "POST", {}, b.cookie)).data.id;
  const [, diff] = await turnsOf(b.cookie, conv2, [`ابحث عن ايفون 13 برو ${tag}`, "الفرق بينه وبين العادي 290؟"]);
  assert.match(diff!.body, /130/, diff!.body.slice(0, 120));
  assert.ok(!diff!.surfaces.includes("LISTING_RESULTS"), "not a new search with 290 as a ceiling");
  for (const m of [] as string[]) {
    const r = await fetch(`${origin}/api/ai/conversations/${conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: b.cookie, origin }, body: JSON.stringify({ message: m, clientMessageId: randomUUID() }) });
    const raw = await r.text(); const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return {}; } }).find((e: any) => e.type === "complete");
    console.log("PROBE", m, "→", JSON.stringify((done?.assistantMessage?.blocks ?? []).map((x: any) => x.payload?.surface ?? x.type)), String(done?.assistantMessage?.body ?? "").slice(0, 90));
  }
});
