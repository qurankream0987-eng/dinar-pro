/**
 * Seller classification and commission acceptance (DINAR_SELLER_CLASSIFICATION=true). Real API,
 * real checkout, real conversation runtime, disposable loopback database, no network, no money.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { businessProfiles, connectPartners, db, markets, orders, pool, sellerClassifications, users } from "@workspace/db";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
process.env.DINAR_SELLER_CLASSIFICATION = "true";
delete process.env.DINAR_DEAL_PAYMENTS;

const { default: app } = await import("../src/app");
const { connectProfitShare } = await import("../src/connect/profit-share");
const { resolveCommissionPolicy } = await import("../src/lib/commission-policy");
const { resolveSellerClassification } = await import("../src/lib/seller-classification");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
after(async () => {
  server.close();
  await pool.end();
});
let ip = Math.floor(Math.random() * 20_000);
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "X-Forwarded-For": `198.48.${(ip >> 8) & 255}.${ip++ & 255}` },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: response.status, data, raw };
}
const phoneBase = 51_450_000 + ((Date.now() + process.pid + 13) % 140_000);
let offset = 0;
type Actor = { id: string; cookie: string };
async function register(name: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Class-${randomUUID().slice(0, 10)}!`;
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Forwarded-For": `198.49.${(ip >> 8) & 255}.${ip++ & 255}` },
    body: JSON.stringify({ displayName: name, phoneCountryCode: "+965", phoneNumber, accountCountry: "KW", password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const data: any = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, cookie)).status, 200);
  return { id: data.user.id, cookie };
}

await db.update(markets).set({ isActive: true, status: "ACTIVE" }).where(eq(markets.id, "JO"));
const policyRate = (await resolveCommissionPolicy(db, { marketId: "JO" })).rateBasisPoints;
const buyer = await register("مشتري التصنيف");
const admin = await register("مسؤول التصنيف");
await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin.id));

async function listing(owner: Actor, input: { title: string; description?: string; price?: string; quantity?: number; categoryId?: string }) {
  const created = await request("/listings", "POST", {
    title: `${input.title} ${randomUUID().slice(0, 3)}`, description: `${input.description ?? "للبيع"} — للاختبار فقط لا يباع`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان",
    attributes: {}, unitPrice: input.price ?? "80.000", inventoryMode: "LIMITED", availableQuantity: input.quantity ?? 1, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [],
  }, owner.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
async function buy(listingId: string) {
  const created = await request("/orders", "POST", { listingId, quantity: 1, fulfilmentType: "PICKUP", idempotencyKey: `class-${randomUUID()}` }, buyer.cookie);
  assert.equal(created.status, 201, created.raw);
  const [row] = await db.select().from(orders).where(eq(orders.id, created.data.id));
  return row!;
}
const classification = async (who: Actor) => (await request("/seller-classification", "GET", undefined, who.cookie)).data;
const pct = (bps: number, minor: number) => Math.floor((minor * bps + 5_000) / 10_000);

test("SC-01 a personal item, declared personal: 0% commission, the seller keeps the whole price", async () => {
  const seller = await register("بائع سرير");
  const declared = await request("/seller-classification/declarations", "POST", { classification: "PERSONAL_SELLER", statement: "سريري الشخصي، اشتريت سريرًا جديدًا" }, seller.cookie);
  assert.equal(declared.status, 201, declared.raw);
  assert.equal(declared.data.classification, "PERSONAL_SELLER");
  assert.match(declared.data.notice, /ليس حكمًا قانونيًا/);
  const order = await buy(await listing(seller, { title: "سرير مستعمل", description: "سريري الشخصي مستعمل", price: "80.000" }));
  assert.deepEqual([order.platformFeeMinor, order.sellerAmountMinor, order.subtotalMinor], [0, 80_000, 80_000]);
  assert.equal((order.data as any).sellerClassification.classification, "PERSONAL_SELLER");
  assert.equal((order.data as any).commissionPolicy.rateBasisPoints, 0);
  assert.equal((order.data as any).commissionPolicy.sellerClassification.rule, "PERSONAL_SALE_NO_COMMISSION");
  const card = await request(`/orders/${order.id}/deal-card`, "GET", undefined, seller.cookie);
  assert.deepEqual([card.data.commission.amount, card.data.commission.state, card.data.commission.collected], ["0.000", "NONE", false]);
  assert.equal((await request(`/orders/${order.id}/deal-card`, "GET", undefined, buyer.cookie)).data.commission, null, "commission is the seller's business");
});

test("SC-02 several personal belongings (moving abroad) never make a merchant, however many listings", async () => {
  const seller = await register("مسافر يبيع أغراضه");
  for (const title of ["ثلاجة مستعملة", "غسالة مستعملة", "تلفزيون مستعمل", "كنب مستعمل", "مكتب مستعمل"])
    await listing(seller, { title, description: "أغراضي الشخصية للبيع بسبب السفر" });
  const view = await classification(seller);
  assert.equal(view.classification, "PERSONAL_SELLER", JSON.stringify(view));
  // Far beyond any plan limit: still personal, listing count carries no weight.
  for (let i = 0; i < 25; i++) await listing(seller, { title: `غرض مستعمل ${i}`, description: "مستعمل" });
  assert.equal((await classification(seller)).classification, "PERSONAL_SELLER", "exceeding a plan limit is not evidence of trade");
  assert.ok(!(await classification(seller)).signals.some((s: any) => /COUNT/.test(s.key)));
});

test("SC-03 stock-like selling makes an individual merchant without a company: policy rate on the order", async () => {
  const seller = await register("بائع هواتف");
  for (const title of ["هاتف جديد A15", "هاتف جديد A25", "هاتف جديد S24"])
    await listing(seller, { title, description: "جديد بالكرتونة كفالة وكيل، متوفر بكميات", quantity: 10, categoryId: "phones", price: "400.000" });
  const view = await classification(seller);
  assert.equal(view.classification, "INDIVIDUAL_MERCHANT", JSON.stringify(view));
  assert.ok(view.signals.some((s: any) => s.key === "MULTI_UNIT_STOCK"));
  const order = await buy(await listing(seller, { title: "هاتف جديد", description: "جديد بالكرتونة", quantity: 5, categoryId: "phones", price: "400.000" }));
  assert.equal(order.platformFeeMinor, pct(policyRate, 400_000));
  assert.equal(policyRate, 500, "the published marketplace rate is 5%");
  assert.equal(order.platformFeeMinor, 20_000, "400 × 5% = 20");
  const [row] = await db.select().from(sellerClassifications).where(and(eq(sellerClassifications.sellerId, seller.id), eq(sellerClassifications.source, "SIGNALS")));
  assert.ok(row, "the derived classification is recorded with its reason and signals");
  const card = await request(`/orders/${order.id}/deal-card`, "GET", undefined, seller.cookie);
  assert.equal(card.data.commission.state, "DUE_ON_COMPLETION");
  assert.equal(card.data.commission.collected, false);
  assert.match(card.data.commission.note, /ليست محصّلة/);
  assert.equal(card.data.commission.sellerNetBeforeOtherCosts, "380.000");
});

test("SC-04 one item and no evidence either way: no automatic commercial classification, no commission", async () => {
  const seller = await register("بائع غامض");
  const order = await buy(await listing(seller, { title: "طاولة", description: "طاولة خشب" }));
  assert.equal((order.data as any).sellerClassification.classification, "UNDER_REVIEW");
  assert.equal(order.platformFeeMinor, 0);
});

test("SC-05 a declaration contradicted by strong stock evidence goes to review; appeal and admin decision are recorded", async () => {
  const seller = await register("تصريح متناقض");
  for (const title of ["سماعة جديدة 1", "سماعة جديدة 2", "سماعة جديدة 3"])
    await listing(seller, { title, description: "جديد بالكرتونة بالجملة", quantity: 20, categoryId: "audio" });
  await request("/seller-classification/declarations", "POST", { classification: "PERSONAL_SELLER", statement: "هذه أغراضي الشخصية" }, seller.cookie);
  assert.equal((await classification(seller)).classification, "UNDER_REVIEW");
  const appeal = await request("/seller-classification/declarations", "POST", { classification: "PERSONAL_SELLER", statement: "هي هدايا لم أستعملها", appeal: true }, seller.cookie);
  assert.equal(appeal.data.classification, "UNDER_REVIEW");
  assert.equal(appeal.data.source, "APPEAL");
  assert.equal((await request("/admin/seller-classifications", "POST", { sellerId: seller.id, marketId: "JO", classification: "INDIVIDUAL_MERCHANT", reason: "x" }, seller.cookie)).status, 403);
  const decided = await request("/admin/seller-classifications", "POST", { sellerId: seller.id, marketId: "JO", classification: "INDIVIDUAL_MERCHANT", reason: "مخزون متجدد بكميات" }, admin.cookie);
  assert.equal(decided.status, 201, decided.raw);
  assert.equal(decided.data.source, "ADMIN");
  await assert.rejects(db.execute(sql`UPDATE seller_classifications SET reason = 'x' WHERE seller_id = ${seller.id}`), (e: any) => /append-only/.test(String(e?.cause?.message ?? e?.message)));
});

test("SC-06 a verified business pays the marketplace rate; an approved Connect partner does not", async () => {
  const company = await register("شركة مسجلة");
  const partner = await register("متجر كونكت");
  const now = new Date();
  const business = async (owner: Actor, status: "VERIFIED" | "DRAFT") => {
    const id = randomUUID();
    await db.insert(businessProfiles).values({
      id, ownerUserId: owner.id, marketId: "JO", displayName: `نشاط ${id.slice(0, 4)}`, normalizedName: `nshat ${id.slice(0, 4)}`, categoryKey: "RETAIL", idempotencyKey: `bp-${id}`,
      verificationStatus: status, ...(status === "VERIFIED" ? { verifiedAt: now, verifiedBy: admin.id } : {}),
    } as any);
    return id;
  };
  await business(company, "VERIFIED");
  const partnerBusiness = await business(partner, "DRAFT");
  await db.insert(connectPartners).values({ id: randomUUID(), businessId: partnerBusiness, marketId: "JO", status: "APPROVED" });
  const companyOrder = await buy(await listing(company, { title: "منتج شركة", price: "100.000" }));
  assert.equal((companyOrder.data as any).sellerClassification.classification, "REGISTERED_BUSINESS");
  assert.equal(companyOrder.platformFeeMinor, pct(policyRate, 100_000));
  const partnerOrder = await buy(await listing(partner, { title: "حذاء رياضي", price: "50.000", quantity: 30, description: "جديد بالكرتونة" }));
  assert.equal((partnerOrder.data as any).sellerClassification.classification, "CONNECT_PARTNER");
  assert.equal(partnerOrder.platformFeeMinor, 0, "no automatic 5% on a Connect partner");
  const card = await request(`/orders/${partnerOrder.id}/deal-card`, "GET", undefined, partner.cookie);
  assert.match(card.data.commission.note, /اتفاقية Connect/);
});

test("SC-07 Connect share is 10% of direct profit after approved, documented costs — never of revenue", () => {
  const share = connectProfitShare({ revenueMinor: 50_000, costs: [{ label: "تكلفة تنفيذ", amountMinor: 30_000, approved: true, documented: true }] });
  assert.deepEqual([share.directProfitMinor, share.jassimShareMinor], [20_000, 2_000], "500 − 300 = 200 → 20");
  const partial = connectProfitShare({ revenueMinor: 50_000, costs: [{ label: "موثقة", amountMinor: 10_000, approved: true, documented: true }, { label: "غير معتمدة", amountMinor: 10_000, approved: false, documented: true }, { label: "بلا مستند", amountMinor: 10_000, approved: true, documented: false }] });
  assert.equal(partial.directProfitMinor, 40_000);
  assert.deepEqual(partial.excludedCosts.map((c) => c.reason), ["NOT_APPROVED", "NOT_DOCUMENTED"]);
  assert.equal(connectProfitShare({ revenueMinor: 10_000, costs: [{ label: "خسارة", amountMinor: 20_000, approved: true, documented: true }] }).jassimShareMinor, 0, "no share on a loss");
  assert.equal(connectProfitShare({ revenueMinor: 1_005, costs: [], shareBasisPoints: 1_000 }).jassimShareMinor, 101, "half-up rounding");
  assert.throws(() => connectProfitShare({ revenueMinor: -1, costs: [] }));
});

test("SC-08 a later classification change never reprices earlier orders", async () => {
  const seller = await register("بائع يتغير");
  await request("/seller-classification/declarations", "POST", { classification: "PERSONAL_SELLER", statement: "هاتفي الشخصي" }, seller.cookie);
  const listingId = await listing(seller, { title: "هاتف", price: "300.000", quantity: 3 });
  const before = await buy(listingId);
  assert.equal(before.platformFeeMinor, 0);
  await request("/admin/seller-classifications", "POST", { sellerId: seller.id, marketId: "JO", classification: "INDIVIDUAL_MERCHANT", reason: "أصبح يبيع مخزونًا" }, admin.cookie);
  const afterOrder = await buy(listingId);
  assert.equal(afterOrder.platformFeeMinor, pct(policyRate, 300_000));
  const [reread] = await db.select().from(orders).where(eq(orders.id, before.id));
  assert.deepEqual([reread!.platformFeeMinor, (reread!.data as any).sellerClassification.classification], [0, "PERSONAL_SELLER"], "earlier order untouched");
});

test("SC-09 conversation: the seller says what they sell; Jassim explains classification and commission", async () => {
  const seller = await register("بائع يتحدث");
  const created = await request("/ai/conversations", "POST", {}, seller.cookie);
  const conversationId = created.data.conversation?.id ?? created.data.id;
  const turn = async (message: string) => {
    const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: seller.cookie }, body: JSON.stringify({ message }) });
    const raw = await r.text();
    const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
    assert.ok(complete, raw.slice(0, 300));
    return complete.assistantMessage.body as string;
  };
  const personal = await turn("سريري الشخصي وأريد التخلص منه");
  assert.match(personal, /مقتنياتك الشخصية/);
  assert.match(personal, /لا عمولة على بيع مقتنياتك/);
  const asked = await turn("ما تصنيفي");
  assert.match(asked, /بائع فردي/);
  const trader = await turn("أنا أشتري الهواتف وأعيد بيعها");
  assert.match(trader, /نشاطك تجاري/);
  assert.match(trader, /5%/);
  const appeal = await turn("أعترض على التصنيف");
  assert.match(appeal, /أحلته للمراجعة/);
  assert.equal((await resolveSellerClassification(db, seller.id, "JO")).classification, "UNDER_REVIEW");
});

test("SC-10 no gateway, no invented money: the deal card offers no electronic method and no exchange rate", async () => {
  const seller = await register("بائع بلا بوابة");
  await request("/deal-payments/seller-methods", "PUT", { methods: [{ code: "CLIQ" }], replace: true }, seller.cookie);
  const order = await buy(await listing(seller, { title: "كتاب" }));
  const card = await request(`/orders/${order.id}/deal-card`, "GET", undefined, buyer.cookie);
  assert.equal(card.status, 200, card.raw);
  assert.ok(!card.data.acceptedMethods.some((m: any) => /GATEWAY|CARD|WHOP/.test(m.code)), "no fake electronic option");
  assert.ok(!/exchange|fxRate|سعر الصرف/i.test(card.raw), "no invented exchange rate");
  assert.equal(card.data.currency, "JOD");
  assert.equal((await request(`/orders/${order.id}/deal-card/actions`, "POST", { action: { type: "CHOOSE", method: "CARD_GATEWAY" } }, buyer.cookie)).data.code, "UNKNOWN_METHOD");
});

test("SC-11 switched off: everyone keeps the published rate (today's behaviour)", async () => {
  process.env.DINAR_SELLER_CLASSIFICATION = "false";
  try {
    const seller = await register("بائع والمفتاح مطفأ");
    await request("/seller-classification/declarations", "POST", { classification: "PERSONAL_SELLER", statement: "سريري الشخصي" }, seller.cookie);
    const order = await buy(await listing(seller, { title: "سرير", price: "80.000" }));
    assert.equal(order.platformFeeMinor, pct(policyRate, 80_000));
    assert.equal((order.data as any).sellerClassification, undefined);
  } finally {
    process.env.DINAR_SELLER_CLASSIFICATION = "true";
  }
});
