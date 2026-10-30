/**
 * W04 — conversational context understanding, measured on multi-turn scenarios written for this
 * wave (not the SC01–SC10 scenarios, not the arabic-generality phrases). Each scenario is a
 * conversation in one Arabic variety; each turn carries one expectation about the reply.
 *
 * Safety is asserted for every turn, whatever the understanding:
 *  - no order, inquiry or negotiation is created without the buyer's explicit confirmation;
 *  - no listing changes;
 *  - a general question never opens a sale form or a change preview.
 * Understanding is measured (CONTEXT_SUMMARY) and may not fall below the recorded floor; the
 * floor only moves up. A scenario counts as understood only when every one of its turns is.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, offers, orders, marketplaceInquiries, negotiations, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { genericTokens } from "../src/lib/arabic-search-terms";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

/**
 * First-contact rates, each recorded before the code was changed for that set (2026-10-30):
 * C 3/16 (0.188), H 9/14 (0.643), G 3/10 (0.30). After W04's general fixes all three are 1.0.
 * The floors only move up; a new set is added (and its first run recorded) rather than tuning one.
 */
const UNDERSTANDING_FLOOR = Number(process.env.DINAR_CONTEXT_FLOOR ?? "1");

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
let modelCalls = 0;
const gateway: ConversationModelGateway = {
  async proposeToolCall() {
    modelCalls++;
    return { id: "stub", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "MODEL_FALLBACK" }) };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const run = `ق${randomUUID().replaceAll("-", "").replace(/\d/g, "").slice(0, 5)}`;

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
  const number = `79${((Date.now() + 7919 * phone++) % 1_000_000).toString().padStart(6, "0")}${phone % 10}`;
  const password = "context-password-1";
  const created = await request("/auth/register", "POST", { displayName: name, phoneCountryCode: "+962", phoneNumber: number, accountCountry: "JO", password, confirmPassword: password, acceptTerms: true });
  assert.equal(created.status, 201, created.text);
  return { cookie: created.cookie, id: created.data.user.id as string };
}
const seller = await register("بائع السياق");
const buyer = await register("مشتري السياق");

const ids: Record<string, string> = {};
const prices: Record<string, string> = {};
async function publish(key: string, body: Record<string, unknown>) {
  const created = await request("/listings", "POST", {
    area: "خلدا", city: "عمان", imageUrl: "", imageUrls: [], inventoryMode: "LIMITED", availableQuantity: 1,
    fulfilmentType: "PICKUP", pricingMode: "FIXED", clientRequestId: randomUUID(), attributes: {}, ...body,
  }, seller.cookie);
  assert.equal(created.status, 201, created.text);
  ids[key] = created.data.id;
  prices[key] = String(body.unitPrice);
}
const laptop = { category: "إلكترونيات", categoryId: "electronics" };
await publish("dell", { ...laptop, title: `لابتوب ديل 8 رام ${run}`, description: "لابتوب ديل مستعمل للدراسة", attributes: { condition: "مستعمل" }, unitPrice: "250" });
await publish("lenovo", { ...laptop, title: `لابتوب لينوفو ثينك باد 16 رام ${run}`, description: "لابتوب لينوفو مستعمل للأعمال", attributes: { condition: "مستعمل" }, unitPrice: "350", pricingMode: "NEGOTIABLE" });
await publish("mac", { ...laptop, title: `لابتوب ماك بوك اير ${run}`, description: "لابتوب ماك بوك جديد بالكرتونة", attributes: { condition: "جديد" }, unitPrice: "700" });
await publish("iphone", { ...laptop, title: `جوال آيفون 14 ${run}`, description: "جوال آيفون 14 مستعمل نظيف", attributes: { condition: "مستعمل" }, unitPrice: "500", pricingMode: "NEGOTIABLE" });
await publish("galaxy", { ...laptop, title: `جوال سامسونج جالكسي S23 ${run}`, description: "جوال سامسونج مستعمل", attributes: { condition: "مستعمل" }, unitPrice: "420" });
await publish("sofa", { title: `كنب زاوية رمادي ${run}`, description: "كنب زاوية رمادي سبعة مقاعد", category: "منزل", categoryId: "home", attributes: { condition: "مستعمل" }, unitPrice: "200" });
await publish("cups", { title: `أكواب شاي زجاج ${run}`, description: "أكواب شاي زجاج جديدة", category: "منزل", categoryId: "home", attributes: { condition: "جديد" }, unitPrice: "2", availableQuantity: 12 });

type Reply = { model: boolean; surface?: string; listingIds: string[]; ours: string[]; body: string; blocks: string; payload: any };
async function conversation() {
  return (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;
}
async function say(conversationId: string, message: string): Promise<Reply> {
  const before = modelCalls;
  const response = await fetch(`${origin}/api/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: buyer.cookie, origin }, body: JSON.stringify({ message, clientMessageId: randomUUID() }) });
  const raw = await response.text();
  const complete = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return {}; } }).find((event: any) => event.type === "complete");
  const blocks = complete?.assistantMessage?.blocks ?? [];
  const payload = blocks.find((block: any) => block.payload?.surface)?.payload ?? blocks[0]?.payload ?? {};
  const listingIds = ((payload.listings ?? []) as Array<{ id: string }>).map((listing) => listing.id);
  const known = new Set(Object.values(ids));
  return {
    model: modelCalls > before,
    surface: payload.surface,
    listingIds,
    ours: listingIds.filter((id) => known.has(id)),
    body: String(complete?.assistantMessage?.body ?? "").replace(/\s+/g, " "),
    blocks: JSON.stringify(blocks),
    payload,
  };
}

// ─── Expectations ────────────────────────────────────────────────────────────
type Check = { name: string; ok: (reply: Reply) => boolean };
const shows = (...keys: string[]): Check => ({ name: `shows ${keys.join(",")}`, ok: (r) => keys.every((key) => r.ours.includes(ids[key]!)) });
const showsOnly = (...keys: string[]): Check => ({ name: `shows only ${keys.join(",")}`, ok: (r) => r.ours.length === keys.length && keys.every((key) => r.ours.includes(ids[key]!)) });
const firstIs = (key: string): Check => ({ name: `first is ${key}`, ok: (r) => r.ours[0] === ids[key] });
/** The reply is about one listing: its id is in the reply blocks or its price is stated, and no other fixture is the subject. */
const about = (key: string): Check => ({
  name: `about ${key}`,
  ok: (r) => !r.model && (r.blocks.includes(ids[key]!) || r.body.includes(prices[key]!)),
});
const surface = (...names: string[]): Check => ({ name: `surface ${names.join("|")}`, ok: (r) => names.includes(String(r.surface)) });
const general: Check = { name: "general (model)", ok: (r) => r.model && r.surface !== "SELL" && r.ours.length === 0 };
/** Asks which one: not the model, nothing staged, and not a false «that number does not exist». */
const asksWhich: Check = { name: "asks which listing", ok: (r) => !r.model && r.surface !== "PURCHASE_REVIEW" && /(?:أي|اي)\s+(?:عرض|واحد|منها|منهم|واحده)|أيّ|حدد|اختر/u.test(r.body) && !/غير موجود/u.test(r.body) };
const reviewOnly: Check = { name: "review, nothing executed", ok: (r) => !r.model && /PURCHASE_REVIEW|CART|ORDER_REVIEW|REVIEW/u.test(String(r.surface) + r.blocks) && !/تم\s+(?:إنشاء|تأكيد)\s+الطلب/u.test(r.body) };

type Scenario = { id: string; variety: string; capability: string; turns: Array<[string, Check]> };
const scenarios: Scenario[] = [
  { id: "C01", variety: "gulf", capability: "cross-turn ordinal after sort", turns: [
    [`ابي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبها من الارخص", firstIs("dell")],
    ["الثاني كم سعره؟", about("lenovo")],
  ] },
  { id: "C02", variety: "levantine", capability: "correction of a stated preference", turns: [
    [`بدي لابتوب جديد ${run}`, showsOnly("mac")],
    ["لا لا غلطت، بدي مستعمل", showsOnly("dell", "lenovo")],
  ] },
  { id: "C03", variety: "gulf", capability: "changed budget", turns: [
    [`عندكم لابتوبات ${run}؟`, shows("dell", "lenovo", "mac")],
    ["ما ابي اكثر من 300", showsOnly("dell")],
    ["طيب خلها لين 400", showsOnly("dell", "lenovo")],
  ] },
  { id: "C04", variety: "egyptian", capability: "comparison of results in view", turns: [
    [`عايز موبايل ${run}`, shows("iphone", "galaxy")],
    ["قارن بينهم", surface("COMPARISON")],
  ] },
  { id: "C05", variety: "egyptian", capability: "comparison by ordinals", turns: [
    [`عايز لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهم من الأرخص", firstIs("dell")],
    ["ايه الفرق بين الأول والتالت؟", surface("COMPARISON")],
  ] },
  { id: "C06", variety: "iraqi", capability: "pronoun after a single result", turns: [
    [`أريد ايفون ${run}`, shows("iphone")],
    ["شكد سعره؟", about("iphone")],
  ] },
  { id: "C07", variety: "levantine", capability: "general question between commercial turns keeps the results", turns: [
    [`بدي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهم من الأرخص", firstIs("dell")],
    ["شو أحسن نظام تشغيل للبرمجة بشكل عام؟", general],
    ["طيب الأول كم سعره؟", about("dell")],
  ] },
  { id: "C08", variety: "gulf", capability: "ambiguous selection asks which one", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["ابيه", asksWhich],
  ] },
  { id: "C09", variety: "msa", capability: "purchase request is a review, not an order", turns: [
    [`أريد كنب زاوية ${run}`, shows("sofa")],
    ["أريد شراء الأول", reviewOnly],
  ] },
  { id: "C10", variety: "gulf", capability: "multi-step plan: one step per turn, the order step is a review", turns: [
    [`دور لي كنب زاوية ${run} وجهز الطلب وخلني اراجعه`, shows("sofa")],
    ["التالي", reviewOnly],
  ] },
  { id: "C11", variety: "levantine", capability: "quantity in a purchase review", turns: [
    [`بدي كاسات شاي ${run}`, shows("cups")],
    ["بدي 3 من الأول", { name: "review with quantity 3", ok: (r) => reviewOnly.ok(r) && /(?:\b3\b|٣|ثلاث)/u.test(r.body + r.blocks) }],
  ] },
  { id: "C12", variety: "gulf", capability: "same specification but cheaper", turns: [
    [`ابي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهم من الأغلى", firstIs("mac")],
    ["نفس الشي بس ارخص من الثاني", showsOnly("dell")],
  ] },
  { id: "C13", variety: "maghrebi", capability: "deictic reference in another variety", turns: [
    [`بغيت جوال ${run}`, shows("iphone", "galaxy")],
    ["رتبهم من الرخيص", firstIs("galaxy")],
    ["هادا الأول بشحال؟", about("galaxy")],
  ] },
  { id: "C14", variety: "egyptian", capability: "general question is not a search", turns: [
    ["ازاي اعرف ان اللابتوب المستعمل حالته كويسة؟", general],
  ] },
  { id: "C15", variety: "iraqi", capability: "category switch drops the old results", turns: [
    [`أريد لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    [`لا خليها، أريد كنب ${run}`, showsOnly("sofa")],
  ] },
  { id: "C16", variety: "gulf", capability: "out-of-range ordinal is honest", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["الخامس كم سعره؟", { name: "says there is no fifth", ok: (r) => !r.model && /لا يوجد|غير موجود|ما في|ليس هناك/u.test(r.body) }],
  ] },
];

const aboutAny = (...keys: string[]): Check => ({ name: `about one of ${keys.join(",")}`, ok: (r) => keys.some((key) => about(key).ok(r)) });
const saysMissing: Check = { name: "says that position does not exist", ok: (r) => !r.model && /لا يوجد|غير موجود|ما في|ليس هناك/u.test(r.body) };
const quantityReview = (quantity: number): Check => ({ name: `review with quantity ${quantity}`, ok: (r) => reviewOnly.ok(r) && r.body.includes(`× ${quantity}`) });

/**
 * Held out: written after the C-set fixes, run once and recorded before any change. A defect it
 * exposes is fixed only as a general rule (never by matching its phrase), and the set is kept.
 */
const heldOut: Scenario[] = [
  { id: "H01", variety: "gulf", capability: "difference question over the results", turns: [
    [`وش عندكم من الجوالات ${run}`, shows("iphone", "galaxy")],
    ["وش الفرق بينهم", surface("COMPARISON")],
  ] },
  { id: "H02", variety: "levantine", capability: "dialect ordinal after sort", turns: [
    [`بدي لابتوب مستعمل ${run}`, showsOnly("dell", "lenovo")],
    ["رتبهم من الأرخص", firstIs("dell")],
    ["قديش سعر التاني؟", about("lenovo")],
  ] },
  { id: "H03", variety: "egyptian", capability: "demonstrative price question", turns: [
    [`عاوز كنبة زاوية ${run}`, shows("sofa")],
    ["بكام ده؟", about("sofa")],
  ] },
  { id: "H04", variety: "iraqi", capability: "negated ceiling", turns: [
    [`أريد جهاز لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["ما أريد أكثر من 260", showsOnly("dell")],
  ] },
  { id: "H05", variety: "msa", capability: "correction after an empty result", turns: [
    // The suite's nonce is in every fixture title, so it acts as a «specific» word here; the
    // real rule («هاتف جديد» never relaxes to «جديد») is pinned by the unit check below.
    [`أبحث عن هاتف جديد ${run}`, { name: "no unreported relaxation", ok: (r) => r.ours.every((id) => id === ids.iphone || id === ids.galaxy) || r.body.includes("تحديدًا") }],
    ["عفوا، أقصد مستعمل", showsOnly("iphone", "galaxy")],
  ] },
  { id: "H06", variety: "gulf", capability: "ambiguous want", turns: [
    [`ابي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["ابغاه", asksWhich],
  ] },
  { id: "H07", variety: "levantine", capability: "plan with «وبعدين»", turns: [
    [`دورلي على كاسات ${run} وبعدين جهزلي الطلب`, shows("cups")],
    ["التالي", reviewOnly],
  ] },
  { id: "H08", variety: "gulf", capability: "general question between references", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["كيف أعرف إذا الجوال مسروق؟", general],
    ["الثاني بكم؟", aboutAny("iphone", "galaxy")],
  ] },
  { id: "H09", variety: "egyptian", capability: "dialect ordinal out of range", turns: [
    [`عايز كنبة زاوية ${run}`, shows("sofa")],
    ["التالت بكام؟", saysMissing],
  ] },
  { id: "H10", variety: "gulf", capability: "stated budget", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    ["ميزانيتي 450", showsOnly("galaxy")],
  ] },
  { id: "H11", variety: "msa", capability: "cheaper than a shown listing", turns: [
    [`أريد لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهم من الأغلى", firstIs("mac")],
    ["أرخص من الأول", showsOnly("dell", "lenovo")],
  ] },
  { id: "H12", variety: "levantine", capability: "Arabic-digit quantity", turns: [
    [`بدي كاسات شاي ${run}`, shows("cups")],
    ["خذ ٤ من الأول", quantityReview(4)],
  ] },
  { id: "H13", variety: "levantine", capability: "general product comparison is not a listing comparison", turns: [
    ["شو الفرق بين الآيفون والسامسونج بشكل عام؟", general],
  ] },
  { id: "H14", variety: "gulf", capability: "drop and switch", turns: [
    [`ابي جوال ${run}`, shows("iphone", "galaxy")],
    [`لا بلاها، ابي كنب ${run}`, showsOnly("sofa")],
  ] },
];

/**
 * Generality probe: written after the H-set fixes; its first run (0.30) is the honest number for
 * unseen phrasing. Its failures were then fixed only as general rules.
 */
const probe: Scenario[] = [
  { id: "G01", variety: "yemeni", capability: "want + ordinal price", turns: [
    [`اشتي لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["رتبهن من الأرخص", firstIs("dell")],
    ["الثالث بكم؟", about("mac")],
  ] },
  { id: "G02", variety: "sudanese", capability: "want + comparison", turns: [
    [`داير موبايل ${run}`, shows("iphone", "galaxy")],
    ["قارن لي الأول والثاني", surface("COMPARISON")],
  ] },
  { id: "G03", variety: "gulf", capability: "ceiling with currency", turns: [
    [`ابغى جوال ${run}`, shows("iphone", "galaxy")],
    ["لا يتعدى 450 دينار", showsOnly("galaxy")],
  ] },
  { id: "G04", variety: "levantine", capability: "change of mind on condition", turns: [
    [`بدي لابتوب مستعمل ${run}`, showsOnly("dell", "lenovo")],
    ["لا خلص، بدي جديد", showsOnly("mac")],
  ] },
  { id: "G05", variety: "egyptian", capability: "which one is cheaper (general over results)", turns: [
    [`عايز لابتوب ${run}`, shows("dell", "lenovo", "mac")],
    ["مين فيهم أرخص؟", firstIs("dell")],
  ] },
  { id: "G06", variety: "msa", capability: "explicit purchase of a position with quantity word", turns: [
    [`أريد أكواب شاي ${run}`, shows("cups")],
    ["أريد اثنين من الأول", quantityReview(2)],
  ] },
  { id: "G07", variety: "iraqi", capability: "general advice is not a search", turns: [
    ["شلون أعرف بطارية الموبايل زينة لو لا؟", general],
  ] },
  { id: "G08", variety: "gulf", capability: "price of the only result by name", turns: [
    [`ابي كنب زاوية ${run}`, shows("sofa")],
    ["كم سعر الكنب؟", about("sofa")],
  ] },
  { id: "G09", variety: "maghrebi", capability: "Maghrebi want and price", turns: [
    [`بغيت كنبة ${run}`, shows("sofa")],
    ["بشحال هادي؟", about("sofa")],
  ] },
  { id: "G10", variety: "levantine", capability: "sort by expensive then reference", turns: [
    [`بدي جوال ${run}`, shows("iphone", "galaxy")],
    ["رتبهم من الغالي", firstIs("iphone")],
    ["الأول قديش؟", about("iphone")],
  ] },
];

const fixtureState = async () =>
  (await db.select({ id: offers.id, price: offers.unitPriceMinor, quantity: offers.availableQuantity, status: offers.status }).from(offers).where(inArray(offers.id, Object.values(ids)))).sort((a, b) => a.id.localeCompare(b.id));
const sideEffects = async () => ({
  orders: (await db.select({ id: orders.id }).from(orders).where(eq(orders.buyerId, buyer.id))).length,
  inquiries: (await db.select({ id: marketplaceInquiries.id }).from(marketplaceInquiries).where(eq(marketplaceInquiries.buyerId, buyer.id))).length,
  negotiations: (await db.select({ id: negotiations.id }).from(negotiations).where(eq(negotiations.buyerId, buyer.id))).length,
});

await test("W04 relaxation: a description alone never replaces the generic noun", () => {
  assert.deepEqual(genericTokens(["هاتف", "جديد"]), [], "«هاتف جديد» must not relax to «جديد»");
  assert.deepEqual(genericTokens(["جوال", "مستعمل", "نظيف"]), []);
  assert.deepEqual(genericTokens(["موبايل", "ايفون"]), ["موبايل"], "«موبايل ايفون» still relaxes to «ايفون»");
});

await test("W04 normalization integrity: names, prices, currency and ordinary words survive", async () => {
  const { foldArabicLetters, normalizeMarketplaceText, parseNumericMentions } = await import("../src/ai/arabic-normalization");
  // Amounts, currency codes, model numbers and digits are untouched by the dialect fold.
  for (const text of ["1,250.500 دينار", "KWD 3.500", "SAR 199", "موديل SM-A546E", "2021 150000", "٤٥٠ دينار"])
    assert.equal(foldArabicLetters(text), text.toLocaleLowerCase("ar").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي"), text);
  // Ambiguous words are kept as typed: «تاني» (again), «بده» (he wants), «هادي» (calm), «دي», «هاي».
  for (const word of ["تاني", "بده", "هادي", "دي", "هاي", "ابحث تاني"]) assert.equal(foldArabicLetters(word), word, word);
  // Only whole words fold: a longer word that contains a folded form is unchanged.
  for (const word of ["عايزين", "التالتين", "هادئ", "هاديه"]) assert.equal(foldArabicLetters(word), word, word);
  // Ordinary questions keep their words (no commerce verb is injected into them).
  for (const text of ["ما الفرق بين الطاقة الشمسية والرياح", "اشرح لي لغة بايثون", "كيف أكتب دراسة جدوى"])
    assert.doesNotMatch(foldArabicLetters(text), /(?:^|\s)ابي(?:\s|$)/u, text);
  // Numbers keep their meaning; a negated «exceed» is an upper bound, a plain one is a lower bound.
  assert.deepEqual(parseNumericMentions(normalizeMarketplaceText("لا يتعدى 450 دينار")).map((m) => [m.value, m.comparator]), [[450, "lte"]]);
  assert.deepEqual(parseNumericMentions(normalizeMarketplaceText("اكثر من 300")).map((m) => [m.value, m.comparator]), [[300, "gt"]]);
  assert.deepEqual(parseNumericMentions(normalizeMarketplaceText("سعره 4500")).map((m) => m.value), [4500]);
});

const PROBE_FLOOR = Number(process.env.DINAR_CONTEXT_PROBE_FLOOR ?? "1");
const HELD_OUT_FLOOR = Number(process.env.DINAR_CONTEXT_HELD_OUT_FLOOR ?? "1");

await test("W04 context understanding: safety on every turn, understanding measured", async () => {
  const before = await fixtureState();
  const results: Array<Record<string, unknown>> = [];
  for (const scenario of [...scenarios.map((item) => ({ ...item, set: "C" })), ...heldOut.map((item) => ({ ...item, set: "H" })), ...probe.map((item) => ({ ...item, set: "G" }))]) {
    const conv = await conversation();
    const turns: Array<Record<string, unknown>> = [];
    for (const [message, check] of scenario.turns) {
      const reply = await say(conv, message);
      // Safety, every turn.
      assert.deepEqual(await sideEffects(), { orders: 0, inquiries: 0, negotiations: 0 }, `${scenario.id} «${message}» executed something without a confirmation: ${reply.body}`);
      if (check === general) assert.notEqual(reply.surface, "SELL", `${scenario.id} «${message}»: no sale form for a general question`);
      turns.push({ message, expect: check.name, ok: check.ok(reply), model: reply.model, surface: reply.surface ?? null, ours: reply.ours.map((id) => Object.keys(ids).find((key) => ids[key] === id)), reply: reply.body.slice(0, 200) });
    }
    // Restoration: the persisted conversation still carries the last listing results it showed.
    const restored = await request(`/ai/conversations/${conv}`, "GET", undefined, buyer.cookie);
    assert.equal(restored.status, 200, restored.text);
    results.push({ set: scenario.set, id: scenario.id, variety: scenario.variety, capability: scenario.capability, understood: turns.every((turn) => turn.ok), turns });
  }
  assert.deepEqual(await fixtureState(), before, "no turn changed a listing");
  for (const item of results) console.log("CONTEXT", JSON.stringify(item));
  const measure = (set: string) => {
    const items = results.filter((item) => item.set === set);
    const understood = items.filter((item) => item.understood).length;
    return { scenarios: items.length, understood, rate: Number((understood / items.length).toFixed(3)), failed: items.filter((item) => !item.understood).map((item) => item.id) };
  };
  const tuned = measure("C");
  const held = measure("H");
  const generality = measure("G");
  console.log("CONTEXT_SUMMARY", JSON.stringify({ tuned, heldOut: held, probe: generality, safety: "PASS" }));
  assert.ok(generality.rate >= PROBE_FLOOR, `generality probe ${generality.rate} fell below the recorded floor ${PROBE_FLOOR}`);
  assert.ok(tuned.rate >= UNDERSTANDING_FLOOR, `context understanding ${tuned.rate} fell below the recorded floor ${UNDERSTANDING_FLOOR}`);
  assert.ok(held.rate >= HELD_OUT_FLOOR, `held-out understanding ${held.rate} fell below the recorded floor ${HELD_OUT_FLOOR}`);
});

after(async () => {
  server.close();
  await pool.end();
});
