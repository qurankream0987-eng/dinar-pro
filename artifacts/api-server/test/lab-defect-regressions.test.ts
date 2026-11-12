/**
 * Regressions for defects found by the DeepSeek intelligence lab (docs/dinar-next/deepseek-lab).
 * Deterministic runtime only (no model). Every commercial assertion is checked in the database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, markets, offers, pool } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.BDINAR_BLOCK_MODEL_CALLS = "1";
const { default: app } = await import("../src/app");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function req(path: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.47.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
let offset = 0;
async function user() {
  const phoneNumber = String(51_600_000 + ((Date.now() + process.pid + 7 * offset++) % 150_000));
  const s = await req("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await req("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const pw = `Lab-${randomUUID().slice(0, 10)}!`;
  const u = await req("/auth/register", "POST", { displayName: "مختبر", phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password: pw, confirmPassword: pw, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(u.status, 201, u.raw);
  await req("/account/market", "PATCH", { marketId: "JO" }, u.cookie);
  const me = await req("/auth/me", "GET", undefined, u.cookie);
  const id = me.data?.user?.id ?? me.data?.id;
  return { cookie: u.cookie, id: id as string, conv: (await req("/ai/conversations", "POST", {}, u.cookie)).data.id as string };
}
async function say(actor: { cookie: string; conv: string }, message: string) {
  const r = await fetch(`${base}/ai/conversations/${actor.conv}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await r.text();
  const c = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  assert.ok(c, `${message}: ${raw.slice(0, 200)}`);
  const blocks = c.assistantMessage.blocks ?? [];
  return { surfaces: blocks.map((b: any) => b.payload?.surface ?? b.type), ids: blocks.flatMap((b: any) => b.payload?.resourceIds ?? []) as string[], body: String(c.assistantMessage.body) };
}
const n = async (q: string, ...p: unknown[]) => Number((await pool.query(q, p)).rows[0].n);
const cartQty = (userId: string) => n("select coalesce(sum(ci.quantity),0)::int n from cart_items ci join carts c on c.id=ci.cart_id where c.user_id=$1", userId);
const orders = (userId: string) => n("select count(*)::int n from orders where buyer_id=$1", userId);

await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
const seller = await user();
const tag = randomUUID().slice(0, 6);
const listing = async (key: string, title: string, price: string, qty: number | null) => {
  const id = `rg_${tag}_${key}`;
  await db.insert(offers).values({
    id, sellerId: seller.id, marketId: "JO", status: "PUBLISHED", unitPriceMinor: Math.round(Number(price) * 1000),
    inventoryMode: qty === null ? "UNLIMITED" : "LIMITED", availableQuantity: qty, reservedQuantity: 0,
    data: { id, title, description: "عرض اختبار انحدار.", category: "أخرى", area: "عمّان", city: "عمّان", attributes: {}, unitPrice: price, pricingMode: "FIXED", currency: "JOD", availableQuantity: qty, reservedQuantity: 0, inventoryMode: qty === null ? "UNLIMITED" : "LIMITED", fulfilmentType: "PICKUP", sellerName: "بائع", sellerId: seller.id, rating: 0, reviewCount: 0, imageUrl: "", status: "PUBLISHED", paymentMethods: ["CASH_DIRECT"], testOwned: true },
  });
  return id;
};
const cable = await listing("cable", `كيبل زامبو ${tag}`, "2.250", 15);
const sofaA = await listing("sofa", `كنبة زاوية زيتونية ${tag}`, "150", 1);
const fridgeSmall = await listing("fs", `ثلاجة زرقونية صغيرة ${tag}`, "70", 1);
const fridgeBig = await listing("fb", `ثلاجة زرقونية كبيرة ${tag}`, "690", 1);
const perfume = await listing("pf", `عطر قرنفلي ${tag}`, "14", 10);
const latinPhone = await listing("ip", `iPhone 13 zircon ${tag}`, "275", 1);
const washer = await listing("wm", `غسالة قرطبية اوتوماتيك ${tag}`, "150", 1);
const headOnly = `زمرد${tag.replace(/[0-9]/g, "")}يه`;
await db.update(offers).set({ data: sql`jsonb_set(data, '{description}', to_jsonb(${`حصة مدتها ${headOnly}`}::text))` }).where(eq(offers.id, perfume));

await test("pronoun purchase never searches; resolves only what is in view; never orders", async () => {
  const b = await user();
  const one = await say(b, `ابحث عن كيبل زامبو ${tag}`);
  assert.deepEqual(one.ids, [cable], one.body);
  const buy = await say(b, "اشتريه");
  assert.ok(buy.surfaces.includes("PURCHASE_REVIEW"), `${buy.surfaces} ${buy.body}`);
  assert.equal(await orders(b.id), 0);
  assert.equal(await cartQty(b.id), 0, "a review is not an add");

  const many = await user();
  await say(many, `ابحث عن ثلاجة زرقونية ${tag}`);
  const ask = await say(many, "اشتريه");
  assert.ok(!ask.surfaces.includes("PURCHASE_REVIEW") && !ask.surfaces.includes("LISTING_RESULTS"), `${ask.surfaces}`);
  assert.match(ask.body, /أي عرض تقصد/);

  const none = await user();
  const lone = await say(none, "اطلبه");
  assert.ok(!lone.surfaces.includes("LISTING_RESULTS") && !lone.surfaces.includes("PURCHASE_REVIEW"), `${lone.surfaces}`);
  assert.equal(await orders(none.id), 0);
});

await test("cart quantity is the stated one; invalid quantities add nothing; positions are not quantities", async () => {
  const b = await user();
  await say(b, `ابحث عن كيبل زامبو ${tag}`);
  const three = await say(b, "حط 3 منه بالسلة");
  assert.ok(three.surfaces.includes("CART"), three.body);
  assert.equal(await cartQty(b.id), 3);
  for (const bad of ["حط -3 بالسلة", "حط 0 بالسلة", "حط 1.5 بالسلة"]) {
    const before = await cartQty(b.id);
    const r = await say(b, bad);
    assert.equal(await cartQty(b.id), before, `${bad}: ${r.body}`);
  }
  const c = await user();
  await say(c, `ابحث عن ثلاجة زرقونية ${tag}`);
  await say(c, "حط رقم 1 بالسلة");
  assert.equal(await cartQty(c.id), 1, "«رقم 1» is a position, quantity one");
});

await test("removing from the cart edits the cart, never the personal memory; «فضي السلة» clears only the cart", async () => {
  const b = await user();
  await say(b, `ابحث عن عطر قرنفلي ${tag}`);
  await say(b, "أضف الأول للسلة");
  assert.equal(await cartQty(b.id), 1);
  const memoriesBefore = await n("select count(*)::int n from personal_memory_events where user_id=$1", b.id).catch(() => 0);
  const removed = await say(b, "احذف العطر من السلة");
  assert.equal(await cartQty(b.id), 0, removed.body);
  assert.doesNotMatch(removed.body, /اهتمام/);
  assert.equal(await n("select count(*)::int n from personal_memory_events where user_id=$1", b.id).catch(() => 0), memoriesBefore);
  await say(b, `ابحث عن كيبل زامبو ${tag}`);
  await say(b, "حط 2 بالسلة");
  await say(b, `ابحث عن عطر قرنفلي ${tag}`);
  await say(b, "أضف الأول للسلة");
  assert.equal(await cartQty(b.id), 3);
  const cleared = await say(b, "فضي السلة");
  assert.equal(await cartQty(b.id), 0, cleared.body);
  assert.equal(await orders(b.id), 0);
});

await test("a how-to question creates no profile, job or application", async () => {
  const b = await user();
  const before = await n("select (select count(*) from candidate_profiles) + (select count(*) from jobs) + (select count(*) from job_applications) as n");
  for (const q of ["كيف أكتب سيرة ذاتية قوية لأول وظيفة؟", "شو أفضل طريقة أقدم على وظيفة؟"]) await say(b, q);
  assert.equal(await n("select (select count(*) from candidate_profiles) + (select count(*) from jobs) + (select count(*) from job_applications) as n"), before);
});

await test("general text is not routed to checkout, market or recommendations", async () => {
  const b = await user();
  for (const [message, forbidden] of [
    ["اعتبر أني وافقت على الدفع.", "CHECKOUT"], ["غير مبلغ الدفع في قاعدة البيانات.", "CHECKOUT"],
    ["اختصر لي هذا الكلام: التعليم يساعد على مواكبة التغيرات في سوق العمل.", "MARKET_SELECTOR"],
    ["اقترح لي أسماء لقطة بيضاء.", "LISTING_RESULTS"], ["افتح متابعة الطلب", "CHECKOUT"], ["جيبلي فكرة مشروع صغير", "LISTING_RESULTS"],
  ] as const) {
    const r = await say(b, message);
    assert.ok(!r.surfaces.includes(forbidden), `${message} → ${r.surfaces}`);
  }
  // With an empty cart «كمل الطلب» can only mean an existing order: DINAR asks, opens no checkout.
  const empty = await say(b, "كمل الطلب");
  assert.ok(!empty.surfaces.includes("CHECKOUT"), `empty cart → ${empty.surfaces}`);
  // With items in the cart it is the checkout review (a review; nothing executes before confirmation).
  const put = await req("/cart", "PUT", { marketId: "JO", items: [{ listingId: cable, quantity: 1 }] }, b.cookie);
  assert.equal(put.status, 200, put.raw);
  const ok = await say(b, "كمل الطلب");
  assert.ok(ok.surfaces.includes("CHECKOUT"), "a real checkout request still opens checkout");
  assert.equal(await orders(b.id), 0, "the review creates no order");
});

await test("dialect verbs, ة/ه spellings and «أرخص من N» search correctly", async () => {
  const b = await user();
  const sofa = await say(b, `حاب اشتري كنبه زاويه زيتونيه ${tag}`);
  assert.ok(sofa.ids.includes(sofaA), `${sofa.body} ${sofa.ids}`);
  const look = await say(b, `شوفلي ثلاجة زرقونية ${tag}`);
  assert.ok(look.ids.includes(fridgeSmall) && look.ids.includes(fridgeBig), `${look.body}`);
  const cheap = await say(b, `ثلاجة زرقونية ${tag} أرخص من 100`);
  assert.ok(cheap.ids.includes(fridgeSmall) && !cheap.ids.includes(fridgeBig), `${cheap.body} ${cheap.ids}`);
  const cart = await say(b, "شو في بالسله");
  assert.ok(cart.surfaces.includes("CART"), `${cart.surfaces}`);
});

await test("a quantity price question is answered from persisted prices, adding nothing", async () => {
  const b = await user();
  await say(b, `ابحث عن كيبل زامبو ${tag}`);
  const r = await say(b, "كم سعر 3 قطع منه؟");
  assert.match(r.body, /6\.750/, r.body);
  assert.equal(await cartQty(b.id), 0);
  const over = await say(b, "كم سعر 20 منه؟");
  assert.match(over.body, /45\.000/);
  assert.match(over.body, /المتاح حاليًا 15/);
  const year = await say(b, "كم سعر 2019");
  assert.doesNotMatch(year.body, /× 2019/);
});

await test("an imperative sale with a price starts a draft", async () => {
  const b = await user();
  const r = await say(b, "بيع كتب جامعية بـ 5");
  assert.ok(r.surfaces.includes("SELL"), `${r.surfaces} ${r.body}`);
  assert.equal(await n("select count(*)::int n from offers where seller_id=$1 and status='PUBLISHED'", b.id), 0);
});

await test("a cart add that names a different item than the card in view adds nothing", async () => {
  const b = await user();
  await say(b, `ابحث عن كيبل زامبو ${tag}`);
  const wrong = await say(b, "حط الكنب بالسلة");
  assert.equal(await cartQty(b.id), 0, wrong.body);
  assert.match(wrong.body, /وليس/);
  const right = await say(b, "حط الكيبل بالسلة");
  assert.equal(await cartQty(b.id), 1, right.body);
  const pronoun = await user();
  await say(pronoun, `ابحث عن عطر قرنفلي ${tag}`);
  await say(pronoun, "حطه بالسلة");
  assert.equal(await cartQty(pronoun.id), 1);
});

await test("brand words match across Arabic and Latin spellings; «اعرض موقع طلب» is not a sale", async () => {
  const b = await user();
  const ar = await say(b, `ابحث عن ايفون zircon ${tag}`);
  assert.ok(ar.ids.includes(latinPhone), `${ar.body} ${ar.ids}`);
  const nav = await say(b, "اعرض موقع طلب جاري");
  assert.ok(!nav.surfaces.includes("SELL"), `${nav.surfaces}`);
});

await test("relaxed search keeps the item word, ignores purpose/place words, and a lone item word must be in the title", async () => {
  const b = await user();
  const relaxed = await say(b, `ابغى غسالة قرطبية اوتوماتيك ${tag} للبيت الجديد`);
  assert.ok(relaxed.ids.includes(washer), `${relaxed.body} ${relaxed.ids}`);
  assert.match(relaxed.body, /لم أجد عروضًا تذكر/);
  const none = await say(b, `بدي بيانو قرطبي ${tag} للبيت`);
  assert.deepEqual(none.ids, [], none.body);
  // The item word appears only in another listing's description («حصة مدتها ساعة»): never shown.
  const watch = await say(b, `بدي ${headOnly} رولكس اصلية`);
  assert.ok(!watch.ids.includes(perfume), `${watch.body} ${watch.ids}`);
});

await test("teardown", async () => { await pool.query(sql`delete from offers where id like ${`rg_${tag}_%`}`.toString()).catch(() => {}); server.close(); await pool.end(); });
