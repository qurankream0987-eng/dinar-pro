/**
 * Cross-domain acceptance (owner mission «General agent and commerce integration»): one Jassim
 * conversation moves from general web research to a marketplace search with real cards, a table
 * of the same results, a cart change, and seller tools (promotion review, marketing, analytics,
 * listing draft) — through the one conversation runtime, with every commerce authority intact.
 *
 * Real: API, conversation runtime, deterministic and model-led routing, canonical search, cart,
 * listing-draft, promotion and analytics services, card envelopes, database. Scripted: the model
 * gateway (no provider), the web-search provider and the web pages (no network), so this proves
 * integration and authority, not real-model language quality.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, listingPromotions, offers, orders, pool } from "@workspace/db";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { getMarketplaceCart } from "../src/lib/marketplace-cart";
import { resolveMarket } from "../src/lib/markets";
import { useWebReaderDependencies, type WebTransport } from "../src/ai/web-reader";
import { registerSearchProvider } from "../src/ai/web-research";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
const JO = await resolveMarket("JO");
const run = randomUUID().slice(0, 6);
const PAGE = "https://specs.example.org/phones-2026";
const transport: WebTransport = async (url, lookup) => {
  await new Promise<void>((resolve, reject) => lookup(url.hostname, {}, (e) => (e ? reject(e) : resolve())));
  const ok = url.toString() === PAGE;
  return { status: ok ? 200 : 404, headers: { "content-type": "text/html" }, body: Buffer.from(ok ? `<html><head><title>أهم مواصفات الهواتف 2026</title></head><body><p>${"أهم ما يُقارن في الهاتف: البطارية والكاميرا والتخزين والسعر. ".repeat(20)}</p></body></html>` : "") };
};
const previousReader = useWebReaderDependencies({ transport, resolver: async () => ["93.184.216.34"] });
const previousProvider = registerSearchProvider({ name: "scripted", async search() { return [{ url: PAGE, title: "مواصفات", snippet: "البطارية والكاميرا" }]; } });

const modelLog: { message: string; tools: string[]; input: string }[] = [];
app.locals.conversationModelGateway = {
  providerInfo: { provider: "OPENAI_COMPATIBLE", requestedModel: "fx/cross-domain" },
  async proposeToolCall(messages, tools) {
    const last = String(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
    const names = (tools ?? []).map((t: any) => String(t?.name ?? t?.function?.name ?? ""));
    modelLog.push({ message: last.slice(-120), tools: names, input: JSON.stringify(messages) });
    const evidence = JSON.stringify(messages).includes("UNTRUSTED_EVIDENCE_ONLY");
    const fed = JSON.stringify(messages).includes('"tool":"readBusinessOverview"');
    if (/مبيعات/u.test(last) && names.includes("readBusinessOverview") && !fed)
      return { id: "c", name: "readBusinessOverview", arguments: "{}", usage: { inputTokens: 100, outputTokens: 10 } } as any;
    if (/الإنترنت/u.test(last) && names.includes("searchWeb") && !evidence)
      return { id: "c", name: "searchWeb", arguments: JSON.stringify({ query: "أهم مواصفات الهواتف 2026" }), usage: { inputTokens: 100, outputTokens: 10 } } as any;
    const reply = evidence ? "أهم ما يُقارن: البطارية والكاميرا والتخزين والسعر [1]." : "تفضل.";
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: reply, ...(/بجدول/u.test(last) ? { display: { format: "TABLE", scope: "LATEST_RESULTS" } } : {}) }), usage: { inputTokens: 100, outputTokens: 20 } } as any;
  },
} as ConversationModelGateway;

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
after(async () => { registerSearchProvider(previousProvider); useWebReaderDependencies(previousReader); server.close(); await pool.end(); });
let ipn = 1;
async function request(p: string, method = "GET", body?: unknown, cookie = "") {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "X-Forwarded-For": `203.0.116.${ipn++ % 250}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
type Actor = { id: string; cookie: string };
const phoneBase = 51_480_000 + ((Date.now() + process.pid) % 9_000);
let offset = 0;
async function account(label: string): Promise<Actor> {
  const phoneNumber = String(phoneBase + 3 * offset++);
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const password = `Xd-${randomUUID().slice(0, 12)}!`;
  const c = await request("/auth/register", "POST", { displayName: `Cross ${label}`, accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: v.data.verificationToken });
  assert.equal(c.status, 201, c.raw);
  assert.equal((await request("/account/market", "PATCH", { marketId: "JO" }, c.cookie)).status, 200);
  return { id: c.data.user.id, cookie: c.cookie };
}
type Turn = { body: string; surface: string; payload: any; blocks: any[] };
async function say(actor: Actor, conversationId: string, message: string): Promise<Turn> {
  const r = await fetch(`${base}/ai/conversations/${conversationId}/turns`, { method: "POST", headers: { "content-type": "application/json", cookie: actor.cookie }, body: JSON.stringify({ message }) });
  const raw = await r.text();
  const done = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
  assert.ok(done, `${message}: ${raw.slice(0, 300)}`);
  const blocks = done.assistantMessage.blocks ?? [];
  const payload = blocks[0]?.payload ?? {};
  return { body: String(done.assistantMessage.body), surface: blocks[0]?.type === "SURFACE" ? String(payload.surface) : String(blocks[0]?.type ?? "TEXT"), payload, blocks };
}
async function publish(seller: Actor, title: string, price: string) {
  const created = await request("/listings", "POST", {
    title, description: `${title} — هاتف بحالة ممتازة للاختبار`, category: "إلكترونيات", categoryId: "electronics", area: "خلدا", city: "عمان",
    attributes: { condition: "جديد" }, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 3, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [], paymentMethods: ["CASH_DIRECT"],
  }, seller.cookie);
  assert.equal(created.status, 201, created.raw);
  return created.data.id as string;
}
const trace: { step: string; surface: string; modelCalls: number; body: string }[] = [];
async function step(actor: Actor, conv: string, label: string, message: string) {
  const before = modelLog.length;
  const t = await say(actor, conv, message);
  trace.push({ step: label, surface: t.surface, modelCalls: modelLog.length - before, body: t.body.slice(0, 160) });
  return t;
}

const seller = await account("seller");
const buyer = await account("buyer");
const ids = [await publish(seller, `هاتف سامسونج ${run}`, "200"), await publish(seller, `هاتف آيفون ${run}`, "450"), await publish(seller, `هاتف شاومي ${run}`, "150")];

test("X1 one conversation: research → real cards → table → cart (buyer)", async () => {
  process.env.DINAR_WEB_SEARCH_ENABLED = "true";
  try {
    const conv = (await request("/ai/conversations", "POST", {}, buyer.cookie)).data.id as string;
    const research = await step(buyer, conv, "research", "جاسم ابحث في الإنترنت عن أهم مواصفات الهواتف هذا العام");
    assert.match(research.body, /\[1\] أهم مواصفات الهواتف 2026 — https:\/\/specs\.example\.org/u, "general research: server-cited source");
    assert.equal(trace.at(-1)!.modelCalls, 2, "the model searched, then answered from the evidence");

    const search = await step(buyer, conv, "search", `جاسم ابحث لي عن هاتف ${run}`);
    assert.equal(search.surface, "LISTING_RESULTS", search.body);
    const shown: string[] = search.payload.resourceIds ?? search.payload.listings.map((l: any) => l.id);
    assert.deepEqual([...shown].sort(), [...ids].sort(), "real cards: exactly the three published listings");

    const table = await step(buyer, conv, "table", "جاسم قارنهم بجدول");
    assert.match(table.body, /كجدول/u, table.body);
    assert.equal(table.payload.resultSetId, search.payload.resultSetId, "the same verified result set, not a new search");

    const cartTurn = await step(buyer, conv, "cart", "جاسم ضيف الثاني للسلة");
    assert.equal(cartTurn.surface, "CART", cartTurn.body);
    const cart = (await request("/cart", "GET", undefined, buyer.cookie)).data as any[];
    assert.deepEqual(cart.map((line) => line.id), [shown[1]], "the second card, and only it, is in the cart");
    assert.equal((await db.select().from(orders).where(eq(orders.buyerId, buyer.id))).length, 0, "no order without checkout confirmation");
    assert.match(cartTurn.body, /لم يُدفع أي شيء/u);
  } finally { delete process.env.DINAR_WEB_SEARCH_ENABLED; }
});

test("X2 seller tools in one conversation: promotion review, marketing, analytics, listing draft", async () => {
  const conv = (await request("/ai/conversations", "POST", {}, seller.cookie)).data.id as string;
  const before = trace.length;
  const found = await step(seller, conv, "seller-search", `جاسم ابحث عن هاتف سامسونج ${run}`);
  assert.equal(found.surface, "LISTING_RESULTS");
  const go = await step(seller, conv, "go-sell", "جاسم روح بيع لي هذا");
  assert.equal(go.surface, "PROMOTION_TYPE_OPTIONS", "«روح بيع لي» is the paid promotion product: a review, never an automatic charge");
  assert.equal((await db.select().from(listingPromotions).where(eq(listingPromotions.sellerId, seller.id))).length, 0, "nothing created or charged");

  const market = await step(seller, conv, "market", "جاسم سوّق لي المنتج");
  assert.equal(market.surface, "ADVICE");
  assert.match(modelLog.at(-1)!.input, /sellerListing/u, "marketing is grounded in the seller's real listing facts");
  assert.match(modelLog.at(-1)!.input, new RegExp(`هاتف سامسونج ${run}`, "u"));

  const analytics = await step(seller, conv, "analytics", "جاسم حلل مبيعات متجري");
  // An individual seller: the canonical sales insight from recorded orders (businesses use the
  // model-led readBusinessOverview path, covered by phase2-model-display).
  assert.equal(analytics.payload.sellerInsight?.topic, "SALES", analytics.body);
  assert.equal(trace.at(-1)!.modelCalls, 0, "figures come from the server's records, not the model");

  const draft = await step(seller, conv, "draft", "جاسم أبي أبيع ساعة يد مستعملة بسعر 30 دينار");
  assert.equal(draft.surface, "SELL", draft.body);
  const published = await db.select().from(offers).where(eq(offers.sellerId, seller.id));
  assert.equal(published.length, 3, "a draft is not a publication: still only the three listings");
});
